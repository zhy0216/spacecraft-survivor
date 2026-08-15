/**
 * 设置显示文案 presenter(04 号)—— volumeText / shakeText 从纯数据层 settings.ts
 * 迁进 i18n 后的断言在这边。需 initI18n:档位名随语言翻,zh 与 en 各钉一遍;
 * 音量百分比是数字、不分语言,只钉数字边界与非法值夹取。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { changeLocale, initI18n } from '../../i18n';
import { shakeText, volumeText } from './settingsText';

describe('设置文案 presenter:音量与震屏档位', () => {
  beforeEach(async () => {
    await initI18n('zh-CN');
  });

  it('音量印成整百分比(数字不分语言)', () => {
    expect(volumeText(0)).toBe('0%');
    expect(volumeText(0.8)).toBe('80%');
    expect(volumeText(1)).toBe('100%');
    expect(volumeText(NaN)).toBe('0%'); // 非法数夹回 0(与 settings 的夹取口径一致)
    expect(volumeText(2)).toBe('100%');
    expect(volumeText(-0.5)).toBe('0%');
  });

  it('震屏三档走 ui.settings.shakeLevels(zh)', () => {
    expect(shakeText(1)).toBe('标准');
    expect(shakeText(0.5)).toBe('轻微');
    expect(shakeText(0)).toBe('关闭');
  });

  it('震屏三档随语言翻(en)', async () => {
    await changeLocale('en');
    expect(shakeText(1)).toBe('Standard');
    expect(shakeText(0.5)).toBe('Low');
    expect(shakeText(0)).toBe('Off');
  });
});
