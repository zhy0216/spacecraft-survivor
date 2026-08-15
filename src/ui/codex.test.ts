/**
 * 图鉴页(ui/codex.ts)。主体测的是那几个**纯函数** —— 图鉴上到底显示了什么:
 * 锁定判定、悬停行(尤其 **1★/2★/3★ 星级三档读数**)、合成武器变身、每行配了哪张图,
 * 哪一条错都只是几行字符串拼接,却要等真人进一次图鉴才看得见(与 gameOver.test 测
 * summaryText 同一条理由)。
 *
 * 文件末尾破一次例去测 createCodexUi 本身(照 gameOver.test 的先例):
 * 只建一次 / show 整块重排 / 过滤器切档 / 悬停 tooltip / Esc 关页回 onClose / 收着时
 * Esc 不认,六条各错一次的后果(多一份监听器、网格叠两遍、切档没反应、悬停没数值)
 * 都要真人反复开关图鉴才看得出来。桩只提供 createCodexUi 真的会碰的那几样
 * (createElement/getElementById/append + window.addEventListener + getBoundingClientRect +
 *  HTMLElement),绝不发展成半个 jsdom —— 本仓 vitest 跑在 Node 环境里,不装 jsdom。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BOSS, ENEMIES, KIND_BEETLE, KIND_SWARM } from '../data/enemies';
import { EDICT_AMMO, EDICT_BOOST, EDICT_GYRO, EDICT_OVERDRIVE, EDICT_STARCHART, EDICTS } from '../data/edicts';
import {
  THR_CHARGE,
  towerAoeDamage,
  towerChargeTime,
  towerDamage,
  towerFireInterval,
  towerRange,
  TOWERS,
  TOWER_AURORA,
  TOWER_AUTOCANNON,
  TOWER_LASER,
  TOWER_MISSILE_NEST,
  TOWER_MORTAR,
  TOWER_STORM_CANNON,
} from '../data/towers';
import {
  COND_ELITE_KILLS,
  COND_FIRST_WIN,
  COND_KILLS,
  UNLOCKS,
  type UnlockEntry,
} from '../data/unlocks';
import { MERGES } from '../data/merges';
import { BOSS_ART_URL, ENEMY_ART_URLS, TOWER_STAR_ART_URLS } from '../render/artUrls';
import { createProgress, type Progress } from '../sim/progress';
import { changeLocale, initI18n } from '../i18n';
import {
  codexRows,
  codexStatsText,
  codexUnlockStats,
  createCodexUi,
  edictHover,
  eliteHover,
  enemyHover,
  formatMul,
  glyphBadgeSvg,
  starLine,
  tintHex,
  weaponHover,
  type CodexArt,
} from './codex';
import { affixName, bossName, enemyName, weaponDisplayName } from './presentation/contentText';
import { behaviorName } from './presentation/behaviorText';
import { edictSummaryText } from './presentation/edictText';
import { unlockConditionText } from './presentation/unlockText';

/** 全解锁掩码:位 0..UNLOCKS.length-1 全置 1(与 sim/progress.ts 的 FULL_MASK 同编码) */
const FULL_MASK = (1 << UNLOCKS.length) - 1;

beforeEach(async () => {
  await initI18n('zh-CN');
});

function progress(mask: number, over: Partial<Progress> = {}): Progress {
  return { ...createProgress(), unlockMask: mask, ...over };
}

/** svg 配图的内容串;非 svg 配图给空串(断言只关心 svg 那类) */
function svgOf(art: CodexArt | null): string {
  return art !== null && art.kind === 'svg' ? art.svg : '';
}

/** 星级读数的期望串:与 codex 的 starLine 同一组 getter 现算 —— 两边对不上 = 有一边口径错了 */
function starExpected(def: typeof TOWERS[number], stars: number, mortar: boolean): string {
  // 期望串用与实现同源的 getter 算(数值表改档时两边一起走,断言不用回头改)
  const dmg = mortar ? towerAoeDamage(def, stars) : towerDamage(def, stars);
  const range = Math.round(towerRange(def, stars));
  if (def.throttle === THR_CHARGE) {
    return (
      `${'★'.repeat(stars)} ${mortar ? '落点伤害' : '伤害'} ${formatMul(dmg)} · 射程 ${range} · ` +
      `充能 ${formatMul(towerChargeTime(def, stars))}s`
    );
  }
  const interval = towerFireInterval(def, stars);
  return (
    `${'★'.repeat(stars)} ${mortar ? '落点伤害' : '伤害'} ${formatMul(dmg)} · 射程 ${range} · ` +
    `射速 ${formatMul(1 / interval)}/s`
  );
}

/** 同一组读数的英文期望串(08 号:双语输出各有断言,数据改档两边自动跟上) */
function starExpectedEn(def: typeof TOWERS[number], stars: number, mortar: boolean): string {
  const dmg = mortar ? towerAoeDamage(def, stars) : towerDamage(def, stars);
  const range = Math.round(towerRange(def, stars));
  const head = `${'★'.repeat(stars)} ${mortar ? 'AoE damage' : 'Damage'} ${formatMul(dmg)}`;
  if (def.throttle === THR_CHARGE) {
    return `${head} · Range ${range} · Charge ${formatMul(towerChargeTime(def, stars))}s`;
  }
  const interval = towerFireInterval(def, stars);
  return `${head} · Range ${range} · Fire rate ${formatMul(1 / interval)}/s`;
}

describe('unlockConditionText', () => {
  it('三种条件各有文案(将来新增条件漏配也能读出一句)', () => {
    const cases: Array<[number, string]> = [
      [COND_FIRST_WIN, '首次胜利'],
      [COND_KILLS, '单局击杀 300'],
      [COND_ELITE_KILLS, '累计精英击杀 14'],
    ];
    for (const [kind, text] of cases) {
      const entry: UnlockEntry = {
        id: 'x',
        devName: 'x',
        kind: 0,
        type: 0,
        condition: { kind, target: kind === COND_KILLS ? 300 : kind === COND_ELITE_KILLS ? 14 : 0 },
      };
      expect(unlockConditionText(entry)).toBe(text);
    }
  });
});

describe('behaviorName', () => {
  it('五种行为各有一行短标签(文案与 content.behaviors 一致)', () => {
    expect(behaviorName(0)).toBe('直线追船');
    expect(behaviorName(1)).toBe('侧向驻留');
    expect(behaviorName(2)).toBe('侧向冲锋');
    expect(behaviorName(3)).toBe('直线冲锋');
    expect(behaviorName(4)).toBe('远程喷吐');
  });

  it('未知行为码印本地化错误且带原始编号,不静默兜底(与 resultTitle 的未知码同一口径)', () => {
    expect(behaviorName(99)).toBe('未知行为 #99');
  });
});

describe('formatMul / edictSummaryText', () => {
  it('数值印法:两位小数内舍入、尾零省掉', () => {
    expect(formatMul(1.25)).toBe('1.25');
    expect(formatMul(1.5)).toBe('1.5');
    expect(formatMul(0.7)).toBe('0.7');
  });

  it('系限定法令:前缀作用系,摘要只印非中性字段(短语与 edictDesc 同源)', () => {
    expect(edictSummaryText(EDICTS[EDICT_AMMO]!)).toBe('弹药系:射速 ×1.25 · 装填 ×0.7');
  });

  it('全船档:前缀「全船」;加法档印点数、概率档换算百分点', () => {
    expect(edictSummaryText(EDICTS[EDICT_OVERDRIVE]!)).toBe('全船:全武器伤害 ×1.15');
    expect(edictSummaryText(EDICTS[EDICT_GYRO]!)).toBe('全船:转向 +10°/s');
    expect(edictSummaryText(EDICTS[EDICT_STARCHART]!)).toBe('全船:星币概率 +5%');
    expect(edictSummaryText(EDICTS[EDICT_BOOST]!)).toBe('全船:加速冷却 -0.3s');
  });

  it('全中性字段(被改坏的条目)回落成破折号,不印空串', () => {
    const neutral = { ...EDICTS[EDICT_AMMO]!, fireRateMul: 1, reloadMul: 1 };
    expect(edictSummaryText(neutral)).toBe('弹药系:—');
  });
});

describe('tintHex / glyphBadgeSvg', () => {
  it('数字 tint → #rrggbb,高位丢 0 也补到六位', () => {
    expect(tintHex(0x9adcff)).toBe('#9adcff');
    expect(tintHex(0x2b4a6e)).toBe('#2b4a6e');
    expect(tintHex(0x0000ff)).toBe('#0000ff');
  });

  it('徽章带字形与 tint(暗底圆盘 + 虚环 + 中心字),与升级卡片同一套字形身份', () => {
    const svg = glyphBadgeSvg('▦', '#123456');
    expect(svg).toContain('<svg');
    expect(svg).toContain('▦');
    expect(svg).toContain('#123456');
  });
});

describe('codexStatsText / codexUnlockStats', () => {
  it('统计行:三个累计计数器', () => {
    expect(codexStatsText(progress(0, { wins: 3, kills: 1280, eliteKills: 9 }))).toBe(
      '胜场 3 · 总击杀 1280 · 精英击杀 9',
    );
  });

  it('内容解锁计数:空进度 0/3,全解锁 3/3', () => {
    expect(codexUnlockStats(progress(0))).toEqual({ unlocked: 0, total: 3 });
    expect(codexUnlockStats(progress(FULL_MASK))).toEqual({ unlocked: 3, total: 3 });
  });
});

describe('codexRows', () => {
  it('分区顺序与过滤器键:武器 → 敌人 → 法令', () => {
    const sections = codexRows(progress(0));
    expect(sections.map((s) => s.title)).toEqual(['武器', '敌人', '法令']);
    expect(sections.map((s) => s.key)).toEqual(['weapons', 'enemies', 'edicts']);
  });

  it('武器只列基础型号(合成武器不单独成行):悬停三档星级读数全印,3★ 档印变身数值与去向', () => {
    const weapons = codexRows(progress(0))[0]!.rows;
    expect(weapons.length).toBe(TOWERS.length - MERGES.length);
    const auto = weapons.find((r) => r.id === String(TOWER_AUTOCANNON))!;
    expect(auto.locked).toBe(false);
    expect(auto.art).toEqual({ kind: 'stars', urls: TOWER_STAR_ART_URLS[0] });
    expect(auto.art?.kind === 'stars' && auto.art.urls[1]).not.toBe(TOWER_STAR_ART_URLS[0]![0]);
    expect(auto.art?.kind === 'stars' && auto.art.urls[2]).not.toBe(TOWER_STAR_ART_URLS[0]![0]);
    const def = TOWERS[0]!;
    expect(auto.hover[0]).toBe('自动机炮 · 弹药系');
    expect(auto.hover[1]).toBe(starExpected(def, 1, false));
    expect(auto.hover[2]).toBe(starExpected(def, 2, false));
    // 3★ 档印的是风暴机炮的数值:合到 3★ 那一刻就变身,游戏里没有"没变身的 3★ 机炮"
    expect(auto.hover[3]).toBe(starExpected(TOWERS[TOWER_STORM_CANNON]!, 3, false));
    expect(auto.hover[4]).toBe('★★★ 变身 风暴机炮');
    // 成长曲线确实在涨:★★/★★★ 的伤害与 ★ 不同(这正是旧版图鉴漏印的两行)
    expect(auto.hover[2]).not.toContain(`★★ 伤害 ${formatMul(def.damage)}`);
  });

  it('全部塔型都有独立的三档星级贴图,合成塔沿用对应血统清单', () => {
    expect(TOWER_STAR_ART_URLS).toHaveLength(TOWERS.length);
    for (const urls of TOWER_STAR_ART_URLS) {
      expect(urls).toHaveLength(3);
      expect(new Set(urls).size).toBe(3);
    }
  });

  it('迫击炮类:落点伤害 + 充能节奏(直击伤害恒 0,不印误导性的 0)', () => {
    const mortar = codexRows(progress(0))[0]!.rows.find(
      (r) => r.id === String(TOWER_MORTAR),
    )!;
    expect(mortar.hover[1]).toBe(starExpected(TOWERS[TOWER_MORTAR]!, 1, true));
    expect(mortar.hover[1]).toContain('落点伤害');
    expect(mortar.hover[1]).toContain('充能');
    expect(mortar.hover[1]).not.toContain('伤害 0');
  });

  it('合成武器不单独成行:底座行的 ★★★ 档印变身数值,末条注明变身去向(用户口径:3★ 就是合成武器)', () => {
    const weapons = codexRows(progress(0))[0]!.rows;
    expect(weapons.find((r) => r.id === String(TOWER_AURORA))).toBeUndefined();
    const laser = weapons.find((r) => r.id === String(TOWER_LASER))!;
    expect(laser.name).toBe(weaponDisplayName(TOWER_LASER));
    expect(laser.hover[0]).toBe('激光棱镜 · 过热系');
    expect(laser.hover[3]).toBe(starExpected(TOWERS[TOWER_AURORA]!, 3, false));
    expect(laser.hover[4]).toBe('★★★ 变身 极光阵列');
    // 贴图仍是底座行自己的血统炮头(round-8 清单)
    expect(laser.art).toEqual({ kind: 'stars', urls: TOWER_STAR_ART_URLS[TOWER_LASER] });
  });

  it('导弹巢:未解锁悬停末条带条件,解锁后只印数值;使用真实炮头贴图', () => {
    const locked = codexRows(progress(0))[0]!.rows.find(
      (r) => r.id === String(TOWER_MISSILE_NEST),
    )!;
    expect(locked.locked).toBe(true);
    expect(locked.hover[locked.hover.length - 1]).toBe('未解锁 · 首次胜利');
    expect(locked.art).toEqual({ kind: 'stars', urls: TOWER_STAR_ART_URLS[TOWER_MISSILE_NEST] });
    const unlocked = codexRows(progress(FULL_MASK))[0]!.rows.find(
      (r) => r.id === String(TOWER_MISSILE_NEST),
    )!;
    expect(unlocked.locked).toBe(false);
    expect(unlocked.hover.some((l) => l.includes('未解锁'))).toBe(false);
  });

  it('敌人:六型 + Boss + 精英事件;悬停报身板与掉落,配图各取各的贴图', () => {
    const enemies = codexRows(progress(0))[1]!.rows;
    expect(enemies.length).toBe(ENEMIES.length + 1 + 1);
    const larvaDef = ENEMIES[0]!;
    const larva = enemies.find((r) => r.id === String(KIND_SWARM))!;
    expect(larva.hover).toEqual([
      `${enemyName(KIND_SWARM)} · ${behaviorName(0)}`,
      `HP ${larvaDef.hp} · 接触 ${larvaDef.contactDamage}`,
      `残骸 ${larvaDef.scrap} · 星币 ${larvaDef.starCoins}`,
    ]);
    expect(larva.art).toEqual({ kind: 'img', urls: [ENEMY_ART_URLS[0]] });
    const beetle = ENEMIES[BOSS.baseKind]!;
    const boss = enemies.find((r) => r.id === 'boss')!;
    expect(boss.hover).toEqual([
      `${bossName()} · 巨型冲锋 · 召唤蜂群`,
      `HP ${Math.round(beetle.hp * BOSS.hpMul)} · 接触 ` +
        `${Math.round(beetle.contactDamage * BOSS.contactDamageMul)}`,
      `星币 ${BOSS.starCoins} · 体型 ×${BOSS.scale}`,
    ]);
    // 读数锚点:按现表 hpMul × 底座 HP 现算(重锚 hpMul 后跟着走,不钉平衡值)
    expect(boss.hover[1]).toContain(
      `HP ${Math.round(beetle.hp * BOSS.hpMul)} · 接触 ` +
        `${Math.round(beetle.contactDamage * BOSS.contactDamageMul)}`,
    );
    expect(boss.art).toEqual({ kind: 'img', urls: [BOSS_ART_URL] });
  });

  it('精英事件条目命名走 collectionItemName(与结算图鉴同源);悬停报词缀名单', () => {
    const elite = codexRows(progress(0))[1]!.rows.find((r) => r.id === 'elite-queen')!;
    expect(elite.locked).toBe(true);
    expect(elite.name).toContain('精英');
    expect(elite.hover[elite.hover.length - 1]).toBe('未解锁 · 累计精英击杀 14');
    // 词缀名单走 presenter(现表:[0,3,4] = 狂热光环/装甲/相位)
    const affixes = elite.hover.find((l) => l.startsWith('词缀'))!;
    expect(affixes).toContain(affixName(0));
    expect(affixes).toContain(affixName(3));
    expect(affixes).toContain(affixName(4));
    // 精英 = 带词缀的底座(冲撞甲虫),图同一张
    expect(elite.art).toEqual({ kind: 'img', urls: [ENEMY_ART_URLS[KIND_BEETLE]] });
    const unlocked = codexRows(progress(FULL_MASK))[1]!.rows.find(
      (r) => r.id === 'elite-queen',
    )!;
    expect(unlocked.locked).toBe(false);
    expect(unlocked.hover.some((l) => l.includes('未解锁'))).toBe(false);
  });

  it('法令全量 10 条:悬停 = 效果摘要 + 叠层上限;超载协议未解锁带条件', () => {
    const edicts = codexRows(progress(0))[2]!.rows;
    expect(edicts.length).toBe(EDICTS.length);
    const over = edicts.find((r) => r.id === String(EDICT_OVERDRIVE))!;
    expect(over.locked).toBe(true);
    expect(over.hover[over.hover.length - 1]).toBe('未解锁 · 单局击杀 300');
    const ammo = edicts.find((r) => r.id === String(EDICT_AMMO))!;
    expect(ammo.locked).toBe(false);
    expect(ammo.hover).toEqual(['弹药系:射速 ×1.25 · 装填 ×0.7', '最多 5 层']);
    expect(ammo.art?.kind).toBe('svg');
    expect(svgOf(ammo.art)).toContain('▦'); // EDICT_ICONS[0]
    expect(svgOf(ammo.art)).toContain(tintHex(EDICTS[EDICT_AMMO]!.tint));
  });
});

// —— 双语输出(08 号):图鉴是内容翻译的验收页,英文侧逐项钉住 ——

describe('codex 英文输出(08 号)', () => {
  it('codexStatsText 英文:胜场 / 总击杀 / 精英击杀', async () => {
    await changeLocale('en');
    expect(codexStatsText(progress(0, { wins: 3, kills: 1280, eliteKills: 9 }))).toBe(
      'Wins 3 · Total kills 1280 · Elite kills 9',
    );
  });

  it('starLine 英文:直击/落点伤害 + 射程 + 射速/充能,★ 符号保留', async () => {
    await changeLocale('en');
    const auto = TOWERS[TOWER_AUTOCANNON]!;
    expect(starLine(auto, 1)).toBe(starExpectedEn(auto, 1, false));
    expect(starLine(auto, 2)).toBe(starExpectedEn(auto, 2, false));
    expect(starLine(auto, 3)).toBe(starExpectedEn(auto, 3, false));
    const mortar = TOWERS[TOWER_MORTAR]!;
    expect(starLine(mortar, 1)).toBe(starExpectedEn(mortar, 1, true));
    expect(starLine(mortar, 1)).toContain('AoE damage');
    expect(starLine(mortar, 1)).toContain('Charge');
    expect(starLine(auto, 1)).toContain('★ Damage');
  });

  it('weaponHover 英文:普通标题 / 3★ 变身行 / 未知型号带编号', async () => {
    await changeLocale('en');
    const auto = weaponHover(TOWER_AUTOCANNON);
    expect(auto[0]).toBe('Auto Cannon · Ammo-fed');
    expect(auto[1]).toBe(starExpectedEn(TOWERS[TOWER_AUTOCANNON]!, 1, false));
    // 3★ 档印合成武器数值,末条报变身去向(合成武器不单独成行)
    expect(auto[3]).toBe(starExpectedEn(TOWERS[TOWER_STORM_CANNON]!, 3, false));
    expect(auto[4]).toBe('Fuses at ★★★ into Storm Cannon');
    // 未知型号:本地化兜底且含原始编号
    expect(weaponHover(999)[0]).toBe('Unknown weapon #999');
  });

  it('enemyHover 英文:身板与掉落逐项翻', async () => {
    await changeLocale('en');
    const larvaDef = ENEMIES[KIND_SWARM]!;
    expect(enemyHover(larvaDef)).toEqual([
      `${enemyName(KIND_SWARM)} · ${behaviorName(0)}`,
      `HP ${larvaDef.hp} · Contact ${larvaDef.contactDamage}`,
      `Scrap ${larvaDef.scrap} · Star coins ${larvaDef.starCoins}`,
    ]);
  });

  it('Boss 悬停英文:巨型冲锋 · 召唤蜂群 + 身板 + 奖励', async () => {
    await changeLocale('en');
    const beetle = ENEMIES[BOSS.baseKind]!;
    const enemies = codexRows(progress(0))[1]!.rows;
    const boss = enemies.find((r) => r.id === 'boss')!;
    expect(boss.hover).toEqual([
      `${bossName()} · Giant charge · Summons swarms`,
      `HP ${Math.round(beetle.hp * BOSS.hpMul)} · Contact ` +
        `${Math.round(beetle.contactDamage * BOSS.contactDamageMul)}`,
      `Star coins ${BOSS.starCoins} · Size ×${BOSS.scale}`,
    ]);
  });

  it('精英条目英文:名称带底座、词缀名单、锁定条件、悬停直出', async () => {
    await changeLocale('en');
    const entry = UNLOCKS[2]!;
    const elite = eliteHover(entry);
    expect(elite[0]).toBe('Hive Queen (Ram Beetle elite)');
    expect(elite).toContain('Affixes Frenzy · Armored · Phased'); // [0,3,4]
    const row = codexRows(progress(0))[1]!.rows.find((r) => r.id === 'elite-queen')!;
    expect(row.locked).toBe(true);
    expect(row.hover[row.hover.length - 1]).toBe('Locked · 14 elite kills total');
    // 全解锁:锁定尾巴消失
    const unlocked = codexRows(progress(FULL_MASK))[1]!.rows.find((r) => r.id === 'elite-queen')!;
    expect(unlocked.locked).toBe(false);
    expect(unlocked.hover.some((l) => l.startsWith('Locked'))).toBe(false);
  });

  it('法令悬停英文:效果摘要 + 叠层上限;未知法令带编号', async () => {
    await changeLocale('en');
    const ammo = edictHover(EDICT_AMMO);
    expect(ammo[0]).toBe('Ammo-fed:Fire rate ×1.25 · Reload ×0.7');
    expect(ammo[1]).toBe('Up to 5 levels');
    expect(edictHover(999)[0]).toBe('Unknown edict #999');
  });

  it('锁定条件英文:首次胜利 / 单局击杀(武器与法令各一);分区标题翻成 Weapons/Enemies/Edicts', async () => {
    await changeLocale('en');
    const sections = codexRows(progress(0));
    expect(sections.map((s) => s.title)).toEqual(['Weapons', 'Enemies', 'Edicts']);
    expect(sections.map((s) => s.key)).toEqual(['weapons', 'enemies', 'edicts']);
    const nest = sections[0]!.rows.find((r) => r.id === String(TOWER_MISSILE_NEST))!;
    expect(nest.locked).toBe(true);
    expect(nest.hover[nest.hover.length - 1]).toBe('Locked · First victory');
    const over = sections[2]!.rows.find((r) => r.id === String(EDICT_OVERDRIVE))!;
    expect(over.locked).toBe(true);
    expect(over.hover[over.hover.length - 1]).toBe('Locked · 300 kills in a run');
  });

  it('双语遍历不串:回到 zh 后输出仍旧是中文(语言切换是全局的,不污染其它用例)', async () => {
    await changeLocale('en');
    expect(codexStatsText(progress(0, { wins: 1 }))).toContain('Wins');
    await changeLocale('zh-CN');
    expect(codexStatsText(progress(0, { wins: 1 }))).toBe('胜场 1 · 总击杀 0 · 精英击杀 0');
  });
});

// —— DOM 接线(照 gameOver.test.ts 的 installDom 桩模式,不装 jsdom)——

interface StubEl {
  tagName: string;
  style: { cssText: string; color: string; display: string; left: string; top: string };
  textContent: string;
  src: string;
  alt: string;
  /** data-content-kind / data-content-id 落在这里(08 号:测试用它们定位行) */
  dataset: Record<string, string>;
  /** 过滤器按钮的 data-filter / 返回按钮的 data-action(08 号:测试用稳定属性定位控件) */
  setAttribute(name: string, value: string): void;
  /** 目录滚动区:refreshLocale 的"保留滚动位置"要读写它 */
  scrollTop: number;
  children: StubEl[];
  listeners: Map<string, (e: unknown) => void>;
  append(...kids: StubEl[]): void;
  appendChild(kid: StubEl): StubEl;
  replaceChildren(...kids: StubEl[]): void;
  addEventListener(type: string, fn: (e: unknown) => void): void;
  getBoundingClientRect(): { left: number; bottom: number };
}

function createStubEl(tag = 'div'): StubEl {
  const el: StubEl = {
    tagName: tag.toUpperCase(),
    style: { cssText: '', color: '', display: '', left: '', top: '' },
    textContent: '',
    src: '',
    alt: '',
    dataset: {},
    setAttribute(name: string, value: string): void {
      const key = name.replace(/^data-/, '');
      el.dataset[key] = value;
    },
    scrollTop: 0,
    children: [],
    listeners: new Map<string, (e: unknown) => void>(),
    append(...kids: StubEl[]): void {
      el.children.push(...kids);
    },
    appendChild(kid: StubEl): StubEl {
      el.children.push(kid);
      return kid;
    },
    replaceChildren(...kids: StubEl[]): void {
      el.children.length = 0;
      el.children.push(...kids);
    },
    addEventListener(type: string, fn: (e: unknown) => void): void {
      el.listeners.set(type, fn);
    },
    getBoundingClientRect(): { left: number; bottom: number } {
      return { left: 10, bottom: 120 };
    },
  };
  return el;
}

interface StubKeyEvent {
  code: string;
  repeat: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
}

function keyEvent(code: string, repeat = false): StubKeyEvent {
  const e: StubKeyEvent = {
    code,
    repeat,
    defaultPrevented: false,
    preventDefault(): void {
      e.defaultPrevented = true;
    },
  };
  return e;
}

interface StubDom {
  /** #ui 覆盖层:遮罩 append 到这里,"重开一局多长出一块"于是一眼数得出来 */
  ui: StubEl;
  /** window.addEventListener 的累计次数:show/hide 多少回都不该让它再涨 */
  windowListeners: number;
  /** 造出来的元素按顺序留档:遮罩 = 第一个 div */
  created: StubEl[];
  key(e: StubKeyEvent): void;
  restore(): void;
}

function installDom(): StubDom {
  const g = globalThis as unknown as Record<string, unknown>;
  const prevWindow = g.window;
  const prevDocument = g.document;
  const prevHtmlElement = g.HTMLElement;
  const keys: Array<(e: StubKeyEvent) => void> = [];

  const dom: StubDom = {
    ui: createStubEl(),
    windowListeners: 0,
    created: [],
    key(e: StubKeyEvent): void {
      for (const fn of keys) fn(e);
    },
    restore(): void {
      g.window = prevWindow;
      g.document = prevDocument;
      g.HTMLElement = prevHtmlElement;
    },
  };

  g.window = {
    innerWidth: 1000, // tooltip 贴边夹取读它
    addEventListener(type: string, fn: (e: StubKeyEvent) => void): void {
      dom.windowListeners++;
      if (type === 'keydown') keys.push(fn);
    },
  };
  g.document = {
    createElement: (tag: string): StubEl => {
      const el = createStubEl(tag);
      dom.created.push(el);
      return el;
    },
    getElementById: (id: string): StubEl | null => (id === 'ui' ? dom.ui : null),
    // isTyping 读它:null = 焦点不在输入框里,于是 Esc 该被当成"关图鉴"
    activeElement: null,
  };
  // Node 里没有 HTMLElement,而 isTyping 拿它做 instanceof —— 不给就直接 ReferenceError
  g.HTMLElement = class HTMLElement {};
  return dom;
}

/** 遮罩 = #ui 的唯一子节点 */
function root(dom: StubDom): StubEl {
  return dom.ui.children[0]!;
}

/** 深度查找:按谓词扫子树,返回第一个命中(卡片名都是 leaf,textContent 可精确匹配) */
function findEl(rootEl: StubEl, pred: (el: StubEl) => boolean): StubEl | undefined {
  if (pred(rootEl)) return rootEl;
  for (const kid of rootEl.children) {
    const hit = findEl(kid, pred);
    if (hit) return hit;
  }
  return undefined;
}

/** 深度收集:按谓词扫子树,返回全部命中(武器卡三档星级缩略图要数出三张图、三个标签) */
function findAll(rootEl: StubEl, pred: (el: StubEl) => boolean): StubEl[] {
  const out: StubEl[] = [];
  const walk = (el: StubEl): void => {
    if (pred(el)) out.push(el);
    for (const kid of el.children) walk(kid);
  };
  walk(rootEl);
  return out;
}

/** 反查父节点:卡片名改挂名称 div 之后,灰显断言要看它父格子的 cssText */
function parentOf(rootEl: StubEl, target: StubEl): StubEl | undefined {
  for (const kid of rootEl.children) {
    if (kid === target) return rootEl;
    const hit = parentOf(kid, target);
    if (hit) return hit;
  }
  return undefined;
}

/** 按 data-content-kind + data-content-id 找卡片格子(08 号:不用本地化名称当唯一身份) */
function findCell(dom: StubDom, kind: string, id: string): StubEl | undefined {
  return findEl(
    root(dom),
    (el) => el.dataset.contentKind === kind && el.dataset.contentId === id,
  );
}

/** 格子的可见文本:名称挂在子 div 上(桩的 textContent 不随子节点派生),取子树最后一个有字的叶子 ——
 * 武器行的艺术框里有星数标签(★/★★/★★★),纯星串的叶子一律跳过,别把标签当成卡片名 */
function cellText(cell: StubEl): string {
  let last = '';
  const walk = (el: StubEl): void => {
    if (el.textContent.length > 0 && !/^★+$/.test(el.textContent)) last = el.textContent;
    for (const kid of el.children) walk(kid);
  };
  walk(cell);
  return last;
}

/** 悬停 tooltip:整页唯一那个 fixed 定位、pointer-events:none 的 div */
function tip(dom: StubDom): StubEl {
  return dom.created.find(
    (el) => el.style.cssText.includes('position:fixed') && el.style.cssText.includes('pointer-events:none'),
  )!;
}

/** 高清看图 viewer:整页唯一那个带 zoom-out 光标的遮罩层 */
function viewerEl(dom: StubDom): StubEl {
  return dom.created.find((el) => el.style.cssText.includes('cursor:zoom-out'))!;
}

describe('createCodexUi', () => {
  let dom: StubDom;
  let closes: number;

  beforeEach(() => {
    dom = installDom();
    closes = 0;
  });
  afterEach(() => {
    dom.restore();
  });

  function make(): ReturnType<typeof createCodexUi> {
    return createCodexUi({
      getProgress: () => progress(0, { wins: 1, kills: 100, eliteKills: 2 }),
      onClose: () => {
        closes++;
      },
    });
  }

  it('默认收着;show 弹出、hide 收回', () => {
    const ui = make();
    // 默认 none 落在构造时的 cssText 里(桩不解析 cssText,照 gameOver.test 同款断言)
    expect(root(dom).style.cssText).toContain('display:none');
    ui.show();
    expect(root(dom).style.display).toBe('flex');
    ui.hide();
    expect(root(dom).style.display).toBe('none');
  });

  it('show 整块重排:标题带计数、卡片图上名下、锁定卡灰显', () => {
    const ui = make();
    ui.show();
    const title = findEl(root(dom), (el) => el.textContent.startsWith('图鉴 ·'))!;
    expect(title.textContent).toBe('图鉴 · 内容解锁 0/3');
    const stats = findEl(root(dom), (el) => el.textContent.startsWith('胜场'))!;
    expect(stats.textContent).toBe('胜场 1 · 总击杀 100 · 精英击杀 2');
    // 卡片名是纯名称(数值在悬停里);分区标题在;行用 data-content-kind/id 定位
    expect(findEl(root(dom), (el) => el.textContent === '武器')).toBeDefined();
    expect(cellText(findCell(dom, 'weapons', String(TOWER_AUTOCANNON))!)).toBe('自动机炮');
    // 锁定卡:名称 div 的父格子带 opacity 灰显(星数标签也是叶子,按精确名称找)
    const lockedCell = findCell(dom, 'weapons', String(TOWER_MISSILE_NEST))!;
    const lockedName = findEl(lockedCell, (el) => el.textContent === '导弹巢')!;
    expect(parentOf(root(dom), lockedName)!.style.cssText).toContain('opacity:.45');
  });

  it('过滤器:切到法令只剩法令卡,切回全部恢复', () => {
    const ui = make();
    ui.show();
    const edictBtn = dom.created.find(
      (el) => el.tagName === 'BUTTON' && el.dataset.filter === 'edicts',
    )!;
    edictBtn.listeners.get('click')?.({});
    expect(findCell(dom, 'edicts', String(EDICT_AMMO))).toBeDefined();
    expect(findCell(dom, 'weapons', String(TOWER_AUTOCANNON))).toBeUndefined();
    const allBtn = dom.created.find(
      (el) => el.tagName === 'BUTTON' && el.dataset.filter === 'all',
    )!;
    allBtn.listeners.get('click')?.({});
    expect(findCell(dom, 'weapons', String(TOWER_AUTOCANNON))).toBeDefined();
    expect(findCell(dom, 'edicts', String(EDICT_AMMO))).toBeDefined();
  });

  it('悬停 tooltip:进卡弹出(含 ★/★★/★★★ 星级读数),出卡收起', () => {
    const ui = make();
    ui.show();
    const cell = findCell(dom, 'weapons', String(TOWER_AUTOCANNON))!;
    // 初始 display:none 落在构造时的 cssText 里(桩不解析 cssText,与遮罩同款断言)
    expect(tip(dom).style.cssText).toContain('display:none');
    cell.listeners.get('mouseenter')?.({});
    expect(tip(dom).style.display).toBe('block');
    expect(tip(dom).textContent).toContain('★ 伤害');
    expect(tip(dom).textContent).toContain('★★ 伤害');
    expect(tip(dom).textContent).toContain('★★★ 伤害');
    expect(tip(dom).style.top).toBe('126px'); // 卡下方 6px
    cell.listeners.get('mouseleave')?.({});
    expect(tip(dom).style.display).toBe('none');
  });

  it('卡片配图:武器 = 一行一种的星级三档缩略图(三张同大 + 图下各标星数),敌/法令仍单图网格', () => {
    const ui = make();
    ui.show();
    const cell = findCell(dom, 'weapons', String(TOWER_AUTOCANNON))!;
    // 武器行是 flex 横排(一行一种),不再是网格格子
    expect(cell.style.cssText).toContain('display:flex');
    const starImgs = findAll(cell, (el) => el.tagName === 'IMG');
    expect(starImgs.length).toBe(3);
    expect(starImgs.map((el) => el.alt)).toEqual(['自动机炮 ★', '自动机炮 ★★', '自动机炮 ★★★']);
    expect(starImgs.every((el) => el.src.endsWith('.png'))).toBe(true); // 生成贴图直摆
    // 三档同一尺寸(星数靠图下标签读,不靠图的大小)
    expect(starImgs[0]!.style.cssText).toContain('width:48px;height:48px;');
    expect(starImgs[1]!.style.cssText).toContain('width:48px;height:48px;');
    expect(starImgs[2]!.style.cssText).toContain('width:48px;height:48px;');
    // 图下各标 ★/★★/★★★,标签色与 renderer 的 FX_STAR_COLORS 同一份(冷蓝/金/亮金)
    const labels = findAll(cell, (el) => ['★', '★★', '★★★'].includes(el.textContent));
    expect(labels.map((l) => l.textContent)).toEqual(['★', '★★', '★★★']);
    expect(labels[0]!.style.cssText).toContain('color:#9adcff');
    expect(labels[1]!.style.cssText).toContain('color:#ffd479');
    expect(labels[2]!.style.cssText).toContain('color:#fff1a8');
    // 合成武器不单独成行:武器区只有基础型号,风暴机炮那一行不存在
    expect(findCell(dom, 'weapons', String(TOWER_STORM_CANNON))).toBeUndefined();
    // 敌/法令单图网格不变:图鉴图标 alt 的 PNG 与 SVG data URI 各在其位
    const plain = dom.created.filter((el) => el.tagName === 'IMG' && el.alt === '图鉴图标');
    expect(plain.some((el) => el.src.endsWith('.png'))).toBe(true);
    expect(plain.some((el) => el.src.startsWith('data:image/svg+xml'))).toBe(true);
    // 导弹巢贴图直摆(三档缩略图)
    expect(
      dom.created.some((el) => el.tagName === 'IMG' && el.src.includes('missile-nest-head')),
    ).toBe(true);
  });

  it('点配图弹高清看图:原图进 viewer、标题就位;Esc 先收看图、再按才关图鉴', () => {
    const ui = make();
    ui.show();
    const swarm = findCell(dom, 'enemies', String(KIND_SWARM))!;
    const thumb = findAll(swarm, (el) => el.tagName === 'IMG')[0]!;
    thumb.listeners.get('click')?.({});
    const viewer = viewerEl(dom);
    expect(viewer.style.display).toBe('flex');
    const big = findAll(viewer, (el) => el.tagName === 'IMG')[0]!;
    expect(big.src).toBe(thumb.src);
    expect(big.src.endsWith('swarm-leech.png')).toBe(true); // 原图 URL 原样放大,没有缩略副本
    expect(findAll(viewer, (el) => el.textContent === '蜂群蛭').length).toBe(1);
    expect(findAll(viewer, (el) => el.textContent === '点击任意处或按 Esc 关闭').length).toBe(1);
    // Esc 先收看图页:图鉴还开着,onClose 不触发
    dom.key(keyEvent('Escape'));
    expect(viewer.style.display).toBe('none');
    expect(root(dom).style.display).toBe('flex');
    expect(closes).toBe(0);
    // 再按 Esc 才关图鉴(与关闭按钮同一条路)
    dom.key(keyEvent('Escape'));
    expect(closes).toBe(1);
    expect(root(dom).style.display).toBe('none');
  });

  it('武器星级缩略图点开:标题带星数;点遮罩收起', () => {
    const ui = make();
    ui.show();
    const cell = findCell(dom, 'weapons', String(TOWER_AUTOCANNON))!;
    const starImgs = findAll(cell, (el) => el.tagName === 'IMG');
    starImgs[1]!.listeners.get('click')?.({});
    const viewer = viewerEl(dom);
    expect(viewer.style.display).toBe('flex');
    expect(findAll(viewer, (el) => el.textContent === '自动机炮 ★★').length).toBe(1);
    expect(findAll(viewer, (el) => el.tagName === 'IMG')[0]!.src).toBe(starImgs[1]!.src);
    viewer.listeners.get('click')?.({});
    expect(viewer.style.display).toBe('none');
  });

  it('法令徽章同样点得开:data URI 原样进 viewer', () => {
    const ui = make();
    ui.show();
    const edict = findCell(dom, 'edicts', String(EDICT_AMMO))!;
    const thumb = findAll(edict, (el) => el.tagName === 'IMG')[0]!;
    expect(thumb.src.startsWith('data:image/svg+xml')).toBe(true);
    thumb.listeners.get('click')?.({});
    const viewer = viewerEl(dom);
    expect(viewer.style.display).toBe('flex');
    expect(findAll(viewer, (el) => el.tagName === 'IMG')[0]!.src).toBe(thumb.src);
  });

  it('看图页开着时 hide/刷新语言都把它一起收掉,不留到下一次打开', async () => {
    const ui = make();
    ui.show();
    const swarm = findCell(dom, 'enemies', String(KIND_SWARM))!;
    findAll(swarm, (el) => el.tagName === 'IMG')[0]!.listeners.get('click')?.({});
    expect(viewerEl(dom).style.display).toBe('flex');
    ui.hide();
    expect(viewerEl(dom).style.display).toBe('none');
    ui.show();
    // 再开一次看图,切语言(图鉴开着)时看图页一并收起(网格重排后旧图引用已不在)
    findAll(findCell(dom, 'enemies', String(KIND_SWARM))!, (el) => el.tagName === 'IMG')[0]!
      .listeners.get('click')
      ?.({});
    expect(viewerEl(dom).style.display).toBe('flex');
    await changeLocale('en');
    ui.refreshLocale();
    expect(viewerEl(dom).style.display).toBe('none');
    await changeLocale('zh-CN');
  });

  it('Esc 关页走 onClose;收着时 Esc 不认;按钮同一条路', () => {
    const ui = make();
    ui.show();
    dom.key(keyEvent('Escape'));
    expect(closes).toBe(1);
    expect(root(dom).style.display).toBe('none');
    dom.key(keyEvent('Escape'));
    expect(closes).toBe(1); // 收着时不再响应
    ui.show();
    const back = dom.created.find(
      (el) => el.tagName === 'BUTTON' && el.dataset.action === 'codex-back',
    )!;
    back.listeners.get('click')?.({});
    expect(closes).toBe(2);
  });

  it('show/hide 多少回都不多挂监听器、不多长遮罩(整页只建一次)', () => {
    const ui = make();
    for (let i = 0; i < 3; i++) {
      ui.show();
      ui.hide();
    }
    expect(dom.windowListeners).toBe(1);
    expect(dom.ui.children.length).toBe(1);
  });

  it('refreshLocale 原地重画:筛选/滚动/统计/掩码全保留,只重画文案(08 号)', async () => {
    const ui = make();
    ui.show();
    // 切到「敌人」筛选,摆一个滚动位置
    const enemyBtn = dom.created.find(
      (el) => el.tagName === 'BUTTON' && el.dataset.filter === 'enemies',
    )!;
    enemyBtn.listeners.get('click')?.({});
    const scroll = dom.created.find((el) => el.style.cssText.includes('overflow-y:auto'))!;
    scroll.scrollTop = 120;
    // 悬停 tooltip 是 scrollEl 外的独立节点,refreshLocale 不许碰它
    tip(dom).style.display = 'block';
    // 切换语言 + refreshLocale(语言真切过去了,main 的 setLanguage 才会触发它)
    await changeLocale('en');
    ui.refreshLocale();
    // 筛选仍是 enemies:敌卡在、武器卡不在;行用 data-content-kind/id 定位
    expect(findCell(dom, 'weapons', String(TOWER_AUTOCANNON))).toBeUndefined();
    const swarm = findCell(dom, 'enemies', String(KIND_SWARM))!;
    expect(cellText(swarm)).toContain('Swarm Leech');
    const boss = findCell(dom, 'enemies', 'boss')!;
    expect(cellText(boss)).toContain('Hive Colossus');
    expect(cellText(findCell(dom, 'enemies', 'elite-queen')!)).toContain(
      'Hive Queen (Ram Beetle elite)',
    );
    // 筛选按钮标签翻成英文;标题/统计按当前语言重画(掩码与统计值未变)
    expect(
      dom.created.find((el) => el.tagName === 'BUTTON' && el.textContent === 'Enemies'),
    ).toBeDefined();
    const title = findEl(root(dom), (el) => el.textContent.startsWith('Codex ·'))!;
    expect(title.textContent).toBe('Codex · Unlocked 0/3');
    const stats = findEl(root(dom), (el) => el.textContent.startsWith('Wins'))!;
    expect(stats.textContent).toBe('Wins 1 · Total kills 100 · Elite kills 2');
    // 滚动位置还原、返回按钮翻新、tooltip 原样
    expect(scroll.scrollTop).toBe(120);
    const back = dom.created.find(
      (el) => el.tagName === 'BUTTON' && el.textContent === 'Back (Esc)',
    )!;
    expect(back).toBeDefined();
    expect(tip(dom).style.display).toBe('block');
    // 不重建监听器(整页只建一次的口径)
    expect(dom.windowListeners).toBe(1);
    // 再刷一次幂等:滚动不丢、筛选不重置
    await changeLocale('zh-CN');
    ui.refreshLocale();
    expect(scroll.scrollTop).toBe(120);
    expect(findCell(dom, 'weapons', String(TOWER_AUTOCANNON))).toBeUndefined();
    // 收着时切换语言(refreshLocale 提前返回),show() 也要按当前语言刷静态 chrome
    ui.hide();
    await changeLocale('en');
    ui.show();
    expect(
      dom.created.find((el) => el.tagName === 'BUTTON' && el.textContent === 'Back (Esc)'),
    ).toBeDefined();
    expect(cellText(findCell(dom, 'enemies', String(KIND_SWARM))!)).toContain('Swarm Leech');
    // show 的整块重排把遮罩重新铺上,但监听器仍只有最初那一条
    expect(dom.windowListeners).toBe(1);
  });
});
