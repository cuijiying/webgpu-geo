/**
 * earcut —— 多边形三角剖分（耳切法，支持带洞多边形）
 *
 * 设计为零依赖、纯函数式实现，输入扁平坐标数组，输出三角形索引。
 * 算法概述：
 *   1) 将外环 + 各洞构建为双向循环链表
 *   2) 通过"桥"把每个洞并入外环，形成单一简单多边形
 *   3) 反复裁剪"耳朵"（无其它顶点落入的凸三角）直至只剩三角形
 *
 * 复杂度近似 O(n²)（最坏），对地图常见的多边形规模足够；
 * 不含 z-order 哈希加速，换取实现简明与可读性。
 */

interface Node {
    i: number;      // 顶点在扁平坐标中的索引（已 /dim）
    x: number;
    y: number;
    prev: Node;
    next: Node;
    steiner: boolean;
}

/**
 * @param data   扁平坐标数组，[x0,y0, x1,y1, ...]（dim=2）
 * @param holeIndices 各洞在"顶点序号"上的起始位置（如 [5, 8] 表示第 5、8 个顶点起为洞）
 * @param dim    每个顶点的分量数，默认 2
 * @returns      三角形顶点索引数组（每 3 个为一组）
 */
export function earcut(data: number[] | Float64Array, holeIndices?: number[], dim = 2): number[] {
    const hasHoles = holeIndices && holeIndices.length > 0;
    const outerLen = hasHoles ? holeIndices![0] * dim : data.length;

    let outerNode = linkedList(data, 0, outerLen, dim, true);
    const triangles: number[] = [];
    if (!outerNode || outerNode.next === outerNode.prev) return triangles;

    if (hasHoles) outerNode = eliminateHoles(data, holeIndices!, outerNode, dim);

    earcutLinked(outerNode, triangles, dim);
    return triangles;
}

/** 用一段坐标构建双向循环链表，确保按指定缠绕方向 */
function linkedList(data: number[] | Float64Array, start: number, end: number, dim: number, clockwise: boolean): Node | null {
    let last: Node | null = null;

    if (clockwise === signedArea(data, start, end, dim) > 0) {
        for (let i = start; i < end; i += dim) last = insertNode(i / dim, data[i], data[i + 1], last);
    } else {
        for (let i = end - dim; i >= start; i -= dim) last = insertNode(i / dim, data[i], data[i + 1], last);
    }

    if (last && equals(last, last.next)) {
        removeNode(last);
        last = last.next;
    }
    return last;
}

/** 主裁剪循环 */
function earcutLinked(ear: Node | null, triangles: number[], dim: number, pass = 0): void {
    if (!ear) return;
    let stop = ear;
    let prev: Node;
    let next: Node;

    while (ear.prev !== ear.next) {
        prev = ear.prev;
        next = ear.next;

        if (isEar(ear)) {
            triangles.push(prev.i, ear.i, next.i);
            removeNode(ear);
            ear = next.next;
            stop = next.next;
            continue;
        }

        ear = next;

        // 绕了一圈仍未找到耳朵 → 处理退化情形
        if (ear === stop) {
            if (pass === 0) {
                earcutLinked(filterPoints(ear), triangles, dim, 1);
            } else if (pass === 1) {
                ear = cureLocalIntersections(filterPoints(ear)!, triangles);
                earcutLinked(ear, triangles, dim, 2);
            }
            break;
        }
    }
}

/** 判断 ear 是否为合法耳朵：凸 + 三角内无其它顶点 */
function isEar(ear: Node): boolean {
    const a = ear.prev;
    const b = ear;
    const c = ear.next;

    if (area(a, b, c) >= 0) return false; // 反凸（凹）顶点

    let p = ear.next.next;
    while (p !== ear.prev) {
        if (
            pointInTriangle(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y) &&
            area(p.prev, p, p.next) >= 0
        ) {
            return false;
        }
        p = p.next;
    }
    return true;
}

/** 移除自交：用于退化多边形的兜底修复 */
function cureLocalIntersections(start: Node, triangles: number[]): Node {
    let p = start;
    do {
        const a = p.prev;
        const b = p.next.next;
        if (!equals(a, b) && intersects(a, p, p.next, b) && locallyInside(a, b) && locallyInside(b, a)) {
            triangles.push(a.i, p.i, b.i);
            removeNode(p);
            removeNode(p.next);
            p = start = b;
        }
        p = p.next;
    } while (p !== start);
    return filterPoints(p)!;
}

/** 把所有洞并入外环 */
function eliminateHoles(data: number[] | Float64Array, holeIndices: number[], outerNode: Node, dim: number): Node {
    const queue: Node[] = [];
    for (let i = 0; i < holeIndices.length; i++) {
        const start = holeIndices[i] * dim;
        const end = i < holeIndices.length - 1 ? holeIndices[i + 1] * dim : data.length;
        const list = linkedList(data, start, end, dim, false);
        if (list) {
            if (list === list.next) list.steiner = true;
            queue.push(getLeftmost(list));
        }
    }
    queue.sort((a, b) => a.x - b.x);

    for (const hole of queue) {
        outerNode = eliminateHole(hole, outerNode);
    }
    return outerNode;
}

function eliminateHole(hole: Node, outerNode: Node): Node {
    const bridge = findHoleBridge(hole, outerNode);
    if (!bridge) return outerNode;

    const bridgeReverse = splitPolygon(bridge, hole);
    filterPoints(bridgeReverse, bridgeReverse.next);
    return filterPoints(bridge, bridge.next)!;
}

/** 为洞找到一座连接到外环的可见桥 */
function findHoleBridge(hole: Node, outerNode: Node): Node | null {
    let p = outerNode;
    const hx = hole.x;
    const hy = hole.y;
    let qx = -Infinity;
    let m: Node | null = null;

    // 向 +x 方向找最近的与水平射线相交的边
    do {
        if (hy <= p.y && hy >= p.next.y && p.next.y !== p.y) {
            const x = p.x + ((hy - p.y) * (p.next.x - p.x)) / (p.next.y - p.y);
            if (x <= hx && x > qx) {
                qx = x;
                m = p.x < p.next.x ? p : p.next;
                if (x === hx) return m; // 恰好命中顶点
            }
        }
        p = p.next;
    } while (p !== outerNode);

    if (!m) return null;

    // 在 m 与候选区域中找更优可见点（处理桥穿过多边形的情况）
    const stop = m;
    const mx = m.x;
    const my = m.y;
    let tanMin = Infinity;

    p = m;
    do {
        if (
            hx >= p.x && p.x >= mx && hx !== p.x &&
            pointInTriangle(hy < my ? hx : qx, hy, mx, my, hy < my ? qx : hx, hy, p.x, p.y)
        ) {
            const tan = Math.abs(hy - p.y) / (hx - p.x);
            if (locallyInside(p, hole) && (tan < tanMin || (tan === tanMin && (p.x > m!.x || (p.x === m!.x && sectorContainsSector(m!, p)))))) {
                m = p;
                tanMin = tan;
            }
        }
        p = p.next;
    } while (p !== stop);

    return m;
}

function sectorContainsSector(m: Node, p: Node): boolean {
    return area(m.prev, m, p.prev) < 0 && area(p.next, m, m.next) < 0;
}

function getLeftmost(start: Node): Node {
    let p = start;
    let leftmost = start;
    do {
        if (p.x < leftmost.x || (p.x === leftmost.x && p.y < leftmost.y)) leftmost = p;
        p = p.next;
    } while (p !== start);
    return leftmost;
}

/** 移除零面积 / 共线冗余顶点 */
function filterPoints(start: Node | null, end?: Node): Node | null {
    if (!start) return start;
    if (!end) end = start;

    let p = start;
    let again: boolean;
    do {
        again = false;
        if (!p.steiner && (equals(p, p.next) || area(p.prev, p, p.next) === 0)) {
            removeNode(p);
            p = end = p.prev;
            if (p === p.next) break;
            again = true;
        } else {
            p = p.next;
        }
    } while (again || p !== end);

    return end;
}

/** 沿对角线把多边形一分为二（用于桥接洞） */
function splitPolygon(a: Node, b: Node): Node {
    const a2 = createNode(a.i, a.x, a.y);
    const b2 = createNode(b.i, b.x, b.y);
    const an = a.next;
    const bp = b.prev;

    a.next = b;
    b.prev = a;
    a2.next = an;
    an.prev = a2;
    b2.next = a2;
    a2.prev = b2;
    bp.next = b2;
    b2.prev = bp;

    return b2;
}

function insertNode(i: number, x: number, y: number, last: Node | null): Node {
    const p = createNode(i, x, y);
    if (!last) {
        p.prev = p;
        p.next = p;
    } else {
        p.next = last.next;
        p.prev = last;
        last.next.prev = p;
        last.next = p;
    }
    return p;
}

function createNode(i: number, x: number, y: number): Node {
    const node = { i, x, y, steiner: false } as Node;
    node.prev = node;
    node.next = node;
    return node;
}

function removeNode(p: Node): void {
    p.next.prev = p.prev;
    p.prev.next = p.next;
}

// ---- 几何谓词 ----

function area(p: Node, q: Node, r: Node): number {
    return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
}

function equals(p1: Node, p2: Node): boolean {
    return p1.x === p2.x && p1.y === p2.y;
}

function intersects(p1: Node, q1: Node, p2: Node, q2: Node): boolean {
    const o1 = Math.sign(area(p1, q1, p2));
    const o2 = Math.sign(area(p1, q1, q2));
    const o3 = Math.sign(area(p2, q2, p1));
    const o4 = Math.sign(area(p2, q2, q1));
    if (o1 !== o2 && o3 !== o4) return true;
    return false;
}

function locallyInside(a: Node, b: Node): boolean {
    return area(a.prev, a, a.next) < 0
        ? area(a, b, a.next) >= 0 && area(a, a.prev, b) >= 0
        : area(a, b, a.prev) < 0 || area(a, a.next, b) < 0;
}

function pointInTriangle(
    ax: number, ay: number, bx: number, by: number, cx: number, cy: number, px: number, py: number,
): boolean {
    return (
        (cx - px) * (ay - py) - (ax - px) * (cy - py) >= 0 &&
        (ax - px) * (by - py) - (bx - px) * (ay - py) >= 0 &&
        (bx - px) * (cy - py) - (cx - px) * (by - py) >= 0
    );
}

function signedArea(data: number[] | Float64Array, start: number, end: number, dim: number): number {
    let sum = 0;
    for (let i = start, j = end - dim; i < end; i += dim) {
        sum += (data[j] - data[i]) * (data[i + 1] + data[j + 1]);
        j = i;
    }
    return sum;
}
