/**
 * 甲板网格 —— 纯逻辑层(03 号 issue)。
 * 铁律 1:本目录永不 import pixi/DOM,也不用 Math.random —— 换来同 seed 确定性、Node 单测、渲染可替换。
 * 铁律 3:格子是建船时一次性造好的普通对象,运行期只改字段;取坐标的函数一律写进调用方给的 out,
 *   模块内只留一个复用的暂存(照 world.ts 的 desired 写法),热循环里不新增分配。
 *
 * 甲板 = 正交网格,唯一要记住的规则是 GDD §4.1:**边缘格开火、内部格供能**。
 * 起始是 T0 拾荒艇的 3×4(10 边缘 + 2 内部),暴露边**一律从 occupied 集合动态推导**,
 * 绝不把"哪些格是边缘"写成常量表:甲板扩建会焊上 1×2/L/T/2×2 异形拼块,
 * 旧边缘格会被包成内部格(炮位变"内脏位"),写死的表当场作废。
 * 推导只看四个正交邻格是否存在且 occupied,**不做"从外部可达"的洪水填充** ——
 * 与 GDD §4.1"四面被围"的字面一致,而且 O(1)、与遍历顺序无关(中心挖空的洞对四周算暴露)。
 *
 * 坐标与角度约定(全仓唯一口径,04 射界 / 05 塔 / 12 扩建都建立在它上面):
 *   船体局部系 **+X = 船头**、**+Y = 右舷** —— 依据是既有代码(renderer 的船体多边形把船头画在
 *     +len/2,createShip 的 heading 起手 -π/2 = 屏幕上方,y 轴朝下),不另立新口径;
 *   row 沿船长,**row 0 = 最靠船头的一行**,row 增大朝船尾;col 沿船宽,**col 0 = 左舷**;
 *   逻辑 col/row 永远不改；cells 是当前 bounds 的 row-major backing，向负坐标扩容时只重排下标,
 *   不改变任何旧格的局部坐标。checksum 同时哈 col/row，故拓扑不依赖 backing 下标碰巧是多少。
 *
 * 放置规则(canPlace/placeAt,GDD §4.1 格子规则 + §4.5 战斗中放置规则)也落在本文件。
 * 本模块**只提供放置,不提供拆除/移动/出售** —— "已放置的塔不可移动、不可出售"这条规则的实现
 * 就是"没有那个 API",而不是某处的一个 if:MVP 没有船坞节点,战斗中的全部规则就只有"往空格里插"。
 * (setOccupied 清内容是 12 号焊/拆**甲板**的副作用,不是卖塔的后门。)
 * 同名叠级(GDD §5.4:Lv1→Lv5)也走 placeAt 这**同一个入口** —— 往已有同种塔的格上再放一座同种塔
 * 就是升级:原格生效、不占新格、不移动任何东西,故与"不可移动、不可出售"共存,
 * 而不是在放置之外另开一个 upgrade API(那个 API 迟早会被当成"先拆再放"用)。
 * canPlace 只读、placeAt 才写:渲染层每帧拿 canPlace 算合法格高亮,不必担心把世界改脏。
 *
 * 支援设施(06 号)的型号与四个邻接加成缓存同样扁平挂在格上,但**邻接规则本身不在本文件**:
 * 甲板只提供 neighborCell 这一份正交四邻偏移(全仓唯一,连 recomputeDeck 自己也走它),
 * 谁跟谁配对、倍率怎么连乘全在 sim/support.ts —— 本文件**绝不 import 它**(那会成运行期环)。
 * 甲板仍旧只当房东:它认识"这格有块几号设施",不认识"协同"这个概念。
 */
import { SUP_AMMO_BAY, SUPPORT_KIND_COUNT } from '../data/supports';
import { DECK_PIECES } from '../data/deckPieces';
import {
  TOWER_AUTOCANNON,
  TOWER_KIND_COUNT,
  TOWER_MAX_LEVEL,
  towerMagazine,
  TOWERS,
} from '../data/towers';
import { tuning } from './config';
import { type Ship, type Vec2, wrapAngle } from './ship';

/** 起始船体 3×4(GDD §4.1 的 T0 拾荒艇):列 = 舷宽方向,行 = 船头→船尾 */
export const DECK_COLS = 3;
export const DECK_ROWS = 4;

/** 拼块旋转档:每档顺时针 90°。 */
export const DECK_ROTATIONS = 4;

/** 焊接结果码。与 PLACE_* 分开编号:焊接不是往既有格里放内容。 */
export const WELD_OK = 20;
export const WELD_BAD_PIECE = 21;
export const WELD_BAD_ROTATION = 22;
export const WELD_OVERLAP = 23;
export const WELD_DETACHED = 24;

export function isWeldSuccess(code: number): boolean {
  return code === WELD_OK;
}

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
/**
 * 同格同种塔 = 升一级(GDD §5.4:Lv1→Lv5,数值成长,原格生效不占新格)。**这是成功码**。
 * 单开一个码而不是复用 PLACE_OK:ui 要说"升到 Lv3"而不是"已放置",渲染层也得知道该不该重画等级点。
 */
export const PLACE_UPGRADE = 5;
/** 已经 Lv5,叠不动了(GDD §5.4 的上限)。与 TAKEN 分开:玩家该被告知"满级了",而不是"这格有东西" */
export const PLACE_MAX_LEVEL = 6;
/** content = CELL_WEAPON 但 towerType 不是合法塔型(TOWERS 的下标)。多半是 ui 的键位表漏了一档 */
export const PLACE_BAD_TOWER = 7;
/**
 * content = CELL_SUPPORT 但 supportType 不是合法设施型(SUPPORTS 的下标)。
 * 与 BAD_TOWER 分成两个码而不是合并成一个"型号不对":塔型与设施型是**两套互不相干的编号**
 * (0 分别是自动机炮与弹药库),ui 照码说人话时得一眼看得出填错的是哪一套。
 */
export const PLACE_BAD_SUPPORT = 8;

/**
 * 整备期移动结果码。移动与战斗放置是两条规则:前者搬运一块已经存在的完整模块，
 * 后者获得一张升级卡后新建/叠级；编号分开，UI 才不会把“目标格被占”说成一次放置失败。
 */
export const MOVE_OK = 30;
export const MOVE_NO_SOURCE = 31;
export const MOVE_NO_TARGET = 32;
export const MOVE_TARGET_TAKEN = 33;
export const MOVE_WEAPON_INTERIOR = 34;
export const MOVE_SAME_CELL = 35;

/**
 * 放置成功的唯一判据。成功从此有**两种**(新塔 PLACE_OK / 升级 PLACE_UPGRADE),
 * 再让每个调用方各写一遍 `code === PLACE_OK` 就会分裂成两份规则 —— 而其中一份必然漏掉升级,
 * 表现是"塔明明升上去了,ui 却弹了一行红字"。
 */
export function isPlaceSuccess(code: number): boolean {
  return code === PLACE_OK || code === PLACE_UPGRADE;
}

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
  /** CELL_*;塔的型号/等级/节流状态一并扁平挂在本对象上,见下方 towerType 起的一段 */
  content: number;
  /** 暴露边位掩码,由 occupied 集合推导,永远不手写 */
  exposed: number;
  /** popcount(exposed):0 = 内部格,2 且正交 = 角落格 */
  exposedCount: number;
  /** 见 recomputeDeck:只有武器塔会因失去全部暴露边而离线 */
  online: boolean;
  /**
   * 炮口**相对射界中心**的偏角(弧度),0 = 归位。04 号只需要这一个运行期状态;
   * 05 号的塔框架会在同一个对象上继续加(冷却/热量/弹夹),故不另开平行数组 ——
   * 格与塔一一对应,12 号焊/拆甲板时它跟着格一起生灭,不会有第二个需要同步的容器。
   * 存相对量而不是世界角:船一转炮管跟着船体走(物理上正确),不必每帧追赶 heading;
   * 于是"归位"就是 turretOffset → 0,与船朝向无关,可观察、可单测。
   * 世界朝向 = wrapAngle(arc.center + turretOffset)。
   * 本文件只负责它的生灭(建格时 0、拆格时清零),唯一的写入方是 sim/turret.ts ——
   * 甲板不认识"敌人"这个概念,它只是那块状态的房东。
   */
  turretOffset: number;

  /*
   * —— 塔的运行期状态(05 号 issue)——
   * 与 turretOffset 同口径:**扁平挂在格上,一次性声明齐,运行期绝不新增字段**。
   * 不另开一个 Tower 对象挂引用,理由有三:
   *   一、格与塔一一对应,单开对象就多出一个要与格同步生灭的容器,12 号拆改甲板时必然漏一处;
   *   二、满甲板十几座塔逐帧读写这些数,扁平对象让 V8 保持单一隐藏类,不必多一层指针跳;
   *   三、清理只有一处 —— recomputeDeck 的非占用分支,漏清一个字段就是"拆了再焊,新塔继承旧热量"。
   * 甲板仍然只当**房东**:这些字段的推进(装填/降温/蓄力/开火)全在 sim/tower.ts,
   * 本文件不 import 它,也不认识"节流机制"这个概念。
   */

  /** TOWER_*(见 data/towers)。**非武器格恒 -1** —— 0 是自动机炮,拿它当"没有塔"会全盘串味 */
  towerType: number;
  /** 1..TOWER_MAX_LEVEL;非武器格恒 0。同名叠级(GDD §5.4)就是把它 +1,不占新格 */
  level: number;
  /** 距下次可开火的剩余秒(充能系恒 0:那类塔的节奏全由 charge 给) */
  cooldown: number;
  /** 弹夹余量(发)—— UI 直接显示这个整数;上限是 towerMagazine(def, level) 的派生量 */
  ammo: number;
  /** 装填剩余秒;>0 = 装填中,期间一律不许开火 */
  reloadLeft: number;
  /** 当前热量 —— UI 的热量条 = heat / towerHeatMax(def, level) */
  heat: number;
  /** 过热强制冷却的剩余秒;>0 = 锁死不许开火(UI 闪红) */
  coolLock: number;
  /** 充能进度 0..1 —— UI 的充能环;满 1.0 就停在那里等目标 */
  charge: number;

  /*
   * —— 支援设施与邻接加成(06 号 issue)——
   * 与上面那八个塔字段同一条口径:**扁平挂在格上、建格时一次性声明齐**,清理也在同一处
   * (recomputeDeck 的非占用分支)。设施与塔共用一个格对象而不是各开一套容器 ——
   * 一格上要么是塔要么是设施,两套容器只会多出一个要同步生灭的东西。
   */

  /**
   * SUP_*(见 data/supports)。**非支援格恒 -1** —— 0 是弹药库,拿它当"没有设施"会全盘串味:
   * damage.ts 的 hullMaxHp 只认这一个字段(不再问一遍 content),填 0 等于给满甲板每个空格
   * 都焊上一块弹药库。与 towerType 的 -1 是同一条「没有」的表达。
   */
  supportType: number;

  /*
   * —— 邻接 buff 缓存 —— **派生量**,由 sim/support.ts 的 recomputeSupportBuffs 全甲板重算,
   * 读它的唯一地方是 sim/tower.ts 的四个 cell* 包装(取值链路只此一条,别处不许再算一份)。
   * 缓存而不是每次现算:满甲板每帧要问几十次"这门炮实际多久一发",而配对只在甲板变了才变。
   * **1 = 这一格没有任何加成**,复位值也是 **1 不是 0**:0 作倍率是把射速/热上限直接抹成 0,
   * 与"没有加成"是两码事 —— 那样的甲板上每座塔都会瞬间过热且永远打不出下一发。
   * 四个都是"越大越好":装填与蓄力那两档由取值函数决定是乘还是除,看表的人不必逐行想方向。
   */
  /** 射速倍率(> 1 = 更快),多块设施连乘 */
  fireRateMul: number;
  /** 装填时长倍率(< 1 = 更短),连乘 */
  reloadMul: number;
  /** 过热上限倍率(> 1 = 能连烧更久),连乘 */
  heatMaxMul: number;
  /** 充能速度倍率(> 1 = 攒得更快;蓄力时长除它),连乘 */
  chargeRateMul: number;
}

export interface Deck {
  /** 当前 backing rectangle 的尺寸；焊到负坐标侧时会扩容，但逻辑格坐标不变。 */
  cols: number;
  rows: number;
  /** backing rectangle 左上角对应的稳定逻辑坐标。起始均为 0。 */
  minCol: number;
  minRow: number;
  /** 初始船体尺寸；局部坐标永远以它为中心，扩建不会把旧格整体推走。 */
  readonly baseCols: number;
  readonly baseRows: number;
  /** 下标 = (row-minRow) * cols + (col-minCol)，按当前 bounds row-major。 */
  readonly cells: DeckCell[];
  /** 任一 occupied/content 变化即 +1,渲染层据此脏标记重建几何(每帧重画局内几十格没必要) */
  revision: number;
  /**
   * 邻接 buff 缓存最后一次重算时的 revision —— sim/support.ts 的 syncSupportBuffs 拿它当脏标记:
   * 与 revision 相等就整帧 O(1) 跳过(配对只在甲板变了才会变,却是每帧都要问的东西)。
   * 初值 **-1** 而不是 0:createDeck 出来的 revision 本身就是 0,填 0 等于开局就宣称"算过了",
   * 于是第一次重算永远不会发生 —— 空甲板上看不出来,而 12 号从一块已经带设施的甲板起手时
   * 就是整局都没有加成。**派生记账,不进 checksum**(与 exposed/online 同一条理由)。
   */
  buffRevision: number;
}

/** 局部坐标暂存:模块级复用而不是每次现造 —— 渲染层每帧会问一遍全部格心(铁律 3) */
const local: Vec2 = { x: 0, y: 0 };

function createCell(col: number, row: number, occupied: boolean): DeckCell {
  return {
    col,
    row,
    occupied,
    content: CELL_EMPTY,
    exposed: 0,
    exposedCount: 0,
    online: true,
    turretOffset: 0,
    towerType: -1,
    level: 0,
    cooldown: 0,
    ammo: 0,
    reloadLeft: 0,
    heat: 0,
    coolLock: 0,
    charge: 0,
    supportType: -1,
    fireRateMul: 1,
    reloadMul: 1,
    heatMaxMul: 1,
    chargeRateMul: 1,
  };
}

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
      cells.push(createCell(col, row, true));
    }
  }
  // buffRevision 起手 -1:见接口里那段 —— 它必须与 revision(0)不等,好让第一次 sync 真的算一遍
  const deck: Deck = {
    cols,
    rows,
    minCol: 0,
    minRow: 0,
    baseCols: cols,
    baseRows: rows,
    cells,
    revision: 0,
    buffRevision: -1,
  };
  // 构造末尾算一次:createDeck 出来的甲板必须立刻答得出"谁是边缘格",不许有未初始化的中间态
  recomputeDeck(deck);
  return deck;
}

/** 越界 -1。col/row 由世界坐标反查而来时可能是任意整数,所以边界检查放在这一处统一做 */
export function cellIndex(deck: Deck, col: number, row: number): number {
  const c = col - deck.minCol;
  const r = row - deck.minRow;
  if (c < 0 || c >= deck.cols || r < 0 || r >= deck.rows) return -1;
  return r * deck.cols + c;
}

export function cellAt(deck: Deck, col: number, row: number): DeckCell | undefined {
  const i = cellIndex(deck, col, row);
  return i < 0 ? undefined : deck.cells[i];
}

/**
 * 正交四邻的第 edge 个邻格 —— **全仓唯一一份四邻偏移**(EDGE_DCOL/EDGE_DROW 只在这里被读)。
 * 暴露边推导、06 号的邻接配对、12 号的非矩形甲板于是天然共用同一条规则:
 * 加一条"邻居"的定义只需改这一个函数,而斜角永远进不来 —— 只有四个 EDGE_* 偏移,没有第五个。
 *
 * **不存在、越界、!occupied 一律 undefined**:洞与船体外的空白是一回事(与 canPlace 的 NO_CELL、
 * cellIndexAtWorld 的 -1 同一条口径)。于是 recomputeDeck 那句"邻格属于船体 → 这条边不算暴露"
 * 与 support.ts 那句"洞不算邻居"读的是同一个判据,不必两处各写一遍 occupied。
 * edge 不是 EDGE_* 时也给 undefined(而不是 ! 断言下去取到 NaN 坐标):本函数是四邻规则的
 * 唯一出口,ui/渲染层把一个越界的边下标传进来时,该得到"没有那个邻居",而不是一次远处的崩溃。
 */
export function neighborCell(deck: Deck, cell: DeckCell, edge: number): DeckCell | undefined {
  const dCol = EDGE_DCOL[edge];
  const dRow = EDGE_DROW[edge];
  if (dCol === undefined || dRow === undefined) return undefined;
  const n = cellAt(deck, cell.col + dCol, cell.row + dRow);
  return n && n.occupied ? n : undefined;
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

/** 把一个仍属于船体的格恢复成“空模块位”；occupied / exposed 等拓扑字段原样保留。 */
function clearCellModule(cell: DeckCell): void {
  cell.content = CELL_EMPTY;
  cell.online = true;
  cell.turretOffset = 0;
  cell.towerType = -1;
  cell.level = 0;
  cell.cooldown = 0;
  cell.ammo = 0;
  cell.reloadLeft = 0;
  cell.heat = 0;
  cell.coolLock = 0;
  cell.charge = 0;
  cell.supportType = -1;
  cell.fireRateMul = 1;
  cell.reloadMul = 1;
  cell.heatMaxMul = 1;
  cell.chargeRateMul = 1;
}

/**
 * 从 occupied 集合全量重算 exposed/exposedCount/online。
 * 全量而不是就地打补丁:改一格会牵动四个邻格,局内几十格量级下这点开销买的是"绝不漏更新";
 * 而且结果与遍历顺序无关 —— 只读邻格的 occupied,不读邻格刚算出来的掩码。
 */
export function recomputeDeck(deck: Deck): void {
  const cells = deck.cells;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    if (!cell.occupied) {
      // 不属于船体的格没有"边"也没有内容:一律清干净,免得 12 号拆改后留下过期的掩码/塔。
      // 炮管偏角一起清:拆掉这格再焊回来,新塔必须从归位状态起手,而不是继承上一座塔的指向
      cell.exposed = 0;
      cell.exposedCount = 0;
      // 塔/设施运行期字段的清理与整备搬运共用这一份，避免两条路径漏掉不同字段。
      clearCellModule(cell);
      continue;
    }
    let mask = 0;
    let count = 0;
    for (let e = 0; e < EDGE_COUNT; e++) {
      // 邻格属于船体 → 这条边被自家甲板挡住,不算暴露。neighborCell 已经把 occupied 与越界
      // 揉进"没有那个邻居"里,故这里不再自己判一遍(四邻规则全仓只有那一份)
      if (neighborCell(deck, cell, e)) continue;
      mask |= 1 << e;
      count++;
    }
    cell.exposed = mask;
    cell.exposedCount = count;
    updateOnline(cell);
  }
}

/** 调试/测试用的单格占用开关；正式拼块扩建走 weldPiece 的原子入口。 */
export function setOccupied(deck: Deck, col: number, row: number, occupied: boolean): void {
  const cell = cellAt(deck, col, row);
  if (!cell) return;
  cell.occupied = occupied;
  recomputeDeck(deck);
  deck.revision++;
}

export interface DeckGridCoord {
  col: number;
  row: number;
}

/** 第 index 个拼块格经 rotation 旋转后的逻辑坐标，写进 out。 */
export function deckPieceCellAt(
  pieceType: number,
  rotation: number,
  anchorCol: number,
  anchorRow: number,
  index: number,
  out: DeckGridCoord,
): DeckGridCoord | undefined {
  const def = DECK_PIECES[pieceType];
  const dCol = def?.cells[index * 2];
  const dRow = def?.cells[index * 2 + 1];
  if (dCol === undefined || dRow === undefined || !Number.isInteger(rotation)) return undefined;
  let c = dCol;
  let r = dRow;
  const turns = ((rotation % DECK_ROTATIONS) + DECK_ROTATIONS) % DECK_ROTATIONS;
  for (let i = 0; i < turns; i++) {
    const nextC = -r;
    r = c;
    c = nextC;
  }
  out.col = anchorCol + c;
  out.row = anchorRow + r;
  return out;
}

const weldCell: DeckGridCoord = { col: 0, row: 0 };

/**
 * 焊接合法性:拼块每格都在当前船体外，且至少一格与既有船体正交相邻。
 * 只读不扩容，UI 可逐帧拿它画绿/红 ghost；所有格先验完，确认时才能原子写入。
 */
export function canWeldPiece(
  deck: Deck,
  pieceType: number,
  rotation: number,
  anchorCol: number,
  anchorRow: number,
): number {
  const def = DECK_PIECES[pieceType];
  if (!def) return WELD_BAD_PIECE;
  if (!Number.isInteger(rotation) || rotation < 0 || rotation >= DECK_ROTATIONS)
    return WELD_BAD_ROTATION;
  if (!Number.isInteger(anchorCol) || !Number.isInteger(anchorRow)) return WELD_DETACHED;

  const count = def.cells.length / 2;
  for (let i = 0; i < count; i++) {
    deckPieceCellAt(pieceType, rotation, anchorCol, anchorRow, i, weldCell);
    if (cellAt(deck, weldCell.col, weldCell.row)?.occupied) return WELD_OVERLAP;
  }

  for (let i = 0; i < count; i++) {
    deckPieceCellAt(pieceType, rotation, anchorCol, anchorRow, i, weldCell);
    for (let e = 0; e < EDGE_COUNT; e++) {
      const dc = EDGE_DCOL[e]!;
      const dr = EDGE_DROW[e]!;
      if (cellAt(deck, weldCell.col + dc, weldCell.row + dr)?.occupied) return WELD_OK;
    }
  }
  return WELD_DETACHED;
}

function resizeDeckBounds(
  deck: Deck,
  minCol: number,
  minRow: number,
  maxCol: number,
  maxRow: number,
): void {
  const oldMinCol = deck.minCol;
  const oldMinRow = deck.minRow;
  const oldCols = deck.cols;
  const oldRows = deck.rows;
  const old = deck.cells.slice();
  const cols = maxCol - minCol + 1;
  const rows = maxRow - minRow + 1;
  deck.cells.length = 0;
  for (let row = minRow; row <= maxRow; row++) {
    for (let col = minCol; col <= maxCol; col++) {
      const oc = col - oldMinCol;
      const or = row - oldMinRow;
      const existing =
        oc >= 0 && oc < oldCols && or >= 0 && or < oldRows
          ? old[or * oldCols + oc]
          : undefined;
      deck.cells.push(existing ?? createCell(col, row, false));
    }
  }
  deck.minCol = minCol;
  deck.minRow = minRow;
  deck.cols = cols;
  deck.rows = rows;
}

/** 原子焊接:先完整校验，再一次扩容、一次占用写入、一次全量派生重算、一次 revision++。 */
export function weldPiece(
  deck: Deck,
  pieceType: number,
  rotation: number,
  anchorCol: number,
  anchorRow: number,
): number {
  const code = canWeldPiece(deck, pieceType, rotation, anchorCol, anchorRow);
  if (!isWeldSuccess(code)) return code;
  const count = DECK_PIECES[pieceType]!.cells.length / 2;
  let minCol = deck.minCol;
  let minRow = deck.minRow;
  let maxCol = deck.minCol + deck.cols - 1;
  let maxRow = deck.minRow + deck.rows - 1;
  for (let i = 0; i < count; i++) {
    deckPieceCellAt(pieceType, rotation, anchorCol, anchorRow, i, weldCell);
    minCol = Math.min(minCol, weldCell.col);
    minRow = Math.min(minRow, weldCell.row);
    maxCol = Math.max(maxCol, weldCell.col);
    maxRow = Math.max(maxRow, weldCell.row);
  }
  if (
    minCol !== deck.minCol ||
    minRow !== deck.minRow ||
    maxCol !== deck.minCol + deck.cols - 1 ||
    maxRow !== deck.minRow + deck.rows - 1
  ) {
    resizeDeckBounds(deck, minCol, minRow, maxCol, maxRow);
  }
  for (let i = 0; i < count; i++) {
    deckPieceCellAt(pieceType, rotation, anchorCol, anchorRow, i, weldCell);
    cellAt(deck, weldCell.col, weldCell.row)!.occupied = true;
  }
  recomputeDeck(deck);
  deck.revision++;
  return WELD_OK;
}

/** 至少存在一个可焊锚点。候选生成只在升级时调用，扫描一圈小边界换来合法性不写死。 */
export function hasWeldPlacement(deck: Deck, pieceType: number): boolean {
  const def = DECK_PIECES[pieceType];
  if (!def) return false;
  const pad = def.cells.length / 2;
  for (let rotation = 0; rotation < DECK_ROTATIONS; rotation++) {
    for (let row = deck.minRow - pad; row < deck.minRow + deck.rows + pad; row++) {
      for (let col = deck.minCol - pad; col < deck.minCol + deck.cols + pad; col++) {
        if (canWeldPiece(deck, pieceType, rotation, col, row) === WELD_OK) return true;
      }
    }
  }
  return false;
}

export function occupiedCellCount(deck: Deck): number {
  let count = 0;
  for (let i = 0; i < deck.cells.length; i++) if (deck.cells[i]!.occupied) count++;
  return count;
}

/** 扩建转向惩罚:GDD §4.4 每新增一个占用格 -1°/s。 */
export function deckTurnRate(deck: Deck): number {
  const added = Math.max(0, occupiedCellCount(deck) - deck.baseCols * deck.baseRows);
  return Math.max(0, tuning.shipTurnRate - added);
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
 * 合法塔型 = TOWERS 的下标。用 Number.isInteger 而不是只比两头大小:NaN 与 1.5 同样不是下标,
 * 放进去只会让 TOWERS[towerType] 取到 undefined —— 那时炸的是 sim/tower.ts,离现场十万八千里。
 */
function isTowerType(towerType: number): boolean {
  return Number.isInteger(towerType) && towerType >= 0 && towerType < TOWER_KIND_COUNT;
}

/**
 * 合法设施型 = SUPPORTS 的下标。与 isTowerType 一字同源(含 NaN/1.5 那道 Number.isInteger):
 * 越界的设施型放进去,SUPPORTS[cell.supportType] 在 damage.ts / 渲染层各取到一次 undefined,
 * 表现是"这块设施既不加血也不上色",而报错点离放置现场十万八千里。
 * 两套编号刻意分成两个函数、两个理由码:塔型与设施型的 0 是两种完全不同的东西。
 */
function isSupportType(supportType: number): boolean {
  return Number.isInteger(supportType) && supportType >= 0 && supportType < SUPPORT_KIND_COUNT;
}

/**
 * 能不能往这一格放东西,返回 PLACE_*。**只读不写**:渲染层每帧对全甲板问一遍来算高亮,
 * ui 层每次点击前也问一遍,任何一次询问都不许改动世界。
 * @param towerType content = CELL_WEAPON 时的塔型(TOWERS 下标),其余内容忽略它。
 *   缺省 = 自动机炮 —— 它是 GDD §5.2 的"基础输出,万金油",默认它让既有的三参调用方
 *   (04 号那批只关心几何的用例、渲染层的合法格高亮)语义原样成立,不必逐处补一个参数。
 * @param supportType content = CELL_SUPPORT 时的设施型(SUPPORTS 下标),其余内容忽略它。
 *   与 towerType 各管各的一半:**第 4 参对支援设施完全无意义**,反过来也一样。
 *   两套编号绝不并成一个"型号"参数 —— 并了之后一次填错就会静默变成另一套里的某一种,
 *   而 0 恰好在两边都存在(自动机炮 / 弹药库),错得最深的那一档偏偏最不显眼。
 *   缺省 = 弹药库,即 GDD §4.3 的"弹药库先行":漏传参数时放下去的,正是 MVP 唯一验过的那种。
 *
 * 判定顺序固定(理由码的语义靠它才唯一):
 *   1. content 不是武器塔/支援设施 → BAD_CONTENT。放在最前是因为它压根不是一次"放置请求",
 *      连问哪一格都无意义;顺带把"placeAt(格, CELL_EMPTY) 当拆除用"这条路堵在最外层;
 *   2. 武器塔但塔型非法 → BAD_TOWER。塔型对不对与哪一格无关,故也判在"问格"之前:
 *      同一个"塔型填错了"不能因为顺手点到界外就改口报 NO_CELL;
 *   3. 支援设施但设施型非法 → BAD_SUPPORT。与上一条一模一样的理由,只是换了另一半编号;
 *      两条天然互斥(一次放置只可能是其中一种内容),挨着写只为读的时候成对;
 *   4. 格不存在或不属于船体 → NO_CELL;
 *   5. 格已占:同种塔叠级(GDD §5.4)是**唯一**能落在占用格上的放置 —— 同 content、同 towerType
 *      → 未满 Lv5 给 UPGRADE、满级给 MAX_LEVEL;**其余一律 TAKEN**(换塔型、换内容都等于
 *      "出售 + 重放",GDD §4.5 明令战斗中不可移动、不可出售);
 *      **支援设施本轮不叠级**:往已有设施的格上再放一律 TAKEN,哪怕型号相同 ——
 *      GDD §5.3 的四种设施压根没有等级档,给它现编一条成长曲线不是本轮该做的事;
 *   6. 武器塔落在内部格 → INTERIOR(GDD §4.1:边缘格开火、内部格供能);
 *      支援设施则任意空占用格都行,内部格正是它的主场。
 *
 * 第 5 步排在 INTERIOR 之前是有意的:被 12 号焊成内脏位的**离线塔照样能升级** ——
 * 它只是不开火,不是不存在;而那一格早已不收新塔(空的内部格仍然一律 INTERIOR)。
 */
export function canPlace(
  deck: Deck,
  col: number,
  row: number,
  content: number,
  towerType: number = TOWER_AUTOCANNON,
  supportType: number = SUP_AMMO_BAY,
): number {
  if (content !== CELL_WEAPON && content !== CELL_SUPPORT) return PLACE_BAD_CONTENT;
  if (content === CELL_WEAPON && !isTowerType(towerType)) return PLACE_BAD_TOWER;
  if (content === CELL_SUPPORT && !isSupportType(supportType)) return PLACE_BAD_SUPPORT;
  const cell = cellAt(deck, col, row);
  if (!cell || !cell.occupied) return PLACE_NO_CELL;
  if (cell.content !== CELL_EMPTY) {
    if (content === CELL_WEAPON && cell.content === CELL_WEAPON && cell.towerType === towerType) {
      return cell.level >= TOWER_MAX_LEVEL ? PLACE_MAX_LEVEL : PLACE_UPGRADE;
    }
    return PLACE_TAKEN;
  }
  // 边缘/内部一律现问暴露边(而不是查一张"哪些格是边缘"的表):12 号扩建把边缘焊成内部之后,
  // 那一格立刻就不再收武器塔,不必在扩建那边记得来同步任何东西
  if (content === CELL_WEAPON && !isEdgeCell(cell)) return PLACE_INTERIOR;
  return PLACE_OK;
}

/**
 * 真正落子:合法则写 content(或给同种塔升一级),返回与 canPlace 同一个码。
 * 非法则一个字段都不动 —— 失败不 bump revision,渲染层不会为一次拒绝白重建一遍几何
 * (拒绝的表现是高亮层的一下闪色)。成功码有两个,故这里问 isPlaceSuccess 而不是比 PLACE_OK。
 */
export function placeAt(
  deck: Deck,
  col: number,
  row: number,
  content: number,
  towerType: number = TOWER_AUTOCANNON,
  supportType: number = SUP_AMMO_BAY,
): number {
  const code = canPlace(deck, col, row, content, towerType, supportType);
  if (!isPlaceSuccess(code)) return code;
  // canPlace 已经判过这一格存在且属于船体,故这里的 ! 是安全的(noUncheckedIndexedAccess)
  const cell = cellAt(deck, col, row)!;

  if (code === PLACE_UPGRADE) {
    // 叠级**只动等级**,运行期节流状态一概不碰:弹夹不白送满、热量不清、充能不清、炮管不归位。
    // 一来"升级 = 免费装填 + 免费散热"会让玩家掐着弹夹见底的那一刻去升级,把成长变成操作技巧;
    // 二来派生上限当帧起自动按新等级算,而 ammo ≤ 旧上限 ≤ 新上限 天然合法,不必补一次夹取。
    // 也不碰 content/online:升级不是"重放一座塔",格还是那一格,不占新格(GDD §5.4)
    cell.level++;
    deck.revision++;
    return code;
  }

  cell.content = content;
  if (content === CELL_WEAPON) {
    // 新塔的起手状态只在这一处写,且**八个字段一次性写齐**(而不是"反正建格时是 0 就不管"):
    // 这一格可能被 12 号拆了再焊、也可能被将来的规则改动放过一遭,起手状态不该指望别处的清理。
    // towerType 已过 isTowerType,故 TOWERS[towerType] 的 ! 是安全的
    cell.towerType = towerType;
    cell.level = 1;
    cell.cooldown = 0;
    cell.ammo = towerMagazine(TOWERS[towerType]!, 1); // 满弹进场;非弹药系的塔这里恒 0
    cell.reloadLeft = 0;
    cell.heat = 0;
    cell.coolLock = 0;
    cell.charge = 0;
    // 武器格**显式**写回 -1,而不是指望"反正建格时是 -1":同一条理由 —— 起手状态不该指望别处的
    // 清理。漏了这一句,一格设施被 12 号拆掉再焊回来放上塔时,那座塔身上就还挂着一块弹药库,
    // 而 damage.ts 的 hullMaxHp 只认 supportType,表现是船莫名其妙多 15 点血
    cell.supportType = -1;
  } else {
    // 支援设施:**只写型号**,塔的那八个字段一概不碰(towerType/level 恒 -1/0,由建格初值与
    // recomputeDeck 的清理保证)—— 它没有塔型,也没有节流机制。
    // 也没有等级:本轮设施不叠级,故这里没有与 PLACE_UPGRADE 对应的分支,
    // 上面 canPlace 那条"往已占的设施格再放一律 TAKEN"让这条路根本走不到。
    // 四个邻接倍率同样不碰:它们是 sim/support.ts 的派生量,新设施带来的加成由本次
    // revision++ 触发的那一遍 recomputeSupportBuffs 统一算(甲板不认识"协同"这回事)。
    cell.supportType = supportType;
  }

  // 暴露边没变(occupied 没动),只有这一格的 online 要跟着新内容走 —— 犯不着全量 recompute。
  // 有上面那条"武器塔只上边缘格"在,这一句今天算出来恒为 true;仍然照算,是为了让 online
  // 永远只由 updateOnline 这一个算式产出:哪天规则放宽(或 12 号先扩建后放塔),这里不会成为漏网
  updateOnline(cell);
  deck.revision++;
  return code;
}

/**
 * 整备期能否把现有模块搬到一个空格。只读不写，渲染层用它画合法目标；
 * “何时允许整备”不在甲板层判断，由 World.moveRefitModule 的 refitPending 闸门负责。
 */
export function canMoveModule(
  deck: Deck,
  fromCol: number,
  fromRow: number,
  toCol: number,
  toRow: number,
): number {
  const source = cellAt(deck, fromCol, fromRow);
  if (
    !source ||
    !source.occupied ||
    (source.content !== CELL_WEAPON && source.content !== CELL_SUPPORT)
  )
    return MOVE_NO_SOURCE;
  if (fromCol === toCol && fromRow === toRow) return MOVE_SAME_CELL;
  const target = cellAt(deck, toCol, toRow);
  if (!target || !target.occupied) return MOVE_NO_TARGET;
  if (target.content !== CELL_EMPTY) return MOVE_TARGET_TAKEN;
  if (source.content === CELL_WEAPON && !isEdgeCell(target)) return MOVE_WEAPON_INTERIOR;
  return MOVE_OK;
}

/**
 * 原子搬运一块模块。炮塔的等级/弹夹/热量/充能等运行期状态全部随模块走；
 * 支援设施保留型号。拓扑不变，只在成功后 bump 一次 revision。
 */
export function moveModule(
  deck: Deck,
  fromCol: number,
  fromRow: number,
  toCol: number,
  toRow: number,
): number {
  const code = canMoveModule(deck, fromCol, fromRow, toCol, toRow);
  if (code !== MOVE_OK) return code;
  const source = cellAt(deck, fromCol, fromRow)!;
  const target = cellAt(deck, toCol, toRow)!;

  target.content = source.content;
  target.turretOffset = source.turretOffset;
  target.towerType = source.towerType;
  target.level = source.level;
  target.cooldown = source.cooldown;
  target.ammo = source.ammo;
  target.reloadLeft = source.reloadLeft;
  target.heat = source.heat;
  target.coolLock = source.coolLock;
  target.charge = source.charge;
  target.supportType = source.supportType;
  // 邻接倍率属于“目标格的新邻居关系”的派生缓存，不随模块搬运；下一次 sync 会重算。
  target.fireRateMul = 1;
  target.reloadMul = 1;
  target.heatMaxMul = 1;
  target.chargeRateMul = 1;

  clearCellModule(source);
  updateOnline(target);
  deck.revision++;
  return MOVE_OK;
}

/** 格心的船体局部坐标(+X = 船头,+Y = 右舷),整块甲板对称于船心 */
export function cellLocalPos(deck: Deck, col: number, row: number, out: Vec2): Vec2 {
  const size = deckCellSize();
  // **只以初始船体为中心**:backing bounds 往船头/左舷扩容时，旧格绝不能整体平移。
  out.x = ((deck.baseRows - 1) / 2 - row) * size;
  out.y = (col - (deck.baseCols - 1) / 2) * size;
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
 * 船体局部坐标反查格下标,不在甲板上返回 -1。
 * 与 cellLocalPos 严格互逆,也是所有拾取路径最终共用的**唯一**「局部坐标 → 格」算式:
 * 老的世界坐标入口先把点逆旋转到局部系再走这里;10 号时停放大则由渲染层的 deckG.toLocal
 * 直接给出局部坐标再走这里。于是甲板缩放/缓动不会逼 ui 复制第二份格子公式。
 * 非占用格一律 -1 —— 洞与船体外的空白对拾取是一回事。
 */
export function cellIndexAtLocal(deck: Deck, lx: number, ly: number): number {
  deckGridAtLocal(deck, lx, ly, weldCell);
  const i = cellIndex(deck, weldCell.col, weldCell.row);
  if (i < 0) return -1;
  return deck.cells[i]!.occupied ? i : -1;
}

/** 局部坐标反查稳定逻辑格坐标；即使落在当前 bounds 外也返回格，供拼块 ghost 拾取。 */
export function deckGridAtLocal(
  deck: Deck,
  lx: number,
  ly: number,
  out: DeckGridCoord,
): DeckGridCoord {
  const size = deckCellSize();
  out.col = Math.floor(ly / size + deck.baseCols / 2);
  out.row = Math.floor(deck.baseRows / 2 - lx / size);
  return out;
}

/**
 * 世界坐标反查格下标(放置交互的拾取用),不在甲板上返回 -1。
 * 与 cellWorldPos 严格互逆:只负责把世界点转回船体局部系(旋转的逆 = 转置),
 * 真正的格子反查统一交给 cellIndexAtLocal —— 两条拾取入口绝不各养一份取整公式。
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
  return cellIndexAtLocal(deck, lx, ly);
}

/**
 * 暴露边的世界法线角(弧度)。04 号的射界中心 = 本值 ± 塔弧度/2;角落格取两条法线的角平分线。
 * edge 必须是 EDGE_* 之一(密集四元组,故用 ! 断言)。
 */
export function edgeWorldNormal(edge: number, heading: number): number {
  return wrapAngle(heading + EDGE_NORMAL[edge]!);
}
