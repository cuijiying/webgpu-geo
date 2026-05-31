import type { Camera } from '../camera/Camera';

/**
 * MapInteraction —— 鼠标 + 触摸交互
 *
 * 支持：
 *   - 左键拖拽平移
 *   - 右键拖拽（或 Ctrl + 左键拖拽）旋转方位角(bearing) + 改变俯仰角(pitch)，2D/3D 通用
 *   - 滚轮缩放（以光标处为锚点）
 *   - 单指拖拽平移 / 双指捏合缩放 / 双指扭转旋转 / 双指上下拖拽改变俯仰角
 *
 * 通过 attach/detach 管理事件，避免内存泄漏。
 */
export class MapInteraction {
    /** 水平拖拽 1 像素对应的方位角增量（弧度） */
    static readonly ROTATE_SPEED = 0.005;
    /** 垂直拖拽 1 像素对应的俯仰角增量（弧度） */
    static readonly PITCH_SPEED = 0.005;

    private _canvas: HTMLCanvasElement;
    private _camera: Camera;
    private _dragging = false;
    private _rotating = false;
    private _lastX = 0;
    private _lastY = 0;
    private _dpr: number;

    // 触摸状态
    private _touchMode: 'none' | 'pan' | 'gesture' = 'none';
    private _pinchDist = 0;
    private _pinchAngle = 0;
    private _pinchCenterY = 0;

    // 绑定后的方法引用，便于 removeEventListener
    private readonly _onMouseDown = (e: MouseEvent) => this._handleDown(e);
    private readonly _onMouseMove = (e: MouseEvent) => this._handleMove(e.clientX, e.clientY);
    private readonly _onMouseUp = () => this._handleUp();
    private readonly _onContextMenu = (e: MouseEvent) => e.preventDefault();
    private readonly _onWheel = (e: WheelEvent) => this._handleWheel(e);
    private readonly _onTouchStart = (e: TouchEvent) => this._handleTouchStart(e);
    private readonly _onTouchMove = (e: TouchEvent) => this._handleTouchMove(e);
    private readonly _onTouchEnd = (e: TouchEvent) => this._handleTouchEnd(e);

    constructor(canvas: HTMLCanvasElement, camera: Camera) {
        this._canvas = canvas;
        this._camera = camera;
        this._dpr = window.devicePixelRatio || 1;
    }

    attach(): void {
        this._canvas.addEventListener('mousedown', this._onMouseDown);
        window.addEventListener('mousemove', this._onMouseMove);
        window.addEventListener('mouseup', this._onMouseUp);
        // 右键拖拽旋转时屏蔽浏览器右键菜单
        this._canvas.addEventListener('contextmenu', this._onContextMenu);
        this._canvas.addEventListener('wheel', this._onWheel, { passive: false });
        this._canvas.addEventListener('touchstart', this._onTouchStart, { passive: false });
        this._canvas.addEventListener('touchmove', this._onTouchMove, { passive: false });
        this._canvas.addEventListener('touchend', this._onTouchEnd);
    }

    detach(): void {
        this._canvas.removeEventListener('mousedown', this._onMouseDown);
        window.removeEventListener('mousemove', this._onMouseMove);
        window.removeEventListener('mouseup', this._onMouseUp);
        this._canvas.removeEventListener('contextmenu', this._onContextMenu);
        this._canvas.removeEventListener('wheel', this._onWheel);
        this._canvas.removeEventListener('touchstart', this._onTouchStart);
        this._canvas.removeEventListener('touchmove', this._onTouchMove);
        this._canvas.removeEventListener('touchend', this._onTouchEnd);
    }

    // ---- 鼠标 ----
    private _handleDown(e: MouseEvent): void {
        // 右键，或 Ctrl/Cmd + 左键 → 旋转 / 俯仰；左键 → 平移
        const rotate = e.button === 2 || (e.button === 0 && (e.ctrlKey || e.metaKey));
        if (rotate) {
            this._rotating = true;
            this._lastX = e.clientX;
            this._lastY = e.clientY;
            this._canvas.style.cursor = 'move';
            e.preventDefault();
            return;
        }
        if (e.button !== 0) return;
        this._dragging = true;
        this._lastX = e.clientX;
        this._lastY = e.clientY;
        this._canvas.style.cursor = 'grabbing';
        e.preventDefault();
    }
    private _handleMove(x: number, y: number): void {
        const dx = x - this._lastX;
        const dy = y - this._lastY;
        if (this._rotating) {
            this._lastX = x;
            this._lastY = y;
            // 水平拖拽改变方位角；向右拖 → 顺时针旋转
            this._camera.setBearing(this._camera.getBearing() - dx * MapInteraction.ROTATE_SPEED);
            // 垂直拖拽改变俯仰角；向上拖 → 增大俯仰（更倾斜）
            this._camera.setPitch(this._camera.getPitch() - dy * MapInteraction.PITCH_SPEED);
            return;
        }
        if (!this._dragging) return;
        this._lastX = x;
        this._lastY = y;
        this._camera.panByPixels(dx, dy, this._dpr);
    }
    private _handleUp(): void {
        if (!this._dragging && !this._rotating) return;
        this._dragging = false;
        this._rotating = false;
        this._canvas.style.cursor = '';
    }
    private _handleWheel(e: WheelEvent): void {
        e.preventDefault();
        // 将 deltaY 按 deltaMode 归一化为“行”，再转为 zoom 增量
        // 鼠标滚轮一格 ≈ 100px；trackpad 连续很小
        let lines = e.deltaY;
        if (e.deltaMode === 1) lines *= 16;          // LINE
        else if (e.deltaMode === 2) lines *= 400;    // PAGE
        // 限制单次跨度，避免某些 trackpad 一次上报几百像素导致狂变
        const clamped = Math.max(-200, Math.min(200, lines));
        const delta = -clamped / 200; // 200px ≈ 1 zoom 级
        const rect = this._canvas.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        this._camera.zoomAround(delta, px, py, this._dpr);
    }

    // ---- 触摸 ----
    private _handleTouchStart(e: TouchEvent): void {
        if (e.touches.length === 1) {
            this._touchMode = 'pan';
            this._lastX = e.touches[0].clientX;
            this._lastY = e.touches[0].clientY;
        } else if (e.touches.length === 2) {
            this._touchMode = 'gesture';
            this._pinchDist = this._touchDistance(e);
            this._pinchAngle = this._touchAngle(e);
            this._pinchCenterY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        }
        e.preventDefault();
    }
    private _handleTouchMove(e: TouchEvent): void {
        if (this._touchMode === 'pan' && e.touches.length === 1) {
            this._handleMove(e.touches[0].clientX, e.touches[0].clientY);
        } else if (this._touchMode === 'gesture' && e.touches.length === 2) {
            const rect = this._canvas.getBoundingClientRect();
            // 1) 捏合缩放（以双指中心为锚点）
            const d = this._touchDistance(e);
            const ratio = d / (this._pinchDist || d);
            this._pinchDist = d;
            const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
            const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
            const dz = Math.log2(ratio);
            if (Number.isFinite(dz) && dz !== 0) this._camera.zoomAround(dz, cx, cy, this._dpr);
            // 2) 扭转旋转 → 方位角
            const angle = this._touchAngle(e);
            let dAngle = angle - this._pinchAngle;
            if (dAngle > Math.PI) dAngle -= 2 * Math.PI;
            else if (dAngle < -Math.PI) dAngle += 2 * Math.PI;
            this._pinchAngle = angle;
            this._camera.setBearing(this._camera.getBearing() + dAngle);
            // 3) 双指整体上下平移 → 俯仰角
            const centerY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
            const dPitch = centerY - this._pinchCenterY;
            this._pinchCenterY = centerY;
            this._camera.setPitch(this._camera.getPitch() - dPitch * MapInteraction.PITCH_SPEED);
        }
        e.preventDefault();
    }
    private _handleTouchEnd(e: TouchEvent): void {
        if (e.touches.length === 0) {
            this._touchMode = 'none';
        } else if (e.touches.length === 1) {
            this._touchMode = 'pan';
            this._lastX = e.touches[0].clientX;
            this._lastY = e.touches[0].clientY;
        }
    }
    private _touchDistance(e: TouchEvent): number {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        return Math.hypot(dx, dy);
    }
    private _touchAngle(e: TouchEvent): number {
        const dx = e.touches[1].clientX - e.touches[0].clientX;
        const dy = e.touches[1].clientY - e.touches[0].clientY;
        return Math.atan2(dy, dx);
    }
}
