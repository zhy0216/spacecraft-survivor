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
import { EDICT_AMMO, EDICT_KIND_COUNT, EDICT_MAX_LEVEL } from './edicts';
import { TOWER_AUTOCANNON, TOWER_KIND_COUNT } from './towers';
import { WEAPON_SLOT_COUNT } from '../sim/armory';

describe('起手配置表', () => {
  it('四条配置及稳定下标保持不变', () => {
    expect(LOADOUT_COUNT).toBe(4);
    expect(LOADOUTS).toHaveLength(LOADOUT_COUNT);
    expect([LOADOUT_STANDARD, LOADOUT_ARC, LOADOUT_BOMBARD, LOADOUT_SNIPER]).toEqual([0, 1, 2, 3]);
    expect(LOADOUTS.map((loadout) => loadout.id)).toEqual(['standard', 'arc', 'bombard', 'sniper']);
    expect(new Set(LOADOUTS.map((loadout) => loadout.id)).size).toBe(LOADOUT_COUNT);
  });

  it('标准起手为双自动机炮加一层弹药协议', () => {
    const standard = LOADOUTS[LOADOUT_STANDARD]!;
    expect(standard.weapons).toEqual([TOWER_AUTOCANNON, TOWER_AUTOCANNON]);
    expect(standard.edicts).toEqual([EDICT_AMMO]);
  });

  it('所有配置装得进武器槽,且同一号法令不超过叠层上限', () => {
    expect(WEAPON_SLOT_COUNT).toBe(8);
    for (const loadout of LOADOUTS) {
      expect(loadout.name.length).toBeGreaterThan(0);
      expect(loadout.desc.length).toBeGreaterThan(0);
      expect(loadout.weapons.length).toBeGreaterThan(0);
      expect(loadout.weapons.length).toBeLessThanOrEqual(WEAPON_SLOT_COUNT);
      // 起手法令按"每项一层"计:同号写几次就是几层,不许超过 EDICT_MAX_LEVEL
      const byType = new Map<number, number>();
      for (const t of loadout.edicts) byType.set(t, (byType.get(t) ?? 0) + 1);
      for (const [t, n] of byType) {
        expect(n, `配置 ${loadout.id} 的法令 ${t} 叠了 ${n} 层`).toBeLessThanOrEqual(EDICT_MAX_LEVEL);
      }
    }
  });

  it('起手配置只含合法基础武器与合法法令', () => {
    for (const loadout of LOADOUTS) {
      for (const type of loadout.weapons) {
        expect(type).toBeGreaterThanOrEqual(0);
        expect(type).toBeLessThan(TOWER_KIND_COUNT);
        expect(isMergeResult(type)).toBe(false);
      }
      for (const type of loadout.edicts) {
        expect(type).toBeGreaterThanOrEqual(0);
        expect(type).toBeLessThan(EDICT_KIND_COUNT);
      }
    }
  });
});
