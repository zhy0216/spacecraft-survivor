/**
 * 可热调参数。Tweakpane 直接绑定本对象,改动即时生效。
 * 初值来自 GDD §3.2 / §14(全部占位,M0 调优)。
 * 原则(todos/05):数值只进配置,不写死在逻辑里。
 */
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
  shipLength: 150, // 船体长度(世界 px,船头→船尾)。03 号 issue 的 3×4 甲板占位:cell ≈ 37.5
  shipWidth: 112, // 船体宽度(世界 px,3 格)

  // —— 镜头(GDD §3.3)——渲染层每帧现读,可热调
  cameraShipHeightFraction: 0.2, // 船占屏幕高度比例(GDD §3.3),决定固定缩放
  cameraLookAhead: 0.15, // 镜头向航向前方偏移的屏高比例(GDD §3.3)

  // —— 压测场景(01 号 issue 验收:1000 敌 + 500 弹 @60fps)——
  stressEnemies: 1000,
  stressBullets: 500,
  enemySpeed: 80, // 蜂群蛭 80 px/s(GDD §14)
  enemySeparation: 14, // 邻居分离半径 px(制造空间哈希查询负载)
  // 最大敌半径:空间哈希 cell = 半径×2(GDD §13)。World 构造时一次性读取,
  // 故不进调参面板 —— 运行期改会让已分桶的数据与查询半径口径错位。
  enemyRadiusMax: 14,
  bulletSpeed: 420, // px/s
};

export type Tuning = typeof tuning;
