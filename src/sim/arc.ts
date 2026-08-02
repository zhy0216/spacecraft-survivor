/**
 * 射界几何与射界内索敌(04 号 issue T1/T2)—— 纯函数、零副作用、零分配。
 * 铁律 1:本目录永不 import pixi/DOM,也不用 Math.random —— 换来同 seed 确定性与 Node 单测,
 *   而且渲染层画 Tab 扇形时**只能**调这里的函数:射界数学全仓只有这一份,
 *   可视化与可命中区域才不会各算各的(04 验收标准第二条)。
 * 铁律 3:结果一律写进调用方给的 out —— 渲染层每帧要对全甲板问一遍扇形,那条路上不许有临时对象。
 *
 * 角度一律用弧度;唯一的例外是入参 arcDeg(度),它直接来自 data/arcs 的档位表或面板旋钮,
 * 进门就 × DEG2RAD。方向口径全部沿用 sim/deck 的 edgeWorldNormal,不在这里重算一遍法线。
 *
 * GDD §4.2 的三句话就是本文件的全部:
 *   射界 = 所在格暴露边的法线方向 ± 塔弧度/2(随船体朝向旋转);
 *   角落格取两条暴露边法线的角平分线,弧度 +60°;
 *   塔只打射界内的目标(射界内无目标时炮管归位)。
 *
 * 本文件只放**无状态的查询**:同样的格 + 同样的朝向,问一百遍答案都一样,也不改世界一个字段。
 * 炮管的运行期状态(cell.turretOffset)与它的逐帧推进在 sim/turret.ts —— 那里才有"记忆"。
 */
import { ARC_OMNI_DEG, ARC_WIDEN_PER_EDGE_DEG } from '../data/arcs';
import { CELL_WEAPON, type DeckCell, EDGE_COUNT, edgeWorldNormal, isEdgeExposed } from './deck';
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
 * 退化判据:暴露边法线的**向量和**长度小于它,就当这一格"没有方向"。
 * 只吃得掉浮点残差(对边相消的残差量级是 1e-16),吃不掉任何真实的偏心 ——
 * 最接近退化的非退化情形是三条边(左右两条相消后还整整剩一个单位长),差着九个数量级。
 */
const DEGENERATE_EPS = 1e-9;

/**
 * 射界半角(弧度)= (塔弧度 + 每多一条暴露边再 +60°) / 2,上限 π。
 *
 * exposedCount = 2 的正交角落格于是正好是 GDD §4.2 写死的"+60°";
 * 三条边(12 号扩建焊出凹形轮廓才造得出)按同一条规则**外推**成 +120° —— GDD 没写这一档,
 * 是这里定的:凹角本就三面临空,给它更宽的视野与"角落格是天然优质炮位"的设计意图一致,
 * 也免得为边数分类讨论(分类讨论迟早在 12 号那边多出一个没人记得的分支)。
 *
 * 夹到 π:再宽也就是全向,超出会让 arcContains 的 |Δ| ≤ half 悄悄恒真却自称"150° 塔"。
 * arcDeg ≥ 360 直接给 π,这就是全向档的全部实现(GDD §5.2 导弹巢的接口预留,MVP 不用)。
 * exposedCount 恒 ≥ 1:0 已被 cellArc 挡在门外(内部格没有射界),故这里不为它兜底。
 */
export function arcHalfAngle(arcDeg: number, exposedCount: number): number {
  if (arcDeg >= ARC_OMNI_DEG) return Math.PI;
  return Math.min(Math.PI, ((arcDeg + (exposedCount - 1) * ARC_WIDEN_PER_EDGE_DEG) / 2) * DEG2RAD);
}

/**
 * 求一格在世界系里的射界,写进 out。
 * @param heading 船体朝向;传 0 得到**船体局部**射界(渲染层就是这么随 deckG 一起转的)
 * @returns 这一格有没有射界。false = 压根没有暴露边(内部格 / 非占用格 / 被围死的离线塔),
 *   此时 **out 一个字段都不改** —— 遍历全甲板的调用方直接跳过,不必先备份再复原。
 *
 * 中心角 = 全部暴露边法线的**单位向量和**方向 atan2(Σsin, Σcos),**绝不对角度取平均**:
 * 角度平均跨 ±π 时会指向正反方向 —— 船尾 -100° 与右舷 +170° 的角落格(船朝 80° 时的右后角),
 * 正确中心是 -145°,取平均却给出 +35°,整整差 180°,塔会朝着船体另一侧开火。
 * 向量和还顺带把边数统一成一条式子:两条正交边给角平分线,三条边里左右相消只剩船头法线,
 * 用不着按 exposedCount 分支。atan2 的值域本就是 (-π, π],故 center 天然已折回。
 *
 * **退化分支**(向量和长度 ≈ 0,即法线互相抵消,只可能是对边或四面暴露):
 *   四面暴露(1×1 甲板):center = 船头朝向、half = π。四面临空,全向是唯一诚实的答案;
 *   恰两条对边(BOW|STERN 或 PORT|STARBOARD;isCornerCell 已把它们排除在角落格之外):
 *     真实射界是**两瓣**,而单锥模型(center + half)表达不了双瓣 →
 *     取掩码里**最低位**那条边的法线,且**不加宽**(按 1 条边算)。
 *     这是一个刻意的取舍 —— 从简、确定、渲染与索敌共用同一个口径,不是漏写:
 *     12 号扩建真焊出 1 格宽的甲板条、并且真有人往上放塔时再回来议(届时要么让塔有两瓣射界,
 *     要么在放置规则里拦掉这种炮位)。
 */
export function cellArc(cell: DeckCell, heading: number, arcDeg: number, out: Arc): boolean {
  const n = cell.exposedCount;
  if (n === 0) return false;

  let sx = 0;
  let sy = 0;
  for (let e = 0; e < EDGE_COUNT; e++) {
    if (!isEdgeExposed(cell, e)) continue;
    const a = edgeWorldNormal(e, heading);
    sx += Math.cos(a);
    sy += Math.sin(a);
  }

  if (sx * sx + sy * sy < DEGENERATE_EPS * DEGENERATE_EPS) {
    if (n === EDGE_COUNT) {
      out.center = wrapAngle(heading);
      out.half = Math.PI;
      return true;
    }
    // 最低位的那条暴露边。n > 0 保证 exposed 非零,这个循环一定停得下来(不必兜越界)
    let edge = 0;
    while (!isEdgeExposed(cell, edge)) edge++;
    out.center = edgeWorldNormal(edge, heading);
    out.half = arcHalfAngle(arcDeg, 1); // 双瓣退化成单瓣:只当一条边,不按 2 条边加宽
    return true;
  }

  out.center = Math.atan2(sy, sx);
  out.half = arcHalfAngle(arcDeg, n);
  return true;
}

/**
 * 某个世界方位角在不在射界里,**含边界** —— 边界上的目标算打得到,
 * Tab 画出来的那条扇形边线才名副其实(04 验收标准第二条的"边界目标测试")。
 * 差值必须先 wrapAngle 再取绝对值:不折回的话,跨 ±π 的扇形判定会整个翻过去。
 * half = π 时恒真(wrapAngle 的值域 ⊂ [-π, π]),全向档因此不需要任何特判。
 */
export function arcContains(arc: Arc, angle: number): boolean {
  return Math.abs(wrapAngle(angle - arc.center)) <= arc.half;
}

/**
 * 这一格是不是一座**能开火**的塔:有武器塔,且在线。
 * online 是 deck 维护的派生量(武器塔失去全部暴露边就离线 = GDD §4.1 的"边缘内化",
 * 12 号扩建把炮位焊成内脏位时发生),这里只读不算 ——
 * 04/05 每一处"跳过这座塔"都问同一个函数,规则才只有一处、不会两边写歪。
 */
export function isTurretCell(cell: DeckCell): boolean {
  return cell.content === CELL_WEAPON && cell.online;
}

/**
 * 在候选里挑一个目标:**射界扇形 ∩ 射程圆**内最近的一只(04 任务"目标过滤")。
 * @param candidates 粗筛结果,由调用方从空间哈希查来(sim/turret 每帧只查一次、全塔共享)。
 *   **绝不接受"全体敌人"**:1000 敌 × 10 塔的线性扫描是 GDD §13 明令要用哈希避开的那件事;
 *   这里只做精筛,所以候选是超集也无所谓(哈希按 cell 粗筛,本就会多给)。
 * @param ox @param oy 炮位(格心世界坐标),**不是船心** —— 舷侧塔与船心差着大半个船长,
 *   拿船心量距离会让射程边界整体歪掉半条船。
 * @param range 射程,与渲染层画的扇形半径同一个数(04 验收标准第二条:可视化 = 可命中区域)
 * @returns 选中的敌人;射界内一只都没有则 null → 调用方据此归位炮管。
 *
 * 顺序刻意如此:dead 最先(尸体本帧还在场上,回收在 step 末尾,不跳过就会瞄着一具尸体);
 * 再比距离平方(**不开方**,平方序与距离序同调);最后才 atan2 —— 三角函数是这条循环里最贵的一步,
 * 赢不了当前最近者的候选连方位都不必算(结果与"先判角度"完全一致,只是省了算)。
 *
 * 同距时**严格 `<` 才替换** = 保留先到者:哈希遍历顺序是确定的(每帧 clear + 按 items 顺序 insert),
 * 于是同 seed 两个世界必然选中同一只敌人 —— 索敌一旦有歧义,确定性口径当场作废。
 * 距离量到敌人**中心点**,不减体型半径:05 号细化(大体型该更早进入射程)前,少一个不受控的口径。
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
