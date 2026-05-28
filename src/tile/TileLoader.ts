import { Tile, TileState } from './Tile';
import type { TileSource } from './TileSource';

/**
 * TileLoader —— 异步瓦片加载器
 *
 * 职责：
 *   1) 通过 fetch + createImageBitmap 获取栅格瓦片
 *   2) 并发限流（默认 8 并发），防止浏览器连接耗尽
 *   3) 支持取消（AbortController）—— 瓦片滚出视野时立即放弃
 *   4) 加载完成后回调，由上层（Layer）负责 GPU 上传
 *
 * 不直接持有 GPU 设备，保持单一职责。
 */
export interface TileLoaderOptions {
    maxConcurrent?: number;
    /** fetch 选项（可用于设置 referrerPolicy / headers 等） */
    fetchInit?: RequestInit;
}

export type TileLoadCallback = (tile: Tile, err?: Error) => void;

export class TileLoader {
    private _source: TileSource;
    private _maxConcurrent: number;
    private _fetchInit: RequestInit;
    private _active = 0;
    private _queue: Array<{ tile: Tile; cb: TileLoadCallback }> = [];

    constructor(source: TileSource, opts: TileLoaderOptions = {}) {
        this._source = source;
        this._maxConcurrent = opts.maxConcurrent ?? 8;
        this._fetchInit = opts.fetchInit ?? { mode: 'cors' };
    }

    /**
     * 请求加载一个瓦片。若已在加载/已就绪则忽略。
     */
    request(tile: Tile, cb: TileLoadCallback): void {
        if (tile.state === TileState.Loading
            || tile.state === TileState.Loaded
            || tile.state === TileState.Ready) {
            return;
        }
        tile.state = TileState.Loading;
        this._queue.push({ tile, cb });
        this._pump();
    }

    /** 取消瓦片的进行中请求 */
    cancel(tile: Tile): void {
        // 若仍在队列中，直接移除
        const i = this._queue.findIndex((q) => q.tile === tile);
        if (i >= 0) {
            this._queue.splice(i, 1);
            tile.state = TileState.Idle;
            return;
        }
        if (tile.state === TileState.Loading) {
            tile.abort?.abort();
        }
    }

    private _pump(): void {
        while (this._active < this._maxConcurrent && this._queue.length > 0) {
            const { tile, cb } = this._queue.shift()!;
            this._active++;
            this._loadOne(tile)
                .then(() => cb(tile))
                .catch((err: Error) => {
                    if (err.name === 'AbortError') {
                        tile.state = TileState.Idle;
                        return;
                    }
                    tile.state = TileState.Error;
                    cb(tile, err);
                })
                .finally(() => {
                    this._active--;
                    this._pump();
                });
        }
    }

    private async _loadOne(tile: Tile): Promise<void> {
        const url = this._source.getTileUrl(tile.coord);
        const ac = new AbortController();
        tile.abort = ac;
        const res = await fetch(url, { ...this._fetchInit, signal: ac.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        const blob = await res.blob();
        // createImageBitmap 在后台线程解码，零拷贝纹理上传，性能最佳
        const bitmap = await createImageBitmap(blob, {
            premultiplyAlpha: 'premultiply',
            colorSpaceConversion: 'none',
        });
        tile.image = bitmap;
        tile.state = TileState.Loaded;
        tile.abort = null;
    }
}
