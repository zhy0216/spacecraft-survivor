/**
 * 平衡系统数值口径(平衡系统)的表级不变量。
 * 与 data/towers.test.ts / data/economy.test.ts 同口径:钉的不是流程(那在 sim/balance.test.ts
 * 与 sim/bossGate.test.ts 里),而是**这几个数本身的口径** —— 难度指数的排序契约、
 * 走廊三旋钮的合法区间、闸门常数的闭合窗口。
 *
 * 后续调平衡时改这几个数是被鼓励的(那正是本表存在的理由,与 todos/05 同一条验收口径),
 * 但改坏下面这几条就是改坏了机制:
 *   难度档倒挂(易塔比难塔难)⇒ 走廊锚线整体失序,「操作难度大的拿数值优势」当场失效;
 *   TTK 目标飞出窗口 ⇒ 闸门配装击杀 Boss 的时间失去设计意义(要么白给要么磨穿);
 *   走廊带宽越界 ⇒ 双侧带不再成立,难塔偷懒/易塔超线都抓不住。
 * 真正的裁判(每塔每星级是否落在走廊内)在 sim/balance.test.ts。
 */
import { describe, expect, it } from 'vitest';
import {
  AOE_REF_RADIUS,
  ARC_REF_DEG,
  CHAIN_REF_COUNT,
  CORRIDOR_BAND,
  CORRIDOR_COVERAGE_WEIGHT,
  CORRIDOR_SLOPE,
  DIFF_COMPRESS_EXP,
  difficultyOf,
  FAM_BY_THROTTLE,
  FUSED_ACQ_PREMIUM,
  GATE_EDICT_LEVELS_MIN,
  GATE_STAR_MASS_MIN,
  GATE_SUMMON_OVERWHELM_RATIO,
  GATE_TTK_MAX,
  GATE_TTK_MIN,
  GATE_TTK_RATIO_MIN,
  GATE_TTK_TARGET,
  GATE_WEAPON_ACQ_FLOOR,
  GATE_WEAPONS_MIN,
  PIERCE_REF_COUNT,
  POWER_ENEMY_DENSITY,
  POWER_ENEMY_RADIUS_REF,
  TRAVEL_TIME_REF,
} from './balance';
import {
  TOWERS,
  TOWER_ANNIHILATION,
  TOWER_ARC,
  TOWER_AURORA,
  TOWER_AUTOCANNON,
  TOWER_DELUGE,
  TOWER_LASER,
  TOWER_MISSILE_NEST,
  TOWER_MORTAR,
  TOWER_PD,
  TOWER_RAILGUN,
  TOWER_STORM_CANNON,
  TOWER_THORN,
  TOWER_THUNDER,
} from './towers';

describe('平衡常数(数据层)', () => {
  it('节流系难度底子严格递增:弹药 < 过热 < 充能(机制要求,难度档不许倒挂)', () => {
    expect(FAM_BY_THROTTLE[0]).toBeLessThan(FAM_BY_THROTTLE[1]!);
    expect(FAM_BY_THROTTLE[1]).toBeLessThan(FAM_BY_THROTTLE[2]!);
  });

  it('走廊三旋钮落在合法区间:斜率正、带宽在 (0,1)、合成溢价 ≥ 1', () => {
    expect(CORRIDOR_SLOPE).toBeGreaterThan(0);
    expect(CORRIDOR_BAND).toBeGreaterThan(0);
    expect(CORRIDOR_BAND).toBeLessThan(1);
    expect(FUSED_ACQ_PREMIUM).toBeGreaterThanOrEqual(1);
    expect(CORRIDOR_COVERAGE_WEIGHT).toBeGreaterThan(0);
  });

  it('火力口径常数全为正:密度 / 半径 / 各参考档,0 会把火力指数整个抹成 0', () => {
    expect(POWER_ENEMY_DENSITY).toBeGreaterThan(0);
    expect(POWER_ENEMY_RADIUS_REF).toBeGreaterThan(0);
    expect(TRAVEL_TIME_REF).toBeGreaterThan(0);
    expect(ARC_REF_DEG).toBeGreaterThan(0);
    expect(AOE_REF_RADIUS).toBeGreaterThan(0);
    expect(CHAIN_REF_COUNT).toBeGreaterThan(0);
    expect(PIERCE_REF_COUNT).toBeGreaterThan(0);
    expect(DIFF_COMPRESS_EXP).toBeGreaterThan(0);
    expect(DIFF_COMPRESS_EXP).toBeLessThanOrEqual(1);
  });

  it('闸门常数闭合:TTK 目标落在 [75, 90] 窗口内,质量/武器/法令数与阈值全为正整数', () => {
    expect(GATE_TTK_MIN).toBeLessThanOrEqual(GATE_TTK_TARGET);
    expect(GATE_TTK_TARGET).toBeLessThanOrEqual(GATE_TTK_MAX);
    expect(GATE_TTK_MIN).toBeGreaterThan(0);
    for (const n of [GATE_STAR_MASS_MIN, GATE_WEAPONS_MIN, GATE_EDICT_LEVELS_MIN, GATE_WEAPON_ACQ_FLOOR]) {
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThan(0);
    }
    expect(GATE_TTK_RATIO_MIN).toBeGreaterThan(1);
    expect(GATE_SUMMON_OVERWHELM_RATIO).toBeGreaterThanOrEqual(5);
  });
});

describe('难度指数(闭式)', () => {
  it('对自动机炮归一:难度恒等于 1.0(GDD §14 锁定行为锚点,难度刻度的零点)', () => {
    expect(difficultyOf(TOWERS[TOWER_AUTOCANNON]!)).toBeCloseTo(1.0, 10);
  });

  it('全塔难度是有限正数(数值表被改坏也不许 NaN/0 顺着乘法污染走廊线)', () => {
    for (const def of TOWERS) {
      const d = difficultyOf(def);
      expect(Number.isFinite(d)).toBe(true);
      expect(d).toBeGreaterThan(0);
    }
  });

  it('难塔一侧:极窄弧 + 沉炮管 + 攒放节奏的塔必须显著难过机炮', () => {
    // 磁轨/湮灭(极窄 30°、容差 2°、转速 120、充能)是全场最难的一档
    expect(difficultyOf(TOWERS[TOWER_RAILGUN]!)).toBeGreaterThan(1.2);
    expect(difficultyOf(TOWERS[TOWER_ANNIHILATION]!)).toBeGreaterThan(1.2);
    // 迫击炮/焦土(窄 60°、提前量、攒放)次难
    expect(difficultyOf(TOWERS[TOWER_MORTAR]!)).toBeGreaterThan(1.2);
    expect(difficultyOf(TOWERS[TOWER_DELUGE]!)).toBeGreaterThan(1.2);
    // 激光/极光(窄 60°、热管理)也难过机炮
    expect(difficultyOf(TOWERS[TOWER_LASER]!)).toBeGreaterThan(1.2);
    expect(difficultyOf(TOWERS[TOWER_AURORA]!)).toBeGreaterThan(1.2);
  });

  it('易塔一侧:广弧 + 快转 + 自动容错的塔必须显著易于机炮', () => {
    expect(difficultyOf(TOWERS[TOWER_PD]!)).toBeLessThan(0.6);
    expect(difficultyOf(TOWERS[TOWER_THORN]!)).toBeLessThan(0.6);
    expect(difficultyOf(TOWERS[TOWER_ARC]!)).toBeLessThan(0.6);
    expect(difficultyOf(TOWERS[TOWER_THUNDER]!)).toBeLessThan(0.6);
  });

  it('中档塔落在机炮附近:风暴/导弹巢不进难易两端', () => {
    expect(difficultyOf(TOWERS[TOWER_STORM_CANNON]!)).toBeGreaterThan(0.3);
    expect(difficultyOf(TOWERS[TOWER_STORM_CANNON]!)).toBeLessThan(2);
    expect(difficultyOf(TOWERS[TOWER_MISSILE_NEST]!)).toBeGreaterThan(0.3);
    expect(difficultyOf(TOWERS[TOWER_MISSILE_NEST]!)).toBeLessThan(2);
  });

  it('难度排序契约:磁轨 > 迫击炮 > 激光 > 机炮 > 点防(走廊锚线的单调性根基)', () => {
    const d = (t: number) => difficultyOf(TOWERS[t]!);
    expect(d(TOWER_RAILGUN)).toBeGreaterThan(d(TOWER_MORTAR));
    expect(d(TOWER_MORTAR)).toBeGreaterThan(d(TOWER_LASER));
    expect(d(TOWER_LASER)).toBeGreaterThan(d(TOWER_AUTOCANNON));
    expect(d(TOWER_AUTOCANNON)).toBeGreaterThan(d(TOWER_PD));
  });
});
