import { Layer } from './Layer';
import type { Engine } from '../core/Engine';
import type { FrameContext } from '../core/Renderer';
import { TileSource } from '../tile/TileSource';
import { TileCache } from '../tile/TileCache';
import { TileLoader, TileLoadPriority } from '../tile/TileLoader';
import { TilePyramid } from '../tile/TilePyramid';
import { Tile, TileState } from '../tile/Tile';
import { tileKey, type TileCoord } from '../geo/types';
import { Mercator } from '../geo/Mercator';
import { RASTER_TILE_WGSL } from '../shaders/raster.wgsl.ts';
import { vec3 } from 'gl-matrix';
/**
 * 栅格瓦片图层配置
 */
export interface RasterTileLayerOptions {
    /** 图层 id（省略则自动生成） */
    id?: string;
    source: TileSource;
    /** LRU 缓存容量（瓦片个数），默认 512 */
    cacheSize?: number;
    /** 同时进行的 HTTP 请求数，默认 6（贴合浏览器单域名连接上限） */
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

/** 镶嵌级别：N 表示一个瓦片被划分为 N×N 个小单元（(N+1)² 个顶点）
 * mercator 模式下其实N=1就够了；globe 模式需要足够细才能贴合球面。 */
const MESH_TESS = 32;

/** 生成 N×N 镶嵌的单位方块顶点 + 索引 */
function buildTessellatedQuad(n: number): { vertices: Float32Array; indices: Uint16Array } {
    const verts = new Float32Array((n + 1) * (n + 1) * 2);
    let vi = 0;
    for (let j = 0; j <= n; j++) {
        for (let i = 0; i <= n; i++) {
            verts[vi++] = i / n;
            verts[vi++] = j / n;
        }
    }
    const idx = new Uint16Array(n * n * 6);
    let ii = 0;
    for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
            const a = j * (n + 1) + i;
            const b = a + 1;
            const c = a + (n + 1);
            const d = c + 1;
            idx[ii++] = a; idx[ii++] = b; idx[ii++] = c;
            idx[ii++] = c; idx[ii++] = b; idx[ii++] = d;
        }
    }
    return { vertices: verts, indices: idx };
}

const { vertices: QUAD_VERTICES, indices: QUAD_INDICES } = buildTessellatedQuad(MESH_TESS);

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
    private _indexBuffer!: GPUBuffer;
    private _globalUbo!: GPUBuffer;
    private _globalBindGroup!: GPUBindGroup;
    private _tileBindGroupLayout!: GPUBindGroupLayout;
    // mipmap 生成（消除倾斜/远处瓦片的缩小走样）
    private _mipPipeline?: GPURenderPipeline;
    private _mipSampler?: GPUSampler;
    private _mipBgl?: GPUBindGroupLayout;
    private _tileUbo!: GPUBuffer;
    private _tileUboCapacity = 0;
    private _scratch = new Float32Array(8);
    /** 全局 UBO 临时缓冲：16 floats viewProj + 4 floats flags + 4 floats eye = 96 bytes */
    private _globalScratch = new Float32Array(24);
    /** globe 模式相机在基础球面空间的位置（每帧复用，免分配） */
    private _eyeScratch = vec3.create();
    /**
     * 当前在途（Idle 入队 / Loading）但尚未 Ready 的瓦片集合。
     * 每帧渲染末尾，凡 `lastUsedFrame` 不等于当前帧、且未被钉固者，
     * 说明已滚出视野 → 立即取消，释放浏览器连接槽，避免高层级
     * 快速平移/缩放时旧请求长期 pending 阻塞新进入视野的瓦片。
     */
    private _inflight = new Set<Tile>();

    constructor(opts: RasterTileLayerOptions) {
        super(opts.id);
        this.interactive = false; // 栅格瓦片图层默认不参与矢量拾取
        this._source = opts.source;
        this._cache = new TileCache(opts.cacheSize ?? 512);
        this._loader = new TileLoader(this._source, {
            maxConcurrent: opts.maxConcurrent ?? 6,
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

        // 顶点缓冲：所有瓦片共享同一个镶嵌单位方块
        this._quadBuffer = device.createBuffer({
            label: 'raster-quad-vb',
            size: QUAD_VERTICES.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(this._quadBuffer, 0, QUAD_VERTICES);

        // 索引缓冲
        this._indexBuffer = device.createBuffer({
            label: 'raster-quad-ib',
            size: QUAD_INDICES.byteLength,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(this._indexBuffer, 0, QUAD_INDICES);

        // 采样器：三线性（带 mipmap），clamp 防止跨瓦片串色。
        // mipmapFilter=linear 配合每张瓦片生成的 mip 链，消除球体倾斜后
        // 远处/掠射角瓦片的缩小走样（锯齿、闪烁）。
        this._sampler = device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
            maxAnisotropy: 16,
        });

        // 全局 UBO：viewProj mat4 + flags vec4 = 80 bytes
        this._globalUbo = device.createBuffer({
            label: 'raster-global-ubo',
            size: 96,
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
            primitive: {
                topology: 'triangle-list',
                // 不做背面剔除：球体远侧半球本就不在瓦片选择集中；而横跨地平线的瓦片
                // 需要把越过地平线的三角形也光栅化，交给片元着色器的「地平线解析覆盖」
                // 平滑淡出（见 raster.wgsl fs_main）。若在此剔除背面，几何边界会恰好停在
                // 地平线处，导致解析覆盖无法在可绘制区域内完整淡到 0，球体轮廓仍有锯齿。
                frontFace: 'cw',
                cullMode: 'none',
            },
            depthStencil: {
                format: 'depth24plus',
                // 不依赖深度缓冲做瓦片间遮挡：
                //  - 球体远侧半球的背面片元由 raster.wgsl fs_main 按地平线解析覆盖
                //    （h<0 → aa=0）直接 discard，不参与合成；
                //  - 前侧半球的瓦片在球面上互不重叠，按绘制顺序合成即可。
                // 若启用深度测试，相邻瓦片/不同细分级别的兜底瓦片会因球面三角
                // 近似误差而发生 z-fighting，在掠射角（大 pitch）下表现为底部
                // 出现带尖锐直边的三角形“空洞”。故关闭深度写入并恒为通过。
                depthWriteEnabled: false,
                depthCompare: 'always',
            },
            multisample: {
                count: engine.sampleCount,
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
        this._indexBuffer?.destroy();
        this._globalUbo?.destroy();
        this._tileUbo?.destroy();
    }

    // ====================== 每帧渲染 ======================

    protected onRender(ctx: FrameContext): void {
        const { engine, camera, pass, frame } = ctx;
        const device = engine.device;

        // 1) 写全局 UBO（viewProj + flags）
        const vp = camera.getViewProjectionMatrix() as Float32Array;
        const isGlobe = camera.getProjection() === 'globe';
        this._globalScratch.set(vp, 0);
        this._globalScratch[16] = isGlobe ? 1 : 0;
        this._globalScratch[17] = 0;
        this._globalScratch[18] = 0;
        this._globalScratch[19] = 0;
        // globe 模式：写入基础球面空间的相机位置（供片元地平线解析抗锯齿）
        if (isGlobe) {
            camera.getGlobeEyeModel(this._eyeScratch);
            this._globalScratch[20] = this._eyeScratch[0];
            this._globalScratch[21] = this._eyeScratch[1];
            this._globalScratch[22] = this._eyeScratch[2];
            this._globalScratch[23] = 0;
        }
        device.queue.writeBuffer(this._globalUbo, 0, this._globalScratch);

        // 2) 计算可见 ideal 瓦片
        //    球体与倾斜平面统一走「屏幕空间采样 + 逐采样点 LOD」：
        //    对每个屏幕采样点做反投影（球体=射线与单位球求交），用局部屏幕导数推算该处
        //    应有的瓦片层级。远处（近地平线）导数骤增→自动选粗瓦片，既能一路铺到真实
        //    地平线、又把瓦片数量控制在有限范围；地平线轮廓再由片元的解析覆盖平滑淡出。
        const idealCoords = isGlobe
            ? TilePyramid.getVisibleTilesTilted(
                camera, this._source.minZoom, this._source.maxZoom,
                window.devicePixelRatio || 1)
            : (camera.getPitch() !== 0 || camera.getBearing() !== 0)
                // 倾斜/旋转：屏幕空间采样 + 逐瓦片 LOD，铺满梯形视野到地平线
                ? TilePyramid.getVisibleTilesTilted(
                    camera, this._source.minZoom, this._source.maxZoom,
                    window.devicePixelRatio || 1)
                : TilePyramid.getVisibleTiles(camera, this._source.minZoom, this._source.maxZoom);
        if (idealCoords.length === 0) return;

        // 3) 对 ideal 瓦片发起请求；同时 prefetch 父级
        //    同时收集 ideal Tile 实例引用，避免后续因 LRU 淘汰而 cache miss
        //    Prefetch 设每帧预算上限，避免小比例尺一次性入队上百个 prefetch 拖垮队列
        const idealTiles: Tile[] = [];
        const PREFETCH_BUDGET_PER_FRAME = 32;
        let prefetchBudget = PREFETCH_BUDGET_PER_FRAME;
        for (const coord of idealCoords) {
            const t = this._requestTile(coord, TileLoadPriority.Visible);
            t.lastUsedFrame = frame;
            idealTiles.push(t);
            // 父级 prefetch：让 LRU 始终持有最近 N 级父级
            for (let d = 1; d <= this._parentPrefetchLevels && coord.z - d >= this._source.minZoom; d++) {
                if (prefetchBudget <= 0) break;
                const pc: TileCoord = { z: coord.z - d, x: coord.x >> d, y: coord.y >> d };
                const key = tileKey(pc);
                const existing = this._cache.get(key);
                // 已存在且不需重新请求 → 仅刷新 LRU 位置，不计入预算
                if (existing && existing.state !== TileState.Idle) {
                    existing.lastUsedFrame = frame;
                    continue;
                }
                const pt = this._requestTile(pc, TileLoadPriority.Prefetch);
                pt.lastUsedFrame = frame;
                prefetchBudget--;
            }
        }

        // 3.5) 取消上一帧请求、但本帧已不再需要（滚出视野）的在途瓦片。
        //      高层级快速平移/缩放时这是关键：及时 abort 让出浏览器连接槽，
        //      使新进入视野的瓦片不必排在大量陈旧 pending 请求之后。
        //      钉固的世界底图（base）永不取消。
        if (this._inflight.size > 0) {
            for (const t of this._inflight) {
                if (t.lastUsedFrame !== frame && !this._cache.isPinned(t.key)) {
                    this._loader.cancel(t);
                    this._inflight.delete(t);
                }
            }
        }

        // 4) 构建绘制列表：
        //    fallbackDraws：父级回退（背景层），按 z 升序保证更近的祖先覆盖更远祖先
        //    tileDraws：    真实 ideal 瓦片（前景层）
        const fallbackDraws: DrawItem[] = [];
        const tileDraws: DrawItem[] = [];
        const now = ctx.time;

        for (let i = 0; i < idealCoords.length; i++) {
            const coord = idealCoords[i];
            const tile = idealTiles[i];
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
        pass.setIndexBuffer(this._indexBuffer, 'uint16');
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
        pass.drawIndexed(QUAD_INDICES.length, 1, 0, 0, 0);
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
    private _requestTile(coord: TileCoord, priority: number = TileLoadPriority.Visible): Tile {
        const tile = this._ensureTile(coord);
        if (tile.state === TileState.Idle || tile.state === TileState.Loading) {
            this._inflight.add(tile);
            this._loader.request(tile, (t, err) => {
                this._inflight.delete(t);
                if (err) {
                    console.warn('[webgpu-geo] tile load failed:', t.key, err.message);
                    return;
                }
                this._uploadToGPU(t);
                this.onChange();
            }, priority);
        } else if (tile.state === TileState.Loaded) {
            this._uploadToGPU(tile);
        }
        return tile;
    }

    /** 预加载世界底图（z=0..baseLoadZoom），并**钉固**为永久兜底地板（永不被 LRU 淘汰） */
    private _preloadBaseTiles(): void {
        if (this._baseLoadZoom < this._source.minZoom) return;
        const top = Math.min(this._baseLoadZoom, this._source.maxZoom);
        for (let z = this._source.minZoom; z <= top; z++) {
            const n = 1 << z;
            for (let x = 0; x < n; x++) {
                for (let y = 0; y < n; y++) {
                    const coord = { z, x, y };
                    this._requestTile(coord, TileLoadPriority.Base);
                    // 钉固：保证任何缩放层级下 fallback 都有可用地板，杜绝空白
                    this._cache.pin(tileKey(coord));
                }
            }
        }
    }

    /**
     * 为某 ideal 坐标构造一条用最近 Ready 祖先填充的 DrawItem。
     *
     * **零副作用、零请求**：
     *   - 只用 `cache.peek` 向上查找最近的 Ready 祖先（不刷新 LRU、不创建 Tile、不入队请求）
     *   - base 底图已被钉固且必然就绪 → 任何 ideal（z≥minZoom）都至少能回退到 base 地板，
     *     因此**永不返回 null、永不空白**
     *
     * 中间层级的逐渐清晰化由 ideal 直接加载 + 每帧 prefetch 共同驱动，
     * 不再在此处逐级 `_loader.request` —— 那会在缩放瞬间产生数百次入队风暴。
     */
    private _buildFallbackDraw(
        coord: TileCoord,
        tw: { x: number; y: number; size: number },
    ): DrawItem | null {
        const maxLookup = Math.min(this._maxParentLookup, coord.z - this._source.minZoom);
        for (let d = 1; d <= maxLookup; d++) {
            const az = coord.z - d;
            const ax = coord.x >> d;
            const ay = coord.y >> d;
            const anc = this._cache.peek(tileKey({ z: az, x: ax, y: ay }));
            if (anc && anc.state === TileState.Ready && anc.bindGroup) {
                const denom = 1 << d;
                const localX = coord.x - (ax << d);
                const localY = coord.y - (ay << d);
                return {
                    source: anc,
                    worldX: tw.x, worldY: tw.y, worldSize: tw.size,
                    uvX: localX / denom,
                    uvY: localY / denom,
                    uvScaleX: 1 / denom,
                    uvScaleY: 1 / denom,
                    opacity: 1,
                };
            }
        }
        return null;
    }

    /** 将 Loaded 瓦片的 ImageBitmap 上传到 GPU 纹理 */
    private _uploadToGPU(tile: Tile): void {
        if (tile.state !== TileState.Loaded || !tile.image) return;
        const device = this.engine.device;
        const size = this._source.tileSize;
        // mip 链层级数：256 → 9 级。三线性采样需要完整 mip 链才能消除缩小走样。
        const mipLevelCount = Math.floor(Math.log2(size)) + 1;
        const texture = device.createTexture({
            label: `tile-tex-${tile.key}`,
            size: { width: size, height: size },
            format: 'rgba8unorm',
            mipLevelCount,
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
        // 逐级下采样生成 mipmap（WebGPU 无内置 generateMipmap）
        this._generateMips(texture, mipLevelCount);
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

    /** 惰性创建 mipmap 下采样所用的渲染管线 / 采样器 */
    private _ensureMipPipeline(): void {
        if (this._mipPipeline) return;
        const device = this.engine.device;
        const module = device.createShaderModule({
            label: 'mipgen-shader',
            code: /* wgsl */ `
struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn v(@builtin(vertex_index) i: u32) -> VOut {
    var p = array<vec2<f32>, 3>(vec2<f32>(-1.0,-1.0), vec2<f32>(3.0,-1.0), vec2<f32>(-1.0,3.0));
    var o: VOut;
    let xy = p[i];
    o.pos = vec4<f32>(xy, 0.0, 1.0);
    o.uv = xy * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5, 0.5);
    return o;
}
@group(0) @binding(0) var s: sampler;
@group(0) @binding(1) var t: texture_2d<f32>;
@fragment fn f(o: VOut) -> @location(0) vec4<f32> {
    return textureSample(t, s, o.uv);
}`,
        });
        this._mipBgl = device.createBindGroupLayout({
            label: 'mipgen-bgl',
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
            ],
        });
        this._mipSampler = device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'nearest',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
        });
        this._mipPipeline = device.createRenderPipeline({
            label: 'mipgen-pipeline',
            layout: device.createPipelineLayout({ bindGroupLayouts: [this._mipBgl] }),
            vertex: { module, entryPoint: 'v' },
            fragment: { module, entryPoint: 'f', targets: [{ format: 'rgba8unorm' }] },
            primitive: { topology: 'triangle-list' },
        });
    }

    /**
     * 逐级把 mip(i-1) 下采样渲染到 mip(i)，生成完整 mip 链。
     * 用全屏三角形 + 线性采样实现 2×2 box 平均（已是 premultiplied alpha，线性平均正确）。
     */
    private _generateMips(texture: GPUTexture, mipLevelCount: number): void {
        if (mipLevelCount <= 1) return;
        this._ensureMipPipeline();
        const device = this.engine.device;
        const encoder = device.createCommandEncoder({ label: 'mipgen' });
        for (let i = 1; i < mipLevelCount; i++) {
            const srcView = texture.createView({ baseMipLevel: i - 1, mipLevelCount: 1 });
            const dstView = texture.createView({ baseMipLevel: i, mipLevelCount: 1 });
            const bg = device.createBindGroup({
                layout: this._mipBgl!,
                entries: [
                    { binding: 0, resource: this._mipSampler! },
                    { binding: 1, resource: srcView },
                ],
            });
            const pass = encoder.beginRenderPass({
                colorAttachments: [{
                    view: dstView,
                    loadOp: 'clear',
                    storeOp: 'store',
                    clearValue: { r: 0, g: 0, b: 0, a: 0 },
                }],
            });
            pass.setPipeline(this._mipPipeline!);
            pass.setBindGroup(0, bg);
            pass.draw(3);
            pass.end();
        }
        device.queue.submit([encoder.finish()]);
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
