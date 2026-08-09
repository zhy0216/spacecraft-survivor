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
 *(真跑完整局是 480s ≈ 28800 逻辑帧,单测里等不起)。
 *
 * 当前结构固定为 **4 段 × 120s**:每两分钟敌群升级一次，同时给玩家一次甲板整备。
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
 * 精英插入 —— 普通敌型的放大个体(GDD §6.4:放大体型 + 1–2 词缀),**运行器按 at 触发**(todos/14 实装)。
 * 与 burst 同一条原子事件口径:到点那一帧整组出、不被单帧上限截断;kind/count 出怪、affixes 原样透传。
 * 出生角 = **当时的主压方向**(接口没有偏移字段:精英是主压流的"节点",与流同源而来)。
 * kind 用普通敌型编号,不另开一张表;词缀编号见 data/affixes.ts 的 AFFIX_*(五个编号的顺序由那张表钉死)。
 */
export interface WaveElite {
  /** 段内触发时刻(秒) */
  at: number;
  /** KIND_*;精英是普通敌型的放大版,不另开一张表 */
  kind: number;
  count: number;
  /** 词缀编号(GDD §6.4:狂热光环 / 裂变 / 磁力干扰 / 装甲 / 相位;编号表见 data/affixes.ts) */
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
  /**
   * 精英插入节点,按 at 升序(与 bursts 同一条游标口径:运行器只往前扫,不回头找)。
   * 编排口径(todos/14):教学段(第一段)恒空,其余段 1–2 个、中后段给力。
   */
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
 *   4. 精英从第二段起每段 1–2 个、中后段给力,教学段不塞;五种词缀整局轮着上场,
 *      每只精英的 kind 不早于该型在侧压/流里的首秀(别让精英抢了首秀的戏)。
 */
export const WAVE_SEGMENTS: WaveSegment[] = [
  {
    // 教学段:只有一条蜂群蛭的正压流,方向几乎不动(60° / 120s = 0.5°/s)。
    // 玩家有空把开局那几座塔摆上甲板,并认清"主压方向"这件事本身
    name: '离港航道',
    duration: 120,
    dirStartDeg: 0,
    dirEndDeg: 60,
    streams: [
      // 蜂群蛭是广弧塔的口粮:段尾 2.6 只/秒,正好压到"一门机炮清不完"
      { kind: KIND_SWARM, rate0: 1.2, rate1: 2.6, spreadDeg: 50 },
    ],
    bursts: [
      // 侧掠者首秀:右舷一小队。展宽收窄到 12° = 一眼看得出它们是一起从那边来的。
      // 48s / 3 只(畅玩性调整,原 35s / 4 只):挪到第一次升级(前三档特价后约 20s 内见卡)
      // 大概率落地之后 —— 首秀从"裸装配考试"变成"刚拿到新塔正好试刀";总血量 80→60,
      // 一次处理不当也不再是 30-40% 船体的挫败源(整局无回血,教学段的坑要浅)
      { at: 48, offsetDeg: 90, spreadDeg: 12, counts: [0, 3, 0, 0] },
      // 换到左舷:两次方向相反,玩家才会明白侧压不是固定一边(否则第一段就学歪了)
      { at: 80, offsetDeg: -90, spreadDeg: 12, counts: [0, 4, 0, 0] },
    ],
    elites: [],
  },
  {
    // 主压方向开始真的走起来(140° / 120s ≈ 1.17°/s,全局最快的一段):
    // 摆好的舷会慢慢偏出去,第一次逼玩家意识到"得一直转"
    name: '碎石带',
    duration: 120,
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
    elites: [
      // 首只精英:侧掠者 + 狂热光环/装甲 —— "这只不一样"的教学时刻:
      // 光环让半径内的蜂群蛭提速,装甲让它硬吃弹药系(机炮/点防)更久
      { at: 40, kind: KIND_STRAFER, count: 1, affixes: [0, 3] },
      // 尾随蛆精英 + 磁力干扰:它赖在船尾,拾取半径减半就是逼玩家先处理它再捡钱
      { at: 95, kind: KIND_TRAILER, count: 1, affixes: [2] },
    ],
  },
  {
    name: '巡逻线',
    duration: 120,
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
      { at: 110, offsetDeg: 135, spreadDeg: 25, counts: [10, 0, 4, 0] },
    ],
    elites: [
      // 相位蜂群蛭:能量系(激光/电弧/磁轨/迫击炮)对它减半,机炮/点防反而才是正解 ——
      // 逼玩家读一读自己甲板上"哪座塔是什么系"
      { at: 30, kind: KIND_SWARM, count: 1, affixes: [4] },
      // 冲撞甲虫精英 + 裂变:击杀后爆成三只 —— 冲锋前摇在放大体型下更要看清,别站着不动
      { at: 100, kind: KIND_BEETLE, count: 1, affixes: [1] },
    ],
  },
  {
    // 收尾段:四型齐全、密度最高。方向从 320° 转到 480°(= 120°),
    // 累积角写成 480 而不是折回 120,见 WaveSegment.dirEndDeg
    name: '虫潮合围',
    duration: 120,
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
      { at: 108, offsetDeg: -135, spreadDeg: 25, counts: [0, 4, 4, 3] },
      // 终局正面压上(offset 0 = 主压方向本身):脚本的最后一口气,活过它就是胜利
      { at: 116, offsetDeg: 0, spreadDeg: 30, counts: [16, 8, 0, 4] },
    ],
    elites: [
      // 狂热光环侧掠者:收尾段怪最密,光环的收益最大 —— 它活着,整片虫潮都在加速
      { at: 40, kind: KIND_STRAFER, count: 1, affixes: [0] },
      // 收尾"小Boss":冲撞甲虫 + 裂变/装甲 —— 血厚、死了还炸三只,活过它就是胜利
      { at: 85, kind: KIND_BEETLE, count: 1, affixes: [1, 3] },
    ],
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
 * 解锁精英事件(19 号 issue)—— **不进 WAVE_SEGMENTS** 的预留槽位表。
 * 为什么要单独成表而不是直接加进某一段:
 *   WAVE_SEGMENTS 是"同 seed 出怪序列逐位可复现"的确定性地基(08/14 号用例钉死),
 *   往既有段里多塞一只精英 = 改掉所有既有 seed 的出怪序列,一整批用例跟着作废;
 *   而解锁事件的出场是**看存档的**(未解锁绝不出现),两件事不该缠在一起。
 * 于是新事件以独立槽位存在:unlockId 指向 unlocks.ts 的 UNLOCK_ELITE 条目,
 * 运行器(sim/waves.ts,后续 issue 接线)在"该解锁已开"时按 segmentIndex 归位、
 * 按 at 升序插入目标段 —— 与既有精英同一套"按 at 触发、整组出、零 rng"的原子口径:
 * 精英本来就是脚本事件(不消耗任何 rng),解锁与否只决定"这组怪出不出",
 * 不移动随机序列 —— 19 号"解锁状态不影响同 seed rng 序列"的验收由此天然成立。
 *
 * 词缀数刻意 > 既有段的上限 2(GDD §6.4 的 1–2 词缀是普通段口径):
 * "词缀更高的精英事件" = 更多词缀的复合威胁,这正是它值得被解锁的原因。
 * 数值占位待调;unlockId 与 unlocks.ts 的同串咬合由 unlocks.test 钉着。
 */
export interface LockedElite {
  /** unlocks.ts 的 UNLOCK_ELITE 条目 id;未解锁时运行器整条跳过 */
  unlockId: string;
  /** 解锁后归位的目标航段下标(落 [0, WAVE_SEGMENTS.length));加段/调段后运行器照下标读 */
  segmentIndex: number;
  /** 段内触发时刻(秒),与 WaveElite.at 同口径:必须 < 该段 duration */
  at: number;
  /** KIND_*;精英是普通敌型的放大版,不另开一张表 */
  kind: number;
  count: number;
  /** 词缀编号(data/affixes.ts 的 AFFIX_*);本表词缀数必须 > 既有段的 2(单测钉住) */
  affixes: number[];
}

/** 解锁精英事件槽位。当前一条(19 号首批):收尾段的"虫群母巢"。 */
export const WAVE_LOCKED_ELITES: LockedElite[] = [
  {
    // 三重词缀小Boss:狂热光环(半径内虫潮加速)× 装甲(弹药系减半)× 相位(能量系减半) ——
    // 三种减伤/增益叠在同一只上,两系塔谁都不能无脑吃它,得先清光环再集火
    unlockId: 'elite-queen',
    segmentIndex: 3, // 收尾段(虫潮合围)
    at: 70, // 占位待调(与既有精英 40/85 错开,不挤在同几秒)
    kind: KIND_BEETLE,
    count: 1,
    affixes: [0, 3, 4],
  },
];

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
