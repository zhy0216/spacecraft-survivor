/**
 * 升级候选生成(改版 10 号 —— 甲板删除后的重写)—— 纯逻辑层。
 * 铁律 1:本目录永不 import pixi/DOM,也**永不用 Math.random** —— 抽候选一律走调用方传进来的
 *   Rng(World 持有的那一个),于是"同 seed 两局弹出来的三张卡一字不差"是结构上的,不靠人自觉。
 * 铁律 3:候选写进调用方给的 out(World.offer),本文件自己的暂存全是模块级复用 ——
 *   一次抽卡不新增分配(卡片本身除外:out 不够长时才补一个对象,整局至多三个)。
 *
 * —— 四类候选(用户设计会;权重在 data/economy.ts)——
 *   新武器 OFFER_NEW_WEAPON(5%):四类里最稀有 —— 武器获得的主要通道是整备期商店,
 *     升级三选一几乎不给新武器,"拿到新武器"永远是一件事而不是顺手的事;
 *   武器升级 OFFER_WEAPON_UPGRADE(25%):升级一张同名武器卡 = 该武器 +1 级;
 *     **可以给未拥有的武器升级**(存档等级,见 World.weaponBankedLevels ——
 *     获得那把武器时从存档级起步);
 *   支援 OFFER_SUPPORT(35%):全船被动、可重复持有(叠效),支援槽满时取用会被拒
 *     (World.acquireSupport 返回 SUPPORT_FULL,UI 照码说人话);
 *   法令 OFFER_EDICT(35%):不占槽、不叠级,已持有的从候选里剔掉。
 *
 * 本文件只回答两个问题,别的一概不管:
 *   **这一次能选什么**(rollUpgradeOffer:掷类别 → 掷型号,去重、按池过滤);
 *   某张卡是什么(optionContent / optionTowerType / optionSupportType / optionLabel)。
 * 扣费、时停、弹卡、取用本身都不在这里:费用与结算在 World.takeUpgrade / skipUpgrade,
 * 时停在 main.ts,卡片在 ui/upgradeFlow.ts。旧版的"有没有落点"判定(optionLegalCells /
 * optionHasLegalPlacement / offerLegal)随甲板删除 —— 槽位制没有"放不放得下"这回事,
 * 候选是否可取的唯一裁决在 World.takeUpgrade(槽满/支援满返回理由码)。
 *
 * —— rng 消耗口径(定死,与 World.stressPickKind 一字同源)——
 * **每个候选位恰好消耗 2 次 rng**:先掷类别(5/25/35/35 按总和归一化),再在该类别的可选表里掷下标。
 * 即使这一位最终空着(四类都无合法项)也照样消耗,即消耗次数与**槽位状态、权重、去重结果全无关**。
 * 少了这条,一次平衡调整(改权重)或一次取用(改槽位)就会把整条随机序列往前后挪一格,
 * 于是"同 seed 同出怪序列"当场作废 —— 而那是 08 号那批用例与整个确定性口径的地基。
 */
import type { Rng } from '../core/rng';
import {
  OFFER_WEIGHT_EDICT,
  OFFER_WEIGHT_NEW_WEAPON,
  OFFER_WEIGHT_SUPPORT,
  OFFER_WEIGHT_WEAPON_UPGRADE,
  UPGRADE_CHOICE_COUNT,
} from '../data/economy';
import { EDICT_KIND_COUNT, EDICTS, edictMask } from '../data/edicts';
import { isMergeResult } from '../data/merges';
import { SUP_AMMO_BAY, SUPPORT_KIND_COUNT, SUPPORTS } from '../data/supports';
import { TOWER_AUTOCANNON, TOWER_KIND_COUNT, TOWERS } from '../data/towers';
import { UNLOCK_EDICT, UNLOCK_TOWER, UNLOCKS } from '../data/unlocks';
import type { SupportSlot, WeaponSlot } from './armory';

/** 候选的四个类别。数字常量而非 enum(与 data/enemies.ts 同口径)。权重在 data/economy.ts */
export const OFFER_NEW_WEAPON = 0;
export const OFFER_WEAPON_UPGRADE = 1;
export const OFFER_SUPPORT = 2;
export const OFFER_EDICT = 3;

/** 卡片内容码(取代旧版 deck 的 CELL_*):武器两类共用 1,支援 2,其余 0。见 optionContent */
export const OFFER_CONTENT_WEAPON = 1;
export const OFFER_CONTENT_SUPPORT = 2;

/**
 * World.takeUpgrade 在「没有待选 / choice 越界」时的返回码。
 * **落在既有成功码(0)之外**是有意的:调用方拿到的是同一条返回通道,
 * 一个 `>= 0` 判据就把它挡在成功之外,而 ui 照码说人话时它只是多出来的一档
 * (见 upgradeFlow.denyMessage)。取负数:它压根不是一条**取用**规则,
 * 与"槽满 / 星币不足"那些码不是一类东西,编号上就该分得开。
 */
export const UPGRADE_NO_OFFER = -1;

/**
 * 一张候选卡。**三个字段全是抽卡那一刻的快照**,不存任何指针/引用:
 * 卡片、渲染层、checksum 读的都是它,而时停期间槽位不会变,故快照与现算永远一致。
 */
export interface UpgradeOption {
  /** OFFER_*(新武器 / 武器升级 / 支援 / 法令)。 */
  kind: number;
  /** 按 kind 解释为 TOWERS / SUPPORTS / EDICTS 的下标;三套编号互不相干。 */
  type: number;
  /**
   * 按 kind 解释:
   *   OFFER_NEW_WEAPON 恒 0(= 未装备);
   *   OFFER_WEAPON_UPGRADE = 该型武器在槽里的**最高等级**,未拥有则 = 存档等级
   *     (weaponBankedLevels)—— 卡片靠它说"当前 Lv3 → Lv4"或"未拥有(Lv2 存档起步)",
   *     也是玩家判断"这张卡是加深还是存级"的唯一读数;
   *   OFFER_SUPPORT / OFFER_EDICT 恒 0(支援不叠级、法令不叠级)。
   */
  level: number;
}

/** 某一类别里"合法且本次还没被抽中"的型号表(掷下标就是在它上面掷)。模块级复用(铁律 3) */
const typePool: number[] = [];

/**
 * 解锁闸门(19 号):塔型 / 法令号 → 它在 UNLOCKS 表里的下标(= 解锁掩码位)。
 * 掩码位 i = UNLOCKS[i] 开没开,与 waves.ts 的 WAVE_LOCKED_ELITES 门控同一条约定。
 * 未被解锁表闸门覆盖的型号填 -1 = 恒进池(合成结果塔由 isMergeResult 管 ——
 * 解锁闸门只碰"解锁才进池"的那几号)。
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
 * 候选的内容码(1 = 武器类、2 = 支援、0 = 其他)。
 * 与下面两个取型函数一道,是**候选 → 取用参数**的唯一翻译:ui 的卡片渲染与
 * World.takeUpgrade 的分支走的都是这三个函数,于是"卡片上印的"与"点下去拿到的"不可能分家。
 * 数值沿用旧 deck 的 CELL_WEAPON / CELL_SUPPORT / CELL_EMPTY(1/2/0),避免渲染层换号。
 */
export function optionContent(opt: UpgradeOption): number {
  if (opt.kind === OFFER_NEW_WEAPON || opt.kind === OFFER_WEAPON_UPGRADE) return OFFER_CONTENT_WEAPON;
  if (opt.kind === OFFER_SUPPORT) return OFFER_CONTENT_SUPPORT;
  return 0;
}

/**
 * 塔型。**非武器候选返回 TOWER_AUTOCANNON 占位**,而不是 -1 或原样返回设施型号:
 * 调用方是无条件把三个字段一次填齐的(见 upgradeFlow 的 choose),用不上的那一半必须是个**合法值**。
 * 占位值取的正是 acquire 路径的默认参数(自动机炮),两处默认值同源,漏传参数时的行为才一致。
 */
export function optionTowerType(opt: UpgradeOption): number {
  return opt.kind === OFFER_NEW_WEAPON || opt.kind === OFFER_WEAPON_UPGRADE ? opt.type : TOWER_AUTOCANNON;
}

/** 设施型。非支援候选返回 SUP_AMMO_BAY 占位,理由与 optionTowerType 一字同源 */
export function optionSupportType(opt: UpgradeOption): number {
  return opt.kind === OFFER_SUPPORT ? opt.type : SUP_AMMO_BAY;
}

/**
 * 候选的名字 —— **一律取自数值表**(TOWERS/SUPPORTS/EDICTS 的 name),ui 不许抄第二份:
 * 抄一份就等于埋一处迟早与数据表走散的文案(加一座塔、改一个名字,卡片却还印着旧的)。
 * 型号越界**报回原始下标而不是兜底成第 0 种**(与 ui 的 placeLabel 同一条口径、同一句措辞):
 * 候选生成只挑表里存在的型,故正常玩不出来;真出来了,那是"生成走岔了",
 * 而静默换成另一座塔正是最难查的那种表现。
 */
export function optionLabel(opt: UpgradeOption): string {
  if (opt.kind === OFFER_NEW_WEAPON || opt.kind === OFFER_WEAPON_UPGRADE) {
    return TOWERS[opt.type]?.name ?? `未知塔型(${opt.type})`;
  }
  if (opt.kind === OFFER_SUPPORT) return SUPPORTS[opt.type]?.name ?? `未知设施(${opt.type})`;
  return EDICTS[opt.type]?.name ?? `未知法令(${opt.type})`;
}

/** 本次已经抽中过这一型了吗(同 kind 同 type = 同一张卡)。三张一样的卡等于没得选 */
function alreadyOffered(out: UpgradeOption[], count: number, kind: number, type: number): boolean {
  for (let i = 0; i < count; i++) {
    const o = out[i]!;
    if (o.kind === kind && o.type === type) return true;
  }
  return false;
}

/** 槽里有没有这一型(任一武器槽 type === type)。新武器池与商店货架的"已有同型"判据 */
function ownsType(weapons: readonly WeaponSlot[], type: number): boolean {
  for (let i = 0; i < weapons.length; i++) {
    if (weapons[i]!.type === type) return true;
  }
  return false;
}

/** 这一型武器在槽里的最高等级(没有 = 0)。武器升级卡的 level 读数 */
function maxWeaponLevel(weapons: readonly WeaponSlot[], type: number): number {
  let level = 0;
  for (let i = 0; i < weapons.length; i++) {
    const slot = weapons[i]!;
    if (slot.type === type && slot.level > level) level = slot.level;
  }
  return level;
}

/**
 * 收集某一类别里**合法且本次还没被抽中**的型号,写进 typePool,返回条数。
 * 顺序恒为型号升序(与数值表下标一致)⇒ 同 seed 掷出的下标落在同一型上,确定性与遍历顺序无关。
 *
 * 四类的过滤(全部是"只改可选表内容、不碰 rng 消耗次数"的口径 —— 见文件头的 rng 消耗口径):
 *   NEW_WEAPON:合成结果塔(isMergeResult)不进 —— 合成武器只能三合一来,能在卡池买到就违背
 *     了"合成只在获得第 3 把时触发"的闸门;已拥有的型不进 —— 升级三选一几乎不给新武器,
 *     更不该给重复的(重复武器的唯一合法来源是……本条刻意留白,见下);
 *   WEAPON_UPGRADE:合成结果塔不进;**未拥有照进** —— 升级可以给未拥有的武器存档等级
 *     (World.weaponBankedLevels),获得那把武器时从存档级起步;
 *   SUPPORT:全部支援型都进(可重复 = 叠效;本表没有支援的解锁闸门,UNLOCKS 没有 UNLOCK_SUPPORT);
 *   EDICT:已持有(法令不叠级)与未解锁的不进。
 *
 * @param heldEdicts World 已持有的法令掩码(18 号):OFFER_EDICT 分支把已持有的剔出可选表 ——
 *   抽到已持有法令的"重复法令无效"沉默陷阱从结构上不存在;法令池被剔空就走 rollUpgradeOffer
 *   的类别回退
 * @param unlockMask 解锁状态位掩码(19 号):未解锁的塔(TOWER_MISSILE_NEST)/ 法令(EDICT_RAPID)
 *   在进池之前就剔出可选表 —— 与 heldEdicts 同位置同口径:只收窄 typePool,
 *   不碰 rng(每个候选位 2 次 rng 无条件消耗不变),"未解锁项绝不进候选"由此结构上成立
 */
function collectPool(
  kind: number,
  out: UpgradeOption[],
  count: number,
  weapons: readonly WeaponSlot[],
  heldEdicts: number,
  unlockMask: number,
): number {
  typePool.length = 0;
  const kindCount =
    kind === OFFER_NEW_WEAPON || kind === OFFER_WEAPON_UPGRADE
      ? TOWER_KIND_COUNT
      : kind === OFFER_SUPPORT
        ? SUPPORT_KIND_COUNT
        : EDICT_KIND_COUNT;
  for (let type = 0; type < kindCount; type++) {
    if (alreadyOffered(out, count, kind, type)) continue;
    if (kind === OFFER_NEW_WEAPON || kind === OFFER_WEAPON_UPGRADE) {
      // 合成结果塔只能从三合一来(见 data/merges.ts 的 isMergeResult);解锁闸门照 tower 位
      if (isMergeResult(type)) continue;
      const unlockBit = TOWER_UNLOCK_BIT[type]!;
      if (unlockBit >= 0 && (unlockMask & (1 << unlockBit)) === 0) continue;
      // 新武器池再剔掉"已经拥有一把"的型:升级三选一里 5% 的新武器给的是**没拿过**的东西,
      // 重复武器的获得通道是商店货架的刷新与未来的内容 —— 想叠第三把合成,等商店上架
      if (kind === OFFER_NEW_WEAPON && ownsType(weapons, type)) continue;
    } else if (kind === OFFER_EDICT) {
      // 法令不叠级 —— 已持有的直接剔掉(与上面的"只改可选表、不碰 rng"同一条口径)
      if (heldEdicts !== 0 && (heldEdicts & edictMask(type)) !== 0) continue;
      const unlockBit = EDICT_UNLOCK_BIT[type]!;
      if (unlockBit >= 0 && (unlockMask & (1 << unlockBit)) === 0) continue;
    }
    // OFFER_SUPPORT:全部型号都进(可重复 = 叠效;支援槽满时的"死卡"由 takeUpgrade 的
    // SUPPORT_FULL 兜底,UI 照码说人话 —— 与旧版"甲板快满时塔卡越来越少"不共命运)
    typePool.push(type);
  }
  return typePool.length;
}

/**
 * 把一个已经掷出来的 [0,1) 解释成类别(新武器 / 武器升级 / 支援 / 法令)。
 * **只解释、不掷** —— 掷在 rollUpgradeOffer 里,且无论权重如何都恰好一次:
 * 于是改 data/economy 的 5/25/35/35 不会移动整条随机序列(见文件头的 rng 消耗口径)。
 * 四个权重都被填成 0(或负数)时回落成武器升级:总不能弹一张空气卡,而升级是卡池的主体。
 */
function pickKind(roll: number): number {
  // 数据表是手改的,负权重会让轮盘转反 —— 与 World.stressPickKind 同一手夹取
  const wNew = Math.max(0, OFFER_WEIGHT_NEW_WEAPON);
  const wUp = Math.max(0, OFFER_WEIGHT_WEAPON_UPGRADE);
  const wSup = Math.max(0, OFFER_WEIGHT_SUPPORT);
  const wEdict = Math.max(0, OFFER_WEIGHT_EDICT);
  const total = wNew + wUp + wSup + wEdict;
  if (total <= 0) return OFFER_WEAPON_UPGRADE;
  const t = roll * total;
  if (t < wNew) return OFFER_NEW_WEAPON;
  if (t < wNew + wUp) return OFFER_WEAPON_UPGRADE;
  if (t < wNew + wUp + wSup) return OFFER_SUPPORT;
  return OFFER_EDICT;
}

/**
 * 抽这一次的三选一,候选写进 out,返回**真实候选数**。
 * @param out World.offer(调用方持有、跨局复用);出门时 `out.length` 恒 = 返回值 ——
 *   ui 照 length 摆卡、World 拿 `length === 0` 当"没有待选",两处读的必须是同一个真相,
 *   故这里宁可把多余的对象丢掉,也不留一截长度对不上的尾巴。
 * @param heldEdicts World 已持有的法令掩码(18 号),OFFER_EDICT 分支按它剔掉已持有:
 *   法令不叠级,候选生成时直接过滤(见 collectPool)。
 * @param unlockMask 解锁状态位掩码(19 号,跨局存档的一部分):未解锁的塔/法令在
 *   collectPool 里就剔出可选表 —— 只收窄 typePool,不碰 rng(每个候选位 2 次无条件消耗不变),
 *   于是同 seed 的随机序列逐位不受解锁状态影响(19 号验收)。缺省 0 = 一切未解锁。
 * @param weapons World.weapons:新武器池按它剔"已拥有"的型、武器升级卡的 level 读它。
 * @param supports World.supports:保留参数 —— 支援池今天不做"槽满过滤"(见 collectPool),
 *   将来若要做"支援槽满 = 支援卡不进池"的死卡过滤,过滤点就在这里。
 * @param weaponBankedLevels World.weaponBankedLevels:未拥有武器的升级卡 level 读它。
 * @returns 0 = 四类都没有合法项(通常只会是数值表被整体裁空)。
 *   这一档由调用方兜底(World 当场按跳过结算,不响回调、不时停),本函数不认识"流程"这回事 ——
 *   返回一张空的候选表让 World 去弹,才是每帧重弹一张空卡的死循环。
 *
 * 算法定死(改它就是改确定性口径):
 *   UPGRADE_CHOICE_COUNT 个候选位,每位**先无条件掷两次 rng**(类别 → 下标),再去看槽位;
 *   可选表 = 该类别里合法(collectPool)且本次未抽中(alreadyOffered)的型号;
 *   掷中的类别没得选就按固定次序退到其余允许类别,**复用同一个下标随机数**,一次都不额外掷;
 *   四类都没得选,这一位就空着(照样已经消耗了 2 次)。
 *   类别回退的固定次序 = 编号升序绕圈(新武器 → 武器升级 → 支援 → 法令)。
 */
export function rollUpgradeOffer(
  rng: Rng,
  out: UpgradeOption[],
  heldEdicts: number,
  unlockMask: number,
  weapons: readonly WeaponSlot[],
  supports: readonly SupportSlot[],
  weaponBankedLevels: readonly number[],
): number {
  void supports; // 保留参数:支援槽满的死卡过滤将来在这里做(见 collectPool 的注释)
  let count = 0;
  for (let slot = 0; slot < UPGRADE_CHOICE_COUNT; slot++) {
    // **两次随机在最前面、无条件**:下面每一条分支(类别回退、可选表为空、这一位空着)
    // 都不许影响消耗次数,写在这里才是结构上的保证,而不是"每条分支都记得掷一次"
    const kindRoll = rng.next();
    const indexRoll = rng.next();

    let kind = pickKind(kindRoll);
    let pool = collectPool(kind, out, count, weapons, heldEdicts, unlockMask);
    if (pool === 0) {
      // 类别没得选就按固定顺序轮到其余允许类别,复用同一个 indexRoll、不额外消耗 rng
      for (let offset = 1; offset < 4 && pool === 0; offset++) {
        kind = (kind + 1) % 4;
        pool = collectPool(kind, out, count, weapons, heldEdicts, unlockMask);
      }
    }
    if (pool === 0) continue;

    // Math.min 那一手是防 roll 取到 1(Rng.next 恒 < 1,但下标越界的代价是一张 undefined 的卡)
    const type = typePool[Math.min(pool - 1, Math.floor(indexRoll * pool))]!;
    let opt = out[count];
    if (!opt) {
      // out 不够长才补对象:整局至多补三个,之后一路就地改字段(铁律 3)
      opt = { kind: OFFER_NEW_WEAPON, type: 0, level: 0 };
      out.push(opt);
    }
    opt.kind = kind;
    opt.type = type;
    // level 口径见 UpgradeOption.level:武器升级读槽内最高等级(未拥有读存档等级),其余恒 0
    opt.level =
      kind === OFFER_WEAPON_UPGRADE
        ? maxWeaponLevel(weapons, type) || weaponBankedLevels[type] || 0
        : 0;
    count++;
  }
  // 截到真实候选数:多出来的是上一次抽卡留下的旧卡,留着就会被 ui 当成第四张/第三张卡摆出来
  out.length = count;
  return count;
}
