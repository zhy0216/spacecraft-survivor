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
import { DECK_PIECES, DECK_PIECE_SQUARE } from '../data/deckPieces';
import { SUP_AMMO_BAY, SUP_ARMOR_BAY, SUP_RADIATOR, SUPPORT_KIND_COUNT } from '../data/supports';
import {
  TOWER_ARC,
  TOWER_AUTOCANNON,
  TOWER_KIND_COUNT,
  TOWER_LASER,
  TOWER_MAX_LEVEL,
  TOWER_PD,
  towerMagazine,
  TOWERS,
} from '../data/towers';
import { tuning } from './config';
import * as deckApi from './deck';
import {
  canPlace,
  canWeldPiece,
  CELL_EMPTY,
  CELL_SUPPORT,
  CELL_WEAPON,
  cellAt,
  cellIndex,
  cellIndexAtLocal,
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
  deckGridAtLocal,
  deckPieceCellAt,
  deckTurnRate,
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
  isPlaceSuccess,
  isWeldSuccess,
  neighborCell,
  PLACE_BAD_CONTENT,
  PLACE_BAD_SUPPORT,
  PLACE_BAD_TOWER,
  PLACE_INTERIOR,
  PLACE_MAX_LEVEL,
  PLACE_NO_CELL,
  PLACE_OK,
  PLACE_TAKEN,
  PLACE_UPGRADE,
  placeAt,
  recomputeDeck,
  setOccupied,
  WELD_DETACHED,
  WELD_OK,
  WELD_OVERLAP,
  weldPiece,
} from './deck';
import { createShip, type Vec2, wrapAngle } from './ship';

const BASE = { shipLength: 150, shipWidth: 112 };
Object.assign(tuning, BASE);
/** 叠级那一组有一条要临时改机炮弹夹(证明弹夹上限确实来自数值表),与 towers.test.ts 同口径:跑完还原 */
const BASE_MAGAZINE = TOWERS[TOWER_AUTOCANNON]!.magazine;
// 有用例会改船体尺寸来验证"格边长由 tuning 推导",跑完必须还原,否则污染同文件后续用例
afterEach(() => {
  Object.assign(tuning, BASE);
  TOWERS[TOWER_AUTOCANNON]!.magazine = BASE_MAGAZINE;
});

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

  it('已放置的不可覆盖:换塔型 / 换内容一律 PLACE_TAKEN(同种塔叠级是另一回事,见下一组)', () => {
    const deck = createDeck();
    expect(placeAt(deck, 0, 0, CELL_WEAPON, TOWER_AUTOCANNON)).toBe(PLACE_OK);
    const rev = deck.revision;

    // 05 号 T4 起,"同一种内容"要连塔型也同才算叠级:换一种塔 = 出售 + 重放,GDD §4.5 明令不许
    expect(canPlace(deck, 0, 0, CELL_WEAPON, TOWER_LASER)).toBe(PLACE_TAKEN);
    expect(placeAt(deck, 0, 0, CELL_SUPPORT)).toBe(PLACE_TAKEN); // 换内容更不行
    // 想借"放个空格"把它清掉:CELL_EMPTY 连合法内容都不是,判定顺序上先被 BAD_CONTENT 挡掉
    expect(placeAt(deck, 0, 0, CELL_EMPTY)).toBe(PLACE_BAD_CONTENT);
    expect(cellAt(deck, 0, 0)!.content).toBe(CELL_WEAPON);
    expect(cellAt(deck, 0, 0)!.towerType).toBe(TOWER_AUTOCANNON); // 被拒的那几下一个字段都没写进去
    expect(cellAt(deck, 0, 0)!.level).toBe(1);
    expect(deck.revision).toBe(rev);

    // 支援设施同样锁死:MVP 里"占用"就是终局,重排要等船坞节点(GDD §4.5);
    // 它也没有"同名叠级"这回事(06 号的设施是另一套),同内容再放一次照旧是 TAKEN
    expect(placeAt(deck, 1, 1, CELL_SUPPORT)).toBe(PLACE_OK);
    expect(canPlace(deck, 1, 1, CELL_SUPPORT)).toBe(PLACE_TAKEN);
    // 内部格的支援上盖武器塔:占用那一步排在 INTERIOR 之前,故报 TAKEN 而不是 INTERIOR
    expect(canPlace(deck, 1, 1, CELL_WEAPON)).toBe(PLACE_TAKEN);
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
        // 塔型也轮一遍:含 (0,0) 上那座机炮的**同型**问法,于是连"升一级"那条分支也压在只读口径下
        for (const t of [TOWER_AUTOCANNON, TOWER_LASER, 99]) {
          canPlace(deck, c.col, c.row, content, t);
        }
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

/**
 * 同名叠级(05 号 issue T4,GDD §5.4:Lv1→Lv5,数值成长,原格生效不占新格)。
 * 它刻意走 placeAt 这**同一个入口**:叠级不是移动、不是重放,故与 §4.5"不可移动、不可出售"共存;
 * 单开一个 upgrade API 的话,那个 API 迟早会被当成"先拆再放"用。
 * 这一组钉的是它与既有放置规则的接缝:成功码从此有两个、只有同型才叠、满级要说满级、
 * 升级绝不重置运行期节流状态(否则成长就变成"掐着弹夹见底去升级"的操作技巧)。
 */
describe('同名叠级 Lv1→Lv5(GDD §5.4)', () => {
  /** 场上的武器格数:"不占新格"就是这个数从头到尾不变 */
  const weaponCells = (deck: Deck): number =>
    deck.cells.filter((c) => c.content === CELL_WEAPON).length;

  it('新放塔:塔型/等级/满弹一次写齐,其余节流状态全零', () => {
    const deck = createDeck();
    expect(placeAt(deck, 0, 0, CELL_WEAPON, TOWER_LASER)).toBe(PLACE_OK);

    const cell = cellAt(deck, 0, 0)!;
    expect(cell.content).toBe(CELL_WEAPON);
    expect(cell.towerType).toBe(TOWER_LASER);
    expect(cell.level).toBe(1);
    // 上限现问数值表:激光是过热系,magazine 为 0 → 这里也该是 0,不该凭空冒出一夹子弹
    expect(cell.ammo).toBe(towerMagazine(TOWERS[TOWER_LASER]!, 1));
    for (const v of [cell.cooldown, cell.reloadLeft, cell.heat, cell.coolLock, cell.charge]) {
      expect(v).toBe(0); // 起手一律干净:节流状态的推进是 sim/tower.ts 的活,放置只负责生它
    }
  });

  it('弹药系新塔满弹进场,弹夹上限来自数值表(改表即改平衡,不改一行代码)', () => {
    const deck = createDeck();
    expect(placeAt(deck, 0, 0, CELL_WEAPON, TOWER_AUTOCANNON)).toBe(PLACE_OK);
    expect(cellAt(deck, 0, 0)!.ammo).toBe(towerMagazine(TOWERS[TOWER_AUTOCANNON]!, 1));
    expect(cellAt(deck, 0, 0)!.ammo).toBeGreaterThan(0); // 上一条不是"0 等于 0"的空过

    TOWERS[TOWER_AUTOCANNON]!.magazine = 7; // 只改数据表(afterEach 还原),deck.ts 一个字不动
    const tuned = createDeck();
    expect(placeAt(tuned, 0, 0, CELL_WEAPON, TOWER_AUTOCANNON)).toBe(PLACE_OK);
    expect(cellAt(tuned, 0, 0)!.ammo).toBe(7);
  });

  it('非武器格永远没有塔字段:支援设施与空格恒 towerType -1 / level 0', () => {
    const deck = createDeck();
    expect(placeAt(deck, 1, 1, CELL_SUPPORT)).toBe(PLACE_OK);
    expect(placeAt(deck, 0, 0, CELL_WEAPON, TOWER_ARC)).toBe(PLACE_OK);
    for (const c of deck.cells) {
      if (c.content === CELL_WEAPON) continue;
      expect(c.towerType).toBe(-1); // 0 是自动机炮:拿它当"没有塔"会让满甲板空格都自称机炮
      expect(c.level).toBe(0);
    }
  });

  it('同格同种塔 = 升一级:Lv1→Lv5 每级 bump revision,且始终不占新格', () => {
    const deck = createDeck();
    expect(placeAt(deck, 0, 0, CELL_WEAPON, TOWER_ARC)).toBe(PLACE_OK);
    const cell = cellAt(deck, 0, 0)!;
    expect(cell.level).toBe(1);
    expect(weaponCells(deck)).toBe(1);

    for (let want = 2; want <= TOWER_MAX_LEVEL; want++) {
      const rev = deck.revision;
      expect(canPlace(deck, 0, 0, CELL_WEAPON, TOWER_ARC)).toBe(PLACE_UPGRADE); // 问和放同码
      expect(placeAt(deck, 0, 0, CELL_WEAPON, TOWER_ARC)).toBe(PLACE_UPGRADE);
      expect(cell.level).toBe(want);
      // 升级也是甲板变化:渲染层靠 revision 才知道该重画等级点与射界半径
      expect(deck.revision).toBe(rev + 1);
      // "原格生效不占新格":整块甲板始终只有这一个武器格,别处一个字段都没被写
      expect(weaponCells(deck)).toBe(1);
      expect(cell.towerType).toBe(TOWER_ARC);
      expect(cell.content).toBe(CELL_WEAPON);
    }
  });

  it('满 Lv5 → PLACE_MAX_LEVEL:等级停住、revision 不动、一个字段都没写', () => {
    const deck = createDeck();
    placeAt(deck, 0, 0, CELL_WEAPON, TOWER_AUTOCANNON);
    for (let i = 1; i < TOWER_MAX_LEVEL; i++) placeAt(deck, 0, 0, CELL_WEAPON, TOWER_AUTOCANNON);
    const cell = cellAt(deck, 0, 0)!;
    expect(cell.level).toBe(TOWER_MAX_LEVEL);

    const rev = deck.revision;
    const snapshot = JSON.stringify(deck);
    // 与 TAKEN 分开的理由:玩家该被告知"满级了",而不是"这格有东西"—— 两句话指向的规则不是一条
    expect(canPlace(deck, 0, 0, CELL_WEAPON, TOWER_AUTOCANNON)).toBe(PLACE_MAX_LEVEL);
    expect(placeAt(deck, 0, 0, CELL_WEAPON, TOWER_AUTOCANNON)).toBe(PLACE_MAX_LEVEL);
    expect(cell.level).toBe(TOWER_MAX_LEVEL);
    expect(deck.revision).toBe(rev);
    expect(JSON.stringify(deck)).toBe(snapshot);
  });

  it('升级不重置运行期状态:弹夹/热量/充能/冷却/装填/过热锁/炮管一概不动', () => {
    const deck = createDeck();
    placeAt(deck, 0, 0, CELL_WEAPON, TOWER_AUTOCANNON);
    const cell = cellAt(deck, 0, 0)!;
    // 手写一组"打了大半个弹夹、正装填、还热着、蓄了一半、炮管偏着"的中间态:升级不该把它抹平
    cell.ammo = 3;
    cell.cooldown = 0.17;
    cell.reloadLeft = 0.42;
    cell.heat = 9;
    cell.coolLock = 1.1;
    cell.charge = 0.6;
    cell.turretOffset = 0.3;

    expect(placeAt(deck, 0, 0, CELL_WEAPON, TOWER_AUTOCANNON)).toBe(PLACE_UPGRADE);
    expect(cell.level).toBe(2);
    // 不白送一个满弹夹:否则玩家会掐着弹夹见底那一刻去升级,把成长变成操作技巧
    expect(cell.ammo).toBe(3);
    expect(cell.cooldown).toBe(0.17);
    expect(cell.reloadLeft).toBe(0.42);
    expect(cell.heat).toBe(9);
    expect(cell.coolLock).toBe(1.1);
    expect(cell.charge).toBe(0.6);
    // 升级不是"重放一座塔":炮管还指着原处,不会当帧啪地归位
    expect(cell.turretOffset).toBe(0.3);

    // 派生上限当帧起按新等级算,旧余量天然合法(ammo ≤ 旧上限 ≤ 新上限),故不必补一次夹取
    const def = TOWERS[TOWER_AUTOCANNON]!;
    expect(towerMagazine(def, 2)).toBeGreaterThan(towerMagazine(def, 1));
    expect(cell.ammo).toBeLessThanOrEqual(towerMagazine(def, 2));
  });

  it('换塔型仍是 PLACE_TAKEN:另外五型挨个试一遍,等级与塔型一动不动', () => {
    const deck = createDeck();
    placeAt(deck, 0, 0, CELL_WEAPON, TOWER_LASER);
    placeAt(deck, 0, 0, CELL_WEAPON, TOWER_LASER); // 先升到 Lv2,"被拒时等级不动"才有话可说
    const cell = cellAt(deck, 0, 0)!;
    const rev = deck.revision;

    for (let t = 0; t < TOWER_KIND_COUNT; t++) {
      if (t === TOWER_LASER) continue;
      // 换塔型 = 出售 + 重放,GDD §4.5 明令不许;它也不是"叠级失败",故不是 MAX_LEVEL
      expect(canPlace(deck, 0, 0, CELL_WEAPON, t)).toBe(PLACE_TAKEN);
      expect(placeAt(deck, 0, 0, CELL_WEAPON, t)).toBe(PLACE_TAKEN);
    }
    expect(cell.towerType).toBe(TOWER_LASER);
    expect(cell.level).toBe(2);
    expect(deck.revision).toBe(rev);
  });

  it('离线塔也能升:焊成内脏位之后照样叠得动(它只是不开火,不是不存在)', () => {
    const deck = deckFrom(['.#.', '.#.', '.#.']);
    expect(placeAt(deck, 1, 1, CELL_WEAPON, TOWER_PD)).toBe(PLACE_OK);
    const mid = cellAt(deck, 1, 1)!;

    setOccupied(deck, 0, 1, true); // 两舷各焊一块:炮位变内脏位
    setOccupied(deck, 2, 1, true);
    expect(isInteriorCell(mid)).toBe(true);
    expect(mid.online).toBe(false);

    // 判定顺序上"格已占"排在 INTERIOR 之前,所以离线塔仍然叠得动
    expect(canPlace(deck, 1, 1, CELL_WEAPON, TOWER_PD)).toBe(PLACE_UPGRADE);
    expect(placeAt(deck, 1, 1, CELL_WEAPON, TOWER_PD)).toBe(PLACE_UPGRADE);
    expect(mid.level).toBe(2);
    expect(mid.online).toBe(false); // 升级不改在线状态:它还是那个四面被围的内脏位
    // 而这一格早已不收**新**塔:换个塔型照旧 TAKEN,空的内部格照旧 INTERIOR
    expect(canPlace(deck, 1, 1, CELL_WEAPON, TOWER_ARC)).toBe(PLACE_TAKEN);
    expect(canPlace(createDeck(), 1, 1, CELL_WEAPON, TOWER_PD)).toBe(PLACE_INTERIOR);
  });

  it('塔型非法 → PLACE_BAD_TOWER,且判在"问格"之前;支援设施不看塔型', () => {
    const deck = createDeck();
    for (const bad of [-1, TOWER_KIND_COUNT, 99, 1.5, NaN]) {
      expect(canPlace(deck, 0, 0, CELL_WEAPON, bad)).toBe(PLACE_BAD_TOWER);
      // 塔型错了就是塔型错了:顺手点到界外也不改口报 NO_CELL(理由码的语义靠判定顺序才唯一)
      expect(canPlace(deck, 99, 99, CELL_WEAPON, bad)).toBe(PLACE_BAD_TOWER);
      expect(placeAt(deck, 0, 0, CELL_WEAPON, bad)).toBe(PLACE_BAD_TOWER);
    }
    // 内容不合法时仍先报内容:BAD_CONTENT 还是最外面那一道
    expect(canPlace(deck, 0, 0, CELL_EMPTY, 99)).toBe(PLACE_BAD_CONTENT);
    // 支援设施压根没有塔型这回事,传什么都不该拦(06 号的设施型号是另一套字段)
    expect(canPlace(deck, 1, 1, CELL_SUPPORT, 99)).toBe(PLACE_OK);

    expect(deck.revision).toBe(0); // 上面全是拒绝:一格都没落子
    expect(deck.cells.every((c) => c.content === CELL_EMPTY)).toBe(true);
  });

  it('塔型缺省 = 自动机炮:三参调用方语义原样成立,再放一次就是升级', () => {
    const deck = createDeck();
    // 04 号那批只关心几何的用例全是三参调用,默认成万金油(GDD §5.2)它们才不用逐处补参数
    expect(placeAt(deck, 0, 0, CELL_WEAPON)).toBe(PLACE_OK);
    expect(cellAt(deck, 0, 0)!.towerType).toBe(TOWER_AUTOCANNON);
    expect(placeAt(deck, 0, 0, CELL_WEAPON)).toBe(PLACE_UPGRADE);
    expect(cellAt(deck, 0, 0)!.level).toBe(2);
  });

  it('isPlaceSuccess:只有 PLACE_OK 与 PLACE_UPGRADE 算成功,九个理由码互不撞号', () => {
    expect(isPlaceSuccess(PLACE_OK)).toBe(true);
    expect(isPlaceSuccess(PLACE_UPGRADE)).toBe(true); // 漏了这一个,升级就会被 ui 当成拒绝弹红字
    const rejects = [
      PLACE_NO_CELL,
      PLACE_TAKEN,
      PLACE_INTERIOR,
      PLACE_BAD_CONTENT,
      PLACE_MAX_LEVEL,
      PLACE_BAD_TOWER,
      // 06 号新增的那一半:设施型非法。isPlaceSuccess 不认它 —— 型号填错时若被当成成功,
      // placeAt 会把一个查不到的下标写进 supportType,此后每一处 SUPPORTS[...] 都静默取到 undefined
      PLACE_BAD_SUPPORT,
    ];
    for (const code of rejects) expect(isPlaceSuccess(code)).toBe(false);

    // ui 靠码分支说人话,撞号就会指错规则(玩家看到的解释与真正被拦的原因对不上)
    const codes = [PLACE_OK, PLACE_UPGRADE, ...rejects];
    expect(new Set(codes).size).toBe(codes.length);
  });
});

/**
 * 正交四邻(06 号 issue T1-a)。neighborCell 是**全仓唯一一份**四邻偏移:
 * 暴露边推导、06 号的邻接配对、12 号的非矩形甲板都从这一个函数取邻居 ——
 * 于是"斜角不算相邻""洞不算邻居"这两条规则只有一处实现,不必在每个调用点各判一遍。
 * 最后一条把它与 exposed 掩码的互补关系钉死:那正是"recomputeDeck 复用了它"的可观察证据。
 */
describe('neighborCell:正交四邻的唯一出口', () => {
  it('四个方向各取到对应的邻格,与"边下标 ↔ 邻格方向"那张表一致', () => {
    const deck = createDeck();
    for (const c of deck.cells) {
      for (let e = 0; e < EDGE_COUNT; e++) {
        const step = NEIGHBOR[e]!;
        expect(neighborCell(deck, c, e)).toBe(cellAt(deck, c.col + step.dCol, c.row + step.dRow));
      }
    }
  });

  it('洞与船体外是一回事:越界与 !occupied 一律 undefined', () => {
    const donut = deckFrom(['###', '#.#', '###']);
    const bow = cellAt(donut, 1, 0)!;
    expect(neighborCell(donut, bow, EDGE_BOW)).toBeUndefined(); // 船体外
    // 洞给的是**同一个**答案 —— 06 号的"洞不算邻居"因此不必在 support.ts 里再判一次 occupied
    expect(neighborCell(donut, bow, EDGE_STERN)).toBeUndefined();
    expect(neighborCell(donut, bow, EDGE_PORT)).toBe(cellAt(donut, 0, 0));
    expect(neighborCell(donut, bow, EDGE_STARBOARD)).toBe(cellAt(donut, 2, 0));
  });

  it('斜角永远进不来;越界的边下标给 undefined 而不是崩', () => {
    const deck = createDeck();
    const c = cellAt(deck, 1, 1)!;
    // "正交四邻判定"的字面实现:四个方向里没有任何一个是斜对角
    const diagonals = [
      cellAt(deck, 0, 0),
      cellAt(deck, 2, 0),
      cellAt(deck, 0, 2),
      cellAt(deck, 2, 2),
    ];
    for (let e = 0; e < EDGE_COUNT; e++) expect(diagonals).not.toContain(neighborCell(deck, c, e));
    // 只有四个 EDGE_* 偏移,没有第五个:传进来一个越界的边下标该得到"没有那个邻居",
    // 而不是拿 NaN 坐标去查表(那时炸的地方离现场十万八千里)
    for (const bad of [-1, EDGE_COUNT, 99, 1.5, NaN]) {
      expect(neighborCell(deck, c, bad)).toBeUndefined();
    }
  });

  it('与 exposed 掩码严格互补 —— recomputeDeck 走的就是它,不是另抄一份偏移', () => {
    const decks = [
      createDeck(),
      deckFrom(['#.#', '###', '#.#']),
      createDeck(1, 4),
      createDeck(1, 1),
    ];
    for (const deck of decks) {
      for (const c of deck.cells) {
        if (!c.occupied) continue;
        for (let e = 0; e < EDGE_COUNT; e++) {
          // 暴露 ⇔ 那个方向没有邻居。两边哪天走散,12 号的异形甲板会先在这里红
          expect(isEdgeExposed(c, e)).toBe(neighborCell(deck, c, e) === undefined);
        }
      }
    }
  });
});

/**
 * 支援设施的型号与邻接加成缓存(06 号 issue T1-a,GDD §5.3)。
 * 本文件只钉**甲板这一侧** —— 谁跟谁配对、四个倍率怎么连乘在 sim/support.ts,不在这里
 * (甲板不认识"协同"这个概念,它只是那几个字段的房东)。钉的几条:
 *   设施型与塔型是**两套编号**,各有一个校验、一个理由码,第 4/5 参互不干涉;
 *   非支援格恒 supportType -1 —— 0 是弹药库,拿它当"没有设施"会让 damage.ts 给全船凭空加满血;
 *   四个倍率的中性值是 **1 不是 0**:0 作倍率是把塔抹死,与"这一格没有加成"是两码事;
 *   拆格(12 号)要把这五个字段一并清干净,否则"拆了再焊"会继承上一轮的设施与加成;
 *   **设施本轮不叠级**:往已占的设施格再放一律 TAKEN(GDD §5.3 的四种设施没有等级档)。
 */
describe('支援设施型号与邻接加成缓存(06 号 GDD §5.3)', () => {
  /** 四个邻接倍率的当前读数,整组一起断言:漏检其中一个的话,漏清那一个也就永远看不见 */
  const muls = (cell: DeckCell): number[] => [
    cell.fireRateMul,
    cell.reloadMul,
    cell.heatMaxMul,
    cell.chargeRateMul,
  ];

  it('建格一次性给齐初值:supportType -1、四个倍率 1、buffRevision -1', () => {
    const deck = createDeck();
    // 缓存脏标记起手必须与 revision(0)**不等**:填 0 等于开局就宣称"算过了",
    // 于是第一次重算永远不发生 —— 空甲板上看不出来,12 号从带设施的甲板起手时是整局没加成
    expect(deck.revision).toBe(0);
    expect(deck.buffRevision).toBe(-1);
    expect(deck.buffRevision).not.toBe(deck.revision);
    for (const c of deck.cells) {
      expect(c.supportType).toBe(-1);
      // 复位值是 1 不是 0:填 0 的话每座塔一进场就是"射速 0、热上限 0",永远打不出下一发
      expect(muls(c)).toEqual([1, 1, 1, 1]);
    }
  });

  it('放设施:第 5 参写进 supportType,塔的字段与 buff 缓存一个都不碰', () => {
    const deck = createDeck();
    expect(placeAt(deck, 1, 1, CELL_SUPPORT, TOWER_AUTOCANNON, SUP_ARMOR_BAY)).toBe(PLACE_OK);

    const cell = cellAt(deck, 1, 1)!;
    expect(cell.content).toBe(CELL_SUPPORT);
    expect(cell.supportType).toBe(SUP_ARMOR_BAY);
    // 设施不是"另一种塔":它没有塔型、没有等级,更没有节流状态
    expect(cell.towerType).toBe(-1);
    expect(cell.level).toBe(0);
    // 四个倍率是 sim/support.ts 的派生量,放置这一步一个字都不写(重算由 revision++ 去触发)
    expect(muls(cell)).toEqual([1, 1, 1, 1]);
    expect(deck.revision).toBe(1);
  });

  it('设施型缺省 = 弹药库(GDD §4.3"弹药库先行",与 world.place / ui 的默认值同一个)', () => {
    const deck = createDeck();
    // 漏传第 5 参时放下去的,得正是 MVP 唯一验过的那一种 —— 三处默认值分家的话,
    // 提示条说的与真放下去的会是两种设施
    expect(placeAt(deck, 1, 1, CELL_SUPPORT)).toBe(PLACE_OK);
    expect(cellAt(deck, 1, 1)!.supportType).toBe(SUP_AMMO_BAY);
  });

  it('四种设施逐个放得下,型号一一落到对应的格上(表里加第五种,这条自动跟上)', () => {
    const deck = createDeck(SUPPORT_KIND_COUNT, 1); // 一行 N 格,一格一种
    for (let t = 0; t < SUPPORT_KIND_COUNT; t++) {
      expect(placeAt(deck, t, 0, CELL_SUPPORT, TOWER_AUTOCANNON, t)).toBe(PLACE_OK);
      expect(cellAt(deck, t, 0)!.supportType).toBe(t);
    }
  });

  it('非支援格恒 supportType -1:武器格显式写回 -1,空格从建格起就是 -1', () => {
    const deck = createDeck();
    expect(placeAt(deck, 1, 1, CELL_SUPPORT, TOWER_AUTOCANNON, SUP_RADIATOR)).toBe(PLACE_OK);
    expect(placeAt(deck, 0, 0, CELL_WEAPON, TOWER_LASER)).toBe(PLACE_OK);
    for (const c of deck.cells) {
      if (c.content === CELL_SUPPORT) continue;
      // 0 是弹药库:拿它当"没有设施",hullMaxHp 会把满甲板的空格全算成 +15 点 HP
      expect(c.supportType).toBe(-1);
    }
    expect(cellAt(deck, 1, 1)!.supportType).toBe(SUP_RADIATOR); // 上一条不是"都是 -1"的空过
  });

  it('拆掉的格把设施与四个倍率一并清干净(否则"拆了再焊"会继承上一轮的加成)', () => {
    const deck = createDeck();
    expect(placeAt(deck, 0, 0, CELL_SUPPORT, TOWER_AUTOCANNON, SUP_ARMOR_BAY)).toBe(PLACE_OK);
    const cell = cellAt(deck, 0, 0)!;
    // 手写一组"邻居给过加成"的读数:重算是 sim/support.ts 的活,这里只验甲板那一处清理
    cell.fireRateMul = 1.25;
    cell.reloadMul = 0.7;
    cell.heatMaxMul = 1.5;
    cell.chargeRateMul = 1.3;

    setOccupied(deck, 0, 0, false);
    expect(cell.content).toBe(CELL_EMPTY);
    // 漏清 supportType,拆掉的装甲舱还在给全船加着 15 点 HP(hullMaxHp 只认这一个字段)
    expect(cell.supportType).toBe(-1);
    // 复位成 1 而不是 0:焊回来的新塔要的是"没有加成",不是"射速被抹成 0"
    expect(muls(cell)).toEqual([1, 1, 1, 1]);

    // 焊回来再放一座塔:上一轮的痕迹一点都不该继承
    setOccupied(deck, 0, 0, true);
    expect(placeAt(deck, 0, 0, CELL_WEAPON, TOWER_AUTOCANNON)).toBe(PLACE_OK);
    expect(cell.supportType).toBe(-1);
    expect(muls(cell)).toEqual([1, 1, 1, 1]);
  });

  it('设施不叠级:往已有设施的格上再放一律 PLACE_TAKEN(GDD §5.3 没有等级档)', () => {
    const deck = createDeck();
    expect(placeAt(deck, 1, 1, CELL_SUPPORT, TOWER_AUTOCANNON, SUP_AMMO_BAY)).toBe(PLACE_OK);
    const cell = cellAt(deck, 1, 1)!;
    const rev = deck.revision;

    // 同型再放一次:塔那边这是 UPGRADE,设施这边不是 —— 给它现编一条成长曲线不是本轮的事
    expect(canPlace(deck, 1, 1, CELL_SUPPORT, TOWER_AUTOCANNON, SUP_AMMO_BAY)).toBe(PLACE_TAKEN);
    expect(placeAt(deck, 1, 1, CELL_SUPPORT, TOWER_AUTOCANNON, SUP_AMMO_BAY)).toBe(PLACE_TAKEN);
    // 换一种设施更不行:那等于"出售 + 重放"(GDD §4.5 明令战斗中不可移动、不可出售)
    expect(placeAt(deck, 1, 1, CELL_SUPPORT, TOWER_AUTOCANNON, SUP_ARMOR_BAY)).toBe(PLACE_TAKEN);

    expect(cell.supportType).toBe(SUP_AMMO_BAY); // 被拒的那几下一个字段都没写进去
    expect(cell.level).toBe(0); // 尤其没有偷偷 +1:设施压根没有等级这回事
    expect(deck.revision).toBe(rev);
  });

  it('设施型非法 → PLACE_BAD_SUPPORT,且判在"问格"之前;两套编号各管各的一半', () => {
    const deck = createDeck();
    for (const bad of [-1, SUPPORT_KIND_COUNT, 99, 1.5, NaN]) {
      expect(canPlace(deck, 1, 1, CELL_SUPPORT, TOWER_AUTOCANNON, bad)).toBe(PLACE_BAD_SUPPORT);
      // 与 BAD_TOWER 同一条口径:型号错了就是型号错了,顺手点到界外也不改口报 NO_CELL
      expect(canPlace(deck, 99, 99, CELL_SUPPORT, TOWER_AUTOCANNON, bad)).toBe(PLACE_BAD_SUPPORT);
      expect(placeAt(deck, 1, 1, CELL_SUPPORT, TOWER_AUTOCANNON, bad)).toBe(PLACE_BAD_SUPPORT);
    }
    // 内容不合法时仍先报内容:BAD_CONTENT 还是最外面那一道
    expect(canPlace(deck, 1, 1, CELL_EMPTY, TOWER_AUTOCANNON, 99)).toBe(PLACE_BAD_CONTENT);
    // 武器塔压根没有设施型这回事,第 5 参传什么都不该拦
    expect(canPlace(deck, 0, 0, CELL_WEAPON, TOWER_AUTOCANNON, 99)).toBe(PLACE_OK);
    // 反过来同理:设施不看塔型 —— 两个型号同时填错时,报的是**这次要放的那种**的码
    expect(canPlace(deck, 0, 0, CELL_WEAPON, 99, 99)).toBe(PLACE_BAD_TOWER);
    expect(canPlace(deck, 1, 1, CELL_SUPPORT, 99, 99)).toBe(PLACE_BAD_SUPPORT);

    expect(deck.revision).toBe(0); // 上面全是拒绝:一格都没落子
    expect(deck.cells.every((c) => c.content === CELL_EMPTY)).toBe(true);
    expect(deck.cells.every((c) => c.supportType === -1)).toBe(true);

    // 已占的格上填错型号,报的还是型号错:BAD_SUPPORT 判在"问格"之前,TAKEN 在之后 ——
    // 一句"格子已被占用"会把玩家的注意力引到完全无关的规则上
    expect(placeAt(deck, 1, 1, CELL_SUPPORT)).toBe(PLACE_OK);
    expect(canPlace(deck, 1, 1, CELL_SUPPORT, TOWER_AUTOCANNON, 99)).toBe(PLACE_BAD_SUPPORT);
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

  it('cellLocalPos 与 cellIndexAtLocal:12 格往返一致,边界与洞都按同一套拾取口径', () => {
    const deck = createDeck();
    const p = v();
    for (const c of deck.cells) {
      cellLocalPos(deck, c.col, c.row, p);
      expect(cellIndexAtLocal(deck, p.x, p.y)).toBe(cellIndex(deck, c.col, c.row));
    }

    const size = deckCellSize();
    expect(cellIndexAtLocal(deck, 500, 0)).toBe(-1);
    expect(cellIndexAtLocal(deck, 2 * size - 0.01, 0)).toBe(cellIndex(deck, 1, 0));
    expect(cellIndexAtLocal(deck, 2 * size + 0.01, 0)).toBe(-1);
    expect(cellIndexAtLocal(deck, 0, 1.5 * size + 0.01)).toBe(-1);

    const donut = deckFrom([
      '###',
      '#.#',
      '###',
    ]);
    expect(cellIndexAtLocal(donut, 0, 0)).toBe(-1);
  });

  it('cellWorldPos 与 cellIndexAtWorld:12 格往返一致(世界入口复用局部拾取)', () => {
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

describe('甲板拼块焊接(GDD §4.4)', () => {
  it('1×2 / L / 2×2 / T 均可旋转吸附到四条任意外边缘', () => {
    const coord = { col: 0, row: 0 };
    const sideHit = (type: number, rotation: number, col: number, row: number, side: number): boolean => {
      const count = DECK_PIECES[type]!.cells.length / 2;
      for (let i = 0; i < count; i++) {
        deckPieceCellAt(type, rotation, col, row, i, coord);
        if (side === EDGE_BOW && coord.row === -1 && coord.col >= 0 && coord.col < DECK_COLS) return true;
        if (side === EDGE_STERN && coord.row === DECK_ROWS && coord.col >= 0 && coord.col < DECK_COLS) return true;
        if (side === EDGE_PORT && coord.col === -1 && coord.row >= 0 && coord.row < DECK_ROWS) return true;
        if (side === EDGE_STARBOARD && coord.col === DECK_COLS && coord.row >= 0 && coord.row < DECK_ROWS) return true;
      }
      return false;
    };

    for (const def of DECK_PIECES) {
      for (const side of [EDGE_BOW, EDGE_STARBOARD, EDGE_STERN, EDGE_PORT]) {
        const deck = createDeck();
        let found = false;
        for (let rotation = 0; rotation < 4 && !found; rotation++) {
          for (let row = -5; row <= 8 && !found; row++) {
            for (let col = -5; col <= 7 && !found; col++) {
              if (canWeldPiece(deck, def.type, rotation, col, row) !== WELD_OK) continue;
              found = sideHit(def.type, rotation, col, row, side);
            }
          }
        }
        expect(found, `${def.name} 无法吸附 edge=${side}`).toBe(true);
      }
    }
  });

  it('非法重叠/悬空是原子的:bounds、格对象内容与 revision 一个字段都不动', () => {
    const deck = createDeck();
    const before = JSON.stringify(deck);
    expect(weldPiece(deck, DECK_PIECE_SQUARE, 0, 0, 0)).toBe(WELD_OVERLAP);
    expect(JSON.stringify(deck)).toBe(before);
    expect(weldPiece(deck, DECK_PIECE_SQUARE, 0, 20, 20)).toBe(WELD_DETACHED);
    expect(JSON.stringify(deck)).toBe(before);
  });

  it('向船头/左舷扩容不移动任何起始格的船体局部坐标', () => {
    const deck = createDeck();
    const before = new Map<string, Vec2>();
    for (let row = 0; row < DECK_ROWS; row++) {
      for (let col = 0; col < DECK_COLS; col++) {
        before.set(`${col},${row}`, { ...cellLocalPos(deck, col, row, v()) });
      }
    }
    expect(weldPiece(deck, DECK_PIECE_SQUARE, 0, -2, 1)).toBe(WELD_OK);
    expect(deck.minCol).toBe(-2);
    for (const [key, p] of before) {
      const [col, row] = key.split(',').map(Number);
      expect(cellLocalPos(deck, col!, row!, v())).toEqual(p);
    }
  });

  it('故意用 2×2 围死左舷塔:确认当帧 online=false、射界来源 exposed 清零', () => {
    const deck = createDeck();
    expect(placeAt(deck, 0, 1, CELL_WEAPON, TOWER_AUTOCANNON)).toBe(PLACE_OK);
    const tower = cellAt(deck, 0, 1)!;
    expect(tower.online).toBe(true);
    expect(tower.exposed).toBe(bit(EDGE_PORT));

    expect(weldPiece(deck, DECK_PIECE_SQUARE, 0, -2, 1)).toBe(WELD_OK);
    expect(tower.exposed).toBe(0);
    expect(tower.exposedCount).toBe(0);
    expect(tower.online).toBe(false);
  });

  it('新焊的非矩形格可由局部坐标精确拾取，凹口/空白仍返回 -1', () => {
    const deck = createDeck();
    expect(weldPiece(deck, DECK_PIECE_SQUARE, 0, -2, 1)).toBe(WELD_OK);
    const p = cellLocalPos(deck, -2, 1, v());
    const i = cellIndexAtLocal(deck, p.x, p.y);
    expect(i).toBe(cellIndex(deck, -2, 1));
    expect(deck.cells[i]!.occupied).toBe(true);

    const empty = cellLocalPos(deck, -2, 0, v());
    expect(cellIndexAtLocal(deck, empty.x, empty.y)).toBe(-1);
    const grid = { col: 0, row: 0 };
    deckGridAtLocal(deck, empty.x, empty.y, grid);
    expect(grid).toEqual({ col: -2, row: 0 });
  });

  it('每个新增占用格精确扣 1°/s，基础 tuning 改动仍即时生效', () => {
    const deck = createDeck();
    const base = tuning.shipTurnRate;
    expect(deckTurnRate(deck)).toBe(base);
    expect(isWeldSuccess(weldPiece(deck, DECK_PIECE_SQUARE, 0, -2, 1))).toBe(true);
    expect(deckTurnRate(deck)).toBe(base - 4);
    tuning.shipTurnRate = base + 10;
    expect(deckTurnRate(deck)).toBe(base + 6);
    tuning.shipTurnRate = base;
  });
});
