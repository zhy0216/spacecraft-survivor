/**
 * 01 号 issue 验收第二条:"人为拖慢渲染时,模拟结果不变"。
 * 固定时步的全部意义就在这里 —— World.step() 不接受 dt、只吃 SIM_DT,
 * 所以只要推进的 tick 数相同,轨迹必然逐位相同,与渲染帧率无关。
 */
import { describe, expect, it } from 'vitest';
import { FixedStepLoop, MAX_STEPS_PER_FRAME, SIM_DT } from './loop';
import { tuning } from '../sim/config';
import { World } from '../sim/world';

// 走压测出怪路(08 号 T2 起 step 的正式路径是波次脚本):这条用例钉的是"tick 数相同 → 结果相同",
// 恒定 200 只比随脚本涨落的怪量更容易看出分叉,而波次本身也照样跟着 tick 走(它就在 step 里)
tuning.stressSpawn = true;
tuning.stressEnemies = 200;

/** 按固定帧长喂满 frames 帧,返回跑完的世界与循环 */
function run(dtMs: number, frames: number, seed = 777) {
  const world = new World(seed);
  const loop = new FixedStepLoop(() => world.step());
  for (let i = 0; i < frames; i++) loop.advance(dtMs);
  return { world, loop };
}

// 总时长固定 4992ms = 299.52 × SIM_DT —— 刻意落在两个 tick 之间,
// 免得浮点累积把某一档推过 tick 边界、造成与帧率无关的假失败。
const TOTAL_MS = 4992;
const EXPECTED_TICKS = 299;

describe('固定时步与渲染帧率解耦', () => {
  it('62 / 31 / 15 fps 三档喂同样的总时长 → tick 与 checksum 完全一致', () => {
    const fast = run(16, TOTAL_MS / 16); // 312 帧,≈62fps,每帧最多 1 步
    const mid = run(32, TOTAL_MS / 32); // 156 帧,≈31fps,每帧最多 2 步
    const slow = run(64, TOTAL_MS / 64); // 78 帧,≈15fps,每帧最多 4 步

    expect(fast.loop.tick).toBe(EXPECTED_TICKS);
    expect(mid.loop.tick).toBe(EXPECTED_TICKS);
    expect(slow.loop.tick).toBe(EXPECTED_TICKS);
    expect(mid.world.checksum()).toBe(fast.world.checksum());
    expect(slow.world.checksum()).toBe(fast.world.checksum());
  });

  it('慢于 spiral-of-death 阈值时主动丢时间(是设计,不是确定性 bug)', () => {
    // 阈值 = MAX_STEPS_PER_FRAME × SIM_DT ≈ 83.3ms/帧 ≈ 12fps。
    // 96ms/帧(≈10fps)已越界:每帧只认 83.3ms,推进量必然少于上面三档。
    expect(96).toBeGreaterThan(MAX_STEPS_PER_FRAME * SIM_DT * 1000);
    const starved = run(96, TOTAL_MS / 96);
    expect(starved.loop.tick).toBeLessThan(EXPECTED_TICKS);
    expect(starved.world.checksum()).not.toBe(run(16, TOTAL_MS / 16).world.checksum());
  });
});

describe('FixedStepLoop', () => {
  it('单帧无论多长都只补 MAX_STEPS_PER_FRAME 步', () => {
    const loop = new FixedStepLoop(() => {});
    loop.advance(1000);
    expect(loop.tick).toBe(MAX_STEPS_PER_FRAME);
  });

  it('alpha 恒在 [0, 1]', () => {
    const loop = new FixedStepLoop(() => {});
    for (const dt of [0, 3, 16, 17, 33, 100, 1000]) {
      loop.advance(dt);
      expect(loop.alpha).toBeGreaterThanOrEqual(0);
      expect(loop.alpha).toBeLessThanOrEqual(1);
    }
  });
});
