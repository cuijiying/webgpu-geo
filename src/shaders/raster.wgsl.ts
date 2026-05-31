/**
 * 栅格瓦片 WGSL 着色器（同时支持 mercator 平面投影 与 globe 球面投影）
 *
 * 顶点输入：单位方块 [0,1]×[0,1] 的细分网格（mercator 也兼容）
 *
 * Per-tile uniform：
 *   worldOffsetSize: xy=瓦片左上角归一化世界坐标，z=瓦片世界尺寸，w=透明度
 *   uvOffsetScale:   xy=纹理 UV 偏移，zw=UV 缩放（用于父级回退子矩形采样）
 *
 * Global uniform：
 *   viewProj:        相机的视图-投影矩阵
 *   projectionMode:  0 = mercator（平面），1 = globe（球面）
 *
 * Globe 投影：把每个顶点的 (worldX, worldY) 反算为 (lng, lat)，再映射到单位球面：
 *   lng = (worldX - 0.5) * 2π
 *   lat = atan(sinh(π * (1 - 2*worldY)))     // 反 Web Mercator
 *   pos = ( cos(lat)*sin(lng),  sin(lat),  cos(lat)*cos(lng) )
 *
 * 反过来再被 viewProj 投到裁剪空间。
 */
export const RASTER_TILE_WGSL = /* wgsl */ `
struct GlobalUniforms {
    viewProj: mat4x4<f32>,
    // x = projectionMode (0=mercator, 1=globe), yzw = 预留
    flags: vec4<f32>,
    // globe 模式：相机在基础球面空间中的位置（xyz），w 预留。用于地平线解析抗锯齿。
    eye: vec4<f32>,
};

struct TileUniforms {
    worldOffsetSize: vec4<f32>,
    uvOffsetScale:   vec4<f32>,
};

@group(0) @binding(0) var<uniform> uGlobal : GlobalUniforms;
@group(1) @binding(0) var<uniform> uTile   : TileUniforms;
@group(1) @binding(1) var          uTex    : texture_2d<f32>;
@group(1) @binding(2) var          uSamp   : sampler;

struct VsOut {
    @builtin(position) pos    : vec4<f32>,
    @location(0)       uv     : vec2<f32>,
    // globe 模式下顶点对应的单位球面坐标（mercator 下为 0）
    @location(1)       sphere : vec3<f32>,
};

const PI : f32 = 3.14159265358979;

fn mercator_to_sphere(world: vec2<f32>) -> vec3<f32> {
    let lng = (world.x - 0.5) * 2.0 * PI;
    let yn  = 1.0 - 2.0 * world.y;
    // sinh(x) = (e^x - e^-x) / 2
    let s   = (exp(PI * yn) - exp(-PI * yn)) * 0.5;
    let lat = atan(s);
    let cl  = cos(lat);
    return vec3<f32>(cl * sin(lng), sin(lat), cl * cos(lng));
}

@vertex
fn vs_main(@location(0) inUv : vec2<f32>) -> VsOut {
    let wOff  = uTile.worldOffsetSize.xy;
    let wSz   = uTile.worldOffsetSize.z;
    let world = wOff + inUv * wSz;

    let uvOff = uTile.uvOffsetScale.xy;
    let uvScl = uTile.uvOffsetScale.zw;

    var pos4 : vec4<f32>;
    var sphere = vec3<f32>(0.0, 0.0, 0.0);
    if (uGlobal.flags.x > 0.5) {
        // globe
        sphere = mercator_to_sphere(world);
        pos4 = vec4<f32>(sphere, 1.0);
    } else {
        // mercator
        pos4 = vec4<f32>(world, 0.0, 1.0);
    }

    var o : VsOut;
    o.pos    = uGlobal.viewProj * pos4;
    o.uv     = uvOff + inUv * uvScl;
    o.sphere = sphere;
    return o;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
    let c = textureSample(uTex, uSamp, in.uv);
    var a = uTile.worldOffsetSize.w;

    // globe：按真实地平线做解析覆盖抗锯齿。
    // 单位球(半径1)被距球心 |eye| 的相机观察时，可见地平线满足 dot(p, eye) = 1：
    //   h > 0 → 近侧可见半球；h < 0 → 被地平线遮挡的背侧。
    // 用屏幕空间导数 fwidth(h) 把硬边界软化为约 1 像素宽的解析边缘，
    // 从而消除镶嵌三角形/背面剔除在球体轮廓处产生的锯齿（MSAA 无法覆盖的几何走样）。
    if (uGlobal.flags.x > 0.5) {
        // in.sphere 是逐片元插值得到的球面点，在三角形内部会沿弦收缩（|in.sphere|<1）。
        // 高缩放时回退父级（大三角形）瓦片的收缩量(≈α²/8)远大于此时极小的地平线余量
        // r=|eye|-1（z14 仅约 4.5e-5），若直接用 dot(in.sphere,eye)-1 会把可见的近侧
        // 片元误判为背侧而整体丢弃，导致球体底部「空洞」。故先归一化方向；
        // 并改用 dot(S, eye-S) 代替 dot(S,eye)-1，避免两个≈1的数相减带来的灾难性抵消。
        let S = normalize(in.sphere);
        let h = dot(S, uGlobal.eye.xyz - S);
        let aa = clamp(h / fwidth(h) + 0.5, 0.0, 1.0);
        // 越过地平线的背侧片元（aa≈0）直接丢弃，避免它们在掠射角下覆盖/擦除
        // 前侧已绘制的瓦片，导致球体底部出现空洞。仍保留 (0,1] 的解析覆盖淡出，
        // 使可见轮廓保持约 1 像素的平滑边缘。
        if (aa <= 0.0) { discard; }
        a = a * aa;
    }

    return vec4<f32>(c.rgb * a, c.a * a);
}
`;
