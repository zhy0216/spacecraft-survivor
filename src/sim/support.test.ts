import { describe, expect, it } from 'vitest';
import {
  SUP_AMMO_BAY,
  SUP_ARMOR_BAY,
  SUP_CAPACITOR,
  SUP_MAGNET,
  SUP_RADIATOR,
  SUP_XP_AMP,
  SUPPORTS,
  supportAffects,
} from '../data/supports';
import { THR_AMMO, THR_CHARGE, THR_HEAT } from '../data/towers';
import { createSupportSlots } from './armory';
import { aggregateSupportBuffs, createSupportBuffs } from './support';

describe('支援槽全船聚合', () => {
  it('空槽产生全部中性倍率', () => {
    expect(aggregateSupportBuffs(createSupportSlots(), createSupportBuffs())).toEqual(
      createSupportBuffs(),
    );
  });

  it('三种节流支援只写入各自的节流族', () => {
    const slots = createSupportSlots();
    slots[0]!.type = SUP_AMMO_BAY;
    slots[1]!.type = SUP_RADIATOR;
    slots[2]!.type = SUP_CAPACITOR;
    const buffs = aggregateSupportBuffs(slots, createSupportBuffs());
    expect(buffs.fireRateMul[THR_AMMO]).toBe(SUPPORTS[SUP_AMMO_BAY]!.fireRateMul);
    expect(buffs.reloadMul[THR_AMMO]).toBe(SUPPORTS[SUP_AMMO_BAY]!.reloadMul);
    expect(buffs.heatMaxMul[THR_HEAT]).toBe(SUPPORTS[SUP_RADIATOR]!.heatMaxMul);
    expect(buffs.chargeRateMul[THR_CHARGE]).toBe(SUPPORTS[SUP_CAPACITOR]!.chargeRateMul);
  });

  it('装甲、经验与磁力支援写入全局档,重复持有按定义叠加', () => {
    const slots = createSupportSlots();
    slots[0]!.type = SUP_ARMOR_BAY;
    slots[1]!.type = SUP_ARMOR_BAY;
    slots[2]!.type = SUP_XP_AMP;
    slots[3]!.type = SUP_MAGNET;
    const buffs = aggregateSupportBuffs(slots, createSupportBuffs());
    expect(buffs.hullHp).toBe(30);
    expect(buffs.damageTakenMul).toBeCloseTo(0.64, 12);
    expect(buffs.xpMul).toBe(SUPPORTS[SUP_XP_AMP]!.xpMul);
    expect(buffs.magnetRadiusMul).toBe(SUPPORTS[SUP_MAGNET]!.magnetRadiusMul);
  });

  it('supportAffects 只匹配同一节流族,全局支援不匹配塔', () => {
    expect(supportAffects(SUPPORTS[SUP_AMMO_BAY]!, THR_AMMO)).toBe(true);
    expect(supportAffects(SUPPORTS[SUP_AMMO_BAY]!, THR_HEAT)).toBe(false);
    expect(supportAffects(SUPPORTS[SUP_ARMOR_BAY]!, THR_AMMO)).toBe(false);
  });
});
