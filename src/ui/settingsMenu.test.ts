/**
 * 设置页的语言行(02 号)。用的是与 pauseMenu.test 同款桩 DOM(不装 jsdom)。
 * 钉四条行为:
 * ① 语言走 onLanguage 单独一条路 —— 点击**绝不**调 onChange(那是"即改即存"的通用通道,
 *    语言切换是异步的、成败未定,过早落盘会把一个没生效的值写进设置);
 * ② 循环顺序 自动 → 简体中文 → English → 自动(与 settings.nextLanguage 同源);
 * ③ refreshLocale 只重画语言行文案(语言切换成功后由 main 统一触发)——
 *    换到 en 后行标签从「语言」变「Language」,auto 档自称从「自动」变「Auto」;
 * ④ 切换失败:showLocaleError 亮出可读错误,下次 show 复位(与暂停菜单同一条"那次结论不留"口径)。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changeLocale, initI18n, t } from '../i18n';
import type { LanguagePreference } from '../i18n';
import { createSettingsMenu, type SettingsMenuHooks } from './settingsMenu';
import type { Settings } from './settings';
import { createSettings } from './settings';

interface StubEl {
  tagName: string;
  style: { cssText: string; color: string; display: string };
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
    style: { cssText: '', color: '', display: '' },
    textContent: '',
    children: [],
    listeners: new Map(),
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
  let cssText = '';
  Object.defineProperty(el.style, 'cssText', {
    get: () => cssText,
    set: (v: string) => {
      cssText = v;
      if (v.includes('display:none')) el.style.display = 'none';
    },
  });
  return el;
}

interface StubDom {
  ui: StubEl;
  created: StubEl[];
  restore(): void;
}

function installDom(): StubDom {
  const g = globalThis as unknown as Record<string, unknown>;
  const prevWindow = g.window;
  const prevDocument = g.document;
  const prevHtmlElement = g.HTMLElement;
  const created: StubEl[] = [];
  const ui = createStubEl();
  const dom: StubDom = {
    ui,
    created,
    restore(): void {
      g.window = prevWindow;
      g.document = prevDocument;
      g.HTMLElement = prevHtmlElement;
    },
  };
  g.window = { addEventListener(): void {} };
  g.document = {
    createElement: (tag: string): StubEl => {
      const el = createStubEl(tag);
      created.push(el);
      return el;
    },
    getElementById: (id: string): StubEl | null => (id === 'ui' ? ui : null),
    activeElement: null,
  };
  g.HTMLElement = class HTMLElement {};
  return dom;
}

function card(dom: StubDom): StubEl {
  return dom.ui.children[0]!.children[0]!;
}

/** 卡里 textContent 匹配的那枚按钮(语言行按钮 / 其它行) */
function findButton(dom: StubDom, text: string): StubEl | undefined {
  const walk = (el: StubEl): StubEl | undefined => {
    if (el.tagName === 'BUTTON' && el.textContent === text) return el;
    for (const kid of el.children) {
      const hit = walk(kid);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(card(dom));
}

/** 按行标签找一行(语言行 = 标签「语言」所在行),返回该行的按钮 */
function rowButton(dom: StubDom, label: string): StubEl | undefined {
  const walk = (el: StubEl): StubEl | undefined => {
    if (el.children.some((k) => k.textContent === label)) {
      return el.children.find((k) => k.tagName === 'BUTTON');
    }
    for (const kid of el.children) {
      const hit = walk(kid);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(card(dom));
}

describe('createSettingsMenu:语言行', () => {
  let dom: StubDom;
  let current: Settings;
  let onLanguageCalls: LanguagePreference[];
  let onChangeCalls: number;

  function make(): ReturnType<typeof createSettingsMenu> {
    const hooks: SettingsMenuHooks = {
      get: () => current,
      onChange: () => {
        onChangeCalls++;
      },
      onLanguage: (next) => {
        onLanguageCalls.push(next);
      },
      onClose: () => {},
    };
    return createSettingsMenu(hooks);
  }

  beforeEach(async () => {
    dom = installDom();
    current = createSettings();
    onLanguageCalls = [];
    onChangeCalls = 0;
    await initI18n('zh-CN');
  });

  afterEach(() => {
    dom.restore();
  });

  it('语言行标签与 auto 档自称用 t() 渲染(中文档)', () => {
    const menu = make();
    menu.show();
    expect(t('ui:settings.language')).toBe('语言');
    expect(findButton(dom, '自动')).toBeDefined();
    expect(rowButton(dom, '语言')).toBeDefined();
  });

  it('点击语言按钮:循环到下一档,走 onLanguage 而非 onChange', () => {
    const menu = make();
    menu.show();
    // 当前 auto → 点击去 zh-CN
    findButton(dom, '自动')!.listeners.get('click')!({});
    expect(onLanguageCalls).toEqual(['zh-CN']);
    expect(onChangeCalls).toBe(0); // 语言不进"即改即存"通道
  });

  it('refreshLocale 只重画语言行:换到 en 后标签与自称跟着翻', async () => {
    const menu = make();
    menu.show();
    await changeLocale('en'); // 语言真切过去了(main 的 setLanguage 在切成功后才会刷)
    current = { ...current, language: 'en' }; // 同步 settings.language(main 在成功后才落盘)
    menu.refreshLocale();
    expect(rowButton(dom, 'Language')).toBeDefined();
    expect(findButton(dom, 'English')).toBeDefined();
    expect(findButton(dom, '自动')).toBeUndefined();
  });

  it('refreshLocale 幂等:语言没变时反复刷不改变行状态(不注册新监听、不动 visible)', () => {
    const menu = make();
    menu.show();
    const before = findButton(dom, '自动');
    expect(menu.visible()).toBe(true);
    menu.refreshLocale();
    menu.refreshLocale();
    expect(findButton(dom, '自动')).toBe(before); // 还是同一颗按钮(只改文案,不重建)
    expect(menu.visible()).toBe(true);
  });

  it('切换失败:showLocaleError 亮出可读错误;下次 show 复位(那次失败不留到下次)', () => {
    const menu = make();
    menu.show();
    menu.showLocaleError(t('ui:language.loadFailed'));
    const errRow = card(dom).children.find((k) => k.textContent === t('ui:language.loadFailed'));
    expect(errRow).toBeDefined();
    expect(errRow!.style.display).not.toBe('none');
    menu.hide();
    menu.show();
    expect(card(dom).children.some((k) => k.textContent === t('ui:language.loadFailed'))).toBe(false);
  });
});
