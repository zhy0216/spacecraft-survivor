/**
 * 船体受击判定几何(09 号 issue T1)。本文件在 Node 里跑通本身就是铁律 1 的一层验证:
 * "蹭到了没有、撞在哪一舷、哪座塔正在挨罚"只由船位姿 + 甲板拓扑 + 一个点和它的体型半径决定,
 * 不碰 Pixi/DOM,也不需要一整个 World —— 一艘船 + 一块甲板就能把每一条边界钉住。
 *
 * 钉的几条口径(改坏就等于改坏了 09 的验收标准):
 *   **核心区不随扩建变大**(GDD §4.4)—— 5×6 甲板下核心区一格不变、甲板轮廓却跟着长,
 *     这是"判定体与甲板渲染解耦"这件事唯一看得见的形式,damage.ts 存在的全部理由;
 *   classifyHit 三层各归各、**含边界**、radius 按两轴外扩,且**先核心后轮廓** ——
 *     最后这条是 World 那边"核心区里的敌人永远走不进火花分支"的前提;
 *   四舷 = 相对船头的四个象限,**每条边界归顺时针方向的那一舷**(±45° / ±135° 四个点逐个钉),
 *     且随船一起转;接触点压在船心上时恒归 BOW,不随朝向漂移;
 *   塔的舷向归属**走暴露边不走方位角**,角落格同时属于两舷 —— 连同"为什么不能每格只挑一条边"
 *     的那个理由(3×4 下 PORT/STERN 会瘪成 2 格)一起钉,免得将来有人"顺手简化"回去;
 *   06 号两个挂钩(hullMaxHp / edgeDamageMul)MVP 的恒定返回值 —— 06 只该改函数体,不该改签名。
 *
 * 参数在文件顶部显式写死并 afterEach 还原(照 ship.test.ts / deck.test.ts 的做法):
 * shipCoreScale 的 0.72 是占位待调的数,平衡一动,断言里那些算得清的整数就全没了。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { tuning } from './config';
import {
  cellFireRateMul,
  classifyHit,
  deckHalfExtents,
  deckOuterRadius,
  edgeDamageMul,
  HIT_CORE,
  HIT_GRAZE,
  HIT_NONE,
  hitBroadside,
  hullCoreHalfExtents,
  hullMaxHp,
} from './damage';
import {
  cellAt,
  createDeck,
  DECK_COLS,
  DECK_ROWS,
  type Deck,
  deckCellSize,
  EDGE_BOW,
  EDGE_COUNT,
  EDGE_PORT,
  EDGE_STARBOARD,
  EDGE_STERN,
  isEdgeExposed,
} from './deck';
import { createShip, DEG2RAD, type Ship, type Vec2 } from './ship';

const BASE = {
  shipLength: 160, // ÷ 4 行 = 40
  shipWidth: 120, // ÷ 3 列 = 40 —— 两轴同为 40,格边长是整数,半长/半宽才算得清
  shipCoreScale: 0.75, // × 40 = 30 的核心格边长 → 核心区半长 60、半宽 45(config 的 0.72 是占位)
  shipHullHp: 100,
  hitFireRateMul: 0.75,
  hitPenaltyTime: 0.5,
};
Object.assign(tuning, BASE);
// 有用例会拖 shipCoreScale / hitFireRateMul 来验证"每次现读",跑完必须还原,否则污染同文件后续用例
afterEach(() => Object.assign(tuning, BASE));

/** 3×4 甲板下的四个数,全文的算术基准。写成常量是为了让断言里的 60/45/80/100 有名字 */
const CORE_HALF_LEN = 60; // DECK_ROWS(4)× 30 / 2
const CORE_HALF_WID = 45; // DECK_COLS(3)× 30 / 2
const DECK_HALF_LEN = 80; // DECK_ROWS(4)× 40 / 2
const DECK_HALF_WID = 60; // DECK_COLS(3)× 40 / 2

const v = (): Vec2 => ({ x: 0, y: 0 });

const shipAt = (x: number, y: number, heading: number): Ship => {
  const ship = createShip();
  ship.x = x;
  ship.px = x;
  ship.y = y;
  ship.py = y;
  ship.heading = heading;
  ship.pheading = heading;
  return ship;
};

/**
 * 船体局部点 → 世界坐标。刻意在这里重写一遍 deck.cellWorldPosAt 那条变换(而不是 import 它):
 * 被测代码走的是它的**逆**(转置旋转),两边各写各的,某一侧把 sin 的符号写反才不会一起错。
 * 暂存复用而不是每次现造:与被测模块同口径,顺带保证断言读的就是刚写的那一份。
 */
const wp: Vec2 = { x: 0, y: 0 };
const worldOf = (ship: Ship, lx: number, ly: number): Vec2 => {
  const cos = Math.cos(ship.heading);
  const sin = Math.sin(ship.heading);
  wp.x = ship.x + lx * cos - ly * sin;
  wp.y = ship.y + lx * sin + ly * cos;
  return wp;
};

/** 用船体局部坐标问分层:船摆在哪、朝哪都不必改断言 */
const classifyLocal = (ship: Ship, deck: Deck, lx: number, ly: number, radius = 0): number => {
  const p = worldOf(ship, lx, ly);
  return classifyHit(ship, deck, p.x, p.y, radius);
};

/**
 * 几个互不对称的位姿:含原点 + heading 0(基准)、含负角、含跨 ±π 的邻域。
 * 几何"只在船停在原点朝右时对"是最容易漏的一类错,而它在真机上表现为"船一转就判歪"。
 */
const POSES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [310, -120, 0.9],
  [-77.5, 640, -Math.PI / 2],
  [1200, 1200, 2.9],
  [-500, -3, -2.3],
];

/** 只有指定的那几条舷在惩罚中的四元组(下标 = EDGE_*) */
const penalty = (...edges: number[]): number[] => {
  const p = new Array<number>(EDGE_COUNT).fill(0);
  for (const e of edges) p[e] = tuning.hitPenaltyTime;
  return p;
};

describe('HIT_* 三层', () => {
  it('三个常量互不相等,HIT_NONE = 0', () => {
    // 调用方(World 结算、渲染层分派)全靠这三个值分支;HIT_NONE 取 0 让"什么都没发生"是自然值
    expect(new Set([HIT_NONE, HIT_GRAZE, HIT_CORE]).size).toBe(3);
    expect(HIT_NONE).toBe(0);
  });
});

describe('hullCoreHalfExtents / deckHalfExtents(判定体与甲板轮廓的分家,GDD §4.4)', () => {
  it('核心区 = 初始 3×4 包围盒 × shipCoreScale / 2,x 沿船长、y 沿船宽', () => {
    const out = v();
    expect(hullCoreHalfExtents(out)).toBe(out); // 写进调用方给的 out 并原样返回(铁律 3)

    const s = deckCellSize() * tuning.shipCoreScale;
    expect(out.x).toBeCloseTo((DECK_ROWS * s) / 2, 12);
    expect(out.y).toBeCloseTo((DECK_COLS * s) / 2, 12);
    expect(out.x).toBeCloseTo(CORE_HALF_LEN, 12);
    expect(out.y).toBeCloseTo(CORE_HALF_WID, 12);
    // 半长 > 半宽:3×4 的船是条长条,反过来就说明行列口径接反了(x/y 谁是船长这件事只有这一处约定)
    expect(out.x).toBeGreaterThan(out.y);
  });

  it('12 号扩建后核心区一格都不变大,甲板轮廓却跟着长(GDD §4.4 的全部实现)', () => {
    const small = createDeck(); // T0 拾荒艇 3×4
    const big = createDeck(5, 6); // 12 号焊上一圈之后

    // 核心区按 DECK_ROWS/DECK_COLS 两个**常量**算(签名里压根没有 deck 这个参数),
    // 于是"不随扩建变大"这件事在这一层是结构性的;它真正的行为形式在 classifyHit 那一组:
    // 核心区边线外一格的点,在 3×4 与 5×6 上同样进不了核心
    const core = v();
    hullCoreHalfExtents(core);
    expect(core).toEqual({ x: CORE_HALF_LEN, y: CORE_HALF_WID });

    const a = v();
    const b = v();
    deckHalfExtents(small, a);
    deckHalfExtents(big, b);
    expect(a).toEqual({ x: DECK_HALF_LEN, y: DECK_HALF_WID });
    expect(b).toEqual({ x: (6 * 40) / 2, y: (5 * 40) / 2 }); // 格边长恒按 3×4 算,扩建不改格子大小
    expect(b.x).toBeGreaterThan(a.x);
    expect(b.y).toBeGreaterThan(a.y);

    // 核心区恒被轮廓罩住(shipCoreScale < 1),否则"蹭到甲板但没伤害"那一层根本没有存在的余地
    expect(core.x).toBeLessThan(a.x);
    expect(core.y).toBeLessThan(a.y);
  });

  it('两者都每次现读 tuning:拖 shipCoreScale 立刻改判定面积', () => {
    const out = v();

    tuning.shipCoreScale = 0.5;
    hullCoreHalfExtents(out);
    expect(out.x).toBeCloseTo((DECK_ROWS * deckCellSize() * 0.5) / 2, 12);

    // scale = 1 正好退化成甲板包围盒本身:核心区与 3×4 轮廓重合,擦碰那一层被挤没 ——
    // 这条同时说明了 shipCoreScale 到底是"相对什么"的比例
    tuning.shipCoreScale = 1;
    hullCoreHalfExtents(out);
    const deckOut = v();
    deckHalfExtents(createDeck(), deckOut);
    expect(out).toEqual(deckOut);
  });

  it('deckOuterRadius = 外接圆,粗筛必然罩得住两层判定', () => {
    const deck = createDeck();
    const h = v();
    deckHalfExtents(deck, h);

    expect(deckOuterRadius(deck)).toBeCloseTo(Math.hypot(h.x, h.y), 12);
    expect(deckOuterRadius(deck)).toBeCloseTo(100, 12); // hypot(80, 60)
    // 粗筛宁大勿小:外接半径必须比两轴半长都大,否则贴着甲板四角进来的那一圈敌人会在粗筛里漏掉
    expect(deckOuterRadius(deck)).toBeGreaterThan(h.x);
    expect(deckOuterRadius(deck)).toBeGreaterThan(h.y);
    // 随扩建一起长(与核心区正相反):它筛的是"可能蹭到甲板"的人,而甲板确实变大了
    expect(deckOuterRadius(createDeck(5, 6))).toBeGreaterThan(deckOuterRadius(deck));
  });

  it('classifyHit 不动调用方的 out —— 模块内那份暂存是私有的', () => {
    const mine = v();
    hullCoreHalfExtents(mine);
    const snapshot = { ...mine };
    classifyHit(shipAt(0, 0, 0), createDeck(), 999, 999, 0);
    expect(mine).toEqual(snapshot);
  });
});

describe('classifyHit(核心区 / 甲板轮廓 / 没碰上)', () => {
  it('三层各归各:船心 = 核心,核心外的甲板 = 擦碰,甲板外 = 没碰上', () => {
    const deck = createDeck();
    const ship = shipAt(0, 0, 0);

    expect(classifyHit(ship, deck, 0, 0, 0)).toBe(HIT_CORE);
    expect(classifyHit(ship, deck, 70, 0, 0)).toBe(HIT_GRAZE); // 60 < 70 < 80
    expect(classifyHit(ship, deck, 0, 50, 0)).toBe(HIT_GRAZE); // 45 < 50 < 60
    expect(classifyHit(ship, deck, 90, 0, 0)).toBe(HIT_NONE);
    expect(classifyHit(ship, deck, 0, 70, 0)).toBe(HIT_NONE);
  });

  it('含边界:恰好落在边线上算碰上(与 arcContains / findArcTarget 同口径)', () => {
    const deck = createDeck();
    const ship = shipAt(0, 0, 0);

    expect(classifyHit(ship, deck, CORE_HALF_LEN, 0, 0)).toBe(HIT_CORE);
    expect(classifyHit(ship, deck, 0, CORE_HALF_WID, 0)).toBe(HIT_CORE);
    expect(classifyHit(ship, deck, CORE_HALF_LEN, CORE_HALF_WID, 0)).toBe(HIT_CORE); // 核心区的角
    expect(classifyHit(ship, deck, -CORE_HALF_LEN, -CORE_HALF_WID, 0)).toBe(HIT_CORE); // 两轴都取绝对值
    // 差一丁点就掉出去:边界是"≤",不是"< 再加一点容差"
    expect(classifyHit(ship, deck, CORE_HALF_LEN + 1e-9, 0, 0)).toBe(HIT_GRAZE);

    expect(classifyHit(ship, deck, DECK_HALF_LEN, 0, 0)).toBe(HIT_GRAZE);
    expect(classifyHit(ship, deck, DECK_HALF_LEN, DECK_HALF_WID, 0)).toBe(HIT_GRAZE); // 甲板的角
    expect(classifyHit(ship, deck, DECK_HALF_LEN + 1e-9, DECK_HALF_WID, 0)).toBe(HIT_NONE);
  });

  it('radius 把两层矩形各自外扩:大个子更早算碰上', () => {
    const deck = createDeck();
    const ship = shipAt(0, 0, 0);

    expect(classifyHit(ship, deck, 70, 0, 9)).toBe(HIT_GRAZE); // 60 + 9 = 69 < 70,还差一点
    expect(classifyHit(ship, deck, 70, 0, 10)).toBe(HIT_CORE); // 恰好贴上 = 碰上(含边界)
    expect(classifyHit(ship, deck, 90, 0, 0)).toBe(HIT_NONE);
    expect(classifyHit(ship, deck, 90, 0, 10)).toBe(HIT_GRAZE); // 80 + 10 = 90
    // 两轴各自加 radius(矩形外扩,不是量到中心的圆):只在船宽方向超界的点也吃得到体型
    expect(classifyHit(ship, deck, 0, 65, 0)).toBe(HIT_NONE);
    expect(classifyHit(ship, deck, 0, 65, 5)).toBe(HIT_GRAZE);
  });

  it('先核心后轮廓:核心区里的点永远走不进擦碰(World 的火花分支靠这条)', () => {
    const deck = createDeck();
    const ship = shipAt(0, 0, 0);

    // 扫一遍整个核心区(含四条边线),一个 HIT_GRAZE 都不许出现 ——
    // 顺序一旦反过来,"贴在船心的蜂群只出火花不掉血",而那种 bug 在真机上极难看出来
    for (let lx = -CORE_HALF_LEN; lx <= CORE_HALF_LEN; lx += 10) {
      for (let ly = -CORE_HALF_WID; ly <= CORE_HALF_WID; ly += 9) {
        expect(classifyHit(ship, deck, lx, ly, 0)).toBe(HIT_CORE);
      }
    }
    // 带体型的也一样:被 radius 外扩进核心的点,不会因为它同时也在甲板里就退回擦碰
    expect(classifyHit(ship, deck, DECK_HALF_LEN, 0, 20)).toBe(HIT_CORE);
  });

  it('判定体跟着船转:换位姿后同一批局部点的分层一字不变', () => {
    const deck = createDeck();
    // [局部 x, 局部 y, 体型半径, 期望分层] —— 在"船停原点朝右"时定下,每个位姿都得给同一个答案。
    // 每条都留了 ≥ 1 的余量:旋转往返的浮点残差在 1e-13 量级,钉边界是另一条用例的事
    const CASES: ReadonlyArray<readonly [number, number, number, number]> = [
      [0, 0, 0, HIT_CORE],
      [59, 44, 0, HIT_CORE],
      [-59, -44, 0, HIT_CORE],
      [70, 0, 0, HIT_GRAZE],
      [0, 55, 0, HIT_GRAZE],
      [-79, -59, 0, HIT_GRAZE],
      [95, 0, 0, HIT_NONE],
      [0, -70, 0, HIT_NONE],
      [66, 0, 8, HIT_CORE], // 带体型的也一起转
      [90, 0, 12, HIT_GRAZE],
    ];

    for (const [x, y, heading] of POSES) {
      const ship = shipAt(x, y, heading);
      for (const [lx, ly, r, want] of CASES) {
        expect(classifyLocal(ship, deck, lx, ly, r)).toBe(want);
      }
    }
  });

  it('扩建只让擦碰区变大:同一个点在 5×6 上是擦碰、在 3×4 上压根没碰上,核心那层两边一模一样', () => {
    const ship = shipAt(0, 0, 0);
    const small = createDeck();
    const big = createDeck(5, 6); // 半长 120、半宽 100

    expect(classifyHit(ship, small, 100, 0, 0)).toBe(HIT_NONE);
    expect(classifyHit(ship, big, 100, 0, 0)).toBe(HIT_GRAZE);
    expect(classifyHit(ship, small, 0, 80, 0)).toBe(HIT_NONE);
    expect(classifyHit(ship, big, 0, 80, 0)).toBe(HIT_GRAZE);

    // GDD §4.4 的那一句:焊了两圈甲板,真正扣血的那块面积一点没变
    for (const [lx, ly] of [
      [0, 0],
      [CORE_HALF_LEN, CORE_HALF_WID],
      [CORE_HALF_LEN, 0],
      [0, CORE_HALF_WID],
    ] as const) {
      expect(classifyHit(ship, small, lx, ly, 0)).toBe(HIT_CORE);
      expect(classifyHit(ship, big, lx, ly, 0)).toBe(HIT_CORE);
    }
    for (const [lx, ly] of [
      [CORE_HALF_LEN + 1, 0],
      [0, CORE_HALF_WID + 1],
      [70, 30],
    ] as const) {
      expect(classifyHit(ship, small, lx, ly, 0)).not.toBe(HIT_CORE);
      expect(classifyHit(ship, big, lx, ly, 0)).not.toBe(HIT_CORE); // 扩建后照样进不了核心
    }
  });
});

describe('hitBroadside(四舷)', () => {
  it('四个正方向各归各舷(口径沿用 deck 的 EDGE_NORMAL:+X = 船头,+Y = 右舷)', () => {
    const ship = shipAt(0, 0, 0);
    expect(hitBroadside(ship, 10, 0)).toBe(EDGE_BOW);
    expect(hitBroadside(ship, 0, 10)).toBe(EDGE_STARBOARD);
    expect(hitBroadside(ship, -10, 0)).toBe(EDGE_STERN);
    expect(hitBroadside(ship, 0, -10)).toBe(EDGE_PORT);
  });

  it('±45° / ±135° 四条边界一律归顺时针方向的那一舷(无重叠、无空隙)', () => {
    const ship = shipAt(0, 0, 0);
    // 用 ±1 的整数点构造精确边界:atan2(±1, ±1) 与 ±π/4 / ±3π/4 逐位相等,
    // 不必让 DEG2RAD 的舍入掺进来 —— 这四个点就是"边界归谁"这件事的全部定义
    expect(hitBroadside(ship, 1, 1)).toBe(EDGE_STARBOARD); // +45°:让给 STARBOARD,不留给 BOW
    expect(hitBroadside(ship, 1, -1)).toBe(EDGE_BOW); // -45°:让给 BOW,不留给 PORT
    expect(hitBroadside(ship, -1, 1)).toBe(EDGE_STERN); // +135°:让给 STERN
    expect(hitBroadside(ship, -1, -1)).toBe(EDGE_PORT); // -135°:让给 PORT
    // atan2 值域上端那一个点(正后方 = +π)也得有主,否则正对船尾撞上来时哪一舷都不闪红
    expect(hitBroadside(ship, -1, 0)).toBe(EDGE_STERN);
  });

  it('整周扫描:每个方位角的归属与按象限分界的独立算法逐点一致', () => {
    const ship = shipAt(0, 0, 0);
    // 参考实现直接照设计约定的区间写(用度、不碰弧度),与 damage.ts 的判据各写各的:
    // 两边同时写歪的概率才够低。步长刻意错开 45 的整数倍 —— 边界点由上一条用例用精确整数点单独钉,
    // 这里不跟 cos/sin 往返的浮点残差较劲
    const ref = (deg: number): number => {
      if (deg >= -45 && deg < 45) return EDGE_BOW;
      if (deg >= 45 && deg < 135) return EDGE_STARBOARD;
      if (deg >= -135 && deg < -45) return EDGE_PORT;
      return EDGE_STERN;
    };

    const seen = new Set<number>();
    for (let deg = -179.75; deg < 180; deg += 0.5) {
      const a = deg * DEG2RAD;
      const got = hitBroadside(ship, Math.cos(a) * 37, Math.sin(a) * 37);
      expect(got).toBe(ref(deg));
      seen.add(got);
    }
    expect(seen.size).toBe(EDGE_COUNT); // 四舷都出现过 = 没有哪一舷被算成了空集
  });

  it('随船一起转:换位姿后同一批局部方向的舷向一字不变', () => {
    // 一律取象限中段(±26.6° / ±63.4° / ±116.6° / ±153.4°),离边界最远:
    // 旋转往返的浮点残差不该有资格改变归属,而边界点的归属是上面那条用例的事
    const DIRS: ReadonlyArray<readonly [number, number, number]> = [
      [2, -1, EDGE_BOW],
      [1, 0, EDGE_BOW],
      [2, 1, EDGE_BOW],
      [1, 2, EDGE_STARBOARD],
      [0, 1, EDGE_STARBOARD],
      [-1, 2, EDGE_STARBOARD],
      [-2, 1, EDGE_STERN],
      [-1, 0, EDGE_STERN],
      [-2, -1, EDGE_STERN],
      [-1, -2, EDGE_PORT],
      [0, -1, EDGE_PORT],
      [1, -2, EDGE_PORT],
    ];

    for (const [x, y, heading] of POSES) {
      const ship = shipAt(x, y, heading);
      for (const [lx, ly, want] of DIRS) {
        const p = worldOf(ship, lx * 40, ly * 40);
        expect(hitBroadside(ship, p.x, p.y)).toBe(want);
      }
    }
  });

  it('接触点压在船心上时恒归 BOW —— 不随朝向漂到任意一舷', () => {
    // 退化点。蜂群贴脸时这是天天发生的事,而它有**两个**独立的漂移来源,POSES 两个都覆盖:
    // 一、写成 wrapAngle(atan2(世界) - heading) 的话,同一个点会算出 -heading 而在四舷之间乱跳;
    // 二、就算先转回局部系,零的**符号位**仍由 heading 的 cos/sin 决定 ——
    //     heading = -2.3 时局部 x 是 -0,atan2(+0, -0) 给出 π,不提前判掉就会归到船尾去
    for (const [x, y, heading] of POSES) {
      const ship = shipAt(x, y, heading);
      expect(hitBroadside(ship, ship.x, ship.y)).toBe(EDGE_BOW);
    }
  });
});

describe('cellFireRateMul(塔的舷向归属走暴露边)', () => {
  it('角落格属于它两条暴露边所在的两舷:任一舷挨罚整格都变慢', () => {
    const deck = createDeck();
    const corner = cellAt(deck, 0, 0)!; // 船头左舷角:BOW | PORT
    expect(isEdgeExposed(corner, EDGE_BOW)).toBe(true);
    expect(isEdgeExposed(corner, EDGE_PORT)).toBe(true);

    expect(cellFireRateMul(corner, penalty(EDGE_BOW))).toBe(tuning.hitFireRateMul);
    expect(cellFireRateMul(corner, penalty(EDGE_PORT))).toBe(tuning.hitFireRateMul);
    // 两舷同时挨罚也只罚一次(不按舷数连乘):角落格两面临敌本就是它射界 +60° 的代价,
    // 让它挨两次罚才扣一次等于在补贴强位;而连乘会在两面受敌时直接造出死亡螺旋
    expect(cellFireRateMul(corner, penalty(EDGE_BOW, EDGE_PORT))).toBe(tuning.hitFireRateMul);
    // 不沾边的那两舷挨罚与它无关
    expect(cellFireRateMul(corner, penalty(EDGE_STARBOARD, EDGE_STERN))).toBe(1);
  });

  it('单边格只认自己那一条边;内部格(无暴露边)四舷全罚也恒 1', () => {
    const deck = createDeck();

    const bowOnly = cellAt(deck, 1, 0)!;
    expect(bowOnly.exposedCount).toBe(1);
    expect(cellFireRateMul(bowOnly, penalty(EDGE_BOW))).toBe(tuning.hitFireRateMul);
    expect(cellFireRateMul(bowOnly, penalty(EDGE_STARBOARD, EDGE_STERN, EDGE_PORT))).toBe(1);

    // 内部格挨不到打(GDD §4.1:四面被围),它也不开火 —— 但规则本身得说得清,不能靠"反正没塔"
    const interior = cellAt(deck, 1, 1)!;
    expect(interior.exposedCount).toBe(0);
    expect(
      cellFireRateMul(interior, penalty(EDGE_BOW, EDGE_STARBOARD, EDGE_STERN, EDGE_PORT)),
    ).toBe(1);
  });

  it('严格 > 0 才罚:计时器归零那一帧立刻恢复;倍率每次现读 tuning', () => {
    const deck = createDeck();
    const corner = cellAt(deck, 0, 0)!;
    const p = [0, 0, 0, 0];

    expect(cellFireRateMul(corner, p)).toBe(1);
    p[EDGE_BOW] = 1e-6; // 还剩一丁点也算在惩罚中(与 World 逐帧减 dt 夹 0 的口径配套)
    expect(cellFireRateMul(corner, p)).toBe(tuning.hitFireRateMul);
    tuning.hitFireRateMul = 0.4; // 面板拖一下立刻改体感,与 stepShip 那批同口径
    expect(cellFireRateMul(corner, p)).toBe(0.4);
    p[EDGE_BOW] = 0;
    expect(cellFireRateMul(corner, p)).toBe(1);
  });

  it('入参短于四元组也不炸:缺的那几舷当没在惩罚', () => {
    const corner = cellAt(createDeck(), 0, 0)!; // BOW | PORT
    expect(cellFireRateMul(corner, [])).toBe(1);
    expect(cellFireRateMul(corner, [tuning.hitPenaltyTime])).toBe(tuning.hitFireRateMul); // 只有 BOW
  });

  it('按暴露边归属,四舷各凑得满 3 座塔 —— 每格只挑一条边就办不到(不走方位角的理由)', () => {
    const deck = createDeck();
    const byExposed = new Array<number>(EDGE_COUNT).fill(0);
    const byLowest = new Array<number>(EDGE_COUNT).fill(0);
    for (const cell of deck.cells) {
      let lowest = -1;
      for (let e = 0; e < EDGE_COUNT; e++) {
        if (!isEdgeExposed(cell, e)) continue;
        byExposed[e] = (byExposed[e] ?? 0) + 1;
        if (lowest < 0) lowest = e;
      }
      if (lowest >= 0) byLowest[lowest] = (byLowest[lowest] ?? 0) + 1;
    }

    // 现行规则(cellFireRateMul 与 world.sink.fired 共用):BOW/STERN 各 3 格(3 列)、
    // PORT/STARBOARD 各 4 格(4 行)—— 每一舷都摆得下 3 座塔,broadside 反馈在四个舷上都活着
    expect(byExposed).toEqual([3, 4, 3, 4]);
    // 换成"每格只挑一条边"(lowestEdge / 按格心方位角都是这一类),PORT 与 STERN 当场瘪成 2 格:
    // 那两舷永远凑不满 3 座塔,一半的受击反馈直接死掉。这就是角落格必须同时属于两舷的原因
    expect(byLowest).toEqual([3, 3, 2, 2]);
  });
});

describe('06 号支援设施的两个挂钩(MVP 恒定,只有函数体待填)', () => {
  it('hullMaxHp 恒 = tuning.shipHullHp,与甲板大小无关', () => {
    expect(hullMaxHp(createDeck())).toBe(100); // GDD §14 锁定的初值
    expect(hullMaxHp(createDeck())).toBe(tuning.shipHullHp);
    // 装甲舱(GDD §5.3 的 +15)是 06 的活:今天焊多少格甲板都不该改变上限
    expect(hullMaxHp(createDeck(5, 6))).toBe(tuning.shipHullHp);

    tuning.shipHullHp = 250;
    expect(hullMaxHp(createDeck())).toBe(250); // 现读 tuning,不是模块加载时算死的
  });

  it('edgeDamageMul 四舷恒 1', () => {
    // 返回的是**倍率**而不是减伤值:06 填函数体时多块装甲舱天然连乘,不可能把伤害减成负数
    const deck = createDeck();
    for (let e = 0; e < EDGE_COUNT; e++) expect(edgeDamageMul(deck, e)).toBe(1);
    expect(edgeDamageMul(createDeck(5, 6), EDGE_BOW)).toBe(1);
  });
});
