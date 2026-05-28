import type { Camera } from '../camera/Camera';
import type { TileCoord } from '../geo/types';

/**
 * TilePyramid —— 可见瓦片计算
 *
 * 根据相机状态，列出当前需要渲染的瓦片坐标集合：
 *   1) 选择目标 zoom 级别 = floor(camera.zoom)（受限于 source 的 min/max）
 *   2) 取视野在世界坐标下的包围盒，映射到该 zoom 下的瓦片网格
 *   3) 输出 [zMin, zMax] 范围内（含父级回退）的瓦片列表
 *
 * 本类是纯函数式工具（无状态），便于测试。
 */
export class TilePyramid {
    /**
     * 计算当前视野下应该被请求/渲染的瓦片坐标
     *
     * @param camera   当前相机
     * @param minZoom  瓦片源支持的最小 zoom
     * @param maxZoom  瓦片源支持的最大 zoom
     */
    static getVisibleTiles(camera: Camera, minZoom: number, maxZoom: number): TileCoord[] {
        const targetZ = Math.max(minZoom, Math.min(maxZoom, Math.round(camera.getZoom())));
        const b = camera.getVisibleWorldBounds();
        const n = 1 << targetZ;

        // 注意水平方向的经度环绕：x 可能为负或超过 n
        const minX = Math.floor(b.minX * n);
        const maxX = Math.floor(b.maxX * n);
        const minY = Math.max(0, Math.floor(b.minY * n));
        const maxY = Math.min(n - 1, Math.floor(b.maxY * n));

        const out: TileCoord[] = [];
        for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
                // 水平环绕处理：x 取模 n
                const wrappedX = ((x % n) + n) % n;
                out.push({ z: targetZ, x: wrappedX, y });
            }
        }
        return out;
    }
}
