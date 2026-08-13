/**
 * I 键首局提示(28 号)的 localStorage 适配器。与其他 localStorage 适配器
 * (runSaveStorage 那类)不同,本模块没有模块级状态、只在调用点读全局 localStorage,
 * 所以注入一个 Map 桩就能把"按过一次 I 就永久不再飘"这条事实钉在 Node 里。
 * main.ts 里 20s 窗口 / 本局只飘一次的那半逻辑住在 boot() 的 ticker 闭包里
 * (耦合 pixi、Input、全流程 UI,拆不出来单测),本文件钉死它依赖的存储层:
 * 永久标记的真值住 localStorage 里,读不出来就当没按过、写不进去就静默失败。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadIPressed, markIPressed } from './keyHintStorage';

/** keyHintStorage 只认 getItem/setItem 两个口子;桩按真实语义实现(Map 就是一台极简存储) */
interface FakeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 存储键与实现同源。这里直抄一份而不导出:键名是契约,抄错两份都红,正好互为校验 */
const I_KEY_HINT_STORAGE_KEY = 'starwreck.keyhint.i-pressed.v1';

describe('keyHintStorage', () => {
  let map: Map<string, string>;
  let fake: FakeStorage;
  let prev: unknown;

  beforeEach(() => {
    map = new Map();
    fake = {
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => {
        map.set(key, value);
      },
    };
    const g = globalThis as unknown as Record<string, unknown>;
    prev = g.localStorage;
    g.localStorage = fake;
  });
  afterEach(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    if (prev === undefined) delete g.localStorage;
    else g.localStorage = prev;
  });

  it('从未按过 I:键缺失时读作没按过 —— 首局提示该飘', () => {
    expect(loadIPressed()).toBe(false);
  });

  it('markIPressed 把"按过"落进 localStorage:底层存储里真的躺着 ' + "'1'" + ',读出口恒真', () => {
    markIPressed();
    // 真值住在 localStorage 里,不是模块内存:直接读底层存储,键值就是 '1'
    expect(fake.getItem(I_KEY_HINT_STORAGE_KEY)).toBe('1');
    expect(loadIPressed()).toBe(true);
    // 反复读不丢:按过一次 I 就永久不再飘,这条事实不随读次数漂移
    expect(loadIPressed()).toBe(true);
  });

  it('标记跟着存储走:清空 localStorage(如玩家清站点数据)后回到"没按过"', () => {
    markIPressed();
    expect(loadIPressed()).toBe(true);
    map.clear();
    // 兜底方向:最坏后果只是提示再飘一次,不会卡死成"永不再飘"
    expect(loadIPressed()).toBe(false);
  });

  it('隐私模式 / 存储不可用:读作没按过、写静默失败,不炸流程', () => {
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.localStorage;
    expect(loadIPressed()).toBe(false);
    expect(() => markIPressed()).not.toThrow();
  });
});
