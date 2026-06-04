/**
 * glTF 模型地理放置
 *
 * 把一个以「米」为单位、局部坐标系（默认 glTF 的 Y-up）的模型，放置到地球上
 * 指定的经纬度 / 高度，并按 heading / pitch / roll 定向。产出一个 4×4 模型矩阵
 * `model`（局部米 → 引擎空间）与对应的法线矩阵 `normal`，供着色器使用：
 *
 *   clipPos     = camera.viewProj * model * vec4(localPos, 1)
 *   worldNormal = normalize(normal * localNormal)
 *
 * ── 引擎空间约定 ──
 *   globe   ：基础球面空间（单位球，model 旋转之前；见 Camera.worldToSphere）
 *             +Y=北极，+Z=(0°,0°)，+X=(90°E,0°)。
 *   mercator：归一化世界平面 [0,1]²，+x=东，+y=南，+z=高度（垂直地面）。
 *
 * 局部坐标轴映射（ENU / 站心坐标）：
 *   localX → 东(East)，localY → 上(Up)，localZ → 南(South)
 *   即 glTF 默认 -Z（前方）指向北，符合直觉。
 */
import { mat4, mat3, glMatrix } from 'gl-matrix';
import { Mercator } from '../geo/Mercator';

glMatrix.setMatrixArrayType(Array); // 用 number[]（float64）做高精度中间计算

/** WGS84 长半轴（赤道半径，米） */
export const WGS84_A = 6378137.0;
/** WGS84 短半轴（极半径，米） */
export const WGS84_B = 6356752.314245179;
/** WGS84 第一偏心率平方 */
export const WGS84_E2 = 1 - (WGS84_B * WGS84_B) / (WGS84_A * WGS84_A);

/** 经纬度（度）+ 椭球高（米）→ ECEF（米），写入 out[0..2] */
export function lngLatHeightToEcef(out: number[], lngDeg: number, latDeg: number, height: number): void {
    const lng = (lngDeg * Math.PI) / 180;
    const lat = (latDeg * Math.PI) / 180;
    const cosLat = Math.cos(lat);
    const sinLat = Math.sin(lat);
    const cosLng = Math.cos(lng);
    const sinLng = Math.sin(lng);
    const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    out[0] = (N + height) * cosLat * cosLng;
    out[1] = (N + height) * cosLat * sinLng;
    out[2] = (N * (1 - WGS84_E2) + height) * sinLat;
}

/** 模型放置参数 */
export interface PlacementParams {
    /** 经度（度） */
    lng: number;
    /** 纬度（度） */
    lat: number;
    /** 椭球高 / 离地高度（米），默认 0 */
    altitude?: number;
    /** 偏航角 heading（度，绕本地“上”轴，0=面向北，顺时针为正），默认 0 */
    heading?: number;
    /** 俯仰角 pitch（度，绕本地“东”轴），默认 0 */
    pitch?: number;
    /** 翻滚角 roll（度，绕本地“前”轴），默认 0 */
    roll?: number;
    /** 统一缩放或三轴缩放（默认 1）。注意非均匀缩放会经法线矩阵正确处理 */
    scale?: number | [number, number, number];
}

/** 放置矩阵输出（写入 GPU uniform 用，float32） */
export interface PlacementMatrices {
    /** 4×4 模型矩阵：局部米 → 引擎空间（列主序，16 元） */
    model: Float32Array;
    /** 法线矩阵 = inverse-transpose(model 3×3)，按 WGSL mat3x3 布局填充为 3×vec4（12 元） */
    normal: Float32Array;
}

// 复用的中间量，避免每次分配
const _ecef: number[] = [0, 0, 0];
const _basis = mat4.create();
const _hpr = mat4.create();
const _model64 = mat4.create();
const _normal64 = mat3.create();

/** ECEF（米）→ 引擎基础球面空间 的线性映射矩阵：(x,y,z) → (y,z,x)/A（列主序） */
const ECEF_TO_ENGINE = mat4.fromValues(
    0, 0, 1 / WGS84_A, 0,
    1 / WGS84_A, 0, 0, 0,
    0, 1 / WGS84_A, 0, 0,
    0, 0, 0, 1,
);

function applyHprScale(m: mat4, p: PlacementParams): void {
    const heading = ((p.heading ?? 0) * Math.PI) / 180;
    const pitch = ((p.pitch ?? 0) * Math.PI) / 180;
    const roll = ((p.roll ?? 0) * Math.PI) / 180;
    mat4.identity(_hpr);
    mat4.rotateY(_hpr, _hpr, heading); // 绕“上”
    mat4.rotateX(_hpr, _hpr, pitch);   // 绕“东”
    mat4.rotateZ(_hpr, _hpr, roll);    // 绕“前”
    mat4.multiply(m, m, _hpr);
    const s = p.scale ?? 1;
    if (typeof s === 'number') mat4.scale(m, m, [s, s, s]);
    else mat4.scale(m, m, s);
}

function finalize(out: PlacementMatrices): void {
    // 法线矩阵 = inverse-transpose(model 3×3)
    mat3.normalFromMat4(_normal64, _model64);
    // 写出 float32
    for (let i = 0; i < 16; i++) out.model[i] = _model64[i];
    // mat3x3 → 3×vec4（列对齐到 16 字节）
    out.normal[0] = _normal64[0]; out.normal[1] = _normal64[1]; out.normal[2] = _normal64[2]; out.normal[3] = 0;
    out.normal[4] = _normal64[3]; out.normal[5] = _normal64[4]; out.normal[6] = _normal64[5]; out.normal[7] = 0;
    out.normal[8] = _normal64[6]; out.normal[9] = _normal64[7]; out.normal[10] = _normal64[8]; out.normal[11] = 0;
}

/** globe 模式：局部米 → 基础球面空间 */
export function buildPlacementGlobe(p: PlacementParams, out: PlacementMatrices): void {
    lngLatHeightToEcef(_ecef, p.lng, p.lat, p.altitude ?? 0);
    const lng = (p.lng * Math.PI) / 180;
    const lat = (p.lat * Math.PI) / 180;
    const cl = Math.cos(lat), sl = Math.sin(lat), co = Math.cos(lng), so = Math.sin(lng);
    // 站心 ENU 基向量（ECEF）
    const eastX = -so, eastY = co, eastZ = 0;
    const upX = cl * co, upY = cl * so, upZ = sl;
    const northX = -sl * co, northY = -sl * so, northZ = cl;
    // basis: 列 = [east, up, -north(=south)]，平移 = ecef 锚点
    mat4.set(_basis,
        eastX, eastY, eastZ, 0,
        upX, upY, upZ, 0,
        -northX, -northY, -northZ, 0,
        _ecef[0], _ecef[1], _ecef[2], 1,
    );
    applyHprScale(_basis, p);
    // engine = (ECEF→engine) × basis
    mat4.multiply(_model64, ECEF_TO_ENGINE, _basis);
    finalize(out);
}

/** mercator 模式：局部米 → 归一化世界平面（+z=高度） */
export function buildPlacementMercator(p: PlacementParams, out: PlacementMatrices): void {
    const w = Mercator.lngLatToWorld({ lng: p.lng, lat: p.lat });
    const lat = (p.lat * Math.PI) / 180;
    const cosLat = Math.max(1e-6, Math.cos(lat));
    // 1 米对应多少“世界单位”：赤道整圈 = 1 世界单位 = 2πA·cosLat 米（墨卡托保角，各向同性）
    const k = 1 / (2 * Math.PI * WGS84_A * cosLat);
    const altWorld = (p.altitude ?? 0) * k;
    // 局部→世界：east→(+x), up→(+z), south→(+y)，统一乘 k
    mat4.set(_basis,
        k, 0, 0, 0,
        0, 0, k, 0,
        0, k, 0, 0,
        w.x, w.y, altWorld, 1,
    );
    applyHprScale(_basis, p);
    mat4.copy(_model64, _basis);
    finalize(out);
}
