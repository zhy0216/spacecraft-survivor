/**
 * 条件式解锁表(19 号 issue T1)的表级不变量。
 * 与 data/edicts.test.ts / data/waves.test.ts 同口径:钉的不是存档读写(那在 sim/progress.ts,
 * 后续 issue),而是**数据表本身的口径** —— 条目齐全且 id 唯一、三类内容各自引用合法型号、
 * 条件字段合法、判定函数与表逐条对得上、解锁引用与 waves.ts 的槽位互相咬合。
 *
 * 调解锁条件时随便改阈值是被鼓励的(那正是本表存在的理由),但改坏这几条就是改坏了机制本身:
 * 把 UNLOCK_ELITE 的 type 指到一个不存在的槽位,玩家永远解不开那件事;
 * 把条件类型改成未知编号,unlockMet 就会悄悄把它当"无条件"放行 —— 锁形同虚设。
 */
import { describe, expect, it } from 'vitest';
import { EDICT_KIND_COUNT, EDICTS } from './edicts';
import { isMergeResult } from './merges';
import { TOWER_KIND_COUNT, TOWERS } from './towers';
import {
  COND_ELITE_KILLS,
  COND_FIRST_WIN,
  COND_KILLS,
  UNLOCK_COUNT,
  UNLOCK_EDICT,
  UNLOCK_ELITE,
  UNLOCK_TOWER,
  unlockMet,
  UNLOCKS,
  type UnlockEntry,
  type UnlockProgress,
} from './unlocks';
import { WAVE_LOCKED_ELITES } from './waves';

/** 三类条件的合法编号集合:未知编号在 unlockMet 里会落进 default,测试钉住 */
const COND_KINDS = [COND_FIRST_WIN, COND_KILLS, COND_ELITE_KILLS];
const UNLOCK_KINDS = [UNLOCK_TOWER, UNLOCK_EDICT, UNLOCK_ELITE];

describe('条件式解锁表', () => {
  it('条目齐全,id 唯一且非空', () => {
    expect(UNLOCK_COUNT).toBe(UNLOCKS.length);
    expect(UNLOCKS.length).toBeGreaterThan(0);
    const ids = UNLOCKS.map((u) => u.id);
    for (const id of ids) expect(id.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const u of UNLOCKS) expect(u.name.length).toBeGreaterThan(0);
  });

  it('三类解锁项各自引用合法型号:塔/法令落在表内,精英落在槽位内', () => {
    for (const u of UNLOCKS) {
      expect(UNLOCK_KINDS).toContain(u.kind);
      if (u.kind === UNLOCK_TOWER) {
        expect(u.type).toBeGreaterThanOrEqual(0);
        expect(u.type).toBeLessThan(TOWER_KIND_COUNT);
        expect(TOWERS[u.type], `塔型 ${u.type} 没有塔`).toBeDefined();
        expect(isMergeResult(u.type), `塔型 ${u.type} 是合成结果,不该走解锁入池`).toBe(false);
      } else if (u.kind === UNLOCK_EDICT) {
        expect(u.type).toBeGreaterThanOrEqual(0);
        expect(u.type).toBeLessThan(EDICT_KIND_COUNT);
        expect(EDICTS[u.type], `法令 ${u.type} 没有条目`).toBeDefined();
      } else {
        // UNLOCK_ELITE:引用 = WAVE_LOCKED_ELITES 下标,且槽位的 unlockId 与条目 id 同串(waves.test 反向钉过)
        expect(Number.isInteger(u.type)).toBe(true);
        expect(u.type).toBeGreaterThanOrEqual(0);
        expect(u.type).toBeLessThan(WAVE_LOCKED_ELITES.length);
        expect(WAVE_LOCKED_ELITES[u.type]!.unlockId).toBe(u.id);
      }
    }
  });

  it('同一内容不被两条条件重复锁住(每条锁指向唯一的解锁项)', () => {
    const seen = new Set<string>();
    for (const u of UNLOCKS) {
      const key = `${u.kind}:${u.type}`;
      expect(seen.has(key), `${key} 被多条解锁条目引用`).toBe(false);
      seen.add(key);
    }
  });

  it('条件字段合法:编号都在表内,阈值类型的 target > 0,非阈值类型恒 0', () => {
    for (const u of UNLOCKS) {
      expect(COND_KINDS, `${u.id} 的条件编号非法`).toContain(u.condition.kind);
      if (u.condition.kind === COND_FIRST_WIN) {
        expect(u.condition.target, `${u.id} 的非阈值条件不该有 target`).toBe(0);
      } else {
        expect(Number.isInteger(u.condition.target)).toBe(true);
        expect(u.condition.target, `${u.id} 的阈值必须为正`).toBeGreaterThan(0);
      }
    }
  });

  it('unlockMet 逐条与表对得上:阈值不到恒不开,到了才开', () => {
    const zero: UnlockProgress = { wins: 0, kills: 0, eliteKills: 0 };
    for (const u of UNLOCKS) {
      // 全零进度:首次胜利锁、击杀锁、精英锁全都关着
      expect(unlockMet(u, zero), `${u.id} 全零进度`).toBe(false);
    }

    // 逐条喂到刚达标:恰好等于阈值的那一格必须开(条件达成即记,不差一格)
    for (const u of UNLOCKS) {
      const p: UnlockProgress = { wins: 0, kills: 0, eliteKills: 0 };
      if (u.condition.kind === COND_FIRST_WIN) p.wins = 1;
      if (u.condition.kind === COND_KILLS) p.kills = u.condition.target;
      if (u.condition.kind === COND_ELITE_KILLS) p.eliteKills = u.condition.target;
      expect(unlockMet(u, p), `${u.id} 阈值恰好达标`).toBe(true);
    }
  });

  it('判定单调:条件各算各的账,别的进度拉满也顶替不了本条;达标后只进不开', () => {
    for (const u of UNLOCKS) {
      const t = u.condition.target;
      // 本条读数差一格,其它读数抬到天上去:不许开(击杀锁不能被精英击杀顶替,反之亦然)
      const below: UnlockProgress = { wins: 0, kills: 0, eliteKills: 0 };
      if (u.condition.kind === COND_FIRST_WIN) {
        below.wins = 0;
        below.kills = 1e6;
        below.eliteKills = 1e6;
      } else if (u.condition.kind === COND_KILLS) {
        below.kills = t - 1;
        below.wins = 100;
        below.eliteKills = 1e6;
      } else if (u.condition.kind === COND_ELITE_KILLS) {
        below.eliteKills = t - 1;
        below.wins = 100;
        below.kills = 1e6;
      }
      expect(unlockMet(u, below), `${u.id} 差一格 + 别的进度拉满`).toBe(false);

      // 达标后再加:已经开的必须保持开(单调,不因别的进度变化关回去)
      const met: UnlockProgress = { wins: 0, kills: 0, eliteKills: 0 };
      if (u.condition.kind === COND_FIRST_WIN) met.wins = 1;
      if (u.condition.kind === COND_KILLS) met.kills = t;
      if (u.condition.kind === COND_ELITE_KILLS) met.eliteKills = t;
      expect(unlockMet(u, met), `${u.id} 阈值恰好达标`).toBe(true);
      met.wins += 5;
      met.kills += 500;
      met.eliteKills += 50;
      expect(unlockMet(u, met), `${u.id} 达标后再加,不该关回去`).toBe(true);
    }
  });

  it('未知条件编号落进 default:表内不许出现,判定侧对伪造条目不崩溃', () => {
    // unlockMet 的 default 分支放行未知编号。写错条件编号会静默解锁 ——
    // 这条用例在"新增条件类型但忘了改判定"时当场报警
    const fake: UnlockEntry = {
      id: 'fake',
      name: '假条目',
      kind: UNLOCK_TOWER,
      type: 0,
      condition: { kind: 99, target: 0 },
    };
    expect(unlockMet(fake, { wins: 0, kills: 0, eliteKills: 0 })).toBe(true);
    // 但真表里不许出现这样的条目(上一条用例已钉住编号合法性)
    expect(UNLOCKS.some((u) => !COND_KINDS.includes(u.condition.kind))).toBe(false);
  });
});
