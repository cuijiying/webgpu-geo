import { Engine } from '../core/Engine';
import { Camera } from '../core/Camera';
import { TextureManager } from '../core/TextureManager';
import { GlobeShaders } from '../shaders/GlobeShaders';
import { mat4, vec3 } from 'gl-matrix';

/**
 * 球体渲染器
 */
export class GlobeRenderer {
    private engine: Engine;
    private camera: Camera;
    private textureManager: TextureManager | null = null;
    
    // 渲染管线
    private pipeline: GPURenderPipeline | null = null;
    private gridPipeline: GPURenderPipeline | null = null;
    
    // 几何体缓冲区
    private vertexBuffer: GPUBuffer | null = null;
    private indexBuffer: GPUBuffer | null = null;
    private gridVertexBuffer: GPUBuffer | null = null;
    private gridIndexBuffer: GPUBuffer | null = null;
    private indexCount: number = 0;
    private gridIndexCount: number = 0;
    
    // 统一变量
    private uniformBuffer: GPUBuffer | null = null;
    private uniformBindGroup: GPUBindGroup | null = null;
    
    // 纹理资源
    private earthTexture: GPUTexture | null = null;
    private normalTexture: GPUTexture | null = null;
    private earthSampler: GPUSampler | null = null;
    private normalSampler: GPUSampler | null = null;
    
    // 深度纹理
    private depthTexture: GPUTexture | null = null;
    private canvasWidth: number = 0;
    private canvasHeight: number = 0;
    
    // 渲染设置
    private showGridLines: boolean = false;
    private lightDirection: vec3 = vec3.fromValues(1, 1, 1);
    
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
        
        // 初始化纹理管理器
        this.textureManager = new TextureManager(device);
        
        // 创建球体几何体（包含法线和UV坐标）
        this.createEnhancedSphereGeometry(device);
        
        // 如果启用网格线，创建网格线几何体
        if (this.showGridLines) {
            this.createGridGeometry(device);
        }
        
        // 创建纹理资源
        await this.createTextures();
        
        // 创建统一缓冲区 (扩展以包含更多数据)
        this.uniformBuffer = device.createBuffer({
            label: "Enhanced Uniform Buffer",
            size: 64 * 3 + 16 + 16 + 16, // 3个mat4 + lightDirection + time + cameraPosition + padding
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        
        // 创建着色器模块
        const shaderModule = device.createShaderModule({
            label: "Enhanced Globe shaders",
            code: GlobeShaders.getVertexShader() + GlobeShaders.getFragmentShader()
        });
        
        // 创建绑定组布局
        const bindGroupLayout = device.createBindGroupLayout({
            label: "Enhanced Globe Bind Group Layout",
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: "uniform" }
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: "float" }
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler: {}
                },
                {
                    binding: 3,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: "float" }
                },
                {
                    binding: 4,
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler: {}
                }
            ]
        });
        
        // 创建管线布局
        const pipelineLayout = device.createPipelineLayout({
            label: "Enhanced Globe Pipeline Layout",
            bindGroupLayouts: [bindGroupLayout]
        });
        
        // 创建绑定组
        this.uniformBindGroup = device.createBindGroup({
            label: "Enhanced Globe Uniform Bind Group",
            layout: bindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: { buffer: this.uniformBuffer }
                },
                {
                    binding: 1,
                    resource: this.earthTexture!.createView()
                },
                {
                    binding: 2,
                    resource: this.earthSampler!
                },
                {
                    binding: 3,
                    resource: this.normalTexture!.createView()
                },
                {
                    binding: 4,
                    resource: this.normalSampler!
                }
            ]
        });
        
        // 创建渲染管线
        this.pipeline = device.createRenderPipeline({
            label: "Enhanced Globe pipeline",
            layout: pipelineLayout,
            vertex: {
                module: shaderModule,
                entryPoint: "vertexMain",
                buffers: [{
                    arrayStride: 32, // 3 * float32 (position) + 3 * float32 (normal) + 2 * float32 (uv)
                    attributes: [
                        {
                            shaderLocation: 0, // position
                            offset: 0,
                            format: "float32x3"
                        },
                        {
                            shaderLocation: 1, // normal
                            offset: 12,
                            format: "float32x3"
                        },
                        {
                            shaderLocation: 2, // uv
                            offset: 24,
                            format: "float32x2"
                        }
                    ]
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
            this.createEnhancedGridPipeline(device, context);
        }
        
        // 初始化深度纹理
        this.updateDepthTexture(device, context);
        
        // 标准化光照方向
        vec3.normalize(this.lightDirection, this.lightDirection);
        
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
     * 创建纹理资源
     */
    private async createTextures(): Promise<void> {
        if (!this.textureManager) return;
        
        // 创建地球纹理
        this.earthTexture = this.textureManager.createDefaultEarthTexture();
        
        // 创建法线贴图
        this.normalTexture = this.textureManager.createDefaultNormalTexture();
        
        // 创建采样器
        this.earthSampler = this.textureManager.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            addressModeU: 'repeat',
            addressModeV: 'clamp-to-edge'
        });
        
        this.normalSampler = this.textureManager.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            addressModeU: 'repeat',
            addressModeV: 'clamp-to-edge'
        });
    }
    
    /**
     * 创建增强的球体几何体（包含法线和UV坐标）
     */
    private createEnhancedSphereGeometry(device: GPUDevice, radius: number = 1.0, segments: number = 64): void {
        const vertices: number[] = [];
        const indices: number[] = [];
        
        // 生成顶点（位置 + 法线 + UV）
        for (let y = 0; y <= segments; y++) {
            const phi = (y / segments) * Math.PI;
            const sinPhi = Math.sin(phi);
            const cosPhi = Math.cos(phi);
            
            for (let x = 0; x <= segments; x++) {
                const theta = (x / segments) * Math.PI * 2;
                const sinTheta = Math.sin(theta);
                const cosTheta = Math.cos(theta);
                
                // 位置
                const px = radius * sinPhi * cosTheta;
                const py = radius * cosPhi;
                const pz = radius * sinPhi * sinTheta;
                
                // 法线（对于球体，法线就是归一化的位置向量）
                const nx = sinPhi * cosTheta;
                const ny = cosPhi;
                const nz = sinPhi * sinTheta;
                
                // UV坐标
                const u = x / segments;
                const v = y / segments;
                
                // 添加顶点数据：位置(3) + 法线(3) + UV(2)
                vertices.push(px, py, pz, nx, ny, nz, u, v);
            }
        }
        
        // 生成索引
        for (let y = 0; y < segments; y++) {
            for (let x = 0; x < segments; x++) {
                const i1 = y * (segments + 1) + x;
                const i2 = i1 + 1;
                const i3 = i1 + (segments + 1);
                const i4 = i3 + 1;
                
                // 避免极点处的退化三角形
                if (y !== 0) {
                    indices.push(i1, i3, i2);
                }
                if (y !== segments - 1) {
                    indices.push(i2, i3, i4);
                }
            }
        }
        
        // 创建顶点缓冲区
        this.vertexBuffer = device.createBuffer({
            label: "Enhanced Sphere vertices",
            size: vertices.length * 4, // float32 = 4 bytes
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        
        // 创建索引缓冲区
        this.indexBuffer = device.createBuffer({
            label: "Enhanced Sphere indices",
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
     * 创建增强的网格线渲染管线
     */
    private createEnhancedGridPipeline(device: GPUDevice, context: GPUCanvasContext): void {
        // 创建网格线着色器模块
        const gridShaderModule = device.createShaderModule({
            label: "Enhanced Grid shaders",
            code: GlobeShaders.getGridVertexShader() + GlobeShaders.getGridFragmentShader()
        });
        
        // 获取绑定组布局（复用主渲染管线的布局）
        const bindGroupLayout = device.createBindGroupLayout({
            label: "Grid Bind Group Layout",
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                buffer: { type: "uniform" }
            }]
        });
        
        // 创建管线布局
        const pipelineLayout = device.createPipelineLayout({
            label: "Enhanced Grid Pipeline Layout",
            bindGroupLayouts: [bindGroupLayout]
        });
        
        // 创建网格线渲染管线
        this.gridPipeline = device.createRenderPipeline({
            label: "Enhanced Grid pipeline",
            layout: pipelineLayout,
            vertex: {
                module: gridShaderModule,
                entryPoint: "vertexMain",
                buffers: [{
                    arrayStride: 12, // 3 * float32 (position only)
                    attributes: [{
                        shaderLocation: 0,
                        offset: 0,
                        format: "float32x3"
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
                cullMode: "none"
            },
            depthStencil: {
                depthWriteEnabled: false, // 网格线不写入深度
                depthCompare: "less-equal",
                format: "depth24plus"
            }
        });
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
        const cameraPosition = this.camera.getPosition();
        
        // 计算时间（用于动画效果）
        const time = Date.now() * 0.001;
        
        // 创建包含所有数据的数组
        const uniformData = new Float32Array(48 + 4 + 4 + 4); // 3*16 + 4 + 4 + 4
        
        // 矩阵数据
        uniformData.set(modelMatrix as Float32Array, 0);
        uniformData.set(viewMatrix as Float32Array, 16);
        uniformData.set(projectionMatrix as Float32Array, 32);
        
        // 光照方向
        uniformData[48] = this.lightDirection[0];
        uniformData[49] = this.lightDirection[1];
        uniformData[50] = this.lightDirection[2];
        uniformData[51] = time; // 时间
        
        // 相机位置
        uniformData[52] = cameraPosition[0];
        uniformData[53] = cameraPosition[1];
        uniformData[54] = cameraPosition[2];
        uniformData[55] = 0.0; // padding
        
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
     * 设置光照方向
     */
    public setLightDirection(x: number, y: number, z: number): void {
        vec3.set(this.lightDirection, x, y, z);
        vec3.normalize(this.lightDirection, this.lightDirection);
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
        
        // 释放纹理管理器资源
        if (this.textureManager) {
            this.textureManager.destroy();
            this.textureManager = null;
        }
        
        // 清空引用
        this.pipeline = null;
        this.gridPipeline = null;
        this.uniformBindGroup = null;
        this.earthTexture = null;
        this.normalTexture = null;
        this.earthSampler = null;
        this.normalSampler = null;
        this.indexCount = 0;
        this.gridIndexCount = 0;
    }
} 