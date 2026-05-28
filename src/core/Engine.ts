/// <reference types="@webgpu/types" />

/**
 * 引擎初始化选项
 */
export interface EngineOptions {
    /** 设备像素比，默认取 window.devicePixelRatio */
    devicePixelRatio?: number;
    /** 画布清屏颜色，默认深灰 */
    clearColor?: GPUColor;
    /** 期望的 powerPreference */
    powerPreference?: GPUPowerPreference;
}

/**
 * Engine —— WebGPU 设备 / 上下文 / 表面 管理者
 *
 * 职责：
 *   1) 探测并请求 WebGPU 适配器与设备
 *   2) 为画布创建并配置 GPUCanvasContext
 *   3) 维护画布尺寸（处理 DPR 与窗口缩放）
 *   4) 提供共享的 depth texture（按需重建）
 *
 * 其它子系统（Renderer / Layer）都依赖 Engine 暴露的资源。
 */
export class Engine {
    /** 抗锯齿采样数（固定 4× MSAA） */
    static readonly SAMPLE_COUNT = 4;

    private _canvas!: HTMLCanvasElement;
    private _device!: GPUDevice;
    private _context!: GPUCanvasContext;
    private _format!: GPUTextureFormat;
    private _dpr: number;
    private _clearColor: GPUColor;
    private _powerPreference: GPUPowerPreference;
    private _depthTexture: GPUTexture | null = null;
    private _msaaTexture: GPUTexture | null = null;

    constructor(opts: EngineOptions = {}) {
        this._dpr = opts.devicePixelRatio ?? (window.devicePixelRatio || 1);
        this._clearColor = opts.clearColor ?? { r: 0.05, g: 0.07, b: 0.1, a: 1 };
        this._powerPreference = opts.powerPreference ?? 'high-performance';
    }

    /** 异步初始化 WebGPU，必须在使用前 await */
    async initialize(canvas: HTMLCanvasElement): Promise<void> {
        if (!('gpu' in navigator)) {
            throw new Error('当前浏览器不支持 WebGPU，请使用 Chrome 113+/Edge 113+');
        }
        const adapter = await navigator.gpu.requestAdapter({
            powerPreference: this._powerPreference,
        });
        if (!adapter) throw new Error('未能获取 GPUAdapter');

        const device = await adapter.requestDevice();
        const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
        if (!context) throw new Error('无法获取 webgpu 画布上下文');

        const format = navigator.gpu.getPreferredCanvasFormat();
        context.configure({
            device,
            format,
            alphaMode: 'premultiplied',
        });

        this._canvas = canvas;
        this._device = device;
        this._context = context;
        this._format = format;

        // 监听设备丢失，方便上层重建
        device.lost.then((info) => {
            console.warn('[webgpu-geo] GPU device lost:', info.message, info.reason);
        });

        this.resize();
    }

    /**
     * 同步画布的物理像素尺寸（按 DPR）。
     * 调用方应在窗口尺寸变化时调用本方法。
     * @returns 是否实际发生了尺寸变更
     */
    resize(): boolean {
        const cssW = this._canvas.clientWidth || this._canvas.width;
        const cssH = this._canvas.clientHeight || this._canvas.height;
        const w = Math.max(1, Math.floor(cssW * this._dpr));
        const h = Math.max(1, Math.floor(cssH * this._dpr));
        if (this._canvas.width === w && this._canvas.height === h) return false;
        this._canvas.width = w;
        this._canvas.height = h;
        // 重建多采样颜色纹理（用于 MSAA，最终 resolve 到 swapchain）
        this._msaaTexture?.destroy();
        this._msaaTexture = this._device.createTexture({
            size: { width: w, height: h },
            sampleCount: Engine.SAMPLE_COUNT,
            format: this._format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
            label: 'engine-msaa-texture',
        });
        // 重建 depth texture（必须与颜色采样数一致）
        this._depthTexture?.destroy();
        this._depthTexture = this._device.createTexture({
            size: { width: w, height: h },
            sampleCount: Engine.SAMPLE_COUNT,
            format: 'depth24plus',
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
            label: 'engine-depth-texture',
        });
        return true;
    }

    /** 销毁引擎与所有 GPU 资源 */
    destroy(): void {
        this._depthTexture?.destroy();
        this._depthTexture = null;
        this._msaaTexture?.destroy();
        this._msaaTexture = null;
        // GPUDevice 没有公开 destroy，丢弃引用即可（未来 API 会提供 device.destroy()）
        (this._device as unknown as { destroy?: () => void }).destroy?.();
    }

    // ---- 访问器 ----
    get canvas(): HTMLCanvasElement { return this._canvas; }
    get device(): GPUDevice { return this._device; }
    get context(): GPUCanvasContext { return this._context; }
    get format(): GPUTextureFormat { return this._format; }
    get devicePixelRatio(): number { return this._dpr; }
    get clearColor(): GPUColor { return this._clearColor; }
    get depthTexture(): GPUTexture {
        if (!this._depthTexture) throw new Error('Engine 未初始化');
        return this._depthTexture;
    }
    get msaaTexture(): GPUTexture {
        if (!this._msaaTexture) throw new Error('Engine 未初始化');
        return this._msaaTexture;
    }
    get sampleCount(): number { return Engine.SAMPLE_COUNT; }
    get width(): number { return this._canvas.width; }
    get height(): number { return this._canvas.height; }
}
