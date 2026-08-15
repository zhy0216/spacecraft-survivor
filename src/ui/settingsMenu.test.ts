/**
 * 设置页(04 号迁完全部文案)。用的是与 pauseMenu.test 同款桩 DOM(不装 jsdom)。
 * 钉四条行为 + 迁移验收:
 * ① 语言走 onLanguage 单独一条路 —— 点击**绝不**调 onChange(那是"即改即存"的通用通道,
 *    语言切换是异步的、成败未定,过早落盘会把一个没生效的值写进设置);
 * ② 循环顺序 自动 → 简体中文 → English → 自动(与 settings.nextLanguage 同源);
 * ③ refreshLocale 只重画文案(语言切换成功后由 main 统一触发)——
 *    换到 en 后整页跟着翻,行标签/开关值/震屏档位/返回/恢复默认/自动保存提示全覆盖;
 * ④ 切换失败:showLocaleError 亮出可读错误,下次 show 复位(与暂停菜单同一条"那次结论不留"口径)。
 * 按钮一律按 data-action 找,不靠中文按钮文本。
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
  dataset: Record<string, string>;
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
    dataset: {},
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

/** 按 data-action 找按钮(04 号:行为测试不靠中文按钮文本) */
function findAction(dom: StubDom, action: string): StubEl | undefined {
  const walk = (el: StubEl): StubEl | undefined => {
    if (el.tagName === 'BUTTON' && el.dataset.action === action) return el;
    for (const kid of el.children) {
      const hit = walk(kid);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(card(dom));
}

/** 按行标签找一行(标签 = 该行 textContent 为 label 的那个子元素),返回该行里第一颗按钮 */
function rowButton(dom: StubDom, label: string): StubEl | undefined {
  const findRow = (el: StubEl): StubEl | undefined => {
    if (el.children.some((k) => k.textContent === label)) return el;
    for (const kid of el.children) {
      const hit = findRow(kid);
      if (hit) return hit;
    }
    return undefined;
  };
  const row = findRow(card(dom));
  if (row === undefined) return undefined;
  const walk = (el: StubEl): StubEl | undefined => {
    if (el.tagName === 'BUTTON') return el;
    for (const kid of el.children) {
      const hit = walk(kid);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(row);
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
    expect(findAction(dom, 'settings-language')!.textContent).toBe('自动');
    expect(rowButton(dom, '语言')).toBeDefined();
  });

  it('点击语言按钮:循环到下一档,走 onLanguage 而非 onChange', () => {
    const menu = make();
    menu.show();
    // 当前 auto → 点击去 zh-CN
    findAction(dom, 'settings-language')!.listeners.get('click')!({});
    expect(onLanguageCalls).toEqual(['zh-CN']);
    expect(onChangeCalls).toBe(0); // 语言不进"即改即存"通道
  });

  it('refreshLocale 整页重画:换到 en 后行标签/自称/开关值/震屏档位/返回/提示全部跟着翻', async () => {
    const menu = make();
    menu.show();
    await changeLocale('en'); // 语言真切过去了(main 的 setLanguage 在切成功后才会刷)
    current = { ...current, language: 'en' }; // 同步 settings.language(main 在成功后才落盘)
    menu.refreshLocale();
    expect(rowButton(dom, 'Language')).toBeDefined();
    expect(findAction(dom, 'settings-language')!.textContent).toBe('English');
    expect(findAction(dom, 'settings-language')!.textContent).not.toBe('自动');
    // 迁移后的其余行也跟着翻(04 号验收:设置页全量文案进 t())
    expect(rowButton(dom, 'Master Volume')).toBeDefined();
    expect(rowButton(dom, 'Sound')).toBeDefined();
    expect(findAction(dom, 'settings-mute')!.textContent).toBe(t('common:on'));
    expect(findAction(dom, 'settings-shake')!.textContent).toBe(t('ui:settings.shakeLevels.standard'));
    expect(findAction(dom, 'settings-back')!.textContent).toBe('Back (Esc)');
    expect(findAction(dom, 'settings-reset')!.textContent).toBe('Restore Defaults');
    expect(
      card(dom).children.some((k) => k.textContent === t('ui:settings.instantSaveHint')),
    ).toBe(true);
  });

  it('refreshLocale 幂等:语言没变时反复刷不改变行状态(不注册新监听、不动 visible)', () => {
    const menu = make();
    menu.show();
    const before = findAction(dom, 'settings-language');
    expect(menu.visible()).toBe(true);
    menu.refreshLocale();
    menu.refreshLocale();
    expect(findAction(dom, 'settings-language')).toBe(before); // 还是同一颗按钮(只改文案,不重建)
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

describe('createSettingsMenu:迁移后的整页文案(04 号)', () => {
  let dom: StubDom;
  let current: Settings;

  function make(): ReturnType<typeof createSettingsMenu> {
    const hooks: SettingsMenuHooks = {
      get: () => current,
      // 模拟 main 的 onChange:就地改 main 那一份设置(菜单重画时读的是它)
      onChange: (next) => {
        current = next;
      },
      onLanguage: () => {},
      onClose: () => {},
    };
    return createSettingsMenu(hooks);
  }

  beforeEach(async () => {
    dom = installDom();
    current = createSettings();
    await initI18n('zh-CN');
  });

  afterEach(() => {
    dom.restore();
  });

  it('整页文案与开关值走 t()(zh 档)', () => {
    const menu = make();
    menu.show();
    expect(card(dom).children[0]!.textContent).toBe(t('ui:settings.title'));
    // 行标签
    expect(rowButton(dom, t('ui:settings.volume'))).toBeDefined();
    expect(rowButton(dom, t('ui:settings.sound'))).toBeDefined();
    expect(rowButton(dom, t('ui:settings.shake'))).toBeDefined();
    expect(rowButton(dom, t('ui:settings.damageNumbers'))).toBeDefined();
    expect(rowButton(dom, t('ui:settings.hitstop'))).toBeDefined();
    // 控件值:开关 开/关、震屏档位、返回/恢复默认/自动保存提示
    expect(findAction(dom, 'settings-mute')!.textContent).toBe(t('common:on'));
    expect(findAction(dom, 'settings-shake')!.textContent).toBe(t('ui:settings.shakeLevels.standard'));
    expect(findAction(dom, 'settings-damage-numbers')!.textContent).toBe(t('common:on'));
    expect(findAction(dom, 'settings-hitstop')!.textContent).toBe(t('common:on'));
    expect(findAction(dom, 'settings-back')!.textContent).toBe('返回(Esc)');
    expect(findAction(dom, 'settings-reset')!.textContent).toBe(t('ui:settings.reset'));
    expect(card(dom).children.some((k) => k.textContent === t('ui:settings.instantSaveHint'))).toBe(true);
    // 震屏档位循环:标准 → 轻微 → 关闭 → 标准(与 settings.nextShake 同源)
    findAction(dom, 'settings-shake')!.listeners.get('click')!({});
    expect(findAction(dom, 'settings-shake')!.textContent).toBe(t('ui:settings.shakeLevels.low'));
    findAction(dom, 'settings-shake')!.listeners.get('click')!({});
    expect(findAction(dom, 'settings-shake')!.textContent).toBe(t('ui:settings.shakeLevels.off'));
  });

  it('音量 −/+ 走 onChange 并在读数上即时反映', () => {
    const menu = make();
    menu.show();
    current = { ...current, masterVolume: 0.5 };
    menu.refreshLocale();
    findAction(dom, 'settings-volume-up')!.listeners.get('click')!({});
    expect(current.masterVolume).toBe(0.6);
    findAction(dom, 'settings-volume-down')!.listeners.get('click')!({});
    expect(current.masterVolume).toBe(0.5);
  });
});
