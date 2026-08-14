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
export const KIND_SPORE = 4; // 孢子炮手(远程:锚定喷吐弹幕,点防阵列的存在理由)
export const ENEMY_KIND_COUNT = 5;
export type EnemyKind = 0 | 1 | 2 | 3 | 4;

/**
 * Boss 的专用 kind 标记(15 号 T1)。**刻意不进 ENEMIES 表、不占 ENEMY_KIND_COUNT**:
 * 表长被"侧压 counts 长度 = ENEMY_KIND_COUNT"与"ENEMIES.length = ENEMY_KIND_COUNT"
 * 两条表级不变量钉死(waves.test.ts / enemies.test.ts),Boss 用独立常量 + 独立数值块
 * (下面那个 BOSS)承载,本表一行都不用动。
 * 取值 = **表长**(= 首个表外下标):22 号孢子炮手把表长从 4 推到 5,标记跟着让位成 5 ——
 * 它是"越界哨兵",必须永远落在 ENEMIES 之外,与表长撞车(Boss 被当普通型/普通型被当 Boss)
 * 是这一类最阴的 bug。塔/子弹/渲染对越界 kind 的兜底("kind 越界只是不打这一只")就是它的安全网:
 * 瞬时判定塔(激光/电弧)照常伤害它,弹道塔在渲染侧跟进前对它的越界兜底是"穿过去"。
 * **绝不用 affixes 位**:affixes ≠ 0 是 14 号精英的血条扫描与 ELITE 缩放的判据,
 * 撞上去 Boss 会被当成精英放大、还挂进精英血条。
 */
export const KIND_BOSS = ENEMY_KIND_COUNT;

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
  /** Boss HP = 底座 hp × 它,再乘 GDD §14 的时间缩放(出生时一次)。
   *  不再手填:由 Boss 闸门反推(见 sim/balance.ts 的 bossHpMulForGate —— 闸门配装的
   *  净 DPS × TTK 目标,单测钉 1% 自洽),这里只留最近一次推导的整数值供快速翻阅 */
  hpMul: number;
  /** Boss 击杀掉落的经验面额 = 底座 scrap × 它。**独立于 hpMul** ——
   *  旧口径把掉落挂在 hpMul 上(掉 12 倍),hpMul 被闸门抬到 52 后掉落会跟着变 600 残骸;
   *  掉落是经济账,血量是战斗账,两笔账不该共用一个旋钮(加字段解耦见 world.ts 的掉落结算) */
  dropMul: number;
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
  name: '母巢巨兽',
  scale: 4.5, // 底座半径 14 → 63；配合渲染层 1.5× 视觉倍率,默认镜头约占屏高 1/4
  hpMul: 47, // 闸门反推(自动求解):净 DPS × TTK 82.5s / 68.8 ≈ 47.5 → 取整 47;
  // Boss HP = 40 × 1.72 × 47 ≈ 3234。推导见 sim/balance.ts 的 bossHpMulForGate。再平衡跑 npm run balance
  dropMul: 12, // 掉落面额独立档(旧「×12」原样保留):Boss 击杀掉 4 × 12 = 48 残骸的经济账与血量账解耦
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
  summonCounts: [6, 2, 0, 0, 0], // 6 蜂群蛭 + 2 侧掠者,型号/数量直给;长度契约与 WaveBurst.counts 同款(长度 = ENEMY_KIND_COUNT,短一位会静默漏一型)
  starCoins: 30, // 3 次重摇的价(10 × 3),占位待调
};

// 行为 = 接近原语 + 是否带冲锋;四型全部由三原语(seek/strafe/charge)组合而成 ——
// 每多一型就多一个 class 的做法在这里会退化成一堆只差两个数的子类。
export const BH_SEEK = 0; // 直线追船
export const BH_STRAFE = 1; // 绕到指定方位角驻留
export const BH_STRAFE_CHARGE = 2; // 绕到侧向 →(短)前摇 → 冲刺穿过 → 脱离
export const BH_SEEK_CHARGE = 3; // 直线接近 → 进射程(长)前摇 → 冲刺
export const BH_SPORE = 4; // 孢子炮手:接近 → 进射程带锚定 → 蓄力预警 → 喷吐弹幕 → 按间隔循环

/** 灰盒剪影形状:渲染层据此选纹理,sim 不关心 */
export type EnemyShape = 'circle' | 'arrow' | 'capsule' | 'hex' | 'spore';

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
  /**
   * 死了进账多少**星币**(用户设计会:星币总是获得,击杀单位就有,精英/Boss 更多)。
   * 与 scrap 同一条口径:**必掉、面额按型定死、击杀当场直接进账 World.starCoins**,
   * 不造掉落物、不掷随机(与残骸的"掉落物 + 磁吸拾取"不同 —— 星币直接进账)。
   * 普通怪 1-4 按敌型(虫群 1 / 侧掠 2 / 尾随 2 / 甲虫 4 / 孢子 3),占位待调;
   * 精英/Boss 的面额在 ELITE.starCoins / BOSS.starCoins,不进本表。
   */
  starCoins: number;
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
  // —— 远程喷吐(GDD §6.2 孢子炮手);其余型填 0 ——
  /** 进入射程带的上界:距船 ≤ 它就该锚定;离开它(船逃出)就重新就位 */
  sporeRange: number;
  /** 射程带的下界:距船 < 它说明玩家贴脸了,后撤保持距离带(否则锚定就退化成白白挨打) */
  sporeMinRange: number;
  /** 两轮齐射之间的间隔 s。**时间驱动、零 rng**:齐射时刻只由锚定后的计时器决定,不掷随机 */
  sporeInterval: number;
  /** 开火前的前摇 s:渲染层据此画收缩预警环("环合拢即开火") */
  sporeWarnTime: number;
  /** 弹丸飞行速度 px/s */
  sporeSpeed: number;
  /** 单发弹丸伤害(命中走 world.damageShip,与接触伤害同一入口) */
  sporeDamage: number;
  /** 一轮齐射几发(1–3) */
  sporeSalvoCount: number;
  /** 齐射扇面的半展宽(度):多发弹丸固定错开,不掷随机 */
  sporeSpreadDeg: number;
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
    starCoins: 1, // 占位待调:场上最多的口粮型,面额给最小档(用户设计会:击杀即有)
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
    sporeRange: 0,
    sporeMinRange: 0,
    sporeInterval: 0,
    sporeWarnTime: 0,
    sporeSpeed: 0,
    sporeDamage: 0,
    sporeSalvoCount: 0,
    sporeSpreadDeg: 0, // 非远程型,整段填 0
    // 洋红(H=300)。刻意不取高饱和洋红:那一档在**红色盲**模拟下会塌到船体 0x2b4a6e 附近
    // (OKLab 距 0.065 < 阈值 0.08),于是这里退一步换饱和度 —— 色相仍是洋红,贴图那边照 H=300
    // 重着色、虫体本身的饱和度不受影响,只有死亡爆点这一处偏淡。
    tint: 0xbd84bd,
    shape: 'circle',
  },
  {
    kind: KIND_STRAFER,
    name: '侧掠者',
    hp: 20, // GDD §14 锁定
    contactDamage: 10, // GDD §14 锁定
    scrap: 2, // 占位待调,平衡口径见 data/economy.ts(血厚一倍多、还要抓它切进来的那一下,给两颗)
    starCoins: 2, // 占位待调:与 scrap 同档(侧掠者)
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
    sporeRange: 0,
    sporeMinRange: 0,
    sporeInterval: 0,
    sporeWarnTime: 0,
    sporeSpeed: 0,
    sporeDamage: 0,
    sporeSalvoCount: 0,
    sporeSpreadDeg: 0, // 非远程型,整段填 0
    // 橙,五型里**明度最高**的一档(H=25):它是唯一"突发侧切"的型,最亮 = 余光里也能先看见它进场。
    // 到不了"橙金"是因为 g ≤ 0x8c 这条硬线(见 enemies.test.ts):金色要 g≈0xa0,越线就滑向暖黄、
    // 离我方冷色域反而更近。g 顶到 0x8c 就是这条线上最橙的一点。贴图重着色同色相。
    tint: 0xff8c3c,
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
    starCoins: 2, // 占位待调:与 scrap 同档(尾随蛆)
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
    sporeRange: 0,
    sporeMinRange: 0,
    sporeInterval: 0,
    sporeWarnTime: 0,
    sporeSpeed: 0,
    sporeDamage: 0,
    sporeSalvoCount: 0,
    sporeSpreadDeg: 0, // 非远程型,整段填 0
    // 深绯红,五型里**明度最低**的一档(H=344):它赖在船尾死角、不冲锋,靠"暗"与最亮的
    // 侧掠者拉开两端;色相只与冲撞甲虫差 6°,分家全靠明度 —— 两者的贴图重着色同样按这个差做。
    // 仍是暖绯红而不是高蓝紫:敌纹理还会乘灰底,原紫色在绿色盲模拟下会与我方靛蓝塔合流。
    tint: 0xb01030, // 色盲合成审计见 render/palette.test.ts;r 顶着 0xb0 的下限(最暗的合法红)
    shape: 'capsule',
  },
  {
    kind: KIND_BEETLE,
    name: '冲撞甲虫',
    hp: 40, // 占位待调
    contactDamage: 18, // 占位待调
    scrap: 4, // 占位待调,平衡口径见 data/economy.ts(全场最硬、最疼的一型,打掉它该有一次看得见的进账)
    starCoins: 4, // 占位待调:最硬的一型给最大档(冲撞甲虫)
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
    sporeRange: 0,
    sporeMinRange: 0,
    sporeInterval: 0,
    sporeWarnTime: 0,
    sporeSpeed: 0,
    sporeDamage: 0,
    sporeSalvoCount: 0,
    sporeSpreadDeg: 0, // 非远程型,整段填 0
    // 猩红(H=356,r 拉满):最疼的一型占最"警报"的那个红。与尾随蛆只差 8° 色相,
    // 两者分家全靠明度(r=255 对 r=176)—— 贴图重着色也按这个差做。
    // Boss 是它的放大版,重着色时按同一档明度处理,两者一眼同族。
    tint: 0xff1f2e,
    shape: 'hex',
  },
  {
    kind: KIND_SPORE,
    name: '孢子炮手',
    // GDD §6.2 的远程型:锚定喷吐弹幕,逼玩家脱离航线过去杀它 —— 点防阵列(TOWER_PD)
    // 存在的全部理由。HP 卡在尾随蛆与甲虫之间:它是"放着不管就会持续掉血"的威胁,
    // 但本身不该像甲虫那样要集火半天(玩家还得在炮火里飞过去打它)
    hp: 26, // 占位待调
    contactDamage: 2, // 占位待调(远程型几乎不贴脸;留着 2 是给"被虫群挤到船上"这类边角情形一个兜底)
    scrap: 3, // 占位待调,平衡口径见 data/economy.ts(比尾随蛆多一颗:逼你绕路的那份操作成本)
    starCoins: 3, // 占位待调:远程炮台逼你绕路,面额卡在甲虫之下(孢子炮手)
    speed: 60, // 占位待调(接近段慢:它是炮台不是猎手,压力全在喷吐上)
    accel: 5, // 占位待调(锚定/重新就位时转向迟钝些,给玩家贴脸的机会)
    radius: 8, // 占位待调(体型介于蜂群蛭与侧掠者之间:远程型的判定体不该太大,否则太好打)
    behavior: BH_SPORE, // 接近 → 射程带锚定 → 蓄力 → 喷吐,状态机见 sim/enemy.ts
    strafeOffsetDeg: 0,
    strafeRadius: 0,
    chargeRange: 0,
    chargeWindup: 0,
    chargeSpeed: 0,
    chargeDuration: 0,
    chargeRecover: 0, // 不冲锋,冲锋段全 0
    // 射程带 = [sporeMinRange, sporeRange]:进带锚定、出带重新就位,带本身自带迟滞,
    // 船在带边缘小幅漂移不会让它反复起锚(机制在 sim/enemy.ts,这里只给两个数)
    sporeRange: 300, // 占位待调(锚定距离 > 点防射程 210:弹幕有 ~0.4s 的拦截窗口,够点防表态又不白给)
    sporeMinRange: 180, // 占位待调(玩家贴进这个圈它就后撤 —— "贴脸换掉炮台"必须真的可行)
    sporeInterval: 2.2, // 占位待调(两轮齐射间隔;**零 rng**:齐射时刻由锚定后计时器决定,同 seed 逐帧可复现)
    sporeWarnTime: 0.8, // 占位待调(蓄力预警:0.8s 够玩家看清"这只要喷了"并开始转舷)
    sporeSpeed: 220, // 占位待调(慢于点防弹速 560 一半以上:拦截弹追得上,玩家转舵也躲得开)
    sporeDamage: 8, // 占位待调(单发 ≈ 1.6 只蜂群蛭的咬伤:三发全中很疼,但每一发都看得见、躲得开)
    sporeSalvoCount: 3, // 占位待调(一轮三发 = "齐射"的读数,一发一发地喷就退化成普通怪了)
    sporeSpreadDeg: 12, // 占位待调(三发固定错开的扇面半展宽:不叠成一根"大弹",也不散到全躲得掉)
    // 紫罗兰(H=288):暖色域最"紫"的一端 —— GDD §12 的红紫域到此为止,再往下就是我方冷蓝。
    // 它是唯一的远程型,离船最远、最该一眼认出来,故占住与另外四型跨度最大的那个色相。
    // 再紫一点就会跌破 r ≥ 0xb0(紫的红分量随色相下滑),288° 是这条线上最紫的一点。
    // 色盲合成审计见 render/palette.test.ts。
    tint: 0xb400e0,
    shape: 'spore', // 带刺球:与圆型蜂群蛭(纯圆)同族但多一圈尖刺,色相之外的第二条辨识通道
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
