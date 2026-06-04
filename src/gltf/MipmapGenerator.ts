/**
 * MipmapGenerator —— 基于渲染的 mipmap 生成器
 *
 * WebGPU 没有内置 generateMipmap，这里用「全屏三角形 + 线性采样上一层」逐级降采样。
 * 管线按纹理格式缓存，可对多张纹理复用。仅支持可作为渲染目标、可采样的 2D 格式
 * （如 rgba8unorm / rgba8unorm-srgb）。
 */
export class MipmapGenerator {
    private _device: GPUDevice;
    private _sampler: GPUSampler;
    private _pipelines = new Map<GPUTextureFormat, GPURenderPipeline>();
    private _module?: GPUShaderModule;

    constructor(device: GPUDevice) {
        this._device = device;
        this._sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    }

    /** 计算给定尺寸的完整 mip 链层数 */
    static mipLevelCount(width: number, height: number): number {
        return 1 + Math.floor(Math.log2(Math.max(width, height)));
    }

    private _pipeline(format: GPUTextureFormat): GPURenderPipeline {
        let p = this._pipelines.get(format);
        if (p) return p;
        if (!this._module) {
            this._module = this._device.createShaderModule({
                label: 'mipmap-blit',
                code: /* wgsl */`
struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  var p = array<vec2<f32>,3>(vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));
  var out: VSOut;
  let xy = p[vi];
  out.pos = vec4(xy, 0.0, 1.0);
  out.uv = vec2((xy.x + 1.0) * 0.5, (1.0 - xy.y) * 0.5);
  return out;
}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@fragment fn fs(in: VSOut) -> @location(0) vec4<f32> {
  return textureSample(src, smp, in.uv);
}`,
            });
        }
        p = this._device.createRenderPipeline({
            label: `mipmap-pipeline-${format}`,
            layout: 'auto',
            vertex: { module: this._module, entryPoint: 'vs' },
            fragment: { module: this._module, entryPoint: 'fs', targets: [{ format }] },
            primitive: { topology: 'triangle-list' },
        });
        this._pipelines.set(format, p);
        return p;
    }

    /**
     * 为已写入 level 0 的纹理生成其余 mip 层。
     * @param texture     mipLevelCount > 1 且带 RENDER_ATTACHMENT|TEXTURE_BINDING 用途的纹理
     * @param format      纹理格式
     * @param baseWidth   level 0 宽
     * @param baseHeight  level 0 高
     * @param mipCount    总层数
     */
    generate(
        texture: GPUTexture, format: GPUTextureFormat,
        baseWidth: number, baseHeight: number, mipCount: number,
    ): void {
        if (mipCount <= 1) return;
        const pipeline = this._pipeline(format);
        const encoder = this._device.createCommandEncoder({ label: 'mipmap-encoder' });
        let w = baseWidth, h = baseHeight;
        for (let level = 1; level < mipCount; level++) {
            w = Math.max(1, w >> 1);
            h = Math.max(1, h >> 1);
            const srcView = texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 });
            const dstView = texture.createView({ baseMipLevel: level, mipLevelCount: 1 });
            const bindGroup = this._device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: srcView },
                    { binding: 1, resource: this._sampler },
                ],
            });
            const pass = encoder.beginRenderPass({
                colorAttachments: [{ view: dstView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
            });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bindGroup);
            pass.draw(3);
            pass.end();
        }
        this._device.queue.submit([encoder.finish()]);
    }
}
