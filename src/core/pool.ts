/**
 * 泛型对象池:预分配 + 复用,目标是战斗运行期零新增分配(GDD §13 实体全对象池)。
 * items 是致密数组,可直接 for 顺序遍历;回收用 swap-remove,O(1) 但不保序。
 */
export class Pool<T> {
  /** 活跃对象(致密,遍历这个) */
  readonly items: T[] = [];
  private free: T[] = [];

  constructor(
    private factory: () => T,
    private reset: (item: T) => void,
    prealloc = 0,
  ) {
    for (let i = 0; i < prealloc; i++) this.free.push(factory());
  }

  spawn(): T {
    const item = this.free.pop() ?? this.factory();
    this.reset(item);
    this.items.push(item);
    return item;
  }

  /** swap-remove:末尾对象顶替被删位。倒序遍历中回收是安全的;正序遍历需在回收后重查当前下标 */
  despawnAt(index: number): void {
    const item = this.items[index]!;
    const last = this.items.pop()!;
    if (item !== last) this.items[index] = last;
    this.free.push(item);
  }

  get size(): number {
    return this.items.length;
  }
}
