import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { vi.stubGlobal('location', { search: '' }); });
import { REROLL_PRICE, UPGRADE_SKIP_FEE } from '../data/economy';
import {
  createEdictLevels,
  EDICT_AMMO,
  EDICT_ARMOR,
  EDICT_COOLANT,
  EDICT_CRUISE,
  EDICT_GYRO,
  EDICT_MAGNET,
  EDICT_MAX_LEVEL,
  EDICT_OVERDRIVE,
  EDICT_STARCHART,
  EDICTS,
} from '../data/edicts';
import { isMergeResult } from '../data/merges';
import { TOWER_AUTOCANNON, TOWER_RAILGUN, TOWERS, towerRange } from '../data/towers';
import { createWeaponSlots, type WeaponSlot } from '../sim/armory';
import { OFFER_EDICT, OFFER_NEW_WEAPON, optionLabel, UPGRADE_NO_OFFER, type UpgradeOption } from '../sim/upgrade';
import {
  ACQUIRE_INVALID_TYPE,
  ACQUIRE_REPLACE_NEEDED,
  REROLL_ALREADY_DONE,
  REROLL_NO_STARCOINS,
  REPLACE_BAD_SLOT,
  REPLACE_INVALID_TYPE,
  EDICT_MAXED,
  EDICT_INVALID_TYPE,
  type World,
} from '../sim/world';
import { cardDesc, cardIcon, cardLevelText, cardTitle, createUpgradeFlow, denyMessage, skipRefund, towerDps } from './upgradeFlow';

function newWeaponOpt(type: number, level = 0): UpgradeOption {
  return { kind: OFFER_NEW_WEAPON, type, level };
}

function edictOpt(type: number, level = 0): UpgradeOption {
  return { kind: OFFER_EDICT, type, level };
}

const DENY_CODES = [
  UPGRADE_NO_OFFER,
  ACQUIRE_REPLACE_NEEDED,
  ACQUIRE_INVALID_TYPE,
  REPLACE_BAD_SLOT,
  REPLACE_INVALID_TYPE,
  EDICT_MAXED,
  EDICT_INVALID_TYPE,
  REROLL_NO_STARCOINS,
  REROLL_ALREADY_DONE,
];

describe('denyMessage', () => {
  it('UI 可收到的每个拒绝码都有明确中文文案', () => {
    const messages = DENY_CODES.map(denyMessage);
    for (const message of messages) {
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain('理由码');
    }
    expect(new Set(messages).size).toBe(messages.length - 1);
  });

  it('关键拒绝原因把可恢复动作说清楚', () => {
    expect(denyMessage(UPGRADE_NO_OFFER)).toContain('升级');
    expect(denyMessage(ACQUIRE_REPLACE_NEEDED)).toContain('替换');
    expect(denyMessage(EDICT_MAXED)).toContain(String(EDICT_MAX_LEVEL));
    expect(denyMessage(REROLL_NO_STARCOINS)).toContain(String(REROLL_PRICE));
    expect(denyMessage(REROLL_ALREADY_DONE)).toContain('摇过');
  });

  it('未知码回落为带原码的兜底文案', () => {
    expect(denyMessage(-999)).toContain('-999');
  });
});

describe('升级卡片纯文案', () => {
  it('两类标题都来自 optionLabel，互不串表', () => {
    const options = [newWeaponOpt(TOWER_AUTOCANNON), edictOpt(EDICT_AMMO)];
    for (const option of options) expect(cardTitle(option)).toBe(optionLabel(option));
  });

  it('所有可出卡型号都有内建图标，未知型号明确报问号', () => {
    const towerOptions = TOWERS.filter((def) => !isMergeResult(def.type)).map((def) => newWeaponOpt(def.type));
    const options = [...towerOptions, ...EDICTS.map((def) => edictOpt(def.type))];
    for (const option of options) expect(cardIcon(option)).not.toBe('?');
    expect(cardIcon(newWeaponOpt(99))).toBe('?');
    expect(cardIcon(edictOpt(99))).toBe('?');
  });

  it('新武器描述按 1★ 报数值与系,等级行按升星通路说话', () => {
    const world = createStubWorld([newWeaponOpt(TOWER_AUTOCANNON)]);
    const def = TOWERS[TOWER_AUTOCANNON];
    expect(def).toBeDefined();
    if (!def) return;
    const desc = cardDesc(newWeaponOpt(TOWER_AUTOCANNON), worldAsWorld(world));
    expect(desc).toContain(String(Math.round(towerRange(def, 1))));
    expect(desc).toContain(String(Math.round(towerDps(def, 1) * 100) / 100));
    expect(desc).toContain('弹药系'); // 武器卡标好所属系
    // 未拥有:从 1★ 起步
    expect(cardLevelText(newWeaponOpt(TOWER_AUTOCANNON), worldAsWorld(world))).toBe('新武器 · 获得后从 ★1 起步');
    // 已有 1★(有配方):先说升星、再说 3★ 合成
    expect(cardLevelText(newWeaponOpt(TOWER_AUTOCANNON, 1), worldAsWorld(world))).toBe(
      '已有 ★1 · 再拿一把升 ★2 · 3★ 合成',
    );
    // 已有 2★(有配方):下一把就是 3★ 变身
    expect(cardLevelText(newWeaponOpt(TOWER_AUTOCANNON, 2), worldAsWorld(world))).toBe(
      '已有 ★2 · 再拿一把 · 凑满 3★ 当场合成',
    );
  });

  it('法令描述逐条来自数值表:系限定档带系名前缀,全船档带「全船」前缀', () => {
    const ammo = cardDesc(edictOpt(EDICT_AMMO));
    expect(ammo).toContain('弹药系');
    expect(ammo).not.toContain('全船');
    expect(ammo).toContain('射速');
    expect(ammo).toContain('装填');
    expect(cardDesc(edictOpt(EDICT_COOLANT))).toContain('热上限');
    expect(cardDesc(edictOpt(EDICT_ARMOR))).toContain('全船');
    expect(cardDesc(edictOpt(EDICT_ARMOR))).toContain('船体 HP');
    expect(cardDesc(edictOpt(EDICT_GYRO))).toContain('转向');
    expect(cardDesc(edictOpt(EDICT_MAGNET))).toContain('磁吸半径');
    expect(cardDesc(edictOpt(EDICT_CRUISE))).toContain('巡航速度');
    expect(cardDesc(edictOpt(EDICT_STARCHART))).toContain('星币概率');
    expect(cardDesc(edictOpt(EDICT_OVERDRIVE))).toContain('全武器伤害');
  });

  it('法令等级行报当前层 → 下一层(「散热协议 ×2 → ×3」),没拿过时报上限', () => {
    expect(cardLevelText(edictOpt(EDICT_COOLANT, 0))).toBe(`法令 · 不占槽 · 可叠到 ×${EDICT_MAX_LEVEL}`);
    expect(cardLevelText(edictOpt(EDICT_COOLANT, 2))).toBe(`法令 · 当前 ×2 → ×3(上限 ×${EDICT_MAX_LEVEL})`);
    expect(cardLevelText(edictOpt(EDICT_COOLANT, EDICT_MAX_LEVEL))).toContain('已满层');
  });

  it('越界型号不冒充第 0 型', () => {
    expect(cardDesc(newWeaponOpt(99))).toContain('99');
    expect(cardDesc(edictOpt(99))).toContain('99');
  });
});

describe('skipRefund', () => {
  it('返还等于费用减手续费，并夹在零以上', () => {
    expect(skipRefund(509)).toBe(509 - UPGRADE_SKIP_FEE);
    expect(skipRefund(UPGRADE_SKIP_FEE)).toBe(0);
    expect(skipRefund(-5)).toBe(0);
  });
});

interface StubEvent {
  code?: string;
  repeat?: boolean;
  preventDefault(): void;
}

interface StubEl {
  style: { cssText: string; color: string; display: string; opacity: string; cursor: string };
  textContent: string;
  disabled: boolean;
  children: StubEl[];
  handlers: Map<string, Array<(event: StubEvent) => void>>;
  append(...children: StubEl[]): void;
  appendChild(child: StubEl): StubEl;
  addEventListener(type: string, handler: (event: StubEvent) => void): void;
}

function createStubEl(): StubEl {
  const element: StubEl = {
    style: { cssText: '', color: '', display: '', opacity: '', cursor: '' },
    textContent: '',
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
  if (element.disabled) return;
  const event: StubEvent = { preventDefault: () => {} };
  for (const handler of element.handlers.get(type) ?? []) handler(event);
}

interface StubDom {
  ui: StubEl;
  timers: Map<number, () => void>;
  key(code: string): void;
  contextMenu(): void;
  restore(): void;
}

function installDom(): StubDom {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previousWindow = globals.window;
  const previousDocument = globals.document;
  const previousHTMLElement = globals.HTMLElement;
  const keyHandlers: Array<(event: StubEvent) => void> = [];
  const contextHandlers: Array<(event: StubEvent) => void> = [];
  let nextTimer = 1;
  const dom: StubDom = {
    ui: createStubEl(),
    timers: new Map(),
    key(code): void {
      const event: StubEvent = { code, repeat: false, preventDefault: () => {} };
      for (const handler of keyHandlers) handler(event);
    },
    contextMenu(): void {
      const event: StubEvent = { preventDefault: () => {} };
      for (const handler of contextHandlers) handler(event);
    },
    restore(): void {
      globals.window = previousWindow;
      globals.document = previousDocument;
      globals.HTMLElement = previousHTMLElement;
    },
  };
  globals.window = {
    addEventListener(type: string, handler: (event: StubEvent) => void): void {
      if (type === 'keydown') keyHandlers.push(handler);
    },
    setTimeout(handler: () => void): number {
      const id = nextTimer++;
      dom.timers.set(id, handler);
      return id;
    },
    clearTimeout(id: number): void { dom.timers.delete(id); },
  };
  globals.document = {
    activeElement: undefined,
    createElement: (): StubEl => createStubEl(),
    getElementById: (id: string): StubEl | null => id === 'ui' ? dom.ui : null,
    addEventListener(type: string, handler: (event: StubEvent) => void): void {
      if (type === 'contextmenu') contextHandlers.push(handler);
    },
  };
  globals.HTMLElement = class {};
  return dom;
}

interface StubWorld {
  offer: UpgradeOption[];
  scrap: number;
  upgradeCost: number;
  starCoins: number;
  offerRerolled: boolean;
  weapons: WeaponSlot[];
  edictLevels: number[];
  takeCalls: Array<[number, number | undefined]>;
  takeCode: number;
  replaceNeeded: boolean;
  skipCalls: number;
  skipOk: boolean;
  rerollCalls: number;
  rerollCode: number;
  takeUpgrade(choice: number, slotIndex?: number): number;
  skipUpgrade(): boolean;
  rerollOffer(): number;
}

function createStubWorld(offer: UpgradeOption[]): StubWorld {
  const world: StubWorld = {
    offer,
    scrap: 60,
    upgradeCost: 35,
    starCoins: 30,
    offerRerolled: false,
    weapons: createWeaponSlots(),
    edictLevels: createEdictLevels(),
    takeCalls: [],
    takeCode: 0,
    replaceNeeded: false,
    skipCalls: 0,
    skipOk: true,
    rerollCalls: 0,
    rerollCode: 3,
    takeUpgrade(choice, slotIndex): number {
      world.takeCalls.push([choice, slotIndex]);
      if (world.replaceNeeded && slotIndex === undefined) return ACQUIRE_REPLACE_NEEDED;
      return world.takeCode;
    },
    skipUpgrade(): boolean { world.skipCalls++; return world.skipOk; },
    rerollOffer(): number {
      world.rerollCalls++;
      if (world.rerollCode > 0) {
        world.starCoins -= REROLL_PRICE;
        world.offerRerolled = true;
      }
      return world.rerollCode;
    },
  };
  return world;
}

function worldAsWorld(world: StubWorld): World {
  return world as unknown as World;
}

const panelOf = (dom: StubDom): StubEl => dom.ui.children[0] as StubEl;
const pickerOf = (dom: StubDom): StubEl => dom.ui.children[1] as StubEl;
const toastOf = (dom: StubDom): StubEl => dom.ui.children[2] as StubEl;
const headOf = (dom: StubDom): StubEl => panelOf(dom).children[0] as StubEl;
const cardsOf = (dom: StubDom): StubEl => panelOf(dom).children[1] as StubEl;
const rerollOf = (dom: StubDom): StubEl => (panelOf(dom).children[2] as StubEl).children[0] as StubEl;
const skipOf = (dom: StubDom): StubEl => (panelOf(dom).children[2] as StubEl).children[1] as StubEl;
const pickerSlotsOf = (dom: StubDom): StubEl => pickerOf(dom).children[1] as StubEl;
const pickerBackOf = (dom: StubDom): StubEl => pickerOf(dom).children[2] as StubEl;

describe('createUpgradeFlow 单阶段流程', () => {
  let dom: StubDom;
  let world: StubWorld;
  let resolved: number;

  function setup(): ReturnType<typeof createUpgradeFlow> {
    const flow = createUpgradeFlow({ world: worldAsWorld(world), onResolved: () => { resolved++; } });
    flow.show();
    return flow;
  }

  beforeEach(() => {
    dom = installDom();
    world = createStubWorld([newWeaponOpt(TOWER_AUTOCANNON), edictOpt(EDICT_ARMOR), edictOpt(EDICT_AMMO)]);
    resolved = 0;
  });

  afterEach(() => dom.restore());

  it('show 渲染世界候选、玩家标题与跳过账目', () => {
    setup();
    expect(headOf(dom).textContent).toBe('世界已暂停 · 三选一');
    expect(cardsOf(dom).children.length).toBe(3);
    const first = cardsOf(dom).children[0] as StubEl;
    expect(first.children.map((child) => child.textContent)).toEqual([
      cardIcon(world.offer[0] as UpgradeOption),
      cardTitle(world.offer[0] as UpgradeOption),
      cardDesc(world.offer[0] as UpgradeOption, worldAsWorld(world)),
      cardLevelText(world.offer[0] as UpgradeOption, worldAsWorld(world)),
    ]);
    expect(skipOf(dom).textContent).toContain(String(skipRefund(world.upgradeCost)));
  });

  it('点卡立即调用 takeUpgrade(choice) 并结算', () => {
    setup();
    fire(cardsOf(dom).children[2] as StubEl, 'click');
    expect(world.takeCalls).toEqual([[2, undefined]]);
    expect(resolved).toBe(1);
    expect(panelOf(dom).style.display).toBe('none');
    expect(toastOf(dom).textContent).toContain('法令生效');
  });

  it('武器槽满时进入替换层，再以同一候选和槽位结算', () => {
    world.replaceNeeded = true;
    for (let index = 0; index < world.weapons.length; index++) {
      const slot = world.weapons[index];
      if (!slot) continue;
      slot.type = index === 1 ? TOWER_RAILGUN : TOWER_AUTOCANNON;
      slot.stars = index + 1;
    }
    setup();
    fire(cardsOf(dom).children[0] as StubEl, 'click');
    expect(world.takeCalls).toEqual([[0, undefined]]);
    expect(panelOf(dom).style.display).toBe('none');
    expect(pickerOf(dom).style.display).toBe('flex');
    expect((pickerSlotsOf(dom).children[1] as StubEl).textContent).toContain('★2');
    fire(pickerSlotsOf(dom).children[1] as StubEl, 'click');
    expect(world.takeCalls).toEqual([[0, undefined], [0, 1]]);
    expect(resolved).toBe(1);
  });

  it('替换层可用按钮、Esc 和右键返回重选，且不结算', () => {
    world.replaceNeeded = true;
    world.weapons[0] = { ...world.weapons[0] as WeaponSlot, type: TOWER_AUTOCANNON, stars: 1 };
    const flow = setup();
    for (const cancel of [() => fire(pickerBackOf(dom), 'click'), () => dom.key('Escape'), () => dom.contextMenu()]) {
      fire(cardsOf(dom).children[0] as StubEl, 'click');
      cancel();
      expect(panelOf(dom).style.display).toBe('flex');
      expect(pickerOf(dom).style.display).toBe('none');
      expect(resolved).toBe(0);
    }
    flow.hide();
  });

  it('普通拒绝留在选卡阶段，卡片过期则放行', () => {
    world.takeCode = EDICT_MAXED;
    setup();
    fire(cardsOf(dom).children[1] as StubEl, 'click');
    expect(resolved).toBe(0);
    expect(panelOf(dom).style.display).toBe('flex');
    expect(toastOf(dom).textContent).toBe(denyMessage(EDICT_MAXED));
    world.takeCode = UPGRADE_NO_OFFER;
    fire(cardsOf(dom).children[1] as StubEl, 'click');
    expect(resolved).toBe(1);
  });

  it('跳过调用 skipUpgrade，空候选也不会把游戏卡在时停', () => {
    setup();
    fire(skipOf(dom), 'click');
    expect(world.skipCalls).toBe(1);
    expect(resolved).toBe(1);
    const empty = createStubWorld([]);
    const flow = createUpgradeFlow({ world: worldAsWorld(empty), onResolved: () => { resolved++; } });
    flow.show();
    expect(resolved).toBe(2);
  });

  it('重摇成功后重绘候选但不结算，并立即置灰', () => {
    setup();
    world.offer = [newWeaponOpt(TOWER_RAILGUN), edictOpt(EDICT_COOLANT)];
    fire(rerollOf(dom), 'click');
    expect(world.rerollCalls).toBe(1);
    expect(resolved).toBe(0);
    expect(rerollOf(dom).disabled).toBe(true);
    expect((cardsOf(dom).children[0] as StubEl).children[1]?.textContent).toBe(cardTitle(world.offer[0] as UpgradeOption));
    expect((cardsOf(dom).children[2] as StubEl).style.display).toBe('none');
  });

  it('星币不足或本档已摇过时重摇置灰', () => {
    world.starCoins = REROLL_PRICE - 1;
    setup();
    expect(rerollOf(dom).disabled).toBe(true);
    fire(rerollOf(dom), 'click');
    expect(world.rerollCalls).toBe(0);
  });

  it('setWorld 收起旧流程，下一次点击只落到新世界', () => {
    const flow = setup();
    const next = createStubWorld([newWeaponOpt(TOWER_RAILGUN)]);
    flow.setWorld(worldAsWorld(next));
    expect(panelOf(dom).style.display).toBe('none');
    expect(resolved).toBe(0);
    flow.show();
    fire(cardsOf(dom).children[0] as StubEl, 'click');
    expect(next.takeCalls).toEqual([[0, undefined]]);
    expect(world.takeCalls).toEqual([]);
  });
});
