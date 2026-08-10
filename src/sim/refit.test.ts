import { afterEach, describe, expect, it } from 'vitest';
import { SIM_DT } from '../core/loop';
import { DECK_PIECE_BAR } from '../data/deckPieces';
import {
  DOCK_EDICT_COUNT,
  DOCK_EDICT_PRICE,
  DOCK_REPAIR_FRACTION,
  DOCK_REPAIR_PRICE,
  REFIT_HEAL_FRACTION,
} from '../data/economy';
import { EDICT_KIND_COUNT, EDICT_RAPID, EDICT_TRACER, edictMask } from '../data/edicts';
import { KIND_SWARM } from '../data/enemies';
import { SUP_AMMO_BAY, SUPPORTS } from '../data/supports';
import { TOWER_AUTOCANNON, TOWER_GATLING, TOWER_MAX_LEVEL } from '../data/towers';
import { UNLOCKS } from '../data/unlocks';
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
  DOCK_NO_STARCOINS,
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

/**
 * 船坞商店(21 号)的确定性:货架掷定(跨段那帧的 rng 消耗口径)与购买零 rng。
 * 购买本身的账(扣费/生效/失败原子)钉在 world.test.ts —— 这里只钉与随机序列有关的那一半:
 * 货架掷定的消耗次数、过滤口径、以及"买没买"扰动不到出怪序列(照上面"进化不消耗 rng"
 * 用例的形制;两处各管一摊,别挪来挪去)。
 */
describe('船坞商店(21 号:货架掷定与购买零 rng)', () => {
  /** 固定随机序列 + 计数器(与 world.test.ts 的星币重摇 describe 同款):类型私有字段使 Rng 名义化 */
  class CountingRng {
    calls = 0;
    constructor(private readonly values: number[] = []) {}
    next(): number {
      return this.values[this.calls++] ?? 0;
    }
  }

  /** 两段空脚本(无流/无侧压/无精英):stepWaves 零 rng,跨段那一帧的消耗才数得清 */
  function useEmptySegments(): void {
    tuning.stressSpawn = false;
    WAVE_SEGMENTS.splice(
      0,
      WAVE_SEGMENTS.length,
      segment({ name: '旧波' }),
      segment({ name: '新波', duration: 1 }),
    );
  }

  /** 走到跨段那一帧(旧段 0.05s = 3 帧走完,第 4 帧跨段)并断言整备挂起 */
  function reachRefit(w: World): void {
    for (let i = 0; i < 4; i++) w.step();
    expect(w.refitPending).toBe(true);
  }

  it('跨段那一帧掷定货架:每个货架位恰消耗 1 次 rng,空池也照样消耗', () => {
    useEmptySegments();
    const w = new World(881);
    const counting = new CountingRng([0.9, 0.9]);
    Object.defineProperty(w, 'rng', { value: counting, configurable: true });
    reachRefit(w);
    expect(counting.calls).toBe(DOCK_EDICT_COUNT); // 除货架外零消耗:消耗次数与池大小无关
    expect(w.dockEdictOffers.length).toBe(DOCK_EDICT_COUNT); // 池没被掏空:两个货架位都摆上了
    for (const t of w.dockEdictOffers) {
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThan(EDICT_KIND_COUNT);
    }
  });

  it('同 seed 双世界:货架逐位一致(掷定在跨段那一帧,两边消耗相同的 rng)', () => {
    useEmptySegments();
    const a = new World(881);
    const b = new World(881);
    reachRefit(a);
    reachRefit(b);
    expect(b.dockEdictOffers).toEqual(a.dockEdictOffers);
  });

  it('货架过滤:已持有与未解锁的绝不上架(与三选一候选的过滤同一条口径)', () => {
    // 缺省掩码 0:急速协议(唯一带解锁闸门的法令)绝不出现(结构上成立:池里根本没有它)
    for (let seed = 0; seed < 12; seed++) {
      useEmptySegments();
      const w = new World(900 + seed);
      reachRefit(w);
      expect(w.dockEdictOffers).not.toContain(EDICT_RAPID);
    }
    // 掩码全开 + 定制掷值:同一下标就能掷中急速协议(对照上面"掷不中")
    useEmptySegments();
    const open = new CountingRng([6.5 / 7, 6.5 / 7]);
    const wOpen = new World(1, (1 << UNLOCKS.length) - 1);
    Object.defineProperty(wOpen, 'rng', { value: open, configurable: true });
    reachRefit(wOpen);
    expect(wOpen.dockEdictOffers[0]).toBe(EDICT_RAPID); // 7 型池的最后一位
    expect(wOpen.dockEdictOffers[1]).not.toBe(EDICT_RAPID); // 第二格不摆重复卡
    // 已持有:跨段前先持有曳光协议,货架就不再摆它(法令不叠级,买了也是白买)
    useEmptySegments();
    const held = new World(2);
    held.edicts = edictMask(EDICT_TRACER);
    reachRefit(held);
    expect(held.dockEdictOffers).not.toContain(EDICT_TRACER);
  });

  it('购买零 rng:同 seed 双世界,一边在整备里买法令/修复一边不买,之后出怪逐只重合', () => {
    useTwoSegments();
    const a = new World(882);
    const b = new World(882);
    for (let i = 0; i < 4; i++) {
      a.step();
      b.step();
    }
    expect(a.refitPending).toBe(true);
    expect(a.dockEdictOffers).toEqual(b.dockEdictOffers); // 货架同 seed 逐位一致

    a.starCoins = b.starCoins = 999;
    a.ship.hp = 1; // a 残血才买得起修复(b 满血不买 —— 这正是"买没买"的分叉点)
    if (a.dockEdictOffers.length > 0) expect(a.buyDockEdict(0)).toBe(0);
    expect(a.buyDockRepair()).toBe(0);
    expect(a.starCoins).toBeLessThan(b.starCoins); // 扣费了,但没动任何随机数
    expect(a.completeRefit()).toBe(true);
    expect(b.completeRefit()).toBe(true);
    for (let i = 0; i < 30; i++) {
      a.step();
      b.step();
    }
    // 出怪位置/型号是 rng 驱动的:购买扰动到任何一个随机数,这里立刻分叉。
    // 两边都没放塔,敌人在射程外,法令/血量的差异反哺不到出怪(与"进化不消耗 rng"同款判据)
    const read = (w: World): number[][] => w.enemies.items.map((e) => [e.x, e.y, e.kind]);
    expect(read(a)).toEqual(read(b));
  });

  it('购买失败(星币不足)不消耗 rng:失败尝试之后序列原地不动', () => {
    useEmptySegments();
    const w = new World(883);
    const counting = new CountingRng([0.5, 0.5, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25]);
    Object.defineProperty(w, 'rng', { value: counting, configurable: true });
    reachRefit(w);
    expect(counting.calls).toBe(DOCK_EDICT_COUNT);
    // 星币为 0:买法令与修复都被拒,一次 rng 都不许动(照 rerollOffer 的"失败不许推序列")
    w.ship.hp = 1;
    expect(w.buyDockEdict(0)).toBe(DOCK_NO_STARCOINS);
    expect(w.buyDockRepair()).toBe(DOCK_NO_STARCOINS);
    expect(counting.calls).toBe(DOCK_EDICT_COUNT);
  });

  it('整备里买过法令/修复后完成整备:付费 40% 与免费 30% 各算各的账,货架随整备清空', () => {
    useEmptySegments();
    const w = new World(884);
    w.starCoins = DOCK_EDICT_PRICE + DOCK_REPAIR_PRICE;
    reachRefit(w);
    expect(w.dockEdictOffers.length).toBe(DOCK_EDICT_COUNT);
    w.ship.hp = 1;
    const edictBefore = w.edicts;
    expect(w.buyDockEdict(0)).toBe(0);
    const maxHp = w.ship.maxHp; // 结构加固可能已把上限抬高:以购买后的上限为准
    expect(w.buyDockRepair()).toBe(0);
    const paid = Math.ceil(maxHp * DOCK_REPAIR_FRACTION);
    expect(w.ship.hp).toBe(Math.min(maxHp, 1 + paid)); // 付费修复当场生效
    expect(w.edicts).not.toBe(edictBefore); // 法令真的买到手了
    expect(w.completeRefit()).toBe(true);
    const free = Math.ceil(maxHp * REFIT_HEAL_FRACTION);
    expect(w.ship.hp).toBe(Math.min(maxHp, 1 + paid + free)); // 免费回血照常在结束时结算
    expect(w.dockEdictOffers).toEqual([]); // 货架随整备结束清空,下一轮跨段重掷
  });
});
