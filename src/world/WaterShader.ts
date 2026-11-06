/**
 * 水面材质。shader 本体在 assets/resources/RpgWater.shader：
 * - 顶点色 r 通道 = 水深 0~1（由 buildWaterMesh 写入），用来混合浅水/深水颜色、岸边泡沫和透明度
 * - 法线由几组随时间移动的正弦波算出，产生波纹、菲涅尔天空反射和太阳高光
 * - 时间用引擎每帧更新的场景变量 u_Time
 *
 * 编辑器里 IDE 会按名字从资源库找到 shader；运行时必须先调用 loadWaterShader() 加载，
 * 否则 setShaderName 找不到 shader，会退回 BLINNPHONG。
 */
export const WATER_SHADER_NAME = "RpgWater";
export const WATER_SHADER_URL = "resources/RpgWater.shader";

export function loadWaterShader(): Promise<any> {
    return Laya.loader.load(WATER_SHADER_URL);
}

export function createWaterMaterial(): Laya.Material {
    const mat = new Laya.Material();
    mat.setShaderName(WATER_SHADER_NAME);
    mat.materialRenderMode = Laya.MaterialRenderMode.RENDERMODE_TRANSPARENT;
    mat.setColor("u_ShallowColor", new Laya.Color(0.25, 0.65, 0.72, 0.45));
    mat.setColor("u_DeepColor", new Laya.Color(0.06, 0.26, 0.50, 0.88));
    mat.setColor("u_SkyColor", new Laya.Color(0.72, 0.85, 0.95, 1));
    mat.setVector3("u_SunDir", new Laya.Vector3(-0.4, 0.8, 0.45));
    return mat;
}
