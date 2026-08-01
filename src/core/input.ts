/**
 * 键盘状态 → 期望航向向量(GDD §3.1:输入是期望航向,不是直接位移)。
 * 骨架阶段尚未接入 sim;02 号 issue(飞船操控)在 World.step 里消费它。
 */
export interface Vec2 {
  x: number;
  y: number;
}

export class Input {
  private keys = new Set<string>();

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => this.keys.add(e.code));
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
