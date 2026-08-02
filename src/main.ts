/**
 * 入口:组装 sim(纯逻辑)+ 输入采样 + 固定时步循环 + 渲染 + 调参面板 + 结算重开。
 * 输入在这里接线而不是在 sim 里读键盘:sim 永不 import core/input(铁律 1),
 * 键盘状态每逻辑帧被翻译成纯数据 ShipCommand 灌进 World.step —— 换来"同 seed + 同输入序列 → 同一条轨迹"。
 * seed 可用 ?seed=123 指定;同 seed 两次运行,同 tick 的 checksum 必须一致。
 *
 * 08 号 issue T3 起,"一局"的装配抽成了 startRun 这一个可重复调用的过程
 * (验收标准原文:一局从开始到胜利/失败/重开**全流程无需刷新页面**)。
 * **游戏流程只在这一层**:World 只把胜负以 onGameOver 说出来,自己不暂停、不重开、不动 loop;
 * 结算界面只把"玩家想再来一局"说出来,自己不认识 World。于是"换一局"这件事全仓只有一处 ——
 * 而它恰恰是最容易做漏的一环:漏一样(渲染层的脏标记、放置交互的 world 引用、面板读数、
 * checksum 节流的游标)都要等真人重开第二局才看得出来。
 */
import { Input } from './core/input';
import { FixedStepLoop, SIM_HZ } from './core/loop';
import { WAVE_SEGMENTS } from './data/waves';
import { Renderer } from './render/renderer';
import type { ShipCommand } from './sim/ship';
import { World } from './sim/world';
import { createDebugPanel, type DebugStats, type RunState } from './ui/debugPanel';
import { createGameOverUi } from './ui/gameOver';
import { createPlacementUi } from './ui/placement';

const seed = Number(new URLSearchParams(location.search).get('seed') ?? '') || 20260801;

async function boot(): Promise<void> {
  const input = new Input();
  // 整局复用同一个 cmd:World 只读它、不缓存引用,所以就地改字段是安全的,
  // 也省下 60Hz 的稳定分配(铁律 3 的运行期零新增分配)。跨局也复用 —— 它是输入的暂存,不是世界状态
  const cmd: ShipCommand = { desiredHeading: null };

  // 这一局的世界与循环。两个都是 **let**:重开 = 换一个新 World + 一个新 FixedStepLoop
  // (World 不加 reset()/restart():池、rng、tick、甲板全是新的,才谈得上"同 seed 可复现";
  //  loop 同理,tick 是这一局的帧号,而 checksum 与面板读数全挂在它上面)。
  // 下面所有闭包(loop 的 step、ticker、结算回调)读的都是这两个变量本身,故换引用一次就够。
  let runIndex = 0;
  // 首局的 World 得先建出来:Renderer.create 建层时就要读甲板。建完原样交给 startRun,
  // 于是**首局与重开走的是同一条装配流程** —— 两条路各写一份的话,重开那条永远会比首局少接一样东西
  let world = new World(seed);
  let loop: FixedStepLoop;
  const renderer = await Renderer.create(world);

  // hp / maxHp 初值直接取船的当前值:面板在第一帧渲染之前就该显示满血,而不是先闪一下 0。
  // 波次那几项同理取世界的当前值(createWaveState 已经按第 0 段 t=0 算好了方向与强度)
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
    segment: 0,
    segTime: 0,
    threatDeg: 0,
    threatRate: 0,
    kills: 0,
  };
  const run: RunState = { paused: false, timeScale: 1 };

  // 放置交互(03 号 issue 的灰盒入口:B 开关 / **1..6 选六种武器塔** /
  // **0 进支援模式,再按 0 在四种支援设施间轮换** / Esc 退出 / 左键放置 ——
  // 05 号起数字键直选塔型、06 号起 0 键轮换设施型,键位表由 ui 侧从数值表现生成,这里不复述)。
  // 屏幕像素换世界坐标只走渲染层这一份镜头公式 —— ui 层不复制第二份,也就不 import pixi(铁律 1)。
  // 状态对象交给渲染层画高亮;两边共享同一个对象,ui 就地改字段,渲染层下一帧自然读到。
  // **只建一次**,重开只换它认的那个 World(见 placement.setWorld):重建一份就等于
  // 每局多一份 window 监听器、多一条提示条。
  // 注意:10 号 issue 的"三选一 → 时停 → 甲板放大 → 拖放"会把这三行连同 ui/placement.ts 一起换掉。
  const placement = createPlacementUi({
    world,
    canvas: renderer.app.canvas,
    screenToWorld: (sx, sy, out) => renderer.screenToWorld(sx, sy, out),
  });
  renderer.setPlacement(placement);

  // 结算界面同样**只建一次**(理由同上:每局多挂一份 Enter 监听器 = 一次回车重开好几局),
  // 重开走的是它的 show/hide。它不认识 World,只收一份纯数据 RunSummary
  const gameOver = createGameOverUi({ onRestart: restart });

  // 调参面板也只建一次:它绑的是 stats/run/tuning 这几个**跨局复用**的对象,
  // 换 World 不换它们(读数由 startRun 复位、tuning 是玩家自己拖的旋钮,重开不该替他复原)
  createDebugPanel(stats, run, { restart });

  let lastChecksumTick = -SIM_HZ;

  /**
   * 装配一局。首局与重开走的是同一条路,顺序有讲究:
   * 先换 world/loop 与挂钩(它们是这一局的本体),再把三个吃 World 引用的地方指过去
   * (渲染层的脏标记缓存 / 放置交互认的甲板 / 结算界面收起来),最后复位 UI 读数。
   * 漏一样的后果各不相同、但都要等真人重开第二局才看得见:
   * 渲染层留着上一局的 deckRevision → 新船上还画着上一局的塔;
   * 放置交互留着旧 world → 点下去落进上一局那艘沉船,画面上什么都不发生;
   * 面板读数不复位 → checksum/tick 还挂在上一局的数上,"同 seed 可复现"当场没法验。
   */
  function startRun(next: World): void {
    world = next;
    loop = new FixedStepLoop(() => {
      // 必须在每个逻辑帧边界重新取样:一帧一采才让"按住 A 的时长"精确对应转过的角度,
      // 掉帧补步时也照样一步一次,手感不随渲染帧率漂移。
      // 读的是外层那个 let world —— 每局都新建 loop,而 startRun 已经先把它换成本局这个了
      cmd.desiredHeading = input.desiredHeading();
      world.step(cmd);
    });

    // 局终(胜利 = 脚本走完 / 失败 = HP 归零,判定与优先级全在 World.settleOutcome)。
    // **sim 当场停下就是 run.paused 这一句**:下一渲染帧起 loop.advance 不再被调用,
    // 世界冻在结算那一帧上(World 自己不暂停、不重开、不动 loop —— 它不认识"游戏流程")。
    // 回调是一次性的,故这里不必自己去重
    world.onGameOver = (result) => {
      run.paused = true;
      gameOver.show({
        result,
        survivedSec: world.elapsed,
        kills: world.kills,
        segment: world.wave.segment,
        // 总段数从数据表现读:数据表里加/删一段,结算界面上的 "n/4" 自动跟上(改数据即可调节奏)
        segmentCount: WAVE_SEGMENTS.length,
        // 剪影是**可选项**:抓不到就是 null,结算界面照常弹(见 renderer.captureShipSilhouette)。
        // 在这里截而不是在渲染层自己判断时机:一局只截一次,而"哪一刻算一局的最终船形"是流程的事
        silhouette: renderer.captureShipSilhouette(),
      });
    };

    // 三处吃 World 引用的地方(渲染层的脏标记缓存 / 放置交互 / 结算界面),各自的理由见它们自己那边
    renderer.setWorld(world);
    placement.setWorld(world);
    gameOver.hide();

    // UI 读数复位。**不动 tuning、不动 run.timeScale、不动放置模式的开关**:
    // 那些是玩家自己拖出来的调参状态,重开一局不该顺手替他复原
    stats.tick = 0;
    stats.checksum = '—';
    stats.hp = world.ship.hp;
    stats.maxHp = world.ship.maxHp;
    stats.seed = seed + runIndex;
    stats.kills = 0;
    stats.segment = world.wave.segment;
    stats.segTime = world.wave.segTime;
    // checksum 每秒才算一次(见 ticker),游标推回负一秒 = 新局第一帧就出第一个值 ——
    // 不推的话,重开后的头一秒面板上挂的还是上一局最后那个哈希,而那正是最容易看错的一个数
    lastChecksumTick = -SIM_HZ;
    run.paused = false;
    runIndex++;

    // 开发用全局句柄:浏览器控制台里可直接 __game.run.paused = true / __game.world.checksum()
    // / __game.input.desiredHeading() 确认键位真的被读到 / __game.restart() 手动重开。
    // **每局重挂**:不换的话 __game.world 拿到的还是上一局那艘沉船,控制台里查什么都是错的
    (window as unknown as { __game?: object }).__game = {
      world,
      loop,
      run,
      stats,
      input,
      placement,
      gameOver,
      restart,
    };
  }

  /**
   * 「再来一局」的唯一入口(结算界面的按钮/Enter 与调参面板的重开按钮共用)。
   * 种子 = seed + 局数:`?seed=` 仍然能复现**第一局**(01 号的确定性口径),
   * 而重开不会每局一模一样 —— 同一份怪潮打第二遍就没什么可玩的了。
   * 函数声明(而不是 const)是为了给上面的 createGameOverUi / createDebugPanel 提前引用:
   * 这两个面板都只建一次,而它们建的时候这一局还没开始装配。
   */
  function restart(): void {
    startRun(new World(seed + runIndex));
  }

  // 首局:把已经交给渲染层的那个 World 原样送进同一条装配流程
  startRun(world);

  renderer.app.ticker.add((ticker) => {
    // 结算弹出后 run.paused = true,于是这一句不再推进 sim,世界冻在结算那一帧上;
    // 下面的 sync 照常跑 —— 结算界面背后是一张静止的战场,而不是黑屏
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
    // 波次读数(08 号 issue):在 11 号的威胁罗盘落地之前,这四个数是"主压方向真的在转"
    // 这条验收唯一的量化读数 —— 画面上只看得出"怪好像多是从那边来的"
    stats.segment = world.wave.segment;
    stats.segTime = world.wave.segTime;
    // 罗盘读的是弧度(world.threatDirection),面板换算成度并折回 [0,360):
    // 数据表里写的是 0..480 的累积角,读数落在负角上就得在脑子里加一圈才对得上
    const threatDeg = (world.threatDirection * 180) / Math.PI;
    stats.threatDeg = threatDeg < 0 ? threatDeg + 360 : threatDeg;
    stats.threatRate = world.threatIntensity;
    stats.kills = world.kills;
    if (loop.tick - lastChecksumTick >= SIM_HZ) {
      stats.checksum = world.checksum();
      lastChecksumTick = loop.tick;
    }
  });
}

void boot();
