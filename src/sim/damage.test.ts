import { afterEach, describe, expect, it } from 'vitest';
import { EDICTS, EDICT_HULL } from '../data/edicts';
import { SUP_ARMOR_BAY, SUPPORTS } from '../data/supports';
import { createSupportSlots } from './armory';
import { tuning } from './config';
import { hullDamageTaken, hullMaxHp, shipRadius } from './damage';
import { aggregateSupportBuffs, createSupportBuffs } from './support';

const baseHp = tuning.shipHullHp;
afterEach(() => {
  tuning.shipHullHp = baseHp;
});

describe('船体圆与全局伤害模型', () => {
  it('受击圆半径等于船长一半', () => {
    expect(shipRadius(48)).toBe(24);
  });

  it('HP 上限 = 基准 + 装甲舱加值 + 法令加值', () => {
    tuning.shipHullHp = 100;
    const supports = createSupportSlots();
    supports[0]!.type = SUP_ARMOR_BAY;
    supports[1]!.type = SUP_ARMOR_BAY;
    const buffs = aggregateSupportBuffs(supports, createSupportBuffs());
    expect(SUPPORTS[SUP_ARMOR_BAY]!.hullHp).toBe(15);
    expect(hullMaxHp(buffs)).toBe(130);
    expect(hullMaxHp(buffs, EDICTS[EDICT_HULL]!.hullHpAdd)).toBe(150);
  });

  it('装甲舱受击倍率按 0.8 连乘', () => {
    const supports = createSupportSlots();
    supports[0]!.type = SUP_ARMOR_BAY;
    supports[1]!.type = SUP_ARMOR_BAY;
    const buffs = aggregateSupportBuffs(supports, createSupportBuffs());
    expect(hullDamageTaken(buffs)).toBeCloseTo(0.64, 12);
  });
});
