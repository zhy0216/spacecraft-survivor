/**
 * 内容展示 presenter(03 号 issue)—— 数值 → 玩家文案的唯一映射层。
 * 边界:它坐在 data/* 与 i18n 之上 —— 读 data 表的**数值编号 + slug 字段**,
 * 再用 content namespace 里的翻译查名字。data/sim 永不 import i18n(确定性边界),
 * 于是"塔型/敌型/法令/词缀/航段 → 显示名"只允许在这里发生,UI 不再直接读 name 字段。
 *
 * slug 是翻译/编辑器身份、数值编号是存档/模拟身份(见各 data 表的 slug 注释);
 * 这里两头都要:**编号 → 查表取 slug → slug 作为 t() 的 key**。越界一律吐带原始编号的
 * 本地化错误文案(zh「未知武器 #{{type}}」/ en「Unknown weapon #{{type}}」),不静默兜底成第 0 种。
 */
import type { content as zhContent } from '../../i18n/resources/zh-CN/content';
import { t } from '../../i18n';
import { AFFIXES } from '../../data/affixes';
import { ENEMIES, KIND_BOSS } from '../../data/enemies';
import { EDICTS } from '../../data/edicts';
import { MERGES } from '../../data/merges';
import { THR_AMMO, THR_CHARGE, THR_HEAT, TOWERS } from '../../data/towers';
import { WAVE_SEGMENTS } from '../../data/waves';

type TowerSlug = keyof (typeof zhContent)['towers'];
type EnemySlug = keyof (typeof zhContent)['enemies'];
/** edicts 段里只有 <slug>.name 是条目名;scope/effects/noEffects 是元数据段,不是条目标识 */
type EdictSlug = Exclude<keyof (typeof zhContent)['edicts'], 'scope' | 'effects' | 'noEffects'>;
type AffixSlug = keyof (typeof zhContent)['affixes'];
type SegmentSlug = keyof (typeof zhContent)['segments'];

/**
 * 节流系 → 代表塔 slug。family 标签按节流系全表一致(同一 THR_* 的塔共享同一 family 文案,
 * content.test 钉着),所以从代表塔取即可;不代表"只有这座塔有 family"。
 */
const FAMILY_TOWER: Readonly<Record<number, TowerSlug>> = {
  [THR_AMMO]: 'autocannon',
  [THR_HEAT]: 'laser_prism',
  [THR_CHARGE]: 'railgun',
};

/** 塔名:TOWERS[type].slug → content.towers.<slug>.name;越界 → 本地化错误 */
export function towerName(type: number): string {
  const slug = TOWERS[type]?.slug;
  if (slug === undefined) return t('content:errors.unknownTower', { type });
  return t(`content:towers.${slug as TowerSlug}.name`);
}

/**
 * 玩家看到的武器名:合成武器不改名 —— 合到 3★ 变身后的槽位仍显示基础武器名
 * (用户口径「三星武器不改名字,自动机炮 3★ 还是叫自动机炮」)。
 * 合成武器的独立名字(风暴机炮等)只活在数值表/翻译表里,不进玩家文案;
 * 槽位、战报、图鉴一律走这里,towerName 只留给"这一型本身叫什么"(卡片标题、血统反查)。
 */
export function weaponDisplayName(type: number): string {
  for (const r of MERGES) {
    if (r.result === type) return towerName(r.base);
  }
  return towerName(type);
}

/** 敌名:ENEMIES[kind].slug → content.enemies.<slug>.name;KIND_BOSS 走 bossName;越界 → 本地化错误 */
export function enemyName(kind: number): string {
  if (kind === KIND_BOSS) return bossName();
  const slug = ENEMIES[kind]?.slug;
  if (slug === undefined) return t('content:errors.unknownEnemy', { kind });
  return t(`content:enemies.${slug as EnemySlug}.name`);
}

/** 法令名:EDICTS[type].slug → content.edicts.<slug>.name;越界 → 本地化错误 */
export function edictName(type: number): string {
  const slug = EDICTS[type]?.slug;
  if (slug === undefined) return t('content:errors.unknownEdict', { type });
  return t(`content:edicts.${slug as EdictSlug}.name`);
}

/** 词缀名:AFFIXES[id].slug → content.affixes.<slug>.name;越界 → 本地化错误 */
export function affixName(id: number): string {
  const slug = AFFIXES[id]?.slug;
  if (slug === undefined) return t('content:errors.unknownAffix', { id });
  return t(`content:affixes.${slug as AffixSlug}.name`);
}

/** 词缀效果说明:content.affixes.<slug>.description;越界 → 本地化错误 */
export function affixDescription(id: number): string {
  const slug = AFFIXES[id]?.slug;
  if (slug === undefined) return t('content:errors.unknownAffix', { id });
  return t(`content:affixes.${slug as AffixSlug}.description`);
}

/** 航段名:WAVE_SEGMENTS[index].slug → content.segments.<slug>.name;越界 → 本地化错误 */
export function waveSegmentName(index: number): string {
  const slug = WAVE_SEGMENTS[index]?.slug;
  if (slug === undefined) return t('content:errors.unknownSegment', { index });
  return t(`content:segments.${slug as SegmentSlug}.name`);
}

/** Boss 名:content.boss.name */
export function bossName(): string {
  return t('content:boss.name');
}

/**
 * 节流系标签:THR_* → content.towers.<代表塔>.family(弹药系/过热系/充能系)。
 * 越界(数值表被改坏) → 本地化错误,不回落成问号档。
 */
export function throttleFamilyName(throttle: number): string {
  const slug = FAMILY_TOWER[throttle];
  if (slug === undefined) return t('content:errors.unknownFamily', { throttle });
  return t(`content:towers.${slug}.family`);
}
