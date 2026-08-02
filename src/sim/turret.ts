/**
 * 炮管推进(04 号 issue T2)—— 全仓唯一写 cell.turretOffset 的地方。
 * 铁律 1:本目录永不 import pixi/DOM,也不用 Math.random —— 塔瞄哪只、转到哪一格弧度,
 *   全由"甲板 + 船位姿 + 空间哈希里的敌人"决定,同 seed 必然复现,Node 里就能单测。
 * 铁律 3:模块级暂存三件套(一个 Arc、一个 Vec2、一个候选数组),运行期零新增分配;
 *   它们**只在一次调用内有效**、绝不跨帧持有 —— 候选数组里装的是池中对象,
 *   敌人一回收,同一个对象下一帧就变成了另一只(见 core/pool 的口径)。
 *
 * 分工:射界几何与"射界内谁最近"在 sim/arc.ts(无状态查询),本文件只做**有记忆的那一半** ——
 * 逐帧把炮口朝目标转、没目标就转回射界中心。拆开的理由与 enemy/world 一样:
 * 几何能脱开世界单测,而这里钉的是时间维度的行为(转速上限、归位、离线冻结)。
 *
 * 炮管**平滑转向而不是瞬时对齐**(与 stepShip 追随期望航向同一套写法):
 *   瞬时归位在画面上是"弹回",而追瞄的转速上限正是 05 号"塔转不过来就打不到"那层手感的唯一来源 ——
 *   现在不给上限,05 再补就等于改手感基线。上限走 tuning.turretTurnRate(°/s,与 shipTurnRate 同口径)。
 *
 * 本文件**不开火**:伤害、冷却、弹道是 05 号的活。04 只负责"塔朝哪"。
 */
import type { SpatialHash } from '../core/spatialHash';
import { type Arc, cellArc, findArcTarget, isTurretCell } from './arc';
import { tuning } from './config';
import { cellWorldPos, type Deck, deckCellSize } from './deck';
import type { Enemy } from './enemy';
import { DEG2RAD, type Ship, type Vec2, wrapAngle } from './ship';

/** 当前这座塔的射界。逐塔覆写,不跨调用留值 */
const arc: Arc = { center: 0, half: 0 };
/** 当前这座塔的炮位(格心世界坐标) */
const muzzle: Vec2 = { x: 0, y: 0 };
/** 本帧的粗筛候选,全塔共享。出函数前清空:不替对象池扣着一批过期引用 */
const candidates: Enemy[] = [];

/**
 * 推进全甲板的炮管一逻辑帧。
 * @param grid 本帧已重建好的敌人空间哈希(World 在敌人循环前 clear + 全量 insert)
 * @param dt 固定时步(SIM_DT);转速上限按秒定义,乘 dt 才与 stepShip 同口径
 *
 * 三条性能口径(1000 敌 + 满甲板塔是 01 号压测场景的常态):
 *   一、没有一座在线武器塔就**直接返回** —— 压测场景默认空甲板,不该为它白掏一次半径 380 的查询;
 *   二、**每帧只查一次空间哈希**:以船心为心、半径 = 射程 + 甲板外接半径,十座塔共享这一份候选。
 *     每塔各查一次是十倍 Map 查找,而查询半径本就只是粗筛(哈希按 cell 返回超集),
 *     精筛在 findArcTarget 里逐塔以**自己的炮位**为原点做,没有精度损失;
 *   三、绝不对 world.enemies.items 做线性扫描(GDD §13)。
 *
 * 哈希分桶用的是敌人**移动前**的位置(World 先建哈希、再跑敌人循环),而 e.x/e.y 已是本帧位置,
 * 这 ≤6px 的错位只可能影响恰好卡在射程边界上的目标,下一帧自然纠正 —— 不为它扩查询半径:
 * 扩半径是每帧都要付的钱,买的却是一个一帧后自动消失的边界抖动。
 */
export function stepTurrets(deck: Deck, ship: Ship, grid: SpatialHash<Enemy>, dt: number): void {
  const cells = deck.cells;
  let hasTurret = false;
  for (let i = 0; i < cells.length; i++) {
    if (isTurretCell(cells[i]!)) {
      hasTurret = true;
      break;
    }
  }
  if (!hasTurret) return;

  // 三项 tuning 每帧现读(与 stepShip 同口径):面板拖动即时生效,不缓存进模块常量。
  // hoist 到帧内只是省属性穿透,不影响"现读"这条口径
  const arcDeg = tuning.turretArcDeg;
  const range = tuning.turretRange;
  const maxTurn = tuning.turretTurnRate * DEG2RAD * dt;

  // 甲板外接半径:任何格心离船心都不超过它,故"离某炮位 ≤ range 的敌人"必然落在这个圆里 ——
  // 一次查询覆盖全塔的充分条件,少一分就会漏掉舷侧塔够得到、船心够不到的那一圈目标
  const reach = range + (Math.hypot(deck.rows, deck.cols) * deckCellSize()) / 2;
  grid.query(ship.x, ship.y, reach, candidates);

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    // 离线塔(被 12 号扩建焊成内脏位)在这里被 isTurretCell 一并挡掉:offset 冻结、相对船体不动,
    // 视觉上就是"炮管停在原处跟着船转";恢复在线后从冻结值继续归位,不会凭空跳一下
    if (!isTurretCell(cell)) continue;
    if (!cellArc(cell, ship.heading, arcDeg, arc)) continue;

    cellWorldPos(deck, ship, cell.col, cell.row, muzzle);
    const target = findArcTarget(candidates, muzzle.x, muzzle.y, arc, range);

    // 有目标就追它的方位,没目标就归位(回到扇形中心 = 偏角 0)。
    // 存的是**相对射界中心**的偏角:船一转,射界与炮管一起转,这里不必每帧追赶 heading
    let want = 0;
    if (target) {
      const bearing = Math.atan2(target.y - muzzle.y, target.x - muzzle.x);
      // 夹进 ±half:findArcTarget 已保证目标在射界内,这一夹是给浮点边界兜底 ——
      // 炮口在任何一帧都不许指到扇形外面去(Tab 画出来的扇形就是它的活动范围)
      want = Math.max(-arc.half, Math.min(arc.half, wrapAngle(bearing - arc.center)));
    }

    // 与 stepShip 追随期望航向同一套:先折回最短弧,再以每帧上限夹取,绝不瞬间对齐。
    // 差值小于一帧的上限时夹取不生效 → 当帧精确落到 want,不会在目标附近来回过冲
    const diff = wrapAngle(want - cell.turretOffset);
    cell.turretOffset = wrapAngle(cell.turretOffset + Math.max(-maxTurn, Math.min(maxTurn, diff)));
  }

  candidates.length = 0;
}
