/**
 * 炮管推进与开火(04 号 issue T2 + 05 号 issue T3)。本文件在 Node 里跑通本身就是铁律 1 的一层验证:
 * "塔朝哪、打出了什么"只由甲板 + 船位姿 + 空间哈希决定,不需要 Pixi,也不需要一整个 World。
 *
 * 钉的几条口径(改坏就等于改坏了 04/05 的任务描述):
 *   射界内有目标 → 炮口追它的方位,但**每帧最多转 def.turnRate × dt**(平滑,不是瞬时);
 *   射界内没目标(空 / 射程外 / 射界外 / 已死)→ **归位**:offset 单调回到 0 且不过冲;
 *   目标过滤逐塔各按自己的射界算 —— 左舷塔不会去追右舷的敌人;
 *   性能口径也在这里钉死:没有在线武器塔就一次哈希都不查,有塔则**每帧只查一次**、全塔共享,
 *     半径按**全甲板最大射程**算(否则射得最远的那座塔会瞎一圈);
 *     链跳与磁轨复用同一份候选,一次额外查询都不许有;
 *   离线塔(12 号扩建把炮位焊成内脏位)offset **与节流一起冻结**,恢复在线后从冻结值继续;
 *   sink = null 只追瞄不开火;**炮口没对准(超出 def.aimTolDeg)一律不开火** ——
 *     这是"塔转不过来就打不到"(GDD §5.2)的唯一实现;
 *   五种开火表现各自的产物(直射弹 / 抛射弹 / 光束 / 链电 / 穿透线),以及链跳选择的确定性。
 *
 * 参数一律改**数值表**(TOWERS)的字段,跑完 afterEach 逐塔还原:04 号那三项全塔共用的 tuning 占位
 * (turretArcDeg/turretRange/turretTurnRate)已被一塔一档的数值表取代,而"改数据文件即可调平衡、
 * 不改代码"正是 05 验收标准第三条 —— 本文件的夹具就是它的机械形式。
 * 基线转速刻意取 60°/s = 每帧 1°:于是"第 N 帧转过 N°"可以逐帧钉,平滑与否一眼看得出来。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SIM_DT } from '../core/loop';
import { Pool } from '../core/pool';
import { SpatialHash } from '../core/spatialHash';
import { ENEMIES, KIND_SWARM } from '../data/enemies';
import {
  TOWER_ARC,
  TOWER_AUTOCANNON,
  TOWER_LASER,
  TOWER_MORTAR,
  TOWER_RAILGUN,
  type TowerDef,
  towerMagazine,
  TOWERS,
} from '../data/towers';
import { BK_DIRECT, BK_MORTAR, type Bullet, createBullet, resetBullet } from './bullet';
import { tuning } from './config';
import {
  CELL_EMPTY,
  CELL_SUPPORT,
  CELL_WEAPON,
  cellAt,
  createDeck,
  type Deck,
  type DeckCell,
  EDGE_BOW,
  EDGE_COUNT,
  EDGE_PORT,
  isEdgeExposed,
  PLACE_OK,
  PLACE_UPGRADE,
  placeAt,
  setOccupied,
} from './deck';
import { applyDamage, createEnemy, type Enemy } from './enemy';
import { type FireSink, FXV_BEAM, FXV_CHAIN, FXV_LANCE } from './fx';
import { createShip, DEG2RAD, type Ship } from './ship';
import { effectiveAoeDamage, effectiveDamage } from './tower';
import { stepTurrets } from './turret';

const BASE = {
  shipLength: 160, // ÷ 4 行 = 40
  shipWidth: 120, // ÷ 3 列 = 40 —— 两轴同为 40,格边长是整数,断言里的炮位坐标才算得清
  // 全局倍率显式写死(与 tower.test.ts 同口径):M0 反复调平衡时不该把这里的行为断言带崩
  towerDamageScale: 1,
  towerFireRateScale: 1,
  // 受击射速惩罚倍率同理(出货占位是 0.75)。刻意压到 0.5 = 帧距整整翻一倍(24 → 48),
  // 一眼读得出"这座塔顿了";本文件钉的是"惩罚有没有接到 stepTurrets 这条链路上",不是那个占位数本身
  hitFireRateMul: 0.5,
};
Object.assign(tuning, BASE);

/**
 * 数值表的原始快照:每条用例跑完逐塔还原顶层字段,免得一处覆写漏到下一条用例里。
 * 本文件的用例一律不碰 growth 子对象(碰了就得连它一起深还原)。
 */
const SNAPSHOT = TOWERS.map((d) => ({ ...d }));
/**
 * 纯几何用例的基线:弧度 90°(半角 45°)、射程 200、转速 60°/s(@60Hz 正好每帧 1°)。
 * 写进数值表而不是 tuning —— 05 号之后"一塔一档"是唯一口径,全塔共用的那三项已经没有了。
 */
const GUN = { arcDeg: 90, range: 200, turnRate: 60 };
/** 还原 + 重新压上基线:afterEach 与模块加载时走同一条路,免得两处各写一遍 */
function resetTowers(): void {
  TOWERS.forEach((d, i) => Object.assign(d, SNAPSHOT[i]!));
  Object.assign(TOWERS[TOWER_AUTOCANNON]!, GUN);
}
resetTowers();
afterEach(() => {
  Object.assign(tuning, BASE);
  resetTowers();
});

/** 每帧转速上限(度)。断言里反复用到,拿它算而不是写死 1,改了 GUN 也不会悄悄失配 */
const MAX_TURN_DEG = GUN.turnRate * SIM_DT;
/** 甲板外接半径 = hypot(rows, cols) × 格边长 / 2 —— 与被测代码同一条式子,不写死 100 */
const DECK_REACH = (Math.hypot(4, 3) * 40) / 2;

const deg = (rad: number): number => rad / DEG2RAD;

const shipAt = (x: number, y: number, heading: number): Ship => {
  const ship = createShip();
  ship.x = ship.px = x;
  ship.y = ship.py = y;
  ship.heading = ship.pheading = heading;
  return ship;
};

/**
 * 只有位置与生死是索敌看的字段,其余走池 factory 的初值。
 * 血厚到打不死:开火用例关心的是"打出去了什么",不该被"死者不再被瞄、不再吃伤害"那两条顺手影响
 * (要验尸体的用例自己把 dead 置起来,见归位那一组)。
 */
const foe = (x: number, y: number): Enemy => {
  const e = createEnemy();
  e.x = x;
  e.y = y;
  e.hp = e.maxHp = 1e6;
  return e;
};

/** 从炮位按"方位角 + 距离"摆一只敌人:测试里想说的永远是"偏 30°、100 远",不是两个坐标 */
const foeAt = (ox: number, oy: number, bearingDeg: number, dist: number): Enemy =>
  foe(ox + Math.cos(bearingDeg * DEG2RAD) * dist, oy + Math.sin(bearingDeg * DEG2RAD) * dist);

/** @param cellSize 默认 = World 的口径(最大敌半径 ×2,GDD §13) */
const gridOf = (enemies: Enemy[], cellSize = tuning.enemyRadiusMax * 2): SpatialHash<Enemy> => {
  const grid = new SpatialHash<Enemy>(cellSize);
  for (const e of enemies) grid.insert(e);
  return grid;
};

/** @param sink 缺省 null = 只追瞄不开火(04 号那批纯几何用例走的就是这条) */
const run = (
  n: number,
  deck: Deck,
  ship: Ship,
  grid: SpatialHash<Enemy>,
  sink: FireSink | null = null,
): void => {
  for (let i = 0; i < n; i++) stepTurrets(deck, ship, grid, SIM_DT, sink);
};

/**
 * 记账用的哈希:除了数查询次数与记下半径,行为与 SpatialHash 一模一样
 * (不 mock —— 换成假的就等于没测)。"每帧只查一次、半径按全甲板最大射程算"是本轮明文的
 * 性能口径,而它在功能断言里完全看不出来,只能这样钉。
 */
class CountingHash extends SpatialHash<Enemy> {
  queries = 0;
  lastRadius = -1;
  override query(x: number, y: number, r: number, out: Enemy[]): Enemy[] {
    this.queries++;
    this.lastRadius = r;
    return super.query(x, y, r, out);
  }
}

/**
 * 3×4 甲板 + 船头正中一座塔(只有 BOW 一条暴露边 → 射界中心 = 船头),炮位在局部 (60, 0)。
 * @param type 塔型,缺省自动机炮
 * @param fields 这一型要覆写的数值表字段(跑完由 afterEach 统一还原)
 *
 * 无论哪一型都先把几何拧成本文件的基线(GUN):开火用例关心的是"打出去了什么",
 * 六塔各自的射界与射程在 data/towers.test.ts 那边钉,这里不必逐塔换算一遍期望值。
 */
function bowTurret(
  type: number = TOWER_AUTOCANNON,
  fields: Partial<TowerDef> = {},
): { deck: Deck; ship: Ship; cell: DeckCell } {
  Object.assign(TOWERS[type]!, GUN, fields);
  const deck = createDeck();
  expect(placeAt(deck, 1, 0, CELL_WEAPON, type)).toBe(PLACE_OK);
  return { deck, ship: shipAt(0, 0, 0), cell: cellAt(deck, 1, 0)! };
}

const BOW_MUZZLE_X = 60; // ((4-1)/2 - 0) × 40
const BOW_MUZZLE_Y = 0;

/**
 * 3×3 甲板挖掉船头一整行 + 中心格一座塔:同样只有 BOW 一条暴露边,
 * 但**炮位恰好落在船心**(局部 (0,0))—— 于是转船时炮位不动、只有射界在转,
 * 想单独看"射界跟着船转"这一件事时,这个夹具比船头塔干净(那座塔的炮位会跟着一起绕)。
 */
function centerTurret(): { deck: Deck; ship: Ship; cell: DeckCell } {
  const deck = createDeck(3, 3);
  for (let col = 0; col < 3; col++) setOccupied(deck, col, 0, false);
  expect(placeAt(deck, 1, 1, CELL_WEAPON)).toBe(PLACE_OK);
  const cell = cellAt(deck, 1, 1)!;
  expect(cell.exposedCount).toBe(1); // 先确认夹具确实只临空船头那一边
  return { deck, ship: shipAt(0, 0, 0), cell };
}

describe('stepTurrets:追瞄(平滑转向,有转速上限)', () => {
  it('炮口朝目标方位转,每帧恰好走一格上限,到位后停住不过冲', () => {
    const { deck, ship, cell } = bowTurret();
    const grid = gridOf([foeAt(BOW_MUZZLE_X, BOW_MUZZLE_Y, 30, 100)]);

    expect(cell.turretOffset).toBe(0); // 起手归位
    run(1, deck, ship, grid);
    // 第一帧就"啪"地对准的话这里会是 30 —— 瞬时对齐在画面上是弹回,也抽掉了 05 号"塔转不过来
    // 就打不到"那层手感的唯一来源
    expect(deg(cell.turretOffset)).toBeCloseTo(MAX_TURN_DEG, 9);

    run(28, deck, ship, grid); // 累计 29 帧
    expect(deg(cell.turretOffset)).toBeCloseTo(29 * MAX_TURN_DEG, 9);
    expect(deg(cell.turretOffset)).toBeLessThan(30); // 还没到位:这一条钉的就是"平滑而非瞬时"

    run(1, deck, ship, grid); // 第 30 帧:差值小于一格上限,当帧精确落到目标方位
    expect(deg(cell.turretOffset)).toBeCloseTo(30, 9);
    run(30, deck, ship, grid); // 再转半秒:停在目标上,不来回抖
    expect(deg(cell.turretOffset)).toBeCloseTo(30, 9);
  });

  it('炮口被 ±half 夹住,且射界外更近的敌人不会把它拽出去', () => {
    const { deck, ship, cell } = bowTurret();
    const grid = gridOf([
      foeAt(BOW_MUZZLE_X, BOW_MUZZLE_Y, 44, 150), // 贴着射界边线(半角 45°)的远目标
      foeAt(BOW_MUZZLE_X, BOW_MUZZLE_Y, 60, 50), // 更近,但在射界外 —— 一眼都不该看
    ]);

    for (let i = 0; i < 90; i++) {
      stepTurrets(deck, ship, grid, SIM_DT, null);
      // 每一帧都不许指到扇形外面去:Tab 画出来的扇形就是炮口的活动范围
      expect(Math.abs(deg(cell.turretOffset))).toBeLessThanOrEqual(45 + 1e-9);
    }
    expect(deg(cell.turretOffset)).toBeCloseTo(44, 9);
  });

  it('负方位同样追得到(转向取最短弧,不会挑远路绕一圈)', () => {
    const { deck, ship, cell } = bowTurret();
    const grid = gridOf([foeAt(BOW_MUZZLE_X, BOW_MUZZLE_Y, -20, 120)]);

    run(1, deck, ship, grid);
    expect(deg(cell.turretOffset)).toBeCloseTo(-MAX_TURN_DEG, 9);
    run(19, deck, ship, grid);
    expect(deg(cell.turretOffset)).toBeCloseTo(-20, 9);
  });
});

describe('stepTurrets:归位(射界内无目标 → 回到扇形中心)', () => {
  /** 先把炮口稳定地拧到 +30°,后面几条都从这个状态开始收 */
  const aimed = (): { deck: Deck; ship: Ship; cell: DeckCell } => {
    const aim = bowTurret();
    run(40, aim.deck, aim.ship, gridOf([foeAt(BOW_MUZZLE_X, BOW_MUZZLE_Y, 30, 100)]));
    expect(deg(aim.cell.turretOffset)).toBeCloseTo(30, 9);
    return aim;
  };

  it('场上一只敌人都没有:offset 单调回到 0,不过冲,到 0 后不再动', () => {
    const { deck, ship, cell } = aimed();
    const empty = gridOf([]);

    let prev = cell.turretOffset;
    for (let i = 0; i < 30; i++) {
      stepTurrets(deck, ship, empty, SIM_DT, null);
      const now = cell.turretOffset;
      expect(now).toBeLessThan(prev); // 单调
      expect(now).toBeGreaterThanOrEqual(-1e-9); // 不过冲:绝不越过 0 荡到另一侧
      expect(deg(prev - now)).toBeCloseTo(MAX_TURN_DEG, 9); // 归位与追瞄共用同一个转速上限
      prev = now;
    }
    expect(deg(cell.turretOffset)).toBeCloseTo(0, 9);
    run(10, deck, ship, empty);
    expect(deg(cell.turretOffset)).toBeCloseTo(0, 9); // 停在中心,不越过 0 抖动
  });

  it('目标还在场上、但被挤出射界:照样归位(判据是"射界内无目标",不是"世上无敌人")', () => {
    const { deck, ship, cell } = aimed();
    // 射程内(120 < 200)、方位 80°(> 半角 45°)—— 看得见摸不着
    const outside = gridOf([foeAt(BOW_MUZZLE_X, BOW_MUZZLE_Y, 80, 120)]);
    run(10, deck, ship, outside);
    expect(deg(cell.turretOffset)).toBeCloseTo(30 - 10 * MAX_TURN_DEG, 9);
    run(20, deck, ship, outside);
    expect(deg(cell.turretOffset)).toBeCloseTo(0, 9);
  });

  it('目标飞出射程:照样归位', () => {
    const { deck, ship, cell } = aimed();
    run(30, deck, ship, gridOf([foeAt(BOW_MUZZLE_X, BOW_MUZZLE_Y, 30, 260)])); // 260 > 射程 200
    expect(deg(cell.turretOffset)).toBeCloseTo(0, 9);
  });

  it('目标本帧被打死:立刻开始归位(尸体到 step 末尾才回收,不跳过就会瞄着它)', () => {
    const { deck, ship, cell } = aimed();
    const corpse = foeAt(BOW_MUZZLE_X, BOW_MUZZLE_Y, 30, 100);
    corpse.dead = true;
    run(30, deck, ship, gridOf([corpse]));
    expect(deg(cell.turretOffset)).toBeCloseTo(0, 9);
  });
});

describe('stepTurrets:目标过滤逐塔各算各的射界', () => {
  it('右舷的敌人只喂动右舷塔,左舷塔归位不动(射界 = 走位即火控的机制载体)', () => {
    const deck = createDeck();
    expect(placeAt(deck, 0, 1, CELL_WEAPON)).toBe(PLACE_OK); // 左舷中段
    expect(placeAt(deck, 2, 1, CELL_WEAPON)).toBe(PLACE_OK); // 右舷中段
    expect(placeAt(deck, 1, 1, CELL_SUPPORT)).toBe(PLACE_OK); // 内部格的供能设施:永远不该被碰
    const port = cellAt(deck, 0, 1)!;
    const starboard = cellAt(deck, 2, 1)!;
    const support = cellAt(deck, 1, 1)!;
    const ship = shipAt(0, 0, 0);

    // 右舷炮位 (20, 40);敌人在它的 110° 方位(射界中心 90° + 20°)、100 远。
    // 同一只敌人对左舷炮位 (20, -40) 而言是 101°:射程内,但离左舷射界 [-135°, -45°] 差着十万八千里
    const grid = gridOf([foeAt(20, 40, 110, 100)]);
    run(40, deck, ship, grid);

    expect(deg(starboard.turretOffset)).toBeCloseTo(20, 9);
    expect(port.turretOffset).toBe(0); // 逐位为 0:压根没被推过,而不是"转出去又转回来"
    expect(support.turretOffset).toBe(0); // 支援设施不是塔,一个字段都不许动
  });

  it('查询半径覆盖"舷侧塔够得到、船心够不到"的那一圈(半径 = 射程 + 甲板外接半径)', () => {
    const deck = createDeck();
    expect(placeAt(deck, 2, 1, CELL_WEAPON)).toBe(PLACE_OK);
    const cell = cellAt(deck, 2, 1)!;
    const ship = shipAt(0, 0, 0);

    // 离右舷炮位 (20,40) 只有 198(在射程内),离船心却有 235 —— 查询半径要是只写这一型的射程,
    // 这只敌人就落在粗筛之外,这座塔会对着自己明明够得到的目标发呆。
    // 刻意用细网格(cell = 8):哈希的粗筛边界贴近查询半径,这条断言才真的在钉半径公式本身
    const target = foeAt(20, 40, 100, 198);
    expect(Math.hypot(target.x, target.y)).toBeGreaterThan(GUN.range);
    run(15, deck, ship, gridOf([target], 8));

    expect(deg(cell.turretOffset)).toBeCloseTo(10, 9); // 100° − 射界中心 90°
  });

  it('船一转射界跟着转:同一只敌人先在射界外,船头转过来才进得来', () => {
    // 走位即火控(GDD §3.1 / P1):玩家改变的是船头,塔的可打范围随之整体旋转。
    // 用炮位落在船心的夹具,转船时只有射界在动,断言里不必再扣掉炮位绕行的那一段
    const { deck, ship, cell } = centerTurret();
    const grid = gridOf([foe(0, 150)]); // 敌人在船的正右方(+90°),距炮位 150 < 射程

    run(20, deck, ship, grid); // 船头朝 0°:敌人在射界外(90° > 半角 45°)
    expect(cell.turretOffset).toBe(0); // 逐位为 0:归位不动

    ship.heading = 90 * DEG2RAD; // 船头正对敌人:它落在射界正中
    run(20, deck, ship, grid);
    expect(deg(cell.turretOffset)).toBeCloseTo(0, 9);

    ship.heading = 70 * DEG2RAD; // 船再偏开 20°:敌人相对射界中心就成了 +20°
    run(30, deck, ship, grid);
    expect(deg(cell.turretOffset)).toBeCloseTo(20, 9);
    // 存的是相对射界中心的偏角 → 炮口的世界朝向 = 射界中心 + 偏角,还是那个 90°(敌人没动过)
    expect(deg(70 * DEG2RAD + cell.turretOffset)).toBeCloseTo(90, 6);
  });
});

describe('stepTurrets:性能口径与离线塔', () => {
  it('一座在线武器塔都没有 → 一次哈希都不查,也不碰任何一格的 offset', () => {
    const deck = createDeck(); // 空甲板 = 压测场景的常态
    const ship = shipAt(0, 0, 0);
    const grid = new CountingHash(tuning.enemyRadiusMax * 2);
    grid.insert(foe(60, 10));

    run(10, deck, ship, grid);
    expect(grid.queries).toBe(0); // 半径 300 的查询要是白掏十次,1000 敌压测里是实打实的帧时间
    expect(deck.cells.every((c) => c.turretOffset === 0)).toBe(true);

    // 反向确认这条断言不是在对着"永远不查"空过:放一座塔就该查起来
    expect(placeAt(deck, 1, 0, CELL_WEAPON)).toBe(PLACE_OK);
    run(1, deck, ship, grid);
    expect(grid.queries).toBe(1);
  });

  it('多座塔共享同一份候选:每帧恰好一次查询,而不是一塔一次', () => {
    const deck = createDeck();
    for (const [col, row] of [
      [0, 0],
      [1, 0],
      [2, 0],
      [0, 1],
    ] as [number, number][]) {
      expect(placeAt(deck, col, row, CELL_WEAPON)).toBe(PLACE_OK);
    }
    const ship = shipAt(0, 0, 0);
    const grid = new CountingHash(tuning.enemyRadiusMax * 2);
    grid.insert(foe(120, 30));

    run(5, deck, ship, grid);
    expect(grid.queries).toBe(5); // 四座塔 × 5 帧 = 20 次的话,Map 查找就翻了四倍
  });

  it('查询半径按**全甲板最大射程**算:短射程的塔不许把远程塔的候选圈缩掉', () => {
    const deck = createDeck();
    Object.assign(TOWERS[TOWER_RAILGUN]!, GUN, { range: 500 }); // 比机炮的 200 远得多
    expect(placeAt(deck, 1, 0, CELL_WEAPON, TOWER_AUTOCANNON)).toBe(PLACE_OK);
    expect(placeAt(deck, 0, 1, CELL_WEAPON, TOWER_RAILGUN)).toBe(PLACE_OK);
    const ship = shipAt(0, 0, 0);
    const grid = new CountingHash(tuning.enemyRadiusMax * 2);
    grid.insert(foe(120, 30));

    run(5, deck, ship, grid);
    expect(grid.queries).toBe(5); // 一塔一档之后仍然是每帧一次、全塔共享
    // 取全甲板最大值而不是"某一座塔的射程":取小了,磁轨炮就会对着自己明明够得到的目标发呆,
    // 而这种瞎是随甲板上还有哪些塔而变的 —— 最难查的一类 bug
    expect(grid.lastRadius).toBeCloseTo(500 + DECK_REACH, 9);
  });

  it('离线塔(暴露边被焊光)offset 冻结,恢复在线后从冻结值继续归位', () => {
    // 把船头那格焊上 = 把这座炮位包成内脏位(GDD §4.1 的"边缘内化"),塔灰显不开火
    const { deck, ship, cell } = centerTurret();
    const grid = gridOf([foeAt(0, 0, 30, 100)]); // 炮位就在船心 (0,0)

    run(10, deck, ship, grid);
    expect(deg(cell.turretOffset)).toBeCloseTo(10, 9);

    setOccupied(deck, 1, 0, true); // 焊死船头那格 → 这座塔离线
    expect(cell.online).toBe(false);
    const frozen = cell.turretOffset;
    run(30, deck, ship, grid);
    expect(cell.turretOffset).toBe(frozen); // 逐位不变:离线塔相对船体不动(视觉上跟着船转)

    setOccupied(deck, 1, 0, false); // 拆回去 → 恢复在线,从冻结值继续,不凭空跳一下
    run(1, deck, ship, gridOf([]));
    expect(deg(cell.turretOffset)).toBeCloseTo(10 - MAX_TURN_DEG, 9);
    run(9, deck, ship, gridOf([]));
    expect(deg(cell.turretOffset)).toBeCloseTo(0, 9);
  });

  it('离线塔连节流一起冻结:冷却不走、一发不打,恢复在线后从冻结值继续走完', () => {
    // 04 号钉的是"offset 冻结",05 号把节流也挂到了同一个开关上 ——
    // 只冻 offset 的话,被焊成内脏位的塔会在里面偷偷装填/蓄力,一恢复在线就凭空吐出一发
    const { deck, ship, cell } = centerTurret();
    const grid = gridOf([foeAt(0, 0, 0, 100)]); // 炮位就在船心,目标正在射界中心
    const log = fireLog();

    run(1, deck, ship, grid, log.sink);
    expect(log.bullets.size).toBe(1);
    const frozen = cell.cooldown;
    expect(frozen).toBeGreaterThan(0);

    setOccupied(deck, 1, 0, true); // 焊死船头那格 → 这座塔离线
    expect(cell.online).toBe(false);
    run(60, deck, ship, grid, log.sink);
    expect(cell.cooldown).toBe(frozen); // 逐位不变:离线塔连时间都不走
    expect(log.bullets.size).toBe(1); // 当然也一发不打

    setOccupied(deck, 1, 0, false); // 拆回去:剩下的冷却接着走,不是从头再来也不是当场就绪
    run(23, deck, ship, grid, log.sink);
    expect(log.bullets.size).toBe(1);
    run(1, deck, ship, grid, log.sink); // 第 24 帧冷却恰好走完(0.4s @60Hz)
    expect(log.bullets.size).toBe(2);
  });

  it('拆掉甲板格 → 连炮管偏角一起清零(重焊回来的新塔必须从归位起手)', () => {
    const { deck, ship, cell } = bowTurret();
    run(10, deck, ship, gridOf([foeAt(BOW_MUZZLE_X, BOW_MUZZLE_Y, 30, 100)]));
    expect(cell.turretOffset).not.toBe(0);

    setOccupied(deck, 1, 0, false); // 12 号扩建拆掉这一格:内容与偏角一起没
    expect(cell.content).toBe(CELL_EMPTY);
    expect(cell.turretOffset).toBe(0);
  });
});

// —— 以下是 05 号 issue T3 的开火(04 号只到"塔朝哪"为止)——————————————————————

interface DamageLog {
  e: Enemy;
  amount: number;
}
interface FxLog {
  kind: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  radius: number;
  towerType: number;
}
interface FireLog {
  sink: FireSink;
  bullets: Pool<Bullet>;
  damages: DamageLog[];
  fxs: FxLog[];
  /** sink.fired 收到的格:broadside 统计的唯一入口,一次开火必须恰好记一次 */
  fired: DeckCell[];
  /** sink.query 的调用次数:链跳与磁轨必须复用 stepTurrets 已查好的候选,一次都不该问 */
  queries: number;
}

/**
 * 记账用的假 sink。开火只经 FireSink 这一道缝回到世界里(见 sim/fx.ts),
 * 于是这里不必造一个 World,就能把"打了谁、扣了多少、推了什么可视化事件、往池里放了什么弹"
 * 按顺序全记下来。damage 真的调 applyDamage —— 于是"本帧已死的不再吃第二发"也验得了。
 */
function fireLog(): FireLog {
  const bullets = new Pool<Bullet>(createBullet, resetBullet);
  const log: FireLog = {
    bullets,
    damages: [],
    fxs: [],
    fired: [],
    queries: 0,
    sink: {
      spawnBullet: () => bullets.spawn(),
      damage: (e, amount) => {
        log.damages.push({ e, amount });
        return applyDamage(e, amount);
      },
      fx: (kind, x0, y0, x1, y1, radius, towerType) => {
        log.fxs.push({ kind, x0, y0, x1, y1, radius, towerType });
      },
      query: () => {
        log.queries++;
      },
      fired: (cell) => {
        log.fired.push(cell);
      },
    },
  };
  return log;
}

/** 弹道方向(度)。断言里想说的永远是"沿炮口 0°",而不是两个速度分量 */
const headingDeg = (b: Bullet): number => deg(Math.atan2(b.vy, b.vx));

describe('stepTurrets:开火门槛(sink / 目标 / 炮口对准 / 节流,缺一不可)', () => {
  it('sink = null:只追瞄,一发不打、一份代价也不记', () => {
    const { deck, ship, cell } = bowTurret();
    const mag = towerMagazine(TOWERS[TOWER_AUTOCANNON]!, 1);
    const grid = gridOf([foeAt(BOW_MUZZLE_X, BOW_MUZZLE_Y, 30, 100)]);
    const log = fireLog();

    run(60, deck, ship, grid);
    expect(deg(cell.turretOffset)).toBeCloseTo(30, 9); // 炮管照转(04 那批用例走的就是这条路)
    expect(log.bullets.size).toBe(0);
    expect(cell.ammo).toBe(mag); // 节流一份代价都没记 —— 没开火就不该扣弹

    // 对照:同样的 60 帧给上 sink 就打起来了,上面那条不是"这座塔本来就打不响"的空过
    run(60, deck, ship, grid, log.sink);
    expect(log.bullets.size).toBe(3); // 24 帧一发(0.4s @60Hz,GDD §14 锚点)
    expect(cell.ammo).toBe(mag - 3);
  });

  it('炮口没对准就不开火:转进容差的那一帧才响第一枪(= "塔转不过来就打不到")', () => {
    // 容差 5.5°、转速每帧 1°:目标在 +30°,炮口转到 24.5° 才够得着 → 第 25 帧才是第一枪。
    // 容差刻意取半度,让判据的临界点落在两帧**之间** —— 边界本身的含不含在 arc.test.ts 钉,
    // 这里要钉的是"确实拦到了转不过来的那一段",不该被 1e-15 的浮点残差左右
    const { deck, ship, cell } = bowTurret(TOWER_AUTOCANNON, { aimTolDeg: 5.5 });
    const grid = gridOf([foeAt(BOW_MUZZLE_X, BOW_MUZZLE_Y, 30, 100)]);
    const log = fireLog();

    let first = 0;
    for (let f = 1; f <= 40; f++) {
      run(1, deck, ship, grid, log.sink);
      if (!first && log.bullets.size > 0) first = f;
    }
    expect(first).toBe(25);
    expect(deg(cell.turretOffset)).toBeCloseTo(30, 9); // 到位之后就一直打得出去了
    expect(log.bullets.size).toBe(1 + Math.floor((40 - 25) / 24));

    // 沉炮(转速 0)则永远够不着这个 30° 的目标:转速上限与容差合起来才是那句"转不过来就打不到",
    // 只有其中一半的话,炮管就只是根装饰品
    const stuck = bowTurret(TOWER_AUTOCANNON, { turnRate: 0, aimTolDeg: 5.5 });
    const log2 = fireLog();
    run(120, stuck.deck, stuck.ship, grid, log2.sink);
    expect(stuck.cell.turretOffset).toBe(0);
    expect(log2.bullets.size).toBe(0);
  });

  it('节流不放行就不开火:弹夹见底后照样追瞄,但一发都不出', () => {
    const { deck, ship, cell } = bowTurret();
    const def = TOWERS[TOWER_AUTOCANNON]!;
    const mag = towerMagazine(def, 1);
    const grid = gridOf([foeAt(BOW_MUZZLE_X, BOW_MUZZLE_Y, 0, 100)]);
    const log = fireLog();

    // 打空一夹(20 发 × 24 帧),进装填
    for (let f = 0; f < 2000 && cell.reloadLeft <= 0; f++) run(1, deck, ship, grid, log.sink);
    expect(cell.reloadLeft).toBe(def.reload);
    expect(log.bullets.size).toBe(mag);

    // 装填那 90 帧里:炮管照样跟着目标转(把目标挪到 +10°),但一发都打不出去 ——
    // 三道门槛各管各的,节流拦住的是"开火",不是"追瞄"
    const moved = gridOf([foeAt(BOW_MUZZLE_X, BOW_MUZZLE_Y, 10, 100)]);
    run(10, deck, ship, moved, log.sink);
    expect(cell.reloadLeft).toBeGreaterThan(0);
    expect(log.bullets.size).toBe(mag);
    expect(deg(cell.turretOffset)).toBeCloseTo(10 * MAX_TURN_DEG, 9);
  });
});

describe('stepTurrets:五种开火表现', () => {
  it('直射弹(机炮):沿**炮口朝向**出膛,弹的字段全从数值表来', () => {
    // 转速 0 = 炮管焊死在射界中心,容差却给到 30°:目标在 +20°、炮口在 0° ——
    // 两者一眼分得开,弹道到底跟谁走当场看得出来
    const { deck, ship, cell } = bowTurret(TOWER_AUTOCANNON, { turnRate: 0, aimTolDeg: 30 });
    const def = TOWERS[TOWER_AUTOCANNON]!;
    const grid = gridOf([foeAt(BOW_MUZZLE_X, BOW_MUZZLE_Y, 20, 120)]);
    const log = fireLog();

    run(1, deck, ship, grid, log.sink);

    expect(cell.turretOffset).toBe(0);
    expect(log.bullets.size).toBe(1);
    const b = log.bullets.items[0]!;
    expect(b.kind).toBe(BK_DIRECT);
    expect(b.x).toBe(BOW_MUZZLE_X); // 出膛点 = 炮位(不是船心)
    expect(b.y).toBe(BOW_MUZZLE_Y);
    expect(b.px).toBe(b.x); // px/py 停在炮口:渲染插值的两端(铁律 2)
    expect(b.py).toBe(b.y);
    expect(headingDeg(b)).toBeCloseTo(0, 9); // 沿炮口 0°,而**不是**目标那 20°
    expect(Math.hypot(b.vx, b.vy)).toBeCloseTo(def.bulletSpeed, 9);
    expect(b.damage).toBe(effectiveDamage(def, 1));
    expect(b.life).toBeCloseTo(GUN.range / def.bulletSpeed, 12); // 射程上限的唯一表达
    expect(b.radius).toBe(def.bulletRadius);
    expect(b.pierce).toBe(0);
    expect(b.towerType).toBe(TOWER_AUTOCANNON);
    // 漏清这两个字段,一颗机炮弹就会在飞完射程那一刻炸出一片 AoE(池复用带来的脏值)
    expect(b.aoeRadius).toBe(0);
    expect(b.aoeDamage).toBe(0);

    expect(log.damages.length).toBe(0); // 真子弹:伤害在飞行途中由 sim/bullet.ts 结算,不当场扣
    expect(log.fxs.length).toBe(0); // 出膛由子弹自己交代,本轮 sim 不产 FXV_MUZZLE
    expect(cell.ammo).toBe(towerMagazine(def, 1) - 1); // 代价记在自己那套机制上
    expect(log.fired).toEqual([cell]); // broadside 统计:一次开火恰好记一次
  });

  it('Lv3 双管 / Lv5 曳光弹:发数与穿透跟着等级跳变,多发绕炮口确定性扇开', () => {
    const { deck, ship, cell } = bowTurret();
    const def = TOWERS[TOWER_AUTOCANNON]!;
    const grid = gridOf([foeAt(BOW_MUZZLE_X, BOW_MUZZLE_Y, 0, 100)]);
    const log = fireLog();

    // 叠级走 placeAt 这个唯一入口(GDD §5.4:原格生效、不占新格)
    for (let lv = 1; lv < 3; lv++) {
      expect(placeAt(deck, 1, 0, CELL_WEAPON, TOWER_AUTOCANNON)).toBe(PLACE_UPGRADE);
    }
    expect(cell.level).toBe(3);

    run(1, deck, ship, grid, log.sink);
    expect(log.bullets.size).toBe(2); // Lv3 双管
    const [a, b] = log.bullets.items as [Bullet, Bullet];
    // 绕炮口对称扇开、整束宽度 = 瞄准容差(不为它新造一个旋钮),而且**全程无随机**:
    // 同一发的两颗弹每次跑都落在同样这两个角上
    expect(headingDeg(a)).toBeCloseTo(-def.aimTolDeg / 2, 9);
    expect(headingDeg(b)).toBeCloseTo(def.aimTolDeg / 2, 9);
    expect(a.damage).toBe(effectiveDamage(def, 3));
    expect(a.damage).toBeGreaterThan(effectiveDamage(def, 1)); // 等级成长真的吃到了
    // 连发按发扣;基数仍是 Lv1 那一夹 —— 叠级不白送弹夹(口径在 sim/tower.ts)
    expect(cell.ammo).toBe(towerMagazine(def, 1) - 2);
    expect(log.fired).toEqual([cell]); // 一次开火(两发)只算一座塔开了火,不是两座

    // 再叠到 Lv5:曳光弹给每发多一层穿透
    for (let lv = 3; lv < 5; lv++) {
      expect(placeAt(deck, 1, 0, CELL_WEAPON, TOWER_AUTOCANNON)).toBe(PLACE_UPGRADE);
    }
    expect(a.pierce).toBe(0); // 已经出膛的那两发不回查塔:升级不追加给飞在半路的弹
    for (let f = 0; f < 60 && log.bullets.size < 3; f++) run(1, deck, ship, grid, log.sink);
    expect(log.bullets.size).toBe(4);
    for (const fresh of log.bullets.items.slice(2)) {
      expect(fresh.pierce).toBe(def.pierce + def.pierceAtLv5);
    }
  });

  it('抛射弹(迫击炮):途中不碰撞的一颗弹,飞行时间 = 落点距离 / 弹速,伤害全在落点', () => {
    // 充能时间调成一帧:这条验的是"打出了什么",不必空跑三秒的蓄力(节奏本身在 tower.test.ts 钉)
    const { deck, ship, cell } = bowTurret(TOWER_MORTAR, { chargeTime: SIM_DT });
    const def = TOWERS[TOWER_MORTAR]!;
    const target = foeAt(BOW_MUZZLE_X, BOW_MUZZLE_Y, 0, 150);
    const log = fireLog();

    run(1, deck, ship, gridOf([target]), log.sink);

    expect(log.bullets.size).toBe(1);
    const b = log.bullets.items[0]!;
    expect(b.kind).toBe(BK_MORTAR);
    expect(b.damage).toBe(0); // 直击不结算 —— 越过前排正是这一型的定位(GDD §5.2)
    expect(b.aoeRadius).toBe(def.aoeRadius);
    expect(b.aoeDamage).toBe(effectiveAoeDamage(def, 1));
    expect(b.aoeDamage).toBeGreaterThan(0); // 它的 def.damage 恒 0,伤害全挂在这一项上
    expect(b.life).toBeCloseTo(150 / def.bulletSpeed, 12);
    // 落点 = 目标**当前**位置,不做提前量:抛射的全部乐趣就是"看得见落点、来得及走开"
    expect(b.x + b.vx * b.life).toBeCloseTo(target.x, 6);
    expect(b.y + b.vy * b.life).toBeCloseTo(target.y, 6);

    expect(log.damages.length).toBe(0); // 开火这一刻一滴血都不掉,全在落点(sim/bullet.ts)
    expect(cell.charge).toBe(0); // 充能系一次放空
    expect(log.fired).toEqual([cell]);
  });

  it('光束(激光):瞬时单体伤害 + 一条炮口→命中点的 FXV_BEAM,不产生子弹', () => {
    const { deck, ship, cell } = bowTurret(TOWER_LASER);
    const def = TOWERS[TOWER_LASER]!;
    const target = foeAt(BOW_MUZZLE_X, BOW_MUZZLE_Y, 0, 120);
    const log = fireLog();

    run(1, deck, ship, gridOf([target]), log.sink);

    expect(log.bullets.size).toBe(0); // 光束没有"飞行"这回事,给它造弹丸只是凭空多一套状态
    expect(log.damages.length).toBe(1);
    expect(log.damages[0]!.e).toBe(target);
    expect(log.damages[0]!.amount).toBe(effectiveDamage(def, 1));

    expect(log.fxs.length).toBe(1);
    const fx = log.fxs[0]!;
    expect(fx.kind).toBe(FXV_BEAM);
    expect(fx.x0).toBe(BOW_MUZZLE_X); // 起点 = 炮口
    expect(fx.y0).toBe(BOW_MUZZLE_Y);
    expect(fx.x1).toBe(target.x); // 终点 = 命中点:画到哪儿就是打到哪儿
    expect(fx.y1).toBe(target.y);
    expect(fx.radius).toBe(0);
    expect(fx.towerType).toBe(TOWER_LASER);
    expect(cell.heat).toBe(def.heatPerShot); // 代价记在过热那一套上
  });

  it('链电(电弧):逐跳跳给最近的未命中活人,伤害逐跳衰减,每跳一条 FXV_CHAIN', () => {
    const { deck, ship, cell } = bowTurret(TOWER_ARC, {
      chainCount: 3,
      chainRange: 60,
      chainFalloff: 0.5,
    });
    const def = TOWERS[TOWER_ARC]!;
    const first = foe(160, 0); // 离炮口 100:射界内最近 → 首目标
    const second = foe(200, 0); // 离 first 40 ≤ 60
    const third = foe(240, 0); // 离 second 40,离 first 80 > 60 —— 只能顺着链子过去
    const lonely = foe(60, 130); // 射程内但谁都够不着:跳跃半径不是射程
    const log = fireLog();

    run(1, deck, ship, gridOf([first, second, third, lonely]), log.sink);

    expect(log.damages.map((d) => d.e)).toEqual([first, second, third]);
    const base = effectiveDamage(def, 1);
    expect(log.damages.map((d) => d.amount)).toEqual([base, base * 0.5, base * 0.25]);
    expect(lonely.hp).toBe(lonely.maxHp); // 一滴血都没掉:chainRange 真的在拦人

    // 每跳一条折线,首尾相接 —— 渲染层照这几条画出整条链(炮口 → 甲 → 乙 → 丙)
    expect(log.fxs.map((f) => f.kind)).toEqual([FXV_CHAIN, FXV_CHAIN, FXV_CHAIN]);
    expect(log.fxs.map((f) => [f.x0, f.x1])).toEqual([
      [BOW_MUZZLE_X, first.x],
      [first.x, second.x],
      [second.x, third.x],
    ]);

    expect(log.queries).toBe(0); // 链跳复用 stepTurrets 已经查好的候选,不额外问哈希
    expect(log.bullets.size).toBe(0);
    // 一次放电 = 一发:按跳数扣热量的话,电弧塔一进人堆就瞬间过热,而"清蜂群"正是它的定位
    expect(cell.heat).toBe(def.heatPerShot);
    expect(log.fired).toEqual([cell]);
  });

  it('链能跳出自己的射程:共享候选圈按"够得着的最远距离"取,不是按射程', () => {
    // 电弧塔真正够得着的范围 = 射程 + (chainCount-1) × chainRange = 200 + 3×100 = 500,
    // 而按射程取圈只有 200 + 甲板外接半径 100 = 300 —— 后两只会被静默挡在候选之外,
    // 于是「每级 +1 跳」这条成长曲线有一半是空的(Lv5 电弧只跳得动前几只)
    const chainHits = (alsoRailgun: boolean): number => {
      const { deck, ship } = bowTurret(TOWER_ARC, {
        chainCount: 4,
        chainRange: 100,
        chainFalloff: 1,
      });
      if (alsoRailgun) {
        // 一座打不着这条线的远程塔(射界朝左舷),纯粹用来把"按射程取的候选圈"撑大
        Object.assign(TOWERS[TOWER_RAILGUN]!, GUN, { range: 900 });
        expect(placeAt(deck, 0, 1, CELL_WEAPON, TOWER_RAILGUN)).toBe(PLACE_OK);
      }
      const foes = [foe(160, 0), foe(250, 0), foe(340, 0), foe(430, 0)]; // 每跳 90 ≤ 100
      const log = fireLog();
      run(1, deck, ship, gridOf(foes), log.sink);
      expect(log.queries).toBe(0); // 仍然只有 stepTurrets 那一次查询,没有为链跳加查
      return log.damages.filter((d) => d.e.kind === foes[0]!.kind).length;
    };

    // 最后一只离船心 430 > 按射程取的圈(200 + 甲板外接半径 100 = 300),
    // 离炮口更是 370 > 射程 200 —— 只能顺着链子过去
    expect(chainHits(false)).toBe(4);
    // 同一条链,甲板上多一座**无关**的远程塔:链长一跳都不该变。
    // 候选圈按射程取时,这座磁轨会把圈撑大、让这条链凭空多跳几只 ——
    // 一座塔的行为取决于旁边有什么塔,正是最难查的那类 bug
    expect(chainHits(true)).toBe(4);
  });

  it('链跳同距:严格 < 才替换 —— 保留候选里先到的那一只(跳跃序列因此确定)', () => {
    // 甲在 (200,14),两只候选在 (228,4) 与 (228,24):离甲都是 √884,而且同在一个哈希 cell 里
    // (cell = 28),于是候选顺序 = 插入顺序 —— 调个个儿就能看出决定权在"先到者"而不是坐标符号
    const secondHopY = (swap: boolean): number => {
      const { deck, ship } = bowTurret(TOWER_ARC, { chainCount: 2, chainRange: 60 });
      const a = foe(200, 14);
      const p = foe(228, 4);
      const q = foe(228, 24);
      const log = fireLog();
      run(1, deck, ship, gridOf(swap ? [a, q, p] : [a, p, q]), log.sink);
      expect(log.damages.length).toBe(2);
      expect(log.damages[0]!.e).toBe(a);
      return log.damages[1]!.e.y;
    };

    expect(secondHopY(false)).toBe(4);
    expect(secondHopY(true)).toBe(24);
  });

  it('磁轨(瞬时线段):线上全员吃满且不衰减,线外/身后/射程之外一律不碰', () => {
    const { deck, ship, cell } = bowTurret(TOWER_RAILGUN, { chargeTime: SIM_DT, lanceWidth: 6 });
    const def = TOWERS[TOWER_RAILGUN]!;
    const r = ENEMIES[KIND_SWARM]!.radius;
    const near = foe(120, 0); // 线上,离炮口 60
    const far = foe(240, 0); // 线上,离炮口 180 ≤ 射程 200
    const onEdge = foe(200, def.lanceWidth + r); // 垂距恰好 = 半宽 + 体型 → 含边界,照样吃满
    const justOut = foe(160, def.lanceWidth + r + 0.001); // 差千分之一就当没看见
    const behind = foe(20, 0); // 炮口身后:投影为负 —— 只判点到直线的距离会把它一起打了
    const beyond = foe(BOW_MUZZLE_X + 205, 0); // 线的延长线上,但超出射程 5
    const log = fireLog();

    run(1, deck, ship, gridOf([near, far, onEdge, justOut, behind, beyond]), log.sink);

    expect(new Set(log.damages.map((d) => d.e))).toEqual(new Set([near, far, onEdge]));
    // 线上不衰减(与链电逐跳衰减正相反):这是"蓄力一发换一条贯穿"的全部回报
    for (const d of log.damages) expect(d.amount).toBe(effectiveDamage(def, 1));
    expect(log.bullets.size).toBe(0); // 60Hz 下一帧走两千 px 的弹丸必然隧穿,故不走子弹池
    expect(log.queries).toBe(0); // 与链跳同口径:复用已经查好的候选

    expect(log.fxs.length).toBe(1);
    const fx = log.fxs[0]!;
    expect(fx.kind).toBe(FXV_LANCE);
    expect(fx.x0).toBe(BOW_MUZZLE_X);
    expect(fx.y0).toBe(BOW_MUZZLE_Y);
    // 终点画到射程尽头 = 可视化即作用范围(与射界叠加层同一条口径)
    expect(fx.x1).toBeCloseTo(BOW_MUZZLE_X + GUN.range, 9);
    expect(fx.y1).toBeCloseTo(BOW_MUZZLE_Y, 9);
    expect(cell.charge).toBe(0);
  });
});

// —— 以下是 09 号 issue T3 的受击射速惩罚(塔侧的接线;判定几何全在 sim/damage.ts)——————————

describe('stepTurrets:受击射速惩罚(被撞舷的塔顿一下,别的舷照常打)', () => {
  /** 没挨罚的射击间隔(帧):0.4s @60Hz,GDD §14 锚点 —— 与上面几组读到的是同一个数 */
  const FAST = 24;
  /** 挨罚后的间隔(帧):0.4 / hitFireRateMul 0.5 = 0.8s。整整一倍,帧距一眼读得出 */
  const SLOW = 48;
  /** 观察窗口(帧):最多 13 枪 < 一夹 20 发 —— 装填那段硬停顿不会混进帧距里来搅局 */
  const FRAMES = 300;

  /** 这几舷正在惩罚中。剩余秒具体是多少不影响倍率(判据只是 > 0),照 World 的口径给一个整窗口 */
  function penalized(...edges: number[]): number[] {
    const p = new Array<number>(EDGE_COUNT).fill(0);
    for (const e of edges) p[e] = tuning.hitPenaltyTime;
    return p;
  }

  /**
   * 三座塔的 3×4 全占用甲板:船头正中(只有 BOW 一条暴露边)、船头左舷**角落格**
   * (BOW + PORT 两条)、右舷中段(只有 STARBOARD)—— 两座各属一舷,外加一座横跨两舷的。
   *
   * 塔一律拧成**全向射界 + 容差 360°**:射界与"炮口对没对准"这两道门槛当场作废,
   * 于是"隔多少帧响一枪"只剩节流这一个变量 —— 本组要读的正是射速惩罚,
   * 不该被"炮管转不转得过来"混进来(那件事上面几组各自钉过了)。
   */
  function penaltyDeck(): {
    deck: Deck;
    ship: Ship;
    grid: SpatialHash<Enemy>;
    bow: DeckCell;
    corner: DeckCell;
    starboard: DeckCell;
  } {
    Object.assign(TOWERS[TOWER_AUTOCANNON]!, GUN, { arcDeg: 360, aimTolDeg: 360, range: 400 });
    const deck = createDeck();
    expect(placeAt(deck, 1, 0, CELL_WEAPON)).toBe(PLACE_OK);
    expect(placeAt(deck, 0, 0, CELL_WEAPON)).toBe(PLACE_OK);
    expect(placeAt(deck, 2, 1, CELL_WEAPON)).toBe(PLACE_OK);
    const bow = cellAt(deck, 1, 0)!;
    const corner = cellAt(deck, 0, 0)!;
    const starboard = cellAt(deck, 2, 1)!;

    // 先确认夹具的舷向归属就是想要的那三种,免得下面的断言其实在对着另一块甲板空过
    expect([bow.exposedCount, corner.exposedCount, starboard.exposedCount]).toEqual([1, 2, 1]);
    expect(isEdgeExposed(corner, EDGE_BOW) && isEdgeExposed(corner, EDGE_PORT)).toBe(true);

    // 敌人摆在船正前方 300:全向射界下三座塔都够得着(离各自炮位 ≤ 283 < 射程 400),
    // 于是三座塔逐帧都有目标 —— 谁慢下来就一定是惩罚的功劳,而不是"这一帧没瞄着人"
    return { deck, ship: shipAt(0, 0, 0), grid: gridOf([foe(300, 0)]), bow, corner, starboard };
  }

  /**
   * 跑一局 FRAMES 帧,返回三座塔各自开火落在第几帧(1-based)。**每次现造夹具** ——
   * 冷却与弹夹不许跨场景带过去,否则第二个场景的第一枪就已经欠着上一局的账。
   * 逐帧调 stepTurrets 而不是一次 run(n):sink.fired 只记"哪一格开了火"、不记时间,而本组要读的正是帧距。
   *
   * @param args 省掉它 = 走 stepTurrets 的**缺省调用形状**(04/05 那批用例走的就是这条)。
   *   这里真的分两条路调,而不是把一个 undefined 转手传下去 —— "既有调用方一个字都不用改"
   *   这条口径,只有真的按既有形状调一次才验得到
   */
  function cadence(...args: [] | [readonly number[] | null]): {
    bow: number[];
    corner: number[];
    starboard: number[];
  } {
    const { deck, ship, grid, bow, corner, starboard } = penaltyDeck();
    const log = fireLog();
    const at = new Map<DeckCell, number[]>();
    for (let f = 1; f <= FRAMES; f++) {
      log.fired.length = 0;
      stepTurrets(deck, ship, grid, SIM_DT, log.sink, ...args);
      for (const cell of log.fired) {
        const list = at.get(cell);
        if (list) list.push(f);
        else at.set(cell, [f]);
      }
    }
    return {
      bow: at.get(bow) ?? [],
      corner: at.get(corner) ?? [],
      starboard: at.get(starboard) ?? [],
    };
  }

  /** 期望的开火帧序列:第 1 帧起,每 gap 帧一枪。写成"隔多少帧一枪",不手抄一串数字 */
  function beat(gap: number): number[] {
    const at: number[] = [];
    for (let f = 1; f <= FRAMES; f += gap) at.push(f);
    return at;
  }

  it('省参数 / 传 null / 全零四元组:三条路逐帧读数一字不差', () => {
    const omitted = cadence();
    // 缺省值一旦不是 null,04/05 那批省参数的用例会在毫无关系的地方开始漂
    expect(cadence(null)).toEqual(omitted);
    // 全零 = "四舷都没在挨罚",必须与"压根没有受击这回事"同一条读数 ——
    // 差一点就是"World 一构造出来全船就在挨罚",而那是整局都不会有人发现的慢性病
    expect(cadence(new Array<number>(EDGE_COUNT).fill(0))).toEqual(omitted);

    // 反向确认上面三条不是在对着三个空数组空过:没惩罚时三座塔都是基准节奏
    expect(omitted.bow).toEqual(beat(FAST));
    expect(omitted.corner).toEqual(beat(FAST));
    expect(omitted.starboard).toEqual(beat(FAST));
  });

  it('PORT 挨了一下:左舷角落格顿下来,船头塔与右舷塔一帧不差', () => {
    const hit = cadence(penalized(EDGE_PORT));

    // 角落格只有 PORT 这一条边中招,照样整格挨罚 —— 塔的舷向归属按**每一条暴露边**算。
    // 3×4 甲板上 PORT 一共只有 2 格,换成"每格只挑一条边"的规则(05 的 lowestEdge,
    // 或按格心方位角),这座角落格会被算成 BOW,左舷的受击反馈当场少掉一半
    expect(hit.corner).toEqual(beat(SLOW));
    // 没中招的两舷一帧不差:惩罚要是漏到全甲板,"被撞舷"这三个字就没有意义了
    expect(hit.bow).toEqual(beat(FAST));
    expect(hit.starboard).toEqual(beat(FAST));
  });

  it('BOW 挨了一下:角落格同时属于两舷,于是它跟着船头塔一起顿', () => {
    const hit = cadence(penalized(EDGE_BOW));
    expect(hit.bow).toEqual(beat(SLOW));
    expect(hit.corner).toEqual(beat(SLOW)); // 两条暴露边任一中招都算数
    expect(hit.starboard).toEqual(beat(FAST));

    // 两条边**同时**在罚:倍率只算一次,不按舷数连乘(连乘那条是 0.5 × 0.5 = 0.25 → 96 帧)。
    // 角落格本就是天然优质炮位(射界 +60°,GDD §4.2),两面临敌、两面可能挨罚已经是那份优势的代价;
    // 再叠一层就成了死亡螺旋 —— 挨得越多、打得越少、于是挨得更多
    const both = cadence(penalized(EDGE_BOW, EDGE_PORT));
    expect(both.corner).toEqual(beat(SLOW));
    expect(both.starboard).toEqual(beat(FAST));
  });
});
