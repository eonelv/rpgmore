/**
 * 低多边形网格构建器：顶点格式 POSITION + NORMAL + COLOR，平面着色（每个三角形独立法线）。
 * 一个块里的地形和所有物件合并成少量 Mesh，大量物体只需很少的 draw call。
 * 单个 Mesh 使用 16 位索引，顶点数接近上限时自动切分出新的 Mesh。
 */
const FLOATS_PER_VERTEX = 10;
const MAX_VERTS = 65000;

export type RGB = [number, number, number];

export class MeshBuilder {
    private verts: number[] = [];
    private count = 0;
    private meshes: Laya.Mesh[] = [];

    /** 添加三角形，法线会被调整为背离参考点 (rx,ry,rz) 的方向 */
    tri(ax: number, ay: number, az: number, bx: number, by: number, bz: number,
        cx: number, cy: number, cz: number, col: RGB, rx: number, ry: number, rz: number) {
        if (this.count + 3 > MAX_VERTS) this.flush();
        const ux = bx - ax, uy = by - ay, uz = bz - az;
        const vx = cx - ax, vy = cy - ay, vz = cz - az;
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= len; ny /= len; nz /= len;
        const mx = (ax + bx + cx) / 3 - rx, my = (ay + by + cy) / 3 - ry, mz = (az + bz + cz) / 3 - rz;
        const v = this.verts;
        // Laya 的正面是“法线方向看过去为顺时针”（与引擎 PrimitiveMesh.createPlane 一致），
        // 绕序反了会被背面剔除：只能看到物体背面的内壁，地面整个消失
        if (nx * mx + ny * my + nz * mz < 0) {
            nx = -nx; ny = -ny; nz = -nz;
            v.push(ax, ay, az, nx, ny, nz, col[0], col[1], col[2], 1);
            v.push(bx, by, bz, nx, ny, nz, col[0], col[1], col[2], 1);
            v.push(cx, cy, cz, nx, ny, nz, col[0], col[1], col[2], 1);
        } else {
            v.push(ax, ay, az, nx, ny, nz, col[0], col[1], col[2], 1);
            v.push(cx, cy, cz, nx, ny, nz, col[0], col[1], col[2], 1);
            v.push(bx, by, bz, nx, ny, nz, col[0], col[1], col[2], 1);
        }
        this.count += 3;
    }

    /** 四边形 a-b-c-d（按顺序围成一圈） */
    quad(a: number[], b: number[], c: number[], d: number[], col: RGB, ref: number[]) {
        this.tri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], col, ref[0], ref[1], ref[2]);
        this.tri(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2], col, ref[0], ref[1], ref[2]);
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
        const decl = Laya.VertexMesh.getVertexDeclaration("POSITION,NORMAL,COLOR");
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
