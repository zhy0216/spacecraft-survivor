/**
 * 空间哈希(GDD §13:cell 尺寸 = 最大敌半径 × 2)。
 * 每逻辑帧 clear + 全量 insert,查询做粗筛(返回覆盖 cell 内所有对象),
 * 精确距离判定由调用方完成。cell 数组复用,不在运行期反复分配。
 */
export interface HasPosition {
  x: number;
  y: number;
}

export class SpatialHash<T extends HasPosition> {
  private cells = new Map<number, T[]>();

  constructor(readonly cellSize: number) {}

  /** cell 坐标打包成 int key。世界范围假定在 ±32768 个 cell 之内(远超本作场地) */
  private key(cx: number, cy: number): number {
    return (cx + 0x8000) | ((cy + 0x8000) << 16);
  }

  clear(): void {
    for (const arr of this.cells.values()) arr.length = 0;
  }

  insert(item: T): void {
    const cx = Math.floor(item.x / this.cellSize);
    const cy = Math.floor(item.y / this.cellSize);
    const k = this.key(cx, cy);
    let arr = this.cells.get(k);
    if (!arr) {
      arr = [];
      this.cells.set(k, arr);
    }
    arr.push(item);
  }

  /** 收集 (x,y) 半径 r 覆盖的所有 cell 中的对象到 out(复用外部数组,零分配) */
  query(x: number, y: number, r: number, out: T[]): T[] {
    out.length = 0;
    const minX = Math.floor((x - r) / this.cellSize);
    const maxX = Math.floor((x + r) / this.cellSize);
    const minY = Math.floor((y - r) / this.cellSize);
    const maxY = Math.floor((y + r) / this.cellSize);
    for (let cy = minY; cy <= maxY; cy++) {
      for (let cx = minX; cx <= maxX; cx++) {
        const arr = this.cells.get(this.key(cx, cy));
        if (arr) {
          for (let i = 0; i < arr.length; i++) out.push(arr[i]!);
        }
      }
    }
    return out;
  }
}
