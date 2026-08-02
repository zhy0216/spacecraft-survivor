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
    speed: 125, // 占位待调(必须快过船的巡航 130 的大半,否则永远绕不到尾)
    accel: 7, // 占位待调
    radius: 8, // 占位待调
    behavior: BH_STRAFE, // 只驻留不冲锋:惩罚火力死角舷
    strafeOffsetDeg: 180, // 占位待调(船尾正后方)
    strafeRadius: 90, // 占位待调(贴得近才叫"咬尾")
    chargeRange: 0,
    chargeWindup: 0,
    chargeSpeed: 0,
    chargeDuration: 0,
    chargeRecover: 0, // 不冲锋,冲锋段全 0
    tint: 0xb14dff, // 占位待调
    shape: 'capsule',
  },
  {
    kind: KIND_BEETLE,
    name: '冲撞甲虫',
    hp: 40, // 占位待调
    contactDamage: 18, // 占位待调
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
