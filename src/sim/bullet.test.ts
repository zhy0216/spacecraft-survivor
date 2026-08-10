/**
 * 子弹的积分、命中、穿透与落点 AoE(05 号 issue T3)。
 * 这里只喂"一个子弹池 + 一个记账用的假 sink",不造 World、不造甲板、不造塔:
 * 子弹与世界之间只有 FireSink 那一道缝(见 sim/fx.ts),于是每一条命中规则都能被逐帧、
 * 逐只地钉死 —— 而这些规则恰恰是玩家唯一能感觉到的东西:
 * 打不打得中、穿不穿得过去、射程到哪儿为止、炸多大一片。
 *
 * 钉的几条(改坏就等于改坏了 05 的验收标准):
 *   直射弹每帧**最多命中一只 = 最近的那一只**,同距保留先到者(与 arc.ts 的 findArcTarget 同口径);
 *   穿透 = 扣一次次数 + 推出敌人判定圆外,**绝不在同一只身上逐帧重复命中**;
 *   life 是**射程上限的唯一表达**:飞满 射程/弹速 秒就回收,一帧不多一帧不少;
 *   抛射弹**途中一概不碰撞**,到期对圈内**全部**敌人结算,并无条件推一个 FXV_BLAST;
 *   零分配的可观测形式:子弹回收即复用、复用前逐字段清零,邻域查询的暂存是模块级复用的同一个数组。
 * 唯独"500 弹同屏 60fps"是真机浏览器的事,Node 里量不出帧率,不在这里假装验过。
 */
import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../core/loop';
import { Pool } from '../core/pool';
import { SpatialHash } from '../core/spatialHash';
import { ELITE } from '../data/affixes';
import { ENEMIES, ENEMY_RADIUS_MAX, KIND_BEETLE, KIND_SWARM } from '../data/enemies';
import { TOWER_AUTOCANNON, TOWER_MORTAR, TOWERS } from '../data/towers';
import {
  BK_DIRECT,
  BK_MORTAR,
  type Bullet,
  createBullet,
  resetBullet,
  stepBullets,
} from './bullet';
import { applyDamage, createEnemy, type Enemy } from './enemy';
import { type FireSink, FXV_BLAST, FXV_IMPACT } from './fx';

/** 蜂群蛭体型 7:下面所有"合并半径 = 3 + 7 = 10"的算术都从这里来,不写死 */
const R_SWARM = ENEMIES[KIND_SWARM]!.radius;
/** 弹丸半径:取机炮的表值,顺带证明这些用例算的是数值表里的那颗弹 */
const R_BULLET = TOWERS[TOWER_AUTOCANNON]!.bulletRadius;
/** 合并半径:命中判据的那个 r */
const R_HIT = R_BULLET + R_SWARM;

interface DamageLog {
  e: Enemy;
  amount: number;
}
interface FxLog {
  kind: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  radius: number;
  towerType: number;
  damage: number;
  dmgRatio: number;
}
interface QueryLog {
  x: number;
  y: number;
  r: number;
}

interface Harness {
  sink: FireSink;
  bullets: Pool<Bullet>;
  enemies: Enemy[];
  damages: DamageLog[];
  fxs: FxLog[];
  queries: QueryLog[];
  /** 每次 query 收到的那个 out 数组本身(不是它的内容):用来验"模块级复用,不每帧新建" */
  outs: Enemy[][];
  step(times?: number): void;
}

/**
 * 记账用的假 sink。子弹只经这一份契约与世界打交道,于是这里能把
 * "打了谁、扣了多少、推了什么可视化事件、问了多大半径的邻域"全部按顺序记下来。
 *
 * query 故意用**线性扫描**而不是真的空间哈希:哈希只是粗筛(按 cell 返回超集),
 * 精筛是 stepBullets 自己的活 —— 喂它一个"全世界都是候选"的最坏输入,才钉得住精筛这条规则。
 * damage 真的调 applyDamage:于是"本帧已被打死的不再吃伤害"这条能在同一套夹具里验。
 * 顺带照 World.damageEnemy 的口径把 lastHit 写给敌对象:飘字(FXV_IMPACT 的 damage 参数)
 * 读的就是它 —— 不写的话假 sink 里永远飘不出数字,这条链路在单测里就是死的。
 */
function harness(...enemies: Enemy[]): Harness {
  const bullets = new Pool<Bullet>(createBullet, resetBullet);
  const damages: DamageLog[] = [];
  const fxs: FxLog[] = [];
  const queries: QueryLog[] = [];
  const outs: Enemy[][] = [];

  const sink: FireSink = {
    spawnBullet: () => bullets.spawn(),
    damage: (e, amount) => {
      damages.push({ e, amount });
      e.lastHit = amount; // 与 World.damageEnemy 同一条"实际结算量写给敌对象"的口径
      return applyDamage(e, amount);
    },
    fx: (kind, x0, y0, x1, y1, radius, towerType, damage = 0, dmgRatio = 0) => {
      fxs.push({ kind, x0, y0, x1, y1, radius, towerType, damage, dmgRatio });
    },
    query: (x, y, r, out) => {
      queries.push({ x, y, r });
      outs.push(out);
      out.length = 0;
      for (const e of enemies) out.push(e);
    },
    fired: () => {},
  };

  return {
    sink,
    bullets,
    enemies,
    damages,
    fxs,
    queries,
    outs,
    step(times = 1) {
      for (let i = 0; i < times; i++) stepBullets(bullets, SIM_DT, sink);
    },
  };
}

/** 一只钉在某处的敌人。血厚到打不死:命中规则的用例不该被"死者不再吃伤害"那条顺手影响 */
function enemyAt(kind: number, x: number, y: number): Enemy {
  const e = createEnemy();
  e.kind = kind;
  e.x = e.px = x;
  e.y = e.py = y;
  e.hp = e.maxHp = 1e6;
  return e;
}

/**
 * 出一发弹。字段由用例按需覆写,其余走 createBullet 的零值 ——
 * 与 sim/turret.ts 开火时"从池里取一颗已清零的弹,当场把字段填满"的口径一致。
 */
function fire(h: Harness, fields: Partial<Bullet>): Bullet {
  const b = h.sink.spawnBullet();
  Object.assign(b, fields);
  b.px = b.x;
  b.py = b.y;
  return b;
}

/** 一发朝 +X、每帧走 10px 的机炮直射弹(弹速 600 是为了让"每帧 10px"这条算术一眼看得懂) */
function directBullet(h: Harness, fields: Partial<Bullet> = {}): Bullet {
  return fire(h, {
    kind: BK_DIRECT,
    x: 0,
    y: 0,
    vx: 600,
    vy: 0,
    damage: 6,
    life: 10,
    radius: R_BULLET,
    towerType: TOWER_AUTOCANNON,
    ...fields,
  });
}

describe('直射弹命中(每帧最多一只 = 最近的那一只)', () => {
  it('射程内挤着三只 → 只有最近的那只吃伤害,其余的连一滴血都不掉', () => {
    // 全部落在弹丸落点(10, 0)的合并半径 10 之内:三只都"够得着",判据只剩远近
    const far = enemyAt(KIND_SWARM, 18, 0); // d = 8
    const near = enemyAt(KIND_SWARM, 14, 0); // d = 4 ← 最近
    const side = enemyAt(KIND_SWARM, 10, 6); // d = 6
    const h = harness(far, near, side);
    const b = directBullet(h, { damage: 6 });

    h.step();

    expect(h.damages.length).toBe(1); // 不是"扫过一条线打一片" —— 那等于白送一次 AoE
    expect(h.damages[0]!.e).toBe(near);
    expect(h.damages[0]!.amount).toBe(6); // 伤害 = 发射那一刻定死的 b.damage,不回查塔
    expect(h.fxs.map((fx) => fx.kind)).toEqual([FXV_IMPACT]);
    // 飘字携带实际结算伤害与相对满血的比例(渲染层配色用):与 damage 同量、ratio = 6/maxHp
    expect(h.fxs[0]!.damage).toBe(6);
    expect(h.fxs[0]!.dmgRatio).toBeCloseTo(6 / near.maxHp, 9);
    expect(far.hp).toBe(far.maxHp);
    expect(side.hp).toBe(side.maxHp);
    expect(h.bullets.size).toBe(0); // 不穿透 → 命中即回收
    expect(b.pierce).toBe(0);
  });

  it('两只等距 → 严格 < 才替换,保留候选里先到的那一只(顺序确定 ⇒ 命中确定)', () => {
    const first = enemyAt(KIND_SWARM, 10, 5);
    const second = enemyAt(KIND_SWARM, 10, -5);
    const a = harness(first, second);
    directBullet(a);
    a.step();
    expect(a.damages.map((d) => d.e)).toEqual([first]);

    // 同一构型、只把候选顺序调个个儿:命中随之换人 —— 证明决定权在"先到者"而不是坐标符号,
    // 也证明这条规则是确定的(候选顺序由上游定死,同 seed 必然复现)
    const b = harness(second, first);
    directBullet(b);
    b.step();
    expect(b.damages.map((d) => d.e)).toEqual([second]);
  });

  it('判据含边界:恰好贴上算命中,差千分之一就当没看见(与 findArcTarget 的射程圆同口径)', () => {
    const onEdge = enemyAt(KIND_SWARM, 10 + R_HIT, 0);
    const hit = harness(onEdge);
    directBullet(hit);
    hit.step();
    expect(hit.damages.length).toBe(1);

    const justOut = enemyAt(KIND_SWARM, 10 + R_HIT + 0.001, 0);
    const miss = harness(justOut);
    miss.step(); // 空过一帧:池里还没有弹,不该有任何查询
    expect(miss.queries.length).toBe(0);
    directBullet(miss);
    miss.step();
    expect(miss.damages.length).toBe(0);
    expect(miss.bullets.size).toBe(1); // 没命中就继续飞,不是"擦边即回收"
  });

  it('本帧已被打死的不再吃伤害:火力自动落到下一只活人身上', () => {
    const corpse = enemyAt(KIND_SWARM, 12, 0); // 最近,但已经是尸体
    const alive = enemyAt(KIND_SWARM, 16, 0);
    const h = harness(corpse, alive);
    expect(applyDamage(corpse, corpse.hp)).toBe(true);

    directBullet(h);
    h.step();

    expect(h.damages.map((d) => d.e)).toEqual([alive]);
    // 尸体整帧都还在场上(回收在 World.step 末尾),但一发都不该再吃 ——
    // 否则 10 号 issue 的掉落会按命中数重复给,kills 也会虚高
    expect(corpse.hp).toBe(0);
  });

  it('px/py = 上一逻辑帧位置,x/y = v × dt 的积分(铁律 2:渲染插值的两端)', () => {
    const h = harness();
    const b = directBullet(h, { vx: 600, vy: 300 });
    h.step();
    expect(b.px).toBe(0);
    expect(b.py).toBe(0);
    expect(b.x).toBeCloseTo(600 * SIM_DT, 12);
    expect(b.y).toBeCloseTo(300 * SIM_DT, 12);
  });
});

describe('穿透(pierce)', () => {
  it('穿一层:命中后扣次数并被推出敌人圆外,下一帧接着打第二只', () => {
    const first = enemyAt(KIND_SWARM, 10, 0);
    const second = enemyAt(KIND_SWARM, 40, 0);
    const h = harness(first, second);
    const b = directBullet(h, { pierce: 1 });

    h.step(); // 落点正压在 first 的中心
    expect(h.damages.map((d) => d.e)).toEqual([first]);
    expect(b.pierce).toBe(0);
    expect(h.bullets.size).toBe(1); // 穿过去了,没被回收
    // 被推到 first 的判定圆外:下一帧就算 first 一动不动,也不会再挨同一颗弹
    expect(Math.hypot(b.x - first.x, b.y - first.y)).toBeGreaterThan(R_HIT);
    expect(b.x).toBeGreaterThan(10); // 沿速度方向推,不是被弹回去

    h.step(); // 30px 处 → 离 second 恰好 10 = 合并半径
    expect(h.damages.map((d) => d.e)).toEqual([first, second]);
    expect(h.bullets.size).toBe(0); // 穿透用光 → 命中即回收
  });

  it('穿透次数用光之前也绝不在同一只身上打第二次(推出圆外,而不是给敌人加 id)', () => {
    // 甲虫体型 14 + 弹半径 3 = 17,而这颗弹每帧只走 1px:不推出圆外的话,
    // 它会赖在这只身上把三次穿透一帧一帧全白送出去
    const beetle = enemyAt(KIND_BEETLE, 0, 0);
    const r = R_BULLET + ENEMIES[KIND_BEETLE]!.radius;
    const h = harness(beetle);
    const b = directBullet(h, { x: -r, vx: 60, pierce: 3 });

    h.step(20);

    expect(h.damages.length).toBe(1);
    expect(b.pierce).toBe(2);
    expect(b.x).toBeGreaterThan(r); // 已经在另一侧,而且越飞越远
    expect(h.bullets.size).toBe(1);
  });

  it('速度为 0 的弹推不出去 → 命中后直接回收(否则它会赖在原地逐帧白打)', () => {
    const e = enemyAt(KIND_SWARM, 0, 0);
    const h = harness(e);
    directBullet(h, { vx: 0, vy: 0, pierce: 5 });

    h.step(3);

    expect(h.damages.length).toBe(1);
    expect(h.bullets.size).toBe(0);
  });
});

describe('射程上限(life 是它的唯一表达)', () => {
  it('机炮的锚点数值(GDD §14:射程 380 / 弹速 420)→ 飞满射程那一帧回收,一帧不多不少', () => {
    const def = TOWERS[TOWER_AUTOCANNON]!;
    const life = def.range / def.bulletSpeed; // 开火方就是这么算 life 的
    const frames = Math.ceil(life / SIM_DT);
    const h = harness();
    const b = directBullet(h, { vx: def.bulletSpeed, life, radius: def.bulletRadius });

    h.step(frames - 1);
    expect(h.bullets.size).toBe(1);
    // 差一帧到期时还没飞满射程 —— 这条对照保证下面那句不是"早就该死了才刚好死"
    expect(b.x).toBeLessThan(def.range);
    const before = b.x;

    h.step();
    expect(h.bullets.size).toBe(0);
    // 收尾位置刚跨过射程线,且超出不到一帧的位移:射程上限就是这条,不必再逐帧量距离
    expect(before + def.bulletSpeed * SIM_DT).toBeGreaterThanOrEqual(def.range);
    expect(before + def.bulletSpeed * SIM_DT).toBeLessThan(def.range + def.bulletSpeed * SIM_DT);
  });

  it('life = 整数帧时恰好活那么多帧(浮点累减的 ±1e-17 残差被 LIFE_EPS 兜住)', () => {
    const h = harness();
    directBullet(h, { life: 30 * SIM_DT });
    h.step(29);
    expect(h.bullets.size).toBe(1);
    h.step();
    expect(h.bullets.size).toBe(0);
  });

  it('到期那一帧仍然判命中:最后一段位移里撞上的人不该白撞', () => {
    const e = enemyAt(KIND_SWARM, 10, 0);
    const h = harness(e);
    directBullet(h, { life: SIM_DT });

    h.step();

    expect(h.damages.map((d) => d.e)).toEqual([e]);
    expect(h.bullets.size).toBe(0);
  });

  it('同帧到期一片(含末尾与相邻)一个不漏,活着的一颗不误伤 —— 倒序 swap-remove 的下标坑', () => {
    const h = harness();
    const doomed = [0, 3, 4];
    const all: Bullet[] = [];
    for (let i = 0; i < 5; i++) {
      all.push(directBullet(h, { y: i * 100, life: doomed.includes(i) ? SIM_DT : 10 }));
    }

    h.step();

    expect(h.bullets.size).toBe(2);
    expect(new Set(h.bullets.items)).toEqual(new Set([all[1]!, all[2]!]));
  });
});

describe('抛射弹(BK_MORTAR):途中不碰撞,落点炸一片', () => {
  /** 迫击炮的表值:AoE 半径/伤害/弹速全从数值表来,改表即改平衡(05 验收标准第三条) */
  const MORTAR = TOWERS[TOWER_MORTAR]!;
  const R_BLAST = MORTAR.aoeRadius + R_SWARM;

  /** 一发飞 60 帧、落在 (600, 0) 的迫击炮弹 */
  function mortarBullet(h: Harness): Bullet {
    return fire(h, {
      kind: BK_MORTAR,
      x: 0,
      y: 0,
      vx: 600,
      vy: 0,
      damage: 0, // 直击不结算:伤害全在落点(见 data/towers 里迫击炮那一行)
      life: 60 * SIM_DT,
      radius: MORTAR.bulletRadius,
      aoeRadius: MORTAR.aoeRadius,
      aoeDamage: MORTAR.aoeDamage,
      towerType: TOWER_MORTAR,
    });
  }

  it('越过前排:途中从人堆正中穿过去也一滴血不掉,一次邻域查询都不问', () => {
    const enRoute = enemyAt(KIND_SWARM, 100, 0); // 第 10 帧正压在它身上
    const h = harness(enRoute);
    mortarBullet(h);

    h.step(59);

    expect(h.damages.length).toBe(0);
    expect(h.fxs.length).toBe(0);
    expect(h.queries.length).toBe(0); // 途中连查都不查 —— 这就是"不碰撞"最省的写法
    expect(h.bullets.size).toBe(1);
  });

  it('落点 AoE:圈内**全部**敌人吃满,含边界;圈外的与途经的一律不吃', () => {
    const enRoute = enemyAt(KIND_SWARM, 100, 0); // 途经点,离爆心 500,与这一发无关
    const center = enemyAt(KIND_SWARM, 600, 0);
    const onEdge = enemyAt(KIND_SWARM, 600, R_BLAST); // 恰好 aoeRadius + 体型
    const justOut = enemyAt(KIND_SWARM, 600, R_BLAST + 0.001);
    const h = harness(enRoute, center, onEdge, justOut);
    mortarBullet(h);

    h.step(60);

    // 全部 —— 不像直射弹只取最近的一只,这就是 AoE 与直射的机制差别
    expect(new Set(h.damages.map((d) => d.e))).toEqual(new Set([center, onEdge]));
    for (const d of h.damages) expect(d.amount).toBe(MORTAR.aoeDamage);
    expect(enRoute.hp).toBe(enRoute.maxHp);
    expect(justOut.hp).toBe(justOut.maxHp);
    expect(h.bullets.size).toBe(0); // 炸完就回收
  });

  it('无条件推一个 FXV_BLAST(爆心/半径/塔型都对得上),哪怕一个人都没炸到', () => {
    const h = harness();
    mortarBullet(h);
    h.step(60);

    expect(h.fxs.length).toBe(1);
    const fx = h.fxs[0]!;
    expect(fx.kind).toBe(FXV_BLAST);
    // 爆心:x0/y0 与 x1/y1 相同(FXV_BLAST 没有"终点"这个概念)
    expect(fx.x0).toBeCloseTo(600, 9);
    expect(fx.y0).toBe(0);
    expect(fx.x1).toBe(fx.x0);
    expect(fx.y1).toBe(fx.y0);
    // 画出来的圈 = 真的炸到的那个圈:射界叠加层"可视化 = 实际作用范围"的口径在这一层也成立
    expect(fx.radius).toBe(MORTAR.aoeRadius);
    expect(fx.towerType).toBe(TOWER_MORTAR);
  });

  it('落点的死者不吃伤害(同帧被别人打死的不该再算一次)', () => {
    const corpse = enemyAt(KIND_SWARM, 600, 0);
    const alive = enemyAt(KIND_SWARM, 600, 20);
    const h = harness(corpse, alive);
    expect(applyDamage(corpse, corpse.hp)).toBe(true);
    mortarBullet(h);

    h.step(60);

    expect(h.damages.map((d) => d.e)).toEqual([alive]);
  });
});

describe('邻域查询的口径(GDD §13)', () => {
  it('直射弹的查询半径 = 弹半径 + 最大敌半径(精英按体型放大),**不超过一个 cell**', () => {
    const h = harness(enemyAt(KIND_SWARM, 500, 0));
    const b = directBullet(h);
    h.step();

    expect(h.queries.length).toBe(1);
    const q = h.queries[0]!;
    // 场上最大的判定体是精英(1.5× 体型):查询半径必须盖得住它,否则精英身体压着圈的
    // 那一截会整个落在没被访问的 cell 里(见 bullet.ts 的 hitDirect)
    expect(q.r).toBe(R_BULLET + ENEMY_RADIUS_MAX * ELITE.scale);
    // 空间哈希的 cell = 最大敌半径 ×2(见 world.ts 的 grid)。查询半径一旦超过一个 cell,
    // 3×3 邻域就不再必然覆盖,哈希会开始悄悄漏人 —— 这条是那个前提的守门员
    expect(q.r).toBeLessThan(ENEMY_RADIUS_MAX * 2);
    // 以弹丸**本帧的新位置**为心(不是帧首位置):命中判的就是这一帧它在哪
    expect(q.x).toBeCloseTo(b.x, 12);
    expect(q.y).toBeCloseTo(b.y, 12);
  });

  it('落点 AoE 是唯一一次超过一个 cell 的查询,且只在到期那一帧问一次', () => {
    const h = harness();
    fire(h, {
      kind: BK_MORTAR,
      vx: 600,
      life: 5 * SIM_DT,
      aoeRadius: TOWERS[TOWER_MORTAR]!.aoeRadius,
      towerType: TOWER_MORTAR,
    });

    h.step(4);
    expect(h.queries.length).toBe(0);
    h.step();
    expect(h.queries.length).toBe(1);
    // 粗筛半径 = AoE 半径 + 最大敌半径(精英按体型放大):判据是"体型碰到圈",而哈希按
    // cell 的 AABB 返超集,少了这一截就会漏掉圆心在圈外、身体压在圈上的那只
    // (下一条用真哈希把它钉死)
    expect(h.queries[0]!.r).toBe(TOWERS[TOWER_MORTAR]!.aoeRadius + ENEMY_RADIUS_MAX * ELITE.scale);
    expect(h.queries[0]!.r).toBeGreaterThan(ENEMY_RADIUS_MAX * 2); // 有意的例外,理由见 bullet.ts
  });

  it('落点 AoE 接真空间哈希:圆心在圈外、身体压在圈上的那只照样吃满(粗筛半径的回归)', () => {
    // 上面所有用例的假 sink 都"全世界皆候选",钉不住粗筛半径够不够 —— 这条换成真的哈希。
    // 构型是算出来的最坏对齐:cell = 28,爆心 21 → 只问 90 时最远只访问到 cell 3([84,112)),
    // 而甲虫在 124(cell 4),d = 103 ≤ 90 + 14 = 104 本该被炸到。
    // 少了 + ENEMY_RADIUS_MAX 这一截,它就整个落在从没被访问的 cell 里,静悄悄不掉血
    const grid = new SpatialHash<Enemy>(ENEMY_RADIUS_MAX * 2);
    const beetle = enemyAt(KIND_BEETLE, 124, 0);
    expect(Math.hypot(beetle.x - 21, beetle.y)).toBeLessThanOrEqual(
      TOWERS[TOWER_MORTAR]!.aoeRadius + ENEMIES[KIND_BEETLE]!.radius,
    );
    grid.insert(beetle);

    const bullets = new Pool<Bullet>(createBullet, resetBullet);
    const damages: DamageLog[] = [];
    const sink: FireSink = {
      spawnBullet: () => bullets.spawn(),
      damage: (e, amount) => {
        damages.push({ e, amount });
        return applyDamage(e, amount);
      },
      fx: () => {},
      query: (x, y, r, out) => {
        grid.query(x, y, r, out);
      },
      fired: () => {},
    };

    const b = bullets.spawn();
    b.kind = BK_MORTAR;
    b.x = b.px = 21;
    b.life = SIM_DT; // 原地待爆:这条验的是落点结算,不是弹道
    b.aoeRadius = TOWERS[TOWER_MORTAR]!.aoeRadius;
    b.aoeDamage = TOWERS[TOWER_MORTAR]!.aoeDamage;
    b.towerType = TOWER_MORTAR;

    stepBullets(bullets, SIM_DT, sink);

    expect(damages.map((d) => d.e)).toEqual([beetle]);
    expect(bullets.size).toBe(0);
  });
});

describe('对象池与零分配(500 弹同屏的结构前提)', () => {
  it('回收进池的子弹被下一发复用,且复用前逐字段清回初值', () => {
    const h = harness(enemyAt(KIND_SWARM, 10, 0));
    const first = directBullet(h, { pierce: 2, aoeRadius: 90, damage: 6 });
    h.step(); // 命中 → 穿透 -1
    h.step(); // 飞走
    expect(h.bullets.size).toBe(1);
    h.step(20); // life 走完(10s 太长,直接把它打发掉)
    first.life = 0;
    h.step();
    expect(h.bullets.size).toBe(0);

    const second = h.sink.spawnBullet();
    expect(second).toBe(first); // 同一个对象:没有 new 出新的,这就是"回收进池"的证据
    // 复用前走了 resetBullet:上一发的穿透次数/AoE 半径/伤害一个都没带过来
    expect(second).toEqual(createBullet());
  });

  it('resetBullet:Object.keys 的每个字段都清回初值 —— 将来加字段忘了重置会被这条抓住', () => {
    const b = createBullet();
    const rec = b as unknown as Record<string, number>;
    const initial = { ...rec }; // createBullet() 的返回值即"初值"的定义
    const keys = Object.keys(rec);
    expect(keys.length).toBeGreaterThan(0);

    for (const k of keys) {
      rec[k] = rec[k]! + 13; // 逐字段弄脏,保证断言不会空过
      expect(rec[k]).not.toBe(initial[k]);
    }

    resetBullet(b);
    for (const k of keys) expect(rec[k]).toBe(initial[k]);
  });

  it('邻域查询的暂存是模块级复用的同一个数组,且出函数前清空(不替对象池扣着过期引用)', () => {
    const h = harness(enemyAt(KIND_SWARM, 900, 0));
    for (let i = 0; i < 4; i++) directBullet(h, { y: i * 50 });

    h.step(3);

    expect(h.queries.length).toBe(12); // 4 颗 × 3 帧,一颗一次,不多问
    expect(new Set(h.outs).size).toBe(1); // 十二次查询用的是同一个数组对象
    // 出函数前清空:里面装的是池中对象,敌人一回收,同一个对象下一帧就是另一只
    expect(h.outs[0]!.length).toBe(0);
  });

  it('空池的一帧什么都不做(压测里没塔的甲板不该为子弹白掏任何开销)', () => {
    const h = harness(enemyAt(KIND_SWARM, 0, 0));
    h.step(10);
    expect(h.queries.length).toBe(0);
    expect(h.damages.length).toBe(0);
    expect(h.fxs.length).toBe(0);
  });
});
