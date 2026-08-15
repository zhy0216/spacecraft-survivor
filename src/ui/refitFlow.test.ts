import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DOCK_EDICT_COUNT,
  DOCK_EDICT_PRICE,
  DOCK_REPAIR_HP,
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
} from '../data/edicts';
import {
  TOWER_AUTOCANNON,
  TOWER_LASER,
  TOWER_RAILGUN,
} from '../data/towers';
import { mergeResultOf } from '../data/merges';
import { createWeaponSlots, type WeaponSlot } from '../sim/armory';
import { createEdictBuffs, type EdictBuffs } from '../sim/edictBuffs';
import { WAVE_SEGMENTS } from '../data/waves';
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
import { initI18n } from '../i18n';
import { edictName, towerName } from './presentation/contentText';

beforeEach(async () => {
  await initI18n('zh-CN');
});

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
  tagName: string;
  src: string;
  alt: string;
  style: Record<string, string>;
  textContent: string;
  innerHTML: string;
  disabled: boolean;
  children: StubEl[];
  handlers: Map<string, Array<(event: StubEvent) => void>>;
  append(...children: StubEl[]): void;
  appendChild(child: StubEl): StubEl;
  replaceChildren(): void;
  addEventListener(type: string, handler: (event: StubEvent) => void): void;
}

function createStubEl(tagName = 'div'): StubEl {
  const element: StubEl = {
    tagName: tagName.toUpperCase(),
    src: '',
    alt: '',
    style: {},
    textContent: '',
    innerHTML: '',
    disabled: false,
    children: [],
    handlers: new Map(),
    append(...children): void { element.children.push(...children); },
    appendChild(child): StubEl { element.children.push(child); return child; },
    replaceChildren(): void { element.children = []; },
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
    createElement: (tagName: string): StubEl => createStubEl(tagName),
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

/**
 * 桩版三合一:3× N★ → 1× (N+1)★;N=2 且有配方 → 当场变身为合成武器。只补足回执要读的
 * 槽位账本(与 World.fuseTriplesOf 同一条形状,能覆盖「合到 ★★ / 合 ★★★ 变身」两档)。
 */
function fuseStubWeapons(world: StubWorld, type: number): void {
  for (let star = 1; star < 3; star++) {
    for (;;) {
      const slots = world.weapons.filter((s) => s && s.type === type && s.stars === star);
      if (slots.length < 3) break;
      let removed = 0;
      for (const s of world.weapons) {
        if (removed >= 3) break;
        if (s && s.type === type && s.stars === star) {
          s.type = -1;
          s.stars = 0;
          removed++;
        }
      }
      const result = star === 2 ? mergeResultOf(type) : -1;
      const target = world.weapons.find((s) => !s || s.type < 0) ?? world.weapons[0];
      if (target) {
        target.type = result >= 0 ? result : type;
        target.stars = star + 1;
      }
    }
  }
}

/** 桩版落位:给 slotIndex = 换装(占着格直接换),否则落第一个空槽;随后跑一轮三合一 */
function acquireStubWeapon(world: StubWorld, type: number, slotIndex?: number): void {
  if (slotIndex !== undefined && slotIndex >= 0) {
    const slot = world.weapons[slotIndex];
    if (slot && slot.type >= 0) {
      slot.type = type;
      slot.stars = 1;
    }
  } else {
    const empty = world.weapons.findIndex((s) => !s || s.type < 0);
    if (empty >= 0) {
      const s = world.weapons[empty]!;
      s.type = type;
      s.stars = 1;
    }
  }
  fuseStubWeapons(world, type);
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
      const type = world.shopWeapons[index];
      world.starCoins -= DOCK_WEAPON_PRICE;
      world.shopWeapons[index] = -1;
      if (type !== undefined && type >= 0) acquireStubWeapon(world, type, slotIndex);
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
      world.ship.hp = Math.min(world.ship.maxHp, world.ship.hp + DOCK_REPAIR_HP);
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
const edictCardsOf = (dom: StubDom): StubEl => starSectionOf(dom).children[1] as StubEl;
const edictOf = (dom: StubDom, index: number): StubEl => edictCardsOf(dom).children[index] as StubEl;
const repairOf = (dom: StubDom): StubEl => starSectionOf(dom).children[2] as StubEl;
const finishOf = (dom: StubDom): StubEl => shopOf(dom).children[4] as StubEl;
// 舰船图:root 的第二个孩子是它的容器(shop 仍是第一个),里头是 shipDiagram.root
const boardWrapOf = (dom: StubDom): StubEl => rootOf(dom).children[1] as StubEl;
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
// 环里最后一层是卡片、倒数第二层是炮位贴图层,再往前一层才是舰壳图(两层叠放保证可点)
const hullArtOf = (dom: StubDom): StubEl => ringOf(dom).children[ringOf(dom).children.length - 3] as StubEl;
const tooltipOf = (dom: StubDom): StubEl => rootOf(dom).children[2] as StubEl;

/** 在桩树里找包含某段文字的节点(桩的 textContent 不聚合子节点,要递归拼) */
function findText(root: StubEl, part: string): boolean {
  if (root.textContent.includes(part)) return true;
  for (const child of root.children) {
    if (findText(child, part)) return true;
  }
  return false;
}

/** 在桩树里找 style 含某段文字的节点(打折的 line-through 与星币金色都画在子节点上) */
function findStyle(root: StubEl, part: string): boolean {
  for (const value of Object.values(root.style)) {
    if (typeof value === 'string' && value.includes(part)) return true;
  }
  for (const child of root.children) {
    if (findStyle(child, part)) return true;
  }
  return false;
}

/** 在桩树里找 src 含某段文字的 IMG 节点(货架配图 img 单独管理,不再是 innerHTML 字符串) */
function findImgSrc(root: StubEl, part: string): boolean {
  if (root.tagName === 'IMG' && root.src.includes(part)) return true;
  for (const child of root.children) {
    if (findImgSrc(child, part)) return true;
  }
  return false;
}

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

  it('舰船背包相对整屏居中，与右侧货架交叠时货架仍在上层', () => {
    setup();
    expect(rootOf(dom).style.cssText).toContain('transparent 360px');
    expect(boardWrapOf(dom).style.cssText).toContain('inset:0');
    expect(boardWrapOf(dom).style.cssText).not.toContain('right:340px');
    expect(boardWrapOf(dom).style.cssText).toContain('z-index:1');
    expect(shopOf(dom).style.cssText).toContain('z-index:2');
  });

  it('最后一跨(Boss 登场那一跨)的越界段下标:标题不印"航段 5",改拟决战字样', () => {
    const flow = createRefitFlow({ world: worldAsWorld(world), onResolved: () => {} });
    flow.show(WAVE_SEGMENTS.length); // 越界哨兵:脚本走完那一跨的信标
    expect(segmentOf(dom).textContent).toContain('决战在即');
    expect(segmentOf(dom).textContent).not.toContain(`航段 ${WAVE_SEGMENTS.length + 1}`);
  });

  it('特价武器卡:原价划线、特价亮金,标"特价";非特价格照旧原价', () => {
    world.shopDiscountIndex = DOCK_EDICT_COUNT + 0; // 武器货架第 0 格打特价
    setup();
    const card = cardsOf(dom).children[0] as StubEl;
    // 价格是独立节点(textContent + 行内含样式),不再拼 innerHTML
    expect(findText(card, '特价')).toBe(true);
    expect(findStyle(card, 'line-through')).toBe(true); // 原价划线
    expect(findText(card, `${DOCK_WEAPON_PRICE} ★`)).toBe(true);
    expect(findText(card, `${shopDiscountPrice(DOCK_WEAPON_PRICE)} ★`)).toBe(true);
    expect(findStyle(card, STAR_GOLD)).toBe(true); // 特价与星币同款金色
    // 第 1 格不是特价:照旧印原价、不划线
    world.shopWeapons[1] = TOWER_LASER;
    fire(refreshOf(dom), 'click');
    const full = cardsOf(dom).children[1] as StubEl;
    expect(findText(full, `${DOCK_WEAPON_PRICE} ★`)).toBe(true);
    expect(findStyle(full, 'line-through')).toBe(false);
  });

  it('特价法令行:原价划线、特价亮金', () => {
    world.shopDiscountIndex = 0; // 法令货架第 0 格打特价
    setup();
    const row = edictOf(dom, 0);
    expect(findText(row, '特价')).toBe(true);
    expect(findStyle(row, 'line-through')).toBe(true);
    expect(findText(row, `${DOCK_EDICT_PRICE} ★`)).toBe(true);
    expect(findText(row, `${shopDiscountPrice(DOCK_EDICT_PRICE)} ★`)).toBe(true);
    expect(findStyle(row, STAR_GOLD)).toBe(true);
  });

  it('武器卡来自 shopWeapons，显示名称与 30 星币价格，售出卡置灰', () => {
    setup();
    expect(findText(cardsOf(dom).children[0] as StubEl, towerName(TOWER_AUTOCANNON))).toBe(true);
    expect(findText(cardsOf(dom).children[0] as StubEl, `${DOCK_WEAPON_PRICE} ★`)).toBe(true);
    expect(findText(cardsOf(dom).children[1] as StubEl, '已售出')).toBe(true);
    expect((cardsOf(dom).children[1] as StubEl).disabled).toBe(true);
  });

  it('购买武器把货架下标交给 World，成功后下架并刷新余额', () => {
    setup();
    fire(cardsOf(dom).children[0] as StubEl, 'click');
    expect(world.weaponCalls).toEqual([[0, undefined]]);
    expect(world.starCoins).toBe(100 - DOCK_WEAPON_PRICE);
    expect((cardsOf(dom).children[0] as StubEl).disabled).toBe(true);
    expect(findText(cardsOf(dom).children[0] as StubEl, '已售出')).toBe(true);
    expect(toastOf(dom).textContent).toContain(towerName(TOWER_AUTOCANNON));
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
    expect((pickerOf(dom).children[1] as StubEl).textContent).toContain(towerName(TOWER_AUTOCANNON));
    expect(findText(chipOf(dom, 2), '正右')).toBe(true);
    expect(findText(chipOf(dom, 2), '★★★')).toBe(true);
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

  it('法令卡显示图片、名称与 25 星币价格，悬停才显示效果，购买后下架', () => {
    setup();
    const card = edictOf(dom, 0);
    expect(findImgSrc(card, 'image/svg+xml')).toBe(true); // 法令配图 = 程序化 SVG 徽章,img 节点
    expect(findText(card, edictName(EDICT_AMMO))).toBe(true);
    expect(findText(card, dockEdictEffect(EDICT_AMMO))).toBe(false);
    expect(findText(card, `${DOCK_EDICT_PRICE} ★`)).toBe(true);
    fire(card, 'mouseenter');
    expect(tooltipOf(dom).textContent).toContain(dockEdictEffect(EDICT_AMMO).split(' ')[0]);
    expect(tooltipOf(dom).style.display).toBe('block');
    fire(card, 'mouseleave');
    expect(tooltipOf(dom).style.display).toBe('none');
    fire(card, 'click');
    expect(world.edictCalls).toEqual([0]);
    expect(card.disabled).toBe(true);
    expect(findText(card, '已售出')).toBe(true);
  });

  it('修复按钮在满血时禁用，残血时调用 buyDockRepair', () => {
    world.ship.hp = world.ship.maxHp;
    const flow = setup();
    expect(repairOf(dom).disabled).toBe(true);
    fire(repairOf(dom), 'click');
    expect(world.repairCalls).toBe(0);
    world.ship.hp = 70;
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
    expect(findText(chipOf(dom, 0), '正前')).toBe(true);
    expect(findText(chipOf(dom, 0), towerName(TOWER_LASER))).toBe(true);
    expect(findText(chipOf(dom, 0), '★★')).toBe(true);
    expect(findText(chipOf(dom, 0), '过热系')).toBe(true); // 舰船图上的武器格也标系
    expect(findText(chipOf(dom, 1), '右前')).toBe(true);
    expect(findText(chipOf(dom, 1), '空槽')).toBe(true);
    // 船体读数 = 读数区第一行的数值节点(标签与数值分节点,05 号起不再拼 innerHTML)
    expect(((headOf(dom).children[1] as StubEl).children[0] as StubEl).children[1]?.textContent).toContain('60/100');
    expect(((headOf(dom).children[0] as StubEl).children[1] as StubEl).textContent).toBe('舰船背包');
    expect(hullArtOf(dom).tagName).toBe('IMG');
    expect(hullArtOf(dom).src).toContain('scrapper-hull.png');
    expect(hullArtOf(dom).alt).toBe('完整飞船');
  });

  it('悬停货架卡把武器虚装到第一个空槽上，移开还原；预览一次都不碰世界', () => {
    world.weapons[0]!.type = TOWER_LASER;
    world.weapons[0]!.stars = 1;
    setup();
    fire(cardsOf(dom).children[0] as StubEl, 'mouseenter');
    expect(findText(chipOf(dom, 1), towerName(TOWER_AUTOCANNON))).toBe(true);
    expect(findText(chipOf(dom, 0), towerName(TOWER_AUTOCANNON))).toBe(false);
    expect(world.weaponCalls).toEqual([]);
    expect(world.starCoins).toBe(100);
    fire(cardsOf(dom).children[0] as StubEl, 'mouseleave');
    expect(findText(chipOf(dom, 1), '空槽')).toBe(true);
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
    expect(findStyle(chipOf(dom, 5), 'line-through')).toBe(true);
    expect(findText(chipOf(dom, 5), towerName(TOWER_RAILGUN))).toBe(true);
    expect(findText(chipOf(dom, 5), towerName(TOWER_AUTOCANNON))).toBe(true);
    expect(findText(chipOf(dom, 4), towerName(TOWER_AUTOCANNON))).toBe(false);
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
    expect(findText(edictWrapOf(dom), '尚未持有')).toBe(true);
    world.edictLevels[EDICT_MAGNET] = 2;
    world.edictLevels[EDICT_ARMOR] = 1;
    fire(repairOf(dom), 'click'); // 任一次购买都会重画左侧
    expect(findText(edictWrapOf(dom), `${edictName(EDICT_MAGNET)} ×2`)).toBe(true);
    expect(findText(edictWrapOf(dom), `${edictName(EDICT_ARMOR)} ×1`)).toBe(true);
  });

  it('武器卡只放图片/名称/价格，悬停说明数值、落位方向与当场合成', () => {
    world.weapons[0]!.type = TOWER_AUTOCANNON;
    world.weapons[0]!.stars = 1;
    world.weapons[1]!.type = TOWER_AUTOCANNON;
    world.weapons[1]!.stars = 1;
    setup();
    const card = cardsOf(dom).children[0] as StubEl;
    expect(findImgSrc(card, 'autocannon-head.png')).toBe(true); // 配图是独立 img 节点
    expect(findText(card, '射程')).toBe(false);
    fire(card, 'mouseenter');
    expect(tooltipOf(dom).textContent).toContain('射程');
    expect(tooltipOf(dom).textContent).toContain('/s');
    expect(tooltipOf(dom).textContent).toContain('弹药系');
    // 2× ★ 同型:报同星把数、照报落位方向(同型也占槽),并预说买下当场合 ★★
    expect(tooltipOf(dom).textContent).toContain('已有 ★ ×2');
    expect(tooltipOf(dom).textContent).toContain('买下合成 ★★');
    expect(tooltipOf(dom).textContent).toContain('装到');
    // 未拥有那一档:清空同型后重画,报「入手 ★」+ 落位方向
    world.weapons[0]!.type = -1;
    world.weapons[0]!.stars = 0;
    world.weapons[1]!.type = -1;
    world.weapons[1]!.stars = 0;
    fire(refreshOf(dom), 'click');
    const fresh = cardsOf(dom).children[0] as StubEl;
    fire(fresh, 'mouseenter');
    expect(tooltipOf(dom).textContent).toContain('入手 ★');
    expect(tooltipOf(dom).textContent).toContain('装到「正前」'); // 全空，第一个空槽是槽 0
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

  it('回执三档:入手新武器 / 三合一合到 ★★ / 连锁合到 ★★★ 变身,各说各的话', () => {
    setup();
    // 第一档:新入手,槽里落下 1★(最高星级 0 → 1,尾巴报「合到 ★」)
    fire(cardsOf(dom).children[0] as StubEl, 'click');
    expect(toastOf(dom).textContent).toBe(`已购入：${towerName(TOWER_AUTOCANNON)} 合到 ★`);
    // 第二档:同型已有 2× 1★,再买 1 把 → 3× 1★ 当场合到 ★★
    world.shopWeapons[0] = TOWER_RAILGUN;
    world.weapons[0]!.type = TOWER_RAILGUN;
    world.weapons[0]!.stars = 1;
    world.weapons[1]!.type = TOWER_RAILGUN;
    world.weapons[1]!.stars = 1;
    world.weaponCode = 0;
    fire(refreshOf(dom), 'click'); // 重画货架(第 0 格现在是磁轨炮)
    fire(cardsOf(dom).children[0] as StubEl, 'click');
    expect(toastOf(dom).textContent).toBe(`已购入：${towerName(TOWER_RAILGUN)} 合到 ★★`);
    // 第三档:2× 1★ + 2× 2★,再买 1 把 → 3× 1★ 合到 2★、3× 2★ 合到 3★ 当场变身;
    // 变身只报「合到 ★★★」不报合成武器名 —— 三星武器不改名字,名字还是磁轨炮
    world.shopWeapons[0] = TOWER_RAILGUN;
    world.weapons[0]!.type = TOWER_RAILGUN;
    world.weapons[0]!.stars = 1;
    world.weapons[1]!.type = TOWER_RAILGUN;
    world.weapons[1]!.stars = 1;
    world.weapons[2]!.type = TOWER_RAILGUN;
    world.weapons[2]!.stars = 2;
    world.weapons[3]!.type = TOWER_RAILGUN;
    world.weapons[3]!.stars = 2;
    world.weaponCode = 0;
    fire(refreshOf(dom), 'click');
    fire(cardsOf(dom).children[0] as StubEl, 'click');
    expect(toastOf(dom).textContent).toBe(`已购入：${towerName(TOWER_RAILGUN)} 合到 ★★★`);
  });

  it('换装回执照报旧武器;最高星级没涨就不带合成尾巴', () => {
    world.replaceNeeded = true;
    // 已持 1★ 自动机炮,再买一把自动机炮换掉别的槽:max 仍 1 → 无尾巴
    world.weapons[0]!.type = TOWER_AUTOCANNON;
    world.weapons[0]!.stars = 1;
    for (let i = 1; i < world.weapons.length; i++) {
      world.weapons[i]!.type = TOWER_LASER;
      world.weapons[i]!.stars = 1;
    }
    setup();
    fire(cardsOf(dom).children[0] as StubEl, 'click'); // 槽满 → 替换态
    expect(pickerOf(dom).style.display).toBe('flex');
    fire(chipOf(dom, 3), 'click'); // 换掉「激光棱镜 ★」
    expect(toastOf(dom).textContent).toBe(`已换装：${towerName(TOWER_AUTOCANNON)} → ${towerName(TOWER_LASER)} ★`);
  });

  it('刷新回执:已刷新货架并报花费', () => {
    setup();
    fire(refreshOf(dom), 'click');
    expect(toastOf(dom).textContent).toBe(`已刷新货架 —— 花费 ${DOCK_SHOP_REFRESH_PRICE} 星币`);
  });

  it('refreshLocale 重画文案且货架/折扣/余额/HP/pendingBuy 与业务计数全不动', async () => {
    world.replaceNeeded = true;
    world.shopDiscountIndex = DOCK_EDICT_COUNT + 0; // 第 0 格打特价
    world.weapons[0]!.type = TOWER_AUTOCANNON;
    world.weapons[0]!.stars = 1;
    for (let i = 1; i < world.weapons.length; i++) {
      world.weapons[i]!.type = TOWER_LASER;
      world.weapons[i]!.stars = 1;
    }
    const flow = setup();
    fire(cardsOf(dom).children[0] as StubEl, 'click'); // 进入替换态(pendingBuy 生效)
    expect(pickerOf(dom).style.display).toBe('flex');
    const shelfBefore = JSON.stringify([world.shopWeapons, world.shopDiscountIndex]);
    const coinsBefore = world.starCoins;
    const hpBefore = world.ship.hp;
    const callsBefore = {
      weapon: world.weaponCalls.length,
      refresh: world.refreshCalls,
      edict: world.edictCalls.length,
      repair: world.repairCalls,
      complete: world.completeCalls,
    };
    await initI18n('en');
    flow.refreshLocale();
    // 世界账本一行不动:不刷新货架、不扣币、不买不修不整备(也不消费 rng —— 桩没有 rng 可消费)
    expect(JSON.stringify([world.shopWeapons, world.shopDiscountIndex])).toBe(shelfBefore);
    expect(world.starCoins).toBe(coinsBefore);
    expect(world.ship.hp).toBe(hpBefore);
    expect(world.weaponCalls.length).toBe(callsBefore.weapon);
    expect(world.refreshCalls).toBe(callsBefore.refresh);
    expect(world.edictCalls.length).toBe(callsBefore.edict);
    expect(world.repairCalls).toBe(callsBefore.repair);
    expect(world.completeCalls).toBe(callsBefore.complete);
    // pendingBuy 保留:替换态还开着,提示翻成英文、武器名照旧
    expect(pickerOf(dom).style.display).toBe('flex');
    expect((pickerOf(dom).children[1] as StubEl).textContent).toContain('Click a slot');
    expect((pickerOf(dom).children[1] as StubEl).textContent).toContain(towerName(TOWER_AUTOCANNON));
    // 静态标签/特价句翻成英文
    expect(((shopHeadOf(dom).children[0] as StubEl).children[1] as StubEl).textContent).toBe('Ship Supply');
    expect(segmentOf(dom).textContent).toContain('Segment 2');
    expect(finishOf(dom).textContent).toContain('Finish refit');
    const card = cardsOf(dom).children[0] as StubEl;
    expect(findText(card, 'On sale')).toBe(true);
    expect(findText(card, `${shopDiscountPrice(DOCK_WEAPON_PRICE)} ★`)).toBe(true);
    // 特价整句(含原价)在悬停 tooltip 里,卡面只印「On sale N ★」
    fire(cardsOf(dom).children[0] as StubEl, 'mouseenter');
    expect(findText(tooltipOf(dom), 'was')).toBe(true);
  });
});

describe('整备面板英文文案(todo 07 中英双验)', () => {
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

  it('英文静态文案:眉题/标题/分区/修复/完成/替换层全走英文', async () => {
    const flow = setup();
    await initI18n('en');
    flow.refreshLocale();
    expect(((shopHeadOf(dom).children[0] as StubEl).children[0] as StubEl).textContent).toBe('DOCK SUPPLY');
    expect(((shopHeadOf(dom).children[0] as StubEl).children[1] as StubEl).textContent).toBe('Ship Supply');
    expect(segmentOf(dom).textContent).toBe('Refit · Segment 2');
    expect((weaponHeadOf(dom).children[0] as StubEl).textContent).toBe('Weapon Supply');
    expect((starSectionOf(dom).children[0] as StubEl).textContent).toBe('Edict Cards');
    expect(pickerOf(dom).children[0]?.textContent).toBe('Weapon slots full');
    expect(pickerOf(dom).children[WEAPON_PICKER_CANCEL_INDEX]?.textContent).toBe('Cancel');
    expect(repairOf(dom).textContent).toContain(`+${DOCK_REPAIR_HP} HP`);
    expect(repairOf(dom).textContent).toContain(`${DOCK_REPAIR_PRICE} ★`);
    expect(finishOf(dom).textContent).toBe('Finish refit · start next wave');
    expect(refreshOf(dom).textContent).toBe(`Refresh ${DOCK_SHOP_REFRESH_PRICE} ★`);
  });

  it('英文拒绝码逐码有文案且不露 key/中文,未知码带原号', async () => {
    await initI18n('en');
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
      expect(text).not.toContain('ui:refit');
      expect(text).not.toContain('理由码');
      expect(text).not.toContain('星币');
      expect(text).not.toContain('已售');
    }
    expect(refitDenyMessage(-999)).toContain('-999');
  });

  it('英文特价卡:On sale 句 + 划线,非特价格照旧;悬停 notes 走英文', async () => {
    world.shopWeapons = [TOWER_AUTOCANNON, TOWER_LASER, TOWER_RAILGUN];
    world.shopDiscountIndex = DOCK_EDICT_COUNT + 1; // 武器货架第 1 格特价
    world.weapons[0]!.type = TOWER_AUTOCANNON;
    world.weapons[0]!.stars = 1;
    world.weapons[1]!.type = TOWER_AUTOCANNON;
    world.weapons[1]!.stars = 1;
    const flow = setup();
    await initI18n('en');
    flow.refreshLocale();
    const sale = cardsOf(dom).children[1] as StubEl;
    expect(findText(sale, 'On sale')).toBe(true);
    expect(findStyle(sale, 'line-through')).toBe(true);
    expect(findText(sale, `${DOCK_WEAPON_PRICE} ★`)).toBe(true);
    expect(findText(sale, `${shopDiscountPrice(DOCK_WEAPON_PRICE)} ★`)).toBe(true);
    const normal = cardsOf(dom).children[0] as StubEl;
    expect(findStyle(normal, 'line-through')).toBe(false);
    // 悬停 weaponNotes 的英文:持有清单与合成预告
    fire(cardsOf(dom).children[0] as StubEl, 'mouseenter');
    expect(tooltipOf(dom).textContent).toContain('Held ★ ×2');
    expect(tooltipOf(dom).textContent).toContain('Buy to fuse ★★');
  });

  it('英文购买回执与刷新回执走整句', async () => {
    const flow = setup();
    await initI18n('en');
    flow.refreshLocale();
    fire(cardsOf(dom).children[0] as StubEl, 'click');
    expect(toastOf(dom).textContent).toContain('Bought:');
    expect(toastOf(dom).textContent).toContain(towerName(TOWER_AUTOCANNON));
    fire(refreshOf(dom), 'click');
    expect(toastOf(dom).textContent).toContain('Shelf refreshed');
  });

  it('英文法令卡售出后显示 Sold out', async () => {
    const flow = setup();
    await initI18n('en');
    flow.refreshLocale();
    fire(edictOf(dom, 0), 'click');
    expect(world.edictCalls).toEqual([0]);
    expect(findText(edictOf(dom, 0), 'Sold out')).toBe(true);
  });
});

// 替换层 = 标题 + 一行提示 + 一颗取消(槽位不在侧栏列,选槽整个搬到左侧舰船图上)
const WEAPON_PICKER_CANCEL_INDEX = 2;
