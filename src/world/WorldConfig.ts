/** 世界的全局参数 */
export const SEED = 20261104;

/** 寻路格子边长（米） */
export const CELL = 2;
/** 每个块的边长（格子数） */
export const CHUNK_CELLS = 32;
/** 每个块的边长（米） */
export const CHUNK_SIZE = CELL * CHUNK_CELLS;

/** 以玩家所在块为中心，最多考虑加载半径内的块（2 => 5x5）；其中只加载距离不超过 LOAD_DIST 的 */
export const LOAD_RADIUS = 2;
/**
 * 玩家到块（最近的边）的距离（米）不超过 LOAD_DIST 才加载，超过 UNLOAD_DIST 就卸载。
 * 雾在 145 米处全白，再远的块看不见，不用留在显存里；两个值差 16 米，在边界来回走不会反复加载。
 * LOAD_DIST 不能超过 LOAD_RADIUS × CHUNK_SIZE
 */
export const LOAD_DIST = 128;
export const UNLOAD_DIST = 144;
/**
 * 远处的块用简化版网格（省显存）：距离小于 LOD_NEAR_DIST 换成完整版，大于 LOD_FAR_DIST 换成简化版，
 * 两者之间保持原样（避免来回走时反复重建）；新加载的块按 LOD_BUILD_DIST 决定
 */
export const LOD_NEAR_DIST = 56;
export const LOD_BUILD_DIST = 72;
export const LOD_FAR_DIST = 88;
/** 寻路数据保留半径（块）。寻路数据很小，可以比画面保留得更远 */
export const NAV_KEEP_RADIUS = 8;

/** 格子类型 */
export const Cell = {
    Grass: 0,
    Sand: 1,
    Road: 2,
    Bridge: 3,
    Water: 4,
    Rock: 5,
    Tree: 6,
    /** 生成后与道路不连通的空地会被填成灌木，保证剩下的可走区域全部连通 */
    Bush: 7,
    /** 树被砍掉后留下的树桩，可以通行 */
    Stump: 8,
    /** 山体（地形本身隆起，不可通行） */
    Mountain: 9,
} as const;

const WALKABLE = [true, true, true, true, false, false, false, false, true, false];

export function isWalkableKind(kind: number): boolean {
    return WALKABLE[kind] === true;
}

/** 可以被砍掉的格子，以及砍掉后变成什么 */
export function chopResult(kind: number): number | null {
    if (kind === Cell.Tree) return Cell.Stump;
    if (kind === Cell.Bush) return Cell.Grass;
    return null;
}

export function chunkKey(cx: number, cz: number): number {
    return (cx + 32768) * 65536 + (cz + 32768);
}
