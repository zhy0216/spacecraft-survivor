/**
 * 入口:组装 sim(纯逻辑)+ 输入采样 + 固定时步循环 + 渲染 + 调参面板。
 * 输入在这里接线而不是在 sim 里读键盘:sim 永不 import core/input(铁律 1),
 * 键盘状态每逻辑帧被翻译成纯数据 ShipCommand 灌进 World.step —— 换来"同 seed + 同输入序列 → 同一条轨迹"。
 * seed 可用 ?seed=123 指定;同 seed 两次运行,同 tick 的 checksum 必须一致。
 */
import { Input } from './core/input';
import { FixedStepLoop, SIM_HZ } from './core/loop';
import { Renderer } from './render/renderer';
import type { ShipCommand } from './sim/ship';
import { World } from './sim/world';
import { createDebugPanel, type DebugStats, type RunState } from './ui/debugPanel';

const seed = Number(new URLSearchParams(location.search).get('seed') ?? '') || 20260801;

async function boot(): Promise<void> {
  const world = new World(seed);
  const input = new Input();
  // 整局复用同一个 cmd:World 只读它、不缓存引用,所以就地改字段是安全的,
  // 也省下 60Hz 的稳定分配(铁律 3 的运行期零新增分配)。
  const cmd: ShipCommand = { desiredHeading: null };
  const loop = new FixedStepLoop(() => {
    // 必须在每个逻辑帧边界重新取样:一帧一采才让"按住 A 的时长"精确对应转过的角度,
    // 掉帧补步时也照样一步一次,手感不随渲染帧率漂移。
    cmd.desiredHeading = input.desiredHeading();
    world.step(cmd);
  });
  const renderer = await Renderer.create(world);

  const stats: DebugStats = { fps: 0, enemies: 0, bullets: 0, speed: 0, tick: 0, checksum: '—', seed };
  const run: RunState = { paused: false, timeScale: 1 };
  createDebugPanel(stats, run);

  // 开发用全局句柄:浏览器控制台里可直接 __game.run.paused = true / __game.world.checksum()
  // / __game.input.desiredHeading() 确认键位真的被读到
  (window as unknown as { __game?: object }).__game = { world, loop, run, stats, input };

  let lastChecksumTick = -SIM_HZ;
  renderer.app.ticker.add((ticker) => {
    if (!run.paused) loop.advance(ticker.elapsedMS * run.timeScale);
    renderer.sync(loop.alpha);

    stats.fps = Math.round(renderer.app.ticker.FPS);
    stats.enemies = world.enemies.size;
    stats.bullets = world.bullets.size;
    // 拖巡航滑杆时盯这个数爬到新上限,才算证实了"改参数无需重启"(02 号 issue 验收标准)
    stats.speed = Math.hypot(world.ship.vx, world.ship.vy);
    stats.tick = loop.tick;
    if (loop.tick - lastChecksumTick >= SIM_HZ) {
      stats.checksum = world.checksum();
      lastChecksumTick = loop.tick;
    }
  });
}

void boot();
