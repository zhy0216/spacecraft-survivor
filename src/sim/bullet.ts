/**
 * 子弹实体与推进(05 号 issue T3)—— 真子弹,纯逻辑。
 * 铁律 1:本目录永不 import pixi/DOM,也不用 Math.random —— 弹道全是"速度 × dt"的确定性积分,
 *   命中取哪一只由**距离 + 候选顺序**定死(与 arc.ts 的 findArcTarget 一字同源),同 seed 必然复现。
 * 铁律 2:每颗弹维护 px/py = 上一逻辑帧位置,渲染层按 alpha 在两点间插值 ——
 *   子弹是全场跑得最快的东西,不插值的话 60Hz 的逻辑帧在 144Hz 屏上就是一串顿挫的虚线。
 * 铁律 3:子弹是对象池里的普通对象,字段在 createBullet 里一次性声明齐、运行期绝不新增;
 *   邻域查询的暂存是**模块级复用数组**,回收走倒序 swap-remove ——
 *   "500 弹同屏不掉帧"(05 验收标准第四条)靠的就是这一帧里一次分配都没有。
 *
 * 本文件对世界只有一条**类型**依赖(FireSink):扣血、查邻居、记可视化事件全经那份契约,
 * 于是它能脱开整个世界单测(见 bullet.test.ts:一个记账用的假 sink 就能钉住全部命中规则),
 * 也不会与 world 连成运行期循环依赖(理由见 sim/fx.ts 的文件头)。
 *
 * 两类弹的分工就是 GDD §5.2 里两座塔的定位差别,故做成 kind 字段 + 两条分支而不是两个池:
 *   BK_DIRECT 直射弹:逐帧碰撞、可穿透 —— 机炮与点防的弹丸;
 *   BK_MORTAR 抛射弹:**途中一概不碰撞**(越过前排正是迫击炮的定位),到期在落点炸一片。
 * 伤害在**发射那一刻定死**写进 b.damage,飞行途中绝不回查塔:塔升级、塔被 12 号焊成内脏位、
 * 甚至那一格被拆掉,都不该改变已经出膛的那一发 —— 也省掉了"子弹持有塔引用"这条生命周期噩梦。
 */
import type { Pool } from '../core/pool';
import { ELITE } from '../data/affixes';
import { ENEMIES, ENEMY_RADIUS_MAX, KIND_BOSS } from '../data/enemies';
import { type Enemy, enemyRadius } from './enemy';
import { type FireSink, FXV_BLAST, FXV_IMPACT } from './fx';

/** 直射弹:飞行途中逐帧碰撞,穿透次数用光即回收 */
export const BK_DIRECT = 0;
/** 抛射弹:途中不碰撞(越过前排),life 走完在落点炸 AoE */
export const BK_MORTAR = 1;

/**
 * 穿透之后把弹丸推出敌人判定圆时多送的那一点距离(px)。
 * 不加它,弹丸会**恰好**停在 d = r 的边界上,而命中判据含边界(d² ≤ r²,与 findArcTarget
 * "恰好落在射程圆上算打得到"同口径)—— 下一帧那只敌人只要没动,就会被同一颗弹再打一次。
 * 取 1e-3 px:小到肉眼与手感都察觉不到,大到浮点残差(1e-13 量级)绝对吃不掉。
 */
const PIERCE_CLEAR_EPS = 1e-3;

/**
 * 到期判据的容差(秒),与 enemy.ts 的 TIMER_EPS、tower.ts 的 THROTTLE_EPS 一字同源:
 * life 是逐帧减 dt 的浮点累减,life = k × dt 这种整数帧的时长减完会落在 ±1e-17 上,
 * 不兜住就会随机多飞一帧 —— "射程 / 弹速 秒之后一定消失"这条口径于是不再是硬的,
 * 按帧数写的单测也会随机变红。1e-9 秒 × 最快的弹速也不到 1e-6 px,吃不掉任何真实距离。
 */
const LIFE_EPS = 1e-9;

/**
 * 邻域查询的暂存,全体子弹共享一份。模块级复用而不是每颗现造:500 弹 × 60Hz 下,
 * 循环里 new 一个数组就是每秒三万次分配,直接写在 GC 停顿上(铁律 3,与 turret.ts 的 candidates 同写法)。
 * **只在一次调用内有效**、绝不跨帧持有 —— 里面装的是池中对象,敌人一回收,
 * 同一个对象下一帧就变成了另一只(见 core/pool 的口径),故 stepBullets 出门前清空。
 */
const scratch: Enemy[] = [];

/** px/py = 上一逻辑帧位置(铁律 2);字段一次性声明齐,运行期不新增 */
export interface Bullet {
  x: number;
  y: number;
  px: number;
  py: number;
  vx: number;
  vy: number;
  /** BK_*,switch 分派用 */
  kind: number;
  /** 单次命中的伤害。**发射那一刻定死,不回查塔**(见文件头) */
  damage: number;
  /**
   * 剩余存活秒 = **射程上限的唯一表达**(life = 射程 / 弹速,由开火方算好写进来)。
   * 不存"出膛点 + 射程"再逐帧量距离:那是每帧一次开方,而且转向弹(将来的追踪弹)一动就不成立;
   * 时间则天然是路程的度量,还顺带把"飞出世界边界"这件事一并管了。
   */
  life: number;
  /** 剩余可穿透次数;命中时 >0 则 -1 穿过去,== 0 则回收 */
  pierce: number;
  /** 弹丸碰撞半径(与敌人 def.radius 相加后判定);同时是渲染层画多大一个点的依据 */
  radius: number;
  /** BK_MORTAR 落点 AoE 的半径与伤害;BK_DIRECT 恒 0(填 0 的口径见 data/towers 文件头) */
  aoeRadius: number;
  aoeDamage: number;
  /** 来源塔型(TOWER_*):渲染层据此选纹理/色,09/10 号 issue 的伤害归因也认它 */
  towerType: number;
  /**
   * 来源塔的节流系(THR_*):伤害结算处(World.damageEnemy)的词缀抗性判定认它 ——
   * 装甲抗弹药系、相位抗能量系(14 号)。**发射那一刻定死**,与 damage 同一条口径:
   * 塔被拆掉也不该改变已经出膛的这一发的"伤害类型"。
   */
  throttle: number;
  /**
   * 点防拦截弹标记(22 号):true = 这颗弹只认敌方弹丸、**绝不命中敌人**(见 hitDirect 的分支)。
   * 拦截是点防的第二职责,拦截弹若半路被虫群吃掉,"击落弹幕"这条承诺就形同虚设;
   * 且它与普通弹共用池,不挂标记的话 stepInterceptHits 会把每一颗普通弹都拿去比弹丸。
   * 发射那一刻定死;普通开火路径恒 false(reset 清回)。
   */
  intercept: boolean;
}

/** 池 factory:字段在这里一次性声明齐,之后只被赋值、绝不新增 */
export function createBullet(): Bullet {
  return {
    x: 0,
    y: 0,
    px: 0,
    py: 0,
    vx: 0,
    vy: 0,
    kind: BK_DIRECT,
    damage: 0,
    life: 0,
    pierce: 0,
    radius: 0,
    aoeRadius: 0,
    aoeDamage: 0,
    towerType: 0,
    throttle: 0, // 0 = THR_AMMO(机炮系);直射弹与抛射弹都只在开火时被覆写
    intercept: false,
  };
}

/**
 * 池 reset:**逐字段清**,与 resetEnemy 同口径。
 * 漏一个,下一发就会继承上一发的状态 —— 最典型的是 aoeRadius 没清,一颗机炮直射弹到期时
 * 突然在落点炸一片;或者 pierce 没清,某发弹莫名其妙能穿三层。这类脏值只在池被压满时才现形,
 * 是最难查的一类 bug,故单测按 Object.keys 逐字段比对,将来加字段忘了这里会被当场抓住。
 */
export function resetBullet(b: Bullet): void {
  b.x = 0;
  b.y = 0;
  b.px = 0;
  b.py = 0;
  b.vx = 0;
  b.vy = 0;
  b.kind = BK_DIRECT;
  b.damage = 0;
  b.life = 0;
  b.pierce = 0;
  b.radius = 0;
  b.aoeRadius = 0;
  b.aoeDamage = 0;
  b.towerType = 0;
  b.throttle = 0; // 漏清:上一发的能量系节流会原样带给下一发(抗性判定认的就是它)
  b.intercept = false; // 漏清:上一发的拦截标记会原样带给下一发,普通弹凭空变成只打弹丸
}

/**
 * 推进全场子弹一逻辑帧:积分 → 碰撞/落点结算 → 回收。
 * @param sink 开火的去处(World 实现):本函数经它扣血、查邻域、记可视化事件,不认识世界的内部结构
 *
 * **倒序遍历**:命中与到期都要当场回收,而 pool 的 despawnAt 是 swap-remove ——
 * 正序时被顶上来的那颗会跳过当前下标而漏检(core/pool 的注释给的就是这条口径,World.reap 同理);
 * 倒序则被顶上来的对象一定落在已经走过的区间,不会漏也不会重。
 */
export function stepBullets(bullets: Pool<Bullet>, dt: number, sink: FireSink): void {
  const items = bullets.items;
  for (let i = items.length - 1; i >= 0; i--) {
    const b = items[i]!;
    // 先存上一帧位置再积分(与敌人循环、stepShip 同口径):渲染插值的两端由此成立
    b.px = b.x;
    b.py = b.y;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;

    if (b.kind === BK_MORTAR) {
      // 途中一概不碰撞:越过前排打到后排去,正是这一型的全部定位(GDD §5.2)
      if (b.life > LIFE_EPS) continue;
      blast(b, sink);
      bullets.despawnAt(i);
      continue;
    }

    // 直射弹:**先判命中再判到期** —— 这一帧的位移正是它飞完的最后一段,那段里撞上的人不该白撞
    // (反过来先判到期的话,射程边界上的目标会随机漏掉一发,而边界恰恰是玩家最容易感知的地方)
    if (!hitDirect(b, sink) || b.life <= LIFE_EPS) bullets.despawnAt(i);
  }
  scratch.length = 0; // 不替对象池扣着一批过期引用(见 scratch 的注释)
}

/**
 * 直射弹的碰撞:**每帧最多命中一只 = 最近的那一只**。
 * 不做"一帧扫过整条线段上的所有人":那等于给每颗弹白送一次 AoE,穿透次数这个旋钮当场作废,
 * 而 AoE 是迫击炮的定位。取最近的一只则与 findArcTarget 是同一条规则(同距严格 < 才替换 =
 * 保留先到者),候选顺序确定 ⇒ 命中确定 ⇒ 同 seed 必然复现。
 * @returns 弹丸是否还活着(命中且穿透用光 = false,由调用方回收)
 */
function hitDirect(b: Bullet, sink: FireSink): boolean {
  // 拦截弹(22 号)只认敌方弹丸、绝不命中敌人:命中判定在 sim/intercept.ts 的
  // stepInterceptHits,这里整段跳过 —— 拦截弹半路被虫群吃掉,"击落弹幕"承诺就形同虚设。
  // 注意它仍会被 stepBullets 正常积分/到期,只是不参与敌人的碰撞
  if (b.intercept) return true;

  // 查询半径 = 弹半径 + 最大敌半径(精英按体型放大,enemyRadius 的上界 = ENEMY_RADIUS_MAX × ELITE.scale)。
  // 1.5 倍率下 ≈ 25px < 一个 cell(28px):守住 GDD §13
  // "查询半径不超过一个 cell"—— 那是 3×3 邻域必然覆盖的前提,破了它哈希就会开始漏人
  sink.query(b.x, b.y, b.radius + ENEMY_RADIUS_MAX * ELITE.scale, scratch);

  let best: Enemy | null = null;
  let bestD2 = Infinity;
  let bestRadius = 0;
  for (let i = 0; i < scratch.length; i++) {
    const e = scratch[i]!;
    if (e.dead) continue; // 本帧已被别人打死:尸体整帧都还在场上,但不该再吃一发(否则 10 号的掉落会重复给)
    const def = ENEMIES[e.kind];
    if (!def && e.kind !== KIND_BOSS) continue; // kind 越界只是不打这一只,不炸掉整局;Boss 是表外的合法目标(15 号)
    const dx = e.x - b.x;
    const dy = e.y - b.y;
    const d2 = dx * dx + dy * dy;
    // 体型那一项走 enemyRadius(精英 ×ELITE.scale):判定体与画出来的剪影同口径
    const r = b.radius + enemyRadius(e);
    if (d2 > r * r) continue; // 含边界:恰好贴上算命中(与 findArcTarget 的射程圆同口径)
    if (d2 >= bestD2) continue; // 严格 < 才替换 —— 同距保留先到者
    best = e;
    bestD2 = d2;
    bestRadius = enemyRadius(e);
  }
  if (!best) return true;

  // 带节流系进伤害结算:词缀抗性(装甲/相位)在 World.damageEnemy 那一处按它判定
  sink.damage(best, b.damage, b.throttle);
  // 命中飘字带**实际结算**的伤害与相对满血的比例:抗性在 damageEnemy 里折算过,
  // 只有 Enemy.lastHit 是那一份真相(见 enemy.ts 的 lastHit 注释);它恰好在这一发刚
  // 结算完,读到的一定是本发 —— 不是上一发留下的脏值
  sink.fx(
    FXV_IMPACT,
    b.x,
    b.y,
    b.x,
    b.y,
    0,
    b.towerType,
    best.lastHit,
    best.maxHp > 0 ? best.lastHit / best.maxHp : 0,
  );
  if (b.pierce <= 0) return false;
  b.pierce--;
  return pushPast(b, best, b.radius + bestRadius);
}

/**
 * 把刚穿过去的弹丸沿**速度方向**推到该敌人判定圆之外。
 * 不给 Enemy 加一个 id 字段、也不给每颗弹挂一张"已命中列表":前者要动 sim/enemy.ts
 * (本轮一行都不许改,那 21 条用例得原样全绿),后者是每颗弹一个数组 = 运行期分配。
 * 推出圆外则是纯几何,零状态、零分配,而且物理上本来就对 ——
 * 穿透弹下一帧本就该出现在那只敌人的另一侧,而不是卡在它身体里逐帧重复命中。
 * @param r 合并半径 = 弹半径 + 该敌体型
 * @returns 弹丸是否还活着。速度为 0 的弹推不出去(方程没有方向),直接回收:
 *   留着它就会赖在同一只敌人身上逐帧白打,把穿透次数一层层白送出去。
 */
function pushPast(b: Bullet, e: Enemy, r: number): boolean {
  const speed = Math.hypot(b.vx, b.vy);
  if (speed <= 0) return false;
  const ux = b.vx / speed;
  const uy = b.vy / speed;
  // 沿 u 走到圆的**远侧**交点:解 |(b - e) + t·u|² = r² 的正根。
  // |b - e| ≤ r(刚判过命中)⇒ 判别式必然 ≥ 0、t 必然 ≥ 0,故不必为无解分支兜底;
  // Math.max(0, …) 只吃浮点残差,不是在处理另一种情形
  const dx = b.x - e.x;
  const dy = b.y - e.y;
  const proj = dx * ux + dy * uy;
  const t = -proj + Math.sqrt(Math.max(0, proj * proj + r * r - (dx * dx + dy * dy)));
  b.x += ux * (t + PIERCE_CLEAR_EPS);
  b.y += uy * (t + PIERCE_CLEAR_EPS);
  // px/py 刻意**不跟着挪**:渲染层插的那一段于是横穿过敌人身体,正是"打穿了"该有的样子
  return true;
}

/**
 * 抛射弹到期的落点结算:一圈之内**全员吃满**(不像直射弹只取最近的一只),这就是 AoE。
 * 可视化事件**无条件**推,哪怕一个人都没炸到 —— "炸开了但没炸到人"正是玩家判断
 * 落点偏了多少的唯一读数,吞掉它就等于让迫击炮的抛射变成一次没有反馈的猜谜。
 */
function blast(b: Bullet, sink: FireSink): void {
  sink.fx(FXV_BLAST, b.x, b.y, b.x, b.y, b.aoeRadius, b.towerType);

  // 全仓唯一一次敢超过一个 cell 的邻域查询,是有意的例外:爆点可能落在 stepTurrets 那份
  // 以船心为心的候选之外(抛射弹本就是越过前排打远处),不自己问一次哈希就会漏掉半圈人。
  // 代价可控 —— 频次是"每颗迫击炮弹一次"(全场最慢的攒-放,几秒一发),
  // 与逐帧逐敌的邻居分离不在一个量级上。
  //
  // 粗筛半径**必须 + ENEMY_RADIUS_MAX × ELITE.scale**,与 hitDirect 那一行同一条理由:
  // 判据是"体型碰到圈"(d ≤ aoeRadius + enemyRadius),而哈希只按 cell 的 AABB 返回超集。
  // 只问 aoeRadius 的话,圆心在圈外一点点、身体却压在圈上的那只,可能整个落在从没被访问的 cell 里 ——
  // 于是"圈内全员吃满"会随爆点与网格的对齐关系随机漏人(爆心 21 / 半径 90 / cell 28 时,
  // 124 处的甲虫 d = 103 ≤ 104 却查不到),而这种漏还极难复现。
  sink.query(b.x, b.y, b.aoeRadius + ENEMY_RADIUS_MAX * ELITE.scale, scratch);
  for (let i = 0; i < scratch.length; i++) {
    const e = scratch[i]!;
    if (e.dead) continue;
    const def = ENEMIES[e.kind];
    if (!def && e.kind !== KIND_BOSS) continue; // 同直射弹兜底:Boss 是表外的合法目标
    const dx = e.x - b.x;
    const dy = e.y - b.y;
    const r = b.aoeRadius + enemyRadius(e);
    if (dx * dx + dy * dy <= r * r) sink.damage(e, b.aoeDamage, b.throttle); // 含边界,与直射弹同口径
  }
}
