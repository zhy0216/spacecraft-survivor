/**
 * 资源质量门禁(10 号质量门):zh-CN 与 en 的 key parity、插值 parity、空值/裸 key 检查,
 * 以及 content 资源 slug 与数据表的对齐。这是防回归的第一道闸 —— 后续任何新增文案
 * 都必须同时落进两种语言,且插值变量不能一边写一边漏。
 *
 * zh-CN 是 key shape 的唯一真相源(编译期 DeepRecord 已强制 en 结构相同),但类型系统
 * 管不住"运行期对象长成什么样"—— 这里直接跑一遍两个 bundle 的叶子遍历,把类型断言
 * 之外的漂移也钉死。
 */
import { describe, expect, it } from 'vitest';
import { AFFIXES } from '../data/affixes';
import { EDICTS } from '../data/edicts';
import { ENEMIES } from '../data/enemies';
import { TOWERS } from '../data/towers';
import { UNLOCKS } from '../data/unlocks';
import { WAVE_SEGMENTS } from '../data/waves';
import { content as enContent } from './resources/en/content';
import { common as enCommon } from './resources/en/common';
import { story as enStory } from './resources/en/story';
import { ui as enUi } from './resources/en/ui';
import { content as zhContent } from './resources/zh-CN/content';
import { common as zhCommon } from './resources/zh-CN/common';
import { story as zhStory } from './resources/zh-CN/story';
import { ui as zhUi } from './resources/zh-CN/ui';

const NAMESPACES: { name: string; zh: object; en: object }[] = [
  { name: 'common', zh: zhCommon, en: enCommon },
  { name: 'ui', zh: zhUi, en: enUi },
  { name: 'content', zh: zhContent, en: enContent },
  { name: 'story', zh: zhStory, en: enStory },
];

/** 递归收集所有叶子 string:path → value。path 是相对本 namespace 的点路径。 */
function collectLeaves(value: unknown, path: string, out: Map<string, string>): void {
  if (typeof value === 'string') {
    out.set(path, value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectLeaves(v, `${path}.${i}`, out));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      collectLeaves(v, path === '' ? k : `${path}.${k}`, out);
    }
  }
}

const INTERP_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

function varsOf(text: string): Set<string> {
  const vars = new Set<string>();
  for (const m of text.matchAll(INTERP_RE)) {
    if (m[1] !== undefined) vars.add(m[1]);
  }
  return vars;
}

describe('资源门禁:key parity(两种语言路径完全一致)', () => {
  for (const ns of NAMESPACES) {
    it(`${ns.name}:zh 与 en 的叶子 key 集合一致`, () => {
      const zh = new Map<string, string>();
      const en = new Map<string, string>();
      collectLeaves(ns.zh, '', zh);
      collectLeaves(ns.en, '', en);
      expect([...en.keys()].sort(), 'en 多出 zh 没有的 key').toEqual([...zh.keys()].sort());
      expect([...zh.keys()].sort(), 'zh 多出 en 没有的 key').toEqual([...en.keys()].sort());
    });
  }
});

describe('资源门禁:interpolation parity(同一 key 两种语言变量一致)', () => {
  for (const ns of NAMESPACES) {
    it(`${ns.name}:每个 key 的 {{var}} 集合两种语言一致`, () => {
      const zh = new Map<string, string>();
      const en = new Map<string, string>();
      collectLeaves(ns.zh, '', zh);
      collectLeaves(ns.en, '', en);
      const problems: string[] = [];
      for (const [path, zhText] of zh) {
        const enText = en.get(path);
        if (enText === undefined) continue; // key 集合不等由上一个 describe 兜住
        const a = varsOf(zhText);
        const b = varsOf(enText);
        if (![...a].every((v) => b.has(v)) || ![...b].every((v) => a.has(v))) {
          problems.push(`${path}: zh=[${[...a].sort().join(',')}] en=[${[...b].sort().join(',')}]`);
        }
      }
      expect(problems, problems.join('\n')).toEqual([]);
    });
  }

  it('plural key(以 _one/_other 结尾,或文案里带 {{count}})必须含 count 变量', () => {
    for (const ns of NAMESPACES) {
      const leaves = new Map<string, string>();
      collectLeaves(ns.zh, '', leaves);
      for (const [path, text] of leaves) {
        const plural = path.endsWith('_one') || path.endsWith('_other');
        const mentionsCount = text.includes('{{count}}');
        if (!plural && !mentionsCount) continue;
        expect(varsOf(text).has('count'), `${ns.name}:${path} 是复数 key,缺 {{count}}`).toBe(true);
      }
    }
  });
});

describe('资源门禁:空翻译 / 裸 key / 意外形状', () => {
  for (const ns of NAMESPACES) {
    it(`${ns.name}:不允许空字符串、纯空白、等于 key 路径的裸 key`, () => {
      const leaves = new Map<string, string>();
      collectLeaves(ns.zh, '', leaves);
      collectLeaves(ns.en, '', leaves);
      const problems: string[] = [];
      for (const [path, text] of leaves) {
        if (text.length === 0) problems.push(`${ns.name}:${path} 是空字符串`);
        if (text.trim().length === 0) problems.push(`${ns.name}:${path} 是纯空白`);
        if (text === path) problems.push(`${ns.name}:${path} 的值等于 key 路径(裸 key 泄漏)`);
      }
      expect(problems, problems.join('\n')).toEqual([]);
    });

    it(`${ns.name}:叶子值全部是字符串(没有把数字/对象落进翻译槽)`, () => {
      const zh = new Map<string, string>();
      const en = new Map<string, string>();
      collectLeaves(ns.zh, '', zh);
      collectLeaves(ns.en, '', en);
      expect(zh.size, 'zh 叶子数应等于收集到的字符串数').toBeGreaterThan(0);
      expect(en.size).toBe(zh.size);
    });
  }
});

describe('资源门禁:content 资源与数据表 slug 对齐(重复/漏写/打错都会在这漏)', () => {
  it('towers:资源 key === 数据表 slug 集合', () => {
    expect(Object.keys(zhContent.towers).sort()).toEqual(TOWERS.map((t) => t.slug).sort());
  });

  it('enemies:资源 key === 数据表 slug 集合(Boss 单列在 content.boss,不混进普通敌型)', () => {
    expect(Object.keys(zhContent.enemies).sort()).toEqual(ENEMIES.map((e) => e.slug).sort());
  });

  it('edicts:条目 key === 数据表 slug 集合(scope/effects/noEffects 是元数据段,不是条目)', () => {
    const entryKeys = Object.keys(zhContent.edicts).filter(
      (k) => k !== 'scope' && k !== 'effects' && k !== 'noEffects',
    );
    expect(entryKeys.sort()).toEqual(EDICTS.map((e) => e.slug).sort());
  });

  it('affixes:资源 key === 数据表 slug 集合', () => {
    expect(Object.keys(zhContent.affixes).sort()).toEqual(AFFIXES.map((a) => a.slug).sort());
  });

  it('segments:资源 key === 数据表 slug 集合', () => {
    expect(Object.keys(zhContent.segments).sort()).toEqual(
      WAVE_SEGMENTS.map((s) => s.slug).sort(),
    );
  });

  it('unlocks:条目 key === 数据表 id 集合(conditions 是元数据段,不是条目)', () => {
    const entryKeys = Object.keys(zhContent.unlocks).filter((k) => k !== 'conditions');
    expect(entryKeys.sort()).toEqual(UNLOCKS.map((u) => u.id).sort());
  });

  it('en 的 content 与 zh 同样对齐(DeepRecord 只管类型,这里钉运行时形状)', () => {
    expect(Object.keys(enContent.towers).sort()).toEqual(TOWERS.map((t) => t.slug).sort());
    expect(Object.keys(enContent.enemies).sort()).toEqual(ENEMIES.map((e) => e.slug).sort());
    expect(Object.keys(enContent.affixes).sort()).toEqual(AFFIXES.map((a) => a.slug).sort());
    expect(Object.keys(enContent.segments).sort()).toEqual(
      WAVE_SEGMENTS.map((s) => s.slug).sort(),
    );
  });
});
