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
import type { InitOptions, Resource } from 'i18next';
import type { LanguagePreference, SupportedLocale } from './locale';
import { SUPPORTED_LOCALES, normalizeLocale, resolveLanguage } from './locale';
import { createPseudoBundle, PSEUDO_LOCALE } from './pseudo';

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
  await i18next.init(sharedInitOptions(locale, resources));
  initialized = true;
}

/** init 的公共配置:正式初始化与伪语言初始化共用同一份选项,免得两处漂移。 */
function sharedInitOptions(lng: string, resources: Resource): InitOptions {
  return {
    lng,
    fallbackLng: 'zh-CN',
    // supportedLngs 里允许 en-XA 存在,但 en-XA 不在 SUPPORTED_LOCALES 里 ——
    // 那是开发/测试的伪语言,currentLocale() 仍把它归一成 'en',设置列表看不到它。
    supportedLngs: [...SUPPORTED_LOCALES, PSEUDO_LOCALE],
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
  };
}

/**
 * 伪语言(en-XA):由英文资源原地膨胀生成(见 pseudo.ts),仅开发/测试用。
 * 入口在 main.ts 的 `?locale=pseudo`(只认 DEV);不写设置、不进语言列表。
 * 与 initI18n 同一条启动纪律:先 await 本函数、再建任何 UI。
 * 已初始化时调用视为"切到伪语言"(与 activateLocale 同一条幂等路径)。
 */
export async function activatePseudo(): Promise<void> {
  const [fallbackBundle, enBundle] = await Promise.all([
    ensureLoaded('zh-CN'),
    ensureLoaded('en'),
  ]);
  const pseudoBundle = createPseudoBundle(enBundle);
  if (!initialized) {
    // i18next 实例在 init 之前还没有 addResourceBundle(资源方法随 init 就位),
    // 首启直接走 init 的 resources 参数注册 en-XA 即可。
    await i18next.init(
      sharedInitOptions(PSEUDO_LOCALE, {
        'zh-CN': fallbackBundle,
        [PSEUDO_LOCALE]: pseudoBundle,
      }),
    );
    initialized = true;
    return;
  }
  for (const ns of NAMESPACES) {
    const nsBundle = pseudoBundle[ns];
    if (nsBundle !== undefined) i18next.addResourceBundle(PSEUDO_LOCALE, ns, nsBundle, true, true);
  }
  await i18next.changeLanguage(PSEUDO_LOCALE);
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
 * i18next 实例当前生效的语言标签(原始值,不做归一)。
 * 常规语言下与 currentLocale() 一致;伪语言激活时是 'en-XA' ——
 * 供 documentElement.lang(BCP47 合法标签)这类"要原始标签"的地方使用。
 */
export function currentI18nLanguage(): string {
  return i18next.resolvedLanguage ?? i18next.language ?? 'zh-CN';
}

/**
 * 探测浏览器系统语言列表(navigator.languages,按用户偏好降序)。
 * Node/测试环境没有 navigator(或它没有 languages)时返回 null ——
 * 不抛错,由 resolveLanguage 回落默认语言。留在本文件而不是 locale.ts:
 * 那是纯函数文件、不碰 navigator,而"读环境"这一小步恰好是它和环境的唯一接缝。
 */
export function detectSystemLanguages(): readonly string[] | null {
  const nav = (globalThis as { navigator?: { languages?: readonly string[] } }).navigator;
  if (nav === undefined) return null;
  if (nav.languages !== undefined && nav.languages.length > 0) return nav.languages;
  return null;
}

/**
 * 偏好 → 具体语言。`'auto'` 时现读 navigator.languages 解析 ——
 * 所以系统语言以后变了,下次启动(或再次切回 auto)会重新解析,不缓存旧结论。
 * 启动顺序里必须先用它拿到语言、再 await initI18n,首屏才不会是"先闪默认语言再变"。
 */
export function resolveEffectiveLocale(preference: LanguagePreference): SupportedLocale {
  return resolveLanguage(preference, detectSystemLanguages());
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
export { registerLocaleAware, refreshAllLocaleAware } from './registry';
export { createPseudoBundle, isPseudoLocale, PSEUDO_LOCALE } from './pseudo';
