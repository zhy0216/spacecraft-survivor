/**
 * 放置提示文案(03 号 issue T4 + 05 号 issue T5 的塔型/叠级)。只测纯函数那几段 ——
 * createPlacementUi 要 DOM 与 canvas,本仓的 vitest 跑在 Node 环境里(不装 jsdom),
 * 交互部分的验收本来也只能靠真人点(见 03 号验收标准),不值得为它拖一个环境进来。
 *
 * 钉的是"每个理由码都当场把规则原文讲一遍"(GDD §4.1/§4.5/§5.4 的规则少到不必做教学关,
 * 前提就是拒绝时必须说清为什么):新增理由码却忘了配文案时,它会静默退化成兜底串 ——
 * 本文件就是那道拦网。塔名与键位则钉"提示条只从数值表取名字",不许 ui 里再抄一份。
 * 注意 ui 只 import type 渲染层,所以这里不会把 pixi 拖进 Node。
 */
import { describe, expect, it } from 'vitest';
import { TOWER_KIND_COUNT, TOWER_MAX_LEVEL, TOWERS } from '../data/towers';
import {
  CELL_SUPPORT,
  CELL_WEAPON,
  isPlaceSuccess,
  PLACE_BAD_CONTENT,
  PLACE_BAD_TOWER,
  PLACE_INTERIOR,
  PLACE_MAX_LEVEL,
  PLACE_NO_CELL,
  PLACE_OK,
  PLACE_TAKEN,
  PLACE_UPGRADE,
} from '../sim/deck';
import { denyMessage, keyHintText, placeLabel, placedMessage } from './placement';

const DENY_CODES = [
  PLACE_NO_CELL,
  PLACE_TAKEN,
  PLACE_INTERIOR,
  PLACE_BAD_CONTENT,
  PLACE_MAX_LEVEL,
  PLACE_BAD_TOWER,
];

describe('denyMessage', () => {
  it('每个拒绝码都有各自的中文文案,互不重复', () => {
    const msgs = DENY_CODES.map(denyMessage);
    for (const m of msgs) expect(m.length).toBeGreaterThan(0);
    // 两个码共用一句话 = 玩家看不出到底撞了哪条规则
    expect(new Set(msgs).size).toBe(DENY_CODES.length);
    // 兜底串只该出现在未知码上;拿它当拒绝文案说明有码漏配了
    for (const m of msgs) expect(m).not.toContain('理由码');
  });

  it('内部格 / 已占用格 / 叠到顶的文案带上规则出处', () => {
    // 前两条是 03 号验收标准里点名的拒绝路径(武器塔进内部格 / 往已占用格里插),
    // 第三条是 05 号的叠级上限 —— 它与"格子已被占用"是两回事,玩家得看得出区别
    expect(denyMessage(PLACE_INTERIOR)).toContain('§4.1');
    expect(denyMessage(PLACE_TAKEN)).toContain('§4.5');
    expect(denyMessage(PLACE_MAX_LEVEL)).toContain('§5.4');
    // 上限从数值表来:把 TOWER_MAX_LEVEL 改成 6,这句提示必须跟着变(改数据即可调平衡)
    expect(denyMessage(PLACE_MAX_LEVEL)).toContain(`Lv${TOWER_MAX_LEVEL}`);
  });

  it('未知码回落成带码的兜底文案,而不是空串', () => {
    // PLACE_OK / PLACE_UPGRADE 走不到 denyMessage(调用方只在非成功时问),故它们也算"未知码"
    for (const code of [PLACE_OK, PLACE_UPGRADE, 99, -1]) {
      expect(denyMessage(code)).toContain(String(code));
    }
  });
});

describe('placeLabel', () => {
  it('武器塔报数值表里的塔名,六种各不相同', () => {
    const names = TOWERS.map((def) => placeLabel(CELL_WEAPON, def.type));
    expect(names).toEqual(TOWERS.map((def) => def.name));
    expect(new Set(names).size).toBe(TOWER_KIND_COUNT);
  });

  it('支援设施不看塔型;塔型越界报回原始下标而不是悄悄换成另一座塔', () => {
    expect(placeLabel(CELL_SUPPORT, 0)).toBe(placeLabel(CELL_SUPPORT, 99));
    expect(placeLabel(CELL_WEAPON, 99)).toContain('99');
  });
});

describe('placedMessage', () => {
  it('叠级与新放是两句话:叠级必须报出升到了几级', () => {
    // 叠级不占新格、画面上什么都不会多出来(GDD §5.4),这行字是唯一能证明"点中了"的东西
    const up = placedMessage(PLACE_UPGRADE, '自动机炮', 3);
    expect(up).toContain('自动机炮');
    expect(up).toContain('Lv3');
    expect(placedMessage(PLACE_OK, '自动机炮', 1)).not.toContain('Lv');
    expect(up).not.toBe(placedMessage(PLACE_OK, '自动机炮', 1));
  });

  it('两种成功码都被 isPlaceSuccess 认下(ui 靠它分成功/拒绝)', () => {
    expect(isPlaceSuccess(PLACE_OK)).toBe(true);
    expect(isPlaceSuccess(PLACE_UPGRADE)).toBe(true);
    for (const code of DENY_CODES) expect(isPlaceSuccess(code)).toBe(false);
  });
});

describe('keyHintText', () => {
  it('六种塔的键位从数值表现生成:下标 + 1 = 数字键,塔名一个不落', () => {
    const hint = keyHintText();
    for (let i = 0; i < TOWERS.length; i++) {
      expect(hint).toContain(`${i + 1} ${TOWERS[i]!.name}`);
    }
    // 0 号键是支援设施(与 1..6 的武器塔分开):键位表漏了它,玩家就再也放不出支援设施
    expect(hint).toContain('0 支援设施');
  });
});
