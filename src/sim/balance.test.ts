/**
 * 平衡系统判定侧(平衡系统)的裁判测试。
 * 核心是**难度→火力走廊不变式**:每塔 × 每星级档的走廊火力必须落在
 * 锚线 × (1 + k×(难度−1)) × 合成溢价的 ±b 带内 —— 难的塔必须真的更强(不许偷懒),
 * 易的塔不许偷偷超线。失败时把全表报告印成调参面板:哪座塔几星越带、越了多少,一目了然。
 *
 * 覆盖专精带是宽带的防退化闸:含覆盖的完整火力指数不许飞到走廊线的 4 倍之上
 * (窄弧塔在覆盖因子上拿回来的部分,不许把「数值优势」变成「数值霸权」),
 * 也不许跌到 15% 之下(覆盖再差也不该把火力抹成摆设)。
 *
 * 真正的全局限流在 data/balance.test.ts(常数口径)与 bossGate.test.ts(闸门数学)。
 */
import { describe, expect, it } from 'vitest';
import { CORRIDOR_BAND, GATE_EDICT_LEVELS_MIN, GATE_STAR_MASS_MIN, GATE_WEAPONS_MIN } from '../data/balance';
import { createEdictLevels } from '../data/edicts';
import {
  TOWERS,
  TOWER_ARC,
  TOWER_AUTOCANNON,
  TOWER_DELUGE,
  TOWER_MISSILE_NEST,
  TOWER_MORTAR,
  TOWER_PD,
  TOWER_THORN,
  TOWER_THUNDER,
} from '../data/towers';
import {
  aoeFactor,
  belowGateMaxDps,
  chainFactor,
  corridorLine,
  corridorPower,
  corridorReport,
  edictTotalLevels,
  gateLegal,
  neutralBuffs,
  refGateDps,
  slotFor,
  slotPowerDps,
} from './balance';

/** 全表体检报告印成调参面板:失败信息里直接可读「谁越带、越了多少」 */
function formatReport(): string {
  const rows = corridorReport();
  const pad = (s: string, w: number) => s.padEnd(w);
  const lines = [
    `${pad('塔', 8)} ${pad('星', 4)} ${pad('难度', 7)} ${pad('火力', 9)} ${pad('锚线', 9)} 残差比`,
  ];
  for (const r of rows) {
    const flag = Math.abs(r.ratio - 1) > CORRIDOR_BAND ? ' ← 越带' : '';
    lines.push(
      `${pad(r.name, 8)} ${pad(String(r.stars), 4)} ${pad(r.difficulty.toFixed(2), 7)} ${pad(
        r.power.toFixed(1),
        9,
      )} ${pad(r.line.toFixed(1), 9)} ${r.ratio.toFixed(2)}${flag}`,
    );
  }
  return lines.join('\n');
}

describe('难度-火力走廊不变式', () => {
  it('每星级每塔走廊火力落在锚线 ±20% 带内(合成塔带获取溢价)—— 难塔不许偷懒,易塔不许超线', () => {
    const bad = corridorReport().filter((r) => Math.abs(r.ratio - 1) > CORRIDOR_BAND);
    if (bad.length > 0) {
      // 失败信息 = 调参面板:对照这行表改 data/towers.ts 的占位数字即可
      throw new Error(`走廊体检 ${bad.length} 处越带:\n${formatReport()}`);
    }
    expect(bad).toEqual([]);
  });

  it('锚塔自身恒压线:机炮三档的走廊火力 = 锚线(锚线就是机炮自己的火力,定义重放)', () => {
    const gun = TOWERS[TOWER_AUTOCANNON]!;
    for (const stars of [1, 2, 3]) {
      const slot = slotFor(TOWER_AUTOCANNON, stars);
      // 走廊口径不含覆盖:机炮的射程成长会让含覆盖指数合法地超线(那是专精带管的事)
      const ratio = corridorPower(slot, gun, neutralBuffs()) / corridorLine(gun, stars);
      expect(Math.abs(ratio - 1)).toBeLessThanOrEqual(1e-9);
    }
  });
});

describe('覆盖专精带(宽带,防退化)', () => {
  it('含覆盖的完整火力指数落在走廊线的 [0.15, 4] 带内 —— 窄弧塔的覆盖惩罚不许抹平火力,也不许霸权', () => {
    const rows = corridorReport();
    for (const r of rows) {
      const def = TOWERS[r.type]!;
      const full = slotPowerDps(slotFor(r.type, r.stars), def, neutralBuffs());
      expect(full).toBeGreaterThanOrEqual(r.line * 0.15);
      expect(full).toBeLessThanOrEqual(r.line * 4);
    }
  });
});

describe('火力指数契约', () => {
  it('落点因子随落点半径单调:迫击炮 90 < 焦土 105 < 导弹巢 110', () => {
    const m = aoeFactor(TOWERS[TOWER_MORTAR]!);
    const d = aoeFactor(TOWERS[TOWER_DELUGE]!);
    const n = aoeFactor(TOWERS[TOWER_MISSILE_NEST]!);
    expect(m).toBeLessThan(d);
    expect(d).toBeLessThan(n);
  });

  it('链跳因子随链数单调,且 1★→3★ 的成长链数同样单调(电弧 < 雷霆)', () => {
    const arc1 = chainFactor(TOWERS[TOWER_ARC]!, 1);
    const arc3 = chainFactor(TOWERS[TOWER_ARC]!, 3);
    const thunder = chainFactor(TOWERS[TOWER_THUNDER]!, 3);
    expect(arc1).toBeLessThan(arc3);
    expect(arc3).toBeLessThan(thunder);
  });

  it('坏表兜底:衰减系数 ≥ 1 退化成链数、≤ 0 退化成 1(不除 0、不反向放大)', () => {
    // 逐字段克隆再改坏,不动原表(与「临时改字段再 afterEach 还原」同一条测试口径)
    const def = { ...TOWERS[TOWER_ARC]!, chainCount: 4, chainFalloff: 1, growth: { ...TOWERS[TOWER_ARC]!.growth, chain: 0 } };
    expect(chainFactor(def, 1)).toBeCloseTo(4, 10);
    const dead = { ...def, chainFalloff: 0 };
    expect(chainFactor(dead, 1)).toBe(1);
  });
});

describe('Boss 闸门规则', () => {
  it('质量口径:3×2★ 与 3★+2★+1★ 合法;2★+2×1★(质量 4)不合法;8×1★ 天然合法(已知退化,留给再调)', () => {
    const edicts = createEdictLevels();
    edicts[0] = GATE_EDICT_LEVELS_MIN;
    const deck = (weapons: [number, number][]) => weapons.map(([type, stars]) => slotFor(type, stars));

    expect(gateLegal(deck([[TOWER_ARC, 2], [TOWER_PD, 2], [TOWER_MORTAR, 2]]), edicts)).toBe(true);
    expect(gateLegal(deck([[TOWER_ARC, 3], [TOWER_PD, 2], [TOWER_MORTAR, 1]]), edicts)).toBe(true);
    expect(gateLegal(deck([[TOWER_ARC, 2], [TOWER_PD, 1], [TOWER_MORTAR, 1]]), edicts)).toBe(false);
    expect(gateLegal(deck([[TOWER_ARC, 1], [TOWER_PD, 1], [TOWER_MORTAR, 1], [TOWER_AUTOCANNON, 1], [TOWER_MISSILE_NEST, 1], [TOWER_THORN, 1], [TOWER_DELUGE, 1], [TOWER_THUNDER, 1]]), edicts)).toBe(true);
    // 质量 ≥ 6 是用户口径/展示规则,真闸门是 refGateDps —— 这条退化已写进 gateLegal 注释
  });

  it('法令口径:5 层任意构成达标(重复叠层算),4 层不达标;总层数与条数是两码事', () => {
    const levels = createEdictLevels();
    expect(edictTotalLevels(levels)).toBe(0);
    levels[0] = 3; // 弹药协议 3 层 + 装甲协议 2 层 = 5 层、2 条
    levels[3] = 2;
    expect(edictTotalLevels(levels)).toBe(GATE_EDICT_LEVELS_MIN);
    levels[3] = 1;
    expect(edictTotalLevels(levels)).toBe(GATE_EDICT_LEVELS_MIN - 1);
    expect(edictTotalLevels(levels)).toBeLessThan(GATE_EDICT_LEVELS_MIN);
  });

  it('枚举口径:闸门锚定 DPS 是正数,且「质量≤5」的上界配置 DPS 同样是正数(诊断口径,非判据)', () => {
    expect(refGateDps()).toBeGreaterThan(0);
    expect(belowGateMaxDps()).toBeGreaterThan(0);
  });

  it('闸门常数与枚举自洽:质量下限与武器把数下限都够得着(8 槽上限内)', () => {
    expect(GATE_STAR_MASS_MIN).toBeLessThanOrEqual(8 * 3);
    expect(GATE_WEAPONS_MIN).toBeLessThanOrEqual(8);
  });
});
