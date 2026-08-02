/**
 * 世界状态与规则 —— 纯逻辑层。
 * 铁律:本目录永不 import pixi/DOM。这换来:同 seed 确定性、Node 里可单测、渲染可替换。
 *
 * 当前内容 = 玩家船(02)+ 四型敌人(07)+ 01 号 issue 的压测子弹:
 *   一艘玩家船(输入只以纯数据 ShipCommand 从外部灌入,sim 永不读键盘),
 *   N 只按 tuning.enemyMix* 混出来的敌人,M 颗子弹直线飞行、出界后确定性重生。
 *
 * 分工:单只敌人的行为(追踪/绕行/冲锋状态机)在 sim/enemy.ts,本文件只做"世界这一层"的接线 ——
 * 出怪、邻居分离、积分位置、接触检测、死亡回收。拆开的理由是行为能脱开世界单测(见 enemy.test.ts),
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
import { tuning } from './config';
import { createDeck, type Deck, placeAt } from './deck';
import {
  applyDamage,
  createEnemy,
  type Enemy,
  initEnemy,
  resetEnemy,
  ST_APPROACH,
  stepEnemyBehavior,
} from './enemy';
import { createShip, type Ship, type ShipCommand, stepShip, type Vec2 } from './ship';

/** 渲染层与既有调用方都从 world 取 Enemy 类型,实体定义搬去 enemy.ts 后这条保持它们不破 */
export type { Enemy } from './enemy';

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

export interface Bullet {
  x: number;
  y: number;
  px: number;
  py: number;
  vx: number;
  vy: number;
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

  private scratch: Enemy[] = [];

  constructor(seed: number) {
    this.rng = new Rng(seed);
    this.enemies = new Pool<Enemy>(createEnemy, resetEnemy);
    this.bullets = new Pool<Bullet>(
      () => ({ x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0 }),
      (b) => {
        b.x = b.y = b.px = b.py = b.vx = b.vy = 0;
      },
    );
  }

  /** 开局至今的秒数。HP 时间缩放(GDD §14)的唯一时间源:挂在 tick 上才与 checksum 同口径 */
  get elapsed(): number {
    return this.tick * SIM_DT;
  }

  /**
   * @param cmd 本逻辑帧的输入(纯数据)。只读不缓存引用,调用方可以整局复用同一个对象;
   *   缺省 = 松手,让 world.step() 的既有调用方(单测、无头跑批)不必关心输入。
   *
   * 顺序定死(单测按此钉):船 → 贴边夹取 → 出怪 → 重建空间哈希 → 清 contacts →
   * 敌人 → 子弹 → 回收死者。出怪排在建哈希之前,新生的敌人当帧就参与分离;
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

    // 子弹:直线飞行,出界重生
    const bullets = this.bullets.items;
    const r2 = WORLD_RADIUS * WORLD_RADIUS;
    for (let i = 0; i < bullets.length; i++) {
      const b = bullets[i]!;
      b.px = b.x;
      b.py = b.y;
      b.x += b.vx * SIM_DT;
      b.y += b.vy * SIM_DT;
      if (b.x * b.x + b.y * b.y > r2) this.resetBullet(b);
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
   * @returns PLACE_* 理由码;被拒时世界一个字段都没动,ui 层照码说人话
   *
   * 它在 step() 之外改世界状态,与"面板改实体数量"同一个口径:一旦调用,
   * 之后的 checksum 不再与"同 seed 从头跑"可比(放置本身是确定性的,但它不在输入序列里)。
   * 10 号 issue 的"三选一 → 时停 → 放置"会把它收进正式流程,届时放置事件进输入序列,这条限制自动消失。
   */
  place(col: number, row: number, content: number): number {
    return placeAt(this.deck, col, row, content);
  }

  /** 让面板改数量即时生效:不足则补,超出则回收(清场不算击杀,故不走 reap 的挂钩) */
  private syncCounts(): void {
    while (this.enemies.size < tuning.stressEnemies) this.spawnEnemy();
    while (this.enemies.size > tuning.stressEnemies) this.enemies.despawnAt(this.enemies.size - 1);
    while (this.bullets.size < tuning.stressBullets) this.resetBullet(this.bullets.spawn());
    while (this.bullets.size > tuning.stressBullets) this.bullets.despawnAt(this.bullets.size - 1);
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

  private resetBullet(b: Bullet): void {
    const a = this.rng.angle();
    const r = Math.sqrt(this.rng.next()) * WORLD_RADIUS * 0.5;
    b.x = b.px = Math.cos(a) * r;
    b.y = b.py = Math.sin(a) * r;
    const dir = this.rng.angle();
    b.vx = Math.cos(dir) * tuning.bulletSpeed;
    b.vy = Math.sin(dir) * tuning.bulletSpeed;
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
    // exposed/online 是 occupied 的派生量,进哈希只是把同一件事哈两遍,故只累加 occupied 与 content
    for (const c of this.deck.cells) {
      acc(c.occupied ? 1 : 0);
      acc(c.content);
    }
    for (const e of this.enemies.items) {
      acc(e.x);
      acc(e.y);
      // 型号与血量也进哈希:否则"出怪混型错位"或"伤害算错"这两类回归会从确定性口径下漏掉
      acc(e.kind);
      acc(e.hp);
    }
    for (const b of this.bullets.items) {
      acc(b.x);
      acc(b.y);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }
}
