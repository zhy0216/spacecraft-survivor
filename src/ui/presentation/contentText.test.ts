/**
 * contentText presenter 测试 —— 数值编号 → 玩家文案的唯一映射层(03 号)。
 * 与 src/i18n/i18n.test.ts 同一条初始化手法:beforeEach 现 initI18n('zh-CN'),
 * 测英文时在用例内 changeLocale('en')。钉的是:
 *   - 已知类型在两个语言下都产出正确名字;
 *   - 越界数值 → 本地化错误文案且带原始编号(不静默兜底成第 0 种);
 *   - KIND_BOSS(表外哨兵)→ Boss 名,不走越界错误;
 *   - 全表遍历:界内结果非空、不出现 未知/Unknown、也不是缺 key 的原始路径 ——
 *     这一条同时钉住「slug 与编号 1:1、content 资源与 slug 对齐」。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { changeLocale, initI18n } from '../../i18n';
import { AFFIXES, AFFIX_FRENZY, AFFIX_MAGNETIC } from '../../data/affixes';
import { ENEMIES, KIND_BOSS, KIND_SWARM } from '../../data/enemies';
import { EDICTS, EDICT_AMMO, EDICT_OVERDRIVE } from '../../data/edicts';
import {
  THR_AMMO,
  THR_CHARGE,
  THR_HEAT,
  TOWER_AUTOCANNON,
  TOWER_MISSILE_NEST,
  TOWERS,
} from '../../data/towers';
import { WAVE_SEGMENTS } from '../../data/waves';
import {
  affixDescription,
  affixName,
  bossName,
  edictName,
  enemyName,
  throttleFamilyName,
  towerName,
  waveSegmentName,
} from './contentText';

describe('contentText presenter', () => {
  beforeEach(async () => {
    await initI18n('zh-CN');
  });

  it('zh-CN 已知类型的中文名与数据表当前 name 一致', () => {
    expect(towerName(TOWER_AUTOCANNON)).toBe('自动机炮');
    expect(towerName(TOWER_MISSILE_NEST)).toBe('导弹巢');
    expect(enemyName(KIND_SWARM)).toBe('蜂群蛭');
    expect(edictName(EDICT_AMMO)).toBe('弹药协议');
    expect(edictName(EDICT_OVERDRIVE)).toBe('超载协议');
    expect(affixName(AFFIX_FRENZY)).toBe('狂热光环');
    expect(affixDescription(AFFIX_MAGNETIC)).toBe('玩家拾取半径 ×0.5');
    expect(waveSegmentName(0)).toBe('离港航道');
    expect(throttleFamilyName(THR_AMMO)).toBe('弹药系');
    expect(throttleFamilyName(THR_HEAT)).toBe('过热系');
    expect(throttleFamilyName(THR_CHARGE)).toBe('充能系');
  });

  it('en 已知类型的英文名', async () => {
    await changeLocale('en');
    expect(towerName(TOWER_AUTOCANNON)).toBe('Auto Cannon');
    expect(towerName(TOWER_MISSILE_NEST)).toBe('Missile Nest');
    expect(enemyName(KIND_SWARM)).toBe('Swarm Leech');
    expect(edictName(EDICT_AMMO)).toBe('Ammo Protocol');
    expect(edictName(EDICT_OVERDRIVE)).toBe('Overdrive Protocol');
    expect(affixName(AFFIX_FRENZY)).toBe('Frenzy');
    expect(affixDescription(AFFIX_MAGNETIC)).toBe('Your pickup radius is ×0.5.');
    expect(waveSegmentName(0)).toBe('Departure Lane');
    expect(throttleFamilyName(THR_AMMO)).toBe('Ammo-fed');
  });

  it('KIND_BOSS(表外哨兵)返回 Boss 名,不走越界错误', () => {
    expect(enemyName(KIND_BOSS)).toBe('母巢巨兽');
    expect(bossName()).toBe('母巢巨兽');
  });

  it('越界数值 → 本地化错误文案,且含原始编号(不静默兜底成第 0 种)', () => {
    expect(towerName(999)).toBe('未知武器 #999');
    expect(enemyName(-1)).toBe('未知敌人 #-1');
    expect(edictName(999)).toBe('未知法令 #999');
    expect(affixName(999)).toBe('未知词缀 #999');
    expect(affixDescription(999)).toBe('未知词缀 #999');
    expect(waveSegmentName(999)).toBe('未知航段 #999');
    expect(throttleFamilyName(999)).toBe('未知节流系 #999');
  });

  it('en 越界错误同样本地化', async () => {
    await changeLocale('en');
    expect(towerName(999)).toBe('Unknown weapon #999');
    expect(enemyName(999)).toBe('Unknown enemy #999');
    expect(throttleFamilyName(-1)).toBe('Unknown throttle family #-1');
  });

  it('slug 与编号 1:1:全表遍历 presenter,界内结果非空、不出现 未知/Unknown、也不是缺 key 路径(双语各走一遍)', async () => {
    const walk = (): void => {
      for (let i = 0; i < TOWERS.length; i++) {
        const s = towerName(i);
        expect(s.length, `塔 ${i}`).toBeGreaterThan(0);
        expect(s, `塔 ${i}`).not.toMatch(/未知|Unknown|^content:/);
      }
      for (let i = 0; i < ENEMIES.length; i++) {
        const s = enemyName(i);
        expect(s.length, `敌 ${i}`).toBeGreaterThan(0);
        expect(s, `敌 ${i}`).not.toMatch(/未知|Unknown|^content:/);
      }
      for (let i = 0; i < EDICTS.length; i++) {
        const s = edictName(i);
        expect(s.length, `法令 ${i}`).toBeGreaterThan(0);
        expect(s, `法令 ${i}`).not.toMatch(/未知|Unknown|^content:/);
      }
      for (let i = 0; i < AFFIXES.length; i++) {
        const n = affixName(i);
        const d = affixDescription(i);
        expect(n.length, `词缀 ${i}`).toBeGreaterThan(0);
        expect(d.length, `词缀 ${i}`).toBeGreaterThan(0);
        expect(n, `词缀 ${i}`).not.toMatch(/未知|Unknown|^content:/);
        expect(d, `词缀 ${i}`).not.toMatch(/未知|Unknown|^content:/);
      }
      for (let i = 0; i < WAVE_SEGMENTS.length; i++) {
        const s = waveSegmentName(i);
        expect(s.length, `航段 ${i}`).toBeGreaterThan(0);
        expect(s, `航段 ${i}`).not.toMatch(/未知|Unknown|^content:/);
      }
    };
    walk();
    await changeLocale('en');
    walk();
  });
});
