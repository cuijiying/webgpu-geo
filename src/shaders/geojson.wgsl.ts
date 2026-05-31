/**
 * GeoJSON 矢量着色器集合（fill / line / circle）
 *
 * 三个管线共享同一 GlobalUniforms：
 *   viewProj : 相机视图-投影矩阵
 *   params.x : 投影模式（0=mercator 平面，1=globe 球面）
 *   params.y : 视口宽（设备像素）
 *   params.z : 视口高（设备像素）
 *   params.w : devicePixelRatio（把 CSS 像素线宽/半径换算到设备像素）
 *   params2.xyz : globe 模式相机指向的球心方向（视图中心的单位球面向量）
 *   params2.w   : globe 模式 1/相机距球心距离（= 地平线 dot 阈值 cos θ_h）
 *
 * 坐标统一为归一化 Mercator 世界坐标 [0,1]；globe 模式在顶点着色器内
 * 通过 mercator_to_sphere 把世界坐标映射到单位球面，与栅格图层保持一致。
 *
 * globe 背面剔除（关键）：
 *   矢量几何用稀疏顶点构成平面三角/线段，其"弦"会陷入球体内部，
 *   若与精细镶嵌的栅格球面做深度测试会被错误遮挡。因此关闭对栅格的
 *   深度遮挡（depthCompare=always），改在片元着色器按"顶点到视图中心
 *   方向的球面 dot 是否越过地平线"逐像素剔除背面，既避免弦下沉导致的
 *   消失，又能正确隐藏地球背侧的要素。
 */

/** 通用前导：GlobalUniforms + 投影/地平线辅助函数 */
const COMMON = /* wgsl */ `
struct Global {
    viewProj : mat4x4<f32>,
    params   : vec4<f32>,
    params2  : vec4<f32>,
};
@group(0) @binding(0) var<uniform> uGlobal : Global;

const PI : f32 = 3.14159265358979;

fn mercator_to_sphere(world : vec2<f32>) -> vec3<f32> {
    let lng = (world.x - 0.5) * 2.0 * PI;
    let yn  = 1.0 - 2.0 * world.y;
    let s   = (exp(PI * yn) - exp(-PI * yn)) * 0.5;
    let lat = atan(s);
    let cl  = cos(lat);
    return vec3<f32>(cl * sin(lng), sin(lat), cl * cos(lng));
}

/** 世界坐标 → 渲染位置（mercator 平面 z=0；globe 单位球面） */
fn world_to_pos(world : vec2<f32>) -> vec3<f32> {
    if (uGlobal.params.x > 0.5) {
        return mercator_to_sphere(world);
    }
    return vec3<f32>(world, 0.0);
}

fn project(world : vec2<f32>) -> vec4<f32> {
    return uGlobal.viewProj * vec4<f32>(world_to_pos(world), 1.0);
}

/** globe 模式：返回顶点相对视图中心方向的 dot（地平线剔除用）；mercator 恒为 1 */
fn horizon_vis(pos : vec3<f32>) -> f32 {
    if (uGlobal.params.x > 0.5) {
        return dot(pos, uGlobal.params2.xyz);
    }
    return 1.0;
}

/** 是否应被地平线剔除（越过地平线 / 地球背侧） */
fn horizon_cull(vis : f32) -> bool {
    return uGlobal.params.x > 0.5 && vis < uGlobal.params2.w;
}
`;

// ============================================================
// 面填充
// ============================================================
export const FILL_WGSL = COMMON + /* wgsl */ `
struct VsOut {
    @builtin(position) pos   : vec4<f32>,
    @location(0)       color : vec4<f32>,
    @location(1)       vis   : f32,
};

@vertex
fn vs_main(@location(0) inPos : vec2<f32>, @location(1) inColor : vec4<f32>) -> VsOut {
    let p = world_to_pos(inPos);
    var o : VsOut;
    o.pos = uGlobal.viewProj * vec4<f32>(p, 1.0);
    o.color = inColor;
    o.vis = horizon_vis(p);
    return o;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
    if (horizon_cull(in.vis)) { discard; }
    // 预乘 alpha 输出
    return vec4<f32>(in.color.rgb * in.color.a, in.color.a);
}
`;

// ============================================================
// 线（屏幕空间等宽挤出，支持 miter join）
// ============================================================
export const LINE_WGSL = COMMON + /* wgsl */ `
struct VsOut {
    @builtin(position) pos   : vec4<f32>,
    @location(0)       color : vec4<f32>,
    @location(1)       vis   : f32,
};

const EPS : f32 = 0.0001;

@vertex
fn vs_main(
    @location(0) inPos    : vec2<f32>,
    @location(1) inNormal : vec2<f32>,
    @location(2) inColor  : vec4<f32>,
    @location(3) inWidth  : f32,
) -> VsOut {
    let vw = uGlobal.params.y;
    let vh = uGlobal.params.z;
    let halfPx = inWidth * 0.5 * uGlobal.params.w;

    let p0 = world_to_pos(inPos);
    let p1 = world_to_pos(inPos + inNormal * EPS);
    let c0 = uGlobal.viewProj * vec4<f32>(p0, 1.0);
    let c1 = uGlobal.viewProj * vec4<f32>(p1, 1.0);

    // 屏幕空间法向（像素方向）
    let s0 = c0.xy / c0.w;
    let s1 = c1.xy / c1.w;
    var dirPx = (s1 - s0) * vec2<f32>(vw, vh);
    let miter = length(inNormal);
    let dl = length(dirPx);
    if (dl > 1e-6) {
        dirPx = dirPx / dl;
    }
    let offsetPx = dirPx * halfPx * max(miter, 1.0);

    // 像素偏移 → NDC（乘 w 抵消后续透视除法）
    let ndc = offsetPx / vec2<f32>(vw, vh) * 2.0 * c0.w;

    var o : VsOut;
    o.pos = vec4<f32>(c0.xy + ndc, c0.zw);
    o.color = inColor;
    o.vis = horizon_vis(p0);
    return o;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
    if (horizon_cull(in.vis)) { discard; }
    return vec4<f32>(in.color.rgb * in.color.a, in.color.a);
}
`;

// ============================================================
// 点 → 实例化圆（屏幕对齐 billboard，带描边与边缘抗锯齿）
// ============================================================
export const CIRCLE_WGSL = COMMON + /* wgsl */ `
struct VsOut {
    @builtin(position) pos         : vec4<f32>,
    @location(0)       local       : vec2<f32>,  // 像素局部坐标（圆心为原点）
    @location(1)       color       : vec4<f32>,
    @location(2)       strokeColor : vec4<f32>,
    @location(3)       radii       : vec2<f32>,  // x=半径px, y=描边宽px
    @location(4)       vis         : f32,
};

@vertex
fn vs_main(
    @location(0) corner      : vec2<f32>,   // 单位方块角 [-1,1]
    @location(1) center      : vec2<f32>,
    @location(2) color       : vec4<f32>,
    @location(3) radius      : f32,
    @location(4) strokeColor : vec4<f32>,
    @location(5) strokeWidth : f32,
) -> VsOut {
    let vw = uGlobal.params.y;
    let vh = uGlobal.params.z;
    let dpr = uGlobal.params.w;
    let rPx = radius * dpr;
    let swPx = strokeWidth * dpr;
    let extent = rPx + swPx;     // 含描边的外缘半径

    let pc = world_to_pos(center);
    let c0 = uGlobal.viewProj * vec4<f32>(pc, 1.0);
    let offsetPx = corner * extent;
    let ndc = offsetPx / vec2<f32>(vw, vh) * 2.0 * c0.w;

    var o : VsOut;
    o.pos = vec4<f32>(c0.xy + ndc, c0.zw);
    o.local = offsetPx;
    o.color = color;
    o.strokeColor = strokeColor;
    o.radii = vec2<f32>(rPx, swPx);
    o.vis = horizon_vis(pc);
    return o;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
    if (horizon_cull(in.vis)) { discard; }
    let dist = length(in.local);
    let r = in.radii.x;
    let sw = in.radii.y;
    let outer = r + sw;

    // 边缘 1px 抗锯齿
    let aa = 1.0;
    let outerAlpha = 1.0 - smoothstep(outer - aa, outer, dist);
    if (outerAlpha <= 0.0) { discard; }

    var col : vec4<f32>;
    if (sw > 0.0) {
        // 填充 → 描边过渡
        let t = smoothstep(r - aa, r, dist);
        col = mix(in.color, in.strokeColor, t);
    } else {
        col = in.color;
    }
    let a = col.a * outerAlpha;
    return vec4<f32>(col.rgb * a, a);
}
`;
