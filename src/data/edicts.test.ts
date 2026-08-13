/**
 * 法令数值表的表级不变量(用户设计会:支援并入法令后重写)—— 与 data/towers.test.ts 同风格:
 * 数据表是"改数据即可调平衡"的那一头,这里钉的是**表本身的结构**:
 * 十条齐全、编号 === 下标、效果字段全数值、层数工具按层说话、作用域路由二选一。
 * 聚合(层数 → 倍率)在 sim/edictBuffs.test.ts 钉;三选一/世界级接线在 sim/upgrade.test.ts
 * 与 sim/world.test.ts 钉。
 */
import { describe, expect, it } from 'vitest';
import { THR_AMMO, THR_CHARGE, THR_HEAT } from './towers';
import {
  clampEdictLevel,
  createEdictLevels,
  edictCanStack,
  edictHeldCount,
  edictLevel,
  EDICT_AMMO,
  EDICT_ARMOR,
  EDICT_CAPACITOR,
  EDICT_COOLANT,
  EDICT_CRUISE,
  EDICT_GYRO,
  EDICT_KIND_COUNT,
  EDICT_MAGNET,
  EDICT_MAX_LEVEL,
  EDICT_OVERDRIVE,
  EDICT_STARCHART,
  EDICT_THR_NONE,
  EDICT_XP,
  EDICTS,
} from './edicts';

describe('法令表级不变量', () => {
  it('十条齐全,编号与 EDICT_* 常量一一对应、与下标一致', () => {
    expect(EDICT_KIND_COUNT).toBe(10);
    expect(EDICTS).toHaveLength(EDICT_KIND_COUNT);
    const ids = [
      EDICT_AMMO,
      EDICT_COOLANT,
      EDICT_CAPACITOR,
      EDICT_ARMOR,
      EDICT_XP,
      EDICT_MAGNET,
      EDICT_GYRO,
      EDICT_CRUISE,
      EDICT_STARCHART,
      EDICT_OVERDRIVE,
    ];
    EDICTS.forEach((e, i) => {
      expect(e.type, `下标 ${i} 的 type 必须 === 下标`).toBe(i);
      expect(ids[i], `EDICT_* 常量顺序必须与表顺序一致`).toBe(i);
      expect(e.name.length).toBeGreaterThan(0); // 卡片要印名字,不许空串
    });
    expect(new Set(ids)).toEqual(new Set(EDICTS.map((e) => e.type))); // 无重复编号
  });

  it('十条的效果数值逐条到位(全部数值型,一条轴一条法令)', () => {
    // 三条系限定档:数值逐字继承原支援表(合并的是两张表,不是两组数值)
    expect(EDICTS[EDICT_AMMO]!.fireRateMul).toBe(1.25); // 原弹药库
    expect(EDICTS[EDICT_AMMO]!.reloadMul).toBe(0.7);
    expect(EDICTS[EDICT_COOLANT]!.heatMaxMul).toBe(1.25); // 原散热器 1.5 按 5 层复利压档(27 号)
    expect(EDICTS[EDICT_CAPACITOR]!.chargeRateMul).toBe(1.3); // 原电容组
    // 全船档
    expect(EDICTS[EDICT_ARMOR]!.hullHpAdd).toBe(15); // 原装甲舱(不是结构加固的 20)
    expect(EDICTS[EDICT_ARMOR]!.damageTakenMul).toBe(0.8);
    expect(EDICTS[EDICT_XP]!.xpMul).toBe(1.25); // 原 1.5 按 5 层复利压档(27 号)
    expect(EDICTS[EDICT_MAGNET]!.magnetRadiusMul).toBe(1.3);
    expect(EDICTS[EDICT_GYRO]!.turnRateAdd).toBe(10);
    expect(EDICTS[EDICT_CRUISE]!.cruiseSpeedMul).toBe(1.1);
    expect(EDICTS[EDICT_STARCHART]!.starCoinChanceAdd).toBeCloseTo(0.08, 12);
    expect(EDICTS[EDICT_OVERDRIVE]!.damageMul).toBe(1.15);
  });

  it('一条轴只归一条法令:任何两条法令的非中性字段集合都不相交', () => {
    // 这就是这次改版的全部目的 —— 旧版支援与法令有 4 条轴两边同时占,
    // 于是"这两张卡差在哪"没有答案。表级钉死:同一个字段不许被两条法令碰
    const KEYS = [
      'fireRateMul',
      'reloadMul',
      'heatMaxMul',
      'chargeRateMul',
      'damageMul',
      'hullHpAdd',
      'damageTakenMul',
      'xpMul',
      'magnetRadiusMul',
      'turnRateAdd',
      'cruiseSpeedMul',
      'starCoinChanceAdd',
    ] as const;
    const NEUTRAL: Record<(typeof KEYS)[number], number> = {
      fireRateMul: 1,
      reloadMul: 1,
      heatMaxMul: 1,
      chargeRateMul: 1,
      damageMul: 1,
      hullHpAdd: 0,
      damageTakenMul: 1,
      xpMul: 1,
      magnetRadiusMul: 1,
      turnRateAdd: 0,
      cruiseSpeedMul: 1,
      starCoinChanceAdd: 0,
    };
    const owner = new Map<string, number>();
    for (const e of EDICTS) {
      for (const k of KEYS) {
        if (e[k] === NEUTRAL[k]) continue;
        // 系限定档按"字段 + 作用系"算一条轴:弹药系射速与过热系射速是两条不同的轴
        const axis = e.throttle >= 0 ? `${k}@${e.throttle}` : k;
        const prev = owner.get(axis);
        expect(prev, `轴 ${axis} 被 ${prev !== undefined ? EDICTS[prev]!.name : ''} 与 ${e.name} 同时占用`).toBe(
          undefined,
        );
        owner.set(axis, e.type);
      }
    }
  });

  it('作用域二选一:系限定档只出现在 throttle >= 0 的法令上,全船档只出现在 -1 上', () => {
    const FAMILY_KEYS = ['fireRateMul', 'reloadMul', 'heatMaxMul', 'chargeRateMul'] as const;
    const GLOBAL_MUL = ['damageMul', 'damageTakenMul', 'xpMul', 'magnetRadiusMul', 'cruiseSpeedMul'] as const;
    for (const e of EDICTS) {
      const family = e.throttle >= 0;
      expect([THR_AMMO, THR_HEAT, THR_CHARGE, EDICT_THR_NONE]).toContain(e.throttle);
      if (family) {
        // 系限定的法令:全船档必须整段中性(否则聚合的 throttle 路由会把它整条丢掉)
        for (const k of GLOBAL_MUL) expect(e[k], `${e.name}.${k}`).toBe(1);
        expect(e.hullHpAdd, `${e.name}.hullHpAdd`).toBe(0);
        expect(e.turnRateAdd, `${e.name}.turnRateAdd`).toBe(0);
        expect(e.starCoinChanceAdd, `${e.name}.starCoinChanceAdd`).toBe(0);
      } else {
        // 全船的法令:四个族倍率必须整段中性(同上,路由不认它们)
        for (const k of FAMILY_KEYS) expect(e[k], `${e.name}.${k}`).toBe(1);
      }
    }
  });

  it('不用的乘法档填 1、加法档填 0(与 towers.ts 的中性值分工同源)', () => {
    for (const e of EDICTS) {
      // 乘法档一律 > 0:0 作乘数是"归零",会把射速/半径直接抹成 0,与"这一档用不上"是两码事
      expect(e.fireRateMul, e.name).toBeGreaterThan(0);
      expect(e.reloadMul, e.name).toBeGreaterThan(0);
      expect(e.heatMaxMul, e.name).toBeGreaterThan(0);
      expect(e.chargeRateMul, e.name).toBeGreaterThan(0);
      expect(e.damageMul, e.name).toBeGreaterThan(0);
      expect(e.damageTakenMul, e.name).toBeGreaterThan(0);
      expect(e.xpMul, e.name).toBeGreaterThan(0);
      expect(e.magnetRadiusMul, e.name).toBeGreaterThan(0);
      expect(e.cruiseSpeedMul, e.name).toBeGreaterThan(0);
      // 加法档不许为负:法令是"更强",没有一条是拿了变弱的
      expect(e.hullHpAdd, e.name).toBeGreaterThanOrEqual(0);
      expect(e.turnRateAdd, e.name).toBeGreaterThanOrEqual(0);
      expect(e.starCoinChanceAdd, e.name).toBeGreaterThanOrEqual(0);
      // 渲染色一律冷色(GDD §12:蓝分量必须压过红分量)
      const r = (e.tint >> 16) & 0xff;
      const b = e.tint & 0xff;
      expect(b, `${e.name} 的 tint 必须是冷色`).toBeGreaterThan(r);
    }
  });

  it('层数工具:夹取接住 NaN/越界,createEdictLevels 全零,canStack 到顶即关', () => {
    expect(clampEdictLevel(NaN)).toBe(0); // NaN 与任何数比较都是 false —— 必须落回 0
    expect(clampEdictLevel(-3)).toBe(0);
    expect(clampEdictLevel(0)).toBe(0);
    expect(clampEdictLevel(2.7)).toBe(2);
    expect(clampEdictLevel(EDICT_MAX_LEVEL + 5)).toBe(EDICT_MAX_LEVEL);

    const levels = createEdictLevels();
    expect(levels).toHaveLength(EDICT_KIND_COUNT);
    expect(levels.every((v) => v === 0)).toBe(true);
    expect(edictHeldCount(levels)).toBe(0);

    levels[EDICT_COOLANT] = 2;
    expect(edictLevel(levels, EDICT_COOLANT)).toBe(2);
    expect(edictLevel(levels, EDICT_AMMO)).toBe(0);
    expect(edictLevel(levels, 999)).toBe(0); // 越界读成 0,不吐 undefined
    expect(edictHeldCount(levels)).toBe(1);
    expect(edictCanStack(levels, EDICT_COOLANT)).toBe(true);

    levels[EDICT_COOLANT] = EDICT_MAX_LEVEL;
    expect(edictCanStack(levels, EDICT_COOLANT)).toBe(false);
    // 表被写坏成超上限:读数照样夹回上限,canStack 仍然关着
    levels[EDICT_COOLANT] = EDICT_MAX_LEVEL + 9;
    expect(edictLevel(levels, EDICT_COOLANT)).toBe(EDICT_MAX_LEVEL);
    expect(edictCanStack(levels, EDICT_COOLANT)).toBe(false);
  });
});
