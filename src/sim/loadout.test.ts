import { describe, expect, it } from 'vitest';
import { EDICT_AMMO, EDICT_CAPACITOR, EDICT_COOLANT, edictLevel } from '../data/edicts';
import {
  LOADOUT_ARC,
  LOADOUT_BOMBARD,
  LOADOUT_SNIPER,
  LOADOUT_STANDARD,
  LOADOUTS,
} from '../data/loadout';
import { TOWERS, towerMagazine } from '../data/towers';
import { World } from './world';
import { applyStartingLoadout } from './loadout';

describe('起始装配落入固定槽位', () => {
  it('标准配置填入武器槽并逐层授予法令,不触发合成', () => {
    const world = new World(1);
    applyStartingLoadout(world, 0);
    const loadout = LOADOUTS[0]!;
    expect(world.weapons.filter((slot) => slot.type >= 0).map((slot) => slot.type)).toEqual(loadout.weapons);
    // 起手法令按"每项一层"落地:配置里同号出现几次,层数就是几
    for (const type of new Set(loadout.edicts)) {
      const want = loadout.edicts.filter((t) => t === type).length;
      expect(edictLevel(world.edictLevels, type)).toBe(want);
    }
    for (const [i, type] of loadout.weapons.entries()) {
      const slot = world.weapons[i]!;
      expect(slot.level).toBe(1);
      expect(slot.ammo).toBe(towerMagazine(TOWERS[type]!, 1));
    }
  });

  it('起手法令按同系配对表落地:标准=弹药,弧光=散热,炮击/狙击=电容,各一层', () => {
    const pairs: Array<[number, number]> = [
      [LOADOUT_STANDARD, EDICT_AMMO],
      [LOADOUT_ARC, EDICT_COOLANT],
      [LOADOUT_BOMBARD, EDICT_CAPACITOR],
      [LOADOUT_SNIPER, EDICT_CAPACITOR],
    ];
    for (const [index, type] of pairs) {
      const world = new World(1);
      applyStartingLoadout(world, index);
      expect(edictLevel(world.edictLevels, type)).toBe(1);
    }
  });

  it('同一个世界只能由空槽接收装配,越界配置不破坏现有槽位', () => {
    const world = new World(2);
    applyStartingLoadout(world, 0);
    const before = world.weapons.map((slot) => slot.type);
    applyStartingLoadout(world, 99);
    expect(world.weapons.map((slot) => slot.type)).toEqual(before);
  });
});
