/**
 * Evented —— 轻量、强类型的事件发射器基类（参考 mapbox-gl 的 Evented 设计）
 *
 * 提供 on / off / once / fire / listens 五个核心 API：
 *   - on(type, listener)    注册监听
 *   - once(type, listener)  注册一次性监听；不传 listener 时返回 Promise（可 await）
 *   - off(type?, listener?) 取消监听（按需精确匹配 / 按类型清空 / 全部清空）
 *   - fire(type, event)     触发事件
 *   - listens(type)         是否存在某类型的监听者（供热点路径短路用，避免无谓拾取）
 *
 * 设计要点：
 *   - 触发时对监听器数组做浅拷贝快照，允许在回调内部安全地增删监听器
 *   - once 通过包装实现，off 仍可用「原始函数引用」精确移除
 *   - listener 内 this 指向当前 Evented 实例（与 DOM 习惯一致）
 */
export type EventListener<E = any> = (event: E) => void;

interface ListenerEntry {
    fn: EventListener;
    once: boolean;
    /** 原始用户函数引用，用于 off 精确匹配（once 包装后仍能移除） */
    orig: EventListener;
}

export class Evented {
    /** type -> 监听器列表（使用无原型对象，避免与 Object.prototype 上的键冲突） */
    private _listeners: Record<string, ListenerEntry[]> = Object.create(null);

    /** 注册事件监听 */
    on(type: string, listener: EventListener): this {
        this._add(type, listener, listener, false);
        return this;
    }

    /**
     * 注册一次性监听。
     *   - 传入 listener：触发一次后自动移除
     *   - 省略 listener：返回 Promise，事件首次触发时 resolve（便于 `await map.once('load')`）
     */
    once(type: string): Promise<any>;
    once(type: string, listener: EventListener): this;
    once(type: string, listener?: EventListener): this | Promise<any> {
        if (!listener) {
            return new Promise((resolve) => {
                this._add(type, (e) => resolve(e), resolve, true);
            });
        }
        this._add(type, listener, listener, true);
        return this;
    }

    /**
     * 取消监听：
     *   off()              —— 移除全部监听
     *   off(type)          —— 移除该类型全部监听
     *   off(type, listener)—— 移除该类型下的指定监听
     */
    off(type?: string, listener?: EventListener): this {
        if (type === undefined) {
            this._listeners = Object.create(null);
            return this;
        }
        const arr = this._listeners[type];
        if (!arr) return this;
        if (!listener) {
            delete this._listeners[type];
            return this;
        }
        const next = arr.filter((e) => e.orig !== listener);
        if (next.length) this._listeners[type] = next;
        else delete this._listeners[type];
        return this;
    }

    /** 触发事件；event 会被注入 type/target（若未显式提供） */
    fire(type: string, event?: any): this {
        const arr = this._listeners[type];
        if (arr && arr.length) {
            const e = event ?? {};
            if (e.type === undefined) e.type = type;
            if (e.target === undefined) e.target = this;
            // 快照遍历，允许回调内部修改监听列表
            for (const entry of arr.slice()) {
                if (entry.once) this._removeEntry(type, entry);
                entry.fn.call(this, e);
            }
        }
        return this;
    }

    /** 是否存在该类型的监听者 */
    listens(type: string): boolean {
        const arr = this._listeners[type];
        return !!arr && arr.length > 0;
    }

    private _add(type: string, fn: EventListener, orig: EventListener, once: boolean): void {
        (this._listeners[type] ||= []).push({ fn, once, orig });
    }

    private _removeEntry(type: string, entry: ListenerEntry): void {
        const arr = this._listeners[type];
        if (!arr) return;
        const i = arr.indexOf(entry);
        if (i >= 0) arr.splice(i, 1);
        if (!arr.length) delete this._listeners[type];
    }
}
