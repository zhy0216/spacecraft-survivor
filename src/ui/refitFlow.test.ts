import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DOCK_EDICT_COUNT,
  DOCK_EDICT_PRICE,
  DOCK_REPAIR_FRACTION,
  DOCK_REPAIR_PRICE,
  DOCK_SHOP_REFRESH_PRICE,
  DOCK_WEAPON_COUNT,
  DOCK_WEAPON_PRICE,
  shopDiscountPrice,
} from '../data/economy';
import {
  createEdictLevels,
  EDICT_AMMO,
  EDICT_ARMOR,
  EDICT_COOLANT,
  EDICT_CRUISE,
  EDICT_GYRO,
  EDICT_MAGNET,
  EDICT_OVERDRIVE,
  EDICTS,
} from '../data/edicts';
import {
  TOWER_AUTOCANNON,
  TOWER_LASER,
  TOWER_RAILGUN,
  TOWERS,
} from '../data/towers';
import { createWeaponSlots, type WeaponSlot } from '../sim/armory';
import { createEdictBuffs, type EdictBuffs } from '../sim/edictBuffs';
import {
  ACQUIRE_REPLACE_NEEDED,
  DOCK_EDICT_SOLD,
  DOCK_HP_FULL,
  DOCK_NO_STARCOINS,
  REFIT_NOT_ACTIVE,
  SHOP_NO_REFRESH_STARCOINS,
  SHOP_NO_STARCOINS,
  SHOP_WEAPON_SOLD,
  type World,
} from '../sim/world';
import { createRefitFlow, dockEdictEffect, refitDenyMessage } from './refitFlow';

describe('整备面板纯文案', () => {
  it('商店相关拒绝码都有明确原因', () => {
    const codes = [
      ACQUIRE_REPLACE_NEEDED,
      SHOP_WEAPON_SOLD,
      SHOP_NO_STARCOINS,
      SHOP_NO_REFRESH_STARCOINS,
      DOCK_EDICT_SOLD,
      DOCK_NO_STARCOINS,
      DOCK_HP_FULL,
      REFIT_NOT_ACTIVE,
    ];
    for (const code of codes) {
      const text = refitDenyMessage(code);
      expect(text.length).toBeGreaterThan(4);
      expect(text).not.toContain('理由码');
    }
  });

  it('未知拒绝码回落为带原码的兜底文案', () => {
    expect(refitDenyMessage(-999)).toContain('-999');
  });

  it('法令效果文案逐项取自数值表(与升级三选一同一份 edictDesc,两处不许各念各的)', () => {
    // 系限定法令前缀 = 系名;全船法令前缀 = 「全船」
    expect(dockEdictEffect(EDICT_AMMO)).toBe('弹药系 射速 ×1.25 / 装填 ×0.7');
    expect(dockEdictEffect(EDICT_COOLANT)).toBe('过热系 热上限 ×1.25'); // 27 号压档:1.5 → 1.25
    expect(dockEdictEffect(EDICT_ARMOR)).toBe('全船 · 船体 HP +15 · 受击 ×0.8');
    expect(dockEdictEffect(EDICT_GYRO)).toBe('全船 · 转向 +10°/s');
    expect(dockEdictEffect(EDICT_MAGNET)).toBe('全船 · 磁吸半径 ×1.3');
    expect(dockEdictEffect(EDICT_CRUISE)).toBe('全船 · 巡航速度 ×1.1');
    expect(dockEdictEffect(EDICT_OVERDRIVE)).toBe('全船 · 全武器伤害 ×1.15');
    expect(dockEdictEffect(999)).toBe('未知法令');
  });
});

interface StubEvent {
  preventDefault(): void;
}

interface StubEl {
  style: Record<string, string>;
  textContent: string;
  innerHTML: string;
  disabled: boolean;
  children: StubEl[];
  handlers: Map<string, Array<(event: StubEvent) => void>>;
  append(...children: StubEl[]): void;
  appendChild(child: StubEl): StubEl;
  addEventListener(type: string, handler: (event: StubEvent) => void): void;
}

function createStubEl(): StubEl {
  const element: StubEl = {
    style: {},
    textContent: '',
    innerHTML: '',
    disabled: false,
    children: [],
    handlers: new Map(),
    append(...children): void { element.children.push(...children); },
    appendChild(child): StubEl { element.children.push(child); return child; },
    addEventListener(type, handler): void {
      const handlers = element.handlers.get(type) ?? [];
      handlers.push(handler);
      element.handlers.set(type, handlers);
    },
  };
  return element;
}

function fire(element: StubEl, type: string): void {
  const event: StubEvent = { preventDefault: () => {} };
  for (const handler of element.handlers.get(type) ?? []) handler(event);
}

interface StubDom {
  ui: StubEl;
  timers: Map<number, () => void>;
  restore(): void;
}

function installDom(): StubDom {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previousWindow = globals.window;
  const previousDocument = globals.document;
  let nextTimer = 1;
  const dom: StubDom = {
    ui: createStubEl(),
    timers: new Map(),
    restore(): void {
      globals.window = previousWindow;
      globals.document = previousDocument;
    },
  };
  globals.window = {
    setTimeout(handler: () => void): number {
      const id = nextTimer++;
      dom.timers.set(id, handler);
      return id;
    },
    clearTimeout(id: number): void { dom.timers.delete(id); },
  };
  globals.document = {
    createElement: (): StubEl => createStubEl(),
    getElementById: (id: string): StubEl | null => id === 'ui' ? dom.ui : null,
  };
  return dom;
}

interface StubWorld {
  refitPending: boolean;
  starCoins: number;
  ship: { hp: number; maxHp: number };
  shopWeapons: number[];
  dockEdictOffers: number[];
  shopDiscountIndex: number;
  weapons: WeaponSlot[];
  edictLevels: number[];
  buffs: EdictBuffs;
  weaponCalls: Array<[number, number | undefined]>;
  weaponCode: number;
  replaceNeeded: boolean;
  refreshCalls: number;
  refreshCode: number;
  edictCalls: number[];
  edictCode: number;
  repairCalls: number;
  repairCode: number;
  completeCalls: number;
  completeOk: boolean;
  buyShopWeapon(index: number, slotIndex?: number): number;
  refreshShop(): number;
  buyDockEdict(index: number): number;
  buyDockRepair(): number;
  completeRefit(): boolean;
}

function createStubWorld(): StubWorld {
  const world: StubWorld = {
    refitPending: true,
    starCoins: 100,
    ship: { hp: 60, maxHp: 100 },
    shopWeapons: [TOWER_AUTOCANNON, -1],
    dockEdictOffers: [EDICT_AMMO, EDICT_GYRO],
    shopDiscountIndex: -1,
    weapons: createWeaponSlots(),
    edictLevels: createEdictLevels(),
    buffs: createEdictBuffs(),
    weaponCalls: [],
    weaponCode: 0,
    replaceNeeded: false,
    refreshCalls: 0,
    refreshCode: 0,
    edictCalls: [],
    edictCode: 0,
    repairCalls: 0,
    repairCode: 0,
    completeCalls: 0,
    completeOk: true,
    buyShopWeapon(index, slotIndex): number {
      world.weaponCalls.push([index, slotIndex]);
      if (world.replaceNeeded && slotIndex === undefined) return ACQUIRE_REPLACE_NEEDED;
      if (world.weaponCode < 0) return world.weaponCode;
      world.starCoins -= DOCK_WEAPON_PRICE;
      world.shopWeapons[index] = -1;
      return world.weaponCode;
    },
    refreshShop(): number {
      world.refreshCalls++;
      if (world.refreshCode < 0) return world.refreshCode;
      world.starCoins -= DOCK_SHOP_REFRESH_PRICE;
      return world.refreshCode;
    },
    buyDockEdict(index): number {
      world.edictCalls.push(index);
      if (world.edictCode < 0) return world.edictCode;
      world.starCoins -= DOCK_EDICT_PRICE;
      world.dockEdictOffers[index] = -1;
      return world.edictCode;
    },
    buyDockRepair(): number {
      world.repairCalls++;
      if (world.repairCode < 0) return world.repairCode;
      world.starCoins -= DOCK_REPAIR_PRICE;
      world.ship.hp = Math.min(world.ship.maxHp, world.ship.hp + Math.ceil(world.ship.maxHp * DOCK_REPAIR_FRACTION));
      return world.repairCode;
    },
    completeRefit(): boolean { world.completeCalls++; return world.completeOk; },
  };
  return world;
}

function worldAsWorld(world: StubWorld): World {
  return world as unknown as World;
}

const rootOf = (dom: StubDom): StubEl => dom.ui.children[0] as StubEl;
const toastOf = (dom: StubDom): StubEl => dom.ui.children[1] as StubEl;
/** 商店的星币金(refitFlow 的 STAR_COLOR):特价文案按它上色,HUD 星币读数同款 */
const STAR_GOLD = '#ffd86e';
const shopOf = (dom: StubDom): StubEl => rootOf(dom).children[0] as StubEl;
const shopHeadOf = (dom: StubDom): StubEl => shopOf(dom).children[0] as StubEl;
const segmentOf = (dom: StubDom): StubEl => shopOf(dom).children[1] as StubEl;
const weaponSectionOf = (dom: StubDom): StubEl => shopOf(dom).children[2] as StubEl;
const weaponHeadOf = (dom: StubDom): StubEl => weaponSectionOf(dom).children[0] as StubEl;
const refreshOf = (dom: StubDom): StubEl => weaponHeadOf(dom).children[1] as StubEl;
const cardsOf = (dom: StubDom): StubEl => weaponSectionOf(dom).children[1] as StubEl;
const pickerOf = (dom: StubDom): StubEl => weaponSectionOf(dom).children[2] as StubEl;
const starSectionOf = (dom: StubDom): StubEl => shopOf(dom).children[3] as StubEl;
const edictOf = (dom: StubDom, index: number): StubEl => starSectionOf(dom).children[index + 1] as StubEl;
const repairOf = (dom: StubDom): StubEl => starSectionOf(dom).children[DOCK_EDICT_COUNT + 1] as StubEl;
const finishOf = (dom: StubDom): StubEl => shopOf(dom).children[4] as StubEl;
// 舰船图:root 的第二个孩子是它的容器(shop 仍是第一个),里头是 shipDiagram.root
const boardOf = (dom: StubDom): StubEl => (rootOf(dom).children[1] as StubEl).children[0] as StubEl;
const headOf = (dom: StubDom): StubEl => boardOf(dom).children[0] as StubEl;
const ringOf = (dom: StubDom): StubEl => boardOf(dom).children[2] as StubEl;
const edictWrapOf = (dom: StubDom): StubEl => (boardOf(dom).children[3] as StubEl).children[1] as StubEl;
/**
 * 槽位卡片层永远是环里**最后挂的一层**(后挂 = 盖在扇形与船体上,卡片才点得到),
 * 层内下标即槽位编号。照这条契约取,而不是数"前面有几枚扇形几层船体" ——
 * 后者会随任何一次装饰改动错位,而错位的症状是点到了别的槽(看着像换错了武器)
 */
const chipLayerOf = (dom: StubDom): StubEl =>
  ringOf(dom).children[ringOf(dom).children.length - 1] as StubEl;
const chipOf = (dom: StubDom, slot: number): StubEl => chipLayerOf(dom).children[slot] as StubEl;

describe('createRefitFlow 纯商店流程', () => {
  let dom: StubDom;
  let world: StubWorld;
  let resolved: number;

  function setup(): ReturnType<typeof createRefitFlow> {
    const flow = createRefitFlow({ world: worldAsWorld(world), onResolved: () => { resolved++; } });
    flow.show(1);
    return flow;
  }

  beforeEach(() => {
    dom = installDom();
    world = createStubWorld();
    resolved = 0;
  });

  afterEach(() => dom.restore());

  it('show 显示航段与固定数量武器卡;店头不再印星币余额(余额在左上统计版,HUD 那侧)', () => {
    setup();
    expect(segmentOf(dom).textContent).toContain('航段 2');
    // 店头只剩标题一格:余额读数搬去 HUD 左列,商店里不印(商店优化)
    expect(shopHeadOf(dom).children.length).toBe(1);
    expect((shopHeadOf(dom).children[0] as StubEl).children[0]?.textContent).toBe('DOCK SUPPLY');
    expect((shopHeadOf(dom).children[0] as StubEl).children[1]?.textContent).toBe('舰装商店');
    expect(cardsOf(dom).children.length).toBe(DOCK_WEAPON_COUNT);
  });

  it('特价武器卡:原价划线、特价亮金,标"特价";非特价格照旧原价', () => {
    world.shopDiscountIndex = DOCK_EDICT_COUNT + 0; // 武器货架第 0 格打特价
    setup();
    const card = cardsOf(dom).children[0] as StubEl;
    expect(card.innerHTML).toContain('特价');
    expect(card.innerHTML).toContain('<s'); // 原价划线
    expect(card.innerHTML).toContain(`${DOCK_WEAPON_PRICE} ★`);
    expect(card.innerHTML).toContain(`${shopDiscountPrice(DOCK_WEAPON_PRICE)} ★`);
    expect(card.innerHTML).toContain(STAR_GOLD); // 特价与星币同款金色
    // 第 1 格不是特价:照旧印原价、不划线
    world.shopWeapons[1] = TOWER_LASER;
    fire(refreshOf(dom), 'click');
    const full = cardsOf(dom).children[1] as StubEl;
    expect(full.innerHTML).toContain(`${DOCK_WEAPON_PRICE} ★`);
    expect(full.innerHTML).not.toContain('<s>');
  });

  it('特价法令行:原价划线、特价亮金', () => {
    world.shopDiscountIndex = 0; // 法令货架第 0 格打特价
    setup();
    const row = edictOf(dom, 0);
    expect(row.innerHTML).toContain('特价');
    expect(row.innerHTML).toContain('<s');
    expect(row.innerHTML).toContain(`${DOCK_EDICT_PRICE} ★`);
    expect(row.innerHTML).toContain(`${shopDiscountPrice(DOCK_EDICT_PRICE)} ★`);
    expect(row.innerHTML).toContain(STAR_GOLD);
  });

  it('武器卡来自 shopWeapons，显示名称与 30 星币价格，售出卡置灰', () => {
    setup();
    expect((cardsOf(dom).children[0] as StubEl).innerHTML).toContain(TOWERS[TOWER_AUTOCANNON]?.name);
    expect((cardsOf(dom).children[0] as StubEl).innerHTML).toContain(`${DOCK_WEAPON_PRICE} ★`);
    expect((cardsOf(dom).children[1] as StubEl).innerHTML).toContain('已售出');
    expect((cardsOf(dom).children[1] as StubEl).disabled).toBe(true);
  });

  it('购买武器把货架下标交给 World，成功后下架并刷新余额', () => {
    setup();
    fire(cardsOf(dom).children[0] as StubEl, 'click');
    expect(world.weaponCalls).toEqual([[0, undefined]]);
    expect(world.starCoins).toBe(100 - DOCK_WEAPON_PRICE);
    expect((cardsOf(dom).children[0] as StubEl).disabled).toBe(true);
    expect((cardsOf(dom).children[0] as StubEl).innerHTML).toContain('已售出');
    expect(toastOf(dom).textContent).toContain(TOWERS[TOWER_AUTOCANNON]?.name);
  });

  it('槽满时打开替换选择器，再以同一货架位和所选槽位购买', () => {
    world.replaceNeeded = true;
    for (let index = 0; index < world.weapons.length; index++) {
      const slot = world.weapons[index];
      if (!slot) continue;
      slot.type = index === 2 ? TOWER_RAILGUN : TOWER_AUTOCANNON;
      slot.stars = index + 1;
    }
    setup();
    fire(cardsOf(dom).children[0] as StubEl, 'click');
    expect(world.weaponCalls).toEqual([[0, undefined]]);
    expect(cardsOf(dom).style.display).toBe('none');
    expect(pickerOf(dom).style.display).toBe('flex');
    // 提示指到左边那张船图上,槽位读数也在那儿(第 2 槽 = 正右的磁轨炮 ★★★)
    expect((pickerOf(dom).children[1] as StubEl).textContent).toContain(TOWERS[TOWER_AUTOCANNON]?.name);
    expect(chipOf(dom, 2).innerHTML).toContain('正右');
    expect(chipOf(dom, 2).innerHTML).toContain('★★★');
    fire(chipOf(dom, 2), 'click');
    expect(world.weaponCalls).toEqual([[0, undefined], [0, 2]]);
    expect(world.starCoins).toBe(100 - DOCK_WEAPON_PRICE);
    expect(pickerOf(dom).style.display).toBe('none');
  });

  it('取消替换不扣费、不下架', () => {
    world.replaceNeeded = true;
    world.weapons[0] = { ...world.weapons[0] as WeaponSlot, type: TOWER_AUTOCANNON, stars: 1 };
    setup();
    fire(cardsOf(dom).children[0] as StubEl, 'click');
    fire(pickerOf(dom).children[WEAPON_PICKER_CANCEL_INDEX] as StubEl, 'click');
    expect(world.starCoins).toBe(100);
    expect(world.shopWeapons[0]).toBe(TOWER_AUTOCANNON);
    expect(cardsOf(dom).style.display).toBe('grid');
  });

  it('刷新按钮显示 10 星币价格并调用 refreshShop', () => {
    setup();
    expect(refreshOf(dom).textContent).toContain(String(DOCK_SHOP_REFRESH_PRICE));
    expect(refreshOf(dom).disabled).toBe(false);
    fire(refreshOf(dom), 'click');
    expect(world.refreshCalls).toBe(1);
    expect(world.starCoins).toBe(100 - DOCK_SHOP_REFRESH_PRICE);
    expect(toastOf(dom).textContent).toContain('已刷新');
  });

  it('刷新失败显示对应拒绝原因', () => {
    world.refreshCode = SHOP_NO_REFRESH_STARCOINS;
    setup();
    fire(refreshOf(dom), 'click');
    expect(toastOf(dom).textContent).toBe(refitDenyMessage(SHOP_NO_REFRESH_STARCOINS));
  });

  it('法令行显示名称、效果与 25 星币价格，购买后下架', () => {
    setup();
    expect(edictOf(dom, 0).innerHTML).toContain(EDICTS[EDICT_AMMO]!.name);
    expect(edictOf(dom, 0).innerHTML).toContain(dockEdictEffect(EDICT_AMMO));
    expect(edictOf(dom, 0).innerHTML).toContain(`${DOCK_EDICT_PRICE} ★`);
    fire(edictOf(dom, 0), 'click');
    expect(world.edictCalls).toEqual([0]);
    expect(edictOf(dom, 0).disabled).toBe(true);
    expect(edictOf(dom, 0).innerHTML).toContain('已售出');
  });

  it('修复按钮在满血时禁用，残血时调用 buyDockRepair', () => {
    world.ship.hp = world.ship.maxHp;
    const flow = setup();
    expect(repairOf(dom).disabled).toBe(true);
    fire(repairOf(dom), 'click');
    expect(world.repairCalls).toBe(0);
    world.ship.hp = 60;
    flow.show(1);
    expect(repairOf(dom).disabled).toBe(false);
    fire(repairOf(dom), 'click');
    expect(world.repairCalls).toBe(1);
    expect(world.ship.hp).toBe(100);
    expect(repairOf(dom).disabled).toBe(true);
  });

  it('左侧画出整条船：每格印朝向，已装的印名称星级与系、没装的印空槽，船体读数取自 world.ship', () => {
    world.weapons[0]!.type = TOWER_LASER;
    world.weapons[0]!.stars = 2;
    setup();
    expect(chipOf(dom, 0).innerHTML).toContain('正前');
    expect(chipOf(dom, 0).innerHTML).toContain(TOWERS[TOWER_LASER]?.name);
    expect(chipOf(dom, 0).innerHTML).toContain('★★');
    expect(chipOf(dom, 0).innerHTML).toContain('过热系'); // 舰船图上的武器格也标系
    expect(chipOf(dom, 1).innerHTML).toContain('右前');
    expect(chipOf(dom, 1).innerHTML).toContain('空槽');
    expect((headOf(dom).children[1] as StubEl).innerHTML).toContain('60/100');
  });

  it('悬停货架卡把武器虚装到第一个空槽上，移开还原；预览一次都不碰世界', () => {
    world.weapons[0]!.type = TOWER_LASER;
    world.weapons[0]!.stars = 1;
    setup();
    fire(cardsOf(dom).children[0] as StubEl, 'mouseenter');
    expect(chipOf(dom, 1).innerHTML).toContain(TOWERS[TOWER_AUTOCANNON]?.name);
    expect(chipOf(dom, 0).innerHTML).not.toContain(TOWERS[TOWER_AUTOCANNON]?.name);
    expect(world.weaponCalls).toEqual([]);
    expect(world.starCoins).toBe(100);
    fire(cardsOf(dom).children[0] as StubEl, 'mouseleave');
    expect(chipOf(dom, 1).innerHTML).toContain('空槽');
  });

  it('替换态里悬停一个槽，就地演示「换下谁、换成谁」', () => {
    world.replaceNeeded = true;
    for (const slot of world.weapons) {
      slot.type = TOWER_RAILGUN;
      slot.stars = 4;
    }
    setup();
    fire(cardsOf(dom).children[0] as StubEl, 'click');
    fire(chipOf(dom, 5), 'mouseenter');
    expect(chipOf(dom, 5).innerHTML).toContain('line-through');
    expect(chipOf(dom, 5).innerHTML).toContain(TOWERS[TOWER_RAILGUN]?.name);
    expect(chipOf(dom, 5).innerHTML).toContain(TOWERS[TOWER_AUTOCANNON]?.name);
    expect(chipOf(dom, 4).innerHTML).not.toContain(TOWERS[TOWER_AUTOCANNON]?.name);
  });

  it('替换态点到空槽不成交（真 DOM 靠 disabled 拦，这里是防桩）', () => {
    world.replaceNeeded = true;
    world.weapons[0]!.type = TOWER_AUTOCANNON;
    world.weapons[0]!.stars = 1;
    setup();
    fire(cardsOf(dom).children[0] as StubEl, 'click');
    fire(chipOf(dom, 1), 'click');
    expect(world.weaponCalls).toEqual([[0, undefined]]);
    expect(world.starCoins).toBe(100);
    fire(chipOf(dom, 0), 'click');
    expect(world.weaponCalls).toEqual([[0, undefined], [0, 0]]);
  });

  it('法令按层数印在船图上，一条都没有时明说', () => {
    setup();
    expect(edictWrapOf(dom).innerHTML).toContain('尚未持有');
    world.edictLevels[EDICT_MAGNET] = 2;
    world.edictLevels[EDICT_ARMOR] = 1;
    fire(repairOf(dom), 'click'); // 任一次购买都会重画左侧
    expect(edictWrapOf(dom).innerHTML).toContain(`${EDICTS[EDICT_MAGNET]!.name} ×2`);
    expect(edictWrapOf(dom).innerHTML).toContain(`${EDICTS[EDICT_ARMOR]!.name} ×1`);
  });

  it('武器卡印出数值与系名、同型照报落位方向,同星把数凑到 2 时预说当场合成', () => {
    world.weapons[0]!.type = TOWER_AUTOCANNON;
    world.weapons[0]!.stars = 1;
    world.weapons[1]!.type = TOWER_AUTOCANNON;
    world.weapons[1]!.stars = 1;
    setup();
    const card = cardsOf(dom).children[0] as StubEl;
    expect(card.innerHTML).toContain('射程');
    expect(card.innerHTML).toContain('/s');
    expect(card.innerHTML).toContain('弹药系'); // 商店武器卡标好所属系
    // 2× ★ 同型:报同星把数、照报落位方向(同型也占槽),并预说买下当场合 ★★
    expect(card.innerHTML).toContain('已有 ★ ×2');
    expect(card.innerHTML).toContain('买下合成 ★★');
    expect(card.innerHTML).toContain('装到');
    // 未拥有那一档:清空同型后重画,报「入手 ★」+ 落位方向
    world.weapons[0]!.type = -1;
    world.weapons[0]!.stars = 0;
    world.weapons[1]!.type = -1;
    world.weapons[1]!.stars = 0;
    fire(refreshOf(dom), 'click');
    const fresh = cardsOf(dom).children[0] as StubEl;
    expect(fresh.innerHTML).toContain('入手 ★');
    expect(fresh.innerHTML).toContain('装到「正前」'); // 全空，第一个空槽是槽 0
  });

  it('完成整备调用 completeRefit，成功才回调', () => {
    setup();
    fire(finishOf(dom), 'click');
    expect(world.completeCalls).toBe(1);
    expect(resolved).toBe(1);
    expect(rootOf(dom).style.display).toBe('none');
  });

  it('没有待整备时直接放行，setWorld 后操作落到新世界', () => {
    world.refitPending = false;
    const flow = createRefitFlow({ world: worldAsWorld(world), onResolved: () => { resolved++; } });
    flow.show(1);
    expect(resolved).toBe(1);
    const next = createStubWorld();
    flow.setWorld(worldAsWorld(next));
    flow.show(0);
    fire(cardsOf(dom).children[0] as StubEl, 'click');
    expect(next.weaponCalls).toEqual([[0, undefined]]);
    expect(world.weaponCalls).toEqual([]);
  });
});

// 替换层 = 标题 + 一行提示 + 一颗取消(槽位不在侧栏列,选槽整个搬到左侧舰船图上)
const WEAPON_PICKER_CANCEL_INDEX = 2;
