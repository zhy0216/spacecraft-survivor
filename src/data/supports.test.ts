import { describe, expect, it } from 'vitest';
import {
  SUP_AMMO_BAY,
  SUP_ARMOR_BAY,
  SUP_CAPACITOR,
  SUP_MAGNET,
  SUP_RADIATOR,
  SUP_XP_AMP,
  SUPPORT_KIND_COUNT,
  SUPPORT_THR_NONE,
  supportAffects,
  SUPPORTS,
} from './supports';
import { THR_AMMO, THR_CHARGE, THR_HEAT, TOWERS } from './towers';

describe('支援数值表', () => {
  it('六种支援下标、名称与类型稳定', () => {
    expect(SUPPORT_KIND_COUNT).toBe(6);
    expect(SUPPORTS).toHaveLength(SUPPORT_KIND_COUNT);
    SUPPORTS.forEach((def, index) => expect(def.type).toBe(index));
    expect(SUPPORTS.map((def) => def.name)).toEqual([
      '弹药库', '散热器', '电容组', '装甲舱', '经验增幅器', '磁力收集器',
    ]);
  });

  it('六种支援的非中性效果符合新契约', () => {
    expect(SUPPORTS[SUP_AMMO_BAY]).toMatchObject({ fireRateMul: 1.25, reloadMul: 0.7 });
    expect(SUPPORTS[SUP_RADIATOR]?.heatMaxMul).toBe(1.5);
    expect(SUPPORTS[SUP_CAPACITOR]?.chargeRateMul).toBe(1.3);
    expect(SUPPORTS[SUP_ARMOR_BAY]).toMatchObject({ hullHp: 15, damageTakenMul: 0.8 });
    expect(SUPPORTS[SUP_XP_AMP]).toMatchObject({ xpMul: 1.5, throttle: SUPPORT_THR_NONE });
    expect(SUPPORTS[SUP_MAGNET]).toMatchObject({ magnetRadiusMul: 1.3, throttle: SUPPORT_THR_NONE });
  });

  it('supportAffects 只按支援与武器节流系匹配', () => {
    const families: Array<[number, number]> = [
      [SUP_AMMO_BAY, THR_AMMO],
      [SUP_RADIATOR, THR_HEAT],
      [SUP_CAPACITOR, THR_CHARGE],
    ];
    for (const [supportType, throttle] of families) {
      const support = SUPPORTS[supportType]!;
      expect(support.throttle).toBe(throttle);
      for (const tower of TOWERS) {
        expect(supportAffects(support, tower.throttle), `${support.name} × ${tower.name}`)
          .toBe(tower.throttle === throttle);
      }
    }
  });

  it('无节流支援不匹配任何武器系', () => {
    expect(SUPPORT_THR_NONE).toBe(-1);
    for (const type of [SUP_ARMOR_BAY, SUP_XP_AMP, SUP_MAGNET]) {
      const support = SUPPORTS[type]!;
      for (const throttle of [THR_AMMO, THR_HEAT, THR_CHARGE]) {
        expect(supportAffects(support, throttle)).toBe(false);
      }
    }
  });

  it('所有乘法字段为正且未使用字段保持中性值', () => {
    for (const def of SUPPORTS) {
      for (const value of [def.fireRateMul, def.reloadMul, def.heatMaxMul, def.chargeRateMul, def.damageTakenMul, def.xpMul, def.magnetRadiusMul]) {
        expect(value, def.name).toBeGreaterThan(0);
      }
    }
    expect(SUPPORTS.filter((def) => def.hullHp !== 0).map((def) => def.type)).toEqual([SUP_ARMOR_BAY]);
    expect(SUPPORTS.filter((def) => def.damageTakenMul !== 1).map((def) => def.type)).toEqual([SUP_ARMOR_BAY]);
    expect(SUPPORTS.filter((def) => def.xpMul !== 1).map((def) => def.type)).toEqual([SUP_XP_AMP]);
    expect(SUPPORTS.filter((def) => def.magnetRadiusMul !== 1).map((def) => def.type)).toEqual([SUP_MAGNET]);
  });
});
