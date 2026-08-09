/**
 * 全仓唯一一条跑完 08 真脚本(480s ≈ 28800 帧)的世界级经济用例。
 * 它回答的只有「自然战斗 + 自然磁吸能结算几次升级」,故关掉撞击伤害避免操作水平/沉船污染结果;
 * 火力、死亡、掉落、磁吸、候选与放置仍全部走真实链路,不手工清怪、不凭空加残骸。
 */
import { afterEach, expect, it } from 'vitest';
import { SIM_HZ } from '../core/loop';
import { KIND_BOSS } from '../data/enemies';
import { WAVE_TOTAL_TIME } from '../data/waves';
import { tuning } from './config';
import { canWeldPiece, isPlaceSuccess, PLACE_OK, WELD_OK } from './deck';
import { applyStartingLoadout } from './loadout';
import { OFFER_DECK, OFFER_EDICT, OFFER_TOWER, optionLegalCells } from './upgrade';
import { RESULT_WIN, World } from './world';

const before = {
  stressSpawn: tuning.stressSpawn,
  enemyContactDamageScale: tuning.enemyContactDamageScale,
};

afterEach(() => Object.assign(tuning, before));

const legal: number[] = [];

/**
 * 固定自动玩家:优先第一张**塔卡**(没有塔卡才取第一张法令卡,再没有才取第 0 张),
 * 放进它的第 0 个合法格。仍是零随机的固定策略,不引入第二条合法性规则。偏好塔而不是盲拿第 0 张,
 * 是因为这条用例要量的是"经济循环喂不喂得起一条像样的火力成长" ——
 * 支援死卡过滤让支援池收窄成弹药库/装甲舱之后,盲拿第 0 张的机器人会连堆五座装甲舱,
 * 火力停摆 → 高面额敌人杀不掉 → 量出来的只是机器人自己的病,不是曲线的量级。
 * 法令(18 号)次选:全船被动、不占格,抽到直接 takeUpgrade 授予(真实玩家不会跳过免费的永久加成)。
 */
function settleOffer(w: World): void {
  if (w.offer.length === 0) return;
  const towerAt = w.offer.findIndex((o) => o.kind === OFFER_TOWER);
  const edictAt = w.offer.findIndex((o) => o.kind === OFFER_EDICT);
  const choice = towerAt >= 0 ? towerAt : edictAt >= 0 ? edictAt : 0;
  const opt = w.offer[choice]!;
  if (opt.kind === OFFER_EDICT) {
    expect(w.takeUpgrade(choice, 0, 0)).toBe(PLACE_OK); // 法令不占格:直接授予
    return;
  }
  if (opt.kind === OFFER_DECK) {
    for (let rotation = 0; rotation < 4; rotation++) {
      for (let row = w.deck.minRow - 4; row < w.deck.minRow + w.deck.rows + 4; row++) {
        for (let col = w.deck.minCol - 4; col < w.deck.minCol + w.deck.cols + 4; col++) {
          if (canWeldPiece(w.deck, opt.type, rotation, col, row) !== WELD_OK) continue;
          expect(w.takeUpgrade(choice, col, row, rotation)).toBe(WELD_OK);
          return;
        }
      }
    }
    throw new Error('拼块候选没有合法焊接锚点');
  }
  expect(optionLegalCells(w.deck, opt, legal)).toBeGreaterThan(0);
  const cell = w.deck.cells[legal[0]!]!;
  expect(isPlaceSuccess(w.takeUpgrade(choice, cell.col, cell.row))).toBe(true);
}

/** 自动玩家在每个两分钟边界扩一块合法甲板，然后确认整备；不搬模块，保持策略固定。 */
function settleRefit(w: World): void {
  if (!w.refitPending) return;
  for (let pieceType = 0; pieceType < 4; pieceType++) {
    for (let rotation = 0; rotation < 4; rotation++) {
      for (let row = w.deck.minRow - 4; row < w.deck.minRow + w.deck.rows + 4; row++) {
        for (let col = w.deck.minCol - 4; col < w.deck.minCol + w.deck.cols + 4; col++) {
          if (canWeldPiece(w.deck, pieceType, rotation, col, row) !== WELD_OK) continue;
          expect(w.weldRefitPiece(pieceType, rotation, col, row)).toBe(WELD_OK);
          expect(w.completeRefit()).toBe(true);
          return;
        }
      }
    }
  }
  expect(w.completeRefit()).toBe(true);
}

/**
 * 真脚本走完 = 进入 Boss 战(15 号)。塔的伤害管线对 KIND_BOSS 的越界兜底是
 * "不打这一只"(弹道塔的 kind 越界跳过,todos/15 渲染/弹道侧跟进前),
 * 故机器人直接击杀 Boss —— 与精英击杀同一条口径,两局在同一帧做同一件事,
 * 经济账与最终 checksum 仍逐位可比。
 */
function killBoss(w: World): void {
  const boss = w.enemies.items.find((e) => e.kind === KIND_BOSS);
  if (boss) w.damageEnemy(boss, 9999);
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

    // 多留 1 秒兜住逐帧浮点跨段边界;正常会在 WAVE_TOTAL_TIME 左右进入 Boss 战、
    // 击杀 Boss 后落成 RESULT_WIN 再提前退出。
    const maxFrames = (WAVE_TOTAL_TIME + 1) * SIM_HZ;
    for (let frame = 0; frame < maxFrames; frame++) {
      a.step();
      b.step();
      settleRefit(a);
      settleRefit(b);
      settleOffer(a);
      settleOffer(b);
      killBoss(a);
      killBoss(b);
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
