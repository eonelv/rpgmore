import { GOLD, RED, RED_DARK, Rect, SKIN, SKIN_SHADE, T_FACE, T_HAIR, T_KIMONO, T_STRIPE, archerAtlas, faceU } from "./ArcherTexture";
import { MeshBuilder, RGB } from "./MeshBuilder";

/**
 * 二次元弓手少女（程序化生成，顶点色 + 一张运行时画出来的贴图，见 ArcherTexture）。
 * 身体、四肢、头、头发都是“放样曲面”：一圈圈水平截面连成的光滑表面，顶点共用、法线平滑。
 * 脸（五官）、和服布料、头发、衬裙用贴图，其余部件是纯色（顶点色）。
 * 卡通描边：每个部件另有一份沿法线外扩的黑色网格，只画背面，在轮廓上露出一圈黑边。
 *
 * 造型：银色长发高马尾 + 红色大蝴蝶结、刘海和垂到胸前的鬓发、红色眼睛；
 * 不对称的红黑和风短装（持弓手一侧是红色和服 + 宽袖 + 黑金肩甲，另一侧是黑色抹胸 + 露肩 + 黑色长手套）、
 * 黑色腰封和金腰绳、红色短裙露出条纹衬裙、背后的大结和飘动的后摆、腰间挂着的鬼面、
 * 大腿绑带、过膝袜、短靴；深色长弓。
 *
 * 节点：躯干 / 头 / 两条腿 / 两条手臂 / 马尾两节 / 后摆 / 弓 / 弓弦 / 搭在弦上的箭，动作全部用代码驱动：
 * - 走路：腿前后摆、手臂反向摆、身体上下颠，马尾和后摆往后飘
 * - 站立：呼吸起伏，马尾轻轻左右晃
 * - 射箭：持弓手把弓举到身前，拉弦手跟着弓弦往后拉，松手后弓弦弹回
 * 模型朝向 +Z，原点在脚底。
 */

const HAIR: RGB = [0.97, 0.97, 1];
const HAIR_SHADE: RGB = [0.8, 0.82, 0.94];
const BLACK: RGB = [0.11, 0.1, 0.13];
const WHITE: RGB = [0.97, 0.96, 0.94];
/** 贴图自带颜色的部件用纯白顶点色 */
const TEX: RGB = [1, 1, 1];
const STOCKING: RGB = [0.24, 0.15, 0.17];
const WOOD: RGB = [0.4, 0.22, 0.13];
const SHAFT: RGB = [0.62, 0.42, 0.2];
const STRING: RGB = [0.96, 0.96, 0.9];
const STEEL: RGB = [0.8, 0.84, 0.9];

/** 胯部离地高度（腿长） */
const HIP = 0.82;
/** 肩膀相对胯部的位置（左右对称） */
const SHOULDER_X = 0.19, SHOULDER_Y = 0.4;
/** 肩膀到手心的长度（上臂、小臂各一半） */
const ARM = 0.56;
/** 手臂自然下垂时肩膀到手的距离：比臂长短一点，手肘微弯 */
const REACH = 0.5;
/** 胯到膝盖的长度 */
const KNEE = 0.4;
/** 脖子根部相对胯部的高度（头节点的位置） */
const NECK = 0.52;
/** 头部整体缩放：头的网格是按卡通大头建的，缩到写实比例（头高约 0.25 米） */
const HEAD = 0.66;
/** 马尾整体缩放（跟着头变小） */
const TAIL = 0.75;
/** 瞄准时弓的位置（相对胯部） */
const BOW_AIM = [0.16, 0.42, 0.55];
/** 弓梢相对弓把的位置：上下 ±TIP_Y，往后 TIP_Z */
const TIP_Y = 0.78, TIP_Z = -0.24;
/** 马尾第一节的长度 */
const TAIL_SEG = 0.5;
/** 描边的粗细（米） */
const OUTLINE = 0.007;
/** 弓弦拉满时往后拉的距离 */
export const DRAW_MAX = 0.3;
/** 箭的长度（箭模型沿 +Z，中心在原点） */
export const ARROW_LEN = 0.9;

// ---------------- 建模工具 ----------------

/**
 * 描边网格的构建器：只收放样曲面（顶点沿法线外扩 width），
 * tri / box / quad 这些平面着色的小零件全部忽略（它们的法线在棱上不连续，外扩后会裂开）
 */
class HullBuilder extends MeshBuilder {
    constructor(readonly width: number) { super(false); }
    tri(): void { /* 忽略 */ }
}

/** 放样曲面的一圈截面：高度 y、左右半径 rx、前后半径 rz、颜色，cx/cz = 截面中心的偏移 */
interface Ring { y: number; rx: number; rz: number; col: RGB; cx: number; cz: number }

function R(y: number, rx: number, rz: number, col: RGB, cx = 0, cz = 0): Ring {
    return { y, rx, rz, col, cx, cz };
}

interface LoftOpts {
    /** 每个顶点的半径倍数：a = 绕 Y 轴的角度（0 = +X，π/2 = 正前方 +Z），i = 第几圈 */
    shape?: (a: number, i: number) => number;
    /** 每个顶点的颜色（不给就用这一圈的颜色） */
    color?: (a: number, i: number, base: RGB) => RGB;
    /** 贴图：横向绕一圈铺满这一块（接缝在正后方），纵向从最高的一圈到最低的一圈 */
    tex?: Rect;
    /** 横向贴图坐标的重新映射（0~1 → 0~1），脸用它把正面放大 */
    uMap?: (s: number) => number;
}

/**
 * 放样曲面：把一圈圈水平的椭圆截面连成光滑的表面（顶点共用，法线按周围各面平均）。
 * 半径为 0 的一圈会收成一个尖（封口用）。相邻两圈的高度不要完全相同。
 * 每圈 seg + 1 个顶点：第一个和最后一个位置相同（在正后方），贴图坐标分别是 0 和 1
 */
function loft(mb: MeshBuilder, rings: Ring[], seg: number, opts?: LoftOpts) {
    const cols = seg + 1, n = rings.length * cols;
    const P = new Float32Array(n * 3), N = new Float32Array(n * 3);
    const angle = (j: number) => -Math.PI / 2 + ((j % seg) / seg) * Math.PI * 2;
    for (let i = 0; i < rings.length; i++) {
        const r = rings[i];
        for (let j = 0; j < cols; j++) {
            const a = angle(j), m = opts?.shape ? opts.shape(a, i) : 1, o = (i * cols + j) * 3;
            P[o] = r.cx + Math.cos(a) * r.rx * m;
            P[o + 1] = r.y;
            P[o + 2] = r.cz + Math.sin(a) * r.rz * m;
        }
    }
    // 三角形（顶点下标），并把面法线（朝外）累加到三个顶点上
    const T: number[] = [];
    const face = (ia: number, ib: number, ic: number, ox: number, oy: number, oz: number) => {
        const a = ia * 3, b = ib * 3, c = ic * 3;
        const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
        const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        if (nx * nx + ny * ny + nz * nz < 1e-16) return;   // 收尖处退化的三角形
        const mx = (P[a] + P[b] + P[c]) / 3 - ox, my = (P[a + 1] + P[b + 1] + P[c + 1]) / 3 - oy,
            mz = (P[a + 2] + P[b + 2] + P[c + 2]) / 3 - oz;
        // Laya 的正面：从法线方向看过去是顺时针（和 MeshBuilder.tri 一致）
        if (nx * mx + ny * my + nz * mz < 0) { nx = -nx; ny = -ny; nz = -nz; T.push(ia, ib, ic); }
        else T.push(ia, ic, ib);
        for (const k of [a, b, c]) { N[k] += nx; N[k + 1] += ny; N[k + 2] += nz; }
    };
    for (let i = 0; i < rings.length - 1; i++) {
        const r0 = rings[i], r1 = rings[i + 1];
        const ox = (r0.cx + r1.cx) / 2, oy = (r0.y + r1.y) / 2, oz = (r0.cz + r1.cz) / 2;
        for (let j = 0; j < seg; j++) {
            const a = i * cols + j, b = a + 1, c = (i + 1) * cols + j, d = c + 1;
            face(a, b, d, ox, oy, oz);
            face(a, d, c, ox, oy, oz);
        }
    }
    // 位置相同的顶点法线要一致：接缝的两个顶点合并；收尖的一圈全部合并
    for (let i = 0; i < rings.length; i++) {
        const pole = rings[i].rx === 0 && rings[i].rz === 0;
        const group = pole ? cols : 2;
        let sx = 0, sy = 0, sz = 0;
        for (let g = 0; g < group; g++) {
            const o = (i * cols + (pole ? g : g * seg)) * 3;
            sx += N[o]; sy += N[o + 1]; sz += N[o + 2];
        }
        let len = Math.hypot(sx, sy, sz);
        if (len < 1e-9) {
            // 算不出来（孤立的尖）：朝远离相邻一圈的方向
            const other = rings[i === 0 ? 1 : i - 1];
            sx = 0; sy = rings[i].y >= other.y ? 1 : -1; sz = 0; len = 1;
        }
        for (let g = 0; g < group; g++) {
            const o = (i * cols + (pole ? g : g * seg)) * 3;
            N[o] = sx / len; N[o + 1] = sy / len; N[o + 2] = sz / len;
        }
    }
    for (let o = 0; o < N.length; o += 3) {
        const len = Math.hypot(N[o], N[o + 1], N[o + 2]);
        if (len > 1e-9) { N[o] /= len; N[o + 1] /= len; N[o + 2] /= len; } else N[o + 1] = 1;
    }

    const grow = mb instanceof HullBuilder ? mb.width : 0;
    let yMax = -Infinity, yMin = Infinity;
    for (const r of rings) { yMax = Math.max(yMax, r.y); yMin = Math.min(yMin, r.y); }
    const t = opts?.tex;
    mb.reserve(n);
    let base = 0;
    for (let i = 0; i < rings.length; i++) {
        for (let j = 0; j < cols; j++) {
            const o = (i * cols + j) * 3;
            const c = opts?.color ? opts.color(angle(j), i, rings[i].col) : rings[i].col;
            let u = 0, v = 0;
            if (t) {
                const s = j / seg;
                u = t[0] + (opts?.uMap ? opts.uMap(s) : s) * (t[2] - t[0]);
                v = t[1] + ((yMax - rings[i].y) / (yMax - yMin || 1)) * (t[3] - t[1]);
            }
            const idx = mb.addVertex(P[o] + N[o] * grow, P[o + 1] + N[o + 1] * grow, P[o + 2] + N[o + 2] * grow,
                N[o], N[o + 1], N[o + 2], c[0], c[1], c[2], 1, u, v);
            if (i === 0 && j === 0) base = idx;
        }
    }
    for (let k = 0; k < T.length; k += 3) mb.addTri(base + T[k], base + T[k + 1], base + T[k + 2]);
}

/** 光滑的椭球。上半用 top 颜色（做蝴蝶结的明暗） */
function ellipsoid(mb: MeshBuilder, x: number, y: number, z: number, rx: number, ry: number, rz: number, col: RGB,
    seg = 10, lat = 6, top: RGB = col, tex?: Rect) {
    const rings: Ring[] = [];
    for (let k = 0; k <= lat; k++) {
        const p = (k / lat) * Math.PI, s = k === 0 || k === lat ? 0 : Math.sin(p);
        rings.push(R(y + ry * Math.cos(p), rx * s, rz * s, k * 2 < lat ? top : col, x, z));
    }
    loft(mb, rings, seg, { tex });
}

/**
 * 一绺头发：从 a 垂到 b 的光滑尖条（上面细、中间鼓、下面收尖），flat = 前后方向压扁的程度。
 * 只适合大致上下走向的发绺
 */
function lock(mb: MeshBuilder, a: number[], b: number[], r: number, col: RGB, tip: RGB = col, flat = 0.7, seg = 6) {
    const prof = [0.5, 1, 0.9, 0.55, 0];
    const rings: Ring[] = [];
    for (let k = 0; k < prof.length; k++) {
        const t = k / (prof.length - 1);
        rings.push(R(a[1] + (b[1] - a[1]) * t, r * prof[k], r * prof[k] * flat, t > 0.6 ? tip : col,
            a[0] + (b[0] - a[0]) * t, a[2] + (b[2] - a[2]) * t));
    }
    loft(mb, rings, seg, { tex: T_HAIR });
}

/**
 * 任意方向的棱台（细小的装饰件用，平面着色）：从 a（半径 r0）到 b（半径 r1），r1 = 0 时是圆锥。
 * capA / capB = 是否封上两头
 */
function tube(mb: MeshBuilder, ax: number, ay: number, az: number, bx: number, by: number, bz: number,
    r0: number, r1: number, col: RGB, sides = 6, capA = true, capB = true) {
    let dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len; dy /= len; dz /= len;
    // 和轴垂直的两个方向 u、v
    let ux: number, uy: number, uz: number;
    if (Math.abs(dy) < 0.9) { ux = dz; uy = 0; uz = -dx; }   // 轴 × (0,1,0)
    else { ux = 0; uy = -dz; uz = dy; }                       // 轴 × (1,0,0)
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
    const mx = (ax + bx) / 2, my = (ay + by) / 2, mz = (az + bz) / 2;
    const ring = (cx: number, cy: number, cz: number, r: number, i: number): number[] => {
        const a = (i / sides) * Math.PI * 2, c = Math.cos(a) * r, s = Math.sin(a) * r;
        return [cx + ux * c + vx * s, cy + uy * c + vy * s, cz + uz * c + vz * s];
    };
    for (let i = 0; i < sides; i++) {
        const a0 = ring(ax, ay, az, r0, i), a1 = ring(ax, ay, az, r0, i + 1);
        if (r1 > 1e-4) {
            const b0 = ring(bx, by, bz, r1, i), b1 = ring(bx, by, bz, r1, i + 1);
            mb.quad(a0, a1, b1, b0, col, [mx, my, mz]);
            if (capB) mb.tri(b0[0], b0[1], b0[2], b1[0], b1[1], b1[2], bx, by, bz, col, mx, my, mz);
        } else {
            mb.tri(a0[0], a0[1], a0[2], a1[0], a1[1], a1[2], bx, by, bz, col, mx, my, mz);
        }
        if (capA) mb.tri(a0[0], a0[1], a0[2], a1[0], a1[1], a1[2], ax, ay, az, col, mx, my, mz);
    }
}

/** 正反两面都画的薄片 a-b-c-d，nx/ny/nz 是薄片大致的法线方向 */
function sheet(mb: MeshBuilder, a: number[], b: number[], c: number[], d: number[], col: RGB,
    nx: number, ny: number, nz: number) {
    const mx = (a[0] + c[0]) / 2, my = (a[1] + c[1]) / 2, mz = (a[2] + c[2]) / 2;
    mb.quad(a, b, c, d, col, [mx + nx * 10, my + ny * 10, mz + nz * 10]);
    mb.quad(a, b, c, d, col, [mx - nx * 10, my - ny * 10, mz - nz * 10]);
}

/** 一个部件的两份网格：本体，和描边用的外扩网格（没有光滑曲面的部件没有描边） */
interface PartMesh { mesh: Laya.Mesh; hull: Laya.Mesh | null }

/** 用同一个建模函数生成本体和描边网格。outline = 描边粗细，0 = 不要描边 */
function build(fn: (mb: MeshBuilder) => void, outline = OUTLINE): PartMesh {
    const mb = new MeshBuilder(true);
    fn(mb);
    let hull: Laya.Mesh | null = null;
    if (outline > 0) {
        const hb = new HullBuilder(outline);
        fn(hb);
        hull = hb.build()[0] ?? null;
    }
    return { mesh: mb.build()[0], hull };
}

let actorMat: Laya.BlinnPhongMaterial | null = null;
/** 弓手和箭共用的材质：顶点色 × 贴图图集（没有贴图的部件采到图集的白色部分） */
export function actorMaterial(): Laya.BlinnPhongMaterial {
    if (!actorMat) {
        actorMat = new Laya.BlinnPhongMaterial();
        actorMat.enableVertexColor = true;
        actorMat.albedoColor = new Laya.Color(1, 1, 1, 1);
        actorMat.specularColor = new Laya.Color(0, 0, 0, 1);
        actorMat.albedoTexture = archerAtlas();
        actorMat.lock = true;
    }
    return actorMat;
}

let outlineMat: Laya.UnlitMaterial | null = null;
/** 描边材质：不受光照的深色，剔除正面只画背面 */
function outlineMaterial(): Laya.UnlitMaterial {
    if (!outlineMat) {
        outlineMat = new Laya.UnlitMaterial();
        outlineMat.albedoColor = new Laya.Color(0.16, 0.07, 0.1, 1);
        outlineMat.cull = Laya.RenderState.CULL_FRONT;
        outlineMat.lock = true;
    }
    return outlineMat;
}

/** 把一个部件加到父节点下（描边网格是它的子节点，跟着它一起动） */
function addPart(pm: PartMesh, parent: Laya.Sprite3D, x: number, y: number, z: number): Laya.MeshSprite3D {
    const node = new Laya.MeshSprite3D(pm.mesh);
    node.meshRenderer.sharedMaterial = actorMaterial();
    node.transform.localPosition = new Laya.Vector3(x, y, z);
    parent.addChild(node);
    if (pm.hull) {
        const h = new Laya.MeshSprite3D(pm.hull);
        h.meshRenderer.sharedMaterial = outlineMaterial();
        h.meshRenderer.castShadow = false;
        node.addChild(h);
    }
    return node;
}

let sharedArrow: Laya.Mesh | null = null;
/** 箭的模型：箭杆 + 箭头 + 三片尾羽。沿 +Z，箭头在 +Z 一端，中心在原点。所有箭共用一份 */
export function arrowMesh(): Laya.Mesh {
    if (sharedArrow) return sharedArrow;
    const mb = new MeshBuilder(true);
    const h = ARROW_LEN / 2;
    tube(mb, 0, 0, -h, 0, 0, h - 0.16, 0.018, 0.018, SHAFT, 5);
    tube(mb, 0, 0, h - 0.18, 0, 0, h, 0.05, 0, STEEL, 4);
    // 尾羽：三片薄片
    for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + Math.PI / 2, fx = Math.cos(a), fy = Math.sin(a);
        sheet(mb, [0, 0, -h + 0.02], [0, 0, -h + 0.24], [fx * 0.06, fy * 0.06, -h + 0.2], [fx * 0.085, fy * 0.085, -h],
            RED, -fy, fx, 0);
    }
    sharedArrow = mb.build()[0];
    sharedArrow.lock = true;
    return sharedArrow;
}

// ---------------- 各个部件 ----------------

/** 大腿（原点在胯关节，往下到膝盖）：大腿 + 袜口；strap = 有没有绑带 */
function buildThigh(mb: MeshBuilder, strap: boolean) {
    loft(mb, [
        R(0.02, 0.085, 0.09, SKIN), R(-0.1, 0.092, 0.095, SKIN), R(-0.24, 0.08, 0.082, SKIN_SHADE),
        R(-0.25, 0.083, 0.085, RED), R(-0.272, 0.082, 0.084, RED),                       // 袜口的红边
        R(-0.28, 0.079, 0.081, STOCKING), R(-KNEE, 0.062, 0.065, STOCKING),
        R(-KNEE - 0.04, 0.04, 0.042, STOCKING), R(-KNEE - 0.055, 0, 0, STOCKING),
    ], 12);
    if (strap) {
        loft(mb, [R(-0.13, 0.094, 0.097, BLACK), R(-0.17, 0.092, 0.095, BLACK)], 12);
        mb.box(0.03, -0.168, 0.085, 0.04, 0.034, 0.02, GOLD);
    }
}

/** 小腿（原点在膝盖，往下到脚底）：膝盖 + 过膝袜 + 短靴 + 脚 */
function buildShin(mb: MeshBuilder) {
    const foot = -(HIP - KNEE);
    ellipsoid(mb, 0, 0, 0, 0.062, 0.062, 0.066, STOCKING, 10, 6);   // 膝盖：弯腿时填住大腿和小腿之间的缝
    loft(mb, [
        R(0.03, 0.058, 0.061, STOCKING), R(-0.1, 0.064, 0.07, STOCKING, 0, -0.012),      // 小腿肚
        R(-0.2, 0.05, 0.054, STOCKING, 0, -0.008),
        R(-0.21, 0.058, 0.062, GOLD), R(-0.23, 0.058, 0.062, GOLD),                      // 靴口金边
        R(-0.24, 0.055, 0.058, BLACK), R(-0.34, 0.046, 0.05, BLACK), R(foot + 0.01, 0.048, 0.055, BLACK),
        R(foot, 0, 0, BLACK),
    ], 12);
    ellipsoid(mb, 0, foot + 0.04, 0.055, 0.05, 0.04, 0.115, BLACK, 10, 6);
}

/** 躯干（原点在胯部）：身体 + 上衣 + 腰封 + 短裙 + 背后的结 + 腰间的鬼面 */
function buildTorso(mb: MeshBuilder) {
    // 胯和腰封
    loft(mb, [
        R(-0.13, 0, 0, BLACK), R(-0.1, 0.09, 0.08, BLACK), R(-0.04, 0.135, 0.108, BLACK),
        R(0.04, 0.132, 0.104, BLACK), R(0.12, 0.112, 0.088, BLACK), R(0.205, 0.112, 0.09, BLACK),
    ], 16);
    // 上衣（和服贴图）。不对称：持弓手（+X）一侧是红色和服，另一侧是黑色抹胸
    loft(mb, [R(0.2, 0.118, 0.094, TEX), R(0.3, 0.138, 0.105, TEX), R(0.38, 0.15, 0.1, TEX), R(0.428, 0.12, 0.085, TEX)],
        16, { tex: T_KIMONO, color: (a, _i, base) => Math.cos(a) < -0.2 ? BLACK : base });
    ellipsoid(mb, 0.058, 0.3, 0.075, 0.063, 0.058, 0.058, TEX, 10, 6, TEX, T_KIMONO);
    ellipsoid(mb, -0.058, 0.3, 0.075, 0.063, 0.058, 0.058, BLACK, 10, 6);
    // 领口和脖子
    loft(mb, [R(0.42, 0.123, 0.087, BLACK), R(0.45, 0.055, 0.05, BLACK), R(0.46, 0.046, 0.046, SKIN),
    R(0.54, 0.042, 0.042, SKIN)], 12);
    // 和服衣襟的金边、颈带
    tube(mb, -0.028, 0.205, 0.098, -0.03, 0.43, 0.092, 0.009, 0.009, GOLD, 4);
    loft(mb, [R(0.478, 0.049, 0.049, BLACK), R(0.496, 0.048, 0.048, BLACK)], 10);
    ellipsoid(mb, 0, 0.485, 0.05, 0.012, 0.012, 0.008, GOLD, 6, 4);
    // 金腰绳和正面的结
    loft(mb, [R(0.112, 0.118, 0.094, GOLD), R(0.136, 0.118, 0.095, GOLD)], 16);
    ellipsoid(mb, 0, 0.124, 0.1, 0.03, 0.03, 0.022, GOLD, 8, 4);
    tube(mb, 0.01, 0.11, 0.105, 0.03, 0.02, 0.125, 0.008, 0.012, GOLD, 4);
    tube(mb, -0.01, 0.11, 0.105, -0.035, 0.03, 0.125, 0.008, 0.012, GOLD, 4);

    // 条纹衬裙（略长）和红色短裙（和服贴图），金色裙边
    loft(mb, [R(0.06, 0.12, 0.096, TEX), R(-0.06, 0.165, 0.14, TEX), R(-0.2, 0.215, 0.19, TEX),
    R(-0.36, 0.258, 0.228, TEX)], 16, { tex: T_STRIPE });
    loft(mb, [R(0.1, 0.122, 0.098, TEX), R(0, 0.165, 0.135, TEX), R(-0.12, 0.222, 0.192, TEX),
    R(-0.265, 0.277, 0.242, TEX)], 16, { tex: T_KIMONO });
    loft(mb, [R(-0.26, 0.277, 0.242, GOLD), R(-0.295, 0.288, 0.252, GOLD)], 16);

    // 背后腰封上的大结
    ellipsoid(mb, 0.1, 0.14, -0.13, 0.11, 0.075, 0.045, RED_DARK, 10, 6, RED);
    ellipsoid(mb, -0.1, 0.14, -0.13, 0.11, 0.075, 0.045, RED_DARK, 10, 6, RED);
    ellipsoid(mb, 0, 0.14, -0.14, 0.04, 0.045, 0.04, GOLD, 8, 4);

    // 挂在腰间的鬼面：黑红的脸、两只角、金色的眼睛和牙
    const mx = -0.17, my = -0.05, mz = 0.165;
    ellipsoid(mb, mx, my, mz, 0.055, 0.07, 0.035, RED_DARK, 10, 6, BLACK);
    tube(mb, mx - 0.03, my + 0.05, mz + 0.01, mx - 0.055, my + 0.13, mz + 0.03, 0.016, 0, RED, 5);
    tube(mb, mx + 0.03, my + 0.05, mz + 0.01, mx + 0.055, my + 0.13, mz + 0.03, 0.016, 0, RED, 5);
    mb.box(mx - 0.022, my + 0.005, mz + 0.03, 0.02, 0.012, 0.012, GOLD);
    mb.box(mx + 0.022, my + 0.005, mz + 0.03, 0.02, 0.012, 0.012, GOLD);
    mb.box(mx, my - 0.045, mz + 0.024, 0.04, 0.012, 0.012, GOLD);
    tube(mb, mx, my + 0.07, mz, -0.11, 0.12, 0.09, 0.005, 0.005, RED, 3);   // 挂绳
}

/** 头（原点在脖子根部）：脸 + 头发 + 刘海 + 鬓发 + 蝴蝶结。五官画在脸的贴图上 */
function buildHead(mb: MeshBuilder) {
    // 脸：下巴收尖的蛋形。高度范围 0.02 ~ 0.39 和 ArcherTexture.paintFace 里的换算对应
    loft(mb, [
        R(0.39, 0, 0, TEX), R(0.375, 0.07, 0.08, TEX), R(0.33, 0.13, 0.14, TEX), R(0.27, 0.16, 0.165, TEX),
        R(0.2, 0.165, 0.165, TEX), R(0.14, 0.15, 0.15, TEX), R(0.09, 0.115, 0.115, TEX, 0, 0.008),
        R(0.05, 0.07, 0.075, TEX, 0, 0.02), R(0.02, 0, 0, TEX, 0, 0.03),
    ], 24, { tex: T_FACE, uMap: faceU });

    // 头发：罩住头顶、两侧和后脑；刘海线以下正面的部分缩进脸里面藏起来，脸就露出来了
    const front = (a: number, i: number) => Math.sin(a) > 0.35 && i >= 5 ? (i >= 7 ? 0.3 : 0.6) : 1;
    loft(mb, [
        R(0.418, 0, 0, HAIR, 0, -0.01), R(0.4, 0.09, 0.09, HAIR, 0, -0.01), R(0.36, 0.15, 0.155, HAIR, 0, -0.01),
        R(0.3, 0.18, 0.185, HAIR, 0, -0.01), R(0.24, 0.187, 0.19, HAIR, 0, -0.01),
        R(0.18, 0.185, 0.185, HAIR_SHADE, 0, -0.012), R(0.1, 0.16, 0.165, HAIR_SHADE, 0, -0.02),
        R(0.03, 0.11, 0.12, HAIR_SHADE, 0, -0.03), R(-0.02, 0, 0, HAIR_SHADE, 0, -0.03),
    ], 16, { shape: front, tex: T_HAIR });

    // 刘海：几绺往下的尖，中间短两边长
    const bangs = [[-0.125, 0.19], [-0.072, 0.232], [-0.02, 0.25], [0.035, 0.228], [0.085, 0.245], [0.132, 0.19]];
    for (const [x, tipY] of bangs)
        lock(mb, [x * 0.8, 0.39, 0.09], [x, tipY, 0.172 - Math.abs(x) * 0.22], 0.05, HAIR, HAIR_SHADE, 0.55);
    // 鬓发：垂到胸前
    for (const s of [1, -1])
        lock(mb, [s * 0.165, 0.28, 0.07], [s * 0.172, -0.15, 0.1], 0.042, HAIR, HAIR_SHADE, 0.7);

    // 马尾的发根 + 红色大蝴蝶结：两片翅膀、中间的结、两条带金色坠子的飘带
    ellipsoid(mb, 0, 0.41, -0.1, 0.075, 0.065, 0.075, HAIR, 10, 6, HAIR, T_HAIR);
    for (const s of [1, -1]) {
        ellipsoid(mb, s * 0.145, 0.49, -0.11, 0.125, 0.085, 0.032, RED_DARK, 10, 6, RED);
        sheet(mb, [s * 0.03, 0.44, -0.13], [s * 0.085, 0.44, -0.13], [s * 0.21, 0.19, -0.18], [s * 0.14, 0.19, -0.18],
            RED, 0, 0, 1);
        mb.box(s * 0.175, 0.15, -0.18, 0.06, 0.045, 0.02, GOLD);
    }
    ellipsoid(mb, 0, 0.465, -0.118, 0.045, 0.05, 0.04, RED, 8, 4);
}

/** 上臂（原点在肩膀，往下到手肘）。sleeve = 持弓手：肩甲 + 红色宽袖；否则是拉弦手：露肩 + 手套的上半截 */
function buildUpperArm(mb: MeshBuilder, sleeve: boolean) {
    const E = ARM / 2;
    if (sleeve) {
        // 袖子里的上臂
        loft(mb, [R(-0.15, 0.044, 0.044, STOCKING), R(-E, 0.044, 0.044, STOCKING), R(-E - 0.03, 0, 0, STOCKING)], 10);
        // 宽袖（和服贴图）：越往下越宽，金色袖口
        loft(mb, [R(0.06, 0, 0, TEX), R(0.04, 0.055, 0.055, TEX), R(-0.05, 0.066, 0.066, TEX), R(-0.2, 0.08, 0.085, TEX),
        R(-0.3, 0.094, 0.104, TEX)], 12, { tex: T_KIMONO });
        loft(mb, [R(-0.295, 0.095, 0.105, GOLD), R(-0.325, 0.097, 0.107, GOLD)], 12);
        // 肩甲：黑底金边，往外张开
        loft(mb, [R(0.085, 0, 0, BLACK, 0.02), R(0.07, 0.06, 0.06, BLACK, 0.02), R(-0.03, 0.1, 0.1, BLACK, 0.025),
        R(-0.15, 0.13, 0.125, BLACK, 0.03), R(-0.158, 0.133, 0.128, GOLD, 0.03), R(-0.185, 0.136, 0.131, GOLD, 0.03)], 12);
        ellipsoid(mb, 0.115, -0.05, 0, 0.02, 0.05, 0.035, GOLD, 8, 4);
    } else {
        // 露出的肩膀和上臂，黑色长手套从手肘上面开始（金色手套口）
        loft(mb, [R(0.055, 0, 0, SKIN), R(0.035, 0.045, 0.045, SKIN), R(-0.02, 0.054, 0.054, SKIN), R(-0.12, 0.048, 0.048, SKIN),
        R(-0.19, 0.044, 0.044, SKIN_SHADE),
        R(-0.195, 0.05, 0.05, GOLD), R(-0.215, 0.05, 0.05, GOLD),
        R(-0.22, 0.048, 0.048, BLACK), R(-E, 0.046, 0.046, BLACK), R(-E - 0.03, 0, 0, BLACK)], 10);
    }
}

/** 小臂（原点在手肘，往下到手心）：手肘 + 小臂 + 手。sleeve = 持弓手：深色小臂 + 金手镯；否则是黑手套 */
function buildForearm(mb: MeshBuilder, sleeve: boolean) {
    const hand = -ARM / 2 + 0.01;
    if (sleeve) {
        ellipsoid(mb, 0, 0, 0, 0.046, 0.046, 0.046, STOCKING, 8, 5);
        loft(mb, [R(0.02, 0.044, 0.044, STOCKING), R(-0.16, 0.034, 0.034, STOCKING),
        R(-0.165, 0.04, 0.04, GOLD), R(-0.2, 0.04, 0.04, GOLD), R(-0.205, 0.032, 0.032, SKIN), R(-0.23, 0.03, 0.03, SKIN)], 10);
        ellipsoid(mb, 0, hand, 0, 0.038, 0.055, 0.034, SKIN, 8, 5);
    } else {
        ellipsoid(mb, 0, 0, 0, 0.048, 0.048, 0.048, BLACK, 8, 5);
        loft(mb, [R(0.02, 0.046, 0.046, BLACK), R(-0.1, 0.042, 0.042, BLACK), R(-0.22, 0.034, 0.034, BLACK)], 10);
        ellipsoid(mb, 0, hand, 0, 0.038, 0.055, 0.034, BLACK, 8, 5);
    }
}

/** 马尾的一节（原点在上端，沿 -Y 垂下）。tip = 最后一节，收成发梢并岔出几绺 */
function buildTail(mb: MeshBuilder, tip: boolean) {
    if (!tip) {
        loft(mb, [R(0.03, 0, 0, HAIR), R(0, 0.05, 0.045, HAIR), R(-0.1, 0.09, 0.075, HAIR), R(-0.26, 0.105, 0.085, HAIR),
        R(-TAIL_SEG, 0.09, 0.075, HAIR_SHADE), R(-TAIL_SEG - 0.04, 0.05, 0.04, HAIR_SHADE)], 10, { tex: T_HAIR });
    } else {
        loft(mb, [R(0.05, 0.06, 0.05, HAIR_SHADE), R(-0.05, 0.088, 0.072, HAIR_SHADE), R(-0.25, 0.078, 0.06, HAIR),
        R(-0.45, 0.045, 0.036, HAIR), R(-0.62, 0, 0, HAIR)], 10, { tex: T_HAIR });
        lock(mb, [0.04, -0.05, 0], [0.13, -0.5, 0.02], 0.045, HAIR_SHADE, HAIR, 0.7);
        lock(mb, [-0.04, -0.08, 0], [-0.12, -0.55, -0.02], 0.04, HAIR_SHADE, HAIR, 0.7);
        lock(mb, [0, -0.2, -0.02], [0.03, -0.7, -0.05], 0.035, HAIR, HAIR, 0.7);
    }
}

/** 背后垂下的后摆（原点在上沿中间，沿 -Y 垂下）：红色长布 + 金边 + 中间一道白 */
function buildCape(mb: MeshBuilder) {
    const L = 0.7;
    // 分三段，下面略微往后弯
    const ys = [0, -0.25, -0.5, -L], ws = [0.11, 0.15, 0.19, 0.22], zs = [0, -0.01, -0.035, -0.08];
    for (let i = 0; i < 3; i++) {
        sheet(mb, [-ws[i], ys[i], zs[i]], [ws[i], ys[i], zs[i]], [ws[i + 1], ys[i + 1], zs[i + 1]],
            [-ws[i + 1], ys[i + 1], zs[i + 1]], RED, 0, 0, 1);
        const k = 0.3;
        sheet(mb, [-ws[i] * k, ys[i] - 0.01, zs[i] - 0.006], [ws[i] * k, ys[i] - 0.01, zs[i] - 0.006],
            [ws[i + 1] * k, ys[i + 1], zs[i + 1] - 0.006], [-ws[i + 1] * k, ys[i + 1], zs[i + 1] - 0.006], WHITE, 0, 0, 1);
    }
    mb.box(0, -L - 0.03, zs[3], 0.46, 0.035, 0.02, GOLD);
}

/** 长弓（原点在弓把，竖着，弓背朝 +Z，两个弓梢往后弯）：深色弓身 + 金色缠线和纹饰 + 弓把 */
function buildBow(mb: MeshBuilder) {
    const curve = [[0, 0, 0.03], [0.15, -0.008, 0.029], [0.3, -0.03, 0.027], [0.45, -0.068, 0.024],
    [0.6, -0.12, 0.02], [0.7, -0.175, 0.016], [TIP_Y, TIP_Z, 0.012]];
    for (const s of [1, -1]) {
        for (let i = 0; i < curve.length - 1; i++) {
            const a = curve[i], b = curve[i + 1];
            tube(mb, 0, s * a[0], a[1], 0, s * b[0], b[1], a[2], b[2], WOOD, 6, i === 0, true);
        }
        // 弓梢往前翘的小尖、缠线、金属箍
        tube(mb, 0, s * TIP_Y, TIP_Z, 0, s * (TIP_Y + 0.07), TIP_Z + 0.05, 0.014, 0, GOLD, 4);
        tube(mb, 0, s * 0.27, -0.025, 0, s * 0.33, -0.036, 0.032, 0.031, GOLD, 6, false, false);
        tube(mb, 0, s * 0.57, -0.108, 0, s * 0.63, -0.136, 0.025, 0.022, STEEL, 6, false, false);
        for (const y of [0.14, 0.2, 0.42, 0.5]) mb.box(0, s * y - 0.008, -0.004 - y * y * 0.32 + 0.028, 0.02, 0.016, 0.012, GOLD);
    }
    tube(mb, 0, -0.09, 0, 0, 0.09, 0, 0.04, 0.04, BLACK, 8);
    tube(mb, 0, 0.09, 0, 0, 0.105, 0, 0.043, 0.043, RED, 8, false, false);
    tube(mb, 0, -0.105, 0, 0, -0.09, 0, 0.043, 0.043, RED, 8, false, false);
}

// ---------------- 骨骼和动作 ----------------

/** 一根“骨头”：网格从原点沿 -Y 伸出，用 aim 让它指向目标点 */
class Bone {
    readonly node: Laya.MeshSprite3D;
    private q = new Laya.Quaternion();
    private s = new Laya.Vector3(1, 1, 1);
    private p = new Laya.Vector3();

    constructor(pm: PartMesh, parent: Laya.Sprite3D, private ox: number, private oy: number, private oz: number,
        /** 网格原本的长度；指向目标时按距离拉伸 */
        private restLen: number, private minScale: number, private maxScale: number) {
        this.node = addPart(pm, parent, ox, oy, oz);
    }

    /** 把骨头的根部挪到新位置（父节点坐标系） */
    moveTo(x: number, y: number, z: number) {
        this.ox = x; this.oy = y; this.oz = z;
        this.p.setValue(x, y, z);
        this.node.transform.localPosition = this.p;
    }

    /** 指向目标点（父节点坐标系），并按距离拉伸 */
    aim(tx: number, ty: number, tz: number) {
        let dx = tx - this.ox, dy = ty - this.oy, dz = tz - this.oz;
        const len = Math.hypot(dx, dy, dz) || 1;
        dx /= len; dy /= len; dz /= len;
        // 把 (0,-1,0) 转到 (dx,dy,dz) 的最短旋转：轴 = (0,-1,0) × d，w = 1 + (0,-1,0)·d
        const w = 1 - dy;
        if (w < 1e-5) this.q.setValue(1, 0, 0, 0);   // 正上方：绕 X 轴转 180°
        else {
            const n = Math.hypot(dz, dx, w);
            this.q.setValue(-dz / n, 0, dx / n, w / n);
        }
        this.node.transform.localRotation = this.q;
        this.s.y = Math.min(this.maxScale, Math.max(this.minScale, len / this.restLen));
        this.node.transform.localScale = this.s;
    }
}

/**
 * 一条手臂：上臂 + 小臂两根骨头，手肘可以弯。
 * reach 给出手要到的位置，自动算出手肘的位置（两段骨头的反向运动学）：
 * 手离肩膀越近手肘弯得越厉害，手肘朝身体的后外侧顶出去
 */
class Arm {
    private upper: Bone;
    private fore: Bone;

    /** (sx, sy) = 肩膀的位置；side = 1 / -1，身体的哪一侧（手肘往这一侧顶） */
    constructor(upper: PartMesh, fore: PartMesh, parent: Laya.Sprite3D, private sx: number, private sy: number,
        private side: number) {
        this.upper = new Bone(upper, parent, sx, sy, 0, ARM / 2, 1, 1);
        this.fore = new Bone(fore, parent, sx, sy - ARM / 2, 0, ARM / 2, 1, 1);
    }

    /** 让手伸到 (tx, ty, tz)（身体坐标系）；够不着时手臂伸直指向它 */
    reach(tx: number, ty: number, tz: number) {
        const L = ARM / 2;
        let dx = tx - this.sx, dy = ty - this.sy, dz = tz;
        const d = Math.hypot(dx, dy, dz) || 1e-6;
        dx /= d; dy /= d; dz /= d;
        const r = Math.min(d, 2 * L - 0.004);
        // 手肘顶出去的方向：后、外、略朝下，去掉沿手臂方向的分量
        let px = this.side * 0.6, py = -0.3, pz = -0.75;
        const dot = px * dx + py * dy + pz * dz;
        px -= dx * dot; py -= dy * dot; pz -= dz * dot;
        const pl = Math.hypot(px, py, pz) || 1;
        const h = Math.sqrt(Math.max(0, L * L - r * r / 4));
        const ex = this.sx + dx * r / 2 + px / pl * h, ey = this.sy + dy * r / 2 + py / pl * h, ez = dz * r / 2 + pz / pl * h;
        this.upper.aim(ex, ey, ez);
        this.fore.moveTo(ex, ey, ez);
        this.fore.aim(this.sx + dx * r, this.sy + dy * r, dz * r);
    }
}

function smooth(t: number): number {
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return t * t * (3 - 2 * t);
}

/**
 * 先绕 Z 轴转 side、再绕 X 轴转 back 的旋转。
 * 对一个沿 -Y 垂下的东西：back > 0 是往身后（-Z）飘，side 是左右晃
 */
function setSwing(q: Laya.Quaternion, back: number, side: number) {
    const sx = Math.sin(back / 2), cx = Math.cos(back / 2), sz = Math.sin(side / 2), cz = Math.cos(side / 2);
    q.setValue(sx * cz, -sx * sz, cx * sz, cx * cz);
}

export class ArcherModel {
    readonly root = new Laya.Sprite3D("Player");
    private body = new Laya.Sprite3D("Body");
    private legL: Laya.MeshSprite3D;
    private legR: Laya.MeshSprite3D;
    private shinL: Laya.MeshSprite3D;
    private shinR: Laya.MeshSprite3D;
    private armBow: Arm;
    private armDraw: Arm;
    private tail1: Laya.MeshSprite3D;
    private tail2: Laya.MeshSprite3D;
    private cape: Laya.MeshSprite3D;
    private bow: Laya.MeshSprite3D;
    private strTop: Bone;
    private strBot: Bone;
    private nocked: Laya.MeshSprite3D;

    private walkPhase = 0;
    private walkAmp = 0;
    private time = 0;
    /** 头发/后摆往后飘的程度，比走路的起停慢半拍 */
    private flow = 0;
    private qA = new Laya.Quaternion();
    private qB = new Laya.Quaternion();
    private qKneeL = new Laya.Quaternion();
    private qKneeR = new Laya.Quaternion();
    private qBow = new Laya.Quaternion();
    private qTail1 = new Laya.Quaternion();
    private qTail2 = new Laya.Quaternion();
    private qCape = new Laya.Quaternion();
    private vBody = new Laya.Vector3(0, HIP, 0);
    private vBow = new Laya.Vector3();
    private vNock = new Laya.Vector3();

    constructor() {
        // 腿：大腿接在胯上，小腿接在大腿的膝盖处
        this.legL = addPart(build(mb => buildThigh(mb, true)), this.root, 0.085, HIP, 0);
        this.legR = addPart(build(mb => buildThigh(mb, false)), this.root, -0.085, HIP, 0);
        const shin = build(buildShin);
        this.shinL = addPart(shin, this.legL, 0, -KNEE, 0);
        this.shinR = addPart(shin, this.legR, 0, -KNEE, 0);

        this.body.transform.localPosition = this.vBody;
        this.root.addChild(this.body);

        this.cape = addPart(build(buildCape, 0), this.body, 0, 0.1, -0.17);
        addPart(build(buildTorso), this.body, 0, 0, 0);

        // 头按写实比例缩小（约七头身）；描边粗细除以缩放，缩小后和身体的一样粗
        const head = addPart(build(buildHead, OUTLINE / HEAD), this.body, 0, NECK, 0);
        head.transform.localScale = new Laya.Vector3(HEAD, HEAD, HEAD);

        // 马尾：两节，第二节接在第一节末端
        this.tail1 = addPart(build(mb => buildTail(mb, false), OUTLINE / TAIL), this.body, 0, NECK + 0.41 * HEAD, -0.13 * HEAD);
        this.tail1.transform.localScale = new Laya.Vector3(TAIL, TAIL, TAIL);
        this.tail2 = addPart(build(mb => buildTail(mb, true), OUTLINE / TAIL), this.tail1, 0, -TAIL_SEG, 0);

        this.armBow = new Arm(build(mb => buildUpperArm(mb, true)), build(mb => buildForearm(mb, true)),
            this.body, SHOULDER_X, SHOULDER_Y, 1);
        this.armDraw = new Arm(build(mb => buildUpperArm(mb, false)), build(mb => buildForearm(mb, false)),
            this.body, -SHOULDER_X, SHOULDER_Y, -1);

        this.bow = addPart(build(buildBow, 0), this.body, 0, 0, 0);

        // 弓弦：上下两段，各自从弓梢指向搭箭点，拉弓时一起往后折
        const str = build(mb => tube(mb, 0, 0, 0, 0, -1, 0, 0.008, 0.008, STRING, 3), 0);
        this.strTop = new Bone(str, this.bow, 0, TIP_Y, TIP_Z, 1, 0.1, 10);
        this.strBot = new Bone(str, this.bow, 0, -TIP_Y, TIP_Z, 1, 0.1, 10);

        // 搭在弦上的箭，只在拉弓时显示
        this.nocked = addPart({ mesh: arrowMesh(), hull: null }, this.bow, 0, 0, 0);
        this.nocked.active = false;

        this.pose(0, false, 0, 0, false);
    }

    /**
     * 每帧更新动作。
     * moving = 这一帧有没有在走；aim = 举弓程度 0~1；draw = 弓弦往后拉的距离（0 ~ DRAW_MAX）；
     * showArrow = 弦上有没有箭
     */
    pose(dt: number, moving: boolean, aim: number, draw: number, showArrow: boolean) {
        this.time += dt;
        this.walkAmp += ((moving ? 1 : 0) - this.walkAmp) * Math.min(1, dt * 12);
        this.flow += ((moving ? 1 : 0) - this.flow) * Math.min(1, dt * 5);
        if (moving) this.walkPhase += dt * 11;
        const swing = Math.sin(this.walkPhase) * this.walkAmp;

        // 腿：大腿绕胯前后摆，两条腿相反；往前迈的那条腿膝盖弯起来（小腿往后收），落地时伸直
        const stride = Math.cos(this.walkPhase) * this.walkAmp;
        setSwing(this.qA, swing * 0.55 - Math.max(0, -stride) * 0.25, 0);
        setSwing(this.qB, -swing * 0.55 - Math.max(0, stride) * 0.25, 0);
        this.legL.transform.localRotation = this.qA;
        this.legR.transform.localRotation = this.qB;
        setSwing(this.qKneeL, 0.04 + Math.max(0, -stride) * 1.1, 0);
        setSwing(this.qKneeR, 0.04 + Math.max(0, stride) * 1.1, 0);
        this.shinL.transform.localRotation = this.qKneeL;
        this.shinR.transform.localRotation = this.qKneeR;

        // 身体：走路时一步一颠，站着时轻微呼吸起伏
        this.vBody.y = HIP + Math.abs(Math.cos(this.walkPhase)) * 0.04 * this.walkAmp
            + Math.sin(this.time * 2.2) * 0.01 * (1 - this.walkAmp);
        this.body.transform.localPosition = this.vBody;

        // 马尾：站着时垂在背后轻轻晃，跑起来往后飘并随步子起伏；第二节比第一节更飘
        const f = this.flow, bounce = Math.sin(this.walkPhase * 2) * this.walkAmp;
        const sway = Math.sin(this.time * 1.7) * (0.07 + 0.05 * f);
        setSwing(this.qTail1, 0.32 + 0.75 * f + bounce * 0.08, sway);
        setSwing(this.qTail2, -0.14 + 0.3 * f + Math.sin(this.walkPhase * 2 - 1.2) * this.walkAmp * 0.16,
            Math.sin(this.time * 1.7 - 0.9) * (0.1 + 0.08 * f));
        this.tail1.transform.localRotation = this.qTail1;
        this.tail2.transform.localRotation = this.qTail2;

        // 后摆
        setSwing(this.qCape, 0.18 + 0.6 * f + bounce * 0.1, Math.sin(this.time * 1.3) * 0.04);
        this.cape.transform.localRotation = this.qCape;

        const k = smooth(aim);
        // 持弓手：平时垂在身侧略微靠前（手肘微弯），瞄准时把弓举到身前、手臂伸直
        const ba = 0.3 + swing * 0.2;
        const bx = SHOULDER_X + 0.07 + (BOW_AIM[0] - SHOULDER_X - 0.07) * k;
        const by = SHOULDER_Y - REACH * Math.cos(ba) + (BOW_AIM[1] - SHOULDER_Y + REACH * Math.cos(ba)) * k;
        const bz = REACH * Math.sin(ba) + (BOW_AIM[2] - REACH * Math.sin(ba)) * k;
        this.armBow.reach(bx, by, bz);

        // 弓跟着持弓手：平时斜着拎在手里（下弓梢朝后，不会戳到地），瞄准时竖直
        this.vBow.setValue(bx, by, bz);
        this.bow.transform.localPosition = this.vBow;
        setSwing(this.qBow, (1 - k) * 0.7, 0);
        this.bow.transform.localRotation = this.qBow;

        // 弓弦和弦上的箭（弓自己的坐标系）
        const nockZ = TIP_Z - draw;
        this.strTop.aim(0, 0, nockZ);
        this.strBot.aim(0, 0, nockZ);
        this.nocked.active = showArrow;
        if (showArrow) {
            this.vNock.setValue(0, 0, nockZ + ARROW_LEN / 2);
            this.nocked.transform.localPosition = this.vNock;
        }

        // 拉弦手：平时前后摆臂（往前摆时手肘弯得多一些），瞄准时去够搭箭点并跟着弦往后拉，手肘往后外侧顶出去
        const da = -swing * 0.6, dr = REACH - 0.07 * Math.max(0, da);
        const rx = -SHOULDER_X - 0.04, ry = SHOULDER_Y - dr * Math.cos(da), rz = dr * Math.sin(da);
        this.armDraw.reach(rx + (BOW_AIM[0] - rx) * k, ry + (BOW_AIM[1] - ry) * k, rz + (BOW_AIM[2] + nockZ - rz) * k);
    }

    /** 箭离弦的位置（模型自己的坐标系：x 向左右、y 向上、z 向前） */
    static readonly MUZZLE = [BOW_AIM[0], HIP + BOW_AIM[1], BOW_AIM[2] + 0.3];
}
