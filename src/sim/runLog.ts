/**
 * 一局的运行日志 —— 纯逻辑层,**永不 import pixi/DOM**,与 sim 其余部分同一条铁律。
 *
 * 目的:局末把「这一局到底发生了什么」做成一份可上传的遥测,给平衡调参与 bug 复现当原料。
 * 事件是**纯追加**(append-only)的时间线,与 runDamageByType / peakDps 同一条口径:
 * **只写不读、不进 checksum、不影响确定性** —— 任何一处 logEvent 都不得读回日志内容做判定,
 * 日志只是世界这台机器旁边的一卷记录纸。
 *
 * 事件粒度(谁说了算):击杀逐只记(kind + 是否精英 —— 平衡分析最值钱的一列)、
 * 升级/重摇/跳过/商店购买逐笔记(玩家决策链)、跨段与 Boss 记转折点、受击记船体损伤、
 * 首帧记起手配装、末帧记胜负。逐帧状态不记 —— 那不是"日志",那是录像,而录像的受众
 * 是回放系统,不是遥测。
 *
 * 容量:一局 8–10 分钟,击杀是绝对大头(千级),升级/商店是几十级。RUN_LOG_MAX_EVENTS 是
 * 保险丝不是日常量 —— 满额后**停止追加并置 truncated 位**,不回绕、不驱逐旧事件:
 * 时间线宁可断尾也不许中间掏洞。上传端据此只提示"截断了",不静默丢数据。
 *
 * 时间戳统一取 world.elapsed(秒),logEvent 内夹到百分位(1/100s):百分位以下的差值是
 * 显示噪音,不夹的话同一份 JSON 里 60Hz 步长的小数尾差会让两份"一模一样的局"diff 出几百处。
 *
 * 与局内存档(sim/runSave.ts)的关系:**日志不进存档**。读档续打时,日志从读档点重新起记
 * (上半局的日志只存在于那份已经离开页面的会话里)—— 上传的是"本会话这场仗",而存档要的是
 * "世界状态";把整卷日志塞进快照会让存档体积翻倍,换不来任何玩法价值。
 */

/** 日志结构版本(与 runSave 的 v 同一条"版本进结构"口径:后端解析按它分派) */
export const RUN_LOG_VERSION = 1;

/** 事件数上限(保险丝,见文件头)。击杀千级 + 决策几十级,8192 足够两倍余量 */
export const RUN_LOG_MAX_EVENTS = 8192;

/** 商店购买行为码(shop 事件的 act 字段,后端可读文案由它查表) */
export const SHOP_ACT_WEAPON = 0;
export const SHOP_ACT_EDICT = 1;
export const SHOP_ACT_REPAIR = 2;
export const SHOP_ACT_REFRESH = 3;

/**
 * 一条日志事件。k 是判别位,其余字段按 k 各取所需;t 恒为事件发生的 world.elapsed 秒。
 * 键名刻意用短键(telemetry 不是给人肉读的,体积按字节算),但值保持可读编码
 * (kind/act 传枚举码而非英文串,后端查表即得文案 —— 枚举码不随文案改名而漂移)。
 */
export type RunLogEvent =
  /** 本局开跑(step 的第一帧):weapons = 8 个武器槽的塔型(空槽 -1),起手配装快照 */
  | { k: 'start'; t: number; weapons: number[] }
  /** 一只敌人被回收(reap):kind = KIND_*,elite = 是否带词缀(Boss 另记 boss 事件) */
  | { k: 'kill'; t: number; kind: number; elite: boolean }
  /** Boss 被击杀(bossPhase 翻 2 的那一帧,与胜利判定同一条"回收那一帧记账"的口径) */
  | { k: 'boss'; t: number }
  /** 结算一张升级卡:kind = OFFER_*(upgrade.ts),type = 武器/法令型,slot = 替换槽(-1 = 无) */
  | { k: 'upgrade'; t: number; kind: number; type: number; slot: number }
  /** 跳过当前升级(照样消费一次升级曲线) */
  | { k: 'upgradeSkip'; t: number }
  /** 重摇当前三选一(扣星币的那一次成功重掷) */
  | { k: 'reroll'; t: number }
  /** 船坞商店成交:act = SHOP_ACT_*,type = 买下的武器/法令型(修复/刷新为 0) */
  | { k: 'shop'; t: number; act: number; type: number }
  /** 航段跨过边界(与补给信标同帧):index = 新航段下标(0-based) */
  | { k: 'segment'; t: number; index: number }
  /** 玩家接上补给信标、整备面板打开 */
  | { k: 'refit'; t: number }
  /** 船体挨了一记(actual 结算后的扣血量) */
  | { k: 'shipHit'; t: number; damage: number }
  /** 船体 HP 归零 */
  | { k: 'shipDestroyed'; t: number }
  /** 局终结论落定:result = RESULT_*(world.ts) */
  | { k: 'gameOver'; t: number; result: number };

/** 一卷日志。events 只由 logEvent 追加(调用方不得直接 push,容量闸门只在那一处) */
export interface RunLog {
  /** RUN_LOG_VERSION。版本进结构:后端按它分派解析,键名不带版本 */
  v: number;
  /** 本局种子(自洽负载:后端拿到它就知道是哪一条随机序列) */
  seed: number;
  events: RunLogEvent[];
  /** 容量闸门触发过没有(见文件头):true = 时间线断尾,后端该在报表上打截断标 */
  truncated: boolean;
}

/**
 * 建一卷空日志。seed 记进日志本体而不是等上传端从别处凑:一份上传负载必须是自洽的,
 * 后端拿到它就知道是哪一份随机序列,不必再向客户端追问种子。
 */
export function createRunLog(seed: number): RunLog {
  return { v: RUN_LOG_VERSION, seed, events: [], truncated: false };
}

/**
 * 追加一个事件。唯一的写入口:容量闸门在这里统一拦,调用方不必各自判。
 * t 夹到百分位(理由见文件头);事件对象由调用方现造,入卷后归日志所有,调用方不得再改。
 */
export function logEvent(log: RunLog, event: RunLogEvent): void {
  if (log.truncated) return;
  if (log.events.length >= RUN_LOG_MAX_EVENTS) {
    log.truncated = true;
    return;
  }
  event.t = Math.round(event.t * 100) / 100;
  log.events.push(event);
}
