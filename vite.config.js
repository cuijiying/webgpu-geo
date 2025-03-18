import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  // 定义入口文件
  build: {
    lib: {
      // 指定入口文件
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'ai',
      fileName: 'aimap-dev',
      formats: ['umd', 'es'],
    },
    outDir: 'dist',
    // 启用源码映射，便于调试
    sourcemap: true,
  },
  // 开发服务器配置
  server: {
    // 监听所有网络接口
    host: '0.0.0.0',
    port: 3000,
    // 热更新
    hmr: true,
    // 自动打开浏览器
    open: '/debug/index.html'
  },
  // 配置别名
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
}); 