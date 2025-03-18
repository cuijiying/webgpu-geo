# WebGPU 地理引擎框架

这是一个基于WebGPU的地理引擎框架，用于渲染地球和地理数据。

## 功能特性

- 基于WebGPU的高性能渲染
- 模块化设计架构
- 渲染白色地球球体
- 支持缩放和旋转控制
- 简单API接口

## 系统要求

- 支持WebGPU的浏览器（如Chrome 113+、Edge 113+）
- 支持WebGPU的硬件

## 安装与使用

1. 克隆代码库：
   ```bash
   git clone https://github.com/yourusername/webgpu-geo.git
   cd webgpu-geo
   ```

2. 安装依赖：
   ```bash
   npm install
   # 或者使用pnpm
   pnpm install
   ```

3. 运行开发服务器：
   ```bash
   npm run dev
   # 或者使用pnpm
   pnpm dev
   ```

4. 在浏览器中打开：
   ```
   http://localhost:5173/debug/
   ```

## 基本用法

只需要几行代码即可创建一个交互式地球：

```javascript
import { AIMap } from 'webgpu-geo';

// 创建地图实例
const map = new AIMap('canvas-id', {
    zoom: 1,
    center: [0, 0],
    enableControl: true
});

// 设置缩放级别
map.setZoom(2);

// 设置地图中心点（经度和纬度）
map.setCenter(110, 35);

// 启用/禁用自动旋转
map.setAutoRotate(true);

// 销毁地图
// map.destroy();
```

## 配置选项

AIMap构造函数接受以下选项：

```typescript
interface AIMapOptions {
    zoom?: number;             // 缩放级别，默认为1
    center?: [number, number]; // 中心位置[经度, 纬度]，默认为[0, 0]
    rotation?: number;         // 初始旋转角度（弧度），默认为0
    enableControl?: boolean;   // 是否启用鼠标/触摸控制，默认为true
    backgroundColor?: [number, number, number, number]; // 背景颜色，默认为[0, 0, 0, 1]
}
```

## 项目结构

```
webgpu-geo/
├── debug/             # 调试和示例文件
├── src/               # 源代码
│   ├── core/          # 核心引擎组件
│   │   ├── Engine.ts  # WebGPU引擎核心
│   │   └── Camera.ts  # 相机控制
│   ├── renderers/     # 渲染器
│   │   └── GlobeRenderer.ts  # 地球渲染器
│   ├── AIMap.ts       # 主要API类
│   └── index.ts       # 公共API导出
└── package.json       # 项目依赖
```

## API参考

### AIMap类

| 方法 | 描述 |
|------|------|
| `constructor(canvasId, options)` | 创建AIMap实例 |
| `setZoom(zoom)` | 设置缩放级别 |
| `getZoom()` | 获取当前缩放级别 |
| `setCenter(longitude, latitude)` | 设置地图中心点 |
| `getCenter()` | 获取当前中心点 |
| `setAutoRotate(enable)` | 启用/禁用自动旋转 |
| `stop()` | 停止渲染循环 |
| `destroy()` | 销毁AIMap实例 |

## 开发指南

### 添加新的渲染器

1. 在 `src/renderers` 目录下创建新的渲染器类
2. 遵循模块化设计，使用现有的Engine和Camera类
3. 在 `src/index.ts` 中导出新的渲染器

### 修改地球外观

修改 `GlobeRenderer.ts` 中的着色器代码来改变地球的外观。

## 许可证

MIT 