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

/**
 * 栅格瓦片图层配置
 */
export interface RasterTileLayerOptions {
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
    private _tileUbo!: GPUBuffer;
    private _tileUboCapacity = 0;
    private _scratch = new Float32Array(8);
    /** 全局 UBO 临时缓冲：16 floats viewProj + 4 floats flags = 80 bytes */
    private _globalScratch = new Float32Array(20);
    /** globe 模式上一帧选定的瓦片层级，用于滞回，避免 0.5 边界处反复跳变 */
    private _lastGlobeZ = -1;
    /**
     * 当前在途（Idle 入队 / Loading）但尚未 Ready 的瓦片集合。
     * 每帧渲染末尾，凡 `lastUsedFrame` 不等于当前帧、且未被钉固者，
     * 说明已滚出视野 → 立即取消，释放浏览器连接槽，避免高层级
     * 快速平移/缩放时旧请求长期 pending 阻塞新进入视野的瓦片。
     */
    private _inflight = new Set<Tile>();

    constructor(opts: RasterTileLayerOptions) {
        super();
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

        // 采样器：双线性，clamp 防止跨瓦片串色
        this._sampler = device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            // 暂未生成 mipmap；置 nearest 避免某些驱动在 minLOD 上的怪异行为
            mipmapFilter: 'nearest',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
        });

        // 全局 UBO：viewProj mat4 + flags vec4 = 80 bytes
        this._globalUbo = device.createBuffer({
            label: 'raster-global-ubo',
            size: 80,
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
                // 镶嵌 quad 的索引顺序是 CW（从屏幕外看）；球面也是 CW 朝外
                // 因此把 CW 作为正面，背面（地球远侧）被剔除以提升性能
                frontFace: 'cw',
                cullMode: 'back',
            },
            depthStencil: {
                format: 'depth24plus',
                // 启用深度写入与测试：球体模式下让近面遮挡远面；
                // 平面模式下所有瓦片同一 Z 平面，less-equal 允许正常覆写
                depthWriteEnabled: true,
                depthCompare: 'less-equal',
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
        device.queue.writeBuffer(this._globalUbo, 0, this._globalScratch);

        // 2) 计算可见 ideal 瓦片
        const idealCoords = isGlobe
            ? this._getGlobeVisibleTiles(camera)
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
     * Globe 模式下的可见瓦片选择
     *
     * 算法：
     *   1) targetZ = round(camera.zoom)
     *   2) 计算可见角半径 = horizon angle + padding
     *      horizon angle = acos(R / d)，R=1 是球半径，d 是相机距球心距离
     *   3) 把可见角换算成 targetZ 下的瓦片半径（基于"每弧度对应多少瓦片"）
     *   4) 仅枚举 center tile 周围这个矩形范围内的瓦片
     *   5) 对每个候选瓦片用"瓦片中心到 view center 的球面距离"做最终精确剔除
     *
     * 这样既不会全图扫描（O(4^z) 太慢），又不会漏掉边缘瓦片。
     */
    private _getGlobeVisibleTiles(camera: import('../camera/Camera').Camera): TileCoord[] {
        const center = camera.getCenter();
        const d = camera.getGlobeDistance();
        const horizonAng = Math.acos(Math.min(0.9999, 1 / d));
        const fov = camera.getGlobeFovY();
        const surfaceDist = Math.max(0.005, d - 1);

        // ===== z 选择：以"屏幕像素密度反推"为权威，camera.zoom 仅作下限保护 =====
        // globe 模式下 camera.zoom 控制的是距离公式 d=1+(d0-1)/2^zoom，
        // 与 mercator 中"zoom=z 表示瓦片宽=viewport/2^z"完全不同：
        //   zoom=2 时 d≈1.35，视口里可见弧长仅占赤道的 ~18%，需要 z≈6 的瓦片才能 1:1。
        // 所以这里必须用 desiredZ（按 radPerPx 反算）作为渲染细节级，
        // 否则远低于 desiredZ 会看到极度拉伸的糊图。
        // 卡顿问题已由 fallback 节流 + Base 优先级 + prefetch 预算 解决，无需在此封顶。
        const vh = Math.max(1, camera.viewportHeight);
        const vw = Math.max(1, camera.viewportWidth);
        const radPerPx = (surfaceDist * fov) / vh;
        const desiredZ = Math.log2((2 * Math.PI) / Math.max(1e-9, 256 * radPerPx));
        const camZ = camera.getZoom();
        const idealF = Math.max(desiredZ, camZ);
        const loZ = this._source.minZoom;
        const hiZ = this._source.maxZoom;
        // ===== 滞回（hysteresis）：用 ±0.6 死区 + 单步切换，避免缩放过程中 targetZ
        //       在两个整数间反复跳变引发"请求一整套新瓦片→GPU 上传风暴→闪烁" =====
        let targetZ: number;
        if (this._lastGlobeZ < 0) {
            targetZ = Math.round(idealF);
        } else if (idealF > this._lastGlobeZ + 0.6) {
            targetZ = this._lastGlobeZ + 1;   // 需要更清晰，升一级
        } else if (idealF < this._lastGlobeZ - 0.6) {
            targetZ = this._lastGlobeZ - 1;   // 可以更粗，降一级
        } else {
            targetZ = this._lastGlobeZ;       // 落在死区内，保持不变
        }
        targetZ = Math.max(loZ, Math.min(hiZ, targetZ));
        this._lastGlobeZ = targetZ;
        const n = 1 << targetZ;

        // ===== 计算可视半角（弧度，球面中心角） =====
        // 给定相机到球心 d、FOV 半角 α，球半径 1：
        //   - 若 α >= asin(1/d)：视锥比切线还宽，能看到整个可见半球 → 使用 horizonAng
        //   - 否则视锥与球面相交于 θ = atan2(t·sinα, d - t·cosα)，
        //     其中 t = d·cosα − √(1 − d²sin²α)
        const tangentHalfAng = Math.asin(Math.min(1, 1 / d));
        const aspect = vw / vh;
        const halfFovV = fov / 2;
        const halfFovH = Math.atan(Math.tan(halfFovV) * aspect);
        const visAngFor = (halfFov: number): number => {
            if (halfFov >= tangentHalfAng) return horizonAng;
            const sinA = Math.sin(halfFov);
            const cosA = Math.cos(halfFov);
            const disc = 1 - d * d * sinA * sinA;
            if (disc <= 0) return horizonAng;
            const t = d * cosA - Math.sqrt(disc);
            const px = t * sinA;
            const pz = d - t * cosA;
            return Math.atan2(px, pz);
        };
        const visAngV = visAngFor(halfFovV);
        const visAngH = visAngFor(halfFovH);
        // 取较大者作为外接圆半径，再加一个瓦片角半径的 padding 防边缘漏裁
        const tileAngRadius = (Math.SQRT2 * Math.PI) / n;
        const visAng = Math.min(Math.PI, Math.max(visAngV, visAngH) + 1.5 * tileAngRadius);

        const tilesPerRad = n / (2 * Math.PI);
        const tileRadius = Math.min(n, Math.ceil(visAng * tilesPerRad) + 1);

        const cTile = Mercator.lngLatToTile(center, targetZ);
        const cx = Math.floor(cTile.x);
        const cy = Math.floor(cTile.y);

        const minY = Math.max(0, cy - tileRadius);
        const maxY = Math.min(n - 1, cy + tileRadius);

        const centerLat = (center.lat * Math.PI) / 180;
        const centerLng = (center.lng * Math.PI) / 180;
        const sinCL = Math.sin(centerLat);
        const cosCL = Math.cos(centerLat);
        const cosVis = Math.cos(Math.min(Math.PI, visAng + tileAngRadius));

        const out: TileCoord[] = [];
        const seen = new Set<number>();
        for (let y = minY; y <= maxY; y++) {
            for (let dx = -tileRadius; dx <= tileRadius; dx++) {
                const rawX = cx + dx;
                const x = ((rawX % n) + n) % n; // 经度环绕
                // 去重（低 zoom 时 wrap 会让同一瓦片被多次枚举）
                const id = y * n + x;
                if (seen.has(id)) continue;
                seen.add(id);
                // 瓦片中心 → 经纬度
                const wx = (x + 0.5) / n;
                const wy = (y + 0.5) / n;
                const ll = Mercator.worldToLngLat(wx, wy);
                const lat = (ll.lat * Math.PI) / 180;
                const lng = (ll.lng * Math.PI) / 180;
                // cos(球面距离) = sinφ1 sinφ2 + cosφ1 cosφ2 cos(Δλ)
                const cosD =
                    sinCL * Math.sin(lat) +
                    cosCL * Math.cos(lat) * Math.cos(lng - centerLng);
                if (cosD >= cosVis) {
                    out.push({ z: targetZ, x, y });
                }
            }
        }
        return out;
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
