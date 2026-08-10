/**
 * 本文件在 Node 环境运行,这本身就是"sim 不依赖 Pixi/DOM"的验证(01 号 issue)。
 *
 * 单只敌人的行为(状态机/前摇/冲刺锁定)在 enemy.test.ts 钉、炮管的追瞄与归位在 turret.test.ts 钉;
 * 这里钉的是**世界这一层的接线**:step 的顺序(含炮管排在敌人循环之后)、出怪混型的随机序列、
 * 接触检测只检测不结算、死亡回收的下标坑与它带出来的残骸掉落(磁吸规则本身在 drop.test.ts 钉),
 * 以及哪些状态进 checksum。
 *
 * 07 验收标准里可自动化的那几条也钉在这里(T5):它们的口径都是"一整个世界连着跑若干秒",
 * 单只敌人的用例复现不出来 —— 方向压力得有一艘真在机动的船,HP 时间缩放得真跑到第 5 分钟。
 * 唯独"1000 只蜂群蛭同屏 60fps"是真机浏览器的事,Node 里量不出帧率,不在这里假装验过。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SIM_DT, SIM_HZ } from '../core/loop';
import {
  AFFIX_ARMORED,
  AFFIX_FISSION,
  AFFIX_FRENZY,
  AFFIX_MAGNETIC,
  AFFIX_PHASED,
  AFFIXES,
  ELITE,
} from '../data/affixes';
import {
  DOCK_EDICT_PRICE,
  DOCK_REPAIR_FRACTION,
  DOCK_REPAIR_PRICE,
  DROP_MAX_ALIVE,
  REROLL_PRICE,
  skipRefundFor,
  UPGRADE_CHOICE_COUNT,
  UPGRADE_OFFER_COOLDOWN,
} from '../data/economy';
import { DECK_PIECE_SQUARE } from '../data/deckPieces';
import {
  EDICT_COOLANT,
  EDICT_CRUISE,
  EDICT_GYRO,
  EDICT_HULL,
  EDICT_MAGNET,
  EDICT_RAPID,
  EDICT_TRACER,
  edictAmmoFireRateMul,
  edictHeatMaxMul,
  edictHullHpAdd,
  edictMask,
} from '../data/edicts';
import {
  ENEMIES,
  KIND_BEETLE,
  KIND_BOSS,
  KIND_SPORE,
  KIND_STRAFER,
  KIND_SWARM,
  KIND_TRAILER,
} from '../data/enemies';
import { SUP_AMMO_BAY, SUP_ARMOR_BAY, SUP_RADIATOR, SUPPORTS } from '../data/supports';
import {
  FX_LIFE_BEAM,
  THR_AMMO,
  THR_CHARGE,
  THR_HEAT,
  TOWER_ARC,
  TOWER_AUTOCANNON,
  TOWER_LASER,
  TOWER_MAX_LEVEL,
  TOWER_MISSILE_NEST,
  TOWER_PD,
  towerArcDeg,
  towerFireInterval,
  towerHeatMax,
  towerMagazine,
  TOWERS,
} from '../data/towers';
import { UNLOCKS } from '../data/unlocks';
import {
  SPAWN_RADIUS,
  SPAWN_RADIUS_BAND,
  WAVE_MAX_ALIVE,
  WAVE_SEGMENTS,
  type WaveSegment,
} from '../data/waves';
import { type Arc, cellArc } from './arc';
import { initBoss } from './boss';
import { tuning } from './config';
import {
  classifyHit,
  deckHalfExtents,
  deckOuterRadius,
  HIT_CORE,
  HIT_GRAZE,
  HIT_NONE,
  hullCoreHalfExtents,
  hullMaxHp,
} from './damage';
import type { Drop } from './drop';
import {
  CELL_SUPPORT,
  CELL_WEAPON,
  cellAt,
  cellWorldPos,
  DECK_COLS,
  DECK_ROWS,
  deckTurnRate,
  EDGE_BOW,
  EDGE_COUNT,
  EDGE_PORT,
  EDGE_STARBOARD,
  EDGE_STERN,
  isPlaceSuccess,
  PLACE_BAD_TOWER,
  PLACE_INTERIOR,
  PLACE_MAX_LEVEL,
  PLACE_OK,
  PLACE_TAKEN,
  PLACE_UPGRADE,
  setOccupied,
  WELD_OK,
} from './deck';
import {
  type Enemy,
  affixMask,
  ENEMY_HIT_FLASH,
  hasAffix,
  hpScaleAt,
  initEnemy,
  ST_APPROACH,
  ST_DASH,
  ST_WINDUP,
} from './enemy';
import { FXV_BEAM, FXV_HULL_HIT, FXV_IMPACT, FXV_KILL, FXV_MUZZLE, FXV_SPARK } from './fx';
import { DEG2RAD, type ShipCommand, type Vec2, wrapAngle } from './ship';
import { cellFireInterval, cellHeatMax } from './tower';
import { waveDirAt } from './waves';
import {
  optionHasLegalPlacement,
  optionLegalCells,
  OFFER_EDICT,
  OFFER_TOWER,
  type UpgradeOption,
  UPGRADE_NO_OFFER,
} from './upgrade';
import {
  ENEMY_FALLBEHIND_RADIUS,
  ENEMY_REJOIN_RADIUS,
  REROLL_ALREADY_DONE,
  REROLL_NO_STARCOINS,
  RESULT_LOSE,
  RESULT_RUNNING,
  RESULT_WIN,
  World,
} from './world';

// 测试用小规模(压测数量是浏览器场景的事,这里只验证逻辑正确性)。
// 与 ship.test.ts 同口径:有用例会拖数量/占比/分离半径,跑完必须还原,否则污染同文件后续用例。
//
// **默认走压测出怪路**(08 号 T2 起 world.step 的正式路径是波次脚本):本文件绝大多数用例钉的是
// "世界这一层的接线"(受击结算 / 回收 / 炮管顺序 / checksum),它们要的是"场上恒定 N 只"这种定数,
// 而不是随脚本时刻变化的怪量 —— 那是波次自己的用例该钉的事(见文件末尾那个 describe 与 waves.test.ts)。
const BASE = {
  stressSpawn: true,
  stressEnemies: 300,
  enemySeparation: 14,
  enemySpeedScale: 1,
  enemyHpScalePerMinute: 0.09,
  enemyMixSwarm: 70,
  enemyMixStrafer: 15,
  enemyMixTrailer: 10,
  enemyMixBeetle: 5,
  // 塔的全局倍率:有用例要临时把伤害归零(见 turretWorld),跑完必须还原
  towerDamageScale: 1,
  towerFireRateScale: 1,
  // 受击模型那一组(09 号):有用例要假装 06 号的装甲舱抬了 HP 上限、或把撞击伤害翻倍,
  // 跑完必须还原。09 落地时一并把 shipContactRadius 从这里删掉了 ——
  // 粗筛半径此后由甲板外接圆算出来(damage.deckOuterRadius),不再是一个手抄的占位数
  shipHullHp: 100,
  shipCoreScale: 0.72,
  enemyHitInterval: 0.6,
  enemyContactDamageScale: 1,
  hitFireRateMul: 0.75,
  hitPenaltyTime: 0.5,
  shipTurnRate: 100,
  // 磁吸那三根(10 号 T1):掉落那一组用例会把起吸半径拖大拖小(验收标准第四条就是这么验的),
  // 跑完必须还原。三条规则本身在 drop.test.ts 钉,这里只关心"世界把它接对了没有"
  dropMagnetRadius: 170,
  dropMagnetSpeed: 300,
  dropCollectRadius: 22,
};
Object.assign(tuning, BASE);

/**
 * 炮管/开火用例读的那一行数值表 —— w.place 的缺省塔型就是自动机炮(GDD §5.2 的万金油)。
 * 04 号那三项全塔共用的 tuning 占位(turretArcDeg/turretRange/turretTurnRate)在 05 号被
 * 一塔一档的数值表取代,故这里显式写死表里的字段并 afterEach 还原:05 一调平衡,
 * 下面那些"转到 25° 就停"的断言不该跟着莫名其妙地红。
 */
const GUN = TOWERS[TOWER_AUTOCANNON]!;
const GUN_BASE = { arcDeg: 100, range: 380, turnRate: 360, aimTolDeg: 6 };
Object.assign(GUN, GUN_BASE);
/** 有用例要临时改甲虫前摇(证明"时长可配"),与 enemy.test.ts 同口径:跑完必须还原 */
const BASE_BEETLE_WINDUP = ENEMIES[KIND_BEETLE]!.chargeWindup;
/** 有用例要把某一型的掉落面额临时改成 0(证明"给不了东西的残骸不掉"),同口径:跑完必须还原 */
const BASE_SCRAP = ENEMIES.map((d) => d.scrap);
afterEach(() => {
  Object.assign(tuning, BASE);
  Object.assign(GUN, GUN_BASE);
  ENEMIES[KIND_BEETLE]!.chargeWindup = BASE_BEETLE_WINDUP;
  for (let i = 0; i < ENEMIES.length; i++) ENEMIES[i]!.scrap = BASE_SCRAP[i]!;
});

/** 只出某一型:验收混型逻辑时才好把断言写死(其余三型权重归零 = 面板上"只看一型"的用法) */
function onlyKind(kind: number): void {
  tuning.enemyMixSwarm = kind === KIND_SWARM ? 100 : 0;
  tuning.enemyMixStrafer = kind === KIND_STRAFER ? 100 : 0;
  tuning.enemyMixTrailer = kind === KIND_TRAILER ? 100 : 0;
  tuning.enemyMixBeetle = kind === KIND_BEETLE ? 100 : 0;
}

describe('World 确定性', () => {
  it('同 seed 同 tick 数 → checksum 相同(01 号 issue 验收)', () => {
    const a = new World(123);
    const b = new World(123);
    for (let i = 0; i < 120; i++) {
      a.step();
      b.step();
    }
    expect(a.enemies.size).toBe(300);
    // 一座塔都没放 → 一颗子弹都没有:01 号那批"凭空重生的压测哑弹"已在 05 号整段删除,
    // 池里的东西此后只可能是塔真的打出来的(见 world.ts 的 stressSyncCounts)
    expect(a.bullets.size).toBe(0);
    expect(a.checksum()).toBe(b.checksum());
  });

  it('不同 seed → checksum 不同', () => {
    const a = new World(1);
    const b = new World(2);
    for (let i = 0; i < 30; i++) {
      a.step();
      b.step();
    }
    expect(a.checksum()).not.toBe(b.checksum());
  });

  it('空间哈希 cell = 最大敌半径 ×2(GDD §13 不变量)', () => {
    expect(new World(1).grid.cellSize).toBe(tuning.enemyRadiusMax * 2);
  });

  it('实体数量跟随 tuning 动态调整(面板改数量即时生效)', () => {
    const w = new World(9);
    w.step();
    expect(w.enemies.size).toBe(300);
    tuning.stressEnemies = 150;
    w.step();
    expect(w.enemies.size).toBe(150);
    tuning.stressEnemies = 300;
    w.step();
    expect(w.enemies.size).toBe(300);
  });

  it('checksum 抓得住敌人的型号与血量(不然出怪错型/伤害算错会从确定性口径下漏掉)', () => {
    tuning.stressEnemies = 20;
    const w = new World(3);
    w.step();
    const e = w.enemies.items[0]!;

    const before = w.checksum();
    e.hp += 1;
    expect(w.checksum()).not.toBe(before);

    const afterHp = w.checksum();
    e.kind = (e.kind + 1) % ENEMIES.length;
    expect(w.checksum()).not.toBe(afterHp);
  });

  it('两个同 seed 世界并排跑:只给其中一边扣一滴血就分叉,补上同一下又合流', () => {
    tuning.stressEnemies = 40;
    const a = new World(88);
    const b = new World(88);
    for (let i = 0; i < 90; i++) {
      a.step();
      b.step();
    }
    expect(a.checksum()).toBe(b.checksum());

    // 走真伤害入口(05 号 issue 的塔就是这么打的),且刻意不打死:位置一点没动,只有 hp 变了。
    // 分叉 = hp 确实进了 checksum,"伤害算错"这类回归才不会从确定性口径下漏掉
    expect(a.damageEnemy(a.enemies.items[0]!, 1)).toBe(false);
    expect(a.checksum()).not.toBe(b.checksum());

    // 另一边补上同样一下就又对上了:上面的差异确实来自那滴血,而不是别处早就在漂移
    expect(b.damageEnemy(b.enemies.items[0]!, 1)).toBe(false);
    expect(a.checksum()).toBe(b.checksum());
  });

  it('elapsed = tick × SIM_DT(HP 时间缩放的唯一时间源,与 checksum 同口径)', () => {
    tuning.stressEnemies = 5;
    const w = new World(1);
    expect(w.elapsed).toBe(0);
    for (let i = 0; i < 90; i++) w.step();
    expect(w.elapsed).toBeCloseTo(1.5, 12);
  });
});

/**
 * 甲板接线(03 号 issue)。规则本身在 deck.test.ts 钉,这里只钉**世界这一层**的两件事:
 * world.place 是全仓唯一的放置入口(与 damageEnemy 同口径:ui/渲染都不许直接改 deck),
 * 以及甲板内容进 checksum —— build 也是世界状态,少了它,"塔放错格"会从确定性口径下漏掉。
 */
describe('甲板接线(world.place 是唯一放置入口)', () => {
  it('world.weld 原子接线:边缘内化后塔即时离线，邻接缓存同一刻撤销', () => {
    tuning.stressEnemies = 0;
    const w = new World(4);
    expect(w.place(0, 1, CELL_WEAPON, TOWER_AUTOCANNON)).toBe(PLACE_OK);
    expect(w.place(1, 1, CELL_SUPPORT, 0, SUP_AMMO_BAY)).toBe(PLACE_OK);
    const tower = cellAt(w.deck, 0, 1)!;
    expect(tower.online).toBe(true);
    expect(tower.fireRateMul).toBeGreaterThan(1);

    expect(w.weld(DECK_PIECE_SQUARE, 0, -2, 1)).toBe(WELD_OK);
    expect(tower.online).toBe(false);
    expect(tower.exposed).toBe(0);
    expect(tower.fireRateMul).toBe(1);
  });

  it('World.step 使用扩建后的实际转向速率:2×2 四格精确少 4°/s', () => {
    tuning.stressEnemies = 0;
    const base = new World(3);
    const expanded = new World(3);
    expect(expanded.weld(DECK_PIECE_SQUARE, 0, -2, 1)).toBe(WELD_OK);
    expect(base.turnRate).toBe(100);
    expect(expanded.turnRate).toBe(96);

    const cmd: ShipCommand = { desiredHeading: { x: 1, y: 0 } };
    base.step(cmd);
    expanded.step(cmd);
    expect(base.ship.heading - expanded.ship.heading).toBeCloseTo((4 * DEG2RAD) / SIM_HZ, 12);
  });

  it('新世界自带一块 T0 的 3×4 空甲板,place 原样转发理由码', () => {
    const w = new World(5);
    expect(w.deck.cells.length).toBe(DECK_COLS * DECK_ROWS);
    expect(w.deck.cells.every((c) => c.occupied)).toBe(true);

    expect(w.place(1, 1, CELL_WEAPON)).toBe(PLACE_INTERIOR); // 内部格放武器塔:拒绝
    expect(cellAt(w.deck, 1, 1)!.content).toBe(0);
    expect(w.place(1, 1, CELL_SUPPORT)).toBe(PLACE_OK); // 同一格放支援设施:允许
    expect(w.place(1, 1, CELL_SUPPORT)).toBe(PLACE_TAKEN); // 已占:战斗中不可移动、不可出售
    expect(cellAt(w.deck, 1, 1)!.content).toBe(CELL_SUPPORT);

    // 非对称格:col 与 row 传反的话 (0,3) 会变成 (3,0),col=3 越界 → PLACE_NO_CELL。
    // 上面几条全用对称坐标,单靠它们抓不住转发时把两个参数写反
    expect(w.place(0, 3, CELL_WEAPON)).toBe(PLACE_OK);
    expect(cellAt(w.deck, 0, 3)!.content).toBe(CELL_WEAPON);
    // 塔型缺省 = 自动机炮(GDD §5.2 的万金油):三参调用方语义原样成立
    expect(cellAt(w.deck, 0, 3)!.towerType).toBe(TOWER_AUTOCANNON);
    expect(cellAt(w.deck, 0, 3)!.level).toBe(1);
  });

  it('塔型与叠级原样转发:同格同种塔 = 升级,换塔型仍是 TAKEN(规则在 sim/deck,这里只验接线)', () => {
    const w = new World(5);
    expect(w.place(1, 0, CELL_WEAPON, TOWER_LASER)).toBe(PLACE_OK);
    const cell = cellAt(w.deck, 1, 0)!;
    expect(cell.towerType).toBe(TOWER_LASER); // 第四个参数真的送到了 deck,而不是被吞掉走了默认值
    expect(cell.level).toBe(1);

    expect(w.place(1, 0, CELL_WEAPON, TOWER_LASER)).toBe(PLACE_UPGRADE);
    expect(cell.level).toBe(2);
    expect(isPlaceSuccess(PLACE_UPGRADE)).toBe(true); // ui 的成功分支认的就是这个函数
    // 换塔型 = 出售 + 重放(GDD §4.5),不许;塔型非法则连格都不必问
    expect(w.place(1, 0, CELL_WEAPON, TOWER_ARC)).toBe(PLACE_TAKEN);
    expect(w.place(2, 0, CELL_WEAPON, 99)).toBe(PLACE_BAD_TOWER);
    expect(cell.level).toBe(2);
    expect(w.deck.cells.filter((c) => c.content === CELL_WEAPON).length).toBe(1); // 升级不占新格
  });

  it('甲板内容进 checksum:并排两个同 seed 世界,只给一边放一座塔就分叉,补上同一座又合流', () => {
    tuning.stressEnemies = 10;
    const a = new World(77);
    const b = new World(77);
    for (let i = 0; i < 30; i++) {
      a.step();
      b.step();
    }
    expect(a.checksum()).toBe(b.checksum());

    // place 不消耗 rng(它不在输入序列里),所以两边的敌人序列一步没错开:分叉只可能来自甲板
    expect(a.place(0, 0, CELL_WEAPON)).toBe(PLACE_OK);
    expect(a.checksum()).not.toBe(b.checksum());
    expect(b.place(0, 0, CELL_WEAPON)).toBe(PLACE_OK);
    expect(a.checksum()).toBe(b.checksum());

    // 被拒的放置一个字段都没动,自然也不该改变哈希
    const before = a.checksum();
    expect(a.place(0, 0, CELL_SUPPORT)).toBe(PLACE_TAKEN);
    expect(a.checksum()).toBe(before);
  });

  it('塔型与等级进 checksum:只给一边升一级就分叉,另一边补上同一级又合流', () => {
    tuning.stressEnemies = 10;
    const a = new World(78);
    const b = new World(78);
    for (const w of [a, b]) expect(w.place(0, 0, CELL_WEAPON, TOWER_LASER)).toBe(PLACE_OK);
    expect(a.checksum()).toBe(b.checksum());

    // 升级只改 level 一个字段(格没换、内容没换):分叉 = 等级确实进了哈希,
    // 否则"叠级没生效"或"升到了别的格上"这类回归会从确定性口径下漏掉
    expect(a.place(0, 0, CELL_WEAPON, TOWER_LASER)).toBe(PLACE_UPGRADE);
    expect(a.checksum()).not.toBe(b.checksum());
    expect(b.place(0, 0, CELL_WEAPON, TOWER_LASER)).toBe(PLACE_UPGRADE);
    expect(a.checksum()).toBe(b.checksum());

    // 塔型同理:同一格、同样是 Lv1 的塔,换个型号就该是另一个世界
    const c = new World(78);
    expect(c.place(0, 0, CELL_WEAPON, TOWER_ARC)).toBe(PLACE_OK);
    const d = new World(78);
    expect(d.place(0, 0, CELL_WEAPON, TOWER_LASER)).toBe(PLACE_OK);
    expect(c.checksum()).not.toBe(d.checksum());

    // 满级后的拒绝一个字段都没动,哈希自然也不许变
    for (let lv = cellAt(a.deck, 0, 0)!.level; lv < TOWER_MAX_LEVEL; lv++) {
      expect(a.place(0, 0, CELL_WEAPON, TOWER_LASER)).toBe(PLACE_UPGRADE);
    }
    const capped = a.checksum();
    expect(a.place(0, 0, CELL_WEAPON, TOWER_LASER)).toBe(PLACE_MAX_LEVEL);
    expect(a.checksum()).toBe(capped);
  });
});

/** 装甲舱的数值只从表里取:GDD §5.3 那 15 点哪天改了,下面这几条断言跟着改,而不是各写死一个 15 */
const ARMOR = SUPPORTS[SUP_ARMOR_BAY]!;

/**
 * 支援设施接线(06 号 issue T4)。邻接配对与倍率连乘在 support.test.ts 钉、
 * HP 上限与舷向减伤的算式在 damage.test.ts 钉,这里只钉**世界这一层**的三件事:
 *   place 的第 5 参真的送到了 sim/deck(而不是被吞掉走了缺省的弹药库);
 *   加成与上限**放置即时生效、拆除即时移除**(验收标准第三条)—— 前一半靠 place 里那两句,
 *     后一半靠 step 帧首那两句,因为 12 号的 setOccupied 根本不认识 World;
 *   哪些进 checksum:设施型号进(一次放置定死的世界状态),四个 buff 缓存与 buffRevision 不进
 *     (甲板的纯派生量,而甲板逐格哈过了)。
 * 邻接加成对射速/装填的实测(验收标准第一条)在 tower.test.ts 那条链路上钉 ——
 * 那是取值函数的事,世界这一层只负责每帧把缓存刷新到位。
 */
describe('支援设施接线(06 号 T4:放置即时生效、拆除即时移除)', () => {
  it('装甲舱放下去**当帧**就抬上限,hp 一分不还;两块加两份,别的设施一分不加', () => {
    tuning.stressEnemies = 0; // 这组用例只关心甲板,场上不必有人
    const w = new World(11);
    const base = w.ship.maxHp;
    w.ship.hp = 40;

    // 第 5 参真的送到了 deck:走缺省的话放下去的是弹药库,上限纹丝不动
    expect(w.place(1, 1, CELL_SUPPORT, TOWER_AUTOCANNON, SUP_ARMOR_BAY)).toBe(PLACE_OK);
    expect(cellAt(w.deck, 1, 1)!.supportType).toBe(SUP_ARMOR_BAY);
    // **不等下一帧**:place 返回的这一刻上限就是新的(hullMaxHp 当场遍历 cells,不读任何缓存)
    expect(w.ship.maxHp).toBe(base + ARMOR.hullHp);
    expect(w.ship.hp).toBe(40); // 上限是船的规格,这一局打下来的账一分不还 —— 装甲舱不是治疗

    // 加法叠加(GDD §5.3 的 HP 是点数不是比例):第二块照样 +15
    expect(w.place(0, 0, CELL_SUPPORT, TOWER_AUTOCANNON, SUP_ARMOR_BAY)).toBe(PLACE_OK);
    expect(w.ship.maxHp).toBe(base + 2 * ARMOR.hullHp);

    // 别的设施一分不加:上限只认表里的 hullHp,不认"这格有东西"
    expect(w.place(2, 0, CELL_SUPPORT, TOWER_AUTOCANNON, SUP_AMMO_BAY)).toBe(PLACE_OK);
    expect(w.ship.maxHp).toBe(base + 2 * ARMOR.hullHp);

    // 跑一帧不会把它抹回去:帧首那次重刷读的是同一块甲板,答案自然一样
    w.step();
    expect(w.ship.maxHp).toBe(base + 2 * ARMOR.hullHp);
    expect(w.ship.hp).toBe(40);
  });

  it('setOccupied 拆掉装甲舱:下一帧上限回落、hp 被夹进新上限;反过来涨上限时 hp 一分不涨', () => {
    tuning.stressEnemies = 0;
    const w = new World(12);
    const base = w.ship.maxHp;
    expect(w.place(0, 0, CELL_SUPPORT, TOWER_AUTOCANNON, SUP_ARMOR_BAY)).toBe(PLACE_OK);
    expect(w.ship.maxHp).toBe(base + ARMOR.hullHp);
    w.ship.hp = w.ship.maxHp; // 满血:上限回落时才看得出那一下夹取

    // 12 号焊/拆甲板的唯一入口。它只清 supportType(recomputeDeck 的非占用分支),
    // **World 一个字都不知道这次拆除发生过** —— 上限回落全靠 step 帧首那次无条件重刷,
    // 这就是"拆除即时移除"(验收标准第三条)在 MVP 里唯一能被真的走一遍的路径
    setOccupied(w.deck, 0, 0, false);
    expect(cellAt(w.deck, 0, 0)!.supportType).toBe(-1);
    expect(w.ship.maxHp).toBe(base + ARMOR.hullHp); // 还没跑帧:上一次重刷留下的旧上限

    w.step();
    expect(w.ship.maxHp).toBe(base);
    expect(w.ship.hp).toBe(base); // 夹进新上限,否则血条会画出一艘 hp > maxHp 的船

    // 只夹不涨:上限重新长回去时,hp 停在原处
    w.ship.hp = 50;
    expect(w.place(0, 1, CELL_SUPPORT, TOWER_AUTOCANNON, SUP_ARMOR_BAY)).toBe(PLACE_OK);
    w.step();
    expect(w.ship.maxHp).toBe(base + ARMOR.hullHp);
    expect(w.ship.hp).toBe(50);
  });

  it('设施型号进 checksum:同一格同样是设施,一边弹药库一边散热器就分叉,换成同一种又合流', () => {
    tuning.stressEnemies = 10;
    const a = new World(79);
    const b = new World(79);
    for (let f = 0; f < 20; f++) {
      a.step();
      b.step();
    }
    expect(a.checksum()).toBe(b.checksum());

    // 两边的 occupied/content 一模一样,唯一的差别就是 supportType:漏了它,
    // "该放弹药库却放成了散热器"这类回归会从确定性口径下漏掉 —— 而这两种对同一门机炮
    // 一个提速一个零效果,下一帧谁开火就此不同
    expect(a.place(1, 1, CELL_SUPPORT, TOWER_AUTOCANNON, SUP_AMMO_BAY)).toBe(PLACE_OK);
    expect(b.place(1, 1, CELL_SUPPORT, TOWER_AUTOCANNON, SUP_RADIATOR)).toBe(PLACE_OK);
    expect(cellAt(a.deck, 1, 1)!.content).toBe(cellAt(b.deck, 1, 1)!.content);
    expect(a.checksum()).not.toBe(b.checksum());

    // 第三个同 seed 世界补上与 b 一模一样的那一块 → 合流。
    // 有这一条,上面那次分叉才排得掉"放置本身让哈希变了"这种空过
    const c = new World(79);
    for (let f = 0; f < 20; f++) c.step();
    expect(c.place(1, 1, CELL_SUPPORT, TOWER_AUTOCANNON, SUP_RADIATOR)).toBe(PLACE_OK);
    expect(c.checksum()).toBe(b.checksum());
  });

  it('四个 buff 缓存与 buffRevision 不进 checksum(甲板的纯派生量,而甲板本身逐格哈过了)', () => {
    tuning.stressEnemies = 0;
    const w = new World(80);
    w.step();
    const before = w.checksum();

    // 手改一格的四个倍率 + 记账用的 buffRevision:哈希纹丝不动。
    // 它们是 occupied/content/supportType/towerType/online 的纯函数(recomputeSupportBuffs 每次
    // 全甲板重算,没有第二条来路),哈它们只是把同一件事哈两遍 —— 与 exposed/online 跳过同一条理由
    const cell = cellAt(w.deck, 0, 0)!;
    cell.fireRateMul = 1.25;
    cell.reloadMul = 0.7;
    cell.heatMaxMul = 1.5;
    cell.chargeRateMul = 1.3;
    w.deck.buffRevision = 999;
    expect(w.checksum()).toBe(before);

    // 对照:同一格上真正的世界状态(设施型号)一动就分叉 —— 上面那条不是"甲板压根没进哈希"的空过
    cell.supportType = SUP_AMMO_BAY;
    expect(w.checksum()).not.toBe(before);
  });
});

/**
 * 炮管接线(04 号 issue T2)。射界几何在 arc.test.ts 钉、炮管的时间维度行为在 turret.test.ts 钉,
 * 这里只钉**世界这一层**的三件事:
 *   step() 里真的每帧推进了炮管(接线不通的话上面两个文件全绿、游戏里炮管一动不动);
 *   炮管排在敌人循环**之后** —— 塔瞄的是敌人本帧的位置,而不是上一帧的;
 *   turretOffset 进 checksum —— 它是逐帧演化出来的状态,不是 occupied 的派生量。
 * "射界内最近优先 / 圈外界外一律不理 / 没得打就归位"这三条口径也在真世界里各走一遍:
 * 单测过了而接线接错(比如塔拿船心当炮位、或者哈希查询半径不够)时,只有这一层拦得住。
 */
describe('炮管接线(04 号:塔只打射界内的目标,没得打就归位)', () => {
  it('step() 每帧推进炮管:射界内有目标就追瞄,目标被挤出射界就归位到扇形中心', () => {
    const w = turretWorld(61, 2);
    const cell = cellAt(w.deck, BOW_COL, BOW_ROW)!;
    const [target, behind] = w.enemies.items as [Enemy, Enemy];
    parkAt(w, target, 25, 200);
    parkAt(w, behind, 170, 150); // 船尾方向:射界外,归位那一段不会被它半路勾回去

    expect(cell.turretOffset).toBe(0); // 起手归位
    for (let f = 0; f < 30; f++) w.step();
    expect(aimDeg(w)).toBeCloseTo(25, 6); // 每帧 6°,30 帧足够转到位并停住

    // 目标挪到 80°(仍在射程内,只是出了半角 50° 的扇形)→ 判据是"射界内无目标",不是"世上无敌人"
    parkAt(w, target, 80, 200);
    let prev = cell.turretOffset;
    for (let f = 0; f < Math.ceil(25 / MAX_TURN_DEG); f++) {
      w.step();
      const now = cell.turretOffset;
      expect(now).toBeLessThan(prev); // 单调收回,肉眼能看见炮管在转(而不是某一帧啪地弹回)
      expect(now).toBeGreaterThanOrEqual(-1e-9); // 不过冲:绝不越过 0 荡到另一侧
      prev = now;
    }
    expect(cell.turretOffset).toBe(0); // 末帧差值不足一格上限 → 当帧精确落到中心
    for (let f = 0; f < 20; f++) w.step();
    expect(cell.turretOffset).toBe(0); // 停住,不在 0 附近抖
  });

  it('射界内两只都够得着 → 瞄最近的;近的那只跑出射程,火力立刻交给远的', () => {
    const w = turretWorld(62, 2);
    const [near, far] = w.enemies.items as [Enemy, Enemy];
    parkAt(w, near, 20, 120);
    parkAt(w, far, -35, 300); // 也在射界内,只是远得多

    for (let f = 0; f < 30; f++) w.step();
    expect(aimDeg(w)).toBeCloseTo(20, 6);

    parkAt(w, near, 20, 500); // 方位不变,只是退到射程外
    for (let f = 0; f < 30; f++) w.step();
    expect(aimDeg(w)).toBeCloseTo(-35, 6);
  });

  it('只打射界扇形 ∩ 射程圆内的目标:圈外一步、界外一度都当没看见', () => {
    const w = turretWorld(63, 1);
    const cell = cellAt(w.deck, BOW_COL, BOW_ROW)!;
    const e = w.enemies.items[0]!;
    const half = GUN.arcDeg / 2; // 船头正中格只有 BOW 一条暴露边,不加宽

    parkAt(w, e, 25, GUN.range + 5); // 方位在射界正中,但差五步进不了射程
    for (let f = 0; f < 20; f++) w.step();
    expect(cell.turretOffset).toBe(0); // 逐位为 0:压根没被推过,而不是"转出去又转回来"

    parkAt(w, e, 25, GUN.range - 5); // 同一个方位,踏进射程圆
    for (let f = 0; f < 20; f++) w.step();
    expect(aimDeg(w)).toBeCloseTo(25, 6);

    parkAt(w, e, half + 1, 150); // 近在 150,但方位比半角多 1°
    for (let f = 0; f < 20; f++) w.step();
    expect(cell.turretOffset).toBe(0);

    parkAt(w, e, half - 1, 150); // 界内 1°:该追。边界"含在内"的逐位口径在 arc.test.ts 钉
    for (let f = 0; f < 20; f++) w.step();
    expect(aimDeg(w)).toBeCloseTo(half - 1, 6);
  });

  it('炮管排在敌人循环之后:塔瞄的是敌人**本帧**的位置,不是上一帧的', () => {
    const w = turretWorld(64, 1);
    const cell = cellAt(w.deck, BOW_COL, BOW_ROW)!;
    const e = w.enemies.items[0]!;
    const bearing = 25;

    // 对照组:同样停在射程外 4px,不给速度就永远进不来 —— 下面那一帧的位移才是唯一的分水岭
    parkAt(w, e, bearing, GUN.range + 4);
    w.step();
    expect(cell.turretOffset).toBe(0);

    // 给它一发朝炮口的径向速度:本帧位移 9px(> 4)且方位角一点不变(径向 = 只缩距离)。
    // 帧首在圈外、帧尾在圈内 —— 若 stepTurrets 排在敌人循环之前,它读到的还是帧首那个
    // "射程外"的位置,炮管会纹丝不动
    parkAt(w, e, bearing, GUN.range + 4);
    const a = bearing * DEG2RAD;
    e.vx = -Math.cos(a) * 600;
    e.vy = -Math.sin(a) * 600;
    w.step();

    expect(distToGun(w, e.px, e.py)).toBeGreaterThan(GUN.range); // 帧首:还在圈外
    expect(distToGun(w, e.x, e.y)).toBeLessThan(GUN.range); // 帧尾:已经进圈
    expect(cell.turretOffset / DEG2RAD).toBeCloseTo(MAX_TURN_DEG, 9); // 当帧就转满了一格上限
  });

  it('放塔后同 seed 两个世界仍逐位一致,且与未放塔的世界不同', () => {
    tuning.stressEnemies = 100;
    const a = armedWorld(88);
    const b = armedWorld(88);
    const c = new World(88); // 对照:同 seed,但一座塔都不放
    for (let f = 0; f < 90; f++) {
      a.step();
      b.step();
      c.step();
    }

    // 非空过:这 90 帧里炮管确实转过。全 0 的话下面两条断言退化成"甲板 content 一致"
    expect(a.deck.cells.some((cell) => cell.turretOffset !== 0)).toBe(true);
    expect(a.checksum()).toBe(b.checksum());
    // 未放塔的世界连 content 都不同,故这一条只兜住"放塔确实改变了世界状态";
    // turretOffset **单独**进哈希由下一条钉死
    expect(a.checksum()).not.toBe(c.checksum());
  });

  it('turretOffset 单独进 checksum:把转过的偏角抹平就分叉,照另一边补回来又合流', () => {
    tuning.stressEnemies = 100;
    const a = armedWorld(89);
    const b = armedWorld(89);
    for (let f = 0; f < 90; f++) {
      a.step();
      b.step();
    }
    expect(a.checksum()).toBe(b.checksum());

    // 只动 turretOffset 一个字段(= 同一块甲板,但"炮管一次都没转过"):
    // 分叉 = 它真的进了哈希,"塔瞄错方向"这类回归才不会从确定性口径下漏掉
    const saved = a.deck.cells.map((cell) => cell.turretOffset);
    expect(saved.some((v) => v !== 0)).toBe(true);
    for (const cell of a.deck.cells) cell.turretOffset = 0;
    expect(a.checksum()).not.toBe(b.checksum());

    // 补回同一组偏角就又对上了:上面的差异确实来自炮管,而不是别处早就在漂移
    a.deck.cells.forEach((cell, i) => {
      cell.turretOffset = saved[i]!;
    });
    expect(a.checksum()).toBe(b.checksum());
  });
});

/**
 * 开火接线(05 号 issue T3)。五种开火表现的判定规则在 turret.test.ts 钉、子弹的积分与命中在
 * bullet.test.ts 钉、三套节流在 tower.test.ts 钉,这里只钉**世界这一层**的四件事:
 *   step() 里塔真的开火了(FireSink 接通:子弹进池、伤害进 damageEnemy、死亡照旧走 reap);
 *   可视化事件每帧老化、走完回池,且**纯表现不进 checksum**;
 *   broadside 读数逐帧重建(渲染层的镜头顿挫认它);
 *   塔的运行期节流状态与子弹位置进 checksum —— 它们是逐帧演化的状态,不是派生量。
 */
describe('开火接线(05 号:塔真的打出东西来)', () => {
  it('step() 里塔真的开火:子弹当帧进池、飞到靶子身上扣血、打死了照旧算 kills', () => {
    const w = firingWorld(71, 1);
    const e = w.enemies.items[0]!;
    parkAt(w, e, 0, 150); // 射界正中、射程内:炮口起手就对着它,当帧即可开火
    const hp = e.hp;

    w.step();
    expect(w.bullets.size).toBe(1);
    const b = w.bullets.items[0]!;
    expect(b.towerType).toBe(TOWER_AUTOCANNON);
    expect(b.damage).toBe(GUN.damage); // 倍率 1 时就是 GDD §14 锚点的 6 伤
    // 子弹排在炮管之后:本帧新出膛的弹当帧就走一步,px/py 停在炮口(铁律 2 的插值两端)
    expect(Math.hypot(b.x - b.px, b.y - b.py)).toBeGreaterThan(0);
    expect(distToGun(w, b.px, b.py)).toBeCloseTo(0, 9);

    // 150px / 420px每秒 ≈ 22 帧后命中(靶子钉着不动)—— 只要在飞就一定会撞上
    for (let f = 0; f < 30 && e.hp === hp; f++) w.step();
    expect(e.hp).toBeLessThan(hp);
    expect(e.hp).toBe(hp - GUN.damage); // 伤害经的是 World.damageEnemy 这唯一入口

    // 一路打死:死亡回收与掉落挂钩走的还是既有那条路径(05 没有另开一条)
    let dropped = 0;
    w.onEnemyDeath = () => dropped++;
    for (let f = 0; f < 600 && w.kills === 0; f++) w.step();
    expect(w.kills).toBe(1);
    expect(dropped).toBe(1);
  });

  it('开火的可视化事件:当帧入池、逐帧老化、存续走完回池;纯表现,不进 checksum', () => {
    // 激光是瞬时判定塔:它的表现全靠 FxEvent(直射弹的表现由子弹自己交代,不推事件)
    const w = firingWorld(72, 1, TOWER_LASER);
    const e = w.enemies.items[0]!;
    parkAt(w, e, 0, 150);

    w.step();
    expect(w.fx.size).toBe(2);
    expect(w.fx.items.map((e) => e.kind)).toEqual([FXV_BEAM, FXV_MUZZLE]);
    const beam = w.fx.items.find((e) => e.kind === FXV_BEAM)!;
    expect(beam.kind).toBe(FXV_BEAM);
    expect(beam.towerType).toBe(TOWER_LASER);
    expect(beam.x0).toBeCloseTo(gunPos(w).x, 9); // 起点 = 炮位(世界坐标,不是甲板局部坐标)
    expect(beam.x1).toBeCloseTo(e.x, 9); // 终点 = 命中点
    // 老化排在开火之后:出膛那一帧就扣掉一个 dt,life 从数值表的 FX_LIFE_BEAM 起算
    expect(beam.life).toBeCloseTo(FX_LIFE_BEAM - SIM_DT, 12);

    // 纯表现:凭空多一个事件,checksum 一位都不许动 ——
    // 否则"渲染改一下淡出时长"看起来就像一次确定性回归
    const before = w.checksum();
    w.fx.spawn();
    expect(w.checksum()).toBe(before);

    // 靶子退到射程外 → 不再有新事件,池必须自己空掉(不老化的话屏幕上会积一层永不消失的光)
    parkAt(w, e, 0, 2000);
    let frames = 0;
    while (w.fx.size > 0 && frames < 60) {
      w.step();
      frames++;
    }
    expect(w.fx.size).toBe(0);
    expect(frames).toBeLessThanOrEqual(Math.ceil(FX_LIFE_BEAM / SIM_DT) + 1);
  });

  it('受击闪白:命中置满、逐帧减 dt 夹 0(与 hitCd 同口径,渲染层只读剩余量)', () => {
    const w = new World(123);
    w.step();
    const e = w.enemies.items[0]!;
    park(e, 0, 0);
    w.damageEnemy(e, 1);
    expect(e.hitFlash).toBe(ENEMY_HIT_FLASH);

    w.step();
    expect(e.hitFlash).toBeCloseTo(ENEMY_HIT_FLASH - SIM_DT, 12); // 衰减一帧,不为负
    for (let f = 0; f < 60 && e.hitFlash > 0; f++) w.step();
    expect(e.hitFlash).toBe(0); // 夹 0:不会跑成负数在哈希里无限发散
  });

  it('hitFlash 不进 checksum:同样的世界只差一个闪白剩余量,checksum 一字不差', () => {
    // 判定口径(见 world.checksum 的注释):hitFlash 是纯表现 —— 不参与任何判定,
    // 且完全由伤害输入决定 = 派生量。这里手工抹掉一只的闪白再比哈希:
    // 若它进了哈希,两个"表现不同、世界相同"的局会当场分叉
    const a = new World(77);
    a.step();
    const b = new World(77);
    b.step();
    const ea = a.enemies.items[0]!;
    const eb = b.enemies.items[0]!;
    park(ea, 100, 0);
    park(eb, 100, 0);
    a.damageEnemy(ea, 5);
    b.damageEnemy(eb, 5);
    eb.hitFlash = 0; // 唯一差异:闪白被手工抹掉(表现层差异,世界不该跟着分叉)
    expect(a.checksum()).toBe(b.checksum());
  });

  it('击杀爆点事件携带致死那一发的实际伤害与相对满血比例(飘字用)', () => {
    const w = new World(88);
    w.step();
    const e = w.enemies.items[0]!;
    park(e, 100, 0);
    const full = e.maxHp;
    w.damageEnemy(e, full); // 一发送走:lastHit 由 damageEnemy 落账
    // 钉死敌速:reap 那一帧读的是敌人"当场"的位置,怪还会动 —— 不动才比得准(afterEach 还原)
    tuning.enemySpeedScale = 0;
    w.step(); // 帧尾 reap 落账:击杀爆点入池
    const killFx = w.fx.items.find((fx) => fx.kind === FXV_KILL);
    expect(killFx).toBeDefined();
    expect(killFx!.damage).toBe(full); // 致死伤害 = 满血一发送走
    expect(killFx!.dmgRatio).toBeCloseTo(1, 9); // damage / maxHp = 1
    expect(killFx!.x0).toBeCloseTo(100, 9); // 爆点坐标 = 死亡地点(敌人钉在 (100, 0))
    expect(killFx!.y0).toBeCloseTo(0, 9);
  });

  it('broadside:同舷三座塔同帧开火 → 记下那一舷与塔数;没人开火的帧读回 -1/0', () => {
    // 容差临时放到 90°:三座塔的射界中心差着 45°,不放宽就得等各自转到位,凑不出"同帧"。
    // 容差本身的行为在 turret.test.ts 钉,这里要的是"同一帧里有三座塔开了火"
    GUN.aimTolDeg = 90;
    const w = firingWorld(73, 1);
    // 船头一整行三格:(0,0) 与 (2,0) 是角落格,它们**同时**算进 BOW 与各自的侧舷 ——
    // 归属规则是"每一条暴露边各投一票"(与 damage.cellFireRateMul 同一条,见 world.sink.fired)。
    // 于是船头拿满 3 票、左右舷各 1 票,最高的那一舷仍是 BOW
    expect(w.place(0, 0, CELL_WEAPON)).toBe(PLACE_OK);
    expect(w.place(2, 0, CELL_WEAPON)).toBe(PLACE_OK);
    parkAt(w, w.enemies.items[0]!, 0, 150);

    expect(w.broadsideEdge).toBe(-1); // 一帧都没跑过:读数是"本帧没人开火"
    expect(w.broadsideCount).toBe(0);

    w.step();
    expect(w.bullets.size).toBe(3);
    expect(w.broadsideCount).toBe(3); // ≥3 = 单舷齐射,渲染层据此给一次镜头顿挫
    expect(w.broadsideEdge).toBe(EDGE_BOW);

    // 逐帧重建:下一帧三座塔都在冷却里,读数当场回到 -1/0 ——
    // 不清的话镜头会被上一帧的齐射一直顶着
    w.step();
    expect(w.bullets.size).toBe(3); // 没有新弹出膛(0.4s 的射击间隔还没走完)
    expect(w.broadsideEdge).toBe(-1);
    expect(w.broadsideCount).toBe(0);
  });

  it('broadside 在 PORT/STERN 也凑得满 3:角落格同时算进两舷(09 号 T3 换掉了"每格挑一条边")', () => {
    // 容差临时放到 90°,理由与上一条相同:射界中心互差 45°~90°,不放宽就凑不出"同帧"
    GUN.aimTolDeg = 90;

    /** 在给定几格上各放一座机炮,把唯一的靶子摆到船的 (dx, dy) 方向上,跑一帧 */
    const volley = (
      seed: number,
      cells: ReadonlyArray<readonly [number, number]>,
      dx: number,
      dy: number,
    ): World => {
      const w = firingWorld(seed, 1);
      for (const [col, row] of cells) expect(w.place(col, row, CELL_WEAPON)).toBe(PLACE_OK);
      park(w.enemies.items[0]!, w.ship.x + dx, w.ship.y + dy);
      w.step();
      // 三座塔真的同帧开了火,下面比的才是"这三票记给了谁",而不是"有几座塔转到位了"
      expect(w.bullets.size).toBe(3);
      return w;
    };

    // 左舷一整列三格:(0,0) 是 BOW|PORT 的角落格,另外两格只有 PORT。
    // 换成"每格只挑一条边"(05 号临时的 lowestEdge),(0,0) 会被算给 BOW,左舷当场只剩 2 票 ——
    // 而 3×4 甲板上 PORT 一共 4 格、其中两格是角落,那一舷就永远够不着"≥3 塔齐射"这条门槛
    const PORT_COLUMN: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [0, 1],
      [0, 2],
    ];
    const port = volley(75, PORT_COLUMN, 0, -200);
    expect(port.broadsideEdge).toBe(EDGE_PORT);
    expect(port.broadsideCount).toBe(3);

    // 船尾一整行三格:两头都是角落格((0,3) = PORT|STERN,(2,3) = STARBOARD|STERN),
    // 挑一条边的话它们分别被算给 STERN 与 STARBOARD,船尾只剩 2 票 —— 同一个病的另一半
    const STERN_ROW: ReadonlyArray<readonly [number, number]> = [
      [0, 3],
      [1, 3],
      [2, 3],
    ];
    const stern = volley(76, STERN_ROW, -250, 0);
    expect(stern.broadsideEdge).toBe(EDGE_STERN);
    expect(stern.broadsideCount).toBe(3);
  });

  it('塔的节流状态与子弹位置进 checksum:抹掉就分叉,补回来又合流', () => {
    /** 同一个靶场跑两份:同 seed + 同放置 ⇒ 两边必须逐位一致 */
    const armed = (seed: number): World => {
      const w = firingWorld(seed, 1);
      parkAt(w, w.enemies.items[0]!, 0, 150);
      return w;
    };
    const a = armed(91);
    const b = armed(91);
    // 90 帧里这座塔打了好几发、靶子被打死又补出新的:开火整条路径(节流→弹道→伤害→回收)
    // 全程都在 checksum 的覆盖下
    for (let f = 0; f < 90; f++) {
      a.step();
      b.step();
    }
    expect(a.checksum()).toBe(b.checksum());
    expect(a.kills).toBeGreaterThan(0); // 非空过:这 90 帧里真的打死过人

    // 再给两边摆一次同样的靶(不消耗 rng,序列一步都不会错开),让池里确实有一颗**在飞**的弹:
    // 300 远 → 43 帧才飞到,下面这 40 帧里它一定还在半路上
    for (const w of [a, b]) parkAt(w, w.enemies.items[0]!, 0, 300);
    for (let f = 0; f < 40; f++) {
      a.step();
      b.step();
    }
    expect(a.checksum()).toBe(b.checksum());
    expect(a.bullets.size).toBeGreaterThan(0);

    const cell = cellAt(a.deck, BOW_COL, BOW_ROW)!;
    expect(cell.ammo).toBeLessThan(towerMagazine(GUN, 1)); // 非空过:这 90 帧真打出去了几发

    // 弹夹:节流状态是逐帧演化出来的状态,不是派生量 —— 漏了它,"某座塔的装填提前了一帧"
    // 这类分叉就从确定性口径下漏掉了,而节流恰恰决定了下一帧谁开火
    const ammo = cell.ammo;
    cell.ammo = ammo + 1;
    expect(a.checksum()).not.toBe(b.checksum());
    cell.ammo = ammo;
    expect(a.checksum()).toBe(b.checksum());

    // 冷却:× 100 之后才抓得住一两帧的差别(Math.round(v*8) 对 0..1 的秒数太粗)
    const cooldown = cell.cooldown;
    cell.cooldown = cooldown + 0.05;
    expect(a.checksum()).not.toBe(b.checksum());
    cell.cooldown = cooldown;
    expect(a.checksum()).toBe(b.checksum());

    // 子弹只哈位置(伤害/存活是发射那一刻定死的常量),而位置已经能抓住任何弹道分叉
    const bullet = a.bullets.items[0]!;
    const bx = bullet.x;
    bullet.x = bx + 1;
    expect(a.checksum()).not.toBe(b.checksum());
    bullet.x = bx;
    expect(a.checksum()).toBe(b.checksum());
  });
});

/**
 * 压测出怪路(tuning.stressSpawn = true)的混型与出生环。08 号 T2 之后它是一条 **debug 路径** ——
 * 正式出怪器走波次脚本(见文件末尾那个 describe),而 tuning.stressEnemies 与四条 enemyMix*
 * 也只在这条路上生效。留着它是因为"1000 敌同屏 60fps"那条压测场景要的是恒定数量,脚本给不了。
 */
describe('压测出怪混型(debug 路径:仅 stressSpawn = true 时生效)', () => {
  it('按 tuning.enemyMix* 轮盘赌:默认占比下四型都出得来', () => {
    const w = new World(31);
    w.step();
    const seen = new Set<number>();
    for (const e of w.enemies.items) seen.add(e.kind);
    expect(seen).toEqual(new Set([KIND_SWARM, KIND_STRAFER, KIND_TRAILER, KIND_BEETLE]));
  });

  it('其余三型权重归零 → 全场同型(面板上"只看一型"的肉眼验收用法)', () => {
    for (const kind of [KIND_SWARM, KIND_STRAFER, KIND_TRAILER, KIND_BEETLE]) {
      onlyKind(kind);
      tuning.stressEnemies = 40;
      const w = new World(12);
      w.step();
      for (const e of w.enemies.items) expect(e.kind).toBe(kind);
    }
  });

  it('四个权重全为 0 → 回落蜂群蛭(总不能出个空气)', () => {
    tuning.enemyMixSwarm = 0;
    tuning.enemyMixStrafer = 0;
    tuning.enemyMixTrailer = 0;
    tuning.enemyMixBeetle = 0;
    tuning.stressEnemies = 10;
    const w = new World(4);
    w.step();
    expect(w.enemies.size).toBe(10);
    for (const e of w.enemies.items) expect(e.kind).toBe(KIND_SWARM);
  });

  it('rng 消耗顺序与 kind 无关:改占比只换型号,不移动整条随机序列', () => {
    // px/py 是出生点(敌人循环开头存的上一帧位置),比 x/y 干净:后者已被各型不同的速度带偏
    const spawnPoints = (setup: () => void): number[] => {
      setup();
      tuning.stressEnemies = 30;
      const w = new World(55);
      w.step();
      const out: number[] = [];
      for (const e of w.enemies.items) out.push(e.px, e.py);
      return out;
    };
    // 全出蜂群蛭与全出甲虫,出生点必须逐个相同 —— 每只固定消耗 kind→angle→radius→side 四次
    const base = spawnPoints(() => onlyKind(KIND_SWARM));
    expect(spawnPoints(() => onlyKind(KIND_BEETLE))).toEqual(base);
    // 权重全 0 的回落分支同样得消耗掉 kind 那一次:少取一次,后面所有敌人的出生点就整体错位
    expect(
      spawnPoints(() => {
        onlyKind(KIND_SWARM);
        tuning.enemyMixSwarm = 0; // 到这儿四个权重都是 0,走的是回落成蜂群蛭那条路
      }),
    ).toEqual(base);
  });

  it('出怪排在敌人循环之前:新生敌人当帧就动,px/py 停在出生环上(铁律 2)', () => {
    onlyKind(KIND_SWARM);
    tuning.stressEnemies = 8;
    const w = new World(6);
    w.step();
    for (const e of w.enemies.items) {
      // 首帧渲染插值的两端不重合 = 它当帧确实被推进过,而不是等到下一帧才开始动
      expect(Math.hypot(e.x - e.px, e.y - e.py)).toBeGreaterThan(0);
      expect(Math.hypot(e.px, e.py)).toBeGreaterThanOrEqual(300); // 出怪环内半径,没生在船脸上
    }
  });

  it('HP 时间缩放接线:晚出生的那批确实更硬(GDD §14)', () => {
    onlyKind(KIND_SWARM);
    tuning.stressEnemies = 6;
    const w = new World(17);
    w.step();
    const early = w.enemies.items[0]!.hp;
    expect(early).toBeCloseTo(ENEMIES[KIND_SWARM]!.hp * (1 + 0.09 * (w.elapsed / 60)), 9);

    w.tick = 60 * 60; // 直接把世界拨到第 60 秒:HP 缩放的时间源就是 tick,不必空跑一分钟
    tuning.stressEnemies = 0;
    w.step(); // 清场
    tuning.stressEnemies = 6;
    w.step(); // 这一批出生在第 60 秒

    const late = w.enemies.items[0]!.hp;
    expect(late).toBeCloseTo(ENEMIES[KIND_SWARM]!.hp * (1 + 0.09 * (w.elapsed / 60)), 9);
    expect(late).toBeGreaterThan(early * 1.08);
  });
});

/**
 * 正式出怪器的接线(08 号 T2)。「什么时候、朝哪、出几只」全在 sim/waves.ts,由 waves.test.ts 钉;
 * 这里钉的是**世界这一层**替它补上的那几件事:出生落点(以船为心的环)、在场上限、出怪挂钩、
 * 波次进度进 checksum,以及 tuning.stressSpawn 那条 debug 路的整段旁路。
 *
 * 一律用 splice 进来的短脚本(与 waves.test.ts 同口径):真脚本 480s ≈ 28800 逻辑帧,单测里等不起,
 * 而且它在 M0 还要被反复调平衡 —— 拿它写断言的用例活不过第一次改动。唯一的例外是那条验收用例
 * (同 seed 两局出怪序列一致):它钉的就是"这一局真正会跑的那份脚本",只是只跑开头几十秒。
 */
describe('波次出怪接线(08 号 T2:正式出怪器)', () => {
  /** 真脚本原样留一份:每个用例都会换成短脚本,跑完必须还原,否则污染同文件后续用例 */
  const REAL = WAVE_SEGMENTS.slice();
  afterEach(() => {
    WAVE_SEGMENTS.splice(0, WAVE_SEGMENTS.length, ...REAL);
  });

  /**
   * 换脚本并回到正式出怪路(本文件的 BASE 默认是压测路)。
   * 必须在 new World **之前**调用:World 构造时就按第 0 段 t=0 算好了方向与强度。
   */
  function useScript(...segs: WaveSegment[]): void {
    tuning.stressSpawn = false;
    WAVE_SEGMENTS.splice(0, WAVE_SEGMENTS.length, ...segs);
  }

  function segment(p: Partial<WaveSegment> = {}): WaveSegment {
    return {
      name: 'seg',
      duration: 60,
      dirStartDeg: 0,
      dirEndDeg: 0,
      streams: [],
      bursts: [],
      elites: [],
      ...p,
    };
  }

  /** 一只怪的出生记录。记**相对船心**的落点:出怪环以船为心,记绝对坐标的断言换个船位就得重写 */
  interface Spawn {
    kind: number;
    dx: number;
    dy: number;
  }
  /**
   * 挂上出怪挂钩收流水账。**回调里当场读**(池里的对象死后会被复用成另一只敌人,存引用读到的是别人)——
   * 08 验收那条"同 seed 出怪序列一致"也只能这么比:池的 items 被 swap-remove 打乱过顺序。
   */
  function watchSpawns(w: World): Spawn[] {
    const out: Spawn[] = [];
    w.onEnemySpawn = (e) => out.push({ kind: e.kind, dx: e.x - w.ship.x, dy: e.y - w.ship.y });
    return out;
  }

  /** 出生点离船心多远 —— 出怪环的唯一口径,断言照抄它 */
  const ringDist = (s: Spawn): number => Math.hypot(s.dx, s.dy);

  it('默认走脚本:按主压方向在船外环上出怪,型号由脚本给死(压测的 enemyMix* 一个字都不生效)', () => {
    useScript(
      segment({
        dirStartDeg: 90, // +Y(y 轴朝下 = 屏幕正下方)
        dirEndDeg: 90,
        streams: [{ kind: KIND_TRAILER, rate0: 305, rate1: 305, spreadDeg: 0 }],
      }),
    );
    // 压测占比全押蜂群蛭:出来的要是尾随蛆,才说明型号真的来自脚本而不是那四条旋钮
    onlyKind(KIND_SWARM);
    const w = new World(41);
    const spawns = watchSpawns(w);
    w.step();

    expect(spawns.length).toBe(5); // 305 只/秒 ÷ 60Hz = 5.08:首帧出 5 只,余账 0.08 留给下一帧
    expect(w.enemies.size).toBe(5); // 而不是压测路那 300 只
    for (const s of spawns) {
      expect(s.kind).toBe(KIND_TRAILER);
      expect(ringDist(s)).toBeGreaterThanOrEqual(SPAWN_RADIUS);
      expect(ringDist(s)).toBeLessThan(SPAWN_RADIUS + SPAWN_RADIUS_BAND);
      // 展宽 0 → 出生角就是主压方向本身
      expect(wrapAngle(Math.atan2(s.dy, s.dx) - Math.PI / 2)).toBeCloseTo(0, 12);
    }
    // 半径真的抖了(SPAWN_RADIUS_BAND):不抖的话一股流会在屏外排成一道正圆弧、整排同时抵达
    expect(new Set(spawns.map(ringDist)).size).toBe(5);

    // 出怪排在建哈希之前:新生的敌人当帧就动,px/py 停在出生环上(铁律 2)
    for (const e of w.enemies.items) {
      expect(Math.hypot(e.px - w.ship.x, e.py - w.ship.y)).toBeGreaterThanOrEqual(SPAWN_RADIUS);
      expect(Math.hypot(e.x - e.px, e.y - e.py)).toBeGreaterThan(0);
    }
  });

  it('出怪环以**船**为心而不是原点(地图无限,船开到哪出怪环跟到哪)', () => {
    useScript(segment({ streams: [{ kind: KIND_SWARM, rate0: 305, rate1: 305, spreadDeg: 0 }] }));
    const w = new World(42);
    // 摆到离原点 806 的地方;没有输入 → 它一步也不会挪(无限地图:更没有任何边界会碰它)
    w.ship.x = 700;
    w.ship.y = -400;
    const spawns = watchSpawns(w);
    w.step();
    expect(w.ship.x).toBe(700);
    expect(w.ship.y).toBe(-400);

    expect(spawns.length).toBe(5);
    for (const s of spawns) {
      expect(ringDist(s)).toBeGreaterThanOrEqual(SPAWN_RADIUS);
      expect(ringDist(s)).toBeLessThan(SPAWN_RADIUS + SPAWN_RADIUS_BAND);
      // 以原点算的话落点会在原点周围的环上:主压方向 0° + 船在 +X 700,离原点远得多
      const fromCenter = Math.hypot(s.dx + w.ship.x, s.dy + w.ship.y);
      expect(fromCenter).toBeGreaterThan(SPAWN_RADIUS + SPAWN_RADIUS_BAND);
    }

    // 再跑一会儿:没有任何"边界"把敌人往里拉 —— 被拉回来的怪会排成一道墙,主压方向当场糊掉
    for (let i = 0; i < 30; i++) w.step();
    const far = w.enemies.items.filter((e) => Math.hypot(e.x, e.y) > 1200);
    expect(far.length).toBeGreaterThan(0);
  });

  it('被甩开的敌人沿船心镜像重投到出怪环上(无限地图的防风筝),插值两端都在新位置', () => {
    tuning.stressSpawn = true;
    tuning.stressEnemies = 1;
    onlyKind(KIND_SWARM);
    const w = new World(44);
    w.step();
    const e = w.enemies.items[0]!;

    // 手动把它甩到船(0,0)正后方、越过触发线一段。清掉出生时的杂向速度:
    // 这条用例钉的是"重投落点在 +X 轴上",不该让上一帧的惯性把 y 抹出一小截
    e.x = -(ENEMY_FALLBEHIND_RADIUS + 200);
    e.y = 0;
    e.vx = 0;
    e.vy = 0;
    w.step();

    // 镜像:从 -X 翻到 +X,半径回到出怪环内沿(这一帧它还会按惯性/转向挪一小步,容差按一帧位移给)
    const stepLen = (ENEMIES[KIND_SWARM]!.speed * tuning.enemySpeedScale) / 60 + 1;
    expect(e.x).toBeGreaterThan(0);
    expect(Math.abs(e.y)).toBeLessThan(1e-6);
    const d = Math.hypot(e.x - w.ship.x, e.y - w.ship.y);
    expect(d).toBeGreaterThan(ENEMY_REJOIN_RADIUS - stepLen);
    expect(d).toBeLessThan(ENEMY_REJOIN_RADIUS + stepLen);
    // px/py 也落在重投点上:渲染插值不会画出一条横跨全屏的拖影
    expect(Math.hypot(e.px - w.ship.x, e.py - w.ship.y)).toBeCloseTo(ENEMY_REJOIN_RADIUS, 6);

    // 压着触发线内侧的绝不误伤:只挪正常的一步,不会被重投回 1150 的环上
    e.x = ENEMY_FALLBEHIND_RADIUS - 10;
    e.y = 0;
    e.vx = 0;
    e.vy = 0;
    w.step();
    expect(Math.hypot(e.x, e.y)).toBeGreaterThan(ENEMY_FALLBEHIND_RADIUS - 10 - stepLen);
  });

  it('onEnemySpawn 与 onEnemyDeath 对称:每成功出一只当场响一次,回调里拿到的是填好的那只', () => {
    useScript(segment({ streams: [{ kind: KIND_BEETLE, rate0: 65, rate1: 65, spreadDeg: 10 }] }));
    const w = new World(43);
    const seen: { kind: number; hp: number; onRing: boolean; stamped: boolean }[] = [];
    w.onEnemySpawn = (e) =>
      seen.push({
        kind: e.kind,
        hp: e.hp,
        onRing: Math.hypot(e.x - w.ship.x, e.y - w.ship.y) >= SPAWN_RADIUS,
        stamped: e.px === e.x && e.py === e.y,
      });
    for (let i = 0; i < SIM_HZ; i++) w.step();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBe(w.enemies.size); // 一只都没死 → 响过的次数就是场上的人数
    for (const s of seen) {
      expect(s.kind).toBe(KIND_BEETLE);
      expect(s.hp).toBeGreaterThan(0); // 挂钩排在 initEnemy 之后:读到的不是个空壳
      expect(s.onRing).toBe(true);
      expect(s.stamped).toBe(true); // px/py 当场就是出生点(铁律 2)
    }
  });

  it('压测那条 debug 路一次都不响:凭空补人凑数量不是"这一局的波次里来了一只怪"', () => {
    tuning.stressSpawn = true;
    tuning.stressEnemies = 20;
    const w = new World(44);
    let n = 0;
    w.onEnemySpawn = () => n++;
    for (let i = 0; i < 10; i++) w.step();
    expect(w.enemies.size).toBe(20);
    expect(n).toBe(0);
  });

  it('同 seed 两局出怪序列一字不差(08 验收标准第二条),换 seed 才换序列', () => {
    // 这条**不换短脚本**:验收要的就是这一局真正会跑的那份 data/waves.ts,只是只跑开头 40 秒
    tuning.stressSpawn = false;
    const run = (seed: number): string[] => {
      const w = new World(seed);
      const out: string[] = [];
      // 型号 + 落点逐只记流水:比池里的 items 靠谱(swap-remove 会打乱顺序,那比的是另一件事)
      w.onEnemySpawn = (e) => out.push(`${e.kind}@${e.x.toFixed(6)},${e.y.toFixed(6)}`);
      for (let i = 0; i < 40 * SIM_HZ; i++) w.step();
      return out;
    };
    const a = run(2026);
    expect(a.length).toBeGreaterThan(30); // 不是"两边都没出怪"的空过
    expect(run(2026)).toEqual(a);
    expect(run(777)).not.toEqual(a);
  });

  it('在场上限:触顶后当帧的出怪请求直接丢弃、不留账(上限一解除不会一口气吐出来)', () => {
    useScript(
      segment({ streams: [{ kind: KIND_SWARM, rate0: 5000, rate1: 5000, spreadDeg: 90 }] }),
    );
    const w = new World(45);
    const spawns = watchSpawns(w);
    // 单帧硬上限 64 只(WAVE_MAX_SPAWN_PER_TICK),故填满 1400 只至少要 22 帧
    for (let i = 0; i < 40; i++) w.step();
    expect(w.enemies.size).toBe(WAVE_MAX_ALIVE);
    expect(spawns.length).toBe(WAVE_MAX_ALIVE);

    // 触顶之后:一只都不再落地(留账的话这几帧攒下的怪会在上限解除时一口气涌出来)
    const intensity = w.threatIntensity;
    w.step();
    // 请求仍在持续，但没有一只真正进池：罗盘强度只能按平滑系数衰减，不能被丢弃请求续上。
    expect(w.threatIntensity).toBeCloseTo(intensity * Math.exp(-SIM_DT / 1.25), 10);
    for (let i = 1; i < 10; i++) w.step();
    expect(w.enemies.size).toBe(WAVE_MAX_ALIVE);
    expect(spawns.length).toBe(WAVE_MAX_ALIVE);
  });

  it('stressSpawn = true:波次整段旁路 —— 冻在初值、方向不转、永不 done(这一局没有胜利条件)', () => {
    // 半秒的脚本:真跑起来早就走完了,而压测路下它一帧都不该动
    useScript(
      segment({
        duration: 0.5,
        dirStartDeg: 0,
        dirEndDeg: 180,
        streams: [{ kind: KIND_SWARM, rate0: 60, rate1: 60, spreadDeg: 0 }],
      }),
    );
    tuning.stressSpawn = true;
    tuning.stressEnemies = 12;
    const w = new World(46);
    const dir0 = w.threatDirection;
    const intensity0 = w.threatIntensity;
    for (let i = 0; i < 120; i++) w.step();

    expect(w.wave.segment).toBe(0);
    expect(w.wave.segTime).toBe(0);
    expect(w.wave.burstNext).toBe(0);
    expect(w.wave.done).toBe(false);
    expect(w.threatDirection).toBe(dir0);
    expect(w.threatIntensity).toBe(intensity0);
    expect(w.enemies.size).toBe(12); // 场上恒定 N 只 —— 压测路要的就是这个定数
  });

  it('无成功样本时方向回退波次派生值、强度为 0', () => {
    const seg = segment({ duration: 10, dirStartDeg: 20, dirEndDeg: 140 });
    useScript(seg);
    const w = new World(47);

    expect(w.threatDirection).toBe(w.wave.dirRad);
    expect(w.threatIntensity).toBe(0);
    for (let f = 0; f < 4 * SIM_HZ; f++) w.step();

    expect(w.enemies.size).toBe(0);
    expect(w.threatIntensity).toBe(0);
    expect(wrapAngle(w.threatDirection - waveDirAt(seg, w.wave.segTime))).toBeCloseTo(0, 12);
  });

  it('罗盘统计实际成功事件：burst 计入强度与方向，并按固定步平滑衰减且同 seed 确定', () => {
    useScript(
      segment({
        dirStartDeg: 10,
        dirEndDeg: 10,
        bursts: [{ at: 0, offsetDeg: 90, spreadDeg: 0, counts: [8, 0, 0, 0] }],
      }),
    );
    const a = new World(48);
    const b = new World(48);

    // 一只都没真正落地前只回退脚本方向，不拿“计划速率”冒充实时强度。
    expect(a.threatDirection / DEG2RAD).toBeCloseTo(10, 12);
    expect(a.threatIntensity).toBe(0);

    a.step();
    b.step();
    expect(a.enemies.size).toBe(8);
    // burst 的实际出生角 = 主压 10° + 偏移 90°，不能仍指着 wave.dirRad。
    expect(wrapAngle(a.threatDirection - 100 * DEG2RAD)).toBeCloseTo(0, 12);
    expect(a.threatIntensity).toBeGreaterThan(0);
    expect(a.threatDirection).toBe(b.threatDirection);
    expect(a.threatIntensity).toBe(b.threatIntensity);

    const peak = a.threatIntensity;
    a.step();
    b.step();
    expect(a.threatIntensity).toBeGreaterThan(0);
    expect(a.threatIntensity).toBeLessThan(peak);
    expect(a.threatIntensity).toBe(b.threatIntensity);
    expect(a.threatDirection).toBe(b.threatDirection);
  });

  it('波次进度进 checksum(段 / 段内计时 / 事件游标 / 逐流的账);方向与强度是派生量,不进', () => {
    useScript(
      segment({
        dirStartDeg: 0,
        dirEndDeg: 90,
        streams: [{ kind: KIND_SWARM, rate0: 0.7, rate1: 0.7, spreadDeg: 20 }],
        bursts: [{ at: 0.2, offsetDeg: 90, spreadDeg: 5, counts: [1, 0, 0, 0] }],
      }),
    );
    const a = new World(48);
    const b = new World(48);
    for (let i = 0; i < SIM_HZ; i++) {
      a.step();
      b.step();
    }
    expect(a.checksum()).toBe(b.checksum());
    expect(a.wave.burstNext).toBe(1); // 事件真的触发过,下面那条游标的断言才不是空过

    // 四项真状态逐个分叉 → 补上同一下又合流:每一项都是**单独**进的哈希,不是靠别的字段捎带
    const mutations: ((w: World) => void)[] = [
      (w) => (w.wave.segment += 1),
      (w) => (w.wave.segTime += 0.5),
      (w) => (w.wave.burstNext += 1),
      (w) => (w.wave.eliteNext += 1), // 14 号:精英游标是"到点即消费"的真状态,同一条口径
      (w) => (w.wave.debt[0] = w.wave.debt[0]! + 0.5),
    ];
    for (const mutate of mutations) {
      mutate(a);
      expect(a.checksum()).not.toBe(b.checksum());
      mutate(b);
      expect(a.checksum()).toBe(b.checksum());
    }

    // dirRad / intensity / done 是 segment + segTime + 脚本的纯函数(与 maxHp / shipDead 同口径):
    // 哈它们只是把同一件事哈两遍,故改了也不该分叉
    const before = a.checksum();
    a.wave.dirRad += 1;
    a.wave.intensity += 1;
    a.wave.done = true;
    expect(a.checksum()).toBe(before);
  });
});

/**
 * 局终判定(08 号 T3 + 15 号 Boss)。World **只做到"判"为止** —— 结论落成 result 与一次 onGameOver,
 * 暂停/重开/结算界面全在 main.ts,故这里钉的只有四件事:判得对不对
 * (胜利 = 脚本走完且 Boss 已击杀 / 失败 / 失败优先)、
 * 响几次(各一次、判完不改口)、判完还能不能接着 step(能,世界不认识"游戏流程")、
 * 以及船沉之后受击结算是不是真的整段停手(连火花都不再推)。
 *
 * 一律用 splice 进来的短脚本(与上一个 describe 同口径):真脚本 480s ≈ 28800 逻辑帧,单测里等不起。
 */
describe('局终判定(08 号 T3:胜负结论,World 只判不停)', () => {
  /** 真脚本原样留一份:每个用例都会换成短脚本,跑完必须还原,否则污染同文件后续用例 */
  const REAL = WAVE_SEGMENTS.slice();
  afterEach(() => {
    WAVE_SEGMENTS.splice(0, WAVE_SEGMENTS.length, ...REAL);
  });

  /**
   * 一段就跑完的脚本,并回到正式出怪路(本文件的 BASE 默认是压测路)。
   * 必须在 new World **之前**调用:World 构造时就按第 0 段 t=0 算好了方向与强度。
   * @param rate 主压速率(只/秒),缺省 0 = 一只怪都不出 —— 胜利那几条要的是一局"没人打扰的空跑"
   */
  function useShortScript(duration: number, rate = 0): void {
    tuning.stressSpawn = false;
    WAVE_SEGMENTS.splice(0, WAVE_SEGMENTS.length, {
      name: 'short',
      duration,
      dirStartDeg: 0,
      dirEndDeg: 0,
      streams: rate > 0 ? [{ kind: KIND_SWARM, rate0: rate, rate1: rate, spreadDeg: 0 }] : [],
      bursts: [],
      elites: [],
    });
  }

  /**
   * 段长**刻意不取整帧**:0.5s 恰好是 30 帧,而 segTime 是逐帧累加出来的,
   * 差一个 ulp 就会在"第 30 帧还是第 31 帧走完"上翻脸。取 0.505 后跨段那一帧无歧义,
   * 于是下面"走完的**前一帧**还没赢"这类断言才钉得住。
   */
  const DUR = 0.505;
  /** 跨段发生在第几帧(1 起数) */
  const CROSS = Math.ceil(DUR * SIM_HZ);

  it('开局 result = RESULT_RUNNING,局还在跑就一次都不响', () => {
    useShortScript(10);
    const w = new World(60);
    let n = 0;
    w.onGameOver = () => n++;

    expect(w.result).toBe(RESULT_RUNNING);
    for (let i = 0; i < SIM_HZ; i++) w.step();
    expect(w.result).toBe(RESULT_RUNNING);
    expect(n).toBe(0);
  });

  it('脚本走完不算赢:击杀 Boss 的那一帧才落 RESULT_WIN,onGameOver 恰好响一次', () => {
    useShortScript(DUR);
    const w = new World(61);
    const seen: number[] = [];
    w.onGameOver = (r) => seen.push(r);

    // 走完的**前一帧**:一切照旧 —— 提前一帧判就等于把最后一段的最后一秒白送了
    for (let i = 0; i < CROSS - 1; i++) w.step();
    expect(w.wave.done).toBe(false);
    expect(w.result).toBe(RESULT_RUNNING);
    expect(seen).toEqual([]);

    w.step();
    expect(w.wave.done).toBe(true);
    // 脚本走完只是进入 Boss 战(15 号):没杀掉 Boss 就不算赢
    expect(w.bossPhase).toBe(1);
    expect(w.result).toBe(RESULT_RUNNING);
    expect(seen).toEqual([]);

    // 再空跑一秒:波次已闭嘴、Boss 还在场上,依然不算赢
    for (let i = 0; i < SIM_HZ; i++) w.step();
    expect(w.result).toBe(RESULT_RUNNING);
    const boss = w.enemies.items.find((e) => e.kind === KIND_BOSS)!;
    expect(boss).toBeDefined();
    expect(boss.dead).toBe(false);

    // 击杀 Boss:帧尾 reap 翻阶段,同一帧 settleOutcome 落结论
    expect(w.damageEnemy(boss, 9999)).toBe(true);
    w.step();
    expect(w.bossPhase).toBe(2);
    expect(w.result).toBe(RESULT_WIN);
    expect(seen).toEqual([RESULT_WIN]);

    // 结算界面弹出后世界还会被 step 几帧(main.ts 下一渲染帧才暂停)—— 那几帧一次都不许再响
    for (let i = 0; i < 2 * SIM_HZ; i++) w.step();
    expect(seen).toEqual([RESULT_WIN]);
    expect(w.result).toBe(RESULT_WIN);
  });

  it('HP 归零 = 失败:结论在**帧尾**出,onShipDestroyed 与 onGameOver 各管一件事、各响一次', () => {
    useShortScript(60); // 长到跑不完:这一条只考失败
    const w = new World(62);
    const log: string[] = [];
    w.onShipDestroyed = () => log.push('dead');
    w.onGameOver = (r) => log.push(`over:${r}`);

    // 沉船那一刻只有状态位,还没有结论:胜负两条路统一在帧尾判(那时本帧的击杀才入完账)
    expect(w.damageShip(w.ship.maxHp, 100, 0)).toBe(true);
    expect(w.shipDead).toBe(true);
    expect(w.result).toBe(RESULT_RUNNING);
    expect(log).toEqual(['dead']);

    w.step();
    expect(w.result).toBe(RESULT_LOSE);
    expect(log).toEqual(['dead', `over:${RESULT_LOSE}`]);

    for (let i = 0; i < 2 * SIM_HZ; i++) w.step();
    expect(log).toEqual(['dead', `over:${RESULT_LOSE}`]);
  });

  it('撞沉的那一帧当帧就判:敌人在帧中把船撞光血,同一次 step 里就落成 RESULT_LOSE', () => {
    // 走真正的伤害路径(受击结算在帧中)而不是帧外 damageShip:结论要是没排在帧尾,这条就红
    const w = hullWorld(63);
    const core = hullCoreHalfExtents(halfOut);
    const e = w.enemies.items[0]!;
    park(e, w.ship.x + core.x / 2, w.ship.y);
    w.ship.hp = 1; // 蜂群蛭一口就够
    let over = -1;
    w.onGameOver = (r) => (over = r);

    w.step();
    expect(w.ship.hp).toBe(0);
    expect(w.shipDead).toBe(true);
    expect(w.result).toBe(RESULT_LOSE);
    expect(over).toBe(RESULT_LOSE);
  });

  it('失败优先于胜利:同一帧既沉船又走完脚本,算失败', () => {
    useShortScript(DUR);
    const w = new World(64);
    const seen: number[] = [];
    w.onGameOver = (r) => seen.push(r);

    for (let i = 0; i < CROSS - 1; i++) w.step();
    expect(w.wave.done).toBe(false);
    // 终点线前一帧被撞沉:这一帧 shipDead 与 wave.done 同时成立
    expect(w.damageShip(w.ship.maxHp, 100, 0)).toBe(true);
    w.step();

    expect(w.wave.done).toBe(true); // 脚本这一帧确实走完了 —— 断言不是空过
    expect(w.shipDead).toBe(true);
    expect(w.result).toBe(RESULT_LOSE);
    expect(seen).toEqual([RESULT_LOSE]);
  });

  it('判完不改口:赢了之后再把船打沉,result 仍是 RESULT_WIN,回调也不再响', () => {
    useShortScript(DUR);
    const w = new World(65);
    const seen: number[] = [];
    w.onGameOver = (r) => seen.push(r);

    for (let i = 0; i < CROSS; i++) w.step();
    expect(w.wave.done).toBe(true);
    expect(w.bossPhase).toBe(1); // 脚本走完 = Boss 登场,胜负未分
    const boss = w.enemies.items.find((e) => e.kind === KIND_BOSS)!;
    expect(w.damageEnemy(boss, 9999)).toBe(true);
    w.step();
    expect(w.result).toBe(RESULT_WIN);

    expect(w.damageShip(w.ship.maxHp, 100, 0)).toBe(true);
    w.step();
    expect(w.shipDead).toBe(true);
    expect(w.result).toBe(RESULT_WIN); // 胜负互斥:先到的那个把这一局定死
    expect(seen).toEqual([RESULT_WIN]);
  });

  it('Boss 阶段状态进 checksum:phase / 召唤游标 / 召唤计时各自单独分叉又合流', () => {
    useShortScript(DUR);
    const a = new World(69);
    const b = new World(69);
    for (let i = 0; i < CROSS; i++) {
      a.step();
      b.step();
    }
    expect(a.checksum()).toBe(b.checksum());
    expect(a.bossPhase).toBe(1); // 非空过:Boss 真的登场了

    // 三项真状态逐个分叉 → 补上同一下又合流:每一项都是**单独**进的哈希
    const mutations: ((w: World) => void)[] = [
      (w) => (w.bossPhase = 2),
      (w) => (w.bossSummonN += 1),
      (w) => (w.bossSummonCooldown += 0.5),
    ];
    for (const mutate of mutations) {
      mutate(a);
      expect(a.checksum()).not.toBe(b.checksum());
      mutate(b);
      expect(a.checksum()).toBe(b.checksum());
    }

    // bossKilledAt 是击杀时刻的一次性记录(与 kills 同口径,派生量):不进哈希
    const before = a.checksum();
    a.bossKilledAt += 3.3;
    expect(a.checksum()).toBe(before);
  });

  it('World 判完不自己停手:step() 照常推进 tick/elapsed(暂停是 main.ts 的事)', () => {
    useShortScript(DUR, 60);
    const w = new World(66);
    for (let i = 0; i < CROSS; i++) w.step();
    expect(w.wave.done).toBe(true);
    // 脚本走完只是进入 Boss 战:杀掉 Boss 才算赢,然后才开始量"判完不停手"
    const boss = w.enemies.items.find((e) => e.kind === KIND_BOSS)!;
    expect(w.damageEnemy(boss, 9999)).toBe(true);
    w.step();
    expect(w.result).toBe(RESULT_WIN);
    const tick = w.tick;
    const alive = w.enemies.size;
    expect(alive).toBeGreaterThan(0); // 场上还有人:下面那条"不再出怪"才有对照

    for (let i = 0; i < 30; i++) w.step();
    expect(w.tick).toBe(tick + 30);
    expect(w.elapsed).toBeCloseTo((tick + 30) * SIM_DT, 12);
    // 胜利之后波次彻底闭嘴(stepWaves 的第一句):结算界面背后不该还在涌怪
    expect(w.enemies.size).toBeLessThanOrEqual(alive);
  });

  it('压测路(stressSpawn)没有胜利条件:脚本再短也不会弹结算', () => {
    useShortScript(0.05); // 短到第一帧就该走完
    tuning.stressSpawn = true;
    tuning.stressEnemies = 4;
    const w = new World(67);
    let n = 0;
    w.onGameOver = () => n++;

    for (let i = 0; i < SIM_HZ; i++) w.step();
    expect(w.wave.done).toBe(false); // 波次整段旁路,冻在初值
    expect(w.result).toBe(RESULT_RUNNING);
    expect(n).toBe(0);
  });

  it('船沉之后受击结算整段停手:连火花与撞击圆环都不再推(伤害那一半本来就被挡着)', () => {
    const w = hullWorld(68);
    const core = hullCoreHalfExtents(halfOut);
    const e = w.enemies.items[0]!;
    park(e, w.ship.x + core.x / 2, w.ship.y);

    // 先证明这只敌人真的在持续产出撞击事件,否则下面那条断言是空过
    w.step();
    expect(w.shipDead).toBe(false);
    expect(w.fx.size).toBeGreaterThan(0);

    // 帧外扣光:这条考的是"沉了之后还推不推事件",不是"怎么沉的"
    expect(w.damageShip(w.ship.hp, 100, 0)).toBe(true);
    expect(w.shipDead).toBe(true);
    // 跑够 2 秒:沉船前那批事件早已到期(FX_LIFE_* 最长 0.22s),无敌帧也早过了好几轮
    for (let i = 0; i < frames(2); i++) w.step();
    expect(w.fx.size).toBe(0);

    // 而它还老老实实压在核心区上 —— 不是因为它走开了才没事件,是结算这一步整段停了
    expect(classifyHit(w.ship, w.deck, e.x, e.y, ENEMIES[KIND_SWARM]!.radius)).toBe(HIT_CORE);
    expect(w.contacts).toContain(e); // 粗筛照常登记:停手的只有结算
  });

  it('result 是派生量,不进 checksum(与 maxHp / shipDead 同口径)', () => {
    const a = new World(69);
    const b = new World(69);
    for (let i = 0; i < 30; i++) {
      a.step();
      b.step();
    }
    expect(a.checksum()).toBe(b.checksum());
    a.result = RESULT_WIN;
    expect(a.checksum()).toBe(b.checksum());
  });
});

/**
 * 07 验收标准里可自动化的部分(T5)。这几条都得在一个真世界里连着跑若干秒才成立:
 * 方向压力说的是"相对**当前**船头的方位",船不动就退化成一句废话;
 * HP 时间缩放说的是第 5 分钟,也只有真跑到 tick=18000 才算数。
 * 剩下的"1000 只同屏 60fps"要真机浏览器,不在这里验(Node 里量不出帧率)。
 */
describe('07 验收标准(可自动化的部分)', () => {
  it('侧掠者从当前船侧发起:起手瞬间的方位在舷侧 45°~135°,而不是聚在船尾 180°(追尾)', () => {
    onlyKind(KIND_STRAFER);
    tuning.stressEnemies = 24;
    const w = new World(101);

    const bearings: number[] = [];
    const watch = watchStates(w, (e, was) => {
      // 只在 APPROACH→WINDUP 那一帧取样:起手之后方向就锁死了,冲刺途中方位自然会滑向船头,
      // 事后回看必然测歪。这一帧的 px/py 正是状态机做判定时用的位置(敌人循环开头存的),
      // ship 也已经是本帧的新位置 —— 与 shouldWindup 的口径严丝合缝
      if (was === ST_APPROACH && e.state === ST_WINDUP) {
        bearings.push(wrapAngle(bearingTo(w, e.px, e.py) - w.ship.heading) / DEG2RAD);
      }
    });

    // 折线巡航:船一路在动还转了三次向,"舷侧"是个移动靶。静止船上测这条毫无意义 ——
    // 追尾型在静止船周围也能凑出各种方位角
    for (const leg of [0, 90, 180, 270]) cruise(w, leg, 5, watch);

    expect(bearings.length).toBeGreaterThan(15); // 真取到样了,不是空过 20 秒
    for (const deg of bearings) {
      // 判据是 |目标方位差| < 30°、目标方位 = 船头 ±90° → 起手必落在 60°~120°,这里留足余量。
      // 一旦退化成追尾,这些值会齐刷刷跑到 180° 附近
      expect(Math.abs(deg)).toBeGreaterThanOrEqual(45);
      expect(Math.abs(deg)).toBeLessThanOrEqual(135);
    }
    // 左右舷都用得上(e.side 出生时定死):全挤一侧的话玩家固定一边火力就免疫了
    expect(bearings.some((d) => d > 0)).toBe(true);
    expect(bearings.some((d) => d < 0)).toBe(true);
  });

  it('尾随蛆持续占据船尾象限:硬转 90° 甩开后绕回**新的**船尾,松手停船也咬在驻留半径上', () => {
    onlyKind(KIND_TRAILER);
    tuning.stressEnemies = 20;
    const w = new World(202);

    /** 落在船尾 ±45° 象限内的比例 */
    const sternFrac = (): number => {
      let ok = 0;
      for (const e of w.enemies.items) {
        const err = wrapAngle(bearingTo(w, e.x, e.y) - (w.ship.heading + Math.PI));
        if (Math.abs(err) < 45 * DEG2RAD) ok++;
      }
      return ok / w.enemies.size;
    };

    cruise(w, 0, 6); // 先直线巡航 6s,让它们从出怪环各处排到船尾
    expect(sternFrac()).toBeGreaterThanOrEqual(0.8);

    cruise(w, 90, 1); // 硬转 90°(100°/s,0.9s 转完):老船尾这一刻变成了正横
    // 转完当场确实被甩到舷侧 —— 有这条对照,下面那条才不是"它们本来就在那儿"的空过
    expect(sternFrac()).toBeLessThan(0.5);

    cruise(w, 90, 4); // 再直线 4s:够它们绕回新船尾
    let worst = 1;
    // 逐帧取最差值而不是只看最后一眼:"持续占据"要的是稳态,不是某一帧的巧合
    cruise(w, 90, 1, () => {
      worst = Math.min(worst, sternFrac());
    });
    expect(worst).toBeGreaterThanOrEqual(0.8);

    // 松手停船(不给输入 = World.step 的缺省;船头朝向不变):纯追踪型这时会一头扎进船身,
    // 尾随蛆则停在驻留半径上咬尾。这一条挡的是"BH_STRAFE 退化成 seek" ——
    // 退化之后上面几条照样能过(追得慢的东西本来就落在船后),方向压力却已经没了
    for (let f = 0; f < 3 * SIM_HZ; f++) w.step();
    expect(sternFrac()).toBeGreaterThanOrEqual(0.8);

    const radius = ENEMIES[KIND_TRAILER]!.strafeRadius;
    const nearest = Math.min(
      ...w.enemies.items.map((e) => Math.hypot(e.x - w.ship.x, e.y - w.ship.y)),
    );
    expect(nearest).toBeGreaterThan(radius * 0.5);
    expect(nearest).toBeLessThan(radius * 1.5);
  });

  it('冲撞甲虫:每次冲刺前必有前摇,帧数由数据表的 chargeWindup 算出来(改数据即改手感)', () => {
    // 0.9 是表里的占位值;另一档证明帧数是从数据算的,不是把 54 写死在代码里
    for (const windup of [BASE_BEETLE_WINDUP, 0.4]) {
      ENEMIES[KIND_BEETLE]!.chargeWindup = windup;
      onlyKind(KIND_BEETLE);
      tuning.stressEnemies = 12;
      const w = new World(303);

      const windupFrames = new Map<Enemy, number>();
      const dashes: number[] = [];
      const watch = watchStates(w, (e, was) => {
        if (e.state === ST_WINDUP) windupFrames.set(e, (windupFrames.get(e) ?? 0) + 1);
        if (e.state === ST_DASH && was !== ST_DASH) {
          // 冲刺只能从前摇里出来。少了这一票,玩家看到的就是无预警的秒杀
          expect(was).toBe(ST_WINDUP);
          dashes.push(windupFrames.get(e) ?? 0);
          windupFrames.set(e, 0);
        }
      });

      for (const leg of [0, 90, 180]) cruise(w, leg, 4, watch);

      expect(dashes.length).toBeGreaterThanOrEqual(3); // 真冲起来了,不是空过 12 秒
      for (const frames of dashes) expect(frames).toBe(Math.round(windup / SIM_DT));
    }
  });

  it('HP 时间缩放跑满 5 分钟:此刻重生的敌人 = 基础血 ×1.45(GDD §14)', () => {
    onlyKind(KIND_SWARM);
    tuning.stressEnemies = 1; // 就一只:要真跑满 18000 帧,场上人越少跑得越快
    const w = new World(77);

    // 回收在帧尾、出怪在帧首 → 打死之后要隔两帧才补出新的一只。
    // 想让新敌恰好生在第 5 分钟那一帧(tick=18000),就得提前两帧动手
    const fiveMin = 5 * 60 * SIM_HZ;
    while (w.tick < fiveMin - 2) w.step();

    const first = w.enemies.items[0]!;
    expect(first.hp).toBeLessThan(ENEMIES[KIND_SWARM]!.hp * 1.1); // 它生在开局,当然还是软的
    expect(w.damageEnemy(first, 9999)).toBe(true);

    w.step(); // 帧尾回收
    expect(w.enemies.size).toBe(0);
    w.step(); // 帧首补位
    expect(w.tick).toBe(fiveMin);
    expect(w.elapsed).toBeCloseTo(300, 9);

    const fresh = w.enemies.items[0]!;
    expect(fresh.hp).toBeCloseTo(ENEMIES[KIND_SWARM]!.hp * 1.45, 9);
    expect(fresh.maxHp).toBe(fresh.hp); // 满血出生,而不是带着上一条命的残血被复用
  });
});

/**
 * 接触粗筛(09 号 T1)。三层判定的几何本身在 damage.test.ts 逐条钉死,这里只钉**世界这一层**:
 * contacts 是一份**超集**(粗筛宁大勿小),精筛与结算全在 settleHullDamage 一处。
 * "超集"这条不是文字游戏 —— 粗筛漏一个人,那只敌人这一帧就彻底结算不到,
 * 而名单里多几个没真碰上的,只是让帧尾多跑几次矩形判定。
 */
describe('接触粗筛(contacts = 粗筛候选,是"真碰上的人"的超集)', () => {
  it('粗筛圆 = 甲板外接圆 + 体型 ×√2,圈外的不登记', () => {
    onlyKind(KIND_SWARM);
    tuning.stressEnemies = 3;
    const w = new World(2);
    w.step();

    const r = coarseRadius(KIND_SWARM, w);
    const [near, far, away] = w.enemies.items as [Enemy, Enemy, Enemy];
    // near 卡在甲板外接圆之外、算上体型之内:漏掉体型那一项的话它就检不出来了
    park(near, r - 3, 0);
    park(far, r + 5, 0);
    park(away, 900, 0);
    expect(r - 3).toBeGreaterThan(deckOuterRadius(w.deck));
    w.step();

    expect(w.contacts).toContain(near);
    expect(w.contacts).not.toContain(far);
    expect(w.contacts).not.toContain(away);
  });

  it('超集:凡 classifyHit ≠ HIT_NONE 的一个不漏,而名单里的未必真碰上', () => {
    onlyKind(KIND_SWARM);
    tuning.stressEnemies = 24;
    tuning.enemySpeedScale = 0; // 钉死在摆好的位置:这一条考的是判定,不是它们往哪走
    const w = new World(42);
    w.step();
    // 斜着摆船:矩形判定体与圆形粗筛的差别只有在非轴对齐时才露得出来
    w.ship.heading = w.ship.pheading = 0.7;

    const def = ENEMIES[KIND_SWARM]!;
    const coarse = coarseRadius(KIND_SWARM, w);
    const items = w.enemies.items;
    // 绕一圈铺开,半径从船心一路排到粗筛圆外:核心区/擦碰/圈内没碰上/圈外,四种情形都排得到
    for (let i = 0; i < items.length; i++) {
      const a = (i / items.length) * Math.PI * 2;
      const d = (coarse * (i % 6)) / 4;
      park(items[i]!, Math.cos(a) * d, Math.sin(a) * d);
    }

    // 四个角再单独摆一遍 —— 粗筛与精筛唯一会分家的地方就在这里:精筛把矩形按体型**两轴各外扩**,
    // 那个盒子的角(hypot(半长+r, 半宽+r))比"外接圆 + r"还远。粗筛半径少乘那个 √2 的话,
    // 这四只会一边被 classifyHit 判成擦碰、一边落在名单之外 —— 于是永远结算不到
    const h = deckHalfExtents(w.deck, halfOut);
    const cos = Math.cos(w.ship.heading);
    const sin = Math.sin(w.ship.heading);
    const lx = h.x + def.radius * 0.9;
    const ly = h.y + def.radius * 0.9;
    for (let i = 0; i < 4; i++) {
      const sx = i < 2 ? lx : -lx;
      const sy = i % 2 === 0 ? ly : -ly;
      // 局部 → 世界(船停在原点):与 classifyHit 那条转置旋转互为逆变换
      park(items[i]!, sx * cos - sy * sin, sx * sin + sy * cos);
    }
    w.step();

    let touched = 0;
    let loose = 0;
    for (const e of items) {
      const listed = w.contacts.includes(e);
      if (classifyHit(w.ship, w.deck, e.x, e.y, def.radius) !== HIT_NONE) {
        // ① 真碰上的一个不漏 —— 粗筛漏掉的人,帧尾的结算永远看不见
        expect(listed).toBe(true);
        touched++;
      } else if (listed) {
        loose++;
      }
      // ② 名单里的都在粗筛圆内:粗筛的定义就是这一条,多一个人进来都是判据写歪了
      if (listed) expect(Math.hypot(e.x - w.ship.x, e.y - w.ship.y)).toBeLessThan(coarse);
    }
    expect(touched).toBeGreaterThan(0); // 非空过:确实有人碰上了
    expect(loose).toBeGreaterThan(0); // 也确实有人只是进了圈却一层都没碰上 —— 这才叫超集
    expect(new Set(w.contacts).size).toBe(w.contacts.length); // 同一只不会被登记两次
  });

  it('把船挪进敌群:名单与"真的落进粗筛圆"的那批人逐个吻合,下一帧开头清空', () => {
    onlyKind(KIND_SWARM);
    tuning.stressEnemies = 12;
    const w = new World(41);
    w.step();

    // 把敌群摆成一串,距离从粗筛圆内一路排到圈外,然后把船直接挪进这堆人中间
    const items = w.enemies.items;
    for (let i = 0; i < items.length; i++) park(items[i]!, 400, 20 + i * 12);
    w.ship.x = 400;
    w.ship.y = 0;
    w.step();

    const r = coarseRadius(KIND_SWARM, w);
    let inside = 0;
    for (const e of items) {
      // 粗筛在敌人积分之后、船本帧也早已走完 → 拿收尾坐标复算,与检测时的口径严格一致
      const touching = Math.hypot(e.x - w.ship.x, e.y - w.ship.y) < r;
      expect(w.contacts.includes(e)).toBe(touching);
      if (touching) inside++;
    }
    expect(inside).toBeGreaterThan(0); // 圈内圈外都得有人,否则这条断言是空过的
    expect(inside).toBeLessThan(items.length);
    expect(w.contacts.length).toBe(inside);

    // 清空发生在敌人循环**之前**:这一帧一只敌人都没有,名单照样得是空的。
    // 若改成"靠重新检测覆盖",空帧就会把上一帧的名单留给帧尾的结算,变成幽灵碰撞
    const ref = w.contacts;
    tuning.stressEnemies = 0;
    w.step();
    expect(w.contacts.length).toBe(0);
    expect(w.contacts).toBe(ref); // 原地清空复用同一个数组,不是每帧 new 一个(铁律 3)
  });

  it('每帧重建:上一帧贴上来的敌人离开后不会留在名单里', () => {
    onlyKind(KIND_SWARM);
    tuning.stressEnemies = 2;
    const w = new World(14);
    w.step();
    for (const e of w.enemies.items) park(e, 0, 0);
    w.step();
    expect(w.contacts.length).toBe(2);

    for (const e of w.enemies.items) park(e, 900, 0);
    w.step();
    expect(w.contacts.length).toBe(0);
  });
});

/**
 * 船体 HP 与受击结算(09 号 T1)。判定几何(核心区/甲板轮廓/四舷/射速倍率)在 damage.test.ts
 * 逐条钉死,这里只钉**世界这一层**的接线:
 *   HP 上限走 damage.hullMaxHp 这条 06 号挂钩,而不是各处现读 tuning;
 *   damageShip 是船体受伤的唯一入口(碰撞结算与将来的敌方弹幕都走它);
 *   撞进核心区才扣血、蹭到核心外的甲板只出火花(GDD §4.4);
 *   同一只敌人的无敌帧、四舷惩罚"不可叠加延长",以及这几样进不进 checksum。
 */
describe('船体 HP 与受击结算(09 号 T1/T2)', () => {
  it('开局满血,上限走 damage.hullMaxHp(deck)——06 号装甲舱的挂钩今天就接着', () => {
    const w = new World(1);
    expect(w.ship.maxHp).toBe(hullMaxHp(w.deck));
    expect(w.ship.hp).toBe(w.ship.maxHp);
    expect(w.ship.hp).toBe(tuning.shipHullHp); // GDD §14 锁定的 100
    expect(w.shipDead).toBe(false);
    expect(w.edgePenalty).toEqual([0, 0, 0, 0]);
  });

  it('放置成功后重刷上限(06 号挂钩真的活着),hp 不跟着回血;被拒的放置不重刷', () => {
    const w = new World(1);
    w.ship.hp = 40;

    // 拖 shipHullHp 冒充"06 号的装甲舱把上限抬了上去":重刷若没接上,maxHp 会一直停在 100
    tuning.shipHullHp = 160;
    expect(w.ship.maxHp).toBe(100); // 还没放置:上限是构造时那一次读的
    expect(w.place(1, 1, CELL_SUPPORT)).toBe(PLACE_OK);
    expect(w.ship.maxHp).toBe(160);
    expect(w.ship.hp).toBe(40); // 上限涨了,这一局打下来的账一分不还 —— 装甲舱不是治疗

    // 被拒的放置一个字段都没动(见 sim/deck),自然也不该重刷
    tuning.shipHullHp = 200;
    expect(w.place(1, 1, CELL_SUPPORT)).toBe(PLACE_TAKEN);
    expect(w.ship.maxHp).toBe(160);
  });

  it('damageShip:按接触点相对船头的方位角定舷,扣血夹 0,amount ≤ 0 一律不算数', () => {
    const w = new World(2);
    w.ship.heading = w.ship.pheading = 0; // 船头 +X,四舷的方位一眼可读
    const full = w.ship.maxHp;

    // 零伤害/负伤害不算数:否则"零伤害的接触"也会把那一舷刷成闪红 + 射速惩罚,反馈就成了噪音
    expect(w.damageShip(0, 100, 0)).toBe(false);
    expect(w.damageShip(-5, 100, 0)).toBe(false);
    expect(w.ship.hp).toBe(full);
    expect(w.edgePenalty).toEqual([0, 0, 0, 0]);

    expect(w.damageShip(10, 100, 0)).toBe(true); // 正 +X = 船头
    expect(w.ship.hp).toBe(full - 10);
    expect(w.edgePenalty[EDGE_BOW]).toBe(tuning.hitPenaltyTime);
    expect(w.edgePenalty[EDGE_STARBOARD]).toBe(0);

    expect(w.damageShip(10, 0, 100)).toBe(true); // +Y = 右舷(口径沿用 deck 的 EDGE_NORMAL)
    expect(w.edgePenalty[EDGE_STARBOARD]).toBe(tuning.hitPenaltyTime);
    expect(w.damageShip(10, 0, -100)).toBe(true);
    expect(w.edgePenalty[EDGE_PORT]).toBe(tuning.hitPenaltyTime);
    expect(w.damageShip(10, -100, 0)).toBe(true);
    expect(w.edgePenalty[EDGE_STERN]).toBe(tuning.hitPenaltyTime);

    // 一发过量伤害:hp 夹在 0,血条/HUD 不必各自再兜一次负数
    expect(w.damageShip(9999, 100, 0)).toBe(true);
    expect(w.ship.hp).toBe(0);
  });

  it('HP 归零:置 shipDead 并触发一次 onShipDestroyed,此后一切停手(局终流程是 08 号)', () => {
    tuning.stressEnemies = 0;
    const w = new World(3);
    let dead = 0;
    w.onShipDestroyed = () => dead++;

    expect(w.damageShip(w.ship.maxHp - 1, 100, 0)).toBe(true);
    expect(w.shipDead).toBe(false);
    expect(dead).toBe(0);

    expect(w.damageShip(1, 100, 0)).toBe(true);
    expect(w.ship.hp).toBe(0);
    expect(w.shipDead).toBe(true);
    expect(dead).toBe(1);

    // 尸体上再打多少下都不再响,也不再刷惩罚:08 那边不必自己去重
    const penalty = [...w.edgePenalty];
    expect(w.damageShip(50, 0, 100)).toBe(false);
    expect(dead).toBe(1);
    expect([...w.edgePenalty]).toEqual(penalty);

    // 本轮**只到状态位为止**:不做结算界面、不重开、不暂停、不动 loop —— 世界照常往下跑
    const tick = w.tick;
    w.step();
    expect(w.tick).toBe(tick + 1);
    expect(w.shipDead).toBe(true);
  });

  it('四舷判定:敌人分别压在船头/右舷/船尾/左舷的核心区,只有对应那一位被点亮', () => {
    // 沿四个方向各取核心区半长/半宽的一半:落点必在核心区内,方位角也正对着那一舷的法线。
    // 尺寸问 damage.hullCoreHalfExtents 而不是手抄一个数 —— 拖一下 shipCoreScale
    // 不该让这条用例莫名其妙地红(它考的是"撞在哪一舷",不是"核心区多大")
    const core = hullCoreHalfExtents(halfOut);
    const CASES: ReadonlyArray<readonly [number, number, number]> = [
      [EDGE_BOW, core.x / 2, 0],
      [EDGE_STARBOARD, 0, core.y / 2],
      [EDGE_STERN, -core.x / 2, 0],
      [EDGE_PORT, 0, -core.y / 2],
    ];
    const def = ENEMIES[KIND_SWARM]!;

    for (const [edge, dx, dy] of CASES) {
      // 一舷一个世界:惩罚计时是累积状态,点亮过的舷要 0.5s 才灭 ——
      // 四舷挤在同一局里的话,"只有这一位亮"从第二舷起就必然不成立
      const w = hullWorld(58 + edge);
      const e = w.enemies.items[0]!;
      park(e, w.ship.x + dx, w.ship.y + dy);
      w.step();

      // 撞的确实是核心区(而不是擦碰):否则下面四条会在"一分血都没结算"的前提下集体空过
      expect(classifyHit(w.ship, w.deck, e.x, e.y, def.radius)).toBe(HIT_CORE);
      expect(w.ship.hp).toBe(w.ship.maxHp - def.contactDamage);
      // 被撞舷闪红(渲染层)与该舷塔的射速惩罚读的都是这一位 —— 点错一位,两件事一起错。
      // 逐位断言而不是只看被撞的那一位:漏判成"四舷全亮"时,只查一位照样绿
      for (let i = 0; i < EDGE_COUNT; i++) {
        expect(w.edgePenalty[i]).toBe(i === edge ? tuning.hitPenaltyTime : 0);
      }
    }
  });

  it('惩罚不可叠加延长:0.3s 后再挨一下,惩罚仍在**第一次**受击后的第 0.5s 结束', () => {
    tuning.stressEnemies = 0; // 空场:这几十帧里只有计时器在动
    const w = new World(4);
    w.ship.heading = w.ship.pheading = 0;
    w.step();

    w.damageShip(1, 100, 0);
    expect(w.edgePenalty[EDGE_BOW]).toBe(tuning.hitPenaltyTime);

    for (let f = 0; f < frames(0.3); f++) w.step();
    const left = w.edgePenalty[EDGE_BOW]!;
    expect(left).toBeCloseTo(0.2, 9);

    // 再挨一下:计时**不许**被推回 0.5s —— 每次受击都重置的话,蜂群贴脸就是一条常亮的红边
    // 加上永不恢复的射速,正是 GDD §4.6 要避开的那条死亡螺旋
    w.damageShip(1, 100, 0);
    expect(w.edgePenalty[EDGE_BOW]).toBe(left);

    // 从头算的第 0.5s(第 30 帧)恰好走完;叠加延长的话这里还剩 0.3s
    for (let f = 0; f < frames(0.2) - 1; f++) w.step();
    expect(w.edgePenalty[EDGE_BOW]).toBeGreaterThan(0);
    w.step();
    expect(w.edgePenalty[EDGE_BOW]).toBeCloseTo(0, 9);
    w.step();
    expect(w.edgePenalty[EDGE_BOW]).toBe(0); // 夹 0,不跑成负数
  });

  it('连续受击(无敌帧关到 0 = 每帧都在咬):惩罚是 0.5s 的锯齿,而不是一条常亮的红边', () => {
    // 验收标准第三条("连续受击时射速惩罚保持 0.5s 上限")的最极端形态:把无敌帧拖到 0,
    // 让这一只每帧都咬一口。上一条走的是 damageShip 直调,这一条走的是真碰撞那条路。
    // HP 上限临时抬高(World 构造时读一次,故必须在 hullWorld 之前拖):
    // 血扣光了 damageShip 就一切停手,读到的便不再是那条锯齿而是"死了之后没人再挨罚"
    tuning.shipHullHp = 1e6;
    tuning.enemyHitInterval = 0;
    const w = hullWorld(57);
    const def = ENEMIES[KIND_SWARM]!;
    park(w.enemies.items[0]!, w.ship.x + hullCoreHalfExtents(halfOut).x / 2, w.ship.y); // 正对船头

    const period = cooldownFrames(tuning.hitPenaltyTime);
    const armed: number[] = [];
    for (let f = 0; f < period * 3; f++) {
      w.step();
      const left = w.edgePenalty[EDGE_BOW]!;
      // 上限就是 hitPenaltyTime:每次受击都重置的话它会**恒等于**上限,一帧都走不下来
      expect(left).toBeLessThanOrEqual(tuning.hitPenaltyTime);
      if (left === tuning.hitPenaltyTime) armed.push(f);
    }

    // 重新点亮只发生在计时走完的那一帧,间隔恰好一个 hitPenaltyTime:中间那几十帧照样在挨咬,
    // 惩罚却一帧都没被延长。闪红读的是同一个计时器,于是玩家看到的红边也跟着一起脉动 ——
    // 那正是"还在挨打"与"已经挨了很久"的区别,常亮的红边什么都说不出来
    expect(armed).toEqual([0, period, period * 2]);
    // 非空过:这段时间里真的每帧都咬到了(不然上面那条对着一串 0 也照样绿)
    expect(w.ship.hp).toBe(w.ship.maxHp - def.contactDamage * period * 3);
  });

  it('撞进核心区 → 扣血 + 暖红事件;伤害速率跟着 enemyContactDamageScale 走', () => {
    const w = hullWorld(51);
    const e = w.enemies.items[0]!;
    const def = ENEMIES[KIND_SWARM]!;
    park(e, 0, 0); // 压在船心 = 核心区
    const full = w.ship.hp;

    w.step();
    expect(classifyHit(w.ship, w.deck, e.x, e.y, def.radius)).toBe(HIT_CORE);
    expect(w.ship.hp).toBe(full - def.contactDamage);
    expect(fxKinds(w)).toContain(FXV_HULL_HIT);
    expect(fxKinds(w)).not.toContain(FXV_SPARK); // 先判核心后判轮廓:核心区里的敌人不出火花
    // 撞完不击退、不消灭、不改状态机(VS 式:它继续磨)
    expect(e.x).toBe(0);
    expect(e.dead).toBe(false);
    expect(e.state).toBe(ST_APPROACH);
    expect(w.kills).toBe(0);

    // "蜂群贴脸掉血速率可控可调"的那根旋钮:同一口咬下去,伤害跟着倍率走
    tuning.enemyContactDamageScale = 3;
    e.hitCd = 0;
    const before = w.ship.hp;
    w.step();
    expect(w.ship.hp).toBe(before - def.contactDamage * 3);
  });

  it('蹭到核心区之外的甲板 → 只出火花,一分血都不结算(GDD §4.4)', () => {
    const w = hullWorld(52);
    const e = w.enemies.items[0]!;
    const def = ENEMIES[KIND_SWARM]!;
    // 核心区之外、甲板轮廓之内 —— 位置从 sim 自己的两个半长**推**出来,不手抄 px
    // (船体尺寸是 tuning 的旋钮,写死一个数,改一次船型这里就红一次):
    // 核心带 = core.x + radius,轮廓带 = hull.x + radius,取两者中点必落在擦碰带里。
    // 位置最终仍由 classifyHit 当场自证
    const core = hullCoreHalfExtents(halfOut).x;
    const hull = deckHalfExtents(w.deck, halfOut).x;
    park(e, (core + hull) / 2 + def.radius, 0);
    const full = w.ship.hp;

    w.step();
    expect(classifyHit(w.ship, w.deck, e.x, e.y, def.radius)).toBe(HIT_GRAZE);
    expect(w.ship.hp).toBe(full); // 一分血都没掉 —— 判定体小于外形,这就是玩家能读到的证据
    expect(fxKinds(w)).toContain(FXV_SPARK);
    expect(fxKinds(w)).not.toContain(FXV_HULL_HIT);
    expect(w.edgePenalty).toEqual([0, 0, 0, 0]); // 没结算就不闪红:擦碰不是"挨打"

    // 再挪到甲板轮廓之外:粗筛名单里还有它(超集),但一层都没碰上 → 连火花都不出。
    // 位置同样推出来:轮廓带之外一点点,又没出粗筛圆(deckOuterRadius + radius×√2)
    park(e, hull + def.radius + 4, 0);
    e.hitCd = 0;
    w.step();
    expect(classifyHit(w.ship, w.deck, e.x, e.y, def.radius)).toBe(HIT_NONE);
    expect(w.contacts).toContain(e);
    expect(w.ship.hp).toBe(full);
    expect(fxKinds(w)).not.toContain(FXV_HULL_HIT);
  });

  it('无敌帧:同一只敌人贴着船,每 enemyHitInterval 才咬得动一口(一次接触只结算一次)', () => {
    const w = hullWorld(53);
    park(w.enemies.items[0]!, 0, 0);
    const def = ENEMIES[KIND_SWARM]!;
    const full = w.ship.hp;

    // 逐帧记下"第几帧掉的血":间隔本身就是验收标准第一条要的那个读数
    const hits: number[] = [];
    let hp = full;
    for (let f = 0; f < frames(2); f++) {
      w.step();
      if (w.ship.hp < hp) {
        hits.push(f);
        hp = w.ship.hp;
      }
    }
    expect(hits.length).toBeGreaterThanOrEqual(3); // 非空过:这 2s 里真被咬了好几口
    for (let i = 1; i < hits.length; i++) {
      // 一帧一跳的话这里全是 1 —— 贴脸就是瞬杀,而 GDD §4.6 要的是一条可读的掉血曲线
      expect(hits[i]! - hits[i - 1]!).toBeGreaterThanOrEqual(frames(tuning.enemyHitInterval));
    }
    expect(w.ship.hp).toBe(full - def.contactDamage * hits.length);
    // 火花与伤害共用同一个冷却 ⇒ 每只敌人每 interval 最多产出一个事件,蜂群贴脸也刷不爆 fx 池
    expect(w.fx.size).toBeLessThanOrEqual(1);
  });

  it('无敌帧的节拍:两口之间恰好一个冷却那么多帧,n 帧里共 ⌈n / 冷却帧数⌉ 口', () => {
    const w = hullWorld(55);
    const e = w.enemies.items[0]!;
    const def = ENEMIES[KIND_SWARM]!;
    park(e, 0, 0);
    const full = w.ship.hp;

    const n = frames(2);
    const hits: number[] = [];
    let hp = full;
    for (let f = 0; f < n; f++) {
      w.step();
      if (w.ship.hp < hp) {
        hits.push(f);
        hp = w.ship.hp;
      }
    }

    const period = cooldownFrames(tuning.enemyHitInterval);
    // 第一口在**第一帧**就咬:initEnemy 起手 hitCd = 0(理由见那里的注释),
    // 于是"贴着不动 n 帧"的掉血口数有一个闭式:⌈n / 冷却帧数⌉ —— 验收标准第一条要的就是这个读数
    expect(hits[0]).toBe(0);
    expect(hits.length).toBe(Math.ceil(n / period));
    // 间隔恰好等于冷却帧数、**一帧不多**:hitCd 的递减排在敌人循环里、结算之前,
    // 挪到结算之后的话每一口都要白等一帧(period + 1)。这条断言就是那个顺序的守门人 ——
    // 上面那条只钉"不短于一个间隔",漏一帧它照样绿
    for (let i = 1; i < hits.length; i++) expect(hits[i]! - hits[i - 1]!).toBe(period);
    expect(w.ship.hp).toBe(full - def.contactDamage * hits.length);
  });

  it('冷却递减挂在敌人循环里:飞离船体的那几帧照样在走,回来不留陈旧冷却', () => {
    const w = hullWorld(56);
    const e = w.enemies.items[0]!;
    const def = ENEMIES[KIND_SWARM]!;
    park(e, 0, 0);
    w.step();
    expect(e.hitCd).toBe(tuning.enemyHitInterval); // 咬了一口,冷却满上

    // 退到粗筛圈外待着:这几帧它连 contacts 都进不去 —— 递减若挂在结算里,这段时间一帧都不走
    park(e, 900, 0);
    for (let f = 0; f < cooldownFrames(tuning.enemyHitInterval); f++) w.step();
    expect(w.contacts.length).toBe(0);
    expect(e.hitCd).toBe(0);

    // 贴回来当帧就咬得动。玩家侧的语义是"躲开这一下再压上去,伤害照常结算",
    // 而不是"离开期间攒下一笔陈旧冷却,回来还得白站半秒"
    const hp = w.ship.hp;
    park(e, 0, 0);
    w.step();
    expect(w.ship.hp).toBe(hp - def.contactDamage);
  });

  it('蜂群贴脸:掉血 = 只数 × 单口伤害 × 全局倍率 × 口数,两根旋钮各自线性可调', () => {
    const n = frames(3);
    const one = swarmHpLoss(61, 1, n);
    expect(one).toBe(swarmRate(1, n));

    // 二十只压上来:**每只各带一份无敌帧** ⇒ 速率按只数线性涨。
    // 全船共用一个冷却的话,这一行会与上面那只单打独斗的一模一样 —— 蜂群也就不成其为压力
    const many = swarmHpLoss(62, 20, n);
    expect(many).toBe(swarmRate(20, n));
    expect(many).toBe(20 * one);

    // 旋钮一:全局撞击倍率。蜂群贴脸太疼(或太不疼)时先拖它,不必去动数值表里每一型的 contactDamage
    tuning.enemyContactDamageScale = 2.5;
    const scaled = swarmHpLoss(63, 20, n);
    expect(scaled).toBe(swarmRate(20, n));
    expect(scaled).toBe(2.5 * many);

    // 旋钮二:无敌帧间隔。GDD 没写这个数,但它才是"一帧一跳的瞬杀"与"可读的掉血曲线"之间的那根杆 ——
    // 拉长一倍,同一群人磨出来的血就少一截(⌈n/周期⌉,不是精确的一半)
    tuning.enemyContactDamageScale = 1;
    tuning.enemyHitInterval *= 2;
    const slower = swarmHpLoss(64, 20, n);
    expect(slower).toBe(swarmRate(20, n));
    expect(slower).toBeLessThan(many);
  });

  it('结算排在子弹之后:本帧刚被打死的敌人不许再咬一口', () => {
    const w = hullWorld(54);
    const e = w.enemies.items[0]!;
    park(e, 0, 0);
    const full = w.ship.hp;

    expect(w.damageEnemy(e, 9999)).toBe(true); // 尸体整帧都还在池里,也照旧进得了粗筛名单
    w.step();
    expect(w.contacts).toContain(e);
    expect(w.ship.hp).toBe(full);
    expect(w.kills).toBe(1);
  });

  it('射速惩罚接线:被撞舷的塔在惩罚期内确实打得更慢(逐塔归属在 damage.cellFireRateMul)', () => {
    /** 开一炮,返回那一发之后的冷却 = 下一发要等多久 */
    const shoot = (hit: boolean): number => {
      const w = firingWorld(74, 1);
      parkAt(w, w.enemies.items[0]!, 0, 150);
      if (hit) w.damageShip(1, 100, 0); // 船头朝 +X ⇒ 这一下撞的是 BOW,正是那座塔的暴露边
      w.step();
      expect(w.bullets.size).toBe(1); // 两边都真的开了火,比的才是同一件事
      return cellAt(w.deck, BOW_COL, BOW_ROW)!.cooldown;
    };
    // 接线断了的话两边一模一样:stepTurrets 收不到 edgePenalty,整条惩罚链路在游戏里就是死的
    expect(shoot(true)).toBeGreaterThan(shoot(false));
  });

  it('ship.hp / edgePenalty / hitCd 进 checksum;maxHp 与 shipDead 是派生量,不进', () => {
    tuning.stressEnemies = 6;
    const a = new World(66);
    const b = new World(66);
    for (let f = 0; f < 30; f++) {
      a.step();
      b.step();
    }
    expect(a.checksum()).toBe(b.checksum());

    // hp:漏了它,"撞击没结算""擦碰也扣了血"这两类回归会从确定性口径下漏掉
    const hp = a.ship.hp;
    a.ship.hp -= 1;
    expect(a.checksum()).not.toBe(b.checksum());
    a.ship.hp = hp;
    expect(a.checksum()).toBe(b.checksum());

    // 四舷各自独立进哈希:任何一舷单独动一下都得分叉,否则"某一舷的惩罚早退了一帧"看不出来
    for (let e = 0; e < EDGE_COUNT; e++) {
      a.edgePenalty[e] = 0.1;
      expect(a.checksum()).not.toBe(b.checksum());
      a.edgePenalty[e] = 0;
      expect(a.checksum()).toBe(b.checksum());
    }

    // 无敌帧剩余秒:它决定"这一口该不该咬",× 100 之后才抓得住一两帧的差别
    const victim = a.enemies.items[0]!;
    victim.hitCd = 0.25;
    expect(a.checksum()).not.toBe(b.checksum());
    victim.hitCd = 0;
    expect(a.checksum()).toBe(b.checksum());

    // 派生量一律不进:maxHp 由甲板定(甲板本身逐格哈过了),shipDead 由 hp 定 ——
    // 哈它们只是把同一件事哈两遍
    const before = a.checksum();
    a.ship.maxHp += 15;
    a.shipDead = true;
    expect(a.checksum()).toBe(before);
  });

  it('撞击真的会让两个同 seed 世界分叉:只给一边喂一口,补上同一口又合流', () => {
    tuning.stressEnemies = 8;
    const a = new World(67);
    const b = new World(67);
    for (let f = 0; f < 30; f++) {
      a.step();
      b.step();
    }
    expect(a.checksum()).toBe(b.checksum());

    expect(a.damageShip(7, a.ship.x + 100, a.ship.y)).toBe(true);
    expect(a.checksum()).not.toBe(b.checksum());
    expect(b.damageShip(7, b.ship.x + 100, b.ship.y)).toBe(true);
    expect(a.checksum()).toBe(b.checksum());
  });
});

describe('死亡回收与掉落挂钩(07 号 T3)', () => {
  it('damageEnemy 只标记不出池,step 末尾统一回收并累加 kills', () => {
    onlyKind(KIND_SWARM);
    tuning.stressEnemies = 5;
    const w = new World(8);
    w.step();
    const victim = w.enemies.items[0]!;

    expect(w.damageEnemy(victim, victim.hp)).toBe(true);
    // 标记 ≠ 出池:05 号 issue 的塔不必知道对象在池里的下标,也不会把别人的遍历搅乱
    expect(w.enemies.size).toBe(5);
    expect(w.kills).toBe(0);

    w.step();
    expect(w.enemies.size).toBe(4);
    expect(w.kills).toBe(1);
    expect(w.enemies.items).not.toContain(victim);
  });

  it('挂钩在回池前触发,回调里拿得到坐标与型号(10 号 issue 的残骸掉落点)', () => {
    onlyKind(KIND_BEETLE);
    tuning.stressEnemies = 3;
    const w = new World(19);
    w.step();
    const victim = w.enemies.items[0]!;
    const at = { x: 0, y: 0, kind: -1, hits: 0 };
    w.onEnemyDeath = (e) => {
      at.x = e.x;
      at.y = e.y;
      at.kind = e.kind;
      at.hits++;
    };

    w.damageEnemy(victim, 9999);
    const x = victim.x;
    const y = victim.y;
    w.step(); // 尸体在本帧仍被推进(它整帧都还在场),所以坐标对着回收那一刻取

    expect(at.hits).toBe(1);
    expect(at.kind).toBe(KIND_BEETLE);
    expect(Math.hypot(at.x - x, at.y - y)).toBeLessThan(20); // 就在它倒下的地方,不是 (0,0)
  });

  it('同一帧打死一片(含末尾与相邻)一个不漏 —— 倒序回收才躲得开 swap-remove 的下标坑', () => {
    onlyKind(KIND_SWARM);
    tuning.stressEnemies = 8;
    const w = new World(23);
    w.step();

    const all = [...w.enemies.items];
    const doomed = [all[0]!, all[5]!, all[6]!, all[7]!]; // 相邻三只 + 末尾:正序回收必漏
    const survivors = all.filter((e) => !doomed.includes(e));
    for (const e of doomed) w.damageEnemy(e, 9999);

    const dropped: Enemy[] = [];
    w.onEnemyDeath = (e) => dropped.push(e);
    w.step();

    expect(w.kills).toBe(4);
    expect(dropped.length).toBe(4);
    expect(new Set(dropped)).toEqual(new Set(doomed));
    expect(w.enemies.size).toBe(4);
    expect(new Set(w.enemies.items)).toEqual(new Set(survivors)); // 活人一个没被误伤
  });

  it('同帧重复致命只算一次击杀(10 号的掉落不会按命中数重复给)', () => {
    onlyKind(KIND_SWARM);
    tuning.stressEnemies = 4;
    const w = new World(24);
    w.step();
    const victim = w.enemies.items[0]!;

    expect(w.damageEnemy(victim, 9999)).toBe(true);
    expect(w.damageEnemy(victim, 9999)).toBe(false);
    let hits = 0;
    w.onEnemyDeath = () => hits++;
    w.step();
    expect(w.kills).toBe(1);
    expect(hits).toBe(1);
  });

  it('回收进池的对象在下一次出怪时被复用(运行期零新增分配的可观测形式)', () => {
    onlyKind(KIND_SWARM);
    tuning.stressEnemies = 6;
    const w = new World(26);
    w.step();

    const doomed = new Set([w.enemies.items[1]!, w.enemies.items[3]!, w.enemies.items[5]!]);
    let hits = 0;
    w.onEnemyDeath = () => hits++;
    for (const e of doomed) expect(w.damageEnemy(e, 9999)).toBe(true);

    w.step(); // 帧尾回收:挂钩响三次,场上一具尸体都不许留
    expect(hits).toBe(3);
    expect(w.kills).toBe(3);
    expect(w.enemies.size).toBe(3);
    for (const e of w.enemies.items) {
      expect(e.dead).toBe(false);
      expect(doomed.has(e)).toBe(false);
    }

    w.step(); // 下一帧帧首按 stressEnemies 补回三只
    expect(w.enemies.size).toBe(6);
    // 补出来的正是刚回收的那三个对象(池是后进先出),没有 new 出新的 —— 这就是"回收进池"的证据
    const reused = w.enemies.items.filter((e) => doomed.has(e));
    expect(reused.length).toBe(3);
    for (const e of reused) {
      // 复用前走了 resetEnemy + initEnemy:上一条命的死亡标记没被带过来
      //(带过来的话它一出生就会被当尸体回收,场上人数会诡异地少一只)
      expect(e.dead).toBe(false);
      expect(e.state).toBe(ST_APPROACH);
      expect(e.hp).toBe(e.maxHp);
      expect(e.hp).toBeGreaterThan(0);
    }
  });

  it('没打死的不回收;面板清场也不算击杀、不掉落', () => {
    onlyKind(KIND_SWARM);
    tuning.stressEnemies = 6;
    const w = new World(25);
    w.step();
    let hits = 0;
    w.onEnemyDeath = () => hits++;

    expect(w.damageEnemy(w.enemies.items[0]!, 1)).toBe(false); // 蜂群蛭 8 血,挨一下死不了
    w.step();
    expect(w.enemies.size).toBe(6);

    tuning.stressEnemies = 2; // 面板拖数量 = 清场,不是打死的
    w.step();
    expect(w.enemies.size).toBe(2);
    expect(w.kills).toBe(0);
    expect(hits).toBe(0);
    expect(w.drops.size).toBe(0); // 清场走的是池的 despawnAt,压根不经过 reap,自然也不掉残骸
  });
});

/**
 * 残骸掉落与磁吸拾取的**世界接线**(10 号 T1)。
 * 磁吸本身的每一条规则(起吸含边界 / 锁定了就不放手 / 匀速直追船心 / 收取判在本帧新位置)
 * 在 drop.test.ts 钉 —— 那边连 World 都不造,喂一个池 + 一块甲板 + 一对船心坐标就够。
 * 这里只钉世界才知道的那几件事:谁掉的、掉在哪、掉多少、掉落与公开挂钩谁先谁后、
 * 收到的那笔账进了谁的兜,以及这一整套有没有把确定性(尤其是出怪的随机序列)搅坏。
 */
describe('残骸掉落接线(10 号 T1:死了掉残骸,磁吸收进 scrap)', () => {
  it('死者当场掉一颗:就掉在它倒下的地方,面额 = 数值表里那一型的 scrap', () => {
    onlyKind(KIND_BEETLE);
    tuning.stressEnemies = 3;
    const w = new World(31);
    w.step();
    expect(w.drops.size).toBe(0); // 还没死过人:一颗残骸都不该凭空出现

    const victim = w.enemies.items[0]!;
    w.damageEnemy(victim, 9999);
    w.step(); // 掉落发生在帧尾的 reap(尸体本帧仍被推进,故坐标对着回收那一刻取)

    expect(w.drops.size).toBe(1);
    const d = w.drops.items[0]!;
    // 出池不清字段(pool 的 reset 在 spawn 时才走),故 victim 身上留着的正是它倒下的坐标
    expect(d.x).toBe(victim.x);
    expect(d.y).toBe(victim.y);
    expect(d.px).toBe(d.x); // px/py 起手 = 当前位置:它还没动过(铁律 2 的两端)
    expect(d.py).toBe(d.y);
    expect(d.value).toBe(ENEMIES[KIND_BEETLE]!.scrap);
    // 出生环在几百 px 外:不该一出生就被吸住,速度也该是 0(停在尸体上等人来捡)
    expect(d.magnet).toBe(false);
    expect(d.vx).toBe(0);
    expect(d.vy).toBe(0);
  });

  it('掉落排在公开挂钩**之前**,而挂钩接不接都不影响掉落', () => {
    onlyKind(KIND_SWARM);
    tuning.stressEnemies = 2;
    const w = new World(32);
    w.step();
    const seen: number[] = [];
    w.onEnemyDeath = () => seen.push(w.drops.size);

    w.damageEnemy(w.enemies.items[0]!, 9999);
    w.step();
    // 回调进门时残骸已经在池里;挂钩自己的语义一个字没变(回池前、每只恰好响一次)
    expect(seen).toEqual([1]);

    // 摘掉挂钩照样掉:残骸是世界自己的账,不是挂钩的副产品
    w.onEnemyDeath = null;
    w.damageEnemy(w.enemies.items[0]!, 9999);
    w.step();
    expect(w.drops.size).toBe(2);
  });

  it('一片死者一个不漏地各掉一颗,面额各按各的型(混型的一局里残骸不是一口价)', () => {
    tuning.stressEnemies = 40; // 默认混型:四型都出得来(下面那条 Set 断言保证这不是空过)
    const w = new World(33);
    w.step();
    const doomed = [...w.enemies.items];
    const kinds = doomed.map((e) => e.kind);
    const want = kinds.reduce((s, k) => s + ENEMIES[k]!.scrap, 0);
    for (const e of doomed) w.damageEnemy(e, 9999);

    w.step();
    expect(new Set(kinds).size).toBeGreaterThan(1);
    expect(w.drops.size).toBe(doomed.length);
    expect(w.drops.items.reduce((s, d) => s + d.value, 0)).toBe(want);
  });

  it('面额 0 的型不掉:一颗给不了任何东西的残骸只会骗玩家专程绕一趟', () => {
    onlyKind(KIND_SWARM);
    tuning.stressEnemies = 4;
    ENEMIES[KIND_SWARM]!.scrap = 0; // 数值表允许 0(表级不变量只要求非负整数);afterEach 还原
    const w = new World(34);
    w.step();
    let hits = 0;
    w.onEnemyDeath = () => hits++;
    for (const e of [...w.enemies.items]) w.damageEnemy(e, 9999);

    w.step();
    expect(w.drops.size).toBe(0);
    expect(w.scrap).toBe(0);
    expect(hits).toBe(4); // 死照样算死:面额只掐掉残骸,回收与挂钩一概不受影响
    expect(w.kills).toBe(4);
  });

  it('磁吸接线:下一帧才起吸 → 飞过来 → 进 scrap → 颗粒回池被下一颗复用', () => {
    onlyKind(KIND_SWARM);
    tuning.stressEnemies = 1;
    tuning.enemySpeedScale = 0;
    const w = new World(35);
    w.step();
    // 起吸半径(170)之内、收取半径(22)之外:接线对了它就该自己飞完这 78px
    park(w.enemies.items[0]!, w.ship.x + 100, w.ship.y);
    w.damageEnemy(w.enemies.items[0]!, 9999);

    w.step();
    const d = w.drops.items[0]!;
    // 本帧的 stepDrops 排在回收之前 ⇒ 这颗新掉的当帧一步不动(先看见它掉在尸体上,再看见它飞过来)
    expect(d.magnet).toBe(false);
    expect(d.x).toBe(w.ship.x + 100);
    expect(w.scrap).toBe(0);

    w.step();
    expect(d.magnet).toBe(true); // 下一帧才起吸

    for (let f = 0; f < frames(0.5); f++) w.step(); // (100-22)/5px ≈ 16 帧,半秒绰绰有余
    expect(w.drops.size).toBe(0);
    expect(w.scrap).toBe(ENEMIES[KIND_SWARM]!.scrap);
    expect(Number.isInteger(w.scrap)).toBe(true); // 面额是整数,收下时整颗进账,不乘任何系数
    expect(w.drops.spawn()).toBe(d); // 同一个对象:收下的当场回池,没有 new 出新的
  });

  it('在场上限是保险丝:触顶后当帧掉的那一颗直接丢弃、**不留账**(与出怪上限同口径)', () => {
    onlyKind(KIND_SWARM);
    tuning.stressEnemies = 2;
    const w = new World(36);
    w.step();
    // 手工把池灌满(靠真打死 1200 只怪去凑是几万帧的事);摆在起吸半径之外,免得被顺手收走 ——
    // 但得在离场剔除半径(DROP_CULL_RADIUS)之内,不然这一池"占位残骸"当帧就被清光了
    for (let i = 0; i < DROP_MAX_ALIVE; i++) {
      const d = w.drops.spawn();
      d.x = d.px = 500 + (i % 97);
      d.y = d.py = 500;
      d.value = 1;
    }

    let hits = 0;
    w.onEnemyDeath = () => hits++;
    w.damageEnemy(w.enemies.items[0]!, 9999);
    w.step();
    expect(w.drops.size).toBe(DROP_MAX_ALIVE); // 这一颗被丢掉了
    expect(hits).toBe(1); // 死照样算死:上限只掐掉残骸,不改回收与挂钩
    expect(w.kills).toBe(1);

    // 腾出三个名额再死一只:它只掉自己那一颗(1197 → 1198),而不是补发刚才欠下的那一颗 ——
    // 留账的话上限一松就会一口气吐出来,正是"卡了之后更卡"的那条死亡螺旋
    for (let i = 0; i < 3; i++) w.drops.despawnAt(0);
    expect(w.drops.size).toBe(DROP_MAX_ALIVE - 3);
    w.damageEnemy(w.enemies.items[0]!, 9999);
    w.step();
    expect(w.drops.size).toBe(DROP_MAX_ALIVE - 2);
  });

  it('拾取半径改大 → 同一局收到的残骸变多(验收标准第四条的量化版)', () => {
    // 真人拖面板看手感那一半 Node 里量不出来,不在这里假装验过;能量化的是这条因果:
    // 同一个 seed、同一批死者、同一片摊在原地的残骸,只把那根旋钮拖大,收回来的就该更多
    const near = harvest(400);
    const far = harvest(900);

    expect(near.total).toBe(far.total); // 同一局:掉出来的残骸逐颗同位,差别只有那一根旋钮
    // 两头都不是"零"和"全部",否则这条就退化成常识
    expect(near.reach).toBeGreaterThan(0);
    expect(far.reach).toBeLessThan(far.total);
    expect(far.got).toBeGreaterThan(near.got * 2);

    // 闭式:船一步没挪、圈外的残骸一步不动 ⇒ 收到的**恰好**是起吸圈里的那些,
    // 而不是"大概更多一点" —— 这条一旦只剩不等号,磁吸悄悄漏收半圈也照样绿
    expect(near.got).toBe(near.reach);
    expect(far.got).toBe(far.reach);
  });

  it('同 seed 两局:掉落、收取与 scrap 逐位一致(掉落没把确定性搅坏)', () => {
    tuning.dropMagnetRadius = 900; // 拖大到"这一片残骸大半都收得回来",让收取也进这条比对
    const a = scrapField(37, 20);
    const b = scrapField(37, 20);
    for (let f = 0; f < frames(5); f++) {
      a.step();
      b.step();
    }

    expect(a.scrap).toBeGreaterThan(0);
    expect(a.drops.size).toBeGreaterThan(0); // 收干净的话下面这条 checksum 就白比了
    expect(a.scrap).toBe(b.scrap);
    expect(a.drops.size).toBe(b.drops.size);
    expect(a.checksum()).toBe(b.checksum());
  });

  it('残骸位置与 scrap 进 checksum;面额是掉落那一刻定死的常量,不进', () => {
    const a = scrapField(38, 6);
    const b = scrapField(38, 6);
    expect(a.checksum()).toBe(b.checksum());

    // 位置:漏了它,"磁吸把残骸吸歪了""该收的没收走"这类回归会从确定性口径下漏掉
    const d = a.drops.items[0]!;
    const x = d.x;
    d.x += 3;
    expect(a.checksum()).not.toBe(b.checksum());
    d.x = x;
    expect(a.checksum()).toBe(b.checksum());

    // 收到的那笔账单独进哈希:收下的残骸当场出池,不哈它,池空之后就再也看不见多收/漏收
    a.scrap += 1;
    expect(a.checksum()).not.toBe(b.checksum());
    b.scrap += 1;
    expect(a.checksum()).toBe(b.checksum());

    // 面额不进(与子弹的 damage 同口径):掉落那一刻按敌型定死,飞行途中不会变
    const before = a.checksum();
    d.value += 5;
    expect(a.checksum()).toBe(before);
  });

  it('掉落一次 rng 都不掷:一边把怪全打死、一边一只不打,出怪序列与随机流仍逐位一致', () => {
    // 于是"这一局打得好不好"反过来扰动不到出怪(08 验收标准第二条:同 seed 同出怪序列)。
    // 必须走**正式出怪器**:压测那条路死一只补一只,而补人自己就要掷随机,这件事在那里测不出来
    tuning.stressSpawn = false;
    const bornA: number[] = [];
    const bornB: number[] = [];
    const a = new World(39);
    const b = new World(39);
    a.onEnemySpawn = (e) => bornA.push(e.kind, e.x, e.y);
    b.onEnemySpawn = (e) => bornB.push(e.kind, e.x, e.y);

    for (let f = 0; f < frames(10); f++) {
      a.step();
      b.step();
      for (const e of a.enemies.items) a.damageEnemy(e, 9999); // a 这一局每帧清场 = 每帧都在掉残骸
    }

    expect(a.kills).toBeGreaterThan(0);
    expect(b.kills).toBe(0);
    // 每只必掉一颗,而且一颗都没被收走(出怪环在船外 1150px,起吸半径够不着)
    expect(a.drops.size).toBe(a.kills);
    expect(a.scrap).toBe(0);
    expect(bornA.length).toBeGreaterThan(0);
    expect(bornA).toEqual(bornB); // 出怪序列一字不差
    expect(a.rng.next()).toBe(b.rng.next()); // 两条随机流仍站在同一格上
  });
});

describe('邻居分离只在接近段叠加', () => {
  it('冲刺中的敌人不被同伴推离锁定直线(否则前摇画出的预警线就成了谎言)', () => {
    expect(driftUnderPack(ST_DASH)).toBe(0);
  });

  it('对照:同一构型在接近段确实被挤开 —— 上面那条不是"分离力根本没生效"的空过', () => {
    expect(driftUnderPack(ST_APPROACH)).toBeLessThan(-0.5);
  });
});

/**
 * 巡航输入。整局复用同一个指令对象 —— World.step 只读不缓存引用,压测与回放也是这么灌输入的。
 */
const cruiseDir: Vec2 = { x: 1, y: 0 };
const cruiseCmd: ShipCommand = { desiredHeading: cruiseDir };

/**
 * 让船朝 headingDeg 方向持续巡航若干秒。
 * 方向压力的用例一律用**折线机动**(直线腿 + 硬转弯)而不是绕圈:转弯那一下才是考点
 *(敌人得跟着"当前"船头重新排队),直线腿则给它们排回去的时间;绕圈则会因为
 * 尾随蛆比船慢(125 vs 130)而被离心甩开,测出来的是速度差而不是方位逻辑。
 * @param onFrame 每逻辑帧末尾回调:"持续占据"要逐帧采样,只看最后一眼会把巧合当稳态
 */
function cruise(w: World, headingDeg: number, seconds: number, onFrame?: () => void): void {
  const a = headingDeg * DEG2RAD;
  cruiseDir.x = Math.cos(a);
  cruiseDir.y = Math.sin(a);
  for (let f = 0; f < Math.round(seconds * SIM_HZ); f++) {
    w.step(cruiseCmd);
    onFrame?.();
  }
}

/** 船 → 敌方位角(全仓统一口径:atan2(ey - ty, ex - tx)) */
function bearingTo(w: World, x: number, y: number): number {
  return Math.atan2(y - w.ship.y, x - w.ship.x);
}

/**
 * 逐帧盯住每只敌人的状态跃迁,返回一个塞给 cruise 的 onFrame。
 * 拿对象引用当键而不是下标:池的 swap-remove 会把下标换位,按下标记状态会张冠李戴。
 * @param onStep 每帧对每只敌人回调 (敌人, 它上一帧的状态)。新出生的敌人上一帧没有状态,给 undefined
 */
function watchStates(
  w: World,
  onStep: (e: Enemy, prevState: number | undefined) => void,
): () => void {
  const prev = new Map<Enemy, number>();
  return () => {
    for (const e of w.enemies.items) onStep(e, prev.get(e));
    prev.clear();
    for (const e of w.enemies.items) prev.set(e, e.state);
  };
}

/**
 * 炮管用例的靶场夹具。船头正中那一格(3×4 甲板上只有 BOW 一条暴露边)当炮位:
 * 射界中心 = 船头朝向、半角 = 弧度/2,断言里不必再扣掉角落格的 +60°。
 */
const BOW_COL = 1;
const BOW_ROW = 0;
/** 每帧转速上限(度)。拿数值表算而不是写死 6,改了参数也不会悄悄失配 */
const MAX_TURN_DEG = GUN_BASE.turnRate * SIM_DT;
/** 炮位与射界的暂存:与被测代码同口径,复用一份,不在断言里现造对象 */
const gun: Vec2 = { x: 0, y: 0 };
const gunArc: Arc = { center: 0, half: 0 };
/** 甲板半长/半宽的暂存(受击那组摆"贴着甲板四角"的构型用) */
const halfOut: Vec2 = { x: 0, y: 0 };

/**
 * 一个静止靶场:船停在原点、船头朝 **+X**(算方位角时不必再扣掉 createShip 的 -π/2),
 * 船头正中一座塔,场上 count 只蜂群蛭等着调用方 parkAt 摆到位。
 * 敌速倍率归零 = 把敌人钉死在摆好的位置(期望速度整体 ×0,park 之后 v 恒为 0),
 * 于是射界/射程的边界断言算的是什么就是什么,不会被每帧一两 px 的漂移搅掉 ——
 * 本组用例考的是"塔朝哪",不是"敌人往哪走"。
 *
 * **伤害倍率一并归零**(05 号开火落地后的必要一手):塔现在真的会开火,靶子挨两发就没了,
 * 而"转到 25° 就停"这类断言要的是一个一直站在那儿的靶子。零伤害是个可逆、可理解的调试态
 * (口径见 sim/tower.ts 的 effectiveDamage),开火那一组自己把它调回来(见 firingWorld)。
 */
function turretWorld(seed: number, count: number, type: number = TOWER_AUTOCANNON): World {
  onlyKind(KIND_SWARM);
  tuning.stressEnemies = count;
  tuning.enemySpeedScale = 0;
  tuning.towerDamageScale = 0;
  const w = new World(seed);
  w.step(); // 帧首出怪:此后场上恰好 count 只
  expect(w.enemies.size).toBe(count);
  expect(w.ship.x).toBe(0); // 没有输入 → 船一步没挪,炮位算得清
  expect(w.ship.y).toBe(0);
  w.ship.heading = w.ship.pheading = 0;
  expect(w.place(BOW_COL, BOW_ROW, CELL_WEAPON, type)).toBe(PLACE_OK);
  return w;
}

/** 同一个靶场,但伤害照常结算 —— 开火那一组正要看谁掉了血 */
function firingWorld(seed: number, count: number, type: number = TOWER_AUTOCANNON): World {
  const w = turretWorld(seed, count, type);
  tuning.towerDamageScale = 1;
  return w;
}

/** 船头与左舷各一座塔:两座塔的射界互不重叠,checksum 里就有两条独立演化的偏角 */
function armedWorld(seed: number): World {
  const w = new World(seed);
  expect(w.place(BOW_COL, BOW_ROW, CELL_WEAPON)).toBe(PLACE_OK);
  expect(w.place(0, 2, CELL_WEAPON)).toBe(PLACE_OK);
  return w;
}

/** 炮位 = 格心的世界坐标(**不是船心**:舷侧塔与船心差着大半个船长) */
function gunPos(w: World): Vec2 {
  return cellWorldPos(w.deck, w.ship, BOW_COL, BOW_ROW, gun);
}

/** 某点离炮口多远。射程判定的口径就是这一条,断言照抄它才不会各算各的 */
function distToGun(w: World, x: number, y: number): number {
  gunPos(w);
  return Math.hypot(x - gun.x, y - gun.y);
}

/** 把敌人钉在"离炮口 dist、方位 bearingDeg"处 —— 用例想说的永远是"偏 25°、200 远",不是两个坐标 */
function parkAt(w: World, e: Enemy, bearingDeg: number, dist: number): void {
  gunPos(w);
  const a = bearingDeg * DEG2RAD;
  park(e, gun.x + Math.cos(a) * dist, gun.y + Math.sin(a) * dist);
}

/**
 * 炮口的世界朝向(度)= 射界中心 + 相对偏角 —— sim/deck 对 turretOffset 的定义就是这一句。
 * 断言比"世界朝向"而不是比 offset:后者与射界中心一起变,换一格炮位就得重算一遍期望值。
 */
function aimDeg(w: World): number {
  const cell = cellAt(w.deck, BOW_COL, BOW_ROW)!;
  expect(cellArc(cell, w.ship.heading, GUN.arcDeg, gunArc)).toBe(true);
  return wrapAngle(gunArc.center + cell.turretOffset) / DEG2RAD;
}

/**
 * 粗筛圆半径 = 甲板外接圆 + 体型 ×√2 —— 与 world.ts 敌人循环里那一句同一条式子。
 * 断言照抄被测代码的口径,而不是自己再推一个:两处走散时该红的是这条式子,不是某个坐标。
 * √2 的理由见 world.ts:精筛把矩形按体型两轴各外扩,那个盒子的角比 R + r 还远。
 */
function coarseRadius(kind: number, w: World): number {
  return deckOuterRadius(w.deck) + ENEMIES[kind]!.radius * Math.SQRT2;
}

/** 秒 → 逻辑帧数。受击那组的计时断言一律用它,免得把 30 这种数写死在用例里 */
function frames(seconds: number): number {
  return Math.round(seconds * SIM_HZ);
}

/**
 * 无敌帧跑完要几逻辑帧 —— 照抄 world 敌人循环那句累减(逐帧减 SIM_DT、夹 0)。
 * **不写成 interval / SIM_DT**:浮点累减未必落在整数帧上(0.5s 要 31 帧而不是 30),
 * 而这组用例钉的恰恰是"两口之间一帧不多一帧不少" —— 拿理想值当期望,断言就得放宽成 ±1 帧,
 * 而那一帧正是"递减排在结算之前还是之后"的全部差别。
 */
function cooldownFrames(seconds: number): number {
  let left = seconds;
  let n = 0;
  while (left > 0) {
    left = Math.max(0, left - SIM_DT);
    n++;
  }
  return n;
}

/** 本帧在场的可视化事件种类。受击那组只关心"出没出、出的是哪一种" */
function fxKinds(w: World): number[] {
  return w.fx.items.map((e) => e.kind);
}

/**
 * 蜂群贴脸的掉血读数:count 只蜂群蛭全压在船心(核心区),跑 n 帧,返回这段时间掉了多少血。
 * 敌速倍率归零把它们钉在原地 —— 这条用例考的是掉血速率,不是它们往哪走。
 *
 * HP 上限临时抬到扛得完整段(World 构造时读一次,故必须在 new World **之前**拖;BASE 会还原):
 * 血一旦夹到 0,读到的就不再是"速率"而是"扣光了",而这里要的正是那条速率曲线。
 */
function swarmHpLoss(seed: number, count: number, n: number): number {
  onlyKind(KIND_SWARM);
  tuning.stressEnemies = count;
  tuning.enemySpeedScale = 0;
  tuning.shipHullHp = 1e6;
  const w = new World(seed);
  w.step(); // 帧首出怪:此后场上恰好 count 只(出生环在船外几百 px,这一帧还咬不着)
  expect(w.enemies.size).toBe(count);
  for (const e of w.enemies.items) park(e, w.ship.x, w.ship.y);

  const full = w.ship.hp;
  for (let f = 0; f < n; f++) w.step();
  expect(w.shipDead).toBe(false); // 没扣光:读数才还是速率
  return full - w.ship.hp;
}

/**
 * 上面那个读数的闭式:只数 × 单口伤害 × 全局倍率 × 口数,口数 = ⌈n / 冷却帧数⌉(第一口在第一帧就咬)。
 * 现读 tuning 而不是收参数:这条式子里的每一项都是面板上的一根旋钮,
 * "蜂群贴脸掉血速率可控可调"(验收标准第一条)说的就是它们各自线性、互不纠缠。
 */
function swarmRate(count: number, n: number): number {
  const bites = Math.ceil(n / cooldownFrames(tuning.enemyHitInterval));
  return count * ENEMIES[KIND_SWARM]!.contactDamage * tuning.enemyContactDamageScale * bites;
}

/**
 * 受击结算用的靶场:船停在原点、船头朝 **+X**(四舷的方位一眼可读),场上一只蜂群蛭,
 * 敌速倍率归零把它钉在调用方 park 的位置上 —— 这组用例考的是"撞在哪一层",不是它往哪走。
 * 一座塔都不放:塔一开火就会把靶子打死,而这里要的是一只一直贴在船上的敌人。
 */
function hullWorld(seed: number): World {
  onlyKind(KIND_SWARM);
  tuning.stressEnemies = 1;
  tuning.enemySpeedScale = 0;
  const w = new World(seed);
  w.step(); // 帧首出怪:此后场上恰好一只
  expect(w.enemies.size).toBe(1);
  w.ship.heading = w.ship.pheading = 0;
  return w;
}

/**
 * 一片摊在船周围的残骸:场上 count 只蜂群蛭当场全打死,残骸就掉在它们各自倒下的地方。
 * 敌速倍率归零把它们钉在出生环上(半径 300..1200,由 seed 定死),于是同一个 seed 的两局
 * 掉出来的残骸逐颗同位 —— 拾取半径的对比才是"同一局只改一根旋钮",而不是两局不同的运气。
 * 打完把在场数拖到 0:这几条用例考的是"这一片残骸能收回来多少",不是"又来了多少怪"。
 */
function scrapField(seed: number, count: number): World {
  onlyKind(KIND_SWARM);
  tuning.stressEnemies = count;
  tuning.enemySpeedScale = 0;
  const w = new World(seed);
  w.step(); // 帧首出怪:此后场上恰好 count 只
  expect(w.enemies.size).toBe(count);
  for (const e of w.enemies.items) w.damageEnemy(e, 9999);
  w.step(); // 帧尾回收 = 掉落(本帧的 stepDrops 排在回收之前,故它们当帧还没动过)
  expect(w.drops.size).toBe(count);
  tuning.stressEnemies = 0; // 这一局不再补人
  return w;
}

/**
 * 把上面那片残骸按给定起吸半径收一轮(5 秒 = 300 帧,够最远那颗 900px 的以 300px/s 飞完)。
 * @returns got = 实际收到的总量;reach = 起吸圈里本来就有多少;total = 这一片一共有多少
 */
function harvest(radius: number): { got: number; reach: number; total: number } {
  const w = scrapField(31, 40);
  tuning.dropMagnetRadius = radius;

  let reach = 0;
  let total = 0;
  for (const d of w.drops.items) {
    total += d.value;
    if (Math.hypot(d.x - w.ship.x, d.y - w.ship.y) <= radius) reach += d.value;
  }

  for (let f = 0; f < frames(5); f++) w.step();
  // 船一步没挪(整局没有输入),这正是上面那个闭式的前提:圈外的残骸永远够不着
  expect(w.ship.x).toBe(0);
  expect(w.ship.y).toBe(0);
  return { got: w.scrap, reach, total };
}

/** 把敌人钉在某处并清速度:构造判定用的确定构型,免得被上一帧的惯性带走 */
function park(e: Enemy, x: number, y: number): void {
  e.x = e.px = x;
  e.y = e.py = y;
  e.vx = 0;
  e.vy = 0;
}

/**
 * 让一只甲虫沿 +X 走,同伴全压在它的 +Y 侧:分离力若参与,它必然被推出 -Y。
 * @returns 若干帧后的横向位移(负 = 被挤开了)
 */
function driftUnderPack(state: number): number {
  onlyKind(KIND_SWARM);
  tuning.stressEnemies = 6;
  const w = new World(21);
  w.step();
  // 船摆在正 +X 的场边:接近段的期望速度也沿 +X,于是横向位移只可能来自分离力
  w.ship.x = 1200;
  w.ship.y = 0;

  const items = w.enemies.items;
  const charger = items[0]!;
  charger.kind = KIND_BEETLE;
  park(charger, 0, 0);
  charger.state = state;
  charger.timer = 5; // 够跑完下面这几帧,中途不会转到硬直
  charger.lockX = 1;
  charger.lockY = 0;
  charger.vx = ENEMIES[KIND_BEETLE]!.chargeSpeed;

  for (let f = 0; f < 10; f++) {
    // 每帧把同伴重新贴回来:冲刺的比同伴快得多,不重摆的话第二帧就没人挤得到它了
    for (let i = 1; i < items.length; i++) park(items[i]!, charger.x, charger.y + 4 + i);
    w.step();
  }
  expect(charger.state).toBe(state); // 状态没被状态机带走,这十帧钉的确实是同一个分支
  expect(charger.x).toBeGreaterThan(0); // 它确实在往前走,不是原地不动才"没漂移"
  return charger.y;
}

/**
 * 精英与词缀接线(14 号)。规则本身(HP/体型放大、词缀位掩码)在 enemy.test.ts 钉,
 * 这里钉**世界这一层**:波次脚本的精英事件真的带着词缀出生、四种词缀的效果各走一遍、
 * 精英死亡必掉 3× 残骸、裂变分裂复用池且不掷随机,以及整套东西进 checksum。
 *
 * 一律用 splice 进来的短脚本(与 waves.test.ts / 上面的波次 describe 同口径):
 * 精英事件只由 at 与脚本决定,短脚本里 at=0 第一帧就触发,断言不必等 40 秒。
 */
describe('精英与词缀接线(14 号:affixes 落地、四效果、掉落与确定性)', () => {
  /** 真脚本原样留一份:每个用例都会换成短脚本,跑完必须还原 */
  const REAL = WAVE_SEGMENTS.slice();
  afterEach(() => {
    WAVE_SEGMENTS.splice(0, WAVE_SEGMENTS.length, ...REAL);
  });

  function useScript(...segs: WaveSegment[]): void {
    tuning.stressSpawn = false;
    WAVE_SEGMENTS.splice(0, WAVE_SEGMENTS.length, ...segs);
  }

  function segment(p: Partial<WaveSegment> = {}): WaveSegment {
    return {
      name: 'seg',
      duration: 60,
      dirStartDeg: 0,
      dirEndDeg: 0,
      streams: [],
      bursts: [],
      elites: [],
      ...p,
    };
  }

  /** 只出精英的脚本:场上第一帧就恰好 count 只精英,断言不受普通流干扰 */
  function eliteScript(affixes: number[], kind: number = KIND_SWARM, count = 1): void {
    useScript(segment({ elites: [{ at: 0, kind, count, affixes }] }));
  }

  it('波次脚本的精英事件真的带词缀出生:affixes 落成位掩码、HP/体型按 ELITE 放大', () => {
    eliteScript([AFFIX_FRENZY, AFFIX_ARMORED], KIND_BEETLE);
    const w = new World(50);
    w.step();
    expect(w.enemies.size).toBe(1);
    const e = w.enemies.items[0]!;
    expect(e.affixes).toBe(affixMask([AFFIX_FRENZY, AFFIX_ARMORED]));
    // HP = 基础 × 时间缩放(第一帧,elapsed = SIM_DT)× ELITE.hpMul;出生环在船外,挨不着任何东西
    expect(e.hp).toBeCloseTo(ENEMIES[KIND_BEETLE]!.hp * hpScaleAt(w.elapsed) * ELITE.hpMul, 9);
    expect(e.maxHp).toBe(e.hp);
  });

  it('狂热光环:半径内**其他**敌人加速 ×frenzySpeedMul,圈外不加速、本体不自加速(查询走空间哈希)', () => {
    eliteScript([AFFIX_FRENZY], KIND_SWARM);
    const w = new World(51);
    w.step();
    const carrier = w.enemies.items[0]!;
    expect(hasAffix(carrier, AFFIX_FRENZY)).toBe(true);

    // 手动补三只普通怪:一只在光环半径内、两只在圈外(全仓的 park 口径:钉死 + 清速度)。
    // 携带者第一帧已经攒下一小截速度,也 park 一次清零 —— 断言的是"这一帧被不被光环加成",
    // 不是"它上一帧的速度还在不在"
    // 注意圈外两只要分别覆盖两种漏网场景:同轴 450(离圆但离方形也远)与对角 (300,300)
    // (√(300²+300²)≈424 > 400,落在 AABB 方形之内、光环圆之外 —— 旧实现在这里误加速)。
    const inside = w.enemies.spawn();
    const outside = w.enemies.spawn();
    const corner = w.enemies.spawn();
    park(inside, carrier.x + 100, carrier.y); // 100 < 400:圈内
    park(outside, carrier.x + 450, carrier.y); // 450 > 400:圈外(同轴)
    park(corner, carrier.x + 300, carrier.y + 300); // ≈424 > 400:圈外(AABB 角落)
    park(carrier, carrier.x, carrier.y);

    w.step();
    const def = ENEMIES[KIND_SWARM]!;
    const follow = Math.min(1, def.accel * SIM_DT);
    const mul = AFFIXES[AFFIX_FRENZY]!.frenzySpeedMul;
    // 第一帧:v = desired × follow(追随系数),desired = 基础速度 × 光环倍率
    expect(Math.hypot(inside.vx, inside.vy)).toBeCloseTo(def.speed * mul * follow, 9);
    expect(Math.hypot(outside.vx, outside.vy)).toBeCloseTo(def.speed * follow, 9);
    expect(Math.hypot(corner.vx, corner.vy)).toBeCloseTo(def.speed * follow, 9); // 对角圈外:不加速
    expect(Math.hypot(carrier.vx, carrier.vy)).toBeCloseTo(def.speed * follow, 9); // 本体不自加速
  });

  it('磁力干扰:携带者在场时拾取半径 ×pickupMul,死亡后当帧的下一帧恢复原半径', () => {
    eliteScript([AFFIX_MAGNETIC], KIND_SWARM);
    const w = new World(53);
    w.step();
    const half = tuning.dropMagnetRadius * AFFIXES[AFFIX_MAGNETIC]!.pickupMul;
    const dropAt = (x: number): Drop => {
      const d = w.drops.spawn();
      d.x = d.px = x;
      d.y = d.py = 0;
      d.value = 1;
      return d;
    };
    const inside = dropAt(half - 1); // 半半径之内:干扰下照样吸
    const between = dropAt(half + 5); // 半半径与全半径之间:干扰下吸不了

    w.step();
    expect(inside.magnet).toBe(true);
    expect(between.magnet).toBe(false);

    expect(w.damageEnemy(w.enemies.items[0]!, 9999)).toBe(true);
    w.step(); // 结算排在回收前:本帧磁吸仍受干扰(尸体整帧还在场)
    expect(between.magnet).toBe(false);

    w.step(); // 干扰源已回池:拾取半径恢复 170,这颗落回圈内
    expect(between.magnet).toBe(true);
    expect(inside.magnet).toBe(true); // 已锁定的不因干扰消失而松手(锁定单向)
  });

  it('装甲/相位:伤害按节流系减半(弹药 ×ballisticMul、能量 ×energyMul),只对词缀本体生效', () => {
    eliteScript([AFFIX_ARMORED, AFFIX_PHASED], KIND_SWARM);
    const w = new World(54);
    w.step();
    const elite = w.enemies.items[0]!;
    const normal = w.enemies.spawn();
    initEnemy(normal, KIND_SWARM, 100, 100, w.elapsed, w.rng); // 普通怪对照
    expect(normal.affixes).toBe(0);

    const A = AFFIXES[AFFIX_ARMORED]!;
    const P = AFFIXES[AFFIX_PHASED]!;
    // 单发 2 伤:精英(24 血)扛得住连续六发,断言不会被"打死了"这条岔路带跑
    let hp = elite.hp;
    // 弹药系(机炮/点防):装甲减半
    expect(w.damageEnemy(elite, 2, THR_AMMO)).toBe(false);
    expect(elite.hp).toBeCloseTo(hp - 2 * A.ballisticMul, 9);
    // 能量系(过热:激光/电弧):相位减半
    hp = elite.hp;
    expect(w.damageEnemy(elite, 2, THR_HEAT)).toBe(false);
    expect(elite.hp).toBeCloseTo(hp - 2 * P.energyMul, 9);
    // 能量系(充能:磁轨/迫击炮):同样是相位减半
    hp = elite.hp;
    expect(w.damageEnemy(elite, 2, THR_CHARGE)).toBe(false);
    expect(elite.hp).toBeCloseTo(hp - 2 * P.energyMul, 9);
    // 不传节流 = 既有调用方语义:不抗
    hp = elite.hp;
    expect(w.damageEnemy(elite, 2)).toBe(false);
    expect(elite.hp).toBeCloseTo(hp - 2, 9);

    // 普通怪:同样一记弹药系,全伤(词缀只挂在词缀本体上,不传染)
    hp = normal.hp;
    expect(w.damageEnemy(normal, 2, THR_AMMO)).toBe(false);
    expect(normal.hp).toBeCloseTo(hp - 2, 9);
  });

  it('抗性接线走真开火路径:机炮(弹药系)打装甲精英每发减半,激光(能量系)打相位精英每发减半', () => {
    // —— 机炮 vs 装甲精英 ——
    eliteScript([AFFIX_ARMORED], KIND_SWARM);
    const gun = new World(56);
    gun.step();
    expect(gun.place(BOW_COL, BOW_ROW, CELL_WEAPON)).toBe(PLACE_OK); // 自动机炮 THR_AMMO
    gun.ship.heading = gun.ship.pheading = 0;
    park(gun.enemies.items[0]!, gun.ship.x + 150, gun.ship.y);
    tuning.enemySpeedScale = 0; // 靶子钉死:断言的是伤害,不是它往哪走

    const hp0 = gun.enemies.items[0]!.hp;
    gun.step(); // 起手冷却 0 → 当帧开火
    expect(gun.bullets.size).toBe(1);
    for (let f = 0; f < 120 && gun.enemies.items[0]!.hp === hp0; f++) gun.step(); // 等弹飞到
    expect(gun.enemies.items[0]!.hp).toBeCloseTo(
      hp0 - TOWERS[TOWER_AUTOCANNON]!.damage * AFFIXES[AFFIX_ARMORED]!.ballisticMul,
      9,
    );

    // —— 激光 vs 相位精英 ——
    tuning.enemySpeedScale = 0;
    eliteScript([AFFIX_PHASED], KIND_SWARM);
    const laser = new World(56);
    laser.step();
    expect(laser.place(BOW_COL, BOW_ROW, CELL_WEAPON, TOWER_LASER)).toBe(PLACE_OK); // THR_HEAT
    laser.ship.heading = laser.ship.pheading = 0;
    park(laser.enemies.items[0]!, laser.ship.x + 150, laser.ship.y);

    const lhp0 = laser.enemies.items[0]!.hp;
    laser.step(); // 激光是瞬时判定:第一帧就打满一发
    expect(laser.enemies.items[0]!.hp).toBeCloseTo(
      lhp0 - TOWERS[TOWER_LASER]!.damage * AFFIXES[AFFIX_PHASED]!.energyMul,
      9,
    );
  });

  it('精英死亡必掉固定星币(ELITE.starCoins),击杀当场进账、不造掉落物;普通怪照旧 1× 残骸', () => {
    eliteScript([AFFIX_ARMORED], KIND_BEETLE);
    const w = new World(55);
    w.step();
    const elite = w.enemies.items[0]!;
    let at = { x: 0, y: 0 };
    w.onEnemyDeath = (e) => {
      at.x = e.x;
      at.y = e.y;
    };

    expect(w.starCoins).toBe(0);
    expect(w.damageEnemy(elite, 9999)).toBe(true);
    w.step();
    // 必掉高级掉落(16 号):3× 残骸整体替换为固定星币面额,零 rng、掉的就是"这一只"的
    expect(w.starCoins).toBe(ELITE.starCoins);
    expect(w.drops.size).toBe(0); // 星币直接入账,不造掉落物(不占 DROP_MAX_ALIVE、不走磁吸)

    // 对照:普通甲虫照旧掉 1× 残骸掉落物 —— 星币只来自精英,普通怪不进星币
    const plain = w.enemies.spawn();
    initEnemy(plain, KIND_BEETLE, 300, 300, w.elapsed, w.rng);
    expect(w.damageEnemy(plain, 9999)).toBe(true);
    w.step();
    expect(w.drops.size).toBe(1);
    expect(w.drops.items[0]!.value).toBe(ENEMIES[KIND_BEETLE]!.scrap);
    expect(w.starCoins).toBe(ELITE.starCoins);
  });

  it('精英掉星币直接进账:零 rng,击杀/进账不扰动出怪随机序列', () => {
    eliteScript([AFFIX_ARMORED], KIND_BEETLE);
    const a = new World(58);
    const b = new World(58);
    a.step();
    b.step();
    const elite = a.enemies.items[0]!;
    expect(a.damageEnemy(elite, 9999)).toBe(true);
    a.step(); // a 击杀精英并当场收账;b 的精英还活着
    b.step();
    expect(a.starCoins).toBe(ELITE.starCoins);
    expect(b.starCoins).toBe(0);
    expect(a.rng.next()).toBe(b.rng.next()); // 击杀/进账一次 rng 都不掷:两条随机流仍站在同一格上
  });

  it('裂变:精英死亡分裂成 3 只(复用池、不带词缀、普通血量、掉在原地),且一次 rng 都不掷', () => {
    eliteScript([AFFIX_FISSION], KIND_SWARM);
    const a = new World(52);
    const b = new World(52);
    a.step();
    b.step();
    const elite = a.enemies.items[0]!;
    expect(hasAffix(elite, AFFIX_FISSION)).toBe(true);
    const split = AFFIXES[AFFIX_FISSION]!.splitCount;
    expect(split).toBe(3);

    let at = { x: 0, y: 0 };
    a.onEnemyDeath = (e) => {
      at.x = e.x;
      at.y = e.y;
    };
    expect(a.damageEnemy(elite, 9999)).toBe(true);
    a.step(); // 帧尾回收 = 分裂
    expect(a.kills).toBe(1);
    expect(a.enemies.size).toBe(split);
    for (const s of a.enemies.items) {
      expect(s.affixes).toBe(0); // 分裂体不是小精英
      expect(s.kind).toBe(KIND_SWARM);
      expect(s.hp).toBeCloseTo(ENEMIES[KIND_SWARM]!.hp * hpScaleAt(a.elapsed), 9); // 普通血量
      expect(s.x).toBe(at.x); // 就掉在父体倒下的地方(帧尾出生,当帧一步不动)
      expect(s.y).toBe(at.y);
    }

    // 分裂不掷随机:对照世界(b)没死过人,两条随机流仍站在同一格上
    b.step();
    expect(a.rng.next()).toBe(b.rng.next());
  });

  it('同 seed 精英段重放:精英出现时刻/词缀与 checksum 逐位一致,击杀/分裂也不扰动序列', () => {
    useScript(
      segment({
        duration: 60,
        dirStartDeg: 0,
        dirEndDeg: 60,
        streams: [{ kind: KIND_SWARM, rate0: 8, rate1: 8, spreadDeg: 15 }],
        elites: [
          // 狂热+装甲侧掠者:活着的那几秒,光环在改**别人的**速度 —— checksum 里必须有它的位
          { at: 5, kind: KIND_STRAFER, count: 1, affixes: [AFFIX_FRENZY, AFFIX_ARMORED] },
          // 裂变甲虫:死掉那一刻爆出三只 —— 掉落/分裂的账也必须在 checksum 里
          { at: 12, kind: KIND_BEETLE, count: 1, affixes: [AFFIX_FISSION] },
        ],
      }),
    );
    const play = (seed: number, killAtFrame: number): string => {
      const w = new World(seed);
      let elite: Enemy | null = null;
      const eliteBorn: number[] = [];
      w.onEnemySpawn = (e) => {
        if (e.affixes !== 0) {
          eliteBorn.push(e.affixes);
          elite = e;
        }
      };
      for (let f = 1; f <= 20 * SIM_HZ; f++) {
        w.step();
        if (elite && f === killAtFrame) {
          w.damageEnemy(elite, 9999);
          elite = null;
        }
      }
      expect(eliteBorn).toEqual([affixMask([AFFIX_FRENZY, AFFIX_ARMORED]), affixMask([AFFIX_FISSION])]);
      return w.checksum();
    };
    const a = play(20260814, 8 * SIM_HZ);
    expect(play(20260814, 8 * SIM_HZ)).toBe(a); // 同 seed:整局逐位一致
    expect(play(20260815, 8 * SIM_HZ)).not.toBe(a); // 换 seed 才换
    expect(play(20260814, 0)).not.toBe(a); // 精英死活不同 → 击杀/掉落/分裂的账分叉
  });

  it('敌人词缀进 checksum:只把精英的词缀位抹掉就分叉,补回来又合流', () => {
    eliteScript([AFFIX_ARMORED], KIND_SWARM);
    const a = new World(57);
    const b = new World(57);
    a.step();
    b.step();
    expect(a.checksum()).toBe(b.checksum());

    const e = a.enemies.items[0]!;
    const affixes = e.affixes;
    e.affixes = 0;
    expect(a.checksum()).not.toBe(b.checksum());
    e.affixes = affixes;
    expect(a.checksum()).toBe(b.checksum());
  });
});

/**
 * 星币与三选一重摇(16 号)。账目口径(击杀直接进账、不进 checksum)、rerollOffer 的
 * rng 消耗与次数限制、以及同 seed 可复现性在这里钉;rollUpgradeOffer 那套 2×count 次
 * 消耗的纯函数钉法见 upgrade.test.ts。
 */
describe('星币与重摇(16 号:账目、rerollOffer、确定性)', () => {
  /** 固定随机序列 + 计数器(与 upgrade.test.ts 同款):类型私有字段使 Rng 名义化,经 unknown 显式转入 */
  class CountingRng {
    calls = 0;
    constructor(private readonly values: number[] = []) {}
    next(): number {
      return this.values[this.calls++] ?? 0;
    }
  }

  /** 空压测场:step() 全程不掷 rng,只有 settleUpgrade 那 6 次 —— rng 账才能数得清 */
  const EMPTY = { stressSpawn: true, stressEnemies: 0 };

  it('重摇:扣 10 星币 → 三个候选全部替换(允许重复),且恰消耗 2×UPGRADE_CHOICE_COUNT 次 rng', () => {
    Object.assign(tuning, EMPTY);
    const w = new World(1);
    // 12 次掷值:前 6 次 = 首轮 offer(塔 2/4/6),后 6 次 = 重摇(支援装甲舱 + 塔 4/5),
    // 两段显然不同 —— 证明三个候选位真的被重掷,不是只换了一张
    const counting = new CountingRng([0.05, 0.2, 0.1, 0.4, 0.15, 0.6, 0.9, 0.2, 0.85, 0.4, 0.8, 0.6]);
    Object.defineProperty(w, 'rng', { value: counting, configurable: true });
    w.scrap = w.upgradeCost;
    w.step(); // 首轮 offer:消费前 6 次
    expect(counting.calls).toBe(UPGRADE_CHOICE_COUNT * 2);
    const first = w.offer.map((o) => ({ ...o }));

    w.starCoins = REROLL_PRICE;
    expect(w.rerollOffer()).toBe(UPGRADE_CHOICE_COUNT);
    expect(counting.calls).toBe(UPGRADE_CHOICE_COUNT * 4); // 每次重摇恰 2×count 次,与首掷同口径
    expect(w.starCoins).toBe(0); // 扣费 10
    expect(w.offerRerolled).toBe(true);
    expect(w.offer).not.toEqual(first);
    for (const opt of w.offer) expect(optionHasLegalPlacement(w.deck, opt)).toBe(true);

    // 星币不足:拒绝、不扣费、不耗 rng(失败的尝试不许推动随机序列)
    const calls = counting.calls;
    w.starCoins = REROLL_PRICE - 1;
    expect(w.rerollOffer()).toBe(REROLL_NO_STARCOINS);
    expect(counting.calls).toBe(calls);
    expect(w.starCoins).toBe(REROLL_PRICE - 1);
    expect(w.offerRerolled).toBe(true); // 失败的尝试也不翻转次数限制
  });

  it('跳过(退残骸 15)与重摇(花星币 10)两条出口互不抵扣', () => {
    Object.assign(tuning, EMPTY);
    const w = new World(3);
    w.scrap = w.upgradeCost;
    w.starCoins = REROLL_PRICE * 3;
    w.step();
    const cost = w.upgradeCost;

    expect(w.rerollOffer()).toBe(UPGRADE_CHOICE_COUNT);
    expect(w.starCoins).toBe(REROLL_PRICE * 2); // 重摇只花星币
    expect(w.scrap).toBe(cost); // 残骸分文未动

    expect(w.skipUpgrade()).toBe(true);
    expect(w.scrap).toBe(skipRefundFor(cost)); // 跳过照旧退残骸(手续费口径不变)
    expect(w.starCoins).toBe(REROLL_PRICE * 2); // 跳过不动星币
    expect(w.offer).toEqual([]);
  });

  it('同 seed 同操作序列:重摇消耗的 rng 次数与结果逐位可复现,且每级第一次重摇必成功', () => {
    const play = (): string => {
      Object.assign(tuning, EMPTY);
      const w = new World(20260816);
      w.scrap = w.upgradeCost;
      w.starCoins = REROLL_PRICE * 4;
      const trace: string[] = [];
      for (let round = 0; round < 3; round++) {
        w.step(); // 生成新一档 offer(次数限制随新 offer 重置)
        trace.push(w.offer.map((o) => `${o.kind}:${o.type}:${o.level}`).join('|'));
        expect(w.rerollOffer()).toBeGreaterThan(0); // 新一档的第一次重摇必须成功
        trace.push(w.offer.map((o) => `${o.kind}:${o.type}:${o.level}`).join('|'));
        expect(w.skipUpgrade()).toBe(true); // 结算掉这一档(与重摇各管各的账)
        w.scrap = w.upgradeCost; // 下一档的钱
        for (let f = 0; f < UPGRADE_OFFER_COOLDOWN * SIM_HZ + 1; f++) w.step(); // 冲掉 5s 弹卡冷却
      }
      expect(w.starCoins).toBe(REROLL_PRICE); // 3 次重摇 × 10 = 30,剩 10
      trace.push(w.checksum());
      return trace.join(';');
    };
    expect(play()).toBe(play()); // 整条操作序列(含每次重摇的 6 次 rng)逐位可复现
  });

  it('offerRerolled 进 checksum(它决定重摇是否再消耗 rng);starCoins 余额不进(只影响 UI 与消费)', () => {
    Object.assign(tuning, EMPTY);
    const a = new World(77);
    const b = new World(77);
    a.scrap = b.scrap = a.upgradeCost;
    a.starCoins = b.starCoins = 999;
    a.step();
    b.step();
    expect(a.checksum()).toBe(b.checksum());

    a.offerRerolled = true; // 摇没摇过 = 下一次 rerollOffer 会不会再吃 2×count 次 rng
    expect(a.checksum()).not.toBe(b.checksum());
    a.offerRerolled = false;
    expect(a.checksum()).toBe(b.checksum());

    a.starCoins += 500; // 余额只是序列的读数(重摇消耗的 rng 本身在序列里):不进 checksum
    expect(a.checksum()).toBe(b.checksum());
  });
});

/**
 * 法令(18 号):授予路径、六个现读点、不占格与确定性。表级不变量在 data/edicts.test.ts 钉,
 * 这里钉的是"World 把法令接对没有"—— 授予当帧各现读点的读数就变,未持有逐位恒等。
 */
describe('法令接线(18 号:授予、现读点、确定性)', () => {
  /** 空压测场:step() 全程不掷 rng,只有 settleUpgrade 那 6 次 —— offer 的账才好数 */
  const EMPTY = { stressSpawn: true, stressEnemies: 0 };
  const CRUISE_BEFORE = tuning.shipCruiseSpeed;

  afterEach(() => {
    tuning.shipCruiseSpeed = CRUISE_BEFORE;
  });

  /** 把当前 offer 强制替换成一张指定法令卡,再走 takeUpgrade 的真实授予路径 */
  function grantEdict(w: World, type: number): void {
    w.offer.splice(0, w.offer.length, { kind: OFFER_EDICT, type, level: 0 });
    expect(w.takeUpgrade(0, 0, 0)).toBe(PLACE_OK);
    expect(w.upgrades).toBe(1);
    expect(w.offer).toEqual([]);
  }

  it('曳光协议:授予后弹药塔射速 +10%(cellFireInterval 读数变化),非弹药系塔一字不碰', () => {
    Object.assign(tuning, EMPTY);
    const w = new World(1);
    expect(w.place(0, 1, CELL_WEAPON, TOWER_AUTOCANNON)).toBe(PLACE_OK);
    expect(w.place(1, 0, CELL_WEAPON, TOWER_LASER)).toBe(PLACE_OK);
    const gun = cellAt(w.deck, 0, 1)!;
    const gunDef = TOWERS[TOWER_AUTOCANNON]!;
    const laser = cellAt(w.deck, 1, 0)!;
    const laserDef = TOWERS[TOWER_LASER]!;
    w.scrap = w.upgradeCost;
    w.step(); // 弹一档 offer,把授予路径接上(消耗 2×count 次 rng,与读表无关)

    // 未持有:聚合倍率恒 1,读数与既有链路逐位一致
    expect(edictAmmoFireRateMul(w.edicts)).toBe(1);
    expect(cellFireInterval(gun, gunDef, 1, edictAmmoFireRateMul(w.edicts))).toBe(0.4);

    grantEdict(w, EDICT_TRACER);

    // 抽到曳光协议:弹药塔间隔 0.4 → 0.4/1.1(面板读数变化正是这条 effective* 链路)
    expect(edictAmmoFireRateMul(w.edicts)).toBe(1.1);
    expect(cellFireInterval(gun, gunDef, 1, edictAmmoFireRateMul(w.edicts))).toBeCloseTo(0.4 / 1.1, 12);
    // 激光(过热系)不受"弹药系射速 +10%"影响:倍率只按格上节流系折进弹药塔 ——
    // turret.stepTurrets 对非弹药系传的恒是 1(cellFireInterval 是纯函数,给什么除什么)
    expect(cellFireInterval(laser, laserDef, 1, 1)).toBeCloseTo(towerFireInterval(laserDef, 1), 12);
  });

  it('法令不占格:授予不改甲板任何一格,也不参与邻接加成与放置合法性', () => {
    Object.assign(tuning, EMPTY);
    const w = new World(2);
    expect(w.place(0, 1, CELL_WEAPON, TOWER_AUTOCANNON)).toBe(PLACE_OK);
    expect(w.place(1, 1, CELL_SUPPORT, TOWER_AUTOCANNON, SUP_AMMO_BAY)).toBe(PLACE_OK);
    w.scrap = w.upgradeCost;
    w.step();
    const deckBefore = w.deck.cells.map((c) => ({
      occupied: c.occupied,
      content: c.content,
      towerType: c.towerType,
      supportType: c.supportType,
      level: c.level,
      fireRateMul: c.fireRateMul,
    }));
    const probe: UpgradeOption = { kind: OFFER_TOWER, type: TOWER_AUTOCANNON, level: 1 };
    const cells: number[] = [];
    const legalBefore = optionLegalCells(w.deck, probe, cells);
    const turnBefore = w.turnRate;
    const hpBefore = w.ship.maxHp;

    grantEdict(w, EDICT_TRACER);

    // 甲板一行未动:occupied/content/towerType/supportType/level/邻接缓存全同 ——
    // 法令不占格、不参与邻接 buff,连放一张卡对 deck 的可见影响都没有
    w.deck.cells.forEach((c, i) => {
      const b = deckBefore[i]!;
      expect(c.occupied).toBe(b.occupied);
      expect(c.content).toBe(b.content);
      expect(c.towerType).toBe(b.towerType);
      expect(c.supportType).toBe(b.supportType);
      expect(c.level).toBe(b.level);
      expect(c.fireRateMul).toBe(b.fireRateMul);
    });
    // 放置合法性(optionLegalCells)与转向/HP 上限的读数也一字不变(那张卡不是这几样法令)
    expect(optionLegalCells(w.deck, probe, cells)).toBe(legalBefore);
    expect(w.turnRate).toBe(turnBefore);
    expect(w.ship.maxHp).toBe(hpBefore);
  });

  it('重心/散热/结构/巡航/磁力的现读点:授予当帧读数就变,未持有逐位恒等', () => {
    Object.assign(tuning, EMPTY);
    const w = new World(3);
    expect(w.place(0, 1, CELL_WEAPON, TOWER_AUTOCANNON)).toBe(PLACE_OK);
    expect(w.place(1, 0, CELL_WEAPON, TOWER_LASER)).toBe(PLACE_OK);
    const laser = cellAt(w.deck, 1, 0)!;
    const laserDef = TOWERS[TOWER_LASER]!;

    // 重心校准:world.turnRate getter 一处(扩建惩罚之上加点)
    expect(w.turnRate).toBe(deckTurnRate(w.deck));
    w.edicts |= edictMask(EDICT_GYRO);
    expect(w.turnRate).toBe(deckTurnRate(w.deck) + 10);
    w.edicts &= ~edictMask(EDICT_GYRO);
    expect(w.turnRate).toBe(deckTurnRate(w.deck));

    // 散热协议:过热上限 ×1.2(激光是过热系;默认参数 = 未持有,原样)
    expect(cellHeatMax(laser, laserDef)).toBe(towerHeatMax(laserDef, 1));
    w.edicts |= edictMask(EDICT_COOLANT);
    expect(cellHeatMax(laser, laserDef, edictHeatMaxMul(w.edicts))).toBeCloseTo(
      towerHeatMax(laserDef, 1) * 1.2,
      12,
    );
    w.edicts &= ~edictMask(EDICT_COOLANT);

    // 结构加固:船体 HP 上限 +20(现读点 = 帧首重算,授予当帧的下一次 step 就生效)
    expect(edictHullHpAdd(w.edicts)).toBe(0);
    w.edicts |= edictMask(EDICT_HULL);
    expect(edictHullHpAdd(w.edicts)).toBe(20);
    w.step(); // 帧首 maxHp = hullMaxHp(deck, +20)
    expect(w.ship.maxHp).toBe(tuning.shipHullHp + 20);
    w.edicts &= ~edictMask(EDICT_HULL);

    // 巡航校准:巡航上限 ×1.1(stepShip 的巡航夹取;照 turnRateDeg 的先例由 World 传入)
    tuning.shipCruiseSpeed = 200;
    const a = new World(4);
    const b = new World(4);
    b.edicts |= edictMask(EDICT_CRUISE);
    const cmd: ShipCommand = { desiredHeading: { x: 1, y: 0 } };
    for (let f = 0; f < 180; f++) {
      a.step(cmd);
      b.step(cmd);
    }
    expect(Math.hypot(a.ship.vx, a.ship.vy)).toBeCloseTo(200, 6);
    expect(Math.hypot(b.ship.vx, b.ship.vy)).toBeCloseTo(220, 6);

    // 磁力过载:拾取半径 ×1.3(world 帧首 magnetMul 连乘,stepDrops 只认倍率)。
    // 无输入、船停在 (0,0):残骸摆在 200 之外、200×1.3=260 之内 —— 没抽到够不着,抽到必收
    tuning.dropMagnetRadius = 200;
    const m = new World(5);
    const d = m.drops.spawn();
    d.x = d.px = 260;
    d.y = d.py = 0;
    d.value = 1;
    m.step();
    expect(m.scrap).toBe(0); // 未持有:260 > 200,吸不到
    m.edicts |= edictMask(EDICT_MAGNET);
    for (let f = 0; f < 60; f++) m.step();
    expect(m.scrap).toBe(1); // 持有:起吸半径拉到 260(含边界),锁上就收
  });

  it('同 seed 同操作序列(含法令授予):出牌序列与 checksum 逐位可复现', () => {
    const play = (): string => {
      Object.assign(tuning, EMPTY);
      const w = new World(20260818);
      const trace: string[] = [];
      for (let round = 0; round < 6; round++) {
        w.scrap = w.upgradeCost;
        w.step(); // 弹一档 offer(消费 2×count 次 rng)
        trace.push(w.offer.map((o) => `${o.kind}:${o.type}:${o.level}`).join('|'));
        // 固定策略:第一张法令就授予,否则跳过 —— 两局在同一帧做同一件事
        const edictAt = w.offer.findIndex((o) => o.kind === OFFER_EDICT);
        if (edictAt >= 0) {
          w.offer.splice(0, w.offer.length, w.offer[edictAt]!);
          expect(w.takeUpgrade(0, 0, 0)).toBe(PLACE_OK);
        } else {
          expect(w.skipUpgrade()).toBe(true);
        }
        for (let f = 0; f < UPGRADE_OFFER_COOLDOWN * SIM_HZ + 1; f++) w.step(); // 冲掉 5s 弹卡冷却
      }
      trace.push(w.checksum());
      return trace.join(';');
    };
    expect(play()).toBe(play()); // 类别数 3→4 后 rng 消耗与出牌序列仍逐位可复现
  });

  it('法令进 checksum:一边授予一边不授予就分叉,补上同一张又合流', () => {
    Object.assign(tuning, EMPTY);
    const a = new World(77);
    const b = new World(77);
    a.scrap = b.scrap = a.upgradeCost;
    a.step();
    b.step();
    expect(a.checksum()).toBe(b.checksum());

    // 授予不消耗 rng(与 place 同一条"外部输入"口径):两边的随机流一步都没错开,
    // 分叉只可能来自法令集合 —— 漏了 acc(this.edicts),这一条当场合流,回归就跑不掉了
    a.offer.splice(0, a.offer.length, { kind: OFFER_EDICT, type: EDICT_TRACER, level: 0 });
    expect(a.takeUpgrade(0, 0, 0)).toBe(PLACE_OK);
    expect(a.checksum()).not.toBe(b.checksum());

    b.offer.splice(0, b.offer.length, { kind: OFFER_EDICT, type: EDICT_TRACER, level: 0 });
    expect(b.takeUpgrade(0, 0, 0)).toBe(PLACE_OK);
    expect(a.checksum()).toBe(b.checksum());

    // 掩码位翻转同样分叉(不是"恰好某一位没进哈希"的假合流)
    const before = a.checksum();
    a.edicts ^= edictMask(EDICT_TRACER);
    expect(a.checksum()).not.toBe(before);
  });

  it('重复法令不出现:抽到并授予后,后续候选绝不再弹同一张(候选剔掉已持有)', () => {
    Object.assign(tuning, EMPTY);
    const w = new World(20260819);
    const granted = new Set<number>();
    for (let round = 0; round < 14; round++) {
      w.scrap = w.upgradeCost;
      w.step();
      const edictAt = w.offer.findIndex((o) => o.kind === OFFER_EDICT);
      if (edictAt >= 0) {
        const type = w.offer[edictAt]!.type;
        expect(granted.has(type), `已授予的法令 ${type} 不该再进候选`).toBe(false);
        w.offer.splice(0, w.offer.length, w.offer[edictAt]!);
        expect(w.takeUpgrade(0, 0, 0)).toBe(PLACE_OK);
        granted.add(type);
      } else {
        expect(w.skipUpgrade()).toBe(true);
      }
      for (let f = 0; f < UPGRADE_OFFER_COOLDOWN * SIM_HZ + 1; f++) w.step();
    }
    expect(granted.size).toBeGreaterThan(0); // 这一局的固定 seed 真的抽到过法令,断言不空转
  });
});

/**
 * 解锁接线(19 号):解锁掩码的构造注入、卡池过滤(未解锁塔/法令绝不进候选)、
 * eliteKills 计数与它"不进 checksum"的口径,以及"过滤在掷前不耗 rng"的确定性。
 * 纯函数那一半(逐型可达 / 消耗次数)在 upgrade.test.ts 钉,这里钉 World 这一层的接线。
 */
describe('解锁接线(19 号:掩码注入、卡池过滤、eliteKills 与确定性)', () => {
  /** 空压测场:step() 全程不掷 rng,只有 settleUpgrade 那 6 次 —— rng 账才能数得清 */
  const EMPTY = { stressSpawn: true, stressEnemies: 0 };
  /** 掩码位 = 该解锁条目在 UNLOCKS 里的下标(与 waves.ts 的 unlockBit / upgrade.ts 的闸门同约定) */
  const maskOf = (...ids: string[]): number => {
    let m = 0;
    for (const id of ids) {
      const i = UNLOCKS.findIndex((u) => u.id === id);
      expect(i, `解锁条目 ${id} 必须存在`).toBeGreaterThanOrEqual(0);
      m |= 1 << i;
    }
    return m;
  };
  const MASK_ALL = (1 << UNLOCKS.length) - 1;

  /** 固定随机序列 + 计数器(与"星币与重摇"describe 同款) */
  class CountingRng {
    calls = 0;
    constructor(private readonly values: number[] = []) {}
    next(): number {
      return this.values[this.calls++] ?? 0;
    }
  }

  /** 真脚本原样留一份:eliteKills 那几条会换成短脚本,跑完必须还原 */
  const REAL = WAVE_SEGMENTS.slice();
  afterEach(() => {
    WAVE_SEGMENTS.splice(0, WAVE_SEGMENTS.length, ...REAL);
    Object.assign(tuning, BASE);
  });

  it('eliteKills:reap 按 affixes ≠ 0 计数(与 spawnDrop 同判定),普通怪与 Boss 不计', () => {
    tuning.stressSpawn = false;
    WAVE_SEGMENTS.splice(0, WAVE_SEGMENTS.length, {
      name: 'seg',
      duration: 60,
      dirStartDeg: 0,
      dirEndDeg: 0,
      streams: [],
      bursts: [],
      elites: [{ at: 0, kind: KIND_BEETLE, count: 1, affixes: [AFFIX_ARMORED] }],
    });
    const w = new World(20260819);
    w.step();
    expect(w.enemies.size).toBe(1);
    const elite = w.enemies.items[0]!;
    expect(w.damageEnemy(elite, 9999)).toBe(true);
    w.step();
    expect(w.kills).toBe(1);
    expect(w.eliteKills).toBe(1); // 精英 = affixes ≠ 0:这一只算

    // 普通怪:击杀照常进 kills,精英数不动
    const plain = w.enemies.spawn();
    initEnemy(plain, KIND_SWARM, 300, 300, w.elapsed, w.rng);
    expect(plain.affixes).toBe(0);
    expect(w.damageEnemy(plain, 9999)).toBe(true);
    w.step();
    expect(w.kills).toBe(2);
    expect(w.eliteKills).toBe(1);

    // Boss 绝不用 affixes 位(boss.test.ts 钉着):击杀计入 kills,不计入精英
    const boss = w.enemies.spawn();
    initBoss(boss, 400, 400, w.elapsed);
    expect(boss.affixes).toBe(0);
    expect(w.damageEnemy(boss, 9999)).toBe(true);
    w.step();
    expect(w.kills).toBe(3);
    expect(w.eliteKills).toBe(1);
  });

  it('eliteKills 不进 checksum:与 kills 同一条派生量口径(击杀本身在敌人池与 affixes 里可见)', () => {
    Object.assign(tuning, EMPTY);
    const a = new World(77);
    const b = new World(77);
    a.step();
    b.step();
    expect(a.checksum()).toBe(b.checksum());

    const before = a.checksum();
    a.eliteKills += 5; // 跨局累计的存档读数:漏哈不影响重放 —— 与 kills 同口径
    expect(a.checksum()).toBe(before);
    a.kills += 5; // 对照:kills 同样不进 —— 两条"回收帧记账"的读数同一条待遇
    expect(a.checksum()).toBe(before);
  });

  it('未解锁掩码(缺省 0):40 seed 穷举,导弹巢与急速协议绝不进候选;基础塔照常出', () => {
    Object.assign(tuning, EMPTY);
    let towers = 0;
    for (let seed = 0; seed < 40; seed++) {
      const w = new World(seed); // 缺省 unlockMask = 0 = 一切未解锁(旧构造语义)
      w.scrap = w.upgradeCost;
      w.step();
      expect(w.offer.length).toBeGreaterThan(0);
      for (const opt of w.offer) {
        if (opt.kind === OFFER_TOWER) {
          towers++;
          expect(opt.type, `seed ${seed} 弹出了未解锁塔 ${opt.type}`).not.toBe(TOWER_MISSILE_NEST);
        } else if (opt.kind === OFFER_EDICT) {
          expect(opt.type, `seed ${seed} 弹出了未解锁法令 ${opt.type}`).not.toBe(EDICT_RAPID);
        }
      }
    }
    expect(towers).toBeGreaterThan(0); // 塔类照常出卡:不是整池被掏空,只是闸门外的型号进不来
  });

  it('解锁掩码传入后:同一组掷值就能掷中导弹巢/急速协议(掩码 0 的对照掷不中)', () => {
    Object.assign(tuning, EMPTY);
    // 塔类:0.1 落在塔类区间,6.5/7 落在空甲板全解锁塔池(0..5 + 12)的最后一型 = 导弹巢
    const open = new CountingRng([0.1, 6.5 / 7, 0, 0, 0, 0]);
    const wOpen = new World(1, MASK_ALL);
    Object.defineProperty(wOpen, 'rng', { value: open, configurable: true });
    wOpen.scrap = wOpen.upgradeCost;
    wOpen.step();
    expect(open.calls).toBe(UPGRADE_CHOICE_COUNT * 2);
    expect(wOpen.offer.some((o) => o.kind === OFFER_TOWER && o.type === TOWER_MISSILE_NEST)).toBe(true);

    // 同一组掷值、掩码 0:导弹巢在池外,同一下标落不到它头上
    const closed = new CountingRng([0.1, 6.5 / 7, 0, 0, 0, 0]);
    const wClosed = new World(1, 0);
    Object.defineProperty(wClosed, 'rng', { value: closed, configurable: true });
    wClosed.scrap = wClosed.upgradeCost;
    wClosed.step();
    expect(closed.calls).toBe(UPGRADE_CHOICE_COUNT * 2); // 过滤不改变消耗次数
    expect(wClosed.offer.some((o) => o.kind === OFFER_TOWER && o.type === TOWER_MISSILE_NEST)).toBe(false);

    // 法令类:0.9 落在法令区间,6.5/7 落在全解锁法令池的最后一型 = 急速协议
    const openE = new CountingRng([0.9, 6.5 / 7, 0, 0, 0, 0]);
    const wOpenE = new World(2, MASK_ALL);
    Object.defineProperty(wOpenE, 'rng', { value: openE, configurable: true });
    wOpenE.scrap = wOpenE.upgradeCost;
    wOpenE.step();
    expect(openE.calls).toBe(UPGRADE_CHOICE_COUNT * 2);
    expect(wOpenE.offer.some((o) => o.kind === OFFER_EDICT && o.type === EDICT_RAPID)).toBe(true);
  });

  it('同 seed 解锁前后:rng 序列逐位一致 —— 过滤只收窄候选集合,不移动消耗次数', () => {
    Object.assign(tuning, EMPTY);
    const play = (mask: number): number[] => {
      const w = new World(20260819, mask);
      // 三轮"弹卡 → 跳过"各消费 6 次 rng;两局操作序列完全一致,只有掩码不同
      for (let round = 0; round < 3; round++) {
        w.scrap = w.upgradeCost;
        w.step();
        expect(w.offer.length).toBeGreaterThan(0);
        expect(w.skipUpgrade()).toBe(true);
        for (let f = 0; f < UPGRADE_OFFER_COOLDOWN * SIM_HZ + 1; f++) w.step();
      }
      const stream: number[] = [];
      for (let i = 0; i < 24; i++) stream.push(w.rng.next());
      return stream;
    };
    expect(play(0)).toEqual(play(MASK_ALL)); // 解锁与否,后续 24 次掷值逐位一致
  });
});

/**
 * 孢子炮手与点防拦截(22 号,GDD §6.2 / §5.2)—— 世界这一层的接线:
 * 齐射落地(敌人循环里消费 sporeFire 闩)、弹丸的 damageShip 路由、点防拦截的移除,
 * 以及最要紧的两条确定性口径 —— 齐射与拦截**零 rng**(volley 由锚定计时器驱动,
 * 拦截由几何驱动),checksum 把敌方弹丸当 sim 状态哈进去。
 * 行为状态机本身在 enemy.test.ts 钉,这里钉的是"世界把它的副作用接对了没有"。
 */
describe('孢子炮手与点防拦截(22 号)', () => {
  const REAL = WAVE_SEGMENTS.slice();
  afterEach(() => {
    WAVE_SEGMENTS.splice(0, WAVE_SEGMENTS.length, ...REAL);
  });

  /** 换脚本并回到正式出怪路(照"波次出怪接线"那个 describe 的同款写法) */
  function useScript(...segs: WaveSegment[]): void {
    tuning.stressSpawn = false;
    WAVE_SEGMENTS.splice(0, WAVE_SEGMENTS.length, ...segs);
  }

  function segment(p: Partial<WaveSegment> = {}): WaveSegment {
    return {
      name: 'seg',
      duration: 60,
      dirStartDeg: 0,
      dirEndDeg: 0,
      streams: [],
      bursts: [],
      elites: [],
      ...p,
    };
  }

  /** 固定随机序列 + 计数器(照"星币与重摇"那个 describe 的同款写法) */
  class CountingRng {
    calls = 0;
    constructor(private readonly values: number[] = []) {}
    next(): number {
      return this.values[this.calls++] ?? 0;
    }
  }

  /** 手动往场上塞一只孢子(正式出怪器之外的注入,与既有用例的手动 initEnemy 同款) */
  function injectSpore(w: World, dx: number, dy: number): void {
    const e = w.enemies.spawn();
    initEnemy(e, KIND_SPORE, w.ship.x + dx, w.ship.y + dy, w.elapsed, w.rng);
  }

  /** 手动往场上塞一颗弹丸(避开"等孢子自己喷"的几十秒) */
  function injectProjectile(w: World, x: number, y: number, vx: number, vy: number, damage: number): void {
    const b = w.enemyBullets.spawn();
    b.x = b.px = x;
    b.y = b.py = y;
    b.vx = vx;
    b.vy = vy;
    b.damage = damage;
    b.life = 20;
    b.radius = 5;
    b.kind = KIND_SPORE;
  }

  it('孢子齐射落地:锚定后按间隔喷吐,弹丸进 enemyBullets,发射零 rng', () => {
    useScript(segment({})); // 空脚本:step() 全程不掷 rng,账才数得清
    const w = new World(7);
    const SPORE = ENEMIES[KIND_SPORE]!;
    // 射程带内放一只:首帧锚定,sporeInterval + sporeWarnTime 后喷第一轮
    injectSpore(w, SPORE.sporeRange - 10, 0);
    // 锚定用真实 rng 放完(侧那一掷),此后换计数器:齐射的每一帧都不许再碰 rng
    const counting = new CountingRng();
    Object.defineProperty(w, 'rng', { value: counting, configurable: true });
    for (let i = 0; i < 200; i++) w.step(); // 200 帧 = 3.3s:够锚定(2.2s)+ 蓄力(0.8s)+ 开火
    expect(w.enemyBullets.size).toBe(SPORE.sporeSalvoCount); // 一轮齐射 = 3 发
    expect(w.enemyBullets.items[0]!.damage).toBe(SPORE.sporeDamage); // 伤害发射那一刻定死
    expect(counting.calls).toBe(0); // 齐射零 rng:同 seed 两局的弹丸序列逐位一致
    expect(w.ship.hp).toBe(100); // 弹丸还在路上,没到船
  });

  it('弹丸命中走 damageShip 路由:核心命中扣血 + 该舷受击惩罚 + 船体飘字事件', () => {
    const w = new World(7); // 默认压测路(本文件 BASE):空场,手动注入弹丸
    const hp0 = w.ship.hp;
    // 弹丸贴着核心区边缘(船头方向,世界 (0, 20) → 局部 -20),一帧位移(3.67px)落进核心
    injectProjectile(w, 0, 20, 0, -220, 8);
    w.step();
    expect(w.ship.hp).toBe(hp0 - 8); // 09 号预留的 damageShip 接口第一次真正被调用
    expect(w.edgePenalty[EDGE_STERN]!).toBeGreaterThan(0); // 弹丸从船尾方向(+Y)来:惩罚落在 STERN
    expect(w.fx.items.some((e) => e.kind === FXV_HULL_HIT && e.damage === 8)).toBe(true);
    expect(w.enemyBullets.size).toBe(0); // 命中即消失
  });

  it('弹丸擦碰甲板轮廓:只出火花、弹丸继续飞,一分血都不扣', () => {
    const w = new World(7);
    // 甲板轮廓带(格边长 12):从带外(局部 x = -30)慢速朝船飞,进带那一帧出一声火花
    // (边缘检测);弹丸不被拦下 —— 轮廓是接触模型的概念,拦不下飞行物
    injectProjectile(w, 0, 30, 0, -2, 8);
    let sparked = false;
    for (let i = 0; i < 50 && !sparked; i++) {
      w.step();
      sparked = w.fx.items.some((e) => e.kind === FXV_SPARK); // 火花只有 0.12s,当场检测
    }
    expect(sparked).toBe(true);
    expect(w.ship.hp).toBe(100);
    expect(w.enemyBullets.size).toBe(1); // 继续飞,直到寿命走完或进核心
  });

  it('点防拦截:射程内朝船接近的弹丸被拦截弹打掉(双回池 + 拦截火花),船不掉血', () => {
    const w = new World(7);
    // 船头边缘格放点防(TOWER_PD,广 150°):射界中心 = 船头方向(-Y),正对弹丸来向
    expect(isPlaceSuccess(w.place(1, 0, CELL_WEAPON, TOWER_PD))).toBe(true);
    // 弹丸从船头前方 300px 直扑船心:进点防射程(210)后被拦截,永远到不了船
    injectProjectile(w, 0, -300, 0, 220, 8);
    // 步进到弹丸消失为止(拦截命中当帧的 FXV_IMPACT 还活着;再走 60 帧它已老化出池)
    for (let i = 0; i < 60 && w.enemyBullets.size > 0; i++) w.step();
    expect(w.enemyBullets.size).toBe(0); // 弹丸没了(被拦截,不是命中了船)
    expect(w.ship.hp).toBe(100); // 一颗都没漏过来
    expect(w.fx.items.some((e) => e.kind === FXV_IMPACT)).toBe(true); // 拦截火花
  });

  it('拦截零 rng:点防开火/命中一步都不掷,随机序列原地不动', () => {
    useScript(segment({})); // 空脚本 + 计数器:任何一步偷吃 rng 都会被 calls 抓住
    const w = new World(7);
    expect(isPlaceSuccess(w.place(1, 0, CELL_WEAPON, TOWER_PD))).toBe(true);
    injectProjectile(w, 0, -300, 0, 220, 8);
    const counting = new CountingRng();
    Object.defineProperty(w, 'rng', { value: counting, configurable: true });
    for (let i = 0; i < 60; i++) w.step();
    expect(counting.calls).toBe(0);
    expect(w.enemyBullets.size).toBe(0);
  });

  it('敌弹进 checksum:同 seed 两局,弹丸位置分叉立即体现在哈希里', () => {
    const a = new World(99);
    const b = new World(99);
    // 两局注入同一颗弹丸 → 哈希一致(池序一致,逐位可比)
    injectProjectile(a, 100, 50, -220, 0, 8);
    injectProjectile(b, 100, 50, -220, 0, 8);
    expect(a.checksum()).toBe(b.checksum());
    // 挪动一颗的位置 → 哈希分叉(位置是弹丸状态的唯一哈面)
    a.enemyBullets.items[0]!.x = 100.5;
    expect(a.checksum()).not.toBe(b.checksum());
    // 少一颗(存在性)同样是状态:清掉一颗 → 分叉
    a.enemyBullets.items[0]!.x = 100;
    a.enemyBullets.despawnAt(0);
    expect(a.checksum()).not.toBe(b.checksum());
    expect(b.checksum()).toBe(b.checksum());
  });
});
