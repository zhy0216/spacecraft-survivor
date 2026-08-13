/**
 * 波次运行器(08 号 issue T2)的机制单测。
 * 钉的是「脚本 → 出怪事件」这条翻译本身:每帧五步的先后、带余数进位的段推进、
 * 小数速率的账,以及最要紧的一条 —— rng 消耗顺序(08 验收:同 seed 两局出怪序列一致)。
 *
 * 一律用本文件 splice 进去的短脚本,不拿 data/waves.ts 里那份 480 秒的真脚本当基准:
 * 真脚本在 M0 会被反复调,拿它写断言的用例活不过第一次平衡改动(与 steering.test.ts 同口径);
 * 真脚本自身的口径由 data/waves.test.ts 钉。splice + afterEach 还原也正是数据表
 * 刻意不 Object.freeze 的理由(与 data/enemies.test.ts 一致)。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SIM_DT, SIM_HZ } from '../core/loop';
import { Rng } from '../core/rng';
import { UNLOCKS } from '../data/unlocks';
import {
  BURST_PATTERN_DIRECTIONAL,
  BURST_PATTERN_RING,
  WAVE_LOCKED_ELITES,
  WAVE_MAX_SPAWN_PER_TICK,
  WAVE_MAX_STREAMS,
  WAVE_SEGMENTS,
  WAVE_TOTAL_TIME,
  type WaveBurst,
  type WaveSegment,
  type WaveStream,
} from '../data/waves';
import { DEG2RAD, wrapAngle } from './ship';
import {
  createWaveState,
  resetWaveState,
  type SpawnSink,
  stepWaves,
  tideMulAt,
  type WaveState,
  waveDirAt,
  waveIntensityAt,
} from './waves';

/** 真脚本原样留一份:每个用例都会换成短脚本,跑完必须还原,否则污染同文件后续用例 */
const REAL = WAVE_SEGMENTS.slice();
/** 解锁槽位表同样原样留一份:用例会换成测试槽位,跑完必须还原 */
const REAL_LOCKED = WAVE_LOCKED_ELITES.slice();
afterEach(() => {
  WAVE_SEGMENTS.splice(0, WAVE_SEGMENTS.length, ...REAL);
  WAVE_LOCKED_ELITES.splice(0, WAVE_LOCKED_ELITES.length, ...REAL_LOCKED);
});

/** 换脚本。runner 每帧现读 WAVE_SEGMENTS,故换完直接 createWaveState 就是新脚本的开局 */
function useScript(...segs: WaveSegment[]): void {
  WAVE_SEGMENTS.splice(0, WAVE_SEGMENTS.length, ...segs);
}

function stream(p: Partial<WaveStream> = {}): WaveStream {
  return { kind: 0, rate0: 0, rate1: 0, spreadDeg: 0, ...p };
}
function burst(p: Partial<WaveBurst> = {}): WaveBurst {
  return { at: 0, offsetDeg: 0, spreadDeg: 0, pattern: 0, counts: [0, 0, 0, 0], ...p };
}
function segment(p: Partial<WaveSegment> = {}): WaveSegment {
  return {
    name: 'seg',
    duration: 10,
    dirStartDeg: 0,
    dirEndDeg: 0,
    streams: [],
    bursts: [],
    elites: [],
    tides: [],
    ...p,
  };
}

interface Rec extends SpawnSink {
  list: { kind: number; angle: number; affixes?: readonly number[] }[];
}
/** 收怪的假 sink:运行器只认识这一份契约,单测里它就是一个数组(铁律 1 的一层验证) */
function rec(): Rec {
  const list: { kind: number; angle: number; affixes?: readonly number[] }[] = [];
  return {
    list,
    spawn(kind: number, angle: number, affixes?: readonly number[]): void {
      // affixes 不落地成 undefined 字段:既有 toEqual 整条列表的断言不受影响
      list.push(affixes === undefined ? { kind, angle } : { kind, angle, affixes });
    },
  };
}

/** 数 rng 消耗次数。子类而不是对象字面量:Rng 有私有字段,结构类型对不上 */
class CountingRng extends Rng {
  calls = 0;
  next(): number {
    this.calls++;
    return super.next();
  }
}

function run(s: WaveState, frames: number, dt: number, rng: Rng, sink: SpawnSink): void {
  for (let i = 0; i < frames; i++) stepWaves(s, dt, rng, sink);
}

describe('waveDirAt', () => {
  it('段首→段尾线性插值,按**累积角**走不折回(320° → 480° 是继续顺时针转,不是倒回去)', () => {
    const seg = segment({ duration: 10, dirStartDeg: 320, dirEndDeg: 480 });
    expect(seg.dirEndDeg - seg.dirStartDeg).toBe(160); // 数据表写累积角的前提
    expect(waveDirAt(seg, 0)).toBeCloseTo(wrapAngle(320 * DEG2RAD), 9);
    expect(waveDirAt(seg, 5)).toBeCloseTo(wrapAngle(400 * DEG2RAD), 9); // 400° 折回 = 40°
    expect(waveDirAt(seg, 10)).toBeCloseTo(wrapAngle(480 * DEG2RAD), 9); // 480° 折回 = 120°

    // 跨 0° 的那一段必须**单调同向**:折回的数据(320 → 120)会让它倒着转一圈,
    // "最优舷持续漂移"当场变成"最优舷来回抽搐"(GDD §6.3)
    let prev = waveDirAt(seg, 0);
    for (let t = 0.5; t <= 10; t += 0.5) {
      const cur = waveDirAt(seg, t);
      expect(wrapAngle(cur - prev)).toBeGreaterThan(0);
      prev = cur;
    }
  });

  it('返回值恒在 (-π, π]:罗盘拿到的永远是折回过的绝对角', () => {
    const seg = segment({ duration: 10, dirStartDeg: -720, dirEndDeg: 720 });
    for (let t = 0; t <= 10; t += 0.25) {
      const a = waveDirAt(seg, t);
      expect(a).toBeGreaterThan(-Math.PI - 1e-9);
      expect(a).toBeLessThanOrEqual(Math.PI + 1e-9);
    }
  });

  it('段外的 segTime 夹在 [0,1] 进度内,duration <= 0 的坏数据回落成段首角(不吐 NaN)', () => {
    const seg = segment({ duration: 10, dirStartDeg: 30, dirEndDeg: 90 });
    expect(waveDirAt(seg, -5)).toBeCloseTo(30 * DEG2RAD, 9);
    expect(waveDirAt(seg, 999)).toBeCloseTo(90 * DEG2RAD, 9);
    const bad = segment({ duration: 0, dirStartDeg: 30, dirEndDeg: 90 });
    expect(waveDirAt(bad, 5)).toBeCloseTo(30 * DEG2RAD, 9);
  });
});

describe('waveIntensityAt', () => {
  it('= 各流当前速率之和,逐流按 rate0 → rate1 线性插值(随时间的密度曲线)', () => {
    const seg = segment({
      duration: 10,
      streams: [stream({ rate0: 1, rate1: 3 }), stream({ rate0: 2, rate1: 2 })],
    });
    expect(waveIntensityAt(seg, 0)).toBeCloseTo(3, 9);
    expect(waveIntensityAt(seg, 5)).toBeCloseTo(4, 9);
    expect(waveIntensityAt(seg, 10)).toBeCloseTo(5, 9);
  });

  it('侧压事件不计入强度:它是脉冲,不是速率', () => {
    const seg = segment({ duration: 10, bursts: [burst({ at: 0, counts: [50, 0, 0, 0] })] });
    expect(waveIntensityAt(seg, 0)).toBe(0);
  });
});

describe('潮汐(tides,节奏改版)', () => {
  it('tideMulAt:窗口内取 mul、窗口外恒 1,边界含头不含尾', () => {
    const seg = segment({
      duration: 30,
      tides: [
        { at: 5, duration: 5, mul: 0.5 },
        { at: 20, duration: 5, mul: 1.4 },
      ],
    });
    expect(tideMulAt(seg, 0)).toBe(1);
    expect(tideMulAt(seg, 5)).toBe(0.5); // 含头
    expect(tideMulAt(seg, 9.999)).toBe(0.5);
    expect(tideMulAt(seg, 10)).toBe(1); // 不含尾
    expect(tideMulAt(seg, 22)).toBe(1.4);
    expect(tideMulAt(seg, 25)).toBe(1);
    expect(tideMulAt(segment({ duration: 10 }), 3)).toBe(1); // 无潮汐编排 = 恒基线
  });

  it('退潮攒账变慢:1 只/秒 × mul 0.5,10 秒只出 5 只,且 rng 消耗 = 出怪数(潮汐零 rng)', () => {
    // 段长 20 > 跑的 10 帧:最后一帧不撞段边界(撞界那一帧只推进不出怪,不属于本用例要钉的事)
    useScript(
      segment({
        duration: 20,
        streams: [stream({ rate0: 1, rate1: 1 })],
        tides: [{ at: 0, duration: 20, mul: 0.5 }],
      }),
    );
    const s = createWaveState();
    const r = rec();
    const rng = new CountingRng(7);
    run(s, 10, 1, rng, r);
    expect(r.list.length).toBe(5);
    expect(rng.calls).toBe(5); // 每成功出一只恰一次,窗口本身一次都不掷
  });

  it('涨潮攒账变快:1 只/秒 × mul 1.5,10 秒出 15 只(重分配的另一半)', () => {
    useScript(
      segment({
        duration: 20,
        streams: [stream({ rate0: 1, rate1: 1 })],
        tides: [{ at: 0, duration: 20, mul: 1.5 }],
      }),
    );
    const s = createWaveState();
    const r = rec();
    run(s, 10, 1, new Rng(7), r);
    expect(r.list.length).toBe(15);
  });

  it('窗口只管窗口内:进窗前的出怪序列与无潮汐脚本逐位一致(同 seed 契约不被窗口的存在扰动)', () => {
    const base = () =>
      segment({ duration: 10, streams: [stream({ rate0: 1, rate1: 1, spreadDeg: 30 })] });
    useScript(base());
    const plain = rec();
    const s1 = createWaveState();
    run(s1, 5, 1, new Rng(42), plain);

    const tided = base();
    tided.tides = [{ at: 6, duration: 3, mul: 0.5 }]; // 窗口在第 6 秒之后,前 5 秒不该受影响
    useScript(tided);
    const withTide = rec();
    const s2 = createWaveState();
    run(s2, 5, 1, new Rng(42), withTide);

    expect(withTide.list).toEqual(plain.list);
  });

  it('waveIntensityAt 乘上潮汐系数:罗盘强度如实反映"此刻静了/涨了"', () => {
    const seg = segment({
      duration: 10,
      streams: [stream({ rate0: 2, rate1: 4 })],
      tides: [{ at: 4, duration: 2, mul: 0.5 }],
    });
    expect(waveIntensityAt(seg, 0)).toBeCloseTo(2, 9);
    expect(waveIntensityAt(seg, 5)).toBeCloseTo(1.5, 9); // 基线 3 × 退潮 0.5
    expect(waveIntensityAt(seg, 8)).toBeCloseTo(3.6, 9); // 窗口外回基线
  });

  it('事件不受潮汐管:深退潮里 burst/精英照常整组出(它们是原子脉冲,不在密度曲线里)', () => {
    useScript(
      segment({
        duration: 10,
        bursts: [burst({ at: 3, counts: [4, 0, 0, 0] })],
        elites: [{ at: 5, kind: 1, count: 2, affixes: [0] }],
        tides: [{ at: 0, duration: 10, mul: 0.2 }],
      }),
    );
    const s = createWaveState();
    const r = rec();
    run(s, 10, 1, new Rng(7), r);
    expect(r.list.length).toBe(6); // 4(burst)+ 2(精英),流本来就是空的
    expect(r.list.filter((e) => e.affixes !== undefined).length).toBe(2);
  });
});

describe('createWaveState / resetWaveState', () => {
  it('开局立刻是第 0 段 t=0 的方向与强度 —— HUD 第一帧就该指对,而不是先指 0 再跳', () => {
    useScript(
      segment({ duration: 10, dirStartDeg: 30, dirEndDeg: 90, streams: [stream({ rate0: 2, rate1: 4 })] }),
    );
    const s = createWaveState();
    expect(s.segment).toBe(0);
    expect(s.segTime).toBe(0);
    expect(s.burstNext).toBe(0);
    expect(s.done).toBe(false);
    expect(s.dirRad).toBeCloseTo(30 * DEG2RAD, 9);
    expect(s.intensity).toBeCloseTo(2, 9);
    // debt 预分配到全脚本最大流数:正常换段时一个字节都不必再分配(铁律 3)
    expect(s.debt.length).toBeGreaterThanOrEqual(WAVE_MAX_STREAMS);
    expect(s.debt.every((v) => v === 0)).toBe(true);
  });

  it('空脚本 = 一开局就 done:不出怪、连 rng 都不碰', () => {
    useScript();
    const s = createWaveState();
    expect(s.done).toBe(true);
    const r = rec();
    const rng = new CountingRng(1);
    run(s, 10, SIM_DT, rng, r);
    expect(r.list).toEqual([]);
    expect(rng.calls).toBe(0);
  });

  it('逐字段复位到开局,且复位后同 seed 重跑出的序列与第一次一字不差', () => {
    useScript(
      segment({
        duration: 1,
        dirStartDeg: 0,
        dirEndDeg: 90,
        streams: [stream({ kind: 1, rate0: 4, rate1: 4, spreadDeg: 15 })],
        bursts: [burst({ at: 0.4, offsetDeg: 90, spreadDeg: 5, counts: [1, 0, 2, 0] })],
      }),
      segment({ duration: 1, dirStartDeg: 90, dirEndDeg: 180 }),
    );
    const s = createWaveState();
    const first = rec();
    run(s, 5, 0.25, new Rng(99), first); // 跑到第二段中间:段号/段内时间/账/游标全脏了才叫复位
    expect(first.list.length).toBeGreaterThan(0);
    expect(s.segment).toBe(1);
    expect(s.segTime).toBeGreaterThan(0);

    resetWaveState(s);
    expect(s.segment).toBe(0);
    expect(s.segTime).toBe(0);
    expect(s.burstNext).toBe(0);
    expect(s.done).toBe(false);
    expect(s.debt.every((v) => v === 0)).toBe(true);
    expect(s.dirRad).toBeCloseTo(0, 9);
    expect(s.intensity).toBeCloseTo(4, 9);

    const second = rec();
    run(s, 5, 0.25, new Rng(99), second);
    expect(second.list).toEqual(first.list);
  });
});

describe('stepWaves 每帧的五步顺序', () => {
  it('同一帧内:侧压事件先出、主压怪流后出,事件内按 counts 下标 0..N 升序', () => {
    useScript(
      segment({
        duration: 10,
        streams: [stream({ kind: 3, rate0: 4, rate1: 4 })], // dt=0.5 → 每帧整 2 只
        bursts: [burst({ at: 0, counts: [1, 2, 0, 0] })],
      }),
    );
    const s = createWaveState();
    const r = rec();
    stepWaves(s, 0.5, new Rng(7), r);
    // 顺序一旦调换,整条 rng 序列跟着错位 —— 同 seed 复现当场作废
    expect(r.list.map((e) => e.kind)).toEqual([0, 1, 1, 3, 3]);
  });

  it('侧压事件只触发一次,游标一路向前', () => {
    useScript(
      segment({ duration: 10, bursts: [burst({ at: 0.2, counts: [0, 3, 0, 0] })] }),
    );
    const s = createWaveState();
    const r = rec();
    stepWaves(s, 0.1, new Rng(3), r);
    expect(r.list.length).toBe(0); // 还没到点
    stepWaves(s, 0.2, new Rng(3), r);
    expect(r.list.length).toBe(3);
    expect(s.burstNext).toBe(1);
    run(s, 20, 0.2, new Rng(3), r);
    expect(r.list.length).toBe(3); // 到点过一次就不再复发
  });

  it('同一帧到点的多个事件按 at 升序全部触发', () => {
    useScript(
      segment({
        duration: 10,
        bursts: [
          burst({ at: 0.1, counts: [1, 0, 0, 0] }),
          burst({ at: 0.2, counts: [0, 1, 0, 0] }),
          burst({ at: 5, counts: [0, 0, 1, 0] }),
        ],
      }),
    );
    const s = createWaveState();
    const r = rec();
    stepWaves(s, 0.5, new Rng(3), r);
    expect(r.list.map((e) => e.kind)).toEqual([0, 1]);
    expect(s.burstNext).toBe(2);
  });

  it('先推时间再出力:第一帧就按 dt 之后的方向/强度算', () => {
    useScript(segment({ duration: 10, dirStartDeg: 0, dirEndDeg: 100, streams: [stream({ rate0: 0, rate1: 10 })] }));
    const s = createWaveState();
    stepWaves(s, 1, new Rng(1), rec());
    expect(s.segTime).toBeCloseTo(1, 9);
    expect(s.dirRad).toBeCloseTo(10 * DEG2RAD, 9); // 而不是段首的 0°
    expect(s.intensity).toBeCloseTo(1, 9);
  });
});

describe('出怪账(debt)', () => {
  it('小数速率靠账攒:0.5 只/秒攒够 1 才出,不四舍五入', () => {
    useScript(segment({ duration: 100, streams: [stream({ rate0: 0.5, rate1: 0.5 })] }));
    const s = createWaveState();
    const r = rec();
    run(s, 7, 0.25, new Rng(1), r); // 0.125/帧 × 7 = 0.875
    expect(r.list.length).toBe(0);
    expect(s.debt[0]).toBeCloseTo(0.875, 9);
    stepWaves(s, 0.25, new Rng(1), r);
    expect(r.list.length).toBe(1);
    expect(s.debt[0]).toBeCloseTo(0, 9);
  });

  it('长期速率对得上脚本:60Hz 下 2 只/秒跑 60 秒 ≈ 120 只', () => {
    useScript(segment({ duration: 1000, streams: [stream({ rate0: 2, rate1: 2 })] }));
    const s = createWaveState();
    const r = rec();
    run(s, 60 * SIM_HZ, SIM_DT, new Rng(1), r);
    expect(r.list.length).toBeGreaterThanOrEqual(119);
    expect(r.list.length).toBeLessThanOrEqual(120);
  });

  it('rate0 → rate1 的密度曲线:出怪只数 = 速率曲线下的面积,后半段真的比前半段密', () => {
    // 0 → 8 只/秒、跑 10 秒。这条钉的是"随时间的密度曲线"(GDD §6.3)真的落在了出怪只数上:
    // 只按段首速率出(或只按段尾)都会让全段总数错一倍以上,而那正是整局压力曲线的形状
    useScript(segment({ duration: 10, streams: [stream({ rate0: 0, rate1: 8 })] }));
    const s = createWaveState();
    const r = rec();
    run(s, 5 * SIM_HZ, SIM_DT, new Rng(9), r);
    const firstHalf = r.list.length;
    run(s, 5 * SIM_HZ, SIM_DT, new Rng(9), r);
    const total = r.list.length;
    expect(s.done).toBe(true);

    // 前半段 = 三角形的四分之一:∫₀⁵ 0.8t dt = 10 只(照段尾速率算的话这里会是 40 只)
    expect(firstHalf).toBe(10);
    // 全段 = 梯形面积 (0 + 8) / 2 × 10 = 40 只;少的那一只是段尾没还完的账(debt ≈ 0.93),
    // 它既不四舍五入也不在越界那一帧补出来 —— 越界帧一律不出怪
    expect(total).toBe(39);
    // 密度确实在涨:后半段 29 只 ≈ 前半段的三倍。把插值改成"整段用同一个速率"这条立刻红
    expect(total - firstHalf).toBeGreaterThan(firstHalf * 2.5);
  });

  it('多流各记各的账,按 streams 数组顺序出', () => {
    useScript(
      segment({
        duration: 100,
        streams: [
          stream({ kind: 2, rate0: 2, rate1: 2 }), // dt=0.5 → 每帧 1 只
          stream({ kind: 0, rate0: 4, rate1: 4 }), // dt=0.5 → 每帧 2 只
        ],
      }),
    );
    const s = createWaveState();
    const r = rec();
    stepWaves(s, 0.5, new Rng(11), r);
    expect(r.list.map((e) => e.kind)).toEqual([2, 0, 0]);
  });
});

describe('段推进', () => {
  it('带余数进位:一帧跨段时余数结转,总时长严格 = Σduration', () => {
    useScript(
      segment({ name: 'a', duration: 1 }),
      segment({ name: 'b', duration: 1 }),
    );
    const s = createWaveState();
    stepWaves(s, 1.5, new Rng(1), rec());
    expect(s.segment).toBe(1);
    expect(s.segTime).toBeCloseTo(0.5, 9); // 吞掉余数的话总时长会比脚本短
  });

  it('一帧跨两段也算得对(短脚本 / 大 dt)', () => {
    useScript(
      segment({ name: 'a', duration: 0.5 }),
      segment({ name: 'b', duration: 0.5 }),
      segment({ name: 'c', duration: 4 }),
    );
    const s = createWaveState();
    stepWaves(s, 1.25, new Rng(1), rec());
    expect(s.segment).toBe(2);
    expect(s.segTime).toBeCloseTo(0.25, 9);
  });

  it('总时长严格 = Σduration:60Hz 下 dt 除不尽段长,也不会每段各吞掉小半帧', () => {
    // 三段刻意都不是 SIM_DT 的整数倍(Σ = 1.33s)。每段各自把余数吞掉的话,一段最多多吞一帧,
    // 三段就要 19 + 29 + 33 = 81 帧才走完 —— 真脚本 4 段同理会比表上的 480s 长出小半秒,
    // "跑完 = 胜利"这条口径也就跟数据表对不上了
    useScript(
      segment({ name: 'a', duration: 0.31 }),
      segment({ name: 'b', duration: 0.47 }),
      segment({ name: 'c', duration: 0.55 }),
    );
    const total = WAVE_SEGMENTS.reduce((sum, seg) => sum + seg.duration, 0);
    const frames = Math.ceil(total / SIM_DT); // 80:带余数进位下走完脚本恰好要这么多帧
    const s = createWaveState();
    run(s, frames - 1, SIM_DT, new Rng(1), rec());
    expect(s.done).toBe(false); // 早一帧走完 = 最后一段被砍掉了一截
    stepWaves(s, SIM_DT, new Rng(1), rec());
    expect(s.done).toBe(true);
    expect(s.segment).toBe(WAVE_SEGMENTS.length);
  });

  it('跨段接力:接缝那一帧起就按**新段**插值,方向接着往同一边转、不在接缝上顿一下', () => {
    useScript(
      // 首尾相接(真脚本的这条口径由 data/waves.test.ts 钉住):接得上,两段连起来就是一条匀速的转动
      segment({ name: 'a', duration: 1, dirStartDeg: 0, dirEndDeg: 90 }),
      segment({ name: 'b', duration: 1, dirStartDeg: 90, dirEndDeg: 180 }),
    );
    const s = createWaveState();
    // 1s 除不尽 0.06 → 接缝落在第 17 帧的**帧中**(余 0.02s):接力接不上的话这一帧当场露馅
    const dt = 0.06;
    const turns: number[] = [];
    let prev = s.dirRad;
    for (let i = 0; i < 30; i++) {
      stepWaves(s, dt, new Rng(1), rec());
      turns.push(wrapAngle(s.dirRad - prev) / DEG2RAD);
      prev = s.dirRad;
    }
    expect(s.segment).toBe(1);
    // 每帧都恰好转过 5.4°(90°/s × 0.06s),接缝那一帧也不例外:
    // 换段时若把方向留在旧段、或从新段段首重新起步,这里会冒出一个 0° 的台阶(玩家看到的就是罗盘卡一下)
    for (const t of turns) expect(t).toBeCloseTo(5.4, 6);
    expect(s.dirRad).toBeCloseTo(waveDirAt(WAVE_SEGMENTS[1]!, s.segTime), 9);
  });

  it('接力棒交给的是**新段**:数据没接上时方向就在接缝上瞬移 —— 正是数据自检钉首尾相接的理由', () => {
    useScript(
      segment({ name: 'a', duration: 1, dirStartDeg: 0, dirEndDeg: 90 }),
      // 故意写成接不上的 200°(真脚本不许这么写):运行器只认新段,一点都不替数据打圆场
      segment({
        name: 'b',
        duration: 1,
        dirStartDeg: 200,
        dirEndDeg: 200,
        bursts: [burst({ at: 0, offsetDeg: 0, counts: [1, 0, 0, 0] })],
      }),
    );
    const s = createWaveState();
    const r = rec();
    run(s, 16, 0.06, new Rng(1), r);
    expect(s.segment).toBe(0);
    expect(s.dirRad / DEG2RAD).toBeCloseTo(86.4, 6);

    stepWaves(s, 0.06, new Rng(1), r); // 接缝那一帧
    expect(s.segment).toBe(1);
    expect(wrapAngle(s.dirRad - 200 * DEG2RAD)).toBeCloseTo(0, 9); // 旧段那 90° 一点都不留
    // 新段的侧压事件也按新方向出(offset 0 = 主压方向本身):
    // 事件的偏移永远相对"当时的"主压方向,而当时 = 换段之后
    expect(r.list.length).toBe(1);
    expect(wrapAngle(r.list[0]!.angle - s.dirRad)).toBeCloseTo(0, 9);
  });

  it('换段清账:debt 归零、侧压游标归零(新段的事件从头再来)', () => {
    useScript(
      segment({
        name: 'a',
        duration: 1,
        streams: [stream({ rate0: 0.5, rate1: 0.5 })],
        bursts: [burst({ at: 0, counts: [1, 0, 0, 0] })],
      }),
      segment({ name: 'b', duration: 5, streams: [stream({ rate0: 0, rate1: 0 })] }),
    );
    const s = createWaveState();
    const r = rec();
    stepWaves(s, 0.5, new Rng(5), r);
    expect(s.debt[0]).toBeCloseTo(0.25, 9);
    expect(s.burstNext).toBe(1);

    stepWaves(s, 0.75, new Rng(5), r); // 跨进 b 段
    expect(s.segment).toBe(1);
    expect(s.debt[0]).toBe(0); // 上一段没还完的账不带进新段
    expect(s.burstNext).toBe(0);
    expect(r.list.length).toBe(1); // b 段没有事件,故仍是 a 段那一只
  });

  it('新段的流比 debt 长就补齐(只在换段发生,热循环里不分配)', () => {
    const many = WAVE_MAX_STREAMS + 2;
    const streams: WaveStream[] = [];
    for (let i = 0; i < many; i++) streams.push(stream({ kind: i % 4, rate0: 2, rate1: 2 }));
    useScript(segment({ name: 'a', duration: 1 }), segment({ name: 'b', duration: 5, streams }));
    const s = createWaveState();
    const r = rec();
    stepWaves(s, 1, new Rng(2), rec()); // 跨进 b 段(越界的余数为 0)
    expect(s.segment).toBe(1);
    expect(s.debt.length).toBeGreaterThanOrEqual(many);
    stepWaves(s, 0.5, new Rng(2), r);
    // 补齐漏了的话,超出预分配长度的那几条流会读到 undefined → 账变 NaN → 永远不出怪
    expect(r.list.length).toBe(many);
  });

  it('脚本走完:done 置位、越界那一帧不出怪、之后不再碰 rng', () => {
    useScript(segment({ duration: 1, streams: [stream({ rate0: 100, rate1: 100 })] }));
    const s = createWaveState();
    const r = rec();
    stepWaves(s, 0.5, new Rng(1), r);
    const before = r.list.length;
    expect(before).toBeGreaterThan(0);

    const rng = new CountingRng(1);
    stepWaves(s, 0.75, rng, r); // 越界那一帧
    expect(s.done).toBe(true);
    expect(r.list.length).toBe(before); // 剩下的余数不属于任何一段,拿它插值就是读越界脚本
    expect(rng.calls).toBe(0);

    run(s, 100, 0.5, rng, r);
    expect(r.list.length).toBe(before);
    expect(rng.calls).toBe(0); // 胜利结算之后不能还在背景里涌怪
  });

  it('done 之后 dirRad 保留最后一帧的方向,不甩回 0', () => {
    useScript(segment({ duration: 1, dirStartDeg: 100, dirEndDeg: 100 }));
    const s = createWaveState();
    stepWaves(s, 0.5, new Rng(1), rec());
    stepWaves(s, 0.75, new Rng(1), rec());
    expect(s.done).toBe(true);
    expect(s.dirRad).toBeCloseTo(100 * DEG2RAD, 9);
  });
});

describe('出怪方向', () => {
  it('主压怪流生在**当帧的主压方向**上(罗盘指哪,怪就真的从哪来)', () => {
    useScript(
      segment({
        duration: 5,
        dirStartDeg: 350,
        dirEndDeg: 470, // 累积角:跨 0° 继续顺时针
        streams: [stream({ rate0: 4, rate1: 4, spreadDeg: 0 })],
      }),
    );
    const s = createWaveState();
    const r = rec();
    let prev = s.dirRad;
    for (let i = 0; i < 4; i++) {
      r.list.length = 0;
      stepWaves(s, 1, new Rng(1), r);
      const seg = WAVE_SEGMENTS[0]!;
      expect(s.dirRad).toBeCloseTo(waveDirAt(seg, s.segTime), 9);
      // 每帧都在往同一个方向转 = 玩家必须持续微调航向,而不是固定角度挂机(08 验收)
      expect(wrapAngle(s.dirRad - prev)).toBeGreaterThan(0);
      prev = s.dirRad;
      for (const e of r.list) expect(wrapAngle(e.angle - s.dirRad)).toBeCloseTo(0, 9);
    }
  });

  it('展宽 = 相对主压方向的半展宽,出生角落在 ±spread 内', () => {
    const spread = 25;
    useScript(
      segment({ duration: 100, dirStartDeg: 40, dirEndDeg: 40, streams: [stream({ rate0: 60, rate1: 60, spreadDeg: spread })] }),
    );
    const s = createWaveState();
    const r = rec();
    run(s, 20, 0.5, new Rng(17), r);
    expect(r.list.length).toBeGreaterThan(100);
    let min = Infinity;
    let max = -Infinity;
    for (const e of r.list) {
      const d = wrapAngle(e.angle - s.dirRad) / DEG2RAD;
      expect(Math.abs(d)).toBeLessThanOrEqual(spread + 1e-9);
      min = Math.min(min, d);
      max = Math.max(max, d);
    }
    // 真的铺满了这条弧,而不是缩在中间的一小撮
    expect(min).toBeLessThan(-spread * 0.8);
    expect(max).toBeGreaterThan(spread * 0.8);
  });

  it('侧压事件的偏移相对**当时的**主压方向:脚本转到哪,侧压跟到哪', () => {
    useScript(
      segment({
        duration: 10,
        dirStartDeg: 0,
        dirEndDeg: 90,
        bursts: [
          burst({ at: 2, offsetDeg: 90, counts: [1, 0, 0, 0] }),
          burst({ at: 8, offsetDeg: 90, counts: [1, 0, 0, 0] }),
        ],
      }),
    );
    const s = createWaveState();
    const r = rec();
    stepWaves(s, 2, new Rng(1), r); // t=2 → dir = 18°
    expect(wrapAngle(r.list[0]!.angle - (18 + 90) * DEG2RAD)).toBeCloseTo(0, 9);
    run(s, 3, 2, new Rng(1), r); // t=8 → dir = 72°,同一个 offsetDeg 已经指向别处了
    expect(r.list.length).toBe(2);
    // 相对船头就没意义了(玩家转舵不该改变虫潮从哪来),这里钉的是"绝对角 + 跟着脚本转"
    expect(wrapAngle(r.list[1]!.angle - (72 + 90) * DEG2RAD)).toBeCloseTo(0, 9);
  });

  it('展宽为 0 也照样掷一次随机:消耗次数与展宽无关,改平衡不移动随机序列', () => {
    const script = (spreadDeg: number): void =>
      useScript(
        segment({
          duration: 100,
          dirStartDeg: 45,
          dirEndDeg: 45,
          streams: [stream({ kind: 2, rate0: 4, rate1: 4, spreadDeg })],
          bursts: [burst({ at: 0, spreadDeg, counts: [0, 0, 0, 2] })],
        }),
      );

    script(0);
    const flat = rec();
    const rngA = new CountingRng(23);
    stepWaves(createWaveState(), 0.5, rngA, flat);
    expect(flat.list.length).toBe(4); // 事件 2 只 + 怪流 2 只
    expect(rngA.calls).toBe(4);
    for (const e of flat.list) expect(e.angle).toBeCloseTo(45 * DEG2RAD, 9);

    script(20);
    const wide = rec();
    const rngB = new CountingRng(23);
    stepWaves(createWaveState(), 0.5, rngB, wide);
    expect(wide.list.map((e) => e.kind)).toEqual(flat.list.map((e) => e.kind));
    expect(rngB.calls).toBe(rngA.calls);
  });
});

describe('环阵 burst(25 号:BURST_PATTERN_RING,整环均布合围)', () => {
  /** 同一份脚本:段长 10、方向恒 0、只有一条 at=0 的 burst —— 一帧触发,零流零精英,base = 0 */
  const ringScript = (counts: number[], spreadDeg = 2, pattern: number = BURST_PATTERN_RING): void =>
    useScript(
      segment({
        duration: 10,
        dirStartDeg: 0,
        dirEndDeg: 0,
        bursts: [burst({ at: 0, offsetDeg: 0, spreadDeg, pattern, counts })],
      }),
    );

  it('同帧整组出 N 只(N = counts 总和),逐型按下标升序、跨型连续编号,游标到点即消费', () => {
    ringScript([16, 4, 0, 0, 0]);
    const s = createWaveState();
    const r = rec();
    stepWaves(s, 0.1, new Rng(1), r);
    // 一帧之内 20 只全部落地:环阵与方向 burst 同一条原子事件口径,不被单帧上限截断
    expect(r.list).toHaveLength(20);
    expect(r.list.map((e) => e.kind)).toEqual([
      ...new Array<number>(16).fill(0),
      ...new Array<number>(4).fill(1),
    ]);
    expect(s.burstNext).toBe(1);
  });

  it('均布:spreadDeg 0 时出生角逐只钉在 base + i/N × 360° 上(抖动为 0 = 纯几何,且仍每只一掷)', () => {
    const N = 16;
    ringScript([16, 0, 0, 0, 0], 0);
    const s = createWaveState();
    const r = rec();
    const rng = new CountingRng(3);
    stepWaves(s, 0.1, rng, r);
    r.list.forEach((e, i) => {
      expect(e.kind).toBe(0);
      // i = 出生次序(跨型连续下标),均布角 = i/N × 360°;展宽 0 时抖动恒 0,角度是纯几何
      expect(e.angle / DEG2RAD).toBeCloseTo((360 / N) * i, 9);
    });
    expect(rng.calls).toBe(N); // 展宽为 0 也照样每只掷一次:消耗次数与展宽无关(既有口径)
  });

  it('环回:整环是闭合的 —— 按出生角排序后首尾相邻间隔也 = 360°/N(允许抖动误差 ±2×spreadDeg)', () => {
    const N = 16;
    const spread = 2;
    const stepDeg = 360 / N;
    for (let seed = 1; seed <= 4; seed++) {
      ringScript([16, 0, 0, 0, 0], spread);
      const s = createWaveState();
      const r = rec();
      stepWaves(s, 0.1, new Rng(seed), r);
      expect(r.list).toHaveLength(N);
      // 相邻间隔 = 槽宽 + (后一只抖动 − 前一只抖动) ∈ [360/N − 2×spread, 360/N + 2×spread];
      // 首尾那一条跨 2π 收口,同样要闭合 —— 收口断了就是环上豁了一个口子
      const sorted = r.list.map((e) => wrapAngle(e.angle)).sort((a, b) => a - b);
      for (let i = 0; i < N; i++) {
        const a = sorted[i]!;
        const b = sorted[(i + 1) % N]!;
        const gap = (i === N - 1 ? b + Math.PI * 2 - a : b - a) / DEG2RAD;
        expect(gap).toBeGreaterThanOrEqual(stepDeg - 2 * spread - 1e-9);
        expect(gap).toBeLessThanOrEqual(stepDeg + 2 * spread + 1e-9);
      }
    }
  });

  it('抖动半宽上限:每只只在自己的均布角 ±spreadDeg 内抖,跨种子不越界,且真的在抖', () => {
    const N = 16;
    const spread = 2;
    const step = (Math.PI * 2) / N;
    let deviated = false;
    for (let seed = 1; seed <= 20; seed++) {
      ringScript([16, 0, 0, 0, 0], spread);
      const s = createWaveState();
      const r = rec();
      stepWaves(s, 0.1, new Rng(seed), r);
      r.list.forEach((e, i) => {
        const dev = wrapAngle(e.angle - step * i) / DEG2RAD;
        expect(Math.abs(dev)).toBeLessThanOrEqual(spread + 1e-9);
        if (Math.abs(dev) > 1) deviated = true;
      });
    }
    // 抖动是真的在抖:20 个种子 × 16 只里必有离开均布槽超过 1° 的 ——
    // 全钉在槽上说明抖动被静默抹掉了(环还是环,但"每只一掷"的账就错了)
    expect(deviated).toBe(true);
  });

  it('原子口径:环阵不被单帧上限截断(N > WAVE_MAX_SPAWN_PER_TICK 也一帧出完)', () => {
    const n = WAVE_MAX_SPAWN_PER_TICK + 5;
    ringScript([n, 0, 0, 0, 0]);
    const s = createWaveState();
    const r = rec();
    stepWaves(s, 0.1, new Rng(1), r);
    expect(r.list).toHaveLength(n);
    expect(r.list.every((e) => e.kind === 0)).toBe(true);
  });

  it('rng 合同:环阵每只恰好 1 次抖动掷,与方向 burst 同 counts 同 seed 双跑消耗逐字相同', () => {
    const counts = [16, 4, 0, 0, 0];

    ringScript(counts, 2);
    const ringS = createWaveState();
    const ringRec = rec();
    const ringRng = new CountingRng(20260825);
    stepWaves(ringS, 0.1, ringRng, ringRec);
    expect(ringRec.list).toHaveLength(20);
    expect(ringRng.calls).toBe(20); // 每只恰好 1 次,不多不少(README 口径点名要的专项钉)

    ringScript(counts, 2, BURST_PATTERN_DIRECTIONAL);
    const dirRec = rec();
    const dirRng = new CountingRng(20260825);
    stepWaves(createWaveState(), 0.1, dirRng, dirRec);
    expect(dirRec.list).toHaveLength(20);
    expect(dirRng.calls).toBe(20);

    // "逐字相同"的最强形式:同 seed 各跑一遍,两条 rng 流站回同一格,下一掷数值相同 ——
    // ring 分支多掷/少掷任何一次都会在这里当场露馅(与 boss.test.ts 的"补给后同格"同款)
    expect(ringRng.next()).toBe(dirRng.next());
  });
});

describe('确定性(08 验收:同 seed 两局出怪序列一致)', () => {
  const SCRIPT = (): void =>
    useScript(
      segment({
        name: 'a',
        duration: 2,
        dirStartDeg: 0,
        dirEndDeg: 60,
        streams: [
          stream({ kind: 0, rate0: 6, rate1: 12, spreadDeg: 30 }),
          stream({ kind: 1, rate0: 1, rate1: 2, spreadDeg: 10 }),
        ],
        bursts: [burst({ at: 0.5, offsetDeg: -90, spreadDeg: 8, counts: [2, 0, 1, 1] })],
      }),
      segment({
        name: 'b',
        duration: 2,
        dirStartDeg: 60,
        dirEndDeg: 200,
        streams: [stream({ kind: 3, rate0: 4, rate1: 4, spreadDeg: 20 })],
        bursts: [burst({ at: 1, offsetDeg: 180, spreadDeg: 12, counts: [0, 3, 0, 0] })],
      }),
    );

  // 多跑一秒:60Hz 下 dt 除不尽脚本时长,跑满 Σduration 帧未必刚好走完最后一段
  const play = (seed: number): { kind: number; angle: number }[] => {
    SCRIPT();
    const s = createWaveState();
    const r = rec();
    run(s, 5 * SIM_HZ, SIM_DT, new Rng(seed), r);
    expect(s.done).toBe(true);
    return r.list;
  };

  it('同 seed 两局:型号与出生角逐只一字不差', () => {
    const a = play(20260802);
    const b = play(20260802);
    expect(a.length).toBeGreaterThan(30);
    expect(b).toEqual(a);
  });

  it('换 seed 才换序列(否则"同 seed 一致"是因为根本没随机)', () => {
    const a = play(1);
    const b = play(2);
    expect(b.map((e) => e.angle)).not.toEqual(a.map((e) => e.angle));
  });

  it('每成功出一只 = 恰好一次 rng.next(),型号与展宽都不改变消耗次数', () => {
    SCRIPT();
    const s = createWaveState();
    const r = rec();
    const rng = new CountingRng(4242);
    run(s, 5 * SIM_HZ, SIM_DT, rng, r);
    expect(rng.calls).toBe(r.list.length);
  });

  it('**真脚本**跑得完整局,且同 seed 两局逐只一致(08 验收标准第二条)', () => {
    // 唯一一条直接跑 data/waves.ts 那份 480s 真脚本的用例:只断言"跑得完 + 可复现",
    // 一个具体数字都不断言(真脚本在 M0 会反复调,那些数字归 data/waves.test.ts 管)。
    // 28800 帧看着吓人,但这里没有世界、没有池,纯粹是脚本插值 + 一次随机
    const frames = Math.ceil(WAVE_TOTAL_TIME / SIM_DT) + SIM_HZ;
    const playReal = (seed: number): Rec['list'] => {
      const s = createWaveState();
      const r = rec();
      run(s, frames, SIM_DT, new Rng(seed), r);
      expect(s.done).toBe(true); // 脚本走完 = 胜利条件,走不完这一局就永远赢不了
      expect(s.segment).toBe(WAVE_SEGMENTS.length);
      return r.list;
    };
    const a = playReal(20260802);
    expect(a.length).toBeGreaterThan(100);
    expect(playReal(20260802)).toEqual(a);
  });
});

describe('精英插入(14 号:实装 todos/08 预留的 WaveElite 接口)', () => {
  const ELITE = { at: 0.2, kind: 3, count: 2, affixes: [0, 3] };
  /** 同一份脚本,elites 二选一:无精英 vs 一只 at=0.2 的 2×3 号精英 */
  const script = (withElite: boolean): void =>
    useScript(
      segment({
        name: 'a',
        duration: 2,
        dirStartDeg: 0,
        dirEndDeg: 60,
        streams: [stream({ kind: 0, rate0: 10, rate1: 10, spreadDeg: 10 })], // dt=0.1 → 每帧整 1 只
        bursts: [burst({ at: 0.1, offsetDeg: 90, spreadDeg: 5, counts: [1, 0, 0, 0] })],
        elites: withElite ? [ELITE] : [],
      }),
    );

  it('填了就出精英:按 at 触发、kind/count 出怪、affixes 透传、游标不重复、不扰动触发帧内的普通怪', () => {
    script(false);
    const plain = rec();
    const plainRng = new CountingRng(8);
    const ps = createWaveState();
    run(ps, 2, 0.1, plainRng, plain);

    script(true);
    const r = rec();
    const rng = new CountingRng(8);
    const rs = createWaveState();
    run(rs, 2, 0.1, rng, r);
    // 精英排在帧末出:到点那一帧(segTime 0.2)里,普通怪(事件 + 流)与无精英脚本逐只一字不差(含出生角)
    expect(r.list.slice(0, plain.list.length)).toEqual(plain.list);
    expect(r.list.length).toBe(plain.list.length + 2);
    // 精英按 at 触发:kind/count 由脚本给死,出生角 = 当时的主压方向
    // (dirStart 0 → dirEnd 60, duration 2,@0.2s 线性插值 = 6°)
    const elites = r.list.slice(plain.list.length);
    for (const e of elites) {
      expect(e.kind).toBe(3);
      expect(e.affixes).toEqual([0, 3]);
      expect(e.angle).toBeCloseTo(6 * DEG2RAD, 9);
    }
    // 每成功出一只 = 恰好一次 rng.next():精英不额外掷型号/词缀/数量,与 bursts 同一口径
    expect(rng.calls).toBe(r.list.length);
    // 游标到点即消费、不重复触发:触发帧后 eliteNext 已经越过这一只
    expect(rs.eliteNext).toBe(1);

    // 不扰动普通怪的型号序列:把两局跑完剩余帧对比。
    // useScript 是全局替换,续跑哪一局就先装回哪份脚本(stepWaves 每帧现读 WAVE_SEGMENTS)
    script(false);
    run(ps, 18, 0.1, plainRng, plain);
    script(true);
    run(rs, 18, 0.1, rng, r);
    expect(r.list.filter((x) => x.affixes !== undefined)).toHaveLength(2); // 到点过一次就不再复发
    // 型号是脚本直给、与 rng 无关:普通怪的型号序列与无精英脚本完全一致
    const ordinaryKinds = r.list.filter((x) => x.affixes === undefined).map((x) => x.kind);
    expect(ordinaryKinds).toEqual(plain.list.map((x) => x.kind));
    expect(rs.done).toBe(true);
    expect(rng.calls).toBe(r.list.length); // 全程每出一只恰好一次
  });

  it('同 seed 两局:精英出现时刻与种类逐位可复现;且与种子无关(纯由 at 与脚本决定)', () => {
    const play = (seed: number): Rec => {
      script(true);
      const r = rec();
      run(createWaveState(), 5 * SIM_HZ, SIM_DT, new Rng(seed), r);
      return r;
    };
    const a = play(20260814);
    const b = play(20260814);
    const c = play(20260815);
    // 同 seed:整条列表(含普通怪的出生角)逐只一字不差
    expect(b.list).toEqual(a.list);
    // 精英的出现时刻(列表位置)与种类由 at 与脚本决定、与种子无关:
    // 普通怪的角变了,精英的 kind/affixes/angle(= 主压方向)却一字不差
    const eliteAt = (list: Rec['list']): number[] =>
      list.map((x, i) => (x.affixes !== undefined ? i : -1)).filter((i) => i >= 0);
    expect(eliteAt(a.list)).toEqual(eliteAt(c.list));
    expect(a.list.filter((x) => x.affixes !== undefined)).toEqual(
      c.list.filter((x) => x.affixes !== undefined),
    );
    expect(a.list.filter((x) => x.affixes !== undefined)).toHaveLength(2);
    expect(a.list.filter((x) => x.affixes !== undefined).map((x) => x.kind)).toEqual([3, 3]);
  });
});

describe('解锁精英事件(19 号:WAVE_LOCKED_ELITES 按解锁掩码门控)', () => {
  /** 测试槽位:收尾段(第 3 段)的"虫群母巢"占位 —— 与真表同构,但挂在第 0 段好测 */
  const LOCKED = { unlockId: 'elite-queen', segmentIndex: 0, at: 0.2, kind: 3, count: 1, affixes: [0, 3, 4] };
  /** 掩码位 = 该解锁条目在 UNLOCKS 里的下标(与运行器同一条约定,见 waves.ts 的 unlockBit) */
  const queenBit = UNLOCKS.findIndex((u) => u.id === LOCKED.unlockId);
  expect(queenBit).toBeGreaterThanOrEqual(0);
  const QUEEN_MASK = 1 << queenBit;

  /** 同一份脚本:一条普通流 + 一只段表精英(at 0.5) + 槽位表里的一只锁定精英(at 0.2) */
  const script = (): void =>
    useScript(
      segment({
        name: 'a',
        duration: 10,
        dirStartDeg: 0,
        dirEndDeg: 60,
        streams: [stream({ kind: 0, rate0: 10, rate1: 10, spreadDeg: 10 })], // dt=0.1 → 每帧整 1 只
        elites: [{ at: 0.5, kind: 1, count: 1, affixes: [0] }],
      }),
    );

  it('未解锁(掩码 0):锁定精英整条跳过 —— 精英链只有段表那一条,连 at 时刻都轮不到它', () => {
    script();
    WAVE_LOCKED_ELITES.splice(0, WAVE_LOCKED_ELITES.length, LOCKED);
    const s = createWaveState(0); // 全部未解锁
    expect(s.elites.map((e) => e.at)).toEqual([0.5]); // 归并时就被挡在链外
    const r = rec();
    run(s, 30, 0.1, new Rng(8), r); // 3 秒:锁定的 at=0.2 早就到点
    expect(r.list.filter((x) => x.affixes !== undefined).map((x) => x.affixes)).toEqual([[0]]);
    expect(r.list.filter((x) => x.affixes !== undefined)).toHaveLength(1); // 只有段表那只
    expect(s.eliteNext).toBe(1); // 段表那只到点即消费,锁定那只没占过游标
  });

  it('解锁后按 at 归并触发:锁定精英照脚本出、游标到点即消费,且不重复触发', () => {
    script();
    WAVE_LOCKED_ELITES.splice(0, WAVE_LOCKED_ELITES.length, LOCKED);
    const s = createWaveState(QUEEN_MASK);
    // 归并链 = 锁定(0.2) + 段表(0.5),按 at 升序 —— 解锁只是"放进链",顺序由 at 定
    expect(s.elites.map((e) => e.at)).toEqual([0.2, 0.5]);
    const r = rec();
    run(s, 30, 0.1, new Rng(8), r);
    const elites = r.list.filter((x) => x.affixes !== undefined);
    expect(elites).toHaveLength(2);
    // 锁定精英:kind/count/affixes 原样透传,出生角 = 当时的主压方向
    // (dirStart 0 → dirEnd 60, duration 10,@0.2s 线性插值 = 1.2°)
    const queen = elites[0]!;
    expect(queen.kind).toBe(3);
    expect(queen.affixes).toEqual([0, 3, 4]);
    expect(queen.angle).toBeCloseTo(1.2 * DEG2RAD, 9);
    expect(s.eliteNext).toBe(2); // 两条都到点即消费
    // 到点过一次就不再复发:继续跑也不再多出精英
    run(s, 60, 0.1, new Rng(8), r);
    expect(r.list.filter((x) => x.affixes !== undefined)).toHaveLength(2);
  });

  it('未解锁 = 槽位不存在:掩码 0 与空槽位表同 seed 逐只一字不差(含出生角)', () => {
    // 19 号验收"解锁状态不影响同 seed rng 序列"的最强形式:未解锁的槽位表现得
    // 就像它从没被加进表里 —— 同 seed 两局的普通怪序列(型号 + 出生角)逐只一致,
    // rng 消耗次数也一字不差
    script();
    WAVE_LOCKED_ELITES.splice(0, WAVE_LOCKED_ELITES.length, LOCKED);
    const lockedRun = rec();
    const lockedRng = new CountingRng(20260819);
    run(createWaveState(0), 5 * SIM_HZ, SIM_DT, lockedRng, lockedRun);

    WAVE_LOCKED_ELITES.splice(0, WAVE_LOCKED_ELITES.length); // 槽位表清空 = 19 号落地前的世界
    const emptyRun = rec();
    const emptyRng = new CountingRng(20260819);
    run(createWaveState(0), 5 * SIM_HZ, SIM_DT, emptyRng, emptyRun);

    expect(lockedRun.list).toEqual(emptyRun.list);
    expect(lockedRng.calls).toBe(emptyRng.calls);
  });

  it('解锁后触发:多出那一组正是锁定精英;普通怪型号序列与未解锁局逐位一致(型号与 rng 无关)', () => {
    // 精英排在帧末、型号脚本直给:解锁让触发帧之后的普通怪出生角顺延(与既有精英同一条
    // 既有口径,14 号用例同款断言),但**型号序列**逐位一致 —— 解锁与否只决定"这组怪出不出"
    script();
    WAVE_LOCKED_ELITES.splice(0, WAVE_LOCKED_ELITES.length, LOCKED);
    const lockedRun = rec();
    run(createWaveState(0), 5 * SIM_HZ, SIM_DT, new Rng(20260819), lockedRun);

    const openRun = rec();
    const openRng = new CountingRng(20260819);
    run(createWaveState(QUEEN_MASK), 5 * SIM_HZ, SIM_DT, openRng, openRun);

    expect(openRun.list.length).toBe(lockedRun.list.length + 1); // 多出恰好一组
    const ordinaryKinds = (list: Rec['list']): number[] =>
      list.filter((x) => x.affixes === undefined).map((x) => x.kind);
    expect(ordinaryKinds(openRun.list)).toEqual(ordinaryKinds(lockedRun.list));
    // rng 消耗口径不变:每出一只恰好一次,多出的那只是精英的"每只一次"
    expect(openRng.calls).toBe(openRun.list.length);
  });

  it('掩码只认自己的位:别的解锁位开着、本槽位未开 = 照样跳过(闸门按条目独立)', () => {
    script();
    WAVE_LOCKED_ELITES.splice(0, WAVE_LOCKED_ELITES.length, LOCKED);
    // 全开但**不包含** queen 的掩码:除 queen 位外全 1
    const otherBits = (1 << UNLOCKS.length) - 1 - QUEEN_MASK;
    const s = createWaveState(otherBits);
    expect(s.elites.map((e) => e.at)).toEqual([0.5]); // queen 位未开 → 仍被挡在链外
    const r = rec();
    run(s, 30, 0.1, new Rng(8), r);
    expect(r.list.filter((x) => x.affixes !== undefined)).toHaveLength(1);
  });

  it('unlockId 查不到 = 数据写坏,按未解锁跳过(不抛、不出、不扰动)', () => {
    script();
    WAVE_LOCKED_ELITES.splice(0, WAVE_LOCKED_ELITES.length, { ...LOCKED, unlockId: 'no-such-entry' });
    const s = createWaveState((1 << UNLOCKS.length) - 1); // 全开
    const r = rec();
    run(s, 30, 0.1, new Rng(8), r);
    expect(r.list.filter((x) => x.affixes !== undefined)).toHaveLength(1); // 只有段表那只
  });
});

describe('单帧出怪上限(数据写坏时不卡死一帧)', () => {
  it('主压怪流撞上限就停,余账留到下一帧', () => {
    useScript(
      segment({
        duration: 100,
        streams: [
          stream({ kind: 0, rate0: 1e6, rate1: 1e6 }),
          stream({ kind: 1, rate0: 60, rate1: 60 }),
        ],
      }),
    );
    const s = createWaveState();
    const r = rec();
    stepWaves(s, 0.5, new Rng(1), r);
    expect(r.list.length).toBe(WAVE_MAX_SPAWN_PER_TICK);
    expect(s.debt[0]).toBeGreaterThan(0); // 账留着,下一帧接着还
    // 上限是保险丝不是配额分配器:撞上限那一帧,后面的流连账都不记
    expect(s.debt[1]).toBe(0);
    expect(r.list.every((e) => e.kind === 0)).toBe(true);

    stepWaves(s, 0.5, new Rng(1), r);
    expect(r.list.length).toBe(WAVE_MAX_SPAWN_PER_TICK * 2);
  });

  it('侧压事件是原子的:不被上限截断(它没有账可留,截断只能凭空吞怪)', () => {
    const n = WAVE_MAX_SPAWN_PER_TICK + 5;
    useScript(
      segment({
        duration: 100,
        streams: [stream({ kind: 1, rate0: 1e6, rate1: 1e6 })],
        bursts: [burst({ at: 0, counts: [n, 0, 0, 0] })],
      }),
    );
    const s = createWaveState();
    const r = rec();
    stepWaves(s, 0.5, new Rng(1), r);
    expect(r.list.length).toBe(n);
    expect(r.list.every((e) => e.kind === 0)).toBe(true); // 已超上限,怪流这一帧一只都不出
  });
});

describe('孢子炮手(KIND_SPORE,22 号)', () => {
  it('运行器对第 5 型一视同仁:侧压事件按 counts 下标升序出,孢子在队列末尾', () => {
    useScript(
      segment({
        duration: 10,
        streams: [],
        bursts: [burst({ at: 0, counts: [1, 2, 0, 0, 3] })], // 孢子 = 下标 4
      }),
    );
    const s = createWaveState();
    const r = rec();
    stepWaves(s, SIM_DT, new Rng(1), r);
    expect(r.list.map((e) => e.kind)).toEqual([0, 1, 1, 4, 4, 4]); // 逐型升序,孢子最后
  });

  it('孢子流走主压流通道:debt 小数账照常攒、速率/方向与既有流同一条插值口径', () => {
    useScript(
      segment({
        duration: 10,
        streams: [stream({ kind: 4, rate0: 2, rate1: 2, spreadDeg: 10 })],
      }),
    );
    const s = createWaveState();
    const r = rec();
    stepWaves(s, 0.5, new Rng(1), r); // dt = 0.5 → 每帧整 1 只
    expect(r.list).toHaveLength(1);
    expect(r.list[0]!.kind).toBe(4);
    expect(Math.abs(r.list[0]!.angle - s.dirRad)).toBeLessThanOrEqual(10 * DEG2RAD);
  });

  it('每出一只孢子恰好消耗一次 rng(与型号无关):同 seed 序列不因第 5 型而移位', () => {
    useScript(
      segment({
        duration: 10,
        streams: [stream({ kind: 0, rate0: 4, rate1: 4 }), stream({ kind: 4, rate0: 4, rate1: 4 })],
      }),
    );
    const s = createWaveState();
    const r = rec();
    const rng = new CountingRng(7);
    stepWaves(s, 0.5, rng, r); // dt = 0.5 → 两条流各出 2 只
    expect(r.list).toHaveLength(4);
    expect(r.list.map((e) => e.kind)).toEqual([0, 0, 4, 4]); // 按 streams 数组顺序出
    expect(rng.calls).toBe(4); // 每只恰一次,孢子不多不少
  });
});
