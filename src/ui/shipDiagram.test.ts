import { beforeEach, describe, expect, it } from 'vitest';
import { TOWER_ANNIHILATION, TOWER_KIND_COUNT, TOWER_PD, TOWERS } from '../data/towers';
import { WEAPON_SLOT_COUNT, WEAPON_SLOT_FACING } from '../sim/armory';
import { changeLocale, initI18n } from '../i18n';
import { slotFacingDeg, slotFacingName, towerGlyph, towerTintCss, wedgeRadius } from './shipDiagram';

beforeEach(async () => {
  await initI18n('zh-CN');
});

describe('舰船图的朝向表', () => {
  it('朝向名与 WEAPON_SLOT_FACING 一一对应（错位 = 面板上写着正前的炮其实朝后）', () => {
    expect(WEAPON_SLOT_FACING.length).toBe(WEAPON_SLOT_COUNT);
    // 四个正方向逐条对表:名字说的方向必须就是数值表里的那个角
    expect(slotFacingName(0)).toBe('正前');
    expect(slotFacingDeg(0)).toBeCloseTo(0);
    expect(slotFacingName(2)).toBe('正右');
    expect(slotFacingDeg(2)).toBeCloseTo(90);
    expect(slotFacingName(4)).toBe('正后');
    expect(slotFacingDeg(4)).toBeCloseTo(180);
    expect(slotFacingName(6)).toBe('正左');
    expect(slotFacingDeg(6)).toBeCloseTo(-90);
  });

  it('朝向名走翻译:切到 en 后八个朝向名全部换新', async () => {
    const zh = Array.from({ length: WEAPON_SLOT_COUNT }, (_, slot) => slotFacingName(slot));
    expect(zh.every((name) => name.length > 0)).toBe(true);
    await changeLocale('en');
    const en = Array.from({ length: WEAPON_SLOT_COUNT }, (_, slot) => slotFacingName(slot));
    expect(en[0]).toBe('Forward');
    expect(en[4]).toBe('Rear');
    // 两套语言逐槽不重合:同一编号在两个语言里报的名字不该撞车
    for (let slot = 0; slot < WEAPON_SLOT_COUNT; slot++) {
      expect(en[slot]).not.toBe(zh[slot]);
    }
  });

  it('槽位下标越界退回「槽 N」,不静默画到某个别的方向去', () => {
    expect(slotFacingName(WEAPON_SLOT_COUNT)).toBe('槽 8');
    expect(slotFacingName(-1)).toBe('槽 -1');
  });

  it('每槽 45° 一档、顺时针一圈（conic-gradient 的 from 就吃这个数，不做任何翻转）', () => {
    for (let slot = 0; slot < WEAPON_SLOT_COUNT; slot++) {
      const deg = slotFacingDeg(slot);
      expect(Math.abs(deg % 45)).toBeLessThan(1e-9);
      // 0..3 在右半圈(正数)、5..7 在左半圈(负数):顺时针为正的口径与 armory 一致
      if (slot > 0 && slot < 4) expect(deg).toBeGreaterThan(0);
      if (slot > 4) expect(deg).toBeLessThan(0);
    }
  });

  it('槽位下标越界退回船头朝向，不静默画到某个别的方向去', () => {
    expect(slotFacingDeg(WEAPON_SLOT_COUNT)).toBe(0);
    expect(slotFacingDeg(-1)).toBe(0);
  });
});

describe('射界扇形的半径映射', () => {
  it('射程越远扇形越大，但两头都夹住（最远的也不许顶穿槽位卡片）', () => {
    const shortest = wedgeRadius(TOWERS[TOWER_PD]!.range); // 210,全场最短
    const longest = wedgeRadius(TOWERS[TOWER_ANNIHILATION]!.range); // 900,全场最远
    expect(shortest).toBeLessThan(longest);
    expect(shortest).toBeGreaterThanOrEqual(wedgeRadius(0));
    expect(longest).toBe(wedgeRadius(99999));
    // 数值表里每一型都落在夹取区间内 —— 越界只会发生在改坏表之后
    for (let type = 0; type < TOWER_KIND_COUNT; type++) {
      const r = wedgeRadius(TOWERS[type]!.range);
      expect(r).toBeGreaterThanOrEqual(wedgeRadius(0));
      expect(r).toBeLessThanOrEqual(wedgeRadius(99999));
    }
  });

  it('NaN / 负射程夹回下界（改坏表也不会画出负半径的圆）', () => {
    expect(wedgeRadius(Number.NaN)).toBe(wedgeRadius(0));
    expect(wedgeRadius(-500)).toBe(wedgeRadius(0));
  });
});

describe('武器的图标与颜色', () => {
  it('每一型都有色，未知型显式报 ?、不静默冒充第 0 型', () => {
    expect(towerGlyph(TOWER_PD)).not.toBe('?');
    expect(towerGlyph(999)).toBe('?');
    expect(towerTintCss(TOWER_PD)).toBe(`#${TOWERS[TOWER_PD]!.tint.toString(16).padStart(6, '0')}`);
    expect(towerTintCss(999)).not.toContain('NaN');
  });
});
