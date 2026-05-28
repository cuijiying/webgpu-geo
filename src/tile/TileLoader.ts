import { Tile, TileState } from './Tile';
import type { TileSource } from './TileSource';

/**
 * TileLoader —— 异步瓦片加载器
 *
 * 职责：
 *   1) 通过 fetch + createImageBitmap 获取栅格瓦片
 *   2) 并发限流，防止浏览器连接耗尽
 *   3) 支持取消（AbortController）—— 瓦片滚出视野时立即放弃
 *   4) 加载完成后回调，由上层（Layer）负责 GPU 上传
 *
 * 调度策略：**按优先级 LIFO（栈式）**
 *   - 队列里每个条目带 priority；越大越先出
 *   - 同优先级内最新加入的先出（用户最新视图永远先服务）
 *   - 用 Map 索引快速取消
 *
 * 不直接持有 GPU 设备，保持单一职责。
 */
export interface TileLoaderOptions {
    maxConcurrent?: number;
    /** fetch 选项（可用于设置 referrerPolicy / headers 等） */
    fetchInit?: RequestInit;
}

export type TileLoadCallback = (tile: Tile, err?: Error) => void;

/** 内置优先级（数值越大越先调度） */
export const TileLoadPriority = {
    /** 用户当前可见的 ideal 瓦片 */
    Visible: 100,
    /** 立即兜底使用的祖先瓦片 */
    Fallback: 50,
    /** 父级缓存预取 */
    Prefetch: 10,
    /** 启动时的世界底图预加载 */
    Base: 1,
} as const;

interface QueueEntry {
    tile: Tile;
    cb: TileLoadCallback;
    priority: number;
    /** 单调递增的入队序号，用于"同优先级取最新" */
    seq: number;
}

export class TileLoader {
    private _source: TileSource;
    private _maxConcurrent: number;
    private _fetchInit: RequestInit;
    private _active = 0;
    /** 优先级桶：key 是 priority，value 是该桶内的栈（push/pop） */
    private _buckets = new Map<number, QueueEntry[]>();
    /** tile.key → entry 索引，加速取消和优先级更新 */
    private _index = new Map<string, QueueEntry>();
    private _seq = 0;

    constructor(source: TileSource, opts: TileLoaderOptions = {}) {
        this._source = source;
        this._maxConcurrent = opts.maxConcurrent ?? 16;
        this._fetchInit = opts.fetchInit ?? { mode: 'cors' };
    }

    /**
     * 请求加载一个瓦片（幂等）。
     * 若已在排队中，priority 取较大者并刷新到栈顶。
     */
    request(tile: Tile, cb: TileLoadCallback, priority: number = TileLoadPriority.Visible): void {
        if (tile.state === TileState.Loaded
            || tile.state === TileState.Ready) {
            return;
        }
        // 已在队列：升级优先级 + 移到栈顶（保证最新视图先服务）
        const existing = this._index.get(tile.key);
        if (existing) {
            const newPri = Math.max(existing.priority, priority);
            existing.cb = cb;
            existing.seq = ++this._seq;
            if (newPri !== existing.priority) {
                // 从旧桶移到新桶
                const oldBucket = this._buckets.get(existing.priority);
                if (oldBucket) {
                    const i = oldBucket.lastIndexOf(existing);
                    if (i >= 0) oldBucket.splice(i, 1);
                }
                existing.priority = newPri;
                this._enqueue(existing);
            } else {
                // 同桶内移到栈顶
                const bucket = this._buckets.get(existing.priority);
                if (bucket) {
                    const i = bucket.lastIndexOf(existing);
                    if (i >= 0 && i !== bucket.length - 1) {
                        bucket.splice(i, 1);
                        bucket.push(existing);
                    }
                }
            }
            return;
        }
        if (tile.state === TileState.Loading) return;
        tile.state = TileState.Loading;
        const entry: QueueEntry = { tile, cb, priority, seq: ++this._seq };
        this._index.set(tile.key, entry);
        this._enqueue(entry);
        this._pump();
    }

    /** 取消瓦片的进行中请求 */
    cancel(tile: Tile): void {
        const entry = this._index.get(tile.key);
        if (entry) {
            const bucket = this._buckets.get(entry.priority);
            if (bucket) {
                const i = bucket.lastIndexOf(entry);
                if (i >= 0) bucket.splice(i, 1);
            }
            this._index.delete(tile.key);
            tile.state = TileState.Idle;
            return;
        }
        if (tile.state === TileState.Loading) {
            tile.abort?.abort();
        }
    }

    /** 当前排队条目数（含所有优先级） */
    get pendingCount(): number {
        let n = 0;
        for (const b of this._buckets.values()) n += b.length;
        return n;
    }

    private _enqueue(entry: QueueEntry): void {
        let bucket = this._buckets.get(entry.priority);
        if (!bucket) {
            bucket = [];
            this._buckets.set(entry.priority, bucket);
        }
        bucket.push(entry);
    }

    /** 从所有桶中取优先级最高 + 栈顶的条目 */
    private _dequeue(): QueueEntry | null {
        // 优先级 key 按降序找首个非空桶
        let bestPri = -Infinity;
        let bestBucket: QueueEntry[] | null = null;
        for (const [pri, bucket] of this._buckets) {
            if (bucket.length > 0 && pri > bestPri) {
                bestPri = pri;
                bestBucket = bucket;
            }
        }
        if (!bestBucket) return null;
        return bestBucket.pop()!;
    }

    private _pump(): void {
        while (this._active < this._maxConcurrent) {
            const entry = this._dequeue();
            if (!entry) return;
            this._index.delete(entry.tile.key);
            this._active++;
            this._loadOne(entry.tile)
                .then(() => entry.cb(entry.tile))
                .catch((err: Error) => {
                    if (err.name === 'AbortError') {
                        entry.tile.state = TileState.Idle;
                        return;
                    }
                    entry.tile.state = TileState.Error;
                    entry.cb(entry.tile, err);
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
