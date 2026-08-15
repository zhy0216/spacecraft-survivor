/**
 * 展示层 presenter 测试(03 号)—— edictText / upgradeText / behaviorText / unlockText。
 * 与 contentText.test 同一套初始化手法:beforeEach 现 initI18n('zh-CN'),
 * 测英文时在用例内 changeLocale('en')。钉的是:
 *   - edictDesc:系限定/全船各一条,双语输出与 zh 数值格式(×1.25 / +15 / -0.3s / ×0.8)对齐;
 *   - edictScopeLabel:系限定 = 系名,全船 = content.edicts.scope.all;
 *   - edictSummaryText:全中性法令回落破折号,不印空串;
 *   - optionLabel:武器 + 法令两条,双语;
 *   - behaviorName:越界 → 本地化错误且带原始编号;
 *   - unlockConditionText:三种条件 + unlockName 按 id 查翻译。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { EDICT_AMMO, EDICT_ARMOR, EDICT_BOOST, EDICT_OVERDRIVE, EDICTS } from '../../data/edicts';
import { TOWER_AUTOCANNON } from '../../data/towers';
import { UNLOCKS } from '../../data/unlocks';
import { changeLocale, initI18n } from '../../i18n';
import { OFFER_EDICT, OFFER_NEW_WEAPON } from '../../sim/upgrade';
import { behaviorName } from './behaviorText';
import { edictDesc, edictScopeLabel, edictSummaryText } from './edictText';
import { unlockConditionText, unlockName } from './unlockText';
import { optionLabel } from './upgradeText';

describe('edictText presenter', () => {
  beforeEach(async () => {
    await initI18n('zh-CN');
  });

  it('edictDesc:系限定法令 = 系名 + 系内乘法档(zh 数值逐字)', () => {
    expect(edictScopeLabel(EDICTS[EDICT_AMMO]!)).toBe('弹药系');
    expect(edictDesc(EDICTS[EDICT_AMMO]!)).toBe('弹药系 射速 ×1.25 / 装填 ×0.7');
  });

  it('edictDesc:全船法令 = 全船前缀 + 加点/减伤/伤害/机动/经济档', () => {
    expect(edictScopeLabel(EDICTS[EDICT_ARMOR]!)).toBe('全船');
    expect(edictDesc(EDICTS[EDICT_ARMOR]!)).toBe('全船 · 船体 HP +15 · 受击 ×0.8');
    expect(edictDesc(EDICTS[EDICT_OVERDRIVE]!)).toBe('全船 · 全武器伤害 ×1.15');
    expect(edictDesc(EDICTS[EDICT_BOOST]!)).toBe('全船 · 加速冷却 -0.3s');
  });

  it('en:同一法令双语文案不同,数值格式仍对齐', async () => {
    await changeLocale('en');
    expect(edictScopeLabel(EDICTS[EDICT_AMMO]!)).toBe('Ammo-fed');
    expect(edictDesc(EDICTS[EDICT_AMMO]!)).toBe('Ammo-fed Fire rate ×1.25 / Reload ×0.7');
    expect(edictScopeLabel(EDICTS[EDICT_ARMOR]!)).toBe('All');
    expect(edictDesc(EDICTS[EDICT_ARMOR]!)).toBe('All · Hull HP +15 · Damage taken ×0.8');
  });

  it('edictSummaryText:全中性法令回落破折号,不印空串', () => {
    const neutral = { ...EDICTS[EDICT_AMMO]!, fireRateMul: 1, reloadMul: 1 };
    expect(edictSummaryText(neutral)).toBe('弹药系:—');
  });
});

describe('upgradeText optionLabel', () => {
  beforeEach(async () => {
    await initI18n('zh-CN');
  });

  it('武器卡 = 塔名,法令卡 = 法令名', () => {
    expect(optionLabel({ kind: OFFER_NEW_WEAPON, type: TOWER_AUTOCANNON, level: 0 })).toBe('自动机炮');
    expect(optionLabel({ kind: OFFER_EDICT, type: EDICT_AMMO, level: 0 })).toBe('弹药协议');
  });

  it('en:同型号显示英文', async () => {
    await changeLocale('en');
    expect(optionLabel({ kind: OFFER_NEW_WEAPON, type: TOWER_AUTOCANNON, level: 0 })).toBe('Auto Cannon');
    expect(optionLabel({ kind: OFFER_EDICT, type: EDICT_AMMO, level: 0 })).toBe('Ammo Protocol');
  });
});

describe('behaviorText', () => {
  beforeEach(async () => {
    await initI18n('zh-CN');
  });

  it('越界行为码 → 本地化错误且带原始编号,不静默兜底', () => {
    expect(behaviorName(99)).toBe('未知行为 #99');
  });
});

describe('unlockText', () => {
  beforeEach(async () => {
    await initI18n('zh-CN');
  });

  it('unlockName 按解锁 id 查 content.unlocks 翻译', () => {
    expect(unlockName(UNLOCKS[0]!)).toBe('导弹巢');
    expect(unlockName(UNLOCKS[1]!)).toBe('超载协议');
    expect(unlockName(UNLOCKS[2]!)).toBe('虫群母巢');
  });

  it('unlockConditionText:三种条件各有文案(阈值走 formatNumber)', () => {
    expect(unlockConditionText(UNLOCKS[0]!)).toBe('首次胜利');
    expect(unlockConditionText(UNLOCKS[1]!)).toBe('单局击杀 300');
    expect(unlockConditionText(UNLOCKS[2]!)).toBe('累计精英击杀 14');
  });

  it('en:解锁名与条件文案本地化', async () => {
    await changeLocale('en');
    expect(unlockName(UNLOCKS[2]!)).toBe('Hive Queen');
    expect(unlockConditionText(UNLOCKS[0]!)).toBe('First victory');
    expect(unlockConditionText(UNLOCKS[1]!)).toBe('300 kills in a run');
    expect(unlockConditionText(UNLOCKS[2]!)).toBe('14 elite kills total');
  });
});
