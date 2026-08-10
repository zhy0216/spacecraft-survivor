import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../core/loop';
import { Pool } from '../core/pool';
import { createShip } from './ship';
import { createEnemyBullet, resetEnemyBullet, stepEnemyBullets } from './enemyBullet';

describe('敌方弹丸无甲板参数', () => {
  it('沿速度积分并保存上一帧位置', () => {
    const pool = new Pool(createEnemyBullet, resetEnemyBullet);
    const bullet = pool.spawn();
    bullet.x = bullet.px = 100; bullet.y = bullet.py = 100;
    bullet.vx = 60; bullet.vy = -30; bullet.life = 10;
    stepEnemyBullets(pool, SIM_DT, createShip(), { hullHit: () => {} });
    expect(bullet.px).toBe(100);
    expect(bullet.x).toBeCloseTo(100 + 60 * SIM_DT, 12);
  });

  it('命中圆形船体后回池并通知 hullHit', () => {
    const pool = new Pool(createEnemyBullet, resetEnemyBullet);
    const bullet = pool.spawn();
    bullet.x = bullet.px = 0; bullet.y = bullet.py = 30;
    bullet.vx = 0; bullet.vy = -100; bullet.life = 10; bullet.damage = 8;
    let hits = 0;
    stepEnemyBullets(pool, SIM_DT, createShip(), { hullHit: () => { hits++; } });
    expect(hits).toBe(1);
    expect(pool.size).toBe(0);
  });
});
