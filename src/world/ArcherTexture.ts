import { RGB } from "./MeshBuilder";

/**
 * 弓手的贴图（运行时逐像素画出来，不依赖图片资源）。一张 1024×1024 的图集，里面有几块：
 * - 脸：皮肤底色 + 眼睛（睫毛、眼白、渐变的虹膜、瞳孔、高光）、眉毛、腮红、鼻子、嘴
 * - 和服布料：红底、暗纹、金色和白色的小花
 * - 头发：一根根发丝的明暗 + 一圈高光（只存明暗，颜色由顶点色决定）
 * - 衬裙：白底灰色竖条纹
 * 图集其余部分是纯白：没有贴图的部件 UV 都是 (0,0)，采到白色，最终颜色 = 顶点色。
 *
 * 贴图坐标：像素 (x, y) 对应 UV (x / SIZE, y / SIZE)。
 */
const SIZE = 1024;

/** 和 Archer.ts 共用的颜色（脸的底色要和脖子、手臂的顶点色一致） */
export const SKIN: RGB = [1, 0.88, 0.8];
export const SKIN_SHADE: RGB = [0.97, 0.8, 0.72];
export const RED: RGB = [0.87, 0.13, 0.16];
export const RED_DARK: RGB = [0.6, 0.07, 0.11];
export const GOLD: RGB = [0.97, 0.78, 0.25];

const BLUSH: RGB = [1, 0.62, 0.62];
const EYE: RGB = [0.72, 0.1, 0.17];
const EYE_LIGHT: RGB = [1, 0.5, 0.45];
const PUPIL: RGB = [0.22, 0.02, 0.07];
const LASH: RGB = [0.14, 0.08, 0.1];
const LIP: RGB = [0.9, 0.4, 0.45];
const LIP_LINE: RGB = [0.7, 0.24, 0.3];
const CREASE: RGB = [0.84, 0.6, 0.55];
const BROW: RGB = [0.6, 0.61, 0.74];
const PURE: RGB = [1, 1, 1];

/** 图集里的一块：[u0, v0, u1, v1] */
export type Rect = [number, number, number, number];

// 各块在图集里的位置（像素）：x, y, 宽, 高
const FACE = [20, 20, 614, 512];
const KIMONO = [660, 20, 340, 340];
const HAIRT = [660, 380, 340, 320];
const STRIPE = [20, 560, 300, 300];

function rectOf(t: number[]): Rect {
    return [t[0] / SIZE, t[1] / SIZE, (t[0] + t[2]) / SIZE, (t[1] + t[3]) / SIZE];
}

/** 脸：横向 = 绕头一圈（正脸在中间，见 faceU），纵向 = 头顶到下巴 */
export const T_FACE = rectOf(FACE);
export const T_KIMONO = rectOf(KIMONO);
export const T_HAIR = rectOf(HAIRT);
export const T_STRIPE = rectOf(STRIPE);

/**
 * 脸的横向贴图坐标：s = 绕头一圈的比例（0 和 1 在后脑，0.5 是正脸）。
 * 正面半圈（0.25 ~ 0.75）占贴图宽度的 80%，后脑被头发盖住、只占两边各 10%，五官的像素更多
 */
export function faceU(s: number): number {
    if (s < 0.25) return s * 0.4;
    if (s > 0.75) return 0.9 + (s - 0.75) * 0.4;
    return 0.1 + (s - 0.25) * 1.6;
}

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

function mix(a: RGB, b: RGB, t: number): RGB {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** 椭圆的覆盖度（边缘 soft 像素宽的过渡，抗锯齿） */
function ell(x: number, y: number, cx: number, cy: number, rx: number, ry: number, soft = 1.2): number {
    const d = (Math.hypot((x - cx) / rx, (y - cy) / ry) - 1) * Math.min(rx, ry);
    return clamp01(0.5 - d / soft);
}

/** 粗线段（两头圆）的覆盖度 */
function seg(x: number, y: number, ax: number, ay: number, bx: number, by: number, r: number, soft = 1.2): number {
    const dx = bx - ax, dy = by - ay;
    const t = clamp01(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1));
    const d = Math.hypot(x - ax - dx * t, y - ay - dy * t) - r;
    return clamp01(0.5 - d / soft);
}

class Painter {
    readonly buf = new Float32Array(SIZE * SIZE * 3).fill(1);

    /** 在矩形范围内逐像素上色：cov 返回 0~1 的覆盖度，col 是颜色或按位置取颜色的函数 */
    paint(x0: number, y0: number, x1: number, y1: number, col: RGB | ((x: number, y: number) => RGB),
        cov: (x: number, y: number) => number) {
        x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
        x1 = Math.min(SIZE - 1, Math.ceil(x1)); y1 = Math.min(SIZE - 1, Math.ceil(y1));
        const b = this.buf;
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                const a = cov(x + 0.5, y + 0.5);
                if (a <= 0) continue;
                const c = typeof col === "function" ? col(x + 0.5, y + 0.5) : col;
                const i = (y * SIZE + x) * 3;
                b[i] += (c[0] - b[i]) * a; b[i + 1] += (c[1] - b[i + 1]) * a; b[i + 2] += (c[2] - b[i + 2]) * a;
            }
        }
    }

    /** 整块填色（四周多填 pad 像素，缩小后的贴图不会在块的边上混进白色） */
    fill(t: number[], pad: number, col: RGB | ((x: number, y: number) => RGB)) {
        this.paint(t[0] - pad, t[1] - pad, t[0] + t[2] + pad, t[1] + t[3] + pad, col, () => 1);
    }

    toTexture(): Laya.Texture2D {
        const px = new Uint8Array(SIZE * SIZE * 4), b = this.buf;
        for (let p = 0; p < SIZE * SIZE; p++) {
            px[p * 4] = Math.round(clamp01(b[p * 3]) * 255);
            px[p * 4 + 1] = Math.round(clamp01(b[p * 3 + 1]) * 255);
            px[p * 4 + 2] = Math.round(clamp01(b[p * 3 + 2]) * 255);
            px[p * 4 + 3] = 255;
        }
        const tex = new Laya.Texture2D(SIZE, SIZE, Laya.TextureFormat.R8G8B8A8, true, false, false);
        tex.setPixelsData(px, false, false);
        tex.wrapModeU = Laya.WrapMode.Repeat;
        tex.wrapModeV = Laya.WrapMode.Repeat;
        tex.filterMode = Laya.FilterMode.Trilinear;
        tex.anisoLevel = 4;
        tex.lock = true;
        return tex;
    }
}

/**
 * 脸。头的网格高 0.37 米（下巴 0.02 ~ 头顶 0.39），眼睛高度处一圈约 1.04 米。
 * 换算：正面横向约 945 像素/米，纵向约 1384 像素/米
 */
function paintFace(p: Painter) {
    const [fx, fy, fw, fh] = FACE;
    const cx = fx + fw / 2;
    const yOf = (headY: number) => fy + ((0.39 - headY) / 0.37) * fh;

    // 皮肤：下巴往下略深一点
    p.fill(FACE, 8, (_x, y) => mix(SKIN, SKIN_SHADE, clamp01((y - yOf(0.1)) / (fh * 0.2)) * 0.5));

    // 腮红
    const by = yOf(0.118);
    for (const s of [1, -1]) {
        const bx = cx + s * 131;
        p.paint(bx - 60, by - 32, bx + 60, by + 32, BLUSH,
            (x, y) => clamp01(1 - Math.hypot((x - bx) / 56, (y - by) / 28)) * 0.6);
    }

    const ey = yOf(0.187);
    for (const s of [1, -1]) {
        const ex = cx + s * 72;
        const white = (x: number, y: number) => ell(x, y, ex, ey, 29, 26);
        // 上睫毛：一条盖在眼睛上沿的粗弧，外眼角往上挑
        p.paint(ex - 40, ey - 40, ex + 40, ey + 12, LASH,
            (x, y) => ell(x, y, ex, ey - 5, 34, 31) * clamp01((ey + 4 - y) / 6));
        p.paint(ex - 48, ey - 26, ex + 48, ey, LASH, (x, y) => seg(x, y, ex + s * 29, ey - 9, ex + s * 41, ey - 19, 2.6));
        // 眼白：上面被睫毛挡着，偏暗
        p.paint(ex - 32, ey - 30, ex + 32, ey + 30,
            (_x, y) => mix([0.8, 0.78, 0.86], PURE, clamp01((y - (ey - 22)) / 20)), white);
        // 虹膜：上深下浅的渐变，不超出眼白
        p.paint(ex - 20, ey - 28, ex + 20, ey + 30, (_x, y) => {
            const t = clamp01((y - (ey - 22)) / 46);
            return t < 0.5 ? mix(PUPIL, EYE, t * 2) : mix(EYE, EYE_LIGHT, (t - 0.5) * 2);
        }, (x, y) => ell(x, y, ex, ey + 1, 17, 25) * white(x, y));
        p.paint(ex - 10, ey - 12, ex + 10, ey + 16, PUPIL, (x, y) => ell(x, y, ex, ey + 2, 7, 11) * white(x, y));
        // 虹膜下半的亮弧、两点高光（光从同一侧来，两只眼睛的高光在同一边）
        p.paint(ex - 14, ey + 10, ex + 14, ey + 26, EYE_LIGHT,
            (x, y) => ell(x, y, ex, ey + 18, 10, 5, 3) * white(x, y) * 0.8);
        p.paint(ex - 18, ey - 20, ex + 2, ey, PURE, (x, y) => ell(x, y, ex - 8, ey - 10, 6, 7));
        p.paint(ex + 2, ey + 5, ex + 12, ey + 15, PURE, (x, y) => ell(x, y, ex + 7, ey + 10, 3, 3));
        // 双眼皮、下眼线
        p.paint(ex - 30, ey - 46, ex + 30, ey - 30, CREASE, (x, y) =>
            Math.max(seg(x, y, ex - 24, ey - 35, ex, ey - 40, 1.2), seg(x, y, ex, ey - 40, ex + 24, ey - 35, 1.2)));
        p.paint(ex - 24, ey + 23, ex + 24, ey + 31, CREASE, (x, y) => seg(x, y, ex - 18, ey + 27, ex + 18, ey + 27, 1) * 0.8);
        // 眉毛：细长，外端略低
        p.paint(ex - 34, ey - 78, ex + 34, ey - 56, BROW,
            (x, y) => seg(x, y, ex - s * 24, ey - 68, ex + s * 26, ey - 63, 2.6));
    }

    // 鼻子：一小道阴影
    const ny = yOf(0.128);
    p.paint(cx - 6, ny - 6, cx + 6, ny + 8, [0.9, 0.66, 0.6], (x, y) => seg(x, y, cx - 2, ny - 2, cx + 1, ny + 4, 1.5) * 0.85);
    // 嘴：上唇线 + 下唇
    const my = yOf(0.086);
    p.paint(cx - 20, my + 1, cx + 20, my + 16, LIP, (x, y) => ell(x, y, cx, my + 8, 14, 5.5, 2.5) * 0.8);
    p.paint(cx - 28, my - 5, cx + 28, my + 8, LIP_LINE, (x, y) =>
        Math.max(seg(x, y, cx - 22, my - 1, cx, my + 2, 1.7), seg(x, y, cx, my + 2, cx + 22, my - 1, 1.7)));
    p.paint(cx - 8, my + 5, cx + 8, my + 11, PURE, (x, y) => ell(x, y, cx + 3, my + 8, 4, 1.6, 2) * 0.5);
}

/** 和服布料：红底 + 竖向的明暗（布的垂感）+ 金色和白色的五瓣小花。左右两边留空，绕一圈接缝处没有图案 */
function paintKimono(p: Painter) {
    const [kx, ky, kw, kh] = KIMONO;
    p.fill(KIMONO, 8, (x, y) => {
        const u = (x - kx) / kw, v = (y - ky) / kh;
        const fold = 0.93 + 0.07 * Math.sin(u * Math.PI * 2 * 5 + Math.sin(v * 5) * 0.8);
        return [RED[0] * fold, RED[1] * fold, RED[2] * fold];
    });
    // [u, v, 大小, 0 = 金色 / 1 = 白色]
    const flowers = [[0.2, 0.16, 15, 0], [0.62, 0.3, 12, 1], [0.38, 0.52, 16, 0], [0.8, 0.62, 13, 0],
    [0.16, 0.76, 12, 1], [0.56, 0.86, 15, 0], [0.84, 0.12, 10, 1], [0.34, 0.9, 9, 1]];
    for (const [u, v, r, kind] of flowers) {
        const fx = kx + u * kw, fy = ky + v * kh, col: RGB = kind ? [1, 0.93, 0.9] : GOLD;
        for (let i = 0; i < 5; i++) {
            const a = (i / 5) * Math.PI * 2 - Math.PI / 2 + u * 3;
            const px = fx + Math.cos(a) * r * 0.62, py = fy + Math.sin(a) * r * 0.62;
            p.paint(px - r, py - r, px + r, py + r, col, (x, y) => ell(x, y, px, py, r * 0.48, r * 0.48));
        }
        p.paint(fx - r, fy - r, fx + r, fy + r, kind ? GOLD : RED_DARK, (x, y) => ell(x, y, fx, fy, r * 0.26, r * 0.26));
    }
    // 几道金色的波浪线
    for (const v0 of [0.42, 0.7]) {
        p.paint(kx + kw * 0.08, ky + kh * (v0 - 0.05), kx + kw * 0.92, ky + kh * (v0 + 0.05), GOLD, (x, y) => {
            const u = (x - kx) / kw;
            const edge = clamp01((u - 0.08) / 0.06) * clamp01((0.92 - u) / 0.06);
            const yy = ky + kh * v0 + Math.sin(u * Math.PI * 2 * 3) * kh * 0.022;
            return clamp01(1.4 - Math.abs(y - yy)) * edge * 0.75;
        });
    }
}

/** 头发：只有明暗（乘上顶点色）。一根根竖向的发丝 + 上部一圈高光；横向是周期的，绕一圈没有接缝 */
function paintHair(p: Painter) {
    const [hx, hy, hw, hh] = HAIRT;
    p.fill(HAIRT, 8, (x, y) => {
        const u = (x - hx) / hw, v = (y - hy) / hh, w = u * Math.PI * 2;
        const strand = 0.5 + 0.5 * Math.sin(w * 17 + 2 * Math.sin(w * 5));
        const fine = 0.5 + 0.5 * Math.sin(w * 53 + Math.sin(w * 7) * 3);
        let val = 0.8 + 0.13 * strand + 0.05 * fine;
        // 高光带：被发丝打断成一段段的
        const band = (v - 0.3 - 0.02 * Math.sin(w * 9)) / 0.06;
        val += 0.16 * Math.exp(-band * band) * (0.45 + 0.55 * strand);
        // 往发梢略深
        val *= 1 - 0.1 * clamp01((v - 0.5) * 2);
        val = clamp01(val);
        // 暗处偏蓝紫
        return [val * (0.9 + 0.1 * val), val * (0.92 + 0.08 * val), val];
    });
}

/** 衬裙：白底，宽窄不一的灰色竖条纹 */
function paintStripe(p: Painter) {
    const [sx, , sw] = STRIPE;
    p.fill(STRIPE, 8, (x) => {
        const w = ((x - sx) / sw) * Math.PI * 2;
        const s = clamp01((Math.sin(w * 8) + 0.35 * Math.sin(w * 16 + 1) - 0.25) * 4);
        return mix(PURE, [0.72, 0.72, 0.79], s);
    });
}

let atlas: Laya.Texture2D | null = null;
/** 弓手的贴图图集（只生成一次） */
export function archerAtlas(): Laya.Texture2D {
    if (!atlas) {
        const p = new Painter();
        paintFace(p);
        paintKimono(p);
        paintHair(p);
        paintStripe(p);
        atlas = p.toTexture();
    }
    return atlas;
}
