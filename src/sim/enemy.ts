/**
 * 敌人实体与行为状态机(07 号 issue T1/T3)—— 纯逻辑。
 * 铁律:本目录永不 import pixi/DOM;随机只走调用方递进来的 Rng(sim 内禁 Math.random);
 * 实体维护 px/py 供渲染层插值(存 px/py 的时机与船同口径,由 World 在推进前做)。
 *
 * 分型不用 class 继承 + 虚函数,而是"数字 kind/behavior 字段 + switch 分派":
 * Enemy 是扁平普通对象,字段在 createEnemy() 里一次性声明齐,运行期绝不新增字段
 * (新增字段会让 V8 换隐藏类,1000 敌同屏的预算下这笔钱直接写在帧时间上,GDD §13)。
 * 池的 reset 逐字段重置 —— 漏一个就会把上一条命的状态带给下一只(单测钉了全字段)。
 *
 * 本文件只产出"期望速度 + 追随系数",不积分位置、不做邻居分离、不回收尸体:那些是 World 的事。
 * 换来的是四种敌型的行为能脱开世界单测(喂一只敌人 + 一艘船就能跑完整套冲锋状态机),
 * 也保证"冲刺中不重新瞄准"这类机制只有一处实现、只需一处钉住。
 */
import type { Rng } from '../core/rng';
import { ELITE } from '../data/affixes';
import {
  BH_SEEK_CHARGE,
  BH_SPORE,
  BH_STRAFE,
  BH_STRAFE_CHARGE,
  BOSS,
  ENEMIES,
  type EnemyDef,
  KIND_BOSS,
  ZONE_HP_MULT,
} from '../data/enemies';
import { tuning } from './config';
import { DEG2RAD, type Ship, type Vec2, wrapAngle } from './ship';
import { lockCharge, seek, strafe } from './steering';

/** 接近段:按 behavior 走 seek 或 strafe */
export const ST_APPROACH = 0;
/** 前摇:刹住不动,方向已锁死,渲染层据此画预警(07 验收:前摇可读) */
export const ST_WINDUP = 1;
/** 冲刺:沿锁定方向直线全速,期间绝不重新瞄准 */
export const ST_DASH = 2;
/** 硬直:不出力,靠惯性滑出去 = 侧掠者的"啃咬后脱离" */
export const ST_RECOVER = 3;
/** 孢子炮手锚定(22 号 GDD §6.2):钉在原地,按 sporeInterval 倒计时下一轮齐射 */
export const ST_ANCHOR = 4;
/** 孢子炮手蓄力:钉在原地倒计时 sporeWarnTime,渲染层画收缩预警环,到时置位 sporeFire */
export const ST_SPORE_WINDUP = 5;

/**
 * 侧掠者起手的方位容差:绕到离目标方位(舷侧)30° 以内才允许进前摇。
 * 这条是"侧掠者确实从舷侧发起攻击、而不是退化成追尾"的机制根源(07 验收标准第一条)——
 * 去掉它 BH_STRAFE_CHARGE 就等于 BH_SEEK_CHARGE,这一型的方向压力也就没了。
 * 与 steering.ts 的 STRAFE_*_GAIN 同理:它是判据的形状而非平衡旋钮
 * (平衡旋钮是数值表里的 chargeRange / strafeOffsetDeg),故留在模块里,不进数值表。
 */
const WINDUP_BEARING_TOL = 30 * DEG2RAD;

/**
 * 计时到期的判据容差(秒)。timer 是逐帧减 dt 的浮点累减:0.2s 这种 dt 整数倍的时长
 * 减完会落在 ±1e-17 上,不兜住就会随机多出一帧。1e-9 远小于一帧(1/60 s),
 * 只吃得掉浮点残差、吃不掉真帧 —— 于是"某状态恰好持续 timer/dt 帧"严格成立,
 * 前摇时长这个最敏感的旋钮才是真可配的(单测按帧数钉)。
 */
const TIMER_EPS = 1e-9;

/**
 * 受击闪白的存续秒(畅玩性:中弹那一下闪白)。**纯表现,不进 checksum**:
 * 闪白不参与任何判定,且完全由伤害输入决定(命中即置满、逐帧线性衰减)= 派生量 ——
 * 与 animSeed 同一条"渲染只读、sim 白送"的口径;它决定不了世界的下一帧,混进哈希
 * 只会让"调一下闪白时长"看起来像一次确定性回归。占位待调
 */
export const ENEMY_HIT_FLASH = 0.08;

/** px/py = 上一逻辑帧位置(铁律 2);字段一次性声明齐,运行期不新增 */
export interface Enemy {
  x: number;
  y: number;
  px: number;
  py: number;
  vx: number;
  vy: number;
  /** EnemyKind,switch 分派用;同时是 ENEMIES 的下标与渲染层的分桶键 */
  kind: number;
  /**
   * 词缀位掩码(14 号):bit = AFFIX_*(data/affixes.ts 的编号),0 = 普通怪。
   * 精英 = affixes ≠ 0:HP/体型按 ELITE.* 放大、死亡掉 ELITE.scrapMul 倍残骸、
   * 词缀效果(狂热光环/裂变/磁力干扰/装甲/相位)按各自的位在此生效。
   * 用位掩码而不是数组:1000 敌热循环里只有按位与的判定,没有数组迭代,
   * 也保住"池 reset 逐字段清回初值"那条 Object.keys 单测的扁平口径。
   */
  affixes: number;
  hp: number;
  maxHp: number;
  /** ST_* */
  state: number;
  /** 当前状态剩余秒(ST_APPROACH 下恒为 0:接近段没有时限) */
  timer: number;
  /** 冲锋锁定方向(单位向量),进 WINDUP 那一刻写死,到 DASH 结束都不再动 */
  lockX: number;
  lockY: number;
  /** +1/-1:绕行型从左舷还是右舷切入。生成时定死 —— 每帧现选会让它在船头前来回抖 */
  side: number;
  /**
   * 渲染层程序化动画的相位种子,[0,1)。由出生位置 hash 出来,**不掷 rng**:
   * 掷 rng 会移动整条出怪随机序列("同 seed 同序列"铁律),而出生位置本身就是确定的,
   * 于是"同一局里每只怪的呼吸/摆动错开相位、且两局同 seed 相位一致"两条同时成立。
   * 不再是纯表现:sim 在视野回收(world.ts 的 ENEMY_RECYCLE_RADIUS 那段)时也读它,
   * 折出这只怪的回收落点半径/角偏 —— 每只恒定、零 rng,回收不扰动出怪序列,读档逐位一致。
   */
  animSeed: number;
  /**
   * 距下次可以再咬船一口的剩余秒(09 号 issue 的无敌帧)。
   * **每只敌人各自一份**,不是全船一个冷却:后者在蜂群贴脸时只有最先判到的那一只咬得动,
   * "一百只压上来"与"一只压上来"的掉血速率会一模一样,GDD §4.6 的挫败曲线当场作废。
   * 伤害与火花共用它(见 World 的结算):于是每只敌人每 interval 最多产出一个事件,
   * 蜂群贴脸也刷不爆 fx 池。递减在 World 的敌人循环里,与 timer 同口径逐帧减 dt。
   */
  hitCd: number;
  /** 本帧被打死,step 末尾统一回收(遍历中就地删会踩 swap-remove 的下标坑) */
  dead: boolean;
  /**
   * 受击闪白剩余秒(畅玩性)。命中即置满 ENEMY_HIT_FLASH、由 World 逐帧减 dt 夹 0,
   * 渲染层读它把剪影朝白色混合 —— "这一发打中了"在蜂群里唯一看得见的回执。
   * **纯表现字段,不进 checksum**(理由见 ENEMY_HIT_FLASH 的注释;衰减与 timer 同口径)。
   */
  hitFlash: number;
  /**
   * 最近一次实际结算的伤害(词缀抗性折算后,见 World.damageEnemy)。**不回池不生效**:
   * 只有"这一发打没打中"的两处表现出口读它 —— 直射弹的命中飘字(FXV_IMPACT)与
   * 死亡爆点飘字(FXV_KILL,reap 在回池前当场读走)。它不是逐帧演化的状态:
   * 伤害输入(amount × 抗性)一旦确定它就是确定值 = 派生量,故**不进 checksum**,
   * 与 maxHp 同一条"哈它只是把同一件事哈两遍"的口径。
   */
  lastHit: number;
  /**
   * 孢子炮手的"本帧开火"闩(22 号):状态机在蓄力到期的**那一帧**置 true,World 在敌人循环里
   * 当场读走并发射齐射、随即清回 false —— 发射弹丸是副作用,状态机(纯"期望速度 + 追随系数"
   * 契约,见文件头)不碰池,只把"该打了"这件事递出去。
   * **零 rng**:发射时刻完全由锚定后的计时器决定,不掷随机,同 seed 逐帧可复现。
   * 它是闩不是状态:同帧必然被消费,跨帧恒 false,故不进 checksum(与 lastHit 同一条"非状态"口径,
   * 但它也不是派生量 —— 它是状态机→世界的单向信号,消费即消失,重放时由同一段确定代码重建)。
   */
  sporeFire: boolean;
}

/** 池 factory:字段在这里一次性声明齐,之后只被赋值、绝不新增 */
export function createEnemy(): Enemy {
  return {
    x: 0,
    y: 0,
    px: 0,
    py: 0,
    vx: 0,
    vy: 0,
    kind: 0,
    affixes: 0,
    hp: 0,
    maxHp: 0,
    state: ST_APPROACH,
    timer: 0,
    lockX: 0,
    lockY: 0,
    side: 1,
    animSeed: 0,
    hitCd: 0,
    dead: false,
    hitFlash: 0,
    lastHit: 0,
    sporeFire: false,
  };
}

/**
 * 池 reset:每个字段都要写一遍。
 * 池里的对象是复用的,漏掉一个字段 = 新出生的敌人继承上一条命的状态
 * (最典型的是 dead 没清 → 一出生就被当尸体回收,或者 state 停在 DASH → 一出生就在冲刺)。
 * 单测按 Object.keys 逐字段比对,将来加字段忘了这里会被当场抓住。
 */
export function resetEnemy(e: Enemy): void {
  e.x = 0;
  e.y = 0;
  e.px = 0;
  e.py = 0;
  e.vx = 0;
  e.vy = 0;
  e.kind = 0;
  e.affixes = 0; // 词缀位掩码:漏清,上一只精英的效果会原样带给下一只普通怪
  e.hp = 0;
  e.maxHp = 0;
  e.state = ST_APPROACH;
  e.timer = 0;
  e.lockX = 0;
  e.lockY = 0;
  e.side = 1;
  e.animSeed = 0;
  e.hitCd = 0;
  e.dead = false;
  e.hitFlash = 0; // 漏清:上一命受击的闪白会原样带给新出生的怪,无端闪一下
  e.lastHit = 0;
  e.sporeFire = false; // 漏清:上一命的"该开火"闩会原样带给新出生的怪,凭空喷一轮
}

/**
 * 敌方 HP 的时间缩放(GDD §14):×(1 + 0.09·t分钟),再乘星区乘数(单地图 MVP 固定 ×1)。
 * 每分钟的斜率现读 tuning —— 面板拖一下就能看清"撑到第 10 分钟该有多硬"。
 * 只在出生时调用一次并把结果写进 hp/maxHp:在场的敌人不会因为时间流逝而回血变硬。
 */
export function hpScaleAt(seconds: number): number {
  return (1 + tuning.enemyHpScalePerMinute * (seconds / 60)) * ZONE_HP_MULT;
}

/**
 * 渲染层动画相位种子:把出生位置 hash 进 [0,1)。**不掷 rng** ——
 * 位置是确定的,同 seed 的两局里相位序列一字不差(铁律里"同 seed 同序列"只约束随机,
 * 这里连随机都不用碰);渲染层拿它给同型敌人错开呼吸/摆动相位。
 */
export function enemyAnimSeed(x: number, y: number): number {
  const h = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return h - Math.floor(h);
}

/**
 * 出生:池 spawn 之后由 World 调用,把一只空壳变成某型敌人。
 * @param elapsedSec 开局至今的秒数(World.elapsed),HP 时间缩放的唯一时间源
 * @param rng 世界的随机源;本函数固定消耗 1 次(side),改这里的消耗次数会移动整条随机序列
 * @param affixes 词缀位掩码(data/affixes.ts 的 AFFIX_* 编号按位),缺省 0 = 普通怪。
 *   **精英 = 非 0**:HP 当场 ×ELITE.hpMul(基础 HP × 时间缩放 × 它,与 affixes.ts 的口径逐字一致);
 *   体型放大不在这里 —— 碰撞半径问 enemyRadius(),由使用方各取所需
 */
export function initEnemy(
  e: Enemy,
  kind: number,
  x: number,
  y: number,
  elapsedSec: number,
  rng: Rng,
  affixes = 0,
): void {
  const def = ENEMIES[kind]!;
  e.x = e.px = x;
  e.y = e.py = y;
  e.vx = 0;
  e.vy = 0;
  e.kind = kind;
  e.affixes = affixes;
  e.hp = e.maxHp = def.hp * hpScaleAt(elapsedSec) * (affixes !== 0 ? ELITE.hpMul : 1);
  e.state = ST_APPROACH;
  e.timer = 0;
  e.lockX = 0;
  e.lockY = 0;
  e.side = rng.next() < 0.5 ? -1 : 1;
  e.animSeed = enemyAnimSeed(x, y);
  // 起手 0 = 一出生就能咬:出生点在船外一千多 px 的出怪环上(见 World.spawnFromWave),
  // 给它一个初始冷却只会让"生在船脸上"这类将来的出怪规则悄悄免掉第一口伤害
  e.hitCd = 0;
  e.dead = false;
  e.hitFlash = 0; // 出生姿态干净:新怪不继承上一命的闪白
  e.lastHit = 0;
  e.sporeFire = false; // 出生姿态干净:新怪不继承上一命的开火闩
}

/**
 * 裂变分裂体的出生(14 号):与 initEnemy 同源,但**一次 rng 都不掷** ——
 * side 直接继承父体(±1 的合法值现成),于是精英结算扰动不到出怪随机序列("同 seed 同序列"铁律)。
 * 分裂体 = 同型、无词缀、普通血量(不 ×ELITE.hpMul):它们是"死亡爆出来的普通怪",不是小精英。
 * 只在 World.reap 里调用,且调用方必须保证 **父体还没回池**(Pool.spawn 会对取出的对象先跑一遍
 * reset —— 池后进先出,第一只分裂体拿到的正是父体这个对象,父体先回池的话 initSplit 读到的
 * x/kind/side 就全是清零后的脏值了,见 World.reap 的顺序注释)。
 */
export function initSplit(e: Enemy, parent: Enemy, elapsedSec: number): void {
  const def = ENEMIES[parent.kind]!;
  e.x = e.px = parent.x;
  e.y = e.py = parent.y;
  e.vx = 0;
  e.vy = 0;
  e.kind = parent.kind;
  e.affixes = 0;
  e.hp = e.maxHp = def.hp * hpScaleAt(elapsedSec);
  e.state = ST_APPROACH;
  e.timer = 0;
  e.lockX = 0;
  e.lockY = 0;
  e.side = parent.side;
  e.animSeed = enemyAnimSeed(parent.x, parent.y);
  e.hitCd = 0;
  e.dead = false;
  e.hitFlash = 0; // 分裂体与父体同一帧出生,不带父体的闪白
  e.lastHit = 0;
  e.sporeFire = false; // 分裂体只继承父体的位置/型号/side,不继承开火闩
}

/**
 * 词缀编号数组(WaveElite.affixes)→ 位掩码。**undefined = 普通怪**(waves.ts 的 SpawnSink
 * 口径),普通流/压测路径不调本函数。只做按位换算,不认识词缀语义。
 */
export function affixMask(affixes: readonly number[] | undefined): number {
  if (affixes === undefined) return 0;
  let m = 0;
  for (let i = 0; i < affixes.length; i++) m |= 1 << affixes[i]!;
  return m;
}

/** 这一只带不带某个词缀(位掩码判定;affixId = data/affixes.ts 的 AFFIX_*) */
export function hasAffix(e: Enemy, affixId: number): boolean {
  return (e.affixes & (1 << affixId)) !== 0;
}

/**
 * 敌人体型碰撞半径(14 号):精英 = 基础半径 × ELITE.scale(体型放大),
 * 普通怪 = 基础半径。**碰撞半径的唯一口径** —— 接触粗筛、受击判定、子弹命中全走它,
 * 别处再抄一遍 `ENEMIES[kind].radius` 就会让精英的判定体与画出来的剪影错位。
 * ELITE.scale 是数据表里的占位(affixes.ts),改平衡只改那里。
 */
export function enemyRadius(e: Enemy): number {
  // Boss(15 号)不进 ENEMIES 表:判定体走底座 radius × BOSS.scale,与 boss.ts 的
  // bossRadius() 同一条口径(子弹命中/受击判定统一走这里,Boss 才能被弹道塔打到)。
  if (e.kind === KIND_BOSS) return ENEMIES[BOSS.baseKind]!.radius * BOSS.scale;
  const r = ENEMIES[e.kind]!.radius;
  return e.affixes !== 0 ? r * ELITE.scale : r;
}

/**
 * 冲锋起手距离:精英按体型放大(ELITE.scale —— 体型放大后起手圈跟着大,
 * 否则"射程内才起手"对一只 1.5× 的甲虫名不副实;起手圈变远也让放大体型的前摇
 * 预警来得更早,14 号"放大体型下前摇仍肉眼可读"验收的几何来源)。
 */
function chargeRangeOf(e: Enemy, def: EnemyDef): number {
  return e.affixes !== 0 ? def.chargeRange * ELITE.scale : def.chargeRange;
}

/**
 * 够不够格起手前摇。不冲锋的型永远 false —— 它们的冲锋参数全是 0,
 * 放进来就会以"射程 0"起手,渲染层的前摇指示也会对着永不冲锋的敌人闪。
 */
function shouldWindup(e: Enemy, def: EnemyDef, ship: Ship): boolean {
  const charges = def.behavior === BH_SEEK_CHARGE || def.behavior === BH_STRAFE_CHARGE;
  if (!charges) return false;

  const dx = e.x - ship.x;
  const dy = e.y - ship.y;
  const range = chargeRangeOf(e, def);
  if (dx * dx + dy * dy > range * range) return false;
  if (def.behavior === BH_SEEK_CHARGE) return true;

  // 绕行型还得先真绕到位:方位没对就只是"路过射程",这一票否决才让它从舷侧起手
  const targetBearing = ship.heading + def.strafeOffsetDeg * DEG2RAD * e.side;
  const angErr = wrapAngle(targetBearing - Math.atan2(dy, dx));
  return Math.abs(angErr) < WINDUP_BEARING_TOL;
}

/**
 * 船距孢子炮手是否在射程带之外(22 号):> sporeRange = 太远(玩家逃了),
 * < sporeMinRange = 贴脸(玩家冲进来了)。带本身自带迟滞:在带内锚定时,
 * 船在带边缘小幅漂移不会让它反复起锚 —— "保持距离带"的机制全部来源,
 * 锚定/蓄力两态都靠它决定"要不要放弃当前姿态回去重新就位"。
 */
function sporeOutOfBand(e: Enemy, ship: Ship, def: EnemyDef): boolean {
  const dx = e.x - ship.x;
  const dy = e.y - ship.y;
  const d2 = dx * dx + dy * dy;
  const hi = def.sporeRange * def.sporeRange;
  if (d2 > hi) return true;
  const lo = def.sporeMinRange * def.sporeMinRange;
  return d2 < lo;
}

/**
 * 孢子的接近段寻路:太远朝船压、贴脸背船退 —— 就是"距离带"在速度上的样子。
 * 带内永远走不到这一支(进带当帧就转锚定),兜底朝船走只是防坏数据的护栏,不是另一种行为。
 */
function sporeSeek(e: Enemy, ship: Ship, def: EnemyDef, speed: number, out: Vec2): void {
  const dx = ship.x - e.x;
  const dy = ship.y - e.y;
  const dist = Math.hypot(dx, dy) || 1;
  const away = dist < def.sporeMinRange ? -1 : 1;
  out.x = (dx / dist) * speed * away;
  out.y = (dy / dist) * speed * away;
}

/**
 * 推进一只敌人的行为一帧:把期望速度写进 out,返回追随系数 follow ∈ (0, 1]。
 * 调用方(World)负责 `v += (desired - v) * follow` 与积分位置 —— 本函数不碰位置。
 *
 * 顺序:先推进计时器并处理到期转移,再按(可能刚更新的)状态出速度。
 * 到期那一帧当场按新状态出力,不空转一帧;而刚进入某状态的那一帧不扣计时
 * (进入时才刚设上 timer),于是"某状态恰好持续 timer/dt 帧"严格成立。
 *
 * 速度一律现乘 tuning.enemySpeedScale、每帧现读(与 stepShip 同口径):
 * 缓存进局部常量就得重启才生效,面板拖动看虫潮快慢的用法会失效。
 */
export function stepEnemyBehavior(e: Enemy, ship: Ship, dt: number, out: Vec2): number {
  const def = ENEMIES[e.kind]!;
  const isSpore = def.behavior === BH_SPORE;

  switch (e.state) {
    case ST_WINDUP:
      e.timer -= dt;
      if (e.timer <= TIMER_EPS) {
        e.state = ST_DASH;
        e.timer = def.chargeDuration;
      }
      break;
    case ST_DASH:
      e.timer -= dt;
      if (e.timer <= TIMER_EPS) {
        e.state = ST_RECOVER;
        e.timer = def.chargeRecover;
      }
      break;
    case ST_RECOVER:
      e.timer -= dt;
      if (e.timer <= TIMER_EPS) {
        e.state = ST_APPROACH;
        e.timer = 0;
      }
      break;
    case ST_ANCHOR:
      // 锚定中玩家逃出射程带:放弃锚定回去重新就位(太远就追、贴脸就退 —— 见 sporeSeek)
      if (sporeOutOfBand(e, ship, def)) {
        e.state = ST_APPROACH;
        e.timer = 0;
        break;
      }
      e.timer -= dt;
      if (e.timer <= TIMER_EPS) {
        e.state = ST_SPORE_WINDUP;
        e.timer = def.sporeWarnTime;
      }
      break;
    case ST_SPORE_WINDUP:
      // 蓄力中玩家逃出射程带:这一轮当场取消 —— "预警 = 即将发生的事"这条承诺
      // 只对仍然成立的情形有效,对着打不到人的方向把预警演完是浪费
      if (sporeOutOfBand(e, ship, def)) {
        e.state = ST_APPROACH;
        e.timer = 0;
        break;
      }
      e.timer -= dt;
      if (e.timer <= TIMER_EPS) {
        e.state = ST_ANCHOR;
        e.timer = def.sporeInterval;
        e.sporeFire = true; // 闩:世界侧读它发射齐射(发射是副作用,见 sporeFire 字段注释)
      }
      break;
    default:
      if (isSpore) {
        // 孢子的接近段没有"冲锋起手"这回事:只看距离带,进带即锚定
        if (!sporeOutOfBand(e, ship, def)) {
          e.state = ST_ANCHOR;
          e.timer = def.sporeInterval;
        }
        break;
      }
      // 接近段没有时限,只看条件够不够起手。方向在这一刻一次性锁死:
      // 之后无论船怎么跑,冲刺都只沿这条线走 —— 这是玩家躲得掉的唯一依据。
      // 借 out 当暂存:下面 WINDUP 分支会把它覆盖成零向量,不多占一个模块级 Vec2。
      if (shouldWindup(e, def, ship)) {
        lockCharge(e.x, e.y, ship.x, ship.y, out);
        e.lockX = out.x;
        e.lockY = out.y;
        e.state = ST_WINDUP;
        e.timer = def.chargeWindup;
      }
      break;
  }

  switch (e.state) {
    case ST_WINDUP:
      // 刹住:期望速度归零 + 双倍追随系数,肉眼看得出"停下来蓄力"这个停顿
      out.x = 0;
      out.y = 0;
      return Math.min(1, def.accel * dt * 2);
    case ST_DASH: {
      // 沿锁定方向直线全速。这里绝不重新读 ship 的位置 ——
      // 任何"冲刺中微调"都会让前摇预警变成谎言,07 验收标准第二条当场作废。
      const sp = def.chargeSpeed * tuning.enemySpeedScale;
      out.x = e.lockX * sp;
      out.y = e.lockY * sp;
      return 1; // 瞬时到速:冲刺要"弹出去",而不是慢慢加速
    }
    case ST_RECOVER:
      // 不出力,靠惯性滑出去(半速追随 = 减速比前摇慢一倍),这就是"啃咬后脱离"
      out.x = 0;
      out.y = 0;
      return Math.min(1, def.accel * dt * 0.5);
    case ST_ANCHOR:
    case ST_SPORE_WINDUP:
      // 锚定/蓄力:钉在原地(期望速度归零 + 双倍追随系数),与冲锋前摇同一档"停得住"的手感
      out.x = 0;
      out.y = 0;
      return Math.min(1, def.accel * dt * 2);
    default: {
      const speed = def.speed * tuning.enemySpeedScale;
      if (isSpore) {
        sporeSeek(e, ship, def, speed, out);
      } else if (def.behavior === BH_STRAFE || def.behavior === BH_STRAFE_CHARGE) {
        // offsetRad 带上 e.side:同一型的两半分别从左右舷压过来,不会挤成一条线
        const offsetRad = def.strafeOffsetDeg * DEG2RAD * e.side;
        strafe(e.x, e.y, ship.x, ship.y, ship.heading, offsetRad, def.strafeRadius, speed, out);
      } else {
        seek(e.x, e.y, ship.x, ship.y, speed, out);
      }
      return Math.min(1, def.accel * dt);
    }
  }
}

/**
 * 扣血。05 号 issue 的塔经 World.damageEnemy 调进来,是全仓唯一的伤害入口。
 * @returns 本次是否致死。已经 dead 直接 false —— 同一帧多颗子弹同时命中只算一次死亡,
 *   否则 10 号 issue 的掉落挂钩会按命中数重复给残骸、kills 也会虚高。
 *   真正的回收与掉落在 step 末尾统一做,调用方不需要知道下标。
 */
export function applyDamage(e: Enemy, amount: number): boolean {
  if (e.dead) return false;
  e.hp -= amount;
  // 受击闪白(畅玩性):只要这一发真的扣了血(抗性折算后可能归零)就亮起,
  // 致死的那一发也照置 —— 尸体当帧就被 reap 回收,闪不闪得到由渲染层自己判断。
  // 置满而不是叠加:连续命中就是整段 0.08s 的重置,不追求"闪得更久"
  if (amount > 0) e.hitFlash = ENEMY_HIT_FLASH;
  if (e.hp > 0) return false;
  e.hp = 0; // 夹到 0:血条/HUD 不必各自再兜一次负数
  e.dead = true;
  return true;
}
