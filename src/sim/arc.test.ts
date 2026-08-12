import { describe, expect, it } from 'vitest';
import { ARC_MEDIUM_DEG, ARC_OMNI_DEG } from '../data/arcs';
import { type Arc, arcContains, findArcTarget, slotArc } from './arc';
import {
  createWeaponSlots,
  slotArcCenter,
  slotHasSpace,
  slotMuzzleWorld,
  swapWeaponSlots,
  WEAPON_HARDPOINTS,
  WEAPON_SLOT_COUNT,
  WEAPON_SLOT_FACING,
} from './armory';
import { createEnemy } from './enemy';
import { createShip, DEG2RAD, wrapAngle } from './ship';

describe('slotArc:固定槽位射界', () => {
  it('八个槽位的中心随船体整体旋转,半角等于档位的一半', () => {
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
  it('创建 8 武器槽,全部为空(支援槽整类删除:支援已并入法令)', () => {
    expect(WEAPON_SLOT_COUNT).toBe(8);
    const slots = createWeaponSlots();
    expect(slots).toHaveLength(8);
    expect(slots.every((slot) => slot.type === -1)).toBe(true);
  });

  it('八个硬点与八个朝向一一对应:每 45° 一档、都落在船体包围盒内', () => {
    expect(WEAPON_HARDPOINTS).toHaveLength(WEAPON_SLOT_COUNT);
    expect(WEAPON_SLOT_FACING).toHaveLength(WEAPON_SLOT_COUNT);
    for (let i = 0; i < WEAPON_SLOT_COUNT; i++) {
      // 朝向 = i × 45°(折回 (-π, π];槽 4 恰好是 π,wrapAngle 原样保留)
      const want = wrapAngle((i * Math.PI) / 4);
      expect(wrapAngle(WEAPON_SLOT_FACING[i]! - want), `槽 ${i} 的朝向`).toBeCloseTo(0, 12);
      // 硬点方位角与射界朝向**同向**(两张表错位 = 炮口从船的另一头冒火)。
      // 允许一档偏差:硬点沿 18×13 的椭圆均布(船比宽长),而射界是正 45° 的等分 ——
      // 斜向四个槽的椭圆方位角因此被压回约 36°。差 9° 只影响炮口冒火的位置,
      // 不影响"这门炮朝哪打"(射界只认 WEAPON_SLOT_FACING);真错位会是 45° 以上
      const hp = WEAPON_HARDPOINTS[i]!;
      const skew = Math.abs(wrapAngle(Math.atan2(hp.y, hp.x) - want));
      expect(skew, `槽 ${i} 的硬点方位`).toBeLessThan(12 * DEG2RAD);
      // 落在船体包围盒(shipLength 48 × shipWidth 36)之内:炮口不许悬在船外
      expect(Math.abs(hp.x)).toBeLessThanOrEqual(24);
      expect(Math.abs(hp.y)).toBeLessThanOrEqual(18);
    }
  });

  it('swapWeaponSlots 换走全部节流状态,但炮管一律归位', () => {
    const slots = createWeaponSlots();
    const a = slots[0]!;
    const b = slots[3]!;
    a.type = 1;
    a.level = 3;
    a.ammo = 7;
    a.heat = 4.5;
    a.charge = 0.6;
    a.turretOffset = 0.9;
    b.type = 5;
    b.level = 2;
    b.ammo = 11;
    b.turretOffset = -0.4;
    swapWeaponSlots(a, b);
    // 武器与它的弹夹/热量/充能一起搬走:换位不是"拆了再装",不许借它免费装填
    expect(a.type).toBe(5);
    expect(a.level).toBe(2);
    expect(a.ammo).toBe(11);
    expect(b.type).toBe(1);
    expect(b.level).toBe(3);
    expect(b.ammo).toBe(7);
    expect(b.heat).toBe(4.5);
    expect(b.charge).toBe(0.6);
    // 炮管偏角是"相对射界中心"的,而换位换掉了射界中心 —— 两边都归零
    expect(a.turretOffset).toBe(0);
    expect(b.turretOffset).toBe(0);
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
