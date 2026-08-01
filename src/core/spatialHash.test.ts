import { describe, expect, it } from 'vitest';
import { Rng } from './rng';
import { SpatialHash } from './spatialHash';

interface Pt {
  x: number;
  y: number;
}

describe('SpatialHash', () => {
  it('query 结果是真实邻居的超集(粗筛零漏检),含负坐标', () => {
    const grid = new SpatialHash<Pt>(28);
    const rng = new Rng(3);
    const pts: Pt[] = [];
    for (let i = 0; i < 500; i++) pts.push({ x: rng.range(-600, 600), y: rng.range(-600, 600) });
    for (const p of pts) grid.insert(p);

    const out: Pt[] = [];
    for (let probe = 0; probe < 50; probe++) {
      const cx = rng.range(-600, 600);
      const cy = rng.range(-600, 600);
      const r = rng.range(5, 80);
      grid.query(cx, cy, r, out);
      const got = new Set(out);
      for (const p of pts) {
        const d2 = (p.x - cx) ** 2 + (p.y - cy) ** 2;
        if (d2 <= r * r) expect(got.has(p)).toBe(true);
      }
    }
  });

  it('clear 后查询为空,且 cell 数组可复用', () => {
    const grid = new SpatialHash<Pt>(10);
    grid.insert({ x: 1, y: 1 });
    grid.insert({ x: -5, y: -5 });
    grid.clear();
    const out: Pt[] = [];
    expect(grid.query(0, 0, 20, out)).toHaveLength(0);

    grid.insert({ x: 2, y: 2 });
    expect(grid.query(0, 0, 5, out)).toHaveLength(1);
  });
});
