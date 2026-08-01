/**
 * 种子随机源(mulberry32)。同一环境下同 seed 序列完全一致(GDD §13 运行种子确定性)。
 * sim 内禁止使用 Math.random —— 所有随机必须经过 World 持有的实例。
 */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  /** [0, 1) */
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(minIncl: number, maxExcl: number): number {
    return Math.floor(this.range(minIncl, maxExcl));
  }

  /** [0, 2π) */
  angle(): number {
    return this.next() * Math.PI * 2;
  }
}
