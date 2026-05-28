import { mat4, vec3 } from 'gl-matrix';
import type { LngLat, WorldBounds } from '../geo/types';
import { Mercator } from '../geo/Mercator';

export type CameraChangeListener = () => void;

/** 投影模式 */
export type ProjectionMode = 'mercator' | 'globe';

/**
 * Camera —— 同时支持 2D 墨卡托 与 3D 球面 两种投影
 *
 * 状态：center(归一化 0..1 世界坐标) + zoom + viewport + bearing + pitch
 *
 * mercator 模式：正交投影，世界平面平铺
 * globe 模式：   透视投影，相机沿 +Z 距球心 d 处看向原点；
 *                顶点着色器把 (worldX, worldY) → 经纬度 → 单位球面 (x,y,z) → 应用 viewProj
 *
 * 距离 d 的设定：zoom=0 时整个球（直径 2）正好填满竖向视口
 *   d0 = 1 / tan(fov/2)；zoom 增加时 d = d0 / 2^zoom（带最小限制避免穿入球内）
 */
export class Camera {
    static readonly TILE_SIZE = 256;
    /** globe 模式透视 FOV（弧度） */
    static readonly FOV_Y = (45 * Math.PI) / 180;
    /** globe 模式相机离球心最近距离 */
    static readonly MIN_GLOBE_DIST = 1.05;

    private _projection: ProjectionMode = 'mercator';
    private _center = { x: 0.5, y: 0.5 };
    private _zoom = 0;
    private _minZoom = 0;
    private _maxZoom = 22;
    private _viewportW = 1;
    private _viewportH = 1;
    private _bearing = 0;
    private _pitch = 0;
    private _viewProj: mat4 = mat4.create();
    private _dirty = true;
    private _listeners: CameraChangeListener[] = [];

    onChange(cb: CameraChangeListener): () => void {
        this._listeners.push(cb);
        return () => {
            const i = this._listeners.indexOf(cb);
            if (i >= 0) this._listeners.splice(i, 1);
        };
    }
    private _emit() { for (const l of this._listeners) l(); }

    // ====================== 投影模式 ======================
    setProjection(mode: ProjectionMode): void {
        if (this._projection === mode) return;
        this._projection = mode;
        this._dirty = true;
        this._emit();
    }
    getProjection(): ProjectionMode { return this._projection; }

    // ====================== 视口 ======================
    setViewportSize(w: number, h: number): void {
        if (this._viewportW === w && this._viewportH === h) return;
        this._viewportW = Math.max(1, w);
        this._viewportH = Math.max(1, h);
        this._dirty = true;
        this._emit();
    }
    get viewportWidth() { return this._viewportW; }
    get viewportHeight() { return this._viewportH; }

    // ====================== center / zoom / bearing / pitch ======================
    setCenter(lngLat: LngLat): void {
        const w = Mercator.lngLatToWorld(lngLat);
        this.setCenterWorld(w.x, w.y);
    }
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

    setBearing(rad: number): void {
        if (this._bearing === rad) return;
        this._bearing = rad;
        this._dirty = true;
        this._emit();
    }
    getBearing(): number { return this._bearing; }

    setPitch(rad: number): void {
        const clamped = Math.max(0, Math.min(Math.PI / 3, rad));
        if (clamped === this._pitch) return;
        this._pitch = clamped;
        this._dirty = true;
        this._emit();
    }
    getPitch(): number { return this._pitch; }

    // ====================== 平面交互辅助（mercator 严格正确；globe 近似） ======================
    zoomAround(deltaZoom: number, px: number, py: number, dpr: number): void {
        if (this._projection === 'mercator') {
            const before = this.screenToWorld(px, py, dpr);
            this.setZoom(this._zoom + deltaZoom);
            const after = this.screenToWorld(px, py, dpr);
            this.setCenterWorld(
                this._center.x + (before.x - after.x),
                this._center.y + (before.y - after.y),
            );
        } else {
            // globe：先按"放大方向把中心拖向光标"近似锚点
            // dz>0（放大）时让 cursor 处的经纬度更靠近视图中心
            const cx = this._viewportW / 2 / dpr;
            const cy = this._viewportH / 2 / dpr;
            const offX = px - cx;
            const offY = py - cy;
            const oldZoom = this._zoom;
            this.setZoom(this._zoom + deltaZoom);
            // 只有 zoom 真正发生变化才补偿平移，避免在 min/max 边界让滚轮变成纯拖拽
            const actualDz = this._zoom - oldZoom;
            if (actualDz !== 0) {
                const factor = 1 - Math.pow(2, -actualDz);
                this.panByPixels(-offX * factor, -offY * factor, dpr);
            }
        }
    }
    screenToWorld(px: number, py: number, dpr: number): { x: number; y: number } {
        const upp = this.worldUnitsPerPixel();
        const cx = this._viewportW / 2 / dpr;
        const cy = this._viewportH / 2 / dpr;
        return {
            x: this._center.x + (px - cx) * upp * dpr,
            y: this._center.y + (py - cy) * upp * dpr,
        };
    }
    worldUnitsPerPixel(): number {
        return 1 / (Camera.TILE_SIZE * Math.pow(2, this._zoom));
    }
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

    // ====================== globe 模式参数 ======================
    /**
     * 相机距球心距离（单位球半径=1）。
     * 采用渐近公式 d = 1 + (d0-1)/2^zoom ——
     * zoom=0 时 d=d0，zoom 越大 d 越接近 1（但永不穿透），免掉硬铳造成的“高缩放无变化”。
     */
    getGlobeDistance(): number {
        const d0 = 1 / Math.tan(Camera.FOV_Y / 2);
        return 1 + (d0 - 1) / Math.pow(2, this._zoom);
    }

    /** globe 模式实际使用的垂直 FOV（保持固定，避免光学缩放带来的瓦片分辨率失配） */
    getGlobeFovY(): number {
        return Camera.FOV_Y;
    }

    /** globe 模式下，屏幕 1 像素对应球面多少弧度 */
    private _globeRadiansPerPixel(): number {
        const d = this.getGlobeDistance();
        const fov = this.getGlobeFovY();
        // 相机到球表面最近距离 ≈ d - 1；像素上对应屏幕 FOV / viewportH
        const surfaceDist = Math.max(0.01, d - 1);
        return (surfaceDist * fov) / Math.max(1, this._viewportH);
    }

    // ====================== 统一交互：像素 → camera 状态 ======================
    /**
     * 按屏幕像素增量平移地图（自动按当前投影模式选择策略）
     * dx>0 = 鼠标右移；dy>0 = 鼠标下移
     */
    panByPixels(dx: number, dy: number, dpr: number): void {
        if (this._projection === 'mercator') {
            const upp = this.worldUnitsPerPixel() * dpr;
            this.setCenterWorld(
                this._center.x - dx * upp,
                this._center.y - dy * upp,
            );
        } else {
            // globe：把像素增量变成经纬度增量（绕球心旋转）
            const radPerPx = this._globeRadiansPerPixel() * dpr;
            const ll = this.getCenter();
            const latRad = (ll.lat * Math.PI) / 180;
            const cosLat = Math.max(0.01, Math.cos(latRad));
            // 拖右 → 经度减小（看见东边像被往右拖）
            // 拖下 → 纬度增大（看见北边）
            let newLng = ll.lng - (dx * radPerPx * 180) / Math.PI / cosLat;
            let newLat = ll.lat + (dy * radPerPx * 180) / Math.PI;
            // 经度环绕到 [-180, 180]
            if (newLng > 180) newLng -= 360;
            else if (newLng < -180) newLng += 360;
            // 纬度限制（Web Mercator 极限 ±85.05°，避免反演 NaN）
            newLat = Math.max(-85.05, Math.min(85.05, newLat));
            this.setCenter({ lng: newLng, lat: newLat });
        }
    }

    // ====================== 投影矩阵 ======================
    getViewProjectionMatrix(): mat4 {
        if (!this._dirty) return this._viewProj;

        if (this._projection === 'mercator') {
            const upp = this.worldUnitsPerPixel();
            const halfW = (this._viewportW / 2) * upp;
            const halfH = (this._viewportH / 2) * upp;
            const left = this._center.x - halfW;
            const right = this._center.x + halfW;
            const bottom = this._center.y + halfH;
            const top = this._center.y - halfH;
            mat4.ortho(this._viewProj, left, right, bottom, top, -1, 1);

            if (this._bearing !== 0) {
                const rot = mat4.create();
                mat4.translate(rot, rot, [this._center.x, this._center.y, 0]);
                mat4.rotateZ(rot, rot, this._bearing);
                mat4.translate(rot, rot, [-this._center.x, -this._center.y, 0]);
                mat4.multiply(this._viewProj, this._viewProj, rot);
            }
        } else {
            // globe：投影 × 视图 × 模型旋转
            const aspect = this._viewportW / this._viewportH;
            const d = this.getGlobeDistance();
            const fov = this.getGlobeFovY();
            // 深度范围：贴近球面时 surfaceDist 可能极小，near 需按之按例缩小
            const surfaceDist = Math.max(1e-5, d - 1);
            const near = Math.max(1e-4, surfaceDist * 0.5);
            const far = d + 2;
            const proj = mat4.create();
            mat4.perspective(proj, fov, aspect, near, far);

            const view = mat4.create();
            mat4.lookAt(view,
                vec3.fromValues(0, 0, d),
                vec3.fromValues(0, 0, 0),
                vec3.fromValues(0, 1, 0));

            if (this._pitch !== 0) {
                const pitchMat = mat4.create();
                mat4.rotateX(pitchMat, pitchMat, -this._pitch);
                mat4.multiply(view, pitchMat, view);
            }
            if (this._bearing !== 0) {
                const bear = mat4.create();
                mat4.rotateZ(bear, bear, this._bearing);
                mat4.multiply(view, bear, view);
            }

            const ll = this.getCenter();
            const lngRad = (ll.lng * Math.PI) / 180;
            const latRad = (ll.lat * Math.PI) / 180;
            const model = mat4.create();
            mat4.rotateX(model, model, latRad);
            mat4.rotateY(model, model, -lngRad);

            mat4.multiply(this._viewProj, proj, view);
            mat4.multiply(this._viewProj, this._viewProj, model);
        }

        this._dirty = false;
        return this._viewProj;
    }
}
