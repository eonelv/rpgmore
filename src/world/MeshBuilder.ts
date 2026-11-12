/**
 * 低多边形网格构建器：顶点格式 POSITION + NORMAL + COLOR（可选 + UV），平面着色（每个三角形独立法线）。
 * 一个块里的地形和所有物件合并成少量 Mesh，大量物体只需很少的 draw call。
 * 单个 Mesh 使用 16 位索引，顶点数接近上限时自动切分出新的 Mesh。
 *
 * 显存：构建时每个顶点是 10 或 12 个 float，上传前压缩成 20 / 28 字节
 * （位置 3×float、法线 4×int8、颜色 4×uint8、UV 2×float），比全用 float 的 40 / 48 字节少四成。
 */
const FLOATS_PER_VERTEX = 10;
const MAX_VERTS = 65000;

let packedOK: boolean | undefined;
/** 引擎是否支持压缩用到的顶点格式（归一化的 int8 / uint8）；不支持就退回全 float 的格式 */
function packedSupported(): boolean {
    if (packedOK === undefined) {
        try {
            packedOK = !!Laya.VertexElementFormat.getElementInfos("nbyte4")
                && !!Laya.VertexElementFormat.getElementInfos("ubyte4");
        } catch (e) {
            packedOK = false;
        }
    }
    return packedOK;
}

const packedDecls: Laya.VertexDeclaration[] = [];
/** 压缩顶点格式的声明：位置 float×3 | 法线 int8×4（归一化）| 颜色 uint8×4（归一化）| UV float×2（可选） */
function packedDecl(withUV: boolean): Laya.VertexDeclaration {
    const k = withUV ? 1 : 0;
    if (!packedDecls[k]) {
        const els = [
            new Laya.VertexElement(0, "vector3", Laya.VertexMesh.MESH_POSITION0),
            new Laya.VertexElement(12, "nbyte4", Laya.VertexMesh.MESH_NORMAL0),
            new Laya.VertexElement(16, "ubyte4", Laya.VertexMesh.MESH_COLOR0),
        ];
        if (withUV) els.push(new Laya.VertexElement(20, "vector2", Laya.VertexMesh.MESH_TEXTURECOORDINATE0));
        packedDecls[k] = new Laya.VertexDeclaration(withUV ? 28 : 20, els);
    }
    return packedDecls[k];
}

function toByte(v: number): number {
    return v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
}

export type RGB = [number, number, number];
const ZERO_UV = [0, 0, 0, 0, 0, 0];
const ONE_ALPHA = [1, 1, 1];

function shadeTop(c: RGB): RGB {
    return [Math.min(1, c[0] * 1.12), Math.min(1, c[1] * 1.12), Math.min(1, c[2] * 1.12)];
}

export class MeshBuilder {
    private verts: number[] = [];
    private idx: number[] = [];
    private count = 0;
    private meshes: Laya.Mesh[] = [];

    /** 每切分出一个新 Mesh 加 1：之前 addVertex 返回的顶点下标从此作废（见 reserve） */
    epoch = 0;

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
        const n0 = this.count;
        this.idx.push(n0, n0 + 1, n0 + 2);
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

    /**
     * 共享顶点的平滑网格（山体）：先 reserve，再用 addVertex 加顶点（自带法线、颜色、alpha、UV），
     * 用 addTri 按顶点下标连成三角形。相邻的面共用顶点，一个四边形平均只多 1 个顶点。
     *
     * reserve(n)：保证接下来 n 个顶点和已有顶点在同一个 Mesh 里。放不下时会切分出新 Mesh、epoch 加 1，
     * 调用方缓存的顶点下标要全部丢掉重新加
     */
    reserve(n: number) {
        if (this.count + n > MAX_VERTS) this.flush();
    }

    /** 添加一个顶点，返回它的下标（只在 epoch 不变时有效） */
    addVertex(x: number, y: number, z: number, nx: number, ny: number, nz: number,
        r: number, g: number, b: number, a: number, u = 0, v = 0): number {
        this.verts.push(x, y, z, nx, ny, nz, r, g, b, a);
        if (this.withUV) this.verts.push(u, v);
        return this.count++;
    }

    /** 用三个顶点下标添加三角形；从正面看过去是顺时针（地面：从上往下看顺时针） */
    addTri(a: number, b: number, c: number) {
        this.idx.push(a, b, c);
    }

    /** 小凸起（花、果子）：底面边长 s 的四棱锥，不画底面，4 个三角形；两个面用 col、两个面用 topCol */
    stud(x: number, y0: number, z: number, s: number, col: RGB, topCol: RGB) {
        const r = s * 0.6, ty = y0 + s * 1.1, ry = y0 + s * 0.3;
        this.tri(x - r, y0, z - r, x + r, y0, z - r, x, ty, z, col, x, ry, z);
        this.tri(x + r, y0, z - r, x + r, y0, z + r, x, ty, z, topCol, x, ry, z);
        this.tri(x + r, y0, z + r, x - r, y0, z + r, x, ty, z, col, x, ry, z);
        this.tri(x - r, y0, z + r, x - r, y0, z - r, x, ty, z, topCol, x, ry, z);
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
     * seg：每圈顶点数，大石头用多一些；seg > 8 时多加一圈，顶部更圆，不会是尖锥；
     * seg <= 4 时只有两圈（碎石用，seg×3 个三角形）；
     * smooth：平滑着色（大石头用），三角形数不变，见 smoothRock
     */
    rock(x: number, y0: number, z: number, rx: number, rz: number, h: number, rot: number, col: RGB,
        rand: (i: number) => number, bulge = 1, moss?: RGB, seg = 7, smooth = false) {
        const SEG = seg;
        const levels = seg <= 4 ? [
            { y: -0.2, r: 1.0 },
            { y: 0.6, r: 0.72 * bulge },
        ] : seg > 8 ? [
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
        if (smooth) {
            this.smoothRock(rings, top, ref, col, moss ?? shadeTop(col), rand);
            return;
        }
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

    /**
     * 平滑着色的石头：和 rock 同样的顶点、同样多的三角形，但
     * - 法线按顶点算（周围各面法线按面积加权平均），光照连续过渡，看不出一块块的三角面；
     * - 颜色按顶点算（下面是 col，最上面一圈和顶点是 topCol，各带一点深浅变化），不再每个面一个颜色。
     * 大石头离得近、面又大，平面着色时每个三角形的明暗和颜色都不一样，切面特别显眼。
     * UV 仍按每个三角形自己的朝向投影，所以顶点不共用
     */
    private smoothRock(rings: number[][][], top: number[], ref: number[], col: RGB, topCol: RGB,
        rand: (i: number) => number) {
        const SEG = rings[0].length, L = rings.length;
        const P: number[][] = [], C: RGB[] = [];
        for (let l = 0; l < L; l++) {
            for (let i = 0; i < SEG; i++) {
                P.push(rings[l][i]);
                const c = l >= 2 && l === L - 1 ? topCol : col;
                const f = 0.93 + rand(70 + l * SEG + i) * 0.14;
                C.push([Math.min(1, c[0] * f), Math.min(1, c[1] * f), Math.min(1, c[2] * f)]);
            }
        }
        const ti = P.length;
        P.push(top);
        C.push(topCol);
        const T: number[] = [];
        for (let l = 0; l < L - 1; l++) {
            const a = l * SEG, b = a + SEG;
            for (let i = 0; i < SEG; i++) {
                const n = (i + 1) % SEG, p = (i + SEG - 1) % SEG;
                T.push(a + i, a + n, b + i, a + i, b + i, b + p);
            }
        }
        const r0 = (L - 1) * SEG;
        for (let i = 0; i < SEG; i++) T.push(r0 + i, r0 + (i + 1) % SEG, ti);

        // 每个面的法线（没有归一化，长度 = 面积 × 2，朝外），累加到三个顶点上
        const N = new Float32Array(P.length * 3);
        const FNm = new Float32Array(T.length);
        for (let t = 0; t < T.length; t += 3) {
            const a = P[T[t]], b = P[T[t + 1]], c = P[T[t + 2]];
            const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
            const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
            let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            const mx = (a[0] + b[0] + c[0]) / 3 - ref[0], my = (a[1] + b[1] + c[1]) / 3 - ref[1],
                mz = (a[2] + b[2] + c[2]) / 3 - ref[2];
            if (nx * mx + ny * my + nz * mz < 0) { nx = -nx; ny = -ny; nz = -nz; }
            FNm[t] = nx; FNm[t + 1] = ny; FNm[t + 2] = nz;
            for (let k = 0; k < 3; k++) {
                const o = T[t + k] * 3;
                N[o] += nx; N[o + 1] += ny; N[o + 2] += nz;
            }
        }
        for (let o = 0; o < N.length; o += 3) {
            const len = Math.hypot(N[o], N[o + 1], N[o + 2]) || 1;
            N[o] /= len; N[o + 1] /= len; N[o + 2] /= len;
        }

        const out = this.verts, wUV = this.withUV;
        for (let t = 0; t < T.length; t += 3) {
            if (this.count + 3 > MAX_VERTS) this.flush();
            const ia = T[t], ib = T[t + 1], ic = T[t + 2];
            const a = P[ia], b = P[ib], c = P[ic];
            const len = Math.hypot(FNm[t], FNm[t + 1], FNm[t + 2]) || 1;
            const fx = FNm[t] / len, fy = FNm[t + 1] / len, fz = FNm[t + 2] / len;
            const uv = wUV && this.uvTile > 0
                ? this.projectUV(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], fx, fy, fz) : ZERO_UV;
            const put = (i: number, k: number) => {
                const p = P[i], col2 = C[i], o = i * 3;
                out.push(p[0], p[1], p[2], N[o], N[o + 1], N[o + 2], col2[0], col2[1], col2[2], 1);
                if (wUV) out.push(uv[k * 2], uv[k * 2 + 1]);
            };
            // 绕序：从法线方向看过去为顺时针（和 tri 一致）。a-b-c 的叉积朝外时要交换 b、c
            const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
            const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
            const dot = (uy * vz - uz * vy) * fx + (uz * vx - ux * vz) * fy + (ux * vy - uy * vx) * fz;
            if (dot < 0) { put(ia, 0); put(ib, 1); put(ic, 2); }
            else { put(ia, 0); put(ic, 2); put(ib, 1); }
            const n0 = this.count;
            this.idx.push(n0, n0 + 1, n0 + 2);
            this.count += 3;
        }
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
        if (this.count + 4 > MAX_VERTS) this.flush();
        const u0 = (cell & 1) * 0.5 + 0.004, v0 = ((cell >> 1) & 1) * 0.5 + 0.004, d = 0.492;
        const out = this.verts;
        const vert = (su: number, sv: number) => {
            out.push(p[0] + (u[0] * su + v[0] * sv) * half, p[1] + (u[1] * su + v[1] * sv) * half,
                p[2] + (u[2] * su + v[2] * sv) * half, n[0], n[1], n[2], col[0], col[1], col[2], 1);
            if (this.withUV) out.push(u0 + (su + 1) * 0.5 * d, v0 + (sv + 1) * 0.5 * d);
        };
        // 四个角共用顶点：4 个顶点 + 6 个索引
        vert(-1, -1); vert(1, -1); vert(1, 1); vert(-1, 1);
        const n0 = this.count;
        this.idx.push(n0, n0 + 1, n0 + 2, n0, n0 + 2, n0 + 3);
        this.count += 4;
    }

    get vertexCount() { return this.count; }

    private flush() {
        if (this.count === 0) return;
        const n = this.count, src = this.verts, t = this.withUV;
        let decl: Laya.VertexDeclaration;
        let vertices: Float32Array;
        if (packedSupported()) {
            // 压缩：法线和颜色各占 4 字节。同一块内存用 float / int8 / uint8 三种视图写入
            const fpv = t ? 12 : 10, stride = t ? 28 : 20, w = stride / 4;
            const buf = new ArrayBuffer(n * stride);
            const f32 = new Float32Array(buf), i8 = new Int8Array(buf), u8 = new Uint8Array(buf);
            for (let i = 0, s = 0; i < n; i++, s += fpv) {
                const f = i * w, b = i * stride;
                f32[f] = src[s]; f32[f + 1] = src[s + 1]; f32[f + 2] = src[s + 2];
                i8[b + 12] = Math.round(src[s + 3] * 127);
                i8[b + 13] = Math.round(src[s + 4] * 127);
                i8[b + 14] = Math.round(src[s + 5] * 127);
                u8[b + 16] = toByte(src[s + 6]); u8[b + 17] = toByte(src[s + 7]);
                u8[b + 18] = toByte(src[s + 8]); u8[b + 19] = toByte(src[s + 9]);
                if (t) { f32[f + 5] = src[s + 10]; f32[f + 6] = src[s + 11]; }
            }
            decl = packedDecl(t);
            vertices = f32;
        } else {
            decl = Laya.VertexMesh.getVertexDeclaration(t ? "POSITION,NORMAL,COLOR,UV" : "POSITION,NORMAL,COLOR");
            vertices = new Float32Array(src);
        }
        this.meshes.push(Laya.PrimitiveMesh._createMesh(decl, vertices, new Uint16Array(this.idx)));
        this.verts = [];
        this.idx = [];
        this.count = 0;
        this.epoch++;
    }

    build(): Laya.Mesh[] {
        this.flush();
        const out = this.meshes;
        this.meshes = [];
        return out;
    }
}

export { FLOATS_PER_VERTEX };
