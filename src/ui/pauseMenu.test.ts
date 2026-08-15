/**
 * 暂停菜单(玩家模式)。主体测的是**两条行为分界线**:
 * ① Esc 只在战斗运行中(canPause)响应 —— 升级/整备/结算时停(run.paused = true)
 *    按 Esc 不该弹菜单,否则时停里 Esc 会同时被流程与菜单抢着消费;
 * ② hide() 是纯收起、不触发 onResume —— restart/retry 换局时 main 用它关菜单,
 *    若 hide 把 run.paused 翻回 false,时停期间世界就还在跑。
 * 04 号起整页文案走 t(),行为测试按 data-action 找按钮,不靠中文按钮文本;
 * refreshLocale 需保留「保存失败」状态与可见性。
 * 与 createGameOverUi 同一条破例理由:这两条错都要等真人开第二局才看得见。
 * 桩只提供 createPauseMenu 真的会碰的那几样(createElement/getElementById/append +
 * window.addEventListener + activeElement),绝不发展成半个 jsdom。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changeLocale, initI18n, t } from '../i18n';
import { createPauseMenu, type PauseMenuHooks } from './pauseMenu';

interface StubEl {
  tagName: string;
  style: { cssText: string; color: string; display: string };
  textContent: string;
  title: string;
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
    title: '',
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

describe('createPauseMenu', () => {
  let dom: StubDom;
  let paused: boolean;
  let restarts: number;
  let retries: number;
  let settingsOpened: number;
  /** 「保存并退出」这一次存得上吗(存档改版:存不上要留在菜单里改口报错) */
  let saveOk: boolean;
  let saveAttempts: number;
  /** 设置页开着吗 —— main 传 `() => settingsMenu.visible()`,菜单据此对 Esc 让路 */
  let settingsVisible: boolean;

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
      blocked: () => settingsVisible,
      onSettings: () => {
        settingsOpened++;
      },
      onSaveAndQuit: () => {
        saveAttempts++;
        return saveOk;
      },
    };
    return createPauseMenu(hooks);
  }

  beforeEach(async () => {
    dom = installDom();
    paused = false;
    restarts = 0;
    retries = 0;
    settingsOpened = 0;
    saveAttempts = 0;
    saveOk = true;
    settingsVisible = false;
    await initI18n('zh-CN');
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
    findAction(dom, 'pause-resume')!.listeners.get('click')!({});
    expect(menu.visible()).toBe(false);
    expect(paused).toBe(false);
  });

  it('「再来一局」按钮:先收起再 restart,不把世界留在暂停态', () => {
    const menu = make();
    dom.key(keyEvent('Escape'));
    findAction(dom, 'pause-restart')!.listeners.get('click')!({});
    expect(menu.visible()).toBe(false);
    expect(restarts).toBe(1);
  });

  it('「再试一局」按钮:先收起再 retry', () => {
    const menu = make();
    dom.key(keyEvent('Escape'));
    findAction(dom, 'pause-retry')!.listeners.get('click')!({});
    expect(menu.visible()).toBe(false);
    expect(retries).toBe(1);
  });

  it('「保存并退出」存上了:调一次 onSaveAndQuit,退出由 main 接手', () => {
    make();
    dom.key(keyEvent('Escape'));
    findAction(dom, 'pause-save-quit')!.listeners.get('click')!({});
    expect(saveAttempts).toBe(1);
    // 收菜单/回标题都是 main 那一侧的事(onSaveAndQuit 里做),菜单自己不擅自收起
    expect(paused).toBe(true);
  });

  it('「保存并退出」**存不上时留在菜单里并当场改口** —— 不给一个空头承诺', () => {
    saveOk = false;
    const menu = make();
    dom.key(keyEvent('Escape'));
    findAction(dom, 'pause-save-quit')!.listeners.get('click')!({});
    // 这是这颗按钮唯一不能出错的地方:此刻退出会静默丢掉整整一局,
    // 而玩家点它的全部意图恰恰是"别丢"
    expect(menu.visible()).toBe(true);
    expect(findAction(dom, 'pause-save-quit')!.textContent).toBe(t('ui:pause.saveFailed'));
  });

  it('上一次的"保存失败"不留到下一次暂停(那是那一次的结论)', () => {
    saveOk = false;
    const menu = make();
    dom.key(keyEvent('Escape'));
    findAction(dom, 'pause-save-quit')!.listeners.get('click')!({});
    expect(findAction(dom, 'pause-save-quit')!.textContent).toBe(t('ui:pause.saveFailed'));
    menu.hide();
    menu.show();
    // 重新弹出时按钮已复位:不然玩家一进暂停就挂着一句吓人的错误,而此刻根本没试过存
    expect(findAction(dom, 'pause-save-quit')!.textContent).toBe(t('ui:pause.saveAndQuit'));
  });

  it('「设置」按钮:只说一声,收菜单与弹设置页都归 main(两个入口共用一页设置)', () => {
    make();
    dom.key(keyEvent('Escape'));
    findAction(dom, 'pause-settings')!.listeners.get('click')!({});
    expect(settingsOpened).toBe(1);
    expect(paused).toBe(true); // 世界继续冻着
  });

  it('键位表(28 号):五行键位齐全、排在设置按钮之前,是纯文本不是按钮', () => {
    const menu = make();
    const cardEl = card(dom);
    // 构造顺序固定:标题 / 4 按钮 / 键位表 / 设置 / 声音 / 提示(见 createPauseMenu)
    const keyTable = cardEl.children[5]!;
    const settingsBtn = cardEl.children[6]!;
    expect(keyTable.tagName).toBe('DIV');
    expect(settingsBtn.tagName).toBe('BUTTON');
    expect(settingsBtn.textContent).toBe(t('ui:pause.settings'));
    // 键位表排在设置按钮之前:暂停菜单按"求助页"顺序读下去,键位先于出口
    expect(cardEl.children.indexOf(keyTable)).toBeLessThan(cardEl.children.indexOf(settingsBtn));
    // 五行五对:键名列是**键位 token**(不翻),说明列走 ui.keys 翻译,顺序与 KEY_ROWS 一致
    const pairs: Array<[string, string]> = [
      ['WASD', t('ui:keys.wasd')],
      ['空格', t('ui:keys.space')],
      ['I', t('ui:keys.layout')],
      ['按住 Tab', t('ui:keys.firingArc')],
      ['Esc', t('ui:keys.pause')],
    ];
    expect(keyTable.children.length).toBe(5);
    pairs.forEach(([key, desc], i) => {
      const row = keyTable.children[i]!;
      expect(row.children[0]!.tagName).toBe('SPAN');
      expect(row.children[0]!.textContent).toBe(key);
      expect(row.children[1]!.tagName).toBe('SPAN');
      expect(row.children[1]!.textContent).toBe(desc);
    });
    // 纯文本:整表不挂任何监听(不是按钮,不可点),菜单收起/重开原样复用
    expect(keyTable.listeners.size).toBe(0);
    menu.show();
    expect(findAction(dom, 'pause-settings')).toBeDefined();
    expect(keyTable.children.length).toBe(5);
  });

  it('键位表说明列随语言翻:refreshLocale 后(en)键名照旧、说明变英文', async () => {
    const menu = make();
    const keyTable = card(dom).children[5]!;
    expect(keyTable.children[0]!.children[0]!.textContent).toBe('WASD');
    expect(keyTable.children[0]!.children[1]!.textContent).toBe(t('ui:keys.wasd'));
    await changeLocale('en');
    menu.refreshLocale();
    // 键位 token 不翻:第一列还是 WASD / 空格 / I / 按住 Tab / Esc
    expect(keyTable.children[0]!.children[0]!.textContent).toBe('WASD');
    expect(keyTable.children[0]!.children[1]!.textContent).toBe(t('ui:keys.wasd'));
    expect(keyTable.children[1]!.children[0]!.textContent).toBe('空格');
    expect(keyTable.children[1]!.children[1]!.textContent).toBe(t('ui:keys.space'));
  });

  it('设置页开着时 Esc 归它:暂停菜单主动让路,不会一键摔回战斗', () => {
    const menu = make();
    dom.key(keyEvent('Escape')); // 暂停
    expect(menu.visible()).toBe(true);
    settingsVisible = true; // 设置页盖在上面
    dom.key(keyEvent('Escape')); // 这一记归设置页
    // 让路失败的症状:菜单收起 + onResume 触发 = 玩家关个设置页直接摔回战斗
    expect(menu.visible()).toBe(true);
    expect(paused).toBe(true);
  });

  it('设置页开着时 Esc 也不会从战斗中把菜单弹出来', () => {
    const menu = make();
    settingsVisible = true;
    dom.key(keyEvent('Escape'));
    expect(menu.visible()).toBe(false);
    expect(paused).toBe(false);
  });

  it('hide() 是纯收起:不触发 onResume,世界状态由 main 自己定(restart/retry 换局用)', () => {
    const menu = make();
    dom.key(keyEvent('Escape'));
    expect(paused).toBe(true);
    menu.hide();
    expect(menu.visible()).toBe(false);
    expect(paused).toBe(true); // 保持冻结 —— restart 会自己置 paused,轮不到这里翻
  });

  it('refreshLocale 保留「保存失败」状态:切到 en 后失败提示翻新、菜单仍开着', async () => {
    saveOk = false;
    const menu = make();
    dom.key(keyEvent('Escape')); // 暂停
    findAction(dom, 'pause-save-quit')!.listeners.get('click')!({});
    expect(findAction(dom, 'pause-save-quit')!.textContent).toBe(t('ui:pause.saveFailed'));
    await changeLocale('en');
    menu.refreshLocale();
    expect(menu.visible()).toBe(true); // 可见性保持
    const btn = findAction(dom, 'pause-save-quit')!;
    expect(btn.textContent).toContain('Save failed');
    // 下一次暂停仍复位回"保存并退出"(en)
    menu.hide();
    menu.show();
    expect(btn.textContent).toBe(t('ui:pause.saveAndQuit'));
  });

  it('声音按钮:点击切 audioBus 静音并同步按钮文字', async () => {
    // audioBus 是 module 单例,Node 下直接可用(ensureCtx 懒建,点击只是切布尔)
    const audio = (await import('../render/audio')).audioBus;
    audio.setMuted(false);
    make();
    dom.key(keyEvent('Escape'));
    const btn = findAction(dom, 'pause-mute')!;
    expect(btn.textContent).toBe(t('ui:pause.soundOn'));
    btn.listeners.get('click')!({});
    expect(audio.isMuted()).toBe(true);
    expect(btn.textContent).toBe(t('ui:pause.soundOff'));
    // 菜单开着时静音状态改,重开菜单也要画对(show 里 paint)
    audio.setMuted(false);
  });

  it('静音单一真相源(二轮审查):注入 hooks 后点击写 hooks、上色读 hooks,不再直碰 audioBus', () => {
    let muted = false;
    let setCalls = 0;
    const hooks: PauseMenuHooks = {
      canPause: () => !paused,
      onPause: () => {
        paused = true;
      },
      onResume: () => {
        paused = false;
      },
      onRestart: () => {},
      onRetry: () => {},
      onSettings: () => {},
      onSaveAndQuit: () => true,
      muted: {
        get: () => muted,
        set: (m: boolean) => {
          setCalls++;
          muted = m;
        },
      },
    };
    const menu = createPauseMenu(hooks);
    menu.show();
    const btn = findAction(dom, 'pause-mute')!;
    expect(btn.textContent).toBe(t('ui:pause.soundOn'));
    btn.listeners.get('click')!({});
    expect(setCalls).toBe(1);
    expect(muted).toBe(true);
    expect(btn.textContent).toBe(t('ui:pause.soundOff'));
    // 外部(设置页)改真相源后重开菜单,画对
    muted = false;
    menu.hide();
    menu.show();
    expect(btn.textContent).toBe(t('ui:pause.soundOn'));
  });
});
