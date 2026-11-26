import { RGB } from "./MeshBuilder";

/** 怪物种类配置。加新种类只需要在这里加一项，刷怪点的下拉框会自动出现 */
export interface UnitDef {
    /** 显示名（编辑器下拉框里用） */
    name: string;
    color: RGB;
    /** 追击时的颜色 */
    chaseColor: RGB;
    /** 移动速度（米/秒） */
    speed: number;
    /** 玩家进入这个距离开始追击 */
    aggro: number;
    /** 玩家超出这个距离放弃追击 */
    leash: number;
    /** 体型缩放 */
    size: number;
    /** 生命值（主角一箭打 1 点） */
    hp: number;
    /** 追击时在这个距离内会朝玩家扔石头（米） */
    throwRange: number;
    /** 两次扔石头的间隔（秒，实际会上下浮动 20%） */
    throwCd: number;
}

export const UNIT_DEFS: Record<string, UnitDef> = {
    imp: { name: "小恶魔（野外随机）", color: [0.85, 0.25, 0.2], chaseColor: [1, 0.05, 0.6], speed: 4, aggro: 18, leash: 32, size: 1, hp: 3, throwRange: 14, throwCd: 2.4 },
    wolf: { name: "狼", color: [0.55, 0.55, 0.58], chaseColor: [0.85, 0.3, 0.3], speed: 6, aggro: 20, leash: 36, size: 0.8, hp: 3, throwRange: 10, throwCd: 2.8 },
    slime: { name: "史莱姆", color: [0.3, 0.85, 0.4], chaseColor: [0.6, 1, 0.2], speed: 3, aggro: 10, leash: 20, size: 0.9, hp: 2, throwRange: 9, throwCd: 3.2 },
    ghost: { name: "幽灵", color: [0.8, 0.8, 1.0], chaseColor: [0.6, 0.4, 1.0], speed: 5, aggro: 25, leash: 40, size: 1.2, hp: 5, throwRange: 16, throwCd: 2 },
};

/** 野外随机刷出的怪物种类 */
export const RANDOM_KIND = "imp";

export function unitDef(kind: string): UnitDef {
    return UNIT_DEFS[kind] ?? UNIT_DEFS[RANDOM_KIND];
}

/** 给编辑器属性面板用的下拉选项 */
export const UNIT_ENUM = Object.keys(UNIT_DEFS).map(k => ({ name: UNIT_DEFS[k].name, value: k }));

export function rgbToCss(c: RGB): string {
    const h = (v: number) => { const s = Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16); return s.length < 2 ? "0" + s : s; };
    return "#" + h(c[0]) + h(c[1]) + h(c[2]);
}
