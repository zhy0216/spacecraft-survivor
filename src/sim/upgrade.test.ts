import { describe, expect, it } from 'vitest';
import { Rng } from '../core/rng';
import { OFFER_WEIGHT_EDICT, OFFER_WEIGHT_NEW_WEAPON, OFFER_WEIGHT_SUPPORT, OFFER_WEIGHT_WEAPON_UPGRADE, UPGRADE_CHOICE_COUNT } from '../data/economy';
import { EDICT_KIND_COUNT } from '../data/edicts';
import { isMergeResult } from '../data/merges';
import { SUPPORT_KIND_COUNT } from '../data/supports';
import { TOWER_AUTOCANNON, TOWER_KIND_COUNT, TOWER_LASER } from '../data/towers';
import { createSupportSlots, createWeaponSlots } from './armory';
import { OFFER_EDICT, OFFER_NEW_WEAPON, OFFER_SUPPORT, OFFER_WEAPON_UPGRADE, rollUpgradeOffer, type UpgradeOption } from './upgrade';

class CountingRng {
  calls = 0;
  constructor(private readonly values: number[]) {}
  next(): number { return this.values[this.calls++] ?? 0; }
}

function state() {
  return { weapons: createWeaponSlots(), supports: createSupportSlots(), banked: new Array<number>(TOWER_KIND_COUNT).fill(0) };
}

function roll(values: number[], held = 0, unlock = 0, setup?: ReturnType<typeof state>): { out: UpgradeOption[]; calls: number } {
  const s = setup ?? state();
  const rng = new CountingRng(values);
  const out: UpgradeOption[] = [];
  rollUpgradeOffer(rng as unknown as Rng, out, held, unlock, s.weapons, s.supports, s.banked);
  return { out, calls: rng.calls };
}

describe('槽位制升级候选', () => {
  it('四类权重为 5/25/35/35', () => {
    expect([OFFER_WEIGHT_NEW_WEAPON, OFFER_WEIGHT_WEAPON_UPGRADE, OFFER_WEIGHT_SUPPORT, OFFER_WEIGHT_EDICT]).toEqual([5, 25, 35, 35]);
    expect(roll([0.01, 0, 0, 0, 0, 0]).out[0]!.kind).toBe(OFFER_NEW_WEAPON);
    expect(roll([0.1, 0, 0, 0, 0, 0]).out[0]!.kind).toBe(OFFER_WEAPON_UPGRADE);
    expect(roll([0.4, 0, 0, 0, 0, 0]).out[0]!.kind).toBe(OFFER_SUPPORT);
    expect(roll([0.9, 0, 0, 0, 0, 0]).out[0]!.kind).toBe(OFFER_EDICT);
  });

  it('每个候选位无条件消费两次 rng 且同轮不重复', () => {
    const result = roll([0.01, 0, 0.4, 0, 0.9, 0]);
    expect(result.calls).toBe(UPGRADE_CHOICE_COUNT * 2);
    expect(new Set(result.out.map((o) => `${o.kind}:${o.type}`)).size).toBe(result.out.length);
  });

  it('新武器池排除合成结果与已拥有类型', () => {
    const s = state();
    s.weapons[0]!.type = TOWER_AUTOCANNON;
    for (let seed = 0; seed < 80; seed++) {
      const out: UpgradeOption[] = [];
      rollUpgradeOffer(new Rng(seed), out, 0, 0, s.weapons, s.supports, s.banked);
      for (const option of out.filter((o) => o.kind === OFFER_NEW_WEAPON)) {
        expect(option.type).not.toBe(TOWER_AUTOCANNON);
        expect(isMergeResult(option.type)).toBe(false);
      }
    }
  });

  it('武器升级允许未拥有类型并用存档等级填写 level', () => {
    const s = state();
    s.banked[TOWER_LASER] = 2;
    const pool = Array.from({ length: TOWER_KIND_COUNT }, (_, type) => type).filter((type) => !isMergeResult(type));
    const index = pool.indexOf(TOWER_LASER);
    const result = roll([0.1, (index + 0.5) / pool.length, 0, 0, 0, 0], 0, 0, s);
    expect(result.out[0]).toEqual({ kind: OFFER_WEAPON_UPGRADE, type: TOWER_LASER, level: 2 });
  });

  it('支援池覆盖全部 6 型,法令池覆盖全部型', () => {
    for (let type = 0; type < SUPPORT_KIND_COUNT; type++) {
      expect(roll([0.4, (type + 0.5) / SUPPORT_KIND_COUNT, 0, 0, 0, 0]).out[0]).toEqual({ kind: OFFER_SUPPORT, type, level: 0 });
    }
    for (let type = 0; type < EDICT_KIND_COUNT; type++) {
      expect(roll([0.9, (type + 0.5) / EDICT_KIND_COUNT, 0, 0, 0, 0], 0, (1 << 30) - 1).out[0]).toEqual({ kind: OFFER_EDICT, type, level: 0 });
    }
  });
});
