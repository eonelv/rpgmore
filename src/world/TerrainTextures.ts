import { hash2 } from "./Noise";
import { SEED } from "./WorldConfig";

/**
 * 程序化生成的地表贴图（运行时生成，不依赖图片资源）。
 *
 * 贴图只存“细节”：接近白色的明暗/色相变化，最终颜色 = 贴图 × 顶点色。
 * 这样草地、桥面的整体颜色仍由 COLORS 决定，和小地图、山体草地保持一致。
 * 所有贴图的平均亮度被归一化到 TEX_MEAN，顶点色乘上 TEX_GAIN 补偿回来。
 * 贴图是无缝的（周期噪声 + 坐标取模），用世界坐标做 UV，Repeat 平铺。
 */
export const TEX_MEAN = 0.85;
export const TEX_GAIN = 1 / TEX_MEAN;
/** 一张草地 / 沙地贴图覆盖的边长（米），必须能整除块边长，块之间才没有接缝 */
export const GRASS_TILE = 8;
export const SAND_TILE = 8;

const SIZE = 256;

/** 周期值噪声：在 period 格后重复 */
function pnoise(x: number, y: number, px: number, py: number, seed: number): number {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    let fx = x - x0, fy = y - y0;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    const wx = (i: number) => ((i % px) + px) % px, wy = (j: number) => ((j % py) + py) % py;
    const a = hash2(wx(x0), wy(y0), seed), b = hash2(wx(x0 + 1), wy(y0), seed);
    const c = hash2(wx(x0), wy(y0 + 1), seed), d = hash2(wx(x0 + 1), wy(y0 + 1), seed);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** 周期分形噪声，(u,v) 为 [0,1) 的贴图坐标，cx/cy 为第一层的格子数 */
function pfbm(u: number, v: number, cx: number, cy: number, octaves: number, seed: number): number {
    let sum = 0, amp = 0.5, norm = 0;
    for (let i = 0; i < octaves; i++) {
        sum += amp * pnoise(u * cx, v * cy, cx, cy, seed + i * 131);
        norm += amp; amp *= 0.5; cx *= 2; cy *= 2;
    }
    return sum / norm;
}

/** 把浮点 RGB 缓冲区按平均亮度归一化到 TEX_MEAN，转成 RGBA8；alpha 为 [0,1]，不传则全不透明 */
function toRGBA(buf: Float32Array, alpha?: Float32Array): Uint8Array {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i];
    const k = TEX_MEAN / (sum / buf.length);
    const out = new Uint8Array(SIZE * SIZE * 4);
    for (let p = 0; p < SIZE * SIZE; p++) {
        for (let c = 0; c < 3; c++) out[p * 4 + c] = Math.max(0, Math.min(255, Math.round(buf[p * 3 + c] * k * 255)));
        out[p * 4 + 3] = alpha ? Math.round(alpha[p] * 255) : 255;
    }
    return out;
}

/**
 * 草地边缘的裁切值（写在草地贴图的 alpha 里）。
 * 材质用 alpha 测试（阈值 0.5），地面顶点 alpha = 0.5 + 0.5 × 草地权重（见 ChunkRenderer），
 * 像素保留的条件是 顶点alpha × 贴图alpha ≥ 0.5：
 * - 草地内部（权重 1）：贴图 alpha ≥ 0.5 恒成立，完全不透
 * - 草地与道路交界：贴图 alpha 高的地方保留，其余被裁掉露出下面的路面，形成成块、圆滑的参差边缘
 * 先做直方图均衡，让 alpha 均匀分布在 [0.5, 0.98]，过渡带宽度才和权重成正比。
 */
function grassEdgeAlpha(): Float32Array {
    return edgeAlpha(SEED + 1500);
}

/** 参差边缘的裁切值：均衡到 [0.55, 0.85]，与 ChunkRenderer 里顶点 alpha 的映射配套 */
function edgeAlpha(seed: number): Float32Array {
    const n = new Float32Array(SIZE * SIZE);
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            // 降低频率（3×3 → ~2.7m特征）、减少层数（2层），特征足够大不会在过渡带里切出孤立碎块
            n[y * SIZE + x] = pfbm(x / SIZE, y / SIZE, 3, 3, 2, seed);
        }
    }
    // 加大模糊半径合并残余碎块；缩小 alpha 范围[0.55,0.85]收窄过渡带宽度
    return equalizeAlpha(blurWrap(n, 6), 0.55, 0.85);
}

/** 无缝的盒式模糊（横竖各一遍，坐标取模），去掉阈值切割后残留的小碎块 */
function blurWrap(src: Float32Array, r: number): Float32Array {
    const tmp = new Float32Array(SIZE * SIZE), out = new Float32Array(SIZE * SIZE);
    const w = 1 / (2 * r + 1);
    const wrap = (i: number) => ((i % SIZE) + SIZE) % SIZE;
    for (let y = 0; y < SIZE; y++)
        for (let x = 0; x < SIZE; x++) {
            let s = 0;
            for (let k = -r; k <= r; k++) s += src[y * SIZE + wrap(x + k)];
            tmp[y * SIZE + x] = s * w;
        }
    for (let y = 0; y < SIZE; y++)
        for (let x = 0; x < SIZE; x++) {
            let s = 0;
            for (let k = -r; k <= r; k++) s += tmp[wrap(y + k) * SIZE + x];
            out[y * SIZE + x] = s * w;
        }
    return out;
}

/** 直方图均衡：把任意分布的值按排名映射到 [lo, hi] */
function equalizeAlpha(n: Float32Array, lo = 0.5, hi = 0.98): Float32Array {
    const order = new Uint32Array(SIZE * SIZE);
    for (let i = 0; i < order.length; i++) order[i] = i;
    order.sort((a, b) => n[a] - n[b]);
    const out = new Float32Array(SIZE * SIZE);
    for (let r = 0; r < order.length; r++) out[order[r]] = lo + (hi - lo) * (r / (order.length - 1));
    return out;
}

function makeTexture(pixels: Uint8Array): Laya.Texture2D {
    const tex = new Laya.Texture2D(SIZE, SIZE, Laya.TextureFormat.R8G8B8A8, true, false, false);
    tex.setPixelsData(pixels, false, false);
    tex.wrapModeU = Laya.WrapMode.Repeat;
    tex.wrapModeV = Laya.WrapMode.Repeat;
    tex.filterMode = Laya.FilterMode.Trilinear;
    tex.anisoLevel = 4;
    tex.lock = true;
    return tex;
}

/** 草地：大块的深浅/偏黄斑块 + 几千根短草叶笔触 */
function grassPixels(): Float32Array {
    const buf = new Float32Array(SIZE * SIZE * 3);
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            const u = x / SIZE, v = y / SIZE;
            const lum = 0.78 + 0.28 * pfbm(u, v, 6, 6, 4, SEED + 900);
            const dry = Math.max(0, pfbm(u, v, 4, 4, 3, SEED + 950) - 0.5) * 2;   // 偏黄的干草斑
            const fine = 0.94 + 0.12 * hash2(x, y, SEED + 977);
            const i = (y * SIZE + x) * 3;
            buf[i] = lum * fine * (1 + dry * 0.35);
            buf[i + 1] = lum * fine;
            buf[i + 2] = lum * fine * (1 - dry * 0.25);
        }
    }
    // 草叶：从根部到叶尖逐渐变亮的短线，坐标取模保证无缝
    const BLADES = 5000;
    for (let b = 0; b < BLADES; b++) {
        const r0 = hash2(b, 1, SEED + 1001), r1 = hash2(b, 2, SEED + 1001), r2 = hash2(b, 3, SEED + 1001);
        const r3 = hash2(b, 4, SEED + 1001), r4 = hash2(b, 5, SEED + 1001);
        const sx = r0 * SIZE, sy = r1 * SIZE;
        const ang = (r2 - 0.5) * 1.2 - Math.PI / 2;   // 大致朝同一方向，略有偏转
        const len = 4 + r3 * 7;
        const dark = r4 < 0.45;
        for (let s = 0; s <= len; s++) {
            const t = s / len;
            const px = ((Math.round(sx + Math.cos(ang) * s) % SIZE) + SIZE) % SIZE;
            const py = ((Math.round(sy + Math.sin(ang) * s) % SIZE) + SIZE) % SIZE;
            const i = (py * SIZE + px) * 3;
            const f = dark ? 0.72 + 0.15 * t : 1.04 + 0.14 * t;
            buf[i] *= f; buf[i + 1] *= f * (dark ? 1 : 1.03); buf[i + 2] *= f;
        }
    }
    return buf;
}

/** 桥面木板：u 方向是木板长度方向，一张贴图 = 一个格子，横向 6 块板 */
function plankPixels(): Float32Array {
    const buf = new Float32Array(SIZE * SIZE * 3);
    const PLANKS = 6;
    const pw = SIZE / PLANKS;
    for (let y = 0; y < SIZE; y++) {
        const p = Math.floor(y / pw);
        const inP = y - p * pw;                 // 板内纵向位置（像素）
        const tone = 0.82 + 0.2 * hash2(p, 0, SEED + 1200);
        const seam = Math.floor(hash2(p, 1, SEED + 1200) * SIZE);   // 每块板接缝的位置
        for (let x = 0; x < SIZE; x++) {
            const u = x / SIZE, v = y / SIZE;
            // 木纹：沿 u 拉长的噪声扭曲后的条纹
            const warp = pfbm(u, v, 3, 24, 3, SEED + 1300 + p);
            const grain = 0.5 + 0.5 * Math.sin((inP + warp * 14) * 1.3);
            let lum = tone * (0.86 + 0.14 * grain) * (0.95 + 0.1 * hash2(x, y, SEED + 1400));
            // 板缝（上下边）和边缘倒角
            if (inP < 3 || inP > pw - 2) lum *= 0.35;
            else if (inP < 5 || inP > pw - 4) lum *= 0.8;
            // 板与板首尾相接的缝 + 两侧的钉子
            const dx = ((x - seam) % SIZE + SIZE) % SIZE;
            if (dx < 2) lum *= 0.4;
            const nailX = dx === 6 || dx === 7 || dx === SIZE - 6 || dx === SIZE - 7;
            const nailY = Math.abs(inP - pw * 0.3) < 1.5 || Math.abs(inP - pw * 0.7) < 1.5;
            if (nailX && nailY) lum *= 0.45;
            const i = (y * SIZE + x) * 3;
            buf[i] = lum * 1.04; buf[i + 1] = lum; buf[i + 2] = lum * 0.94;
        }
    }
    return buf;
}

/** 沙地：细沙颗粒 + 被风/水推出的波纹 + 深浅斑块 + 零星的小石子 */
function sandPixels(): Float32Array {
    const buf = new Float32Array(SIZE * SIZE * 3);
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            const u = x / SIZE, v = y / SIZE;
            const patch = pfbm(u, v, 4, 4, 3, SEED + 1600);              // 大块的干/湿
            const warp = pfbm(u, v, 3, 3, 2, SEED + 1650);
            // 波纹：沿一个方向的正弦，被噪声扭曲。周期必须是整数，贴图才无缝
            const ripple = Math.sin((v * 14 + u * 4 + warp * 2.2) * Math.PI * 2);
            const ripLum = 1 + 0.05 * ripple * (0.4 + 0.6 * patch);
            const grain = 0.95 + 0.1 * hash2(x, y, SEED + 1700);
            const lum = (0.92 + 0.12 * patch) * ripLum * grain;
            const wet = Math.max(0, 0.45 - patch) * 0.5;               // 湿沙略深、略偏灰
            const i = (y * SIZE + x) * 3;
            buf[i] = lum * (1.02 - wet * 0.3);
            buf[i + 1] = lum * (1.0 - wet * 0.25);
            buf[i + 2] = lum * (0.96 - wet * 0.1);
        }
    }
    // 小石子：几百个 1~3 像素的深色/浅色圆点
    const PEBBLES = 140;
    for (let b = 0; b < PEBBLES; b++) {
        const cx = hash2(b, 1, SEED + 1800) * SIZE, cy = hash2(b, 2, SEED + 1800) * SIZE;
        const r = 0.7 + hash2(b, 3, SEED + 1800) * 1.3;
        const f = hash2(b, 4, SEED + 1800) < 0.6 ? 0.78 : 1.08;
        const R = Math.ceil(r);
        for (let j = -R; j <= R; j++) {
            for (let i = -R; i <= R; i++) {
                if (i * i + j * j > r * r) continue;
                const px = ((Math.round(cx) + i) % SIZE + SIZE) % SIZE, py = ((Math.round(cy) + j) % SIZE + SIZE) % SIZE;
                const k = (py * SIZE + px) * 3;
                // 石子偏灰：往中性色拉
                const g = (buf[k] + buf[k + 1] + buf[k + 2]) / 3;
                buf[k] = (buf[k] * 0.4 + g * 0.6) * f; buf[k + 1] = (buf[k + 1] * 0.4 + g * 0.6) * f; buf[k + 2] = (buf[k + 2] * 0.4 + g * 0.6) * f;
            }
        }
    }
    return buf;
}

/** 沙地边缘的裁切值：和草地同样的方案，用更大块、更圆滑的噪声（沙子的边缘比草地平滑） */
function sandEdgeAlpha(): Float32Array {
    const n = new Float32Array(SIZE * SIZE);
    for (let y = 0; y < SIZE; y++)
        for (let x = 0; x < SIZE; x++)
            // 同草地方案：降低频率（3×3）、减少层数（2层），过渡带更整洁
            n[y * SIZE + x] = pfbm(x / SIZE, y / SIZE, 3, 3, 2, SEED + 1900);
    return equalizeAlpha(blurWrap(n, 6), 0.55, 0.85);
}

/**
 * 山体岩石：天然岩面，避免规则的“铺地石板”感。
 * - 大尺度明暗斑块（风化程度不同）为主体
 * - Voronoi 只用来切出不规则的岩块“切面”：每块有自己的倾斜明暗（像不同朝向的断面），块之间是明暗突变而不是描边
 * - 少量断续、粗细不一的裂隙（脊形噪声 + 遮罩），不形成闭合网格
 * - 水平岩层、细颗粒、矿物斑点、竖向的雨水污痕、零星的地衣
 * 山坡侧面用 (水平, 高度) 做 UV，所以 v 方向的岩层在悬崖上是横向的
 */
function rockPixels(): Float32Array {
    const buf = new Float32Array(SIZE * SIZE * 3);
    const G = 3;   // 每边几块岩面（大而不规则）
    const feat = (i: number, j: number) => {
        const wi = ((i % G) + G) % G, wj = ((j % G) + G) % G;
        return [i + 0.1 + 0.8 * hash2(wi, wj, SEED + 2000), j + 0.1 + 0.8 * hash2(wi, wj, SEED + 2001),
            hash2(wi, wj, SEED + 2002), hash2(wi, wj, SEED + 2003) * Math.PI * 2];
    };
    const smooth = (a: number, b: number, t: number) => { const k = Math.max(0, Math.min(1, (t - a) / (b - a))); return k * k * (3 - 2 * k); };
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            const u = x / SIZE, v = y / SIZE;
            // 坐标强烈扭曲，岩块边界弯曲不规则
            const wu = u + (pfbm(u, v, 3, 3, 4, SEED + 2100) - 0.5) * 0.3;
            const wv = v + (pfbm(u, v, 3, 3, 4, SEED + 2150) - 0.5) * 0.3;
            const px = wu * G, py = wv * G;
            const ci = Math.floor(px), cj = Math.floor(py);
            let f1 = 9, f2 = 9, tone = 0, facet = 0;
            for (let j = -1; j <= 1; j++) {
                for (let i = -1; i <= 1; i++) {
                    const f = feat(ci + i, cj + j);
                    const dx = px - f[0], dy = py - f[1];
                    const d = Math.hypot(dx, dy);
                    if (d < f1) {
                        f2 = f1; f1 = d; tone = f[2];
                        facet = dx * Math.cos(f[3]) + dy * Math.sin(f[3]);   // 切面的倾斜明暗
                    } else if (d < f2) f2 = d;
                }
            }
            const edge = f2 - f1;
            // 大尺度风化斑块 + 中尺度起伏
            const mass = pfbm(u, v, 2, 2, 4, SEED + 2050);
            const mid = pfbm(u, v, 8, 8, 4, SEED + 2250);
            let lum = (0.72 + 0.4 * mass) * (0.9 + 0.12 * tone) * (1 + 0.1 * facet) * (0.82 + 0.3 * mid);
            // 岩块边界：只有一部分是裂开的（遮罩控制），且裂缝很窄
            const edgeMask = smooth(0.5, 0.65, pfbm(u, v, 5, 5, 2, SEED + 2500));
            lum *= 1 - 0.4 * edgeMask * (1 - smooth(0.0, 0.035, edge));
            // 细裂隙：脊形噪声，断续出现
            const ridge = 1 - Math.abs(2 * pfbm(u, v, 6, 6, 4, SEED + 2600) - 1);
            const fissMask = smooth(0.55, 0.7, pfbm(u, v, 4, 4, 2, SEED + 2650));
            lum *= 1 - 0.35 * fissMask * smooth(0.93, 0.985, ridge);
            // 岩层、雨水污痕（沿 v 方向拉长）、颗粒、矿物斑点
            const strata = 0.96 + 0.04 * Math.sin((v * 22 + pfbm(u, v, 3, 6, 2, SEED + 2200) * 3) * Math.PI * 2);
            const streak = 0.94 + 0.1 * pfbm(u, v, 24, 2, 3, SEED + 2700);
            const grain = 0.9 + 0.2 * hash2(x, y, SEED + 2300);
            const sp = hash2(x, y, SEED + 2350);
            const speck = sp > 0.985 ? 1.18 : sp < 0.02 ? 0.75 : 1;
            lum *= strata * streak * grain * speck;
            const lichen = Math.max(0, pfbm(u, v, 10, 10, 3, SEED + 2400) - 0.62) * 3;
            const i3 = (y * SIZE + x) * 3;
            buf[i3] = lum * (1 - lichen * 0.12);
            buf[i3 + 1] = lum * (1 + lichen * 0.1);
            buf[i3 + 2] = lum * (1 - lichen * 0.3);
        }
    }
    return buf;
}

/**
 * 砂石路面：夯实的土 + 大片深浅斑块 + 密集的小砾石（偏灰，左上亮右下暗，有立体感）+ 少量大一点的石子。
 * 路面不透明，草地边缘盖在它上面
 */
function gravelPixels(): Float32Array {
    const buf = new Float32Array(SIZE * SIZE * 3);
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            const u = x / SIZE, v = y / SIZE;
            const patch = pfbm(u, v, 4, 4, 3, SEED + 2500);
            const mid = pfbm(u, v, 12, 12, 2, SEED + 2550);
            const grain = 0.9 + 0.2 * hash2(x, y, SEED + 2600);
            const lum = (0.86 + 0.2 * patch) * (0.94 + 0.12 * mid) * grain;
            const i = (y * SIZE + x) * 3;
            buf[i] = lum * 1.02; buf[i + 1] = lum; buf[i + 2] = lum * 0.95;
        }
    }
    const stones = (count: number, rMin: number, rMax: number, seed: number) => {
        for (let b = 0; b < count; b++) {
            const cx = hash2(b, 1, seed) * SIZE, cy = hash2(b, 2, seed) * SIZE;
            const r = rMin + hash2(b, 3, seed) * (rMax - rMin);
            const ecc = 0.7 + hash2(b, 4, seed) * 0.6;          // 椭圆
            const tone = 0.82 + hash2(b, 5, seed) * 0.4;
            const grey = 0.5 + hash2(b, 6, seed) * 0.4;          // 往灰色拉多少
            const R = Math.ceil(r * 1.4) + 1;
            for (let j = -R; j <= R; j++) {
                for (let i = -R; i <= R; i++) {
                    const dx = i / (r * ecc), dy = j / (r / ecc);
                    const d2 = dx * dx + dy * dy;
                    const px = ((Math.round(cx) + i) % SIZE + SIZE) % SIZE, py = ((Math.round(cy) + j) % SIZE + SIZE) % SIZE;
                    const k = (py * SIZE + px) * 3;
                    if (d2 > 1) {
                        // 石子右下方的接触阴影
                        const sx = (i - r * 0.35) / (r * ecc), sy = (j - r * 0.35) / (r / ecc);
                        if (sx * sx + sy * sy <= 1.1) { buf[k] *= 0.82; buf[k + 1] *= 0.82; buf[k + 2] *= 0.82; }
                        continue;
                    }
                    const light = 1 + 0.18 * (-dx - dy) * 0.7 - 0.1 * d2;   // 左上受光
                    const f = tone * light;
                    const g = (buf[k] + buf[k + 1] + buf[k + 2]) / 3;
                    for (let c = 0; c < 3; c++) buf[k + c] = (buf[k + c] * (1 - grey) + g * grey) * f;
                }
            }
        }
    };
    stones(2600, 0.8, 2.0, SEED + 2700);
    stones(90, 2.5, 4.5, SEED + 2800);
    return buf;
}

/**
 * 花岗岩（散落的石头用）：比山体岩石细碎，大量黑白矿物斑点 + 少量细裂纹 + 风化斑块
 */
function granitePixels(): Float32Array {
    const buf = new Float32Array(SIZE * SIZE * 3);
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            const u = x / SIZE, v = y / SIZE;
            const mass = pfbm(u, v, 3, 3, 4, SEED + 3000);
            const mid = pfbm(u, v, 16, 16, 3, SEED + 3050);
            let lum = (0.8 + 0.3 * mass) * (0.88 + 0.24 * mid);
            // 矿物斑点：黑云母（深）、长石（浅）、石英（浅灰），用中频噪声成团分布
            const s = pfbm(u, v, 48, 48, 2, SEED + 3100);
            const sp = hash2(x, y, SEED + 3150);
            if (s > 0.62 && sp < 0.55) lum *= 0.55;
            else if (s < 0.36 && sp < 0.5) lum *= 1.22;
            lum *= 0.92 + 0.16 * hash2(x, y, SEED + 3200);
            // 细裂纹
            const ridge = 1 - Math.abs(2 * pfbm(u, v, 5, 5, 4, SEED + 3250) - 1);
            if (ridge > 0.965) lum *= 0.6;
            const warm = pfbm(u, v, 6, 6, 2, SEED + 3300) - 0.5;   // 偏暖/偏冷的斑块
            const i = (y * SIZE + x) * 3;
            buf[i] = lum * (1 + warm * 0.1);
            buf[i + 1] = lum;
            buf[i + 2] = lum * (1 - warm * 0.12);
        }
    }
    return buf;
}

/**
 * 层状砂岩：v 方向（石头侧面的高度方向）明显的水平岩层，层与层颜色深浅、冷暖不同，
 * 层线被噪声扭曲；层内有细颗粒和侵蚀出的凹槽
 */
function strataPixels(): Float32Array {
    const buf = new Float32Array(SIZE * SIZE * 3);
    const BANDS = 10;   // 一张贴图里的层数（整数，保证无缝）
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            const u = x / SIZE, v = y / SIZE;
            const warp = pfbm(u, v, 3, 2, 3, SEED + 3500);
            const t = (v + (warp - 0.5) * 0.12) * BANDS;
            const band = ((Math.floor(t) % BANDS) + BANDS) % BANDS;
            const inB = t - Math.floor(t);
            const tone = 0.82 + 0.3 * hash2(band, 0, SEED + 3550);
            const hue = hash2(band, 1, SEED + 3550) - 0.5;
            let lum = tone * (0.9 + 0.14 * pfbm(u, v, 12, 4, 3, SEED + 3600));
            // 层线：每层的上沿暗、下沿略亮（侵蚀出的台阶）
            if (inB < 0.06) lum *= 0.62;
            else if (inB < 0.14) lum *= 0.85;
            else if (inB > 0.9) lum *= 1.06;
            lum *= 0.93 + 0.14 * hash2(x, y, SEED + 3650);
            const i = (y * SIZE + x) * 3;
            buf[i] = lum * (1.04 + hue * 0.12);
            buf[i + 1] = lum;
            buf[i + 2] = lum * (0.92 - hue * 0.1);
        }
    }
    return buf;
}

/** 一张石头贴图覆盖的边长（米），石头物件用法线投影 UV */
export const STONE_TILE = 2;   // 必须能整除块边长，石头格子的地面在块之间才没有接缝
let graniteTex: Laya.Texture2D | null = null;
let strataTex: Laya.Texture2D | null = null;

export function graniteTexture(): Laya.Texture2D {
    if (!graniteTex || graniteTex.destroyed) graniteTex = makeTexture(toRGBA(granitePixels()));
    return graniteTex;
}

export function strataTexture(): Laya.Texture2D {
    if (!strataTex || strataTex.destroyed) strataTex = makeTexture(toRGBA(strataPixels()));
    return strataTex;
}

let gravelTex: Laya.Texture2D | null = null;
/** 一张砂石贴图覆盖的边长（米） */
export const GRAVEL_TILE = 4;

export function gravelTexture(): Laya.Texture2D {
    if (!gravelTex || gravelTex.destroyed) gravelTex = makeTexture(toRGBA(gravelPixels()));
    return gravelTex;
}

let trailTex: Laya.Texture2D | null = null;
/** 山路：砂石贴图 + alpha 里的参差边缘（alpha 测试裁出路边），和平地道路是同一种砂石 */
export function trailTexture(): Laya.Texture2D {
    if (!trailTex || trailTex.destroyed) trailTex = makeTexture(toRGBA(gravelPixels(), edgeAlpha(SEED + 2700)));
    return trailTex;
}

let grassTex: Laya.Texture2D | null = null;
let plankTex: Laya.Texture2D | null = null;
let sandTex: Laya.Texture2D | null = null;
let rockTex: Laya.Texture2D | null = null;

/** 一张岩石贴图覆盖的边长（米） */
export const ROCK_TILE = 8;

export function rockTexture(): Laya.Texture2D {
    if (!rockTex || rockTex.destroyed) rockTex = makeTexture(toRGBA(rockPixels()));
    return rockTex;
}

export function sandTexture(): Laya.Texture2D {
    if (!sandTex || sandTex.destroyed) sandTex = makeTexture(toRGBA(sandPixels(), sandEdgeAlpha()));
    return sandTex;
}

export function grassTexture(): Laya.Texture2D {
    if (!grassTex || grassTex.destroyed) {
        grassTex = makeTexture(toRGBA(grassPixels(), grassEdgeAlpha()));
    }
    return grassTex;
}

export function plankTexture(): Laya.Texture2D {
    if (!plankTex || plankTex.destroyed) plankTex = makeTexture(toRGBA(plankPixels()));
    return plankTex;
}
