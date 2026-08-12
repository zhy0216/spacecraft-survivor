/**
 * 渲染帧计时窗(只服务 ?debug 调参面板的帧率读数)。
 *
 * **不进 sim、不进 checksum**:量的是真实墙钟耗时,与确定性无关 —— 确定性那一半
 * 在 core/loop.ts(固定时步:tick 数相同则结果逐位相同,与帧率无关)。这里是它的反面:
 * 专门看"这一帧画得够不够快",而那恰恰是唯一不能靠单测量出来的东西(见 sim/bullet.test.ts 文件头)。
 *
 * 为什么不直接读 Pixi 的 `ticker.FPS`:那是 `1000 / 上一帧 elapsedMS`,即**单帧瞬时值**。
 * 面板每 200ms 采一次 = 随机抽某一帧的倒数,读数在 48~63 之间乱跳,分不出"抖了一下"
 * 和"真的掉帧了"。而验收口径(01 号:1000 敌 + 500 弹 @60fps)要盯的是**最差的那一帧** ——
 * 一次 120ms 的卡顿摊进一秒的平均值里只压掉三四帧,平均帧率上根本读不出来。
 * 所以这里给同一个窗口的三种读法:平均帧率(趋势)、平均帧时(对预算)、窗口内最长帧(掉帧)。
 */

/**
 * 统计窗口:最近约 1 秒的帧。**按时长而不是按帧数**取窗 —— 定帧数窗(如"最近 60 帧")
 * 在 144Hz 上只覆盖 0.4 秒、在 20fps 上覆盖 3 秒,读数的时效会随帧率自己漂移,
 * 而"最差帧"本就是拿来对比不同负载的,窗口长度必须与负载无关。
 */
export const FRAME_WINDOW_MS = 1000;

/**
 * 超过这个间隔的"一帧"不算帧,算**时间断点**:切标签页回来、断点停下、系统休眠醒来。
 * Pixi 的 `ticker.elapsedMS` 是**未夹取**的真实间隔(它只夹 deltaMS,见 Ticker.update 里
 * 那句先赋值后夹取),所以后台十秒会原样送进来 —— 不挡的话「最差帧」会被一个根本不是掉帧的数
 * 钉住,还得等整整一个窗口才滚得出去。500ms(≈2fps)已远低于任何"还能玩"的帧率,
 * 拿它当分界不会误伤真掉帧:真掉到那一步,面板读数是不是准已经不重要了。
 */
export const FRAME_SPIKE_MS = 500;

/** 环形缓冲容量 = 1 秒 @ 512fps 封顶。真跑到那个帧率就按最老的挤掉,窗口自然短一点 */
const CAPACITY = 512;

export class FrameMeter {
  private readonly buf = new Float64Array(CAPACITY);
  /** 下一个写入位 */
  private head = 0;
  private count = 0;
  /** 窗口内帧时之和(ms):平均帧率/平均帧时都由它现算,不必每次遍历一遍缓冲 */
  private sum = 0;
  private worst = 0;
  /** worst 欠一次重算:被挤出窗口的那一帧恰好是当前最差帧时立起来(见 drop) */
  private worstDirty = false;

  constructor(private readonly windowMs: number = FRAME_WINDOW_MS) {}

  /**
   * 喂一帧的真实耗时。
   * @param ms 上一渲染帧的墙钟间隔(通常直接给 Pixi 的 ticker.elapsedMS)
   */
  push(ms: number): void {
    // 非正/非数:首帧(ticker 还没有上一帧可减)与时钟回拨。丢掉这一个样本即可,
    // 不必像时间断点那样作废整窗 —— 它不代表"中间过去了一段没画的时间"
    if (!Number.isFinite(ms) || ms <= 0) return;
    if (ms > FRAME_SPIKE_MS) {
      this.reset();
      return;
    }
    if (this.count === CAPACITY) this.drop();
    this.buf[this.head] = ms;
    this.head = (this.head + 1) % CAPACITY;
    this.count++;
    this.sum += ms;
    if (ms > this.worst) this.worst = ms;
    // 滚掉窗口外的老帧。`count > 1` 是兜底:再慢也得给窗口留一个样本,
    // 否则单帧超过窗长(比如 300ms 一帧)会把自己也丢掉,读数变成 0
    while (this.count > 1 && this.sum - this.oldest() >= this.windowMs) this.drop();
  }

  /** 窗口平均帧率(帧/秒);窗口空时 0 */
  get fps(): number {
    return this.sum > 0 ? (this.count * 1000) / this.sum : 0;
  }

  /** 窗口平均帧时(ms)。60fps = 16.7ms —— 它比 fps 更好与"一帧的预算"直接比 */
  get frameMs(): number {
    return this.count > 0 ? this.sum / this.count : 0;
  }

  /**
   * 窗口内最长的一帧(ms)。**"掉帧了没"看这个数**,平均值会把一次卡顿磨平。
   * 重算只发生在最差帧刚被挤出窗口的那一次(见 worstDirty),不是每次读都遍历。
   */
  get worstMs(): number {
    if (this.worstDirty) {
      let max = 0;
      for (let i = 0; i < this.count; i++) {
        const v = this.buf[(this.tail + i) % CAPACITY]!;
        if (v > max) max = v;
      }
      this.worst = max;
      this.worstDirty = false;
    }
    return this.worst;
  }

  /** 清窗(时间断点):读数从下一帧起重新攒 */
  reset(): void {
    this.head = 0;
    this.count = 0;
    this.sum = 0;
    this.worst = 0;
    this.worstDirty = false;
  }

  /** 最老那一帧的下标(环形缓冲的尾) */
  private get tail(): number {
    return (this.head - this.count + CAPACITY) % CAPACITY;
  }

  private oldest(): number {
    return this.buf[this.tail]!;
  }

  private drop(): void {
    const v = this.buf[this.tail]!;
    this.sum -= v;
    this.count--;
    // 挤掉的正是当前最差帧 → 欠一次重算(而不是当场扫一遍:连续滚窗时那是每帧 O(n))
    if (v >= this.worst) this.worstDirty = true;
  }
}
