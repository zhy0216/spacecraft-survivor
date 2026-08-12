/**
 * 船体受击判定的全部几何(改版 09 号 —— 甲板删除后的重写)—— 纯函数、零副作用、零分配。
 * 铁律 1:本目录永不 import pixi/DOM,也不用 Math.random —— 谁撞到船、掉多少血,
 *   全由"船位姿 + 支援聚合 + 一个点和它的体型半径"决定,同 seed 必然复现。
 * 铁律 3:本文件连暂存都不需要 —— 判定只剩一个圆,连 out 都不用。
 *
 * —— 甲板几何 → 圆的语义替换(用户设计会)——
 * 旧版三层判定(核心矩形 / 稀疏甲板格轮廓 / 没碰上)随网格一起删除:
 * **船体受击 = 船心周围一个圆**(半径 = shipLength / 2),撞进来的敌人/弹丸直接掉血,
 * 不再有"蹭到轮廓只出火花"的擦碰层 —— 判定体与船形从此是同一个圆,
 * 渲染层画多大,判定就是多大,不存在第二处口径。
 * 代价是"贴船掠过的敌人擦不出火花"这类细节反馈,换来的是全仓只剩一份几何:
 * 接触粗筛(world 的 contacts)、炮管共享查询圈(sim/turret 的 reach)、弹丸命中
 * (sim/enemyBullet)用的都是同一个 shipRadius,想写歪都难。
 *
 * 依赖只有 ./config 与 ./support(类型),**绝不 import world / turret / tower**:
 * 那三个都是本文件的下游(World 每帧问结算、turret 每帧问查询圈),引回去就是运行期循环依赖。
 * 装甲舱/经验增幅器那几项(改版 06 号)只读 sim/support 的聚合结果,不碰数据表 ——
 * "持有了几块什么支援"由 aggregateEdictBuffs 全船算好,本文件只认那个聚合。
 */
import { tuning } from './config';
import type { EdictBuffs } from './edictBuffs';

/**
 * 船体受击圆半径 = shipLength / 2。**全仓唯一口径**:World 的接触粗筛、
 * sim/turret 的共享查询圈、sim/enemyBullet 的命中判定都问它,别处不许另抄一个数。
 * @param shipLength 船体长度(tuning.shipLength;传参而不是现读 tuning,让调用点显式声明它量的是船)
 */
export function shipRadius(shipLength: number): number {
  return shipLength / 2;
}

/**
 * 船体 HP 上限 = 基准(tuning.shipHullHp,GDD §14 锁定的 100)+ 法令聚合的 hullHp
 * (装甲协议 +15/层,2 层 = +30)。
 * 旧版签名里的 deck 参数换成 buffs:HP 上限从"甲板的派生量"变成"法令聚合的派生量"——
 * 装甲协议的 +15/层已经在 buffs.hullHp 里加过(支援并入法令后不再有第二个加点来源),
 * 故旧的 edictHpAdd 第二参整条删除:一个数只在一处算。
 * 聚合每帧由 World 现算(见 sim/edictBuffs.ts),本函数只做加法,World 每帧现调,拿到当帧生效。
 * **加法叠加**(2 层 = +30):HP 是**点数**不是比例,这是全表唯一一项加法。
 * 每次现读 tuning 而不是模块加载时算死:shipHullHp 是面板上的旋钮,与 shipRadius 同口径。
 */
export function hullMaxHp(buffs: EdictBuffs): number {
  return tuning.shipHullHp + buffs.hullHp;
}

/**
 * 受击伤害倍率 = 法令聚合的 damageTakenMul(装甲协议 ×0.8,2 层 = ×0.64)。
 * 连乘而不是把 -20% 加起来:倍率连乘永远推不到 ≤ 0,而"每层 -20%"的加法在 5 层时会把
 * 倍率抹成 0(撞上去一点都不疼)。代价是收益递减,但那正是要的:堆装甲该有天花板。
 * 它是 World.damageShip 与 sink.hullHit 计算"实际结算伤害"的**唯一**去处 ——
 * 飘字与血条扣掉的量永远一致,玩家不会读到两本账(旧版 edgeDamageMul 的同一条分工)。
 */
export function hullDamageTaken(buffs: EdictBuffs): number {
  return buffs.damageTakenMul;
}
