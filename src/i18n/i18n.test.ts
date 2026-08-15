import { describe, expect, it, vi } from 'vitest';
import {
  changeLocale,
  currentLocale,
  getI18nInstance,
  initI18n,
  t,
} from './index';
import type { LocaleAware } from './types';
import { common as enCommon } from './resources/en/common';

describe('i18n:初始化与语言切换', () => {
  it('zh-CN 初始化后读取同一个 typed key', async () => {
    await initI18n('zh-CN');
    expect(currentLocale()).toBe('zh-CN');
    expect(t('common:confirm')).toBe('确认');
    expect(t('ui:menu.newRun')).toBe('开始航行');
    expect(t('content:towers.autocannon.name')).toBe('自动机炮');
    expect(t('story:title.subtitle')).toBe('星 骸');
  });

  it('en 初始化后读到英文值,key 结构仍按 zh-CN 受检', async () => {
    await initI18n('en');
    expect(currentLocale()).toBe('en');
    expect(t('common:confirm')).toBe('Confirm');
    expect(t('ui:menu.newRun')).toBe('Start Voyage');
    expect(t('content:towers.autocannon.name')).toBe('Auto Cannon');
  });

  it('changeLocale 来回切换,currentLocale 跟着走', async () => {
    await initI18n('zh-CN');
    await changeLocale('en');
    expect(currentLocale()).toBe('en');
    expect(t('common:confirm')).toBe('Confirm');
    await changeLocale('zh-CN');
    expect(currentLocale()).toBe('zh-CN');
    expect(t('common:confirm')).toBe('确认');
  });

  it('导出 LocaleAware 契约', () => {
    let refreshed = 0;
    const aware: LocaleAware = {
      refreshLocale(): void {
        refreshed++;
      },
    };
    aware.refreshLocale();
    expect(refreshed).toBe(1);
  });
});

describe('i18n:缺 key 兜底', () => {
  it('en 已加载但缺该 key 时回落到中文', async () => {
    await initI18n('en');
    const inst = getI18nInstance();
    inst.removeResourceBundle('en', 'common');
    expect(inst.t('common:confirm')).toBe('确认'); // 回落到 zh-CN
    inst.addResourceBundle('en', 'common', enCommon, true, true); // 还原
    expect(inst.t('common:confirm')).toBe('Confirm');
  });

  it('两边都缺 → 开发环境显式告警,并返回可检测的 key path', async () => {
    await initI18n('zh-CN');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const untyped = t as unknown as (key: string) => string;
    const res = untyped('common:no.such.key');
    expect(res).toBe('no.such.key'); // 兜底返回 key 本身(namespace 前缀被剥离),可检测
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('i18n:插值与复数', () => {
  it('插值参数正常替换(含复数 count)', async () => {
    await initI18n('zh-CN');
    expect(
      t('ui:menu.saveLine', { segment: '2/4', duration: '1:05', kills: 12, hp: '45/100' }),
    ).toBe('航段 2/4 · 1:05 · 击杀 12 · 船体 45/100');
    expect(t('common:enemiesLeft', { count: 3 })).toBe('还剩 3 只敌舰');
  });

  it('英文按 count 选复数形式(one/other)', async () => {
    await initI18n('en');
    expect(t('common:enemiesLeft', { count: 1 })).toBe('1 enemy left');
    expect(t('common:enemiesLeft', { count: 3 })).toBe('3 enemies left');
  });

  it('插值参数缺失 → 保留 {{var}} 占位,不抛异常', async () => {
    await initI18n('zh-CN');
    const rawT = getI18nInstance().t as unknown as (
      key: string,
      options: Record<string, unknown>,
    ) => string;
    expect(rawT('ui:menu.saveLine', {})).toBe(
      '航段 {{segment}} · {{duration}} · 击杀 {{kills}} · 船体 {{hp}}',
    );
  });
});

describe('i18n:编译期拦截(@ts-expect-error 由 tsc 验证)', () => {
  it('key 写错 / 插值缺参在编译期被 TypeScript 拦下', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // @ts-expect-error 不存在的 key 会被 tsc 拦下
    void t('common:noSuchKey');
    // @ts-expect-error 插值变量缺 segment 等会被 tsc 拦下
    void t('ui:menu.saveLine', {});
    // @ts-expect-error 写错插值变量名会被 tsc 拦下
    void t('ui:menu.saveLine', { segment: '2/4', duration: '1:05', kills: 1, bogus: 2 });
    warn.mockRestore();
  });
});
