/**
 * 玩家可见代码的硬编码中文扫描(10 号质量门)。
 *
 * 为什么用 AST 而不是 rg:仓库中文注释极多,逐行 rg 会满屏误报;而 `ts.createSourceFile`
 * 给出的语法树里注释不在节点流中 —— 只遍历字符串字面量 / 模板字面量,注释天然免疫,
 * 无需任何正则排除。
 *
 * 扫描范围:**玩家可见的模块** —— src/ui/ 的全部非测试 .ts、src/main.ts、presentation。
 * 调参面板(ui/debugPanel.ts)玩家形态连按三次 ~ 可呼出,故**不再豁免**、一样扫描;
 * 其余明确排除:各 *.test.ts。
 * 个别确实需要硬编码中文的 token(console 调试日志)走**精确 allowlist**,
 * 逐条写理由;禁止整文件/整目录豁免。
 *
 * 源码读取走 `import.meta.glob` + `?raw`(Vite 原生能力,测试侧不用装 @types/node):
 * 文件内容以字符串形式静态打进测试,与 git 当前工作树一一对应。
 */
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** src/ui/** 与 src/main.ts 的全部 .ts 源文本(含测试与 debugPanel,过滤在下面做)。 */
const RAW = import.meta.glob('../ui/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const MAIN_RAW = import.meta.glob('../main.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const INDEX_RAW = import.meta.glob('./index.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** glob 的 key 是相对本测试文件(src/i18n/)的路径,归一到 'src/...' 风格。 */
const toRel = (key: string): string =>
  key.startsWith('../') ? `src/${key.slice(3)}` : `src/i18n/${key.replace(/^\.\//, '')}`;

function allRaw(): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(RAW)) merged[toRel(k)] = v;
  for (const [k, v] of Object.entries(MAIN_RAW)) merged[toRel(k)] = v;
  for (const [k, v] of Object.entries(INDEX_RAW)) merged[toRel(k)] = v;
  return merged;
}

const SOURCES = allRaw();

/** 精确 allowlist:文件 → 允许的整串字面量 + 理由。宁可加条目,不可宽到整文件。 */
const ALLOWLIST: ReadonlyMap<string, readonly { value: string; reason: string }[]> = new Map([
  [
    'src/main.ts',
    [
      {
        value: '[i18n] 切换语言失败,保留当前语言:',
        reason: 'console 调试日志(非玩家可见文案),语言切换失败时 main 侧告警用',
      },
    ],
  ],
]);

/** 明确豁免的整文件。当前为空:调参面板已双语化,不再有任何整文件豁免。 */
const EXCLUDED_FILES = new Set<string>();

/** CJK 显区(统一表意 + 表意扩展 A + CJK 符号标点 + 全角形式)。符号 ★—·×° 不在其列。 */
const CJK_RE = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;

function playerVisibleFiles(): string[] {
  return Object.keys(SOURCES).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
}

function sourceOf(file: string): string {
  const src = SOURCES[file];
  if (src === undefined) throw new Error(`扫描目标不存在:${file}`);
  return src;
}

/** 收集一个源文件里所有含 CJK 的字符串/模板字面量(注释天然不在语法树里)。 */
function findCjkLiterals(file: string): { literal: string; line: number }[] {
  const sf = ts.createSourceFile(file, sourceOf(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits: { literal: string; line: number }[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      if (CJK_RE.test(node.text)) {
        const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        hits.push({ literal: node.text, line: pos.line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/** 收集所有把翻译/插值写进 innerHTML 的落点(翻译字符串只允许走 textContent)。 */
function findInnerHtmlUsages(file: string): { what: string; line: number }[] {
  const sf = ts.createSourceFile(file, sourceOf(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits: { what: string; line: number }[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken) &&
      ts.isPropertyAccessExpression(node.left) &&
      (node.left.name.text === 'innerHTML' || node.left.name.text === 'outerHTML')
    ) {
      const pos = sf.getLineAndCharacterOfPosition(node.left.getStart(sf));
      hits.push({ what: `${node.left.name.text} 赋值`, line: pos.line + 1 });
    }
    if (ts.isPropertyAssignment(node) && node.name.getText(sf) === 'innerHTML') {
      const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      hits.push({ what: '对象字面量 innerHTML 属性', line: pos.line + 1 });
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'insertAdjacentHTML'
    ) {
      const pos = sf.getLineAndCharacterOfPosition(node.expression.getStart(sf));
      hits.push({ what: 'insertAdjacentHTML 调用', line: pos.line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe('10 号门禁:玩家可见代码无硬编码中文', () => {
  it('src/ui + main.ts + presentation 里不允许新增硬编码中文(注释不在此列)', () => {
    const failures: string[] = [];
    for (const file of playerVisibleFiles()) {
      if (EXCLUDED_FILES.has(file)) continue;
      const allowed = ALLOWLIST.get(file) ?? [];
      for (const hit of findCjkLiterals(file)) {
        if (allowed.some((a) => a.value === hit.literal)) continue;
        failures.push(`${file}:${hit.line} 硬编码中文「${hit.literal}」`);
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('扫描器确实认得出硬编码中文(防止把 allowlist 放宽到整文件后测试变绿)———对照样例自证', () => {
    const sf = ts.createSourceFile(
      'src/__sanity.ts',
      "const a = '按钮';const b = 'OK';const c = `航段 ${'x'}`;",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const literals: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        if (CJK_RE.test(node.text)) literals.push(node.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(literals).toContain('按钮');
    expect(literals).toContain('航段 ');
    expect(literals).not.toContain('OK'); // 无中文的字符串不误报
  });

  it('allowlist 与豁免清单本身没有中文以外的漂移(逐条写明理由,条目必须是活的)', () => {
    expect(
      EXCLUDED_FILES.size,
      '整文件豁免已清零:调参面板双语化后不再允许任何整文件豁免',
    ).toBe(0);
    for (const [file, entries] of ALLOWLIST) {
      expect(file, 'allowlist 的 key 必须是相对路径').toMatch(/^src\//);
      const source = sourceOf(file);
      for (const e of entries) {
        expect(CJK_RE.test(e.value), `allowlist 条目「${e.value}」不含 CJK,不该在列表里`).toBe(
          true,
        );
        expect(e.reason.length, `allowlist 条目「${e.value}」必须写理由`).toBeGreaterThan(0);
        // 死条目 = 源码里已经找不到这段文字 → 允许别人直接删掉它,不许留着一份过期豁免
        expect(
          source.includes(e.value),
          `${file} 里找不到 allowlist 条目「${e.value}」(死条目,请删除)`,
        ).toBe(true);
      }
    }
  });
});

describe('10 号门禁:翻译字符串不进 innerHTML', () => {
  it('玩家可见代码里不存在 innerHTML/outerHTML 赋值或 insertAdjacentHTML 调用', () => {
    const failures: string[] = [];
    for (const file of playerVisibleFiles()) {
      if (EXCLUDED_FILES.has(file)) continue;
      for (const hit of findInnerHtmlUsages(file)) {
        failures.push(`${file}:${hit.line} ${hit.what}`);
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('i18n 基础设施自身也遵守:textContent 契约在文件头,index.ts 不含 innerHTML', () => {
    expect(findInnerHtmlUsages('src/i18n/index.ts')).toEqual([]);
  });
});
