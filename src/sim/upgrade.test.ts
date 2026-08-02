/**
 * 三选一的纯逻辑与 World 经济接线。候选规则在本文件钉,卡片 DOM 在 ui/upgradeFlow.test.ts 钉;
 * 真脚本的 12–15 次平衡窗口另见 sim/economy.test.ts。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Rng } from '../core/rng';
import {
  OFFER_WEIGHT_DECK,
  OFFER_WEIGHT_SUPPORT,
  OFFER_WEIGHT_TOWER,
  UPGRADE_CHOICE_COUNT,
  UPGRADE_SKIP_REFUND,
} from '../data/economy';
import { DECK_PIECES } from '../data/deckPieces';
import { SUP_AMMO_BAY, SUPPORTS } from '../data/supports';
import {
  TOWER_AUTOCANNON,
  TOWER_KIND_COUNT,
  TOWER_LASER,
  TOWER_MAX_LEVEL,
  TOWERS,
} from '../data/towers';
import { tuning } from './config';
import {
  CELL_EMPTY,
  CELL_SUPPORT,
  CELL_WEAPON,
  cellAt,
  createDeck,
  canWeldPiece,
  isPlaceSuccess,
  PLACE_NO_CELL,
  placeAt,
  WELD_OK,
} from './deck';
import { RESULT_WIN, World } from './world';
import {
  OFFER_SUPPORT,
  OFFER_TOWER,
  OFFER_DECK,
  optionContent,
  optionLabel,
  optionLegalCells,
  optionHasLegalPlacement,
  optionSupportType,
  optionTowerType,
  rollUpgradeOffer,
  type UpgradeOption,
  UPGRADE_NO_OFFER,
} from './upgrade';

/** 固定随机序列 + 计数器:类型私有字段使 Rng 名义化,测试桩经 unknown 显式转入。 */
class CountingRng {
  calls = 0;
  constructor(private readonly values: number[] = []) {}
  next(): number {
    return this.values[this.calls++] ?? 0;
  }
}

const tower = (type: number, level = 0): UpgradeOption => ({ kind: OFFER_TOWER, type, level });
const support = (type: number): UpgradeOption => ({ kind: OFFER_SUPPORT, type, level: 0 });
const deckPiece = (type: number): UpgradeOption => ({ kind: OFFER_DECK, type, level: 0 });

function fillWithSupportsExcept(deck: ReturnType<typeof createDeck>, except: number): void {
  for (let i = 0; i < deck.cells.length; i++) {
    if (i === except) continue;
    const c = deck.cells[i]!;
    expect(placeAt(deck, c.col, c.row, CELL_SUPPORT, TOWER_AUTOCANNON, SUP_AMMO_BAY)).toBe(0);
  }
}

describe('候选翻译与合法格', () => {
  it('塔/设施各自翻译成唯一一套 place 参数,不用的型号落回合法占位', () => {
    const gun = tower(TOWER_LASER, 2);
    expect(optionContent(gun)).toBe(CELL_WEAPON);
    expect(optionTowerType(gun)).toBe(TOWER_LASER);
    expect(optionSupportType(gun)).toBe(SUP_AMMO_BAY);

    const bay = support(SUP_AMMO_BAY);
    expect(optionContent(bay)).toBe(CELL_SUPPORT);
    expect(optionTowerType(bay)).toBe(TOWER_AUTOCANNON);
    expect(optionSupportType(bay)).toBe(SUP_AMMO_BAY);

    const hull = deckPiece(0);
    expect(optionContent(hull)).toBe(CELL_EMPTY);
    expect(optionTowerType(hull)).toBe(TOWER_AUTOCANNON);
    expect(optionSupportType(hull)).toBe(SUP_AMMO_BAY);
  });

  it('名字只取数值表,型号越界把原始下标报出来', () => {
    expect(optionLabel(tower(TOWER_AUTOCANNON))).toBe(TOWERS[TOWER_AUTOCANNON]!.name);
    expect(optionLabel(support(SUP_AMMO_BAY))).toBe(SUPPORTS[SUP_AMMO_BAY]!.name);
    expect(optionLabel(deckPiece(0))).toBe(DECK_PIECES[0]!.name);
    expect(optionLabel(tower(99))).toContain('99');
    expect(optionLabel(support(88))).toContain('88');
  });

  it('塔候选 = 空边缘格 + 同型未满级格;内部空格与异型已占格都不高亮', () => {
    const deck = createDeck();
    expect(placeAt(deck, 0, 1, CELL_WEAPON, TOWER_AUTOCANNON)).toBe(0);
    expect(placeAt(deck, 2, 1, CELL_WEAPON, TOWER_LASER)).toBe(0);
    const cells: number[] = [];

    expect(optionLegalCells(deck, tower(TOWER_AUTOCANNON, 1), cells)).toBe(9);
    expect(cells).toContain(3); // (0,1) 同型塔可叠级
    expect(cells).not.toContain(4); // (1,1) 内部空格不能放武器塔
    expect(cells).not.toContain(5); // (2,1) 异型塔已占
  });

  it('设施候选能落在任意空占用格,但不能叠在已有内容上', () => {
    const deck = createDeck();
    placeAt(deck, 0, 0, CELL_WEAPON, TOWER_AUTOCANNON);
    const cells: number[] = [];
    expect(optionLegalCells(deck, support(SUP_AMMO_BAY), cells)).toBe(deck.cells.length - 1);
    expect(cells).not.toContain(0);
    expect(cells).toContain(4); // 内部格正是设施的主场
  });
});

describe('rollUpgradeOffer', () => {
  it('每个候选位恰好消耗两次 rng,候选不重复且每张至少有一格合法', () => {
    const deck = createDeck();
    const rng = new CountingRng([0, 0, 0.99, 0.99, 0, 0.5]);
    const out: UpgradeOption[] = [];
    const count = rollUpgradeOffer(deck, rng as unknown as Rng, out);

    expect(rng.calls).toBe(UPGRADE_CHOICE_COUNT * 2);
    expect(count).toBe(UPGRADE_CHOICE_COUNT);
    expect(out).toHaveLength(count);
    expect(new Set(out.map((o) => `${o.kind}:${o.type}`)).size).toBe(count);
    for (const opt of out) expect(optionHasLegalPlacement(deck, opt)).toBe(true);
  });

  it('同 seed + 同甲板得到逐字段相同的候选', () => {
    const a: UpgradeOption[] = [];
    const b: UpgradeOption[] = [];
    rollUpgradeOffer(createDeck(), new Rng(20260802), a);
    rollUpgradeOffer(createDeck(), new Rng(20260802), b);
    expect(a).toEqual(b);
  });

  it('掷中的类别没得放就退到其他类,且不额外消耗 rng', () => {
    const deck = createDeck();
    // 十个边缘格全被设施占住,只留两个内部空格:塔类完全没得放,设施仍可放。
    for (const c of deck.cells) {
      if (c.exposedCount > 0) placeAt(deck, c.col, c.row, CELL_SUPPORT, TOWER_AUTOCANNON, SUP_AMMO_BAY);
    }
    const rng = new CountingRng(new Array(UPGRADE_CHOICE_COUNT * 2).fill(0)); // 每位都先掷中塔类
    const out: UpgradeOption[] = [];
    rollUpgradeOffer(deck, rng as unknown as Rng, out);

    expect(rng.calls).toBe(UPGRADE_CHOICE_COUNT * 2);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((opt) => opt.kind === OFFER_SUPPORT)).toBe(true);
  });

  it('满甲板仍可抽扩建;若抽到同型叠级卡,level 取该型最高等级', () => {
    const deck = createDeck();
    const targetIndex = 0;
    const target = deck.cells[targetIndex]!;
    placeAt(deck, target.col, target.row, CELL_WEAPON, TOWER_AUTOCANNON);
    placeAt(deck, target.col, target.row, CELL_WEAPON, TOWER_AUTOCANNON); // Lv2
    placeAt(deck, target.col, target.row, CELL_WEAPON, TOWER_AUTOCANNON); // Lv3
    fillWithSupportsExcept(deck, targetIndex);

    const out: UpgradeOption[] = [];
    expect(rollUpgradeOffer(deck, new Rng(7), out)).toBe(3);
    expect(out.some((o) => o.kind === OFFER_DECK)).toBe(true);
    const gun = out.find((o) => o.kind === OFFER_TOWER);
    if (gun) expect(gun).toEqual(tower(TOWER_AUTOCANNON, 3));
  });

  it('所有既有格都占满且唯一塔也满级 → 回退甲板拼块,六次 rng 一次不少', () => {
    const deck = createDeck();
    const target = deck.cells[0]!;
    for (let lv = 0; lv < TOWER_MAX_LEVEL; lv++) {
      expect(isPlaceSuccess(placeAt(deck, target.col, target.row, CELL_WEAPON, TOWER_AUTOCANNON))).toBe(true);
    }
    fillWithSupportsExcept(deck, 0);
    const rng = new CountingRng();
    const stale = [tower(4), support(2)];

    expect(rollUpgradeOffer(deck, rng as unknown as Rng, stale)).toBe(3);
    expect(stale.every((o) => o.kind === OFFER_DECK)).toBe(true);
    expect(rng.calls).toBe(UPGRADE_CHOICE_COUNT * 2);
  });

  it('空甲板的塔型池覆盖数值表范围,绝不生成越界型号', () => {
    for (let seed = 0; seed < 40; seed++) {
      const out: UpgradeOption[] = [];
      rollUpgradeOffer(createDeck(), new Rng(seed), out);
      for (const opt of out) {
        if (opt.kind === OFFER_TOWER) expect(opt.type).toBeLessThan(TOWER_KIND_COUNT);
        else if (opt.kind === OFFER_SUPPORT) expect(opt.type).toBeLessThan(SUPPORTS.length);
        else expect(opt.type).toBeLessThan(DECK_PIECES.length);
      }
    }
  });

  it('类别轮盘按 45:25:15 解释并在法令缺席时按总和 85 归一化', () => {
    expect([OFFER_WEIGHT_TOWER, OFFER_WEIGHT_SUPPORT, OFFER_WEIGHT_DECK]).toEqual([45, 25, 15]);
    const deck = createDeck();
    const out: UpgradeOption[] = [];
    rollUpgradeOffer(
      deck,
      new CountingRng([0.1, 0, 0.6, 0, 0.95, 0]) as unknown as Rng,
      out,
    );
    expect(out.map((o) => o.kind)).toEqual([OFFER_TOWER, OFFER_SUPPORT, OFFER_DECK]);
  });
});

const WORLD_TUNING = { stressSpawn: true, stressEnemies: 0 };
const tuningBefore = { stressSpawn: tuning.stressSpawn, stressEnemies: tuning.stressEnemies };

afterEach(() => Object.assign(tuning, tuningBefore));

function offerWorld(seed = 1): World {
  Object.assign(tuning, WORLD_TUNING);
  const w = new World(seed);
  w.scrap = w.upgradeCost;
  w.step();
  return w;
}

describe('World 三选一经济接线', () => {
  it('够钱的帧尾生成一次候选并只响一次回调;World 自己不停 tick', () => {
    Object.assign(tuning, WORLD_TUNING);
    const w = new World(10);
    let offers = 0;
    w.onUpgradeOffer = () => offers++;
    w.scrap = w.upgradeCost;

    w.step();
    expect(w.offer.length).toBeGreaterThan(0);
    expect(offers).toBe(1);
    const tick = w.tick;
    w.step();
    expect(w.tick).toBe(tick + 1);
    expect(offers).toBe(1); // 候选没结算前不重掷、不重响
  });

  it('合法放置才扣费、upgrades++、清 offer;被拒时三笔账原样不动', () => {
    const w = offerWorld(11);
    const beforeScrap = w.scrap;
    const beforeOffer = w.offer.map((o) => ({ ...o }));
    expect(w.takeUpgrade(0, 99, 99)).toBe(PLACE_NO_CELL);
    expect(w.scrap).toBe(beforeScrap);
    expect(w.upgrades).toBe(0);
    expect(w.offer).toEqual(beforeOffer);

    const opt = w.offer[0]!;
    if (opt.kind === OFFER_DECK) {
      let welded = false;
      for (let row = -4; row <= 7 && !welded; row++) {
        for (let col = -4; col <= 6 && !welded; col++) {
          if (canWeldPiece(w.deck, opt.type, 0, col, row) !== WELD_OK) continue;
          expect(w.takeUpgrade(0, col, row, 0)).toBe(WELD_OK);
          welded = true;
        }
      }
      expect(welded).toBe(true);
    } else {
      const cells: number[] = [];
      optionLegalCells(w.deck, opt, cells);
      const cell = w.deck.cells[cells[0]!]!;
      expect(isPlaceSuccess(w.takeUpgrade(0, cell.col, cell.row))).toBe(true);
    }
    expect(w.scrap).toBe(0);
    expect(w.upgrades).toBe(1);
    expect(w.offer).toEqual([]);
  });

  it('跳过扣本轮费用、返还封顶额并算一次升级;无待选不动账', () => {
    const w = offerWorld(12);
    w.scrap += 7;
    const cost = w.upgradeCost;
    expect(w.skipUpgrade()).toBe(true);
    expect(w.scrap).toBe(7 + Math.min(UPGRADE_SKIP_REFUND, cost));
    expect(w.upgrades).toBe(1);
    expect(w.offer).toEqual([]);

    const snapshot = [w.scrap, w.upgrades];
    expect(w.skipUpgrade()).toBe(false);
    expect(w.takeUpgrade(0, 0, 0)).toBe(UPGRADE_NO_OFFER);
    expect([w.scrap, w.upgrades]).toEqual(snapshot);
  });

  it('既有甲板全满时仍弹拼块卡,不再把可扩建的船误判成“彻底没得放”', () => {
    Object.assign(tuning, WORLD_TUNING);
    const w = new World(13);
    for (const c of w.deck.cells) placeAt(w.deck, c.col, c.row, CELL_SUPPORT, 0, SUP_AMMO_BAY);
    let offers = 0;
    w.onUpgradeOffer = () => offers++;
    const cost = w.upgradeCost;
    w.scrap = cost;

    w.step();
    expect(w.offer.length).toBeGreaterThan(0);
    expect(w.offer.every((o) => o.kind === OFFER_DECK)).toBe(true);
    expect(offers).toBe(1);
    expect(w.upgrades).toBe(0);
    expect(w.scrap).toBe(cost);
  });

  it('局终之后不再生成升级候选', () => {
    Object.assign(tuning, WORLD_TUNING);
    const w = new World(14);
    w.result = RESULT_WIN;
    w.scrap = w.upgradeCost;
    w.step();
    expect(w.offer).toEqual([]);
    expect(w.upgrades).toBe(0);
  });

  it('upgrades 与 offer 逐字段进 checksum,upgradeCost 是派生量不另存状态', () => {
    const a = offerWorld(15);
    const b = offerWorld(15);
    expect(a.checksum()).toBe(b.checksum());

    a.upgrades++;
    expect(a.checksum()).not.toBe(b.checksum());
    a.upgrades--;
    expect(a.checksum()).toBe(b.checksum());

    a.offer[0]!.type++;
    expect(a.checksum()).not.toBe(b.checksum());
    a.offer[0]!.type--;
    expect(a.checksum()).toBe(b.checksum());
  });
});
