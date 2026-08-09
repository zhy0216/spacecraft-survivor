/**
 * 三选一升级的候选生成(10 号 issue T2)—— 纯逻辑层。
 * 铁律 1:本目录永不 import pixi/DOM,也**永不用 Math.random** —— 抽候选一律走调用方传进来的
 *   Rng(World 持有的那一个),于是"同 seed 两局弹出来的三张卡一字不差"是结构上的,不靠人自觉。
 * 铁律 3:候选写进调用方给的 out(World.offer),本文件自己的暂存全是模块级复用 ——
 *   一次抽卡不新增分配(卡片本身除外:out 不够长时才补一个对象,整局至多三个)。
 *
 * 本文件只回答两个问题,别的一概不管:
 *   **这一次能选什么**(rollUpgradeOffer:掷类别 → 掷型号,去重、剔掉放不下的);
 *   **某个候选有没有落点**(optionHasLegalPlacement):塔/设施走 optionLegalCells，拼块走船体外锚点。
 * 扣费、时停、弹卡、放置本身都不在这里:费用与结算在 World.takeUpgrade / skipUpgrade,
 * 时停在 main.ts,卡片在 ui/upgradeFlow.ts,而"能不能放"这条规则从头到尾只有 sim/deck.ts 那一份。
 *
 * —— 合法性只有一份 ——
 * 塔/设施候选合法 ⟺ optionLegalCells(...) > 0；拼块候选合法 ⟺ hasWeldPlacement(...)。
 * 写成"就是那个函数"而不是另写一遍判据,于是 todos/10 的"不出当前放不下的选项"是**结构上**成立的:
 * 卡面上出现的每一型,玩家点下去必然至少有一格能落;而 ui 高亮的格与生成候选时数过的格是同一批。
 * 甲板在时停期间不会变(World 不自己跑帧),故生成那一刻的合法性到玩家点下去时仍然成立。
 *
 * —— rng 消耗口径(定死,与 World.stressPickKind 一字同源)——
 * **每个候选位恰好消耗 2 次 rng**:先掷类别(45/25/15/15 按总和归一化),再在该类别的可选表里掷下标。
 * 即使这一位最终空着(四类都无合法项)也照样消耗,即消耗次数与**甲板状态、权重、去重结果全无关**。
 * 少了这条,一次平衡调整(改权重)或一次放置(改甲板)就会把整条随机序列往前后挪一格,
 * 于是"同 seed 同出怪序列"当场作废 —— 而那是 08 号那批用例与整个确定性口径的地基。
 */
import type { Rng } from '../core/rng';
import {
  OFFER_WEIGHT_DECK,
  OFFER_WEIGHT_EDICT,
  OFFER_WEIGHT_SUPPORT,
  OFFER_WEIGHT_TOWER,
  UPGRADE_CHOICE_COUNT,
} from '../data/economy';
import { DECK_PIECE_KIND_COUNT, DECK_PIECES } from '../data/deckPieces';
import { EDICT_KIND_COUNT, EDICTS, edictMask } from '../data/edicts';
import { isEvolutionTower } from '../data/evolutions';
import { SUP_AMMO_BAY, SUPPORT_KIND_COUNT, SUPPORTS } from '../data/supports';
import { TOWER_AUTOCANNON, TOWER_KIND_COUNT, TOWERS } from '../data/towers';
import { UNLOCK_EDICT, UNLOCK_TOWER, UNLOCKS } from '../data/unlocks';
import {
  canPlace,
  CELL_EMPTY,
  CELL_SUPPORT,
  CELL_WEAPON,
  type Deck,
  hasWeldPlacement,
  isPlaceSuccess,
} from './deck';

/**
 * 候选的四个类别。数字常量而非 enum(与 data/enemies.ts、deck.ts 的 CELL_* 同口径)。
 * 45/25/15/15 对应 GDD §7 的塔类/支援/甲板/法令,权重在 data/economy。
 */
export const OFFER_TOWER = 0;
export const OFFER_SUPPORT = 1;
export const OFFER_DECK = 2;
export const OFFER_EDICT = 3;

/**
 * World.takeUpgrade 在「没有待选 / choice 越界」时的返回码。
 * **落在 PLACE_*(0..8)的编号之外**是有意的:调用方拿到的是同一条返回通道,
 * 一个 `isPlaceSuccess(code)` 就把它挡在成功之外,而 ui 照码说人话时它只是多出来的一档
 *(见 upgradeFlow.denyMessage)。取负数而不是再往后排一个 9:它压根不是一条**放置**规则,
 * 与"内部格只能放设施"那些码不是一类东西,编号上就该分得开。
 */
export const UPGRADE_NO_OFFER = -1;

/**
 * 一张候选卡。**三个字段全是抽卡那一刻的快照**,不存任何指针/引用:
 * 卡片、渲染层、checksum 读的都是它,而时停期间甲板不会变,故快照与现算永远一致。
 */
export interface UpgradeOption {
  /** OFFER_*(塔类 / 支援 / 甲板拼块 / 法令)。 */
  kind: number;
  /** 按 kind 解释为 TOWERS / SUPPORTS / DECK_PIECES / EDICTS 的下标；四套编号互不相干。 */
  type: number;
  /**
   * 甲板上该型塔的**最高等级**,0 = 尚未拥有;**支援恒 0**(设施不叠级,每次都是新建一格)。
   * 卡片靠它说"未装备 / 当前 Lv3 / 满级只能新建"(见 ui 的 cardLevelText),
   * 也是玩家判断"这张卡是加宽还是加深"的唯一读数。
   * 取**最高**而不是某一格:同型塔可能在甲板上有好几座、级数各不相同,而玩家真正关心的是
   * "再点一次能到几级" —— canPlace 允许把这一次叠到任何一座未满级的同型塔上,
   * 最高的那座才是这张卡承诺的上限。
   */
  level: number;
}

/**
 * 合法格判定的暂存与探针。**绝不外借**(所以不导出,与 sim/support.ts 的 scratch 同一条理由):
 * 借出去的话,调用方刚拿到手的那份合法格表会被下一次候选生成就地清空。
 * probe 是"拿一个 (kind, type) 去问问有没有格子能放"用的临时候选 —— 它只走 optionLegalCells,
 * 那条路一个字都不读 level,故这里的 level 永远填 0 即可。
 */
const legalScratch: number[] = [];
const probe: UpgradeOption = { kind: OFFER_TOWER, type: 0, level: 0 };
/** 某一类别里"合法且本次还没被抽中"的型号表(掷下标就是在它上面掷)。同样绝不外借 */
const typePool: number[] = [];

/**
 * 解锁闸门(19 号):塔型 / 法令号 → 它在 UNLOCKS 表里的下标(= 解锁掩码位)。
 * 掩码位 i = UNLOCKS[i] 开没开,与 waves.ts 的 WAVE_LOCKED_ELITES 门控同一条约定。
 * 未被解锁表闸门覆盖的型号填 -1 = 恒进池(六座基础塔、进化塔的池外身份另由
 * isEvolutionTower 管 —— 解锁闸门只碰"解锁才进池"的那几号)。
 * 模块加载时算一次(表是静态的,运行期只做一次按位判定,铁律 3:热路径零分配)。
 */
const TOWER_UNLOCK_BIT: number[] = new Array<number>(TOWER_KIND_COUNT).fill(-1);
const EDICT_UNLOCK_BIT: number[] = new Array<number>(EDICT_KIND_COUNT).fill(-1);
for (let i = 0; i < UNLOCKS.length; i++) {
  const u = UNLOCKS[i]!;
  if (u.kind === UNLOCK_TOWER && u.type >= 0 && u.type < TOWER_KIND_COUNT) {
    TOWER_UNLOCK_BIT[u.type] = i;
  } else if (u.kind === UNLOCK_EDICT && u.type >= 0 && u.type < EDICT_KIND_COUNT) {
    EDICT_UNLOCK_BIT[u.type] = i;
  }
}

/**
 * 候选对应 deck 的哪种内容(CELL_WEAPON / CELL_SUPPORT)。
 * 与下面两个取型函数一道,是**候选 → 放置参数**的唯一翻译:ui 的 PlacementUiState 三个字段、
 * World.takeUpgrade 交给 place 的三个参数,走的都是这三个函数,于是"高亮的格"与"放下去的东西"
 * 不可能分家(高亮 = 规则,03 号立下的口径)。
 */
export function optionContent(opt: UpgradeOption): number {
  if (opt.kind === OFFER_TOWER) return CELL_WEAPON;
  if (opt.kind === OFFER_SUPPORT) return CELL_SUPPORT;
  return CELL_EMPTY;
}

/**
 * 塔型。**非塔候选返回 TOWER_AUTOCANNON 占位**,而不是 -1 或原样返回设施型号:
 * 调用方是无条件把三个字段一次填齐的(见 upgradeFlow 的 choose),用不上的那一半必须是个**合法值** ——
 * 填 -1 的话,哪天 canPlace 的判定顺序变一变,一次放设施就会先撞上 PLACE_BAD_TOWER。
 * 占位值取的正是 placeAt / canPlace 的默认参数(自动机炮 / 弹药库,GDD §4.3 的"弹药库先行"),
 * 两处默认值同源,漏传参数时的行为才与提示文案说的一致。
 */
export function optionTowerType(opt: UpgradeOption): number {
  return opt.kind === OFFER_TOWER ? opt.type : TOWER_AUTOCANNON;
}

/** 设施型。非设施候选返回 SUP_AMMO_BAY 占位,理由与 optionTowerType 一字同源 */
export function optionSupportType(opt: UpgradeOption): number {
  return opt.kind === OFFER_SUPPORT ? opt.type : SUP_AMMO_BAY;
}

/**
 * 候选的名字 —— **一律取自数值表**(TOWERS/SUPPORTS 的 name),ui 不许抄第二份:
 * 抄一份就等于埋一处迟早与数据表走散的文案(加一座塔、改一个名字,卡片却还印着旧的)。
 * 型号越界**报回原始下标而不是兜底成第 0 种**(与 ui 的 placeLabel 同一条口径、同一句措辞):
 * 候选生成只挑表里存在的型,故正常玩不出来;真出来了,那是"生成走岔了",
 * 而静默换成另一座塔正是最难查的那种表现。
 */
export function optionLabel(opt: UpgradeOption): string {
  if (opt.kind === OFFER_TOWER) return TOWERS[opt.type]?.name ?? `未知塔型(${opt.type})`;
  if (opt.kind === OFFER_SUPPORT) return SUPPORTS[opt.type]?.name ?? `未知设施(${opt.type})`;
  if (opt.kind === OFFER_EDICT) return EDICTS[opt.type]?.name ?? `未知法令(${opt.type})`;
  return DECK_PIECES[opt.type]?.name ?? `未知甲板拼块(${opt.type})`;
}

/**
 * 这个候选眼下能放到哪几格 —— 下标写进 out(cells 的下标,与 checksum/渲染层同一套编号)。
 * @param out 调用方持有的复用缓冲;进门先清长度。
 * @returns 合法格数;**0 = 这张卡现在放不下**(候选生成据此把它整个剔掉)。
 *
 * 判据只有一句 `isPlaceSuccess(canPlace(...))`,规则一行都不在这里重写:
 * 空边缘格(PLACE_OK)与未满级的同型塔(PLACE_UPGRADE)都算合法,而"哪一种算成功"这件事
 * 只有 deck.ts 的 isPlaceSuccess 知道 —— 在这里列码,迟早会漏掉后加的那一个。
 */
export function optionLegalCells(deck: Deck, opt: UpgradeOption, out: number[]): number {
  out.length = 0; // 复用调用方的缓冲:清长度,不新建数组
  if (opt.kind === OFFER_DECK) return 0; // 拼块落在船体外的逻辑格，走 canWeldPiece 而非既有 cell 下标
  const content = optionContent(opt);
  const towerType = optionTowerType(opt);
  const supportType = optionSupportType(opt);
  const cells = deck.cells;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    if (isPlaceSuccess(canPlace(deck, cell.col, cell.row, content, towerType, supportType))) {
      out.push(i);
    }
  }
  return out.length;
}

/** 任意类别的统一“至少有一个落点”判据；拼块走船体外锚点，其余走既有格下标。 */
export function optionHasLegalPlacement(deck: Deck, opt: UpgradeOption): boolean {
  // 法令不占格、没有"落点"这回事:它是全船被动,永远可授予 ——
  // 于是候选生成/重摇/ui 判合法时它恒真,与"甲板快满时塔卡越来越少"不共命运
  if (opt.kind === OFFER_EDICT) return true;
  return opt.kind === OFFER_DECK
    ? hasWeldPlacement(deck, opt.type)
    : optionLegalCells(deck, opt, legalScratch) > 0;
}

/**
 * 甲板上该型塔的最高等级(没有这一型 = 0)。见 UpgradeOption.level 那段:
 * 取最高是因为 canPlace 允许把这一次叠到任何一座未满级的同型塔上,而卡片承诺的是其中最深的那条路。
 */
function maxTowerLevel(deck: Deck, towerType: number): number {
  const cells = deck.cells;
  let level = 0;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    if (cell.content === CELL_WEAPON && cell.towerType === towerType && cell.level > level) {
      level = cell.level;
    }
  }
  return level;
}

/**
 * 甲板上是否存在至少一座**在线**且属于指定节流系的武器塔。
 * 支援死卡过滤(见 offerLegal)专用:扫一遍 backing rectangle,抽卡每局只发生十几次,
 * 不在热循环上。读 online 而不是只看 content —— 被扩建包成内部格的塔打不响,
 * 挨着它放散热器同样是零收益。
 */
function deckHasThrottleTower(deck: Deck, throttle: number): boolean {
  const cells = deck.cells;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    if (cell.content !== CELL_WEAPON || !cell.online) continue;
    if (TOWERS[cell.towerType]?.throttle === throttle) return true;
  }
  return false;
}

/**
 * 这一型现在有没有地方放。统一走 optionHasLegalPlacement(不另写判据,理由见文件头)。
 * 塔/设施每问一次扫当前 backing rectangle，拼块则扫船体外一圈锚点；抽卡每局只发生十几次，
 * 不在任何热循环上，买的是"规则只有一份"。
 *
 * 支援设施多一道**死卡过滤**(畅玩性调整):作用于某个节流系的设施(throttle >= 0,
 * 弹药库/散热器/电容组)只有在场上存在同节流系的在线武器塔时才进候选 ——
 * 开局只有弹药系机炮时,散热器/电容组选了零收益、跳过又要付手续费,是"三选一里有陷阱卡"
 * 的直接来源。装甲舱(SUPPORT_THR_NONE = -1,不作用于相邻塔)天然豁免,支援类永不被滤空到
 * 连它都不剩。过滤只改可选表内容、不碰 rng 消耗次数(见 rollUpgradeOffer 的口径),
 * 同 seed 的出怪序列逐位不变。
 */
function offerLegal(deck: Deck, kind: number, type: number): boolean {
  if (kind === OFFER_SUPPORT) {
    const throttle = SUPPORTS[type]?.throttle;
    if (throttle !== undefined && throttle >= 0 && !deckHasThrottleTower(deck, throttle)) {
      return false;
    }
  }
  probe.kind = kind;
  probe.type = type;
  probe.level = 0;
  return optionHasLegalPlacement(deck, probe);
}

/** 本次已经抽中过这一型了吗(同 kind 同 type = 同一张卡)。三张一样的卡等于没得选 */
function alreadyOffered(out: UpgradeOption[], count: number, kind: number, type: number): boolean {
  for (let i = 0; i < count; i++) {
    const o = out[i]!;
    if (o.kind === kind && o.type === type) return true;
  }
  return false;
}

/**
 * 收集某一类别里**合法且本次还没被抽中**的型号,写进 typePool,返回条数。
 * 顺序恒为型号升序(与数值表下标一致)⇒ 同 seed 掷出的下标落在同一型上,确定性与遍历顺序无关。
 * @param heldEdicts World 已持有的法令掩码(18 号):OFFER_EDICT 分支把已持有的剔出可选表 ——
 *   与支援死卡过滤同一条"只改可选表内容、不碰 rng 消耗次数"的口径,于是抽到已持有法令
 *   的"重复法令无效"沉默陷阱从结构上不存在;法令池被剔空就走 rollUpgradeOffer 的类别回退
 * @param unlockMask 解锁状态位掩码(19 号):未解锁的塔(TOWER_MISSILE_NEST)/ 法令(EDICT_RAPID)
 *   在 offerLegal **之前**就剔出可选表 —— 与 heldEdicts 同位置同口径:只收窄 typePool,
 *   不碰 rng(每个候选位 2 次 rng 无条件消耗不变),"未解锁项绝不进候选"由此结构上成立
 */
function collectTypes(
  deck: Deck,
  kind: number,
  out: UpgradeOption[],
  count: number,
  heldEdicts = 0,
  unlockMask = 0,
): number {
  typePool.length = 0;
  const kindCount =
    kind === OFFER_TOWER
      ? TOWER_KIND_COUNT
      : kind === OFFER_SUPPORT
        ? SUPPORT_KIND_COUNT
        : kind === OFFER_DECK
          ? DECK_PIECE_KIND_COUNT
          : EDICT_KIND_COUNT;
  for (let type = 0; type < kindCount; type++) {
    if (alreadyOffered(out, count, kind, type)) continue;
    // 17 号:进化塔只能从配方来(船坞里满级塔 + 相邻支援),不是"数值表里多出来的可买型号" ——
    // 能在三选一里买到就违背了 GDD §5.5"进化只在船坞"的闸门,塔型池直接跳过
    if (kind === OFFER_TOWER && isEvolutionTower(type)) continue;
    // 18 号:法令不叠级 —— 已持有的直接剔掉(与支援死卡过滤同一条"只改可选表、不碰 rng"口径)
    if (kind === OFFER_EDICT && heldEdicts !== 0 && (heldEdicts & edictMask(type)) !== 0) continue;
    // 19 号:解锁闸门 —— 未解锁的塔/法令绝不进候选(与 heldEdicts 同一条"只改可选表、不碰 rng"
    // 口径:过滤在掷之前,不耗 rng)。掩码位 = UNLOCKS 下标;unlockMask = 0 时被闸门覆盖的
    // 型号全部挡在池外(默认的旧世界构造 = 一切未解锁),不碰闸门的型号恒进池
    const unlockBit =
      kind === OFFER_TOWER ? TOWER_UNLOCK_BIT[type]! : kind === OFFER_EDICT ? EDICT_UNLOCK_BIT[type]! : -1;
    if (unlockBit >= 0 && (unlockMask & (1 << unlockBit)) === 0) continue;
    if (!offerLegal(deck, kind, type)) continue;
    typePool.push(type);
  }
  return typePool.length;
}

/**
 * 把一个已经掷出来的 [0,1) 解释成类别(塔类 / 支援 / 甲板拼块 / 法令)。
 * **只解释、不掷** —— 掷在 rollUpgradeOffer 里,且无论权重如何都恰好一次:
 * 于是改 data/economy 的 45/25/15/15 不会移动整条随机序列(见文件头的 rng 消耗口径)。
 * 四个权重都被填成 0(或负数)时回落成塔类:总不能弹一张空气卡,而塔是卡池的主体。
 */
function pickKind(roll: number, includeDeck: boolean): number {
  // 数据表是手改的,负权重会让轮盘转反 —— 与 World.stressPickKind 同一手夹取
  const wTower = Math.max(0, OFFER_WEIGHT_TOWER);
  const wSupport = Math.max(0, OFFER_WEIGHT_SUPPORT);
  const wDeck = includeDeck ? Math.max(0, OFFER_WEIGHT_DECK) : 0;
  const wEdict = Math.max(0, OFFER_WEIGHT_EDICT);
  const total = wTower + wSupport + wDeck + wEdict;
  if (total <= 0) return OFFER_TOWER;
  const t = roll * total;
  if (t < wTower) return OFFER_TOWER;
  if (t < wTower + wSupport) return OFFER_SUPPORT;
  // wDeck = 0(战斗升级)时这一行恒不成立,回退区间整段落进法令 ——
  // "甲板拼块专属于整备"由权重归零表达,而不是改区间边界
  if (t < wTower + wSupport + wDeck) return OFFER_DECK;
  return OFFER_EDICT;
}

/**
 * 抽这一次的三选一,候选写进 out,返回**真实候选数**。
 * @param out World.offer(调用方持有、跨局复用);出门时 `out.length` 恒 = 返回值 ——
 *   ui 照 length 摆卡、World 拿 `length === 0` 当"没有待选",两处读的必须是同一个真相,
 *   故这里宁可把多余的对象丢掉,也不留一截长度对不上的尾巴。
 * @param heldEdicts World 已持有的法令掩码(18 号),OFFER_EDICT 分支按它剔掉已持有:
 *   法令不叠级,候选生成时直接过滤(与支援死卡过滤同构,见 collectTypes)。
 * @param unlockMask 解锁状态位掩码(19 号,跨局存档的一部分):未解锁的塔/法令在
 *   collectTypes 里、offerLegal **之前**就剔出可选表 —— 与 heldEdicts 同位置同口径:
 *   只收窄 typePool,不碰 rng(每个候选位 2 次无条件消耗不变),于是同 seed 的随机序列
 *   逐位不受解锁状态影响(19 号验收)。缺省 0 = 一切未解锁(默认的旧世界构造语义)。
 * @returns 0 = 四类都没有合法项(通常只会是数值表/拼块表被整体裁空)。
 *   这一档由调用方兜底(World 当场按跳过结算,不响回调、不时停),本函数不认识"流程"这回事 ——
 *   返回一张空的候选表让 World 去弹,才是每帧重弹一张空卡的死循环。
 *
 * 算法定死(改它就是改确定性口径):
 *   UPGRADE_CHOICE_COUNT 个候选位,每位**先无条件掷两次 rng**(类别 → 下标),再去看甲板;
 *   可选表 = 该类别里合法(offerLegal)且本次未抽中(alreadyOffered)的型号;
 *   掷中的类别没得选就按固定次序退到其余允许类别,**复用同一个下标随机数**,一次都不额外掷;
 *   四类都没得选,这一位就空着(照样已经消耗了 2 次)。
 *   类别回退的固定次序 = 编号升序绕圈(塔 → 支援 → 甲板 → 法令);战斗升级 includeDeck=false
 *   时甲板编号(2)在绕圈里当场跳去法令(3) —— 拼块专属于整备,但塔/支援之外的法令照出
 */
export function rollUpgradeOffer(
  deck: Deck,
  rng: Rng,
  out: UpgradeOption[],
  includeDeck: boolean = true,
  heldEdicts: number = 0,
  unlockMask: number = 0,
): number {
  const kindCount = includeDeck ? 4 : 3;
  let count = 0;
  for (let slot = 0; slot < UPGRADE_CHOICE_COUNT; slot++) {
    // **两次随机在最前面、无条件**:下面每一条分支(类别回退、可选表为空、这一位空着)
    // 都不许影响消耗次数,写在这里才是结构上的保证,而不是"每条分支都记得掷一次"
    const kindRoll = rng.next();
    const indexRoll = rng.next();

    let kind = pickKind(kindRoll, includeDeck);
    let pool = collectTypes(deck, kind, out, count, heldEdicts, unlockMask);
    if (pool === 0) {
      // 类别没得选就按固定顺序轮到其余允许类别，复用同一个 indexRoll、不额外消耗 rng。
      // 战斗升级 includeDeck=false 时甲板(2)在绕圈里跳去法令(3),绝不会绕进甲板拼块。
      for (let offset = 1; offset < kindCount && pool === 0; offset++) {
        kind = (kind + 1) % 4;
        if (!includeDeck && kind === OFFER_DECK) kind = OFFER_EDICT;
        pool = collectTypes(deck, kind, out, count, heldEdicts, unlockMask);
      }
    }
    if (pool === 0) continue;

    // Math.min 那一手是防 roll 取到 1(Rng.next 恒 < 1,但下标越界的代价是一张 undefined 的卡)
    const type = typePool[Math.min(pool - 1, Math.floor(indexRoll * pool))]!;
    let opt = out[count];
    if (!opt) {
      // out 不够长才补对象:整局至多补三个,之后一路就地改字段(铁律 3)
      opt = { kind: OFFER_TOWER, type: 0, level: 0 };
      out.push(opt);
    }
    opt.kind = kind;
    opt.type = type;
    // 设施恒 0:它不叠级,每次都是新建一格(canPlace 对已占的设施格一律 TAKEN)
    opt.level = kind === OFFER_TOWER ? maxTowerLevel(deck, type) : 0;
    count++;
  }
  // 截到真实候选数:多出来的是上一次抽卡留下的旧卡,留着就会被 ui 当成第四张/第三张卡摆出来
  out.length = count;
  return count;
}
