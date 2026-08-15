import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEdictLevels } from '../data/edicts';
import { TOWER_AUTOCANNON, TOWER_LASER } from '../data/towers';
import { createWeaponSlots, type WeaponSlot } from '../sim/armory';
import { createEdictBuffs } from '../sim/edictBuffs';
import type { World } from '../sim/world';
import { changeLocale, initI18n, t } from '../i18n';
import { createArmoryPanel } from './armoryPanel';

interface StubEl {
  tagName: string;
  src: string;
  alt: string;
  style: Record<string, string>;
  textContent: string;
  innerHTML: string;
  disabled: boolean;
  children: StubEl[];
  handlers: Map<string, Array<() => void>>;
  append(...children: StubEl[]): void;
  appendChild(child: StubEl): StubEl;
  addEventListener(type: string, handler: () => void): void;
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
    addEventListener(type, handler): void {
      const handlers = element.handlers.get(type) ?? [];
      handlers.push(handler);
      element.handlers.set(type, handlers);
    },
  };
  return element;
}

function fire(element: StubEl, type: string): void {
  for (const handler of element.handlers.get(type) ?? []) handler();
}

/** 在桩树里找包含某段文字的节点(桩的 textContent 不聚合子节点,要递归拼) */
function findText(root: StubEl, part: string): boolean {
  if (root.textContent.includes(part)) return true;
  for (const child of root.children) {
    if (findText(child, part)) return true;
  }
  return false;
}

function installDom(): { ui: StubEl; restore(): void } {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previousWindow = globals.window;
  const previousDocument = globals.document;
  const ui = createStubEl();
  globals.window = { addEventListener(): void {} };
  globals.document = {
    createElement: (tagName: string): StubEl => createStubEl(tagName),
    getElementById: (id: string): StubEl | null => id === 'ui' ? ui : null,
  };
  return {
    ui,
    restore(): void {
      globals.window = previousWindow;
      globals.document = previousDocument;
    },
  };
}

function createWorld(): World {
  const weapons = createWeaponSlots();
  weapons[0]!.type = TOWER_AUTOCANNON;
  weapons[0]!.stars = 1;
  weapons[2]!.type = TOWER_LASER;
  weapons[2]!.stars = 2;
  const world = {
    weapons,
    ship: { hp: 80, maxHp: 100 },
    buffs: createEdictBuffs(),
    edictLevels: createEdictLevels(),
    swapWeapons(a: number, b: number): number {
      const first: WeaponSlot = weapons[a]!;
      weapons[a] = weapons[b]!;
      weapons[b] = first;
      return 0;
    },
  };
  return world as unknown as World;
}

describe('舰船背包面板', () => {
  let dom: ReturnType<typeof installDom>;

  beforeEach(async () => {
    await initI18n('zh-CN');
    dom = installDom();
  });
  afterEach(() => dom.restore());

  it('与商店共用完整舰船图，点两个真实朝向槽交换武器', () => {
    const world = createWorld();
    let opened = 0;
    const panel = createArmoryPanel({
      canOpen: () => true,
      onOpen: () => { opened++; },
      onClose: () => {},
    });
    panel.setWorld(world);
    panel.show();

    const root = dom.ui.children[0]!;
    const diagram = root.children[0]!;
    const head = diagram.children[0]!;
    const ring = diagram.children[2]!;
    const chipLayer = ring.children[ring.children.length - 1]!;
    // 环里最后一层是卡片、倒数第二层是炮位贴图层,再往前一层才是舰壳图(两层叠放保证可点)
    const hullArt = ring.children[ring.children.length - 3]!;
    const chips = chipLayer.children;

    expect(opened).toBe(1);
    expect(((head.children[0] as StubEl).children[1] as StubEl).textContent).toBe('舰船背包');
    expect(hullArt.tagName).toBe('IMG');
    expect(hullArt.src).toContain('scrapper-hull.png');
    expect(findText(chips[0]!, '正前')).toBe(true);
    expect(findText(chips[2]!, '正右')).toBe(true);

    fire(chips[0]!, 'click');
    expect(panel.selected()).toBe(0);
    expect(chips[0]!.style.border).toContain('#ffd479');
    fire(chips[2]!, 'click');
    expect(panel.selected()).toBe(-1);
    expect(world.weapons[0]!.type).toBe(TOWER_LASER);
    expect(world.weapons[2]!.type).toBe(TOWER_AUTOCANNON);
  });

  it('舰船图上装备的武器在硬点可见,换位后炮位贴图实时跟上', () => {
    const world = createWorld();
    const panel = createArmoryPanel({
      canOpen: () => true,
      onOpen: () => {},
      onClose: () => {},
    });
    panel.setWorld(world);
    panel.show();

    const root = dom.ui.children[0]!;
    const diagram = root.children[0]!;
    const ring = diagram.children[2]!;
    const chipLayer = ring.children[ring.children.length - 1]!;
    const turretLayer = ring.children[ring.children.length - 2]!;
    const turrets = turretLayer.children;
    const chips = chipLayer.children;

    // 槽 0 = 自动炮、槽 2 = 激光:炮位贴图按真实朝向落在硬点上,换位前 src 跟着各自槽位走
    expect(turrets[0]!.style.display).toBe('block');
    expect(turrets[0]!.style.opacity).toBe('1');
    expect(turrets[0]!.src).toContain('autocannon');
    expect(turrets[2]!.style.transform).toContain('rotate(90deg)');

    fire(chips[0]!, 'click');
    fire(chips[2]!, 'click');

    // 换位后炮头实时换位:槽 0 现在装激光,槽 2 现在装自动炮 —— 不是等关掉面板才更新
    expect(turrets[0]!.src).toContain('laser');
    expect(turrets[2]!.src).toContain('autocannon');
  });

  it('悬停已装武器的槽弹描述 tooltip(名称★星级/当前星级数值/持续火力),空槽与移开即隐', () => {
    const world = createWorld();
    const panel = createArmoryPanel({
      canOpen: () => true,
      onOpen: () => {},
      onClose: () => {},
    });
    panel.setWorld(world);
    panel.show();

    const root = dom.ui.children[0]!;
    const diagram = root.children[0]!;
    const ring = diagram.children[2]!;
    const chipLayer = ring.children[ring.children.length - 1]!;
    const chips = chipLayer.children;
    // tooltip 挂在舰船图 root 的末尾(头/HP 条/环/脚部的下标不因它挪位)
    const tip = diagram.children[diagram.children.length - 1]!;

    expect(tip.style.display).toBe('none');

    fire(chips[0]!, 'mouseenter');
    expect(tip.style.display).toBe('block');
    expect(tip.textContent).toContain('自动机炮 ★ · 弹药系');
    expect(tip.textContent).toContain('伤害');
    expect(tip.textContent).toContain('射程');
    expect(tip.textContent).toContain('持续火力');
    expect(tip.style.left).toBe('8px'); // 桩 DOM 报不出几何,夹回左缘
    expect(tip.style.top).toBe('14px');

    fire(chips[0]!, 'mouseleave');
    expect(tip.style.display).toBe('none');

    // 空槽不弹描述
    fire(chips[1]!, 'mouseenter');
    expect(tip.style.display).toBe('none');
  });

  it('换位后描述 tooltip 收起(世界变了,旧描述不许还悬着)', () => {
    const world = createWorld();
    const panel = createArmoryPanel({
      canOpen: () => true,
      onOpen: () => {},
      onClose: () => {},
    });
    panel.setWorld(world);
    panel.show();

    const root = dom.ui.children[0]!;
    const diagram = root.children[0]!;
    const ring = diagram.children[2]!;
    const chipLayer = ring.children[ring.children.length - 1]!;
    const chips = chipLayer.children;
    const tip = diagram.children[diagram.children.length - 1]!;

    fire(chips[0]!, 'mouseenter');
    expect(tip.style.display).toBe('block');
    fire(chips[0]!, 'click');
    expect(tip.style.display).toBe('none');
  });

  it('refreshLocale(05 号):切到 en 后标题/槽位朝向翻新,选择态与交换态原地保留', async () => {
    const world = createWorld();
    const panel = createArmoryPanel({
      canOpen: () => true,
      onOpen: () => {},
      onClose: () => {},
    });
    panel.setWorld(world);
    panel.show();

    const root = dom.ui.children[0]!;
    const diagram = root.children[0]!;
    const head = diagram.children[0]!;
    const ring = diagram.children[2]!;
    const chipLayer = ring.children[ring.children.length - 1]!;
    const chips = chipLayer.children;

    // 选中槽 0 后切语言:选择态必须保留(只重画文案,不动 picked)
    fire(chips[0]!, 'click');
    expect(panel.selected()).toBe(0);
    const zhBorder = chips[0]!.style.border;

    await changeLocale('en');
    panel.refreshLocale();

    // 标题与朝向翻新
    expect(((head.children[0] as StubEl).children[1] as StubEl).textContent).toBe(t('ui:armory.title'));
    expect(findText(chips[0]!, 'Forward')).toBe(true);
    expect(findText(chips[2]!, 'Right')).toBe(true);
    // 选择态保留:选中格描边原样,点另一格仍完成交换
    expect(panel.selected()).toBe(0);
    expect(chips[0]!.style.border).toBe(zhBorder);
    fire(chips[2]!, 'click');
    expect(panel.selected()).toBe(-1);
    expect(world.weapons[0]!.type).toBe(TOWER_LASER);
    expect(world.weapons[2]!.type).toBe(TOWER_AUTOCANNON);
    await changeLocale('zh-CN');
  });
});
