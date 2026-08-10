import { describe, expect, it } from 'vitest';
import { isMergeResult } from './merges';
import {
  LOADOUT_ARC,
  LOADOUT_BOMBARD,
  LOADOUT_COUNT,
  LOADOUT_SNIPER,
  LOADOUT_STANDARD,
  LOADOUTS,
} from './loadout';
import { SUPPORT_KIND_COUNT } from './supports';
import { TOWER_AUTOCANNON, TOWER_KIND_COUNT } from './towers';
import { SUPPORT_SLOT_COUNT, WEAPON_SLOT_COUNT } from '../sim/armory';

describe('起手配置表', () => {
  it('四条配置及稳定下标保持不变', () => {
    expect(LOADOUT_COUNT).toBe(4);
    expect(LOADOUTS).toHaveLength(LOADOUT_COUNT);
    expect([LOADOUT_STANDARD, LOADOUT_ARC, LOADOUT_BOMBARD, LOADOUT_SNIPER]).toEqual([0, 1, 2, 3]);
    expect(LOADOUTS.map((loadout) => loadout.id)).toEqual(['standard', 'arc', 'bombard', 'sniper']);
    expect(new Set(LOADOUTS.map((loadout) => loadout.id)).size).toBe(LOADOUT_COUNT);
  });

  it('标准起手为双自动机炮加弹药库', () => {
    const standard = LOADOUTS[LOADOUT_STANDARD]!;
    expect(standard.weapons).toEqual([TOWER_AUTOCANNON, TOWER_AUTOCANNON]);
    expect(standard.supports).toEqual([0]);
  });

  it('所有配置可装入四个武器槽和四个支援槽', () => {
    expect(WEAPON_SLOT_COUNT).toBe(4);
    expect(SUPPORT_SLOT_COUNT).toBe(4);
    for (const loadout of LOADOUTS) {
      expect(loadout.name.length).toBeGreaterThan(0);
      expect(loadout.desc.length).toBeGreaterThan(0);
      expect(loadout.weapons.length).toBeGreaterThan(0);
      expect(loadout.weapons.length).toBeLessThanOrEqual(WEAPON_SLOT_COUNT);
      expect(loadout.supports.length).toBeLessThanOrEqual(SUPPORT_SLOT_COUNT);
    }
  });

  it('起手配置只含合法基础武器与合法支援', () => {
    for (const loadout of LOADOUTS) {
      for (const type of loadout.weapons) {
        expect(type).toBeGreaterThanOrEqual(0);
        expect(type).toBeLessThan(TOWER_KIND_COUNT);
        expect(isMergeResult(type)).toBe(false);
      }
      for (const type of loadout.supports) {
        expect(type).toBeGreaterThanOrEqual(0);
        expect(type).toBeLessThan(SUPPORT_KIND_COUNT);
      }
    }
  });
});
