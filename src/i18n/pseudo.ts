/**
 * 伪语言(en-XA):仅开发/测试环境可用的界面压力测试语言(10 号质量门)。
 *
 * ## 它是什么
 * 把英文资源原地膨胀一份(约 30%–40%)当作一个"语言"挂进 i18next:
 *   - 每个字符串用 ⟦ ⟧ 包裹,母音翻倍 —— 长了、变形了,一眼就看出哪些按钮/标签
 *     在真实长文案下会截断、溢出、换行错位;
 *   - 插值 `{{var}}`、星币 `★`、乘号 `×`、破折号 `—` 与温度 `°` 等游戏符号原样保留
 *     (i18next 需要精确的 `{{var}}` 才能替换,符号是玩法读数的一部分);
 *   - 键位 token( Esc / Enter / Tab / Space / WASD / R / U / I)与专名
 *     (STARWRECK / Boss / DPS)不翻倍,免得把"UI 塞得下吗"的验收污染成"键位都变形了"。
 *
 * ## 为什么不入正式列表
 * en-XA 是**开发工具**,不是玩家语言:不进 SUPPORTED_LOCALES、不进设置语言列表。
 * 入口是 URL `?locale=pseudo`(main.ts 仅在 `import.meta.env.DEV` 时响应)。
 * currentLocale() 对 en-XA 归一成 'en'(它本就由 en 派生),于是下游的类型与语言设置
 * 完全无感;文档语言标签 documentElement.lang 则用 currentI18nLanguage() 读到原始 'en-XA'。
 *
 * 本文件全是纯函数,Node 可直接单测(pseudo.test.ts),不依赖 import.meta.env。
 */

export const PSEUDO_LOCALE = 'en-XA' as const;

export type PseudoLocale = typeof PSEUDO_LOCALE;

export function isPseudoLocale(value: string): value is PseudoLocale {
  return value === PSEUDO_LOCALE;
}

/** 英文里的母音(翻倍的候选):英文约 38% 的字母是母音,全翻倍 ≈ 长度 ×1.38。 */
const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'A', 'E', 'I', 'O', 'U']);

/**
 * 整段保留的 token(正则交替,顺序有讲究):
 *   1. `{{var}}` 插值 —— i18next 替换依赖精确原文,一个字都不能动;
 *   2. 连续两个以上大写字母(键位 WASD/、专名 STARWRECK/DPS/HP/HP 前的缩写);
 *   3. 独立成词的键位与专名(Boss/Esc/Enter/Tab/Space/WASD 与单字母键位 R/U/I);
 *   4. 游戏符号 ★ × ° — ·(玩法读数的一部分,不随语言翻倍)。
 */
const KEEP_TOKEN_RE =
  /\{\{\s*[\w.\s-]+\s*\}\}|\b(?:[A-Z]{2,}|Boss|DPS|STARWRECK|Esc|Enter|Tab|Space|WASD|R|U|I)\b|[★×°·—]/g;

/** 膨胀一个"可翻倍"的片段:母音翻倍,其余字符(含空格/标点/数字)原样。 */
function expandChunk(chunk: string): string {
  let out = '';
  for (const ch of chunk) {
    out += VOWELS.has(ch) ? ch + ch : ch;
  }
  return out;
}

/**
 * 把一句英文伪化成 en-XA 文本:⟦ 包裹 + 母音翻倍,保留插值/符号/键位/专名。
 * 确定性:同一输入永远产出同一输出(母音翻倍是无状态的逐字符规则)。
 */
export function pseudoTransform(text: string): string {
  let out = '';
  let last = 0;
  KEEP_TOKEN_RE.lastIndex = 0;
  for (let m = KEEP_TOKEN_RE.exec(text); m !== null; m = KEEP_TOKEN_RE.exec(text)) {
    if (m.index > last) out += expandChunk(text.slice(last, m.index));
    out += m[0];
    last = m.index + m[0].length;
  }
  if (last < text.length) out += expandChunk(text.slice(last));
  return `⟦${out}⟧`;
}

function deepMap(value: unknown): unknown {
  if (typeof value === 'string') return pseudoTransform(value);
  if (Array.isArray(value)) return value.map(deepMap);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepMap(v);
    }
    return out;
  }
  return value;
}

/**
 * 由英文语言包原地生成 en-XA 语言包:结构不变、每个叶子字符串过 pseudoTransform。
 * 泛型保持结构类型(传入 DeepRecord 形状就原样返回同形状)。
 */
export function createPseudoBundle<T>(enBundle: T): T {
  return deepMap(enBundle) as T;
}
