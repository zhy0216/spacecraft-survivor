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
