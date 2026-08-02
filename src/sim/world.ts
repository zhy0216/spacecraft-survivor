/**
 * 世界状态与规则 —— 纯逻辑层。
 * 铁律:本目录永不 import pixi/DOM。这换来:同 seed 确定性、Node 里可单测、渲染可替换。
 *
 * 当前内容 = 玩家船(02)+ 四型敌人(07)+ 武器塔与它们打出来的子弹(05):
 *   一艘玩家船(输入只以纯数据 ShipCommand 从外部灌入,sim 永不读键盘),
 *   N 只按 tuning.enemyMix* 混出来的敌人,以及甲板上的塔真的开火产生的子弹与可视化事件。
 *
 * 01 号 issue 那批"凭空重生的压测哑弹"在 05 号整段删除:哑弹与真弹共用一个池,
 * "500 弹同屏不掉帧"这条验收测的就是假东西 —— 500 弹现在得由塔真的打出来才算数。
 *
 * 分工:单只敌人的行为(追踪/绕行/冲锋状态机)在 sim/enemy.ts,炮管的追瞄与归位在 sim/turret.ts,
 * 子弹的积分与命中在 sim/bullet.ts,本文件只做"世界这一层"的接线 ——
 * 出怪、邻居分离、积分位置、接触检测、开火的去处(FireSink)、事件老化、死亡回收。
 * 拆开的理由是它们能脱开世界单测(见 enemy.test.ts / turret.test.ts / bullet.test.ts),
 * 而这里钉的是顺序与生命周期。
 *
 * 本文件对后续 issue 只留挂钩、不抢活:contacts 交给 09(伤害/无敌帧/四舷),
 * onEnemyDeath 交给 10(残骸掉落),出怪器交给 08(波次脚本)。
 */
import { SIM_DT } from '../core/loop';
import { Pool } from '../core/pool';
import { Rng } from '../core/rng';
import { SpatialHash } from '../core/spatialHash';
import { ENEMIES, KIND_BEETLE, KIND_STRAFER, KIND_SWARM, KIND_TRAILER } from '../data/enemies';
import {
  FX_LIFE_BEAM,
  FX_LIFE_BLAST,
  FX_LIFE_CHAIN,
  FX_LIFE_LANCE,
  TOWER_AUTOCANNON,
} from '../data/towers';
import { type Bullet, createBullet, resetBullet, stepBullets } from './bullet';
import { tuning } from './config';
import { createDeck, type Deck, EDGE_COUNT, placeAt } from './deck';
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
  type FireSink,
  type FxEvent,
  FXV_BLAST,
  FXV_CHAIN,
  FXV_LANCE,
  resetFxEvent,
} from './fx';
import { createShip, type Ship, type ShipCommand, stepShip, type Vec2 } from './ship';
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
 * 可视化事件的存续秒数:一律取 data/towers 的 FX_LIFE_*(渲染层读的是同一组常量,
 * 两边才不会各算各的淡出时长)。
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
    default:
      return FX_LIFE_BEAM;
  }
}

/**
 * 这一格算哪一舷:取暴露边掩码的**最低位**那条边(BOW < STARBOARD < STERN < PORT)。
 * 角落格有两条暴露边,总得挑一条 —— 挑最低位与 sim/arc.ts 退化分支的口径一致(那里也是
 * "最低位的那条暴露边"),两处对"这格朝哪"的回答才不会分裂。
 * 09 号 issue 的四舷方位角判定接手后统一到那一份口径上,这个函数届时作废。
 * @returns EDGE_*;没有暴露边(内部格/离线塔)返回 -1
 */
function lowestEdge(exposed: number): number {
  for (let e = 0; e < EDGE_COUNT; e++) {
    if ((exposed & (1 << e)) !== 0) return e;
  }
  return -1;
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
   * 本帧贴到船身的敌人。**只检测不结算**:伤害/无敌帧/四舷判定是 09 号 issue 的活,
   * 现在先把"谁贴上来了"这件事以零成本(敌人循环里顺手一次距离判断)交出去。
   * 每帧在敌人循环前清空;元素是池中对象,step() 返回后立刻读,别跨帧存引用 ——
   * 死者回池后同一个对象会变成另一只敌人。
   */
  readonly contacts: Enemy[] = [];

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
      const edge = lowestEdge(cell.exposed);
      // 没有暴露边 = 离线塔,本就打不响;真进来了也不该算进齐射(那会让 broadsideEdge 变成瞎猜)
      if (edge < 0) return;
      const n = this.edgeFires[edge]! + 1;
      this.edgeFires[edge] = n;
      // 严格 > 才换舷 = 平局保留先到的那一舷(edge 顺序固定 ⇒ 结果确定),与索敌的"保留先到者"同口径
      if (n > this.broadsideCount) {
        this.broadsideCount = n;
        this.broadsideEdge = edge;
      }
    },
  };

  constructor(seed: number) {
    this.rng = new Rng(seed);
    this.enemies = new Pool<Enemy>(createEnemy, resetEnemy);
    this.bullets = new Pool<Bullet>(createBullet, resetBullet);
  }

  /** 开局至今的秒数。HP 时间缩放(GDD §14)的唯一时间源:挂在 tick 上才与 checksum 同口径 */
  get elapsed(): number {
    return this.tick * SIM_DT;
  }

  /**
   * @param cmd 本逻辑帧的输入(纯数据)。只读不缓存引用,调用方可以整局复用同一个对象;
   *   缺省 = 松手,让 world.step() 的既有调用方(单测、无头跑批)不必关心输入。
   *
   * 顺序定死(单测按此钉):船 → 贴边夹取 → 出怪 → 重建空间哈希 → 清 contacts / 清 broadside →
   * 敌人 → 炮管(含节流与开火)→ 子弹 → 可视化事件老化 → 回收死者。
   * 出怪排在建哈希之前,新生的敌人当帧就参与分离;
   * 炮管排在敌人循环**之后**:敌人本帧已经动完,塔瞄的就是本帧位置 ——
   * 反过来的话每座塔都恒定落后一帧,贴脸高速目标会永远被瞄在身后(04 号 issue);
   * 子弹排在炮管之后,于是本帧新出膛的弹当帧就走一步、px/py 停在炮口
   *(与"出怪排在建哈希之前、新生敌人当帧就动"同一条口径);
   * 回收排在最后,于是"本帧被打死的敌人"在整帧里始终可见(渲染/结算读到的是同一批人)。
   */
  step(cmd: ShipCommand = IDLE): void {
    this.tick++;

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
    const contactR = tuning.shipContactRadius;

    this.contacts.length = 0;
    // broadside 与 contacts 同口径:逐帧重建的"这一帧发生了什么",在敌人循环之前就清干净,
    // 于是一帧都没塔开火时读到的是 -1/0,而不是上一帧的齐射(见字段注释)
    this.broadsideEdge = -1;
    this.broadsideCount = 0;
    for (let e = 0; e < this.edgeFires.length; e++) this.edgeFires[e] = 0;

    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i]!;
      e.px = e.x;
      e.py = e.y;
      const def = ENEMIES[e.kind]!;

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

      // 接触检测:船体判定圆(09 号 issue 换成固定核心区)+ 敌人体型。
      // 只登记,不扣血、不弹开、不消灭 —— 结算全在 09,这里多做一步都会跟它打架
      const cdx = e.x - tx;
      const cdy = e.y - ty;
      const cr = contactR + def.radius;
      if (cdx * cdx + cdy * cdy < cr * cr) this.contacts.push(e);
    }

    // 炮管:朝射界内最近的敌人转,没得打就归位(04 号 issue),够得着又转得过来就开火(05 号)。
    // 传 this.grid 而不是 enemies:1000 敌 × 十座塔的线性扫描是 GDD §13 明令要用哈希避开的那件事;
    // 传 this.sink 而不是 this:开火侧只认识 FireSink 那份契约,永远不认识 World(见 sim/fx.ts)
    stepTurrets(this.deck, ship, this.grid, SIM_DT, this.sink);

    // 子弹:积分 → 命中 → 迫击炮到期在落点炸 AoE(规则全在 sim/bullet.ts,本文件只给它一个 sink)
    stepBullets(this.bullets, SIM_DT, this.sink);

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
   * @returns PLACE_* 理由码;被拒时世界一个字段都没动,ui 层照码说人话(成功判定用 isPlaceSuccess)
   *
   * 它在 step() 之外改世界状态,与"面板改实体数量"同一个口径:一旦调用,
   * 之后的 checksum 不再与"同 seed 从头跑"可比(放置本身是确定性的,但它不在输入序列里)。
   * 10 号 issue 的"三选一 → 时停 → 放置"会把它收进正式流程,届时放置事件进输入序列,这条限制自动消失。
   */
  place(col: number, row: number, content: number, towerType: number = TOWER_AUTOCANNON): number {
    return placeAt(this.deck, col, row, content, towerType);
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
    for (const c of this.deck.cells) {
      acc(c.occupied ? 1 : 0);
      acc(c.content);
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
    for (const e of this.enemies.items) {
      acc(e.x);
      acc(e.y);
      // 型号与血量也进哈希:否则"出怪混型错位"或"伤害算错"这两类回归会从确定性口径下漏掉
      acc(e.kind);
      acc(e.hp);
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
