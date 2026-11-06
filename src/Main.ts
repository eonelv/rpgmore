import { SpawnPoint } from "./editor/SpawnPoint";
import { Minimap } from "./ui/Minimap";
import { MonsterManager, Player } from "./world/Actors";
import { ChunkManager } from "./world/ChunkManager";
import { NavGrid } from "./world/NavGrid";
import { PathService, Vec2 } from "./world/PathFinder";
import { SpawnRegistry } from "./world/Spawns";
import { CELL, CHUNK_SIZE, chopResult } from "./world/WorldConfig";
import { loadWaterShader } from "./world/WaterShader";
import { groundY, roadNode } from "./world/WorldGen";

const { regClass } = Laya;

/**
 * 开放世界原型入口。
 * 操作：鼠标左键点击地面 → 主角自动寻路；点击树 → 走过去砍掉；按住 F 砍面前的树；WASD 直接移动；滚轮缩放；
 *      G 键自动前往 1~2 公里外的随机地点（测试长距离分段寻路和流式加载）；M 键切换小地图/大地图。
 * 刷怪点：在场景里任意位置放挂了 SpawnPoint 组件的节点，启动时自动收集。
 */
@regClass()
export class Main extends Laya.Script {
    private scene3D: Laya.Scene3D;
    private camera: Laya.Camera;
    private nav = new NavGrid();
    private paths = new PathService(this.nav, 3);
    private chunks: ChunkManager;
    private monsters: MonsterManager;
    private player: Player;
    private lines: Laya.PixelLineSprite3D;
    private marker: Laya.MeshSprite3D;
    private hud: Laya.Text;
    private spawns = new SpawnRegistry();
    private minimap: Minimap;

    private camDist = 26;
    private ray = new Laya.Ray(new Laya.Vector3(), new Laya.Vector3());
    private v2 = new Laya.Vector2();
    private camPos = new Laya.Vector3();
    private camTarget = new Laya.Vector3();
    private up = new Laya.Vector3(0, 1, 0);
    private ready = false;
    private fpsAcc = 0; private fpsFrames = 0; private fps = 0;

    async onStart() {
        // Laya 3 的 Scene3D 不在 2D 场景的子节点里，要通过 scene.scene3D 获取
        const owner = this.owner as Laya.Scene;
        this.scene3D = owner.scene3D;
        this.camera = this.scene3D?.getChildByName("Main Camera") as Laya.Camera;
        if (!this.scene3D || !this.camera) {
            console.error("Main: 找不到 Scene3D 或 Main Camera", this.scene3D, this.camera);
            this.enabled = false;
            return;
        }

        // 雾和背景同色，远处的块在雾中淡入，看不到加载边界
        const fog = new Laya.Color(0.62, 0.75, 0.88, 1);
        this.scene3D.enableFog = true;
        this.scene3D.fogColor = fog;
        this.scene3D.fogStart = 70;
        this.scene3D.fogRange = 75;
        this.camera.clearFlag = Laya.CameraClearFlags.SolidColor;
        this.camera.clearColor = fog;
        this.camera.farPlane = 200;

        // 水面 shader 是资源文件，要先加载，否则水面材质会退回默认 shader
        await loadWaterShader();

        const worldRoot = new Laya.Sprite3D("World");
        this.scene3D.addChild(worldRoot);
        this.chunks = new ChunkManager(worldRoot, this.nav);
        this.collectSpawnPoints(this.scene3D);
        this.monsters = new MonsterManager(this.scene3D, this.nav, this.paths, this.spawns);
        this.minimap = new Minimap(this.nav, this.spawns.all);
        this.chunks.onChunkLoaded = (cx, cz) => this.monsters.spawnForChunk(cx, cz);
        this.chunks.onChunkUnloaded = (cx, cz) => this.monsters.despawnForChunk(cx, cz);
        this.nav.onCellChanged = (cx, cz, gx, gz) => this.onCellChanged(cx, cz, gx, gz);

        // 出生在块 (0,0) 的道路节点上，保证在连通区域内
        const start = roadNode(0, 0);
        this.player = new Player(this.scene3D, { x: (start.gx + 0.5) * CELL, z: (start.gz + 0.5) * CELL }, this.nav);
        this.chunks.warmUp(this.player.pos.x, this.player.pos.z);

        this.lines = new Laya.PixelLineSprite3D(4000);
        this.scene3D.addChild(this.lines);
        this.marker = new Laya.MeshSprite3D(Laya.PrimitiveMesh.createCylinder(0.5, 0.1, 12));
        const mm = new Laya.BlinnPhongMaterial();
        mm.albedoColor = new Laya.Color(1, 0.85, 0.1, 1);
        this.marker.meshRenderer.sharedMaterial = mm;
        this.marker.active = false;
        this.scene3D.addChild(this.marker);

        this.hud = new Laya.Text();
        this.hud.fontSize = 16;
        this.hud.color = "#ffffff";
        this.hud.stroke = 3;
        this.hud.strokeColor = "#000000";
        this.hud.pos(10, 10);
        Laya.stage.addChild(this.hud);

        Laya.stage.on(Laya.Event.MOUSE_DOWN, this, this.onClick);
        Laya.stage.on(Laya.Event.MOUSE_WHEEL, this, (e: Laya.Event) => {
            this.camDist = Math.min(60, Math.max(10, this.camDist - e.delta * 0.02 * this.camDist));
        });
        Laya.stage.on(Laya.Event.KEY_DOWN, this, (e: Laya.Event) => {
            if (e.keyCode === Laya.Keyboard.G) this.travelFar();
            if (e.keyCode === Laya.Keyboard.M) this.minimap.toggle();
        });
        this.ready = true;
    }

    onDestroy() {
        Laya.stage.offAllCaller(this);
        this.hud?.destroy();
        this.minimap?.destroy();
    }

    /** 收集场景里所有 SpawnPoint 组件（任意层级），转成运行时数据 */
    private collectSpawnPoints(node: Laya.Node) {
        for (let i = 0; i < node.numChildren; i++) {
            const child = node.getChildAt(i);
            const sp = child.getComponent(SpawnPoint);
            if (sp && sp.enabled) this.spawns.add(sp.toInfo());
            this.collectSpawnPoints(child);
        }
    }

    onUpdate() {
        if (!this.ready) return;   // onStart 还在等 shader 加载
        const dt = Math.min(Laya.timer.delta / 1000, 0.05);
        const p = this.player;

        // WASD 移动（取消自动寻路）
        let mx = 0, mz = 0;
        const K = Laya.Keyboard, I = Laya.InputManager;
        if (I.hasKeyDown(K.W) || I.hasKeyDown(K.UP)) mz -= 1;
        if (I.hasKeyDown(K.S) || I.hasKeyDown(K.DOWN)) mz += 1;
        if (I.hasKeyDown(K.A) || I.hasKeyDown(K.LEFT)) mx -= 1;
        if (I.hasKeyDown(K.D) || I.hasKeyDown(K.RIGHT)) mx += 1;
        if (mx || mz) {
            this.chopTarget = null;
            if (p.path.length || p.pending) { p.cancelPath(); p.finalTarget = null; this.marker.active = false; }
            const len = Math.sqrt(mx * mx + mz * mz);
            p.moveFree(mx / len * p.speed * dt, mz / len * p.speed * dt);
        } else if (p.advance(dt)) {
            // 分段路径走完一段后，继续规划下一段
            if (p.partial && p.finalTarget && !p.pending) this.requestPlayerPath(p.finalTarget);
            else if (!p.pending && !p.partial) this.marker.active = false;
        }

        this.updateChop(dt);
        if (I.hasKeyDown(K.F)) this.chopNearby();   // 按住 F 连续砍

        this.paths.update();
        this.monsters.update(dt, p.pos);
        this.chunks.update(p.pos.x, p.pos.z);
        this.updateCamera(dt);
        this.drawPaths();
        this.minimap.update(p.pos, p.heading, this.monsters.monsters, this.marker.active ? p.finalTarget : null);
        this.updateHud(dt);
    }

    private onClick() {
        const hit = this.pickGround(Laya.stage.mouseX, Laya.stage.mouseY);
        if (!hit) return;
        const gx = Math.floor(hit.x / CELL), gz = Math.floor(hit.z / CELL);
        if (chopResult(this.nav.kind(gx, gz)) !== null) this.walkToChop(gx, gz);
        else this.walkTo(hit);
    }

    // ---------------- 砍树 ----------------

    /** 走到要砍的树旁边后再砍 */
    private chopTarget: { gx: number; gz: number } | null = null;
    private chopCooldown = 0;

    /** 点击了一棵树：寻路到它旁边的可走格子，到达后砍掉 */
    private walkToChop(gx: number, gz: number) {
        const p = this.player.pos;
        let best: Vec2 | null = null, bestD = Infinity;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            if (!this.nav.walkable(gx + dx, gz + dz)) continue;
            const c = { x: (gx + dx + 0.5) * CELL, z: (gz + dz + 0.5) * CELL };
            const d = (c.x - p.x) ** 2 + (c.z - p.z) ** 2;
            if (d < bestD) { bestD = d; best = c; }
        }
        if (!best) { console.log("这棵树四周都被挡住了，先砍它旁边的树"); return; }
        this.walkTo(best);
        this.chopTarget = { gx, gz };
    }

    /** F 键：砍掉面前（或身边最近）的一棵树/灌木 */
    private chopNearby() {
        const p = this.player;
        const pgx = Math.floor(p.pos.x / CELL), pgz = Math.floor(p.pos.z / CELL);
        // 先看面朝方向的格子
        const fx = Math.floor((p.pos.x + Math.sin(p.heading) * CELL) / CELL);
        const fz = Math.floor((p.pos.z + Math.cos(p.heading) * CELL) / CELL);
        if (chopResult(this.nav.kind(fx, fz)) !== null) { this.chop(fx, fz); return; }
        // 再找周围 8 格
        for (let dz = -1; dz <= 1; dz++)
            for (let dx = -1; dx <= 1; dx++)
                if (chopResult(this.nav.kind(pgx + dx, pgz + dz)) !== null) { this.chop(pgx + dx, pgz + dz); return; }
    }

    private chop(gx: number, gz: number) {
        if (this.chopCooldown > 0) return;
        const after = chopResult(this.nav.kind(gx, gz));
        if (after === null) return;
        this.chopCooldown = 0.35;
        this.nav.setCell(gx, gz, after);   // 寻路数据立即更新，并触发该块画面重建
        this.chopCount++;
    }
    private chopCount = 0;

    private updateChop(dt: number) {
        this.chopCooldown = Math.max(0, this.chopCooldown - dt);
        const t = this.chopTarget;
        if (!t) return;
        const p = this.player;
        if (p.path.length || p.pending) return;   // 还在路上
        const d = Math.hypot((t.gx + 0.5) * CELL - p.pos.x, (t.gz + 0.5) * CELL - p.pos.z);
        if (d <= CELL * 1.6) {
            p.heading = Math.atan2((t.gx + 0.5) * CELL - p.pos.x, (t.gz + 0.5) * CELL - p.pos.z);
            p.syncNode();
            this.chop(t.gx, t.gz);
        }
        this.chopTarget = null;
    }

    /** 格子变化时：重建画面；如果有格子变成阻挡，让正在走的单位重新寻路 */
    private onCellChanged(cx: number, cz: number, gx: number, gz: number) {
        this.chunks.rebuild(cx, cz);
        this.minimap.invalidate(cx, cz);
        if (this.nav.walkable(gx, gz)) return;   // 只是多了一条路，旧路径仍然有效
        const p = this.player;
        if (p.finalTarget && (p.path.length || p.pending)) { p.cancelPath(); this.requestPlayerPath(p.finalTarget); }
        for (const m of this.monsters.monsters) m.cancelPath();   // 怪物下次思考时会自己重新寻路
    }

    private travelFar() {
        const a = Math.random() * Math.PI * 2, d = 1000 + Math.random() * 1000;
        this.walkTo({ x: this.player.pos.x + Math.cos(a) * d, z: this.player.pos.z + Math.sin(a) * d });
    }

    private walkTo(target: Vec2) {
        this.chopTarget = null;
        this.player.cancelPath();
        this.player.finalTarget = target;
        this.requestPlayerPath(target);
        this.marker.active = true;
        this.marker.transform.position = new Laya.Vector3(target.x, groundY(target.x, target.z) + 0.05, target.z);
    }

    private requestPlayerPath(target: Vec2) {
        const p = this.player;
        p.pending = this.paths.request(p.pos, target, r => {
            p.pending = null;
            p.path = r.ok ? r.points : [];
            p.partial = r.ok && r.partial;
            if (!r.ok) { p.finalTarget = null; this.marker.active = false; }
        });
    }

    /** 屏幕射线与高度场求交：步进后二分细化 */
    private pickGround(sx: number, sy: number): Vec2 | null {
        this.v2.setValue(sx, sy);
        this.camera.viewportPointToRay(this.v2, this.ray);
        const o = this.ray.origin, d = this.ray.direction;
        const above = (t: number) => o.y + d.y * t > groundY(o.x + d.x * t, o.z + d.z * t);
        let prev = 0;
        for (let t = 0.5; t < 250; t += 0.5) {
            if (!above(t)) {
                let lo = prev, hi = t;
                for (let i = 0; i < 12; i++) { const m = (lo + hi) / 2; if (above(m)) lo = m; else hi = m; }
                return { x: o.x + d.x * hi, z: o.z + d.z * hi };
            }
            prev = t;
        }
        return null;
    }

    private updateCamera(dt: number) {
        const p = this.player.pos;
        const py = groundY(p.x, p.z);
        const k = 1 - Math.exp(-dt * 8);
        const tx = p.x, tz = p.z + this.camDist * 0.75;
        // 视线被山挡住时抬高相机：沿 角色->相机 采样，保证视线高出地面至少 1.5 米
        const eye = py + 1;
        let ty = py + this.camDist * 0.85;
        for (let i = 1; i <= 12; i++) {
            const t = i / 12;
            const h = groundY(p.x, p.z + (tz - p.z) * t) + 1.5;
            ty = Math.max(ty, eye + (h - eye) / t);
        }
        const c = this.camera.transform.position;
        if (this.camPos.x === 0 && this.camPos.z === 0) this.camPos.setValue(tx, ty, tz);
        else this.camPos.setValue(c.x + (tx - c.x) * k, c.y + (ty - c.y) * k, c.z + (tz - c.z) * k);
        this.camera.transform.position = this.camPos;
        this.camTarget.setValue(p.x, py + 1, p.z);
        this.camera.transform.lookAt(this.camTarget, this.up, false, true);
    }

    private lineColorP = new Laya.Color(1, 0.9, 0.1, 1);
    private lineColorM = new Laya.Color(1, 0.2, 0.2, 1);
    private la = new Laya.Vector3();
    private lb = new Laya.Vector3();

    private drawPaths() {
        this.lines.clear();
        this.drawPath(this.player.pos, this.player.path, this.lineColorP);
        for (const m of this.monsters.monsters) if (m.state === "chase") this.drawPath(m.pos, m.path, this.lineColorM);
    }

    private drawPath(from: Vec2, path: Vec2[], col: Laya.Color) {
        let prev = from;
        for (const pt of path) {
            if (this.lines.lineCount >= this.lines.maxLineCount) return;
            this.la.setValue(prev.x, groundY(prev.x, prev.z) + 0.3, prev.z);
            this.lb.setValue(pt.x, groundY(pt.x, pt.z) + 0.3, pt.z);
            this.lines.addLine(this.la, this.lb, col, col);
            prev = pt;
        }
    }

    private updateHud(dt: number) {
        this.fpsAcc += dt; this.fpsFrames++;
        if (this.fpsAcc >= 0.5) { this.fps = Math.round(this.fpsFrames / this.fpsAcc); this.fpsAcc = 0; this.fpsFrames = 0; }
        const p = this.player.pos;
        this.hud.text =
            `FPS ${this.fps}\n` +
            `位置 (${p.x.toFixed(0)}, ${p.z.toFixed(0)})  块 (${Math.floor(p.x / CHUNK_SIZE)}, ${Math.floor(p.z / CHUNK_SIZE)})\n` +
            `已加载块 ${this.chunks.loadedCount}  排队 ${this.chunks.queuedCount}  寻路数据缓存 ${this.nav.cachedCount}  已砍 ${this.chopCount}  地图修改 ${this.nav.editCount}\n` +
            `刷怪点 ${this.spawns.all.length}  怪物 ${this.monsters.monsters.length}  追击 ${this.monsters.chasingCount}  寻路排队 ${this.paths.pending}  寻路耗时 ${this.paths.lastFrameMs.toFixed(1)}ms\n` +
            `左键点地面: 自动寻路   左键点树: 走过去砍掉   F(按住): 砍面前的树
WASD: 移动   滚轮: 缩放   G: 前往远方   M: 大地图`;
    }
}
