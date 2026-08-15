/**
 * 存储回归门禁(10 号质量门):语言设置不渗进存档,老数据仍可读。
 *
 * 三条口径:
 * 1. 局内存档快照 / 运行日志 / 元进度里**不得出现** language/locale 字段 ——
 *    语言是界面偏好,不是世界状态;一旦混进去,读档回来的世界与"该语言无关"的
 *    确定性口径就会纠缠。
 * 2. 设置键保持 `starwreck.settings.v1` 不变(改名 = 老玩家音量/语言全部归零)。
 * 3. 老设置文件(02 号之前没有 language 字段)仍能逐项兜底读成语言 auto ——
 *    这条在 settings.test.ts 已有,这里补上"键不变"这半条,并把快照/日志/进度的
 *    字段排查钉在一起。
 */
import { describe, expect, it } from 'vitest';
import { applyRandomStart } from '../sim/loadout';
import { createProgress } from '../sim/progress';
import { createRunLog } from '../sim/runLog';
import { captureRun } from '../sim/runSave';
import { World } from '../sim/world';
import { normalizeSettings } from '../ui/settings';
import { SETTINGS_STORAGE_KEY } from '../ui/settingsStorage';

/** 递归收集对象里的所有 key(含嵌套),数组当普通值走。 */
function allKeys(value: unknown, path: string, out: string[]): string[] {
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      value.forEach((v, i) => allKeys(v, `${path}[${i}]`, out));
      return out;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.push(path === '' ? k : `${path}.${k}`);
      allKeys(v, path === '' ? k : `${path}.${k}`, out);
    }
  }
  return out;
}

function assertNoLanguageKey(value: unknown): string[] {
  const keys = allKeys(value, '', []);
  return keys.filter((k) => {
    const base = k.includes('.') ? k.slice(k.lastIndexOf('.') + 1) : k;
    return base === 'language' || base === 'locale' || base === 'lng';
  });
}

function freshWorld(): World {
  const world = new World(20260801);
  applyRandomStart(world);
  for (let i = 0; i < 300; i++) world.step();
  return world;
}

describe('10 号门禁:语言不进存档', () => {
  it('runSave 快照不含 language/locale/lng 字段', () => {
    const snap = captureRun(freshWorld(), { seed: 20260801 });
    expect(assertNoLanguageKey(snap), '快照里出现语言字段').toEqual([]);
  });

  it('runLog 事件与负载不含 language/locale/lng 字段', () => {
    const log = createRunLog(7);
    const world = new World(7);
    world.step();
    expect(assertNoLanguageKey(log), '日志壳含语言字段').toEqual([]);
    expect(
      world.log.events.every((e) => assertNoLanguageKey(e).length === 0),
      '日志事件含语言字段',
    ).toBe(true);
  });

  it('元进度对象不含 language/locale/lng 字段', () => {
    expect(assertNoLanguageKey(createProgress())).toEqual([]);
  });
});

describe('10 号门禁:老设置仍可读、存储键不变', () => {
  it('设置键保持 starwreck.settings.v1(改名会把老玩家的一切设置归零)', () => {
    expect(SETTINGS_STORAGE_KEY).toBe('starwreck.settings.v1');
  });

  it('老设置文件没有 language 字段 → 回落 auto,其余字段原样保留', () => {
    const s = normalizeSettings({ masterVolume: 0.4, muted: true, shake: 0.5, hitstop: false });
    expect(s.language).toBe('auto');
    expect(s.masterVolume).toBe(0.4);
    expect(s.muted).toBe(true);
    expect(s.shake).toBe(0.5);
    expect(s.hitstop).toBe(false);
    expect(s.damageNumbers).toBe(true); // 缺项走出厂默认
  });
});
