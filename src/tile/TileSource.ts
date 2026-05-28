import type { TileCoord } from '../geo/types';

/**
 * TileSource —— 瓦片源
 *
 * 支持标准 XYZ URL 模板，例如：
 *   "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
 *   "https://{s}.tile.osm.org/{z}/{x}/{y}.png"  （{s} 为子域轮转）
 *
 * 设计为抽象点，未来可扩展 TMS / WMTS / 自定义协议。
 */
export interface TileSourceOptions {
    /** URL 模板，必须包含 {z} {x} {y}；可选 {s} */
    url: string;
    /** 子域名列表（用于 {s} 轮转），默认 ['a', 'b', 'c'] */
    subdomains?: string[];
    /** 最小可用 zoom */
    minZoom?: number;
    /** 最大可用 zoom */
    maxZoom?: number;
    /** 瓦片像素尺寸，默认 256 */
    tileSize?: number;
    /** 归属信息 */
    attribution?: string;
}

export class TileSource {
    readonly url: string;
    readonly subdomains: string[];
    readonly minZoom: number;
    readonly maxZoom: number;
    readonly tileSize: number;
    readonly attribution: string;
    private _sidx = 0;

    constructor(opts: TileSourceOptions) {
        if (!opts.url) throw new Error('TileSource.url 必填');
        this.url = opts.url;
        this.subdomains = opts.subdomains ?? ['a', 'b', 'c'];
        this.minZoom = opts.minZoom ?? 0;
        this.maxZoom = opts.maxZoom ?? 19;
        this.tileSize = opts.tileSize ?? 256;
        this.attribution = opts.attribution ?? '';
    }

    /** 根据 z/x/y 生成最终的瓦片请求 URL */
    getTileUrl(c: TileCoord): string {
        const s = this.subdomains[this._sidx++ % this.subdomains.length];
        return this.url
            .replace('{s}', s)
            .replace('{z}', String(c.z))
            .replace('{x}', String(c.x))
            .replace('{y}', String(c.y));
    }
}
