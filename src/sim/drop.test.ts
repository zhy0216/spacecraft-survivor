import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../core/loop';
import { Pool } from '../core/pool';
import { tuning } from './config';
import { createDrop, resetDrop, stepDrops, type Drop } from './drop';

function fixture(): Pool<Drop> {
  return new Pool<Drop>(createDrop, resetDrop);
}

describe('残骸掉落物槽位无关的磁吸与经验', () => {
  it('超过磁吸半径不拾取,进入半径后沿船心移动并回收', () => {
    const drops = fixture();
    const drop = drops.spawn();
    drop.x = drop.px = tuning.dropMagnetRadius - 1;
    drop.y = drop.py = 0;
    drop.value = 2;
    let got = stepDrops(drops, 0, 0, SIM_DT);
    expect(drop.magnet).toBe(true);
    for (let i = 0; i < 20 && drops.size > 0; i++) got += stepDrops(drops, 0, 0, SIM_DT);
    expect(got).toBe(2);
    expect(drops.size).toBe(0);
  });

  it('xpMul 对本帧收取的总 XP 整体缩放', () => {
    const drops = fixture();
    const drop = drops.spawn();
    drop.x = drop.px = 1;
    drop.y = drop.py = 0;
    drop.value = 4;
    expect(stepDrops(drops, 0, 0, SIM_DT, 1, 1.5)).toBe(6);
  });
});
