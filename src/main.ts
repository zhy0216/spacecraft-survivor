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
 * 而它恰恰是最容易做漏的一环:漏一样(渲染层的脏标记、升级流程的 world 引用、面板读数、
 * checksum 节流的游标)都要等真人重开第二局才看得出来。
 *
 * 10 号 issue 起,**时停也只在这一层**:World 攒够残骸就把 onUpgradeOffer 说出来,
 * 停不停、放不放大、什么时候恢复战斗一概不归它管(与 onGameOver 一字同源)。
 * 冻结世界要两句话才算数 —— run.paused 挡住下一次 advance,loop.halt() 让**本次** advance
 * 当场停手(回调是在 step 回调里响的,那一刻 while 还没走完)。
 */
import { Input } from './core/input';
import { FixedStepLoop, SIM_HZ } from './core/loop';
import { WAVE_SEGMENTS } from './data/waves';
import { Renderer } from './render/renderer';
import { applyStartingLoadout } from './sim/loadout';
import type { ShipCommand } from './sim/ship';
import { World } from './sim/world';
import { createDebugPanel, type DebugStats, type RunState } from './ui/debugPanel';
import { createGameOverUi } from './ui/gameOver';
import { createHud } from './ui/hud';
import { createUpgradeFlow, type UpgradeFlowUi } from './ui/upgradeFlow';

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

  // 战斗 HUD 同样整页只建一次:固定屏幕空间的血条/残骸/计时/航段与威胁箭头都只改已有 DOM。
  // 重开走 setWorld,升级时停与结算的淡出则每渲染帧照 run.paused 同步,不另挂事件监听器。
  // 放在升级/结算面板之前创建,后两者弹出时自然盖在它上面;HUD 本身 pointer-events:none。
  const hud = createHud({ world });

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
    scrap: 0,
    upgrades: 0,
    upgradeCost: world.upgradeCost,
  };
  const run: RunState = { paused: false, timeScale: 1 };

  // 三选一升级流程(10 号 issue T4,取代了 03 号那条灰盒放置入口 ui/placement.ts ——
  // 删而不是留一个 debug 开关的理由见 ui/upgradeFlow.ts 的文件头)。
  // 两阶段:选卡 → 放置,时停期间的一切交互都在它那一侧;这里只负责"接线"。
  // 拾格子走渲染层的 screenToDeckLocal 而不是 screenToWorld:甲板放大 30% 之后,
  // 只有它算得出与画面上那个高亮框同一格(镜头/缩放公式只在渲染层存一份,ui 不复制第二份,
  // 也就不 import pixi —— 铁律 1)。状态对象交给渲染层画高亮:两边共享同一个对象,
  // ui 就地改字段,渲染层下一帧自然读到。
  // **只建一次**,重开只换它认的那个 World(见 upgradeFlow.setWorld):
  // 重建一份就等于每局多一份 window 监听器、多一块面板。
  // 类型标注不能省:onResolved 的闭包里回头引用了 upgradeFlow 自己,不标就是一处循环推导。
  const upgradeFlow: UpgradeFlowUi = createUpgradeFlow({
    world,
    canvas: renderer.app.canvas,
    screenToDeckLocal: (sx, sy, out) => renderer.screenToDeckLocal(sx, sy, out),
    // 这一次升级结算完了(放好了 / 跳过了):收卡、甲板缩回去、战斗继续。
    // **恢复战斗只有这一条路** —— World 与 ui 都不认识"游戏流程",run.paused 只在 main 这一层动
    onResolved: () => {
      upgradeFlow.hide();
      renderer.setDeckZoom(false);
      run.paused = false;
    },
  });
  renderer.setPlacement(upgradeFlow);

  // 结算界面同样**只建一次**(理由同上:每局多挂一份 Enter 监听器 = 一次回车重开好几局),
  // 重开走的是它的 show/hide。它不认识 World,只收一份纯数据 RunSummary
  const gameOver = createGameOverUi({ onRestart: restart });

  // 调参面板也只建一次:它绑的是 stats/run/tuning 这几个**跨局复用**的对象,
  // 换 World 不换它们(读数由 startRun 复位、tuning 是玩家自己拖的旋钮,重开不该替他复原)
  createDebugPanel(stats, run, { restart });

  let lastChecksumTick = -SIM_HZ;

  /**
   * 装配一局。首局与重开走的是同一条路,顺序有讲究:
   * 先换 world/loop 与挂钩(它们是这一局的本体),再把吃 World 引用的地方指过去
   * (渲染层的脏标记缓存 / 升级流程认的甲板 / HUD 读数 / 结算界面收起来),最后复位调试读数。
   * 漏一样的后果各不相同、但都要等真人重开第二局才看得见:
   * 渲染层留着上一局的 deckRevision → 新船上还画着上一局的塔;
   * 升级流程留着旧 world → 点下去落进上一局那艘沉船,画面上什么都不发生;
   * 面板读数不复位 → checksum/tick 还挂在上一局的数上,"同 seed 可复现"当场没法验。
   */
  function startRun(next: World): void {
    world = next;
    // 正式开局才套用固定舷位起手塔。**不放进 World 构造函数**:规则单测与纯 sim 调用方需要空甲板,
    // 而「这一局怎么开场」是 data/loadout.ts 的数值配置,经 sim/loadout 逐条走 placeAt 唯一入口。
    applyStartingLoadout(world.deck);
    loop = new FixedStepLoop(() => {
      // 必须在每个逻辑帧边界重新取样:一帧一采才让"按住 A 的时长"精确对应转过的角度,
      // 掉帧补步时也照样一步一次,手感不随渲染帧率漂移。
      // 读的是外层那个 let world —— 每局都新建 loop,而 startRun 已经先把它换成本局这个了
      cmd.desiredHeading = input.desiredHeading();
      world.step(cmd);
    });

    // 局终(胜利 = 脚本走完 / 失败 = HP 归零,判定与优先级全在 World.settleOutcome)。
    // **sim 当场停下要 run.paused + loop.halt() 两句**(与弹卡那一处一字同源,理由见下):
    // 前者让下一渲染帧起不再调用 loop.advance,后者让本次 advance 当场停手 ——
    // 世界于是冻在结算那一帧上(World 自己不暂停、不重开、不动 loop:它不认识"游戏流程")。
    // 回调是一次性的,故这里不必自己去重
    world.onGameOver = (result) => {
      run.paused = true;
      // **run.paused 只挡得住下一次 advance**:回调是在 loop 的 step 里响的,那一刻 advance
      // 还站在 while 里,不 halt 的话本次还会把剩余的固定步补完(最多 4 帧 ≈ 66ms)——
      // 结算界面背后那张"静止的战场"就会比玩家看到的最后一帧多走一段(与弹卡那一处同一个坑)
      loop.halt();
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

    // 攒够残骸 → 三选一(10 号 issue T4)。**时停就是这三句**:run.paused 挡住下一次 advance,
    // loop.halt() 让**本次** advance 当场停手并丢掉剩余累积时间(回调是在 step 里响的,
    // 不 halt 的话这一帧还会补跑最多 4 步 = 时停"漏"了 66ms),setDeckZoom 把甲板放大 30%
    // (GDD §11)。World 自己不暂停、不动 loop —— 它连"这一局要不要停"都不知道。
    // 回调只在候选生成那一帧响一次,故这里不必自己去重
    world.onUpgradeOffer = () => {
      run.paused = true;
      loop.halt();
      renderer.setDeckZoom(true);
      upgradeFlow.show();
    };

    // 吃 World 引用的地方(渲染层的脏标记缓存 / 升级流程 / HUD),各自的理由见它们自己那边。
    // setWorld 会把上一局那张还开着的卡片一并收掉,但**不恢复战斗** —— 那一步在下面的 run.paused;
    // 甲板缩放同理由渲染层的 setWorld 当场吸附回 1(时停中点重开按钮时,不复位就会带着放大开出去)
    renderer.setWorld(world);
    upgradeFlow.setWorld(world);
    hud.setWorld(world);
    gameOver.hide();

    // UI 读数复位。**不动 tuning、不动 run.timeScale、不动放置模式的开关**:
    // 那些是玩家自己拖出来的调参状态,重开一局不该顺手替他复原
    stats.tick = 0;
    stats.checksum = '—';
    stats.hp = world.ship.hp;
    stats.maxHp = world.ship.maxHp;
    stats.seed = seed + runIndex;
    stats.kills = 0;
    stats.scrap = 0;
    stats.upgrades = 0;
    stats.upgradeCost = world.upgradeCost;
    stats.segment = world.wave.segment;
    stats.segTime = world.wave.segTime;
    // checksum 每秒才算一次(见 ticker),游标推回负一秒 = 新局第一帧就出第一个值 ——
    // 不推的话,重开后的头一秒面板上挂的还是上一局最后那个哈希,而那正是最容易看错的一个数
    lastChecksumTick = -SIM_HZ;
    run.paused = false;
    // 上一局若停在升级/结算态,HUD 此刻仍是淡出的;新局装配完成就当场恢复,不等首个 ticker。
    hud.setPaused(false);
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
      upgradeFlow,
      hud,
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
    // 按住 Tab 叠加显示各塔射界(GDD §4.2:**按住**,不是 toggle,所以这里每帧灌"此刻是否按着"
    // 而不是监听一次按键事件)。按渲染帧采样即可 —— 它纯是可视化开关,不进 World.step,
    // 也就不参与确定性回放;放在 sync 之前是为了同一帧内先定开关再画,不留一帧迟滞。
    renderer.setArcOverlay(input.isDown('Tab'));
    // 船动了、光标没动,悬停格也得跟着重算;时停期间船虽不动,甲板放大还在缓动。
    // 同步点由 renderer 卡在「本帧 deckG 变换已更新、高亮尚未绘制」的位置调用,
    // 于是看到的框、screenToDeckLocal 与点击确认一帧都不会走散。直接传稳定方法引用,不按帧造闭包。
    renderer.sync(loop.alpha, upgradeFlow.syncHover);
    // HUD 固定在 DOM 屏幕空间,不读敌人容器、也不随相机/船体变换。时停(升级或结算)先淡出,
    // 再同步静止世界的最后一帧读数;重开时 hud.setWorld 已换到新引用,不会重复 append 节点。
    hud.setPaused(run.paused);
    hud.sync();

    stats.fps = Math.round(renderer.app.ticker.FPS);
    stats.enemies = world.enemies.size;
    stats.bullets = world.bullets.size;
    // 拖巡航滑杆时盯这个数爬到新上限,才算证实了"改参数无需重启"(02 号 issue 验收标准)
    stats.speed = Math.hypot(world.ship.vx, world.ship.vy);
    // 船体 HP 同时进正式 HUD 与调参面板；面板保留数值精度，便于对比撞击伤害倍率 / 无敌帧。
    stats.hp = world.ship.hp;
    // 上限每帧现读(06 号 issue):它是甲板的派生量,放一块装甲舱当帧 +15、12 号拆掉当帧回落 ——
    // 装甲舱是四种设施里唯一不画邻接连线的那种,这个数跳一下就是它生效的肉眼落点
    stats.maxHp = world.ship.maxHp;
    stats.tick = loop.tick;
    // 波次读数与常驻 HUD / 威胁罗盘同源；调参面板额外保留精确值供脚本核对。
    stats.segment = world.wave.segment;
    stats.segTime = world.wave.segTime;
    // 罗盘读的是弧度(world.threatDirection),面板换算成度并折回 [0,360):
    // 数据表里写的是 0..480 的累积角,读数落在负角上就得在脑子里加一圈才对得上
    const threatDeg = (world.threatDirection * 180) / Math.PI;
    stats.threatDeg = threatDeg < 0 ? threatDeg + 360 : threatDeg;
    stats.threatRate = world.threatIntensity;
    stats.kills = world.kills;
    stats.scrap = world.scrap;
    stats.upgrades = world.upgrades;
    stats.upgradeCost = world.upgradeCost;
    if (loop.tick - lastChecksumTick >= SIM_HZ) {
      stats.checksum = world.checksum();
      lastChecksumTick = loop.tick;
    }
  });
}

void boot();
