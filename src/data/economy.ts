/**
 * 残骸经济的数值口径(10 号 issue)—— 纯数据,零 import。
 * 与 data/enemies.ts 同一条上下游关系:src/data 是 src/sim 的**上游**,永不反过来 import sim
 *(也永不 import pixi/DOM)。存在的意义仍是 todos/05 那条验收:改本文件即可调平衡,不改一行逻辑。
 *
 * 分工(这三处别混着放,否则"改哪个数会动什么"就说不清了):
 *   一型一个数的掉落面额(哪一型死了掉几点残骸)→ data/enemies.ts 的 EnemyDef.scrap;
 *   磁吸的手感旋钮(起吸半径 / 磁吸速度 / 收取半径)→ sim/config.ts 的 tuning,那是面板上拖的东西;
 *   本文件放的是"这一局的经济口径" —— 既不属于某一型、也不该在面板上随手拖的那些数:
 *   升级曲线、三选一的类别权重、跳过返还,外加在场残骸这条保险丝。
 */

/**
 * —— 升级曲线 ——
 * 所需残骸 = BASE × GROWTH^级数(GDD §14 的形状:"10 × 1.25^级数")。
 * GROWTH 逐字照抄 GDD;**BASE 抬到了 35**,理由是那条曲线原本配的是另一种局长,把账算给下一个人看:
 *
 *   等比求和:攒够 N 次升级的累计残骸 = BASE × (GROWTH^N − 1) / (GROWTH − 1) = 4 × BASE × (1.25^N − 1)。
 *   GDD 的口径是 **25 分钟 / 22–26 次**:BASE = 10 时,26 次要 40 × (1.25²⁶ − 1) ≈ 13,200 残骸。
 *   MVP 单局只有 550s ≈ 9.2 分钟(data/waves.ts 的四段脚本),总出怪约 2700 只,
 *   按 data/enemies.ts 的面额 1/2/2/4 折算,**每只都打死、每颗都捡到**的理论上界也才 ≈ 3500 残骸。
 *   拿 BASE = 10 去接这 3500:1.25^N = 3500/40 + 1 ≈ 88.5 ⇒ N ≈ 20 次,远超 todos/10 的 12–15。
 *   把 BASE 抬成 3.5 倍(10 → 35)等于把整条曲线右移 log(3.5)/log(1.25) ≈ 5.6 次 ⇒ N ≈ 14.5,正落在窗口里。
 *
 * 于是"12–15 次"这条验收换算成本文件的语言就是:**一局收到的残骸要落在 [Σ12, Σ16) ≈ [1898, 4834)**
 *(Σn = 前 n 次升级的累计花费,取整后的实数见 economy.test.ts)。
 * 上界远高于理论满收的 3500 是有意的余量:够到 16 次意味着经济已经彻底崩了;
 * 而下界 1898 = 理论满收的 54% —— 实测跑不到 12 次,该先怀疑的是火力/掉落面额,不是这条曲线。
 *
 * 真正的裁判是 sim/economy.test.ts(用 08 的真脚本跑一局实测)。这两个数与 enemies.ts 的四个面额
 * 都只是**起点**:调平衡时只改这几个数、不改一行逻辑,正是 todos/05 立下的那条验收。
 */
export const UPGRADE_COST_BASE = 35;
export const UPGRADE_COST_GROWTH = 1.25; // GDD §14 逐字锁定

/**
 * 第 n 次升级(**n 从 0 起** = World.upgrades,即"已经结算过几次")所需残骸。
 *
 * **取整**:残骸是整点记账的(每只怪掉整数颗,World.scrap 恒为整数),
 * 价钱带小数的话 `scrap >= upgradeCost` 这条判据就会卡在"永远差 0.4 点"上,
 * 而 UI 上印出来的还是同一个整数 —— 玩家看到的是"钱够了却不弹卡"。
 * 用 round 而不是 floor:四舍五入更贴住那条等比曲线,累计误差不会一路往下偏。
 *
 * n < 0 / NaN / 小数一律夹回第 0 级。`n >= 1` 式的写法(而不是 `n < 1`)是为了把 **NaN 一并接住** ——
 * NaN 与任何数比较都是 false(与 data/towers.ts 的 clampLevel 同一条口径);
 * 少了这一手,一个未初始化的 upgrades 会让价钱变成 NaN,而 `scrap >= NaN` 恒 false ⇒ 整局再也不弹卡。
 * **上界不夹**:曲线本就该涨到玩家攒不动为止,那是"这一局到头了",不是一个要被兜住的错误。
 */
export function upgradeCost(upgrades: number): number {
  const n = upgrades >= 1 ? Math.floor(upgrades) : 0;
  return Math.round(UPGRADE_COST_BASE * Math.pow(UPGRADE_COST_GROWTH, n));
}

/**
 * 三选一(GDD §7 / §11)—— 是**设计口径不是旋钮**:改成四选一要连带改卡片布局、时停节奏与整条平衡账。
 * 它只是候选生成的**上限**:甲板快满时真实候选会更少(sim/upgrade.ts 的 rollUpgradeOffer 返回真实数),
 * 故 ui 一律照 world.offer.length 摆卡,绝不照这个常量摆(照它摆就会出现一张空卡)。
 */
export const UPGRADE_CHOICE_COUNT = 3;

/**
 * 三选一里"塔类 / 支援 / 甲板拼块"的类别权重，恢复 GDD §7 的 45/25/15。
 * **不必凑 100**:法令(M2)尚未实装，sim/upgrade.ts 按三者之和 85 归一化；以后补法令 15
 * 只需把第四类接进同一轮盘，不必重写现有三类的相对权重。
 *
 * 权重只决定"掷出来的那个数怎么解释",**不决定掷几次**:每个候选位恒定消耗 2 次 rng
 *(见 rollUpgradeOffer),于是改这三个数不会移动整条随机序列 —— 同 seed 的出怪照旧一模一样。
 */
export const OFFER_WEIGHT_TOWER = 45;
export const OFFER_WEIGHT_SUPPORT = 25;
/** 甲板拼块恢复 GDD §7 的 15% 占位；法令尚未实装，三类按 45:25:15 自动归一化。 */
export const OFFER_WEIGHT_DECK = 15;

/**
 * 跳过一次升级的返还额(GDD §7:"可跳过(返还 15 残骸)")。
 * 它是**返还**不是免单:跳过照样扣掉这一次的 upgradeCost、照样 upgrades++,
 * 否则下一帧 scrap 还够,同一张卡会当场再弹一次(那才是真正的死循环)。
 * 调用方(World.skipUpgrade / ui 的 skipRefund)必须把它夹到 cost 以内 ——
 * 第 0 级的 cost 有可能比返还额还小,不夹的话"跳过"就成了一台印残骸的机器。
 */
export const UPGRADE_SKIP_REFUND = 15;

/**
 * 在场残骸上限:触顶后当帧掉落的那一颗**直接丢弃、不留账** ——
 * 留账的话上限一解除就会一口气吐出来,正是"卡了之后更卡"的那条死亡螺旋
 *(与 data/waves.ts 的 WAVE_MAX_ALIVE 一字同源)。
 *
 * 它是**保险丝而不是旋钮**:每只怪必掉一颗、在场敌人上限是 1400,而残骸一路被磁吸收走,
 * 正常一局根本够不到这个数;真够到了,说明玩家已经很久没能靠近战场中心把残骸捡回来 ——
 * 那一局本就要输,此时最不该做的事就是再为一屏捡不到的残骸付遍历与绘制的钱。
 */
export const DROP_MAX_ALIVE = 1200;
