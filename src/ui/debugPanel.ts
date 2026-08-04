/**
 * Tweakpane 调参面板(DOM 覆盖层)。
 * 服务两件事:01 号 issue 的压测读数,02 号 issue 的手感热调(改了立刻体感对比)。
 *
 * 08 号 issue 起还多服务一件:波次脚本的**量化读数**(航段 / 主压方向 / 强度)。
 * 11 号已有常驻 HUD 与威胁罗盘；这里仍保留精确数值，供调参与核对实际出怪统计。
 */
import { Pane } from 'tweakpane';
import { WAVE_SEGMENTS } from '../data/waves';
import { tuning } from '../sim/config';
import { segmentLabel } from './gameOver';

export interface DebugStats {
  fps: number;
  /** 存活敌数 = 池里 items.length,与滑杆设定的目标值区分开 —— fps 读数得配它才有意义 */
  enemies: number;
  bullets: number;
  speed: number; // 船速 px/s,用来确认巡航参数改动真的生效
  /** 扩建惩罚后的实际转向速率(°/s)。 */
  turnRate: number;
  /**
   * 船体 HP(09 号 issue)。正式 HUD 给状态读数；这个只读数保留更多精度，
   * 用来量化对比撞击伤害倍率 / 无敌帧等调参效果。
   */
  hp: number;
  /**
   * 船体 HP 上限(06 号 issue)。它**不是** tuning.shipHullHp,而是甲板的派生量:
   * 基础值 + 每块装甲舱 +15(见 sim/damage.hullMaxHp),World 每逻辑帧重刷一次。
   * 单独占一条只读项的理由:装甲舱是四种支援设施里唯一**不画邻接连线**的那种
   * (它不作用于相邻塔),放下去之后画面上除了格子换色什么都不会变 ——
   * 这个数跳 +15 就是"装甲舱真的生效了"唯一的肉眼落点(06 号验收标准第三条)。
   */
  maxHp: number;
  tick: number;
  checksum: string;
  seed: number;
  /**
   * 当前航段**下标**(world.wave.segment),显示时才 +1 —— 换算与"走完那一刻"的措辞
   * 共用 ui/gameOver.ts 的 segmentLabel:面板与结算界面报的"航段进度"必须是同一句话,
   * 各写各的迟早会在越界值(segment == 段数)上分家,印出一个 "5/4" 来。
   */
  segment: number;
  /** 段内已过秒数。它与 segment 合起来才读得出"这一段走到哪儿了" */
  segTime: number;
  /**
   * 主压方向(**度**,世界系绝对角,已折回 [0,360))。sim 里是弧度,换算在 main.ts ——
   * 面板是给人读的,而数据表(src/data/waves.ts)里写的也是度,两边对得上才好核对脚本。
   * **绝对角不是相对船头的角**:玩家转舵这个数一动不动,才说明"最优舷"真的会随时间漂移(GDD §6.3)。
   */
  threatDeg: number;
  /** 实际主压强度(只/秒)= 成功生成事件的平滑速率；burst 计入，被在场上限丢弃的请求不计 */
  threatRate: number;
  /** 累计击杀。结算界面报的是同一个数(见 ui/gameOver.ts 的 RunSummary),这里能中途看它爬 */
  kills: number;
  /** 已收集、未花掉的残骸(10 号 issue)。三选一卡片与这里读的是同一笔 World.scrap */
  scrap: number;
  /** 已结算升级次数(放置成功或跳过都算一次),也是下一次费用曲线的级数 */
  upgrades: number;
  /** 下一次升级所需残骸 = data/economy.upgradeCost(upgrades),World 的派生读数 */
  upgradeCost: number;
}

export interface RunState {
  paused: boolean;
  timeScale: number;
}

/**
 * 面板要触发的流程动作。**面板不认识 World、不动 loop**:重开那一整套
 * (新 World + 新 loop + renderer.setWorld + upgradeFlow.setWorld + UI 复位)只在 main.ts 一处,
 * 这里与结算界面的「再来一局」按钮走的是同一个入口(理由见 ui/gameOver.ts 的 onRestart)。
 */
export interface RunHooks {
  restart(): void;
}

export function createDebugPanel(stats: DebugStats, run: RunState, hooks: RunHooks): void {
  const pane = new Pane({ title: 'STARWRECK · 灰盒调参' });

  const perf = pane.addFolder({ title: '性能 / 确定性' });
  perf.addBinding(stats, 'fps', { readonly: true, interval: 200, format: (v: number) => v.toFixed(0) });
  perf.addBinding(stats, 'enemies', { label: '敌(存活)', readonly: true, interval: 200, format: (v: number) => String(Math.round(v)) });
  // 05 号起这是**塔真的打出来的弹**(不再有凭空重生的压测哑弹),故它同时是"500 弹不掉帧"
  // 那条验收的读数:它爬到 500 上下时 fps 还稳,才算数
  perf.addBinding(stats, 'bullets', { label: '弹(存活)', readonly: true, interval: 200, format: (v: number) => String(Math.round(v)) });
  // 拖巡航滑杆时盯这个数:它爬到新的上限,才算"参数改动无需重启即可体感对比"落实了
  perf.addBinding(stats, 'speed', { label: '船速 px/s', readonly: true, interval: 200, format: (v: number) => String(Math.round(v)) });
  perf.addBinding(stats, 'turnRate', { label: '实际转向 °/s', readonly: true, interval: 200, format: (v: number) => v.toFixed(0) });
  perf.addBinding(stats, 'tick', { readonly: true, interval: 200, format: (v: number) => String(Math.round(v)) });
  perf.addBinding(stats, 'checksum', { readonly: true, interval: 500 });
  perf.addBinding(stats, 'seed', { readonly: true, format: (v: number) => String(v) });

  const runF = pane.addFolder({ title: '运行' });
  runF.addBinding(run, 'paused', { label: '暂停' });
  runF.addBinding(run, 'timeScale', { label: '时间倍率', min: 0.1, max: 3, step: 0.1 });
  // 出怪走哪条路(08 号 issue):关 = 正式的波次脚本(有航段、有主压方向、走完就是胜利),
  // 开 = 回到 01 号那条"场上恒定 N 只"的压测路 —— 那条路**整段旁路波次运行器**:
  // 方向不转、脚本不推进、永远走不完,故本局也就不再有胜利条件。
  // label 得把这两件事都说出来:只写"压测出怪"的话,打开它等一局的人会以为脚本卡住了
  runF.addBinding(tuning, 'stressSpawn', { label: '压测出怪(旁路波次脚本,本局无胜利)' });
  // 重开与结算界面的「再来一局」是同一个入口(见 RunHooks):打歪了想重来时,
  // 不必先把自己撞沉一次。注意它**换种子**(seed + runIndex),所以验不了"同 seed 可复现" ——
  // 那件事只能带 ?seed= 刷新页面,别指望这个按钮
  runF.addButton({ title: '重开本局(换种子)' }).on('click', () => hooks.restart());

  // 波次脚本读数(08 号 issue)。全是只读:脚本本身在 src/data/waves.ts,改那张表即可调节奏
  //(08 号验收:改数据文件就能调,不改代码)—— 面板不该开第二个入口去改这一局的进度。
  // 默认展开:与常驻 HUD 同源，但保留小数精度，便于核对脚本与实际生成是否一致。
  const wave = pane.addFolder({ title: '波次(08)', expanded: true });
  // 与结算界面共用 segmentLabel:走完时它报的是 "4/4(全通)" 而不是 "5/4"(segment 是越界值)
  wave.addBinding(stats, 'segment', {
    label: '航段',
    readonly: true,
    interval: 200,
    format: (v: number) => segmentLabel(Math.round(v), WAVE_SEGMENTS.length),
  });
  wave.addBinding(stats, 'segTime', { label: '段内 s', readonly: true, interval: 200, format: (v: number) => v.toFixed(1) });
  // 盯着它一路涨(而不是在某个角度上停住),就是"主压方向持续漂移、玩家不能固定角度挂机"的读数。
  // 度数与 src/data/waves.ts 里写的起止角同一套(世界系绝对角,0 = +X,顺时针为正)——
  // 只是这里折回了 [0,360),数据表里写的则是不折回的累积角(如 320→480,折回会让它倒着转)
  wave.addBinding(stats, 'threatDeg', { label: '主压方向 °', readonly: true, interval: 200, format: (v: number) => v.toFixed(0) });
  wave.addBinding(stats, 'threatRate', { label: '强度 只/s', readonly: true, interval: 200, format: (v: number) => v.toFixed(2) });
  // 与结算界面报的是同一个数;放这儿是因为"打到第几段"与"打死了多少"合起来才是这一局的进度
  wave.addBinding(stats, 'kills', { label: '击杀', readonly: true, interval: 200, format: (v: number) => String(Math.round(v)) });

  // 压测只剩敌人这一半:子弹那一半(stressBullets / bulletSpeed)在 05 号 issue 整段删除 ——
  // 凭空重生的哑弹与真弹共用一个池,"500 弹不掉帧"测的就是假东西。500 弹现在由塔真的打出来,
  // 想压满就多放几座高射速塔(点防/机炮)再把敌数拖高,盯上面的「弹(存活)」读数即可。
  //
  // **整个抽屉只在「运行 · 压测出怪」打开时生效**(敌速倍率与分离半径除外:那两根管的是
  // 全场敌人的行为,与谁把它们放出来无关)—— 正式出怪器的数量由脚本的速率曲线定,不看这根滑杆。
  const stress = pane.addFolder({ title: '压测(验收 1000 敌)' });
  stress.addBinding(tuning, 'stressEnemies', { label: '敌数量(仅压测模式)', min: 0, max: 5000, step: 100 });
  // 各型敌人的基础速度在 src/data/enemies.ts,这里只剩全局倍率;拖到 0 = 全场定格,
  // 想看清某一型的走位(尤其冲锋前摇)时比暂停好用 —— 船还能开,敌人不动
  stress.addBinding(tuning, 'enemySpeedScale', { label: '敌速倍率', min: 0, max: 3, step: 0.1 });
  stress.addBinding(tuning, 'enemySeparation', { label: '分离半径', min: 0, max: 40, step: 1 });

  // 敌人(07 号 issue):四条占比是轮盘赌权重,不必凑成 100。
  // **四条一律仅在「运行 · 压测出怪」打开时生效**:正式出怪器(08 号)的型号由
  // src/data/waves.ts 的波次脚本逐条流给死,一次随机都不掷 —— 改平衡请去改那张表。
  // 注意:改占比只影响**新生成**的敌人,已在场的不会变型 —— 想只看某一型做肉眼验收,
  // 把其余三个调 0,再把上面的「敌数量(仅压测模式)」拖到 0 再拖回来即可清场重出。
  const enemy = pane.addFolder({ title: '敌人(07)' });
  enemy.addBinding(tuning, 'enemyMixSwarm', { label: '蜂群蛭 %(仅压测)', min: 0, max: 100, step: 5 });
  enemy.addBinding(tuning, 'enemyMixStrafer', { label: '侧掠者 %(仅压测)', min: 0, max: 100, step: 5 });
  enemy.addBinding(tuning, 'enemyMixTrailer', { label: '尾随蛆 %(仅压测)', min: 0, max: 100, step: 5 });
  enemy.addBinding(tuning, 'enemyMixBeetle', { label: '冲撞甲虫 %(仅压测)', min: 0, max: 100, step: 5 });
  // 同样只作用于新生成的敌人:HP 在生成那一刻按世界已过时间定死(GDD §14)
  enemy.addBinding(tuning, 'enemyHpScalePerMinute', { label: 'HP/分钟', min: 0, max: 0.5, step: 0.01 });

  // 默认展开:M0 门就是靠这四根滑杆边玩边调出来的,不该让人先点开一层
  const ship = pane.addFolder({ title: '船体手感', expanded: true });
  ship.addBinding(tuning, 'shipTurnRate', { label: '转向 °/s', min: 20, max: 300, step: 5 });
  ship.addBinding(tuning, 'shipCruiseSpeed', { label: '巡航 px/s', min: 40, max: 400, step: 5 });
  ship.addBinding(tuning, 'shipAccel', { label: '加速 px/s²', min: 60, max: 800, step: 10 });
  ship.addBinding(tuning, 'shipDamping', { label: '阻尼 s', min: 0.2, max: 3, step: 0.1 });

  // 受击(09 号 issue):HP 读数与五根旋钮放在同一个抽屉里 —— 调"蜂群贴脸掉血速率"时要盯的
  // 就是这个数掉得多快,读数与旋钮分家的话得在面板上来回找两个位置。
  // 五根旋钮全部由 sim 现读,故拖动即时生效、无需重开(shipHullHp 稍特殊,见它自己那段);
  // 判定体那根还能按住 Tab 边拖边看轮廓变。
  const hit = pane.addFolder({ title: '受击(09)' });
  hit.addBinding(stats, 'hp', { label: '船体 HP', readonly: true, interval: 200, format: (v: number) => String(Math.round(v)) });
  // 紧挨着 hp 放:这两个数只有摆在一起才读得出"还剩多少"。放一块装甲舱它当场 +15(见 DebugStats.maxHp),
  // 而 hp 纹丝不动 —— 上限是船的规格,当前 HP 是这一局打下来的账,装甲不是治疗
  hit.addBinding(stats, 'maxHp', { label: 'HP 上限', readonly: true, interval: 200, format: (v: number) => String(Math.round(v)) });
  // 各型的 contactDamage 在 src/data/enemies.ts,这里是全局倍率:先拖它定"贴脸掉得多快",
  // 再回数值表分配各型的相对轻重(与塔的伤害倍率同一条用法)
  hit.addBinding(tuning, 'enemyContactDamageScale', { label: '撞击伤害倍率', min: 0, max: 5, step: 0.1 });
  // 同一只敌人两次结算之间的间隔。下限不给 0:那等于每逻辑帧咬一口,贴脸就是 60 倍速瞬杀,
  // 拖到那儿只会以为是 bug 而不是"调到了极端"
  hit.addBinding(tuning, 'enemyHitInterval', { label: '无敌帧 s', min: 0.1, max: 3, step: 0.05 });
  // <1 = 被撞舷的塔变慢。下限同样不给 0:0 = 那一舷彻底哑火,而"不制造死亡螺旋"正是这条设计的前提
  hit.addBinding(tuning, 'hitFireRateMul', { label: '受击射速×', min: 0.2, max: 1, step: 0.05 });
  // 闪红与射速惩罚共用这一个计时器(GDD §4.6 锁定 0.5s),拖它等于同时改两件事的时长 ——
  // 想验"惩罚不可叠加延长"就把它拖长,连续撞击时它也只会从**第一次**受击起算
  hit.addBinding(tuning, 'hitPenaltyTime', { label: '惩罚时长 s', min: 0.1, max: 3, step: 0.1 });
  // 判定体大小(GDD §4.4:判定小于外形)。按住 Tab 能看见那个矩形跟着这根滑杆实时变 ——
  // 那是它唯一的肉眼校准方式,拖完再去贴脸试"擦碰出火花 / 进核心才掉血"的分界对不对
  hit.addBinding(tuning, 'shipCoreScale', { label: '判定体×(按 Tab 看)', min: 0.2, max: 1.5, step: 0.02 });
  // 只是**基础值**:真正的上限 = 它 + 每块装甲舱 +15(hullMaxHp 是甲板的派生量),
  // 而 06 号起 World.step 每逻辑帧重刷一次 ship.maxHp —— 所以这根滑杆拖到哪儿,
  // 上面那条只读「HP 上限」当帧就跟到哪儿(不必再放一座塔去触发),hp 则只夹不涨、不跟着回血。
  // label 得说这个真话:写"重开生效"/"放塔后生效"都会让人以为拖了没用而白等
  hit.addBinding(tuning, 'shipHullHp', {
    label: 'HP 上限(基础)',
    min: 20,
    max: 500,
    step: 10,
  });

  // 残骸经济(10 号):三根**手感旋钮**与三条只读账摆在同一个抽屉里。
  // 面额归 data/enemies、曲线/权重/返还归 data/economy,它们不是运行中随手拖的东西;
  // 这里只放 sim/drop 每帧现读的三根,于是拖一下立刻就能看「残骸开始飞 / 追不追得上 / 何时到账」。
  const economy = pane.addFolder({ title: '残骸经济(10)', expanded: true });
  economy.addBinding(stats, 'scrap', {
    label: '残骸',
    readonly: true,
    interval: 100,
    format: (v: number) => String(Math.round(v)),
  });
  economy.addBinding(stats, 'upgrades', {
    label: '升级次数',
    readonly: true,
    interval: 100,
    format: (v: number) => String(Math.round(v)),
  });
  economy.addBinding(stats, 'upgradeCost', {
    label: '下次所需',
    readonly: true,
    interval: 100,
    format: (v: number) => String(Math.round(v)),
  });
  economy.addBinding(tuning, 'dropMagnetRadius', {
    label: '起吸半径 px',
    min: 20,
    max: 600,
    step: 5,
  });
  economy.addBinding(tuning, 'dropMagnetSpeed', {
    label: '磁吸速度 px/s',
    min: 20,
    max: 800,
    step: 10,
  });
  economy.addBinding(tuning, 'dropCollectRadius', {
    label: '收取半径 px',
    min: 0,
    max: 100,
    step: 1,
  });

  // 塔(05 号 issue):这里**只剩两根全局倍率**。04 号那三项全塔共用的占位
  // (turretArcDeg / turretRange / turretTurnRate)已被数值表一塔一档取代 —— 弧度、射程、转速、
  // 节流参数全在 src/data/towers.ts,改那张表即可调平衡(05 号验收标准),面板不该再开第二个入口:
  // 面板能改的数与数值表里的数一旦分家,调出来的手感就落不回文件里。
  // 两根倍率由 sim/tower.ts 每逻辑帧现读(与 enemySpeedScale 同口径),故拖动即时生效;
  // 用法是"整体拖一下看体感":想知道六塔的相对强弱够不够开,把伤害倍率拖一半再打一波最快。
  const tower = pane.addFolder({ title: '塔(05)' });
  tower.addBinding(tuning, 'towerDamageScale', { label: '伤害倍率', min: 0, max: 5, step: 0.1 });
  // >1 = 全塔射得更快(实际 fireInterval = 表里的值 ÷ 它);充能系不受它影响(那类塔的节奏在 chargeTime)
  tower.addBinding(tuning, 'towerFireRateScale', { label: '射速倍率', min: 0.1, max: 5, step: 0.1 });

  // 镜头(GDD §3.3):两项都是屏高比例,故与分辨率无关;渲染层每帧现读,拖动即时生效。
  // 范围必须罩得住默认值 0.064(船与敌人同尺度那次改的,见 config.ts):Tweakpane 对带
  // min/max 的绑定**写入时就夹取**,min 高于默认值的话,一碰滑杆值就被永久顶到 min 上、
  // 再也拖不回来;step 也得让 0.064 落在网格上(0.002 × 32),否则同样回不去
  const camera = pane.addFolder({ title: '镜头(GDD §3.3)' });
  camera.addBinding(tuning, 'cameraShipHeightFraction', { label: '船占屏高', min: 0.03, max: 0.3, step: 0.002 });
  camera.addBinding(tuning, 'cameraLookAhead', { label: '前视偏移', min: 0, max: 0.4, step: 0.01 });
}
