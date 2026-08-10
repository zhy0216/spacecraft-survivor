/**
 * 敌人状态机与伤害 API(07 号 issue T1/T3)。
 * 这里只喂"一只敌人 + 一艘船",不造 World:行为原语是纯函数、状态机只出期望速度,
 * 所以整套冲锋流程在 Node 里跑得完 —— 这本身就是铁律 1 的一层验证。
 * 积分接线(存 px/py → 期望速度 → 一阶追随 → 积分位置)在 stepOnce 里照 World 的敌人循环复刻,
 * 唯独不含邻居分离:分离是人群效应,会把"直线冲锋"这类单体机制的断言搅浑。
 *
 * 钉的几条机制(改坏就等于改坏了 07 的验收标准):
 *   前摇时长 = chargeWindup/SIM_DT 帧且期间几乎不动 —— "前摇可读、来得及躲";
 *   冲刺沿进入前摇那一帧锁定的方向直走,船跑了也不改道 —— 玩家躲得掉的唯一依据;
 *   侧掠者必须先绕到舷侧才起手 —— 否则退化成追尾,侧压这条方向压力就没了;
 *   resetEnemy 逐字段清回初值 —— 池复用的正确性,将来加字段忘了重置会被当场抓住。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SIM_DT } from '../core/loop';
import { Rng } from '../core/rng';
import {
  AFFIX_ARMORED,
  AFFIX_FISSION,
  AFFIX_FRENZY,
  AFFIX_MAGNETIC,
  ELITE,
} from '../data/affixes';
import { ENEMIES, KIND_BEETLE, KIND_SPORE, KIND_STRAFER, KIND_SWARM, KIND_TRAILER } from '../data/enemies';
import { tuning } from './config';
import {
  affixMask,
  applyDamage,
  createEnemy,
  type Enemy,
  enemyAnimSeed,
  ENEMY_HIT_FLASH,
  enemyRadius,
  hasAffix,
  hpScaleAt,
  initEnemy,
  initSplit,
  resetEnemy,
  ST_ANCHOR,
  ST_APPROACH,
  ST_DASH,
  ST_RECOVER,
  ST_SPORE_WINDUP,
  ST_WINDUP,
  stepEnemyBehavior,
} from './enemy';
import { createShip, DEG2RAD, type Ship, type Vec2, wrapAngle } from './ship';

// 与 ship.test.ts 同口径:参数在文件顶部显式写死,免得 M0 反复调平衡时把机制断言带崩。
// 0.09 是 GDD §14 的口径(数据表里那份由 data/enemies.test.ts 钉),这里钉的是公式形状。
const BASE = { enemySpeedScale: 1, enemyHpScalePerMinute: 0.09 };
Object.assign(tuning, BASE);
/** 有用例要临时改前摇时长(证明"时长可配"),跑完必须还原,否则污染同文件后续用例 */
const BASE_WINDUP = ENEMIES[KIND_BEETLE]!.chargeWindup;
afterEach(() => {
  Object.assign(tuning, BASE);
  ENEMIES[KIND_BEETLE]!.chargeWindup = BASE_WINDUP;
});

const v = (): Vec2 => ({ x: 0, y: 0 });

/** 热循环里这东西是复用的,单测也跟着复用一个,顺带保证没人偷偷 new */
const scratch = v();

/** 与 World 敌人循环同口径的最小接线(不含邻居分离) */
function stepOnce(e: Enemy, ship: Ship): void {
  e.px = e.x;
  e.py = e.y;
  const follow = stepEnemyBehavior(e, ship, SIM_DT, scratch);
  e.vx += (scratch.x - e.vx) * follow;
  e.vy += (scratch.y - e.vy) * follow;
  e.x += e.vx * SIM_DT;
  e.y += e.vy * SIM_DT;
}

/** 船头默认朝屏幕上方(y 轴朝下),与 createShip 一致;船不开动,敌人的位移只可能来自寻路 */
function shipAt(x: number, y: number): Ship {
  const s = createShip();
  s.x = s.px = x;
  s.y = s.py = y;
  return s;
}

/** side 是生成时随机定死的,单测要可复现就出生后直接指定 */
function spawn(kind: number, x: number, y: number, side = 1): Enemy {
  const e = createEnemy();
  initEnemy(e, kind, x, y, 0, new Rng(1));
  e.side = side;
  return e;
}

/** 一路推进到指定状态,返回用掉的帧数;跑不到就直接失败(免得后续断言在错的状态上空过) */
function driveTo(e: Enemy, ship: Ship, state: number, limit = 30 * 60): number {
  for (let i = 1; i <= limit; i++) {
    stepOnce(e, ship);
    if (e.state === state) return i;
  }
  throw new Error(`${limit} 帧内没进到状态 ${state},当前 ${e.state}`);
}

describe('hpScaleAt(HP 时间缩放)', () => {
  it('GDD §14:×(1 + 0.09·t分钟),星区乘数单地图固定 ×1', () => {
    expect(hpScaleAt(0)).toBeCloseTo(1, 12);
    expect(hpScaleAt(300)).toBeCloseTo(1.45, 12); // 第 5 分钟
    expect(hpScaleAt(600)).toBeCloseTo(1.9, 12); // 第 10 分钟
  });

  it('线性:两倍时间 = 两倍增量(不是指数,后期不会突然打不动)', () => {
    expect(hpScaleAt(600) - 1).toBeCloseTo((hpScaleAt(300) - 1) * 2, 12);
  });

  it('斜率每次现读 tuning:调到 0 就是全程原始血量(面板拖动即时生效)', () => {
    tuning.enemyHpScalePerMinute = 0;
    expect(hpScaleAt(600)).toBe(1);
  });
});

describe('initEnemy(出生)', () => {
  it('hp = maxHp = def.hp × 时间缩放', () => {
    const def = ENEMIES[KIND_STRAFER]!;
    const e = createEnemy();
    initEnemy(e, KIND_STRAFER, 10, -20, 300, new Rng(1));

    expect(e.hp).toBeCloseTo(def.hp * hpScaleAt(300), 9);
    expect(e.maxHp).toBe(e.hp); // 满血出生:血条一出来就是满的
    expect(e.hp).toBeGreaterThan(def.hp); // 第 5 分钟的确实更硬,不是把缩放算丢了
  });

  it('出生姿态干净:APPROACH、px/py 与 x/y 重合、静止、无锁定、未死、能立刻咬', () => {
    const e = createEnemy();
    // 先弄脏受击冷却:World 的出生路径是 reset → init,但 initEnemy 自己也得把这一格写齐 ——
    // 只靠 resetEnemy 的话,Object.keys 那条用例检不出 initEnemy 的漏写(它清完就是 0)
    e.hitCd = 5;
    initEnemy(e, KIND_BEETLE, 7, 9, 0, new Rng(42));

    expect(e.kind).toBe(KIND_BEETLE);
    expect(e.state).toBe(ST_APPROACH);
    expect(e.timer).toBe(0);
    // 首帧渲染插值的两端必须重合,否则新敌人会从别处"飞"进场(铁律 2)
    expect(e.px).toBe(e.x);
    expect(e.py).toBe(e.y);
    expect(e.vx).toBe(0);
    expect(e.vy).toBe(0);
    expect(e.lockX).toBe(0);
    expect(e.lockY).toBe(0);
    expect(e.dead).toBe(false);
    expect(Math.abs(e.side)).toBe(1);
    // 起手 0 = 一出生就能咬(09 号的无敌帧)。出生点在船外几百 px,给初始冷却只会让将来
    // "生在船脸上"那类出怪规则悄悄免掉第一口伤害
    expect(e.hitCd).toBe(0);
  });

  it('hitFlash / lastHit 出生归零:新怪不继承上一命的受击闪白与伤害账(池复用才会脏)', () => {
    const e = createEnemy();
    e.hitFlash = 5;
    e.lastHit = 99;
    initEnemy(e, KIND_BEETLE, 7, 9, 0, new Rng(42));
    expect(e.hitFlash).toBe(0);
    expect(e.lastHit).toBe(0);

    const s = createEnemy();
    initSplit(s, e, 0);
    expect(s.hitFlash).toBe(0); // 分裂体与父体同帧出生,不带父体的闪白
    expect(s.lastHit).toBe(0);
  });

  it('固定消耗 1 次 rng(出怪的随机序列不因敌型逻辑变动而移位),左右舷都出得来', () => {
    const rng = new Rng(7);
    const probe = new Rng(7);
    const e = createEnemy();
    initEnemy(e, KIND_SWARM, 0, 0, 0, rng);
    probe.next();
    expect(rng.next()).toBe(probe.next());

    const sides = new Set<number>();
    const r = new Rng(3);
    for (let i = 0; i < 40; i++) {
      initEnemy(e, KIND_STRAFER, 0, 0, 0, r);
      sides.add(e.side);
    }
    expect(sides).toEqual(new Set([-1, 1])); // 全跑一侧的话侧掠者就只会从一个舷来
  });
});

describe('enemyAnimSeed(渲染层动画相位种子)', () => {
  it('值域 [0,1):渲染层拿它当相位起点,越界会破坏 sin 周期的连续性', () => {
    for (let i = 0; i < 200; i++) {
      const s = enemyAnimSeed(i * 13, i * 7 + 3);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(1);
    }
  });

  it('同位置两次 hash 一字不差 —— 同 seed 两局的相位序列一致的前提', () => {
    expect(enemyAnimSeed(123.5, -77.25)).toBe(enemyAnimSeed(123.5, -77.25));
  });

  it('不同位置基本不撞:200 个不同出生点几乎全部分开(同型虫子不同步呼吸)', () => {
    const seeds = new Set<number>();
    for (let i = 0; i < 200; i++) seeds.add(enemyAnimSeed(i * 13, i * 7 + 3));
    expect(seeds.size).toBeGreaterThan(190);
  });

  it('initEnemy 写入 animSeed = 出生位置的 hash,且不消耗 rng(序列一步不挪)', () => {
    const rng = new Rng(7);
    const probe = new Rng(7);
    const e = createEnemy();
    initEnemy(e, KIND_SWARM, 12, 34, 0, rng);
    expect(e.animSeed).toBe(enemyAnimSeed(12, 34));
    probe.next(); // 只有 side 那一次消耗,动画种子不参与随机
    expect(rng.next()).toBe(probe.next());
  });

  it('initSplit 同样写入(由父体位置推出):裂变体的呼吸相位也是确定的', () => {
    const parent = createEnemy();
    initEnemy(parent, KIND_STRAFER, 100, 50, 0, new Rng(1));
    const s = createEnemy();
    initSplit(s, parent, 0);
    expect(s.animSeed).toBe(enemyAnimSeed(100, 50));
  });
});

describe('resetEnemy(池 reset)', () => {  it('Object.keys 的每个字段都清回初值 —— 将来加字段忘了重置会被这条抓住', () => {
    const e = createEnemy();
    const rec = e as unknown as Record<string, number | boolean>;
    const initial = { ...rec }; // createEnemy() 的返回值即"初值"的定义
    const keys = Object.keys(rec);
    expect(keys.length).toBeGreaterThan(0);

    // 逐字段弄脏:数字 +13、布尔取反 —— 保证每个字段都真的偏离了初值,断言不会空过
    for (const k of keys) {
      const cur = rec[k]!;
      rec[k] = typeof cur === 'boolean' ? !cur : cur + 13;
      expect(rec[k]).not.toBe(initial[k]);
    }

    resetEnemy(e);
    for (const k of keys) expect(rec[k]).toBe(initial[k]);
    // 初值本身也不能悄悄变成"半个活敌人":一出生就在冲刺 / 一出生就是尸体
    expect(e.state).toBe(ST_APPROACH);
    expect(e.dead).toBe(false);
  });

  it('池复用:上一条命打到一半的状态不会被下一只继承', () => {
    const ship = shipAt(0, 0);
    const e = spawn(KIND_BEETLE, 500, 0);
    driveTo(e, ship, ST_DASH);
    applyDamage(e, e.hp); // 死在冲刺途中 —— 池里最脏的那种回收时机

    resetEnemy(e); // Pool.spawn 会先 reset 再由 World 调 initEnemy
    initEnemy(e, KIND_SWARM, 0, 0, 0, new Rng(9));
    expect(e.state).toBe(ST_APPROACH);
    expect(e.dead).toBe(false);
    expect(e.lockX).toBe(0);
    expect(e.lockY).toBe(0);
    expect(e.timer).toBe(0);
  });
});

describe('精英与词缀(14 号:HP/体型放大 + affixes 位掩码)', () => {
  it('initEnemy 带词缀:HP = 基础 × 时间缩放 × ELITE.hpMul,affixes 落成位掩码', () => {
    const def = ENEMIES[KIND_BEETLE]!;
    const e = createEnemy();
    initEnemy(
      e,
      KIND_BEETLE,
      10,
      -20,
      300,
      new Rng(1),
      affixMask([AFFIX_FISSION, AFFIX_ARMORED]),
    );

    expect(e.affixes).toBe(affixMask([AFFIX_FISSION, AFFIX_ARMORED]));
    expect(hasAffix(e, AFFIX_FISSION)).toBe(true);
    expect(hasAffix(e, AFFIX_ARMORED)).toBe(true);
    expect(hasAffix(e, AFFIX_FRENZY)).toBe(false);
    expect(e.hp).toBeCloseTo(def.hp * hpScaleAt(300) * ELITE.hpMul, 9);
    expect(e.maxHp).toBe(e.hp); // 满血出生:血条一出来就是满的
    expect(e.hp).toBeGreaterThan(def.hp * hpScaleAt(300)); // 确实比同型普通怪硬
  });

  it('无词缀 = 普通怪:HP 不放大、affixes 为 0(普通流/压测路径的既有语义一字不变)', () => {
    const def = ENEMIES[KIND_SWARM]!;
    const e = createEnemy();
    initEnemy(e, KIND_SWARM, 0, 0, 600, new Rng(1));
    expect(e.affixes).toBe(0);
    expect(hasAffix(e, AFFIX_ARMORED)).toBe(false);
    expect(e.hp).toBeCloseTo(def.hp * hpScaleAt(600), 9);
  });

  it('enemyRadius:精英 = 基础半径 × ELITE.scale(体型放大),普通怪 = 基础半径', () => {
    const plain = createEnemy();
    initEnemy(plain, KIND_BEETLE, 0, 0, 0, new Rng(1));
    expect(enemyRadius(plain)).toBe(ENEMIES[KIND_BEETLE]!.radius);

    const elite = createEnemy();
    initEnemy(elite, KIND_BEETLE, 0, 0, 0, new Rng(1), affixMask([AFFIX_FRENZY]));
    expect(enemyRadius(elite)).toBeCloseTo(ENEMIES[KIND_BEETLE]!.radius * ELITE.scale, 9);
    expect(enemyRadius(elite)).toBeGreaterThan(enemyRadius(plain));
  });

  it('resetEnemy 把 affixes 清回 0:池复用的精英不带词缀重生(上一条命的效果不继承)', () => {
    const e = createEnemy();
    initEnemy(e, KIND_STRAFER, 0, 0, 0, new Rng(1), affixMask([AFFIX_MAGNETIC]));
    expect(e.affixes).not.toBe(0);
    expect(e.hp).toBeGreaterThan(ENEMIES[KIND_STRAFER]!.hp); // 确实是精英血量

    resetEnemy(e);
    expect(e.affixes).toBe(0); // Object.keys 那条用例也兜着,这里显式钉一次
    initEnemy(e, KIND_STRAFER, 0, 0, 0, new Rng(9));
    expect(e.affixes).toBe(0);
    expect(e.hp).toBeCloseTo(ENEMIES[KIND_STRAFER]!.hp, 9); // 也不带 3× 血量
  });

  it('initSplit:裂变分裂体 = 同型、无词缀、普通血量、继承父体 side,且一次 rng 都不掷', () => {
    const parent = createEnemy();
    initEnemy(parent, KIND_STRAFER, 100, 50, 300, new Rng(1), affixMask([AFFIX_FISSION]));
    parent.side = -1;

    const rng = new Rng(7);
    const probe = new Rng(7);
    const s = createEnemy();
    initSplit(s, parent, 300);
    expect(rng.next()).toBe(probe.next()); // 分裂不掷随机:side 继承父体,序列一步不挪

    expect(s.x).toBe(100);
    expect(s.y).toBe(50);
    expect(s.kind).toBe(KIND_STRAFER);
    expect(s.affixes).toBe(0); // 分裂体不带词缀:它们不是小精英
    expect(s.side).toBe(-1);
    expect(s.hp).toBeCloseTo(ENEMIES[KIND_STRAFER]!.hp * hpScaleAt(300), 9); // 普通血量,不 ×ELITE.hpMul
    expect(s.maxHp).toBe(s.hp);
    expect(s.state).toBe(ST_APPROACH);
    expect(s.lockX).toBe(0);
    expect(s.lockY).toBe(0);
    expect(s.hitCd).toBe(0);
    expect(s.dead).toBe(false);
  });

  it('精英冲撞甲虫:起手圈按体型放大(ELITE.scale),前摇仍是 chargeWindup/SIM_DT 帧 —— 放大体型下肉眼可读', () => {
    const def = ENEMIES[KIND_BEETLE]!;
    const ship = shipAt(0, 0);
    const e = createEnemy();
    // 出生在"普通起手圈之外、精英起手圈之内":普通甲虫在这段距离还不该起手
    initEnemy(e, KIND_BEETLE, def.chargeRange * ELITE.scale + 100, 0, 0, new Rng(1), affixMask([AFFIX_ARMORED]));

    let distAtWindup = -1;
    for (let i = 1; i <= 30 * 60 && distAtWindup < 0; i++) {
      stepOnce(e, ship);
      if (e.state === ST_WINDUP) distAtWindup = Math.hypot(e.x - ship.x, e.y - ship.y);
    }
    expect(distAtWindup).toBeGreaterThan(0); // 真的起手了,不是空过 1800 帧
    expect(distAtWindup).toBeGreaterThan(def.chargeRange); // 起手圈确实放大过(630 > 420)
    expect(distAtWindup).toBeLessThanOrEqual(def.chargeRange * ELITE.scale + 1);

    // 前摇时长与普通甲虫逐帧一致:体型放大不改状态机节拍,"看得懂、来得及躲"依然成立
    let frames = 1; // 进入的那一帧就是第 1 帧前摇
    for (let i = 0; i < 10000 && e.state === ST_WINDUP; i++) {
      stepOnce(e, ship);
      if (e.state === ST_WINDUP) frames++;
    }
    expect(frames).toBe(Math.round(def.chargeWindup / SIM_DT));
    expect(e.state).toBe(ST_DASH); // 前摇完直接进冲刺,中间不空转一帧
  });
});

describe('冲撞甲虫:前摇(BH_SEEK_CHARGE)', () => {
  it('射程外老实追,进 chargeRange 才起手', () => {
    const def = ENEMIES[KIND_BEETLE]!;
    const ship = shipAt(0, 0);
    const e = spawn(KIND_BEETLE, def.chargeRange + 200, 0);

    let entered = 0;
    for (let i = 1; i <= 30 * 60 && entered === 0; i++) {
      const dist = Math.hypot(e.x - ship.x, e.y - ship.y);
      stepOnce(e, ship);
      if (e.state === ST_WINDUP) entered = i;
      else expect(dist).toBeGreaterThan(def.chargeRange); // 没起手 = 这一帧本来就在射程外
    }

    expect(entered).toBeGreaterThan(0);
    expect(Math.hypot(e.x - ship.x, e.y - ship.y)).toBeLessThanOrEqual(def.chargeRange);
  });

  it('前摇持续 chargeWindup/SIM_DT 帧 —— 时长可配,改数据表就是改手感', () => {
    // 0.9 是表里的占位值;另两档证明帧数是从数据算出来的,不是把 54 写死在代码里
    for (const windup of [BASE_WINDUP, 0.2, 0.5]) {
      ENEMIES[KIND_BEETLE]!.chargeWindup = windup;
      const ship = shipAt(0, 0);
      const e = spawn(KIND_BEETLE, ENEMIES[KIND_BEETLE]!.chargeRange + 100, 0);
      driveTo(e, ship, ST_WINDUP);

      let frames = 1; // 进入的那一帧就是第 1 帧前摇
      for (let i = 0; i < 10000 && e.state === ST_WINDUP; i++) {
        stepOnce(e, ship);
        if (e.state === ST_WINDUP) frames++;
      }

      expect(frames).toBe(Math.round(windup / SIM_DT));
      expect(e.state).toBe(ST_DASH); // 前摇完直接进冲刺,中间不空转一帧
    }
  });

  it('前摇期间几乎不动:期望速度归零 + 双倍追随,肉眼看得出蓄力停顿', () => {
    const def = ENEMIES[KIND_BEETLE]!;
    const ship = shipAt(0, 0);
    const e = spawn(KIND_BEETLE, def.chargeRange + 200, 0);
    driveTo(e, ship, ST_WINDUP); // 到这儿它已经是全速接近的状态,刹得住才算数

    const x0 = e.x;
    const y0 = e.y;
    for (let i = 0; i < 10000 && e.state === ST_WINDUP; i++) stepOnce(e, ship);
    const moved = Math.hypot(e.x - x0, e.y - y0);

    // 一阶刹车的滑行上限 ≈ speed/(2·accel)(时间常数 1/(2·accel) 秒),与前摇多长无关;
    // 给 1.5 倍余量。作为对照:自由接近这 0.9s 能走 speed×0.9 ≈ 63px
    expect(moved).toBeLessThan((def.speed / (2 * def.accel)) * 1.5);
    expect(moved).toBeLessThan(def.speed * def.chargeWindup * 0.25);
  });

  it('不冲锋的型(蜂群蛭/尾随蛆)贴到脸上也不会进 WINDUP', () => {
    const ship = shipAt(0, 0);
    for (const kind of [KIND_SWARM, KIND_TRAILER]) {
      const e = spawn(kind, 20, 0);
      for (let i = 0; i < 5 * 60; i++) stepOnce(e, ship);
      // 它们的冲锋参数全是 0,一旦被放进 WINDUP 就会以 0 前摇 0 速度乱冲,渲染层预警也会乱闪
      expect(e.state).toBe(ST_APPROACH);
    }
  });
});

describe('冲刺:方向在进前摇那一刻锁死', () => {
  it('中途把船挪走也不改道 —— 玩家来得及转向躲避的唯一机制来源', () => {
    const def = ENEMIES[KIND_BEETLE]!;
    const ship = shipAt(0, 0);
    const e = spawn(KIND_BEETLE, 500, 0);
    driveTo(e, ship, ST_WINDUP);

    const lx = e.lockX;
    const ly = e.lockY;
    expect(Math.hypot(lx, ly)).toBeCloseTo(1, 12); // 单位向量:速度由 chargeSpeed 出
    expect(lx).toBeCloseTo(-1, 6); // 甲虫在 +X 轴、船在原点 → 锁定方向指向 -X
    expect(ly).toBeCloseTo(0, 6);

    // 前摇还没走完就把船挪去另一个象限 = "玩家转向躲开"的最强版本
    ship.x = -900;
    ship.y = 1400;

    // 冲刺段的首尾位置要在 DASH 帧里取:循环退出的那一帧已经是硬直,还会再靠惯性滑一段
    let dashFrames = 0;
    let sx = 0;
    let sy = 0;
    let ex = 0;
    let ey = 0;
    for (let i = 0; i < 30 * 60 && e.state !== ST_RECOVER; i++) {
      const px = e.x;
      const py = e.y;
      stepOnce(e, ship);
      if (e.state !== ST_DASH) continue;
      if (dashFrames === 0) {
        sx = px;
        sy = py;
      }
      ex = e.x;
      ey = e.y;
      dashFrames++;
      const dx = e.x - px;
      const dy = e.y - py;
      expect(dx * ly - dy * lx).toBeCloseTo(0, 9); // 叉乘为 0 = 与锁定方向共线
      expect(dx * lx + dy * ly).toBeGreaterThan(0); // 而且是朝锁定方向走
      expect(Math.hypot(dx, dy)).toBeCloseTo(def.chargeSpeed * SIM_DT, 9); // follow=1,瞬时到速
    }

    expect(e.lockX).toBe(lx); // 锁定值一帧都没被重算过
    expect(e.lockY).toBe(ly);
    expect(dashFrames).toBe(Math.round(def.chargeDuration / SIM_DT));
    // 全程覆盖 chargeSpeed × chargeDuration:渲染层的预警线就是照这个长度画的
    const reach = Math.hypot(ex - sx, ey - sy);
    expect(reach).toBeCloseTo(def.chargeSpeed * def.chargeDuration, 6);
    // 船在 (-900, 1400),敌人却越冲越远 —— 这才叫"没有冲刺中微调"
    expect(Math.hypot(e.x - ship.x, e.y - ship.y)).toBeGreaterThan(1400);
  });

  it('冲完进硬直:不再出力,靠惯性滑出去(啃咬后脱离),硬直完回到接近段', () => {
    const def = ENEMIES[KIND_BEETLE]!;
    const ship = shipAt(0, 0);
    const e = spawn(KIND_BEETLE, 500, 0);
    driveTo(e, ship, ST_RECOVER);

    // 进硬直时还带着冲刺的速度(只被扣掉了当帧那一次半速追随)
    const speedIn = Math.hypot(e.vx, e.vy);
    expect(speedIn).toBeGreaterThan(def.chargeSpeed * 0.9);
    expect(speedIn).toBeLessThanOrEqual(def.chargeSpeed);

    let frames = 0;
    for (let i = 0; i < 10000 && e.state === ST_RECOVER; i++) {
      stepOnce(e, ship);
      frames++;
    }
    expect(e.state).toBe(ST_APPROACH); // 硬直完自己回到接近段,不会卡死在硬直里
    expect(frames).toBe(Math.round(def.chargeRecover / SIM_DT)); // 硬直时长同样由数据表说了算

    // 硬直里只衰减不出力:明显慢下来了,但没被急刹成 0 —— 滑出去的这一段就是玩家的反打窗口
    const speedOut = Math.hypot(e.vx, e.vy);
    expect(speedOut).toBeLessThan(speedIn * 0.2);
    expect(speedOut).toBeGreaterThan(0);
  });
});

describe('侧掠者:必须先绕到舷侧才起手(BH_STRAFE_CHARGE)', () => {
  it('射程内但方位没对(船尾位)不起手 —— 拿掉这一票就退化成追尾冲锋', () => {
    const ship = shipAt(0, 0); // 船头朝 -Y
    const def = ENEMIES[KIND_STRAFER]!;
    expect(150).toBeLessThan(def.chargeRange); // 距离这条早就满足了,拦着它的只可能是方位

    // side=+1 → 目标方位 = heading + 90° = 0(+X 舷侧);把它放在 +Y,即船的正后方
    const stern = spawn(KIND_STRAFER, 0, 150, 1);
    stepOnce(stern, ship);
    expect(stern.state).toBe(ST_APPROACH);

    // 对照组:同一位置的甲虫(BH_SEEK_CHARGE 不看方位)当帧就起手 —— 证明拦住侧掠者的是方位判据
    const beetle = spawn(KIND_BEETLE, 0, 150);
    stepOnce(beetle, ship);
    expect(beetle.state).toBe(ST_WINDUP);
  });

  it('绕到舷侧后自然起手,起手当帧距离与方位两条同时成立(07 验收:确实从侧向切入)', () => {
    const ship = shipAt(0, 0);
    const def = ENEMIES[KIND_STRAFER]!;
    const e = spawn(KIND_STRAFER, 0, 400, 1); // 从船尾外侧出发,方位差 90°、距离也不够

    let angErrAtWindup = -1;
    let distAtWindup = -1;
    for (let i = 0; i < 60 * 60 && angErrAtWindup < 0; i++) {
      const bearing = Math.atan2(e.y - ship.y, e.x - ship.x); // 船 → 敌,全仓统一口径
      const angErr = Math.abs(wrapAngle(ship.heading + 90 * DEG2RAD - bearing));
      const dist = Math.hypot(e.x - ship.x, e.y - ship.y);
      stepOnce(e, ship);
      if (e.state === ST_WINDUP) {
        angErrAtWindup = angErr;
        distAtWindup = dist;
      }
    }

    expect(angErrAtWindup).toBeGreaterThanOrEqual(0); // 确实起手了,不是空过 3600 帧
    expect(angErrAtWindup).toBeLessThan(30 * DEG2RAD); // 起手时人在舷侧,不是在追尾
    expect(distAtWindup).toBeLessThanOrEqual(def.chargeRange);
  });
});

describe('applyDamage(05 号 issue 的唯一伤害入口)', () => {
  it('没打死返回 false,血确实掉了', () => {
    const e = spawn(KIND_STRAFER, 0, 0);
    expect(applyDamage(e, 5)).toBe(false);
    expect(e.hp).toBeCloseTo(e.maxHp - 5, 9);
    expect(e.dead).toBe(false);
  });

  it('致死返回 true 且置 dead;再打一次返回 false(同帧重复致命只算一次)', () => {
    const e = spawn(KIND_SWARM, 0, 0);
    expect(applyDamage(e, e.hp)).toBe(true);
    expect(e.dead).toBe(true);
    expect(e.hp).toBe(0); // 夹到 0:HUD 不必各自兜负数

    // 同一帧的第二颗子弹不能再算一次死亡,否则 10 号 issue 的掉落会按命中数重复给、kills 虚高
    expect(applyDamage(e, 999)).toBe(false);
    expect(e.hp).toBe(0);
  });

  it('溢出伤害不会把血打成负数,过量击杀也只算一次', () => {
    const e = spawn(KIND_BEETLE, 0, 0);
    expect(applyDamage(e, e.maxHp * 10)).toBe(true);
    expect(e.hp).toBe(0);
  });

  it('受击闪白:真扣血的那一发置满 ENEMY_HIT_FLASH,0 伤害不闪(抗性折算后可能归零)', () => {
    const e = spawn(KIND_SWARM, 0, 0);
    applyDamage(e, 5);
    expect(e.hitFlash).toBe(ENEMY_HIT_FLASH);
    expect(e.hp).toBe(e.maxHp - 5);

    const zero = spawn(KIND_SWARM, 0, 0);
    applyDamage(zero, 0);
    expect(zero.hitFlash).toBe(0); // 没掉血 = 没挨打,不给闪白(那会误导"打中了")
  });

  it('致死的那一发也置闪白(尸体当帧回收,闪不闪得到由渲染层判断);已死不再重闪', () => {
    const e = spawn(KIND_SWARM, 0, 0);
    expect(applyDamage(e, e.hp)).toBe(true);
    expect(e.hitFlash).toBe(ENEMY_HIT_FLASH);
    expect(e.dead).toBe(true);

    e.hitFlash = 0; // 尸体在池里待到帧尾:再来的伤害不许把它点亮
    expect(applyDamage(e, 999)).toBe(false);
    expect(e.hitFlash).toBe(0);
  });
});

describe('全局敌速倍率', () => {
  it('enemySpeedScale 每帧现读:接近段与冲刺段都跟着变(面板拖动即时生效)', () => {
    const ship = shipAt(0, 0);
    const swarm = spawn(KIND_SWARM, 300, 0);
    const out = v();

    stepEnemyBehavior(swarm, ship, SIM_DT, out);
    expect(Math.hypot(out.x, out.y)).toBeCloseTo(ENEMIES[KIND_SWARM]!.speed, 9);
    tuning.enemySpeedScale = 0.5;
    stepEnemyBehavior(swarm, ship, SIM_DT, out);
    expect(Math.hypot(out.x, out.y)).toBeCloseTo(ENEMIES[KIND_SWARM]!.speed * 0.5, 9);

    // 冲刺段同样现读:压测时想把虫潮放慢看清行为,冲锋不跟着慢就白搭
    tuning.enemySpeedScale = 1;
    const beetle = spawn(KIND_BEETLE, 500, 0);
    driveTo(beetle, ship, ST_DASH);
    tuning.enemySpeedScale = 0.5;
    stepEnemyBehavior(beetle, ship, SIM_DT, out);
    expect(Math.hypot(out.x, out.y)).toBeCloseTo(ENEMIES[KIND_BEETLE]!.chargeSpeed * 0.5, 9);
  });
});

describe('零分配约定', () => {
  it('期望速度写进调用方的 out,返回 follow ∈ (0, 1]', () => {
    const ship = shipAt(0, 0);
    const out = v();
    for (const kind of [KIND_SWARM, KIND_STRAFER, KIND_TRAILER, KIND_BEETLE]) {
      const e = spawn(kind, 200, 100);
      const follow = stepEnemyBehavior(e, ship, SIM_DT, out);
      expect(follow).toBeGreaterThan(0);
      expect(follow).toBeLessThanOrEqual(1);
      expect(Number.isFinite(out.x) && Number.isFinite(out.y)).toBe(true);
    }
  });
});

describe('孢子炮手(BH_SPORE,22 号 GDD §6.2)', () => {
  // 孢子数值:进带锚定、蓄力、喷吐、按间隔循环 —— 断言里的帧数全靠这几个数算得清
  const SPORE = ENEMIES[KIND_SPORE]!;

  it('接近段:进射程带(≤ sporeRange)即锚定,锚定帧不扣蓄力计时(刚进入不扣帧)', () => {
    const ship = shipAt(0, 0);
    // 船在 (0,0),孢子从射程带外开始压进
    const e = spawn(KIND_SPORE, SPORE.sporeRange + 50, 0);
    driveTo(e, ship, ST_ANCHOR);
    expect(Math.hypot(e.x, e.y)).toBeLessThanOrEqual(SPORE.sporeRange + 1);
    expect(e.timer).toBeCloseTo(SPORE.sporeInterval, 9); // 锚定当帧计时还没开始扣
    // 锚定 = 期望速度恒零(惯性滑行是 World 的 v 积分,单帧看不完,钉的是"不再出力"这件事)
    const out = v();
    stepEnemyBehavior(e, ship, SIM_DT, out);
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
  });

  it('锚定 → 蓄力:sporeInterval 秒后进 ST_SPORE_WINDUP,蓄力期间也钉在原地', () => {
    const ship = shipAt(0, 0);
    const e = spawn(KIND_SPORE, SPORE.sporeRange, 0);
    driveTo(e, ship, ST_ANCHOR);
    const frames = driveTo(e, ship, ST_SPORE_WINDUP);
    // 锚定持续 sporeInterval/SIM_DT 帧(±1:进入当帧不扣计时,与其它状态机同口径)
    expect(frames).toBeGreaterThanOrEqual(SPORE.sporeInterval / SIM_DT - 1);
    expect(frames).toBeLessThanOrEqual(SPORE.sporeInterval / SIM_DT + 1);
    expect(e.timer).toBeCloseTo(SPORE.sporeWarnTime, 9); // 蓄力倒计时 = 预警窗
  });

  it('蓄力到期:sporeFire 置位(世界侧据此发射齐射)并回到锚定,下一轮间隔重新起算', () => {
    const ship = shipAt(0, 0);
    const e = spawn(KIND_SPORE, SPORE.sporeRange, 0);
    driveTo(e, ship, ST_ANCHOR);
    driveTo(e, ship, ST_SPORE_WINDUP);
    e.sporeFire = false; // 模拟世界侧上一轮已消费
    // 蓄力走满 sporeWarnTime 回到锚定的那一帧 = 开火帧(与"刚进入某状态不扣计时"同口径)
    driveTo(e, ship, ST_ANCHOR);
    expect(e.sporeFire).toBe(true); // 闩:世界侧当场读走
    expect(e.state).toBe(ST_ANCHOR);
    expect(e.timer).toBeCloseTo(SPORE.sporeInterval, 9); // 下一轮间隔从开火当帧重新起算
  });

  it('蓄力全程零 rng:sporeFire 只由计时器决定,掷不掷随机都不影响齐射时刻', () => {
    const ship = shipAt(0, 0);
    // 同一帧推进两只同位置孢子:没有 rng 参与,它们的状态机必须逐帧一字不差
    const a = spawn(KIND_SPORE, SPORE.sporeRange, 0);
    const b = spawn(KIND_SPORE, SPORE.sporeRange, 0);
    for (let i = 0; i < 300; i++) {
      stepOnce(a, ship);
      stepOnce(b, ship);
      expect(a.state).toBe(b.state);
      expect(a.timer).toBeCloseTo(b.timer, 12);
      expect(a.sporeFire).toBe(b.sporeFire);
    }
  });

  it('船逃出射程带:锚定/蓄力都放弃,回去重新就位(重新就位 = 接近段)', () => {
    const ship = shipAt(0, 0);
    const e = spawn(KIND_SPORE, SPORE.sporeRange, 0);
    driveTo(e, ship, ST_ANCHOR);
    // 船瞬间开到带外(距孢子 > sporeRange):下一帧孢子就该放弃锚定
    ship.x = e.x + SPORE.sporeRange + 100;
    stepOnce(e, ship);
    expect(e.state).toBe(ST_APPROACH);
    // 蓄力中逃跑同样取消:预警不该对着打不到人的方向演完
    ship.x = 0;
    driveTo(e, ship, ST_ANCHOR);
    driveTo(e, ship, ST_SPORE_WINDUP);
    ship.x = e.x + SPORE.sporeRange + 100;
    stepOnce(e, ship);
    expect(e.state).toBe(ST_APPROACH);
    expect(e.sporeFire).toBe(false); // 取消的那一轮不许开火
  });

  it('船贴脸(进 sporeMinRange 内):后撤保持距离带,退回到带内再重新锚定', () => {
    const ship = shipAt(0, 0);
    const e = spawn(KIND_SPORE, SPORE.sporeRange, 0);
    driveTo(e, ship, ST_ANCHOR);
    // 船瞬移到孢子脸上:锚定作废,接近段背船退
    ship.x = e.x - 10;
    ship.y = e.y;
    const beforeX = e.x;
    stepOnce(e, ship);
    expect(e.state).toBe(ST_APPROACH);
    expect(e.x).toBeGreaterThan(beforeX); // 朝远离船的方向退
    // 退到带内(≥ sporeMinRange)自动重新锚定
    driveTo(e, ship, ST_ANCHOR);
    expect(Math.hypot(e.x - ship.x, e.y - ship.y)).toBeGreaterThanOrEqual(
      SPORE.sporeMinRange - 1,
    );
  });

  it('非远程型永远不进孢子状态(sporeFire 恒 false)', () => {
    const ship = shipAt(0, 0);
    for (const kind of [KIND_SWARM, KIND_STRAFER, KIND_TRAILER, KIND_BEETLE]) {
      const e = spawn(kind, 300, 0);
      for (let i = 0; i < 120; i++) {
        stepOnce(e, ship);
        expect(e.sporeFire).toBe(false);
      }
      expect(e.state).not.toBe(ST_ANCHOR);
      expect(e.state).not.toBe(ST_SPORE_WINDUP);
    }
  });
});

