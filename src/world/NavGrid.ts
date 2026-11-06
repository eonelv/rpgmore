import { CELL, CHUNK_CELLS, NAV_KEEP_RADIUS, chunkKey } from "./WorldConfig";
import { ChunkData, generateChunk } from "./WorldGen";

/**
 * 寻路数据层：与画面分离。
 * 每块的数据是 32x32 字节，按需生成（纯函数、确定性），所以未加载画面的块也能参与寻路。
 */
export class NavGrid {
    private chunks = new Map<number, ChunkData>();
    /**
     * 玩家对世界的修改（砍树等）：chunkKey -> (格子索引 -> 新类型)。
     * 块数据被回收后重新生成时，会再把这些修改叠加上去，所以修改是永久的。
     * 这份记录很小，以后做存档时直接序列化即可。
     */
    private edits = new Map<number, Map<number, number>>();
    /** 每次修改 +1，可用于判断缓存的路径是否过期 */
    version = 0;
    /** 格子被修改后的回调（用于重建该块的画面） */
    onCellChanged: (cx: number, cz: number, gx: number, gz: number) => void = () => { };

    getChunk(cx: number, cz: number): ChunkData {
        const key = chunkKey(cx, cz);
        let c = this.chunks.get(key);
        if (!c) {
            c = generateChunk(cx, cz);
            const e = this.edits.get(key);
            if (e) for (const [i, kind] of e) c.kinds[i] = kind;
            this.chunks.set(key, c);
        }
        return c;
    }

    kind(gx: number, gz: number): number {
        const cx = Math.floor(gx / CHUNK_CELLS), cz = Math.floor(gz / CHUNK_CELLS);
        return this.getChunk(cx, cz).kindLocal(gx - cx * CHUNK_CELLS, gz - cz * CHUNK_CELLS);
    }

    /** 修改一个格子的类型，立即对之后的寻路生效 */
    setCell(gx: number, gz: number, kind: number) {
        const cx = Math.floor(gx / CHUNK_CELLS), cz = Math.floor(gz / CHUNK_CELLS);
        const c = this.getChunk(cx, cz);
        const i = (gz - cz * CHUNK_CELLS) * CHUNK_CELLS + (gx - cx * CHUNK_CELLS);
        if (c.kinds[i] === kind) return;
        c.kinds[i] = kind;
        const key = chunkKey(cx, cz);
        let e = this.edits.get(key);
        if (!e) { e = new Map(); this.edits.set(key, e); }
        e.set(i, kind);
        this.version++;
        this.onCellChanged(cx, cz, gx, gz);
    }

    get editCount() {
        let n = 0;
        for (const e of this.edits.values()) n += e.size;
        return n;
    }

    /** 全局格子坐标是否可走 */
    walkable(gx: number, gz: number): boolean {
        const cx = Math.floor(gx / CHUNK_CELLS), cz = Math.floor(gz / CHUNK_CELLS);
        return this.getChunk(cx, cz).walkableLocal(gx - cx * CHUNK_CELLS, gz - cz * CHUNK_CELLS);
    }

    walkableWorld(wx: number, wz: number): boolean {
        return this.walkable(Math.floor(wx / CELL), Math.floor(wz / CELL));
    }

    /** 回收离玩家太远的寻路数据 */
    trim(playerCx: number, playerCz: number) {
        for (const [key, c] of this.chunks) {
            if (Math.abs(c.cx - playerCx) > NAV_KEEP_RADIUS || Math.abs(c.cz - playerCz) > NAV_KEEP_RADIUS) {
                this.chunks.delete(key);
            }
        }
    }

    get cachedCount() { return this.chunks.size; }

    /** 在 (gx,gz) 周围 radius 格内找最近的可走格子 */
    nearestWalkable(gx: number, gz: number, radius = 4): { gx: number; gz: number } | null {
        if (this.walkable(gx, gz)) return { gx, gz };
        for (let r = 1; r <= radius; r++) {
            let best: { gx: number; gz: number } | null = null, bestD = Infinity;
            for (let dz = -r; dz <= r; dz++) {
                for (let dx = -r; dx <= r; dx++) {
                    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
                    if (this.walkable(gx + dx, gz + dz)) {
                        const d = dx * dx + dz * dz;
                        if (d < bestD) { bestD = d; best = { gx: gx + dx, gz: gz + dz }; }
                    }
                }
            }
            if (best) return best;
        }
        return null;
    }

    /** 格子直线是否无阻挡（用于路径平滑）。沿线段采样，检查角色半径覆盖到的格子 */
    lineClear(ax: number, az: number, bx: number, bz: number, radius = 0.45): boolean {
        const dx = bx - ax, dz = bz - az;
        const dist = Math.sqrt(dx * dx + dz * dz);
        const steps = Math.ceil(dist / (CELL * 0.25));
        for (let i = 0; i <= steps; i++) {
            const t = steps === 0 ? 0 : i / steps;
            const x = ax + dx * t, z = az + dz * t;
            if (!this.walkableWorld(x - radius, z - radius) || !this.walkableWorld(x + radius, z - radius) ||
                !this.walkableWorld(x - radius, z + radius) || !this.walkableWorld(x + radius, z + radius)) {
                return false;
            }
        }
        return true;
    }
}
