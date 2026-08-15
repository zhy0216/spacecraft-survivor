/**
 * 运行日志的上传适配层 —— ui 层,与 ui/runSaveStorage.ts 同一条边界:
 * 浏览器能力(fetch / localStorage)只在这里碰,sim/runLog.ts 一字不识网络。
 *
 * 上传后端**尚未定案**(讨论后接):本文件把接缝先钉死,后端落地只换端点这一件事 ——
 *   - submitRunLog(endpoint, payload):POST JSON、10 秒超时、2xx 才算成功;
 *   - 端点存在 localStorage(starwreck.logEndpoint.v1),未配置 = 上传功能整条关闭;
 *   - 负载格式(RunLogPayload)是**本文件对后端的承诺**,后端解析按 v 分派。
 * 于是客户端这一侧的上传流程(按钮/状态/失败提示)今天就能做完并被测住,
 * 后端怎么写不阻塞它。
 *
 * 兜底口径与两份既有存储适配器一致:localStorage 不可用一律静默兜底 ——
 * 读端点失败 = 没有端点(按钮报"未配置上传地址"),写端点失败 = 不写(这次配置丢就丢了,
 * 调试配置不是玩家进度,不值得为它打断流程)。
 */
import type { RunLog } from '../sim/runLog';

/** 上传端点键(调试配置,不进设置存档 —— 后端定案前它只属于"想试上传的人") */
export const RUN_LOG_ENDPOINT_KEY = 'starwreck.logEndpoint.v1';

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

/** 读上传端点。没有 / localStorage 不可用 = null(上传功能整条关闭) */
export function getLogEndpoint(): string | null {
  try {
    return localStorage.getItem(RUN_LOG_ENDPOINT_KEY);
  } catch {
    return null;
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
