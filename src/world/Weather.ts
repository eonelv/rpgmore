import { WP, biomeWeather } from "./Biome";
import { valueNoise } from "./Noise";
import { SEED } from "./WorldConfig";
import { groundY } from "./WorldGen";

/**
 * 天气和氛围：按主角所在位置的地貌（biomeWeather）调整雾、背景色、环境光，并画天气粒子。
 *
 * - 雾、环境光：目标值按地貌插值（区域分界两侧约 64 米内平滑过渡），实际值再按时间指数逼近（约 SMOOTH_T 秒），
 *   走过分界时不会突变。雾的全白距离不超过 FOG_MAX（加载边界在雾里）。
 * - 阵雨、阵沙：强度 = 持续部分 + 阵发部分 × 慢变噪声（几十秒一个起伏），时有时无。
 * - 粒子：每种天气一个 Mesh（几百个面片，贴图来自运行时画的粒子图集），每帧在 CPU 上更新顶点。
 *   粒子在镜头前方的一个盒子里，粒子本身留在世界里（主角走动时不会跟着走），出了盒子从对面回来。
 *   盒子的顶、底和四周边缘、镜头附近都会淡出，看不到盒子的边界，也不会有粒子糊在镜头上。
 *   强度变化时数量逐渐增减（约 2 秒）。
 *   雪花、尘团、光点、叶片朝向镜头并各自旋转；雨丝沿下落方向拉长；萤火贴地飘、各自忽明忽暗。
 */

/** 雾在这个距离（米）处全白，不能超过加载距离（LOAD_DIST 128 + 一些余量） */
const FOG_MAX = 145;
/** 雾和环境光跟随地貌的时间常数（秒） */
const SMOOTH_T = 3;
/** 粒子数量跟随强度的时间常数（秒） */
const AMOUNT_T = 2;
/** 粒子盒子的半边长（水平，米）和高度（米）。盒子中心在镜头和主角的中点 */
const BOX_HALF = 22;
const BOX_H = 20;
/** 离镜头这么近（米）的粒子淡出 */
const NEAR_FADE = 2.5;
/** 离盒子中心超过 FAR_FADE × BOX_HALF 的粒子开始淡出，到盒子边上完全透明 */
const FAR_FADE = 0.7;
/** 盒子顶部、底部的淡入淡出高度（米） */
const EDGE_FADE_H = 2.5;

/** 粒子的形状：图集里的第几格 */
const Shape = { Flake: 0, Streak: 1, Puff: 2, Glow: 3, Leaf: 4 } as const;
/** 图集 128×128，4×4 格，每格 32 像素 */
const ATLAS = 128, CELLS = 4, CELL_PX = ATLAS / CELLS;

interface Kind {
    /** 面片数上限（电脑 / 手机） */
    max: number;
    maxMobile: number;
    /** 面片半宽、半高（米），每个粒子再乘 0.6~1.4 的随机大小 */
    w: number; h: number;
    /** 下落速度（米/秒，每个粒子 ±25%；负数是往上飘）、水平风速（米/秒，沿 +x）、飘动幅度（米/秒） */
    fall: number; wind: number; sway: number;
    /** 颜色和最大不透明度 */
    color: [number, number, number, number];
    /** 第二种颜色：每个粒子在两种颜色之间随机取 */
    color2?: [number, number, number];
    shape: number;
    additive: boolean;
    /** 雨丝：沿运动方向（下落 + 风）拉长，不随镜头旋转 */
    streak?: boolean;
    /** 萤火：贴地飘（离地 0.4~2.6 米），不下落，忽明忽暗 */
    hover?: boolean;
    /** 每个粒子的最大转速（弧度/秒） */
    spin?: number;
}

type KindName = "snow" | "rain" | "dust" | "firefly" | "leaves";

const KINDS: Record<KindName, Kind> = {
    snow: {
        max: 900, maxMobile: 360, w: 0.09, h: 0.09, fall: 1.3, wind: 0.8, sway: 0.7,
        color: [1, 1, 1, 0.95], shape: Shape.Flake, additive: false, spin: 0.8,
    },
    rain: {
        max: 1100, maxMobile: 420, w: 0.02, h: 0.55, fall: 15, wind: 2, sway: 0,
        color: [0.78, 0.85, 0.95, 0.5], shape: Shape.Streak, additive: false, streak: true,
    },
    dust: {
        max: 260, maxMobile: 110, w: 1.4, h: 1.1, fall: -0.15, wind: 7, sway: 1.5,
        color: [0.86, 0.72, 0.50, 0.22], shape: Shape.Puff, additive: false, spin: 0.3,
    },
    firefly: {
        max: 140, maxMobile: 70, w: 0.16, h: 0.16, fall: 0, wind: 0, sway: 0.4,
        color: [0.95, 1, 0.45, 1], color2: [0.55, 1, 0.55], shape: Shape.Glow, additive: true, hover: true,
    },
    leaves: {
        max: 240, maxMobile: 110, w: 0.13, h: 0.09, fall: 0.8, wind: 1.2, sway: 1.5,
        color: [0.86, 0.36, 0.12, 1], color2: [0.92, 0.70, 0.18], shape: Shape.Leaf, additive: false, spin: 2.5,
    },
};

// ---------------- 粒子图集 ----------------

function smooth01(t: number): number {
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return t * t * (3 - 2 * t);
}

/**
 * 粒子图集（运行时画，白色 + alpha，由顶点色着色）：
 * 雪花（软圆点）、雨丝（两头渐隐的细线）、尘团（边缘不规则、有浓淡）、光点（亮核 + 光晕）、叶片（带叶脉）
 */
let atlas: Laya.Texture2D | null = null;
function particleAtlas(): Laya.Texture2D {
    if (atlas) return atlas;
    const px = new Uint8Array(ATLAS * ATLAS * 4);
    const paint = (cell: number, f: (u: number, v: number) => number) => {
        const ox = (cell % CELLS) * CELL_PX, oy = Math.floor(cell / CELLS) * CELL_PX;
        for (let y = 0; y < CELL_PX; y++)
            for (let x = 0; x < CELL_PX; x++) {
                const u = ((x + 0.5) / CELL_PX) * 2 - 1, v = ((y + 0.5) / CELL_PX) * 2 - 1;
                // 每格留 1 像素透明边，双线性过滤和 mipmap 不会采到隔壁格
                const border = x === 0 || y === 0 || x === CELL_PX - 1 || y === CELL_PX - 1;
                const a = border ? 0 : Math.max(0, Math.min(1, f(u, v)));
                const i = ((oy + y) * ATLAS + ox + x) * 4;
                px[i] = px[i + 1] = px[i + 2] = 255;
                px[i + 3] = Math.round(a * 255);
            }
    };
    paint(Shape.Flake, (u, v) => smooth01(1 - Math.hypot(u, v)) * 1.6);
    paint(Shape.Streak, (u, v) => (1 - Math.min(1, Math.abs(u) * 2.2)) * (1 - v * v));
    // 尘团：轮廓微微起伏的软团，中心浓、往外慢慢变淡（浓淡只做轻微的低频变化，不出现空洞）
    paint(Shape.Puff, (u, v) => {
        const r = Math.hypot(u, v), a = Math.atan2(v, u);
        const edge = 0.9 + 0.06 * Math.sin(a * 3 + 1) + 0.04 * Math.sin(a * 5 + 2);
        const blot = 0.88 + 0.12 * Math.sin(u * 3.1 + 0.7) * Math.cos(v * 2.6 - 0.4);
        const k = Math.max(0, 1 - r / edge);
        return k * k * (3 - 2 * k) * 0.9 * blot;
    });
    // 光点：亮核 + 明显的光晕（加色混合，光晕是萤火"发光"的感觉）
    paint(Shape.Glow, (u, v) => {
        const r = Math.hypot(u, v);
        const halo = Math.max(0, 1 - r);
        return halo * halo * 0.55 + Math.max(0, 1 - r * 3.5) * 0.9;
    });
    paint(Shape.Leaf, (u, v) => {
        const w = 0.55 * (1 - v * v);
        if (Math.abs(u) > w || Math.abs(v) > 0.95) return 0;
        const vein = Math.abs(u) < 0.06 ? 0.75 : 1;
        return smooth01((w - Math.abs(u)) / 0.12) * vein;
    });
    const tex = new Laya.Texture2D(ATLAS, ATLAS, Laya.TextureFormat.R8G8B8A8, true, false, false);
    tex.setPixelsData(px, false, false);
    tex.wrapModeU = Laya.WrapMode.Clamp;
    tex.wrapModeV = Laya.WrapMode.Clamp;
    tex.lock = true;
    atlas = tex;
    return tex;
}

// ---------------- 一种天气粒子 ----------------

/** 每个顶点的浮点数：位置 3 + 颜色 4 + UV 2；每个面片 4 个顶点 */
const FPV = 9;
const FPQ = FPV * 4;

/** 一种天气粒子：每个粒子的状态 + 一个 Mesh */
class Layer {
    private sprite: Laya.MeshSprite3D;
    private mesh: Laya.Mesh;
    private n: number;
    /** 粒子位置：x、z 是世界坐标（NaN = 下次重新撒进盒子），y 是盒子里的高度 0~BOX_H */
    private px: Float32Array; private py: Float32Array; private pz: Float32Array;
    /** 每个粒子的随机数：相位、大小、下落速度倍数、两种颜色的混合比例、转速 */
    private phase: Float32Array; private size: Float32Array; private speed: Float32Array;
    private tint: Float32Array; private spinRate: Float32Array;
    private verts: Float32Array;
    /** 上一帧画的面片数 */
    private shown = 0;
    /** 强度的平滑值 */
    private amount = 0;
    private U0: number; private U1: number; private V0: number; private V1: number;

    constructor(scene: Laya.Scene3D, private k: Kind, mobile: boolean) {
        const n = this.n = mobile ? k.maxMobile : k.max;
        this.px = new Float32Array(n).fill(NaN); this.py = new Float32Array(n); this.pz = new Float32Array(n);
        this.phase = new Float32Array(n); this.size = new Float32Array(n); this.speed = new Float32Array(n);
        this.tint = new Float32Array(n); this.spinRate = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            this.py[i] = Math.random() * BOX_H;
            this.phase[i] = Math.random() * Math.PI * 2;
            this.size[i] = 0.6 + Math.random() * 0.8;
            this.speed[i] = 0.75 + Math.random() * 0.5;
            this.tint[i] = Math.random();
            this.spinRate[i] = (Math.random() * 2 - 1) * (k.spin ?? 0);
        }
        const du = 1 / CELLS;
        this.U0 = (k.shape % CELLS) * du; this.U1 = this.U0 + du;
        this.V0 = Math.floor(k.shape / CELLS) * du; this.V1 = this.V0 + du;
        this.verts = new Float32Array(n * FPQ);
        const idx = new Uint16Array(n * 6);
        for (let i = 0; i < n; i++) {
            const v = i * 4, o = i * 6;
            idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2;
            idx[o + 3] = v; idx[o + 4] = v + 2; idx[o + 5] = v + 3;
        }
        const decl = Laya.VertexMesh.getVertexDeclaration("POSITION,COLOR,UV");
        this.mesh = Laya.PrimitiveMesh._createMesh(decl, this.verts, idx);
        // 包围盒放大：顶点每帧都在变，不让引擎按旧的包围盒做视锥剔除
        this.mesh.bounds = new Laya.Bounds(new Laya.Vector3(-1e5, -1e3, -1e5), new Laya.Vector3(1e5, 1e3, 1e5));
        const m = new Laya.UnlitMaterial();
        m.enableVertexColor = true;
        m.albedoTexture = particleAtlas();
        m.albedoColor = new Laya.Color(1, 1, 1, 1);
        m.materialRenderMode = k.additive ? Laya.MaterialRenderMode.RENDERMODE_ADDTIVE : Laya.MaterialRenderMode.RENDERMODE_TRANSPARENT;
        m.cull = Laya.RenderState.CULL_NONE;
        this.sprite = new Laya.MeshSprite3D(this.mesh, "Weather");
        this.sprite.meshRenderer.sharedMaterial = m;
        this.sprite.meshRenderer.castShadow = false;
        this.sprite.meshRenderer.receiveShadow = false;
        this.sprite.active = false;
        scene.addChild(this.sprite);
    }

    /** 上一帧画的面片数 */
    get count(): number { return this.shown; }

    /**
     * 更新一帧。target：强度 0~1；(cx,cz)：盒子中心；by：盒子底面高度；
     * cam：镜头位置；right / up：镜头的右、上方向（面片朝镜头展开）；t：时间（秒）
     */
    update(dt: number, target: number, cx: number, by: number, cz: number,
        cam: Laya.Vector3, right: Laya.Vector3, up: Laya.Vector3, t: number) {
        const k = this.k;
        this.amount = dt > 0 ? this.amount + (target - this.amount) * (1 - Math.exp(-dt / AMOUNT_T)) : target;
        if (target === 0 && this.amount < 0.01) this.amount = 0;
        const count = Math.min(this.n, Math.round(this.n * this.amount));
        if (count <= 0) {
            if (this.sprite.active) this.sprite.active = false;
            for (let i = 0; i < this.shown; i++) this.px[i] = NaN;
            this.shown = 0;
            return;
        }
        if (!this.sprite.active) this.sprite.active = true;
        const px = this.px, py = this.py, pz = this.pz, ph = this.phase, v = this.verts;
        const S = 2 * BOX_HALF, x0 = cx - BOX_HALF, z0 = cz - BOX_HALF;
        const farR = BOX_HALF * FAR_FADE, farW = BOX_HALF - farR;
        const [r1, g1, b1, a] = k.color;
        const c2 = k.color2 ?? k.color;
        const { U0, U1, V0, V1 } = this;
        const near2 = NEAR_FADE * NEAR_FADE;
        // 雨丝方向：下落 + 风
        const sl = Math.hypot(k.wind, k.fall) || 1;
        const sdx = k.wind / sl, sdy = -k.fall / sl;
        const leaf = k.shape === Shape.Leaf;
        for (let i = 0; i < count; i++) {
            const p = ph[i];
            let x = px[i], y = py[i], z = pz[i];
            if (x !== x) { x = x0 + Math.random() * S; z = z0 + Math.random() * S; }
            x += (k.wind + k.sway * Math.sin(t * 0.9 + p * 3)) * dt;
            z += k.sway * Math.cos(t * 0.7 + p * 5) * dt;
            if (!k.hover) {
                y -= k.fall * this.speed[i] * dt;
                if (y < 0) y += BOX_H; else if (y > BOX_H) y -= BOX_H;
            }
            // 出了盒子从对面回来
            if (x < x0) x += S; else if (x >= x0 + S) x -= S;
            if (z < z0) z += S; else if (z >= z0 + S) z -= S;
            px[i] = x; py[i] = y; pz[i] = z;

            let wy: number, alpha = a;
            if (k.hover) {
                wy = groundAt(x, z) + 0.4 + 1.1 * (1 + Math.sin(t * 0.45 + p * 3));
                // 每只萤火虫自己的节奏：亮的时间短、暗的时间长
                const blink = Math.sin(t * (1.2 + this.speed[i]) + p * 7);
                alpha = blink > 0 ? blink * blink : 0;
            } else {
                wy = by + y;
                alpha *= Math.min(1, y / EDGE_FADE_H, (BOX_H - y) / EDGE_FADE_H);
            }
            const hx = Math.abs(x - cx), hz = Math.abs(z - cz), hd = hx > hz ? hx : hz;
            if (hd > farR) alpha *= Math.max(0, 1 - (hd - farR) / farW);
            const ex = x - cam.x, ey = wy - cam.y, ez = z - cam.z;
            const d2 = ex * ex + ey * ey + ez * ez;
            if (d2 < near2) alpha *= d2 / near2;
            const o0 = i * FPQ;
            if (alpha < 0.01) { v.fill(0, o0, o0 + FPQ); continue; }

            const sz = this.size[i], q = this.tint[i];
            const r = r1 + (c2[0] - r1) * q, g = g1 + (c2[1] - g1) * q, b = b1 + (c2[2] - b1) * q;
            let ux: number, uy: number, uz: number, vx: number, vy: number, vz: number;
            if (k.streak) {
                const w = k.w * sz, h = k.h * sz;
                ux = right.x * w; uy = 0; uz = right.z * w;
                vx = sdx * h; vy = sdy * h; vz = 0;
            } else {
                // 朝向镜头，在屏幕平面里按各自的角度旋转；叶片的宽度随时间变化（翻转）
                const ang = p + this.spinRate[i] * t;
                const ca = Math.cos(ang), sa = Math.sin(ang);
                const w = k.w * sz * (leaf ? 0.25 + 0.75 * Math.abs(Math.cos(t * 2.2 + p * 4)) : 1), h = k.h * sz;
                ux = (right.x * ca + up.x * sa) * w; uy = (right.y * ca + up.y * sa) * w; uz = (right.z * ca + up.z * sa) * w;
                vx = (up.x * ca - right.x * sa) * h; vy = (up.y * ca - right.y * sa) * h; vz = (up.z * ca - right.z * sa) * h;
            }
            let o = o0;
            o = put(v, o, x - ux - vx, wy - uy - vy, z - uz - vz, r, g, b, alpha, U0, V1);
            o = put(v, o, x + ux - vx, wy + uy - vy, z + uz - vz, r, g, b, alpha, U1, V1);
            o = put(v, o, x + ux + vx, wy + uy + vy, z + uz + vz, r, g, b, alpha, U1, V0);
            put(v, o, x - ux + vx, wy - uy + vy, z - uz + vz, r, g, b, alpha, U0, V0);
        }
        // 上一帧画过、这一帧不画的面片：缩成点，下次出现时重新撒
        if (count < this.shown) {
            v.fill(0, count * FPQ, this.shown * FPQ);
            for (let i = count; i < this.shown; i++) px[i] = NaN;
        }
        const upload = Math.max(count, this.shown);
        this.shown = count;
        // 只上传用到的部分（字节数）
        this.mesh.vertexBuffer.setData(v.buffer, 0, 0, upload * FPQ * 4);
    }
}

function put(v: Float32Array, o: number, x: number, y: number, z: number,
    r: number, g: number, b: number, a: number, u: number, w: number): number {
    v[o] = x; v[o + 1] = y; v[o + 2] = z; v[o + 3] = r; v[o + 4] = g; v[o + 5] = b; v[o + 6] = a; v[o + 7] = u; v[o + 8] = w;
    return o + FPV;
}

/** 萤火贴地：地面高度按 4 米网格缓存（groundY 比较慢） */
const groundCache = new Map<number, number>();
function groundAt(x: number, z: number): number {
    const ix = Math.floor(x / 4), iz = Math.floor(z / 4), key = ix * 100003 + iz;
    let y = groundCache.get(key);
    if (y === undefined) {
        if (groundCache.size > 20000) groundCache.clear();
        y = groundY((ix + 0.5) * 4, (iz + 0.5) * 4);
        groundCache.set(key, y);
    }
    return y;
}

// ---------------- 天气 ----------------

export class Weather {
    /** 天气粒子开关（DEBUG 面板里的按钮） */
    particlesOn = true;
    private layers: Record<KindName, Layer>;
    /** 当前的雾色、起雾距离、过渡长度、环境光（已经按时间平滑） */
    private cur = new Float32Array(8);
    private target = new Float32Array(8);
    private started = false;
    private time = 0;
    private fogColor = new Laya.Color(0, 0, 0, 1);
    private ambient = new Laya.Color(0, 0, 0, 1);
    private right = new Laya.Vector3();
    private up = new Laya.Vector3();

    constructor(private scene: Laya.Scene3D, private camera: Laya.Camera) {
        const mobile = Laya.Browser.onMobile;
        this.layers = {
            snow: new Layer(scene, KINDS.snow, mobile),
            rain: new Layer(scene, KINDS.rain, mobile),
            dust: new Layer(scene, KINDS.dust, mobile),
            firefly: new Layer(scene, KINDS.firefly, mobile),
            leaves: new Layer(scene, KINDS.leaves, mobile),
        };
        scene.enableFog = true;
    }

    /** 当前画的天气粒子面片总数（HUD 用） */
    get particleCount(): number {
        let n = 0;
        const L = this.layers;
        for (const k in L) n += L[k as KindName].count;
        return n;
    }

    /** 每帧调用。(x,z)：主角位置；dt = 0 时直接跳到目标值（出生、传送） */
    update(dt: number, x: number, z: number) {
        this.time += dt;
        const t = this.time;
        const w = biomeWeather(x, z);
        const tg = this.target;
        tg[0] = w[WP.FogR]; tg[1] = w[WP.FogG]; tg[2] = w[WP.FogB]; tg[3] = w[WP.FogStart]; tg[4] = w[WP.FogRange];
        tg[5] = w[WP.AmbR]; tg[6] = w[WP.AmbG]; tg[7] = w[WP.AmbB];
        // 阵发：慢变噪声超过阈值的时候才有（阵雨约 40 秒、阵沙约 30 秒一个起伏）
        const rainGust = Math.max(0, (valueNoise(t / 40, 0.5, SEED + 6100) - 0.55) / 0.45);
        const dustGust = Math.max(0, (valueNoise(t / 30, 3.5, SEED + 6200) - 0.5) / 0.5);
        const snow = w[WP.Snow];
        const rain = Math.min(1, w[WP.Rain] + w[WP.RainGust] * rainGust);
        const dust = Math.min(1, w[WP.Dust] + w[WP.DustGust] * dustGust);
        const firefly = w[WP.Firefly], leaves = w[WP.Leaves];

        // 雾和环境光：指数逼近目标值
        const c = this.cur;
        const f = this.started && dt > 0 ? 1 - Math.exp(-dt / SMOOTH_T) : 1;
        this.started = true;
        for (let i = 0; i < 8; i++) c[i] += (tg[i] - c[i]) * f;
        // 下雨、风沙时雾更近、更暗
        const thick = Math.max(rain * 0.35, dust * 0.5);
        const dim = 1 - rain * 0.15;
        const start = c[3] * (1 - thick);
        const range = Math.min(c[4], FOG_MAX - start);
        this.fogColor.setValue(c[0] * dim, c[1] * dim, c[2] * dim, 1);
        this.scene.fogColor = this.fogColor;
        this.scene.fogStart = start;
        this.scene.fogRange = range;
        this.camera.clearColor = this.fogColor;
        this.ambient.setValue(c[5] * dim, c[6] * dim, c[7] * dim, 1);
        this.scene.ambientColor = this.ambient;

        // 粒子盒子：中心在镜头和主角的中点（镜头拉远时盒子也往镜头那边挪，粒子还在画面里）
        const tr = this.camera.transform;
        tr.getRight(this.right);
        tr.getUp(this.up);
        const cam = tr.position;
        const bx = (cam.x + x) / 2, bz = (cam.z + z) / 2;
        const by = groundAt(bx, bz) - 2;
        const on = this.particlesOn;
        const L = this.layers, R = this.right, U = this.up;
        L.snow.update(dt, on ? snow : 0, bx, by, bz, cam, R, U, t);
        L.rain.update(dt, on ? rain : 0, bx, by, bz, cam, R, U, t);
        L.dust.update(dt, on ? dust : 0, bx, by, bz, cam, R, U, t);
        L.firefly.update(dt, on ? firefly : 0, bx, by, bz, cam, R, U, t);
        L.leaves.update(dt, on ? leaves : 0, bx, by, bz, cam, R, U, t);
    }

    /** HUD 用：这里的天气（文字） */
    describe(x: number, z: number): string {
        const w = biomeWeather(x, z);
        const parts: string[] = [];
        if (w[WP.Snow] > 0.05) parts.push("雪");
        if (w[WP.Rain] > 0.05) parts.push("雨");
        else if (w[WP.RainGust] > 0.05) parts.push("阵雨");
        if (w[WP.Dust] > 0.05) parts.push("风沙");
        else if (w[WP.DustGust] > 0.05) parts.push("阵沙");
        if (w[WP.Firefly] > 0.05) parts.push("萤火");
        if (w[WP.Leaves] > 0.05) parts.push("落叶");
        return parts.join(" ");
    }
}
