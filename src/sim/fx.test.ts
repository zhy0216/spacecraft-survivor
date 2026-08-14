import { describe, expect, it } from 'vitest';
import {
  FXV_BEAM,
  FXV_BLAST,
  FXV_CHAIN,
  FXV_IMPACT,
  FXV_LANCE,
  FXV_MUZZLE,
  fxLifeForStars,
} from './fx';

describe('fxLifeForStars(逐星余波时长)', () => {
  it('链电/磁轨/爆炸/炮口/命中随星级单调延长', () => {
    for (const kind of [FXV_CHAIN, FXV_LANCE, FXV_BLAST, FXV_MUZZLE, FXV_IMPACT]) {
      const one = fxLifeForStars(kind, 1);
      const two = fxLifeForStars(kind, 2);
      const three = fxLifeForStars(kind, 3);
      expect(two).toBeGreaterThan(one);
      expect(three).toBeGreaterThan(two);
    }
  });

  it('持续激光不因星级拖尾:停火后不会残留一条假光束', () => {
    expect(fxLifeForStars(FXV_BEAM, 1)).toBe(fxLifeForStars(FXV_BEAM, 2));
    expect(fxLifeForStars(FXV_BEAM, 2)).toBe(fxLifeForStars(FXV_BEAM, 3));
  });
});
