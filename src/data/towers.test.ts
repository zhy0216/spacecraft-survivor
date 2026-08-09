/**
 * 武器塔数值表(05 号 issue T1)的表级不变量。
 * 与 data/enemies.test.ts 同口径:钉的不是开火逻辑(那在 sim/tower.ts、sim/turret.ts 里),
 * 而是**数据表本身的口径** —— 下标即 type、GDD 锚点数、弧度档位、三套节流机制的可区分性、
 * 表现字段与 fx 自洽、等级成长的方向、越界等级的夹取,以及敌我色域分离。
 *
 * 后续调平衡时随便改数字是被鼓励的(那正是本表存在的理由),但改坏这几条就是改坏了机制本身:
 * 比如把某座充能塔的 fireInterval 填成非 0,它的节奏就变成两个旋钮打架;
 * 比如把三种节流并成两种,06 号支援设施的三个作用锚点就少了一个。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  ARC_MEDIUM_DEG,
  ARC_NARROW_DEG,
  ARC_TIERS_DEG,
  ARC_VERY_NARROW_DEG,
  ARC_WIDE_DEG,
} from './arcs';
import {
  FX_BEAM,
  FX_BULLET,
  FX_CHAIN,
  FX_LANCE,
  FX_LIFE_BEAM,
  FX_LIFE_BLAST,
  FX_LIFE_CHAIN,
  FX_LIFE_LANCE,
  FX_MORTAR,
  THR_AMMO,
  THR_CHARGE,
  THR_HEAT,
  TOWER_ARC,
  TOWER_AUTOCANNON,
  TOWER_KIND_COUNT,
  TOWER_LASER,
  TOWER_MAX_LEVEL,
  TOWER_MORTAR,
  TOWER_PD,
  TOWER_RAILGUN,
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

/** 最后一条用例要临时改机炮伤害(验证表可写),跑完必须还原,否则污染同文件后续用例 */
const BASE_DAMAGE = TOWERS[TOWER_AUTOCANNON]!.damage;
afterEach(() => {
  TOWERS[TOWER_AUTOCANNON]!.damage = BASE_DAMAGE;
});

/** 1..TOWER_MAX_LEVEL,给"逐级比一遍"的用例用 */
const LEVELS = Array.from({ length: TOWER_MAX_LEVEL }, (_, i) => i + 1);

/** 全部等级取值函数。越界夹取那条要对着它们逐个问一遍,少列一个就少护一个 */
const ACCESSORS: Array<[string, (def: TowerDef, level: number) => number]> = [
  ['towerDamage', towerDamage],
  ['towerFireInterval', towerFireInterval],
  ['towerRange', towerRange],
  ['towerArcDeg', towerArcDeg],
  ['towerMagazine', towerMagazine],
  ['towerHeatMax', towerHeatMax],
  ['towerChargeTime', towerChargeTime],
  ['towerChainCount', towerChainCount],
  ['towerBurst', towerBurst],
  ['towerPierce', towerPierce],
  ['towerAoeDamage', towerAoeDamage],
];

describe('武器塔数值表', () => {
  it('下标 === type:sim 靠 TOWERS[cell.towerType] 直取,错一位就全塔串味', () => {
    expect(TOWERS.length).toBe(TOWER_KIND_COUNT);
    expect(TOWER_KIND_COUNT).toBe(6); // GDD §5.2 的 MVP 六塔
    TOWERS.forEach((def, i) => expect(def.type).toBe(i));
    expect(TOWERS[TOWER_AUTOCANNON]!.name).toBe('自动机炮');
    expect(TOWERS[TOWER_LASER]!.name).toBe('激光棱镜');
    expect(TOWERS[TOWER_ARC]!.name).toBe('电弧塔');
    expect(TOWERS[TOWER_RAILGUN]!.name).toBe('磁轨炮');
    expect(TOWERS[TOWER_PD]!.name).toBe('点防阵列');
    expect(TOWERS[TOWER_MORTAR]!.name).toBe('等离子迫击炮');
  });

  it('自动机炮 = GDD §14 锚点五数,不会被"顺手调平衡"改掉', () => {
    const gun = TOWERS[TOWER_AUTOCANNON]!;
    expect(gun.damage).toBe(6);
    expect(gun.fireInterval).toBe(0.4); // 2.5 发每秒
    expect(1 / gun.fireInterval).toBe(2.5);
    expect(gun.range).toBe(380);
    expect(gun.magazine).toBe(20);
    expect(gun.reload).toBe(1.5);

    // Lv1 的取值函数必须原样吐出锚点数:成长曲线要是把 Lv1 也乘了一道,
    // 整张表的基准就与 GDD §14 对不上,而这五个数是全局平衡的原点
    expect(towerDamage(gun, 1)).toBe(6);
    expect(towerFireInterval(gun, 1)).toBe(0.4);
    expect(towerRange(gun, 1)).toBe(380);
    expect(towerMagazine(gun, 1)).toBe(20);
  });

  it('六塔弧度与 GDD §5.2 一致,且一律取自 data/arcs 的档位(不许写裸数字)', () => {
    expect(TOWERS[TOWER_AUTOCANNON]!.arcDeg).toBe(ARC_MEDIUM_DEG); // 100°
    expect(TOWERS[TOWER_LASER]!.arcDeg).toBe(ARC_NARROW_DEG); // 60°
    expect(TOWERS[TOWER_ARC]!.arcDeg).toBe(ARC_WIDE_DEG); // 150°
    expect(TOWERS[TOWER_RAILGUN]!.arcDeg).toBe(ARC_VERY_NARROW_DEG); // 30°
    expect(TOWERS[TOWER_PD]!.arcDeg).toBe(ARC_WIDE_DEG); // 150°
    expect(TOWERS[TOWER_MORTAR]!.arcDeg).toBe(ARC_NARROW_DEG); // 60°

    // 落在有序档位表里 = 没人偷偷写了个 137°,也没人给 MVP 塔挂上全向档
    // (ARC_OMNI_DEG 是绕开整套射界机制的例外,不在 ARC_TIERS_DEG 里)
    for (const def of TOWERS) expect(ARC_TIERS_DEG).toContain(def.arcDeg);

    // 弧度不随等级成长:射界是格子的属性,加宽只由角落格与 §5.5 的进化给
    for (const def of TOWERS) {
      for (const lv of LEVELS) expect(towerArcDeg(def, lv)).toBe(def.arcDeg);
    }
  });

  it('三种节流各两塔,机制字段与 throttle 自洽(06 号支援设施的三个作用锚点)', () => {
    const count = (thr: number): number => TOWERS.filter((d) => d.throttle === thr).length;
    expect(count(THR_AMMO)).toBe(2); // 机炮 + 点防
    expect(count(THR_HEAT)).toBe(2); // 激光 + 电弧
    expect(count(THR_CHARGE)).toBe(2); // 磁轨 + 迫击炮
    expect(TOWERS[TOWER_AUTOCANNON]!.throttle).toBe(THR_AMMO);
    expect(TOWERS[TOWER_PD]!.throttle).toBe(THR_AMMO);
    expect(TOWERS[TOWER_LASER]!.throttle).toBe(THR_HEAT);
    expect(TOWERS[TOWER_ARC]!.throttle).toBe(THR_HEAT);
    expect(TOWERS[TOWER_RAILGUN]!.throttle).toBe(THR_CHARGE);
    expect(TOWERS[TOWER_MORTAR]!.throttle).toBe(THR_CHARGE);

    for (const def of TOWERS) {
      const ammo = def.throttle === THR_AMMO;
      const heat = def.throttle === THR_HEAT;
      const charge = def.throttle === THR_CHARGE;

      // 弹药系:弹夹与装填齐全,才有"突发满速后必然停火一段"这个特征
      expect(def.magazine > 0).toBe(ammo);
      expect(def.reload > 0).toBe(ammo);

      // 过热系:四个数缺一不可 —— 少了 coolPerSec 就永不降温,少了 overheatLock 就没有惩罚
      expect(def.heatPerShot > 0).toBe(heat);
      expect(def.heatMax > 0).toBe(heat);
      expect(def.coolPerSec > 0).toBe(heat);
      expect(def.overheatLock > 0).toBe(heat);

      // 充能系:蓄力周期给节奏,**fireInterval 必须恒 0** —— 再压一层冷却就是两个旋钮打架
      expect(def.chargeTime > 0).toBe(charge);
      expect(def.fireInterval === 0).toBe(charge);
    }
  });

  it('过热系"点射就不停火":冷却速率追得上半速射击,追不上满速(与弹药系的分水岭)', () => {
    for (const def of TOWERS) {
      if (def.throttle !== THR_HEAT) continue;
      const gainPerSec = def.heatPerShot / def.fireInterval;
      // 满速连射必然过热,否则这座塔根本没有节流,过热机制名存实亡
      expect(gainPerSec).toBeGreaterThan(def.coolPerSec);
      // 但降到半速就收支平衡甚至转正 —— "只罚贪连射"正是它区别于弹药系的地方
      expect(gainPerSec / 2).toBeLessThanOrEqual(def.coolPerSec);
    }
  });

  it('开火表现与弹道字段自洽:不用的一律 0(否则渲染层会对着一座光束塔画子弹)', () => {
    for (const def of TOWERS) {
      const flies = def.fx === FX_BULLET || def.fx === FX_MORTAR;
      expect(def.bulletSpeed > 0).toBe(flies);
      expect(def.bulletRadius > 0).toBe(flies);

      const chains = def.fx === FX_CHAIN;
      expect(def.chainCount > 0).toBe(chains);
      expect(def.chainRange > 0).toBe(chains);
      expect(def.chainFalloff > 0).toBe(chains);
      if (chains) {
        expect(def.chainCount).toBeGreaterThanOrEqual(2); // 只跳一次就不叫链
        expect(def.chainFalloff).toBeLessThan(1); // 不衰减的链电 = 广弧塔白嫖全屏伤害
        expect(def.chainRange).toBeLessThanOrEqual(def.range); // 跳得比射程还远就绕开了射界规则
      }

      expect(def.lanceWidth > 0).toBe(def.fx === FX_LANCE);

      const blasts = def.fx === FX_MORTAR;
      expect(def.aoeRadius > 0).toBe(blasts);
      expect(def.aoeDamage > 0).toBe(blasts);
      // 抛射弹途中不碰撞,直击不结算 → 单发伤害必须是 0,免得 UI 把它当伤害显示
      expect(def.damage === 0).toBe(blasts);
    }

    expect(TOWERS[TOWER_LASER]!.fx).toBe(FX_BEAM);
    expect(TOWERS[TOWER_ARC]!.fx).toBe(FX_CHAIN);
    expect(TOWERS[TOWER_RAILGUN]!.fx).toBe(FX_LANCE);
    // 点防的"击落弹幕"接口预留:MVP 四敌无弹幕,这面旗子先立着(GDD §5.2)
    expect(TOWERS[TOWER_PD]!.interceptsProjectiles).toBe(true);
    expect(TOWERS.filter((d) => d.interceptsProjectiles).length).toBe(1);
  });

  it('等级成长真的单调:Lv1→Lv5 每一档都朝同一个方向走(GDD §5.4)', () => {
    for (const def of TOWERS) {
      for (let lv = 1; lv < TOWER_MAX_LEVEL; lv++) {
        // 射程:六塔都成长,一律严格变大
        expect(towerRange(def, lv + 1)).toBeGreaterThan(towerRange(def, lv));

        // 伤害:迫击炮的 def.damage 恒 0(伤害全在落点),它的那一档由 towerAoeDamage 管
        if (def.damage > 0) {
          expect(towerDamage(def, lv + 1)).toBeGreaterThan(towerDamage(def, lv));
        } else {
          expect(towerAoeDamage(def, lv + 1)).toBeGreaterThan(towerAoeDamage(def, lv));
        }

        // 射速:成长系数为 1 的塔(激光的 10Hz 是伤害 tick 的离散化口径,不是射速旋钮)不许变慢
        expect(towerFireInterval(def, lv + 1)).toBeLessThanOrEqual(towerFireInterval(def, lv));
        if (def.fireInterval > 0 && def.growth.fireRate > 1) {
          expect(towerFireInterval(def, lv + 1)).toBeLessThan(towerFireInterval(def, lv));
        }

        // 三套节流各自的成长档:升级要能在自己那套机制上被看见
        if (def.throttle === THR_AMMO) {
          expect(towerMagazine(def, lv + 1)).toBeGreaterThan(towerMagazine(def, lv));
        }
        if (def.throttle === THR_HEAT) {
          expect(towerHeatMax(def, lv + 1)).toBeGreaterThan(towerHeatMax(def, lv));
        }
        if (def.throttle === THR_CHARGE) {
          expect(towerChargeTime(def, lv + 1)).toBeLessThan(towerChargeTime(def, lv));
        }
        if (def.fx === FX_CHAIN) {
          expect(towerChainCount(def, lv + 1)).toBeGreaterThan(towerChainCount(def, lv));
        }
      }
    }

    // 弹夹/链跳是加法档且取整:Lv5 必须仍是整数,UI 直接把它印出来
    for (const def of TOWERS) {
      expect(Number.isInteger(towerMagazine(def, TOWER_MAX_LEVEL))).toBe(true);
      expect(Number.isInteger(towerChainCount(def, TOWER_MAX_LEVEL))).toBe(true);
    }
    expect(towerMagazine(TOWERS[TOWER_AUTOCANNON]!, TOWER_MAX_LEVEL)).toBe(40); // 20 + 4×5
    expect(towerChainCount(TOWERS[TOWER_ARC]!, TOWER_MAX_LEVEL)).toBe(7); // 3 + 4×1(扶正后 Lv1 即 2 跳)
  });

  it('Lv3/Lv5 是机制小跳变而不是渐变(GDD §5.4:机炮双管 / 曳光弹)', () => {
    const gun = TOWERS[TOWER_AUTOCANNON]!;
    expect(LEVELS.map((lv) => towerBurst(gun, lv))).toEqual([1, 1, 2, 2, 2]);
    expect(LEVELS.map((lv) => towerPierce(gun, lv))).toEqual([0, 0, 0, 0, 1]);

    // 其余五塔本轮没有跳变:恒 1 发、恒不穿透。留着非 0 的 burstAtLv3
    // 会让一座光束塔在 Lv3 那一帧突然打两下,而它压根不发射弹丸
    for (const def of TOWERS) {
      if (def.type === TOWER_AUTOCANNON) continue;
      expect(LEVELS.map((lv) => towerBurst(def, lv))).toEqual([1, 1, 1, 1, 1]);
      expect(LEVELS.map((lv) => towerPierce(def, lv))).toEqual([0, 0, 0, 0, 0]);
    }
  });

  it('level 越界一律夹到 [1, 5],绝不吐出 NaN/Infinity', () => {
    // NaN 最阴:它比较恒 false,写成 `level < 1` 的夹取会让它一路穿到 Math.pow,
    // 再被 checksum 的 `| 0` 抹成 0 —— 分叉当场就从确定性口径下漏掉了
    const tooLow = [-Infinity, -3, 0, 0.5, NaN];
    const tooHigh = [TOWER_MAX_LEVEL + 1, 99, 1e9, Infinity];

    for (const def of TOWERS) {
      for (const [name, fn] of ACCESSORS) {
        const lo = fn(def, 1);
        const hi = fn(def, TOWER_MAX_LEVEL);
        expect(Number.isFinite(lo), name).toBe(true);
        expect(Number.isFinite(hi), name).toBe(true);
        for (const lv of tooLow) expect(fn(def, lv), `${name}@${lv}`).toBe(lo);
        for (const lv of tooHigh) expect(fn(def, lv), `${name}@${lv}`).toBe(hi);
      }
    }
  });

  it('迫击炮的伤害全在落点,且落点伤害照样吃等级成长', () => {
    const mortar = TOWERS[TOWER_MORTAR]!;
    expect(mortar.damage).toBe(0); // 途中不碰撞 → 直击不结算
    expect(towerAoeDamage(mortar, 1)).toBe(mortar.aoeDamage);
    // 少了这一条,它就是六塔里唯一升级不加伤的塔,偏偏又是充能系里最慢的那座
    expect(towerAoeDamage(mortar, TOWER_MAX_LEVEL)).toBeGreaterThan(mortar.aoeDamage);
    // 非 AoE 塔的落点伤害恒 0:成长系数再大也乘不出东西来
    for (const def of TOWERS) {
      if (def.fx === FX_MORTAR) continue;
      expect(towerAoeDamage(def, TOWER_MAX_LEVEL)).toBe(0);
    }
  });

  it('敌我色域分离:六塔一律冷色,且彼此可辨(GDD §12)', () => {
    for (const def of TOWERS) {
      const r = (def.tint >> 16) & 0xff;
      const b = def.tint & 0xff;
      // 与 data/enemies.test.ts 那条严格对称:敌人是"红强、绿受限",船侧就是"蓝强、红受限"。
      // 千单位同屏时可读性全靠色域,一旦某座塔滑进暖色,玩家分不清那是自己的弹还是敌人
      expect(b).toBeGreaterThanOrEqual(0xb0);
      expect(r).toBeLessThanOrEqual(0x8c);
    }
    expect(new Set(TOWERS.map((d) => d.tint)).size).toBe(TOWER_KIND_COUNT);
  });

  it('可视化存续常量为正,且光束最短(它每 0.1s 就续一次命)', () => {
    for (const life of [FX_LIFE_BEAM, FX_LIFE_CHAIN, FX_LIFE_LANCE, FX_LIFE_BLAST]) {
      expect(life).toBeGreaterThan(0);
    }
    expect(FX_LIFE_BEAM).toBeLessThan(FX_LIFE_CHAIN);
    expect(FX_LIFE_CHAIN).toBeLessThan(FX_LIFE_LANCE);
    expect(FX_LIFE_LANCE).toBeLessThan(FX_LIFE_BLAST);
  });

  it('光束存续 ≥ 激光的开火间隔:短于它就没有"持续光束",只有 10Hz 频闪', () => {
    // 两次伤害 tick 之间若有几帧池里一条光束都没有,画面上读到的就是虚线闪烁 ——
    // 而"持续单体光束"正是激光区别于另外五塔的那条表现通道(GDD §5.2)。
    // 只需在 Lv1 成立:fireRate 成长只会让间隔更短,缝隙不会重新裂开
    expect(FX_LIFE_BEAM).toBeGreaterThanOrEqual(towerFireInterval(TOWERS[TOWER_LASER]!, 1));
  });

  it('表是可写的:单测能临时改字段再还原(没有 readonly,也没 Object.freeze)', () => {
    // "改数据文件即可调平衡"(05 号验收标准第三条)的机械保证:
    // 冻表会让后续验证"射速/伤害可配"的用例无从下手,也会让面板调参失去落点
    const gun = TOWERS[TOWER_AUTOCANNON]!;
    gun.damage = 99;
    expect(towerDamage(gun, 1)).toBe(99);
    expect(towerDamage(gun, 2)).toBe(99 * gun.growth.damage);
  });
});
