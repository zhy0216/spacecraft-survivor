/**
 * 标题界面的纯函数(不装 jsdom)。
 * 钉的是两句**给玩家看的话**,而它们各自守着一个不可逆的决定:
 * ① 存档摘要必须说清"继续的是什么"(尤其血量:接手一艘残血船而不自知是最坏的一种意外);
 * ② 「新航行」在有存档时必须把代价说出来 —— 二段确认的措辞里没有"放弃存档"四个字,
 *    这个二段确认就等于没有。
 *
 * 04 号起两句纯函数走 t()(ui:menu.continueLine / newRun / newRunWithSave / abandonSave),
 * 故在 zh-CN 与 en 下各钉一遍;行为测试按 data-action 找按钮,不靠中文按钮文本。
 *
 * 文件末尾破一次例去测「图鉴」按钮的接线与 refreshLocale 保留二段确认状态
 * (照 gameOver.test 的先例)。桩只提供 createTitleScreen 真的会碰的那几样
 * (createElement/getElementById/append + window.addEventListener + HTMLElement),
 * 不装 jsdom。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { changeLocale, initI18n, t } from '../i18n';
import type { RunSaveDigest } from '../sim/runSave';
import { createTitleScreen, continueLineText, newRunLabel } from './titleScreen';

beforeEach(async () => {
  await initI18n('zh-CN');
});

const DIGEST: RunSaveDigest = {
  elapsedSec: 754,
  segment: 2,
  segmentCount: 4,
  kills: 318,
  hp: 63.4,
  maxHp: 115,
};

describe('标题界面:存档摘要那一行(zh-CN)', () => {
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

describe('标题界面:存档摘要那一行(en)', () => {
  it('句子结构由翻译决定:措辞与字段顺序跟 en 资源走', async () => {
    await changeLocale('en');
    const line = continueLineText(DIGEST);
    expect(line).toContain('Segment 3/4');
    expect(line).toContain('12:34');
    expect(line).toContain('Kills 318');
    expect(line).toContain('Hull 63/115');
  });
});

describe('标题界面:「新航行」的二段确认(zh-CN)', () => {
  it('没有存档 = 没有代价,一句话直说', () => {
    expect(newRunLabel(false, false)).toBe(t('ui:menu.newRun'));
  });

  it('有存档时第一下只是问话,且措辞里点明"放弃存档"', () => {
    expect(newRunLabel(true, false)).toBe(t('ui:menu.newRunWithSave'));
    expect(newRunLabel(true, true)).toContain('放弃存档');
  });

  it('没有存档时不会问出一句无意义的确认', () => {
    // hasSave = false 时无论 confirming 是什么,文案都不该冒出"放弃存档"
    expect(newRunLabel(false, true)).toBe(t('ui:menu.newRun'));
  });
});

describe('标题界面:「新航行」的二段确认(en)', () => {
  it('有存档时的有损确认在英文下也把"放弃存档"说清楚', async () => {
    await changeLocale('en');
    expect(newRunLabel(true, false)).toBe(t('ui:menu.newRunWithSave'));
    expect(newRunLabel(true, true)).toContain('abandon');
  });

  it('没有存档 = 一句话直说(Start Voyage)', async () => {
    await changeLocale('en');
    expect(newRunLabel(false, false)).toBe(t('ui:menu.newRun'));
  });
});

// —— 「图鉴」按钮接线 / refreshLocale(不装 jsdom,见文件头)——

interface StubEl {
  tagName: string;
  style: { cssText: string; display: string };
  textContent: string;
  dataset: Record<string, string>;
  children: StubEl[];
  listeners: Map<string, (e: unknown) => void>;
  append(...kids: StubEl[]): void;
  appendChild(kid: StubEl): StubEl;
  addEventListener(type: string, fn: (e: unknown) => void): void;
  setAttribute(name: string, value: string): void;
}

function createStubEl(tag = 'div'): StubEl {
  const el: StubEl = {
    tagName: tag.toUpperCase(),
    style: { cssText: '', display: '' },
    textContent: '',
    dataset: {},
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
    setAttribute(): void {},
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

/** 按 data-action 找按钮(04 号:行为测试不靠中文按钮文本) */
function findAction(created: StubEl[], action: string): StubEl | undefined {
  return created.find((el) => el.tagName === 'BUTTON' && el.dataset.action === action);
}

describe('标题界面:按钮接线与语言切换', () => {
  it('四颗动作按钮都在(data-action);点图鉴收起本页并把去向交给 onCodex', () => {
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
      const actions = dom.created
        .filter((el) => el.tagName === 'BUTTON')
        .map((b) => b.dataset.action);
      expect(actions).toEqual(['title-continue', 'title-new-run', 'title-settings', 'title-codex']);
      const codexBtn = findAction(dom.created, 'title-codex')!;
      codexBtn.listeners.get('click')?.({});
      expect(codexCalls).toBe(1);
      expect(ui.visible()).toBe(false); // 收起本页 —— 漏这一句就叠两层遮罩
    } finally {
      dom.restore();
    }
  });

  it('refreshLocale 保留二段确认状态:切到 en 后问话重说、按钮不重建、下一击仍开新局', async () => {
    const dom = installDom();
    try {
      let newRuns = 0;
      const ui = createTitleScreen({
        onContinue() {},
        onNewRun() {
          newRuns++;
        },
        onSettings() {},
        onCodex() {},
      });
      ui.show(DIGEST);
      const newBtn = findAction(dom.created, 'title-new-run')!;
      newBtn.listeners.get('click')?.({}); // 第一下:进入二段确认
      expect(newBtn.textContent).toBe(t('ui:menu.abandonSave'));
      expect(ui.visible()).toBe(true);

      await changeLocale('en');
      ui.refreshLocale();
      // confirming 状态保持、文案翻成 en,且还是同一颗按钮(只改文案,不重建)
      expect(findAction(dom.created, 'title-new-run')).toBe(newBtn);
      expect(newBtn.textContent).toContain('abandon');
      expect(ui.visible()).toBe(true);
      // 二段确认的第二下仍然生效:点下去就真的开新局
      newBtn.listeners.get('click')?.({});
      expect(newRuns).toBe(1);
      expect(ui.visible()).toBe(false);
    } finally {
      dom.restore();
    }
  });

  it('有存档时按钮主次不随语言变:主按钮仍是「继续」,新航行保持二段确认', async () => {
    const dom = installDom();
    try {
      const ui = createTitleScreen({ onContinue() {}, onNewRun() {}, onSettings() {}, onCodex() {} });
      ui.show(DIGEST);
      const continueBtn = findAction(dom.created, 'title-continue')!;
      expect(continueBtn.style.cssText).toContain('rgba(43,74,110,.6)'); // PRIMARY_CSS 底色更实
      await changeLocale('en');
      ui.refreshLocale();
      expect(continueBtn.style.cssText).toContain('rgba(43,74,110,.6)'); // 主按钮地位不变
      expect(continueBtn.textContent).toBe(t('ui:menu.continueRun'));
    } finally {
      dom.restore();
    }
  });
});
