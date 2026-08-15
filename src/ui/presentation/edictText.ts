/**
 * 法令展示 presenter(03 号)—— edictScopeLabel / edictDesc / edictSummaryText 从 data/edicts 移出。
 * 边界与 contentText 同一条:data/sim 永不 import i18n(确定性边界),于是"数值 → 效果文案"
 * 只允许在这里发生。效果短语逐项查 content.edicts.effects 的翻译 key,数字/正负号走 i18n/format;
 * 分隔符与效果顺序在**本 presenter 里**定(zh 系内乘法档沿用「 / 」、其余用「 · 」),数值表里不写。
 * edictDesc 念的是**一层的效果**而不是"当前总量" —— "已经叠到几层"由卡面/徽记的 ×N 单独报。
 */
import type { EdictDef } from '../../data/edicts';
import { EDICT_THR_NONE } from '../../data/edicts';
import { t } from '../../i18n';
import { formatNumber, formatSigned } from '../../i18n/format';
import { throttleFamilyName } from './contentText';

/** 乘法档值:两位小数内舍入、尾零省掉(1.25 / 0.7 / 1.3,不印 1.250) */
function mul(v: number): string {
  return formatNumber(v, { maximumFractionDigits: 2 });
}

/** 系内乘法档的分隔符(分隔符归 presenter 定,数值表不写) */
const FAMILY_SEP = ' / ';
/** 效果段的分隔符 */
const PART_SEP = ' · ';

/** 法令效果短语(只念非中性字段;乘法档 1、加法档 0 = "这档用不上"):族倍率与全局档分开、顺序固定 */
function effectParts(def: EdictDef): { family: string[]; global: string[] } {
  const family: string[] = [];
  if (def.fireRateMul !== 1) family.push(t('content:edicts.effects.fireRate', { value: mul(def.fireRateMul) }));
  if (def.reloadMul !== 1) family.push(t('content:edicts.effects.reload', { value: mul(def.reloadMul) }));
  if (def.heatMaxMul !== 1) family.push(t('content:edicts.effects.heatMax', { value: mul(def.heatMaxMul) }));
  if (def.chargeRateMul !== 1) family.push(t('content:edicts.effects.chargeRate', { value: mul(def.chargeRateMul) }));

  const global: string[] = [];
  if (def.damageMul !== 1) global.push(t('content:edicts.effects.damage', { value: mul(def.damageMul) }));
  if (def.hullHpAdd !== 0) global.push(t('content:edicts.effects.hullHp', { value: formatSigned(def.hullHpAdd) }));
  if (def.damageTakenMul !== 1) global.push(t('content:edicts.effects.damageTaken', { value: mul(def.damageTakenMul) }));
  if (def.xpMul !== 1) global.push(t('content:edicts.effects.xp', { value: mul(def.xpMul) }));
  if (def.magnetRadiusMul !== 1) global.push(t('content:edicts.effects.magnetRadius', { value: mul(def.magnetRadiusMul) }));
  if (def.turnRateAdd !== 0) global.push(t('content:edicts.effects.turnRate', { value: formatSigned(def.turnRateAdd) }));
  if (def.cruiseSpeedMul !== 1) global.push(t('content:edicts.effects.cruiseSpeed', { value: mul(def.cruiseSpeedMul) }));
  if (def.boostCooldownAdd !== 0) global.push(t('content:edicts.effects.boostCooldown', { value: formatSigned(def.boostCooldownAdd) }));
  if (def.starCoinChanceAdd !== 0) {
    global.push(t('content:edicts.effects.starCoinChance', { value: formatSigned(def.starCoinChanceAdd * 100) }));
  }
  return { family, global };
}

/**
 * 法令的作用范围标签:系限定法令 = 节流系名(弹药系 / 过热系 / 充能系),
 * 全船法令(EDICT_THR_NONE)= content.edicts.scope.all(「全船」/「All」)。
 */
export function edictScopeLabel(def: EdictDef): string {
  return def.throttle !== EDICT_THR_NONE ? throttleFamilyName(def.throttle) : t('content:edicts.scope.all');
}

/** 法令卡的一句话:前缀作用域(系名 / 全船),效果段按固定顺序拼接;空效果 → noEffects 兜底(不许空串) */
export function edictDesc(def: EdictDef): string {
  const { family, global } = effectParts(def);
  const parts: string[] = [];
  if (def.throttle !== EDICT_THR_NONE && family.length > 0) {
    parts.push(`${throttleFamilyName(def.throttle)} ${family.join(FAMILY_SEP)}`);
  }
  parts.push(...global);
  if (def.throttle === EDICT_THR_NONE && parts.length > 0) {
    parts.unshift(edictScopeLabel(def));
  }
  return parts.length > 0 ? parts.join(PART_SEP) : t('content:edicts.noEffects');
}

/** 图鉴用的法令效果摘要:前缀「作用域:」,效果短语与 edictDesc 同源;全中性 → 破折号 */
export function edictSummaryText(def: EdictDef): string {
  const { family, global } = effectParts(def);
  const parts = [...family, ...global];
  return `${edictScopeLabel(def)}:${parts.length === 0 ? '—' : parts.join(PART_SEP)}`;
}
