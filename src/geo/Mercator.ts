import type { LngLat, TileCoord } from './types';

/**
 * Web Mercator (EPSG:3857) 投影工具
 *
 * 本引擎使用"归一化 Mercator 世界坐标系"作为内部统一坐标：
 *   - 整张世界地图 = 一个 [0,1] x [0,1] 的正方形
 *   - 原点 (0, 0) 在西北角 (lng=-180, lat≈85.0511)
 *   - x 向东递增到 1 (lng=180)
 *   - y 向南递增到 1 (lat≈-85.0511)
 *
 * 这个坐标系的好处：
 *   1) 与 XYZ 瓦片方案天然对齐：在 zoom z 下，瓦片 (x,y) 占据
 *      [x/2^z, (x+1)/2^z] × [y/2^z, (y+1)/2^z]
 *   2) 不受具体地球半径影响，方便 GPU 端用 f32 表达
 *   3) 缩放只是相机层的事情，与世界坐标解耦
 */
export class Mercator {
    /** Web Mercator 投影可表达的最大纬度（约 85.05112878°） */
    static readonly MAX_LAT = 85.05112877980659;

    /** 将纬度限制到合法范围 */
    static clampLat(lat: number): number {
        return Math.max(-Mercator.MAX_LAT, Math.min(Mercator.MAX_LAT, lat));
    }

    /** 将经度规范化到 [-180, 180] */
    static wrapLng(lng: number): number {
        const wrapped = ((lng + 180) % 360 + 360) % 360 - 180;
        return wrapped;
    }

    /**
     * 经纬度 → 归一化世界坐标 (0..1)
     */
    static lngLatToWorld(lngLat: LngLat): { x: number; y: number } {
        const lat = Mercator.clampLat(lngLat.lat);
        const x = (lngLat.lng + 180) / 360;
        const sinLat = Math.sin((lat * Math.PI) / 180);
        // 标准 Web Mercator 公式
        const y = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
        return { x, y };
    }

    /**
     * 归一化世界坐标 (0..1) → 经纬度
     */
    static worldToLngLat(x: number, y: number): LngLat {
        const lng = x * 360 - 180;
        // 反 Mercator
        const n = Math.PI - 2 * Math.PI * y;
        const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
        return { lng, lat };
    }

    /**
     * 经纬度 → 瓦片坐标（带小数，用于判断当前 zoom 下的精确位置）
     */
    static lngLatToTile(lngLat: LngLat, z: number): { x: number; y: number } {
        const w = Mercator.lngLatToWorld(lngLat);
        const n = 1 << z;
        return { x: w.x * n, y: w.y * n };
    }

    /**
     * 瓦片坐标 → 归一化世界坐标（瓦片左上角）
     */
    static tileToWorld(t: TileCoord): { x: number; y: number; size: number } {
        const n = 1 << t.z;
        return { x: t.x / n, y: t.y / n, size: 1 / n };
    }
}
