/**
 * glTF 模型着色器（WGSL）
 *
 * 顶点：clipPos = viewProj · model · pos；worldNormal = normalize(normalMat · normal)
 * 片元：方向光 + 环境光（双面光照可选）+ 基色贴图 × 基色因子 + 自发光，
 *       输出 premultiplied alpha；MASK 模式按 alphaCutoff 丢弃。
 *
 * 适用于 mercator 与 globe 两种投影：模型矩阵已把局部米坐标变换到对应引擎空间，
 * 法线矩阵为 inverse-transpose，即便 mercator 左手系下也能给出正确朝外法线。
 */
export const GLTF_WGSL = /* wgsl */`
struct Global {
  viewProj : mat4x4<f32>,
  lightDir : vec4<f32>,   // xyz=指向光源的单位向量（引擎空间），w 未用
  ambient  : vec4<f32>,   // rgb=环境光颜色，w=方向光强度
};

struct DrawData {
  model     : mat4x4<f32>,
  normalMat : mat3x3<f32>,        // 以 3×vec4 上传
  baseColor : vec4<f32>,          // 线性 RGBA 基色因子
  params    : vec4<f32>,          // x=hasTexture, y=alphaCutoff, z=alphaMode(0/1/2), w=doubleSided
  emissive  : vec4<f32>,          // rgb 自发光
};

@group(0) @binding(0) var<uniform> u : Global;
@group(1) @binding(0) var<uniform> d : DrawData;
@group(1) @binding(1) var baseTex : texture_2d<f32>;
@group(1) @binding(2) var baseSamp : sampler;

struct VSOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) normal : vec3<f32>,
  @location(1) uv : vec2<f32>,
};

@vertex
fn vs_main(
  @location(0) position : vec3<f32>,
  @location(1) normal : vec3<f32>,
  @location(2) uv : vec2<f32>,
) -> VSOut {
  var out : VSOut;
  let world = d.model * vec4<f32>(position, 1.0);
  out.clip = u.viewProj * world;
  out.normal = normalize(d.normalMat * normal);
  out.uv = uv;
  return out;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  var color = d.baseColor;
  if (d.params.x > 0.5) {
    color = color * textureSample(baseTex, baseSamp, in.uv);
  }

  // alpha 模式
  let alphaMode = d.params.z;
  var alpha = color.a;
  if (alphaMode < 0.5) {
    alpha = 1.0;                 // OPAQUE
  } else if (alphaMode < 1.5) {
    if (alpha < d.params.y) { discard; }  // MASK
    alpha = 1.0;
  }

  // 光照
  let N = normalize(in.normal);
  let L = normalize(u.lightDir.xyz);
  var ndl = dot(N, L);
  if (d.params.w > 0.5) { ndl = abs(ndl); } else { ndl = max(ndl, 0.0); }
  let intensity = u.ambient.w;
  let lit = u.ambient.rgb + vec3<f32>(intensity) * ndl;

  var rgb = color.rgb * lit + d.emissive.rgb;
  rgb = rgb * alpha;            // premultiplied alpha 输出
  return vec4<f32>(rgb, alpha);
}
`;
