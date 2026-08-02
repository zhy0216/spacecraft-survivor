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
  // 以下四项由 sim/ship.ts 的 stepShip 每逻辑帧现读:现读才有"面板拖一下立刻能体感对比",
  // 缓存进局部变量就得重启才生效(02 号 issue 验收标准)。
  shipCruiseSpeed: 130, // px/s
  shipAccel: 260, // px/s²
  shipTurnRate: 100, // °/s,全游戏最重要的手感参数
  shipDamping: 1.2, // 松手 ~1.2s 内停
  // 船体尺寸:渲染器构造时一次性读取(灰盒多边形只建一次),故不进调参面板 ——
  // 运行期改不会重建几何,只会让镜头缩放与船体实际大小口径错位。
  // 这两个数同时是 3×4 甲板的包围盒:格边长不在任何地方写死,由 sim/deck 的 deckCellSize()
  // 现算 = min(shipLength / DECK_ROWS, shipWidth / DECK_COLS) —— 取较小轴才保证甲板撑不破包围盒。
  // 于是改这里就等于改格子大小,渲染层的格线与放置拾取都跟着走同一个数,不会再有第三处口径。
  shipLength: 150, // 船体长度(世界 px,船头→船尾);÷ 4 行 = 37.5
  shipWidth: 112, // 船体宽度(世界 px,船宽方向);÷ 3 列 ≈ 37.33 —— 当前的较小轴,即实际格边长

  // —— 镜头(GDD §3.3)——渲染层每帧现读,可热调
  cameraShipHeightFraction: 0.2, // 船占屏幕高度比例(GDD §3.3),决定固定缩放
  cameraLookAhead: 0.15, // 镜头向航向前方偏移的屏高比例(GDD §3.3)

  // —— 压测场景(01 号 issue 验收:1000 敌 + 500 弹 @60fps)——
  // 只剩敌人这一半:子弹的那一半(stressBullets / bulletSpeed)在 05 号 issue 整段删除 ——
  // 凭空重生的哑弹与真弹共用一个池,"500 弹不掉帧"测的就是假东西。500 弹改由塔真的打出来。
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
  // 出怪占比(轮盘赌权重,不必凑成 100)。08 号 issue 的波次脚本接手前的临时出怪器;
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
  hitFireRateMul: 0.75, // 被撞舷的塔在惩罚期内的射速倍率(<1 = 变慢);轻微,不制造死亡螺旋
  hitPenaltyTime: 0.5, // GDD §4.6 锁定:被撞舷闪红 + 射速惩罚的时长(秒),两者共用这一个计时器

  // —— 武器塔(05 号 issue)——一塔一个数的(伤害/射程/弧度/转速/节流)全在 src/data/towers.ts,
  // 这里只留**全局倍率**:与 enemySpeedScale 同口径,是面板上"整体拖一下看体感"的那种旋钮。
  // 04 号的 turretArcDeg / turretRange / turretTurnRate 三项全塔共用的占位由数值表一塔一档取代,已删。
  // sim/tower.ts 的 effectiveDamage / effectiveFireInterval 每逻辑帧现读它们(数值表永不 import 本文件,
  // 那是上下游关系,引回去就成环),故面板拖动即时生效。
  towerDamageScale: 1,
  towerFireRateScale: 1, // >1 = 全塔射得更快(除以它得到实际 fireInterval)
};

export type Tuning = typeof tuning;
