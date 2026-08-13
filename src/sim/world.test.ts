import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SIM_DT } from '../core/loop';
import { AFFIX_ARMORED, AFFIX_FRENZY } from '../data/affixes';
import {
  DOCK_REPAIR_PRICE,
  MAGNET_PICKUP_SURGE,
  STARTING_STAR_COINS,
} from '../data/economy';
import { EDICT_ARMOR, EDICT_MAX_LEVEL, EDICT_STARCHART, edictLevel } from '../data/edicts';
import { KIND_SWARM } from '../data/enemies';
import {
  STAR_MAX,
  TOWER_ARC,
  TOWER_AUTOCANNON,
  TOWER_LASER,
  TOWER_MISSILE_NEST,
  TOWER_RAILGUN,
  TOWER_STORM_CANNON,
} from '../data/towers';
import { SPAWN_RADIUS, SPAWN_RADIUS_BAND, WAVE_SEGMENTS, type WaveSegment } from '../data/waves';
import { tuning } from './config';
import { DROP_KIND_MAGNET } from './drop';
import { FX_LIFE_RESONANCE, FXV_RESONANCE } from './fx';
import { wrapAngle } from './ship';
import {
  ENEMY_RECYCLE_RADIUS,
  ENEMY_RECYCLE_SPREAD_DEG,
  THREAT_SPAWN_IMPULSE,
  World,
} from './world';

describe('World 槽位制核心接线', () => {
  it('同 seed replay 包含武器槽与法令层数', () => {
    const a = new World(10);
    const b = new World(10);
    a.acquireWeapon(TOWER_AUTOCANNON);
    b.acquireWeapon(TOWER_AUTOCANNON);
    a.grantEdict(EDICT_ARMOR);
    b.grantEdict(EDICT_ARMOR);
    for (let i = 0; i < 30; i++) { a.step(); b.step(); }
    expect(a.checksum()).toBe(b.checksum());
    a.weapons[0]!.turretOffset += 0.1;
    expect(a.checksum()).not.toBe(b.checksum());
  });

  it('获得、替换武器与授予法令返回明确代码', () => {
    const world = new World(1);
    expect(world.acquireWeapon(TOWER_AUTOCANNON)).toBe(0);
    expect(world.acquireWeapon(TOWER_LASER)).toBe(0);
    expect(world.acquireWeapon(999)).toBe(-51);
    expect(world.grantEdict(EDICT_ARMOR)).toBe(0);
    expect(world.grantEdict(999)).toBe(-54); // EDICT_INVALID_TYPE
    expect(world.replaceWeapon(0, TOWER_LASER)).toBe(0);
    expect(world.replaceWeapon(99, TOWER_AUTOCANNON)).toBe(-60);
  });

  it('法令叠层到 EDICT_MAX_LEVEL 封顶,满层再授予返回 EDICT_MAXED', () => {
    const world = new World(1);
    for (let i = 0; i < EDICT_MAX_LEVEL; i++) expect(world.grantEdict(EDICT_ARMOR)).toBe(0);
    expect(edictLevel(world.edictLevels, EDICT_ARMOR)).toBe(EDICT_MAX_LEVEL);
    expect(world.grantEdict(EDICT_ARMOR)).toBe(-53); // EDICT_MAXED
    expect(edictLevel(world.edictLevels, EDICT_ARMOR)).toBe(EDICT_MAX_LEVEL);
  });

  it('换位:交换两个槽的内容,越界/同槽被拒', () => {
    const world = new World(1);
    world.acquireWeapon(TOWER_AUTOCANNON);
    world.acquireWeapon(TOWER_LASER);
    expect(world.swapWeapons(0, 1)).toBe(0);
    expect(world.weapons[0]!.type).toBe(TOWER_LASER);
    expect(world.weapons[1]!.type).toBe(TOWER_AUTOCANNON);
    // 与空槽换 = 把炮挪个朝向,合法
    expect(world.swapWeapons(1, 5)).toBe(0);
    expect(world.weapons[5]!.type).toBe(TOWER_AUTOCANNON);
    expect(world.weapons[1]!.type).toBe(-1);
    expect(world.swapWeapons(0, 0)).toBe(-80); // SWAP_BAD_SLOT:换了等于没换
    expect(world.swapWeapons(0, 99)).toBe(-80);
  });

  it('三合一升星:同星凑满 3 把当场合一 —— 3× 1★ → 2★,3× 2★ → 3★ 变身合成武器', () => {
    const world = new World(2);
    // 前两把 1★:各落一个槽,同型也照占槽,不合成
    expect(world.acquireWeapon(TOWER_AUTOCANNON)).toBe(0);
    expect(world.acquireWeapon(TOWER_AUTOCANNON)).toBe(0);
    expect(world.weapons[0]!.type).toBe(TOWER_AUTOCANNON);
    expect(world.weapons[1]!.type).toBe(TOWER_AUTOCANNON);
    expect(world.weapons.filter((slot) => slot.type >= 0)).toHaveLength(2);
    // 第 3 把 1★:三把当场合一 → 最早槽(0)升 2★,其余两槽腾空
    expect(world.acquireWeapon(TOWER_AUTOCANNON)).toBe(0);
    expect(world.weapons[0]!.type).toBe(TOWER_AUTOCANNON);
    expect(world.weapons[0]!.stars).toBe(2);
    expect(world.weapons[1]!.type).toBe(-1);
    expect(world.weapons[2]!.type).toBe(-1);
    expect(world.weapons.filter((slot) => slot.type >= 0)).toHaveLength(1);
    // 再集六把 1★ = 再合两把 2★;第三把 2★ 合出的那一刻连锁:三把 2★ 当场合一 → 3★
    // 且有配方 → 当场变身风暴机炮(节流状态全清重装),其余两槽腾空
    for (let i = 0; i < 6; i++) expect(world.acquireWeapon(TOWER_AUTOCANNON)).toBe(0);
    expect(world.weapons[0]!.type).toBe(TOWER_STORM_CANNON);
    expect(world.weapons[0]!.stars).toBe(STAR_MAX);
    expect(world.weapons[1]!.type).toBe(-1);
    expect(world.weapons[2]!.type).toBe(-1);
    expect(world.weapons.filter((slot) => slot.type >= 0)).toHaveLength(1);
    // 原型槽已变身,再收同型从头养一条 1★ 线
    expect(world.acquireWeapon(TOWER_AUTOCANNON)).toBe(0);
    expect(world.weapons.filter((slot) => slot.type === TOWER_AUTOCANNON)).toHaveLength(1);
  });

  it('无配方的塔:3× 2★ → 3★ 到顶不变身,再收同型从头养新线(防御性兜底)', () => {
    const world = new World(2);
    for (let i = 0; i < 9; i++) expect(world.acquireWeapon(TOWER_MISSILE_NEST)).toBe(0);
    const occupied = world.weapons.filter((slot) => slot.type >= 0);
    expect(occupied).toHaveLength(1);
    expect(occupied[0]!.type).toBe(TOWER_MISSILE_NEST);
    expect(occupied[0]!.stars).toBe(STAR_MAX);
    // 到顶后再收同型:卡池已把满 3★ 剔掉,这里只保证落空槽 1★、从头养,不做无操作
    expect(world.acquireWeapon(TOWER_MISSILE_NEST)).toBe(0);
    expect(world.weapons.filter((slot) => slot.type === TOWER_MISSILE_NEST)).toHaveLength(2);
  });

  it('槽满挡住一切获得(同型也不例外):未拥有与已拥有都回 REPLACE_NEEDED', () => {
    const world = new World(2);
    const types = [0, 1, 2, 3, 4, 5, TOWER_MISSILE_NEST, TOWER_STORM_CANNON];
    for (let i = 0; i < 8; i++) {
      world.weapons[i]!.type = types[i]!;
      world.weapons[i]!.stars = 1;
    }
    expect(world.acquireWeapon(TOWER_AUTOCANNON)).toBeLessThan(0); // 未拥有 + 槽满
    expect(world.acquireWeapon(TOWER_AUTOCANNON)).toBeLessThan(0); // 已拥有(槽 0)+ 槽满也一样
    // 替换通道照常:换下槽 0,新机炮落位 1★(同型只有一把,无合成)
    expect(world.replaceWeapon(0, TOWER_AUTOCANNON)).toBe(0);
    expect(world.weapons[0]!.type).toBe(TOWER_AUTOCANNON);
    expect(world.weapons[0]!.stars).toBe(1);
  });

  it('替换也参与三合一:换入的一把凑满三把 1★,当场合一;换下 2★ 换成 1★ 是玩家的自由', () => {
    const world = new World(2);
    expect(world.acquireWeapon(TOWER_AUTOCANNON)).toBe(0); // 槽 0:1★
    expect(world.acquireWeapon(TOWER_AUTOCANNON)).toBe(0); // 槽 1:1★
    expect(world.acquireWeapon(TOWER_LASER)).toBe(0); // 槽 2:1★
    // 槽 2 换成机炮:三把 1★ 凑满 → 合一,幸存槽 = 最早槽 0 → 2★,槽 1/2 腾空
    expect(world.replaceWeapon(2, TOWER_AUTOCANNON)).toBe(0);
    expect(world.weapons[0]!.stars).toBe(2);
    expect(world.weapons[1]!.type).toBe(-1);
    expect(world.weapons[2]!.type).toBe(-1);
    // 异型替换:旧武器清空、新武器落位 1★
    expect(world.replaceWeapon(0, TOWER_RAILGUN)).toBe(0);
    expect(world.weapons[0]!.type).toBe(TOWER_RAILGUN);
    expect(world.weapons[0]!.stars).toBe(1);
  });

  it('法令聚合驱动船体上限:装甲协议每层 +15,授予当帧就生效', () => {
    const world = new World(3);
    world.grantEdict(EDICT_ARMOR);
    // grantEdict 自己就同步了上限(不必等下一帧 step):点下卡片那一瞬血条就该动
    expect(world.ship.maxHp).toBe(115);
    world.step();
    expect(world.ship.maxHp).toBe(115);
    world.grantEdict(EDICT_ARMOR);
    expect(world.ship.maxHp).toBe(130);
  });

  it('星币按概率掉落:每次击杀恒掷 1 次 rng —— 概率高低不移动随机序列', () => {
    const mk = (charts: number): World => {
      const w = new World(77);
      for (let i = 0; i < charts; i++) w.grantEdict(EDICT_STARCHART);
      return w;
    };
    const a = mk(0); // 基础 10%
    const b = mk(EDICT_MAX_LEVEL); // 10% + 5×8% = 50%
    for (let i = 0; i < 200; i++) {
      for (const w of [a, b]) {
        const e = w.enemies.spawn();
        e.hp = e.maxHp = 1;
        w.damageEnemy(e, 5);
      }
      a.step();
      b.step();
    }
    // 概率不同、掷的次数相同:同 seed 同操作序列,两条随机流必须停在同一格
    // (少了"每杀恒掷一次"这条,拿一层星图协议就会把整局的出怪序列整体挪位)
    expect(a.rng.next()).toBe(b.rng.next());
    // 概率真的起作用了:5 层星图协议的收入应当明显高于基础档(200 杀,期望 20 vs 100)。
    // 钉的是**这一局挣到的**,不是余额 —— 开局白送的 STARTING_STAR_COINS 两边一样多,
    // 留在读数里只会把两档的倍数差冲淡(15 + 20 与 15 + 100 的比值远小于真实的 5 倍)
    const earned = (w: World): number => w.starCoins - STARTING_STAR_COINS;
    expect(earned(a)).toBeGreaterThan(0);
    expect(earned(b)).toBeGreaterThan(earned(a) * 2);
  });

  it('开局白送 STARTING_STAR_COINS:一分没杀就有余额,且不因 seed 而变', () => {
    // 与出怪/掉落无关的常数:换 seed 不该换到第二个数(它不掷 rng,也不进 checksum)
    expect(new World(1).starCoins).toBe(STARTING_STAR_COINS);
    expect(new World(999).starCoins).toBe(STARTING_STAR_COINS);
    // 第一家店(武器 30 / 法令 25 / 修复 25)仍买不起:白送的是半样东西,不是一整套起手装备
    expect(STARTING_STAR_COINS).toBeLessThan(DOCK_REPAIR_PRICE);
  });

  it('checksum 不包含星币余额', () => {
    const a = new World(4);
    const b = new World(4);
    a.starCoins = 100;
    expect(a.checksum()).toBe(b.checksum());
  });
});

describe('加速技能(空格)', () => {
  it('触发即提速:巡航上限按 boostSpeedMul 抬高,窗内速度超过普通巡航', () => {
    const world = new World(7);
    const east = { desiredHeading: { x: 1, y: 0 }, boost: false };
    // 先把船头转向 +X 并推到普通巡航稳态
    for (let i = 0; i < 240; i++) world.step(east);
    const normalSpeed = Math.hypot(world.ship.vx, world.ship.vy);
    expect(normalSpeed).toBeLessThanOrEqual(tuning.shipCruiseSpeed + 1e-6);

    east.boost = true;
    world.step(east);
    expect(world.boostTime).toBeGreaterThan(0);
    expect(world.boostCooldown).toBeGreaterThan(0);
    for (let i = 0; i < 30; i++) world.step(east);
    const boosted = Math.hypot(world.ship.vx, world.ship.vy);
    expect(boosted).toBeGreaterThan(normalSpeed * 1.5);
    expect(boosted).toBeLessThanOrEqual(tuning.shipCruiseSpeed * tuning.boostSpeedMul + 1e-6);
  });

  it('冷却门槛:窗结束后按住空格不重触发,冷却归零后才能再次点火', () => {
    const world = new World(8);
    const cmd = { desiredHeading: { x: 1, y: 0 }, boost: true };
    world.step(cmd);
    const cdAfterFire = world.boostCooldown;
    expect(cdAfterFire).toBeCloseTo(tuning.boostCooldown - 1 / 60, 3);
    // 走完加速窗:boostTime 归零,但冷却仍在走,按着空格也不再点火
    const windowTicks = Math.ceil(tuning.boostDuration * 60) + 2;
    for (let i = 0; i < windowTicks; i++) world.step(cmd);
    expect(world.boostTime).toBe(0);
    expect(world.boostCooldown).toBeGreaterThan(0);
    // 冷却走完的下一帧:再次点火
    const restTicks = Math.ceil(world.boostCooldown * 60) + 2;
    for (let i = 0; i < restTicks; i++) world.step(cmd);
    expect(world.boostTime).toBeGreaterThan(0);
  });

  it('无方向输入时沿船头满推:松着方向键按空格,船也真的动起来', () => {
    const world = new World(9);
    const cmd = { desiredHeading: null, boost: true };
    for (let i = 0; i < 30; i++) world.step(cmd);
    expect(Math.hypot(world.ship.vx, world.ship.vy)).toBeGreaterThan(50);
  });

  it('计时器进 checksum:同 seed 一边点火一边不点,哈希当场分叉', () => {
    const a = new World(10);
    const b = new World(10);
    a.step({ desiredHeading: null, boost: true });
    b.step({ desiredHeading: null, boost: false });
    expect(a.checksum()).not.toBe(b.checksum());
  });

  it('加速窗内船体受伤按 boostDamageTakenMul 打折,窗外全额', () => {
    const world = new World(13);
    world.damageShip(10);
    expect(world.ship.hp).toBeCloseTo(90);
    world.step({ desiredHeading: null, boost: true }); // 点火:窗内
    expect(world.boostTime).toBeGreaterThan(0);
    world.damageShip(10);
    expect(world.ship.hp).toBeCloseTo(90 - 10 * tuning.boostDamageTakenMul);
  });
});

describe('逐武器 DPS 读数', () => {
  it('带塔型的伤害按型归账,窗口平滑收敛后不打则衰减回落', () => {
    const world = new World(11);
    const e = world.enemies.spawn();
    e.hp = e.maxHp = 1e6;
    expect(world.dpsOf(TOWER_AUTOCANNON)).toBe(0);
    // 稳定输入 600 伤害/秒(每帧 10):平滑值应收敛到 600 附近
    for (let i = 0; i < 600; i++) {
      world.step();
      world.damageEnemy(e, 10, undefined, TOWER_AUTOCANNON);
    }
    const settled = world.dpsOf(TOWER_AUTOCANNON);
    expect(settled).toBeGreaterThan(500);
    expect(settled).toBeLessThan(700);
    // 未被归账的型保持 0;型越界读不炸
    expect(world.dpsOf(TOWER_LASER)).toBe(0);
    expect(world.dpsOf(-1)).toBe(0);
    expect(world.dpsOf(999)).toBe(0);
    // 停火后按 2.5s 窗口衰减:5 秒后剩不到两成
    for (let i = 0; i < 300; i++) world.step();
    expect(world.dpsOf(TOWER_AUTOCANNON)).toBeLessThan(settled * 0.2);
  });

  it('本局累计伤害与峰值 DPS 逐帧落账(局末战报的两份读数)', () => {
    const world = new World(14);
    const e = world.enemies.spawn();
    e.hp = e.maxHp = 1e6;
    world.damageEnemy(e, 100, undefined, TOWER_AUTOCANNON);
    world.damageEnemy(e, 50, undefined, TOWER_AUTOCANNON);
    world.damageEnemy(e, 30, undefined, TOWER_LASER);
    // 累计账不衰减:就是打出去的原数
    expect(world.runDamageByType[TOWER_AUTOCANNON]).toBeCloseTo(150);
    expect(world.runDamageByType[TOWER_LASER]).toBeCloseTo(30);
    // 峰值在下一帧帧首取样(衰减后的稳态口径):step 一帧后 > 0,此后停火只降不升
    world.step();
    const peak = world.peakDps;
    expect(peak).toBeGreaterThan(0);
    for (let i = 0; i < 120; i++) world.step();
    expect(world.peakDps).toBe(peak);
  });

  it('DPS 读数不进 checksum(纯 HUD 读数,照 threatRate 口径)', () => {
    const a = new World(12);
    const b = new World(12);
    const e = a.enemies.spawn();
    e.hp = e.maxHp = 1e6;
    const f = b.enemies.spawn();
    f.hp = f.maxHp = 1e6;
    // 同样的伤害、一边带归因一边不带:世界状态(hp)一致,哈希必须一致
    a.damageEnemy(e, 50, undefined, TOWER_AUTOCANNON);
    b.damageEnemy(f, 50);
    expect(a.dpsOf(TOWER_AUTOCANNON)).toBeGreaterThan(0);
    expect(b.dpsOf(TOWER_AUTOCANNON)).toBe(0);
    expect(a.checksum()).toBe(b.checksum());
  });
});

describe('齐射共振(24 号)', () => {
  // fired 走私有 sink(塔开火的唯一事件通道),与 sim 侧单测"直接调入口"同一条手法
  const fire = (world: World, slot: number): void =>
    (world as unknown as { sink: { fired(slotIndex: number): void } }).sink.fired(slot);
  const resonances = (world: World) => world.fx.items.filter((e) => e.kind === FXV_RESONANCE);
  // 三种不同塔型填满 0/1/2 三槽(同型三把会合成,不同型不合成)
  const loadThree = (world: World): void => {
    expect(world.acquireWeapon(TOWER_AUTOCANNON)).toBe(0);
    expect(world.acquireWeapon(TOWER_LASER)).toBe(0);
    expect(world.acquireWeapon(TOWER_ARC)).toBe(0);
  };

  it('相邻三槽窗口内开火触发共振:fx 池出现 FXV_RESONANCE,life > 0', () => {
    const world = new World(30);
    loadThree(world);
    fire(world, 0);
    fire(world, 1);
    expect(resonances(world)).toHaveLength(0);
    fire(world, 2);
    const evs = resonances(world);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.life).toBeCloseTo(FX_LIFE_RESONANCE, 6);
  });

  it('只有两槽开火不触发', () => {
    const world = new World(31);
    loadThree(world);
    fire(world, 0);
    fire(world, 1);
    expect(resonances(world)).toHaveLength(0);
  });

  it('7-0-1 环回三元组触发(mod 8),事件中心槽 = 0', () => {
    const world = new World(32);
    loadThree(world);
    expect(world.swapWeapons(2, 7)).toBe(0); // 槽 2 的炮挪到 7:7/0/1 成一舷
    fire(world, 7);
    fire(world, 0);
    expect(resonances(world)).toHaveLength(0);
    fire(world, 1);
    const evs = resonances(world);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.towerType).toBe(0);
  });

  it('三元组中间夹空槽不触发', () => {
    const world = new World(33);
    loadThree(world);
    expect(world.swapWeapons(1, 5)).toBe(0); // 0 与 2 有炮、1 空:0-1-2 不成立
    fire(world, 0);
    fire(world, 2);
    fire(world, 5);
    expect(resonances(world)).toHaveLength(0);
  });

  it('窗口过期后再开第三炮不触发', () => {
    const world = new World(34);
    loadThree(world);
    fire(world, 0);
    fire(world, 1);
    // 推过 RESONANCE_WINDOW(0.5s = 30 tick)再加两帧余量:前两炮的账过期
    for (let i = 0; i < 32; i++) world.step();
    fire(world, 2);
    expect(resonances(world)).toHaveLength(0);
  });

  it('冷却期内二次齐射不重复触发,冷却结束后恢复', () => {
    const world = new World(35);
    loadThree(world);
    fire(world, 0);
    fire(world, 1);
    fire(world, 2);
    expect(resonances(world)).toHaveLength(1);
    expect(world.resonanceCooldown).toBe(4);
    // 冷却期内(0.5s 窗远小于 4s)再齐射:不再推第二个事件
    fire(world, 0);
    fire(world, 1);
    fire(world, 2);
    expect(resonances(world)).toHaveLength(1);
    // 冷却走完(4s = 240 tick)后再次齐射:恢复触发
    for (let i = 0; i < 241; i++) world.step();
    expect(world.resonanceCooldown).toBe(0);
    expect(resonances(world)).toHaveLength(0);
    fire(world, 0);
    fire(world, 1);
    fire(world, 2);
    expect(resonances(world)).toHaveLength(1);
  });

  it('1-2-3 触发时事件携带正确中心槽下标 towerType = 2', () => {
    const world = new World(36);
    loadThree(world);
    expect(world.swapWeapons(0, 3)).toBe(0); // 槽 0 的炮挪到 3:1/2/3 成一舷
    fire(world, 3);
    fire(world, 2);
    fire(world, 1);
    const evs = resonances(world);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.towerType).toBe(2);
  });
});

describe('磁吸涌(26 号)', () => {
  // 短脚本手法与 boss.test.ts 同口径:真脚本 120s 段干等不起,splice 进来跑完必须还原,
  // 否则污染同文件后续用例(stepWaves 每帧现读 WAVE_SEGMENTS)
  const REAL = WAVE_SEGMENTS.slice();
  afterEach(() => {
    WAVE_SEGMENTS.splice(0, WAVE_SEGMENTS.length, ...REAL);
  });
  const shortSeg = (name: string, duration: number): WaveSegment => ({
    name,
    duration,
    dirStartDeg: 0,
    dirEndDeg: 0,
    streams: [],
    bursts: [],
    elites: [],
    tides: [],
  });
  const useScript = (...segs: WaveSegment[]): WaveSegment[] =>
    WAVE_SEGMENTS.splice(0, WAVE_SEGMENTS.length, ...segs);
  /** 杀一只精英(affixes ≠ 0):spawn → 置词缀位 → 致死 → step 让帧尾 reap 落账 */
  const killElite = (world: World, affix: number): void => {
    const e = world.enemies.spawn();
    e.hp = e.maxHp = 10;
    e.affixes = 1 << affix;
    world.damageEnemy(e, 99);
    world.step();
  };

  it('精英死亡必掉一颗磁吸宝物,拾起置 MAGNET_PICKUP_SURGE;普通怪不掉', () => {
    const world = new World(41);
    killElite(world, AFFIX_FRENZY);
    expect(world.eliteKills).toBe(1);
    // 掉落排在帧尾 reap(stepDrops 之后):killElite 那一帧宝物已躺在场上,涌还没置
    expect(world.drops.items.filter((d) => d.kind === DROP_KIND_MAGNET).length).toBe(1);
    expect(world.magnetSurgeTime).toBe(0);
    // 敌人掉在原点、船停在原点:下一帧的 stepDrops 把它收下并报数,置位排在递减之后 ——
    // 足额 MAGNET_PICKUP_SURGE,不缩一格
    world.step();
    expect(world.drops.items.some((d) => d.kind === DROP_KIND_MAGNET)).toBe(false);
    expect(world.magnetSurgeTime).toBe(MAGNET_PICKUP_SURGE);
    // 普通怪(无词缀)死亡:只掉经验残骸,不掉宝物
    const normal = world.enemies.spawn();
    normal.hp = normal.maxHp = 10;
    world.damageEnemy(normal, 99);
    world.step();
    expect(world.drops.items.some((d) => d.kind === DROP_KIND_MAGNET)).toBe(false);
  });

  it('涌还醒着时拾起第二颗宝物取 max 不叠加', () => {
    const world = new World(42);
    // 余量 1.5s 时拾起:max(1.5 - SIM_DT, 2.0) = 2.0 —— 补满,不叠加成 3.5
    world.magnetSurgeTime = 1.5;
    killElite(world, AFFIX_FRENZY);
    world.step();
    expect(world.magnetSurgeTime).toBeCloseTo(MAGNET_PICKUP_SURGE, 6);
    // 余量高于涌时长时再拾起:max 保留现值 —— 连拾两颗不把涌抻成常态。
    // 置位前那两帧(杀精英帧 + 拾起帧)各减过一格:现值 = 2.3 - 2 × SIM_DT
    world.magnetSurgeTime = 2.3;
    killElite(world, AFFIX_ARMORED);
    world.step();
    expect(world.magnetSurgeTime).toBeCloseTo(2.3 - 2 * SIM_DT, 6);
  });

  it('涌期间远处(> 基础半径 80、< 弃置半径 2000)掉落被锁定并收取;涌结束新掉落回基础半径', () => {
    useScript(shortSeg('a', 60), shortSeg('b', 60));
    const world = new World(43);
    const farDrop = (value: number) => {
      const d = world.drops.spawn();
      d.x = d.px = 500; // 500:tuning.dropMagnetRadius(80) 之上、DROP_CULL_RADIUS(2000) 之内
      d.y = d.py = 0;
      d.value = value;
      return d;
    };
    // 无涌:500px 超基础起吸半径,不起吸、不锁定(也没出弃置半径,原样躺着)
    const stray = farDrop(10);
    world.step();
    expect(stray.magnet).toBe(false);
    expect(world.drops.size).toBe(1);

    // 涌开始:同一颗下一帧起吸判定进半径(80 × 25 = 2000),当场锁定 ——
    // 锁定是单向的(进过半径一次就永不放手),此后照飞照收
    world.magnetSurgeTime = MAGNET_PICKUP_SURGE;
    world.step();
    expect(stray.magnet).toBe(true);

    // 锁定后一路收到船里(500px ÷ 400px/s ≈ 1.25s < 2.0s 涌窗):全额进账
    const before = world.scrap;
    while (world.drops.size > 0) world.step();
    expect(world.scrap).toBe(before + 10);
    // 涌自然衰减归零(场上没有第二颗宝物可拾)
    while (world.magnetSurgeTime > 0) world.step();
    expect(world.magnetSurgeTime).toBe(0);

    // 涌结束后的新掉落到远处:回到基础半径,不被锁定(仍在弃置半径内,不被折半回收)
    const next = farDrop(7);
    world.step();
    expect(next.magnet).toBe(false);
    expect(world.drops.size).toBe(1);
  });

  it('涌计时进 checksum:同 seed 一边置涌一边不置,哈希当场分叉', () => {
    const a = new World(44);
    const b = new World(44);
    a.step();
    b.step();
    expect(a.checksum()).toBe(b.checksum());
    a.magnetSurgeTime = 1;
    expect(a.checksum()).not.toBe(b.checksum());
  });

  it('双世界同 seed 同操作:拾起宝物置位与涌衰减不破 checksum 逐帧一致', () => {
    const a = new World(45);
    const b = new World(45);
    // 先各自杀一只精英(确定性时刻、零 rng),再各跑一帧把掉在原点的宝物拾起 ——
    // 覆盖"拾起置位那一帧"与"涌衰减中的帧"两类逐帧哈希
    killElite(a, AFFIX_FRENZY);
    killElite(b, AFFIX_FRENZY);
    expect(a.checksum()).toBe(b.checksum());
    // 2.0s 涌 = 120 帧;跑 150 帧,涌已两边同归于 0
    for (let i = 0; i < 150; i++) {
      a.step();
      b.step();
      expect(a.checksum()).toBe(b.checksum());
    }
    expect(a.magnetSurgeTime).toBe(b.magnetSurgeTime);
    expect(a.magnetSurgeTime).toBe(0);
  });
});

describe('视野回收重投(无限地图防风筝)', () => {
  // 封闭夹具:压测路旁路出怪脚本(场上只有手里这一只、罗盘没有其他样本、rng 一字不动)。
  // stressEnemies 取 1 而不是 0 —— 0 会让 stressSyncCounts 把刚手摆的怪当场清掉。
  const prevSpawn: { on: boolean; n: number } = { on: tuning.stressSpawn, n: tuning.stressEnemies };

  beforeEach(() => {
    tuning.stressSpawn = true;
    tuning.stressEnemies = 1;
  });
  afterEach(() => {
    tuning.stressSpawn = prevSpawn.on;
    tuning.stressEnemies = prevSpawn.n;
  });

  /** 手摆一只蜂群蛭在船的 (x, y) 相对位置、钉死 animSeed 与航向(朝东 = 0),返回世界与它 */
  const place = (seed: number, x: number, y: number, animSeed: number) => {
    const w = new World(seed);
    w.ship.heading = 0;
    const e = w.enemies.spawn();
    e.kind = KIND_SWARM;
    e.hp = e.maxHp = 1; // 照 killElite 的口径:池出生是空壳,hp 要自己给(这一局没有武器,不会被打死)
    e.x = e.px = x;
    e.y = e.py = y;
    e.animSeed = animSeed;
    return { w, e };
  };

  it('边界:越界者回收进 [出怪内沿, 外沿) 的航向前向扇面,圈内者不动', () => {
    for (const s of [0, 0.5, 0.99999]) {
      const { w, e } = place(7, ENEMY_RECYCLE_RADIUS + 1, 0, s);
      w.step();
      // 落点半径 = SPAWN_RADIUS + s*BAND,px/py 都停在新位置上(回收在 px 存档之前,插值无拖影)
      const dist = Math.hypot(e.px - w.ship.x, e.py - w.ship.y);
      expect(dist).toBeCloseTo(SPAWN_RADIUS + s * SPAWN_RADIUS_BAND, 8);
      // 方位在航向 ± 半宽锥内
      const rel = Math.abs(wrapAngle(Math.atan2(e.py - w.ship.y, e.px - w.ship.x) - w.ship.heading));
      expect(rel).toBeLessThanOrEqual((ENEMY_RECYCLE_SPREAD_DEG * Math.PI) / 180 + 1e-7);
    }
    // 圈内(离触发界 1px)不回收:px 存档时刻仍在原处
    const { w, e } = place(8, ENEMY_RECYCLE_RADIUS - 1, 0, 0.5);
    w.step();
    expect(e.px).toBe(ENEMY_RECYCLE_RADIUS - 1);
  });

  it('回收零 rng;威胁罗盘恰吃一发脉冲、方向 = 实际落点方位、强度不动', () => {
    const { w, e } = place(9, 1500, 0, 0.25);
    const before = w.rng.state;
    w.step();
    expect(w.rng.state).toBe(before);
    const dx = e.px - w.ship.x;
    const dy = e.py - w.ship.y;
    const dist = Math.hypot(dx, dy);
    expect(w.threatDirX).toBeCloseTo((dx / dist) * THREAT_SPAWN_IMPULSE, 12);
    expect(w.threatDirY).toBeCloseTo((dy / dist) * THREAT_SPAWN_IMPULSE, 12);
    // 只喂方向不喂 threatRate:回收没有新增一只怪
    expect(w.threatIntensity).toBe(0);
  });

  it('新生儿安全:出怪环外沿的怪不会被当场误判,常量不等式钉死', () => {
    expect(ENEMY_RECYCLE_RADIUS).toBe(SPAWN_RADIUS + SPAWN_RADIUS_BAND + 50);
    const { w, e } = place(10, SPAWN_RADIUS + SPAWN_RADIUS_BAND, 0, 0.5);
    w.step();
    expect(e.px).toBe(SPAWN_RADIUS + SPAWN_RADIUS_BAND);
  });
});

describe('视野回收重投·长航(默认波次路径)', () => {
  it('20 秒直飞:缓冲圈箍住全场、前方跑步机非空、双世界逐帧 checksum 一致', () => {
    const a = new World(5);
    const b = new World(5);
    const half = (ENEMY_RECYCLE_SPREAD_DEG * Math.PI) / 180;
    let maxDist = 0;
    let treadmillSeen = false;
    for (let i = 0; i < 1200; i++) {
      a.step({ desiredHeading: { x: 1, y: 0 } });
      b.step({ desiredHeading: { x: 1, y: 0 } });
      if (i % 60 === 0) expect(a.checksum()).toBe(b.checksum());
      for (const e of a.enemies.items) {
        const d = Math.hypot(e.x - a.ship.x, e.y - a.ship.y);
        if (d > maxDist) maxDist = d;
        // 跑步机在送怪上前:px = 当帧移动前的位置 —— 刚回收的怪 px 恰落在 [SPAWN_RADIUS, +BAND)
        // 的航向锥内,下一 tick 就开始向船收近、缩到内沿以下,所以只能逐帧盯 px 不能盯帧末 x
        const pdx = e.px - a.ship.x;
        const pdy = e.py - a.ship.y;
        if (
          !treadmillSeen &&
          Math.hypot(pdx, pdy) >= SPAWN_RADIUS - 1e-6 &&
          Math.abs(wrapAngle(Math.atan2(pdy, pdx) - a.ship.heading)) <= half + 1e-7
        ) {
          treadmillSeen = true;
        }
      }
    }
    // 全程无一只越过缓冲圈(触发 1350 + 单 tick 最大位移/分离推挤余量)
    expect(maxDist).toBeLessThan(ENEMY_RECYCLE_RADIUS + 40);
    // 越出 30px 余量带的怪只能是回收产物 —— 必在航向锥内(出怪带外沿 1300 + 位移到不了这一档)
    for (const e of a.enemies.items) {
      const d = Math.hypot(e.x - a.ship.x, e.y - a.ship.y);
      if (d > ENEMY_RECYCLE_RADIUS + 30) {
        const rel = Math.abs(wrapAngle(Math.atan2(e.y - a.ship.y, e.x - a.ship.x) - a.ship.heading));
        expect(rel).toBeLessThanOrEqual(half + 1e-7);
      }
    }
    expect(treadmillSeen).toBe(true);
  });
});
