/**
 * 图鉴页(ui/codex.ts)。主体测的是那几个**纯函数** —— 图鉴上到底印了什么:
 * 锁定判定、效果摘要、合成武器底座名、解锁条件文案,哪一条错都只是几行字符串拼接,
 * 却要等真人进一次图鉴才看得见(与 gameOver.test 测 summaryText 同一条理由)。
 *
 * 文件末尾破一次例去测 createCodexUi 本身(照 gameOver.test 的先例):
 * 只建一次 / show 整块重排 / Esc 关页回 onClose / 收着时 Esc 不认,四条各错一次的后果
 * (多一份监听器、目录叠两遍、Esc 一按关好几层)都要真人反复开关图鉴才看得出来。
 * 桩只提供 createCodexUi 真的会碰的那几样(createElement/getElementById/append +
 * window.addEventListener + HTMLElement),绝不发展成半个 jsdom —— 本仓 vitest 跑在
 * Node 环境里,不装 jsdom。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BOSS, ENEMIES } from '../data/enemies';
import { EDICT_AMMO, EDICT_GYRO, EDICT_OVERDRIVE, EDICT_STARCHART, EDICTS } from '../data/edicts';
import { TOWERS, TOWER_MISSILE_NEST } from '../data/towers';
import {
  COND_ELITE_KILLS,
  COND_FIRST_WIN,
  COND_KILLS,
  COND_NONE,
  UNLOCKS,
  type UnlockEntry,
} from '../data/unlocks';
import { createProgress, type Progress } from '../sim/progress';
import {
  behaviorName,
  codexRows,
  codexStatsText,
  codexUnlockStats,
  createCodexUi,
  edictSummaryText,
  formatMul,
  unlockConditionText,
} from './codex';

/** 全解锁掩码:位 0..UNLOCKS.length-1 全置 1(与 sim/progress.ts 的 FULL_MASK 同编码) */
const FULL_MASK = (1 << UNLOCKS.length) - 1;

function progress(mask: number, over: Partial<Progress> = {}): Progress {
  return { ...createProgress(), unlockMask: mask, ...over };
}

describe('unlockConditionText', () => {
  it('四种条件各有文案;COND_NONE 印无条件(将来新增条件漏配也能读出一句)', () => {
    const cases: Array<[number, string]> = [
      [COND_FIRST_WIN, '首次胜利'],
      [COND_KILLS, '单局击杀 300'],
      [COND_ELITE_KILLS, '累计精英击杀 14'],
      [COND_NONE, '无条件'],
    ];
    for (const [kind, text] of cases) {
      const entry: UnlockEntry = {
        id: 'x',
        name: 'x',
        kind: 0,
        type: 0,
        condition: { kind, target: kind === COND_KILLS ? 300 : kind === COND_ELITE_KILLS ? 14 : 0 },
      };
      expect(unlockConditionText(entry)).toBe(text);
    }
  });
});

describe('behaviorName', () => {
  it('五种行为各有一行短标签(文案与 enemies.ts 常量注释的短截一致)', () => {
    expect(behaviorName(0)).toBe('直线追船');
    expect(behaviorName(1)).toBe('侧向驻留');
    expect(behaviorName(2)).toBe('侧向冲锋');
    expect(behaviorName(3)).toBe('直线冲锋');
    expect(behaviorName(4)).toBe('远程喷吐');
  });

  it('未知行为码印出码本身,不静默兜底(与 resultTitle 的未知码同一口径)', () => {
    expect(behaviorName(99)).toBe('行为 99');
  });
});

describe('formatMul / edictSummaryText', () => {
  it('倍率印法:两位小数内舍入、尾零省掉', () => {
    expect(formatMul(1.25)).toBe('1.25');
    expect(formatMul(1.5)).toBe('1.5');
    expect(formatMul(0.7)).toBe('0.7');
  });

  it('系限定法令:前缀作用系,摘要只印非中性字段', () => {
    expect(edictSummaryText(EDICTS[EDICT_AMMO]!)).toBe('弹药系:射速 ×1.25 · 装填 ×0.7');
  });

  it('全船档:前缀「全船」;加法档印点数、概率档换算百分点', () => {
    expect(edictSummaryText(EDICTS[EDICT_OVERDRIVE]!)).toBe('全船:伤害 ×1.15');
    expect(edictSummaryText(EDICTS[EDICT_GYRO]!)).toBe('全船:转向 +10°/s');
    expect(edictSummaryText(EDICTS[EDICT_STARCHART]!)).toBe('全船:星币 +2%');
  });

  it('全中性字段(被改坏的条目)回落成破折号,不印空串', () => {
    const neutral = { ...EDICTS[EDICT_AMMO]!, fireRateMul: 1, reloadMul: 1 };
    expect(edictSummaryText(neutral)).toBe('弹药系:—');
  });
});

describe('codexStatsText / codexUnlockStats', () => {
  it('统计行:三个累计计数器', () => {
    expect(codexStatsText(progress(0, { wins: 3, kills: 1280, eliteKills: 9 }))).toBe(
      '胜场 3 · 总击杀 1280 · 精英击杀 9',
    );
  });

  it('内容解锁计数剔掉船形收藏(无条件,不占分子分母):空进度 0/5,全解锁 5/5', () => {
    expect(codexUnlockStats(progress(0))).toEqual({ unlocked: 0, total: 5 });
    expect(codexUnlockStats(progress(FULL_MASK))).toEqual({ unlocked: 5, total: 5 });
  });
});

describe('codexRows', () => {
  it('分区顺序:武器 → 敌人 → 法令 → 起手配置', () => {
    const titles = codexRows(progress(0)).map((s) => s.title);
    expect(titles).toEqual(['武器', '敌人', '法令', '起手配置']);
  });

  it('武器全量 13 型:基础塔印射程/伤害/系别,迫击炮类印落点伤害(直击伤害恒 0)', () => {
    const weapons = codexRows(progress(0))[0]!.rows;
    expect(weapons.length).toBe(TOWERS.length);
    const auto = weapons.find((r) => r.name === '自动机炮')!;
    expect(auto.locked).toBe(false);
    expect(auto.detail).toBe('射程 380 · 伤害 6 · 弹药系');
    const mortar = weapons.find((r) => r.name === '等离子迫击炮')!;
    expect(mortar.detail).toContain('落点伤害 20');
    expect(mortar.detail).not.toContain('伤害 0');
  });

  it('合成武器经 MERGES 反查底座名(数据表改名图鉴跟着走)', () => {
    const weapons = codexRows(progress(0))[0]!.rows;
    const aurora = weapons.find((r) => r.name === '极光阵列')!;
    expect(aurora.detail).toBe('激光棱镜合3★ · 过热系');
  });

  it('导弹巢:未解锁灰显 + 条件文案,解锁后印回数值行', () => {
    const locked = codexRows(progress(0))[0]!.rows.find(
      (r) => r.name === TOWERS[TOWER_MISSILE_NEST]!.name,
    )!;
    expect(locked.locked).toBe(true);
    expect(locked.detail).toBe('首次胜利');
    const unlocked = codexRows(progress(FULL_MASK))[0]!.rows.find(
      (r) => r.name === TOWERS[TOWER_MISSILE_NEST]!.name,
    )!;
    expect(unlocked.locked).toBe(false);
    expect(unlocked.detail).toContain('射程 460');
  });

  it('敌人:六型 + Boss + 精英事件;Boss 数值按底座 × 倍率现算', () => {
    const enemies = codexRows(progress(0))[1]!.rows;
    expect(enemies.length).toBe(ENEMIES.length + 1 + 1);
    const larva = enemies.find((r) => r.name === '蜂群蛭')!;
    expect(larva.detail).toBe('HP 8 · 接触 5 · 直线追船');
    const beetle = ENEMIES[BOSS.baseKind]!;
    const boss = enemies.find((r) => r.name === BOSS.name)!;
    expect(boss.detail).toBe(
      `HP ${Math.round(beetle.hp * BOSS.hpMul)} · 接触 ` +
        `${Math.round(beetle.contactDamage * BOSS.contactDamageMul)} · 巨型冲锋 · 召唤蜂群`,
    );
    // 读数锚点(现表:hpMul 52、contactDamageMul 2):40×52=2080、18×2=36
    expect(boss.detail).toContain('HP 2080 · 接触 36');
  });

  it('精英事件条目命名走 collectionItemName(与结算图鉴同源);未解锁带条件', () => {
    const elite = codexRows(progress(0))[1]!.rows.find((r) => r.name.includes('虫群母巢'))!;
    expect(elite.locked).toBe(true);
    expect(elite.name).toContain('精英');
    expect(elite.detail).toBe('累计精英击杀 14');
    const unlocked = codexRows(progress(FULL_MASK))[1]!.rows.find((r) =>
      r.name.includes('虫群母巢'),
    )!;
    expect(unlocked.locked).toBe(false);
    expect(unlocked.detail).toBe('');
  });

  it('法令全量 10 条:超载协议未解锁带条件,其余恒解锁', () => {
    const edicts = codexRows(progress(0))[2]!.rows;
    expect(edicts.length).toBe(EDICTS.length);
    const over = edicts.find((r) => r.name === '超载协议')!;
    expect(over.locked).toBe(true);
    expect(over.detail).toBe('单局击杀 300');
    const ammo = edicts.find((r) => r.name === '弹药协议')!;
    expect(ammo.locked).toBe(false);
    expect(ammo.detail).toBe('弹药系:射速 ×1.25 · 装填 ×0.7');
  });

  it('起手配置:炮击/狙击未解锁带条件,解锁后印回表内描述', () => {
    const loadouts = codexRows(progress(0))[3]!.rows;
    expect(loadouts.length).toBe(4);
    const bombard = loadouts.find((r) => r.name === '炮击开局')!;
    expect(bombard.locked).toBe(true);
    expect(bombard.detail).toBe('累计精英击杀 5');
    const standard = loadouts.find((r) => r.name === '标准起手')!;
    expect(standard.locked).toBe(false);
    expect(standard.detail).toContain('弹药');
    const unlocked = codexRows(progress(FULL_MASK))[3]!.rows.find(
      (r) => r.name === '狙击开局',
    )!;
    expect(unlocked.locked).toBe(false);
    expect(unlocked.detail).toContain('磁轨炮');
  });
});

// —— DOM 接线(照 gameOver.test.ts 的 installDom 桩模式,不装 jsdom)——

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
  /** 造出来的元素按顺序留档:遮罩 = 第一个 div */
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
    // isTyping 读它:null = 焦点不在输入框里,于是 Esc 该被当成"关图鉴"
    activeElement: null,
  };
  // Node 里没有 HTMLElement,而 isTyping 拿它做 instanceof —— 不给就直接 ReferenceError
  g.HTMLElement = class HTMLElement {};
  return dom;
}

/** 遮罩 = #ui 的唯一子节点 */
function root(dom: StubDom): StubEl {
  return dom.ui.children[0]!;
}

/** 深度查找:按谓词扫子树,返回第一个命中(目录行都是 leaf,textContent 可精确匹配) */
function findEl(rootEl: StubEl, pred: (el: StubEl) => boolean): StubEl | undefined {
  if (pred(rootEl)) return rootEl;
  for (const kid of rootEl.children) {
    const hit = findEl(kid, pred);
    if (hit) return hit;
  }
  return undefined;
}

describe('createCodexUi', () => {
  let dom: StubDom;
  let closes: number;

  beforeEach(() => {
    dom = installDom();
    closes = 0;
  });
  afterEach(() => {
    dom.restore();
  });

  function make(): ReturnType<typeof createCodexUi> {
    return createCodexUi({
      getProgress: () => progress(0, { wins: 1, kills: 100, eliteKills: 2 }),
      onClose: () => {
        closes++;
      },
    });
  }

  it('默认收着;show 弹出、hide 收回', () => {
    const ui = make();
    // 默认 none 落在构造时的 cssText 里(桩不解析 cssText,照 gameOver.test 同款断言)
    expect(root(dom).style.cssText).toContain('display:none');
    ui.show();
    expect(root(dom).style.display).toBe('flex');
    ui.hide();
    expect(root(dom).style.display).toBe('none');
  });

  it('show 整块重排:标题带计数、锁定项灰显 + 条件、解锁项带数值', () => {
    const ui = make();
    ui.show();
    const title = findEl(root(dom), (el) => el.textContent.startsWith('图鉴 ·'))!;
    expect(title.textContent).toBe('图鉴 · 内容解锁 0/5');
    const stats = findEl(root(dom), (el) => el.textContent.startsWith('胜场'))!;
    expect(stats.textContent).toBe('胜场 1 · 总击杀 100 · 精英击杀 2');
    // 锁定项:导弹巢(未解锁 · 首次胜利),灰显样式落在 opacity 上
    const locked = findEl(root(dom), (el) => el.textContent.includes('导弹巢(未解锁 · 首次胜利)'))!;
    expect(locked.style.cssText).toContain('opacity:.45');
    // 解锁项:名称 + 数值详情
    expect(findEl(root(dom), (el) => el.textContent.includes('自动机炮  射程 380'))).toBeDefined();
    // 分区标题
    expect(findEl(root(dom), (el) => el.textContent === '武器')).toBeDefined();
    expect(findEl(root(dom), (el) => el.textContent === '船形剪影')).toBeDefined();
    // 无剪影给占位,不空着这一栏
    expect(findEl(root(dom), (el) => el.textContent.includes('暂无收藏剪影'))).toBeDefined();
  });

  it('剪影:progress.silhouettes 全量摆成 img,空时不摆 img', () => {
    const ui = createCodexUi({
      getProgress: () => progress(0, { silhouettes: ['data:a', 'data:b'] }),
      onClose: () => {},
    });
    ui.show();
    const imgs = dom.created.filter((el) => el.tagName === 'IMG');
    expect(imgs.length).toBe(2);
    expect(imgs[0]!.src).toBe('data:a');
    expect(imgs[1]!.src).toBe('data:b');
  });

  it('Esc 关页走 onClose;收着时 Esc 不认;按钮同一条路', () => {
    const ui = make();
    ui.show();
    dom.key(keyEvent('Escape'));
    expect(closes).toBe(1);
    expect(root(dom).style.display).toBe('none');
    dom.key(keyEvent('Escape'));
    expect(closes).toBe(1); // 收着时不再响应
    ui.show();
    const back = dom.created.find(
      (el) => el.tagName === 'BUTTON' && el.textContent === '返回(Esc)',
    )!;
    back.listeners.get('click')?.({});
    expect(closes).toBe(2);
  });

  it('show/hide 多少回都不多挂监听器、不多长遮罩(整页只建一次)', () => {
    const ui = make();
    for (let i = 0; i < 3; i++) {
      ui.show();
      ui.hide();
    }
    expect(dom.windowListeners).toBe(1);
    expect(dom.ui.children.length).toBe(1);
  });
});
