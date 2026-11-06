import { NavGrid } from "./NavGrid";
import { hash2 } from "./Noise";
import { Vec2 } from "./PathFinder";
import { CELL, CHUNK_SIZE, SEED, chunkKey } from "./WorldConfig";

/** 一个刷怪点的数据（与编辑器组件分离，运行时和编辑器预览共用） */
export interface SpawnInfo {
    /** 唯一标识，用于防止重复生成 */
    id: string;
    kind: string;
    /** 中心（世界坐标） */
    x: number;
    z: number;
    count: number;
    /** 生成和闲逛的半径（米） */
    radius: number;
    /** 中心所在块不再刷野外随机怪 */
    clearRandom: boolean;
}

/**
 * 第 i 只怪物的出生位置：按刷怪点坐标和序号确定，每次都一样。
 * 编辑器预览和游戏运行用的是同一个函数，所以看到的位置就是实际位置（找不到可走格子时返回 null）。
 */
export function spawnPosition(s: SpawnInfo, i: number, nav: NavGrid): Vec2 | null {
    const seedX = Math.round(s.x * 10), seedZ = Math.round(s.z * 10);
    const a = hash2(seedX + i * 131, seedZ, SEED + 51) * Math.PI * 2;
    const r = Math.sqrt(hash2(seedX, seedZ + i * 137, SEED + 53)) * s.radius;
    const gx = Math.floor((s.x + Math.cos(a) * r) / CELL), gz = Math.floor((s.z + Math.sin(a) * r) / CELL);
    const p = nav.nearestWalkable(gx, gz, 4);
    return p ? { x: (p.gx + 0.5) * CELL, z: (p.gz + 0.5) * CELL } : null;
}

/** 按中心所在的块索引所有刷怪点 */
export class SpawnRegistry {
    private byChunk = new Map<number, SpawnInfo[]>();
    readonly all: SpawnInfo[] = [];

    add(s: SpawnInfo) {
        this.all.push(s);
        const key = chunkKey(Math.floor(s.x / CHUNK_SIZE), Math.floor(s.z / CHUNK_SIZE));
        let list = this.byChunk.get(key);
        if (!list) { list = []; this.byChunk.set(key, list); }
        list.push(s);
    }

    inChunk(cx: number, cz: number): SpawnInfo[] {
        return this.byChunk.get(chunkKey(cx, cz)) ?? [];
    }
}
