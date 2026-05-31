# 事件体系（Event System）

webgpu-geo 的事件体系参考 [mapbox-gl-js](https://docs.mapbox.com/mapbox-gl-js/api/map/#map-events) 的事件语义设计，提供一套**完整、高效、简明易用**的交互事件能力，覆盖：

- 地图级鼠标/触摸/滚轮事件（`click` / `mousemove` / `wheel` / `touchstart` …）
- 图层级要素事件（带要素拾取的 `click` / `mouseenter` / `mouseleave` …）
- 视图变换事件（`movestart` / `move` / `moveend` / `zoom` / `rotate` / `pitch` …）
- 内置相机交互（左键平移、**右键拖拽旋转/俯仰**、滚轮缩放、触摸手势，2D/3D 通用）
- 生命周期事件（`load` / `resize` / `remove`）
- 坐标投影 API（`project` / `unproject`）与要素查询（`queryRenderedFeatures`）

> 在线体验：`debug/events.html`

---

## 1. 快速上手

```js
const map = new ai.Map({
    container: 'map',
    center: { lng: 110, lat: 34 },
    zoom: 3,
    tileSource: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', subdomains: ['a','b','c'] }
});
await map.ready();

// 地图级事件
map.on('click', (e) => {
    console.log('点击经纬度', e.lngLat, '屏幕坐标', e.point);
});

// 视图变换事件
map.on('moveend', () => console.log('视图停止移动', map.getCenter(), map.getZoom()));

// 图层级要素事件（需要图层带 id）
const layer = map.addGeoJSON({ id: 'cities', data: geojson, paint: { circleRadius: 8 } });
map.on('click', 'cities', (e) => {
    console.log('命中要素', e.features[0].properties);
});
```

---

## 2. 核心 API

### 2.1 `Evented` 基类

`Map` 与 `Layer` 均继承自 `Evented`，提供统一的发布/订阅接口：

| 方法 | 说明 |
| --- | --- |
| `on(type, listener)` | 注册监听 |
| `once(type, listener)` | 一次性监听；省略 `listener` 时返回 `Promise`，可 `await map.once('load')` |
| `off(type?, listener?)` | 取消监听：无参清空全部 / 仅 `type` 清空该类型 / `type+listener` 精确移除 |
| `fire(type, event)` | 主动触发事件（一般供内部使用，也可用于自定义事件） |
| `listens(type)` | 是否存在该类型监听者（热点路径短路判断） |

实现要点：

- 触发时对监听器数组**浅拷贝快照**，允许在回调内安全地增删监听器；
- `once` 通过包装实现，`off` 仍可用「原始函数引用」精确移除；
- 监听器内 `this` 指向当前 `Evented` 实例。

### 2.2 `Map.on` 的两种形式

```js
map.on('click', handler);             // 地图级
map.on('click', 'layerId', handler);  // 图层级（命中该图层要素时触发，event.features 携带命中要素）
```

`off` / `once` 同样支持这两种形式。图层级监听本质上是把回调注册到对应 `Layer`（`Layer` 也是 `Evented`），因此也可以直接：

```js
layer.on('click', handler);
```

---

## 3. 事件分类与事件对象

### 3.1 地图级鼠标事件 `MapMouseEvent`

类型：`mousedown` `mouseup` `mousemove` `mouseover` `mouseout` `click` `dblclick` `contextmenu`

```ts
interface MapMouseEvent {
    type: string;
    target: Map;
    layer?: Layer;            // 仅图层级事件
    originalEvent: MouseEvent;
    point: { x, y };          // canvas 内 CSS 像素
    lngLat: { lng, lat };     // 该屏幕位置对应经纬度
    features?: Feature[];     // 命中要素（地图级事件携带最顶层命中图层的要素）
    defaultPrevented: boolean;
    preventDefault(): void;
}
```

### 3.2 图层级要素事件

类型：`click` `dblclick` `contextmenu` `mousedown` `mouseup` `mousemove` `mouseenter` `mouseleave` `mouseover` `mouseout`

- 仅当图层 `visible && interactive` 且对该事件类型存在监听时，才会进行命中测试（按需拾取，零监听零开销）；
- `event.features` 为该图层在指针位置命中的要素列表，顺序为「顶层优先」；
- `mouseenter` / `mouseleave` 由 `mousemove` 的命中结果派生：要素从「无命中 → 有命中」触发 enter，反之触发 leave。

```js
map.on('mouseenter', 'cities', (e) => {
    map.engine.canvas.style.cursor = 'pointer';
    showPopup(e.features[0]);
});
map.on('mouseleave', 'cities', () => {
    map.engine.canvas.style.cursor = '';
    hidePopup();
});
```

### 3.3 滚轮事件 `MapWheelEvent`

类型：`wheel`，携带 `point` / `lngLat` / `originalEvent`。

### 3.4 触摸事件 `MapTouchEvent`

类型：`touchstart` `touchmove` `touchend`

```ts
interface MapTouchEvent {
    points: { x, y }[];    // 所有触点（CSS 像素）
    point: { x, y };       // 触点几何中心
    lngLat: { lng, lat };  // 中心对应经纬度
    lngLats: LngLat[];     // 各触点经纬度
    // ...
}
```

单指轻点（无明显位移）会被合成为一次 `click`，并对图层做要素拾取。

### 3.5 视图变换事件 `MapCameraEvent`

| 维度 | 事件序列 |
| --- | --- |
| 平移/任意视图变化 | `movestart` → `move`（多次）→ `moveend` |
| 拖拽（指针） | `dragstart` → `drag`（多次）→ `dragend` |
| 缩放 | `zoomstart` → `zoom` → `zoomend` |
| 旋转 | `rotatestart` → `rotate` → `rotateend` |
| 倾斜 | `pitchstart` → `pitch` → `pitchend` |

派生规则：

- `move` / `zoom` / `rotate` / `pitch` 通过对相机状态做**前后帧差分**得到，因此**程序化调用**（`map.setCenter` / `map.setZoom` / `map.setBearing` / `map.setPitch`）与**交互操作**都会触发；
- 与 mapbox 一致，缩放/旋转/倾斜也会附带触发一次 `move`；
- `*end` 采用 **200ms 防抖**：连续变化停止 200ms 后触发，避免每帧抖动；
- `drag*` 基于指针「按下-移动-抬起」派生，与相机平移解耦。

### 3.6 生命周期事件

| 事件 | 触发时机 |
| --- | --- |
| `load` | 引擎初始化完成、首帧渲染后 |
| `resize` | 容器尺寸变化（`ResizeObserver`） |
| `remove` | `map.destroy()` 调用时 |

---

## 4. 交互操作（鼠标 / 触摸）

内置相机交互由 `MapInteraction` 负责，与事件分发（`MapEventManager`）解耦。所有手势在 **2D（mercator）与 3D（globe）两种投影下行为一致**。

### 4.1 鼠标

| 操作 | 效果 |
| --- | --- |
| 左键拖拽 | 平移地图 |
| **右键拖拽** | 水平方向改变**方位角 bearing**，垂直方向改变**俯仰角 pitch** |
| `Ctrl`/`Cmd` + 左键拖拽 | 同右键拖拽（旋转 / 俯仰），方便无右键设备 |
| 滚轮 | 以光标处为锚点缩放 |

- 向右拖拽 → 顺时针旋转（bearing 减小）；向上拖拽 → 俯仰角增大（地图更倾斜）；
- 俯仰角范围 `0°–60°`（`Camera.MAX_PITCH`），方位角无限制（自动环绕）；
- 右键拖拽时会自动屏蔽浏览器右键菜单（`contextmenu` 引擎事件仍可在快速右击时触发）。

灵敏度可通过常量调整：`MapInteraction.ROTATE_SPEED`、`MapInteraction.PITCH_SPEED`（弧度/像素）。

### 4.2 触摸

| 操作 | 效果 |
| --- | --- |
| 单指拖拽 | 平移地图 |
| 双指捏合 | 以双指中心为锚点缩放 |
| 双指扭转 | 改变方位角 bearing |
| 双指同向上下拖拽 | 改变俯仰角 pitch |

缩放、旋转、俯仰在双指手势中**同时生效**，与 mapbox 触摸体验一致。

### 4.3 程序化控制

```js
map.setBearing(30);   // 方位角（角度，0=正北，顺时针为正）
map.setPitch(45);     // 俯仰角（角度，0=正俯视，最大 60）
map.getBearing();     // → 30
map.getPitch();       // → 45
```

这些调用同样会触发对应的 `rotate*` / `pitch*` / `move*` 事件。

---

## 5. 坐标投影与要素查询

```js
// 经纬度 → 屏幕 CSS 像素
const pt = map.project({ lng: 116.4, lat: 39.9 });

// 屏幕 CSS 像素 → 经纬度
const ll = map.unproject({ x: 400, y: 300 });

// 查询屏幕点下命中的要素（含所属图层）
const picked = map.queryRenderedFeatures({ x: 400, y: 300 }, {
    layers: ['cities'],   // 可选：限定图层
    tolerance: 4          // 可选：命中容差（CSS 像素）
});
// picked: { feature, layer }[]
```

`project` / `unproject` 在 **mercator** 与 **globe** 两种投影下、且在**任意 bearing / pitch** 下均可用：

- mercator（无倾斜无旋转）：正交反算，精确；
- mercator（有 pitch 或 bearing）：用透视 `viewProj` 矩阵投影；`unproject` 通过相机射线与地图平面 `z=0` 求交，射线指向地平线以上时返回 `{ lng: NaN, lat: NaN }`；
- globe：复用着色器的 `mercator→球面` 映射经 `viewProj` 投影；`unproject` 用相机射线与单位球求交，未命中地球时返回 `{ lng: NaN, lat: NaN }`。

---

## 6. 要素拾取（Hit Testing）原理

拾取统一在 **屏幕 CSS 像素空间** 进行，从而线/点容差能以像素表达、且 mercator 与 globe 复用同一套逻辑（投影差异封装在 `Camera.projectWorld` 内，倾斜 / 旋转后依然正确）：

| 几何 | 判定方式 |
| --- | --- |
| `Polygon` / `MultiPolygon` | 外环投影为屏幕多边形，**射线法**判断内部；落在洞内则排除 |
| `LineString` / `MultiLineString` | 点到折线最近距离 ≤ `lineWidth/2 + tolerance` |
| `Point` / `MultiPoint` | 点到圆心距离 ≤ `circleRadius + circleStrokeWidth + tolerance` |

globe 模式下，位于**背面（不可见半球）**的顶点会被自动跳过（地平线 `dot` 阈值 `cosθ = 1/d`，与着色器保持一致）。

`Layer.hitTest(point, camera, dpr, tolerance)` 为可重写接口，基类默认返回 `[]`，`GeoJSONLayer` 已实现；`RasterTileLayer` 默认 `interactive = false`，不参与拾取。

---

## 7. 架构与数据流

```
浏览器 DOM 事件 (canvas)
        │
        ▼
  MapEventManager  ──► 计算 point(CSS px) / lngLat(unproject)
        │                       │
        │                       └─► 对「有监听的可交互图层」做 hitTest（按需拾取）
        ▼
   map.fire(type)  ──► 地图级监听器
   layer.fire(type)──► 图层级监听器（携带 features）

相机状态变化 (Camera.onChange)
        │
        ▼
   Map._emitCameraEvents() ──► 差分 + 防抖 ──► move/zoom/rotate/pitch (+ start/end)
```

模块职责：

| 模块 | 文件 | 职责 |
| --- | --- | --- |
| `Evented` | [src/events/Evented.ts](../src/events/Evented.ts) | 通用发布/订阅基类 |
| 事件类型 | [src/events/MapEvent.ts](../src/events/MapEvent.ts) | 事件对象与类型定义 |
| `MapEventManager` | [src/control/MapEvents.ts](../src/control/MapEvents.ts) | DOM 事件 → 引擎事件，命中测试，悬停/拖拽派生 |
| 命中测试工具 | [src/control/hitTest.ts](../src/control/hitTest.ts) | 屏幕空间几何判定（点/线/面） |
| `Camera` 投影 | [src/camera/Camera.ts](../src/camera/Camera.ts) | `projectWorld` / `unprojectToWorld` / 球面互转 |
| `Layer` | [src/layers/Layer.ts](../src/layers/Layer.ts) | 继承 Evented，`id` / `interactive` / `hitTest` |
| `GeoJSONLayer` | [src/layers/GeoJSONLayer.ts](../src/layers/GeoJSONLayer.ts) | 实现矢量要素 `hitTest` |
| `Map` | [src/Map.ts](../src/Map.ts) | 事件 API、`project`/`unproject`/`queryRenderedFeatures`、视图变换事件派生 |
| `MapInteraction` | [src/control/MapInteraction.ts](../src/control/MapInteraction.ts) | 相机平移/缩放/旋转/俯仰（与事件解耦） |

设计要点：

- **解耦**：相机交互（`MapInteraction`）与事件分发（`MapEventManager`）互不依赖，可独立演进；
- **按需拾取**：仅当存在图层监听时才做命中测试，静止/无监听时零开销；
- **统一坐标**：所有命中测试在屏幕像素空间完成，两种投影复用同一逻辑。

---

## 8. 事件类型速查表

| 分类 | 事件名 | 事件对象 | 携带要素 |
| --- | --- | --- | --- |
| 鼠标 | `mousedown` `mouseup` `mousemove` `mouseover` `mouseout` `click` `dblclick` `contextmenu` | `MapMouseEvent` | 图层级时有 |
| 悬停（图层） | `mouseenter` `mouseleave` | `MapMouseEvent` | 是 |
| 滚轮 | `wheel` | `MapWheelEvent` | 否 |
| 触摸 | `touchstart` `touchmove` `touchend` | `MapTouchEvent` | tap 合成 click 时有 |
| 视图 | `movestart` `move` `moveend` `dragstart` `drag` `dragend` `zoomstart` `zoom` `zoomend` `rotatestart` `rotate` `rotateend` `pitchstart` `pitch` `pitchend` | `MapCameraEvent` | 否 |
| 生命周期 | `load` `resize` `remove` | `MapCameraEvent` | 否 |

---

## 9. 与 mapbox-gl 的差异

- 图层引用使用 `Layer.id`（字符串）或直接传 `Layer` 实例，未实现样式表达式过滤器；
- `queryRenderedFeatures` 当前需要传入屏幕点（不支持空参返回整屏要素 / box 查询）；
- globe 模式拾取会跳过背面，复杂多边形在极高纬度的投影为近似；
- `wheel` / `touch` 事件不阻断内置相机交互（如需自定义可在回调内自行处理）。
