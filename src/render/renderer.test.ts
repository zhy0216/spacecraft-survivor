import { describe, expect, it } from 'vitest';
import type { ElitePeek } from '../sim/waves';
import { ELITE_WARN_LEAD, eliteWarnActive, eliteWarnKey } from './renderer';

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
