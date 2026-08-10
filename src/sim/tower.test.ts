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
    while (canFire(slot, def)) onFired(slot, def, 1, buffs);
    expect(slot.coolLock).toBeGreaterThan(0);
    const heat = slot.heat;
    stepThrottle(slot, def, SIM_DT, buffs);
    expect(slot.heat).toBeLessThan(heat);
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
