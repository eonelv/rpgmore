import { RGB } from "./MeshBuilder";
import {
    GRASS_TILE, GRAVEL_TILE, ROCK_TILE, SAND_TILE, grassTexture, rockTexture, sandTexture, trailTexture,
} from "./TerrainTextures";

/**
 * 地面网格 + 地面 shader：草地、沙地、砂石（道路 / 山路）、岩石合在一张网格里，按真实地形高度只画一层，
 * 在像素里按权重混合几种贴图。没有叠层，也就没有重合闪烁，地面和树、石头、角色脚底在同一高度。
 *
 * 每个顶点带：
 * - 颜色 COLOR0：草地颜色 rgb + 草地 alpha（0.5 + 0.5 × 草地权重）
 * - a_Ground0：沙地颜色 rgb + 沙地 alpha
 * - a_Ground1：底层颜色 rgb + 山路 alpha
 * - 法线的 w：底层的岩石权重（0 砂石贴图，1 岩石贴图，相邻顶点之间渐变）
 * - UV：块内坐标（米），shader 里按各贴图的边长换算
 *
 * 像素里从下往上合成：底层（道路砂石 / 水底 / 山体岩石）→ 沙地 → 草地 → 山路砂石。某一层的覆盖条件和原来的 alpha 测试一样：
 * 顶点 alpha × 贴图 alpha ≥ 0.5（贴图 alpha 里是参差边缘的噪声），只是阈值两边留一点软过渡，边缘不起锯齿
 */
export const GROUND_SHADER_NAME = "RpgGround";

const VS = `
#define SHADER_NAME RpgGroundVS
#include "Math.glsl";
#include "Scene.glsl";
#include "SceneFogInput.glsl";
#include "Camera.glsl";
#include "Sprite3DVertex.glsl";
#include "VertexCommon.glsl";
#include "BlinnPhongVertex.glsl";

varying vec4 v_Sand;
varying vec4 v_Under;
varying float v_Rock;

void main()
{
    Vertex vertex;
    getVertexParams(vertex);
    PixelParams pixel;
    initPixelParams(pixel, vertex);
    // 和引擎处理顶点色一样，颜色从 gamma 空间转到线性空间
    v_Sand = vec4(pow(a_Ground0.rgb, vec3(2.2)), a_Ground0.a);
    v_Under = vec4(pow(a_Ground1.rgb, vec3(2.2)), a_Ground1.a);
    v_Rock = a_Normal.w;
    gl_Position = getPositionCS(pixel.positionWS);
    gl_Position = remapPositionZ(gl_Position);
#ifdef FOG
    FogHandle(gl_Position.z);
#endif
}
`;

const FS = `
#define SHADER_NAME RpgGroundFS
#include "Color.glsl";
#include "Scene.glsl";
#include "SceneFog.glsl";
#include "Camera.glsl";
#include "Sprite3DFrag.glsl";
#include "BlinnPhongFrag.glsl";

varying vec4 v_Sand;
varying vec4 v_Under;
varying float v_Rock;

// 覆盖度：顶点 alpha × 贴图 alpha 过 0.5 就盖住（和原来的 alpha 测试一致），两边各留 0.02 的软过渡
float cover(float vertexAlpha, float texAlpha)
{
    return smoothstep(0.48, 0.52, vertexAlpha * texAlpha);
}

void main()
{
    PixelParams pixel;
    getPixelParams(pixel);

#ifdef UV
    vec2 p = pixel.uv0;
#else
    vec2 p = vec2(0.0);
#endif
    float y = pixel.positionWS.y;
    vec3 n = pixel.normalWS;

    vec4 grass = texture2D(u_GrassTex, p * u_TileInv.x);
#ifdef Gamma_u_GrassTex
    grass = gammaToLinear(grass);
#endif
    vec4 sand = texture2D(u_SandTex, p * u_TileInv.y);
#ifdef Gamma_u_SandTex
    sand = gammaToLinear(sand);
#endif
    vec4 gravel = texture2D(u_GravelTex, p * u_TileInv.z);
#ifdef Gamma_u_GravelTex
    gravel = gammaToLinear(gravel);
#endif
    // 岩石：缓坡从上往下投影，陡坡投影到侧面（朝 ±x 用 (z, 高度)，朝 ±z 用 (x, 高度)），悬崖上的纹理不会被拉长
    vec4 rockTop = texture2D(u_RockTex, p * u_TileInv.w);
    vec4 rockX = texture2D(u_RockTex, vec2(p.y, y) * u_TileInv.w);
    vec4 rockZ = texture2D(u_RockTex, vec2(p.x, y) * u_TileInv.w);
    float side = smoothstep(-0.15, 0.15, abs(n.x) - abs(n.z));
    float top = smoothstep(0.62, 0.82, abs(n.y));
    vec3 rock = mix(mix(rockZ.rgb, rockX.rgb, side), rockTop.rgb, top);
#ifdef Gamma_u_RockTex
    rock = gammaToLinear(rock);
#endif

#ifdef COLOR
    vec3 grassTint = pixel.vertexColor.rgb;
    float grassAlpha = pixel.vertexColor.a;
#else
    vec3 grassTint = vec3(1.0);
    float grassAlpha = 1.0;
#endif

    // 底层：砂石贴图（道路、水底）和岩石贴图（山体）按岩石权重渐变
    vec3 under = v_Under.rgb * mix(gravel.rgb, rock, clamp(v_Rock, 0.0, 1.0));

    vec3 c = under;
    c = mix(c, v_Sand.rgb * sand.rgb, cover(v_Sand.a, sand.a));
    c = mix(c, grassTint * grass.rgb, cover(grassAlpha, grass.a));
    c = mix(c, pow(u_GravelColor.rgb, vec3(2.2)) * gravel.rgb, cover(v_Under.a, gravel.a));

    Surface surface;
    surface.diffuseColor = c;
    surface.alpha = 1.0;
    surface.alphaClip = 0.0;
    surface.normalTS = vec3(0.0, 0.0, 1.0);
    surface.gloss = vec3(0.0);
    surface.specularColor = vec3(0.0);
    surface.shininess = 0.078125;
    vec3 color = BlinnPhongLighting(surface, pixel);
#ifdef FOG
    color = sceneLitFog(color);
#endif
    gl_FragColor = vec4(color, 1.0);
    gl_FragColor = outputTransform(gl_FragColor);
}
`;

let registered = false;
/**
 * 注册地面 shader（只注册一次）。必须在引擎初始化之后、创建地面材质之前调用。
 * 不能用 Shader3D.find 判断是否已注册：编辑器里 find 找不到 shader 资源时会注册一个占位 shader 并返回它
 */
function ensureGroundShader() {
    if (registered) return;
    registered = true;
    const attr: Record<string, [number, Laya.ShaderDataType]> = {};
    const def = Laya.SubShader.DefaultAttributeMap;
    for (const k in def) attr[k] = def[k];
    // 这两个是 GPU 实例化用的属性，和下面自定义属性的位置（12、13）重复，地面不用实例化，去掉
    delete attr["a_SimpleTextureParams"];
    delete attr["a_LightmapScaleOffset"];
    // 法线多一个 w 分量：底层的岩石权重
    attr["a_Normal"] = [Laya.VertexMesh.MESH_NORMAL0, Laya.ShaderDataType.Vector4];
    attr["a_Ground0"] = [Laya.VertexMesh.MESH_CUSTOME0, Laya.ShaderDataType.Vector4];
    attr["a_Ground1"] = [Laya.VertexMesh.MESH_CUSTOME1, Laya.ShaderDataType.Vector4];
    const uniforms: any = {
        u_GrassTex: Laya.ShaderDataType.Texture2D,
        u_SandTex: Laya.ShaderDataType.Texture2D,
        u_GravelTex: Laya.ShaderDataType.Texture2D,
        u_RockTex: Laya.ShaderDataType.Texture2D,
        u_TileInv: Laya.ShaderDataType.Vector4,
        u_GravelColor: Laya.ShaderDataType.Vector4,
    };
    const defaults: any = {
        u_TileInv: new Laya.Vector4(1 / GRASS_TILE, 1 / SAND_TILE, 1 / GRAVEL_TILE, 1 / ROCK_TILE),
        u_GravelColor: new Laya.Vector4(1, 1, 1, 1),
    };
    const shader = Laya.Shader3D.add(GROUND_SHADER_NAME, false, false);
    shader.shaderType = Laya.ShaderFeatureType.D3;
    const sub = new Laya.SubShader(attr, uniforms, defaults);
    shader.addSubShader(sub);
    sub.addShaderPass(VS, FS);
}

/** 地面材质。gravel：山路砂石的颜色（乘砂石贴图） */
export function createGroundMaterial(gravel: RGB): Laya.Material {
    ensureGroundShader();
    const m = new Laya.Material();
    m.setShaderName(GROUND_SHADER_NAME);
    m.setTexture("u_GrassTex", grassTexture());
    m.setTexture("u_SandTex", sandTexture());
    // 山路贴图 = 砂石贴图 + alpha 里的参差边缘，道路和山路共用
    m.setTexture("u_GravelTex", trailTexture());
    m.setTexture("u_RockTex", rockTexture());
    m.setVector4("u_TileInv", new Laya.Vector4(1 / GRASS_TILE, 1 / SAND_TILE, 1 / GRAVEL_TILE, 1 / ROCK_TILE));
    m.setVector4("u_GravelColor", new Laya.Vector4(gravel[0], gravel[1], gravel[2], 1));
    return m;
}

const MAX_VERTS = 65000;
/** 构建时每个顶点的 float 数：位置 3 + 法线 3 + 岩石权重 1 + 三组颜色各 4 + UV 2 */
const FPV = 21;

let decl: Laya.VertexDeclaration | null = null;
let packed = true;
/**
 * 顶点格式：位置 float×3 | 法线 int8×4（w = 岩石权重）| 颜色 uint8×4 | UV float×2 | a_Ground0 uint8×4 | a_Ground1 uint8×4，
 * 共 36 字节。引擎不支持压缩格式时退回全 float（88 字节）
 */
function groundDecl(): Laya.VertexDeclaration {
    if (decl) return decl;
    const VM = Laya.VertexMesh;
    try {
        packed = !!Laya.VertexElementFormat.getElementInfos("nbyte4") && !!Laya.VertexElementFormat.getElementInfos("ubyte4");
    } catch (e) {
        packed = false;
    }
    if (packed) {
        decl = new Laya.VertexDeclaration(36, [
            new Laya.VertexElement(0, "vector3", VM.MESH_POSITION0),
            new Laya.VertexElement(12, "nbyte4", VM.MESH_NORMAL0),
            new Laya.VertexElement(16, "ubyte4", VM.MESH_COLOR0),
            new Laya.VertexElement(20, "vector2", VM.MESH_TEXTURECOORDINATE0),
            new Laya.VertexElement(28, "ubyte4", VM.MESH_CUSTOME0),
            new Laya.VertexElement(32, "ubyte4", VM.MESH_CUSTOME1),
        ]);
    } else {
        decl = new Laya.VertexDeclaration(88, [
            new Laya.VertexElement(0, "vector3", VM.MESH_POSITION0),
            new Laya.VertexElement(12, "vector4", VM.MESH_NORMAL0),
            new Laya.VertexElement(28, "vector4", VM.MESH_COLOR0),
            new Laya.VertexElement(44, "vector2", VM.MESH_TEXTURECOORDINATE0),
            new Laya.VertexElement(52, "vector4", VM.MESH_CUSTOME0),
            new Laya.VertexElement(68, "vector4", VM.MESH_CUSTOME1),
        ]);
    }
    return decl;
}

function toByte(v: number): number {
    return v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
}

/** 地面网格构建器：共享顶点的三角网格（先 reserve，再 addVertex / addTri），顶点数接近 16 位索引上限时切分 */
export class GroundBuilder {
    private verts = new Float32Array(FPV * 1024);
    private vlen = 0;
    private idx = new Uint16Array(4096);
    private ilen = 0;
    private count = 0;
    private meshes: Laya.Mesh[] = [];
    /** 每切分出一个新 Mesh 加 1，之前返回的顶点下标作废 */
    epoch = 0;

    /** 保证接下来 n 个顶点和已有顶点在同一个 Mesh 里 */
    reserve(n: number) {
        if (this.count + n > MAX_VERTS) this.flush();
    }

    /**
     * 加一个顶点，返回下标。g / s / u 开头的是草地、沙地、底层的颜色，ga / sa 是草地、沙地 alpha，
     * ta 是山路 alpha，rock 是底层的岩石权重，(u,v) 是块内坐标（米）
     */
    addVertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, rock: number,
        gr: number, gg: number, gb: number, ga: number,
        sr: number, sg: number, sb: number, sa: number,
        ur: number, ug: number, ub: number, ta: number, u: number, v: number): number {
        if (this.vlen + FPV > this.verts.length) {
            const nv = new Float32Array(this.verts.length * 2);
            nv.set(this.verts);
            this.verts = nv;
        }
        const o = this.verts, i = this.vlen;
        o[i] = x; o[i + 1] = y; o[i + 2] = z;
        o[i + 3] = nx; o[i + 4] = ny; o[i + 5] = nz; o[i + 6] = rock;
        o[i + 7] = gr; o[i + 8] = gg; o[i + 9] = gb; o[i + 10] = ga;
        o[i + 11] = sr; o[i + 12] = sg; o[i + 13] = sb; o[i + 14] = sa;
        o[i + 15] = ur; o[i + 16] = ug; o[i + 17] = ub; o[i + 18] = ta;
        o[i + 19] = u; o[i + 20] = v;
        this.vlen = i + FPV;
        return this.count++;
    }

    /** 三角形，从上往下看顺时针（Laya 的正面） */
    addTri(a: number, b: number, c: number) {
        if (this.ilen + 3 > this.idx.length) {
            const ni = new Uint16Array(this.idx.length * 2);
            ni.set(this.idx);
            this.idx = ni;
        }
        const o = this.idx, i = this.ilen;
        o[i] = a; o[i + 1] = b; o[i + 2] = c;
        this.ilen = i + 3;
    }

    private flush() {
        if (this.count === 0) return;
        const d = groundDecl(), n = this.count, src = this.verts;
        let out: Float32Array;
        if (packed) {
            const buf = new ArrayBuffer(n * 36);
            const f32 = new Float32Array(buf), i8 = new Int8Array(buf), u8 = new Uint8Array(buf);
            for (let k = 0, s = 0; k < n; k++, s += FPV) {
                const f = k * 9, b = k * 36;
                f32[f] = src[s]; f32[f + 1] = src[s + 1]; f32[f + 2] = src[s + 2];
                i8[b + 12] = Math.round(src[s + 3] * 127);
                i8[b + 13] = Math.round(src[s + 4] * 127);
                i8[b + 14] = Math.round(src[s + 5] * 127);
                i8[b + 15] = Math.round(src[s + 6] * 127);
                for (let c = 0; c < 4; c++) u8[b + 16 + c] = toByte(src[s + 7 + c]);
                f32[f + 5] = src[s + 19]; f32[f + 6] = src[s + 20];
                for (let c = 0; c < 4; c++) u8[b + 28 + c] = toByte(src[s + 11 + c]);
                for (let c = 0; c < 4; c++) u8[b + 32 + c] = toByte(src[s + 15 + c]);
            }
            out = f32;
        } else {
            out = new Float32Array(n * 22);
            for (let k = 0, s = 0; k < n; k++, s += FPV) {
                const f = k * 22;
                out[f] = src[s]; out[f + 1] = src[s + 1]; out[f + 2] = src[s + 2];
                for (let c = 0; c < 4; c++) out[f + 3 + c] = src[s + 3 + c];
                for (let c = 0; c < 4; c++) out[f + 7 + c] = src[s + 7 + c];
                out[f + 11] = src[s + 19]; out[f + 12] = src[s + 20];
                for (let c = 0; c < 4; c++) out[f + 13 + c] = src[s + 11 + c];
                for (let c = 0; c < 4; c++) out[f + 17 + c] = src[s + 15 + c];
            }
        }
        this.meshes.push(Laya.PrimitiveMesh._createMesh(d, out, this.idx.slice(0, this.ilen)));
        this.vlen = 0;
        this.ilen = 0;
        this.count = 0;
        this.epoch++;
    }

    discard() {
        for (const m of this.meshes) m.destroy();
        this.meshes = [];
        this.vlen = 0;
        this.ilen = 0;
        this.count = 0;
        this.epoch++;
    }

    build(): Laya.Mesh[] {
        this.flush();
        const out = this.meshes;
        this.meshes = [];
        return out;
    }
}
