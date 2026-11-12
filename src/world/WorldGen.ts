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
export const WATER_NOISE = 0.36;
/** 沙地判定阈值：地形噪声在 [WATER_NOISE, SAND_NOISE) 之间是沙地（与 generateChunk 一致） */
export const SAND_NOISE = 0.395;
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

/** 不考虑道路山谷的山体高度（米），没有山的地方为 0。只用噪声，不会触发道路生成 */
export function mountainBase(wx: number, wz: number, n: number): number {
    // 山区分布（低频）；低洼处（湖泊、沙滩）不长山，水体判定保持不变
    const mask = smoothstep(0.52, 0.64, fbm(wx / 240, wz / 240, 3, SEED + 900)) * smoothstep(0.40, 0.50, n);
    if (mask <= 0) return 0;
    const ridge = ridgedFbm(wx / 110, wz / 110, 5, SEED + 700);
    return mask * (0.1 + ridge * ridge * 1.1) * MOUNTAIN_HEIGHT;
}

/** 山体高度（米），没有山的地方为 0。n 为 terrainNoise 的值 */
export function mountainHeight(wx: number, wz: number, n: number): number {
    const b = mountainBase(wx, wz, n);
    // 道路切开山体形成山谷
    return b <= 0 ? 0 : b * roadValley(wx, wz);
}

/** 不含山路修整的地形高度（米） */
function rawHeight(wx: number, wz: number): number {
    const n = terrainNoise(wx, wz);
    return (n - 0.5) * 14 + mountainHeight(wx, wz, n);
}

/**
 * 地形高度（米），是世界坐标的连续函数，所以块与块之间不会有接缝。
 * 山路附近的地面压到山路的高度（距中心线 MTN_FLAT 米内完全压平，MTN_FALL 米外恢复原高）
 */
export function terrainHeight(wx: number, wz: number): number {
    const h = rawHeight(wx, wz);
    const segs = mountainSegsNearChunk(Math.floor(wx / CHUNK_SIZE), Math.floor(wz / CHUNK_SIZE));
    if (segs.length === 0 || !nearestMountainTrail(segs, wx, wz)) return h;
    return h + (nearY - h) * nearF;
}

/** 角色站立高度 */
export function groundY(wx: number, wz: number): number {
    return Math.max(terrainHeight(wx, wz), WALK_MIN_Y);
}

// ==================== 道路网 ====================

/** 大区边长（块数 / 米）。大区 (rx,rz) 覆盖 [(rx-0.5)R, (rx+0.5)R) */
const REGION_CHUNKS = 8;
export const REGION = REGION_CHUNKS * CHUNK_SIZE;

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

// ==================== 山路 ====================
//
// 高的山上修一条盘山小路，从山顶一直通到山脚（山体高度低于 MOUNTAIN_CELL_MIN 的地方，常常就是主干道的山谷）。
// 1. 每个大区找最多 PEAKS_PER_REGION 座山体高度超过 PEAK_MIN 的山峰。
// 2. 以山峰为中心在 MTN_GRID 米的粗网格上做 Dijkstra（16 个方向），超过坡度上限的边代价极高，
//    所以路会沿等高线斜着绕上去，自然形成之字形。
// 3. 折线做 Chaikin 平滑、按 MTN_SAMPLE 米重采样，取原始地形高度后平滑，
//    再从山脚往上逐点把坡度夹到 MTN_GRADE 以内（太陡的地方挖低）。
// 4. terrainHeight 把山路附近的地面压到路面高度（两侧形成挖方的岩壁），路面格子是 Road。

/** 山体高度超过这个值（米）的山峰修山路 */
const PEAK_MIN = 14;
const PEAKS_PER_REGION = 2;
/** 同一大区两座修路山峰的最小间距（米） */
const PEAK_SPACING = 200;
/** 找山峰的采样间距（米） */
const PEAK_STEP = 16;
/** 山路坡度上限（高度差 / 水平距离），0.3 约 17° */
export const MTN_GRADE = 0.3;
/** 规划山路的粗网格间距（米）和半径（格），半径决定山路最远伸出 176 米 */
const MTN_GRID = 8;
const MTN_GRID_R = 22;
/** 山路折线的采样间距（米） */
const MTN_SAMPLE = 3;
/** 山路路面半宽（米） */
const MTN_HALF = 1.8;
/** 距中心线 MTN_FLAT 米内地面压到路面高度，MTN_FALL 米外恢复原高 */
const MTN_FLAT = 3.5;
const MTN_FALL = 10;
/** 路面与原始地形的高度差上限（米），再往上修挖方/填方太大就在这里结束 */
const MTN_MAX_CUT = 5;
/** 之字形相邻两段中心线的最小间距（米），保证两段路面之间留出过渡的坡 */
const MTN_GAP = 2 * MTN_HALF + 3;

/** 16 个方向：上下左右、对角、马步，方便走出接近等高线的斜线 */
const MTN_DIRS = [
    [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
    [2, 1], [1, 2], [-1, 2], [-2, 1], [-2, -1], [-1, -2], [1, -2], [2, -1],
];

/**
 * 山路的终点只能落在已有道路（主干道、小路）上，这样山路一定和道路网连通。
 * 只到“山体结束”不够：山脚常常是大片散石（terrainNoise > 0.66）、密林，或者被群山围住的小盆地，
 * 路在那里结束就走不出去
 */
function isTrailGoal(x: number, z: number, n: number, m: number): boolean {
    if (m >= MOUNTAIN_CELL_MIN) return false;
    for (const r of roadsNearChunk(Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE))) {
        if (lineDistance(r, x, z, r.style.half) <= r.style.half - 1) return true;
    }
    return false;
}

/** 从山峰 peak 规划一条下到山脚的路，返回 x,z,y 三元组（山脚 -> 山顶）；找不到返回 null */
function planMountainTrail(peak: P): number[] | null {
    const R = MTN_GRID_R, W = 2 * R + 1, n = W * W;
    const hs = new Float32Array(n);
    /** 0 未采样，1 可以修路经过，2 终点，3 水（不能走） */
    const type = new Uint8Array(n);
    const sample = (i: number) => {
        if (type[i] !== 0) return type[i];
        const x = peak.x + (i % W - R) * MTN_GRID, z = peak.z + (((i / W) | 0) - R) * MTN_GRID;
        const tn = terrainNoise(x, z);
        const m = mountainHeight(x, z, tn);
        hs[i] = (tn - 0.5) * 14 + m;
        return type[i] = tn < WATER_NOISE ? 3 : isTrailGoal(x, z, tn, m) ? 2 : 1;
    };
    const dist = new Float32Array(n).fill(Infinity);
    const parent = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    const heap = new MinHeap();
    const start = R * W + R;
    sample(start);
    dist[start] = 0;
    heap.push(start, 0);
    let goal = -1;
    while (heap.size > 0) {
        const cur = heap.pop();
        if (done[cur]) continue;
        done[cur] = 1;
        if (type[cur] === 2) { goal = cur; break; }
        const cx = cur % W, cz = (cur / W) | 0;
        for (const [dx, dz] of MTN_DIRS) {
            const nx = cx + dx, nz = cz + dz;
            if (nx < 0 || nz < 0 || nx >= W || nz >= W) continue;
            const ni = nz * W + nx;
            if (done[ni] || sample(ni) === 3) continue;
            const L = Math.sqrt(dx * dx + dz * dz) * MTN_GRID;
            const g = Math.abs(hs[ni] - hs[cur]) / L;
            const cost = L * (1 + 0.5 * g + 80 * Math.max(0, g - MTN_GRADE));
            if (dist[cur] + cost < dist[ni]) {
                dist[ni] = dist[cur] + cost;
                parent[ni] = cur;
                heap.push(ni, dist[ni]);
            }
        }
    }
    if (goal < 0) return null;

    // 网格路径（parent 链从山脚指回山顶，正好是山脚 -> 山顶的顺序）
    let line: number[] = [];
    for (let i = goal; i >= 0; i = parent[i]) {
        line.push(peak.x + (i % W - R) * MTN_GRID, peak.z + (((i / W) | 0) - R) * MTN_GRID);
    }
    // Chaikin 平滑两次（保留两端）
    for (let it = 0; it < 2; it++) {
        const out = [line[0], line[1]];
        for (let i = 0; i + 3 < line.length; i += 2) {
            const ax = line[i], az = line[i + 1], bx = line[i + 2], bz = line[i + 3];
            out.push(ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25, ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75);
        }
        out.push(line[line.length - 2], line[line.length - 1]);
        line = out;
    }
    // 按 MTN_SAMPLE 米重采样
    const xs: number[] = [], zs: number[] = [];
    let carry = 0;
    xs.push(line[0]); zs.push(line[1]);
    for (let i = 0; i + 3 < line.length; i += 2) {
        const ax = line[i], az = line[i + 1], dx = line[i + 2] - ax, dz = line[i + 3] - az;
        const L = Math.sqrt(dx * dx + dz * dz);
        let s = MTN_SAMPLE - carry;
        for (; s <= L; s += MTN_SAMPLE) { xs.push(ax + dx * s / L); zs.push(az + dz * s / L); }
        carry = L - (s - MTN_SAMPLE);
    }
    xs.push(line[line.length - 2]); zs.push(line[line.length - 1]);
    // 路面高度：原始地形 -> 平滑 -> 从山脚往上夹坡度
    const m = xs.length;
    let ys = xs.map((x, i) => rawHeight(x, zs[i]));
    for (let it = 0; it < 4; it++) {
        const s = ys.slice();
        for (let i = 1; i < m - 1; i++) s[i] = ys[i - 1] * 0.25 + ys[i] * 0.5 + ys[i + 1] * 0.25;
        ys = s;
    }
    ys[0] = Math.max(ys[0], WALK_MIN_Y);
    for (let i = 1; i < m; i++) {
        const d = Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]) * MTN_GRADE;
        ys[i] = Math.min(Math.max(ys[i], ys[i - 1] - d), ys[i - 1] + d);
    }
    // 路面与原始地形差太多（山顶附近找不到足够长的缓坡）的地方不再往上修，避免挖出很深的沟
    // 平滑后之字形的两段可能挨得太近甚至交叉（高度不同），那里地面没法同时贴合两段路面，也在这里结束
    const out: number[] = [];
    for (let i = 0; i < m; i++) {
        if (i > 0 && Math.abs(rawHeight(xs[i], zs[i]) - ys[i]) > MTN_MAX_CUT) break;
        let clash = false;
        for (let j = 0; j < i && !clash; j++) {
            const d = Math.hypot(xs[i] - xs[j], zs[i] - zs[j]);
            // 沿路距离远大于直线距离：是另一段路
            clash = d < MTN_GAP && (i - j) * MTN_SAMPLE > 2 * d + 6 && Math.abs(ys[i] - ys[j]) > 0.5;
        }
        if (clash) break;
        out.push(xs[i], zs[i], ys[i]);
    }
    return out;
}

/** 山峰位置：从采样点出发，按 4 米步长爬到局部最高处 */
function climbToPeak(x: number, z: number): P {
    let h = rawHeight(x, z);
    for (let it = 0; it < 16; it++) {
        let bx = x, bz = z;
        for (const [dx, dz] of MTN_DIRS) {
            if (Math.abs(dx) > 1 || Math.abs(dz) > 1) break;   // 只用前 8 个方向
            const hh = rawHeight(x + dx * 4, z + dz * 4);
            if (hh > h) { h = hh; bx = x + dx * 4; bz = z + dz * 4; }
        }
        if (bx === x && bz === z) break;
        x = bx; z = bz;
    }
    return { x, z };
}

const mtnTrailCache = new Map<number, number[][]>();
/** 大区 (rx,rz) 内的山路（每条是 x,z,y 三元组，山脚 -> 山顶） */
function regionMountainTrails(rx: number, rz: number): number[][] {
    return cached(mtnTrailCache, regionKey(rx, rz), 1024, () => {
        const cands: { x: number; z: number; m: number }[] = [];
        const x0 = (rx - 0.5) * REGION + PEAK_STEP / 2, z0 = (rz - 0.5) * REGION + PEAK_STEP / 2;
        for (let z = z0; z < (rz + 0.5) * REGION; z += PEAK_STEP) {
            for (let x = x0; x < (rx + 0.5) * REGION; x += PEAK_STEP) {
                const m = mountainHeight(x, z, terrainNoise(x, z));
                if (m >= PEAK_MIN) cands.push({ x, z, m });
            }
        }
        cands.sort((a, b) => b.m - a.m);
        const peaks: P[] = [];
        for (const c of cands) {
            if (peaks.length >= PEAKS_PER_REGION) break;
            if (peaks.some(p => Math.hypot(p.x - c.x, p.z - c.z) < PEAK_SPACING)) continue;
            peaks.push(climbToPeak(c.x, c.z));
        }
        const out: number[][] = [];
        for (const p of peaks) {
            const t = planMountainTrail(p);
            if (t && t.length >= 6) out.push(t);
        }
        return out;
    });
}

const mtnSegCache = new Map<number, Float64Array>();
/**
 * 可能影响块 (cx,cz) 的山路线段，每段 6 个数 ax,az,ay,bx,bz,by。
 * 山路离候选采样点最远约 MTN_GRID_R × MTN_GRID × √2 + 爬峰偏移 64 ≈ 315 米，小于一个大区（512 米），
 * 所以隔两个大区的山路碰不到本块，看周围 3x3 个大区就够了
 */
function mountainSegsNearChunk(cx: number, cz: number): Float64Array {
    return cached(mtnSegCache, regionKey(cx, cz), 4096, () => {
        const x0 = cx * CHUNK_SIZE - MTN_FALL, x1 = (cx + 1) * CHUNK_SIZE + MTN_FALL;
        const z0 = cz * CHUNK_SIZE - MTN_FALL, z1 = (cz + 1) * CHUNK_SIZE + MTN_FALL;
        const rx = Math.round((cx + 0.5) * CHUNK_SIZE / REGION), rz = Math.round((cz + 0.5) * CHUNK_SIZE / REGION);
        const out: number[] = [];
        for (let j = -1; j <= 1; j++) {
            for (let i = -1; i <= 1; i++) {
                for (const t of regionMountainTrails(rx + i, rz + j)) {
                    for (let k = 0; k + 5 < t.length; k += 3) {
                        const ax = t[k], az = t[k + 1], bx = t[k + 3], bz = t[k + 4];
                        if (Math.max(ax, bx) < x0 || Math.min(ax, bx) > x1 || Math.max(az, bz) < z0 || Math.min(az, bz) > z1) continue;
                        out.push(ax, az, t[k + 2], bx, bz, t[k + 5]);
                    }
                }
            }
        }
        return new Float64Array(out);
    });
}

/**
 * nearestMountainTrail 的结果：
 * nearD：到最近山路中心线的距离（米）；
 * nearF：地面压向路面的程度（0~1，取各线段的最大值）；
 * nearY：路面高度，按 1/(d⁴+0.05) 加权平均附近各线段的高度。
 * 之字形相邻的两段路离得很近时，中间的地面在两段的高度之间平滑过渡，不会因为“最近的线段”切换而出现台阶；
 * 站在某段路的中心线上时权重几乎全在这段上，路面就是它自己的高度
 */
let nearD = Infinity, nearY = 0, nearF = 0;
function nearestMountainTrail(s: Float64Array, x: number, z: number): boolean {
    let best = Infinity, wSum = 0, ySum = 0, f = 0;
    for (let i = 0; i < s.length; i += 6) {
        const ax = s[i], az = s[i + 1], dx = s[i + 3] - ax, dz = s[i + 4] - az;
        if (Math.min(ax, ax + dx) - x > MTN_FALL || x - Math.max(ax, ax + dx) > MTN_FALL ||
            Math.min(az, az + dz) - z > MTN_FALL || z - Math.max(az, az + dz) > MTN_FALL) continue;
        const len2 = dx * dx + dz * dz;
        let t = len2 > 0 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = ax + dx * t - x, ez = az + dz * t - z;
        const d2 = ex * ex + ez * ez;
        if (d2 < best) best = d2;
        if (d2 >= MTN_FALL * MTN_FALL) continue;
        const fi = 1 - smoothstep(MTN_FLAT, MTN_FALL, Math.sqrt(d2));
        const w = fi / (d2 * d2 + 0.05);
        wSum += w;
        ySum += w * (s[i + 2] + (s[i + 5] - s[i + 2]) * t);
        if (fi > f) f = fi;
    }
    nearD = Math.sqrt(best);
    nearF = f;
    nearY = wSum > 0 ? ySum / wSum : 0;
    return f > 0;
}

class MinHeap {
    private idx: number[] = [];
    private key: number[] = [];
    get size() { return this.idx.length; }
    push(i: number, k: number) {
        const a = this.idx, b = this.key;
        let n = a.length;
        a.push(i); b.push(k);
        while (n > 0) {
            const p = (n - 1) >> 1;
            if (b[p] <= k) break;
            a[n] = a[p]; b[n] = b[p];
            n = p;
        }
        a[n] = i; b[n] = k;
    }
    pop(): number {
        const a = this.idx, b = this.key;
        const top = a[0];
        const li = a.pop()!, lk = b.pop()!;
        const len = a.length;
        if (len > 0) {
            let n = 0;
            for (; ;) {
                let c = 2 * n + 1;
                if (c >= len) break;
                if (c + 1 < len && b[c + 1] < b[c]) c++;
                if (b[c] >= lk) break;
                a[n] = a[c]; b[n] = b[c];
                n = c;
            }
            a[n] = li; b[n] = lk;
        }
        return top;
    }
}

/**
 * 离 (wx,wz) 最近的山路终点（山路的最高处，世界坐标），在周围 5x5 个大区里找；没有山路返回 null。
 * exclude：跳过离这些点 20 米以内的终点（去过的山顶）；
 * minTopY：只要路面最高处不低于这个高度（米）的山路，半路截断的矮山路不算山顶
 */
export function nearestMountainTop(wx: number, wz: number, exclude: P[] = [], minTopY = 15): P | null {
    const rx = Math.round(wx / REGION), rz = Math.round(wz / REGION);
    let best: P | null = null, bestD = Infinity;
    for (let j = -2; j <= 2; j++) {
        for (let i = -2; i <= 2; i++) {
            for (const t of regionMountainTrails(rx + i, rz + j)) {
                const x = t[t.length - 3], z = t[t.length - 2];
                if (t[t.length - 1] < minTopY) continue;
                if (exclude.some(e => Math.hypot(x - e.x, z - e.z) < 20)) continue;
                const d = Math.hypot(x - wx, z - wz);
                if (d < bestD) { bestD = d; best = { x, z }; }
            }
        }
    }
    return best;
}

/** 山路路面半宽（米），渲染时用来画路面边缘 */
export const MOUNTAIN_TRAIL_HALF = MTN_HALF;

/** 块 (cx,cz) 附近（MTN_FALL 米内）有没有山路 */
export function chunkHasMountainTrail(cx: number, cz: number): boolean {
    return mountainSegsNearChunk(cx, cz).length > 0;
}

/** 到最近山路中心线的距离（米）；MTN_FALL 米内没有山路时返回 Infinity */
export function mountainTrailDistance(wx: number, wz: number): number {
    const segs = mountainSegsNearChunk(Math.floor(wx / CHUNK_SIZE), Math.floor(wz / CHUNK_SIZE));
    if (segs.length === 0) return Infinity;
    nearestMountainTrail(segs, wx, wz);
    return nearD;
}

/**
 * 山路格子下面原本的地面类型（渲染用：山路画成连续的砂石带，格子本身按原来的地面画）。
 * 只返回 Mountain / Sand / Grass，不返回会画出模型的类型（石头、树）
 */
export function trailGroundKind(wx: number, wz: number): number {
    const n = terrainNoise(wx, wz);
    if (mountainHeight(wx, wz, n) > MOUNTAIN_CELL_MIN) return Cell.Mountain;
    return n < SAND_NOISE ? Cell.Sand : Cell.Grass;
}

/** 是否在主干道/小路的路面上（不含山路） */
export function onRegularRoad(wx: number, wz: number): boolean {
    for (const r of roadsNearChunk(Math.floor(wx / CHUNK_SIZE), Math.floor(wz / CHUNK_SIZE))) {
        if (lineDistance(r, wx, wz, r.style.half) <= r.style.half) return true;
    }
    return false;
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
    const mtnSegs = mountainSegsNearChunk(cx, cz);

    // 1. 地形 + 道路
    for (let lz = 0; lz < N; lz++) {
        for (let lx = 0; lx < N; lx++) {
            const gx = gx0 + lx, gz = gz0 + lz;
            const wx = (gx + 0.5) * CELL, wz = (gz + 0.5) * CELL;
            const n = terrainNoise(wx, wz);
            let kind: number = Cell.Grass;
            if (mountainHeight(wx, wz, n) > MOUNTAIN_CELL_MIN) kind = Cell.Mountain;
            else if (n < WATER_NOISE) kind = Cell.Water;
            else if (n < SAND_NOISE) kind = Cell.Sand;
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
            // 山路：穿过山体、树、石头直接开路（规划时已避开水面）
            if (kind !== Cell.Road && kind !== Cell.Bridge && kind !== Cell.Water &&
                mtnSegs.length > 0 && nearestMountainTrail(mtnSegs, wx, wz) && nearD <= MTN_HALF) {
                kind = Cell.Road;
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
