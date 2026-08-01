/**
 * 可热调参数。Tweakpane 直接绑定本对象,改动即时生效。
 * 初值来自 GDD §3.2 / §14(全部占位,M0 调优)。
 * 原则(todos/05):数值只进配置,不写死在逻辑里。
 */
export const tuning = {
  // —— 船(GDD §3.2,02 号 issue 接线)——
  shipCruiseSpeed: 130, // px/s
  shipAccel: 260, // px/s²
  shipTurnRate: 100, // °/s,全游戏最重要的手感参数
  shipDamping: 1.2, // 松手 ~1.2s 内停

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
