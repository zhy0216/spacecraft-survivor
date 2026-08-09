import { afterEach, describe, expect, it } from 'vitest';
import { SIM_DT } from '../core/loop';
import { DECK_PIECE_BAR } from '../data/deckPieces';
import { KIND_SWARM } from '../data/enemies';
import { WAVE_SEGMENTS, type WaveSegment } from '../data/waves';
import { tuning } from './config';
import {
  canWeldPiece,
  CELL_WEAPON,
  cellAt,
  MOVE_OK,
  placeAt,
  WELD_OK,
} from './deck';
import {
  REFIT_ALREADY_WELDED,
  REFIT_NOT_ACTIVE,
  World,
} from './world';

const REAL = WAVE_SEGMENTS.slice();
const STRESS = tuning.stressSpawn;
afterEach(() => {
  WAVE_SEGMENTS.splice(0, WAVE_SEGMENTS.length, ...REAL);
  tuning.stressSpawn = STRESS;
});

function segment(p: Partial<WaveSegment> = {}): WaveSegment {
  return {
    name: '航段',
    duration: 0.051,
    dirStartDeg: 0,
    dirEndDeg: 0,
    streams: [],
    bursts: [],
    elites: [],
    ...p,
  };
}

function useTwoSegments(): void {
  tuning.stressSpawn = false;
  WAVE_SEGMENTS.splice(
    0,
    WAVE_SEGMENTS.length,
    segment({ name: '旧波' }),
    segment({
      name: '新波',
      duration: 1,
      streams: [{ kind: KIND_SWARM, rate0: 60, rate1: 60, spreadDeg: 0 }],
    }),
  );
}

describe('两分钟波次整备', () => {
  it('跨段先进入整备、下一波不偷跑；完成后才从新段开始出怪', () => {
    useTwoSegments();
    const w = new World(81);
    const seen: number[] = [];
    w.onRefitOffer = (segmentIndex) => seen.push(segmentIndex);

    // 先走到跨段前一帧，再补足残骸：制造“跨段与普通升级同帧成立”的真实冲突。
    for (let i = 0; i < 3; i++) w.step();
    expect(w.wave.segment).toBe(0);
    expect(w.offer).toEqual([]);
    w.scrap = w.upgradeCost;
    w.step();
    expect(w.wave.segment).toBe(1);
    expect(seen).toEqual([1]);
    expect(w.enemies.size).toBe(0);
    expect(w.offer).toEqual([]);

    const heldTime = w.wave.segTime;
    for (let i = 0; i < 10; i++) w.step();
    expect(w.wave.segTime).toBe(heldTime);
    expect(w.enemies.size).toBe(0);
    expect(seen).toEqual([1]);

    expect(w.completeRefit()).toBe(true);
    expect(w.completeRefit()).toBe(false);
    w.step();
    expect(w.wave.segTime).toBeCloseTo(heldTime + SIM_DT, 12);
    expect(w.enemies.size).toBe(1);
    expect(w.offer).toEqual([]); // 完成整备后有冷却，不会下一帧背靠背弹普通升级
  });

  it('甲板每轮最多焊一块；模块只能在整备期移动并保留等级', () => {
    const w = new World(82);
    expect(placeAt(w.deck, 0, 1, CELL_WEAPON)).toBe(0);
    cellAt(w.deck, 0, 1)!.level = 3;

    expect(w.moveRefitModule(0, 1, 2, 2)).toBe(REFIT_NOT_ACTIVE);
    expect(w.weldRefitPiece(DECK_PIECE_BAR, 0, -2, 0)).toBe(REFIT_NOT_ACTIVE);

    w.refitPending = true;
    expect(w.moveRefitModule(0, 1, 2, 2)).toBe(MOVE_OK);
    expect(cellAt(w.deck, 2, 2)!.level).toBe(3);

    let welded = false;
    for (let row = -4; row <= 7 && !welded; row++) {
      for (let col = -4; col <= 6 && !welded; col++) {
        if (canWeldPiece(w.deck, DECK_PIECE_BAR, 0, col, row) !== WELD_OK) continue;
        expect(w.weldRefitPiece(DECK_PIECE_BAR, 0, col, row)).toBe(WELD_OK);
        welded = true;
      }
    }
    expect(welded).toBe(true);
    expect(w.refitWelded).toBe(true);
    expect(w.weldRefitPiece(DECK_PIECE_BAR, 0, -9, -9)).toBe(REFIT_ALREADY_WELDED);
  });

  it('整备等待态与本轮焊接状态进入 checksum', () => {
    const a = new World(83);
    const b = new World(83);
    expect(a.checksum()).toBe(b.checksum());
    a.refitPending = true;
    expect(a.checksum()).not.toBe(b.checksum());
    b.refitPending = true;
    expect(a.checksum()).toBe(b.checksum());
    a.refitWelded = true;
    expect(a.checksum()).not.toBe(b.checksum());
  });
});
