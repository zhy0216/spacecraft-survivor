/**
 * 敌方弹丸实体与推进(孢子炮手 GDD §6.2)—— 纯逻辑。
 * 铁律 1:本目录永不 import pixi/DOM,也不用 Math.random —— 弹丸是"速度 × dt"的确定性积分,
 *   命中判据是"船体受击圆 + 弹丸半径"的圆判定(sim/damage 的 shipRadius 唯一口径),
 *   同 seed 必然复现。
 * 铁律 2:每颗弹丸维护 px/py = 上一逻辑帧位置,渲染层按 alpha 插值(与 my 子弹同口径)。
 * 铁律 3:弹丸是对象池里的普通对象,字段在 createEnemyBullet 里一次性声明齐、运行期绝不新增。
 *
 * 与我方子弹(sim/bullet.ts)的分工是方向上的镜像:那边是"我方弹道 → 打敌人",
 * 这边是"敌方弹道 → 打船"。差异只有两处:
 *   一、目标判定不查空间哈希(敌人少、船只有一艘):直接对船体受击圆做判定 ——
 *       **没有核心/擦碰分层**(改版 09 号:甲板三层判定随网格删除,命中即真掉血);
 *   二、伤害入口是 world.damageShip —— 09 号在注释里预留的"敌方弹幕伤害接口",
 *       实际结算量 = 弹丸伤害 × 支援聚合的 damageTakenMul(sim/damage 的 hullDamageTaken)。
 *
 * 本文件对世界只有一条**类型**依赖(EnemyBulletSink):扣血与记可视化事件全经那份契约,
 * 于是它能脱开整个世界单测(一个记账用的假 sink 就能钉住全部命中规则),
 * 也不会与 world 连成运行期循环依赖(与 sim/bullet.ts 的 FireSink 同一条理由)。
 */
import type { Pool } from '../core/pool';
import { shipRadius } from './damage';
import { tuning } from './config';
import { type Ship } from './ship';

/**
 * 到期判据的容差(秒),与 bullet.ts 的 LIFE_EPS 一字同源:
 * life 是逐帧减 dt 的浮点累减,life = k × dt 这种整数帧的时长减完会落在 ±1e-17 上,
 * 不兜住就会随机多飞一帧 —— "射程 / 弹速 秒之后一定消失"这条口径于是不再是硬的。
 */
const LIFE_EPS = 1e-9;

/**
 * 在场弹丸上限(保险丝,与 WAVE_MAX_ALIVE / DROP_MAX_ALIVE 同一条口径):
 * 正常脚本下孢子炮手在场个位数、每轮齐射 3 发,全场稳定在 30 发以内;触顶只是丢弃新弹,
 * 不留账 —— 留账的话上限一解除就会一口气吐出来。它是给"数据写坏/将来新远程型"的栏杆,
 * 不是平衡旋钮。1000 敌同屏的预算里,弹丸按粒子渲染,这个量级对 GPU 完全无感。
 */
export const ENEMY_BULLET_MAX_ALIVE = 200;

/** px/py = 上一逻辑帧位置(铁律 2);字段一次性声明齐,运行期不新增 */
export interface EnemyBullet {
  x: number;
  y: number;
  px: number;
  py: number;
  vx: number;
  vy: number;
  /**
   * 来源敌型(KIND_*):现在恒 KIND_SPORE,渲染层据此取 enemyTint 配色。
   * 将来新的远程敌型直接换号,渲染层一行都不用改(与 Bullet.towerType 同一条口径)。
   */
  kind: number;
  /** 单发伤害。**发射那一刻定死,飞行途中不回查敌人**(与 Bullet.damage 同口径) */
  damage: number;
  /**
   * 剩余存活秒 = **射程上限的唯一表达**(life = 射程 / 弹速,由开火方算好写进来)。
   * 与我方子弹同一条口径:时间是路程的度量,还顺带把"飞出世界边界"一并管了。
   */
  life: number;
  /** 弹丸碰撞半径(渲染层画多大一个点的依据,判定时与船体受击圆相加) */
  radius: number;
}

/** 池 factory:字段在这里一次性声明齐,之后只被赋值、绝不新增 */
export function createEnemyBullet(): EnemyBullet {
  return {
    x: 0,
    y: 0,
    px: 0,
    py: 0,
    vx: 0,
    vy: 0,
    kind: 0,
    damage: 0,
    life: 0,
    radius: 0,
  };
}

/**
 * 池 reset:**逐字段清**,与 resetBullet 同口径。
 * 漏一个,下一发就会继承上一发的状态 —— 最典型的是 life 没清,一颗刚出膛的弹立刻到期消失。
 */
export function resetEnemyBullet(b: EnemyBullet): void {
  b.x = 0;
  b.y = 0;
  b.px = 0;
  b.py = 0;
  b.vx = 0;
  b.vy = 0;
  b.kind = 0;
  b.damage = 0;
  b.life = 0;
  b.radius = 0;
}

/**
 * 开火的去处(与 sim/fx.ts 的 FireSink 同一条写法):弹丸命中只问"船掉血 + 记事件"一件事,
 * 实现方(World)负责 damageShip 的减伤(支援聚合的 damageTakenMul)与 FxEvent 的具体填法。
 */
export interface EnemyBulletSink {
  /**
   * 弹丸进船体受击圆 = 真掉血。实现方必须走 world.damageShip(09 号预留的敌方弹幕伤害入口),
   * 并按 settleHullDamage 同款口径推 FXV_HULL_HIT(飘字 = 实际结算伤害)。
   * @param x @param y 命中点世界坐标(飘字/爆炸表现画在哪,不再参与判定 —— 四舷已删)
   */
  hullHit(x: number, y: number, damage: number): void;
}

/**
 * 推进全场敌方弹丸一逻辑帧:积分 → 船体受击圆判定 → 回池。
 * @param sink 弹丸的去处(World 实现):本函数经它扣血、记事件,不认识世界的内部结构
 *
 * **倒序遍历**:命中与到期都要当场回收,而 pool 的 despawnAt 是 swap-remove ——
 * 正序时被顶上来的那颗会跳过当前下标而漏检(与 stepBullets 同一条口径)。
 *
 * **先判命中再判到期**(与 stepBullets 一字同源):这一帧的位移正是它飞完的最后一段,
 * 那段里撞上船的人不该白撞 —— 射程边界上的弹丸恰好该在边界上炸响。
 *
 * 全程零 rng、零分配:命中完全由"船位姿 + 弹丸位置"决定(受击圆半径现读 tuning)。
 */
export function stepEnemyBullets(
  pool: Pool<EnemyBullet>,
  dt: number,
  ship: Ship,
  sink: EnemyBulletSink,
): void {
  const items = pool.items;
  // 受击圆半径 = 船体半长 + 弹丸体型:弹丸的判定体与敌人接触粗筛同一条口径(damage.shipRadius),
  // 判定圆的大小**由命中那一帧的弹丸半径**定,故 hoist 出循环的是船的那一半
  const hullR = shipRadius(tuning.shipLength);
  for (let i = items.length - 1; i >= 0; i--) {
    const b = items[i]!;
    // 先存上一帧位置再积分(与 my 子弹、敌人循环同口径):渲染插值的两端由此成立
    b.px = b.x;
    b.py = b.y;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;

    // 圆命中判定(含边界):圆心距 ≤ 船体受击半径 + 弹丸半径 = 打上船了。
    // 旧版"先判核心后判轮廓"的三层几何随甲板删除 —— 命中即真掉血,没有擦碰层。
    const dx = b.x - ship.x;
    const dy = b.y - ship.y;
    const hitR = hullR + b.radius;
    if (dx * dx + dy * dy <= hitR * hitR) {
      sink.hullHit(b.x, b.y, b.damage);
      pool.despawnAt(i); // 命中即消失:弹丸不是穿透物,炸在船身上
      continue;
    }
    if (b.life <= LIFE_EPS) pool.despawnAt(i);
  }
}
