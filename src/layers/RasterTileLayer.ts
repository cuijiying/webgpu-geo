import { Layer } from './Layer';
import type { Engine } from '../core/Engine';
import type { FrameContext } from '../core/Renderer';
import { TileSource } from '../tile/TileSource';
import { TileCache } from '../tile/TileCache';
import { TileLoader } from '../tile/TileLoader';
import { TilePyramid } from '../tile/TilePyramid';
import { Tile, TileState } from '../tile/Tile';
import { tileKey } from '../geo/types';
import { Mercator } from '../geo/Mercator';
import { RASTER_TILE_WGSL } from '../shaders/raster.wgsl.ts';

/**
 * 栅格瓦片图层配置
 */
export interface RasterTileLayerOptions {
    source: TileSource;
    /** LRU 缓存容量（瓦片个数），默认 256 */
    cacheSize?: number;
    /** 同时进行的 HTTP 请求数，默认 8 */
    maxConcurrent?: number;
    /** 是否启用淡入动画，默认 true */
    fadeIn?: boolean;
    /** 淡入时长（ms），默认 200 */
    fadeDuration?: number;
}

/**
 * 单位方块顶点（两个三角形组成 quad）
 *   v0(0,0) v1(1,0)
 *   v2(0,1) v3(1,1)
 */
const QUAD_VERTICES = new Float32Array([
    0, 0,  1, 0,  0, 1,
    0, 1,  1, 0,  1, 1,
]);

/**
 * 每瓦片 Uniform：offset.xy + size + opacity，共 4 个 f32
 * WebGPU uniform buffer 最小对齐 256B，因此我们也按 256B 步进打包
 */
const TILE_UBO_STRIDE = 256;

/**
 * RasterTileLayer —— 标准 XYZ 栅格瓦片图层
 *
 * 渲染流程（每帧）：
 *   1) 由 TilePyramid 计算当前可见瓦片
 *   2) 对未加载的瓦片调用 TileLoader 异步加载
 *   3) 对已 Loaded 但还没建纹理的瓦片，创建 GPUTexture + BindGroup
 *   4) 绘制所有 Ready 的瓦片
 *
 * 性能要点：
 *   - 顶点缓冲全图层共享（仅 6 顶点）
 *   - 全局 UBO（viewProj）共用 group0
 *   - 每瓦片 UBO 集中在一个大 buffer，按 256B stride 偏移使用 dynamic offset
 */
export class RasterTileLayer extends Layer {
    private _source: TileSource;
    private _cache: TileCache;
    private _loader: TileLoader;
    private _fadeIn: boolean;
    private _fadeDuration: number;

    // GPU 资源
    private _pipeline!: GPURenderPipeline;
    private _sampler!: GPUSampler;
    private _quadBuffer!: GPUBuffer;
    private _globalUbo!: GPUBuffer;
    private _globalBindGroup!: GPUBindGroup;
    private _tileBindGroupLayout!: GPUBindGroupLayout;
    /** 每瓦片 UBO，size = capacity * 256B */
    private _tileUbo!: GPUBuffer;
    private _tileUboCapacity = 0;
    private _scratch = new Float32Array(4); // 临时 CPU 拷贝

    constructor(opts: RasterTileLayerOptions) {
        super();
        this._source = opts.source;
        this._cache = new TileCache(opts.cacheSize ?? 256);
        this._loader = new TileLoader(this._source, {
            maxConcurrent: opts.maxConcurrent ?? 8,
        });
        this._fadeIn = opts.fadeIn ?? true;
        this._fadeDuration = opts.fadeDuration ?? 200;
    }

    protected onAttach(engine: Engine): void {
        const device = engine.device;

        // ----- 1) 顶点缓冲（共享单位方块） -----
        this._quadBuffer = device.createBuffer({
            label: 'raster-quad-vb',
            size: QUAD_VERTICES.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(this._quadBuffer, 0, QUAD_VERTICES);

        // ----- 2) 采样器（双线性 + clamp） -----
        this._sampler = device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
        });

        // ----- 3) 全局 UBO（viewProj mat4 = 64 字节）-----
        this._globalUbo = device.createBuffer({
            label: 'raster-global-ubo',
            size: 64,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // ----- 4) Bind group 布局 -----
        const globalBgl = device.createBindGroupLayout({
            label: 'raster-global-bgl',
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                buffer: { type: 'uniform' },
            }],
        });
        this._tileBindGroupLayout = device.createBindGroupLayout({
            label: 'raster-tile-bgl',
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 },
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: 'float', viewDimension: '2d' },
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler: { type: 'filtering' },
                },
            ],
        });

        this._globalBindGroup = device.createBindGroup({
            label: 'raster-global-bg',
            layout: globalBgl,
            entries: [{ binding: 0, resource: { buffer: this._globalUbo } }],
        });

        // ----- 5) 管线 -----
        const module = device.createShaderModule({ code: RASTER_TILE_WGSL, label: 'raster-shader' });
        this._pipeline = device.createRenderPipeline({
            label: 'raster-pipeline',
            layout: device.createPipelineLayout({
                bindGroupLayouts: [globalBgl, this._tileBindGroupLayout],
            }),
            vertex: {
                module,
                entryPoint: 'vs_main',
                buffers: [{
                    arrayStride: 8, // 2 * f32
                    attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
                }],
            },
            fragment: {
                module,
                entryPoint: 'fs_main',
                targets: [{
                    format: engine.format,
                    blend: {
                        color: {
                            srcFactor: 'one', // 着色器已 premultiply
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add',
                        },
                        alpha: {
                            srcFactor: 'one',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add',
                        },
                    },
                }],
            },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: {
                format: 'depth24plus',
                depthWriteEnabled: false,
                depthCompare: 'always',
            },
        });

        // 初始化 tile UBO（容量 64 起步，按需扩容）
        this._growTileUbo(64);
    }

    protected onDetach(): void {
        this._cache.clear();
        this._quadBuffer?.destroy();
        this._globalUbo?.destroy();
        this._tileUbo?.destroy();
    }

    protected onRender(ctx: FrameContext): void {
        const { engine, camera, pass, frame } = ctx;
        const device = engine.device;

        // 1) 写入全局 UBO
        const vp = camera.getViewProjectionMatrix();
        device.queue.writeBuffer(this._globalUbo, 0, vp as Float32Array);

        // 2) 计算可见瓦片并触发加载
        const visible = TilePyramid.getVisibleTiles(camera, this._source.minZoom, this._source.maxZoom);
        const visibleTiles: Tile[] = [];
        for (const coord of visible) {
            const key = tileKey(coord);
            let tile = this._cache.get(key);
            if (!tile) {
                tile = new Tile(coord);
                this._cache.set(key, tile);
            }
            tile.lastUsedFrame = frame;

            if (tile.state === TileState.Idle) {
                this._loader.request(tile, (t, err) => {
                    if (err) {
                        // 静默处理；可选输出日志
                        console.warn('[webgpu-geo] tile load failed:', t.key, err.message);
                        return;
                    }
                    // 上传到 GPU
                    this._uploadToGPU(t);
                    this.onChange();
                });
            } else if (tile.state === TileState.Loaded) {
                // 例如加载在上一帧完成但还未上传
                this._uploadToGPU(tile);
            }
            visibleTiles.push(tile);
        }

        // 3) 绘制
        if (visibleTiles.length === 0) return;
        // 必要时扩容 tile UBO
        this._growTileUbo(visibleTiles.length);

        pass.setPipeline(this._pipeline);
        pass.setVertexBuffer(0, this._quadBuffer);
        pass.setBindGroup(0, this._globalBindGroup);

        let drawIndex = 0;
        const now = ctx.time;
        for (const tile of visibleTiles) {
            if (tile.state !== TileState.Ready || !tile.bindGroup) continue;
            const tw = Mercator.tileToWorld(tile.coord);

            // 计算淡入透明度
            let opacity = 1;
            if (this._fadeIn) {
                const age = now - (tile as Tile & { _readyAt?: number })._readyAt!;
                opacity = Math.max(0, Math.min(1, age / this._fadeDuration));
                if (opacity < 1) this.onChange(); // 仍在淡入，继续重绘
            }

            this._scratch[0] = tw.x;
            this._scratch[1] = tw.y;
            this._scratch[2] = tw.size;
            this._scratch[3] = opacity;
            const offset = drawIndex * TILE_UBO_STRIDE;
            device.queue.writeBuffer(this._tileUbo, offset, this._scratch);
            pass.setBindGroup(1, tile.bindGroup, [offset]);
            pass.draw(6, 1, 0, 0);
            drawIndex++;
        }
    }

    /** 将 Loaded 状态的瓦片图像上传到 GPU 纹理 */
    private _uploadToGPU(tile: Tile): void {
        if (tile.state !== TileState.Loaded || !tile.image) return;
        const device = this.engine.device;
        const size = this._source.tileSize;
        const texture = device.createTexture({
            label: `tile-tex-${tile.key}`,
            size: { width: size, height: size },
            format: 'rgba8unorm',
            usage:
                GPUTextureUsage.TEXTURE_BINDING |
                GPUTextureUsage.COPY_DST |
                GPUTextureUsage.RENDER_ATTACHMENT,
        });
        device.queue.copyExternalImageToTexture(
            { source: tile.image, flipY: false },
            { texture },
            { width: size, height: size },
        );
        tile.texture = texture;
        // 释放 ImageBitmap
        tile.image.close?.();
        tile.image = null;

        tile.bindGroup = device.createBindGroup({
            label: `tile-bg-${tile.key}`,
            layout: this._tileBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this._tileUbo, size: 16 } },
                { binding: 1, resource: texture.createView() },
                { binding: 2, resource: this._sampler },
            ],
        });
        tile.state = TileState.Ready;
        (tile as Tile & { _readyAt?: number })._readyAt = performance.now();
    }

    /** 扩容每瓦片 UBO 并重建所有 tile bind group */
    private _growTileUbo(needed: number): void {
        if (needed <= this._tileUboCapacity) return;
        // 按 2 的幂扩容
        let cap = Math.max(64, this._tileUboCapacity);
        while (cap < needed) cap *= 2;

        const device = this.engine.device;
        this._tileUbo?.destroy();
        this._tileUbo = device.createBuffer({
            label: 'raster-tile-ubo',
            size: cap * TILE_UBO_STRIDE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this._tileUboCapacity = cap;

        // 已存在的 tile 需要重新创建 bind group（buffer 变了）
        this._cache.forEach((t) => {
            if (t.texture) {
                t.bindGroup = device.createBindGroup({
                    layout: this._tileBindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: this._tileUbo, size: 16 } },
                        { binding: 1, resource: t.texture.createView() },
                        { binding: 2, resource: this._sampler },
                    ],
                });
            }
        });
    }
}
