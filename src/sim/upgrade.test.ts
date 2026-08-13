import { describe, expect, it } from 'vitest';
import { Rng } from '../core/rng';
import { OFFER_WEIGHT_EDICT, OFFER_WEIGHT_NEW_WEAPON, UPGRADE_CHOICE_COUNT } from '../data/economy';
import {
  createEdictLevels,
  EDICT_COOLANT,
  EDICT_KIND_COUNT,
  EDICT_MAX_LEVEL,
  EDICT_OVERDRIVE,
} from '../data/edicts';
import { isMergeResult } from '../data/merges';
import { TOWER_AUTOCANNON, TOWER_KIND_COUNT, TOWER_MISSILE_NEST } from '../data/towers';
import { createWeaponSlots } from './armory';
import { OFFER_EDICT, OFFER_NEW_WEAPON, rollUpgradeOffer, type UpgradeOption } from './upgrade';

class CountingRng {
  calls = 0;
  constructor(private readonly values: number[]) {}
  next(): number {
    return this.values[this.calls++] ?? 0;
  }
}

function state() {
  return {
    weapons: createWeaponSlots(),
    edicts: createEdictLevels(),
  };
}

function roll(
  values: number[],
  unlock = 0,
  setup?: ReturnType<typeof state>,
): { out: UpgradeOption[]; calls: number } {
  const s = setup ?? state();
  const rng = new CountingRng(values);
  const out: UpgradeOption[] = [];
  rollUpgradeOffer(rng as unknown as Rng, out, s.edicts, unlock, s.weapons);
  return { out, calls: rng.calls };
}

/** 武器类候选的可选表(与 collectPool 同一条过滤:合成结果塔不进、未解锁不进、已满 3★ 不进) */
const WEAPON_POOL = Array.from({ length: TOWER_KIND_COUNT }, (_, t) => t).filter((t) => !isMergeResult(t));

describe('槽位制升级候选', () => {
  it('两类权重为 40/60,掷出的数按区间解释', () => {
    expect([OFFER_WEIGHT_NEW_WEAPON, OFFER_WEIGHT_EDICT]).toEqual([40, 60]);
    expect(roll([0.01, 0, 0, 0, 0, 0]).out[0]!.kind).toBe(OFFER_NEW_WEAPON);
    expect(roll([0.5, 0, 0, 0, 0, 0], (1 << 30) - 1).out[0]!.kind).toBe(OFFER_EDICT);
  });

  it('每个候选位无条件消费两次 rng 且同轮不重复', () => {
    const result = roll([0.01, 0, 0.5, 0, 0.9, 0], (1 << 30) - 1);
    expect(result.calls).toBe(UPGRADE_CHOICE_COUNT * 2);
    expect(new Set(result.out.map((o) => `${o.kind}:${o.type}`)).size).toBe(result.out.length);
  });

  it('新武器池排除合成结果塔,但**允许已拥有且未满 3★ 的同型**(那是升星合成的唯一通路)', () => {
    const s = state();
    s.weapons[0]!.type = TOWER_AUTOCANNON;
    s.weapons[0]!.stars = 1;
    let sawOwned = false;
    for (let seed = 0; seed < 120; seed++) {
      const out: UpgradeOption[] = [];
      rollUpgradeOffer(new Rng(seed), out, s.edicts, 0, s.weapons);
      for (const option of out.filter((o) => o.kind === OFFER_NEW_WEAPON)) {
        // 合成结果塔永远不进池:它只能从"合到 3★ 变身"来
        expect(isMergeResult(option.type)).toBe(false);
        if (option.type === TOWER_AUTOCANNON) sawOwned = true;
      }
    }
    expect(sawOwned, '已拥有的型必须还能被抽到,否则同型第 2/3 把永远凑不齐').toBe(true);
  });

  it('已满 3★ 的无配方塔剔出新武器池(死卡,与法令满层同一条口径);3★ 有配方塔会变身故照进', () => {
    const s = state();
    s.weapons[0]!.type = TOWER_MISSILE_NEST; // 无配方:3★ 就是顶
    s.weapons[0]!.stars = 3;
    for (let seed = 0; seed < 120; seed++) {
      const out: UpgradeOption[] = [];
      rollUpgradeOffer(new Rng(seed), out, s.edicts, (1 << 30) - 1, s.weapons);
      for (const option of out.filter((o) => o.kind === OFFER_NEW_WEAPON)) {
        expect(option.type).not.toBe(TOWER_MISSILE_NEST);
      }
    }
    // 满 3★ 剔的是"这一型已到顶",基础塔(有配方)在 3★ 那一刻就变身,槽里根本不会有 3★ 基础塔
  });

  it('新武器卡的 level = 槽内同型最高星级(卡片靠它说"已有 ★N · 再拿一把升 ★N+1")', () => {
    const s = state();
    s.weapons[0]!.type = TOWER_AUTOCANNON;
    s.weapons[0]!.stars = 2;
    const index = WEAPON_POOL.indexOf(TOWER_AUTOCANNON);
    const result = roll([0.01, (index + 0.5) / WEAPON_POOL.length, 0, 0, 0, 0], 0, s);
    expect(result.out[0]).toEqual({ kind: OFFER_NEW_WEAPON, type: TOWER_AUTOCANNON, level: 2 });
  });

  it('法令池覆盖全部型(全解锁下),卡上的 level = 当前层数', () => {
    for (let type = 0; type < EDICT_KIND_COUNT; type++) {
      expect(roll([0.9, (type + 0.5) / EDICT_KIND_COUNT, 0, 0, 0, 0], (1 << 30) - 1).out[0]).toEqual({
        kind: OFFER_EDICT,
        type,
        level: 0,
      });
    }
    const s = state();
    s.edicts[EDICT_COOLANT] = 2;
    const idx = EDICT_COOLANT;
    const got = roll([0.9, (idx + 0.5) / EDICT_KIND_COUNT, 0, 0, 0, 0], (1 << 30) - 1, s).out[0]!;
    expect(got.type).toBe(EDICT_COOLANT);
    expect(got.level, '卡片要印「散热协议 ×2 → ×3」,level 就是那个 2').toBe(2);
  });

  it('满层的法令剔出候选(判据是"满层"而不是"已持有" —— 法令可叠到 5 层)', () => {
    const s = state();
    s.edicts[EDICT_COOLANT] = EDICT_MAX_LEVEL;
    for (let seed = 0; seed < 120; seed++) {
      const out: UpgradeOption[] = [];
      rollUpgradeOffer(new Rng(seed), out, s.edicts, (1 << 30) - 1, s.weapons);
      for (const option of out.filter((o) => o.kind === OFFER_EDICT)) {
        expect(option.type).not.toBe(EDICT_COOLANT);
      }
    }
    // 只差一层时照进:满层过滤不许提前一层生效
    s.edicts[EDICT_COOLANT] = EDICT_MAX_LEVEL - 1;
    const got = roll([0.9, (EDICT_COOLANT + 0.5) / EDICT_KIND_COUNT, 0, 0, 0, 0], (1 << 30) - 1, s).out[0]!;
    expect(got).toEqual({ kind: OFFER_EDICT, type: EDICT_COOLANT, level: EDICT_MAX_LEVEL - 1 });
  });

  it('未解锁的法令不进候选,且过滤不移动 rng 消耗(只收窄可选表)', () => {
    // 掩码 = 0 时超载协议(唯一带解锁闸门的法令)不许出现在任何一位候选上
    for (let seed = 0; seed < 120; seed++) {
      const s = state();
      const out: UpgradeOption[] = [];
      rollUpgradeOffer(new Rng(seed), out, s.edicts, 0, s.weapons);
      for (const option of out.filter((o) => o.kind === OFFER_EDICT)) {
        expect(option.type).not.toBe(EDICT_OVERDRIVE);
      }
    }
    // 同一组随机数:解锁与否只改"抽到谁",消耗次数一字不变(19 号那条确定性验收)
    const dice = [0.9, 0.99, 0.9, 0.99, 0.9, 0.99];
    const locked = roll(dice, 0);
    const unlocked = roll(dice, (1 << 30) - 1);
    expect(locked.calls).toBe(UPGRADE_CHOICE_COUNT * 2);
    expect(unlocked.calls).toBe(locked.calls);
  });
});
