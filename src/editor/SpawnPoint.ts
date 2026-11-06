import { SpawnInfo, spawnPosition } from "../world/Spawns";
import { UNIT_ENUM, unitDef } from "../world/UnitDefs";
import { groundY } from "../world/WorldGen";
import { editorNav } from "./EditorNav";

const { regClass, property, runInEditor } = Laya;

/**
 * 刷怪点。在 IDE 里新建一个 Sprite3D 节点，挂上这个组件，拖到地形上想要的位置即可。
 * - 只用节点的 X/Z 坐标，高度自动贴地
 * - 编辑器里显示：白色圆圈 = 刷怪/闲逛范围，彩色竖线 = 每只怪物的实际出生位置（和游戏里完全一致）
 * - 游戏运行时由 Main 收集所有刷怪点，在所在块加载时生成怪物
 */
@regClass()
@runInEditor
export class SpawnPoint extends Laya.Script {
    @property({ type: String, caption: "怪物种类", enumSource: UNIT_ENUM })
    kind = "wolf";

    @property({ type: Number, caption: "数量", min: 1, max: 30, step: 1 })
    count = 3;

    @property({ type: Number, caption: "半径（米）", min: 1, max: 60, step: 1, tips: "生成和闲逛的范围" })
    radius = 8;

    @property({ type: Boolean, caption: "清除所在块的随机怪", tips: "勾选后，刷怪点中心所在的块不再生成野外随机怪" })
    clearRandom = true;

    private gizmo: Laya.PixelLineSprite3D | null = null;
    private drawnKey = "";

    /** 转成运行时数据 */
    toInfo(): SpawnInfo {
        const p = (this.owner as Laya.Sprite3D).transform.position;
        return {
            id: this.owner.name,
            kind: this.kind,
            x: p.x, z: p.z,
            count: Math.max(1, Math.round(this.count)),
            radius: Math.max(1, this.radius),
            clearRandom: this.clearRandom,
        };
    }

    onUpdate() {
        if (Laya.LayaEnv.isPlaying) return;
        const p = (this.owner as Laya.Sprite3D).transform.position;
        const key = `${p.x.toFixed(2)},${p.z.toFixed(2)},${this.kind},${this.count},${this.radius}`;
        if (key !== this.drawnKey) {
            this.drawnKey = key;
            this.draw();
        }
    }

    onDisable() { this.clearGizmo(); }
    onDestroy() { this.clearGizmo(); }

    private clearGizmo() {
        if (this.gizmo) { this.gizmo.destroy(); this.gizmo = null; }
        this.drawnKey = "";
    }

    private draw() {
        const scene = (this.owner as Laya.Sprite3D).scene;
        if (!scene) return;
        if (!this.gizmo) {
            this.gizmo = new Laya.PixelLineSprite3D(256);
            this.gizmo.hideFlags = Laya.HideFlags.HideAndDontSave;
            scene.addChild(this.gizmo);
        }
        const g = this.gizmo;
        g.clear();
        const info = this.toInfo();
        const def = unitDef(info.kind);
        const white = new Laya.Color(1, 1, 1, 1);
        const col = new Laya.Color(def.color[0], def.color[1], def.color[2], 1);
        const a = new Laya.Vector3(), b = new Laya.Vector3();

        // 范围圈（贴地）
        const N = 48;
        for (let i = 0; i < N; i++) {
            const t0 = i / N * Math.PI * 2, t1 = (i + 1) / N * Math.PI * 2;
            const x0 = info.x + Math.cos(t0) * info.radius, z0 = info.z + Math.sin(t0) * info.radius;
            const x1 = info.x + Math.cos(t1) * info.radius, z1 = info.z + Math.sin(t1) * info.radius;
            a.setValue(x0, groundY(x0, z0) + 0.3, z0);
            b.setValue(x1, groundY(x1, z1) + 0.3, z1);
            g.addLine(a, b, white, white);
        }
        // 中心柱
        const cy = groundY(info.x, info.z);
        a.setValue(info.x, cy, info.z); b.setValue(info.x, cy + 8, info.z);
        g.addLine(a, b, white, col);
        // 每只怪物的出生位置
        for (let i = 0; i < info.count && g.lineCount < g.maxLineCount; i++) {
            const pos = spawnPosition(info, i, editorNav());
            if (!pos) continue;
            const y = groundY(pos.x, pos.z);
            a.setValue(pos.x, y, pos.z); b.setValue(pos.x, y + 2.5 * def.size, pos.z);
            g.addLine(a, b, col, col);
        }
    }
}
