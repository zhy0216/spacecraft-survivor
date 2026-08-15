/**
 * LocaleAware 注册表 + 切换成功路径(02 号)。
 *
 * 成功路径的意义:语言真正切换成功(await changeLocale 已落地)之后,才轮到
 * refreshAllLocaleAware 重刷已注册 UI —— 顺序反了 UI 会拿旧语言 t() 刷一遍白费。
 * 幂等性:同一 UI 注册两遍只算一份 —— 这是"一次切换刷两遍/一次按键连开好几页"
 * 那类监听器泄漏在注册表这一侧的镜像事故,Set 直接排掉。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changeLocale, currentLocale, initI18n, registerLocaleAware, refreshAllLocaleAware } from './index';
import { unregisterLocaleAware, __localeAwareCount } from './registry';
import type { LocaleAware } from './types';

function makeAware(count: { n: number }): LocaleAware {
  return {
    refreshLocale(): void {
      count.n++;
    },
  };
}

describe('LocaleAware 注册表:切换成功路径', () => {
  let count: { n: number };
  let aware: LocaleAware;
  let extra: LocaleAware;

  beforeEach(() => {
    count = { n: 0 };
    aware = makeAware(count);
    extra = makeAware(count);
    registerLocaleAware(aware);
    registerLocaleAware(extra);
  });

  afterEach(() => {
    unregisterLocaleAware(aware);
    unregisterLocaleAware(extra);
  });

  it('注册表计数正确;刷新触发每个已注册 UI 恰好一次', () => {
    expect(__localeAwareCount()).toBe(2);
    refreshAllLocaleAware();
    expect(count.n).toBe(2);
  });

  it('同一 UI 注册两遍仍只算一份 —— 幂等,排掉"刷两遍"的泄漏', () => {
    registerLocaleAware(aware);
    expect(__localeAwareCount()).toBe(2);
    refreshAllLocaleAware();
    expect(count.n).toBe(2); // 不是 3
  });

  it('unregister 之后不再刷新', () => {
    unregisterLocaleAware(extra);
    expect(__localeAwareCount()).toBe(1);
    refreshAllLocaleAware();
    expect(count.n).toBe(1);
  });

  it('切换成功后再刷:currentLocale 已落地,UI 拿到的 t() 是新语言(与 boot 顺序一字对齐)', async () => {
    await initI18n('zh-CN');
    await changeLocale('en');
    expect(currentLocale()).toBe('en');
    refreshAllLocaleAware();
    expect(count.n).toBe(2);
  });
});
