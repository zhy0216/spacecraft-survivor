import { afterEach, describe, expect, it } from 'vitest';
import { SIM_DT } from '../core/loop';
import { DECK_PIECE_BAR } from '../data/deckPieces';
import { REFIT_HEAL_FRACTION } from '../data/economy';
import { KIND_SWARM } from '../data/enemies';
import { SUP_AMMO_BAY, SUPPORTS } from '../data/supports';
import { TOWER_AUTOCANNON, TOWER_GATLING, TOWER_MAX_LEVEL } from '../data/towers';
import { WAVE_SEGMENTS, type WaveSegment } from '../data/waves';
import { tuning } from './config';
import {
  canWeldPiece,
  CELL_EMPTY,
  CELL_SUPPORT,
  CELL_WEAPON,
  cellAt,
  EVOLVE_NO_RECIPE,
  EVOLVE_OK,
  MOVE_OK,
  placeAt,
  PLACE_OK,
  PLACE_TAKEN,
  WELD_OK,
} from './deck';
import { syncSupportBuffs } from './support';
import {
  REFIT_ALREADY_WELDED,
  REFIT_NOT_ACTIVE,
  World,
} from './world';

const REAL = WAVE_SEGMENTS.slice();
const STRESS = tuning.stressSpawn;
const AMMO = SUPPORTS[SUP_AMMO_BAY]!;
afterEach(() => {
  WAVE_SEGMENTS.splice(0, WAVE_SEGMENTS.length, ...REAL);
  tuning.stressSpawn = STRESS;
});

function segment(p: Partial<WaveSegment> = {}): WaveSegment {
  return {
    name: '航段',
    duration: 0.051,
    dirStartDeg: 0,
    dirEndDeg: 0,
    streams: [],
    bursts: [],
    elites: [],
    ...p,
  };
}

function useTwoSegments(): void {
  tuning.stressSpawn = false;
  WAVE_SEGMENTS.splice(
    0,
    WAVE_SEGMENTS.length,
    segment({ name: '旧波' }),
    segment({
      name: '新波',
      duration: 1,
      streams: [{ kind: KIND_SWARM, rate0: 60, rate1: 60, spreadDeg: 0 }],
    }),
  );
}

describe('两分钟波次整备', () => {
  it('跨段先进入整备、下一波不偷跑；完成后才从新段开始出怪', () => {
    useTwoSegments();
    const w = new World(81);
    const seen: number[] = [];
    w.onRefitOffer = (segmentIndex) => seen.push(segmentIndex);

    // 先走到跨段前一帧，再补足残骸：制造“跨段与普通升级同帧成立”的真实冲突。
    for (let i = 0; i < 3; i++) w.step();
    expect(w.wave.segment).toBe(0);
    expect(w.offer).toEqual([]);
    w.scrap = w.upgradeCost;
    w.step();
    expect(w.wave.segment).toBe(1);
    expect(seen).toEqual([1]);
    expect(w.enemies.size).toBe(0);
    expect(w.offer).toEqual([]);

    const heldTime = w.wave.segTime;
    for (let i = 0; i < 10; i++) w.step();
    expect(w.wave.segTime).toBe(heldTime);
    expect(w.enemies.size).toBe(0);
    expect(seen).toEqual([1]);

    expect(w.completeRefit()).toBe(true);
    expect(w.completeRefit()).toBe(false);
    w.step();
    expect(w.wave.segTime).toBeCloseTo(heldTime + SIM_DT, 12);
    expect(w.enemies.size).toBe(1);
    expect(w.offer).toEqual([]); // 完成整备后有冷却，不会下一帧背靠背弹普通升级
  });

  it('整备结束修复船体(GDD §9:船坞 = 免费重排 + 回 30% HP);满血不溢出,未在整备不生效', () => {
    const w = new World(83);
    const full = w.ship.maxHp;
    w.ship.hp = Math.floor(full * 0.4);

    expect(w.completeRefit()).toBe(false); // 未进入整备:一个字段都不动
    expect(w.ship.hp).toBe(Math.floor(full * 0.4));

    w.refitPending = true;
    expect(w.completeRefit()).toBe(true);
    // ceil:回血后 = 40% + 30% → 70%;若舍入用 floor,小 maxHp 下 30% 可能被吞成 0
    expect(w.ship.hp).toBe(Math.floor(full * 0.4) + Math.ceil(full * REFIT_HEAL_FRACTION));

    // 满血完成整备:回血夹在 maxHp 上,一分不溢出
    w.refitPending = true;
    expect(w.completeRefit()).toBe(true);
    expect(w.ship.hp).toBe(full);

    // 回血是确定性算术:同 seed 双世界、同操作序列,hp 与 checksum 逐位一致
    const a = new World(84);
    const b = new World(84);
    a.ship.hp = b.ship.hp = Math.floor(full * 0.4);
    a.refitPending = true;
    b.refitPending = true;
    expect(a.checksum()).toBe(b.checksum());
    expect(a.completeRefit()).toBe(true);
    expect(b.completeRefit()).toBe(true);
    expect(a.ship.hp).toBe(b.ship.hp);
    expect(a.checksum()).toBe(b.checksum());
  });

  it('甲板每轮最多焊一块；模块只能在整备期移动并保留等级', () => {
    const w = new World(82);
    expect(placeAt(w.deck, 0, 1, CELL_WEAPON)).toBe(0);
    cellAt(w.deck, 0, 1)!.level = 3;

    expect(w.moveRefitModule(0, 1, 2, 2)).toBe(REFIT_NOT_ACTIVE);
    expect(w.weldRefitPiece(DECK_PIECE_BAR, 0, -2, 0)).toBe(REFIT_NOT_ACTIVE);

    w.refitPending = true;
    expect(w.moveRefitModule(0, 1, 2, 2)).toBe(MOVE_OK);
    expect(cellAt(w.deck, 2, 2)!.level).toBe(3);

    let welded = false;
    for (let row = -4; row <= 7 && !welded; row++) {
      for (let col = -4; col <= 6 && !welded; col++) {
        if (canWeldPiece(w.deck, DECK_PIECE_BAR, 0, col, row) !== WELD_OK) continue;
        expect(w.weldRefitPiece(DECK_PIECE_BAR, 0, col, row)).toBe(WELD_OK);
        welded = true;
      }
    }
    expect(welded).toBe(true);
    expect(w.refitWelded).toBe(true);
    expect(w.weldRefitPiece(DECK_PIECE_BAR, 0, -9, -9)).toBe(REFIT_ALREADY_WELDED);
  });

  it('整备等待态与本轮焊接状态进入 checksum', () => {
    const a = new World(83);
    const b = new World(83);
    expect(a.checksum()).toBe(b.checksum());
    a.refitPending = true;
    expect(a.checksum()).not.toBe(b.checksum());
    b.refitPending = true;
    expect(a.checksum()).toBe(b.checksum());
    a.refitWelded = true;
    expect(a.checksum()).not.toBe(b.checksum());
  });

  /** 摆一座满级机炮 (1,3) + 相邻弹药库 (1,2):最省事的可进化布局(进化产物 = 加特林要塞) */
  function evolveSetup(w: World): void {
    expect(placeAt(w.deck, 1, 3, CELL_WEAPON)).toBe(PLACE_OK);
    cellAt(w.deck, 1, 3)!.level = TOWER_MAX_LEVEL;
    expect(placeAt(w.deck, 1, 2, CELL_SUPPORT, TOWER_AUTOCANNON, SUP_AMMO_BAY)).toBe(PLACE_OK);
  }

  it('整备期内进化:闸门 / 吞噬支援格释放 / 塔变进化型 / 等级承接 5 / 不可逆', () => {
    const w = new World(84);
    evolveSetup(w);

    expect(w.evolveRefitTower(1, 3, 1, 2)).toBe(REFIT_NOT_ACTIVE);
    w.refitPending = true;
    expect(w.evolveRefitTower(1, 3, 1, 2)).toBe(EVOLVE_OK);

    const tower = cellAt(w.deck, 1, 3)!;
    expect(tower.towerType).toBe(TOWER_GATLING); // 塔变为进化型
    expect(tower.level).toBe(TOWER_MAX_LEVEL); // 等级承接 5
    const freed = cellAt(w.deck, 1, 2)!;
    expect(freed.content).toBe(CELL_EMPTY); // 吞噬支援格
    expect(freed.supportType).toBe(-1);
    expect(freed.occupied).toBe(true); // 腾出格子,不是拆掉甲板

    // 腾出的格子在整备期可以再放东西:空间系统的复利时刻
    expect(w.place(1, 2, CELL_SUPPORT, TOWER_AUTOCANNON, SUP_AMMO_BAY)).toBe(PLACE_OK);
    // 进化后的塔继续吃邻接:同一块弹药库、同一系节流,加成原样生效
    expect(tower.fireRateMul).toBe(AMMO.fireRateMul);

    // 不可逆:回原塔型恒 PLACE_TAKEN(与"塔不可出售"同口径),进化塔之间也没有配方
    expect(placeAt(w.deck, 1, 3, CELL_WEAPON, TOWER_AUTOCANNON)).toBe(PLACE_TAKEN);
    expect(w.evolveRefitTower(1, 3, 1, 2)).toBe(EVOLVE_NO_RECIPE);
  });

  it('进化后继续吃邻接;被 12 号焊成内部格时照样离线(03 号 online 状态机不豁免)', () => {
    const w = new World(87);
    // 两块弹药库:一块将被吞噬(1,2),一块幸存 (2,3) —— 进化只该撤掉被吃的那条线
    expect(placeAt(w.deck, 1, 3, CELL_WEAPON)).toBe(PLACE_OK);
    cellAt(w.deck, 1, 3)!.level = TOWER_MAX_LEVEL;
    expect(placeAt(w.deck, 1, 2, CELL_SUPPORT, TOWER_AUTOCANNON, SUP_AMMO_BAY)).toBe(PLACE_OK);
    expect(placeAt(w.deck, 2, 3, CELL_SUPPORT, TOWER_AUTOCANNON, SUP_AMMO_BAY)).toBe(PLACE_OK);
    w.refitPending = true;
    expect(w.evolveRefitTower(1, 3, 1, 2)).toBe(EVOLVE_OK);
    const tower = cellAt(w.deck, 1, 3)!;
    expect(tower.fireRateMul).toBe(AMMO.fireRateMul); // 幸存的那块照常连上

    // 整备期焊一块甲板把 (1,3) 四面围死:(0,3)/(2,3)/(1,2) 已在船体上,只差船尾一格 (1,4)
    expect(w.weldRefitPiece(DECK_PIECE_BAR, 0, 0, 4)).toBe(WELD_OK);
    expect(tower.online).toBe(false); // 被包成内部格 → 离线
    expect(tower.towerType).toBe(TOWER_GATLING); // 塔还在,只是灰显不开火
    // 离线塔不配连线:sync(由 weld 触发)把这条失效的线连同加成一起撤掉
    expect(tower.fireRateMul).toBe(1);
  });

  it('进化进 checksum:双世界同 seed,一边进化一边不进化逐位不同;两边同进化逐位一致', () => {
    const a = new World(85);
    const b = new World(85);
    evolveSetup(a);
    evolveSetup(b);
    a.refitPending = true;
    b.refitPending = true;
    expect(a.checksum()).toBe(b.checksum());
    expect(a.evolveRefitTower(1, 3, 1, 2)).toBe(EVOLVE_OK);
    expect(a.checksum()).not.toBe(b.checksum()); // 塔型与支援格型号都在逐格哈希里
    expect(b.evolveRefitTower(1, 3, 1, 2)).toBe(EVOLVE_OK);
    expect(a.checksum()).toBe(b.checksum());
  });

  it('进化不消耗 rng:同 seed,进化过的世界与没进化的世界随机序列逐位不变', () => {
    useTwoSegments();
    const a = new World(86);
    const b = new World(86);
    evolveSetup(a);
    evolveSetup(b);
    for (let i = 0; i < 4; i++) {
      a.step();
      b.step();
    }
    expect(a.refitPending).toBe(true);
    expect(b.refitPending).toBe(true);

    // a 在整备里多进化一次,b 直接放行 —— 进化一次 rng 都不掷,
    // 两边的随机序列必须仍在同一位置,之后几秒的出怪逐只重合
    expect(a.evolveRefitTower(1, 3, 1, 2)).toBe(EVOLVE_OK);
    a.completeRefit();
    b.completeRefit();
    for (let i = 0; i < 30; i++) {
      a.step();
      b.step();
    }
    // 出怪位置/型号是 rng 驱动的:进化扰动到任何一个随机数,这里立刻分叉。
    // 塔开火是确定性算术(不掷 rng),且此刻敌人远在射程外,不会因甲板差异提前打死谁。
    const read = (w: World): number[][] => w.enemies.items.map((e) => [e.x, e.y, e.kind]);
    expect(read(a)).toEqual(read(b));
  });
});
