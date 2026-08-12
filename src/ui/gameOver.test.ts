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
import {
  UNLOCK_COLLECT,
  UNLOCK_EDICT,
  UNLOCK_ELITE,
  UNLOCK_LOADOUT,
  UNLOCK_TOWER,
  UNLOCKS,
} from '../data/unlocks';
import { WAVE_SEGMENTS } from '../data/waves';
import { createProgress } from '../sim/progress';
import { RESULT_LOSE, RESULT_RUNNING, RESULT_WIN } from '../sim/world';
import { TOWER_AUTOCANNON, TOWER_LASER, TOWERS } from '../data/towers';
import {
  collectionCategoryName,
  collectionItemName,
  createGameOverUi,
  formatDuration,
  type RunSummary,
  resultNote,
  resultTitle,
  segmentLabel,
  summaryText,
  weaponReportRows,
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

  it('胜利文案挂 Boss(15 号):不再是"航段全通"那句 —— 胜利的唯一来路是 Boss 已击杀', () => {
    expect(resultTitle(RESULT_WIN)).toContain('Boss');
    expect(resultTitle(RESULT_WIN)).not.toContain('航段全通');
    expect(resultNote(RESULT_WIN)).toContain('Boss');
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
    bossKilledAtSec: 0,
    silhouette: null,
    newUnlocks: [],
    progressStats: createProgress(),
    weaponReport: [],
    peakDps: 0,
    ...over,
  };
}

describe('weaponReportRows', () => {
  it('名字取数据表,伤害取整,占比按全武器总伤害算(条加起来是一整局的 100%)', () => {
    const rows = weaponReportRows([
      { type: TOWER_AUTOCANNON, damage: 750.4 },
      { type: TOWER_LASER, damage: 250 },
    ]);
    expect(rows[0]!.name).toBe(TOWERS[TOWER_AUTOCANNON]!.name);
    expect(rows[0]!.damage).toBe(750);
    expect(rows[0]!.ratio).toBeCloseTo(0.7501, 3);
    expect(rows[1]!.ratio).toBeCloseTo(0.2499, 3);
  });

  it('型越界印 #type(不许静默兜底),空表与坏数值不产出 NaN', () => {
    expect(weaponReportRows([{ type: 999, damage: 10 }])[0]!.name).toBe('#999');
    expect(weaponReportRows([])).toEqual([]);
    const rows = weaponReportRows([{ type: TOWER_AUTOCANNON, damage: Number.NaN }]);
    expect(rows[0]!.damage).toBe(0);
    expect(rows[0]!.ratio).toBe(0);
  });
});

describe('summaryText', () => {
  it('失败局三行:存活时间 / 击杀数 / 航段进度,一行都不许少,也不带 Boss 行', () => {
    const lines = summaryText(
      summary({ result: RESULT_LOSE, survivedSec: 125, kills: 7, segment: 1 }),
    ).split('\n');
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('2:05');
    expect(lines[1]).toContain('7');
    expect(lines[2]).toContain('2/4');
    expect(lines.join('\n')).not.toContain('Boss 击杀');
  });

  it('胜利局多一行 Boss 击杀时间(15 号),格式与存活时间同款 m:ss', () => {
    const lines = summaryText(
      summary({ result: RESULT_WIN, survivedSec: 550, kills: 1234, bossKilledAtSec: 550 }),
    ).split('\n');
    expect(lines.length).toBe(4);
    expect(lines[3]).toContain('Boss 击杀');
    expect(lines[3]).toContain('9:10');
    // 未击杀(0)也不印成负数/乱码:照 formatDuration 的夹 0 口径显示 0:00
    const zero = summaryText(summary({ result: RESULT_WIN, bossKilledAtSec: 0 })).split('\n');
    expect(zero[3]).toContain('0:00');
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

describe('collectionCategoryName / collectionItemName(19 号图鉴,20 号加起手配置)', () => {
  it('分类名按 UNLOCK_* 给五类文案,未知 kind 印码不静默(与 resultTitle 的未知码同一口径)', () => {
    expect(collectionCategoryName(UNLOCK_TOWER)).toBe('塔');
    expect(collectionCategoryName(UNLOCK_ELITE)).toBe('敌人');
    expect(collectionCategoryName(UNLOCK_EDICT)).toBe('法令');
    expect(collectionCategoryName(UNLOCK_COLLECT)).toBe('船形剪影');
    expect(collectionCategoryName(UNLOCK_LOADOUT)).toBe('起手配置');
    expect(collectionCategoryName(99)).toBe('分类 99');
  });

  it('条目名从内容表读:塔/法令取数据表名,精英条目带底敌型名,起手配置取 LOADOUTS 名', () => {
    // 导弹巢 / 急速协议在内容表与 UNLOCKS 表同名 —— 数据表改名,图鉴跟着走
    expect(collectionItemName(UNLOCKS[0]!)).toBe('导弹巢');
    expect(collectionItemName(UNLOCKS[1]!)).toBe('急速协议');
    // 虫群母巢的底敌型 = WAVE_LOCKED_ELITES[0].kind → 冲撞甲虫(这条钉着两表的下标咬合)
    expect(collectionItemName(UNLOCKS[2]!)).toBe('虫群母巢(冲撞甲虫精英)');
    expect(collectionItemName(UNLOCKS[3]!)).toBe('船形收藏');
    // 20 号追加的两条起手配置锁(下标 4/5,只增不改):名字读 LOADOUTS 表
    expect(collectionItemName(UNLOCKS[4]!)).toBe('炮击开局');
    expect(collectionItemName(UNLOCKS[5]!)).toBe('狙击开局');
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
  /** 图鉴刷新每次 show 整块重排,createGameOverUi 用 replaceChildren 清场(见 renderCollection) */
  replaceChildren(...kids: StubEl[]): void;
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

/** 结算卡 = 遮罩的唯一子节点;图鉴与「解锁 XX」都长在它里面 */
function panel(dom: StubDom): StubEl {
  return root(dom).children[0]!;
}

/** 深度查找:按谓词扫子树,返回第一个命中(图鉴条目/解锁块都是 leaf,textContent 可精确匹配) */
function findEl(rootEl: StubEl, pred: (el: StubEl) => boolean): StubEl | undefined {
  if (pred(rootEl)) return rootEl;
  for (const kid of rootEl.children) {
    const hit = findEl(kid, pred);
    if (hit) return hit;
  }
  return undefined;
}

/** 「解锁 XX」块 = 结算卡第 6 个子节点(标题、注、剪影、读数、战报、解锁、图鉴、按钮,构造顺序固定,与 upgradeFlow.test 同款按位取) */
function unlockBlock(dom: StubDom): StubEl {
  return panel(dom).children[5]!;
}

/** 武器战报块 = 结算卡第 5 个子节点(位序见 unlockBlock 的注释) */
function reportBlock(dom: StubDom): StubEl {
  return panel(dom).children[4]!;
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

  it('武器战报:有伤害的局出占比行与峰值标题,一炮没开的局整块藏着', () => {
    const ui = make();
    ui.show(
      summary({
        weaponReport: [
          { type: TOWER_AUTOCANNON, damage: 900 },
          { type: TOWER_LASER, damage: 100 },
        ],
        peakDps: 55.6,
      }),
    );
    const report = reportBlock(dom);
    expect(report.style.display).toBe('block');
    // 标题印峰值 DPS(取整);行数 = 标题 + 两把武器
    expect(report.children[0]!.textContent).toBe('武器战报 · 峰值 56 DPS');
    expect(report.children.length).toBe(3);
    expect(findEl(report, (el) => el.textContent === TOWERS[TOWER_AUTOCANNON]!.name)).toBeDefined();
    expect(findEl(report, (el) => el.textContent === '900')).toBeDefined();

    // 换一局(一炮没开):整块收回,行也清空 —— 上一局的战报不许赖在下一局的结算卡里
    ui.show(summary());
    expect(reportBlock(dom).style.display).toBe('none');
    expect(reportBlock(dom).children.length).toBe(0);
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

  it('图鉴:已解锁项彩色、未解锁项灰显(降透明度 + 标注)(19 号,20 号加起手配置)', () => {
    const ui = make();
    // 掩码位 0 = 导弹巢已解锁,其余内容锁全关
    ui.show(
      summary({ progressStats: { unlockMask: 1, wins: 1, kills: 0, eliteKills: 0, silhouettes: [] } }),
    );
    const cardEl = panel(dom);
    const tower = findEl(cardEl, (el) => el.textContent === '导弹巢')!;
    expect(tower.style.cssText).toContain('#c8dcf0');
    expect(tower.style.cssText).not.toContain('opacity');
    const edict = findEl(cardEl, (el) => el.textContent === '急速协议(未解锁)')!;
    expect(edict.style.cssText).toContain('#5f7a99');
    expect(edict.style.cssText).toContain('opacity:.45');
    const elite = findEl(cardEl, (el) => el.textContent === '虫群母巢(冲撞甲虫精英)(未解锁)')!;
    expect(elite.style.cssText).toContain('opacity:.45');
    // 起手配置与内容锁同栏:未解锁灰显(20 号)
    const loadout = findEl(cardEl, (el) => el.textContent === '炮击开局(未解锁)')!;
    expect(loadout.style.cssText).toContain('opacity:.45');
    // 计数头:5 条内容解锁里开了 1 条(船形收藏无条件,不计入分子分母)
    const title = findEl(cardEl, (el) => el.textContent.startsWith('图鉴'))!;
    expect(title.textContent).toBe('图鉴 · 内容解锁 1/5');
    // 全解锁时计数头到顶,条目不再带"(未解锁)"
    ui.show(
      summary({
        progressStats: {
          unlockMask: 0b111111,
          wins: 1,
          kills: 9999,
          eliteKills: 14,
          silhouettes: [],
        },
      }),
    );
    expect(findEl(cardEl, (el) => el.textContent.startsWith('图鉴'))!.textContent).toBe(
      '图鉴 · 内容解锁 5/5',
    );
    expect(findEl(cardEl, (el) => el.textContent === '导弹巢(未解锁)')).toBeUndefined();
  });

  it('图鉴:剪影展示最近 N 张,一张都没有给占位(19 号)', () => {
    const ui = make();
    ui.show(summary({ progressStats: createProgress() }));
    const cardEl = panel(dom);
    const placeholder = findEl(cardEl, (el) => el.textContent.includes('暂无收藏剪影'))!;
    expect(placeholder.textContent).toContain('暂无收藏剪影');

    ui.show(
      summary({
        progressStats: { ...createProgress(), silhouettes: ['data:old', 'data:a', 'data:b', 'data:c'] },
      }),
    );
    // 只留最近 N 张缩略图;最旧那张(data:old)被挤掉;shotEl(src 为空)不混进来
    const imgs: StubEl[] = [];
    (function collect(el: StubEl): void {
      if (el.tagName === 'IMG') imgs.push(el);
      for (const kid of el.children) collect(kid);
    })(cardEl);
    const thumbs = imgs.filter((el) => el.src !== '');
    expect(thumbs.map((el) => el.src)).toEqual(['data:a', 'data:b', 'data:c']);
    expect(findEl(cardEl, (el) => el.textContent.includes('暂无收藏剪影'))).toBeUndefined();
  });

  it('「解锁 XX」:有新解锁才显示,空数组整个隐藏(19 号)', () => {
    const ui = make();
    ui.show(summary({ newUnlocks: [] }));
    // 无新解锁:块藏起来,且不残留上一局的"解锁:"字样
    expect(unlockBlock(dom).style.display).toBe('none');
    expect(findEl(panel(dom), (el) => el.textContent.startsWith('解锁:'))).toBeUndefined();

    ui.show(summary({ newUnlocks: [0, 2] }));
    expect(unlockBlock(dom).style.display).toBe('block');
    // 与局内 toast 同一句"解锁:名字";多条换行排开
    expect(unlockBlock(dom).textContent).toBe('解锁:导弹巢\n解锁:虫群母巢');
  });

  it('失败局同样带 newUnlocks:条件达成即记,结算页照报(19 号)', () => {
    const ui = make();
    ui.show(summary({ result: RESULT_LOSE, newUnlocks: [1] }));
    expect(unlockBlock(dom).style.display).toBe('block');
    expect(unlockBlock(dom).textContent).toBe('解锁:急速协议');
    // 失败局图鉴照常铺(未解锁灰显、计数如实),不看胜负
    expect(findEl(panel(dom), (el) => el.textContent === '导弹巢(未解锁)')).toBeDefined();
  });
});
