import { buildChunkMeshes, buildWaterMesh, createWorldMaterials } from "../world/ChunkRenderer";
import { CELL } from "../world/WorldConfig";
import { groundY, spawnPoint } from "../world/WorldGen";
import { editorNav } from "./EditorNav";

const { regClass, property, runInEditor } = Laya;

/** 预览半径上限（块）。12 = 25x25 块，1600 米见方 */
const MAX_RADIUS = 12;
/** 离中心块超过这么多块的用简化版网格（和游戏里远处的块一样），省显存 */
const FULL_DETAIL_RADIUS = 3;
/** 每帧最多花这么多毫秒构建预览，避免半径大时编辑器卡死 */
const BUDGET_MS = 12;

/**
 * 在 IDE 场景视图里显示程序生成的地形，方便摆放刷怪点等内容。
 * - 只在编辑器里生效，游戏运行时什么都不做（运行时由 ChunkManager 流式加载）
 * - 预览出来的节点不保存进场景文件
 * - 黄色竖线是玩家出生点
 */
@regClass()
@runInEditor
export class WorldPreview extends Laya.Script {
    @property({ type: Number, caption: "中心块 X", tips: "预览区域中心所在的块坐标（1 块 = 64 米）" })
    centerChunkX = 0;

    @property({ type: Number, caption: "中心块 Z" })
    centerChunkZ = 0;

    @property({ type: Number, caption: "半径（块）", min: 0, max: MAX_RADIUS, step: 1, tips: "3 = 7x7 块（约 450 米见方），最大 12。世界没有边界，只能预览一部分；离中心超过 3 块的用简化版网格" })
    radius = 3;

    private root: Laya.Sprite3D | null = null;
    private meshes: Laya.Mesh[] = [];
    private builtKey = "";
    /** 还没构建的块，从中心向外排 */
    private queue: { cx: number; cz: number; far: boolean }[] = [];
    private mats: ReturnType<typeof createWorldMaterials> | null = null;

    onEnable() {
        if (Laya.LayaEnv.isPlaying) return;
        this.builtKey = "";
    }

    onUpdate() {
        if (Laya.LayaEnv.isPlaying) return;
        const r = Math.max(0, Math.min(MAX_RADIUS, Math.round(this.radius)));
        const key = `${Math.round(this.centerChunkX)},${Math.round(this.centerChunkZ)},${r}`;
        if (key !== this.builtKey) {
            this.builtKey = key;
            this.rebuild(Math.round(this.centerChunkX), Math.round(this.centerChunkZ), r);
        }
        // 分帧构建：先出中心，再逐圈向外
        const t0 = performance.now();
        while (this.root && this.queue.length > 0 && performance.now() - t0 < BUDGET_MS) {
            const q = this.queue.shift()!;
            this.buildChunk(this.root, q.cx, q.cz, q.far);
        }
    }

    onDisable() { this.clear(); }
    onDestroy() { this.clear(); }

    private clear() {
        if (this.root) { this.root.destroy(true); this.root = null; }
        for (const m of this.meshes) m.destroy();
        this.meshes = [];
        this.queue = [];
        this.builtKey = "";
    }

    private rebuild(ccx: number, ccz: number, r: number) {
        this.clear();
        this.builtKey = `${ccx},${ccz},${r}`;
        const scene = (this.owner as Laya.Sprite3D).scene;
        if (!scene) return;
        if (!this.mats) this.mats = createWorldMaterials();

        const root = new Laya.Sprite3D("WorldPreview(临时)");
        root.hideFlags = Laya.HideFlags.HideAndDontSave;
        for (let cz = ccz - r; cz <= ccz + r; cz++) {
            for (let cx = ccx - r; cx <= ccx + r; cx++) {
                const d = Math.max(Math.abs(cx - ccx), Math.abs(cz - ccz));
                this.queue.push({ cx, cz, far: d > FULL_DETAIL_RADIUS });
            }
        }
        const ring = (q: { cx: number; cz: number }) => Math.max(Math.abs(q.cx - ccx), Math.abs(q.cz - ccz));
        this.queue.sort((a, b) => ring(a) - ring(b));

        // 出生点标记（与 Main 里的出生逻辑一致：spawnPoint）
        const start = spawnPoint();
        const sx = (start.gx + 0.5) * CELL, sz = (start.gz + 0.5) * CELL, sy = groundY(sx, sz);
        const lines = new Laya.PixelLineSprite3D(4);
        const yellow = new Laya.Color(1, 0.9, 0.1, 1);
        lines.addLine(new Laya.Vector3(sx, sy, sz), new Laya.Vector3(sx, sy + 12, sz), yellow, yellow);
        lines.addLine(new Laya.Vector3(sx - 2, sy + 0.2, sz), new Laya.Vector3(sx + 2, sy + 0.2, sz), yellow, yellow);
        lines.addLine(new Laya.Vector3(sx, sy + 0.2, sz - 2), new Laya.Vector3(sx, sy + 0.2, sz + 2), yellow, yellow);
        root.addChild(lines);

        scene.addChild(root);
        this.root = root;
    }

    private buildChunk(root: Laya.Sprite3D, cx: number, cz: number, far: boolean) {
        const mats = this.mats!;
        for (const p of buildChunkMeshes(editorNav().getChunk(cx, cz), (gx, gz) => editorNav().kind(gx, gz), far)) {
            this.meshes.push(p.mesh);
            const ms = new Laya.MeshSprite3D(p.mesh);
            ms.meshRenderer.sharedMaterial = mats.terrain[p.layer];
            root.addChild(ms);
        }
        const wm = buildWaterMesh(cx, cz);
        if (wm) {
            this.meshes.push(wm);
            const water = new Laya.MeshSprite3D(wm);
            water.meshRenderer.sharedMaterial = mats.water;
            root.addChild(water);
        }
    }
}
