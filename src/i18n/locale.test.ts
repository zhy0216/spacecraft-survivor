/**
 * 语言解析(02 号)。钉的是三条口径:
 * ① 显式 zh-CN / en 直接采用 —— 玩家手动选过就该听玩家的,不探测系统;
 * ② auto 按 navigator.languages 的**顺序**扫描 —— 浏览器偏好列表本身就是用户优先级,
 *    命中第一个可支持的就定,而不是像旧版那样只看第一个;
 * ③ 一个都命中不了(含 Node 没有 navigator)→ 回落 en —— 默认英文,除非浏览器检测到中文,绝不抛错。
 * detectSystemLanguages 是唯一碰环境的一小步,测它时临时替换 globalThis.navigator,测完还原。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  isLanguagePreference,
  normalizeLocale,
  resolveLanguage,
  SUPPORTED_LOCALES,
} from './locale';
import { detectSystemLanguages, resolveEffectiveLocale } from './index';

// Node ≥21 的 globalThis.navigator 是个只读 getter,普通赋值会抛 —— 一律走 defineProperty。
const g = globalThis as { navigator?: unknown };
const originalNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function setNavigator(value: unknown): void {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}

afterEach(() => {
  if (originalNavigatorDesc === undefined) {
    delete g.navigator;
  } else {
    Object.defineProperty(globalThis, 'navigator', originalNavigatorDesc);
  }
});

describe('语言解析:normalizeLocale 兼容项', () => {
  it('zh 系简体兼容项一律归一为 zh-CN', () => {
    for (const tag of ['zh', 'zh-CN', 'zh-cn', 'zh-Hans', 'zh-SG', 'zh_Hans', 'ZH-cn']) {
      expect(normalizeLocale(tag)).toBe('zh-CN');
    }
  });

  it('en 系一律归一为 en(en-* 全收)', () => {
    for (const tag of ['en', 'en-US', 'en-GB', 'en_AU', 'EN']) {
      expect(normalizeLocale(tag)).toBe('en');
    }
  });

  it('不支持的语言 → null(不走错路,交给上层回落)', () => {
    expect(normalizeLocale('fr-FR')).toBeNull();
    expect(normalizeLocale('ja')).toBeNull();
    expect(normalizeLocale('')).toBeNull();
  });
});

describe('语言解析:resolveLanguage 偏好 → 具体语言', () => {
  it('显式 zh-CN / en 原样直出,不看系统语言(即使系统偏好另一个)', () => {
    expect(resolveLanguage('zh-CN', ['en-US', 'en'])).toBe('zh-CN');
    expect(resolveLanguage('en', ['zh-CN'])).toBe('en');
  });

  it('auto 按列表顺序找第一个支持的语言(浏览器偏好列表 = 用户优先级)', () => {
    expect(resolveLanguage('auto', ['fr-FR', 'en-US', 'zh-CN'])).toBe('en');
    expect(resolveLanguage('auto', ['ja-JP', 'zh', 'en'])).toBe('zh-CN');
    expect(resolveLanguage('auto', ['zh-Hans', 'en'])).toBe('zh-CN'); // 简体兼容项照收
    expect(resolveLanguage('auto', ['en-GB'])).toBe('en');
  });

  it('auto 一个都不命中 → 回落 en(Node 没有 navigator / detected 为 null 也走这里)', () => {
    expect(resolveLanguage('auto', ['fr-FR', 'ja-JP'])).toBe('en');
    expect(resolveLanguage('auto', null)).toBe('en');
    expect(resolveLanguage('auto', [])).toBe('en');
  });

  it('isLanguagePreference:只认三张合法牌(auto / zh-CN / en),老设置里的怪字符串进不来', () => {
    expect(isLanguagePreference('auto')).toBe(true);
    expect(isLanguagePreference('zh-CN')).toBe(true);
    expect(isLanguagePreference('en')).toBe(true);
    expect(isLanguagePreference('zh-Hans')).toBe(false);
    expect(isLanguagePreference('auto ')).toBe(false);
    expect(isLanguagePreference('')).toBe(false);
  });

  it('SUPPORTED_LOCALES 恰好两张,且与 normalizeLocale 的自洽', () => {
    expect(SUPPORTED_LOCALES).toEqual(['zh-CN', 'en']);
  });
});

describe('语言解析:detectSystemLanguages 与 resolveEffectiveLocale', () => {
  it('浏览器有 navigator.languages 时按顺序读出', () => {
    setNavigator({ languages: ['fr-FR', 'en-GB'] });
    expect(detectSystemLanguages()).toEqual(['fr-FR', 'en-GB']);
    expect(resolveEffectiveLocale('auto')).toBe('en');
  });

  it('没有 navigator(Node/测试环境)时返回 null,resolveEffectiveLocale 回落 en 不抛错', () => {
    delete g.navigator;
    expect(detectSystemLanguages()).toBeNull();
    expect(resolveEffectiveLocale('auto')).toBe('en');
    expect(resolveEffectiveLocale('en')).toBe('en'); // 显式偏好不受影响
  });

  it('navigator 存在但没有 languages(极旧浏览器)→ null 同款回落 en', () => {
    setNavigator({ language: 'en-US' });
    expect(detectSystemLanguages()).toBeNull();
    expect(resolveEffectiveLocale('auto')).toBe('en');
  });
});
