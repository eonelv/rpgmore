import { TerrainLayer, buildChunkMeshes, buildWaterMesh, createWorldMaterials } from "./ChunkRenderer";
import { NavGrid } from "./NavGrid";
import { CHUNK_SIZE, LOAD_RADIUS, UNLOAD_RADIUS, chunkKey } from "./WorldConfig";

interface LoadedChunk {
    cx: number;
    cz: number;
    root: Laya.Sprite3D;
    meshes: Laya.Mesh[];
    terrain: Laya.MeshSprite3D[];
    water: Laya.Mesh | null;
}

/**
 * 按玩家位置流式加载/卸载块的画面。
 * - 玩家跨块时，重新计算需要的块，按距离从近到远排进构建队列
 * - 每帧只在时间预算（默认 4ms）内构建，避免一次性生成多个块导致卡顿
 * - 离开卸载半径的块立即销毁，释放网格
 */
export class ChunkManager {
    private loaded = new Map<number, LoadedChunk>();
    private queue: { cx: number; cz: number; key: number }[] = [];
    private queued = new Set<number>();
    private lastCx = NaN;
    private lastCz = NaN;
    private terrainMat: Record<TerrainLayer, Laya.BlinnPhongMaterial>;
    private waterMat: Laya.Material;

    /** 块加载/卸载的回调，用于生成/回收怪物 */
    onChunkLoaded: (cx: number, cz: number) => void = () => { };
    onChunkUnloaded: (cx: number, cz: number) => void = () => { };

    constructor(private parent: Laya.Sprite3D, private nav: NavGrid, private budgetMs = 4) {
        const m = createWorldMaterials();
        this.terrainMat = m.terrain;
        this.waterMat = m.water;
    }

    get loadedCount() { return this.loaded.size; }
    get queuedCount() { return this.queue.length; }

    isLoaded(cx: number, cz: number) { return this.loaded.has(chunkKey(cx, cz)); }

    /** 每帧调用 */
    update(px: number, pz: number) {
        const cx = Math.floor(px / CHUNK_SIZE), cz = Math.floor(pz / CHUNK_SIZE);
        if (cx !== this.lastCx || cz !== this.lastCz) {
            this.lastCx = cx; this.lastCz = cz;
            this.refresh(cx, cz);
            this.nav.trim(cx, cz);
        }
        this.processQueue();
    }

    private refresh(cx: number, cz: number) {
        // 卸载
        for (const [key, c] of this.loaded) {
            if (Math.abs(c.cx - cx) > UNLOAD_RADIUS || Math.abs(c.cz - cz) > UNLOAD_RADIUS) {
                this.unload(key, c);
            }
        }
        // 放弃已经不需要的排队项
        this.queue = this.queue.filter(q => {
            const keep = Math.abs(q.cx - cx) <= LOAD_RADIUS && Math.abs(q.cz - cz) <= LOAD_RADIUS;
            if (!keep) this.queued.delete(q.key);
            return keep;
        });
        // 加入新需要的块
        for (let z = cz - LOAD_RADIUS; z <= cz + LOAD_RADIUS; z++) {
            for (let x = cx - LOAD_RADIUS; x <= cx + LOAD_RADIUS; x++) {
                const key = chunkKey(x, z);
                if (this.loaded.has(key) || this.queued.has(key)) continue;
                this.queued.add(key);
                this.queue.push({ cx: x, cz: z, key });
            }
        }
        // 近的优先
        this.queue.sort((a, b) =>
            (Math.abs(a.cx - cx) + Math.abs(a.cz - cz)) - (Math.abs(b.cx - cx) + Math.abs(b.cz - cz)));
    }

    /** 立即构建玩家周围 3x3 块，用于开局，避免玩家掉进空白区域 */
    warmUp(px: number, pz: number) {
        this.update(px, pz);
        const cx = Math.floor(px / CHUNK_SIZE), cz = Math.floor(pz / CHUNK_SIZE);
        this.queue = this.queue.filter(q => {
            if (Math.abs(q.cx - cx) <= 1 && Math.abs(q.cz - cz) <= 1) {
                this.queued.delete(q.key);
                this.build(q.cx, q.cz, q.key);
                return false;
            }
            return true;
        });
    }

    private processQueue() {
        const t0 = performance.now();
        while (this.queue.length > 0 && performance.now() - t0 < this.budgetMs) {
            const q = this.queue.shift()!;
            this.queued.delete(q.key);
            this.build(q.cx, q.cz, q.key);
        }
    }

    /** 块数据被修改（如砍树）后，立即重建该块的地形网格。水面不变，保留 */
    rebuild(cx: number, cz: number) {
        const c = this.loaded.get(chunkKey(cx, cz));
        if (!c) return;   // 没加载画面就不用管，以后加载时自然会用到新数据
        for (const ms of c.terrain) ms.destroy(true);
        for (const m of c.meshes) m.destroy();
        this.buildTerrain(c);
    }

    private buildTerrain(c: LoadedChunk) {
        const parts = buildChunkMeshes(this.nav.getChunk(c.cx, c.cz), (gx, gz) => this.nav.kind(gx, gz));
        c.meshes = parts.map(p => p.mesh);
        c.terrain = parts.map(p => {
            const ms = new Laya.MeshSprite3D(p.mesh);
            ms.meshRenderer.sharedMaterial = this.terrainMat[p.layer];
            c.root.addChild(ms);
            return ms;
        });
    }

    private build(cx: number, cz: number, key: number) {
        const root = new Laya.Sprite3D(`chunk_${cx}_${cz}`);
        const c: LoadedChunk = { cx, cz, root, meshes: [], terrain: [], water: buildWaterMesh(cx, cz) };
        this.buildTerrain(c);
        if (c.water) {
            const water = new Laya.MeshSprite3D(c.water);
            water.meshRenderer.sharedMaterial = this.waterMat;
            water.meshRenderer.castShadow = false;
            root.addChild(water);
        }
        this.parent.addChild(root);
        this.loaded.set(key, c);
        this.onChunkLoaded(cx, cz);
    }

    private unload(key: number, c: LoadedChunk) {
        this.onChunkUnloaded(c.cx, c.cz);
        c.root.destroy(true);
        for (const m of c.meshes) m.destroy();
        if (c.water) c.water.destroy();
        this.loaded.delete(key);
    }
}
