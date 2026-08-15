/**
 * 伪语言(en-XA)测试(10 号质量门):纯函数变换的行为 + 与 i18n 基础设施的接线。
 *
 * 纯函数部分(pseudoTransform / createPseudoBundle)不依赖 i18next,可独立测;
 * 接线部分(activatePseudo)确认:伪语言激活后 t() 返回膨胀文本、currentLocale() 归一成
 * 'en'、原始语言标签是 'en-XA'、且 en-XA 不在 SUPPORTED_LOCALES 里(不进正式语言列表)。
 */
import { describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES } from './locale';
import { activatePseudo, changeLocale, currentI18nLanguage, currentLocale, t } from './index';
import {
  createPseudoBundle,
  isPseudoLocale,
  PSEUDO_LOCALE,
  pseudoTransform,
} from './pseudo';
import { ui as enUi } from './resources/en/ui';

const LENGTH_RATIO = (text: string): number => pseudoTransform(text).length / text.length;

describe('伪语言:pseudoTransform 基本形态', () => {
  it('用 ⟦⟧ 包裹并明显变长(每句 1.25–1.8 倍,整批均值 ≥1.3,即约 30% 起)', () => {
    const samples = [
      'Cordon breached',
      'Weapon slots are full — pick a slot in the replace view to swap out an old weapon',
      'Click a weapon slot to swap in the new weapon · arc = the slot firing arc & range',
      'The cordon Boss is down — this ship sailed out of the swarm alive',
      'Hull HP',
    ];
    const ratios = samples.map((s) => {
      const r = LENGTH_RATIO(s);
      expect(r, `「${s}」膨胀比 ${r} 应落在 1.25–1.8`).toBeGreaterThanOrEqual(1.25);
      expect(r, `「${s}」膨胀比 ${r} 不应超过 1.8`).toBeLessThanOrEqual(1.8);
      return r;
    });
    const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    expect(avg, `整批均值 ${avg} 应 ≥1.3`).toBeGreaterThanOrEqual(1.3);
  });

  it('确定性:同一输入两次变换结果一字不差', () => {
    const s = 'Start Voyage';
    expect(pseudoTransform(s)).toBe(pseudoTransform(s));
  });

  it('空串不崩,产出空包装', () => {
    expect(pseudoTransform('')).toBe('⟦⟧');
  });
});

describe('伪语言:保留插值 / 符号 / 键位 / 专名', () => {
  it('插值 {{var}} 原样保留(i18next 替换依赖精确原文)', () => {
    // 精确全串断言:{{segment}} 一字未变,周边文本按母音翻倍规则膨胀
    expect(pseudoTransform('Segment {{segment}} cleared · supply beacon dropped')).toBe(
      '⟦Seegmeent {{segment}} cleeaareed · suupply beeaacoon drooppeed⟧',
    );
  });

  it('游戏符号 ★ × ° — · 原样保留', () => {
    const out = pseudoTransform('★ Star Coins · Boost 0° — ×1.5');
    expect(out).toContain('★');
    expect(out).toContain('×');
    expect(out).toContain('°');
    expect(out).toContain('—');
    expect(out).toContain('·');
  });

  it('键位 token(Esc/Enter/Tab/WASD/单字母 R/U/I)不翻倍', () => {
    const out = pseudoTransform('Press [I] or Tab · Retry Run (R) · Back (Esc) · Enter to continue · WASD');
    expect(out).toContain('[I]');
    expect(out).toContain('Tab');
    expect(out).toContain('(R)');
    expect(out).toContain('Esc');
    expect(out).toContain('Enter');
    expect(out).toContain('WASD');
  });

  it('专名(STARWRECK / Boss / DPS)不翻倍', () => {
    const out = pseudoTransform('STARWRECK · Boss DPS report');
    expect(out).toContain('STARWRECK');
    expect(out).toContain('Boss');
    expect(out).toContain('DPS');
  });
});

describe('伪语言:createPseudoBundle', () => {
  it('结构不变(叶子 key 集合与 en 一致)、值全部是膨胀后的字符串', () => {
    const bundle = createPseudoBundle(enUi);
    const enLeaves: string[] = [];
    const pseudoLeaves: string[] = [];
    const walk = (a: unknown, b: unknown, path: string): void => {
      if (typeof a === 'string' && typeof b === 'string') {
        enLeaves.push(a);
        pseudoLeaves.push(b);
        expect(b.length, `${path}:伪文本应更长`).toBeGreaterThanOrEqual(a.length);
        return;
      }
      if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
        expect(Object.keys(a as object).sort()).toEqual(Object.keys(b as object).sort());
        for (const [k, v] of Object.entries(a as Record<string, unknown>)) {
          walk(v, (b as Record<string, unknown>)[k], path === '' ? k : `${path}.${k}`);
        }
      }
    };
    walk(enUi, bundle, '');
    expect(enLeaves.length).toBeGreaterThan(50); // 覆盖了相当一批文案,不是空转
    expect(pseudoLeaves.length).toBe(enLeaves.length);
  });

  it('en-XA 是伪语言标签,且不在正式支持语言里', () => {
    expect(isPseudoLocale('en-XA')).toBe(true);
    expect(isPseudoLocale('en')).toBe(false);
    expect((SUPPORTED_LOCALES as readonly string[]).includes(PSEUDO_LOCALE)).toBe(false);
  });
});

describe('伪语言:与 i18n 基础设施接线(activatePseudo)', () => {
  it('激活后 t() 返回膨胀文本,currentLocale 归一 en,原始标签 en-XA', async () => {
    await activatePseudo();
    expect(currentI18nLanguage()).toBe('en-XA');
    expect(currentLocale()).toBe('en');
    const label = t('ui:menu.newRun');
    expect(label).not.toBe('Start Voyage');
    expect(label.startsWith('⟦')).toBe(true);
    expect(label.endsWith('⟧')).toBe(true);
    expect(label).toContain('Staart'); // 母音翻倍确实发生
    expect(currentLocale()).toBe('en'); // 设置行/类型层面仍是 en(伪语言不新增正式语言)
  });

  it('从伪语言切回真实语言,currentI18nLanguage 回到 zh-CN/en', async () => {
    await activatePseudo();
    await changeLocale('zh-CN');
    expect(currentI18nLanguage()).toBe('zh-CN');
    expect(currentLocale()).toBe('zh-CN');
    expect(t('common:confirm')).toBe('确认');
  });
});
