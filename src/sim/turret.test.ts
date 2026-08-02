/**
 * 炮管推进(04 号 issue T2)。本文件在 Node 里跑通本身就是铁律 1 的一层验证:
 * "塔朝哪"只由甲板 + 船位姿 + 空间哈希决定,不需要 Pixi,也不需要一整个 World。
 *
 * 钉的几条口径(改坏就等于改坏了 04 的任务描述):
 *   射界内有目标 → 炮口追它的方位,但**每帧最多转 turretTurnRate × dt**(平滑,不是瞬时);
 *   射界内没目标(空 / 射程外 / 射界外 / 已死)→ **归位**:offset 单调回到 0 且不过冲;
 *   目标过滤逐塔各按自己的射界算 —— 左舷塔不会去追右舷的敌人;
 *   性能口径也在这里钉死:没有在线武器塔就一次哈希都不查,有塔则**每帧只查一次**、全塔共享;
 *     查询半径必须覆盖"舷侧塔够得到、船心够不到"的那一圈,否则边上的塔会瞎一小块;
 *   离线塔(12 号扩建把炮位焊成内脏位)offset **冻结**,恢复在线后从冻结值继续。
 *
 * 参数在文件顶部显式写死并 afterEach 还原(照 deck.test.ts / ship.test.ts 的做法):
 * tuning 里那三项是 05 号接手前的占位,行为断言不该被一次平衡调整带崩。
 * 转速刻意取 60°/s = 每帧 1°:于是"第 N 帧转过 N°"可以逐帧钉,平滑与否一眼看得出来。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SIM_DT } from '../core/loop';
import { SpatialHash } from '../core/spatialHash';
import { tuning } from './config';
import {
  CELL_EMPTY,
  CELL_SUPPORT,
  CELL_WEAPON,
  cellAt,
  createDeck,
  type Deck,
  type DeckCell,
  PLACE_OK,
  placeAt,
  setOccupied,
} from './deck';
import { createEnemy, type Enemy } from './enemy';
import { createShip, DEG2RAD, type Ship } from './ship';
import { stepTurrets } from './turret';

const BASE = {
  shipLength: 160, // ÷ 4 行 = 40
  shipWidth: 120, // ÷ 3 列 = 40 —— 两轴同为 40,格边长是整数,断言里的炮位坐标才算得清
  turretArcDeg: 90, // 半角 45°
  turretRange: 200,
  turretTurnRate: 60, // °/s;@60Hz 正好每帧 1°
};
Object.assign(tuning, BASE);
afterEach(() => Object.assign(tuning, BASE));

/** 每帧转速上限(度)。断言里反复用到,拿它算而不是写死 1,改了 BASE 也不会悄悄失配 */
const MAX_TURN_DEG = tuning.turretTurnRate * SIM_DT;

const deg = (rad: number): number => rad / DEG2RAD;

const shipAt = (x: number, y: number, heading: number): Ship => {
  const ship = createShip();
  ship.x = ship.px = x;
  ship.y = ship.py = y;
  ship.heading = ship.pheading = heading;
  return ship;
};

/** 只有位置与生死是索敌看的字段,其余走池 factory 的初值 */
const foe = (x: number, y: number): Enemy => {
  const e = createEnemy();
  e.x = x;
  e.y = y;
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

const run = (n: number, deck: Deck, ship: Ship, grid: SpatialHash<Enemy>): void => {
  for (let i = 0; i < n; i++) stepTurrets(deck, ship, grid, SIM_DT);
};

/**
 * 记账用的哈希:除了数查询次数,行为与 SpatialHash 一模一样(不 mock —— 换成假的就等于没测)。
 * "每帧只查一次"是本轮明文的性能口径,而它在功能断言里完全看不出来,只能这样钉。
 */
class CountingHash extends SpatialHash<Enemy> {
  queries = 0;
  override query(x: number, y: number, r: number, out: Enemy[]): Enemy[] {
    this.queries++;
    return super.query(x, y, r, out);
  }
}

/** 3×4 甲板 + 船头正中一座塔(只有 BOW 一条暴露边 → 射界中心 = 船头),炮位在局部 (60, 0) */
function bowTurret(): { deck: Deck; ship: Ship; cell: DeckCell } {
  const deck = createDeck();
  expect(placeAt(deck, 1, 0, CELL_WEAPON)).toBe(PLACE_OK);
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
      stepTurrets(deck, ship, grid, SIM_DT);
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
      stepTurrets(deck, ship, empty, SIM_DT);
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

    // 离右舷炮位 (20,40) 只有 198(在射程内),离船心却有 235 —— 查询半径要是只写 tuning.turretRange,
    // 这只敌人就落在粗筛之外,这座塔会对着自己明明够得到的目标发呆。
    // 刻意用细网格(cell = 8):哈希的粗筛边界贴近查询半径,这条断言才真的在钉半径公式本身
    const target = foeAt(20, 40, 100, 198);
    expect(Math.hypot(target.x, target.y)).toBeGreaterThan(tuning.turretRange);
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

  it('拆掉甲板格 → 连炮管偏角一起清零(重焊回来的新塔必须从归位起手)', () => {
    const { deck, ship, cell } = bowTurret();
    run(10, deck, ship, gridOf([foeAt(BOW_MUZZLE_X, BOW_MUZZLE_Y, 30, 100)]));
    expect(cell.turretOffset).not.toBe(0);

    setOccupied(deck, 1, 0, false); // 12 号扩建拆掉这一格:内容与偏角一起没
    expect(cell.content).toBe(CELL_EMPTY);
    expect(cell.turretOffset).toBe(0);
  });
});
