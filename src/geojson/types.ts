/**
 * GeoJSON 类型定义（RFC 7946 子集）
 *
 * 仅覆盖本引擎矢量渲染需要的几何与要素结构。坐标统一为 [lng, lat]（GeoJSON 规范顺序）。
 */

/** 经纬度坐标对 [lng, lat]（可带可选高程，渲染时忽略高程） */
export type Position = [number, number] | [number, number, number];

export interface PointGeometry {
    type: 'Point';
    coordinates: Position;
}
export interface MultiPointGeometry {
    type: 'MultiPoint';
    coordinates: Position[];
}
export interface LineStringGeometry {
    type: 'LineString';
    coordinates: Position[];
}
export interface MultiLineStringGeometry {
    type: 'MultiLineString';
    coordinates: Position[][];
}
export interface PolygonGeometry {
    type: 'Polygon';
    /** 第一个环为外环，其余为洞 */
    coordinates: Position[][];
}
export interface MultiPolygonGeometry {
    type: 'MultiPolygon';
    coordinates: Position[][][];
}
export interface GeometryCollection {
    type: 'GeometryCollection';
    geometries: Geometry[];
}

export type Geometry =
    | PointGeometry
    | MultiPointGeometry
    | LineStringGeometry
    | MultiLineStringGeometry
    | PolygonGeometry
    | MultiPolygonGeometry
    | GeometryCollection;

export interface Feature {
    type: 'Feature';
    geometry: Geometry | null;
    properties?: Record<string, unknown> | null;
    id?: string | number;
}

export interface FeatureCollection {
    type: 'FeatureCollection';
    features: Feature[];
}

/** GeoJSONLayer 接受的数据形态：要素集合 / 单要素 / 单几何 / 远程 URL */
export type GeoJSONData = FeatureCollection | Feature | Geometry | string;

/** 颜色：CSS 颜色字符串（#rgb/#rrggbb/#rrggbbaa/rgb()/rgba()）或归一化 RGBA 数组 */
export type ColorLike = string | [number, number, number, number];

/**
 * paint 取值：常量，或从 feature.properties 取值的字段名表达式。
 * 形如 ['get', 'fieldName'] 时按要素属性取值，实现数据驱动样式。
 */
export type PaintValue<T> = T | ['get', string];
