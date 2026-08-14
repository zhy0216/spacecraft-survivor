/**
 * 开火分派与五种弹道的直测(二轮审查补 —— 此前 turretFire.ts 零直接测试,
 * 星级系统刚改写过的 star→伤害接线与链跳/线段几何全靠世界级集成测试间接覆盖)。
 * 全部 Node 直测:FireSink 是记录桩,子弹走真对象池 —— 五条弹道的几何与定值
 * 在这里逐位钉死,不装 jsdom、不跑一帧世界。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SIM_DT } from '../core/loop';
import { Pool } from '../core/pool';
import { KIND_BOSS, KIND_SWARM } from '../data/enemies';
import {
  TOWER_ARC,
  TOWER_AURORA,
  TOWER_AUTOCANNON,
  TOWER_LASER,
  TOWER_MORTAR,
  TOWER_PD,
  TOWER_RAILGUN,
  TOWER_STORM_CANNON,
  TOWERS,
  towerChainCount,
  towerPierce,
  towerRange,
  type TowerDef,
} from '../data/towers';
import { createWeaponSlots, type WeaponSlot } from './armory';
import { BK_DIRECT, BK_MORTAR, createBullet, resetBullet, stepBullets, type Bullet } from './bullet';
import { createEnemy, enemyRadius, type Enemy } from './enemy';
import { FXV_BEAM, FXV_CHAIN, FXV_LANCE, type FireSink } from './fx';
import { effectiveAoeDamage, effectiveDamage, slotShotsPerFire } from './tower';
import { candidates, fire, muzzle, projectileBarrelOffset } from './turretFire';

interface Hit {
  e: Enemy;
  amount: number;
  throttle?: number;
  towerType?: number;
}

interface FxRec {
  kind: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  stars: number;
}

/** FireSink 记录桩:子弹走真池(逐字段可查),伤害与 fx 事件进数组(逐条可对账) */
function mkSink(...queryEnemies: Enemy[]): {
  sink: FireSink;
  bullets: Pool<Bullet>;
  hits: Hit[];
  fxs: FxRec[];
} {
  const bullets = new Pool<Bullet>(createBullet, resetBullet);
  const hits: Hit[] = [];
  const fxs: FxRec[] = [];
  const sink: FireSink = {
    spawnBullet: () => bullets.spawn(),
    damage: (e, amount, throttle, towerType) => {
      hits.push({ e, amount, throttle, towerType });
      return false;
    },
    fx: (kind, x0, y0, x1, y1, _radius, _towerType, _damage, _dmgRatio, stars = 0) => {
      fxs.push({ kind, x0, y0, x1, y1, stars });
    },
    // 五条开火路径都不做邻域查询(候选由调用方填),桩只需要是合法的 FireSink
    query: (_x, _y, _r, out) => {
      out.length = 0;
      for (let i = 0; i < queryEnemies.length; i++) out.push(queryEnemies[i]!);
    },
    fired: () => {},
  };
  return { sink, bullets, hits, fxs };
}

/** 一只站好位置的活敌(蜂群蛭底座;kind 可换成 Boss) */
function mkEnemy(x: number, y: number, kind = KIND_SWARM): Enemy {
  const e = createEnemy();
  e.kind = kind;
  e.x = e.px = x;
  e.y = e.py = y;
  e.hp = e.maxHp = 10;
  return e;
}

function mkSlot(type: number, stars: number): WeaponSlot {
  const slot = createWeaponSlots()[0]!;
  slot.type = type;
  slot.stars = stars;
  return slot;
}

afterEach(() => {
  // candidates 是模块级暂存(与 turret.ts 共享):用例之间不许扣着上一批敌人引用
  candidates.length = 0;
});

describe('fire 分派', () => {
  it('按 def.fx 分派五条弹道;认不出的 fx 一律哑火 —— 不碰子弹池、不推 fx、返回 0', () => {
    const { sink, bullets, fxs } = mkSink();
    muzzle.x = 0;
    muzzle.y = 0;
    const t = mkEnemy(100, 0);
    // 数值表被改坏:fx 填了不存在的编号。哑火而不是随便挑一种表现顶上
    const bad = { ...TOWERS[TOWER_AUTOCANNON]!, fx: 99 } as TowerDef;
    expect(fire(mkSlot(TOWER_AUTOCANNON, 1), bad, t, 0, 100, sink)).toBe(0);
    expect(bullets.size).toBe(0);
    expect(fxs.length).toBe(0);
    // 五条弹道各归各的出口
    for (const type of [TOWER_AUTOCANNON, TOWER_MORTAR, TOWER_LASER, TOWER_ARC, TOWER_RAILGUN]) {
      const def = TOWERS[type]!;
      expect(fire(mkSlot(type, 1), def, t, 0, towerRange(def, 1), sink)).toBeGreaterThan(0);
    }
  });
});

describe('直射弹(FX_BULLET)', () => {
  it('弹速非正 = 数值表被改坏:当场哑火,一颗都不出', () => {
    const { sink, bullets } = mkSink();
    const def = { ...TOWERS[TOWER_AUTOCANNON]!, bulletSpeed: 0 } as TowerDef;
    expect(fire(mkSlot(TOWER_AUTOCANNON, 1), def, mkEnemy(100, 0), 0, 100, sink)).toBe(0);
    expect(bullets.size).toBe(0);
  });

  it('发数走 slotShotsPerFire:多管沿同一瞄准线平行出膛,伤害/射程/穿透/星级当场定死', () => {
    const { sink, bullets } = mkSink();
    muzzle.x = 10;
    muzzle.y = 20;
    const def = TOWERS[TOWER_AUTOCANNON]!;
    const aim = Math.PI / 4;
    const range = 300;
    const n = slotShotsPerFire(def, 2);
    const shots = fire(mkSlot(TOWER_AUTOCANNON, 2), def, mkEnemy(1, 1), aim, range, sink, 1.5);
    expect(shots).toBe(n);
    expect(bullets.size).toBe(n);
    const nx = -Math.sin(aim);
    const ny = Math.cos(aim);
    for (let i = 0; i < n; i++) {
      const b = bullets.items[i]!;
      expect(b.kind).toBe(BK_DIRECT);
      const offset = (i - (n - 1) / 2) * def.bulletRadius * 2;
      expect(b.x).toBeCloseTo(10 + nx * offset, 12);
      expect(b.y).toBeCloseTo(20 + ny * offset, 12);
      // 双管只分开出膛点,方向不散开:升级后不会在远距离把小目标夹在两弹之间
      expect(Math.atan2(b.vy, b.vx)).toBeCloseTo(aim, 12);
      // 伤害在发射那一刻按 stars 定死(星级系统接线:出膛后改塔不改这一发)
      expect(b.damage).toBe(effectiveDamage(def, 2, 1.5));
      expect(b.life).toBe(range / def.bulletSpeed);
      expect(b.pierce).toBe(towerPierce(def, 2));
      expect(b.towerType).toBe(def.type);
      expect(b.stars).toBe(2);
      expect(b.throttle).toBe(def.throttle);
    }
  });

  it('2★ 机炮正对最大射程处的静止蜂群蛭:平行双管两发都命中,不再左右夹空', () => {
    muzzle.x = 0;
    muzzle.y = 0;
    const def = TOWERS[TOWER_AUTOCANNON]!;
    const range = towerRange(def, 2);
    const target = mkEnemy(range, 0);
    target.hp = target.maxHp = 1e9; // 两发都能落账,不被第一发击杀闩挡掉
    const { sink, bullets, hits } = mkSink(target);

    expect(fire(mkSlot(TOWER_AUTOCANNON, 2), def, target, 0, range, sink)).toBe(2);
    const frames = Math.ceil((range / def.bulletSpeed) / SIM_DT);
    for (let i = 0; i < frames; i++) stepBullets(bullets, SIM_DT, sink);

    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.e === target)).toBe(true);
  });

  it('星级接线:同塔 1★ 与 3★ 出膛伤害不同(数据层 getter 钉过,这里钉"开火真的带着 stars 走")', () => {
    const def = TOWERS[TOWER_AUTOCANNON]!;
    const { sink: s1, bullets: b1 } = mkSink();
    fire(mkSlot(TOWER_AUTOCANNON, 1), def, mkEnemy(1, 1), 0, 300, s1);
    const { sink: s3, bullets: b3 } = mkSink();
    fire(mkSlot(TOWER_AUTOCANNON, 3), def, mkEnemy(1, 1), 0, 300, s3);
    expect(b3.items[0]!.damage).toBe(effectiveDamage(def, 3));
    expect(b3.items[0]!.damage).toBeGreaterThan(b1.items[0]!.damage);
  });

  it('2★/3★ 点防保持单发，但按扣弹前的弹夹余量确定性地左右交替炮口', () => {
    const def = TOWERS[TOWER_PD]!;
    const slot = mkSlot(TOWER_PD, 3);
    slot.ammo = 80;
    expect(projectileBarrelOffset(slot, def, 0, 1)).toBe(def.bulletRadius);
    slot.ammo = 79;
    expect(projectileBarrelOffset(slot, def, 0, 1)).toBe(-def.bulletRadius);
    // 1★ 仍走中线；视觉变化不增加真实弹数。
    slot.stars = 1;
    expect(projectileBarrelOffset(slot, def, 0, 1)).toBe(0);
  });

  it('风暴机炮的双管齐射 = slotShotsPerFire 的恒发数 × 星级跳变,不是漏成单管', () => {
    const def = TOWERS[TOWER_STORM_CANNON]!;
    expect(slotShotsPerFire(def, 3)).toBeGreaterThan(1);
    const { sink, bullets } = mkSink();
    muzzle.x = 0;
    muzzle.y = 0;
    const shots = fire(mkSlot(TOWER_STORM_CANNON, 3), def, mkEnemy(100, 0), 0, 300, sink);
    expect(shots).toBe(slotShotsPerFire(def, 3));
    expect(bullets.size).toBe(shots);
  });
});

describe('抛射弹(FX_MORTAR)', () => {
  it('途中不碰撞:直击伤害恒 0、伤害全在落点 AoE;落点夹在射程内(超程目标不超程)', () => {
    const { sink, bullets } = mkSink();
    muzzle.x = 0;
    muzzle.y = 0;
    const def = TOWERS[TOWER_MORTAR]!;
    const range = 300;
    const n = slotShotsPerFire(def, 1);
    // 目标距炮口 500 > range 300:life 按夹取后的 300 算(落点不许跑出射界叠加层的圆)
    const shots = fire(mkSlot(TOWER_MORTAR, 1), def, mkEnemy(300, 400), 0, range, sink, 2);
    expect(shots).toBe(n);
    const b = bullets.items[0]!;
    expect(b.kind).toBe(BK_MORTAR);
    expect(b.damage).toBe(0);
    expect(b.aoeDamage).toBe(effectiveAoeDamage(def, 1, 2));
    expect(b.life).toBe(range / def.bulletSpeed);
    expect(b.towerType).toBe(def.type);
    expect(b.throttle).toBe(def.throttle);
  });

  it('弹速非正:当场哑火(与直射弹同一条理由)', () => {
    const { sink, bullets } = mkSink();
    const def = { ...TOWERS[TOWER_MORTAR]!, bulletSpeed: 0 } as TowerDef;
    expect(fire(mkSlot(TOWER_MORTAR, 1), def, mkEnemy(100, 0), 0, 100, sink)).toBe(0);
    expect(bullets.size).toBe(0);
  });
});

describe('光束(FX_BEAM)', () => {
  it('单体光束(激光):只打首目标,命中点 = 目标当前位置,推一条 muzzle→目标 的光束', () => {
    const { sink, hits, fxs } = mkSink();
    muzzle.x = 0;
    muzzle.y = 0;
    const def = TOWERS[TOWER_LASER]!;
    expect(towerPierce(def, 1)).toBe(0);
    const t = mkEnemy(120, 50);
    expect(fire(mkSlot(TOWER_LASER, 1), def, t, 0, 100, sink)).toBe(1);
    expect(hits).toEqual([
      { e: t, amount: effectiveDamage(def, 1), throttle: def.throttle, towerType: def.type },
    ]);
    expect(fxs).toHaveLength(1);
    expect(fxs[0]!.kind).toBe(FXV_BEAM);
    expect(fxs[0]!.x0).toBe(0);
    expect(fxs[0]!.y0).toBe(0);
    expect(fxs[0]!.x1).toBe(t.x);
    expect(fxs[0]!.y1).toBe(t.y);
    expect(fxs[0]!.stars).toBe(1);
  });

  it('穿透光束(极光阵列):沿炮口→目标的射线扫到射程尽头 —— 线上全员吃满,线外/身后/射程外/尸体不吃', () => {
    const { sink, hits, fxs } = mkSink();
    muzzle.x = 0;
    muzzle.y = 0;
    const def = TOWERS[TOWER_AURORA]!;
    expect(towerPierce(def, 1)).toBeGreaterThan(0);
    const range = towerRange(def, 1);
    const r = enemyRadius(mkEnemy(0, 0));
    const target = mkEnemy(100, 0);
    const onLine = mkEnemy(250, 0); // 恰好在线上:必中
    const offLine = mkEnemy(250, def.lanceWidth + r + 1); // 半宽 + 体型之外 1px:不中
    const behind = mkEnemy(-80, 0); // 投影在炮口身后:不中
    const beyond = mkEnemy(range + 500, 0); // 射程之外:不中
    const dead = mkEnemy(400, 0);
    dead.dead = true; // 尸体整帧还在场上,但不再吃一发
    candidates.push(target, onLine, offLine, behind, beyond, dead);
    expect(fire(mkSlot(TOWER_AURORA, 1), def, target, 0, range, sink)).toBe(1);
    const hitSet = new Set(hits.map((h) => h.e));
    expect(hitSet.has(target)).toBe(true);
    expect(hitSet.has(onLine)).toBe(true);
    expect(hitSet.has(offLine)).toBe(false);
    expect(hitSet.has(behind)).toBe(false);
    expect(hitSet.has(beyond)).toBe(false);
    expect(hitSet.has(dead)).toBe(false);
    // 光束画到射程尽头:可视化即作用范围
    expect(fxs).toHaveLength(1);
    expect(fxs[0]!.kind).toBe(FXV_BEAM);
    expect(fxs[0]!.x1).toBeCloseTo(range, 9);
  });
});

describe('链电(FX_CHAIN)', () => {
  it('逐跳取最近的未命中活人:伤害逐跳 ×chainFalloff、跳数 = towerChainCount、绝不回头弹', () => {
    const { sink, hits, fxs } = mkSink();
    muzzle.x = 0;
    muzzle.y = 0;
    const def = TOWERS[TOWER_ARC]!;
    const total = towerChainCount(def, 1);
    const target = mkEnemy(100, 0);
    const hop1 = mkEnemy(100, 10); // 距 target 10(最近的那只先跳)
    const hop2 = mkEnemy(100, 30); // 距 hop1 20
    const hop3 = mkEnemy(100, 60); // 距 hop2 30
    const hop4 = mkEnemy(100, 100); // 距 hop3 40(跳数不够时轮不到)
    candidates.push(hop4, hop2, target, hop3, hop1); // 乱序进候选:最近优先与候选顺序无关
    // 一次放电恒算"一发":跳几只都不改返回
    expect(fire(mkSlot(TOWER_ARC, 1), def, target, 0, 100, sink)).toBe(1);
    expect(hits).toHaveLength(total);
    expect(hits[0]!.e).toBe(target);
    expect(hits[0]!.amount).toBe(effectiveDamage(def, 1));
    for (let i = 1; i < total; i++) {
      expect(hits[i]!.e).toBe([hop1, hop2, hop3, hop4][i - 1]);
      expect(hits[i]!.amount).toBeCloseTo(effectiveDamage(def, 1) * Math.pow(def.chainFalloff, i), 9);
    }
    // 不回头弹:同一只绝不进两次(回头弹会让掉落按命中数重复给,10 号 issue)
    expect(new Set(hits.map((h) => h.e)).size).toBe(total);
    // 每跳一条 FXV_CHAIN,渲染层首尾相接连成整条链
    expect(fxs).toHaveLength(total);
    expect(fxs.every((f) => f.kind === FXV_CHAIN)).toBe(true);
    expect(fxs.every((f) => f.stars === 1)).toBe(true);
    // 链长改坏(0/负数):首目标照样吃这一下 —— "打得到却不掉血"比"少跳一只"难查得多
    const { sink: s2, hits: h2 } = mkSink();
    const zero = { ...def, chainCount: 0 } as TowerDef;
    expect(fire(mkSlot(TOWER_ARC, 1), zero, target, 0, 100, s2)).toBe(1);
    expect(h2).toHaveLength(1);
  });
});

describe('穿透直线(FX_LANCE)', () => {
  it('线上全员吃满不衰减:身后/射程外/线外/尸体不吃;Boss 是表外的合法目标;光柱无条件推一条', () => {
    const { sink, hits, fxs } = mkSink();
    muzzle.x = 0;
    muzzle.y = 0;
    const def = TOWERS[TOWER_RAILGUN]!;
    const range = towerRange(def, 1);
    const r = enemyRadius(mkEnemy(0, 0));
    const a = mkEnemy(100, 0);
    const b = mkEnemy(400, 0);
    const boss = mkEnemy(500, 0, KIND_BOSS); // 不进 ENEMIES 表,但弹道塔必须打得到它
    const off = mkEnemy(400, def.lanceWidth + r + 1);
    const behind = mkEnemy(-60, 0);
    const beyond = mkEnemy(range + 100, 0);
    const dead = mkEnemy(200, 0);
    dead.dead = true;
    candidates.push(a, b, boss, off, behind, beyond, dead);
    expect(fire(mkSlot(TOWER_RAILGUN, 1), def, mkEnemy(0, 0), 0, range, sink, 2)).toBe(1);
    const hitSet = new Set(hits.map((h) => h.e));
    expect(hitSet.has(a)).toBe(true);
    expect(hitSet.has(b)).toBe(true);
    expect(hitSet.has(boss)).toBe(true);
    expect(hitSet.has(off)).toBe(false);
    expect(hitSet.has(behind)).toBe(false);
    expect(hitSet.has(beyond)).toBe(false);
    expect(hitSet.has(dead)).toBe(false);
    // 贯穿不衰减:全员同额,伤害乘着 damageMul
    for (const h of hits) expect(h.amount).toBe(effectiveDamage(def, 1, 2));
    // 光柱无条件推一条,哪怕一个人都没扫到:"打出去但没打中"是玩家读沉炮的唯一读数
    expect(fxs).toHaveLength(1);
    expect(fxs[0]!.kind).toBe(FXV_LANCE);
    expect(fxs[0]!.x1).toBeCloseTo(range, 9);
    expect(fxs[0]!.stars).toBe(1);
  });
});
