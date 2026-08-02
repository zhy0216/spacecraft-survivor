/**
 * 甲板网格 —— 纯逻辑层(03 号 issue)。
 * 铁律 1:本目录永不 import pixi/DOM,也不用 Math.random —— 换来同 seed 确定性、Node 单测、渲染可替换。
 * 铁律 3:格子是建船时一次性造好的普通对象,运行期只改字段;取坐标的函数一律写进调用方给的 out,
 *   模块内只留一个复用的暂存(照 world.ts 的 desired 写法),热循环里不新增分配。
 *
 * 甲板 = 正交网格,唯一要记住的规则是 GDD §4.1:**边缘格开火、内部格供能**。
 * MVP 只有 T0 拾荒艇的 3×4(10 边缘 + 2 内部),但暴露边**一律从 occupied 集合动态推导**,
 * 绝不把"哪些格是边缘"写成常量表:12 号 issue 的甲板扩建会焊上 L/T/2×2 异形拼块,
 * 旧边缘格会被包成内部格(炮位变"内脏位"),写死的表当场作废。
 * 推导只看四个正交邻格是否存在且 occupied,**不做"从外部可达"的洪水填充** ——
 * 与 GDD §4.1"四面被围"的字面一致,而且 O(1)、与遍历顺序无关(中心挖空的洞对四周算暴露)。
 *
 * 坐标与角度约定(全仓唯一口径,04 射界 / 05 塔 / 12 扩建都建立在它上面):
 *   船体局部系 **+X = 船头**、**+Y = 右舷** —— 依据是既有代码(renderer 的船体多边形把船头画在
 *     +len/2,createShip 的 heading 起手 -π/2 = 屏幕上方,y 轴朝下),不另立新口径;
 *   row 沿船长,**row 0 = 最靠船头的一行**,row 增大朝船尾;col 沿船宽,**col 0 = 左舷**;
 *   cells 下标 = row * cols + col(row-major)。这个顺序是 checksum 与渲染遍历的唯一顺序,永不改。
 *
 * 放置规则(canPlace/placeAt,GDD §4.1 格子规则 + §4.5 战斗中放置规则)也落在本文件。
 * 本模块**只提供放置,不提供拆除/移动/出售** —— "已放置的塔不可移动、不可出售"这条规则的实现
 * 就是"没有那个 API",而不是某处的一个 if:MVP 没有船坞节点,战斗中的全部规则就只有"往空格里插"。
 * (setOccupied 清内容是 12 号焊/拆**甲板**的副作用,不是卖塔的后门。)
 * canPlace 只读、placeAt 才写:渲染层每帧拿 canPlace 算合法格高亮,不必担心把世界改脏。
 */
import { tuning } from './config';
import { type Ship, type Vec2, wrapAngle } from './ship';

/** 起始船体 3×4(GDD §4.1 的 T0 拾荒艇):列 = 舷宽方向,行 = 船头→船尾 */
export const DECK_COLS = 3;
export const DECK_ROWS = 4;

/** 格内容。不用 enum(照 data/enemies.ts 的口径):数字常量在热循环里最省事 */
export const CELL_EMPTY = 0;
export const CELL_WEAPON = 1;
export const CELL_SUPPORT = 2;

/**
 * 放置结果的理由码。返回码而不是 boolean / 抛异常:被拒绝时 UI 要说清"为什么不行"
 * (GDD §4.1 的规则少到不用教学,前提是每次拒绝都当场把规则讲一遍),
 * 而渲染层每帧要对 12 个格问一遍合法性 —— 那条路上不能有异常,也不能有临时对象。
 */
export const PLACE_OK = 0;
/** 越界,或该格不属于船体(occupied=false):洞与船体外的空白是一回事 */
export const PLACE_NO_CELL = 1;
/** 已有塔/设施 —— 战斗中不可移动、不可出售(GDD §4.5),想重排得等船坞节点(M1) */
export const PLACE_TAKEN = 2;
/** 内部格(四面被围)只能放支援设施(GDD §4.1) */
export const PLACE_INTERIOR = 3;
/** content 不是 CELL_WEAPON / CELL_SUPPORT。含 CELL_EMPTY:MVP 没有"放个空格"式的拆除 */
export const PLACE_BAD_CONTENT = 4;

/** 四条边的方向下标。掩码位 = 1 << edge */
export const EDGE_BOW = 0;
export const EDGE_STARBOARD = 1;
export const EDGE_STERN = 2;
export const EDGE_PORT = 3;
export const EDGE_COUNT = 4;

/** 邻格偏移,下标 = EDGE_*。密集数组,取值处用 ! 断言(noUncheckedIndexedAccess) */
const EDGE_DCOL = [0, 1, 0, -1];
const EDGE_DROW = [-1, 0, 1, 0];
/** 各边的**局部**法线角(弧度):+X = 船头 → 0,+Y = 右舷 → +π/2。世界法线见 edgeWorldNormal */
const EDGE_NORMAL = [0, Math.PI / 2, Math.PI, -Math.PI / 2];

/** 对边掩码:BOW|STERN 与 STARBOARD|PORT。角落格判定要排掉这两种"两条边但不正交"的情形 */
const MASK_BOW_STERN = (1 << EDGE_BOW) | (1 << EDGE_STERN);
const MASK_PORT_STARBOARD = (1 << EDGE_STARBOARD) | (1 << EDGE_PORT);

export interface DeckCell {
  col: number;
  row: number;
  /** 是否属于船体;12 号焊接拼块 = 把更多格置 true */
  occupied: boolean;
  /** CELL_*;05/06 会在本对象上再加 tower 引用字段 */
  content: number;
  /** 暴露边位掩码,由 occupied 集合推导,永远不手写 */
  exposed: number;
  /** popcount(exposed):0 = 内部格,2 且正交 = 角落格 */
  exposedCount: number;
  /** 见 recomputeDeck:只有武器塔会因失去全部暴露边而离线 */
  online: boolean;
}

export interface Deck {
  readonly cols: number;
  readonly rows: number;
  /** 下标 = row * cols + col,顺序固定 */
  readonly cells: DeckCell[];
  /** 任一 occupied/content 变化即 +1,渲染层据此脏标记重建几何(每帧重画 12 个格没必要) */
  revision: number;
}

/** 局部坐标暂存:模块级复用而不是每次现造 —— 渲染层每帧会问一遍全部格心(铁律 3) */
const local: Vec2 = { x: 0, y: 0 };

/**
 * 格边长:由船体尺寸推导,绝不在第三处再写死一个数(渲染层的船体多边形、config 的包围盒、这里)。
 * 取两轴较小值,保证 3×4 甲板不超出 tuning 声明的包围盒。
 * 做成函数而非常量:调用方(渲染层重建几何、单测)现读 tuning,改船体尺寸不必改这里。
 * 恒以起始的 3×4 为基准 —— 12 号扩建是"多焊几格",不是"把格子改小"。
 */
export function deckCellSize(): number {
  return Math.min(tuning.shipLength / DECK_ROWS, tuning.shipWidth / DECK_COLS);
}

/** 默认 = T0 拾荒艇的 3×4 全占用空甲板。cols/rows 可传,是给 12 号扩建与单测用的 */
export function createDeck(cols: number = DECK_COLS, rows: number = DECK_ROWS): Deck {
  const cells: DeckCell[] = [];
  // 先行后列地推入:写入顺序本身就是"下标 = row * cols + col"这条约定
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      cells.push({
        col,
        row,
        occupied: true,
        content: CELL_EMPTY,
        exposed: 0,
        exposedCount: 0,
        online: true,
      });
    }
  }
  const deck: Deck = { cols, rows, cells, revision: 0 };
  // 构造末尾算一次:createDeck 出来的甲板必须立刻答得出"谁是边缘格",不许有未初始化的中间态
  recomputeDeck(deck);
  return deck;
}

/** 越界 -1。col/row 由世界坐标反查而来时可能是任意整数,所以边界检查放在这一处统一做 */
export function cellIndex(deck: Deck, col: number, row: number): number {
  if (col < 0 || col >= deck.cols || row < 0 || row >= deck.rows) return -1;
  return row * deck.cols + col;
}

export function cellAt(deck: Deck, col: number, row: number): DeckCell | undefined {
  const i = cellIndex(deck, col, row);
  return i < 0 ? undefined : deck.cells[i];
}

/**
 * 离线状态机(12 号扩建才会触发)的唯一算式:online = 不是武器塔,或至少还留着一条暴露边。
 * 支援设施与空格恒为 true —— 只有武器塔会因失去全部暴露边而灰显、不开火(GDD §4.1 的"边缘内化")。
 * 它是 content 与暴露边的**派生量**:不造状态机、不加 timer,变了就当场重算。
 * 抽成一个函数是为了 recomputeDeck(occupied 变)与 placeAt(content 变)共用同一份算式 ——
 * 两处各抄一遍,迟早有一处写歪,而 04/05 将来是照这个字段跳过开火的。
 */
function updateOnline(cell: DeckCell): void {
  cell.online = cell.content !== CELL_WEAPON || cell.exposedCount > 0;
}

/**
 * 从 occupied 集合全量重算 exposed/exposedCount/online。
 * 全量而不是就地打补丁:改一格会牵动四个邻格,12 格量级下这点开销买的是"绝不漏更新";
 * 而且结果与遍历顺序无关 —— 只读邻格的 occupied,不读邻格刚算出来的掩码。
 */
export function recomputeDeck(deck: Deck): void {
  const cells = deck.cells;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    if (!cell.occupied) {
      // 不属于船体的格没有"边"也没有内容:一律清干净,免得 12 号拆改后留下过期的掩码/塔
      cell.exposed = 0;
      cell.exposedCount = 0;
      cell.content = CELL_EMPTY;
      cell.online = true;
      continue;
    }
    let mask = 0;
    let count = 0;
    for (let e = 0; e < EDGE_COUNT; e++) {
      const n = cellAt(deck, cell.col + EDGE_DCOL[e]!, cell.row + EDGE_DROW[e]!);
      if (n && n.occupied) continue; // 邻格属于船体 → 这条边被自家甲板挡住,不算暴露
      mask |= 1 << e;
      count++;
    }
    cell.exposed = mask;
    cell.exposedCount = count;
    updateOnline(cell);
  }
}

/** 12 号扩建的唯一入口:焊上/拆掉一格甲板。内部重算暴露边并 bump revision */
export function setOccupied(deck: Deck, col: number, row: number, occupied: boolean): void {
  const cell = cellAt(deck, col, row);
  if (!cell) return;
  cell.occupied = occupied;
  recomputeDeck(deck);
  deck.revision++;
}

export function isEdgeExposed(cell: DeckCell, edge: number): boolean {
  return (cell.exposed & (1 << edge)) !== 0;
}

/** 边缘格:至少一条边暴露 → 可放武器塔,朝暴露边开火(GDD §4.1) */
export function isEdgeCell(cell: DeckCell): boolean {
  return cell.occupied && cell.exposedCount > 0;
}

/** 内部格:四面被围 → 只能放支援设施(GDD §4.1)。非占用格不是内部格,故必须判 occupied */
export function isInteriorCell(cell: DeckCell): boolean {
  return cell.occupied && cell.exposedCount === 0;
}

/**
 * 角落格:恰好两条暴露边**且两条正交** —— 射界加宽的天然优质炮位(GDD §4.1/§4.2)。
 * 必须排掉对边的情形:1 格宽的甲板列每格都是左右舷两条对边暴露,那不是角落,
 * 04 号对它求两条法线的角平分线会退化(两法线相反,角平分线无定义)。
 */
export function isCornerCell(cell: DeckCell): boolean {
  if (cell.exposedCount !== 2) return false;
  return cell.exposed !== MASK_BOW_STERN && cell.exposed !== MASK_PORT_STARBOARD;
}

/**
 * 能不能往这一格放东西,返回 PLACE_*。**只读不写**:渲染层每帧对全甲板问一遍来算高亮,
 * ui 层每次点击前也问一遍,任何一次询问都不许改动世界。
 *
 * 判定顺序固定(理由码的语义靠它才唯一):
 *   1. content 不是武器塔/支援设施 → BAD_CONTENT。放在最前是因为它压根不是一次"放置请求",
 *      连问哪一格都无意义;顺带把"placeAt(格, CELL_EMPTY) 当拆除用"这条路堵在最外层;
 *   2. 格不存在或不属于船体 → NO_CELL;
 *   3. 已有塔/设施 → TAKEN。战斗中不可移动、不可出售(GDD §4.5)= 占用格永远拒绝,
 *      连"换一种内容盖上去"也不行;
 *   4. 武器塔落在内部格 → INTERIOR(GDD §4.1:边缘格开火、内部格供能);
 *      支援设施则任意空占用格都行,内部格正是它的主场。
 */
export function canPlace(deck: Deck, col: number, row: number, content: number): number {
  if (content !== CELL_WEAPON && content !== CELL_SUPPORT) return PLACE_BAD_CONTENT;
  const cell = cellAt(deck, col, row);
  if (!cell || !cell.occupied) return PLACE_NO_CELL;
  if (cell.content !== CELL_EMPTY) return PLACE_TAKEN;
  // 边缘/内部一律现问暴露边(而不是查一张"哪些格是边缘"的表):12 号扩建把边缘焊成内部之后,
  // 那一格立刻就不再收武器塔,不必在扩建那边记得来同步任何东西
  if (content === CELL_WEAPON && !isEdgeCell(cell)) return PLACE_INTERIOR;
  return PLACE_OK;
}

/**
 * 真正落子:合法则写 content,返回与 canPlace 同一个码。非法则一个字段都不动 ——
 * 失败不 bump revision,渲染层不会为一次拒绝白重建一遍几何(拒绝的表现是高亮层的一下闪色)。
 * 05/06 号 issue 的塔实体会在这里往格上再挂一个引用,规则判定仍然只此一处。
 */
export function placeAt(deck: Deck, col: number, row: number, content: number): number {
  const code = canPlace(deck, col, row, content);
  if (code !== PLACE_OK) return code;
  // canPlace 已经判过这一格存在且属于船体,故这里的 ! 是安全的(noUncheckedIndexedAccess)
  const cell = cellAt(deck, col, row)!;
  cell.content = content;
  // 暴露边没变(occupied 没动),只有这一格的 online 要跟着新内容走 —— 犯不着全量 recompute。
  // 有上面那条"武器塔只上边缘格"在,这一句今天算出来恒为 true;仍然照算,是为了让 online
  // 永远只由 updateOnline 这一个算式产出:哪天规则放宽(或 12 号先扩建后放塔),这里不会成为漏网
  updateOnline(cell);
  deck.revision++;
  return code;
}

/** 格心的船体局部坐标(+X = 船头,+Y = 右舷),整块甲板对称于船心 */
export function cellLocalPos(deck: Deck, col: number, row: number, out: Vec2): Vec2 {
  const size = deckCellSize();
  out.x = ((deck.rows - 1) / 2 - row) * size; // row 越小越靠船头,故取负号方向
  out.y = (col - (deck.cols - 1) / 2) * size;
  return out;
}

/**
 * 格心的世界坐标(用 sim 当前位姿)。
 * 渲染层要的是插值位姿,别用这个 —— 甲板整体作为一个 Container 跟着船转即可(见 renderer);
 * 真要按插值位姿逐格取点,走 cellWorldPosAt 传插值后的 x/y/heading。
 */
export function cellWorldPos(deck: Deck, ship: Ship, col: number, row: number, out: Vec2): Vec2 {
  return cellWorldPosAt(deck, ship.x, ship.y, ship.heading, col, row, out);
}

/** 指定位姿版:wx = x + lx·cos - ly·sin,wy = y + lx·sin + ly·cos(全仓唯一的船体→世界变换) */
export function cellWorldPosAt(
  deck: Deck,
  x: number,
  y: number,
  heading: number,
  col: number,
  row: number,
  out: Vec2,
): Vec2 {
  cellLocalPos(deck, col, row, local);
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  out.x = x + local.x * cos - local.y * sin;
  out.y = y + local.x * sin + local.y * cos;
  return out;
}

/**
 * 世界坐标反查格下标(放置交互的拾取用),不在甲板上返回 -1。
 * 与 cellWorldPos 严格互逆:先把世界点转回船体局部系(旋转的逆 = 转置),再按格边长取整。
 * 非占用格一律 -1 —— 洞与船体外的空白对拾取是一回事。
 */
export function cellIndexAtWorld(
  deck: Deck,
  x: number,
  y: number,
  heading: number,
  wx: number,
  wy: number,
): number {
  const dx = wx - x;
  const dy = wy - y;
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  const lx = dx * cos + dy * sin;
  const ly = -dx * sin + dy * cos;
  const size = deckCellSize();
  const col = Math.floor(ly / size + deck.cols / 2);
  const row = Math.floor(deck.rows / 2 - lx / size);
  const i = cellIndex(deck, col, row);
  if (i < 0) return -1;
  return deck.cells[i]!.occupied ? i : -1;
}

/**
 * 暴露边的世界法线角(弧度)。04 号的射界中心 = 本值 ± 塔弧度/2;角落格取两条法线的角平分线。
 * edge 必须是 EDGE_* 之一(密集四元组,故用 ! 断言)。
 */
export function edgeWorldNormal(edge: number, heading: number): number {
  return wrapAngle(heading + EDGE_NORMAL[edge]!);
}
