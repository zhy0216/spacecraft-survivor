/**
 * 条件式解锁表(19 号 issue T1)—— 纯数据,单向依赖 towers/edicts/waves(它们不回头 import 本文件)。
 * 与 data/towers.ts / data/edicts.ts 同风格:数字常量而非 enum、字段不加 readonly、不 Object.freeze
 * (单测要临时改字段再 afterEach 还原);铁律照旧:永不 import pixi/DOM,也永不 import sim/
 * (卡池过滤、解锁判定、存档读写都在下游,引回去就成环)。
 *
 * GDD §10 的红线:**只解锁内容,不解锁数值** —— 解锁项全部是"进池 / 进事件 / 进图鉴",
 * 没有任何永久伤害/血量加成。条件与内容解耦:
 *   条件 = UnlockCondition(阈值字段:kind 选哪种条件, target 给阈值);
 *   内容 = kind(UNLOCK_* 分三类)+ type(引用 towers / edicts / waves 的类型 id)。
 * 于是"改阈值"只动 condition 一行,"换解锁内容"只动 kind/type 两行,互不牵连。
 *
 * 判定是纯函数(unlockMet):progress 由存档侧(sim/progress.ts,后续 issue)每局结算喂进来,
 * 失败局同样推进(条件达成即记,不因失败回滚 —— 19 号验收口径,本表只认"到没到",不认胜负)。
 *
 * **下标只增不改** —— progress.unlockMask 的位 i = UNLOCKS[i],旧存档的掩码指到哪条
 * 就永远是哪条;新条目一律追加到末尾,不许插入/重排(progress.test 与 saves 都钉着这条编码)。
 * 起手配置类(旧 UNLOCK_LOADOUT,随机开局改版):两条起手解锁随选择界面一并删除,
 * 落在表尾、后续位号不受影响 —— 旧存档掩码里多余的置位被忽略,不构成伤害。
 *
 * 与确定性的关系:解锁状态只收窄候选集合(少掷中未解锁项),不移动 rng 消耗次数 ——
 * 卡池过滤在 sim/upgrade.ts 的 collectTypes 里与 offerLegal 同位置落地(后续 issue),
 * 本表只声明"哪一号内容被哪一条条件挡着"。
 */
import { EDICT_OVERDRIVE } from './edicts';
import { TOWER_MISSILE_NEST } from './towers';

export const UNLOCK_TOWER = 0; // 解锁塔入池(三选一候选)
export const UNLOCK_EDICT = 1; // 解锁法令(18 号,三选一候选)
export const UNLOCK_ELITE = 2; // 解锁精英事件(词缀更高的脚本事件,waves.ts 的 WAVE_LOCKED_ELITES)

export const COND_FIRST_WIN = 0; // 首次胜利(wins ≥ 1)
export const COND_KILLS = 1; // 单局击杀数阈值(单局内累计)
export const COND_ELITE_KILLS = 2; // 累计精英击杀计数(跨局累计,14 号精英计数的读数)

export interface UnlockCondition {
  /** COND_* */
  kind: number;
  /** 阈值;COND_FIRST_WIN 恒 0(那种条件的判据不是数字阈值) */
  target: number;
}

export interface UnlockEntry {
  /** 唯一 id。waves.ts 的 LockedElite.unlockId 与它同串互相咬合(单测钉着) */
  id: string;
  /**
   * devName:开发/调参用的**中文开发名**,只给人看、逻辑不读。
   * 玩家界面不得读它 —— 显示名一律走 presenter(src/ui/presentation/unlockText 的 unlockName,
   * 按 id 查 content.unlocks)。
   */
  devName: string;
  /** UNLOCK_* */
  kind: number;
  /** 目标内容:按 kind 解释为 TOWERS / EDICTS / WAVE_LOCKED_ELITES 的下标 */
  type: number;
  condition: UnlockCondition;
}

/**
 * 存档侧每局结算喂进来的进度(纯数字,可序列化)。wins/kills 是当局结算值,
 * eliteKills 是跨局累计(14 号计数从第 0 局起就不清零) —— 具体累计口径在 sim/progress.ts,
 * 本表只回答"这份进度够不够开这条锁"。
 */
export interface UnlockProgress {
  /** 累计胜利局数(首次胜利判定用) */
  wins: number;
  /** 当局击杀数(单局阈值判定用;未达标的失败局照常入档,不因失败回滚) */
  kills: number;
  /** 累计精英击杀数 */
  eliteKills: number;
}

/**
 * 首批三条解锁(19 号任务清单;船形收藏条已随剪影功能一并删除):
 *   1. 首次胜利 → 进阶塔"导弹巢"入池(towers.ts 第 12 号);
 *   2. 单局击杀 300 达标 → 新法令"急速协议"(edicts.ts 第 6 号,与 18 号联动);
 *   3. 累计击杀 14 只精英(≈ 两三局的量,占位待调)→ 三重词缀精英事件"虫群母巢"
 *      (waves.ts 的 WAVE_LOCKED_ELITES,词缀数 > 既有段的上限 2)。
 */
export const UNLOCKS: UnlockEntry[] = [
  {
    id: 'tower-missile-nest',
    devName: '导弹巢',
    kind: UNLOCK_TOWER,
    type: TOWER_MISSILE_NEST, // 首次胜利后才进三选一池;unlocks.test 钉着"它是非进化塔,池子闸门对它生效"
    condition: { kind: COND_FIRST_WIN, target: 0 },
  },
  {
    // **id 与下标都不许改**(progress.unlockMask 的位 i = UNLOCKS[i],旧存档的掩码指着它);
    // 支援并入法令后"急速协议"随同轴合并消失,这一条改指进阶法令"超载协议" ——
    // 换的是解锁内容(kind/type 两行),不是这条锁本身
    id: 'edict-rapid',
    devName: '超载协议',
    kind: UNLOCK_EDICT,
    type: EDICT_OVERDRIVE, // 单局击杀达标才进三选一池(与法令池同一条闸门)
    condition: { kind: COND_KILLS, target: 300 }, // 单局 300 杀 ≈ 中盘偏后,占位待调
  },
  {
    id: 'elite-queen',
    devName: '虫群母巢',
    kind: UNLOCK_ELITE,
    type: 0, // WAVE_LOCKED_ELITES 的下标;unlocks.test 钉:该条的 unlockId === 本条 id
    condition: { kind: COND_ELITE_KILLS, target: 14 }, // 累计 14 只精英 ≈ 两三局,占位待调
  },
];

export const UNLOCK_COUNT = UNLOCKS.length;

/**
 * 这条解锁现在开没开。纯函数:条件类型 → 对照 progress 的对应读数,阈值不到恒 false。
 * 失败局同样推进的语义在存档侧(progress 怎么记),这里只管"progress 够不够"。
 */
export function unlockMet(entry: UnlockEntry, progress: UnlockProgress): boolean {
  switch (entry.condition.kind) {
    case COND_FIRST_WIN:
      return progress.wins >= 1;
    case COND_KILLS:
      return progress.kills >= entry.condition.target;
    case COND_ELITE_KILLS:
      return progress.eliteKills >= entry.condition.target;
    default:
      return true; // 未知条件编号:表内条目由 unlocks.test 钉住编号合法,这里对伪造条目不崩溃
  }
}
