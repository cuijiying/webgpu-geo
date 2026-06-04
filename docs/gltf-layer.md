# glTF / glb 模型图层加载功能

> 为 webgpu-geo 引擎新增的 3D 模型加载能力：把任意 glTF 2.0 / glb 模型按经纬度、
> 高度与朝向放置到地图上，原生支持 `mercator` 平面与 `globe` 球面两种投影。

---

## 1. 功能概览

| 能力 | 说明 |
| --- | --- |
| 容器格式 | `.glb`（二进制）与 `.gltf`（外部 / data-URI buffer、外部 / 内嵌图片） |
| 几何 | TRIANGLES / TRIANGLE_STRIP / TRIANGLE_FAN，节点层级 TRS / matrix 变换烘焙 |
| 材质 | `pbrMetallicRoughness.baseColorFactor` + 基色贴图、`emissiveFactor`、`alphaMode`（OPAQUE/MASK/BLEND）、`doubleSided` |
| 法线 | 读取 NORMAL；缺失时按面法线自动生成 |
| 纹理 | sRGB 基色贴图 + 渲染式 mipmap（消除倾斜视角走样）+ 各向异性过滤 |
| 放置 | 经纬度 / 椭球高 + heading / pitch / roll + 均匀或三轴缩放 |
| 投影 | 同一图层在 2D / 3D 间自动切换，无需重载模型 |

核心设计：

- **地理放置**：模型局部坐标（米）经站心 ENU 基底变换到引擎空间，赤道与高纬度均正确贴地。
- **双投影一致**：每帧依据相机投影选择 `buildPlacementGlobe` / `buildPlacementMercator` 重建模型矩阵。
- **按需重绘**：模型加载完成或放置参数变化时才触发渲染，静止时不占用 GPU。
- **零额外依赖**：glb 解析、accessor 读取、mipmap 生成均为引擎内置实现（仅复用 `gl-matrix`）。

---

## 2. 快速上手

```ts
import { Map } from 'webgpu-geo';

const map = new Map({
    container: 'map',
    center: { lng: 116.4074, lat: 39.9042 },
    zoom: 16,
    projection: 'globe',
    tileSource: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png' },
});
await map.ready();

// 便捷方法：返回 GLTFLayer 实例
const model = map.addGLTF({
    url: 'https://example.com/models/Duck.glb',
    lng: 116.4074,
    lat: 39.9042,
    altitude: 0,     // 离地高度（米）
    heading: 30,     // 朝向（度，0=面向北，顺时针为正）
    scale: 200,      // 放大系数（Duck 模型约 1.7 米，×200≈340 米，便于观察）
});

model.on('load', () => console.log('模型已加载'));
model.on('error', (e) => console.error(e.error));
```

也可手动创建并 `addLayer`：

```ts
import { GLTFLayer } from 'webgpu-geo';

const layer = new GLTFLayer({ url: '/models/building.glb', lng: 116.4, lat: 39.9 });
map.addLayer(layer);
```

在线示例见 [debug/gltf.html](../debug/gltf.html)。

---

## 3. API

### 3.1 `GLTFLayerOptions`

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `url` | `string` | — | 模型地址（`.gltf` 或 `.glb`），**必填** |
| `lng` / `lat` | `number` | — | 放置经纬度（度），**必填** |
| `altitude` | `number` | `0` | 椭球高 / 离地高度（米） |
| `heading` | `number` | `0` | 偏航角（度，绕本地“上”轴，0=面向北，顺时针为正） |
| `pitch` | `number` | `0` | 俯仰角（度，绕本地“东”轴） |
| `roll` | `number` | `0` | 翻滚角（度，绕本地“前”轴） |
| `scale` | `number \| [x,y,z]` | `1` | 均匀或三轴缩放（非均匀缩放经法线矩阵正确处理） |
| `lightDirection` | `[x,y,z]` | `[0.3, 1.0, 0.25]` | 方向光，定义在本地 ENU（x=东 / y=上 / z=南），随放置基底变换，故两投影下光照一致 |
| `ambientColor` | `[r,g,b]` | `[0.35,0.35,0.38]` | 环境光颜色（0..1） |
| `lightIntensity` | `number` | `0.9` | 方向光强度 |
| `id` | `string` | 自动 | 图层 id |
| `loadOptions` | `GltfLoadOptions` | — | 透传给 `fetch`（headers / signal 等） |

### 3.2 `GLTFLayer` 方法与事件

| 成员 | 说明 |
| --- | --- |
| `setPlacement(params)` | 运行时更新 `lng/lat/altitude/heading/pitch/roll/scale`，下一帧生效 |
| `visible` | 显隐开关（改后调用 `map.renderer.requestRender()`） |
| `on('load', fn)` | 模型加载并上传 GPU 完成 |
| `on('error', fn)` | 加载 / 解析失败，`e.error` 为错误对象 |

### 3.3 底层工具

```ts
import { loadGltf, buildPlacementGlobe, buildPlacementMercator } from 'webgpu-geo';

const model = await loadGltf('/models/a.glb');     // → ParsedModel（与 GPU 无关）
const mats = { model: new Float32Array(16), normal: new Float32Array(12) };
buildPlacementGlobe({ lng: 116.4, lat: 39.9, scale: 100 }, mats);
```

---

## 4. 坐标与放置原理

### 4.1 局部坐标轴映射（站心 ENU）

模型局部坐标按「米」解释，轴向映射到站心坐标系：

```
localX → 东 (East)
localY → 上 (Up)
localZ → 南 (South)   // 即 glTF 默认 -Z（前方）指向北，符合直觉
```

heading / pitch / roll 依次为绕 上 / 东 / 前 轴的旋转：
`R = rotateY(heading) · rotateX(pitch) · rotateZ(roll)`。

### 4.2 globe 模式

1. 经纬高 → ECEF（WGS84 椭球）：`lngLatHeightToEcef`。
2. 构造站心 ENU 基底（列向量 `[east, up, -north]`）+ ECEF 平移。
3. 乘 `ECEF_TO_ENGINE`（线性轴交换 `(x,y,z)→(y,z,x)/A`）变换到引擎“基础球面空间”
   （单位球，相机 model 旋转之前；与瓦片/球面顶点同一空间）。

> 引擎基础球面空间约定：+Y=北极，+Z=(0°,0°)，+X=(90°E,0°)，右手系。

### 4.3 mercator 模式

1. 经纬度 → 归一化世界平面 `[0,1]²`（`Mercator.lngLatToWorld`）。
2. 米 → 世界单位的尺度 `k = 1 / (2π·A·cosLat)`（墨卡托保角，各向同性）。
3. 局部轴映射 `east→+x, up→+z, south→+y`，平移到世界坐标 `(x, y, alt·k)`。

> mercator 世界平面约定：+x=东，+y=南，+z=高度。

### 4.4 着色器

```
clipPos     = camera.viewProj · model · vec4(localPos, 1)
worldNormal = normalize(normalMat · localNormal)   // normalMat = inverse-transpose(model)
```

法线矩阵采用 inverse-transpose，即便 mercator 为左手系也能保证法线朝外。

---

## 5. 渲染与精度说明

- **背面剔除关闭（`cullMode: 'none'`）**：mercator 左手系与 globe 右手系绕序相反，
  统一不剔除可避免两投影间的正反面冲突；单个模型过绘制开销可忽略。
- **双面光照**：`doubleSided` 材质用 `abs(N·L)`，正反面同样受光。
- **深度**：开启深度写入与 `less-equal` 测试，模型自身正确遮挡；底图瓦片不写深度，模型始终绘制其上。
- **premultiplied alpha**：片元输出预乘 alpha，与引擎合成管线一致；BLEND 材质半透明正确。
- **浮点精度（RTC）**：完整 4×4 模型矩阵以 float32 上传。锚点在引擎空间数量级约 1.0，
  均匀舍入误差 < 1 米，城市尺度下不可见，且为整体平移、模型内部无相对畸变。
- **mipmap**：基色贴图按渲染方式逐级降采样 + 最高 16× 各向异性，消除倾斜 / 远处贴图走样。

---

## 6. 支持范围与限制（v1）

**支持**：glTF 2.0 / glb、三角形几何、节点层级变换、基色因子 + 基色贴图、自发光、
alphaMode（OPAQUE/MASK/BLEND）、doubleSided、自动法线、多图元 / 多网格、内嵌与外部资源。

**暂不支持**（遇到时给出明确报错或忽略）：

| 项 | 行为 |
| --- | --- |
| `KHR_draco_mesh_compression` / `EXT_meshopt_compression` | 抛出错误，提示使用未压缩模型 |
| KTX2 / Basis 压缩纹理 | 图片解码失败时回退基色因子 |
| 金属度 / 粗糙度 / 法线贴图等完整 PBR | 仅用基色 + 方向光近似 |
| 骨骼蒙皮 / 关键帧动画 / morph target | 忽略（仅渲染绑定姿态） |
| 点 / 线图元 | 跳过 |

> 如需 Draco / meshopt，请在导出时关闭压缩，或先用工具（如 `gltf-transform`）解压。

---

## 7. 文件结构

| 文件 | 职责 |
| --- | --- |
| [src/gltf/geo.ts](../src/gltf/geo.ts) | 地理放置：经纬高 → 模型矩阵 + 法线矩阵（ECEF / ENU，双投影） |
| [src/gltf/gltf-types.ts](../src/gltf/gltf-types.ts) | glTF 2.0 JSON 类型 + 解析中间表示 |
| [src/gltf/GLTFLoader.ts](../src/gltf/GLTFLoader.ts) | glb 容器 / accessor / 节点烘焙 / 材质 / 纹理解析 |
| [src/gltf/MipmapGenerator.ts](../src/gltf/MipmapGenerator.ts) | 渲染式 mipmap 生成 |
| [src/shaders/gltf.wgsl.ts](../src/shaders/gltf.wgsl.ts) | 顶点 / 片元着色器（方向光 + 双面光照 + 基色贴图） |
| [src/layers/GLTFLayer.ts](../src/layers/GLTFLayer.ts) | 图层：管线 / GPU 资源 / 放置矩阵 / 每帧绘制 |
| [debug/gltf.html](../debug/gltf.html) | 交互示例（投影切换 + scale / heading / pitch 调节） |
