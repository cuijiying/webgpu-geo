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

    get(key: string): Tile | undefined {
        const t = this._map.get(key);
        if (!t) return undefined;
        // touch：移到末尾
        this._map.delete(key);
        this._map.set(key, t);
        return t;
    }

    set(key: string, tile: Tile): void {
        if (this._map.has(key)) this._map.delete(key);
        this._map.set(key, tile);
        this._evict();
    }

    delete(key: string): boolean {
        const t = this._map.get(key);
        if (!t) return false;
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
    }

    private _evict(): void {
        while (this._map.size > this._capacity) {
            // 取最旧的 key 并删除
            const oldestKey = this._map.keys().next().value as string | undefined;
            if (!oldestKey) break;
            this.delete(oldestKey);
        }
    }
}
