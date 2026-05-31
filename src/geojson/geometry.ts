import { Mercator } from '../geo/Mercator';
import { earcut } from './earcut';
import type { RGBA } from './color';
import type { Feature, Position } from './types';

/**
 * 几何构建：将规范化要素转换为可直接上传 GPU 的顶点 / 索引数据。
 *
 * 所有坐标在此从经纬度投影到归一化 Mercator 世界坐标 [0,1]，
 * 与栅格图层共享同一坐标系，从而天然支持 mercator / globe 两种投影
 * （globe 的球面映射在顶点着色器内完成）。
 */

export interface Mesh {
    /** 交错顶点数组 */
    vertices: Float32Array;
    /** 三角形索引 */
    indices: Uint32Array;
}

/** 每要素样式取值回调 */
export type FillStyleFn = (f: Feature, index: number) => RGBA;
export type LineStyleFn = (f: Feature, index: number) => { color: RGBA; width: number };
export type CircleStyleFn = (f: Feature, index: number) => {
    color: RGBA; radius: number; strokeColor: RGBA; strokeWidth: number;
};

const toWorld = (p: Position): [number, number] => {
    const w = Mercator.lngLatToWorld({ lng: p[0], lat: p[1] });
    return [w.x, w.y];
};

// ============================================================
// 面填充（Polygon / MultiPolygon）
// 顶点布局：x, y, r, g, b, a  → 6 floats / vertex
// ============================================================
export const FILL_FLOATS = 6;

export function buildFillMesh(features: Feature[], style: FillStyleFn): Mesh {
    const verts: number[] = [];
    const indices: number[] = [];

    for (let fi = 0; fi < features.length; fi++) {
        const f = features[fi];
        const g = f.geometry;
        if (!g) continue;
        const polygons: Position[][][] =
            g.type === 'Polygon' ? [g.coordinates] :
            g.type === 'MultiPolygon' ? g.coordinates : [];
        if (polygons.length === 0) continue;

        const [r, gg, b, a] = style(f, fi);

        for (const rings of polygons) {
            // 扁平化外环 + 洞，记录洞起始顶点索引
            const flat: number[] = [];
            const holeIndices: number[] = [];
            for (let ri = 0; ri < rings.length; ri++) {
                if (ri > 0) holeIndices.push(flat.length / 2);
                for (const pt of rings[ri]) {
                    const w = toWorld(pt);
                    flat.push(w[0], w[1]);
                }
            }
            if (flat.length < 6) continue;

            const baseVertex = verts.length / FILL_FLOATS;
            const tri = earcut(flat, holeIndices, 2);
            for (let i = 0; i < flat.length; i += 2) {
                verts.push(flat[i], flat[i + 1], r, gg, b, a);
            }
            for (const idx of tri) indices.push(baseVertex + idx);
        }
    }

    return {
        vertices: new Float32Array(verts),
        indices: new Uint32Array(indices),
    };
}

// ============================================================
// 线（LineString / MultiLineString，以及可选的多边形描边）
// 顶点布局：x, y, nx, ny, r, g, b, a, width → 9 floats / vertex
// nx,ny 为带 miter 缩放的世界空间法向量，width 为整体线宽（像素）
// ============================================================
export const LINE_FLOATS = 9;

/** 收集要素中的线状路径（含可选的多边形边界） */
function collectLines(f: Feature, includePolygonRings: boolean): Position[][] {
    const g = f.geometry;
    if (!g) return [];
    switch (g.type) {
        case 'LineString': return [g.coordinates];
        case 'MultiLineString': return g.coordinates;
        case 'Polygon': return includePolygonRings ? g.coordinates : [];
        case 'MultiPolygon': return includePolygonRings ? g.coordinates.flat() : [];
        default: return [];
    }
}

export function buildLineMesh(
    features: Feature[],
    style: LineStyleFn,
    includePolygonRings: boolean,
): Mesh {
    const verts: number[] = [];
    const indices: number[] = [];

    for (let fi = 0; fi < features.length; fi++) {
        const f = features[fi];
        const paths = collectLines(f, includePolygonRings);
        if (paths.length === 0) continue;
        const { color, width } = style(f, fi);
        if (width <= 0) continue;

        for (const path of paths) {
            // 投影并去除重复相邻点
            const pts: [number, number][] = [];
            for (const p of path) {
                const w = toWorld(p);
                const last = pts[pts.length - 1];
                if (!last || last[0] !== w[0] || last[1] !== w[1]) pts.push(w);
            }
            if (pts.length < 2) continue;

            emitPolyline(pts, color, width, verts, indices);
        }
    }

    return {
        vertices: new Float32Array(verts),
        indices: new Uint32Array(indices),
    };
}

/** 用 miter join 把折线展开为三角带 */
function emitPolyline(
    pts: [number, number][],
    color: RGBA,
    width: number,
    verts: number[],
    indices: number[],
): void {
    const n = pts.length;
    const [r, g, b, a] = color;

    // 逐点法向量（带 miter 缩放）
    const normals: [number, number][] = new Array(n);
    const segNormal = (i: number): [number, number] => {
        const dx = pts[i + 1][0] - pts[i][0];
        const dy = pts[i + 1][1] - pts[i][1];
        const len = Math.hypot(dx, dy) || 1;
        return [-dy / len, dx / len]; // 左法线
    };

    for (let i = 0; i < n; i++) {
        if (i === 0) {
            normals[i] = segNormal(0);
        } else if (i === n - 1) {
            normals[i] = segNormal(n - 2);
        } else {
            const a0 = segNormal(i - 1);
            const a1 = segNormal(i);
            let mx = a0[0] + a1[0];
            let my = a0[1] + a1[1];
            const mlen = Math.hypot(mx, my) || 1;
            mx /= mlen; my /= mlen;
            // miter 长度 = 1/cos(theta/2)，并做上限钳制避免尖角处过冲
            const dot = mx * a1[0] + my * a1[1];
            const scale = Math.min(1 / Math.max(0.1, dot), 4);
            normals[i] = [mx * scale, my * scale];
        }
    }

    const baseVertex = verts.length / LINE_FLOATS;
    for (let i = 0; i < n; i++) {
        const [px, py] = pts[i];
        const [nx, ny] = normals[i];
        // 上下两个挤出顶点（+normal / -normal）
        verts.push(px, py, nx, ny, r, g, b, a, width);
        verts.push(px, py, -nx, -ny, r, g, b, a, width);
    }
    for (let i = 0; i < n - 1; i++) {
        const v = baseVertex + i * 2;
        // 四个顶点：v(上) v+1(下) v+2(下一上) v+3(下一下)
        indices.push(v, v + 1, v + 2);
        indices.push(v + 2, v + 1, v + 3);
    }
}

// ============================================================
// 点（Point / MultiPoint）→ 实例化圆
// 每实例布局：cx, cy, r, g, b, a, radius, sr, sg, sb, sa, strokeWidth → 12 floats
// ============================================================
export const CIRCLE_FLOATS = 12;

export function buildCircleInstances(features: Feature[], style: CircleStyleFn): Float32Array {
    const data: number[] = [];

    for (let fi = 0; fi < features.length; fi++) {
        const f = features[fi];
        const g = f.geometry;
        if (!g) continue;
        const points: Position[] =
            g.type === 'Point' ? [g.coordinates] :
            g.type === 'MultiPoint' ? g.coordinates : [];
        if (points.length === 0) continue;

        const s = style(f, fi);
        for (const p of points) {
            const w = toWorld(p);
            data.push(
                w[0], w[1],
                s.color[0], s.color[1], s.color[2], s.color[3],
                s.radius,
                s.strokeColor[0], s.strokeColor[1], s.strokeColor[2], s.strokeColor[3],
                s.strokeWidth,
            );
        }
    }

    return new Float32Array(data);
}
