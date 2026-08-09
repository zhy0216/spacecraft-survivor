import { describe, expect, it } from 'vitest';
import { BOSS } from '../data/enemies';
import type { ElitePeek } from '../sim/waves';
import {
  bossSummonWarnActive,
  bossSummonWarnFraction,
  bossWarnOnEnter,
  ELITE_WARN_LEAD,
  eliteWarnActive,
  eliteWarnKey,
  enemyAnimFrame,
  type EnemyAnim,
} from './renderer';

/**
 * 精英出场预警的判定/去重是纯函数(见 renderer.ts 的导出),在这里钉 14 号的两条口径:
 *  1. 预警窗口 ~2s:eta 进窗才亮,没到点的精英一个字都不提示;
 *  2. 发声去重:同一只精英(segment + eliteNext 游标)整窗只响一次,换一只才再响。
 * 画图本身(屏边箭头 + 倒计时环)需要 WebGL 上下文,不在这里测。
 */

const peek = (etaSeconds: number): ElitePeek => ({
  etaSeconds,
  kind: 0,
  count: 1,
  affixes: [],
});

describe('eliteWarnActive(窗口判定)', () => {
  it('没有下一个未触发的精英(段内放完 / 脚本走完 / 压测旁路)恒不亮', () => {
    expect(eliteWarnActive(null)).toBe(false);
  });

  it('eta 超出预警窗口不亮;进窗(≤ ELITE_WARN_LEAD)才亮,直到出生前最后一帧', () => {
    expect(eliteWarnActive(peek(ELITE_WARN_LEAD + 0.01))).toBe(false);
    expect(eliteWarnActive(peek(ELITE_WARN_LEAD))).toBe(true);
    expect(eliteWarnActive(peek(ELITE_WARN_LEAD / 2))).toBe(true);
    expect(eliteWarnActive(peek(0))).toBe(true);
  });
});

describe('eliteWarnKey(发声去重键)', () => {
  it('同一只精英(段与游标都相同)键恒定 —— 预警窗口内不会重复发声', () => {
    expect(eliteWarnKey(1, 0)).toBe(eliteWarnKey(1, 0));
  });

  it('游标前移(精英出生)或换段后键必变 —— 下一只精英进窗照常响', () => {
    expect(eliteWarnKey(1, 0)).not.toBe(eliteWarnKey(1, 1));
    expect(eliteWarnKey(1, 1)).not.toBe(eliteWarnKey(2, 1));
  });

  it('哨兵 -1(无预警)不与任何真键冲突', () => {
    expect(eliteWarnKey(0, 0)).toBe(0);
    expect(eliteWarnKey(0, 0)).not.toBe(-1);
    expect(eliteWarnKey(0, 0)).toBeGreaterThanOrEqual(0);
  });
});

describe('bossSummonWarnActive(召唤预告窗口,15 号)', () => {
  it('只有 Boss 战中(bossPhase === 1)才亮;未进场 / 已击杀都不提示', () => {
    expect(bossSummonWarnActive(1, 0)).toBe(false);
    expect(bossSummonWarnActive(1, 2)).toBe(false);
    expect(bossSummonWarnActive(1, 1)).toBe(true);
  });

  it('冷却超出预警窗不亮;进窗(≤ BOSS.summonWarnTime)才亮;到 0(已触发,sim 当场重置)不亮', () => {
    expect(bossSummonWarnActive(BOSS.summonWarnTime + 0.01, 1)).toBe(false);
    expect(bossSummonWarnActive(BOSS.summonWarnTime, 1)).toBe(true);
    expect(bossSummonWarnActive(BOSS.summonWarnTime / 2, 1)).toBe(true);
    expect(bossSummonWarnActive(0, 1)).toBe(false);
  });
});

describe('bossSummonWarnFraction(倒计时环弧长)', () => {
  it('刚进窗满弧(1),触发前一刻收没(→0),坏分母回落 0', () => {
    expect(bossSummonWarnFraction(BOSS.summonWarnTime)).toBe(1);
    expect(bossSummonWarnFraction(BOSS.summonWarnTime / 2)).toBeCloseTo(0.5);
    expect(bossSummonWarnFraction(0)).toBe(0);
    expect(bossSummonWarnFraction(Number.NaN)).toBe(0);
  });
});

describe('bossWarnOnEnter(出场音帧判定)', () => {
  it('只有 bossPhase 翻进 1 的那一帧该响 —— 停留 / 击杀 / 首帧 0 都不响', () => {
    expect(bossWarnOnEnter(0, 1)).toBe(true);
    expect(bossWarnOnEnter(-1, 1)).toBe(true);
    expect(bossWarnOnEnter(0, 0)).toBe(false);
    expect(bossWarnOnEnter(1, 1)).toBe(false);
    expect(bossWarnOnEnter(1, 2)).toBe(false);
    expect(bossWarnOnEnter(-1, 0)).toBe(false);
  });
});

/**
 * 程序化敌人动画(第一步)的纯读数:enemyAnimFrame 是 syncParticles 热循环里每帧对每只怪
 * 的调用,值域/界就是画面上虫群的动作边界 —— 缩放翻负 = 虫子变成黑点,摆动超界 = 朝向说谎。
 * 画图本身(vertex/rotation 缓冲上传)需要 WebGL,不在这里测。
 */

const breathing: EnemyAnim = { freq: 3, breatheAmp: 0.1, wobbleAmp: 0.2, spin: 0 };
const spinner: EnemyAnim = { freq: 0, breatheAmp: 0, wobbleAmp: 0, spin: 1.5 };
const idle: EnemyAnim = { freq: 0, breatheAmp: 0, wobbleAmp: 0, spin: 0 };

describe('enemyAnimFrame(动画读数)', () => {
  it('全 0 参数恒等:缩放 = 基准、摆动 = 0 —— 不该动的型绝不白动', () => {
    for (let t = 0; t < 10; t += 0.37) {
      const f = enemyAnimFrame(idle, t, 0.7, 2.5);
      expect(f.scale).toBe(2.5);
      expect(f.wobble).toBeCloseTo(0, 9); // sin 为负时 -0,toBeCloseTo 才不挑刺
      expect(f.spin).toBeCloseTo(0.7 * Math.PI * 2, 9); // spin 公式恒成立:seed 相位仍在
    }
  });

  it('呼吸缩放夹在基准 ×(1∓幅度)内,且一个完整周期上下界都到得了', () => {
    const base = 1.6;
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (let t = 0; t <= (Math.PI * 2) / breathing.freq; t += 1 / 240) {
      const s = enemyAnimFrame(breathing, t, 0, base).scale;
      lo = Math.min(lo, s);
      hi = Math.max(hi, s);
      expect(s).toBeGreaterThan(0); // 幅度 < 1 的硬约束:缩放翻负 = 图形反相的黑点
      expect(s).toBeLessThanOrEqual(base * (1 + breathing.breatheAmp) + 1e-9);
      expect(s).toBeGreaterThanOrEqual(base * (1 - breathing.breatheAmp) - 1e-9);
    }
    expect(lo).toBeCloseTo(base * (1 - breathing.breatheAmp), 2);
    expect(hi).toBeCloseTo(base * (1 + breathing.breatheAmp), 2);
  });

  it('摆动幅度不超 wobbleAmp,且一个周期内正负都过 —— 真的在摆,不是停在一边', () => {
    let sawNeg = false;
    let sawPos = false;
    for (let t = 0; t < (Math.PI * 2) / breathing.freq; t += 1 / 240) {
      const w = enemyAnimFrame(breathing, t, 0.3, 1).wobble;
      expect(Math.abs(w)).toBeLessThanOrEqual(breathing.wobbleAmp + 1e-9);
      if (w < 0) sawNeg = true;
      if (w > 0) sawPos = true;
    }
    expect(sawNeg && sawPos).toBe(true);
  });

  it('自转随时间单调推进(漂移转,不是摆回来):t 越大转角越大', () => {
    let prev = Number.NEGATIVE_INFINITY;
    for (let t = 0; t < 3; t += 1 / 60) {
      const s = enemyAnimFrame(spinner, t, 0.1, 1).spin;
      expect(s).toBeGreaterThan(prev);
      prev = s;
    }
  });

  it('同参数同输出:确定性 —— 同 seed 两局相位一字不差的前提', () => {
    expect(enemyAnimFrame(breathing, 1.234, 0.8, 2)).toEqual(
      enemyAnimFrame(breathing, 1.234, 0.8, 2),
    );
  });

  it('不同 seed 的相位错开:同型两只不会在同一时刻同向呼吸', () => {
    expect(enemyAnimFrame(breathing, 0, 0.1, 1).scale).not.toBe(
      enemyAnimFrame(breathing, 0, 0.9, 1).scale,
    );
  });
});
