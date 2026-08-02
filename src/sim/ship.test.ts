/**
 * 飞船运动模型(02 号 issue T1)。本文件在 Node 里跑通本身就是一层验证:
 * 手感逻辑不依赖 Pixi/DOM/键盘,输入只是一个纯数据向量。
 * 参数在文件顶部显式设定:vitest 每个测试文件有独立模块注册表,但显式写死才不会被
 * config.ts 的默认值调整(M0 就是要反复调这四个数)带崩。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SIM_DT, SIM_HZ } from '../core/loop';
import { tuning } from './config';
import {
  createShip,
  DEG2RAD,
  lerpAngle,
  type Ship,
  type ShipCommand,
  stepShip,
  type Vec2,
  wrapAngle,
} from './ship';
import { WORLD_RADIUS, World } from './world';

const BASE = { shipTurnRate: 100, shipCruiseSpeed: 130, shipAccel: 260, shipDamping: 1.2 };
Object.assign(tuning, BASE);
// 有用例会拖参数来验证"每帧现读",跑完必须还原,否则污染同文件后续用例
afterEach(() => Object.assign(tuning, BASE));

// World 用例只关心船与追船逻辑,压测数量是浏览器场景的事 —— 调小纯粹为了跑得快
tuning.stressEnemies = 50;

// y 轴朝下:-1 是屏幕上方
const UP: Vec2 = { x: 0, y: -1 };
const DOWN: Vec2 = { x: 0, y: 1 };
const RIGHT: Vec2 = { x: 1, y: 0 };

function run(ship: Ship, desired: Vec2 | null, ticks: number): void {
  for (let i = 0; i < ticks; i++) stepShip(ship, desired, SIM_DT);
}

const speed = (s: Ship): number => Math.hypot(s.vx, s.vy);

describe('角度工具', () => {
  it('wrapAngle 折回 (-π, π]', () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapAngle(-Math.PI * 1.5)).toBeCloseTo(Math.PI / 2, 12);
    expect(wrapAngle(0.3)).toBeCloseTo(0.3, 12);
  });

  it('lerpAngle 走最短弧:跨 ±π 不甩头', () => {
    // 直接线性插值会得到 0(绕远路穿过 0),沿最短弧应落在 ±π 附近
    expect(lerpAngle(3, -3, 0.5)).toBeCloseTo(Math.PI, 9);
  });

  it('lerpAngle 端点即两端姿态', () => {
    expect(lerpAngle(1.2, -2.5, 0)).toBeCloseTo(1.2, 12);
    expect(wrapAngle(lerpAngle(1.2, -2.5, 1))).toBeCloseTo(-2.5, 12);
  });
});

describe('createShip', () => {
  it('静止、船头朝屏幕上方,px/py/pheading 与当前值一致,且满血进场', () => {
    const ship = createShip();
    expect(ship.heading).toBe(-Math.PI / 2);
    // 首帧渲染插值的两端必须重合,否则船会从别处"飞"进场
    expect(ship.pheading).toBe(ship.heading);
    expect(ship.px).toBe(ship.x);
    expect(ship.py).toBe(ship.y);
    expect(speed(ship)).toBe(0);
    // 全局船体 HP(09 号):船不进对象池,createShip 是它一生中唯一一次初始化 ——
    // 上限现读 tuning,所以"改了 HP 要重开一局才生效"是这条口径的必然结论
    expect(ship.hp).toBe(tuning.shipHullHp);
    expect(ship.maxHp).toBe(tuning.shipHullHp);
  });
});

describe('stepShip 转向', () => {
  it('按 shipTurnRate 为上限追随期望航向,绝不瞬间对齐', () => {
    const ship = createShip();
    const before = ship.heading;
    stepShip(ship, DOWN, SIM_DT); // 期望航向与船头正好差 180°

    // 只断言转过的角度大小:180° 时的旋转方向由 wrapAngle 实现唯一确定,不是设计契约
    expect(Math.abs(wrapAngle(ship.heading - before))).toBeCloseTo(
      tuning.shipTurnRate * DEG2RAD * SIM_DT,
      9,
    );
  });

  it('持续输入下 90° 需要 0.9s 转完,到位后不过冲', () => {
    const ship = createShip();
    run(ship, RIGHT, 30); // 0.5s 只转得动 50°,离 90° 还差得远
    expect(Math.abs(ship.heading)).toBeGreaterThan(0.5);

    run(ship, RIGHT, 30); // 累计 1s > 90° / 100°/s
    expect(ship.heading).toBeCloseTo(0, 9);
  });

  it('1 秒内转过的角度不超过 shipTurnRate:反向 180° 也只能慢慢掉头', () => {
    const ship = createShip();
    const maxTurn = tuning.shipTurnRate * DEG2RAD * SIM_DT;
    let prev = ship.heading;
    let turned = 0;

    // 逐帧累加 |Δheading| 而不是看首尾差:首尾差在过冲来回摆时会把真实转量低估掉。
    // 期望航向与船头差 180°,1s 只转得动 100°,所以每一帧都该顶在上限上。
    for (let i = 0; i < SIM_HZ; i++) {
      stepShip(ship, DOWN, SIM_DT);
      const d = Math.abs(wrapAngle(ship.heading - prev));
      expect(d).toBeCloseTo(maxTurn, 9); // 单帧只转 turnRate×dt —— 没有哪一帧偷偷瞬间对齐
      turned += d;
      prev = ship.heading;
    }

    const deg = turned / DEG2RAD;
    expect(deg).toBeLessThanOrEqual(tuning.shipTurnRate + 1); // 1° 容差留给浮点与折角
    expect(deg).toBeGreaterThanOrEqual(tuning.shipTurnRate * 0.99); // 也不能偷懒少转
  });

  it('shipTurnRate 每帧现读:改成 0 立刻停转(面板拖动即时生效)', () => {
    const ship = createShip();
    const before = ship.heading;
    tuning.shipTurnRate = 0;
    run(ship, DOWN, 10);
    expect(ship.heading).toBeCloseTo(before, 12);
  });
});

describe('stepShip 推进', () => {
  it('推力沿船头而非期望航向 —— 这才有"转船找射界"', () => {
    const ship = createShip();
    stepShip(ship, RIGHT, SIM_DT);

    expect(Math.atan2(ship.vy, ship.vx)).toBeCloseTo(ship.heading, 9);
    // 船头才刚偏了 100°/s × 1/60 ≈ 1.7°,所以速度仍几乎全在"朝上"这个分量上
    expect(ship.vy).toBeLessThan(0);
    expect(Math.abs(ship.vx)).toBeLessThan(Math.abs(ship.vy) * 0.1);
  });

  it('以加速度趋近巡航速度,并夹在上限', () => {
    const ship = createShip();
    run(ship, UP, 6); // 期望航向 = 初始船头,不用转向,纯直线加速
    expect(speed(ship)).toBeCloseTo(tuning.shipAccel * 0.1, 6);

    run(ship, UP, 294); // 累计 5s:早该顶到上限
    expect(speed(ship)).toBeCloseTo(tuning.shipCruiseSpeed, 6);
    expect(speed(ship)).toBeLessThanOrEqual(tuning.shipCruiseSpeed + 1e-9);
  });

  it('shipCruiseSpeed 每帧现读:调小后下一帧就被夹到新上限', () => {
    const ship = createShip();
    run(ship, UP, 120);
    tuning.shipCruiseSpeed = 40;
    stepShip(ship, UP, SIM_DT);
    expect(speed(ship)).toBeCloseTo(40, 6);
  });
});

describe('stepShip 阻尼滑行', () => {
  it('松手不转向,只减速,shipDamping 秒内停住', () => {
    const ship = createShip();
    run(ship, UP, 60);
    const heading = ship.heading;

    run(ship, null, 30); // 松手 0.5s:明显慢下来了,但远没停
    expect(ship.heading).toBe(heading);
    expect(speed(ship)).toBeGreaterThan(1);
    expect(speed(ship)).toBeLessThan(tuning.shipCruiseSpeed * 0.3);

    run(ship, null, 42); // 累计 1.2s(GDD §3.2:松手 1.2s 内停)
    expect(speed(ship)).toBe(0);
  });

  it('松手 1.2s 后速度归零,但 0.6s 时仍在滑行(阻尼不能退化成急刹)', () => {
    const ship = createShip();
    run(ship, UP, 120); // 期望航向 = 初始船头,不掺转向;2s 足够顶到巡航速度
    expect(speed(ship)).toBeCloseTo(tuning.shipCruiseSpeed, 6);

    // "停住"的判据挂在巡航速度上取 2%:写成绝对 px/s 会在 shipCruiseSpeed 被调走后失效
    const stopped = tuning.shipCruiseSpeed * 0.02;
    run(ship, null, 36); // 松手 0.6s:太空惯性,半程时必须还明显在动
    expect(speed(ship)).toBeGreaterThan(stopped);

    run(ship, null, 36); // 累计 1.2s(GDD §3.2:松手 1.2s 内停)
    expect(speed(ship)).toBeLessThan(stopped);
  });

  it('松手不是急停:惯性还会把船带出一段(太空手感)', () => {
    const ship = createShip();
    run(ship, UP, 60);
    const y0 = ship.y;
    run(ship, null, 30);
    expect(y0 - ship.y).toBeGreaterThan(20);
  });

  it('零向量等同无输入:走阻尼路径而不是继续推进', () => {
    const ship = createShip();
    run(ship, UP, 60);
    const heading = ship.heading;
    const v = speed(ship);

    stepShip(ship, { x: 0, y: 0 }, SIM_DT);
    expect(ship.heading).toBe(heading);
    expect(speed(ship)).toBeLessThan(v);
  });
});

describe('铁律 2:渲染插值端点', () => {
  it('每帧先存上一逻辑帧的位置与朝向', () => {
    const ship = createShip();
    run(ship, RIGHT, 10);
    const { x, y, heading } = ship;

    stepShip(ship, RIGHT, SIM_DT);
    expect(ship.px).toBe(x);
    expect(ship.py).toBe(y);
    expect(ship.pheading).toBe(heading);
    expect(ship.y).not.toBe(y); // 两端确实不同,插值才有意义
  });
});

/** 由 tick 派生的脚本化输入:必须含 null 段,推进与阻尼两条路径才都被确定性覆盖 */
function scripted(tick: number): ShipCommand {
  const phase = Math.floor(tick / 20) % 4;
  if (phase === 3) return { desiredHeading: null }; // 松手滑行
  const a = (phase * Math.PI) / 2;
  return { desiredHeading: { x: Math.cos(a), y: Math.sin(a) } };
}

describe('World 接线', () => {
  it('同 seed + 同输入序列 → checksum 相同(输入是纯数据,确定性不被打破)', () => {
    const a = new World(77);
    const b = new World(77);
    const idle = new World(77); // 同 seed 但全程松手,用来证明这条 checksum 真被输入牵动过
    for (let i = 0; i < 240; i++) {
      a.step(scripted(a.tick));
      b.step(scripted(b.tick));
      idle.step();
    }
    expect(a.checksum()).toBe(b.checksum());
    // 万一输入没接进 sim,两边都退化成"静止船 + 同一群敌人",上面那条相等就成了空过
    expect(a.checksum()).not.toBe(idle.checksum());
    expect(a.ship.x).not.toBe(0); // 船确实被开动了,不是拿两个静止世界在自欺
  });

  it('不同输入序列 → checksum 不同', () => {
    const a = new World(77);
    const b = new World(77);
    for (let i = 0; i < 240; i++) {
      a.step(scripted(a.tick));
      b.step(scripted(b.tick + 20)); // 相位错开一段
    }
    expect(a.checksum()).not.toBe(b.checksum());
  });

  it('checksum 抓得住朝向的细微差别(换算成度才有 0.125° 分辨率)', () => {
    const w = new World(3);
    w.step();
    const before = w.checksum();
    w.ship.heading += 0.2 * DEG2RAD; // 0.2° > 量化步长 0.125°,弧度口径下会被抹平
    expect(w.checksum()).not.toBe(before);
  });

  it('checksum 抓得住船的位置(与朝向那条对称,否则位置那半没人钉)', () => {
    const w = new World(3);
    w.step();
    const before = w.checksum();
    w.ship.x += 0.2; // 0.2 > 量化步长 0.125,足以改变哈希
    expect(w.checksum()).not.toBe(before);
    const afterX = w.checksum();
    w.ship.y += 0.2;
    expect(w.checksum()).not.toBe(afterX);
  });

  it('step() 无参 = 松手:船不会自己漂走', () => {
    const w = new World(1);
    for (let i = 0; i < 60; i++) w.step();
    expect(w.ship.x).toBe(0);
    expect(w.ship.y).toBe(0);
  });

  it('敌人追的是船,不再是绕圈的假想点', () => {
    const w = new World(11);
    w.step();
    // 把船挪到场地一侧;松手输入下它停在原地,敌群该压到它身上而不是聚回场心
    w.ship.x = 600;
    w.ship.y = 0;
    for (let i = 0; i < 15 * 60; i++) w.step();

    expect(w.ship.x).toBe(600); // 船没动过,敌群的位移只可能来自寻路目标
    // 80 px/s 跑 15s 足够跨过这 600px,敌群会贴成分离力撑开的一小团;
    // 若还在追场心,这个均值会停在 ~600(光看"距离变小了"是分辨不出来的)
    expect(meanDistToShip(w)).toBeLessThan(200);
  });

  it('船被夹在场地内,贴边后不再向外积速', () => {
    const w = new World(5);
    const cmd: ShipCommand = { desiredHeading: { x: 1, y: 0 } };
    for (let i = 0; i < 20 * 60; i++) w.step(cmd); // 130 px/s 跑 20s,远超场地半径

    const d = Math.hypot(w.ship.x, w.ship.y);
    expect(d).toBeLessThanOrEqual(WORLD_RADIUS + 1e-6);
    expect(d).toBeCloseTo(WORLD_RADIUS, 6); // 确实贴在边上,而不是被别的逻辑拉回场心
    // 速度只剩切向:径向外向分量每帧被清掉,松开推力也不会弹射出去
    expect((w.ship.vx * w.ship.x + w.ship.vy * w.ship.y) / d).toBeLessThanOrEqual(1e-9);
  });
});

function meanDistToShip(w: World): number {
  let sum = 0;
  for (const e of w.enemies.items) sum += Math.hypot(e.x - w.ship.x, e.y - w.ship.y);
  return sum / w.enemies.size;
}
