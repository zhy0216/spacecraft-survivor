import { beforeEach, describe, expect, it } from 'vitest';
import {
  __clearFormatterCache,
  __formatterCacheSize,
  formatDuration,
  formatNumber,
  formatPercent,
  formatSigned,
} from './format';

beforeEach(() => {
  __clearFormatterCache();
});

describe('format:数字与百分比', () => {
  it('按 locale 格式化数字', () => {
    expect(formatNumber(1234567, {}, 'en')).toBe('1,234,567');
    expect(formatNumber(1234567, {}, 'zh-CN')).toBe('1,234,567');
  });

  it('percent 输入是比值,印成百分比;小数位可覆盖', () => {
    expect(formatPercent(0.35, {}, 'en')).toBe('35%');
    expect(formatPercent(0.35, {}, 'zh-CN')).toBe('35%');
    expect(formatPercent(0.125, { maximumFractionDigits: 1 }, 'en')).toBe('12.5%');
  });

  it('同一「语言+选项」复用同一个 Intl.NumberFormat,不每帧 new', () => {
    expect(__formatterCacheSize()).toBe(0);
    formatNumber(1, { maximumFractionDigits: 0 }, 'zh-CN');
    formatNumber(2, { maximumFractionDigits: 0 }, 'zh-CN');
    expect(__formatterCacheSize()).toBe(1); // 第二次命中缓存,不再新建
    formatPercent(0.5, {}, 'zh-CN');
    expect(__formatterCacheSize()).toBe(2); // percent = 一组不同选项,多占一位
    formatNumber(3, { maximumFractionDigits: 1 }, 'en');
    expect(__formatterCacheSize()).toBe(3); // 不同 locale 各自占位
  });

  it('同一组选项不因传入顺序不同而重复缓存', () => {
    formatNumber(1, { maximumFractionDigits: 0, useGrouping: false }, 'en');
    formatNumber(1, { useGrouping: false, maximumFractionDigits: 0 }, 'en');
    expect(__formatterCacheSize()).toBe(1);
  });
});

describe('format:持续时长 m:ss', () => {
  it('65 秒 → 1:05', () => {
    expect(formatDuration(65)).toBe('1:05');
  });

  it('0 → 0:00', () => {
    expect(formatDuration(0)).toBe('0:00');
  });

  it('向下取整,8:59.9 报 8:59 而不是 9:00', () => {
    expect(formatDuration(539.9)).toBe('8:59');
  });

  it('负数(理论上出不来)夹成 0', () => {
    expect(formatDuration(-5)).toBe('0:00');
  });
});

describe('format:带符号数值', () => {
  it('正数带 +,负数带 -,零是 0', () => {
    expect(formatSigned(15)).toBe('+15');
    expect(formatSigned(-0.3)).toBe('-0.3');
    expect(formatSigned(0)).toBe('0');
  });

  it('整值不带小数,非整值保留一位', () => {
    expect(formatSigned(1.2)).toBe('+1.2');
    expect(formatSigned(-1.25)).toBe('-1.2'); // Math.round 半值向 +∞ 取整,确定性
    expect(formatSigned(0.04)).toBe('0');
    expect(formatSigned(0.06)).toBe('+0.1');
  });
});
