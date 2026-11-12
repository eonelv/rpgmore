import { hash2, fbm, valueNoise } from "./Noise";
import { createWaterMaterial } from "./WaterShader";
import { MeshBuilder, RGB } from "./MeshBuilder";
import {
    BARK_TILE, FOLIAGE_TILE, GRASS_TILE, GRAVEL_TILE, ROCK_TILE, SAND_TILE, STONE_TILE, TEX_GAIN,
    barkTexture, foliageTexture, leafCardTexture, pineTexture, graniteTexture, grassTexture, gravelTexture, plankTexture, rockTexture, sandTexture, strataTexture, trailTexture,
} from "./TerrainTextures";
import { CELL, CHUNK_CELLS, CHUNK_SIZE, Cell, SEED } from "./WorldConfig";
import {
    ChunkData, MOUNTAIN_TRAIL_HALF, SAND_NOISE, WATER_NOISE, WATER_Y, WALK_MIN_Y, chunkHasMountainTrail,
    mountainTrailDistance, onRegularRoad,
    terrainHeight, terrainNoise, trailGroundKind,
} from "./WorldGen";

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

function smoothstep(a: number, b: number, x: number): number {
    const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
    return t * t * (3 - 2 * t);
}

/**
 * 山体顶点的草地权重（0~1）：低处、缓坡长草，高处、陡坡露出岩石。
 * 草地层盖在岩石层上，用这个权重做 alpha 裁切，草和岩石的分界是参差的
 */
function mountainGrass(h: number, slope: number): number {
    return 1 - smoothstep(0.35, 0.8, (h - 4) / 7 + slope * 0.75);
}

/** 山体岩石的颜色（乘岩石贴图）：越高越浅 -> 积雪；雪线附近犬牙交错，陡坡上积不住雪 */
function mountainRockColor(h: number, slope: number, jitter: number): RGB {
    const c = mix(MTN_ROCK, MTN_ROCK_HI, (h - 10) / 14);
    const snow = (h - SNOW_LINE + jitter * 4) / 3 - slope * 0.8;
    return mix(c, SNOW, snow);
}

/** 山体格子每边细分的段数：寻路格子 2 米，山体网格 1 米 */
const MTN_SUB = 2;
/** 山体细分网格的间距（米） */
const MTN_STEP = CELL / MTN_SUB;

/**
 * 山体表面的岩石起伏 [-1,1)：两层噪声（波长 6 米、3 米），叠加在地形高度上。
 * 是世界坐标的函数，相邻块在共享边上算出同样的值，没有接缝
 */
function mountainDetail(wx: number, wz: number): number {
    return fbm(wx / 6, wz / 6, 2, SEED + 1300) * 2 - 1;
}
const TRUNK: RGB = [0.40, 0.27, 0.16];
const LEAF: RGB = [0.16, 0.42, 0.20];
const LEAF_LIGHT: RGB = [0.42, 0.62, 0.24];
const LEAF_YELLOW: RGB = [0.74, 0.66, 0.20];
const LEAF_RED: RGB = [0.62, 0.16, 0.12];
const BUSH: RGB = [0.22, 0.50, 0.22];
const BUSH_DARK: RGB = [0.14, 0.36, 0.17];
const BUSH_LIGHT: RGB = [0.40, 0.62, 0.26];
const FLOWER_COLORS: RGB[] = [[0.95, 0.92, 0.85], [0.95, 0.75, 0.25], [0.85, 0.45, 0.70], [0.65, 0.55, 0.92]];
const BERRY: RGB = [0.78, 0.12, 0.14];
/** 散落石头的颜色（乘石头贴图，所以带 TEX_GAIN） */
const GRANITE: RGB = [0.56 * TEX_GAIN, 0.56 * TEX_GAIN, 0.58 * TEX_GAIN];
const STRATA: RGB = [0.66 * TEX_GAIN, 0.57 * TEX_GAIN, 0.45 * TEX_GAIN];
const MOSS: RGB = [0.30 * TEX_GAIN, 0.46 * TEX_GAIN, 0.22 * TEX_GAIN];

const POST: RGB = [0.40, 0.27, 0.15];
const RAIL: RGB = [0.50, 0.34, 0.19];

function shade(c: RGB, f: number): RGB {
    return [Math.min(1, c[0] * f), Math.min(1, c[1] * f), Math.min(1, c[2] * f)];
}

/**
 * 地形网格分三层，各用一个材质：
 * - base：纯顶点色（道路、水底、树/石头等物件、桥的栏杆和桥墩）
 * - grass：绿色平地和山上长草的地方，草地贴图 × 顶点色（alpha 测试过渡）
 * - gravel：道路，砂石贴图 × 顶点色
 * - rock：山体，岩石贴图 × 顶点色（山上草地的边缘被裁掉后露出岩石）
 * - sand：沙地，沙地贴图 × 顶点色（alpha 测试过渡）
 * - trail：山路，砂石贴图（alpha 测试裁出路边），按到山路中心线的距离画成连续的带子，盖在草地层上面
 * - plank：桥面，木板贴图 × 顶点色
 * - granite / strata：散落的石头（Cell.Rock），花岗岩 / 层状砂岩贴图，法线投影 UV；
 *   石头格子的地面是草地，不再单独铺一层石头底图
 * - foliage / bark：树冠和灌木的叶子（树叶贴图）、树干树枝（树皮贴图），法线投影 UV
 */
export type TerrainLayer = "base" | "grass" | "sand" | "plank" | "rock" | "gravel" | "trail" | "granite" | "strata"
    | "foliage" | "bark" | "leafcard" | "pine";

/**
 * 树和灌木用的网格：叶团内核（树叶贴图）、叶簇面片（双面裁切）、松枝（双面裁切）、树干（树皮贴图）、花和果子（纯顶点色）。
 * far = true 是远处的块：叶簇面片数量减半（单片放大补上）、松枝切面减少、不画花和果子
 */
interface Veg { leaf: MeshBuilder; card: MeshBuilder; pine: MeshBuilder; bark: MeshBuilder; base: MeshBuilder; far: boolean }

/**
 * 一团树冠 / 灌木叶簇：里面一个偏暗的小叶团做内核（挡住视线，不会看穿），
 * 外面围一圈斜着往外、往下探出的叶簇面片（贴图里叶片以外是透明的）。
 * 轮廓是一簇簇参差的叶尖，不是一个多面体球。三角形数 = 20 + cards × 2
 */
function crown(v: Veg, x: number, yc: number, z: number, rx: number, ry: number, rz: number,
    col: RGB, top: RGB, rand: (i: number) => number, cards: number) {
    v.leaf.blob(x, yc, z, rx * 0.7, ry * 0.7, rz * 0.7, shade(col, 0.62), shade(col, 0.8), rand, 5);
    // 远处：面片数量减半，单片放大一些，树冠的轮廓大小不变
    const grow = v.far ? 1.3 : 1;
    if (v.far) cards = Math.ceil(cards / 2);
    const rot = rand(100) * Math.PI * 2;
    for (let i = 0; i < cards; i++) {
        // 在球面上均匀撒点（上面多、底下不放）
        const yy = 0.95 - ((i + 0.5) / cards) * 1.35;
        const rad = Math.sqrt(1 - yy * yy);
        const a = rot + i * 2.4 + (rand(110 + i) - 0.5) * 0.5;
        const ca = Math.cos(a), sa = Math.sin(a);
        const d = [ca * rad, yy, sa * rad];                 // 往外的方向
        const u = [-sa, 0, ca];                             // 水平切线
        // 另一条边：往外 + 沿球面往下，面片相对球面斜着约 50°，正面和轮廓上都看得见
        let vx = d[0] * 0.8 + yy * ca, vy = d[1] * 0.8 - rad, vz = d[2] * 0.8 + yy * sa;
        const vl = Math.hypot(vx, vy, vz) || 1;
        vx /= vl; vy /= vl; vz /= vl;
        const p = [x + d[0] * rx * 0.78, yc + d[1] * ry * 0.78, z + d[2] * rz * 0.78];
        const half = Math.min(rx, rz) * (0.5 + rand(130 + i) * 0.16) * grow;
        // 法线：往外偏上，受光像一整个球
        const nl = Math.hypot(d[0], d[1] + 0.5, d[2]) || 1;
        const c = shade(mix(col, top, (yy + 0.4) / 1.35), 0.9 + rand(150 + i) * 0.2);
        v.card.card(p, u, [vx, vy, vz], half, [d[0] / nl, (d[1] + 0.5) / nl, d[2] / nl], c, Math.floor(rand(170 + i) * 4));
    }
}
export interface ChunkMesh { mesh: Laya.Mesh; layer: TerrainLayer }

/** 地面用草地贴图的格子：草地以及长在草地上的树、灌木、树桩 */
function isGrassGround(kind: number): boolean {
    return kind === Cell.Grass || kind === Cell.Tree || kind === Cell.Bush || kind === Cell.Stump || kind === Cell.Rock;
}

function isSandGround(kind: number): boolean {
    return kind === Cell.Sand;
}

/** 先上下左右，再对角 */
const NEIGHBORS8: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];

function isPath(kind: number): boolean {
    return kind === Cell.Bridge || kind === Cell.Road;
}

/**
 * 贴图层比下面的地面高一点，避免重合闪烁；草地盖在沙地上面（沙草交界处草的边缘压住沙子）。
 * 间距必须大于深度缓冲的最小可分辨距离：相机 near=0.3、far=1000，16 位深度缓冲在约 25 米处
 * 的精度只有约 0.07 米，0.01 的间距会让两层在深度测试里交替胜出，接触边缘随相机移动闪烁。
 */
const SAND_LIFT = 0.15;
const GRASS_LIFT = 0.3;
/** 山路砂石层盖在草地层上面（间距同样要大于深度精度） */
const TRAIL_LIFT = 0.42;

/**
 * 山路砂石层的顶点 alpha：路面中心 0.97，路边外 0.55。
 * 贴图 alpha 在 [0.55, 0.85]，像素保留条件 顶点alpha × 贴图alpha ≥ 0.5：
 * 顶点 alpha ≥ 0.91 处全部保留，≤ 0.59 处全部裁掉，中间按贴图噪声裁出参差的边。
 * 过渡带以路面半宽为中心、宽 1.6 米，所以看到的路宽和可走格子的宽度一致
 */
const TRAIL_ALPHA_MIN = 0.5 / 0.85;
function trailAlpha(d: number): number {
    const t = (MOUNTAIN_TRAIL_HALF + 0.8 - d) / 1.6;
    return t <= 0 ? 0 : 0.55 + 0.42 * Math.min(1, t);
}

/** 草地边缘下面垫的地面颜色（被裁掉的地方露出来的颜色） */
function underColor(kind: number): RGB {
    if (kind === Cell.Mountain) return MTN_ROCK;
    if (kind === Cell.Bridge) return COLORS[Cell.Water];
    return COLORS[kind];
}

/**
 * 把一个块的数据构建成渲染网格（地形 + 树/石头/灌木/桥），按“每帧时间预算”调用。
 * kindGlobal：按全局格子坐标查类型，用来看相邻块边缘的格子（草地过渡、桥栏杆在块之间要连续）。
 * far = true 构建远处用的简化版（省显存）：地形和物件的位置、轮廓不变，只去掉远处看不清的小东西——
 * 不画碎石、花和果子，叶簇面片减半，松枝切面减少
 */
export function buildChunkMeshes(data: ChunkData, kindGlobal: (gx: number, gz: number) => number, far = false): ChunkMesh[] {
    const mb = new MeshBuilder();
    const grass = new MeshBuilder(true);
    const sand = new MeshBuilder(true);
    const plank = new MeshBuilder(true);
    const rock = new MeshBuilder(true);
    const gravel = new MeshBuilder(true);
    const trail = new MeshBuilder(true);
    const granite = new MeshBuilder(true, STONE_TILE);
    const strata = new MeshBuilder(true, STONE_TILE);
    const foliage = new MeshBuilder(true, FOLIAGE_TILE);
    const bark = new MeshBuilder(true, BARK_TILE);
    const leafcard = new MeshBuilder(true);
    const pine = new MeshBuilder(true);
    const veg: Veg = { leaf: foliage, card: leafcard, pine, bark, base: mb, far };
    const gx0 = data.cx * CHUNK_CELLS, gz0 = data.cz * CHUNK_CELLS;
    granite.uvOriginX = strata.uvOriginX = foliage.uvOriginX = bark.uvOriginX = gx0 * CELL;
    granite.uvOriginZ = strata.uvOriginZ = foliage.uvOriginZ = bark.uvOriginZ = gz0 * CELL;
    const N = CHUNK_CELLS;
    // 本块 + 外面一圈格子的类型（画面用）。
    // 山路格子在数据里是 Road，但画面上按原来的地面（山体/草地）画，路面另画成一条边缘参差的砂石带（trail 层），
    // 不按格子画，所以山路不会是一格一格的方块
    const M = N + 2;
    const K = new Int8Array(M * M);
    const TR = new Uint8Array(M * M);   // 1 = 山路格子
    for (let z = -1; z <= N; z++)
        for (let x = -1; x <= N; x++) {
            let k = x >= 0 && z >= 0 && x < N && z < N ? data.kindLocal(x, z) : kindGlobal(gx0 + x, gz0 + z);
            if (k === Cell.Road) {
                const wx = (gx0 + x + 0.5) * CELL, wz = (gz0 + z + 0.5) * CELL;
                if (mountainTrailDistance(wx, wz) <= MOUNTAIN_TRAIL_HALF && !onRegularRoad(wx, wz)) {
                    k = trailGroundKind(wx, wz);
                    TR[(z + 1) * M + x + 1] = 1;
                }
            }
            K[(z + 1) * M + x + 1] = k;
        }
    const isTrail = (lx: number, lz: number) => TR[(lz + 1) * M + lx + 1] === 1;
    const kindAt = (lx: number, lz: number) => lx < -1 || lz < -1 || lx > N || lz > N ? -1 : K[(lz + 1) * M + lx + 1];
    /** 从 (lx,lz) 沿 (dx,dz) 连续的道路/桥格子数 */
    const pathRun = (lx: number, lz: number, dx: number, dz: number) => {
        let n = 0;
        while (n < 6 && isPath(kindAt(lx + dx * (n + 1), lz + dz * (n + 1)))) n++;
        return n;
    };
    /** 按全局格子坐标查类型：本块和外面一圈用 K，再远的查相邻块 */
    const kindG = (gx: number, gz: number) => {
        const k = kindAt(gx - gx0, gz - gz0);
        return k >= 0 ? k : kindGlobal(gx, gz);
    };
    const bigStones = new BigStoneCache(kindG);

    // 顶点数据（(N+1)x(N+1)），用世界坐标/全局格子计算，相邻块共享边缘，没有接缝
    // H：高度。挨着道路的顶点压平一点并且不低于可走高度（按顶点处理，路边和草地之间没有台阶缝）
    // MG：山体上的草地权重（按高度和坡度），坡度用多算一圈的原始高度 R 求
    // AG：草地层的顶点 alpha = 0.5 + 0.5 × 周围 4 格的草地权重平均（草地格算 1，山体格算 MG）
    // AS：沙地层的顶点 alpha，同理
    const V = N + 1;
    const RW = V + 2;
    const R = new Float32Array(RW * RW);
    for (let z = -1; z <= V; z++)
        for (let x = -1; x <= V; x++)
            R[(z + 1) * RW + x + 1] = terrainHeight((gx0 + x) * CELL, (gz0 + z) * CELL);
    // TA：山路砂石层的顶点 alpha，按顶点到山路中心线的距离算（连续的，所以路边是平滑的曲线而不是格子边）
    // 和 R 一样多算一圈（下标 (z+1)*RW+x+1），用来判断外面一圈格子是不是挨着山路
    const TA = new Float32Array(RW * RW);
    if (chunkHasMountainTrail(data.cx, data.cz)) {
        for (let z = -1; z <= V; z++)
            for (let x = -1; x <= V; x++)
                TA[(z + 1) * RW + x + 1] = trailAlpha(mountainTrailDistance((gx0 + x) * CELL, (gz0 + z) * CELL));
    }
    const H = new Float32Array(V * V);
    // GX/GZ：原始地形的坡度（高度对 x、z 的偏导），用来算平滑法线
    const GX = new Float32Array(V * V);
    const GZ = new Float32Array(V * V);
    const MG = new Float32Array(V * V);
    const AG = new Float32Array(V * V);
    const AS = new Float32Array(V * V);
    for (let z = 0; z <= N; z++) {
        for (let x = 0; x <= N; x++) {
            const ri = (z + 1) * RW + x + 1;
            let h = R[ri];
            const ddx = (R[ri + 1] - R[ri - 1]) / (2 * CELL), ddz = (R[ri + RW] - R[ri - RW]) / (2 * CELL);
            const slope = Math.hypot(ddx, ddz);
            GX[z * V + x] = ddx;
            GZ[z * V + x] = ddz;
            const mg = mountainGrass(h, slope);
            let road = false, g = 0, s = 0, w = 0;
            for (let j = -1; j <= 0; j++) {
                for (let i = -1; i <= 0; i++) {
                    const k = kindAt(x + i, z + j);
                    if (k === Cell.Road) road = true;
                    if (isGrassGround(k)) g++;
                    else if (k === Cell.Mountain) g += mg;
                    if (isSandGround(k)) s++;
                    else if (k === Cell.Water) w++;
                }
            }
            // 沙滩挨着水的顶点：水格子也算沙地，沙子一直铺到水下，裁切发生在水面以下，
            // 不会在岸上露出水底的颜色；岸线由水面与地形相交 + 泡沫决定
            if (s > 0) {
                s += w;
            } else if (w > 0) {
                // 四邻全是水格的顶点（s===0）：若地形接近水面，也铺沙地贴图以遮盖水底深褐色。
                // depth>0 表示在水下；depth<0 表示地形高于水面（水格噪声低但高度可能超过 WATER_Y）。
                // smoothstep(0.2, 1.6, depth)：0.2m 以内全沙，1.6m 以下无沙，过渡藏在水面以下不可见。
                const depth = WATER_Y - h;
                const sf = 1 - smoothstep(0.2, 1.6, depth);
                if (sf > 0) s = 4 * sf;
            }
            if (road) h = Math.max(h, WALK_MIN_Y) - 0.02;
            H[z * V + x] = h;
            MG[z * V + x] = mg;
            AG[z * V + x] = 0.5 + 0.5 * (g / 4);
            AS[z * V + x] = 0.5 + 0.5 * (s / 4);
        }
    }

    // VG：草地层的顶点颜色 = 周围 4 格草色的平均（山体格用山上的草色，石头格偏暗，各带逐格的深浅变化）。
    // 颜色在格子内渐变，看不出一格一格的色块；平地和山体的草地层在共享边上用同一份颜色，交界处没有色差
    const VGR = new Float32Array(V * V), VGG = new Float32Array(V * V), VGB = new Float32Array(V * V);
    for (let z = 0; z <= N; z++) {
        for (let x = 0; x <= N; x++) {
            let r = 0, g = 0, b = 0;
            for (let j = -1; j <= 0; j++) {
                for (let i = -1; i <= 0; i++) {
                    const k = kindAt(x + i, z + j), jt = hash2(gx0 + x + i, gz0 + z + j, SEED + 3);
                    const c = k === Cell.Mountain ? MTN_GRASS : COLORS[Cell.Grass];
                    const f = k === Cell.Mountain ? 0.94 + jt * 0.12 : k === Cell.Rock ? 0.88 + jt * 0.06 : 0.97 + jt * 0.06;
                    r += c[0] * f; g += c[1] * f; b += c[2] * f;
                }
            }
            const s = TEX_GAIN / 4, vi = z * V + x;
            VGR[vi] = Math.min(1, r * s); VGG[vi] = Math.min(1, g * s); VGB[vi] = Math.min(1, b * s);
        }
    }
    /**
     * 平地的贴图层（草地、沙地）的一个格子：4 个顶点 + 2 个三角形，抬高 lift。
     * 法线按顶点算（地形坡度 GX/GZ），相邻格子在共享的顶点上法线相同，坡上的光照连续过渡，
     * 看不出一块块的三角面（平面着色时每个三角形一个明暗，山脚的斜坡上特别显眼）。
     * col 不传时用草地的顶点颜色 VG。对角线和 quad 一样（00-11），不会被下面垫的底色层戳穿
     */
    const groundQuad = (mesh: MeshBuilder, lx: number, lz: number, lift: number, tile: number, al: number[], col?: RGB) => {
        mesh.reserve(4);
        const vert = (x: number, z: number, a: number) => {
            const k = z * V + x, sx = GX[k], sz = GZ[k], inv = 1 / Math.hypot(sx, 1, sz);
            return mesh.addVertex((gx0 + x) * CELL, H[k] + lift, (gz0 + z) * CELL, -sx * inv, inv, -sz * inv,
                col ? col[0] : VGR[k], col ? col[1] : VGG[k], col ? col[2] : VGB[k], a, x * CELL / tile, z * CELL / tile);
        };
        const a = vert(lx, lz, al[0]), b = vert(lx + 1, lz, al[1]), c = vert(lx + 1, lz + 1, al[2]), d = vert(lx, lz + 1, al[3]);
        mesh.addTri(a, b, c);
        mesh.addTri(a, c, d);
    };

    // ---- 山体细分网格 ----
    // 山体格子每边细分成 MTN_SUB 段，顶点带平滑法线和逐顶点颜色，并叠加岩石起伏 mountainDetail，
    // 看不出一格一格的大三角面。
    // DW：起伏的权重（格子顶点）。只有周围 4 格都是山体、且都不挨着山路的顶点才起伏：
    // - 山体与草地/道路相接的边上权重为 0，细分出来的中间顶点仍在原来的直线上，和旁边不细分的格子没有缝；
    // - 山路格子的四个角权重都是 0，路面高度仍等于 terrainHeight（角色站立的高度）。
    const FN = N * MTN_SUB, FV = FN + 1;
    let hasMtn = false;
    for (let z = 0; z < N && !hasMtn; z++)
        for (let x = 0; x < N; x++) if (kindAt(x, z) === Cell.Mountain) { hasMtn = true; break; }
    const FH = new Float32Array(hasMtn ? FV * FV : 0);       // 高度
    const FNR = new Float32Array(hasMtn ? FV * FV * 3 : 0);  // 法线
    const FRC = new Float32Array(hasMtn ? FV * FV * 3 : 0);  // 岩石层颜色
    const FGC = new Float32Array(hasMtn ? FV * FV * 3 : 0);  // 草地层颜色
    const FAG = new Float32Array(hasMtn ? FV * FV : 0);      // 草地层 alpha
    const FTA = new Float32Array(hasMtn ? FV * FV : 0);      // 山路砂石层 alpha
    if (hasMtn) {
        const roughCell = (lx: number, lz: number) => {
            if (kindAt(lx, lz) !== Cell.Mountain || isTrail(lx, lz)) return false;
            const t = (lz + 1) * RW + lx + 1;
            return TA[t] === 0 && TA[t + 1] === 0 && TA[t + RW] === 0 && TA[t + RW + 1] === 0;
        };
        const DW = new Float32Array(V * V);
        for (let z = 0; z <= N; z++)
            for (let x = 0; x <= N; x++)
                DW[z * V + x] = roughCell(x - 1, z - 1) && roughCell(x, z - 1) && roughCell(x - 1, z) && roughCell(x, z) ? 1 : 0;
        // 起伏噪声多算一圈，块边缘的顶点也能用中心差分求坡度（相邻块的法线一致）
        const NW = FN + 3;
        const DN = new Float32Array(NW * NW);
        const ox = gx0 * CELL, oz = gz0 * CELL;
        for (let j = -1; j <= FN + 1; j++)
            for (let i = -1; i <= FN + 1; i++)
                DN[(j + 1) * NW + i + 1] = mountainDetail(ox + i * MTN_STEP, oz + j * MTN_STEP);
        for (let j = 0; j <= FN; j++) {
            const cz0 = Math.min(Math.floor(j / MTN_SUB), N - 1), tz = j / MTN_SUB - cz0;
            for (let i = 0; i <= FN; i++) {
                const cx0 = Math.min(Math.floor(i / MTN_SUB), N - 1), tx = i / MTN_SUB - cx0;
                const c00 = cz0 * V + cx0, c10 = c00 + 1, c01 = c00 + V, c11 = c01 + 1;
                const w00 = (1 - tx) * (1 - tz), w10 = tx * (1 - tz), w01 = (1 - tx) * tz, w11 = tx * tz;
                const lerp = (A: Float32Array) => A[c00] * w00 + A[c10] * w10 + A[c01] * w01 + A[c11] * w11;
                const di = (j + 1) * NW + i + 1, d = DN[di];
                const mg = lerp(MG);
                // 裸露的岩石起伏大，长草的缓坡起伏小
                const amp = lerp(DW) * (0.25 + 0.95 * (1 - mg));
                const h = lerp(H) + amp * d;
                const sx = lerp(GX) + amp * (DN[di + 1] - DN[di - 1]) / (2 * MTN_STEP);
                const sz = lerp(GZ) + amp * (DN[di + NW] - DN[di - NW]) / (2 * MTN_STEP);
                const inv = 1 / Math.hypot(sx, 1, sz);
                const k = j * FV + i, k3 = k * 3;
                FH[k] = h;
                FNR[k3] = -sx * inv; FNR[k3 + 1] = inv; FNR[k3 + 2] = -sz * inv;
                FAG[k] = lerp(AG);
                const t00 = (cz0 + 1) * RW + cx0 + 1;
                FTA[k] = TA[t00] * w00 + TA[t00 + 1] * w10 + TA[t00 + RW] * w01 + TA[t00 + RW + 1] * w11;
                // 颜色逐顶点算：雪线、岩石深浅按连续的噪声变化；凹处暗、凸处亮，岩面更有体积感
                const wx = ox + i * MTN_STEP, wz = oz + j * MTN_STEP;
                const jit = valueNoise(wx / 3, wz / 3, SEED + 3);
                const lit = 0.84 + 0.32 * (d * 0.5 + 0.5);
                const rc = shade(mountainRockColor(h, Math.hypot(sx, sz) * 1.2, jit), lit * TEX_GAIN);
                FRC[k3] = rc[0]; FRC[k3 + 1] = rc[1]; FRC[k3 + 2] = rc[2];
                // 草地层颜色用格子顶点颜色 VG 的插值：和旁边平地的草地层在共享边上完全一样
                FGC[k3] = lerp(VGR); FGC[k3 + 1] = lerp(VGG); FGC[k3 + 2] = lerp(VGB);
            }
        }
    }
    /** 细分网格上 (u,v)（单位：细分格）处的山体表面高度 */
    const fineY = (u: number, v: number) => {
        const i0 = Math.min(Math.floor(u), FN - 1), j0 = Math.min(Math.floor(v), FN - 1);
        const tx = u - i0, tz = v - j0, k = j0 * FV + i0;
        return (FH[k] * (1 - tx) + FH[k + 1] * tx) * (1 - tz) + (FH[k + FV] * (1 - tx) + FH[k + FV + 1] * tx) * tz;
    };
    /**
     * 细分网格顶点 (i,j) 在 mesh 里的下标，没有就新加一个。相邻的面共用顶点（每个四边形平均只多 1 个顶点）。
     * layer：0 岩石层、1 草地层、2 山路砂石层。三层用同一份高度（只差抬高量），切分的对角线也一样，
     * 上面的层不会被下面的层戳穿。
     * mode 只对岩石层有用，是 UV 的投影面（见 rockUVMode）；同一个顶点在不同投影面下 UV 不同，各存一份
     */
    const vcache = new Map<MeshBuilder, { ids: Int32Array; epoch: number }>();
    const mtnIndex = (mesh: MeshBuilder, i: number, j: number, layer: number, mode: number): number => {
        let c = vcache.get(mesh);
        if (!c) {
            c = { ids: new Int32Array(FV * FV * 3).fill(-1), epoch: mesh.epoch };
            vcache.set(mesh, c);
        } else if (c.epoch !== mesh.epoch) {
            // 顶点满了切分出了新的 Mesh，之前的下标作废
            c.ids.fill(-1);
            c.epoch = mesh.epoch;
        }
        const k = j * FV + i, k3 = k * 3, key = k3 + mode;
        if (c.ids[key] >= 0) return c.ids[key];
        const lx = i * MTN_STEP, lz = j * MTN_STEP;
        const px = gx0 * CELL + lx, pz = gz0 * CELL + lz;
        const h = FH[k], nx = FNR[k3], ny = FNR[k3 + 1], nz = FNR[k3 + 2];
        let id: number;
        if (layer === 1) {
            id = mesh.addVertex(px, h + GRASS_LIFT, pz, nx, ny, nz, FGC[k3], FGC[k3 + 1], FGC[k3 + 2], FAG[k],
                lx / GRASS_TILE, lz / GRASS_TILE);
        } else if (layer === 2) {
            id = mesh.addVertex(px, h + TRAIL_LIFT, pz, nx, ny, nz, GRAVEL_COL[0], GRAVEL_COL[1], GRAVEL_COL[2], FTA[k],
                lx / GRAVEL_TILE, lz / GRAVEL_TILE);
        } else {
            // 缓坡投影 (x,z)；朝 ±x 的陡坡投影 (z,y)；朝 ±z 的陡坡投影 (x,y)
            const u = mode === 1 ? lz : lx, v = mode === 0 ? lz : h;
            id = mesh.addVertex(px, h, pz, nx, ny, nz, FRC[k3], FRC[k3 + 1], FRC[k3 + 2], 1, u / ROCK_TILE, v / ROCK_TILE);
        }
        c.ids[key] = id;
        return id;
    };
    /** 画一个山体格子的某一层（细分成 MTN_SUB × MTN_SUB 个平滑四边形） */
    const mountainCell = (mesh: MeshBuilder, lx: number, lz: number, layer: number) => {
        for (let sj = 0; sj < MTN_SUB; sj++) {
            for (let si = 0; si < MTN_SUB; si++) {
                const i = lx * MTN_SUB + si, j = lz * MTN_SUB + sj;
                const k = j * FV + i;
                const ha = FH[k], hb = FH[k + 1], hc = FH[k + FV + 1], hd = FH[k + FV];
                const mode = layer === 0 ? rockUVMode(MTN_STEP, ha, hb, hc, hd) : 0;
                // 四个顶点必须和之前共用的顶点在同一个 Mesh 里
                mesh.reserve(4);
                const a = mtnIndex(mesh, i, j, layer, mode), b = mtnIndex(mesh, i + 1, j, layer, mode);
                const c = mtnIndex(mesh, i + 1, j + 1, layer, mode), d = mtnIndex(mesh, i, j + 1, layer, mode);
                // 沿高度差较小的对角线切开，山脊、山沟的走向不会被三角形切成锯齿
                if (Math.abs(ha - hc) <= Math.abs(hb - hd)) {
                    mesh.addTri(a, b, c); mesh.addTri(a, c, d);
                } else {
                    mesh.addTri(a, b, d); mesh.addTri(b, c, d);
                }
            }
        }
    };

    for (let lz = 0; lz < N; lz++) {
        for (let lx = 0; lx < N; lx++) {
            const kind = kindAt(lx, lz);
            const gx = gx0 + lx, gz = gz0 + lz;
            const x0 = gx * CELL, x1 = x0 + CELL, z0 = gz * CELL, z1 = z0 + CELL;
            const i00 = lz * V + lx, i10 = i00 + 1, i01 = i00 + V, i11 = i01 + 1;
            const h00 = H[i00], h10 = H[i10], h01 = H[i01], h11 = H[i11];
            const gal = [AG[i00], AG[i10], AG[i11], AG[i01]];   // 草地 alpha：与 quad 的顶点顺序 a-b-c-d 一致
            const gMin = Math.min(gal[0], gal[1], gal[2], gal[3]), gMax = Math.max(gal[0], gal[1], gal[2], gal[3]);
            const sal = [AS[i00], AS[i10], AS[i11], AS[i01]];   // 沙地 alpha
            const sMin = Math.min(sal[0], sal[1], sal[2], sal[3]), sMax = Math.max(sal[0], sal[1], sal[2], sal[3]);
            const jitter = hash2(gx, gz, SEED + 3);
            const hAvg = (h00 + h10 + h01 + h11) / 4;
            const slope = (Math.max(h00, h10, h01, h11) - Math.min(h00, h10, h01, h11)) / CELL;
            let col: RGB;
            if (kind === Cell.Mountain) {
                col = shade(mountainRockColor(hAvg, slope, jitter), (0.94 + jitter * 0.12) * TEX_GAIN);
            } else if (isGrassGround(kind)) {
                // 石头格子的地面也是草地（石头长在草里），颜色用草地的，稍暗一点像被石头挡住了光
                col = kind === Cell.Rock
                    ? shade(COLORS[Cell.Grass], (0.88 + jitter * 0.06) * TEX_GAIN)
                    : shade(COLORS[kind], (0.97 + jitter * 0.06) * TEX_GAIN);
            } else if (isSandGround(kind)) {
                col = shade(COLORS[kind], (0.97 + jitter * 0.06) * TEX_GAIN);
            } else {
                col = shade(COLORS[kind], 0.92 + jitter * 0.16);
            }
            const cxw = (x0 + x1) / 2, czw = (z0 + z1) / 2;
            const ref = [cxw, -1000, czw];   // 参考点在下方 => 法线朝上
            const grassCell = isGrassGround(kind), sandCell = isSandGround(kind);
            const textured = grassCell || sandCell;
            // base 层：非贴图格子总是画；贴图格子只在边缘（有裁剪）时画，做底色
            if (kind === Cell.Mountain) {
                // 岩石层；四个顶点都被草完全盖住的格子不用画
                if (gMin < 1) mountainCell(rock, lx, lz, 0);
            } else if (kind === Cell.Road) {
                gravelQuad(gravel, lx, lz, x0, z0, h00, h10, h11, h01, ref);
            } else if (!textured) {
                mb.quad([x0, h00, z0], [x1, h10, z0], [x1, h11, z1], [x0, h01, z1], col, ref);
            } else {
                const aMin2 = grassCell ? gMin : sMin;
                if (aMin2 < 1) {
                    let nk = -1;
                    for (const [dx, dz] of NEIGHBORS8) {
                        const k = kindAt(lx + dx, lz + dz);
                        if (k >= 0 && (grassCell ? !isGrassGround(k) : !isSandGround(k))) { nk = k; break; }
                    }
                    // 挨着路的草地边缘下面垫砂石，被裁掉的地方和路面是同一种材质
                    if (nk === Cell.Road) gravelQuad(gravel, lx, lz, x0, z0, h00, h10, h11, h01, ref);
                    else if (nk >= 0) mb.quad([x0, h00, z0], [x1, h10, z0], [x1, h11, z1], [x0, h01, z1],
                        shade(underColor(nk), 0.92 + jitter * 0.16), ref);
                }
            }
            // 草地层
            if (kind === Cell.Mountain) {
                if (gMax > 0.5) mountainCell(grass, lx, lz, 1);
            } else if (grassCell || gMax > 0.5) {
                // UV 用块内坐标（块边长是 GRASS_TILE 的整数倍，块之间无缝），避免远处 UV 过大损失精度
                groundQuad(grass, lx, lz, GRASS_LIFT, GRASS_TILE, gal);
            }
            // 山路砂石层：盖在草地层上面，边缘由顶点 alpha × 贴图 alpha 裁出参差的路边
            const t00 = (lz + 1) * RW + lx + 1;
            const tal = [TA[t00], TA[t00 + 1], TA[t00 + RW + 1], TA[t00 + RW]];
            const tMax = Math.max(tal[0], tal[1], tal[2], tal[3]);
            if (tMax > TRAIL_ALPHA_MIN && kind === Cell.Mountain) {
                mountainCell(trail, lx, lz, 2);
            } else if (tMax > TRAIL_ALPHA_MIN) {
                const u0 = lx * CELL / GRAVEL_TILE, u1 = u0 + CELL / GRAVEL_TILE;
                const v0 = lz * CELL / GRAVEL_TILE, v1 = v0 + CELL / GRAVEL_TILE;
                const L = TRAIL_LIFT;
                trail.quad([x0, h00 + L, z0], [x1, h10 + L, z0], [x1, h11 + L, z1], [x0, h01 + L, z1], GRAVEL_COL, ref,
                    [u0, v0, u1, v0, u1, v1, u0, v1], tal);
            }
            // 沙地层
            if (sandCell || sMax > 0.5) {
                const scol = sandCell ? col : shade(COLORS[Cell.Sand], (0.97 + jitter * 0.06) * TEX_GAIN);
                groundQuad(sand, lx, lz, SAND_LIFT, SAND_TILE, sal, scol);
            }

            const baseY = Math.max(Math.min(h00, h10, h01, h11), WALK_MIN_Y - 0.3);
            const r = hash2(gx, gz, SEED + 99);
            switch (kind) {
                case Cell.Tree:
                    treeCell(veg, gx, gz, cxw, baseY, czw, 0.8 + r * 0.6, LEAF);
                    break;
                case Cell.Mountain: {
                    // 山上的装饰（只是画面，山体格子本来就不可走）：长草的地方有树，裸露的岩石上有大石块
                    // 山路和路边不放（tMax > 0 表示格子挨着山路）
                    if (hAvg > SNOW_LINE - 3 || tMax > 0 || isTrail(lx, lz)) break;
                    const cg = (MG[i00] + MG[i10] + MG[i01] + MG[i11]) / 4;
                    // 偏离格子中心，避免排成网格；高度取细分网格上该点的高度，往下埋一点防止在坡上悬空
                    const fx = 0.25 + 0.5 * hash2(gx, gz, SEED + 101), fz = 0.25 + 0.5 * hash2(gx, gz, SEED + 102);
                    const px = x0 + fx * CELL, pz = z0 + fz * CELL;
                    const py = fineY((lx + fx) * MTN_SUB, (lz + fz) * MTN_SUB);
                    if (cg > 0.45 && slope < 1.3 && r < 0.12 + cg * 0.33) {
                        // 越高越偏黄，山顶附近有整棵变红的
                        const autumn = smoothstep(SNOW_LINE - 16, SNOW_LINE - 4, py);
                        const red = hash2(gx, gz, SEED + 103) < autumn * 0.7;
                        const leaf = red ? mix(LEAF, LEAF_RED, 0.55 + autumn * 0.45)
                            : mix(LEAF, LEAF_YELLOW, autumn * 0.85);
                        const s = (0.75 + hash2(gx, gz, SEED + 104) * 0.6) * (0.8 + cg * 0.2);
                        treeCell(veg, gx, gz, px, py - 0.25 - slope * 0.3, pz, s, leaf, true);
                    } else if (cg < 0.5 && r > 0.93) {
                        const bc = shade(mountainRockColor(hAvg, 0, jitter), 0.92 + jitter * 0.12);
                        mb.boulder(px, py - slope * 0.4, pz, 0.6 + hash2(gx, gz, SEED + 105) * 0.8, bc,
                            i => hash2(gx * 64 + i, gz, SEED + 106));
                    }
                    break;
                }
                case Cell.Rock: {
                    // 大石头脚下的格子：大石头已经挡住了，不再放小石头（否则会从大石头里戳出来）
                    const near = bigStones.cover(cxw, czw);
                    if (near > 0) break;
                    let rockN = 0;
                    for (const [dx, dz] of NEIGHBORS8) if (kindAt(lx + dx, lz + dz) === Cell.Rock) rockN++;
                    const hs = (k: number) => hash2(gx, gz, SEED + 4200 + k);
                    // 石林里：约三成格子只有碎石（露出草地，石头之间有空隙），其余尺寸差别大
                    // 零散的单块石头基本占满格子，保证看起来挡路
                    const inField = rockN >= 3;
                    const strataZone = stoneZone(cxw, czw);
                    if (inField && hs(1) < 0.3) {
                        if (!far) pebbles(granite, strata, gx, gz, x0, z0, baseY, bigStones, strataZone, 2);
                        break;
                    }
                    const scale = inField ? 0.5 + hs(0) * 0.55 : 0.85 + hs(0) * 0.2;
                    stoneCell(granite, strata, gx, gz, cxw, baseY, czw, jitter, scale, stoneHeightScale(cxw, czw), strataZone);
                    if (!far) pebbles(granite, strata, gx, gz, x0, z0, baseY, bigStones, strataZone, 0);
                    break;
                }
                case Cell.Bush:
                    bushCell(veg, gx, gz, cxw, baseY, czw, jitter);
                    break;
                case Cell.Stump:
                    veg.bark.box(cxw, baseY, czw, 0.45, 0.3, 0.45, shade(TRUNK, TEX_GAIN), shade([0.75, 0.6, 0.4], TEX_GAIN));
                    break;
                case Cell.Bridge: {
                    // 桥沿着道路/桥格子连得更长的方向延伸，木板横铺（垂直于桥的方向）
                    const alongX = pathRun(lx, lz, 1, 0) + pathRun(lx, lz, -1, 0) >= pathRun(lx, lz, 0, 1) + pathRun(lx, lz, 0, -1);
                    buildBridgeCell(mb, plank, kindAt, lx, lz, x0, z0, alongX, Math.min(h00, h10, h01, h11), jitter);
                    break;
                }
            }
        }
    }
    // 大石头由中心所在的块来画（相邻块按同样的全局规则算出同一批大石头，不会重复也不会漏）
    bigStones.ensure(gx0 * CELL, gz0 * CELL, (gx0 + N) * CELL, (gz0 + N) * CELL);
    for (const s of bigStones.all()) {
        const sgx = Math.floor(s.x / CELL), sgz = Math.floor(s.z / CELL);
        if (sgx >= gx0 && sgx < gx0 + N && sgz >= gz0 && sgz < gz0 + N) drawBigStone(granite, strata, s);
    }
    const out: ChunkMesh[] = [];
    for (const m of mb.build()) out.push({ mesh: m, layer: "base" });
    for (const m of grass.build()) out.push({ mesh: m, layer: "grass" });
    for (const m of sand.build()) out.push({ mesh: m, layer: "sand" });
    for (const m of plank.build()) out.push({ mesh: m, layer: "plank" });
    for (const m of rock.build()) out.push({ mesh: m, layer: "rock" });
    for (const m of gravel.build()) out.push({ mesh: m, layer: "gravel" });
    for (const m of trail.build()) out.push({ mesh: m, layer: "trail" });
    for (const m of granite.build()) out.push({ mesh: m, layer: "granite" });
    for (const m of strata.build()) out.push({ mesh: m, layer: "strata" });
    for (const m of foliage.build()) out.push({ mesh: m, layer: "foliage" });
    for (const m of bark.build()) out.push({ mesh: m, layer: "bark" });
    for (const m of leafcard.build()) out.push({ mesh: m, layer: "leafcard" });
    for (const m of pine.build()) out.push({ mesh: m, layer: "pine" });
    return out;
}

/**
 * 一个灌木格子（不可走，可以砍）的模型，按格子哈希从四种造型里选一种：
 * 0 圆团灌木（几团叶簇挤在一起）；1 开花的灌木；2 结红果的深色灌木；
 * 3 蕨丛/高草（一簇从中心向外铺开的单片叶子，中间垫一小团叶簇）。
 * 叶簇是底暗顶亮的低多边形团块；尺寸基本占满格子，成片的灌木格子会连成一整片树篱
 */
function bushCell(v: Veg, gx: number, gz: number, x: number, y: number, z: number, jitter: number) {
    const rnd = (k: number) => (i: number) => hash2(gx * 101 + i, gz * 83 + k, SEED + 4500);
    const h = (k: number) => hash2(gx, gz, SEED + 4600 + k);
    const variant = Math.floor(h(0) * 4);
    const R = CELL * 0.5;
    // 叶子乘树叶贴图，颜色要补偿贴图的平均亮度
    const T = (c: RGB) => shade(c, TEX_GAIN);
    // 每格的叶色在深绿和黄绿之间变化
    const base = T(mix(BUSH_DARK, BUSH, 0.55 + jitter * 0.45));
    const light = T(mix(BUSH, BUSH_LIGHT, 0.4 + h(1) * 0.6));

    /** 一团叶簇：中心 (cx,cz)，半径 r，高 hh */
    const clump = (cx: number, cz: number, r: number, hh: number, k: number, col = base, top = light) =>
        crown(v, cx, y + hh * 0.42, cz, r, hh * 0.5, r * (0.85 + h(40 + k) * 0.3), col, top, rnd(k), k === 0 ? 7 : 5);

    /** 叶簇外围的一圈小团，返回它们的位置，用于放花和果子 */
    const ring = (n: number, dist: number, r: number, hh: number, col?: RGB, top?: RGB) => {
        const pts: number[][] = [];
        const a0 = h(2) * Math.PI * 2;
        for (let k = 0; k < n; k++) {
            const a = a0 + (k / n) * Math.PI * 2 + (h(10 + k) - 0.5) * 0.8;
            const d = dist * (0.8 + h(20 + k) * 0.4);
            const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
            const s = 0.8 + h(30 + k) * 0.4;
            clump(px, pz, r * s, hh * s, k + 1, col, top);
            pts.push([px, y + hh * s * 0.85, pz, r * s]);
        }
        return pts;
    };

    /** 在叶簇表面散落小凸起（花、果子）；远处的块不画 */
    const dots = (pts: number[][], cols: RGB[], per: number, size: number) => {
        if (v.far) return;
        let k = 0;
        for (const [px, py, pz, r] of pts) {
            for (let i = 0; i < per; i++, k++) {
                const a = h(60 + k) * Math.PI * 2, d = r * (0.2 + h(80 + k) * 0.5);
                const c = cols[Math.floor(h(100 + k) * cols.length)];
                v.base.stud(px + Math.cos(a) * d, py - d * 0.35, pz + Math.sin(a) * d, size, shade(c, 0.85), c);
            }
        }
    };

    switch (variant) {
        case 0: {
            clump(x, z, R * 0.7, 1.3 + h(3) * 0.4, 0);
            ring(3 + (h(4) < 0.5 ? 1 : 0), R * 0.55, R * 0.5, 0.9 + h(5) * 0.3);
            break;
        }
        case 1: {
            // 花色每格一种（偶尔两种混开）
            const c1 = FLOWER_COLORS[Math.floor(h(6) * FLOWER_COLORS.length)];
            const c2 = h(7) < 0.3 ? FLOWER_COLORS[Math.floor(h(8) * FLOWER_COLORS.length)] : c1;
            const hh = 1.1 + h(3) * 0.3;
            clump(x, z, R * 0.65, hh, 0);
            const pts = ring(3, R * 0.5, R * 0.48, 0.85);
            pts.push([x, y + hh * 0.9, z, R * 0.6]);
            dots(pts, [c1, c2], 3, 0.13);
            break;
        }
        case 2: {
            const dark = T(shade(BUSH_DARK, 0.95 + jitter * 0.15));
            const top = T(mix(BUSH_DARK, BUSH, 0.6));
            const hh = 1.0 + h(3) * 0.3;
            clump(x, z, R * 0.72, hh, 0, dark, top);
            const pts = ring(4, R * 0.55, R * 0.45, 0.8, dark, top);
            pts.push([x, y + hh * 0.9, z, R * 0.6]);
            dots(pts, [BERRY], 2, 0.1);
            break;
        }
        default: {
            // 蕨丛：中间垫一小团矮叶簇，周围一圈对折的单片叶子从中心向外铺开
            clump(x, z, R * 0.4, 0.45, 0, base, base);
            const n = 6 + Math.floor(h(3) * 3);
            for (let k = 0; k < n; k++) {
                const a = (k / n) * Math.PI * 2 + h(120 + k) * 0.5;
                const d = R * (0.75 + h(140 + k) * 0.45);
                const tipY = y + 0.15 + h(160 + k) * 0.35;
                v.leaf.leaf(x + Math.cos(a) * R * 0.12, y + 0.05, z + Math.sin(a) * R * 0.12,
                    x + Math.cos(a) * d, tipY, z + Math.sin(a) * d,
                    0.16 + h(180 + k) * 0.1, 0.12 + h(200 + k) * 0.1, mix(base, light, 0.3 + h(220 + k) * 0.7));
            }
            break;
        }
    }
}

/** 棕榈离水最远多少米 */
const PALM_WATER_DIST = 21;
/** 地形噪声高于这个值的地方离水一定很远，不用再采样（省时间） */
const PALM_NOISE_MAX = 0.47;

/**
 * 点 (x,z) 处的树是棕榈的概率（0 = 不会是棕榈）。
 * 在周围 8 个方向 × 3 圈（7 / 14 / 21 米）采样地形：
 * - 一个水面采样点都没有 => 0，不在水附近不长棕榈（只看地形噪声不行：地势平缓的地方噪声值低，但离水可以很远）；
 * - 有水：沙地采样点越多（沙滩越大）概率越高，大沙滩边上成片（约 85%），只有一条窄沙边的水边零星几棵（约 15%）
 */
function palmChance(x: number, z: number): number {
    if (terrainNoise(x, z) > PALM_NOISE_MAX) return 0;
    let water = 0, sand = 0;
    for (let ring = 1; ring <= 3; ring++) {
        const d = ring * PALM_WATER_DIST / 3;
        for (let k = 0; k < 8; k++) {
            const a = (k + ring * 0.5) * Math.PI / 4;
            const n = terrainNoise(x + Math.cos(a) * d, z + Math.sin(a) * d);
            if (n < WATER_NOISE) water++;
            else if (n < SAND_NOISE) sand++;
        }
    }
    if (water === 0) return 0;
    return 0.15 + 0.7 * smoothstep(0.1, 0.35, sand / 24);
}

/**
 * 一棵树，按格子哈希从四种造型里选一种：
 * 0 松树（树干 + 五层松枝裙摆，下沿由松枝贴图裁成参差的枝梢）；1 阔叶树（主干分出三根枝，四团叶簇）；
 * 2 红叶树（浅色树干分出三根枝，五团红叶）；3 棕榈（两节弯曲的树干 + 七片弧形长叶）。
 * 叶团画在 foliage 层（树叶贴图），树干树枝画在 bark 层（树皮贴图），棕榈的长叶和果子画在 base 层（纯顶点色）。
 * 高度 4~6 米。s 是整体缩放，leaf 是基础叶色，mountain 为 true 时不出棕榈、红叶树用传入的秋色。
 * 棕榈只出现在水边，松树按低频噪声成片分布、大小不一
 */
function treeCell(v: Veg, gx: number, gz: number, x: number, y: number, z: number, s: number, leaf: RGB, mountain = false) {
    const rnd = (k: number) => (i: number) => hash2(gx * 73 + i, gz * 59 + k, SEED + 4300);
    const h = (k: number) => hash2(gx, gz, SEED + 4400 + k);
    const rot = h(1) * Math.PI * 2;
    // 棕榈只长在水边，大沙滩旁边成片，见 palmChance
    const palmP = mountain ? 0 : palmChance(x, z);
    // 松树成片：低频噪声划出松林，松林里绝大多数是松树，松林外只有零星几棵；山上松树本来就多
    const stand = smoothstep(0.45, 0.6, fbm(x / 45, z / 45, 2, SEED + 4700));
    const pineP = mountain ? 0.3 + 0.62 * stand : 0.05 + 0.87 * stand;
    let variant: number;
    if (h(0) < palmP) variant = 3;
    else if (h(6) < pineP) variant = 0;
    else variant = h(7) < 0.66 ? 1 : 2;
    // 松林里大树小树混在一起：松树的大小差别拉大（约 0.55~1.25 倍）
    if (variant === 0) s *= 0.55 + h(5) * 0.7;
    // 叶子和树干乘贴图，颜色要补偿贴图的平均亮度
    const T = (c: RGB, f = 1) => shade(c, f * TEX_GAIN);
    const trunk = T(TRUNK, 0.9 + h(2) * 0.2);
    /** 从 (bx,by,bz) 往方位角 a 伸出一根树枝，水平伸出 out、升高 up，返回枝梢 */
    const branch = (bx: number, by: number, bz: number, a: number, out: number, up: number, r0: number, col: RGB) => {
        const ex = bx + Math.cos(a) * out * s, ey = by + up * s, ez = bz + Math.sin(a) * out * s;
        v.bark.prism(bx, by, bz, r0 * s, ex, ey, ez, r0 * 0.45 * s, col, 4, a);
        return [ex, ey, ez];
    };
    /** 一团叶簇：中心 c，水平半径 r、竖直半径 ry */
    const clump = (c: number[], r: number, ry: number, col: RGB, top: RGB, k: number) =>
        crown(v, c[0], c[1], c[2], r * s, ry * s, r * (0.85 + h(10 + k) * 0.3) * s, col, top, rnd(k), r > 1.1 ? 12 : 9);

    if (variant === 0) {
        // 松树：树干下面露出一截，上面五层往下垂的松枝裙摆，一层压一层、越往上越小，最上面收成尖顶。
        // 每层的下沿由松枝贴图裁成参差的枝梢，从缝隙里能看到下一层和树干
        v.bark.prism(x, y, z, 0.22 * s, x, y + 3.6 * s, z, 0.06 * s, trunk, 5, rot);
        const TIERS = 5;
        for (let k = 0; k < TIERS; k++) {
            const t = k / (TIERS - 1);
            const rBot = 1.5 * (1 - t * 0.7) * (0.92 + h(60 + k) * 0.16) * s;
            const yBot = y + (0.75 + k * 0.85) * s;
            const yTop = yBot + (1.5 - t * 0.4) * s;
            v.pine.skirt(x, yTop, z, k === TIERS - 1 ? 0 : rBot * 0.2, yBot, rBot, T(leaf, 0.85 + t * 0.35),
                v.far ? 5 : 8, rot + k * 0.9, k < 2 ? 2 : 1);
        }
        return;
    }
    if (variant === 1) {
        // 阔叶树：粗短的树干分出两根斜枝，主干继续往上；枝梢各顶一团叶簇，下面再垫一团，树冠宽而蓬松
        const top = y + 1.6 * s;
        v.bark.prism(x, y, z, 0.3 * s, x, top, z, 0.18 * s, trunk, 6, rot);
        const col = T(leaf), light = T(mix(leaf, LEAF_LIGHT, 0.55));
        const tips = [
            branch(x, top, z, rot, 0.15, 1.2, 0.18, trunk),
            branch(x, top - 0.2 * s, z, rot + 2.3, 1.0, 0.9, 0.14, trunk),
            branch(x, top - 0.1 * s, z, rot + 4.2, 0.9, 1.0, 0.13, trunk),
        ];
        clump([tips[0][0], tips[0][1] + 0.5 * s, tips[0][2]], 1.35, 1.0, col, light, 0);
        clump(tips[1], 1.0, 0.8, col, light, 1);
        clump(tips[2], 0.95, 0.75, col, light, 2);
        const a = rot + 1.2;
        clump([x + Math.cos(a) * 0.7 * s, top + 0.9 * s, z + Math.sin(a) * 0.7 * s], 0.9, 0.7, shade(col, 0.9), light, 3);
        return;
    }
    if (variant === 2) {
        // 红叶树：浅色的高树干在 2/3 处分成三根枝，树冠是好几团红叶，又宽又高
        const bark = T([0.62, 0.50, 0.40], 0.92 + h(3) * 0.16);
        const top = y + 2.2 * s;
        v.bark.prism(x, y, z, 0.32 * s, x, top, z, 0.2 * s, bark, 6, rot);
        // 平地上的红叶树偏橙红，山上的直接用传进来的秋色
        const red = mountain ? leaf : mix(LEAF_RED, LEAF_YELLOW, h(4) * 0.35);
        const col = T(red, 0.92), light = T(mix(red, LEAF_YELLOW, 0.3), 1.05);
        for (let k = 0; k < 3; k++) {
            const tip = branch(x, top, z, rot + k * 2.1 + (h(20 + k) - 0.5) * 0.6, 1.0 + h(30 + k) * 0.3, 1.1 + h(40 + k) * 0.4, 0.15, bark);
            clump(tip, 1.05, 0.8, col, light, k);
        }
        clump([x, top + 2.0 * s, z], 1.25, 0.95, col, light, 3);
        const a = rot + 1.05;
        clump([x + Math.cos(a) * 0.9 * s, top + 1.6 * s, z + Math.sin(a) * 0.9 * s], 0.9, 0.7, col, light, 4);
        return;
    }
    // 棕榈：两节往一边弯的细树干，顶上七片弧形长叶，中间一小团深色的果子。
    // 成片的棕榈要错落有致：整体大小（约 0.6~1.3 倍）、树干高矮（0.75~1.3 倍）、弯的程度（0.4~1.8 倍）各自随机，
    // 有高有矮、有直有斜，树冠不会排在同一个高度上
    s *= 0.6 + h(5) * 0.7;
    const tall = 0.75 + h(8) * 0.55, lean = 0.4 + h(9) * 1.4;
    const bark = T(TRUNK, 1.2);
    const a0 = rot;
    const mx = x + Math.cos(a0) * 0.25 * lean * s, mz = z + Math.sin(a0) * 0.25 * lean * s, my = y + 2.2 * tall * s;
    const tx = x + Math.cos(a0) * 0.8 * lean * s, tz = z + Math.sin(a0) * 0.8 * lean * s, ty = y + 4.3 * tall * s;
    v.bark.prism(x, y, z, 0.2 * s, mx, my, mz, 0.15 * s, bark, 5, rot);
    v.bark.prism(mx, my, mz, 0.15 * s, tx, ty, tz, 0.11 * s, bark, 5, rot);
    // 果子和长叶画在纯顶点色的 base 层：树叶贴图是一片片小叶子，投影到一整片长叶上会变成斑点
    v.base.blob(tx, ty - 0.1 * s, tz, 0.3 * s, 0.25 * s, 0.3 * s, shade(TRUNK, 0.8), TRUNK, rnd(9), 4);
    // 七片长叶：每片是一整条先上扬再下垂的弧形叶片；一高一低交替，树冠上下有层次
    for (let k = 0; k < 7; k++) {
        const a = rot + (k / 7) * Math.PI * 2 + (h(50 + k) - 0.5) * 0.4;
        const high = (k & 1) === 1;
        const len = (high ? 1.5 : 2.0) * (0.9 + h(20 + k) * 0.25) * s;
        const rise = (high ? 0.75 : 0.4) * s;
        const droop = (high ? 0.1 : 0.7 + h(30 + k) * 0.5) * s;
        v.base.frond(tx, ty, tz, Math.cos(a), Math.sin(a), len, rise, droop, 0.34 * s,
            shade(LEAF_LIGHT, (high ? 0.95 : 0.8) + h(40 + k) * 0.2));
    }
}

/**
 * 一个石头格子（不可走）的模型，按格子哈希从几种造型里选一种：
 * 0 圆滚的大石头；1 一大两小的石堆；2 长苔藓的大石头（花岗岩）；
 * 3 叠起来的扁平石板；4 往上收的石柱（层状砂岩）。
 * 朝向、尺寸、颜色都有随机变化。scale 决定水平尺寸（1 = 基本占满格子），
 * hScale 是这一带石头的整体高矮（石林里有的地方高耸、有的地方低矮）
 */
function stoneCell(granite: MeshBuilder, strata: MeshBuilder, gx: number, gz: number,
    x: number, y: number, z: number, jitter: number, scale = 1, hScale = 1, strataZone = 0.4) {
    const rnd = (k: number) => (i: number) => hash2(gx * 97 + i, gz * 89 + k, SEED + 4000);
    const h = (k: number) => hash2(gx, gz, SEED + 4100 + k);
    // 岩性按区域决定（一片灰色花岗岩、一片黄色砂岩），不再逐格随机混在一起
    // 花岗岩：0 圆石 / 1 石堆 / 2 苔藓石（少）；砂岩：3 石板 / 4 石柱
    const variant = h(0) < strataZone
        ? (h(7) < 0.55 ? 3 : 4)
        : (h(7) < 0.5 ? 0 : h(7) < 0.85 ? 1 : 2);
    const rot = h(1) * Math.PI * 2;
    const R = CELL * 0.5 * scale;   // 格子半宽
    const gcol = shade(GRANITE, 0.9 + jitter * 0.2);
    const scol = shade(STRATA, 0.9 + jitter * 0.2);
    // 偏离格子中心一点（小石头偏得更多，避免一格一个中心）
    const ox = (h(2) - 0.5) * (0.3 + 0.8 * (1 - scale)), oz = (h(3) - 0.5) * (0.3 + 0.8 * (1 - scale));
    switch (variant) {
        case 0: {
            const s = 0.85 + h(4) * 0.3;
            granite.rock(x + ox, y, z + oz, R * 0.95 * s, R * (0.75 + h(5) * 0.2) * s, (1.3 + h(6) * 0.6) * s * hScale, rot, gcol, rnd(0), 1.08);
            break;
        }
        case 1: {
            granite.rock(x + ox, y, z + oz, R * 0.7, R * 0.6, (1.3 + h(4) * 0.4) * hScale, rot, gcol, rnd(0), 1.05);
            for (let k = 0; k < 2; k++) {
                const a = rot + k * 2.4 + h(10 + k);
                const d = R * 0.6;
                const s = 0.3 + h(12 + k) * 0.2;
                granite.rock(x + Math.cos(a) * d, y, z + Math.sin(a) * d, R * s, R * s * 0.85, 0.7 * s * 2 * hScale,
                    a, shade(gcol, 0.92 + h(14 + k) * 0.15), rnd(1 + k), 1.1);
            }
            break;
        }
        case 2: {
            const s = 0.9 + h(4) * 0.25;
            granite.rock(x + ox, y, z + oz, R * 0.92 * s, R * 0.82 * s, (1.1 + h(5) * 0.4) * s * hScale, rot, gcol, rnd(0), 1.12,
                shade(MOSS, 0.9 + h(6) * 0.2));
            break;
        }
        case 3: {
            // 2~3 层扁平石板，越往上越小，每层朝向略有偏转
            const n = 2 + (h(4) < 0.5 ? 1 : 0);
            let yy = y;
            for (let k = 0; k < n; k++) {
                const s = 1 - k * 0.24;
                const th = (0.45 + h(5 + k) * 0.25) * hScale;
                strata.rock(x + ox * (1 + k), yy, z + oz * (1 - k), R * 0.95 * s, R * 0.8 * s, th + 0.2, rot + k * 0.4,
                    shade(scol, 0.95 + h(8 + k) * 0.12), rnd(k), 1.02);
                yy += th;
            }
            break;
        }
        default: {
            // 石柱 + 脚下一块碎石。约三分之一是高大的石柱：高 1.7~2.8 倍、粗 1.3~1.7 倍（粗细不受格子内缩放影响，
            // 可以略微超出格子），石林里高矮差别大，不会一片同样高的石笋
            const s = 0.85 + h(4) * 0.3;
            const big = h(20) < 0.35;
            const tall = big ? 1.7 + h(21) * 1.1 : 0.8 + h(21) * 0.5;
            const fat = big ? (1.3 + h(22) * 0.4) / Math.max(scale, 0.6) : 1;
            const pr = R * fat;
            strata.rock(x + ox, y, z + oz, pr * 0.75 * s, pr * 0.65 * s, (2.2 + h(5) * 0.9) * s * tall * hScale, rot, scol, rnd(0),
                big ? 0.86 : 0.82, undefined, big ? 9 : 7);
            const a = rot + 1.9;
            strata.rock(x + Math.cos(a) * pr * 0.7, y, z + Math.sin(a) * pr * 0.7, pr * 0.3, pr * 0.25, 0.45 * hScale * (big ? 1.5 : 1),
                a, shade(scol, 0.9), rnd(1), 1.1);
            break;
        }
    }
}

/**
 * 大石头：一颗石头跨好几格，只在成片的石林里出现。
 * 由全局哈希决定，所以相邻块算出完全一样的结果（中心所在的块负责画，其余块只用来避开重叠）
 */
interface BigStone { x: number; z: number; r: number; h: number; rot: number; strata: boolean; moss: boolean; seed: number }
const BIG_STONE_STEP = 10;
const BIG_STONE_REACH = 9;   // 半径上限 + 余量，查覆盖范围时用

class BigStoneCache {
    private map = new Map<number, BigStone | null>();
    constructor(private kindG: (gx: number, gz: number) => number) { }
    private at(ix: number, iz: number): BigStone | null {
        const key = ix * 73856093 + iz * 19349663;
        let s = this.map.get(key);
        if (s !== undefined) return s;
        s = bigStoneAt(ix, iz, this.kindG);
        this.map.set(key, s);
        return s;
    }
    /** 覆盖点 (wx,wz) 的大石头中，距离最近的那颗的“靠近程度”（0 没碰到，1 完全盖住） */
    cover(wx: number, wz: number): number {
        let best = 0;
        const i0 = Math.floor(wx / BIG_STONE_STEP), j0 = Math.floor(wz / BIG_STONE_STEP);
        for (let j = j0 - 1; j <= j0 + 1; j++) for (let i = i0 - 1; i <= i0 + 1; i++) {
            const s = this.at(i, j);
            if (!s) continue;
            const t = 1 - Math.hypot(wx - s.x, wz - s.z) / (s.r + 0.6);
            if (t > best) best = t;
        }
        return best;
    }
    /** 可能与本块相交的全部大石头（先把本块及周围一圈网格点算出来，之后 all() 才完整） */
    all(): BigStone[] {
        const out: BigStone[] = [];
        for (const s of this.map.values()) if (s) out.push(s);
        return out;
    }
    /** 保证覆盖矩形 [x0,x1]×[z0,z1]（外扩半径余量）的网格点都已计算 */
    ensure(x0: number, z0: number, x1: number, z1: number) {
        const i0 = Math.floor((x0 - BIG_STONE_REACH) / BIG_STONE_STEP), i1 = Math.floor((x1 + BIG_STONE_REACH) / BIG_STONE_STEP);
        const j0 = Math.floor((z0 - BIG_STONE_REACH) / BIG_STONE_STEP), j1 = Math.floor((z1 + BIG_STONE_REACH) / BIG_STONE_STEP);
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.at(i, j);
    }
}

function bigStoneCover(c: BigStoneCache, wx: number, wz: number): number { return c.cover(wx, wz); }

/** 网格点 (ix,iz) 上的大石头（没有则返回 null） */
function bigStoneAt(ix: number, iz: number, kindG: (gx: number, gz: number) => number): BigStone | null {
    const h = (k: number) => hash2(ix, iz, SEED + 4700 + k);
    if (h(0) > 0.7) return null;   // 不是每个网格点都有
    const x = (ix + 0.5) * BIG_STONE_STEP + (h(1) - 0.5) * BIG_STONE_STEP * 0.7;
    const z = (iz + 0.5) * BIG_STONE_STEP + (h(2) - 0.5) * BIG_STONE_STEP * 0.7;
    // 只长在成片的石林里：中心和周围一圈都得是石头格子
    let rock = 0, n = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        n++;
        if (kindG(Math.floor(x / CELL) + dx * 2, Math.floor(z / CELL) + dz * 2) === Cell.Rock) rock++;
    }
    if (rock < n - 1) return null;
    const zone = stoneZone(x, z);
    return {
        x, z,
        r: 2.2 + h(3) * 2.6,          // 直径 4~10 米
        h: (1.4 + h(4) * 2.4) * stoneHeightScale(x, z),
        rot: h(5) * Math.PI * 2,
        strata: h(6) < zone,
        moss: h(7) < 0.12,
        seed: (hash2(ix, iz, SEED + 4800) * 1e9) | 0,
    };
}

/** 这一带石头的整体高矮（0.6~1.6），几十米一个变化，石林里有高耸的石柱区也有低矮的碎石区 */
function stoneHeightScale(wx: number, wz: number): number {
    return 0.6 + fbm(wx / 46, wz / 46, 2, SEED + 4900);
}

/** 这一带的岩性（0 全是花岗岩，1 全是砂岩），大片渐变，灰色和黄色不会一格一格混在一起 */
function stoneZone(wx: number, wz: number): number {
    return fbm(wx / 34, wz / 34, 2, SEED + 5000);
}

function drawBigStone(granite: MeshBuilder, strata: MeshBuilder, s: BigStone) {
    const mb = s.strata ? strata : granite;
    const col = shade(s.strata ? STRATA : GRANITE, 0.92 + hash2(s.seed, 1, SEED + 4810) * 0.16);
    const rnd = (i: number) => hash2(s.seed, i, SEED + 4820);
    const rx = s.r * (0.85 + hash2(s.seed, 2, SEED + 4830) * 0.3);
    const rz = s.r * (0.85 + hash2(s.seed, 3, SEED + 4830) * 0.3);
    const bulge = s.strata ? 0.8 + hash2(s.seed, 4, SEED + 4830) * 0.25 : 1.02 + hash2(s.seed, 4, SEED + 4830) * 0.16;
    // 14 个切面，大石头看起来圆，不会是一个大锥子；平滑着色，看不出一块块的三角面
    mb.rock(s.x, terrainHeight(s.x, s.z) - 0.4, s.z, rx, rz, s.h, s.rot, col, rnd, bulge,
        s.moss ? shade(MOSS, 0.9 + hash2(s.seed, 5, SEED + 4830) * 0.2) : undefined, 14, true);
}

/** 格子角落的碎石：只在石头格子旁边出现，打破格子的轮廓 */
function pebbles(granite: MeshBuilder, strata: MeshBuilder, gx: number, gz: number,
    x0: number, z0: number, y: number, big: BigStoneCache, strataZone: number, extra = 0) {
    const h = (k: number) => hash2(gx, gz, SEED + 4950 + k);
    const n = extra + 1 + Math.floor(h(0) * 2);
    for (let k = 0; k < n; k++) {
        const px = x0 + h(10 + k) * CELL, pz = z0 + h(20 + k) * CELL;
        if (big.cover(px, pz) > 0) continue;
        const mb = h(30 + k) < strataZone ? strata : granite;
        const r = 0.16 + h(40 + k) * 0.22;
        const col = shade(mb === strata ? STRATA : GRANITE, 0.85 + h(50 + k) * 0.25);
        // 碎石很小，4 个切面、两圈顶点就够（12 个三角形）
        mb.rock(px, y - 0.1, pz, r, r * (0.75 + h(60 + k) * 0.4), 0.22 + h(70 + k) * 0.28,
            h(80 + k) * Math.PI * 2, col, i => hash2(gx * 17 + k, gz * 13 + i, SEED + 4960), 1.1, undefined, 4);
    }
}

/** 砂石路面：所有格子同一个颜色（不做逐格明暗，否则会拼成棋盘格），深浅变化交给贴图 */
const GRAVEL_COL = shade(COLORS[Cell.Road], TEX_GAIN);
function gravelQuad(gravel: MeshBuilder, lx: number, lz: number, x0: number, z0: number,
    h00: number, h10: number, h11: number, h01: number, ref: number[]) {
    const x1 = x0 + CELL, z1 = z0 + CELL;
    // 块内坐标做 UV，块边长是 GRAVEL_TILE 的整数倍，块之间无缝
    const u0 = lx * CELL / GRAVEL_TILE, u1 = u0 + CELL / GRAVEL_TILE;
    const v0 = lz * CELL / GRAVEL_TILE, v1 = v0 + CELL / GRAVEL_TILE;
    gravel.quad([x0, h00, z0], [x1, h10, z0], [x1, h11, z1], [x0, h01, z1], GRAVEL_COL, ref,
        [u0, v0, u1, v0, u1, v1, u0, v1]);
}

/**
 * 山体岩石面的 UV 投影面（顶点顺序 00-10-11-01，size 是边长，米）。按面的朝向选：
 * 0 缓坡，从上往下投影 (x,z)；1 朝 ±x 的陡坡，投影到 (z, 高度)；2 朝 ±z 的陡坡，投影到 (x, 高度)。
 * 陡坡投影到侧面，悬崖上的纹理不会被拉长，岩层是横向的。
 * 水平坐标用块内坐标（块边长是 ROCK_TILE 的整数倍，块之间无缝）
 */
function rockUVMode(size: number, h00: number, h10: number, h11: number, h01: number): number {
    const dhx = Math.abs((h10 + h11) - (h00 + h01)) / (2 * size);
    const dhz = Math.abs((h01 + h11) - (h00 + h10)) / (2 * size);
    if (Math.max(dhx, dhz) < 0.8) return 0;
    return dhx > dhz ? 1 : 2;
}

/** 桥面顶部高度 = 可走高度，角色正好站在桥面上 */
const DECK_Y = WALK_MIN_Y;
const DECK_THICK = 0.22;
const RAIL_H = 0.95;

/**
 * 一个桥格子的模型：木板桥面（贴图）+ 桥面侧边 + 临水一侧的栏杆（立柱、扶手、中栏）+ 立柱下的桥墩。
 * 立柱放在格子边的中点，每段扶手正好一个格子长，相邻格子的栏杆首尾相接。
 */
function buildBridgeCell(mb: MeshBuilder, plank: MeshBuilder, kindAt: (lx: number, lz: number) => number,
    lx: number, lz: number, x0: number, z0: number, alongX: boolean, floorY: number, jitter: number) {
    const x1 = x0 + CELL, z1 = z0 + CELL;
    const cxw = x0 + CELL / 2, czw = z0 + CELL / 2;
    const top = DECK_Y, bot = DECK_Y - DECK_THICK;

    // 桥面：一个格子 = 一张木板贴图，贴图的 u 是木板长度方向
    const deckCol = shade(COLORS[Cell.Bridge], (0.96 + jitter * 0.08) * TEX_GAIN);
    const uv = alongX
        ? [0, 0, 0, 1, 1, 1, 1, 0]    // 桥沿 x 延伸：木板沿 z 铺，u 对应 z
        : [0, 0, 1, 0, 1, 1, 0, 1];   // 桥沿 z 延伸：木板沿 x 铺，u 对应 x
    plank.quad([x0, top, z0], [x1, top, z0], [x1, top, z1], [x0, top, z1], deckCol, [cxw, -1000, czw], uv);

    const sideCol = shade(COLORS[Cell.Bridge], 0.78);
    const ref = [cxw, bot + DECK_THICK / 2, czw];
    // 四条边：邻格方向 (dx,dz) + 边的两个端点
    const edges: [number, number, number, number, number, number][] = [
        [0, -1, x0, z0, x1, z0],
        [0, 1, x0, z1, x1, z1],
        [-1, 0, x0, z0, x0, z1],
        [1, 0, x1, z0, x1, z1],
    ];
    for (const [dx, dz, ax, az, bx, bz] of edges) {
        const nk = kindAt(lx + dx, lz + dz);
        if (nk === Cell.Bridge) continue;
        // 桥面侧边（与陆地相接处会埋进地形里）
        mb.quad([ax, bot, az], [bx, bot, bz], [bx, top, bz], [ax, top, az], sideCol, ref);
        if (nk !== Cell.Water) continue;

        // 栏杆往格子内缩一点
        const inset = 0.12;
        const mx = (ax + bx) / 2 - dx * inset, mz = (az + bz) / 2 - dz * inset;
        const alongEdgeX = dz !== 0;
        // 立柱 + 桥墩（桥墩一直插到水底）
        mb.box(mx, bot, mz, 0.16, top - bot + RAIL_H, 0.16, POST, shade(POST, 1.15));
        if (floorY < bot) mb.box(mx, floorY - 0.2, mz, 0.26, bot - floorY + 0.2, 0.26, shade(POST, 0.85));
        // 扶手和中栏
        mb.box(mx, top + RAIL_H - 0.1, mz, alongEdgeX ? CELL : 0.1, 0.1, alongEdgeX ? 0.1 : CELL, RAIL, shade(RAIL, 1.15));
        mb.box(mx, top + RAIL_H * 0.45, mz, alongEdgeX ? CELL : 0.06, 0.07, alongEdgeX ? 0.06 : CELL, shade(RAIL, 0.92));
    }
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

export interface WorldMaterials {
    terrain: Record<TerrainLayer, Laya.BlinnPhongMaterial>;
    water: Laya.Material;
}

function terrainMaterial(tex: Laya.BaseTexture | null): Laya.BlinnPhongMaterial {
    const m = new Laya.BlinnPhongMaterial();
    m.enableVertexColor = true;
    m.albedoColor = new Laya.Color(1, 1, 1, 1);
    m.specularColor = new Laya.Color(0, 0, 0, 1);
    if (tex) m.albedoTexture = tex;
    m.lock = true;
    return m;
}

/** 草地/沙地材质：alpha 测试，顶点 alpha × 贴图 alpha < 0.5 的像素被裁掉 */
function cutoutMaterial(tex: Laya.BaseTexture): Laya.BlinnPhongMaterial {
    const m = terrainMaterial(tex);
    m.lock = false;
    m.materialRenderMode = Laya.MaterialRenderMode.RENDERMODE_CUTOUT;
    m.alphaTestValue = 0.5;
    m.lock = true;
    return m;
}

/** 叶簇面片 / 松枝材质：alpha 测试裁出叶片轮廓，双面显示（从背面、从下面也要看得见） */
function leafCardMaterial(tex: Laya.BaseTexture): Laya.BlinnPhongMaterial {
    const m = terrainMaterial(tex);
    m.lock = false;
    m.materialRenderMode = Laya.MaterialRenderMode.RENDERMODE_CUTOUT;
    // 远处贴图缩小后 alpha 被平均变淡，阈值低一点，远看树冠不会变稀
    m.alphaTestValue = 0.35;
    m.cull = Laya.RenderState.CULL_NONE;
    m.lock = true;
    return m;
}

/** 地形和水面共用的材质（游戏运行和编辑器预览共用） */
export function createWorldMaterials(): WorldMaterials {
    const water = createWaterMaterial();
    water.lock = true;
    return {
        terrain: {
            base: terrainMaterial(null),
            grass: cutoutMaterial(grassTexture()),
            sand: cutoutMaterial(sandTexture()),
            plank: terrainMaterial(plankTexture()),
            rock: terrainMaterial(rockTexture()),
            gravel: terrainMaterial(gravelTexture()),
            trail: cutoutMaterial(trailTexture()),
            granite: terrainMaterial(graniteTexture()),
            strata: terrainMaterial(strataTexture()),
            foliage: terrainMaterial(foliageTexture()),
            bark: terrainMaterial(barkTexture()),
            leafcard: leafCardMaterial(leafCardTexture()),
            pine: leafCardMaterial(pineTexture()),
        },
        water,
    };
}
