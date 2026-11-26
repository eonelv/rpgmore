import { cellColor } from "../world/ChunkRenderer";
import { Vec2 } from "../world/PathFinder";
import { SpawnInfo } from "../world/Spawns";
import { rgbToCss, unitDef } from "../world/UnitDefs";
import { NavGrid } from "../world/NavGrid";
import { CELL, CHUNK_CELLS, CHUNK_SIZE, Cell, chunkKey } from "../world/WorldConfig";
import { areaKeyAt, isNamedArea, newPlaceInfo, placeAt } from "../world/Areas";
import { unwarp, warped } from "../world/Biome";

/** 小地图上要画的怪物（只需要位置和种类） */
export interface MapUnit { pos: Vec2; kind: string; state: string; }

interface Tile { tex: Laya.Texture; t2d: Laya.Texture2D; }

/**
 * 右上角小地图。
 * - 每个块生成一张 32x32 贴图（1 格 = 1 像素），颜色取自地形配色，缓存起来
 * - 格子被修改（砍树）时只重画那一块
 * - 区域分界画在贴图里（深色描边）；区域名写在区域露在地图里的那部分的中间，大地图上还写小地名
 * - 叠加：玩家箭头、怪物点、刷怪点范围、路径终点
 * - M 键切换 小地图 / 大地图
 */
export class Minimap {
    readonly view = new Laya.Sprite();
    private mapLayer = new Laya.Sprite();
    private iconLayer = new Laya.Sprite();
    private tiles = new Map<number, Tile>();
    private pixels = new Uint8Array(CHUNK_CELLS * CHUNK_CELLS * 4);
    private areaKeys = new Float64Array((CHUNK_CELLS + 2) * (CHUNK_CELLS + 2));
    private big = false;
    private lastKey = "";

    /** 小地图边长（像素）和显示的世界范围（米） */
    private size = 200;
    private range = 320;

    constructor(private nav: NavGrid, private spawns: SpawnInfo[]) {
        this.view.addChild(this.mapLayer);
        this.view.addChild(this.iconLayer);
        this.view.mouseEnabled = false;
        Laya.stage.addChild(this.view);
        this.layout();
        Laya.stage.on(Laya.Event.RESIZE, this, this.layout);
    }

    toggle() {
        this.big = !this.big;
        this.layout();
    }

    private layout() {
        if (this.big) {
            this.size = Math.min(Laya.stage.width, Laya.stage.height) - 80;
            this.range = 1600;
            this.view.pos((Laya.stage.width - this.size) / 2, (Laya.stage.height - this.size) / 2);
        } else {
            this.size = 200;
            this.range = 320;
            this.view.pos(Laya.stage.width - this.size - 10, 10);
        }
        this.view.scrollRect = new Laya.Rectangle(0, 0, this.size, this.size);
        this.lastKey = "";
    }

    /** 格子被修改后调用：丢掉这一块的缓存，下次绘制时重画 */
    invalidate(cx: number, cz: number) {
        const key = chunkKey(cx, cz);
        const t = this.tiles.get(key);
        if (t) { t.t2d.destroy(); this.tiles.delete(key); this.lastKey = ""; }
    }

    /** 每帧最多新生成几块贴图（打开大地图时分几帧画完，不卡顿） */
    private buildBudget = 0;

    private tile(cx: number, cz: number): Tile | null {
        const key = chunkKey(cx, cz);
        let t = this.tiles.get(key);
        if (t) return t;
        if (this.buildBudget <= 0) return null;
        this.buildBudget--;
        const data = this.nav.getChunk(cx, cz);
        const px = this.pixels, N = CHUNK_CELLS, M = N + 2;
        // 每格所在区域（多算一圈），和上下左右任一格不同的格子是分界，画暗一些
        const keys = this.areaKeys;
        for (let lz = -1; lz <= N; lz++)
            for (let lx = -1; lx <= N; lx++)
                keys[(lz + 1) * M + lx + 1] = areaKeyAt((cx * N + lx + 0.5) * CELL, (cz * N + lz + 0.5) * CELL);
        for (let lz = 0; lz < N; lz++) {
            for (let lx = 0; lx < N; lx++) {
                // 草地、沙地按地貌着色（荒原枯黄、北域雪白……）
                const c = cellColor(data.kindLocal(lx, lz), (cx * N + lx + 0.5) * CELL, (cz * N + lz + 0.5) * CELL);
                const water = data.kindLocal(lx, lz) === Cell.Water;
                const k = (lz + 1) * M + lx + 1, key = keys[k];
                const edge = keys[k - 1] !== key || keys[k + 1] !== key || keys[k - M] !== key || keys[k + M] !== key;
                const f = edge ? 0.35 : 1;
                const i = (lz * N + lx) * 4;
                px[i] = (water ? 0.22 : c[0]) * 255 * f;
                px[i + 1] = (water ? 0.45 : c[1]) * 255 * f;
                px[i + 2] = (water ? 0.78 : c[2]) * 255 * f;
                px[i + 3] = 255;
            }
        }
        const t2d = new Laya.Texture2D(N, N, Laya.TextureFormat.R8G8B8A8, false, false, false);
        t2d.filterMode = Laya.FilterMode.Point;
        t2d.wrapModeU = Laya.WrapMode.Clamp;
        t2d.wrapModeV = Laya.WrapMode.Clamp;
        t2d.setPixelsData(px, false, false);
        t = { t2d, tex: new Laya.Texture(t2d) };
        this.tiles.set(key, t);
        return t;
    }

    /** 地图中心（玩家）的世界坐标，update 时记录，供点击换算用 */
    private center: Vec2 | null = null;

    /**
     * 屏幕坐标是否落在地图上；落在地图上则返回对应的世界坐标，否则返回 null。
     * 小地图和大地图通用（两者只是 size / range 不同）。
     */
    pick(sx: number, sy: number): Vec2 | null {
        if (!this.center || !this.view.visible) return null;
        const lx = sx - this.view.x, ly = sy - this.view.y, S = this.size;
        if (lx < 0 || ly < 0 || lx > S || ly > S) return null;
        const k = this.range / S;
        return { x: this.center.x + (lx - S / 2) * k, z: this.center.z + (ly - S / 2) * k };
    }

    update(player: Vec2, heading: number, units: MapUnit[], target: Vec2 | null) {
        const S = this.size, scale = S / this.range;
        this.center = { x: player.x, z: player.z };
        const ox = player.x - this.range / 2, oz = player.z - this.range / 2;   // 左上角的世界坐标
        const toX = (wx: number) => (wx - ox) * scale, toY = (wz: number) => (wz - oz) * scale;

        // 地图层：玩家每移动约 1 像素才重画（贴图都已缓存，很便宜）
        const key = `${Math.round(ox * scale)},${Math.round(oz * scale)},${S}`;
        if (key !== this.lastKey) {
            this.lastKey = key;
            const g = this.mapLayer.graphics;
            g.clear();
            g.drawRect(0, 0, S, S, "#1a2a3a");
            const c0x = Math.floor(ox / CHUNK_SIZE), c1x = Math.floor((ox + this.range) / CHUNK_SIZE);
            const c0z = Math.floor(oz / CHUNK_SIZE), c1z = Math.floor((oz + this.range) / CHUNK_SIZE);
            const tw = CHUNK_SIZE * scale;
            this.buildBudget = 12;
            let missing = false;
            for (let cz = c0z; cz <= c1z; cz++)
                for (let cx = c0x; cx <= c1x; cx++) {
                    const t = this.tile(cx, cz);
                    if (t) g.drawTexture(t.tex, toX(cx * CHUNK_SIZE), toY(cz * CHUNK_SIZE), tw + 0.5, tw + 0.5);
                    else missing = true;
                }
            if (missing) this.lastKey = "";   // 下一帧继续画没生成完的块
            this.trimTiles(c0x, c1x, c0z, c1z);
        }

        // 图标层：每帧重画
        const g = this.iconLayer.graphics;
        g.clear();
        for (const s of this.spawns) {
            const x = toX(s.x), y = toY(s.z), r = Math.max(3, s.radius * scale);
            if (x < -r || y < -r || x > S + r || y > S + r) continue;
            g.drawCircle(x, y, r, null, rgbToCss(unitDef(s.kind).color), 1);
        }
        this.drawNames(g, ox, oz, toX, toY);
        const dot = this.big ? 2 : 2.5;
        for (const u of units) {
            const x = toX(u.pos.x), y = toY(u.pos.z);
            if (x < 0 || y < 0 || x > S || y > S) continue;
            g.drawCircle(x, y, dot, u.state === "chase" ? "#ff3366" : rgbToCss(unitDef(u.kind).color), "#000000", 0.5);
        }
        if (target) {
            const x = Math.min(S - 4, Math.max(4, toX(target.x))), y = Math.min(S - 4, Math.max(4, toY(target.z)));
            g.drawCircle(x, y, 4, null, "#ffdd22", 2);
        }
        // 玩家箭头（heading 0 = +Z = 屏幕下方）
        const px = S / 2, py = S / 2, sn = Math.sin(heading), cs = Math.cos(heading), L = 8;
        g.drawPoly(0, 0, [
            px + sn * L, py + cs * L,
            px - sn * L * 0.5 + cs * L * 0.55, py - cs * L * 0.5 - sn * L * 0.55,
            px - sn * L * 0.5 - cs * L * 0.55, py - cs * L * 0.5 + sn * L * 0.55,
        ], "#3388ff", "#ffffff", 1.5);
        g.drawRect(0, 0, S, S, null, "#ffffff", 2);
        g.drawLine(S / 2, 3, S / 2, 12, "#ffffff", 1);   // 北 = -Z = 上方
    }

    private labelInfo = newPlaceInfo();

    /**
     * 区域名和小地名。在显示范围里每隔一段取样，找出露在地图里的区域和小地名格子：
     * - 区域名写在区域和显示范围相交部分的中间（小地图上当前区域的名字因此始终可见）；
     * - 大地图上小地名写在小地名格子的中心（格子中心不在地图里就不写）
     */
    private drawNames(g: Laya.Graphics, ox: number, oz: number, toX: (x: number) => number, toY: (z: number) => number) {
        const S = this.size, R = this.range, big = this.big;
        const fs = big ? 20 : 14, font = `bold ${fs}px Arial`;
        const pfs = 13, pfont = `${pfs}px Arial`;
        const steps = big ? 8 : 3;
        const areas = new Map<number, { name: string; named: boolean; box: number[]; sx: number; sz: number }>();
        const places = new Map<number, { name: string; x: number; z: number }>();
        const p = this.labelInfo;
        for (let j = 0; j <= steps; j++) {
            for (let i = 0; i <= steps; i++) {
                const wx = ox + R * i / steps, wz = oz + R * j / steps;
                placeAt(wx, wz, p);
                if (!areas.has(p.area.key)) {
                    areas.set(p.area.key, { name: p.areaName, named: isNamedArea(p.area), box: [wx, wz, wx, wz], sx: wx, sz: wz });
                } else {
                    const b = areas.get(p.area.key)!.box;
                    b[0] = Math.min(b[0], wx); b[1] = Math.min(b[1], wz); b[2] = Math.max(b[2], wx); b[3] = Math.max(b[3], wz);
                }
                if (big && !places.has(p.placeKey)) places.set(p.placeKey, { name: p.placeName, x: p.placeX, z: p.placeZ });
            }
        }
        if (big) {
            for (const pl of places.values()) {
                unwarp(pl.x, pl.z);
                const x = toX(warped.x), y = toY(warped.z);
                if (x < 30 || y < 10 || x > S - 30 || y > S - 10) continue;
                g.drawCircle(x, y, 2, "#fff6d8", "#000000", 0.5);
                g.fillBorderText(pl.name, x, y + 4, pfont, "#e8e0c8", "center", 2, "#000000");
            }
        }
        for (const a of areas.values()) {
            // 取样点在这个区域里的范围（区域露出来的部分）的中间；那里不属于这个区域（区域是弯的）就用第一个取样点
            let cx = (a.box[0] + a.box[2]) / 2, cz = (a.box[1] + a.box[3]) / 2;
            if (areaKeyAt(cx, cz) !== areaKeyAt(a.sx, a.sz)) { cx = a.sx; cz = a.sz; }
            const x = Math.min(S - fs * 3, Math.max(fs * 3, toX(cx)));
            const y = Math.min(S - fs * 2, Math.max(fs, toY(cz) - fs * 1.4));
            g.fillBorderText(a.name, x, y, font, a.named ? "#fff6d8" : "#cfd8e0", "center", 3, "#000000");
        }
    }

    /** 回收远离显示范围的贴图 */
    private trimTiles(c0x: number, c1x: number, c0z: number, c1z: number) {
        if (this.tiles.size < 1200) return;
        for (const [key, t] of this.tiles) {
            const cx = Math.floor(key / 65536) - 32768, cz = (key % 65536) - 32768;
            if (cx < c0x - 4 || cx > c1x + 4 || cz < c0z - 4 || cz > c1z + 4) { t.t2d.destroy(); this.tiles.delete(key); }
        }
    }

    destroy() {
        Laya.stage.offAllCaller(this);
        for (const t of this.tiles.values()) t.t2d.destroy();
        this.tiles.clear();
        this.view.destroy(true);
    }
}


