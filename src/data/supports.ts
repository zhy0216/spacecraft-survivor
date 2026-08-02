/**
 * 支援设施数值表(06 号 issue T2)—— 纯数据,只 import 同目录的 data/towers(THR_* 常量与 TowerDef 类型)。
 * 铁律:src/data 与 src/sim 一样永不 import pixi/DOM;**也永不 import sim/config** ——
 * 数据表是配置的上游,引回去就成环。依赖方向是 supports → towers **单向**
 * (towers.ts 一个字都不知道本文件的存在),于是 06 号也落在 05 号那条验收上:
 * **改本文件即可调平衡,不改一行逻辑代码**。
 *
 * 与 data/towers.ts 同风格:
 *   数字常量而非 enum(热循环里按下标直取最省事,isolatedModules 下 enum 也不划算);
 *   字段不加 readonly、不 Object.freeze —— 单测要临时改字段再 afterEach 还原;
 *   **不用的乘法档填 1、加法档填 0 并注明** —— 两个中性值的分工与 towers.ts 的 growth 一段同源:
 *     0 作乘数是"归零",会把相邻塔的射速/热上限直接抹成 0,与"这一档用不上"是两码事。
 *
 * 叠加口径(**定死**,sim/support.ts 与 sim/damage.ts 都照它算,别处不许另立一套):
 *   四个邻接倍率一律**连乘** —— 两座弹药库夹一门机炮 = 射速 ×1.25²、装填 ×0.7²;
 *   同舷两块装甲 = 受撞 ×0.8²。理由与 sim/damage.ts 那句"返回倍率而不是减伤值"一字同源:
 *   连乘永远推不到 ≤ 0,而"每块 -30%"的加法在四块围一门炮时会把装填时间推成负数。
 *   **只有 hullHp 是加法**(两块装甲舱 = +30):它是点数,不是比例。
 *
 * 四种设施的效果数值逐条来自 GDD §5.3(调平衡时可改,但改的是那张表的口径);
 * 只有 tint 是占位待调。
 */
import { THR_AMMO, THR_CHARGE, THR_HEAT, type TowerDef } from './towers';

export const SUP_AMMO_BAY = 0; // 弹药库
export const SUP_RADIATOR = 1; // 散热器
export const SUP_CAPACITOR = 2; // 电容组
export const SUP_ARMOR_BAY = 3; // 装甲舱
export const SUPPORT_KIND_COUNT = 4;

/**
 * throttle 填它 = **不作用于任何相邻塔**(四种里只有装甲舱)。
 * 故意用 -1 而不是另开一个"无"档:与 DeckCell.towerType 的 -1 是同一条「没有」的表达,
 * 且它落在 THR_*(0/1/2)的编号之外 —— supportAffects 只需一句 `>= 0` 就把整类挡在门外,
 * 不必在两条链路上各写一次"如果是装甲舱就跳过"。
 */
export const SUPPORT_THR_NONE = -1;

export interface SupportDef {
  /** 下标 === type,与 SUP_* 一致;SUPPORTS[cell.supportType] 直取,错一位就全设施串味 */
  type: number;
  name: string;
  /**
   * 作用的节流系(data/towers 的 THR_*),或 SUPPORT_THR_NONE = 不作用于相邻塔。
   * **一设施只认一系**:GDD §4.3 那条"类型不匹配无效果"整个落在这一个字段上,
   * 判据统一走 supportAffects(见文件末尾),UI 连线与 buff 计算都问它。
   */
  throttle: number;
  /** 相邻同系塔:射速倍率(> 1 = 更快);不用填 1 */
  fireRateMul: number;
  /** 相邻同系塔:装填时间倍率(< 1 = 更短);不用填 1 */
  reloadMul: number;
  /** 相邻同系塔:过热上限倍率(> 1 = 能连烧更久);不用填 1 */
  heatMaxMul: number;
  /** 相邻同系塔:充能速度倍率(> 1 = 更快,chargeTime 除它);不用填 1 */
  chargeRateMul: number;
  /**
   * 船体 HP 加成(点),**加法**(两块 = +30)。
   * 与"相邻"无关:装甲舱护的是船,不是隔壁那座塔 —— 全甲板求和,见 sim/damage.ts 的 hullMaxHp。
   * 不用填 0。
   */
  hullHp: number;
  /**
   * 所在舷受撞伤害倍率(< 1 = 减伤),**连乘**。同样与"相邻"无关:
   * 舷向归属走 isEdgeExposed(角落格同时护两舷、内部格一条舷都不护),见 sim/damage.ts 的 edgeDamageMul。
   * 不用填 1。
   */
  edgeDamageMul: number;
  /**
   * 渲染色。一律**冷色**(GDD §12:敌我色域完全分离),且与六塔的 tint 都不撞 ——
   * 邻接连线的颜色取的就是它,与塔身涂成同一个色就读不出线的两端谁是谁。
   */
  tint: number;
}

/** 下标 === type,顺序 弹药库/散热器/电容组/装甲舱;sim 靠 SUPPORTS[cell.supportType] 直取 */
export const SUPPORTS: SupportDef[] = [
  {
    type: SUP_AMMO_BAY,
    name: '弹药库',
    // 弹药系两塔(机炮 / 点防)。GDD §4.3 的 MVP 就是这一种先行:
    // "突发满速后必然停火装填"是弹药系的手感,而这块正是买断那段停火的东西
    throttle: THR_AMMO,
    fireRateMul: 1.25, // GDD §5.3:射速 +25%
    reloadMul: 0.7, // GDD §5.3:装填 -30%
    heatMaxMul: 1,
    chargeRateMul: 1, // 不作用的乘法档填 1 = 恒等(填 0 会把相邻塔的热上限/充能直接抹成 0)
    hullHp: 0, // 非装甲舱:加法档填 0
    edgeDamageMul: 1, // 非装甲舱:乘法档填 1
    tint: 0x4fb3a5, // 占位待调(青绿;与点防的 0x5ce8b4 靠明度拉开)
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
    edgeDamageMul: 1,
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
    edgeDamageMul: 1,
    tint: 0x7d8ee8, // 占位待调(偏紫的蓝;仍在冷色域内)
  },
  {
    type: SUP_ARMOR_BAY,
    name: '装甲舱',
    // 四种里唯一不作用于相邻塔的:效果全在船体本身(HP 与所在舷)。
    // 于是 supportAffects 对任何塔恒 false ⇒ 它永远不产生 link ⇒ UI 永远不给它画连线 ——
    // 画了就是误导(GDD §4.3 那条"不匹配时 UI 不画线"在这里是结构上的,不是靠人记得跳过)
    throttle: SUPPORT_THR_NONE,
    fireRateMul: 1,
    reloadMul: 1,
    heatMaxMul: 1,
    chargeRateMul: 1, // 四个邻接倍率整段恒等
    hullHp: 15, // GDD §5.3:船体 HP +15(加法,两块 = +30)
    edgeDamageMul: 0.8, // GDD §5.3:所在舷受撞伤害 -20%(连乘,同舷两块 = ×0.64)
    tint: 0x8fa6bd, // 占位待调(低饱和钢蓝:它是结构件不是输出件,刻意不抢六塔的高饱和)
  },
];

/**
 * 类型匹配的**唯一**判据:UI 连线与 buff 计算都必须问它,任何地方不许再写一遍。
 * 两处各判一次的写法迟早会漂,而 06 号验收第二条"连线只出现在真实生效的配对上"
 * 只有在同一个函数同时喂这两条链路时才是**结构上**成立的,而不是靠人盯着两边同步。
 *
 * `sup.throttle >= 0` 这一手不是冗余:少了它,一旦哪天某座塔的 throttle 也读到 -1
 * (未初始化,或将来某种"无节流"的塔),装甲舱就会凭空开始给它加成。
 * 把「没有」挡在门外一次,比在两条链路上各补一次特判便宜。
 */
export function supportAffects(sup: SupportDef, tower: TowerDef): boolean {
  return sup.throttle >= 0 && sup.throttle === tower.throttle;
}
