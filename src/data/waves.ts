/**
 * 波次脚本(08 号 issue T1)—— 纯数据,只 import 同目录的 data/enemies 的 KIND_* 常量。
 * 铁律:src/data 与 src/sim 一样永不 import pixi/DOM;**也永不 import sim/**(config 与 waves 运行器
 * 都在下游,sim/waves.ts 单向读本文件,引回去就成环)。于是 08 号也落在 05 号那条验收上:
 * **改本文件即可调整单局节奏,不改一行逻辑代码**。
 *
 * 单局 = 一串首尾相接的**航段**(GDD §9 的星图/节点结构在 MVP 里裁剪成了这个)。
 * 每段的语法照 GDD §6.3:`主压方向流(持续) + 侧压事件(定时) + 精英插入(节点)`。
 *
 * 角度口径(与 ship.heading 同一套,全仓统一):世界系**绝对角**,0 = +X,顺时针为正(y 轴朝下)。
 * 主压方向刻意**不是相对船头的角** —— 相对船头的话,玩家一转舵怪就跟着转,转舵这个动作本身就没意义了;
 * 而 GDD §6.3 要的正是"最优舷持续漂移":方向随航段缓慢旋转,玩家得一直微调航向,不能找个角度挂机。
 * 本表一律写**度**并带 Deg 后缀(数值表要能一眼对着 GDD 核对),sim/waves.ts 进门就 × DEG2RAD 换弧度,
 * 与 data/arcs.ts 那条"度数表能核对、弧度表核对不了"同源。
 *
 * 与 data/towers.ts 同风格:字段不加 readonly、数组也不 Object.freeze ——
 * 单测要把 WAVE_SEGMENTS 整段 splice 成一份几秒钟的短脚本、跑完再还原
 *(真跑完整局是 550s ≈ 33000 逻辑帧,单测里等不起)。
 *
 * 除"4 段 × 90–180s、总时长 8–10 分钟"这条结构口径来自 todos/08 外,所有数字全部占位待调。
 */
import { KIND_BEETLE, KIND_STRAFER, KIND_SWARM, KIND_TRAILER } from './enemies';

/**
 * 主压怪流:整段**持续**出的那一股,方向就是当时的主压方向。
 * 速率写"段首 / 段尾"两点、段内按 segTime/duration 线性插值 —— 这就是 GDD §6.3 的"随时间的密度曲线"。
 * 刻意只给两点:三点以上的曲线在数据表里既难核对也难调,而"这段开头多少、结尾多少"是设计师一眼能对的承诺。
 */
export interface WaveStream {
  /** KIND_*(data/enemies.ts);型号由脚本给死,运行器不为它掷随机 */
  kind: number;
  /** 段首速率(只/秒) */
  rate0: number;
  /** 段尾速率(只/秒);段内线性插值 */
  rate1: number;
  /**
   * 相对主压方向的**半展宽**(度):出生角 = 主压方向 ± spread。
   * 它决定"这股压力糊多宽的一片舷" —— 太窄成一条线(一门窄弧塔就锁死了),太宽就没有"主压方向"可言。
   */
  spreadDeg: number;
}

/**
 * 定时侧压事件:段内某一刻**一次性**放出一组怪,用来打断"对着主压方向摆好舷就不动"的稳态。
 * 与主压流的分工是节奏上的:流是背景压力,事件是突发。
 */
export interface WaveBurst {
  /** 段内触发时刻(秒),必须 < duration;同段内数组按 at **升序**(运行器只往前扫,不回头找) */
  at: number;
  /**
   * 相对**当时的主压方向**的偏移(度):±90 = 侧压(逼玩家换舷),180 = 背后(咬火力死角的船尾)。
   * 写相对量而不是绝对角:主压方向在段内是转着的,写死绝对角的话,同一个"侧压"到了段尾就变成正面压了。
   */
  offsetDeg: number;
  /** 半展宽(度),同 WaveStream.spreadDeg;事件一般比流窄 —— 要让人一眼看出"它们是一起从那边来的" */
  spreadDeg: number;
  /**
   * 逐型只数,**下标 = KIND_***,顺序 蜂群蛭 / 侧掠者 / 尾随蛆 / 冲撞甲虫,
   * 长度必须 = ENEMY_KIND_COUNT(短一位就会静默漏掉一型,单测钉住)。
   */
  counts: number[];
}

/**
 * 精英插入 —— **接口预留,MVP 不实装**(todos/08 明写)。
 * 运行器一行都不读它,每段的 elites 恒为 []:留着类型与字段,是为了精英(GDD §6.4:放大体型 + 1–2 词缀)
 * 落地那天,脚本格式与运行器入口都不必回头改结构;而**不留死代码路径** —— 接口预留 = 类型存在,
 * 不是"先写一套永远走不到的分支在那里烂着"。
 */
export interface WaveElite {
  /** 段内触发时刻(秒) */
  at: number;
  /** KIND_*;精英是普通敌型的放大版,不另开一张表 */
  kind: number;
  count: number;
  /** 词缀编号(GDD §6.4:狂热光环 / 裂变 / 磁力干扰 / 装甲 / 相位);词缀表将来另立 data/affixes.ts */
  affixes: number[];
}

/** 一个航段 = 一段时长内的"方向 + 流 + 事件" */
export interface WaveSegment {
  /** 只给人看(调参面板与结算界面显示"第 n 段:碎石带"),逻辑不读 */
  name: string;
  /** 秒,90–180(todos/08 的单局结构口径) */
  duration: number;
  /** 主压方向起角(绝对角,度) */
  dirStartDeg: number;
  /**
   * 主压方向止角(绝对角,度)。**写累积角、绝不折回**:插值是线性的,
   * 想从 320° 转到 120° 就写 480 而不是 120 —— 写 120 的话它会倒着转 200°,
   * "最优舷缓慢漂移"当场变成一次急甩。相邻两段首尾相接(mod 360),单测钉住。
   */
  dirEndDeg: number;
  streams: WaveStream[];
  bursts: WaveBurst[];
  /** MVP 一律 [];见 WaveElite */
  elites: WaveElite[];
}

/**
 * 单局的四个航段(todos/08:4 段 × 90–180s,总时长 8–10 分钟)。
 * 四段的方向连起来是 0° → 480°(整整一圈半):最优舷绕船转过一整周还多,
 * 于是不存在"某一个航向能吃满全局"的解 —— 这正是 GDD §6.3 那条设计意图的落点。
 *
 * 压力曲线的编排口径(数字全部占位待调,但这几条是机制,改数字时别改坏):
 *   1. 段内密度只涨不落,**换段时也不掉压**(rate1 → 下一段的 rate0 不许回落),
 *      否则每次换段都送玩家一段白给的喘息,九分钟就成了四段各自的小高潮。
 *   2. 敌型逐段解锁:蜂群蛭(教学)→ + 侧掠者(逼换舷)→ + 尾随蛆(罚死角)→ + 冲撞甲虫(考转向)。
 *      除打底的蜂群蛭外,每一型**先在侧压事件里露一次面,下一段才进流** ——
 *      一次来一小队,比混进流里更看得清它的行为(冲锋型尤其:前摇得看得见才叫"来得及躲")。
 *   3. 侧压事件左右交替,并在中后段插入 180°(背后):船尾是火力死角,那一下就是在收"甲板怎么排"的账。
 */
export const WAVE_SEGMENTS: WaveSegment[] = [
  {
    // 教学段:只有一条蜂群蛭的正压流,方向几乎不动(60° / 100s = 0.6°/s)。
    // 玩家有空把开局那几座塔摆上甲板,并认清"主压方向"这件事本身
    name: '离港航道',
    duration: 100,
    dirStartDeg: 0,
    dirEndDeg: 60,
    streams: [
      // 蜂群蛭是广弧塔的口粮:段尾 2.6 只/秒,正好压到"一门机炮清不完"
      { kind: KIND_SWARM, rate0: 1.2, rate1: 2.6, spreadDeg: 50 },
    ],
    bursts: [
      // 侧掠者首秀:右舷一小队。展宽收窄到 12° = 一眼看得出它们是一起从那边来的
      { at: 35, offsetDeg: 90, spreadDeg: 12, counts: [0, 4, 0, 0] },
      // 换到左舷:两次方向相反,玩家才会明白侧压不是固定一边(否则第一段就学歪了)
      { at: 70, offsetDeg: -90, spreadDeg: 12, counts: [0, 5, 0, 0] },
    ],
    elites: [],
  },
  {
    // 主压方向开始真的走起来(140° / 130s ≈ 1.1°/s,全局最快的一段):
    // 摆好的舷会慢慢偏出去,第一次逼玩家意识到"得一直转"
    name: '碎石带',
    duration: 130,
    dirStartDeg: 60,
    dirEndDeg: 200,
    streams: [
      { kind: KIND_SWARM, rate0: 2.4, rate1: 3.4, spreadDeg: 55 },
      // 侧掠者进流:它自带 ±90° 驻留,哪怕从主压方向来也会绕到舷侧去,
      // 于是"主压方向"与"实际挨打的舷"第一次出现偏差
      { kind: KIND_STRAFER, rate0: 0.25, rate1: 0.6, spreadDeg: 35 },
    ],
    bursts: [
      { at: 30, offsetDeg: 90, spreadDeg: 14, counts: [6, 3, 0, 0] },
      // 尾随蛆首秀,而且是从背后来的:船尾没塔的甲板会在这一下吃到教训
      { at: 62, offsetDeg: 180, spreadDeg: 20, counts: [0, 0, 4, 0] },
      { at: 96, offsetDeg: -90, spreadDeg: 14, counts: [8, 4, 0, 0] },
    ],
    elites: [],
  },
  {
    name: '巡逻线',
    duration: 150,
    dirStartDeg: 200,
    dirEndDeg: 320,
    streams: [
      { kind: KIND_SWARM, rate0: 3.2, rate1: 4.2, spreadDeg: 60 },
      { kind: KIND_STRAFER, rate0: 0.6, rate1: 1.0, spreadDeg: 35 },
      // 尾随蛆进流:它只驻留不冲锋,压力是"持续咬着尾巴"而不是突发,适合当背景噪声
      { kind: KIND_TRAILER, rate0: 0.3, rate1: 0.6, spreadDeg: 25 },
    ],
    bursts: [
      { at: 25, offsetDeg: 90, spreadDeg: 14, counts: [8, 4, 0, 0] },
      { at: 60, offsetDeg: 180, spreadDeg: 22, counts: [0, 0, 6, 0] },
      // 冲撞甲虫首秀:只有一只,而且从侧面来 —— 0.9s 前摇看得清,躲一次就学会了
      { at: 95, offsetDeg: -90, spreadDeg: 14, counts: [0, 6, 0, 1] },
      // 斜后方 135°:既不是纯侧也不是纯背,逼玩家在"转过去接"和"跑开"之间选
      { at: 130, offsetDeg: 135, spreadDeg: 25, counts: [10, 0, 4, 0] },
    ],
    elites: [],
  },
  {
    // 收尾段:四型齐全、最长(170s)、密度最高。方向从 320° 转到 480°(= 120°),
    // 累积角写成 480 而不是折回 120,见 WaveSegment.dirEndDeg
    name: '虫潮合围',
    duration: 170,
    dirStartDeg: 320,
    dirEndDeg: 480,
    streams: [
      { kind: KIND_SWARM, rate0: 4.2, rate1: 5.4, spreadDeg: 65 },
      { kind: KIND_STRAFER, rate0: 1.0, rate1: 1.5, spreadDeg: 35 },
      { kind: KIND_TRAILER, rate0: 0.5, rate1: 0.9, spreadDeg: 25 },
      // 冲撞甲虫进流,速率压得极低:它单只 40 HP、撞一下 18 伤,再多就不是"考转向"而是刷血条了
      { kind: KIND_BEETLE, rate0: 0.15, rate1: 0.35, spreadDeg: 20 },
    ],
    bursts: [
      { at: 25, offsetDeg: -90, spreadDeg: 14, counts: [0, 6, 0, 2] },
      { at: 60, offsetDeg: 180, spreadDeg: 22, counts: [0, 0, 8, 0] },
      { at: 95, offsetDeg: 90, spreadDeg: 14, counts: [12, 6, 0, 0] },
      { at: 130, offsetDeg: -135, spreadDeg: 25, counts: [0, 4, 4, 3] },
      // 终局正面压上(offset 0 = 主压方向本身):脚本的最后一口气,活过它就是胜利
      { at: 160, offsetDeg: 0, spreadDeg: 30, counts: [16, 8, 0, 4] },
    ],
    elites: [],
  },
];

/**
 * 单局总时长(秒)= Σduration。**从表里推导而不是写死**:改任一段时长它自动跟上,
 * 不会悄悄与"8–10 分钟"这条结构口径失配(与 data/enemies.ts 的 ENEMY_RADIUS_MAX 同口径)。
 * 模块加载时算一次 —— 单测把 WAVE_SEGMENTS splice 成短脚本后它不会重算,而那正是想要的:
 * 它是"本作单局有多长"这条**设计口径**,不是运行器的状态(运行器一个字都不读它,
 * 局终由逐段推进到越界自然得出,少一处能对不上的真相)。
 */
export const WAVE_TOTAL_TIME = WAVE_SEGMENTS.reduce((sum, seg) => sum + seg.duration, 0);

/**
 * 一段里最多几条主压流 = sim/waves.ts 里 debt 数组的**预分配长度**(铁律 3:运行期零新增分配)。
 * 同样从表里推导:加一条流不必回头改运行器。
 * 运行器仍会在换段时按需补齐 —— 单测 splice 进来的短脚本可能比它长,而补齐只发生在换段那一帧,
 * 不在热循环里。
 */
export const WAVE_MAX_STREAMS = WAVE_SEGMENTS.reduce(
  (max, seg) => (seg.streams.length > max ? seg.streams.length : max),
  0,
);

/**
 * 出怪半径:以**船**为心(地图无限,没有场心这回事),世界 px。
 * 必须**大于镜头视野半径**,否则敌人会当着玩家的面凭空出现。21:9 3440×1440(市面最宽的一档)下的推导:
 *   scale      = 屏高 × tuning.cameraShipHeightFraction ÷ tuning.shipLength = 1440 × 0.064 ÷ 48 = 1.92
 *   视野半对角 = hypot(屏宽, 屏高) ÷ 2 ÷ scale = 3729.2 ÷ 2 ÷ 1.92 ≈ 971
 *   lookAhead  = 屏高 × tuning.cameraLookAhead ÷ scale = 1440 × 0.15 ÷ 1.92 = 112.5(镜头前推的那一截也要算进去)
 *   合计 ≈ 1083 → 取 1150,留 ~67px 余量
 *  (船缩小与占屏比例调低是一对连动 —— 见 tuning.cameraShipHeightFraction 的注释,scale 恒 1.92 不变)
 * sim 不知道屏幕多大(铁律 1:sim 永不认识 DOM/画布),所以这个数就是渲染层与 sim 之间**唯一的约定**:
 * 换更宽的屏、或把 cameraShipHeightFraction 调小(= 镜头拉远),都得回来把它加大 —— 单测钉着这条不等式。
 * 上界也有:出得太远,最慢的敌型要走好几秒才进屏,密度曲线与实际压力就对不上了(单测一并钉住)。
 *
 * 它同时是 sim/world.ts 那对防风筝常量的基准:被甩开(> SPAWN_RADIUS + 2×BAND)的敌人
 * 镜像重投回这个半径上 —— 出怪与重投共用同一档进屏距离,玩家分不出谁是挪过来的。
 */
export const SPAWN_RADIUS = 1150;

/**
 * 半径抖动带:实际出怪半径 ∈ [SPAWN_RADIUS, SPAWN_RADIUS + BAND)。
 * 不抖的话,一股流出上百只之后会在屏外排成一个正圆弧,进屏时整整齐齐一排 ——
 * 一眼就看出是脚本刷出来的,而且同排的怪会同时抵达,把"持续压力"压成一下一下的脉冲。
 */
export const SPAWN_RADIUS_BAND = 150;

/**
 * 在场敌人上限:触顶后当帧的出怪请求直接丢弃(**不留账** —— 留账的话上限一解除就会一口气吐出来)。
 * 1400 护的是 01 号那条 1000 敌同屏预算,并留出 40% 余量给收尾段的爆发。
 * 它是**保险丝而不是旋钮**:正常脚本下够不到,够到了说明玩家火力已经彻底崩了(那一局本就要输)。
 */
export const WAVE_MAX_ALIVE = 1400;

/**
 * 单帧出怪硬上限。正常脚本远够不到(最大的一次侧压事件也只有几十只,单测钉住它必须能一帧出完),
 * 它护的是"数据写坏"这一种情况:某条流的 rate 被误填成 1e6 时,不至于一帧里出十万只把画面卡死 ——
 * 与 data/towers.ts 那些"不用就填 0"的口径一样,是给手滑留的一道栏杆。
 */
export const WAVE_MAX_SPAWN_PER_TICK = 64;
