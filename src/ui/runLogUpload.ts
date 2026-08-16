/**
 * 运行日志的上传适配层 —— ui 层,与 ui/runSaveStorage.ts 同一条边界:
 * 浏览器能力(fetch / localStorage)只在这里碰,sim/runLog.ts 一字不识网络。
 *
 * 生产后端是同源 Cloudflare Worker `/api/logs`,日志落到私有 R2 bucket,D1 只做月度
 * 数量/字节硬配额。本文件仍保留
 * localStorage 端点覆盖,方便本地分析器或临时环境接管上传 ——
 *   - submitRunLog(endpoint, payload):POST JSON、10 秒超时、2xx 才算成功;
 *   - localStorage(starwreck.logEndpoint.v1)有值时覆盖默认同源端点;
 *   - 负载格式(RunLogPayload)是**本文件对后端的承诺**,后端解析按 v 分派。
 *
 * 本地开发环境(localhost / 127.0.0.1)没有同源 Worker 可传:isLocalHost() 检出后,
 * 上传按钮改口「保存到本地」—— saveRunLogLocally() 把同一份负载落成 JSON 文件
 * (浏览器下载),本地分析器与将来的人工复盘吃的都是这份文件。
 *
 * 兜底口径与两份既有存储适配器一致:localStorage 不可用一律静默兜底 ——
 * 读端点失败 = 使用同源默认端点,写端点失败 = 不写(这次配置丢就丢了,
 * 调试配置不是玩家进度,不值得为它打断流程)。
 */
import type { RunLog } from '../sim/runLog';

/** 上传端点键(调试覆盖,不进设置存档) */
export const RUN_LOG_ENDPOINT_KEY = 'starwreck.logEndpoint.v1';

/** 漏存提醒的永久关闭键(见 ui/gameOver.ts 的「返回标题」守卫) */
export const RUN_LOG_REMIND_KEY = 'starwreck.runLogRemind.v1';

/** Cloudflare Worker 上的生产上传入口；同源部署不需要 CORS 或玩家配置。 */
export const DEFAULT_RUN_LOG_ENDPOINT = '/api/logs';

/** 上传请求的超时(ms):后端不回应就该有个了断,别让按钮永远停在"上传中…" */
export const UPLOAD_TIMEOUT_MS = 10000;

/**
 * 一份上传负载。**自洽**是硬要求:后端拿到它就能独立解析,不向客户端追问任何东西 ——
 * 事件时间线(log)与结局读数(summary 那一半)都在这一个对象里。
 * v 与 runLog 的 v 不是同一个数:这是**负载**的版本,升级格式(加字段/改形状)时 +1。
 */
export interface RunLogPayload {
  /** 负载结构版本(RUN_LOG_PAYLOAD_VERSION) */
  v: number;
  /** 产品标识,后端多游戏共用一个端点时按它分库 */
  game: string;
  /** 本局种子 */
  seed: number;
  /** 事件时间线(直接引用日志的 events;快照后不得再追加 —— 见 buildRunLogPayload) */
  events: RunLog['events'];
  /** 时间线是否断尾(RUN_LOG_MAX_EVENTS 触发过) */
  truncated: boolean;
  /** 结局读数:RESULT_*(sim/world.ts) */
  result: number;
  survivedSec: number;
  kills: number;
  eliteKills: number;
  segment: number;
  bossKilledAtSec: number;
  peakDps: number;
  weaponReport: { type: number; damage: number }[];
}

/** 负载结构版本(见 RunLogPayload.v) */
export const RUN_LOG_PAYLOAD_VERSION = 1;

/** 产品标识(见 RunLogPayload.game) */
export const RUN_LOG_GAME_ID = 'starwreck';

/** 负载的结局读数那一半,由调用方(main.ts 的 onGameOver)从世界现摘 */
export interface RunLogMeta {
  result: number;
  survivedSec: number;
  kills: number;
  eliteKills: number;
  segment: number;
  bossKilledAtSec: number;
  peakDps: number;
  weaponReport: { type: number; damage: number }[];
}

/**
 * 从一卷日志 + 结局读数拼出上传负载。**浅拷贝 events 引用而不是逐条复制**:负载是在
 * 局终那一刻(世界已冻、日志不再追加)构建并立刻序列化的快照,复制上千条事件只白花一次
 * 一局一次的分配;契约是"构建后不得再动那卷日志",与结算界面的 summary 同一条"局终摘数"口径。
 */
export function buildRunLogPayload(log: RunLog, meta: RunLogMeta): RunLogPayload {
  return {
    v: RUN_LOG_PAYLOAD_VERSION,
    game: RUN_LOG_GAME_ID,
    seed: log.seed,
    events: log.events,
    truncated: log.truncated,
    ...meta,
  };
}

/** 读上传端点。调试覆盖缺失 / localStorage 不可用时使用同源 Cloudflare API。 */
export function getLogEndpoint(): string {
  try {
    return localStorage.getItem(RUN_LOG_ENDPOINT_KEY) || DEFAULT_RUN_LOG_ENDPOINT;
  } catch {
    return DEFAULT_RUN_LOG_ENDPOINT;
  }
}

/** 写上传端点(调试配置;失败静默,理由见文件头) */
export function setLogEndpoint(url: string): void {
  try {
    localStorage.setItem(RUN_LOG_ENDPOINT_KEY, url);
  } catch {
    // 静默失败:见文件头兜底口径
  }
}

/** 玩家是否永久关掉了「日志还没保存」的漏存提醒。localStorage 不可用一律视为没关(照常提醒)。 */
export function isRunLogRemindDismissed(): boolean {
  try {
    return localStorage.getItem(RUN_LOG_REMIND_KEY) === 'off';
  } catch {
    return false;
  }
}

/** 永久关闭漏存提醒(写失败静默:这次偏好丢就丢了,不值得打断流程,见文件头兜底口径) */
export function dismissRunLogRemind(): void {
  try {
    localStorage.setItem(RUN_LOG_REMIND_KEY, 'off');
  } catch {
    // 静默失败:见文件头兜底口径
  }
}

/**
 * 把负载 POST 到端点。**后端契约(待讨论后落地)**:JSON body、Content-Type: application/json、
 * 2xx 一律算成功。超时与网络错误都归成 false —— 上传的失败不值得分类,按钮上只需一句话。
 * @returns true = 后端 2xx;false = 超时 / 网络错误 / 非 2xx
 */
export async function submitRunLog(endpoint: string, payload: RunLogPayload): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

/** 本地回环主机名(localhost / IPv4 / IPv6 环回)。Node 测试环境没有 location,一律不算本地。 */
export function isLocalHost(): boolean {
  try {
    const host = location.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}

/**
 * 把负载落成本地 JSON 文件(浏览器下载)。本地开发没有同源 Worker,「上传」改为保存:
 * 文件名带种子与墙钟时间戳,连续存几局不会互相覆盖。下载失败(浏览器不让动 Blob/URL)
 * 归成 false —— 与 submitRunLog 同一条口径:按钮上只需一句话,失败不值得分类。
 */
export function saveRunLogLocally(payload: RunLogPayload): boolean {
  try {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${RUN_LOG_GAME_ID}-seed${payload.seed}-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  } catch {
    return false;
  }
}
