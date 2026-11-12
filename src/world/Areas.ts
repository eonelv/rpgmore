import { fbm } from "./Noise";
import { SEED } from "./WorldConfig";
import { MOUNTAIN_CELL_MIN, REGION, WATER_NOISE, mountainBase, terrainNoise } from "./WorldGen";

/**
 * 区域命名。
 *
 * 世界没有边界，按大区（REGION = 512 米见方，和道路网用的是同一套划分）起名：
 * - 以出生点所在大区为中心的 (2×NAMED_RADIUS+1)² 个大区是"有名字的区域"，名字固定不变。
 *   每个大区先按地貌分类（湖 / 山 / 谷坡 / 林 / 原野），再从对应的名字表里取一个没用过的名字。
 *   地貌只由世界种子决定，所以同一个种子下名字永远不变。
 * - 更远的地方按方位叫 东域 / 西域 / 南域 / 北域 / 东北域 ……（北 = -Z，东 = +X，和小地图一致）
 */

/** 有名字的范围：大区坐标的绝对值不超过它（2 => 5x5 个大区，2560 米见方） */
export const NAMED_RADIUS = 2;

type Biome = "lake" | "peak" | "valley" | "forest" | "plain";

const NAMES: Record<Biome, string[]> = {
    lake: ["明月湖", "镜心湖", "落星泽", "碧波湾", "听雨湖", "白鹭洲", "寒烟渡", "沉璧湖", "芦雪泽", "云梦泽"],
    peak: ["苍龙岭", "摘星峰", "铁脊山", "凌霄峰", "卧虎岭", "断云峰", "青冥山", "雷鸣崖", "孤鹰岭", "玉屏山"],
    valley: ["栖霞谷", "瞭望坡", "回风谷", "鹿鸣谷", "落雁坡", "幽兰谷", "石门峡", "松涛坡", "忘忧谷", "挽风坡"],
    forest: ["迷雾林", "青枫林", "古木林", "萤火林", "竹影林", "乌桕林", "千松林", "听蝉林", "霜叶林", "藏鹿林"],
    plain: ["长风原", "晴川原", "青草坪", "望乡野", "流萤原", "牧歌原", "踏歌坪", "白露原", "金穗原", "驰马原", "惊蛰原", "野望原"],
};
/** 某一类名字用完后，依次借用这些类的名字 */
const FALLBACK: Biome[] = ["plain", "valley", "forest", "peak", "lake"];

/** 分类时每隔这么多米取一个样本 */
const SAMPLE_STEP = 32;

/** 大区 (rx,rz) 的地貌：按水面、山体、森林各占多少来定 */
function classify(rx: number, rz: number): Biome {
    let water = 0, mountain = 0, forest = 0, total = 0;
    const x0 = (rx - 0.5) * REGION + SAMPLE_STEP / 2, z0 = (rz - 0.5) * REGION + SAMPLE_STEP / 2;
    for (let z = z0; z < (rz + 0.5) * REGION; z += SAMPLE_STEP) {
        for (let x = x0; x < (rx + 0.5) * REGION; x += SAMPLE_STEP) {
            total++;
            const n = terrainNoise(x, z);
            if (n < WATER_NOISE) water++;
            else if (mountainBase(x, z, n) > MOUNTAIN_CELL_MIN) mountain++;
            else if (fbm(x / 70, z / 70, 3, SEED + 500) > 0.56) forest++;
        }
    }
    // 各自除以"算得上有特色"的占比，谁超出得最多就算谁；都不够就是原野
    const w = water / total / 0.18, m = mountain / total / 0.22, f = forest / total / 0.30;
    const best = Math.max(w, m, f);
    if (best < 1) return "plain";
    if (best === w) return "lake";
    if (best === m) return mountain / total >= 0.38 ? "peak" : "valley";
    return "forest";
}

function key(rx: number, rz: number): number {
    return (rx + NAMED_RADIUS) * (2 * NAMED_RADIUS + 1) + (rz + NAMED_RADIUS);
}

let named: Map<number, string> | null = null;

/** 一次性给所有有名字的大区分配名字（从中心向外，保证不重名） */
function namedAreas(): Map<number, string> {
    if (named) return named;
    named = new Map();
    const R = NAMED_RADIUS;
    const cells: { rx: number; rz: number }[] = [];
    for (let rz = -R; rz <= R; rz++) for (let rx = -R; rx <= R; rx++) cells.push({ rx, rz });
    const ring = (c: { rx: number; rz: number }) => Math.max(Math.abs(c.rx), Math.abs(c.rz));
    cells.sort((a, b) => ring(a) - ring(b) || a.rz - b.rz || a.rx - b.rx);
    const used: Record<Biome, number> = { lake: 0, peak: 0, valley: 0, forest: 0, plain: 0 };
    for (const c of cells) {
        const biome = classify(c.rx, c.rz);
        let name = "";
        for (const b of [biome, ...FALLBACK]) {
            if (used[b] < NAMES[b].length) { name = NAMES[b][used[b]++]; break; }
        }
        named.set(key(c.rx, c.rz), name || `无名之地 ${c.rx},${c.rz}`);
    }
    return named;
}

/** 大区 (rx,rz) 的名字 */
export function areaName(rx: number, rz: number): string {
    const R = NAMED_RADIUS;
    if (Math.abs(rx) <= R && Math.abs(rz) <= R) return namedAreas().get(key(rx, rz))!;
    const ns = rz < -R ? "北" : rz > R ? "南" : "";
    const ew = rx > R ? "东" : rx < -R ? "西" : "";
    return `${ew}${ns}域`;
}

/** 是不是有名字的固定区域（不是"某某域"） */
export function isNamedArea(rx: number, rz: number): boolean {
    return Math.abs(rx) <= NAMED_RADIUS && Math.abs(rz) <= NAMED_RADIUS;
}

/** 世界坐标所在的大区坐标 */
export function regionOf(wx: number, wz: number): { rx: number; rz: number } {
    return { rx: Math.round(wx / REGION), rz: Math.round(wz / REGION) };
}

/** 世界坐标所在区域的名字 */
export function areaAt(wx: number, wz: number): string {
    return areaName(Math.round(wx / REGION), Math.round(wz / REGION));
}
