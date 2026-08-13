import { describe, expect, it } from 'vitest';
import {
  DOCK_EDICT_PRICE,
  DOCK_REPAIR_PRICE,
  DOCK_SHOP_REFRESH_PRICE,
  DOCK_WEAPON_PRICE,
  REFIT_HEAL_FRACTION,
  SHOP_BEACON_LIFETIME,
  SHOP_BEACON_MAX_DIST,
  SHOP_BEACON_MIN_DIST,
} from '../data/economy';
import { SIM_DT } from '../core/loop';
import { TOWER_AUTOCANNON } from '../data/towers';
import { World } from './world';

describe('槽位制整备与船坞商店', () => {
  it('completeRefit 只在整备中生效,且**不回血**(回血挂在接上信标那一刻)', () => {
    const world = new World(1);
    world.ship.hp = 1;
    expect(world.completeRefit()).toBe(false);
    world.refitPending = true;
    expect(world.completeRefit()).toBe(true);
    // 用户设计会:商店搬上地图后,免费 30% 回血在**接上信标**时结算(见 World.step 的接触分支)——
    // 关面板才回血的话,玩家在店里没法判断那 25 星币的付费修复还要不要买
    expect(world.ship.hp).toBe(1);
    expect(world.refitPending).toBe(false);
  });

  it('接上地图商店信标:开面板 + 免费回血 30%,信标当场熄灭(一轮一次)', () => {
    const world = new World(1);
    const full = world.ship.maxHp;
    world.ship.hp = 1;
    // 手工点亮一个贴在船身上的信标(生成时机由 step 的跨段分支管,那条另有用例)
    world.shopBeaconActive = true;
    world.shopBeaconX = world.ship.x;
    world.shopBeaconY = world.ship.y;
    world.shopBeaconTtl = 30;
    let openedAt = -1;
    world.onRefitOffer = (seg) => (openedAt = seg);

    world.step();

    expect(world.refitPending).toBe(true);
    expect(openedAt).toBe(world.shopBeaconSegment);
    expect(world.ship.hp).toBe(1 + Math.ceil(full * REFIT_HEAL_FRACTION));
    expect(world.shopBeaconActive).toBe(false); // 一轮一次:关掉面板也不许再接一次
    expect(world.shopBeaconTtl).toBe(0);
  });

  it('没赶到:信标到期熄灭,两张货架一起作废(不留过期货)', () => {
    const world = new World(1);
    world.shopBeaconActive = true;
    world.shopBeaconX = world.ship.x + 100000; // 远到这一帧绝不可能碰上
    world.shopBeaconY = world.ship.y;
    world.shopBeaconTtl = SIM_DT / 2; // 下一帧就到期
    world.dockEdictOffers.push(0);
    world.shopWeapons.push(TOWER_AUTOCANNON);

    world.step();

    expect(world.shopBeaconActive).toBe(false);
    expect(world.refitPending).toBe(false); // 没接上就没有面板
    expect(world.dockEdictOffers).toHaveLength(0);
    expect(world.shopWeapons).toHaveLength(0);
  });

  it('跨航段那一帧:信标点亮在船周围 600..1400px,两张货架同帧掷定,战斗不停', () => {
    const world = new World(5);
    // 跑到第一个段边界(WAVE_SEGMENTS[0].duration = 120s)。信标一亮就收工 ——
    // 30 秒后它会自己熄灭,多跑几帧就检不到了
    let guard = 0;
    while (!world.shopBeaconActive && guard < 130 * 60) {
      world.step();
      guard++;
    }
    expect(world.shopBeaconActive).toBe(true);
    expect(world.wave.segment).toBe(1); // 跨段那一帧点亮
    expect(world.refitPending).toBe(false); // **战斗不停**:面板要等玩家开过去撞上才弹
    expect(world.shopBeaconTtl).toBeCloseTo(SHOP_BEACON_LIFETIME, 6);
    const dist = Math.hypot(world.shopBeaconX - world.ship.x, world.shopBeaconY - world.ship.y);
    expect(dist).toBeGreaterThanOrEqual(SHOP_BEACON_MIN_DIST - 1);
    expect(dist).toBeLessThanOrEqual(SHOP_BEACON_MAX_DIST + 1);
    // 货架在信标生成时就掷定(不是接上时才掷):接不接得上取决于玩家操作,
    // 让它决定 rng 时点等于把随机序列交给玩家手速
    expect(world.dockEdictOffers.length).toBeGreaterThan(0);
    expect(world.shopWeapons.length).toBeGreaterThan(0);
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
