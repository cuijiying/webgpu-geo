import { Engine, type EngineOptions } from './core/Engine';
import { Renderer } from './core/Renderer';
import { Camera } from './camera/Camera';
import { Layer } from './layers/Layer';
import { RasterTileLayer } from './layers/RasterTileLayer';
import { TileSource } from './tile/TileSource';
import { MapInteraction } from './control/MapInteraction';
import type { LngLat } from './geo/types';

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
export class Map {
    readonly engine: Engine;
    readonly camera: Camera;
    readonly renderer: Renderer;
    private _canvas: HTMLCanvasElement;
    private _interaction: MapInteraction | null = null;
    private _readyPromise: Promise<void>;
    private _resizeObserver: ResizeObserver | null = null;

    constructor(opts: MapOptions) {
        this._canvas = Map._resolveCanvas(opts.container);
        this.engine = new Engine(opts.engine);
        this.camera = new Camera();
        if (opts.minZoom !== undefined || opts.maxZoom !== undefined) {
            this.camera.setZoomRange(opts.minZoom ?? 0, opts.maxZoom ?? 22);
        }
        if (opts.zoom !== undefined) this.camera.setZoom(opts.zoom);
        if (opts.center) this.camera.setCenter(opts.center);
        this.renderer = new Renderer(this.engine, this.camera);

        // 相机变化 → 请求重绘
        this.camera.onChange(() => this.renderer.requestRender());

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

        // 监听容器尺寸变化（比 window.resize 更准确）
        if (typeof ResizeObserver !== 'undefined') {
            this._resizeObserver = new ResizeObserver(() => this.renderer.requestRender());
            this._resizeObserver.observe(this._canvas);
        } else {
            window.addEventListener('resize', this._onWindowResize);
        }

        this.renderer.start();
    }

    private readonly _onWindowResize = () => this.renderer.requestRender();

    /** 等待初始化完成 */
    ready(): Promise<void> { return this._readyPromise; }

    addLayer(layer: Layer): this { this.renderer.addLayer(layer); return this; }
    removeLayer(layer: Layer): this { this.renderer.removeLayer(layer); return this; }

    setCenter(lngLat: LngLat): this { this.camera.setCenter(lngLat); return this; }
    getCenter(): LngLat { return this.camera.getCenter(); }
    setZoom(z: number): this { this.camera.setZoom(z); return this; }
    getZoom(): number { return this.camera.getZoom(); }

    /** 销毁地图，释放所有资源 */
    destroy(): void {
        this.renderer.stop();
        this._interaction?.detach();
        this._interaction = null;
        this._resizeObserver?.disconnect();
        this._resizeObserver = null;
        window.removeEventListener('resize', this._onWindowResize);
        this.engine.destroy();
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
