/**
 * 全仓唯一一条跑完 08 真脚本(550s ≈ 33000 帧)的世界级经济用例。
 * 它回答的只有「自然战斗 + 自然磁吸能结算几次升级」,故关掉撞击伤害避免操作水平/沉船污染结果;
 * 火力、死亡、掉落、磁吸、候选与放置仍全部走真实链路,不手工清怪、不凭空加残骸。
 */
import { afterEach, expect, it } from 'vitest';
import { SIM_HZ } from '../core/loop';
import { WAVE_TOTAL_TIME } from '../data/waves';
import { tuning } from './config';
import { isPlaceSuccess } from './deck';
import { applyStartingLoadout } from './loadout';
import { optionLegalCells } from './upgrade';
import { RESULT_WIN, World } from './world';

const before = {
  stressSpawn: tuning.stressSpawn,
  enemyContactDamageScale: tuning.enemyContactDamageScale,
};

afterEach(() => Object.assign(tuning, before));

const legal: number[] = [];

/** 固定自动玩家:永远取第 0 张、放进它的第 0 个合法格,不引入第二条合法性规则。 */
function settleOffer(w: World): void {
  const opt = w.offer[0];
  if (!opt) return;
  expect(optionLegalCells(w.deck, opt, legal)).toBeGreaterThan(0);
  const cell = w.deck.cells[legal[0]!]!;
  expect(isPlaceSuccess(w.takeUpgrade(0, cell.col, cell.row))).toBe(true);
}

it(
  '真脚本一局自然完成 12–15 次升级,同 seed 的经济与最终 checksum 逐位一致',
  () => {
    tuning.stressSpawn = false;
    tuning.enemyContactDamageScale = 0;
    const a = new World(20260802);
    const b = new World(20260802);
    applyStartingLoadout(a.deck);
    applyStartingLoadout(b.deck);

    // 多留 1 秒兜住逐帧浮点跨段边界;正常会在 WAVE_TOTAL_TIME 左右落成 RESULT_WIN 后提前退出。
    const maxFrames = (WAVE_TOTAL_TIME + 1) * SIM_HZ;
    for (let frame = 0; frame < maxFrames; frame++) {
      a.step();
      b.step();
      settleOffer(a);
      settleOffer(b);
      if (a.result === RESULT_WIN && b.result === RESULT_WIN) break;
    }

    expect(a.result).toBe(RESULT_WIN);
    expect(b.result).toBe(RESULT_WIN);
    expect(a.upgrades).toBeGreaterThanOrEqual(12);
    expect(a.upgrades).toBeLessThanOrEqual(15);
    expect(b.upgrades).toBe(a.upgrades);
    expect(b.scrap).toBe(a.scrap);
    expect(b.checksum()).toBe(a.checksum());
  },
  120_000,
);
