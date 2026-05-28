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
    @builtin(position) pos : vec4<f32>,
    @location(0)       uv  : vec2<f32>,
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
    if (uGlobal.flags.x > 0.5) {
        // globe
        let p = mercator_to_sphere(world);
        pos4 = vec4<f32>(p, 1.0);
    } else {
        // mercator
        pos4 = vec4<f32>(world, 0.0, 1.0);
    }

    var o : VsOut;
    o.pos = uGlobal.viewProj * pos4;
    o.uv  = uvOff + inUv * uvScl;
    return o;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
    let c = textureSample(uTex, uSamp, in.uv);
    let a = uTile.worldOffsetSize.w;
    return vec4<f32>(c.rgb * a, c.a * a);
}
`;
