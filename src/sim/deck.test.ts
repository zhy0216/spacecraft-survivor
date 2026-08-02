/**
 * 甲板网格(03 号 issue T1)。本文件在 Node 里跑通本身就是铁律 1 的一层验证:
 * 甲板的拓扑与几何不依赖 Pixi/DOM,一个纯对象就能问出"谁是边缘格、法线朝哪"。
 *
 * 钉的几条口径(改坏就等于改坏了 03 的验收标准):
 *   暴露边只看四个正交邻格是否 occupied —— 非矩形/凹形/中心带洞的集合都得吃得下,
 *     且中心的洞对四周算暴露(不做"从外部可达"的洪水填充,GDD §4.1 的"四面被围"是字面意思);
 *   角落格必须两条暴露边**正交** —— 1 格宽甲板的对边暴露不是角落格,
 *     否则 04 号对它求两条法线的角平分线会退化;
 *   格坐标随船平移旋转,cellWorldPos 与 cellIndexAtWorld 严格互逆(放置交互的拾取靠它);
 *   暴露边法线 = heading + 局部角,且确实指向"格外" —— 04 号的射界中心架在它上面。
 *
 * 船体尺寸在文件顶部显式写死并 afterEach 还原(照 ship.test.ts 的做法):
 * M0 会反复调 tuning,几何断言不该被平衡调整带崩。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { tuning } from './config';
import * as deckApi from './deck';
import {
  canPlace,
  CELL_EMPTY,
  CELL_SUPPORT,
  CELL_WEAPON,
  cellAt,
  cellIndex,
  cellIndexAtWorld,
  cellLocalPos,
  cellWorldPos,
  cellWorldPosAt,
  createDeck,
  DECK_COLS,
  DECK_ROWS,
  type Deck,
  type DeckCell,
  deckCellSize,
  EDGE_BOW,
  EDGE_COUNT,
  EDGE_PORT,
  EDGE_STARBOARD,
  EDGE_STERN,
  edgeWorldNormal,
  isCornerCell,
  isEdgeCell,
  isEdgeExposed,
  isInteriorCell,
  PLACE_BAD_CONTENT,
  PLACE_INTERIOR,
  PLACE_NO_CELL,
  PLACE_OK,
  PLACE_TAKEN,
  placeAt,
  recomputeDeck,
  setOccupied,
} from './deck';
import { createShip, type Vec2, wrapAngle } from './ship';

const BASE = { shipLength: 150, shipWidth: 112 };
Object.assign(tuning, BASE);
// 有用例会改船体尺寸来验证"格边长由 tuning 推导",跑完必须还原,否则污染同文件后续用例
afterEach(() => Object.assign(tuning, BASE));

const v = (): Vec2 => ({ x: 0, y: 0 });

/** 与 deck.ts 内部那张表同一份,这里刻意重写一遍:把"边下标 ↔ 邻格方向"这条约定钉死在测试里 */
const NEIGHBOR = [
  { dCol: 0, dRow: -1 }, // EDGE_BOW
  { dCol: 1, dRow: 0 }, // EDGE_STARBOARD
  { dCol: 0, dRow: 1 }, // EDGE_STERN
  { dCol: -1, dRow: 0 }, // EDGE_PORT
];

const bit = (...edges: number[]): number => edges.reduce((m, e) => m | (1 << e), 0);

const popcount = (m: number): number => {
  let n = 0;
  for (let e = 0; e < EDGE_COUNT; e++) if ((m & (1 << e)) !== 0) n++;
  return n;
};

const count = (deck: Deck, f: (c: DeckCell) => boolean): number => deck.cells.filter(f).length;

/** 输出 'col,row' 列表(cells 是 row-major,故顺序确定),比一堆布尔断言好读也好定位 */
const coordsOf = (deck: Deck, f: (c: DeckCell) => boolean): string[] =>
  deck.cells.filter(f).map((c) => `${c.col},${c.row}`);

/**
 * 用字符画建甲板:一个字符串一行(row 0 在最上 = 最靠船头),'#' = 属于船体,'.' = 洞或船体外。
 * 走 setOccupied 而不是直接改字段 —— 顺带把"12 号扩建入口"这条路径也压在每个形状用例上。
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

describe('格边长与 createDeck', () => {
  it('格边长由船体尺寸推导:取两轴较小值,甲板不超出包围盒', () => {
    expect(deckCellSize()).toBeCloseTo(Math.min(150 / DECK_ROWS, 112 / DECK_COLS), 12);
    expect(DECK_ROWS * deckCellSize()).toBeLessThanOrEqual(tuning.shipLength + 1e-9);
    expect(DECK_COLS * deckCellSize()).toBeLessThanOrEqual(tuning.shipWidth + 1e-9);
  });

  it('改船体尺寸,格边长跟着走(数值只进配置,不写死在逻辑里)', () => {
    tuning.shipLength = 200;
    tuning.shipWidth = 120;
    expect(deckCellSize()).toBe(40); // min(200/4, 120/3)
    tuning.shipWidth = 400; // 长边不再是瓶颈时,由船长那一轴定
    expect(deckCellSize()).toBe(50);
  });

  it('默认 3×4、全占用、全空格,下标 = row * cols + col', () => {
    const deck = createDeck();
    expect(deck.cols).toBe(DECK_COLS);
    expect(deck.rows).toBe(DECK_ROWS);
    expect(deck.cells.length).toBe(12);
    expect(deck.revision).toBe(0);
    for (let row = 0; row < DECK_ROWS; row++) {
      for (let col = 0; col < DECK_COLS; col++) {
        const i = row * DECK_COLS + col;
        expect(cellIndex(deck, col, row)).toBe(i);
        const cell = deck.cells[i]!;
        expect(cell.col).toBe(col);
        expect(cell.row).toBe(row);
        expect(cell.occupied).toBe(true);
        expect(cell.content).toBe(CELL_EMPTY);
        expect(cell.online).toBe(true);
      }
    }
  });

  it('越界下标一律 -1 / undefined', () => {
    const deck = createDeck();
    expect(cellIndex(deck, -1, 0)).toBe(-1);
    expect(cellIndex(deck, 0, -1)).toBe(-1);
    expect(cellIndex(deck, DECK_COLS, 0)).toBe(-1);
    expect(cellIndex(deck, 0, DECK_ROWS)).toBe(-1);
    expect(cellAt(deck, 3, 0)).toBeUndefined();
  });
});

describe('暴露边推导:3×4 满甲板(GDD §4.1 的 T0 拾荒艇)', () => {
  it('10 个边缘格 + 2 个内部格 + 4 个角落格', () => {
    const deck = createDeck();
    expect(count(deck, isEdgeCell)).toBe(10);
    expect(coordsOf(deck, isInteriorCell)).toEqual(['1,1', '1,2']);
    expect(coordsOf(deck, isCornerCell)).toEqual(['0,0', '2,0', '0,3', '2,3']);
    // 三类互斥且铺满:边缘 + 内部 = 全部占用格,角落是边缘的真子集
    expect(count(deck, (c) => isEdgeCell(c) && isInteriorCell(c))).toBe(0);
    expect(count(deck, (c) => isCornerCell(c) && !isEdgeCell(c))).toBe(0);
  });

  it('逐格掩码:只有"该方向没有占用邻格"才置位', () => {
    const deck = createDeck();
    for (const cell of deck.cells) {
      const want =
        (cell.row === 0 ? 1 << EDGE_BOW : 0) |
        (cell.row === DECK_ROWS - 1 ? 1 << EDGE_STERN : 0) |
        (cell.col === 0 ? 1 << EDGE_PORT : 0) |
        (cell.col === DECK_COLS - 1 ? 1 << EDGE_STARBOARD : 0);
      expect(cell.exposed).toBe(want);
      expect(cell.exposedCount).toBe(popcount(want));
      for (let e = 0; e < EDGE_COUNT; e++) {
        expect(isEdgeExposed(cell, e)).toBe((want & (1 << e)) !== 0);
      }
    }
  });

  it('掩码方向与全仓约定一致:row 0 = 船头行,col 0 = 左舷', () => {
    const deck = createDeck();
    expect(cellAt(deck, 0, 0)!.exposed).toBe(bit(EDGE_BOW, EDGE_PORT));
    expect(cellAt(deck, 2, 0)!.exposed).toBe(bit(EDGE_BOW, EDGE_STARBOARD));
    expect(cellAt(deck, 0, 3)!.exposed).toBe(bit(EDGE_STERN, EDGE_PORT));
    expect(cellAt(deck, 2, 3)!.exposed).toBe(bit(EDGE_STERN, EDGE_STARBOARD));
    expect(cellAt(deck, 1, 0)!.exposed).toBe(bit(EDGE_BOW)); // 船头正中:只有一条边朝外
  });
});

describe('暴露边推导:非矩形占用集合(12 号扩建会真的造出这些形状)', () => {
  it('L 形:只有 L 的拐角那格是角落格,脚上的中段是对边暴露', () => {
    const deck = deckFrom([
      '#..', //
      '#..',
      '###',
    ]);
    expect(count(deck, (c) => c.occupied)).toBe(5);
    expect(count(deck, isEdgeCell)).toBe(5); // 这么瘦的形状没有任何内部格
    expect(count(deck, isInteriorCell)).toBe(0);
    expect(coordsOf(deck, isCornerCell)).toEqual(['0,2']);

    // 拐角那格:船头侧与右舷都被自家甲板挡住,只剩船尾 + 左舷两条正交暴露边
    expect(cellAt(deck, 0, 2)!.exposed).toBe(bit(EDGE_STERN, EDGE_PORT));
    // 脚的中段:前后暴露、左右被围 —— 两条边但对边,不是角落格
    expect(cellAt(deck, 1, 2)!.exposed).toBe(bit(EDGE_BOW, EDGE_STERN));
    expect(cellAt(deck, 1, 2)!.exposedCount).toBe(2);
    expect(isCornerCell(cellAt(deck, 1, 2)!)).toBe(false);
    // 竖条的顶端三面临空
    expect(cellAt(deck, 0, 0)!.exposed).toBe(bit(EDGE_BOW, EDGE_STARBOARD, EDGE_PORT));
  });

  it('U 形凹口:凹口两侧的臂尖各是一个角落格,凹底是对边暴露', () => {
    const deck = deckFrom([
      '#.#', //
      '#.#',
      '###',
    ]);
    expect(count(deck, (c) => c.occupied)).toBe(7);
    expect(count(deck, isEdgeCell)).toBe(7);
    expect(count(deck, isInteriorCell)).toBe(0);
    expect(coordsOf(deck, isCornerCell)).toEqual(['0,2', '2,2']);

    // 凹底:朝凹口(船头侧)与船尾各一条,左右被两条臂夹住
    expect(cellAt(deck, 1, 2)!.exposed).toBe(bit(EDGE_BOW, EDGE_STERN));
    // 臂的中段:凹口那侧也算暴露 —— 凹进去的空气不是自家甲板
    expect(cellAt(deck, 0, 1)!.exposed).toBe(bit(EDGE_STARBOARD, EDGE_PORT));
    expect(cellAt(deck, 2, 1)!.exposed).toBe(bit(EDGE_STARBOARD, EDGE_PORT));
    // 凹口本身不属于船体:既不是边缘格也不是内部格
    const notch = cellAt(deck, 1, 1)!;
    expect(notch.exposed).toBe(0);
    expect(isEdgeCell(notch)).toBe(false);
    expect(isInteriorCell(notch)).toBe(false);
  });

  it('中心带洞:洞四周的格算暴露(纯局部邻接,不做可达性洪水填充)', () => {
    const deck = deckFrom([
      '###', //
      '#.#',
      '###',
    ]);
    expect(count(deck, (c) => c.occupied)).toBe(8);
    expect(count(deck, isInteriorCell)).toBe(0); // 洞让一圈全成了边缘格
    expect(coordsOf(deck, isCornerCell)).toEqual(['0,0', '2,0', '0,2', '2,2']);

    // 船头正中那格:外侧一条 + 朝洞一条。若改成"从外部可达"的判定,这里会只剩 1 条 —— 那就是回归
    const towardHole = cellAt(deck, 1, 0)!;
    expect(towardHole.exposed).toBe(bit(EDGE_BOW, EDGE_STERN));
    expect(isEdgeExposed(towardHole, EDGE_STERN)).toBe(true);
    expect(isCornerCell(towardHole)).toBe(false); // 两条边,但对边
  });

  it('5×5 挖一个洞:洞旁的格是边缘格,再外一圈才是内部格', () => {
    const deck = deckFrom([
      '#####', //
      '#####',
      '##.##',
      '#####',
      '#####',
    ]);
    // 贴着洞的四格各多一条朝洞的暴露边 —— 身处船体正中也能架炮(12 号"内脏位"反过来的一面)
    const nextToHole = cellAt(deck, 2, 1)!;
    expect(nextToHole.exposed).toBe(bit(EDGE_STERN));
    expect(isEdgeCell(nextToHole)).toBe(true);
    // 内部格 = 四邻俱全的那四格(斜贴着洞的不算,邻接只看正交)
    expect(coordsOf(deck, isInteriorCell)).toEqual(['1,1', '3,1', '1,3', '3,3']);
    expect(count(deck, isEdgeCell)).toBe(20);
  });

  it('单列 1×4:每格都是左右舷对边暴露 → 一个角落格都没有', () => {
    const deck = createDeck(1, 4);
    expect(count(deck, isEdgeCell)).toBe(4);
    expect(count(deck, isInteriorCell)).toBe(0);
    expect(count(deck, isCornerCell)).toBe(0); // 04 号求角平分线会退化,故必须排掉对边
    const mid = cellAt(deck, 0, 1)!;
    expect(mid.exposed).toBe(bit(EDGE_STARBOARD, EDGE_PORT));
    expect(mid.exposedCount).toBe(2);
    expect(cellAt(deck, 0, 0)!.exposedCount).toBe(3); // 两端还多一条首/尾边
    expect(cellAt(deck, 0, 3)!.exposedCount).toBe(3);
  });

  it('1×1:四面临空也不是角落格(两条暴露边是硬条件)', () => {
    const deck = createDeck(1, 1);
    const only = deck.cells[0]!;
    expect(only.exposedCount).toBe(4);
    expect(isEdgeCell(only)).toBe(true);
    expect(isCornerCell(only)).toBe(false);
    expect(isInteriorCell(only)).toBe(false);
  });
});

describe('setOccupied(12 号扩建入口)', () => {
  it('改一格牵动四邻的暴露边,并 bump revision', () => {
    const deck = createDeck();
    expect(deck.revision).toBe(0);
    const interior = cellAt(deck, 1, 1)!;
    expect(isInteriorCell(interior)).toBe(true);

    setOccupied(deck, 1, 0, false); // 挖掉船头正中那格
    expect(deck.revision).toBe(1);
    expect(isEdgeExposed(interior, EDGE_BOW)).toBe(true); // 邻格的掩码当场跟着变
    expect(isInteriorCell(interior)).toBe(false);
    expect(coordsOf(deck, isInteriorCell)).toEqual(['1,2']);
  });

  it('拆掉的格连内容一起清空(免得留下过期的塔与掩码)', () => {
    const deck = createDeck();
    cellAt(deck, 0, 0)!.content = CELL_WEAPON;
    setOccupied(deck, 0, 0, false);

    const c = cellAt(deck, 0, 0)!;
    expect(c.content).toBe(CELL_EMPTY);
    expect(c.exposed).toBe(0);
    expect(c.exposedCount).toBe(0);
    expect(c.online).toBe(true);
    expect(isEdgeCell(c)).toBe(false);
    expect(isInteriorCell(c)).toBe(false);
  });

  it('越界的格不炸、也不留痕', () => {
    const deck = createDeck();
    setOccupied(deck, -1, 0, true);
    setOccupied(deck, 0, DECK_ROWS, false);
    expect(deck.revision).toBe(0);
    expect(deck.cells.every((c) => c.occupied)).toBe(true);
  });
});

/**
 * 放置合法性与战斗规则(03 号 T2)。钉的是 GDD §4.1/§4.5 那两句话的字面实现:
 *   "边缘格开火、内部格供能" → 武器塔只上边缘格,支援设施任意空的占用格;
 *   "战斗中不可移动、不可出售" → 占用格永远拒绝,且整个模块根本没有拆除入口。
 * 理由码逐个钉住:被拒时 ui 照码说人话,码的语义一旦漂移,玩家看到的解释就会指错规则。
 * 边缘/内部一律现问暴露边(而不是查表),所以最后一条把"塔放好之后甲板才变"的情形也压上。
 */
describe('放置合法性与战斗规则(GDD §4.1 / §4.5)', () => {
  it('武器塔仅限边缘格:10 个边缘格放得下,2 个内部格一律 PLACE_INTERIOR', () => {
    const deck = createDeck();
    let ok = 0;
    for (const c of deck.cells) {
      const code = canPlace(deck, c.col, c.row, CELL_WEAPON);
      expect(code).toBe(isEdgeCell(c) ? PLACE_OK : PLACE_INTERIOR);
      if (code === PLACE_OK) ok++;
    }
    expect(ok).toBe(10); // T0 拾荒艇 = 10 边缘 + 2 内部(GDD §4.1)

    expect(placeAt(deck, 0, 0, CELL_WEAPON)).toBe(PLACE_OK);
    expect(cellAt(deck, 0, 0)!.content).toBe(CELL_WEAPON);
    // 内部格上的武器塔连写都写不进去 —— 不是"放进去再灰显",那是 12 号扩建才有的既成事实
    expect(placeAt(deck, 1, 1, CELL_WEAPON)).toBe(PLACE_INTERIOR);
    expect(cellAt(deck, 1, 1)!.content).toBe(CELL_EMPTY);
  });

  it('支援设施:任意空的占用格都行,内部格正是它的主场(03 验收标准那条)', () => {
    const deck = createDeck();
    for (const c of deck.cells) expect(canPlace(deck, c.col, c.row, CELL_SUPPORT)).toBe(PLACE_OK);

    expect(placeAt(deck, 1, 1, CELL_SUPPORT)).toBe(PLACE_OK); // 内部格
    expect(placeAt(deck, 0, 0, CELL_SUPPORT)).toBe(PLACE_OK); // 边缘(角落)格:支援不挑边
    expect(cellAt(deck, 1, 1)!.content).toBe(CELL_SUPPORT);
    expect(cellAt(deck, 0, 0)!.content).toBe(CELL_SUPPORT);
    // 支援设施不看暴露边:四面被围照样供能,online 恒 true(只有武器塔会离线)
    expect(cellAt(deck, 1, 1)!.online).toBe(true);
  });

  it('canPlace 与 placeAt 给同一个码;成功才 bump revision,拒绝一个字段都不动', () => {
    const deck = createDeck();
    const rejects: [number, number, number, number][] = [
      [1, 1, CELL_WEAPON, PLACE_INTERIOR],
      [9, 9, CELL_SUPPORT, PLACE_NO_CELL],
      [0, 0, CELL_EMPTY, PLACE_BAD_CONTENT],
    ];
    for (const [col, row, content, want] of rejects) {
      expect(canPlace(deck, col, row, content)).toBe(want);
      expect(placeAt(deck, col, row, content)).toBe(want); // 问和放必须同码,ui 才敢先问后放
    }
    // 拒绝不 bump:渲染层不会为一次拒绝白重建一遍底板几何(拒绝的表现是高亮层闪一下)
    expect(deck.revision).toBe(0);
    expect(deck.cells.every((c) => c.content === CELL_EMPTY)).toBe(true);

    expect(canPlace(deck, 0, 0, CELL_WEAPON)).toBe(PLACE_OK);
    expect(placeAt(deck, 0, 0, CELL_WEAPON)).toBe(PLACE_OK);
    expect(deck.revision).toBe(1);
  });

  it('已放置的不可覆盖:占用格一律 PLACE_TAKEN,连"换个内容盖上去"也不行', () => {
    const deck = createDeck();
    expect(placeAt(deck, 0, 0, CELL_WEAPON)).toBe(PLACE_OK);
    const rev = deck.revision;

    expect(canPlace(deck, 0, 0, CELL_WEAPON)).toBe(PLACE_TAKEN); // 同一种内容也不行
    expect(placeAt(deck, 0, 0, CELL_SUPPORT)).toBe(PLACE_TAKEN); // 换一种更不行
    // 想借"放个空格"把它清掉:CELL_EMPTY 连合法内容都不是,判定顺序上先被 BAD_CONTENT 挡掉
    expect(placeAt(deck, 0, 0, CELL_EMPTY)).toBe(PLACE_BAD_CONTENT);
    expect(cellAt(deck, 0, 0)!.content).toBe(CELL_WEAPON);
    expect(deck.revision).toBe(rev);

    // 支援设施同样锁死:MVP 里"占用"就是终局,重排要等船坞节点(GDD §4.5)
    expect(placeAt(deck, 1, 1, CELL_SUPPORT)).toBe(PLACE_OK);
    expect(canPlace(deck, 1, 1, CELL_SUPPORT)).toBe(PLACE_TAKEN);
  });

  it('模块里根本没有拆除/出售/移动的入口 —— 这就是"不可移动、不可出售"的全部实现', () => {
    // 规则的实现是"没有那个 API",而不是某处的一个 if:能被调用的东西迟早会被调用。
    // setOccupied 是 12 号焊/拆**甲板**的入口(拆掉的格连内容一起清),不是卖塔的后门,故不在此列。
    // M1 的船坞真加了拆除入口时这条会红 —— 那正是回来重读 §4.5(战斗中仍然不许拆)的时候。
    const exported = Object.keys(deckApi);
    expect(exported).toContain('placeAt'); // 反向确认这条断言不是在对着空模块空过
    expect(exported.filter((k) => /remove|demolish|sell|move|clearCell/i.test(k))).toEqual([]);
  });

  it('越界 / 洞 / 船体外 → PLACE_NO_CELL(拾取给回来的下标可能是任意整数)', () => {
    const donut = deckFrom(['###', '#.#', '###']);
    const rev = donut.revision;

    expect(canPlace(donut, 1, 1, CELL_SUPPORT)).toBe(PLACE_NO_CELL); // 洞:不属于船体
    expect(canPlace(donut, 1, 1, CELL_WEAPON)).toBe(PLACE_NO_CELL); // 非占用格先于边缘/内部判
    expect(canPlace(donut, -1, 0, CELL_SUPPORT)).toBe(PLACE_NO_CELL);
    expect(canPlace(donut, 0, 3, CELL_SUPPORT)).toBe(PLACE_NO_CELL);

    expect(placeAt(donut, 1, 1, CELL_SUPPORT)).toBe(PLACE_NO_CELL);
    expect(cellAt(donut, 1, 1)!.content).toBe(CELL_EMPTY);
    expect(donut.revision).toBe(rev);
  });

  it('content 非法 → PLACE_BAD_CONTENT,且这条判在最前(越界也照样先报内容不对)', () => {
    const deck = createDeck();
    for (const bad of [CELL_EMPTY, -1, 3, 99, NaN]) {
      expect(canPlace(deck, 0, 0, bad)).toBe(PLACE_BAD_CONTENT);
      // 判定顺序固定,理由码才有唯一语义:同一个错不能今天报这个、明天报那个
      expect(canPlace(deck, 99, 99, bad)).toBe(PLACE_BAD_CONTENT);
    }
  });

  it('canPlace 只读:问遍全甲板 × 各种内容,整个 deck 快照一位不差', () => {
    const deck = createDeck();
    placeAt(deck, 0, 0, CELL_WEAPON);
    placeAt(deck, 1, 1, CELL_SUPPORT);
    // 渲染层每帧对 12 个格问一遍来算高亮:它要是会写状态,放置模式一开着世界就在偷偷变
    const snapshot = JSON.stringify(deck);

    for (const c of deck.cells) {
      for (const content of [CELL_EMPTY, CELL_WEAPON, CELL_SUPPORT, 77]) {
        canPlace(deck, c.col, c.row, content);
      }
    }
    const outside: [number, number][] = [
      [-1, 0],
      [0, -1],
      [9, 9],
    ];
    for (const [col, row] of outside) canPlace(deck, col, row, CELL_WEAPON);

    expect(JSON.stringify(deck)).toBe(snapshot);
  });

  it('放好的武器塔被四面围死 → online 由 true 变 false(12 号边缘内化的预演)', () => {
    // 一条 1 格宽的竖甲板:中段左右舷临空,是边缘格,收得下武器塔
    const deck = deckFrom(['.#.', '.#.', '.#.']);
    expect(placeAt(deck, 1, 1, CELL_WEAPON)).toBe(PLACE_OK);
    const mid = cellAt(deck, 1, 1)!;
    expect(mid.online).toBe(true);

    setOccupied(deck, 0, 1, true); // 左舷焊一块:右舷还开着,照常开火
    expect(mid.exposedCount).toBe(1);
    expect(mid.online).toBe(true);

    setOccupied(deck, 2, 1, true); // 右舷也焊上:四面被围,炮位变"内脏位"
    expect(isInteriorCell(mid)).toBe(true);
    expect(mid.online).toBe(false);
    expect(mid.content).toBe(CELL_WEAPON); // 塔还在,只是灰显不开火(GDD §4.1),不是被清掉

    // 离线了也依然不许被顶掉:唯一的出路是船坞重排,不是"就地重放一次"
    expect(canPlace(deck, 1, 1, CELL_SUPPORT)).toBe(PLACE_TAKEN);
    // 而边缘判定确实是现算的:这一格此刻已经不再收新的武器塔,船头那格却还收
    expect(canPlace(deck, 1, 0, CELL_WEAPON)).toBe(PLACE_OK);
  });
});

describe('online:只有武器塔会因失去全部暴露边而离线', () => {
  it('内部格上的武器塔离线;支援设施与空格恒在线', () => {
    const deck = createDeck();
    cellAt(deck, 1, 1)!.content = CELL_WEAPON; // 内部格(放置规则会拦,这里直接写字段是为了单测派生量)
    cellAt(deck, 0, 0)!.content = CELL_WEAPON; // 角落格
    cellAt(deck, 1, 2)!.content = CELL_SUPPORT; // 内部格
    recomputeDeck(deck);

    expect(cellAt(deck, 1, 1)!.online).toBe(false);
    expect(cellAt(deck, 0, 0)!.online).toBe(true);
    expect(cellAt(deck, 1, 2)!.online).toBe(true);
    expect(deck.cells.every((c) => c.content === CELL_WEAPON || c.online)).toBe(true);
  });

  it('边缘格被焊成内部格 → 塔当场离线(12 号扩建的代价:炮位变内脏位)', () => {
    const deck = deckFrom([
      '.#.', //
      '.#.',
      '.#.',
    ]);
    const mid = cellAt(deck, 1, 1)!;
    mid.content = CELL_WEAPON;
    recomputeDeck(deck);
    expect(isEdgeCell(mid)).toBe(true);
    expect(mid.online).toBe(true);

    setOccupied(deck, 0, 1, true); // 两舷各焊上一块
    setOccupied(deck, 2, 1, true);
    expect(isInteriorCell(mid)).toBe(true);
    expect(mid.online).toBe(false);
    expect(mid.content).toBe(CELL_WEAPON); // 塔还在,只是灰显不开火,不是被清掉
  });
});

describe('格坐标:局部系与世界系', () => {
  it('cellLocalPos:+X = 船头、+Y = 右舷,整块甲板对称于船心', () => {
    const deck = createDeck();
    const size = deckCellSize();
    const p = v();

    cellLocalPos(deck, 0, 0, p); // 左舷最前
    expect(p.x).toBeCloseTo(1.5 * size, 9); // 4 行:最前一行在 +1.5 格
    expect(p.y).toBeCloseTo(-size, 9); // 3 列:最左一列在 -1 格
    cellLocalPos(deck, 2, 3, p); // 右舷最后
    expect(p.x).toBeCloseTo(-1.5 * size, 9);
    expect(p.y).toBeCloseTo(size, 9);

    let sx = 0;
    let sy = 0;
    for (const c of deck.cells) {
      cellLocalPos(deck, c.col, c.row, p);
      sx += p.x;
      sy += p.y;
    }
    expect(sx).toBeCloseTo(0, 9); // 对称 = 甲板重心就是船心,渲染层不必再补偏移
    expect(sy).toBeCloseTo(0, 9);
  });

  it('随船平移:heading = 0 时世界坐标 = 船位 + 局部坐标', () => {
    const deck = createDeck();
    const p = v();
    const l = v();
    for (const c of deck.cells) {
      cellLocalPos(deck, c.col, c.row, l);
      cellWorldPosAt(deck, 300, -120, 0, c.col, c.row, p);
      expect(p.x).toBeCloseTo(300 + l.x, 9);
      expect(p.y).toBeCloseTo(-120 + l.y, 9);
    }
  });

  it('随船旋转:船头朝屏幕上方时,row 0 那行在船的上方、右舷在屏幕右侧', () => {
    const deck = createDeck();
    const size = deckCellSize();
    const ship = createShip(); // heading = -π/2(y 轴朝下,即屏幕上方)
    ship.x = 50;
    ship.y = 80;
    const p = v();

    cellWorldPos(deck, ship, 1, 0, p); // 船头正中
    expect(p.x).toBeCloseTo(50, 9);
    expect(p.y).toBeCloseTo(80 - 1.5 * size, 9);
    cellWorldPos(deck, ship, 1, 3, p); // 船尾正中
    expect(p.y).toBeCloseTo(80 + 1.5 * size, 9);
    cellWorldPos(deck, ship, 2, 0, p); // 右舷最前
    expect(p.x).toBeCloseTo(50 + size, 9);
  });

  it('随船旋转:与船心的距离不变,方位角整体跟着 heading 转', () => {
    const deck = createDeck();
    const l = v();
    const a = v();
    const b = v();
    const h0 = 0.3;
    const h1 = h0 + 1.1;
    for (const c of deck.cells) {
      cellLocalPos(deck, c.col, c.row, l);
      cellWorldPosAt(deck, 10, -5, h0, c.col, c.row, a);
      cellWorldPosAt(deck, 10, -5, h1, c.col, c.row, b);

      const da = Math.hypot(a.x - 10, a.y + 5);
      expect(da).toBeCloseTo(Math.hypot(l.x, l.y), 9);
      expect(Math.hypot(b.x - 10, b.y + 5)).toBeCloseTo(da, 9);
      const rotated = wrapAngle(Math.atan2(b.y + 5, b.x - 10) - Math.atan2(a.y + 5, a.x - 10));
      expect(rotated).toBeCloseTo(h1 - h0, 9);
    }
  });

  it('cellWorldPos 与 cellIndexAtWorld:12 格往返一致(拾取靠这条互逆)', () => {
    const deck = createDeck();
    const p = v();
    const poses: [number, number, number][] = [
      [0, 0, 0],
      [0, 0, -Math.PI / 2],
      [137, -42, 0.7],
      [-880, 610, -2.3],
      [12.5, 7.25, 3.0],
    ];
    for (const [sx, sy, h] of poses) {
      for (const c of deck.cells) {
        cellWorldPosAt(deck, sx, sy, h, c.col, c.row, p);
        expect(cellIndexAtWorld(deck, sx, sy, h, p.x, p.y)).toBe(cellIndex(deck, c.col, c.row));
      }
    }
  });

  it('不在甲板上 / 落在非占用格 → -1', () => {
    const deck = createDeck();
    const size = deckCellSize();
    expect(cellIndexAtWorld(deck, 0, 0, 0, 500, 0)).toBe(-1);
    // 甲板长 4 格:船头前方 2 格是边界,差一点在里面、过一点就出去
    expect(cellIndexAtWorld(deck, 0, 0, 0, 2 * size - 0.01, 0)).toBe(cellIndex(deck, 1, 0));
    expect(cellIndexAtWorld(deck, 0, 0, 0, 2 * size + 0.01, 0)).toBe(-1);
    expect(cellIndexAtWorld(deck, 0, 0, 0, 0, 1.5 * size + 0.01)).toBe(-1); // 右舷方向出界

    // 洞正好落在船心:拾取必须当它是船体外的空白
    const donut = deckFrom(['###', '#.#', '###']);
    expect(cellIndexAtWorld(donut, 0, 0, 0, 0, 0)).toBe(-1);
  });
});

describe('暴露边法线', () => {
  it('= heading + 局部角(船头 0、右舷 +π/2、船尾 π、左舷 -π/2)', () => {
    for (const h of [0, 0.7, -Math.PI / 2, 2.9]) {
      expect(edgeWorldNormal(EDGE_BOW, h)).toBeCloseTo(wrapAngle(h), 9);
      expect(edgeWorldNormal(EDGE_STARBOARD, h)).toBeCloseTo(wrapAngle(h + Math.PI / 2), 9);
      expect(edgeWorldNormal(EDGE_STERN, h)).toBeCloseTo(wrapAngle(h + Math.PI), 9);
      expect(edgeWorldNormal(EDGE_PORT, h)).toBeCloseTo(wrapAngle(h - Math.PI / 2), 9);
    }
  });

  it('船头朝屏幕上方时,船头边的法线指向屏幕上方', () => {
    const ship = createShip();
    const n = edgeWorldNormal(EDGE_BOW, ship.heading);
    expect(Math.cos(n)).toBeCloseTo(0, 9);
    expect(Math.sin(n)).toBeCloseTo(-1, 9); // y 轴朝下 → -1 是上方
  });

  it('沿法线走一格:暴露边走出甲板,非暴露边正好落到那一侧的邻格', () => {
    const size = deckCellSize();
    const p = v();
    const cases = [
      { deck: createDeck(), h: 0.7, sx: 137, sy: -42 },
      { deck: deckFrom(['###', '#.#', '###']), h: -2.3, sx: -50, sy: 90 },
    ];
    for (const { deck, h, sx, sy } of cases) {
      for (const c of deck.cells) {
        if (!c.occupied) continue;
        for (let e = 0; e < EDGE_COUNT; e++) {
          cellWorldPosAt(deck, sx, sy, h, c.col, c.row, p);
          const n = edgeWorldNormal(e, h);
          const hit = cellIndexAtWorld(
            deck,
            sx,
            sy,
            h,
            p.x + Math.cos(n) * size,
            p.y + Math.sin(n) * size,
          );
          const step = NEIGHBOR[e]!;
          // 暴露 = 那一步之外没有自家甲板(出界或是洞);不暴露 = 正好踩在邻格上
          if (isEdgeExposed(c, e)) expect(hit).toBe(-1);
          else expect(hit).toBe(cellIndex(deck, c.col + step.dCol, c.row + step.dRow));
        }
      }
    }
  });
});
