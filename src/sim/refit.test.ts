import { describe, expect, it } from 'vitest';
import {
  DOCK_EDICT_COUNT,
  DOCK_EDICT_PRICE,
  DOCK_REPAIR_PRICE,
  DOCK_SHOP_REFRESH_PRICE,
  DOCK_WEAPON_PRICE,
  SHOP_BEACON_LIFETIME,
  SHOP_BEACON_MAX_DIST,
  SHOP_BEACON_MIN_DIST,
  shopDiscountPrice,
} from '../data/economy';
import { SIM_DT } from '../core/loop';
import { EDICT_AMMO } from '../data/edicts';
import { TOWER_AUTOCANNON, TOWER_LASER, TOWER_STORM_CANNON } from '../data/towers';
import { ACQUIRE_REPLACE_NEEDED, SHOP_NO_STARCOINS, World } from './world';

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

  it('接上地图商店信标:开面板、不回血,信标当场熄灭(一轮一次)', () => {
    const world = new World(1);
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
    expect(world.ship.hp).toBe(1); // 商店不白送:接上信标只是拿到付费修复的资格
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
    // 特价(打折机制)与货架同帧掷定:有货就必有一件打折
    expect(world.shopDiscountIndex).toBeGreaterThanOrEqual(0);
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

  it('特价折扣:掷定的特价位落在还没售出的货架上,扣费按特价算(法令与武器两条路)', () => {
    const world = new World(4);
    world.refitPending = true;
    world.dockEdictOffers.push(EDICT_AMMO);
    world.shopWeapons.push(TOWER_AUTOCANNON);
    // 特价指到法令第 0 格:原价 25 只扣特价
    world.shopDiscountIndex = 0;
    world.starCoins = shopDiscountPrice(DOCK_EDICT_PRICE);
    expect(world.buyDockEdict(0)).toBe(0);
    expect(world.starCoins).toBe(0);
    // 特价指到武器第 0 格(偏置 DOCK_EDICT_COUNT):原价 30 只扣特价
    world.shopDiscountIndex = DOCK_EDICT_COUNT;
    world.starCoins = shopDiscountPrice(DOCK_WEAPON_PRICE);
    expect(world.buyShopWeapon(0)).toBe(0);
    expect(world.starCoins).toBe(0);
  });

  it('特价不足原价:差 1 星币也买不了特价,但非特价格照原价拒绝', () => {
    const world = new World(4);
    world.refitPending = true;
    world.shopWeapons.push(TOWER_AUTOCANNON);
    world.shopDiscountIndex = DOCK_EDICT_COUNT; // 第 0 格武器打特价
    world.starCoins = shopDiscountPrice(DOCK_WEAPON_PRICE) - 1;
    expect(world.buyShopWeapon(0)).toBe(SHOP_NO_STARCOINS); // 一分钱都不能少
    expect(world.shopWeapons[0]).toBe(TOWER_AUTOCANNON); // 失败一个字段都不动
  });

  it('rollShopDiscount:只在没售出的格之间挑,货架全空时掷定 -1(恒掷 1 次 rng)', () => {
    const world = new World(4);
    world.refitPending = true;
    world.dockEdictOffers.push(EDICT_AMMO, EDICT_AMMO, EDICT_AMMO);
    world.shopWeapons.push(TOWER_AUTOCANNON);
    world.dockEdictOffers[0] = -1; // 售出一格:特价不许落在这里
    const rngBefore = world.rng.state;
    world.rollShopDiscount();
    expect(world.rng.state).not.toBe(rngBefore); // 恰掷 1 次,游标确实动过
    expect(world.shopDiscountIndex).not.toBe(0);
    // 全空货架:照掷 1 次,结果 -1 = 没有特价
    world.dockEdictOffers.length = 0;
    world.shopWeapons.length = 0;
    world.rollShopDiscount();
    expect(world.shopDiscountIndex).toBe(-1);
  });

  it('refreshShop 重掷货架后跟着重掷特价(新货架配新特价)', () => {
    const world = new World(4);
    world.refitPending = true;
    world.dockEdictOffers.push(EDICT_AMMO);
    world.shopWeapons.push(TOWER_AUTOCANNON);
    world.shopDiscountIndex = -1;
    world.starCoins = DOCK_SHOP_REFRESH_PRICE + 100;
    expect(world.refreshShop()).toBe(0);
    expect(world.shopDiscountIndex).toBeGreaterThanOrEqual(0);
  });

  it('槽满时带着替换位购买:旧武器被换下、新武器落位、货架下架(特价机制之外顺手修的换装通道)', () => {
    const world = new World(4);
    world.refitPending = true;
    world.shopWeapons.push(TOWER_LASER);
    world.starCoins = 999;
    for (const slot of world.weapons) {
      slot.type = TOWER_AUTOCANNON;
      slot.stars = 1;
    }
    expect(world.buyShopWeapon(0)).toBe(ACQUIRE_REPLACE_NEEDED); // 没给替换位:先选槽
    expect(world.starCoins).toBe(999); // 失败不扣费、货架不动
    expect(world.buyShopWeapon(0, 3)).toBe(0);
    expect(world.weapons[3]!.type).toBe(TOWER_LASER); // 新武器落在替换槽上
    expect(world.weapons[3]!.stars).toBe(1);
    expect(world.shopWeapons[0]).toBe(-1);
  });

  it('槽满但同型已凑两把 ★:买下直接吸收合成(3 把合 1 把),不要求替换位、扣费下架', () => {
    const world = new World(4);
    world.refitPending = true;
    world.shopWeapons.push(TOWER_AUTOCANNON);
    world.starCoins = DOCK_WEAPON_PRICE;
    world.weapons[0]!.type = TOWER_AUTOCANNON;
    world.weapons[0]!.stars = 1;
    world.weapons[1]!.type = TOWER_AUTOCANNON;
    world.weapons[1]!.stars = 1;
    for (let i = 2; i < 8; i++) {
      world.weapons[i]!.type = TOWER_LASER;
      world.weapons[i]!.stars = 1;
    }
    expect(world.buyShopWeapon(0)).toBe(0); // 吸收合成当场成功,不进替换态
    expect(world.starCoins).toBe(0);
    expect(world.shopWeapons[0]).toBe(-1);
    // 幸存槽 = 下标最小的槽 0 → ★★;槽 1 清空;激光原封不动
    expect(world.weapons[0]!.type).toBe(TOWER_AUTOCANNON);
    expect(world.weapons[0]!.stars).toBe(2);
    expect(world.weapons[1]!.type).toBe(-1);
    expect(world.weapons.filter((s) => s.type === TOWER_LASER)).toHaveLength(6);
  });

  it('吸收合成接链条:两把 ★ + 两把 ★★ 槽满买下 ★,当场合 ★★★ 变身(机炮→风暴机炮)', () => {
    const world = new World(4);
    world.refitPending = true;
    world.shopWeapons.push(TOWER_AUTOCANNON);
    world.starCoins = DOCK_WEAPON_PRICE;
    world.weapons[0]!.type = TOWER_AUTOCANNON;
    world.weapons[0]!.stars = 1;
    world.weapons[1]!.type = TOWER_AUTOCANNON;
    world.weapons[1]!.stars = 1;
    world.weapons[2]!.type = TOWER_AUTOCANNON;
    world.weapons[2]!.stars = 2;
    world.weapons[3]!.type = TOWER_AUTOCANNON;
    world.weapons[3]!.stars = 2;
    for (let i = 4; i < 8; i++) {
      world.weapons[i]!.type = TOWER_LASER;
      world.weapons[i]!.stars = 1;
    }
    expect(world.buyShopWeapon(0)).toBe(0);
    // 1★ 合 ★★(幸存槽 0)→ 与槽 2/3 的 ★★ 连合 ★★★ → 机炮有配方,当场变身风暴机炮
    expect(world.weapons[0]!.type).toBe(TOWER_STORM_CANNON);
    expect(world.weapons[0]!.stars).toBe(3);
    expect(world.weapons[1]!.type).toBe(-1);
    expect(world.weapons[2]!.type).toBe(-1);
    expect(world.weapons[3]!.type).toBe(-1);
    // 腾出 3 个空槽:1× 风暴机炮 + 4× 激光 = 5 门
    expect(world.weapons.filter((s) => s.type >= 0)).toHaveLength(5);
  });

  it('吸收合成不满足条件(同型只凑一把 ★)时仍回 ACQUIRE_REPLACE_NEEDED,不扣费', () => {
    const world = new World(4);
    world.refitPending = true;
    world.shopWeapons.push(TOWER_AUTOCANNON);
    world.starCoins = 999;
    world.weapons[0]!.type = TOWER_AUTOCANNON;
    world.weapons[0]!.stars = 1;
    for (let i = 1; i < 8; i++) {
      world.weapons[i]!.type = TOWER_LASER;
      world.weapons[i]!.stars = 1;
    }
    expect(world.buyShopWeapon(0)).toBe(ACQUIRE_REPLACE_NEEDED);
    expect(world.starCoins).toBe(999);
    expect(world.shopWeapons[0]).toBe(TOWER_AUTOCANNON);
  });
});
