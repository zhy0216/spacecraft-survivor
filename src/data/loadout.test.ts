/**
 * 起手配置表(20 号)的表级不变量:条目齐全且 id 唯一、名称/描述非空、
 * 每条条目都是合法型号的武器塔且落在 3×4 船体范围内、标准起手与旧固定表逐字节一致。
 * "全部配置能在全新甲板上完整落地"的放置规则钉在 sim/loadout.test.ts(那是 placeAt 的活,
 * 这里只钉本表自己的口径 —— 与 data/unlocks.test.ts 只钉表不钉存档同一条分工)。
 */
import { describe, expect, it } from 'vitest';
import {
  LOADOUT_ARC,
  LOADOUT_BOMBARD,
  LOADOUT_COUNT,
  LOADOUT_SNIPER,
  LOADOUT_STANDARD,
  LOADOUTS,
} from './loadout';
import { SUPPORT_KIND_COUNT } from './supports';
import { TOWER_AUTOCANNON, TOWER_KIND_COUNT } from './towers';

/** 起始船体 3×4(GDD §4.1);起手表不许出现越界的格 */
const DECK_COLS = 3;
const DECK_ROWS = 4;

describe('起手配置表', () => {
  it('条目齐全:id 唯一且非空,名称/描述非空,编号常量与表长自洽', () => {
    expect(LOADOUT_COUNT).toBe(LOADOUTS.length);
    expect(LOADOUTS.length).toBeGreaterThanOrEqual(3);
    const ids = LOADOUTS.map((l) => l.id);
    for (const id of ids) expect(id.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const l of LOADOUTS) {
      expect(l.name.length).toBeGreaterThan(0);
      expect(l.desc.length).toBeGreaterThan(0);
      expect(l.entries.length).toBeGreaterThan(0);
    }
    for (const idx of [LOADOUT_STANDARD, LOADOUT_ARC, LOADOUT_BOMBARD, LOADOUT_SNIPER]) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(LOADOUT_COUNT);
    }
  });

  it('标准起手 = 旧固定表的逐字节等价(整数稳定性:老行为与老存档语义不得漂移)', () => {
    const standard = LOADOUTS[LOADOUT_STANDARD]!;
    expect(standard.id).toBe('standard');
    expect(standard.entries).toEqual([
      { col: 0, row: 1, content: 1, towerType: TOWER_AUTOCANNON, supportType: 0 },
      { col: 2, row: 1, content: 1, towerType: TOWER_AUTOCANNON, supportType: 0 },
    ]);
  });

  it('每条条目都是合法型号的武器塔,且落在起始 3×4 船体范围内', () => {
    for (const l of LOADOUTS) {
      for (const e of l.entries) {
        expect(e.col).toBeGreaterThanOrEqual(0);
        expect(e.col).toBeLessThan(DECK_COLS);
        expect(e.row).toBeGreaterThanOrEqual(0);
        expect(e.row).toBeLessThan(DECK_ROWS);
        expect(e.content).toBe(1); // CELL_WEAPON 的稳定数据码,见文件头
        expect(e.towerType).toBeGreaterThanOrEqual(0);
        expect(e.towerType).toBeLessThan(TOWER_KIND_COUNT);
        expect(e.supportType).toBeGreaterThanOrEqual(0);
        expect(e.supportType).toBeLessThan(SUPPORT_KIND_COUNT);
      }
    }
  });
});
