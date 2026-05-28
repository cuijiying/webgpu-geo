import type { TileCoord } from '../geo/types';
import { tileKey } from '../geo/types';

/**
 * 瓦片状态
 */
export const enum TileState {
    /** 已创建，未开始加载 */
    Idle = 0,
    /** 正在网络加载图像 */
    Loading = 1,
    /** 已加载图像，但 GPU 纹理尚未创建 */
    Loaded = 2,
    /** GPU 纹理已就绪，可被渲染 */
    Ready = 3,
    /** 加载失败 */
    Error = 4,
}

/**
 * Tile —— 单个栅格瓦片
 *
 * 同时承担"逻辑标识 + GPU 资源容器"角色：
 *   - coord:    瓦片坐标 (z, x, y)
 *   - state:    加载/上传状态机
 *   - image:    解码后的图像（ImageBitmap），上传到 GPU 后可释放
 *   - texture:  GPU 纹理，渲染时绑定
 *
 * GPU 资源由 RasterTileLayer 在 Loaded → Ready 阶段创建。
 */
export class Tile {
    readonly coord: TileCoord;
    readonly key: string;
    state: TileState = TileState.Idle;
    image: ImageBitmap | null = null;
    texture: GPUTexture | null = null;
    bindGroup: GPUBindGroup | null = null;
    /** 最近一次被需要的帧号，供 LRU 使用 */
    lastUsedFrame: number = 0;
    /** 加载用的 AbortController，便于在不再需要时取消 */
    abort: AbortController | null = null;

    constructor(coord: TileCoord) {
        this.coord = coord;
        this.key = tileKey(coord);
    }

    /** 释放所有 GPU + CPU 资源 */
    dispose(): void {
        this.abort?.abort();
        this.abort = null;
        if (this.image) { this.image.close?.(); this.image = null; }
        if (this.texture) { this.texture.destroy(); this.texture = null; }
        this.bindGroup = null;
        this.state = TileState.Idle;
    }
}
