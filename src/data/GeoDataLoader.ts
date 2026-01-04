/**
 * GeoJSON特征接口
 */
export interface GeoJSONFeature {
    type: 'Feature';
    geometry: {
        type: 'Point' | 'LineString' | 'Polygon' | 'MultiPoint' | 'MultiLineString' | 'MultiPolygon';
        coordinates: number[] | number[][] | number[][][];
    };
    properties?: { [key: string]: any };
}

/**
 * GeoJSON数据接口
 */
export interface GeoJSONData {
    type: 'FeatureCollection';
    features: GeoJSONFeature[];
}

/**
 * 解析后的点数据
 */
export interface ParsedPointData {
    longitude: number;
    latitude: number;
    altitude?: number;
    properties?: { [key: string]: any };
}

/**
 * 解析后的线数据
 */
export interface ParsedLineData {
    coordinates: [number, number, number?][];
    properties?: { [key: string]: any };
}

/**
 * 解析后的面数据
 */
export interface ParsedPolygonData {
    rings: [number, number, number?][][];
    properties?: { [key: string]: any };
}

/**
 * 地理数据加载器
 * 支持加载和解析各种地理数据格式
 */
export class GeoDataLoader {
    
    /**
     * 从URL加载GeoJSON数据
     */
    public static async loadGeoJSON(url: string): Promise<GeoJSONData | null> {
        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            // 验证GeoJSON格式
            if (!this.validateGeoJSON(data)) {
                throw new Error('Invalid GeoJSON format');
            }
            
            return data;
        } catch (error) {
            console.error('Failed to load GeoJSON:', error);
            return null;
        }
    }
    
    /**
     * 解析GeoJSON为点数据
     */
    public static parsePointsFromGeoJSON(geoJSON: GeoJSONData): ParsedPointData[] {
        const points: ParsedPointData[] = [];
        
        for (const feature of geoJSON.features) {
            if (feature.geometry.type === 'Point') {
                const coords = feature.geometry.coordinates as number[];
                points.push({
                    longitude: coords[0],
                    latitude: coords[1],
                    altitude: coords[2],
                    properties: feature.properties
                });
            } else if (feature.geometry.type === 'MultiPoint') {
                const coordsArray = feature.geometry.coordinates as number[][];
                for (const coords of coordsArray) {
                    points.push({
                        longitude: coords[0],
                        latitude: coords[1],
                        altitude: coords[2],
                        properties: feature.properties
                    });
                }
            }
        }
        
        return points;
    }
    
    /**
     * 解析GeoJSON为线数据
     */
    public static parseLinesFromGeoJSON(geoJSON: GeoJSONData): ParsedLineData[] {
        const lines: ParsedLineData[] = [];
        
        for (const feature of geoJSON.features) {
            if (feature.geometry.type === 'LineString') {
                const coords = feature.geometry.coordinates as number[][];
                lines.push({
                    coordinates: coords.map(coord => [coord[0], coord[1], coord[2]]),
                    properties: feature.properties
                });
            } else if (feature.geometry.type === 'MultiLineString') {
                const coordsArray = feature.geometry.coordinates as number[][][];
                for (const coords of coordsArray) {
                    lines.push({
                        coordinates: coords.map(coord => [coord[0], coord[1], coord[2]]),
                        properties: feature.properties
                    });
                }
            }
        }
        
        return lines;
    }
    
    /**
     * 解析GeoJSON为面数据
     */
    public static parsePolygonsFromGeoJSON(geoJSON: GeoJSONData): ParsedPolygonData[] {
        const polygons: ParsedPolygonData[] = [];
        
        for (const feature of geoJSON.features) {
            if (feature.geometry.type === 'Polygon') {
                const rings = feature.geometry.coordinates as number[][][];
                polygons.push({
                    rings: rings.map(ring => ring.map(coord => [coord[0], coord[1], coord[2]])),
                    properties: feature.properties
                });
            } else if (feature.geometry.type === 'MultiPolygon') {
                const polygonArray = feature.geometry.coordinates as any;
                for (const polygon of polygonArray) {
                    polygons.push({
                        rings: polygon.map((ring: any) => ring.map((coord: any) => [coord[0], coord[1], coord[2]])),
                        properties: feature.properties
                    });
                }
            }
        }
        
        return polygons;
    }
    
    /**
     * 创建示例城市数据
     */
    public static createSampleCityData(): ParsedPointData[] {
        return [
            {
                longitude: 116.4074,
                latitude: 39.9042,
                properties: { name: '北京', population: 21540000, country: '中国' }
            },
            {
                longitude: 121.4737,
                latitude: 31.2304,
                properties: { name: '上海', population: 24280000, country: '中国' }
            },
            {
                longitude: 113.2644,
                latitude: 23.1291,
                properties: { name: '广州', population: 14043500, country: '中国' }
            },
            {
                longitude: 114.0579,
                latitude: 22.5431,
                properties: { name: '深圳', population: 12356820, country: '中国' }
            },
            {
                longitude: -74.0060,
                latitude: 40.7128,
                properties: { name: '纽约', population: 8336817, country: '美国' }
            },
            {
                longitude: -118.2437,
                latitude: 34.0522,
                properties: { name: '洛杉矶', population: 3979576, country: '美国' }
            },
            {
                longitude: -87.6298,
                latitude: 41.8781,
                properties: { name: '芝加哥', population: 2693976, country: '美国' }
            },
            {
                longitude: 2.3522,
                latitude: 48.8566,
                properties: { name: '巴黎', population: 2161000, country: '法国' }
            },
            {
                longitude: -0.1276,
                latitude: 51.5074,
                properties: { name: '伦敦', population: 8982000, country: '英国' }
            },
            {
                longitude: 139.6917,
                latitude: 35.6895,
                properties: { name: '东京', population: 13929286, country: '日本' }
            },
            {
                longitude: 151.2093,
                latitude: -33.8688,
                properties: { name: '悉尼', population: 5312163, country: '澳大利亚' }
            },
            {
                longitude: 55.2708,
                latitude: 25.2048,
                properties: { name: '迪拜', population: 3331420, country: '阿联酋' }
            }
        ];
    }
    
    /**
     * 创建示例国家边界数据（简化版）
     */
    public static createSampleCountryBorders(): ParsedLineData[] {
        return [
            {
                // 中国边界（简化）
                coordinates: [
                    [73.5, 39.5], [134.8, 39.5], [134.8, 53.5], [73.5, 53.5], [73.5, 39.5]
                ],
                properties: { name: '中国', iso: 'CN' }
            },
            {
                // 美国边界（简化）
                coordinates: [
                    [-125.0, 32.0], [-66.9, 32.0], [-66.9, 49.0], [-125.0, 49.0], [-125.0, 32.0]
                ],
                properties: { name: '美国', iso: 'US' }
            }
        ];
    }
    
    /**
     * 验证GeoJSON格式
     */
    private static validateGeoJSON(data: any): data is GeoJSONData {
        return (
            data &&
            typeof data === 'object' &&
            data.type === 'FeatureCollection' &&
            Array.isArray(data.features) &&
            data.features.every((feature: any) => 
                feature.type === 'Feature' &&
                feature.geometry &&
                typeof feature.geometry.type === 'string' &&
                Array.isArray(feature.geometry.coordinates)
            )
        );
    }
    
    /**
     * 将经纬度转换为3D坐标
     */
    public static lonLatToCartesian(longitude: number, latitude: number, altitude: number = 0, radius: number = 1): [number, number, number] {
        const lon = longitude * Math.PI / 180;
        const lat = latitude * Math.PI / 180;
        const r = radius + altitude * 0.001; // 高度缩放
        
        const x = r * Math.cos(lat) * Math.cos(lon);
        const y = r * Math.sin(lat);
        const z = r * Math.cos(lat) * Math.sin(lon);
        
        return [x, y, z];
    }
    
    /**
     * 将3D坐标转换为经纬度
     */
    public static cartesianToLonLat(x: number, y: number, z: number): [number, number, number] {
        const radius = Math.sqrt(x * x + y * y + z * z);
        const longitude = Math.atan2(z, x) * 180 / Math.PI;
        const latitude = Math.asin(y / radius) * 180 / Math.PI;
        const altitude = (radius - 1) * 1000; // 假设基础半径为1
        
        return [longitude, latitude, altitude];
    }
}