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
  /**
   * slug:翻译/编辑器身份 —— 全表唯一、小写下划线(见 affixes.test)。
   * **数值 id 才是存档与模拟身份**,slug 不进存档、不被 sim 读取。
   */
  slug: string;
  /**
   * devName:开发/调参用的**中文开发名**,只给人看、逻辑不读。
   * 玩家界面不得读它 —— 显示名一律走 presenter(src/ui/presentation/contentText 的 affixName)。
   */
  devName: string;
  /**
   * devDescription:开发/实现说明(读哪个字段、怎么挂修正)。玩家界面不得读它 ——
   * 面向玩家的效果文案走 presenter 的 affixDescription(查 content.affixes.<slug>.description)。
   */
  devDescription: string;
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
    slug: 'frenzy',
    devName: '狂热光环',
    devDescription: '半径内敌人速度 ×1.6(蜂群加成)',
    frenzyRadius: 400, // 占位待调
    frenzySpeedMul: 1.6, // 占位待调
    splitCount: 0,
    pickupMul: 1,
    ballisticMul: 1,
    energyMul: 1,
  },
  {
    id: AFFIX_FISSION,
    slug: 'fission',
    devName: '裂变',
    devDescription: '死亡时分裂成 3 只(复用池)',
    frenzyRadius: 0,
    frenzySpeedMul: 1,
    splitCount: 3, // 占位待调
    pickupMul: 1,
    ballisticMul: 1,
    energyMul: 1,
  },
  {
    id: AFFIX_MAGNETIC,
    slug: 'magnetic',
    devName: '磁力干扰',
    devDescription: '玩家拾取半径 ×0.5(读 dropMagnetRadius 处挂修正)',
    frenzyRadius: 0,
    frenzySpeedMul: 1,
    splitCount: 0,
    pickupMul: 0.5, // 占位待调
    ballisticMul: 1,
    energyMul: 1,
  },
  {
    id: AFFIX_ARMORED,
    slug: 'armored',
    devName: '装甲',
    devDescription: '弹药系伤害 ×0.3(与塔的 throttle=THR_AMMO 对齐)',
    frenzyRadius: 0,
    frenzySpeedMul: 1,
    splitCount: 0,
    pickupMul: 1,
    ballisticMul: 0.3, // 占位待调(原 0.5:2026-08-15 威胁加压,减半改成砍到三成)
    energyMul: 1,
  },
  {
    id: AFFIX_PHASED,
    slug: 'phased',
    devName: '相位',
    devDescription: '能量系伤害 ×0.3(过热/充能两系,与塔的 throttle 对齐)',
    frenzyRadius: 0,
    frenzySpeedMul: 1,
    splitCount: 0,
    pickupMul: 1,
    ballisticMul: 1,
    energyMul: 0.3, // 占位待调(原 0.5:2026-08-15 威胁加压,与装甲词缀同一条口径)
  },
];

/**
 * 精英通用参数(GDD §6.4 / todos/14 + 16)—— 体型与 HP 放大、掉落面额,占位待调。
 * 与 enemies.ts 的表格同一条口径:改平衡只改这里,不改 sim 一行。
 * 两条掉落账各走各的:starCoins 按 STARCOIN_DROP_CHANCE 概率入账(见 data/economy);
 * scrapMul 是精英**经验掉落物**的面额倍率(改版 10 号后 World.spawnDrop 现读:精英 XP =
 * 底座 scrap × 它)。
 *
 * 2026-08-15 精英威胁加压(对局日志 seed 3462751984 复盘:7 只精英零接触命中、终局在
 * 峰值火力前活不过一次集火 —— 「增加精英怪」的同时必须让单只成为"必须停下手处理"的瞬间):
 *   hpMul 3 → 12:终局精英甲虫 = 40 × 1.72 × 12 ≈ 825 HP,在玩家终局单目标火力
 *   (~400–700 DPS)下 TTK ≈ 1.5–2.5s,叠装甲/相位减半后 3s+ —— 足够逼出一轮走位,
 *   又不会刷成血条墙(占位待调,真人体感后再拉);
 *   contactDamageMul 新增 = 2:精英的威胁不只血厚 —— 放它进身的每一记都该更疼;
 *   starCoins 10 → 15:威胁涨了,击杀面额跟着涨(≈ 1.5 次重摇)。
 */
export const ELITE = {
  /** 体型放大比例:渲染纹理、碰撞半径与冲锋几何都乘它(倍数建议真人试玩定稿) */
  scale: 1.5,
  /** HP 放大比例:精英 HP = 基础 HP × 时间缩放 × 它 */
  hpMul: 12,
  /** 接触伤害倍率(与 hpMul 同一条"独立倍率"口径,sim/world.ts 的 settleHullDamage 现读):
   *  精英接触 = 底座 contactDamage × 它 —— "放进身有代价",精英不只是一块更厚的血条 */
  contactDamageMul: 2,
  /** 精英经验掉落物的面额倍率:精英 XP = 底座 scrap × 它(World.spawnDrop 现读) */
  scrapMul: 3,
  /** 精英星币面额(16 号):命中掉率时当场进账 world.starCoins,零 rng 面额、掉的就是"这一只"的。
   *  1 只精英 = 1 次重摇的价(10) → 2026-08-15 随威胁加压抬到 15(≈ 1.5 次重摇) */
  starCoins: 15,
};
