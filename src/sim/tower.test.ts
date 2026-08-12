import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../core/loop';
import { createEdictLevels, EDICT_AMMO, EDICT_CAPACITOR, EDICT_COOLANT, EDICT_OVERDRIVE } from '../data/edicts';
import {
  THR_AMMO, THR_CHARGE, THR_HEAT,
  TOWER_AURORA, TOWER_AUTOCANNON, TOWER_DELUGE, TOWER_LASER, TOWER_MORTAR, TOWER_RAILGUN,
  TOWER_STORM_CANNON, TOWERS, towerMagazine,
} from '../data/towers';
import { createWeaponSlots } from './armory';
import { aggregateEdictBuffs, createEdictBuffs } from './edictBuffs';
import {
  canFire, FIRE_CHARGING, FIRE_COOLDOWN, FIRE_LOCKED, FIRE_READY, FIRE_RELOAD, onFired,
  slotChargeTime, slotFireInterval, slotFireReadout, slotHeatMax, slotReload, slotShotsPerFire,
  slotSustainedDps, slotTowerDef, stepThrottle,
} from './tower';

function setup(type: number) {
  const slot = createWeaponSlots()[0]!;
  const def = TOWERS[type]!;
  slot.type = type; slot.level = 1; slot.ammo = towerMagazine(def, 1);
  return { slot, def };
}

describe('slotTowerDef', () => {
  it('从武器槽解析塔定义,空槽返回 undefined', () => {
    const slot = createWeaponSlots()[0]!;
    expect(slotTowerDef(slot)).toBeUndefined();
    slot.type = TOWER_AUTOCANNON;
    expect(slotTowerDef(slot)).toBe(TOWERS[TOWER_AUTOCANNON]);
  });
});

describe('三套槽位节流状态机', () => {
  it('弹药系开火扣弹并写入冷却,空弹后进入装填', () => {
    const { slot, def } = setup(TOWER_AUTOCANNON);
    const buffs = createEdictBuffs();
    onFired(slot, def, 1, buffs);
    expect(slot.ammo).toBe(towerMagazine(def, 1) - 1);
    expect(slot.cooldown).toBe(slotFireInterval(slot, def, buffs));
    slot.ammo = 1;
    onFired(slot, def, 1, buffs);
    expect(slot.reloadLeft).toBe(slotReload(slot, def, buffs));
  });

  it('过热系达到上限后锁定并随时间降温', () => {
    const { slot, def } = setup(TOWER_LASER);
    const buffs = createEdictBuffs();
    // 与 sim/turret.ts 的每帧顺序同口径:先推进节流,再问放行,能开就开。
    // onFired 每发都写入 fireInterval 冷却,一口气 while 连开只打得出第 1 发就被冷却挡住,
    // 必须逐帧贪连射才到得了顶(满速约 3s = 24 / (1.6/0.1 - 8));600 帧 = 10s 是宽裕的安全上限
    for (let f = 0; f < 600 && slot.coolLock <= 0; f++) {
      stepThrottle(slot, def, SIM_DT, buffs);
      if (canFire(slot, def)) onFired(slot, def, 1, buffs);
    }
    expect(slot.coolLock).toBeGreaterThan(0);
    expect(slot.heat).toBe(slotHeatMax(slot, def, buffs)); // 夹在上限,不冲过头
    // 锁死期间:一律不许开火,但降温照跑(热量条一直往下走)
    const heat = slot.heat;
    stepThrottle(slot, def, SIM_DT, buffs);
    expect(canFire(slot, def)).toBe(false);
    expect(slot.heat).toBeLessThan(heat);
    // 罚够 overheatLock 就到点解锁,且热量从零起手
    for (let f = 0; f < Math.ceil(def.overheatLock / SIM_DT); f++) stepThrottle(slot, def, SIM_DT, buffs);
    expect(slot.coolLock).toBe(0);
    expect(slot.heat).toBe(0);
    expect(canFire(slot, def)).toBe(true);
  });

  it('充能系蓄满才可开火,开火清空充能', () => {
    const { slot, def } = setup(TOWER_RAILGUN);
    const buffs = createEdictBuffs();
    expect(canFire(slot, def)).toBe(false);
    for (let i = 0; i < Math.ceil(slotChargeTime(slot, def, buffs) / SIM_DT); i++) stepThrottle(slot, def, SIM_DT, buffs);
    expect(canFire(slot, def)).toBe(true);
    onFired(slot, def, 1, buffs);
    expect(slot.charge).toBe(0);
  });
});

describe('slotShotsPerFire(恒发 × Lv3 跳变,与开火同一份口径)', () => {
  it('机炮 Lv3 双管、风暴机炮基础双管、焦土骤雨三连发、光束/磁轨恒 1', () => {
    const ac = TOWERS[TOWER_AUTOCANNON]!;
    expect(slotShotsPerFire(ac, 1)).toBe(1);
    expect(slotShotsPerFire(ac, 3)).toBe(2);
    // 风暴机炮的"双管齐射"是恒发签名(def.burst = 2):Lv1 起就是双管,不靠 Lv3 跳变
    expect(slotShotsPerFire(TOWERS[TOWER_STORM_CANNON]!, 1)).toBe(2);
    expect(slotShotsPerFire(TOWERS[TOWER_DELUGE]!, 1)).toBe(3);
    expect(slotShotsPerFire(TOWERS[TOWER_LASER]!, 5)).toBe(1);
    expect(slotShotsPerFire(TOWERS[TOWER_RAILGUN]!, 5)).toBe(1);
  });
});

describe('slotSustainedDps(理论持续 DPS —— 火力面板的固定数值)', () => {
  const buffs = createEdictBuffs();

  it('弹药系摊上装填硬停顿:机炮 Lv1 = 20发×6 / (19×0.4 + 1.5) ≈ 13.2', () => {
    const { slot, def } = setup(TOWER_AUTOCANNON);
    expect(slotSustainedDps(slot, def, buffs)).toBeCloseTo((20 * 6) / (19 * 0.4 + 1.5), 5);
  });

  it('无装填买断(风暴机炮)= 纯射速,双管齐射进发数:2×6/0.25 = 48', () => {
    const { slot, def } = setup(TOWER_STORM_CANNON);
    expect(slotSustainedDps(slot, def, buffs)).toBeCloseTo(48, 5);
  });

  it('过热系摊上锁死罚时:激光 = 30 × 3/(3+2) = 18;无过热签名(极光)不打折 = 30', () => {
    const laser = setup(TOWER_LASER);
    expect(slotSustainedDps(laser.slot, laser.def, buffs)).toBeCloseTo(18, 5);
    const aurora = setup(TOWER_AURORA);
    expect(slotSustainedDps(aurora.slot, aurora.def, buffs)).toBeCloseTo(30, 5);
  });

  it('充能系 = 每发 ÷ 蓄力时长;迫击炮取落点伤害(def.damage 恒 0 不算成哑炮)', () => {
    const rail = setup(TOWER_RAILGUN);
    expect(slotSustainedDps(rail.slot, rail.def, buffs)).toBeCloseTo(45 / 2.4, 5);
    const mortar = setup(TOWER_MORTAR);
    expect(slotSustainedDps(mortar.slot, mortar.def, buffs)).toBeCloseTo(34 / 3, 5);
  });

  it('法令聚合抬得动它:弹药协议(射速 + 装填)让机炮的持续 DPS 变大,叠第二层再变大', () => {
    const { slot, def } = setup(TOWER_AUTOCANNON);
    const base = slotSustainedDps(slot, def, buffs);
    const levels = createEdictLevels();
    levels[EDICT_AMMO] = 1;
    const one = slotSustainedDps(slot, def, aggregateEdictBuffs(levels, createEdictBuffs()));
    levels[EDICT_AMMO] = 2;
    const two = slotSustainedDps(slot, def, aggregateEdictBuffs(levels, createEdictBuffs()));
    expect(one).toBeGreaterThan(base);
    expect(two).toBeGreaterThan(one);
  });

  it('超载协议按层直乘进 DPS:2 层 = ×1.15²(全武器伤害是它独占的那条轴)', () => {
    const { slot, def } = setup(TOWER_AUTOCANNON);
    const base = slotSustainedDps(slot, def, buffs);
    const levels = createEdictLevels();
    levels[EDICT_OVERDRIVE] = 2;
    const buffed = aggregateEdictBuffs(levels, createEdictBuffs());
    expect(slotSustainedDps(slot, def, buffed)).toBeCloseTo(base * 1.15 * 1.15, 6);
  });
});

describe('slotFireReadout(下一次发射读数)', () => {
  const out = { state: FIRE_READY, seconds: 0, ratio: 0 };

  it('弹药系:装填优先于冷却(与 canFire 判序同源),清空报就绪', () => {
    const { slot, def } = setup(TOWER_AUTOCANNON);
    const buffs = createEdictBuffs();
    slotFireReadout(slot, def, buffs, out);
    expect(out).toEqual({ state: FIRE_READY, seconds: 0, ratio: 1 });
    slot.cooldown = 0.2;
    slotFireReadout(slot, def, buffs, out);
    expect(out.state).toBe(FIRE_COOLDOWN);
    expect(out.seconds).toBeCloseTo(0.2);
    expect(out.ratio).toBeCloseTo(1 - 0.2 / 0.4);
    slot.reloadLeft = 0.75;
    slotFireReadout(slot, def, buffs, out);
    expect(out.state).toBe(FIRE_RELOAD);
    expect(out.seconds).toBeCloseTo(0.75);
    expect(out.ratio).toBeCloseTo(0.5);
  });

  it('过热系:锁死报过热,进度按 overheatLock 回充', () => {
    const { slot, def } = setup(TOWER_LASER);
    slot.coolLock = 1;
    slotFireReadout(slot, def, createEdictBuffs(), out);
    expect(out.state).toBe(FIRE_LOCKED);
    expect(out.seconds).toBe(1);
    expect(out.ratio).toBeCloseTo(1 - 1 / def.overheatLock);
  });

  it('充能系:蓄力报充能(seconds = 未蓄部分 × 蓄力时长),蓄满就绪;NaN 不外漏', () => {
    const { slot, def } = setup(TOWER_RAILGUN);
    slot.charge = 0.25;
    slotFireReadout(slot, def, createEdictBuffs(), out);
    expect(out.state).toBe(FIRE_CHARGING);
    expect(out.seconds).toBeCloseTo(0.75 * 2.4);
    expect(out.ratio).toBe(0.25);
    slot.charge = 1;
    slotFireReadout(slot, def, createEdictBuffs(), out);
    expect(out).toEqual({ state: FIRE_READY, seconds: 0, ratio: 1 });
    slot.charge = Number.NaN;
    slotFireReadout(slot, def, createEdictBuffs(), out);
    expect(Number.isFinite(out.seconds)).toBe(true);
    expect(Number.isFinite(out.ratio)).toBe(true);
  });
});

describe('法令聚合进入槽位数值包装', () => {
  it('弹药协议、散热协议、电容协议只强化对应节流族', () => {
    const levels = createEdictLevels();
    levels[EDICT_AMMO] = 1;
    levels[EDICT_COOLANT] = 1;
    levels[EDICT_CAPACITOR] = 1;
    const buffs = aggregateEdictBuffs(levels, createEdictBuffs());
    const ammo = setup(TOWER_AUTOCANNON);
    const heat = setup(TOWER_LASER);
    const charge = setup(TOWER_RAILGUN);
    expect(slotFireInterval(ammo.slot, ammo.def, buffs)).toBeLessThan(ammo.def.fireInterval);
    expect(slotHeatMax(heat.slot, heat.def, buffs)).toBeGreaterThan(heat.def.heatMax);
    expect(slotChargeTime(charge.slot, charge.def, buffs)).toBeLessThan(charge.def.chargeTime);
    expect(ammo.def.throttle).toBe(THR_AMMO);
    expect(heat.def.throttle).toBe(THR_HEAT);
    expect(charge.def.throttle).toBe(THR_CHARGE);
  });
});
