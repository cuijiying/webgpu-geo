import type { Engine } from './Engine';
import type { Camera } from '../camera/Camera';
import type { Layer } from '../layers/Layer';

/**
 * 帧上下文：传递给每个 Layer 的渲染数据
 */
export interface FrameContext {
    engine: Engine;
    camera: Camera;
    encoder: GPUCommandEncoder;
    pass: GPURenderPassEncoder;
    /** 帧序号（每帧 +1） */
    frame: number;
    /** 时间戳，单位 ms（performance.now） */
    time: number;
}

/**
 * Renderer —— 帧调度器
 *
 * 职责：
 *   1) 按 requestAnimationFrame 节奏驱动每一帧
 *   2) 处理画布尺寸 / 相机视口同步
 *   3) 创建 RenderPass，按图层顺序调用 Layer.render
 *   4) 提供 requestRender 节流：图层数据变化时仅在下一帧重绘
 *
 * 设计要点：默认按需重绘 (on-demand) —— 仅当 dirty=true 时
 * 才真正执行渲染，避免地图静止时也持续占用 GPU。
 */
export class Renderer {
    private _engine: Engine;
    private _camera: Camera;
    private _layers: Layer[] = [];
    private _raf: number | null = null;
    private _dirty: boolean = true;
    private _frame: number = 0;
    private _running: boolean = false;

    constructor(engine: Engine, camera: Camera) {
        this._engine = engine;
        this._camera = camera;
    }

    addLayer(layer: Layer): void {
        this._layers.push(layer);
        layer.attach(this._engine);
        // Layer 自身变化时通知重绘
        layer.onChange = () => this.requestRender();
        this.requestRender();
    }

    removeLayer(layer: Layer): void {
        const i = this._layers.indexOf(layer);
        if (i < 0) return;
        this._layers.splice(i, 1);
        layer.detach();
        this.requestRender();
    }

    /** 启动渲染循环（按需重绘） */
    start(): void {
        if (this._running) return;
        this._running = true;
        const tick = () => {
            if (!this._running) return;
            if (this._dirty) {
                // 先清 dirty：渲染过程中若有人再次 requestRender（如 resize / 异步 tile 上传），
                // 不会被本帧结束时的赋值覆盖掉，下一帧会继续重绘
                this._dirty = false;
                this._renderFrame();
            }
            this._raf = requestAnimationFrame(tick);
        };
        this._raf = requestAnimationFrame(tick);
    }

    stop(): void {
        this._running = false;
        if (this._raf !== null) cancelAnimationFrame(this._raf);
        this._raf = null;
    }

    /** 请求在下一帧重绘 */
    requestRender(): void {
        this._dirty = true;
    }

    /** 渲染单帧 */
    private _renderFrame(): void {
        // 同步画布尺寸 → 相机视口
        if (this._engine.resize()) {
            this._camera.setViewportSize(this._engine.width, this._engine.height);
        }

        const device = this._engine.device;
        const ctx = this._engine.context;
        const encoder = device.createCommandEncoder({ label: 'frame-encoder' });
        const swapView = ctx.getCurrentTexture().createView();
        const msaaView = this._engine.msaaTexture.createView();
        const pass = encoder.beginRenderPass({
            label: 'main-pass',
            colorAttachments: [{
                view: msaaView,
                resolveTarget: swapView,
                clearValue: this._engine.clearColor,
                loadOp: 'clear',
                storeOp: 'store',
            }],
            depthStencilAttachment: {
                view: this._engine.depthTexture.createView(),
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            },
        });

        const frameCtx: FrameContext = {
            engine: this._engine,
            camera: this._camera,
            encoder,
            pass,
            frame: this._frame++,
            time: performance.now(),
        };

        for (const layer of this._layers) {
            if (layer.visible) layer.render(frameCtx);
        }

        pass.end();
        device.queue.submit([encoder.finish()]);
    }
}
