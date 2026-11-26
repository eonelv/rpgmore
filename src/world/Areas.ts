import { AreaRef, Slot, areaBoxWarped, areaOf, isHomeArea, newAreaRef, warped } from "./Biome";
import { hash2 } from "./Noise";
import { SEED } from "./WorldConfig";

/**
 * 区域和小地名的名字（区域怎么划分见 Biome.ts）。
 *
 * - 出生所在的世界单元用手写的名字（长风原、明月湖……），每个区域 4 个手写的小地名。
 * - 其他世界单元：区域名 = 两字前缀 + 地貌后缀（"镜心湖"），四个域叫"北域 · 朔风"，界山叫"界山 · 天堑"；
 *   小地名 = 两字前缀 + 一字后缀（"青石渡"）。同一个单元里的区域名、同一个区域里的小地名不重复。
 * - 小地名：区域在扭曲坐标里按 PLACE 米切成小块，每块一个名字（中间的区域 2×2 块，四个域十几到三十块）。
 *
 * 名字只由区域编号决定，所以同一个地方的名字永远不变。
 */

/** 小地名的格子边长（扭曲坐标，米） */
const PLACE = 768;

/** 出生单元中间 3×3 个区域的名字（按 Slot 下标）和四个域的名字 */
const HOME_NAMES = ["栖霞谷", "苍龙岭", "迷雾林", "落日原", "长风原", "明月湖", "乱石林", "赤枫丘", "落星泽", "北域", "南域", "东域", "西域"];

/** 出生单元中间 3×3 个区域的小地名（每个区域 2×2 块：西北、东北、西南、东南） */
const HOME_PLACES = [
    ["回风谷", "枫林渡", "霞光坡", "听泉潭"],
    ["摘星峰", "断云崖", "龙脊道", "雪松坳"],
    ["古木林", "萤火洞", "藏鹿径", "千年树"],
    ["残阳坡", "驼铃道", "枯井集", "望烽台"],
    ["望乡坡", "十里亭", "牧歌坪", "风车岗"],
    ["湖心岛", "渔歌渡", "芦花滩", "望月台"],
    ["千柱林", "卧牛石", "一线天", "石钟岩"],
    ["红叶坡", "金叶岗", "斜阳岭", "晚枫亭"],
    ["沉星潭", "鬼火沼", "腐木滩", "蛙鸣洼"],
];

/** 其他单元的区域名前缀（不含出生单元已经用过的） */
const AREA_PREFIX = [
    "镜心", "碧波", "听雨", "白鹭", "寒烟", "沉璧", "云梦", "摘星", "铁脊", "凌霄", "卧虎", "断云", "青冥", "雷鸣",
    "孤鹰", "玉屏", "回风", "鹿鸣", "落雁", "幽兰", "松涛", "忘忧", "挽风", "青枫", "古木", "萤火", "竹影", "千松",
    "听蝉", "霜叶", "藏鹿", "晴川", "望乡", "流萤", "牧歌", "踏歌", "白露", "金穗", "驰马", "惊蛰", "野望", "残阳",
    "赤霞", "紫烟", "碧落", "天青", "青鸾", "金乌", "银汉", "星河", "烟波", "翠屏", "苍梧", "望舒", "扶摇", "鸣鹤",
];
/** 中间 3×3 个区域的名字后缀（按 Slot 下标，和地貌对应） */
const AREA_SUFFIX = ["谷", "岭", "林", "野", "原", "湖", "石林", "丘", "泽"];

/** 其他单元四个域的称呼（按 Slot：北、南、东、西） */
const DOMAIN_TITLE = ["北域", "南域", "东域", "西域"];
const DOMAIN_EPITHET = [
    ["朔风", "寒鸦", "霜铃", "冰原", "雪狼", "玄冰", "极光", "凛冬", "白狐", "冻云"],
    ["瘴云", "藤萝", "蛮荒", "翠微", "雷泽", "百越", "雨师", "青藤", "赤蟒", "云笼"],
    ["潮生", "蜃楼", "鲸歌", "珊瑚", "碧海", "听涛", "望潮", "浮槎", "沧浪", "海市"],
    ["流沙", "玉门", "赤漠", "孤烟", "黄沙", "胡杨", "驼铃", "月泉", "铁勒", "阳关"],
];
const SEAM_EPITHET = ["天堑", "断界", "擎天", "万仞", "通天", "横断", "镇岳", "分水", "绝壁", "苍穹"];

/** 小地名的前缀：四个域、界山各有自己风格的一组，其余区域共用一组 */
const PLACE_PREFIX_COMMON = [
    "青石", "白云", "黄泥", "老鸦", "双溪", "三叉", "七里", "望月", "听风", "卧龙", "飞鹰", "黑水", "红叶", "金沙",
    "银杏", "古槐", "柳荫", "杏花", "桃源", "梨花", "松风", "野狐", "灰狼", "鹿角", "马蹄", "龟背", "鹤鸣", "燕归",
    "雁回", "鱼跃", "莲花", "芦苇", "石鼓", "铜钟", "铁索", "玉带", "碧螺", "云台", "烟雨", "晚照", "孤松", "双塔",
    "九曲", "百花", "回龙", "落凤", "伏虎", "断桥",
];
const PLACE_PREFIX = [
    ["寒鸦", "霜铃", "冰河", "雪松", "冻泉", "朔风", "白狐", "凛风", "冰镜", "霜狼", "雪鹰", "枯木", "鸦啼", "冰棱"],
    ["瘴雾", "藤桥", "蛮寨", "翠竹", "雷鸣", "芭蕉", "毒龙", "青蛇", "猿啼", "象鼻", "孔雀", "榕荫", "雨林", "蟒山"],
    ["潮音", "蜃气", "鲸背", "珊瑚", "碧螺", "海燕", "白帆", "渔火", "望潮", "贝壳", "椰风", "浪花", "鸥鸣", "沧海"],
    ["流沙", "玉门", "赤沙", "孤烟", "黄羊", "胡杨", "驼峰", "月牙", "风蚀", "烽燧", "鸣沙", "红柳", "铁门", "沙枣"],
    ["鹰愁", "猿啸", "天梯", "铁壁", "云关", "雪岭", "绝云", "石门", "飞瀑", "望乡", "回首", "仙人", "鬼见", "一线"],
];
/** 小地名的后缀（按地貌，见 Biome） */
const PLACE_SUFFIX = [
    ["坡", "亭", "坪", "岗", "渡", "庄", "集"],          // 平原
    ["岛", "渡", "滩", "台", "堤", "洲", "矶"],          // 湖泊
    ["峰", "崖", "岭", "坳", "台", "顶"],                // 高山
    ["林", "径", "洞", "坞", "里", "岭"],                // 密林
    ["谷", "渡", "坡", "潭", "峡", "溪"],                // 山谷
    ["坡", "道", "集", "台", "塬", "井"],                // 荒原
    ["林", "石", "岩", "崖", "岗", "峡"],                // 石林
    ["坡", "岗", "岭", "坳", "亭", "丘"],                // 秋色丘陵
    ["潭", "沼", "滩", "洼", "泽", "洲"],                // 沼泽
    ["原", "岭", "湖", "谷", "林", "坡"],                // 北域
    ["岛", "湾", "礁", "屿", "滩", "港"],                // 东域
    ["林", "溪", "谷", "寨", "潭", "洞"],                // 南域
    ["漠", "碛", "堡", "泉", "丘", "驿"],                // 西域
    ["关", "口", "隘", "峰", "岭", "栈"],                // 界山
];

/** 从 n 个组合里按 i 取第 i 个，同一个 seed 下 i 不同时结果一定不同（i < n） */
function pick(n: number, seed: number, i: number): number {
    const start = Math.floor(seed * n);
    let stride = 1;
    for (const s of [7, 11, 13, 17, 19, 23, 29, 31]) if (gcd(s, n) === 1) { stride = s; break; }
    return (start + i * stride) % n;
}
function gcd(a: number, b: number): number {
    while (b) [a, b] = [b, a % b];
    return a;
}

const unitNameCache = new Map<number, number[]>();
/** 单元 (ux,uz) 中间 9 个区域的前缀下标：各自哈希，单元内撞了就往后顺延，保证互不相同 */
function unitPrefixes(ux: number, uz: number): number[] {
    const key = (ux + 4096) * 8192 + (uz + 4096);
    let out = unitNameCache.get(key);
    if (!out) {
        if (unitNameCache.size > 256) unitNameCache.clear();
        out = [];
        const n = AREA_PREFIX.length;
        for (let i = 0; i < 9; i++) {
            let k = Math.floor(hash2(ux * 16 + i, uz, SEED + 801) * n);
            while (out.indexOf(k) >= 0) k = (k + 1) % n;
            out.push(k);
        }
        unitNameCache.set(key, out);
    }
    return out;
}

/** 区域的名字 */
export function areaName(a: AreaRef): string {
    if (isHomeArea(a)) return HOME_NAMES[a.slot];
    if (a.slot < 9) return AREA_PREFIX[unitPrefixes(a.ux, a.uz)[a.slot]] + AREA_SUFFIX[a.slot];
    if (a.slot <= Slot.West) {
        const d = a.slot - Slot.North;
        const list = DOMAIN_EPITHET[d];
        return `${DOMAIN_TITLE[d]} · ${list[Math.floor(hash2(a.ux, a.uz, SEED + 811 + d) * list.length)]}`;
    }
    return `界山 · ${SEAM_EPITHET[Math.floor(hash2(a.ux * 2 + a.slot, a.uz, SEED + 821) * SEAM_EPITHET.length)]}`;
}

/** 区域是不是有自己的名字（不是某某域、界山），小地图上用亮一点的颜色 */
export function isNamedArea(a: AreaRef): boolean {
    return a.slot < 9;
}

/** 区域里小地名格子的行列数 */
function placeGrid(box: number[]): { cols: number; rows: number } {
    return { cols: Math.max(1, Math.round((box[2] - box[0]) / PLACE)), rows: Math.max(1, Math.round((box[3] - box[1]) / PLACE)) };
}

/** 区域 a 里第 index 块的小地名 */
function placeNameAt(a: AreaRef, index: number): string {
    if (isHomeArea(a) && a.slot < 9) return HOME_PLACES[a.slot][index];
    const prefixes = a.slot < 9 ? PLACE_PREFIX_COMMON
        : a.slot <= Slot.West ? PLACE_PREFIX[a.slot - Slot.North] : PLACE_PREFIX[4];
    const suffixes = PLACE_SUFFIX[a.biome];
    const n = prefixes.length * suffixes.length;
    // index < count；组合数 n 至少 14×6 = 84，比一个区域的格子数（最多约 30）多，所以同一区域里不会重名
    const c = pick(n, hash2(a.key % 65536, Math.floor(a.key / 65536), SEED + 831), index);
    return prefixes[c % prefixes.length] + suffixes[Math.floor(c / prefixes.length) % suffixes.length];
}

/** 一个位置的区域和小地名 */
export interface PlaceInfo {
    area: AreaRef;
    /** 区域名 */
    areaName: string;
    /** 小地名 */
    placeName: string;
    /** 小地名格子的唯一编号 */
    placeKey: number;
    /** 小地名格子中心（扭曲坐标） */
    placeX: number;
    placeZ: number;
}

export function newPlaceInfo(): PlaceInfo {
    return { area: newAreaRef(), areaName: "", placeName: "", placeKey: 0, placeX: 0, placeZ: 0 };
}

/** 世界坐标处的区域和小地名，写到 out */
export function placeAt(wx: number, wz: number, out: PlaceInfo): PlaceInfo {
    const a = areaOf(wx, wz, out.area);
    // areaOf 刚算过扭曲坐标，还在 warped 里
    const x = warped.x, z = warped.z;
    const box = areaBoxWarped(a);
    const { cols, rows } = placeGrid(box);
    const cw = (box[2] - box[0]) / cols, ch = (box[3] - box[1]) / rows;
    const col = Math.min(cols - 1, Math.max(0, Math.floor((x - box[0]) / cw)));
    const row = Math.min(rows - 1, Math.max(0, Math.floor((z - box[1]) / ch)));
    const index = row * cols + col;
    out.areaName = areaName(a);
    out.placeName = placeNameAt(a, index);
    out.placeKey = a.key * 64 + index;
    out.placeX = box[0] + (col + 0.5) * cw;
    out.placeZ = box[1] + (row + 0.5) * ch;
    return out;
}

const tmpPlace = newPlaceInfo();

/** 世界坐标所在区域的名字 */
export function areaAt(wx: number, wz: number): string {
    return placeAt(wx, wz, tmpPlace).areaName;
}

/** 世界坐标所在区域的编号（判断两处是不是同一个区域用） */
export function areaKeyAt(wx: number, wz: number): number {
    return areaOf(wx, wz, tmpPlace.area).key;
}

/** 世界坐标所在小地名格子的编号 */
export function placeKeyAt(wx: number, wz: number): number {
    return placeAt(wx, wz, tmpPlace).placeKey;
}
