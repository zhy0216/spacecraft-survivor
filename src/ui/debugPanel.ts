/**
 * Tweakpane 调参面板(DOM 覆盖层)。
 * 服务两件事:01 号 issue 的压测读数,02 号 issue 的手感热调(改了立刻体感对比)。
 */
import { Pane } from 'tweakpane';
import { tuning } from '../sim/config';

export interface DebugStats {
  fps: number;
  /** 存活敌数 = 池里 items.length,与滑杆设定的目标值区分开 —— fps 读数得配它才有意义 */
  enemies: number;
  bullets: number;
  speed: number; // 船速 px/s,用来确认巡航参数改动真的生效
  /**
   * 船体 HP(09 号 issue)。11 号 issue 的战斗 HUD 会给它一条正式血条,在那之前,
   * 这个只读数是"蜂群贴脸掉血速率可控可调"(09 号验收标准)唯一的**量化**读数 ——
   * 画面上那条灰盒血条只回答"在掉",拖倍率对比掉得多快得看数。
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
}

export interface RunState {
  paused: boolean;
  timeScale: number;
}

export function createDebugPanel(stats: DebugStats, run: RunState): void {
  const pane = new Pane({ title: 'STARWRECK · 灰盒调参' });

  const perf = pane.addFolder({ title: '性能 / 确定性' });
  perf.addBinding(stats, 'fps', { readonly: true, interval: 200, format: (v: number) => v.toFixed(0) });
  perf.addBinding(stats, 'enemies', { label: '敌(存活)', readonly: true, interval: 200, format: (v: number) => String(Math.round(v)) });
  // 05 号起这是**塔真的打出来的弹**(不再有凭空重生的压测哑弹),故它同时是"500 弹不掉帧"
  // 那条验收的读数:它爬到 500 上下时 fps 还稳,才算数
  perf.addBinding(stats, 'bullets', { label: '弹(存活)', readonly: true, interval: 200, format: (v: number) => String(Math.round(v)) });
  // 拖巡航滑杆时盯这个数:它爬到新的上限,才算"参数改动无需重启即可体感对比"落实了
  perf.addBinding(stats, 'speed', { label: '船速 px/s', readonly: true, interval: 200, format: (v: number) => String(Math.round(v)) });
  perf.addBinding(stats, 'tick', { readonly: true, interval: 200, format: (v: number) => String(Math.round(v)) });
  perf.addBinding(stats, 'checksum', { readonly: true, interval: 500 });
  perf.addBinding(stats, 'seed', { readonly: true, format: (v: number) => String(v) });

  const runF = pane.addFolder({ title: '运行' });
  runF.addBinding(run, 'paused', { label: '暂停' });
  runF.addBinding(run, 'timeScale', { label: '时间倍率', min: 0.1, max: 3, step: 0.1 });

  // 压测只剩敌人这一半:子弹那一半(stressBullets / bulletSpeed)在 05 号 issue 整段删除 ——
  // 凭空重生的哑弹与真弹共用一个池,"500 弹不掉帧"测的就是假东西。500 弹现在由塔真的打出来,
  // 想压满就多放几座高射速塔(点防/机炮)再把敌数拖高,盯上面的「弹(存活)」读数即可。
  const stress = pane.addFolder({ title: '压测(验收 1000 敌)' });
  stress.addBinding(tuning, 'stressEnemies', { label: '敌数量(目标)', min: 0, max: 5000, step: 100 });
  // 各型敌人的基础速度在 src/data/enemies.ts,这里只剩全局倍率;拖到 0 = 全场定格,
  // 想看清某一型的走位(尤其冲锋前摇)时比暂停好用 —— 船还能开,敌人不动
  stress.addBinding(tuning, 'enemySpeedScale', { label: '敌速倍率', min: 0, max: 3, step: 0.1 });
  stress.addBinding(tuning, 'enemySeparation', { label: '分离半径', min: 0, max: 40, step: 1 });

  // 敌人(07 号 issue):四条占比是轮盘赌权重,不必凑成 100。
  // 注意:改占比只影响**新生成**的敌人,已在场的不会变型 —— 想只看某一型做肉眼验收,
  // 把其余三个调 0,再把上面的「敌数量(目标)」拖到 0 再拖回来即可清场重出。
  const enemy = pane.addFolder({ title: '敌人(07)' });
  enemy.addBinding(tuning, 'enemyMixSwarm', { label: '蜂群蛭 %', min: 0, max: 100, step: 5 });
  enemy.addBinding(tuning, 'enemyMixStrafer', { label: '侧掠者 %', min: 0, max: 100, step: 5 });
  enemy.addBinding(tuning, 'enemyMixTrailer', { label: '尾随蛆 %', min: 0, max: 100, step: 5 });
  enemy.addBinding(tuning, 'enemyMixBeetle', { label: '冲撞甲虫 %', min: 0, max: 100, step: 5 });
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

  // 镜头(GDD §3.3):两项都是屏高比例,故与分辨率无关;渲染层每帧现读,拖动即时生效
  const camera = pane.addFolder({ title: '镜头(GDD §3.3)' });
  camera.addBinding(tuning, 'cameraShipHeightFraction', { label: '船占屏高', min: 0.1, max: 0.4, step: 0.01 });
  camera.addBinding(tuning, 'cameraLookAhead', { label: '前视偏移', min: 0, max: 0.4, step: 0.01 });
}
