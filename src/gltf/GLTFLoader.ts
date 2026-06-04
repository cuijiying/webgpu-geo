/**
 * GLTFLoader —— glTF 2.0 / glb 解析器
 *
 * 输出与 GPU 无关的 {@link ParsedModel}：把场景节点层级的变换烘焙进顶点，
 * 每个图元产出交错顶点缓冲（position+normal+uv）+ uint32 索引 + 材质（基色 + 基色贴图）。
 *
 * 支持：
 *   · .glb（二进制容器，JSON + BIN chunk）与 .gltf（外部/内嵌 base64 buffer、外部/内嵌图片）
 *   · TRIANGLES / TRIANGLE_STRIP / TRIANGLE_FAN
 *   · 缺失法线时按面法线自动生成
 *   · 节点 TRS / matrix 层级变换烘焙
 *   · pbrMetallicRoughness.baseColorFactor + baseColorTexture、alphaMode、doubleSided、emissiveFactor
 *
 * 不支持（v1，遇到时给出明确报错或忽略）：
 *   · KHR_draco_mesh_compression / EXT_meshopt_compression（压缩几何）
 *   · KTX2 / basis 纹理、骨骼蒙皮动画、morph target
 */
import { mat4, mat3, quat } from 'gl-matrix';
import {
    ComponentType, PrimitiveMode,
    type GltfDocument, type GltfAccessor, type GltfNode,
    type ParsedModel, type ParsedPrimitive,
} from './gltf-types';

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

export interface GltfLoadOptions {
    /** 透传给 fetch 的选项（headers / mode / credentials 等） */
    fetchInit?: RequestInit;
    /** 取消信号 */
    signal?: AbortSignal;
}

/** 加载并解析 glTF/glb，返回烘焙后的模型数据 */
export async function loadGltf(url: string, opts: GltfLoadOptions = {}): Promise<ParsedModel> {
    const res = await fetch(url, { ...opts.fetchInit, signal: opts.signal });
    if (!res.ok) throw new Error(`[gltf] 加载失败 ${res.status} ${res.statusText}: ${url}`);
    const buf = await res.arrayBuffer();
    const parser = new GltfParser(url, opts);
    await parser.init(buf);
    return parser.build();
}

class GltfParser {
    private _doc!: GltfDocument;
    private _bin?: Uint8Array; // glb BIN chunk
    private _buffers: (Uint8Array | undefined)[] = [];
    private _imageCache = new Map<number, Promise<ImageBitmap | undefined>>();
    private _baseUrl: string;
    private _opts: GltfLoadOptions;

    constructor(url: string, opts: GltfLoadOptions) {
        // 资源相对路径基准
        this._baseUrl = url.slice(0, url.lastIndexOf('/') + 1);
        this._opts = opts;
    }

    async init(buf: ArrayBuffer): Promise<void> {
        const view = new DataView(buf);
        if (view.byteLength >= 12 && view.getUint32(0, true) === GLB_MAGIC) {
            this._parseGlb(buf, view);
        } else {
            const text = new TextDecoder().decode(buf);
            this._doc = JSON.parse(text) as GltfDocument;
        }
        this._checkUnsupported();
        await this._resolveBuffers();
    }

    private _parseGlb(buf: ArrayBuffer, view: DataView): void {
        const version = view.getUint32(4, true);
        if (version !== 2) throw new Error(`[gltf] 不支持的 glb 版本 ${version}`);
        const total = view.getUint32(8, true);
        let offset = 12;
        let json: GltfDocument | undefined;
        while (offset < total) {
            const chunkLen = view.getUint32(offset, true);
            const chunkType = view.getUint32(offset + 4, true);
            const dataStart = offset + 8;
            if (chunkType === CHUNK_JSON) {
                const text = new TextDecoder().decode(new Uint8Array(buf, dataStart, chunkLen));
                json = JSON.parse(text) as GltfDocument;
            } else if (chunkType === CHUNK_BIN) {
                this._bin = new Uint8Array(buf, dataStart, chunkLen);
            }
            offset = dataStart + chunkLen + ((chunkLen % 4) ? 4 - (chunkLen % 4) : 0);
        }
        if (!json) throw new Error('[gltf] glb 缺少 JSON chunk');
        this._doc = json;
    }

    private _checkUnsupported(): void {
        const required = this._doc.extensionsRequired ?? [];
        const blocked = required.filter((e) =>
            e === 'KHR_draco_mesh_compression' || e === 'EXT_meshopt_compression');
        if (blocked.length) {
            throw new Error(`[gltf] 暂不支持压缩几何扩展：${blocked.join(', ')}（请使用未压缩的 glTF/glb）`);
        }
    }

    private async _resolveBuffers(): Promise<void> {
        const buffers = this._doc.buffers ?? [];
        this._buffers = await Promise.all(buffers.map(async (b) => {
            if (!b.uri) return this._bin; // glb 主缓冲
            if (b.uri.startsWith('data:')) return decodeDataUri(b.uri);
            const res = await fetch(this._baseUrl + b.uri, { ...this._opts.fetchInit, signal: this._opts.signal });
            if (!res.ok) throw new Error(`[gltf] buffer 加载失败: ${b.uri}`);
            return new Uint8Array(await res.arrayBuffer());
        }));
    }

    // ====================== accessor 读取 ======================

    /** 读取 accessor 为 Float32Array（应用 normalized 归一化） */
    private _readFloat(accessorIndex: number): Float32Array {
        const acc = this._accessor(accessorIndex);
        const ncomp = numComponents(acc.type);
        const out = new Float32Array(acc.count * ncomp);
        if (acc.bufferView === undefined) return out; // 稀疏/空 accessor → 全 0
        const bv = this._doc.bufferViews![acc.bufferView];
        const data = this._buffers[bv.buffer];
        if (!data) throw new Error(`[gltf] 缺少 buffer ${bv.buffer}`);
        const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
        const compSize = componentByteSize(acc.componentType);
        const stride = bv.byteStride ?? compSize * ncomp;
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const norm = acc.normalized ?? false;
        for (let i = 0; i < acc.count; i++) {
            const elemOff = base + i * stride;
            for (let c = 0; c < ncomp; c++) {
                const off = elemOff + c * compSize;
                out[i * ncomp + c] = readComponent(dv, off, acc.componentType, norm);
            }
        }
        return out;
    }

    /** 读取索引 accessor 为 Uint32Array */
    private _readIndices(accessorIndex: number): Uint32Array {
        const acc = this._accessor(accessorIndex);
        const out = new Uint32Array(acc.count);
        if (acc.bufferView === undefined) return out;
        const bv = this._doc.bufferViews![acc.bufferView];
        const data = this._buffers[bv.buffer]!;
        const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
        const compSize = componentByteSize(acc.componentType);
        const stride = bv.byteStride ?? compSize;
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        for (let i = 0; i < acc.count; i++) {
            const off = base + i * stride;
            out[i] = readComponent(dv, off, acc.componentType, false);
        }
        return out;
    }

    private _accessor(i: number): GltfAccessor {
        const acc = this._doc.accessors?.[i];
        if (!acc) throw new Error(`[gltf] 缺少 accessor ${i}`);
        return acc;
    }

    // ====================== 图片 ======================

    private _loadImage(imageIndex: number): Promise<ImageBitmap | undefined> {
        let p = this._imageCache.get(imageIndex);
        if (p) return p;
        p = this._decodeImage(imageIndex);
        this._imageCache.set(imageIndex, p);
        return p;
    }

    private async _decodeImage(imageIndex: number): Promise<ImageBitmap | undefined> {
        const img = this._doc.images?.[imageIndex];
        if (!img) return undefined;
        let blob: Blob;
        try {
            if (img.bufferView !== undefined) {
                const bv = this._doc.bufferViews![img.bufferView];
                const data = this._buffers[bv.buffer]!;
                const start = data.byteOffset + (bv.byteOffset ?? 0);
                const bytes = new Uint8Array(data.buffer, start, bv.byteLength);
                blob = new Blob([bytes], { type: img.mimeType ?? 'image/png' });
            } else if (img.uri?.startsWith('data:')) {
                const bytes = decodeDataUri(img.uri);
                blob = new Blob([bytes], { type: mimeFromDataUri(img.uri) });
            } else if (img.uri) {
                const res = await fetch(this._baseUrl + img.uri, { ...this._opts.fetchInit, signal: this._opts.signal });
                blob = await res.blob();
            } else {
                return undefined;
            }
            return await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
        } catch (e) {
            console.warn('[gltf] 图片解码失败，使用基色因子替代:', e);
            return undefined;
        }
    }

    // ====================== 场景遍历 + 烘焙 ======================

    async build(): Promise<ParsedModel> {
        const sceneIndex = this._doc.scene ?? 0;
        const scene = this._doc.scenes?.[sceneIndex];
        const roots = scene?.nodes ?? (this._doc.nodes ? this._doc.nodes.map((_, i) => i) : []);

        const primitives: ParsedPrimitive[] = [];
        const min: [number, number, number] = [Infinity, Infinity, Infinity];
        const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

        const tasks: Promise<void>[] = [];
        const visit = (nodeIndex: number, parent: mat4) => {
            const node = this._doc.nodes![nodeIndex];
            const local = nodeMatrix(node);
            const world = mat4.create();
            mat4.multiply(world, parent, local);
            if (node.mesh !== undefined) {
                tasks.push(this._bakeMesh(node.mesh, world, primitives, min, max));
            }
            for (const child of node.children ?? []) visit(child, world);
        };
        const ident = mat4.create();
        for (const r of roots) visit(r, ident);

        await Promise.all(tasks);

        if (!isFinite(min[0])) { min[0] = min[1] = min[2] = 0; max[0] = max[1] = max[2] = 0; }
        return { primitives, min, max };
    }

    private async _bakeMesh(
        meshIndex: number, world: mat4,
        out: ParsedPrimitive[],
        min: [number, number, number], max: [number, number, number],
    ): Promise<void> {
        const mesh = this._doc.meshes?.[meshIndex];
        if (!mesh) return;
        // 法线矩阵（节点）
        const normalMat = mat3.create();
        mat3.normalFromMat4(normalMat, world);

        for (const prim of mesh.primitives) {
            const mode = prim.mode ?? PrimitiveMode.TRIANGLES;
            if (mode !== PrimitiveMode.TRIANGLES
                && mode !== PrimitiveMode.TRIANGLE_STRIP
                && mode !== PrimitiveMode.TRIANGLE_FAN) {
                continue; // 跳过点/线图元
            }
            const posIdx = prim.attributes['POSITION'];
            if (posIdx === undefined) continue;
            const positions = this._readFloat(posIdx);
            const vcount = positions.length / 3;
            const normals = prim.attributes['NORMAL'] !== undefined
                ? this._readFloat(prim.attributes['NORMAL']) : null;
            const uvs = prim.attributes['TEXCOORD_0'] !== undefined
                ? this._readFloat(prim.attributes['TEXCOORD_0']) : null;

            // 索引（含 strip/fan → list 转换）
            let indices = prim.indices !== undefined
                ? this._readIndices(prim.indices)
                : sequentialIndices(vcount);
            if (mode === PrimitiveMode.TRIANGLE_STRIP) indices = stripToList(indices);
            else if (mode === PrimitiveMode.TRIANGLE_FAN) indices = fanToList(indices);

            // 烘焙世界变换到顶点 + 交错
            const verts = new Float32Array(vcount * 8);
            for (let i = 0; i < vcount; i++) {
                const px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2];
                const wx = world[0] * px + world[4] * py + world[8] * pz + world[12];
                const wy = world[1] * px + world[5] * py + world[9] * pz + world[13];
                const wz = world[2] * px + world[6] * py + world[10] * pz + world[14];
                verts[i * 8] = wx; verts[i * 8 + 1] = wy; verts[i * 8 + 2] = wz;
                if (wx < min[0]) min[0] = wx; if (wy < min[1]) min[1] = wy; if (wz < min[2]) min[2] = wz;
                if (wx > max[0]) max[0] = wx; if (wy > max[1]) max[1] = wy; if (wz > max[2]) max[2] = wz;
                if (normals) {
                    const nx = normals[i * 3], ny = normals[i * 3 + 1], nz = normals[i * 3 + 2];
                    let tx = normalMat[0] * nx + normalMat[3] * ny + normalMat[6] * nz;
                    let ty = normalMat[1] * nx + normalMat[4] * ny + normalMat[7] * nz;
                    let tz = normalMat[2] * nx + normalMat[5] * ny + normalMat[8] * nz;
                    const len = Math.hypot(tx, ty, tz) || 1;
                    verts[i * 8 + 3] = tx / len; verts[i * 8 + 4] = ty / len; verts[i * 8 + 5] = tz / len;
                }
                if (uvs) { verts[i * 8 + 6] = uvs[i * 2]; verts[i * 8 + 7] = uvs[i * 2 + 1]; }
            }
            if (!normals) computeFlatNormals(verts, indices);

            // 材质
            const matInfo = this._resolveMaterial(prim.material);
            const baseColorImage = matInfo.baseColorImageIndex !== undefined
                ? await this._loadImage(matInfo.baseColorImageIndex) : undefined;

            out.push({
                vertices: verts,
                vertexCount: vcount,
                indices,
                baseColorFactor: matInfo.baseColorFactor,
                baseColorImage,
                doubleSided: matInfo.doubleSided,
                alphaMode: matInfo.alphaMode,
                alphaCutoff: matInfo.alphaCutoff,
                emissiveFactor: matInfo.emissiveFactor,
            });
        }
    }

    private _resolveMaterial(materialIndex: number | undefined) {
        const mat = materialIndex !== undefined ? this._doc.materials?.[materialIndex] : undefined;
        const pbr = mat?.pbrMetallicRoughness;
        let baseColorImageIndex: number | undefined;
        if (pbr?.baseColorTexture) {
            const tex = this._doc.textures?.[pbr.baseColorTexture.index];
            if (tex?.source !== undefined) baseColorImageIndex = tex.source;
        }
        return {
            baseColorFactor: (pbr?.baseColorFactor ?? [1, 1, 1, 1]) as [number, number, number, number],
            baseColorImageIndex,
            doubleSided: mat?.doubleSided ?? false,
            alphaMode: mat?.alphaMode ?? 'OPAQUE',
            alphaCutoff: mat?.alphaCutoff ?? 0.5,
            emissiveFactor: (mat?.emissiveFactor ?? [0, 0, 0]) as [number, number, number],
        };
    }
}

// ====================== 辅助函数 ======================

function nodeMatrix(node: GltfNode): mat4 {
    const m = mat4.create();
    if (node.matrix) { mat4.copy(m, node.matrix as unknown as mat4); return m; }
    const t = node.translation ?? [0, 0, 0];
    const r = node.rotation ?? [0, 0, 0, 1];
    const s = node.scale ?? [1, 1, 1];
    const q = quat.fromValues(r[0], r[1], r[2], r[3]);
    mat4.fromRotationTranslationScale(m, q, t as [number, number, number], s as [number, number, number]);
    return m;
}

function numComponents(type: GltfAccessor['type']): number {
    switch (type) {
        case 'SCALAR': return 1;
        case 'VEC2': return 2;
        case 'VEC3': return 3;
        case 'VEC4': return 4;
        case 'MAT2': return 4;
        case 'MAT3': return 9;
        case 'MAT4': return 16;
    }
}

function componentByteSize(ct: ComponentType): number {
    switch (ct) {
        case ComponentType.BYTE:
        case ComponentType.UNSIGNED_BYTE: return 1;
        case ComponentType.SHORT:
        case ComponentType.UNSIGNED_SHORT: return 2;
        case ComponentType.UNSIGNED_INT:
        case ComponentType.FLOAT: return 4;
    }
}

function readComponent(dv: DataView, off: number, ct: ComponentType, normalized: boolean): number {
    switch (ct) {
        case ComponentType.FLOAT: return dv.getFloat32(off, true);
        case ComponentType.UNSIGNED_INT: return dv.getUint32(off, true);
        case ComponentType.UNSIGNED_SHORT: {
            const v = dv.getUint16(off, true); return normalized ? v / 65535 : v;
        }
        case ComponentType.SHORT: {
            const v = dv.getInt16(off, true); return normalized ? Math.max(v / 32767, -1) : v;
        }
        case ComponentType.UNSIGNED_BYTE: {
            const v = dv.getUint8(off); return normalized ? v / 255 : v;
        }
        case ComponentType.BYTE: {
            const v = dv.getInt8(off); return normalized ? Math.max(v / 127, -1) : v;
        }
    }
}

function sequentialIndices(count: number): Uint32Array {
    const a = new Uint32Array(count);
    for (let i = 0; i < count; i++) a[i] = i;
    return a;
}

function stripToList(strip: Uint32Array): Uint32Array {
    if (strip.length < 3) return new Uint32Array(0);
    const out = new Uint32Array((strip.length - 2) * 3);
    let o = 0;
    for (let i = 0; i < strip.length - 2; i++) {
        if (i % 2 === 0) { out[o++] = strip[i]; out[o++] = strip[i + 1]; out[o++] = strip[i + 2]; }
        else { out[o++] = strip[i + 1]; out[o++] = strip[i]; out[o++] = strip[i + 2]; }
    }
    return out;
}

function fanToList(fan: Uint32Array): Uint32Array {
    if (fan.length < 3) return new Uint32Array(0);
    const out = new Uint32Array((fan.length - 2) * 3);
    let o = 0;
    for (let i = 1; i < fan.length - 1; i++) { out[o++] = fan[0]; out[o++] = fan[i]; out[o++] = fan[i + 1]; }
    return out;
}

/** 交错缓冲（stride=8）按三角形面法线填充 normal 分量 */
function computeFlatNormals(verts: Float32Array, indices: Uint32Array): void {
    for (let t = 0; t < indices.length; t += 3) {
        const ia = indices[t], ib = indices[t + 1], ic = indices[t + 2];
        const ax = verts[ia * 8], ay = verts[ia * 8 + 1], az = verts[ia * 8 + 2];
        const bx = verts[ib * 8], by = verts[ib * 8 + 1], bz = verts[ib * 8 + 2];
        const cx = verts[ic * 8], cy = verts[ic * 8 + 1], cz = verts[ic * 8 + 2];
        const ux = bx - ax, uy = by - ay, uz = bz - az;
        const vx = cx - ax, vy = cy - ay, vz = cz - az;
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;
        for (const idx of [ia, ib, ic]) {
            verts[idx * 8 + 3] += nx; verts[idx * 8 + 4] += ny; verts[idx * 8 + 5] += nz;
        }
    }
    // 归一化累加法线
    for (let i = 0; i < verts.length; i += 8) {
        const nx = verts[i + 3], ny = verts[i + 4], nz = verts[i + 5];
        const len = Math.hypot(nx, ny, nz) || 1;
        verts[i + 3] = nx / len; verts[i + 4] = ny / len; verts[i + 5] = nz / len;
    }
}

/** 解析 data:URI（base64）为 Uint8Array */
function decodeDataUri(uri: string): Uint8Array {
    const comma = uri.indexOf(',');
    const meta = uri.slice(5, comma);
    const dataPart = uri.slice(comma + 1);
    if (meta.includes('base64')) {
        const bin = atob(dataPart);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
    }
    return new TextEncoder().encode(decodeURIComponent(dataPart));
}

function mimeFromDataUri(uri: string): string {
    const m = /^data:([^;,]+)/.exec(uri);
    return m ? m[1] : 'image/png';
}
