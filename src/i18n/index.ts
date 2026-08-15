/**
 * i18n 基础设施的唯一出口:初始化、t、语言切换与当前语言。
 *
 * ## 安全前提(必读)
 * 初始化关闭了 interpolation.escapeValue(见下方注释)。这**只**在一条铁律下是安全的:
 * 翻译结果一律只写进 `textContent`,绝不进 innerHTML / insertAdjacentHTML 等任何会把
 * 字符串当 HTML 解析的落点 —— 翻译字符串里出现 "<script>" 也只会显示成字面文本。
 * 任何想用 innerHTML 渲染翻译结果的代码,都要先想清楚这条约束(见 10 号质量门)。
 *
 * ## 资源加载
 * 走文件底部的**字面量 loader map**:语言 → 静态 import,绝不拼接路径再动态 import,
 * Vite 才能在构建期看到每一个入口。初始化至少载入 zh-CN fallback 与当前语言;
 * 切换到尚未载入的语言时,先静态加载资源,再 changeLanguage。
 */
import i18next from 'i18next';
import type { Resource } from 'i18next';
import type { SupportedLocale } from './locale';
import { SUPPORTED_LOCALES, normalizeLocale } from './locale';

const NAMESPACES = ['common', 'ui', 'content', 'story'] as const;
export type NamespaceId = (typeof NAMESPACES)[number];

/** 一个语言的完整语言包:四个 namespace,值只要求是对象(具体形状由 zh-CN 资源自行决定)。 */
type ResourceBundle = Record<NamespaceId, object>;

/**
 * 静态可分析的字面量 loader map。这里不拼接、不变量化路径 ——
 * 每个入口都是 Vite 一眼能看到的静态 import。
 */
const loaders: Record<SupportedLocale, () => Promise<{ default: ResourceBundle }>> = {
  'zh-CN': () => import('./resources/zh-CN'),
  en: () => import('./resources/en'),
};

const loadedBundles = new Map<SupportedLocale, ResourceBundle>();
let initialized = false;

/** 载入并缓存一个语言包(幂等)。init 之前不碰 store —— init 会新建 ResourceStore。 */
async function ensureLoaded(locale: SupportedLocale): Promise<ResourceBundle> {
  const cached = loadedBundles.get(locale);
  if (cached !== undefined) return cached;
  const bundle = (await loaders[locale]()).default;
  loadedBundles.set(locale, bundle);
  return bundle;
}

/** 把缓存里的语言包灌进 i18next 的 resource store。 */
function syncBundle(locale: SupportedLocale, bundle: ResourceBundle): void {
  for (const ns of NAMESPACES) {
    const nsBundle = bundle[ns];
    if (nsBundle !== undefined) i18next.addResourceBundle(locale, ns, nsBundle, true, true);
  }
}

/**
 * 初始化。至少同时载入 fallback(zh-CN)与目标语言,再 init 实例。
 * 重复调用视为切换语言(幂等):已初始化时只做 ensureLoaded + changeLanguage。
 */
export async function initI18n(locale: SupportedLocale): Promise<void> {
  const [fallbackBundle, primaryBundle] = await Promise.all([
    ensureLoaded('zh-CN'),
    ensureLoaded(locale),
  ]);
  if (initialized) {
    await activateLocale(locale);
    return;
  }
  const resources: Resource = {
    'zh-CN': fallbackBundle,
    [locale]: primaryBundle,
  };
  await i18next.init({
    lng: locale,
    fallbackLng: 'zh-CN',
    supportedLngs: [...SUPPORTED_LOCALES],
    ns: [...NAMESPACES],
    defaultNS: 'common',
    load: 'currentOnly',
    // saveMissing: true 只是把缺 key 路由到下面的 missingKeyHandler —— 项目没有配置任何
    // backend,不存在"自动上报"这回事;生产环境 handler 为空,等于关闭上报。
    saveMissing: true,
    resources,
    missingKeyHandler: (lngs, ns, key) => {
      // 开发环境显式告警;生产环境什么都不做(见 saveMissing 注释)。
      if (import.meta.env.DEV) {
        console.warn(`[i18n] missing key: ${ns}:${key} (lngs: ${lngs.join(', ')})`);
      }
    },
    interpolation: {
      // escapeValue: false —— 安全前提见文件头注释:翻译字符串只进 textContent,绝不进 innerHTML。
      escapeValue: false,
    },
  });
  initialized = true;
}

/** 载入目标语言包、灌进 store,再切换语言。 */
async function activateLocale(locale: SupportedLocale): Promise<void> {
  const bundle = await ensureLoaded(locale);
  syncBundle(locale, bundle);
  await i18next.changeLanguage(locale);
}

/**
 * 切换语言。目标语言尚未载入时先静态加载资源,再 changeLanguage。
 */
export async function changeLocale(locale: SupportedLocale): Promise<void> {
  if (!initialized) {
    await initI18n(locale);
    return;
  }
  await activateLocale(locale);
}

/**
 * 当前生效语言。实例未初始化 / 读到不支持的值时兜回 zh-CN。
 */
export function currentLocale(): SupportedLocale {
  const raw = i18next.resolvedLanguage ?? i18next.language ?? 'zh-CN';
  return normalizeLocale(raw) ?? 'zh-CN';
}

/**
 * 底层实例句柄(测试与少数高级场景用)。资源装载仍走本模块的 loader map,不要绕开它。
 */
export function getI18nInstance(): typeof i18next {
  return i18next;
}

export { t } from 'i18next';
export type { SupportedLocale, LanguagePreference } from './locale';
export type { LocaleAware, DeepRecord } from './types';
