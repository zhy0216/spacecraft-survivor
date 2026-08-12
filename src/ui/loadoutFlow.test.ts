/**
 * 起手配置选择界面(20 号 issue)。
 * 主体测的是导出的**纯函数** —— 掩码 → 卡片视图这条数据链:锁没锁、条件文案、甲板示意图,
 * 三种都只是字符串/布尔拼装,却决定玩家开局第一眼看到什么,Node 里逐字段钉最便宜。
 * 文件末尾**破一次例**去测 createLoadoutFlow 本身(理由与 ui/gameOver.test.ts 文件头一致):
 * "选卡 → 开跑"是 20 号验收主流程,只建一次 / 收着时不认键 / 锁着的卡点了不许开船,
 * 三条各错一次的后果(一次按键选好几局、战斗中误按数字把正打着的局换掉、锁卡也能选)
 * 都要等真人重开第二局才看得见。桩只提供 createLoadoutFlow 真的会碰的那几样,
 * 绝不发展成半个 jsdom(本仓的 vitest 跑在 Node 环境里,不装 jsdom)。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOADOUTS } from '../data/loadout';
import {
  COND_ELITE_KILLS,
  COND_FIRST_WIN,
  COND_KILLS,
  COND_NONE,
  UNLOCK_LOADOUT,
  UNLOCKS,
} from '../data/unlocks';
import {
  createLoadoutFlow,
  loadoutCards,
  loadoutConditionText,
  loadoutDiagram,
  loadoutUnlockIndex,
  loadoutUnlocked,
} from './loadoutFlow';

describe('loadoutDiagram', () => {
  it('标准起手:槽位文本图,双机炮占前两个武器槽(共 8 格),法令行印开局那一条', () => {
    const diagram = loadoutDiagram(LOADOUTS[0]!);
    const lines = diagram.split('\n');
    expect(lines[0]).toBe('武器 [机][机][·][·][·][·][·][·]');
    expect(lines[1]).toBe('法令 弹');
    expect(lines[2]).toBe('↑ 船头');
    expect(lines).toHaveLength(3); // 只有武器/法令/船头三行,没有别的
  });

  it('狙击开局:双磁轨炮并踞前两个武器槽', () => {
    const diagram = loadoutDiagram(LOADOUTS[3]!);
    expect(diagram.split('\n')[0]).toBe('武器 [轨][轨][·][·][·][·][·][·]');
  });
});

describe('loadoutUnlockIndex / loadoutUnlocked', () => {
  it('无条件配置无门禁(-1,恒开);有门禁的配置指到 UNLOCKS 里那条锁', () => {
    expect(loadoutUnlockIndex(0)).toBe(-1);
    expect(loadoutUnlockIndex(1)).toBe(-1);
    expect(loadoutUnlocked(0, 0)).toBe(true);
    expect(loadoutUnlocked(1, 0)).toBe(true);
    for (const idx of [2, 3]) {
      const gate = loadoutUnlockIndex(idx);
      expect(gate).toBeGreaterThanOrEqual(0);
      const entry = UNLOCKS[gate]!;
      expect(entry.kind).toBe(UNLOCK_LOADOUT);
      expect(entry.type).toBe(idx);
      // 锁与配置同名:解锁 toast / 图鉴 / 卡片读的是同一个名字(两表各存一份的同步钉)
      expect(entry.name).toBe(LOADOUTS[idx]!.name);
    }
    // 掩码那位不开 = 锁着;开了 = 可用
    const gate2 = loadoutUnlockIndex(2)!;
    expect(loadoutUnlocked(2, 1 << gate2)).toBe(true);
    expect(loadoutUnlocked(2, 0)).toBe(false);
  });
});

describe('loadoutConditionText', () => {
  it('四类条件各有玩家文案;未知编号印码,不静默当成无条件', () => {
    expect(loadoutConditionText({ id: 'x', name: 'x', kind: UNLOCK_LOADOUT, type: 0, condition: { kind: COND_FIRST_WIN, target: 0 } })).toBe('通关 1 局解锁');
    expect(loadoutConditionText({ id: 'x', name: 'x', kind: UNLOCK_LOADOUT, type: 0, condition: { kind: COND_KILLS, target: 150 } })).toBe('单局击杀 150 解锁');
    expect(loadoutConditionText({ id: 'x', name: 'x', kind: UNLOCK_LOADOUT, type: 0, condition: { kind: COND_ELITE_KILLS, target: 5 } })).toBe('累计击杀 5 只精英解锁');
    expect(loadoutConditionText({ id: 'x', name: 'x', kind: UNLOCK_LOADOUT, type: 0, condition: { kind: COND_NONE, target: 0 } })).toBe('无条件解锁');
    expect(loadoutConditionText({ id: 'x', name: 'x', kind: UNLOCK_LOADOUT, type: 0, condition: { kind: 99, target: 0 } })).toBe('条件 99 解锁');
  });
});

describe('loadoutCards', () => {
  it('掩码 0:前两条可用,后两条灰显并带各自的条件文案', () => {
    const cards = loadoutCards(0);
    expect(cards).toHaveLength(LOADOUTS.length);
    expect(cards[0]!.unlocked).toBe(true);
    expect(cards[1]!.unlocked).toBe(true);
    expect(cards[2]!.unlocked).toBe(false);
    expect(cards[2]!.conditionText).toBe('累计击杀 5 只精英解锁');
    expect(cards[3]!.unlocked).toBe(false);
    expect(cards[3]!.conditionText).toBe('单局击杀 150 解锁');
    // 已解锁的卡片不挂条件文案
    expect(cards[0]!.conditionText).toBe('');
  });

  it('掩码全开:四条全部可用', () => {
    const full = (1 << UNLOCKS.length) - 1;
    for (const card of loadoutCards(full)) expect(card.unlocked).toBe(true);
  });
});

// —— 以下只服务 createLoadoutFlow 那几条(破例的理由见文件头)——

interface StubEl {
  tagName: string;
  style: { cssText: string; display: string };
  textContent: string;
  children: StubEl[];
  listeners: Map<string, (e: unknown) => void>;
  append(...kids: StubEl[]): void;
  appendChild(kid: StubEl): StubEl;
  replaceChildren(...kids: StubEl[]): void;
  addEventListener(type: string, fn: (e: unknown) => void): void;
}

function createStubEl(tag = 'div'): StubEl {
  const el: StubEl = {
    tagName: tag.toUpperCase(),
    style: { cssText: '', display: '' },
    textContent: '',
    children: [],
    listeners: new Map<string, (e: unknown) => void>(),
    append(...kids: StubEl[]): void {
      el.children.push(...kids);
    },
    appendChild(kid: StubEl): StubEl {
      el.children.push(kid);
      return kid;
    },
    replaceChildren(...kids: StubEl[]): void {
      el.children.length = 0;
      el.children.push(...kids);
    },
    addEventListener(type: string, fn: (e: unknown) => void): void {
      el.listeners.set(type, fn);
    },
  };
  return el;
}

interface StubKeyEvent {
  code: string;
  repeat: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
}

function keyEvent(code: string, repeat = false): StubKeyEvent {
  const e: StubKeyEvent = {
    code,
    repeat,
    defaultPrevented: false,
    preventDefault(): void {
      e.defaultPrevented = true;
    },
  };
  return e;
}

interface StubDom {
  ui: StubEl;
  windowListeners: number;
  created: StubEl[];
  key(e: StubKeyEvent): void;
  restore(): void;
}

function installDom(): StubDom {
  const g = globalThis as unknown as Record<string, unknown>;
  const prevWindow = g.window;
  const prevDocument = g.document;
  const prevHtmlElement = g.HTMLElement;
  const keys: Array<(e: StubKeyEvent) => void> = [];

  const dom: StubDom = {
    ui: createStubEl(),
    windowListeners: 0,
    created: [],
    key(e: StubKeyEvent): void {
      for (const fn of keys) fn(e);
    },
    restore(): void {
      g.window = prevWindow;
      g.document = prevDocument;
      g.HTMLElement = prevHtmlElement;
    },
  };

  g.window = {
    addEventListener(type: string, fn: (e: StubKeyEvent) => void): void {
      dom.windowListeners++;
      if (type === 'keydown') keys.push(fn);
    },
  };
  g.document = {
    createElement: (tag: string): StubEl => {
      const el = createStubEl(tag);
      dom.created.push(el);
      return el;
    },
    getElementById: (id: string): StubEl | null => (id === 'ui' ? dom.ui : null),
    // isTyping 读它:null = 焦点不在输入框里
    activeElement: null,
  };
  // Node 里没有 HTMLElement,而 isTyping 拿它做 instanceof —— 不给就直接 ReferenceError
  g.HTMLElement = class HTMLElement {};
  return dom;
}

/** 遮罩 = #ui 的唯一子节点;面板 = 遮罩的唯一子节点 */
function panel(dom: StubDom): StubEl {
  return dom.ui.children[0]!.children[0]!;
}

/** 四张卡 = 面板里 grid 的四个子节点(标题/提示/grid 的构造顺序固定,见 createLoadoutFlow) */
function cards(dom: StubDom): StubEl[] {
  return panel(dom).children[2]!.children;
}

/** 深度查找:textContent 精确匹配(卡片上的名字/条件文案都是 leaf) */
function findText(rootEl: StubEl, text: string): StubEl | undefined {
  if (rootEl.textContent === text) return rootEl;
  for (const kid of rootEl.children) {
    const hit = findText(kid, text);
    if (hit) return hit;
  }
  return undefined;
}

describe('createLoadoutFlow', () => {
  let dom: StubDom;
  let picked: number[];

  beforeEach(() => {
    dom = installDom();
    picked = [];
  });
  afterEach(() => {
    dom.restore();
  });

  function make(): ReturnType<typeof createLoadoutFlow> {
    return createLoadoutFlow({
      onSelect: (i) => {
        picked.push(i);
      },
    });
  }

  it('默认收着;show 弹出四张卡,已解锁卡带点击、锁卡不带', () => {
    const ui = make();
    expect(dom.ui.children[0]!.style.cssText).toContain('display:none');

    ui.show(0);
    expect(dom.ui.children[0]!.style.display).toBe('flex');
    const cardEls = cards(dom);
    expect(cardEls).toHaveLength(LOADOUTS.length);
    // 前两张无条件:有点击;后两张锁着:没有点击监听器(点了也不许开船)
    expect(cardEls[0]!.listeners.has('click')).toBe(true);
    expect(cardEls[1]!.listeners.has('click')).toBe(true);
    expect(cardEls[2]!.listeners.has('click')).toBe(false);
    expect(cardEls[3]!.listeners.has('click')).toBe(false);
    // 锁卡灰显 + 印条件文案;名称与甲板示意图都在卡片里
    expect(cardEls[2]!.style.cssText).toContain('opacity:.45');
    expect(findText(cardEls[2]!, '累计击杀 5 只精英解锁')).toBeDefined();
    expect(findText(cardEls[2]!, '炮击开局')).toBeDefined();
  });

  it('点击已解锁卡 = 选择该卡,面板当场收起;点击锁卡毫无反应', () => {
    const ui = make();
    ui.show(0);
    cards(dom)[1]!.listeners.get('click')!(undefined);
    expect(picked).toEqual([1]);
    expect(dom.ui.children[0]!.style.display).toBe('none');

    ui.show(0);
    expect(cards(dom)[2]!.listeners.has('click')).toBe(false);
    expect(picked).toEqual([1]);
  });

  it('数字键 1–4 选择对应卡(按下标-1);锁卡的数字键被忽略', () => {
    const ui = make();
    ui.show(0);
    dom.key(keyEvent('Digit1'));
    dom.key(keyEvent('Digit3')); // 锁着的炮击开局
    expect(picked).toEqual([0]);
    // 选完面板收起,再按数字也不触发(visible 守卫)
    dom.key(keyEvent('Digit2'));
    expect(picked).toEqual([0]);
  });

  it('收着的时候数字键一律不认 —— 战斗中误按数字不该换掉正打着的局', () => {
    const ui = make();
    dom.key(keyEvent('Digit1'));
    expect(picked).toEqual([]);
  });

  it('长按不连发(repeat)、越界数字键、非数字键一概不管', () => {
    const ui = make();
    ui.show(0);
    dom.key(keyEvent('Digit1', true));
    dom.key(keyEvent('Digit0'));
    dom.key(keyEvent('Digit5'));
    dom.key(keyEvent('KeyA'));
    expect(picked).toEqual([]);
  });

  it('只建一次:show/hide 多少回都不再 append DOM、不再挂 window 监听器', () => {
    const ui = make();
    const listeners = dom.windowListeners;
    expect(listeners).toBeGreaterThan(0);
    expect(dom.ui.children.length).toBe(1);

    for (let i = 0; i < 3; i++) {
      ui.show(0);
      ui.hide();
    }
    expect(dom.windowListeners).toBe(listeners);
    expect(dom.ui.children.length).toBe(1);
  });

  it('show 用最新掩码重排:全解锁后锁卡变可选,条件文案消失', () => {
    const ui = make();
    ui.show(0);
    expect(cards(dom)[2]!.listeners.has('click')).toBe(false);

    const full = (1 << UNLOCKS.length) - 1;
    ui.show(full);
    const cardEls = cards(dom);
    expect(cardEls[2]!.listeners.has('click')).toBe(true);
    expect(cardEls[2]!.style.cssText).not.toContain('opacity');
    expect(findText(cardEls[2]!, '累计击杀 5 只精英解锁')).toBeUndefined();
    cardEls[3]!.listeners.get('click')!(undefined);
    expect(picked).toEqual([3]);
  });
});
