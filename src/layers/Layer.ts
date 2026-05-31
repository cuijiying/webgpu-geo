import type { Engine } from '../core/Engine';
import type { FrameContext } from '../core/Renderer';
import type { Camera } from '../camera/Camera';
import type { Feature } from '../geojson/types';
import type { PixelXY } from '../geo/types';
import { Evented } from '../events/Evented';

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
 *
 * Layer 继承 Evented：可直接 `layer.on('click', fn)` 监听图层级事件
 * （由 Map 的事件分发器在命中要素后触发）。
 */
export abstract class Layer extends Evented {
    /** 图层唯一标识，便于 map.on(type, id, fn) / queryRenderedFeatures({layers}) 引用 */
    id: string;
    visible: boolean = true;
    /** 是否参与鼠标拾取（false 时跳过命中测试，提升性能） */
    interactive: boolean = true;
    protected engine!: Engine;
    /** 由 Renderer 注入：调用以请求重绘 */
    onChange: () => void = () => { /* noop until attached */ };

    private static _uid = 0;

    constructor(id?: string) {
        super();
        this.id = id ?? `layer-${++Layer._uid}`;
    }

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

    /**
     * 命中测试：返回指定屏幕坐标（CSS 像素）下命中的要素列表（从上到下）。
     * 基类默认返回空数组；矢量类图层应重写。
     *
     * @param point      canvas 内 CSS 像素坐标
     * @param camera     当前相机（用于世界↔屏幕投影）
     * @param dpr        设备像素比
     * @param tolerance  命中容差（CSS 像素，用于线/点）
     */
    hitTest(_point: PixelXY, _camera: Camera, _dpr: number, _tolerance: number): Feature[] {
        return [];
    }

    protected abstract onAttach(engine: Engine): void;
    protected abstract onDetach(): void;
    protected abstract onRender(ctx: FrameContext): void;
}

