import { describe, expect, it } from 'vitest';
import { getI18nInstance, initI18n, t } from './index';

/**
 * 「英文整语言尚未加载」的回退:放在**独立测试文件**里 —— vitest 每个文件独占一份模块图,
 * 本文件从头到尾只 init zh-CN,en 的语言包从没进过 store,`lng: 'en'` 查询只能回落到中文。
 */
describe('i18n:目标语言整语言缺失时回落到 zh-CN', () => {
  it('en 从未加载 → t(..., { lng: "en" }) 返回中文值', async () => {
    await initI18n('zh-CN');
    expect(getI18nInstance().t('common:confirm', { lng: 'en' })).toBe('确认');
    expect(getI18nInstance().t('ui:menu.newRun', { lng: 'en' })).toBe('开始航行');
    expect(t('common:confirm')).toBe('确认'); // 当前语言 zh-CN 不受影响
  });
});
