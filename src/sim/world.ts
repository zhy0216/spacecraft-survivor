/**
 * 世界状态与规则 —— 纯逻辑层。
 * 铁律:本目录永不 import pixi/DOM。这换来:同 seed 确定性、Node 里可单测、渲染可替换。
 *
 * 当前内容 = 玩家船(02)+ 01 号 issue 的压测场景:
 *   一艘玩家船(输入只以纯数据 ShipCommand 从外部灌入,sim 永不读键盘),
 *   N 个"敌人"追船(转向力 + 空间哈希邻居分离),M 颗子弹直线飞行、出界后确定性重生。
 * 后续 issue 在此基础上替换:敌人行为 → 四种 MVP 敌(07),场地边界 → 真地图规则(08)。
 */
import { SIM_DT } from '../core/loop';
import { Pool } from '../core/pool';
import { Rng } from '../core/rng';
import { SpatialHash } from '../core/spatialHash';
import { tuning } from './config';
import { createShip, type Ship, type ShipCommand, stepShip } from './ship';

/** 无输入的默认指令:让不接线输入的调用方(单测、无头跑批)照常 world.step() */
const IDLE: ShipCommand = { desiredHeading: null };

/** 压测场地半径(逻辑坐标,原点为场心) */
export const WORLD_RADIUS = 1200;

/** 期望速度的追随系数(1/s),转向力寻路的最小形式(GDD §13:无 A*) */
const SEEK_ACCEL = 6;

/** px/py = 上一逻辑帧位置,渲染层据此插值 */
export interface Enemy {
  x: number;
  y: number;
  px: number;
  py: number;
  vx: number;
  vy: number;
}

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

  private scratch: Enemy[] = [];

  constructor(seed: number) {
    this.rng = new Rng(seed);
    this.enemies = new Pool<Enemy>(
      () => ({ x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0 }),
      (e) => {
        e.x = e.y = e.px = e.py = e.vx = e.vy = 0;
      },
    );
    this.bullets = new Pool<Bullet>(
      () => ({ x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0 }),
      (b) => {
        b.x = b.y = b.px = b.py = b.vx = b.vy = 0;
      },
    );
  }

  /**
   * @param cmd 本逻辑帧的输入(纯数据)。只读不缓存引用,调用方可以整局复用同一个对象;
   *   缺省 = 松手,让 world.step() 的既有调用方(单测、无头跑批)不必关心输入。
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

    // 敌人:追船 + 邻居分离。船坐标 hoist 出循环:1000 敌是本轮压测场景,
    // 热循环里每帧多两次属性穿透没必要
    const tx = ship.x;
    const ty = ship.y;
    const sep = tuning.enemySeparation;
    const follow = Math.min(1, SEEK_ACCEL * SIM_DT);
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i]!;
      e.px = e.x;
      e.py = e.y;

      const dx = tx - e.x;
      const dy = ty - e.y;
      const dist = Math.hypot(dx, dy) || 1;
      let dvx = (dx / dist) * tuning.enemySpeed;
      let dvy = (dy / dist) * tuning.enemySpeed;

      if (sep > 0) {
        this.grid.query(e.x, e.y, sep, this.scratch);
        for (let j = 0; j < this.scratch.length; j++) {
          const n = this.scratch[j]!;
          if (n === e) continue;
          const ox = e.x - n.x;
          const oy = e.y - n.y;
          const d2 = ox * ox + oy * oy;
          if (d2 >= sep * sep || d2 === 0) continue;
          const d = Math.sqrt(d2);
          const push = ((sep - d) / sep) * tuning.enemySpeed;
          dvx += (ox / d) * push;
          dvy += (oy / d) * push;
        }
      }

      e.vx += (dvx - e.vx) * follow;
      e.vy += (dvy - e.vy) * follow;
      e.x += e.vx * SIM_DT;
      e.y += e.vy * SIM_DT;
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
  }

  /** 让面板改数量即时生效:不足则补,超出则回收 */
  private syncCounts(): void {
    while (this.enemies.size < tuning.stressEnemies) this.spawnEnemy();
    while (this.enemies.size > tuning.stressEnemies) this.enemies.despawnAt(this.enemies.size - 1);
    while (this.bullets.size < tuning.stressBullets) this.resetBullet(this.bullets.spawn());
    while (this.bullets.size > tuning.stressBullets) this.bullets.despawnAt(this.bullets.size - 1);
  }

  private spawnEnemy(): void {
    const e = this.enemies.spawn();
    const a = this.rng.angle();
    const r = 300 + this.rng.next() * (WORLD_RADIUS - 300);
    e.x = e.px = Math.cos(a) * r;
    e.y = e.py = Math.sin(a) * r;
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
    for (const e of this.enemies.items) {
      acc(e.x);
      acc(e.y);
    }
    for (const b of this.bullets.items) {
      acc(b.x);
      acc(b.y);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }
}
