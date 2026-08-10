/**
 * 起始装配只验证「数据表经唯一放置入口落地」,具体放置规则由 deck.test.ts 负责。
 * 20 号起装配对象从单一 STARTING_LOADOUT 换成 LOADOUTS 多配置:缺省(无参)= 标准起手,
 * 语义与旧版逐字节一致;新增"全部配置都能在全新甲板落地"的合法性钉 ——
 * 数值表里加一条配置却落在内部格/越界格,这条用例当场抓出来,不用等真人开局少一门炮。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOADOUT_BOMBARD, LOADOUTS } from '../data/loadout';
import { TOWER_AUTOCANNON, TOWER_MORTAR } from '../data/towers';
import { CELL_EMPTY, CELL_WEAPON, cellAt, createDeck } from './deck';
import { applyStartingLoadout } from './loadout';

/** 旧测试按"可改表再还原"的约定直接动数据;20 号改动的对象变成标准起手那一条的 entries */
const original = LOADOUTS[0]!.entries.map((entry) => ({ ...entry }));

afterEach(() => {
  LOADOUTS[0]!.entries.length = 0;
  for (const entry of original) LOADOUTS[0]!.entries.push({ ...entry });
  vi.restoreAllMocks();
});

describe('applyStartingLoadout', () => {
  it('缺省 = 标准起手:左右舷各放一门自动机炮,World 构造仍可保持空甲板', () => {
    const deck = createDeck();
    expect(deck.cells.every((cell) => cell.content === CELL_EMPTY)).toBe(true);

    applyStartingLoadout(deck);

    const left = cellAt(deck, 0, 1)!;
    const right = cellAt(deck, 2, 1)!;
    expect([left.content, right.content]).toEqual([CELL_WEAPON, CELL_WEAPON]);
    expect([left.towerType, right.towerType]).toEqual([TOWER_AUTOCANNON, TOWER_AUTOCANNON]);
    expect([left.level, right.level]).toEqual([1, 1]);
    expect(deck.cells.filter((cell) => cell.content === CELL_WEAPON)).toHaveLength(2);
  });

  it('表里某条非法时只跳过该条并把理由码报出来,其余起手塔照常落地', () => {
    LOADOUTS[0]!.entries.unshift({ ...LOADOUTS[0]!.entries[0]!, col: 1, row: 1 }); // 内部格不能放武器塔
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const deck = createDeck();

    applyStartingLoadout(deck);

    expect(cellAt(deck, 1, 1)!.content).toBe(CELL_EMPTY);
    expect(deck.cells.filter((cell) => cell.content === CELL_WEAPON)).toHaveLength(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain('理由码');
  });

  it('四条配置都能在全新 3×4 甲板上完整落地:逐条放到位,条数与表一致', () => {
    for (const def of LOADOUTS) {
      const deck = createDeck();
      applyStartingLoadout(deck, def);
      // 每条配置的所有条目都必须真实落在声明的格上(内部格/越界格会在这里显形)
      for (const e of def.entries) {
        const cell = cellAt(deck, e.col, e.row)!;
        expect(cell.content, `${def.id} (${e.col},${e.row})`).toBe(CELL_WEAPON);
        expect(cell.towerType, `${def.id} (${e.col},${e.row})`).toBe(e.towerType);
        expect(cell.level, `${def.id} (${e.col},${e.row})`).toBe(1);
      }
      expect(deck.cells.filter((cell) => cell.content === CELL_WEAPON)).toHaveLength(
        def.entries.length,
      );
    }
  });

  it('按下标装配与按定义装配等价(开局选择界面传的是下标)', () => {
    const byIndex = createDeck();
    applyStartingLoadout(byIndex, LOADOUT_BOMBARD);
    const byDef = createDeck();
    applyStartingLoadout(byDef, LOADOUTS[LOADOUT_BOMBARD]!);
    for (const cell of byIndex.cells) {
      const other = byDef.cells[cell.col + cell.row * byDef.cols]!;
      expect([cell.content, cell.towerType, cell.supportType]).toEqual([
        other.content,
        other.towerType,
        other.supportType,
      ]);
    }
  });

  it('越界的配置下标只警告不落子 —— 空甲板开出去比"开局少一门炮"更难查', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const deck = createDeck();
    applyStartingLoadout(deck, 99);
    expect(deck.cells.every((cell) => cell.content === CELL_EMPTY)).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain('找不到配置');
  });
});
