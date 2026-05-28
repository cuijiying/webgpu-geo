/**
 * 栅格瓦片 WGSL 着色器
 *
 * 渲染思路：
 *   - 每个瓦片用一个 [0,1]×[0,1] 的单位方块表示，顶点缓冲共用
 *   - 通过 per-draw uniform 传入 tile 的世界坐标偏移 (offset.xy) 与尺寸 (size)
 *   - 顶点着色器：world = offset + uv * size；clip = viewProj * vec4(world, 0, 1)
 *   - 片元着色器：直接采样瓦片纹理
 *
 * 该 shader 一次只渲染一个瓦片；对于几十~几百个瓦片完全够用。
 * 若未来要进一步提速，可改造为 instanced 渲染（per-instance offset/size buffer）。
 */
export const RASTER_TILE_WGSL = /* wgsl */ `
struct GlobalUniforms {
    viewProj: mat4x4<f32>,
};

struct TileUniforms {
    // x, y: 瓦片左上角的归一化世界坐标
    // z   : 瓦片尺寸（= 1 / 2^zoom）
    // w   : 透明度（0..1），用于淡入
    offsetSizeOpacity: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uGlobal : GlobalUniforms;
@group(1) @binding(0) var<uniform> uTile   : TileUniforms;
@group(1) @binding(1) var          uTex    : texture_2d<f32>;
@group(1) @binding(2) var          uSamp   : sampler;

struct VsOut {
    @builtin(position) pos : vec4<f32>,
    @location(0)       uv  : vec2<f32>,
};

@vertex
fn vs_main(@location(0) inUv : vec2<f32>) -> VsOut {
    let off = uTile.offsetSizeOpacity.xy;
    let sz  = uTile.offsetSizeOpacity.z;
    let world = off + inUv * sz;
    var o : VsOut;
    o.pos = uGlobal.viewProj * vec4<f32>(world, 0.0, 1.0);
    // 纹理 V 轴：图像 (0,0) 在左上，我们的 uv (0,0) 也是左上 → 直接透传
    o.uv  = inUv;
    return o;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
    let c = textureSample(uTex, uSamp, in.uv);
    let a = uTile.offsetSizeOpacity.w;
    return vec4<f32>(c.rgb * a, c.a * a);
}
`;
