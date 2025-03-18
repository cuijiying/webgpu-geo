import { Engine } from './core/Engine';
import { Camera } from './core/Camera';
import { GlobeRenderer } from './renderers/GlobeRenderer';
import { mat4, vec3 } from 'gl-matrix';

/**
 * AIMap选项接口
 */
export interface AIMapOptions {
    /**
     * 相机缩放级别
     */
    zoom?: number;
    
    /**
     * 地图中心位置，格式为[经度, 纬度]
     */
    center?: [number, number];
    
    /**
     * 初始旋转角度（以弧度为单位）
     */
    rotation?: number;
    
    /**
     * 是否启用控制
     */
    enableControl?: boolean;
    
    /**
     * Canvas的背景颜色
     */
    backgroundColor?: [number, number, number, number];
}

/**
 * AIMap默认选项
 */
const DEFAULT_OPTIONS: AIMapOptions = {
    zoom: 1,
    center: [0, 0],
    rotation: 0,
    enableControl: true,
    backgroundColor: [0, 0, 0, 1]
};

/**
 * AIMap类 - WebGPU地理引擎的主要入口
 */
export class AIMap {
    private engine: Engine;
    private camera: Camera;
    private renderer: GlobeRenderer;
    private canvas: HTMLCanvasElement;
    private options: AIMapOptions;
    private animationFrameId: number | null = null;
    
    // 鼠标控制相关属性
    private isDragging: boolean = false;
    private lastMouseX: number = 0;
    private lastMouseY: number = 0;
    private rotationSpeed: number = 0.01;
    private autoRotate: boolean = false;
    private autoRotateSpeed: number = 0.005;
    
    /**
     * 创建AIMap实例
     * @param canvasId Canvas元素的ID或HTMLCanvasElement实例
     * @param options AIMap选项
     */
    constructor(canvasId: string | HTMLCanvasElement, options: AIMapOptions = {}) {
        // 合并选项
        this.options = { ...DEFAULT_OPTIONS, ...options };
        
        // 获取Canvas元素
        if (typeof canvasId === 'string') {
            const element = document.getElementById(canvasId);
            if (!element || !(element instanceof HTMLCanvasElement)) {
                throw new Error(`找不到ID为${canvasId}的Canvas元素`);
            }
            this.canvas = element;
        } else if (canvasId instanceof HTMLCanvasElement) {
            this.canvas = canvasId;
        } else {
            throw new Error('canvasId必须是Canvas元素ID或HTMLCanvasElement实例');
        }
        
        // 初始化引擎组件
        this.engine = new Engine();
        this.camera = new Camera();
        this.renderer = new GlobeRenderer(this.engine, this.camera);
        
        // 设置事件监听器
        this.setupEventListeners();
        
        // 初始化并开始渲染
        this.initialize();
    }
    
    /**
     * 初始化AIMap
     */
    private async initialize(): Promise<void> {
        // 设置Canvas尺寸
        this.resizeCanvas();
        
        // 初始化WebGPU引擎
        const initialized = await this.engine.initialize(this.canvas);
        if (!initialized) {
            throw new Error('WebGPU引擎初始化失败');
        }
        
        // 设置相机
        this.updateCameraFromOptions();
        
        // 初始化渲染器
        await this.renderer.initialize();
        
        // 开始渲染循环
        this.startRenderLoop();
    }
    
    /**
     * 设置事件监听器
     */
    private setupEventListeners(): void {
        // 窗口大小变化事件
        window.addEventListener('resize', this.handleResize.bind(this));
        
        // 如果启用控制，设置鼠标和触摸事件
        if (this.options.enableControl) {
            // 鼠标事件
            this.canvas.addEventListener('mousedown', this.handleMouseDown.bind(this));
            this.canvas.addEventListener('mousemove', this.handleMouseMove.bind(this));
            this.canvas.addEventListener('mouseup', this.handleMouseUp.bind(this));
            this.canvas.addEventListener('mouseleave', this.handleMouseUp.bind(this));
            
            // 鼠标滚轮事件
            this.canvas.addEventListener('wheel', this.handleWheel.bind(this), { passive: false });
            
            // 触摸事件
            this.canvas.addEventListener('touchstart', this.handleTouchStart.bind(this), { passive: false });
            this.canvas.addEventListener('touchmove', this.handleTouchMove.bind(this), { passive: false });
            this.canvas.addEventListener('touchend', this.handleTouchEnd.bind(this));
        }
    }
    
    /**
     * 处理窗口大小变化
     */
    private handleResize(): void {
        this.resizeCanvas();
        this.camera.setAspectRatio(this.canvas.width / this.canvas.height);
    }
    
    /**
     * 调整Canvas大小
     */
    private resizeCanvas(): void {
        const dpr = window.devicePixelRatio || 1;
        const displayWidth = Math.floor(this.canvas.clientWidth * dpr);
        const displayHeight = Math.floor(this.canvas.clientHeight * dpr);
        
        // 如果画布大小已经正确，则不做任何更改
        if (this.canvas.width !== displayWidth || this.canvas.height !== displayHeight) {
            this.canvas.width = displayWidth;
            this.canvas.height = displayHeight;
        }
    }
    
    /**
     * 从选项更新相机参数
     */
    private updateCameraFromOptions(): void {
        // 设置相机位置，基于缩放级别
        const cameraDistance = 3 / this.options.zoom!;
        
        // 将中心点(经纬度)转换为3D位置
        if (this.options.center) {
            const [longitude, latitude] = this.options.center;
            
            // 计算相机位置
            const phi = (90 - latitude) * (Math.PI / 180);
            const theta = (longitude + 180) * (Math.PI / 180);
            
            const x = -cameraDistance * Math.sin(phi) * Math.cos(theta);
            const y = cameraDistance * Math.cos(phi);
            const z = cameraDistance * Math.sin(phi) * Math.sin(theta);
            
            this.camera.setPosition(x, y, z);
        } else {
            // 默认相机位置
            this.camera.setPosition(0, 0, cameraDistance);
        }
        
        // 设置观察目标
        this.camera.setTarget(0, 0, 0);
        
        // 设置宽高比
        this.camera.setAspectRatio(this.canvas.width / this.canvas.height);
    }
    
    /**
     * 开始渲染循环
     */
    private startRenderLoop(): void {
        const renderFrame = () => {
            // 如果启用自动旋转
            if (this.autoRotate) {
                this.rotateGlobeY(this.autoRotateSpeed);
            }
            
            // 渲染地球
            this.renderer.render();
            
            // 继续渲染循环
            this.animationFrameId = requestAnimationFrame(renderFrame);
        };
        
        // 启动渲染循环
        this.animationFrameId = requestAnimationFrame(renderFrame);
    }
    
    /**
     * 停止渲染循环
     */
    public stop(): void {
        if (this.animationFrameId !== null) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
    }
    
    /**
     * 处理鼠标按下事件
     */
    private handleMouseDown(event: MouseEvent): void {
        this.isDragging = true;
        this.lastMouseX = event.clientX;
        this.lastMouseY = event.clientY;
        
        // 停止自动旋转
        this.autoRotate = false;
        
        // 防止默认行为
        event.preventDefault();
    }
    
    /**
     * 处理鼠标移动事件
     */
    private handleMouseMove(event: MouseEvent): void {
        if (!this.isDragging) return;
        
        const deltaX = event.clientX - this.lastMouseX;
        const deltaY = event.clientY - this.lastMouseY;
        
        // 旋转地球
        this.rotateGlobeY(-deltaX * this.rotationSpeed);
        this.rotateGlobeX(-deltaY * this.rotationSpeed);
        
        this.lastMouseX = event.clientX;
        this.lastMouseY = event.clientY;
        
        // 防止默认行为
        event.preventDefault();
    }
    
    /**
     * 处理鼠标释放事件
     */
    private handleMouseUp(event: MouseEvent): void {
        this.isDragging = false;
        event.preventDefault();
    }
    
    /**
     * 处理鼠标滚轮事件
     */
    private handleWheel(event: WheelEvent): void {
        // 确定缩放方向
        const zoomDelta = event.deltaY > 0 ? 0.9 : 1.1;
        
        // 更新缩放级别
        this.setZoom(this.options.zoom! * zoomDelta);
        
        // 防止默认滚动行为
        event.preventDefault();
    }
    
    /**
     * 处理触摸开始事件
     */
    private handleTouchStart(event: TouchEvent): void {
        if (event.touches.length === 1) {
            this.isDragging = true;
            this.lastMouseX = event.touches[0].clientX;
            this.lastMouseY = event.touches[0].clientY;
            
            // 停止自动旋转
            this.autoRotate = false;
        }
        
        // 防止默认行为
        event.preventDefault();
    }
    
    /**
     * 处理触摸移动事件
     */
    private handleTouchMove(event: TouchEvent): void {
        if (!this.isDragging || event.touches.length !== 1) return;
        
        const deltaX = event.touches[0].clientX - this.lastMouseX;
        const deltaY = event.touches[0].clientY - this.lastMouseY;
        
        // 旋转地球
        this.rotateGlobeY(-deltaX * this.rotationSpeed);
        this.rotateGlobeX(-deltaY * this.rotationSpeed);
        
        this.lastMouseX = event.touches[0].clientX;
        this.lastMouseY = event.touches[0].clientY;
        
        // 防止默认行为
        event.preventDefault();
    }
    
    /**
     * 处理触摸结束事件
     */
    private handleTouchEnd(event: TouchEvent): void {
        console.log('TouchEvent', event);
        this.isDragging = false;
    }
    
    /**
     * 绕Y轴旋转地球
     */
    private rotateGlobeY(angle: number): void {
        // 获取当前相机位置
        const position = vec3.clone(this.camera.getPosition());
        
        // 使用rotateY方法
        const rotationMatrix = vec3.create();
        vec3.rotateY(rotationMatrix, position, [0, 0, 0], angle);
        
        // 更新相机位置
        this.camera.setPosition(
            rotationMatrix[0],
            rotationMatrix[1],
            rotationMatrix[2]
        );
    }
    
    /**
     * 绕X轴旋转地球
     */
    private rotateGlobeX(angle: number): void {
        // 获取当前相机位置
        const position = vec3.clone(this.camera.getPosition());
        
        // 计算旋转轴（垂直于相机位置和Y轴的向量）
        const rotationAxis = vec3.create();
        vec3.cross(rotationAxis, position, [0, 1, 0]);
        vec3.normalize(rotationAxis, rotationAxis);
        
        // 创建临时结果向量
        const rotationMatrix = vec3.create();
        
        // 应用旋转 - 使用自定义旋转实现，因为vec3没有通用的rotate方法
        // 创建旋转矩阵
        const rotMat = mat4.create();
        mat4.fromRotation(rotMat, angle, rotationAxis);
        
        // 应用旋转
        vec3.transformMat4(rotationMatrix, position, rotMat);
        
        // 限制垂直旋转角度，避免翻转
        const verticalAngle = Math.acos(rotationMatrix[1] / vec3.length(rotationMatrix));
        if (verticalAngle > 0.1 && verticalAngle < Math.PI - 0.1) {
            // 更新相机位置
            this.camera.setPosition(
                rotationMatrix[0],
                rotationMatrix[1],
                rotationMatrix[2]
            );
        }
    }
    
    /**
     * 设置缩放级别
     */
    public setZoom(zoom: number): void {
        // 限制缩放级别在合理范围内
        zoom = Math.max(0.5, Math.min(10, zoom));
        
        // 更新选项
        this.options.zoom = zoom;
        
        // 计算新的相机距离
        const cameraDistance = 3 / zoom;
        
        // 获取当前相机位置的方向向量
        const position = vec3.clone(this.camera.getPosition());
        
        // 归一化
        vec3.normalize(position, position);
        
        // 应用新距离
        vec3.scale(position, position, cameraDistance);
        
        // 更新相机位置
        this.camera.setPosition(
            position[0],
            position[1],
            position[2]
        );
    }
    
    /**
     * 设置地图中心
     */
    public setCenter(longitude: number, latitude: number): void {
        this.options.center = [longitude, latitude];
        this.updateCameraFromOptions();
    }
    
    /**
     * 启用/禁用自动旋转
     */
    public setAutoRotate(enable: boolean): void {
        this.autoRotate = enable;
    }
    
    /**
     * 获取当前缩放级别
     */
    public getZoom(): number {
        return this.options.zoom!;
    }
    
    /**
     * 获取当前中心点
     */
    public getCenter(): [number, number] {
        return this.options.center!;
    }
    
    /**
     * 销毁AIMap实例
     */
    public destroy(): void {
        // 停止渲染循环
        this.stop();
        
        // 移除事件监听器
        window.removeEventListener('resize', this.handleResize.bind(this));
        
        if (this.options.enableControl) {
            this.canvas.removeEventListener('mousedown', this.handleMouseDown.bind(this));
            this.canvas.removeEventListener('mousemove', this.handleMouseMove.bind(this));
            this.canvas.removeEventListener('mouseup', this.handleMouseUp.bind(this));
            this.canvas.removeEventListener('mouseleave', this.handleMouseUp.bind(this));
            this.canvas.removeEventListener('wheel', this.handleWheel.bind(this));
            this.canvas.removeEventListener('touchstart', this.handleTouchStart.bind(this));
            this.canvas.removeEventListener('touchmove', this.handleTouchMove.bind(this));
            this.canvas.removeEventListener('touchend', this.handleTouchEnd.bind(this));
        }
    }
} 