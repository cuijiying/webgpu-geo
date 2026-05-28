/**
 * 经纬度坐标
 *  - lng: 经度，范围 [-180, 180]
 *  - lat: 纬度，范围 [-85.05112878, 85.05112878]（Web Mercator 有效范围）
 */
export interface LngLat {
    lng: number;
    lat: number;
}

/**
 * 标准 XYZ 瓦片坐标（Slippy Map / Web Mercator）
 *  - z: 缩放级别（0 = 整张世界一张瓦片）
 *  - x: 列，范围 [0, 2^z - 1]，向东递增
 *  - y: 行，范围 [0, 2^z - 1]，向南递增（TMS 反向，本引擎使用 Google/XYZ 约定）
 */
export interface TileCoord {
    z: number;
    x: number;
    y: number;
}

/**
 * 像素坐标（屏幕空间，左上角为 (0,0)）
 */
export interface PixelXY {
    x: number;
    y: number;
}

/**
 * 视口包围盒（归一化 Mercator 世界坐标，0..1）
 */
export interface WorldBounds {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

/**
 * 生成瓦片唯一 key，便于在 Map/缓存中使用
 */
export function tileKey(c: TileCoord): string {
    return `${c.z}/${c.x}/${c.y}`;
}
