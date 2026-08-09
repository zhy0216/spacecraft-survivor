import { describe, expect, it } from 'vitest';
import {
  MOVE_NO_SOURCE,
  MOVE_NO_TARGET,
  MOVE_SAME_CELL,
  MOVE_TARGET_TAKEN,
  MOVE_WEAPON_INTERIOR,
  WELD_BAD_PIECE,
  WELD_BAD_ROTATION,
  WELD_DETACHED,
  WELD_OVERLAP,
} from '../sim/deck';
import { REFIT_ALREADY_WELDED, REFIT_NOT_ACTIVE } from '../sim/world';
import { refitDenyMessage, refitShopWidth, refitThreatSummary } from './refitFlow';

describe('整备面板纯文案', () => {
  it('下一波摘要从波次表生成，并点出逐段首次出现的敌型', () => {
    expect(refitThreatSummary(1)).toContain('碎石带');
    expect(refitThreatSummary(1)).toContain('新敌型：尾随蛆');
    expect(refitThreatSummary(2)).toContain('新敌型：冲撞甲虫');
    expect(refitThreatSummary(3)).toContain('蜂群蛭 4.2→5.4/秒');
    expect(refitThreatSummary(99)).toBe('下一波资料缺失');
  });

  it('所有整备拒绝码都有明确中文原因，不退化成裸数字', () => {
    const codes = [
      MOVE_NO_SOURCE,
      MOVE_NO_TARGET,
      MOVE_TARGET_TAKEN,
      MOVE_WEAPON_INTERIOR,
      MOVE_SAME_CELL,
      WELD_OVERLAP,
      WELD_DETACHED,
      WELD_BAD_PIECE,
      WELD_BAD_ROTATION,
      REFIT_ALREADY_WELDED,
      REFIT_NOT_ACTIVE,
    ];
    for (const code of codes) {
      const text = refitDenyMessage(code);
      expect(text.length).toBeGreaterThan(4);
      expect(text).not.toBe(`整备操作被拒绝(理由码 ${code})`);
    }
  });

  it('固定商店栏在常见桌面宽度下保持可读，并给左侧甲板留出空间', () => {
    expect(refitShopWidth(800)).toBe(300);
    expect(refitShopWidth(1200)).toBe(408);
    expect(refitShopWidth(1920)).toBe(430);
    expect(refitShopWidth(Number.NaN)).toBe(0);
  });
});
