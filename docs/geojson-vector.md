# GeoJSON 矢量数据加载功能

> 为 webgpu-geo 引擎新增的点 / 线 / 面矢量渲染能力，设计参考 Mapbox GL 的
> source + paint 模型，原生支持 `mercator` 平面与 `globe` 球面两种投影。

---

## 1. 功能概览

| 几何类型 | GeoJSON 类型 | 渲染方式 |
| --- | --- | --- |
| 面 | `Polygon` / `MultiPolygon` | earcut 三角剖分填充（支持带洞多边形） |
| 线 | `LineString` / `MultiLineString` | 屏幕空间等宽挤出 + miter join |
| 点 | `Point` / `MultiPoint` | 实例化圆 billboard（填充 + 描边 + 抗锯齿） |

核心特性：

- **零额外依赖**：earcut 三角剖分、颜色解析均为引擎内置实现。
- **一图层多几何**：单个 `GeoJSONLayer` 同时渲染点/线/面，三条独立管线。
- **数据驱动样式**：paint 取值支持 `['get', '字段名']` 从 `feature.properties` 取值。
- **双投影一致**：所有几何投影到归一化 Mercator 世界坐标 `[0,1]`，球面映射在顶点着色器内完成，2D/3D 自动适配。
- **远程 / 内联数据**：支持传入 GeoJSON 对象或远程 URL（自动 `fetch`）。
- **动态更新**：`setData` / `setPaint` 运行时替换数据或样式。

---

## 2. 快速上手

```ts
import { Map } from 'webgpu-geo';

const map = new Map({
    container: 'map',
    center: { lng: 110, lat: 34 },
    zoom: 3,
    tileSource: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png' },
});
await map.ready();

// 便捷方法：返回 GeoJSONLayer 实例
const layer = map.addGeoJSON({
    data: {
        type: 'FeatureCollection',
        features: [{
            type: 'Feature',
            properties: { name: '北京' },
            geometry: { type: 'Point', coordinates: [116.4, 39.9] },
        }],
    },
    paint: {
        circleColor: '#e63946',
        circleRadius: 8,
        circleStrokeColor: '#fff',
        circleStrokeWidth: 2,
    },
});
```

也可显式构造图层后用 `addLayer`：

```ts
import { GeoJSONLayer } from 'webgpu-geo';

const layer = new GeoJSONLayer({ data: './regions.geojson', paint: { fillColor: '#3bb2d0' } });
map.addLayer(layer);
```

> 在线示例：[`debug/geojson.html`](../debug/geojson.html)，运行 `npm run serve` 后访问。

---

## 3. API

### 3.1 `Map.addGeoJSON(options): GeoJSONLayer`

便捷创建并添加矢量图层，返回图层实例。

### 3.2 `GeoJSONLayerOptions`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `data` | `FeatureCollection \| Feature \| Geometry \| string` | 内联 GeoJSON 或远程 URL |
| `paint` | `GeoJSONPaint` | 样式（见下） |

### 3.3 `GeoJSONPaint`

颜色支持 `#rgb` / `#rrggbb` / `#rrggbbaa` / `rgb()` / `rgba()` / 颜色名 / `[r,g,b,a]`（0..1）。
带 `PaintValue<T>` 标注的字段可取常量或 `['get', '字段名']` 数据驱动表达式。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `fillColor` | `PaintValue<ColorLike>` | `#3bb2d0` | 面填充色 |
| `fillOpacity` | `number` | `0.5` | 面透明度 |
| `fillOutlineColor` | `ColorLike` | — | 设置后多边形边界以线渲染 |
| `fillOutlineWidth` | `number` | `1` | 描边宽（px） |
| `lineColor` | `PaintValue<ColorLike>` | `#3bb2d0` | 线颜色 |
| `lineWidth` | `PaintValue<number>` | `2` | 线宽（CSS px） |
| `lineOpacity` | `number` | `1` | 线透明度 |
| `circleColor` | `PaintValue<ColorLike>` | `#ee6352` | 圆填充色 |
| `circleRadius` | `PaintValue<number>` | `5` | 圆半径（CSS px） |
| `circleOpacity` | `number` | `1` | 圆透明度 |
| `circleStrokeColor` | `PaintValue<ColorLike>` | `#ffffff` | 圆描边色 |
| `circleStrokeWidth` | `PaintValue<number>` | `1` | 圆描边宽（CSS px） |

### 3.4 `GeoJSONLayer` 实例方法

| 方法 | 说明 |
| --- | --- |
| `setData(data)` | 替换数据并重建几何 |
| `setPaint(paint)` | 合并更新样式并重建几何 |
| `visible: boolean` | 显隐开关（改后需 `map.renderer.requestRender()`） |

### 3.5 其它导出

```ts
import {
    GeoJSONLayer, GeoJSONSource,
    parseColor, earcut,
    type GeoJSONData, type Feature, type FeatureCollection,
    type Geometry, type Position, type ColorLike, type PaintValue,
} from 'webgpu-geo';
```

---

## 4. 数据驱动样式示例

```ts
map.addGeoJSON({
    data: provinces,                 // 每个 feature.properties 带 color / width
    paint: {
        fillColor: ['get', 'color'], // 按要素属性着色
        fillOpacity: 0.45,
        fillOutlineColor: '#ffffff',
        lineWidth: ['get', 'width'],
    },
});
```

`['get', 'color']` 会在构建几何时对每个要素读取 `feature.properties.color`；
解析后的颜色被写入顶点属性，因此**同类几何仍只需一次 draw call**，兼顾灵活与性能。

---

## 5. 架构与实现

### 5.1 模块划分

```
src/
  geojson/
    types.ts          GeoJSON 类型定义（RFC 7946 子集）
    GeoJSONSource.ts  数据加载 / 规范化（URL fetch、GeometryCollection 展开）
    earcut.ts         多边形三角剖分（耳切法，支持带洞）
    color.ts          颜色解析 → 归一化 RGBA
    geometry.ts       要素 → GPU 顶点/索引数据（点/线/面）
  shaders/
    geojson.wgsl.ts   fill / line / circle 三个 WGSL 着色器
  layers/
    GeoJSONLayer.ts   组合图层：建管线、传 uniform、上传缓冲、逐帧绘制
```

### 5.2 数据流

```
GeoJSONData ─► GeoJSONSource.normalize ─► Feature[]
                                            │
              ┌─────────────────────────────┼─────────────────────────────┐
              ▼                             ▼                             ▼
        buildFillMesh                 buildLineMesh               buildCircleInstances
       (earcut 三角剖分)            (miter 挤出折线)            (每点一个实例)
              │                             │                             │
              ▼                             ▼                             ▼
        Fill VBO/IBO                  Line VBO/IBO                Circle Instance VBO
              └─────────────► GeoJSONLayer.onRender 逐帧绘制 ◄────────────┘
```

### 5.3 坐标系统一

所有经纬度经 `Mercator.lngLatToWorld` 投影到归一化世界坐标 `[0,1]`（与栅格瓦片图层同坐标系）。顶点着色器中：

- **mercator**：直接 `viewProj * vec4(world, 0, 1)`。
- **globe**：先 `mercator_to_sphere(world)` 把世界坐标映射到单位球面，再乘 `viewProj`。

$$
\text{lng} = (x - 0.5)\cdot 2\pi,\quad
\text{lat} = \arctan\!\big(\sinh(\pi(1-2y))\big)
$$
$$
\mathbf{p} = \big(\cos\text{lat}\sin\text{lng},\; \sin\text{lat},\; \cos\text{lat}\cos\text{lng}\big)
$$

这一设计使矢量数据**无需任何改动即可在 2D/3D 间切换**。

### 5.4 面：earcut 三角剖分

- 外环 + 各洞扁平化为坐标数组，记录洞的起始顶点索引。
- `earcut(flat, holeIndices)` 返回三角形索引：
  1. 构建双向循环链表，按缠绕方向规整；
  2. 把每个洞通过"桥"并入外环形成单一简单多边形；
  3. 反复裁剪"耳朵"直至只剩三角。
- 顶点布局：`x, y, r, g, b, a`（6 floats）。

### 5.5 线：屏幕空间 miter 挤出

CPU 端为每个折线顶点计算带 miter 缩放的世界空间法向量（相邻段法线平均，miter 长度上限钳制 4 以避免尖角过冲），每点生成 `±normal` 两个挤出顶点。

顶点着色器把线宽按**屏幕像素**施加，保证任意缩放下线宽恒定：

```
c0 = project(pos)
c1 = project(pos + normal * EPS)     // 投影差分求屏幕法向
dirPx = normalize((c1/c1.w - c0/c0.w) * viewport)
offset = dirPx * halfWidthPx * miterLen
ndc    = offset / viewport * 2 * c0.w   // 抵消透视除法
```

差分法对 mercator 与 globe 同样成立（只要 `project` 一致），因此线宽在球面上也保持像素恒定。顶点布局：`x, y, nx, ny, r, g, b, a, width`（9 floats）。

### 5.6 点：实例化圆 billboard

每个点一个 instance，共享一个单位方块（6 顶点两三角）。顶点着色器把方块角点按 `半径 + 描边宽` 在屏幕空间扩展（screen-aligned billboard）；片元着色器按到圆心像素距离做填充/描边过渡并在外缘做 1px 抗锯齿。

实例布局：`cx, cy, r,g,b,a, radius, sr,sg,sb,sa, strokeWidth`（12 floats）。

### 5.7 渲染状态

- **混合**：预乘 alpha（`one` / `one-minus-src-alpha`），与栅格图层一致。
- **深度**：`depthWriteEnabled=false`，`depthCompare='always'`。矢量几何由稀疏顶点构成，其平面三角/线段的"弦"会陷入单位球内部；若与精细镶嵌的栅格球面做 `less-equal` 深度测试会被错误遮挡（大面整个消失）。因此关闭对栅格的深度遮挡，globe 背面改由**着色器逐像素地平线剔除**处理（见 5.9）。
- **MSAA**：复用引擎的 4× 采样。
- **绘制顺序**：面 → 线 → 点（点在最上层）。

### 5.8 性能要点

- 每种几何整体合批，**一次 draw call**（点为单次实例化绘制）。
- 几何在数据/样式变更时一次性构建并上传，逐帧仅更新一个 96 字节的全局 uniform。
- 索引使用 `uint32`，支持大规模多边形。

### 5.9 globe 背面剔除（地平线裁剪）

3D 球体模式下，矢量几何不依赖深度缓冲与栅格球面比较（见 5.7），而是在着色器中按**地平线可见性**逐像素剔除背侧要素：

- 全局 uniform 追加 `params2`：`xyz` = 视图中心方向的单位球面向量 $\mathbf{C}$，`w` = $1/d$（$d$ 为相机到球心距离）。
- 顶点着色器计算 $\mathrm{vis} = \mathbf{P}\cdot\mathbf{C}$（$\mathbf{P}$ 为顶点的单位球面坐标），作为 varying 插值到片元。
- 片元着色器中当 $\mathrm{vis} < 1/d$ 时 `discard`：因相机在距球心 $d$ 处，地平线恰为 $\mathbf{P}\cdot\mathbf{C}=\cos\theta_h=1/d$，越过即落在地球背侧。

该方案每顶点仅一次点积、每片元一次比较，开销极小，且能在不依赖三角镶嵌精度的情况下正确隐藏地球背面、消除"弦下沉"导致的整面消失。`mercator` 平面模式下 `params.x=0`，恒不剔除。

---

## 6. 已知限制与后续可扩展方向

- earcut 未含 z-order 哈希加速，超大多边形（数万顶点）三角剖分为 O(n²) 最坏复杂度；常规地图数据足够。
- 线为 miter join，未实现 round/bevel join 与端点 cap、虚线（dash）。
- globe 模式背面通过地平线裁剪剔除（见 5.9）；恰好跨地平线的大要素以逐像素方式裁剪，边缘平滑。
- 暂未实现要素拾取（hit-test）与按缩放级别插值的 paint 表达式。

这些均可在现有 `geometry.ts` / 着色器基础上增量扩展。
