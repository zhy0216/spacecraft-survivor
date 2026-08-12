/**
 * 种子随机源(mulberry32)。同一环境下同 seed 序列完全一致(GDD §13 运行种子确定性)。
 * sim 内禁止使用 Math.random —— 所有随机必须经过 World 持有的实例。
 */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  /**
   * 内部游标(mulberry32 的 32 位状态)。**只为存档而开**(sim/runSave.ts):
   * 读档要接着存档那一刻的随机序列往下掷,否则同一局存前存后会走出两条轨迹 ——
   * 而"这一局接着打"正是存档的全部承诺。写入一律 `>>> 0` 归一,与构造函数同口径:
   * 手改过的存档塞进来一个小数/负数,序列会当场变成另一条(mulberry32 只认无符号 32 位)。
   */
  get state(): number {
    return this.s;
  }

  set state(v: number) {
    this.s = v >>> 0;
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
