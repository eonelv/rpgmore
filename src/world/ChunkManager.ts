import { ChunkMesh, TerrainLayer, buildChunkMeshes, buildChunkMeshesSteps, buildWaterMesh, createWorldMaterials } from "./ChunkRenderer";
import { NavGrid } from "./NavGrid";
import {
    CHUNK_SIZE, LOAD_DIST, LOAD_RADIUS, LOD_BUILD_DIST, LOD_FAR_DIST, LOD_NEAR_DIST, UNLOAD_DIST, chunkKey,
} from "./WorldConfig";

/** 是否显示水面（排查手机帧率时临时关闭，改回 true 恢复） */
const DRAW_WATER = true;
/** 玩家每走这么远（米）重新检查一次哪些块要加载、卸载、切换精度 */
const REFRESH_STEP = 4;

interface LoadedChunk {
    cx: number;
    cz: number;
    root: Laya.Sprite3D;
    meshes: Laya.Mesh[];
    terrain: Laya.MeshSprite3D[];
    /** terrain[i] 属于哪一层 */
    layers: TerrainLayer[];
    water: Laya.Mesh | null;
    /** 当前是不是远处用的简化版网格 */
    far: boolean;
}

/** 正在分帧构建的一个块的网格 */
interface BuildJob {
    cx: number;
    cz: number;
    key: number;
    /** 构建的是不是简化版 */
    far: boolean;
    /** 已加载的块（重建）或 null（新加载） */
    chunk: LoadedChunk | null;
    it: Generator<void, ChunkMesh[], void>;
}

/** 点 (px,pz) 到块 (cx,cz) 最近的边的水平距离（米），在块内为 0 */
function chunkDist(cx: number, cz: number, px: number, pz: number): number {
    const x0 = cx * CHUNK_SIZE, z0 = cz * CHUNK_SIZE;
    const dx = Math.max(x0 - px, 0, px - x0 - CHUNK_SIZE), dz = Math.max(z0 - pz, 0, pz - z0 - CHUNK_SIZE);
    return Math.hypot(dx, dz);
}

/**
 * 按玩家位置流式加载/卸载块的画面。
 * - 玩家每走几米，重新计算需要的块，按距离从近到远排进构建队列
 * - 每帧只在时间预算（默认 4ms）内构建；一个块按行分步构建，可以分摊到好几帧（树多的块构建一次要几十毫秒），
 *   建完之前旧网格（或空白）保持不变，建完再一次性换上
 * - 距离超过 UNLOAD_DIST（雾里看不见）的块立即销毁，释放网格
 * - 远处的块用简化版网格（省显存），玩家走近后在时间预算内重建成完整版
 */
export class ChunkManager {
    private loaded = new Map<number, LoadedChunk>();
    private queue: { cx: number; cz: number; key: number }[] = [];
    private queued = new Set<number>();
    /** 等着切换精度（完整版 <-> 简化版）的块 */
    private lodQueue: number[] = [];
    /** 数据被修改（砍树）、等着按原精度重建的块，优先级最高 */
    private dirty = new Set<number>();
    /** 当前正在构建的块（同一时间只建一个） */
    private job: BuildJob | null = null;
    /** 临时隐藏的层（排查帧率用，见 setLayerHidden） */
    private hidden = new Set<TerrainLayer>();
    private lastX = NaN;
    private lastZ = NaN;
    private px = 0;
    private pz = 0;
    private terrainMat: Record<TerrainLayer, Laya.Material>;
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
    get queuedCount() { return this.queue.length + (this.job && !this.job.chunk ? 1 : 0); }

    /** 显示/隐藏某一层（所有已加载的块，以及之后加载的块），排查哪一层拖慢渲染用 */
    setLayerHidden(layer: TerrainLayer, hide: boolean) {
        if (hide) this.hidden.add(layer); else this.hidden.delete(layer);
        for (const c of this.loaded.values())
            c.terrain.forEach((ms, i) => { if (c.layers[i] === layer) ms.active = !hide; });
    }

    isLayerHidden(layer: TerrainLayer) { return this.hidden.has(layer); }

    isLoaded(cx: number, cz: number) { return this.loaded.has(chunkKey(cx, cz)); }

    /** 每帧调用 */
    update(px: number, pz: number) {
        this.px = px; this.pz = pz;
        // 第一次（lastX 是 NaN）也会进来
        if (!(Math.hypot(px - this.lastX, pz - this.lastZ) < REFRESH_STEP)) {
            this.lastX = px; this.lastZ = pz;
            const cx = Math.floor(px / CHUNK_SIZE), cz = Math.floor(pz / CHUNK_SIZE);
            this.refresh(cx, cz);
            this.nav.trim(cx, cz);
        }
        this.processQueue();
    }

    private refresh(cx: number, cz: number) {
        const px = this.px, pz = this.pz;
        // 卸载；留下的块看看要不要切换精度
        this.lodQueue.length = 0;
        const lod: { key: number; d: number }[] = [];
        for (const [key, c] of this.loaded) {
            const d = chunkDist(c.cx, c.cz, px, pz);
            if (d > UNLOAD_DIST) this.unload(key, c);
            else if (c.far ? d < LOD_NEAR_DIST : d > LOD_FAR_DIST) lod.push({ key, d });
        }
        // 正在构建的新块已经走远了：放弃
        const j = this.job;
        if (j && !j.chunk && chunkDist(j.cx, j.cz, px, pz) > UNLOAD_DIST) this.abortJob();
        // 近的先换（走近的块要尽快换成完整版）
        lod.sort((a, b) => a.d - b.d);
        for (const l of lod) this.lodQueue.push(l.key);
        // 放弃已经不需要的排队项
        this.queue = this.queue.filter(q => {
            const keep = chunkDist(q.cx, q.cz, px, pz) <= UNLOAD_DIST;
            if (!keep) this.queued.delete(q.key);
            return keep;
        });
        // 加入新需要的块
        for (let z = cz - LOAD_RADIUS; z <= cz + LOAD_RADIUS; z++) {
            for (let x = cx - LOAD_RADIUS; x <= cx + LOAD_RADIUS; x++) {
                const key = chunkKey(x, z);
                if (this.loaded.has(key) || this.queued.has(key) || this.job?.key === key) continue;
                if (chunkDist(x, z, px, pz) > LOAD_DIST) continue;
                this.queued.add(key);
                this.queue.push({ cx: x, cz: z, key });
            }
        }
        // 近的优先
        this.queue.sort((a, b) => chunkDist(a.cx, a.cz, px, pz) - chunkDist(b.cx, b.cz, px, pz));
    }

    /** 立即构建玩家周围 3x3 块，用于开局，避免玩家掉进空白区域 */
    warmUp(px: number, pz: number) {
        // 只排队不构建（update 会开始分步构建，和下面的同步构建重复）
        this.px = px; this.pz = pz;
        this.lastX = px; this.lastZ = pz;
        this.refresh(Math.floor(px / CHUNK_SIZE), Math.floor(pz / CHUNK_SIZE));
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
        while (performance.now() - t0 < this.budgetMs) {
            if (!this.job && !this.startJob()) return;
            const j = this.job!;
            const r = j.it.next();
            if (r.done) {
                this.job = null;
                this.finishJob(j, r.value);
            }
        }
    }

    /** 取下一个要构建的块：砍树后的重建 > 新块（近的优先）> 切换精度。没有活干返回 false */
    private startJob(): boolean {
        for (const key of this.dirty) {
            this.dirty.delete(key);
            const c = this.loaded.get(key);
            if (c) { this.job = this.makeJob(c.cx, c.cz, key, c.far, c); return true; }
        }
        if (this.queue.length > 0) {
            const q = this.queue.shift()!;
            this.queued.delete(q.key);
            this.job = this.makeJob(q.cx, q.cz, q.key, chunkDist(q.cx, q.cz, this.px, this.pz) > LOD_BUILD_DIST, null);
            return true;
        }
        while (this.lodQueue.length > 0) {
            const key = this.lodQueue.shift()!;
            const c = this.loaded.get(key);
            if (!c) continue;
            // 排队之后可能已经换过了（或者又走回来了），按现在的距离再判断一次
            const d = chunkDist(c.cx, c.cz, this.px, this.pz);
            if (c.far ? d >= LOD_NEAR_DIST : d <= LOD_FAR_DIST) continue;
            this.job = this.makeJob(c.cx, c.cz, key, !c.far, c);
            return true;
        }
        return false;
    }

    private makeJob(cx: number, cz: number, key: number, far: boolean, chunk: LoadedChunk | null): BuildJob {
        const it = buildChunkMeshesSteps(this.nav.getChunk(cx, cz), (gx, gz) => this.nav.kind(gx, gz), far);
        return { cx, cz, key, far, chunk, it };
    }

    /** 放弃当前的构建（已经生成的网格由构建器销毁） */
    private abortJob() {
        const j = this.job;
        if (!j) return;
        this.job = null;
        j.it.return(undefined as any);
        // 新块没建完就放弃：如果还需要，下次 refresh 会重新排队
    }

    private finishJob(j: BuildJob, parts: ChunkMesh[]) {
        if (j.chunk) {
            const c = j.chunk;
            for (const ms of c.terrain) ms.destroy(true);
            for (const m of c.meshes) m.destroy();
            c.far = j.far;
            this.attachTerrain(c, parts);
        } else if (this.loaded.has(j.key)) {
            for (const p of parts) p.mesh.destroy();
        } else {
            this.attachNew(j.cx, j.cz, j.key, j.far, parts);
        }
    }

    /**
     * 块数据被修改（如砍树）后重建该块的地形网格（精度不变），在之后几帧内分步完成，水面不变。
     * 如果这个块正在构建，用的是旧数据，放弃重来
     */
    rebuild(cx: number, cz: number) {
        const key = chunkKey(cx, cz);
        if (!this.loaded.has(key)) {
            // 没加载画面就不用管，以后加载时自然会用到新数据；正在构建的新块要用新数据重建
            if (this.job?.key === key) { this.abortJob(); this.requeue(cx, cz, key); }
            return;
        }
        if (this.job?.key === key) this.abortJob();
        this.dirty.add(key);
    }

    /** 新块放回构建队列最前面 */
    private requeue(cx: number, cz: number, key: number) {
        if (this.queued.has(key)) return;
        this.queued.add(key);
        this.queue.unshift({ cx, cz, key });
    }

    private attachTerrain(c: LoadedChunk, all: ChunkMesh[]) {
        const parts = all;
        c.meshes = parts.map(p => p.mesh);
        c.layers = parts.map(p => p.layer);
        c.terrain = parts.map(p => {
            const ms = new Laya.MeshSprite3D(p.mesh);
            ms.meshRenderer.sharedMaterial = this.terrainMat[p.layer];
            if (this.hidden.has(p.layer)) ms.active = false;
            c.root.addChild(ms);
            return ms;
        });
    }

    /** 立即构建一个新块（开局用） */
    private build(cx: number, cz: number, key: number) {
        const far = chunkDist(cx, cz, this.px, this.pz) > LOD_BUILD_DIST;
        const parts = buildChunkMeshes(this.nav.getChunk(cx, cz), (gx, gz) => this.nav.kind(gx, gz), far);
        this.attachNew(cx, cz, key, far, parts);
    }

    private attachNew(cx: number, cz: number, key: number, far: boolean, parts: ChunkMesh[]) {
        const root = new Laya.Sprite3D(`chunk_${cx}_${cz}`);
        const c: LoadedChunk = { cx, cz, root, meshes: [], terrain: [], layers: [], water: buildWaterMesh(cx, cz), far };
        this.attachTerrain(c, parts);
        if (c.water && DRAW_WATER) {
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
        if (this.job?.key === key) this.abortJob();
        this.dirty.delete(key);
        this.onChunkUnloaded(c.cx, c.cz);
        c.root.destroy(true);
        for (const m of c.meshes) m.destroy();
        if (c.water) c.water.destroy();
        this.loaded.delete(key);
    }
}
