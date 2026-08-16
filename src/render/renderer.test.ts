import { describe, expect, it } from 'vitest';
import { BOSS } from '../data/enemies';
import { FXV_HULL_HIT, FXV_IMPACT, FXV_KILL } from '../sim/fx';
import type { ElitePeek } from '../sim/waves';
import {
  bossSummonWarnActive,
  bossSummonWarnFraction,
  BOSS_ENTRANCE_FX_TIME,
  bossEntranceStrength,
  bossWarnOnEnter,
  dmgNumberColor,
  dmgNumberText,
  ELITE_WARN_LEAD,
  eliteWarnActive,
  eliteWarnKey,
  enemyAnimFrame,
  hitFlashMix,
  type EnemyAnim,
  lerpColor,
  viewCullRect,
  visualStarTier,
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

describe('visualStarTier(逐星表现夹取)', () => {
  it('旧值/坏值回落 1★，2★/3★ 只落在三个稳定档位', () => {
    expect(visualStarTier(Number.NaN)).toBe(1);
    expect(visualStarTier(0)).toBe(1);
    expect(visualStarTier(1)).toBe(1);
    expect(visualStarTier(2)).toBe(2);
    expect(visualStarTier(3)).toBe(3);
    expect(visualStarTier(99)).toBe(3);
  });
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

describe('bossEntranceStrength(出场色相/震动包络)', () => {
  it('触发时满强度,窗口中过渡,结束与坏值都归零', () => {
    expect(bossEntranceStrength(BOSS_ENTRANCE_FX_TIME)).toBe(1);
    expect(bossEntranceStrength(BOSS_ENTRANCE_FX_TIME / 2)).toBeCloseTo(0.5, 12);
    expect(bossEntranceStrength(0)).toBe(0);
    expect(bossEntranceStrength(-1)).toBe(0);
    expect(bossEntranceStrength(Number.NaN)).toBe(0);
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

describe('dmgNumberText(飘字文本)', () => {
  it('取整:小数伤害(溅射)不印小数点,零/负数兜住', () => {
    expect(dmgNumberText(6)).toBe('6');
    expect(dmgNumberText(6.7)).toBe('7');
    expect(dmgNumberText(0)).toBe('0');
    expect(dmgNumberText(-3)).toBe('-3');
  });
});

describe('dmgNumberColor(飘字配色)', () => {
  it('船体真伤害恒红、击杀恒暖黄,不看比例', () => {
    const hull = dmgNumberColor(FXV_HULL_HIT, 0);
    const kill = dmgNumberColor(FXV_KILL, 0);
    expect(hull).not.toBe(kill);
    expect(dmgNumberColor(FXV_HULL_HIT, 1)).toBe(hull); // 比例不影响红字
    expect(dmgNumberColor(FXV_KILL, 1)).toBe(kill);
  });

  it('直射命中:小伤害白 → 大伤害黄,阈值带内线性过渡', () => {
    const white = dmgNumberColor(FXV_IMPACT, 0.01);
    const yellow = dmgNumberColor(FXV_IMPACT, 0.5);
    expect(white).toBe(0xffffff); // 比例低于白端阈值 = 纯白
    expect(yellow).toBe(0xffd35c); // 高于黄端阈值 = 纯黄
    expect(dmgNumberColor(FXV_IMPACT, 0.2)).not.toBe(white); // 阈值带内:介于白黄之间
    expect(dmgNumberColor(FXV_IMPACT, 0.2)).not.toBe(yellow);
  });
});

describe('lerpColor(颜色插值)', () => {
  it('k=0 得 a、k=1 得 b、k=0.5 得通道中点', () => {
    expect(lerpColor(0x000000, 0xffffff, 0)).toBe(0x000000);
    expect(lerpColor(0x000000, 0xffffff, 1)).toBe(0xffffff);
    expect(lerpColor(0x000000, 0xffffff, 0.5)).toBe(0x808080);
  });

  it('越界/NaN 被夹住:不产出越界颜色', () => {
    expect(lerpColor(0x000000, 0xffffff, -1)).toBe(0x000000);
    expect(lerpColor(0x000000, 0xffffff, 2)).toBe(0xffffff);
    expect(lerpColor(0x000000, 0xffffff, Number.NaN)).toBe(0x000000);
  });
});

describe('hitFlashMix(受击闪白强度)', () => {
  it('满值 = 1(刚命中那一帧最白),0 = 熄灭,线性衰减', () => {
    expect(hitFlashMix(0.08)).toBe(1);
    expect(hitFlashMix(0)).toBe(0);
    expect(hitFlashMix(0.04)).toBeCloseTo(0.5, 12);
    expect(hitFlashMix(-1)).toBe(0); // 防御:负数夹 0
  });
});

/**
 * 屏外剔除矩形的反向变换是纯函数(见 renderer.ts 的导出),在这里钉口径:
 * 世界 = pivot + (屏幕 - position) / scale(worldLayer 无旋转,position 含震屏)。
 * 分桶循环的剔除判断与热循环本身需要 WebGL,不在这里测。
 */
const rect = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

describe('viewCullRect(屏外剔除矩形)', () => {
  it('margin=0:屏幕矩形经缩放/平移/pivot 反变换回世界系', () => {
    const r = viewCullRect(2, 1000, 800, 400, 300, 800, 600, 0, rect);
    expect(r.minX).toBe(800); // 1000 + (0 - 400) / 2
    expect(r.maxX).toBe(1200); // 1000 + (800 - 400) / 2
    expect(r.minY).toBe(650); // 800 + (0 - 300) / 2
    expect(r.maxY).toBe(950); // 800 + (600 - 300) / 2
  });

  it('margin 四边外扩同值,内部点不受扰动', () => {
    const m = 64;
    const r = viewCullRect(2, 1000, 800, 400, 300, 800, 600, m, rect);
    expect(r.minX).toBe(800 - m);
    expect(r.maxX).toBe(1200 + m);
    expect(r.minY).toBe(650 - m);
    expect(r.maxY).toBe(950 + m);
  });

  it('position 含震屏:镜头右移 +20,世界系剔除矩形左移 -10(反向吸收)', () => {
    const ra = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    const rb = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    const a = viewCullRect(2, 1000, 800, 400, 300, 800, 600, 0, ra);
    const b = viewCullRect(2, 1000, 800, 420, 300, 800, 600, 0, rb);
    expect(b.minX).toBe(a.minX - 10);
    expect(b.maxX).toBe(a.maxX - 10);
    expect(b.minY).toBe(a.minY);
  });

  it('scale=1 且 pivot 在原点的退化情形:矩形 = 屏幕尺寸直接平移', () => {
    const r = viewCullRect(1, 0, 0, 0, 0, 800, 600, 0, rect);
    expect(r.minX).toBe(0);
    expect(r.maxX).toBe(800);
    expect(r.minY).toBe(0);
    expect(r.maxY).toBe(600);
  });

  it('同参数同输出:确定性 —— 分桶剔除不掺每帧抖动', () => {
    expect(viewCullRect(1.92, -123.4, 55.5, 960, 540, 1920, 1080, 64, rect)).toEqual(
      viewCullRect(1.92, -123.4, 55.5, 960, 540, 1920, 1080, 64, rect),
    );
  });
});
