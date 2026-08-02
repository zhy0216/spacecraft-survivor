/**
 * 输入层里唯一值得单测的一段:哪些键要吞掉浏览器默认行为(04 号 T3-b 的 Tab)。
 * 本仓的 vitest 跑在 Node 环境(不装 jsdom),但 Input 的事件源是构造参数注入的 ——
 * 塞一个只记 handler 的假 window,就能在 Node 里把 keydown/keyup 全流程跑完,
 * 不必为这几行把一个 DOM 环境拖进来(照 ui/upgradeFlow.test.ts 的同一条取舍)。
 *
 * 钉的是两件事,漏哪一件"按住 Tab 显示射界"都会坏,而且都是肉眼很难当场归因的坏法:
 * 1. Tab 必须 preventDefault —— 否则浏览器拿它切焦点,焦点跑进调参面板的输入框,
 *    松手的 keyup 落到那个元素上而不是 window,'Tab' 永远清不掉,叠加层卡常亮;
 * 2. 拦默认行为 ≠ 吞掉按键 —— Tab 仍要进 keys,否则叠加层根本没有触发源。
 */
import { describe, expect, it } from 'vitest';
import { Input } from './input';

/** 假事件:只留 Input 会碰的 code,外加一个能被断言的 preventDefault 痕迹 */
interface FakeKeyEvent {
  code: string;
  defaultPrevented: boolean;
  preventDefault(): void;
}

function keyEvent(code: string): FakeKeyEvent {
  const e: FakeKeyEvent = {
    code,
    defaultPrevented: false,
    preventDefault(): void {
      e.defaultPrevented = true;
    },
  };
  return e;
}

/** 假 window:Input 每种事件只注册一个 handler,故一个 Map 就够,不必做派发树 */
function fakeWindow(): { target: Window; fire: (type: string, e?: FakeKeyEvent) => void } {
  const handlers = new Map<string, (e: FakeKeyEvent) => void>();
  const target = {
    addEventListener(type: string, h: (e: FakeKeyEvent) => void): void {
      handlers.set(type, h);
    },
  } as unknown as Window;
  return {
    target,
    fire: (type, e = keyEvent('')): void => {
      const h = handlers.get(type);
      // 没注册就报错而不是静默跳过:那说明 Input 少监听了一种事件,正是本文件该拦下的回归
      if (!h) throw new Error(`未注册的事件:${type}`);
      h(e);
    },
  };
}

describe('Input · 默认行为拦截', () => {
  it('Tab 被 preventDefault,但照常进 keys(按住期间 isDown 为真)', () => {
    const { target, fire } = fakeWindow();
    const input = new Input(target);

    const down = keyEvent('Tab');
    fire('keydown', down);
    expect(down.defaultPrevented).toBe(true);
    expect(input.isDown('Tab')).toBe(true);

    // 松手就灭:叠加层是"按住显示"而不是 toggle(GDD §4.2)
    fire('keyup', keyEvent('Tab'));
    expect(input.isDown('Tab')).toBe(false);
  });

  it('其余键一律不拦 —— 全量 preventDefault 会连浏览器快捷键与将来的文本输入一起废掉', () => {
    const { target, fire } = fakeWindow();
    new Input(target);

    for (const code of ['KeyW', 'KeyA', 'ArrowUp', 'KeyB', 'Escape']) {
      const e = keyEvent(code);
      fire('keydown', e);
      expect(e.defaultPrevented).toBe(false);
    }
  });

  it('窗口失焦时清空按键,按住 Tab 切出去不会把叠加层留成常亮', () => {
    const { target, fire } = fakeWindow();
    const input = new Input(target);

    fire('keydown', keyEvent('Tab'));
    fire('blur');
    expect(input.isDown('Tab')).toBe(false);
  });
});
