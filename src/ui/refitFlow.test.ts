import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DOCK_EDICT_COUNT,
  DOCK_EDICT_PRICE,
  DOCK_REPAIR_FRACTION,
  DOCK_REPAIR_PRICE,
  DOCK_SHOP_REFRESH_PRICE,
  DOCK_WEAPON_COUNT,
  DOCK_WEAPON_PRICE,
} from '../data/economy';
import { EDICT_COOLANT, EDICT_CRUISE, EDICT_GYRO, EDICT_HULL, EDICT_MAGNET, EDICT_RAPID, EDICT_TRACER, EDICTS } from '../data/edicts';
import { TOWER_AUTOCANNON, TOWER_LASER, TOWER_RAILGUN, TOWERS } from '../data/towers';
import { createWeaponSlots, type WeaponSlot } from '../sim/armory';
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

  it('法令效果文案逐项取自数值表', () => {
    expect(dockEdictEffect(EDICT_TRACER)).toBe('弹药射速 ×1.1');
    expect(dockEdictEffect(EDICT_GYRO)).toBe('转向 +10°/s');
    expect(dockEdictEffect(EDICT_MAGNET)).toBe('拾取半径 ×1.3');
    expect(dockEdictEffect(EDICT_COOLANT)).toBe('过热上限 ×1.2');
    expect(dockEdictEffect(EDICT_HULL)).toBe('船体 HP +20');
    expect(dockEdictEffect(EDICT_CRUISE)).toBe('巡航速度 ×1.1');
    expect(dockEdictEffect(EDICT_RAPID)).toBe('弹药射速 ×1.25');
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
  weapons: WeaponSlot[];
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
    dockEdictOffers: [EDICT_TRACER, EDICT_GYRO],
    weapons: createWeaponSlots(),
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

  it('show 显示航段、星币余额和固定数量武器卡', () => {
    setup();
    expect(segmentOf(dom).textContent).toContain('航段 2');
    expect(shopHeadOf(dom).children[1]?.textContent).toBe('★ 100');
    expect(cardsOf(dom).children.length).toBe(DOCK_WEAPON_COUNT);
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
      slot.level = index + 1;
    }
    setup();
    fire(cardsOf(dom).children[0] as StubEl, 'click');
    expect(world.weaponCalls).toEqual([[0, undefined]]);
    expect(cardsOf(dom).style.display).toBe('none');
    expect(pickerOf(dom).style.display).toBe('flex');
    expect((pickerOf(dom).children[3] as StubEl).innerHTML).toContain('Lv3');
    fire(pickerOf(dom).children[3] as StubEl, 'click');
    expect(world.weaponCalls).toEqual([[0, undefined], [0, 2]]);
    expect(world.starCoins).toBe(100 - DOCK_WEAPON_PRICE);
    expect(pickerOf(dom).style.display).toBe('none');
  });

  it('取消替换不扣费、不下架', () => {
    world.replaceNeeded = true;
    world.weapons[0] = { ...world.weapons[0] as WeaponSlot, type: TOWER_AUTOCANNON, level: 1 };
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
    expect(edictOf(dom, 0).innerHTML).toContain(EDICTS[EDICT_TRACER]?.name);
    expect(edictOf(dom, 0).innerHTML).toContain(dockEdictEffect(EDICT_TRACER));
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

const WEAPON_PICKER_CANCEL_INDEX = 1 + 4;
