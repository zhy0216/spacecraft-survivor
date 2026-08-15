/**
 * locale 感知的数字/时长格式化。
 *
 * Intl.NumberFormat 按「locale + 选项签名」模块级缓存:战斗 HUD 每帧都会格式同样的东西,
 * 绝不能在热路径上反复 new(铁律 3:运行期零新增分配)。签名先对选项 key 排序再拼接,
 * 同一组选项(与书写顺序无关)永远落在同一个缓存位。
 * formatDuration / formatSigned 保持确定性、不依赖 Intl,也不随 locale 变化。
 */
import type { SupportedLocale } from './locale';
import { currentLocale } from './index';

const numberFormatCache = new Map<string, Intl.NumberFormat>();

/** 选项的确定性签名:key 排序后拼接,同一组选项(任意书写顺序)命中同一缓存位。 */
function optionSignature(options: Intl.NumberFormatOptions): string {
  return Object.keys(options)
    .sort()
    .map((key) => `${key}=${String(options[key as keyof Intl.NumberFormatOptions])}`)
    .join(',');
}

function getNumberFormat(
  locale: SupportedLocale,
  options: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  const key = `${locale}\u0000${optionSignature(options)}`;
  let nf = numberFormatCache.get(key);
  if (nf === undefined) {
    nf = new Intl.NumberFormat(locale, options);
    numberFormatCache.set(key, nf);
  }
  return nf;
}

export function formatNumber(
  value: number,
  options: Intl.NumberFormatOptions = {},
  locale: SupportedLocale = currentLocale(),
): string {
  return getNumberFormat(locale, options).format(value);
}

/** 百分比。输入是比值(0.35 → '35%'),默认取整,可用 options 覆盖小数位。 */
export function formatPercent(
  value: number,
  options: Intl.NumberFormatOptions = {},
  locale: SupportedLocale = currentLocale(),
): string {
  return formatNumber(value, { style: 'percent', maximumFractionDigits: 0, ...options }, locale);
}

/**
 * 战斗计时器 m:ss。秒数**向下取整**(与 ui/gameOver 同一口径:8:59.9 报 8:59,
 * 免得报出一个比总时长还大的数),负数(理论上出不来)夹成 0。
 */
export function formatDuration(totalSeconds: number): string {
  const total = Math.floor(totalSeconds > 0 ? totalSeconds : 0);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 带符号的数值描述:'+15' / '-0.3' / '0',供 "+15 装甲"、"-0.3s 冷却" 一类效果描述使用。 */
export function formatSigned(value: number, digits = 1): string {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  if (rounded === 0) return '0';
  const sign = rounded > 0 ? '+' : '-';
  const abs = Math.abs(rounded);
  const body = Number.isInteger(abs) ? String(abs) : abs.toFixed(digits);
  return `${sign}${body}`;
}

/** 测试钩子:当前缓存的 Intl.NumberFormat 实例数。语言+选项组合复用,缓存只增不缩。 */
export function __formatterCacheSize(): number {
  return numberFormatCache.size;
}

/** 测试钩子:清空缓存,让单测从干净状态起跑。 */
export function __clearFormatterCache(): void {
  numberFormatCache.clear();
}
