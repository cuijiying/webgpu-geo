import { Layer } from './Layer';
import type { Engine } from '../core/Engine';
import type { FrameContext } from '../core/Renderer';
import { TileSource } from '../tile/TileSource';
import { TileCache } from '../tile/TileCache';
import { TileLoader } from '../tile/TileLoader';
import { TilePyramid } from '../tile/TilePyramid';
import { Tile, TileState } from '../tile/Tile';
import { tileKey, type TileCoord } from '../geo/types';
import { Mercator } from '../geo/Mercator';
import { RASTER_TILE_WGSL } from '../shaders/raster.wgsl.ts';

/**
 * 栅格瓦片图层配置
 */
export interface RasterTileLayerOptions {
    source: TileSource;
    /** LRU 缓存容量（瓦片个数），默认 512 */
    cacheSize?: number;
    /** 同时进行的 HTTP 请求数，默认 16 */
    maxConcurrent?: number;
    /** 是否启用淡入动画，默认 false（避免初始加载亮度差） */
    fadeIn?: boolean;
    /** 淡入时长（ms），默认 200 */
    fadeDuration?: number;
    /** 父级回退向上搜索的最大层数，默认 25（覆盖全 XYZ 范围） */
    maxParentLookup?: number;
    /**
     * 初始化时预加载的"世界底图"最大 zoom。
     * 例如 baseLoadZoom=2 → 预加载 z=0..2 共 1+4+16=21 张瓦片，
     * 作为任何缩放层级下兜底的父级回退源。
     * 设为 -1 可关闭预加载。默认 2。
     */
    baseLoadZoom?: number;
    /**
     * 每帧为可见瓦片额外请求多少层父级（即"前瞻 prefetch"）。
     * 让缩放/平移时父级永远在缓存中，消除转场黑屏。默认 3。
     */
    parentPrefetchLevels?: number;
}

/** 单位方块顶点（两个三角形组成 quad） */
const QUAD_VERTICES = new Float32Array([
    0, 0,  1, 0,  0, 1,
    0, 1,  1, 0,  1, 1,
]);

/**
 * 每瓦片 UBO 数据 = 8 个 f32 = 32 字节：
 *   [0..3] worldOffsetSize: worldX, worldY, worldSize, opacity
 *   [4..7] uvOffsetScale:   uvX, uvY, uvScaleX, uvScaleY
 * WebGPU 要求 dynamic offset 按 minUniformBufferOffsetAlignment 对齐（默认 256B），
 * 故每条 draw 数据占 256B 槽位。
 */
const TILE_UBO_DATA_SIZE = 32;
const TILE_UBO_STRIDE = 256;

/** 一次绘制调用所需的全部信息 */
interface DrawItem {
    /** 提供 GPU 纹理 + bindGroup 的瓦片（可能是 ideal 自己，也可能是祖先） */
    source: Tile;
    /** 世界坐标 */
    worldX: number;
    worldY: number;
    worldSize: number;
    /** 采样 UV 子矩形 */
    uvX: number;
    uvY: number;
    uvScaleX: number;
    uvScaleY: number;
    /** 透明度（用于 cross-fade） */
    opacity: number;
}

/**
 * RasterTileLayer —— 标准 XYZ 栅格瓦片图层（Mapbox 风格）
 *
 * 渲染流程（每帧）：
 *   1) TilePyramid 计算可见 ideal 瓦片
 *   2) 对 ideal 瓦片：未加载则请求；同时为其请求 N 级父级（prefetch）
 *   3) 对每个 ideal：
 *      - 若 Ready：加入 tileDraws（前景）；若处于 fadeIn 期间，同时加入父级到 fallbackDraws（背景）实现 cross-fade
 *      - 否则：找最近 Ready 祖先做 fallback
 *   4) 绘制顺序：fallbackDraws（背景，可能有重叠但都是不透明 → 最后写入胜出） → tileDraws（前景，完全覆盖）
 *
 * 兜底机制（消除黑屏 + 亮度带的关键）：
 *   - 启动时预加载 z=0..baseLoadZoom 的"世界底图"，确保任何 zoom 下父级回退都有可用纹理
 *   - 每帧为可见瓦片再 prefetch parentPrefetchLevels 级父级到 LRU
 *
 * 性能要点：
 *   - 共享顶点缓冲 + 单一管线 + 全局 UBO
 *   - 每瓦片 UBO 集中在大 buffer，按 256B 步进 + dynamic offset
 *   - 加载并发限流；瓦片状态机避免重复请求
 */
export class RasterTileLayer extends Layer {
    private _source: TileSource;
    private _cache: TileCache;
    private _loader: TileLoader;
    private _fadeIn: boolean;
    private _fadeDuration: number;
    private _maxParentLookup: number;
    private _baseLoadZoom: number;
    private _parentPrefetchLevels: number;

    // GPU 资源
    private _pipeline!: GPURenderPipeline;
    private _sampler!: GPUSampler;
    private _quadBuffer!: GPUBuffer;
    private _globalUbo!: GPUBuffer;
    private _globalBindGroup!: GPUBindGroup;
    private _tileBindGroupLayout!: GPUBindGroupLayout;
    private _tileUbo!: GPUBuffer;
    private _tileUboCapacity = 0;
    private _scratch = new Float32Array(8);

    constructor(opts: RasterTileLayerOptions) {
        super();
        this._source = opts.source;
        this._cache = new TileCache(opts.cacheSize ?? 512);
        this._loader = new TileLoader(this._source, {
            maxConcurrent: opts.maxConcurrent ?? 16,
        });
        this._fadeIn = opts.fadeIn ?? false;
        this._fadeDuration = opts.fadeDuration ?? 200;
        this._maxParentLookup = opts.maxParentLookup ?? 25;
        this._baseLoadZoom = opts.baseLoadZoom ?? 2;
        this._parentPrefetchLevels = opts.parentPrefetchLevels ?? 3;
    }

    // ====================== 生命周期 ======================

    protected onAttach(engine: Engine): void {
        const device = engine.device;

        // 顶点缓冲：所有瓦片共享同一个单位方块
        this._quadBuffer = device.createBuffer({
            label: 'raster-quad-vb',
            size: QUAD_VERTICES.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(this._quadBuffer, 0, QUAD_VERTICES);

        // 采样器：双线性，clamp 防止跨瓦片串色
        this._sampler = device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            // 暂未生成 mipmap；置 nearest 避免某些驱动在 minLOD 上的怪异行为
            mipmapFilter: 'nearest',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
        });

        // 全局 UBO：viewProj mat4
        this._globalUbo = device.createBuffer({
            label: 'raster-global-ubo',
            size: 64,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // BindGroup 布局
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
                    buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: TILE_UBO_DATA_SIZE },
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

        // 渲染管线
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
                    arrayStride: 8,
                    attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
                }],
            },
            fragment: {
                module,
                entryPoint: 'fs_main',
                targets: [{
                    format: engine.format,
                    blend: {
                        // 输入已 premultiplied alpha
                        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
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

        // 初始 UBO 容量
        this._growTileUbo(128);

        // 预加载"世界底图"——任何缩放层级的兜底父级
        this._preloadBaseTiles();
    }

    protected onDetach(): void {
        this._cache.clear();
        this._quadBuffer?.destroy();
        this._globalUbo?.destroy();
        this._tileUbo?.destroy();
    }

    // ====================== 每帧渲染 ======================

    protected onRender(ctx: FrameContext): void {
        const { engine, camera, pass, frame } = ctx;
        const device = engine.device;

        // 1) 写全局 UBO
        const vp = camera.getViewProjectionMatrix();
        device.queue.writeBuffer(this._globalUbo, 0, vp as Float32Array);

        // 2) 计算可见 ideal 瓦片
        const idealCoords = TilePyramid.getVisibleTiles(
            camera, this._source.minZoom, this._source.maxZoom,
        );
        if (idealCoords.length === 0) return;

        // 3) 对 ideal 瓦片发起请求；同时 prefetch 父级
        for (const coord of idealCoords) {
            const t = this._requestTile(coord);
            t.lastUsedFrame = frame;
            // 父级 prefetch：让 LRU 始终持有最近 N 级父级
            for (let d = 1; d <= this._parentPrefetchLevels && coord.z - d >= this._source.minZoom; d++) {
                const pc: TileCoord = { z: coord.z - d, x: coord.x >> d, y: coord.y >> d };
                const pt = this._requestTile(pc);
                pt.lastUsedFrame = frame;
            }
        }

        // 4) 构建绘制列表：
        //    fallbackDraws：父级回退（背景层），按 z 升序保证更近的祖先覆盖更远祖先
        //    tileDraws：    真实 ideal 瓦片（前景层）
        const fallbackDraws: DrawItem[] = [];
        const tileDraws: DrawItem[] = [];
        const now = ctx.time;

        for (const coord of idealCoords) {
            const tile = this._cache.get(tileKey(coord))!; // 上面 _requestTile 已确保存在
            const tw = Mercator.tileToWorld(coord);

            if (tile.state === TileState.Ready && tile.bindGroup) {
                // 真实 ideal 瓦片
                let opacity = 1;
                if (this._fadeIn) {
                    const readyAt = (tile as Tile & { _readyAt?: number })._readyAt ?? now;
                    opacity = Math.max(0, Math.min(1, (now - readyAt) / this._fadeDuration));
                    if (opacity < 1) {
                        this.onChange();
                        // cross-fade 期间在下面铺一张父级
                        const fb = this._buildFallbackDraw(coord, tw);
                        if (fb) fallbackDraws.push(fb);
                    }
                }
                tileDraws.push({
                    source: tile,
                    worldX: tw.x, worldY: tw.y, worldSize: tw.size,
                    uvX: 0, uvY: 0, uvScaleX: 1, uvScaleY: 1,
                    opacity,
                });
            } else {
                // ideal 未就绪 → 必有兜底（最差也有 z=0 底图）
                const fb = this._buildFallbackDraw(coord, tw);
                if (fb) fallbackDraws.push(fb);
            }
        }

        const totalDraws = fallbackDraws.length + tileDraws.length;
        if (totalDraws === 0) return;
        this._growTileUbo(totalDraws);

        // 5) emit draws
        pass.setPipeline(this._pipeline);
        pass.setVertexBuffer(0, this._quadBuffer);
        pass.setBindGroup(0, this._globalBindGroup);

        // 背景按 z 升序（先大祖先，后近祖先），让近的覆盖远的
        fallbackDraws.sort((a, b) => a.source.coord.z - b.source.coord.z);

        let i = 0;
        for (const d of fallbackDraws) i = this._emitDraw(device, pass, d, i);
        for (const d of tileDraws)     i = this._emitDraw(device, pass, d, i);
    }

    // ====================== 私有逻辑 ======================

    /** 写 UBO + setBindGroup + draw，返回下一个 drawIndex */
    private _emitDraw(
        device: GPUDevice,
        pass: GPURenderPassEncoder,
        d: DrawItem,
        drawIndex: number,
    ): number {
        if (!d.source.bindGroup) return drawIndex;
        const s = this._scratch;
        s[0] = d.worldX;  s[1] = d.worldY;  s[2] = d.worldSize;  s[3] = d.opacity;
        s[4] = d.uvX;     s[5] = d.uvY;     s[6] = d.uvScaleX;   s[7] = d.uvScaleY;
        const off = drawIndex * TILE_UBO_STRIDE;
        device.queue.writeBuffer(this._tileUbo, off, s);
        pass.setBindGroup(1, d.source.bindGroup, [off]);
        pass.draw(6, 1, 0, 0);
        return drawIndex + 1;
    }

    /** 查询或创建 Tile（同时刷新 LRU 位置） */
    private _ensureTile(coord: TileCoord): Tile {
        const key = tileKey(coord);
        let tile = this._cache.get(key);
        if (!tile) {
            tile = new Tile(coord);
            this._cache.set(key, tile);
        }
        return tile;
    }

    /**
     * 请求一个瓦片（幂等）：
     *   - Idle  → 加入加载队列
     *   - Loaded → 立即上传 GPU
     *   - 其它   → 无动作
     */
    private _requestTile(coord: TileCoord): Tile {
        const tile = this._ensureTile(coord);
        if (tile.state === TileState.Idle) {
            this._loader.request(tile, (t, err) => {
                if (err) {
                    console.warn('[webgpu-geo] tile load failed:', t.key, err.message);
                    return;
                }
                this._uploadToGPU(t);
                this.onChange();
            });
        } else if (tile.state === TileState.Loaded) {
            this._uploadToGPU(tile);
        }
        return tile;
    }

    /** 预加载世界底图（z=0..baseLoadZoom），作为永久兜底父级 */
    private _preloadBaseTiles(): void {
        if (this._baseLoadZoom < this._source.minZoom) return;
        const top = Math.min(this._baseLoadZoom, this._source.maxZoom);
        for (let z = this._source.minZoom; z <= top; z++) {
            const n = 1 << z;
            for (let x = 0; x < n; x++) {
                for (let y = 0; y < n; y++) {
                    this._requestTile({ z, x, y });
                }
            }
        }
    }

    /**
     * 为某 ideal 坐标构造一条用最近 Ready 祖先填充的 DrawItem。
     *
     * **关键优化**：在向上搜索过程中，对遇到的 Idle 祖先**立即发起加载**。
     * 这样即使首次因没有中间层级而只能用 z=baseLoadZoom 极度拉伸的纹理兜底，
     * 后续帧会逐渐有更高分辨率的中间祖先就绪，画面持续清晰化。
     * 这是 Mapbox "on-demand parent loading" 的核心机制。
     */
    private _buildFallbackDraw(
        coord: TileCoord,
        tw: { x: number; y: number; size: number },
    ): DrawItem | null {
        let best: DrawItem | null = null;
        for (let d = 1; d <= this._maxParentLookup && coord.z - d >= this._source.minZoom; d++) {
            const az = coord.z - d;
            const ax = coord.x >> d;
            const ay = coord.y >> d;
            const pc: TileCoord = { z: az, x: ax, y: ay };
            const anc = this._ensureTile(pc);
            // 懒触发加载：填补 baseLoadZoom..idealZ 之间的祖先空洞
            if (anc.state === TileState.Idle) {
                this._loader.request(anc, (t, err) => {
                    if (err) return;
                    this._uploadToGPU(t);
                    this.onChange();
                });
            } else if (anc.state === TileState.Loaded) {
                this._uploadToGPU(anc);
            }
            // 找到最近的 Ready 祖先即可返回（向上是越来越粗糙）
            if (anc.state === TileState.Ready && anc.bindGroup && !best) {
                const n = 1 << d;
                const localX = coord.x - (ax << d);
                const localY = coord.y - (ay << d);
                best = {
                    source: anc,
                    worldX: tw.x, worldY: tw.y, worldSize: tw.size,
                    uvX: localX / n,
                    uvY: localY / n,
                    uvScaleX: 1 / n,
                    uvScaleY: 1 / n,
                    opacity: 1,
                };
                // 找到一个就够了：返回，但循环里也已经在 ensure idle 的祖先了
                return best;
            }
        }
        return best;
    }

    /** 将 Loaded 瓦片的 ImageBitmap 上传到 GPU 纹理 */
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
            { texture, premultipliedAlpha: true },
            { width: size, height: size },
        );
        tile.texture = texture;
        tile.image.close?.();
        tile.image = null;

        tile.bindGroup = device.createBindGroup({
            label: `tile-bg-${tile.key}`,
            layout: this._tileBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this._tileUbo, size: TILE_UBO_DATA_SIZE } },
                { binding: 1, resource: texture.createView() },
                { binding: 2, resource: this._sampler },
            ],
        });
        tile.state = TileState.Ready;
        (tile as Tile & { _readyAt?: number })._readyAt = performance.now();
    }

    /** 扩容每瓦片 UBO（容量不够时），并重建所有已存在 tile 的 bindGroup */
    private _growTileUbo(needed: number): void {
        if (needed <= this._tileUboCapacity) return;
        let cap = Math.max(128, this._tileUboCapacity);
        while (cap < needed) cap *= 2;

        const device = this.engine.device;
        this._tileUbo?.destroy();
        this._tileUbo = device.createBuffer({
            label: 'raster-tile-ubo',
            size: cap * TILE_UBO_STRIDE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this._tileUboCapacity = cap;

        // buffer 句柄变了 → 重建所有 Ready 瓦片的 bindGroup
        this._cache.forEach((t) => {
            if (t.texture) {
                t.bindGroup = device.createBindGroup({
                    layout: this._tileBindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: this._tileUbo, size: TILE_UBO_DATA_SIZE } },
                        { binding: 1, resource: t.texture.createView() },
                        { binding: 2, resource: this._sampler },
                    ],
                });
            }
        });
    }
}
