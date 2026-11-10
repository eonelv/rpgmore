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
