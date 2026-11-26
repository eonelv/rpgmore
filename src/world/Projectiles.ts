import { Monster, MonsterManager } from "./Actors";
import { actorMaterial, arrowMesh } from "./Archer";
import { MeshBuilder, RGB } from "./MeshBuilder";
import { NavGrid } from "./NavGrid";
import { CELL, Cell } from "./WorldConfig";
import { groundY } from "./WorldGen";

/** 箭和石头共用的重力加速度（米/秒²），调小了一些，弧线更好看 */
const GRAVITY = 18;

/** 箭：飞到目标用的时间 = ARROW_T0 + 水平距离 / ARROW_T_PER（秒），距离越远抛得越高 */
const ARROW_T0 = 0.35;
const ARROW_T_PER = 26;
/** 一支箭最多飞多久（没射中东西时） */
const ARROW_MAX_AGE = 4;
/** 飞行中的箭比手里的放大一些，远处也看得清 */
const ARROW_SCALE = 1.5;
/** 射中地面/树后插在上面停留的时间 */
const STUCK_TIME = 1.5;
const ARROW_DAMAGE = 1;
/** 拖尾：每飞这么远撒一颗粒子 */
const TRAIL_SPACING = 0.16;

/** 石头：飞行时间 = ROCK_T0 + 水平距离 / ROCK_T_PER，比箭慢、抛得更高，玩家走开就能躲掉 */
const ROCK_T0 = 0.55;
const ROCK_T_PER = 15;
const ROCK_RADIUS = 0.22;
/** 石头离玩家身体中心这么近算砸中 */
const ROCK_HIT_RADIUS = 0.6;
const ROCK_DUST_SPACING = 0.7;

const MAX_PARTICLES = 420;

// ---------------- 粒子 ----------------

/** 粒子种类：glow = 柔和光团，spark = 四角星火花（这两种加色混合），dust = 尘土（半透明混合） */
export type ParticleKind = "glow" | "spark" | "dust";

interface ParticleStyle {
    /** 随寿命依次切换的材质（颜色从亮到暗 / 透明度从高到低） */
    stages: Laya.Material[];
    /** true = 越来越大（尘土散开），false = 越来越小 */
    grow: boolean;
}

interface Particle {
    node: Laya.MeshSprite3D;
    style: ParticleStyle;
    stage: number;
    pos: Laya.Vector3;
    scale: Laya.Vector3;
    vx: number; vy: number; vz: number;
    grav: number;
    life: number; maxLife: number; size: number;
}

const TEX_SIZE = 64;

/** 运行时画一张 64×64 的粒子贴图；f(dx, dy) 返回该像素的亮度/不透明度（0~1），dx、dy ∈ [-1, 1] */
function particleTexture(f: (dx: number, dy: number) => number, premultiply: boolean): Laya.Texture2D {
    const px = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
    for (let y = 0; y < TEX_SIZE; y++)
        for (let x = 0; x < TEX_SIZE; x++) {
            const dx = (x + 0.5) / TEX_SIZE * 2 - 1, dy = (y + 0.5) / TEX_SIZE * 2 - 1;
            const a = Math.max(0, Math.min(1, f(dx, dy)));
            const c = Math.round((premultiply ? a : 1) * 255), i = (y * TEX_SIZE + x) * 4;
            px[i] = px[i + 1] = px[i + 2] = c;
            px[i + 3] = Math.round(a * 255);
        }
    const tex = new Laya.Texture2D(TEX_SIZE, TEX_SIZE, Laya.TextureFormat.R8G8B8A8, true, false, false);
    tex.setPixelsData(px, false, false);
    tex.wrapModeU = Laya.WrapMode.Clamp;
    tex.wrapModeV = Laya.WrapMode.Clamp;
    tex.lock = true;
    return tex;
}

/** 中心亮、边缘平滑衰减到 0 的光团 */
function softFalloff(dx: number, dy: number): number {
    const r = Math.sqrt(dx * dx + dy * dy);
    if (r >= 1) return 0;
    const k = 1 - r;
    return k * k * (0.35 + 0.65 * k) + Math.max(0, 1 - r * 4) * 0.6;   // 柔和外圈 + 很亮的小核心
}

/** 四角星：横竖两道细光芒 + 中心光点 */
function starFalloff(dx: number, dy: number): number {
    const r = Math.sqrt(dx * dx + dy * dy);
    if (r >= 1) return 0;
    const ray = (a: number, b: number) => Math.max(0, 1 - Math.abs(a) * 14) * (1 - Math.abs(b));
    const core = Math.max(0, 1 - r * 3);
    return Math.max(ray(dx, dy), ray(dy, dx)) * (1 - r) + core * core;
}

/** 边缘不规则一点的尘土团 */
function dustFalloff(dx: number, dy: number): number {
    const r = Math.sqrt(dx * dx + dy * dy);
    const a = Math.atan2(dy, dx);
    const edge = 0.8 + 0.12 * Math.sin(a * 5) + 0.08 * Math.sin(a * 9 + 1);
    if (r >= edge) return 0;
    const k = 1 - r / edge;
    return Math.min(1, k * 1.6) * 0.85;
}

function particleMaterial(tex: Laya.Texture2D, mode: Laya.MaterialRenderMode, r: number, g: number, b: number, a: number): Laya.Material {
    const m = new Laya.UnlitMaterial();
    m.albedoTexture = tex;
    m.albedoColor = new Laya.Color(r, g, b, a);
    m.materialRenderMode = mode;
    m.cull = Laya.RenderState.CULL_NONE;
    m.lock = true;
    return m;
}

/**
 * 粒子池：始终朝向镜头的面片（广告牌）。光团和火花用加色混合，叠在一起越叠越亮；尘土用半透明混合。
 * 颜色/透明度随寿命变化：每种粒子有几档材质，按剩余寿命切换（所有粒子共用这几个材质，可以合批），节点循环使用
 */
export class ParticlePool {
    private live: Particle[] = [];
    private free: Particle[] = [];
    private mesh: Laya.Mesh;
    private styles: Record<ParticleKind, ParticleStyle>;

    constructor(private scene: Laya.Scene3D, private camera: Laya.Camera) {
        this.mesh = Laya.PrimitiveMesh.createQuad(1, 1);
        this.mesh.lock = true;
        const add = Laya.MaterialRenderMode.RENDERMODE_ADDTIVE, blend = Laya.MaterialRenderMode.RENDERMODE_TRANSPARENT;
        const glowTex = particleTexture(softFalloff, true);
        const starTex = particleTexture(starFalloff, true);
        const dustTex = particleTexture(dustFalloff, false);
        // 金色魔法光：白热 → 金 → 橙 → 暗红，最后几乎不可见
        const warm: RGB[] = [[1, 0.97, 0.82], [1, 0.8, 0.38], [0.95, 0.48, 0.16], [0.45, 0.16, 0.06]];
        this.styles = {
            glow: { stages: warm.map(c => particleMaterial(glowTex, add, c[0], c[1], c[2], 1)), grow: false },
            spark: { stages: warm.map(c => particleMaterial(starTex, add, c[0], c[1], c[2], 1)), grow: false },
            dust: { stages: [0.55, 0.4, 0.25, 0.1].map(a => particleMaterial(dustTex, blend, 0.62, 0.54, 0.44, a)), grow: true },
        };
    }

    emit(kind: ParticleKind, x: number, y: number, z: number, vx: number, vy: number, vz: number,
        life: number, size: number, grav = 0) {
        let p = this.free.pop();
        if (!p) {
            if (this.live.length >= MAX_PARTICLES) return;
            const node = new Laya.MeshSprite3D(this.mesh);
            node.meshRenderer.castShadow = false;
            node.meshRenderer.receiveShadow = false;
            this.scene.addChild(node);
            p = { node, style: null!, stage: -1, pos: new Laya.Vector3(), scale: new Laya.Vector3(), vx: 0, vy: 0, vz: 0, grav: 0, life: 0, maxLife: 1, size: 0 };
        }
        p.style = this.styles[kind];
        p.stage = -1;
        p.pos.setValue(x, y, z);
        p.vx = vx; p.vy = vy; p.vz = vz;
        p.grav = grav;
        p.life = p.maxLife = life;
        p.size = size;
        p.node.active = true;
        this.live.push(p);
        this.place(p, this.camera.transform.rotation);
    }

    update(dt: number) {
        const drag = Math.exp(-dt * 3);
        const rot = this.camera.transform.rotation;
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
            p.vx *= drag; p.vy = p.vy * drag - p.grav * dt; p.vz *= drag;
            p.pos.setValue(p.pos.x + p.vx * dt, p.pos.y + p.vy * dt, p.pos.z + p.vz * dt);
            this.place(p, rot);
        }
    }

    /** 按剩余寿命更新材质档位、大小，并转向镜头 */
    private place(p: Particle, rot: Laya.Quaternion) {
        const age = 1 - p.life / p.maxLife;
        const stages = p.style.stages;
        const st = Math.min(stages.length - 1, Math.floor(age * stages.length));
        if (st !== p.stage) { p.stage = st; p.node.meshRenderer.sharedMaterial = stages[st]; }
        // 先很快长到原大小（不会凭空“蹦”出来），之后缩小 / 尘土继续散开
        const s = p.size * Math.min(1, age * 8) * (p.style.grow ? 1 + 1.6 * age : 1 - age * 0.85);
        p.scale.setValue(s, s, s);
        p.node.transform.position = p.pos;
        p.node.transform.rotation = rot;
        p.node.transform.localScale = p.scale;
    }

    /** 往随机方向迸出一颗粒子（速度 0.4~1 倍 speed，寿命、大小也随机浮动） */
    burst(kind: ParticleKind, x: number, y: number, z: number, speed: number, life: number, size: number, up = 0, grav = 0) {
        const a = Math.random() * Math.PI * 2, u = Math.random() * 2 - 1, h = Math.sqrt(1 - u * u);
        const v = speed * (0.4 + Math.random() * 0.6);
        this.emit(kind, x, y, z, Math.cos(a) * h * v, u * v + up, Math.sin(a) * h * v,
            life * (0.6 + Math.random() * 0.4), size * (0.7 + Math.random() * 0.6), grav);
    }

    get count() { return this.live.length; }
}

// ---------------- 弹道 ----------------

/** 这个位置是不是地面、树或石头（箭会插在上面，石头会碎掉） */
function blocked(nav: NavGrid, x: number, y: number, z: number): boolean {
    const g = groundY(x, z);
    if (y <= g + 0.05) return true;
    const gx = Math.floor(x / CELL), gz = Math.floor(z / CELL);
    const kind = nav.kind(gx, gz);
    if (kind === Cell.Rock) return y < g + 1.5;
    if (kind === Cell.Tree) {
        // 只算树干附近，树冠之间的空隙可以穿过去
        const ox = x - (gx + 0.5) * CELL, oz = z - (gz + 0.5) * CELL;
        return y < g + 4 && ox * ox + oz * oz < 0.5 * 0.5;
    }
    return false;
}

/** 抛体：位置、速度，以及要在 tLeft 秒后落到的目标点 */
interface Ballistic {
    pos: Laya.Vector3;
    vx: number; vy: number; vz: number;
    /** 离预定落点还剩多少秒（<= 0 后只按重力自由飞） */
    tLeft: number;
}

/** 算出从当前位置出发、正好 t 秒后落到 (tx,ty,tz) 的初速度（受重力的抛物线） */
function aimAt(b: Ballistic, tx: number, ty: number, tz: number, t: number) {
    b.vx = (tx - b.pos.x) / t;
    b.vz = (tz - b.pos.z) / t;
    b.vy = (ty - b.pos.y) / t + 0.5 * GRAVITY * t;
    b.tLeft = t;
}

/** 按重力飞 dt 秒，返回这一帧飞过的位移（调用方用它做线段碰撞） */
function integrate(b: Ballistic, dt: number, out: number[]) {
    out[0] = b.vx * dt;
    out[1] = b.vy * dt - 0.5 * GRAVITY * dt * dt;
    out[2] = b.vz * dt;
    b.vy -= GRAVITY * dt;
    b.tLeft -= dt;
}

/** 线段 p0 + d·s（s ∈ [0, len]，d 是单位向量）上离点 (px,py,pz) 最近的位置 s 和距离平方 */
function closestOnSegment(x0: number, y0: number, z0: number, dx: number, dy: number, dz: number, len: number,
    px: number, py: number, pz: number): [number, number] {
    const mx = px - x0, my = py - y0, mz = pz - z0;
    let s = mx * dx + my * dy + mz * dz;
    s = s < 0 ? 0 : s > len ? len : s;
    const cx = mx - dx * s, cy = my - dy * s, cz = mz - dz * s;
    return [s, cx * cx + cy * cy + cz * cz];
}

// ---------------- 箭 ----------------

interface Arrow extends Ballistic {
    node: Laya.MeshSprite3D;
    /** 追踪的目标（射出时锁定的怪物）：每帧按它当前位置重新瞄准落点，弧线保持平滑 */
    target: Monster | null;
    age: number;
    /** 离上一颗拖尾粒子飞了多远 */
    sinceTrail: number;
    /** > 0：已经插在地上/树上，倒计时结束后消失 */
    stuck: number;
}

/** 管理所有飞行中的箭：向上抛射的弧线、追踪、命中判定、粒子拖尾 */
export class ArrowManager {
    private arrows: Arrow[] = [];
    private q = new Laya.Quaternion();
    private scale = new Laya.Vector3(ARROW_SCALE, ARROW_SCALE, ARROW_SCALE);
    private step = [0, 0, 0];

    constructor(private scene: Laya.Scene3D, private nav: NavGrid, private monsters: MonsterManager,
        private particles: ParticlePool) { }

    /** 从 from 抛射一支箭，落到 (tx,ty,tz)；target 不为空时落点会跟着它移动 */
    fire(from: Laya.Vector3, tx: number, ty: number, tz: number, target: Monster | null) {
        const node = new Laya.MeshSprite3D(arrowMesh());
        node.meshRenderer.sharedMaterial = actorMaterial();
        node.meshRenderer.castShadow = false;
        node.transform.localScale = this.scale;
        this.scene.addChild(node);
        const a: Arrow = {
            node, pos: new Laya.Vector3(from.x, from.y, from.z), vx: 0, vy: 0, vz: 0, tLeft: 0,
            target, age: 0, sinceTrail: 0, stuck: 0,
        };
        const t = ARROW_T0 + Math.hypot(tx - from.x, tz - from.z) / ARROW_T_PER;
        aimAt(a, tx, ty, tz, t);
        this.arrows.push(a);
        this.orient(a);
        // 离弦的闪光和一小团火花
        const P = this.particles;
        P.emit("glow", from.x, from.y, from.z, 0, 0, 0, 0.16, 0.9);
        for (let i = 0; i < 8; i++) P.burst("spark", from.x, from.y, from.z, 3, 0.35, 0.28, 0.5, 3);
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
    }

    /** 飞一帧；返回 true = 这支箭该消失了（射中怪物或飞太久） */
    private fly(a: Arrow, dt: number): boolean {
        a.age += dt;
        // 追踪：按目标当前位置、剩余时间重新算初速度（目标死了就按原来的抛物线飞）
        const t = a.target;
        if (t && t.dead) a.target = null;
        else if (t && a.tLeft > dt) aimAt(a, t.pos.x, t.centerY, t.pos.z, a.tLeft);

        const x0 = a.pos.x, y0 = a.pos.y, z0 = a.pos.z;
        const st = this.step;
        integrate(a, dt, st);
        const len = Math.hypot(st[0], st[1], st[2]);
        if (len < 1e-6) return a.age >= ARROW_MAX_AGE;
        const dx = st[0] / len, dy = st[1] / len, dz = st[2] / len;

        // 这一帧飞过的线段上，最先碰到的怪物
        let hit: Monster | null = null, hitS = len;
        for (const m of this.monsters.monsters) {
            const [s, d2] = closestOnSegment(x0, y0, z0, dx, dy, dz, len, m.pos.x, m.centerY, m.pos.z);
            const r = m.def.size * 0.6 + 0.2;
            if (d2 <= r * r && s <= hitS) { hit = m; hitS = s; }
        }
        const move = hit ? hitS : len;
        const x1 = x0 + dx * move, y1 = y0 + dy * move, z1 = z0 + dz * move;
        this.trail(a, x0, y0, z0, dx, dy, dz, move);
        a.pos.setValue(x1, y1, z1);
        this.orient(a);

        const P = this.particles;
        if (hit) {
            P.emit("glow", x1, y1, z1, 0, 0, 0, 0.22, 1.6);
            for (let i = 0; i < 14; i++) P.burst("spark", x1, y1, z1, 7, 0.45, 0.35, 1, 6);
            // 一圈水平散开的光团
            for (let i = 0; i < 10; i++) {
                const ang = (i / 10) * Math.PI * 2;
                P.emit("glow", x1, y1, z1, Math.cos(ang) * 5, 0.3, Math.sin(ang) * 5, 0.3, 0.45);
            }
            this.monsters.damage(hit, ARROW_DAMAGE);
            return true;
        }
        if (blocked(this.nav, x1, y1, z1)) {
            P.emit("glow", x1, y1, z1, 0, 0, 0, 0.15, 0.7);
            for (let i = 0; i < 6; i++) P.burst("spark", x1, y1, z1, 3.5, 0.3, 0.22, 1.5, 8);
            for (let i = 0; i < 3; i++) P.burst("dust", x1, y1 + 0.1, z1, 0.8, 0.6, 0.45, 0.6);
            a.stuck = STUCK_TIME;
            return false;
        }
        return a.age >= ARROW_MAX_AGE;
    }

    /** 沿这一帧飞过的线段，每隔 TRAIL_SPACING 撒拖尾：一串紧贴箭尾的光团，偶尔飘出一颗火星 */
    private trail(a: Arrow, x0: number, y0: number, z0: number, dx: number, dy: number, dz: number, move: number) {
        const P = this.particles;
        let d = TRAIL_SPACING - a.sinceTrail;
        while (d <= move) {
            const back = d - 0.45;   // 从箭尾的位置出来
            const x = x0 + dx * back, y = y0 + dy * back, z = z0 + dz * back;
            P.emit("glow", x, y, z, -dx * 0.6, -dy * 0.6 + 0.15, -dz * 0.6, 0.28, 0.32);
            if (Math.random() < 0.35) {
                const j = () => (Math.random() - 0.5) * 1.6;
                P.emit("spark", x, y, z, -dx * 1.2 + j(), -dy * 1.2 + j() + 0.4, -dz * 1.2 + j(),
                    0.45 + Math.random() * 0.3, 0.16 + Math.random() * 0.1, 2);
            }
            d += TRAIL_SPACING;
        }
        a.sinceTrail = (a.sinceTrail + move) % TRAIL_SPACING;
    }

    /** 让箭头（模型的 +Z）指向飞行方向（当前速度）：把 (0,0,1) 转到 v 的最短旋转 */
    private orient(a: Arrow) {
        const l = Math.hypot(a.vx, a.vy, a.vz) || 1;
        const vx = a.vx / l, vy = a.vy / l, vz = a.vz / l;
        const w = 1 + vz;
        if (w < 1e-5) this.q.setValue(0, 1, 0, 0);   // 正后方：绕 Y 轴转 180°
        else {
            const n = Math.hypot(vy, vx, w);
            this.q.setValue(-vy / n, vx / n, 0, w / n);
        }
        a.node.transform.rotation = this.q;
        a.node.transform.position = a.pos;
    }

    private remove(i: number) {
        this.arrows[i].node.destroy(true);
        this.arrows.splice(i, 1);
    }

    get count() { return this.arrows.length; }
}

// ---------------- 怪物扔的石头 ----------------

interface Rock extends Ballistic {
    node: Laya.MeshSprite3D;
    rot: Laya.Vector3;
    spinX: number; spinY: number;
    sinceDust: number;
}

let rockAssets: { mesh: Laya.Mesh; mat: Laya.Material } | null = null;
function sharedRock() {
    if (!rockAssets) {
        const mb = new MeshBuilder();
        let seed = 7;
        mb.boulder(0, -ROCK_RADIUS * 0.8, 0, ROCK_RADIUS, [0.55, 0.5, 0.45], i => {
            seed = (seed * 16807 + i * 31) % 2147483647;
            return (seed % 1000) / 1000;
        });
        const mesh = mb.build()[0];
        mesh.lock = true;
        const mat = new Laya.BlinnPhongMaterial();
        mat.enableVertexColor = true;
        mat.albedoColor = new Laya.Color(1, 1, 1, 1);
        mat.specularColor = new Laya.Color(0, 0, 0, 1);
        // boulder 不画底面，石头在空中翻滚时底部会露出来：双面渲染，看到的是内壁而不是空洞
        mat.cull = Laya.RenderState.CULL_NONE;
        mat.lock = true;
        rockAssets = { mesh, mat };
    }
    return rockAssets;
}

/** 管理怪物扔出的石头：高抛的弧线，砸中玩家、落地或撞到树/石头就碎成一团尘土 */
export class RockManager {
    private rocks: Rock[] = [];
    private step = [0, 0, 0];

    constructor(private scene: Laya.Scene3D, private nav: NavGrid, private particles: ParticlePool) { }

    /** 从 from 扔一块石头，落到 (tx,ty,tz)（扔出时玩家所在的位置，不预判，玩家移动就能躲开） */
    throw(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number) {
        const a = sharedRock();
        const node = new Laya.MeshSprite3D(a.mesh);
        node.meshRenderer.sharedMaterial = a.mat;
        this.scene.addChild(node);
        const r: Rock = {
            node, pos: new Laya.Vector3(fx, fy, fz), vx: 0, vy: 0, vz: 0, tLeft: 0,
            rot: new Laya.Vector3(Math.random() * 360, Math.random() * 360, 0),
            spinX: 300 + Math.random() * 300, spinY: 200 + Math.random() * 200, sinceDust: 0,
        };
        aimAt(r, tx, ty, tz, ROCK_T0 + Math.hypot(tx - fx, tz - fz) / ROCK_T_PER);
        node.transform.position = r.pos;
        node.transform.localRotationEuler = r.rot;
        this.rocks.push(r);
        for (let i = 0; i < 4; i++) this.particles.burst("dust", fx, fy, fz, 1, 0.45, 0.35, 0.5);
    }

    /** 飞一帧；(px,py,pz) 是玩家身体中心。返回这一帧砸中玩家的石头数 */
    update(dt: number, px: number, py: number, pz: number): number {
        let hits = 0;
        const st = this.step, P = this.particles;
        for (let i = this.rocks.length - 1; i >= 0; i--) {
            const r = this.rocks[i];
            const x0 = r.pos.x, y0 = r.pos.y, z0 = r.pos.z;
            integrate(r, dt, st);
            const len = Math.hypot(st[0], st[1], st[2]) || 1e-6;
            const [s, d2] = closestOnSegment(x0, y0, z0, st[0] / len, st[1] / len, st[2] / len, len, px, py, pz);
            const hitPlayer = d2 <= ROCK_HIT_RADIUS * ROCK_HIT_RADIUS;
            const move = hitPlayer ? s : len;
            const x1 = x0 + st[0] / len * move, y1 = y0 + st[1] / len * move, z1 = z0 + st[2] / len * move;
            r.pos.setValue(x1, y1, z1);

            // 飞行中偶尔掉一点碎屑
            r.sinceDust += move;
            if (r.sinceDust >= ROCK_DUST_SPACING) {
                r.sinceDust = 0;
                P.emit("dust", x1, y1, z1, 0, 0.2, 0, 0.4, 0.22);
            }

            if (hitPlayer || blocked(this.nav, x1, y1, z1)) {
                const gy = Math.max(y1, groundY(x1, z1) + 0.1);
                for (let k = 0; k < 9; k++) P.burst("dust", x1, gy, z1, 2.6, 0.7, 0.55, 1.2, 2);
                if (hitPlayer) {
                    hits++;
                    for (let k = 0; k < 6; k++) P.burst("spark", x1, y1, z1, 4, 0.25, 0.22, 0.5, 5);
                }
                r.node.destroy(true);
                this.rocks.splice(i, 1);
                continue;
            }
            r.rot.setValue(r.rot.x + r.spinX * dt, r.rot.y + r.spinY * dt, 0);
            r.node.transform.position = r.pos;
            r.node.transform.localRotationEuler = r.rot;
        }
        return hits;
    }

    get count() { return this.rocks.length; }
}
