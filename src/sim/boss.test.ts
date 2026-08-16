/**
 * Boss 战(15 号 T1)的接线与行为测试。
 * 本文件在 Node 环境运行,这本身就是"sim 不依赖 Pixi/DOM"的验证(与 world.test.ts 同口径)。
 *
 * 分工:Boss 个体的状态机(纯函数,喂一只 Enemy + 一艘船就能跑完)在这里钉;
 * 世界这一层的接线(登场时机、召唤 rng 口径、胜利判定、掉落、checksum)也在这里钉 ——
 * 局终判定那条既有链路(脚本走完不算赢、击杀 Boss 才赢)在 world.test.ts 钉。
 *
 * 一律用 splice 进来的短脚本(与 waves.test.ts 同口径):真脚本 480s ≈ 28800 逻辑帧,单测里等不起。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SIM_DT, SIM_HZ } from '../core/loop';
import { STARTING_STAR_COINS, SHOP_BEACON_LIFETIME, SHOP_BEACON_MAX_DIST, SHOP_BEACON_MIN_DIST } from '../data/economy';
import {
  BOSS,
  ENEMIES,
  KIND_BEETLE,
  KIND_BOSS,
  KIND_STRAFER,
  KIND_SWARM,
} from '../data/enemies';
import {
  SPAWN_RADIUS,
  SPAWN_RADIUS_BAND,
  WAVE_MAX_ALIVE,
  WAVE_SEGMENTS,
} from '../data/waves';
import {
  BOSS_CHASE,
  BOSS_DASH,
  BOSS_RECOVER,
  BOSS_WINDUP,
  BOSS_Z_LEGS,
  bossContactDamage,
  bossEjectTickCap,
  bossZLaneDir,
  initBoss,
  initEject,
  initSummon,
  stepBossBehavior,
} from './boss';
import { tuning } from './config';
import { createEnemy, enemyAnimSeed, type Enemy, hpScaleAt, initEnemy, ST_APPROACH } from './enemy';
import { captureRun, restoreRun } from './runSave';
import { createShip, type Vec2 } from './ship';
import { ACQUIRE_OK, RESULT_RUNNING, RESULT_WIN, World } from './world';
import { TOWER_AUTOCANNON, TOWERS } from '../data/towers';

/** 测试用小规模,与 world.test.ts 同口径:有用例会拖字段,跑完必须还原 */
const BASE = {
  stressSpawn: true,
  shipHullHp: 100,
  enemySpeedScale: 1,
  enemyContactDamageScale: 1,
  enemyHitInterval: 0.6,
};
Object.assign(tuning, BASE);

const REAL = WAVE_SEGMENTS.slice();
afterEach(() => {
  WAVE_SEGMENTS.splice(0, WAVE_SEGMENTS.length, ...REAL);
  Object.assign(tuning, BASE);
});

/** 段长刻意不取整帧:与 world.test.ts 的局终判定同一条口径,跨段帧无歧义 */
const DUR = 0.505;
const CROSS = Math.ceil(DUR * SIM_HZ);

/**
 * 一个"脚本已走完、Boss 已登场"的世界:换短脚本 → 走完 → Boss 阶段进入。
 * 船体 HP 上限临时抬到 1e6:多数用例要 Boss 活着跑几十秒(召唤/行为),不能被它撞沉。
 */
function bossWorld(seed: number): World {
  tuning.stressSpawn = false;
  tuning.shipHullHp = 1e6;
  WAVE_SEGMENTS.splice(0, WAVE_SEGMENTS.length, {
    slug: 'short',
    devName: 'short',
    duration: DUR,
    dirStartDeg: 0,
    dirEndDeg: 0,
    streams: [],
    bursts: [],
    elites: [],
    tides: [],
  });
  const w = new World(seed);
  for (let i = 0; i < CROSS; i++) w.step();
  return w; // wave.done → bossPhase === 1
}

/** 召唤计时从 summonInterval 起逐帧减 dt、到点触发:照 world 那句累减重放一遍 */
function summonFrames(): number {
  let left = BOSS.summonInterval;
  let n = 0;
  while (left > 0) {
    left = Math.max(0, left - SIM_DT);
    n++;
  }
  return n;
}

/** 把敌人钉在某处并清速度(全仓 park 口径) */
function park(e: Enemy, x: number, y: number): void {
  e.x = e.px = x;
  e.y = e.py = y;
  e.vx = 0;
  e.vy = 0;
}

describe('Boss 行为状态机(纯函数,可脱离世界)', () => {
  function makeBoss(x: number, y: number): Enemy {
    const e = createEnemy();
    initBoss(e, x, y, 0);
    return e;
  }

  it('initBoss / initSummon 写入动画相位种子(出生位置 hash,与 initEnemy 同口径)', () => {
    const boss = makeBoss(400, -200);
    expect(boss.animSeed).toBe(enemyAnimSeed(400, -200));

    const summon = createEnemy();
    initSummon(summon, 0, -50, 80, 0, 3);
    expect(summon.animSeed).toBe(enemyAnimSeed(-50, 80));
  });

  it('initEject:弹射怪 = dashEjectKind 直给、普通血量无词缀、带弹射初速(大小 = dashEjectSpeed、方向 = 弹射角)', () => {
    const e = createEnemy();
    initEject(e, 300, -120, Math.PI / 2, 0);
    expect(e.kind).toBe(BOSS.dashEjectKind);
    expect(e.affixes).toBe(0); // 弹射怪不是小精英
    expect(e.hp).toBeCloseTo(ENEMIES[BOSS.dashEjectKind]!.hp * hpScaleAt(0), 9);
    expect(e.hp).toBe(e.maxHp);
    expect(e.state).toBe(ST_APPROACH);
    expect(e.side).toBe(0); // 与 initBoss 同一条零 rng 口径
    expect(e.animSeed).toBe(enemyAnimSeed(300, -120));
    expect(e.vx).toBeCloseTo(0, 9); // cos(π/2)
    expect(e.vy).toBeCloseTo(BOSS.dashEjectSpeed, 9);
    expect(Math.hypot(e.vx, e.vy)).toBeCloseTo(BOSS.dashEjectSpeed, 9);
  });

  it('bossEjectTickCap:一次冲刺的弹射批次数上限 = ⌈chargeDuration / dashEjectInterval⌉ + 1(结构常数)', () => {
    expect(bossEjectTickCap()).toBe(Math.ceil(BOSS.chargeDuration / BOSS.dashEjectInterval) + 1);
    expect(bossEjectTickCap()).toBeGreaterThan(BOSS.chargeDuration / BOSS.dashEjectInterval);
  });

  it('接近段 seek 追船;进冲锋距离 → 锁方向进长前摇,前摇刹停且帧数 = 表里 chargeWindup', () => {
    const ship = createShip(); // 船在原点
    const e = makeBoss(300, 0); // 射程(底座 420 × 1.5 = 630)之内
    const out: Vec2 = { x: 0, y: 0 };

    let follow = stepBossBehavior(e, ship, SIM_DT, out);
    expect(e.state).toBe(BOSS_WINDUP);
    expect(e.lockX).toBe(-1); // 方向在这一刻锁死(敌 → 船:Boss 在船 +X,锁的是 -X)
    expect(e.lockY).toBe(0);
    expect(out.x).toBe(0); // 前摇刹住:肉眼看得出"停下来蓄力"
    expect(out.y).toBe(0);
    expect(follow).toBeGreaterThan(0);

    // 前摇逐帧减 dt:恰好 chargeWindup / SIM_DT 帧后进冲刺(浮点累减与 sim 同口径)
    let windupFrames = 0;
    while (e.state === BOSS_WINDUP) {
      stepBossBehavior(e, ship, SIM_DT, out);
      windupFrames++;
    }
    expect(windupFrames).toBe(Math.round(BOSS.chargeWindup / SIM_DT));
    expect(e.state).toBe(BOSS_DASH);
  });

  it('射程外不锁前摇:接近段持续 seek 追船(速度 = 底座 × speedMul × 全局倍率)', () => {
    const ship = createShip();
    const e = makeBoss(2000, 0); // 630 射程之外
    const out: Vec2 = { x: 0, y: 0 };

    stepBossBehavior(e, ship, SIM_DT, out);
    expect(e.state).toBe(BOSS_CHASE);
    expect(out.x).toBeLessThan(0); // 朝船(-X)走
    expect(out.y).toBeCloseTo(0, 9);
    const want = ENEMIES[KIND_BEETLE]!.speed * BOSS.speedMul * tuning.enemySpeedScale;
    expect(Math.hypot(out.x, out.y)).toBeCloseTo(want, 9);
  });

  it('前摇锁死方向:冲刺折 Z 字(逐段 ±chargeZAngleDeg 交替、三段等长)全速、绝不重新瞄准;冲完硬直,再回接近段', () => {
    const ship = createShip();
    const e = makeBoss(300, 0);
    const out: Vec2 = { x: 0, y: 0 };
    stepBossBehavior(e, ship, SIM_DT, out); // → WINDUP,锁 (-1,0)

    // 船挪走:冲刺期间读到的若是新位置,前摇预警画出的折线就成了谎言
    ship.x = 5000;
    ship.y = 5000;
    while (e.state !== BOSS_DASH) stepBossBehavior(e, ship, SIM_DT, out);
    expect(e.state).toBe(BOSS_DASH);
    const want = ENEMIES[KIND_BEETLE]!.chargeSpeed * BOSS.chargeSpeedMul;
    const c30 = Math.cos(Math.PI / 6);
    const s30 = Math.sin(Math.PI / 6);
    // 段 0:锁向 +30°(锁 -X → 偏 -Y 侧)
    expect(out.x).toBeCloseTo(-want * c30, 9);
    expect(out.y).toBeCloseTo(-want * s30, 9);

    // 逐帧数段:三段等长、翻段方向交替;段号由 timer 折出(与 sim 同一条闭式)
    const legFrames = Math.round((BOSS.chargeDuration / BOSS_Z_LEGS) / SIM_DT);
    const framesInLeg = [1, 0, 0]; // 上面进段那一步已输出段 0 的第 1 帧
    let total = 1;
    let leg = 0;
    while (e.state === BOSS_DASH) {
      stepBossBehavior(e, ship, SIM_DT, out);
      if (e.state !== BOSS_DASH) break;
      const elapsed = BOSS.chargeDuration - e.timer;
      const cur = Math.min(BOSS_Z_LEGS - 1, Math.floor((elapsed * BOSS_Z_LEGS) / BOSS.chargeDuration));
      if (cur !== leg) {
        leg = cur;
        // 翻段那一帧:方向 = 锁向按 ±chargeZAngleDeg 交替(仍在锁定折线上,不重新瞄准)
        expect(out.x).toBeCloseTo(-want * c30, 9);
        expect(out.y).toBeCloseTo(cur % 2 === 0 ? -want * s30 : want * s30, 9);
      }
      total++;
      framesInLeg[leg]!++;
    }
    // 三段等长(±1 帧容差:dt = 1/60 是二进制无限小数,逐帧累减的漂移会把翻段点挪一帧,
    // 与老直线冲刺"全程帧数"同一条浮点口径);全程帧数必须精确 = chargeDuration / SIM_DT
    for (const n of framesInLeg) expect(Math.abs(n - legFrames)).toBeLessThanOrEqual(1);
    expect(framesInLeg.reduce((s, n) => s + n, 0)).toBe(Math.round(BOSS.chargeDuration / SIM_DT));
    expect(total).toBe(Math.round(BOSS.chargeDuration / SIM_DT));
    expect(e.state).toBe(BOSS_RECOVER);
    expect(out.x).toBe(0); // 硬直不出力,靠惯性滑出去
    expect(out.y).toBe(0);

    let recoverFrames = 0;
    while (e.state === BOSS_RECOVER) {
      stepBossBehavior(e, ship, SIM_DT, out);
      recoverFrames++;
    }
    expect(recoverFrames).toBe(Math.round(BOSS.chargeRecover / SIM_DT));
    expect(e.state).toBe(BOSS_CHASE);
    stepBossBehavior(e, ship, SIM_DT, out);
    expect(out.x).toBeGreaterThan(0); // 回到接近段:重新 seek 追船
    expect(out.y).toBeGreaterThan(0);
  });

  it('bossZLaneDir:锁向按 ±chargeZAngleDeg 交替偏转,零次随机、单位长度(预警折线与 DASH 共用)', () => {
    const out: Vec2 = { x: 0, y: 0 };
    const c30 = Math.cos(Math.PI / 6);
    const s30 = Math.sin(Math.PI / 6);
    // 锁 +X:段 0/2 = +30°,段 1 = -30°;三段合成一条 Z 走廊
    bossZLaneDir(1, 0, 0, out);
    expect(out.x).toBeCloseTo(c30, 12);
    expect(out.y).toBeCloseTo(s30, 12);
    bossZLaneDir(1, 0, 1, out);
    expect(out.x).toBeCloseTo(c30, 12);
    expect(out.y).toBeCloseTo(-s30, 12);
    bossZLaneDir(1, 0, 2, out);
    expect(out.x).toBeCloseTo(c30, 12);
    expect(out.y).toBeCloseTo(s30, 12);
    // 锁 -X:镜像;单位长度不因方向变
    bossZLaneDir(-1, 0, 0, out);
    expect(Math.hypot(out.x, out.y)).toBeCloseTo(1, 12);
    expect(out.y).toBeCloseTo(-s30, 12);
    // 偶数段恒同、奇数段恒反:与段号奇偶绑定(0 段与 2 段可互换,不影响走廊形状)
    bossZLaneDir(0, 1, 1, out); // 锁 +Y:-30° 段
    expect(out.x).toBeCloseTo(s30, 12);
    expect(out.y).toBeCloseTo(c30, 12);
  });
});

describe('Boss 战接线(15 号:登场、召唤、胜利、掉落、确定性)', () => {
  it('巨大慢速激光球:独立倒计时到点发射、方向锁定、尺寸/速度走 Boss 数据', () => {
    const w = bossWorld(13);
    // 关掉玩家火力,避免点防在同一帧把大球拦截掉;本用例只看 Boss 发射侧。
    for (const slot of w.weapons) slot.type = -1;
    expect(w.bossLaserCooldown).toBe(BOSS.laserInterval);

    const frames = Math.ceil(BOSS.laserInterval * SIM_HZ) + 2;
    for (let f = 0; f < frames; f++) w.step();
    const laser = w.enemyBullets.items.find((b) => b.kind === KIND_BOSS);
    expect(laser).toBeDefined();
    expect(laser!.radius).toBe(BOSS.laserRadius);
    expect(laser!.damage).toBeCloseTo(BOSS.laserDamage * tuning.enemySporeDamageScale, 9);
    expect(Math.hypot(laser!.vx, laser!.vy)).toBeCloseTo(BOSS.laserSpeed, 9);
    expect(laser!.life).toBeLessThanOrEqual(BOSS.laserLife);
    // 发射后倒计时重置,下一颗不会在同一帧重复生成。
    expect(w.bossLaserCooldown).toBeGreaterThan(BOSS.laserInterval - SIM_DT * 2);
  });

  it('脚本走完那一帧进入 Boss 战:生成 Boss 一只(与敌人同池、专用 kind 标记、零 rng)', () => {
    const w = bossWorld(5);
    expect(w.wave.done).toBe(true);
    expect(w.bossPhase).toBe(1);
    expect(w.bossSummonN).toBe(0);
    expect(w.bossSummonCooldown).toBe(BOSS.summonInterval);

    const bosses = w.enemies.items.filter((e) => e.kind === KIND_BOSS);
    expect(bosses.length).toBe(1);
    const boss = bosses[0]!;
    expect(boss.affixes).toBe(0); // 绝不用 affixes 位(14 号精英判据)
    expect(boss.state).toBe(BOSS_CHASE);
    expect(boss.hp).toBeCloseTo(
      ENEMIES[KIND_BEETLE]!.hp * hpScaleAt(w.elapsed) * BOSS.hpMul,
      9,
    );
    expect(boss.maxHp).toBe(boss.hp);
    // 出生在出怪环上(以船为心),方向 = 脚本最后的主压方向(本脚本恒 0° = +X)
    const d = Math.hypot(boss.x - w.ship.x, boss.y - w.ship.y);
    expect(d).toBeGreaterThanOrEqual(SPAWN_RADIUS);
    expect(d).toBeLessThan(SPAWN_RADIUS + SPAWN_RADIUS_BAND);
    expect(boss.y).toBeCloseTo(w.ship.y, 6);
    expect(boss.x).toBeGreaterThan(w.ship.x);
  });

  it('调试入口 debugSpawnBoss:波次未走完也能进 Boss 战(同一条 enterBossPhase、零 rng),再按再来一只', () => {
    const w = new World(5);
    expect(w.wave.done).toBe(false);
    expect(w.bossPhase).toBe(0);

    w.debugSpawnBoss();
    expect(w.bossPhase).toBe(1);
    expect(w.bossSummonN).toBe(0);
    expect(w.bossSummonCooldown).toBe(BOSS.summonInterval);
    const bosses = w.enemies.items.filter((e) => e.kind === KIND_BOSS);
    expect(bosses.length).toBe(1);
    expect(bosses[0]!.affixes).toBe(0); // 绝不用 affixes 位(14 号精英判据)
    // 出生在出怪环上(以船为心),与脚本走完那一帧同一条 enterBossPhase
    const d = Math.hypot(bosses[0]!.x - w.ship.x, bosses[0]!.y - w.ship.y);
    expect(d).toBeGreaterThanOrEqual(SPAWN_RADIUS);
    expect(d).toBeLessThan(SPAWN_RADIUS + SPAWN_RADIUS_BAND);

    // 零 rng:同 seed 两局各按一次,随机流逐位一致(与"脚本走完那一帧"同一条口径)
    const a = new World(7);
    const b = new World(7);
    a.debugSpawnBoss();
    b.debugSpawnBoss();
    expect(a.rng.next()).toBe(b.rng.next());

    // 再按 = 再来一只(召唤计时与游标按 enterBossPhase 归零重计)
    w.bossSummonCooldown = 0;
    w.debugSpawnBoss();
    expect(w.enemies.items.filter((e) => e.kind === KIND_BOSS).length).toBe(2);
    expect(w.bossSummonCooldown).toBe(BOSS.summonInterval);
    expect(w.bossSummonN).toBe(0);
  });

  it('最后一跨与 Boss 同帧投放商店信标:段下标 = 越界哨兵,两张货架照常掷定(每两分钟一次)', () => {
    const w = bossWorld(9);
    expect(w.wave.done).toBe(true);
    expect(w.bossPhase).toBe(1);
    expect(w.shopBeaconActive).toBe(true); // 设计会:第 8 分钟不例外,与 Boss 同帧
    expect(w.shopBeaconSegment).toBe(WAVE_SEGMENTS.length); // 越界哨兵:UI 侧另拟标题
    expect(w.shopBeaconTtl).toBeCloseTo(SHOP_BEACON_LIFETIME, 6);
    const dist = Math.hypot(w.shopBeaconX - w.ship.x, w.shopBeaconY - w.ship.y);
    expect(dist).toBeGreaterThanOrEqual(SHOP_BEACON_MIN_DIST - 1);
    expect(dist).toBeLessThanOrEqual(SHOP_BEACON_MAX_DIST + 1);
    expect(w.dockEdictOffers.length).toBeGreaterThan(0);
    expect(w.shopWeapons.length).toBeGreaterThan(0);
    expect(w.shopDiscountIndex).toBeGreaterThanOrEqual(0);
  });

  it('召唤:每 summonInterval 秒一批,型号/数量直给、出生在 Boss 身边一圈、侧掠者左右交替', () => {
    const w = bossWorld(7);
    const boss = w.enemies.items.find((e) => e.kind === KIND_BOSS)!;
    // 用 spawn 挂钩把「召唤」与「冲刺弹射」分开:召唤怪出生时零初速,弹射怪带 dashEjectSpeed
    // 离膛(Boss 在第二批召唤前后会追进冲锋圈开始冲刺弹射,不分开的话数量账会被弹射污染)
    const summoned: Enemy[] = [];
    w.onEnemySpawn = (e) => {
      if (Math.hypot(e.vx, e.vy) === 0) summoned.push(e);
    };
    for (let f = 0; f < summonFrames(); f++) w.step();

    expect(w.bossSummonN).toBe(1);
    expect(w.bossSummonCooldown).toBe(BOSS.summonInterval); // 触发后重置,下一批再等一个周期

    const minions = w.enemies.items.filter((e) => e.kind !== KIND_BOSS);
    const total = BOSS.summonCounts.reduce((s, n) => s + n, 0);
    expect(minions.length).toBe(total);
    const byKind = new Map<number, number>();
    const straferSides = new Set<number>();
    for (const m of minions) {
      byKind.set(m.kind, (byKind.get(m.kind) ?? 0) + 1);
      if (m.kind === KIND_STRAFER) straferSides.add(m.side);
      // 出生在 Boss 身边一圈(summonRingRadius);px/py 是出生点(插值两端)
      const ring = Math.hypot(m.px - boss.px, m.py - boss.py);
      expect(ring).toBeCloseTo(BOSS.summonRingRadius, 6);
      expect(m.affixes).toBe(0); // 召唤怪不是小精英
      expect(m.hp).toBeCloseTo(ENEMIES[m.kind]!.hp * hpScaleAt(w.elapsed), 9);
      expect(m.hp).toBe(m.maxHp);
    }
    for (let k = 0; k < BOSS.summonCounts.length; k++) {
      expect(byKind.get(k) ?? 0).toBe(BOSS.summonCounts[k]!);
    }
    expect(straferSides).toEqual(new Set([-1, 1])); // side 交替直给,不掷随机

    // 第二批:再过一个周期,游标 2、数量翻倍(只数召唤,不含冲刺弹射)
    for (let f = 0; f < summonFrames(); f++) w.step();
    expect(w.bossSummonN).toBe(2);
    expect(summoned.length).toBe(total * 2);
  });

  it('召唤预告:bossSummonCooldown 是渲染层的预警时间字段(最后 summonWarnTime 秒可读)', () => {
    const w = bossWorld(15);
    expect(w.bossSummonCooldown).toBe(BOSS.summonInterval); // 进场即满

    // 走到预告窗口内:cooldown 已经比 summonWarnTime 小、但召唤还没触发
    const warnFrames = Math.ceil(BOSS.summonWarnTime * SIM_HZ);
    for (let f = 0; f < summonFrames() - warnFrames + 1; f++) w.step();
    expect(w.bossSummonCooldown).toBeGreaterThan(0);
    expect(w.bossSummonCooldown).toBeLessThan(BOSS.summonWarnTime);
    expect(w.bossSummonN).toBe(0);

    // 再走到触发:游标 +1、计时重置(渲染层读到的"预告"与"触发"严丝合缝)
    while (w.bossSummonN === 0) w.step();
    expect(w.bossSummonN).toBe(1);
    expect(w.bossSummonCooldown).toBe(BOSS.summonInterval);
  });

  it('召唤 rng 口径:每只召唤怪恰好一次角度(型号/数量直给不掷随机)', () => {
    const a = bossWorld(42);
    const b = bossWorld(42);
    // b 的 Boss 当场击杀:从此 b 不再召唤。**击杀会掷一次星币判定**(用户设计会:10% 概率掉),
    // 那一掷发生在下一帧的 reap 里,故下面两条流的对齐要把它算进去(见循环后的补掷)
    const bb = b.enemies.items.find((e) => e.kind === KIND_BOSS)!;
    expect(b.damageEnemy(bb, 9999)).toBe(true);

    let frames = 0;
    while (a.bossSummonN === 0 && frames < summonFrames() + 2) {
      a.step();
      b.step();
      frames++;
    }
    expect(a.bossSummonN).toBe(1);
    expect(b.bossSummonN).toBe(0);
    // 数量口径的旁证:池里 = Boss + 恰好 summonCounts 总和只召唤怪
    const total = BOSS.summonCounts.reduce((s, n) => s + n, 0);
    expect(a.enemies.size - 1).toBe(total);

    // 这次召唤恰好吃掉 total 次 rng(每只一次出生角);而 b 那边多掷了一次星币判定
    // (Boss 被回收那一帧),故补给 a:两条流站回同一格
    for (let i = 0; i < total; i++) b.rng.next();
    a.rng.next();
    expect(a.rng.next()).toBe(b.rng.next());
  });

  it('召唤共享 WAVE_MAX_ALIVE 上限:触顶丢弃、不留账,且触顶帧一次 rng 都不掷', () => {
    const fill = (w: World): void => {
      while (w.enemies.size < WAVE_MAX_ALIVE) {
        const e = w.enemies.spawn();
        initEnemy(e, KIND_SWARM, 5000, 5000, w.elapsed, w.rng);
      }
    };
    const a = bossWorld(13);
    fill(a);
    const b = bossWorld(13);
    const bb = b.enemies.items.find((e) => e.kind === KIND_BOSS)!;
    expect(b.damageEnemy(bb, 9999)).toBe(true); // 对照:没有召唤的世界,随机流只走星币那一掷
    fill(b);

    const sizeBefore = a.enemies.size;
    a.bossSummonCooldown = SIM_DT; // 直接拨到下一帧触发(计时本身有别的用例钉)
    a.step();
    b.step();
    expect(a.bossSummonN).toBe(1); // 事件"到点即消费"(游标照 eliteNext 先例)
    expect(a.enemies.size).toBe(sizeBefore); // 一只都没落地:触顶丢弃、不留账
    expect(a.enemies.size).toBe(WAVE_MAX_ALIVE);
    // 触顶帧**召唤**一次 rng 都不掷;b 那边多掷的是 Boss 回收那一帧的星币判定,补给 a 后同格
    a.rng.next();
    expect(a.rng.next()).toBe(b.rng.next());
  });

  it('冲刺弹射:进 DASH 后每 dashEjectInterval 秒弹一批(型号直给、在 Boss 当前位置离膛、带初速),游标到点即消费、离段归零', () => {
    const w = bossWorld(21);
    const boss = w.enemies.items.find((e) => e.kind === KIND_BOSS)!;
    park(boss, w.ship.x + 300, w.ship.y); // 起手圈(630)内:下一帧进前摇

    // 弹射怪是这批步骤里唯一的 spawn 来源(Boss 早已登场;召唤首触发在 7s,这里 4s 内走完)
    const spawns: {
      at: number;
      kind: number;
      x: number;
      y: number;
      vx: number;
      vy: number;
      bx: number;
      by: number;
      ux: number;
      uy: number;
      speed: number;
      hpWant: number;
    }[] = [];
    w.onEnemySpawn = (e) => {
      // 挂钩在帧首弹射里触发:此刻 Boss 与船当帧都没动,弹射点 = Boss 位置、方向 = 船方位
      const dx = w.ship.x - boss.x;
      const dy = w.ship.y - boss.y;
      const dl = Math.hypot(dx, dy) || 1;
      spawns.push({
        at: w.bossEjectDone,
        kind: e.kind,
        x: e.x,
        y: e.y,
        vx: e.vx,
        vy: e.vy,
        bx: boss.x,
        by: boss.y,
        ux: dx / dl,
        uy: dy / dl,
        speed: Math.hypot(e.vx, e.vy),
        hpWant: ENEMIES[BOSS.dashEjectKind]!.hp * hpScaleAt(w.elapsed), // 出生时刻口径
      });
    };

    for (let f = 0; f < 200 && boss.state !== BOSS_DASH; f++) w.step();
    expect(boss.state).toBe(BOSS_DASH);
    expect(w.bossEjectDone).toBe(0); // 刚进冲刺:一批都还没到点

    let maxDone = 0;
    for (let f = 0; f < 200 && boss.state !== BOSS_RECOVER; f++) {
      w.step();
      maxDone = Math.max(maxDone, w.bossEjectDone);
    }
    // 批次数 = 冲刺内能到点的批次:duration 恰好是 interval 整数倍时,末批落在最后
    // 一帧的头部之外(那时 elapsed = duration − dt),故不算 —— 与 sim 同一条浮点口径
    const ticksPerDash = Math.floor((BOSS.chargeDuration - SIM_DT) / BOSS.dashEjectInterval);
    expect(maxDone).toBe(ticksPerDash); // 2.4/0.6 → 3 批(0.6/1.2/1.8s)
    // 弹射点 = Boss 当时的位置、初速 = dashEjectSpeed、方向 = 船方位(零 rng)、型号直给
    expect(spawns.length).toBe(maxDone * BOSS.dashEjectCount);
    for (const s of spawns) {
      expect(s.kind).toBe(BOSS.dashEjectKind);
      expect(s.x).toBeCloseTo(s.bx, 9);
      expect(s.y).toBeCloseTo(s.by, 9);
      expect(s.speed).toBeCloseTo(BOSS.dashEjectSpeed, 9);
      expect(s.vx / s.speed).toBeCloseTo(s.ux, 9); // 笔直朝船:与「Boss → 船」同向
      expect(s.vy / s.speed).toBeCloseTo(s.uy, 9);
    }
    // 到点即消费:每批内的两只都记在同一个游标值下(1/2/3 各两只)
    const byTick = new Map<number, number>();
    for (const s of spawns) byTick.set(s.at, (byTick.get(s.at) ?? 0) + 1);
    for (let t = 1; t <= maxDone; t++) expect(byTick.get(t)).toBe(BOSS.dashEjectCount);

    // 离开 DASH(硬直)那一帧游标归零:下一帧头复位
    for (let f = 0; f < 3; f++) w.step();
    expect(w.bossEjectDone).toBe(0);
    // 弹射怪 = 普通血量的小怪(不 ×ELITE.hpMul、不进词缀),出场即 seek 追船;
    // HP 按各自出生时刻的时间缩放现算(时间缩放逐秒爬,不同批次的出生 HP 本就不同)
    const ejected = w.enemies.items.filter((e) => e.kind === BOSS.dashEjectKind);
    expect(ejected.length).toBe(maxDone * BOSS.dashEjectCount);
    for (let i = 0; i < ejected.length; i++) {
      const m = ejected[i]!;
      expect(m.affixes).toBe(0);
      expect(m.hp).toBeCloseTo(spawns[i]!.hpWant, 9);
      expect(m.state).toBe(ST_APPROACH);
    }
  });

  it('弹射零 rng:方向 = 船方位现算,弹射完全不扰动随机序列(与召唤相反)', () => {
    const a = bossWorld(33);
    const b = bossWorld(33);
    const ba = a.enemies.items.find((e) => e.kind === KIND_BOSS)!;
    const bb = b.enemies.items.find((e) => e.kind === KIND_BOSS)!;
    park(ba, a.ship.x + 300, a.ship.y); // 冲锋圈内:走完整条冲刺,弹三批
    park(bb, 50000, 50000); // 对照组:冲锋圈外永不弹射(seek 也拉不回来)
    const frames = Math.ceil((BOSS.chargeWindup + BOSS.chargeDuration) * SIM_HZ) + 4;
    for (let f = 0; f < frames; f++) {
      a.step();
      b.step();
    }
    const ticksPerDash = Math.floor((BOSS.chargeDuration - SIM_DT) / BOSS.dashEjectInterval);
    const ejectedA = a.enemies.items.filter((e) => e.kind === BOSS.dashEjectKind);
    expect(ejectedA.length).toBe(ticksPerDash * BOSS.dashEjectCount);
    // 零 rng:a 弹了三批、b 一场没弹,两边的随机流仍逐位同格 —— 一次补偿都不需要
    // (方向是 atan2 现算,型号/数量直给;弹射怪此后 seek/追击/接触也都不掷随机)
    expect(a.rng.next()).toBe(b.rng.next());
  });

  it('弹射共享 WAVE_MAX_ALIVE 上限:触顶丢弃、不留账,且触顶帧一次 rng 都不掷', () => {
    const fill = (w: World): void => {
      while (w.enemies.size < WAVE_MAX_ALIVE) {
        const e = w.enemies.spawn();
        initEnemy(e, KIND_SWARM, 5000, 5000, w.elapsed, w.rng);
      }
    };
    const a = bossWorld(37);
    const b = bossWorld(37);
    fill(a);
    fill(b);
    const ba = a.enemies.items.find((e) => e.kind === KIND_BOSS)!;
    const bb = b.enemies.items.find((e) => e.kind === KIND_BOSS)!;
    park(ba, a.ship.x + 300, a.ship.y);
    park(bb, 50000, 50000); // 对照组:不冲锋 = 不弹射
    const sizeBefore = a.enemies.size;
    const frames = Math.ceil((BOSS.chargeWindup + BOSS.chargeDuration) * SIM_HZ) + 4;
    let maxDone = 0;
    for (let f = 0; f < frames; f++) {
      a.step();
      b.step();
      maxDone = Math.max(maxDone, a.bossEjectDone);
    }
    expect(maxDone).toBeGreaterThanOrEqual(1); // 批次"到点即消费"(游标照 eliteNext 先例)
    expect(a.enemies.size).toBe(sizeBefore); // 一只都没落地:触顶丢弃、不留账
    expect(a.rng.next()).toBe(b.rng.next()); // 弹射零 rng:触顶丢弃也不掷,两条流逐位同格
  });

  it('冲刺中途存档:读档后弹射游标接得上(checksum 一致、继续推进逐帧一致)', () => {
    const w = bossWorld(41);
    const boss = w.enemies.items.find((e) => e.kind === KIND_BOSS)!;
    park(boss, w.ship.x + 300, w.ship.y);
    for (let f = 0; f < 200 && boss.state !== BOSS_DASH; f++) w.step();
    expect(boss.state).toBe(BOSS_DASH);
    while (w.bossEjectDone < 2) w.step(); // 走到第二批已弹完(1.2s < 冲刺 2.4s,必然还在 DASH)
    expect(boss.state).toBe(BOSS_DASH);
    expect(w.bossEjectDone).toBe(2);

    const restored = restoreRun(captureRun(w, { seed: 41 }));
    expect(restored.bossEjectDone).toBe(2);
    expect(restored.checksum()).toBe(w.checksum());
    // 继续推进:游标漏存的话,读档侧会从 0 重发整批弹射,checksum 当场分叉
    for (let seg = 0; seg < 4; seg++) {
      for (let f = 0; f < 60; f++) {
        w.step();
        restored.step();
      }
      expect(restored.checksum()).toBe(w.checksum());
    }
  });

  it('同 seed 两局:Boss 行为与召唤逐位可复现(15 验收),换 seed 才换', () => {
    const run = (seed: number): string => {
      const w = bossWorld(seed);
      const out: string[] = [];
      let prevState = -1;
      let prevSum = -1;
      for (let f = 0; f < 30 * SIM_HZ; f++) {
        w.step();
        const b = w.enemies.items.find((e) => e.kind === KIND_BOSS);
        if (!b) {
          out.push(`bossGone@${f}`);
          break;
        }
        if (b.state !== prevState) {
          out.push(`s${f}:${b.state}`);
          prevState = b.state;
        }
        if (w.bossSummonN !== prevSum) {
          out.push(`sum${f}:${w.bossSummonN}`);
          prevSum = w.bossSummonN;
        }
      }
      out.push(w.checksum());
      return out.join('|');
    };
    const a = run(20260815);
    // 非空过:30 秒里真的发生过状态跃迁(进过前摇)与至少两次召唤
    expect(a).toMatch(/s\d+:11/);
    expect((a.match(/sum\d+:\d+/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(run(20260815)).toBe(a); // 同 seed:整局逐位一致
    expect(run(20260816)).not.toBe(a); // 换 seed 才换
  });

  it('击杀 Boss → 胜利:记 bossKilledAt 与击杀数,双轨进账:固定星币当场入账 + 原地掉一颗 Boss 档经验', () => {
    const w = bossWorld(9);
    expect(w.wave.done).toBe(true);
    expect(w.bossPhase).toBe(1);
    expect(w.result).toBe(RESULT_RUNNING);
    const boss = w.enemies.items.find((e) => e.kind === KIND_BOSS)!;
    let over = -1;
    w.onGameOver = (r) => (over = r);
    const killsBefore = w.kills;

    expect(w.damageEnemy(boss, 9999)).toBe(true);
    w.step();

    expect(w.kills).toBe(killsBefore + 1); // Boss 击杀计入 kills
    expect(w.bossPhase).toBe(2);
    expect(w.bossKilledAt).toBeCloseTo(w.elapsed, 12); // 与 kills 同口径:回收那一帧的时刻
    expect(w.result).toBe(RESULT_WIN);
    expect(over).toBe(RESULT_WIN);

    // 双轨进账(见 World.spawnDrop):星币**按概率**入账(用户设计会:每次击杀恒掷一次、
    // 命中 buffs.starCoinChance 才给),故这里只钉两档合法读数 —— 要么一分没进、要么整额
    // BOSS.starCoins,绝不会是别的数(面额本身没变,变的只是给不给)。命中与否由那一掷决定,
    // 与 seed 绑定;两档都从开局白送的 STARTING_STAR_COINS 起算(那是余额的地板,不是收入)
    expect([STARTING_STAR_COINS, STARTING_STAR_COINS + BOSS.starCoins]).toContain(w.starCoins);
    // 经验走掉落物:原地必掉一颗,面额 = 底座 scrap × BOSS.dropMul(掉落档,与 hpMul 解耦)
    expect(w.drops.size).toBe(1);
    expect(w.drops.items[0]!.value).toBe(ENEMIES[BOSS.baseKind]!.scrap * BOSS.dropMul);
  });

  it('Boss 撞击复用 09 受击模型:撞核心区扣 bossContactDamage(大质量,比底座更疼)', () => {
    const w = bossWorld(11);
    const boss = w.enemies.items.find((e) => e.kind === KIND_BOSS)!;
    park(boss, w.ship.x, w.ship.y); // 压在船心 = 核心区
    const full = w.ship.hp;

    w.step();
    expect(bossContactDamage()).toBeGreaterThan(ENEMIES[KIND_BEETLE]!.contactDamage);
    expect(w.ship.hp).toBe(full - bossContactDamage());
    expect(boss.dead).toBe(false); // 撞完不击退、不消灭(09 口径,巨型个体压着继续磨)
  });

  it('弹道塔能命中 Boss:表外 kind 不挡子弹(直射/光矛的命中判定把 Boss 当合法目标)', () => {
    const w = bossWorld(13);
    w.ship.heading = w.ship.pheading = 0;
    expect(w.acquireWeapon(TOWER_AUTOCANNON)).toBe(ACQUIRE_OK);
    const boss = w.enemies.items.find((e) => e.kind === KIND_BOSS)!;
    const hp = boss.hp;
    // 钉在炮口射程内正前方:Boss 判定体走 enemyRadius → 底座 radius × BOSS.scale
    park(boss, w.ship.x + 120, w.ship.y);
    // 直到命中:子弹在飞就一定会撞上(Boss 钉着不动)
    for (let f = 0; f < 200 && boss.hp === hp; f++) w.step();
    expect(boss.hp).toBeLessThan(hp);
    expect(boss.hp).toBe(hp - TOWERS[TOWER_AUTOCANNON]!.damage); // 伤害经 World.damageEnemy 唯一入口
  });
});
