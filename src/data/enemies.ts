/**
 * 敌人数值表(07 号 issue T2)—— 纯数据,零 import。
 * 连 sim/config 都不引:数据表是它的上游(tuning.enemyRadiusMax 反过来读这里的
 * ENEMY_RADIUS_MAX),引回去就成环了。铁律:src/data 与 src/sim 一样永不 import pixi/DOM。
 * 存在的意义是 05 号 issue 的验收口径:改平衡只改本文件,不改一行逻辑代码。
 *
 * 分型不用 class 继承 + 虚函数,而是"数字 kind/behavior 字段 + switch 分派":
 * 1000 敌同屏是硬性能预算(GDD §13),扁平对象 + 单态 switch 才不给 V8 添堵。
 * 也不用 enum(isolatedModules 下不划算),用导出的数字常量 + 联合类型。
 *
 * 字段刻意不加 readonly、不 Object.freeze:单测要照 ship.test.ts 改 tuning 的既有做法,
 * 临时改字段(afterEach 还原)来验证"前摇时长可配 / 改数据即可调平衡"。
 *
 * 除 GDD §14 锁定的几项外,全部占位待调(M0 边玩边调)。
 */

export const KIND_SWARM = 0; // 蜂群蛭
export const KIND_STRAFER = 1; // 侧掠者
export const KIND_TRAILER = 2; // 尾随蛆
export const KIND_BEETLE = 3; // 冲撞甲虫
export const ENEMY_KIND_COUNT = 4;
export type EnemyKind = 0 | 1 | 2 | 3;

/**
 * Boss 的专用 kind 标记(15 号 T1)。**刻意不进 ENEMIES 表、不占 ENEMY_KIND_COUNT**:
 * 表长被"侧压 counts 长度 = ENEMY_KIND_COUNT"与"ENEMIES.length = ENEMY_KIND_COUNT"
 * 两条表级不变量钉死(waves.test.ts / enemies.test.ts),Boss 用独立常量 + 独立数值块
 * (下面那个 BOSS)承载,本表一行都不用动。
 * 塔/子弹/渲染对越界 kind 的兜底("kind 越界只是不打这一只")就是它的安全网:
 * 瞬时判定塔(激光/电弧)照常伤害它,弹道塔在渲染侧跟进前对它的越界兜底是"穿过去"。
 * **绝不用 affixes 位**:affixes ≠ 0 是 14 号精英的血条扫描与 ELITE 缩放的判据,
 * 撞上去 Boss 会被当成精英放大、还挂进精英血条。
 */
export const KIND_BOSS = 4;

/** Boss 数值块(15 号 T1):Boss = **放大的四型之一**,底座见 baseKind,所有数字都是
 * 底座值的倍率或直接给秒数 —— 改平衡只改这里,sim/boss.ts 一行都不动。
 * "大质量撞击伤害更高"就是 contactDamageMul(接触伤害乘倍率),不新开机制。 */
export interface BossDef {
  /** 底座敌型(Boss 是它的大号版):体型/HP/接触伤害/冲锋参数从它的数值乘倍率 */
  baseKind: EnemyKind;
  /** 只给人看(结算界面/调试面板),逻辑不读 */
  name: string;
  /** 体型放大倍率:碰撞半径 = 底座 radius × 它(bossRadius() 的唯一来源) */
  scale: number;
  /** Boss HP = 底座 hp × 它,再乘 GDD §14 的时间缩放(出生时一次) */
  hpMul: number;
  /** 接触伤害 = 底座 contactDamage × 它(大质量撞击伤害更高,09 号模型只换数值) */
  contactDamageMul: number;
  /** 接近段速度 = 底座 speed × 它(大而慢,才压得出"巨型个体"的压迫感) */
  speedMul: number;
  /** 追随系数 = 底座 accel × 它(转向迟钝,绕开有解) */
  accelMul: number;
  /** 冲锋起手距离 = 底座 chargeRange × 它 */
  chargeRangeMul: number;
  /** 前摇时长 s:比底座长 —— 巨型个体的冲锋更要"看得懂、来得及躲" */
  chargeWindup: number;
  /** 冲刺速 = 底座 chargeSpeed × 它 */
  chargeSpeedMul: number;
  chargeDuration: number;
  /** 冲完的硬直 s(反打窗口) */
  chargeRecover: number;
  /** 召唤周期 s:每过这么久召唤一批蜂群(Boss 活着才计时) */
  summonInterval: number;
  /** 召唤预告窗口 s:World.bossSummonCooldown < 它时渲染层应提前预警(与精英预警共用提示通道) */
  summonWarnTime: number;
  /** 召唤怪出生环半径 px,以 Boss 为心 */
  summonRingRadius: number;
  /**
   * 一次召唤的逐型只数,**下标 = KIND_***、长度 = ENEMY_KIND_COUNT(与 WaveBurst.counts 同口径)。
   * 型号/数量直给、不掷随机 —— 只有每只召唤怪的出生角掷一次(见 sim/world 的召唤)。
   */
  summonCounts: number[];
  /** Boss 必掉星币面额(16 号):击杀当场进账 world.starCoins,零 rng、固定面额、掉的就是"这一只"的。
   *  旧口径"底座 scrap × scrapMul 的 4× 残骸"整体替换为它(16 号星币落地);占位待调 */
  starCoins: number;
}

/** Boss = 放大的冲撞甲虫(四型里唯一"直线蓄力冲锋"的,收尾高潮要的就是这一型的身位压力) */
export const BOSS: BossDef = {
  baseKind: KIND_BEETLE,
  name: '合围巨兽',
  scale: 2.5, // 底座半径 14 → 35:比精英(14 × 1.5 = 21)还大一圈
  hpMul: 12, // 底座 40 → 480(8 分钟时间缩放后 ≈ 826)
  contactDamageMul: 2, // 底座 18 → 36:大质量撞击
  speedMul: 0.8, // 底座 70 → 56:大而慢
  accelMul: 0.5, // 底座 4 → 2:转向迟钝
  chargeRangeMul: 1.5, // 底座 420 → 630:大个子起手圈跟着大
  chargeWindup: 1.2, // 底座 0.9 → 1.2:更长前摇,预告更早
  chargeSpeedMul: 1, // 底座 380 → 380
  chargeDuration: 1.2, // 占位待调
  chargeRecover: 1.8, // 占位待调(冲完长硬直 = 反打窗口)
  summonInterval: 9, // 占位待调:每 9 秒召唤一批
  summonWarnTime: 1.5, // 占位待调:最后 1.5s 给预告
  summonRingRadius: 120, // 占位待调
  summonCounts: [6, 2, 0, 0], // 6 蜂群蛭 + 2 侧掠者,型号/数量直给
  starCoins: 30, // 3 次重摇的价(10 × 3),占位待调
};

// 行为 = 接近原语 + 是否带冲锋;四型全部由三原语(seek/strafe/charge)组合而成 ——
// 每多一型就多一个 class 的做法在这里会退化成一堆只差两个数的子类。
export const BH_SEEK = 0; // 直线追船
export const BH_STRAFE = 1; // 绕到指定方位角驻留
export const BH_STRAFE_CHARGE = 2; // 绕到侧向 →(短)前摇 → 冲刺穿过 → 脱离
export const BH_SEEK_CHARGE = 3; // 直线接近 → 进射程(长)前摇 → 冲刺

/** 灰盒剪影形状:渲染层据此选纹理,sim 不关心 */
export type EnemyShape = 'circle' | 'arrow' | 'capsule' | 'hex';

export interface EnemyDef {
  kind: EnemyKind;
  name: string;
  hp: number;
  contactDamage: number;
  /**
   * 死了掉多少残骸(10 号 issue),**必须是 ≥ 0 的整数**:残骸是全程唯一成长资源(GDD §7),
   * 而升级曲线按整点记账 —— 掉半颗残骸会让"离下一次升级还差几只怪"这条读数变成一句没法验的近似
   * (表级不变量见 enemies.test.ts)。
   * 每只**必掉、价值按型定死**:不掷随机、不按伤害归因,于是战斗打得好不好反过来扰动不到
   * 出怪的随机序列(08 号"同 seed 同出怪序列"因此照旧成立)。
   * 四型的数只是**占位待调**,平衡口径见 src/data/economy.ts —— 一局升几次由"总掉落量 × 升级曲线"
   * 一起决定,单看这里任何一个数都没有意义。
   */
  scrap: number;
  /** 接近段基础速度 px/s;实际速度还要乘 tuning.enemySpeedScale */
  speed: number;
  /** 期望速度的追随系数 1/s(转向力寻路,GDD §13 无 A*);越大越"贴脸咬得死" */
  accel: number;
  radius: number;
  /** BH_*,状态机 switch 分派用 */
  behavior: number;
  /** 驻留方位角(相对船头,度):±90 是舷侧,180 是船尾 */
  strafeOffsetDeg: number;
  /** 驻留半径 px:绕船盘旋的目标距离 */
  strafeRadius: number;
  /** 进入前摇的距离阈值 px */
  chargeRange: number;
  /** 前摇时长 s —— 冲锋型"看得懂、来得及躲"的唯一旋钮 */
  chargeWindup: number;
  chargeSpeed: number;
  chargeDuration: number;
  /** 冲完的硬直 s:靠惯性滑出去 = "啃咬后脱离" */
  chargeRecover: number;
  /** 渲染色(GDD §12:敌方红紫暖色域,与冷色船体完全分离,色盲安全) */
  tint: number;
  shape: EnemyShape;
}

/** 下标 === kind,顺序 swarm/strafer/trailer/beetle;stepEnemyBehavior 靠 ENEMIES[e.kind] 直取 */
export const ENEMIES: EnemyDef[] = [
  {
    kind: KIND_SWARM,
    name: '蜂群蛭',
    hp: 8, // GDD §14 锁定
    contactDamage: 5, // GDD §14 锁定
    // 占位待调,平衡口径见 data/economy.ts。1 = 最小面额:它是场上最多、最好打的口粮型,
    // 一局的残骸大头本来就该由"打了很多只"而不是"每只值很多"堆出来
    scrap: 1,
    speed: 80, // GDD §14 锁定
    accel: 6, // 占位待调(= 01 号压测里 SEEK_ACCEL 的推广,四型的基准手感)
    radius: 7, // 占位待调
    behavior: BH_SEEK, // 慢速大量、直线追船 = 持续正压,广弧塔的口粮
    strafeOffsetDeg: 0,
    strafeRadius: 0,
    chargeRange: 0,
    chargeWindup: 0,
    chargeSpeed: 0,
    chargeDuration: 0,
    chargeRecover: 0, // 不冲锋,冲锋段全 0
    tint: 0xff4d6d, // 占位待调
    shape: 'circle',
  },
  {
    kind: KIND_STRAFER,
    name: '侧掠者',
    hp: 20, // GDD §14 锁定
    contactDamage: 10, // GDD §14 锁定
    scrap: 2, // 占位待调,平衡口径见 data/economy.ts(血厚一倍多、还要抓它切进来的那一下,给两颗)
    speed: 150, // 占位待调(接近段速度;GDD §14 锁的 220 是下面的冲刺速)
    accel: 8, // 占位待调
    radius: 9, // 占位待调
    behavior: BH_STRAFE_CHARGE, // 突发侧压,逼玩家换舷
    strafeOffsetDeg: 90, // 占位待调(舷侧起手;实际左右舷由 e.side 在生成时定死)
    strafeRadius: 260, // 占位待调
    chargeRange: 300, // 占位待调
    chargeWindup: 0.35, // 占位待调(短前摇:侧向切入要"突发",给太多预告就没压力了)
    chargeSpeed: 220, // GDD §14 锁定
    chargeDuration: 1.1, // 占位待调(够穿过船身)
    chargeRecover: 1.2, // 占位待调(硬直里靠惯性滑出去 = "啃咬后脱离")
    tint: 0xff8c42, // 占位待调
    shape: 'arrow',
  },
  {
    kind: KIND_TRAILER,
    name: '尾随蛆',
    hp: 14, // 占位待调
    contactDamage: 6, // 占位待调
    // 占位待调,平衡口径见 data/economy.ts。与侧掠者同档:它血没那么厚,但赖在船尾死角上,
    // 玩家得转舵把火力送过去才拿得到 —— 那份操作成本也该算进价钱里
    scrap: 2,
    speed: 125, // 占位待调(必须快过船的巡航 130 的大半,否则永远绕不到尾)
    accel: 7, // 占位待调
    radius: 8, // 占位待调
    behavior: BH_STRAFE, // 只驻留不冲锋:惩罚火力死角舷
    strafeOffsetDeg: 180, // 占位待调(船尾正后方)
    // 占位待调(贴得近才叫"咬尾")。35 是按 48×36 的船身算的:船尾轮廓接触带 = 半长 24 + 体型 8
    // = 32,驻留 35 只差 3px —— 它不冲锋,驻留半径就是它唯一够得到船的机制,
    // 必须压着轮廓摆,否则这一型(惩罚船尾死角)在几何上整个失效。改船体尺寸要连着它一起调
    strafeRadius: 35,
    chargeRange: 0,
    chargeWindup: 0,
    chargeSpeed: 0,
    chargeDuration: 0,
    chargeRecover: 0, // 不冲锋,冲锋段全 0
    // 暖绯红而不是高蓝紫：敌纹理还会乘灰底；原紫色在绿色盲模拟下会与我方靛蓝塔合流。
    tint: 0xd42844, // 占位待调；色盲合成审计见 render/palette.test.ts
    shape: 'capsule',
  },
  {
    kind: KIND_BEETLE,
    name: '冲撞甲虫',
    hp: 40, // 占位待调
    contactDamage: 18, // 占位待调
    scrap: 4, // 占位待调,平衡口径见 data/economy.ts(全场最硬、最疼的一型,打掉它该有一次看得见的进账)
    speed: 70, // 占位待调(接近段慢,压力全在冲锋那一下)
    accel: 4, // 占位待调(转向迟钝,绕开它是有解的)
    radius: 14, // 占位待调,但它同时钉着 ENEMY_RADIUS_MAX = 14 → 空间哈希 cell 与今天一致
    behavior: BH_SEEK_CHARGE, // 直线蓄力冲锋,考验转向躲避
    strafeOffsetDeg: 0,
    strafeRadius: 0,
    chargeRange: 420, // 占位待调
    // 占位待调。0.9s 是"来得及躲"的算术依据:船 100°/s → 前摇期间玩家能转 90°,
    // 足够把船身转出冲锋直线。调小到 0.3 就会变成无解的秒杀,这是本型最敏感的一个数。
    chargeWindup: 0.9,
    chargeSpeed: 380, // 占位待调
    chargeDuration: 1.0, // 占位待调
    chargeRecover: 1.5, // 占位待调(冲完长硬直 = 反打窗口)
    tint: 0xff1f4b, // 占位待调
    shape: 'hex',
  },
];

/**
 * 空间哈希 cell = 它 ×2(GDD §13:查询半径不超过一个 cell 时,3×3 邻域必然覆盖)。
 * 从表里推导而不是写死:加了新敌型只改 radius,cell 口径自动跟上,不会悄悄失配。
 * 模块加载时算一次 —— 与 World 构造时一次性读 tuning.enemyRadiusMax 同口径。
 */
export const ENEMY_RADIUS_MAX = ENEMIES.reduce((m, d) => (d.radius > m ? d.radius : m), 0);

/** 星区 HP 乘数。GDD §14 是 ×1 / ×1.8 / ×3,单地图 MVP(08)只有第一星区,固定 ×1 */
export const ZONE_HP_MULT = 1;
