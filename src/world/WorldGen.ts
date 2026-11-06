import { fbm, hash2, ridgedFbm, valueNoise } from "./Noise";
import { CELL, CHUNK_CELLS, CHUNK_SIZE, Cell, SEED, isWalkableKind } from "./WorldConfig";

/**
 * 程序化世界生成（纯函数，确定性）。
 *
 * 道路网（稀疏）：
 * 1. 主干道：世界按 REGION（512 米）划分大区，每个大区有一个枢纽点（落在陆地上），
 *    相邻（上下左右）大区的枢纽之间修一条弯曲的主干道，路宽约 13 米。
 *    主干道只跨窄水面（修桥）；遇到大水面时依次尝试向两侧绕行，都绕不开就不修这一段。
 * 2. 小路：每个大区 0~2 条，从主干道中段分叉出去，路宽约 4 米，只跨很窄的溪流，
 *    遇到宽水面就在岸边结束。
 * 3. 其余地方是大片相连的草地、森林、山和水。大水面不能通过。
 *
 * 连通性：不再保证任意两点可达（大湖、山脉会挡路）。
 * 块内完全被围住的小块空地会填成灌木；寻路找不到路时会走到离目标最近的可达位置。
 */

export const WATER_Y = -2.0;
/** 桥面/道路的最低高度 */
export const WALK_MIN_Y = WATER_Y + 0.15;

/** 水体判定阈值（与 generateChunk 一致） */
const WATER_NOISE = 0.36;
/** 小水坑被抬到这个噪声值（沙地，略高于水面） */
const POND_FLOOR = WATER_NOISE + 0.012;

/**
 * 地形原始噪声 [0,1)。
 * 只保留大尺度低洼处（前 2 层 octave 的噪声 coarse 足够低）的水；
 * coarse 不够低、只因为细节噪声凹下去形成的小水坑被抬到水面以上（变成沙地），这里也就不会修桥。
 * 按 coarse 平滑过渡，地形高度仍然连续
 */
export function terrainNoise(wx: number, wz: number): number {
    const n = fbm(wx / 140, wz / 140, 4, SEED);
    if (n >= POND_FLOOR) return n;
    const coarse = fbm(wx / 140, wz / 140, 2, SEED);   // 只取 n 的低频两层：大尺度的起伏
    const w = smoothstep(0.28, 0.34, coarse);
    return n + (POND_FLOOR - n) * w;
}

function smoothstep(a: number, b: number, x: number): number {
    const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
    return t * t * (3 - 2 * t);
}

/** 山峰最大高度（米，叠加在基础地形之上） */
const MOUNTAIN_HEIGHT = 42;
/** 山体高度超过这个值（米）的格子是不可走的山 */
export const MOUNTAIN_CELL_MIN = 2.2;
/** 道路中心保留的山体比例（山口略微隆起，而不是完全平的峡谷） */
const ROAD_KEEP = 0.04;

/** 山体高度（米），没有山的地方为 0。n 为 terrainNoise 的值 */
export function mountainHeight(wx: number, wz: number, n: number): number {
    // 山区分布（低频）；低洼处（湖泊、沙滩）不长山，水体判定保持不变
    const mask = smoothstep(0.52, 0.64, fbm(wx / 240, wz / 240, 3, SEED + 900)) * smoothstep(0.40, 0.50, n);
    if (mask <= 0) return 0;
    const ridge = ridgedFbm(wx / 110, wz / 110, 5, SEED + 700);
    // 道路切开山体形成山谷
    return mask * (0.1 + ridge * ridge * 1.1) * MOUNTAIN_HEIGHT * roadValley(wx, wz);
}

/** 地形高度（米），是世界坐标的连续函数，所以块与块之间不会有接缝 */
export function terrainHeight(wx: number, wz: number): number {
    const n = terrainNoise(wx, wz);
    return (n - 0.5) * 14 + mountainHeight(wx, wz, n);
}

/** 角色站立高度 */
export function groundY(wx: number, wz: number): number {
    return Math.max(terrainHeight(wx, wz), WALK_MIN_Y);
}

// ==================== 道路网 ====================

/** 大区边长（块数 / 米）。大区 (rx,rz) 覆盖 [(rx-0.5)R, (rx+0.5)R) */
const REGION_CHUNKS = 8;
const REGION = REGION_CHUNKS * CHUNK_SIZE;

interface RoadStyle {
    /** 路面半宽（米）：离中心线这么远以内的格子是路 */
    half: number;
    /** 山谷：距中心 valleyIn 米内山体压到最低，valleyOut 米外恢复原高 */
    valleyIn: number;
    valleyOut: number;
    /** 能修桥的最长水面（米），更长的水面过不去 */
    maxBridge: number;
}

/** 主干道：路宽约 6~7 格（13 米） */
const HIGHWAY: RoadStyle = { half: 6.4, valleyIn: 9, valleyOut: 18, maxBridge: 30 };
/** 小路：路宽约 2 格（4 米） */
const TRAIL: RoadStyle = { half: 2.2, valleyIn: 4, valleyOut: 10, maxBridge: 6 };
/** 块的道路候选范围外扩（米），必须不小于所有 valleyOut 和 half */
const ROAD_MARGIN = 20;

interface Road {
    style: RoadStyle;
    /** 折线顶点 x0,z0,x1,z1,...（世界坐标） */
    pts: number[];
    minX: number; maxX: number; minZ: number; maxZ: number;
}

interface P { x: number; z: number; }

function makeRoad(style: RoadStyle, pts: number[]): Road {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
        minX = Math.min(minX, pts[i]); maxX = Math.max(maxX, pts[i]);
        minZ = Math.min(minZ, pts[i + 1]); maxZ = Math.max(maxZ, pts[i + 1]);
    }
    return { style, pts, minX, maxX, minZ, maxZ };
}

/** 两点之间的弯曲折线：横向偏移 = sin(πt) × (bias + 噪声摆动)，两端正好落在 a、b 上 */
const POLY_SEGS = 32;
function bentLine(a: P, b: P, seed: number, bias: number, wiggle: number): number[] {
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    const nx = -dz / len, nz = dx / len;
    const pts: number[] = [];
    for (let i = 0; i <= POLY_SEGS; i++) {
        const t = i / POLY_SEGS;
        const off = Math.sin(Math.PI * t) * (bias + wiggle * (valueNoise(t * 4, seed, SEED + 61) * 2 - 1));
        pts.push(a.x + dx * t + nx * off, a.z + dz * t + nz * off);
    }
    return pts;
}

/** 沿折线每米采样，返回第一段长于 maxRun 米的水面的起点（沿线距离），没有返回 Infinity */
function firstLongWater(pts: number[], maxRun: number): number {
    let dist = 0, runStart = -1;
    for (let i = 0; i + 3 < pts.length; i += 2) {
        const ax = pts[i], az = pts[i + 1], dx = pts[i + 2] - ax, dz = pts[i + 3] - az;
        const L = Math.sqrt(dx * dx + dz * dz);
        const steps = Math.max(1, Math.ceil(L));
        for (let s = i === 0 ? 0 : 1; s <= steps; s++) {
            const t = s / steps, d = dist + L * t;
            if (terrainNoise(ax + dx * t, az + dz * t) < WATER_NOISE) {
                if (runStart < 0) runStart = d;
                if (d - runStart > maxRun) return runStart;
            } else runStart = -1;
        }
        dist += L;
    }
    return Infinity;
}

/** 把折线截断到沿线距离 cut 米处 */
function truncateLine(pts: number[], cut: number): number[] {
    const out = [pts[0], pts[1]];
    let dist = 0;
    for (let i = 0; i + 3 < pts.length; i += 2) {
        const ax = pts[i], az = pts[i + 1], dx = pts[i + 2] - ax, dz = pts[i + 3] - az;
        const L = Math.sqrt(dx * dx + dz * dz);
        if (dist + L >= cut) {
            const t = L > 0 ? (cut - dist) / L : 0;
            out.push(ax + dx * t, az + dz * t);
            return out;
        }
        out.push(pts[i + 2], pts[i + 3]);
        dist += L;
    }
    return out;
}

function regionKey(rx: number, rz: number): number {
    return (rx + 32768) * 65536 + (rz + 32768);
}

/** 带容量上限的缓存（满了就清空，数据都能重新算出来） */
function cached<T>(map: Map<number, T>, key: number, limit: number, make: () => T): T {
    let v = map.get(key);
    if (v === undefined) {
        if (map.size >= limit) map.clear();
        v = make();
        map.set(key, v);
    }
    return v;
}

const hubCache = new Map<number, P>();
/**
 * 大区的枢纽点（主干道交汇处）：在大区中心附近抖动，依次尝试几个候选位置，取第一个在陆地上的。
 * 大区 (0,0) 的第一个候选是出生点附近的固定位置。
 */
function regionHub(rx: number, rz: number): P {
    return cached(hubCache, regionKey(rx, rz), 4096, () => {
        let p: P = { x: rx * REGION, z: rz * REGION };
        for (let k = 0; k < 8; k++) {
            p = rx === 0 && rz === 0 && k === 0
                ? { x: 34, z: 52 }
                : {
                    x: (rx + (hash2(rx * 8 + k, rz, SEED + 41) - 0.5) * 0.4) * REGION,
                    z: (rz + (hash2(rx, rz * 8 + k, SEED + 43) - 0.5) * 0.4) * REGION,
                };
            if (terrainNoise(p.x, p.z) > WATER_NOISE + 0.06) break;
        }
        return p;
    });
}

/** 遇到大水面时依次尝试的横向绕行量（米） */
const DETOURS = [0, 70, -70, 140, -140, 200, -200];

const edgeCache = new Map<number, Road | null>();
/** 枢纽 (rx,rz) 到 +x（dir=0）或 +z（dir=1）方向相邻枢纽的主干道；绕不开大水面时为 null */
function highwayEdge(rx: number, rz: number, dir: 0 | 1): Road | null {
    return cached(edgeCache, regionKey(rx, rz) * 2 + dir, 8192, () => {
        const a = regionHub(rx, rz), b = dir === 0 ? regionHub(rx + 1, rz) : regionHub(rx, rz + 1);
        const seed = Math.floor(hash2(rx, rz * 2 + dir, SEED + 63) * 1e6);
        for (const bias of DETOURS) {
            const pts = bentLine(a, b, seed, bias, 35);
            if (firstLongWater(pts, HIGHWAY.maxBridge) === Infinity) return makeRoad(HIGHWAY, pts);
        }
        return null;
    });
}

const trailCache = new Map<number, Road[]>();
/** 大区 (rx,rz) 的小路：从它的 +x/+z 主干道中段分叉出去 */
function regionTrails(rx: number, rz: number): Road[] {
    return cached(trailCache, regionKey(rx, rz), 4096, () => {
        const out: Road[] = [];
        const count = Math.floor(hash2(rx, rz, SEED + 71) * 3);   // 0~2 条
        for (let i = 0; i < count; i++) {
            const h = (s: number) => hash2(rx * 4 + i, rz, SEED + s);
            const edge = highwayEdge(rx, rz, h(73) < 0.5 ? 0 : 1);
            if (!edge) continue;
            // 起点：主干道折线上的某个顶点（中段）
            const seg = Math.floor(POLY_SEGS * (0.25 + h(75) * 0.5));
            const p = edge.pts;
            const sx = p[seg * 2], sz = p[seg * 2 + 1];
            const tx = p[seg * 2 + 2] - sx, tz = p[seg * 2 + 3] - sz;
            const tl = Math.sqrt(tx * tx + tz * tz) || 1;
            // 方向：大致垂直于主干道，随机偏转 ±0.4 弧度，伸向一侧
            const side = h(77) < 0.5 ? 1 : -1;
            const ang = Math.atan2(tz / tl, tx / tl) + side * Math.PI / 2 + (h(79) - 0.5) * 0.8;
            const len = 90 + h(81) * 130;
            const end = { x: sx + Math.cos(ang) * len, z: sz + Math.sin(ang) * len };
            let pts = bentLine({ x: sx, z: sz }, end, Math.floor(h(83) * 1e6), 0, 16);
            // 遇到宽水面就在岸边结束
            const cut = firstLongWater(pts, TRAIL.maxBridge);
            if (cut !== Infinity) {
                if (cut < 30) continue;
                pts = truncateLine(pts, cut - 3);
            }
            out.push(makeRoad(TRAIL, pts));
        }
        return out;
    });
}

const chunkRoadCache = new Map<number, Road[]>();
/**
 * 可能影响块 (cx,cz) 的道路（外扩 ROAD_MARGIN 米后包围盒相交）。
 * 枢纽抖动 ±0.2 个大区，主干道绕行最多偏离连线约 0.46 个大区，小路从主干道再伸出最多 0.45 个大区，
 * 看周围 5x5 个大区拥有的道路就足够（结果按块缓存）。
 */
function roadsNearChunk(cx: number, cz: number): Road[] {
    return cached(chunkRoadCache, regionKey(cx, cz), 4096, () => {
        const x0 = cx * CHUNK_SIZE - ROAD_MARGIN, x1 = (cx + 1) * CHUNK_SIZE + ROAD_MARGIN;
        const z0 = cz * CHUNK_SIZE - ROAD_MARGIN, z1 = (cz + 1) * CHUNK_SIZE + ROAD_MARGIN;
        const rx = Math.round((cx + 0.5) * CHUNK_SIZE / REGION), rz = Math.round((cz + 0.5) * CHUNK_SIZE / REGION);
        const out: Road[] = [];
        const add = (r: Road | null) => {
            if (r && r.maxX >= x0 && r.minX <= x1 && r.maxZ >= z0 && r.minZ <= z1) out.push(r);
        };
        for (let j = -2; j <= 2; j++) {
            for (let i = -2; i <= 2; i++) {
                add(highwayEdge(rx + i, rz + j, 0));
                add(highwayEdge(rx + i, rz + j, 1));
                for (const t of regionTrails(rx + i, rz + j)) add(t);
            }
        }
        // 主干道排在前面，判定路面时优先
        out.sort((a, b) => (a.style === HIGHWAY ? 0 : 1) - (b.style === HIGHWAY ? 0 : 1));
        return out;
    });
}

/** 点到折线的距离（米），超过 limit 时可能返回不精确的较大值 */
function lineDistance(r: Road, x: number, z: number, limit: number): number {
    if (x < r.minX - limit || x > r.maxX + limit || z < r.minZ - limit || z > r.maxZ + limit) return Infinity;
    const p = r.pts;
    let best = Infinity;
    for (let i = 0; i + 3 < p.length; i += 2) {
        const ax = p[i], az = p[i + 1], dx = p[i + 2] - ax, dz = p[i + 3] - az;
        const len2 = dx * dx + dz * dz;
        let t = len2 > 0 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = ax + dx * t - x, ez = az + dz * t - z;
        const d2 = ex * ex + ez * ez;
        if (d2 < best) best = d2;
    }
    return Math.sqrt(best);
}

/** 道路山谷系数：山体高度乘以它（道路中心 ROAD_KEEP，远处 1） */
function roadValley(wx: number, wz: number): number {
    let f = 1;
    for (const r of roadsNearChunk(Math.floor(wx / CHUNK_SIZE), Math.floor(wz / CHUNK_SIZE))) {
        const s = r.style;
        const d = lineDistance(r, wx, wz, s.valleyOut);
        if (d < s.valleyOut) f = Math.min(f, ROAD_KEEP + (1 - ROAD_KEEP) * smoothstep(s.valleyIn, s.valleyOut, d));
    }
    return f;
}

/** 出生点（全局格子坐标）：大区 (0,0) 的枢纽，主干道交汇处 */
export function spawnPoint(): { gx: number; gz: number } {
    const h = regionHub(0, 0);
    return { gx: Math.floor(h.x / CELL), gz: Math.floor(h.z / CELL) };
}

// ==================== 块生成 ====================

export class ChunkData {
    /** 每个格子的类型，索引 = lz * CHUNK_CELLS + lx */
    readonly kinds = new Uint8Array(CHUNK_CELLS * CHUNK_CELLS);
    constructor(readonly cx: number, readonly cz: number) { }

    kindLocal(lx: number, lz: number): number {
        return this.kinds[lz * CHUNK_CELLS + lx];
    }
    walkableLocal(lx: number, lz: number): boolean {
        return isWalkableKind(this.kinds[lz * CHUNK_CELLS + lx]);
    }
}

/** 块内完全被围住（不接触块边缘、没有道路）且小于这个格子数的空地填成灌木 */
const POCKET_MAX = 40;

export function generateChunk(cx: number, cz: number): ChunkData {
    const data = new ChunkData(cx, cz);
    const k = data.kinds;
    const N = CHUNK_CELLS;
    const gx0 = cx * N, gz0 = cz * N;
    const roads = roadsNearChunk(cx, cz);

    // 1. 地形 + 道路
    for (let lz = 0; lz < N; lz++) {
        for (let lx = 0; lx < N; lx++) {
            const gx = gx0 + lx, gz = gz0 + lz;
            const wx = (gx + 0.5) * CELL, wz = (gz + 0.5) * CELL;
            const n = terrainNoise(wx, wz);
            let kind: number = Cell.Grass;
            if (mountainHeight(wx, wz, n) > MOUNTAIN_CELL_MIN) kind = Cell.Mountain;
            else if (n < WATER_NOISE) kind = Cell.Water;
            else if (n < 0.395) kind = Cell.Sand;
            else if (n > 0.66) kind = Cell.Rock;
            else {
                const forest = fbm(wx / 70, wz / 70, 3, SEED + 500);
                const r = hash2(gx, gz, SEED + 7);
                if (forest > 0.56 && r < 0.45) kind = Cell.Tree;
                else if (r < 0.025) kind = Cell.Rock;   // 零散的石头
                else if (r < 0.06) kind = Cell.Tree;    // 零散的树
            }
            for (const r of roads) {
                if (lineDistance(r, wx, wz, r.style.half) <= r.style.half) {
                    // 路遇到水变成桥（能走到这里的水面都已经确认足够窄），遇到树/石头直接开路
                    kind = kind === Cell.Water ? Cell.Bridge : Cell.Road;
                    break;
                }
            }
            k[lz * N + lx] = kind;
        }
    }

    // 2. 块内被完全围住的小块空地 -> 灌木（大片草地、接触块边缘的空地保持原样）
    const comp = new Int32Array(N * N).fill(-1);
    const queue = new Int32Array(N * N);
    for (let s = 0; s < N * N; s++) {
        if (comp[s] >= 0 || !isWalkableKind(k[s])) continue;
        let head = 0, tail = 0, open = false;
        comp[s] = s; queue[tail++] = s;
        while (head < tail) {
            const i = queue[head++];
            const lx = i % N, lz = (i / N) | 0;
            if (lx === 0 || lz === 0 || lx === N - 1 || lz === N - 1 || k[i] === Cell.Road || k[i] === Cell.Bridge) open = true;
            if (lx > 0) visit(i - 1);
            if (lx < N - 1) visit(i + 1);
            if (lz > 0) visit(i - N);
            if (lz < N - 1) visit(i + N);
        }
        if (!open && tail < POCKET_MAX) for (let j = 0; j < tail; j++) k[queue[j]] = Cell.Bush;
        function visit(j: number) {
            if (comp[j] < 0 && isWalkableKind(k[j])) { comp[j] = s; queue[tail++] = j; }
        }
    }
    return data;
}
