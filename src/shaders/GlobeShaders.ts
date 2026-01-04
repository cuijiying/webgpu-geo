/**
 * 地球渲染着色器
 * 包含高质量的顶点和片段着色器代码
 */
export class GlobeShaders {
    /**
     * 地球顶点着色器
     */
    static getVertexShader(): string {
        return `
            struct Uniforms {
                modelMatrix: mat4x4<f32>,
                viewMatrix: mat4x4<f32>,
                projectionMatrix: mat4x4<f32>,
                lightDirection: vec3<f32>,
                time: f32,
                cameraPosition: vec3<f32>,
                _padding: f32,
            };
            
            @group(0) @binding(0) var<uniform> uniforms: Uniforms;
            
            struct VertexInput {
                @location(0) position: vec3<f32>,
                @location(1) normal: vec3<f32>,
                @location(2) uv: vec2<f32>,
            };
            
            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(0) worldPos: vec3<f32>,
                @location(1) normal: vec3<f32>,
                @location(2) uv: vec2<f32>,
                @location(3) viewDir: vec3<f32>,
            };
            
            @vertex
            fn vertexMain(input: VertexInput) -> VertexOutput {
                var output: VertexOutput;
                
                // 转换到世界坐标
                var worldPosition = uniforms.modelMatrix * vec4<f32>(input.position, 1.0);
                output.worldPos = worldPosition.xyz;
                
                // 转换法线到世界空间
                output.normal = normalize((uniforms.modelMatrix * vec4<f32>(input.normal, 0.0)).xyz);
                
                // UV坐标
                output.uv = input.uv;
                
                // 视线方向
                output.viewDir = normalize(uniforms.cameraPosition - worldPosition.xyz);
                
                // 最终位置
                output.position = uniforms.projectionMatrix * uniforms.viewMatrix * worldPosition;
                
                return output;
            }
        `;
    }
    
    /**
     * 地球片段着色器
     */
    static getFragmentShader(): string {
        return `
            struct Uniforms {
                modelMatrix: mat4x4<f32>,
                viewMatrix: mat4x4<f32>,
                projectionMatrix: mat4x4<f32>,
                lightDirection: vec3<f32>,
                time: f32,
                cameraPosition: vec3<f32>,
                _padding: f32,
            };
            
            @group(0) @binding(0) var<uniform> uniforms: Uniforms;
            @group(0) @binding(1) var earthTexture: texture_2d<f32>;
            @group(0) @binding(2) var earthSampler: sampler;
            @group(0) @binding(3) var normalTexture: texture_2d<f32>;
            @group(0) @binding(4) var normalSampler: sampler;
            
            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(0) worldPos: vec3<f32>,
                @location(1) normal: vec3<f32>,
                @location(2) uv: vec2<f32>,
                @location(3) viewDir: vec3<f32>,
            };
            
            // 计算菲涅尔反射
            fn fresnel(cosTheta: f32, F0: f32) -> f32 {
                return F0 + (1.0 - F0) * pow(1.0 - cosTheta, 5.0);
            }
            
            // 计算大气散射效果
            fn atmosphericScattering(viewDir: vec3<f32>, normal: vec3<f32>, lightDir: vec3<f32>) -> vec3<f32> {
                let rimPower = 2.0;
                let rimIntensity = 0.8;
                let atmosphereColor = vec3<f32>(0.4, 0.7, 1.0); // 蓝色大气
                
                let rim = 1.0 - max(0.0, dot(viewDir, normal));
                let rimEffect = pow(rim, rimPower) * rimIntensity;
                
                return atmosphereColor * rimEffect;
            }
            
            @fragment
            fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
                // 采样地球纹理
                var earthColor = textureSample(earthTexture, earthSampler, input.uv);
                
                // 采样法线贴图
                var normalMap = textureSample(normalTexture, normalSampler, input.uv);
                var perturbedNormal = normalize(input.normal + (normalMap.xyz * 2.0 - 1.0) * 0.1);
                
                // 光照计算
                let lightDir = normalize(-uniforms.lightDirection);
                let viewDir = normalize(input.viewDir);
                let halfDir = normalize(lightDir + viewDir);
                
                // 漫反射
                let NdotL = max(0.0, dot(perturbedNormal, lightDir));
                let diffuse = earthColor.rgb * NdotL;
                
                // 镜面反射
                let NdotH = max(0.0, dot(perturbedNormal, halfDir));
                let specular = pow(NdotH, 32.0) * 0.3;
                
                // 环境光
                let ambient = earthColor.rgb * 0.1;
                
                // 大气散射
                let atmosphere = atmosphericScattering(viewDir, perturbedNormal, lightDir);
                
                // 菲涅尔效果
                let fresnel = fresnel(max(0.0, dot(viewDir, perturbedNormal)), 0.04);
                
                // 合成最终颜色
                var finalColor = ambient + diffuse + specular * fresnel + atmosphere;
                
                // 色调映射
                finalColor = finalColor / (finalColor + vec3<f32>(1.0));
                
                // 伽马校正
                finalColor = pow(finalColor, vec3<f32>(1.0 / 2.2));
                
                return vec4<f32>(finalColor, 1.0);
            }
        `;
    }
    
    /**
     * 网格线顶点着色器
     */
    static getGridVertexShader(): string {
        return `
            struct Uniforms {
                modelMatrix: mat4x4<f32>,
                viewMatrix: mat4x4<f32>,
                projectionMatrix: mat4x4<f32>,
                lightDirection: vec3<f32>,
                time: f32,
                cameraPosition: vec3<f32>,
                _padding: f32,
            };
            
            @group(0) @binding(0) var<uniform> uniforms: Uniforms;
            
            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(0) worldPos: vec3<f32>,
                @location(1) distance: f32,
            };
            
            @vertex
            fn vertexMain(@location(0) position: vec3<f32>) -> VertexOutput {
                var output: VertexOutput;
                var worldPosition = uniforms.modelMatrix * vec4<f32>(position, 1.0);
                output.worldPos = worldPosition.xyz;
                
                // 计算到相机的距离，用于淡出效果
                output.distance = length(uniforms.cameraPosition - worldPosition.xyz);
                
                output.position = uniforms.projectionMatrix * uniforms.viewMatrix * worldPosition;
                return output;
            }
        `;
    }
    
    /**
     * 网格线片段着色器
     */
    static getGridFragmentShader(): string {
        return `
            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(0) worldPos: vec3<f32>,
                @location(1) distance: f32,
            };
            
            @fragment
            fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
                // 基础网格线颜色
                let baseColor = vec3<f32>(1.0, 1.0, 1.0);
                
                // 根据距离计算透明度
                let maxDistance = 10.0;
                let alpha = 1.0 - smoothstep(3.0, maxDistance, input.distance);
                
                // 添加一些亮度变化
                let brightness = 0.6 + 0.4 * sin(input.distance * 0.1);
                
                return vec4<f32>(baseColor * brightness, alpha * 0.8);
            }
        `;
    }
}