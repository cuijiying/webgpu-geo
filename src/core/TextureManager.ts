/**
 * 纹理管理器
 * 负责加载、管理和缓存WebGPU纹理
 */
export class TextureManager {
    private device: GPUDevice;
    private textureCache: Map<string, GPUTexture> = new Map();
    private samplerCache: Map<string, GPUSampler> = new Map();
    
    constructor(device: GPUDevice) {
        this.device = device;
    }
    
    /**
     * 创建默认地球纹理（程序生成）
     */
    public createDefaultEarthTexture(): GPUTexture {
        const width = 512;
        const height = 256;
        
        // 创建简单的地球纹理数据
        const data = new Uint8Array(width * height * 4);
        
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const index = (y * width + x) * 4;
                
                // 根据纬度创建简单的颜色变化
                const lat = (y / height - 0.5) * Math.PI;
                const lon = (x / width - 0.5) * Math.PI * 2;
                
                // 陆地/海洋的简单模拟
                const landMask = this.generateLandMask(lon, lat);
                
                if (landMask > 0.5) {
                    // 陆地颜色 - 绿色/棕色
                    data[index] = Math.floor(50 + landMask * 100);     // R
                    data[index + 1] = Math.floor(80 + landMask * 120); // G
                    data[index + 2] = Math.floor(30 + landMask * 50);  // B
                } else {
                    // 海洋颜色 - 蓝色
                    const oceanDepth = 0.5 - landMask;
                    data[index] = Math.floor(20 + oceanDepth * 40);     // R
                    data[index + 1] = Math.floor(50 + oceanDepth * 80); // G
                    data[index + 2] = Math.floor(120 + oceanDepth * 135); // B
                }
                
                data[index + 3] = 255; // Alpha
            }
        }
        
        // 创建纹理
        const texture = this.device.createTexture({
            label: "Default Earth Texture",
            size: [width, height, 1],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        
        // 写入数据
        this.device.queue.writeTexture(
            { texture },
            data,
            { bytesPerRow: width * 4 },
            { width, height }
        );
        
        this.textureCache.set('earth-default', texture);
        return texture;
    }
    
    /**
     * 创建默认法线贴图
     */
    public createDefaultNormalTexture(): GPUTexture {
        const width = 256;
        const height = 128;
        
        // 创建简单的法线贴图数据
        const data = new Uint8Array(width * height * 4);
        
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const index = (y * width + x) * 4;
                
                // 基础法线 (0, 0, 1) 映射到 (128, 128, 255)
                data[index] = 128;     // X
                data[index + 1] = 128; // Y
                data[index + 2] = 255; // Z
                data[index + 3] = 255; // Alpha
            }
        }
        
        // 创建纹理
        const texture = this.device.createTexture({
            label: "Default Normal Texture",
            size: [width, height, 1],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        
        // 写入数据
        this.device.queue.writeTexture(
            { texture },
            data,
            { bytesPerRow: width * 4 },
            { width, height }
        );
        
        this.textureCache.set('normal-default', texture);
        return texture;
    }
    
    /**
     * 从URL加载纹理
     */
    public async loadTextureFromURL(url: string, label?: string): Promise<GPUTexture | null> {
        try {
            // 检查缓存
            if (this.textureCache.has(url)) {
                return this.textureCache.get(url)!;
            }
            
            // 加载图片
            const response = await fetch(url);
            const blob = await response.blob();
            const imageBitmap = await createImageBitmap(blob);
            
            // 创建纹理
            const texture = this.device.createTexture({
                label: label || `Texture from ${url}`,
                size: [imageBitmap.width, imageBitmap.height, 1],
                format: 'rgba8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
            });
            
            // 复制图片数据到纹理
            this.device.queue.copyExternalImageToTexture(
                { source: imageBitmap },
                { texture },
                [imageBitmap.width, imageBitmap.height]
            );
            
            // 缓存纹理
            this.textureCache.set(url, texture);
            
            return texture;
        } catch (error) {
            console.error(`Failed to load texture from ${url}:`, error);
            return null;
        }
    }
    
    /**
     * 创建采样器
     */
    public createSampler(config?: {
        magFilter?: GPUFilterMode;
        minFilter?: GPUFilterMode;
        addressModeU?: GPUAddressMode;
        addressModeV?: GPUAddressMode;
        maxAnisotropy?: number;
    }): GPUSampler {
        const key = JSON.stringify(config || {});
        
        if (this.samplerCache.has(key)) {
            return this.samplerCache.get(key)!;
        }
        
        const sampler = this.device.createSampler({
            magFilter: config?.magFilter || 'linear',
            minFilter: config?.minFilter || 'linear',
            addressModeU: config?.addressModeU || 'repeat',
            addressModeV: config?.addressModeV || 'repeat',
            maxAnisotropy: config?.maxAnisotropy || 1,
        });
        
        this.samplerCache.set(key, sampler);
        return sampler;
    }
    
    /**
     * 获取缓存的纹理
     */
    public getTexture(key: string): GPUTexture | undefined {
        return this.textureCache.get(key);
    }
    
    /**
     * 简单的陆地遮罩生成函数
     */
    private generateLandMask(lon: number, lat: number): number {
        // 使用简单的噪声函数生成陆地/海洋分布
        const noise1 = Math.sin(lon * 3 + lat * 2) * 0.5 + 0.5;
        const noise2 = Math.sin(lon * 5 - lat * 3) * 0.3 + 0.5;
        const noise3 = Math.sin(lon * 7 + lat * 4) * 0.2 + 0.5;
        
        // 组合噪声
        let landValue = noise1 * 0.6 + noise2 * 0.3 + noise3 * 0.1;
        
        // 添加一些大陆形状
        const continentMask = Math.sin(lat * 2) * Math.sin(lon * 1.5) * 0.5 + 0.5;
        landValue = landValue * 0.7 + continentMask * 0.3;
        
        return Math.max(0, Math.min(1, landValue));
    }
    
    /**
     * 销毁所有纹理资源
     */
    public destroy(): void {
        // 销毁所有缓存的纹理
        for (const texture of this.textureCache.values()) {
            texture.destroy();
        }
        
        // 清空缓存
        this.textureCache.clear();
        this.samplerCache.clear();
    }
}