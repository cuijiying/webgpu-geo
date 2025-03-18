import { Engine } from '../core/Engine';
import { Camera } from '../core/Camera';
import { mat4 } from 'gl-matrix';

/**
 * 球体渲染器
 */
export class GlobeRenderer {
    private engine: Engine;
    private camera: Camera;
    private pipeline: GPURenderPipeline | null = null;
    private vertexBuffer: GPUBuffer | null = null;
    private indexBuffer: GPUBuffer | null = null;
    private uniformBuffer: GPUBuffer | null = null;
    private uniformBindGroup: GPUBindGroup | null = null;
    private indexCount: number = 0;
    
    // 缓存深度纹理
    private depthTexture: GPUTexture | null = null;
    private canvasWidth: number = 0;
    private canvasHeight: number = 0;
    
    constructor(engine: Engine, camera: Camera) {
        this.engine = engine;
        this.camera = camera;
    }
    
    /**
     * 初始化渲染器
     */
    public async initialize(): Promise<boolean> {
        const device = this.engine.getDevice();
        const context = this.engine.getContext();
        
        if (!device || !context) {
            console.error("引擎未正确初始化");
            return false;
        }
        
        // 创建球体几何体
        this.createSphereGeometry(device);
        
        // 创建统一缓冲区
        this.uniformBuffer = device.createBuffer({
            label: "Uniform Buffer",
            size: 64 * 3, // 3个mat4矩阵
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        
        // 创建着色器
        const shaderModule = device.createShaderModule({
            label: "Globe shaders",
            code: `
                struct Uniforms {
                    modelMatrix: mat4x4f,
                    viewMatrix: mat4x4f,
                    projectionMatrix: mat4x4f,
                };
                
                @group(0) @binding(0) var<uniform> uniforms: Uniforms;
                
                struct VertexOutput {
                    @builtin(position) position: vec4f,
                };
                
                @vertex
                fn vertexMain(@location(0) position: vec3f) -> VertexOutput {
                    var output: VertexOutput;
                    var mvpPosition = uniforms.projectionMatrix * uniforms.viewMatrix * uniforms.modelMatrix * vec4f(position, 1.0);
                    output.position = mvpPosition;
                    return output;
                }
                
                @fragment
                fn fragmentMain() -> @location(0) vec4f {
                    return vec4f(1.0, 1.0, 1.0, 1.0); // 纯白色
                }
            `
        });
        
        // 创建绑定组布局
        const bindGroupLayout = device.createBindGroupLayout({
            label: "Globe Bind Group Layout",
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.VERTEX,
                buffer: {
                    type: "uniform"
                }
            }]
        });
        
        // 创建管线布局
        const pipelineLayout = device.createPipelineLayout({
            label: "Globe Pipeline Layout",
            bindGroupLayouts: [bindGroupLayout]
        });
        
        // 创建绑定组
        this.uniformBindGroup = device.createBindGroup({
            label: "Globe Uniform Bind Group",
            layout: bindGroupLayout,
            entries: [{
                binding: 0,
                resource: {
                    buffer: this.uniformBuffer
                }
            }]
        });
        
        // 创建渲染管线
        this.pipeline = device.createRenderPipeline({
            label: "Globe pipeline",
            layout: pipelineLayout,
            vertex: {
                module: shaderModule,
                entryPoint: "vertexMain",
                buffers: [{
                    arrayStride: 12, // 3 * float32
                    attributes: [{
                        shaderLocation: 0,
                        offset: 0,
                        format: "float32x3" // 3D positions
                    }]
                }]
            },
            fragment: {
                module: shaderModule,
                entryPoint: "fragmentMain",
                targets: [{
                    format: navigator.gpu.getPreferredCanvasFormat()
                }]
            },
            primitive: {
                topology: "triangle-list",
                cullMode: "back"
            },
            depthStencil: {
                depthWriteEnabled: true,
                depthCompare: "less",
                format: "depth24plus"
            }
        });
        
        // 初始化深度纹理
        this.updateDepthTexture(device, context);
        
        return true;
    }
    
    /**
     * 更新深度纹理（如果画布大小变化）
     */
    private updateDepthTexture(device: GPUDevice, context: GPUCanvasContext): void {
        const canvas = context.canvas as HTMLCanvasElement;
        const width = canvas.width;
        const height = canvas.height;
        
        // 如果画布大小未变或尚未初始化，不需要更新
        if (width === this.canvasWidth && height === this.canvasHeight && this.depthTexture) {
            return;
        }
        
        // 销毁旧的深度纹理
        if (this.depthTexture) {
            this.depthTexture.destroy();
            this.depthTexture = null;
        }
        
        // 创建新的深度纹理
        this.depthTexture = device.createTexture({
            label: "Depth Texture",
            size: [width, height],
            format: 'depth24plus',
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        
        // 更新尺寸缓存
        this.canvasWidth = width;
        this.canvasHeight = height;
    }
    
    /**
     * 创建球体几何体
     */
    private createSphereGeometry(device: GPUDevice, radius: number = 1.0, segments: number = 32): void {
        const vertices: number[] = [];
        const indices: number[] = [];
        
        // 生成顶点
        for (let y = 0; y <= segments; y++) {
            const phi = (y / segments) * Math.PI;
            
            for (let x = 0; x <= segments; x++) {
                const theta = (x / segments) * Math.PI * 2;
                
                // 球面坐标到笛卡尔坐标的转换
                const px = radius * Math.sin(phi) * Math.cos(theta);
                const py = radius * Math.cos(phi);
                const pz = radius * Math.sin(phi) * Math.sin(theta);
                
                vertices.push(px, py, pz);
            }
        }
        
        // 生成索引
        for (let y = 0; y < segments; y++) {
            for (let x = 0; x < segments; x++) {
                const i1 = y * (segments + 1) + x;
                const i2 = i1 + 1;
                const i3 = i1 + (segments + 1);
                const i4 = i3 + 1;
                
                // 一个矩形分成两个三角形
                indices.push(i1, i3, i2);
                indices.push(i2, i3, i4);
            }
        }
        
        // 创建顶点缓冲区
        this.vertexBuffer = device.createBuffer({
            label: "Sphere vertices",
            size: vertices.length * 4, // float32 = 4 bytes
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        
        // 创建索引缓冲区
        this.indexBuffer = device.createBuffer({
            label: "Sphere indices",
            size: indices.length * 4, // uint32 = 4 bytes
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
        
        // 写入数据
        device.queue.writeBuffer(this.vertexBuffer, 0, new Float32Array(vertices));
        device.queue.writeBuffer(this.indexBuffer, 0, new Uint32Array(indices));
        
        this.indexCount = indices.length;
    }
    
    /**
     * 更新统一变量
     */
    private updateUniforms(device: GPUDevice): void {
        if (!this.uniformBuffer) return;
        
        // 创建模型矩阵
        const modelMatrix = mat4.create();
        mat4.identity(modelMatrix);
        
        // 获取相机矩阵
        const viewMatrix = this.camera.getViewMatrix();
        const projectionMatrix = this.camera.getProjectionMatrix();
        
        // 创建一个包含所有矩阵数据的数组
        const uniformData = new Float32Array(16 * 3);
        uniformData.set(modelMatrix as Float32Array, 0);
        uniformData.set(viewMatrix as Float32Array, 16);
        uniformData.set(projectionMatrix as Float32Array, 32);
        
        // 写入到统一缓冲区
        device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);
    }
    
    /**
     * 渲染球体
     */
    public render(): void {
        const device = this.engine.getDevice();
        const context = this.engine.getContext();
        
        if (!device || !context || !this.pipeline || !this.vertexBuffer || !this.indexBuffer || !this.uniformBindGroup) {
            return;
        }
        
        // 检查并更新深度纹理（如果需要）
        this.updateDepthTexture(device, context);
        
        if (!this.depthTexture) {
            return;
        }
        
        // 更新统一变量
        this.updateUniforms(device);
        
        // 获取当前帧的视图
        const view = context.getCurrentTexture().createView();
        
        // 创建命令编码器
        const encoder = device.createCommandEncoder({label: "Globe Render Commands"});
        
        // 开始渲染通道
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view,
                clearValue: [0.0, 0.0, 0.0, 1.0],
                loadOp: 'clear',
                storeOp: 'store',
            }],
            depthStencilAttachment: {
                view: this.depthTexture.createView(),
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            }
        });
        
        // 设置管线
        pass.setPipeline(this.pipeline);
        
        // 设置绑定组
        pass.setBindGroup(0, this.uniformBindGroup);
        
        // 设置顶点缓冲区
        pass.setVertexBuffer(0, this.vertexBuffer);
        
        // 设置索引缓冲区
        pass.setIndexBuffer(this.indexBuffer, 'uint32');
        
        // 绘制
        pass.drawIndexed(this.indexCount);
        
        // 结束通道
        pass.end();
        
        // 提交命令
        device.queue.submit([encoder.finish()]);
    }
    
    /**
     * 释放渲染器资源
     */
    public destroy(): void {
        const device = this.engine.getDevice();
        if (!device) return;
        
        // 释放WebGPU缓冲区
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
        
        // 释放深度纹理
        if (this.depthTexture) {
            this.depthTexture.destroy();
            this.depthTexture = null;
        }
        
        this.pipeline = null;
        this.uniformBindGroup = null;
        this.indexCount = 0;
    }
} 