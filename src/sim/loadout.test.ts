/** 起始装配只验证「数据表经唯一放置入口落地」,具体放置规则由 deck.test.ts 负责。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STARTING_LOADOUT } from '../data/loadout';
import { TOWER_AUTOCANNON } from '../data/towers';
import { CELL_EMPTY, CELL_WEAPON, cellAt, createDeck } from './deck';
import { applyStartingLoadout } from './loadout';

const original = STARTING_LOADOUT.map((entry) => ({ ...entry }));

afterEach(() => {
  STARTING_LOADOUT.length = 0;
  for (const entry of original) STARTING_LOADOUT.push({ ...entry });
  vi.restoreAllMocks();
});

describe('applyStartingLoadout', () => {
  it('左右舷各放一门自动机炮,World 构造仍可保持空甲板', () => {
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
    STARTING_LOADOUT.unshift({ ...STARTING_LOADOUT[0]!, col: 1, row: 1 }); // 内部格不能放武器塔
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const deck = createDeck();

    applyStartingLoadout(deck);

    expect(cellAt(deck, 1, 1)!.content).toBe(CELL_EMPTY);
    expect(deck.cells.filter((cell) => cell.content === CELL_WEAPON)).toHaveLength(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain('理由码');
  });
});
