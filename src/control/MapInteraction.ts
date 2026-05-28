import type { Camera } from '../camera/Camera';

/**
 * MapInteraction —— 鼠标 + 触摸交互
 *
 * 支持：
 *   - 左键拖拽平移
 *   - 滚轮缩放（以光标处为锚点）
 *   - 单指拖拽平移 / 双指捏合缩放（简化版）
 *
 * 通过 attach/detach 管理事件，避免内存泄漏。
 */
export class MapInteraction {
    private _canvas: HTMLCanvasElement;
    private _camera: Camera;
    private _dragging = false;
    private _lastX = 0;
    private _lastY = 0;
    private _dpr: number;

    // 触摸状态
    private _touchMode: 'none' | 'pan' | 'pinch' = 'none';
    private _pinchDist = 0;

    // 绑定后的方法引用，便于 removeEventListener
    private readonly _onMouseDown = (e: MouseEvent) => this._handleDown(e.clientX, e.clientY, e);
    private readonly _onMouseMove = (e: MouseEvent) => this._handleMove(e.clientX, e.clientY);
    private readonly _onMouseUp = () => this._handleUp();
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
        this._canvas.addEventListener('wheel', this._onWheel, { passive: false });
        this._canvas.addEventListener('touchstart', this._onTouchStart, { passive: false });
        this._canvas.addEventListener('touchmove', this._onTouchMove, { passive: false });
        this._canvas.addEventListener('touchend', this._onTouchEnd);
    }

    detach(): void {
        this._canvas.removeEventListener('mousedown', this._onMouseDown);
        window.removeEventListener('mousemove', this._onMouseMove);
        window.removeEventListener('mouseup', this._onMouseUp);
        this._canvas.removeEventListener('wheel', this._onWheel);
        this._canvas.removeEventListener('touchstart', this._onTouchStart);
        this._canvas.removeEventListener('touchmove', this._onTouchMove);
        this._canvas.removeEventListener('touchend', this._onTouchEnd);
    }

    // ---- 鼠标 ----
    private _handleDown(x: number, y: number, e: MouseEvent): void {
        if (e.button !== 0) return;
        this._dragging = true;
        this._lastX = x;
        this._lastY = y;
        this._canvas.style.cursor = 'grabbing';
        e.preventDefault();
    }
    private _handleMove(x: number, y: number): void {
        if (!this._dragging) return;
        const dx = x - this._lastX;
        const dy = y - this._lastY;
        this._lastX = x;
        this._lastY = y;
        const upp = this._camera.worldUnitsPerPixel() * this._dpr;
        const c = this._camera.getCenterWorld();
        this._camera.setCenterWorld(c.x - dx * upp, c.y - dy * upp);
    }
    private _handleUp(): void {
        if (!this._dragging) return;
        this._dragging = false;
        this._canvas.style.cursor = '';
    }
    private _handleWheel(e: WheelEvent): void {
        e.preventDefault();
        // 标准化滚轮强度（不同设备/系统差异较大）
        const delta = -Math.sign(e.deltaY) * 0.4;
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
            this._touchMode = 'pinch';
            this._pinchDist = this._touchDistance(e);
        }
        e.preventDefault();
    }
    private _handleTouchMove(e: TouchEvent): void {
        if (this._touchMode === 'pan' && e.touches.length === 1) {
            this._handleMove(e.touches[0].clientX, e.touches[0].clientY);
        } else if (this._touchMode === 'pinch' && e.touches.length === 2) {
            const d = this._touchDistance(e);
            const ratio = d / this._pinchDist;
            this._pinchDist = d;
            const dz = Math.log2(ratio);
            const rect = this._canvas.getBoundingClientRect();
            const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
            const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
            this._camera.zoomAround(dz, cx, cy, this._dpr);
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
}
