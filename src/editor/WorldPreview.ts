import { buildChunkMeshes, buildWaterMesh, createWorldMaterials } from "../world/ChunkRenderer";
import { CELL, CHUNK_SIZE } from "../world/WorldConfig";
import { groundY, spawnPoint } from "../world/WorldGen";
import { editorNav } from "./EditorNav";

const { regClass, property, runInEditor } = Laya;

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

    @property({ type: Number, caption: "半径（块）", min: 0, max: 8, step: 1, tips: "2 = 5x5 块，太大会让编辑器变卡" })
    radius = 3;

    private root: Laya.Sprite3D | null = null;
    private meshes: Laya.Mesh[] = [];
    private builtKey = "";
    private mats: ReturnType<typeof createWorldMaterials> | null = null;

    onEnable() {
        if (Laya.LayaEnv.isPlaying) return;
        this.builtKey = "";
    }

    onUpdate() {
        if (Laya.LayaEnv.isPlaying) return;
        const r = Math.max(0, Math.min(8, Math.round(this.radius)));
        const key = `${Math.round(this.centerChunkX)},${Math.round(this.centerChunkZ)},${r}`;
        if (key !== this.builtKey) {
            this.builtKey = key;
            this.rebuild(Math.round(this.centerChunkX), Math.round(this.centerChunkZ), r);
        }
    }

    onDisable() { this.clear(); }
    onDestroy() { this.clear(); }

    private clear() {
        if (this.root) { this.root.destroy(true); this.root = null; }
        for (const m of this.meshes) m.destroy();
        this.meshes = [];
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
                for (const p of buildChunkMeshes(editorNav().getChunk(cx, cz), (gx, gz) => editorNav().kind(gx, gz))) {
                    this.meshes.push(p.mesh);
                    const ms = new Laya.MeshSprite3D(p.mesh);
                    ms.meshRenderer.sharedMaterial = this.mats.terrain[p.layer];
                    root.addChild(ms);
                }
                const wm = buildWaterMesh(cx, cz);
                if (wm) {
                    this.meshes.push(wm);
                    const water = new Laya.MeshSprite3D(wm);
                    water.meshRenderer.sharedMaterial = this.mats.water;
                    root.addChild(water);
                }
            }
        }

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
}
