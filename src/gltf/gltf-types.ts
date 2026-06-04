/**
 * glTF 2.0 JSON 结构类型（本引擎消费的子集）
 *
 * 规范：https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html
 * 未列出的字段会被解析器忽略，不影响加载。
 */

/** 组件类型枚举（accessor.componentType） */
export const enum ComponentType {
    BYTE = 5120,
    UNSIGNED_BYTE = 5121,
    SHORT = 5122,
    UNSIGNED_SHORT = 5123,
    UNSIGNED_INT = 5125,
    FLOAT = 5126,
}

/** 图元拓扑（primitive.mode） */
export const enum PrimitiveMode {
    POINTS = 0,
    LINES = 1,
    LINE_LOOP = 2,
    LINE_STRIP = 3,
    TRIANGLES = 4,
    TRIANGLE_STRIP = 5,
    TRIANGLE_FAN = 6,
}

export interface GltfAsset {
    version: string;
    minVersion?: string;
    generator?: string;
}

export interface GltfBuffer {
    /** 外部 URI 或 data:URI；glb 主缓冲省略此字段（使用 BIN chunk） */
    uri?: string;
    byteLength: number;
}

export interface GltfBufferView {
    buffer: number;
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
    target?: number;
}

export interface GltfAccessor {
    bufferView?: number;
    byteOffset?: number;
    componentType: ComponentType;
    normalized?: boolean;
    count: number;
    type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT2' | 'MAT3' | 'MAT4';
    max?: number[];
    min?: number[];
}

export interface GltfPrimitive {
    attributes: Record<string, number>; // POSITION / NORMAL / TEXCOORD_0 / COLOR_0 ...
    indices?: number;
    material?: number;
    mode?: PrimitiveMode;
}

export interface GltfMesh {
    primitives: GltfPrimitive[];
    name?: string;
}

export interface GltfNode {
    name?: string;
    mesh?: number;
    camera?: number;
    children?: number[];
    /** 4×4 列主序矩阵；与 TRS 二选一 */
    matrix?: number[];
    translation?: [number, number, number];
    rotation?: [number, number, number, number]; // 四元数 [x,y,z,w]
    scale?: [number, number, number];
}

export interface GltfScene {
    nodes?: number[];
    name?: string;
}

export interface GltfTextureInfo {
    index: number;
    texCoord?: number;
}

export interface GltfPbrMetallicRoughness {
    baseColorFactor?: [number, number, number, number];
    baseColorTexture?: GltfTextureInfo;
    metallicFactor?: number;
    roughnessFactor?: number;
    metallicRoughnessTexture?: GltfTextureInfo;
}

export interface GltfMaterial {
    name?: string;
    pbrMetallicRoughness?: GltfPbrMetallicRoughness;
    normalTexture?: GltfTextureInfo & { scale?: number };
    emissiveFactor?: [number, number, number];
    emissiveTexture?: GltfTextureInfo;
    alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
    alphaCutoff?: number;
    doubleSided?: boolean;
}

export interface GltfTexture {
    sampler?: number;
    source?: number;
}

export interface GltfImage {
    uri?: string;
    mimeType?: string;
    bufferView?: number;
}

export interface GltfSampler {
    magFilter?: number;
    minFilter?: number;
    wrapS?: number;
    wrapT?: number;
}

/** glTF 顶层文档 */
export interface GltfDocument {
    asset: GltfAsset;
    scene?: number;
    scenes?: GltfScene[];
    nodes?: GltfNode[];
    meshes?: GltfMesh[];
    accessors?: GltfAccessor[];
    bufferViews?: GltfBufferView[];
    buffers?: GltfBuffer[];
    materials?: GltfMaterial[];
    textures?: GltfTexture[];
    images?: GltfImage[];
    samplers?: GltfSampler[];
    extensionsUsed?: string[];
    extensionsRequired?: string[];
}

// ====================== 解析后的中间表示（与 GPU 无关） ======================

/** 单个图元的 CPU 端几何数据（顶点已烘焙节点变换，处于 glTF 模型空间，单位米） */
export interface ParsedPrimitive {
    /** 交错顶点：position(3) + normal(3) + uv(2)，stride = 8 float */
    vertices: Float32Array;
    /** 顶点数 */
    vertexCount: number;
    /** 三角形索引 */
    indices: Uint32Array;
    /** 基色因子 RGBA（线性 0..1，已与 vertex color 无关） */
    baseColorFactor: [number, number, number, number];
    /** 基色贴图（已解码）；无则 undefined */
    baseColorImage?: ImageBitmap;
    /** 是否双面 */
    doubleSided: boolean;
    /** alpha 模式 */
    alphaMode: 'OPAQUE' | 'MASK' | 'BLEND';
    /** MASK 模式裁剪阈值 */
    alphaCutoff: number;
    /** 自发光因子 RGB */
    emissiveFactor: [number, number, number];
}

/** 解析后的整个模型 */
export interface ParsedModel {
    primitives: ParsedPrimitive[];
    /** 模型空间 AABB（米），用于估算包围球 / 调试 */
    min: [number, number, number];
    max: [number, number, number];
}
