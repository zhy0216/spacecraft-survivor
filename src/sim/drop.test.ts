import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../core/loop';
import { Pool } from '../core/pool';
import { tuning } from './config';
import {
  createDrop,
  DROP_KIND_MAGNET,
  DROP_KIND_XP,
  resetDrop,
  stepDrops,
  type Drop,
} from './drop';

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

  it('磁吸宝物(26 号改)收下报数、不进经验账', () => {
    const drops = fixture();
    const orb = drops.spawn();
    orb.x = orb.px = 1;
    orb.y = orb.py = 0;
    orb.kind = DROP_KIND_MAGNET;
    orb.value = 0;
    const out = { n: 0 };
    const got = stepDrops(drops, 0, 0, SIM_DT, 1, 1, out);
    expect(out.n).toBe(1);
    expect(got).toBe(0);
    expect(drops.size).toBe(0);
  });

  it('经验掉落收下进账、不报宝物(分流问 kind 不问 value)', () => {
    const drops = fixture();
    const xp = drops.spawn();
    xp.x = xp.px = 1;
    xp.y = xp.py = 0;
    xp.value = 4;
    const out = { n: 0 };
    const got = stepDrops(drops, 0, 0, SIM_DT, 1, 1.5, out);
    expect(got).toBe(6);
    expect(out.n).toBe(0);
  });

  it('resetDrop 清 kind:一颗宝物回收后,下一个 spawn 出的是一颗普通残骸', () => {
    const drops = fixture();
    const orb = drops.spawn();
    orb.kind = DROP_KIND_MAGNET;
    orb.x = orb.px = 1;
    orb.y = orb.py = 0;
    stepDrops(drops, 0, 0, SIM_DT);
    expect(drops.size).toBe(0);
    const next = drops.spawn();
    expect(next.kind).toBe(DROP_KIND_XP);
  });
});
