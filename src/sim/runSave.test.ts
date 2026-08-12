/**
 * 局内存档的验收:**读档后的世界与存档那一刻的世界是同一个世界,而且往后每一帧都还是**。
 *
 * 这条口径不是"字段抄全了"那种自证清白的检查(逐字段比对的测试只会证明 capture 与
 * restore 抄了同一张表,漏掉的字段两边一起漏,测试照样绿)。这里改用 World 自己的
 * checksum + 继续推进若干帧:checksum 覆盖的正是"什么是真状态"那份清单,
 * 而**继续推进**能抓住 checksum 没覆盖但影响未来的东西 —— 首当其冲是 rng 游标:
 * 漏了它,存档那一刻两边的哈希完全一致,却在下一次出怪时分道扬镳。
 */
import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../core/loop';
import { TOWER_KIND_COUNT } from '../data/towers';
import { WAVE_SEGMENTS } from '../data/waves';
import { createBullet } from './bullet';
import { createDrop } from './drop';
import { createEnemy } from './enemy';
import { createEnemyBullet } from './enemyBullet';
import { applyStartingLoadout } from './loadout';
import {
  BU_STRIDE,
  DR_STRIDE,
  EB_STRIDE,
  EN_STRIDE,
  OF_STRIDE,
  RUN_SAVE_VERSION,
  WP_STRIDE,
  canSaveRun,
  captureRun,
  digestRunSnapshot,
  parseRunSnapshot,
  restoreRun,
  serializeRunSnapshot,
  tryRestoreRun,
} from './runSave';
import { EDICT_KIND_COUNT } from '../data/edicts';
import { WEAPON_SLOT_COUNT } from './armory';
import type { ShipCommand } from './ship';
import { RESULT_RUNNING, World } from './world';

const META = { seed: 20260801, loadout: 0 };

/**
 * 跑一局到第 n 帧。**输入不是恒定的**:一直朝同一个方向开的话船会飞出怪群,
 * 打不出子弹、掉落、升级候选那些真正要被存下来的状态。这里让船按一条固定的
 * 折线转向(不掷任何随机,故本身可复现),换来场上同时有敌人/子弹/掉落物。
 */
function runTo(world: World, frames: number): void {
  const cmd: ShipCommand = { desiredHeading: { x: 1, y: 0 }, boost: false };
  for (let i = 0; i < frames; i++) {
    const a = (i / 90) * Math.PI * 0.5;
    cmd.desiredHeading = { x: Math.cos(a), y: Math.sin(a) };
    cmd.boost = i % 300 === 0;
    world.step(cmd);
  }
}

function freshRun(frames: number): World {
  const world = new World(META.seed);
  applyStartingLoadout(world, META.loadout);
  runTo(world, frames);
  return world;
}

describe('局内存档:capture → restore', () => {
  it('读档后的 checksum 与存档那一刻一致', () => {
    const world = freshRun(600);
    const snap = captureRun(world, META);
    const restored = restoreRun(snap);
    expect(restored.checksum()).toBe(world.checksum());
  });

  it('读档后继续推进 600 帧,每 60 帧的 checksum 仍逐帧一致(rng 游标接得上)', () => {
    const world = freshRun(600);
    const restored = restoreRun(captureRun(world, META));
    // 两边喂**同一条**输入序列:同一个 runTo 的第 601 帧起,轨迹必须逐帧重合。
    // 分 10 段比对而不是只比末尾:错位越早发现,越容易定位是哪一类状态漏了
    for (let seg = 0; seg < 10; seg++) {
      runTo(world, 60);
      runTo(restored, 60);
      expect(restored.checksum()).toBe(world.checksum());
    }
  });

  it('场上确实有实体时才算数(这一局跑到 600 帧应有敌人与掉落)', () => {
    const world = freshRun(600);
    expect(world.enemies.size).toBeGreaterThan(0);
    const snap = captureRun(world, META);
    expect(snap.enemies.length).toBe(world.enemies.size * EN_STRIDE);
    expect(snap.bullets.length).toBe(world.bullets.size * BU_STRIDE);
    expect(snap.enemyBullets.length).toBe(world.enemyBullets.size * EB_STRIDE);
    expect(snap.drops.length).toBe(world.drops.size * DR_STRIDE);
    const restored = restoreRun(snap);
    expect(restored.enemies.size).toBe(world.enemies.size);
    expect(restored.bullets.size).toBe(world.bullets.size);
    expect(restored.drops.size).toBe(world.drops.size);
  });

  it('capture 是纯读:摘一次快照不改动这一局的任何状态', () => {
    const world = freshRun(300);
    const before = world.checksum();
    const rngBefore = world.rng.state;
    captureRun(world, META);
    expect(world.checksum()).toBe(before);
    expect(world.rng.state).toBe(rngBefore);
  });

  it('局内的账(击杀/精英/武器战报)读档后不被抹掉', () => {
    const world = freshRun(900);
    world.kills = 137;
    world.eliteKills = 5;
    world.runDamageByType[0] = 4321;
    world.peakDps = 88.5;
    const restored = restoreRun(captureRun(world, META));
    expect(restored.kills).toBe(137);
    expect(restored.eliteKills).toBe(5);
    expect(restored.runDamageByType[0]).toBe(4321);
    expect(restored.peakDps).toBe(88.5);
  });

  it('读档不补发开局星币:余额取存档里的那一份(花掉的钱不会读一次档回来)', () => {
    const world = freshRun(300);
    world.starCoins = 3; // 比 STARTING_STAR_COINS 低:补发过就会被顶回 15
    const restored = restoreRun(captureRun(world, META));
    expect(restored.starCoins).toBe(3);
  });

  it('起手配置不被重放:读档拿的是存下来的槽位,不是开局那四门炮', () => {
    const world = freshRun(60);
    // 手动改一个槽,模拟"半局里换过武器":读档必须拿到改后的这一份
    world.weapons[0]!.type = 3;
    world.weapons[0]!.level = 4;
    world.weapons[0]!.heat = 0.37;
    const restored = restoreRun(captureRun(world, META));
    expect(restored.weapons[0]!.type).toBe(3);
    expect(restored.weapons[0]!.level).toBe(4);
    expect(restored.weapons[0]!.heat).toBeCloseTo(0.37, 6);
  });

  it('rng 游标漏存会当场露馅(反证:把游标改掉,后续轨迹必然分叉)', () => {
    const world = freshRun(600);
    const snap = captureRun(world, META);
    const tampered = { ...snap, rng: (snap.rng + 1) >>> 0 };
    const restored = restoreRun(tampered);
    // 存档那一刻两边仍相同(游标不进 checksum)——正是这一点让"漏存 rng"极难发现
    expect(restored.checksum()).toBe(world.checksum());
    // 但只要世界继续跑,出怪序列就会分开
    runTo(world, 600);
    runTo(restored, 600);
    expect(restored.checksum()).not.toBe(world.checksum());
  });
});

describe('局内存档:序列化与判废', () => {
  it('JSON 往返后仍是同一份快照', () => {
    const world = freshRun(420);
    const snap = captureRun(world, META);
    const back = parseRunSnapshot(serializeRunSnapshot(snap));
    expect(back).not.toBeNull();
    expect(restoreRun(back!).checksum()).toBe(world.checksum());
  });

  it('非法 JSON / 空对象 / 版本对不上一律判废', () => {
    expect(parseRunSnapshot('{oops')).toBeNull();
    expect(parseRunSnapshot('null')).toBeNull();
    expect(parseRunSnapshot('{}')).toBeNull();
    const world = freshRun(60);
    const snap = captureRun(world, META);
    const old = serializeRunSnapshot({ ...snap, v: RUN_SAVE_VERSION + 1 });
    expect(parseRunSnapshot(old)).toBeNull();
  });

  it('定长数组长度不对、池数组不是 stride 整数倍、格子里有 NaN,一律判废', () => {
    const snap = captureRun(freshRun(120), META);
    expect(parseRunSnapshot(serializeRunSnapshot({ ...snap, ship: [1, 2, 3] }))).toBeNull();
    expect(parseRunSnapshot(serializeRunSnapshot({ ...snap, econ: [] }))).toBeNull();
    // stride 差一格:整条池数组的字段就此错位,读进来就是一场坐标乱飞的战斗
    expect(
      parseRunSnapshot(serializeRunSnapshot({ ...snap, enemies: [...snap.enemies, 1] })),
    ).toBeNull();
    // NaN 过不了 JSON(会变成 null),故直接构造一份带 null 的原始串
    const withNull = serializeRunSnapshot(snap).replace('"tick":', '"tick2":');
    expect(parseRunSnapshot(withNull)).toBeNull();
  });

  it('语义越界(段号 999)被 tryRestoreRun 或波次夹取兜住,不产出一个半死的世界', () => {
    const snap = captureRun(freshRun(120), META);
    const world = tryRestoreRun({ ...snap, wave: [999, 0, 0, 0] });
    // 夹取让它落在"脚本走完"上(合法状态,World 会照常判定进 Boss),而不是读一个不存在的段
    expect(world).not.toBeNull();
    expect(world!.wave.segment).toBeLessThanOrEqual(WAVE_SEGMENTS.length);
    expect(() => world!.step()).not.toThrow();
  });
});

describe('局内存档:能不能存 / 摘要读数', () => {
  it('还在跑的局才存得,分出胜负或沉船的不存', () => {
    const world = freshRun(60);
    expect(world.result).toBe(RESULT_RUNNING);
    expect(canSaveRun(world)).toBe(true);
    world.shipDead = true;
    expect(canSaveRun(world)).toBe(false);
  });

  it('摘要给出存活时长/航段/击杀/血量,maxHp 按支援与法令现算', () => {
    const world = freshRun(600);
    world.kills = 42;
    const d = digestRunSnapshot(captureRun(world, META));
    expect(d.elapsedSec).toBeCloseTo(600 * SIM_DT, 6);
    expect(d.kills).toBe(42);
    expect(d.segment).toBe(world.wave.segment);
    expect(d.segmentCount).toBe(WAVE_SEGMENTS.length);
    expect(d.hp).toBe(world.ship.hp);
    // 现算的上限必须与世界帧首算出来的那一个一致(两处同源,不是各存一份)
    expect(d.maxHp).toBe(world.ship.maxHp);
  });
});

describe('局内存档:stride 与结构对表', () => {
  /**
   * 这一组是**给未来的人**的:往 Enemy / Bullet 里加一个字段而忘了改存档,
   * 症状是"读档后某一类行为悄悄退回默认值",没有任何一处会报错。
   * 于是把 stride 与结构字段数钉在一起 —— 加字段必然让这里变红,
   * 逼着改的人回去决定"这个新字段是真状态(要存)还是派生量/表现(不存)"。
   * 数字对不上时的正确修法**不是**把数字改到相等,而是:先在 runSave.ts 的字段表里
   * 给新字段定性、该存的存进去,再把这里的"不存字段数"改成新的值并写明理由。
   */
  it('Enemy:15 存 + 6 不存(px/py/hitFlash/lastHit/dead/sporeFire 见 EN_STRIDE 注释)', () => {
    // 那 6 个的定性各不相同(插值基准 / 纯表现 / 派生量 / 同帧闩),逐条理由在 EN_STRIDE 注释里;
    // animSeed 反过来:它虽是表现字段却**要存** —— 由出生位置 hash 而来,读档时无从重算
    expect(Object.keys(createEnemy()).length).toBe(EN_STRIDE + 6);
  });
  it('Bullet:14 存 + px/py 不存', () => {
    expect(Object.keys(createBullet()).length).toBe(BU_STRIDE + 2);
  });
  it('EnemyBullet:8 存 + px/py 不存', () => {
    expect(Object.keys(createEnemyBullet()).length).toBe(EB_STRIDE + 2);
  });
  it('Drop:6 存 + px/py 不存', () => {
    expect(Object.keys(createDrop()).length).toBe(DR_STRIDE + 2);
  });
  it('武器槽 / 法令层数 / 候选卡:全字段都存,一个不落', () => {
    const world = new World(1);
    expect(Object.keys(world.weapons[0]!).length).toBe(WP_STRIDE);
    const snap = captureRun(world, META);
    expect(snap.weapons.length).toBe(WEAPON_SLOT_COUNT * WP_STRIDE);
    expect(snap.edicts.length).toBe(EDICT_KIND_COUNT);
    expect(snap.banked.length).toBe(TOWER_KIND_COUNT);
    expect(snap.damageByType.length).toBe(TOWER_KIND_COUNT);
    expect(snap.offer.length % OF_STRIDE).toBe(0);
    // 商店信标:五个数(active/x/y/ttl/segment)—— 少一个就是读档后信标位置对不上
    expect(snap.beacon.length).toBe(5);
  });
});
