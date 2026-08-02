/**
 * 射界弧度档位(04 号 issue T1)—— 纯数据,零 import。
 * 与 data/enemies.ts 同口径:src/data 与 src/sim 一样永不 import pixi/DOM,
 * 也不引 sim/config —— 数据表是配置的上游(tuning.turretArcDeg 反过来读这里),引回去就成环。
 *
 * 本文件只提供**词汇表**:GDD §4.2 那张表的五个档位,以及角落格的加宽量。
 * 单位是**度**并一律带 Deg 后缀:全仓角度用弧度存(sim/arc.ts 进门就 × DEG2RAD),
 * 只有给人看的数值表用度 —— 度数表能一眼对着 GDD 的表核对,弧度表核对不了。
 *
 * 刻意**不**在这里绑定"哪座塔用哪一档":本文件不认识"塔"这个概念,
 * 一塔一档是 05 号塔数值表的事(那时 tuning 里那三项全局占位整段作废)。
 * 于是加一档弧度、改一档度数都只动这一个文件,不牵动任何逻辑代码
 * (todos/05 验收口径:改数据文件即可调平衡)。
 */

export const ARC_VERY_NARROW_DEG = 30; // 磁轨炮
export const ARC_NARROW_DEG = 60; // 等离子迫击炮
export const ARC_MEDIUM_DEG = 100; // 自动机炮
export const ARC_WIDE_DEG = 150; // 电弧塔 / 点防阵列
export const ARC_OMNI_DEG = 360; // 导弹巢:接口预留(sim/arc 认它 = 全向),MVP 不用

/**
 * 每多一条暴露边加宽多少度(GDD §4.2:角落格 +60°)。
 * 三条边以上是按同一条规则外推(见 sim/arc.ts 的 arcHalfAngle),GDD 没有单列那一档。
 */
export const ARC_WIDEN_PER_EDGE_DEG = 60;

/**
 * 有序档位表(窄 → 广),**不含全向档** —— 360° 不是"更广的一档",而是绕开整套射界机制的例外
 * (GDD §5.2:导弹巢是唯一例外),混进表里会让"遍历所有档位"的调参面板与单测把例外当常态。
 */
export const ARC_TIERS_DEG = [ARC_VERY_NARROW_DEG, ARC_NARROW_DEG, ARC_MEDIUM_DEG, ARC_WIDE_DEG];
