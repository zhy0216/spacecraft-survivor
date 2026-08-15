/**
 * 依赖边界门禁(10 号质量门):sim/data/core 三块纯逻辑层永不 import i18n。
 *
 * 这条边界是确定性的物理保证:World.checksum 只在"同 seed + 同输入"下有意义的先决条件,
 * 就是任何 sim 路径都不读语言 —— 语言一旦混进去,"同 seed 两种语言两条轨迹"就出现了,
 * 存档/回放/复现整条管线当场失效。presenter 层(ui/presentation)坐在 i18n 之上查翻译,
 * 正是为了把 i18n 挡在 sim 之外,这里用 import 语句的精确匹配把边界钉成测试。
 *
 * import 语句本身足够可靠,不必上 AST:specifier 是字面量,正则精确匹配即可。
 * 源码读取走 `import.meta.glob` + `?raw`(Vite 原生能力,测试侧不用装 @types/node)。
 */
import { describe, expect, it } from 'vitest';

const RAW = import.meta.glob('../sim/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const DATA_RAW = import.meta.glob('../data/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const CORE_RAW = import.meta.glob('../core/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const CONTENT_TEXT_RAW = import.meta.glob('../ui/presentation/contentText.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** glob 的 key 是相对本测试文件(src/i18n/)的路径,归一到 'src/...' 风格。 */
const toRel = (key: string): string =>
  key.startsWith('../') ? `src/${key.slice(3)}` : `src/i18n/${key.replace(/^\.\//, '')}`;

const SOURCES: Record<string, string> = {};
for (const [k, v] of Object.entries(RAW)) SOURCES[toRel(k)] = v;
for (const [k, v] of Object.entries(DATA_RAW)) SOURCES[toRel(k)] = v;
for (const [k, v] of Object.entries(CORE_RAW)) SOURCES[toRel(k)] = v;
for (const [k, v] of Object.entries(CONTENT_TEXT_RAW)) SOURCES[toRel(k)] = v;

/** 匹配 import 语句里的模块 specifier(静态与动态 import 都收)。 */
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\b[^\n]*?\bfrom\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /import\s*\(\s*['"]([^'"]+)['"]/g;

function isI18nSpec(spec: string): boolean {
  return spec === 'i18n' || spec.endsWith('/i18n') || spec.includes('/i18n/');
}

function importSpecifiers(source: string): string[] {
  const specs = new Set<string>();
  for (const re of [IMPORT_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0;
    for (let m = re.exec(source); m !== null; m = re.exec(source)) {
      const spec = m[1];
      if (spec !== undefined) specs.add(spec);
    }
  }
  return [...specs];
}

describe('10 号门禁:sim/data/core 依赖边界', () => {
  it('三块纯逻辑层不得 import src/i18n(含任意子路径)', () => {
    const violations: string[] = [];
    for (const [file, source] of Object.entries(SOURCES)) {
      if (!/^src\/(sim|data|core)\//.test(file)) continue;
      for (const spec of importSpecifiers(source)) {
        if (isI18nSpec(spec)) violations.push(`${file}: import '${spec}'`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('presenter 层在 ui/ 下、且确实 import 了 i18n(证明映射层存在,不是边界被绕过)', () => {
    const file = 'src/ui/presentation/contentText.ts';
    const source = SOURCES[file];
    expect(source, `${file} 应在扫描列表里`).toBeDefined();
    expect(importSpecifiers(source!)).toContain('../../i18n');
  });
});
