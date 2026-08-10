import { describe, expect, it } from 'vitest';
import { ARC_MEDIUM_DEG, ARC_OMNI_DEG } from '../data/arcs';
import { type Arc, arcContains, findArcTarget, slotArc } from './arc';
import {
  createSupportSlots,
  createWeaponSlots,
  slotArcCenter,
  slotHasSpace,
  slotMuzzleWorld,
  SUPPORT_SLOT_COUNT,
  WEAPON_HARDPOINTS,
  WEAPON_SLOT_COUNT,
  WEAPON_SLOT_FACING,
} from './armory';
import { createEnemy } from './enemy';
import { createShip, DEG2RAD, wrapAngle } from './ship';

describe('slotArc:固定槽位射界', () => {
  it('四个槽位的中心随船体整体旋转,半角等于档位的一半', () => {
    const out: Arc = { center: 0, half: 0 };
    for (let i = 0; i < WEAPON_SLOT_COUNT; i++) {
      slotArc(i, 0.7, ARC_MEDIUM_DEG, out);
      expect(wrapAngle(out.center - WEAPON_SLOT_FACING[i]! - 0.7)).toBeCloseTo(0, 12);
      expect(out.half).toBeCloseTo(ARC_MEDIUM_DEG * DEG2RAD / 2, 12);
    }
  });

  it('全向档夹到 π,越界槽位回退到船头朝向', () => {
    const out: Arc = { center: 0, half: 0 };
    slotArc(99, -2.3, ARC_OMNI_DEG, out);
    expect(out.center).toBe(wrapAngle(-2.3));
    expect(out.half).toBe(Math.PI);
  });
});

describe('arcContains / findArcTarget', () => {
  it('含边界并正确处理跨 ±π', () => {
    const arc: Arc = { center: 175 * DEG2RAD, half: 10 * DEG2RAD };
    expect(arcContains(arc, -179 * DEG2RAD)).toBe(true);
    expect(arcContains(arc, -170 * DEG2RAD)).toBe(false);
  });

  it('只从射界与射程交集里选择最近的存活目标', () => {
    const dead = createEnemy();
    dead.x = 10;
    dead.dead = true;
    const outside = createEnemy();
    outside.y = 20;
    const far = createEnemy();
    far.x = 80;
    const near = createEnemy();
    near.x = 30;
    const arc: Arc = { center: 0, half: Math.PI / 4 };
    expect(findArcTarget([dead, outside, far, near], 0, 0, arc, 100)).toBe(near);
  });
});

describe('armory:定长槽位与硬点数学', () => {
  it('创建 4 武器槽与 4 支援槽,全部为空', () => {
    expect(WEAPON_SLOT_COUNT).toBe(4);
    expect(SUPPORT_SLOT_COUNT).toBe(4);
    expect(createWeaponSlots().map((slot) => slot.type)).toEqual([-1, -1, -1, -1]);
    expect(createSupportSlots().map((slot) => slot.type)).toEqual([-1, -1, -1, -1]);
  });

  it('炮口 = 船心 + 随船旋转后的硬点,射界中心与 slotArc 一致', () => {
    const ship = createShip();
    ship.x = 100;
    ship.y = 50;
    ship.heading = Math.PI / 2;
    const out = { x: 0, y: 0 };
    slotMuzzleWorld(ship, 0, out);
    expect(out.x).toBeCloseTo(100 - WEAPON_HARDPOINTS[0]!.y, 12);
    expect(out.y).toBeCloseTo(50 + WEAPON_HARDPOINTS[0]!.x, 12);
    const arc: Arc = { center: 0, half: 0 };
    slotArc(0, ship.heading, ARC_MEDIUM_DEG, arc);
    expect(slotArcCenter(ship, 0)).toBe(arc.center);
  });

  it('任一武器槽为空即有空间,全满才返回 false', () => {
    const slots = createWeaponSlots();
    expect(slotHasSpace(slots)).toBe(true);
    for (const slot of slots) slot.type = 0;
    expect(slotHasSpace(slots)).toBe(false);
  });
});
