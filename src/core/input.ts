/**
 * 键盘状态 → 期望航向向量(GDD §3.1:输入是期望航向,不是直接位移)。
 * 骨架阶段尚未接入 sim;02 号 issue(飞船操控)在 World.step 里消费它。
 */
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
 */
const PREVENT_DEFAULT = new Set(['Tab']);

export class Input {
  private keys = new Set<string>();

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => {
      // 拦默认行为 ≠ 吞掉这次按键:照常记进 keys,否则"按住 Tab 显示射界"就没了触发源
      if (PREVENT_DEFAULT.has(e.code)) e.preventDefault();
      this.keys.add(e.code);
    });
    target.addEventListener('keyup', (e) => this.keys.delete(e.code));
    target.addEventListener('blur', () => this.keys.clear());
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** 归一化期望航向;无输入返回 null(= 维持当前航向滑行减速) */
  desiredHeading(): Vec2 | null {
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
