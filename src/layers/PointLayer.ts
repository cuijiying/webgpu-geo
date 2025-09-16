import { Layer } from './Layer';
import { Engine } from '../core/Engine';
import { Camera } from '../core/Camera';
import { mat4 } from 'gl-matrix';

/**
 * 点数据接口
 */
export interface PointData {
    longitude: number;
    latitude: number;
    altitude?: number;
    color?: [number, number, number, number]; // RGBA
    size?: number;
    label?: string;
    data?: any; // 自定义数据
}

/**
 * 点图层
 * 用于在地球上显示点状数据
 */
export class PointLayer extends Layer {
    private points: PointData[] = [];
    private vertexBuffer: GPUBuffer | null = null;
    private indexBuffer: GPUBuffer | null = null;
    private uniformBuffer: GPUBuffer | null = null;
    private pipeline: GPURenderPipeline | null = null;
    private bindGroup: GPUBindGroup | null = null;
    private vertexCount: number = 0;
    
    // 默认样式
    private defaultColor: [number, number, number, number] = [1.0, 0.0, 0.0, 1.0]; // 红色
    private defaultSize: number = 5.0;
    
    constructor(id: string, name: string, engine: Engine, camera: Camera) {
        super(id, name, engine, camera);
    }
    
    /**
     * 添加点数据
     */
    public addPoint(point: PointData): void {
        this.points.push(point);
    }
    
    /**
     * 添加多个点
     */
    public addPoints(points: PointData[]): void {
        this.points.push(...points);
    }
    
    /**
     * 清空所有点
     */
    public clearPoints(): void {
        this.points = [];
    }
    
    /**
     * 获取所有点
     */
    public getPoints(): PointData[] {
        return [...this.points];
    }
    
    /**
     * 设置默认颜色
     */
    public setDefaultColor(r: number, g: number, b: number, a: number = 1.0): void {
        this.defaultColor = [r, g, b, a];
    }
    
    /**
     * 设置默认大小
     */
    public setDefaultSize(size: number): void {
        this.defaultSize = size;
    }
    
    /**
     * 初始化点图层
     */
    public async initialize(): Promise<boolean> {
        const device = this.engine.getDevice();
        if (!device) {
            console.error("无法获取GPU设备");
            return false;
        }
        
        // 创建着色器
        await this.createShaders(device);
        
        // 创建统一缓冲区
        this.uniformBuffer = device.createBuffer({
            label: "Point Layer Uniform Buffer",
            size: 64 * 3 + 16, // 3个mat4 + 其他参数
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        
        return true;
    }
    
    /**
     * 创建着色器和渲染管线
     */
    private async createShaders(device: GPUDevice): Promise<void> {
        const shaderModule = device.createShaderModule({
            label: "Point Layer Shaders",
            code: `
                struct Uniforms {
                    modelMatrix: mat4x4<f32>,
                    viewMatrix: mat4x4<f32>,
                    projectionMatrix: mat4x4<f32>,
                    pointSize: f32,
                    opacity: f32,
                    _padding: vec2<f32>,
                };
                
                @group(0) @binding(0) var<uniform> uniforms: Uniforms;
                
                struct VertexInput {
                    @location(0) position: vec3<f32>,
                    @location(1) color: vec4<f32>,
                    @location(2) size: f32,
                };
                
                struct VertexOutput {
                    @builtin(position) position: vec4<f32>,
                    @location(0) color: vec4<f32>,
                    @builtin(point_size) size: f32,
                };
                
                @vertex
                fn vertexMain(input: VertexInput) -> VertexOutput {
                    var output: VertexOutput;
                    
                    var worldPosition = uniforms.modelMatrix * vec4<f32>(input.position, 1.0);
                    output.position = uniforms.projectionMatrix * uniforms.viewMatrix * worldPosition;
                    output.color = input.color;
                    output.size = input.size * uniforms.pointSize;
                    
                    return output;
                }
                
                @fragment
                fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
                    // 创建圆形点
                    let center = vec2<f32>(0.5, 0.5);
                    let dist = distance(input.position.xy, center);
                    
                    if (dist > 0.5) {
                        discard;
                    }
                    
                    // 边缘柔化
                    let alpha = 1.0 - smoothstep(0.4, 0.5, dist);
                    
                    var finalColor = input.color;
                    finalColor.a *= alpha * uniforms.opacity;
                    
                    return finalColor;
                }
            `
        });
        
        // 创建绑定组布局
        const bindGroupLayout = device.createBindGroupLayout({
            label: "Point Layer Bind Group Layout",
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                buffer: { type: "uniform" }
            }]
        });
        
        // 创建管线布局
        const pipelineLayout = device.createPipelineLayout({
            label: "Point Layer Pipeline Layout",
            bindGroupLayouts: [bindGroupLayout]
        });
        
        // 创建绑定组
        this.bindGroup = device.createBindGroup({
            label: "Point Layer Bind Group",
            layout: bindGroupLayout,
            entries: [{
                binding: 0,
                resource: { buffer: this.uniformBuffer! }
            }]
        });
        
        // 创建渲染管线
        this.pipeline = device.createRenderPipeline({
            label: "Point Layer Pipeline",
            layout: pipelineLayout,
            vertex: {
                module: shaderModule,
                entryPoint: "vertexMain",
                buffers: [{
                    arrayStride: 32, // 3 * float32 (position) + 4 * float32 (color) + 1 * float32 (size)
                    attributes: [
                        {
                            shaderLocation: 0, // position
                            offset: 0,
                            format: "float32x3"
                        },
                        {
                            shaderLocation: 1, // color
                            offset: 12,
                            format: "float32x4"
                        },
                        {
                            shaderLocation: 2, // size
                            offset: 28,
                            format: "float32"
                        }
                    ]
                }]
            },
            fragment: {
                module: shaderModule,
                entryPoint: "fragmentMain",
                targets: [{
                    format: 'bgra8unorm', // 假设的格式，实际应该从上下文获取
                    blend: {
                        color: {
                            srcFactor: "src-alpha",
                            dstFactor: "one-minus-src-alpha",
                            operation: "add"
                        },
                        alpha: {
                            srcFactor: "one",
                            dstFactor: "one-minus-src-alpha",
                            operation: "add"
                        }
                    }
                }]
            },
            primitive: {
                topology: "point-list"
            },
            depthStencil: {
                depthWriteEnabled: false,
                depthCompare: "less-equal",
                format: "depth24plus"
            }
        });
    }
    
    /**
     * 更新几何体数据
     */
    private updateGeometry(): void {
        const device = this.engine.getDevice();
        if (!device || this.points.length === 0) return;
        
        // 准备顶点数据
        const vertices: number[] = [];
        
        for (const point of this.points) {
            // 将经纬度转换为3D坐标
            const lon = point.longitude * Math.PI / 180;
            const lat = point.latitude * Math.PI / 180;
            const radius = 1.0 + (point.altitude || 0) * 0.001; // 高度缩放
            
            const x = radius * Math.cos(lat) * Math.cos(lon);
            const y = radius * Math.sin(lat);
            const z = radius * Math.cos(lat) * Math.sin(lon);
            
            // 位置
            vertices.push(x, y, z);
            
            // 颜色
            const color = point.color || this.defaultColor;
            vertices.push(color[0], color[1], color[2], color[3]);
            
            // 大小
            const size = point.size || this.defaultSize;
            vertices.push(size);
        }
        
        // 创建或更新顶点缓冲区
        if (this.vertexBuffer) {
            this.vertexBuffer.destroy();
        }
        
        this.vertexBuffer = device.createBuffer({
            label: "Point Layer Vertices",
            size: vertices.length * 4,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        
        device.queue.writeBuffer(this.vertexBuffer, 0, new Float32Array(vertices));
        this.vertexCount = this.points.length;
    }
    
    /**
     * 更新统一变量
     */
    private updateUniforms(): void {
        const device = this.engine.getDevice();
        if (!device || !this.uniformBuffer) return;
        
        // 创建模型矩阵
        const modelMatrix = mat4.create();
        mat4.identity(modelMatrix);
        
        // 获取相机矩阵
        const viewMatrix = this.camera.getViewMatrix();
        const projectionMatrix = this.camera.getProjectionMatrix();
        
        // 创建统一数据
        const uniformData = new Float32Array(48 + 4); // 3*16 + 4
        uniformData.set(modelMatrix as Float32Array, 0);
        uniformData.set(viewMatrix as Float32Array, 16);
        uniformData.set(projectionMatrix as Float32Array, 32);
        
        // 其他参数
        uniformData[48] = this.defaultSize; // pointSize
        uniformData[49] = this.opacity;     // opacity
        uniformData[50] = 0.0;              // padding
        uniformData[51] = 0.0;              // padding
        
        device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);
    }
    
    /**
     * 渲染点图层
     */
    public render(renderPass: GPURenderPassEncoder): void {
        if (!this.visible || this.points.length === 0 || !this.pipeline || !this.bindGroup) {
            return;
        }
        
        // 更新几何体（如果需要）
        this.updateGeometry();
        
        // 更新统一变量
        this.updateUniforms();
        
        if (!this.vertexBuffer) return;
        
        // 设置渲染管线和资源
        renderPass.setPipeline(this.pipeline);
        renderPass.setBindGroup(0, this.bindGroup);
        renderPass.setVertexBuffer(0, this.vertexBuffer);
        
        // 绘制点
        renderPass.draw(this.vertexCount);
    }
    
    /**
     * 释放资源
     */
    public destroy(): void {
        if (this.vertexBuffer) {
            this.vertexBuffer.destroy();
            this.vertexBuffer = null;
        }
        
        if (this.indexBuffer) {
            this.indexBuffer.destroy();
            this.indexBuffer = null;
        }
        
        if (this.uniformBuffer) {
            this.uniformBuffer.destroy();
            this.uniformBuffer = null;
        }
        
        this.pipeline = null;
        this.bindGroup = null;
        this.points = [];
        this.vertexCount = 0;
    }
}