/**
 * 设置显示文案 presenter(04 号迁移)—— 数值 → 玩家文案的映射层。
 * 原 ui/settings.ts 里的 volumeText / shakeText 是**玩家可见文本**,随 04 号迁进 i18n:
 * 本文件坐在 i18n 之上(数据层 settings.ts 保持零 DOM / 零 i18n 的纯数据分工),
 * 数字格式(音量百分比)不分语言,档位名走 ui.settings.shakeLevels 翻译。
 */
import { t } from '../../i18n';

/** 音量百分比文案(0..1 → '80%')。数字本身不分语言;非有限数夹回 0(与 settings 夹取口径一致) */
export function volumeText(v: number): string {
  const c = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  return `${Math.round(c * 100)}%`;
}

/**
 * 震屏强度的三档文案。做成"档"而不是连续滑杆:震屏是晕动症开关,
 * 玩家要的是"关掉 / 小一点 / 原样",没人需要 37% 的震屏。档位名走翻译。
 */
export function shakeText(v: number): string {
  if (v <= 0.01) return t('ui:settings.shakeLevels.off');
  if (v <= 0.55) return t('ui:settings.shakeLevels.low');
  return t('ui:settings.shakeLevels.standard');
}
