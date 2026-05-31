import { Layer } from './Layer';
import type { Engine } from '../core/Engine';
import type { FrameContext } from '../core/Renderer';
import { GeoJSONSource } from '../geojson/GeoJSONSource';
import { parseColor, type RGBA } from '../geojson/color';
import {
    buildFillMesh, buildLineMesh, buildCircleInstances,
    FILL_FLOATS, LINE_FLOATS, CIRCLE_FLOATS,
    type Mesh,
} from '../geojson/geometry';
import type { ColorLike, Feature, GeoJSONData, Geometry, PaintValue, Position } from '../geojson/types';
import { FILL_WGSL, LINE_WGSL, CIRCLE_WGSL } from '../shaders/geojson.wgsl.ts';
import type { Camera } from '../camera/Camera';
import type { PixelXY } from '../geo/types';
import { Mercator } from '../geo/Mercator';
import { pointInScreenRing, distToPolyline } from '../control/hitTest';

/**
 * GeoJSONLayer 样式（Mapbox paint 风格的精简集合）
 *
 * 颜色 / 数值均支持常量或数据驱动表达式 ['get', '字段名']：
 *   fillColor: '#3bb2d0'                  // 常量
 *   fillColor: ['get', 'color']           // 读取 feature.properties.color
 */
export interface GeoJSONPaint {
    // 面
    fillColor?: PaintValue<ColorLike>;
    fillOpacity?: number;
    /** 设置后多边形边界以线渲染（描边色） */
    fillOutlineColor?: ColorLike;
    fillOutlineWidth?: number;
    // 线
    lineColor?: PaintValue<ColorLike>;
    /** 线宽（CSS 像素） */
    lineWidth?: PaintValue<number>;
    lineOpacity?: number;
    // 点（圆）
    circleColor?: PaintValue<ColorLike>;
    /** 圆半径（CSS 像素） */
    circleRadius?: PaintValue<number>;
    circleOpacity?: number;
    circleStrokeColor?: PaintValue<ColorLike>;
    circleStrokeWidth?: PaintValue<number>;
}

export interface GeoJSONLayerOptions {
    /** 图层 id（省略则自动生成） */
    id?: string;
    /** 数据：FeatureCollection / Feature / Geometry / 远程 URL */
    data: GeoJSONData;
    /** 样式 */
    paint?: GeoJSONPaint;
}

const DEFAULT_PAINT = {
    fillColor: '#3bb2d0' as ColorLike,
    fillOpacity: 0.5,
    fillOutlineWidth: 1,
    lineColor: '#3bb2d0' as ColorLike,
    lineWidth: 2,
    lineOpacity: 1,
    circleColor: '#ee6352' as ColorLike,
    circleRadius: 5,
    circleOpacity: 1,
    circleStrokeColor: '#ffffff' as ColorLike,
    circleStrokeWidth: 1,
};

/** 解析数据驱动取值 ['get', field] 或常量 */
function resolveColor(value: PaintValue<ColorLike> | undefined, feature: Feature, fallback: ColorLike): ColorLike {
    if (value === undefined) return fallback;
    if (Array.isArray(value) && value.length === 2 && value[0] === 'get') {
        const v = feature.properties?.[value[1] as string];
        return (v ?? fallback) as ColorLike;
    }
    return value as ColorLike;
}

function resolveNumber(value: PaintValue<number> | undefined, feature: Feature, fallback: number): number {
    if (value === undefined) return fallback;
    if (Array.isArray(value) && value.length === 2 && value[0] === 'get') {
        const v = feature.properties?.[value[1] as string];
        return typeof v === 'number' ? v : fallback;
    }
    return value as number;
}

/** 屏幕对齐圆所需的共享单位方块（两个三角形，角点 [-1,1]） */
const CIRCLE_CORNERS = new Float32Array([
    -1, -1, 1, -1, -1, 1,
    -1, 1, 1, -1, 1, 1,
]);

/**
 * GeoJSONLayer —— GeoJSON 点 / 线 / 面矢量图层
 *
 * 一个图层内同时渲染三类几何，各用独立管线：
 *   - Polygon/MultiPolygon → 三角填充（earcut 剖分）
 *   - LineString/MultiLineString → miter join 等宽线（可含多边形描边）
 *   - Point/MultiPoint → 实例化圆（billboard）
 *
 * 全部几何投影到归一化 Mercator 世界坐标，因此在 mercator / globe 模式下
 * 均能正确渲染（球面映射在着色器内完成）。
 */
export class GeoJSONLayer extends Layer {
    private _source: GeoJSONSource;
    private _paint: GeoJSONPaint;
    private _abort: AbortController | null = null;

    // 管线
    private _fillPipeline!: GPURenderPipeline;
    private _linePipeline!: GPURenderPipeline;
    private _circlePipeline!: GPURenderPipeline;

    // 全局 uniform
    private _globalUbo!: GPUBuffer;
    private _globalBindGroup!: GPUBindGroup;
    private _globalScratch = new Float32Array(24); // mat4(16) + params(4) + params2(4)

    // GPU 缓冲
    private _fillVbo: GPUBuffer | null = null;
    private _fillIbo: GPUBuffer | null = null;
    private _fillIndexCount = 0;
    private _lineVbo: GPUBuffer | null = null;
    private _lineIbo: GPUBuffer | null = null;
    private _lineIndexCount = 0;
    private _circleCornerVbo!: GPUBuffer;
    private _circleInstanceVbo: GPUBuffer | null = null;
    private _circleInstanceCount = 0;

    private _ready = false;

    constructor(opts: GeoJSONLayerOptions) {
        super(opts.id);
        this._paint = opts.paint ?? {};
        this._source = new GeoJSONSource(opts.data);
    }

    // ====================== 生命周期 ======================

    protected onAttach(engine: Engine): void {
        const device = engine.device;

        // 全局 UBO
        this._globalUbo = device.createBuffer({
            label: 'geojson-global-ubo',
            size: 96,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const globalBgl = device.createBindGroupLayout({
            label: 'geojson-global-bgl',
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                buffer: { type: 'uniform' },
            }],
        });
        this._globalBindGroup = device.createBindGroup({
            layout: globalBgl,
            entries: [{ binding: 0, resource: { buffer: this._globalUbo } }],
        });
        const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [globalBgl] });

        const blend: GPUBlendState = {
            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        };
        const target: GPUColorTargetState = { format: engine.format, blend };
        const depthStencil: GPUDepthStencilState = {
            format: 'depth24plus',
            depthWriteEnabled: false,   // 不写深度，避免互相干扰
            // 不与栅格球面做深度遮挡：矢量稀疏三角的"弦"会陷入球内，
            // 若用 less-equal 会被精细镶嵌的栅格球面错误遮挡。
            // globe 背面改由着色器逐像素地平线剔除。
            depthCompare: 'always',
        };
        const multisample = { count: engine.sampleCount };

        // —— 面填充管线 ——
        const fillModule = device.createShaderModule({ code: FILL_WGSL, label: 'geojson-fill' });
        this._fillPipeline = device.createRenderPipeline({
            label: 'geojson-fill-pipeline',
            layout: pipelineLayout,
            vertex: {
                module: fillModule, entryPoint: 'vs_main',
                buffers: [{
                    arrayStride: FILL_FLOATS * 4,
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: 'float32x2' },
                        { shaderLocation: 1, offset: 8, format: 'float32x4' },
                    ],
                }],
            },
            fragment: { module: fillModule, entryPoint: 'fs_main', targets: [target] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil, multisample,
        });

        // —— 线管线 ——
        const lineModule = device.createShaderModule({ code: LINE_WGSL, label: 'geojson-line' });
        this._linePipeline = device.createRenderPipeline({
            label: 'geojson-line-pipeline',
            layout: pipelineLayout,
            vertex: {
                module: lineModule, entryPoint: 'vs_main',
                buffers: [{
                    arrayStride: LINE_FLOATS * 4,
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: 'float32x2' },   // pos
                        { shaderLocation: 1, offset: 8, format: 'float32x2' },   // normal
                        { shaderLocation: 2, offset: 16, format: 'float32x4' },  // color
                        { shaderLocation: 3, offset: 32, format: 'float32' },    // width
                    ],
                }],
            },
            fragment: { module: lineModule, entryPoint: 'fs_main', targets: [target] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil, multisample,
        });

        // —— 圆（实例化）管线 ——
        const circleModule = device.createShaderModule({ code: CIRCLE_WGSL, label: 'geojson-circle' });
        this._circlePipeline = device.createRenderPipeline({
            label: 'geojson-circle-pipeline',
            layout: pipelineLayout,
            vertex: {
                module: circleModule, entryPoint: 'vs_main',
                buffers: [
                    {
                        arrayStride: 2 * 4, stepMode: 'vertex',
                        attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
                    },
                    {
                        arrayStride: CIRCLE_FLOATS * 4, stepMode: 'instance',
                        attributes: [
                            { shaderLocation: 1, offset: 0, format: 'float32x2' },   // center
                            { shaderLocation: 2, offset: 8, format: 'float32x4' },   // color
                            { shaderLocation: 3, offset: 24, format: 'float32' },    // radius
                            { shaderLocation: 4, offset: 28, format: 'float32x4' },  // strokeColor
                            { shaderLocation: 5, offset: 44, format: 'float32' },    // strokeWidth
                        ],
                    },
                ],
            },
            fragment: { module: circleModule, entryPoint: 'fs_main', targets: [target] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil, multisample,
        });

        // 圆角点共享缓冲
        this._circleCornerVbo = device.createBuffer({
            label: 'geojson-circle-corners',
            size: CIRCLE_CORNERS.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(this._circleCornerVbo, 0, CIRCLE_CORNERS);

        // 加载并构建（URL 异步，内联数据同步）
        this._loadAndBuild();
    }

    protected onDetach(): void {
        this._abort?.abort();
        this._abort = null;
        this._fillVbo?.destroy();
        this._fillIbo?.destroy();
        this._lineVbo?.destroy();
        this._lineIbo?.destroy();
        this._circleInstanceVbo?.destroy();
        this._circleCornerVbo?.destroy();
        this._globalUbo?.destroy();
        this._ready = false;
    }

    // ====================== 数据 / 样式更新 ======================

    /** 替换数据并重建几何 */
    setData(data: Exclude<GeoJSONData, string>): this {
        this._source.setData(data);
        if (this.engine) this._build();
        return this;
    }

    /** 合并更新样式并重建几何 */
    setPaint(paint: GeoJSONPaint): this {
        this._paint = { ...this._paint, ...paint };
        if (this.engine && this._source.loaded) this._build();
        return this;
    }

    /** 数据源（只读访问规范化后的 Feature 列表） */
    get source(): GeoJSONSource { return this._source; }

    // ====================== 命中测试（屏幕空间拾取） ======================

    /**
     * 拾取屏幕坐标下命中的要素。统一在屏幕 CSS 像素空间判定：
     *   - Polygon ：投影外环/洞为屏幕多边形，射线法判断内部（再排除落在洞内的情况）
     *   - LineString：点到折线最近距离 ≤ 线宽/2 + 容差
     *   - Point   ：点到圆心距离 ≤ 圆半径 + 描边宽 + 容差
     *
     * globe 模式下自动跳过背面（不可见半球）的顶点。返回顺序：后绘制的在前（顶层优先）。
     */
    hitTest(point: PixelXY, camera: Camera, dpr: number, tolerance: number): Feature[] {
        if (!this.visible || !this.interactive || !this._source.loaded) return [];
        const hits: Feature[] = [];
        const px = point.x;
        const py = point.y;

        for (const feature of this._source.features) {
            const geom = feature.geometry;
            if (!geom) continue;
            if (this._geometryHit(geom, feature, px, py, camera, dpr, tolerance)) {
                hits.push(feature);
            }
        }
        // 后添加（绘制在上层）的要素优先返回
        return hits.reverse();
    }

    private _geometryHit(
        geom: Geometry, feature: Feature,
        px: number, py: number,
        camera: Camera, dpr: number, tol: number,
    ): boolean {
        switch (geom.type) {
            case 'Point':
                return this._pointHit(geom.coordinates, feature, px, py, camera, dpr, tol);
            case 'MultiPoint':
                return geom.coordinates.some((c) => this._pointHit(c, feature, px, py, camera, dpr, tol));
            case 'LineString':
                return this._lineHit(geom.coordinates, feature, px, py, camera, dpr, tol);
            case 'MultiLineString':
                return geom.coordinates.some((l) => this._lineHit(l, feature, px, py, camera, dpr, tol));
            case 'Polygon':
                return this._polygonHit(geom.coordinates, px, py, camera, dpr);
            case 'MultiPolygon':
                return geom.coordinates.some((p) => this._polygonHit(p, px, py, camera, dpr));
            case 'GeometryCollection':
                return geom.geometries.some((g) => this._geometryHit(g, feature, px, py, camera, dpr, tol));
            default:
                return false;
        }
    }

    /** 经纬度坐标 → 屏幕 CSS 像素（含可见性） */
    private _project(coord: Position, camera: Camera, dpr: number) {
        const w = Mercator.lngLatToWorld({ lng: coord[0], lat: coord[1] });
        return camera.projectWorld(w.x, w.y, dpr);
    }

    private _pointHit(
        coord: Position, feature: Feature,
        px: number, py: number,
        camera: Camera, dpr: number, tol: number,
    ): boolean {
        const s = this._project(coord, camera, dpr);
        if (!s.visible) return false;
        const radius = resolveNumber(this._paint.circleRadius, feature, DEFAULT_PAINT.circleRadius);
        const stroke = resolveNumber(this._paint.circleStrokeWidth, feature, DEFAULT_PAINT.circleStrokeWidth);
        const r = radius + stroke + tol;
        const dx = px - s.x;
        const dy = py - s.y;
        return dx * dx + dy * dy <= r * r;
    }

    private _lineHit(
        coords: Position[], feature: Feature,
        px: number, py: number,
        camera: Camera, dpr: number, tol: number,
    ): boolean {
        const flat = this._projectRing(coords, camera, dpr);
        if (flat.length < 2) return false;
        const width = resolveNumber(this._paint.lineWidth, feature, DEFAULT_PAINT.lineWidth);
        const threshold = width / 2 + tol;
        return distToPolyline(px, py, flat) <= threshold;
    }

    private _polygonHit(rings: Position[][], px: number, py: number, camera: Camera, dpr: number): boolean {
        if (rings.length === 0) return false;
        const outer = this._projectRing(rings[0], camera, dpr);
        if (outer.length < 6 || !pointInScreenRing(px, py, outer)) return false;
        // 命中外环后，若落在任一洞内则不算命中
        for (let i = 1; i < rings.length; i++) {
            const hole = this._projectRing(rings[i], camera, dpr);
            if (hole.length >= 6 && pointInScreenRing(px, py, hole)) return false;
        }
        return true;
    }

    /** 投影一个坐标环到扁平屏幕坐标数组，跳过 globe 背面点 */
    private _projectRing(coords: Position[], camera: Camera, dpr: number): number[] {
        const out: number[] = [];
        for (const c of coords) {
            const s = this._project(c, camera, dpr);
            if (!s.visible || Number.isNaN(s.x)) continue;
            out.push(s.x, s.y);
        }
        return out;
    }

    private async _loadAndBuild(): Promise<void> {
        if (this._source.loaded) {
            this._build();
            return;
        }
        this._abort = new AbortController();
        try {
            await this._source.load(this._abort.signal);
            if (this.engine) {
                this._build();
                this.onChange();
            }
        } catch (err) {
            if ((err as Error).name !== 'AbortError') {
                console.error('[webgpu-geo] GeoJSON 加载失败：', err);
            }
        }
    }

    // ====================== 几何构建 ======================

    private _styleAlpha(base: RGBA, opacity: number): RGBA {
        return [base[0], base[1], base[2], base[3] * opacity];
    }

    private _build(): void {
        const device = this.engine.device;
        const features = this._source.features;
        const p = this._paint;

        // —— 面 ——
        const fillMesh = buildFillMesh(features, (f) => {
            const c = parseColor(resolveColor(p.fillColor, f, DEFAULT_PAINT.fillColor));
            return this._styleAlpha(c, p.fillOpacity ?? DEFAULT_PAINT.fillOpacity);
        });
        this._uploadFill(device, fillMesh);

        // —— 线（含可选的多边形描边）——
        const hasOutline = p.fillOutlineColor !== undefined;
        const lineMesh = buildLineMesh(
            features,
            (f) => {
                const isPolyOutline = f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon';
                if (isPolyOutline) {
                    const c = parseColor(p.fillOutlineColor, [0, 0, 0, 1]);
                    return { color: c, width: p.fillOutlineWidth ?? DEFAULT_PAINT.fillOutlineWidth };
                }
                const c = parseColor(resolveColor(p.lineColor, f, DEFAULT_PAINT.lineColor));
                const w = resolveNumber(p.lineWidth, f, DEFAULT_PAINT.lineWidth);
                return { color: this._styleAlpha(c, p.lineOpacity ?? DEFAULT_PAINT.lineOpacity), width: w };
            },
            hasOutline,
        );
        this._uploadLine(device, lineMesh);

        // —— 点（圆）——
        const circleData = buildCircleInstances(features, (f) => {
            const c = parseColor(resolveColor(p.circleColor, f, DEFAULT_PAINT.circleColor));
            const sc = parseColor(resolveColor(p.circleStrokeColor, f, DEFAULT_PAINT.circleStrokeColor));
            return {
                color: this._styleAlpha(c, p.circleOpacity ?? DEFAULT_PAINT.circleOpacity),
                radius: resolveNumber(p.circleRadius, f, DEFAULT_PAINT.circleRadius),
                strokeColor: sc,
                strokeWidth: resolveNumber(p.circleStrokeWidth, f, DEFAULT_PAINT.circleStrokeWidth),
            };
        });
        this._uploadCircle(device, circleData);

        this._ready = true;
        this.onChange();
    }

    private _uploadFill(device: GPUDevice, mesh: Mesh): void {
        this._fillVbo?.destroy();
        this._fillIbo?.destroy();
        this._fillVbo = null;
        this._fillIbo = null;
        this._fillIndexCount = 0;
        if (mesh.indices.length === 0) return;
        this._fillVbo = device.createBuffer({
            label: 'geojson-fill-vbo',
            size: mesh.vertices.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(this._fillVbo, 0, mesh.vertices);
        this._fillIbo = device.createBuffer({
            label: 'geojson-fill-ibo',
            size: mesh.indices.byteLength,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(this._fillIbo, 0, mesh.indices);
        this._fillIndexCount = mesh.indices.length;
    }

    private _uploadLine(device: GPUDevice, mesh: Mesh): void {
        this._lineVbo?.destroy();
        this._lineIbo?.destroy();
        this._lineVbo = null;
        this._lineIbo = null;
        this._lineIndexCount = 0;
        if (mesh.indices.length === 0) return;
        this._lineVbo = device.createBuffer({
            label: 'geojson-line-vbo',
            size: mesh.vertices.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(this._lineVbo, 0, mesh.vertices);
        this._lineIbo = device.createBuffer({
            label: 'geojson-line-ibo',
            size: mesh.indices.byteLength,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(this._lineIbo, 0, mesh.indices);
        this._lineIndexCount = mesh.indices.length;
    }

    private _uploadCircle(device: GPUDevice, data: Float32Array): void {
        this._circleInstanceVbo?.destroy();
        this._circleInstanceVbo = null;
        this._circleInstanceCount = 0;
        if (data.length === 0) return;
        this._circleInstanceVbo = device.createBuffer({
            label: 'geojson-circle-instances',
            size: data.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(this._circleInstanceVbo, 0, data);
        this._circleInstanceCount = data.length / CIRCLE_FLOATS;
    }

    // ====================== 渲染 ======================

    protected onRender(ctx: FrameContext): void {
        if (!this._ready) return;
        const { engine, camera, pass } = ctx;
        const device = engine.device;

        // 写全局 UBO
        const isGlobe = camera.getProjection() === 'globe';
        const vp = camera.getViewProjectionMatrix() as Float32Array;
        this._globalScratch.set(vp, 0);
        this._globalScratch[16] = isGlobe ? 1 : 0;
        this._globalScratch[17] = engine.width;
        this._globalScratch[18] = engine.height;
        this._globalScratch[19] = engine.devicePixelRatio;

        // params2：globe 地平线剔除参数（视图中心球面方向 + 1/相机距球心距离）
        if (isGlobe) {
            const c = camera.getCenter();
            const latR = (c.lat * Math.PI) / 180;
            const lngR = (c.lng * Math.PI) / 180;
            const cl = Math.cos(latR);
            // 与着色器 mercator_to_sphere 同一坐标系
            this._globalScratch[20] = cl * Math.sin(lngR);
            this._globalScratch[21] = Math.sin(latR);
            this._globalScratch[22] = cl * Math.cos(lngR);
            // 地平线 dot 阈值 = cos(θ_h) = 1/d
            this._globalScratch[23] = 1 / camera.getGlobeDistance();
        } else {
            this._globalScratch[20] = 0;
            this._globalScratch[21] = 0;
            this._globalScratch[22] = 0;
            this._globalScratch[23] = 0;
        }
        device.queue.writeBuffer(this._globalUbo, 0, this._globalScratch);

        // 绘制顺序：面 → 线 → 点（点在最上）
        if (this._fillIbo && this._fillIndexCount > 0) {
            pass.setPipeline(this._fillPipeline);
            pass.setBindGroup(0, this._globalBindGroup);
            pass.setVertexBuffer(0, this._fillVbo);
            pass.setIndexBuffer(this._fillIbo, 'uint32');
            pass.drawIndexed(this._fillIndexCount);
        }
        if (this._lineIbo && this._lineIndexCount > 0) {
            pass.setPipeline(this._linePipeline);
            pass.setBindGroup(0, this._globalBindGroup);
            pass.setVertexBuffer(0, this._lineVbo);
            pass.setIndexBuffer(this._lineIbo, 'uint32');
            pass.drawIndexed(this._lineIndexCount);
        }
        if (this._circleInstanceVbo && this._circleInstanceCount > 0) {
            pass.setPipeline(this._circlePipeline);
            pass.setBindGroup(0, this._globalBindGroup);
            pass.setVertexBuffer(0, this._circleCornerVbo);
            pass.setVertexBuffer(1, this._circleInstanceVbo);
            pass.draw(6, this._circleInstanceCount);
        }
    }
}
