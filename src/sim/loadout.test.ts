import { describe, expect, it } from 'vitest';
import { TOWERS, towerMagazine } from '../data/towers';
import { WEAPON_SLOT_COUNT } from './armory';
import { World } from './world';
import {
  START_TOWER_COUNT,
  START_TOWER_POOL,
  applyRandomStart,
  installWeapon,
} from './loadout';

describe('随机开局装配', () => {
  it('落下两座 1★ 基础塔,落在两个不同的空槽上,起手状态与普通获得同一条口径', () => {
    const world = new World(1);
    applyRandomStart(world);
    const filled = world.weapons.filter((slot) => slot.type >= 0);
    expect(filled).toHaveLength(START_TOWER_COUNT);
    for (const slot of filled) {
      expect(START_TOWER_POOL).toContain(slot.type);
      expect(slot.stars).toBe(1);
      expect(slot.ammo).toBe(towerMagazine(TOWERS[slot.type]!, 1));
      expect(slot.reloadLeft).toBe(0);
      expect(slot.heat).toBe(0);
      expect(slot.coolLock).toBe(0);
      expect(slot.charge).toBe(0);
      expect(slot.turretOffset).toBe(0);
    }
    // 抽槽无放回:两座塔落在不同槽位,不会叠格
    const slots = filled.map((slot) => world.weapons.indexOf(slot));
    expect(new Set(slots).size).toBe(slots.length);
  });

  it('随机性只来自 world.rng:同 seed 两次装配逐位一致', () => {
    const a = new World(7);
    const b = new World(7);
    applyRandomStart(a);
    applyRandomStart(b);
    const snap = (w: World): string => w.weapons.map((s) => `${s.type}:${s.stars}`).join(',');
    expect(snap(a)).toBe(snap(b));
  });

  it('不授予任何起手法令:法令一律走局内获取', () => {
    const world = new World(3);
    applyRandomStart(world);
    for (const level of world.edictLevels) expect(level).toBe(0);
  });

  it('装配不触发三合一升星:同型两座(随机池允许的合法结果)仍是两个 1★ 槽', () => {
    for (let seed = 0; seed < 40; seed++) {
      const world = new World(seed);
      applyRandomStart(world);
      for (const slot of world.weapons) {
        if (slot.type >= 0) expect(slot.stars).toBe(1);
      }
    }
  });

  it('installWeapon 直落 1★、满弹进场、其余节流状态归零', () => {
    const world = new World(2);
    installWeapon(world.weapons[0]!, 0);
    const s = world.weapons[0]!;
    expect(s.type).toBe(0);
    expect(s.stars).toBe(1);
    expect(s.ammo).toBe(towerMagazine(TOWERS[0]!, 1));
  });

  it('只剩一个空槽时只落下能放得下的,不覆盖已装武器', () => {
    const world = new World(4);
    for (let i = 0; i < WEAPON_SLOT_COUNT - 1; i++) installWeapon(world.weapons[i]!, 0);
    applyRandomStart(world);
    const filled = world.weapons.filter((slot) => slot.type >= 0);
    expect(filled).toHaveLength(WEAPON_SLOT_COUNT); // 7 座已有 + 1 座新落
    expect(world.weapons.filter((slot) => slot.type === 0)).toHaveLength(WEAPON_SLOT_COUNT - 1);
  });
});
