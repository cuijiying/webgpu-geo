/**
 * 栅格瓦片 WGSL 着色器
 *
 * 渲染思路：
 *   - 每个瓦片用一个 [0,1]×[0,1] 的单位方块表示，顶点缓冲共用
 *   - 通过 per-draw uniform 传入：
 *       worldOffsetSize:  瓦片在世界中的位置 (xy=offset, z=size, w=opacity)
 *       uvOffsetScale:    采样纹理时的 UV 子矩形 (xy=offset, zw=scale)
 *
 * uvOffsetScale 用于支持"父级瓦片回退"：当目标瓦片尚未加载时，
 * 用其祖先瓦片中对应的子区域代替绘制，从而消除缩放/平移期间的黑色空白。
 * 正常瓦片传 (0,0,1,1) 即可。
 */
export const RASTER_TILE_WGSL = /* wgsl */ `
struct GlobalUniforms {
    viewProj: mat4x4<f32>,
};

struct TileUniforms {
    // xy = 瓦片左上角的归一化世界坐标
    // z  = 瓦片世界尺寸（= 1 / 2^zoom）
    // w  = 透明度（0..1）
    worldOffsetSize: vec4<f32>,
    // xy = 纹理 UV 偏移；zw = 纹理 UV 缩放
    uvOffsetScale: vec4<f32>,
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
    let wOff = uTile.worldOffsetSize.xy;
    let wSz  = uTile.worldOffsetSize.z;
    let world = wOff + inUv * wSz;

    let uvOff = uTile.uvOffsetScale.xy;
    let uvScl = uTile.uvOffsetScale.zw;

    var o : VsOut;
    o.pos = uGlobal.viewProj * vec4<f32>(world, 0.0, 1.0);
    o.uv  = uvOff + inUv * uvScl;
    return o;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
    let c = textureSample(uTex, uSamp, in.uv);
    let a = uTile.worldOffsetSize.w;
    // 输入已是 premultiplied alpha；再乘以全局 opacity
    return vec4<f32>(c.rgb * a, c.a * a);
}
`;
