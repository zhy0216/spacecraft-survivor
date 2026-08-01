/**
 * 入口:组装 sim(纯逻辑)+ 固定时步循环 + 渲染 + 调参面板。
 * seed 可用 ?seed=123 指定;同 seed 两次运行,同 tick 的 checksum 必须一致。
 */
import { FixedStepLoop, SIM_HZ } from './core/loop';
import { Renderer } from './render/renderer';
import { World } from './sim/world';
import { createDebugPanel, type DebugStats, type RunState } from './ui/debugPanel';

const seed = Number(new URLSearchParams(location.search).get('seed') ?? '') || 20260801;

async function boot(): Promise<void> {
  const world = new World(seed);
  const loop = new FixedStepLoop(() => world.step());
  const renderer = await Renderer.create(world);

  const stats: DebugStats = { fps: 0, tick: 0, checksum: '—', seed };
  const run: RunState = { paused: false, timeScale: 1 };
  createDebugPanel(stats, run);

  // 开发用全局句柄:浏览器控制台里可直接 __game.run.paused = true / __game.world.checksum()
  (window as unknown as { __game?: object }).__game = { world, loop, run, stats };

  let lastChecksumTick = -SIM_HZ;
  renderer.app.ticker.add((ticker) => {
    if (!run.paused) loop.advance(ticker.elapsedMS * run.timeScale);
    renderer.sync(loop.alpha);

    stats.fps = Math.round(renderer.app.ticker.FPS);
    stats.tick = loop.tick;
    if (loop.tick - lastChecksumTick >= SIM_HZ) {
      stats.checksum = world.checksum();
      lastChecksumTick = loop.tick;
    }
  });
}

void boot();
