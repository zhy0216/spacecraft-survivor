/**
 * 放置提示文案(03 号 issue T4)。只测 denyMessage 这一段纯逻辑 ——
 * createPlacementUi 要 DOM 与 canvas,本仓的 vitest 跑在 Node 环境里(不装 jsdom),
 * 交互部分的验收本来也只能靠真人点(见 03 号验收标准),不值得为它拖一个环境进来。
 *
 * 钉的是"每个理由码都当场把规则原文讲一遍"(GDD §4.1/§4.5 的规则少到不必做教学关,
 * 前提就是拒绝时必须说清为什么):新增理由码却忘了配文案时,它会静默退化成兜底串 ——
 * 本文件就是那道拦网。注意 ui 只 import type 渲染层,所以这里不会把 pixi 拖进 Node。
 */
import { describe, expect, it } from 'vitest';
import {
  PLACE_BAD_CONTENT,
  PLACE_INTERIOR,
  PLACE_NO_CELL,
  PLACE_OK,
  PLACE_TAKEN,
} from '../sim/deck';
import { denyMessage } from './placement';

const DENY_CODES = [PLACE_NO_CELL, PLACE_TAKEN, PLACE_INTERIOR, PLACE_BAD_CONTENT];

describe('denyMessage', () => {
  it('每个拒绝码都有各自的中文文案,互不重复', () => {
    const msgs = DENY_CODES.map(denyMessage);
    for (const m of msgs) expect(m.length).toBeGreaterThan(0);
    // 两个码共用一句话 = 玩家看不出到底撞了哪条规则
    expect(new Set(msgs).size).toBe(DENY_CODES.length);
    // 兜底串只该出现在未知码上;拿它当拒绝文案说明有码漏配了
    for (const m of msgs) expect(m).not.toContain('理由码');
  });

  it('内部格与已占用格的文案带上规则出处', () => {
    // 这两条是 03 号验收标准里点名的拒绝路径(武器塔进内部格 / 往已占用格里插)
    expect(denyMessage(PLACE_INTERIOR)).toContain('§4.1');
    expect(denyMessage(PLACE_TAKEN)).toContain('§4.5');
  });

  it('未知码回落成带码的兜底文案,而不是空串', () => {
    // PLACE_OK 走不到 denyMessage(调用方只在非 OK 时问),故它也算"未知码"
    for (const code of [PLACE_OK, 99, -1]) {
      expect(denyMessage(code)).toContain(String(code));
    }
  });
});
