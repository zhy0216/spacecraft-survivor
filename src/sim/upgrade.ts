/**
 * 三选一升级的候选生成(10 号 issue T2)—— 纯逻辑层。
 * 铁律 1:本目录永不 import pixi/DOM,也**永不用 Math.random** —— 抽候选一律走调用方传进来的
 *   Rng(World 持有的那一个),于是"同 seed 两局弹出来的三张卡一字不差"是结构上的,不靠人自觉。
 * 铁律 3:候选写进调用方给的 out(World.offer),本文件自己的暂存全是模块级复用 ——
 *   一次抽卡不新增分配(卡片本身除外:out 不够长时才补一个对象,整局至多三个)。
 *
 * 本文件只回答两个问题,别的一概不管:
 *   **这一次能选什么**(rollUpgradeOffer:掷类别 → 掷型号,去重、剔掉放不下的);
 *   **某个候选能放到哪几格**(optionLegalCells:渲染层的合法格高亮、ui 的确认、
 *     单测里的自动玩家,读的都是这一个函数)。
 * 扣费、时停、弹卡、放置本身都不在这里:费用与结算在 World.takeUpgrade / skipUpgrade,
 * 时停在 main.ts,卡片在 ui/upgradeFlow.ts,而"能不能放"这条规则从头到尾只有 sim/deck.ts 那一份。
 *
 * —— 合法性只有一份 ——
 * 候选合法 ⟺ optionLegalCells(...) > 0 ⟺ 至少有一格 canPlace 给成功码。
 * 写成"就是那个函数"而不是另写一遍判据,于是 todos/10 的"不出当前放不下的选项"是**结构上**成立的:
 * 卡面上出现的每一型,玩家点下去必然至少有一格能落;而 ui 高亮的格与生成候选时数过的格是同一批。
 * 甲板在时停期间不会变(World 不自己跑帧),故生成那一刻的合法性到玩家点下去时仍然成立。
 *
 * —— rng 消耗口径(定死,与 World.stressPickKind 一字同源)——
 * **每个候选位恰好消耗 2 次 rng**:先掷类别(按 data/economy 的 65/35),再在该类别的可选表里掷下标。
 * 即使这一位最终空着(甲板上两类都没得放了)也照样消耗,即消耗次数与**甲板状态、权重、去重结果全无关**。
 * 少了这条,一次平衡调整(改权重)或一次放置(改甲板)就会把整条随机序列往前后挪一格,
 * 于是"同 seed 同出怪序列"当场作废 —— 而那是 08 号那批用例与整个确定性口径的地基。
 */
import type { Rng } from '../core/rng';
import { OFFER_WEIGHT_SUPPORT, OFFER_WEIGHT_TOWER, UPGRADE_CHOICE_COUNT } from '../data/economy';
import { SUP_AMMO_BAY, SUPPORT_KIND_COUNT, SUPPORTS } from '../data/supports';
import { TOWER_AUTOCANNON, TOWER_KIND_COUNT, TOWERS } from '../data/towers';
import { canPlace, CELL_SUPPORT, CELL_WEAPON, type Deck, isPlaceSuccess } from './deck';

/**
 * 候选的两个类别。数字常量而非 enum(与 data/enemies.ts、deck.ts 的 CELL_* 同口径)。
 * MVP 的卡池就只有这两类:甲板拼块归 12 号、法令归 M2(GDD §7 的四类在 todos/10 里已裁剪成两类)。
 */
export const OFFER_TOWER = 0;
export const OFFER_SUPPORT = 1;

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
  /** OFFER_*(塔类 / 支援)。只有这两档,别处不许出现第三种 */
  kind: number;
  /** 按 kind 解释:塔类 = TOWER_*(TOWERS 下标),支援 = SUP_*(SUPPORTS 下标)。两套编号互不相干 */
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
 * 候选对应 deck 的哪种内容(CELL_WEAPON / CELL_SUPPORT)。
 * 与下面两个取型函数一道,是**候选 → 放置参数**的唯一翻译:ui 的 PlacementUiState 三个字段、
 * World.takeUpgrade 交给 place 的三个参数,走的都是这三个函数,于是"高亮的格"与"放下去的东西"
 * 不可能分家(高亮 = 规则,03 号立下的口径)。
 */
export function optionContent(opt: UpgradeOption): number {
  return opt.kind === OFFER_TOWER ? CELL_WEAPON : CELL_SUPPORT;
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
  return SUPPORTS[opt.type]?.name ?? `未知设施(${opt.type})`;
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
 * 这一型现在有没有地方放。**就是 optionLegalCells > 0**(不另写判据,理由见文件头)。
 * 每问一次要扫一遍 12 格,一次抽卡至多问 (6 塔 + 4 设施) × 2 = 20 次 ——
 * 而抽卡每局只发生十几次,不在任何热循环上,买的是"规则只有一份"。
 */
function offerLegal(deck: Deck, kind: number, type: number): boolean {
  probe.kind = kind;
  probe.type = type;
  probe.level = 0;
  return optionLegalCells(deck, probe, legalScratch) > 0;
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
 */
function collectTypes(deck: Deck, kind: number, out: UpgradeOption[], count: number): number {
  typePool.length = 0;
  const kindCount = kind === OFFER_TOWER ? TOWER_KIND_COUNT : SUPPORT_KIND_COUNT;
  for (let type = 0; type < kindCount; type++) {
    if (alreadyOffered(out, count, kind, type)) continue;
    if (!offerLegal(deck, kind, type)) continue;
    typePool.push(type);
  }
  return typePool.length;
}

/**
 * 把一个已经掷出来的 [0,1) 解释成类别(塔类 / 支援)。
 * **只解释、不掷** —— 掷在 rollUpgradeOffer 里,且无论权重如何都恰好一次:
 * 于是改 data/economy 的 65/35 不会移动整条随机序列(见文件头的 rng 消耗口径)。
 * 两个权重都被填成 0(或负数)时回落成塔类:总不能弹一张空气卡,而塔是卡池的主体。
 */
function pickKind(roll: number): number {
  // 数据表是手改的,负权重会让轮盘转反 —— 与 World.stressPickKind 同一手夹取
  const wTower = Math.max(0, OFFER_WEIGHT_TOWER);
  const wSupport = Math.max(0, OFFER_WEIGHT_SUPPORT);
  const total = wTower + wSupport;
  if (total <= 0) return OFFER_TOWER;
  // 按两者之和归一化 ⇒ 权重不必凑 100(data/economy 那段写了这条口径)
  return roll * total < wTower ? OFFER_TOWER : OFFER_SUPPORT;
}

/**
 * 抽这一次的三选一,候选写进 out,返回**真实候选数**。
 * @param out World.offer(调用方持有、跨局复用);出门时 `out.length` 恒 = 返回值 ——
 *   ui 照 length 摆卡、World 拿 `length === 0` 当"没有待选",两处读的必须是同一个真相,
 *   故这里宁可把多余的对象丢掉,也不留一截长度对不上的尾巴。
 * @returns 0 = **甲板彻底没得放**(每一格都占着、且所有同型塔都满级了)。
 *   这一档由调用方兜底(World 当场按跳过结算,不响回调、不时停),本函数不认识"流程"这回事 ——
 *   返回一张空的候选表让 World 去弹,才是每帧重弹一张空卡的死循环。
 *
 * 算法定死(改它就是改确定性口径):
 *   UPGRADE_CHOICE_COUNT 个候选位,每位**先无条件掷两次 rng**(类别 → 下标),再去看甲板;
 *   可选表 = 该类别里合法(offerLegal)且本次未抽中(alreadyOffered)的型号;
 *   掷中的类别没得选就退到另一类别,**复用同一个下标随机数**,一次都不额外掷;
 *   两类都没得选,这一位就空着(照样已经消耗了 2 次)。
 */
export function rollUpgradeOffer(deck: Deck, rng: Rng, out: UpgradeOption[]): number {
  let count = 0;
  for (let slot = 0; slot < UPGRADE_CHOICE_COUNT; slot++) {
    // **两次随机在最前面、无条件**:下面每一条分支(类别回退、可选表为空、这一位空着)
    // 都不许影响消耗次数,写在这里才是结构上的保证,而不是"每条分支都记得掷一次"
    const kindRoll = rng.next();
    const indexRoll = rng.next();

    let kind = pickKind(kindRoll);
    let pool = collectTypes(deck, kind, out, count);
    if (pool === 0) {
      // 掷中的类别没得选(比如甲板只剩内部格:塔一座都放不下)→ 退到另一类别。
      // 这就是 todos/10 那条"甲板已满时的兜底":能出的只剩叠级/设施时,卡池自己就收敛过去了
      kind = kind === OFFER_TOWER ? OFFER_SUPPORT : OFFER_TOWER;
      pool = collectTypes(deck, kind, out, count);
    }
    if (pool === 0) continue; // 两类都没得放:这一位空着(rng 照样消耗过了)

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
