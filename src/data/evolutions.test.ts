/**
 * 空间进化配方表(17 号 issue)的表级不变量。
 * 与 towers.test.ts / supports.test.ts 同口径:钉的不是船坞流程(那在 refitFlow,后续 issue),
 * 而是**数据表本身的口径** —— 6 条配方齐全、塔型/支援型编号合法、结果塔型落在
 * TOWER_KIND_COUNT 内、配方顺序与 towers.ts 新塔编号 6..11 一一对应,
 * 以及"配方不满足绝不触发"这条验收的机械形式(evolutionOf 对没配对的组合恒返回 -1)。
 *
 * 调平衡时改 EVOLUTIONS 里的塔/支援搭配是被鼓励的(那正是本表存在的理由),
 * 但改坏"结果塔型在表内、顺序对得上新塔编号"这几条,船坞判定就会张冠李戴。
 */
import { describe, expect, it } from 'vitest';
import {
  TOWER_ARC,
  TOWER_AUTOCANNON,
  TOWER_FIRESTORM,
  TOWER_GATLING,
  TOWER_KIND_COUNT,
  TOWER_LASER,
  TOWER_MORTAR,
  TOWER_PARTICLE,
  TOWER_PD,
  TOWER_PHASE,
  TOWER_RAILGUN,
  TOWER_TESLA,
  TOWER_THORN,
  TOWERS,
} from './towers';
import {
  SUP_AMMO_BAY,
  SUP_ARMOR_BAY,
  SUP_CAPACITOR,
  SUPPORT_KIND_COUNT,
  SUP_RADIATOR,
  SUPPORTS,
} from './supports';
import { EVOLUTIONS, evolutionOf } from './evolutions';

describe('空间进化配方表', () => {
  it('6 条配方齐全,顺序 = GDD §5.5,结果塔型与 towers.ts 编号 6..11 一一对应', () => {
    expect(EVOLUTIONS).toHaveLength(6);
    expect(EVOLUTIONS.map((r) => r.result)).toEqual([
      TOWER_GATLING,
      TOWER_PHASE,
      TOWER_PARTICLE,
      TOWER_TESLA,
      TOWER_FIRESTORM,
      TOWER_THORN,
    ]);
    // 结果塔型就是"新塔编号"那六个:配方顺序错位 = 塔的张冠李戴,钉死两条链的对应
    expect(TOWER_GATLING).toBe(6);
    expect(TOWER_THORN).toBe(11);
    // 13 = 六基塔 + 六进化塔 + 19 号进阶塔导弹巢(进阶塔不在此表,走解锁入池,见 unlocks)
    expect(TOWER_KIND_COUNT).toBe(13);
  });

  it('配方里的塔型与支援型都指向合法型号,结果塔型落在表内', () => {
    for (const r of EVOLUTIONS) {
      expect(r.base).toBeGreaterThanOrEqual(0);
      expect(r.base).toBeLessThan(TOWER_KIND_COUNT);
      expect(TOWERS[r.base], `塔型 ${r.base} 没有塔`).toBeDefined();
      expect(r.support).toBeGreaterThanOrEqual(0);
      expect(r.support).toBeLessThan(SUPPORT_KIND_COUNT);
      expect(SUPPORTS[r.support], `支援型 ${r.support} 没有设施`).toBeDefined();
      expect(r.result).toBeGreaterThanOrEqual(0);
      expect(r.result).toBeLessThan(TOWER_KIND_COUNT);
      expect(TOWERS[r.result], `结果塔型 ${r.result} 没有塔`).toBeDefined();
      // 进化必须换塔型:吞掉支援却原地不动等于没进化
      expect(r.result).not.toBe(r.base);
    }
  });

  it('evolutionOf 精确命中配方;没有配对的组合恒返回 -1(配方不满足绝不触发)', () => {
    for (const r of EVOLUTIONS) {
      expect(evolutionOf(r.base, r.support)).toBe(r.result);
    }
    // 全表穷举:6×4 支援组合里,命中的恰是六条配方,其余组合一律 -1 ——
    // 船坞的"支援换成别的绝不触发"整条判据的机械形式
    for (let t = 0; t < TOWER_KIND_COUNT; t++) {
      for (let s = 0; s < SUPPORT_KIND_COUNT; s++) {
        const hit = EVOLUTIONS.find((r) => r.base === t && r.support === s);
        expect(evolutionOf(t, s), `塔 ${t} + 支援 ${s}`).toBe(hit ? hit.result : -1);
      }
    }
  });
});
