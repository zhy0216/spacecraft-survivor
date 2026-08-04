/**
 * 空间哈希(GDD §13:cell 尺寸 = 最大敌半径 × 2)。
 * 每逻辑帧 clear + 全量 insert,查询做粗筛(返回覆盖 cell 内所有对象),
 * 精确距离判定由调用方完成。cell 数组复用:住过人的桶只清 length,
 * 被清理掉的空桶数组进备件箱等着复用(见 spare)—— 稳态零分配,巡航迁移期也只是搬运。
 */
export interface HasPosition {
  x: number;
  y: number;
}

/**
 * 空桶清理阈值(cell 个数)。地图无限之后,船一路航行会把桶 Map 撒满一条航迹 ——
 * 空数组只清 length 不删条目的话,内存与 clear() 的每帧耗时都随航程**无限增长**。
 * 但也不能每帧删空桶:虫群边缘的 cell 逐帧进出,帧帧删了又建就是纯 GC churn。
 * 折中:桶数越过这一档才把空桶删掉(在场敌人上限 1400 ⇒ 活跃桶 ≤ 1400,4096 留了近 3 倍余量),
 * 于是常态零分配、长途航行时偶尔一次 O(桶数) 的清理把内存拉回在场规模。
 */
const PRUNE_CELLS = 4096;

/**
 * 空桶数组备件箱的上限。巡航时敌群每秒迁进上百个新 cell:没有备件箱,每个新桶都要
 * new 一个数组、每次清理又把几千个旧数组一口气丢给 GC —— 周期性的分配脉冲正是铁律 3
 * 要避开的。有界是必须的:备件箱自己不能变成第二个只涨不落的内存池。
 */
const SPARE_MAX = 512;

export class SpatialHash<T extends HasPosition> {
  private cells = new Map<number, T[]>();
  /** 被清理下岗的空桶数组暂存于此,insert 新 cell 时优先复用(理由见 SPARE_MAX) */
  private spare: T[][] = [];

  constructor(readonly cellSize: number) {}

  /** 当前桶数(含空桶)。只读诊断口径,清理阈值的单测钉的就是它 */
  get cellCount(): number {
    return this.cells.size;
  }

  /** cell 坐标打包成 int key。世界范围假定在 ±32768 个 cell 之内(±90 万 px,25 分钟一局开不出去) */
  private key(cx: number, cy: number): number {
    return (cx + 0x8000) | ((cy + 0x8000) << 16);
  }

  clear(): void {
    if (this.cells.size > PRUNE_CELLS) {
      // 上一帧没人住的桶直接删(遍历中 delete 对 Map 是安全的),数组进备件箱等复用;
      // 住着人的照旧只清 length
      for (const [k, arr] of this.cells) {
        if (arr.length === 0) {
          this.cells.delete(k);
          if (this.spare.length < SPARE_MAX) this.spare.push(arr);
        } else {
          arr.length = 0;
        }
      }
      return;
    }
    for (const arr of this.cells.values()) arr.length = 0;
  }

  insert(item: T): void {
    const cx = Math.floor(item.x / this.cellSize);
    const cy = Math.floor(item.y / this.cellSize);
    const k = this.key(cx, cy);
    let arr = this.cells.get(k);
    if (!arr) {
      // 优先从备件箱取:巡航时新 cell 源源不断,现 new 就是每秒上百次分配(铁律 3)
      arr = this.spare.pop() ?? [];
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
