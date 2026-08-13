import { describe, expect, it } from 'vitest';
import {
  FX_BEAM,
  FX_CHAIN,
  FX_LIFE_BEAM,
  FX_LIFE_BLAST,
  FX_LIFE_CHAIN,
  FX_LIFE_LANCE,
  FX_LANCE,
  FX_MORTAR,
  THR_AMMO,
  THR_CHARGE,
  THR_HEAT,
  TOWER_ANNIHILATION,
  TOWER_AURORA,
  TOWER_AUTOCANNON,
  TOWER_DELUGE,
  TOWER_KIND_COUNT,
  TOWER_LASER,
  TOWER_MISSILE_NEST,
  TOWER_RAILGUN,
  STAR_MAX,
  TOWER_STORM_CANNON,
  TOWER_THORN,
  TOWER_THUNDER,
  towerAoeDamage,
  towerArcDeg,
  towerBurst,
  towerChainCount,
  towerChargeTime,
  towerDamage,
  type TowerDef,
  towerFireInterval,
  towerHeatMax,
  towerMagazine,
  towerPierce,
  towerRange,
  TOWERS,
} from './towers';

const STARS = [1, 2, 3];
const ACCESSORS: Array<[string, (def: TowerDef, level: number) => number]> = [
  ['damage', towerDamage], ['fireInterval', towerFireInterval], ['range', towerRange],
  ['arc', towerArcDeg], ['magazine', towerMagazine], ['heat', towerHeatMax],
  ['charge', towerChargeTime], ['chain', towerChainCount], ['burst', towerBurst],
  ['pierce', towerPierce], ['aoeDamage', towerAoeDamage],
];

describe('武器塔数值表', () => {
  it('下标、基础塔与合成塔编号稳定', () => {
    expect(TOWER_KIND_COUNT).toBe(13);
    expect(STAR_MAX).toBe(3);
    expect(TOWERS).toHaveLength(TOWER_KIND_COUNT);
    TOWERS.forEach((def, index) => expect(def.type).toBe(index));
    expect(TOWERS.slice(0, 6).map((def) => def.name)).toEqual([
      '自动机炮', '激光棱镜', '电弧塔', '磁轨炮', '点防阵列', '等离子迫击炮',
    ]);
    expect(TOWERS.slice(6, 12).map((def) => def.name)).toEqual([
      '风暴机炮', '极光阵列', '湮灭长矛', '雷霆王冠', '焦土骤雨', '荆棘星幕',
    ]);
    expect(TOWERS[TOWER_MISSILE_NEST]?.name).toBe('导弹巢');
  });

  it('基础自动机炮锚点保持不变', () => {
    const gun = TOWERS[TOWER_AUTOCANNON]!;
    expect({ damage: gun.damage, fireInterval: gun.fireInterval, range: gun.range, magazine: gun.magazine, reload: gun.reload })
      .toEqual({ damage: 6, fireInterval: 0.4, range: 380, magazine: 20, reload: 1.5 });
    expect(towerDamage(gun, 1)).toBe(6);
    expect(towerFireInterval(gun, 1)).toBe(0.4);
  });

  it('六把合成武器的设计签名存在', () => {
    expect(TOWERS[TOWER_STORM_CANNON]).toMatchObject({ name: '风暴机炮', reload: 0, burst: 2, fireInterval: 0.25 });
    expect(TOWERS[TOWER_AURORA]).toMatchObject({ name: '极光阵列', pierce: 1, heatMax: 0 });
    expect(TOWERS[TOWER_ANNIHILATION]).toMatchObject({ name: '湮灭长矛', chargeTime: 1.0, range: 900 });
    expect(TOWERS[TOWER_THUNDER]).toMatchObject({ name: '雷霆王冠', chainCount: 6 });
    expect(TOWERS[TOWER_DELUGE]).toMatchObject({ name: '焦土骤雨', burst: 3, aoeRadius: 105 });
    expect(TOWERS[TOWER_THORN]).toMatchObject({ name: '荆棘星幕', fireInterval: 0.09, interceptsProjectiles: true });
  });

  it('节流机制字段自洽', () => {
    for (const def of TOWERS) {
      expect(def.magazine > 0).toBe(def.throttle === THR_AMMO);
      expect(def.chargeTime > 0).toBe(def.throttle === THR_CHARGE);
      expect(def.fireInterval === 0).toBe(def.throttle === THR_CHARGE);
      if (def.type === TOWER_STORM_CANNON) continue;
      if (def.type === TOWER_AURORA) continue;
      expect(def.heatMax > 0).toBe(def.throttle === THR_HEAT);
    }
    expect(TOWERS[TOWER_AUTOCANNON]!.throttle).toBe(THR_AMMO);
    expect(TOWERS[TOWER_LASER]!.throttle).toBe(THR_HEAT);
    expect(TOWERS[TOWER_RAILGUN]!.throttle).toBe(THR_CHARGE);
  });

  it('表现字段与开火类型自洽', () => {
    for (const def of TOWERS) {
      const projectile = def.fx === 0 || def.fx === FX_MORTAR;
      expect(def.bulletSpeed > 0).toBe(projectile);
      expect(def.bulletRadius > 0).toBe(projectile);
      expect(def.chainCount > 0).toBe(def.fx === FX_CHAIN);
      expect(def.aoeRadius > 0).toBe(def.fx === FX_MORTAR);
      expect(def.aoeDamage > 0).toBe(def.fx === FX_MORTAR);
      expect(def.damage === 0).toBe(def.fx === FX_MORTAR);
    }
    expect(TOWERS[TOWER_AURORA]!.fx).toBe(FX_BEAM);
    expect(TOWERS[TOWER_ANNIHILATION]!.fx).toBe(FX_LANCE);
    expect(TOWERS[TOWER_DELUGE]!.fx).toBe(FX_MORTAR);
    expect(TOWERS.filter((def) => def.interceptsProjectiles)).toHaveLength(2);
  });

  it('星级 getter 保持成长、整数与越界夹取契约(2★/3★ = 旧 Lv3/Lv5 档)', () => {
    for (const def of TOWERS) {
      for (let stars = 1; stars < STAR_MAX; stars++) {
        expect(towerRange(def, stars + 1)).toBeGreaterThan(towerRange(def, stars));
        if (def.damage > 0) expect(towerDamage(def, stars + 1)).toBeGreaterThan(towerDamage(def, stars));
        else expect(towerAoeDamage(def, stars + 1)).toBeGreaterThan(towerAoeDamage(def, stars));
      }
      for (const [name, getter] of ACCESSORS) {
        const low = getter(def, 1);
        const high = getter(def, STAR_MAX);
        expect(Number.isFinite(low), name).toBe(true);
        expect(Number.isFinite(high), name).toBe(true);
        expect(getter(def, Number.NaN), name).toBe(low);
        expect(getter(def, 99), name).toBe(high);
      }
      expect(Number.isInteger(towerMagazine(def, STAR_MAX))).toBe(true);
      expect(Number.isInteger(towerChainCount(def, STAR_MAX))).toBe(true);
    }
    const gun = TOWERS[TOWER_AUTOCANNON]!;
    // 星级映射钉死:2★ 触发旧 Lv3 的双管跳变、3★ 触发旧 Lv5 的曳光弹穿透
    expect(STARS.map((stars) => towerBurst(gun, stars))).toEqual([1, 2, 2]);
    expect(STARS.map((stars) => towerPierce(gun, stars))).toEqual([0, 0, 1]);
    // 2★/3★ 的数值档位恰好命中旧 Lv3/Lv5:按成长表现算一遍(不改表、只钉换算口径)
    expect(towerDamage(gun, 2)).toBe(gun.damage * Math.pow(gun.growth.damage, 2));
    expect(towerDamage(gun, 3)).toBe(gun.damage * Math.pow(gun.growth.damage, 4));
  });

  it('光束与特效存续时间保持正序', () => {
    expect(FX_LIFE_BEAM).toBeGreaterThanOrEqual(towerFireInterval(TOWERS[TOWER_LASER]!, 1));
    expect([FX_LIFE_BEAM, FX_LIFE_CHAIN, FX_LIFE_LANCE, FX_LIFE_BLAST]).toEqual([0.1, 0.12, 0.18, 0.25]);
  });
});
