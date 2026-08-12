import { afterEach, describe, expect, it } from 'vitest';
import { createEdictLevels, EDICTS, EDICT_ARMOR } from '../data/edicts';
import { tuning } from './config';
import { hullDamageTaken, hullMaxHp, shipRadius } from './damage';
import { aggregateEdictBuffs, createEdictBuffs } from './edictBuffs';

const baseHp = tuning.shipHullHp;
afterEach(() => {
  tuning.shipHullHp = baseHp;
});

describe('船体圆与全局伤害模型', () => {
  it('受击圆半径等于船长一半', () => {
    expect(shipRadius(48)).toBe(24);
  });

  it('HP 上限 = 基准 + 装甲协议每层 15(加法档,支援并入法令后只剩这一个来源)', () => {
    tuning.shipHullHp = 100;
    const levels = createEdictLevels();
    expect(EDICTS[EDICT_ARMOR]!.hullHpAdd).toBe(15);
    expect(hullMaxHp(aggregateEdictBuffs(levels, createEdictBuffs()))).toBe(100);
    levels[EDICT_ARMOR] = 2;
    expect(hullMaxHp(aggregateEdictBuffs(levels, createEdictBuffs()))).toBe(130);
    levels[EDICT_ARMOR] = 5;
    expect(hullMaxHp(aggregateEdictBuffs(levels, createEdictBuffs()))).toBe(175);
  });

  it('装甲协议受击倍率按 0.8 逐层连乘', () => {
    const levels = createEdictLevels();
    levels[EDICT_ARMOR] = 2;
    const buffs = aggregateEdictBuffs(levels, createEdictBuffs());
    expect(hullDamageTaken(buffs)).toBeCloseTo(0.64, 12);
  });
});
