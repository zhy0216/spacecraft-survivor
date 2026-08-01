/**
 * 本文件在 Node 环境运行,这本身就是"sim 不依赖 Pixi/DOM"的验证(01 号 issue)。
 */
import { describe, expect, it } from 'vitest';
import { tuning } from './config';
import { World } from './world';

// 测试用小规模(压测数量是浏览器场景的事,这里只验证逻辑正确性)
tuning.stressEnemies = 300;
tuning.stressBullets = 100;

describe('World 确定性', () => {
  it('同 seed 同 tick 数 → checksum 相同(01 号 issue 验收)', () => {
    const a = new World(123);
    const b = new World(123);
    for (let i = 0; i < 120; i++) {
      a.step();
      b.step();
    }
    expect(a.enemies.size).toBe(300);
    expect(a.bullets.size).toBe(100);
    expect(a.checksum()).toBe(b.checksum());
  });

  it('不同 seed → checksum 不同', () => {
    const a = new World(1);
    const b = new World(2);
    for (let i = 0; i < 30; i++) {
      a.step();
      b.step();
    }
    expect(a.checksum()).not.toBe(b.checksum());
  });

  it('空间哈希 cell = 最大敌半径 ×2(GDD §13 不变量)', () => {
    expect(new World(1).grid.cellSize).toBe(tuning.enemyRadiusMax * 2);
  });

  it('实体数量跟随 tuning 动态调整(面板改数量即时生效)', () => {
    const w = new World(9);
    w.step();
    expect(w.enemies.size).toBe(300);
    tuning.stressEnemies = 150;
    w.step();
    expect(w.enemies.size).toBe(150);
    tuning.stressEnemies = 300;
    w.step();
    expect(w.enemies.size).toBe(300);
  });
});
