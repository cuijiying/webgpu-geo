import { Layer } from './Layer';
import type { Engine } from '../core/Engine';
import type { FrameContext } from '../core/Renderer';
import type { ProjectionMode } from '../camera/Camera';
import { GLTF_WGSL } from '../shaders/gltf.wgsl.ts';
import { loadGltf, type GltfLoadOptions } from '../gltf/GLTFLoader';
import type { ParsedModel } from '../gltf/gltf-types';
import {
    buildPlacementGlobe, buildPlacementMercator,
    type PlacementParams, type PlacementMatrices,
} from '../gltf/geo';
import { MipmapGenerator } from '../gltf/MipmapGenerator';

/** GLTFLayer 配置 */
export interface GLTFLayerOptions extends PlacementParams {
    /** 图层 id（省略自动生成） */
    id?: string;
    /** 模型地址（.gltf 或 .glb） */
    url: string;
    /** 透传给 fetch 的加载选项 */
    loadOptions?: GltfLoadOptions;
    /**
     * 方向光方向，定义在模型本地 ENU 坐标（x=东, y=上, z=南），
     * 会随放置基底变换到引擎空间，故两种投影下光照表现一致。默认 [0.3, 1.0, 0.25]。
     */
    lightDirection?: [number, number, number];
    /** 环境光颜色 rgb（0..1），默认 [0.35, 0.35, 0.38] */
    ambientColor?: [number, number, number];
    /** 方向光强度，默认 0.9 */
    lightIntensity?: number;
}

/** 每条 draw 的 UBO 字节步长（dynamic offset 需 256 对齐） */
const DRAW_STRIDE = 256;
/** 每条 draw 的有效数据浮点数：model16 + normal12 + baseColor4 + params4 + emissive4 = 40 */
const DRAW_FLOATS = 40;

interface GpuPrimitive {
    vertexBuffer: GPUBuffer;
    indexBuffer: GPUBuffer;
    indexCount: number;
    bindGroup: GPUBindGroup;
    drawOffset: number;     // 在共享 draw UBO 中的字节偏移
    texture?: GPUTexture;
    // 材质静态部分（写入 draw UBO 的后 24 floats）
    baseColor: [number, number, number, number];
    params: [number, number, number, number];
    emissive: [number, number, number];
}

/**
 * GLTFLayer —— 在地图上指定经纬度/高度放置并渲染一个 glTF/glb 模型。
 *
 * 支持 mercator 与 globe 两种投影：每帧根据相机投影选择放置算法，把模型从局部米
 * 坐标变换到对应引擎空间。详见 docs/gltf-layer.md。
 */
export class GLTFLayer extends Layer {
    private _url: string;
    private _loadOptions?: GltfLoadOptions;
    private _placement: PlacementParams;
    private _lightLocal: [number, number, number];
    private _ambient: [number, number, number];
    private _intensity: number;

    private _pipeline!: GPURenderPipeline;
    private _globalBgl!: GPUBindGroupLayout;
    private _drawBgl!: GPUBindGroupLayout;
    private _globalUbo!: GPUBuffer;
    private _globalBindGroup!: GPUBindGroup;
    private _drawUbo!: GPUBuffer;
    private _sampler!: GPUSampler;
    private _whiteTexture!: GPUTexture;
    private _mipmaps!: MipmapGenerator;

    private _primitives: GpuPrimitive[] = [];
    private _ready = false;
    private _destroyed = false;

    // 放置矩阵缓存 + 投影脏标记
    private _mats: PlacementMatrices = { model: new Float32Array(16), normal: new Float32Array(12) };
    private _lastProjection: ProjectionMode | null = null;
    private _placementDirty = true;
    private _lightEngine = new Float32Array(3);

    private _globalScratch = new Float32Array(24); // viewProj(16)+lightDir(4)+ambient(4)
    private _drawScratch = new Float32Array(DRAW_FLOATS);

    constructor(opts: GLTFLayerOptions) {
        super(opts.id);
        this.interactive = false;
        this._url = opts.url;
        this._loadOptions = opts.loadOptions;
        this._placement = {
            lng: opts.lng, lat: opts.lat,
            altitude: opts.altitude, heading: opts.heading,
            pitch: opts.pitch, roll: opts.roll, scale: opts.scale,
        };
        this._lightLocal = opts.lightDirection ?? [0.3, 1.0, 0.25];
        this._ambient = opts.ambientColor ?? [0.35, 0.35, 0.38];
        this._intensity = opts.lightIntensity ?? 0.9;
    }

    /** 更新模型放置参数（经纬度/朝向/缩放等），下一帧生效 */
    setPlacement(params: Partial<PlacementParams>): void {
        Object.assign(this._placement, params);
        this._placementDirty = true;
        this.onChange();
    }

    // ====================== 生命周期 ======================

    protected onAttach(engine: Engine): void {
        const device = engine.device;
        this._mipmaps = new MipmapGenerator(device);

        this._sampler = device.createSampler({
            magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
            addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 16,
        });

        // 1×1 白色占位纹理（无基色贴图的图元复用）
        this._whiteTexture = device.createTexture({
            size: [1, 1], format: 'rgba8unorm-srgb',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture(
            { texture: this._whiteTexture },
            new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1],
        );

        // 全局 UBO：viewProj(64) + lightDir(16) + ambient(16) = 96 字节
        this._globalUbo = device.createBuffer({
            label: 'gltf-global-ubo', size: 96,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this._globalBgl = device.createBindGroupLayout({
            label: 'gltf-global-bgl',
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                buffer: { type: 'uniform' },
            }],
        });
        this._drawBgl = device.createBindGroupLayout({
            label: 'gltf-draw-bgl',
            entries: [
                {
                    binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: DRAW_FLOATS * 4 },
                },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
            ],
        });

        this._globalBindGroup = device.createBindGroup({
            label: 'gltf-global-bg', layout: this._globalBgl,
            entries: [{ binding: 0, resource: { buffer: this._globalUbo } }],
        });

        const module = device.createShaderModule({ code: GLTF_WGSL, label: 'gltf-shader' });
        this._pipeline = device.createRenderPipeline({
            label: 'gltf-pipeline',
            layout: device.createPipelineLayout({ bindGroupLayouts: [this._globalBgl, this._drawBgl] }),
            vertex: {
                module, entryPoint: 'vs_main',
                buffers: [{
                    arrayStride: 32,
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: 'float32x3' },  // position
                        { shaderLocation: 1, offset: 12, format: 'float32x3' }, // normal
                        { shaderLocation: 2, offset: 24, format: 'float32x2' }, // uv
                    ],
                }],
            },
            fragment: {
                module, entryPoint: 'fs_main',
                targets: [{
                    format: engine.format,
                    blend: {
                        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                    },
                }],
            },
            primitive: {
                topology: 'triangle-list',
                // mercator 左手系 / globe 右手系绕序相反，统一不剔除背面；
                // 法线由 inverse-transpose 保持朝外，光照在两种投影下均正确。
                cullMode: 'none',
            },
            depthStencil: {
                format: 'depth24plus',
                depthWriteEnabled: true,
                depthCompare: 'less-equal',
            },
            multisample: { count: engine.sampleCount },
        });

        // 异步加载模型
        this._loadModel(engine);
    }

    private async _loadModel(engine: Engine): Promise<void> {
        try {
            const model = await loadGltf(this._url, this._loadOptions);
            if (this._destroyed) return;
            this._buildGpu(engine, model);
            this._ready = true;
            this.onChange();
            this.fire('load');
        } catch (e) {
            console.error('[GLTFLayer] 模型加载失败:', e);
            this.fire('error', { error: e });
        }
    }

    private _buildGpu(engine: Engine, model: ParsedModel): void {
        const device = engine.device;
        const count = model.primitives.length;

        // 共享 draw UBO（按 256 对齐分槽）
        this._drawUbo = device.createBuffer({
            label: 'gltf-draw-ubo', size: Math.max(DRAW_STRIDE, count * DRAW_STRIDE),
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        model.primitives.forEach((prim, i) => {
            const vertexBuffer = device.createBuffer({
                label: `gltf-vb-${i}`, size: prim.vertices.byteLength,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
            device.queue.writeBuffer(vertexBuffer, 0, prim.vertices);

            const indexBuffer = device.createBuffer({
                label: `gltf-ib-${i}`, size: prim.indices.byteLength,
                usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
            });
            device.queue.writeBuffer(indexBuffer, 0, prim.indices);

            // 纹理
            let texture: GPUTexture | undefined;
            let textureView: GPUTextureView;
            if (prim.baseColorImage) {
                const img = prim.baseColorImage;
                const mip = MipmapGenerator.mipLevelCount(img.width, img.height);
                texture = device.createTexture({
                    label: `gltf-tex-${i}`,
                    size: [img.width, img.height],
                    format: 'rgba8unorm-srgb',
                    mipLevelCount: mip,
                    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
                });
                device.queue.copyExternalImageToTexture(
                    { source: img }, { texture }, [img.width, img.height],
                );
                this._mipmaps.generate(texture, 'rgba8unorm-srgb', img.width, img.height, mip);
                textureView = texture.createView();
                img.close?.();
            } else {
                textureView = this._whiteTexture.createView();
            }

            const drawOffset = i * DRAW_STRIDE;
            const bindGroup = device.createBindGroup({
                label: `gltf-draw-bg-${i}`, layout: this._drawBgl,
                entries: [
                    { binding: 0, resource: { buffer: this._drawUbo, offset: 0, size: DRAW_FLOATS * 4 } },
                    { binding: 1, resource: textureView },
                    { binding: 2, resource: this._sampler },
                ],
            });

            const alphaMode = prim.alphaMode === 'OPAQUE' ? 0 : prim.alphaMode === 'MASK' ? 1 : 2;
            this._primitives.push({
                vertexBuffer, indexBuffer, indexCount: prim.indices.length,
                bindGroup, drawOffset, texture,
                baseColor: prim.baseColorFactor,
                params: [prim.baseColorImage ? 1 : 0, prim.alphaCutoff, alphaMode, prim.doubleSided ? 1 : 0],
                emissive: prim.emissiveFactor,
            });
        });

        this._placementDirty = true;
    }

    // ====================== 放置矩阵 ======================

    private _rebuildPlacement(projection: ProjectionMode): void {
        if (projection === 'globe') buildPlacementGlobe(this._placement, this._mats);
        else buildPlacementMercator(this._placement, this._mats);

        // 把本地 ENU 光向用模型旋转(上 3×3)变换到引擎空间
        const m = this._mats.model;
        const [lx, ly, lz] = this._lightLocal;
        let ex = m[0] * lx + m[4] * ly + m[8] * lz;
        let ey = m[1] * lx + m[5] * ly + m[9] * lz;
        let ez = m[2] * lx + m[6] * ly + m[10] * lz;
        const len = Math.hypot(ex, ey, ez) || 1;
        this._lightEngine[0] = ex / len;
        this._lightEngine[1] = ey / len;
        this._lightEngine[2] = ez / len;

        // 把 draw UBO 中每个图元的 model/normal/材质块写入
        for (const p of this._primitives) {
            const s = this._drawScratch;
            s.set(this._mats.model, 0);     // 0..15
            s.set(this._mats.normal, 16);   // 16..27
            s[28] = p.baseColor[0]; s[29] = p.baseColor[1]; s[30] = p.baseColor[2]; s[31] = p.baseColor[3];
            s[32] = p.params[0]; s[33] = p.params[1]; s[34] = p.params[2]; s[35] = p.params[3];
            s[36] = p.emissive[0]; s[37] = p.emissive[1]; s[38] = p.emissive[2]; s[39] = 0;
            this.engine.device.queue.writeBuffer(this._drawUbo, p.drawOffset, s);
        }
        this._lastProjection = projection;
        this._placementDirty = false;
    }

    // ====================== 每帧渲染 ======================

    protected onRender(ctx: FrameContext): void {
        if (!this._ready || !this.visible) return;
        const { camera, pass } = ctx;
        const device = ctx.engine.device;
        const projection = camera.getProjection();

        if (this._placementDirty || projection !== this._lastProjection) {
            this._rebuildPlacement(projection);
        }

        // 全局 UBO
        const vp = camera.getViewProjectionMatrix() as Float32Array;
        this._globalScratch.set(vp, 0);
        this._globalScratch[16] = this._lightEngine[0];
        this._globalScratch[17] = this._lightEngine[1];
        this._globalScratch[18] = this._lightEngine[2];
        this._globalScratch[19] = 0;
        this._globalScratch[20] = this._ambient[0];
        this._globalScratch[21] = this._ambient[1];
        this._globalScratch[22] = this._ambient[2];
        this._globalScratch[23] = this._intensity;
        device.queue.writeBuffer(this._globalUbo, 0, this._globalScratch);

        pass.setPipeline(this._pipeline);
        pass.setBindGroup(0, this._globalBindGroup);
        for (const p of this._primitives) {
            pass.setBindGroup(1, p.bindGroup, [p.drawOffset]);
            pass.setVertexBuffer(0, p.vertexBuffer);
            pass.setIndexBuffer(p.indexBuffer, 'uint32');
            pass.drawIndexed(p.indexCount);
        }
    }

    protected onDetach(): void {
        this._destroyed = true;
        for (const p of this._primitives) {
            p.vertexBuffer.destroy();
            p.indexBuffer.destroy();
            p.texture?.destroy();
        }
        this._primitives = [];
        this._drawUbo?.destroy();
        this._globalUbo?.destroy();
        this._whiteTexture?.destroy();
    }
}
