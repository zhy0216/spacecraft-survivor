/**
 * 支持的语言与 locale 规范化。纯函数、不碰 navigator/DOM —— Node 测试直接可跑。
 * 规范化把浏览器/存储里五花八门的语言标签收敛成 SupportedLocale 里的两种。
 */

export const SUPPORTED_LOCALES = ['zh-CN', 'en'] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** 'auto' = 跟随浏览器/系统语言,具体由调用方把探测到的系统标签喂给 resolveLanguage。 */
export type LanguagePreference = 'auto' | SupportedLocale;

export function isSupportedLocale(value: string): value is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * 把任意语言标签规范成 SupportedLocale。
 * 'en' / 'en-US' / 'en_GB' → 'en';'zh' / 'zh-CN' / 'zh-Hans' / 'zh-SG' → 'zh-CN';其余 → null。
 */
export function normalizeLocale(value: string): SupportedLocale | null {
  const tag = value.trim().toLowerCase().replaceAll('_', '-');
  if (tag === 'zh' || tag === 'zh-cn' || tag === 'zh-hans' || tag === 'zh-sg') return 'zh-CN';
  if (tag === 'en' || tag.startsWith('en-')) return 'en';
  return null;
}

/**
 * 语言偏好 → 具体语言。'auto' 时用调用方探测到的系统标签(detected)解析,
 * 解析不出来返回 null,由调用方决定兜到哪个默认(通常是 fallback 的 zh-CN)。
 */
export function resolveLanguage(
  preference: LanguagePreference,
  detected: string | null,
): SupportedLocale | null {
  if (preference !== 'auto') return preference;
  if (detected === null) return null;
  return normalizeLocale(detected);
}
