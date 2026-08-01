import { describe, expect, it } from 'vitest';
import { Rng } from './rng';

describe('Rng(mulberry32)', () => {
  it('同 seed 序列完全一致', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 1000; i++) expect(a.next()).toBe(b.next());
  });

  it('不同 seed 序列不同', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    const sa = Array.from({ length: 8 }, () => a.next());
    const sb = Array.from({ length: 8 }, () => b.next());
    expect(sa).not.toEqual(sb);
  });

  it('值域 [0, 1)', () => {
    const r = new Rng(7);
    for (let i = 0; i < 10000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
