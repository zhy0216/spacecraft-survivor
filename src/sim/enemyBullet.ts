/**
 * 敌方弹丸实体与推进(孢子炮手 GDD §6.2)—— 纯逻辑。
 * 铁律 1:本目录永不 import pixi/DOM,也不用 Math.random —— 弹丸是"速度 × dt"的确定性积分,
 *   命中判据是 damage.ts 的 classifyHit(与敌人接触结算共用同一份几何),同 seed 必然复现。
 * 铁律 2:每颗弹丸维护 px/py = 上一逻辑帧位置,渲染层按 alpha 插值(与 my 子弹同口径)。
 * 铁律 3:弹丸是对象池里的普通对象,字段在 createEnemyBullet 里一次性声明齐、运行期绝不新增。
 *
 * 与我方子弹(sim/bullet.ts)的分工是方向上的镜像:那边是"我方弹道 → 打敌人",
 * 这边是"敌方弹道 → 打船"。差异只有两处:
 *   一、目标判定不查空间哈希(敌人少、船只有一艘):直接对船体做 damage.ts 的三层判定
 *       (核心区真掉血 / 甲板轮廓只出火花 / 没碰上),与 settleHullDamage 的敌人接触同一套语义;
 *   二、伤害入口是 world.damageShip —— 09 号在注释里预留的"敌方弹幕伤害接口"今天第一次被真正使用。
 *
 * 本文件对世界只有一条**类型**依赖(EnemyBulletSink):扣血与记可视化事件全经那份契约,
 * 于是它能脱开整个世界单测(一个记账用的假 sink 就能钉住全部命中规则),
 * 也不会与 world 连成运行期循环依赖(与 sim/bullet.ts 的 FireSink 同一条理由)。
 */
import type { Pool } from '../core/pool';
import { classifyHit, HIT_CORE, HIT_GRAZE } from './damage';
import type { Deck } from './deck';
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
  /** 弹丸碰撞半径(渲染层画多大一个点的依据,判定时与船体判定区相加) */
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
 * 开火的去处(与 sim/fx.ts 的 FireSink 同一条写法):弹丸命中只问"船掉血 + 记事件"两件事,
 * 实现方(World)负责 damageShip 的舷向减伤/受击惩罚与 FxEvent 的具体填法。
 */
export interface EnemyBulletSink {
  /**
   * 弹丸进核心区 = 真掉血。实现方必须走 world.damageShip(09 号预留的敌方弹幕伤害入口),
   * 并按 settleHullDamage 同款口径推 FXV_HULL_HIT(飘字 = 实际结算伤害)。
   * @param x @param y 命中点世界坐标(撞的是哪一舷由它相对船头的方位角定)
   */
  hullHit(x: number, y: number, damage: number): void;
  /** 蹭到核心区之外的甲板:只出火花,一分血都不结算(GDD §4.4,与敌人接触同口径) */
  graze(x: number, y: number): void;
}

/**
 * 推进全场敌方弹丸一逻辑帧:积分 → 船体判定 → 回池。
 * @param sink 弹丸的去处(World 实现):本函数经它扣血、记事件,不认识世界的内部结构
 *
 * **倒序遍历**:命中与到期都要当场回收,而 pool 的 despawnAt 是 swap-remove ——
 * 正序时被顶上来的那颗会跳过当前下标而漏检(与 stepBullets 同一条口径)。
 *
 * **先判命中再判到期**(与 stepBullets 一字同源):这一帧的位移正是它飞完的最后一段,
 * 那段里撞上船的人不该白撞 —— 射程边界上的弹丸恰好该在边界上炸响。
 *
 * **擦边(甲板轮廓)只出火花、弹丸继续飞**:甲板轮廓是"接触"模型的概念 —— 敌人在甲板上
 * 蹭着是擦碰,弹丸从轮廓上空掠过不该被拦下;若擦边即消失,瞄着船心的齐射会在进核心区
 * 之前(轮廓恒包住核心区)全部白给,远程威胁整个失效。火花只在**进入**轮廓的那一帧响一次
 * (用上一帧的判定结果做边沿检测,零额外状态),读作"这一发擦着甲板过去了"。
 *
 * 全程零 rng、零分配:命中取哪一层完全由"船位姿 + 甲板 + 弹丸位置"决定。
 */
export function stepEnemyBullets(
  pool: Pool<EnemyBullet>,
  dt: number,
  ship: Ship,
  deck: Deck,
  sink: EnemyBulletSink,
): void {
  const items = pool.items;
  for (let i = items.length - 1; i >= 0; i--) {
    const b = items[i]!;
    // 先存上一帧位置再积分(与 my 子弹、敌人循环同口径):渲染插值的两端由此成立
    b.px = b.x;
    b.py = b.y;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;

    // 船体三层判定(核心区 / 甲板轮廓 / 没碰上),与敌人接触结算共用同一份几何。
    // 判定体 = 弹丸半径 + 船体判定区(核心恒按初始 3×4,扩建不把船变成更大的靶子,GDD §4.4)
    const hit = classifyHit(ship, deck, b.x, b.y, b.radius);
    if (hit === HIT_CORE) {
      sink.hullHit(b.x, b.y, b.damage);
      pool.despawnAt(i); // 命中即消失:弹丸不是穿透物,炸在船身上
      continue;
    }
    if (hit === HIT_GRAZE) {
      // 只在"上一帧还没擦、这一帧擦上"的边沿响一次火花,然后继续飞(理由见函数头)
      if (classifyHit(ship, deck, b.px, b.py, b.radius) !== HIT_GRAZE) {
        sink.graze(b.x, b.y);
      }
      continue;
    }
    if (b.life <= LIFE_EPS) pool.despawnAt(i);
  }
}
