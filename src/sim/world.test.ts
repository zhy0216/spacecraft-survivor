import { describe, expect, it } from 'vitest';
import { SUP_ARMOR_BAY } from '../data/supports';
import { TOWER_AUTOCANNON, TOWER_LASER, TOWER_MAX_LEVEL } from '../data/towers';
import { World } from './world';

describe('World 槽位制核心接线', () => {
  it('同 seed replay 包含武器槽与支援槽状态', () => {
    const a = new World(10);
    const b = new World(10);
    a.acquireWeapon(TOWER_AUTOCANNON);
    b.acquireWeapon(TOWER_AUTOCANNON);
    a.acquireSupport(SUP_ARMOR_BAY);
    b.acquireSupport(SUP_ARMOR_BAY);
    for (let i = 0; i < 30; i++) { a.step(); b.step(); }
    expect(a.checksum()).toBe(b.checksum());
    a.weapons[0]!.turretOffset += 0.1;
    expect(a.checksum()).not.toBe(b.checksum());
  });

  it('获得、替换武器与支援槽返回明确代码', () => {
    const world = new World(1);
    expect(world.acquireWeapon(TOWER_AUTOCANNON)).toBe(0);
    expect(world.acquireWeapon(TOWER_LASER)).toBe(0);
    expect(world.acquireWeapon(999)).toBe(-51);
    expect(world.acquireSupport(SUP_ARMOR_BAY)).toBe(0);
    expect(world.replaceWeapon(0, TOWER_LASER)).toBe(0);
    expect(world.replaceWeapon(99, TOWER_AUTOCANNON)).toBe(-60);
  });

  it('四次重复获得触发合成时保留最高等级并释放槽位', () => {
    const world = new World(2);
    for (let i = 0; i < 3; i++) expect(world.acquireWeapon(TOWER_AUTOCANNON)).toBe(0);
    const occupied = world.weapons.filter((slot) => slot.type >= 0);
    expect(occupied).toHaveLength(1);
    expect(occupied[0]!.level).toBeLessThanOrEqual(TOWER_MAX_LEVEL);
  });

  it('支援聚合驱动船体上限', () => {
    const world = new World(3);
    world.acquireSupport(SUP_ARMOR_BAY);
    world.step();
    expect(world.ship.maxHp).toBe(115);
  });

  it('checksum 不包含星币余额', () => {
    const a = new World(4);
    const b = new World(4);
    a.starCoins = 100;
    expect(a.checksum()).toBe(b.checksum());
  });
});
