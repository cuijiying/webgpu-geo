/**
 * 屏幕空间命中测试工具
 *
 * 拾取统一在「屏幕 CSS 像素」空间进行，从而：
 *   - 线 / 点的容差能以像素表达，符合直觉且与缩放无关
 *   - mercator 与 globe 两种投影都能复用同一套逻辑（差异封装在 Camera.projectWorld 内）
 */

/** 点是否落在多边形环内（射线法）。ring 为扁平坐标 [x0,y0,x1,y1,...] */
export function pointInScreenRing(px: number, py: number, ring: number[]): boolean {
    let inside = false;
    const n = ring.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = ring[i * 2], yi = ring[i * 2 + 1];
        const xj = ring[j * 2], yj = ring[j * 2 + 1];
        const intersect = (yi > py) !== (yj > py)
            && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
        if (intersect) inside = !inside;
    }
    return inside;
}

/** 点到线段距离的平方 */
export function distToSegmentSq(
    px: number, py: number,
    ax: number, ay: number,
    bx: number, by: number,
): number {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    const ex = px - cx;
    const ey = py - cy;
    return ex * ex + ey * ey;
}

/** 点到折线的最近距离（像素）。polyline 为扁平坐标 [x0,y0,...] */
export function distToPolyline(px: number, py: number, polyline: number[]): number {
    const n = polyline.length / 2;
    if (n === 0) return Infinity;
    if (n === 1) {
        const dx = px - polyline[0];
        const dy = py - polyline[1];
        return Math.hypot(dx, dy);
    }
    let min = Infinity;
    for (let i = 0; i < n - 1; i++) {
        const d = distToSegmentSq(
            px, py,
            polyline[i * 2], polyline[i * 2 + 1],
            polyline[(i + 1) * 2], polyline[(i + 1) * 2 + 1],
        );
        if (d < min) min = d;
    }
    return Math.sqrt(min);
}
