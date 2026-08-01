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
  perf.addBinding(stats, 'bullets', { label: '弹(存活)', readonly: true, interval: 200, format: (v: number) => String(Math.round(v)) });
  perf.addBinding(stats, 'tick', { readonly: true, interval: 200, format: (v: number) => String(Math.round(v)) });
  perf.addBinding(stats, 'checksum', { readonly: true, interval: 500 });
  perf.addBinding(stats, 'seed', { readonly: true, format: (v: number) => String(v) });

  const runF = pane.addFolder({ title: '运行' });
  runF.addBinding(run, 'paused', { label: '暂停' });
  runF.addBinding(run, 'timeScale', { label: '时间倍率', min: 0.1, max: 3, step: 0.1 });

  const stress = pane.addFolder({ title: '压测(验收 1000 敌 + 500 弹)' });
  stress.addBinding(tuning, 'stressEnemies', { label: '敌数量(目标)', min: 0, max: 5000, step: 100 });
  stress.addBinding(tuning, 'stressBullets', { label: '弹数量(目标)', min: 0, max: 2000, step: 50 });
  stress.addBinding(tuning, 'enemySpeed', { label: '敌速 px/s', min: 20, max: 300, step: 5 });
  stress.addBinding(tuning, 'enemySeparation', { label: '分离半径', min: 0, max: 40, step: 1 });
  stress.addBinding(tuning, 'bulletSpeed', { label: '弹速 px/s', min: 60, max: 1200, step: 20 });

  const ship = pane.addFolder({ title: '船体手感(02 号 issue 接线)', expanded: false });
  ship.addBinding(tuning, 'shipTurnRate', { label: '转向 °/s', min: 20, max: 300, step: 5 });
  ship.addBinding(tuning, 'shipCruiseSpeed', { label: '巡航 px/s', min: 40, max: 400, step: 5 });
  ship.addBinding(tuning, 'shipAccel', { label: '加速 px/s²', min: 60, max: 800, step: 10 });
  ship.addBinding(tuning, 'shipDamping', { label: '阻尼 s', min: 0.2, max: 3, step: 0.1 });
}
