/**
 * 波次运行器(08 号 issue T2)—— 纯逻辑,「脚本 → 出怪事件」的唯一翻译层。
 * 铁律:本目录永不 import pixi/DOM;随机只走调用方递进来的 Rng(sim 内禁 Math.random)。
 *
 * 它只回答"这一帧该朝哪个方向出几只什么怪",一个字都不认识世界:出生点坐标、在场上限、
 * 对象池与 initEnemy 全在实现 SpawnSink 的那一侧(World)。拆开换来的是整套波次脚本
 * 能脱开 World 单测(喂个假 sink 就能把 550 秒跑完),而 World 那边只剩一句
 * "把角度换成船外环上的一点"。
 *
 * 口径两条,别处不许另立:
 *   1. 数据表写**度**、sim 内一律**弧度**(用 ship.ts 的 DEG2RAD 换算;data/ 永不 import sim/,
 *      那是上下游关系,引回去就成环);
 *   2. 主压方向是**世界系绝对角**(0 = +X,顺时针为正,与 ship.heading 同一套),
 *      不是相对船头的角 —— 相对船头的话玩家转舵就没意义了(GDD §6.3「最优舷持续漂移」)。
 *
 * rng 消耗顺序是本模块最要紧的契约(08 验收:同 seed 两局出怪序列一致):
 * 每成功出一只 = 恰好一次 rng.next()(出生角的抖动),**与展宽是否为 0 无关**;
 * 型号由脚本直接给、不掷随机。于是调一次平衡(改速率、改占比、改展宽)都不会移动整条随机序列。
 *
 * data/waves.ts 里的 WaveElite 本文件**一行都不读**:精英只预留接口(类型 + 字段),
 * 不留一条"读了但什么也不做"的死代码路径(08 任务:MVP 不实装精英)。
 */
import type { Rng } from '../core/rng';
import {
  WAVE_MAX_SPAWN_PER_TICK,
  WAVE_MAX_STREAMS,
  WAVE_SEGMENTS,
  type WaveSegment,
  type WaveStream,
} from '../data/waves';
import { DEG2RAD, wrapAngle } from './ship';

/**
 * 出怪的去处(与 sim/fx.ts 的 FireSink 同一条口径):运行器只说"朝这个方向出一只这型的怪",
 * 出生半径、在场上限、池与 initEnemy 全归实现方。
 * 实现方在回调里当场用掉 kind/angle 即可,本模块不跨帧持有任何东西。
 */
export interface SpawnSink {
  /** @param angleRad 世界系**绝对**角(0 = +X,顺时针为正);出生点 = 船心 + 该方向上的出怪半径 */
  spawn(kind: number, angleRad: number): void;
}

/**
 * 一局波次脚本的运行期状态。**只有前四个字段是真状态**(进 World.checksum),
 * 后三个是 segment + segTime + 脚本的纯函数,随时可重算 —— 与 ship.maxHp / World.shipDead
 * 同一条派生量口径:哈它只是把同一件事哈两遍。
 */
export interface WaveState {
  /** 当前航段下标;== WAVE_SEGMENTS.length 表示脚本走完 */
  segment: number;
  /** 段内已过秒数,恒 < 当前段 duration(段推进带余数进位) */
  segTime: number;
  /** 本段下一个待触发的 burst 下标(bursts 按 at 升序,故一个游标就够) */
  burstNext: number;
  /**
   * 逐流累积的出怪账(下标 = 当前段 streams 的下标)。
   * 0.7 只/秒这种小数速率全靠它攒:每帧四舍五入的话,速率低于 60 只/秒的流会被抹成 0 或炸成满帧。
   */
  debt: number[];
  /** 当前主压方向(弧度,折回 (-π, π]);11 号的威胁罗盘读它。**派生量** */
  dirRad: number;
  /** 当前主压强度 = 本段各 stream 当前速率之和(只/秒);HUD 用来显示"压力有多大"。**派生量** */
  intensity: number;
  /** segment >= WAVE_SEGMENTS.length 的**派生量**;World 据此判胜利 */
  done: boolean;
}

/**
 * 段内进度 [0, 1]。要夹一次是因为 waveDirAt / waveIntensityAt 是**公开**函数
 * (HUD 与单测会拿任意 segTime 问它们),而"segTime < duration"只在 runner 内部成立。
 * duration <= 0 的坏数据回落成 0:与其吐 Infinity/NaN 让罗盘乱转,不如钉在段首角上。
 */
function segProgress(seg: WaveSegment, segTime: number): number {
  if (!(seg.duration > 0)) return 0;
  const p = segTime / seg.duration;
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

/** 某条流的当前速率(只/秒):段首 rate0 → 段尾 rate1 线性插值,这就是「随时间的密度曲线」 */
function rateAt(st: WaveStream, prog: number): number {
  return st.rate0 + (st.rate1 - st.rate0) * prog;
}

/**
 * 主压方向(弧度)。**先按累积角线性插值、最后才 wrapAngle** —— 数据表里写的是不折回的
 * 累积角(如 320° → 480°),折回成 -240°→120° 再插值会让主压方向倒着转一圈,
 * "最优舷持续漂移"当场变成"最优舷来回抽搐"。
 */
export function waveDirAt(seg: WaveSegment, segTime: number): number {
  const deg = seg.dirStartDeg + (seg.dirEndDeg - seg.dirStartDeg) * segProgress(seg, segTime);
  return wrapAngle(deg * DEG2RAD);
}

/** 主压强度(只/秒)= 本段各流当前速率之和。侧压事件不进来:它是脉冲,不是速率 */
export function waveIntensityAt(seg: WaveSegment, segTime: number): number {
  const prog = segProgress(seg, segTime);
  let sum = 0;
  for (const st of seg.streams) sum += rateAt(st, prog);
  return sum;
}

/**
 * 进入某一段时的复位:出怪账清零、侧压游标归零,并按新段的流数补齐 debt。
 * 补齐是运行期唯一可能的分配,且只发生在**换段那一帧**;热循环里一个字都不 push(铁律 3)。
 */
function enterSegment(s: WaveState): void {
  for (let i = 0; i < s.debt.length; i++) s.debt[i] = 0;
  s.burstNext = 0;
  const seg = WAVE_SEGMENTS[s.segment];
  if (seg === undefined) return;
  // 正常脚本下 WAVE_MAX_STREAMS 已经预留够了,这里兜的是单测 splice 进来的长脚本
  while (s.debt.length < seg.streams.length) s.debt.push(0);
}

/** 把两个派生量同步到当前 segment + segTime */
function refreshDerived(s: WaveState): void {
  const seg = WAVE_SEGMENTS[s.segment];
  // 脚本走完就保留最后一帧的方向:罗盘不该在结算界面弹出的同时突然甩回 0
  if (seg === undefined) return;
  s.dirRad = waveDirAt(seg, s.segTime);
  s.intensity = waveIntensityAt(seg, s.segTime);
}

/**
 * 建一局的波次状态。**立刻按第 0 段 t = 0 算好 dirRad / intensity** ——
 * 开局第一帧 HUD 就该拿到真的主压方向,而不是先指着 0 弧度再在下一帧跳过去。
 */
export function createWaveState(): WaveState {
  const s: WaveState = {
    segment: 0,
    segTime: 0,
    burstNext: 0,
    // 预分配到全脚本的最大流数:正常换段时一个字节都不必再分配(铁律 3)
    debt: new Array<number>(WAVE_MAX_STREAMS).fill(0),
    dirRad: 0,
    intensity: 0,
    done: WAVE_SEGMENTS.length === 0,
  };
  enterSegment(s);
  refreshDerived(s);
  return s;
}

/**
 * 复位到开局(逐字段重置,与池的 reset 同口径:漏一个字段就把上一局的账带进新一局)。
 * 正式重开走的是"换整个 World"(池/rng/tick/甲板全新才谈得上同 seed 可复现),
 * 本函数只服务于单测与将来可能的原地重跑,故不复用 debt 之外的任何东西。
 */
export function resetWaveState(s: WaveState): void {
  s.segment = 0;
  s.segTime = 0;
  s.dirRad = 0;
  s.intensity = 0;
  s.done = WAVE_SEGMENTS.length === 0;
  enterSegment(s); // burstNext 与 debt 都在里面
  refreshDerived(s);
}

/**
 * 推进波次一逻辑帧。**每一步的顺序都定死**(整条 rng 序列依赖它,单测按此钉):
 *   1 走完直接闭嘴 → 2 推时间 → 3 段推进(带余数进位)→ 4 重算方向/强度 →
 *   5 侧压事件 → 6 主压怪流。
 * 调换 5 与 6 或者把 2 挪到 4 之后,出怪序列会整条错位 —— 同 seed 复现当场作废。
 *
 * @param dt 逻辑帧步长(秒),固定时步下恒为 SIM_DT;做成参数是为了单测能一口气跑完一段
 */
export function stepWaves(s: WaveState, dt: number, rng: Rng, sink: SpawnSink): void {
  // 1. 脚本走完就彻底闭嘴。World 在胜利之后照常 step(既有那条"船沉后世界照常往下跑"的
  //    用例仍然成立),不在这里 return 的话结算界面背后还会继续涌怪
  if (s.done) return;

  // 2. 先推时间再按新状态出力(与 sim/enemy.ts 的状态机同口径:到期那一帧当场按新状态算)
  s.segTime += dt;

  // 3. 段推进:**带余数进位**,于是整套脚本的总时长严格 = Σduration,
  //    不会因为 dt 除不尽 duration 而每段各吞掉小半帧。
  //    用 while 而不是 if:单测里 splice 进来的短脚本一帧跨两段也得算对。
  while (s.segment < WAVE_SEGMENTS.length) {
    const cur = WAVE_SEGMENTS[s.segment]!;
    if (cur.duration > 0 && s.segTime < cur.duration) break;
    // duration <= 0 的坏数据:整段跳过但**不动 segTime** —— `-= 0` 会把这个 while 卡死一帧
    if (cur.duration > 0) s.segTime -= cur.duration;
    s.segment++;
    enterSegment(s);
  }
  if (s.segment >= WAVE_SEGMENTS.length) {
    // 越界那一帧不出怪:剩下的余数不属于任何一段,拿它去插值就是在读越界的脚本
    s.done = true;
    return;
  }
  const seg = WAVE_SEGMENTS[s.segment]!;

  // 4. 主压方向与强度:11 号的威胁罗盘每帧读它们(经 World 的两个 getter),
  //    本帧的出怪也全部以这个 dirRad 为基准 —— 罗盘指哪,怪就真的从哪来
  s.dirRad = waveDirAt(seg, s.segTime);
  s.intensity = waveIntensityAt(seg, s.segTime);

  // 本帧已出怪数。上限只是"数据写坏时别卡死一帧"的保险丝,正常脚本永远碰不到它
  let spawned = 0;

  // 5. 侧压事件。bursts 按 at 升序,故游标一路向前:碰到第一个没到点的就可以收工
  const bursts = seg.bursts;
  while (s.burstNext < bursts.length) {
    const b = bursts[s.burstNext]!;
    if (b.at > s.segTime) break;
    s.burstNext++;
    // 偏移相对**当时的**主压方向:脚本转到哪,侧压就跟着转到哪(±90 恒为舷侧,180 恒为背后)
    const base = s.dirRad + b.offsetDeg * DEG2RAD;
    const spread = b.spreadDeg * DEG2RAD;
    const counts = b.counts;
    // 逐型按下标 0..N 升序出,顺序定死:改某一型的只数只会在序列末尾增减,不会整条错位
    for (let k = 0; k < counts.length; k++) {
      const n = counts[k]!;
      for (let j = 0; j < n; j++) {
        // 计进 spawned,但**不被本帧上限截断**:事件是原子的,它没有 debt 可以留账,
        // 截断只能把这几只凭空吞掉。counts 写成天文数字是数据自检该抓的事,不该在这里变成静默丢怪
        spawned++;
        sink.spawn(k, base + (rng.next() * 2 - 1) * spread);
      }
    }
  }

  // 6. 主压怪流,**按 streams 数组顺序**
  const streams = seg.streams;
  const prog = segProgress(seg, s.segTime);
  for (let i = 0; i < streams.length; i++) {
    // 撞上限那一帧,后面的流连账都不记:上限是保险丝,不是配额分配器
    if (spawned >= WAVE_MAX_SPAWN_PER_TICK) break;
    const st = streams[i]!;
    let debt = s.debt[i]! + rateAt(st, prog) * dt;
    const spread = st.spreadDeg * DEG2RAD;
    while (debt >= 1 && spawned < WAVE_MAX_SPAWN_PER_TICK) {
      debt -= 1;
      spawned++;
      // 展宽为 0 也照样掷这一次:消耗次数与展宽无关,改一次平衡才不会移动整条随机序列
      sink.spawn(st.kind, s.dirRad + (rng.next() * 2 - 1) * spread);
    }
    s.debt[i] = debt; // 撞上限时余账原样留着,下一帧接着还
  }
}
