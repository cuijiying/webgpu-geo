import type {
    GeoJSONData, Feature, FeatureCollection, Geometry,
} from './types';

/**
 * GeoJSONSource —— 数据加载与规范化
 *
 * 职责：
 *   - 接受 FeatureCollection / Feature / Geometry / URL 字符串
 *   - 远程 URL 通过 fetch 异步加载
 *   - 统一展开为扁平的 Feature[]（GeometryCollection 会被拆解为多个 Feature）
 *
 * 不负责任何 GPU / 几何构建，仅产出规范化要素，供图层消费。
 */
export class GeoJSONSource {
    private _features: Feature[] = [];
    private _loaded = false;

    constructor(data?: GeoJSONData) {
        if (data !== undefined && typeof data !== 'string') {
            this.setData(data);
        }
        this._pendingUrl = typeof data === 'string' ? data : null;
    }

    private _pendingUrl: string | null;

    /** 是否已就绪（同步数据构造即就绪；URL 需 await load()） */
    get loaded(): boolean { return this._loaded; }

    /** 规范化后的扁平要素列表 */
    get features(): Feature[] { return this._features; }

    /** 直接设置数据（同步） */
    setData(data: Exclude<GeoJSONData, string>): this {
        this._features = GeoJSONSource.normalize(data);
        this._loaded = true;
        this._pendingUrl = null;
        return this;
    }

    /**
     * 完成加载：若构造时传入 URL 则发起 fetch，否则立即返回。
     * 可重复 await，已加载时直接 resolve。
     */
    async load(signal?: AbortSignal): Promise<this> {
        if (this._loaded) return this;
        if (this._pendingUrl) {
            const resp = await fetch(this._pendingUrl, { signal });
            if (!resp.ok) throw new Error(`加载 GeoJSON 失败：HTTP ${resp.status} ${this._pendingUrl}`);
            const json = (await resp.json()) as Exclude<GeoJSONData, string>;
            this.setData(json);
        }
        return this;
    }

    /** 把任意 GeoJSON 形态展开为扁平 Feature[] */
    static normalize(data: Exclude<GeoJSONData, string>): Feature[] {
        const out: Feature[] = [];
        const pushGeometry = (geom: Geometry | null, props: Record<string, unknown> | null | undefined, id?: string | number) => {
            if (!geom) return;
            if (geom.type === 'GeometryCollection') {
                for (const g of geom.geometries) pushGeometry(g, props, id);
            } else {
                out.push({ type: 'Feature', geometry: geom, properties: props ?? null, id });
            }
        };

        switch (data.type) {
            case 'FeatureCollection':
                for (const f of (data as FeatureCollection).features) {
                    pushGeometry(f.geometry, f.properties, f.id);
                }
                break;
            case 'Feature':
                pushGeometry((data as Feature).geometry, (data as Feature).properties, (data as Feature).id);
                break;
            default:
                // 裸几何
                pushGeometry(data as Geometry, null);
                break;
        }
        return out;
    }
}
