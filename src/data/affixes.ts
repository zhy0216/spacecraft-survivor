/**
 * 词缀表(14 号 issue T1)—— 纯数据,零 import(与 data/enemies.ts 同风格)。
 * 编号对齐 GDD §6.4 与 data/waves.ts 的 WaveElite.affixes 注释顺序:
 * 狂热光环 / 裂变 / 磁力干扰 / 装甲 / 相位,**下标即编号**,sim 靠 AFFIXES[affix] 直取。
 * 铁律:src/data 与 src/sim 一样永不 import pixi/DOM,也永不 import sim/(引回去就成环)。
 * 存在的意义是 05 号 issue 的验收口径:改平衡只改本文件,不改一行逻辑代码。
 *
 * 效果字段口径与 enemies.ts 的"冲锋参数"同源:**不作用的乘法档一律填 1(恒等)、
 * 不作用的半径/数量档一律填 0** —— 填 0 会把别人的倍率抹成零伤,填错的档单测当场抓出来。
 * 本表只声明数字;效果挂载在 sim/enemy 状态机与 damage 结算处(todos/14 任务清单,本轮不实装)。
 *
 * 除 GDD §14 锁定的几项外,全部占位待调(M0 边玩边调)。
 */

export const AFFIX_FRENZY = 0; // 狂热光环
export const AFFIX_FISSION = 1; // 裂变
export const AFFIX_MAGNETIC = 2; // 磁力干扰
export const AFFIX_ARMORED = 3; // 装甲
export const AFFIX_PHASED = 4; // 相位
export const AFFIX_COUNT = 5;
export type AffixId = 0 | 1 | 2 | 3 | 4;

export interface AffixDef {
  id: AffixId;
  name: string;
  /** 一句话效果说明(GDD §6.4),给人核对用,逻辑不读 */
  description: string;
  /** 狂热光环:生效半径(世界 px);其余词缀恒 0 */
  frenzyRadius: number;
  /** 狂热光环:半径内敌人的速度倍率(> 1 = 加速,蜂群加成);其余词缀恒 1 */
  frenzySpeedMul: number;
  /** 裂变:死亡时分裂出的数量(复用池);其余词缀恒 0 */
  splitCount: number;
  /** 磁力干扰:玩家拾取半径的系数(< 1 = 干扰);其余词缀恒 1 */
  pickupMul: number;
  /** 装甲:弹药系伤害倍率(THR_AMMO 的机炮/点防);其余词缀恒 1 */
  ballisticMul: number;
  /** 相位:能量系伤害倍率(过热 THR_HEAT 的激光/电弧 + 充能 THR_CHARGE 的磁轨/迫击炮);其余词缀恒 1 */
  energyMul: number;
}

/** 下标 === 编号,顺序 狂热光环/裂变/磁力干扰/装甲/相位;sim 靠 AFFIXES[affix] 直取 */
export const AFFIXES: AffixDef[] = [
  {
    id: AFFIX_FRENZY,
    name: '狂热光环',
    description: '半径内敌人速度 ×1.6(蜂群加成)',
    frenzyRadius: 400, // 占位待调
    frenzySpeedMul: 1.6, // 占位待调
    splitCount: 0,
    pickupMul: 1,
    ballisticMul: 1,
    energyMul: 1,
  },
  {
    id: AFFIX_FISSION,
    name: '裂变',
    description: '死亡时分裂成 3 只(复用池)',
    frenzyRadius: 0,
    frenzySpeedMul: 1,
    splitCount: 3, // 占位待调
    pickupMul: 1,
    ballisticMul: 1,
    energyMul: 1,
  },
  {
    id: AFFIX_MAGNETIC,
    name: '磁力干扰',
    description: '玩家拾取半径 ×0.5(读 dropMagnetRadius 处挂修正)',
    frenzyRadius: 0,
    frenzySpeedMul: 1,
    splitCount: 0,
    pickupMul: 0.5, // 占位待调
    ballisticMul: 1,
    energyMul: 1,
  },
  {
    id: AFFIX_ARMORED,
    name: '装甲',
    description: '弹药系伤害 ×0.5(与塔的 throttle=THR_AMMO 对齐)',
    frenzyRadius: 0,
    frenzySpeedMul: 1,
    splitCount: 0,
    pickupMul: 1,
    ballisticMul: 0.5, // 占位待调
    energyMul: 1,
  },
  {
    id: AFFIX_PHASED,
    name: '相位',
    description: '能量系伤害 ×0.5(过热/充能两系,与塔的 throttle 对齐)',
    frenzyRadius: 0,
    frenzySpeedMul: 1,
    splitCount: 0,
    pickupMul: 1,
    ballisticMul: 1,
    energyMul: 0.5, // 占位待调
  },
];

/**
 * 精英通用参数(GDD §6.4 / todos/14)—— 体型与 HP 放大、掉残骸倍率,占位待调。
 * 与 enemies.ts 的表格同一条口径:改平衡只改这里,不改 sim 一行。
 * 掉落倍率 = 3× 残骸,不掷随机、保确定性口径(16 号星币落地前先按它给)。
 */
export const ELITE = {
  /** 体型放大比例:渲染纹理、碰撞半径与冲锋几何都乘它(倍数建议真人试玩定稿) */
  scale: 1.5,
  /** HP 放大比例:精英 HP = 基础 HP × 时间缩放 × 它 */
  hpMul: 3,
  /** 掉落倍率:精英必掉基础残骸 × 它(3× 残骸,占位可调) */
  scrapMul: 3,
};
