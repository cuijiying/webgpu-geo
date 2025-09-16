import { Engine } from '../core/Engine';
import { Camera } from '../core/Camera';

/**
 * 图层基类
 * 所有地图图层都应该继承此类
 */
export abstract class Layer {
    protected engine: Engine;
    protected camera: Camera;
    protected visible: boolean = true;
    protected opacity: number = 1.0;
    protected zIndex: number = 0;
    protected id: string;
    protected name: string;
    
    constructor(id: string, name: string, engine: Engine, camera: Camera) {
        this.id = id;
        this.name = name;
        this.engine = engine;
        this.camera = camera;
    }
    
    /**
     * 初始化图层资源
     */
    public abstract initialize(): Promise<boolean>;
    
    /**
     * 渲染图层
     */
    public abstract render(renderPass: GPURenderPassEncoder): void;
    
    /**
     * 更新图层（每帧调用）
     */
    public update(_deltaTime: number): void {
        // 子类可以重写此方法
    }
    
    /**
     * 释放图层资源
     */
    public abstract destroy(): void;
    
    /**
     * 设置图层可见性
     */
    public setVisible(visible: boolean): void {
        this.visible = visible;
    }
    
    /**
     * 获取图层可见性
     */
    public isVisible(): boolean {
        return this.visible;
    }
    
    /**
     * 设置图层透明度
     */
    public setOpacity(opacity: number): void {
        this.opacity = Math.max(0, Math.min(1, opacity));
    }
    
    /**
     * 获取图层透明度
     */
    public getOpacity(): number {
        return this.opacity;
    }
    
    /**
     * 设置图层Z索引
     */
    public setZIndex(zIndex: number): void {
        this.zIndex = zIndex;
    }
    
    /**
     * 获取图层Z索引
     */
    public getZIndex(): number {
        return this.zIndex;
    }
    
    /**
     * 获取图层ID
     */
    public getId(): string {
        return this.id;
    }
    
    /**
     * 获取图层名称
     */
    public getName(): string {
        return this.name;
    }
}