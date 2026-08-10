/**
 * 可热调参数。Tweakpane 直接绑定本对象,改动即时生效。
 * 初值来自 GDD §3.2 / §14(全部占位,M0 调优)。
 * 原则(todos/05):数值只进配置,不写死在逻辑里。
 *
 * 分工:一型一个数的(各敌型血量/速度/前摇)进 src/data/enemies.ts;
 * 全局性的倍率与阈值留在这里 —— 后者才是面板上"拖一下看体感"的旋钮。
 */
import { ENEMY_RADIUS_MAX } from '../data/enemies';

export const tuning = {
  // —— 船(GDD §3.2)——
  // 以下五项由 sim/ship.ts 的 stepShip 每逻辑帧现读:现读才有"面板拖一下立刻能体感对比",
  // 缓存进局部变量就得重启才生效(02 号 issue 验收标准)。
  shipCruiseSpeed: 130, // px/s
  shipAccel: 260, // px/s²
  shipTurnRate: 100, // °/s,全游戏最重要的手感参数
  // 转舵时每秒消掉多少比例的横向滑移。0 = 纯惯性漂移,越大则航迹越快跟上船头。
  // 4/s 保留一小段可读的侧滑,但不再出现"船头已转完、船还在横着冲"。
  shipSteeringGrip: 4, // 1/s
  shipDamping: 1.2, // 松手 ~1.2s 内停
  // 船体尺寸:渲染器构造时一次性读取(灰盒多边形只建一次),故不进调参面板 ——
  // 运行期改不会重建几何,只会让镜头缩放与船体实际大小口径错位。
  // 甲板网格删除后这两个数仍在用:
  //   shipLength / 2 = 船体受击圆半径(sim/damage 的 shipRadius)与炮管共享查询圈/接触粗筛
  //     (sim/turret 的 reach、sim/world 的 contacts 都读它);
  //   shipWidth 只决定船形宽高比,渲染层画船身用。
  // 48×36 = "船与敌人同尺度"的落点(敌半径 7~14,冲撞甲虫直径 28,船身 48 只比最大的敌型
  // 大一圈):战斗中船是一枚与虫群同台的棋子,武器硬点(armory 的 WEAPON_HARDPOINTS)与受击圆
  // 都以它为尺度 —— 改这两个数,硬点与判定体自动跟着走。
  shipLength: 48, // 船体长度(世界 px,船头→船尾);÷ 2 = 受击圆半径 24
  shipWidth: 36, // 船体宽度(世界 px,船宽方向)

  // —— 镜头(GDD §3.3)——渲染层每帧现读,可热调
  // 0.064 与 shipLength 48 是**一对**:缩放 = 屏高 × 0.064 ÷ 48 = 屏高 ÷ 750,
  // 与旧口径(屏高 × 0.2 ÷ 150)完全相同 —— 船缩小 3.125 倍的同时把占屏比例同倍调低,
  // 敌人/射程/磁吸/出怪半径的**屏幕观感一个都不变**(data/waves.ts 的 SPAWN_RADIUS
  // 推导也因此原样成立)。想拉近拉远镜头,改它;想改船的世界体型,连 shipLength 一起改。
  cameraShipHeightFraction: 0.064, // 船占屏幕高度比例,决定固定缩放
  cameraLookAhead: 0.15, // 镜头向航向前方偏移的屏高比例(GDD §3.3)

  // —— 压测场景(01 号 issue 验收:1000 敌 + 500 弹 @60fps)——
  // 只剩敌人这一半:子弹的那一半(stressBullets / bulletSpeed)在 05 号 issue 整段删除 ——
  // 凭空重生的哑弹与真弹共用一个池,"500 弹不掉帧"测的就是假东西。500 弹改由塔真的打出来。
  /**
   * debug:回到 01 号的 1000 敌压测出怪(旁路波次脚本,本局不再有胜利条件)。
   * 08 号正式出怪器默认走脚本 —— 打开它,World 就整段绕开 sim/waves.ts 的运行器,
   * 波次状态冻在初值(方向不转、永不走完),换来的是"场上恒定 N 只"这种压测才要的定数。
   */
  stressSpawn: false,
  /** **仅 stressSpawn = true 时生效**:压测路径维持的在场敌人数 */
  stressEnemies: 1000,
  enemySeparation: 14, // 邻居分离半径 px(制造空间哈希查询负载)
  // 最大敌半径:空间哈希 cell = 半径×2(GDD §13)。从数值表推导,不在这里写死 ——
  // 加一型敌人只改 src/data/enemies.ts 的 radius,cell 口径自动跟上。
  // World 构造时一次性读取,故不进调参面板:运行期改会让已分桶的数据与查询半径口径错位。
  enemyRadiusMax: ENEMY_RADIUS_MAX,

  // —— 敌人(GDD §14 / todos/07)——各型基础数值在 src/data/enemies.ts,这里只放全局量。
  // 与 stepShip 同口径:敌人状态机每逻辑帧现读,面板拖动即时生效,不缓存进局部常量。
  enemySpeedScale: 1, // 全局敌速倍率:压测想让虫潮慢下来看清行为时拖它,不去动数值表
  enemyHpScalePerMinute: 0.09, // GDD §14:敌方 HP ×(1 + 0.09·t分钟),单地图星区乘数固定 ×1
  // 出怪占比(轮盘赌权重,不必凑成 100)。**仅 stressSpawn = true 时生效** ——
  // 正式出怪器的型号由 src/data/waves.ts 的波次脚本逐条流给死,不掷随机(08 号 issue)。
  // 只影响新生成的敌人,已在场的不会变型。
  enemyMixSwarm: 70,
  enemyMixStrafer: 15,
  enemyMixTrailer: 10,
  enemyMixBeetle: 5,

  // —— 受击模型(GDD §4.6 / §14,09 号 issue)——判定几何全在 src/sim/damage.ts,这里只有数。
  // 与 stepShip 那批同口径:除 shipHullHp 外全部每帧现读,面板拖一下立刻改体感。
  // GDD §14 锁定。hullMaxHp() 现读它,而 World.place() 每次放置成功都重刷 ship.maxHp
  //(为的是 06 号装甲舱的「船体 HP +15」)—— 所以拖它之后放一座塔,上限当场就变,hp 不回血
  shipHullHp: 100,
  // 核心区 = 初始 3×4 包围盒 × 它(GDD §4.4:判定小于外形,扩建不把船变成更大的靶子);占位待调
  shipCoreScale: 0.72,
  // 同一只敌人两次结算之间的间隔(无敌帧),秒。GDD 未写,但一帧一跳的话贴脸就是瞬杀 ——
  // 它与下面那个倍率合起来才是"蜂群贴脸掉血速率可控可调"的两根旋钮;占位待调
  enemyHitInterval: 0.6,
  enemyContactDamageScale: 1, // 全局撞击伤害倍率(各型的 contactDamage 在 src/data/enemies.ts)
  // 全局**敌方弹幕**伤害倍率(22 号孢子炮手):与 enemyContactDamageScale 同一条"面板旋钮"口径,
  // 但走独立的一根 —— 接触与弹幕是两个伤害来源,测试/压测要能只关其中一个
  enemySporeDamageScale: 1,
  hitFireRateMul: 0.75, // 被撞舷的塔在惩罚期内的射速倍率(<1 = 变慢);轻微,不制造死亡螺旋
  hitPenaltyTime: 0.5, // GDD §4.6 锁定:被撞舷闪红 + 射速惩罚的时长(秒),两者共用这一个计时器

  // —— 武器塔(05 号 issue)——一塔一个数的(伤害/射程/弧度/转速/节流)全在 src/data/towers.ts,
  // 这里只留**全局倍率**:与 enemySpeedScale 同口径,是面板上"整体拖一下看体感"的那种旋钮。
  // 04 号的 turretArcDeg / turretRange / turretTurnRate 三项全塔共用的占位由数值表一塔一档取代,已删。
  // sim/tower.ts 的 effectiveDamage / effectiveFireInterval 每逻辑帧现读它们(数值表永不 import 本文件,
  // 那是上下游关系,引回去就成环),故面板拖动即时生效。
  towerDamageScale: 1,
  towerFireRateScale: 1, // >1 = 全塔射得更快(除以它得到实际 fireInterval)

  // —— 残骸经济(改版 10 号)——只有磁吸这三根旋钮在这里,理由是分工那一段:
  // 掉落**价值**是一型一个数(敌人死了掉几颗),归 src/data/enemies.ts 的 scrap;
  // 升级曲线 / 三选一权重 / 跳过返还是"这一局的经济口径",归 src/data/economy.ts。
  // 留在这里的三项恰恰是面板上"拖一下就看得出体感"的那种全局量(与 shipTurnRate 同一类),
  // 由 sim/drop.ts 的 stepDrops 每逻辑帧现读:改了当帧生效,不必重开一局。
  // **80 是磁吸缩小后的新档**(用户设计会:经验是主要成长资源,捡取该有取舍 ——
  // 起吸半径从 240 收窄到 80,配合"磁力收集器支援 ×1.3 / 磁力过载法令 ×1.3"两条扩容路,
  // 玩家对抗"捡不到"的主要投资方向就是它们;实收效率仍是升级频率的实际闸门,
  // 见 data/economy.ts 的账 —— 与旧 240 的"航线擦过去 = 收得下"宽容档形成对照)
  dropMagnetRadius: 80, // 磁吸起吸半径 px;本轮唯一要能"拖一下看体感"的旋钮(验收标准第四条)
  // 磁吸速度 px/s。**必须显著大于 shipCruiseSpeed(130)**:残骸锁定后匀速直追船心,
  // 净逼近速度 = 本值 - 船速,拖到船速以下的话被吸住的残骸就永远吊在船屁股后面追不上
  dropMagnetSpeed: 400,
  // 收取半径 px;**必须远大于一帧位移**(400/60 ≈ 6.7px),否则残骸会一帧跨过收取圈。
  // (sim/drop.ts 另有一手"够得着船心就落在船心、不冲过头"兜底,但那是保险,不是让这个数可以乱填)
  dropCollectRadius: 22,
};

export type Tuning = typeof tuning;
