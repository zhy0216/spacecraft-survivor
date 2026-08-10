/**
 * 敌方弹丸(22 号,孢子炮手)—— 纯逻辑单测,不造 World:
 * 喂一个池 + 一艘船 + 一块甲板 + 一个记账假 sink 就能把运动/寿命/船体三层判定全部钉住
 * (与 bullet.test.ts 的假 sink 同一条拆分)。
 *
 * 钉的几条口径(改坏就等于改坏了 22 号的验收):
 *   px/py 在积分前存档 —— 渲染插值的两端由此成立(铁律 2);
 *   核心命中 = 真掉血(hullHit 带弹丸伤害)、甲板轮廓 = 只出火花(graze)、没碰上 = 继续飞 ——
 *     与敌人接触结算的 HIT_CORE / HIT_GRAZE 共用同一份 classifyHit 几何;
 *   先判命中再判到期:射程边界上撞到船的那一段位移不算白撞;
 *   命中/到期都当场倒序回池,零 rng、零分配。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SIM_DT } from '../core/loop';
import { Pool } from '../core/pool';
import { tuning } from './config';
import { createDeck, type Deck } from './deck';
import { createShip, type Ship } from './ship';
import {
  createEnemyBullet,
  type EnemyBullet,
  ENEMY_BULLET_MAX_ALIVE,
  resetEnemyBullet,
  stepEnemyBullets,
  type EnemyBulletSink,
} from './enemyBullet';

// 与 damage.test.ts 同口径:参数在文件顶部显式写死并 afterEach 还原 ——
// 核心区半长 60 / 半宽 45 / 甲板外接 80,断言里的数才写得清
const BASE = {
  shipLength: 160, // ÷ 4 行 = 40
  shipWidth: 120, // ÷ 3 列 = 40
  shipCoreScale: 0.75, // × 40 = 30 的核心格边长 → 核心区半长 60、半宽 45
};
Object.assign(tuning, BASE);
afterEach(() => Object.assign(tuning, BASE));

const CORE_HALF_LEN = 60;
const DECK_HALF_LEN = 80;

/** 记账假 sink:hullHit / graze 都记下来,断言"哪一层、扣了多少" */
function fakeSink(): EnemyBulletSink & {
  hullHits: { x: number; y: number; damage: number }[];
  grazes: { x: number; y: number }[];
} {
  const hullHits: { x: number; y: number; damage: number }[] = [];
  const grazes: { x: number; y: number }[] = [];
  return {
    hullHits,
    grazes,
    hullHit: (x, y, damage) => hullHits.push({ x, y, damage }),
    graze: (x, y) => grazes.push({ x, y }),
  };
}

/** 船头默认朝屏幕上方,船不开动(与 enemy.test.ts 的 shipAt 同款) */
function shipAt(x: number, y: number): Ship {
  const s = createShip();
  s.x = s.px = x;
  s.y = s.py = y;
  return s;
}

/** 造一颗弹丸:填好位置/速度/寿命,px/py 与 x/y 重合(出生姿态干净) */
function spawnBullet(
  pool: Pool<EnemyBullet>,
  x: number,
  y: number,
  vx: number,
  vy: number,
  life = 10,
  damage = 8,
): EnemyBullet {
  const b = pool.spawn();
  b.x = b.px = x;
  b.y = b.py = y;
  b.vx = vx;
  b.vy = vy;
  b.life = life;
  b.damage = damage;
  b.radius = 5;
  return b;
}

describe('stepEnemyBullets(运动与船体判定)', () => {
  it('积分:px/py 先存档,位置沿速度走 v×dt(渲染插值的两端由此成立)', () => {
    const pool = new Pool<EnemyBullet>(createEnemyBullet, resetEnemyBullet);
    const b = spawnBullet(pool, 100, 200, 60, -30, 10);
    const sink = fakeSink();
    stepEnemyBullets(pool, SIM_DT, shipAt(0, 0), createDeck(), sink);
    expect(pool.size).toBe(1); // 离船十万八千里,活着
    expect(b.px).toBe(100);
    expect(b.py).toBe(200);
    expect(b.x).toBe(100 + 60 * SIM_DT);
    expect(b.y).toBe(200 - 30 * SIM_DT);
    expect(sink.hullHits).toEqual([]);
    expect(sink.grazes).toEqual([]);
  });

  it('寿命走完即回池:life 是射程上限的唯一表达,与 my 子弹同口径', () => {
    const pool = new Pool<EnemyBullet>(createEnemyBullet, resetEnemyBullet);
    const b = spawnBullet(pool, 500, 0, 0, 0, SIM_DT); // 寿命恰好一帧
    stepEnemyBullets(pool, SIM_DT, shipAt(0, 0), createDeck(), fakeSink());
    expect(pool.size).toBe(0);
  });

  it('核心命中 = 真掉血(hullHit 带弹丸伤害)且弹丸当场回池', () => {
    const pool = new Pool<EnemyBullet>(createEnemyBullet, resetEnemyBullet);
    // 朝船心飞(船默认朝 -Y):落在核心区(半长 60,半径 5 外扩后 65)
    const b = spawnBullet(pool, 0, 200, 0, -220, 10, 8);
    const ship = shipAt(0, 0);
    const sink = fakeSink();
    const frames = Math.ceil(200 / 220 / SIM_DT); // 54.5 帧后进核心
    for (let i = 0; i < frames; i++) stepEnemyBullets(pool, SIM_DT, ship, createDeck(), sink);
    expect(sink.hullHits).toHaveLength(1);
    expect(sink.hullHits[0]!.damage).toBe(8); // 伤害原样递给世界(倍率/减伤是 world.damageShip 的事)
    // 进核心前先掠过船尾甲板 = 一声擦边火花(边缘检测只响一次),弹丸继续飞
    expect(sink.grazes).toHaveLength(1);
    expect(pool.size).toBe(0); // 命中即消失:弹丸不是穿透物
  });

  it('擦边甲板 = 只出火花、弹丸继续飞(轮廓是接触模型的概念,拦不下飞行物)', () => {
    const pool = new Pool<EnemyBullet>(createEnemyBullet, resetEnemyBullet);
    // 从甲板轮廓带外(局部 x = -90)慢速朝船飞:进入轮廓带那一帧出一声火花,
    // 弹丸不被拦下、继续飞,最后进核心区真掉血
    spawnBullet(pool, 0, 90, 0, -10, 10);
    const sink = fakeSink();
    const ship = shipAt(0, 0);
    for (let i = 0; i < 100; i++) stepEnemyBullets(pool, SIM_DT, ship, createDeck(), sink);
    expect(sink.grazes).toHaveLength(1); // 只有进轮廓那一帧响(边缘检测)
    expect(sink.hullHits).toEqual([]); // 还在轮廓带里,一分血都没扣
    expect(pool.size).toBe(1); // 擦边不消失
    for (let i = 0; i < 200; i++) stepEnemyBullets(pool, SIM_DT, ship, createDeck(), sink);
    expect(sink.hullHits).toHaveLength(1); // 飞完轮廓带,进核心区真掉血
    expect(pool.size).toBe(0);
  });

  it('先判命中再判到期:射程边界上撞到船的那一段位移不算白撞', () => {
    const pool = new Pool<EnemyBullet>(createEnemyBullet, resetEnemyBullet);
    // 寿命恰好一帧、位移 100px 直穿核心(船头方向):这一帧既是最后一帧、又是命中帧 ——
    // 若判据顺序反过来(先判寿命),弹丸会在命中前一刻凭空消失,白撞
    spawnBullet(pool, 0, 50, 0, -100, SIM_DT);
    const sink = fakeSink();
    stepEnemyBullets(pool, SIM_DT, shipAt(0, 0), createDeck(), sink);
    expect(sink.hullHits).toHaveLength(1);
  });

  it('弹丸不出判定区就继续飞:靠近但没碰到,寿命没到,一颗都不回收', () => {
    const pool = new Pool<EnemyBullet>(createEnemyBullet, resetEnemyBullet);
    spawnBullet(pool, 0, 100, 0, 10, 10); // 船头前方 100 > 65,还差得远
    spawnBullet(pool, 200, 0, -10, 0, 10);
    stepEnemyBullets(pool, SIM_DT, shipAt(0, 0), createDeck(), fakeSink());
    expect(pool.size).toBe(2);
  });

  it('倒序回池安全:一帧里前后两颗同时到期,swap-remove 不跳不重', () => {
    const pool = new Pool<EnemyBullet>(createEnemyBullet, resetEnemyBullet);
    spawnBullet(pool, 500, 0, 0, 0, SIM_DT);
    spawnBullet(pool, 500, 100, 0, 0, SIM_DT);
    spawnBullet(pool, 500, 200, 0, 0, SIM_DT);
    stepEnemyBullets(pool, SIM_DT, shipAt(0, 0), createDeck(), fakeSink());
    expect(pool.size).toBe(0);
  });
});

describe('resetEnemyBullet(池 reset)', () => {
  it('Object.keys 的每个字段都清回初值 —— 将来加字段忘了重置会被这条抓住', () => {
    const b = createEnemyBullet();
    const initial = { ...b };
    b.x = 1;
    b.y = 2;
    b.px = 3;
    b.py = 4;
    b.vx = 5;
    b.vy = 6;
    b.kind = 7;
    b.damage = 8;
    b.life = 9;
    b.radius = 10;
    resetEnemyBullet(b);
    expect(b).toEqual(initial);
    expect(Object.keys(b).length).toBe(Object.keys(initial).length);
  });
});

describe('ENEMY_BULLET_MAX_ALIVE(保险丝)', () => {
  it('在场弹丸的硬上限:触顶只是丢弃新弹,不留账(与 WAVE_MAX_ALIVE 同一条口径)', () => {
    // 上限本身是一个可读的常量,给"数据写坏"留一道栏杆 —— 正常脚本远够不到
    expect(ENEMY_BULLET_MAX_ALIVE).toBeGreaterThan(100);
  });
});
