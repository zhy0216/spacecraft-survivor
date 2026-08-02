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
import { createPlacementUi } from './ui/placement';

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

  // hp / maxHp 初值直接取船的当前值:面板在第一帧渲染之前就该显示满血,而不是先闪一下 0
  const stats: DebugStats = {
    fps: 0,
    enemies: 0,
    bullets: 0,
    speed: 0,
    hp: world.ship.hp,
    maxHp: world.ship.maxHp,
    tick: 0,
    checksum: '—',
    seed,
  };
  const run: RunState = { paused: false, timeScale: 1 };
  createDebugPanel(stats, run);

  // 放置交互(03 号 issue 的灰盒入口:B 开关 / **1..6 选六种武器塔** /
  // **0 进支援模式,再按 0 在四种支援设施间轮换** / Esc 退出 / 左键放置 ——
  // 05 号起数字键直选塔型、06 号起 0 键轮换设施型,键位表由 ui 侧从数值表现生成,这里不复述)。
  // 屏幕像素换世界坐标只走渲染层这一份镜头公式 —— ui 层不复制第二份,也就不 import pixi(铁律 1)。
  // 状态对象交给渲染层画高亮;两边共享同一个对象,ui 就地改字段,渲染层下一帧自然读到。
  // 注意:10 号 issue 的"三选一 → 时停 → 甲板放大 → 拖放"会把这三行连同 ui/placement.ts 一起换掉。
  const placement = createPlacementUi({
    world,
    canvas: renderer.app.canvas,
    screenToWorld: (sx, sy, out) => renderer.screenToWorld(sx, sy, out),
  });
  renderer.setPlacement(placement);

  // 开发用全局句柄:浏览器控制台里可直接 __game.run.paused = true / __game.world.checksum()
  // / __game.input.desiredHeading() 确认键位真的被读到
  (window as unknown as { __game?: object }).__game = { world, loop, run, stats, input, placement };

  let lastChecksumTick = -SIM_HZ;
  renderer.app.ticker.add((ticker) => {
    if (!run.paused) loop.advance(ticker.elapsedMS * run.timeScale);
    // 船动了、光标没动,悬停格也得跟着重算 —— 否则高亮框会跟着甲板飘走(见 placement.syncHover)
    placement.syncHover();
    // 按住 Tab 叠加显示各塔射界(GDD §4.2:**按住**,不是 toggle,所以这里每帧灌"此刻是否按着"
    // 而不是监听一次按键事件)。按渲染帧采样即可 —— 它纯是可视化开关,不进 World.step,
    // 也就不参与确定性回放;放在 sync 之前是为了同一帧内先定开关再画,不留一帧迟滞。
    renderer.setArcOverlay(input.isDown('Tab'));
    renderer.sync(loop.alpha);

    stats.fps = Math.round(renderer.app.ticker.FPS);
    stats.enemies = world.enemies.size;
    stats.bullets = world.bullets.size;
    // 拖巡航滑杆时盯这个数爬到新上限,才算证实了"改参数无需重启"(02 号 issue 验收标准)
    stats.speed = Math.hypot(world.ship.vx, world.ship.vy);
    // 船体 HP(09 号 issue):画面上那条灰盒血条只回答"在掉",拖撞击伤害倍率 / 无敌帧对比
    // "掉得多快"要看这个数(09 号验收标准的"可控可调")。11 号 issue 的 HUD 会接手这条读数
    stats.hp = world.ship.hp;
    // 上限每帧现读(06 号 issue):它是甲板的派生量,放一块装甲舱当帧 +15、12 号拆掉当帧回落 ——
    // 装甲舱是四种设施里唯一不画邻接连线的那种,这个数跳一下就是它生效的肉眼落点
    stats.maxHp = world.ship.maxHp;
    stats.tick = loop.tick;
    if (loop.tick - lastChecksumTick >= SIM_HZ) {
      stats.checksum = world.checksum();
      lastChecksumTick = loop.tick;
    }
  });
}

void boot();
