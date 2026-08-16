import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { vi.stubGlobal('location', { search: '' }); });
import { rerollPriceFor, UPGRADE_SKIP_STAR_COINS } from '../data/economy';
import {
  createEdictLevels,
  EDICT_AMMO,
  EDICT_ARMOR,
  EDICT_BOOST,
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
import { TOWER_AUTOCANNON, TOWER_MISSILE_NEST, TOWER_RAILGUN, TOWERS, towerRange } from '../data/towers';
import { createWeaponSlots, type WeaponSlot } from '../sim/armory';
import { OFFER_EDICT, OFFER_NEW_WEAPON, UPGRADE_NO_OFFER, type UpgradeOption } from '../sim/upgrade';
import {
  ACQUIRE_INVALID_TYPE,
  ACQUIRE_REPLACE_NEEDED,
  REROLL_NO_STARCOINS,
  REPLACE_BAD_SLOT,
  REPLACE_INVALID_TYPE,
  EDICT_MAXED,
  EDICT_INVALID_TYPE,
  type World,
} from '../sim/world';
import { changeLocale, currentLocale, initI18n, t } from '../i18n';
import { cardDesc, cardIcon, cardLevelText, cardTitle, createUpgradeFlow, denyMessage, towerDps, upgradeComparison, upgradeComparisonText } from './upgradeFlow';
import { optionLabel } from './presentation/upgradeText';

beforeEach(async () => {
  await initI18n('zh-CN');
});

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
];

describe('denyMessage', () => {
  it('UI 可收到的每个拒绝码都有明确中文文案', () => {
    const messages = DENY_CODES.map((code) =>
      code === REROLL_NO_STARCOINS ? denyMessage(code, { price: rerollPriceFor(0) }) : denyMessage(code),
    );
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
    // 重摇价现算传入:不足第 n+1 摇时,文案报的是那一摇的价
    expect(denyMessage(REROLL_NO_STARCOINS, { price: rerollPriceFor(2) })).toContain(String(rerollPriceFor(2)));
  });

  it('未知码回落为带原码的兜底文案', () => {
    expect(denyMessage(-999)).toContain('-999');
  });

  it('en 下每个理由码都有英文文案,未知码仍保留原始编号', async () => {
    await changeLocale('en');
    const messages = DENY_CODES.map((code) =>
      code === REROLL_NO_STARCOINS ? denyMessage(code, { price: rerollPriceFor(0) }) : denyMessage(code),
    );
    for (const message of messages) {
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain('理由码');
    }
    expect(denyMessage(UPGRADE_NO_OFFER)).toContain('upgrade');
    expect(denyMessage(EDICT_MAXED)).toContain(String(EDICT_MAX_LEVEL));
    expect(denyMessage(REROLL_NO_STARCOINS, { price: rerollPriceFor(1) })).toContain(String(rerollPriceFor(1)));
    expect(denyMessage(-999)).toContain('-999');
  });

  it('满层文案英文按 count 选复数分支(one/other)', async () => {
    await changeLocale('en');
    expect(t('ui:upgrade.deny.edictMaxed', { count: 1 })).toBe(
      'This edict is maxed out (1 layer cap) — pick another or skip',
    );
    expect(t('ui:upgrade.deny.edictMaxed', { count: 5 })).toBe(
      'This edict is maxed out (5 layers cap) — pick another or skip',
    );
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

  it('新武器描述按 1★ 报数值与系,等级行按同型同星把数说话', () => {
    const world = createStubWorld([newWeaponOpt(TOWER_AUTOCANNON)]);
    const asWorld = worldAsWorld(world);
    const def = TOWERS[TOWER_AUTOCANNON];
    expect(def).toBeDefined();
    if (!def) return;
    const desc = cardDesc(newWeaponOpt(TOWER_AUTOCANNON), asWorld);
    expect(desc).toContain(String(Math.round(towerRange(def, 1))));
    expect(desc).toContain(String(Math.round(towerDps(def, 1) * 100) / 100));
    expect(desc).toContain('弹药系'); // 武器卡标好所属系
    // 未拥有:从 ★ 起步
    expect(cardLevelText(newWeaponOpt(TOWER_AUTOCANNON), asWorld)).toBe('新武器 · 获得后从 ★ 起步');
    // 1× ★:报把数 + 三合一规则
    world.weapons[0]!.type = TOWER_AUTOCANNON;
    world.weapons[0]!.stars = 1;
    expect(cardLevelText(newWeaponOpt(TOWER_AUTOCANNON), asWorld)).toBe('已有 ★ ×1 · 三把同星合一');
    // 2× ★:下一张卡当场合 ★★
    world.weapons[1]!.type = TOWER_AUTOCANNON;
    world.weapons[1]!.stars = 1;
    expect(cardLevelText(newWeaponOpt(TOWER_AUTOCANNON), asWorld)).toBe('已有 ★ ×2 · 再来一把合成 ★★');
    // 2× ★ + 2× ★★:下一张卡 ★ 合一、★★ 满三把连锁合到 ★★★(有配方 = 当场合成)
    world.weapons[0]!.stars = 2;
    world.weapons[1]!.stars = 2;
    world.weapons[2]!.type = TOWER_AUTOCANNON;
    world.weapons[2]!.stars = 1;
    world.weapons[3]!.type = TOWER_AUTOCANNON;
    world.weapons[3]!.stars = 1;
    expect(cardLevelText(newWeaponOpt(TOWER_AUTOCANNON), asWorld)).toBe(
      '已有 ★★ ×2 ★ ×2 · 再来一把连合到 ★★★ 合成',
    );
    // 无配方塔(导弹巢):同样连锁,但没有"合成"尾巴
    const nest = createStubWorld([newWeaponOpt(TOWER_MISSILE_NEST)]);
    const nestWorld = worldAsWorld(nest);
    nest.weapons[0]!.type = TOWER_MISSILE_NEST;
    nest.weapons[0]!.stars = 2;
    nest.weapons[1]!.type = TOWER_MISSILE_NEST;
    nest.weapons[1]!.stars = 2;
    nest.weapons[2]!.type = TOWER_MISSILE_NEST;
    nest.weapons[2]!.stars = 1;
    nest.weapons[3]!.type = TOWER_MISSILE_NEST;
    nest.weapons[3]!.stars = 1;
    expect(cardLevelText(newWeaponOpt(TOWER_MISSILE_NEST), nestWorld)).toBe(
      '已有 ★★ ×2 ★ ×2 · 再来一把连合到 ★★★',
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
    expect(cardDesc(edictOpt(EDICT_BOOST))).toContain('加速冷却 -0.3s');
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

  it('en 下武器卡描述按英文句式拼装,持有/合成语义不依赖中文词序', async () => {
    await changeLocale('en');
    const world = createStubWorld([newWeaponOpt(TOWER_AUTOCANNON)]);
    const asWorld = worldAsWorld(world);
    expect(cardDesc(newWeaponOpt(TOWER_AUTOCANNON), asWorld)).toContain('Arc ');
    expect(cardDesc(newWeaponOpt(TOWER_AUTOCANNON), asWorld)).toContain('Range ');
    expect(cardDesc(newWeaponOpt(TOWER_AUTOCANNON), asWorld)).toContain('DPS ');
    expect(cardDesc(newWeaponOpt(TOWER_AUTOCANNON), asWorld)).toContain('Ammo-fed');
    expect(cardDesc(edictOpt(99))).toContain('99');
    // 新武器从 1★ 起步
    expect(cardLevelText(newWeaponOpt(TOWER_AUTOCANNON), asWorld)).toBe('New weapon · starts at ★');
    // 两把 1★:再来一把合成 ★★
    world.weapons[0]!.type = TOWER_AUTOCANNON;
    world.weapons[0]!.stars = 1;
    world.weapons[1]!.type = TOWER_AUTOCANNON;
    world.weapons[1]!.stars = 1;
    expect(cardLevelText(newWeaponOpt(TOWER_AUTOCANNON), asWorld)).toBe(
      'Held ★ ×2 · get one more to fuse ★★',
    );
    // 法令层数进度
    expect(cardLevelText(edictOpt(EDICT_COOLANT, 2))).toBe(`Edict · ×2 → ×3 (cap ×${EDICT_MAX_LEVEL})`);
  });
});

describe('upgradeComparison(升星前后预览)', () => {
  it('新武器显示从无到 1★ 的 DPS/射程变化,不修改 World', () => {
    const world = createStubWorld([newWeaponOpt(TOWER_AUTOCANNON)]);
    const comparison = upgradeComparison(newWeaponOpt(TOWER_AUTOCANNON), worldAsWorld(world));
    expect(comparison.beforeStars).toBe(0);
    expect(comparison.afterStars).toBe(1);
    expect(comparison.beforeDps).toBeNull();
    expect(comparison.afterDps).toBe(towerDps(TOWERS[TOWER_AUTOCANNON]!, 1));
    expect(upgradeComparisonText(newWeaponOpt(TOWER_AUTOCANNON), worldAsWorld(world))).toContain('DPS — →');
    expect(world.weapons.every((slot) => slot.type < 0)).toBe(true);
  });

  it('两把 1★ 再来一张预览为 2★,三把 2★ 连锁预览为 3★', () => {
    const world = createStubWorld([newWeaponOpt(TOWER_AUTOCANNON)]);
    world.weapons[0]!.type = TOWER_AUTOCANNON;
    world.weapons[0]!.stars = 1;
    world.weapons[1]!.type = TOWER_AUTOCANNON;
    world.weapons[1]!.stars = 1;
    expect(upgradeComparison(newWeaponOpt(TOWER_AUTOCANNON), worldAsWorld(world)).afterStars).toBe(2);
    world.weapons[0]!.stars = 2;
    world.weapons[1]!.stars = 2;
    world.weapons[2]!.type = TOWER_AUTOCANNON;
    world.weapons[2]!.stars = 2;
    expect(upgradeComparison(newWeaponOpt(TOWER_AUTOCANNON), worldAsWorld(world)).afterStars).toBe(3);
  });

  it('法令预览按当前层 → 下一层,并在满层时夹住', () => {
    expect(upgradeComparison(edictOpt(EDICT_COOLANT, 2)).afterStars).toBe(3);
    expect(upgradeComparison(edictOpt(EDICT_COOLANT, EDICT_MAX_LEVEL)).afterStars).toBe(EDICT_MAX_LEVEL);
  });

  it('en 下升星预览与法令叠层预览句式独立翻译', async () => {
    await changeLocale('en');
    const world = createStubWorld([newWeaponOpt(TOWER_AUTOCANNON)]);
    expect(upgradeComparisonText(newWeaponOpt(TOWER_AUTOCANNON), worldAsWorld(world))).toContain('DPS — →');
    expect(upgradeComparisonText(edictOpt(EDICT_COOLANT, 2))).toBe('Layers ×2 → ×3');
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
  offerRerolls: number;
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
  /** 确定性快照:offer + 武器槽 + 星币/残骸/重摇计数,用于钉"refreshLocale 不改 World" */
  checksum(): string;
}

function createStubWorld(offer: UpgradeOption[]): StubWorld {
  const world: StubWorld = {
    offer,
    scrap: 60,
    upgradeCost: 35,
    starCoins: 30,
    offerRerolls: 0,
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
        world.starCoins -= rerollPriceFor(world.offerRerolls);
        world.offerRerolls++;
      }
      return world.rerollCode;
    },
    checksum(): string {
      const offer = world.offer.map((o) => `${o.kind}:${o.type}:${o.level}`).join('|');
      const slots = world.weapons.map((s) => `${s.type}:${s.stars}`).join('|');
      return [offer, slots, world.scrap, world.starCoins, world.offerRerolls].join('#');
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

  it('show 渲染世界候选、玩家标题与跳过补偿', () => {
    setup();
    expect(headOf(dom).textContent).toBe('世界已暂停 · 三选一');
    expect(cardsOf(dom).children.length).toBe(3);
    const first = cardsOf(dom).children[0] as StubEl;
    expect(first.children.map((child) => child.textContent)).toEqual([
      cardIcon(world.offer[0] as UpgradeOption),
      cardTitle(world.offer[0] as UpgradeOption),
      cardDesc(world.offer[0] as UpgradeOption, worldAsWorld(world)),
      cardLevelText(world.offer[0] as UpgradeOption, worldAsWorld(world)),
      upgradeComparisonText(world.offer[0] as UpgradeOption, worldAsWorld(world)),
    ]);
    expect(skipOf(dom).textContent).toContain(String(UPGRADE_SKIP_STAR_COINS));
    expect(rerollOf(dom).textContent).toContain(String(rerollPriceFor(0)));
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
    expect((pickerSlotsOf(dom).children[1] as StubEl).textContent).toContain('★★');
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

  it('选卡阶段 Esc 不再是死键(二轮审查):flash 指路,不跳过、不结算', () => {
    setup();
    dom.key('Escape');
    expect(toastOf(dom).textContent).toBe('选一张卡,或点「跳过」结束这次升级');
    expect(world.skipCalls).toBe(0);
    expect(resolved).toBe(0);
    expect(panelOf(dom).style.display).toBe('flex'); // 仍留在选卡层
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

  it('重摇成功后重绘候选但不结算,按钮价随计数递增', () => {
    setup();
    world.offer = [newWeaponOpt(TOWER_RAILGUN), edictOpt(EDICT_COOLANT)];
    fire(rerollOf(dom), 'click');
    expect(world.rerollCalls).toBe(1);
    expect(resolved).toBe(0);
    // 首摇扣 5,星币 30 − 5 = 25 仍够第二摇 10:按钮不置灰,文案已换到下一摇的价
    expect(world.starCoins).toBe(30 - rerollPriceFor(0));
    expect(rerollOf(dom).textContent).toContain(String(rerollPriceFor(1)));
    expect(rerollOf(dom).disabled).toBe(false);
    expect((cardsOf(dom).children[0] as StubEl).children[1]?.textContent).toBe(cardTitle(world.offer[0] as UpgradeOption));
    expect((cardsOf(dom).children[2] as StubEl).style.display).toBe('none');
  });

  it('星币不足下一次递增价时重摇置灰,失败不消耗调用', () => {
    world.starCoins = rerollPriceFor(0) - 1;
    setup();
    expect(rerollOf(dom).disabled).toBe(true);
    expect(rerollOf(dom).textContent).toContain(String(rerollPriceFor(0)));
    fire(rerollOf(dom), 'click');
    expect(world.rerollCalls).toBe(0);
  });

  it('首摇后余额不足第二摇:置灰在摇完那一刻跟上', () => {
    world.starCoins = rerollPriceFor(0);
    setup();
    expect(rerollOf(dom).disabled).toBe(false);
    fire(rerollOf(dom), 'click');
    expect(world.rerollCalls).toBe(1);
    expect(world.starCoins).toBe(0);
    expect(rerollOf(dom).disabled).toBe(true); // 第二摇要 10,0 星币不够
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

  it('refreshLocale 切到 en 后重画文案:候选/World/phase 原地保留,不重掷、不结算', async () => {
    // 先进替换层(phase = REPLACE),验证切语言后替换层仍开着
    world.replaceNeeded = true;
    world.weapons[0] = { ...world.weapons[0] as WeaponSlot, type: TOWER_AUTOCANNON, stars: 1 };
    const flow = setup();
    fire(cardsOf(dom).children[0] as StubEl, 'click');
    expect(pickerOf(dom).style.display).toBe('flex');

    const beforeOffer = world.offer;
    const beforeChecksum = world.checksum();
    const takeCallsBefore = world.takeCalls.length;
    expect((cardsOf(dom).children[0] as StubEl).children[1]?.textContent).toContain('自动机炮');
    expect((pickerSlotsOf(dom).children[0] as StubEl).textContent).toContain('自动机炮');

    await changeLocale('en');
    flow.refreshLocale();

    expect(currentLocale()).toBe('en');
    // 世界一字未动:offer 同一份引用,星币/残骸/槽位/重摇位 checksum 不变,
    // refreshLocale 本身不新增任何结算调用(进替换层那一次 takeUpgrade 是点卡产生的)
    expect(world.offer).toBe(beforeOffer);
    expect(world.checksum()).toBe(beforeChecksum);
    expect(world.takeCalls.length).toBe(takeCallsBefore);
    expect(world.rerollCalls).toBe(0);
    expect(world.skipCalls).toBe(0);
    // 仍停在替换层(面板收着、替换层开着),phase 没被切走
    expect(pickerOf(dom).style.display).toBe('flex');
    expect(panelOf(dom).style.display).toBe('none');
    // 卡片与槽位文案翻成英文
    expect((cardsOf(dom).children[0] as StubEl).children[1]?.textContent).toBe(
      cardTitle(world.offer[0] as UpgradeOption),
    );
    const slot0 = pickerSlotsOf(dom).children[0] as StubEl;
    expect(slot0.textContent).toContain('Auto Cannon');
    expect(slot0.textContent).toContain('★');
    expect(pickerBackOf(dom).textContent).toContain('Back');
    expect(headOf(dom).textContent).toContain('Pick one');
    flow.hide();
  });

  it('refreshLocale 在选卡阶段同样重画候选/头部/按钮,且不自动选卡', async () => {
    const flow = setup();
    expect(panelOf(dom).style.display).toBe('flex');
    const beforeChecksum = world.checksum();
    expect((cardsOf(dom).children[0] as StubEl).children[1]?.textContent).toContain('自动机炮');

    await changeLocale('en');
    flow.refreshLocale();

    expect(world.checksum()).toBe(beforeChecksum);
    expect(world.rerollCalls).toBe(0);
    expect(world.takeCalls).toEqual([]);
    expect(panelOf(dom).style.display).toBe('flex'); // 面板仍开着
    expect(pickerOf(dom).style.display).toBe('none');
    expect(headOf(dom).textContent).toContain('Pick one');
    expect((cardsOf(dom).children[0] as StubEl).children[1]?.textContent).toBe(
      cardTitle(world.offer[0] as UpgradeOption),
    );
    expect(rerollOf(dom).textContent).toContain('Reroll');
    expect(skipOf(dom).textContent).toContain('Skip');
    flow.hide();
  });
});
