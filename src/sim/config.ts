/**
 * 可热调参数。Tweakpane 直接绑定本对象,改动即时生效。
 * 初值来自 GDD §3.2 / §14(全部占位,M0 调优)。
 * 原则(todos/05):数值只进配置,不写死在逻辑里。
 *
 * 分工:一型一个数的(各敌型血量/速度/前摇)进 src/data/enemies.ts;
 * 全局性的倍率与阈值留在这里 —— 后者才是面板上"拖一下看体感"的旋钮。
 */
import { ARC_MEDIUM_DEG } from '../data/arcs';
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
  stressEnemies: 1000,
  stressBullets: 500,
  enemySeparation: 14, // 邻居分离半径 px(制造空间哈希查询负载)
  // 最大敌半径:空间哈希 cell = 半径×2(GDD §13)。从数值表推导,不在这里写死 ——
  // 加一型敌人只改 src/data/enemies.ts 的 radius,cell 口径自动跟上。
  // World 构造时一次性读取,故不进调参面板:运行期改会让已分桶的数据与查询半径口径错位。
  enemyRadiusMax: ENEMY_RADIUS_MAX,
  bulletSpeed: 420, // px/s

  // —— 敌人(GDD §14 / todos/07)——各型基础数值在 src/data/enemies.ts,这里只放全局量。
  // 与 stepShip 同口径:敌人状态机每逻辑帧现读,面板拖动即时生效,不缓存进局部常量。
  enemySpeedScale: 1, // 全局敌速倍率:压测想让虫潮慢下来看清行为时拖它,不去动数值表
  enemyHpScalePerMinute: 0.09, // GDD §14:敌方 HP ×(1 + 0.09·t分钟),单地图星区乘数固定 ×1
  // 占位:船体接触判定圆(= shipWidth/2)。09 号 issue 会换成固定核心区 + 四舷判定,
  // 现在只用来把"贴到船了"这件事检出来放进 world.contacts,不结算伤害。
  shipContactRadius: 56,
  // 出怪占比(轮盘赌权重,不必凑成 100)。08 号 issue 的波次脚本接手前的临时出怪器;
  // 只影响新生成的敌人,已在场的不会变型。
  enemyMixSwarm: 70,
  enemyMixStrafer: 15,
  enemyMixTrailer: 10,
  enemyMixBeetle: 5,

  // —— 射界与炮管(04 号 issue)——三项全是占位:05 号的塔数值表接手后一塔一档,这里整段作废。
  // 与 stepShip 同口径:sim 每逻辑帧现读,面板拖动即时生效,不缓存进局部常量。
  turretArcDeg: ARC_MEDIUM_DEG, // 中 100°(GDD §4.2);本轮所有武器格统一用这一档
  turretRange: 380, // 自动机炮射程(GDD §14);本轮所有武器格统一用它
  turretTurnRate: 360, // 炮管转速上限 °/s(与 shipTurnRate 同单位口径),追瞄与归位共用
};

export type Tuning = typeof tuning;
