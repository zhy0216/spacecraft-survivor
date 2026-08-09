/**
 * 词缀表(14 号 issue T1)的表级不变量 —— 照 data/enemies.test.ts 的风格。
 * 钉的不是效果逻辑(那在 sim/ 里,todos/14 任务清单后续轮次实装),而是表本身的口径:
 * 五种编号齐全且对齐 GDD §6.4 的顺序、效果字段齐全且各词缀自带参数生效、精英通用参数为正。
 * 后续调数值时随便改数字是被鼓励的,但改坏这几条就是改坏了机制本身:
 * 编号错位会让 WaveElite.affixes 里的数字指向另一条词缀(静默换效果),
 * 倍率填成 0 会把对应伤害系直接抹成零伤。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  AFFIX_ARMORED,
  AFFIX_COUNT,
  AFFIX_FISSION,
  AFFIX_FRENZY,
  AFFIX_MAGNETIC,
  AFFIX_PHASED,
  AFFIXES,
  ELITE,
} from './affixes';

// 最后一条用例要临时改字段(验证表可写),跑完必须还原,否则污染同文件后续用例
const BASE_SPEED_MUL = AFFIXES[AFFIX_FRENZY]!.frenzySpeedMul;
afterEach(() => {
  AFFIXES[AFFIX_FRENZY]!.frenzySpeedMul = BASE_SPEED_MUL;
});

describe('词缀表', () => {
  it('五种编号齐全:下标 === 编号,顺序对齐 GDD §6.4(狂热光环/裂变/磁力干扰/装甲/相位)', () => {
    expect(AFFIXES.length).toBe(AFFIX_COUNT);
    expect(AFFIX_COUNT).toBe(5);
    AFFIXES.forEach((def, i) => expect(def.id).toBe(i));
    expect(AFFIXES[AFFIX_FRENZY]!.name).toBe('狂热光环');
    expect(AFFIXES[AFFIX_FISSION]!.name).toBe('裂变');
    expect(AFFIXES[AFFIX_MAGNETIC]!.name).toBe('磁力干扰');
    expect(AFFIXES[AFFIX_ARMORED]!.name).toBe('装甲');
    expect(AFFIXES[AFFIX_PHASED]!.name).toBe('相位');
  });

  it('效果字段齐全:名字与描述非空;各词缀自带参数生效,不作用的档是中性值(倍率 1 / 数量半径 0)', () => {
    // 与 enemies.ts"该冲的参数齐、不冲的一律 0"同一条口径:中性档填错,效果当场串味
    for (const def of AFFIXES) {
      expect(def.name.length, `词缀 ${def.id} 的名字不许留空`).toBeGreaterThan(0);
      expect(def.description.length, `词缀 ${def.id} 的描述不许留空`).toBeGreaterThan(0);
    }

    const frenzy = AFFIXES[AFFIX_FRENZY]!;
    expect(frenzy.frenzyRadius).toBeGreaterThan(0);
    expect(frenzy.frenzySpeedMul).toBeGreaterThan(1); // 光环 = 加速,不是减速
    expect(frenzy.splitCount).toBe(0);
    expect(frenzy.pickupMul).toBe(1);
    expect(frenzy.ballisticMul).toBe(1);
    expect(frenzy.energyMul).toBe(1);

    const fission = AFFIXES[AFFIX_FISSION]!;
    expect(fission.splitCount).toBeGreaterThanOrEqual(2); // 至少裂成两份才有"裂"可言
    expect(fission.frenzyRadius).toBe(0);
    expect(fission.frenzySpeedMul).toBe(1);
    expect(fission.pickupMul).toBe(1);
    expect(fission.ballisticMul).toBe(1);
    expect(fission.energyMul).toBe(1);

    const magnetic = AFFIXES[AFFIX_MAGNETIC]!;
    expect(magnetic.pickupMul).toBeGreaterThan(0);
    expect(magnetic.pickupMul).toBeLessThan(1); // 干扰 = 拾取半径变小
    expect(magnetic.frenzyRadius).toBe(0);
    expect(magnetic.frenzySpeedMul).toBe(1);
    expect(magnetic.splitCount).toBe(0);
    expect(magnetic.ballisticMul).toBe(1);
    expect(magnetic.energyMul).toBe(1);

    const armored = AFFIXES[AFFIX_ARMORED]!;
    expect(armored.ballisticMul).toBeGreaterThan(0);
    expect(armored.ballisticMul).toBeLessThan(1); // 抗 = 减伤,不是免伤
    expect(armored.frenzyRadius).toBe(0);
    expect(armored.frenzySpeedMul).toBe(1);
    expect(armored.splitCount).toBe(0);
    expect(armored.pickupMul).toBe(1);
    expect(armored.energyMul).toBe(1);

    const phased = AFFIXES[AFFIX_PHASED]!;
    expect(phased.energyMul).toBeGreaterThan(0);
    expect(phased.energyMul).toBeLessThan(1);
    expect(phased.frenzyRadius).toBe(0);
    expect(phased.frenzySpeedMul).toBe(1);
    expect(phased.splitCount).toBe(0);
    expect(phased.pickupMul).toBe(1);
    expect(phased.ballisticMul).toBe(1);
  });

  it('精英通用参数:体型/HP 放大比例与掉落倍率都是正数(占位待调)', () => {
    expect(ELITE.scale).toBeGreaterThan(0);
    expect(ELITE.hpMul).toBeGreaterThan(0);
    // 掉落倍率 = 3× 残骸(todos/14 的口径,16 号星币落地前先按它给,不掷随机)
    expect(ELITE.scrapMul).toBeGreaterThanOrEqual(1);
  });

  it('表是可写的:单测能临时改字段再还原(没有 readonly,也没 Object.freeze)', () => {
    // "改数据文件即可调平衡"(todos/05 验收口径)的机械保证:
    // 冻表会让后续验证"光环倍率可配"的用例无从下手
    AFFIXES[AFFIX_FRENZY]!.frenzySpeedMul = 1.9;
    expect(AFFIXES[AFFIX_FRENZY]!.frenzySpeedMul).toBe(1.9);
  });
});
