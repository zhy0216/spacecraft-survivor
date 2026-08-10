import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DOCK_EDICT_COUNT,
  DOCK_EDICT_PRICE,
  DOCK_REPAIR_FRACTION,
  DOCK_REPAIR_PRICE,
} from '../data/economy';
import {
  EDICT_COOLANT,
  EDICT_CRUISE,
  EDICT_GYRO,
  EDICT_HULL,
  EDICT_MAGNET,
  EDICT_RAPID,
  EDICT_TRACER,
  EDICTS,
} from '../data/edicts';
import { evolutionOf } from '../data/evolutions';
import { SUP_AMMO_BAY, SUP_RADIATOR } from '../data/supports';
import { TOWER_AUTOCANNON, TOWER_LASER, TOWER_MAX_LEVEL, TOWERS } from '../data/towers';
import {
  CELL_EMPTY,
  CELL_SUPPORT,
  CELL_WEAPON,
  cellAt,
  cellLocalPos,
  createDeck,
  type Deck,
  evolveAt,
  EVOLVE_BAD_SUPPORT,
  EVOLVE_BAD_TARGET,
  EVOLVE_NOT_MAX_LEVEL,
  EVOLVE_NO_RECIPE,
  EVOLVE_OK,
  isPlaceSuccess,
  moveModule,
  MOVE_OK,
  placeAt,
  MOVE_NO_SOURCE,
  MOVE_NO_TARGET,
  MOVE_SAME_CELL,
  MOVE_TARGET_TAKEN,
  MOVE_WEAPON_INTERIOR,
  WELD_BAD_PIECE,
  WELD_BAD_ROTATION,
  WELD_DETACHED,
  WELD_OVERLAP,
} from '../sim/deck';
import { syncSupportBuffs } from '../sim/support';
import {
  DOCK_EDICT_SOLD,
  DOCK_HP_FULL,
  DOCK_NO_STARCOINS,
  REFIT_ALREADY_WELDED,
  REFIT_NOT_ACTIVE,
  type World,
} from '../sim/world';
import {
  createRefitFlow,
  dockEdictEffect,
  refitDenyMessage,
  refitShopWidth,
  refitThreatSummary,
} from './refitFlow';

describe('整备面板纯文案', () => {
  it('下一波摘要从波次表生成，并点出逐段首次出现的敌型', () => {
    expect(refitThreatSummary(1)).toContain('碎石带');
    expect(refitThreatSummary(1)).toContain('新敌型：尾随蛆');
    expect(refitThreatSummary(2)).toContain('新敌型：冲撞甲虫');
    expect(refitThreatSummary(3)).toContain('蜂群蛭 4.2→5.4/秒');
    expect(refitThreatSummary(99)).toBe('下一波资料缺失');
  });

  it('所有整备拒绝码都有明确中文原因，不退化成裸数字', () => {
    const codes = [
      MOVE_NO_SOURCE,
      MOVE_NO_TARGET,
      MOVE_TARGET_TAKEN,
      MOVE_WEAPON_INTERIOR,
      MOVE_SAME_CELL,
      WELD_OVERLAP,
      WELD_DETACHED,
      WELD_BAD_PIECE,
      WELD_BAD_ROTATION,
      REFIT_ALREADY_WELDED,
      REFIT_NOT_ACTIVE,
      EVOLVE_BAD_TARGET,
      EVOLVE_BAD_SUPPORT,
      EVOLVE_NOT_MAX_LEVEL,
      EVOLVE_NO_RECIPE,
      DOCK_EDICT_SOLD,
      DOCK_NO_STARCOINS,
      DOCK_HP_FULL,
    ];
    for (const code of codes) {
      const text = refitDenyMessage(code);
      expect(text.length).toBeGreaterThan(4);
      expect(text).not.toBe(`整备操作被拒绝(理由码 ${code})`);
    }
  });

  it('固定商店栏在常见桌面宽度下保持可读，并给左侧甲板留出空间', () => {
    expect(refitShopWidth(800)).toBe(300);
    expect(refitShopWidth(1200)).toBe(408);
    expect(refitShopWidth(1920)).toBe(430);
    expect(refitShopWidth(Number.NaN)).toBe(0);
  });

  it('法令效果文案取自数值表:乘 1 / 加 0 的中性档不印,其余按档翻译', () => {
    expect(dockEdictEffect(EDICT_TRACER)).toBe('弹药射速 ×1.1');
    expect(dockEdictEffect(EDICT_GYRO)).toBe('转向 +10°/s');
    expect(dockEdictEffect(EDICT_MAGNET)).toBe('拾取半径 ×1.3');
    expect(dockEdictEffect(EDICT_COOLANT)).toBe('过热上限 ×1.2');
    expect(dockEdictEffect(EDICT_HULL)).toBe('船体 HP +20');
    expect(dockEdictEffect(EDICT_CRUISE)).toBe('巡航速度 ×1.1');
    expect(dockEdictEffect(EDICT_RAPID)).toBe('弹药射速 ×1.25');
    expect(dockEdictEffect(999)).toBe('未知法令');
  });
});

// —— 以下只服务"重排阶段可触发进化"那几条(破例上 DOM 桩的理由与 upgradeFlow.test.ts 文件头一字同源:
//    玩家在船坞里的点确认必须翻译成对 World.evolveRefitTower 的**一次**调用、拒绝码必须说人话,
//    这类"点错一下"的规则只有把 UI 桩起来才钉得住;桩只提供 createRefitFlow 真会碰的那几样)——

interface StubEvent {
  clientX?: number;
  clientY?: number;
  code?: string;
  repeat?: boolean;
  preventDefault(): void;
}

/** 桩元素:createRefitFlow 只碰它的 style 几项 / textContent / innerHTML / disabled / append / addEventListener */
interface StubEl {
  style: Record<string, string>;
  textContent: string;
  innerHTML: string;
  disabled: boolean;
  children: StubEl[];
  handlers: Map<string, Array<(e: StubEvent) => void>>;
  append(...kids: StubEl[]): void;
  appendChild(kid: StubEl): StubEl;
  addEventListener(type: string, fn: (e: StubEvent) => void): void;
  setAttribute(name: string, value: string): void;
}

function createStubEl(): StubEl {
  const el: StubEl = {
    style: {},
    textContent: '',
    innerHTML: '',
    disabled: false,
    children: [],
    handlers: new Map<string, Array<(e: StubEvent) => void>>(),
    append(...kids: StubEl[]): void {
      el.children.push(...kids);
    },
    appendChild(kid: StubEl): StubEl {
      el.children.push(kid);
      return kid;
    },
    addEventListener(type: string, fn: (e: StubEvent) => void): void {
      const list = el.handlers.get(type) ?? [];
      list.push(fn);
      el.handlers.set(type, list);
    },
    setAttribute(): void {},
  };
  return el;
}

/** 触发桩元素上的一次事件(没挂监听器就什么都不做,与真 DOM 一致;disabled 不拦,由实现自守) */
function fire(el: StubEl, type: string, e: Partial<StubEvent> = {}): void {
  const ev: StubEvent = { preventDefault: () => {}, ...e };
  for (const fn of el.handlers.get(type) ?? []) fn(ev);
}

interface StubDom {
  /** #ui 覆盖层:面板与提示条 append 到这里 */
  ui: StubEl;
  /** window.addEventListener 的累计调用次数 */
  windowListeners: number;
  /** 还没到点的提示超时。假计时器(不真排队),故测完不会有回调在后面飞 */
  timers: Map<number, () => void>;
  canvas: HTMLCanvasElement;
  /** 画布上的一次左键点击(clientX/Y = 画布像素,见下面 getBoundingClientRect) */
  click(x: number, y: number): void;
  /** 一次按键(只用得到 code) */
  key(code: string): void;
  restore(): void;
}

function installDom(): StubDom {
  const g = globalThis as unknown as Record<string, unknown>;
  const prevWindow = g.window;
  const prevDocument = g.document;
  const prevHtmlElement = g.HTMLElement;
  const canvasEl = createStubEl();
  const keyHandlers: Array<(e: StubEvent) => void> = [];
  let nextTimer = 1;

  const dom: StubDom = {
    ui: createStubEl(),
    windowListeners: 0,
    timers: new Map<number, () => void>(),
    canvas: Object.assign(canvasEl, {
      // 画布左上角 = 屏幕原点 ⇒ clientX/Y 直接就是画布像素(与真实的 resolution=1 + 满窗画布一致)
      getBoundingClientRect: (): { left: number; top: number } => ({ left: 0, top: 0 }),
    }) as unknown as HTMLCanvasElement,
    click(x: number, y: number): void {
      fire(canvasEl, 'click', { clientX: x, clientY: y });
    },
    key(code: string): void {
      const ev: StubEvent = { code, repeat: false, preventDefault: () => {} };
      for (const fn of keyHandlers) fn(ev);
    },
    restore(): void {
      g.window = prevWindow;
      g.document = prevDocument;
      g.HTMLElement = prevHtmlElement;
    },
  };

  g.window = {
    innerWidth: 1200,
    addEventListener(type: string, fn: (e: StubEvent) => void): void {
      dom.windowListeners++;
      if (type === 'keydown') keyHandlers.push(fn);
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
  // isTyping 里那句 `el instanceof HTMLElement` 在 Node 里没有这个全局,不补就是一声 ReferenceError
  g.HTMLElement = class {};
  return dom;
}

/**
 * 桩 World:进化侧只提供 createRefitFlow 真会读的那几样(见文件头取舍)。
 * evolveRefitTower **走真 evolveAt** —— 本文件要钉的"成功当场刷新甲板"是 UI 把
 * 配对坐标原样交给世界、世界把塔换掉这件事,桩只代为接线,不另造一套世界。
 */
interface StubWorld {
  deck: Deck;
  refitPending: boolean;
  refitWelded: boolean;
  /** 星币区(21 号):余额读数 + 货架 + 购买记账,桩里走一份最小 fake(规则本体在 world.test.ts 钉) */
  starCoins: number;
  ship: { hp: number; maxHp: number };
  dockEdictOffers: number[];
  /** 每次 buyDockEdict 的入参下标 */
  buyCalls: number[];
  /** buyDockRepair 的调用次数 */
  repairCalls: number;
  /** 强制的返回码:设置后不真记账(测拒绝路径用),undefined = 走最小 fake */
  buyForce: number | undefined;
  /** 每次 evolveRefitTower 的入参:[towerCol, towerRow, supportCol, supportRow] */
  evolveCalls: number[][];
  /** 每次 moveRefitModule 的入参:[fromCol, fromRow, toCol, toRow] */
  moveCalls: number[][];
  /** 强制的返回码:设置后不真改甲板(测拒绝路径用),undefined = 走真 evolveAt */
  evolveForce: number | undefined;
  evolveRefitTower(towerCol: number, towerRow: number, supportCol: number, supportRow: number): number;
  moveRefitModule(fromCol: number, fromRow: number, toCol: number, toRow: number): number;
  buyDockEdict(index: number): number;
  buyDockRepair(): number;
  completeRefit(): boolean;
}

function createStubWorld(): StubWorld {
  const w: StubWorld = {
    deck: createDeck(),
    refitPending: true,
    refitWelded: false,
    starCoins: 999,
    ship: { hp: 100, maxHp: 100 },
    dockEdictOffers: [],
    buyCalls: [],
    repairCalls: 0,
    buyForce: undefined,
    evolveCalls: [],
    moveCalls: [],
    evolveForce: undefined,
    evolveRefitTower(towerCol: number, towerRow: number, supportCol: number, supportRow: number): number {
      w.evolveCalls.push([towerCol, towerRow, supportCol, supportRow]);
      if (w.evolveForce !== undefined) return w.evolveForce;
      const code = evolveAt(w.deck, towerCol, towerRow, supportCol, supportRow);
      if (code === EVOLVE_OK) syncSupportBuffs(w.deck);
      return code;
    },
    moveRefitModule(fromCol: number, fromRow: number, toCol: number, toRow: number): number {
      w.moveCalls.push([fromCol, fromRow, toCol, toRow]);
      const code = moveModule(w.deck, fromCol, fromRow, toCol, toRow);
      if (code === MOVE_OK) syncSupportBuffs(w.deck);
      return code;
    },
    // 最小 fake 只复刻 UI 会读的那几样账(余额/货架/血量),规则本体(校验顺序、原子性)在
    // world.test.ts 钉 —— 这里要钉的是"点击翻译成对 World 的一次调用、返回码说人话"
    buyDockEdict(index: number): number {
      w.buyCalls.push(index);
      if (w.buyForce !== undefined) return w.buyForce;
      if (w.starCoins < DOCK_EDICT_PRICE) return DOCK_NO_STARCOINS;
      const type = w.dockEdictOffers[index];
      if (type === undefined || type < 0) return DOCK_EDICT_SOLD;
      w.starCoins -= DOCK_EDICT_PRICE;
      w.dockEdictOffers[index] = -1;
      return 0;
    },
    buyDockRepair(): number {
      w.repairCalls++;
      if (w.buyForce !== undefined) return w.buyForce;
      if (w.ship.hp >= w.ship.maxHp) return DOCK_HP_FULL;
      if (w.starCoins < DOCK_REPAIR_PRICE) return DOCK_NO_STARCOINS;
      w.starCoins -= DOCK_REPAIR_PRICE;
      w.ship.hp = Math.min(w.ship.maxHp, w.ship.hp + Math.ceil(w.ship.maxHp * DOCK_REPAIR_FRACTION));
      return 0;
    },
    completeRefit(): boolean {
      return true;
    },
  };
  return w;
}

/** 放一座塔并直接塞到满级(叠到 Lv5 要放四次,测试直写等级即可,与 evolve.test.ts 同款) */
function lv5Tower(deck: Deck, col: number, row: number, type: number): void {
  const code = placeAt(deck, col, row, CELL_WEAPON, type);
  expect(isPlaceSuccess(code), `塔 ${type} @(${col},${row})`).toBe(true);
  cellAt(deck, col, row)!.level = TOWER_MAX_LEVEL;
}

/** 放一块支援设施。第 4 参(塔型)对设施完全无意义,照 deck 的签名原样传缺省值 */
function support(deck: Deck, col: number, row: number, type: number): void {
  const code = placeAt(deck, col, row, CELL_SUPPORT, TOWER_AUTOCANNON, type);
  expect(isPlaceSuccess(code), `设施 ${type} @(${col},${row})`).toBe(true);
}

// —— 面板的 DOM 结构(见 createRefitFlow 里 append 的顺序):
//    #ui = [root, toast];root = [workspace, shop];
//    workspace = [workspaceHead, workspaceHint, evolveBanner];evolveBanner = [evolveText, evolveBtn];
//    shop = [shopHead, threat, shopNote, cards, starSection, actions];
//    starSection = [starHead, edictRows(2), repairBtn];actions = [skipWeld, back, rotate, finish] ——
const rootOf = (dom: StubDom): StubEl => dom.ui.children[0]!;
const workspaceOf = (dom: StubDom): StubEl => rootOf(dom).children[0]!;
const evolveBannerOf = (dom: StubDom): StubEl => workspaceOf(dom).children[2]!;
const evolveTextOf = (dom: StubDom): StubEl => evolveBannerOf(dom).children[0]!;
const evolveBtnOf = (dom: StubDom): StubEl => evolveBannerOf(dom).children[1]!;
const shopOf = (dom: StubDom): StubEl => rootOf(dom).children[1]!;
const starSectionOf = (dom: StubDom): StubEl => shopOf(dom).children[4]!;
const actionsOf = (dom: StubDom): StubEl => shopOf(dom).children[5]!;
const skipBtnOf = (dom: StubDom): StubEl => actionsOf(dom).children[0]!;
const toastOf = (dom: StubDom): StubEl => dom.ui.children[1]!;
const starHeadOf = (dom: StubDom): StubEl => starSectionOf(dom).children[0]!;
/** 第 i 张法令卡(0 起),紧跟 starHead 之后 */
const edictRowOf = (dom: StubDom, i: number): StubEl => starSectionOf(dom).children[1 + i]!;
/** 修复按钮 = starHead + DOCK_EDICT_COUNT 张法令卡之后的那一个 */
const repairBtnOf = (dom: StubDom): StubEl => starSectionOf(dom).children[1 + DOCK_EDICT_COUNT]!;

describe('createRefitFlow 重排阶段的进化提示与确认', () => {
  let dom: StubDom;
  let world: StubWorld;
  let resolved: number;

  /** 起手:弹整备面板(停选拼块阶段),再点"不扩建,进入重排" */
  function setup(): ReturnType<typeof createRefitFlow> {
    const flow = createRefitFlow({
      world: world as unknown as World,
      canvas: dom.canvas,
      screenToDeckLocal: (sx: number, sy: number, out: { x: number; y: number }) => {
        out.x = sx;
        out.y = sy;
        return out;
      },
      onLayout: () => {},
      onResolved: () => {
        resolved++;
      },
    });
    flow.show(1);
    fire(skipBtnOf(dom), 'click');
    return flow;
  }

  beforeEach(() => {
    dom = installDom();
    world = createStubWorld();
    resolved = 0;
  });
  afterEach(() => {
    dom.restore();
  });

  it('配方满足:重排阶段出现"可进化"提示,文案含进化塔名,按钮可点', () => {
    lv5Tower(world.deck, 1, 0, TOWER_AUTOCANNON);
    support(world.deck, 1, 1, SUP_AMMO_BAY);
    const flow = createRefitFlow({
      world: world as unknown as World,
      canvas: dom.canvas,
      screenToDeckLocal: (sx: number, sy: number, out: { x: number; y: number }) => {
        out.x = sx;
        out.y = sy;
        return out;
      },
      onLayout: () => {},
      onResolved: () => {},
    });
    flow.show(1);
    // 相位状态机:选拼块阶段不出进化提示/按钮(焊接与搬运各归各的相位)
    expect(evolveBannerOf(dom).style.display).toBe('none');
    fire(skipBtnOf(dom), 'click');
    expect(evolveBannerOf(dom).style.display).toBe('flex');
    const resultName = TOWERS[evolutionOf(TOWER_AUTOCANNON, SUP_AMMO_BAY)]!.name;
    expect(evolveTextOf(dom).textContent).toContain(resultName);
    expect(evolveTextOf(dom).textContent).toContain('不可逆');
    expect(evolveBtnOf(dom).disabled).toBe(false);
  });

  it('配方不满足绝不触发:型号不对时提示隐藏、按钮不可点,点了也不惊动 World', () => {
    lv5Tower(world.deck, 1, 0, TOWER_AUTOCANNON);
    support(world.deck, 1, 1, SUP_RADIATOR); // 同一位置,只是型号不对
    setup();
    expect(evolveBannerOf(dom).style.display).toBe('none');
    expect(evolveBtnOf(dom).disabled).toBe(true);
    fire(evolveBtnOf(dom), 'click');
    expect(world.evolveCalls).toEqual([]);
  });

  it('点确认 → 把 (塔格, 支援格) 原样交给 world.evolveRefitTower;成功当场刷新甲板与配对', () => {
    lv5Tower(world.deck, 1, 0, TOWER_AUTOCANNON);
    support(world.deck, 1, 1, SUP_AMMO_BAY);
    setup();
    const resultName = TOWERS[evolutionOf(TOWER_AUTOCANNON, SUP_AMMO_BAY)]!.name;
    fire(evolveBtnOf(dom), 'click');
    expect(world.evolveCalls).toEqual([[1, 0, 1, 1]]);
    // 甲板真的变了(桩 world 走真 evolveAt):塔替换为进化型、支援格清空释放
    expect(cellAt(world.deck, 1, 0)!.towerType).toBe(evolutionOf(TOWER_AUTOCANNON, SUP_AMMO_BAY));
    expect(cellAt(world.deck, 1, 0)!.level).toBe(TOWER_MAX_LEVEL); // 等级承接
    expect(cellAt(world.deck, 1, 1)!.content).toBe(CELL_EMPTY);
    // 视图刷新:配对已消耗,提示消失;toast 报出进化结果(文案含进化塔名)
    expect(evolveBannerOf(dom).style.display).toBe('none');
    expect(toastOf(dom).textContent).toContain('已进化');
    expect(toastOf(dom).textContent).toContain(resultName);
  });

  it('多对并存:吃一对后当场重扫,下一对自动顶上;全吃光后提示消失', () => {
    lv5Tower(world.deck, 1, 0, TOWER_AUTOCANNON);
    support(world.deck, 1, 1, SUP_AMMO_BAY);
    lv5Tower(world.deck, 1, 3, TOWER_LASER);
    support(world.deck, 0, 3, SUP_RADIATOR);
    setup();
    const first = TOWERS[evolutionOf(TOWER_AUTOCANNON, SUP_AMMO_BAY)]!.name;
    const second = TOWERS[evolutionOf(TOWER_LASER, SUP_RADIATOR)]!.name;
    expect(evolveTextOf(dom).textContent).toContain(first);
    expect(evolveTextOf(dom).textContent).toContain('另有 1 对可进化');

    fire(evolveBtnOf(dom), 'click');
    // 第一对被吃掉,配对表重扫后提示仍在、换成了下一对
    expect(evolveBannerOf(dom).style.display).toBe('flex');
    expect(evolveTextOf(dom).textContent).toContain(second);
    expect(evolveTextOf(dom).textContent).not.toContain(first);

    fire(evolveBtnOf(dom), 'click');
    expect(world.evolveCalls).toEqual([
      [1, 0, 1, 1],
      [1, 3, 0, 3],
    ]);
    expect(evolveBannerOf(dom).style.display).toBe('none');
  });

  it('拒绝码走 refitDenyMessage 说人话:提示保留、配对不消耗,玩家可以换布局再试', () => {
    lv5Tower(world.deck, 1, 0, TOWER_AUTOCANNON);
    support(world.deck, 1, 1, SUP_AMMO_BAY);
    world.evolveForce = EVOLVE_NO_RECIPE;
    setup();
    fire(evolveBtnOf(dom), 'click');
    expect(world.evolveCalls).toEqual([[1, 0, 1, 1]]);
    expect(toastOf(dom).textContent).toBe(refitDenyMessage(EVOLVE_NO_RECIPE));
    // 失败一律原子拒绝:配对原样保留,提示还在
    expect(evolveBannerOf(dom).style.display).toBe('flex');
    expect(evolveBtnOf(dom).disabled).toBe(false);
  });

  it('重排阶段的搬运会刷新配对:把支援挪出相邻位后提示当场消失', () => {
    lv5Tower(world.deck, 1, 0, TOWER_AUTOCANNON);
    support(world.deck, 1, 1, SUP_AMMO_BAY);
    const flow = createRefitFlow({
      world: world as unknown as World,
      canvas: dom.canvas,
      screenToDeckLocal: (sx: number, sy: number, out: { x: number; y: number }) => {
        out.x = sx;
        out.y = sy;
        return out;
      },
      onLayout: () => {},
      onResolved: () => {},
    });
    flow.show(1);
    fire(skipBtnOf(dom), 'click');
    expect(evolveBannerOf(dom).style.display).toBe('flex');

    // 屏幕坐标 = 甲板局部坐标(桩里的恒等换算):点格心 = 点在这一格上。
    // 第一次点击拿起支援 (1,1),第二次点到斜角空格 (0,1) 落位 ——
    // 斜角不构成正交相邻,配对当场拆散(与 arrangeClick 的真实路径一致)
    const from = cellLocalPos(world.deck, 1, 1, { x: 0, y: 0 });
    const to = cellLocalPos(world.deck, 0, 1, { x: 0, y: 0 });
    dom.click(from.x, from.y);
    dom.click(to.x, to.y);
    expect(world.moveCalls).toEqual([[1, 1, 0, 1]]);
    // moveRefitModule 成功 → clearSource → syncPanel → 重扫配对 → 提示消失
    expect(evolveBannerOf(dom).style.display).toBe('none');
    expect(evolveBtnOf(dom).disabled).toBe(true);
  });
});

/**
 * 星币区(21 号):整备面板把"点法令卡 / 点修复"翻译成对 World 的一次调用、返回码说人话。
 * 购买规则本体(扣费/生效/失败原子)在 world.test.ts 与 refit.test.ts 钉,这里只钉 UI 那一层:
 * 余额读数、卡片文案取自数值表、点击路径、置灰态与 deny 反馈 —— 与上面"重排阶段的进化"
 * 同一条"破例上 DOM 桩"的取舍(见文件头那段)。
 */
describe('createRefitFlow 星币区(21 号:买法令卡与付费修复)', () => {
  let dom: StubDom;
  let world: StubWorld;
  let resolved: number;

  function setup(seedOffers: number[] = []): ReturnType<typeof createRefitFlow> {
    world.dockEdictOffers.splice(0, world.dockEdictOffers.length, ...seedOffers);
    const flow = createRefitFlow({
      world: world as unknown as World,
      canvas: dom.canvas,
      screenToDeckLocal: (sx: number, sy: number, out: { x: number; y: number }) => {
        out.x = sx;
        out.y = sy;
        return out;
      },
      onLayout: () => {},
      onResolved: () => {
        resolved++;
      },
    });
    flow.show(1);
    return flow;
  }

  beforeEach(() => {
    dom = installDom();
    world = createStubWorld();
    resolved = 0;
  });
  afterEach(() => {
    dom.restore();
  });

  it('余额读数:星币区头部显示 ★ 余额,买完一张当场刷新', () => {
    world.starCoins = 42;
    setup([EDICT_TRACER, EDICT_GYRO]);
    expect(starHeadOf(dom).children[1]!.textContent).toBe('★ 42');
    fire(edictRowOf(dom, 0), 'click');
    expect(world.buyCalls).toEqual([0]);
    expect(starHeadOf(dom).children[1]!.textContent).toBe(`★ ${42 - DOCK_EDICT_PRICE}`);
  });

  it('法令卡文案取自数值表:名字 + 效果 + 价格一行摆全(ui 不抄第二份文案)', () => {
    setup([EDICT_TRACER, EDICT_MAGNET]);
    const first = edictRowOf(dom, 0);
    expect(first.innerHTML).toContain(EDICTS[EDICT_TRACER]!.name);
    expect(first.innerHTML).toContain(dockEdictEffect(EDICT_TRACER));
    expect(first.innerHTML).toContain(`${DOCK_EDICT_PRICE} ★`);
    expect(edictRowOf(dom, 1).innerHTML).toContain(EDICTS[EDICT_MAGNET]!.name);
  });

  it('点法令卡 → 把下标原样交给 world.buyDockEdict;成功当场下架置灰、报回执', () => {
    setup([EDICT_TRACER, EDICT_GYRO]);
    fire(edictRowOf(dom, 0), 'click');
    expect(world.buyCalls).toEqual([0]);
    expect(toastOf(dom).textContent).toContain('已购入');
    expect(toastOf(dom).textContent).toContain(EDICTS[EDICT_TRACER]!.name);
    // 货架下架 → 置灰 → 再点被实现自守拦下,不再惊动 World
    expect(edictRowOf(dom, 0).disabled).toBe(true);
    expect(edictRowOf(dom, 0).innerHTML).toContain('已售出');
    fire(edictRowOf(dom, 0), 'click');
    expect(world.buyCalls).toEqual([0]);
    // 没被买的那一格保持可买
    expect(edictRowOf(dom, 1).disabled).toBe(false);
  });

  it('星币不足:按钮不置灰,点击给出 deny 文案(置灰只认售出/满血,不足靠点击反馈)', () => {
    world.starCoins = DOCK_EDICT_PRICE - 1;
    setup([EDICT_TRACER, EDICT_GYRO]);
    expect(edictRowOf(dom, 0).disabled).toBe(false); // 不足不置灰
    fire(edictRowOf(dom, 0), 'click');
    expect(world.buyCalls).toEqual([0]);
    expect(world.starCoins).toBe(DOCK_EDICT_PRICE - 1); // 失败原子:余额不动
    expect(toastOf(dom).textContent).toBe(refitDenyMessage(DOCK_NO_STARCOINS));
  });

  it('修复按钮:满血置灰不可点;残血可点,点击把决策交给 world.buyDockRepair', () => {
    world.ship.hp = world.ship.maxHp;
    const flow = setup();
    expect(repairBtnOf(dom).disabled).toBe(true); // 满血:置灰
    fire(repairBtnOf(dom), 'click');
    expect(world.repairCalls).toBe(0); // 置灰 + 实现自守:不惊动 World

    // 残血后重新同步面板:置灰态当场放开
    world.ship.hp = 61; // 61 + ceil(0.4 × 100) = 101 → 夹回 100 → 修完即满血
    flow.show(1);
    expect(repairBtnOf(dom).disabled).toBe(false);
    fire(repairBtnOf(dom), 'click');
    expect(world.repairCalls).toBe(1);
    expect(toastOf(dom).textContent).toContain('已修复');
    expect(repairBtnOf(dom).disabled).toBe(true); // 修完满血 → 当场回到置灰
  });

  it('强制拒绝码走 refitDenyMessage 说人话:竞态下(置灰已过期)失败提示正确、账目不动', () => {
    world.starCoins = DOCK_EDICT_PRICE * 2;
    world.buyForce = DOCK_NO_STARCOINS; // 模拟"余额刚被别处花掉"的竞态
    setup([EDICT_TRACER, EDICT_GYRO]);
    fire(edictRowOf(dom, 0), 'click');
    expect(world.buyCalls).toEqual([0]);
    expect(toastOf(dom).textContent).toBe(refitDenyMessage(DOCK_NO_STARCOINS));
    expect(world.starCoins).toBe(DOCK_EDICT_PRICE * 2);
    expect(world.dockEdictOffers).toEqual([EDICT_TRACER, EDICT_GYRO]);
  });
});
