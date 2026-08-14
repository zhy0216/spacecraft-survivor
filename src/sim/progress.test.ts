/**
 * 元进度存档的纯数据层(19 号 issue 的"存档模块")—— Node 环境,铁律 1 的验证
 * (sim 不依赖 Pixi/DOM/localStorage,这份测试才跑得起来)。
 * 与 data/unlocks.test.ts 同口径:钉的是**存档侧的口径** —— evaluateRun 条件达成即记
 * (失败局同样推进)、已解锁不重复、JSON 往返,
 * 以及 unlockMask 编码与 sim/upgrade.ts 的位约定一致(位 i = UNLOCKS[i])。
 * localStorage 适配器(ui/progressStorage.ts)在 Node 里没有 localStorage,不在这里假装验过。
 */
import { describe, expect, it } from 'vitest';
import { Rng } from '../core/rng';
import { isMergeResult } from '../data/merges';
import { TOWER_KIND_COUNT } from '../data/towers';
import { COND_ELITE_KILLS, COND_FIRST_WIN, COND_KILLS, UNLOCKS } from '../data/unlocks';
import { createEdictLevels } from '../data/edicts';
import { createWeaponSlots } from './armory';
import {
  createProgress,
  evaluateRun,
  mergeProgress,
  parseProgress,
  serializeProgress,
  type RunStats,
} from './progress';
import { OFFER_NEW_WEAPON, rollUpgradeOffer, type UpgradeOption } from './upgrade';
import { RESULT_LOSE, RESULT_WIN } from './world';

/** 固定随机序列 + 计数器:类型私有字段使 Rng 名义化,测试桩经 unknown 显式转入(与 upgrade.test 同款) */
class CountingRng {
  calls = 0;
  constructor(private readonly values: number[] = []) {}
  next(): number {
    return this.values[this.calls++] ?? 0;
  }
}

/** 条目 id → 它在 UNLOCKS 里的下标(= 掩码位)。测试钉住"位约定"用的探针 */
function bitOf(id: string): number {
  const i = UNLOCKS.findIndex((u) => u.id === id);
  expect(i, `${id} 不在 UNLOCKS 表里`).toBeGreaterThanOrEqual(0);
  return i;
}

/** 空跑一局(什么条件都不达,只方便摆初始进度) */
const idleRun = (): RunStats => ({ result: RESULT_LOSE, kills: 0, eliteKills: 0 });

describe('evaluateRun:条件达成即记,不看胜负', () => {
  it('失败局 300 杀照常解锁 edict-rapid,但胜利局数不加(不惩罚尝试,也不白送胜利)', () => {
    const r = evaluateRun(createProgress(), {
      result: RESULT_LOSE,
      kills: 300,
      eliteKills: 0,
    });
    expect(r.newUnlocks & (1 << bitOf('edict-rapid'))).not.toBe(0);
    expect(r.newUnlocks & (1 << bitOf('tower-missile-nest'))).toBe(0);
    expect(r.progress.wins).toBe(0);
  });

  it('胜利局才 +1 wins,并解锁首次胜利锁(导弹巢)', () => {
    const r = evaluateRun(createProgress(), {
      result: RESULT_WIN,
      kills: 299,
      eliteKills: 0,
    });
    expect(r.progress.wins).toBe(1);
    expect(r.newUnlocks & (1 << bitOf('tower-missile-nest'))).not.toBe(0);
    expect(r.newUnlocks & (1 << bitOf('edict-rapid'))).toBe(0); // 299 杀不到 300,单局阈值差一就锁着
  });

  it('精英击杀跨局累计:两局加起来到 14 才开 elite-queen,单局不够不白算', () => {
    const first = evaluateRun(createProgress(), { ...idleRun(), eliteKills: 13 });
    expect(first.newUnlocks & (1 << bitOf('elite-queen'))).toBe(0);
    expect(first.progress.eliteKills).toBe(13);
    const second = evaluateRun(first.progress, { ...idleRun(), eliteKills: 1 });
    expect(second.newUnlocks & (1 << bitOf('elite-queen'))).not.toBe(0);
    expect(second.progress.eliteKills).toBe(14);
  });

  it('计数器累计口径:击杀总数跨局累加,失败局同样入账', () => {
    const first = evaluateRun(createProgress(), { ...idleRun(), kills: 200 });
    const second = evaluateRun(first.progress, { ...idleRun(), kills: 100 });
    expect(second.progress.kills).toBe(300);
    expect(second.progress.eliteKills).toBe(0);
  });

  it('纯函数:入参进度不被改动', () => {
    const p = createProgress();
    const before = JSON.stringify(p);
    evaluateRun(p, { result: RESULT_WIN, kills: 300, eliteKills: 14 });
    expect(JSON.stringify(p)).toBe(before);
  });
});

describe('evaluateRun:已解锁不重复', () => {
  it('同局喂两次,新解锁位为零,掩码不回退', () => {
    const run = { result: RESULT_WIN, kills: 300, eliteKills: 14 } as const;
    const first = evaluateRun(createProgress(), run);
    const again = evaluateRun(first.progress, run);
    expect(first.newUnlocks).not.toBe(0);
    expect(again.newUnlocks).toBe(0);
    expect(again.progress.unlockMask).toBe(first.progress.unlockMask);
  });

  it('已解锁条件即使之后不满足也不会关回去(单调:进度只进不退)', () => {
    const opened = evaluateRun(createProgress(), { ...idleRun(), kills: 300 });
    const later = evaluateRun(opened.progress, idleRun()); // 后面一局 0 杀
    expect(later.progress.unlockMask).toBe(opened.progress.unlockMask);
  });
});

describe('mergeProgress:单调合并', () => {
  it('掩码取并、计数器取最大', () => {
    const a = evaluateRun(createProgress(), {
      result: RESULT_WIN,
      kills: 300,
      eliteKills: 0,
    }).progress;
    const b = evaluateRun(createProgress(), {
      ...idleRun(),
      eliteKills: 14,
    }).progress;
    const m = mergeProgress(a, b);
    expect(m.unlockMask).toBe((1 << UNLOCKS.length) - 1);
    expect(m.wins).toBe(1);
    expect(m.kills).toBe(300);
    expect(m.eliteKills).toBe(14);
    // 任何一边都不会把另一边拉回去
    expect(mergeProgress(createProgress(), a).unlockMask).toBe(a.unlockMask);
  });
});

describe('序列化:JSON 往返与兜底', () => {
  it('序列化 → 解析等值往返', () => {
    const p = evaluateRun(
      evaluateRun(createProgress(), {
        result: RESULT_WIN,
        kills: 320,
        eliteKills: 15,
      }).progress,
      idleRun(),
    ).progress;
    expect(parseProgress(serializeProgress(p))).toEqual(p);
  });

  it('损坏输入兜底 null:非法 JSON / 缺字段 / 类型错', () => {
    expect(parseProgress('not json')).toBeNull();
    expect(parseProgress('{"unlockMask":1}')).toBeNull(); // 缺三个字段
    expect(
      parseProgress(
        JSON.stringify({ unlockMask: 1, wins: 'x', kills: 0, eliteKills: 0 }),
      ),
    ).toBeNull();
  });

  it('载入夹取:越界掩码位裁掉、计数器夹非负整数;旧档多出的剪影字段被忽略', () => {
    const loaded = parseProgress(
      JSON.stringify({
        unlockMask: (1 << UNLOCKS.length) - 1 | 1 << UNLOCKS.length, // 混进一个越界高位
        wins: -3,
        kills: 2.5,
        eliteKills: 10,
        silhouettes: Array.from({ length: 40 }, (_, i) => `s${i}`), // 旧版字段:直接忽略
      }),
    );
    expect(loaded).not.toBeNull();
    const p = loaded!;
    expect(p.unlockMask).toBe((1 << UNLOCKS.length) - 1); // 越界位被裁
    expect(p.wins).toBe(0); // 负数夹 0
    expect(p.kills).toBe(2); // 取整
    expect(p).not.toHaveProperty('silhouettes'); // 删掉的字段不再出现在解析结果里
  });
});

describe('unlockMask 编码与 sim/upgrade.ts 的位约定一致', () => {
  it('位 i = UNLOCKS[i]:只满足第 i 条的进度,新解锁位 = 1<<i', () => {
    for (let i = 0; i < UNLOCKS.length; i++) {
      const u = UNLOCKS[i]!;
      const run: RunStats = { ...idleRun() };
      if (u.condition.kind === COND_FIRST_WIN) run.result = RESULT_WIN;
      if (u.condition.kind === COND_KILLS) run.kills = u.condition.target;
      if (u.condition.kind === COND_ELITE_KILLS) run.eliteKills = u.condition.target;
      const r = evaluateRun(createProgress(), run);
      // 20 号起同一读数上允许出现多条阈值(单局击杀 150/300):喂第 i 条阈值时,
      // 同族里阈值更低(≤)的兄弟必然跟着开 —— 那是条件本身蕴涵的,不算误开。
      // 只把这些蕴涵位让出来,其余位仍然一个都不许多开(隔离断言的强度不变)
      let implied = 0;
      for (let j = 0; j < UNLOCKS.length; j++) {
        const s = UNLOCKS[j]!;
        if (j === i || s.condition.kind !== u.condition.kind) continue;
        if (u.condition.kind === COND_KILLS || u.condition.kind === COND_ELITE_KILLS) {
          if (s.condition.target <= u.condition.target) implied |= 1 << j;
        } else {
          implied |= 1 << j; // 非阈值族(首次胜利):同 kind 即同时达标
        }
      }
      const others = (1 << UNLOCKS.length) - 1 & ~(1 << i) & ~implied;
      expect(r.newUnlocks & (1 << i), `${u.id} 的解锁位不是 1<<${i}`).not.toBe(0);
      expect(r.newUnlocks & others, `${u.id} 误开了别的锁`).toBe(0);
    }
  });

  it('全条件满足的掩码 = (1 << UNLOCKS.length) - 1,正是 upgrade.test 里"全解锁"的 MASK_ALL', () => {
    const all = evaluateRun(createProgress(), {
      result: RESULT_WIN,
      kills: 300,
      eliteKills: 14,
    }).progress;
    expect(all.unlockMask).toBe((1 << UNLOCKS.length) - 1);
  });

  it('evaluateRun 算出的掩码被 upgrade.ts 闸门直接消费:全解锁下导弹巢可被掷中', () => {
    const weapons = createWeaponSlots();
    const edicts = createEdictLevels();
    const mask = evaluateRun(createProgress(), {
      result: RESULT_WIN,
      kills: 300,
      eliteKills: 14,
    }).progress.unlockMask;
    // 沿 upgrade.test.ts 逐型喂掷值的既有口径:kind 掷 0.1 = 新武器,
    // 武器池 = 型号升序剔除合成结果塔 —— 全解锁掩码下每一型(含导弹巢)都必须掷得中
    const towerPool: number[] = [];
    for (let t = 0; t < TOWER_KIND_COUNT; t++) {
      if (!isMergeResult(t)) towerPool.push(t);
    }
    for (const [pos, type] of towerPool.entries()) {
      const out: UpgradeOption[] = [];
      const rng = new CountingRng([0.01, (pos + 0.5) / towerPool.length]);
      expect(rollUpgradeOffer(rng as unknown as Rng, out, edicts, mask, weapons)).toBeGreaterThan(0);
      expect(out[0]).toEqual({ kind: OFFER_NEW_WEAPON, type, level: 0 });
    }
  });
});
