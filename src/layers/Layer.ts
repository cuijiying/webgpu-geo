import type { Engine } from '../core/Engine';
import type { FrameContext } from '../core/Renderer';

/**
 * Layer —— 图层基类
 *
 * 生命周期：
 *   constructor → attach(engine) → render(frame) * N → detach()
 *
 * 子类只需实现 onAttach/onDetach/onRender。
 *
 * `onChange` 由 Renderer 在 addLayer 时注入，子类内部状态变化
 * （例如新瓦片就绪）时调用，即可请求下一帧重绘。
 */
export abstract class Layer {
    visible: boolean = true;
    protected engine!: Engine;
    /** 由 Renderer 注入：调用以请求重绘 */
    onChange: () => void = () => { /* noop until attached */ };

    attach(engine: Engine): void {
        this.engine = engine;
        this.onAttach(engine);
    }

    detach(): void {
        this.onDetach();
    }

    render(ctx: FrameContext): void {
        this.onRender(ctx);
    }

    protected abstract onAttach(engine: Engine): void;
    protected abstract onDetach(): void;
    protected abstract onRender(ctx: FrameContext): void;
}
