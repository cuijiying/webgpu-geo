import { Layer } from '../layers/Layer';
import { Engine } from './Engine';
import { Camera } from './Camera';

/**
 * 图层管理器
 * 负责管理所有地图图层的渲染顺序和生命周期
 */
export class LayerManager {
    private layers: Map<string, Layer> = new Map();
    private layerOrder: string[] = [];
    
    constructor(_engine: Engine, _camera: Camera) {
        // 引擎和相机引用保存在各个图层中
    }
    
    /**
     * 添加图层
     */
    public async addLayer(layer: Layer): Promise<boolean> {
        const id = layer.getId();
        
        if (this.layers.has(id)) {
            console.warn(`图层 ${id} 已存在`);
            return false;
        }
        
        // 初始化图层
        const initialized = await layer.initialize();
        if (!initialized) {
            console.error(`图层 ${id} 初始化失败`);
            return false;
        }
        
        // 添加到管理器
        this.layers.set(id, layer);
        this.layerOrder.push(id);
        
        // 按Z索引排序
        this.sortLayers();
        
        return true;
    }
    
    /**
     * 移除图层
     */
    public removeLayer(id: string): boolean {
        const layer = this.layers.get(id);
        if (!layer) {
            console.warn(`图层 ${id} 不存在`);
            return false;
        }
        
        // 销毁图层资源
        layer.destroy();
        
        // 从管理器中移除
        this.layers.delete(id);
        const index = this.layerOrder.indexOf(id);
        if (index > -1) {
            this.layerOrder.splice(index, 1);
        }
        
        return true;
    }
    
    /**
     * 获取图层
     */
    public getLayer(id: string): Layer | undefined {
        return this.layers.get(id);
    }
    
    /**
     * 获取所有图层
     */
    public getAllLayers(): Layer[] {
        return this.layerOrder.map(id => this.layers.get(id)!);
    }
    
    /**
     * 设置图层可见性
     */
    public setLayerVisible(id: string, visible: boolean): boolean {
        const layer = this.layers.get(id);
        if (layer) {
            layer.setVisible(visible);
            return true;
        }
        return false;
    }
    
    /**
     * 设置图层透明度
     */
    public setLayerOpacity(id: string, opacity: number): boolean {
        const layer = this.layers.get(id);
        if (layer) {
            layer.setOpacity(opacity);
            return true;
        }
        return false;
    }
    
    /**
     * 设置图层Z索引
     */
    public setLayerZIndex(id: string, zIndex: number): boolean {
        const layer = this.layers.get(id);
        if (layer) {
            layer.setZIndex(zIndex);
            this.sortLayers();
            return true;
        }
        return false;
    }
    
    /**
     * 移动图层到顶部
     */
    public moveLayerToTop(id: string): boolean {
        if (!this.layers.has(id)) return false;
        
        const index = this.layerOrder.indexOf(id);
        if (index > -1) {
            this.layerOrder.splice(index, 1);
            this.layerOrder.push(id);
            return true;
        }
        return false;
    }
    
    /**
     * 移动图层到底部
     */
    public moveLayerToBottom(id: string): boolean {
        if (!this.layers.has(id)) return false;
        
        const index = this.layerOrder.indexOf(id);
        if (index > -1) {
            this.layerOrder.splice(index, 1);
            this.layerOrder.unshift(id);
            return true;
        }
        return false;
    }
    
    /**
     * 按Z索引排序图层
     */
    private sortLayers(): void {
        this.layerOrder.sort((a, b) => {
            const layerA = this.layers.get(a)!;
            const layerB = this.layers.get(b)!;
            return layerA.getZIndex() - layerB.getZIndex();
        });
    }
    
    /**
     * 更新所有图层
     */
    public update(deltaTime: number): void {
        for (const id of this.layerOrder) {
            const layer = this.layers.get(id);
            if (layer && layer.isVisible()) {
                layer.update(deltaTime);
            }
        }
    }
    
    /**
     * 渲染所有图层
     */
    public render(renderPass: GPURenderPassEncoder): void {
        // 按顺序渲染所有可见图层
        for (const id of this.layerOrder) {
            const layer = this.layers.get(id);
            if (layer && layer.isVisible()) {
                layer.render(renderPass);
            }
        }
    }
    
    /**
     * 清空所有图层
     */
    public clear(): void {
        // 销毁所有图层
        for (const layer of this.layers.values()) {
            layer.destroy();
        }
        
        this.layers.clear();
        this.layerOrder = [];
    }
    
    /**
     * 获取图层数量
     */
    public getLayerCount(): number {
        return this.layers.size;
    }
    
    /**
     * 检查图层是否存在
     */
    public hasLayer(id: string): boolean {
        return this.layers.has(id);
    }
    
    /**
     * 销毁图层管理器
     */
    public destroy(): void {
        this.clear();
    }
}