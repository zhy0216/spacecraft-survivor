/**
 * 暂停菜单(玩家模式)。主体测的是**两条行为分界线**:
 * ① Esc 只在战斗运行中(canPause)响应 —— 升级/整备/结算时停(run.paused = true)
 *    按 Esc 不该弹菜单,否则时停里 Esc 会同时被流程与菜单抢着消费;
 * ② hide() 是纯收起、不触发 onResume —— restart/retry 换局时 main 用它关菜单,
 *    若 hide 把 run.paused 翻回 false,起手选择期间世界就还在跑。
 * 与 createGameOverUi 同一条破例理由:这两条错都要等真人开第二局才看得见。
 * 桩只提供 createPauseMenu 真的会碰的那几样(createElement/getElementById/append +
 * window.addEventListener + activeElement),绝不发展成半个 jsdom。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPauseMenu, type PauseMenuHooks } from './pauseMenu';

interface StubEl {
  tagName: string;
  style: { cssText: string; color: string; display: string };
  textContent: string;
  title: string;
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
    title: '',
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
  // 与真实 DOM 同一语义:整串 cssText 赋值会把 display:none 落到独立字段上,
  // 之后的 style.display = 'flex' 覆盖它 —— 桩不解析,这两步就会各走各的
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

/** 根遮罩的显示状态:cssText 解析后落在 style.display(与真实 DOM 同读法) */
function rootDisplay(dom: StubDom): string {
  return dom.ui.children[0]!.style.display;
}

interface StubKeyEvent {
  code: string;
  repeat: boolean;
}

function keyEvent(code: string, repeat = false): StubKeyEvent {
  return { code, repeat };
}

interface StubDom {
  ui: StubEl;
  keys: Array<(e: StubKeyEvent) => void>;
  key(e: StubKeyEvent): void;
  restore(): void;
}

function installDom(): StubDom {
  const g = globalThis as unknown as Record<string, unknown>;
  const prevWindow = g.window;
  const prevDocument = g.document;
  const prevHtmlElement = g.HTMLElement;
  const dom: StubDom = {
    ui: createStubEl(),
    keys: [],
    key(e: StubKeyEvent): void {
      for (const fn of dom.keys) fn(e);
    },
    restore(): void {
      g.window = prevWindow;
      g.document = prevDocument;
      g.HTMLElement = prevHtmlElement;
    },
  };
  g.window = {
    addEventListener(type: string, fn: (e: StubKeyEvent) => void): void {
      if (type === 'keydown') dom.keys.push(fn);
    },
  };
  g.document = {
    createElement: (tag: string): StubEl => createStubEl(tag),
    getElementById: (id: string): StubEl | null => (id === 'ui' ? dom.ui : null),
    activeElement: null,
  };
  g.HTMLElement = class HTMLElement {};
  return dom;
}

/** 遮罩 = #ui 的唯一子节点;卡 = 遮罩的唯一子节点(构造顺序固定) */
function card(dom: StubDom): StubEl {
  return dom.ui.children[0]!.children[0]!;
}

/** 按钮 = 卡里 textContent 匹配的那枚(标题/4 按钮/提示,构造顺序见 createPauseMenu) */
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

describe('createPauseMenu', () => {
  let dom: StubDom;
  let paused: boolean;
  let restarts: number;
  let retries: number;

  function make(): ReturnType<typeof createPauseMenu> {
    const hooks: PauseMenuHooks = {
      canPause: () => !paused,
      onPause: () => {
        paused = true;
      },
      onResume: () => {
        paused = false;
      },
      onRestart: () => {
        restarts++;
      },
      onRetry: () => {
        retries++;
      },
    };
    return createPauseMenu(hooks);
  }

  beforeEach(() => {
    dom = installDom();
    paused = false;
    restarts = 0;
    retries = 0;
  });
  afterEach(() => {
    dom.restore();
  });

  it('遮罩初始隐藏;按 Esc 弹菜单并触发 onPause(世界冻结)', () => {
    const menu = make();
    expect(rootDisplay(dom)).toBe('none');
    expect(menu.visible()).toBe(false);

    dom.key(keyEvent('Escape'));
    expect(menu.visible()).toBe(true);
    expect(rootDisplay(dom)).toBe('flex');
    expect(paused).toBe(true);
  });

  it('菜单开着时再按 Esc:收起并触发 onResume(世界恢复)', () => {
    const menu = make();
    dom.key(keyEvent('Escape'));
    dom.key(keyEvent('Escape'));
    expect(menu.visible()).toBe(false);
    expect(paused).toBe(false);
  });

  it('时停中(run.paused)按 Esc 不弹菜单 —— 升级/整备/结算的 Esc 归流程自己', () => {
    const menu = make();
    paused = true; // 升级时停
    dom.key(keyEvent('Escape'));
    expect(menu.visible()).toBe(false);
    expect(paused).toBe(true); // 世界保持冻结,onPause 未被调
  });

  it('重复按 Esc(e.repeat)不弹菜单,与流程层同一条防连发口径', () => {
    const menu = make();
    dom.key(keyEvent('Escape', true));
    expect(menu.visible()).toBe(false);
    expect(paused).toBe(false);
  });

  it('非 Esc 键不弹菜单', () => {
    const menu = make();
    dom.key(keyEvent('KeyR'));
    expect(menu.visible()).toBe(false);
    expect(paused).toBe(false);
  });

  it('「继续」按钮:收起 + onResume', () => {
    const menu = make();
    dom.key(keyEvent('Escape'));
    findButton(dom, '继续(Esc)')!.listeners.get('click')!({});
    expect(menu.visible()).toBe(false);
    expect(paused).toBe(false);
  });

  it('「再来一局」按钮:先收起再 restart,不把世界留在暂停态', () => {
    const menu = make();
    dom.key(keyEvent('Escape'));
    findButton(dom, '再来一局(换种子)')!.listeners.get('click')!({});
    expect(menu.visible()).toBe(false);
    expect(restarts).toBe(1);
  });

  it('「再试一局」按钮:先收起再 retry', () => {
    const menu = make();
    dom.key(keyEvent('Escape'));
    findButton(dom, '再试一局(同种子)')!.listeners.get('click')!({});
    expect(menu.visible()).toBe(false);
    expect(retries).toBe(1);
  });

  it('hide() 是纯收起:不触发 onResume,世界状态由 main 自己定(restart/retry 换局用)', () => {
    const menu = make();
    dom.key(keyEvent('Escape'));
    expect(paused).toBe(true);
    menu.hide();
    expect(menu.visible()).toBe(false);
    expect(paused).toBe(true); // 保持冻结 —— restart 会自己置 paused,轮不到这里翻
  });

  it('声音按钮:点击切 audioBus 静音并同步按钮文字', async () => {
    // audioBus 是 module 单例,Node 下直接可用(ensureCtx 懒建,点击只是切布尔)
    const audio = (await import('../render/audio')).audioBus;
    audio.setMuted(false);
    const menu = make();
    dom.key(keyEvent('Escape'));
    const btn = findButton(dom, '声音:开')!;
    btn.listeners.get('click')!({});
    expect(audio.isMuted()).toBe(true);
    expect(findButton(dom, '声音:关')).toBeDefined();
    // 菜单开着时静音状态改,重开菜单也要画对(show 里 paintMute)
    audio.setMuted(false);
  });
});
