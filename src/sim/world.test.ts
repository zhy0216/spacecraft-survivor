import { describe, expect, it } from 'vitest';
import { DOCK_REPAIR_PRICE, STARTING_STAR_COINS } from '../data/economy';
import { EDICT_ARMOR, EDICT_MAX_LEVEL, EDICT_STARCHART, edictLevel } from '../data/edicts';
import { TOWER_ARC, TOWER_AUTOCANNON, TOWER_LASER, TOWER_MAX_LEVEL } from '../data/towers';
import { tuning } from './config';
import { FX_LIFE_RESONANCE, FXV_RESONANCE } from './fx';
import { World } from './world';

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

  it('四次重复获得触发合成时保留最高等级并释放槽位', () => {
    const world = new World(2);
    for (let i = 0; i < 3; i++) expect(world.acquireWeapon(TOWER_AUTOCANNON)).toBe(0);
    const occupied = world.weapons.filter((slot) => slot.type >= 0);
    expect(occupied).toHaveLength(1);
    expect(occupied[0]!.level).toBeLessThanOrEqual(TOWER_MAX_LEVEL);
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
