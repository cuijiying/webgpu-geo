import { Engine } from './core/Engine';
import { Camera } from './core/Camera';
import { LayerManager } from './core/LayerManager';
import { GlobeRenderer } from './renderers/GlobeRenderer';
import { PointLayer, PointData } from './layers/PointLayer';
import { GeoDataLoader } from './data/GeoDataLoader';
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

    /**
     * 是否显示经纬网格线
     */
    showGridLines?: boolean;
}

/**
 * AIMap默认选项
 */
const DEFAULT_OPTIONS: AIMapOptions = {
    zoom: 1,
    center: [0, 0],
    rotation: 0,
    enableControl: true,
    backgroundColor: [0, 0, 0, 1],
    showGridLines: false
};

/**
 * AIMap类 - WebGPU地理引擎的主要入口
 */
export default class AIMap {
    private engine: Engine;
    private camera: Camera;
    private renderer: GlobeRenderer;
    private layerManager: LayerManager;
    private canvas: HTMLCanvasElement;
    private options: AIMapOptions;
    private animationFrameId: number | null = null;
    private lastFrameTime: number = 0;
    
    // 鼠标控制相关属性
    private isDragging: boolean = false;
    private lastMouseX: number = 0;
    private lastMouseY: number = 0;
    private rotationSpeed: number = 0.01;
    private autoRotate: boolean = false;
    private autoRotateSpeed: number = 0.005;
    
    // 存储绑定后的事件处理函数引用
    private boundHandleResize: (event: UIEvent) => void;
    private boundHandleMouseDown: (event: MouseEvent) => void;
    private boundHandleMouseMove: (event: MouseEvent) => void;
    private boundHandleMouseUp: (event: MouseEvent) => void;
    private boundHandleWheel: (event: WheelEvent) => void;
    private boundHandleTouchStart: (event: TouchEvent) => void;
    private boundHandleTouchMove: (event: TouchEvent) => void;
    private boundHandleTouchEnd: (event: TouchEvent) => void;
    private boundHandleKeyDown: (event: KeyboardEvent) => void;
    
    /**
     * 创建AIMap实例
     * @param canvasId Canvas元素的ID或HTMLCanvasElement实例
     * @param options AIMap选项
     */
    constructor(canvasId: string | HTMLCanvasElement, options: AIMapOptions = {}) {
        // 合并选项
        this.options = { ...DEFAULT_OPTIONS, ...options };
        if (!canvasId) {
            throw new Error('canvasId不能为空');
        }
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
        this.renderer = new GlobeRenderer(this.engine, this.camera, this.options.showGridLines);
        this.layerManager = new LayerManager(this.engine, this.camera);
        
        // 绑定事件处理函数
        this.boundHandleResize = this.handleResize.bind(this);
        this.boundHandleMouseDown = this.handleMouseDown.bind(this);
        this.boundHandleMouseMove = this.handleMouseMove.bind(this);
        this.boundHandleMouseUp = this.handleMouseUp.bind(this);
        this.boundHandleWheel = this.handleWheel.bind(this);
        this.boundHandleTouchStart = this.handleTouchStart.bind(this);
        this.boundHandleTouchMove = this.handleTouchMove.bind(this);
        this.boundHandleTouchEnd = this.handleTouchEnd.bind(this);
        this.boundHandleKeyDown = this.handleKeyDown.bind(this);
        
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
        window.addEventListener('resize', this.boundHandleResize);
        
        // 如果启用控制，设置鼠标和触摸事件
        if (this.options.enableControl) {
            // 鼠标事件
            this.canvas.addEventListener('mousedown', this.boundHandleMouseDown);
            this.canvas.addEventListener('mousemove', this.boundHandleMouseMove);
            this.canvas.addEventListener('mouseup', this.boundHandleMouseUp);
            this.canvas.addEventListener('mouseleave', this.boundHandleMouseUp);
            
            // 鼠标滚轮事件
            this.canvas.addEventListener('wheel', this.boundHandleWheel, { passive: false });
            
            // 触摸事件
            this.canvas.addEventListener('touchstart', this.boundHandleTouchStart, { passive: false });
            this.canvas.addEventListener('touchmove', this.boundHandleTouchMove, { passive: false });
            this.canvas.addEventListener('touchend', this.boundHandleTouchEnd);
            
            // 键盘事件
            window.addEventListener('keydown', this.boundHandleKeyDown);
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
        // 确保不会创建多个渲染循环
        if (this.animationFrameId !== null) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
        
        const renderFrame = (currentTime: number) => {
            // 计算帧时间差
            const deltaTime = currentTime - (this.lastFrameTime || currentTime);
            this.lastFrameTime = currentTime;
            
            // 如果启用自动旋转
            if (this.autoRotate) {
                this.rotateGlobeY(this.autoRotateSpeed);
            }
            
            // 更新图层
            this.layerManager.update(deltaTime);
            
            // 渲染地球和图层
            this.renderScene();
            
            // 继续渲染循环
            this.animationFrameId = requestAnimationFrame(renderFrame);
        };
        
        // 启动渲染循环
        this.animationFrameId = requestAnimationFrame(renderFrame);
    }
    
    /**
     * 渲染场景（地球和所有图层）
     */
    private renderScene(): void {
        // 渲染地球（包含内置的渲染通道管理）
        this.renderer.render();
        
        // TODO: 将图层渲染集成到renderer中，或者创建单独的渲染通道
        // 目前先使用简单的方法
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
        // 修正Y轴方向, 因为Y轴方向是相反的
        const deltaY = -(event.clientY - this.lastMouseY);
        
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
     * 处理键盘事件
     */
    private handleKeyDown(event: KeyboardEvent): void {
        if (!this.options.enableControl) return;
        
        const rotationStep = 0.1;
        const zoomStep = 0.1;
        
        switch (event.key) {
            case 'ArrowLeft':
            case 'a':
            case 'A':
                this.rotateGlobeY(-rotationStep);
                event.preventDefault();
                break;
                
            case 'ArrowRight':
            case 'd':
            case 'D':
                this.rotateGlobeY(rotationStep);
                event.preventDefault();
                break;
                
            case 'ArrowUp':
            case 'w':
            case 'W':
                this.rotateGlobeX(rotationStep);
                event.preventDefault();
                break;
                
            case 'ArrowDown':
            case 's':
            case 'S':
                this.rotateGlobeX(-rotationStep);
                event.preventDefault();
                break;
                
            case '+':
            case '=':
                this.setZoom(this.options.zoom! * (1 + zoomStep));
                event.preventDefault();
                break;
                
            case '-':
            case '_':
                this.setZoom(this.options.zoom! * (1 - zoomStep));
                event.preventDefault();
                break;
                
            case ' ':
                this.setAutoRotate(!this.autoRotate);
                event.preventDefault();
                break;
                
            case 'r':
            case 'R':
                // 重置视角
                this.setZoom(1);
                this.setCenter(0, 0);
                this.setAutoRotate(false);
                event.preventDefault();
                break;
                
            case 'g':
            case 'G':
                // 切换网格线
                this.toggleGridLines();
                event.preventDefault();
                break;
        }
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
     * 设置经纬网格线的显示状态
     * @param visible 是否显示网格线
     */
    public setGridLinesVisible(visible: boolean): void {
        if (this.options.showGridLines !== visible) {
            this.options.showGridLines = visible;
            this.renderer.setGridLinesVisible(visible);
        }
    }
    
    /**
     * 获取经纬网格线的显示状态
     * @returns 是否显示网格线
     */
    public getGridLinesVisible(): boolean {
        return this.options.showGridLines ?? false;
    }
    
    /**
     * 切换经纬网格线的显示状态
     * @returns 切换后的显示状态
     */
    public toggleGridLines(): boolean {
        const newState = !this.getGridLinesVisible();
        this.setGridLinesVisible(newState);
        return newState;
    }
    
    /**
     * 添加点图层
     */
    public async addPointLayer(id: string, name: string, points: PointData[]): Promise<boolean> {
        const pointLayer = new PointLayer(id, name, this.engine, this.camera);
        pointLayer.addPoints(points);
        return await this.layerManager.addLayer(pointLayer);
    }
    
    /**
     * 移除图层
     */
    public removeLayer(id: string): boolean {
        return this.layerManager.removeLayer(id);
    }
    
    /**
     * 设置图层可见性
     */
    public setLayerVisible(id: string, visible: boolean): boolean {
        return this.layerManager.setLayerVisible(id, visible);
    }
    
    /**
     * 设置图层透明度
     */
    public setLayerOpacity(id: string, opacity: number): boolean {
        return this.layerManager.setLayerOpacity(id, opacity);
    }
    
    /**
     * 获取图层管理器
     */
    public getLayerManager(): LayerManager {
        return this.layerManager;
    }
    
    /**
     * 设置光照方向
     */
    public setLightDirection(x: number, y: number, z: number): void {
        this.renderer.setLightDirection(x, y, z);
    }
    
    /**
     * 加载示例城市数据
     */
    public async loadSampleCityData(): Promise<boolean> {
        const cityData = GeoDataLoader.createSampleCityData();
        const pointData: PointData[] = cityData.map(city => ({
            longitude: city.longitude,
            latitude: city.latitude,
            altitude: city.altitude,
            color: [1.0, 0.8, 0.0, 1.0], // 金色
            size: Math.log(city.properties?.population || 1000000) * 2, // 根据人口调整大小
            label: city.properties?.name,
            data: city.properties
        }));
        
        return await this.addPointLayer('cities', '世界城市', pointData);
    }
    
    /**
     * 从GeoJSON URL加载数据
     */
    public async loadGeoJSONData(url: string, layerId: string, layerName: string): Promise<boolean> {
        try {
            const geoJSON = await GeoDataLoader.loadGeoJSON(url);
            if (!geoJSON) {
                console.error('Failed to load GeoJSON data');
                return false;
            }
            
            const pointData = GeoDataLoader.parsePointsFromGeoJSON(geoJSON);
            const points: PointData[] = pointData.map(point => ({
                longitude: point.longitude,
                latitude: point.latitude,
                altitude: point.altitude,
                color: [0.0, 1.0, 0.0, 1.0], // 绿色
                size: 5.0,
                data: point.properties
            }));
            
            return await this.addPointLayer(layerId, layerName, points);
        } catch (error) {
            console.error('Error loading GeoJSON data:', error);
            return false;
        }
    }
    
    /**
     * 销毁AIMap实例
     */
    public destroy(): void {
        // 停止渲染循环
        this.stop();
        
        // 释放图层管理器
        if (this.layerManager) {
            this.layerManager.destroy();
        }
        
        // 释放WebGPU资源
        if (this.renderer) {
            this.renderer.destroy();
        }
        
        if (this.engine) {
            this.engine.destroy();
        }
        
        // 移除事件监听器
        window.removeEventListener('resize', this.boundHandleResize);
        
        if (this.options.enableControl) {
            this.canvas.removeEventListener('mousedown', this.boundHandleMouseDown);
            this.canvas.removeEventListener('mousemove', this.boundHandleMouseMove);
            this.canvas.removeEventListener('mouseup', this.boundHandleMouseUp);
            this.canvas.removeEventListener('mouseleave', this.boundHandleMouseUp);
            this.canvas.removeEventListener('wheel', this.boundHandleWheel);
            this.canvas.removeEventListener('touchstart', this.boundHandleTouchStart);
            this.canvas.removeEventListener('touchmove', this.boundHandleTouchMove);
            this.canvas.removeEventListener('touchend', this.boundHandleTouchEnd);
            window.removeEventListener('keydown', this.boundHandleKeyDown);
        }
    }
} 