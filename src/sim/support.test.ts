/**
 * 邻接协同(06 号 issue T1-b,GDD §4.3)。本文件在 Node 里跑通本身就是铁律 1 的一层验证:
 * "谁给谁加成"只依赖甲板这个纯对象与两张数值表,不需要 Pixi、不需要一帧渲染。
 *
 * 钉的几条口径(改坏就等于改坏了 06 的验收标准):
 *   **正交四邻**——斜角相邻零效果、零连线;洞与船体外一律不算邻居(两者给同一个答案),
 *     且 L 形/环形甲板照单全收(邻居只从 deck 的 neighborCell 取,12 号焊出的形状不必回头改规则);
 *   **节流类型不匹配 ⇒ 既不进 links、也不改任何一个读数** —— UI 于是天然画不出那条线(不画 = 不误导),
 *     装甲舱(SUPPORT_THR_NONE)对六塔全员不匹配,一条 link 都不产生;
 *   **离线塔不算受益格** —— 被 12 号围死的哑炮身上不该挂着一条"正在生效"的线;
 *   **四个倍率一律连乘** —— 两座弹药库夹一门机炮 = ×1.25² / ×0.7²,收益递减但永远推不到 ≤ 0;
 *   **连线与 buff 是同一份** —— 照 supportLinks 自己折一遍,必须与缓存逐格逐位相同;
 *   **revision 守卫** —— 甲板没变就整帧不重算,一变(放置或 12 号的 setOccupied)当场重算。
 *
 * 数值一律从 SUPPORTS 现读、绝不抄字面量:06 号验收要的是"改数据文件即可调平衡",
 * 把 1.25 抄进断言里,调一次表就得回来改一遍测试 —— 那条验收也就名存实亡了。
 */
import { describe, expect, it } from 'vitest';
import {
  SUP_AMMO_BAY,
  SUP_ARMOR_BAY,
  SUP_CAPACITOR,
  SUP_RADIATOR,
  SUPPORTS,
} from '../data/supports';
import { TOWER_AUTOCANNON, TOWER_LASER, TOWER_RAILGUN } from '../data/towers';
import {
  CELL_SUPPORT,
  CELL_WEAPON,
  cellAt,
  cellIndex,
  createDeck,
  type Deck,
  type DeckCell,
  isPlaceSuccess,
  placeAt,
  setOccupied,
} from './deck';
import { recomputeSupportBuffs, supportLinks, syncSupportBuffs } from './support';

const AMMO = SUPPORTS[SUP_AMMO_BAY]!;
const RADIATOR = SUPPORTS[SUP_RADIATOR]!;
const CAPACITOR = SUPPORTS[SUP_CAPACITOR]!;

/** 四个倍率的中性读数。**1 不是 0**:0 作倍率是把塔抹死,与"这一格没有加成"是两码事 */
const NONE = [1, 1, 1, 1];

/** 配对表的复用缓冲:supportLinks 收 out 正是为了这个,单测也照渲染层那样整份文件只留一块(铁律 3) */
const pairs: number[] = [];

/**
 * 连线表读成 '支援格 → 受益格' 的坐标串。
 * 比一串下标好读也好定位,顺带把两条约定钉死:out[2k] 是支援格、out[2k+1] 是受益塔格;
 * 顺序 = 支援格按 cells 的 row-major、每格再按 EDGE_* 升序(确定性口径,连线叠色也靠它不跳)。
 */
function links(deck: Deck): string[] {
  const flat = supportLinks(deck, pairs);
  const list: string[] = [];
  for (let k = 0; k + 1 < flat.length; k += 2) {
    const a = deck.cells[flat[k]!]!;
    const b = deck.cells[flat[k + 1]!]!;
    list.push(`${a.col},${a.row}→${b.col},${b.row}`);
  }
  return list;
}

/** 四个邻接倍率整组一起断言(照 deck.test.ts 的 muls):漏检其中一个,漏乘/漏清那一个就永远看不见 */
const muls = (cell: DeckCell): number[] => [
  cell.fireRateMul,
  cell.reloadMul,
  cell.heatMaxMul,
  cell.chargeRateMul,
];

/**
 * 照 links 表把四个倍率自己折一遍(独立于 recomputeSupportBuffs 的第二份算法)。
 * 与缓存对不上就说明"连线"与"加成"已经是两套规则了 —— 而 06 号验收第二条
 * "连线只出现在真实生效的配对上"正是靠两者同源才成立的。
 */
function foldLinks(deck: Deck): number[][] {
  const flat = supportLinks(deck, pairs);
  const out = deck.cells.map(() => [1, 1, 1, 1]);
  for (let k = 0; k + 1 < flat.length; k += 2) {
    const def = SUPPORTS[deck.cells[flat[k]!]!.supportType]!;
    const m = out[flat[k + 1]!]!;
    m[0] = m[0]! * def.fireRateMul;
    m[1] = m[1]! * def.reloadMul;
    m[2] = m[2]! * def.heatMaxMul;
    m[3] = m[3]! * def.chargeRateMul;
  }
  return out;
}

/** 放一座塔;放不下当场红 —— 免得后面的断言在一块空甲板上"全绿" */
function tower(deck: Deck, col: number, row: number, type: number = TOWER_AUTOCANNON): DeckCell {
  const code = placeAt(deck, col, row, CELL_WEAPON, type);
  expect(isPlaceSuccess(code), `塔 ${type} @(${col},${row})`).toBe(true);
  return cellAt(deck, col, row)!;
}

/** 放一块设施。第 4 参(塔型)对设施完全无意义,照 deck 的签名原样传缺省值 */
function support(deck: Deck, col: number, row: number, type: number): DeckCell {
  const code = placeAt(deck, col, row, CELL_SUPPORT, TOWER_AUTOCANNON, type);
  expect(isPlaceSuccess(code), `设施 ${type} @(${col},${row})`).toBe(true);
  return cellAt(deck, col, row)!;
}

/**
 * 用字符画建甲板(与 deck.test.ts 的 deckFrom 同一份):一个字符串一行(row 0 最靠船头),
 * '#' = 属于船体,'.' = 洞或船体外。走 setOccupied,顺带把"12 号扩建入口"压在每个形状用例上。
 */
function deckFrom(art: string[]): Deck {
  const rows = art.length;
  const cols = art[0]!.length;
  const deck = createDeck(cols, rows);
  for (let row = 0; row < rows; row++) {
    const line = art[row]!;
    for (let col = 0; col < cols; col++) setOccupied(deck, col, row, line[col] === '#');
  }
  return deck;
}

describe('supportLinks:生效中的邻接配对', () => {
  it('正交四邻:斜角相邻零效果、零连线;同一块设施挪到正交位上立刻生效', () => {
    const deck = createDeck();
    const gun = tower(deck, 1, 0);
    // (1,0) 的两个斜角邻格。注意正交这一侧最多只能有三个邻居:四个正交邻格都属于船体的格
    // 必然是内部格,而内部格上的武器塔早就离线了(GDD §4.1 的"边缘内化")
    support(deck, 0, 1, SUP_AMMO_BAY);
    support(deck, 2, 1, SUP_AMMO_BAY);
    recomputeSupportBuffs(deck);
    expect(links(deck)).toEqual([]);
    expect(muls(gun)).toEqual(NONE);

    // 同一种设施换到正交位:立刻有线、立刻有加成 —— 上面那两块不是"型号不对",纯粹是位置不对
    support(deck, 0, 0, SUP_AMMO_BAY);
    recomputeSupportBuffs(deck);
    expect(links(deck)).toEqual(['0,0→1,0']);
    expect(muls(gun)).toEqual([AMMO.fireRateMul, AMMO.reloadMul, 1, 1]);
  });

  it('一块设施喂四邻的每一座塔:多条 link 从同一格出发,受益格各拿各的', () => {
    const deck = createDeck();
    // 内部格正是它的主场(GDD §4.1:边缘格开火、内部格供能)
    const bay = support(deck, 1, 1, SUP_AMMO_BAY);
    const guns = [tower(deck, 1, 0), tower(deck, 0, 1), tower(deck, 2, 1)];
    recomputeSupportBuffs(deck);

    // 第四个邻格 (1,2) 也是内部格,武器塔上不去 ⇒ 四邻里只有三座塔。顺序 = EDGE_* 升序
    expect(links(deck)).toEqual(['1,1→1,0', '1,1→2,1', '1,1→0,1']);
    for (const g of guns) {
      expect(muls(g), `(${g.col},${g.row})`).toEqual([AMMO.fireRateMul, AMMO.reloadMul, 1, 1]);
    }
    // 设施自己不吃自己的加成:受益格永远是 link 的另一端
    expect(muls(bay)).toEqual(NONE);
  });

  it('洞与船体外都不算邻居;把洞焊上,同一格立刻算邻居', () => {
    const deck = deckFrom(['###', '#.#', '###']);
    const gun = tower(deck, 1, 0); // 船头边临空、船尾边是洞 —— 两条暴露边
    support(deck, 0, 0, SUP_AMMO_BAY);
    support(deck, 1, 2, SUP_AMMO_BAY); // 隔着洞:洞不是桥,它与塔不是邻居
    expect(cellAt(deck, 1, 1)!.occupied).toBe(false);
    expect(links(deck)).toEqual(['0,0→1,0']);

    // 12 号把洞焊上,同一格立刻算邻居 —— 上面那条"不算"是因为它是洞,不是因为几何变了
    setOccupied(deck, 1, 1, true);
    support(deck, 1, 1, SUP_AMMO_BAY);
    expect(links(deck)).toEqual(['0,0→1,0', '1,1→1,0']);
    recomputeSupportBuffs(deck);
    expect(gun.fireRateMul).toBe(AMMO.fireRateMul * AMMO.fireRateMul);
  });

  it('非矩形甲板(L 形 / 环形):邻居只从 neighborCell 取,形状再怪也是同一条规则', () => {
    // L 形:一条竖臂 + 一只脚。塔落在竖臂中段,正交邻居只有上下两格(右边是空气)
    const l = deckFrom(['#..', '#..', '###']);
    const gun = tower(l, 0, 1);
    support(l, 0, 0, SUP_AMMO_BAY);
    support(l, 0, 2, SUP_AMMO_BAY);
    support(l, 1, 2, SUP_AMMO_BAY); // 与塔斜角相邻;它正交挨着的 (0,2) 是设施,设施之间不配对
    recomputeSupportBuffs(l);
    expect(links(l)).toEqual(['0,0→0,1', '0,2→0,1']);
    expect(gun.fireRateMul).toBe(AMMO.fireRateMul * AMMO.fireRateMul);

    // 环形:中间两格是洞,塔的船尾边正对着洞
    const ring = deckFrom(['####', '#..#', '####']);
    const g2 = tower(ring, 1, 0);
    support(ring, 0, 0, SUP_AMMO_BAY);
    support(ring, 2, 0, SUP_AMMO_BAY);
    support(ring, 0, 1, SUP_AMMO_BAY); // 斜角
    support(ring, 1, 2, SUP_AMMO_BAY); // 隔着洞
    recomputeSupportBuffs(ring);
    expect(links(ring)).toEqual(['0,0→1,0', '2,0→1,0']);
    expect(g2.fireRateMul).toBe(AMMO.fireRateMul * AMMO.fireRateMul);
  });

  it('节流类型不匹配:既不进 links(UI 于是画不出线),四个读数也一个字不改', () => {
    const deck = createDeck();
    const gun = tower(deck, 1, 0); // 弹药系
    support(deck, 0, 0, SUP_RADIATOR); // 过热系:同一个正交位,只是型号不对
    support(deck, 2, 0, SUP_AMMO_BAY); // 弹药系:对照组
    support(deck, 1, 1, SUP_CAPACITOR); // 充能系
    recomputeSupportBuffs(deck);

    // 只剩弹药库那一条:不匹配的配对**根本不进这张表**,故"UI 不画线"是结构上的,不是靠人记得跳过
    expect(links(deck)).toEqual(['2,0→1,0']);
    // 而且是一个字都不改:heatMaxMul 停在 1 而不是散热器的 1.5,chargeRateMul 停在 1 而不是 1.3
    expect(muls(gun)).toEqual([AMMO.fireRateMul, AMMO.reloadMul, 1, 1]);
    expect(RADIATOR.heatMaxMul).not.toBe(1); // 用例不空转的证明:那块设施本身是有效果的
    expect(CAPACITOR.chargeRateMul).not.toBe(1);
  });

  it('装甲舱:一条 link 都不产生,任何一格的四个倍率都不改', () => {
    const deck = createDeck();
    // 三系塔各一座:装甲舱对六塔全员不匹配,三条腿一条都连不起来
    tower(deck, 0, 0, TOWER_LASER); // 过热系
    tower(deck, 1, 0, TOWER_AUTOCANNON); // 弹药系
    tower(deck, 2, 0, TOWER_RAILGUN); // 充能系
    for (const [col, row] of [
      [0, 1],
      [1, 1],
      [2, 1],
    ] as const) {
      support(deck, col, row, SUP_ARMOR_BAY);
    }
    recomputeSupportBuffs(deck);

    expect(links(deck)).toEqual([]);
    for (const c of deck.cells) expect(muls(c), `(${c.col},${c.row})`).toEqual(NONE);
    // 用例不空转的证明:三块装甲舱确实焊上去了。
    // 它的 HP +15 与所在舷减伤在 sim/damage.ts 现遍历 cells 算,压根不走本文件
    expect(deck.cells.filter((c) => c.supportType === SUP_ARMOR_BAY).length).toBe(3);
  });

  it('离线塔(被围死的武器格)不算受益格:连线与加成一起消失', () => {
    // 右舷开个洞,(1,1) 因此还剩一条暴露边 —— 是边缘格,放得下塔
    const deck = deckFrom(['###', '##.', '###']);
    const gun = tower(deck, 1, 1);
    support(deck, 0, 1, SUP_AMMO_BAY);
    syncSupportBuffs(deck);
    expect(gun.online).toBe(true);
    expect(links(deck)).toEqual(['0,1→1,1']);
    expect(muls(gun)).toEqual([AMMO.fireRateMul, AMMO.reloadMul, 1, 1]);

    // 12 号把那个洞焊上:(1,1) 四面被围 → 离线(GDD §4.1 的"边缘内化")。
    // 塔还在那儿(战斗中不可移动、不可出售),但它一发都打不出去 ——
    // 走 sync 而不是 recompute:setOccupied 也 bump 了 revision,守卫因此当场失效,
    // 焊拆甲板这条路不必记得来调一次重算
    setOccupied(deck, 2, 1, true);
    expect(gun.online).toBe(false);
    expect(links(deck)).toEqual([]);
    syncSupportBuffs(deck);
    expect(muls(gun)).toEqual(NONE); // 复位那一步的可观察证据:加成不会赖在格上
  });

  it('配对表写进调用方的缓冲:返回的就是它本身,进门先清长度(铁律 3)', () => {
    const deck = createDeck();
    tower(deck, 1, 0);
    support(deck, 0, 0, SUP_AMMO_BAY);

    const buf: number[] = [7, 7, 7]; // 上一次留下的残留
    expect(supportLinks(deck, buf)).toBe(buf); // 同一块数组,不新造(渲染层整局用到底)
    expect(buf).toEqual([cellIndex(deck, 0, 0), cellIndex(deck, 1, 0)]);
    // 一对都没有的甲板必须把残留清干净,否则渲染层会照着上一次的配对再画一遍
    expect(supportLinks(createDeck(), buf)).toEqual([]);
  });
});

describe('recomputeSupportBuffs:全甲板复位 + 逐对连乘', () => {
  it('先全甲板复位:上一份甲板留下的脏值一律被抹掉,复位值是 1 不是 0', () => {
    const deck = createDeck();
    const gun = tower(deck, 1, 0);
    support(deck, 0, 0, SUP_AMMO_BAY);
    // 手塞一整块脏值:12 号"拆了再焊"、或某帧漏同步,现场就是这个样子
    for (const c of deck.cells) {
      c.fireRateMul = 3;
      c.reloadMul = 3;
      c.heatMaxMul = 3;
      c.chargeRateMul = 3;
    }
    recomputeSupportBuffs(deck);

    for (const c of deck.cells) {
      // 没有来源的格一律回到 1 —— 复位成 0 的话,每座塔一进场就是"射速 0、热上限 0",永远打不响
      if (c !== gun) expect(muls(c), `(${c.col},${c.row})`).toEqual(NONE);
    }
    // 受益格也是**从 1 起连乘**,而不是叠在脏值上(3 × 1.25 = 3.75 就是漏了复位的样子)
    expect(muls(gun)).toEqual([AMMO.fireRateMul, AMMO.reloadMul, 1, 1]);
  });

  it('多来源连乘:两座弹药库夹一门机炮 = 射速 ×1.25²、装填 ×0.7²', () => {
    const deck = createDeck();
    const gun = tower(deck, 1, 0);
    support(deck, 0, 0, SUP_AMMO_BAY);
    support(deck, 2, 0, SUP_AMMO_BAY);
    recomputeSupportBuffs(deck);
    expect(links(deck).length).toBe(2);
    expect(gun.fireRateMul).toBe(AMMO.fireRateMul * AMMO.fireRateMul);
    expect(gun.reloadMul).toBe(AMMO.reloadMul * AMMO.reloadMul);
    // 不作用的那两档仍然恒 1:弹药库的 heatMaxMul/chargeRateMul 是 1,乘几次都是恒等
    expect(gun.heatMaxMul).toBe(1);
    expect(gun.chargeRateMul).toBe(1);

    // 三面围满:连乘只是收益递减,倍率永远推不到 ≤ 0 ——
    // 这正是不用"每座 -30%"加法的理由(四座围一门就会把装填时间推成负数)
    support(deck, 1, 1, SUP_AMMO_BAY);
    recomputeSupportBuffs(deck);
    expect(links(deck).length).toBe(3);
    expect(gun.fireRateMul).toBe(AMMO.fireRateMul * AMMO.fireRateMul * AMMO.fireRateMul);
    expect(gun.reloadMul).toBe(AMMO.reloadMul * AMMO.reloadMul * AMMO.reloadMul);
    expect(gun.reloadMul).toBeGreaterThan(0);
  });

  it('每一次连乘都对应一条 link:连线与加成是同一份,不是两套规则', () => {
    const deck = createDeck();
    tower(deck, 0, 0, TOWER_LASER); // 过热系
    tower(deck, 1, 0, TOWER_AUTOCANNON); // 弹药系
    tower(deck, 2, 0, TOWER_RAILGUN); // 充能系
    support(deck, 0, 1, SUP_RADIATOR);
    support(deck, 1, 1, SUP_AMMO_BAY);
    support(deck, 2, 1, SUP_CAPACITOR);
    support(deck, 1, 2, SUP_ARMOR_BAY); // 一条 link 都不产生
    recomputeSupportBuffs(deck);

    // 逐格逐位对:两边哪天走散,画出来的线就与真正生效的加成对不上(06 号验收第二条当场作废)
    expect(deck.cells.map(muls)).toEqual(foldLinks(deck));
    // 三系各吃各的那一档,互不串味
    expect(cellAt(deck, 0, 0)!.heatMaxMul).toBe(RADIATOR.heatMaxMul);
    expect(cellAt(deck, 1, 0)!.fireRateMul).toBe(AMMO.fireRateMul);
    expect(cellAt(deck, 2, 0)!.chargeRateMul).toBe(CAPACITOR.chargeRateMul);
  });
});

describe('syncSupportBuffs:revision 守卫', () => {
  it('第一次一定重算:buffRevision 起手 -1,与 createDeck 的 revision 0 不等', () => {
    const deck = createDeck();
    const cell = cellAt(deck, 1, 1)!;
    cell.fireRateMul = 42; // 充当"12 号从一块已经带设施的甲板起手"时的旧读数
    expect(deck.buffRevision).toBe(-1);

    syncSupportBuffs(deck);
    expect(deck.buffRevision).toBe(deck.revision);
    // 真的算过了 —— buffRevision 起手填 0 的话这一遍永远不会发生(那是整局都没有加成)
    expect(cell.fireRateMul).toBe(1);
  });

  it('revision 没变就不重算;一变(放置)当场重算', () => {
    const deck = createDeck();
    const gun = tower(deck, 1, 0);
    support(deck, 0, 0, SUP_AMMO_BAY);
    // 放置本身不写这四个字段:它们是派生量,由 sync 统一刷(World 帧首一次、place 成功后一次)
    expect(muls(gun)).toEqual(NONE);
    expect(deck.buffRevision).not.toBe(deck.revision);

    syncSupportBuffs(deck);
    expect(deck.buffRevision).toBe(deck.revision);
    expect(gun.fireRateMul).toBe(AMMO.fireRateMul);

    // 干净时是纯 O(1):手改一个倍率再 sync,它纹丝不动(真重算过就会被复位再连乘回 1.25)
    gun.fireRateMul = 42;
    syncSupportBuffs(deck);
    expect(gun.fireRateMul).toBe(42);

    // 甲板一变(再焊一块弹药库)守卫当场失效,顺手把那个脏值抹掉
    support(deck, 2, 0, SUP_AMMO_BAY);
    expect(deck.buffRevision).not.toBe(deck.revision);
    syncSupportBuffs(deck);
    expect(gun.fireRateMul).toBe(AMMO.fireRateMul * AMMO.fireRateMul);
    expect(deck.buffRevision).toBe(deck.revision);
  });
});
