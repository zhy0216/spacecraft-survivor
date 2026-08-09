/**
 * 元进度存档的纯数据层(19 号 issue 的"存档模块")。
 *
 * 铁律 1 的边界画在这里:本文件**零 DOM / 零 localStorage**,Node 里可单测。
 * 剪影的抓取在 renderer、localStorage 的读写适配在 ui/progressStorage.ts、结算流程在 main.ts ——
 * 全在下游,本文件不认识它们,能做的事只有三样:给一份进度和一局结算算出新进度
 * (evaluateRun)、两份进度单调合并(mergeProgress)、JSON 序列化往返(serialize/parse)。
 *
 * 三句话口径(与 data/unlocks.ts 文件头互相咬合):
 * 1. **条件达成即记,不看胜负** —— 失败局照常入档,不因失败回滚(19 号验收"失败局同样推进")。
 *    胜负只影响一件事:wins 只在 RESULT_WIN 时 +1(首次胜利锁的判据)。
 * 2. **只解锁内容,不解锁数值(GDD §10 红线)** —— 本文件只累计布尔位与三个整数计数器,
 *    没有任何永久伤害/血量加成,难度曲线保持诚实。
 * 3. **剪影是锦上添花** —— 限量最近 N 张 + 总字节预算(容量注意,19 号口径),超了丢最旧;
 *    存储失败只影响图鉴,不能反噬一局的收尾。
 *
 * 位掩码约定(与 sim/upgrade.ts 的 TOWER_UNLOCK_BIT / EDICT_UNLOCK_BIT、sim/waves.ts 的
 * WAVE_LOCKED_ELITES 门控同一条):**位 i = UNLOCKS[i] 开没开**,即 mask & (1 << i)。
 * progress.test.ts 把这条编码与 upgrade.ts 的闸门逐位互钉。
 */
import { unlockMet, UNLOCKS, type UnlockProgress } from '../data/unlocks';
import { RESULT_WIN } from './world';

/** 剪影集合上限:最近 N 张。超出丢最旧(队列语义,下标 0 = 最旧) */
export const SILHOUETTE_MAX_COUNT = 10;
/**
 * 剪影集合总字节预算。dataURL 是 base64 字符串,一个字符 ≈ 一字节,故直接用字符串长度合计。
 * 500KB 内可装 ~5 张 100KB 级快照,几十局下来也不会戳穿 localStorage 的 5MB 配额(19 号容量注意)。
 */
export const SILHOUETTE_MAX_BYTES = 500 * 1024;

/** 全解锁掩码:位 0..UNLOCKS.length-1 全置 1。解析时把越界高位裁掉用的上限 */
const FULL_MASK = (1 << UNLOCKS.length) - 1;

/** 一局的结算读数(纯数据)。main.ts 从 World 摘好递进来,字段口径见各注释 */
export interface RunStats {
  /** RESULT_WIN / RESULT_LOSE(sim/world.ts)。只认胜利:wins 是否 +1 全看这一位 */
  result: number;
  /** 本局击杀数。COND_KILLS(单局阈值)对照的就是它,与 world.kills 同读数 */
  kills: number;
  /** 本局精英击杀数。累计进 Progress.eliteKills(14 号精英计数,跨局不清零) */
  eliteKills: number;
  /** 本局船形剪影 dataURL;渲染层抓不到就是 null,此时不入图鉴 */
  silhouette: string | null;
}

/** 元进度。只存解锁布尔与计数器、剪影集合 —— 局内状态是 sim 的,不存在存档里(19 号口径) */
export interface Progress {
  /** 位 i = UNLOCKS[i] 开没开(与 World.unlockMask 同编码,直接喂构造参数) */
  unlockMask: number;
  /** 累计胜利局数(首次胜利锁的判据) */
  wins: number;
  /** 累计击杀总数(展示/统计用;单局阈值判定不读它,读 RunStats.kills) */
  kills: number;
  /** 累计精英击杀数(COND_ELITE_KILLS 的判据) */
  eliteKills: number;
  /** 船形剪影集合:下标 0 = 最旧,末尾 = 最新;限量 + 容量保护(见 pushSilhouette) */
  silhouettes: string[];
}

export interface EvaluateResult {
  /** 结算后的新进度(**新对象**,入参 progress 不被改动) */
  progress: Progress;
  /** 本次新开的位掩码(增量):0 = 没有新解锁。结算界面"解锁 XX"提示读它 */
  newUnlocks: number;
}

/** 空进度:一切未解锁、计数器归零、无剪影 */
export function createProgress(): Progress {
  return { unlockMask: 0, wins: 0, kills: 0, eliteKills: 0, silhouettes: [] };
}

/**
 * 一局结算进一次进度。纯函数:不修改入参,返回新对象。
 * 条件达成即记(不看 result):失败局的 300 杀照样开 edict-rapid —— 不因失败回滚,
 * 只"惩罚尝试"的不是进度,是玩家自己(19 号口径)。
 */
export function evaluateRun(progress: Progress, run: RunStats): EvaluateResult {
  const wins = progress.wins + (run.result === RESULT_WIN ? 1 : 0);
  const runKills = Math.max(0, run.kills);
  const eliteKills = progress.eliteKills + Math.max(0, run.eliteKills);
  // 喂给 unlockMet 的读数:首次胜利/累计精英看结算后的累计值,单局击杀阈值看本局击杀数
  const check: UnlockProgress = { wins, kills: runKills, eliteKills };
  let mask = progress.unlockMask;
  for (let i = 0; i < UNLOCKS.length; i++) {
    if ((mask & (1 << i)) !== 0) continue; // 已解锁不重复判(条件不会回退)
    if (unlockMet(UNLOCKS[i]!, check)) mask |= 1 << i;
  }
  return {
    progress: {
      unlockMask: mask,
      wins,
      kills: progress.kills + runKills,
      eliteKills,
      silhouettes: pushSilhouette(progress.silhouettes, run.silhouette),
    },
    newUnlocks: mask ^ progress.unlockMask,
  };
}

/**
 * 剪影入队:新 dataURL 追加到末尾,随后按"最近 N 张"与"总字节预算"两条线裁掉最旧的。
 * null/空串 = 没抓到剪影,原列表原样返回(不新增、不改动)。
 * 裁减**绝不把刚入队的这张也丢掉**(length > 1 才允许丢):这一局至少留一张。
 */
export function pushSilhouette(list: string[], dataUrl: string | null): string[] {
  if (dataUrl === null || dataUrl.length === 0) return list;
  const next = list.slice();
  next.push(dataUrl);
  return capSilhouettes(next);
}

/** 按限量与预算裁减(共享给 pushSilhouette 与解析兜底:载入时同样要守住容量) */
function capSilhouettes(list: string[]): string[] {
  const next = list.slice();
  while (next.length > SILHOUETTE_MAX_COUNT) next.shift();
  while (next.length > 1 && byteSize(next) > SILHOUETTE_MAX_BYTES) next.shift();
  return next;
}

function byteSize(list: string[]): number {
  let total = 0;
  for (const s of list) total += s.length;
  return total;
}

/**
 * 两份进度单调合并(如将来多存档/云同步对账):掩码取并、计数器取最大、
 * 剪影去重后合并再裁回限量与预算。合并是"两边的进度都向前"的保底口径,
 * 任何一边都不会把另一边拉回去。跨份剪影的先后顺序不可知,去重保留先出现的那份。
 */
export function mergeProgress(a: Progress, b: Progress): Progress {
  const seen = new Set<string>(a.silhouettes);
  const silhouettes = a.silhouettes.slice();
  for (const s of b.silhouettes) {
    if (seen.has(s)) continue;
    seen.add(s);
    silhouettes.push(s);
  }
  return {
    unlockMask: a.unlockMask | b.unlockMask,
    wins: Math.max(a.wins, b.wins),
    kills: Math.max(a.kills, b.kills),
    eliteKills: Math.max(a.eliteKills, b.eliteKills),
    silhouettes: capSilhouettes(silhouettes),
  };
}

/** 序列化:Progress → JSON 字符串。纯函数,可单测(JSON 往返见 progress.test.ts) */
export function serializeProgress(p: Progress): string {
  return JSON.stringify(p);
}

/**
 * 反序列化:JSON 字符串 → Progress。损坏(非法 JSON / 缺字段 / 类型错)返回 null,
 * 由调用方(localStorage 适配器)兜底成空进度 —— 存档坏了就从头再来,不能卡死收尾。
 * 形状合法的旧数据还要过一遍"夹取":越界掩码位裁掉、计数器夹非负整数、
 * 剪影重新裁回限量与预算(手改过的存档不许撑爆配额)。
 */
export function parseProgress(json: string): Progress | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  return normalize(raw);
}

function normalize(raw: unknown): Progress | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const unlockMask = o['unlockMask'];
  const wins = o['wins'];
  const kills = o['kills'];
  const eliteKills = o['eliteKills'];
  const silhouettes = o['silhouettes'];
  if (typeof unlockMask !== 'number' || !Number.isFinite(unlockMask)) return null;
  if (typeof wins !== 'number' || !Number.isFinite(wins)) return null;
  if (typeof kills !== 'number' || !Number.isFinite(kills)) return null;
  if (typeof eliteKills !== 'number' || !Number.isFinite(eliteKills)) return null;
  if (!Array.isArray(silhouettes) || silhouettes.some((s) => typeof s !== 'string')) return null;
  return {
    unlockMask: Math.floor(unlockMask) & FULL_MASK,
    wins: Math.floor(Math.max(0, wins)),
    kills: Math.floor(Math.max(0, kills)),
    eliteKills: Math.floor(Math.max(0, eliteKills)),
    silhouettes: capSilhouettes(silhouettes as string[]),
  };
}
