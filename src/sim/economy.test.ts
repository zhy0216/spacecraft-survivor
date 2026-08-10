import { describe, expect, it } from 'vitest';
import { OFFER_WEIGHT_EDICT, OFFER_WEIGHT_NEW_WEAPON, OFFER_WEIGHT_SUPPORT, OFFER_WEIGHT_WEAPON_UPGRADE, upgradeCost, skipRefundFor } from '../data/economy';
import { applyStartingLoadout } from './loadout';
import { World } from './world';

describe('槽位制经济参数', () => {
  it('升级费用递增且跳过退款扣除固定手续费', () => {
    expect(upgradeCost(0)).toBeGreaterThan(0);
    expect(upgradeCost(2)).toBeGreaterThan(upgradeCost(1));
    expect(skipRefundFor(upgradeCost(2))).toBeLessThan(upgradeCost(2));
  });

  it('候选四类权重总和为 100', () => {
    expect(OFFER_WEIGHT_NEW_WEAPON + OFFER_WEIGHT_WEAPON_UPGRADE + OFFER_WEIGHT_SUPPORT + OFFER_WEIGHT_EDICT).toBe(100);
  });

  it('起始装配与商店都读取固定武器槽而非甲板边界', () => {
    const world = new World(1);
    applyStartingLoadout(world);
    expect(world.weapons.some((slot) => slot.type >= 0)).toBe(true);
    expect(world.weapons).toHaveLength(4);
  });
});
