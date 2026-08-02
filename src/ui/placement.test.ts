/**
 * 放置提示文案(03 号 issue T4 + 05 号 issue T5 的塔型/叠级)。主体只测纯函数那几段 ——
 * createPlacementUi 要 DOM 与 canvas,本仓的 vitest 跑在 Node 环境里(不装 jsdom),
 * 交互部分的验收本来也只能靠真人点(见 03 号验收标准),不值得为它拖一个环境进来。
 *
 * 钉的是"每个理由码都当场把规则原文讲一遍"(GDD §4.1/§4.5/§5.4 的规则少到不必做教学关,
 * 前提就是拒绝时必须说清为什么):新增理由码却忘了配文案时,它会静默退化成兜底串 ——
 * 本文件就是那道拦网。塔名与键位则钉"提示条只从数值表取名字",不许 ui 里再抄一份。
 * 注意 ui 只 import type 渲染层,所以这里不会把 pixi 拖进 Node。
 *
 * **唯一的例外是文件末尾的 setWorld**(08 号 issue T3 的重开流程,验收标准原文:
 * 一局从开始到胜利/失败/重开全流程无需刷新页面)。它恰恰**不是交互**,而是"换一局"这条流程里
 * 最容易做漏的一环:换引用 / 不重复注册 window 事件 / 不重复 append DOM,三条各错一次的后果
 * (点了没反应、监听器每局翻倍、提示条越叠越多)都要等真人重开第二、第三局才看得出来。
 * 三条全都能在一个几十行的 DOM 桩上数出来,故这里破一次例 —— 桩只提供 createPlacementUi
 * 真的会碰的那几样(createElement/getElementById/append + window 的三个方法 + canvas 的两个),
 * 绝不发展成半个 jsdom。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SUP_AMMO_BAY, SUP_ARMOR_BAY, SUPPORT_KIND_COUNT, SUPPORTS } from '../data/supports';
import { TOWER_AUTOCANNON, TOWER_KIND_COUNT, TOWER_MAX_LEVEL, TOWERS } from '../data/towers';
import {
  CELL_SUPPORT,
  CELL_WEAPON,
  isPlaceSuccess,
  PLACE_BAD_CONTENT,
  PLACE_BAD_SUPPORT,
  PLACE_BAD_TOWER,
  PLACE_INTERIOR,
  PLACE_MAX_LEVEL,
  PLACE_NO_CELL,
  PLACE_OK,
  PLACE_TAKEN,
  PLACE_UPGRADE,
} from '../sim/deck';
import type { Vec2 } from '../sim/ship';
import { World } from '../sim/world';
import {
  createPlacementUi,
  denyMessage,
  keyHintText,
  nextSupportType,
  placeLabel,
  placedMessage,
} from './placement';

const DENY_CODES = [
  PLACE_NO_CELL,
  PLACE_TAKEN,
  PLACE_INTERIOR,
  PLACE_BAD_CONTENT,
  PLACE_MAX_LEVEL,
  PLACE_BAD_TOWER,
  PLACE_BAD_SUPPORT,
];

describe('denyMessage', () => {
  it('每个拒绝码都有各自的中文文案,互不重复', () => {
    const msgs = DENY_CODES.map(denyMessage);
    for (const m of msgs) expect(m.length).toBeGreaterThan(0);
    // 两个码共用一句话 = 玩家看不出到底撞了哪条规则
    expect(new Set(msgs).size).toBe(DENY_CODES.length);
    // 兜底串只该出现在未知码上;拿它当拒绝文案说明有码漏配了
    for (const m of msgs) expect(m).not.toContain('理由码');
  });

  it('内部格 / 已占用格 / 叠到顶的文案带上规则出处', () => {
    // 前两条是 03 号验收标准里点名的拒绝路径(武器塔进内部格 / 往已占用格里插),
    // 第三条是 05 号的叠级上限 —— 它与"格子已被占用"是两回事,玩家得看得出区别
    expect(denyMessage(PLACE_INTERIOR)).toContain('§4.1');
    expect(denyMessage(PLACE_TAKEN)).toContain('§4.5');
    expect(denyMessage(PLACE_MAX_LEVEL)).toContain('§5.4');
    // 上限从数值表来:把 TOWER_MAX_LEVEL 改成 6,这句提示必须跟着变(改数据即可调平衡)
    expect(denyMessage(PLACE_MAX_LEVEL)).toContain(`Lv${TOWER_MAX_LEVEL}`);
  });

  it('未知码回落成带码的兜底文案,而不是空串', () => {
    // PLACE_OK / PLACE_UPGRADE 走不到 denyMessage(调用方只在非成功时问),故它们也算"未知码"
    for (const code of [PLACE_OK, PLACE_UPGRADE, 99, -1]) {
      expect(denyMessage(code)).toContain(String(code));
    }
  });
});

describe('placeLabel', () => {
  it('武器塔报数值表里的塔名,六种各不相同', () => {
    const names = TOWERS.map((def) => placeLabel(CELL_WEAPON, def.type));
    expect(names).toEqual(TOWERS.map((def) => def.name));
    expect(new Set(names).size).toBe(TOWER_KIND_COUNT);
  });

  it('支援设施报数值表里的设施名,四种各不相同', () => {
    // 与塔名同一条口径(06 号起设施分四型):名字只在 src/data/supports.ts 存一份,ui 不抄第二份
    const names = SUPPORTS.map((def) => placeLabel(CELL_SUPPORT, TOWER_AUTOCANNON, def.type));
    expect(names).toEqual(SUPPORTS.map((def) => def.name));
    expect(new Set(names).size).toBe(SUPPORT_KIND_COUNT);
  });

  it('两种型号互不相干;越界一律报回原始下标而不是悄悄换成另一种', () => {
    // 支援设施不看塔型、武器塔不看设施型 —— 两个参数各自只在自己那种 content 下有意义
    expect(placeLabel(CELL_SUPPORT, 0)).toBe(placeLabel(CELL_SUPPORT, 99));
    expect(placeLabel(CELL_WEAPON, TOWER_AUTOCANNON, 99)).toBe(placeLabel(CELL_WEAPON, TOWER_AUTOCANNON));
    // 静默兜底成第 0 种 = 提示条说的和真放下去的是两码事,这两条就是拦网
    expect(placeLabel(CELL_WEAPON, 99)).toContain('99');
    expect(placeLabel(CELL_SUPPORT, TOWER_AUTOCANNON, 99)).toContain('99');
  });
});

describe('placedMessage', () => {
  it('叠级与新放是两句话:叠级必须报出升到了几级', () => {
    // 叠级不占新格、画面上什么都不会多出来(GDD §5.4),这行字是唯一能证明"点中了"的东西
    const up = placedMessage(PLACE_UPGRADE, '自动机炮', 3);
    expect(up).toContain('自动机炮');
    expect(up).toContain('Lv3');
    expect(placedMessage(PLACE_OK, '自动机炮', 1)).not.toContain('Lv');
    expect(up).not.toBe(placedMessage(PLACE_OK, '自动机炮', 1));
  });

  it('两种成功码都被 isPlaceSuccess 认下(ui 靠它分成功/拒绝)', () => {
    expect(isPlaceSuccess(PLACE_OK)).toBe(true);
    expect(isPlaceSuccess(PLACE_UPGRADE)).toBe(true);
    for (const code of DENY_CODES) expect(isPlaceSuccess(code)).toBe(false);
  });
});

describe('nextSupportType', () => {
  it('支援模式里连按 0:四种一个不落地轮一圈,再按转回弹药库', () => {
    let type = SUP_AMMO_BAY;
    const seen: number[] = [];
    for (let i = 0; i < SUPPORT_KIND_COUNT; i++) {
      type = nextSupportType(CELL_SUPPORT, type);
      seen.push(type);
    }
    // 少一次取模 / 少加一次 1,都会让某一种设施在灰盒里根本选不出来
    expect(new Set(seen).size).toBe(SUPPORT_KIND_COUNT);
    expect(type).toBe(SUP_AMMO_BAY);
  });

  it('刚才选的是武器塔时落回弹药库(弹药库先行),而不是接着上次的轮换位', () => {
    // 与 world.place 的默认设施型同一个值:进支援模式看到的第一种 = 漏传参数时会放下去的那种
    expect(nextSupportType(CELL_WEAPON, SUP_ARMOR_BAY)).toBe(SUP_AMMO_BAY);
    expect(nextSupportType(CELL_WEAPON, SUP_AMMO_BAY)).toBe(SUP_AMMO_BAY);
  });
});

describe('keyHintText', () => {
  it('六种塔的键位从数值表现生成:下标 + 1 = 数字键,塔名一个不落', () => {
    const hint = keyHintText();
    for (let i = 0; i < TOWERS.length; i++) {
      expect(hint).toContain(`${i + 1} ${TOWERS[i]!.name}`);
    }
    // 0 号键是支援设施(与 1..6 的武器塔分开):键位表漏了它,玩家就再也放不出支援设施
    expect(hint).toContain('0 支援设施');
  });

  it('四种设施的名字也从数值表现生成,且写明 0 键是轮换', () => {
    const hint = keyHintText();
    // 一种都不许落下:0 键是唯一的入口,提示条里没写出来的那种设施等于玩家不知道它存在
    for (const def of SUPPORTS) expect(hint).toContain(def.name);
    expect(SUPPORTS.length).toBe(SUPPORT_KIND_COUNT);
    // "按 0 会在四种之间转"必须讲明白:只写"0 支援设施"的话,另外三种没有任何线索
    expect(hint).toContain('轮换');
  });
});

// —— 以下只服务 setWorld 那三条(破例的理由见文件头)——

/** 桩元素:createPlacementUi 只碰它的 style.cssText / style.color / textContent / append / appendChild */
interface StubEl {
  style: { cssText: string; color: string };
  textContent: string;
  children: StubEl[];
  append(...kids: StubEl[]): void;
  appendChild(kid: StubEl): StubEl;
}

function createStubEl(): StubEl {
  const el: StubEl = {
    style: { cssText: '', color: '' },
    textContent: '',
    children: [],
    append(...kids: StubEl[]): void {
      el.children.push(...kids);
    },
    appendChild(kid: StubEl): StubEl {
      el.children.push(kid);
      return kid;
    },
  };
  return el;
}

interface StubDom {
  /** #ui 覆盖层:提示条 append 到这里,"重开一局多长出一条"于是一眼数得出来 */
  ui: StubEl;
  /** window.addEventListener 的累计调用次数:重开一局不该让它再涨 */
  windowListeners: number;
  /** 还没到点的闪现超时。假计时器(不真排队),故测完不会有回调在后面飞 */
  timers: Map<number, () => void>;
  canvas: HTMLCanvasElement;
  /** 触发画布上的一次左键点击(clientX/Y = 画布像素,见下面 getBoundingClientRect) */
  click(x: number, y: number): void;
  restore(): void;
}

function installDom(): StubDom {
  const g = globalThis as unknown as Record<string, unknown>;
  const prevWindow = g.window;
  const prevDocument = g.document;
  const clicks: Array<(e: { clientX: number; clientY: number }) => void> = [];
  let nextTimer = 1;

  const dom: StubDom = {
    ui: createStubEl(),
    windowListeners: 0,
    timers: new Map<number, () => void>(),
    canvas: {
      addEventListener(type: string, fn: (e: { clientX: number; clientY: number }) => void): void {
        if (type === 'click') clicks.push(fn);
      },
      // 画布左上角 = 屏幕原点 ⇒ clientX/Y 直接就是画布像素(与真实的 resolution=1 + 满窗画布一致)
      getBoundingClientRect(): { left: number; top: number } {
        return { left: 0, top: 0 };
      },
    } as unknown as HTMLCanvasElement,
    click(x: number, y: number): void {
      for (const fn of clicks) fn({ clientX: x, clientY: y });
    },
    restore(): void {
      g.window = prevWindow;
      g.document = prevDocument;
    },
  };

  g.window = {
    addEventListener(): void {
      dom.windowListeners++;
    },
    setTimeout(fn: () => void): number {
      const id = nextTimer++;
      dom.timers.set(id, fn);
      return id;
    },
    clearTimeout(id: number): void {
      dom.timers.delete(id);
    },
  };
  g.document = {
    createElement: (): StubEl => createStubEl(),
    getElementById: (id: string): StubEl | null => (id === 'ui' ? dom.ui : null),
  };
  return dom;
}

/** 屏幕像素 = 世界坐标:船开局停在世界原点,于是点 (0,0) 就是点在船正中那一格上 */
function screenIsWorld(sx: number, sy: number, out: Vec2): Vec2 {
  out.x = sx;
  out.y = sy;
  return out;
}

function countSupports(world: World): number {
  return world.deck.cells.filter((c) => c.content === CELL_SUPPORT).length;
}

/** 提示条是 #ui 的唯一子节点,它的第三行是闪现行(见 createPlacementUi 里 box.append 的顺序) */
function flashText(dom: StubDom): string {
  return dom.ui.children[0]?.children[2]?.textContent ?? '';
}

describe('createPlacementUi().setWorld', () => {
  let dom: StubDom;

  beforeEach(() => {
    dom = installDom();
  });
  afterEach(() => {
    dom.restore();
  });

  it('换掉 world 引用:重开后点下去的格落在新船上,旧船一格不动', () => {
    const first = new World(1);
    const second = new World(2);
    const ui = createPlacementUi({
      world: first,
      canvas: dom.canvas,
      screenToWorld: screenIsWorld,
    });
    // 直接改状态对象而不是模拟按键:PlacementUi 就是渲染层每帧读的那个 state(见 PlacementUiState),
    // 这里要测的是 setWorld,不是键位。选支援设施是因为船正中那一格是内部格(武器塔进不去,GDD §4.1)
    ui.active = true;
    ui.content = CELL_SUPPORT;

    dom.click(0, 0);
    expect(countSupports(first)).toBe(1);
    expect(countSupports(second)).toBe(0);

    ui.setWorld(second);
    dom.click(0, 0);
    // 忘了换引用的话,这一下会照旧落进上一局那艘沉船里,而画面上什么都不会发生
    // (渲染层读的是新 World 的甲板)—— 那正是最难查的一类"点了没反应"
    expect(countSupports(second)).toBe(1);
    expect(countSupports(first)).toBe(1);
  });

  it('不重复注册 window 事件、不重复 append DOM', () => {
    const ui = createPlacementUi({
      world: new World(1),
      canvas: dom.canvas,
      screenToWorld: screenIsWorld,
    });
    const listeners = dom.windowListeners;
    // 建的时候确实挂了监听器、也确实 append 了提示条 —— 否则下面两条"没变"是废话
    expect(listeners).toBeGreaterThan(0);
    expect(dom.ui.children.length).toBe(1);

    ui.setWorld(new World(2));
    ui.setWorld(new World(3));
    // 每重开一局多一份监听器 = 一次点击放好几次塔;多一条提示条 = 左下角越堆越高
    expect(dom.windowListeners).toBe(listeners);
    expect(dom.ui.children.length).toBe(1);
  });

  it('复位悬停格/被拒格与闪现计时,但不动放置模式开关', () => {
    const ui = createPlacementUi({
      world: new World(1),
      canvas: dom.canvas,
      screenToWorld: screenIsWorld,
    });
    // 默认 content = CELL_WEAPON,而船正中是内部格 ⇒ 必被拒(PLACE_INTERIOR,GDD §4.1)
    ui.active = true;
    dom.click(0, 0);
    expect(ui.denyIndex).toBeGreaterThanOrEqual(0);
    expect(flashText(dom)).not.toBe('');
    expect(dom.timers.size).toBe(1);
    ui.hoverIndex = ui.denyIndex;

    ui.setWorld(new World(2));
    // 两个下标都是上一艘船上的位置:留着就会在新局第一帧描出一个与光标无关的框/红闪
    expect(ui.hoverIndex).toBe(-1);
    expect(ui.denyIndex).toBe(-1);
    // 计时器也得停:留着的话它会在新局里回来抹一次 denyIndex —— 抹的是别人的状态
    expect(dom.timers.size).toBe(0);
    expect(flashText(dom)).toBe('');
    // 开关是玩家自己的选择,重开一局不该顺手替他关掉
    expect(ui.active).toBe(true);
  });
});
