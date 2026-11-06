import { hash2 } from "./Noise";
import { createWaterMaterial } from "./WaterShader";
import { MeshBuilder, RGB } from "./MeshBuilder";
import { CELL, CHUNK_CELLS, CHUNK_SIZE, Cell, SEED } from "./WorldConfig";
import { ChunkData, WATER_Y, WALK_MIN_Y, terrainHeight } from "./WorldGen";

export const COLORS: Record<number, RGB> = {
    [Cell.Grass]: [0.36, 0.62, 0.30],
    [Cell.Sand]: [0.86, 0.80, 0.55],
    [Cell.Road]: [0.62, 0.50, 0.34],
    [Cell.Bridge]: [0.55, 0.38, 0.22],
    [Cell.Water]: [0.45, 0.42, 0.30],   // 水底
    [Cell.Rock]: [0.50, 0.50, 0.52],
    [Cell.Tree]: [0.30, 0.55, 0.26],
    [Cell.Bush]: [0.33, 0.58, 0.28],
    [Cell.Stump]: [0.40, 0.58, 0.28],
    [Cell.Mountain]: [0.52, 0.49, 0.45],   // 小地图用的颜色，3D 中按高度另行着色
};
const MTN_GRASS: RGB = [0.34, 0.52, 0.28];
const MTN_ROCK: RGB = [0.50, 0.47, 0.43];
const MTN_ROCK_HI: RGB = [0.60, 0.58, 0.56];
const SNOW: RGB = [0.94, 0.95, 0.98];
/** 雪线（米） */
const SNOW_LINE = 24;

function mix(a: RGB, b: RGB, t: number): RGB {
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** 山体格子的颜色：山脚草地 -> 岩石 -> 积雪；坡度越陡岩石越多 */
function mountainColor(h: number, slope: number, jitter: number): RGB {
    const rockiness = (h - 2) / 6 + slope * 0.6;
    let c = mix(MTN_GRASS, MTN_ROCK, rockiness);
    c = mix(c, MTN_ROCK_HI, (h - 10) / 14);
    // 雪线附近犬牙交错，陡坡上积不住雪
    const snow = (h - SNOW_LINE + jitter * 4) / 3 - slope * 0.8;
    return mix(c, SNOW, snow);
}
const TRUNK: RGB = [0.40, 0.27, 0.16];
const LEAF: RGB = [0.16, 0.42, 0.20];
const BUSH: RGB = [0.22, 0.50, 0.22];
const ROCK: RGB = [0.46, 0.46, 0.50];

function shade(c: RGB, f: number): RGB {
    return [Math.min(1, c[0] * f), Math.min(1, c[1] * f), Math.min(1, c[2] * f)];
}

/** 把一个块的数据构建成渲染网格（地形 + 树/石头/灌木/桥），按“每帧时间预算”调用 */
export function buildChunkMeshes(data: ChunkData): Laya.Mesh[] {
    const mb = new MeshBuilder();
    const gx0 = data.cx * CHUNK_CELLS, gz0 = data.cz * CHUNK_CELLS;
    const N = CHUNK_CELLS;

    // 顶点高度（(N+1)x(N+1)），用世界坐标计算，相邻块共享边缘高度，没有接缝
    const H = new Float32Array((N + 1) * (N + 1));
    for (let z = 0; z <= N; z++)
        for (let x = 0; x <= N; x++)
            H[z * (N + 1) + x] = terrainHeight((gx0 + x) * CELL, (gz0 + z) * CELL);

    for (let lz = 0; lz < N; lz++) {
        for (let lx = 0; lx < N; lx++) {
            const kind = data.kindLocal(lx, lz);
            const gx = gx0 + lx, gz = gz0 + lz;
            const x0 = gx * CELL, x1 = x0 + CELL, z0 = gz * CELL, z1 = z0 + CELL;
            let h00 = H[lz * (N + 1) + lx], h10 = H[lz * (N + 1) + lx + 1];
            let h01 = H[(lz + 1) * (N + 1) + lx], h11 = H[(lz + 1) * (N + 1) + lx + 1];
            if (kind === Cell.Road) {
                // 道路压平一点，并且不低于可走高度
                h00 = Math.max(h00, WALK_MIN_Y) - 0.02; h10 = Math.max(h10, WALK_MIN_Y) - 0.02;
                h01 = Math.max(h01, WALK_MIN_Y) - 0.02; h11 = Math.max(h11, WALK_MIN_Y) - 0.02;
            }
            const jitter = hash2(gx, gz, SEED + 3);
            let col: RGB;
            if (kind === Cell.Mountain) {
                const hAvg = (h00 + h10 + h01 + h11) / 4;
                const slope = (Math.max(h00, h10, h01, h11) - Math.min(h00, h10, h01, h11)) / CELL;
                col = shade(mountainColor(hAvg, slope, jitter), 0.94 + jitter * 0.12);
            } else {
                col = shade(COLORS[kind], 0.92 + jitter * 0.16);
            }
            const cxw = (x0 + x1) / 2, czw = (z0 + z1) / 2;
            const ref = [cxw, -1000, czw];   // 参考点在下方 => 法线朝上
            mb.quad([x0, h00, z0], [x1, h10, z0], [x1, h11, z1], [x0, h01, z1], col, ref);

            const baseY = Math.max(Math.min(h00, h10, h01, h11), WALK_MIN_Y - 0.3);
            const r = hash2(gx, gz, SEED + 99);
            switch (kind) {
                case Cell.Tree: {
                    const s = 0.8 + r * 0.6;
                    mb.box(cxw, baseY, czw, 0.35 * s, 1.2 * s, 0.35 * s, TRUNK);
                    mb.cone(cxw, baseY + 1.0 * s, czw, 1.0 * s, 2.4 * s, LEAF, 6, r * 3);
                    mb.cone(cxw, baseY + 2.0 * s, czw, 0.7 * s, 1.8 * s, shade(LEAF, 1.15), 6, r * 5);
                    break;
                }
                case Cell.Rock: {
                    const s = 0.9 + r * 0.8;
                    mb.box(cxw, baseY - 0.2, czw, CELL * 0.9, 1.2 * s, CELL * 0.85, ROCK, shade(ROCK, 1.1));
                    mb.box(cxw + 0.2, baseY + 0.9 * s, czw - 0.1, CELL * 0.55, 0.7 * s, CELL * 0.5, shade(ROCK, 0.92));
                    break;
                }
                case Cell.Bush:
                    mb.box(cxw, baseY, czw, CELL * 0.85, 0.9 + r * 0.4, CELL * 0.85, BUSH, shade(BUSH, 1.15));
                    break;
                case Cell.Stump:
                    mb.box(cxw, baseY, czw, 0.45, 0.3, 0.45, TRUNK, [0.75, 0.6, 0.4]);
                    break;
                case Cell.Bridge:
                    mb.box(cxw, WALK_MIN_Y - 0.25, czw, CELL, 0.25, CELL, COLORS[Cell.Bridge], shade(COLORS[Cell.Bridge], 1.1));
                    break;
            }
        }
    }
    return mb.build();
}

/** 水深达到这个值（米）时视为最深颜色 */
const WATER_FULL_DEPTH = 2.5;

/**
 * 块 (cx,cz) 的水面网格（世界坐标），只覆盖有顶点低于水位的格子；没有水返回 null。
 * 顶点色 r = 水深 0~1，水面 shader 用它混合深浅颜色和岸边泡沫。
 */
export function buildWaterMesh(cx: number, cz: number): Laya.Mesh | null {
    const N = CHUNK_CELLS;
    const gx0 = cx * CHUNK_CELLS, gz0 = cz * CHUNK_CELLS;
    const D = new Float32Array((N + 1) * (N + 1));
    for (let z = 0; z <= N; z++)
        for (let x = 0; x <= N; x++)
            D[z * (N + 1) + x] = (WATER_Y - terrainHeight((gx0 + x) * CELL, (gz0 + z) * CELL)) / WATER_FULL_DEPTH;

    const verts: number[] = [];
    const idx: number[] = [];
    const vmap = new Int32Array((N + 1) * (N + 1)).fill(-1);
    const vert = (x: number, z: number) => {
        const k = z * (N + 1) + x;
        if (vmap[k] < 0) {
            vmap[k] = verts.length / 10;
            const d = Math.max(0, Math.min(1, D[k]));
            verts.push((gx0 + x) * CELL, WATER_Y, (gz0 + z) * CELL, 0, 1, 0, d, 0, 0, 1);
        }
        return vmap[k];
    };
    for (let z = 0; z < N; z++) {
        for (let x = 0; x < N; x++) {
            const k = z * (N + 1) + x;
            if (D[k] <= 0 && D[k + 1] <= 0 && D[k + N + 1] <= 0 && D[k + N + 2] <= 0) continue;
            const a = vert(x, z), b = vert(x + 1, z), c = vert(x + 1, z + 1), d = vert(x, z + 1);
            // 从上往下看顺时针（Laya 的正面，与 MeshBuilder 一致）
            idx.push(a, c, d, a, b, c);
        }
    }
    if (idx.length === 0) return null;
    const decl = Laya.VertexMesh.getVertexDeclaration("POSITION,NORMAL,COLOR");
    return Laya.PrimitiveMesh._createMesh(decl, new Float32Array(verts), new Uint16Array(idx));
}

/** 地形和水面共用的材质（游戏运行和编辑器预览共用） */
export function createWorldMaterials(): { terrain: Laya.BlinnPhongMaterial; water: Laya.Material } {
    const terrain = new Laya.BlinnPhongMaterial();
    terrain.enableVertexColor = true;
    terrain.albedoColor = new Laya.Color(1, 1, 1, 1);
    terrain.specularColor = new Laya.Color(0, 0, 0, 1);
    terrain.lock = true;

    const water = createWaterMaterial();
    water.lock = true;
    return { terrain, water };
}
