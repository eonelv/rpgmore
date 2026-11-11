/**
 * 低多边形网格构建器：顶点格式 POSITION + NORMAL + COLOR（可选 + UV），平面着色（每个三角形独立法线）。
 * 一个块里的地形和所有物件合并成少量 Mesh，大量物体只需很少的 draw call。
 * 单个 Mesh 使用 16 位索引，顶点数接近上限时自动切分出新的 Mesh。
 */
const FLOATS_PER_VERTEX = 10;
const MAX_VERTS = 65000;

export type RGB = [number, number, number];
const ZERO_UV = [0, 0, 0, 0, 0, 0];
const ONE_ALPHA = [1, 1, 1];

function shadeTop(c: RGB): RGB {
    return [Math.min(1, c[0] * 1.12), Math.min(1, c[1] * 1.12), Math.min(1, c[2] * 1.12)];
}

export class MeshBuilder {
    private verts: number[] = [];
    private count = 0;
    private meshes: Laya.Mesh[] = [];

    /** 自动投影 UV 时减去的水平原点（取块的原点，避免远处 UV 过大损失精度） */
    uvOriginX = 0;
    uvOriginZ = 0;

    /**
     * withUV = true 时每个顶点多两个贴图坐标，用于贴图材质。
     * uvTile > 0 时，没有传 uv 的三角形按法线主方向自动投影 UV（一张贴图覆盖 uvTile 米），
     * 任意形状的物件（石头等）不用手算 UV
     */
    constructor(private withUV = false, private uvTile = 0) { }

    /**
     * 添加三角形，法线会被调整为背离参考点 (rx,ry,rz) 的方向。
     * uv = [ua, va, ub, vb, uc, vc]，只在 withUV 时使用；al = 三个顶点的 alpha，默认 1
     */
    tri(ax: number, ay: number, az: number, bx: number, by: number, bz: number,
        cx: number, cy: number, cz: number, col: RGB, rx: number, ry: number, rz: number, uv?: number[], al?: number[]) {
        if (this.count + 3 > MAX_VERTS) this.flush();
        const ux = bx - ax, uy = by - ay, uz = bz - az;
        const vx = cx - ax, vy = cy - ay, vz = cz - az;
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= len; ny /= len; nz /= len;
        const mx = (ax + bx + cx) / 3 - rx, my = (ay + by + cy) / 3 - ry, mz = (az + bz + cz) / 3 - rz;
        const v = this.verts;
        const t = this.withUV;
        const u = uv ?? (t && this.uvTile > 0 ? this.projectUV(ax, ay, az, bx, by, bz, cx, cy, cz, nx, ny, nz) : ZERO_UV);
        const a = al ?? ONE_ALPHA;
        // Laya 的正面是“法线方向看过去为顺时针”（与引擎 PrimitiveMesh.createPlane 一致），
        // 绕序反了会被背面剔除：只能看到物体背面的内壁，地面整个消失
        if (nx * mx + ny * my + nz * mz < 0) {
            nx = -nx; ny = -ny; nz = -nz;
            v.push(ax, ay, az, nx, ny, nz, col[0], col[1], col[2], a[0]); if (t) v.push(u[0], u[1]);
            v.push(bx, by, bz, nx, ny, nz, col[0], col[1], col[2], a[1]); if (t) v.push(u[2], u[3]);
            v.push(cx, cy, cz, nx, ny, nz, col[0], col[1], col[2], a[2]); if (t) v.push(u[4], u[5]);
        } else {
            v.push(ax, ay, az, nx, ny, nz, col[0], col[1], col[2], a[0]); if (t) v.push(u[0], u[1]);
            v.push(cx, cy, cz, nx, ny, nz, col[0], col[1], col[2], a[2]); if (t) v.push(u[4], u[5]);
            v.push(bx, by, bz, nx, ny, nz, col[0], col[1], col[2], a[1]); if (t) v.push(u[2], u[3]);
        }
        this.count += 3;
    }

    /** 按法线主方向把三角形投影到 xz / zy / xy 平面得到 UV（三个顶点同一个投影面，三角形内没有接缝） */
    private projectUV(ax: number, ay: number, az: number, bx: number, by: number, bz: number,
        cx: number, cy: number, cz: number, nx: number, ny: number, nz: number): number[] {
        const k = 1 / this.uvTile, ox = this.uvOriginX, oz = this.uvOriginZ;
        const anx = Math.abs(nx), any = Math.abs(ny), anz = Math.abs(nz);
        if (any >= anx && any >= anz)
            return [(ax - ox) * k, (az - oz) * k, (bx - ox) * k, (bz - oz) * k, (cx - ox) * k, (cz - oz) * k];
        if (anx >= anz)
            return [(az - oz) * k, ay * k, (bz - oz) * k, by * k, (cz - oz) * k, cy * k];
        return [(ax - ox) * k, ay * k, (bx - ox) * k, by * k, (cx - ox) * k, cy * k];
    }

    /** 四边形 a-b-c-d（按顺序围成一圈）；uv = [ua, va, ub, vb, uc, vc, ud, vd]；al = 四个顶点的 alpha */
    quad(a: number[], b: number[], c: number[], d: number[], col: RGB, ref: number[], uv?: number[], al?: number[]) {
        this.tri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], col, ref[0], ref[1], ref[2],
            uv && [uv[0], uv[1], uv[2], uv[3], uv[4], uv[5]], al && [al[0], al[1], al[2]]);
        this.tri(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2], col, ref[0], ref[1], ref[2],
            uv && [uv[0], uv[1], uv[4], uv[5], uv[6], uv[7]], al && [al[0], al[2], al[3]]);
    }

    /** 轴对齐盒子，(x,z) 为底面中心，y0 为底面高度 */
    box(x: number, y0: number, z: number, sx: number, sy: number, sz: number, col: RGB, topCol: RGB = col) {
        const x0 = x - sx / 2, x1 = x + sx / 2, z0 = z - sz / 2, z1 = z + sz / 2, y1 = y0 + sy;
        const ref = [x, y0 + sy / 2, z];
        this.quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], topCol, ref);
        this.quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], col, ref);
        this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], col, ref);
        this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], col, ref);
        this.quad([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], col, ref);
    }

    /**
     * 不规则的低多边形石块（不画底面，底部埋进地里）：两圈扭曲的顶点 + 顶点，
     * 每个面的颜色略有不同，看起来是一块块的岩面
     */
    boulder(x: number, y0: number, z: number, r: number, col: RGB, rand: (i: number) => number) {
        const SEG = 6;
        const ringA: number[][] = [], ringB: number[][] = [];
        const rot = rand(0) * Math.PI * 2;
        const hy = r * (0.9 + rand(1) * 0.6);
        for (let i = 0; i < SEG; i++) {
            const a = rot + (i / SEG) * Math.PI * 2;
            const ra = r * (0.8 + rand(2 + i) * 0.4);
            ringA.push([x + Math.cos(a) * ra, y0 - 0.15, z + Math.sin(a) * ra]);
            const b = a + Math.PI / SEG;
            const rb = r * (0.5 + rand(10 + i) * 0.3);
            ringB.push([x + Math.cos(b) * rb, y0 + hy * (0.5 + rand(20 + i) * 0.25), z + Math.sin(b) * rb]);
        }
        const top = [x + (rand(30) - 0.5) * r * 0.4, y0 + hy, z + (rand(31) - 0.5) * r * 0.4];
        const ref = [x, y0 + hy * 0.35, z];
        const face = (k: number) => {
            const f = 0.86 + rand(40 + k) * 0.24;
            return [Math.min(1, col[0] * f), Math.min(1, col[1] * f), Math.min(1, col[2] * f)] as RGB;
        };
        for (let i = 0; i < SEG; i++) {
            const j = (i + 1) % SEG;
            const a0 = ringA[i], a1 = ringA[j], b0 = ringB[i], bPrev = ringB[(i + SEG - 1) % SEG];
            this.tri(a0[0], a0[1], a0[2], a1[0], a1[1], a1[2], b0[0], b0[1], b0[2], face(i), ref[0], ref[1], ref[2]);
            this.tri(a0[0], a0[1], a0[2], b0[0], b0[1], b0[2], bPrev[0], bPrev[1], bPrev[2], face(i + SEG), ref[0], ref[1], ref[2]);
            // 顶面颜色亮一点
            const t = shadeTop(face(i + 2 * SEG));
            this.tri(b0[0], b0[1], b0[2], ringB[j][0], ringB[j][1], ringB[j][2], top[0], top[1], top[2], t, ref[0], ref[1], ref[2]);
        }
    }

    /**
     * 更圆润、可拉伸的低多边形石头（不画底面，底部埋进地里）。
     * 3 圈顶点 + 顶点，相邻两圈错开半格，形成三角切面；截面是椭圆 (rx, rz)，绕 y 轴转 rot。
     * bulge：中圈相对底圈的鼓出程度（>1 是圆鼓的大石头，<1 是往上收的石柱）；
     * moss：顶部的苔藓颜色（不传则没有苔藓）；
     * seg：每圈顶点数，大石头用多一些；seg > 8 时多加一圈，顶部更圆，不会是尖锥
     */
    rock(x: number, y0: number, z: number, rx: number, rz: number, h: number, rot: number, col: RGB,
        rand: (i: number) => number, bulge = 1, moss?: RGB, seg = 7) {
        const SEG = seg;
        const levels = seg > 8 ? [
            { y: -0.2, r: 1.0 },
            { y: 0.38, r: bulge },
            { y: 0.72, r: 0.78 * bulge },
            { y: 0.93, r: 0.42 * bulge },
        ] : [
            { y: -0.2, r: 1.0 },
            { y: 0.45, r: bulge },
            { y: 0.85, r: 0.55 * bulge },
        ];
        const cr = Math.cos(rot), sr = Math.sin(rot);
        const rings: number[][][] = levels.map((lv, l) => {
            const ring: number[][] = [];
            for (let i = 0; i < SEG; i++) {
                const a = ((i + l * 0.5) / SEG) * Math.PI * 2;
                const j = 0.82 + rand(l * SEG + i) * 0.36;   // 每个顶点的半径扰动
                const lx = Math.cos(a) * rx * lv.r * j, lz = Math.sin(a) * rz * lv.r * j;
                const yy = l === 0 ? lv.y : h * (lv.y + (rand(30 + l * SEG + i) - 0.5) * 0.14);
                ring.push([x + lx * cr - lz * sr, y0 + yy, z + lx * sr + lz * cr]);
            }
            return ring;
        });
        const top = [x + (rand(60) - 0.5) * rx * 0.35, y0 + h, z + (rand(61) - 0.5) * rz * 0.35];
        const ref = [x, y0 + h * 0.4, z];
        let k = 0;
        const face = (c: RGB) => {
            const f = 0.86 + rand(70 + k++) * 0.26;
            return [Math.min(1, c[0] * f), Math.min(1, c[1] * f), Math.min(1, c[2] * f)] as RGB;
        };
        const T = (p: number[], q: number[], s: number[], c: RGB) =>
            this.tri(p[0], p[1], p[2], q[0], q[1], q[2], s[0], s[1], s[2], c, ref[0], ref[1], ref[2]);
        for (let l = 0; l < rings.length - 1; l++) {
            const A = rings[l], B = rings[l + 1];
            // 上半部分（第二段）可能长苔藓
            const upper = moss && l === 1 ? moss : col;
            for (let i = 0; i < SEG; i++) {
                const n = (i + 1) % SEG, p = (i + SEG - 1) % SEG;
                T(A[i], A[n], B[i], face(col));
                T(A[i], B[i], B[p], face(l === 1 && rand(90 + i) < 0.5 ? upper : col));
            }
        }
        const R = rings[rings.length - 1];
        const topCol = moss ?? shadeTop(col);
        for (let i = 0; i < SEG; i++) T(R[i], R[(i + 1) % SEG], top, face(topCol));
    }

    /** 圆锥（不画底面），用于树冠 */
    cone(x: number, y0: number, z: number, r: number, h: number, col: RGB, slices = 6, phase = 0) {
        const ref = [x, y0 + h * 0.3, z];
        for (let i = 0; i < slices; i++) {
            const a0 = phase + (i / slices) * Math.PI * 2, a1 = phase + ((i + 1) / slices) * Math.PI * 2;
            this.tri(x + Math.cos(a0) * r, y0, z + Math.sin(a0) * r,
                x + Math.cos(a1) * r, y0, z + Math.sin(a1) * r,
                x, y0 + h, z, col, ref[0], ref[1], ref[2]);
        }
    }

    /**
     * 树干/树枝：从底面中心 (ax,ay,az) 到顶面中心 (bx,by,bz) 的棱台，只画侧面（sides×2 个三角形）。
     * 截面是水平的，适合往上长、略微倾斜的枝干
     */
    prism(ax: number, ay: number, az: number, r0: number, bx: number, by: number, bz: number, r1: number,
        col: RGB, sides = 4, phase = 0) {
        const ref = [(ax + bx) / 2, (ay + by) / 2, (az + bz) / 2];
        for (let i = 0; i < sides; i++) {
            const a0 = phase + (i / sides) * Math.PI * 2, a1 = phase + ((i + 1) / sides) * Math.PI * 2;
            const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
            this.quad([ax + c0 * r0, ay, az + s0 * r0], [ax + c1 * r0, ay, az + s1 * r0],
                [bx + c1 * r1, by, bz + s1 * r1], [bx + c0 * r1, by, bz + s0 * r1], col, ref);
        }
    }

    /**
     * 低多边形叶团（树冠、灌木）：底尖 + 两圈错开的扭曲顶点 + 顶尖，共 seg×4 个三角形。
     * (x,yc,z) 是中心，rx/ry/rz 是三个方向的半径；底面偏暗，顶面用 topCol
     */
    blob(x: number, yc: number, z: number, rx: number, ry: number, rz: number, col: RGB, topCol: RGB,
        rand: (i: number) => number, seg = 5) {
        const rot = rand(0) * Math.PI * 2;
        const ring = (l: number, y: number, r: number) => {
            const out: number[][] = [];
            for (let i = 0; i < seg; i++) {
                const a = rot + ((i + l * 0.5) / seg) * Math.PI * 2;
                const j = r * (0.84 + rand(1 + l * seg + i) * 0.32);
                out.push([x + Math.cos(a) * rx * j, yc + ry * (y + (rand(20 + l * seg + i) - 0.5) * 0.2), z + Math.sin(a) * rz * j]);
            }
            return out;
        };
        const L = ring(0, -0.28, 1.0), U = ring(1, 0.38, 0.8);
        const bot = [x, yc - ry * 0.8, z];
        const top = [x + (rand(40) - 0.5) * rx * 0.3, yc + ry, z + (rand(41) - 0.5) * rz * 0.3];
        let k = 0;
        const face = (c: RGB, f: number) => {
            f *= 0.9 + rand(50 + k++) * 0.18;
            return [Math.min(1, c[0] * f), Math.min(1, c[1] * f), Math.min(1, c[2] * f)] as RGB;
        };
        const T = (p: number[], q: number[], s: number[], c: RGB) =>
            this.tri(p[0], p[1], p[2], q[0], q[1], q[2], s[0], s[1], s[2], c, x, yc, z);
        for (let i = 0; i < seg; i++) {
            const n = (i + 1) % seg, p = (i + seg - 1) % seg;
            T(bot, L[i], L[n], face(col, 0.72));
            T(L[i], L[n], U[i], face(col, 1));
            T(L[i], U[i], U[p], face(topCol, 0.92));
            T(U[i], U[n], top, face(topCol, 1.05));
        }
    }

    /**
     * 松树的一层枝叶：一圈上小下大的“裙摆”（圆台侧面），配合松枝贴图（双面、alpha 测试）：
     * 贴图的 u 绕一圈重复 uRep 次，v 从上沿到下沿，下沿被贴图裁成参差的松枝。slices×2 个三角形
     */
    skirt(x: number, yTop: number, z: number, rTop: number, yBot: number, rBot: number, col: RGB,
        slices: number, phase: number, uRep: number) {
        const ref = [x, (yTop + yBot) / 2, z];
        for (let i = 0; i < slices; i++) {
            const a0 = phase + (i / slices) * Math.PI * 2, a1 = phase + ((i + 1) / slices) * Math.PI * 2;
            const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
            const u0 = (i / slices) * uRep, u1 = ((i + 1) / slices) * uRep;
            this.quad([x + c0 * rTop, yTop, z + s0 * rTop], [x + c1 * rTop, yTop, z + s1 * rTop],
                [x + c1 * rBot, yBot, z + s1 * rBot], [x + c0 * rBot, yBot, z + s0 * rBot], col, ref,
                [u0, 0.02, u1, 0.02, u1, 0.98, u0, 0.98]);
        }
    }

    /**
     * 一片对折的叶子（中脉凸起，从上面和侧面都看得见）：叶柄在 (bx,by,bz)，叶尖在 (tx,ty,tz)，
     * 最宽处半宽 w、离叶柄 45%，arch 是最宽处往上拱的高度。4 个三角形
     */
    leaf(bx: number, by: number, bz: number, tx: number, ty: number, tz: number, w: number, arch: number, col: RGB) {
        let dx = tx - bx, dz = tz - bz;
        const len = Math.hypot(dx, dz) || 1;
        dx /= len; dz /= len;
        const mx = bx + (tx - bx) * 0.45, my = by + (ty - by) * 0.45 + arch, mz = bz + (tz - bz) * 0.45;
        const fold = w * 0.35;
        const lx = mx - dz * w, lz = mz + dx * w, rx = mx + dz * w, rz = mz - dx * w;
        const ly = my - fold;
        // 参考点在叶子正下方很远处 => 法线朝上
        const qy = my - 100;
        const lc = col, dc: RGB = [col[0] * 0.86, col[1] * 0.86, col[2] * 0.86];
        this.tri(bx, by, bz, lx, ly, lz, mx, my, mz, lc, mx, qy, mz);
        this.tri(lx, ly, lz, tx, ty, tz, mx, my, mz, lc, mx, qy, mz);
        this.tri(bx, by, bz, mx, my, mz, rx, ly, rz, dc, mx, qy, mz);
        this.tri(mx, my, mz, tx, ty, tz, rx, ly, rz, dc, mx, qy, mz);
    }

    /**
     * 棕榈的一片长叶：从叶柄 (bx,by,bz) 沿水平方向 (ca,sa) 伸出 len，先上扬 rise 再下垂到叶柄以下 droop，
     * 是一整条连续的弧形叶片（3 段，叶柄窄、中间最宽、叶尖收尖），沿中脉对折。
     * 正反两面都画（背面法线朝下、自然偏暗），从树下往上看也看得见。共 20 个三角形
     */
    frond(bx: number, by: number, bz: number, ca: number, sa: number, len: number, rise: number, droop: number,
        w: number, col: RGB) {
        const T = [0, 0.3, 0.65, 1], W = [0.3, 1, 0.8, 0];
        const spine: number[][] = [], left: number[][] = [], right: number[][] = [];
        for (let i = 0; i < 4; i++) {
            const t = T[i], hw = W[i] * w;
            const px = bx + ca * len * t, pz = bz + sa * len * t;
            const py = by + 4 * rise * t * (1 - t) - droop * t * t;
            spine.push([px, py, pz]);
            left.push([px - sa * hw, py - hw * 0.4, pz + ca * hw]);
            right.push([px + sa * hw, py - hw * 0.4, pz - ca * hw]);
        }
        const dark: RGB = [col[0] * 0.85, col[1] * 0.85, col[2] * 0.85];
        const both = (p: number[], q: number[], r: number[], c: RGB) => {
            // 参考点在正下方 => 朝上的一面；在正上方 => 朝下的一面
            this.tri(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2], c, p[0], p[1] - 100, p[2]);
            this.tri(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2], c, p[0], p[1] + 100, p[2]);
        };
        for (let i = 0; i < 3; i++) {
            both(spine[i], spine[i + 1], left[i], col);
            both(spine[i], spine[i + 1], right[i], dark);
            if (i < 2) {
                both(left[i], spine[i + 1], left[i + 1], col);
                both(right[i], spine[i + 1], right[i + 1], dark);
            }
        }
    }

    /**
     * 叶簇面片（配合双面、alpha 测试的材质）：中心 p，沿 u、v 两个单位方向各伸出 half 的方片，2 个三角形。
     * 法线由调用方给（一般取树冠中心往外的方向，整个树冠的明暗像一个球，不会一片亮一片暗）；
     * cell 是 2×2 图集里的第几格
     */
    card(p: number[], u: number[], v: number[], half: number, n: number[], col: RGB, cell: number) {
        if (this.count + 6 > MAX_VERTS) this.flush();
        const u0 = (cell & 1) * 0.5 + 0.004, v0 = ((cell >> 1) & 1) * 0.5 + 0.004, d = 0.492;
        const out = this.verts;
        const vert = (su: number, sv: number) => {
            out.push(p[0] + (u[0] * su + v[0] * sv) * half, p[1] + (u[1] * su + v[1] * sv) * half,
                p[2] + (u[2] * su + v[2] * sv) * half, n[0], n[1], n[2], col[0], col[1], col[2], 1);
            if (this.withUV) out.push(u0 + (su + 1) * 0.5 * d, v0 + (sv + 1) * 0.5 * d);
        };
        vert(-1, -1); vert(1, -1); vert(1, 1);
        vert(-1, -1); vert(1, 1); vert(-1, 1);
        this.count += 6;
    }

    get vertexCount() { return this.count; }

    private flush() {
        if (this.count === 0) return;
        const decl = Laya.VertexMesh.getVertexDeclaration(this.withUV ? "POSITION,NORMAL,COLOR,UV" : "POSITION,NORMAL,COLOR");
        const vertices = new Float32Array(this.verts);
        const indices = new Uint16Array(this.count);
        for (let i = 0; i < this.count; i++) indices[i] = i;
        this.meshes.push(Laya.PrimitiveMesh._createMesh(decl, vertices, indices));
        this.verts = [];
        this.count = 0;
    }

    build(): Laya.Mesh[] {
        this.flush();
        const out = this.meshes;
        this.meshes = [];
        return out;
    }
}

export { FLOATS_PER_VERTEX };
