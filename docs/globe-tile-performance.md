# 3D 球体栅格瓦片渲染性能优化文档

> 目标：解决 globe（3D 球体）模式下栅格瓦片渲染的**卡顿**（尤其缩放时）与**画面空白**问题，使交互流畅、视觉连续。

本文档完整记录问题现象、根因分析、修复方案与验证方法，便于后续维护与回归。

---

## 1. 问题现象

| 现象 | 触发场景 | 影响 |
| --- | --- | --- |
| 严重卡顿、鼠标无法操作 | 小比例尺（zoom 1~2）首屏 / 缩放 | 一次性请求上百张瓦片，主线程阻塞 |
| 缩放过程持续模糊 | globe 缩放 | 渲染层级远低于像素所需细节级 |
| 缩放时画面中间空白 | 快速缩放 | 兜底地板瓦片缺失，无回退纹理 |
| 缩放卡顿 + 闪烁 | 连续缩放 | 层级在边界反复跳变，请求/上传风暴 |

---

## 2. 关键背景：globe 模式与 mercator 的差异

平面（mercator）模式下，`camera.zoom = z` 直接等价于"瓦片宽度 = 视口宽 / 2^z"，缩放级别与瓦片细节级一一对应。

球体（globe）模式则完全不同。相机距球心的距离由下式控制：

$$d = 1 + \frac{d_0 - 1}{2^{\text{zoom}}}, \quad d_0 = \frac{1}{\tan(\text{fov}/2)}$$

即 **`camera.zoom` 控制的是"相机离球面的远近"，而不是瓦片细节级**。真正决定清晰度的，是屏幕每像素对应的球面弧度 `radPerPx`，据此反推所需的瓦片层级：

$$z_{\text{desired}} = \log_2\!\left(\frac{2\pi}{256 \cdot \text{radPerPx}}\right), \quad \text{radPerPx} = \frac{(d-1)\cdot \text{fov}}{\text{viewportHeight}}$$

实测（视口高 800px）：

| camera.zoom | d | desiredZ（所需细节级） |
| --- | --- | --- |
| 1 | 1.71 | ≈ 5 |
| 2 | 1.35 | ≈ 6 |
| 4 | 1.09 | ≈ 8 |

**这是后续所有取舍的基础：globe 渲染清晰度必须以 `desiredZ` 为准，而瓦片数量需要靠其它手段约束。**

---

## 3. 根因分析与修复

优化分两轮推进。第一轮解决"首屏请求风暴卡死"，第二轮解决"缩放卡顿/模糊/空白"。

### 第一轮：首屏请求风暴

#### 根因 1：globe 的 targetZ 与像素密度脱钩，且一度被错误封顶

最初 `_getGlobeVisibleTiles` 直接 `Math.round(desiredZ)`，在 zoom 1~2 时算出 z=5~6，叠加 horizon 范围内大量瓦片，单帧请求上百张。

曾尝试用 `targetZ = min(desiredZ, camZ + 1)` 封顶来压数量——但这会把 z=6 的纹理用 z=3 的图拉伸 8 倍，导致**全程模糊**（这是"一直很模糊"现象的来源）。

**最终修复**：以 `desiredZ` 为权威保证清晰度，数量改由下文其它机制约束（详见根因 5 滞回 + prefetch 预算）。

#### 根因 2：`_buildFallbackDraw` 每帧逐级暴力请求

旧逻辑对每个未就绪 ideal 瓦片，向上最多 25 层，**每层 Idle 祖先都 `_loader.request`**。冷启动 100+ ideal × 多层 = 单帧数千次入队，把队列、字符串拼 key、Map 操作全部堆在主线程。

**修复**：fallback 不再逐级请求；改为只读查询缓存找最近 Ready 祖先（见第二轮根因 A）。

#### 根因 3：base 底图优先级过低被抢占

`TileLoadPriority.Base = 1`（最低），首屏排队的兜底底图立刻被随后的 Visible(100)/Fallback(50) 插队，底图迟迟不就绪 → 触发更多 fallback → 雪崩。

**修复**：提升 `Base = 200`（最高）。底图数量极少（baseLoadZoom=2 仅 21 张），最先就绪后即可作为全局兜底地板。

```ts
export const TileLoadPriority = {
    Visible: 100,
    Base: 200,    // 提到最高：兜底地板必须最先就绪
    Fallback: 50,
    Prefetch: 10,
} as const;
```

#### 根因 4：无每帧加载预算

所有 ideal / prefetch / fallback 请求集中在一帧瞬时入队，16 并发立刻打满，浏览器同时解码大量 PNG 与主线程争用。

**修复**：为 prefetch 增加每帧预算上限，且已在缓存中的 prefetch 仅刷新 LRU、不计预算。

```ts
const PREFETCH_BUDGET_PER_FRAME = 32;
let prefetchBudget = PREFETCH_BUDGET_PER_FRAME;
// ...
if (existing && existing.state !== TileState.Idle) {
    existing.lastUsedFrame = frame;   // 仅刷新 LRU
    continue;                          // 不消耗预算
}
const pt = this._requestTile(pc, TileLoadPriority.Prefetch);
prefetchBudget--;
```

---

### 第二轮：缩放卡顿 / 空白 / 闪烁

#### 根因 A：fallback 查询造成 LRU 抖动（缩放卡顿主因）

`TileCache.get()` 有副作用——每次都 `Map.delete + Map.set` 把项移到末尾。缩放瞬间新 z 级 ideal 瓦片**全部未就绪**，约 50 个瓦片 × 向上若干层 = 每帧数百次 Map 删/插，这是缩放抖动的元凶。

**修复**：给 `TileCache` 增加无副作用的只读 `peek()`，fallback 搜索改用它。

```ts
/** 只读窥视，不刷新 LRU（无 Map 结构变更） */
peek(key: string): Tile | undefined {
    return this._map.get(key);
}
```

#### 根因 B：base 底图被 LRU 淘汰（空白主因）

base 瓦片只在启动时请求一次。高 zoom（如 z=8）下，prefetch 只覆盖 targetZ-1..3，fallback 找到 z5 就返回、不再向上触碰 base，于是 base 长期不被 touch → **被 LRU 淘汰**。一旦快速缩小，兜底地板消失 → 中间空白且需重新请求。

**修复**：给 `TileCache` 增加**钉固（pin）**机制，预加载后把 base 瓦片钉固，使其永不被淘汰。

```ts
// TileCache：淘汰时跳过被钉固的 key
private _evict(): void {
    if (this._map.size <= this._capacity) return;
    const it = this._map.keys();
    let res = it.next();
    while (this._map.size > this._capacity && !res.done) {
        const key = res.value;
        res = it.next();           // 先推进迭代器再删除，保证遍历安全
        if (this._pinned.has(key)) continue;
        this.delete(key);
    }
}
```

```ts
// RasterTileLayer：预加载 base 后立即钉固
this._requestTile(coord, TileLoadPriority.Base);
this._cache.pin(tileKey(coord));
```

由于 base（z0..2）全覆盖且永久就绪，**任何 z≥minZoom 的 ideal 都至少能回退到 base 地板，从根本上杜绝空白**。

#### 根因 C：targetZ 在 0.5 边界震荡（请求风暴 + 闪烁）

`Math.round(desiredZ)` 在缩放过程中跨越 0.5 边界时，targetZ 在两个整数间反复跳变，每跳一次就请求一整套新 z 级瓦片（约 4 倍数量）并触发 GPU 上传风暴。

**修复**：引入**滞回（hysteresis）**——±0.6 死区 + 单步切换。

```ts
let targetZ: number;
if (this._lastGlobeZ < 0) {
    targetZ = Math.round(idealF);
} else if (idealF > this._lastGlobeZ + 0.6) {
    targetZ = this._lastGlobeZ + 1;   // 需要更清晰，升一级
} else if (idealF < this._lastGlobeZ - 0.6) {
    targetZ = this._lastGlobeZ - 1;   // 可以更粗，降一级
} else {
    targetZ = this._lastGlobeZ;       // 落在死区，保持不变
}
```

死区避免临界点反复横跳；单步切换保证每次最多换一级，配合 prefetch 预热相邻层级，缩放过渡平滑且无突发请求。

---

### 第三轮：高层级请求长期 pending（请求堆积阻塞）

#### 问题现象

层级较高（如 z≥14）平移 / 缩放时，DevTools Network 面板里**大量瓦片请求长期停在 "pending（待处理）"**，画面迟迟刷不出新瓦片；停止操作后要等很久才陆续补齐。

#### 根因 D：在途请求从不取消，旧请求堆积

`TileLoader` 早已实现 `cancel()`（含 `AbortController` 中止在途 fetch），但 `RasterTileLayer` **从未调用**。

高层级下每帧可见瓦片集合剧变。上一帧请求、尚未加载完成的瓦片滚出视野后，请求仍留在队列或在途 fetch 中，永不释放。它们持续占用浏览器连接槽，新进入视野的瓦片只能排在其后 → 表现为大量 pending。

**修复**：图层维护"在途瓦片集合" `_inflight`，每帧请求阶段结束后，取消所有本帧未被触达（`lastUsedFrame !== frame`）且未被钉固的瓦片。

```ts
// RasterTileLayer.onRender —— 请求阶段之后
if (this._inflight.size > 0) {
    for (const t of this._inflight) {
        if (t.lastUsedFrame !== frame && !this._cache.isPinned(t.key)) {
            this._loader.cancel(t);   // 队列中→移除；在途→abort 让出连接槽
            this._inflight.delete(t);
        }
    }
}
```

`_requestTile` 在入队时把瓦片加入 `_inflight`，加载完成 / 失败的回调里再移除；钉固的 base 底图永不取消。

#### 根因 E：`maxConcurrent=16` 远超浏览器单域名连接上限

浏览器对单一主机的并发连接数有限（HTTP/1.1 约 6）。OSM 默认源 `https://tile.openstreetmap.org/{z}/{x}/{y}.png` 是**单主机**（URL 无 `{s}`，`subdomains` 配置实为空操作），16 并发里约 10 个被压在浏览器自身的 pending 队列。

关键在于：一旦 `_loadOne` 被调用，条目就从优先级队列移除（`_index.delete`）。这些"浏览器 pending"请求**脱离调度器控制**——既不能再被 LIFO 重排，也无法被 `cancel` 及时中止，最新可见瓦片反而排到它们之后。

**修复**：默认 `maxConcurrent` 由 16 降到 **6**，贴合单域名连接上限。这样更多条目留在**我们自己的队列**里，可被 LIFO 重排与 `cancel` 丢弃，而不是涌入不可控的浏览器队列。多子域 / HTTP/2 源可按需调高。

> 根因 D 与 E 协同：D 主动 abort 滚出视野的在途请求，立即让出连接槽；E 控制派发节奏，让槽位始终服务于最新视图。

---

## 4. 修改文件清单

| 文件 | 修改要点 |
| --- | --- |
| `src/tile/TileLoader.ts` | `Base` 优先级提到最高（200）；默认 `maxConcurrent` 16→6 |
| `src/tile/TileCache.ts` | 新增 `peek()` 只读查询；新增 `pin/unpin` 钉固机制，淘汰时跳过钉固项 |
| `src/layers/RasterTileLayer.ts` | targetZ 以 desiredZ 为准 + 滞回；prefetch 每帧预算；fallback 改用 peek 且零请求；base 预加载后钉固；新增 `_inflight` 在途追踪，每帧取消滚出视野的请求；默认 `maxConcurrent` 16→6 |


---

## 5. 优化效果对比

| 场景 | 优化前 | 优化后 |
| --- | --- | --- |
| globe zoom=1 首屏 | 数百次 request + fallback 雪崩，卡死 | 少量 ideal + 21 张钉固 base + ≤32 prefetch |
| fallback 每帧开销 | 数百~数千次 Map 删/插 | 仅 `peek` 只读，零 Map 变更 |
| 缩放层级切换 | 边界反复跳变，请求/上传风暴 | ±0.6 死区单步切换，平滑无突发 |
| 兜底地板 | 可能被 LRU 淘汰 → 空白 | base 永久钉固 → 永不空白 |
| 渲染清晰度 | 被错误封顶 → 全程模糊 | 以 desiredZ 为准 → 像素级清晰 |
| 高层级平移/缩放 | 旧请求从不取消 + 16 并发涌入浏览器队列 → 大量 pending、新瓦片排队 | 滚出视野即 abort + 6 并发贴合连接上限 → 请求始终服务最新视图 |

三大根因（A 抖动 / B 空白 / C 震荡）相互协同：滞回减少层级切换频率，prefetch 预热相邻层级，钉固保证地板永在，peek 消除高频读的结构性开销。

---

## 6. 验证方法

1. 类型检查：`npx tsc --noEmit` 应无报错。
2. 构建：`npm run build`（或 `npm run dev` watch）。
3. 打开 `debug/index.html`，点击「3D 球体」：
   - **首屏**：zoom 1~2 时鼠标可立即流畅拖拽，不卡死。
   - **缩放**：滚轮连续缩放画面平滑，无明显闪烁。
   - **空白**：快速来回缩放，画面始终有内容（最差为略糊的 base 地板），无纯色空白。
   - **清晰度**：停在任意层级 1~2 秒后应清晰到位。
   - **Network 面板**：瓦片请求量平稳，无瞬时数百请求的尖峰。
4. **高层级请求堆积**验证（2D / 3D 均适用）：缩放到 z≥14，打开 Network 面板快速连续平移：
   - 滚出视野的请求应迅速变为 **canceled**，而非长期 pending。
   - 在途请求数稳定在 `maxConcurrent`（默认 6）附近，不再堆积。
   - 停止操作后当前视野瓦片应很快补齐。

---

## 7. 后续可选优化方向

- **缩放进行中延迟切级**：检测缩放速度，运动中保持当前层级，停稳后再加载目标层级，进一步减少中间请求。
- **GPU 纹理上传节流**：每帧限制 `_uploadToGPU` 次数，平滑突发上传带来的微卡顿。
- **子级回退（down-sampling）**：缩小瞬间用已加载的高清子瓦片临时填充，提升过渡清晰度（注意层级差过大时子瓦片数量爆炸，需限制 1~2 级）。
- **瓦片淡入 cross-fade 调优**：在层级切换时对新旧层做交叉淡化，进一步消除视觉跳变。

---

## 8. 倾斜视角（pitch / bearing）瓦片选择

### 8.1 问题现象

开启俯仰（pitch > 0）或旋转方位角（bearing ≠ 0）后，**远处（靠近地平线方向）的地图瓦片缺失**，视野上半部分出现空白；旋转时四角也会漏裁。

### 8.2 根因

平面模式原先用 `Camera.getVisibleWorldBounds()` 求一个**轴对齐的正交包围盒**来挑瓦片。该包围盒只在「正射俯视（pitch=0、bearing=0）」时与真实视野一致：

- **pitch > 0**：透视投影下可视区域是一个**向远处张开的梯形**，一直延伸到地平线。轴对齐盒子按视口高度估算范围，远端瓦片根本不会被请求 → 远处空白。
- **bearing ≠ 0**：可视矩形被旋转，轴对齐盒子无法覆盖旋转后的四角 → 边角漏裁。

球体模式的 `_getGlobeVisibleTiles` 同理：可视球冠半角只由 FOV 推算，未计入 pitch，俯仰后地平线方向的球冠被低估 → 远处瓦片缺失。

### 8.3 修复方案

**平面（mercator）倾斜/旋转：屏幕空间采样 + 逐瓦片 LOD**

当 `pitch ≠ 0 || bearing ≠ 0` 时，改用 `TilePyramid.getVisibleTilesTilted(camera, minZoom, maxZoom, dpr)`：

1. 在屏幕（CSS 像素）上以固定步长（约 64px）撒网格采样点；
2. 每个采样点用 `camera.unprojectToWorld` 做**射线-地面（z=0）求交**，落到世界坐标。地平线以上的点（射线 `t<0`）直接跳过，天然避免无穷大范围；
3. 用采样点与其邻域像素（+δ）的世界距离估算**该处的每像素世界尺度**，反推**局部所需层级**

   $$z_{\text{local}} = \log_2\!\left(\frac{\text{dpr}}{256 \cdot \text{worldPerCssPx}}\right)$$

   近处（视野底部）≈ 相机层级，远处（地平线方向）尺度被透视拉大 → 层级自动降低；
4. 把采样点所在瓦片按 `z_local` 收集去重。

这样**梯形视野铺满到地平线**，同时远处用低层级瓦片，瓦片总数被采样点数量上界约束（与视口面积成正比，约百级），不会随 pitch 爆炸。非倾斜的正北俯视仍走原有 `getVisibleTiles` 快路径，行为不变。

**球体（globe）俯仰：可视球冠按 pitch 外扩（限幅）+ 数量上限**

`_getGlobeVisibleTiles` 的可视半角叠加**限幅后的** pitch：

```ts
// 直接叠加完整 pitch 会让可视半角剧增、瓦片数量爆炸，
// 右键连续改变 pitch 时引发请求风暴导致卡死，因此必须限幅。
const pitchPad = Math.min(camera.getPitch() * 0.5, 0.25);
const visAng = Math.min(Math.PI, Math.max(visAngV, visAngH) + pitchPad + 1.5 * tileAngRadius);
```

并对一帧请求的 ideal 瓦片数设**硬上限**（按到视图中心的球面距离「近的优先」截断），作为兜底防止任何情况下的请求风暴：

```ts
const MAX_GLOBE_TILES = 200;
if (cand.length > MAX_GLOBE_TILES) {
    cand.sort((a, b) => b.cosD - a.cosD); // cosD 越大越近
    cand.length = MAX_GLOBE_TILES;
}
```

**球体俯仰的视角修正（相机绕焦点轨道旋转）**

早期实现把俯仰写成 `pitchMat * view`（绕相机自身旋转），导致地球中心被甩出画面、视角错乱。正确做法是让相机**绕焦点（球面正对点 `(0,0,1)`）做轨道旋转**，焦点恒居屏幕中心：

```ts
const r = d - 1;                 // 相机到焦点的距离
const eye = pitch === 0 ? [0,0,d] : [0, -r*sin(pitch), 1 + r*cos(pitch)];
const up  = pitch === 0 ? [0,1,0] : [0, cos(pitch), sin(pitch)];
const target = pitch === 0 ? [0,0,0] : [0,0,1];
mat4.lookAt(view, eye, target, up);
// near/far 依据俯仰后的实际相机距球心距离 eyeDist=√(r²+1+2r·cos(pitch)) 计算
```

### 8.4 修改文件

| 文件 | 修改要点 |
| --- | --- |
| `src/tile/TilePyramid.ts` | 新增 `getVisibleTilesTilted`：屏幕空间采样 + 射线落地 + 逐采样点 LOD + 去重 |
| `src/camera/Camera.ts` | globe 俯仰改为相机绕焦点 `(0,0,1)` 轨道旋转（焦点居中），near/far 按俯仰后实际相机距离计算 |
| `src/layers/RasterTileLayer.ts` | 平面 `pitch≠0 \|\| bearing≠0` 时改用 `getVisibleTilesTilted`；globe 可视半角叠加**限幅** pitch（≤0.25）+ ideal 瓦片数硬上限 200（近距优先截断）防卡死 |

### 8.5 验证

打开 `debug/events.html`：

- **2D 俯仰**：右键上下拖拽抬高俯仰角（或「俯仰 +15°」按钮到 60°），视野梯形应**铺满到地平线**，上半部分无空白。
- **2D 旋转**：右键左右拖拽改变方位角，旋转后的四角应被瓦片完整覆盖。
- **3D 俯仰**：切到「3D 球体」后抬高俯仰角，焦点应**始终居中**（地球不偏出画面），地平线方向瓦片正常加载，球面无大块空白。
- **3D 右键拖拽不卡死**：在球体上右键连续拖拽改变俯仰/方位角，主线程应保持流畅，不再因瓦片请求风暴卡死。

## 9. 球体大俯仰角下的画质问题（锯齿 + 底部遮挡）

### 9.1 问题现象

3D 球体模式下右键抬高俯仰角后：

1. **远处切片锯齿化严重**：靠近地平线的瓦片被极度缩小，纹理闪烁/摩尔纹明显。
2. **底部切片被遮挡**：画面下方中央出现一块带尖锐直边的三角形「空洞」，露出低清底图。

### 9.2 根因

1. **锯齿**：瓦片纹理只上传了 mip level 0，且采样器 `mipmapFilter:'nearest'`。掠射角下一个瓦片在屏幕上仅占几个像素，单层纹理点采样必然走样。
2. **三角形空洞**：渲染管线启用了 `depthWriteEnabled:true` + `depthCompare:'less-equal'` 做瓦片间深度遮挡。但球面是用 `32×32` 镶嵌网格的**平面三角形近似**——不同覆盖范围 / 不同细分级别的瓦片（如兜底底图 vs ideal 瓦片）对同一球面的逼近误差不同，较粗的网格三角形会**凸出**到较细瓦片之前，在掠射角下沿网格三角形对角线发生 z-fighting，表现为带直边的三角形空洞。

### 9.3 修复方案

1. **Mipmap + 三线性 / 各向异性过滤**（解决锯齿）：
   - 主采样器改为 `magFilter/minFilter/mipmapFilter = linear`，`maxAnisotropy:16`。
   - 每张瓦片纹理按 `mipLevelCount = floor(log2(size))+1` 创建，上传 level 0 后用一条轻量「全屏三角形降采样」管线（`_ensureMipPipeline` / `_generateMips`）逐级 render 生成完整 mip 链（WebGPU 无内置 `generateMipmap`）。

2. **改用绘制顺序合成，关闭瓦片间深度测试**（解决三角形空洞）：
   - 远侧半球已由 `cullMode:'back'` 背面剔除；前侧半球瓦片在球面上互不重叠，无需深度缓冲做相互遮挡。
   - 管线改为 `depthWriteEnabled:false` + `depthCompare:'always'`，按「先粗兜底、后 ideal」的绘制顺序合成，彻底消除球面近似误差导致的 z-fighting。

### 9.4 修改文件

| 文件 | 修改要点 |
| --- | --- |
| `src/layers/RasterTileLayer.ts` | 主采样器改三线性 + `maxAnisotropy:16`；瓦片纹理生成完整 mip 链（新增 `_ensureMipPipeline` / `_generateMips`）；渲染管线深度状态改为 `depthWrite:false` + `depthCompare:'always'`，依赖背面剔除 + 绘制顺序合成 |

### 9.5 验证

打开 `debug/events.html` → 「3D 球体」，抬高俯仰角到 50°~60°：

- **远处不锯齿**：地平线方向被缩小的瓦片应平滑过渡，无闪烁/摩尔纹。
- **底部无空洞**：画面下方应被瓦片完整覆盖，不再出现带直边的三角形低清块。
