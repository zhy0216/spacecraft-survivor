/**
 * 三选一升级流程(10 号 issue T4)。分成两半:
 *
 * 前半是**纯函数**——卡片上那三行字与拒绝文案。它们是"改数据文件即可调平衡"这条口径
 * (todos/05 验收)在 ui 侧的落点:名称/描述/等级全部从 data/towers 与 data/supports 现算,
 * 数值表改一个数、加一座塔,卡片必须自己跟上 —— 本文件就是那道拦网。
 * 拒绝文案那一段自 ui/placement.test.ts 迁来(那个文件连同 ui/placement.ts 已整个删除),
 * 钉的仍是"每个理由码都当场把规则原文讲一遍":新增理由码却忘了配文案时,它会静默退化成兜底串。
 *
 * 后半是**两阶段状态机**(选卡 → 放置 → 结算 / 取消)。这一半破例上了一个几十行的 DOM 桩,
 * 理由与旧文件里那段 setWorld 的破例一字同源:它恰恰**不是**"好不好看"的交互,
 * 而是几条只有真人打完一整局才碰得到、碰到了又很难复现的规则 ——
 *   非法格点了不许结算(点一下就白扣一次残骸,而残骸是全程唯一的成长资源);
 *   取消路径不许扣费、更不许恢复战斗(时停漏一次,冻结期间世界就白走一段);
 *   重开一局不许留着上一局的卡片与下标(拿新世界的 offer 去兑上一局的选择);
 *   window 监听器与 DOM 不许每局翻倍(一次点击放好几座塔)。
 * 桩只提供 createUpgradeFlow 真的会碰的那几样,绝不发展成半个 jsdom。
 *
 * World 一侧用**桩**而不是真 World:本文件要钉的是"玩家的一次点击被翻译成了对 World 的哪一次调用、
 * 以及什么时候一次都不该调",而候选怎么生成、费用怎么扣是 sim 那边的用例(sim/upgrade.test.ts /
 * sim/world.test.ts)的事。混在一起的话,这几条规则会被 rng 与波次脚本的噪声盖过去。
 * 注意 ui 只 import type 渲染层,所以这里不会把 pixi 拖进 Node。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DECK_PIECES, DECK_PIECE_SQUARE } from '../data/deckPieces';
import { UPGRADE_SKIP_FEE } from '../data/economy';
import { SUP_AMMO_BAY, SUP_ARMOR_BAY, SUPPORT_KIND_COUNT, SUPPORTS } from '../data/supports';
import { TOWER_AUTOCANNON, TOWER_KIND_COUNT, TOWER_MAX_LEVEL, TOWERS, towerRange } from '../data/towers';
import {
  CELL_SUPPORT,
  CELL_WEAPON,
  cellIndexAtLocal,
  cellLocalPos,
  createDeck,
  type Deck,
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
  WELD_DETACHED,
  WELD_OK,
  WELD_OVERLAP,
} from '../sim/deck';
import type { Vec2 } from '../sim/ship';
import { OFFER_DECK, OFFER_SUPPORT, OFFER_TOWER, optionLabel, UPGRADE_NO_OFFER, type UpgradeOption } from '../sim/upgrade';
import type { World } from '../sim/world';
import {
  cardDesc,
  cardIcon,
  cardLevelText,
  cardTitle,
  createUpgradeFlow,
  denyMessage,
  placeLabel,
  placedMessage,
  skipRefund,
} from './upgradeFlow';

/** 塔候选。level = 甲板上该型塔的最高等级(0 = 尚未拥有),与 sim/upgrade 的口径一致 */
function towerOpt(type: number, level = 0): UpgradeOption {
  return { kind: OFFER_TOWER, type, level };
}
/** 设施候选:等级恒 0(设施不叠级) */
function supportOpt(type: number): UpgradeOption {
  return { kind: OFFER_SUPPORT, type, level: 0 };
}
function deckOpt(type: number): UpgradeOption {
  return { kind: OFFER_DECK, type, level: 0 };
}

const DENY_CODES = [
  PLACE_NO_CELL,
  PLACE_TAKEN,
  PLACE_INTERIOR,
  PLACE_BAD_CONTENT,
  PLACE_MAX_LEVEL,
  PLACE_BAD_TOWER,
  PLACE_BAD_SUPPORT,
  WELD_OVERLAP,
  WELD_DETACHED,
  UPGRADE_NO_OFFER,
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

  it('卡片过期那一档不提甲板:它不是撞上了哪条放置规则', () => {
    // 提了格子只会让玩家去找一个根本不存在的问题 —— 待选没了是流程的事,不是这一格的事
    const msg = denyMessage(UPGRADE_NO_OFFER);
    expect(msg).not.toContain('格');
    expect(msg).toContain('升级');
  });

  it('未知码回落成带码的兜底文案,而不是空串', () => {
    // PLACE_OK / PLACE_UPGRADE 走不到 denyMessage(调用方只在非成功时问),故它们也算"未知码"。
    // **-1 不再是未知码**:10 号 issue 起它是 UPGRADE_NO_OFFER,上面那条已经钉过
    for (const code of [PLACE_OK, PLACE_UPGRADE, 99, -42]) {
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
    // 与塔名同一条口径:名字只在 src/data/supports.ts 存一份,ui 不抄第二份
    const names = SUPPORTS.map((def) => placeLabel(CELL_SUPPORT, TOWER_AUTOCANNON, def.type));
    expect(names).toEqual(SUPPORTS.map((def) => def.name));
    expect(new Set(names).size).toBe(SUPPORT_KIND_COUNT);
  });

  it('两种型号互不相干;越界一律报回原始下标而不是悄悄换成另一种', () => {
    // 支援设施不看塔型、武器塔不看设施型 —— 两个参数各自只在自己那种 content 下有意义
    expect(placeLabel(CELL_SUPPORT, 0)).toBe(placeLabel(CELL_SUPPORT, 99));
    expect(placeLabel(CELL_WEAPON, TOWER_AUTOCANNON, 99)).toBe(placeLabel(CELL_WEAPON, TOWER_AUTOCANNON));
    // 静默兜底成第 0 种 = 提示说的和真放下去的是两码事,这两条就是拦网
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

describe('cardTitle', () => {
  it('标题 = 数值表里的名字(经 optionLabel),塔/设施/拼块均不串台', () => {
    const towers = TOWERS.map((def) => cardTitle(towerOpt(def.type)));
    expect(towers).toEqual(TOWERS.map((def) => def.name));
    const supports = SUPPORTS.map((def) => cardTitle(supportOpt(def.type)));
    expect(supports).toEqual(SUPPORTS.map((def) => def.name));
    const pieces = DECK_PIECES.map((def) => cardTitle(deckOpt(def.type)));
    expect(pieces).toEqual(DECK_PIECES.map((def) => def.name));
    // 塔与设施同名 = 玩家分不出这张卡是一座炮还是一块砖
    expect(new Set([...towers, ...supports]).size).toBe(TOWER_KIND_COUNT + SUPPORT_KIND_COUNT);
  });

  it('一律走 sim 的 optionLabel,ui 不抄第二份名字', () => {
    // 抄一份的下场:数值表改了名字,卡片上还挂着旧的
    for (const def of TOWERS) expect(cardTitle(towerOpt(def.type))).toBe(optionLabel(towerOpt(def.type)));
    for (const def of SUPPORTS) {
      expect(cardTitle(supportOpt(def.type))).toBe(optionLabel(supportOpt(def.type)));
    }
  });
});

describe('cardIcon', () => {
  it('塔/设施/拼块都有明确且互不串台的内建图标', () => {
    const towerIcons = TOWERS.map((def) => cardIcon(towerOpt(def.type)));
    const supportIcons = SUPPORTS.map((def) => cardIcon(supportOpt(def.type)));
    const pieceIcons = DECK_PIECES.map((def) => cardIcon(deckOpt(def.type)));
    const icons = [...towerIcons, ...supportIcons, ...pieceIcons];
    expect(icons.length).toBe(TOWER_KIND_COUNT + SUPPORT_KIND_COUNT + DECK_PIECES.length);
    for (const icon of icons) {
      expect(icon.length).toBeGreaterThan(0);
      expect(icon).not.toBe('?');
      // 图标是随代码交付的字符,不依赖图片 URL / 外部资产能否加载
      expect(icon).not.toContain('http');
      expect(icon).not.toContain('<');
    }
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('未知型号显式报 ?,不冒充数值表第 0 型', () => {
    expect(cardIcon(towerOpt(99))).toBe('?');
    expect(cardIcon(supportOpt(99))).toBe('?');
    expect(cardIcon(deckOpt(99))).toBe('?');
  });
});

describe('cardDesc', () => {
  it('甲板拼块卡报格数、旋转、外边缘与逐格转向代价', () => {
    for (const def of DECK_PIECES) {
      const desc = cardDesc(deckOpt(def.type));
      expect(desc).toContain(String(def.cells.length / 2));
      expect(desc).toContain('旋转');
      expect(desc).toContain('外边缘');
      expect(desc).toContain('°/s');
    }
  });
  it('塔卡报射界 / 射程 / 节流系三样,六座各不相同', () => {
    const descs = TOWERS.map((def) => cardDesc(towerOpt(def.type)));
    for (const d of descs) {
      expect(d).toContain('射界');
      expect(d).toContain('射程');
    }
    // 六座塔的描述撞车 = 三选一时根本比不出该选谁
    expect(new Set(descs).size).toBe(TOWER_KIND_COUNT);
    // 三种节流机制是 GDD §5.1 的分水岭,也是三种支援设施的作用锚点:卡片上必须报出来
    const throttles = ['弹药系', '过热系', '充能系'];
    for (const d of descs) expect(throttles.some((t) => d.includes(t))).toBe(true);
  });

  it('射程按"点下去之后会是几级"报,而不是当前等级', () => {
    const def = TOWERS[TOWER_AUTOCANNON]!;
    // 尚未拥有 → 拿到的是一座 Lv1 新塔
    expect(cardDesc(towerOpt(TOWER_AUTOCANNON, 0))).toContain(String(Math.round(towerRange(def, 1))));
    // 已有 Lv2 → 这张卡承诺的是 Lv3 的射程(报 Lv2 就是在描述玩家已经有的东西)
    expect(cardDesc(towerOpt(TOWER_AUTOCANNON, 2))).toContain(String(Math.round(towerRange(def, 3))));
    // 已满级 → 只能新建,于是回到 Lv1 的读数(GDD §5.4:叠不动了)
    expect(cardDesc(towerOpt(TOWER_AUTOCANNON, TOWER_MAX_LEVEL))).toBe(
      cardDesc(towerOpt(TOWER_AUTOCANNON, 0)),
    );
  });

  it('设施卡把它自己那几项非中性的数念出来,四种各不相同', () => {
    const descs = SUPPORTS.map((def) => cardDesc(supportOpt(def.type)));
    expect(new Set(descs).size).toBe(SUPPORT_KIND_COUNT);
    // 弹药库:两项加成都要念到(只念一半 = 玩家以为它只加射速)
    const ammo = cardDesc(supportOpt(SUP_AMMO_BAY));
    expect(ammo).toContain('射速');
    expect(ammo).toContain('装填');
    expect(ammo).toContain('弹药系');
    // 装甲舱是四种里唯一**不作用于相邻塔**的,故绝不许出现"相邻"两个字 ——
    // 出现了就是在承诺一件它做不到的事(与渲染层不给它画邻接连线是同一条口径)
    const armor = cardDesc(supportOpt(SUP_ARMOR_BAY));
    expect(armor).not.toContain('相邻');
    expect(armor).toContain('船体 HP');
    expect(armor).toContain('所在舷');
  });

  it('描述从数值表现生成:改表里的数,卡片当场跟着变', () => {
    // 这一条就是"改数据文件即可调平衡,不改代码"(todos/05 验收)在 ui 侧的落点。
    // 给数值表加一个手写的 desc 字段的话,这条会立刻变红 —— 那正是它存在的理由
    const def = SUPPORTS[SUP_AMMO_BAY]!;
    const before = def.fireRateMul;
    try {
      def.fireRateMul = 1.75;
      expect(cardDesc(supportOpt(SUP_AMMO_BAY))).toContain('1.75');
      // 调回中性值 = 这一项不再有效果,那半句就该消失
      def.fireRateMul = 1;
      expect(cardDesc(supportOpt(SUP_AMMO_BAY))).not.toContain('射速');
    } finally {
      def.fireRateMul = before;
    }
  });

  it('型号越界不静默兜底成第 0 种,而是把下标印出来', () => {
    // 兜底的下场:玩家照着另一座塔的射程/射界下判断,点下去才发现放的是别的东西
    expect(cardDesc(towerOpt(99))).toContain('99');
    expect(cardDesc(supportOpt(99))).toContain('99');
  });
});

describe('cardLevelText', () => {
  it('拼块明确说明确认即焊死、局内不可拆挪', () => {
    expect(cardLevelText(deckOpt(DECK_PIECE_SQUARE))).toContain('焊死');
    expect(cardLevelText(deckOpt(DECK_PIECE_SQUARE))).toContain('不可');
  });
  it('三档各说各的话:未装备 / 当前 LvN / 满级只能新建', () => {
    expect(cardLevelText(towerOpt(TOWER_AUTOCANNON, 0))).toBe('未装备');
    for (let lv = 1; lv < TOWER_MAX_LEVEL; lv++) {
      expect(cardLevelText(towerOpt(TOWER_AUTOCANNON, lv))).toBe(`当前 Lv${lv}`);
    }
    // 满级这一档必须把"只能新建"讲明白:不讲的话玩家会照着"再点一次那座塔"的直觉去点,
    // 然后吃一记 PLACE_MAX_LEVEL —— 而那时残骸已经花在这张卡上了
    const top = cardLevelText(towerOpt(TOWER_AUTOCANNON, TOWER_MAX_LEVEL));
    expect(top).toContain(`Lv${TOWER_MAX_LEVEL}`);
    expect(top).toContain('满级');
    expect(top).toContain('新建');
  });

  it('支援设施不拿恒 0 的 level 冒充“未装备”,明确说明每次都是新建', () => {
    for (const def of SUPPORTS) {
      const text = cardLevelText(supportOpt(def.type));
      expect(text).toContain('不叠级');
      expect(text).toContain('新建');
      expect(text).not.toContain('未装备');
    }
  });

  it('越界与 NaN 不产出 LvNaN 这种字', () => {
    // 上限之外照满级那一档说话;负数/NaN 一律回落"未装备"(NaN 比较恒 false,故写成 !(lv >= 1))
    expect(cardLevelText(towerOpt(TOWER_AUTOCANNON, TOWER_MAX_LEVEL + 3))).toContain('满级');
    expect(cardLevelText(towerOpt(TOWER_AUTOCANNON, -1))).toBe('未装备');
    expect(cardLevelText(towerOpt(TOWER_AUTOCANNON, Number.NaN))).toBe('未装备');
  });
});

describe('skipRefund', () => {
  it('返还 = cost − 手续费:净亏恒为手续费,不随费用曲线暴涨', () => {
    expect(skipRefund(UPGRADE_SKIP_FEE * 10)).toBe(UPGRADE_SKIP_FEE * 9);
    expect(skipRefund(509)).toBe(509 - UPGRADE_SKIP_FEE);
  });

  it('费用不高于手续费时返还 0,坏输入不印残骸', () => {
    // 与 World.skipUpgrade 调的是同一个 skipRefundFor。分家的后果有两层:
    // 按钮上印的返还数与实际到账各走各的(玩家算不清账),更糟的是跳过会净赚残骸 ——
    // 那样下一帧又满足 scrap ≥ upgradeCost,卡片会一张接一张地弹
    expect(skipRefund(UPGRADE_SKIP_FEE)).toBe(0);
    expect(skipRefund(UPGRADE_SKIP_FEE - 1)).toBe(0);
    expect(skipRefund(0)).toBe(0);
    expect(skipRefund(-5)).toBe(0);
  });
});

// —— 以下只服务两阶段状态机那几条(破例上 DOM 桩的理由见文件头)——

interface StubEvent {
  clientX?: number;
  clientY?: number;
  code?: string;
  repeat?: boolean;
  preventDefault(): void;
}

/** 桩元素:createUpgradeFlow 只碰它的 style 三项 / textContent / append / appendChild / addEventListener */
interface StubEl {
  style: { cssText: string; color: string; display: string };
  textContent: string;
  children: StubEl[];
  handlers: Map<string, Array<(e: StubEvent) => void>>;
  append(...kids: StubEl[]): void;
  appendChild(kid: StubEl): StubEl;
  addEventListener(type: string, fn: (e: StubEvent) => void): void;
}

function createStubEl(): StubEl {
  const el: StubEl = {
    style: { cssText: '', color: '', display: '' },
    textContent: '',
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
  };
  return el;
}

/** 触发桩元素上的一次事件(没挂监听器就什么都不做,与真 DOM 一致) */
function fire(el: StubEl, type: string, e: Partial<StubEvent> = {}): void {
  const ev: StubEvent = { preventDefault: () => {}, ...e };
  for (const fn of el.handlers.get(type) ?? []) fn(ev);
}

interface StubDom {
  /** #ui 覆盖层:面板与提示条 append 到这里,"重开一局多长出一块"于是一眼数得出来 */
  ui: StubEl;
  /** window.addEventListener 的累计调用次数:重开一局不该让它再涨 */
  windowListeners: number;
  /** 还没到点的提示超时。假计时器(不真排队),故测完不会有回调在后面飞 */
  timers: Map<number, () => void>;
  canvas: HTMLCanvasElement;
  /** 画布上的一次左键点击 / 右键(clientX/Y = 画布像素,见下面 getBoundingClientRect) */
  click(x: number, y: number): void;
  rightClick(x: number, y: number): void;
  move(x: number, y: number): void;
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
  const moveHandlers: Array<(e: StubEvent) => void> = [];
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
    rightClick(x: number, y: number): void {
      fire(canvasEl, 'contextmenu', { clientX: x, clientY: y });
    },
    move(x: number, y: number): void {
      const ev: StubEvent = { clientX: x, clientY: y, preventDefault: () => {} };
      for (const fn of moveHandlers) fn(ev);
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
    addEventListener(type: string, fn: (e: StubEvent) => void): void {
      dom.windowListeners++;
      if (type === 'keydown') keyHandlers.push(fn);
      if (type === 'mousemove') moveHandlers.push(fn);
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
  // isTyping 里那句 `el instanceof HTMLElement` 在 Node 里没有这个全局,不补就是一声 ReferenceError。
  // activeElement 桩里压根没有 ⇒ undefined instanceof 恒 false ⇒ isTyping() = false,正是"没在打字"
  g.HTMLElement = class {};
  return dom;
}

/**
 * 桩 World:只提供 createUpgradeFlow 真的会读的那几样(见文件头的取舍)。
 * takeUpgrade / skipUpgrade 的答复由用例现填 —— 本文件钉的是"点了之后调没调、调的是哪一格",
 * 而**它们各自答什么**是 sim 那边的规则。
 */
interface StubWorld {
  deck: Deck;
  offer: UpgradeOption[];
  scrap: number;
  upgradeCost: number;
  /** 每次 takeUpgrade 的入参:[choice, col, row] */
  takeCalls: number[][];
  skipCalls: number;
  /** takeUpgrade 的返回码,由用例现填 */
  takeCode: number;
  turnRate: number;
  skipOk: boolean;
  takeUpgrade(choice: number, col: number, row: number, rotation?: number): number;
  skipUpgrade(): boolean;
}

function createStubWorld(offer: UpgradeOption[]): StubWorld {
  const w: StubWorld = {
    deck: createDeck(),
    offer,
    scrap: 60,
    upgradeCost: 35,
    takeCalls: [],
    skipCalls: 0,
    takeCode: PLACE_OK,
    turnRate: 100,
    skipOk: true,
    takeUpgrade(choice: number, col: number, row: number, rotation?: number): number {
      w.takeCalls.push(rotation === undefined ? [choice, col, row] : [choice, col, row, rotation]);
      return w.takeCode;
    },
    skipUpgrade(): boolean {
      w.skipCalls++;
      return w.skipOk;
    },
  };
  return w;
}

/** 屏幕像素 = 甲板局部坐标:于是用例可以直接拿 cellLocalPos 的格心当"点在这一格上" */
function screenIsDeckLocal(sx: number, sy: number, out: Vec2): Vec2 {
  out.x = sx;
  out.y = sy;
  return out;
}

/** 某一格格心的"屏幕坐标"(配合上面那个恒等换算) */
function cellPoint(deck: Deck, col: number, row: number): Vec2 {
  return cellLocalPos(deck, col, row, { x: 0, y: 0 });
}

// —— 面板的 DOM 结构(见 createUpgradeFlow 里 append 的顺序):
//    #ui = [面板, 提示条];面板 = [标题行, 卡片行, 按钮行];按钮行 = [跳过, 重选] ——
const panelOf = (dom: StubDom): StubEl => dom.ui.children[0]!;
const cardsOf = (dom: StubDom): StubEl => panelOf(dom).children[1]!;
const skipBtnOf = (dom: StubDom): StubEl => panelOf(dom).children[2]!.children[0]!;
const backBtnOf = (dom: StubDom): StubEl => panelOf(dom).children[2]!.children[1]!;
const rotateBtnOf = (dom: StubDom): StubEl => panelOf(dom).children[2]!.children[2]!;
const toastOf = (dom: StubDom): StubEl => dom.ui.children[1]!;

describe('createUpgradeFlow 两阶段状态机', () => {
  let dom: StubDom;
  let world: StubWorld;
  let resolved: number;

  /** 起手:两张卡(一门机炮 + 一块弹药库),面板已弹出、停在选卡阶段 */
  function setup(): ReturnType<typeof createUpgradeFlow> {
    const flow = createUpgradeFlow({
      world: world as unknown as World,
      canvas: dom.canvas,
      screenToDeckLocal: screenIsDeckLocal,
      onResolved: () => {
        resolved++;
      },
    });
    flow.show();
    return flow;
  }

  beforeEach(() => {
    dom = installDom();
    world = createStubWorld([towerOpt(TOWER_AUTOCANNON, 2), supportOpt(SUP_AMMO_BAY)]);
    resolved = 0;
  });
  afterEach(() => {
    dom.restore();
  });

  it('选卡阶段不高亮、点画布不算数', () => {
    const flow = setup();
    // 还没决定放什么,"哪些格合法"这个问题根本没有答案 —— 高亮层此时必须是空的
    expect(flow.active).toBe(false);
    dom.click(0, 0);
    // 一次误点变成一座放错格的塔,而塔放下去不可移动、不可出售(GDD §4.5)
    expect(world.takeCalls.length).toBe(0);
    expect(resolved).toBe(0);
  });

  it('卡片 DOM 同时显示图标 / 名称 / 描述 / 当前等级', () => {
    setup();
    const card = cardsOf(dom).children[0]!;
    expect(card.children.length).toBe(4);
    expect(card.children[0]!.textContent).toBe(cardIcon(world.offer[0]!));
    expect(card.children[1]!.textContent).toBe(cardTitle(world.offer[0]!));
    expect(card.children[2]!.textContent).toBe(cardDesc(world.offer[0]!));
    expect(card.children[3]!.textContent).toBe(cardLevelText(world.offer[0]!));
  });

  it('点一张卡 → 放置阶段:候选原样填进 PlacementUiState', () => {
    const flow = setup();
    fire(cardsOf(dom).children[0]!, 'click');
    expect(flow.active).toBe(true);
    expect(flow.content).toBe(CELL_WEAPON);
    expect(flow.towerType).toBe(TOWER_AUTOCANNON);
    // 第二张是支援设施:换一张卡,三个字段整体跟着换(渲染层的合法格高亮读的就是它们)
    fire(backBtnOf(dom), 'click');
    fire(cardsOf(dom).children[1]!, 'click');
    expect(flow.content).toBe(CELL_SUPPORT);
    expect(flow.supportType).toBe(SUP_AMMO_BAY);
  });

  it('点合法格 → 按卡片下标结算一次,面板收起、战斗恢复', () => {
    const flow = setup();
    fire(cardsOf(dom).children[1]!, 'click'); // 选第二张
    world.takeCode = PLACE_OK;
    const p = cellPoint(world.deck, 0, 1);
    dom.click(p.x, p.y);
    // 下标必须是卡片的位置:错一位就是"选了弹药库,放下去一门炮"
    expect(world.takeCalls).toEqual([[1, 0, 1]]);
    expect(resolved).toBe(1);
    expect(flow.active).toBe(false);
    expect(panelOf(dom).style.display).toBe('none');
  });

  it('拼块卡进入焊接模式:可在甲板外拾取稳定逻辑格，R/按钮旋转后原样交给 World', () => {
    world = createStubWorld([deckOpt(DECK_PIECE_SQUARE)]);
    const flow = setup();
    fire(cardsOf(dom).children[0]!, 'click');
    expect(flow.weldPieceType).toBe(DECK_PIECE_SQUARE);
    expect(flow.weldRotation).toBe(0);
    expect(rotateBtnOf(dom).style.display).toBe('block');

    dom.key('KeyR');
    expect(flow.weldRotation).toBe(1);
    fire(rotateBtnOf(dom), 'click');
    expect(flow.weldRotation).toBe(2);

    world.takeCode = WELD_OK;
    world.turnRate = 96;
    const p = cellPoint(world.deck, -2, 1);
    dom.click(p.x, p.y);
    expect(world.takeCalls).toEqual([[0, -2, 1, 2]]);
    expect(resolved).toBe(1);
    expect(toastOf(dom).textContent).toContain('96');
  });

  it('拼块悬空/重叠被拒时保持时停与焊接态，并让 ghost 红闪', () => {
    world = createStubWorld([deckOpt(DECK_PIECE_SQUARE)]);
    const flow = setup();
    fire(cardsOf(dom).children[0]!, 'click');
    world.takeCode = WELD_OVERLAP;
    dom.click(0, 0);
    expect(resolved).toBe(0);
    expect(flow.active).toBe(true);
    expect(flow.weldDenied).toBe(true);
    expect(toastOf(dom).textContent).toBe(denyMessage(WELD_OVERLAP));

    // 红闪只属于刚拒绝的锚点；移到另一格后应重新展示该格的实时合法性。
    const next = cellPoint(world.deck, -2, 1);
    dom.move(next.x, next.y);
    expect(flow.weldDenied).toBe(false);
  });

  it('叠级的回执留在屏幕上,不随面板一起消失', () => {
    // 同名叠级不占新格(GDD §5.4):恢复战斗后画面上什么都没多出来,
    // 这行字是玩家唯一能确认"刚才那一下落成了什么"的东西
    setup();
    fire(cardsOf(dom).children[0]!, 'click');
    world.takeCode = PLACE_UPGRADE;
    const p = cellPoint(world.deck, 0, 1);
    dom.click(p.x, p.y);
    expect(toastOf(dom).textContent).toContain('Lv');
    expect(toastOf(dom).style.display).toBe('block');
  });

  it('非法格:闪红说人话,一分钱不扣、一帧不恢复', () => {
    // 验收标准原文:非法格不可确认放置。这里 sim 答的是"内部格只能放支援设施"
    const flow = setup();
    fire(cardsOf(dom).children[0]!, 'click');
    world.takeCode = PLACE_INTERIOR;
    const p = cellPoint(world.deck, 1, 1);
    dom.click(p.x, p.y);
    expect(resolved).toBe(0);
    // 还站在放置阶段里:可以换一格,也可以退回去换一张卡
    expect(flow.active).toBe(true);
    expect(panelOf(dom).style.display).toBe('flex');
    expect(toastOf(dom).textContent).toBe(denyMessage(PLACE_INTERIOR));
    // 被拒的那一格要闪:光有文案的话,玩家不知道自己点的是哪一格
    expect(flow.denyIndex).toBeGreaterThanOrEqual(0);
  });

  it('点在甲板之外:连 sim 都不惊动', () => {
    const flow = setup();
    fire(cardsOf(dom).children[0]!, 'click');
    dom.click(1e5, 1e5);
    expect(world.takeCalls.length).toBe(0);
    expect(resolved).toBe(0);
    // 没有格子可闪,反馈只剩这行文案
    expect(flow.denyIndex).toBe(-1);
    expect(toastOf(dom).textContent).toBe(denyMessage(PLACE_NO_CELL));
  });

  it('Esc / 右键 / 重选:退回选卡,不扣费也不恢复战斗', () => {
    const flow = setup();
    for (const cancel of [
      () => dom.key('Escape'),
      () => dom.rightClick(0, 0),
      () => fire(backBtnOf(dom), 'click'),
    ]) {
      fire(cardsOf(dom).children[0]!, 'click');
      expect(flow.active).toBe(true);
      cancel();
      // 退回选卡:高亮熄掉、面板还开着(时停要一直停到这一次升级真的结算掉为止)
      expect(flow.active).toBe(false);
      expect(panelOf(dom).style.display).toBe('flex');
      expect(world.takeCalls.length).toBe(0);
      expect(resolved).toBe(0);
      // 取消之后点画布不该再落成一次放置(否则"重选"就成了一条隐形的确认键)
      dom.click(0, 0);
      expect(world.takeCalls.length).toBe(0);
    }
  });

  it('跳过:走 World 的 skipUpgrade 并结算,按钮上的返还额不虚报', () => {
    setup();
    // 第 0 级的费用可能比返还额还低,按钮得照实说(与 World.skipUpgrade 的夹取同源)
    expect(skipBtnOf(dom).textContent).toContain(String(skipRefund(world.upgradeCost)));
    fire(skipBtnOf(dom), 'click');
    expect(world.skipCalls).toBe(1);
    expect(world.takeCalls.length).toBe(0);
    expect(resolved).toBe(1);
    expect(panelOf(dom).style.display).toBe('none');
  });

  it('弹一张空卡不会把玩家永久卡在时停里', () => {
    // World 只在真的生成了候选时才响 onUpgradeOffer,故这是一道拦网:
    // 空面板 + 时停 = 一局到此为止,而且看上去像"游戏卡死了"
    world.offer.length = 0;
    setup();
    expect(resolved).toBe(1);
    expect(panelOf(dom).style.display).toBe('none');
  });

  it('弹第二次卡复用同一批 DOM,不越堆越多', () => {
    const flow = setup();
    const cardCount = cardsOf(dom).children.length;
    expect(cardCount).toBe(world.offer.length);
    flow.hide();
    flow.show();
    expect(cardsOf(dom).children.length).toBe(cardCount);
    expect(dom.ui.children.length).toBe(2);
  });

  it('setWorld:换掉引用,重开后的确认落在新船上', () => {
    const flow = setup();
    fire(cardsOf(dom).children[0]!, 'click');
    const next = createStubWorld([towerOpt(TOWER_AUTOCANNON, 0)]);
    flow.setWorld(next as unknown as World);
    // 上一局的卡片与下标一律作废:留着就会拿新世界的 offer 去兑上一局的选择
    expect(flow.active).toBe(false);
    expect(panelOf(dom).style.display).toBe('none');
    // **不替 main 恢复战斗**:重开流程自己会复位 run.paused 与甲板缩放
    expect(resolved).toBe(0);

    flow.show();
    fire(cardsOf(dom).children[0]!, 'click');
    const p = cellPoint(next.deck, 0, 1);
    dom.click(p.x, p.y);
    // 忘了换引用的话,这一下会照旧落进上一局那艘沉船里,而画面上什么都不会发生
    expect(next.takeCalls.length).toBe(1);
    expect(world.takeCalls.length).toBe(0);
  });

  it('setWorld 不重复注册 window 事件、不重复 append DOM,并抹掉上一局的提示', () => {
    const flow = setup();
    const listeners = dom.windowListeners;
    // 建的时候确实挂了监听器、也确实 append 了面板与提示条 —— 否则下面两条"没变"是废话
    expect(listeners).toBeGreaterThan(0);
    expect(dom.ui.children.length).toBe(2);
    // 先制造一条还没到点的提示(上一局的话)
    fire(cardsOf(dom).children[0]!, 'click');
    dom.click(1e5, 1e5);
    expect(dom.timers.size).toBe(1);

    flow.setWorld(createStubWorld([]) as unknown as World);
    flow.setWorld(createStubWorld([]) as unknown as World);
    // 每重开一局多一份监听器 = 一次点击结算好几次;多一块面板 = 屏幕上越堆越高
    expect(dom.windowListeners).toBe(listeners);
    expect(dom.ui.children.length).toBe(2);
    // 计时器也得停:留着的话它会在新局里回来抹一次 denyIndex —— 抹的是别人的状态
    expect(dom.timers.size).toBe(0);
    expect(toastOf(dom).textContent).toBe('');
  });

  it('syncHover 只在放置阶段重算悬停格', () => {
    // 时停期间船不动,但甲板放大有一段缓动(见 renderer.setDeckZoom):只在 mousemove 里算的话,
    // 缓动那零点几秒里"看到的框"与"点下去的格"不是同一个 —— 而塔一放就不可移动、不可出售
    const flow = setup();
    // 选卡阶段:高亮层是空的,悬停格不该被算出来(算了就会在没选卡时描一个框)
    flow.hoverIndex = 999;
    flow.syncHover();
    expect(flow.hoverIndex).toBe(999);

    fire(cardsOf(dom).children[0]!, 'click');
    flow.hoverIndex = 999;
    flow.syncHover();
    // 进了放置阶段就每帧现算(桩里鼠标停在 (0,0) = 船正中那一格),而不是冻在上一次的下标上
    expect(flow.hoverIndex).toBe(cellIndexAtLocal(world.deck, 0, 0));
  });
});
