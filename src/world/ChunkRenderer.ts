import { hash2 } from "./Noise";
import { createWaterMaterial } from "./WaterShader";
import { MeshBuilder, RGB } from "./MeshBuilder";
import {
    GRASS_TILE, GRAVEL_TILE, ROCK_TILE, SAND_TILE, STONE_TILE, TEX_GAIN,
    graniteTexture, grassTexture, gravelTexture, plankTexture, rockTexture, sandTexture, strataTexture,
} from "./TerrainTextures";
import { CELL, CHUNK_CELLS, CHUNK_SIZE, Cell, SEED } from "./WorldConfig";
import { ChunkData, WATER_Y, WALK_MIN_Y, terrainHeight } from "./WorldGen";

export const COLORS: Record<number, RGB> = {
    [Cell.Grass]: [0.36, 0.62, 0.30],
    [Cell.Sand]: [0.86, 0.80, 0.55],
    [Cell.Road]: [0.62, 0.50, 0.34],
    [Cell.Bridge]: [0.55, 0.38, 0.22],
    [Cell.Water]: [0.45, 0.42, 0.30],   // 水底
    [Cell.Rock]: [0.50, 0.50, 0.52],
    [Cell.Tree]: [0.30, 0.55, 0.26],
    [Cell.Bush]: [0.33, 0.58, 0.28],
    [Cell.Stump]: [0.40, 0.58, 0.28],
    [Cell.Mountain]: [0.52, 0.49, 0.45],   // 小地图用的颜色，3D 中按高度另行着色
};
const MTN_GRASS: RGB = [0.34, 0.52, 0.28];
const MTN_ROCK: RGB = [0.50, 0.47, 0.43];
const MTN_ROCK_HI: RGB = [0.60, 0.58, 0.56];
const SNOW: RGB = [0.94, 0.95, 0.98];
/** 雪线（米） */
const SNOW_LINE = 24;

function mix(a: RGB, b: RGB, t: number): RGB {
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function smoothstep(a: number, b: number, x: number): number {
    const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
    return t * t * (3 - 2 * t);
}

/**
 * 山体顶点的草地权重（0~1）：低处、缓坡长草，高处、陡坡露出岩石。
 * 草地层盖在岩石层上，用这个权重做 alpha 裁切，草和岩石的分界是参差的
 */
function mountainGrass(h: number, slope: number): number {
    return 1 - smoothstep(0.35, 0.8, (h - 4) / 7 + slope * 0.75);
}

/** 山体岩石的颜色（乘岩石贴图）：越高越浅 -> 积雪；雪线附近犬牙交错，陡坡上积不住雪 */
function mountainRockColor(h: number, slope: number, jitter: number): RGB {
    const c = mix(MTN_ROCK, MTN_ROCK_HI, (h - 10) / 14);
    const snow = (h - SNOW_LINE + jitter * 4) / 3 - slope * 0.8;
    return mix(c, SNOW, snow);
}
const TRUNK: RGB = [0.40, 0.27, 0.16];
const LEAF: RGB = [0.16, 0.42, 0.20];
const BUSH: RGB = [0.22, 0.50, 0.22];
const BUSH_DARK: RGB = [0.14, 0.36, 0.17];
const BUSH_LIGHT: RGB = [0.40, 0.62, 0.26];
const FLOWER_COLORS: RGB[] = [[0.95, 0.92, 0.85], [0.95, 0.75, 0.25], [0.85, 0.45, 0.70], [0.65, 0.55, 0.92]];
const BERRY: RGB = [0.78, 0.12, 0.14];
/** 散落石头的颜色（乘石头贴图，所以带 TEX_GAIN） */
const GRANITE: RGB = [0.56 * TEX_GAIN, 0.56 * TEX_GAIN, 0.58 * TEX_GAIN];
const STRATA: RGB = [0.66 * TEX_GAIN, 0.57 * TEX_GAIN, 0.45 * TEX_GAIN];
const MOSS: RGB = [0.30 * TEX_GAIN, 0.46 * TEX_GAIN, 0.22 * TEX_GAIN];

const POST: RGB = [0.40, 0.27, 0.15];
const RAIL: RGB = [0.50, 0.34, 0.19];

function shade(c: RGB, f: number): RGB {
    return [Math.min(1, c[0] * f), Math.min(1, c[1] * f), Math.min(1, c[2] * f)];
}

/**
 * 地形网格分三层，各用一个材质：
 * - base：纯顶点色（道路、水底、树/石头等物件、桥的栏杆和桥墩）
 * - grass：绿色平地和山上长草的地方，草地贴图 × 顶点色（alpha 测试过渡）
 * - gravel：道路，砂石贴图 × 顶点色
 * - rock：山体，岩石贴图 × 顶点色（山上草地的边缘被裁掉后露出岩石）
 * - sand：沙地，沙地贴图 × 顶点色（alpha 测试过渡）
 * - plank：桥面，木板贴图 × 顶点色
 * - granite / strata：散落的石头（Cell.Rock）和它们下面的地面，花岗岩 / 层状砂岩贴图，法线投影 UV
 */
export type TerrainLayer = "base" | "grass" | "sand" | "plank" | "rock" | "gravel" | "granite" | "strata";
export interface ChunkMesh { mesh: Laya.Mesh; layer: TerrainLayer }

/** 地面用草地贴图的格子：草地以及长在草地上的树、灌木、树桩 */
function isGrassGround(kind: number): boolean {
    return kind === Cell.Grass || kind === Cell.Tree || kind === Cell.Bush || kind === Cell.Stump;
}

function isSandGround(kind: number): boolean {
    return kind === Cell.Sand;
}

/** 先上下左右，再对角 */
const NEIGHBORS8: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];

function isPath(kind: number): boolean {
    return kind === Cell.Bridge || kind === Cell.Road;
}

/**
 * 贴图层比下面的地面高一点，避免重合闪烁；草地盖在沙地上面（沙草交界处草的边缘压住沙子）。
 * 间距必须大于深度缓冲的最小可分辨距离：相机 near=0.3、far=1000，16 位深度缓冲在约 25 米处
 * 的精度只有约 0.07 米，0.01 的间距会让两层在深度测试里交替胜出，接触边缘随相机移动闪烁。
 */
const SAND_LIFT = 0.15;
const GRASS_LIFT = 0.3;

/** 草地边缘下面垫的地面颜色（被裁掉的地方露出来的颜色） */
function underColor(kind: number): RGB {
    if (kind === Cell.Mountain) return MTN_ROCK;
    if (kind === Cell.Bridge) return COLORS[Cell.Water];
    return COLORS[kind];
}

/**
 * 把一个块的数据构建成渲染网格（地形 + 树/石头/灌木/桥），按“每帧时间预算”调用。
 * kindGlobal：按全局格子坐标查类型，用来看相邻块边缘的格子（草地过渡、桥栏杆在块之间要连续）
 */
export function buildChunkMeshes(data: ChunkData, kindGlobal: (gx: number, gz: number) => number): ChunkMesh[] {
    const mb = new MeshBuilder();
    const grass = new MeshBuilder(true);
    const sand = new MeshBuilder(true);
    const plank = new MeshBuilder(true);
    const rock = new MeshBuilder(true);
    const gravel = new MeshBuilder(true);
    const granite = new MeshBuilder(true, STONE_TILE);
    const strata = new MeshBuilder(true, STONE_TILE);
    const gx0 = data.cx * CHUNK_CELLS, gz0 = data.cz * CHUNK_CELLS;
    granite.uvOriginX = strata.uvOriginX = gx0 * CELL;
    granite.uvOriginZ = strata.uvOriginZ = gz0 * CELL;
    const N = CHUNK_CELLS;
    // 本块 + 外面一圈格子的类型
    const M = N + 2;
    const K = new Int8Array(M * M);
    for (let z = -1; z <= N; z++)
        for (let x = -1; x <= N; x++)
            K[(z + 1) * M + x + 1] = x >= 0 && z >= 0 && x < N && z < N ? data.kindLocal(x, z) : kindGlobal(gx0 + x, gz0 + z);
    const kindAt = (lx: number, lz: number) => lx < -1 || lz < -1 || lx > N || lz > N ? -1 : K[(lz + 1) * M + lx + 1];
    /** 从 (lx,lz) 沿 (dx,dz) 连续的道路/桥格子数 */
    const pathRun = (lx: number, lz: number, dx: number, dz: number) => {
        let n = 0;
        while (n < 6 && isPath(kindAt(lx + dx * (n + 1), lz + dz * (n + 1)))) n++;
        return n;
    };

    // 顶点数据（(N+1)x(N+1)），用世界坐标/全局格子计算，相邻块共享边缘，没有接缝
    // H：高度。挨着道路的顶点压平一点并且不低于可走高度（按顶点处理，路边和草地之间没有台阶缝）
    // MG：山体上的草地权重（按高度和坡度），坡度用多算一圈的原始高度 R 求
    // AG：草地层的顶点 alpha = 0.5 + 0.5 × 周围 4 格的草地权重平均（草地格算 1，山体格算 MG）
    // AS：沙地层的顶点 alpha，同理
    const V = N + 1;
    const RW = V + 2;
    const R = new Float32Array(RW * RW);
    for (let z = -1; z <= V; z++)
        for (let x = -1; x <= V; x++)
            R[(z + 1) * RW + x + 1] = terrainHeight((gx0 + x) * CELL, (gz0 + z) * CELL);
    const H = new Float32Array(V * V);
    const MG = new Float32Array(V * V);
    const AG = new Float32Array(V * V);
    const AS = new Float32Array(V * V);
    for (let z = 0; z <= N; z++) {
        for (let x = 0; x <= N; x++) {
            const ri = (z + 1) * RW + x + 1;
            let h = R[ri];
            const slope = Math.hypot(R[ri + 1] - R[ri - 1], R[ri + RW] - R[ri - RW]) / (2 * CELL);
            const mg = mountainGrass(h, slope);
            let road = false, g = 0, s = 0, w = 0;
            for (let j = -1; j <= 0; j++) {
                for (let i = -1; i <= 0; i++) {
                    const k = kindAt(x + i, z + j);
                    if (k === Cell.Road) road = true;
                    if (isGrassGround(k)) g++;
                    else if (k === Cell.Mountain) g += mg;
                    if (isSandGround(k)) s++;
                    else if (k === Cell.Water) w++;
                }
            }
            // 沙滩挨着水的顶点：水格子也算沙地，沙子一直铺到水下，裁切发生在水面以下，
            // 不会在岸上露出水底的颜色；岸线由水面与地形相交 + 泡沫决定
            if (s > 0) {
                s += w;
            } else if (w > 0) {
                // 四邻全是水格的顶点（s===0）：若地形接近水面，也铺沙地贴图以遮盖水底深褐色。
                // depth>0 表示在水下；depth<0 表示地形高于水面（水格噪声低但高度可能超过 WATER_Y）。
                // smoothstep(0.2, 1.6, depth)：0.2m 以内全沙，1.6m 以下无沙，过渡藏在水面以下不可见。
                const depth = WATER_Y - h;
                const sf = 1 - smoothstep(0.2, 1.6, depth);
                if (sf > 0) s = 4 * sf;
            }
            if (road) h = Math.max(h, WALK_MIN_Y) - 0.02;
            H[z * V + x] = h;
            MG[z * V + x] = mg;
            AG[z * V + x] = 0.5 + 0.5 * (g / 4);
            AS[z * V + x] = 0.5 + 0.5 * (s / 4);
        }
    }

    for (let lz = 0; lz < N; lz++) {
        for (let lx = 0; lx < N; lx++) {
            const kind = data.kindLocal(lx, lz);
            const gx = gx0 + lx, gz = gz0 + lz;
            const x0 = gx * CELL, x1 = x0 + CELL, z0 = gz * CELL, z1 = z0 + CELL;
            const i00 = lz * V + lx, i10 = i00 + 1, i01 = i00 + V, i11 = i01 + 1;
            const h00 = H[i00], h10 = H[i10], h01 = H[i01], h11 = H[i11];
            const gal = [AG[i00], AG[i10], AG[i11], AG[i01]];   // 草地 alpha：与 quad 的顶点顺序 a-b-c-d 一致
            const gMin = Math.min(gal[0], gal[1], gal[2], gal[3]), gMax = Math.max(gal[0], gal[1], gal[2], gal[3]);
            const sal = [AS[i00], AS[i10], AS[i11], AS[i01]];   // 沙地 alpha
            const sMin = Math.min(sal[0], sal[1], sal[2], sal[3]), sMax = Math.max(sal[0], sal[1], sal[2], sal[3]);
            const jitter = hash2(gx, gz, SEED + 3);
            const hAvg = (h00 + h10 + h01 + h11) / 4;
            const slope = (Math.max(h00, h10, h01, h11) - Math.min(h00, h10, h01, h11)) / CELL;
            let col: RGB;
            if (kind === Cell.Mountain) {
                col = shade(mountainRockColor(hAvg, slope, jitter), (0.94 + jitter * 0.12) * TEX_GAIN);
            } else if (isGrassGround(kind)) {
                col = shade(COLORS[kind], (0.97 + jitter * 0.06) * TEX_GAIN);
            } else if (isSandGround(kind)) {
                col = shade(COLORS[kind], (0.97 + jitter * 0.06) * TEX_GAIN);
            } else {
                col = shade(COLORS[kind], 0.92 + jitter * 0.16);
            }
            const cxw = (x0 + x1) / 2, czw = (z0 + z1) / 2;
            const ref = [cxw, -1000, czw];   // 参考点在下方 => 法线朝上
            const grassCell = isGrassGround(kind), sandCell = isSandGround(kind);
            const textured = grassCell || sandCell;
            // base 层：非贴图格子总是画；贴图格子只在边缘（有裁剪）时画，做底色
            if (kind === Cell.Mountain) {
                // 岩石层；四个顶点都被草完全盖住的格子不用画
                if (gMin < 1) rock.quad([x0, h00, z0], [x1, h10, z0], [x1, h11, z1], [x0, h01, z1], col, ref,
                    rockUV(lx, lz, h00, h10, h11, h01));
            } else if (kind === Cell.Road) {
                gravelQuad(gravel, lx, lz, x0, z0, h00, h10, h11, h01, ref);
            } else if (kind === Cell.Rock) {
                // 石头下面的地面：花岗岩贴图，比石头本身暗一点（UV 自动从上往下投影）
                granite.quad([x0, h00, z0], [x1, h10, z0], [x1, h11, z1], [x0, h01, z1],
                    shade(GRANITE, 0.8 + jitter * 0.1), ref);
            } else if (!textured) {
                mb.quad([x0, h00, z0], [x1, h10, z0], [x1, h11, z1], [x0, h01, z1], col, ref);
            } else {
                const aMin2 = grassCell ? gMin : sMin;
                if (aMin2 < 1) {
                    let nk = -1;
                    for (const [dx, dz] of NEIGHBORS8) {
                        const k = kindAt(lx + dx, lz + dz);
                        if (k >= 0 && (grassCell ? !isGrassGround(k) : !isSandGround(k))) { nk = k; break; }
                    }
                    // 挨着路的草地边缘下面垫砂石，被裁掉的地方和路面是同一种材质
                    if (nk === Cell.Road) gravelQuad(gravel, lx, lz, x0, z0, h00, h10, h11, h01, ref);
                    else if (nk >= 0) mb.quad([x0, h00, z0], [x1, h10, z0], [x1, h11, z1], [x0, h01, z1],
                        shade(underColor(nk), 0.92 + jitter * 0.16), ref);
                }
            }
            // 草地层
            if (grassCell || gMax > 0.5) {
                const gcol = grassCell ? col
                    : shade(kind === Cell.Mountain ? MTN_GRASS : COLORS[Cell.Grass], (0.97 + jitter * 0.06) * TEX_GAIN);
                // UV 用块内坐标（块边长是 GRASS_TILE 的整数倍，块之间无缝），避免远处 UV 过大损失精度
                const u0 = (lx * CELL) / GRASS_TILE, u1 = u0 + CELL / GRASS_TILE;
                const v0 = (lz * CELL) / GRASS_TILE, v1 = v0 + CELL / GRASS_TILE;
                const L = GRASS_LIFT;
                grass.quad([x0, h00 + L, z0], [x1, h10 + L, z0], [x1, h11 + L, z1], [x0, h01 + L, z1], gcol, ref,
                    [u0, v0, u1, v0, u1, v1, u0, v1], gal);
            }
            // 沙地层
            if (sandCell || sMax > 0.5) {
                const scol = sandCell ? col : shade(COLORS[Cell.Sand], (0.97 + jitter * 0.06) * TEX_GAIN);
                const su0 = (lx * CELL) / SAND_TILE, su1 = su0 + CELL / SAND_TILE;
                const sv0 = (lz * CELL) / SAND_TILE, sv1 = sv0 + CELL / SAND_TILE;
                const L = SAND_LIFT;
                sand.quad([x0, h00 + L, z0], [x1, h10 + L, z0], [x1, h11 + L, z1], [x0, h01 + L, z1], scol, ref,
                    [su0, sv0, su1, sv0, su1, sv1, su0, sv1], sal);
            }

            const baseY = Math.max(Math.min(h00, h10, h01, h11), WALK_MIN_Y - 0.3);
            const r = hash2(gx, gz, SEED + 99);
            switch (kind) {
                case Cell.Tree:
                    pineTree(mb, cxw, baseY, czw, 0.8 + r * 0.6, r, LEAF);
                    break;
                case Cell.Mountain: {
                    // 山上的装饰（只是画面，山体格子本来就不可走）：长草的地方有树，裸露的岩石上有大石块
                    if (hAvg > SNOW_LINE - 3) break;
                    const cg = (MG[i00] + MG[i10] + MG[i01] + MG[i11]) / 4;
                    // 偏离格子中心，避免排成网格；高度取该点的双线性插值，往下埋一点防止在坡上悬空
                    const fx = 0.25 + 0.5 * hash2(gx, gz, SEED + 101), fz = 0.25 + 0.5 * hash2(gx, gz, SEED + 102);
                    const px = x0 + fx * CELL, pz = z0 + fz * CELL;
                    const py = (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
                    if (cg > 0.45 && slope < 1.3 && r < 0.12 + cg * 0.33) {
                        const leaf = shade(LEAF, 0.85 + hash2(gx, gz, SEED + 103) * 0.25);
                        const s = (0.75 + hash2(gx, gz, SEED + 104) * 0.6) * (0.8 + cg * 0.2);
                        pineTree(mb, px, py - 0.25 - slope * 0.3, pz, s, r, leaf);
                    } else if (cg < 0.5 && r > 0.93) {
                        const bc = shade(mountainRockColor(hAvg, 0, jitter), 0.92 + jitter * 0.12);
                        mb.boulder(px, py - slope * 0.4, pz, 0.6 + hash2(gx, gz, SEED + 105) * 0.8, bc,
                            i => hash2(gx * 64 + i, gz, SEED + 106));
                    }
                    break;
                }
                case Cell.Rock:
                    stoneCell(granite, strata, gx, gz, cxw, baseY, czw, jitter);
                    break;
                case Cell.Bush:
                    bushCell(mb, gx, gz, cxw, baseY, czw, jitter);
                    break;
                case Cell.Stump:
                    mb.box(cxw, baseY, czw, 0.45, 0.3, 0.45, TRUNK, [0.75, 0.6, 0.4]);
                    break;
                case Cell.Bridge: {
                    // 桥沿着道路/桥格子连得更长的方向延伸，木板横铺（垂直于桥的方向）
                    const alongX = pathRun(lx, lz, 1, 0) + pathRun(lx, lz, -1, 0) >= pathRun(lx, lz, 0, 1) + pathRun(lx, lz, 0, -1);
                    buildBridgeCell(mb, plank, kindAt, lx, lz, x0, z0, alongX, Math.min(h00, h10, h01, h11), jitter);
                    break;
                }
            }
        }
    }
    const out: ChunkMesh[] = [];
    for (const m of mb.build()) out.push({ mesh: m, layer: "base" });
    for (const m of grass.build()) out.push({ mesh: m, layer: "grass" });
    for (const m of sand.build()) out.push({ mesh: m, layer: "sand" });
    for (const m of plank.build()) out.push({ mesh: m, layer: "plank" });
    for (const m of rock.build()) out.push({ mesh: m, layer: "rock" });
    for (const m of gravel.build()) out.push({ mesh: m, layer: "gravel" });
    for (const m of granite.build()) out.push({ mesh: m, layer: "granite" });
    for (const m of strata.build()) out.push({ mesh: m, layer: "strata" });
    return out;
}

/**
 * 一个灌木格子（不可走，可以砍）的模型，按格子哈希从几种造型里选一种：
 * 0 圆团灌木（几团叶簇挤在一起）；1 开花的灌木；2 结红果的深色灌木；3 高草/蕨丛（一束倾斜的叶片）。
 * 叶簇是平面着色的多面体团块，底部偏暗、顶部偏亮；尺寸基本占满格子，
 * 成片的灌木格子会连成一整片树篱
 */
function bushCell(mb: MeshBuilder, gx: number, gz: number, x: number, y: number, z: number, jitter: number) {
    const rnd = (k: number) => (i: number) => hash2(gx * 101 + i, gz * 83 + k, SEED + 4500);
    const h = (k: number) => hash2(gx, gz, SEED + 4600 + k);
    const variant = Math.floor(h(0) * 4);
    const R = CELL * 0.5;
    // 每格的叶色在深绿和黄绿之间变化
    const base = mix(BUSH_DARK, BUSH, 0.55 + jitter * 0.45);
    const light = mix(BUSH, BUSH_LIGHT, 0.4 + h(1) * 0.6);

    /** 一团叶簇：中心 (cx,cz)，半径 r，高 hh；顶部用亮色 */
    const clump = (cx: number, cz: number, r: number, hh: number, k: number, col = base, top = light) =>
        mb.rock(cx, y, cz, r, r * (0.85 + h(40 + k) * 0.3), hh, h(50 + k) * Math.PI * 2, col, rnd(k), 1.15, top);

    /** 叶簇外围的一圈小团，返回它们的位置，用于放花和果子 */
    const ring = (n: number, dist: number, r: number, hh: number, col?: RGB, top?: RGB) => {
        const pts: number[][] = [];
        const a0 = h(2) * Math.PI * 2;
        for (let k = 0; k < n; k++) {
            const a = a0 + (k / n) * Math.PI * 2 + (h(10 + k) - 0.5) * 0.8;
            const d = dist * (0.8 + h(20 + k) * 0.4);
            const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
            const s = 0.8 + h(30 + k) * 0.4;
            clump(px, pz, r * s, hh * s, k + 1, col, top);
            pts.push([px, y + hh * s * 0.85, pz, r * s]);
        }
        return pts;
    };

    /** 在叶簇表面散落小方块（花、果子） */
    const dots = (pts: number[][], cols: RGB[], per: number, size: number) => {
        let k = 0;
        for (const [px, py, pz, r] of pts) {
            for (let i = 0; i < per; i++, k++) {
                const a = h(60 + k) * Math.PI * 2, d = r * (0.2 + h(80 + k) * 0.5);
                const c = cols[Math.floor(h(100 + k) * cols.length)];
                mb.box(px + Math.cos(a) * d, py - d * 0.35, pz + Math.sin(a) * d, size, size, size, shade(c, 0.85), c);
            }
        }
    };

    switch (variant) {
        case 0: {
            clump(x, z, R * 0.7, 1.3 + h(3) * 0.4, 0);
            ring(3 + (h(4) < 0.5 ? 1 : 0), R * 0.55, R * 0.5, 0.9 + h(5) * 0.3);
            break;
        }
        case 1: {
            // 花色每格一种（偶尔两种混开）
            const c1 = FLOWER_COLORS[Math.floor(h(6) * FLOWER_COLORS.length)];
            const c2 = h(7) < 0.3 ? FLOWER_COLORS[Math.floor(h(8) * FLOWER_COLORS.length)] : c1;
            const hh = 1.1 + h(3) * 0.3;
            clump(x, z, R * 0.65, hh, 0);
            const pts = ring(3, R * 0.5, R * 0.48, 0.85);
            pts.push([x, y + hh * 0.9, z, R * 0.6]);
            dots(pts, [c1, c2], 3, 0.13);
            break;
        }
        case 2: {
            const dark = shade(BUSH_DARK, 0.95 + jitter * 0.15);
            const top = mix(BUSH_DARK, BUSH, 0.6);
            const hh = 1.0 + h(3) * 0.3;
            clump(x, z, R * 0.72, hh, 0, dark, top);
            const pts = ring(4, R * 0.55, R * 0.45, 0.8, dark, top);
            pts.push([x, y + hh * 0.9, z, R * 0.6]);
            dots(pts, [BERRY], 2, 0.1);
            break;
        }
        default: {
            // 高草/蕨丛：一束从中心向外倾斜的细长三棱锥叶片，中间有一小团矮叶簇垫底
            clump(x, z, R * 0.55, 0.5, 0, base, base);
            const n = 11 + Math.floor(h(3) * 5);
            for (let k = 0; k < n; k++) {
                const a = h(120 + k) * Math.PI * 2;
                const d0 = R * 0.35 * h(140 + k);
                const lean = 0.35 + h(160 + k) * 0.55;
                const len = 1.0 + h(180 + k) * 0.9;
                const bx = x + Math.cos(a) * d0, bz = z + Math.sin(a) * d0;
                const tx = bx + Math.cos(a) * len * lean, tz = bz + Math.sin(a) * len * lean;
                const ty = y + len * (1 - lean * 0.45);
                blade(mb, bx, y - 0.05, bz, tx, ty, tz, 0.11, mix(base, light, h(200 + k)));
            }
            break;
        }
    }
}

/** 一片叶子：从底部 (bx,by,bz) 到叶尖 (tx,ty,tz) 的细三棱锥（三个侧面，四面都看得见） */
function blade(mb: MeshBuilder, bx: number, by: number, bz: number, tx: number, ty: number, tz: number, w: number, col: RGB) {
    const p: number[][] = [];
    for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        p.push([bx + Math.cos(a) * w, by, bz + Math.sin(a) * w]);
    }
    // 参考点取在叶片轴线中点，法线朝外
    const rx = (bx + tx) / 2, ry = (by + ty) / 2, rz = (bz + tz) / 2;
    for (let i = 0; i < 3; i++) {
        const a = p[i], b = p[(i + 1) % 3];
        const c = shade(col, 0.88 + i * 0.1);
        mb.tri(a[0], a[1], a[2], b[0], b[1], b[2], tx, ty, tz, c, rx, ry, rz);
    }
}

/**
 * 一个石头格子（不可走）的模型，按格子哈希从几种造型里选一种：
 * 0 圆滚的大石头；1 一大两小的石堆；2 长苔藓的大石头（花岗岩）；
 * 3 叠起来的扁平石板；4 往上收的石柱（层状砂岩）。
 * 所有造型都基本占满格子，看起来挡路；朝向、尺寸、颜色都有随机变化
 */
function stoneCell(granite: MeshBuilder, strata: MeshBuilder, gx: number, gz: number,
    x: number, y: number, z: number, jitter: number) {
    const rnd = (k: number) => (i: number) => hash2(gx * 97 + i, gz * 89 + k, SEED + 4000);
    const h = (k: number) => hash2(gx, gz, SEED + 4100 + k);
    const variant = Math.floor(h(0) * 5);
    const rot = h(1) * Math.PI * 2;
    const R = CELL * 0.5;   // 格子半宽
    const gcol = shade(GRANITE, 0.9 + jitter * 0.2);
    const scol = shade(STRATA, 0.9 + jitter * 0.2);
    // 偏离格子中心一点
    const ox = (h(2) - 0.5) * 0.3, oz = (h(3) - 0.5) * 0.3;
    switch (variant) {
        case 0: {
            const s = 0.85 + h(4) * 0.3;
            granite.rock(x + ox, y, z + oz, R * 0.95 * s, R * (0.75 + h(5) * 0.2) * s, (1.3 + h(6) * 0.6) * s, rot, gcol, rnd(0), 1.08);
            break;
        }
        case 1: {
            granite.rock(x + ox, y, z + oz, R * 0.7, R * 0.6, 1.3 + h(4) * 0.4, rot, gcol, rnd(0), 1.05);
            for (let k = 0; k < 2; k++) {
                const a = rot + k * 2.4 + h(10 + k);
                const d = R * 0.6;
                const s = 0.3 + h(12 + k) * 0.2;
                granite.rock(x + Math.cos(a) * d, y, z + Math.sin(a) * d, R * s, R * s * 0.85, 0.7 * s * 2,
                    a, shade(gcol, 0.92 + h(14 + k) * 0.15), rnd(1 + k), 1.1);
            }
            break;
        }
        case 2: {
            const s = 0.9 + h(4) * 0.25;
            granite.rock(x + ox, y, z + oz, R * 0.92 * s, R * 0.82 * s, (1.1 + h(5) * 0.4) * s, rot, gcol, rnd(0), 1.12,
                shade(MOSS, 0.9 + h(6) * 0.2));
            break;
        }
        case 3: {
            // 2~3 层扁平石板，越往上越小，每层朝向略有偏转
            const n = 2 + (h(4) < 0.5 ? 1 : 0);
            let yy = y;
            for (let k = 0; k < n; k++) {
                const s = 1 - k * 0.24;
                const th = 0.45 + h(5 + k) * 0.25;
                strata.rock(x + ox * (1 + k), yy, z + oz * (1 - k), R * 0.95 * s, R * 0.8 * s, th + 0.2, rot + k * 0.4,
                    shade(scol, 0.95 + h(8 + k) * 0.12), rnd(k), 1.02);
                yy += th;
            }
            break;
        }
        default: {
            // 石柱 + 脚下一块碎石
            const s = 0.85 + h(4) * 0.3;
            strata.rock(x + ox, y, z + oz, R * 0.75 * s, R * 0.65 * s, (2.2 + h(5) * 0.9) * s, rot, scol, rnd(0), 0.82);
            const a = rot + 1.9;
            strata.rock(x + Math.cos(a) * R * 0.7, y, z + Math.sin(a) * R * 0.7, R * 0.3, R * 0.25, 0.45,
                a, shade(scol, 0.9), rnd(1), 1.1);
            break;
        }
    }
}

/** 砂石路面：所有格子同一个颜色（不做逐格明暗，否则会拼成棋盘格），深浅变化交给贴图 */
const GRAVEL_COL = shade(COLORS[Cell.Road], TEX_GAIN);
function gravelQuad(gravel: MeshBuilder, lx: number, lz: number, x0: number, z0: number,
    h00: number, h10: number, h11: number, h01: number, ref: number[]) {
    const x1 = x0 + CELL, z1 = z0 + CELL;
    // 块内坐标做 UV，块边长是 GRAVEL_TILE 的整数倍，块之间无缝
    const u0 = lx * CELL / GRAVEL_TILE, u1 = u0 + CELL / GRAVEL_TILE;
    const v0 = lz * CELL / GRAVEL_TILE, v1 = v0 + CELL / GRAVEL_TILE;
    gravel.quad([x0, h00, z0], [x1, h10, z0], [x1, h11, z1], [x0, h01, z1], GRAVEL_COL, ref,
        [u0, v0, u1, v0, u1, v1, u0, v1]);
}

/** 松树：树干 + 两层树冠 */
function pineTree(mb: MeshBuilder, x: number, y: number, z: number, s: number, r: number, leaf: RGB) {
    mb.box(x, y, z, 0.35 * s, 1.2 * s, 0.35 * s, TRUNK);
    mb.cone(x, y + 1.0 * s, z, 1.0 * s, 2.4 * s, leaf, 6, r * 3);
    mb.cone(x, y + 2.0 * s, z, 0.7 * s, 1.8 * s, shade(leaf, 1.15), 6, r * 5);
}

/**
 * 山体格子的岩石 UV（顶点顺序 00-10-11-01）。按格子朝向选投影面：
 * 缓坡从上往下投影 (x,z)；陡坡投影到侧面 (水平, 高度)，悬崖上的纹理不会被拉长，岩层是横向的。
 * 水平坐标用块内坐标（块边长是 ROCK_TILE 的整数倍，块之间无缝）
 */
function rockUV(lx: number, lz: number, h00: number, h10: number, h11: number, h01: number): number[] {
    const T = ROCK_TILE;
    const x0 = lx * CELL / T, x1 = x0 + CELL / T, z0 = lz * CELL / T, z1 = z0 + CELL / T;
    const dhx = Math.abs((h10 + h11) - (h00 + h01)) / (2 * CELL);
    const dhz = Math.abs((h01 + h11) - (h00 + h10)) / (2 * CELL);
    if (Math.max(dhx, dhz) < 0.8) return [x0, z0, x1, z0, x1, z1, x0, z1];
    if (dhx > dhz) return [z0, h00 / T, z0, h10 / T, z1, h11 / T, z1, h01 / T];   // 朝 ±x 的坡：投影到 (z, y)
    return [x0, h00 / T, x1, h10 / T, x1, h11 / T, x0, h01 / T];                    // 朝 ±z 的坡：投影到 (x, y)
}

/** 桥面顶部高度 = 可走高度，角色正好站在桥面上 */
const DECK_Y = WALK_MIN_Y;
const DECK_THICK = 0.22;
const RAIL_H = 0.95;

/**
 * 一个桥格子的模型：木板桥面（贴图）+ 桥面侧边 + 临水一侧的栏杆（立柱、扶手、中栏）+ 立柱下的桥墩。
 * 立柱放在格子边的中点，每段扶手正好一个格子长，相邻格子的栏杆首尾相接。
 */
function buildBridgeCell(mb: MeshBuilder, plank: MeshBuilder, kindAt: (lx: number, lz: number) => number,
    lx: number, lz: number, x0: number, z0: number, alongX: boolean, floorY: number, jitter: number) {
    const x1 = x0 + CELL, z1 = z0 + CELL;
    const cxw = x0 + CELL / 2, czw = z0 + CELL / 2;
    const top = DECK_Y, bot = DECK_Y - DECK_THICK;

    // 桥面：一个格子 = 一张木板贴图，贴图的 u 是木板长度方向
    const deckCol = shade(COLORS[Cell.Bridge], (0.96 + jitter * 0.08) * TEX_GAIN);
    const uv = alongX
        ? [0, 0, 0, 1, 1, 1, 1, 0]    // 桥沿 x 延伸：木板沿 z 铺，u 对应 z
        : [0, 0, 1, 0, 1, 1, 0, 1];   // 桥沿 z 延伸：木板沿 x 铺，u 对应 x
    plank.quad([x0, top, z0], [x1, top, z0], [x1, top, z1], [x0, top, z1], deckCol, [cxw, -1000, czw], uv);

    const sideCol = shade(COLORS[Cell.Bridge], 0.78);
    const ref = [cxw, bot + DECK_THICK / 2, czw];
    // 四条边：邻格方向 (dx,dz) + 边的两个端点
    const edges: [number, number, number, number, number, number][] = [
        [0, -1, x0, z0, x1, z0],
        [0, 1, x0, z1, x1, z1],
        [-1, 0, x0, z0, x0, z1],
        [1, 0, x1, z0, x1, z1],
    ];
    for (const [dx, dz, ax, az, bx, bz] of edges) {
        const nk = kindAt(lx + dx, lz + dz);
        if (nk === Cell.Bridge) continue;
        // 桥面侧边（与陆地相接处会埋进地形里）
        mb.quad([ax, bot, az], [bx, bot, bz], [bx, top, bz], [ax, top, az], sideCol, ref);
        if (nk !== Cell.Water) continue;

        // 栏杆往格子内缩一点
        const inset = 0.12;
        const mx = (ax + bx) / 2 - dx * inset, mz = (az + bz) / 2 - dz * inset;
        const alongEdgeX = dz !== 0;
        // 立柱 + 桥墩（桥墩一直插到水底）
        mb.box(mx, bot, mz, 0.16, top - bot + RAIL_H, 0.16, POST, shade(POST, 1.15));
        if (floorY < bot) mb.box(mx, floorY - 0.2, mz, 0.26, bot - floorY + 0.2, 0.26, shade(POST, 0.85));
        // 扶手和中栏
        mb.box(mx, top + RAIL_H - 0.1, mz, alongEdgeX ? CELL : 0.1, 0.1, alongEdgeX ? 0.1 : CELL, RAIL, shade(RAIL, 1.15));
        mb.box(mx, top + RAIL_H * 0.45, mz, alongEdgeX ? CELL : 0.06, 0.07, alongEdgeX ? 0.06 : CELL, shade(RAIL, 0.92));
    }
}

/** 水深达到这个值（米）时视为最深颜色 */
const WATER_FULL_DEPTH = 2.5;

/**
 * 块 (cx,cz) 的水面网格（世界坐标），只覆盖有顶点低于水位的格子；没有水返回 null。
 * 顶点色 r = 水深 0~1，水面 shader 用它混合深浅颜色和岸边泡沫。
 */
export function buildWaterMesh(cx: number, cz: number): Laya.Mesh | null {
    const N = CHUNK_CELLS;
    const gx0 = cx * CHUNK_CELLS, gz0 = cz * CHUNK_CELLS;
    const D = new Float32Array((N + 1) * (N + 1));
    for (let z = 0; z <= N; z++)
        for (let x = 0; x <= N; x++)
            D[z * (N + 1) + x] = (WATER_Y - terrainHeight((gx0 + x) * CELL, (gz0 + z) * CELL)) / WATER_FULL_DEPTH;

    const verts: number[] = [];
    const idx: number[] = [];
    const vmap = new Int32Array((N + 1) * (N + 1)).fill(-1);
    const vert = (x: number, z: number) => {
        const k = z * (N + 1) + x;
        if (vmap[k] < 0) {
            vmap[k] = verts.length / 10;
            const d = Math.max(0, Math.min(1, D[k]));
            verts.push((gx0 + x) * CELL, WATER_Y, (gz0 + z) * CELL, 0, 1, 0, d, 0, 0, 1);
        }
        return vmap[k];
    };
    for (let z = 0; z < N; z++) {
        for (let x = 0; x < N; x++) {
            const k = z * (N + 1) + x;
            if (D[k] <= 0 && D[k + 1] <= 0 && D[k + N + 1] <= 0 && D[k + N + 2] <= 0) continue;
            const a = vert(x, z), b = vert(x + 1, z), c = vert(x + 1, z + 1), d = vert(x, z + 1);
            // 从上往下看顺时针（Laya 的正面，与 MeshBuilder 一致）
            idx.push(a, c, d, a, b, c);
        }
    }
    if (idx.length === 0) return null;
    const decl = Laya.VertexMesh.getVertexDeclaration("POSITION,NORMAL,COLOR");
    return Laya.PrimitiveMesh._createMesh(decl, new Float32Array(verts), new Uint16Array(idx));
}

export interface WorldMaterials {
    terrain: Record<TerrainLayer, Laya.BlinnPhongMaterial>;
    water: Laya.Material;
}

function terrainMaterial(tex: Laya.BaseTexture | null): Laya.BlinnPhongMaterial {
    const m = new Laya.BlinnPhongMaterial();
    m.enableVertexColor = true;
    m.albedoColor = new Laya.Color(1, 1, 1, 1);
    m.specularColor = new Laya.Color(0, 0, 0, 1);
    if (tex) m.albedoTexture = tex;
    m.lock = true;
    return m;
}

/** 草地/沙地材质：alpha 测试，顶点 alpha × 贴图 alpha < 0.5 的像素被裁掉 */
function cutoutMaterial(tex: Laya.BaseTexture): Laya.BlinnPhongMaterial {
    const m = terrainMaterial(tex);
    m.lock = false;
    m.materialRenderMode = Laya.MaterialRenderMode.RENDERMODE_CUTOUT;
    m.alphaTestValue = 0.5;
    m.lock = true;
    return m;
}

/** 地形和水面共用的材质（游戏运行和编辑器预览共用） */
export function createWorldMaterials(): WorldMaterials {
    const water = createWaterMaterial();
    water.lock = true;
    return {
        terrain: {
            base: terrainMaterial(null),
            grass: cutoutMaterial(grassTexture()),
            sand: cutoutMaterial(sandTexture()),
            plank: terrainMaterial(plankTexture()),
            rock: terrainMaterial(rockTexture()),
            gravel: terrainMaterial(gravelTexture()),
            granite: terrainMaterial(graniteTexture()),
            strata: terrainMaterial(strataTexture()),
        },
        water,
    };
}
