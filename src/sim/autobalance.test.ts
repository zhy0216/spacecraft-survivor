/**
 * 自动平衡求解器(平衡系统)的裁判测试。
 * 与 data/enemies.test.ts 同一条「快照 + afterEach 还原」口径:改表用例先存原值、跑完写回 ——
 * 求解器契约三条:改坏的表能被拉回带内;已平衡的表零编辑(幂等);锚塔与签名字段永不触碰。
 * 文本写回(applyEdits)是纯函数,用合成文本钉块作用域 / 缩进消歧 / 幂等 / 坏编辑防御。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BOSS } from '../data/enemies';
import {
  FX_MORTAR,
  STAR_MAX,
  TOWERS,
  TOWER_AUTOCANNON,
  TOWER_LASER,
  TOWER_MORTAR,
  TOWER_PD,
  TOWER_STORM_CANNON,
  TOWER_KIND_COUNT,
  type TowerDef,
} from '../data/towers';
import { bossHpMulForGate, corridorAnchorP, corridorOk, corridorPower, corridorRatio, neutralBuffs, slotFor, towerStars } from './balance';
import {
  applyEdits,
  applyEditsToTable,
  makeBossEdit,
  pinDamage,
  solveAll,
  solveGrowth,
  solveTowerEdits,
  toSig2,
  type BalanceEdit,
} from './autobalance';

// —— 快照 / 还原(与 enemies.test.ts 同口径)——
type TweakKey = 'damage' | 'aoeDamage' | 'growth';
const snapshots: { def: TowerDef; key: TweakKey; value: number }[] = [];

function tweak(type: number, key: TweakKey, value: number): TowerDef {
  const def = TOWERS[type]!;
  const cur = key === 'growth' ? def.growth.damage : def[key];
  snapshots.push({ def, key, value: cur });
  if (key === 'growth') def.growth.damage = value;
  else def[key] = value;
  return def;
}

afterEach(() => {
  for (const s of snapshots.reverse()) {
    if (s.key === 'growth') s.def.growth.damage = s.value;
    else s.def[s.key] = s.value;
  }
  snapshots.length = 0;
});

describe('自动平衡求解器', () => {
  it('已平衡的表:零编辑(幂等 —— 跑两次还是零编辑,注释与数值逐字确定)', () => {
    expect(solveTowerEdits()).toEqual([]);
    const result = solveAll();
    expect(result.towerEdits).toEqual([]);
    expect(result.bossEdit).toBeNull();
  });

  it('临时改坏单发:pinDamage 一次线性解精确回线,圆整后全星回带(激光 3.3 → 2.0)', () => {
    tweak(TOWER_LASER, 'damage', 2.0);
    const pin = pinDamage(TOWERS[TOWER_LASER]!, 1);
    expect(Number.isFinite(pin)).toBe(true);
    tweak(TOWER_LASER, 'damage', pin); // 应用未圆整值:1★ 残差比 = 1(浮点精度内)
    expect(corridorRatio(TOWERS[TOWER_LASER]!, 1)).toBeCloseTo(1, 9);
    // 完整求解:圆整候选择优后全部星级回带
    const edits = solveTowerEdits();
    applyEditsToTable(edits);
    for (const s of towerStars(TOWERS[TOWER_LASER]!)) expect(corridorOk(TOWERS[TOWER_LASER]!, s)).toBe(true);
  });

  it('临时改坏成长档:solveGrowth 二分收敛回手调值附近,应用后 2★/3★ 全部回带(激光 1.8 → 1.4)', () => {
    tweak(TOWER_LASER, 'growth', 1.4);
    const g = solveGrowth(TOWERS[TOWER_LASER]!);
    expect(g).toBeCloseTo(1.81, 2); // 手调 1.8,端到端精确解 1.81
    tweak(TOWER_LASER, 'growth', g);
    const target = corridorAnchorP(3) / corridorAnchorP(1);
    const probe = { ...TOWERS[TOWER_LASER]!, growth: { ...TOWERS[TOWER_LASER]!.growth, damage: g } };
    const p1 = corridorPower(slotFor(TOWER_LASER, 1), probe, neutralBuffs());
    const p3 = corridorPower(slotFor(TOWER_LASER, 3), probe, neutralBuffs());
    expect(p3 / p1).toBeCloseTo(target, 6); // 端到端步进追平锚线(未圆整口径)
  });

  it('弹药系 ceil 折点不破坏线性:点防 1★ 压线同样精确', () => {
    tweak(TOWER_PD, 'damage', 0.8);
    const pin = pinDamage(TOWERS[TOWER_PD]!, 1);
    tweak(TOWER_PD, 'damage', pin);
    expect(corridorRatio(TOWERS[TOWER_PD]!, 1)).toBeCloseTo(1, 9);
  });

  it('合成塔只解 3★ 伤害旋钮:成长档永不动(风暴 8 → 5)', () => {
    tweak(TOWER_STORM_CANNON, 'damage', 5);
    const edits = solveTowerEdits().filter((e) => e.anchor === TOWER_STORM_CANNON);
    expect(edits.length).toBe(1);
    expect(edits[0]!.field).toBe('damage');
    applyEditsToTable(edits);
    expect(corridorOk(TOWERS[TOWER_STORM_CANNON]!, STAR_MAX)).toBe(true);
  });

  it('迫击炮系走 aoeDamage 旋钮:damage 恒 0 不许碰', () => {
    tweak(TOWER_MORTAR, 'aoeDamage', 10);
    const edits = solveTowerEdits().filter((e) => e.anchor === TOWER_MORTAR);
    expect(edits.length).toBeGreaterThanOrEqual(1);
    expect(edits.every((e) => e.field !== 'damage')).toBe(true);
    expect(edits.some((e) => e.field === 'aoeDamage')).toBe(true);
    expect(TOWERS[TOWER_MORTAR]!.damage).toBe(0); // FX_MORTAR 五件套自洽(towers.test 钉死)
  });

  it('全表扰动回归:13 塔伤害 ×0.5、基础塔成长 ×0.8 改坏后,求解 → 应用 → 全部回带', () => {
    for (const def of TOWERS) {
      if (def.type === TOWER_AUTOCANNON) continue;
      if (def.fx === FX_MORTAR) tweak(def.type, 'aoeDamage', def.aoeDamage * 0.5);
      else tweak(def.type, 'damage', def.damage * 0.5);
      if (![TOWER_STORM_CANNON].includes(def.type) && def.type > TOWER_MORTAR) continue; // 合成塔不碰成长
      if (towerStars(def).length > 1 && def.type <= 5) tweak(def.type, 'growth', def.growth.damage * 0.8);
    }
    const edits = solveTowerEdits();
    applyEditsToTable(edits);
    for (const def of TOWERS) {
      for (const s of towerStars(def)) {
        expect(corridorOk(def, s)).toBe(true);
      }
    }
  });

  it('锚塔与签名字段永不被提议编辑:无机炮锚,字段只在伤害三档内', () => {
    // 先改坏一片再求解,验证编辑清单的形状(锚塔零编辑)
    tweak(TOWER_LASER, 'damage', 1.0);
    tweak(TOWER_PD, 'growth', 1.2);
    const edits = solveTowerEdits();
    expect(edits.some((e) => e.anchor === TOWER_AUTOCANNON)).toBe(false);
    for (const e of edits) {
      expect(['damage', 'aoeDamage', 'growth.damage']).toContain(e.field);
      expect(e.anchor).toBeGreaterThanOrEqual(0);
      expect(e.anchor).toBeLessThan(TOWER_KIND_COUNT);
    }
  });

  it('toSig2 口径:2 位有效数字、整数原样(1.704→1.7、3.28→3.3、52.2→52、87→87)', () => {
    expect(toSig2(1.704)).toBe(1.7);
    expect(toSig2(3.28)).toBe(3.3);
    expect(toSig2(52.2)).toBe(52);
    expect(toSig2(87)).toBe(87);
    expect(toSig2(0.096)).toBe(0.096); // 恰好 2 位有效数字:不圆整
  });

  it('hpMul 推导:现表一致不出编辑;塔表改坏后编辑跟着走(proposed = round(推导))', () => {
    expect(makeBossEdit()).toBeNull();
    tweak(TOWER_LASER, 'damage', TOWERS[TOWER_LASER]!.damage * 0.5);
    const edits = solveTowerEdits();
    applyEditsToTable(edits);
    const bossEdit = makeBossEdit();
    expect(bossEdit).not.toBeNull();
    expect(bossEdit!.proposed).toBe(Math.round(bossHpMulForGate()));
    expect(bossEdit!.current).toBe(BOSS.hpMul);
    expect(bossEdit!.file).toBe('enemies');
  });
});

describe('applyEdits(文本写回)', () => {
  const TOWER_TEXT = `export const TOWER_A = 0;
export const TOWER_B = 1;
export const TOWERS: TowerDef[] = [
  {
    type: TOWER_A,
    name: 'a',
    damage: 6, // 原注释甲
    aoeDamage: 0,
    growth: {
      damage: 1.2, // 成长甲
      fireRate: 1,
    },
  },
  {
    type: TOWER_B,
    name: 'b',
    damage: 6, // 原注释乙
    growth: {
      damage: 1.2, // 成长乙
    },
  },
];
`;

  function edit(anchor: number, field: 'damage' | 'growth.damage', current: number, proposed: number): BalanceEdit {
    return { file: 'towers', anchor, field, current, proposed, comment: '// 自动求解' };
  }

  it('按块作用域替换:另一座塔的同值字段不受影响', () => {
    const out = applyEdits(TOWER_TEXT, [edit(0, 'damage', 6, 7)]);
    expect(out).toContain('    damage: 7, // 自动求解');
    expect(out).toContain('    damage: 6, // 原注释乙'); // 乙塔同值不受影响
  });

  it('缩进消歧:growth.damage 只动 6 空格行,damage 只动 4 空格行', () => {
    const g = applyEdits(TOWER_TEXT, [edit(0, 'growth.damage', 1.2, 1.3)]);
    expect(g).toContain('      damage: 1.3, // 自动求解');
    expect(g).toContain('    damage: 6, // 原注释甲'); // 主伤害档不动
    const d = applyEdits(TOWER_TEXT, [edit(0, 'damage', 6, 7)]);
    expect(d).toContain('      damage: 1.2, // 成长甲'); // 成长档不动
  });

  it('同一批编辑重应用:文本逐字不变(幂等)', () => {
    const once = applyEdits(TOWER_TEXT, [edit(0, 'damage', 6, 7)]);
    const twice = applyEdits(once, [edit(0, 'damage', 6, 7)]);
    expect(twice).toBe(once);
  });

  it('enemies.ts:hpMul 值与推导注释整块重生成,dropMul 与续注之外的内容不动', () => {
    const text = `export const BOSS: BossDef = {
  baseKind: 3,
  name: '合围巨兽',
  hpMul: 52, // 旧注释第一行
  // 旧续注一(手写数字 60.3 会陈)
  // 旧续注二(手写数字 43.5 会陈)
  dropMul: 12, // 掉落档注释
};
`;
    const bossEdit: BalanceEdit = {
      file: 'enemies',
      anchor: -1,
      field: 'hpMul',
      current: 52,
      proposed: 53,
      // 续行自带 2 空格缩进(约定:comment 的第二段 = 文件里的整行)
      comment: '// 闸门反推(自动求解):第一行\n  // Boss HP 续行',
    };
    const out = applyEdits(text, [bossEdit]);
    expect(out).toContain('  hpMul: 53, // 闸门反推(自动求解):第一行');
    expect(out).toContain('  // Boss HP 续行');
    expect(out).not.toContain('旧续注');
    expect(out).toContain('  dropMul: 12, // 掉落档注释');
    expect(applyEdits(out, [{ ...bossEdit, current: 53 }])).toBe(out); // 重应用逐字不变
  });

  it('坏编辑防御:锚找不到 / 现值对不上 → 原样返回,不抛、不覆盖', () => {
    expect(applyEdits(TOWER_TEXT, [edit(99, 'damage', 6, 7)])).toBe(TOWER_TEXT);
    expect(applyEdits(TOWER_TEXT, [edit(0, 'damage', 5, 7)])).toBe(TOWER_TEXT); // 现值 5 ≠ 文件 6
    expect(applyEdits('', [edit(0, 'damage', 6, 7)])).toBe('');
  });
});
