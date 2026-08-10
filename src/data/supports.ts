/**
 * 支援数值表(06 号 issue T2,改版设计会重写)—— 纯数据,零 import。
 * 铁律:src/data 与 src/sim 一样永不 import pixi/DOM;**也永不 import sim/config** ——
 * 数据表是配置的上游,引回去就成环。依赖方向是 supports → towers **单向**
 * (towers.ts 一个字都不知道本文件的存在),于是 06 号也落在 05 号那条验收上:
 * **改本文件即可调平衡,不改一行逻辑代码**。
 *
 * —— 甲板删除后的语义重写(用户设计会)——
 * 旧版支援是**甲板格 + 邻接加成**(弹药库给"相邻"的弹药系塔加射速),随网格一起删除。
 * 新语义:**支援槽 = 全船被动**。每持有一个支援,按它的作用系给**全船所有**同类武器/船体
 * 一个全局效果;重复持有连乘/连加(两座弹药库 = 弹药系射速 ×1.25²)。
 * 于是不再有"邻接""所在舷""暴露边"这些空间概念 —— 效果从"摆在哪里"解耦,
 * 只数"持有了几个"。
 *
 * 与 data/towers.ts 同风格:
 *   数字常量而非 enum(热循环里按下标直取最省事,isolatedModules 下 enum 也不划算);
 *   字段不加 readonly、不 Object.freeze —— 单测要临时改字段再 afterEach 还原;
 *   **不用的乘法档填 1、加法档填 0 并注明** —— 两个中性值的分工与 towers.ts 的 growth 一段同源:
 *     0 作乘数是"归零",会把全局射速/磁吸半径直接抹成 0,与"这一档用不上"是两码事。
 *
 * 叠加口径(**定死**,sim/support.ts 与 sim/tower.ts / sim/damage.ts 都照它算,别处不许另立一套):
 *   乘法档一律**连乘**(两座弹药库 = ×1.25²,推不到 ≤ 0);
 *   **只有 hullHp 是加法**(两座装甲舱 = +30):它是点数,不是比例。
 *   —— 新增两类乘法档(用户设计会):
 *   xpMul(经验获取倍率,经验增幅器)与 magnetRadiusMul(磁吸半径倍率,磁力收集器),
 *   同样连乘 —— 这是"支援可以加速升级"那一半的落地:经验增幅器让每颗经验掉落值更高。
 *
 * 旧字段 throttle 保留但语义变化:它不再用于"邻接判定",而是**作用系** ——
 * 弹药库(THR_AMMO)只给弹药系武器加成、散热器(THR_HEAT)只给过热系、
 * 电容组(THR_CHARGE)只给充能系;装甲舱/经验增幅器/磁力收集器用 SUPPORT_THR_NONE(-1)
 * = 不作用于特定系(全船无条件生效)。
 */
import { THR_AMMO, THR_CHARGE, THR_HEAT } from './towers';

export const SUP_AMMO_BAY = 0; // 弹药库
export const SUP_RADIATOR = 1; // 散热器
export const SUP_CAPACITOR = 2; // 电容组
export const SUP_ARMOR_BAY = 3; // 装甲舱
export const SUP_XP_AMP = 4; // 经验增幅器(新增:加速升级)
export const SUP_MAGNET = 5; // 磁力收集器(新增:磁吸半径)
export const SUPPORT_KIND_COUNT = 6;

/**
 * throttle 填它 = **不作用于特定武器系**(装甲舱 / 经验增幅器 / 磁力收集器)。
 * 故意用 -1 而不是另开一个"无"档:与 DeckCell.towerType 的 -1 是同一条「没有」的表达,
 * 且它落在 THR_*(0/1/2)的编号之外 —— 效果计算只需一句 `>= 0` 就把"系限定"与"全船"分开。
 */
export const SUPPORT_THR_NONE = -1;

export interface SupportDef {
  /** 下标 === type,与 SUP_* 一致;SUPPORTS[supportType] 直取,错一位就全设施串味 */
  type: number;
  name: string;
  /**
   * 作用的武器系(data/towers 的 THR_*),或 SUPPORT_THR_NONE = 全船无条件生效。
   * 作用系相同的武器共享这一个加成;不匹配的武器不受影响。
   * —— 旧版"一设施只认一系"的判据(supportAffects)仍在文件末尾,判的是"系"不是"邻接"。
   */
  throttle: number;
  /** 本系武器:射速倍率(> 1 = 更快);不用填 1 */
  fireRateMul: number;
  /** 本系武器:装填时间倍率(< 1 = 更短);不用填 1 */
  reloadMul: number;
  /** 本系武器:过热上限倍率(> 1 = 能连烧更久);不用填 1 */
  heatMaxMul: number;
  /** 本系武器:充能速度倍率(> 1 = 更快,chargeTime 除它);不用填 1 */
  chargeRateMul: number;
  /**
   * 船体 HP 加成(点),**加法**(两块 = +30)。与"系"无关:护的是船,不是某系武器。
   * 不用填 0。
   */
  hullHp: number;
  /**
   * 受击伤害倍率(< 1 = 减伤),**连乘**。与"系"无关(装甲舱护全船,不再是"所在舷")。
   * 不用填 1。
   */
  damageTakenMul: number;
  /**
   * 经验获取倍率(> 1 = 每颗经验掉落值更高),**连乘**。加速升级的核心档(用户设计会)。
   * 不用填 1。
   */
  xpMul: number;
  /**
   * 磁吸半径倍率(> 1 = 起吸半径更大),**连乘**。不用填 1。
   */
  magnetRadiusMul: number;
  /**
   * 渲染色。一律**冷色**(GDD §12:敌我色域完全分离),且与各武器的 tint 都不撞。
   */
  tint: number;
}

/** 下标 === type,顺序 弹药库/散热器/电容组/装甲舱/经验增幅器/磁力收集器;sim 靠 SUPPORTS[supportType] 直取 */
export const SUPPORTS: SupportDef[] = [
  {
    type: SUP_AMMO_BAY,
    name: '弹药库',
    // 弹药系三塔(机炮 / 点防 / 导弹巢)。"突发满速后必然停火装填"是弹药系的手感,
    // 这块正是买断那段停火的东西 —— 现在全船弹药系一起买断
    throttle: THR_AMMO,
    fireRateMul: 1.25, // GDD §5.3:射速 +25%
    reloadMul: 0.7, // GDD §5.3:装填 -30%
    heatMaxMul: 1,
    chargeRateMul: 1, // 不作用的乘法档填 1 = 恒等(填 0 会把热上限/充能直接抹成 0)
    hullHp: 0, // 非装甲舱:加法档填 0
    damageTakenMul: 1, // 非装甲舱:乘法档填 1
    xpMul: 1, // 非经验档
    magnetRadiusMul: 1, // 非磁吸档
    tint: 0x4fb3a5, // 占位待调(青绿)
  },
  {
    type: SUP_RADIATOR,
    name: '散热器',
    throttle: THR_HEAT, // 过热系两塔(激光 / 电弧)
    fireRateMul: 1,
    reloadMul: 1, // 恒等档
    heatMaxMul: 1.5, // GDD §5.3:过热上限 +50%
    chargeRateMul: 1,
    hullHp: 0,
    damageTakenMul: 1,
    xpMul: 1,
    magnetRadiusMul: 1,
    tint: 0x5aa8d8, // 占位待调(中调天蓝)
  },
  {
    type: SUP_CAPACITOR,
    name: '电容组',
    throttle: THR_CHARGE, // 充能系两塔(磁轨 / 迫击炮)
    fireRateMul: 1,
    reloadMul: 1,
    heatMaxMul: 1, // 恒等档
    chargeRateMul: 1.3, // GDD §5.3:充能速度 +30%(chargeTime 除它 ⇒ 攒得更快)
    hullHp: 0,
    damageTakenMul: 1,
    xpMul: 1,
    magnetRadiusMul: 1,
    tint: 0x7d8ee8, // 占位待调(偏紫的蓝)
  },
  {
    type: SUP_ARMOR_BAY,
    name: '装甲舱',
    // 不再作用于"相邻塔/所在舷"—— 全船 HP +15、全船受击 ×0.8。
    // throttle 恒 SUPPORT_THR_NONE:效果在船体本身,不区分武器系
    throttle: SUPPORT_THR_NONE,
    fireRateMul: 1,
    reloadMul: 1,
    heatMaxMul: 1,
    chargeRateMul: 1, // 四个系倍率整段恒等
    hullHp: 15, // GDD §5.3:船体 HP +15(加法,两块 = +30)
    damageTakenMul: 0.8, // 受撞伤害 -20%(连乘,两块 = ×0.64)
    xpMul: 1,
    magnetRadiusMul: 1,
    tint: 0x8fa6bd, // 占位待调(低饱和钢蓝)
  },
  {
    type: SUP_XP_AMP,
    name: '经验增幅器',
    // 新增(用户设计会):"支援可以加速升级"的核心档。全船无条件 —— 每持有一个,
    // 每颗经验掉落的进账值 ×1.5(连乘)。它不移动 rng、不改波次,只放大掉落收益,
    // 于是"点了它升级更快"是玩家一眼能验证的承诺。
    throttle: SUPPORT_THR_NONE,
    fireRateMul: 1,
    reloadMul: 1,
    heatMaxMul: 1,
    chargeRateMul: 1,
    hullHp: 0,
    damageTakenMul: 1,
    xpMul: 1.5, // 经验 +50%(连乘;占位待调)
    magnetRadiusMul: 1,
    tint: 0xcfe8a0, // 占位待调(冷黄绿:唯一"经济向"的支援,色相上与火力支援拉开)
  },
  {
    type: SUP_MAGNET,
    name: '磁力收集器',
    // 新增(用户设计会):磁吸半径 ×1.3。与磁力过载法令(EDICT_MAGNET ×1.3)同档位、
    // 同连乘口径 —— 磁吸是"捡经验"的效率,半径越大漏得越少。配合磁吸缩小(240→80)落地,
    // 它就是玩家对抗"捡不到"的主要投资方向。
    throttle: SUPPORT_THR_NONE,
    fireRateMul: 1,
    reloadMul: 1,
    heatMaxMul: 1,
    chargeRateMul: 1,
    hullHp: 0,
    damageTakenMul: 1,
    xpMul: 1,
    magnetRadiusMul: 1.3, // 磁吸半径 +30%(连乘;占位待调)
    tint: 0x8ab8e8, // 占位待调(冷灰蓝:与磁力过载法令共用"磁吸"语感的色域)
  },
];

/**
 * 类型匹配的**唯一**判据:sim/support.ts 的效果汇总与 UI 的卡片文案都必须问它。
 * `sup.throttle >= 0` 这一手不是冗余:少了它,一旦哪天某座武器的 throttle 也读到 -1
 * (未初始化,或将来某种"无节流"的武器),装甲舱就会凭空开始给它加成。
 */
export function supportAffects(sup: SupportDef, throttle: number): boolean {
  return sup.throttle >= 0 && sup.throttle === throttle;
}
