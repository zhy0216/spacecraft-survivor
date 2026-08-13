import { describe, expect, it } from 'vitest';
import { SpatialHash } from '../core/spatialHash';
import { TOWER_AUTOCANNON, TOWERS, towerMagazine } from '../data/towers';
import { createWeaponSlots, slotMuzzleWorld } from './armory';
import { createEnemy } from './enemy';
import { createShip } from './ship';
import { createEdictBuffs } from './edictBuffs';
import { stepTurrets } from './turret';

describe('stepTurrets 槽位接线', () => {
  it('空武器槽不查询空间哈希,武器槽按固定硬点追瞄', () => {
    const weapons = createWeaponSlots();
    const ship = createShip();
    ship.heading = 0;
    const grid = new SpatialHash<ReturnType<typeof createEnemy>>(64);
    stepTurrets(weapons, ship, grid, 1 / 60, null, createEdictBuffs());
    weapons[0]!.type = TOWER_AUTOCANNON;
    weapons[0]!.stars = 1;
    weapons[0]!.ammo = towerMagazine(TOWERS[TOWER_AUTOCANNON]!, 1);
    const muzzle = { x: 0, y: 0 };
    slotMuzzleWorld(ship, 0, muzzle);
    const enemy = createEnemy();
    enemy.x = muzzle.x + 100;
    enemy.y = muzzle.y + 20;
    grid.insert(enemy);
    for (let i = 0; i < 20; i++) stepTurrets(weapons, ship, grid, 1 / 60, null, createEdictBuffs());
    expect(weapons[0]!.turretOffset).toBeGreaterThan(0);
  });
});
