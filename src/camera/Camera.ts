import { mat4, vec3, vec4 } from 'gl-matrix';
import type { LngLat, WorldBounds } from '../geo/types';
import { Mercator } from '../geo/Mercator';

/** 世界坐标 → 屏幕坐标的投影结果 */
export interface ScreenProjection {
    /** canvas 内 CSS 像素 X */
    x: number;
    /** canvas 内 CSS 像素 Y */
    y: number;
    /** 在 globe 模式下该点是否位于可见半球（mercator 恒为 true） */
    visible: boolean;
}

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
    /** mercator 倾斜（pitch）时使用的透视 FOV（弧度，约 36.87°，与 mapbox 一致） */
    static readonly MERCATOR_FOV = 0.6435011087932844;
    /** 最大俯仰角（弧度，60°） */
    static readonly MAX_PITCH = (60 * Math.PI) / 180;
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
        const clamped = Math.max(0, Math.min(Camera.MAX_PITCH, rad));
        if (clamped === this._pitch) return;
        this._pitch = clamped;
        this._dirty = true;
        this._emit();
    }
    getPitch(): number { return this._pitch; }

    // ====================== 平面交互辅助（mercator 严格正确；globe 近似） ======================
    zoomAround(deltaZoom: number, px: number, py: number, dpr: number): void {
        if (this._projection === 'mercator') {
            const before = this.unprojectToWorld(px, py, dpr) ?? this.screenToWorld(px, py, dpr);
            this.setZoom(this._zoom + deltaZoom);
            const after = this.unprojectToWorld(px, py, dpr) ?? this.screenToWorld(px, py, dpr);
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

    // ====================== 世界 → 屏幕 投影（拾取 / project 用） ======================
    /**
     * 世界坐标 → 屏幕 CSS 像素。
     *   - mercator：正交反算，精确
     *   - globe   ：复用着色器的 mercator→球面映射，经 viewProj 投影到裁剪空间，
     *               再换算到屏幕；并按地平线 dot 阈值判定可见半球
     */
    projectWorld(x: number, y: number, dpr: number): ScreenProjection {
        if (this._projection === 'mercator') {
            if (this._pitch === 0 && this._bearing === 0) {
                // 正交快速路径
                const upp = this.worldUnitsPerPixel();
                const cx = this._viewportW / 2 / dpr;
                const cy = this._viewportH / 2 / dpr;
                return {
                    x: cx + (x - this._center.x) / (upp * dpr),
                    y: cy + (y - this._center.y) / (upp * dpr),
                    visible: true,
                };
            }
            // 倾斜/旋转：用 viewProj 矩阵投影平面点 (x, y, 0)
            const vp = this.getViewProjectionMatrix();
            const clip = vec4.transformMat4(
                vec4.create(), vec4.fromValues(x, y, 0, 1), vp,
            );
            if (clip[3] <= 0) return { x: NaN, y: NaN, visible: false }; // 位于相机后方
            const ndcX = clip[0] / clip[3];
            const ndcY = clip[1] / clip[3];
            return {
                x: (ndcX * 0.5 + 0.5) * (this._viewportW / dpr),
                y: (1 - (ndcY * 0.5 + 0.5)) * (this._viewportH / dpr),
                visible: true,
            };
        }
        // globe
        const p = Camera.worldToSphere(x, y);
        const vp = this.getViewProjectionMatrix();
        const clip = vec4.transformMat4(
            vec4.create(),
            vec4.fromValues(p[0], p[1], p[2], 1),
            vp,
        );
        if (clip[3] === 0) return { x: NaN, y: NaN, visible: false };
        const ndcX = clip[0] / clip[3];
        const ndcY = clip[1] / clip[3];
        const sx = (ndcX * 0.5 + 0.5) * (this._viewportW / dpr);
        const sy = (1 - (ndcY * 0.5 + 0.5)) * (this._viewportH / dpr);
        // 地平线剔除：可见半球阈值 cosθ = 1/d（与着色器 params2.w 一致）
        const center = Camera.worldToSphere(this._center.x, this._center.y);
        const dot = p[0] * center[0] + p[1] * center[1] + p[2] * center[2];
        const visible = dot >= 1 / this.getGlobeDistance();
        return { x: sx, y: sy, visible };
    }

    /**
     * 屏幕 CSS 像素 → 世界坐标（screenToWorld 的精确版本）。
     *   - mercator：直接反算
     *   - globe   ：相机射线与单位球求交，取近交点再反映射回世界坐标；
     *               未命中地球时返回 null
     */
    unprojectToWorld(px: number, py: number, dpr: number): { x: number; y: number } | null {
        if (this._projection === 'mercator') {
            if (this._pitch === 0 && this._bearing === 0) {
                return this.screenToWorld(px, py, dpr);
            }
            // 倾斜/旋转：构造世界射线，与地图平面 z=0 求交
            const vp = this.getViewProjectionMatrix();
            const inv = mat4.invert(mat4.create(), vp);
            if (!inv) return null;
            const ndcX = (px * dpr) / this._viewportW * 2 - 1;
            const ndcY = 1 - (py * dpr) / this._viewportH * 2;
            const near = vec4.transformMat4(vec4.create(), vec4.fromValues(ndcX, ndcY, 0, 1), inv);
            const far = vec4.transformMat4(vec4.create(), vec4.fromValues(ndcX, ndcY, 1, 1), inv);
            const ox = near[0] / near[3], oy = near[1] / near[3], oz = near[2] / near[3];
            const fx = far[0] / far[3], fy = far[1] / far[3], fz = far[2] / far[3];
            const dz = fz - oz;
            if (Math.abs(dz) < 1e-9) return null;       // 射线平行于地面
            const t = -oz / dz;                          // 与 z=0 平面交点参数
            if (t < 0) return null;                      // 交点在相机后方（地平线以上）
            return { x: ox + (fx - ox) * t, y: oy + (fy - oy) * t };
        }
        // globe：构造世界射线，与单位球求交
        const vp = this.getViewProjectionMatrix();
        const inv = mat4.invert(mat4.create(), vp);
        if (!inv) return null;
        const ndcX = (px * dpr) / this._viewportW * 2 - 1;
        const ndcY = 1 - (py * dpr) / this._viewportH * 2;
        // 高缩放时相机几乎贴在球面上（near≈2e-5），用近裁剪面逆投影得到的射线
        // 起点 o 病态：微小误差会把 o 推到球内/对侧，导致求交命中背面、反算出
        // 完全错误的世界坐标（瓦片选错→画面空洞/错铺）。改用「精确相机位置作起点 +
        // 远点仅用于定向」：相机位置由 getGlobeEyeModel 在基础球面空间精确给出，
        // 远裁剪面(≈3)逆投影良态，二者之差即为稳定的射线方向。
        const far = vec4.transformMat4(vec4.create(), vec4.fromValues(ndcX, ndcY, 1, 1), inv);
        const f = vec3.fromValues(far[0] / far[3], far[1] / far[3], far[2] / far[3]);
        const o = this.getGlobeEyeModel(vec3.create());
        const dir = vec3.sub(vec3.create(), f, o);
        vec3.normalize(dir, dir);
        // |o + t·dir|² = 1，用垂距法求判别式：disc = 1 - |o - (o·dir)dir|²，
        // 避免 |o|≈1 时 dot(o,o)-1 的抵消，并稳定取近交点。
        const b = vec3.dot(o, dir);
        const perpx = o[0] - b * dir[0];
        const perpy = o[1] - b * dir[1];
        const perpz = o[2] - b * dir[2];
        const disc = 1 - (perpx * perpx + perpy * perpy + perpz * perpz);
        if (disc < 0) return null;
        const sqrt = Math.sqrt(disc);
        const tNear = -b - sqrt;
        const tHit = tNear >= 0 ? tNear : (-b + sqrt);
        if (tHit < 0) return null;
        const hit = vec3.scaleAndAdd(vec3.create(), o, dir, tHit);
        return Camera.sphereToWorld(hit[0], hit[1], hit[2]);
    }

    /** 世界坐标(归一化 Mercator) → 单位球面点（复刻着色器 mercator_to_sphere） */
    static worldToSphere(x: number, y: number): [number, number, number] {
        const lng = (x - 0.5) * 2 * Math.PI;
        const yn = 1 - 2 * y;
        const s = Math.sinh(Math.PI * yn);
        const lat = Math.atan(s);
        const cl = Math.cos(lat);
        return [cl * Math.sin(lng), Math.sin(lat), cl * Math.cos(lng)];
    }

    /** 单位球面点 → 世界坐标(归一化 Mercator)（worldToSphere 的逆） */
    static sphereToWorld(x: number, y: number, z: number): { x: number; y: number } {
        const lat = Math.asin(Math.max(-1, Math.min(1, y)));
        const lng = Math.atan2(x, z);
        const wx = lng / (2 * Math.PI) + 0.5;
        const yn = Math.asinh(Math.tan(lat)) / Math.PI;
        const wy = (1 - yn) / 2;
        return { x: wx, y: wy };
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

    /**
     * globe 模式下相机在「基础球面空间」（着色器顶点 p 所在空间，即 model 旋转之前）
     * 中的位置。用于片元着色器按真实地平线做解析覆盖抗锯齿。
     * 推导：clip = proj·view·model·p，相机在世界空间(W)的位置即 lookAt 的 eye；
     * 而 p 属于基础球面空间(S)，model 把 S→W，故 eyeS = model⁻¹·eyeW。
     * model 为纯旋转 → model⁻¹ = transpose(model)。
     */
    getGlobeEyeModel(out: vec3): vec3 {
        const d = this.getGlobeDistance();
        const r = d - 1;
        const sp = Math.sin(this._pitch);
        const cp = Math.cos(this._pitch);
        // 相机在世界空间(W)的位置（bearing 仅改朝向不改位置）
        const eyeW = this._pitch === 0
            ? vec3.fromValues(0, 0, d)
            : vec3.fromValues(0, -r * sp, 1 + r * cp);
        // model = rotateX(lat)·rotateY(-lng)；其逆 = rotateY(lng)·rotateX(-lat)
        const ll = this.getCenter();
        const lngRad = (ll.lng * Math.PI) / 180;
        const latRad = (ll.lat * Math.PI) / 180;
        const inv = mat4.create();
        mat4.rotateY(inv, inv, lngRad);
        mat4.rotateX(inv, inv, -latRad);
        vec3.transformMat4(out, eyeW, inv);
        return out;
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

    // ====================== mercator 透视倾斜矩阵 ======================
    /**
     * 构建 mercator 倾斜（pitch>0）时的透视 viewProj 矩阵。
     *
     * 思路（与 mapbox-gl 一致）：地图位于 z=0 平面（世界坐标 [0,1]），
     * 相机置于中心点正上方距离 cameraDist 处，先按 pitch 绕屏幕水平轴后仰、
     * 再按 bearing 绕竖直轴旋转。cameraDist = halfH / tan(fov/2) 保证 pitch=0
     * 时与正交投影在中心处等价（缩放比例一致）。
     *
     * 世界 Y 轴向南增大，这里通过翻转 Y（scaleY(-1)）使屏幕上方对应北方。
     */
    private _buildMercatorPerspective(out: mat4): void {
        const upp = this.worldUnitsPerPixel();
        const halfH = (this._viewportH / 2) * upp;       // 视口半高（世界单位）
        const aspect = this._viewportW / this._viewportH;
        const fovY = Camera.MERCATOR_FOV;
        const cameraDist = halfH / Math.tan(fovY / 2);    // 相机到中心平面距离（世界单位）
        const pitch = this._pitch;

        // 远裁剪面：随俯仰增大而变远，保证倾斜后仍能看到远处地面
        const fovAbove = fovY / 2;
        const groundAngle = Math.PI / 2 + pitch;
        const topHalfSurfaceDist =
            (Math.sin(fovAbove) * cameraDist) /
            Math.sin(Math.max(0.01, Math.PI - groundAngle - fovAbove));
        const farZ = (Math.cos(Math.PI / 2 - pitch) * topHalfSurfaceDist + cameraDist) * 1.2;
        const nearZ = cameraDist * 0.1;

        const proj = mat4.create();
        mat4.perspective(proj, fovY, aspect, nearZ, farZ);

        // view = T(0,0,-d) · Rx(-pitch) · Rz(-bearing) · [翻转Y并平移到中心]
        const view = mat4.create();
        mat4.translate(view, view, [0, 0, -cameraDist]);
        mat4.rotateX(view, view, -pitch);
        mat4.rotateZ(view, view, -this._bearing);
        // 居中 + 翻转 Y：point' = (x-cx, -(y-cy), 0)
        const center = mat4.create();
        mat4.scale(center, center, [1, -1, 1]);
        mat4.translate(center, center, [-this._center.x, -this._center.y, 0]);
        mat4.multiply(view, view, center);

        mat4.multiply(out, proj, view);
    }

    // ====================== 投影矩阵 ======================
    getViewProjectionMatrix(): mat4 {
        if (!this._dirty) return this._viewProj;

        if (this._projection === 'mercator') {
            if (this._pitch === 0) {
                // —— 正交快速路径（无俯仰）——
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
                // —— 透视倾斜路径（俯仰 + 方位）——
                this._buildMercatorPerspective(this._viewProj);
            }
        } else {
            // globe：投影 × 视图 × 模型旋转
            const aspect = this._viewportW / this._viewportH;
            const d = this.getGlobeDistance();
            const fov = this.getGlobeFovY();

            // —— 视图矩阵 —— 
            // 焦点 = 球面正对点 (0,0,1)（模型旋转已把 center 经纬度转到该处）。
            const view = mat4.create();
            const sp = Math.sin(this._pitch);
            const cp = Math.cos(this._pitch);
            const r = d - 1;                       // 相机到焦点的距离
            // pitch=0 时 eye=(0,0,d)；pitch>0 时相机绕焦点 (0,0,1) 轨道旋转，
            // 始终 lookAt 焦点 → 焦点恒居屏幕中心，地球不会偏出画面。
            const eye = this._pitch === 0
                ? vec3.fromValues(0, 0, d)
                : vec3.fromValues(0, -r * sp, 1 + r * cp);
            const up = this._pitch === 0
                ? vec3.fromValues(0, 1, 0)
                : vec3.fromValues(0, cp, sp);
            const target = this._pitch === 0
                ? vec3.fromValues(0, 0, 0)
                : vec3.fromValues(0, 0, 1);
            mat4.lookAt(view, eye, target, up);

            if (this._bearing !== 0) {
                const bear = mat4.create();
                mat4.rotateZ(bear, bear, this._bearing);
                mat4.multiply(view, bear, view);
            }

            // —— 投影矩阵 —— 依据相机到球心的实际距离设置 near/far
            const eyeDist = this._pitch === 0
                ? d
                : Math.sqrt(r * r + 1 + 2 * r * cp);
            const surfaceDist = Math.max(1e-7, eyeDist - 1);
            // near 必须小于相机到最近地表点的距离(surfaceDist)，否则近处地表会被近裁剪面
            // 整体裁掉。高缩放时 surfaceDist 极小（z14≈8.6e-5），固定下限(如 1e-4)会
            // 超过 surfaceDist，导致俯视全黑、倾斜时近地（屏幕下方）被裁出「空洞」。
            // 故 near 取 surfaceDist 的固定比例，仅用极小绝对下限兜底。
            // （栅格瓦片 depthWrite 关闭、depthCompare=always，near 取小不会带来深度精度问题。）
            const near = Math.max(1e-7, surfaceDist * 0.5);
            const far = eyeDist + 2;
            const proj = mat4.create();
            mat4.perspective(proj, fov, aspect, near, far);

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
