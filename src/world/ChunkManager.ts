import { TerrainLayer, buildChunkMeshes, buildWaterMesh, createWorldMaterials } from "./ChunkRenderer";
import { NavGrid } from "./NavGrid";
import {
    CHUNK_SIZE, LOAD_DIST, LOAD_RADIUS, LOD_BUILD_DIST, LOD_FAR_DIST, LOD_NEAR_DIST, UNLOAD_DIST, chunkKey,
} from "./WorldConfig";

/** 是否显示水面（排查手机帧率时临时关闭，改回 true 恢复） */
const DRAW_WATER = true;
/** 是否显示 alpha 测试的地面层（草地/沙地/山路），排查手机帧率用 */
const DRAW_CUTOUT = true;
const CUTOUT_LAYERS = new Set<TerrainLayer>(["grass", "sand", "trail"]);
/** 玩家每走这么远（米）重新检查一次哪些块要加载、卸载、切换精度 */
const REFRESH_STEP = 4;

interface LoadedChunk {
    cx: number;
    cz: number;
    root: Laya.Sprite3D;
    meshes: Laya.Mesh[];
    terrain: Laya.MeshSprite3D[];
    water: Laya.Mesh | null;
    /** 当前是不是远处用的简化版网格 */
    far: boolean;
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
 * - 每帧只在时间预算（默认 4ms）内构建，避免一次性生成多个块导致卡顿
 * - 距离超过 UNLOAD_DIST（雾里看不见）的块立即销毁，释放网格
 * - 远处的块用简化版网格（省显存），玩家走近后在时间预算内重建成完整版
 */
export class ChunkManager {
    private loaded = new Map<number, LoadedChunk>();
    private queue: { cx: number; cz: number; key: number }[] = [];
    private queued = new Set<number>();
    /** 等着切换精度（完整版 <-> 简化版）的块 */
    private lodQueue: number[] = [];
    private lastX = NaN;
    private lastZ = NaN;
    private px = 0;
    private pz = 0;
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
                if (this.loaded.has(key) || this.queued.has(key)) continue;
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
        // 新的块都建完了，再给已有的块切换精度
        while (this.lodQueue.length > 0 && performance.now() - t0 < this.budgetMs) {
            const c = this.loaded.get(this.lodQueue.shift()!);
            if (!c) continue;
            c.far = !c.far;
            this.rebuild(c.cx, c.cz);
        }
    }

    /** 块数据被修改（如砍树）后，立即重建该块的地形网格（精度不变）。水面不变，保留 */
    rebuild(cx: number, cz: number) {
        const c = this.loaded.get(chunkKey(cx, cz));
        if (!c) return;   // 没加载画面就不用管，以后加载时自然会用到新数据
        for (const ms of c.terrain) ms.destroy(true);
        for (const m of c.meshes) m.destroy();
        this.buildTerrain(c);
    }

    private buildTerrain(c: LoadedChunk) {
        const parts = buildChunkMeshes(this.nav.getChunk(c.cx, c.cz), (gx, gz) => this.nav.kind(gx, gz), c.far)
            .filter(p => {
                if (DRAW_CUTOUT || !CUTOUT_LAYERS.has(p.layer)) return true;
                p.mesh.destroy();
                return false;
            });
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
        const far = chunkDist(cx, cz, this.px, this.pz) > LOD_BUILD_DIST;
        const c: LoadedChunk = { cx, cz, root, meshes: [], terrain: [], water: buildWaterMesh(cx, cz), far };
        this.buildTerrain(c);
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
        this.onChunkUnloaded(c.cx, c.cz);
        c.root.destroy(true);
        for (const m of c.meshes) m.destroy();
        if (c.water) c.water.destroy();
        this.loaded.delete(key);
    }
}
