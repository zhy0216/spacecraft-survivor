/**
 * 固定时步 60Hz 逻辑 + 渲染插值(GDD §13)。
 * 渲染帧由 Pixi ticker 驱动;本模块把真实流逝时间累积成固定步长的 sim tick,
 * 并输出插值系数 alpha,渲染层用它在实体的 prev/cur 位置之间取样。
 *
 * halt() 是"时停"的唯一正确停法(10 号 issue T3):世界里那些要求当场停下的事
 * (三选一弹卡、局终结算)都是在 step 回调里说出来的,而那一刻循环还站在 while 里 ——
 * 只把外层的 run.paused 立起来,挡住的是**下一次** advance,本次 advance 照样会把
 * 剩余的固定步补完(掉帧那一帧最多还有 4 步 ≈ 66ms:敌人多走 66ms、伤害多结算 4 次,
 * 玩家看到的那一帧与卡片弹出时的世界对不上)。
 */
export const SIM_HZ = 60;
export const SIM_DT = 1 / SIM_HZ;

/** 单帧最多补几步:超出则丢弃剩余时间,防止卡顿后的 spiral of death */
export const MAX_STEPS_PER_FRAME = 5;

export class FixedStepLoop {
  private acc = 0;
  /** halt() 立的旗。只在**本次** advance 内有效(进门先清零),故没有配套的 resume():
   *  恢复战斗那一侧把 advance 重新调起来就行,不必记得再解一次锁 */
  private halted = false;
  /** 渲染插值系数 [0,1):当前累积时间在一个步长中的进度 */
  alpha = 0;
  /** 已执行的逻辑帧总数 */
  tick = 0;

  constructor(private step: () => void) {}

  /** @param dtMs 上一渲染帧的真实耗时(毫秒,未缩放) */
  advance(dtMs: number): void {
    this.halted = false;
    this.acc += Math.min(dtMs / 1000, MAX_STEPS_PER_FRAME * SIM_DT);
    let steps = 0;
    while (!this.halted && this.acc >= SIM_DT && steps < MAX_STEPS_PER_FRAME) {
      this.step();
      this.tick++;
      this.acc -= SIM_DT;
      steps++;
    }
    if (this.halted) {
      // 剩余累积时间**作废**,不留给下一次 advance:留着的话恢复战斗的第一帧会一口气把
      // 时停期间"欠"的步补跑回来(最多 4 步),时停就白停了 —— 冻结期间的世界必须一动不动。
      // alpha 一并归零:这一帧已经没有"下一步"可插值,再报个中间进度就是在骗渲染层
      this.acc = 0;
      this.alpha = 0;
      return;
    }
    this.alpha = Math.min(this.acc / SIM_DT, 1);
  }

  /**
   * 在 step 回调里调用:本次 advance 的 while 当场停手(当前这一步已经跑完,不再补下一步),
   * 并丢弃剩余累积时间。调用方随后自行决定何时不再调 advance(时停 / 结算)。
   * 在 advance 之外调用是空操作 —— 下一次 advance 进门就把旗清了,它停的是"这一次补步"。
   */
  halt(): void {
    this.halted = true;
  }
}
