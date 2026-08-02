/**
 * 残骸经济数值口径(10 号 issue T2)的表级不变量。
 * 与 data/towers.test.ts / data/enemies.test.ts 同口径:钉的不是流程(那在 sim/upgrade.test.ts
 * 与 sim/world.test.ts 里),而是**这几个数本身的口径** —— 曲线的形状与取整、夹取、
 * 三选一的类别权重方向、跳过返还与第 0 级花费的大小关系,以及"这条曲线与出怪脚本的量级对不对得上"。
 *
 * 后续调平衡时改这几个数是被鼓励的(那正是本表存在的理由,todos/05 的验收口径),
 * 但改坏下面这几条就是改坏了机制:
 *   价钱掉出整数 ⇒ `scrap >= upgradeCost` 会卡在"永远差 0.4 点"上,而 UI 印的还是同一个整数;
 *   曲线不再单调 ⇒ 越升越便宜,分钟级循环的张力当场没了;
 *   总掉落量接不住 12 次的累计花费 ⇒ 这一局无论打得多好都升不到 12 次,而症状只是"卡弹得有点少"。
 * 真正的裁判(一局实测升几次)在 sim/economy.test.ts —— 本文件只负责在**跑那 33000 帧之前**
 * 就把"量级压根对不上"这一类问题拦下来。
 */
import { describe, expect, it } from 'vitest';
import {
  DROP_MAX_ALIVE,
  OFFER_WEIGHT_SUPPORT,
  OFFER_WEIGHT_TOWER,
  UPGRADE_CHOICE_COUNT,
  UPGRADE_COST_BASE,
  UPGRADE_COST_GROWTH,
  upgradeCost,
  UPGRADE_SKIP_REFUND,
} from './economy';
import { ENEMIES } from './enemies';
import { WAVE_SEGMENTS } from './waves';

/** 前 n 次升级的累计花费(n = 0 → 0)。"一局升几次"这条验收换算成残骸总量就是它 */
function cumulative(n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += upgradeCost(i);
  return sum;
}

/**
 * 整局脚本**理论满收**的残骸(每只怪都打死、每颗残骸都捡到的上界)。
 * 流按 rate 的线性积分算((rate0 + rate1)/2 × duration,与 sim/waves.ts 逐帧记账的总量同一个数,
 * 只差每段末尾那点不足一只的余账),事件按 counts 逐型求和。
 * 这里刻意**不 import sim** —— data 是 sim 的上游(铁律),而这笔账三张数据表就算得出来。
 */
function theoreticalScrap(): number {
  let total = 0;
  for (const seg of WAVE_SEGMENTS) {
    for (const s of seg.streams) {
      total += ((s.rate0 + s.rate1) / 2) * seg.duration * ENEMIES[s.kind]!.scrap;
    }
    for (const b of seg.bursts) {
      for (let kind = 0; kind < b.counts.length; kind++) {
        total += b.counts[kind]! * ENEMIES[kind]!.scrap;
      }
    }
  }
  return total;
}

describe('升级曲线', () => {
  it('= round(BASE × GROWTH^级数),第 0 级就是 BASE', () => {
    expect(upgradeCost(0)).toBe(Math.round(UPGRADE_COST_BASE));
    // 逐级对着闭式算一遍:BASE/GROWTH 改了这条照样成立,改坏的是"取整口径"才会红
    for (let n = 0; n < 24; n++) {
      expect(upgradeCost(n)).toBe(Math.round(UPGRADE_COST_BASE * Math.pow(UPGRADE_COST_GROWTH, n)));
    }
  });

  it('恒为正整数:残骸是整点记账的,带小数的价钱会让"钱够了却不弹卡"', () => {
    for (let n = 0; n < 24; n++) {
      const cost = upgradeCost(n);
      expect(Number.isInteger(cost)).toBe(true);
      expect(cost).toBeGreaterThan(0);
    }
  });

  it('严格递增,且相邻两级之比 ≈ GROWTH(取整误差之内)', () => {
    for (let n = 0; n < 24; n++) {
      const cost = upgradeCost(n);
      const next = upgradeCost(n + 1);
      // 单调是机制:越升越便宜的话,"攒残骸"这件事在一局的后半段就不再有张力
      expect(next).toBeGreaterThan(cost);
      // 容差 0.05 是留给**低位取整**的(35 → 44 的比值是 1.257,55 → 68 是 1.236),
      // 高位的比值会一路收敛回 1.25;写死成 toBeCloseTo(1.25) 会在第一级就红
      expect(Math.abs(next / cost - UPGRADE_COST_GROWTH)).toBeLessThan(0.05);
    }
  });

  it('n < 0 / NaN / 小数一律夹回第 0 级(NaN 那一档是关键:价钱一旦成 NaN,整局再也不弹卡)', () => {
    const base = upgradeCost(0);
    expect(upgradeCost(-1)).toBe(base);
    expect(upgradeCost(-100)).toBe(base);
    expect(upgradeCost(Number.NaN)).toBe(base);
    expect(upgradeCost(0.9)).toBe(base);
    // 小数向下取整:等级是整数档,取到档位之间的怪值没有意义(与 towers.clampLevel 同口径)
    expect(upgradeCost(3.7)).toBe(upgradeCost(3));
    // 上界**刻意不夹**:涨到玩家攒不动为止就是"这一局到头了",不是要被兜住的错误
    expect(upgradeCost(40)).toBeGreaterThan(upgradeCost(30));
  });

  it('曲线与出怪脚本的量级对得上:理论满收够得着 12 次升级的累计花费', () => {
    // todos/10 的目标窗口 12–15 次 ⇒ 一局收到的残骸要落进 [Σ12, Σ16)。
    // 这两个数就是 data/economy.ts 头部那笔账里的 1898 / 4835,从函数现算而不是抄字面量
    const need12 = cumulative(12);
    const need16 = cumulative(16);
    expect(need12).toBeLessThan(need16);
    // 必要条件:整局把每只怪都打死、每颗残骸都捡到,也得够得着第 12 次 ——
    // 够不着的话这一局无论打得多好都升不到 12 次,而 sim/economy.test.ts 要跑 33000 帧才发现这件事。
    // 反过来不是必要条件(实战收不满,故理论满收允许高过 Σ16),那一半归实测那条用例
    expect(theoreticalScrap()).toBeGreaterThanOrEqual(need12);
  });
});

describe('三选一与跳过', () => {
  it('三选一是设计口径不是旋钮:恒 3', () => {
    expect(UPGRADE_CHOICE_COUNT).toBe(3);
    expect(Number.isInteger(UPGRADE_CHOICE_COUNT)).toBe(true);
  });

  it('类别权重非负、和为正,且塔类占比更大(build 的主体长在甲板上)', () => {
    expect(OFFER_WEIGHT_TOWER).toBeGreaterThanOrEqual(0);
    expect(OFFER_WEIGHT_SUPPORT).toBeGreaterThanOrEqual(0);
    // 和为 0 的表能通过上面每一条,却让类别轮盘无从掷起(sim/upgrade 那边会回落成塔类)
    expect(OFFER_WEIGHT_TOWER + OFFER_WEIGHT_SUPPORT).toBeGreaterThan(0);
    // GDD §7 的卡池比例里武器塔本就压过支援(45% vs 25%),裁剪成两类之后这条方向不该翻过来
    expect(OFFER_WEIGHT_TOWER).toBeGreaterThan(OFFER_WEIGHT_SUPPORT);
  });

  it('跳过返还是正整数,且小于第 0 级花费 —— 跳过永远净亏,不是一台印残骸的机器', () => {
    expect(Number.isInteger(UPGRADE_SKIP_REFUND)).toBe(true);
    expect(UPGRADE_SKIP_REFUND).toBeGreaterThan(0);
    // 这一条是**绊线**而不是铁律:World.skipUpgrade 里那手 Math.min 兜得住"返还 > 花费",
    // 但真到了那一步,跳过就成了免单(甚至净赚) —— 调 BASE 的人该在这里先被拦一次,
    // 而不是等玩家发现"一直点跳过就能白升级"
    expect(UPGRADE_SKIP_REFUND).toBeLessThan(upgradeCost(0));
  });
});

describe('在场残骸上限', () => {
  it('是正整数保险丝:正常一局够不到,够到了也只是丢弃当帧那一颗', () => {
    expect(Number.isInteger(DROP_MAX_ALIVE)).toBe(true);
    expect(DROP_MAX_ALIVE).toBeGreaterThan(0);
  });
});
