/**
 * 运行日志(sim/runLog.ts + World 的落账接线)。
 *
 * 主体测的是**纯函数与容量闸门**:夹百分位、断尾置位 —— 这些错一旦埋下,只会在后端
 * 拿到几千条事件的真实上传里现形,而那时客户端早就改不动了。
 * 破例测 World(理由与 world.test 的 DPS 归账同款):日志是"只写不读"的记录纸,
 * 它最阴的失败不是写错值,而是**反过来扰动世界** —— 多加一次 rng 消耗、把某个事件
 * 落进 checksum 的分支,都要等"同 seed 复现"被玩家拿 ?seed 对账时才抓得到。
 * 于是这里的每一条 World 用例都顺带钉两件事:日志内容对、checksum 不被日志污染。
 */
import { describe, expect, it } from 'vitest';
import { EDICT_AMMO } from '../data/edicts';
import { KIND_BOSS, KIND_SWARM } from '../data/enemies';
import { TOWER_AUTOCANNON } from '../data/towers';
import { WEAPON_SLOT_COUNT } from './armory';
import { tuning } from './config';
import { SIM_DT } from '../core/loop';
import {
  createRunLog,
  logEvent,
  RUN_LOG_MAX_EVENTS,
  RUN_LOG_VERSION,
  SHOP_ACT_EDICT,
  SHOP_ACT_REFRESH,
  SHOP_ACT_REPAIR,
  SHOP_ACT_WEAPON,
  type RunLogEvent,
} from './runLog';
import { RESULT_LOSE, World } from './world';

/** 按 k 捡出日志里所有该种事件(时间线顺序不变) */
function byKind(log: { events: RunLogEvent[] }, k: RunLogEvent['k']): RunLogEvent[] {
  return log.events.filter((e) => e.k === k);
}

describe('createRunLog / logEvent(纯函数与容量闸门)', () => {
  it('空卷:版本、种子、空时间线、未截断', () => {
    const log = createRunLog(42);
    expect(log.v).toBe(RUN_LOG_VERSION);
    expect(log.seed).toBe(42);
    expect(log.events).toEqual([]);
    expect(log.truncated).toBe(false);
  });

  it('追加按时间线顺序,时间戳夹到百分位(60Hz 步长的小数尾差不进卷)', () => {
    const log = createRunLog(1);
    logEvent(log, { k: 'upgradeSkip', t: 1.23456 });
    logEvent(log, { k: 'upgradeSkip', t: 2.5 });
    expect(log.events.map((e) => e.t)).toEqual([1.23, 2.5]);
  });

  it('容量闸门:满额置 truncated 断尾,不回绕不驱逐(时间线宁可断尾不许掏洞)', () => {
    const log = createRunLog(1);
    for (let i = 0; i < RUN_LOG_MAX_EVENTS + 5; i++) {
      logEvent(log, { k: 'upgradeSkip', t: i });
    }
    expect(log.events).toHaveLength(RUN_LOG_MAX_EVENTS);
    expect(log.truncated).toBe(true);
    // 第一条还在原位:断尾 ≠ 滚动覆盖
    expect(log.events[0]!.t).toBe(0);
  });
});

describe('World 落账接线(每一条都顺带钉 checksum 不被日志污染)', () => {
  /** 出一只可被回收的怪(照 world.test 的 spawn + 灌血口径),kind/词缀可订 */
  function spawnVictim(world: World, kind = KIND_SWARM, affixes = 0): void {
    const e = world.enemies.spawn();
    e.kind = kind;
    e.affixes = affixes;
    e.hp = e.maxHp = 1e6;
  }

  it('第一帧记 start(8 槽配装快照),只记一次;日志追加不碰 checksum', () => {
    const a = new World(11);
    const b = new World(11);
    a.step();
    b.step();
    expect(byKind(a.log, 'start')).toHaveLength(1);
    const start = byKind(a.log, 'start')[0]! as Extract<RunLogEvent, { k: 'start' }>;
    expect(start.weapons).toHaveLength(WEAPON_SLOT_COUNT);
    for (let i = 0; i < 10; i++) {
      a.step();
      b.step(); // 两边同帧:checksum 的比对只对同 tick 有意义
    }
    expect(byKind(a.log, 'start')).toHaveLength(1); // 不重记
    expect(a.checksum()).toBe(b.checksum());
  });

  it('击杀逐只记(kind + 是否精英),Boss 另记 boss 转折条', () => {
    const a = new World(12);
    const b = new World(12);
    for (const w of [a, b]) {
      spawnVictim(w, KIND_SWARM, 0);
      spawnVictim(w, KIND_SWARM, 1); // 精英:带词缀
      spawnVictim(w, KIND_BOSS, 0);
      // 三只一次收完;damageEnemy 只标记,回收在 step 帧尾的 reap
      for (const e of w.enemies.items) w.damageEnemy(e, 1e7);
      w.step();
    }
    // reap 倒序回收(swap-remove 的下标纪律),击杀条顺序 = 出生顺序的倒序 ——
    // 时间线只承诺"同帧内按回收序",用例按内容排序后断言
    const kills = (byKind(a.log, 'kill') as Array<Extract<RunLogEvent, { k: 'kill' }>>).sort(
      (x, y) => x.kind - y.kind || Number(x.elite) - Number(y.elite),
    );
    expect(kills).toHaveLength(3);
    expect(kills[0]).toMatchObject({ kind: KIND_SWARM, elite: false });
    expect(kills[1]).toMatchObject({ kind: KIND_SWARM, elite: true });
    expect(kills[2]).toMatchObject({ kind: KIND_BOSS, elite: false });
    expect(byKind(a.log, 'boss')).toHaveLength(1);
    // 日志纯追加:同样的操作序列,两边日志逐位一致,checksum 逐位一致
    expect(a.log.events).toEqual(b.log.events);
    expect(a.checksum()).toBe(b.checksum());
  });

  it('船体:受击记实际扣血量、沉船记一条、帧尾 gameOver 落失败结论', () => {
    const a = new World(13);
    const b = new World(13);
    for (const w of [a, b]) {
      w.damageShip(1e9); // 一击沉:shipHit + shipDestroyed 当场落账
      w.step(); // 帧尾 settleOutcome 出结论
    }
    const hit = byKind(a.log, 'shipHit')[0]! as Extract<RunLogEvent, { k: 'shipHit' }>;
    expect(hit.damage).toBeGreaterThan(0);
    expect(byKind(a.log, 'shipDestroyed')).toHaveLength(1);
    const over = byKind(a.log, 'gameOver')[0]! as Extract<RunLogEvent, { k: 'gameOver' }>;
    expect(over.result).toBe(RESULT_LOSE);
    expect(a.checksum()).toBe(b.checksum());
  });

  it('升级决策链:结算一张卡记 kind/型/替换槽,跳过与重摇各有自己的条', () => {
    const world = new World(14);
    /** 凑钱后步进,直到弹卡冷却(5s)走完、三候选 roll 出来(照 economy.test 的自然弹卡口径) */
    const stepUntilOffer = (): void => {
      world.scrap = world.upgradeCost;
      let guard = 0;
      while (world.offer.length === 0 && guard < 400) {
        world.step();
        guard++;
      }
    };
    // 第一档:结算一张
    stepUntilOffer();
    const opt = world.offer[0]!;
    expect(world.takeUpgrade(0, 0)).toBeGreaterThanOrEqual(0);
    const upgrade = byKind(world.log, 'upgrade')[0]! as Extract<RunLogEvent, { k: 'upgrade' }>;
    expect(upgrade.kind).toBe(opt.kind);
    expect(upgrade.type).toBe(opt.type);
    expect(upgrade.slot).toBe(0);

    // 第二档:跳过(completeUpgrade 都拉满 5s 冷却,下一档要等冷却走完)
    stepUntilOffer();
    expect(world.skipUpgrade()).toBe(true);
    expect(byKind(world.log, 'upgradeSkip')).toHaveLength(1);

    // 第三档:重摇(星币够才算,失败不记)
    stepUntilOffer();
    world.starCoins = 100;
    expect(world.rerollOffer()).toBeGreaterThan(0);
    expect(byKind(world.log, 'reroll')).toHaveLength(1);
  });

  it('船坞商店四类成交各记一条 act,失败不落账', () => {
    const world = new World(15);
    world.refitPending = true;
    world.dockEdictOffers.push(EDICT_AMMO);
    world.shopWeapons.push(TOWER_AUTOCANNON);
    world.starCoins = 999;
    world.ship.hp = 1; // 修复要有伤可修
    expect(world.buyDockEdict(0)).toBe(0);
    expect(world.buyShopWeapon(0)).toBe(0);
    expect(world.buyDockRepair()).toBe(0);
    expect(world.refreshShop()).toBe(0);
    const acts = (byKind(world.log, 'shop') as Array<Extract<RunLogEvent, { k: 'shop' }>>).map(
      (e) => e.act,
    );
    expect(acts).toEqual([SHOP_ACT_EDICT, SHOP_ACT_WEAPON, SHOP_ACT_REPAIR, SHOP_ACT_REFRESH]);
    // 失败路径:法令格已售出,再买不动账也不落账
    world.starCoins = 999;
    expect(world.buyDockEdict(0)).toBeLessThan(0);
    expect(byKind(world.log, 'shop')).toHaveLength(4);
  });

  it('跨段记 segment(与信标同帧),接上信标记 refit', () => {
    // 关掉撞击与弹幕伤害(照 economy.test 长跑的口径):这条用例要船活着跑到 120s 的段边界,
    // 沉船会先把局终结论落定,refit 事件那道 RESULT_RUNNING 闸门当场把整备吞掉
    const world = new World(5);
    const contact = tuning.enemyContactDamageScale;
    const spore = tuning.enemySporeDamageScale;
    tuning.enemyContactDamageScale = 0;
    tuning.enemySporeDamageScale = 0;
    try {
      let guard = 0;
      while (world.wave.segment === 0 && guard < 130 * 60) {
        world.step();
        guard++;
      }
      expect(world.wave.segment).toBe(1);
      const segment = byKind(world.log, 'segment')[0]! as Extract<RunLogEvent, { k: 'segment' }>;
      expect(segment.index).toBe(1);

      // 把信标贴到船身上 → step 接触判定 → refit 事件 + refitPending(照 refit.test 的手工点亮口径)
      world.shopBeaconX = world.ship.x;
      world.shopBeaconY = world.ship.y;
      world.step();
      expect(byKind(world.log, 'refit')).toHaveLength(1);
    } finally {
      tuning.enemyContactDamageScale = contact;
      tuning.enemySporeDamageScale = spore;
    }
  });

  it('受击时间戳用 world.elapsed 秒(帧号 × SIM_DT),与生存时长同一条时间轴', () => {
    const world = new World(16);
    const steps = 300;
    for (let i = 0; i < steps; i++) world.step();
    world.damageShip(10);
    const hit = byKind(world.log, 'shipHit')[0]!;
    // 300 帧 × 1/60s = 5.0s,夹百分位后仍精确等于(整数秒无尾差)
    expect(hit.t).toBe(steps * SIM_DT);
  });
});
