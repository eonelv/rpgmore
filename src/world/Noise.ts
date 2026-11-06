/** 确定性哈希：同样的输入永远得到同样的 [0,1) 值，保证世界可重复生成 */
export function hash2(x: number, z: number, seed: number): number {
    let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(z | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b9);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

function fade(t: number): number {
    return t * t * (3 - 2 * t);
}

/** 值噪声，返回 [0,1) */
export function valueNoise(x: number, z: number, seed: number): number {
    const x0 = Math.floor(x), z0 = Math.floor(z);
    const fx = fade(x - x0), fz = fade(z - z0);
    const a = hash2(x0, z0, seed);
    const b = hash2(x0 + 1, z0, seed);
    const c = hash2(x0, z0 + 1, seed);
    const d = hash2(x0 + 1, z0 + 1, seed);
    return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

/** 分形噪声（多层叠加），返回 [0,1) */
export function fbm(x: number, z: number, octaves: number, seed: number): number {
    let sum = 0, amp = 0.5, freq = 1, norm = 0;
    for (let i = 0; i < octaves; i++) {
        sum += amp * valueNoise(x * freq, z * freq, seed + i * 1013);
        norm += amp;
        amp *= 0.5;
        freq *= 2;
    }
    return sum / norm;
}

/** 山脊噪声（每层取 1-|2v-1| 再平方，形成尖锐的山脊线），返回 [0,1] */
export function ridgedFbm(x: number, z: number, octaves: number, seed: number): number {
    let sum = 0, amp = 0.5, freq = 1, norm = 0, weight = 1;
    for (let i = 0; i < octaves; i++) {
        let r = 1 - Math.abs(valueNoise(x * freq, z * freq, seed + i * 1013) * 2 - 1);
        r *= r;
        // 低处的细节减弱，山谷更平滑、山脊更突出
        r *= weight;
        weight = Math.min(1, r * 2);
        sum += amp * r;
        norm += amp;
        amp *= 0.5;
        freq *= 2;
    }
    return sum / norm;
}
