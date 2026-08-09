/**
 * 空间进化配方表(17 号 issue T1)—— 纯数据,与 towers.ts / supports.ts 同风格:可改、可测。
 * 铁律:src/data 与 src/sim 一样永不 import pixi/DOM;**也永不 import sim/config** ——
 * 数据表是配置的上游,引回去就成环。依赖方向是 evolutions → supports → towers 单向无环。
 *
 * 判据是"空间关系"不是"卡牌合成"(GDD §4.5 / 17 号口径):满级塔(Lv5)与指定支援设施
 * **正交相邻**时,船坞给出进化入口,触发后支援格清空(腾出一格)、塔替换为进化型。
 * 本表只描述"哪塔 + 哪支援 → 哪种进化塔";相邻判定与替换流程住在船坞侧(refitFlow,
 * 后续 issue)。进化不可逆,与"塔不可出售"同口径 —— 本表同样没有"拆回"这条边。
 *
 * 6 条配方按 GDD §5.5 的顺序排列,恰好对应 towers.ts 里 TOWER_GATLING=6..TOWER_THORN=11
 * 的编号(evolutions.test.ts 钉着这条对应,错位 = 配方张冠李戴)。
 * ※ 电弧配方:GDD 原表是反应堆,反应堆不在 MVP 支援表,按 17 号口径方案 A 挂散热器(行为同构),
 *   将来反应堆落地时只改这一行,判定与流程一个字不动。
 */
import {
  TOWER_ARC,
  TOWER_AUTOCANNON,
  TOWER_FIRESTORM,
  TOWER_GATLING,
  TOWER_LASER,
  TOWER_MORTAR,
  TOWER_PARTICLE,
  TOWER_PD,
  TOWER_PHASE,
  TOWER_RAILGUN,
  TOWER_TESLA,
  TOWER_THORN,
} from './towers';
import { SUP_AMMO_BAY, SUP_ARMOR_BAY, SUP_CAPACITOR, SUP_RADIATOR } from './supports';

export interface EvolutionRecipe {
  /** 满级塔型(TOWER_*) */
  base: number;
  /** 被吞噬的支援型(SUP_*) */
  support: number;
  /** 进化结果塔型(TOWER_*;下标落在 [0, TOWER_KIND_COUNT) 内) */
  result: number;
}

/**
 * 六条配方。顺序 = GDD §5.5,与 towers.ts 的新塔编号 6..11 一一对应:
 * 机炮+弹药库 → 加特林要塞(6)、激光+散热器 → 相位切割者(7)、磁轨+电容组 → 粒子长矛(8)、
 * 电弧+散热器 → 特斯拉冠冕(9)、迫击炮+弹药库 → 轨道火雨(10)、点防+装甲舱 → 荆棘壁垒(11)。
 */
export const EVOLUTIONS: EvolutionRecipe[] = [
  { base: TOWER_AUTOCANNON, support: SUP_AMMO_BAY, result: TOWER_GATLING },
  { base: TOWER_LASER, support: SUP_RADIATOR, result: TOWER_PHASE },
  { base: TOWER_RAILGUN, support: SUP_CAPACITOR, result: TOWER_PARTICLE },
  // GDD 原表是反应堆(未实装);按 17 号口径方案 A 挂散热器,行为同构,判定不受影响
  { base: TOWER_ARC, support: SUP_RADIATOR, result: TOWER_TESLA },
  { base: TOWER_MORTAR, support: SUP_AMMO_BAY, result: TOWER_FIRESTORM },
  { base: TOWER_PD, support: SUP_ARMOR_BAY, result: TOWER_THORN },
];

/**
 * 配方查询:这一对(塔型, 支援型)能进化成哪一型。没有配方返回 -1 ——
 * 与 DeckCell.towerType / SUPPORT_THR_NONE 的"没有"是同一条表达
 * (船坞的"配方不满足绝不触发"整条判据就住在这一个函数里)。
 */
export function evolutionOf(base: number, support: number): number {
  for (const r of EVOLUTIONS) {
    if (r.base === base && r.support === support) return r.result;
  }
  return -1;
}

/**
 * 这一型是不是**进化结果塔**(只能从配方来)。
 * 升级卡池(sim/upgrade.ts 的塔型池)靠它把 6..11 挡在门外 ——
 * 进化塔不是"数值表里多出来的可买型号",是船坞里空间关系的产物,
 * 能在三选一里买到就违背了 GDD §5.5"进化只在船坞"的闸门。
 * 判定从配方表推导,不硬编码 6..11:加一条配方,卡池过滤自动跟上。
 */
export function isEvolutionTower(type: number): boolean {
  for (const r of EVOLUTIONS) {
    if (r.result === type) return true;
  }
  return false;
}
