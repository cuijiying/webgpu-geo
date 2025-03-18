/// <reference types="@webgpu/types" />

/**
 * WebGPU 地理引擎核心类
 */
export class Engine {
    private device: GPUDevice | null = null;
    private context: GPUCanvasContext | null = null;
    private canvas: HTMLCanvasElement | null = null;
    
    constructor() {
        
    }
    
    /**
     * 初始化WebGPU
     */
    public async initialize(canvas: HTMLCanvasElement): Promise<boolean> {
        this.canvas = canvas;
        
        // 检查WebGPU支持
        if (!navigator.gpu) {
            console.error("WebGPU不受支持");
            return false;
        }
        
        // 获取GPU适配器
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            console.error("无法获取GPU适配器");
            return false;
        }
        
        // 获取GPU设备
        this.device = await adapter.requestDevice();
        
        // 配置Canvas上下文
        this.context = this.canvas.getContext('webgpu') as GPUCanvasContext;
        if (!this.context) {
            console.error("无法创建WebGPU上下文");
            return false;
        }
        
        // 配置上下文格式
        const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
        this.context.configure({
            device: this.device,
            format: presentationFormat,
            alphaMode: 'premultiplied'
        });
        
        return true;
    }
    
    /**
     * 获取GPU设备
     */
    public getDevice(): GPUDevice | null {
        return this.device;
    }
    
    /**
     * 获取Canvas上下文
     */
    public getContext(): GPUCanvasContext | null {
        return this.context;
    }
    
    /**
     * 获取Canvas元素
     */
    public getCanvas(): HTMLCanvasElement | null {
        return this.canvas;
    }
} 