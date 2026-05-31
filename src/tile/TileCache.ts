import { Tile } from './Tile';

/**
 * TileCache —— 带容量上限的 LRU 瓦片缓存
 *
 * 关键点：
 *   - 利用 Map 在 JS 中保持插入顺序的特性，迭代器最旧 → 最新
 *   - 每次 get/set 都将命中项移到末尾，使其变"最新"
 *   - 超出容量时从头部（最旧）开始淘汰，并销毁对应 Tile 的 GPU 资源
 *
 * 容量建议：根据视口可见瓦片数的 4~8 倍，足以覆盖常见交互场景。
 */
export class TileCache {
    private _map = new Map<string, Tile>();
    private _capacity: number;
    /** 被钉固的 key 集合：永不被 LRU 淘汰（如世界底图，作为永久兜底地板） */
    private _pinned = new Set<string>();

    constructor(capacity = 256) {
        this._capacity = Math.max(16, capacity);
    }

    get size(): number { return this._map.size; }
    get capacity(): number { return this._capacity; }
    setCapacity(c: number): void {
        this._capacity = Math.max(16, c);
        this._evict();
    }

    has(key: string): boolean { return this._map.has(key); }

    /**
     * 读取并刷新 LRU（移到末尾=最新）。
     * 注意：会产生 Map.delete+set 副作用，仅在"确实要用这个瓦片"时调用。
     */
    get(key: string): Tile | undefined {
        const t = this._map.get(key);
        if (!t) return undefined;
        // touch：移到末尾
        this._map.delete(key);
        this._map.set(key, t);
        return t;
    }

    /**
     * 只读窥视，**不刷新 LRU**（无 Map 结构变更）。
     * 用于 fallback 祖先链搜索等高频只读场景，避免每帧数百次 Map 删/插抖动。
     */
    peek(key: string): Tile | undefined {
        return this._map.get(key);
    }

    /** 钉固一个瓦片，使其永不被 LRU 淘汰 */
    pin(key: string): void { this._pinned.add(key); }
    /** 取消钉固 */
    unpin(key: string): void { this._pinned.delete(key); }
    isPinned(key: string): boolean { return this._pinned.has(key); }

    set(key: string, tile: Tile): void {
        if (this._map.has(key)) this._map.delete(key);
        this._map.set(key, tile);
        this._evict();
    }

    delete(key: string): boolean {
        const t = this._map.get(key);
        if (!t) return false;
        this._pinned.delete(key);
        t.dispose();
        return this._map.delete(key);
    }

    /** 仅用于遍历（按"旧 → 新"顺序） */
    forEach(cb: (t: Tile) => void): void {
        this._map.forEach(cb);
    }

    clear(): void {
        this._map.forEach((t) => t.dispose());
        this._map.clear();
        this._pinned.clear();
    }

    private _evict(): void {
        if (this._map.size <= this._capacity) return;
        // 从最旧开始淘汰，跳过被钉固的 key。
        // 先用迭代器推进再删除，保证删除当前项不破坏遍历。
        const it = this._map.keys();
        let res = it.next();
        while (this._map.size > this._capacity && !res.done) {
            const key = res.value;
            res = it.next();
            if (this._pinned.has(key)) continue;
            this.delete(key);
        }
    }
}
