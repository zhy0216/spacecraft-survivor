/**
 * 结算界面(08 号 issue T3)。主体测的是那几个**纯函数** —— 结算上到底印了什么:
 * 把 8:59.9 报成 9:00、胜利时航段印成 "5/4"、某个结果码漏配文案却静默显示成"航段全通",
 * 三种错都只是一行字符串拼接,却要等真人打完一整局(8–10 分钟)撞上那一刻才看得见。
 *
 * 文件末尾**破一次例**去测 createGameOverUi 本身(理由与 ui/upgradeFlow.test.ts 的 setWorld 一致):
 * 它不是"交互",而是"一局从开始到胜利/失败/重开全流程无需刷新页面"(08 验收标准)里
 * 最容易做漏的一环 —— 只建一次 / 收着时 Enter 不认 / 点了就该消失,三条各错一次的后果
 * (一次回车重开好几局、战斗中误按回车把正打着的一局重开掉、点完按钮面板还挂在新局上)
 * 都要等真人重开第二局才看得出来。桩只提供 createGameOverUi 真的会碰的那几样
 * (createElement/getElementById/append + window.addEventListener + activeElement),
 * 绝不发展成半个 jsdom:本仓的 vitest 跑在 Node 环境里,不装 jsdom(见 ui/upgradeFlow.test.ts)。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WAVE_SEGMENTS } from '../data/waves';
import { RESULT_LOSE, RESULT_RUNNING, RESULT_WIN } from '../sim/world';
import {
  createGameOverUi,
  formatDuration,
  type RunSummary,
  resultNote,
  resultTitle,
  segmentLabel,
  summaryText,
} from './gameOver';

describe('formatDuration', () => {
  it('m:ss,秒数补零', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(9)).toBe('0:09');
    expect(formatDuration(59)).toBe('0:59');
    expect(formatDuration(60)).toBe('1:00');
    expect(formatDuration(550)).toBe('9:10');
  });

  it('**向下取整**:8:59.9 报 8:59 —— 进位成 9:00 会让人以为脚本多跑了一段', () => {
    expect(formatDuration(539.9)).toBe('8:59');
    expect(formatDuration(59.99)).toBe('0:59');
  });

  it('负数夹 0,不印出 "-1:-3" 这种读不出来的东西', () => {
    expect(formatDuration(-1)).toBe('0:00');
  });
});

describe('segmentLabel', () => {
  it('segment 是下标,显示时 +1(玩家读的是第几段)', () => {
    expect(segmentLabel(0, 4)).toBe('1/4');
    expect(segmentLabel(2, 4)).toBe('3/4');
    expect(segmentLabel(3, 4)).toBe('4/4');
  });

  it('走完那一刻 segment == 段数(越界值):报满段 + 全通,绝不印 "5/4"', () => {
    // 这正是**胜利界面**上必然出现的那个值 —— 直接 +1 的话,每一次胜利都会印错
    expect(segmentLabel(4, 4)).toBe('4/4(全通)');
    expect(segmentLabel(5, 4)).toBe('4/4(全通)');
  });

  it('空脚本不显示进度(0/0 读不出任何意思)', () => {
    expect(segmentLabel(0, 0)).toBe('—');
  });
});

describe('resultTitle / resultNote', () => {
  it('胜负各有自己的一句话,且不重样', () => {
    expect(resultTitle(RESULT_WIN)).not.toBe(resultTitle(RESULT_LOSE));
    expect(resultNote(RESULT_WIN)).not.toBe(resultNote(RESULT_LOSE));
    for (const r of [RESULT_WIN, RESULT_LOSE]) {
      expect(resultTitle(r).length).toBeGreaterThan(0);
      expect(resultNote(r).length).toBeGreaterThan(0);
    }
  });

  it('未知码把码印出来,**不静默兜底成胜利** —— 那样一条判定写反了都没人看得见', () => {
    // RESULT_RUNNING 弹出结算本身就是个 bug(局还没完),界面得当场把它喊出来
    expect(resultTitle(RESULT_RUNNING)).toContain(String(RESULT_RUNNING));
    expect(resultTitle(RESULT_RUNNING)).not.toBe(resultTitle(RESULT_WIN));
    expect(resultNote(RESULT_RUNNING)).not.toBe(resultNote(RESULT_WIN));
  });
});

/** 一局的结算数据:各用例只改自己关心的那一两个字段 */
function summary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    result: RESULT_WIN,
    survivedSec: 550,
    kills: 1234,
    segment: 4,
    segmentCount: 4,
    silhouette: null,
    ...over,
  };
}

describe('summaryText', () => {
  it('三行:存活时间 / 击杀数 / 航段进度,一行都不许少', () => {
    const lines = summaryText(summary({ survivedSec: 125, kills: 7, segment: 1 })).split('\n');
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('2:05');
    expect(lines[1]).toContain('7');
    expect(lines[2]).toContain('2/4');
  });

  it('击杀数取整(将来有人往里塞加权分也不会印出小数)', () => {
    expect(summaryText(summary({ kills: 12.4 }))).toContain('12');
    expect(summaryText(summary({ kills: 12.4 }))).not.toContain('12.4');
  });

  it('段数由调用方给,于是数据表加/删一段,结算跟着走(改数据即可调节奏)', () => {
    // 真表也得对得上:main.ts 传的就是 WAVE_SEGMENTS.length
    expect(summaryText(summary({ segment: 0, segmentCount: WAVE_SEGMENTS.length }))).toContain(
      `1/${WAVE_SEGMENTS.length}`,
    );
    expect(summaryText(summary({ segment: 0, segmentCount: 7 }))).toContain('1/7');
  });
});

// —— 以下只服务 createGameOverUi 那三条(破例的理由见文件头)——

/** 桩元素:createGameOverUi 只碰它的 style / textContent / src / alt / append / addEventListener */
interface StubEl {
  tagName: string;
  style: { cssText: string; color: string; display: string };
  textContent: string;
  src: string;
  alt: string;
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
    src: '',
    alt: '',
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
  /** #ui 覆盖层:遮罩 append 到这里,"重开一局多长出一块"于是一眼数得出来 */
  ui: StubEl;
  /** window.addEventListener 的累计次数:show/hide 多少回都不该让它再涨 */
  windowListeners: number;
  /** 造出来的元素按顺序留档:遮罩 = 第一个 div,img 与 button 各只有一个 */
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
    // isTyping 读它:null = 焦点不在输入框里,于是 Enter 该被当成"再来一局"
    activeElement: null,
  };
  // Node 里没有 HTMLElement,而 isTyping 拿它做 instanceof —— 不给就直接 ReferenceError
  g.HTMLElement = class HTMLElement {};
  return dom;
}

/** 遮罩 = #ui 的唯一子节点(见 createGameOverUi 的 appendChild) */
function root(dom: StubDom): StubEl {
  return dom.ui.children[0]!;
}

/** 剪影那张 img:createGameOverUi 只造一个 */
function shot(dom: StubDom): StubEl {
  return dom.created.find((el) => el.tagName === 'IMG')!;
}

function button(dom: StubDom): StubEl {
  return dom.created.find((el) => el.tagName === 'BUTTON')!;
}

describe('createGameOverUi', () => {
  let dom: StubDom;
  let restarts: number;

  beforeEach(() => {
    dom = installDom();
    restarts = 0;
  });
  afterEach(() => {
    dom.restore();
  });

  function make(): ReturnType<typeof createGameOverUi> {
    return createGameOverUi({
      onRestart: () => {
        restarts++;
      },
    });
  }

  it('默认收着;show 弹出、hide 收回', () => {
    const ui = make();
    // 默认 none 是硬要求:一局刚开始就糊着一块结算遮罩的话,玩家连塔都放不下去
    //(遮罩铺满整屏且吃 pointer-events,见 ROOT_CSS)
    expect(root(dom).style.cssText).toContain('display:none');

    ui.show(summary());
    expect(root(dom).style.display).toBe('flex');
    ui.hide();
    expect(root(dom).style.display).toBe('none');
  });

  it('印的就是那三行 + 胜负各自的标题(与纯函数同一份口径)', () => {
    const ui = make();
    const s = summary({ result: RESULT_LOSE, survivedSec: 61, kills: 3, segment: 1 });
    ui.show(s);

    const texts = root(dom).children[0]!.children.map((el) => el.textContent);
    expect(texts).toContain(resultTitle(RESULT_LOSE));
    expect(texts).toContain(resultNote(RESULT_LOSE));
    expect(texts).toContain(summaryText(s));
  });

  it('剪影抓不到(null)就整个不显示,**且不动 src** —— 置空 src 会让浏览器重新请求当前页', () => {
    const ui = make();
    ui.show(summary({ silhouette: 'data:image/png;base64,AAAA' }));
    expect(shot(dom).style.display).toBe('block');
    expect(shot(dom).src).toBe('data:image/png;base64,AAAA');

    ui.show(summary({ silhouette: null }));
    expect(shot(dom).style.display).toBe('none');
    expect(shot(dom).src).toBe('data:image/png;base64,AAAA');
  });

  it('按钮与 Enter 都通向同一个 onRestart,且**点了当场收起来**', () => {
    const ui = make();
    ui.show(summary());
    button(dom).listeners.get('click')!(undefined);
    expect(restarts).toBe(1);
    // 不收的话,onRestart 里新建的那一局会顶着一块结算遮罩开出去
    expect(root(dom).style.display).toBe('none');

    ui.show(summary());
    dom.key(keyEvent('Enter'));
    expect(restarts).toBe(2);
    expect(root(dom).style.display).toBe('none');
  });

  it('收着的时候 Enter 一律不认 —— 战斗中误按回车不该把正打着的一局重开掉', () => {
    const ui = make();
    dom.key(keyEvent('Enter'));
    expect(restarts).toBe(0);

    // 弹出 → 重开(自动收起)之后再按,同样不该再触发:一次结算只该重开一局
    ui.show(summary());
    dom.key(keyEvent('Enter'));
    dom.key(keyEvent('Enter'));
    expect(restarts).toBe(1);
  });

  it('长按不连发(repeat),Enter 之外的键一概不管', () => {
    const ui = make();
    ui.show(summary());
    dom.key(keyEvent('Enter', true));
    dom.key(keyEvent('Space'));
    dom.key(keyEvent('KeyB'));
    expect(restarts).toBe(0);
  });

  it('Enter 必须 preventDefault:按钮带着焦点时,浏览器会再派一次 click(= 一按重开两局)', () => {
    const ui = make();
    ui.show(summary());
    const e = keyEvent('Enter');
    dom.key(e);
    expect(e.defaultPrevented).toBe(true);
  });

  it('只建一次:show/hide 多少回都不再 append DOM、不再挂 window 监听器', () => {
    const ui = make();
    const listeners = dom.windowListeners;
    // 确实挂了、也确实 append 了 —— 否则下面两条"没变"是废话
    expect(listeners).toBeGreaterThan(0);
    expect(dom.ui.children.length).toBe(1);

    for (let i = 0; i < 3; i++) {
      ui.show(summary());
      ui.hide();
    }
    // 每局多一份监听器 = 一次回车重开好几局;每局多一块遮罩 = 战场上永远糊着一层看不见的点击拦截层
    expect(dom.windowListeners).toBe(listeners);
    expect(dom.ui.children.length).toBe(1);
  });
});
