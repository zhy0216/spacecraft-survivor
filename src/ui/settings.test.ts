/**
 * 设置的纯数据层。测的是**兜底方向**这一条:设置项坏了要逐项退回默认,
 * 而不是整份判废(与局内存档从严判废正好相反,理由见 settings.ts 的 normalizeSettings)。
 * 手改过 / 旧版本 / 半截写入的设置都会走到这条路上,而它出错的症状是"玩家的音量被莫名调回默认",
 * 那种事没人会当成 bug 报上来,只会当成"这游戏有点怪"。
 */
import { describe, expect, it } from 'vitest';
import {
  createSettings,
  nextShake,
  normalizeSettings,
  parseSettings,
  serializeSettings,
  shakeText,
  volumeText,
} from './settings';

describe('设置:夹取与兜底', () => {
  it('JSON 往返后逐字段不变', () => {
    const s = { masterVolume: 0.35, muted: true, shake: 0.5, damageNumbers: false, hitstop: false };
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

  it('出厂设置与各处原本写死的手感一致(音量 0.8、震屏/飘字/顿帧恒开)', () => {
    const d = createSettings();
    expect(d.masterVolume).toBe(0.8); // = render/audio.ts 的 masterVolume 初值
    expect(d.muted).toBe(false);
    expect(d.shake).toBe(1);
    expect(d.damageNumbers).toBe(true);
    expect(d.hitstop).toBe(true);
  });
});

describe('设置:文案与档位', () => {
  it('音量印成整百分比', () => {
    expect(volumeText(0)).toBe('0%');
    expect(volumeText(0.8)).toBe('80%');
    expect(volumeText(1)).toBe('100%');
  });

  it('震屏三档文案与三档循环闭合(标准 → 轻微 → 关闭 → 标准)', () => {
    expect(shakeText(1)).toBe('标准');
    expect(shakeText(0.5)).toBe('轻微');
    expect(shakeText(0)).toBe('关闭');
    const a = nextShake(1);
    const b = nextShake(a);
    const c = nextShake(b);
    expect(shakeText(a)).toBe('轻微');
    expect(shakeText(b)).toBe('关闭');
    expect(c).toBe(1); // 转回起点:每一档都到得了,不会卡在某一档出不来
  });
});
