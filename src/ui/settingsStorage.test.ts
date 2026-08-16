/**
 * 设置存储适配器的设备默认档。与 keyHintStorage.test.ts 同一套桩法:
 * 适配器只认全局 localStorage 与 window.matchMedia 两个口子,各打一个 Map 桩
 * 与一个可控的媒体查询桩,就能把"统计面板随设备出厂"这条事实钉在 Node 里。
 * 桌面默认开、移动端默认关;一旦存盘里有显式的 showStatsPanel(设置页/P 键写下的),
 * 无论什么设备都无条件尊重那份显式值。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSettings } from './settings';
import { loadSettings, SETTINGS_STORAGE_KEY } from './settingsStorage';

interface FakeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 桌面档 = 断点一个都不命中;移动档 = 命中(窄屏或粗指针,与 index.html 同一条断点) */
function matchMediaStub(mobile: boolean): (query: string) => { matches: boolean } {
  return () => ({ matches: mobile });
}

describe('settingsStorage:统计面板的设备出厂档', () => {
  let map: Map<string, string>;
  let fake: FakeStorage;
  let prevStorage: unknown;
  let prevWindow: unknown;
  let hadWindow: boolean;

  beforeEach(() => {
    map = new Map();
    fake = {
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => {
        map.set(key, value);
      },
    };
    const g = globalThis as unknown as Record<string, unknown>;
    prevStorage = g.localStorage;
    g.localStorage = fake;
    prevWindow = g.window;
    hadWindow = 'window' in g;
  });
  afterEach(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    if (prevStorage === undefined) delete g.localStorage;
    else g.localStorage = prevStorage;
    if (hadWindow) g.window = prevWindow;
    else delete g.window;
  });

  it('新机器(无设置):桌面默认开统计面板,移动端默认关,其余项仍是出厂值', () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = { matchMedia: matchMediaStub(false) };
    const desktop = loadSettings();
    expect(desktop.showStatsPanel).toBe(true);
    const base = createSettings();
    expect({ ...desktop, showStatsPanel: base.showStatsPanel }).toEqual(base);

    g.window = { matchMedia: matchMediaStub(true) };
    const mobile = loadSettings();
    expect(mobile.showStatsPanel).toBe(false);
    expect({ ...mobile, showStatsPanel: base.showStatsPanel }).toEqual(base);
  });

  it('存盘里有显式值:设备不覆盖玩家已做过的选择', () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = { matchMedia: matchMediaStub(true) }; // 移动端
    map.set(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ masterVolume: 0.5, showStatsPanel: true, language: 'zh-CN' }),
    );
    const s = loadSettings();
    expect(s.showStatsPanel).toBe(true); // 移动端下显式 true 照留
    expect(s.masterVolume).toBe(0.5); // 其余字段不受影响

    g.window = { matchMedia: matchMediaStub(false) }; // 桌面
    map.set(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ masterVolume: 0.5, showStatsPanel: false, language: 'en' }),
    );
    expect(loadSettings().showStatsPanel).toBe(false); // 桌面下显式 false 照留
  });

  it('老 v1 档没有 showStatsPanel:按设备补出厂档,其余字段原样保留', () => {
    const g = globalThis as unknown as Record<string, unknown>;
    map.set(SETTINGS_STORAGE_KEY, JSON.stringify({ masterVolume: 0.5, shake: 0.5 }));

    g.window = { matchMedia: matchMediaStub(false) };
    const desktop = loadSettings();
    expect(desktop.showStatsPanel).toBe(true);
    expect(desktop.masterVolume).toBe(0.5);
    expect(desktop.shake).toBe(0.5);

    g.window = { matchMedia: matchMediaStub(true) };
    const mobile = loadSettings();
    expect(mobile.showStatsPanel).toBe(false);
    expect(mobile.masterVolume).toBe(0.5);
  });

  it('matchMedia 缺席(非常规环境):按桌面开,不炸', () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = {};
    expect(loadSettings().showStatsPanel).toBe(true);
    delete g.window;
    expect(loadSettings().showStatsPanel).toBe(true);
  });

  it('损坏 JSON:一份随设备的出厂设置(与读不出来同一个口径)', () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = { matchMedia: matchMediaStub(false) };
    map.set(SETTINGS_STORAGE_KEY, '{oops');
    expect(loadSettings().showStatsPanel).toBe(true);
    g.window = { matchMedia: matchMediaStub(true) };
    expect(loadSettings().showStatsPanel).toBe(false);
  });
});
