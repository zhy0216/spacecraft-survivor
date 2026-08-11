import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../core/loop';
import { SUP_AMMO_BAY, SUP_CAPACITOR, SUP_RADIATOR } from '../data/supports';
import { THR_AMMO, THR_CHARGE, THR_HEAT, TOWER_AUTOCANNON, TOWER_LASER, TOWER_RAILGUN, TOWERS, towerMagazine } from '../data/towers';
import { createSupportSlots, createWeaponSlots } from './armory';
import { aggregateSupportBuffs, createSupportBuffs } from './support';
import { canFire, onFired, slotChargeTime, slotFireInterval, slotHeatMax, slotReload, slotTowerDef, stepThrottle } from './tower';

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
    const buffs = createSupportBuffs();
    onFired(slot, def, 1, buffs);
    expect(slot.ammo).toBe(towerMagazine(def, 1) - 1);
    expect(slot.cooldown).toBe(slotFireInterval(slot, def, buffs));
    slot.ammo = 1;
    onFired(slot, def, 1, buffs);
    expect(slot.reloadLeft).toBe(slotReload(slot, def, buffs));
  });

  it('过热系达到上限后锁定并随时间降温', () => {
    const { slot, def } = setup(TOWER_LASER);
    const buffs = createSupportBuffs();
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
    const buffs = createSupportBuffs();
    expect(canFire(slot, def)).toBe(false);
    for (let i = 0; i < Math.ceil(slotChargeTime(slot, def, buffs) / SIM_DT); i++) stepThrottle(slot, def, SIM_DT, buffs);
    expect(canFire(slot, def)).toBe(true);
    onFired(slot, def, 1, buffs);
    expect(slot.charge).toBe(0);
  });
});

describe('支援聚合进入槽位数值包装', () => {
  it('弹药库、散热器、电容组只强化对应节流族', () => {
    const supports = createSupportSlots();
    supports[0]!.type = SUP_AMMO_BAY;
    supports[1]!.type = SUP_RADIATOR;
    supports[2]!.type = SUP_CAPACITOR;
    const buffs = aggregateSupportBuffs(supports, createSupportBuffs());
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
