/**
 * 语言切换失败路径(02 号)。放在独立测试文件里 —— vi.mock 是文件级作用域,
 * 只在这里把 en 语言包"掐断",别污染其它文件里成功的 changeLocale('en')。
 *
 * 失败口径:目标语言包加载失败 → changeLocale 抛错 → 当前语言**保持不动**,
 * 不落到一个没生效的语言上(落盘由 main 决定,这里只保证 i18n 层不退让)。
 */
import { describe, expect, it, vi } from 'vitest';

// en 语言包的 loader 一 import 就炸,模拟资源加载失败(网络/打包缺档)
vi.mock('./resources/en', () => {
  throw new Error('simulated resource load failure');
});

import { changeLocale, currentLocale, initI18n, t } from './index';

describe('i18n:切换失败路径', () => {
  it('目标语言包加载失败:changeLocale 抛错,当前语言保持切换前的那个', async () => {
    await initI18n('zh-CN');
    expect(currentLocale()).toBe('zh-CN');

    await expect(changeLocale('en')).rejects.toThrow();

    // 语言没被"半切"过去:currentLocale 与翻译都还是中文
    expect(currentLocale()).toBe('zh-CN');
    expect(t('common:confirm')).toBe('确认');

    // 再切一次仍失败(资源确实拿不到,不是一次性的事故)
    await expect(changeLocale('en')).rejects.toThrow();
    expect(currentLocale()).toBe('zh-CN');
  });

  it('显式偏好 zh-CN 不受 en 加载失败影响(原地切,不碰坏掉的那包)', async () => {
    await initI18n('zh-CN');
    await changeLocale('zh-CN');
    expect(currentLocale()).toBe('zh-CN');
  });
});
