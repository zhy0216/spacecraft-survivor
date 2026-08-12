import { describe, expect, it } from 'vitest';
import { SUP_ARMOR_BAY } from '../data/supports';
import { TOWER_AUTOCANNON, TOWER_LASER, TOWER_MAX_LEVEL } from '../data/towers';
import { tuning } from './config';
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

describe('加速技能(空格)', () => {
  it('触发即提速:巡航上限按 boostSpeedMul 抬高,窗内速度超过普通巡航', () => {
    const world = new World(7);
    const east = { desiredHeading: { x: 1, y: 0 }, boost: false };
    // 先把船头转向 +X 并推到普通巡航稳态
    for (let i = 0; i < 240; i++) world.step(east);
    const normalSpeed = Math.hypot(world.ship.vx, world.ship.vy);
    expect(normalSpeed).toBeLessThanOrEqual(tuning.shipCruiseSpeed + 1e-6);

    east.boost = true;
    world.step(east);
    expect(world.boostTime).toBeGreaterThan(0);
    expect(world.boostCooldown).toBeGreaterThan(0);
    for (let i = 0; i < 30; i++) world.step(east);
    const boosted = Math.hypot(world.ship.vx, world.ship.vy);
    expect(boosted).toBeGreaterThan(normalSpeed * 1.5);
    expect(boosted).toBeLessThanOrEqual(tuning.shipCruiseSpeed * tuning.boostSpeedMul + 1e-6);
  });

  it('冷却门槛:窗结束后按住空格不重触发,冷却归零后才能再次点火', () => {
    const world = new World(8);
    const cmd = { desiredHeading: { x: 1, y: 0 }, boost: true };
    world.step(cmd);
    const cdAfterFire = world.boostCooldown;
    expect(cdAfterFire).toBeCloseTo(tuning.boostCooldown - 1 / 60, 3);
    // 走完加速窗:boostTime 归零,但冷却仍在走,按着空格也不再点火
    const windowTicks = Math.ceil(tuning.boostDuration * 60) + 2;
    for (let i = 0; i < windowTicks; i++) world.step(cmd);
    expect(world.boostTime).toBe(0);
    expect(world.boostCooldown).toBeGreaterThan(0);
    // 冷却走完的下一帧:再次点火
    const restTicks = Math.ceil(world.boostCooldown * 60) + 2;
    for (let i = 0; i < restTicks; i++) world.step(cmd);
    expect(world.boostTime).toBeGreaterThan(0);
  });

  it('无方向输入时沿船头满推:松着方向键按空格,船也真的动起来', () => {
    const world = new World(9);
    const cmd = { desiredHeading: null, boost: true };
    for (let i = 0; i < 30; i++) world.step(cmd);
    expect(Math.hypot(world.ship.vx, world.ship.vy)).toBeGreaterThan(50);
  });

  it('计时器进 checksum:同 seed 一边点火一边不点,哈希当场分叉', () => {
    const a = new World(10);
    const b = new World(10);
    a.step({ desiredHeading: null, boost: true });
    b.step({ desiredHeading: null, boost: false });
    expect(a.checksum()).not.toBe(b.checksum());
  });

  it('加速窗内船体受伤按 boostDamageTakenMul 打折,窗外全额', () => {
    const world = new World(13);
    world.damageShip(10);
    expect(world.ship.hp).toBeCloseTo(90);
    world.step({ desiredHeading: null, boost: true }); // 点火:窗内
    expect(world.boostTime).toBeGreaterThan(0);
    world.damageShip(10);
    expect(world.ship.hp).toBeCloseTo(90 - 10 * tuning.boostDamageTakenMul);
  });
});

describe('逐武器 DPS 读数', () => {
  it('带塔型的伤害按型归账,窗口平滑收敛后不打则衰减回落', () => {
    const world = new World(11);
    const e = world.enemies.spawn();
    e.hp = e.maxHp = 1e6;
    expect(world.dpsOf(TOWER_AUTOCANNON)).toBe(0);
    // 稳定输入 600 伤害/秒(每帧 10):平滑值应收敛到 600 附近
    for (let i = 0; i < 600; i++) {
      world.step();
      world.damageEnemy(e, 10, undefined, TOWER_AUTOCANNON);
    }
    const settled = world.dpsOf(TOWER_AUTOCANNON);
    expect(settled).toBeGreaterThan(500);
    expect(settled).toBeLessThan(700);
    // 未被归账的型保持 0;型越界读不炸
    expect(world.dpsOf(TOWER_LASER)).toBe(0);
    expect(world.dpsOf(-1)).toBe(0);
    expect(world.dpsOf(999)).toBe(0);
    // 停火后按 2.5s 窗口衰减:5 秒后剩不到两成
    for (let i = 0; i < 300; i++) world.step();
    expect(world.dpsOf(TOWER_AUTOCANNON)).toBeLessThan(settled * 0.2);
  });

  it('本局累计伤害与峰值 DPS 逐帧落账(局末战报的两份读数)', () => {
    const world = new World(14);
    const e = world.enemies.spawn();
    e.hp = e.maxHp = 1e6;
    world.damageEnemy(e, 100, undefined, TOWER_AUTOCANNON);
    world.damageEnemy(e, 50, undefined, TOWER_AUTOCANNON);
    world.damageEnemy(e, 30, undefined, TOWER_LASER);
    // 累计账不衰减:就是打出去的原数
    expect(world.runDamageByType[TOWER_AUTOCANNON]).toBeCloseTo(150);
    expect(world.runDamageByType[TOWER_LASER]).toBeCloseTo(30);
    // 峰值在下一帧帧首取样(衰减后的稳态口径):step 一帧后 > 0,此后停火只降不升
    world.step();
    const peak = world.peakDps;
    expect(peak).toBeGreaterThan(0);
    for (let i = 0; i < 120; i++) world.step();
    expect(world.peakDps).toBe(peak);
  });

  it('DPS 读数不进 checksum(纯 HUD 读数,照 threatRate 口径)', () => {
    const a = new World(12);
    const b = new World(12);
    const e = a.enemies.spawn();
    e.hp = e.maxHp = 1e6;
    const f = b.enemies.spawn();
    f.hp = f.maxHp = 1e6;
    // 同样的伤害、一边带归因一边不带:世界状态(hp)一致,哈希必须一致
    a.damageEnemy(e, 50, undefined, TOWER_AUTOCANNON);
    b.damageEnemy(f, 50);
    expect(a.dpsOf(TOWER_AUTOCANNON)).toBeGreaterThan(0);
    expect(b.dpsOf(TOWER_AUTOCANNON)).toBe(0);
    expect(a.checksum()).toBe(b.checksum());
  });
});
