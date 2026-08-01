import { describe, expect, it } from 'vitest';
import { Pool } from './pool';

interface Obj {
  id: number;
  v: number;
}

describe('Pool', () => {
  it('despawnAt 是 swap-remove,回收对象被复用而非新建', () => {
    let created = 0;
    const pool = new Pool<Obj>(
      () => ({ id: created++, v: 0 }),
      (o) => {
        o.v = 0;
      },
    );
    const a = pool.spawn();
    pool.spawn();
    pool.spawn();
    expect(created).toBe(3);

    a.v = 99;
    pool.despawnAt(0);
    expect(pool.size).toBe(2);

    const d = pool.spawn();
    expect(created).toBe(3); // 未新建,复用了 a
    expect(d).toBe(a);
    expect(d.v).toBe(0); // reset 已执行
  });

  it('items 保持致密(无空洞)', () => {
    const pool = new Pool<Obj>(
      () => ({ id: 0, v: 0 }),
      (o) => {
        o.v = 0;
      },
    );
    for (let i = 0; i < 5; i++) pool.spawn().v = i;
    pool.despawnAt(2);
    expect(pool.size).toBe(4);
    for (let i = 0; i < pool.size; i++) expect(pool.items[i]).toBeDefined();
  });

  it('prealloc 预分配后 spawn 不再新建', () => {
    let created = 0;
    const pool = new Pool<Obj>(
      () => ({ id: created++, v: 0 }),
      (o) => {
        o.v = 0;
      },
      10,
    );
    expect(created).toBe(10);
    for (let i = 0; i < 10; i++) pool.spawn();
    expect(created).toBe(10);
  });
});
