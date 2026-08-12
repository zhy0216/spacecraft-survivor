/**
 * 波次运行器(08 号 issue T2)—— 纯逻辑,「脚本 → 出怪事件」的唯一翻译层。
 * 铁律:本目录永不 import pixi/DOM;随机只走调用方递进来的 Rng(sim 内禁 Math.random)。
 *
 * 它只回答"这一帧该朝哪个方向出几只什么怪",一个字都不认识世界:出生点坐标、在场上限、
 * 对象池与 initEnemy 全在实现 SpawnSink 的那一侧(World)。拆开换来的是整套波次脚本
 * 能脱开 World 单测(喂个假 sink 就能把 480 秒跑完),而 World 那边只剩一句
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
 * 精英(14 号实装 WaveElite)同一条口径:型号/词缀/数量全是脚本直给、不额外掷随机 ——
 * 出现时刻只由 at 与 segTime 决定、与种子无关,每出一只恰好一次 rng.next()。
 * 19 号的解锁精英(WAVE_LOCKED_ELITES)也走这条链:换段时按 at 归并进本段精英链,
 * 未解锁的整条跳过 —— 精英零 rng,解锁与否只决定"这组怪出不出",不移动随机序列。
 * 潮汐(tides,节奏改版)同样零 rng:tideMulAt 是 segment + segTime 的纯函数,
 * 只缩放流的记账速率 —— 它改"出多少只",不改"每只怎么掷"(见 tideMulAt 的注释)。
 * 出场顺序 = 侧压 → 主压流 → 精英(帧末):精英排在帧末,触发帧内的普通怪
 * 与无精英脚本逐只一致(帧间序列从下一帧起才整体顺延)。
 */
import type { Rng } from '../core/rng';
import { UNLOCKS } from '../data/unlocks';
import {
  WAVE_LOCKED_ELITES,
  WAVE_MAX_SPAWN_PER_TICK,
  WAVE_MAX_STREAMS,
  WAVE_SEGMENTS,
  type WaveElite,
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
  /**
   * @param angleRad 世界系**绝对**角(0 = +X,顺时针为正);出生点 = 船心 + 该方向上的出怪半径
   * @param affixes 精英词缀编号(data/affixes.ts 的 AFFIX_*)。**undefined = 普通怪**;
   *   精英恒带 ≥1 词缀(脚本口径),实现方按"affixes !== undefined 即精英"分流,
   *   决定体型/HP 放大(ELITE.*)与词缀效果挂载 —— 本模块只透传,不认识词缀语义
   */
  spawn(kind: number, angleRad: number, affixes?: readonly number[]): void;
}

/**
 * 一局波次脚本的运行期状态。**前五个字段是真状态**(segment / segTime / burstNext / eliteNext / debt),
 * 全部进 World.checksum(14 号起 eliteNext 也由世界侧哈希,防止重放失配);
 * unlockMask 是开局定死的输入配置(见字段注释,不进 checksum);
 * elites / dirRad / intensity / done 是 segment + segTime + 脚本的纯函数,随时可重算
 * —— 与 ship.maxHp / World.shipDead 同一条派生量口径:哈它只是把同一件事哈两遍。
 */
export interface WaveState {
  /** 当前航段下标;== WAVE_SEGMENTS.length 表示脚本走完 */
  segment: number;
  /** 段内已过秒数,恒 < 当前段 duration(段推进带余数进位) */
  segTime: number;
  /** 本段下一个待触发的 burst 下标(bursts 按 at 升序,故一个游标就够) */
  burstNext: number;
  /** 本段下一个待触发的精英下标(elites 按 at 升序,与 burstNext 同一条游标口径) */
  eliteNext: number;
  /**
   * 逐流累积的出怪账(下标 = 当前段 streams 的下标)。
   * 0.7 只/秒这种小数速率全靠它攒:每帧四舍五入的话,速率低于 60 只/秒的流会被抹成 0 或炸成满帧。
   */
  debt: number[];
  /**
   * 解锁状态位掩码(19 号):**位 i = UNLOCKS[i] 开没开**(掩码由存档侧构造,跨局不变)。
   * 它只决定"未解锁的 WAVE_LOCKED_ELITES 槽位出不出",而精英是脚本事件(零 rng)——
   * 于是解锁与否只收窄"这组怪出不出",不移动随机序列(19 号验收)。
   * 它是开局定死的**输入配置**(与 seed 同一条"构造时给一次"的待遇),不是逐帧演化的状态,
   * 也不进 checksum:它从不参与任何判定,只影响"脚本里本来就没有的槽位"出不出。
   */
  unlockMask: number;
  /**
   * 本段实际要出的精英链:**段表 elites + 已解锁的 WAVE_LOCKED_ELITES**,按 at 归并升序。
   * 解锁槽位不进 WAVE_SEGMENTS(19 号:往既有段里塞一只精英 = 改掉所有既有 seed 的出怪序列),
   * 这里是它们唯一的落点;未解锁的整条跳过。精英零 rng,两条路都不扰动随机序列。
   * **派生量**:segment + 脚本 + unlockMask 的纯函数(enterSegment 每次换段现拼),
   * 与 dirRad / intensity 同一条"哈它只是把同一件事哈两遍"的口径 —— eliteNext 是唯一真状态。
   */
  elites: WaveElite[];
  /** 脚本计划的主压方向(弧度,折回 (-π, π]);实际统计无样本时供 World 罗盘兜底。**派生量** */
  dirRad: number;
  /** 脚本计划强度 = 本段各 stream 当前速率之和(只/秒);供调试与脚本测试，不冒充实际生成。**派生量** */
  intensity: number;
  /** segment >= WAVE_SEGMENTS.length 的**派生量**;World 据此进入 Boss 战(15 号),胜利还要 Boss 已击杀(见 world.settleOutcome) */
  done: boolean;
}

/**
 * 段内进度 [0, 1]。要夹一次是因为 waveDirAt / waveIntensityAt 是**公开**函数
 * (调试与单测会拿任意 segTime 问它们),而"segTime < duration"只在 runner 内部成立。
 * duration <= 0 的坏数据回落成 0:与其吐 Infinity/NaN 让罗盘乱转,不如钉在段首角上。
 */
function segProgress(seg: WaveSegment, segTime: number): number {
  if (!(seg.duration > 0)) return 0;
  const p = segTime / seg.duration;
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

/** 某条流的当前**基线**速率(只/秒):段首 rate0 → 段尾 rate1 线性插值,这就是「随时间的密度曲线」 */
function rateAt(st: WaveStream, prog: number): number {
  return st.rate0 + (st.rate1 - st.rate0) * prog;
}

/**
 * 潮汐系数:segTime 落在某个 tides 窗口内 → 该窗口的 mul,否则 1(基线)。
 * 窗口按 at 升序且互不重叠(data/waves.test 钉),故扫到第一个"还没开始"的窗口即可收工 ——
 * 正常一段只有几个窗口,这是每帧一次的 O(个位数) 早退扫描,零分配。
 * **零 rng、零状态**:它是 segment + segTime 的纯函数,与 waveDirAt 同一条派生量口径;
 * 它只缩放流的记账速率(mul < 1 攒得慢、> 1 攒得快),每成功出一只仍恰好一次 rng.next(),
 * "同 seed 同序列"的消耗契约一个字不动 —— 潮汐改的是出多少只,不是每只怎么掷。
 * 公开导出:HUD/调参面板要能单独问"此刻是潮是汐"(与 waveDirAt / waveIntensityAt 同待遇)。
 */
export function tideMulAt(seg: WaveSegment, segTime: number): number {
  const tides = seg.tides;
  for (let i = 0; i < tides.length; i++) {
    const w = tides[i]!;
    if (segTime < w.at) return 1;
    if (segTime < w.at + w.duration) return w.mul;
  }
  return 1;
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

/**
 * 脚本计划强度(只/秒)= 本段各流当前速率之和 × 潮汐系数;侧压 burst 是离散事件,不属于这条计划曲线。
 * 潮汐乘在这里而不是只乘在出怪处:罗盘强度与调试读数要如实反映"此刻真的静了/涨了",
 * 退潮的"耳朵一静"本身就是给玩家的预警信号(WaveTide 编排铁律 1 的可读性落点)。
 */
export function waveIntensityAt(seg: WaveSegment, segTime: number): number {
  const prog = segProgress(seg, segTime);
  let sum = 0;
  for (const st of seg.streams) sum += rateAt(st, prog);
  return sum * tideMulAt(seg, segTime);
}

/** peekNextBurst 的答复(调用方持有、跨帧复用,铁律 3:热路径零分配) */
export interface BurstPeek {
  /** 距触发还有几秒(>= 0;已到点未消费的帧上是 0) */
  etaSeconds: number;
  /** 相对当时主压方向的偏移(度,照抄脚本;换算成绝对角是调用方的事 —— 它有 dirRad,这里没有) */
  offsetDeg: number;
}

/**
 * 只读地看一眼**当前段**下一个未触发的 burst(HUD 预警箭头用,11 号罗盘的补课):
 * waveIntensityAt 明文不含 burst,整队瞬时出现 —— 罗盘只能在怪已出生后才反应,
 * 180° 背袭直扑火力死角时"看得懂再挨打"的可读性原则完全落空。
 * 复用运行器自己的 burstNext 有序游标(bursts 按 at 升序),**零 rng、零状态改动**:
 * 确定性与既有序列一个字都不碰。跨段不看 —— 下一段的 burst 要等换段才有确定的主压方向。
 * @returns 是否有下一个 burst;false 时 out 不动
 */
export function peekNextBurst(s: WaveState, out: BurstPeek): boolean {
  const seg = WAVE_SEGMENTS[s.segment];
  if (seg === undefined) return false;
  const b = seg.bursts[s.burstNext];
  if (b === undefined) return false;
  const eta = b.at - s.segTime;
  out.etaSeconds = eta > 0 ? eta : 0;
  out.offsetDeg = b.offsetDeg;
  return true;
}

/** peekNextElite 的答复(调用方持有、跨帧复用,铁律 3:热路径零分配) */
export interface ElitePeek {
  /** 距触发还有几秒(>= 0;已到点未消费的帧上是 0) */
  etaSeconds: number;
  /** KIND_*(data/enemies.ts);精英是普通敌型的放大版,不另开一张表 */
  kind: number;
  count: number;
  /** 词缀编号(data/affixes.ts 的 AFFIX_*);非空 = 精英 */
  affixes: readonly number[];
}

/**
 * 只读地看一眼**当前段**下一个未触发的精英(出场预警用,与 peekNextBurst 同一条口径):
 * 精英是"突发时刻",~2s 前就得让玩家知道来的是谁 —— 别让突发变秒杀(todos/14)。
 * 复用运行器自己的 eliteNext 有序游标(elites 按 at 升序),**零 rng、零状态改动**:
 * 确定性与既有序列一个字都不碰。跨段不看 —— 下一段的精英要等换段才有确定的主压方向。
 * @returns 是否有下一个精英;false 时 out 不动
 */
export function peekNextElite(s: WaveState, out: ElitePeek): boolean {
  const el = s.elites[s.eliteNext];
  if (el === undefined) return false;
  const eta = el.at - s.segTime;
  out.etaSeconds = eta > 0 ? eta : 0;
  out.kind = el.kind;
  out.count = el.count;
  out.affixes = el.affixes;
  return true;
}

/**
 * 解锁槽位的掩码位 = 它在 UNLOCKS 表里的下标(unlockId 与条目 id 同串,data/waves.test 钉着)。
 * @returns 掩码位;unlockId 在表里查不到 = 数据写坏了,返回 -1 按"未解锁"跳过
 */
function unlockBit(unlockId: string): number {
  for (let i = 0; i < UNLOCKS.length; i++) {
    if (UNLOCKS[i]!.id === unlockId) return i;
  }
  return -1;
}

/**
 * 进入某一段时的复位:出怪账清零、侧压游标归零,并按新段的流数补齐 debt。
 * 顺带把本段要出的精英链拼出来(段表 elites + 已解锁的 WAVE_LOCKED_ELITES,按 at 升序)——
 * 解锁槽位的归并只发生在**换段那一帧**,与 debt 补齐同一条铁律 3 例外。
 * 补齐是运行期唯一可能的分配,且只发生在**换段那一帧**;热循环里一个字都不 push(铁律 3)。
 */
function enterSegment(s: WaveState): void {
  for (let i = 0; i < s.debt.length; i++) s.debt[i] = 0;
  s.burstNext = 0;
  s.eliteNext = 0;
  const seg = WAVE_SEGMENTS[s.segment];
  // 精英链每次换段整条重拼(派生量,见 WaveState.elites 的注释)。
  // 两条源都按 at 升序,双游标归并;未解锁槽位在归并现场跳过 —— 精英零 rng,
  // 跳过只是少出一组怪,随机序列一个字节都不动(19 号验收"同 seed 普通怪序列逐位一致")
  s.elites.length = 0;
  if (seg !== undefined) {
    const regs = seg.elites;
    let i = 0; // 段表精英游标
    let j = 0; // 解锁槽位游标
    while (i < regs.length || j < WAVE_LOCKED_ELITES.length) {
      // 槽位游标先越过"不属于本段 / 未解锁"的条目:它们不配出现在本段的精英链里
      while (j < WAVE_LOCKED_ELITES.length) {
        const l = WAVE_LOCKED_ELITES[j]!;
        const bit = unlockBit(l.unlockId);
        if (l.segmentIndex === s.segment && bit >= 0 && (s.unlockMask & (1 << bit)) !== 0) break;
        j++;
      }
      const l = WAVE_LOCKED_ELITES[j];
      if (l === undefined) {
        // 槽位已耗尽:剩下的全是段表精英,原样续完
        while (i < regs.length) s.elites.push(regs[i++]!);
      } else if (i >= regs.length || l.at < regs[i]!.at) {
        s.elites.push(l);
        j++;
      } else {
        s.elites.push(regs[i]!);
        i++;
      }
    }
  }
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
 * @param unlockMask 解锁状态位掩码(位 i = UNLOCKS[i] 开没开),缺省 0 = 全部未解锁;
 *   它只决定 WAVE_LOCKED_ELITES 槽位出不出(见 WaveState.unlockMask 的注释)
 */
export function createWaveState(unlockMask: number = 0): WaveState {
  const s: WaveState = {
    segment: 0,
    segTime: 0,
    burstNext: 0,
    eliteNext: 0,
    // 预分配到全脚本的最大流数:正常换段时一个字节都不必再分配(铁律 3)
    debt: new Array<number>(WAVE_MAX_STREAMS).fill(0),
    unlockMask,
    elites: [],
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
  enterSegment(s); // burstNext / eliteNext 与 debt 都在里面
  refreshDerived(s);
}

/**
 * 推进波次一逻辑帧。**每一步的顺序都定死**(整条 rng 序列依赖它,单测按此钉):
 *   1 走完直接闭嘴 → 2 推时间 → 3 段推进(带余数进位)→ 4 重算方向/强度 →
 *   5 侧压事件 → 6 主压怪流 → 7 精英插入(帧末)。
 * 调换 5–7 中的任意两步或者把 2 挪到 4 之后,出怪序列会整条错位 —— 同 seed 复现当场作废。
 *
 * @param dt 逻辑帧步长(秒),固定时步下恒为 SIM_DT;做成参数是为了单测能一口气跑完一段
 */
export function stepWaves(
  s: WaveState,
  dt: number,
  rng: Rng,
  sink: SpawnSink,
  stopAtSegmentBoundary: boolean = false,
): void {
  // 1. 脚本走完就彻底闭嘴。World 在胜利之后照常 step(既有那条"船沉后世界照常往下跑"的
  //    用例仍然成立),不在这里 return 的话结算界面背后还会继续涌怪
  if (s.done) return;

  // 2. 先推时间再按新状态出力(与 sim/enemy.ts 的状态机同口径:到期那一帧当场按新状态算)
  s.segTime += dt;

  // 3. 段推进:**带余数进位**,于是整套脚本的总时长严格 = Σduration,
  //    不会因为 dt 除不尽 duration 而每段各吞掉小半帧。
  //    用 while 而不是 if:单测里 splice 进来的短脚本一帧跨两段也得算对。
  const segmentBefore = s.segment;
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

  // 4. 脚本计划方向与强度。本帧主流出怪以 dirRad 为基准；World 另按真正成功的事件统计 HUD 实况。
  s.dirRad = waveDirAt(seg, s.segTime);
  s.intensity = waveIntensityAt(seg, s.segTime);
  // 正式游戏在段边界进入整备:段号/余数/下一段预告已经落地，但下一段一只怪都还没出生。
  // 默认 false 保留纯运行器原有语义，批量仿真与既有单测仍可一帧跨段并立即按新段出力。
  if (stopAtSegmentBoundary && s.segment !== segmentBefore) return;

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

  // 6. 主压怪流,**按 streams 数组顺序**。潮汐(tideMulAt)只乘在这条记账速率上:
  //    退潮攒得慢、涨潮攒得快,bursts/elites 是原子事件不受它管(WaveTide 的分工口径)
  const streams = seg.streams;
  const prog = segProgress(seg, s.segTime);
  const tide = tideMulAt(seg, s.segTime);
  for (let i = 0; i < streams.length; i++) {
    // 撞上限那一帧,后面的流连账都不记:上限是保险丝,不是配额分配器
    if (spawned >= WAVE_MAX_SPAWN_PER_TICK) break;
    const st = streams[i]!;
    let debt = s.debt[i]! + rateAt(st, prog) * tide * dt;
    const spread = st.spreadDeg * DEG2RAD;
    while (debt >= 1 && spawned < WAVE_MAX_SPAWN_PER_TICK) {
      debt -= 1;
      spawned++;
      // 展宽为 0 也照样掷这一次:消耗次数与展宽无关,改一次平衡才不会移动整条随机序列
      sink.spawn(st.kind, s.dirRad + (rng.next() * 2 - 1) * spread);
    }
    s.debt[i] = debt; // 撞上限时余账原样留着,下一帧接着还
  }

  // 7. 精英插入(帧末)。与侧压同一条原子事件口径:按 at 升序游标一路向前、不被本帧上限截断;
  // 型号/词缀/数量全是脚本直给,每出一只恰好消耗一次角度随机(与展宽无关的既有惯例)。
  // 排在帧末出:触发帧内的普通怪(事件 + 流)与无精英脚本逐只一致,帧间序列才整体顺延。
  // 精英链 = 段表 elites + 已解锁的 WAVE_LOCKED_ELITES(enterSegment 每段拼好,见 s.elites)
  const elites = s.elites;
  while (s.eliteNext < elites.length) {
    const el = elites[s.eliteNext]!;
    if (el.at > s.segTime) break;
    s.eliteNext++;
    for (let j = 0; j < el.count; j++) {
      // 出生角 = 当时的主压方向,展宽恒 0(接口没有偏移字段:精英是主压流的"节点")。
      // 展宽为 0 也照样掷这一次:消耗次数与展宽无关,改一次平衡才不会移动整条随机序列
      rng.next();
      // 计进 spawned,但**不被本帧上限截断**:与 bursts 同一条原子事件口径
      spawned++;
      sink.spawn(el.kind, s.dirRad, el.affixes);
    }
  }
}
