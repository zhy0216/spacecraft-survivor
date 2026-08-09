/**
 * 空间进化判定与原子写入(17 号 issue,sim 侧)。本文件在 Node 里跑通本身就是铁律 1 的一层验证:
 * "哪座满级塔 + 哪块相邻支援 → 哪种进化塔"只依赖甲板这个纯对象与三张数值表,零 rng ——
 * 同一块甲板问一百遍答案都一样(17 号验收"配方不满足时绝不触发"的那条线就住在 findEvolutionPairs 里)。
 *
 * 钉的几条口径(改坏就等于改坏了 17 号的验收标准):
 *   **判据 = 空间关系**——只看 Lv5(TOWER_MAX_LEVEL)与正交四邻的支援型号;
 *     斜角/隔洞一律不算邻居(与 supportLinks 共用 neighborCell 这同一份四邻规则);
 *     支援换成别的型号、塔未满级 → 不检出一对、evolveAt 拒绝;
 *   **全收集、顺序确定**——塔按 cells 的 row-major、每塔按 EDGE_* 升序,同 seed 两世界逐对相同;
 *   **零 rng 纯函数**——不碰 deck 一个字段、残留缓冲被清空、返回的就是调用方那块 out;
 *   **原子性**——evolveAt 失败时一个字段都不动、revision 不 bump;成功只 bump 一次;
 *   **等级承接**——塔型替换、level 原样留下满级 5,运行期节流状态随模块保留(仿 moveModule);
 *   **不可逆**——配方表只有 base → result 单向边,进化塔之间没有配方,
 *     placeAt 回原塔型恒 PLACE_TAKEN(与"塔不可出售"同口径);
 *   **不是规则的例外**——进化后的塔继续吃邻接,被 12 号包成内部格照样离线(03 号 online 状态机)。
 *
 * 结果塔型一律从 data/evolutions 现读、绝不抄字面量:改配方表即可调平衡,测试不用回头改。
 */
import { describe, expect, it } from 'vitest';
import { evolutionOf } from '../data/evolutions';
import { SUP_AMMO_BAY, SUP_CAPACITOR, SUP_RADIATOR, SUPPORTS } from '../data/supports';
import {
  TOWER_AUTOCANNON,
  TOWER_GATLING,
  TOWER_LASER,
  TOWER_MAX_LEVEL,
  TOWER_RAILGUN,
} from '../data/towers';
import {
  CELL_EMPTY,
  CELL_SUPPORT,
  CELL_WEAPON,
  cellAt,
  createDeck,
  type Deck,
  evolveAt,
  EVOLVE_BAD_SUPPORT,
  EVOLVE_BAD_TARGET,
  EVOLVE_NO_RECIPE,
  EVOLVE_NOT_MAX_LEVEL,
  EVOLVE_OK,
  isPlaceSuccess,
  placeAt,
  PLACE_OK,
  PLACE_TAKEN,
  setOccupied,
} from './deck';
import { findEvolutionPairs } from './evolve';
import { syncSupportBuffs } from './support';

const AMMO = SUPPORTS[SUP_AMMO_BAY]!;

/** 配对表的复用缓冲:findEvolutionPairs 收 out 正是为了这个,单测也照渲染层那样只留一块(铁律 3) */
const buf: number[] = [];

/** 放一座塔并直接塞到满级(叠到 Lv5 要放四次,测试直写等级即可) */
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

/**
 * 用字符画建甲板(与 support.test.ts / deck.test.ts 同一份):一个字符串一行(row 0 最靠船头),
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

/**
 * 配对表读成 '塔格→支援格' 的坐标串。
 * 比一串下标好读也好定位,顺带把两条约定钉死:out[2k] 是满级塔格、out[2k+1] 是被吞噬的支援格;
 * 顺序 = 塔按 cells 的 row-major、每塔按 EDGE_* 升序(确定性口径,金光连线的叠色也靠它不跳)。
 */
function pairs(deck: Deck): string[] {
  const flat = findEvolutionPairs(deck, buf);
  const list: string[] = [];
  for (let k = 0; k + 1 < flat.length; k += 2) {
    const a = deck.cells[flat[k]!]!;
    const b = deck.cells[flat[k + 1]!]!;
    list.push(`${a.col},${a.row}→${b.col},${b.row}`);
  }
  return list;
}

describe('findEvolutionPairs:满级塔 + 正交相邻指定支援', () => {
  it('配方满足:机炮 Lv5 + 相邻弹药库 → 检出该对,结果塔型取配方表', () => {
    const deck = createDeck();
    lv5Tower(deck, 1, 0, TOWER_AUTOCANNON);
    support(deck, 1, 1, SUP_AMMO_BAY);
    expect(pairs(deck)).toEqual(['1,0→1,1']);
    // 结果塔型从表里现读,不抄字面量;顺带钉住"配方存在"这件事本身
    expect(evolutionOf(TOWER_AUTOCANNON, SUP_AMMO_BAY)).toBe(TOWER_GATLING);
  });

  it('配方不满足绝不触发:支援换成别的型号,同一位置同一布局就是不给', () => {
    const deck = createDeck();
    lv5Tower(deck, 1, 0, TOWER_AUTOCANNON);
    support(deck, 0, 0, SUP_RADIATOR); // 与弹药库同一个正交位,只是型号不对
    expect(pairs(deck)).toEqual([]);
    expect(evolutionOf(TOWER_AUTOCANNON, SUP_RADIATOR)).toBe(-1); // 表里确实没有这条边
    expect(evolveAt(deck, 1, 0, 0, 0)).toBe(EVOLVE_NO_RECIPE);
    expect(cellAt(deck, 1, 0)!.towerType).toBe(TOWER_AUTOCANNON); // 一个字都没动

    // 换一个正交位补上弹药库:当场出现配对 —— 上面的"不触发"是型号的锅,不是位置的锅
    support(deck, 1, 1, SUP_AMMO_BAY);
    expect(pairs(deck)).toEqual(['1,0→1,1']);
  });

  it('未满级绝不触发:等级是唯一闸门(Lv4 与 Lv5 只差一级,配对差一个都没有)', () => {
    const deck = createDeck();
    lv5Tower(deck, 1, 0, TOWER_AUTOCANNON);
    support(deck, 1, 1, SUP_AMMO_BAY);
    cellAt(deck, 1, 0)!.level = TOWER_MAX_LEVEL - 1;
    expect(pairs(deck)).toEqual([]);
    expect(evolveAt(deck, 1, 0, 1, 1)).toBe(EVOLVE_NOT_MAX_LEVEL);
    expect(cellAt(deck, 1, 0)!.towerType).toBe(TOWER_AUTOCANNON);
    expect(cellAt(deck, 1, 1)!.supportType).toBe(SUP_AMMO_BAY); // 支援格也没被动
  });

  it('斜角与隔洞不算邻居:正交贴边才触发(与 supportLinks 同一份四邻规则)', () => {
    const deck = deckFrom([
      '###', //
      '#.#',
      '###',
    ]);
    lv5Tower(deck, 1, 2, TOWER_AUTOCANNON);
    support(deck, 0, 1, SUP_AMMO_BAY); // 斜角,且与塔之间隔着洞
    expect(pairs(deck)).toEqual([]);
    // 12 号把洞焊上:斜角仍是斜角,依旧不触发
    setOccupied(deck, 1, 1, true);
    expect(pairs(deck)).toEqual([]);
    // 同一格的正交位补一块:当场出现配对 —— 上面不是"型号不对",是位置不对
    support(deck, 1, 1, SUP_AMMO_BAY);
    expect(pairs(deck)).toEqual(['1,2→1,1']);
  });

  it('多对并存全收集:一座塔被多块同型支援围着、多座塔各配各的,一对不漏、顺序确定', () => {
    const deck = createDeck();
    // 机炮 (1,0):左右两舷各一块弹药库 → 两对;EDGE_* 升序 = 右舷先于左舷
    lv5Tower(deck, 1, 0, TOWER_AUTOCANNON);
    support(deck, 0, 0, SUP_AMMO_BAY);
    support(deck, 2, 0, SUP_AMMO_BAY);
    // 磁轨 (0,1) + 电容组 (1,1):型号不同的一对
    lv5Tower(deck, 0, 1, TOWER_RAILGUN);
    support(deck, 1, 1, SUP_CAPACITOR);
    // 激光 (1,3) + 散热器 (0,3):再一对
    lv5Tower(deck, 1, 3, TOWER_LASER);
    support(deck, 0, 3, SUP_RADIATOR);

    expect(pairs(deck)).toEqual([
      '1,0→2,0',
      '1,0→0,0',
      '0,1→1,1',
      '1,3→0,3',
    ]);
    expect(evolutionOf(TOWER_RAILGUN, SUP_CAPACITOR)).not.toBe(-1);
    expect(evolutionOf(TOWER_LASER, SUP_RADIATOR)).not.toBe(-1);
  });

  it('零 rng 纯函数:同一块甲板问一百遍答案一致,甲板一个字段不动,残留缓冲被清空', () => {
    const deck = createDeck();
    lv5Tower(deck, 1, 0, TOWER_AUTOCANNON);
    support(deck, 0, 0, SUP_AMMO_BAY);
    const snapshot = JSON.stringify(deck);
    const first = pairs(deck);
    for (let i = 0; i < 100; i++) expect(pairs(deck)).toEqual(first);
    expect(JSON.stringify(deck)).toBe(snapshot);

    const dirty: number[] = [7, 7, 7]; // 上一次留下的残留:没有配对的甲板必须把它清干净
    expect(findEvolutionPairs(createDeck(), dirty)).toBe(dirty); // 返回的就是调用方那块 out
    expect(dirty).toEqual([]);
  });
});

describe('evolveAt:原子进化写入', () => {
  it('成功:支援格清空释放、塔型替换为配方结果、等级承接满级、revision 只 +1', () => {
    const deck = createDeck();
    lv5Tower(deck, 1, 0, TOWER_AUTOCANNON);
    support(deck, 1, 1, SUP_AMMO_BAY);
    const tower = cellAt(deck, 1, 0)!;
    tower.ammo = 3; // 运行期节流状态随模块走(仿 moveModule 的口径)
    const rev = deck.revision;

    expect(evolveAt(deck, 1, 0, 1, 1)).toBe(EVOLVE_OK);
    expect(tower.towerType).toBe(TOWER_GATLING);
    expect(tower.level).toBe(TOWER_MAX_LEVEL); // 等级承接,不重置
    expect(tower.ammo).toBe(3); // 节流状态也不重置

    const freed = cellAt(deck, 1, 1)!;
    expect(freed.content).toBe(CELL_EMPTY);
    expect(freed.supportType).toBe(-1);
    expect(freed.level).toBe(0);
    expect(freed.occupied).toBe(true); // 只是腾空,不是拆掉甲板
    expect(deck.revision).toBe(rev + 1);
    expect(placeAt(deck, 1, 1, CELL_SUPPORT, TOWER_AUTOCANNON, SUP_RADIATOR)).toBe(PLACE_OK);
  });

  it('失败一律原子拒绝:五种理由一个字段都不动,revision 不 bump', () => {
    const deck = createDeck();
    lv5Tower(deck, 1, 0, TOWER_AUTOCANNON);
    support(deck, 1, 1, SUP_AMMO_BAY);
    support(deck, 0, 0, SUP_RADIATOR);
    const snapshot = JSON.stringify(deck);
    const rev = deck.revision;

    expect(evolveAt(deck, 9, 9, 1, 1)).toBe(EVOLVE_BAD_TARGET); // 塔格不存在
    expect(evolveAt(deck, 1, 1, 1, 0)).toBe(EVOLVE_BAD_TARGET); // 塔格不是武器塔
    expect(evolveAt(deck, 1, 0, 9, 9)).toBe(EVOLVE_BAD_SUPPORT); // 支援格不存在
    expect(evolveAt(deck, 1, 0, 1, 0)).toBe(EVOLVE_BAD_SUPPORT); // 支援格就是塔自己(同格)
    expect(evolveAt(deck, 1, 0, 0, 0)).toBe(EVOLVE_NO_RECIPE); // 散热器:型号不匹配
    expect(JSON.stringify(deck)).toBe(snapshot);
    expect(deck.revision).toBe(rev);
  });

  it('不可逆:进化塔之间没有配方,placeAt 回原塔型恒 PLACE_TAKEN(与塔不可出售同口径)', () => {
    const deck = createDeck();
    lv5Tower(deck, 1, 0, TOWER_AUTOCANNON);
    support(deck, 1, 1, SUP_AMMO_BAY);
    expect(evolveAt(deck, 1, 0, 1, 1)).toBe(EVOLVE_OK);
    expect(cellAt(deck, 1, 0)!.towerType).toBe(TOWER_GATLING);

    // 另一块弹药库紧挨着新塔:配方表里没有以进化塔为 base 的边,再来一次恒 NO_RECIPE
    support(deck, 0, 0, SUP_AMMO_BAY);
    expect(pairs(deck)).toEqual([]);
    expect(evolveAt(deck, 1, 0, 0, 0)).toBe(EVOLVE_NO_RECIPE);

    // 换回原塔型 = 换塔型,不是同名叠级 → 恒 PLACE_TAKEN
    expect(placeAt(deck, 1, 0, CELL_WEAPON, TOWER_AUTOCANNON)).toBe(PLACE_TAKEN);
    expect(cellAt(deck, 1, 0)!.towerType).toBe(TOWER_GATLING);
  });

  it('进化塔继续吃邻接;被包成内部格照样离线(03 号 online 状态机不豁免)', () => {
    const deck = deckFrom([
      '###', //
      '##.',
      '###',
    ]);
    lv5Tower(deck, 1, 1, TOWER_AUTOCANNON);
    support(deck, 0, 1, SUP_AMMO_BAY); // 将被吞噬
    support(deck, 1, 0, SUP_AMMO_BAY); // 幸存:进化只撤被吃的那条线
    expect(pairs(deck)).toEqual(['1,1→1,0', '1,1→0,1']);
    expect(evolveAt(deck, 1, 1, 0, 1)).toBe(EVOLVE_OK);

    const tower = cellAt(deck, 1, 1)!;
    expect(tower.towerType).toBe(TOWER_GATLING);
    // 塔型换了,但这一格还是边缘格:幸存的那块弹药库(同系节流)照常连上
    syncSupportBuffs(deck);
    expect(tower.online).toBe(true);
    expect(tower.fireRateMul).toBe(AMMO.fireRateMul);
    // 但配对表一片空白:加特林已是配方的终点,配方表里没有以进化塔为 base 的边(不可逆的结构面)
    expect(pairs(deck)).toEqual([]);

    // 12 号把洞焊上:四面被围 → 离线(进化的塔不是规则的例外)
    setOccupied(deck, 2, 1, true);
    expect(tower.online).toBe(false);
    expect(tower.towerType).toBe(TOWER_GATLING); // 塔还在,只是灰显不开火
    expect(pairs(deck)).toEqual([]);
  });
});
