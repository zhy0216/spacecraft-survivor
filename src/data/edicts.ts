/**
 * 法令数值表(18 号 issue)—— 纯数据,零 import。
 * 与 data/supports.ts / data/towers.ts 同风格:
 *   数字常量而非 enum(掩码按位直取最省事,isolatedModules 下 enum 也不划算);
 *   字段不加 readonly、不 Object.freeze —— 单测要临时改字段再 afterEach 还原;
 *   **不用的乘法档填 1、加法档填 0 并注明**(两个中性值的分工与 towers.ts 的 growth 一段同源:
 *     0 作乘数是"归零",会把射速/拾取半径直接抹成 0,与"这一档用不上"是两码事)。
 *
 * 法令是**不占格的全船被动**(GDD §7):效果挂在 sim 侧的 effective* 现读点
 * (塔射速 / 转向 / 拾取半径 / 过热上限 / 船体 HP / 巡航速度),本文件只负责"哪一号给什么数"。
 * 叠加口径:**倍率一律连乘、点数一律相加** —— 与 sim/damage.ts 那句"返回倍率而不是减伤值"
 * 一字同源,连乘永远推不到 ≤ 0。MVP 每号只可能出现一次(三选一把已持有的从候选里剔掉,
 * 见 sim/upgrade.ts 的 heldEdicts),故"几号同持"的连乘/相加只发生在不同号之间。
 *
 * 七条全部数值型、不引入新机制(18 号调味定位:build 主体必须长在甲板上,法令只是调味)。
 */
export const EDICT_TRACER = 0; // 曳光协议
export const EDICT_GYRO = 1; // 重心校准
export const EDICT_MAGNET = 2; // 磁力过载
export const EDICT_COOLANT = 3; // 散热协议
export const EDICT_HULL = 4; // 结构加固
export const EDICT_CRUISE = 5; // 巡航校准
// 19 号进阶法令:条件式解锁(单局击杀达标)后进三选一池,未解锁时由卡池过滤挡在候选之外。
// 与 18 号同一条"数值型、不引入新机制"的口径 —— 它是既有字段的**更强档**,不是新机制
export const EDICT_RAPID = 6; // 急速协议
export const EDICT_KIND_COUNT = 7;

export interface EdictDef {
  /** 下标 === type,与 EDICT_* 一致;EDICTS[type] 直取,错一位就全船串味 */
  type: number;
  name: string;
  /** 弹药系塔的射速倍率(曳光协议 = 1.1 = +10%);不用填 1 */
  ammoFireRateMul: number;
  /** 转向速率加点 °/s(重心校准 = +10;加法档);不用填 0 */
  turnRateAdd: number;
  /** 拾取半径倍率(磁力过载 = 1.3 = +30%);不用填 1 */
  magnetRadiusMul: number;
  /** 过热上限倍率(散热协议 = 1.2 = +20%);不用填 1 */
  heatMaxMul: number;
  /** 船体 HP 加点(结构加固 = +20;加法档,与装甲舱的 hullHp 同口径);不用填 0 */
  hullHpAdd: number;
  /** 巡航速度倍率(巡航校准 = 1.1 = +10%);不用填 1 */
  cruiseSpeedMul: number;
}

/** 下标 === type,顺序 曳光/重心/磁力/散热/结构/巡航 + 19 号急速协议;sim 靠 EDICTS[type] 直取 */
export const EDICTS: EdictDef[] = [
  {
    type: EDICT_TRACER,
    name: '曳光协议',
    ammoFireRateMul: 1.1, // 所有弹药系射速 +10%
    turnRateAdd: 0, // 非转向号:加法档填 0
    magnetRadiusMul: 1, // 非磁吸号:乘法档填 1(填 0 会把拾取半径直接抹成 0)
    heatMaxMul: 1,
    hullHpAdd: 0,
    cruiseSpeedMul: 1,
  },
  {
    type: EDICT_GYRO,
    name: '重心校准',
    ammoFireRateMul: 1,
    turnRateAdd: 10, // 转向 +10°/s
    magnetRadiusMul: 1,
    heatMaxMul: 1,
    hullHpAdd: 0,
    cruiseSpeedMul: 1,
  },
  {
    type: EDICT_MAGNET,
    name: '磁力过载',
    ammoFireRateMul: 1,
    turnRateAdd: 0,
    magnetRadiusMul: 1.3, // 拾取半径 +30%
    heatMaxMul: 1,
    hullHpAdd: 0,
    cruiseSpeedMul: 1,
  },
  {
    type: EDICT_COOLANT,
    name: '散热协议',
    ammoFireRateMul: 1,
    turnRateAdd: 0,
    magnetRadiusMul: 1,
    heatMaxMul: 1.2, // 过热上限 +20%
    hullHpAdd: 0,
    cruiseSpeedMul: 1,
  },
  {
    type: EDICT_HULL,
    name: '结构加固',
    ammoFireRateMul: 1,
    turnRateAdd: 0,
    magnetRadiusMul: 1,
    heatMaxMul: 1,
    hullHpAdd: 20, // 船体 HP +20(加法)
    cruiseSpeedMul: 1,
  },
  {
    type: EDICT_CRUISE,
    name: '巡航校准',
    ammoFireRateMul: 1,
    turnRateAdd: 0,
    magnetRadiusMul: 1,
    heatMaxMul: 1,
    hullHpAdd: 0,
    cruiseSpeedMul: 1.1, // 巡航速度 +10%
  },
  {
    // 19 号进阶法令:曳光协议的更强档(弹药系射速 +10% → +25%)。
    // 全数值、不引入新机制 —— 解锁内容的价值在"更强的既有档",不在新机制(18 号口径)
    type: EDICT_RAPID,
    name: '急速协议',
    ammoFireRateMul: 1.25, // 弹药系射速 +25%
    turnRateAdd: 0,
    magnetRadiusMul: 1,
    heatMaxMul: 1,
    hullHpAdd: 0,
    cruiseSpeedMul: 1,
  },
];

/** 一位掩码(1 << type)。World 的 edicts 字段、候选剔已持有都拿它按位说话 */
export function edictMask(type: number): number {
  return 1 << type;
}

/** 这条法令持没持有。掩码带在身上的唯一判据,别处不许再写一遍位移 */
export function hasEdict(mask: number, type: number): boolean {
  return (mask & edictMask(type)) !== 0;
}

/** 已持有法令的转向加点之和(°/s)。重心校准 = +10,未持有恒 0 */
export function edictTurnRateAdd(mask: number): number {
  let add = 0;
  for (let i = 0; i < EDICTS.length; i++) {
    if (hasEdict(mask, i)) add += EDICTS[i]!.turnRateAdd;
  }
  return add;
}

/** 已持有法令的船体 HP 加点之和。结构加固 = +20,未持有恒 0 */
export function edictHullHpAdd(mask: number): number {
  let add = 0;
  for (let i = 0; i < EDICTS.length; i++) {
    if (hasEdict(mask, i)) add += EDICTS[i]!.hullHpAdd;
  }
  return add;
}

/** 已持有法令的弹药系射速倍率(连乘)。曳光协议 = 1.1,未持有恒 1 */
export function edictAmmoFireRateMul(mask: number): number {
  let mul = 1;
  for (let i = 0; i < EDICTS.length; i++) {
    if (hasEdict(mask, i)) mul *= EDICTS[i]!.ammoFireRateMul;
  }
  return mul;
}

/** 已持有法令的拾取半径倍率(连乘)。磁力过载 = 1.3,未持有恒 1 */
export function edictMagnetRadiusMul(mask: number): number {
  let mul = 1;
  for (let i = 0; i < EDICTS.length; i++) {
    if (hasEdict(mask, i)) mul *= EDICTS[i]!.magnetRadiusMul;
  }
  return mul;
}

/** 已持有法令的过热上限倍率(连乘)。散热协议 = 1.2,未持有恒 1 */
export function edictHeatMaxMul(mask: number): number {
  let mul = 1;
  for (let i = 0; i < EDICTS.length; i++) {
    if (hasEdict(mask, i)) mul *= EDICTS[i]!.heatMaxMul;
  }
  return mul;
}

/** 已持有法令的巡航速度倍率(连乘)。巡航校准 = 1.1,未持有恒 1 */
export function edictCruiseSpeedMul(mask: number): number {
  let mul = 1;
  for (let i = 0; i < EDICTS.length; i++) {
    if (hasEdict(mask, i)) mul *= EDICTS[i]!.cruiseSpeedMul;
  }
  return mul;
}
