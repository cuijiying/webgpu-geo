import { mat4, vec3 } from 'gl-matrix';

/**
 * 相机类
 */
export class Camera {
    private position: vec3 = vec3.fromValues(0, 0, 3); // 相机位置
    private target: vec3 = vec3.fromValues(0, 0, 0);   // 观察目标
    private up: vec3 = vec3.fromValues(0, 1, 0);       // 上方向
    
    private viewMatrix: mat4 = mat4.create();          // 视图矩阵
    private projectionMatrix: mat4 = mat4.create();    // 投影矩阵
    private viewProjectionMatrix: mat4 = mat4.create(); // 视图投影矩阵
    
    private aspectRatio: number = 1.0;
    private fov: number = Math.PI / 4;  // 45度视场角
    private near: number = 0.1;
    private far: number = 1000.0;
    
    constructor() {
        this.updateViewMatrix();
        this.updateProjectionMatrix();
    }
    
    /**
     * 更新视图矩阵
     */
    public updateViewMatrix(): void {
        mat4.lookAt(this.viewMatrix, this.position, this.target, this.up);
        this.updateViewProjectionMatrix();
    }
    
    /**
     * 更新投影矩阵
     */
    public updateProjectionMatrix(): void {
        mat4.perspective(this.projectionMatrix, this.fov, this.aspectRatio, this.near, this.far);
        this.updateViewProjectionMatrix();
    }
    
    /**
     * 更新视图投影矩阵
     */
    private updateViewProjectionMatrix(): void {
        mat4.multiply(this.viewProjectionMatrix, this.projectionMatrix, this.viewMatrix);
    }
    
    /**
     * 设置相机位置
     */
    public setPosition(x: number, y: number, z: number): void {
        vec3.set(this.position, x, y, z);
        this.updateViewMatrix();
    }
    
    /**
     * 获取相机位置
     */
    public getPosition(): vec3 {
        return this.position;
    }
    
    /**
     * 设置观察目标
     */
    public setTarget(x: number, y: number, z: number): void {
        vec3.set(this.target, x, y, z);
        this.updateViewMatrix();
    }
    
    /**
     * 获取观察目标
     */
    public getTarget(): vec3 {
        return this.target;
    }
    
    /**
     * 设置宽高比
     */
    public setAspectRatio(aspectRatio: number): void {
        this.aspectRatio = aspectRatio;
        this.updateProjectionMatrix();
    }
    
    /**
     * 获取视图矩阵
     */
    public getViewMatrix(): mat4 {
        return this.viewMatrix;
    }
    
    /**
     * 获取投影矩阵
     */
    public getProjectionMatrix(): mat4 {
        return this.projectionMatrix;
    }
    
    /**
     * 获取视图投影矩阵
     */
    public getViewProjectionMatrix(): mat4 {
        return this.viewProjectionMatrix;
    }
} 