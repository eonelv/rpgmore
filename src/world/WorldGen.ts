import { fbm, hash2, ridgedFbm } from "./Noise";
import { CELL, CHUNK_CELLS, CHUNK_SIZE, Cell, SEED, isWalkableKind } from "./WorldConfig";

/**
 * 程序化世界生成（纯函数，确定性）。
 *
 * 连通性保证：
 * 1. 每个块有一个“道路节点”，相邻（上下左右）块的节点之间都修一条路。
 *    路遇到水变成桥、遇到岩石/树直接开路，因此所有道路节点构成一张全连通的网格图。
 * 2. 每个块生成后，从该块的道路格子做 4 向洪水填充，
 *    与道路不连通的可走格子会被填成灌木（阻挡）。
 * => 世界中任意两个可走格子之间一定存在路径，
 *    而且路径只需经过“起点块与终点块围成的矩形”内的块。寻路依赖这一点来限制搜索范围。
 */

export const WATER_Y = -2.0;
/** 桥面/道路的最低高度 */
export const WALK_MIN_Y = WATER_Y + 0.15;

/** 地形原始噪声 [0,1) */
export function terrainNoise(wx: number, wz: number): number {
    return fbm(wx / 140, wz / 140, 4, SEED);
}

function smoothstep(a: number, b: number, x: number): number {
    const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
    return t * t * (3 - 2 * t);
}

/** 山峰最大高度（米，叠加在基础地形之上） */
const MOUNTAIN_HEIGHT = 42;
/** 山体高度超过这个值（米）的格子是不可走的山 */
export const MOUNTAIN_CELL_MIN = 2.2;
/** 道路两侧的山谷：距道路中心 ROAD_VALLEY_IN 米内山体压到最低，到 ROAD_VALLEY_OUT 米恢复原高 */
const ROAD_VALLEY_IN = 3;
const ROAD_VALLEY_OUT = 12;   // 不能超过 12 米，见 roadDistance 的说明
/** 道路中心保留的山体比例（山口略微隆起，而不是完全平的峡谷） */
const ROAD_KEEP = 0.04;

/** 山体高度（米），没有山的地方为 0。n 为 terrainNoise 的值 */
export function mountainHeight(wx: number, wz: number, n: number): number {
    // 山区分布（低频）；低洼处（湖泊、沙滩）不长山，水体判定保持不变
    const mask = smoothstep(0.42, 0.58, fbm(wx / 240, wz / 240, 3, SEED + 900)) * smoothstep(0.40, 0.50, n);
    if (mask <= 0) return 0;
    const ridge = ridgedFbm(wx / 110, wz / 110, 5, SEED + 700);
    let m = mask * (0.1 + ridge * ridge * 1.1) * MOUNTAIN_HEIGHT;
    // 道路切开山体形成山谷，保证道路网仍然全连通
    const d = roadDistance(wx, wz);
    if (d < ROAD_VALLEY_OUT) m *= ROAD_KEEP + (1 - ROAD_KEEP) * smoothstep(ROAD_VALLEY_IN, ROAD_VALLEY_OUT, d);
    return m;
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

/** 块 (cx,cz) 的道路节点（全局格子坐标）。离块边缘至少 6 格，保证路只经过相邻的两个块 */
export function roadNode(cx: number, cz: number): { gx: number; gz: number } {
    const span = CHUNK_CELLS - 12;
    return {
        gx: cx * CHUNK_CELLS + 6 + Math.floor(hash2(cx, cz, SEED + 11) * span),
        gz: cz * CHUNK_CELLS + 6 + Math.floor(hash2(cx, cz, SEED + 23) * span),
    };
}

const nodeCache = new Map<number, { wx: number; wz: number }>();
/** 道路节点中心的世界坐标（带缓存，terrainHeight 调用很频繁） */
function roadNodeWorld(cx: number, cz: number): { wx: number; wz: number } {
    const key = (cx + 32768) * 65536 + (cz + 32768);
    let p = nodeCache.get(key);
    if (!p) {
        if (nodeCache.size > 4096) nodeCache.clear();
        const n = roadNode(cx, cz);
        p = { wx: (n.gx + 0.5) * CELL, wz: (n.gz + 0.5) * CELL };
        nodeCache.set(key, p);
    }
    return p;
}

function segDist2(px: number, pz: number, a: { wx: number; wz: number }, b: { wx: number; wz: number }): number {
    const dx = b.wx - a.wx, dz = b.wz - a.wz;
    const len2 = dx * dx + dz * dz;
    let t = len2 > 0 ? ((px - a.wx) * dx + (pz - a.wz) * dz) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = a.wx + dx * t - px, ez = a.wz + dz * t - pz;
    return ex * ex + ez * ez;
}

/**
 * 到最近道路中心线的距离（米）。只检查所在块周围 3x3 块之间的 12 段路：
 * 道路节点离块边缘至少 6 格（12 米），更远的路段离本块至少 12 米，
 * 所以只要 ROAD_VALLEY_OUT <= 12，结果在块边界上也是连续的。
 */
function roadDistance(wx: number, wz: number): number {
    const cx = Math.floor(wx / CHUNK_SIZE), cz = Math.floor(wz / CHUNK_SIZE);
    let best = Infinity;
    for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
            const a = roadNodeWorld(cx + i, cz + j);
            if (i < 1) best = Math.min(best, segDist2(wx, wz, a, roadNodeWorld(cx + i + 1, cz + j)));
            if (j < 1) best = Math.min(best, segDist2(wx, wz, a, roadNodeWorld(cx + i, cz + j + 1)));
        }
    }
    return Math.sqrt(best);
}

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

export function generateChunk(cx: number, cz: number): ChunkData {
    const data = new ChunkData(cx, cz);
    const k = data.kinds;
    const gx0 = cx * CHUNK_CELLS, gz0 = cz * CHUNK_CELLS;

    // 1. 基础地形
    for (let lz = 0; lz < CHUNK_CELLS; lz++) {
        for (let lx = 0; lx < CHUNK_CELLS; lx++) {
            const gx = gx0 + lx, gz = gz0 + lz;
            const wx = (gx + 0.5) * CELL, wz = (gz + 0.5) * CELL;
            const n = terrainNoise(wx, wz);
            let kind: number = Cell.Grass;
            if (mountainHeight(wx, wz, n) > MOUNTAIN_CELL_MIN) kind = Cell.Mountain;
            else if (n < 0.36) kind = Cell.Water;
            else if (n < 0.395) kind = Cell.Sand;
            else if (n > 0.66) kind = Cell.Rock;
            else {
                const forest = fbm(wx / 70, wz / 70, 3, SEED + 500);
                const r = hash2(gx, gz, SEED + 7);
                if (forest > 0.56 && r < 0.45) kind = Cell.Tree;
                else if (r < 0.025) kind = Cell.Rock;   // 零散的石头
                else if (r < 0.06) kind = Cell.Tree;    // 零散的树
            }
            k[lz * CHUNK_CELLS + lx] = kind;
        }
    }

    // 2. 道路：本块节点 <-> 四个相邻块的节点
    const me = roadNode(cx, cz);
    const neighbors = [roadNode(cx + 1, cz), roadNode(cx - 1, cz), roadNode(cx, cz + 1), roadNode(cx, cz - 1)];
    for (const nb of neighbors) carveRoad(data, me.gx, me.gz, nb.gx, nb.gz);

    // 3. 连通性修正：从道路出发 4 向洪水填充，不连通的可走格子 -> 灌木
    const N = CHUNK_CELLS;
    const visited = new Uint8Array(N * N);
    const queue = new Int32Array(N * N);
    let head = 0, tail = 0;
    for (let i = 0; i < N * N; i++) {
        if (k[i] === Cell.Road || k[i] === Cell.Bridge) { visited[i] = 1; queue[tail++] = i; }
    }
    while (head < tail) {
        const i = queue[head++];
        const lx = i % N, lz = (i / N) | 0;
        if (lx > 0) tryVisit(i - 1);
        if (lx < N - 1) tryVisit(i + 1);
        if (lz > 0) tryVisit(i - N);
        if (lz < N - 1) tryVisit(i + N);
    }
    function tryVisit(j: number) {
        if (!visited[j] && isWalkableKind(k[j])) { visited[j] = 1; queue[tail++] = j; }
    }
    for (let i = 0; i < N * N; i++) {
        if (!visited[i] && isWalkableKind(k[i])) k[i] = Cell.Bush;
    }
    return data;
}

/** 把线段 (ax,az)-(bx,bz)（全局格子坐标）附近 1 格内的格子开成道路，只处理落在本块内的部分 */
function carveRoad(data: ChunkData, ax: number, az: number, bx: number, bz: number) {
    const gx0 = data.cx * CHUNK_CELLS, gz0 = data.cz * CHUNK_CELLS;
    const minX = Math.max(Math.min(ax, bx) - 1, gx0), maxX = Math.min(Math.max(ax, bx) + 1, gx0 + CHUNK_CELLS - 1);
    const minZ = Math.max(Math.min(az, bz) - 1, gz0), maxZ = Math.min(Math.max(az, bz) + 1, gz0 + CHUNK_CELLS - 1);
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz;
    for (let gz = minZ; gz <= maxZ; gz++) {
        for (let gx = minX; gx <= maxX; gx++) {
            let t = len2 > 0 ? ((gx - ax) * dx + (gz - az) * dz) / len2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const px = ax + dx * t - gx, pz = az + dz * t - gz;
            if (px * px + pz * pz <= 1.0) {
                const i = (gz - gz0) * CHUNK_CELLS + (gx - gx0);
                data.kinds[i] = data.kinds[i] === Cell.Water ? Cell.Bridge : Cell.Road;
            }
        }
    }
}
