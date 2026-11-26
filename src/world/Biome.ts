import { fbm } from "./Noise";
import { SEED } from "./WorldConfig";

/**
 * 区域布局（只决定"哪里是哪个区域、什么地貌"，不含名字；名字见 Areas.ts）。
 *
 * 世界由"世界单元"向四面无限平铺，每个单元 UNIT = 5 × AREA 米见方，单元 (ux,uz) 的中心在 (ux·UNIT, uz·UNIT)：
 *
 *            北域（整条上边）
 *   西域  栖霞谷  苍龙岭  迷雾林  东域
 *   西域  落日原  长风原  明月湖  东域        长风原 = 出生地
 *   西域  乱石林  赤枫丘  落星泽  东域
 *            南域（整条下边）
 *
 * - 中间 3×3 个区域，每个 AREA 米见方；外圈是四个域，南北域占满整条上下边（角上归南北域）。
 * - 单元之间的接缝两侧各 SEAM_HALF 米是"界山"：北域的雪原和南域的雨林、东域的海和西域的大漠之间隔着一道山脉。
 * - 所有分界都在"扭曲坐标"里是直线：世界坐标先加上一个低频噪声偏移（一般 ±100 米，最多 ±220 米），
 *   所以在世界里分界线是弯曲的，不是方格。
 * - 地貌过渡：扭曲坐标里每 LAT 米一个格点，格点取所在区域的地貌，四个格点按 smoothstep 插值，
 *   分界两侧各约 LAT/2 米内两种地貌混合。所有分界线都落在格线上，所以过渡带正好以分界线为中心。
 *
 * 北 = -Z，东 = +X，和小地图一致。
 */

/** 一个区域的边长（米），等于 3 个道路大区 */
export const AREA = 1536;
/** 世界单元的边长（米） */
export const UNIT = 5 * AREA;
/** 界山的半宽（米）：离单元接缝这么近的地方是界山 */
export const SEAM_HALF = 256;
/** 地貌过渡格点的间距（米）。AREA、UNIT / 2、SEAM_HALF 都必须是它的整数倍 */
const LAT = 128;

/**
 * 区域边界扭曲：噪声波长（米）和最大偏移（米）。
 * 偏移的变化率不能太大（2 × AMP × 噪声最大斜率 2 / SCALE 要明显小于 1），否则坐标会折叠，分界线上出现飞地
 */
const WARP_SCALE = 1400;
const WARP_AMP = 220;

/** 地貌种类 */
export const Biome = {
    /** 平原（长风原） */
    Plain: 0,
    /** 湖泊（明月湖） */
    Lake: 1,
    /** 高山（苍龙岭） */
    Peak: 2,
    /** 密林（迷雾林） */
    Forest: 3,
    /** 山谷（栖霞谷） */
    Valley: 4,
    /** 荒原（落日原） */
    Waste: 5,
    /** 石林（乱石林） */
    Stone: 6,
    /** 秋色丘陵（赤枫丘） */
    Maple: 7,
    /** 沼泽（落星泽） */
    Swamp: 8,
    /** 北域：雪原枯木 */
    North: 9,
    /** 东域：沧海群岛 */
    East: 10,
    /** 南域：南疆雨林 */
    South: 11,
    /** 西域：大漠戈壁 */
    West: 12,
    /** 界山：单元之间的山脉 */
    Seam: 13,
} as const;
export const BIOME_COUNT = 14;

/**
 * 区域在单元里的位置：0~8 是中间 3×3（下标 = (az+1)×3 + (ax+1)，ax/az ∈ -1..1），
 * 9~12 是四个域，13/14 是单元东边 / 南边的界山
 */
export const Slot = { North: 9, South: 10, East: 11, West: 12, SeamX: 13, SeamZ: 14 } as const;

/** 中间 3×3 个区域的地貌（按 Slot 下标） */
const CENTER_BIOMES = [
    Biome.Valley, Biome.Peak, Biome.Forest,
    Biome.Waste, Biome.Plain, Biome.Lake,
    Biome.Stone, Biome.Maple, Biome.Swamp,
];
const SLOT_BIOMES = [...CENTER_BIOMES, Biome.North, Biome.South, Biome.East, Biome.West, Biome.Seam, Biome.Seam];

/**
 * 一个区域。
 * key：区域的唯一编号（同一个区域在任何位置算出来都一样）；
 * ux/uz：所在单元（界山是接缝西边 / 北边的那个单元）
 */
export interface AreaRef { key: number; biome: number; slot: number; ux: number; uz: number; }

export function newAreaRef(): AreaRef {
    return { key: 0, biome: 0, slot: 0, ux: 0, uz: 0 };
}

/** 区域编号：单元坐标 ±4096 以内不会冲突（约 ±3 万公里） */
function areaKey(ux: number, uz: number, slot: number): number {
    return ((ux + 4096) * 8192 + (uz + 4096)) * 16 + slot;
}

/** 是不是出生所在的那个单元里的区域（界山不算） */
export function isHomeArea(a: AreaRef): boolean {
    return a.ux === 0 && a.uz === 0 && a.slot < Slot.SeamX;
}

// ==================== 扭曲坐标 ====================

/** warp / unwarp 的结果（避免每次分配对象） */
export const warped = { x: 0, z: 0 };

function offsetX(wx: number, wz: number): number {
    return (fbm(wx / WARP_SCALE, wz / WARP_SCALE, 2, SEED + 11) - 0.5) * 2 * WARP_AMP;
}
function offsetZ(wx: number, wz: number): number {
    return (fbm(wx / WARP_SCALE, wz / WARP_SCALE, 2, SEED + 13) - 0.5) * 2 * WARP_AMP;
}

/**
 * 扭曲偏移的缓存：偏移按 WARP_GRID 米的网格采样，格子内双线性插值（偏移的波长 1400 米，插值误差远小于 1 米）。
 * 直接映射的缓存，每个槽存一个格子四个角的 x/z 偏移
 */
const WARP_GRID = 32;
const WC_BITS = 12, WC_SIZE = 1 << WC_BITS;
const wcKeyX = new Int32Array(WC_SIZE).fill(0x7fffffff);
const wcKeyZ = new Int32Array(WC_SIZE);
const wcVal = new Float32Array(WC_SIZE * 8);

/** 世界坐标 -> 扭曲坐标，结果写到 warped */
export function warp(wx: number, wz: number): void {
    const gx = wx / WARP_GRID, gz = wz / WARP_GRID;
    const ix = Math.floor(gx), iz = Math.floor(gz);
    const slot = ((ix * 73856093) ^ (iz * 19349663)) & (WC_SIZE - 1);
    const o = slot * 8;
    if (wcKeyX[slot] !== ix || wcKeyZ[slot] !== iz) {
        wcKeyX[slot] = ix; wcKeyZ[slot] = iz;
        const x0 = ix * WARP_GRID, z0 = iz * WARP_GRID, x1 = x0 + WARP_GRID, z1 = z0 + WARP_GRID;
        wcVal[o] = offsetX(x0, z0); wcVal[o + 1] = offsetX(x1, z0); wcVal[o + 2] = offsetX(x0, z1); wcVal[o + 3] = offsetX(x1, z1);
        wcVal[o + 4] = offsetZ(x0, z0); wcVal[o + 5] = offsetZ(x1, z0); wcVal[o + 6] = offsetZ(x0, z1); wcVal[o + 7] = offsetZ(x1, z1);
    }
    const tx = gx - ix, tz = gz - iz;
    const a = wcVal[o] + (wcVal[o + 1] - wcVal[o]) * tx, b = wcVal[o + 2] + (wcVal[o + 3] - wcVal[o + 2]) * tx;
    const c = wcVal[o + 4] + (wcVal[o + 5] - wcVal[o + 4]) * tx, d = wcVal[o + 6] + (wcVal[o + 7] - wcVal[o + 6]) * tx;
    warped.x = wx + a + (b - a) * tz;
    warped.z = wz + c + (d - c) * tz;
}

/** 扭曲坐标 -> 世界坐标（迭代求逆，误差远小于 1 米，只用来摆小地图上的文字），结果写到 warped */
export function unwarp(x: number, z: number): void {
    let wx = x, wz = z;
    for (let i = 0; i < 6; i++) {
        const nx = x - offsetX(wx, wz), nz = z - offsetZ(wx, wz);
        wx = nx; wz = nz;
    }
    warped.x = wx;
    warped.z = wz;
}

// ==================== 区域判定 ====================

/** 扭曲坐标 (x,z) 所在的区域，写到 out */
export function areaOfWarped(x: number, z: number, out: AreaRef): AreaRef {
    const ux = Math.round(x / UNIT), uz = Math.round(z / UNIT);
    const lx = x - ux * UNIT, lz = z - uz * UNIT;
    const dx = UNIT / 2 - Math.abs(lx), dz = UNIT / 2 - Math.abs(lz);
    let slot: number, kx = ux, kz = uz;
    if (dx < SEAM_HALF || dz < SEAM_HALF) {
        // 界山归接缝西边 / 北边的单元；角上按离哪条接缝近算
        if (dx <= dz) { slot = Slot.SeamX; if (lx < 0) kx = ux - 1; }
        else { slot = Slot.SeamZ; if (lz < 0) kz = uz - 1; }
    } else if (Math.abs(lz) >= 1.5 * AREA) {
        slot = lz < 0 ? Slot.North : Slot.South;
    } else if (Math.abs(lx) >= 1.5 * AREA) {
        slot = lx > 0 ? Slot.East : Slot.West;
    } else {
        slot = (Math.round(lz / AREA) + 1) * 3 + Math.round(lx / AREA) + 1;
    }
    out.key = areaKey(kx, kz, slot);
    out.biome = SLOT_BIOMES[slot];
    out.slot = slot;
    out.ux = kx;
    out.uz = kz;
    return out;
}

/** 世界坐标 (wx,wz) 所在的区域，写到 out */
export function areaOf(wx: number, wz: number, out: AreaRef): AreaRef {
    warp(wx, wz);
    return areaOfWarped(warped.x, warped.z, out);
}

/**
 * 区域在扭曲坐标里的范围 [x0, z0, x1, z1]（界山是整条接缝）。
 * 用来枚举区域里的小地名、摆小地图上的文字
 */
export function areaBoxWarped(a: AreaRef): number[] {
    const cx = a.ux * UNIT, cz = a.uz * UNIT, H = UNIT / 2, C = 1.5 * AREA;
    switch (a.slot) {
        case Slot.North: return [cx - H, cz - H, cx + H, cz - C];
        case Slot.South: return [cx - H, cz + C, cx + H, cz + H];
        case Slot.East: return [cx + C, cz - C, cx + H, cz + C];
        case Slot.West: return [cx - H, cz - C, cx - C, cz + C];
        case Slot.SeamX: return [cx + H - SEAM_HALF, cz - H, cx + H + SEAM_HALF, cz + H];
        case Slot.SeamZ: return [cx - H, cz + H - SEAM_HALF, cx + H, cz + H + SEAM_HALF];
        default: {
            const ax = a.slot % 3 - 1, az = Math.floor(a.slot / 3) - 1;
            return [cx + (ax - 0.5) * AREA, cz + (az - 0.5) * AREA, cx + (ax + 0.5) * AREA, cz + (az + 0.5) * AREA];
        }
    }
}

// ==================== 地貌过渡 ====================

function smooth(t: number): number {
    return t * t * (3 - 2 * t);
}

const tmpRef = newAreaRef();

/**
 * 世界坐标处各种地貌的权重（加起来是 1），写到 out（长度 BIOME_COUNT）。
 * 区域内部只有一种地貌；分界两侧各约 LAT/2 米内平滑过渡，是世界坐标的连续函数
 */
export function biomeWeights(wx: number, wz: number, out: Float32Array): Float32Array {
    out.fill(0);
    warp(wx, wz);
    const fx = warped.x / LAT - 0.5, fz = warped.z / LAT - 0.5;
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = smooth(fx - ix), tz = smooth(fz - iz);
    for (let j = 0; j <= 1; j++) {
        for (let i = 0; i <= 1; i++) {
            const w = (i ? tx : 1 - tx) * (j ? tz : 1 - tz);
            if (w <= 0) continue;
            areaOfWarped((ix + i + 0.5) * LAT, (iz + j + 0.5) * LAT, tmpRef);
            out[tmpRef.biome] += w;
        }
    }
    return out;
}

// ==================== 地貌参数（地形生成用） ====================

/** 地貌参数在参数向量里的下标 */
export const BP = {
    /** 加到地形噪声上的偏移：负数水多，正数水少（水面判定 WATER_NOISE 不变） */
    Water: 0,
    /** 保留小水坑的程度 0~1：0 = 细节噪声凹下去的小水坑全部填成沙地，1 = 全部保留（沼泽的碎水面） */
    Pond: 1,
    /** 叠加的细节噪声（波长 35 米）振幅，让水面变碎 */
    Detail: 2,
    /** 河网强度 0~1 */
    River: 3,
    /** 基础地形的起伏倍数（以水岸为基准缩放，水岸高度不变） */
    Relief: 4,
    /** 加到山区分布噪声上的偏移：正数山多 */
    MtnOff: 5,
    /** 山体高度倍数 */
    MtnMul: 6,
    /** 成片石林阈值（不含水面偏移的原始地形噪声大于它是石头） */
    RockTh: 7,
    /** 森林阈值（森林噪声大于它是林区）和林内树的密度 */
    ForestTh: 8,
    ForestDens: 9,
    /** 林区外零散石头、零散树的概率 */
    ScatterRock: 10,
    ScatterTree: 11,
    /** 沙地斑块阈值：斑块噪声小于它的陆地是沙地，0 = 没有斑块 */
    SandPatch: 12,
    /** 沙滩加宽：地形噪声在 [WATER_NOISE, SAND_NOISE + 它) 之间是沙地 */
    SandBand: 13,
    /** 主干道能修桥的最长水面（米），按大区枢纽处取值 */
    Bridge: 14,
    /** 每个大区修山路的山峰数，按大区枢纽处取值 */
    Peaks: 15,
} as const;
const BP_COUNT = 16;

/**
 * 每种地貌的参数（顺序同 BP）。阈值按噪声分布换算（见 docs/区域地貌实现文档.md 第 5 节）：
 * 例如明月湖水面约 65%，地形噪声 65% 分位约 0.556，偏移 ≈ 0.36 − 0.556 ≈ −0.20
 */
//                水     坑   细节  河   起伏  山偏   山倍  石林  林阈  林密  散石   散树   沙斑  沙宽  桥   山峰
const BIOME_PARAMS: number[][] = [
    /* 平原 */ [0.05, 0, 0, 0, 0.7, -0.22, 0.5, 0.76, 0.66, 0.45, 0.006, 0.05, 0, 0, 30, 2],
    /* 湖泊 */ [-0.25, 0.7, 0, 0, 0.8, -0.30, 0.3, 0.80, 0.62, 0.40, 0.008, 0.05, 0, 0.03, 120, 2],
    /* 高山 */ [0.02, 0, 0, 0, 1.0, 0.20, 1.5, 0.70, 0.56, 0.45, 0.025, 0.06, 0, 0, 30, 3],
    /* 密林 */ [0, 0, 0, 0, 1.0, -0.08, 0.6, 0.74, 0.38, 0.55, 0.015, 0.10, 0, 0, 30, 2],
    /* 山谷 */ [-0.02, 0, 0, 1, 1.0, 0.12, 0.75, 0.70, 0.54, 0.45, 0.02, 0.07, 0, 0, 30, 2],
    /* 荒原 */ [0.18, 0, 0, 0, 0.6, -0.35, 0.3, 0.74, 0.78, 0.25, 0.012, 0.015, 0.50, 0, 30, 2],
    /* 石林 */ [0.09, 0, 0, 0, 1.0, 0, 0.2, 0.47, 0.66, 0.30, 0.03, 0.03, 0, 0, 30, 2],
    /* 秋丘 */ [0.03, 0, 0, 0, 1.2, 0.05, 0.3, 0.72, 0.52, 0.50, 0.02, 0.07, 0, 0, 30, 2],
    /* 沼泽 */ [-0.16, 1, 0.12, 0, 0.4, -0.40, 0, 0.85, 0.60, 0.35, 0.005, 0.07, 0, 0, 50, 2],
    /* 北域 */ [0, 0, 0, 0, 1.0, 0.08, 1.1, 0.70, 0.66, 0.30, 0.03, 0.03, 0, 0, 30, 2],
    /* 东域 */ [-0.26, 0.3, 0, 0, 0.8, -0.30, 0.4, 0.80, 0.62, 0.40, 0.008, 0.05, 0, 0.04, 120, 2],
    /* 南域 */ [0.02, 0, 0, 1, 1.0, -0.10, 0.6, 0.76, 0.34, 0.55, 0.01, 0.10, 0, 0, 30, 2],
    /* 西域 */ [0.13, 0, 0, 0, 1.3, -0.40, 0, 0.80, 0.80, 0.20, 0.008, 0.003, 0.74, 0, 30, 2],
    /* 界山 */ [0.04, 0, 0, 0, 1.0, 0.35, 1.4, 0.72, 0.56, 0.45, 0.02, 0.05, 0, 0, 30, 2],
];
/** 扭曲坐标里格点 (ix,iz)（格子中心 (ix+0.5)·LAT）的地貌 */
function latticeBiome(ix: number, iz: number): number {
    return areaOfWarped((ix + 0.5) * LAT, (iz + 0.5) * LAT, tmpRef).biome;
}

/** 按地貌插值的一张参数表：每种地貌一行，out 是共享的结果数组，记住上次查询的位置 */
interface ParamSet { table: Float32Array; count: number; out: Float32Array; x: number; z: number; }

function makeParamSet(rows: number[][], count: number, name: string): ParamSet {
    if (rows.length !== BIOME_COUNT) throw new Error(`${name} 行数不对`);
    const table = new Float32Array(BIOME_COUNT * count);
    rows.forEach((row, b) => {
        if (row.length !== count) throw new Error(`${name}[${b}] 长度不对`);
        table.set(row, b * count);
    });
    return { table, count, out: new Float32Array(count), x: NaN, z: NaN };
}

function addRow(ps: ParamSet, b: number, w: number): void {
    if (w <= 0) return;
    const o = b * ps.count, out = ps.out, t = ps.table;
    for (let k = 0; k < ps.count; k++) out[k] += w * t[o + k];
}

/** 按和 biomeWeights 相同的四个格点插值；四个格点同一地貌时（区域内部）直接拷贝整行 */
function interpolate(ps: ParamSet, wx: number, wz: number): Float32Array {
    const out = ps.out;
    if (wx === ps.x && wz === ps.z) return out;
    ps.x = wx; ps.z = wz;
    warp(wx, wz);
    const fx = warped.x / LAT - 0.5, fz = warped.z / LAT - 0.5;
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const b00 = latticeBiome(ix, iz), b10 = latticeBiome(ix + 1, iz);
    const b01 = latticeBiome(ix, iz + 1), b11 = latticeBiome(ix + 1, iz + 1);
    if (b00 === b10 && b00 === b01 && b00 === b11) {
        out.set(ps.table.subarray(b00 * ps.count, (b00 + 1) * ps.count));
        return out;
    }
    const tx = smooth(fx - ix), tz = smooth(fz - iz);
    out.fill(0);
    addRow(ps, b00, (1 - tx) * (1 - tz));
    addRow(ps, b10, tx * (1 - tz));
    addRow(ps, b01, (1 - tx) * tz);
    addRow(ps, b11, tx * tz);
    return out;
}

const terrainSet = makeParamSet(BIOME_PARAMS, BP_COUNT, "BIOME_PARAMS");

/**
 * 世界坐标处的地形参数（下标见 BP），是世界坐标的连续函数。
 * 返回共享的数组，下次调用会被覆盖，要立刻读出来。连续两次查同一个点直接返回上次的结果
 */
export function biomeParams(wx: number, wz: number): Float32Array {
    return interpolate(terrainSet, wx, wz);
}

// ==================== 地貌外观（着色和植被用） ====================

/** 外观参数在参数向量里的下标 */
export const LP = {
    /** 平地草色 RGB（山上的草按同样比例变暗） */
    GrassR: 0, GrassG: 1, GrassB: 2,
    /** 沙地颜色 RGB */
    SandR: 3, SandG: 4, SandB: 5,
    /** 基础叶色 RGB（阔叶树、松树；灌木按它相对默认叶色的比例调色） */
    LeafR: 6, LeafG: 7, LeafB: 8,
    /** 雪线（米），很低的值 = 山上全是雪 */
    SnowLine: 9,
    /** 平地上松树的概率 = PineBase + PineStand × 松林噪声 */
    PineBase: 10, PineStand: 11,
    /** 不是松树时，各树种的相对权重：阔叶、红叶、枯树、柳树、棕榈（不靠水也长的） */
    Broad: 12, Red: 13, Dead: 14, Willow: 15, Palm: 16,
    /** 水边棕榈概率的倍数（0 = 水边不长棕榈） */
    PalmShore: 17,
    /** 挨着水的草地、沙地长芦苇的概率 */
    Reed: 18,
    /** 加到石头岩性上的偏移：正数砂岩多 */
    StrataBias: 19,
    /** 石头高度倍数 */
    StoneH: 20,
    /** 水面颜色：冰面程度、沼泽绿水程度（0~1） */
    Ice: 21, Murk: 22,
} as const;
const LP_COUNT = 23;

//                 草色               沙色               叶色              雪线  松基  松林  阔叶  红叶  枯树  柳树  棕榈  水棕  芦苇  砂岩  石高  冰  浊
const BIOME_LOOKS: number[][] = [
    /* 平原 */ [0.38, 0.65, 0.30, 0.86, 0.80, 0.55, 0.18, 0.45, 0.20, 24, 0.02, 0.40, 0.90, 0.10, 0, 0, 0, 1, 0, 0, 1, 0, 0],
    /* 湖泊 */ [0.32, 0.61, 0.38, 0.88, 0.83, 0.60, 0.18, 0.46, 0.24, 24, 0.02, 0.30, 0.40, 0, 0, 0.60, 0, 0.2, 0.35, 0, 1, 0, 0],
    /* 高山 */ [0.32, 0.56, 0.32, 0.80, 0.77, 0.58, 0.14, 0.38, 0.20, 18, 0.30, 0.60, 0.80, 0.20, 0, 0, 0, 0.5, 0, 0, 1, 0, 0],
    /* 密林 */ [0.24, 0.50, 0.24, 0.80, 0.76, 0.54, 0.11, 0.34, 0.15, 24, 0.25, 0.60, 0.85, 0.15, 0, 0, 0, 0.5, 0, 0, 1, 0, 0],
    /* 山谷 */ [0.40, 0.60, 0.30, 0.86, 0.79, 0.56, 0.16, 0.42, 0.20, 24, 0.05, 0.50, 0.30, 0.70, 0, 0, 0, 0.5, 0.1, 0, 1, 0, 0],
    /* 荒原 */ [0.66, 0.62, 0.34, 0.88, 0.76, 0.50, 0.42, 0.46, 0.20, 24, 0, 0.10, 0.50, 0, 0.50, 0, 0, 0.3, 0, 0.2, 1, 0, 0],
    /* 石林 */ [0.50, 0.58, 0.32, 0.86, 0.78, 0.54, 0.20, 0.42, 0.18, 24, 0.10, 0.40, 0.70, 0.30, 0, 0, 0, 0.5, 0, 0.45, 1.3, 0, 0],
    /* 秋丘 */ [0.62, 0.60, 0.28, 0.86, 0.79, 0.55, 0.70, 0.50, 0.14, 24, 0.02, 0.20, 0.40, 0.60, 0, 0, 0, 0.3, 0, 0, 1, 0, 0],
    /* 沼泽 */ [0.32, 0.42, 0.22, 0.62, 0.58, 0.42, 0.20, 0.34, 0.16, 24, 0.02, 0.10, 0.45, 0, 0.45, 0.10, 0, 0, 0.45, 0, 1, 0, 1],
    /* 北域 */ [0.90, 0.92, 0.96, 0.86, 0.88, 0.92, 0.40, 0.52, 0.50, -100, 0.15, 0.30, 0, 0, 0.85, 0, 0, 0, 0, 0, 1, 1, 0],
    /* 东域 */ [0.36, 0.63, 0.32, 0.93, 0.88, 0.68, 0.18, 0.46, 0.22, 24, 0.02, 0.20, 0.50, 0, 0, 0, 0.50, 1.6, 0, 0, 1, 0, 0],
    /* 南域 */ [0.20, 0.50, 0.20, 0.82, 0.77, 0.55, 0.10, 0.40, 0.16, 24, 0, 0.10, 0.60, 0, 0, 0, 0.40, 1, 0.1, 0, 1, 0, 0],
    /* 西域 */ [0.66, 0.60, 0.36, 0.90, 0.74, 0.48, 0.30, 0.48, 0.22, 24, 0, 0, 0, 0, 0.20, 0, 0.80, 1.5, 0, 0.6, 1, 0, 0],
    /* 界山 */ [0.32, 0.54, 0.30, 0.82, 0.78, 0.58, 0.14, 0.38, 0.20, 22, 0.60, 0.35, 0.80, 0.20, 0, 0, 0, 0.5, 0, 0, 1, 0, 0],
];
const lookSet = makeParamSet(BIOME_LOOKS, LP_COUNT, "BIOME_LOOKS");

/** 世界坐标处的外观参数（下标见 LP），用法同 biomeParams（共享数组，要立刻读出来） */
export function biomeLook(wx: number, wz: number): Float32Array {
    return interpolate(lookSet, wx, wz);
}

// ==================== 地貌天气（雾、环境光、天气粒子） ====================

/** 天气参数在参数向量里的下标 */
export const WP = {
    /** 雾颜色 RGB（也是背景色） */
    FogR: 0, FogG: 1, FogB: 2,
    /** 起雾距离和雾的过渡长度（米）。两者之和不能超过 145（加载边界在雾里全白处） */
    FogStart: 3, FogRange: 4,
    /** 环境光 RGB */
    AmbR: 5, AmbG: 6, AmbB: 7,
    /** 各种天气粒子的强度 0~1：持续的部分 + 阵发的部分（随时间时有时无） */
    Snow: 8, Rain: 9, RainGust: 10, Dust: 11, DustGust: 12, Firefly: 13, Leaves: 14,
} as const;
const WP_COUNT = 15;

//                 雾色                 起雾 过渡  环境光               雪   雨   阵雨  沙   阵沙  萤火  落叶
const BIOME_WEATHER: number[][] = [
    /* 平原 */ [0.62, 0.75, 0.88, 70, 75, 0.42, 0.46, 0.53, 0, 0, 0, 0, 0, 0, 0],
    /* 湖泊 */ [0.70, 0.80, 0.90, 55, 85, 0.44, 0.48, 0.55, 0, 0, 0, 0, 0, 0.5, 0],
    /* 高山 */ [0.66, 0.70, 0.76, 60, 85, 0.42, 0.45, 0.50, 0.25, 0, 0, 0, 0, 0, 0],
    /* 密林 */ [0.55, 0.66, 0.66, 35, 90, 0.36, 0.42, 0.42, 0, 0, 0, 0, 0, 0.8, 0.15],
    /* 山谷 */ [0.88, 0.74, 0.76, 60, 85, 0.48, 0.44, 0.46, 0, 0, 0, 0, 0, 0, 0.6],
    /* 荒原 */ [0.88, 0.76, 0.56, 60, 85, 0.52, 0.45, 0.36, 0, 0, 0, 0, 0.6, 0, 0],
    /* 石林 */ [0.78, 0.74, 0.62, 65, 80, 0.46, 0.44, 0.40, 0, 0, 0, 0, 0, 0, 0],
    /* 秋丘 */ [0.86, 0.78, 0.64, 70, 75, 0.48, 0.44, 0.40, 0, 0, 0, 0, 0, 0, 0.8],
    /* 沼泽 */ [0.58, 0.62, 0.44, 30, 85, 0.38, 0.42, 0.34, 0, 0, 0.4, 0, 0, 0.9, 0],
    /* 北域 */ [0.84, 0.90, 0.96, 45, 90, 0.50, 0.54, 0.62, 1, 0, 0, 0, 0, 0, 0],
    /* 东域 */ [0.60, 0.74, 0.90, 65, 80, 0.42, 0.47, 0.56, 0, 0, 0.5, 0, 0, 0, 0],
    /* 南域 */ [0.80, 0.84, 0.84, 40, 90, 0.40, 0.46, 0.44, 0, 0.4, 0.6, 0, 0, 0.3, 0],
    /* 西域 */ [0.86, 0.72, 0.50, 35, 80, 0.54, 0.46, 0.34, 0, 0, 0, 0.5, 0.5, 0, 0],
    /* 界山 */ [0.64, 0.68, 0.74, 55, 85, 0.42, 0.45, 0.50, 0.15, 0, 0, 0, 0, 0, 0],
];
const weatherSet = makeParamSet(BIOME_WEATHER, WP_COUNT, "BIOME_WEATHER");

/** 世界坐标处的天气参数（下标见 WP），用法同 biomeParams（共享数组，要立刻读出来） */
export function biomeWeather(wx: number, wz: number): Float32Array {
    return interpolate(weatherSet, wx, wz);
}
