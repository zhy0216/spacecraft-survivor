/**
 * 标题界面的纯函数(不装 jsdom)。
 * 钉的是两句**给玩家看的话**,而它们各自守着一个不可逆的决定:
 * ① 存档摘要必须说清"继续的是什么"(尤其血量:接手一艘残血船而不自知是最坏的一种意外);
 * ② 「新航行」在有存档时必须把代价说出来 —— 二段确认的措辞里没有"放弃存档"四个字,
 *    这个二段确认就等于没有。
 *
 * 文件末尾破一次例去测「图鉴」按钮的接线(照 gameOver.test 的先例):
 * 它是四条出口里唯一"先收本页再弹别的页"的那一类 —— 点下去该收起自己并把去向
 * 交给 onCodex,漏一句 hide 就会叠两层遮罩。桩只提供 createTitleScreen 真的会碰的
 * 那几样(createElement/getElementById/append + window.addEventListener + HTMLElement),
 * 不装 jsdom。
 */
import { describe, expect, it } from 'vitest';
import type { RunSaveDigest } from '../sim/runSave';
import { createTitleScreen, continueLineText, newRunLabel } from './titleScreen';

const DIGEST: RunSaveDigest = {
  elapsedSec: 754,
  segment: 2,
  segmentCount: 4,
  kills: 318,
  hp: 63.4,
  maxHp: 115,
};

describe('标题界面:存档摘要那一行', () => {
  it('四个读数齐全:航段 / 时长 / 击杀 / 船体', () => {
    const line = continueLineText(DIGEST);
    expect(line).toContain('3/4'); // segment 是下标,玩家读的是第几段
    expect(line).toContain('12:34'); // 754s
    expect(line).toContain('318');
    expect(line).toContain('63/115'); // 血量取整,分子分母都印
  });

  it('脚本走完(已进 Boss 战)时印全通,而不是印出一个比总段数还大的数', () => {
    expect(continueLineText({ ...DIGEST, segment: 4 })).toContain('4/4');
    expect(continueLineText({ ...DIGEST, segment: 4 })).not.toContain('5/4');
  });

  it('满血与空血都印得出来(整取不留小数)', () => {
    expect(continueLineText({ ...DIGEST, hp: 115, maxHp: 115 })).toContain('115/115');
    expect(continueLineText({ ...DIGEST, hp: 0.4, maxHp: 100 })).toContain('0/100');
  });
});

describe('标题界面:「新航行」的二段确认', () => {
  it('没有存档 = 没有代价,一句话直说', () => {
    expect(newRunLabel(false, false)).toBe('开始航行');
  });

  it('有存档时第一下只是问话,且措辞里点明"放弃存档"', () => {
    expect(newRunLabel(true, false)).toBe('开始新航行');
    expect(newRunLabel(true, true)).toContain('放弃存档');
  });

  it('没有存档时不会问出一句无意义的确认', () => {
    // hasSave = false 时无论 confirming 是什么,文案都不该冒出"放弃存档"
    expect(newRunLabel(false, true)).toBe('开始航行');
  });
});

// —— 「图鉴」按钮接线(不装 jsdom,见文件头)——

interface StubEl {
  tagName: string;
  style: { cssText: string; display: string };
  textContent: string;
  children: StubEl[];
  listeners: Map<string, (e: unknown) => void>;
  append(...kids: StubEl[]): void;
  appendChild(kid: StubEl): StubEl;
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
    addEventListener(type: string, fn: (e: unknown) => void): void {
      el.listeners.set(type, fn);
    },
  };
  return el;
}

function installDom(): {
  created: StubEl[];
  restore(): void;
} {
  const g = globalThis as unknown as Record<string, unknown>;
  const prevWindow = g.window;
  const prevDocument = g.document;
  const prevHtmlElement = g.HTMLElement;
  const created: StubEl[] = [];
  const dom = {
    created,
    restore(): void {
      g.window = prevWindow;
      g.document = prevDocument;
      g.HTMLElement = prevHtmlElement;
    },
  };
  g.window = {
    addEventListener(): void {},
  };
  g.document = {
    createElement: (tag: string): StubEl => {
      const el = createStubEl(tag);
      created.push(el);
      return el;
    },
    getElementById: (id: string): StubEl | null => {
      if (id !== 'ui') return null;
      // #ui 本身:页面上唯一的既有节点,遮罩 append 到它里面
      const ui = createStubEl();
      return ui;
    },
    activeElement: null,
  };
  g.HTMLElement = class HTMLElement {};
  return dom;
}

describe('标题界面:「图鉴」按钮', () => {
  it('四颗按钮都在;点图鉴收起本页并把去向交给 onCodex', () => {
    const dom = installDom();
    try {
      let codexCalls = 0;
      const ui = createTitleScreen({
        onContinue() {},
        onNewRun() {},
        onSettings() {},
        onCodex() {
          codexCalls++;
        },
      });
      ui.show(null);
      const buttons = dom.created.filter((el) => el.tagName === 'BUTTON');
      const labels = buttons.map((b) => b.textContent);
      expect(labels).toEqual(['继续上次航行', '开始航行', '设置', '图鉴']);
      const codexBtn = buttons.find((b) => b.textContent === '图鉴')!;
      codexBtn.listeners.get('click')?.({});
      expect(codexCalls).toBe(1);
      expect(ui.visible()).toBe(false); // 收起本页 —— 漏这一句就叠两层遮罩
    } finally {
      dom.restore();
    }
  });
});
