import { afterEach, describe, expect, it } from 'vitest';
import { SIM_HZ } from '../core/loop';
import { KIND_BOSS } from '../data/enemies';
import { OFFER_WEIGHT_EDICT, OFFER_WEIGHT_NEW_WEAPON, skipRefundFor, upgradeCost } from '../data/economy';
import { WAVE_TOTAL_TIME } from '../data/waves';
import { WEAPON_SLOT_COUNT } from './armory';
import { tuning } from './config';
import { applyStartingLoadout } from './loadout';
import { OFFER_EDICT, OFFER_NEW_WEAPON } from './upgrade';
import { ACQUIRE_REPLACE_NEEDED, RESULT_WIN, World } from './world';

describe('槽位制经济参数', () => {
  it('升级费用递增且跳过退款扣除固定手续费', () => {
    expect(upgradeCost(0)).toBeGreaterThan(0);
    expect(upgradeCost(2)).toBeGreaterThan(upgradeCost(1));
    expect(skipRefundFor(upgradeCost(2))).toBeLessThan(upgradeCost(2));
  });

  it('候选两类权重总和为 100(星级系统:武器升级整类取消)', () => {
    expect(OFFER_WEIGHT_NEW_WEAPON + OFFER_WEIGHT_EDICT).toBe(100);
  });

  it('起始装配与商店都读取固定武器槽而非甲板边界', () => {
    const world = new World(1);
    applyStartingLoadout(world);
    expect(world.weapons.some((slot) => slot.type >= 0)).toBe(true);
    // 槽位数从 armory 现读:8 个槽围成一圈是设计口径,写死数字的话改口径这条就成了假绿
    expect(world.weapons).toHaveLength(WEAPON_SLOT_COUNT);
  });
});

describe('真脚本长跑:一局自然升级次数窗口(12–15)', () => {
  // 全仓唯一一条跑完真脚本(480s ≈ 28800 帧)的世界级经济用例。
  // 它回答的只有「自然战斗 + 自然磁吸能结算几次升级」,故关掉撞击与弹幕伤害避免操作水平/
  // 沉船污染结果(与 deck 时代的先例同口径);火力、死亡、掉落、磁吸、候选与放置仍全部走
  // 真实链路,不手工清怪、不凭空加残骸。磁吸涌(26 号)把"被甩在身后的残骸"提前锁定收取,
  // 会改这一局的到账时机 —— 这条用例就是"涌不把升级次数推出 12–15 窗"的裁判。
  const before = {
    stressSpawn: tuning.stressSpawn,
    enemyContactDamageScale: tuning.enemyContactDamageScale,
    enemySporeDamageScale: tuning.enemySporeDamageScale,
  };
  afterEach(() => Object.assign(tuning, before));

  /** 固定自动玩家:新武器 > 法令,槽满时用 0 号槽替换;全被拒才跳过。零随机策略 */
  function settleOffer(w: World): void {
    if (w.offer.length === 0) return;
    const order = [OFFER_NEW_WEAPON, OFFER_EDICT];
    for (const kind of order) {
      const at = w.offer.findIndex((o) => o.kind === kind);
      if (at < 0) continue;
      let code = w.takeUpgrade(at);
      if (code === ACQUIRE_REPLACE_NEEDED) code = w.takeUpgrade(at, 0);
      if (code >= 0) return;
    }
    w.skipUpgrade();
  }

  /** 真脚本走完 = 进入 Boss 战:机器人直接击杀 Boss(与精英击杀同口径,两局同帧做同一件事) */
  function killBoss(w: World): void {
    const boss = w.enemies.items.find((e) => e.kind === KIND_BOSS);
    if (boss) w.damageEnemy(boss, 9999);
  }

  it(
    '真脚本一局自然完成 12–15 次升级,同 seed 的经济与最终 checksum 逐位一致',
    () => {
      tuning.stressSpawn = false;
      tuning.enemyContactDamageScale = 0;
      tuning.enemySporeDamageScale = 0;
      const a = new World(20260802);
      const b = new World(20260802);
      applyStartingLoadout(a);
      applyStartingLoadout(b);

      // 多留 1 秒兜住逐帧浮点跨段边界;正常会在 WAVE_TOTAL_TIME 左右进入 Boss 战、
      // 击杀 Boss 后落成 RESULT_WIN 再提前退出
      const maxFrames = (WAVE_TOTAL_TIME + 1) * SIM_HZ;
      for (let frame = 0; frame < maxFrames; frame++) {
        a.step();
        b.step();
        settleOffer(a);
        settleOffer(b);
        killBoss(a);
        killBoss(b);
        if (a.result === RESULT_WIN && b.result === RESULT_WIN) break;
      }

      expect(a.result).toBe(RESULT_WIN);
      expect(b.result).toBe(RESULT_WIN);
      // 经济验收锚点(README 口径):窗口不许改宽 —— 掉出去要回到数值侧调,而不是迁就断言
      expect(a.upgrades).toBeGreaterThanOrEqual(12);
      expect(a.upgrades).toBeLessThanOrEqual(15);
      expect(b.upgrades).toBe(a.upgrades);
      expect(b.scrap).toBe(a.scrap);
      expect(b.checksum()).toBe(a.checksum());
    },
    120_000,
  );
});
