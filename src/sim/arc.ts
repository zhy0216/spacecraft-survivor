/**
 * 射界几何与射界内索敌(改版 04 号 —— 甲板删除后的重写)—— 纯函数、零副作用、零分配。
 * 铁律 1:本目录永不 import pixi/DOM,也不用 Math.random —— 换来同 seed 确定性与 Node 单测,
 *   而且渲染层画扇形时**只能**调这里的函数:射界数学全仓只有这一份,
 *   可视化与可命中区域才不会各算各的(04 验收标准第二条)。
 * 铁律 3:结果一律写进调用方给的 out —— 渲染层每帧要对全部武器槽问一遍扇形,那条路上不许有临时对象。
 *
 * 角度一律用弧度;唯一的例外是入参 arcDeg(度),它直接来自 data/towers 的档位表,
 * 进门就 × DEG2RAD。方向口径沿用 sim/armory 的 WEAPON_SLOT_FACING,不在这里重算。
 *
 * —— 暴露边 → 固定槽位朝向的语义替换(用户设计会)——
 * 旧版射界 = 所在格暴露边的法线方向 ± 塔弧度/2,角落格加宽 +60° —— 随网格删除。
 * 新语义:**槽位射界 = 固定槽位朝向(WEAPON_SLOT_FACING[i])+ 船头朝向 ± 塔弧度/2**,
 * 没有加宽、没有"内部格没有射界"这回事 —— 4 个槽永远有射界,船转向时一起转,
 * 「转船找射界」的手感由槽位朝向而不是甲板形状给出。塔只打射界内的目标
 * (射界内无目标时炮管归位,见 sim/turret.ts)。
 *
 * 本文件只放**无状态的查询**:同样的槽 + 同样的朝向,问一百遍答案都一样,也不改世界一个字段。
 * 炮管的运行期状态(slot.turretOffset)与它的逐帧推进在 sim/turret.ts —— 那里才有"记忆"。
 */
import { ARC_OMNI_DEG } from '../data/arcs';
import { WEAPON_SLOT_FACING } from './armory';
import type { Enemy } from './enemy';
import { DEG2RAD, wrapAngle } from './ship';

/**
 * 一段扇形射界:以 center 为中心、向两侧各张开 half。
 * center 落在 (-π, π](atan2 / wrapAngle 的值域),half ∈ [0, π],half = π 即全向。
 * 是个可被反复填写的普通对象:调用方持有一个模块级实例整局复用(铁律 3),不要按帧新建。
 */
export interface Arc {
  center: number;
  half: number;
}

/**
 * 槽 i 的射界,写进 out。
 * @param heading 船体朝向;传 0 得到**船体局部**射界(渲染层画 Tab 扇形时用)
 *
 * 中心角 = WEAPON_SLOT_FACING[i] + heading(slotArcCenter 的同一份算术,这里再折回一次
 * 保证 out.center 落在 (-π, π])。半角 = arcDeg / 2,不再有角落格加宽:
 * 槽位没有"几条暴露边"这回事,弧多宽就是数值表那一档多宽。
 * 夹到 π:再宽也就是全向,超出会让 arcContains 的 |Δ| ≤ half 悄悄恒真却自称"150° 塔"。
 * arcDeg ≥ 360 直接给 π,这就是全向档的全部实现(data/arcs 的 ARC_OMNI_DEG 接口预留)。
 */
export function slotArc(slotIndex: number, heading: number, arcDeg: number, out: Arc): void {
  // WEAPON_SLOT_FACING 长度 = WEAPON_SLOT_COUNT,槽位下标越界(调用方写坏)时兜底成船头朝向
  out.center = wrapAngle((WEAPON_SLOT_FACING[slotIndex] ?? 0) + heading);
  out.half = arcDeg >= ARC_OMNI_DEG ? Math.PI : Math.min(Math.PI, (arcDeg / 2) * DEG2RAD);
}

/**
 * 某个世界方位角在不在射界里,**含边界** —— 边界上的目标算打得到,
 * 渲染层画出来的那条扇形边线才名副其实(04 验收标准第二条的"边界目标测试")。
 * 差值必须先 wrapAngle 再取绝对值:不折回的话,跨 ±π 的扇形判定会整个翻过去。
 * half = π 时恒真(wrapAngle 的值域 ⊂ [-π, π]),全向档因此不需要任何特判。
 */
export function arcContains(arc: Arc, angle: number): boolean {
  return Math.abs(wrapAngle(angle - arc.center)) <= arc.half;
}

/**
 * 在候选里挑一个目标:**射界扇形 ∩ 射程圆**内最近的一只(04 任务"目标过滤")。
 * @param candidates 粗筛结果,由调用方从空间哈希查来(sim/turret 每帧只查一次、全塔共享)。
 *   **绝不接受"全体敌人"**:1000 敌 × 4 塔的线性扫描是 GDD §13 明令要用哈希避开的那件事;
 *   这里只做精筛,所以候选是超集也无所谓(哈希按 cell 粗筛,本就会多给)。
 * @param ox @param oy 炮位(硬点世界坐标,sim/armory 的 slotMuzzleWorld),**不是船心** ——
 *   舷侧槽与船心差着大半个船长,拿船心量距离会让射程边界整体歪掉半条船。
 * @param range 射程,与渲染层画的扇形半径同一个数(04 验收标准第二条:可视化 = 可命中区域)
 * @returns 选中的敌人;射界内一只都没有则 null → 调用方据此归位炮管。
 *
 * 顺序刻意如此:dead 最先(尸体本帧还在场上,回收在 step 末尾,不跳过就会瞄着一具尸体);
 * 再比距离平方(**不开方**,平方序与距离序同调);最后才 atan2 —— 三角函数是这条循环里最贵的一步,
 * 赢不了当前最近者的候选连方位都不必算(结果与"先判角度"完全一致,只是省了算)。
 *
 * 同距时**严格 `<` 才替换** = 保留先到者:哈希遍历顺序是确定的(每帧 clear + 按 items 顺序 insert),
 * 于是同 seed 两个世界必然选中同一只敌人 —— 索敌一旦有歧义,确定性口径当场作废。
 * 距离量到敌人**中心点**,不减体型半径:大体型该更早进入射程的细化前,少一个不受控的口径。
 */
export function findArcTarget(
  candidates: readonly Enemy[],
  ox: number,
  oy: number,
  arc: Arc,
  range: number,
): Enemy | null {
  const r2 = range * range;
  let best: Enemy | null = null;
  let bestD2 = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const e = candidates[i]!;
    if (e.dead) continue;
    const dx = e.x - ox;
    const dy = e.y - oy;
    const d2 = dx * dx + dy * dy;
    if (d2 > r2) continue; // 含边界:恰好落在射程圆上算打得到(与 arcContains 的 ≤ 同口径)
    if (d2 >= bestD2) continue;
    if (!arcContains(arc, Math.atan2(dy, dx))) continue;
    best = e;
    bestD2 = d2;
  }
  return best;
}
