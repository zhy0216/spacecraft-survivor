/**
 * 炮管推进与开火(04 号 issue T2 + 05 号 issue T3)—— 全仓唯一写 cell.turretOffset 的地方,
 * 也是"这一帧哪座塔打了、打出了什么"的唯一裁决处。
 * 铁律 1:本目录永不 import pixi/DOM,也不用 Math.random —— 塔瞄哪只、转到哪一格弧度、
 *   链电跳给谁、磁轨扫中谁,全由"甲板 + 船位姿 + 空间哈希里的敌人"决定,同 seed 必然复现。
 *   本轮的开火路径**一次随机都不需要**:多发扇开、链跳选择、线段命中全是确定性规则。
 * 铁律 3:模块级暂存四件套(一个 Arc、一个 Vec2、一个候选数组、一个已命中列表),
 *   运行期零新增分配;它们**只在一次调用内有效**、绝不跨帧持有 —— 候选数组里装的是池中对象,
 *   敌人一回收,同一个对象下一帧就变成了另一只(见 core/pool 的口径)。
 *
 * 分工:射界几何与"射界内谁最近"在 sim/arc.ts(无状态查询),节流状态机在 sim/tower.ts,
 * 子弹的积分与命中在 sim/bullet.ts,一塔一档的数值全在 data/towers.ts ——
 * 本文件一个裸数字都不写(**改数据文件即可调平衡**,05 验收标准第三条),只做接线与裁决:
 * 逐帧把炮口朝目标转、没目标就转回射界中心,够得着且转得过来就按塔型分派一次开火。
 *
 * 炮管**平滑转向而不是瞬时对齐**(与 stepShip 追随期望航向同一套写法):
 * 瞬时归位在画面上是"弹回",而转速上限(def.turnRate)加上瞄准容差(def.aimTolDeg)
 * 合起来就是 GDD §5.2 那句"塔转不过来就打不到" —— 磁轨那种沉炮追不上贴脸的快目标,
 * 只能靠转船去喂它,这正是"走位即火控"落到单座塔上的样子。
 *
 * 五种开火表现按 def.fx 分派,分成"真子弹"与"瞬时判定"两类,分界线是弹速:
 *   FX_BULLET / FX_MORTAR 走子弹池 —— 飞行途中看得见、躲得开,是玩家读得懂的弹道;
 *   FX_BEAM / FX_CHAIN / FX_LANCE 当场结算 + 推一个 FxEvent 让画面存续几帧 ——
 *     磁轨那种一帧两千 px 的东西做成弹丸必然隧穿(60Hz 下一步跨过整只敌人),
 *     而光束与链电本就没有"飞行"这回事,给它们造弹丸只会凭空多一套要维护的状态。
 */
import type { SpatialHash } from '../core/spatialHash';
import { ENEMIES } from '../data/enemies';
import {
  FX_BEAM,
  FX_BULLET,
  FX_CHAIN,
  FX_LANCE,
  FX_MORTAR,
  type TowerDef,
  towerArcDeg,
  towerBurst,
  towerChainCount,
  towerPierce,
  towerRange,
} from '../data/towers';
import { type Arc, cellArc, findArcTarget, isTurretCell } from './arc';
import { BK_DIRECT, BK_MORTAR } from './bullet';
import { cellFireRateMul } from './damage';
import { cellWorldPos, type Deck, type DeckCell, deckCellSize } from './deck';
import type { Enemy } from './enemy';
import { type FireSink, FXV_BEAM, FXV_CHAIN, FXV_LANCE, FXV_MUZZLE } from './fx';
import { DEG2RAD, type Ship, type Vec2, wrapAngle } from './ship';
import {
  canFire,
  cellTowerDef,
  effectiveAoeDamage,
  effectiveDamage,
  onFired,
  stepThrottle,
} from './tower';

/** 当前这座塔的射界。逐塔覆写,不跨调用留值 */
const arc: Arc = { center: 0, half: 0 };
/** 当前这座塔的炮位(格心世界坐标)。开火那几个函数直接读它,不逐个当参数传 */
const muzzle: Vec2 = { x: 0, y: 0 };
/** 本帧的粗筛候选,全塔共享。出函数前清空:不替对象池扣着一批过期引用 */
const candidates: Enemy[] = [];
/**
 * 链电本次开火**已命中**的敌人。模块级复用而不是每次开火现造一个数组:
 * 一座电弧塔每秒一两次开火,现造就是每秒一两次分配 —— 而铁律 3 要的是运行期零新增分配。
 * 出 fireChain 前 `length = 0`(理由同 candidates:里面装的是池中对象,不许跨调用留着)。
 */
const chained: Enemy[] = [];

/**
 * 这座塔**够得着的最远距离**(自炮位起算)—— 共享候选圈半径的取值依据,不是射程本身。
 * 对绝大多数塔它就等于射程;电弧塔例外:首目标落在射程边缘后,链还能沿着敌群再往外走
 * (chainCount-1) 跳、每跳最多 chainRange。按射程取圈会让后几跳静默够不着,
 * 且会让这座塔的实际链长取决于甲板上还有没有别的射程更远的塔(见文件头)。
 * 这是个**上界**,不是真实链长:链只有在敌人恰好一路排开时才走得这么远,粗筛宁大勿小。
 */
function towerOutreach(def: TowerDef, level: number): number {
  const range = towerRange(def, level);
  const hops = towerChainCount(def, level) - 1;
  return hops > 0 ? range + hops * def.chainRange : range;
}

/**
 * 推进全甲板的炮管一逻辑帧,并按各塔的节流与射界开火。
 * @param grid 本帧已重建好的敌人空间哈希(World 在敌人循环前 clear + 全量 insert)
 * @param dt 固定时步(SIM_DT);转速与节流都按秒定义,乘 dt 才与 stepShip 同口径
 * @param sink 开火的去处(World 实现)。**传 null = 只追瞄、不开火** ——
 *   04 号那批纯几何用例因此不必造一整套世界,而"炮管朝哪"这件事本就不该依赖"打得出打不出"。
 *   节流(装填/降温/蓄力)无论有没有 sink 都照常推进:它是时间的函数,不是开火的副作用。
 * @param edgePenalty 四舷的受击惩罚剩余秒(world.edgePenalty,下标 = EDGE_*),09 号 T3 的射速惩罚。
 *   **传 null = 没有受击这回事**(04/05 那批用例与任何不关心受击的调用方走这条),逐塔恒 1 倍。
 *   舷向归属由 cellFireRateMul 按**暴露边**判(角落格同时属于两舷),不按格心方位角 ——
 *   规则与 world.sink.fired 的 broadside 统计同一条,只此一份(见 sim/damage.ts)。
 *
 * 三条性能口径(1000 敌 + 满甲板塔是 01 号压测场景的常态):
 *   一、没有一座在线武器塔就**直接返回** —— 压测场景默认空甲板,不该为它白掏一次查询;
 *   二、**每帧只查一次空间哈希**:以船心为心、半径 = **全甲板最大射程** + 甲板外接半径,
 *     十座塔共享这一份候选。每塔各查一次是十倍 Map 查找,而查询半径本就只是粗筛
 *     (哈希按 cell 返回超集),精筛在 findArcTarget 里逐塔以**自己的炮位**为原点做,没有精度损失;
 *     取最大射程而不是各塔自己的射程,是这条共享的充分条件 —— 少一分,射得最远的那座塔就会瞎一圈。
 *     链跳与磁轨的线段判定也**复用这一份候选**,不再额外查哈希。磁轨的线段终点就在自己射程内,
 *     但**链电不是**:一条链能从射程边缘再往外走 (chainCount-1) × chainRange,所以它的触及范围
 *     要单独算进 outreach(见下面的 towerOutreach)。少算这一截会出两种病:Lv5 电弧的后几跳
 *     够不着(「每级 +1 跳」的成长有一半是空的),以及甲板上多放一座射程更远的**无关**塔
 *     会把候选圈撑大、让同一条链凭空多跳几只 —— 一座塔的行为取决于旁边有什么塔,最难查的那类 bug。
 *     唯一的例外是迫击炮的落点 AoE,它在 sim/bullet.ts 里自己问一次(爆点可能落在这个圆之外)。
 *   三、绝不对 world.enemies.items 做线性扫描(GDD §13)。
 *
 * 哈希分桶用的是敌人**移动前**的位置(World 先建哈希、再跑敌人循环),而 e.x/e.y 已是本帧位置,
 * 这 ≤6px 的错位只可能影响恰好卡在射程边界上的目标,下一帧自然纠正 —— 不为它扩查询半径:
 * 扩半径是每帧都要付的钱,买的却是一个一帧后自动消失的边界抖动。
 */
export function stepTurrets(
  deck: Deck,
  ship: Ship,
  grid: SpatialHash<Enemy>,
  dt: number,
  sink: FireSink | null,
  edgePenalty: readonly number[] | null = null,
): void {
  const cells = deck.cells;
  // 一趟扫出两件事:有没有在线塔、全甲板最大射程是多少。
  // 塔型非法(数值表被改坏 / 将来某处漏了校验)的格在这里就不算数:它下面那个循环也会跳过,
  // 两处用同一条判据(cellTowerDef 取不到 def),不会出现"算进了查询半径却永远不开火"的塔
  let hasTurret = false;
  let maxOutreach = 0;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    if (!isTurretCell(cell)) continue;
    const def = cellTowerDef(cell);
    if (!def) continue;
    hasTurret = true;
    const out = towerOutreach(def, cell.level);
    if (out > maxOutreach) maxOutreach = out;
  }
  if (!hasTurret) return;

  // 甲板外接半径:任何格心离船心都不超过它,故"离某炮位 ≤ maxOutreach 的敌人"必然落在这个圆里 ——
  // 一次查询覆盖全塔的充分条件,少一分就会漏掉舷侧塔够得到、船心够不到的那一圈目标
  const reach = maxOutreach + (Math.hypot(deck.rows, deck.cols) * deckCellSize()) / 2;
  grid.query(ship.x, ship.y, reach, candidates);

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    // 离线塔(被 12 号扩建焊成内脏位)在这里被 isTurretCell 一并挡掉:**一切冻结** ——
    // offset 冻结、节流也冻结(装填/降温/蓄力全停),视觉上就是"炮管停在原处跟着船转";
    // 恢复在线后从冻结值继续,不会凭空跳一下
    if (!isTurretCell(cell)) continue;
    const def = cellTowerDef(cell);
    if (!def) continue;
    const level = cell.level;

    // 这一格的受击射速惩罚(09 号 T3):它任一条暴露边所在舷正在惩罚中就变慢。
    // 逐塔现算而不是逐舷预先算一遍:角落格同时属于两舷,预先按舷分组反而要处理重复归属
    const fireMul = edgePenalty ? cellFireRateMul(cell, edgePenalty) : 1;

    // 节流**有没有目标都要推进**:装填、降温、蓄力都在这里,只在有目标时跑的话,
    // 弹药塔会"没敌人时永远装不完",充能塔也攒不出那一发迎面的抢跳。
    // 惩罚跟着一起进节流(而不是只在开火那一刻扣):蓄力也要慢下来,否则充能系对受击免疫
    stepThrottle(cell, def, dt, fireMul);

    if (!cellArc(cell, ship.heading, towerArcDeg(def, level), arc)) continue;
    cellWorldPos(deck, ship, cell.col, cell.row, muzzle);
    const range = towerRange(def, level);
    const target = findArcTarget(candidates, muzzle.x, muzzle.y, arc, range);

    // 有目标就追它的方位,没目标就归位(回到扇形中心 = 偏角 0)。
    // 存的是**相对射界中心**的偏角:船一转,射界与炮管一起转,这里不必每帧追赶 heading
    let want = 0;
    let bearing = 0;
    if (target) {
      bearing = Math.atan2(target.y - muzzle.y, target.x - muzzle.x);
      // 夹进 ±half:findArcTarget 已保证目标在射界内,这一夹是给浮点边界兜底 ——
      // 炮口在任何一帧都不许指到扇形外面去(Tab 画出来的扇形就是它的活动范围)
      want = Math.max(-arc.half, Math.min(arc.half, wrapAngle(bearing - arc.center)));
    }

    // 与 stepShip 追随期望航向同一套:先折回最短弧,再以每帧上限夹取,绝不瞬间对齐。
    // 差值小于一帧的上限时夹取不生效 → 当帧精确落到 want,不会在目标附近来回过冲
    const maxTurn = def.turnRate * DEG2RAD * dt;
    const diff = wrapAngle(want - cell.turretOffset);
    cell.turretOffset = wrapAngle(cell.turretOffset + Math.max(-maxTurn, Math.min(maxTurn, diff)));

    // —— 开火门槛三道,缺一不可 ——
    // 第一道:有没有地方开火(sink = null 就是纯追瞄)、射界内有没有目标
    if (!sink || !target) continue;
    // 炮口的世界朝向 = 射界中心 + 相对偏角(sim/deck 对 turretOffset 的定义就是这一句)
    const aim = wrapAngle(arc.center + cell.turretOffset);
    // 第二道:**炮口没对准目标就不开火**。这就是"塔转不过来就打不到"的全部实现 ——
    // 少了它,转速上限只影响炮管这根装饰品,沉炮照样能贴脸秒杀高速目标
    if (Math.abs(wrapAngle(bearing - aim)) > def.aimTolDeg * DEG2RAD) continue;
    // 第三道:节流放不放行(弹夹/热量/充能,规则全在 sim/tower.ts,这里不复述)
    if (!canFire(cell, def)) continue;

    const shots = fire(cell, def, target, aim, range, sink);
    // shots = 0 只可能是数值表被改坏(弹速非正、fx 越界):那种塔当场哑火,
    // 而**不记代价** —— 记了就会白扣一发弹药/一份热量,现场看上去像"塔在打但没伤害"
    if (shots <= 0) continue;
    // 所有塔型共用的一次短促炮口闪：只在真正打出至少一发/一次结算后推事件，哑火不闪。
    // 一次 trigger 只推一条（双管仍是一座塔开了一次火），渲染层按 towerType 取同源冷色。
    sink.fx(FXV_MUZZLE, muzzle.x, muzzle.y, muzzle.x, muzzle.y, 0, def.type);
    // 与 stepThrottle 传同一个 fireMul:写进 cooldown 的那个间隔和逐帧夹取它的那个上限
    // 必须同源,否则惩罚期内写进去的长冷却会被下一帧按基准间隔夹回去,惩罚静默失效
    onFired(cell, def, shots, fireMul);
    sink.fired(cell);
  }

  candidates.length = 0;
}

/**
 * 按塔型分派一次开火。
 * @param aim 炮口的世界朝向(弧度)—— 弹道一律沿它,而不是直指目标:
 *   容差之内的那点偏差正是"炮管刚刚转到"的手感,直指目标等于把容差这道门槛白设了
 * @returns 这一次实际打出去几发(喂给 onFired 记代价)。0 = 没打出去,调用方不记代价
 */
function fire(
  cell: DeckCell,
  def: TowerDef,
  target: Enemy,
  aim: number,
  range: number,
  sink: FireSink,
): number {
  switch (def.fx) {
    case FX_BULLET:
      return fireBullets(cell, def, aim, range, sink);
    case FX_MORTAR:
      return fireMortar(cell, def, target, aim, range, sink);
    case FX_BEAM:
      return fireBeam(cell, def, target, sink);
    case FX_CHAIN:
      return fireChain(cell, def, target, sink);
    case FX_LANCE:
      return fireLance(cell, def, aim, range, sink);
    default:
      // 认不出的 fx(数值表被改坏)一律哑火,而不是随便挑一种表现顶上:
      // 顶上去的话现场看到的是"这门炮打出了别人的弹",离"表填错了"这个真因十万八千里
      return 0;
  }
}

/**
 * 直射弹(机炮、点防):沿炮口朝向打出 towerBurst 发。
 * 射程以 life 表达(life = 射程 / 弹速),不给子弹存出膛点再逐帧量距离 —— 理由见 sim/bullet.ts。
 */
function fireBullets(
  cell: DeckCell,
  def: TowerDef,
  aim: number,
  range: number,
  sink: FireSink,
): number {
  // 弹速非正 = 数值表被改坏:life = 射程/弹速 会变成 Infinity 或 NaN,那颗弹永不回收,
  // 子弹池会一路涨到掉帧。当场哑火,代价是"这门炮不响",而不是一个越跑越卡的世界
  if (!(def.bulletSpeed > 0)) return 0;

  const n = towerBurst(def, cell.level);
  const damage = effectiveDamage(def, cell.level);
  const pierce = towerPierce(def, cell.level);
  const life = range / def.bulletSpeed;
  // 多发扇开的整束宽度 = **瞄准容差**,不为它新造一个旋钮:
  // 于是每一发的方向都还落在"算打得到"的那个锥里(容差之外的方向本就不许开火),
  // 而且扇开量随塔而变 —— 宽容差的近防散得开,窄容差的主炮几乎是并排两发。
  // n = 1 时步长恒 0,不必分支;全程无随机(铁律 1)
  const step = n > 1 ? (def.aimTolDeg * DEG2RAD) / (n - 1) : 0;
  const base = -((n - 1) / 2) * step;

  for (let i = 0; i < n; i++) {
    const a = aim + base + i * step;
    const b = sink.spawnBullet();
    b.kind = BK_DIRECT;
    b.x = b.px = muzzle.x;
    b.y = b.py = muzzle.y;
    b.vx = Math.cos(a) * def.bulletSpeed;
    b.vy = Math.sin(a) * def.bulletSpeed;
    // 伤害在**发射那一刻定死**:塔升级、塔被焊成内脏位、甚至那一格被拆掉,
    // 都不该改变已经出膛的这一发(见 sim/bullet.ts 的文件头)
    b.damage = damage;
    b.life = life;
    b.pierce = pierce;
    b.radius = def.bulletRadius;
    b.towerType = def.type;
    // aoeRadius / aoeDamage 保持 resetBullet 清出来的 0:直射弹没有落点 AoE
  }
  return n;
}

/**
 * 抛射弹(迫击炮):一发**途中不碰撞**的弹,飞到落点炸一片(GDD §5.2 的"越过前排")。
 * 落点取目标**当前**位置、不做提前量:抛射的全部乐趣就是"看得见落点、来得及走开",
 * 加了提前量它就成了必中的追踪弹,那是另一种塔。
 */
function fireMortar(
  cell: DeckCell,
  def: TowerDef,
  target: Enemy,
  aim: number,
  range: number,
  sink: FireSink,
): number {
  if (!(def.bulletSpeed > 0)) return 0; // 理由同 fireBullets:Infinity 的 life 是个不回收的弹

  const dx = target.x - muzzle.x;
  const dy = target.y - muzzle.y;
  // 夹在射程内是给浮点边界与将来的规则变动兜底(findArcTarget 已保证 ≤ range):
  // 落点绝不许跑到射界叠加层画出来的那个圆之外 —— 那条圆就是玩家读到的"这门炮够得到哪"
  const dist = Math.min(Math.hypot(dx, dy), range);

  const b = sink.spawnBullet();
  b.kind = BK_MORTAR;
  b.x = b.px = muzzle.x;
  b.y = b.py = muzzle.y;
  b.vx = Math.cos(aim) * def.bulletSpeed;
  b.vy = Math.sin(aim) * def.bulletSpeed;
  b.damage = 0; // 直击不结算:伤害全在落点(见 data/towers 里迫击炮那一行)
  b.life = dist / def.bulletSpeed;
  b.radius = def.bulletRadius;
  b.aoeRadius = def.aoeRadius;
  b.aoeDamage = effectiveAoeDamage(def, cell.level);
  b.towerType = def.type;
  return 1;
}

/**
 * 持续光束(激光):瞬时单体判定 + 一条每次开火续命的可视化。
 * "持续"= fireInterval 0.1s 的伤害 tick,视觉连续、判定离散(见 data/towers 里激光那一行):
 * 真做成 dps × dt 的连续积分,伤害就会跟着帧长漂,确定性也没了。
 */
function fireBeam(cell: DeckCell, def: TowerDef, target: Enemy, sink: FireSink): number {
  sink.damage(target, effectiveDamage(def, cell.level));
  // 命中点取目标**当前**位置:瞬时判定,画到哪儿就是打到哪儿
  sink.fx(FXV_BEAM, muzzle.x, muzzle.y, target.x, target.y, 0, def.type);
  return 1;
}

/**
 * 链式闪电(电弧):首目标 = findArcTarget 选中的那只(与其余塔同一条索敌口径),
 * 之后逐跳找"距上一跳点最近、在 chainRange 内、还没被这一发打过的活人",伤害逐跳 × chainFalloff。
 * 总命中数 = towerChainCount(含首目标),每跳推一个 FXV_CHAIN,渲染层首尾相接连成整条链。
 * @returns 恒 1 —— 一次放电就是"一发":代价按发算,与它跳了几只无关
 *   (按跳数扣热量的话,电弧塔在人堆里会瞬间过热,而"清蜂群"正是它的定位)
 */
function fireChain(cell: DeckCell, def: TowerDef, target: Enemy, sink: FireSink): number {
  const total = towerChainCount(def, cell.level);
  let damage = effectiveDamage(def, cell.level);
  let hop: Enemy | null = target;
  let fromX = muzzle.x;
  let fromY = muzzle.y;

  chained.length = 0;
  while (hop) {
    sink.damage(hop, damage);
    sink.fx(FXV_CHAIN, fromX, fromY, hop.x, hop.y, 0, def.type);
    chained.push(hop);
    // 判在这里而不是循环头:chainCount 被改成 0/负数时,首目标照样吃这一下 ——
    // "打得到却不掉血"比"少跳一只"难查得多
    if (chained.length >= total) break;
    fromX = hop.x;
    fromY = hop.y;
    damage *= def.chainFalloff;
    hop = nextHop(fromX, fromY, def.chainRange);
  }

  chained.length = 0; // 出函数前清空:里面装的是池中对象,不许跨调用扣着过期引用
  return 1;
}

/**
 * 下一跳的目标:距上一跳点最近、在 chainRange 内、未死、且**不在本次已命中列表**里的那只。
 * 同距**严格 `<` 才替换** = 保留候选里先到的那一只(与 findArcTarget / hitDirect 一字同源):
 * candidates 的顺序由上游定死(每帧 clear + 按 items 顺序 insert)⇒ 跳跃序列确定 ⇒ 同 seed 必然复现。
 * 已命中列表用线性 includes:一条链最多几跳,建一个 Set 的分配代价远大于这几次比较(铁律 3)。
 */
function nextHop(x: number, y: number, range: number): Enemy | null {
  const r2 = range * range;
  let best: Enemy | null = null;
  let bestD2 = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const e = candidates[i]!;
    // 尸体整帧都还在场上(回收在 step 末尾),但不该再吃一发 —— 含本次前几跳刚打死的那几只,
    // 否则 10 号 issue 的掉落会按命中数重复给
    if (e.dead) continue;
    const dx = e.x - x;
    const dy = e.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 > r2) continue; // 含边界:恰好落在跳跃半径上算跳得到(与射程圆同口径)
    if (d2 >= bestD2) continue;
    if (chained.includes(e)) continue; // 最后判:链子绝不许在两只之间来回弹
    best = e;
    bestD2 = d2;
  }
  return best;
}

/**
 * 穿透直线(磁轨):从炮口沿炮口朝向拉一条长 towerRange 的线段,**线上全员吃满**(不衰减)。
 * 做成瞬时线段而不是高速穿透弹:60Hz 下一帧走两千 px 的弹丸必然隧穿(一步跨过整只敌人),
 * 而给它加子步进就等于在热循环里为一座塔单开一套积分。
 * 判据 = 点到**线段**的距离(投影落在 [0, range] 之内 + 垂距 ≤ 半宽 + 体型):
 * 只判点到直线的话,身后与射程之外的敌人也会一起中弹。
 */
function fireLance(
  cell: DeckCell,
  def: TowerDef,
  aim: number,
  range: number,
  sink: FireSink,
): number {
  const ux = Math.cos(aim);
  const uy = Math.sin(aim);
  const damage = effectiveDamage(def, cell.level);

  for (let i = 0; i < candidates.length; i++) {
    const e = candidates[i]!;
    if (e.dead) continue;
    const edef = ENEMIES[e.kind];
    if (!edef) continue; // kind 越界只是不打这一只,不炸掉整局(与渲染层同一条兜底口径)
    const dx = e.x - muzzle.x;
    const dy = e.y - muzzle.y;
    const along = dx * ux + dy * uy;
    if (along < 0 || along > range) continue;
    // 叉积的绝对值 = 点到直线的距离(u 是单位向量),不必开方也不必再算一次投影
    const perp = Math.abs(dx * uy - dy * ux);
    if (perp > def.lanceWidth + edef.radius) continue; // 含边界,与全仓其余命中判据同口径
    sink.damage(e, damage);
  }

  // 无条件推一条光柱,哪怕一个人都没扫到:"打出去了但没打中"正是玩家判断这门沉炮该不该
  // 提前多少的唯一读数(与迫击炮那条 FXV_BLAST 同一条理由)。终点画到射程尽头 = 可视化即作用范围
  sink.fx(FXV_LANCE, muzzle.x, muzzle.y, muzzle.x + ux * range, muzzle.y + uy * range, 0, def.type);
  return 1;
}
