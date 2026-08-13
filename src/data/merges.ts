/**
 * 武器合成配方表(改版 GDD §5.5 / 用户设计会)—— 纯数据,与 towers.ts 同风格:可改、可测。
 * 铁律:src/data 与 src/sim 一样永不 import pixi/DOM;**也永不 import sim/config** ——
 * 数据表是配置的上游,引回去就成环。依赖方向是 merges → towers 单向无环。
 *
 * 甲板/邻接进化体系删除后,「三合一合成」取代它成为武器变强的唯一进化通道(GDD §5.5 的
 * 空间进化配方整段作废)—— 星级系统落地后它的形态是:
 *   **同型同星凑满 3 把当场合一升一星**:3× 1★ → 1× 2★、3× 2★ → 1× 3★;
 *   **有配方的基础武器合到 3★ 的那一刻当场变身为合成武器**(占 1 个武器槽)。
 * 合成是**凑满三把的那一刻**触发的(用户设计会:不是船坞手动操作,是即时合成),
 * 合成结果不可逆、不能再拆回 3 把 —— 与旧"进化不可逆"同一条口径。
 *
 * 本表只描述"哪把基础武器合到 3★ 会变成哪把合成武器";三合一升星与 3★ 变身都住在
 * sim/world.ts(World.fuseTriplesOf:槽位记账 + 凑满三把当场兑换)。合成结果与基础武器
 * 一一对应(6 条线),顺序与 towers.ts 里 TOWER_STORM_CANNON=6..TOWER_THORN=11 的编号一致
 * (merges.test 钉着这条对应,错位 = 配方张冠李戴)。
 *
 * 旧的"满级塔 + 相邻支援"进化(evolutions.ts / isEvolutionTower)随甲板网格一起删除:
 * 合成不再要求等级/邻接,只数同型同星的把数 —— 这是"槽位制"对"网格制"的替换。
 */
import {
  TOWER_ANNIHILATION,
  TOWER_ARC,
  TOWER_AURORA,
  TOWER_AUTOCANNON,
  TOWER_DELUGE,
  TOWER_LASER,
  TOWER_MORTAR,
  TOWER_PD,
  TOWER_RAILGUN,
  TOWER_STORM_CANNON,
  TOWER_THORN,
  TOWER_THUNDER,
} from './towers';

export interface MergeRecipe {
  /** 基础武器型(TOWER_*) */
  base: number;
  /** 合成结果武器型(TOWER_*;下标落在 [0, TOWER_KIND_COUNT) 内) */
  result: number;
}

/**
 * 六条合成线。顺序 = 与 towers.ts 的合成武器编号 6..11 一一对应:
 * 机炮→风暴机炮(6)、激光→极光阵列(7)、磁轨→湮灭长矛(8)、
 * 电弧→雷霆王冠(9)、迫击炮→焦土骤雨(10)、点防→荆棘星幕(11)。
 */
export const MERGES: MergeRecipe[] = [
  { base: TOWER_AUTOCANNON, result: TOWER_STORM_CANNON },
  { base: TOWER_LASER, result: TOWER_AURORA },
  { base: TOWER_RAILGUN, result: TOWER_ANNIHILATION },
  { base: TOWER_ARC, result: TOWER_THUNDER },
  { base: TOWER_MORTAR, result: TOWER_DELUGE },
  { base: TOWER_PD, result: TOWER_THORN },
];

/**
 * 配方查询:这把武器合到 3★ 会不会变身、变成什么。没有配方返回 -1 ——
 * 与 DeckCell.towerType 的"没有"是同一条表达(World.fuseTriplesOf 合到 3★ 时靠它查变身结果)。
 */
export function mergeResultOf(base: number): number {
  for (const r of MERGES) {
    if (r.base === base) return r.result;
  }
  return -1;
}

/**
 * 这一型是不是**合成结果武器**(只能从三合一合成来)。
 * 升级卡池(sim/upgrade.ts 的新武器池)靠它把 6..11 挡在门外 ——
 * 合成武器不是"数值表里多出来的可买型号",是合成机制的产物,
 * 能在三选一/商店里买到就违背了"合成武器只从 3★ 变身来"的闸门。
 * 判定从配方表推导,不硬编码 6..11:加一条配方,卡池过滤自动跟上。
 */
export function isMergeResult(type: number): boolean {
  for (const r of MERGES) {
    if (r.result === type) return true;
  }
  return false;
}
