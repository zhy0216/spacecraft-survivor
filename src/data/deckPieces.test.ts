import { describe, expect, it } from 'vitest';
import { DECK_PIECE_KIND_COUNT, DECK_PIECES, deckPieceCellCount } from './deckPieces';

describe('甲板拼块数值表', () => {
  it('恰好提供 1×2 / L / 2×2 / T 四型，类型与下标稳定一致', () => {
    expect(DECK_PIECE_KIND_COUNT).toBe(4);
    expect(DECK_PIECES.map((d) => d.type)).toEqual([0, 1, 2, 3]);
    expect(DECK_PIECES.map((d) => deckPieceCellCount(d.type))).toEqual([2, 3, 4, 4]);
  });

  it('每块都含锚点、无重复格且正交连通', () => {
    for (const def of DECK_PIECES) {
      const cells: Array<[number, number]> = [];
      for (let i = 0; i < def.cells.length; i += 2) cells.push([def.cells[i]!, def.cells[i + 1]!]);
      expect(cells[0]).toEqual([0, 0]);
      expect(new Set(cells.map(([c, r]) => `${c},${r}`)).size).toBe(cells.length);

      const reached = new Set<string>(['0,0']);
      let changed = true;
      while (changed) {
        changed = false;
        for (const [c, r] of cells) {
          const key = `${c},${r}`;
          if (reached.has(key)) continue;
          if (
            reached.has(`${c + 1},${r}`) ||
            reached.has(`${c - 1},${r}`) ||
            reached.has(`${c},${r + 1}`) ||
            reached.has(`${c},${r - 1}`)
          ) {
            reached.add(key);
            changed = true;
          }
        }
      }
      expect(reached.size, `${def.name} 必须正交连通`).toBe(cells.length);
    }
  });
});
