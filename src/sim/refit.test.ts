import { describe, expect, it } from 'vitest';
import { DOCK_EDICT_PRICE, DOCK_REPAIR_FRACTION, DOCK_REPAIR_PRICE, DOCK_SHOP_REFRESH_PRICE, DOCK_WEAPON_PRICE, REFIT_HEAL_FRACTION } from '../data/economy';
import { TOWER_AUTOCANNON } from '../data/towers';
import { World } from './world';

describe('槽位制整备与船坞商店', () => {
  it('completeRefit 只在整备中生效并免费回血 30%', () => {
    const world = new World(1);
    const full = world.ship.maxHp;
    world.ship.hp = 1;
    expect(world.completeRefit()).toBe(false);
    world.refitPending = true;
    expect(world.completeRefit()).toBe(true);
    expect(world.ship.hp).toBe(1 + Math.ceil(full * REFIT_HEAL_FRACTION));
  });

  it('船坞购买接口在非整备中拒绝', () => {
    const world = new World(2);
    expect(world.buyDockEdict(0)).toBe(-20);
    expect(world.buyDockRepair()).toBe(-20);
    expect(world.buyShopWeapon(0)).toBe(-20);
    expect(world.refreshShop()).toBe(-20);
  });

  it('整备中可购买修复与货架武器,星币按价格扣除', () => {
    const world = new World(3);
    world.refitPending = true;
    world.shopWeapons.push(TOWER_AUTOCANNON);
    world.starCoins = DOCK_REPAIR_PRICE + DOCK_WEAPON_PRICE + DOCK_SHOP_REFRESH_PRICE + DOCK_EDICT_PRICE;
    world.ship.hp = 1;
    expect(world.buyDockRepair()).toBe(0);
    expect(world.buyShopWeapon(0)).toBe(0);
    expect(world.shopWeapons[0]).toBe(-1);
  });
});
