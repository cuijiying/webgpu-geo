# WebGPU 地理引擎 (WebGPU Geo Engine)

基于WebGPU的高性能地图显示框架，支持3D地球渲染、图层系统、地理数据可视化等功能。

## 特性

### 🌍 核心渲染
- **WebGPU渲染引擎**: 利用最新的WebGPU API实现高性能GPU渲染
- **3D地球显示**: 真实感的球体地球模型，支持纹理贴图
- **物理光照**: 基于物理的光照模型，包括漫反射、镜面反射和大气散射效果
- **法线贴图**: 支持法线贴图增强表面细节
- **深度缓冲**: 正确的深度测试和Z缓冲

### 🎮 交互控制
- **鼠标控制**: 拖拽旋转、滚轮缩放
- **触摸支持**: 移动设备触摸手势支持
- **键盘控制**: 
  - WASD/方向键: 旋转地球
  - +/-: 缩放
  - 空格: 切换自动旋转
  - R: 重置视角
  - G: 切换网格线
- **自动旋转**: 可开启/关闭的自动旋转功能

### 📊 图层系统
- **多图层支持**: 可添加多个不同类型的图层
- **点图层**: 支持在地球上显示点状数据
- **图层管理**: 图层可见性、透明度、Z索引控制
- **动态更新**: 运行时动态添加/移除图层

### 🗺️ 数据支持
- **GeoJSON加载**: 支持标准GeoJSON格式数据
- **示例数据**: 内置世界主要城市数据
- **坐标转换**: 经纬度与3D笛卡尔坐标系转换
- **数据解析**: 支持点、线、面等几何类型

### 🎨 视觉效果
- **经纬网格线**: 可切换的经纬度网格线显示
- **大气效果**: 边缘大气散射效果
- **菲涅尔反射**: 真实的表面反射效果
- **色调映射**: HDR到LDR的色调映射
- **伽马校正**: 正确的颜色空间处理

## 快速开始

### 安装依赖

```bash
npm install
```

### 构建项目

```bash
npm run build
```

### 运行演示

```bash
npm run serve
```

然后在浏览器中访问 `debug/index.html`

### 基本使用

```javascript
// 创建地图实例
const map = new ai.Map('canvas-id', {
    zoom: 1,
    center: [0, 0], // [经度, 纬度]
    enableControl: true,
    showGridLines: true,
    backgroundColor: [0, 0, 0, 1]
});

// 加载示例城市数据
await map.loadSampleCityData();

// 设置光照方向
map.setLightDirection(1, 1, 1);

// 控制图层
map.setLayerVisible('cities', true);
map.setLayerOpacity('cities', 0.8);
```

## API 文档

### AIMap 类

#### 构造函数
```javascript
new AIMap(canvasId, options)
```

**参数:**
- `canvasId`: Canvas元素的ID或HTMLCanvasElement实例
- `options`: 配置选项对象

**选项:**
- `zoom`: 缩放级别 (默认: 1)
- `center`: 地图中心 [经度, 纬度] (默认: [0, 0])
- `rotation`: 初始旋转角度 (默认: 0)
- `enableControl`: 是否启用控制 (默认: true)
- `backgroundColor`: 背景颜色 [R, G, B, A] (默认: [0, 0, 0, 1])
- `showGridLines`: 是否显示网格线 (默认: false)

#### 主要方法

**视角控制:**
- `setZoom(zoom)`: 设置缩放级别
- `setCenter(longitude, latitude)`: 设置地图中心
- `setAutoRotate(enable)`: 启用/禁用自动旋转

**图层管理:**
- `addPointLayer(id, name, points)`: 添加点图层
- `removeLayer(id)`: 移除图层
- `setLayerVisible(id, visible)`: 设置图层可见性
- `setLayerOpacity(id, opacity)`: 设置图层透明度

**数据加载:**
- `loadSampleCityData()`: 加载示例城市数据
- `loadGeoJSONData(url, layerId, layerName)`: 从URL加载GeoJSON数据

**渲染控制:**
- `setLightDirection(x, y, z)`: 设置光照方向
- `setGridLinesVisible(visible)`: 设置网格线可见性
- `toggleGridLines()`: 切换网格线显示

### 图层系统

#### PointLayer (点图层)
用于显示点状数据，如城市、标记点等。

```javascript
const pointData = [
    {
        longitude: 116.4074,
        latitude: 39.9042,
        altitude: 0,
        color: [1.0, 0.0, 0.0, 1.0], // RGBA
        size: 10,
        label: "北京",
        data: { population: 21540000 }
    }
];

await map.addPointLayer('cities', '城市', pointData);
```

#### 自定义图层
继承 `Layer` 基类创建自定义图层：

```javascript
class CustomLayer extends Layer {
    async initialize() {
        // 初始化资源
        return true;
    }
    
    render(renderPass) {
        // 渲染逻辑
    }
    
    destroy() {
        // 清理资源
    }
}
```

### 数据格式

#### GeoJSON 支持
支持标准GeoJSON格式：

```json
{
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [116.4074, 39.9042]
            },
            "properties": {
                "name": "北京",
                "population": 21540000
            }
        }
    ]
}
```

## 系统要求

- **浏览器**: Chrome 113+, Edge 113+, Firefox 113+ (需要WebGPU支持)
- **GPU**: 支持Vulkan/D3D12/Metal的现代GPU
- **内存**: 建议4GB+显存

## 架构设计

### 核心模块

1. **Engine**: WebGPU引擎核心，负责GPU设备初始化和上下文管理
2. **Camera**: 3D相机系统，处理视图和投影变换
3. **Renderer**: 渲染器，负责几何体渲染和着色器管理
4. **LayerManager**: 图层管理器，处理多图层渲染顺序
5. **TextureManager**: 纹理管理器，负责纹理加载和缓存

### 着色器系统

- **顶点着色器**: 处理顶点变换、法线计算、UV映射
- **片段着色器**: 实现PBR光照、纹理采样、大气效果
- **网格线着色器**: 专用于网格线渲染的着色器

### 性能优化

- **GPU缓冲区管理**: 高效的顶点和索引缓冲区管理
- **纹理缓存**: 智能纹理缓存系统
- **渲染批次**: 减少Draw Call的批次渲染
- **视锥体剔除**: 只渲染可见区域的几何体

## 开发计划

- [ ] LOD (Level of Detail) 系统
- [ ] 瓦片地图支持
- [ ] 线图层和面图层
- [ ] 动画系统
- [ ] 后处理效果
- [ ] VR/AR支持

## 贡献

欢迎提交Issue和Pull Request来帮助改进这个项目。

## 许可证

MIT License

## 技术栈

- **WebGPU**: 现代GPU API
- **TypeScript**: 类型安全的JavaScript
- **gl-matrix**: 数学库
- **Vite**: 构建工具

---

*这是一个实验性项目，展示了WebGPU在地理可视化领域的潜力。*