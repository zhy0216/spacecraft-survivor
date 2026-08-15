/**
 * 法令聚合(层数 → 倍率)的口径钉死 —— 取代旧的 sim/support.test.ts。
 * 表本身的不变量在 data/edicts.test.ts;这里只钉**聚合规则**:
 * 乘法档 base^层、加法档 add×层、系限定档只落进自己那一族、全船档不串进族里、
 * 星币概率含基础值且夹在 [0,1]。
 */
import { describe, expect, it } from 'vitest';
import { STARCOIN_DROP_CHANCE } from '../data/economy';
import {
  createEdictLevels,
  EDICT_AMMO,
  EDICT_ARMOR,
  EDICT_BOOST,
  EDICT_CAPACITOR,
  EDICT_COOLANT,
  EDICT_CRUISE,
  EDICT_GYRO,
  EDICT_MAGNET,
  EDICT_MAX_LEVEL,
  EDICT_OVERDRIVE,
  EDICT_STARCHART,
  EDICT_XP,
  EDICTS,
} from '../data/edicts';
import { THR_AMMO, THR_CHARGE, THR_HEAT } from '../data/towers';
import { aggregateEdictBuffs, createEdictBuffs } from './edictBuffs';

/** 一份层数表 → 一份聚合(每次新建 out,免得用例之间互相污染) */
function agg(set: (levels: number[]) => void) {
  const levels = createEdictLevels();
  set(levels);
  return aggregateEdictBuffs(levels, createEdictBuffs());
}

describe('法令聚合', () => {
  it('零法令 = 全中性,星币概率 = 基础值', () => {
    const b = agg(() => {});
    expect(b.fireRateMul).toEqual([1, 1, 1]);
    expect(b.reloadMul).toEqual([1, 1, 1]);
    expect(b.heatMaxMul).toEqual([1, 1, 1]);
    expect(b.chargeRateMul).toEqual([1, 1, 1]);
    expect(b.damageMul).toBe(1);
    expect(b.hullHp).toBe(0);
    expect(b.damageTakenMul).toBe(1);
    expect(b.xpMul).toBe(1);
    expect(b.magnetRadiusMul).toBe(1);
    expect(b.turnRateAdd).toBe(0);
    expect(b.cruiseSpeedMul).toBe(1);
    expect(b.boostCooldownAdd).toBe(0);
    expect(b.starCoinChance).toBeCloseTo(STARCOIN_DROP_CHANCE, 12);
  });

  it('乘法档按层求幂:2 层散热协议 = ×1.25²,5 层 = ×1.25⁵', () => {
    // 散热/增幅已按 5 层复利压档(27 号):1.5 → 1.25,5 层 ×7.6 → ×3.05
    expect(agg((l) => (l[EDICT_COOLANT] = 2)).heatMaxMul[THR_HEAT]).toBeCloseTo(1.25 ** 2, 12);
    expect(agg((l) => (l[EDICT_COOLANT] = EDICT_MAX_LEVEL)).heatMaxMul[THR_HEAT]).toBeCloseTo(1.25 ** 5, 12);
    expect(agg((l) => (l[EDICT_AMMO] = 3)).fireRateMul[THR_AMMO]).toBeCloseTo(1.25 ** 3, 12);
    expect(agg((l) => (l[EDICT_AMMO] = 3)).reloadMul[THR_AMMO]).toBeCloseTo(0.7 ** 3, 12);
    expect(agg((l) => (l[EDICT_CAPACITOR] = 2)).chargeRateMul[THR_CHARGE]).toBeCloseTo(1.3 ** 2, 12);
    expect(agg((l) => (l[EDICT_OVERDRIVE] = 4)).damageMul).toBeCloseTo(1.15 ** 4, 12);
    expect(agg((l) => (l[EDICT_ARMOR] = 3)).damageTakenMul).toBeCloseTo(0.8 ** 3, 12);
    expect(agg((l) => (l[EDICT_XP] = 2)).xpMul).toBeCloseTo(1.25 ** 2, 12); // 增幅协议同样压档(27 号)
    expect(agg((l) => (l[EDICT_MAGNET] = 2)).magnetRadiusMul).toBeCloseTo(1.3 ** 2, 12);
    expect(agg((l) => (l[EDICT_CRUISE] = 2)).cruiseSpeedMul).toBeCloseTo(1.1 ** 2, 12);
  });

  it('加法档按层求和:3 层装甲协议 = +45,3 层重心校准 = +30°/s,3 层增压校准 = -0.9s', () => {
    expect(agg((l) => (l[EDICT_ARMOR] = 3)).hullHp).toBe(45);
    expect(agg((l) => (l[EDICT_GYRO] = 3)).turnRateAdd).toBe(30);
    expect(agg((l) => (l[EDICT_BOOST] = 3)).boostCooldownAdd).toBeCloseTo(-0.9, 12);
    expect(agg((l) => (l[EDICT_BOOST] = EDICT_MAX_LEVEL)).boostCooldownAdd).toBeCloseTo(-1.5, 12);
  });

  it('系限定档只落进自己那一族,另外两族恒中性', () => {
    const b = agg((l) => {
      l[EDICT_AMMO] = 1;
      l[EDICT_COOLANT] = 1;
      l[EDICT_CAPACITOR] = 1;
    });
    // 弹药协议只抬弹药族的射速/装填
    expect(b.fireRateMul[THR_AMMO]).toBeCloseTo(1.25, 12);
    expect(b.fireRateMul[THR_HEAT]).toBe(1);
    expect(b.fireRateMul[THR_CHARGE]).toBe(1);
    // 散热协议只抬过热族的热上限(27 号压档后单层 ×1.25)
    expect(b.heatMaxMul[THR_HEAT]).toBeCloseTo(1.25, 12);
    expect(b.heatMaxMul[THR_AMMO]).toBe(1);
    // 电容协议只抬充能族的充能速度
    expect(b.chargeRateMul[THR_CHARGE]).toBeCloseTo(1.3, 12);
    expect(b.chargeRateMul[THR_AMMO]).toBe(1);
    // 三条系限定法令一个全船档都不碰
    expect(b.hullHp).toBe(0);
    expect(b.damageMul).toBe(1);
    expect(b.xpMul).toBe(1);
  });

  it('全船档不串进任何一族(路由只认 throttle)', () => {
    const b = agg((l) => {
      l[EDICT_ARMOR] = 2;
      l[EDICT_OVERDRIVE] = 1;
      l[EDICT_MAGNET] = 1;
    });
    expect(b.fireRateMul).toEqual([1, 1, 1]);
    expect(b.heatMaxMul).toEqual([1, 1, 1]);
    expect(b.chargeRateMul).toEqual([1, 1, 1]);
    expect(b.reloadMul).toEqual([1, 1, 1]);
    expect(b.hullHp).toBe(30);
  });

  it('星币概率 = 基础 + 星图协议每层加点(重锚后 +2 个点),且夹在 [0,1]', () => {
    const add = EDICTS[EDICT_STARCHART]!.starCoinChanceAdd;
    expect(agg((l) => (l[EDICT_STARCHART] = 1)).starCoinChance).toBeCloseTo(STARCOIN_DROP_CHANCE + add, 12);
    expect(agg((l) => (l[EDICT_STARCHART] = EDICT_MAX_LEVEL)).starCoinChance).toBeCloseTo(
      STARCOIN_DROP_CHANCE + add * EDICT_MAX_LEVEL,
      12,
    );
    // 层数被写坏成超上限:夹取在 edictLevel 那一步做掉,概率不会冲破 1
    const wild = aggregateEdictBuffs(
      createEdictLevels().map((_, i) => (i === EDICT_STARCHART ? 999 : 0)),
      createEdictBuffs(),
    );
    expect(wild.starCoinChance).toBeLessThanOrEqual(1);
    expect(wild.starCoinChance).toBeCloseTo(STARCOIN_DROP_CHANCE + add * EDICT_MAX_LEVEL, 12);
  });

  it('全量重算:同一个 out 反复聚合不累积残值(复位而不是增量)', () => {
    const out = createEdictBuffs();
    const levels = createEdictLevels();
    levels[EDICT_ARMOR] = 2;
    aggregateEdictBuffs(levels, out);
    expect(out.hullHp).toBe(30);
    // 层数回落(正常玩不出来,但读档会整表覆写):聚合必须跟着落回去,不许留着上一次的账
    levels[EDICT_ARMOR] = 0;
    aggregateEdictBuffs(levels, out);
    expect(out.hullHp).toBe(0);
    expect(out.damageTakenMul).toBe(1);
    // 反复聚合同一份层数:结果恒等(幂等),不会一次比一次大
    levels[EDICT_AMMO] = 2;
    const a = aggregateEdictBuffs(levels, out).fireRateMul[THR_AMMO];
    const b = aggregateEdictBuffs(levels, out).fireRateMul[THR_AMMO];
    expect(b).toBe(a);
  });

  it('越界层数表(比表短/比表长)不吐 NaN', () => {
    const short = aggregateEdictBuffs([2], createEdictBuffs());
    const long = aggregateEdictBuffs(new Array<number>(64).fill(1), createEdictBuffs());
    for (const b of [short, long]) {
      expect(Number.isFinite(b.damageMul)).toBe(true);
      expect(Number.isFinite(b.hullHp)).toBe(true);
      expect(Number.isFinite(b.boostCooldownAdd)).toBe(true);
      expect(Number.isFinite(b.starCoinChance)).toBe(true);
      expect(b.fireRateMul.every(Number.isFinite)).toBe(true);
    }
  });
});
