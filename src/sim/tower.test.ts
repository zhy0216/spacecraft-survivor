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
 *     且倍率被拖到 0/负/NaN 也不许把塔永久卡死;
 *   受击射速惩罚 fireMul(09 号 T3):只作用在**射击间隔与蓄力速度**上 ——
 *     装填、降温、过热锁三条腿一个字不动(挨一下就连装填也变慢 = 死亡螺旋),
 *     充能系也必须真的慢下来(不然六塔里有两座对受击完全免疫),
 *     且**缺省 1 时逐帧读数与今天一字不差**(既有调用方一个参数都不用补);
 *   邻接加成(06 号 T2):四个 cell* 包装是**唯一**取值链路 —— 精确等式钉在纯函数上,
 *     手感则用实测帧距钉(设施把 0.4s 压成 0.32s 这种非整帧时长,round 会读少一帧),
 *     且**节流系不匹配时逐帧读数与"隔壁什么都没有"完全一致**(零效果就得是零效果)。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SIM_DT } from '../core/loop';
import { SUP_AMMO_BAY, SUP_CAPACITOR, SUP_RADIATOR, SUPPORTS } from '../data/supports';
import {
  THR_AMMO,
  THR_CHARGE,
  THR_HEAT,
  TOWER_ARC,
  TOWER_AUTOCANNON,
  TOWER_GATLING,
  TOWER_KIND_COUNT,
  TOWER_LASER,
  TOWER_MORTAR,
  TOWER_PD,
  TOWER_PHASE,
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
import { recomputeSupportBuffs } from './support';
import {
  canFire,
  cellChargeTime,
  cellFireInterval,
  cellHeatMax,
  cellReload,
  cellTowerDef,
  effectiveDamage,
  effectiveFireInterval,
  onFired,
  stepThrottle,
  THROTTLE_EPS,
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

/**
 * 与 sim/turret.ts 的每帧顺序同口径:节流先推进(有没有目标都跑),再问节流放不放行。
 * @param fireMul 受击射速惩罚倍率(09 号 T3),缺省 1 = 没被撞 —— 与 stepThrottle/onFired 的缺省一致,
 *   于是上面那批既有用例连一个参数都不用补,读到的仍是今天这条链路
 */
function tick(p: Placed, hasTarget: boolean, shots = 1, fireMul = 1): boolean {
  stepThrottle(p.cell, p.def, SIM_DT, fireMul);
  if (!hasTarget || !canFire(p.cell, p.def)) return false;
  onFired(p.cell, p.def, shots, fireMul);
  return true;
}

/** 跑 frames 帧,返回开火落在第几帧(1-based)。hasTarget 按帧给,默认恒有目标 */
function run(
  p: Placed,
  frames: number,
  hasTarget: (f: number) => boolean = () => true,
  fireMul = 1,
): number[] {
  const at: number[] = [];
  for (let f = 1; f <= frames; f++) if (tick(p, hasTarget(f), 1, fireMul)) at.push(f);
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

/**
 * 秒 → **帧距**:与 stepCooldown / stepThrottle 那条"逐帧减 dt,减到 ≤ THROTTLE_EPS 才算到期"
 * 的判据同源。上面那个 frames() 是 Math.round,只对**整帧**时长成立;
 * 而邻接加成后的 0.4 / 1.25 = 0.32s = 19.2 帧压根不是整帧 —— 照抄 frames() 会把一条
 * 真实存在的 20 帧读成 19 帧,断言当场变成"钉住了一个不存在的行为"。
 * 减掉 EPS 再取上整,于是整帧时长(1.5s = 90 帧)也照旧读得对,两种时长共用同一个算式。
 */
function gapFrames(sec: number): number {
  return Math.ceil((sec - THROTTLE_EPS) / SIM_DT);
}

/** 蓄满一发要几帧:与 stepThrottle 充能分支那条 `charge >= 1 - THROTTLE_EPS` 同源(反向累加) */
function chargeFrames(sec: number): number {
  return Math.ceil(((1 - THROTTLE_EPS) * sec) / SIM_DT);
}

/**
 * 造一座塔 + 若干相邻支援设施(06 号 T2)。塔一律落在船头一行的中格 (1,0):
 * 它是边缘格(船头那条边暴露),而左 (0,0) / 右 (2,0) / 后 (1,1) 三个正交邻格都放得下设施 ——
 * 于是"两座弹药库夹一门机炮"用同一块甲板就摆得出来,不必为它另造几何。
 * @param sups [col, row, SUP_*] 三元组;空数组 = 对照组(同一几何、隔壁什么都没有)
 *
 * 末尾**显式重算一次 buff 缓存**:重算的时机归 World(sim/world.ts 的 place 与 step 各一次),
 * 直接用 placeAt 的单测就得自己同步 —— 这一行本身就是"四个倍率是派生量、不是状态"的证据。
 */
function placeWithSupports(type: number, sups: readonly (readonly number[])[]): Placed {
  const deck = createDeck();
  expect(isPlaceSuccess(placeAt(deck, 1, 0, CELL_WEAPON, type))).toBe(true);
  for (const s of sups) {
    const code = placeAt(deck, s[0]!, s[1]!, CELL_SUPPORT, TOWER_AUTOCANNON, s[2]!);
    expect(isPlaceSuccess(code), `设施 ${s[2]} @(${s[0]},${s[1]})`).toBe(true);
  }
  recomputeSupportBuffs(deck);
  const cell = cellAt(deck, 1, 0)!;
  return { deck, cell, def: cellTowerDef(cell)! };
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
    // 17 号进化塔里两座"把代价整条买断"的签名塔:加特林 reload 0(不再装填)→ reloadLeft 恒 0;
    // 相位切割者 heatPerShot 0(无过热)→ heat / coolLock 恒 0。它们不是"没用上那套机制",
    // 是那套机制的代价被配方买断了 —— 这两个字段从"该动"里除名,其余照旧必须动
    const NO_COST: Record<number, readonly string[]> = {
      [TOWER_GATLING]: ['reloadLeft'],
      [TOWER_PHASE]: ['heat', 'coolLock'],
    };

    for (let type = 0; type < TOWER_KIND_COUNT; type++) {
      const p = place(type);
      const own = OWNED[p.def.throttle]!;
      const skip = NO_COST[p.def.type] ?? [];
      const touched = new Set<string>();
      // 1200 帧 = 20 秒:够每一套走完自己的整个循环(装填一轮、过热一轮、蓄放两轮)
      for (let f = 1; f <= 1200; f++) {
        tick(p, true);
        for (const k of FIELDS) {
          if (skip.includes(k)) continue;
          if (p.cell[k] === 0) continue;
          expect(own, `${p.def.name} 第 ${f} 帧动了 ${k}`).toContain(k);
          touched.add(k);
        }
      }
      // 反过来也要钉:自己那几个字段必须真的动起来过,
      // 否则"互不复用"可以靠"什么都不做"蒙混过关(比如一座压根开不了火的塔)
      expect([...touched].sort(), p.def.name).toEqual([...own].filter((k) => !skip.includes(k)));
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

describe('受击射速惩罚 fireMul(09 号 T3:被撞舷的塔顿一下)', () => {
  /**
   * 本组一律显式写死倍率、不读 tuning.hitFireRateMul:这里钉的是"惩罚怎么作用",
   * 而那个数是 M0 要反复拖的占位(09 号约定 §2),让它把机制断言带崩没有意义。
   * 0.75 = 出货占位值,恰好把机炮的 24 帧变成整 32 帧,帧距读得出来。
   */
  const MUL = 0.75;

  it('射击间隔再除一次 fireMul:< 1 变慢,缺省即 1,两个旋钮各除各的', () => {
    const def = TOWERS[TOWER_AUTOCANNON]!;
    expect(effectiveFireInterval(def, 1, 1)).toBe(effectiveFireInterval(def, 1)); // 缺省 = 传 1
    expect(effectiveFireInterval(def, 1, 0.5)).toBeCloseTo(0.8, 12);
    // 全局射速倍率(面板旋钮)与受击惩罚(船体状态)是两件事,谁都不吞掉谁:
    // 拖快到 2 倍的塔挨了撞,仍然只是"比自己的 2 倍慢一截",而不是回到基准
    tuning.towerFireRateScale = 2;
    expect(effectiveFireInterval(def, 1, 0.5)).toBeCloseTo(0.4, 12);
  });

  it('fireMul 被喂成 0 / 负 / NaN:走与全局倍率同一道下限保护,且不顺着乘法污染另一边', () => {
    const def = TOWERS[TOWER_AUTOCANNON]!;
    for (const bad of [0, -1, NaN]) {
      // Infinity 会写进 cell.cooldown 并再也减不回来,NaN 会顺着 checksum 搅烂确定性口径 ——
      // 惩罚倍率是 sim 内部算出来的,但保护照给:少一道口子就够破一局的确定性
      const interval = effectiveFireInterval(def, 1, bad);
      expect(Number.isFinite(interval), `fireMul ${bad}`).toBe(true);
      expect(interval).toBeGreaterThan(0);

      // 分两次除而不是先乘成一个数:NaN × 有限数还是 NaN,合并的话一边坏掉必然把另一边一起拖下水
      tuning.towerFireRateScale = bad;
      expect(effectiveFireInterval(def, 1, 1), `全局倍率 ${bad}`).toBe(effectiveFireInterval(def, 1));
      tuning.towerFireRateScale = 1;
    }
  });

  it('弹药系:帧距按倍率变长,而那段硬停顿(装填)一帧都不变', () => {
    const p = place(TOWER_AUTOCANNON);
    const mag = towerMagazine(p.def, 1);
    const slow = frames(towerFireInterval(p.def, 1) / MUL);
    expect(slow).toBe(32); // 24 帧 → 32 帧

    const at = run(p, 900, () => true, MUL);
    expect(gaps(at).slice(0, mag - 1)).toEqual(new Array(mag - 1).fill(slow));
    // 装填是"塔自己的一段停顿",不是射击间隔:惩罚一秒都不该加在它头上 ——
    // 挨一下就连装填也变慢,被撞舷会越挨越打不动,那正是"死亡螺旋"本身
    expect(gaps(at)[mag - 1]).toBe(frames(p.def.reload));
    expect(p.cell.ammo).toBeGreaterThan(0); // 惩罚期内开的火照常一发扣一发,不多扣
  });

  it('过热系:射击间隔变长,降温速率与过热锁死时长一个字不变', () => {
    // 与上面那条贪连射用例同一组整齐数值(热量 3/发、降温 6/秒、上限 10、锁死 0.5s、间隔 0.1s):
    // 只改数值表、不改逻辑,好把每一帧写死
    Object.assign(TOWERS[TOWER_LASER]!, {
      fireInterval: 0.1,
      heatPerShot: 3,
      coolPerSec: 6,
      heatMax: 10,
      overheatLock: 0.5,
    });
    const p = place(TOWER_LASER);
    const def = p.def;

    // 只有两种间隔:被惩罚拉长的射击间隔(0.1 / 0.5 = 0.2s = 12 帧),
    // 与**没被惩罚碰过**的过热锁(0.5s = 30 帧)—— 后者要是也乘了倍率,罚的时长就不再是设计者定的那个数
    const at = run(p, 600, () => true, 0.5);
    expect(new Set(gaps(at))).toEqual(new Set([frames(0.2), frames(def.overheatLock)]));

    // 降温同口径:惩罚只作用在射击间隔上,挨一下不该连"还剩多久能打"都跟着变慢
    const q = place(TOWER_LASER);
    onFired(q.cell, def, 1, 0.5);
    for (let i = 0; i < 6; i++) stepThrottle(q.cell, def, SIM_DT, 0.5);
    expect(q.cell.heat).toBeCloseTo(def.heatPerShot - def.coolPerSec * SIM_DT * 6, 12);
  });

  it('充能系也真的慢下来:不然六塔里有两座对受击完全免疫', () => {
    const p = place(TOWER_RAILGUN);
    const need = frames(towerChargeTime(p.def, 1)); // 2.4s = 144 帧
    const slow = frames(towerChargeTime(p.def, 1) / MUL); // 192 帧
    expect(slow).toBe(192);

    // 充能系没有 cooldown 那条腿,惩罚只能进蓄力速度。它与"节奏只由 chargeTime 给"不矛盾:
    // fireMul 不是射速旋钮(那个是 towerFireRateScale,对充能系照旧无效,见上一组的对照用例),
    // 它是一次外部事件带来的**受击惩罚**
    expect(run(p, slow * 3, () => true, MUL)).toEqual([slow, slow * 2, slow * 3]);
    expect(p.cell.cooldown).toBe(0); // 充能系那条恒 0 的腿没被惩罚顺手拧开
  });

  it('缺省 fireMul = 1:六塔逐帧读数与既有链路一字不差(既有调用方一个字都不用改)', () => {
    const FIELDS = ['cooldown', 'ammo', 'reloadLeft', 'heat', 'coolLock', 'charge'] as const;
    for (let type = 0; type < TOWER_KIND_COUNT; type++) {
      const bare = place(type); // 走缺省参数 = 今天的调用形状
      const one = place(type); // 显式传 1
      // 600 帧 = 10 秒:够弹药走完一整轮装填、过热罚一次、充能放四次
      for (let f = 1; f <= 600; f++) {
        expect(tick(bare, true), `${bare.def.name} 第 ${f} 帧`).toBe(tick(one, true, 1, 1));
        for (const k of FIELDS) {
          expect(bare.cell[k], `${bare.def.name} 第 ${f} 帧的 ${k}`).toBe(one.cell[k]);
        }
      }
    }
  });
});

describe('邻接加成 cell*(06 号 T2:四个包装是全仓唯一的取值链路)', () => {
  it('弹药库贴机炮:射速 ×1.25、装填 ×0.7,精确等式钉在纯函数上', () => {
    const sup = SUPPORTS[SUP_AMMO_BAY]!;
    const bare = placeWithSupports(TOWER_AUTOCANNON, []);
    // 隔壁什么都没有时,四个包装与既有链路**逐位**一字不差(缓存初值 1,乘 1 / 除 1 是恒等):
    // 06 号接进来之后,五个既有 describe 里那批断言仍然读的是同一条链路
    expect(cellFireInterval(bare.cell, bare.def)).toBe(effectiveFireInterval(bare.def, 1));
    expect(cellReload(bare.cell, bare.def)).toBe(bare.def.reload);

    const p = placeWithSupports(TOWER_AUTOCANNON, [[0, 0, SUP_AMMO_BAY]]);
    // 等式取自数值表本身,不写死 0.32/1.05:改 data/supports 的两个数,本断言跟着走(05 验收第三条)
    expect(cellFireInterval(p.cell, p.def)).toBe(effectiveFireInterval(p.def, 1) / sup.fireRateMul);
    expect(cellReload(p.cell, p.def)).toBe(p.def.reload * sup.reloadMul);
    expect(cellFireInterval(p.cell, p.def)).toBeCloseTo(0.32, 12); // GDD §14 的 0.4s → 0.32s
    expect(cellReload(p.cell, p.def)).toBeCloseTo(1.05, 12); // 1.5s → 1.05s

    // 另外两个包装一动不动:弹药库只认弹药系那两个旋钮(热上限/蓄力是散热器与电容组的活)
    expect(cellHeatMax(p.cell, p.def)).toBe(towerHeatMax(p.def, 1));
    expect(cellChargeTime(p.cell, p.def)).toBe(towerChargeTime(p.def, 1));

    // onFired **当场**写进去的就是加成后的时长,而不是靠下一帧的现夹去补:
    // 渲染层的装填进度条 = 1 - reloadLeft / cellReload,分子若还是基准的 1.5s,
    // 放下弹药库那一帧的进度条会先反向长出去一截、下一帧再跳回来
    onFired(p.cell, p.def, towerMagazine(p.def, 1)); // 一梭子打空 → 进装填
    expect(p.cell.ammo).toBe(0);
    expect(p.cell.reloadLeft).toBe(cellReload(p.cell, p.def));
    expect(p.cell.cooldown).toBe(cellFireInterval(p.cell, p.def));
  });

  it('弹药库贴机炮:帧距实测变密,那段硬停顿也真的短了三成', () => {
    const p = placeWithSupports(TOWER_AUTOCANNON, [[0, 0, SUP_AMMO_BAY]]);
    const mag = towerMagazine(p.def, 1);
    // 0.32s = 19.2 帧 —— **不是整帧**,故帧距一律走 gapFrames(取上整),不照抄 frames() 的 round
    const gap = gapFrames(cellFireInterval(p.cell, p.def));
    const reloadGap = gapFrames(cellReload(p.cell, p.def));
    expect(gap).toBe(20);
    expect(reloadGap).toBe(63);
    expect(gap).toBeLessThan(frames(towerFireInterval(p.def, 1))); // 24 帧 → 20 帧,真的更密
    expect(reloadGap).toBeLessThan(frames(p.def.reload)); // 90 帧 → 63 帧

    const at = run(p, 700);
    // 节奏仍是"突发 - 停 - 突发"(弹药系的机制没被加成改掉),只是两段都按倍率缩了
    expect(gaps(at).slice(0, mag - 1)).toEqual(new Array(mag - 1).fill(gap));
    expect(gaps(at)[mag - 1]).toBe(reloadGap);
    expect(gaps(at).slice(mag, mag + 5)).toEqual(new Array(5).fill(gap));
  });

  it('装填途中放下弹药库:正在走的那一轮当场变短(与 stepCooldown 那道现夹一字同源)', () => {
    const p = placeWithSupports(TOWER_AUTOCANNON, []);
    while (p.cell.reloadLeft <= 0) tick(p, true); // 打空进装填,此刻按基准的 1.5s 在走
    expect(p.cell.reloadLeft).toBe(p.def.reload);

    // 战斗中放下设施(GDD §4.5 允许);World 之外的调用方要自己同步一次派生缓存
    const code = placeAt(p.deck, 0, 0, CELL_SUPPORT, TOWER_AUTOCANNON, SUP_AMMO_BAY);
    expect(isPlaceSuccess(code)).toBe(true);
    recomputeSupportBuffs(p.deck);

    // 下一帧就被夹进新的装填时长里。不夹的话"装填 -30%"要等这一轮 1.5s 走完才看得见 ——
    // 而放下设施的那一秒半正是玩家盯着看反馈的时候
    stepThrottle(p.cell, p.def, SIM_DT);
    expect(p.cell.reloadLeft).toBeCloseTo(cellReload(p.cell, p.def) - SIM_DT, 12);

    let spent = 1; // 上面那一帧
    while (p.cell.reloadLeft > 0) {
      stepThrottle(p.cell, p.def, SIM_DT);
      spent++;
    }
    expect(spent).toBe(gapFrames(cellReload(p.cell, p.def))); // 整轮按新时长算,63 帧而不是 90
    expect(p.cell.ammo).toBe(towerMagazine(p.def, 1));
  });

  it('散热器贴机炮:节流系不匹配 ⇒ 六个读数字段逐帧与对照组**完全一致**', () => {
    const FIELDS = ['cooldown', 'ammo', 'reloadLeft', 'heat', 'coolLock', 'charge'] as const;
    // 三面围满散热器:零效果就该是零效果,围几座都一样(不匹配的配对压根不进 supportLinks 那张表)
    const p = placeWithSupports(TOWER_AUTOCANNON, [
      [0, 0, SUP_RADIATOR],
      [2, 0, SUP_RADIATOR],
      [1, 1, SUP_RADIATOR],
    ]);
    const bare = placeWithSupports(TOWER_AUTOCANNON, []);

    // 600 帧 = 10 秒:够走完一整轮"满弹 → 打空 → 装填 → 再满速",每一帧逐字段对
    for (let f = 1; f <= 600; f++) {
      expect(tick(p, true), `第 ${f} 帧`).toBe(tick(bare, true));
      for (const k of FIELDS) expect(p.cell[k], `第 ${f} 帧的 ${k}`).toBe(bare.cell[k]);
    }
    // 取值链路那一头同样一字不差 —— 复位值是 1(无加成)而不是 0(把射速抹成 0 是另一回事)
    expect(cellFireInterval(p.cell, p.def)).toBe(cellFireInterval(bare.cell, bare.def));
    expect(cellReload(p.cell, p.def)).toBe(cellReload(bare.cell, bare.def));
  });

  it('散热器贴激光:过热上限 ×1.5 ⇒ 多打一发才被罚(抬的是上限,单发代价一个字不变)', () => {
    // 换一组整齐的数好把每一帧写死(只改数值表、不改逻辑):热量 4/发、不降温、上限 10、
    // 锁死 0.5s = 30 帧、射击间隔 6 帧 ⇒ 对照组第 3 发到顶,散热器把它推到第 4 发
    Object.assign(TOWERS[TOWER_LASER]!, {
      fireInterval: 0.1,
      heatPerShot: 4,
      coolPerSec: 0,
      heatMax: 10,
      overheatLock: 0.5,
    });
    const sup = SUPPORTS[SUP_RADIATOR]!;
    const p = placeWithSupports(TOWER_LASER, [[0, 0, SUP_RADIATOR]]);
    expect(cellHeatMax(p.cell, p.def)).toBe(towerHeatMax(p.def, 1) * sup.heatMaxMul);
    expect(cellHeatMax(p.cell, p.def)).toBe(15);

    const bare = placeWithSupports(TOWER_LASER, []);
    expect(run(p, 60).slice(0, 5)).toEqual([1, 7, 13, 19, 49]); // 4 发才到顶
    expect(run(bare, 60).slice(0, 5)).toEqual([1, 7, 13, 43, 49]); // 3 发就到顶,罚完才接得上
    // 热量夹在**各自**的上限上:热量条的分子分母同源,加成后照样画不出框
    expect(p.cell.heat).toBeLessThanOrEqual(cellHeatMax(p.cell, p.def));
    expect(bare.cell.heat).toBeLessThanOrEqual(cellHeatMax(bare.cell, bare.def));
    expect(cellHeatMax(bare.cell, bare.def)).toBe(10);
  });

  it('电容组贴磁轨:蓄力时长 ÷1.3 ⇒ 蓄满帧数按它变短,冷却那条恒 0 的腿没被拧开', () => {
    const sup = SUPPORTS[SUP_CAPACITOR]!;
    const p = placeWithSupports(TOWER_RAILGUN, [[0, 0, SUP_CAPACITOR]]);
    expect(cellChargeTime(p.cell, p.def)).toBe(towerChargeTime(p.def, 1) / sup.chargeRateMul);

    const need = chargeFrames(cellChargeTime(p.cell, p.def)); // 2.4 / 1.3 ≈ 1.846s ≈ 110.8 帧
    expect(need).toBe(111);
    expect(need).toBeLessThan(frames(towerChargeTime(p.def, 1))); // 144 帧 → 111 帧
    // 攒-放的节奏整体变快,且每一轮都一样长(放完精确归零,加成不会在轮与轮之间漂)
    expect(run(p, need * 3)).toEqual([need, need * 2, need * 3]);
    expect(p.cell.cooldown).toBe(0);
  });

  it('两座弹药库夹一门机炮:四个倍率一律**连乘**(1.25² / 0.7²),不是"每座 -30%"的加法', () => {
    const sup = SUPPORTS[SUP_AMMO_BAY]!;
    const one = placeWithSupports(TOWER_AUTOCANNON, [[0, 0, SUP_AMMO_BAY]]);
    const two = placeWithSupports(TOWER_AUTOCANNON, [
      [0, 0, SUP_AMMO_BAY],
      [2, 0, SUP_AMMO_BAY],
    ]);

    expect(cellFireInterval(two.cell, two.def)).toBe(
      effectiveFireInterval(two.def, 1) / (sup.fireRateMul * sup.fireRateMul),
    );
    expect(cellReload(two.cell, two.def)).toBe(two.def.reload * (sup.reloadMul * sup.reloadMul));
    // 连乘 = 两座的效果恰好是一座的**再来一遍**,而不是把两次折扣加起来:
    // 加法在四座围一门炮时会把装填推成负数,而负的 reloadLeft 会让 canFire 当场放行 ——
    // 那门炮此后再也不装填,弹药系的硬停顿整条消失(连乘则永远推不到 ≤ 0)
    expect(cellReload(two.cell, two.def)).toBeCloseTo(
      cellReload(one.cell, one.def) * sup.reloadMul,
      12,
    );
    expect(cellReload(two.cell, two.def)).toBeGreaterThan(0);
    expect(cellFireInterval(two.cell, two.def)).toBeCloseTo(0.256, 12); // 0.4 → 0.32 → 0.256

    // 手感上也真的又密了一档:20 帧 → 16 帧
    const gap = gapFrames(cellFireInterval(two.cell, two.def));
    expect(gap).toBe(16);
    expect(gap).toBeLessThan(gapFrames(cellFireInterval(one.cell, one.def)));
    expect(gaps(run(two, 200)).slice(0, 5)).toEqual(new Array(5).fill(gap));
  });

  it('第 4 参 buffMul 与另外两个旋钮各除各的:各自过一遍 safeScale,一边坏掉不牵连另一边', () => {
    const def = TOWERS[TOWER_AUTOCANNON]!;
    expect(effectiveFireInterval(def, 1, 1, 1)).toBe(effectiveFireInterval(def, 1)); // 缺省 = 传 1
    expect(effectiveFireInterval(def, 1, 1, 1.25)).toBe(0.4 / 1.25);

    for (const bad of [0, -1, NaN]) {
      // 加成是 sim 内部连乘出来的,但保护照给:Infinity 会写进 cell.cooldown 且再也减不回来,
      // NaN 更会顺着 checksum 把整局的确定性口径搅烂 —— 少一道口子就够破一局
      const interval = effectiveFireInterval(def, 1, 1, bad);
      expect(Number.isFinite(interval), `buffMul ${bad}`).toBe(true);
      expect(interval).toBeGreaterThan(0);
      // 三个旋钮先乘成一个数的话,NaN × 有限数还是 NaN:受击惩罚坏掉会把邻接加成一起拖下水
      expect(effectiveFireInterval(def, 1, bad, 1.25)).toBe(
        effectiveFireInterval(def, 1, bad) / 1.25,
      );
      tuning.towerFireRateScale = bad;
      expect(effectiveFireInterval(def, 1, 1, 1.25), `全局倍率 ${bad}`).toBe(
        effectiveFireInterval(def, 1) / 1.25,
      );
      tuning.towerFireRateScale = 1;
    }
  });
});
