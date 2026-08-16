/**
 * 调参面板(畅玩性)。不测每一根滑杆的绑定(那是 tweakpane 的职责),
 * 只测面板自己的两条**布局行为**:
 * ① 包装层(.tp-dfwv)必须限高 + 可纵向滚动 —— 面板内容比一屏高,不滚动底下几组够不着;
 * ② 显隐句柄 show/hide/toggle/visible 收敛在 pane.hidden 上(main.ts 的连按三次 ~ 靠它)。
 * tweakpane 在 node 环境建不起来(要 document),整模块 vi.mock 成最小桩。
 */
import { describe, expect, it, vi } from 'vitest';

interface FakeStyle {
  maxHeight?: string;
  overflowY?: string;
}

// vi.mock 工厂会被提升到文件顶,类定义放不进工厂里 —— 用 vi.hoisted 先建好
const { FakePane } = vi.hoisted(() => {
  class FakeFolder {
    title: string;
    constructor(params: { title?: string }) {
      this.title = params.title ?? '';
    }
    addBinding(): unknown {
      return {};
    }
    addButton(): { on(): void } {
      return { on: () => {} };
    }
  }

  class FakePane {
    static last: FakePane | null = null;
    element: { parentElement: { style: FakeStyle } };
    hidden = false;
    folders: FakeFolder[] = [];
    constructor() {
      FakePane.last = this;
      this.element = { parentElement: { style: {} } };
    }
    addFolder(params: { title?: string }): FakeFolder {
      const folder = new FakeFolder(params);
      this.folders.push(folder);
      return folder;
    }
  }

  return { FakePane };
});

vi.mock('tweakpane', () => ({ Pane: FakePane }));

import { createDebugPanel, type DebugStats, type RunHooks } from './debugPanel';

function makeStats(): DebugStats {
  return {
    fps: 60,
    frameMs: 16.7,
    worstMs: 16.7,
    enemies: 0,
    bullets: 0,
    speed: 100,
    turnRate: 90,
    hp: 100,
    maxHp: 100,
    tick: 0,
    checksum: '0',
    seed: 1,
    segment: 0,
    segTime: 0,
    threatDeg: 0,
    threatRate: 0,
    kills: 0,
    scrap: 0,
    upgrades: 0,
    upgradeCost: 10,
  };
}

function makeHooks(): RunHooks {
  return { restart: () => {}, retry: () => {}, spawnShop: () => {}, addWeapon: () => {}, spawnBoss: () => {} };
}

describe('createDebugPanel', () => {
  it('包装层写上限高与纵向滚动样式:面板比一屏高时底下几组抽屉滚得到', () => {
    createDebugPanel(makeStats(), { paused: false, timeScale: 1 }, makeHooks());
    const lastPane = FakePane.last;
    expect(lastPane).not.toBeNull();
    const style = lastPane!.element.parentElement.style;
    expect(style.maxHeight).toBe('calc(100vh - 16px)');
    expect(style.overflowY).toBe('auto');
  });

  it('显隐句柄收敛在 pane.hidden 上(main.ts 连按三次 ~ 靠它呼出/收起)', () => {
    const panel = createDebugPanel(makeStats(), { paused: false, timeScale: 1 }, makeHooks());
    expect(panel.visible()).toBe(true);
    panel.hide();
    expect(panel.visible()).toBe(false);
    panel.toggle();
    expect(panel.visible()).toBe(true);
    panel.show();
    expect(panel.visible()).toBe(true);
  });
});
