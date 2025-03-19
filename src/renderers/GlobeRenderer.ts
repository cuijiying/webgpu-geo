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
    
    // 网格线相关属性
    private showGridLines: boolean = false;
    private gridPipeline: GPURenderPipeline | null = null;
    private gridVertexBuffer: GPUBuffer | null = null;
    private gridIndexBuffer: GPUBuffer | null = null;
    private gridIndexCount: number = 0;
    
    constructor(engine: Engine, camera: Camera, showGridLines: boolean = false) {
        this.engine = engine;
        this.camera = camera;
        this.showGridLines = showGridLines;
    }
    
    /**
     * 设置网格线的可见性
     * @param visible 是否可见
     */
    public setGridLinesVisible(visible: boolean): void {
        console.log(`设置网格线可见性: ${visible}`);
        
        // 如果状态没有变化，则不做任何操作
        if (this.showGridLines === visible) {
            console.log("网格线可见性状态未变化，不执行任何操作");
            return;
        }
        
        // 更新状态
        this.showGridLines = visible;
        console.log(`网格线状态已更新: ${this.showGridLines}`);
        
        // 如果变为显示状态，但尚未创建网格线几何体
        if (visible) {
            console.log("准备创建网格线资源");
            const device = this.engine.getDevice();
            const context = this.engine.getContext();
            
            if (!device) {
                console.error("无法获取GPU设备，无法创建网格线");
                return;
            }
            
            if (!context) {
                console.error("无法获取绘图上下文，无法创建网格线");
                return;
            }
            
            // 如果网格线顶点缓冲区不存在，创建几何体
            if (!this.gridVertexBuffer) {
                console.log("创建网格线几何体");
                this.createGridGeometry(device);
            } else {
                console.log("网格线几何体已存在");
            }
            
            // 如果网格线渲染管线不存在，创建管线
            if (!this.gridPipeline) {
                console.log("创建网格线渲染管线");
                this.createGridPipeline(device, context);
            } else {
                console.log("网格线渲染管线已存在");
            }
            
            console.log("网格线资源准备完毕", {
                vertexBuffer: !!this.gridVertexBuffer,
                indexBuffer: !!this.gridIndexBuffer,
                pipeline: !!this.gridPipeline,
                indexCount: this.gridIndexCount
            });
        }
    }
    
    /**
     * 创建网格线渲染管线
     */
    private createGridPipeline(device: GPUDevice, context: GPUCanvasContext): void {
        // 创建网格线着色器
        const gridShaderModule = device.createShaderModule({
            label: "Grid shaders",
            code: `
                struct Uniforms {
                    modelMatrix: mat4x4<f32>,
                    viewMatrix: mat4x4<f32>,
                    projectionMatrix: mat4x4<f32>,
                };
                
                @group(0) @binding(0) var<uniform> uniforms: Uniforms;
                
                struct VertexOutput {
                    @builtin(position) position: vec4<f32>,
                    @location(0) worldPos: vec3<f32>,
                };
                
                @vertex
                fn vertexMain(@location(0) position: vec3<f32>) -> VertexOutput {
                    var output: VertexOutput;
                    var worldPosition = uniforms.modelMatrix * vec4<f32>(position, 1.0);
                    output.worldPos = worldPosition.xyz;
                    output.position = uniforms.projectionMatrix * uniforms.viewMatrix * worldPosition;
                    return output;
                }
                
                @fragment
                fn fragmentMain(@location(0) worldPos: vec3<f32>) -> @location(0) vec4<f32> {
                    // 简单方法 - 直接返回黑色，不进行背面剔除
                    return vec4<f32>(0.0, 0.0, 0.0, 1.0); // 纯黑色
                }
            `
        });
        
        // 获取绑定组布局
        const bindGroupLayout = device.createBindGroupLayout({
            label: "Grid Bind Group Layout",
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
            label: "Grid Pipeline Layout",
            bindGroupLayouts: [bindGroupLayout]
        });
        
        // 创建网格线渲染管线
        this.gridPipeline = device.createRenderPipeline({
            label: "Grid pipeline",
            layout: pipelineLayout,
            vertex: {
                module: gridShaderModule,
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
                module: gridShaderModule,
                entryPoint: "fragmentMain",
                targets: [{
                    format: context.getCurrentTexture().format,
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
                topology: "line-list",
                cullMode: "back", // 改为背面剔除
                frontFace: "ccw"
            },
            depthStencil: {
                depthWriteEnabled: true, 
                depthCompare: "less",
                format: "depth24plus"
            }
        });
        
        // 如果需要，重新创建绑定组
        if (this.uniformBuffer) {
            this.uniformBindGroup = device.createBindGroup({
                label: "Uniform Bind Group",
                layout: bindGroupLayout,
                entries: [{
                    binding: 0,
                    resource: {
                        buffer: this.uniformBuffer
                    }
                }]
            });
        }
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
        
        // 如果启用网格线，创建网格线几何体
        if (this.showGridLines) {
            this.createGridGeometry(device);
        }
        
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
                    modelMatrix: mat4x4<f32>,
                    viewMatrix: mat4x4<f32>,
                    projectionMatrix: mat4x4<f32>,
                };
                
                @group(0) @binding(0) var<uniform> uniforms: Uniforms;
                
                struct VertexOutput {
                    @builtin(position) position: vec4<f32>,
                };
                
                @vertex
                fn vertexMain(@location(0) position: vec3<f32>) -> VertexOutput {
                    var output: VertexOutput;
                    output.position = uniforms.projectionMatrix * uniforms.viewMatrix * uniforms.modelMatrix * vec4<f32>(position, 1.0);
                    return output;
                }
                
                @fragment
                fn fragmentMain() -> @location(0) vec4<f32> {
                    // 使用浅灰色，以便网格线更明显
                    return vec4<f32>(0.5, 0.5, 0.5, 1.0);
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
                    format: context.getCurrentTexture().format,
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
                topology: "triangle-list",
                cullMode: "back",
                frontFace: "ccw"
            },
            depthStencil: {
                depthWriteEnabled: true,
                depthCompare: "less",
                format: "depth24plus"
            }
        });

        // 如果启用网格线，创建网格线渲染管线
        if (this.showGridLines) {
            this.createGridPipeline(device, context);
        }
        
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
     * 创建网格线几何体
     */
    private createGridGeometry(device: GPUDevice, radius: number = 1.01): void {
        console.log("创建网格线几何体");
        const vertices: number[] = [];
        const indices: number[] = [];
        let indexCounter = 0;
        
        // 使用稍微大一点的半径，确保网格线显示在球体表面上方
        // 创建经线（子午线）- 南北方向的线
        const longitudeCount = 36; // 每10度一条线
        for (let i = 0; i < longitudeCount; i++) {
            const angle = (i / longitudeCount) * Math.PI * 2;
            const x = Math.sin(angle);
            const z = Math.cos(angle);
            
            // 从南极到北极的线
            for (let j = 0; j <= 36; j++) {
                const phi = (j / 36) * Math.PI;
                const sinPhi = Math.sin(phi);
                const cosPhi = Math.cos(phi);
                
                const px = radius * sinPhi * x;
                const py = radius * cosPhi;
                const pz = radius * sinPhi * z;
                
                vertices.push(px, py, pz);
                
                // 添加线段
                if (j < 36) {
                    indices.push(indexCounter, indexCounter + 1);
                }
                
                indexCounter++;
            }
        }
        
        // 创建纬线（平行线）- 东西方向的圆形线
        const latitudeCount = 18; // 每10度一条线
        for (let i = 1; i < latitudeCount; i++) {
            const phi = (i / latitudeCount) * Math.PI;
            const sinPhi = Math.sin(phi);
            const cosPhi = Math.cos(phi);
            const circleRadius = radius * sinPhi;
            
            const startIndex = indexCounter;
            
            // 创建圆形线
            for (let j = 0; j <= 36; j++) {
                const angle = (j / 36) * Math.PI * 2;
                const x = circleRadius * Math.sin(angle);
                const y = radius * cosPhi;
                const z = circleRadius * Math.cos(angle);
                
                vertices.push(x, y, z);
                
                // 添加线段
                if (j < 36) {
                    indices.push(indexCounter, indexCounter + 1);
                }
                
                indexCounter++;
            }
        }
        
        console.log(`网格线几何体: ${vertices.length / 3} 个顶点, ${indices.length / 2} 条线段`);
        
        // 创建顶点缓冲区
        this.gridVertexBuffer = device.createBuffer({
            label: "Grid vertices",
            size: vertices.length * 4, // float32 = 4 bytes
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        
        // 创建索引缓冲区
        this.gridIndexBuffer = device.createBuffer({
            label: "Grid indices",
            size: indices.length * 4, // uint32 = 4 bytes
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
        
        // 写入数据
        device.queue.writeBuffer(this.gridVertexBuffer, 0, new Float32Array(vertices));
        device.queue.writeBuffer(this.gridIndexBuffer, 0, new Uint32Array(indices));
        
        this.gridIndexCount = indices.length;
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
     * 渲染球体和网格线
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
        
        // 渲染球体
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.uniformBindGroup);
        pass.setVertexBuffer(0, this.vertexBuffer);
        pass.setIndexBuffer(this.indexBuffer, 'uint32');
        pass.drawIndexed(this.indexCount);
        
        // 只在网格线启用时才尝试渲染网格线
        if (this.showGridLines) {
            // 检查所有必要的资源是否存在
            if (this.gridPipeline && this.gridVertexBuffer && this.gridIndexBuffer && this.gridIndexCount > 0) {
                // 设置网格线渲染管线和资源
                pass.setPipeline(this.gridPipeline);
                pass.setBindGroup(0, this.uniformBindGroup);
                pass.setVertexBuffer(0, this.gridVertexBuffer);
                pass.setIndexBuffer(this.gridIndexBuffer, 'uint32');
                
                // 绘制网格线
                pass.drawIndexed(this.gridIndexCount);
                
                // 调试输出
                console.log("绘制网格线: " + this.gridIndexCount + " 个索引");
            } else {
                // 缺少必要资源，输出调试信息
                console.warn("网格线显示已启用，但缺少必要资源", {
                    pipeline: !!this.gridPipeline,
                    vertexBuffer: !!this.gridVertexBuffer,
                    indexBuffer: !!this.gridIndexBuffer,
                    indexCount: this.gridIndexCount
                });
            }
        }
        
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
        
        // 释放网格线资源
        if (this.gridVertexBuffer) {
            this.gridVertexBuffer.destroy();
            this.gridVertexBuffer = null;
        }
        
        if (this.gridIndexBuffer) {
            this.gridIndexBuffer.destroy();
            this.gridIndexBuffer = null;
        }
        
        // 释放深度纹理
        if (this.depthTexture) {
            this.depthTexture.destroy();
            this.depthTexture = null;
        }
        
        this.pipeline = null;
        this.gridPipeline = null;
        this.uniformBindGroup = null;
        this.indexCount = 0;
        this.gridIndexCount = 0;
    }
} 