/**
 * 固定时步 60Hz 逻辑 + 渲染插值(GDD §13)。
 * 渲染帧由 Pixi ticker 驱动;本模块把真实流逝时间累积成固定步长的 sim tick,
 * 并输出插值系数 alpha,渲染层用它在实体的 prev/cur 位置之间取样。
 */
export const SIM_HZ = 60;
export const SIM_DT = 1 / SIM_HZ;

/** 单帧最多补几步:超出则丢弃剩余时间,防止卡顿后的 spiral of death */
export const MAX_STEPS_PER_FRAME = 5;

export class FixedStepLoop {
  private acc = 0;
  /** 渲染插值系数 [0,1):当前累积时间在一个步长中的进度 */
  alpha = 0;
  /** 已执行的逻辑帧总数 */
  tick = 0;

  constructor(private step: () => void) {}

  /** @param dtMs 上一渲染帧的真实耗时(毫秒,未缩放) */
  advance(dtMs: number): void {
    this.acc += Math.min(dtMs / 1000, MAX_STEPS_PER_FRAME * SIM_DT);
    let steps = 0;
    while (this.acc >= SIM_DT && steps < MAX_STEPS_PER_FRAME) {
      this.step();
      this.tick++;
      this.acc -= SIM_DT;
      steps++;
    }
    this.alpha = Math.min(this.acc / SIM_DT, 1);
  }
}
