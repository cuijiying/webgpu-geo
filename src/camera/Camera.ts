import { mat4 } from 'gl-matrix';
import type { LngLat, WorldBounds } from '../geo/types';
import { Mercator } from '../geo/Mercator';

/**
 * 相机变化回调
 */
export type CameraChangeListener = () => void;

/**
 * Camera —— 2D 墨卡托正交相机
 *
 * 状态模型：
 *   - center: 归一化 Mercator 世界坐标 (0..1) 的视图中心
 *   - zoom:   缩放级别（可为小数）。zoom = 0 时世界为 256px；
 *             每升 1 级，瓦片像素尺寸 ×2。
 *   - viewport: 画布物理像素尺寸（width × height）
 *
 * 投影模型：
 *   - 屏幕中心总是对齐 `center`
 *   - 每像素覆盖的"世界单位"为 worldUnitsPerPixel = 1 / (tileSize * 2^zoom)
 *   - 因此可见的世界范围 = viewport × worldUnitsPerPixel
 *   - 在 GPU 端使用一个 4x4 矩阵将 [worldX, worldY] 映射到 NDC：
 *       clipX =  2 * (worldX - center.x) / (viewWorldW)
 *       clipY = -2 * (worldY - center.y) / (viewWorldH)   // y 向下
 *
 * 该矩阵称为 viewProjection，所有图层共享。
 */
export class Camera {
    /** 单瓦片像素尺寸（标准 XYZ 瓦片 = 256） */
    static readonly TILE_SIZE = 256;

    private _center = { x: 0.5, y: 0.5 };
    private _zoom = 0;
    private _minZoom = 0;
    private _maxZoom = 22;
    private _viewportW = 1;
    private _viewportH = 1;
    private _bearing = 0; // 预留，单位：弧度
    private _viewProj: mat4 = mat4.create();
    private _dirty = true;
    private _listeners: CameraChangeListener[] = [];

    // ---- 监听 ----
    onChange(cb: CameraChangeListener): () => void {
        this._listeners.push(cb);
        return () => {
            const i = this._listeners.indexOf(cb);
            if (i >= 0) this._listeners.splice(i, 1);
        };
    }
    private _emit() { for (const l of this._listeners) l(); }

    // ---- 视口 ----
    setViewportSize(w: number, h: number): void {
        if (this._viewportW === w && this._viewportH === h) return;
        this._viewportW = Math.max(1, w);
        this._viewportH = Math.max(1, h);
        this._dirty = true;
        this._emit();
    }
    get viewportWidth() { return this._viewportW; }
    get viewportHeight() { return this._viewportH; }

    // ---- center ----
    /** 通过经纬度设置中心 */
    setCenter(lngLat: LngLat): void {
        const w = Mercator.lngLatToWorld(lngLat);
        this.setCenterWorld(w.x, w.y);
    }
    /** 通过归一化 Mercator 世界坐标设置中心 */
    setCenterWorld(x: number, y: number): void {
        this._center.x = x;
        this._center.y = Math.max(0, Math.min(1, y));
        this._dirty = true;
        this._emit();
    }
    getCenter(): LngLat {
        return Mercator.worldToLngLat(this._center.x, this._center.y);
    }
    getCenterWorld() { return { ...this._center }; }

    // ---- zoom ----
    setZoom(z: number): void {
        const clamped = Math.max(this._minZoom, Math.min(this._maxZoom, z));
        if (clamped === this._zoom) return;
        this._zoom = clamped;
        this._dirty = true;
        this._emit();
    }
    getZoom(): number { return this._zoom; }
    setZoomRange(min: number, max: number): void {
        this._minZoom = min;
        this._maxZoom = max;
        this.setZoom(this._zoom);
    }
    get minZoom() { return this._minZoom; }
    get maxZoom() { return this._maxZoom; }

    /**
     * 围绕指定屏幕像素点缩放（用于鼠标滚轮缩放，保证鼠标下世界点固定）
     * @param deltaZoom zoom 增量
     * @param px        屏幕像素 x（CSS 像素）
     * @param py        屏幕像素 y（CSS 像素）
     * @param dpr       devicePixelRatio
     */
    zoomAround(deltaZoom: number, px: number, py: number, dpr: number): void {
        const before = this.screenToWorld(px, py, dpr);
        this.setZoom(this._zoom + deltaZoom);
        const after = this.screenToWorld(px, py, dpr);
        // 平移：使 before == after
        this.setCenterWorld(
            this._center.x + (before.x - after.x),
            this._center.y + (before.y - after.y),
        );
    }

    /**
     * 屏幕像素 → 归一化世界坐标
     * @param dpr devicePixelRatio（输入像素是 CSS 像素时需要换算）
     */
    screenToWorld(px: number, py: number, dpr: number): { x: number; y: number } {
        const upp = this.worldUnitsPerPixel();
        const cx = this._viewportW / 2 / dpr;
        const cy = this._viewportH / 2 / dpr;
        return {
            x: this._center.x + (px - cx) * upp * dpr,
            y: this._center.y + (py - cy) * upp * dpr,
        };
    }

    /** 当前 zoom 下，1 像素对应的世界坐标长度 */
    worldUnitsPerPixel(): number {
        return 1 / (Camera.TILE_SIZE * Math.pow(2, this._zoom));
    }

    /** 当前视口在世界坐标系下的包围盒 */
    getVisibleWorldBounds(): WorldBounds {
        const upp = this.worldUnitsPerPixel();
        const halfW = (this._viewportW / 2) * upp;
        const halfH = (this._viewportH / 2) * upp;
        return {
            minX: this._center.x - halfW,
            minY: Math.max(0, this._center.y - halfH),
            maxX: this._center.x + halfW,
            maxY: Math.min(1, this._center.y + halfH),
        };
    }

    /** bearing（弧度） */
    setBearing(rad: number): void {
        if (this._bearing === rad) return;
        this._bearing = rad;
        this._dirty = true;
        this._emit();
    }
    getBearing(): number { return this._bearing; }

    /**
     * 返回 viewProjection 矩阵（mat4，列主序，可直接写入 GPU buffer）
     * 该矩阵把"归一化世界坐标 (x,y,0,1)"映射到 NDC。
     */
    getViewProjectionMatrix(): mat4 {
        if (!this._dirty) return this._viewProj;
        const upp = this.worldUnitsPerPixel();
        const halfW = (this._viewportW / 2) * upp;
        const halfH = (this._viewportH / 2) * upp;

        // 正交投影：left/right/bottom/top 围绕 center
        const left = this._center.x - halfW;
        const right = this._center.x + halfW;
        const bottom = this._center.y + halfH; // y 向下：bottom 数值更大
        const top = this._center.y - halfH;
        // gl-matrix 的 ortho：mat4.ortho(out, left, right, bottom, top, near, far)
        // 这里 bottom>top 等价于在 y 轴翻转，使世界 y 向下与屏幕 y 向下一致
        mat4.ortho(this._viewProj, left, right, bottom, top, -1, 1);

        if (this._bearing !== 0) {
            // 围绕 center 旋转
            const rot = mat4.create();
            mat4.translate(rot, rot, [this._center.x, this._center.y, 0]);
            mat4.rotateZ(rot, rot, this._bearing);
            mat4.translate(rot, rot, [-this._center.x, -this._center.y, 0]);
            mat4.multiply(this._viewProj, this._viewProj, rot);
        }

        this._dirty = false;
        return this._viewProj;
    }
}
