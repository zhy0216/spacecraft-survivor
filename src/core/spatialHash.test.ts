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

  it('长途航行不积空桶:桶数越过阈值后空桶被清掉,内存回到在场规模(无限地图口径)', () => {
    const grid = new SpatialHash<Pt>(28);
    const p: Pt = { x: 0, y: 0 };
    // 模拟"每逻辑帧 clear + 全量 insert"的世界节奏,同时让实体一路向前跨 cell ——
    // 不清理的话,这一趟下来桶数 = 航迹上碰过的每一个 cell,只涨不落
    for (let i = 0; i < 20000; i++) {
      grid.clear();
      p.x = i * 28;
      grid.insert(p);
    }
    // 桶数被压回阈值以内(4096 + 常数),而不是两万
    expect(grid.cellCount).toBeLessThan(5000);

    // 清理不伤正确性:清完照常插得进、查得到
    grid.clear();
    p.x = 123;
    p.y = -456;
    grid.insert(p);
    const out: Pt[] = [];
    expect(grid.query(123, -456, 5, out)).toHaveLength(1);
  });
});
