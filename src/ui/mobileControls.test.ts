/**
 * 移动端驾驶层的桩测试。只钉本层自己承诺的三件事:
 * ① 背包键是注入动作的触发器,只在控件启用时响应(禁用态点击不穿透);
 * ② 背包键的标签/aria-label 走 ui:keys.layout 翻译,切语言原地刷新;
 * ③ 结构上 steer/armory/boost 三件套挂在 #ui 下,swapped 只换摇杆与加速的列。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changeLocale, initI18n, t } from '../i18n';
import { createMobileControls, type MobileControlsUi } from './mobileControls';

interface ClassList {
  names: Set<string>;
  toggle(name: string, force?: boolean): void;
  add(name: string): void;
  remove(name: string): void;
}

interface StubEl {
  tagName: string;
  className: string;
  style: Record<string, string>;
  textContent: string;
  children: StubEl[];
  attributes: Map<string, string>;
  handlers: Map<string, Array<() => void>>;
  classList: ClassList;
  append(...children: StubEl[]): void;
  appendChild(child: StubEl): StubEl;
  addEventListener(type: string, handler: () => void): void;
  setAttribute(name: string, value: string): void;
  setPointerCapture(): void;
}

function createStubEl(tagName = 'div'): StubEl {
  const element: StubEl = {
    tagName: tagName.toUpperCase(),
    className: '',
    style: {},
    textContent: '',
    children: [],
    attributes: new Map(),
    handlers: new Map(),
    classList: {
      names: new Set(),
      toggle(name: string, force?: boolean): void {
        const on = force === undefined ? !element.classList.names.has(name) : force;
        if (on) element.classList.names.add(name);
        else element.classList.names.delete(name);
      },
      add(name: string): void { element.classList.names.add(name); },
      remove(name: string): void { element.classList.names.delete(name); },
    },
    append(...children): void { element.children.push(...children); },
    appendChild(child): StubEl { element.children.push(child); return child; },
    addEventListener(type, handler): void {
      const handlers = element.handlers.get(type) ?? [];
      handlers.push(handler);
      element.handlers.set(type, handlers);
    },
    setAttribute(name, value): void { element.attributes.set(name, value); },
    setPointerCapture(): void {},
  };
  return element;
}

function fire(element: StubEl, type: string): void {
  for (const handler of element.handlers.get(type) ?? []) handler();
}

function installDom(): { ui: StubEl; root: StubEl; restore(): void } {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previousWindow = globals.window;
  const previousDocument = globals.document;
  const ui = createStubEl();
  const root = createStubEl('html');
  const rafCallbacks: Array<() => void> = [];
  globals.window = {
    requestAnimationFrame(cb: () => void): void { rafCallbacks.push(cb); },
    dispatchEvent(): void {},
    addEventListener(): void {},
  };
  globals.document = {
    createElement: (tagName: string): StubEl => createStubEl(tagName),
    getElementById: (id: string): StubEl | null => id === 'ui' ? ui : null,
    documentElement: root,
  };
  return {
    ui,
    root,
    restore(): void {
      globals.window = previousWindow;
      globals.document = previousDocument;
    },
  };
}

describe('移动端驾驶层', () => {
  let dom: ReturnType<typeof installDom>;
  const input = {
    clearVirtualHeading(): void {},
    setVirtualHeading(): void {},
    setVirtualKey(): void {},
  };

  beforeEach(async () => {
    await initI18n('zh-CN');
    dom = installDom();
  });
  afterEach(() => dom.restore());

  function controls(): MobileControlsUi {
    return createMobileControls(input as never);
  }

  function armoryButton(): StubEl {
    const root = dom.ui.children[0]!;
    const wrap = root.children[1]!;
    return wrap.children[1]!;
  }

  function armoryLabel(): StubEl {
    const root = dom.ui.children[0]!;
    const wrap = root.children[1]!;
    return wrap.children[0]!;
  }

  it('背包键夹在摇杆与加速之间,标签与 aria-label 取 ui:keys.layout 翻译', () => {
    controls();
    const root = dom.ui.children[0]!;
    expect(root.children).toHaveLength(3);
    expect(armoryButton().className).toBe('sw-mobile-armory');
    expect(armoryButton().tagName).toBe('BUTTON');
    expect(armoryLabel().textContent).toBe(t('ui:keys.layout'));
    expect(armoryButton().attributes.get('aria-label')).toBe(t('ui:keys.layout'));
  });

  it('控件启用时点击背包键触发注入动作,禁用后点击不穿透', () => {
    const c = controls();
    let fired = 0;
    c.setArmoryAction(() => { fired++; });
    c.sync(true, true);
    fire(armoryButton(), 'click');
    expect(fired).toBe(1);

    c.sync(true, false);
    fire(armoryButton(), 'click');
    expect(fired).toBe(1);

    c.sync(true, true);
    fire(armoryButton(), 'click');
    expect(fired).toBe(2);
  });

  it('未注入动作时点击背包键不抛错', () => {
    const c = controls();
    c.sync(true, true);
    fire(armoryButton(), 'click');
  });

  it('切语言后背包键标签与 aria-label 原地刷新', async () => {
    const c = controls();
    await changeLocale('en');
    c.refreshLocale(); // main 的 registerLocaleAware 在语言切换成功后就是调这一记
    expect(armoryLabel().textContent).toBe(t('ui:keys.layout'));
    expect(armoryButton().attributes.get('aria-label')).toBe(t('ui:keys.layout'));
    await changeLocale('zh-CN');
  });

  it('swapped 只翻转摇杆/加速所在列,背包键居中不受影响(节点顺序不变)', () => {
    const c = controls();
    const root = dom.ui.children[0]!;
    c.setSwapped(true);
    expect(root.classList.names.has('sw-mobile-controls-swapped')).toBe(true);
    // 背包键仍在中间:顺序 steer / armory / boost 不因换手而重排
    expect(root.children[1]!.className).toBe('sw-mobile-armory-wrap');
  });
});
