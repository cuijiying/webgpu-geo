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

    /**
     * 倾斜 / 旋转（pitch>0 或 bearing≠0）下的可见瓦片计算（mercator）。
     *
     * 平面正交包围盒在倾斜后无法覆盖梯形视野（远处缺失），旋转后也会漏掉转角。
     * 这里改为 **屏幕空间采样 + 逐瓦片 LOD**：
     *   1) 在屏幕上按固定像素步长撒采样点；
     *   2) 每个采样点反投影到地面 (z=0)，得到世界坐标；
     *   3) 由该点邻域的「世界单位/像素」反算局部 zoom —— 近处高、远处低，
     *      天然形成细节层次，既能铺满到地平线又不会让瓦片数量爆炸；
     *   4) 落入对应 zoom 的瓦片并去重输出。
     *
     * @param dpr 设备像素比（屏幕 CSS 像素 → 设备像素）
     */
    static getVisibleTilesTilted(
        camera: Camera, minZoom: number, maxZoom: number, dpr: number,
    ): TileCoord[] {
        const cssW = camera.viewportWidth / dpr;
        const cssH = camera.viewportHeight / dpr;
        const STEP = 64;              // 采样步长（CSS 像素）
        const DELTA = 4;              // 估算局部尺度的邻域偏移（CSS 像素）
        const camZ = camera.getZoom();
        // hiZ（细节级上限）：
        //   - mercator：camera.zoom 即瓦片层级语义，round(camZ)+1 足够；
        //   - globe   ：camera.zoom 控制的是相机距离（d=1+(d0-1)/2^zoom），并非瓦片层级，
        //               其数值远低于实际所需 z（如 zoom=4 实际需 z≈7）。此时完全交给
        //               逐采样点的屏幕空间导数（wpp）推算 z，上限放宽到 maxZoom。
        const isGlobe = camera.getProjection() === 'globe';
        const hiZ = isGlobe ? maxZoom : Math.min(maxZoom, Math.round(camZ) + 1);

        const out: TileCoord[] = [];
        const seen = new Set<string>();

        const addPoint = (wx: number, wy: number, z: number) => {
            if (wy < 0 || wy > 1) return;             // 越过极区
            const n = 1 << z;
            const fx = wx - Math.floor(wx);            // 经度环绕到 [0,1)
            const tx = Math.min(n - 1, Math.floor(fx * n));
            const ty = Math.min(n - 1, Math.max(0, Math.floor(wy * n)));
            const key = z + '/' + tx + '/' + ty;
            if (seen.has(key)) return;
            seen.add(key);
            out.push({ z, x: tx, y: ty });
        };

        // 多撒一行/一列覆盖右下边缘
        for (let sy = 0; sy <= cssH + STEP; sy += STEP) {
            const y = Math.min(cssH, sy);
            for (let sx = 0; sx <= cssW + STEP; sx += STEP) {
                const x = Math.min(cssW, sx);
                const p0 = camera.unprojectToWorld(x, y, dpr);
                if (!p0) continue;                     // 地平线以上，无地面交点
                // 估算局部「世界单位 / CSS 像素」
                const pr = camera.unprojectToWorld(x + DELTA, y, dpr);
                const pd = camera.unprojectToWorld(x, y + DELTA, dpr);
                let wpp = 0;
                if (pr) wpp = Math.max(wpp, Math.hypot(pr.x - p0.x, pr.y - p0.y) / DELTA);
                if (pd) wpp = Math.max(wpp, Math.hypot(pd.x - p0.x, pd.y - p0.y) / DELTA);
                let z: number;
                if (wpp > 0) {
                    // zoom = log2( dpr / (256 · worldPerCssPx) )
                    z = Math.round(Math.log2(dpr / (256 * wpp)));
                } else {
                    z = minZoom;                       // 邻域都越过地平线 → 取最粗
                }
                z = Math.max(minZoom, Math.min(hiZ, z));
                addPoint(p0.x, p0.y, z);
            }
        }
        return out;
    }
}
