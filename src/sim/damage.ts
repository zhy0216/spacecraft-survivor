/**
 * 船体受击判定的全部几何(09 号 issue T1)—— 纯函数、零副作用、零分配。
 * 铁律 1:本目录永不 import pixi/DOM,也不用 Math.random —— 谁蹭到了船、撞在哪一舷、
 *   哪座塔正在挨罚,全由"船位姿 + 甲板拓扑 + 一个点和它的体型半径"决定,同 seed 必然复现;
 *   喂一艘船 + 一块甲板就能在 Node 里把每一条边界钉住,不必造一整个 World。
 * 铁律 3:结果一律写进调用方给的 out,模块内只留一个复用的 Vec2 暂存(照 sim/world.ts 的 desired):
 *   蜂群贴脸的那一帧里,每只敌人都要问一次判定,那条路上不许有临时对象。
 *
 * **受击判定体与甲板渲染解耦**(GDD §4.4)就是本文件存在的全部理由:
 *   核心区恒按**初始 3×4**(DECK_ROWS/DECK_COLS 两个常量)算,**绝不读 deck.rows/cols** ——
 *   12 号扩建往上焊多少块甲板,判定体都一格不变大。扩建的真实代价是边缘内化(GDD §4.1)
 *   与转向惩罚,而**不是把船变成更大的靶子**(STG 惯例:判定小于外形);
 *   甲板轮廓则按真实稀疏 occupied 格集合增长,但它只决定"蹭到了没有"这件表现事 ——
 *   蹭到轮廓却没进核心 → 只出火花,一分血都不结算(GDD §4.4 明写的那句)。
 * 两套尺寸从此各归各:渲染改船形不会悄悄改变受击面积,反过来也一样。
 *
 * 判定几何**全仓只有这一份**:World 的结算、turret 的射速惩罚、渲染层 Tab 里那个判定体轮廓
 * 调的都是这里的函数 —— 与 sim/arc.ts 让"可视化 = 可命中区域"成立的是同一条理由,
 * 各处再抄一遍核心矩形/稀疏格判定,迟早有一处写歪,而那时画出来的框与真正扣血的框就不是同一个了。
 *
 * 依赖只有 ./config、./deck、./ship 与数据表 ../data/supports 四条,
 * **绝不 import world / turret / tower**:那三个都是本文件的下游(World 每帧问结算、
 * turret 每帧问射速),引回去就是一个运行期循环依赖,在 ESM 里表现为"某一侧拿到 undefined",
 * 且只在改了 import 顺序时才炸(见 sim/fx.ts 的同一段)。
 * 装甲舱那两项(06 号)只读 data/supports 这张表、**不 import sim/support.ts**:
 * 本文件要的是"甲板上有哪些设施",而不是"哪块设施正在给哪座塔加成" —— 后者才是那个模块的事。
 */
import { SUPPORTS } from '../data/supports';
import { tuning } from './config';
import {
  DECK_COLS,
  DECK_ROWS,
  type Deck,
  type DeckCell,
  deckCellSize,
  cellLocalPos,
  EDGE_BOW,
  EDGE_COUNT,
  EDGE_PORT,
  EDGE_STARBOARD,
  EDGE_STERN,
  isEdgeExposed,
} from './deck';
import type { Ship, Vec2 } from './ship';

/** 没碰上:连甲板轮廓都没蹭到 */
export const HIT_NONE = 0;
/** 蹭到甲板轮廓、但在核心区之外 → 只出火花,不结算伤害(GDD §4.4) */
export const HIT_GRAZE = 1;
/** 进核心区 → 结算伤害 */
export const HIT_CORE = 2;

/**
 * 四舷的象限分界(弧度):±45° 与 ±135°。
 * 抽成常量而不是在判据里写 Math.PI / 4,是为了让 hitBroadside 那四行读起来就是"四个象限"。
 */
const QUARTER = Math.PI / 4;
const THREE_QUARTERS = (3 * Math.PI) / 4;

/**
 * 半长/半宽的暂存。模块级复用而不是每次现造:1000 敌的粗筛名单每帧都要走 classifyHit,
 * 循环里 new 一个对象就是直接写在 GC 停顿上(铁律 3)。**只在一次调用内有效**,不跨调用留值。
 */
const half: Vec2 = { x: 0, y: 0 };
const cellPos: Vec2 = { x: 0, y: 0 };

/**
 * 受击核心区的半长(out.x,沿局部 +X = 船头)与半宽(out.y,沿 +Y = 右舷)。
 * = 初始 3×4 包围盒 × tuning.shipCoreScale / 2。
 *
 * **恒按 DECK_ROWS/DECK_COLS 两个常量算,绝不读 deck.rows/cols** —— 这一句就是 GDD §4.4
 * "受击区域不随扩建变大"的全部实现:12 号焊上 L 形拼块之后,剪影变了、build 变了,
 * 而这两个数一个字都不会动。也正因为如此,本函数压根不需要 deck 这个参数。
 * 每次现读 tuning(而不是模块加载时算一次):shipCoreScale 是面板上"判定体该多小"的旋钮,
 * 缓存住就得重开一局才看得出效果,与 stepShip 那四项同口径。
 */
export function hullCoreHalfExtents(out: Vec2): Vec2 {
  const s = deckCellSize() * tuning.shipCoreScale;
  out.x = (DECK_ROWS * s) / 2; // 行沿船长(sim/deck 的坐标约定)
  out.y = (DECK_COLS * s) / 2; // 列沿船宽
  return out;
}

/**
 * 当前真实 occupied 格集合的轴对齐半长/半宽 —— 给调试读数与外接范围使用,随异形扩建变大。
 * 它与 hullCoreHalfExtents 的区别就是读可见甲板还是固定核心,而这正是两件事的分界线:
 * 玩家看得见的船有多大 vs 敌人打得疼的地方有多大。
 */
export function deckHalfExtents(deck: Deck, out: Vec2): Vec2 {
  const h = deckCellSize() / 2;
  out.x = 0;
  out.y = 0;
  for (let i = 0; i < deck.cells.length; i++) {
    const cell = deck.cells[i]!;
    if (!cell.occupied) continue;
    cellLocalPos(deck, cell.col, cell.row, cellPos);
    out.x = Math.max(out.x, Math.abs(cellPos.x) + h);
    out.y = Math.max(out.y, Math.abs(cellPos.y) + h);
  }
  return out;
}

/**
 * 甲板外接圆半径 = 所有 occupied 格最远角点到船心的最大距离。World 敌人循环的粗筛用:
 * "这一帧可能蹭到船的人"筛进 contacts,精筛(classifyHit)只对那一小撮做。
 * sim/turret.ts 的共享候选圈直接调用本函数,甲板外接半径全仓只有这一个口径。
 * 取外接圆而不是内切:粗筛宁大勿小,少一分就会漏掉贴着甲板四角进来的那一圈敌人。
 */
export function deckOuterRadius(deck: Deck): number {
  const size = deckCellSize();
  const halfSize = size / 2;
  let radius = 0;
  for (let i = 0; i < deck.cells.length; i++) {
    const cell = deck.cells[i]!;
    if (!cell.occupied) continue;
    cellLocalPos(deck, cell.col, cell.row, cellPos);
    radius = Math.max(
      radius,
      Math.hypot(Math.abs(cellPos.x) + halfSize, Math.abs(cellPos.y) + halfSize),
    );
  }
  return radius;
}

/**
 * 一个半径 radius 的圆(敌人)落在哪一层:HIT_CORE / HIT_GRAZE / HIT_NONE。
 * @param x @param y 世界坐标(敌人中心)
 * @param radius 敌人体型半径;传 0 就是纯点判定(渲染层/单测问"这个点在不在核心区"用)
 *
 * 先把点转回船体局部系(旋转的逆 = 转置,与 deck.cellIndexAtWorld 一字同源的那条变换),
 * 再先判固定核心矩形、后逐 occupied 格判可见轮廓 —— 判定跟着船转,却不必重算世界角点。
 * **先判核心再判轮廓**:核心区整个含在轮廓里,顺序反过来的话核心区里的敌人会先被判成擦碰,
 * 于是"贴在船心的蜂群只出火花不掉血"—— 这条顺序是 World 那边"火花分支永远走不到核心区敌人"的前提。
 *
 * **含边界**(|lx| ≤ 半长 + radius 即算碰上),与 arcContains / findArcTarget / fireLance
 * 那批命中判据同口径:边界上的目标一律算碰上,可视化画出来的框才名副其实。
 * 两个轴各自加 radius = 把核心与每个甲板格按体型外扩,四个角上比真圆角多算一丁点:
 * 那点误差远小于一只敌人的半径,而换来的是零开方、零分支 —— 与"粗筛宁大勿小"同一条取舍。
 */
export function classifyHit(
  ship: Ship,
  deck: Deck,
  x: number,
  y: number,
  radius: number,
): number {
  const dx = x - ship.x;
  const dy = y - ship.y;
  const cos = Math.cos(ship.heading);
  const sin = Math.sin(ship.heading);
  const localX = dx * cos + dy * sin;
  const localY = -dx * sin + dy * cos;
  const lx = Math.abs(localX);
  const ly = Math.abs(localY);

  hullCoreHalfExtents(half);
  if (lx <= half.x + radius && ly <= half.y + radius) return HIT_CORE;
  // 可见轮廓是**稀疏占用格集合**，不能拿扩容后的 backing rectangle 充数：L/T 拼块凹口里的空气
  // 仍该是空气。逐格做扩半格矩形判定，格数只在升级时增长，contacts 又已由外接圆粗筛过。
  const cellHalf = deckCellSize() / 2;
  for (let i = 0; i < deck.cells.length; i++) {
    const cell = deck.cells[i]!;
    if (!cell.occupied) continue;
    cellLocalPos(deck, cell.col, cell.row, cellPos);
    if (
      Math.abs(localX - cellPos.x) <= cellHalf + radius &&
      Math.abs(localY - cellPos.y) <= cellHalf + radius
    )
      return HIT_GRAZE;
  }
  return HIT_NONE;
}

/**
 * 接触点(世界坐标)相对**船头**的方位角落在哪一舷,返回 EDGE_*(GDD §4.6:按接触点相对船头的
 * 方位角判定被撞的舷)。方向口径沿用 sim/deck 的 EDGE_NORMAL(+X = 船头 → BOW,+Y = 右舷 →
 * STARBOARD),不另立一套:四条边的法线本就是四个象限的中心线,舷向与射界说的是同一件事。
 *
 * 分界(单测按此钉,四舷无重叠无空隙):
 *   [-45°, 45°) = BOW;[45°, 135°) = STARBOARD;
 *   [135°, 180°] ∪ [-180°, -135°) = STERN;[-135°, -45°) = PORT。
 * 每条边界归**顺时针方向的那一舷** —— 归属规则只有这一句,才不会出现"恰好 45° 时两舷都闪红"
 * 或者两舷都不闪的缝。
 *
 * 取角度的方式是**先转回局部系再 atan2**,而不是 wrapAngle(atan2(世界) - heading):
 * 两者数学上等价,但退化点上不是 —— 后一种写法在接触点与船心重合时会算出 -heading,
 * 让同一个退化点随船朝向漂到任意一舷(蜂群压在船心上时最容易撞见)。
 * 顺带也省掉一次 wrapAngle:atan2 的值域本就是 (-π, π]。
 */
export function hitBroadside(ship: Ship, x: number, y: number): number {
  const dx = x - ship.x;
  const dy = y - ship.y;
  // 接触点与船心重合:局部坐标是零,而 atan2 对零**只看符号位** —— 那两个零的正负又完全由
  // heading 的 cos/sin 符号决定(如 heading ∈ 第三象限时 0·cos 得 -0,atan2(+0, -0) = π = 船尾)。
  // 于是不提前判掉的话,同一个退化点会随船朝向在 BOW 与 STERN 之间来回跳。
  // 钉死在 BOW 是约定(与"四舷分界含 atan2(0,0) = 0"同一句),不是碰巧:蜂群贴脸压到船心上
  // 在本作里是常态,受击反馈总得有个确定的去处,而船头是四舷里唯一不依赖符号位的那个答案
  if (dx === 0 && dy === 0) return EDGE_BOW;
  const cos = Math.cos(ship.heading);
  const sin = Math.sin(ship.heading);
  const rel = Math.atan2(-dx * sin + dy * cos, dx * cos + dy * sin);
  if (rel >= -QUARTER && rel < QUARTER) return EDGE_BOW;
  if (rel >= QUARTER && rel < THREE_QUARTERS) return EDGE_STARBOARD;
  if (rel >= -THREE_QUARTERS && rel < -QUARTER) return EDGE_PORT;
  return EDGE_STERN; // 剩下的就是 [135°, 180°] ∪ [-180°, -135°),含 atan2 值域上端的那个 π
}

/**
 * 这一格当前的射速惩罚倍率:它**任一条暴露边**所在舷正在惩罚中 → tuning.hitFireRateMul,否则 1。
 * @param edgePenalty 四舷的惩罚剩余秒,下标 = EDGE_*(World.edgePenalty)
 *
 * **塔的舷向归属不走方位角,而是"每一条暴露边各算一舷",角落格同时属于两舷** ——
 * 判据就是既有的 isEdgeExposed。理由是甲板拓扑本身:3×4 甲板上 PORT/STERN 各只有 2 格,
 * 任何"每格只挑一条边"的规则(05 号临时的 lowestEdge、或按格心方位角)都永远凑不满 3 座塔,
 * 于是 broadside 反馈在一半的舷上直接死掉。cellFireRateMul 与 world.sink.fired 用的是同一条规则。
 *
 * 任一舷中招就整格挨罚(而不是按舷数打折):角落格本就是天然优质炮位(射界 +60°,GDD §4.2),
 * 它两面临敌、两面都可能挨罚,正是那份优势的代价 —— 让它挨两次罚才只扣一次,那是在补贴强位。
 */
export function cellFireRateMul(cell: DeckCell, edgePenalty: readonly number[]): number {
  for (let e = 0; e < EDGE_COUNT; e++) {
    if (!isEdgeExposed(cell, e)) continue;
    // ?? 0:入参是外部给的只读数组,长度不由本模块保证(noUncheckedIndexedAccess)
    if ((edgePenalty[e] ?? 0) > 0) return tuning.hitFireRateMul;
  }
  return 1;
}

/**
 * 船体 HP 上限 = 基准(tuning.shipHullHp,GDD §14 锁定的 100)+ 甲板上每块设施的 hullHp
 * (GDD §5.3 的装甲舱 = +15,数值在 data/supports)。09 号立的签名一个字没动:
 * HP 上限从设计上就是**甲板的派生量**,故参数一直是 deck 而不是一个数。
 *
 * **不特判 SUP_ARMOR_BAY,一律读表里的 hullHp 字段** —— 哪天 GDD §5.3 后半张表的维修机库也带几点血,
 * 改 data/supports 的一个数就够了,本文件一个字不用动(06 号验收:改数据即可调平衡)。
 * 判据只有"这一格的 supportType 在表里查得到":非支援格恒 -1(deck.ts 的建格与 recomputeDeck
 * 的清理共同保证这条不变量),SUPPORTS[-1] 取到 undefined ⇒ `?? 0`。
 * **不再问一遍 content**:同一件事两处各判一次,迟早有一处漏掉 —— 而 12 号拆掉一格甲板时,
 * 加成当帧回落靠的正是那条清理,再补一个 content 判据只会掩盖它哪天失效。
 *
 * **加法叠加**(两块 = +30):HP 是**点数**不是比例,这是本轮唯一一项加法 ——
 * 四个邻接倍率与下面的 edgeDamageMul 一律连乘,理由见 edgeDamageMul。
 * **不读 buff 缓存、当场遍历 cells**:于是与 recomputeSupportBuffs 的时机完全无关,
 * 放下去当帧就是新的(World.place 里那句 maxHp = hullMaxHp(deck) 因此不必等下一帧)。
 * 每次现读 tuning 而不是模块加载时算死:shipHullHp 是面板上的旋钮,与 hullCoreHalfExtents 同口径。
 */
export function hullMaxHp(deck: Deck): number {
  let hp = tuning.shipHullHp;
  const cells = deck.cells;
  for (let i = 0; i < cells.length; i++) {
    hp += SUPPORTS[cells[i]!.supportType]?.hullHp ?? 0;
  }
  return hp;
}

/**
 * 某一舷的受撞减伤倍率 = 该舷上每块设施的 edgeDamageMul 连乘(GDD §5.3 的装甲舱 = ×0.8)。
 * 同样不特判设施型号:表里那三种恒 1,乘上去是恒等,故循环里不需要按型号分支。
 *
 * 舷向归属**复用 isEdgeExposed**,与 cellFireRateMul / world.sink.fired 一字同源:
 * 一块设施属于它**每一条**暴露边所在的舷 —— 角落格的装甲舱同时护两舷(它两面临敌,
 * 那既是角落格 +60° 射界的代价,也该是它防御上的对价);内部格的装甲舱一条暴露边都没有,
 * ⇒ 只加 HP、不护任何一舷。各处再写一遍"这一格算哪一舷",迟早有一处写歪,
 * 那时护住的舷与闪红的舷就不是同一条了。
 *
 * **连乘而不是把 -20% 加起来**:同舷两块 = ×0.64 而不是 ×0.6,四块也只到 ×0.41 ——
 * 倍率连乘永远推不到 ≤ 0,而"每块 -20%"的加法在五块围一舷时就把倍率抹成 0(撞上去一点都不疼),
 * 再多一块直接变负(撞一下反而回血)。
 * 代价是收益递减,但那正是要的:堆装甲该有天花板。
 * 与 cellFireRateMul 那条"任一舷中招也只罚一次"不冲突 —— 那边罚的是**一座塔**
 * (让角落格挨两次罚才扣一次等于补贴强位),这边算的是**一舷的防御**,每多焊一块就该多一分。
 *
 * 同样不读 buff 缓存、当场遍历(理由见 hullMaxHp):放下去当帧的那次撞击就吃到减伤。
 */
export function edgeDamageMul(deck: Deck, edge: number): number {
  let mul = 1;
  const cells = deck.cells;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    if (!isEdgeExposed(cell, edge)) continue;
    mul *= SUPPORTS[cell.supportType]?.edgeDamageMul ?? 1;
  }
  return mul;
}
