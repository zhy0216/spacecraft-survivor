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
 *
 * 存档改版起,**开跑前的那一屏也只在这一层**:页面载入不再直接开打,而是
 * 标题界面(继续 / 新航行 / 设置)→ startRun。两条入口最后都汇进
 * startRun 这一个装配点(读档多一条 restored 分支,见其参数),理由与首局/重开
 * 不许各写一份是同一条:装配漏接一样,要等真人走到那条入口才看得见。
 * 随机开局起,开局不再有任何选择步骤:起手两座塔由 world.rng 现抽(sim/loadout.ts),
 * 在 startRun 的非 restored 分支落地 —— 同 seed 同起手,retry 与读档都不重放。
 *
 * **存档时机也只在这一层**(sim/runSave.ts 只提供纯粹的 capture/restore,它不知道"何时"):
 * 一律挑**世界已经冻住的那些点** —— 升级时停 / 整备时停 / 暂停菜单 / 页面隐藏。
 * 帧中不存:那一刻 dead 闩没清、contacts 没结算,而快照不存这些字段的前提正是
 * "跨帧恒为初值"(runSave.ts 文件头第三类)。局终则反过来**删档**:
 * 一局打完还留着半局存档,下次进来那颗「继续」通向的是一场已经结束的战斗。
 */
import { FrameMeter } from './core/frameMeter';
import { Input } from './core/input';
import { FixedStepLoop, SIM_HZ } from './core/loop';
import { COND_NONE, unlockMet, UNLOCKS, type UnlockProgress } from './data/unlocks';
import { WAVE_MAX_ALIVE, WAVE_SEGMENTS } from './data/waves';
import { audioBus } from './render/audio';
import { bossWarnOnEnter, Renderer, SHIP_DEATH_FX_TIME } from './render/renderer';
import { applyRandomStart } from './sim/loadout';
import { evaluateRun, mergeProgress, type Progress } from './sim/progress';
import type { ShipCommand } from './sim/ship';
import { RESULT_LOSE, RESULT_WIN, World } from './sim/world';
import { canSaveRun, captureRun, digestRunSnapshot } from './sim/runSave';
import { createDebugPanel, type DebugStats, type RunState } from './ui/debugPanel';
import { createGameOverUi } from './ui/gameOver';
import { createHud } from './ui/hud';
import { loadIPressed, markIPressed } from './ui/keyHintStorage';
import { createArmoryPanel, type ArmoryPanelUi } from './ui/armoryPanel';
import { createPauseMenu, type PauseMenuUi } from './ui/pauseMenu';
import { loadProgress, saveProgress } from './ui/progressStorage';
import { createRefitFlow, type RefitFlowUi } from './ui/refitFlow';
import {
  clearRunSnapshot,
  loadRunSnapshot,
  loadRunWorld,
  saveRunSnapshot,
} from './ui/runSaveStorage';
import type { Settings } from './ui/settings';
import { createSettingsMenu } from './ui/settingsMenu';
import { applySettings, loadSettings, saveSettings } from './ui/settingsStorage';
import { createCodexUi } from './ui/codex';
import { createTitleScreen } from './ui/titleScreen';
import { createUpgradeFlow, type UpgradeFlowUi } from './ui/upgradeFlow';

const seed = Number(new URLSearchParams(location.search).get('seed') ?? '') || 20260801;

/**
 * 玩家模式 / 开发模式(畅玩性):URL 带 ?debug 时挂 Tweakpane 调参面板,
 * 否则挂玩家暂停菜单(Esc)并让 HUD/罗盘用到整条屏幕 —— 默认是玩家形态。
 * 标题随之切换:正式页签 "STARWRECK 星骸",开发模式追加 "· dev" 提醒自己在调参。
 */
const DEBUG = new URLSearchParams(location.search).has('debug');
if (DEBUG) document.title = 'STARWRECK 星骸 · dev';

/** 击杀 hitstop 的冻结时长(ms):40-60ms 的一记顿挫,再长就是卡顿(占位待调) */
const HITSTOP_MS = 45;

/** 段落横幅的存留秒数(26 号):3 秒够读完一行,到点由 hud 侧渐隐 */
const BANNER_SECONDS = 3;

/** I 键首局提示的时间窗(28 号):战斗开始后 20s 内飘一次,过了窗就不打扰 */
const I_HINT_WINDOW_SECONDS = 20;

async function boot(): Promise<void> {
  const input = new Input();
  // 玩家设置(音量/震屏/飘字/顿帧):**页载第一件事就读并生效** —— 静音的玩家不该
  // 在标题界面出现之前先被响一声。渲染层此刻还不存在,故先只灌音频那一半(applySettings
  // 收 renderer 可缺席),Renderer.create 之后再整份重灌一次(见下面那句)。
  // 它是整页唯一那一份设置(设置页与暂停菜单读的都是它),故是 let 而不是 const
  let settings: Settings = loadSettings();
  applySettings(settings);
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
  const cmd: ShipCommand = { desiredHeading: null, boost: false };

  // 这一局的世界与循环。两个都是 **let**:重开 = 换一个新 World + 一个新 FixedStepLoop
  // (World 不加 reset()/restart():池、rng、tick、槽位全是新的,才谈得上"同 seed 可复现";
  //  loop 同理,tick 是这一局的帧号,而 checksum 与面板读数全挂在它上面)。
  // 下面所有闭包(loop 的 step、ticker、结算回调)读的都是这两个变量本身,故换引用一次就够。
  let runIndex = 0;
  // 一局的流水号(畅玩性):startRun 每次 +1,沉船爆炸的延迟结算回调比对它 ——
  // 延迟期间重开过,旧局的结算作废(见 onGameOver 的 setTimeout 守卫)
  let runToken = 0;
  // **本局**的种子。restart 换种子时更新,retry(同 seed 重试)原样再用 ——
  // 没有它的话被特定波次组合打死后想"再试同一局"只能手改 URL ?seed= 刷新页面
  let runSeed = seed;
  // 首局标记:boot 里预建的 World 还没装配过 —— 「新航行」回调用它分辨"送预建 World"与"新建 World"
  let firstRun = true;
  // 元进度存档(19 号):页载时读一次,此后每局结算(onGameOver)写一次。
  // World 构造时注入 unlockMask(卡池过滤与解锁精英门控读它);掩码 0 = 全未解锁,首局就是这么起步的。
  // 局内不写 —— 解锁状态只在"一局结束"这一个点入档(progress.ts 的口径,见 onGameOver)
  let progress: Progress = loadProgress();
  // 首局的 World 得先建出来:Renderer.create 建层时就要读它的槽位。建完原样交给 startRun,
  // 于是**首局与重开走的是同一条装配流程** —— 两条路各写一份的话,重开那条永远会比首局少接一样东西
  let world = new World(runSeed, progress.unlockMask);
  // 首局先给 loop 一个初始值而不是留 undefined:首局的选择界面弹出时 ticker 已经挂上,
  // 它每帧都会读 loop(alpha/tick/advance),缺了这一个值首帧就崩 ——
  // 这个初始 loop 从不会被 advance(run.paused 挡着),startRun 会立刻用本局的替换掉它
  let loop: FixedStepLoop = new FixedStepLoop(() => world.step(cmd));
  const renderer = await Renderer.create(world);
  // 渲染层就位,把设置整份重灌一次 —— 这一次震屏强度与飘字开关才真的落到位
  applySettings(settings, renderer);

  // 战斗 HUD 同样整页只建一次:固定屏幕空间的血条/残骸/计时/航段与威胁箭头都只改已有 DOM。
  // 重开走 setWorld,升级时停与结算的淡出则每渲染帧照 run.paused 同步,不另挂事件监听器。
  // 放在升级/结算面板之前创建,后两者弹出时自然盖在它上面;HUD 本身 pointer-events:none。
  // rightGutter:玩家模式 0(罗盘/顶栏用到整条屏幕),开发模式 288(给 Tweakpane 让位)。
  // muted hooks(二轮审查):静音的**唯一真相源** = settings.muted —— HUD/暂停菜单/设置页
  // 三处都读写这一份,写即落盘 + 全量重灌(与 settingsMenu.onChange 同一条通道),
  // 不再存在"HUD 静音被设置页抹掉/不持久化"的状态分裂
  const mutedHooks = {
    get: (): boolean => settings.muted,
    set: (m: boolean): void => {
      settings = { ...settings, muted: m };
      saveSettings(settings);
      applySettings(settings, renderer);
    },
  };
  const hud = createHud({ world, rightGutter: DEBUG ? undefined : 0, debug: DEBUG, muted: mutedHooks });

  // hp / maxHp 初值直接取船的当前值:面板在第一帧渲染之前就该显示满血,而不是先闪一下 0。
  // 波次那几项同理取世界的当前值(createWaveState 已经按第 0 段 t=0 算好了方向与强度)
  // 帧率读数的统计窗(见 core/frameMeter.ts):**跨局复用**,与 tuning/stats 同一档 ——
  // 它量的是这台机器这一刻画得多快,不属于任何一局,重开不清窗
  const frameMeter = new FrameMeter();

  const stats: DebugStats = {
    fps: 0,
    frameMs: 0,
    worstMs: 0,
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
  // 选卡 → 点卡即结算(改版:槽位制没有"放置"这一阶段),时停期间的一切交互都在它那一侧;
  // 这里只负责"接线"。**只建一次**,重开只换它认的那个 World(见 upgradeFlow.setWorld):
  // 重建一份就等于每局多一份 window 监听器、多一块面板。
  // 类型标注不能省:onResolved 的闭包里回头引用了 upgradeFlow 自己,不标就是一处循环推导。
  const upgradeFlow: UpgradeFlowUi = createUpgradeFlow({
    world,
    // 这一次升级结算完了(点卡 / 跳过了):收卡、战斗继续。
    // **恢复战斗只有这一条路** —— World 与 ui 都不认识"游戏流程",run.paused 只在 main 这一层动
    onResolved: () => {
      upgradeFlow.hide();
      run.paused = false;
    },
  });

  // 每两分钟的航段整备：改版后只逛星币商店（买武器 / 法令 / 付费修复 / 刷新货架），
  // 新增/升级模块仍只走普通升级。
  const refitFlow: RefitFlowUi = createRefitFlow({
    world,
    onResolved: () => {
      refitFlow.hide();
      run.paused = false;
    },
  });

  // 结算界面同样**只建一次**(理由同上:每局多挂一份 Enter 监听器 = 一次回车重开好几局),
  // 重开走的是它的 show/hide。它不认识 World,只收一份纯数据 RunSummary
  // onTitle:局终之后回标题的出口。补的是流程死角 —— 玩家模式下 Esc 暂停菜单要求
  // `!run.paused`,而局终后 run.paused 恒真,没有这颗按钮就只剩重开两条路(见 gameOver.ts)。
  // 存档在 onGameOver 里已经删过,这里不必再管
  const gameOver = createGameOverUi({ onRestart: restart, onRetry: retry, onTitle: toTitle });

  // 调参面板/暂停菜单也只建一次:它们绑的是 stats/run/tuning 这几个**跨局复用**的对象,
  // 换 World 不换它们(读数由 startRun 复位、tuning 是玩家自己拖的旋钮,重开不该替他复原)。
  // 开发模式(?debug)挂 Tweakpane;玩家模式挂 Esc 暂停菜单 —— 战斗中的暂停/换局入口
  // 在玩家模式下只能从这里进,调试面板的暂停勾选与两个重开按钮玩家看不到(畅玩性)。
  // 暂停菜单的句柄:设置页关掉后要弹回它(战斗中开的设置该回暂停,不该回标题)。
  // 开发模式下没有暂停菜单(那边是 Tweakpane),故可空 —— settingsMenu 里用 `?.` 兜住
  let pauseMenu: PauseMenuUi | null = null;
  if (DEBUG) {
    createDebugPanel(stats, run, { restart, retry });
  } else {
    pauseMenu = createPauseMenu({
      muted: mutedHooks,
      canPause: () => !run.paused,
      onPause: () => {
        // 暂停 = 下一次 advance 被挡住;本次没有 step 回调在跑(回调只在 ticker 的
        // advance 里),不必 loop.halt() —— 与升级/结算时停同一套口径,只多一行
        run.paused = true;
        // 自动存档点之三:玩家主动暂停 = 最可能接着去干别的事的时刻。
        // 世界此刻已冻(上一句),正是干净的存档时机
        saveRun();
      },
      onResume: () => {
        run.paused = false;
      },
      onRestart: () => {
        // restart 直接开新局,菜单自己关掉即可
        restart();
      },
      onRetry: () => {
        retry();
      },
      // 设置页开在暂停菜单之上时,那一记 Esc 归设置页(见 pauseMenu.ts 的 blocked 注释)
      blocked: () => settingsMenu.visible(),
      onSettings: () => {
        pauseMenu?.hide(); // 纯收起,世界继续冻着(hide 不触发 onResume)
        settingsMenu.show();
      },
      onSaveAndQuit: () => {
        // 存不上就**原地留在暂停菜单里**(返回 false,由菜单当场改口报错):
        // 此刻退出会静默丢掉这一局,而玩家点这颗按钮的全部意图恰恰是"别丢"
        if (!saveRun()) return false;
        pauseMenu?.hide();
        toTitle();
        return true;
      },
    });
  }

  /**
   * 武器布局面板(按 I)。与暂停菜单同一条时停口径:面板自己不动 loop,
   * 冻结/恢复由这里的两个回调执行。**开发模式下也建**:换位是玩法而不是调试工具,
   * 没有理由让它跟着 Tweakpane 一起消失。
   * blocked:暂停菜单/设置页开着时那一记 I / Esc 归它们(理由见 armoryPanel 的 blocked)。
   */
  const armoryPanel: ArmoryPanelUi = createArmoryPanel({
    canOpen: () => runActive && !run.paused,
    onOpen: () => {
      // 与弹卡那一处一字同源:run.paused 挡住下一次 advance,loop.halt() 让**本次**
      // advance 当场停手并丢掉剩余累积时间(否则这一帧还会补跑最多 4 步 = 时停"漏"了 66ms)
      run.paused = true;
      loop.halt();
      hud.setPaused(true);
      // I 键首局提示(28 号):面板真的开出来了 = 玩家按过了 I,永久不再飘 —— 顺手落盘
      markIPressed();
      ipressed = true;
    },
    onClose: () => {
      run.paused = false;
      hud.setPaused(false);
    },
    blocked: () => settingsMenu.visible() || (pauseMenu?.visible() ?? false),
  });

  /**
   * 这一局跑起来了没有。**存档的总闸**:boot 里那个预建的 World(标题界面背景里那艘
   * 没出港的船)也是一个合法的、result === RUNNING 的世界,canSaveRun 会痛快地放行 ——
   * 于是玩家在标题界面切一下浏览器标签,就会被存进一份 0 帧的"存档",
   * 而它长得跟真存档一模一样,下次进来那颗「继续」通向的是一局根本没打过的仗。
   * startRun 置真,局终与回标题置假。
   */
  let runActive = false;

  let lastChecksumTick = -SIM_HZ;
  // 残骸拾取音的增量检测基准:跟上一次读到的 scrap 比,值爬升的那一帧响一声叮(见 ticker)
  let lastScrap = 0;
  // 击杀 hitstop(畅玩性):上一帧已消费的击杀数(与 lastScrap 同一条增量检测写法)与
  // 冻结截止的墙钟时刻 —— performance.now() < hitstopUntil 时跳过 loop.advance(见 ticker)
  let lastKills = 0;
  let hitstopUntil = 0;
  // 加速技能音效的沿检测基准(与 lastScrap 同一条增量检测写法):boostTime 从 0 变正的
  // 那一帧 = 触发帧,响一声推进器点火;窗内持续为真不重复响
  let lastBoostActive = false;
  // Boss 战横幅(26 号)的沿检测基准:bossPhase 从别的值翻进 1 的那一帧弹「封锁线接敌」。
  // 判据与渲染层出场音同一条 bossWarnOnEnter(见 renderer.syncBossWarn);换局在 startRun
  // 按新世界现值对齐 —— 读档直接落在 Boss 战里不重弹
  let bossPhaseSeen = 0;
  // 本局已 toast 过的解锁位掩码(19 号):与 progress.unlockMask 同编码。局内检测跨过阈值
  // 就置位,防止同一局里"300 杀达标"这类条件每帧弹一次 —— 置位过的不再重复提示
  let announcedMask = 0;
  // I 键首局提示(28 号):"按过一次 I 就永久不再飘"的永久标记来自 localStorage
  // (见 ui/keyHintStorage.ts,不进 sim、不进存档),"本局已飘过"则是 main 层的一个 let ——
  // 提示是本局一次性的,不落盘。ipressed 页载时读一次,面板开过就地置真 + 落盘
  let ipressed = loadIPressed();
  let keyHintShown = false;
  // 磁吸宝物首拾提示(二轮审查):金色宝物 = 精英掉落,拾起 = 2 秒全场磁吸 —— 全 UI 没有任何
  // 解释,玩家首见只会当它是又一种残骸。每局第一次涌置位时走解锁 toast 通道提示一次;
  // "本局已飘过"是 main 层的一个 let(与 keyHintShown 同一条口径),换局清零
  let magnetToastShown = false;
  // 本局开跑的 world.elapsed 基准(秒):20s 窗口按它与当前 elapsed 的差算,
  // 读档进来的世界 elapsed 不为 0,窗口照样从"这一局开跑"起算
  let battleStartElapsed = 0;

  /**
   * 存一次档。**只在世界冻着的那些点调用**(升级/整备时停、暂停菜单、页面隐藏) ——
   * 帧中存会捞到 dead 闩没清的半帧状态,而快照不存那些字段的前提正是"跨帧恒为初值"
   * (sim/runSave.ts 文件头第三类)。
   *
   * 三道闸各挡一种"存了等于害人"的情况:没跑起来的局(runActive)、已分胜负或已沉船的局
   * (canSaveRun)、以及存储本身不可用(saveRunSnapshot 返回 false)。
   * @returns 真的存上了没有 —— 暂停菜单的「保存并退出」据此决定是退出还是当场改口报错
   */
  function saveRun(): boolean {
    if (!runActive || !canSaveRun(world)) return false;
    return saveRunSnapshot(captureRun(world, { seed: runSeed }));
  }

  /**
   * 装配一局。首局与重开走的是同一条路,顺序有讲究:
   * 先换 world/loop 与挂钩(它们是这一局的本体),再把吃 World 引用的地方指过去
   * (渲染层的脏标记缓存 / 升级流程认的甲板 / HUD 读数 / 结算界面收起来),最后复位调试读数。
   * 漏一样的后果各不相同、但都要等真人重开第二局才看得见:
   * 渲染层留着上一局的脏标记 → 新船上还画着上一局的塔;
   * 升级流程留着旧 world → 点下去落进上一局那艘沉船,画面上什么都不发生;
   * 面板读数不复位 → checksum/tick 还挂在上一局的数上,"同 seed 可复现"当场没法验。
   */
  function startRun(next: World, restored = false): void {
    // 一局的流水号(畅玩性,沉船爆炸的延迟结算用):换一局就 +1 —— 延迟回调里比对它,
    // 期间重开过的旧局结算直接作废,不会在"新一局"头上弹"上一局"的卡片
    runToken++;
    world = next;
    // 正式开局才套随机起手。**不放进 World 构造函数**:规则单测与纯 sim 调用方需要空槽位,
    // 而「这一局怎么开场」是 sim/loadout.ts 的随机装配 —— 从 world.rng 派生,同 seed 必同起手。
    //
    // **读档进来的世界一律跳过这一句**(restored):它的槽位是存档里那一份 ——
    // 再套一遍随机起手就是把玩家半局攒下的武器覆盖回开局那两门炮,而盘面看着还挺正常
    // (船在、怪在、时间也对),是读档最惨烈也最难自查的一种失败
    if (!restored) applyRandomStart(world);
    loop = new FixedStepLoop(() => {
      // 必须在每个逻辑帧边界重新取样:一帧一采才让"按住 A 的时长"精确对应转过的角度,
      // 掉帧补步时也照样一步一次,手感不随渲染帧率漂移。
      // 读的是外层那个 let world —— 每局都新建 loop,而 startRun 已经先把它换成本局这个了
      cmd.desiredHeading = input.desiredHeading();
      // 加速键与方向同一条采样纪律:触发裁决(冷却)在 World.step,这里只报"按没按着"
      cmd.boost = input.isDown('Space');
      world.step(cmd);
    });
    // 帧号对齐到世界的(新局恒 0,读档接着存档那一刻往下数):loop.tick 是面板与
    // checksum 节流的游标,让它从 0 重数的话,读档后面板上的 tick 会与世界的 elapsed
    // 差出整整一局 —— 而那个数正是核对确定性时唯一会被人盯着看的读数
    loop.tick = world.tick;

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
      armoryPanel.hide();
      // 局终 = 删半局存档。留着它的话下次进标题那颗「继续」通向一场**已经结束**的战斗
      // (读进去 result 早已落定,settleOutcome 的结论永不再变,当场又弹一次结算)。
      // 排在结算之前:结算界面可能被延迟 SHIP_DEATH_FX_TIME 秒才弹,而"这一局结束了"
      // 在此刻就已经是事实,删档不该等演出
      runActive = false;
      clearRunSnapshot();
      // 剪影在渲染层只截一次,元进度与结算界面共用同一张(渲染层抓不到就是 null,此时不入图鉴)
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
      // 武器战报快照:从 world.runDamageByType 摘"真打出过伤害"的型、按伤害降序 ——
      // 显示层(weaponReportRows)只管排版,排序口径在摘数的这一处定死。
      // 一局一次的分配,不在铁律 3 管的热路径上
      const weaponReport: { type: number; damage: number }[] = [];
      for (let i = 0; i < world.runDamageByType.length; i++) {
        const damage = world.runDamageByType[i]!;
        if (damage > 0) weaponReport.push({ type: i, damage });
      }
      weaponReport.sort((a, b) => b.damage - a.damage);
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
        // 武器战报(上面刚摘的快照)+ 本局峰值总 DPS:结算界面的输出占比条读它们
        weaponReport,
        peakDps: world.peakDps,
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
    // 不 halt 的话这一帧还会补跑最多 4 步 = 时停"漏"了 66ms)。World 自己不暂停、不动 loop
    // —— 它连"这一局要不要停"都不知道。回调只在候选生成那一帧响一次,故这里不必自己去重
    world.onUpgradeOffer = () => {
      run.paused = true;
      loop.halt();
      upgradeFlow.show();
      // 自动存档点之一。挑这里而不是"每隔 N 秒存一次":世界此刻已经被上面两句冻住,
      // 而定时存档必然落在帧中(见 saveRun 的口径)。三选一大约每分钟弹一次,
      // 密度正好 —— 意外关页面最多丢一次升级的进度。
      // **必须排在 halt 之后**:不然存下来的是"这一帧还没停稳"的世界
      saveRun();
    };

    // 航段跨过两分钟边界后，World 已经停住下一段的出怪；这里负责把当前固定步当场截住，
    // 并切到独立整备界面。普通升级即使同帧够钱也会被 World 延后，不会叠两层时停。
    // 商店信标生成(每跨一个航段一次):世界**不停**,玩家自己决定去不去接 ——
    // 这里只播一声提示,信标本体由渲染层画、倒计时由 HUD 报
    world.onShopBeacon = (segment) => {
      audioBus.playEliteWarn();
      // 段落收束横幅(26 号):segment 是跨段后**新航段**的下标(0-based),跨进 index N
      // 即"航段 N 刚肃清" —— 与 HUD 航段读数的 1-based 显示一字对齐(segmentReadout 印 index+1)。
      // 第 4 段走完 wave.done,信标不生成、此回调不响,收束由 Boss 战那条横幅接棒(见 ticker)
      hud.showBanner(`航段 ${segment} 肃清 · 补给信标已投放`, BANNER_SECONDS);
    };

    world.onRefitOffer = (segmentIndex) => {
      run.paused = true;
      loop.halt();
      refitFlow.show(segmentIndex);
      // 自动存档点之二(理由同 onUpgradeOffer)。航段整备是这一局最像"关卡边界"的地方,
      // 每两分钟一次 —— 玩家心里的"存档点"多半就是这里
      saveRun();
    };

    // 吃 World 引用的地方(渲染层的脏标记缓存 / 升级流程 / HUD),各自的理由见它们自己那边。
    // setWorld 会把上一局那张还开着的卡片一并收掉,但**不恢复战斗** —— 那一步在下面的 run.paused
    renderer.setWorld(world);
    upgradeFlow.setWorld(world);
    refitFlow.setWorld(world);
    armoryPanel.setWorld(world);
    armoryPanel.hide(); // 上一局那张还开着的布局面板一并收掉(与 setWorld 同一条理由)
    hud.setWorld(world);
    gameOver.hide();

    // UI 读数复位。**不动 tuning、不动 run.timeScale**:
    // 那些是玩家自己拖出来的调参状态,重开一局不该顺手替他复原
    // 读数一律**从新世界现读**而不是写死 0:新局那些值本来就是 0,而读档进来的世界
    // 带着半局的账(击杀 300、残骸 40)—— 写死 0 的话面板会先报一屏假读数,
    // 更要命的是下面两个增量基准会以为"这一帧刚杀了 300 只"
    stats.tick = world.tick;
    stats.checksum = '—';
    stats.hp = world.ship.hp;
    stats.maxHp = world.ship.maxHp;
    stats.turnRate = world.turnRate;
    stats.seed = runSeed;
    stats.kills = world.kills;
    stats.scrap = world.scrap;
    // 新局基准 = 新世界的 scrap(新局 0 / 读档是存档那一刻的余额):首帧增量检测零出发,
    // 不会误响拾取音
    lastScrap = world.scrap;
    // hitstop 的增量基准与冻结窗同样属于上一局:换局对齐到新世界、冻结窗清零。
    // **基准取 world.kills 而不是 0**:读档时它是几百,留 0 的话首帧就会被判成"刚刚连杀",
    // 玩家一进游戏先吃一记莫名其妙的顿帧
    lastKills = world.kills;
    hitstopUntil = 0;
    // Boss 战横幅的沿检测基准同属上一局:按新世界现值对齐(bossPhase 0→1→2 单调,同局只进战一次)
    bossPhaseSeen = world.bossPhase;
    // 加速音效的沿检测基准同属上一局:新世界 boostTime 必然是 0,基准清回 false 对齐
    lastBoostActive = false;
    // 局内解锁 toast 的"已提示"记性也只属于这一局:换局清零(已开锁的位由掩码本身挡住,不会重弹)
    announcedMask = 0;
    // I 键首局提示的"本局已飘过"记性同属这一局:换局清零、20s 窗重新起算
    // (永久标记在 localStorage 那侧,不受换局影响)
    keyHintShown = false;
    // 磁吸宝物首拾提示的记性也同属这一局:换局清零(读档进来已置过涌的也不重飘 ——
    // 沿检测看的是"翻正那一帧",存量涌不会触发)
    magnetToastShown = false;
    battleStartElapsed = world.elapsed;
    stats.upgrades = world.upgrades;
    stats.upgradeCost = world.upgradeCost;
    stats.segment = world.wave.segment;
    stats.segTime = world.wave.segTime;
    // checksum 每秒才算一次(见 ticker),游标推回负一秒 = 新局第一帧就出第一个值 ——
    // 不推的话,重开后的头一秒面板上挂的还是上一局最后那个哈希,而那正是最容易看错的一个数
    lastChecksumTick = -SIM_HZ;
    run.paused = false;
    // 上一局若停在升级/结算态,HUD 此刻仍是淡出的;新局装配完成就当场恢复,不等首个 ticker。
    hud.setPaused(false);
    // 这一局开始接受存档(见 runActive 的声明):标题界面上那个预建的空世界不算一局
    runActive = true;
    // 开一局**新的**就把旧存档删掉:那份快照指向的是一场此后再也回不去的航行,
    // 留着它只会让下次进标题时那颗「继续」通向一局玩家已经亲手放弃过的战斗。
    // 读档进来的这一局反过来不删 —— 它本来就是那份存档
    if (!restored) clearRunSnapshot();

    // 读档回到一个**停在时停里**的世界:升级三选一与航段整备恰恰是最自然的存档点
    // (世界本来就冻着,main 也正是在那两处存的档)。此时不能直接恢复战斗 ——
    // 候选卡还挂在 world.offer 上没结算,直接开跑就是"卡片凭空消失、这一次升级白欠"。
    // 判据取世界自己的字段而不是另存一个 UI 状态位:offer 与 refitPending 都进 checksum,
    // 它们就是"这一局欠玩家一次选择"的唯一真相,而 UI 状态位存了还会与它们打架
    if (restored) {
      if (world.refitPending) {
        run.paused = true;
        refitFlow.show(world.wave.segment);
      } else if (world.offer.length > 0) {
        run.paused = true;
        upgradeFlow.show();
      }
      hud.setPaused(run.paused);
    }

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
      armoryPanel,
      hud,
      gameOver,
      titleScreen,
      settingsMenu,
      codex,
      restart,
      retry,
      // 存档一路都能在控制台里手验:__game.saveRun() 存一次、__game.toTitle() 回标题
      // 看那颗「继续」在不在、__game.clearRunSnapshot() 清档复现"新玩家第一次进游戏"
      saveRun,
      toTitle,
      clearRunSnapshot,
    };
  }

  /**
   * 「再来一局」的换种子入口(结算界面的按钮/Enter 与调参面板的重开按钮共用)。
   * 种子 = seed + 局数:`?seed=` 仍然能复现**第一局**(01 号的确定性口径),
   * 而重开不会每局一模一样 —— 同一份怪潮打第二遍就没什么可玩的了。
   * 起手由新种子现抽(applyRandomStart 读 world.rng),不需要任何选择步骤。
   * 函数声明(而不是 const)是为了给上面的 createGameOverUi / createDebugPanel 提前引用:
   * 这两个面板都只建一次,而它们建的时候这一局还没开始装配。
   */
  function restart(): void {
    runIndex++;
    runSeed = seed + runIndex;
    startRun(new World(runSeed, progress.unlockMask));
  }

  /**
   * 「再试这一局」的同 seed 入口(畅玩性调整):runSeed 不动、runIndex 不消耗。
   * 新 World 拿到的就是刚打完那一局的种子 —— 随机起手从同一条 rng 序列派生,
   * 连起手一起原样重来(起手与波次同源:都是 seed 的函数)。确定性口径
   * ("同 seed + 同输入 → 同轨迹")天然支撑它:35s 侧压从哪边来、哪一段最凶,
   * 死过一次就都是可用的知识。
   * 它同时修复了调参面板那条"验不了同 seed 可复现"的遗留(面板现在两个按钮都有)。
   */
  function retry(): void {
    startRun(new World(runSeed, progress.unlockMask));
  }

  /**
   * 回标题界面。**存档在调用之前由调用方决定存不存** —— 「保存并退出」先存再回,
   * 而局终是删档后回:两条路对存档的处置正好相反,故不塞进本函数。
   * 世界继续冻着(run.paused 恒真):标题界面背后那张静止的战场就是刚才那一局,
   * 直到玩家挑好下一条路才被换掉。
   */
  function toTitle(): void {
    runActive = false;
    run.paused = true;
    gameOver.hide();
    upgradeFlow.hide();
    refitFlow.hide();
    armoryPanel.hide();
    titleScreen.show(titleDigest());
  }

  /**
   * 此刻有没有可继续的存档。**每次都重读 localStorage** 而不是缓存一个布尔:
   * 刚才那一步可能刚存下一份(保存并退出)、也可能刚把它删掉(局终),
   * 读一次现成的好过在调用点各自推断"现在应该有没有档"—— 那种推断错一处,
   * 症状就是标题界面上多出/少掉一颗「继续」,而它恰恰是最要命的那颗按钮
   */
  function titleDigest(): ReturnType<typeof digestRunSnapshot> | null {
    const snap = loadRunSnapshot();
    return snap === null ? null : digestRunSnapshot(snap);
  }

  // 设置页:**整页只建一次、标题与暂停两个入口共用**(见 ui/settingsMenu.ts 文件头)。
  // 改一项就落盘 + 整份重灌到各落点 —— 没有"改了没保存"的中间态。
  // onClose 要回哪去由**这里**记(设置页自己不知道是谁弹的它):战斗中开的就弹回暂停菜单,
  // 否则回标题 —— 判据取 runActive 而不是"上次谁调的 show",少一个必须两处同步的状态位
  const settingsMenu = createSettingsMenu({
    get: () => settings,
    onChange: (next) => {
      settings = next;
      saveSettings(settings);
      applySettings(settings, renderer);
    },
    onClose: () => {
      if (runActive) pauseMenu?.show();
      else titleScreen.show(titleDigest());
    },
  });

  /**
   * 图鉴页(ui/codex.ts):**整页只建一次**,只从标题进 —— 每局结算后 progress 已更新,
   * getProgress 每次 show 现读,标题那颗「图鉴」点开就是最新的一份。onClose 只回标题:
   * 与设置页不同,它没有"战斗中开"的那条来路,不需要 runActive 分岔(入口只此一处)。
   */
  const codex = createCodexUi({
    getProgress: () => progress,
    onClose: () => {
      titleScreen.show(titleDigest());
    },
  });

  /**
   * 标题界面(进游戏的第一屏)。四条出口:
   *   继续 —— 读档建世界,走 startRun 的 restored 分支(**不重放起手**);
   *   新航行 —— 直接开新局(首局送预建 World,之后换种子新建);
   *   设置 —— 收起自己弹设置页,关掉后由 onClose 弹回来;
   *   图鉴 —— 收起自己弹图鉴页(与设置同一条让路)。
   * 读档失败(存档损坏 / 存储不可用)不弹错误框,直接退回"没有存档"的标题:
   * loadRunWorld 已经把读不出来的档删掉了,玩家再点一次就是一颗干净的「开始航行」
   */
  const titleScreen = createTitleScreen({
    onContinue: () => {
      const loaded = loadRunWorld();
      if (loaded === null) {
        titleScreen.show(null);
        return;
      }
      // 存档里带着种子:不接回来的话,读档后再点「再试一局」会用标题界面那个默认种子重开
      // —— 那是另一局(起手由种子派生,读档这局的随机起手已经长在槽位里,不需要额外状态)
      runSeed = loaded.snapshot.seed;
      firstRun = false; // 预建的那个空 World 就此作废,重开走"新建"那条
      startRun(loaded.world, true);
    },
    onNewRun: () => {
      if (firstRun) {
        firstRun = false;
        startRun(world); // 首局送 boot 里预建、渲染层已按其槽位建好层的那个 World
      } else {
        restart(); // 换种子直接开新局,起手由新种子现抽
      }
    },
    onSettings: () => {
      titleScreen.hide();
      settingsMenu.show();
    },
    onCodex: () => {
      titleScreen.hide();
      codex.show();
    },
  });

  // 进游戏第一屏:标题界面(继续 / 新航行 / 设置),而不是直接开打。
  // 「新航行」直接开新局(随机起手在 startRun 落地),不再有独立的起手选择一步。
  // **先冻结再弹**:此刻 ticker 已挂上(见 boot 末尾),run.paused 挡住 loop.advance,
  // 标题期间世界停在首帧,开跑由 startRun 收尾时一并恢复
  run.paused = true;
  toTitle();

  // 页面隐藏时自动存档(切标签页 / 切到后台 / 关页面)。**用 visibilitychange 而不是
  // beforeunload**:移动端与现代浏览器的标签页回收根本不保证触发 beforeunload,
  // 而 visibilitychange→hidden 是官方推荐的"最后一次可靠机会"。
  // pagehide 再兜一道(桌面端直接关窗时更稳)。两条路都只是再存一次同一份快照,
  // 重复存不产生任何副作用(saveRun 是幂等的纯读 + 覆盖写)。
  // 时停/暂停期间照存:世界冻着,正是最干净的存档时机
  const saveOnLeave = (): void => {
    saveRun();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveOnLeave();
  });
  window.addEventListener('pagehide', saveOnLeave);

  renderer.app.ticker.add((ticker) => {
    // 击杀 hitstop(畅玩性):击杀数爬升的那一帧立一个 ~50ms 的冻结窗。
    // 窗内跳过 loop.advance —— 世界冻住、画面冻住,就是那一记"顿一下"的打击感;
    // sync/HUD 照常跑(表现层自持的飘字/震屏/爆炸不受影响)。**时停/结算期间不触发**:
    // 那两个状态 run.paused = true,世界本来就不动,再立冻结窗只会把恢复战斗的时间点往后推。
    // 封顶两道:同帧多杀(kills 一次跳 N)只算一次(增量检测);冻结窗内再杀不续窗
    // (`>= hitstopUntil` 挡住了) —— 8 杀/秒也不会变成永久慢动作
    // settings.hitstop 是玩家的开关(ui/settings.ts):关掉后**一个冻结窗都不立**,
    // 而不是立了再跳过 —— 后者会让 hitstopUntil 一直挂着未来的时刻,拨回来时还要等它过期
    if (
      settings.hitstop &&
      !run.paused &&
      world.kills > lastKills &&
      performance.now() >= hitstopUntil
    ) {
      hitstopUntil = performance.now() + HITSTOP_MS;
    }
    lastKills = world.kills;
    // 结算弹出后 run.paused = true,于是这一句不再推进 sim,世界冻在结算那一帧上;
    // 下面的 sync 照常跑 —— 结算界面背后是一张静止的战场,而不是黑屏。
    // hitstop 冻结同理:窗内跳过 advance,世界停在击杀那一帧,插值 alpha 也停住 = 画面定格
    if (!run.paused && performance.now() >= hitstopUntil) loop.advance(ticker.elapsedMS * run.timeScale);
    // 按住 Tab 叠加显示各武器槽射界(GDD §4.2:**按住**,不是 toggle,所以这里每帧灌"此刻是否按着"
    // 而不是监听一次按键事件)。按渲染帧采样即可 —— 它纯是可视化开关,不进 World.step,
    // 也就不参与确定性回放;放在 sync 之前是为了同一帧内先定开关再画,不留一帧迟滞。
    renderer.setArcOverlay(input.isDown('Tab'));
    renderer.sync(loop.alpha);
    // HUD 固定在 DOM 屏幕空间,不读敌人容器、也不随相机/船体变换。时停(升级或结算)先淡出,
    // 再同步静止世界的最后一帧读数;重开时 hud.setWorld 已换到新引用,不会重复 append 节点。
    hud.setPaused(run.paused);
    hud.sync();

    // 帧率读数(只喂 ?debug 面板,不进 checksum、不参与确定性)。喂进去的是 ticker.elapsedMS ——
    // Pixi 那个**未夹取**的真实帧间隔(它只夹 deltaMS,见 Ticker.update),所以掉帧不会被
    // minFPS 的 100ms 上限磨平;代价是切标签页回来会送进一个几秒的"帧",由 FrameMeter 当断点挡掉。
    // 不读 ticker.FPS 的理由见 core/frameMeter.ts 文件头:那是单帧瞬时值,面板上只会乱跳
    frameMeter.push(ticker.elapsedMS);
    stats.fps = frameMeter.fps;
    stats.frameMs = frameMeter.frameMs;
    stats.worstMs = frameMeter.worstMs;
    stats.enemies = world.enemies.size;
    // 音乐威胁强度:存活敌人数 ÷ WAVE_MAX_ALIVE(同屏保险丝上限)→ 0..1 密度比。
    // Boss 在场时怪可能很少,配乐仍需保持压力 —— 取密度比与 0.35 的较大者。
    // setAmbience 会平滑调整 genmedia 背景音乐的音量/低通开度,便宜到可以每帧灌。
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
    // 上限每帧现读(改版 06 号):它是支援槽的派生量,买下装甲舱当帧 +15 ——
    // 这个数跳一下就是它生效的肉眼落点
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
      // I 键首局提示(28 号):战斗开始 20s 内,从未按过 I 且本局还没飘过 → 走解锁 toast
      // 通道飘一条「按 I 可调整武器朝向」。窗口按 world.elapsed 与开跑基准的差算
      // (读档进来的世界口径不变);时停期间不查 —— 世界不动,窗口不缩,恢复后接着等
      if (
        !keyHintShown &&
        !ipressed &&
        world.elapsed - battleStartElapsed <= I_HINT_WINDOW_SECONDS
      ) {
        keyHintShown = true;
        hud.toast('按 I 可调整武器朝向');
      }
    }
    // 加速技能触发:boostTime 从 0 变正的那一帧响推进器点火(沿检测,窗内不重复响)
    const boostActive = world.boostTime > 0;
    if (boostActive && !lastBoostActive) audioBus.playBoost();
    lastBoostActive = boostActive;
    // 磁吸宝物首拾提示(二轮审查):magnetSurgeTime 翻正的那一帧 = 玩家刚拾起精英掉落的
    // 金色宝物,走解锁 toast 通道解释一次"这是什么" —— 时停中世界不动,不会误触发
    if (!magnetToastShown && world.magnetSurgeTime > 0) {
      magnetToastShown = true;
      hud.toast('磁吸风暴:残骸自动飞向你 2 秒');
    }
    // Boss 战横幅(26 号):bossPhase 翻进 1 的那一帧弹「封锁线接敌」,与出场音同一套
    // bossWarnOnEnter 判据;基准在 startRun 按新世界现值对齐
    if (world.bossPhase !== bossPhaseSeen) {
      if (bossWarnOnEnter(bossPhaseSeen, world.bossPhase)) {
        hud.showBanner('封锁线接敌', BANNER_SECONDS);
      }
      bossPhaseSeen = world.bossPhase;
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
