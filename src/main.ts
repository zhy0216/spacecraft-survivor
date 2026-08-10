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
import { COND_NONE, unlockMet, UNLOCKS, type UnlockProgress } from './data/unlocks';
import { WAVE_MAX_ALIVE, WAVE_SEGMENTS } from './data/waves';
import { audioBus } from './render/audio';
import { Renderer, SHIP_DEATH_FX_TIME } from './render/renderer';
import { applyStartingLoadout } from './sim/loadout';
import { evaluateRun, mergeProgress, type Progress } from './sim/progress';
import type { ShipCommand } from './sim/ship';
import { RESULT_LOSE, RESULT_WIN, World } from './sim/world';
import { createDebugPanel, type DebugStats, type RunState } from './ui/debugPanel';
import { createGameOverUi } from './ui/gameOver';
import { createHud, type HudUi } from './ui/hud';
import { createLoadoutFlow } from './ui/loadoutFlow';
import { loadProgress, saveProgress } from './ui/progressStorage';
import { createRefitFlow, type RefitFlowUi } from './ui/refitFlow';
import { createUpgradeFlow, type UpgradeFlowUi } from './ui/upgradeFlow';

const seed = Number(new URLSearchParams(location.search).get('seed') ?? '') || 20260801;

/** 击杀 hitstop 的冻结时长(ms):40-60ms 的一记顿挫,再长就是卡顿(占位待调) */
const HITSTOP_MS = 45;

async function boot(): Promise<void> {
  const input = new Input();
  // 浏览器自动播放策略:AudioContext 只能由用户手势解锁。在首次键盘/点击的同步栈里 resume
  // 一次就摘掉监听(浏览器要求 resume 必须落在手势处理里;之后发声全靠已解锁的 ctx)。
  // 挂在 main 而不是 Input 里:输入管线不认识声音,音频只从事件出口消费(见 render/audio.ts)。
  const unlockAudio = (): void => {
    window.removeEventListener('keydown', unlockAudio);
    window.removeEventListener('pointerdown', unlockAudio);
    void audioBus.resume();
  };
  window.addEventListener('keydown', unlockAudio);
  window.addEventListener('pointerdown', unlockAudio);
  // 整局复用同一个 cmd:World 只读它、不缓存引用,所以就地改字段是安全的,
  // 也省下 60Hz 的稳定分配(铁律 3 的运行期零新增分配)。跨局也复用 —— 它是输入的暂存,不是世界状态
  const cmd: ShipCommand = { desiredHeading: null };

  // 这一局的世界与循环。两个都是 **let**:重开 = 换一个新 World + 一个新 FixedStepLoop
  // (World 不加 reset()/restart():池、rng、tick、甲板全是新的,才谈得上"同 seed 可复现";
  //  loop 同理,tick 是这一局的帧号,而 checksum 与面板读数全挂在它上面)。
  // 下面所有闭包(loop 的 step、ticker、结算回调)读的都是这两个变量本身,故换引用一次就够。
  let runIndex = 0;
  // 一局的流水号(畅玩性):startRun 每次 +1,沉船爆炸的延迟结算回调比对它 ——
  // 延迟期间重开过,旧局的结算作废(见 onGameOver 的 setTimeout 守卫)
  let runToken = 0;
  // **本局**的种子。restart 换种子时更新,retry(同 seed 重试)原样再用 ——
  // 没有它的话被特定波次组合打死后想"再试同一局"只能手改 URL ?seed= 刷新页面
  let runSeed = seed;
  // **本局**的起手配置(LOADOUTS 下标,20 号)。与 runSeed 同一条纪律:
  // 它是**开跑前输入** —— restart 经选择界面更新,retry 原样沿用(同 seed 重试 = 连起手一起重来);
  // 选择发生在 World 构造之前,故同 seed + 同配置 → 同一条轨迹(选择本身不碰 rng)
  let loadoutIndex = 0;
  // 首局标记:boot 里预建的 World 还没装配过 —— 选择界面回调用它分辨"送预建 World"与"新建 World"
  let firstRun = true;
  // 元进度存档(19 号):页载时读一次,此后每局结算(onGameOver)写一次。
  // World 构造时注入 unlockMask(卡池过滤与解锁精英门控读它);掩码 0 = 全未解锁,首局就是这么起步的。
  // 局内不写 —— 解锁状态只在"一局结束"这一个点入档(progress.ts 的口径,见 onGameOver)
  let progress: Progress = loadProgress();
  // 首局的 World 得先建出来:Renderer.create 建层时就要读甲板。建完原样交给 startRun,
  // 于是**首局与重开走的是同一条装配流程** —— 两条路各写一份的话,重开那条永远会比首局少接一样东西
  let world = new World(runSeed, progress.unlockMask);
  // 首局先给 loop 一个初始值而不是留 undefined:首局的选择界面弹出时 ticker 已经挂上,
  // 它每帧都会读 loop(alpha/tick/advance),缺了这一个值首帧就崩 ——
  // 这个初始 loop 从不会被 advance(run.paused 挡着),startRun 会立刻用本局的替换掉它
  let loop: FixedStepLoop = new FixedStepLoop(() => world.step(cmd));
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
    turnRate: world.turnRate,
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
      renderer.setPlacement(upgradeFlow);
      renderer.setDeckZoom(false);
      run.paused = false;
    },
  });
  renderer.setPlacement(upgradeFlow);

  // 每两分钟的航段整备：与普通升级共用甲板拾格/高亮接口，但流程和权限完全独立。
  // 它只允许焊一块甲板、搬运现有炮塔与支援；新增/升级模块仍只走普通升级。
  const refitFlow: RefitFlowUi = createRefitFlow({
    world,
    canvas: renderer.app.canvas,
    screenToDeckLocal: (sx, sy, out) => renderer.screenToDeckLocal(sx, sy, out),
    // 右侧商店宽度随窗口变化；渲染器用它把飞船始终居中在左侧装配区，而不是压在商店下面。
    onLayout: (rightInset) => renderer.setDeckViewRightInset(rightInset),
    onResolved: () => {
      refitFlow.hide();
      renderer.setAssemblyView(false);
      renderer.setPlacement(upgradeFlow);
      renderer.setDeckZoom(false);
      run.paused = false;
    },
  });
  // 渲染器只接一个 PlacementUiState；两套流程各自 inactive 时同步悬停是空操作。
  const syncPlacementHover = (): void => {
    upgradeFlow.syncHover();
    refitFlow.syncHover();
  };

  // 结算界面同样**只建一次**(理由同上:每局多挂一份 Enter 监听器 = 一次回车重开好几局),
  // 重开走的是它的 show/hide。它不认识 World,只收一份纯数据 RunSummary
  const gameOver = createGameOverUi({ onRestart: restart, onRetry: retry });

  // 调参面板也只建一次:它绑的是 stats/run/tuning 这几个**跨局复用**的对象,
  // 换 World 不换它们(读数由 startRun 复位、tuning 是玩家自己拖的旋钮,重开不该替他复原)
  createDebugPanel(stats, run, { restart, retry });

  let lastChecksumTick = -SIM_HZ;
  // 残骸拾取音的增量检测基准:跟上一次读到的 scrap 比,值爬升的那一帧响一声叮(见 ticker)
  let lastScrap = 0;
  // 击杀 hitstop(畅玩性):上一帧已消费的击杀数(与 lastScrap 同一条增量检测写法)与
  // 冻结截止的墙钟时刻 —— performance.now() < hitstopUntil 时跳过 loop.advance(见 ticker)
  let lastKills = 0;
  let hitstopUntil = 0;
  // 本局已 toast 过的解锁位掩码(19 号):与 progress.unlockMask 同编码。局内检测跨过阈值
  // 就置位,防止同一局里"300 杀达标"这类条件每帧弹一次 —— 置位过的不再重复提示
  let announcedMask = 0;

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
    // 一局的流水号(畅玩性,沉船爆炸的延迟结算用):换一局就 +1 —— 延迟回调里比对它,
    // 期间重开过的旧局结算直接作废,不会在"新一局"头上弹"上一局"的卡片
    runToken++;
    world = next;
    // 正式开局才套用起手配置。**不放进 World 构造函数**:规则单测与纯 sim 调用方需要空甲板,
    // 而「这一局怎么开场」是 data/loadout.ts 的数值配置,经 sim/loadout 逐条走 placeAt 唯一入口。
    // 20 号:套哪一套由 loadoutIndex 定(开局选择界面选完才走到这里,retry 原样沿用上一局的)
    applyStartingLoadout(world.deck, loadoutIndex);
    loop = new FixedStepLoop(() => {
      // 必须在每个逻辑帧边界重新取样:一帧一采才让"按住 A 的时长"精确对应转过的角度,
      // 掉帧补步时也照样一步一次,手感不随渲染帧率漂移。
      // 读的是外层那个 let world —— 每局都新建 loop,而 startRun 已经先把它换成本局这个了
      cmd.desiredHeading = input.desiredHeading();
      world.step(cmd);
    });

    // 沉船那一刻的表现(畅玩性):爆炸演出 + 重震 + 爆炸音。**纯表现** —— 渲染层不碰 sim
    // 任何字段;这一帧稍后的 onGameOver 才暂停世界、推迟弹结算(见下面那句 setTimeout)。
    // 只接"船沉了"(onShipDestroyed)而不接 onGameOver:胜利时没有爆炸,结算就该立刻弹
    world.onShipDestroyed = () => {
      renderer.playShipDeathExplosion();
    };

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
      upgradeFlow.hide();
      refitFlow.hide();
      renderer.setAssemblyView(false);
      // 剪影在渲染层只截一次,存档与结算界面共用同一张(渲染层抓不到就是 null,此时不入图鉴)
      const silhouette = renderer.captureShipSilhouette();
      // 19 号:一局结束 → 结算进元进度。**条件达成即记,不看胜负**:失败局照常入档
      // (progress.ts 口径),wins 是否 +1 由 evaluateRun 自己判,这里只摘 runStats 读数。
      // 失败局同样保存 —— "下一把的新理由"不因这一把输了就欠着
      const evalResult = evaluateRun(progress, {
        result,
        kills: world.kills,
        eliteKills: world.eliteKills,
        silhouette,
      });
      // 单调合并:掩码取并、计数取最大、剪影去重 —— 两份进度只会向前,不会把哪边拉回去
      progress = mergeProgress(progress, evalResult.progress);
      saveProgress(progress);
      // 增量掩码 → UNLOCKS 下标数组:结算界面"解锁 XX"提示与将来图鉴任务读的都是它
      const newUnlockIdx: number[] = [];
      for (let i = 0; i < UNLOCKS.length; i++) {
        if ((evalResult.newUnlocks & (1 << i)) !== 0) newUnlockIdx.push(i);
      }
      // 结算数据在这一刻全部取走(世界此后不再动):延迟弹出用的就是这份快照,
      // 期间重开换掉 world 引用也不影响它 —— 见下面 setTimeout 的 runToken 守卫
      const summary = {
        result,
        survivedSec: world.elapsed,
        kills: world.kills,
        segment: world.wave.segment,
        // 总段数从数据表现读:数据表里加/删一段,结算界面上的 "n/4" 自动跟上(改数据即可调节奏)
        segmentCount: WAVE_SEGMENTS.length,
        // Boss 击杀时刻(15 号):world.bossKilledAt = 击杀那一帧的 elapsed 秒,未击杀保持 0;
        // 只有胜利局会印它(见 gameOver.summaryText),但照常传 —— 口径与 kills 同一处
        bossKilledAtSec: world.bossKilledAt,
        // 剪影是**可选项**:抓不到就是 null,结算界面照常弹(见 renderer.captureShipSilhouette)。
        // 在这里截而不是在渲染层自己判断时机:一局只截一次,而"哪一刻算一局的最终船形"是流程的事
        silhouette,
        // 19 号:newUnlocks = 本次新开锁的 UNLOCKS 下标(增量),结算界面「解锁 XX」提示;
        // progressStats = 结算后的元进度,图鉴读它 —— 两字段定义在 ui/gameOver.ts 的 RunSummary
        newUnlocks: newUnlockIdx,
        progressStats: progress,
      };
      // 失败 = 沉船:结算**推迟 SHIP_DEATH_FX_TIME** 秒再弹,让爆炸演出读得完
      // (爆炸是渲染层自持的,run.paused 冻结世界但不冻结它)。胜利没有爆炸,当场弹。
      // 延迟用墙钟 setTimeout + runToken 守卫:延迟期间玩家从调参面板重开/重试,
      // startRun 已把 runToken +1,旧局的这张卡片直接作废 —— 不会在新一局头上弹"上一局"的结算
      if (result === RESULT_LOSE) {
        const token = runToken;
        window.setTimeout(() => {
          if (token !== runToken) return;
          gameOver.show(summary);
        }, SHIP_DEATH_FX_TIME * 1000);
      } else {
        gameOver.show(summary);
      }
    };

    // 攒够残骸 → 三选一(10 号 issue T4)。**时停就是这三句**:run.paused 挡住下一次 advance,
    // loop.halt() 让**本次** advance 当场停手并丢掉剩余累积时间(回调是在 step 里响的,
    // 不 halt 的话这一帧还会补跑最多 4 步 = 时停"漏"了 66ms),setDeckZoom 把甲板放大 30%
    // (GDD §11)。World 自己不暂停、不动 loop —— 它连"这一局要不要停"都不知道。
    // 回调只在候选生成那一帧响一次,故这里不必自己去重
    world.onUpgradeOffer = () => {
      run.paused = true;
      loop.halt();
      renderer.setAssemblyView(false);
      renderer.setPlacement(upgradeFlow);
      renderer.setDeckZoom(true);
      upgradeFlow.show();
    };

    // 航段跨过两分钟边界后，World 已经停住下一段的出怪；这里负责把当前固定步当场截住，
    // 并切到独立整备界面。普通升级即使同帧够钱也会被 World 延后，不会叠两层时停。
    world.onRefitOffer = (segmentIndex) => {
      run.paused = true;
      loop.halt();
      renderer.setAssemblyView(true);
      renderer.setPlacement(refitFlow);
      renderer.setDeckZoom(true);
      refitFlow.show(segmentIndex);
    };

    // 吃 World 引用的地方(渲染层的脏标记缓存 / 升级流程 / HUD),各自的理由见它们自己那边。
    // setWorld 会把上一局那张还开着的卡片一并收掉,但**不恢复战斗** —— 那一步在下面的 run.paused;
    // 甲板缩放同理由渲染层的 setWorld 当场吸附回 1(时停中点重开按钮时,不复位就会带着放大开出去)
    renderer.setWorld(world);
    upgradeFlow.setWorld(world);
    refitFlow.setWorld(world);
    renderer.setPlacement(upgradeFlow);
    hud.setWorld(world);
    gameOver.hide();

    // UI 读数复位。**不动 tuning、不动 run.timeScale、不动放置模式的开关**:
    // 那些是玩家自己拖出来的调参状态,重开一局不该顺手替他复原
    stats.tick = 0;
    stats.checksum = '—';
    stats.hp = world.ship.hp;
    stats.maxHp = world.ship.maxHp;
    stats.turnRate = world.turnRate;
    stats.seed = runSeed;
    stats.kills = 0;
    stats.scrap = 0;
    // 新局基准 = 新世界的 scrap(当前为 0):首帧增量检测零出发,不会误响拾取音
    lastScrap = world.scrap;
    // hitstop 的增量基准与冻结窗同样属于上一局:新局清零,首帧击杀照常触发一记顿挫
    // (留着旧基准会以为"新局第一秒就杀了一只",或把上一局的冻结窗带进新局)
    lastKills = 0;
    hitstopUntil = 0;
    // 局内解锁 toast 的"已提示"记性也只属于这一局:换局清零(已开锁的位由掩码本身挡住,不会重弹)
    announcedMask = 0;
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
      refitFlow,
      hud,
      gameOver,
      loadoutFlow,
      restart,
      retry,
    };
  }

  /**
   * 「再来一局」的换种子入口(结算界面的按钮/Enter 与调参面板的重开按钮共用)。
   * 种子 = seed + 局数:`?seed=` 仍然能复现**第一局**(01 号的确定性口径),
   * 而重开不会每局一模一样 —— 同一份怪潮打第二遍就没什么可玩的了。
   * 20 号起**先弹起手配置选择界面**:玩家挑完这一局怎么开场,onSelect 才真正装配新局。
   * 选择期间世界必须冻着:结算/时停进来时 run.paused 本来就是 true,这一句兜住
   * 调参面板在战斗中点重开的路径(那个瞬间 run.paused 还是 false)。
   * 函数声明(而不是 const)是为了给上面的 createGameOverUi / createDebugPanel 提前引用:
   * 这两个面板都只建一次,而它们建的时候这一局还没开始装配。
   */
  function restart(): void {
    runIndex++;
    runSeed = seed + runIndex;
    run.paused = true;
    loadoutFlow.show(progress.unlockMask);
  }

  /**
   * 「再试这一局」的同 seed 入口(畅玩性调整):runSeed 不动、runIndex 不消耗,
   * **loadoutIndex 也不动** —— 同 seed 重试连起手配置一起原样重来,不弹选择界面
   * (20 号口径:起手是"这一局"的一部分,想换起手请走「再来一局」)。
   * 新 World 拿到的就是刚打完那一局的种子 —— 确定性口径("同 seed + 同输入 → 同轨迹")
   * 天然支撑它:35s 侧压从哪边来、哪一段最凶,死过一次就都是可用的知识。
   * 它同时修复了调参面板那条"验不了同 seed 可复现"的遗留(面板现在两个按钮都有)。
   */
  function retry(): void {
    startRun(new World(runSeed, progress.unlockMask));
  }

  // 起手配置选择界面(20 号)—— 只建一次,重开走 show/hide(与结算界面同一条教训)。
  // onSelect 是"玩家挑完了"的唯一去处:收界面 → 决定装配哪一艘 World →
  // 交给 startRun 那一条**与重开完全相同的装配流程**(首局与重开不许各写一份,那会漏接线)。
  // 首局送的是 boot 里预建、渲染层已按其甲板建好层的那个 World;重开则新建 ——
  // 由 firstRun 分辨,换种子(retry 外的所有来路)在 restart 里已先算好 runSeed
  const loadoutFlow = createLoadoutFlow({
    onSelect: (index) => {
      loadoutIndex = index;
      loadoutFlow.hide();
      if (firstRun) {
        firstRun = false;
        startRun(world);
      } else {
        startRun(new World(runSeed, progress.unlockMask));
      }
    },
  });

  // 首局:起手配置选择界面先行(GDD §10「起手配置…可在开局选择」)。
  // 首局也走选择界面而不是静默默认「标准起手」:解锁行军从第一把起就看得见
  // ("下一把的新理由"与主流程同屏),且首局与重开从此共用同一条装配路径。
  // 选择不消耗 rng、不推进 sim —— 挑多久都不影响「?seed= 复现第一局」的确定性口径。
  // **先冻结再弹**:此刻 ticker 已挂上(见 boot 末尾),run.paused 挡住 loop.advance,
  // 选择期间世界停在首帧,选完 startRun 收尾时一并恢复
  run.paused = true;
  loadoutFlow.show(progress.unlockMask);

  renderer.app.ticker.add((ticker) => {
    // 击杀 hitstop(畅玩性):击杀数爬升的那一帧立一个 ~50ms 的冻结窗。
    // 窗内跳过 loop.advance —— 世界冻住、画面冻住,就是那一记"顿一下"的打击感;
    // sync/HUD 照常跑(表现层自持的飘字/震屏/爆炸不受影响)。**时停/结算期间不触发**:
    // 那两个状态 run.paused = true,世界本来就不动,再立冻结窗只会把恢复战斗的时间点往后推。
    // 封顶两道:同帧多杀(kills 一次跳 N)只算一次(增量检测);冻结窗内再杀不续窗
    // (`>= hitstopUntil` 挡住了) —— 8 杀/秒也不会变成永久慢动作
    if (!run.paused && world.kills > lastKills && performance.now() >= hitstopUntil) {
      hitstopUntil = performance.now() + HITSTOP_MS;
    }
    lastKills = world.kills;
    // 结算弹出后 run.paused = true,于是这一句不再推进 sim,世界冻在结算那一帧上;
    // 下面的 sync 照常跑 —— 结算界面背后是一张静止的战场,而不是黑屏。
    // hitstop 冻结同理:窗内跳过 advance,世界停在击杀那一帧,插值 alpha 也停住 = 画面定格
    if (!run.paused && performance.now() >= hitstopUntil) loop.advance(ticker.elapsedMS * run.timeScale);
    // 按住 Tab 叠加显示各塔射界(GDD §4.2:**按住**,不是 toggle,所以这里每帧灌"此刻是否按着"
    // 而不是监听一次按键事件)。按渲染帧采样即可 —— 它纯是可视化开关,不进 World.step,
    // 也就不参与确定性回放;放在 sync 之前是为了同一帧内先定开关再画,不留一帧迟滞。
    renderer.setArcOverlay(input.isDown('Tab'));
    // 船动了、光标没动,悬停格也得跟着重算;时停期间船虽不动,甲板放大还在缓动。
    // 同步点由 renderer 卡在「本帧 deckG 变换已更新、高亮尚未绘制」的位置调用,
    // 于是看到的框、screenToDeckLocal 与点击确认一帧都不会走散。直接传稳定方法引用,不按帧造闭包。
    renderer.sync(loop.alpha, syncPlacementHover);
    // HUD 固定在 DOM 屏幕空间,不读敌人容器、也不随相机/船体变换。时停(升级或结算)先淡出,
    // 再同步静止世界的最后一帧读数;重开时 hud.setWorld 已换到新引用,不会重复 append 节点。
    hud.setPaused(run.paused);
    hud.sync();

    stats.fps = Math.round(renderer.app.ticker.FPS);
    stats.enemies = world.enemies.size;
    // 背景底噪:存活敌人数 ÷ WAVE_MAX_ALIVE(同屏保险丝上限)→ 0..1 密度比。
    // Boss 战(15 号):Boss 在场时怪可能很少,底噪却该最沉 —— 取密度比与 0.35 的较大者,
    // 用既有 setAmbience 通道做"Boss 战变奏"(13 音频的 Boss 主题暂缺,先以底噪压沉代替)。
    // setAmbience 每帧只写一条 gain 缓动(setTargetAtTime),便宜到可以每帧灌
    const bossRumble = world.bossPhase === 1 ? 0.35 : 0;
    audioBus.setAmbience(
      Math.min(1, Math.max(0, world.enemies.size / WAVE_MAX_ALIVE, bossRumble)),
    );
    stats.bullets = world.bullets.size;
    // 拖巡航滑杆时盯这个数爬到新上限,才算证实了"改参数无需重启"(02 号 issue 验收标准)
    stats.speed = Math.hypot(world.ship.vx, world.ship.vy);
    stats.turnRate = world.turnRate;
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
    // 局内解锁提示(19 号):每渲染帧对照 UNLOCKS 查"已达成但还没入档"的条件。
    // 局内可达的只有单局击杀(COND_KILLS)与累计精英击杀(COND_ELITE_KILLS,跨局累计 +
    // 本局 world.eliteKills);首胜与收藏在结算入档,局内不存在"达成瞬间",不在这里弹。
    // unlockMet 是单调的(条件不会回退),所以跨过阈值就弹一次、announcedMask 挡住重复。
    // 时停/结算期间不查:那些帧世界不动,阈值不可能跨过,也免得在结算界面底下弹 toast。
    if (!run.paused) {
      const live: UnlockProgress = {
        wins: progress.wins + (world.result === RESULT_WIN ? 1 : 0),
        kills: world.kills,
        eliteKills: progress.eliteKills + world.eliteKills,
      };
      for (let i = 0; i < UNLOCKS.length; i++) {
        if ((progress.unlockMask & (1 << i)) !== 0) continue; // 已解锁不重复判
        if ((announcedMask & (1 << i)) !== 0) continue; // 本局已提示过
        const entry = UNLOCKS[i]!;
        if (entry.condition.kind === COND_NONE) continue; // 收藏类无"达成瞬间",结算时自然入档
        if (!unlockMet(entry, live)) continue;
        announcedMask |= 1 << i;
        hud.toast(`解锁:${entry.name}`);
      }
    }
    // 残骸拾取:scrap 值爬升的那一帧响一声轻快高频叮(增量检测,首帧基准在 startRun 里已对齐,
    // 不会误触发;升级花掉残骸是下降,不响)
    if (world.scrap > lastScrap) audioBus.playCollect();
    stats.scrap = world.scrap;
    lastScrap = world.scrap;
    stats.upgrades = world.upgrades;
    stats.upgradeCost = world.upgradeCost;
    if (loop.tick - lastChecksumTick >= SIM_HZ) {
      stats.checksum = world.checksum();
      lastChecksumTick = loop.tick;
    }
  });
}

void boot();
