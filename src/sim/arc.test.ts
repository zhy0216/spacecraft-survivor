/**
 * 射界几何(04 号 issue T1)。本文件在 Node 里跑通本身就是铁律 1 的一层验证:
 * 射界只由"甲板拓扑 + 船体朝向 + 一个度数"决定,不碰 Pixi/DOM,也不需要一整个 World。
 *
 * 钉的几条口径(改坏就等于改坏了 04 的验收标准):
 *   普通边缘格 = 那条暴露边的法线 ± 弧度/2;
 *   角落格 = 两条法线的角平分线、弧度 +60°(GDD §4.2);
 *   多暴露边(凹形轮廓)= 向量和方向,每多一条边再 +60°(外推);
 *   **跨 ±π 必须用向量和** —— 对角度取平均会指向反方向,这一条是 cellArc 存在的主要理由;
 *   退化(对边 / 四面暴露)与内部格是明文约定的行为,不是"碰巧算出来这样";
 *   射界随 heading 整体旋转、半角与朝向无关(04 验收标准第三条的 sim 侧口径:
 *   渲染层拿同一个函数、传插值朝向,结构上不可能比船体晚一帧)。
 *
 * 全程显式传 arcDeg,**不读 tuning.turretArcDeg**:那三项是 05 号接手前的占位,
 * 用它当基准的话,05 一删这段测试就整片红,而几何本身其实一点没变。
 */
import { describe, expect, it } from 'vitest';
import {
  ARC_MEDIUM_DEG,
  ARC_NARROW_DEG,
  ARC_OMNI_DEG,
  ARC_TIERS_DEG,
  ARC_VERY_NARROW_DEG,
  ARC_WIDE_DEG,
  ARC_WIDEN_PER_EDGE_DEG,
} from '../data/arcs';
import { type Arc, arcContains, arcHalfAngle, cellArc, findArcTarget, isTurretCell } from './arc';
import {
  CELL_SUPPORT,
  CELL_WEAPON,
  cellAt,
  createDeck,
  type Deck,
  EDGE_BOW,
  EDGE_PORT,
  EDGE_STARBOARD,
  EDGE_STERN,
  edgeWorldNormal,
  isCornerCell,
  isInteriorCell,
  PLACE_OK,
  placeAt,
  setOccupied,
} from './deck';
import { createEnemy, type Enemy } from './enemy';
import { DEG2RAD, wrapAngle } from './ship';

/** 全文统一用"中"档(100°)当基准,加宽/夹取的用例再各自换档 */
const ARC = ARC_MEDIUM_DEG;

/** 几个互不对称的朝向:含 0、含负角、含跨 ±π 的邻域,免得几何"只在 heading=0 时对" */
const HEADINGS = [0, 0.7, -Math.PI / 2, 2.9, -2.3];

const arc = (): Arc => ({ center: 0, half: 0 });

/** 角度相等:比较折回后的差 —— 否则 +π 与 -π 这两个同一方向会被判成不等 */
const expectAngle = (got: number, want: number): void => {
  expect(wrapAngle(got - want)).toBeCloseTo(0, 9);
};

/**
 * 用字符画建甲板(与 deck.test.ts 同一份 helper,刻意各留一份而不是互相 export):
 * 一个字符串一行(row 0 在最上 = 最靠船头),'#' = 属于船体,'.' = 洞或船体外。
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

describe('弧度档位表(GDD §4.2)', () => {
  it('五档数值照抄 GDD §4.2 的表', () => {
    expect(ARC_VERY_NARROW_DEG).toBe(30); // 磁轨炮
    expect(ARC_NARROW_DEG).toBe(60); // 等离子迫击炮
    expect(ARC_MEDIUM_DEG).toBe(100); // 自动机炮
    expect(ARC_WIDE_DEG).toBe(150); // 电弧塔 / 点防阵列
    expect(ARC_OMNI_DEG).toBe(360); // 导弹巢(接口预留,MVP 不用)
    expect(ARC_WIDEN_PER_EDGE_DEG).toBe(60); // 角落格 +60°
  });

  it('档位表窄 → 广严格递增,且不含全向档(360 是例外而不是"更广的一档")', () => {
    expect(ARC_TIERS_DEG).toEqual([
      ARC_VERY_NARROW_DEG,
      ARC_NARROW_DEG,
      ARC_MEDIUM_DEG,
      ARC_WIDE_DEG,
    ]);
    for (let i = 1; i < ARC_TIERS_DEG.length; i++) {
      expect(ARC_TIERS_DEG[i]!).toBeGreaterThan(ARC_TIERS_DEG[i - 1]!);
    }
    expect(ARC_TIERS_DEG).not.toContain(ARC_OMNI_DEG);
  });
});

describe('arcHalfAngle:半角 = (弧度 + 每多一条暴露边 60°) / 2', () => {
  it('单条暴露边 = 档位的一半(每一档都验一遍)', () => {
    for (const deg of ARC_TIERS_DEG) {
      expect(arcHalfAngle(deg, 1)).toBeCloseTo((deg / 2) * DEG2RAD, 12);
    }
  });

  it('角落格 +60°;三条边按同一条规则外推 +120°', () => {
    expect(arcHalfAngle(ARC, 2)).toBeCloseTo(((ARC + 60) / 2) * DEG2RAD, 12);
    expect(arcHalfAngle(ARC, 3)).toBeCloseTo(((ARC + 120) / 2) * DEG2RAD, 12);
    expect(arcHalfAngle(ARC_NARROW_DEG, 2)).toBeCloseTo(((60 + 60) / 2) * DEG2RAD, 12);
  });

  it('夹到 π:加宽再多也就是全向,不会算出"半角 > 180°"这种自欺的数', () => {
    expect(arcHalfAngle(350, 2)).toBe(Math.PI); // (350+60)/2 = 205° → 夹回 180°
    expect(arcHalfAngle(ARC_WIDE_DEG, 4)).toBeCloseTo(((150 + 180) / 2) * DEG2RAD, 12); // 165°,没到顶
    expect(arcHalfAngle(ARC_WIDE_DEG, 4)).toBeLessThan(Math.PI);
  });

  it('全向档(≥360°)恒为 π,与暴露边数无关', () => {
    for (const n of [1, 2, 3, 4]) expect(arcHalfAngle(ARC_OMNI_DEG, n)).toBe(Math.PI);
    expect(arcHalfAngle(400, 1)).toBe(Math.PI);
  });
});

describe('cellArc:普通边缘格(只有一条暴露边)', () => {
  it('中心 = 那条边的世界法线,半角 = 弧度/2', () => {
    const deck = createDeck(); // 3×4 的 T0 拾荒艇
    const cases: [number, number, number][] = [
      [1, 0, EDGE_BOW], // 船头正中
      [1, 3, EDGE_STERN], // 船尾正中
      [0, 1, EDGE_PORT], // 左舷中段
      [2, 1, EDGE_STARBOARD], // 右舷中段
      [0, 2, EDGE_PORT],
      [2, 2, EDGE_STARBOARD],
    ];
    const out = arc();
    for (const h of HEADINGS) {
      for (const [col, row, edge] of cases) {
        const cell = cellAt(deck, col, row)!;
        expect(cell.exposedCount).toBe(1); // 先确认夹具确实是"普通边缘格"
        expect(cellArc(cell, h, ARC, out)).toBe(true);
        expectAngle(out.center, edgeWorldNormal(edge, h));
        expect(out.half).toBeCloseTo((ARC / 2) * DEG2RAD, 12);
      }
    }
  });

  it('唯一那条暴露边朝洞时,射界就指向船体内侧(几何只认掩码,不认"朝外")', () => {
    // 12 号扩建挖出的天井炮位:暴露边是纯局部邻接判定(03 号口径,不做可达性洪水填充),
    // 朝洞的那条边照样架得住炮 —— 于是这一格的射界指向船体内部。这不是漏判,是那条口径的必然结论,
    // 钉住它是为了将来有人"顺手"给 cellArc 补一个朝外性修正时,这里当场红给他看。
    const deck = deckFrom([
      '#####', //
      '#####',
      '##.##',
      '#####',
      '#####',
    ]);
    const cell = cellAt(deck, 2, 1)!; // 洞正在它的船尾侧
    expect(cell.exposedCount).toBe(1);
    const out = arc();
    for (const h of HEADINGS) {
      expect(cellArc(cell, h, ARC, out)).toBe(true);
      expectAngle(out.center, edgeWorldNormal(EDGE_STERN, h));
      expect(out.half).toBeCloseTo((ARC / 2) * DEG2RAD, 12);
    }
  });

  it('随船体朝向整体旋转,半角不随朝向变(转船就是转射界,这是 P1 的机制载体)', () => {
    const deck = createDeck();
    const a0 = arc();
    const a1 = arc();
    const h0 = 0.3;
    const h1 = h0 + 1.1;
    for (const cell of deck.cells) {
      if (!cellArc(cell, h0, ARC, a0)) continue; // 内部格没有射界,跳过
      expect(cellArc(cell, h1, ARC, a1)).toBe(true);
      expectAngle(wrapAngle(a1.center - a0.center), h1 - h0);
      expect(a1.half).toBe(a0.half);
    }
  });
});

describe('cellArc:角落格(两条正交暴露边)', () => {
  it('中心 = 两条法线的角平分线,弧度 +60°(GDD §4.2)', () => {
    const deck = createDeck();
    // 四个角相对船头的角平分线方向:左前 -45°、右前 +45°、左后 -135°、右后 +135°
    const cases: [number, number, number][] = [
      [0, 0, -Math.PI / 4],
      [2, 0, Math.PI / 4],
      [0, 3, (-3 * Math.PI) / 4],
      [2, 3, (3 * Math.PI) / 4],
    ];
    const out = arc();
    for (const h of HEADINGS) {
      for (const [col, row, offset] of cases) {
        const cell = cellAt(deck, col, row)!;
        expect(isCornerCell(cell)).toBe(true);
        expect(cellArc(cell, h, ARC, out)).toBe(true);
        expectAngle(out.center, wrapAngle(h + offset));
        expect(out.half).toBeCloseTo(((ARC + ARC_WIDEN_PER_EDGE_DEG) / 2) * DEG2RAD, 12);
      }
    }
  });

  it('角落格确实比同型的普通边缘格宽 60°(天然优质炮位)', () => {
    const deck = createDeck();
    const corner = arc();
    const plain = arc();
    cellArc(cellAt(deck, 0, 0)!, 0.4, ARC, corner);
    cellArc(cellAt(deck, 1, 0)!, 0.4, ARC, plain);
    expect(corner.half - plain.half).toBeCloseTo((ARC_WIDEN_PER_EDGE_DEG / 2) * DEG2RAD, 12);
  });

  it('跨 ±π:向量和给出正确的中心,对角度取平均会差整整 180°', () => {
    // 船朝 80° 时右后角(STERN|STARBOARD)的两条世界法线是 -100° 与 +170° —— 跨了 ±π。
    // 正确中心 -145°;把两个角度直接平均得到 (-100+170)/2 = +35°,恰好指向船体另一侧。
    // 这条用例是 cellArc 用"单位向量和 + atan2"而不是"角度平均"的唯一拦网,删了它就没人拦得住。
    const deck = createDeck();
    const cell = cellAt(deck, 2, 3)!;
    const h = 80 * DEG2RAD;
    expectAngle(edgeWorldNormal(EDGE_STERN, h), -100 * DEG2RAD);
    expectAngle(edgeWorldNormal(EDGE_STARBOARD, h), 170 * DEG2RAD);

    const out = arc();
    expect(cellArc(cell, h, ARC, out)).toBe(true);
    expectAngle(out.center, -145 * DEG2RAD);
    // 反向钉死:与"角度平均"的结果差半圈,不是差一点点浮点
    expect(Math.abs(wrapAngle(out.center - 35 * DEG2RAD))).toBeCloseTo(Math.PI, 9);
  });
});

describe('cellArc:多暴露边(12 号扩建焊出的凹形轮廓)', () => {
  it('三条边:左右两条相消,中心 = 剩下那条的法线,半角 +120°', () => {
    // L 形的竖条顶端:船头、左舷、右舷都临空,只有船尾接着自家甲板
    const deck = deckFrom([
      '#..', //
      '#..',
      '###',
    ]);
    const cell = cellAt(deck, 0, 0)!;
    expect(cell.exposedCount).toBe(3);
    const out = arc();
    for (const h of HEADINGS) {
      expect(cellArc(cell, h, ARC, out)).toBe(true);
      expectAngle(out.center, edgeWorldNormal(EDGE_BOW, h));
      expect(out.half).toBeCloseTo(((ARC + 2 * ARC_WIDEN_PER_EDGE_DEG) / 2) * DEG2RAD, 12);
    }
  });

  it('L 形的拐角仍是标准角落格:船尾 + 左舷的角平分线', () => {
    const deck = deckFrom(['#..', '#..', '###']);
    const cell = cellAt(deck, 0, 2)!;
    expect(isCornerCell(cell)).toBe(true);
    const out = arc();
    const h = -2.3;
    expect(cellArc(cell, h, ARC, out)).toBe(true);
    expectAngle(out.center, wrapAngle(h + (-3 * Math.PI) / 4)); // 左后 -135°
    expect(out.half).toBeCloseTo(((ARC + 60) / 2) * DEG2RAD, 12);
  });

  it('U 形凹口的臂中段(左右舷对边)走退化分支:取最低位那条边、且不加宽', () => {
    const deck = deckFrom([
      '#.#', //
      '#.#',
      '###',
    ]);
    const cell = cellAt(deck, 0, 1)!;
    expect(cell.exposedCount).toBe(2);
    expect(isCornerCell(cell)).toBe(false); // 两条边,但是对边
    const out = arc();
    for (const h of HEADINGS) {
      expect(cellArc(cell, h, ARC, out)).toBe(true);
      // 掩码最低位:STARBOARD(1)< PORT(3)。双瓣射界表达不了,取一瓣且按 1 条边算宽度
      expectAngle(out.center, edgeWorldNormal(EDGE_STARBOARD, h));
      expect(out.half).toBeCloseTo((ARC / 2) * DEG2RAD, 12);
    }
  });

  it('甜甜圈中心带洞:朝洞那条边算暴露,与外侧边构成对边 → 同样走退化分支', () => {
    const deck = deckFrom([
      '###', //
      '#.#',
      '###',
    ]);
    const cell = cellAt(deck, 1, 0)!;
    expect(cell.exposedCount).toBe(2);
    const out = arc();
    const h = 0.7;
    expect(cellArc(cell, h, ARC, out)).toBe(true);
    expectAngle(out.center, edgeWorldNormal(EDGE_BOW, h)); // BOW(0)是最低位
    expect(out.half).toBeCloseTo((ARC / 2) * DEG2RAD, 12);
  });
});

describe('cellArc:退化与"压根没有射界"', () => {
  it('1×4 单列的中段(左右舷对边):中心 = 右舷法线,不加宽', () => {
    const deck = createDeck(1, 4);
    const cell = cellAt(deck, 0, 1)!;
    expect(cell.exposedCount).toBe(2);
    const out = arc();
    for (const h of HEADINGS) {
      expect(cellArc(cell, h, ARC, out)).toBe(true);
      expectAngle(out.center, edgeWorldNormal(EDGE_STARBOARD, h));
      expect(out.half).toBeCloseTo((ARC / 2) * DEG2RAD, 12);
    }
  });

  it('1×1 四面临空:半角 = π,中心 = 船头朝向,射界覆盖整个圆周', () => {
    const deck = createDeck(1, 1);
    const cell = deck.cells[0]!;
    expect(cell.exposedCount).toBe(4);
    const out = arc();
    for (const h of HEADINGS) {
      expect(cellArc(cell, h, ARC, out)).toBe(true);
      expect(out.half).toBe(Math.PI);
      expectAngle(out.center, h);
      // 全向:任何方位都打得到,含 ±π 两端
      for (let a = -180; a <= 180; a += 15) expect(arcContains(out, a * DEG2RAD)).toBe(true);
    }
  });

  it('内部格 / 洞 / 被围死的离线塔:返回 false,且 out 一个字段都不改', () => {
    const deck = createDeck();
    const interior = cellAt(deck, 1, 1)!;
    expect(isInteriorCell(interior)).toBe(true);

    // 哨兵值:false 之后调用方会直接跳过这一格,函数绝不能顺手把上一格的结果抹掉
    const out: Arc = { center: 12345, half: 678 };
    expect(cellArc(interior, 0.7, ARC, out)).toBe(false);
    expect(out.center).toBe(12345);
    expect(out.half).toBe(678);

    const donut = deckFrom(['###', '#.#', '###']);
    expect(cellArc(cellAt(donut, 1, 1)!, 0, ARC, out)).toBe(false); // 洞不属于船体

    // 12 号扩建把炮位焊成内脏位:塔还在、但没有暴露边 → 没有射界(灰显不开火,GDD §4.1)
    const strip = deckFrom(['.#.', '.#.', '.#.']);
    expect(placeAt(strip, 1, 1, CELL_WEAPON)).toBe(PLACE_OK);
    setOccupied(strip, 0, 1, true);
    setOccupied(strip, 2, 1, true);
    const buried = cellAt(strip, 1, 1)!;
    expect(buried.content).toBe(CELL_WEAPON);
    expect(cellArc(buried, 0, ARC, out)).toBe(false);
    expect(out.center).toBe(12345);
  });
});

/**
 * 渲染层画 Tab 扇形时传 heading = 0 拿**船体局部**几何,再把整块甲板作为一个 Container
 * 跟着插值位姿一起转。这条"局部 + heading = 世界"的等式正是那种画法成立的前提,
 * 也是 04 验收标准第三条(船旋转时射界实时跟随、无一帧延迟撕裂感)在 sim 侧的口径:
 * 射界压根没有状态,世界朝向每次都由 heading 现算 —— 结构上就不存在"晚一帧"的地方。
 * 退化分支(对边 / 四面暴露)也必须满足,否则异形甲板上的扇形会在转船时原地打滑。
 */
describe('局部射界 ↔ 世界射界(渲染层的取法)', () => {
  it('任意形状 × 任意朝向:世界中心 = 局部中心 + heading,半角与朝向无关', () => {
    const shapes: Deck[] = [
      createDeck(), // 3×4:普通边缘格 + 四个角落格
      deckFrom(['#..', '#..', '###']), // L 形:三条暴露边的凹形轮廓
      deckFrom(['###', '#.#', '###']), // 甜甜圈:朝洞的对边退化
      createDeck(1, 4), // 单列:左右舷对边退化
      createDeck(1, 1), // 四面临空:全向退化
    ];
    const localArc = arc();
    const worldArc = arc();
    for (const deck of shapes) {
      for (const cell of deck.cells) {
        if (!cellArc(cell, 0, ARC, localArc)) continue; // 内部格 / 洞:没有射界
        for (const h of HEADINGS) {
          expect(cellArc(cell, h, ARC, worldArc)).toBe(true);
          expectAngle(worldArc.center, localArc.center + h);
          expect(worldArc.half).toBe(localArc.half); // 半角逐位相同:朝向根本没进这条算式
        }
      }
    }
  });
});

describe('arcContains', () => {
  it('含边界:恰好落在扇形边线上算打得到(可视化的扇形 = 可命中区域)', () => {
    // 刻意取 center = 0:边界那一下钉的是 "<=" 而不是 "<",
    // 不该被 wrapAngle 往返的 1 ulp 误差搅成随机结果(真正的"外面"用 1e-6 表示)
    const a: Arc = { center: 0, half: 50 * DEG2RAD };
    expect(arcContains(a, a.half)).toBe(true);
    expect(arcContains(a, -a.half)).toBe(true);
    expect(arcContains(a, a.half + 1e-6)).toBe(false);
    expect(arcContains(a, -a.half - 1e-6)).toBe(false);
  });

  it('跨 ±π 的扇形照样判得对(角度差必须先折回)', () => {
    const a: Arc = { center: 175 * DEG2RAD, half: 10 * DEG2RAD };
    expect(arcContains(a, 179 * DEG2RAD)).toBe(true);
    expect(arcContains(a, -179 * DEG2RAD)).toBe(true); // = +181°,离中心才 6°
    expect(arcContains(a, -176 * DEG2RAD)).toBe(true); // = +184°,离中心 9°,还在里面
    expect(arcContains(a, -170 * DEG2RAD)).toBe(false); // = +190°,离中心 15°,已经出界
    expect(arcContains(a, 160 * DEG2RAD)).toBe(false);
    expect(arcContains(a, 0)).toBe(false);
  });

  it('塔只覆盖自己那一舷:船头格打不到船尾方向,反之亦然', () => {
    const deck = createDeck();
    const bow = arc();
    const stern = arc();
    const h = 0.7;
    cellArc(cellAt(deck, 1, 0)!, h, ARC, bow);
    cellArc(cellAt(deck, 1, 3)!, h, ARC, stern);
    expect(arcContains(bow, h)).toBe(true); // 正前方
    expect(arcContains(bow, wrapAngle(h + Math.PI))).toBe(false); // 正后方
    expect(arcContains(stern, wrapAngle(h + Math.PI))).toBe(true);
    expect(arcContains(stern, h)).toBe(false);
    // 100° 的塔连正侧方(±90°)都够不着:半角只有 50°
    expect(arcContains(bow, wrapAngle(h + Math.PI / 2))).toBe(false);
  });

  it('全向档:任何方位都算在射界内(360° 的接口预留就靠 half = π 自然成立)', () => {
    const deck = createDeck();
    const out = arc();
    expect(cellArc(cellAt(deck, 1, 0)!, 0.7, ARC_OMNI_DEG, out)).toBe(true);
    expect(out.half).toBe(Math.PI);
    for (let a = -180; a <= 180; a += 10) expect(arcContains(out, a * DEG2RAD)).toBe(true);
  });
});

describe('isTurretCell', () => {
  it('只有"在线的武器塔"才算塔:空格 / 支援设施 / 被围死的塔一律不是', () => {
    const deck = createDeck();
    expect(isTurretCell(cellAt(deck, 0, 0)!)).toBe(false); // 空的边缘格
    placeAt(deck, 0, 0, CELL_WEAPON);
    expect(isTurretCell(cellAt(deck, 0, 0)!)).toBe(true);
    placeAt(deck, 1, 1, CELL_SUPPORT); // 内部格上的供能设施:在线,但不开火
    expect(isTurretCell(cellAt(deck, 1, 1)!)).toBe(false);

    const strip = deckFrom(['.#.', '.#.', '.#.']);
    placeAt(strip, 1, 1, CELL_WEAPON);
    const mid = cellAt(strip, 1, 1)!;
    expect(isTurretCell(mid)).toBe(true);
    setOccupied(strip, 0, 1, true);
    setOccupied(strip, 2, 1, true); // 四面焊死 → online 变 false
    expect(isTurretCell(mid)).toBe(false);
  });
});

/**
 * 索敌(04 任务"目标过滤":塔只索敌射界扇形 ∩ 射程圆内的目标)。
 * 这里刻意用**手写的 Arc** 而不是某一格的射界:目标过滤的规则与甲板拓扑无关,
 * 混进一格真实几何只会让"选错人"的失败信息里多一层要先排除的嫌疑。
 * 扇形几何本身在上面各 describe 里已经钉死。
 */
describe('findArcTarget:射界 ∩ 射程内最近优先', () => {
  /** 只有位置与生死是这个函数看的字段,其余一律走池 factory 的初值(绝不手搓半个 Enemy) */
  const foe = (x: number, y: number): Enemy => {
    const e = createEnemy();
    e.x = x;
    e.y = y;
    return e;
  };

  /** 正前方 ±45°、射程 100 的塔,炮位在原点 */
  const ARC45: Arc = { center: 0, half: Math.PI / 4 };
  const RANGE = 100;

  it('射界外、射程外、背后的敌人一律不被选', () => {
    expect(findArcTarget([foe(150, 0)], 0, 0, ARC45, RANGE)).toBe(null); // 方位对,但太远
    expect(findArcTarget([foe(0, 50)], 0, 0, ARC45, RANGE)).toBe(null); // 距离够,但 90° 出界
    expect(findArcTarget([foe(-50, 0)], 0, 0, ARC45, RANGE)).toBe(null); // 正后方:转过去也不许打
    expect(findArcTarget([], 0, 0, ARC45, RANGE)).toBe(null); // 空候选(哈希这一带没人)
    expect(findArcTarget([foe(50, 0)], 0, 0, ARC45, RANGE)).not.toBe(null); // 反向确认夹具没写死
  });

  it('都在射界内时选最近的一只,且与候选顺序无关(哈希给的顺序不该改变结果)', () => {
    const near = foe(30, 5);
    const far = foe(80, 10);
    expect(findArcTarget([near, far], 0, 0, ARC45, RANGE)).toBe(near);
    expect(findArcTarget([far, near], 0, 0, ARC45, RANGE)).toBe(near);
  });

  it('近但在射界外的敌人不会挡住远处射界内的目标(过滤发生在比距离之后,不是"最近的那只再判方位")', () => {
    const blocker = foe(1, 40); // 距离 40,方位 88°:出界
    const real = foe(70, 0); // 距离 70,正前方
    expect(findArcTarget([blocker, real], 0, 0, ARC45, RANGE)).toBe(real);
  });

  it('同距保留先到者(严格 < 才替换)—— 索敌有歧义,确定性口径就作废了', () => {
    const a = foe(40, 10);
    const b = foe(40, -10); // 与 a 等距、镜像对称,两只都在射界内
    expect(findArcTarget([a, b], 0, 0, ARC45, RANGE)).toBe(a);
    expect(findArcTarget([b, a], 0, 0, ARC45, RANGE)).toBe(b);
  });

  it('跳过 dead:本帧被打死的敌人整帧还在场上(回收在 step 末尾),不跳过就会瞄着一具尸体', () => {
    const corpse = foe(20, 0);
    corpse.dead = true;
    const alive = foe(90, 0);
    expect(findArcTarget([corpse, alive], 0, 0, ARC45, RANGE)).toBe(alive);
    expect(findArcTarget([corpse], 0, 0, ARC45, RANGE)).toBe(null);
  });

  it('边界含在内:恰好落在射程圆上 / 扇形边线上都算打得到(Tab 画出来的就是可命中区域)', () => {
    const onRange = foe(RANGE, 0); // 距离恰好 = range
    expect(findArcTarget([onRange], 0, 0, ARC45, RANGE)).toBe(onRange);
    expect(findArcTarget([foe(RANGE + 1e-3, 0)], 0, 0, ARC45, RANGE)).toBe(null);

    // atan2(5,5) 逐位等于 π/4 = half,是真正的"边线上"而不是"差一点点"
    const onEdge = foe(5, 5);
    expect(Math.atan2(5, 5)).toBe(ARC45.half);
    expect(findArcTarget([onEdge], 0, 0, ARC45, RANGE)).toBe(onEdge);
    expect(findArcTarget([foe(5, 5.001)], 0, 0, ARC45, RANGE)).toBe(null);
  });

  it('炮位不是船心:同一只敌人,换个炮位就可能落到射程外(舷侧塔与船心差着大半个船长)', () => {
    const e = foe(0, 0);
    expect(findArcTarget([e], -90, 0, { center: 0, half: Math.PI / 4 }, RANGE)).toBe(e);
    expect(findArcTarget([e], -110, 0, { center: 0, half: Math.PI / 4 }, RANGE)).toBe(null);
  });

  it('全向档(half = π):任何方位的最近者都选得中', () => {
    const omni: Arc = { center: 0, half: Math.PI };
    const behind = foe(-30, 0);
    expect(findArcTarget([foe(60, 0), behind], 0, 0, omni, RANGE)).toBe(behind);
  });
});
