import { NavGrid } from "./NavGrid";
import { CELL, CHUNK_CELLS } from "./WorldConfig";
import { roadNode } from "./WorldGen";

/**
 * 分层 + 分帧的格子 A*。
 *
 * 低层：8 方向 A*，禁止斜穿墙角。搜索范围限制在“起点块与终点块围成的矩形 + 1 块边距”内。
 *       世界生成保证矩形内一定有通路，所以限制范围不会导致找不到路。
 * 高层：目标超过 MAX_SPAN 块时，先在块网格上朝目标走 MAX_SPAN 块，
 *       以那块的道路节点作为中间目标。到达后再规划下一段（返回 partial=true）。
 * 分帧：每个请求每次 step() 最多展开固定数量的节点，PathService 按每帧时间预算推进队列。
 */

export interface Vec2 { x: number; z: number; }

export interface PathResult {
    ok: boolean;
    /** 世界坐标路径点（已平滑），不含起点 */
    points: Vec2[];
    /** true 表示这只是去往远处目标的一段，到达后需要继续请求 */
    partial: boolean;
    expanded: number;
}

const MAX_SPAN = 3;
const SQRT2 = Math.SQRT2;
const DIRS = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
];

class MinHeap {
    private idx: number[] = [];
    private key: number[] = [];
    get size() { return this.idx.length; }
    push(i: number, k: number) {
        const a = this.idx, b = this.key;
        a.push(i); b.push(k);
        let n = a.length - 1;
        while (n > 0) {
            const p = (n - 1) >> 1;
            if (b[p] <= k) break;
            a[n] = a[p]; b[n] = b[p];
            n = p;
        }
        a[n] = i; b[n] = k;
    }
    pop(): number {
        const a = this.idx, b = this.key;
        const top = a[0];
        const li = a.pop()!, lk = b.pop()!;
        if (a.length > 0) {
            let n = 0;
            const len = a.length;
            for (; ;) {
                let c = 2 * n + 1;
                if (c >= len) break;
                if (c + 1 < len && b[c + 1] < b[c]) c++;
                if (b[c] >= lk) break;
                a[n] = a[c]; b[n] = b[c];
                n = c;
            }
            a[n] = li; b[n] = lk;
        }
        return top;
    }
}

export class PathRequest {
    done = false;
    result: PathResult | null = null;
    cancelled = false;

    private ox = 0; private oz = 0; private w = 0; private h = 0;
    private g!: Float32Array;
    private parent!: Int32Array;
    private state!: Uint8Array;   // 0 未访问，1 开放，2 关闭，3 阻挡（缓存）
    private open = new MinHeap();
    private sx = 0; private sz = 0; private tx = 0; private tz = 0;
    private partial = false;
    private expanded = 0;
    private startWorld: Vec2;

    constructor(private nav: NavGrid, from: Vec2, to: Vec2, private onDone: (r: PathResult) => void) {
        this.startWorld = from;
        let sgx = Math.floor(from.x / CELL), sgz = Math.floor(from.z / CELL);
        let tgx = Math.floor(to.x / CELL), tgz = Math.floor(to.z / CELL);

        const s = nav.nearestWalkable(sgx, sgz, 3);
        if (!s) { this.finish(false, []); return; }
        sgx = s.gx; sgz = s.gz;

        // 高层：目标太远时，选一个中间目标
        const scx = Math.floor(sgx / CHUNK_CELLS), scz = Math.floor(sgz / CHUNK_CELLS);
        let tcx = Math.floor(tgx / CHUNK_CELLS), tcz = Math.floor(tgz / CHUNK_CELLS);
        if (Math.abs(tcx - scx) > MAX_SPAN || Math.abs(tcz - scz) > MAX_SPAN) {
            const dx = tcx - scx, dz = tcz - scz;
            const k = MAX_SPAN / Math.max(Math.abs(dx), Math.abs(dz));
            tcx = scx + Math.round(dx * k);
            tcz = scz + Math.round(dz * k);
            const rn = roadNode(tcx, tcz);
            tgx = rn.gx; tgz = rn.gz;
            this.partial = true;
        } else {
            const t = nav.nearestWalkable(tgx, tgz, 6);
            if (!t) { this.finish(false, []); return; }
            tgx = t.gx; tgz = t.gz;
        }

        // 搜索范围：两块围成的矩形 + 1 块边距
        const minCx = Math.min(scx, tcx) - 1, maxCx = Math.max(scx, tcx) + 1;
        const minCz = Math.min(scz, tcz) - 1, maxCz = Math.max(scz, tcz) + 1;
        this.ox = minCx * CHUNK_CELLS; this.oz = minCz * CHUNK_CELLS;
        this.w = (maxCx - minCx + 1) * CHUNK_CELLS; this.h = (maxCz - minCz + 1) * CHUNK_CELLS;
        const n = this.w * this.h;
        this.g = new Float32Array(n);
        this.parent = new Int32Array(n);
        this.state = new Uint8Array(n);

        this.sx = sgx - this.ox; this.sz = sgz - this.oz;
        this.tx = tgx - this.ox; this.tz = tgz - this.oz;
        const si = this.sz * this.w + this.sx;
        this.g[si] = 0;
        this.parent[si] = -1;
        this.state[si] = 1;
        this.open.push(si, this.heuristic(this.sx, this.sz));
    }

    private heuristic(x: number, z: number): number {
        const dx = Math.abs(x - this.tx), dz = Math.abs(z - this.tz);
        return (dx + dz) + (SQRT2 - 2) * Math.min(dx, dz);
    }

    private passable(x: number, z: number): boolean {
        if (x < 0 || z < 0 || x >= this.w || z >= this.h) return false;
        const i = z * this.w + x;
        if (this.state[i] === 3) return false;
        if (this.state[i] !== 0) return true;
        if (!this.nav.walkable(x + this.ox, z + this.oz)) { this.state[i] = 3; return false; }
        return true;
    }

    /** 推进最多 budget 个节点，完成后返回 true */
    step(budget: number): boolean {
        if (this.done) return true;
        if (this.cancelled) { this.done = true; return true; }
        const w = this.w;
        while (budget-- > 0) {
            if (this.open.size === 0) { this.finish(false, []); return true; }
            const cur = this.open.pop();
            if (this.state[cur] === 2) continue;
            this.state[cur] = 2;
            this.expanded++;
            const cx = cur % w, cz = (cur / w) | 0;
            if (cx === this.tx && cz === this.tz) { this.finish(true, this.reconstruct(cur)); return true; }
            const gc = this.g[cur];
            for (const [dx, dz, cost] of DIRS) {
                const nx = cx + dx, nz = cz + dz;
                if (!this.passable(nx, nz)) continue;
                // 斜向移动时两侧都必须可走，避免穿过墙角
                if (dx !== 0 && dz !== 0 && (!this.passable(cx + dx, cz) || !this.passable(cx, cz + dz))) continue;
                const ni = nz * w + nx;
                if (this.state[ni] === 2) continue;
                const ng = gc + cost;
                if (this.state[ni] === 1 && ng >= this.g[ni]) continue;
                this.g[ni] = ng;
                this.parent[ni] = cur;
                this.state[ni] = 1;
                this.open.push(ni, ng + this.heuristic(nx, nz) * 1.001);
            }
        }
        return false;
    }

    private reconstruct(end: number): Vec2[] {
        const cells: Vec2[] = [];
        for (let i = end; i !== -1; i = this.parent[i]) {
            const x = i % this.w, z = (i / this.w) | 0;
            cells.push({ x: (x + this.ox + 0.5) * CELL, z: (z + this.oz + 0.5) * CELL });
        }
        cells.reverse();
        return this.smooth(cells);
    }

    /** 路径平滑（拉直）：从当前点出发，跳到最远的一个能直线到达的点 */
    private smooth(cells: Vec2[]): Vec2[] {
        if (cells.length <= 2) return cells.slice(1);
        const out: Vec2[] = [];
        let anchor: Vec2 = this.startWorld;
        let i = 0;
        while (i < cells.length - 1) {
            let j = cells.length - 1;
            while (j > i + 1 && !this.nav.lineClear(anchor.x, anchor.z, cells[j].x, cells[j].z)) j--;
            out.push(cells[j]);
            anchor = cells[j];
            i = j;
        }
        return out;
    }

    private finish(ok: boolean, points: Vec2[]) {
        this.done = true;
        this.result = { ok, points, partial: this.partial, expanded: this.expanded };
        this.g = null!; this.parent = null!; this.state = null!;
        if (!this.cancelled) this.onDone(this.result);
    }
}

/** 寻路请求队列：每帧在时间预算内推进，避免多个单位同时寻路时卡帧 */
export class PathService {
    private queue: PathRequest[] = [];
    lastFrameMs = 0;
    totalSolved = 0;

    constructor(private nav: NavGrid, private budgetMs = 3) { }

    request(from: Vec2, to: Vec2, onDone: (r: PathResult) => void): PathRequest {
        const req = new PathRequest(this.nav, from, to, r => { this.totalSolved++; onDone(r); });
        if (!req.done) this.queue.push(req);
        return req;
    }

    get pending() { return this.queue.length; }

    update() {
        const t0 = performance.now();
        while (this.queue.length > 0 && performance.now() - t0 < this.budgetMs) {
            const req = this.queue[0];
            if (req.step(400)) this.queue.shift();
        }
        this.lastFrameMs = performance.now() - t0;
    }
}
