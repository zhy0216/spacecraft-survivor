import { describe, expect, it } from 'vitest';
import {
  MERGES,
  isMergeResult,
  mergeResultOf,
} from './merges';
import {
  TOWER_ANNIHILATION,
  TOWER_ARC,
  TOWER_AURORA,
  TOWER_AUTOCANNON,
  TOWER_DELUGE,
  TOWER_KIND_COUNT,
  TOWER_LASER,
  TOWER_MISSILE_NEST,
  TOWER_MORTAR,
  TOWER_PD,
  TOWER_RAILGUN,
  TOWER_STORM_CANNON,
  TOWER_THORN,
  TOWER_THUNDER,
} from './towers';

describe('武器合成配方表', () => {
  it('六条配方顺序与合成武器编号 6..11 一致', () => {
    expect(MERGES).toHaveLength(6);
    expect(MERGES).toEqual([
      { base: TOWER_AUTOCANNON, result: TOWER_STORM_CANNON },
      { base: TOWER_LASER, result: TOWER_AURORA },
      { base: TOWER_RAILGUN, result: TOWER_ANNIHILATION },
      { base: TOWER_ARC, result: TOWER_THUNDER },
      { base: TOWER_MORTAR, result: TOWER_DELUGE },
      { base: TOWER_PD, result: TOWER_THORN },
    ]);
    expect(MERGES.map(({ result }) => result)).toEqual([6, 7, 8, 9, 10, 11]);
    for (const recipe of MERGES) {
      expect(recipe.result).toBeLessThan(TOWER_KIND_COUNT);
      expect(mergeResultOf(recipe.base)).toBe(recipe.result);
    }
  });

  it('非基础武器没有配方,且只有六个结果型被标记为合成结果', () => {
    expect(mergeResultOf(TOWER_MISSILE_NEST)).toBe(-1);
    for (const recipe of MERGES) expect(isMergeResult(recipe.result)).toBe(true);
    for (const base of [TOWER_AUTOCANNON, TOWER_LASER, TOWER_ARC, TOWER_RAILGUN, TOWER_PD, TOWER_MORTAR]) {
      expect(isMergeResult(base)).toBe(false);
    }
    expect(isMergeResult(TOWER_MISSILE_NEST)).toBe(false);
  });
});
