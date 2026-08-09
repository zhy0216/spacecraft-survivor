/**
 * 法令数值表的表级不变量(18 号)—— 与 data/supports.test.ts / data/towers.test.ts 同风格:
 * 数据表是"改数据即可调平衡"的那一头,这里钉的是**表本身的结构**:
 * 六条齐全、编号 === 下标、效果字段全数值、掩码工具按位说话。
 * 三选一/世界级的接线在 sim/upgrade.test.ts 与 sim/world.test.ts 钉。
 */
import { describe, expect, it } from 'vitest';
import {
  EDICT_COOLANT,
  EDICT_CRUISE,
  EDICT_GYRO,
  EDICT_HULL,
  EDICT_KIND_COUNT,
  EDICT_MAGNET,
  EDICT_RAPID,
  EDICT_TRACER,
  EDICTS,
  edictAmmoFireRateMul,
  edictCruiseSpeedMul,
  edictHeatMaxMul,
  edictHullHpAdd,
  edictMagnetRadiusMul,
  edictMask,
  edictTurnRateAdd,
  hasEdict,
} from './edicts';

describe('法令表级不变量', () => {
  it('七条齐全,编号与 EDICT_* 常量一一对应、与下标一致', () => {
    expect(EDICT_KIND_COUNT).toBe(7);
    expect(EDICTS).toHaveLength(EDICT_KIND_COUNT);
    const ids = [
      EDICT_TRACER,
      EDICT_GYRO,
      EDICT_MAGNET,
      EDICT_COOLANT,
      EDICT_HULL,
      EDICT_CRUISE,
      EDICT_RAPID,
    ];
    EDICTS.forEach((e, i) => {
      expect(e.type, `下标 ${i} 的 type 必须 === 下标`).toBe(i);
      expect(ids[i], `EDICT_* 常量顺序必须与表顺序一致`).toBe(i);
      expect(e.name.length).toBeGreaterThan(0); // 卡片要印名字,不许空串
    });
    expect(new Set(ids)).toEqual(new Set(EDICTS.map((e) => e.type))); // 无重复编号
  });

  it('七条的效果数值逐条到位(全部数值型,不引入新机制)', () => {
    expect(EDICTS[EDICT_TRACER]!.ammoFireRateMul).toBe(1.1); // 弹药系射速 +10%
    expect(EDICTS[EDICT_GYRO]!.turnRateAdd).toBe(10); // 转向 +10°/s
    expect(EDICTS[EDICT_MAGNET]!.magnetRadiusMul).toBe(1.3); // 拾取半径 +30%
    expect(EDICTS[EDICT_COOLANT]!.heatMaxMul).toBe(1.2); // 过热上限 +20%
    expect(EDICTS[EDICT_HULL]!.hullHpAdd).toBe(20); // 船体 HP +20
    expect(EDICTS[EDICT_CRUISE]!.cruiseSpeedMul).toBe(1.1); // 巡航速度 +10%
    // 19 号进阶法令:曳光协议的更强档,仍是同一个字段的数值
    expect(EDICTS[EDICT_RAPID]!.ammoFireRateMul).toBe(1.25); // 弹药系射速 +25%
    // 除弹药射速外,急速协议其余档全部中性(与其它六条同一套"不用就填中性"口径)
    expect(EDICTS[EDICT_RAPID]!.turnRateAdd).toBe(0);
    expect(EDICTS[EDICT_RAPID]!.magnetRadiusMul).toBe(1);
    expect(EDICTS[EDICT_RAPID]!.heatMaxMul).toBe(1);
    expect(EDICTS[EDICT_RAPID]!.hullHpAdd).toBe(0);
    expect(EDICTS[EDICT_RAPID]!.cruiseSpeedMul).toBe(1);
  });

  it('不用的乘法档填 1、加法档填 0(与 towers.ts 的中性值分工同源)', () => {
    for (const e of EDICTS) {
      expect(e.ammoFireRateMul).toBeGreaterThanOrEqual(1);
      expect(e.magnetRadiusMul).toBeGreaterThanOrEqual(1);
      expect(e.heatMaxMul).toBeGreaterThanOrEqual(1);
      expect(e.cruiseSpeedMul).toBeGreaterThanOrEqual(1);
      expect(e.turnRateAdd).toBeGreaterThanOrEqual(0);
      expect(e.hullHpAdd).toBeGreaterThanOrEqual(0);
    }
  });

  it('掩码工具按位说话:edictMask/hasEdict/聚合函数与表逐条对得上', () => {
    // 单条持有:聚合恒等于该条的字段值
    for (let i = 0; i < EDICT_KIND_COUNT; i++) {
      const mask = edictMask(i);
      expect(mask).toBe(1 << i);
      for (let j = 0; j < EDICT_KIND_COUNT; j++) {
        expect(hasEdict(mask, j)).toBe(i === j);
      }
      const e = EDICTS[i]!;
      expect(edictAmmoFireRateMul(mask)).toBe(e.ammoFireRateMul);
      expect(edictTurnRateAdd(mask)).toBe(e.turnRateAdd);
      expect(edictMagnetRadiusMul(mask)).toBe(e.magnetRadiusMul);
      expect(edictHeatMaxMul(mask)).toBe(e.heatMaxMul);
      expect(edictHullHpAdd(mask)).toBe(e.hullHpAdd);
      expect(edictCruiseSpeedMul(mask)).toBe(e.cruiseSpeedMul);
    }

    // 全持有:加法求和、乘法连乘(每条的数值都 > 中性值,故全持有时必然大于单条)
    const all = (1 << EDICT_KIND_COUNT) - 1;
    const sumAdd = (k: 'turnRateAdd' | 'hullHpAdd'): number =>
      EDICTS.reduce((acc, e) => acc + e[k], 0);
    const prodMul = (k: 'ammoFireRateMul' | 'magnetRadiusMul' | 'heatMaxMul' | 'cruiseSpeedMul'): number =>
      EDICTS.reduce((acc, e) => acc * e[k], 1);
    expect(edictTurnRateAdd(all)).toBe(sumAdd('turnRateAdd'));
    expect(edictHullHpAdd(all)).toBe(sumAdd('hullHpAdd'));
    expect(edictAmmoFireRateMul(all)).toBeCloseTo(prodMul('ammoFireRateMul'), 12);
    expect(edictMagnetRadiusMul(all)).toBeCloseTo(prodMul('magnetRadiusMul'), 12);
    expect(edictHeatMaxMul(all)).toBeCloseTo(prodMul('heatMaxMul'), 12);
    expect(edictCruiseSpeedMul(all)).toBeCloseTo(prodMul('cruiseSpeedMul'), 12);

    // 空掩码 = 全中性:未持有任何法令时,六个现读点都按恒等读数走
    expect(edictAmmoFireRateMul(0)).toBe(1);
    expect(edictTurnRateAdd(0)).toBe(0);
    expect(edictMagnetRadiusMul(0)).toBe(1);
    expect(edictHeatMaxMul(0)).toBe(1);
    expect(edictHullHpAdd(0)).toBe(0);
    expect(edictCruiseSpeedMul(0)).toBe(1);
  });

  it('聚合函数不越界:任意掩码位(含越界位)都不会把读数变成 NaN', () => {
    const wild = 0xffff;
    expect(Number.isFinite(edictAmmoFireRateMul(wild))).toBe(true);
    expect(Number.isFinite(edictTurnRateAdd(wild))).toBe(true);
    expect(Number.isFinite(edictMagnetRadiusMul(wild))).toBe(true);
    expect(Number.isFinite(edictHeatMaxMul(wild))).toBe(true);
    expect(Number.isFinite(edictHullHpAdd(wild))).toBe(true);
    expect(Number.isFinite(edictCruiseSpeedMul(wild))).toBe(true);
  });
});
