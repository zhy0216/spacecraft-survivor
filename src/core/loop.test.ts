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

/**
 * 时停的停法(10 号 issue T3)。08 号踩过的坑:弹结算/弹卡片是在 step 回调里说出来的,
 * 那一刻循环还站在 while 里 —— 只立外层的 run.paused 挡的是**下一次** advance,
 * 本次 advance 还会把剩余固定步补完。下面两条分别钉"当场停手"与"不补跑"。
 * 喂 64ms:够补 3 步(64 / 16.67 = 3.84),第 1 步就停手的话另外两步必须不发生。
 */
describe('FixedStepLoop.halt()', () => {
  it('回调里 halt 后,本次 advance 不再多跑一步', () => {
    let steps = 0;
    const loop: FixedStepLoop = new FixedStepLoop(() => {
      steps++;
      loop.halt();
    });

    loop.advance(64);

    // 当前这一步跑完才停(它正是"弹卡片的那一帧"),但不许再补第 2、3 步
    expect(steps).toBe(1);
    expect(loop.tick).toBe(1);
    // 剩余时间作废,于是也没有"下一步的进度"可言
    expect(loop.alpha).toBe(0);
  });

  it('被丢弃的时间不会在下一次 advance 补跑回来', () => {
    let halting = true;
    const loop: FixedStepLoop = new FixedStepLoop(() => {
      if (halting) loop.halt();
    });

    loop.advance(64); // 3.84 步的量,跑 1 步就停手,余下的 47.3ms 该作废
    expect(loop.tick).toBe(1);

    // 时停结束。16ms < 16.67ms:acc 真被清零了才一步都跑不出来
    // (不清的话余量 47.3 + 16 = 63.3ms 会当场补 3 步 —— 时停期间的世界就"漏"跑了)
    halting = false;
    loop.advance(16);
    expect(loop.tick).toBe(1);

    // 但也不是"从此不跑了":旗每次 advance 进门就清,再喂一帧凑够一步照常推进
    loop.advance(16);
    expect(loop.tick).toBe(2);
  });

  it('升级回调里 halt + 外层 paused 后,敌人/子弹/掉落/计时器在任意渲染帧数内完全冻结', () => {
    const world = new World(20260802);
    const bullet = world.bullets.spawn();
    bullet.x = bullet.px = 0;
    bullet.y = bullet.py = 0;
    bullet.vx = 120;
    bullet.life = 10;
    const drop = world.drops.spawn();
    drop.x = drop.px = 100;
    drop.y = drop.py = 0;
    drop.value = 1;
    world.scrap = world.upgradeCost;

    let paused = false;
    const loop: FixedStepLoop = new FixedStepLoop(() => world.step());
    world.onUpgradeOffer = () => {
      paused = true; // main.ts:挡住下一次 advance
      loop.halt(); // main.ts:本次 advance 当场停手
    };

    loop.advance(64); // 原本够补 3 步,弹卡那一步后必须立刻停
    expect(loop.tick).toBe(1);
    expect(world.offer.length).toBeGreaterThan(0);
    const enemy = world.enemies.items[0]!;
    const snapshot = {
      tick: world.tick,
      checksum: world.checksum(),
      enemyX: enemy.x,
      enemyY: enemy.y,
      bulletX: bullet.x,
      bulletLife: bullet.life,
      dropX: drop.x,
      dropMagnet: drop.magnet,
    };

    // ticker / 渲染照常跑两秒,但 main 的 paused 守卫不再把任何墙钟时间灌进 sim。
    for (let frame = 0; frame < 120; frame++) if (!paused) loop.advance(1000 / 60);

    expect(world.tick).toBe(snapshot.tick);
    expect(world.checksum()).toBe(snapshot.checksum);
    expect([enemy.x, enemy.y]).toEqual([snapshot.enemyX, snapshot.enemyY]);
    expect([bullet.x, bullet.life]).toEqual([snapshot.bulletX, snapshot.bulletLife]);
    expect([drop.x, drop.magnet]).toEqual([snapshot.dropX, snapshot.dropMagnet]);
  });
});
