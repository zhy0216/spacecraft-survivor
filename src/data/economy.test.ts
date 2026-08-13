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
 * 真正的裁判(一局实测升几次)在 sim/economy.test.ts —— 本文件只负责在**跑那 28800 帧之前**
 * 就把"量级压根对不上"这一类问题拦下来。
 */
import { describe, expect, it } from 'vitest';
import {
  DOCK_EDICT_COUNT,
  DOCK_EDICT_PRICE,
  DOCK_REPAIR_FRACTION,
  DOCK_REPAIR_PRICE,
  DOCK_SHOP_REFRESH_PRICE,
  DOCK_WEAPON_COUNT,
  DOCK_WEAPON_PRICE,
  DROP_MAX_ALIVE,
  OFFER_WEIGHT_EDICT,
  OFFER_WEIGHT_NEW_WEAPON,
  REFIT_HEAL_FRACTION,
  REROLL_PRICE,
  skipRefundFor,
  UPGRADE_CHOICE_COUNT,
  UPGRADE_COST_BASE,
  UPGRADE_COST_GROWTH,
  UPGRADE_EARLY_COSTS,
  upgradeCost,
  UPGRADE_SKIP_FEE,
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
  it('前几档走特价表,之后 = round(BASE × GROWTH^级数)', () => {
    // 特价表(畅玩性调整):首卡要能在教学段前半分钟内见到,故前几档明码低于曲线
    for (let n = 0; n < UPGRADE_EARLY_COSTS.length; n++) {
      expect(upgradeCost(n)).toBe(UPGRADE_EARLY_COSTS[n]);
      // 特价必须真的比曲线便宜:高过曲线的"特价"是在骗人
      expect(upgradeCost(n)).toBeLessThan(
        Math.round(UPGRADE_COST_BASE * Math.pow(UPGRADE_COST_GROWTH, n)),
      );
    }
    // 特价档之外逐级对着闭式算一遍:BASE/GROWTH 改了这条照样成立,改坏的是"取整口径"才会红
    for (let n = UPGRADE_EARLY_COSTS.length; n < 24; n++) {
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

  it('严格递增,特价档之外相邻两级之比 ≈ GROWTH(取整误差之内)', () => {
    for (let n = 0; n < 24; n++) {
      const cost = upgradeCost(n);
      const next = upgradeCost(n + 1);
      // 单调是机制:越升越便宜的话,"攒残骸"这件事在一局的后半段就不再有张力。
      // 特价档也在这条里 —— 特价只许便宜,不许把曲线折成非单调
      expect(next).toBeGreaterThan(cost);
      // 比值检查从特价档之后起:特价段的爬坡比(15→25→40)本就比 GROWTH 陡,
      // 那是"前期便宜、快速跟上"的形状,不是取整误差。
      // 容差 0.05 是留给**低位取整**的,高位的比值会一路收敛回 1.25
      if (n < UPGRADE_EARLY_COSTS.length) continue;
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
    // 够不着的话这一局无论打得多好都升不到 12 次,而 sim/economy.test.ts 要跑 28800 帧才发现这件事。
    // 反过来不是必要条件(实战收不满,故理论满收允许高过 Σ16),那一半归实测那条用例
    expect(theoreticalScrap()).toBeGreaterThanOrEqual(need12);
  });
});

describe('三选一与跳过', () => {
  it('三选一是设计口径不是旋钮:恒 3', () => {
    expect(UPGRADE_CHOICE_COUNT).toBe(3);
    expect(Number.isInteger(UPGRADE_CHOICE_COUNT)).toBe(true);
  });

  it('两类权重固定为 40/60,总和为 100(星级系统:武器升级整类取消)', () => {
    const weights = [OFFER_WEIGHT_NEW_WEAPON, OFFER_WEIGHT_EDICT];
    expect(weights).toEqual([40, 60]);
    expect(weights.reduce((sum, weight) => sum + weight, 0)).toBe(100);
  });

  it('跳过手续费是正整数,返还 = cost − 手续费夹在 [0, cost] —— 跳过永远净亏,不是印残骸的机器', () => {
    expect(Number.isInteger(UPGRADE_SKIP_FEE)).toBe(true);
    expect(UPGRADE_SKIP_FEE).toBeGreaterThan(0);
    for (let n = 0; n < 24; n++) {
      const cost = upgradeCost(n);
      const refund = skipRefundFor(cost);
      expect(Number.isInteger(refund)).toBe(true);
      // 净亏恒为 min(手续费, cost):后期跳过不再是随曲线暴涨的断崖(旧口径第 12 档净亏 494),
      // 但也绝不免单 —— 免单的话"三选一"会退化成无限白嫖重随
      expect(refund).toBeGreaterThanOrEqual(0);
      expect(refund).toBeLessThan(cost);
      expect(cost - refund).toBe(Math.min(UPGRADE_SKIP_FEE, cost));
    }
    // 坏输入不印钱:0/负数费用最多返 0
    expect(skipRefundFor(0)).toBe(0);
    expect(skipRefundFor(-10)).toBe(0);
    expect(skipRefundFor(Number.NaN)).toBe(0);
  });

  it('重摇价(16 号)是正整数星币:单次固定面额、不随曲线浮动,与跳过各管各的账', () => {
    expect(Number.isInteger(REROLL_PRICE)).toBe(true);
    expect(REROLL_PRICE).toBeGreaterThan(0);
    // 与跳过互不抵扣:跳过退残骸(UPGRADE_SKIP_FEE)、重摇花星币 —— 两条出口不该撞成一个数,
    // 否则玩家在 UI 上分不清这次点击花的是哪种钱
    expect(REROLL_PRICE).not.toBe(UPGRADE_SKIP_FEE);
  });
});

describe('船坞商店(21 号)', () => {
  it('武器货架固定 2 把、单价 30、刷新价 10', () => {
    expect(DOCK_WEAPON_COUNT).toBe(2);
    expect(DOCK_WEAPON_PRICE).toBe(30);
    expect(DOCK_SHOP_REFRESH_PRICE).toBe(10);
  });
  it('法令货架张数是小正整数:2 张配 300–430px 的侧栏不挤,货架摆得下也读得完', () => {
    expect(Number.isInteger(DOCK_EDICT_COUNT)).toBe(true);
    expect(DOCK_EDICT_COUNT).toBeGreaterThan(0);
    expect(DOCK_EDICT_COUNT).toBeLessThanOrEqual(3);
  });

  it('法令卡是正整数星币,且贵于一次重摇(10):它是攒出来的大项,不是顺手的小费', () => {
    expect(Number.isInteger(DOCK_EDICT_PRICE)).toBe(true);
    expect(DOCK_EDICT_PRICE).toBeGreaterThan(REROLL_PRICE);
  });

  it('付费修复与法令同价(25):两者都是整备期"一个决定"的档位,不该有便宜的次等选项', () => {
    expect(Number.isInteger(DOCK_REPAIR_PRICE)).toBe(true);
    expect(DOCK_REPAIR_PRICE).toBeGreaterThan(0);
    expect(DOCK_REPAIR_PRICE).toBe(DOCK_EDICT_PRICE);
  });

  it('付费修复比例在 (0,1) 且严格强于免费回血(30%):花了钱不能比白送的弱', () => {
    expect(DOCK_REPAIR_FRACTION).toBeGreaterThan(0);
    expect(DOCK_REPAIR_FRACTION).toBeLessThan(1);
    expect(DOCK_REPAIR_FRACTION).toBeGreaterThan(REFIT_HEAL_FRACTION);
  });
});

describe('在场残骸上限', () => {
  it('是正整数保险丝:正常一局够不到,够到了也只是丢弃当帧那一颗', () => {
    expect(Number.isInteger(DROP_MAX_ALIVE)).toBe(true);
    expect(DROP_MAX_ALIVE).toBeGreaterThan(0);
  });
});
