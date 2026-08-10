/**
 * 点防拦截(22 号)—— 纯逻辑单测,不造 World:
 * 喂一块甲板(放一座点防)+ 一艘船 + 一串弹丸 + 一个记账假 sink,把拦截的目标选择
 * (射界/射程/朝船接近/距船最近)与命中结算(线段 × 圆、双回池、事件)全部钉住。
 *
 * 钉的几条口径(改坏就等于改坏了 22 号的验收):
 *   **优先级 = 弹丸优先、敌人其次**:拦截 pass 排在 stepTurrets 之前,onFired 的 cooldown
 *     闸住同帧双射 —— 这条接线在 world.test.ts 钉,这里钉的是"选哪颗弹丸"本身;
 *   只拦**朝船接近**的弹丸(掠过船身的放它走,不浪费弹药);
 *   多颗并存取**距船最近**的那颗(它最先到船,紧迫性最高);
 *   拦截弹是真子弹、带 intercept 标记,瞄准一阶提前量;
 *   命中 = 线段 × 圆(兜住拦截弹一帧 9px 的跳跃),双回池 + 一次事件。
 * 全程零 rng。
 */
import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../core/loop';
import { Pool } from '../core/pool';
import { KIND_SPORE } from '../data/enemies';
import { SUP_AMMO_BAY } from '../data/supports';
import { TOWER_AUTOCANNON, TOWER_PD } from '../data/towers';
import { createBullet, type Bullet, resetBullet } from './bullet';
import { CELL_WEAPON, createDeck, type Deck, isPlaceSuccess, placeAt } from './deck';
import { type EnemyBullet, createEnemyBullet, resetEnemyBullet } from './enemyBullet';
import { type FireSink } from './fx';
import { stepInterception, stepInterceptHits } from './intercept';
import { createShip, type Ship } from './ship';

/** 记账假 sink:拦截开的火记进池,炮口闪记下来(与 bullet.test.ts 的假 sink 同款) */
function fakeFireSink(pool: Pool<Bullet>): FireSink & { muzzles: number } {
  const sink: FireSink & { muzzles: number } = {
    muzzles: 0,
    spawnBullet: () => pool.spawn(),
    damage: () => false,
    fx: () => {
      sink.muzzles++;
    },
    query: () => {},
    fired: () => {},
  };
  return sink;
}

/** 放一座点防在船头格(射界中心 = 船头方向 -Y),返回甲板与船 */
function pdSetup(): { deck: Deck; ship: Ship } {
  const deck = createDeck();
  const ship = createShip(); // 默认朝向 -π/2(朝屏幕上方)
  const code = placeAt(deck, 1, 0, CELL_WEAPON, TOWER_PD, SUP_AMMO_BAY);
  expect(isPlaceSuccess(code)).toBe(true);
  return { deck, ship };
}

/** 一颗裸弹丸(stepInterception 只读,不必走池) */
function proj(x: number, y: number, vx: number, vy: number): EnemyBullet {
  return { x, y, px: x, py: y, vx, vy, kind: KIND_SPORE, damage: 8, life: 10, radius: 5 };
}

describe('stepInterception(目标选择与开火)', () => {
  it('射界 + 射程内、朝船接近的弹丸 → 打出一颗带 intercept 标记的拦截弹', () => {
    const { deck, ship } = pdSetup();
    const bullets = new Pool<Bullet>(createBullet, resetBullet);
    const sink = fakeFireSink(bullets);
    // 弹丸从船头前方 200px 直扑(射程 210 内、射界中心 -90° 上、朝船接近)
    stepInterception(deck, ship, [proj(0, -200, 0, 220)], SIM_DT, sink);
    expect(bullets.size).toBe(1);
    expect(bullets.items[0]!.intercept).toBe(true); // 拦截弹标记:只认弹丸,不认敌人
    expect(bullets.items[0]!.towerType).toBe(TOWER_PD);
    expect(bullets.items[0]!.vx).toBeCloseTo(0, 9); // 正前方:速度沿 -Y
    expect(bullets.items[0]!.vy).toBeLessThan(0);
    expect(sink.muzzles).toBe(1); // 炮口闪(开火表现与声音的载体)
  });

  it('已经掠过船身的弹丸(背向远离)不拦:不浪费弹药', () => {
    const { deck, ship } = pdSetup();
    const bullets = new Pool<Bullet>(createBullet, resetBullet);
    const sink = fakeFireSink(bullets);
    // 弹丸在船头前方但**正在远离**(dot(速度, 船 - 弹丸) ≤ 0)
    stepInterception(deck, ship, [proj(0, -200, 0, -220)], SIM_DT, sink);
    expect(bullets.size).toBe(0);
  });

  it('射程外的弹丸不拦:等它进射程再说(点防射程 210 是它的代价)', () => {
    const { deck, ship } = pdSetup();
    const bullets = new Pool<Bullet>(createBullet, resetBullet);
    const sink = fakeFireSink(bullets);
    stepInterception(deck, ship, [proj(0, -400, 0, 220)], SIM_DT, sink);
    expect(bullets.size).toBe(0);
  });

  it('射界外的弹丸不拦:点防只打它面前的半圆', () => {
    const { deck, ship } = pdSetup();
    const bullets = new Pool<Bullet>(createBullet, resetBullet);
    const sink = fakeFireSink(bullets);
    // 弹丸在船尾侧(射界中心 -90° 的对面):距离够近也够不到
    stepInterception(deck, ship, [proj(0, 150, 0, -220)], SIM_DT, sink);
    expect(bullets.size).toBe(0);
  });

  it('多颗并存取距船最近的那颗:炮口朝它,而不是朝第一颗撞见的', () => {
    const { deck, ship } = pdSetup();
    const bullets = new Pool<Bullet>(createBullet, resetBullet);
    const sink = fakeFireSink(bullets);
    // 近的一颗在正前方(炮口已对准),远的一颗在 30° 偏角 —— 若错误地选了远的,
    // 炮口转不到位(aimTol 10°),这一发根本打不出去
    const near = proj(0, -100, 0, 220);
    const far = proj(100, -180, -120, 180);
    stepInterception(deck, ship, [far, near], SIM_DT, sink);
    expect(bullets.size).toBe(1);
    // 拦截弹沿"近弹丸的一阶提前量"方向出膛(几乎正对 -Y)
    const b = bullets.items[0]!;
    const aim = Math.atan2(b.vy, b.vx);
    expect(aim).toBeCloseTo(-Math.PI / 2, 2);
  });

  it('非拦截塔(自动机炮)对弹丸视而不见:拦截旗子(interceptsProjectiles)是唯一筛子', () => {
    const deck = createDeck();
    const ship = createShip();
    placeAt(deck, 1, 0, CELL_WEAPON, TOWER_AUTOCANNON, SUP_AMMO_BAY);
    const bullets = new Pool<Bullet>(createBullet, resetBullet);
    const sink = fakeFireSink(bullets);
    stepInterception(deck, ship, [proj(0, -100, 0, 220)], SIM_DT, sink);
    expect(bullets.size).toBe(0);
  });
});

describe('stepInterceptHits(拦截弹 × 弹丸)', () => {
  it('拦截弹命中弹丸:双回池 + 一次事件,发射点塔型随事件带走', () => {
    const bullets = new Pool<Bullet>(createBullet, resetBullet);
    const projectiles = new Pool<EnemyBullet>(createEnemyBullet, resetEnemyBullet);
    // 一颗拦截弹(intercept = true)与一颗弹丸贴在一起
    const b = bullets.spawn();
    b.x = b.px = 0;
    b.y = b.py = 0;
    b.intercept = true;
    b.towerType = TOWER_PD;
    const p = projectiles.spawn();
    p.x = p.px = 3;
    p.y = p.py = 0;
    p.vx = 0;
    p.vy = 220;
    p.radius = 5;
    const events: { towerType: number; x: number; y: number }[] = [];
    stepInterceptHits(bullets, projectiles, (towerType, x, y) => events.push({ towerType, x, y }));
    expect(bullets.size).toBe(0);
    expect(projectiles.size).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]!.towerType).toBe(TOWER_PD); // 渲染层照塔型取冷色
  });

  it('线段判定:弹丸本帧从拦截弹路径上横穿过去也算命中(不靠端点碰端点)', () => {
    const bullets = new Pool<Bullet>(createBullet, resetBullet);
    const projectiles = new Pool<EnemyBullet>(createEnemyBullet, resetEnemyBullet);
    // 拦截弹本帧从 (0,0) 跳到 (0, 10)(px/py = 上一帧位置,与 stepBullets 同口径);
    // 弹丸在 (3, 5) —— 在路径上但不在任何一端:纯端点检查会漏,线段检查必须命中
    const b = bullets.spawn();
    b.px = 0;
    b.py = 0;
    b.x = 0;
    b.y = 10;
    b.intercept = true;
    const p = projectiles.spawn();
    p.x = p.px = 3;
    p.y = p.py = 5;
    p.vx = 0;
    p.vy = 0;
    p.radius = 5;
    stepInterceptHits(bullets, projectiles, () => {});
    expect(bullets.size).toBe(0);
    expect(projectiles.size).toBe(0);
  });

  it('普通弹不认弹丸:没有 intercept 标记的弹飞多远都不碰', () => {
    const bullets = new Pool<Bullet>(createBullet, resetBullet);
    const projectiles = new Pool<EnemyBullet>(createEnemyBullet, resetEnemyBullet);
    const b = bullets.spawn();
    b.x = b.px = 0;
    b.y = b.py = 0;
    b.intercept = false; // 普通弹
    const p = projectiles.spawn();
    p.x = p.px = 1;
    p.y = p.py = 0;
    p.radius = 5;
    stepInterceptHits(bullets, projectiles, () => {});
    expect(bullets.size).toBe(1);
    expect(projectiles.size).toBe(1);
  });
});
