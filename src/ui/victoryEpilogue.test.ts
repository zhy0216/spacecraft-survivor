import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changeLocale, initI18n } from '../i18n';
import { createVictoryEpilogue } from './victoryEpilogue';

interface StubEl {
  tagName: string;
  style: { cssText: string; display: string };
  textContent: string;
  src: string;
  alt: string;
  draggable: boolean;
  tabIndex: number;
  children: StubEl[];
  listeners: Map<string, (e: unknown) => void>;
  /** setAttribute 的记录(aria-label 断言用) */
  attrs: Record<string, string>;
  append(...kids: StubEl[]): void;
  appendChild(kid: StubEl): StubEl;
  addEventListener(type: string, fn: (e: unknown) => void): void;
  setAttribute(name: string, value: string): void;
  focus(): void;
}

function createStubEl(tag = 'div'): StubEl {
  const el: StubEl = {
    tagName: tag.toUpperCase(),
    style: { cssText: '', display: '' },
    textContent: '',
    src: '',
    alt: '',
    draggable: true,
    tabIndex: -1,
    children: [],
    listeners: new Map(),
    attrs: {},
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
    setAttribute(name: string, value: string): void {
      el.attrs[name] = value;
    },
    focus(): void {},
  };
  return el;
}

interface StubKeyEvent {
  code: string;
  repeat: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
}

function keyEvent(code: string): StubKeyEvent {
  const e: StubKeyEvent = {
    code,
    repeat: false,
    defaultPrevented: false,
    preventDefault(): void {
      e.defaultPrevented = true;
    },
  };
  return e;
}

describe('胜利终幕', () => {
  let uiRoot: StubEl;
  let created: StubEl[];
  let keyHandlers: Array<(e: StubKeyEvent) => void>;
  let restore: () => void;

  beforeEach(async () => {
    await initI18n('zh-CN');
    const g = globalThis as unknown as Record<string, unknown>;
    const prevWindow = g.window;
    const prevDocument = g.document;
    const prevHtmlElement = g.HTMLElement;
    uiRoot = createStubEl();
    created = [];
    keyHandlers = [];
    g.window = {
      addEventListener(type: string, fn: (e: StubKeyEvent) => void): void {
        if (type === 'keydown') keyHandlers.push(fn);
      },
    };
    g.document = {
      createElement(tag: string): StubEl {
        const el = createStubEl(tag);
        created.push(el);
        return el;
      },
      getElementById(id: string): StubEl | null {
        return id === 'ui' ? uiRoot : null;
      },
      activeElement: null,
    };
    g.HTMLElement = class HTMLElement {};
    restore = () => {
      g.window = prevWindow;
      g.document = prevDocument;
      g.HTMLElement = prevHtmlElement;
    };
  });

  afterEach(() => restore());

  it('默认隐藏；show 后铺满画面并保留明确的故事钩子', () => {
    const epilogue = createVictoryEpilogue({ onClose() {} });
    const root = uiRoot.children[0]!;
    expect(root.style.cssText).toContain('position:fixed;inset:0');
    expect(root.style.cssText).toContain('display:none');
    const image = created.find((el) => el.tagName === 'IMG')!;
    expect(image.src).toContain('victory-epilogue-nanobanana');
    expect(image.style.cssText).toContain('object-fit:cover');
    expect(created.some((el) => el.textContent.includes('只是守门者'))).toBe(true);
    expect(created.some((el) => el.textContent.includes('下一次航行'))).toBe(true);

    epilogue.show();
    expect(root.style.display).toBe('block');
    expect(epilogue.visible()).toBe(true);
  });

  it('点击整张图或按 Enter 都只返回一次主菜单；隐藏时按键不误触', () => {
    let closes = 0;
    const epilogue = createVictoryEpilogue({ onClose: () => closes++ });
    const root = uiRoot.children[0]!;

    keyHandlers[0]!(keyEvent('Enter'));
    expect(closes).toBe(0);

    epilogue.show();
    root.listeners.get('click')?.({});
    expect(closes).toBe(1);
    expect(epilogue.visible()).toBe(false);

    epilogue.show();
    const e = keyEvent('Enter');
    keyHandlers[0]!(e);
    expect(e.defaultPrevented).toBe(true);
    expect(closes).toBe(2);
    keyHandlers[0]!(keyEvent('Enter'));
    expect(closes).toBe(2);
  });

  it('refreshLocale 只重画文案:叙事/aria/alt 翻成英文,不重播、不触发 onClose(09 号)', async () => {
    let closes = 0;
    const epilogue = createVictoryEpilogue({ onClose: () => closes++ });
    const root = uiRoot.children[0]!;
    const image = created.find((el) => el.tagName === 'IMG')!;
    epilogue.show();
    expect(root.attrs['aria-label']).toBe('胜利终幕,点击返回主菜单');
    expect(image.alt).toContain('拼装舰穿过破碎的甲虫 Boss');

    await changeLocale('en');
    epilogue.refreshLocale();
    // 叙事整块翻成英文
    expect(root.attrs['aria-label']).toBe('Victory epilogue, click to return to the title');
    expect(image.alt).toContain('Boss');
    expect(created.some((el) => el.textContent === 'Voyage log · past the cordon')).toBe(true);
    expect(created.some((el) => el.textContent === 'There is still starlight beyond the gate')).toBe(
      true,
    );
    expect(created.some((el) => el.textContent.includes('gatekeeper'))).toBe(true);
    expect(created.some((el) => el.textContent === 'Next voyage · chase the signal')).toBe(true);
    expect(created.some((el) => el.textContent.includes('Enter to return to the title'))).toBe(
      true,
    );
    // 不重播/不重置:仍显示着、可见性不变、onClose 不触发
    expect(root.style.display).toBe('block');
    expect(epilogue.visible()).toBe(true);
    expect(closes).toBe(0);

    // 切回 zh 也原地换回,监听器仍只有最初那一条
    await changeLocale('zh-CN');
    epilogue.refreshLocale();
    expect(root.attrs['aria-label']).toBe('胜利终幕,点击返回主菜单');
    expect(created.some((el) => el.textContent.includes('只是守门者'))).toBe(true);
    expect(keyHandlers.length).toBe(1);
    expect(closes).toBe(0);
  });
});
