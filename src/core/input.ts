/**
 * 键盘状态 → 期望航向向量(GDD §3.1:输入是期望航向,不是直接位移)。
 * 骨架阶段尚未接入 sim;02 号 issue(飞船操控)在 World.step 里消费它。
 */
import { isTyping } from './isTyping';

export interface Vec2 {
  x: number;
  y: number;
}

/**
 * 需要吞掉浏览器默认行为的键(按 e.code 匹配)。
 * Tab 是 04 号射界叠加层的"按住显示"键(GDD §4.2):不拦的话浏览器会拿它切焦点,
 * 焦点一路移进调参面板的输入框 —— 按住 Tab 就变成"焦点在一格格跳",
 * 而且松手的 keyup 会落到那个新获得焦点的元素上、根本传不回 window,
 * keys 里的 'Tab' 于是永远清不掉,叠加层卡在常亮(blur 兜底也只在整个窗口失焦时才触发)。
 * 只列真正需要的键:全量 preventDefault 会把浏览器快捷键与将来的文本输入一起废掉。
 * Space 是加速技能键:不拦的话浏览器会拿它滚动页面,还会"点击"恰好持有焦点的按钮 ——
 * 战斗中每次加速都可能顺手触发一次静音开关这类灾难。
 */
const PREVENT_DEFAULT = new Set(['Tab', 'Space']);

export class Input {
  private keys = new Set<string>();
  /** 触控摇杆的期望航向。单独存分量,避免 pointermove 热路径反复分配 Vec2。 */
  private virtualHeadingX = 0;
  private virtualHeadingY = 0;
  private virtualHeadingActive = false;
  /** 触控按钮映射成与键盘同名的虚拟键；World 仍只看到同一份纯输入命令。 */
  private virtualKeys = new Set<string>();

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => {
      // 拦默认行为 ≠ 吞掉这次按键:照常记进 keys,否则"按住 Tab 显示射界"就没了触发源。
      // isTyping 守卫(二轮审查):焦点在输入框里(开发期 Tweakpane 的文本框)时这一记
      // 是打字,preventDefault 会让空格打不出来、Tab 切不动焦点 —— 玩家侧没有文本输入,
      // 这条只救 dev 工具
      if (PREVENT_DEFAULT.has(e.code) && !isTyping()) e.preventDefault();
      this.keys.add(e.code);
    });
    target.addEventListener('keyup', (e) => this.keys.delete(e.code));
    target.addEventListener('blur', () => {
      this.keys.clear();
      this.clearVirtualInput();
    });
  }

  isDown(code: string): boolean {
    return this.keys.has(code) || this.virtualKeys.has(code);
  }

  /**
   * 触控摇杆写入屏幕/世界同向的航向。输入可不是单位向量：这里统一归一化，
   * 让 UI 手势的半径只决定摇杆视觉位移，不改变 sim 的转向语义。
   */
  setVirtualHeading(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      this.clearVirtualHeading();
      return;
    }
    const len = Math.hypot(x, y);
    if (len <= 1e-6) {
      this.clearVirtualHeading();
      return;
    }
    this.virtualHeadingX = x / len;
    this.virtualHeadingY = y / len;
    this.virtualHeadingActive = true;
  }

  clearVirtualHeading(): void {
    this.virtualHeadingX = 0;
    this.virtualHeadingY = 0;
    this.virtualHeadingActive = false;
  }

  setVirtualKey(code: string, down: boolean): void {
    if (down) this.virtualKeys.add(code);
    else this.virtualKeys.delete(code);
  }

  clearVirtualInput(): void {
    this.clearVirtualHeading();
    this.virtualKeys.clear();
  }

  /** 归一化期望航向;无输入返回 null(= 维持当前航向滑行减速) */
  desiredHeading(): Vec2 | null {
    // 摇杆按着时优先于键盘。松手即回到键盘分支，桌面调试与移动触控可以共存。
    if (this.virtualHeadingActive) {
      return { x: this.virtualHeadingX, y: this.virtualHeadingY };
    }
    let x = 0;
    let y = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) y -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) y += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    if (x === 0 && y === 0) return null;
    const len = Math.hypot(x, y);
    return { x: x / len, y: y / len };
  }
}
