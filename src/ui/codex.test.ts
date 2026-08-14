/**
 * 图鉴页(ui/codex.ts)。主体测的是那几个**纯函数** —— 图鉴上到底显示了什么:
 * 锁定判定、悬停行(尤其 **1★/2★/3★ 星级三档读数**)、合成武器血统、每行配了哪张图,
 * 哪一条错都只是几行字符串拼接,却要等真人进一次图鉴才看得见(与 gameOver.test 测
 * summaryText 同一条理由)。
 *
 * 文件末尾破一次例去测 createCodexUi 本身(照 gameOver.test 的先例):
 * 只建一次 / show 整块重排 / 过滤器切档 / 悬停 tooltip / Esc 关页回 onClose / 收着时
 * Esc 不认,六条各错一次的后果(多一份监听器、网格叠两遍、切档没反应、悬停没数值)
 * 都要真人反复开关图鉴才看得出来。桩只提供 createCodexUi 真的会碰的那几样
 * (createElement/getElementById/append + window.addEventListener + getBoundingClientRect +
 *  HTMLElement),绝不发展成半个 jsdom —— 本仓 vitest 跑在 Node 环境里,不装 jsdom。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AFFIXES } from '../data/affixes';
import { BOSS, ENEMIES, KIND_BEETLE } from '../data/enemies';
import { EDICT_AMMO, EDICT_GYRO, EDICT_OVERDRIVE, EDICT_STARCHART, EDICTS } from '../data/edicts';
import {
  THR_CHARGE,
  towerAoeDamage,
  towerChargeTime,
  towerDamage,
  towerFireInterval,
  towerRange,
  TOWERS,
  TOWER_LASER,
  TOWER_MISSILE_NEST,
  TOWER_MORTAR,
} from '../data/towers';
import {
  COND_ELITE_KILLS,
  COND_FIRST_WIN,
  COND_KILLS,
  UNLOCKS,
  type UnlockEntry,
} from '../data/unlocks';
import { BOSS_ART_URL, ENEMY_ART_URLS, TOWER_ART_URLS } from '../render/artUrls';
import { createProgress, type Progress } from '../sim/progress';
import {
  behaviorName,
  codexRows,
  codexStatsText,
  codexUnlockStats,
  createCodexUi,
  edictSummaryText,
  formatMul,
  glyphBadgeSvg,
  tintHex,
  unlockConditionText,
  type CodexArt,
} from './codex';

/** 全解锁掩码:位 0..UNLOCKS.length-1 全置 1(与 sim/progress.ts 的 FULL_MASK 同编码) */
const FULL_MASK = (1 << UNLOCKS.length) - 1;

function progress(mask: number, over: Partial<Progress> = {}): Progress {
  return { ...createProgress(), unlockMask: mask, ...over };
}

/** svg 配图的内容串;非 svg 配图给空串(断言只关心 svg 那类) */
function svgOf(art: CodexArt | null): string {
  return art !== null && art.kind === 'svg' ? art.svg : '';
}

/** 星级读数的期望串:与 codex 的 starLine 同一组 getter 现算 —— 两边对不上 = 有一边口径错了 */
function starExpected(def: typeof TOWERS[number], stars: number, mortar: boolean): string {
  // 期望串用与实现同源的 getter 算(数值表改档时两边一起走,断言不用回头改)
  const dmg = mortar ? towerAoeDamage(def, stars) : towerDamage(def, stars);
  const range = Math.round(towerRange(def, stars));
  if (def.throttle === THR_CHARGE) {
    return (
      `${'★'.repeat(stars)} ${mortar ? '落点伤害' : '伤害'} ${formatMul(dmg)} · 射程 ${range} · ` +
      `充能 ${formatMul(towerChargeTime(def, stars))}s`
    );
  }
  const interval = towerFireInterval(def, stars);
  return (
    `${'★'.repeat(stars)} ${mortar ? '落点伤害' : '伤害'} ${formatMul(dmg)} · 射程 ${range} · ` +
    `射速 ${formatMul(1 / interval)}/s`
  );
}

describe('unlockConditionText', () => {
  it('三种条件各有文案(将来新增条件漏配也能读出一句)', () => {
    const cases: Array<[number, string]> = [
      [COND_FIRST_WIN, '首次胜利'],
      [COND_KILLS, '单局击杀 300'],
      [COND_ELITE_KILLS, '累计精英击杀 14'],
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
  it('数值印法:两位小数内舍入、尾零省掉', () => {
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

describe('tintHex / glyphBadgeSvg', () => {
  it('数字 tint → #rrggbb,高位丢 0 也补到六位', () => {
    expect(tintHex(0x9adcff)).toBe('#9adcff');
    expect(tintHex(0x2b4a6e)).toBe('#2b4a6e');
    expect(tintHex(0x0000ff)).toBe('#0000ff');
  });

  it('徽章带字形与 tint(暗底圆盘 + 虚环 + 中心字),与升级卡片同一套字形身份', () => {
    const svg = glyphBadgeSvg('▦', '#123456');
    expect(svg).toContain('<svg');
    expect(svg).toContain('▦');
    expect(svg).toContain('#123456');
  });
});

describe('codexStatsText / codexUnlockStats', () => {
  it('统计行:三个累计计数器', () => {
    expect(codexStatsText(progress(0, { wins: 3, kills: 1280, eliteKills: 9 }))).toBe(
      '胜场 3 · 总击杀 1280 · 精英击杀 9',
    );
  });

  it('内容解锁计数:空进度 0/3,全解锁 3/3', () => {
    expect(codexUnlockStats(progress(0))).toEqual({ unlocked: 0, total: 3 });
    expect(codexUnlockStats(progress(FULL_MASK))).toEqual({ unlocked: 3, total: 3 });
  });
});

describe('codexRows', () => {
  it('分区顺序与过滤器键:武器 → 敌人 → 法令', () => {
    const sections = codexRows(progress(0));
    expect(sections.map((s) => s.title)).toEqual(['武器', '敌人', '法令']);
    expect(sections.map((s) => s.key)).toEqual(['weapons', 'enemies', 'edicts']);
  });

  it('武器全量 13 型:悬停三档星级读数全印(2★/3★ 伤害不再缺席),配图与渲染层同源', () => {
    const weapons = codexRows(progress(0))[0]!.rows;
    expect(weapons.length).toBe(TOWERS.length);
    const auto = weapons.find((r) => r.name === '自动机炮')!;
    expect(auto.locked).toBe(false);
    expect(auto.art).toEqual({ kind: 'img', urls: [TOWER_ART_URLS[0]] });
    const def = TOWERS[0]!;
    expect(auto.hover[0]).toBe('自动机炮 · 弹药系');
    expect(auto.hover[1]).toBe(starExpected(def, 1, false));
    expect(auto.hover[2]).toBe(starExpected(def, 2, false));
    expect(auto.hover[3]).toBe(starExpected(def, 3, false));
    // 成长曲线确实在涨:★★/★★★ 的伤害与 ★ 不同(这正是旧版图鉴漏印的两行)
    expect(auto.hover[2]).not.toContain(`★★ 伤害 ${formatMul(def.damage)}`);
  });

  it('迫击炮类:落点伤害 + 充能节奏(直击伤害恒 0,不印误导性的 0)', () => {
    const mortar = codexRows(progress(0))[0]!.rows.find(
      (r) => r.name === TOWERS[TOWER_MORTAR]!.name,
    )!;
    expect(mortar.hover[1]).toBe(starExpected(TOWERS[TOWER_MORTAR]!, 1, true));
    expect(mortar.hover[1]).toContain('落点伤害');
    expect(mortar.hover[1]).toContain('充能');
    expect(mortar.hover[1]).not.toContain('伤害 0');
  });

  it('合成武器经 MERGES 反查底座名与底座贴图(数据表改名图鉴跟着走)', () => {
    const weapons = codexRows(progress(0))[0]!.rows;
    const aurora = weapons.find((r) => r.name === '极光阵列')!;
    expect(aurora.hover[0]).toBe('极光阵列 · 由激光棱镜合★★★变身 · 过热系');
    // 合成塔没有独立贴图,配图回退底座塔的图 —— 与悬停里的"底座合★★★"两相印证
    expect(aurora.art).toEqual({ kind: 'img', urls: [TOWER_ART_URLS[TOWER_LASER]] });
  });

  it('导弹巢:未解锁悬停末条带条件,解锁后只印数值;无贴图走字形徽章', () => {
    const locked = codexRows(progress(0))[0]!.rows.find(
      (r) => r.name === TOWERS[TOWER_MISSILE_NEST]!.name,
    )!;
    expect(locked.locked).toBe(true);
    expect(locked.hover[locked.hover.length - 1]).toBe('未解锁 · 首次胜利');
    // 徽章 = 升级卡片同一套字形(♁)+ 数值表 tint
    expect(locked.art?.kind).toBe('svg');
    expect(svgOf(locked.art)).toContain('♁');
    expect(svgOf(locked.art)).toContain(tintHex(TOWERS[TOWER_MISSILE_NEST]!.tint));
    const unlocked = codexRows(progress(FULL_MASK))[0]!.rows.find(
      (r) => r.name === TOWERS[TOWER_MISSILE_NEST]!.name,
    )!;
    expect(unlocked.locked).toBe(false);
    expect(unlocked.hover.some((l) => l.includes('未解锁'))).toBe(false);
  });

  it('敌人:六型 + Boss + 精英事件;悬停报身板与掉落,配图各取各的贴图', () => {
    const enemies = codexRows(progress(0))[1]!.rows;
    expect(enemies.length).toBe(ENEMIES.length + 1 + 1);
    const larvaDef = ENEMIES[0]!;
    const larva = enemies.find((r) => r.name === larvaDef.name)!;
    expect(larva.hover).toEqual([
      `${larvaDef.name} · 直线追船`,
      `HP ${larvaDef.hp} · 接触 ${larvaDef.contactDamage}`,
      `残骸 ${larvaDef.scrap} · 星币 ${larvaDef.starCoins}`,
    ]);
    expect(larva.art).toEqual({ kind: 'img', urls: [ENEMY_ART_URLS[0]] });
    const beetle = ENEMIES[BOSS.baseKind]!;
    const boss = enemies.find((r) => r.name === BOSS.name)!;
    expect(boss.hover).toEqual([
      `${BOSS.name} · 巨型冲锋 · 召唤蜂群`,
      `HP ${Math.round(beetle.hp * BOSS.hpMul)} · 接触 ` +
        `${Math.round(beetle.contactDamage * BOSS.contactDamageMul)}`,
      `星币 ${BOSS.starCoins} · 体型 ×${BOSS.scale}`,
    ]);
    // 读数锚点:按现表 hpMul × 底座 HP 现算(重锚 hpMul 后跟着走,不钉平衡值)
    expect(boss.hover[1]).toContain(
      `HP ${Math.round(beetle.hp * BOSS.hpMul)} · 接触 ` +
        `${Math.round(beetle.contactDamage * BOSS.contactDamageMul)}`,
    );
    expect(boss.art).toEqual({ kind: 'img', urls: [BOSS_ART_URL] });
  });

  it('精英事件条目命名走 collectionItemName(与结算图鉴同源);悬停报词缀名单', () => {
    const elite = codexRows(progress(0))[1]!.rows.find((r) => r.name.includes('虫群母巢'))!;
    expect(elite.locked).toBe(true);
    expect(elite.name).toContain('精英');
    expect(elite.hover[elite.hover.length - 1]).toBe('未解锁 · 累计精英击杀 14');
    // 词缀名单读数据表(现表:[0,3,4] = 狂热光环/装甲/相位)
    const affixes = elite.hover.find((l) => l.startsWith('词缀'))!;
    expect(affixes).toContain(AFFIXES[0]!.name);
    expect(affixes).toContain(AFFIXES[3]!.name);
    expect(affixes).toContain(AFFIXES[4]!.name);
    // 精英 = 带词缀的底座(冲撞甲虫),图同一张
    expect(elite.art).toEqual({ kind: 'img', urls: [ENEMY_ART_URLS[KIND_BEETLE]] });
    const unlocked = codexRows(progress(FULL_MASK))[1]!.rows.find((r) =>
      r.name.includes('虫群母巢'),
    )!;
    expect(unlocked.locked).toBe(false);
    expect(unlocked.hover.some((l) => l.includes('未解锁'))).toBe(false);
  });

  it('法令全量 10 条:悬停 = 效果摘要 + 叠层上限;超载协议未解锁带条件', () => {
    const edicts = codexRows(progress(0))[2]!.rows;
    expect(edicts.length).toBe(EDICTS.length);
    const over = edicts.find((r) => r.name === '超载协议')!;
    expect(over.locked).toBe(true);
    expect(over.hover[over.hover.length - 1]).toBe('未解锁 · 单局击杀 300');
    const ammo = edicts.find((r) => r.name === '弹药协议')!;
    expect(ammo.locked).toBe(false);
    expect(ammo.hover).toEqual(['弹药系:射速 ×1.25 · 装填 ×0.7', '最多 5 层']);
    expect(ammo.art?.kind).toBe('svg');
    expect(svgOf(ammo.art)).toContain('▦'); // EDICT_ICONS[0]
    expect(svgOf(ammo.art)).toContain(tintHex(EDICTS[EDICT_AMMO]!.tint));
  });
});

// —— DOM 接线(照 gameOver.test.ts 的 installDom 桩模式,不装 jsdom)——

interface StubEl {
  tagName: string;
  style: { cssText: string; color: string; display: string; left: string; top: string };
  textContent: string;
  src: string;
  alt: string;
  children: StubEl[];
  listeners: Map<string, (e: unknown) => void>;
  append(...kids: StubEl[]): void;
  appendChild(kid: StubEl): StubEl;
  replaceChildren(...kids: StubEl[]): void;
  addEventListener(type: string, fn: (e: unknown) => void): void;
  getBoundingClientRect(): { left: number; bottom: number };
}

function createStubEl(tag = 'div'): StubEl {
  const el: StubEl = {
    tagName: tag.toUpperCase(),
    style: { cssText: '', color: '', display: '', left: '', top: '' },
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
    getBoundingClientRect(): { left: number; bottom: number } {
      return { left: 10, bottom: 120 };
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
    innerWidth: 1000, // tooltip 贴边夹取读它
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

/** 深度查找:按谓词扫子树,返回第一个命中(卡片名都是 leaf,textContent 可精确匹配) */
function findEl(rootEl: StubEl, pred: (el: StubEl) => boolean): StubEl | undefined {
  if (pred(rootEl)) return rootEl;
  for (const kid of rootEl.children) {
    const hit = findEl(kid, pred);
    if (hit) return hit;
  }
  return undefined;
}

/** 反查父节点:卡片名改挂名称 div 之后,灰显断言要看它父格子的 cssText */
function parentOf(rootEl: StubEl, target: StubEl): StubEl | undefined {
  for (const kid of rootEl.children) {
    if (kid === target) return rootEl;
    const hit = parentOf(kid, target);
    if (hit) return hit;
  }
  return undefined;
}

/** 悬停 tooltip:整页唯一那个 fixed 定位、pointer-events:none 的 div */
function tip(dom: StubDom): StubEl {
  return dom.created.find(
    (el) => el.style.cssText.includes('position:fixed') && el.style.cssText.includes('pointer-events:none'),
  )!;
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

  it('show 整块重排:标题带计数、卡片图上名下、锁定卡灰显', () => {
    const ui = make();
    ui.show();
    const title = findEl(root(dom), (el) => el.textContent.startsWith('图鉴 ·'))!;
    expect(title.textContent).toBe('图鉴 · 内容解锁 0/3');
    const stats = findEl(root(dom), (el) => el.textContent.startsWith('胜场'))!;
    expect(stats.textContent).toBe('胜场 1 · 总击杀 100 · 精英击杀 2');
    // 卡片名是纯名称(数值在悬停里);分区标题在
    expect(findEl(root(dom), (el) => el.textContent === '武器')).toBeDefined();
    expect(findEl(root(dom), (el) => el.textContent === '自动机炮')).toBeDefined();
    // 锁定卡:名称 div 的父格子带 opacity 灰显
    const lockedName = findEl(root(dom), (el) => el.textContent === '导弹巢')!;
    expect(parentOf(root(dom), lockedName)!.style.cssText).toContain('opacity:.45');
  });

  it('过滤器:切到法令只剩法令卡,切回全部恢复', () => {
    const ui = make();
    ui.show();
    const edictBtn = dom.created.find(
      (el) => el.tagName === 'BUTTON' && el.textContent === '法令',
    )!;
    edictBtn.listeners.get('click')?.({});
    expect(findEl(root(dom), (el) => el.textContent === '弹药协议')).toBeDefined();
    expect(findEl(root(dom), (el) => el.textContent === '自动机炮')).toBeUndefined();
    const allBtn = dom.created.find(
      (el) => el.tagName === 'BUTTON' && el.textContent === '全部',
    )!;
    allBtn.listeners.get('click')?.({});
    expect(findEl(root(dom), (el) => el.textContent === '自动机炮')).toBeDefined();
    expect(findEl(root(dom), (el) => el.textContent === '弹药协议')).toBeDefined();
  });

  it('悬停 tooltip:进卡弹出(含 ★/★★/★★★ 星级读数),出卡收起', () => {
    const ui = make();
    ui.show();
    const nameEl = findEl(root(dom), (el) => el.textContent === '自动机炮')!;
    const cell = parentOf(root(dom), nameEl)!;
    // 初始 display:none 落在构造时的 cssText 里(桩不解析 cssText,与遮罩同款断言)
    expect(tip(dom).style.cssText).toContain('display:none');
    cell.listeners.get('mouseenter')?.({});
    expect(tip(dom).style.display).toBe('block');
    expect(tip(dom).textContent).toContain('★ 伤害');
    expect(tip(dom).textContent).toContain('★★ 伤害');
    expect(tip(dom).textContent).toContain('★★★ 伤害');
    expect(tip(dom).style.top).toBe('126px'); // 卡下方 6px
    cell.listeners.get('mouseleave')?.({});
    expect(tip(dom).style.display).toBe('none');
  });

  it('卡片配图:PNG 直摆、无贴图条目走 SVG data URI(导弹巢/法令)', () => {
    const ui = make();
    ui.show();
    const thumbs = dom.created.filter((el) => el.tagName === 'IMG' && el.alt === '图鉴图标');
    // 武器 13 卡 + 敌人 8 卡 + 法令 10 卡,配图数必然远多于零
    expect(thumbs.length).toBeGreaterThan(20);
    expect(thumbs.some((el) => el.src.endsWith('.png'))).toBe(true); // 生成贴图直摆
    const svg = thumbs.find((el) => el.src.startsWith('data:image/svg+xml'));
    expect(svg).toBeDefined(); // 导弹巢与法令的徽章走 data URI
    expect(svg!.src).toContain(encodeURIComponent('♁')); // 导弹巢字形
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
