import { Engine, type EngineOptions } from './core/Engine';
import { Renderer } from './core/Renderer';
import { Camera, type ProjectionMode } from './camera/Camera';
import { Layer } from './layers/Layer';
import { RasterTileLayer } from './layers/RasterTileLayer';
import { GeoJSONLayer, type GeoJSONLayerOptions } from './layers/GeoJSONLayer';
import { TileSource } from './tile/TileSource';
import { MapInteraction } from './control/MapInteraction';
import { MapEventManager } from './control/MapEvents';
import { Evented, type EventListener } from './events/Evented';
import type { PickedFeature, QueryOptions } from './events/MapEvent';
import type { LngLat, PixelXY } from './geo/types';
import { Mercator } from './geo/Mercator';

/**
 * Map 创建选项
 */
export interface MapOptions {
    /** canvas 元素 ID 或元素本身 */
    container: string | HTMLCanvasElement;
    /** 初始中心点（经纬度） */
    center?: LngLat;
    /** 初始缩放级别 */
    zoom?: number;
    /** zoom 范围 */
    minZoom?: number;
    maxZoom?: number;
    /** 默认栅格瓦片源（不传则不添加默认图层） */
    tileSource?: TileSource | { url: string; subdomains?: string[]; attribution?: string };
    /** 是否启用鼠标/触摸交互，默认 true */
    interactive?: boolean;
    /** 初始投影模式：'mercator' (默认) | 'globe' (3D 球体) */
    projection?: ProjectionMode;
    /** 引擎选项 */
    engine?: EngineOptions;
}

/**
 * Map —— 地图主入口
 *
 * 用法：
 *   const map = new Map({ container: 'canvas', center: { lng: 116.4, lat: 39.9 }, zoom: 4 });
 *   await map.ready();
 *
 * 提供的能力：
 *   - 创建并管理 Engine / Camera / Renderer / Layers / Interaction
 *   - 暴露常用 API：setCenter / setZoom / addLayer / on('move')
 *   - destroy() 完整释放资源
 */
export class Map extends Evented {
    readonly engine: Engine;
    readonly camera: Camera;
    readonly renderer: Renderer;
    private _canvas: HTMLCanvasElement;
    private _interaction: MapInteraction | null = null;
    private _events: MapEventManager | null = null;
    private _readyPromise: Promise<void>;
    private _resizeObserver: ResizeObserver | null = null;
    private _dpr: number = window.devicePixelRatio || 1;

    // —— 视图变换事件派生：记录上一帧状态 + 各维度「结束」防抖计时器 ——
    private _prevState = { x: 0.5, y: 0.5, zoom: 0, bearing: 0, pitch: 0 };
    private _moveTimers: { [k: string]: number } = {};
    private _moving: { [k: string]: boolean } = {};

    constructor(opts: MapOptions) {
        super();
        this._canvas = Map._resolveCanvas(opts.container);
        this.engine = new Engine(opts.engine);
        this.camera = new Camera();
        if (opts.minZoom !== undefined || opts.maxZoom !== undefined) {
            this.camera.setZoomRange(opts.minZoom ?? 0, opts.maxZoom ?? 22);
        }
        if (opts.zoom !== undefined) this.camera.setZoom(opts.zoom);
        if (opts.center) this.camera.setCenter(opts.center);
        if (opts.projection) this.camera.setProjection(opts.projection);
        this.renderer = new Renderer(this.engine, this.camera);

        // 相机变化 → 请求重绘 + 派生 move/zoom/rotate/pitch 事件
        this._snapshotState();
        this.camera.onChange(() => {
            this.renderer.requestRender();
            this._emitCameraEvents();
        });

        this._readyPromise = this._initialize(opts);
    }

    private async _initialize(opts: MapOptions): Promise<void> {
        await this.engine.initialize(this._canvas);
        this.camera.setViewportSize(this.engine.width, this.engine.height);

        // 默认瓦片图层
        if (opts.tileSource) {
            const source = opts.tileSource instanceof TileSource
                ? opts.tileSource
                : new TileSource(opts.tileSource);
            this.renderer.addLayer(new RasterTileLayer({ source }));
        }

        // 交互
        if (opts.interactive !== false) {
            this._interaction = new MapInteraction(this._canvas, this.camera);
            this._interaction.attach();
        }

        // 事件分发器（始终启用，与相机交互解耦）
        this._events = new MapEventManager(this._canvas, this.camera, this);
        this._events.attach();

        // 监听容器尺寸变化（比 window.resize 更准确）
        if (typeof ResizeObserver !== 'undefined') {
            this._resizeObserver = new ResizeObserver(() => {
                this.renderer.requestRender();
                this.fire('resize', { type: 'resize', target: this });
            });
            this._resizeObserver.observe(this._canvas);
        } else {
            window.addEventListener('resize', this._onWindowResize);
        }

        this.renderer.start();
        // 首帧渲染后派发 load
        requestAnimationFrame(() => this.fire('load', { type: 'load', target: this }));
    }

    private readonly _onWindowResize = () => {
        this.renderer.requestRender();
        this.fire('resize', { type: 'resize', target: this });
    };

    /** 等待初始化完成 */
    ready(): Promise<void> { return this._readyPromise; }

    addLayer(layer: Layer): this { this.renderer.addLayer(layer); return this; }
    removeLayer(layer: Layer): this { this.renderer.removeLayer(layer); return this; }

    /**
     * 便捷添加 GeoJSON 矢量图层（点/线/面）。
     * 返回创建的 GeoJSONLayer，可用其 setData / setPaint 动态更新。
     */
    addGeoJSON(opts: GeoJSONLayerOptions): GeoJSONLayer {
        const layer = new GeoJSONLayer(opts);
        this.renderer.addLayer(layer);
        return layer;
    }

    setCenter(lngLat: LngLat): this { this.camera.setCenter(lngLat); return this; }
    getCenter(): LngLat { return this.camera.getCenter(); }
    setZoom(z: number): this { this.camera.setZoom(z); return this; }
    getZoom(): number { return this.camera.getZoom(); }

    /** 设置方位角（角度，0=正北，顺时针为正） */
    setBearing(deg: number): this { this.camera.setBearing((deg * Math.PI) / 180); return this; }
    /** 获取方位角（角度） */
    getBearing(): number { return (this.camera.getBearing() * 180) / Math.PI; }
    /** 设置俯仰角（角度，0=正俯视，最大 60°） */
    setPitch(deg: number): this { this.camera.setPitch((deg * Math.PI) / 180); return this; }
    /** 获取俯仰角（角度） */
    getPitch(): number { return (this.camera.getPitch() * 180) / Math.PI; }

    /** 切换投影模式（'mercator' | 'globe'），会触发重绘 */
    setProjection(mode: ProjectionMode): this { this.camera.setProjection(mode); return this; }
    getProjection(): ProjectionMode { return this.camera.getProjection(); }

    /** 按 id 获取图层 */
    getLayer(id: string): Layer | undefined {
        return this.renderer.layers.find((l) => l.id === id);
    }

    // ====================== 事件 API（支持图层级监听） ======================

    /**
     * 注册事件监听。两种形式：
     *   map.on('click', handler)            —— 地图级
     *   map.on('click', 'layerId', handler) —— 图层级（命中该图层要素时触发，事件含 features）
     */
    on(type: string, listener: EventListener): this;
    on(type: string, layerId: string, listener: EventListener): this;
    on(type: string, a: string | EventListener, b?: EventListener): this {
        return this._delegate('on', type, a, b);
    }

    /** 注册一次性监听（同 on 的两种形式；省略 listener 时返回 Promise） */
    once(type: string): Promise<any>;
    once(type: string, listener: EventListener): this;
    once(type: string, layerId: string, listener: EventListener): this;
    once(type: string, a?: string | EventListener, b?: EventListener): this | Promise<any> {
        if (a === undefined) return super.once(type);
        return this._delegate('once', type, a, b);
    }

    /** 取消监听（同 on 的两种形式） */
    off(type?: string, listener?: EventListener): this;
    off(type: string, layerId: string, listener: EventListener): this;
    off(type?: string, a?: string | EventListener, b?: EventListener): this {
        if (type === undefined) { super.off(); return this; }
        return this._delegate('off', type, a, b);
    }

    /** on/once/off 的统一委派：函数形式走地图级，id 形式走对应图层 */
    private _delegate(method: 'on' | 'once' | 'off', type: string, a?: string | EventListener, b?: EventListener): this {
        if (typeof a === 'function' || a === undefined) {
            (super[method] as (t: string, l?: EventListener) => unknown)(type, a as EventListener | undefined);
            return this;
        }
        const layer = this.getLayer(a);
        if (layer) {
            if (method !== 'off') layer.interactive = true;
            (layer[method] as (t: string, l?: EventListener) => unknown)(type, b);
        }
        return this;
    }

    // ====================== 坐标投影 ======================

    /** 经纬度 → 屏幕 CSS 像素坐标 */
    project(lngLat: LngLat): PixelXY {
        const w = Mercator.lngLatToWorld(lngLat);
        const s = this.camera.projectWorld(w.x, w.y, this._dpr);
        return { x: s.x, y: s.y };
    }

    /** 屏幕 CSS 像素坐标 → 经纬度 */
    unproject(point: PixelXY): LngLat {
        const w = this.camera.unprojectToWorld(point.x, point.y, this._dpr);
        if (!w) return { lng: NaN, lat: NaN };
        return Mercator.worldToLngLat(w.x, w.y);
    }

    /** 查询指定屏幕点下渲染命中的要素（含所属图层） */
    queryRenderedFeatures(point: PixelXY, opts?: QueryOptions): PickedFeature[] {
        return this._events ? this._events.query(point, opts) : [];
    }

    /** 销毁地图，释放所有资源 */
    destroy(): void {
        this.fire('remove', { type: 'remove', target: this });
        for (const k in this._moveTimers) clearTimeout(this._moveTimers[k]);
        this.renderer.stop();
        this._interaction?.detach();
        this._interaction = null;
        this._events?.detach();
        this._events = null;
        this._resizeObserver?.disconnect();
        this._resizeObserver = null;
        window.removeEventListener('resize', this._onWindowResize);
        this.engine.destroy();
        this.off();
    }

    // ====================== 视图变换事件派生 ======================

    private _snapshotState(): void {
        const c = this.camera.getCenterWorld();
        this._prevState = {
            x: c.x, y: c.y,
            zoom: this.camera.getZoom(),
            bearing: this.camera.getBearing(),
            pitch: this.camera.getPitch(),
        };
    }

    private _emitCameraEvents(): void {
        const c = this.camera.getCenterWorld();
        const zoom = this.camera.getZoom();
        const bearing = this.camera.getBearing();
        const pitch = this.camera.getPitch();
        const p = this._prevState;
        const moved = c.x !== p.x || c.y !== p.y;
        const zoomed = zoom !== p.zoom;
        const rotated = bearing !== p.bearing;
        const pitched = pitch !== p.pitch;
        if (zoomed) this._transition('zoom');
        if (rotated) this._transition('rotate');
        if (pitched) this._transition('pitch');
        // 与 mapbox 一致：缩放/旋转/倾斜均视为一次 move
        if (moved || zoomed || rotated || pitched) this._transition('move');
        this._snapshotState();
    }

    /** 以「start → 持续 → 防抖 end」模型派发某维度的变换事件 */
    private _transition(name: string): void {
        if (!this._moving[name]) {
            this._moving[name] = true;
            this.fire(`${name}start`, { type: `${name}start`, target: this });
        }
        this.fire(name, { type: name, target: this });
        clearTimeout(this._moveTimers[name]);
        this._moveTimers[name] = setTimeout(() => {
            this._moving[name] = false;
            this.fire(`${name}end`, { type: `${name}end`, target: this });
        }, 200) as unknown as number;
    }

    private static _resolveCanvas(c: string | HTMLCanvasElement): HTMLCanvasElement {
        if (typeof c === 'string') {
            const el = document.getElementById(c);
            if (!el || !(el instanceof HTMLCanvasElement)) {
                throw new Error(`找不到 id=${c} 的 canvas 元素`);
            }
            return el;
        }
        return c;
    }
}
