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

/** 语言偏好合法吗?老设置文件里可能存进任意字符串,逐项兜底时就靠它分辨"非法 → 回落 auto"。 */
export function isLanguagePreference(value: string): value is LanguagePreference {
  return value === 'auto' || isSupportedLocale(value);
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
 * 语言偏好 → 具体语言。`'auto'` 时按优先级顺序扫描候选系统标签(detected,
 * 即 navigator.languages 的顺序),命中第一个可支持的语言就定。
 * **默认英文,除非浏览器检测到中文**:一个都不命中(包括 Node 环境没有
 * navigator、detected 为 null)回落 `'en'` —— zh-CN 只在明确探测到时生效。
 * 显式 `zh-CN` / `en` 不探测系统、原样直出 —— 玩家手动选过就该听玩家的。
 */
export function resolveLanguage(
  preference: LanguagePreference,
  detected: readonly string[] | null,
): SupportedLocale {
  if (preference !== 'auto') return preference;
  if (detected !== null) {
    for (const tag of detected) {
      const locale = normalizeLocale(tag);
      if (locale !== null) return locale;
    }
  }
  return 'en';
}
