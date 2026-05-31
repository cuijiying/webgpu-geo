import type { Camera } from '../camera/Camera';
import type { Map } from '../Map';
import type { Layer } from '../layers/Layer';
import type { Feature } from '../geojson/types';
import type { LngLat, PixelXY } from '../geo/types';
import { Mercator } from '../geo/Mercator';
import type {
    MapMouseEvent, MapWheelEvent, MapTouchEvent, QueryOptions, PickedFeature,
} from '../events/MapEvent';

/** 默认拾取容差（CSS 像素） */
const DEFAULT_TOLERANCE = 4;
/** 判定「点击」而非「拖拽」的最大位移（CSS 像素） */
const CLICK_MOVE_THRESHOLD = 3;

/**
 * MapEventManager —— 把浏览器原生 DOM 事件翻译为引擎语义事件
 *
 * 职责：
 *   1. 绑定 canvas 上的鼠标 / 滚轮 / 触摸事件，统一计算 point(CSS 像素) 与 lngLat
 *   2. 触发地图级事件（map.fire）
 *   3. 对存在监听的可交互图层做命中测试，触发图层级事件（layer.fire）
 *   4. 维护悬停状态，派生 mouseenter / mouseleave / mouseover / mouseout
 *   5. 派生 dragstart / drag / dragend（基于指针按下-移动-抬起）
 *
 * 注意：本类只负责「事件」，相机平移/缩放由 MapInteraction 负责，二者解耦。
 */
export class MapEventManager {
    private _canvas: HTMLCanvasElement;
    private _camera: Camera;
    private _map: Map;
    private _dpr: number;

    /** 当前悬停命中要素的图层集合（用于 enter/leave 派生） */
    private _hovered = new Set<Layer>();
    /** 鼠标按下的起始屏幕点（用于区分点击 / 拖拽） */
    private _downPoint: PixelXY | null = null;
    private _dragging = false;

    constructor(canvas: HTMLCanvasElement, camera: Camera, map: Map) {
        this._canvas = canvas;
        this._camera = camera;
        this._map = map;
        this._dpr = window.devicePixelRatio || 1;
    }

    // ====================== 绑定 / 解绑 ======================
    attach(): void {
        const c = this._canvas;
        c.addEventListener('mousedown', this._onMouseDown);
        c.addEventListener('mouseup', this._onMouseUp);
        c.addEventListener('mousemove', this._onMouseMove);
        c.addEventListener('mouseout', this._onMouseOut);
        c.addEventListener('click', this._onClick);
        c.addEventListener('dblclick', this._onDblClick);
        c.addEventListener('contextmenu', this._onContextMenu);
        c.addEventListener('wheel', this._onWheel, { passive: true });
        c.addEventListener('touchstart', this._onTouchStart, { passive: true });
        c.addEventListener('touchmove', this._onTouchMove, { passive: true });
        c.addEventListener('touchend', this._onTouchEnd);
        // 拖拽过程中指针可能移出 canvas，移动/抬起监听挂到 window
        window.addEventListener('mousemove', this._onWindowMouseMove);
        window.addEventListener('mouseup', this._onWindowMouseUp);
    }

    detach(): void {
        const c = this._canvas;
        c.removeEventListener('mousedown', this._onMouseDown);
        c.removeEventListener('mouseup', this._onMouseUp);
        c.removeEventListener('mousemove', this._onMouseMove);
        c.removeEventListener('mouseout', this._onMouseOut);
        c.removeEventListener('click', this._onClick);
        c.removeEventListener('dblclick', this._onDblClick);
        c.removeEventListener('contextmenu', this._onContextMenu);
        c.removeEventListener('wheel', this._onWheel);
        c.removeEventListener('touchstart', this._onTouchStart);
        c.removeEventListener('touchmove', this._onTouchMove);
        c.removeEventListener('touchend', this._onTouchEnd);
        window.removeEventListener('mousemove', this._onWindowMouseMove);
        window.removeEventListener('mouseup', this._onWindowMouseUp);
    }

    // ====================== 坐标换算 ======================
    private _pointFromClient(clientX: number, clientY: number): PixelXY {
        const rect = this._canvas.getBoundingClientRect();
        return { x: clientX - rect.left, y: clientY - rect.top };
    }

    private _lngLatFromPoint(point: PixelXY): LngLat {
        const world = this._camera.unprojectToWorld(point.x, point.y, this._dpr);
        if (!world) return { lng: NaN, lat: NaN };
        return Mercator.worldToLngLat(world.x, world.y);
    }

    // ====================== 拾取 ======================
    /** 对所有「可交互且 visible」图层做命中测试，返回 {layer -> features} */
    private _pickAll(point: PixelXY, tolerance = DEFAULT_TOLERANCE): globalThis.Map<Layer, Feature[]> {
        const result = new globalThis.Map<Layer, Feature[]>();
        const layers = this._map.renderer.layers;
        // 顶层优先：倒序遍历
        for (let i = layers.length - 1; i >= 0; i--) {
            const layer = layers[i];
            if (!layer.visible || !layer.interactive) continue;
            const features = layer.hitTest(point, this._camera, this._dpr, tolerance);
            if (features.length) result.set(layer, features);
        }
        return result;
    }

    /** 供 Map.queryRenderedFeatures 调用 */
    query(point: PixelXY, opts?: QueryOptions): PickedFeature[] {
        const tol = opts?.tolerance ?? DEFAULT_TOLERANCE;
        const filter = opts?.layers;
        const out: PickedFeature[] = [];
        const layers = this._map.renderer.layers;
        for (let i = layers.length - 1; i >= 0; i--) {
            const layer = layers[i];
            if (!layer.visible || !layer.interactive) continue;
            if (filter && !filter.includes(layer.id)) continue;
            for (const feature of layer.hitTest(point, this._camera, this._dpr, tol)) {
                out.push({ feature, layer });
            }
        }
        return out;
    }

    // ====================== 事件对象工厂 ======================
    private _makeMouseEvent(type: string, e: MouseEvent, point: PixelXY): MapMouseEvent {
        const ev: MapMouseEvent = {
            type,
            target: this._map,
            originalEvent: e,
            point,
            lngLat: this._lngLatFromPoint(point),
            defaultPrevented: false,
            preventDefault() { this.defaultPrevented = true; e.preventDefault(); },
        };
        return ev;
    }

    /**
     * 触发某个鼠标类事件：先派发地图级，再对命中图层派发图层级。
     * 返回命中的 {layer -> features}（mousemove 用其更新悬停状态）。
     */
    private _dispatchMouse(type: string, e: MouseEvent): globalThis.Map<Layer, Feature[]> {
        const point = this._pointFromClient(e.clientX, e.clientY);
        const base = this._makeMouseEvent(type, e, point);

        // 仅当存在图层监听时才做拾取，避免无谓开销
        const picked = this._anyLayerListens(type)
            ? this._pickAll(point)
            : new globalThis.Map<Layer, Feature[]>();

        // 地图级（携带最顶层命中要素，便于无需指定图层即可拿到要素）
        const top = picked.size ? [...picked.values()][0] : undefined;
        this._map.fire(type, { ...base, features: top, layer: top ? [...picked.keys()][0] : undefined });

        // 图层级
        for (const [layer, features] of picked) {
            if (!layer.listens(type)) continue;
            layer.fire(type, { ...base, layer, features });
        }
        return picked;
    }

    private _anyLayerListens(type: string): boolean {
        for (const layer of this._map.renderer.layers) {
            if (layer.interactive && layer.listens(type)) return true;
        }
        // enter/leave 依赖 mousemove 拾取
        if (type === 'mousemove') {
            for (const layer of this._map.renderer.layers) {
                if (layer.interactive
                    && (layer.listens('mouseenter') || layer.listens('mouseleave')
                        || layer.listens('mouseover') || layer.listens('mouseout'))) {
                    return true;
                }
            }
        }
        return false;
    }

    // ====================== 鼠标处理 ======================
    private readonly _onMouseDown = (e: MouseEvent) => {
        this._downPoint = this._pointFromClient(e.clientX, e.clientY);
        this._dragging = false;
        this._dispatchMouse('mousedown', e);
    };

    private readonly _onMouseUp = (e: MouseEvent) => {
        this._dispatchMouse('mouseup', e);
    };

    private readonly _onWindowMouseUp = (e: MouseEvent) => {
        if (this._dragging) {
            this._map.fire('dragend', this._makeMouseEvent('dragend', e,
                this._pointFromClient(e.clientX, e.clientY)));
        }
        this._dragging = false;
        this._downPoint = null;
    };

    private readonly _onMouseMove = (e: MouseEvent) => {
        const picked = this._dispatchMouse('mousemove', e);
        this._updateHover(picked, e);
    };

    private readonly _onWindowMouseMove = (e: MouseEvent) => {
        // 仅用于派生拖拽事件（按下后移动）
        if (!this._downPoint) return;
        const point = this._pointFromClient(e.clientX, e.clientY);
        const moved = Math.hypot(point.x - this._downPoint.x, point.y - this._downPoint.y);
        if (!this._dragging && moved > CLICK_MOVE_THRESHOLD) {
            this._dragging = true;
            this._map.fire('dragstart', this._makeMouseEvent('dragstart', e, point));
        }
        if (this._dragging) {
            this._map.fire('drag', this._makeMouseEvent('drag', e, point));
        }
    };

    private readonly _onMouseOut = (e: MouseEvent) => {
        // 指针离开 canvas：清空悬停，补发 leave
        for (const layer of this._hovered) {
            const ev = this._makeMouseEvent('mouseleave', e, this._pointFromClient(e.clientX, e.clientY));
            layer.fire('mouseleave', { ...ev, layer });
            layer.fire('mouseout', { ...ev, layer });
        }
        this._hovered.clear();
        this._map.fire('mouseout', this._makeMouseEvent('mouseout', e,
            this._pointFromClient(e.clientX, e.clientY)));
    };

    private readonly _onClick = (e: MouseEvent) => {
        // 拖拽后浏览器仍可能触发 click，按位移阈值过滤掉
        if (this._downPoint) {
            const point = this._pointFromClient(e.clientX, e.clientY);
            const moved = Math.hypot(point.x - this._downPoint.x, point.y - this._downPoint.y);
            if (moved > CLICK_MOVE_THRESHOLD) return;
        }
        this._dispatchMouse('click', e);
    };

    private readonly _onDblClick = (e: MouseEvent) => {
        this._dispatchMouse('dblclick', e);
    };

    private readonly _onContextMenu = (e: MouseEvent) => {
        this._dispatchMouse('contextmenu', e);
    };

    /** 根据本次 mousemove 的命中结果，派生 enter / leave / over / out */
    private _updateHover(picked: globalThis.Map<Layer, Feature[]>, e: MouseEvent): void {
        const point = this._pointFromClient(e.clientX, e.clientY);
        // 进入 / 移动
        for (const [layer, features] of picked) {
            const wasHovered = this._hovered.has(layer);
            if (!wasHovered) {
                this._hovered.add(layer);
                const ev = this._makeMouseEvent('mouseenter', e, point);
                if (layer.listens('mouseenter')) layer.fire('mouseenter', { ...ev, layer, features });
                if (layer.listens('mouseover')) layer.fire('mouseover', { ...ev, type: 'mouseover', layer, features });
            }
        }
        // 离开
        for (const layer of [...this._hovered]) {
            if (!picked.has(layer)) {
                this._hovered.delete(layer);
                const ev = this._makeMouseEvent('mouseleave', e, point);
                if (layer.listens('mouseleave')) layer.fire('mouseleave', { ...ev, layer });
                if (layer.listens('mouseout')) layer.fire('mouseout', { ...ev, type: 'mouseout', layer });
            }
        }
    }

    // ====================== 滚轮 ======================
    private readonly _onWheel = (e: WheelEvent) => {
        if (!this._map.listens('wheel')) return;
        const point = this._pointFromClient(e.clientX, e.clientY);
        const ev: MapWheelEvent = {
            type: 'wheel',
            target: this._map,
            originalEvent: e,
            point,
            lngLat: this._lngLatFromPoint(point),
            defaultPrevented: false,
            preventDefault() { this.defaultPrevented = true; },
        };
        this._map.fire('wheel', ev);
    };

    // ====================== 触摸 ======================
    private _makeTouchEvent(type: string, e: TouchEvent): MapTouchEvent {
        const list = e.touches.length ? e.touches : e.changedTouches;
        const points: PixelXY[] = [];
        for (let i = 0; i < list.length; i++) {
            points.push(this._pointFromClient(list[i].clientX, list[i].clientY));
        }
        const center = points.length
            ? points.reduce((a, p) => ({ x: a.x + p.x / points.length, y: a.y + p.y / points.length }), { x: 0, y: 0 })
            : { x: 0, y: 0 };
        return {
            type,
            target: this._map,
            originalEvent: e,
            points,
            point: center,
            lngLat: this._lngLatFromPoint(center),
            lngLats: points.map((p) => this._lngLatFromPoint(p)),
            defaultPrevented: false,
            preventDefault() { this.defaultPrevented = true; },
        };
    }

    private _touchStartPoint: PixelXY | null = null;

    private readonly _onTouchStart = (e: TouchEvent) => {
        if (e.touches.length === 1) {
            this._touchStartPoint = this._pointFromClient(e.touches[0].clientX, e.touches[0].clientY);
        } else {
            this._touchStartPoint = null;
        }
        if (this._map.listens('touchstart')) this._map.fire('touchstart', this._makeTouchEvent('touchstart', e));
    };

    private readonly _onTouchMove = (e: TouchEvent) => {
        if (this._touchStartPoint && e.touches.length === 1) {
            const p = this._pointFromClient(e.touches[0].clientX, e.touches[0].clientY);
            if (Math.hypot(p.x - this._touchStartPoint.x, p.y - this._touchStartPoint.y) > CLICK_MOVE_THRESHOLD) {
                this._touchStartPoint = null; // 视为拖拽，取消 tap
            }
        }
        if (this._map.listens('touchmove')) this._map.fire('touchmove', this._makeTouchEvent('touchmove', e));
    };

    private readonly _onTouchEnd = (e: TouchEvent) => {
        if (this._map.listens('touchend')) this._map.fire('touchend', this._makeTouchEvent('touchend', e));
        // 轻点（无明显位移）→ 触发 click，并对图层做拾取
        if (this._touchStartPoint) {
            const point = this._touchStartPoint;
            this._touchStartPoint = null;
            const synthetic = new MouseEvent('click', {
                clientX: point.x + this._canvas.getBoundingClientRect().left,
                clientY: point.y + this._canvas.getBoundingClientRect().top,
            });
            this._dispatchMouse('click', synthetic);
        }
    };
}
