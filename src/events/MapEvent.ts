/**
 * 事件类型定义 —— 对齐 mapbox-gl 的事件语义，便于迁移与使用。
 */
import type { LngLat, PixelXY } from '../geo/types';
import type { Feature } from '../geojson/types';
import type { Map } from '../Map';
import type { Layer } from '../layers/Layer';

/** 地图级鼠标事件类型 */
export type MapMouseEventType =
    | 'mousedown' | 'mouseup' | 'mousemove' | 'mouseover' | 'mouseout'
    | 'click' | 'dblclick' | 'contextmenu';

/** 图层级鼠标事件类型（带要素拾取） */
export type MapLayerEventType =
    | 'mousedown' | 'mouseup' | 'mousemove'
    | 'mouseenter' | 'mouseleave' | 'mouseover' | 'mouseout'
    | 'click' | 'dblclick' | 'contextmenu';

/** 视图变换事件类型 */
export type MapCameraEventType =
    | 'movestart' | 'move' | 'moveend'
    | 'dragstart' | 'drag' | 'dragend'
    | 'zoomstart' | 'zoom' | 'zoomend'
    | 'rotatestart' | 'rotate' | 'rotateend'
    | 'pitchstart' | 'pitch' | 'pitchend';

/** 生命周期事件类型 */
export type MapLifecycleEventType =
    | 'load' | 'render' | 'idle' | 'resize' | 'remove' | 'error';

/**
 * 鼠标 / 指针类事件对象。
 *
 *   - point   : 相对 canvas 左上角的 CSS 像素坐标
 *   - lngLat  : 该屏幕位置对应的经纬度
 *   - features: 仅图层级事件携带，命中的要素列表（按从上到下顺序）
 */
export interface MapMouseEvent {
    type: string;
    target: Map;
    /** 触发该事件的图层（仅图层级事件存在） */
    layer?: Layer;
    /** 原始 DOM 事件 */
    originalEvent: MouseEvent;
    /** 屏幕坐标（canvas 内 CSS 像素） */
    point: PixelXY;
    /** 经纬度坐标 */
    lngLat: LngLat;
    /** 命中要素（仅图层级事件） */
    features?: Feature[];
    /** 是否已阻止默认行为 */
    defaultPrevented: boolean;
    /** 阻止地图内置默认行为（当前用于约定，可供上层扩展） */
    preventDefault(): void;
}

/** 滚轮事件对象 */
export interface MapWheelEvent {
    type: 'wheel';
    target: Map;
    originalEvent: WheelEvent;
    point: PixelXY;
    lngLat: LngLat;
    defaultPrevented: boolean;
    preventDefault(): void;
}

/** 触摸事件对象 */
export interface MapTouchEvent {
    type: string;
    target: Map;
    layer?: Layer;
    originalEvent: TouchEvent;
    /** 多点触摸的所有触点（CSS 像素） */
    points: PixelXY[];
    /** 触点几何中心 */
    point: PixelXY;
    /** 触点几何中心对应的经纬度 */
    lngLat: LngLat;
    /** 各触点对应经纬度 */
    lngLats: LngLat[];
    features?: Feature[];
    defaultPrevented: boolean;
    preventDefault(): void;
}

/** 视图变换 / 生命周期事件对象（轻量，仅携带来源信息） */
export interface MapCameraEvent {
    type: string;
    target: Map;
    /** 触发本次视图变化的原始 DOM 事件（程序触发时为 undefined） */
    originalEvent?: MouseEvent | WheelEvent | TouchEvent;
}

/** 错误事件对象 */
export interface MapErrorEvent {
    type: 'error';
    target: Map;
    error: Error;
}

/**
 * 拾取选项（queryRenderedFeatures / 图层命中测试）
 */
export interface QueryOptions {
    /** 限定参与拾取的图层 id 列表；省略则查询全部可拾取图层 */
    layers?: string[];
    /** 命中容差（CSS 像素），用于线 / 点的近邻判定，默认 4 */
    tolerance?: number;
}

/** 命中结果：要素 + 其所属图层 */
export interface PickedFeature {
    feature: Feature;
    layer: Layer;
}
