/**
 * **局内存档**的纯数据层(与 sim/progress.ts 的"元进度"是两件事:那份记跨局解锁,
 * 这份记"这一局打到哪了")。铁律 1 的边界与 progress.ts 一字同源:
 * 本文件**零 DOM / 零 localStorage**,Node 里可单测;localStorage 的读写适配在
 * ui/runSaveStorage.ts,存档时机与读档后的接线在 main.ts —— 全在下游,本文件不认识它们。
 *
 * ## 口径:存的是 checksum 认的那一份状态
 *
 * "这一局接着打"的唯一验收标准是 **capture → restore 之后 checksum 不变,
 * 且此后每一帧都继续不变**(runSave.test.ts 就是这么钉的)。于是本文件的字段表
 * 不是照着"看起来重要"挑的,而是照着 World.checksum() 那份清单逐条对齐的 ——
 * 那份清单已经把"什么是真状态、什么是派生量"辩论完了,存档没有资格再辩一遍。
 *
 * 由此推出三类**不存**的字段,每一类都在下面的 EN_* / BU_* 常量处逐条记了名:
 * 1. **派生量**(ship.maxHp / wave.dirRad / buffs / upgradeCost / result / shipDead):
 *    step() 帧首统一现算,存了反而会在"存档时的数据表"与"读档时的数据表"之间造出矛盾 ——
 *    改了 tuning 再读档,存的是旧上限、算的是新上限,血条当场对不上。
 * 2. **纯表现**(px/py/pheading 插值基准、hitFlash 闪白、fx 事件池、dpsByType 平滑读数、
 *    threatRate/DirX/DirY 罗盘平滑):少一帧插值、少闪一次白不改变世界的下一帧。
 *    插值基准读档时对齐成当前位置(见 restoreRun),否则第一帧会从上一局的位置拖一条线过来。
 * 3. **同帧即消费的闩**(enemy.dead / sporeFire):它们在一帧之内产生并消费,
 *    而存档只发生在帧边界上(main 只在时停/暂停时存)—— 跨帧恒为初值。
 *
 * ## rng 游标必须存
 *
 * 存档最容易漏、也最难查的一样:`rng.state`。漏了它,读档后的世界会从 seed 的**开头**
 * 重新掷 —— 出怪序列、货架、候选卡全部回到第 0 帧那一批,而船与槽位却停在第 300 秒,
 * 症状是"读档后怪突然变简单了"这种没人会联想到随机数的现象。core/rng.ts 的 state
 * 访问器**只为这一处而开**。
 *
 * ## 版本号进结构而不是进键名
 *
 * 与 progressStorage 的"版本号进键名即清档"相反:局内存档 parse 时校验 `v`,
 * 对不上直接判废(返回 null)。理由是两者的损失不对称 —— 元进度丢了是几十局的解锁,
 * 值得为兼容费心;半局进度丢了就是这一把,而"读进来一份字段对不齐的半局"会以
 * "读档后船原地爆炸"的形式发作,远不如干脆判废、让玩家重开一局来得诚实。
 */
import { SIM_DT } from '../core/loop';
import { EDICT_KIND_COUNT } from '../data/edicts';
import { TOWER_KIND_COUNT } from '../data/towers';
import { WAVE_SEGMENTS } from '../data/waves';
import { WEAPON_SLOT_COUNT } from './armory';
import { hullMaxHp } from './damage';
import { aggregateEdictBuffs, createEdictBuffs } from './edictBuffs';
import { restoreWaveState } from './waves';
import { RESULT_RUNNING, World } from './world';

/**
 * 存档结构版本。**改了任何一条字段表(顺序 / 数量 / 含义)就必须 +1** ——
 * 旧档此后判废(见文件头"版本号进结构"那段)。stride 常量的单测会替你记住这件事:
 * 往 Enemy 里加一个字段而忘了这里,runSave.test.ts 的字段数守卫当场变红。
 *
 * v3(26 号磁吸涌):快照新增 magnetSurgeTime 标量 —— 它影响拾取半径、进 checksum,必须存。
 * v4(26 号改):掉落物新增 kind 字段(磁吸宝物与经验分流,DR_STRIDE 6→7);磁吸涌的
 *   触发从"跨段 / 精英死亡自动置位"改为"拾起磁吸宝物",magnetSurgeTime 标量原样保留。
 * v5(星级系统):武器槽的 level(1..5)改语义为 stars(1..3,2★/3★ = 旧 Lv3/Lv5 档);
 *   删除 weaponBankedLevels 字段与 OFFER_WEAPON_UPGRADE 类别 —— 存档不再有"存档等级"。
 * **只改了字段表才升版本**;旧档照"版本对不上直接判废"的既有口径丢弃(损失半局,可接受)。
 */
export const RUN_SAVE_VERSION = 5;

// —— 实体的扁平字段表 ——
// 池里的实体是存档的大头(几百只怪 × 十几个数),故不逐只存成对象,而是**平铺成一条数字数组**:
// 一只怪占 EN_STRIDE 个格子,顺序 = 下面这张表,**永不改**(改了就是换版本号)。
// 扁平化不是为了省字节,是为了让"漏存一个字段"这件事有一个可以被单测钉死的形状:
// 长度 % stride 必须为 0,而 stride 又与 Object.keys(createEnemy()).length 对表(见 runSave.test.ts)。

/**
 * 一只敌人占几个格子。字段顺序:
 * x, y, vx, vy, kind, affixes, hp, maxHp, state, timer, lockX, lockY, side, animSeed, hitCd
 *
 * **不存**(与 Enemy 结构的其余 5 个字段一一对应,理由见文件头三类):
 * px/py = 插值基准(读档时对齐成 x/y);hitFlash = 闪白纯表现;
 * lastHit = 伤害输入的派生量;dead/sporeFire = 同帧即消费的闩。
 * animSeed **要存**:它决定视野回收的落点(world.ts 的 ENEMY_RECYCLE_RADIUS 那段)与
 * 呼吸相位,且是由出生位置 hash 出来的定值 —— 读档时无从重算(出生位置早已不可考),
 * 不存的话读档后的回收落点会整片跑偏、全场虫子的相位也会在那一刻齐刷刷对齐。
 */
export const EN_STRIDE = 15;
/** 一颗我方子弹占几个格子:x, y, vx, vy, kind, damage, life, pierce, radius, aoeRadius, aoeDamage, towerType, throttle, intercept(0/1)。不存 px/py */
export const BU_STRIDE = 14;
/** 一颗敌方弹丸占几个格子:x, y, vx, vy, kind, damage, life, radius。不存 px/py */
export const EB_STRIDE = 8;
/** 一颗掉落物占几个格子:x, y, vx, vy, value, magnet(0/1), kind。不存 px/py */
export const DR_STRIDE = 7;
/** 一个武器槽占几个格子:type, stars, cooldown, ammo, reloadLeft, heat, coolLock, charge, turretOffset(= WeaponSlot 的全部字段) */
export const WP_STRIDE = 9;
/** 一张候选卡占几个格子:kind, type, level(= UpgradeOption 的全部字段) */
export const OF_STRIDE = 3;

/**
 * 一局的存档。字段分组照"这是什么"分,不照"存在哪"分:
 * 开跑前输入(seed / loadout / unlockMask)、随机游标、逐帧演化的真状态、实体池。
 *
 * 数组一律是**扁平数字数组**(见上面 stride 那段);标量分组用具名字段,读起来还认得出是什么。
 */
export interface RunSnapshot {
  /** 结构版本,必须 === RUN_SAVE_VERSION,否则判废 */
  v: number;
  /** 本局种子(开跑前输入)。读档 = new World(seed, unlockMask) 再把状态填回去 */
  seed: number;
  /** 本局起手配置下标(LOADOUTS)。**只为"再试一局"沿用**:读档本身不重放起手,槽位是存下来的 */
  loadout: number;
  /** 存档那一刻的解锁掩码(开跑前输入,决定卡池与解锁精英槽位) */
  unlockMask: number;
  /** rng 游标(mulberry32 状态)。漏了它读档后随机序列会退回开头,见文件头 */
  rng: number;
  /** 已跑的逻辑帧数。elapsed = tick × SIM_DT,HP 时间缩放与结算时长都读它 */
  tick: number;
  /** 船:x, y, vx, vy, heading, hp(maxHp 是派生量,帧首现算) */
  ship: number[];
  /** 武器槽,WEAPON_SLOT_COUNT × WP_STRIDE */
  weapons: number[];
  /** 法令层数表,长度 EDICT_KIND_COUNT(下标 = EDICT_*,值 = 层数 0..EDICT_MAX_LEVEL) */
  edicts: number[];
  /** 波次进度:segment, segTime, burstNext, eliteNext(elites/dirRad/intensity/done 是派生量) */
  wave: number[];
  /** 逐流出怪账 */
  debt: number[];
  /** 经济与流程:scrap, starCoins, upgrades, offerCooldown, offerRerolled(0/1), refitPending(0/1), boostTime, boostCooldown */
  econ: number[];
  /**
   * 磁吸涌剩余秒(26 号改):0 = 无涌。它决定起吸半径(涌 × 25 ≈ 全场)→ 进 checksum,
   * 照文件头"存的是 checksum 认的那一份状态"的清单口径,必须存 —— 漏了它,
   * 读档后涌消失,这一局的经济账从读档帧起与"没存过档"的局分叉。
   * 涌的触发权在掉落物池里(磁吸宝物的 kind 见 drops),标量只记"还剩几秒"。
   */
  magnetSurgeTime: number;
  /** 地图商店信标:active(0/1), x, y, ttl, segment */
  beacon: number[];
  /** 待选候选卡,N × OF_STRIDE(长度 0 = 没有待选) */
  offer: number[];
  /** 本轮船坞法令货架(已售出的格子是 -1) */
  dockEdicts: number[];
  /** 本轮商店武器货架(已售出的格子是 -1) */
  shopWeapons: number[];
  /** Boss:phase, summonN, summonCooldown, killedAt */
  boss: number[];
  /**
   * 局内统计:kills, eliteKills, peakDps。
   * 三者都**不进 checksum**(派生量口径),但都要存:它们是这一局的**账**,
   * 而账的去处是结算界面与元进度解锁判定 —— 读档后清零等于把玩家打了半小时的战绩抹掉。
   */
  tally: number[];
  /** 逐型累计伤害(武器战报),长度 TOWER_KIND_COUNT。与 tally 同一条"账不能抹"的理由 */
  damageByType: number[];
  /** 敌人池,N × EN_STRIDE */
  enemies: number[];
  /** 我方子弹池,N × BU_STRIDE */
  bullets: number[];
  /** 敌方弹丸池,N × EB_STRIDE */
  enemyBullets: number[];
  /** 掉落物池,N × DR_STRIDE */
  drops: number[];
}

/** 存档那一刻的额外输入 —— World 自己不知道的两样开跑前配置(种子归 World 但起手不归) */
export interface RunSaveMeta {
  /** 本局种子。World 不保存构造参数,故由流程层(main)递进来 */
  seed: number;
  /** 本局起手配置下标(LOADOUTS) */
  loadout: number;
}

/**
 * 这一局能不能存。**只有还在跑的局才存得**:已分出胜负的世界存下来,读档就是
 * 进一个立刻弹结算的死局(settleOutcome 的结论永不再变);
 * 沉船同理 —— 存一艘沉了的船,读档就是读进一次必死。
 * main 在每个存档时机前先问这一句(存档是"下一次接着打",不是"回放最后一帧")。
 */
export function canSaveRun(world: World): boolean {
  return world.result === RESULT_RUNNING && !world.shipDead;
}

/**
 * 把一局的当前状态摘成快照。**纯读**:一个字段都不改动 World,
 * 于是"存了个档"绝不可能成为这一局分叉的原因(存档最不该做的事就是改变被存的东西)。
 *
 * 调用时机由 main 定,但只在**帧边界**上调用(时停 / 暂停 / 离开页面):
 * 帧中调用会捞到 dead 闩没清、contacts 没结算的半帧状态 —— 那些字段本文件不存,
 * 而它们不存的前提正是"跨帧恒为初值"。
 */
export function captureRun(world: World, meta: RunSaveMeta): RunSnapshot {
  const ship = world.ship;
  const weapons: number[] = [];
  for (let i = 0; i < WEAPON_SLOT_COUNT; i++) {
    const s = world.weapons[i]!;
    weapons.push(
      s.type,
      s.stars,
      s.cooldown,
      s.ammo,
      s.reloadLeft,
      s.heat,
      s.coolLock,
      s.charge,
      s.turretOffset,
    );
  }
  const edicts: number[] = [];
  for (let i = 0; i < EDICT_KIND_COUNT; i++) edicts.push(world.edictLevels[i]!);

  const offer: number[] = [];
  for (const o of world.offer) offer.push(o.kind, o.type, o.level);

  const enemies: number[] = [];
  for (const e of world.enemies.items) {
    enemies.push(
      e.x,
      e.y,
      e.vx,
      e.vy,
      e.kind,
      e.affixes,
      e.hp,
      e.maxHp,
      e.state,
      e.timer,
      e.lockX,
      e.lockY,
      e.side,
      e.animSeed,
      e.hitCd,
    );
  }
  const bullets: number[] = [];
  for (const b of world.bullets.items) {
    bullets.push(
      b.x,
      b.y,
      b.vx,
      b.vy,
      b.kind,
      b.damage,
      b.life,
      b.pierce,
      b.radius,
      b.aoeRadius,
      b.aoeDamage,
      b.towerType,
      b.throttle,
      b.intercept ? 1 : 0,
    );
  }
  const enemyBullets: number[] = [];
  for (const b of world.enemyBullets.items) {
    enemyBullets.push(b.x, b.y, b.vx, b.vy, b.kind, b.damage, b.life, b.radius);
  }
  const drops: number[] = [];
  for (const d of world.drops.items) {
    drops.push(d.x, d.y, d.vx, d.vy, d.value, d.magnet ? 1 : 0, d.kind);
  }

  return {
    v: RUN_SAVE_VERSION,
    seed: meta.seed,
    loadout: meta.loadout,
    unlockMask: world.unlockMask,
    rng: world.rng.state,
    tick: world.tick,
    ship: [ship.x, ship.y, ship.vx, ship.vy, ship.heading, ship.hp],
    weapons,
    edicts,
    wave: [world.wave.segment, world.wave.segTime, world.wave.burstNext, world.wave.eliteNext],
    debt: world.wave.debt.slice(),
    econ: [
      world.scrap,
      world.starCoins,
      world.upgrades,
      world.offerCooldown,
      world.offerRerolled ? 1 : 0,
      world.refitPending ? 1 : 0,
      world.boostTime,
      world.boostCooldown,
    ],
    magnetSurgeTime: world.magnetSurgeTime,
    beacon: [
      world.shopBeaconActive ? 1 : 0,
      world.shopBeaconX,
      world.shopBeaconY,
      world.shopBeaconTtl,
      world.shopBeaconSegment,
    ],
    offer,
    dockEdicts: world.dockEdictOffers.slice(),
    shopWeapons: world.shopWeapons.slice(),
    boss: [world.bossPhase, world.bossSummonN, world.bossSummonCooldown, world.bossKilledAt],
    tally: [world.kills, world.eliteKills, world.peakDps],
    damageByType: Array.from(world.runDamageByType),
    enemies,
    bullets,
    enemyBullets,
    drops,
  };
}

/**
 * 把快照放回一个**全新的 World**。不提供"就地读进旧 World"的路子,理由与 World 不加 reset()
 * 一字同源:池 / rng / 槽位全新才谈得上一条干净的轨迹 —— 而读档恰恰是最需要它的时刻。
 *
 * **不走 applyStartingLoadout**:槽位是存下来的那一份,再套一遍起手配置就是把玩家半局的
 * 武器覆盖回开局那四门炮(读档最惨烈的一种失败,且盘面看着还挺正常)。
 *
 * 顺序有讲究:先 rng(此后不许再有任何掷点)、再标量、再波次(restoreWaveState 内部要重拼
 * 派生量)、最后灌池。插值基准(px/py/pheading)一律对齐成当前值 —— 新 World 的实体是从
 * 池里 spawn 出来的,不对齐的话读档第一帧每颗子弹都会从原点拖一条线过来。
 */
export function restoreRun(snap: RunSnapshot): World {
  const world = new World(snap.seed, snap.unlockMask);
  world.rng.state = snap.rng;
  world.tick = snap.tick;

  const ship = world.ship;
  ship.x = ship.px = snap.ship[0]!;
  ship.y = ship.py = snap.ship[1]!;
  ship.vx = snap.ship[2]!;
  ship.vy = snap.ship[3]!;
  ship.heading = ship.pheading = snap.ship[4]!;
  ship.hp = snap.ship[5]!;

  for (let i = 0; i < WEAPON_SLOT_COUNT; i++) {
    const s = world.weapons[i]!;
    const o = i * WP_STRIDE;
    s.type = snap.weapons[o]!;
    s.stars = snap.weapons[o + 1]!;
    s.cooldown = snap.weapons[o + 2]!;
    s.ammo = snap.weapons[o + 3]!;
    s.reloadLeft = snap.weapons[o + 4]!;
    s.heat = snap.weapons[o + 5]!;
    s.coolLock = snap.weapons[o + 6]!;
    s.charge = snap.weapons[o + 7]!;
    s.turretOffset = snap.weapons[o + 8]!;
  }
  for (let i = 0; i < EDICT_KIND_COUNT; i++) world.edictLevels[i] = snap.edicts[i]!;

  restoreWaveState(world.wave, snap.wave[0]!, snap.wave[1]!, snap.wave[2]!, snap.wave[3]!, snap.debt);

  world.scrap = snap.econ[0]!;
  world.starCoins = snap.econ[1]!;
  world.upgrades = snap.econ[2]!;
  world.offerCooldown = snap.econ[3]!;
  world.offerRerolled = snap.econ[4]! !== 0;
  world.refitPending = snap.econ[5]! !== 0;
  world.boostTime = snap.econ[6]!;
  world.boostCooldown = snap.econ[7]!;
  world.magnetSurgeTime = snap.magnetSurgeTime;
  world.shopBeaconActive = snap.beacon[0]! !== 0;
  world.shopBeaconX = snap.beacon[1]!;
  world.shopBeaconY = snap.beacon[2]!;
  world.shopBeaconTtl = snap.beacon[3]!;
  world.shopBeaconSegment = snap.beacon[4]!;

  world.offer.length = 0;
  for (let o = 0; o + OF_STRIDE <= snap.offer.length; o += OF_STRIDE) {
    world.offer.push({ kind: snap.offer[o]!, type: snap.offer[o + 1]!, level: snap.offer[o + 2]! });
  }
  world.dockEdictOffers.length = 0;
  for (const t of snap.dockEdicts) world.dockEdictOffers.push(t);
  world.shopWeapons.length = 0;
  for (const t of snap.shopWeapons) world.shopWeapons.push(t);

  world.bossPhase = snap.boss[0]!;
  world.bossSummonN = snap.boss[1]!;
  world.bossSummonCooldown = snap.boss[2]!;
  world.bossKilledAt = snap.boss[3]!;

  world.kills = snap.tally[0]!;
  world.eliteKills = snap.tally[1]!;
  world.peakDps = snap.tally[2]!;
  for (let i = 0; i < world.runDamageByType.length; i++) {
    world.runDamageByType[i] = snap.damageByType[i] ?? 0;
  }

  for (let o = 0; o + EN_STRIDE <= snap.enemies.length; o += EN_STRIDE) {
    const e = world.enemies.spawn();
    e.x = e.px = snap.enemies[o]!;
    e.y = e.py = snap.enemies[o + 1]!;
    e.vx = snap.enemies[o + 2]!;
    e.vy = snap.enemies[o + 3]!;
    e.kind = snap.enemies[o + 4]!;
    e.affixes = snap.enemies[o + 5]!;
    e.hp = snap.enemies[o + 6]!;
    e.maxHp = snap.enemies[o + 7]!;
    e.state = snap.enemies[o + 8]!;
    e.timer = snap.enemies[o + 9]!;
    e.lockX = snap.enemies[o + 10]!;
    e.lockY = snap.enemies[o + 11]!;
    e.side = snap.enemies[o + 12]!;
    e.animSeed = snap.enemies[o + 13]!;
    e.hitCd = snap.enemies[o + 14]!;
  }
  for (let o = 0; o + BU_STRIDE <= snap.bullets.length; o += BU_STRIDE) {
    const b = world.bullets.spawn();
    b.x = b.px = snap.bullets[o]!;
    b.y = b.py = snap.bullets[o + 1]!;
    b.vx = snap.bullets[o + 2]!;
    b.vy = snap.bullets[o + 3]!;
    b.kind = snap.bullets[o + 4]!;
    b.damage = snap.bullets[o + 5]!;
    b.life = snap.bullets[o + 6]!;
    b.pierce = snap.bullets[o + 7]!;
    b.radius = snap.bullets[o + 8]!;
    b.aoeRadius = snap.bullets[o + 9]!;
    b.aoeDamage = snap.bullets[o + 10]!;
    b.towerType = snap.bullets[o + 11]!;
    b.throttle = snap.bullets[o + 12]!;
    b.intercept = snap.bullets[o + 13]! !== 0;
  }
  for (let o = 0; o + EB_STRIDE <= snap.enemyBullets.length; o += EB_STRIDE) {
    const b = world.enemyBullets.spawn();
    b.x = b.px = snap.enemyBullets[o]!;
    b.y = b.py = snap.enemyBullets[o + 1]!;
    b.vx = snap.enemyBullets[o + 2]!;
    b.vy = snap.enemyBullets[o + 3]!;
    b.kind = snap.enemyBullets[o + 4]!;
    b.damage = snap.enemyBullets[o + 5]!;
    b.life = snap.enemyBullets[o + 6]!;
    b.radius = snap.enemyBullets[o + 7]!;
  }
  for (let o = 0; o + DR_STRIDE <= snap.drops.length; o += DR_STRIDE) {
    const d = world.drops.spawn();
    d.x = d.px = snap.drops[o]!;
    d.y = d.py = snap.drops[o + 1]!;
    d.vx = snap.drops[o + 2]!;
    d.vy = snap.drops[o + 3]!;
    d.value = snap.drops[o + 4]!;
    d.magnet = snap.drops[o + 5]! !== 0;
    d.kind = snap.drops[o + 6]!;
  }

  return world;
}

/** 存档摘要(标题界面那一行"打到哪了"的读数)。纯函数,不建 World */
export interface RunSaveDigest {
  /** 已存活秒数 */
  elapsedSec: number;
  /** 当前航段下标(0 基);>= segmentCount = 已进 Boss 战 */
  segment: number;
  /** 总段数(数据表现读,加删一段自动跟上) */
  segmentCount: number;
  kills: number;
  hp: number;
  /** 当前 HP 上限:支援槽 + 法令的派生量,与 step 帧首同一条算法现算,不另存一份 */
  maxHp: number;
}

/**
 * 摘一份给人看的读数。maxHp **现算而不是存**:它是支援槽与法令的派生量
 * (与 World.step 帧首那一句同源),存一份的话改了数据表就会在标题界面上显示一个
 * 世界里根本不存在的上限 —— 唯一真相只有一处,这里照着算一遍,而不是抄一遍。
 */
export function digestRunSnapshot(snap: RunSnapshot): RunSaveDigest {
  const buffs = aggregateEdictBuffs(snap.edicts, createEdictBuffs());
  return {
    elapsedSec: snap.tick * SIM_DT,
    segment: snap.wave[0] ?? 0,
    segmentCount: WAVE_SEGMENTS.length,
    kills: snap.tally[0] ?? 0,
    hp: snap.ship[5] ?? 0,
    maxHp: hullMaxHp(buffs),
  };
}

/** 序列化:RunSnapshot → JSON 字符串(与 serializeProgress 同一条最朴素的写法) */
export function serializeRunSnapshot(snap: RunSnapshot): string {
  return JSON.stringify(snap);
}

/**
 * 反序列化 + 校验。**判废从严**(见文件头"版本号进结构"):非法 JSON / 版本对不上 /
 * 定长数组长度不对 / 池数组不是 stride 的整数倍 / 任何一个格子不是有限数 —— 一律返回 null。
 *
 * 从严的理由:半局存档的每一个数都会被直接灌进 sim,一个 NaN 坐标传染出去就是
 * "读档后整场怪原地消失"这种查无可查的现象;而判废的代价只是这一把,不值得为它冒险兼容。
 */
export function parseRunSnapshot(json: string): RunSnapshot | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o['v'] !== RUN_SAVE_VERSION) return null;

  const nums = (key: string, exact: number, stride = 0): number[] | null => {
    const v = o[key];
    if (!Array.isArray(v)) return null;
    if (exact >= 0 && v.length !== exact) return null;
    if (stride > 0 && v.length % stride !== 0) return null;
    for (const n of v) {
      if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    }
    return v as number[];
  };
  const scalar = (key: string): number | null => {
    const v = o[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };

  const seed = scalar('seed');
  const loadout = scalar('loadout');
  const unlockMask = scalar('unlockMask');
  const rng = scalar('rng');
  const tick = scalar('tick');
  const magnetSurgeTime = scalar('magnetSurgeTime');
  if (
    seed === null ||
    loadout === null ||
    unlockMask === null ||
    rng === null ||
    tick === null ||
    magnetSurgeTime === null
  ) {
    return null;
  }
  const ship = nums('ship', 6);
  const weapons = nums('weapons', WEAPON_SLOT_COUNT * WP_STRIDE);
  const edicts = nums('edicts', EDICT_KIND_COUNT);
  const wave = nums('wave', 4);
  const debt = nums('debt', -1);
  const econ = nums('econ', 8);
  const beacon = nums('beacon', 5);
  const offer = nums('offer', -1, OF_STRIDE);
  const dockEdicts = nums('dockEdicts', -1);
  const shopWeapons = nums('shopWeapons', -1);
  const boss = nums('boss', 4);
  const tally = nums('tally', 3);
  const damageByType = nums('damageByType', TOWER_KIND_COUNT);
  const enemies = nums('enemies', -1, EN_STRIDE);
  const bullets = nums('bullets', -1, BU_STRIDE);
  const enemyBullets = nums('enemyBullets', -1, EB_STRIDE);
  const drops = nums('drops', -1, DR_STRIDE);
  if (
    ship === null ||
    weapons === null ||
    edicts === null ||
    beacon === null ||
    wave === null ||
    debt === null ||
    econ === null ||
    offer === null ||
    dockEdicts === null ||
    shopWeapons === null ||
    boss === null ||
    tally === null ||
    damageByType === null ||
    enemies === null ||
    bullets === null ||
    enemyBullets === null ||
    drops === null
  ) {
    return null;
  }
  return {
    v: RUN_SAVE_VERSION,
    // 种子与游标夹成无符号 32 位:Rng 内部就是这么用的(见 core/rng.ts),
    // 手改过的存档塞个小数进来会走出一条谁也复现不了的序列
    seed: seed >>> 0,
    loadout: Math.max(0, Math.floor(loadout)),
    unlockMask: Math.floor(unlockMask),
    rng: rng >>> 0,
    tick: Math.max(0, Math.floor(tick)),
    magnetSurgeTime: Math.max(0, magnetSurgeTime),
    ship,
    weapons,
    edicts,
    wave,
    debt,
    econ,
    beacon,
    offer,
    dockEdicts,
    shopWeapons,
    boss,
    tally,
    damageByType,
    enemies,
    bullets,
    enemyBullets,
    drops,
  };
}

/**
 * 兜底自检:一份**结构合法**的存档能不能真的读进来。parse 只保证"每个格子是有限数",
 * 挡不住"段号 999""槽位型号 -7"这类语义越界 —— 而语义越界要等读档后 sim 跑起来才发作。
 * 于是读档路径在把世界交给流程层之前先跑一遍本函数:抛了就当没有存档
 * (ui/runSaveStorage.ts 的口径),而不是把一个半死的世界推到玩家面前。
 */
export function tryRestoreRun(snap: RunSnapshot): World | null {
  try {
    const world = restoreRun(snap);
    // checksum 会把每一个真状态字段读一遍:NaN / undefined 混进来时这一句是最早的落网点
    if (world.checksum().length === 0) return null;
    return world;
  } catch {
    return null;
  }
}
