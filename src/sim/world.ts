/**
 * 世界状态与规则 —— 纯逻辑层。
 * 铁律:本目录永不 import pixi/DOM。这换来:同 seed 确定性、Node 里可单测、渲染可替换。
 *
 * 当前内容 = 玩家船(02)+ 四型敌人(07)+ 武器塔与它们打出来的子弹(05)+ 挨打这一半(09):
 *   一艘玩家船(输入只以纯数据 ShipCommand 从外部灌入,sim 永不读键盘),
 *   N 只按 tuning.enemyMix* 混出来的敌人,甲板上的塔真的开火产生的子弹与可视化事件,
 *   以及贴上来的敌人对船体 HP 的结算与四舷受击惩罚。
 *
 * 01 号 issue 那批"凭空重生的压测哑弹"在 05 号整段删除:哑弹与真弹共用一个池,
 * "500 弹同屏不掉帧"这条验收测的就是假东西 —— 500 弹现在得由塔真的打出来才算数。
 *
 * 分工:单只敌人的行为(追踪/绕行/冲锋状态机)在 sim/enemy.ts,炮管的追瞄与归位在 sim/turret.ts,
 * 子弹的积分与命中在 sim/bullet.ts,受击判定的全部几何(核心区/甲板轮廓/四舷/射速惩罚)在
 * sim/damage.ts,本文件只做"世界这一层"的接线 —— 出怪、邻居分离、积分位置、接触粗筛、
 * 开火的去处(FireSink)、船体受击结算、事件老化、死亡回收。
 * 拆开的理由是它们能脱开世界单测(见 enemy.test.ts / turret.test.ts / bullet.test.ts /
 * damage.test.ts),而这里钉的是顺序与生命周期。
 *
 * 本文件对后续 issue 只留挂钩、不抢活:shipDead / onShipDestroyed 只是状态位与回调,
 * 失败流程(结算界面/重开/暂停)交给 08 —— 世界不认识"游戏流程",它只负责把船沉了这件事说出来;
 * HP 上限与舷向减伤问 damage.ts 的两个挂钩(06 号装甲舱届时只填函数体);
 * onEnemyDeath 交给 10(残骸掉落),出怪器交给 08(波次脚本)。
 */
import { SIM_DT } from '../core/loop';
import { Pool } from '../core/pool';
import { Rng } from '../core/rng';
import { SpatialHash } from '../core/spatialHash';
import { ENEMIES, KIND_BEETLE, KIND_STRAFER, KIND_SWARM, KIND_TRAILER } from '../data/enemies';
import { SUP_AMMO_BAY } from '../data/supports';
import {
  FX_LIFE_BEAM,
  FX_LIFE_BLAST,
  FX_LIFE_CHAIN,
  FX_LIFE_LANCE,
  TOWER_AUTOCANNON,
} from '../data/towers';
import { type Bullet, createBullet, resetBullet, stepBullets } from './bullet';
import { tuning } from './config';
import {
  classifyHit,
  deckOuterRadius,
  edgeDamageMul,
  HIT_CORE,
  HIT_NONE,
  hitBroadside,
  hullMaxHp,
} from './damage';
import { createDeck, type Deck, EDGE_COUNT, isEdgeExposed, isPlaceSuccess, placeAt } from './deck';
import {
  applyDamage,
  createEnemy,
  type Enemy,
  initEnemy,
  resetEnemy,
  ST_APPROACH,
  stepEnemyBehavior,
} from './enemy';
import {
  createFxEvent,
  FX_LIFE_HULL_HIT,
  FX_LIFE_SPARK,
  type FireSink,
  type FxEvent,
  FXV_BLAST,
  FXV_CHAIN,
  FXV_HULL_HIT,
  FXV_LANCE,
  FXV_SPARK,
  resetFxEvent,
} from './fx';
import { createShip, type Ship, type ShipCommand, stepShip, type Vec2 } from './ship';
import { syncSupportBuffs } from './support';
import { stepTurrets } from './turret';

/** 渲染层与既有调用方都从 world 取 Enemy 类型,实体定义搬去 enemy.ts 后这条保持它们不破 */
export type { Enemy } from './enemy';
/** 子弹同理:实体搬去 bullet.ts 之后,渲染层的 `import type { Bullet } from '../sim/world'` 不必改 */
export type { Bullet } from './bullet';

/** 无输入的默认指令:让不接线输入的调用方(单测、无头跑批)照常 world.step() */
const IDLE: ShipCommand = { desiredHeading: null };

/** 压测场地半径(逻辑坐标,原点为场心) */
export const WORLD_RADIUS = 1200;

/** 出怪环的内半径:别把敌人直接生在船脸上 —— 08 号 issue 的波次脚本接手后这里整段作废 */
const SPAWN_MIN_RADIUS = 300;

/**
 * 敌人期望速度的暂存。模块级复用而不是每只现造:1000 敌 × 60Hz 下,
 * 循环里 new 一个对象就是每秒六万次分配,直接写在 GC 停顿上(铁律 3:运行期零新增分配)。
 */
const desired: Vec2 = { x: 0, y: 0 };

/**
 * 可视化事件的存续秒数:开火那几种一律取 data/towers 的 FX_LIFE_*,挨打这两种取 sim/fx.ts 的
 * FX_LIFE_SPARK / FX_LIFE_HULL_HIT(渲染层读的是同一批常量,两边才不会各算各的淡出时长)。
 * 挨打那两个刻意不进数值表:那张表是"某座塔开火的表现有多长",而船上一座塔都没有照样会被撞 ——
 * 放进去只会让平衡调整与受击反馈莫名其妙地耦在一起(理由全文见 sim/fx.ts)。
 * FXV_MUZZLE 数值表没给档 —— 它只是"炮口闪一下",退回最短的那一档(与光束同长)即可;
 * 表里没有的数不该由 sim 现发明一个,那就成了第二处真相。
 */
function fxLife(kind: number): number {
  switch (kind) {
    case FXV_CHAIN:
      return FX_LIFE_CHAIN;
    case FXV_LANCE:
      return FX_LIFE_LANCE;
    case FXV_BLAST:
      return FX_LIFE_BLAST;
    case FXV_SPARK:
      return FX_LIFE_SPARK;
    case FXV_HULL_HIT:
      return FX_LIFE_HULL_HIT;
    default:
      return FX_LIFE_BEAM;
  }
}

export class World {
  readonly rng: Rng;
  readonly enemies: Pool<Enemy>;
  readonly bullets: Pool<Bullet>;
  /** cell = 最大敌半径 ×2(GDD §13):查询半径不超过一个 cell 时,3×3 邻域必然覆盖 */
  readonly grid = new SpatialHash<Enemy>(tuning.enemyRadiusMax * 2);
  tick = 0;
  /** 全局只有一艘船,故不进对象池;它同样维护 px/py 与 pheading 供渲染插值(铁律 2) */
  readonly ship: Ship = createShip();

  /**
   * 甲板(03 号 issue):起始 = T0 拾荒艇的 3×4 全空格。整局同一个对象,
   * 放塔与 12 号扩建都是就地改字段 —— 渲染层持有它的引用,靠 revision 做脏标记。
   */
  readonly deck: Deck = createDeck();

  /**
   * 本帧贴到船身的敌人 —— **粗筛候选**(照 sim/turret.ts 的 candidates 口径),不是"真撞上的人"。
   * 敌人循环里只做一次廉价的圆判定(甲板外接圆 + 体型)就入名单,精筛(damage.ts 的 classifyHit)
   * 与扣血全在 settleHullDamage 一处:判定几何全仓只有 damage.ts 那一份,热循环里再抄一遍
   * 迟早写歪,而那时"画出来的判定体"与"真正扣血的判定体"就不是同一个了。
   * 于是它是**超集** —— 名单里的人可能一层都没碰上(粗筛宁大勿小,半径口径见敌人循环里那段 cr)。
   * 每帧在敌人循环前清空;元素是池中对象,step() 返回后立刻读,别跨帧存引用 ——
   * 死者回池后同一个对象会变成另一只敌人。
   */
  readonly contacts: Enemy[] = [];

  /**
   * 四舷的受击惩罚剩余秒,下标 = EDGE_*。>0 = 该舷闪红(渲染层)+ 该舷塔射速惩罚中(sim/turret)。
   * 整局复用同一个致密四元组(铁律 3:运行期零新增分配),逐帧减 dt 夹 0。
   *
   * 闪红与射速惩罚读的是**这同一个计时器**:两件事天然同起同落,想差一帧都做不到 ——
   * 渲染层要是为闪红另起一个衰减计时,玩家看到的"这一舷在闪"与"这一舷的塔在变慢"就会各走各的,
   * 而它们本该是同一次挨打。"惩罚不可叠加延长"的语义也一并白送(见 damageShip)。
   */
  readonly edgePenalty: number[] = new Array<number>(EDGE_COUNT).fill(0);

  /**
   * 船体 HP 归零。**局终流程本身是 08 号 issue**:结算界面、重开、暂停、动 loop 都不在这里 ——
   * 世界不认识"游戏流程",它只负责把"船沉了"这件事以一个状态位说出来。
   * 它是 ship.hp 的派生量(除了归零那一刻没有第二条来路),故**不进 checksum**。
   */
  shipDead = false;

  /**
   * 船沉的**一次性**回调(08 号失败流程挂这里)。只在 hp 第一次归零那一帧响一次:
   * damageShip 的首句就把已 dead 的世界挡在门外,于是尸体上再挨多少下都不会再响,
   * 08 那边不必自己去重 —— 与 onEnemyDeath"同帧重复致命只算一次"是同一条口径。
   */
  onShipDestroyed: (() => void) | null = null;

  /**
   * 死亡挂钩(掉落物本体由 10 号 issue 实现)。回调返回后对象立刻回池,
   * 所以回调里必须当场取走 x/y/kind,不能存引用等下一帧再读。
   */
  onEnemyDeath: ((e: Enemy) => void) | null = null;

  /** 累计击杀。面板改数量导致的清场不计入 —— 那不是打死的 */
  kills = 0;

  /**
   * 开火/命中的可视化事件(05 号 issue):渲染层遍历 world.fx.items 逐个画,按 life 淡出。
   * **纯表现,一律不进 checksum**(理由见 checksum 末尾那段);每帧在 step 末尾统一老化,
   * life ≤ 0 倒序 swap-remove 回池 —— 与子弹、敌人共用同一套生命周期写法(铁律 3)。
   */
  readonly fx = new Pool<FxEvent>(createFxEvent, resetFxEvent);

  /**
   * 本帧开火塔最多的那一舷(EDGE_*),**-1 = 本帧一座塔都没开火**;
   * broadsideCount = 该舷本帧的开火塔数,≥3 就是单舷齐射,渲染层据此给一次镜头顿挫(05 号 T5)。
   * 一座塔按它**每一条暴露边**各投一票、角落格同时算进两舷(归属规则与理由见 sink.fired)。
   * 与 contacts 同口径**逐帧重建**:它是"这一帧发生了什么"的读数,不是累计状态 ——
   * 不清的话镜头会被上一帧的齐射一直顶着。
   */
  broadsideEdge = -1;
  broadsideCount = 0;

  private scratch: Enemy[] = [];

  /** 本帧各舷的开火塔数,下标 = EDGE_*。整局复用同一个致密四元组(铁律 3:运行期零新增分配) */
  private readonly edgeFires: number[] = new Array<number>(EDGE_COUNT).fill(0);

  /**
   * 开火的去处(sim/fx.ts 的 FireSink)。塔与子弹只 `import type` 那份契约,经它回到世界里来 ——
   * 双向直连(world 调 turret、turret 取 world 的池)就是一个运行期循环依赖,
   * 在 ESM 里表现为"某一侧拿到 undefined",且只在改了 import 顺序时才炸。
   *
   * 做成**字段上的对象字面量**而不是 `World implements FireSink`:渲染层要遍历的事件池叫
   * world.fx,而契约里记事件的方法也叫 fx —— 同一个类上放不下两个同名成员。
   * 构造时建一次、整局复用(箭头函数捕获 this),不在每帧的开火路径上现造对象。
   */
  private readonly sink: FireSink = {
    spawnBullet: () => this.bullets.spawn(),
    damage: (e, amount) => this.damageEnemy(e, amount),
    fx: (kind, x0, y0, x1, y1, radius, towerType) => {
      const e = this.fx.spawn();
      e.kind = kind;
      e.x0 = x0;
      e.y0 = y0;
      e.x1 = x1;
      e.y1 = y1;
      e.radius = radius;
      e.towerType = towerType;
      e.life = fxLife(kind);
    },
    query: (x, y, r, out) => {
      this.grid.query(x, y, r, out);
    },
    fired: (cell) => {
      // 一座塔属于它**每一条暴露边**对应的舷,故角落格的这一发**同时记进两舷** ——
      // 判据就是既有的 isEdgeExposed,与 damage.cellFireRateMul(射速惩罚的逐塔归属)
      // 是同一条规则,全仓只此一份:玩家读到的"这一舷在齐射"与"这一舷在挨罚"说的必须是同一批塔。
      //
      // 不按"每格只挑一条边"(05 号临时的 lowestEdge、或按格心方位角都是这一类)的理由是甲板拓扑:
      // 3×4 甲板按暴露边数,BOW/STERN 各 3 格、PORT/STARBOARD 各 4 格,四舷都摆得下 3 座塔;
      // 挑一条边则 PORT 与 STERN 当场瘪成 2 格(两头的角落格被算给了别人),
      // 那两舷永远凑不满"≥3 塔齐射",一半的 broadside 反馈直接死掉(逐格计数见 damage.test.ts)。
      // 代价是 broadsideCount 的语义从"开火塔数"变成"**这一舷**有几座塔开了火",
      // 角落格的一发在两舷各算一票 —— 而这与它凭两条暴露边拿到 +60° 射界(GDD §4.2)是同一件事:
      // 它本来就同时对着两个方向打。
      //
      // 没有暴露边 = 内部格/离线塔,本就打不响;真进来了这个循环也一票不投,
      // 不必单独挡一手(那会让 broadsideEdge 变成瞎猜)
      for (let edge = 0; edge < EDGE_COUNT; edge++) {
        if (!isEdgeExposed(cell, edge)) continue;
        const n = this.edgeFires[edge]! + 1;
        this.edgeFires[edge] = n;
        // 严格 > 才换舷 = 平局保留先到的那一舷(edge 顺序固定 ⇒ 结果确定),与索敌的"保留先到者"同口径
        if (n > this.broadsideCount) {
          this.broadsideCount = n;
          this.broadsideEdge = edge;
        }
      }
    },
  };

  constructor(seed: number) {
    this.rng = new Rng(seed);
    this.enemies = new Pool<Enemy>(createEnemy, resetEnemy);
    this.bullets = new Pool<Bullet>(createBullet, resetBullet);
    // HP 上限问 damage.hullMaxHp 而不是直接读 tuning:06 号的装甲舱("船体 HP +15")会把它变成
    // **甲板的派生量**,调用点今天就接好,届时 06 只需要把那个函数体填掉,World 一个字不用动。
    // 满血进场(hp = maxHp):createShip 里那份初值只是"船不进池"的兜底,真相以这一句为准
    this.ship.hp = this.ship.maxHp = hullMaxHp(this.deck);
  }

  /** 开局至今的秒数。HP 时间缩放(GDD §14)的唯一时间源:挂在 tick 上才与 checksum 同口径 */
  get elapsed(): number {
    return this.tick * SIM_DT;
  }

  /**
   * @param cmd 本逻辑帧的输入(纯数据)。只读不缓存引用,调用方可以整局复用同一个对象;
   *   缺省 = 松手,让 world.step() 的既有调用方(单测、无头跑批)不必关心输入。
   *
   * 顺序定死(单测按此钉):**甲板派生量(邻接 buff + HP 上限)** → 船 → 贴边夹取 → 出怪 →
   * 重建空间哈希 → 清 contacts / 清 broadside / edgePenalty 逐帧减 dt →
   * 敌人(积分 + hitCd 递减 + 粗筛入 contacts)→
   * 炮管(含节流与开火)→ 子弹 → 船体受击结算 → 可视化事件老化 → 回收死者。
   * 甲板派生量排在**最前**(见下面那两句):这一帧的塔按最新的邻接加成开火、这一帧的撞击按最新的
   * 上限结算 —— 12 号拆掉一格甲板(setOccupied 清 supportType)后,加成与上限当帧就回落,
   * 而不是靠下一次放置才想起来重刷(06 号验收第三条"拆除即时移除"的落点就在这两句)。
   * 出怪排在建哈希之前,新生的敌人当帧就参与分离;
   * 炮管排在敌人循环**之后**:敌人本帧已经动完,塔瞄的就是本帧位置 ——
   * 反过来的话每座塔都恒定落后一帧,贴脸高速目标会永远被瞄在身后(04 号 issue);
   * 子弹排在炮管之后,于是本帧新出膛的弹当帧就走一步、px/py 停在炮口
   *(与"出怪排在建哈希之前、新生敌人当帧就动"同一条口径);
   * 受击结算排在**子弹之后**,于是"本帧刚被塔打死的敌人"那一句过滤真的有意义(尸体不许再咬一口),
   * 又排在**回收之前**,因为尸体整帧都还在池里 —— contacts 里存的是池中对象,
   * 回收先走的话名单里会留着已经出池、且可能已被复用成另一只敌人的引用;
   * 回收排在最后,于是"本帧被打死的敌人"在整帧里始终可见(渲染/结算读到的是同一批人)。
   */
  step(cmd: ShipCommand = IDLE): void {
    this.tick++;

    // 甲板的两样派生量在帧首统一刷,于是"这一帧"的塔与"这一帧"的撞击读到的都是最新的甲板。
    //
    // 邻接加成:sync 自带 revision 守卫,甲板没变时整帧 O(1)(见 sim/support.ts),
    // 故放在热路径上不心疼。放这里而不是只在 place 之后刷一次 —— 甲板还有 place 之外的改法
    // (12 号的 setOccupied 焊/拆),而那条路不该被迫记得来调一次 buff 重算。
    syncSupportBuffs(this.deck);
    // HP 上限同理是**甲板的派生量**(装甲舱 +15,damage.hullMaxHp):拆掉装甲舱的当帧就该回落,
    // 这正是 06 号验收第三条"拆除即时移除"要的即时性 —— place 里那一句只管得住"放下去"这一半。
    // 每帧现算而不是记个脏标记:hullMaxHp 是十来格的一遍加法,比维护第二个 revision 便宜得多。
    //
    // **只夹不涨**:上限回落时把 hp 压进新上限(否则拆掉装甲舱会留下一艘 hp > maxHp 的船,
    // 血条画出去满出来),但上限涨上去时 hp 一分不还 —— 装甲舱是船的规格,不是治疗
    // (与 place 里那句"这一局打下来的账一分不还"同一条口径)。
    // 不在这里判 shipDead:hp 已经是 0,夹取对它是恒等,多一个分支只是多一条要维护的路
    this.ship.maxHp = hullMaxHp(this.deck);
    if (this.ship.hp > this.ship.maxHp) this.ship.hp = this.ship.maxHp;

    // 船先动:敌人这一帧要追的是船的新位置,晚一帧追会让高速时的包夹肉眼可见地滞后
    const ship = this.ship;
    stepShip(ship, cmd.desiredHeading, SIM_DT);

    // 压测场地是有边界的(08 号 issue 换成真地图规则):超出就沿径向贴回边上,
    // 并清掉速度的外向分量 —— 否则贴边时推力仍在往外积速,一转头就会弹射出去
    const shipDist = Math.hypot(ship.x, ship.y);
    if (shipDist > WORLD_RADIUS) {
      const nx = ship.x / shipDist;
      const ny = ship.y / shipDist;
      ship.x = nx * WORLD_RADIUS;
      ship.y = ny * WORLD_RADIUS;
      const radial = ship.vx * nx + ship.vy * ny;
      if (radial > 0) {
        ship.vx -= radial * nx;
        ship.vy -= radial * ny;
      }
    }

    // 注意:运行中通过面板改实体数量会消耗 rng,之后的 checksum 不再与"从头跑"可比
    this.syncCounts();

    // 重建空间哈希
    const enemies = this.enemies.items;
    this.grid.clear();
    for (let i = 0; i < enemies.length; i++) this.grid.insert(enemies[i]!);

    // 船坐标与全局倍率 hoist 出循环:1000 敌是本轮压测场景,热循环里每帧多几次属性穿透没必要。
    // hoist 到帧内而不是构造时 —— 每帧仍是现读,面板拖动照样即时生效
    const tx = ship.x;
    const ty = ship.y;
    const sep = tuning.enemySeparation;
    const speedScale = tuning.enemySpeedScale;
    // 粗筛半径 = 甲板外接圆(damage.ts 的唯一口径,随 12 号扩建一起长),体型那一项见下面 cr
    const contactR = deckOuterRadius(this.deck);

    this.contacts.length = 0;
    // broadside 与 contacts 同口径:逐帧重建的"这一帧发生了什么",在敌人循环之前就清干净,
    // 于是一帧都没塔开火时读到的是 -1/0,而不是上一帧的齐射(见字段注释)
    this.broadsideEdge = -1;
    this.broadsideCount = 0;
    for (let e = 0; e < this.edgeFires.length; e++) this.edgeFires[e] = 0;

    // 四舷惩罚逐帧减 dt、夹 0。排在结算(帧尾)**之前**:本帧新挨的那一下拿到的是完整的
    // hitPenaltyTime,不会当帧就被扣掉一个 dt(否则"0.5s 惩罚"实际只有 0.4833s,还差得刚好一帧)。
    // 夹 0 而不是让它跑成负数:负数会让 checksum 里这一项在整局没挨打的舷上无限发散,
    // 也会让 cellFireRateMul 的"严格 > 0 才罚"退化成一句废话
    for (let e = 0; e < this.edgePenalty.length; e++) {
      const left = this.edgePenalty[e]! - SIM_DT;
      this.edgePenalty[e] = left > 0 ? left : 0;
    }

    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i]!;
      e.px = e.x;
      e.py = e.y;
      const def = ENEMIES[e.kind]!;

      // 无敌帧逐帧减 dt、夹 0(与 edgePenalty 同口径)。**每只敌人各自一份**:
      // 全船一个冷却的话,蜂群贴脸时只有最先判到的那一只咬得动,"一百只压上来"与"一只压上来"
      // 的掉血速率会一模一样(见 Enemy.hitCd 的字段注释)
      if (e.hitCd > 0) e.hitCd = Math.max(0, e.hitCd - SIM_DT);

      // 行为只给"期望速度 + 追随系数",位置由这里积分(sim/enemy 不碰位置)
      const follow = stepEnemyBehavior(e, ship, SIM_DT, desired);
      let dvx = desired.x;
      let dvy = desired.y;

      // 邻居分离**只在接近段**叠加:前摇/冲刺/硬直期间被同伴推离锁定直线,
      // 直线冲锋就不再是直线 —— 前摇预警画出的那条线会变成谎言(07 验收标准第二条)。
      // 分离半径用全局 tuning.enemySeparation 而不做成 per-kind:它是人群的物理常量,
      // 且必须守住"查询半径 ≤ 一个 cell"的性能口径(GDD §13)。
      if (sep > 0 && e.state === ST_APPROACH) {
        const speed = def.speed * speedScale;
        this.grid.query(e.x, e.y, sep, this.scratch);
        for (let j = 0; j < this.scratch.length; j++) {
          const n = this.scratch[j]!;
          if (n === e) continue;
          const ox = e.x - n.x;
          const oy = e.y - n.y;
          const d2 = ox * ox + oy * oy;
          if (d2 >= sep * sep || d2 === 0) continue;
          const d = Math.sqrt(d2);
          const push = ((sep - d) / sep) * speed;
          dvx += (ox / d) * push;
          dvy += (oy / d) * push;
        }
      }

      e.vx += (dvx - e.vx) * follow;
      e.vy += (dvy - e.vy) * follow;
      e.x += e.vx * SIM_DT;
      e.y += e.vy * SIM_DT;

      // 粗筛:甲板外接圆 + 敌人体型。只登记,不扣血、不弹开、不消灭 ——
      // 三层判定(核心区/甲板轮廓/没碰上)与结算全在帧尾的 settleHullDamage 一处做完,
      // 这里多做一步都会跟它打架(而且要在 1000 敌的热循环里付两次矩形判定的钱)。
      //
      // 体型那一项乘 √2 而不是直接加 radius:精筛(classifyHit)把矩形按体型**两轴各外扩** radius,
      // 那个盒子的外接半径是 hypot(半长+r, 半宽+r),而它**严格大于** hypot(半长, 半宽) + r
      //(三角不等式:半长 + 半宽 > 外接半径)—— 只加 r 会在甲板四角漏掉一小片真擦碰,
      // 而粗筛漏掉的人这一帧就彻底结算不到(名单是超集才有意义)。
      // R + r√2 是它的紧上界(hypot(半长+r, 半宽+r) ≤ hypot(半长, 半宽) + hypot(r, r)),
      // 代价只是一次乘法 —— 逐只现算精确外接半径要一次开方,那才是 1000 敌热循环里付不起的钱
      const cdx = e.x - tx;
      const cdy = e.y - ty;
      const cr = contactR + def.radius * Math.SQRT2;
      if (cdx * cdx + cdy * cdy < cr * cr) this.contacts.push(e);
    }

    // 炮管:朝射界内最近的敌人转,没得打就归位(04 号 issue),够得着又转得过来就开火(05 号)。
    // 传 this.grid 而不是 enemies:1000 敌 × 十座塔的线性扫描是 GDD §13 明令要用哈希避开的那件事;
    // 传 this.sink 而不是 this:开火侧只认识 FireSink 那份契约,永远不认识 World(见 sim/fx.ts);
    // 传 this.edgePenalty:被撞舷的塔在惩罚期内变慢(09 号 §4.6),逐塔归属由 damage.cellFireRateMul 定
    stepTurrets(this.deck, ship, this.grid, SIM_DT, this.sink, this.edgePenalty);

    // 子弹:积分 → 命中 → 迫击炮到期在落点炸 AoE(规则全在 sim/bullet.ts,本文件只给它一个 sink)
    stepBullets(this.bullets, SIM_DT, this.sink);

    // 船体受击结算:粗筛名单 → 三层判定 → 扣血/出火花(顺序理由见块注释与 settleHullDamage)
    this.settleHullDamage();

    // 可视化事件老化。倒序 swap-remove(与 reap 同一个下标坑);它纯是表现,不参与任何判定,
    // 故老化排在开火之后、回收之前的哪一步都无所谓 —— 唯一要紧的是每帧只走一次
    const fx = this.fx.items;
    for (let i = fx.length - 1; i >= 0; i--) {
      const e = fx[i]!;
      e.life -= SIM_DT;
      if (e.life <= 0) this.fx.despawnAt(i);
    }

    this.reap();
  }

  /**
   * 统一回收本帧的死者。**必须倒序**:pool 的 despawnAt 是 swap-remove,
   * 正序遍历时被顶上来的那只会跳过当前下标而漏检(pool.ts 注释已给口径);
   * 倒序则被顶上来的对象一定落在已经走过的区间,不会漏也不会重。
   * 掉落交给挂钩:回调返回后对象立刻回池,10 号 issue 必须在回调里当场取走坐标。
   */
  private reap(): void {
    for (let i = this.enemies.size - 1; i >= 0; i--) {
      const e = this.enemies.items[i]!;
      if (!e.dead) continue;
      this.kills++;
      this.onEnemyDeath?.(e);
      this.enemies.despawnAt(i);
    }
  }

  /**
   * 本帧的船体受击结算 —— 三层判定(核心区 / 甲板轮廓 / 没碰上)与扣血**全仓只有这一处**。
   * 只走 contacts 那份粗筛名单:精筛是"转回局部系 + 两次矩形判定",给全场 1000 只人手来一遍
   * 是白付的钱,而粗筛圆罩得住两层判定的全部范围(半径怎么取见敌人循环里那段 √2 的说明)。
   *
   * 撞完**不击退、不消灭敌人、不改它的状态机**:VS 式的贴脸就是"它压在那儿继续磨",
   * 弹开会把蜂群贴脸变成一件物理玩具,而 GDD §4.6 要的是一条稳定可读的掉血曲线。
   * 伤害与火花**共用同一个冷却**(e.hitCd):于是每只敌人每 enemyHitInterval 最多产出一个事件,
   * 蜂群贴脸也刷不爆 fx 池;掉血速率则由 enemyHitInterval × contactDamage × 全局倍率三根旋钮定死
   *(验收标准第一条"一次接触只结算一次、蜂群贴脸掉血速率可控可调"说的就是这件事)。
   */
  private settleHullDamage(): void {
    const ship = this.ship;
    const deck = this.deck;
    const scale = tuning.enemyContactDamageScale;
    for (let i = 0; i < this.contacts.length; i++) {
      const e = this.contacts[i]!;
      // 本帧刚被塔打死的敌人不许再咬一口 —— 这一句之所以有意义,全靠结算排在子弹之后
      if (e.dead) continue;
      const def = ENEMIES[e.kind]!;
      const hit = classifyHit(ship, deck, e.x, e.y, def.radius);
      // 粗筛名单是超集,一层都没碰上的直接放过;冷却没走完的连火花都不出(免得"没伤害的擦碰"
      // 每帧刷一个事件,把 fx 池当烟花放)
      if (hit === HIT_NONE || e.hitCd > 0) continue;
      e.hitCd = tuning.enemyHitInterval;

      if (hit === HIT_CORE) {
        this.damageShip(def.contactDamage * scale, e.x, e.y);
        this.pushHitFx(FXV_HULL_HIT, e.x, e.y);
      } else {
        // 蹭到核心区之外的甲板:**只出火花,一分血都不结算**(GDD §4.4)。
        // classifyHit 先判核心后判轮廓,所以核心区里的敌人永远走不进这一支
        this.pushHitFx(FXV_SPARK, e.x, e.y);
      }
    }
  }

  /**
   * 挨打的可视化事件入池。借 sink.fx 而不是在这里再写一遍取池/填字段/取 life ——
   * FxEvent 的生命周期全仓只该有一条路径(fxLife 的口径也才不会分裂)。
   * 起点终点同点、半径 0:这两种表现都画在**接触点**上(见 renderer 的 FXV_SPARK / FXV_HULL_HIT);
   * towerType 填 0 只是占位 —— 挨打不是任何一座塔打出来的,渲染层对这两种 kind 也不读它。
   */
  private pushHitFx(kind: number, x: number, y: number): void {
    this.sink.fx(kind, x, y, x, y, 0, 0);
  }

  /**
   * 船体受伤的**唯一入口**:碰撞结算(settleHullDamage)走它,而它同时就是
   * **敌方弹幕伤害的接口预留** —— MVP 没有远程敌,故本轮不造弹丸、不加敌方子弹池、
   * 不给 EnemyDef 加远程字段;将来那一发打到船上,调的还是这一个方法。
   *
   * @param amount 伤害量(调用方已乘过全局倍率)。≤ 0 一律不算数:
   *   否则"零伤害的接触"也会把那一舷刷成闪红 + 射速惩罚,反馈就成了噪音
   * @param x @param y 接触点世界坐标 —— 撞的是哪一舷由它相对**船头**的方位角定(damage.hitBroadside),
   *   而不是由敌人是谁定:同一只敌人绕到船尾再撞,闪的就该是船尾
   * @returns 本次是否真的扣到血(船已沉 / amount ≤ 0 → false)
   */
  damageShip(amount: number, x: number, y: number): boolean {
    // 已沉就一切停手:这一句同时保证了 onShipDestroyed 只可能响一次(与 applyDamage 的
    // "同帧重复致命只算一次"同一条口径),08 号的失败流程不必自己去重
    if (this.shipDead || amount <= 0) return false;

    const edge = hitBroadside(this.ship, x, y);
    // 舷向减伤是 06 号装甲舱("所在舷受撞伤害 -20%")的挂钩,MVP 恒返回 1 —— 调用点今天就接好
    const dealt = amount * edgeDamageMul(this.deck, edge);
    this.ship.hp = Math.max(0, this.ship.hp - dealt);

    // **惩罚不可叠加延长**(验收标准第三条):已经在挨罚就不再把计时推回 0.5s ——
    // 每次受击都重置的话,蜂群贴脸就是一条常亮的红边 + 永不恢复的射速,正是那条要避开的死亡螺旋。
    // 闪红读的是同一个计时器,于是"闪红"与"射速惩罚"天然同窗口、不可能差一帧
    if (this.edgePenalty[edge]! <= 0) this.edgePenalty[edge] = tuning.hitPenaltyTime;

    if (this.ship.hp <= 0) {
      this.shipDead = true;
      // 局终流程本身是 08 号 issue:这里只把消息递出去,不做结算界面、不重开、不暂停、不动 loop
      this.onShipDestroyed?.();
    }
    return true;
  }

  /**
   * 05 号 issue 的唯一伤害入口(塔/子弹都走这里)。
   * 只标记不回收:真正的出池与掉落在 step 末尾统一做,于是调用方不必知道对象在池里的下标,
   * 也不会在别人遍历到一半时把数组搅乱。
   * @returns 本次是否致死(同帧重复致命只算一次,见 applyDamage)
   */
  damageEnemy(e: Enemy, amount: number): boolean {
    return applyDamage(e, amount);
  }

  /**
   * 全仓唯一的放置入口(与 damageEnemy 同口径:规则在 sim/deck,World 只转发)。
   * @param towerType content = CELL_WEAPON 时的塔型;缺省 = 自动机炮(GDD §5.2 的万金油),
   *   于是既有的三参调用方语义原样成立。往已有**同种**塔的格上再放一座 = 同名叠级
   *   (PLACE_UPGRADE,GDD §5.4),换塔型/换内容仍然是 PLACE_TAKEN —— 规则全在 sim/deck,这里不复述。
   * @param supportType content = CELL_SUPPORT 时的设施型;缺省 = 弹药库(GDD §4.3 的"弹药库先行"),
   *   于是既有的三/四参调用方语义同样原样成立。两套编号各管各的一半、绝不合并 ——
   *   0 在两边分别是自动机炮与弹药库,理由全文见 sim/deck 的 canPlace。
   * @returns PLACE_* 理由码;被拒时世界一个字段都没动,ui 层照码说人话(成功判定用 isPlaceSuccess)
   *
   * 它在 step() 之外改世界状态,与"面板改实体数量"同一个口径:一旦调用,
   * 之后的 checksum 不再与"同 seed 从头跑"可比(放置本身是确定性的,但它不在输入序列里)。
   * 10 号 issue 的"三选一 → 时停 → 放置"会把它收进正式流程,届时放置事件进输入序列,这条限制自动消失。
   */
  place(
    col: number,
    row: number,
    content: number,
    towerType: number = TOWER_AUTOCANNON,
    supportType: number = SUP_AMMO_BAY,
  ): number {
    const code = placeAt(this.deck, col, row, content, towerType, supportType);
    // 放置成功就重刷上限:HP 上限从设计上就是**甲板的派生量**(06 号的装甲舱 +15)。
    // hullMaxHp 当场遍历 cells、不读任何缓存,故这一句放下去当帧就是新的上限。
    // **hp 不跟着涨**:上限是船的规格,当前 HP 是这一局打下来的账 —— 装一块装甲舱不该顺手治疗。
    // 被拒的放置一个字段都没动(见 sim/deck),自然也不必重刷
    if (isPlaceSuccess(code)) {
      this.ship.maxHp = hullMaxHp(this.deck);
      // 邻接加成也当场重算,不等下一帧的 step:放置发生在 step **之外**(ui 的一次点击),
      // 而 10 号的"三选一 → 时停 → 放置"里时间是停的 —— 那时不补这一句,玩家就会看见
      // 一块焊好的弹药库连着一门一动不动的机炮,直到时停结束才突然提速。
      // 它自己带 revision 守卫,故与帧首那次 sync 重复调用是 O(1),不必怕多算一遍
      syncSupportBuffs(this.deck);
    }
    return code;
  }

  /**
   * 让面板改数量即时生效:不足则补,超出则回收(清场不算击杀,故不走 reap 的挂钩)。
   * **只剩敌人这一半**:子弹那一半(维持 tuning.stressBullets 颗哑弹)在 05 号 issue 整段删除 ——
   * 凭空重生的哑弹与真弹共用一个池,"500 弹同屏不掉帧"这条验收测的就是假东西。
   */
  private syncCounts(): void {
    while (this.enemies.size < tuning.stressEnemies) this.spawnEnemy();
    while (this.enemies.size > tuning.stressEnemies) this.enemies.despawnAt(this.enemies.size - 1);
  }

  /**
   * 出一只怪。rng 消耗顺序**定死为 kind → angle → radius → side**,且与 kind 无关:
   * 改某一型的行为、甚至改出怪占比,都不会移动整条随机序列(位置序列照旧,只是型号变了),
   * 确定性回放才不会因为一次平衡调整而全废。
   */
  private spawnEnemy(): void {
    const kind = this.pickKind();
    const a = this.rng.angle();
    const r = SPAWN_MIN_RADIUS + this.rng.next() * (WORLD_RADIUS - SPAWN_MIN_RADIUS);
    const e = this.enemies.spawn();
    // HP 时间缩放只在出生时算一次(GDD §14):在场的敌人不会因为时间流逝而回血变硬
    initEnemy(e, kind, Math.cos(a) * r, Math.sin(a) * r, this.elapsed, this.rng);
  }

  /**
   * 按 tuning.enemyMix* 四个权重轮盘赌。08 号 issue 的波次脚本接手前的临时出怪器,
   * 只影响新生成的敌人 —— 面板拖占比不会让已在场的敌人变型。
   * 无论权重如何都**恰好消耗一次 rng**:消耗次数随权重变的话,拖一下面板整条序列就错位了。
   */
  private pickKind(): number {
    // 面板下限是 0,这里再夹一次是防手改配置写出负权重把轮盘转反
    const w0 = Math.max(0, tuning.enemyMixSwarm);
    const w1 = Math.max(0, tuning.enemyMixStrafer);
    const w2 = Math.max(0, tuning.enemyMixTrailer);
    const w3 = Math.max(0, tuning.enemyMixBeetle);
    const total = w0 + w1 + w2 + w3;
    // 先取那一次随机数再判空:消耗次数必须与权重无关,否则拖一下面板整条序列就错位了
    const t = this.rng.next() * total;
    if (total <= 0) return KIND_SWARM; // 四个都拖到 0:回落成蜂群蛭,总不能出个空气

    // 累加比较(而不是逐个减):求和顺序与 total 一致,权重为 0 的型在浮点边界上也绝不会被选中
    let acc = w0;
    if (t < acc) return KIND_SWARM;
    acc += w1;
    if (t < acc) return KIND_STRAFER;
    acc += w2;
    if (t < acc) return KIND_TRAILER;
    return KIND_BEETLE;
  }

  /** 全体实体位置的滚动哈希。同 seed 同 tick 数 → 必然相同(01 号 issue 验收口径) */
  checksum(): string {
    let h = 0;
    const acc = (v: number): void => {
      h = (Math.imul(h, 31) + (Math.round(v * 8) | 0)) | 0;
    };
    // 船排在最前:它是这条哈希里唯一受输入影响的量,顺序固定才能跨运行比对。
    // 朝向换算成度再累加 —— Math.round(v*8) 对弧度太粗(量化步长 0.125 rad ≈ 7°),
    // 换成度后分辨率是 0.125°,才抓得住"同一条输入序列转出的角度不一致"
    acc(this.ship.x);
    acc(this.ship.y);
    acc((this.ship.heading * 180) / Math.PI);
    // 船体 HP:这一局唯一的失败进度。漏了它,"撞击没结算""无敌帧漏判""擦碰也扣了血"这三类回归
    // 全都会从确定性口径下漏掉。不放大 100 倍 —— HP 是 100 量级的量,acc 内部量化到 1/8 绰绰有余。
    //
    // **maxHp 与 shipDead 都不进**,它们是派生量:
    //   maxHp = damage.hullMaxHp(deck),而甲板本身下面逐格哈过了 —— 哈它就是把同一件事哈两遍;
    //   shipDead 除了"hp 归零那一刻置位"没有第二条来路,hp 已经进来了,它就没有独立信息。
    acc(this.ship.hp);
    // 甲板紧跟着船:build 也是世界状态,少了它,"塔放错格"或"扩建没同步"这类回归会从确定性口径下漏掉。
    // 顺序 = deck.cells 的下标顺序(row-major,见 sim/deck),与渲染遍历同一条,永不改;
    // exposed/online 是 occupied 的派生量,进哈希只是把同一件事哈两遍,故跳过。
    // turretOffset 则**不是**派生量,而是逐帧追瞄/归位演化出来的状态(04 号 issue):
    // 漏了它,"塔瞄错方向"这类回归就从确定性口径下漏掉,而它恰恰是 05 号开火方向的唯一依据。
    // 换算成度的理由与 heading 那句一致 —— Math.round(v*8) 对弧度太粗。
    //
    // 塔的运行期状态(05 号 issue)与 turretOffset 同理:冷却/弹夹/装填/热量/过热锁/充能
    // **全是逐帧演化出来的状态,不是派生量**,漏了它们,"某座塔的装填提前了一帧"这类分叉
    // 就从确定性口径下漏掉了 —— 而节流状态恰恰决定了下一帧谁开火。
    // cooldown/reloadLeft/coolLock/charge × 100 的理由与"弧度换算成度"同源:
    // Math.round(v * 8) 对 0..1 量级的秒数/进度太粗(量化步长 0.125),抓不住一两帧的差别
    //
    // 支援设施的**型号**(06 号)与 towerType 同理是一次放置定死的世界状态,不是派生量:
    // 漏了它,"该放弹药库却放成了散热器"这类回归会从确定性口径下漏掉 —— 而两者对同一门炮
    // 一个提速一个不提速,下一帧谁开火就此不同。而那四个**邻接 buff 缓存与 buffRevision 一律不进**:
    // 它们是 occupied/content/supportType/towerType/online 的纯函数(recomputeSupportBuffs 每次
    // 全甲板重算,没有第二条来路),而这几样上下逐格全哈过了 —— 哈缓存只是把同一件事哈两遍,
    // 与 exposed/online 跳过是同一条理由
    for (const c of this.deck.cells) {
      acc(c.occupied ? 1 : 0);
      acc(c.content);
      acc(c.supportType);
      acc((c.turretOffset * 180) / Math.PI);
      acc(c.towerType);
      acc(c.level);
      acc(c.cooldown * 100);
      acc(c.ammo);
      acc(c.reloadLeft * 100);
      // 与同组另外四项一样放大 100 倍:acc 内部量化到 1/8,不放大的话热量分辨率只有 0.125,
      // 而电弧塔一帧的降温量(coolPerSec/60)比这还小 —— 差一帧的热量会从确定性口径下漏掉
      acc(c.heat * 100);
      acc(c.coolLock * 100);
      acc(c.charge * 100);
    }
    // 四舷惩罚剩余秒紧跟着甲板:它是逐帧演化出来的状态(受击置位 + 每帧减 dt),不是任何东西的派生量 ——
    // 漏了它,"某一舷的射速惩罚早退了一帧"这类分叉就从确定性口径下漏掉,而它恰恰决定了下一帧谁打得快。
    // × 100 的理由与冷却/装填/热量那批秒数字段一字同源:acc 内部量化到 1/8,不放大的话
    // 0.5s 量级的计时器分辨率只有 0.125,差一两帧根本看不出来
    for (let e = 0; e < this.edgePenalty.length; e++) acc(this.edgePenalty[e]! * 100);
    for (const e of this.enemies.items) {
      acc(e.x);
      acc(e.y);
      // 型号与血量也进哈希:否则"出怪混型错位"或"伤害算错"这两类回归会从确定性口径下漏掉
      acc(e.kind);
      acc(e.hp);
      // 无敌帧剩余秒同理是逐帧演化的状态:它决定"这一口该不该咬",漏了它,
      // "结算间隔算错"就只会在血条上慢慢体现,而不会当场炸出一次确定性分叉。× 100 同上
      acc(e.hitCd * 100);
    }
    // 子弹**只哈位置**:伤害/存活/穿透都是发射那一刻定死的常量(见 sim/bullet.ts),
    // 而位置已经能抓住任何弹道分叉 —— 多哈几个不会变的数只是把同一件事哈好几遍。
    for (const b of this.bullets.items) {
      acc(b.x);
      acc(b.y);
    }
    // FxEvent 一律**不进** checksum:它纯是表现(少画一条闪电不改变世界的下一帧),
    // 混进来只会让"渲染改一下淡出时长"看起来像一次确定性回归。broadside 同理是本帧的表现读数。
    return (h >>> 0).toString(16).padStart(8, '0');
  }
}
