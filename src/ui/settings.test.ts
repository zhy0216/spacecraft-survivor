/**
 * 设置的纯数据层。测的是**兜底方向**这一条:设置项坏了要逐项退回默认,
 * 而不是整份判废(与局内存档从严判废正好相反,理由见 settings.ts 的 normalizeSettings)。
 * 手改过 / 旧版本 / 半截写入的设置都会走到这条路上,而它出错的症状是"玩家的音量被莫名调回默认",
 * 那种事没人会当成 bug 报上来,只会当成"这游戏有点怪"。
 * 显示文案(volumeText / shakeText)04 号迁进 ui/presentation/settingsText.ts 后随语言翻,
 * 那里的断言搬到 settingsText.test.ts(需 initI18n);本文件只留数值/档位循环的纯逻辑。
 */
import { describe, expect, it } from 'vitest';
import {
  createSettings,
  nextLanguage,
  nextShake,
  normalizeSettings,
  parseSettings,
  serializeSettings,
} from './settings';

describe('设置:夹取与兜底', () => {
  it('JSON 往返后逐字段不变', () => {
    const s = {
      masterVolume: 0.35,
      muted: true,
      shake: 0.5,
      damageNumbers: false,
      hitstop: false,
      language: 'en' as const,
    };
    expect(parseSettings(serializeSettings(s))).toEqual(s);
  });

  it('非法 JSON / 非对象 → 一份完整的默认设置(不是错误)', () => {
    expect(parseSettings('{oops')).toEqual(createSettings());
    expect(normalizeSettings(null)).toEqual(createSettings());
    expect(normalizeSettings(42)).toEqual(createSettings());
  });

  it('坏字段逐项退回默认,好字段原样留着', () => {
    const s = normalizeSettings({ masterVolume: 'loud', muted: true, shake: 0.5 });
    expect(s.masterVolume).toBe(createSettings().masterVolume); // 坏的退回
    expect(s.muted).toBe(true); // 好的留着
    expect(s.shake).toBe(0.5);
  });

  it('音量与震屏夹进 0..1,NaN 退回默认(不许把音频弄哑)', () => {
    expect(normalizeSettings({ masterVolume: 5 }).masterVolume).toBe(1);
    expect(normalizeSettings({ masterVolume: -3 }).masterVolume).toBe(0);
    expect(normalizeSettings({ masterVolume: NaN }).masterVolume).toBe(createSettings().masterVolume);
    expect(normalizeSettings({ shake: 99 }).shake).toBe(1);
  });

  it('出厂设置与各处原本写死的手感一致(音量 0.8、震屏/飘字/顿帧恒开、语言 auto)', () => {
    const d = createSettings();
    expect(d.masterVolume).toBe(0.8); // = render/audio.ts 的 masterVolume 初值
    expect(d.muted).toBe(false);
    expect(d.shake).toBe(1);
    expect(d.damageNumbers).toBe(true);
    expect(d.hitstop).toBe(true);
    expect(d.language).toBe('auto');
  });
});

describe('设置:语言字段的兼容与循环', () => {
  it('老设置(02 号之前的 v1 文件)没有 language 字段 → 回落 auto,其余项原样保留', () => {
    const s = normalizeSettings({ masterVolume: 0.5, muted: true, shake: 0.5 });
    expect(s.language).toBe('auto');
    expect(s.masterVolume).toBe(0.5); // 不因新字段的加入连累清空老设置
    expect(s.muted).toBe(true);
  });

  it('非法 language 字符串逐项回落 auto,不整份判废', () => {
    for (const bad of ['zh-Hans', 'fr-FR', '', 'auto ', 42, null]) {
      expect(normalizeSettings({ language: bad }).language).toBe('auto');
    }
  });

  it('合法偏好(zh-CN / en / auto)原样保留', () => {
    expect(normalizeSettings({ language: 'zh-CN' }).language).toBe('zh-CN');
    expect(normalizeSettings({ language: 'en' }).language).toBe('en');
    expect(normalizeSettings({ language: 'auto' }).language).toBe('auto');
  });

  it('语言三档循环闭合(自动 → 简体中文 → English → 自动),与设置页那颗按钮同源', () => {
    expect(nextLanguage('auto')).toBe('zh-CN');
    expect(nextLanguage('zh-CN')).toBe('en');
    expect(nextLanguage('en')).toBe('auto');
  });
});

describe('设置:震屏档位循环', () => {
  it('三档循环闭合(标准 → 轻微 → 关闭 → 标准),档位文案见 settingsText.test', () => {
    const a = nextShake(1);
    const b = nextShake(a);
    const c = nextShake(b);
    expect(a).toBe(0.5); // 标准 → 轻微
    expect(b).toBe(0); // 轻微 → 关闭
    expect(c).toBe(1); // 转回起点:每一档都到得了,不会卡在某一档出不来
  });
});
