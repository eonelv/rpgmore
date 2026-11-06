import { NavGrid } from "./NavGrid";
import { hash2 } from "./Noise";
import { PathRequest, PathService, Vec2 } from "./PathFinder";
import { SpawnRegistry, spawnPosition } from "./Spawns";
import { RANDOM_KIND, UnitDef, unitDef } from "./UnitDefs";
import { CELL, CHUNK_CELLS, SEED, chunkKey } from "./WorldConfig";
import { groundY } from "./WorldGen";

const RADIUS = 0.45;

function makeMat(r: number, g: number, b: number): Laya.BlinnPhongMaterial {
    const m = new Laya.BlinnPhongMaterial();
    m.albedoColor = new Laya.Color(r, g, b, 1);
    m.lock = true;
    return m;
}

/** 沿路径点移动的单位（主角和怪物共用） */
export class Mover {
    readonly node: Laya.Sprite3D;
    pos: Vec2;
    path: Vec2[] = [];
    speed: number;
    /** 当前路径只是去往远处目标的一段 */
    partial = false;
    finalTarget: Vec2 | null = null;
    pending: PathRequest | null = null;
    private tmp = new Laya.Vector3();
    /** 朝向（弧度），0 = +Z 方向 */
    heading = 0;

    constructor(node: Laya.Sprite3D, pos: Vec2, speed: number, protected nav: NavGrid) {
        this.node = node;
        this.pos = { x: pos.x, z: pos.z };
        this.speed = speed;
        this.syncNode();
    }

    /** 沿路径走 dt 秒，返回是否到达路径终点 */
    advance(dt: number): boolean {
        let budget = this.speed * dt;
        while (budget > 0 && this.path.length > 0) {
            const t = this.path[0];
            const dx = t.x - this.pos.x, dz = t.z - this.pos.z;
            const d = Math.sqrt(dx * dx + dz * dz);
            if (d <= budget) {
                this.pos.x = t.x; this.pos.z = t.z;
                budget -= d;
                this.path.shift();
            } else {
                this.pos.x += dx / d * budget;
                this.pos.z += dz / d * budget;
                budget = 0;
            }
            if (d > 1e-4) this.heading = Math.atan2(dx, dz);
        }
        this.syncNode();
        return this.path.length === 0;
    }

    /** 自由移动（WASD），按轴分别检测阻挡，可以贴着墙滑动 */
    moveFree(dx: number, dz: number) {
        if (dx === 0 && dz === 0) return;
        this.heading = Math.atan2(dx, dz);
        const nx = this.pos.x + dx;
        if (this.canStand(nx, this.pos.z)) this.pos.x = nx;
        const nz = this.pos.z + dz;
        if (this.canStand(this.pos.x, nz)) this.pos.z = nz;
        this.syncNode();
    }

    private canStand(x: number, z: number): boolean {
        const n = this.nav;
        return n.walkableWorld(x - RADIUS, z - RADIUS) && n.walkableWorld(x + RADIUS, z - RADIUS) &&
            n.walkableWorld(x - RADIUS, z + RADIUS) && n.walkableWorld(x + RADIUS, z + RADIUS);
    }

    syncNode() {
        this.tmp.setValue(this.pos.x, groundY(this.pos.x, this.pos.z), this.pos.z);
        this.node.transform.position = this.tmp;
        this.node.transform.localRotationEulerY = this.heading * 180 / Math.PI;
    }

    cancelPath() {
        if (this.pending) { this.pending.cancelled = true; this.pending = null; }
        this.path = [];
        this.partial = false;
    }
}

export class Player extends Mover {
    constructor(scene: Laya.Scene3D, pos: Vec2, nav: NavGrid) {
        const root = new Laya.Sprite3D("Player");
        const body = new Laya.MeshSprite3D(Laya.PrimitiveMesh.createCapsule(0.4, 1.8));
        body.meshRenderer.sharedMaterial = makeMat(0.2, 0.45, 0.95);
        body.transform.localPosition = new Laya.Vector3(0, 0.9, 0);
        root.addChild(body);
        const nose = new Laya.MeshSprite3D(Laya.PrimitiveMesh.createBox(0.2, 0.2, 0.4));
        nose.meshRenderer.sharedMaterial = makeMat(1, 0.9, 0.3);
        nose.transform.localPosition = new Laya.Vector3(0, 1.4, 0.4);
        root.addChild(nose);
        scene.addChild(root);
        super(root, pos, 7, nav);
    }
}

type MonsterState = "idle" | "wander" | "chase";

/** 所有怪物共用的网格，避免每只怪物各建一份 */
let shared: { body: Laya.Mesh; eye: Laya.Mesh; eyeMat: Laya.Material } | null = null;
function monsterAssets() {
    if (!shared) {
        shared = {
            body: Laya.PrimitiveMesh.createBox(1, 1, 1),
            eye: Laya.PrimitiveMesh.createBox(0.6, 0.15, 0.1),
            eyeMat: makeMat(1, 1, 1),
        };
        shared.body.lock = true;
        shared.eye.lock = true;
    }
    return shared;
}

export class Monster extends Mover {
    state: MonsterState = "idle";
    private thinkTimer = 0;
    private lastChaseTarget: Vec2 = { x: 0, z: 0 };
    private body: Laya.MeshSprite3D;

    constructor(scene: Laya.Scene3D, pos: Vec2, nav: NavGrid, readonly kind: string, readonly def: UnitDef,
        private matIdle: Laya.Material, private matChase: Laya.Material,
        private home: Vec2, private wanderRadius: number,
        /** 生成这只怪物的块。回收以它为准，块重新加载时不会重复生成 */
        readonly originKey: number) {
        const a = monsterAssets();
        const s = def.size;
        const root = new Laya.Sprite3D("Monster_" + kind);
        const body = new Laya.MeshSprite3D(a.body);
        body.meshRenderer.sharedMaterial = matIdle;
        body.transform.localPosition = new Laya.Vector3(0, 0.5 * s, 0);
        body.transform.localScale = new Laya.Vector3(s, s, s);
        root.addChild(body);
        const eye = new Laya.MeshSprite3D(a.eye);
        eye.meshRenderer.sharedMaterial = a.eyeMat;
        eye.transform.localPosition = new Laya.Vector3(0, 0.75 * s, 0.52 * s);
        eye.transform.localScale = new Laya.Vector3(s, s, s);
        root.addChild(eye);
        scene.addChild(root);
        super(root, pos, def.speed, nav);
        this.body = body;
        this.thinkTimer = Math.random() * 2;
    }

    update(dt: number, player: Vec2, paths: PathService) {
        const dx = player.x - this.pos.x, dz = player.z - this.pos.z;
        const distToPlayer = Math.sqrt(dx * dx + dz * dz);

        // 状态切换
        if (this.state !== "chase" && distToPlayer < this.def.aggro) this.setState("chase");
        else if (this.state === "chase" && distToPlayer > this.def.leash) { this.setState("idle"); this.cancelPath(); }

        this.thinkTimer -= dt;
        if (this.state === "chase") {
            // 玩家移动超过 2 米，或者路径走完，就重新寻路（限制频率）
            const mdx = player.x - this.lastChaseTarget.x, mdz = player.z - this.lastChaseTarget.z;
            if (distToPlayer > 1.6 && !this.pending && this.thinkTimer <= 0 &&
                (this.path.length === 0 || mdx * mdx + mdz * mdz > 4)) {
                this.thinkTimer = 0.4;
                this.lastChaseTarget = { x: player.x, z: player.z };
                this.goTo(player, paths);
            }
            if (distToPlayer <= 1.6) this.path = [];
        } else if (this.path.length === 0 && !this.pending && this.thinkTimer <= 0) {
            // 在出生点附近闲逛
            this.thinkTimer = 2 + Math.random() * 3;
            const a = Math.random() * Math.PI * 2, r = Math.random() * this.wanderRadius;
            this.state = "wander";
            this.goTo({ x: this.home.x + Math.cos(a) * r, z: this.home.z + Math.sin(a) * r }, paths);
        }
        if (this.advance(dt) && this.state === "wander") this.state = "idle";
    }

    private goTo(target: Vec2, paths: PathService) {
        if (this.pending) this.pending.cancelled = true;
        this.pending = paths.request(this.pos, target, r => {
            this.pending = null;
            this.path = r.ok ? r.points : [];
        });
    }

    private setState(s: MonsterState) {
        this.state = s;
        this.body.meshRenderer.sharedMaterial = s === "chase" ? this.matChase : this.matIdle;
    }

    destroy() {
        this.cancelPath();
        this.node.destroy(true);
    }
}

/**
 * 怪物随块生成/回收：
 * - 场景里摆放的刷怪点（SpawnPoint 组件）：中心所在的块加载时生成
 * - 野外随机怪：每个块按种子确定生成 0~2 只（刷怪点可以关掉所在块的随机怪）
 */
export class MonsterManager {
    readonly monsters: Monster[] = [];
    private mats = new Map<string, { idle: Laya.Material; chase: Laya.Material }>();

    constructor(private scene: Laya.Scene3D, private nav: NavGrid, private paths: PathService,
        private spawns: SpawnRegistry) { }

    private matsFor(kind: string) {
        let m = this.mats.get(kind);
        if (!m) {
            const d = unitDef(kind);
            m = { idle: makeMat(d.color[0], d.color[1], d.color[2]), chase: makeMat(d.chaseColor[0], d.chaseColor[1], d.chaseColor[2]) };
            this.mats.set(kind, m);
        }
        return m;
    }

    private spawn(kind: string, pos: Vec2, home: Vec2, wanderRadius: number, originKey: number) {
        const m = this.matsFor(kind);
        this.monsters.push(new Monster(this.scene, pos, this.nav, kind, unitDef(kind), m.idle, m.chase, home, wanderRadius, originKey));
    }

    spawnForChunk(cx: number, cz: number) {
        const key = chunkKey(cx, cz);
        const points = this.spawns.inChunk(cx, cz);
        for (const s of points) {
            for (let i = 0; i < s.count; i++) {
                const pos = spawnPosition(s, i, this.nav);
                if (pos) this.spawn(s.kind, pos, { x: s.x, z: s.z }, Math.max(2, s.radius), key);
            }
        }
        if (points.some(s => s.clearRandom)) return;

        const count = Math.floor(hash2(cx, cz, SEED + 777) * 3);
        for (let i = 0; i < count; i++) {
            const gx = cx * CHUNK_CELLS + Math.floor(hash2(cx * 7 + i, cz, SEED + 31) * CHUNK_CELLS);
            const gz = cz * CHUNK_CELLS + Math.floor(hash2(cx, cz * 7 + i, SEED + 37) * CHUNK_CELLS);
            const p = this.nav.nearestWalkable(gx, gz, 6);
            if (!p) continue;
            const pos = { x: (p.gx + 0.5) * CELL, z: (p.gz + 0.5) * CELL };
            this.spawn(RANDOM_KIND, pos, pos, 14, key);
        }
    }

    /** 回收这个块生成的怪物（按出生块，追击跑远的怪物也一起回收） */
    despawnForChunk(cx: number, cz: number) {
        const key = chunkKey(cx, cz);
        for (let i = this.monsters.length - 1; i >= 0; i--) {
            const m = this.monsters[i];
            if (m.originKey === key) {
                m.destroy();
                this.monsters.splice(i, 1);
            }
        }
    }

    update(dt: number, player: Vec2) {
        for (const m of this.monsters) m.update(dt, player, this.paths);
    }

    get chasingCount() { return this.monsters.filter(m => m.state === "chase").length; }
}
