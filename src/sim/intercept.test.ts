import { describe, expect, it } from 'vitest';
import { Pool } from '../core/pool';
import { TOWER_AUTOCANNON, TOWER_PD, towerMagazine, TOWERS } from '../data/towers';
import { createWeaponSlots } from './armory';
import { createBullet, resetBullet } from './bullet';
import { createEnemyBullet, resetEnemyBullet } from './enemyBullet';
import { createEdictBuffs } from './edictBuffs';
import { createShip } from './ship';
import { stepInterception, stepInterceptHits } from './intercept';
import type { FireSink } from './fx';

const sinkFor = (bullets: Pool<ReturnType<typeof createBullet>>): FireSink => ({
  spawnBullet: () => bullets.spawn(), damage: () => false, fx: () => {}, query: () => {}, fired: () => {},
});

describe('槽位点防拦截', () => {
  it('只使用带拦截能力的武器槽', () => {
    const weapons = createWeaponSlots();
    weapons[0]!.type = TOWER_AUTOCANNON;
    weapons[0]!.level = 1;
    weapons[0]!.ammo = towerMagazine(TOWERS[TOWER_AUTOCANNON]!, 1);
    const bullets = new Pool(createBullet, resetBullet);
    stepInterception(weapons, createShip(), [], 1 / 60, sinkFor(bullets), createEdictBuffs());
    expect(bullets.size).toBe(0);
    weapons[0]!.type = TOWER_PD;
    weapons[0]!.ammo = towerMagazine(TOWERS[TOWER_PD]!, 1);
    stepInterception(weapons, createShip(), [], 1 / 60, sinkFor(bullets), createEdictBuffs());
    expect(bullets.size).toBe(0);
  });
});

describe('stepInterceptHits', () => {
  it('拦截弹命中敌弹后双双回池并发出事件', () => {
    const bullets = new Pool(createBullet, resetBullet);
    const projectiles = new Pool(createEnemyBullet, resetEnemyBullet);
    const bullet = bullets.spawn();
    bullet.intercept = true;
    bullet.radius = 5; // 池默认 0:半径不补,r = 0 下相距 1px 也判不中(intercept.ts 的 r = p.radius + b.radius + step)
    bullet.x = bullet.px = 0; bullet.y = bullet.py = 0;
    const projectile = projectiles.spawn();
    projectile.radius = 5;
    projectile.x = projectile.px = 1; projectile.y = projectile.py = 0;
    const events: number[] = [];
    stepInterceptHits(bullets, projectiles, (type) => events.push(type));
    expect(bullets.size).toBe(0);
    expect(projectiles.size).toBe(0);
    expect(events).toHaveLength(1);
  });
});
