/**
 * 开火的可视化事件与"开火的去处"契约(05 号 issue T1)—— sim 与 world / 渲染之间**唯一的那道缝**。
 * 铁律 1:本目录永不 import pixi/DOM。本文件连一行逻辑都没有,只有一个数据对象和一个接口 ——
 *   它存在的全部意义就是让 sim/turret.ts、sim/bullet.ts **不必 import world**:
 *   开火要往世界里放子弹、扣血、查邻居,而世界要调用炮管 —— 双向直连就是一个运行期循环依赖,
 *   在 ESM 里表现为"某一侧拿到 undefined",且只在改了 import 顺序时才炸。
 *   于是反过来:World 实现 FireSink,开火侧只 `import type` 这份契约(类型 import 编译后整条消失)。
 * 铁律 3:FxEvent 是对象池里的普通对象,创建与清零分成两个纯函数交给 Pool ——
 *   500 弹同屏的那一帧里,每次开火都 new 一个事件对象就是直接写在 GC 停顿上。
 *
 * FxEvent **纯表现,一律不进 checksum**:它不参与任何判定,少画一条闪电不改变世界的下一帧;
 * 混进哈希只会让"渲染改一下淡出时长"看起来像确定性回归。同理它**不做插值**(最多差一逻辑帧)。
 * 坐标一律**世界坐标**(不是甲板局部坐标):链电与磁轨的终点本就在船外,局部系表达不了。
 */
import type { DeckCell } from './deck';
import type { Enemy } from './enemy';
import type { Bullet } from './bullet';

// —— 可视化种类。与 data/towers 的 FX_* 分开编号:那是"塔怎么结算",这是"屏幕上画什么" ——
// 一次开火可能推多个事件(链电逐跳一条),两套编号绑死反而会逼出一堆特例。
export const FXV_BEAM = 0; // 细实线常亮:激光的一次伤害 tick
export const FXV_CHAIN = 1; // 逐跳折线:电弧的一跳
export const FXV_LANCE = 2; // 粗光柱:磁轨的一次贯穿
export const FXV_BLAST = 3; // 圆环:迫击炮落点的一次 AoE
export const FXV_MUZZLE = 4; // 炮口闪:真子弹类塔开火时的短促提示

/**
 * 一次开火/命中的可视化事件。字段全是扁平数字(照 Enemy/Bullet 的口径),
 * 由 World 每帧递减 life、≤0 倒序 swap-remove 回池。
 */
export interface FxEvent {
  /** FXV_* */
  kind: number;
  /** 起点(炮口) */
  x0: number;
  y0: number;
  /** 终点(命中点)。FXV_BLAST 时 = 爆心,与 x0/y0 相同 */
  x1: number;
  y1: number;
  /** FXV_BLAST 的 AoE 半径,其余种类恒 0 */
  radius: number;
  /** 来源塔型(TOWER_*):渲染层据此取 def.tint 选色,不必再回查是谁打的 */
  towerType: number;
  /** 剩余存续秒。初值取 data/towers 的 FX_LIFE_*,由 World 每帧扣 dt */
  life: number;
}

/** 池的 factory:字段一次性声明齐,运行期绝不新增 */
export function createFxEvent(): FxEvent {
  return { kind: 0, x0: 0, y0: 0, x1: 0, y1: 0, radius: 0, towerType: 0, life: 0 };
}

/**
 * 池的 reset:**逐字段清**。漏一个,下一次复用就会把上一发的坐标/半径带进来,
 * 表现为"某条闪电偶尔从上一次的位置起手" —— 这类 bug 只在池被压满时才出现,最难查。
 */
export function resetFxEvent(e: FxEvent): void {
  e.kind = 0;
  e.x0 = 0;
  e.y0 = 0;
  e.x1 = 0;
  e.y1 = 0;
  e.radius = 0;
  e.towerType = 0;
  e.life = 0;
}

/**
 * 开火的去处。**World 实现它**;sim/turret.ts 与 sim/bullet.ts 只 `import type` 本接口,
 * 于是它们能脱开整个世界单测(给一个记账用的假 sink,就能断言"这一发打了谁、扣了多少")。
 *
 * 五个方法就是开火需要世界配合的全部,多一个都不给:
 * 再加一个"读世界状态"的方法,开火逻辑就会开始依赖世界的内部结构,拆分也就白拆了。
 */
export interface FireSink {
  /** 从池里取一颗**已清零**的子弹,调用方当场把字段填满(池不认识弹道,填不满是调用方的错) */
  spawnBullet(): Bullet;
  /** 唯一伤害入口 = World.damageEnemy。@returns 本次是否致死 */
  damage(e: Enemy, amount: number): boolean;
  /** 记一次可视化事件(坐标一律世界坐标) */
  fx(
    kind: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    radius: number,
    towerType: number,
  ): void;
  /** 邻域查询(复用 World 的空间哈希,绝不线性扫全场),结果写进 out */
  query(x: number, y: number, r: number, out: Enemy[]): void;
  /** 记一次开火:broadside(单舷 ≥3 塔同帧开火)统计的唯一入口 */
  fired(cell: DeckCell): void;
}
