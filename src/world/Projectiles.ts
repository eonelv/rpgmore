import { Monster, MonsterManager } from "./Actors";
import { actorMaterial, arrowMesh } from "./Archer";
import { MeshBuilder, RGB } from "./MeshBuilder";
import { NavGrid } from "./NavGrid";
import { CELL, Cell } from "./WorldConfig";
import { groundY } from "./WorldGen";

/** 箭的飞行速度（米/秒）和最远射程 */
const ARROW_SPEED = 40;
const ARROW_RANGE = 48;
/** 飞行中的箭比手里的放大一些，远处也看得清 */
const ARROW_SCALE = 1.5;
/** 射中地面/树后插在上面停留的时间 */
const STUCK_TIME = 1.5;
const ARROW_DAMAGE = 1;

/** 拖尾：每飞这么远撒一颗粒子 */
const TRAIL_SPACING = 0.3;
const MAX_PARTICLES = 320;

interface Particle {
    node: Laya.MeshSprite3D;
    pos: Laya.Vector3;
    scale: Laya.Vector3;
    vx: number; vy: number; vz: number;
    life: number; maxLife: number; size: number;
}

/**
 * 简单的粒子池：发光的小菱形块，出生后慢慢飘散、缩小到消失。
 * 所有粒子共用一个网格和两种不透明的自发光材质（不用透明混合，手机上便宜），节点循环使用
 */
class ParticlePool {
    private live: Particle[] = [];
    private free: Particle[] = [];
    private mesh: Laya.Mesh;
    private mats: Laya.Material[];

    constructor(private scene: Laya.Scene3D) {
        const mb = new MeshBuilder();
        const white: RGB = [1, 1, 1];
        // 八面体：上下两个四棱锥
        for (const s of [1, -1])
            for (let i = 0; i < 4; i++) {
                const a0 = (i / 4) * Math.PI * 2, a1 = ((i + 1) / 4) * Math.PI * 2;
                mb.tri(Math.cos(a0) * 0.5, 0, Math.sin(a0) * 0.5, Math.cos(a1) * 0.5, 0, Math.sin(a1) * 0.5,
                    0, s * 0.7, 0, white, 0, 0, 0);
            }
        this.mesh = mb.build()[0];
        this.mesh.lock = true;
        this.mats = [[1, 0.86, 0.3], [1, 1, 0.85], [1, 0.55, 0.15]].map(c => {
            const m = new Laya.UnlitMaterial();
            m.albedoColor = new Laya.Color(c[0], c[1], c[2], 1);
            m.lock = true;
            return m;
        });
    }

    emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number) {
        let p = this.free.pop();
        if (!p) {
            if (this.live.length >= MAX_PARTICLES) return;
            const node = new Laya.MeshSprite3D(this.mesh);
            node.meshRenderer.castShadow = false;
            node.transform.localRotationEuler = new Laya.Vector3(Math.random() * 360, Math.random() * 360, 0);
            this.scene.addChild(node);
            p = { node, pos: new Laya.Vector3(), scale: new Laya.Vector3(), vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1, size: 0 };
        }
        p.node.meshRenderer.sharedMaterial = this.mats[Math.floor(Math.random() * this.mats.length)];
        p.pos.setValue(x, y, z);
        p.vx = vx; p.vy = vy; p.vz = vz;
        p.life = p.maxLife = life;
        p.size = size;
        p.scale.setValue(size, size, size);
        p.node.transform.position = p.pos;
        p.node.transform.localScale = p.scale;
        p.node.active = true;
        this.live.push(p);
    }

    update(dt: number) {
        const drag = Math.exp(-dt * 3);
        for (let i = this.live.length - 1; i >= 0; i--) {
            const p = this.live[i];
            p.life -= dt;
            if (p.life <= 0) {
                p.node.active = false;
                this.live[i] = this.live[this.live.length - 1];
                this.live.pop();
                this.free.push(p);
                continue;
            }
            p.vx *= drag; p.vy *= drag; p.vz *= drag;
            p.pos.setValue(p.pos.x + p.vx * dt, p.pos.y + p.vy * dt, p.pos.z + p.vz * dt);
            const s = p.size * (p.life / p.maxLife);
            p.scale.setValue(s, s, s);
            p.node.transform.position = p.pos;
            p.node.transform.localScale = p.scale;
        }
    }

    get count() { return this.live.length; }
}

interface Arrow {
    node: Laya.MeshSprite3D;
    pos: Laya.Vector3;
    dx: number; dy: number; dz: number;
    /** 追踪的目标（射出时锁定的怪物），没有则直线飞 */
    target: Monster | null;
    travelled: number;
    /** 离上一颗拖尾粒子飞了多远 */
    sinceTrail: number;
    /** > 0：已经插在地上/树上，倒计时结束后消失 */
    stuck: number;
}

/** 管理所有飞行中的箭：飞行、追踪、命中判定、粒子拖尾 */
export class ArrowManager {
    private arrows: Arrow[] = [];
    private particles: ParticlePool;
    private q = new Laya.Quaternion();
    private scale = new Laya.Vector3(ARROW_SCALE, ARROW_SCALE, ARROW_SCALE);

    constructor(private scene: Laya.Scene3D, private nav: NavGrid, private monsters: MonsterManager) {
        this.particles = new ParticlePool(scene);
    }

    /** 从 from 朝 (tx,ty,tz) 射出一支箭；target 不为空时箭会追着它飞 */
    fire(from: Laya.Vector3, tx: number, ty: number, tz: number, target: Monster | null) {
        let dx = tx - from.x, dy = ty - from.y, dz = tz - from.z;
        const len = Math.hypot(dx, dy, dz) || 1;
        dx /= len; dy /= len; dz /= len;
        const node = new Laya.MeshSprite3D(arrowMesh());
        node.meshRenderer.sharedMaterial = actorMaterial();
        node.meshRenderer.castShadow = false;
        node.transform.localScale = this.scale;
        this.scene.addChild(node);
        const a: Arrow = { node, pos: new Laya.Vector3(from.x, from.y, from.z), dx, dy, dz, target, travelled: 0, sinceTrail: 0, stuck: 0 };
        this.arrows.push(a);
        this.orient(a);
        // 离弦的一小团火花
        for (let i = 0; i < 6; i++) this.spark(from.x, from.y, from.z, 2.5, 0.25, 0.12);
    }

    update(dt: number) {
        for (let i = this.arrows.length - 1; i >= 0; i--) {
            const a = this.arrows[i];
            if (a.stuck > 0) {
                a.stuck -= dt;
                if (a.stuck <= 0) this.remove(i);
                continue;
            }
            if (this.fly(a, dt)) this.remove(i);
        }
        this.particles.update(dt);
    }

    /** 飞一帧；返回 true = 这支箭该消失了（射中怪物或飞出射程） */
    private fly(a: Arrow, dt: number): boolean {
        // 追踪：朝目标当前的位置修正方向（目标死了就按原方向飞）
        const t = a.target;
        if (t && !t.dead) {
            const ex = t.pos.x - a.pos.x, ey = t.centerY - a.pos.y, ez = t.pos.z - a.pos.z;
            const el = Math.hypot(ex, ey, ez);
            if (el > 1e-3) { a.dx = ex / el; a.dy = ey / el; a.dz = ez / el; }
        }
        const step = ARROW_SPEED * dt;
        const x0 = a.pos.x, y0 = a.pos.y, z0 = a.pos.z;

        // 这一帧飞过的线段上，最先碰到的怪物
        let hit: Monster | null = null, hitT = step;
        for (const m of this.monsters.monsters) {
            const mx = m.pos.x - x0, my = m.centerY - y0, mz = m.pos.z - z0;
            let along = mx * a.dx + my * a.dy + mz * a.dz;
            along = along < 0 ? 0 : along > step ? step : along;
            const cx = mx - a.dx * along, cy = my - a.dy * along, cz = mz - a.dz * along;
            const r = m.def.size * 0.6 + 0.2;
            if (cx * cx + cy * cy + cz * cz <= r * r && along <= hitT) { hit = m; hitT = along; }
        }
        const move = hit ? hitT : step;
        const x1 = x0 + a.dx * move, y1 = y0 + a.dy * move, z1 = z0 + a.dz * move;
        this.trail(a, x0, y0, z0, move);
        a.pos.setValue(x1, y1, z1);
        a.travelled += move;
        this.orient(a);

        if (hit) {
            for (let i = 0; i < 14; i++) this.spark(x1, y1, z1, 6, 0.4, 0.2);
            this.monsters.damage(hit, ARROW_DAMAGE);
            return true;
        }
        if (this.blocked(x1, y1, z1)) {
            for (let i = 0; i < 6; i++) this.spark(x1, y1, z1, 3, 0.3, 0.14);
            a.stuck = STUCK_TIME;
            return false;
        }
        return a.travelled >= ARROW_RANGE;
    }

    /** 这个位置是不是地面、树或石头（箭会插在上面） */
    private blocked(x: number, y: number, z: number): boolean {
        const g = groundY(x, z);
        if (y <= g + 0.05) return true;
        const gx = Math.floor(x / CELL), gz = Math.floor(z / CELL);
        const kind = this.nav.kind(gx, gz);
        if (kind === Cell.Rock) return y < g + 1.5;
        if (kind === Cell.Tree) {
            // 只算树干附近，树冠之间的空隙可以穿过去
            const ox = x - (gx + 0.5) * CELL, oz = z - (gz + 0.5) * CELL;
            return y < g + 4 && ox * ox + oz * oz < 0.5 * 0.5;
        }
        return false;
    }

    /** 沿这一帧飞过的线段，每隔 TRAIL_SPACING 撒一颗拖尾粒子 */
    private trail(a: Arrow, x0: number, y0: number, z0: number, move: number) {
        let d = TRAIL_SPACING - a.sinceTrail;
        while (d <= move) {
            const j = () => (Math.random() - 0.5) * 1.2;
            // 粒子从箭尾的位置出来，带一点向后和向四周散开的速度
            const back = 0.5;
            this.particles.emit(x0 + a.dx * (d - back), y0 + a.dy * (d - back), z0 + a.dz * (d - back),
                -a.dx * 1.5 + j(), -a.dy * 1.5 + j() + 0.6, -a.dz * 1.5 + j(),
                0.35 + Math.random() * 0.25, 0.13 + Math.random() * 0.09);
            d += TRAIL_SPACING;
        }
        a.sinceTrail = (a.sinceTrail + move) % TRAIL_SPACING;
    }

    /** 往随机方向迸出一颗火花 */
    private spark(x: number, y: number, z: number, speed: number, life: number, size: number) {
        const a = Math.random() * Math.PI * 2, u = Math.random() * 2 - 1, h = Math.sqrt(1 - u * u);
        const v = speed * (0.4 + Math.random() * 0.6);
        this.particles.emit(x, y, z, Math.cos(a) * h * v, u * v + 1, Math.sin(a) * h * v,
            life * (0.6 + Math.random() * 0.4), size * (0.7 + Math.random() * 0.6));
    }

    /** 让箭头（模型的 +Z）指向飞行方向：把 (0,0,1) 转到 d 的最短旋转 */
    private orient(a: Arrow) {
        const w = 1 + a.dz;
        if (w < 1e-5) this.q.setValue(0, 1, 0, 0);   // 正后方：绕 Y 轴转 180°
        else {
            const n = Math.hypot(a.dy, a.dx, w);
            this.q.setValue(-a.dy / n, a.dx / n, 0, w / n);
        }
        a.node.transform.rotation = this.q;
        a.node.transform.position = a.pos;
    }

    private remove(i: number) {
        this.arrows[i].node.destroy(true);
        this.arrows.splice(i, 1);
    }

    get count() { return this.arrows.length; }
    get particleCount() { return this.particles.count; }
}
