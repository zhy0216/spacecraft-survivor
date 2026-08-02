/**
 * 塔的节流状态机(05 号 issue T2)。
 * 这里只喂"一个甲板格 + 一份 def",不造 World、不造敌人:节流是纯时间维度的状态机,
 * 于是三套机制的边界能按**帧数**逐帧钉死 —— 而帧数正是玩家真正感觉到的那个东西
 * (弹夹见底那一下的停顿有多长、贪连射会被罚多久、蓄力多久才放)。
 * 每一帧的顺序照 sim/turret.ts 复刻:先 stepThrottle(有没有目标都跑),再 canFire,再 onFired。
 *
 * 钉的几条机制(改坏就等于改坏了 05 的验收标准与 06 的作用锚点):
 *   三套机制**机制上互不相同** —— 运行期读数字段两两不交,停火特征也各不相同,
 *     不是同一个 cooldown 换三种皮;否则 06 号支援设施的三个作用锚点就少了两个;
 *   弹药:突发满速 → 打空 → **硬停顿恰好 reload/SIM_DT 帧**,且帧数由数据算出;
 *   过热:半速点射跑满 60 秒一次都不停(与弹药系的分水岭),贪连射到顶才被锁死 overheatLock;
 *   充能:无目标也照常蓄、**满 1.0 精确封顶停在那里等目标**,节奏与射速旋钮完全无关;
 *   effectiveDamage / effectiveFireInterval 每次现读 tuning(面板拖动即时生效),
 *     且倍率被拖到 0/负/NaN 也不许把塔永久卡死。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SIM_DT } from '../core/loop';
import {
  THR_AMMO,
  THR_CHARGE,
  THR_HEAT,
  TOWER_ARC,
  TOWER_AUTOCANNON,
  TOWER_KIND_COUNT,
  TOWER_LASER,
  TOWER_MORTAR,
  TOWER_PD,
  TOWER_RAILGUN,
  type TowerDef,
  towerChargeTime,
  towerDamage,
  towerFireInterval,
  towerHeatMax,
  towerMagazine,
  TOWERS,
} from '../data/towers';
import { tuning } from './config';
import {
  CELL_SUPPORT,
  CELL_WEAPON,
  cellAt,
  createDeck,
  type Deck,
  type DeckCell,
  isPlaceSuccess,
  PLACE_UPGRADE,
  placeAt,
} from './deck';
import {
  canFire,
  cellTowerDef,
  effectiveDamage,
  effectiveFireInterval,
  onFired,
  stepThrottle,
} from './tower';

// 与 enemy.test.ts 同口径:全局倍率在文件顶部显式写死,免得 M0 反复调平衡时把机制断言带崩
const BASE = { towerDamageScale: 1, towerFireRateScale: 1 };
Object.assign(tuning, BASE);

/**
 * 有几条用例要临时改数值表 —— 那本身就是"改数据文件即可调平衡,不改代码"(05 验收标准第三条)的证据。
 * 跑完逐塔还原顶层字段;本文件的用例一律不碰 growth 子对象(碰了就得连它一起深还原)。
 */
const SNAPSHOT = TOWERS.map((d) => ({ ...d }));
afterEach(() => {
  Object.assign(tuning, BASE);
  TOWERS.forEach((d, i) => Object.assign(d, SNAPSHOT[i]!));
});

interface Placed {
  deck: Deck;
  cell: DeckCell;
  def: TowerDef;
}

/** 造一座真塔:走 placeAt 这个唯一入口,起手状态与实战一致(Lv1、满弹、其余全 0) */
function place(type: number): Placed {
  const deck = createDeck();
  expect(isPlaceSuccess(placeAt(deck, 0, 0, CELL_WEAPON, type))).toBe(true); // (0,0) 是角落格,必是边缘格
  const cell = cellAt(deck, 0, 0)!;
  const def = cellTowerDef(cell)!;
  return { deck, cell, def };
}

/** 叠级也走同一个入口(GDD §5.4:原格生效、不占新格) */
function upgrade(p: Placed): void {
  expect(placeAt(p.deck, 0, 0, CELL_WEAPON, p.cell.towerType)).toBe(PLACE_UPGRADE);
}

/** 与 sim/turret.ts 的每帧顺序同口径:节流先推进(有没有目标都跑),再问节流放不放行 */
function tick(p: Placed, hasTarget: boolean, shots = 1): boolean {
  stepThrottle(p.cell, p.def, SIM_DT);
  if (!hasTarget || !canFire(p.cell, p.def)) return false;
  onFired(p.cell, p.def, shots);
  return true;
}

/** 跑 frames 帧,返回开火落在第几帧(1-based)。hasTarget 按帧给,默认恒有目标 */
function run(p: Placed, frames: number, hasTarget: (f: number) => boolean = () => true): number[] {
  const at: number[] = [];
  for (let f = 1; f <= frames; f++) if (tick(p, hasTarget(f))) at.push(f);
  return at;
}

/** 相邻两发的帧距 —— 三套机制的"停火特征"全靠它读出来 */
function gaps(at: number[]): number[] {
  return at.slice(1).map((f, i) => f - at[i]!);
}

/** 秒 → 帧。装填/锁死这类"恰好 N 帧"的期望一律由数据算出,不写魔数 */
function frames(sec: number): number {
  return Math.round(sec / SIM_DT);
}

describe('cellTowerDef(格 → 塔定义)', () => {
  it('没有塔的格一律 undefined:towerType === -1 就是甲板对"这格没塔"的唯一表达', () => {
    const deck = createDeck();
    expect(cellTowerDef(cellAt(deck, 1, 1)!)).toBeUndefined(); // 空格
    // 支援设施也没有塔型:节流状态永远不属于它(deck 保证 towerType 恒 -1)
    expect(isPlaceSuccess(placeAt(deck, 1, 1, CELL_SUPPORT))).toBe(true);
    expect(cellTowerDef(cellAt(deck, 1, 1)!)).toBeUndefined();
  });

  it('武器格取到下标对应的那一份;非法下标不抛异常、只给 undefined', () => {
    const p = place(TOWER_ARC);
    expect(p.def).toBe(TOWERS[TOWER_ARC]);

    // 手改成越界/非整数(数值表被改坏、或将来某处漏了校验):调用方拿到 undefined 就会跳过这座塔,
    // 而不是顺着 TOWERS[x].throttle 当场炸在离现场十万八千里的地方
    for (const bad of [-1, TOWER_KIND_COUNT, 1.5, NaN]) {
      p.cell.towerType = bad;
      expect(cellTowerDef(p.cell)).toBeUndefined();
    }
  });
});

describe('弹药 THR_AMMO(弹夹 + 装填:突发满速后必然停火一整段)', () => {
  it('满弹进场,按 fireInterval 的帧距连射;打空后**恰好停 reload/SIM_DT 帧**', () => {
    const p = place(TOWER_AUTOCANNON);
    const def = p.def;
    const mag = towerMagazine(def, 1);
    expect(p.cell.ammo).toBe(mag); // placeAt 给的起手状态:满弹进场
    expect(mag).toBe(20); // GDD §14 锚点

    const shotGap = frames(towerFireInterval(def, 1)); // 0.4s = 24 帧
    const reloadGap = frames(def.reload); // 1.5s = 90 帧
    expect(shotGap).toBe(24);
    expect(reloadGap).toBe(90);

    const at = run(p, 700);
    // 一夹 20 发全是满速(19 个 24 帧的间隔),之后是那一段硬停顿 —— 这就是弹药系的特征
    expect(gaps(at).slice(0, mag - 1)).toEqual(new Array(mag - 1).fill(shotGap));
    expect(gaps(at)[mag - 1]).toBe(reloadGap);
    // 停顿后又是满速的一夹:节奏是"突发 - 停 - 突发",不是均匀慢射
    expect(gaps(at).slice(mag, mag + 5)).toEqual(new Array(5).fill(shotGap));
  });

  it('装填期间 canFire 恒 false、ammo 停在 0(UI 读的就是这个整数),装完当帧即可开火', () => {
    const p = place(TOWER_AUTOCANNON);
    const mag = towerMagazine(p.def, 1);

    // 先把一夹打空(有目标就一直打)
    let fired = 0;
    let f = 0;
    while (fired < mag) {
      f++;
      if (tick(p, true)) fired++;
    }
    expect(p.cell.ammo).toBe(0);
    expect(p.cell.reloadLeft).toBe(p.def.reload);

    // 装填中间的每一帧都不许开火,且弹夹读数一直是 0(不许偷偷回弹,UI 会跳)
    const wait = frames(p.def.reload);
    for (let i = 1; i < wait; i++) {
      stepThrottle(p.cell, p.def, SIM_DT);
      expect(canFire(p.cell, p.def), `装填第 ${i} 帧`).toBe(false);
      expect(p.cell.ammo).toBe(0);
      expect(p.cell.reloadLeft).toBeGreaterThan(0);
    }
    // 第 wait 帧装填完毕:满弹、当帧就能打(冷却与装填并行推进,不再叠一层射击间隔)
    stepThrottle(p.cell, p.def, SIM_DT);
    expect(p.cell.reloadLeft).toBe(0);
    expect(p.cell.ammo).toBe(mag);
    expect(canFire(p.cell, p.def)).toBe(true);
  });

  it('装填途中升级:装完按**当前**等级满弹(升级的成长当场看得见)', () => {
    const p = place(TOWER_AUTOCANNON);
    while (p.cell.reloadLeft <= 0) tick(p, true); // 打空进装填

    upgrade(p); // GDD §5.4:叠级不清弹夹、不缩短这次装填,只把上限抬高
    expect(p.cell.level).toBe(2);
    expect(p.cell.reloadLeft).toBeGreaterThan(0);

    while (p.cell.reloadLeft > 0) stepThrottle(p.cell, p.def, SIM_DT);
    expect(p.cell.ammo).toBe(towerMagazine(p.def, 2));
    expect(towerMagazine(p.def, 2)).toBeGreaterThan(towerMagazine(p.def, 1));
  });

  it('一次几发就扣几发:Lv3 双管不许白嫖(不然升级会把节流悄悄削弱)', () => {
    const p = place(TOWER_AUTOCANNON);
    const mag = towerMagazine(p.def, 1);

    onFired(p.cell, p.def, 2);
    expect(p.cell.ammo).toBe(mag - 2);
    // shots ≤ 0 是调用方的错(onFired 只该在真开火后调),至少按一发算,免得弹夹永不见底
    onFired(p.cell, p.def, 0);
    expect(p.cell.ammo).toBe(mag - 3);
    // 一梭子超过余量也只夹到 0,UI 不会出现 -1 发
    onFired(p.cell, p.def, 999);
    expect(p.cell.ammo).toBe(0);
    expect(p.cell.reloadLeft).toBe(p.def.reload);
  });

  it('装填时长改数据即改行为;调成 0 = 无停顿,而不是把塔弄死', () => {
    // 05 验收标准第三条的机械形式:这两段只改 TOWERS 的字段,一行逻辑都没动
    TOWERS[TOWER_PD]!.reload = 0.5;
    const p = place(TOWER_PD);
    const mag = towerMagazine(p.def, 1);
    while (p.cell.reloadLeft <= 0) tick(p, true);
    expect(frames(p.cell.reloadLeft)).toBe(frames(0.5));

    TOWERS[TOWER_PD]!.reload = 0;
    const q = place(TOWER_PD);
    let shots = 0;
    for (let f = 1; f <= 600; f++) if (tick(q, true)) shots++;
    expect(q.cell.reloadLeft).toBe(0);
    expect(shots).toBeGreaterThan(mag); // 打穿了一夹还在打:装填时长 0 = 没有那段停顿
  });
});

describe('过热 THR_HEAT(热量 + 强制冷却:点射永不停火,只罚贪连射)', () => {
  it('半速点射跑满 60 秒:一次机会都没浪费,热量连一发的量都攒不起来', () => {
    const p = place(TOWER_LASER);
    const def = p.def;
    const shotGap = frames(towerFireInterval(def, 1)); // 6 帧
    const every = shotGap * 2; // 半速 = 每两个射击间隔才有一次目标

    let chances = 0;
    let taken = 0;
    let peak = 0;
    for (let f = 1; f <= 60 * 60; f++) {
      const has = f % every === 1;
      if (has) chances++;
      if (tick(p, has)) taken++;
      peak = Math.max(peak, p.cell.heat);
      expect(p.cell.coolLock, `第 ${f} 帧`).toBe(0);
    }
    // "点射就永不停火"= 每一次有目标的机会都真的打出去了。这正是过热与弹药的分水岭:
    // 同样的节奏,弹药塔照样要停(见下一条),过热塔一次都不停
    expect(taken).toBe(chances);
    expect(chances).toBe(300);
    expect(peak).toBeLessThanOrEqual(def.heatPerShot + 1e-9);
    expect(peak).toBeLessThan(towerHeatMax(def, 1));
  });

  it('同样的半速节奏,弹药塔照样得停 —— 两套机制不是一回事', () => {
    const p = place(TOWER_AUTOCANNON);
    const every = frames(towerFireInterval(p.def, 1)) * 2;
    let chances = 0;
    let taken = 0;
    for (let f = 1; f <= 60 * 60; f++) {
      const has = f % every === 1;
      if (has) chances++;
      if (tick(p, has)) taken++;
    }
    expect(taken).toBeLessThan(chances); // 弹夹见底就是硬停顿,与射多快无关
    expect(p.cell.heat).toBe(0); // 而且它从头到尾没有"热量"这个概念
  });

  it('贪连射到顶:热量夹在上限、锁死恰好 overheatLock/SIM_DT 帧、解锁那一帧从零起手', () => {
    // 出货数值的过热点落在小数上(算得出但读不出),这里换一组整齐的数,好把每一帧写死。
    // 只改数值表、不改逻辑:热量 3/发,降温 6/秒(= 0.1/帧),上限 10,锁死 0.5s,射击间隔 6 帧
    Object.assign(TOWERS[TOWER_LASER]!, {
      fireInterval: 0.1,
      heatPerShot: 3,
      coolPerSec: 6,
      heatMax: 10,
      overheatLock: 0.5,
    });
    const p = place(TOWER_LASER);
    const def = p.def;

    // 每 6 帧一发:3 → 5.4 → 7.8 → 10.2(第 4 发到顶)。到顶后锁死 30 帧,第 49 帧才又打得出来
    const at = run(p, 60);
    expect(at).toEqual([1, 7, 13, 19, 49, 55]);
    expect(at[4]! - at[3]!).toBe(frames(def.overheatLock)); // 罚的时长由数据算出

    // 第 4 发把热量顶到上限并锁死(夹住而不是冲过头:热量条 = heat / heatMax,超过 1 会画出框)
    const q = place(TOWER_LASER);
    run(q, 19);
    expect(q.cell.heat).toBe(towerHeatMax(def, 1));
    expect(q.cell.coolLock).toBe(def.overheatLock);

    // 锁死期间:一律不许开火,但热量条一直在往下走(玩家看得见还剩多久)
    const lock = frames(def.overheatLock);
    let prev = q.cell.heat;
    for (let i = 1; i < lock; i++) {
      stepThrottle(q.cell, def, SIM_DT);
      expect(canFire(q.cell, def), `锁死第 ${i} 帧`).toBe(false);
      expect(q.cell.heat).toBeLessThan(prev);
      prev = q.cell.heat;
    }
    // 解锁那一帧从零起手:惩罚时长是设计者定的 overheatLock,不再取决于 coolPerSec 顺带降到了几
    stepThrottle(q.cell, def, SIM_DT);
    expect(q.cell.coolLock).toBe(0);
    expect(q.cell.heat).toBe(0);
    expect(canFire(q.cell, def)).toBe(true);
  });

  it('不开火时热量按 coolPerSec 线性降,夹 0 不为负', () => {
    const p = place(TOWER_ARC);
    const def = p.def;
    onFired(p.cell, def, 1);
    const heat0 = p.cell.heat;
    expect(heat0).toBe(def.heatPerShot);

    for (let i = 0; i < 6; i++) stepThrottle(p.cell, def, SIM_DT);
    expect(p.cell.heat).toBeCloseTo(heat0 - def.coolPerSec * SIM_DT * 6, 12);

    // 一路降到 0 就停住:负热量会让 UI 的热量条反向长出去,也会白送一整段"负债"缓冲
    for (let i = 0; i < 10 * 60; i++) stepThrottle(p.cell, def, SIM_DT);
    expect(p.cell.heat).toBe(0);
  });

  it('连发的热量按发算(不然升到 Lv3 那一档等于免费降热)', () => {
    const p = place(TOWER_LASER);
    onFired(p.cell, p.def, 2);
    expect(p.cell.heat).toBe(p.def.heatPerShot * 2);
  });
});

describe('充能 THR_CHARGE(蓄力周期:满充放,节奏与射速旋钮无关)', () => {
  it('无目标也照常蓄,满 1.0 精确封顶,停在那里等目标', () => {
    const p = place(TOWER_RAILGUN);
    const need = frames(towerChargeTime(p.def, 1)); // 2.4s = 144 帧
    expect(need).toBe(144);

    for (let f = 1; f < need; f++) {
      stepThrottle(p.cell, p.def, SIM_DT); // 全程没有目标
      expect(canFire(p.cell, p.def), `第 ${f} 帧`).toBe(false);
    }
    stepThrottle(p.cell, p.def, SIM_DT);
    // 精确 1.0 而不是 0.9999…:UI 的充能环要画得满,canFire 也才能干净地比 >= 1
    expect(p.cell.charge).toBe(1);
    expect(canFire(p.cell, p.def)).toBe(true);

    // 满了就停着等目标(不外溢、不衰减):目标一进射界就是当场一发,不必再等一个周期
    for (let f = 0; f < 300; f++) stepThrottle(p.cell, p.def, SIM_DT);
    expect(p.cell.charge).toBe(1);
    expect(canFire(p.cell, p.def)).toBe(true);
  });

  it('放完归零重新攒:两发之间恰好 chargeTime/SIM_DT 帧,且 cooldown 全程恒 0', () => {
    const p = place(TOWER_RAILGUN);
    const need = frames(towerChargeTime(p.def, 1));
    const at: number[] = [];
    for (let f = 1; f <= need * 3; f++) {
      if (tick(p, true)) {
        at.push(f);
        expect(p.cell.charge).toBe(0); // 一次放空
      }
      expect(p.cell.cooldown).toBe(0); // 充能系没有冷却这条腿:UI 与 checksum 里那一位永远不动
    }
    expect(at).toEqual([need, need * 2, need * 3]);
  });

  it('节奏只由 chargeTime 给:全局射速倍率拖到 4 倍,充能塔一帧都不变(弹药塔变四倍快)', () => {
    tuning.towerFireRateScale = 4;

    const rail = place(TOWER_RAILGUN);
    const need = frames(towerChargeTime(rail.def, 1));
    expect(gaps(run(rail, need * 3))).toEqual([need, need]);
    expect(effectiveFireInterval(rail.def, 1)).toBe(0); // 充能系的 fireInterval 恒 0,除多少都是 0

    // 对照组:同一个旋钮把弹药塔的射击间隔真的压到四分之一
    const gun = place(TOWER_AUTOCANNON);
    expect(gaps(run(gun, 100)).slice(0, 3)).toEqual([6, 6, 6]); // 24 帧 → 6 帧
  });

  it('等级越高蓄得越快(升级看得见),chargeTime 调成 0 也不许吐 NaN 把塔弄死', () => {
    const p = place(TOWER_MORTAR);
    const lv1 = frames(towerChargeTime(p.def, 1));
    upgrade(p);
    const at = run(p, lv1 * 2);
    expect(at[0]!).toBeLessThan(lv1); // Lv2 的 chargeTime 更短,第一发提前到了
    expect(at[0]!).toBeGreaterThan(lv1 * 0.8); // 但不是一步登天(chargeRate 是每级复利)

    TOWERS[TOWER_MORTAR]!.chargeTime = 0;
    const q = place(TOWER_MORTAR);
    stepThrottle(q.cell, q.def, SIM_DT);
    expect(q.cell.charge).toBe(1); // 取消蓄力 = 每帧即满,而不是 NaN/Infinity
    expect(canFire(q.cell, q.def)).toBe(true);
  });
});

describe('三套机制机制上互不相同(06 号支援设施的三个作用锚点)', () => {
  it('运行期读数字段两两不交:各塔只碰自己那套,且自己那套真的都被用上', () => {
    const FIELDS = ['cooldown', 'ammo', 'reloadLeft', 'heat', 'coolLock', 'charge'] as const;
    /** 每套机制**只许**碰这几个字段;其余的必须逐帧恒 0(否则就是同一个 cooldown 换皮) */
    const OWNED: Record<number, readonly string[]> = {
      [THR_AMMO]: ['ammo', 'cooldown', 'reloadLeft'],
      [THR_HEAT]: ['coolLock', 'cooldown', 'heat'],
      [THR_CHARGE]: ['charge'],
    };

    for (let type = 0; type < TOWER_KIND_COUNT; type++) {
      const p = place(type);
      const own = OWNED[p.def.throttle]!;
      const touched = new Set<string>();
      // 1200 帧 = 20 秒:够每一套走完自己的整个循环(装填一轮、过热一轮、蓄放两轮)
      for (let f = 1; f <= 1200; f++) {
        tick(p, true);
        for (const k of FIELDS) {
          if (p.cell[k] === 0) continue;
          expect(own, `${p.def.name} 第 ${f} 帧动了 ${k}`).toContain(k);
          touched.add(k);
        }
      }
      // 反过来也要钉:自己那几个字段必须真的动起来过,
      // 否则"互不复用"可以靠"什么都不做"蒙混过关(比如一座压根开不了火的塔)
      expect([...touched].sort(), p.def.name).toEqual([...own]);
    }
  });

  it('三种停火特征各不相同:硬停顿 / 只罚贪连射 / 攒-放', () => {
    const of = (type: number): number[] => gaps(run(place(type), 60 * 60));

    // 弹药:绝大多数间隔是满速,偶尔插进一段**明显更长**的硬停顿
    const ammo = of(TOWER_AUTOCANNON);
    const fast = frames(towerFireInterval(TOWERS[TOWER_AUTOCANNON]!, 1));
    expect(new Set(ammo)).toEqual(new Set([fast, frames(TOWERS[TOWER_AUTOCANNON]!.reload)]));

    // 过热:满速连射同样会被罚(与"点射不停"并存,这才叫"只罚贪连射")
    const heat = of(TOWER_LASER);
    expect(new Set(heat).size).toBe(2);
    expect(Math.min(...heat)).toBe(frames(towerFireInterval(TOWERS[TOWER_LASER]!, 1)));
    expect(Math.max(...heat)).toBe(frames(TOWERS[TOWER_LASER]!.overheatLock));

    // 充能:只有一种间隔,而且它与 fireInterval 无关(那个数恒 0)
    const charge = of(TOWER_RAILGUN);
    expect(new Set(charge)).toEqual(new Set([frames(towerChargeTime(TOWERS[TOWER_RAILGUN]!, 1))]));
    expect(TOWERS[TOWER_RAILGUN]!.fireInterval).toBe(0);
  });
});

describe('effectiveDamage / effectiveFireInterval(全局倍率现读 tuning)', () => {
  it('伤害 = 等级取值 × 倍率,每次调用现读(面板拖动即时生效)', () => {
    const def = TOWERS[TOWER_AUTOCANNON]!;
    expect(effectiveDamage(def, 1)).toBe(6); // GDD §14 锚点,倍率 1 时原样吐出
    tuning.towerDamageScale = 2;
    expect(effectiveDamage(def, 1)).toBe(12);
    expect(effectiveDamage(def, 3)).toBe(towerDamage(def, 3) * 2);
  });

  it('射击间隔 = 等级取值 ÷ 倍率,同样现读', () => {
    const def = TOWERS[TOWER_AUTOCANNON]!;
    expect(effectiveFireInterval(def, 1)).toBe(0.4);
    tuning.towerFireRateScale = 2;
    expect(effectiveFireInterval(def, 1)).toBeCloseTo(0.2, 12);
    expect(effectiveFireInterval(def, 4)).toBeCloseTo(towerFireInterval(def, 4) / 2, 12);
  });

  it('倍率被拖成 0 / 负 / NaN 也不许把塔永久卡死或污染确定性', () => {
    const def = TOWERS[TOWER_AUTOCANNON]!;
    for (const bad of [0, -1, NaN]) {
      tuning.towerFireRateScale = bad;
      const interval = effectiveFireInterval(def, 1);
      // Infinity 会写进 cell.cooldown,而 Infinity - dt 恒为 Infinity —— 那座塔此后再也减不回来,
      // 把倍率拖回去也救不活;NaN 更会顺着 checksum 把整局的确定性口径搅烂
      expect(Number.isFinite(interval), `射速倍率 ${bad}`).toBe(true);
      expect(interval).toBeGreaterThan(0);

      tuning.towerDamageScale = bad;
      // 伤害倍率允许为 0(全场零伤害是个可逆的调试态),但负伤害 = 给敌人回血,NaN 会污染 hp
      expect(effectiveDamage(def, 1), `伤害倍率 ${bad}`).toBe(0);
    }
  });

  it('正在走的那一轮冷却也现读倍率:拖快当场变快,拖到底再拖回来一定救得回来', () => {
    tuning.towerFireRateScale = 0;
    const p = place(TOWER_AUTOCANNON);
    expect(tick(p, true)).toBe(true); // 第一发照常打出去,然后写进一个极长(但有限)的冷却
    expect(Number.isFinite(p.cell.cooldown)).toBe(true);
    expect(run(p, 600)).toEqual([]); // 慢到几乎不开火 —— 这正是"倍率 0"该有的语义

    // 剩余冷却每帧夹在**当前**射击间隔内:一个射击间隔之内就恢复了,
    // 不必等那个天文数字慢慢走完(不夹的话这座塔会一直冻到本局结束)
    tuning.towerFireRateScale = 1;
    expect(run(p, frames(towerFireInterval(p.def, 1)) + 1)).toEqual([24]);
  });
});
