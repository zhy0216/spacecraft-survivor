/**
 * 转向力三原语(07 号 issue T1)。三个原语都是纯函数,所以这里不造 World、不接数值表:
 * 数值在文件顶部显式写死(与 ship.test.ts 同口径)—— src/data/enemies.ts 里那批占位值
 * 在 M0 会被反复调,钉的是"极坐标绕行会收敛"这条机制,不该被一次平衡改动带崩。
 *
 * 最要紧的一条是"绕行不许退化成直奔锚点":距离已对、方位没对时必须纯切向走,
 * 这就是 07 验收标准里"侧掠者确实从舷侧发起攻击、尾随蛆确实占住船尾"的机制根源。
 */
import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../core/loop';
import { type Vec2, wrapAngle } from './ship';
import { anchorPoint, lockCharge, seek, strafe } from './steering';

/** 每次要个干净的 out;生产代码里这东西是全局复用的,单测图省事才现造 */
const v = (): Vec2 => ({ x: 0, y: 0 });

describe('anchorPoint', () => {
  // 船的位置与朝向都取非特殊值:原点 + 轴对齐的角度会让"点乘 ≈ 0"这类断言蒙混过关
  const TX = 123;
  const TY = -45;
  const HEADING = 0.7;
  const RADIUS = 260;

  /** 把锚点相对船的位移拆进"船头方向 / 正舷侧"这组基:fwd 为正 = 船头前方 */
  function decompose(offsetRad: number): { fwd: number; lat: number } {
    const p = anchorPoint(TX, TY, HEADING, offsetRad, RADIUS, v());
    const dx = p.x - TX;
    const dy = p.y - TY;
    const hx = Math.cos(HEADING);
    const hy = Math.sin(HEADING);
    return { fwd: hx * dx + hy * dy, lat: hx * dy - hy * dx };
  }

  it('offset = ±π/2 落在正舷侧:与船头点乘 ≈ 0,叉乘符号 = side', () => {
    for (const side of [1, -1]) {
      // 调用方传的就是 def.strafeOffsetDeg * DEG2RAD * e.side,侧掠者的 90° 即此处的 ±π/2
      const { fwd, lat } = decompose((side * Math.PI) / 2);
      expect(fwd).toBeCloseTo(0, 9); // 一丝前后偏移都没有,才叫"正舷侧"
      // 符号错了就整型串舷:e.side 是生成时定死的,左舷的敌人会全跑到右舷去
      expect(Math.sign(lat)).toBe(side);
      expect(Math.abs(lat)).toBeCloseTo(RADIUS, 9);
    }
  });

  it('offset = π 落在船尾正后方(尾随蛆的方向压力),0 落在船头正前', () => {
    const stern = decompose(Math.PI);
    expect(stern.fwd).toBeCloseTo(-RADIUS, 9);
    expect(stern.lat).toBeCloseTo(0, 9);
    expect(decompose(0).fwd).toBeCloseTo(RADIUS, 9);
  });

  it('锚点恒在以船为心、radius 为半径的圆上', () => {
    for (const off of [0, 0.3, 1.9, -2.7, Math.PI]) {
      const p = anchorPoint(TX, TY, HEADING, off, RADIUS, v());
      expect(Math.hypot(p.x - TX, p.y - TY)).toBeCloseTo(RADIUS, 9);
    }
  });
});

describe('seek', () => {
  it('返回朝目标的单位方向 × speed', () => {
    const out = seek(0, 0, 300, 400, 200, v()); // 3-4-5:方向正好是 (0.6, 0.8)
    expect(out.x).toBeCloseTo(120, 9);
    expect(out.y).toBeCloseTo(160, 9);
    expect(Math.hypot(out.x, out.y)).toBeCloseTo(200, 9);
  });

  it('速度只由 speed 决定,与距离无关(转向力不是弹簧)', () => {
    const far = seek(17, -3, 17 + 3000, -3 + 4000, 80, v());
    const near = seek(17, -3, 17 + 3, -3 + 4, 80, v());
    expect(Math.hypot(far.x, far.y)).toBeCloseTo(80, 9);
    expect(far.x).toBeCloseTo(near.x, 9);
    expect(far.y).toBeCloseTo(near.y, 9);
  });

  it('与目标重合时给零向量而不是 NaN(贴脸帧不许把速度污染成 NaN)', () => {
    const out = seek(5, 5, 5, 5, 100, v());
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
  });
});

describe('strafe', () => {
  // 侧掠者的占位数值(src/data/enemies.ts):接近速 150、驻留半径 260、追随系数 8
  const SPEED = 150;
  const RADIUS = 260;
  const ACCEL = 8;
  /** 船头朝屏幕上方(y 轴朝下)。船固定在原点,敌人的位移就只可能来自这三个原语 */
  const HEADING = -Math.PI / 2;
  /** offset = +π/2 时目标方位 = -π/2 + π/2 = 0,锚点正好落在 +X 轴上,好手算 */
  const OFF_X = Math.PI / 2;

  interface Mover {
    x: number;
    y: number;
    vx: number;
    vy: number;
  }

  /** 最小积分器:与 stepEnemyBehavior 的接线同口径(期望速度 → 一阶追随 → 积分位置) */
  function fly(m: Mover, offsetRad: number, seconds: number): void {
    const out = v();
    const follow = Math.min(1, ACCEL * SIM_DT);
    for (let i = 0; i < Math.round(seconds / SIM_DT); i++) {
      strafe(m.x, m.y, 0, 0, HEADING, offsetRad, RADIUS, SPEED, out);
      m.vx += (out.x - m.vx) * follow;
      m.vy += (out.y - m.vy) * follow;
      m.x += m.vx * SIM_DT;
      m.y += m.vy * SIM_DT;
    }
  }

  const bearingErr = (m: Mover, offsetRad: number): number =>
    wrapAngle(HEADING + offsetRad - Math.atan2(m.y, m.x));

  it('稳态收敛:bearing 误差 → 0、dist → radius(左舷/右舷/船尾三种驻留位)', () => {
    for (const off of [OFF_X, -OFF_X, Math.PI]) {
      // 从船头正前方 700px 起步:方位差 90°(船尾那档是 180°)、距离差 440,两路误差都得收
      const m: Mover = { x: 0, y: -700, vx: 0, vy: 0 };
      fly(m, off, 15);
      expect(Math.abs(bearingErr(m, off))).toBeLessThan(0.01);
      expect(Math.hypot(m.x, m.y)).toBeCloseTo(RADIUS, 0);
    }
  });

  it('稳态落点就是 anchorPoint 给的锚点(两个原语共用一套方位口径)', () => {
    const m: Mover = { x: 0, y: -700, vx: 0, vy: 0 };
    fly(m, -OFF_X, 15);
    const p = anchorPoint(0, 0, HEADING, -OFF_X, RADIUS, v());
    expect(Math.hypot(m.x - p.x, m.y - p.y)).toBeLessThan(1);
  });

  it('距离已对、方位没对时期望速度是纯切向 —— 极坐标分解的判据', () => {
    // 敌人正好在驻留半径上,但在船的另一侧(方位差 90°)。
    // 直奔锚点会切弦而过、从船腹穿过去(径向分量 ≈ -0.71 × speed),极坐标分解只沿圆周绕。
    const out = strafe(0, RADIUS, 0, 0, HEADING, OFF_X, RADIUS, SPEED, v());
    expect(out.x * 0 + out.y * 1).toBeCloseTo(0, 9); // 径向单位向量在 (0, RADIUS) 处是 (0, 1)
    expect(Math.hypot(out.x, out.y)).toBeCloseTo(SPEED, 9); // 离锚点还远,照样满速
    expect(out.x).toBeGreaterThan(0); // 沿最短弧转向 +X 上的锚点,不绕远路
  });

  it('绕最短弧,不绕远路 —— 角度差必须先折回 (-π, π]', () => {
    // 目标方位 = -π/2 + (-π/2) = -π,锚点在 -X 轴上;敌人在 +Y 轴、方位 +π/2。
    // 折回后角度差是 +π/2(往 +bearing 走 1/4 圈就到),不折回则是 -3π/2 —— 反着绕 3/4 圈。
    // 两者都"能收敛",所以只有这条方向断言钉得住 wrapAngle(与 stepShip 转向是同一个坑)。
    const out = strafe(0, RADIUS, 0, 0, HEADING, -OFF_X, RADIUS, SPEED, v());
    expect(out.y).toBeCloseTo(0, 9); // 距离已对 → 纯切向
    expect(out.x).toBeLessThan(0); // 沿 bearing 增大的方向绕向 -X,而不是掉头绕远路
  });

  it('方位已对时只剩径向:太远向内、太近向外', () => {
    const far = strafe(RADIUS + 400, 0, 0, 0, HEADING, OFF_X, RADIUS, SPEED, v());
    expect(far.x).toBeCloseTo(-SPEED, 9);
    expect(far.y).toBeCloseTo(0, 9);

    // 太近要退出去:不退的话绕行就退化成贴脸,驻留半径这个参数等于白写
    const near = strafe(RADIUS - 200, 0, 0, 0, HEADING, OFF_X, RADIUS, SPEED, v());
    expect(near.x).toBeCloseTo(SPEED, 9);
    expect(near.y).toBeCloseTo(0, 9);
  });

  it('进锚点前会刹车:期望速度按误差缩小,而不是一路定长满速', () => {
    // speed 是**上限**不是定值。定长速度在锚点附近没有不动点,只会绕着它抖;
    // 这 10px 的残差对应的期望速度必须远小于 speed,肉眼才看得出"停下来驻留"。
    const out = strafe(RADIUS + 10, 0, 0, 0, HEADING, OFF_X, RADIUS, SPEED, v());
    expect(Math.hypot(out.x, out.y)).toBeLessThan(SPEED * 0.5);
    expect(out.x).toBeLessThan(0); // 方向不变,还是向内
  });

  it('停在锚点上时期望速度归零 —— 归一化到定长会在这里除零或绕成极限环', () => {
    const out = strafe(RADIUS, 0, 0, 0, HEADING, OFF_X, RADIUS, SPEED, v());
    expect(Math.hypot(out.x, out.y)).toBe(0);
  });

  it('与船重合时不产 NaN:退化成沿目标方位推出去', () => {
    const out = strafe(0, 0, 0, 0, HEADING, OFF_X, RADIUS, SPEED, v());
    expect(out.x).toBeCloseTo(SPEED, 9); // 目标方位在 +X
    expect(out.y).toBeCloseTo(0, 9);
  });
});

describe('lockCharge', () => {
  it('返回敌 → 船的单位向量,不含速度(速度是 DASH 段 chargeSpeed 的事)', () => {
    const out = lockCharge(100, 100, 400, 500, v()); // Δ = (300, 400),又是 3-4-5
    expect(out.x).toBeCloseTo(0.6, 12);
    expect(out.y).toBeCloseTo(0.8, 12);
  });

  it('各个方向/距离上都是单位长度', () => {
    for (const a of [0, 1.1, -2.4, 3.0]) {
      for (const d of [1, 37, 900]) {
        const out = lockCharge(0, 0, Math.cos(a) * d, Math.sin(a) * d, v());
        expect(Math.hypot(out.x, out.y)).toBeCloseTo(1, 12);
        expect(Math.atan2(out.y, out.x)).toBeCloseTo(a, 12);
      }
    }
  });

  it('与船重合时给零向量而不是 NaN', () => {
    const out = lockCharge(-8, 3, -8, 3, v());
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
  });
});

describe('零分配约定', () => {
  it('四个原语都把结果写进 out 并把 out 原样返回(热循环复用同一个 Vec2)', () => {
    const out = v();
    expect(anchorPoint(0, 0, 0, 0, 1, out)).toBe(out);
    expect(seek(0, 0, 1, 0, 10, out)).toBe(out);
    expect(strafe(3, 0, 0, 0, 0, 0, 1, 10, out)).toBe(out);
    expect(lockCharge(0, 0, 1, 0, out)).toBe(out);
  });
});
