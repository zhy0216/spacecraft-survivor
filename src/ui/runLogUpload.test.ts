/**
 * 上传适配层里能脱开浏览器的部分:负载构建与端点兜底。
 * fetch/localStorage 本体不在这里测(与 runSaveStorage 同一条理由:Node 里没有 localStorage,
 * 测试只覆盖纯函数与"不可用时静默兜底"这两半)。
 * 负载形状是**本文件对后端的承诺**(runLogUpload.ts 文件头)—— 后端落地前,
 * 这份测试就是那份承诺的白纸黑字:字段改名/加字段不 bump 版本,后端解析当场就炸。
 */
import { describe, expect, it } from 'vitest';
import { createRunLog, logEvent, type RunLog } from '../sim/runLog';
import {
  buildRunLogPayload,
  getLogEndpoint,
  RUN_LOG_GAME_ID,
  RUN_LOG_PAYLOAD_VERSION,
  setLogEndpoint,
  type RunLogMeta,
} from './runLogUpload';

function meta(over: Partial<RunLogMeta> = {}): RunLogMeta {
  return {
    result: 1,
    survivedSec: 550,
    kills: 1234,
    eliteKills: 7,
    segment: 4,
    bossKilledAtSec: 550,
    peakDps: 88.5,
    weaponReport: [{ type: 0, damage: 900 }],
    ...over,
  };
}

describe('buildRunLogPayload(负载 = 本文件对后端的承诺)', () => {
  it('自洽:版本/游戏标识/种子/时间线/截断位 + 结局读数全在一个对象里', () => {
    const log: RunLog = createRunLog(42);
    logEvent(log, { k: 'upgradeSkip', t: 3 });
    const payload = buildRunLogPayload(log, meta());
    expect(payload.v).toBe(RUN_LOG_PAYLOAD_VERSION);
    expect(payload.game).toBe(RUN_LOG_GAME_ID);
    expect(payload.seed).toBe(42);
    expect(payload.events).toBe(log.events); // 浅引用:局终那一刻世界已冻,不再追加
    expect(payload.truncated).toBe(false);
    expect(payload.result).toBe(1);
    expect(payload.kills).toBe(1234);
    expect(payload.peakDps).toBe(88.5);
    expect(payload.weaponReport).toEqual([{ type: 0, damage: 900 }]);
  });

  it('截断位原样透传:后端该在报表上打截断标,而不是拿着断尾时间线当全量', () => {
    const log = createRunLog(1);
    log.truncated = true;
    expect(buildRunLogPayload(log, meta()).truncated).toBe(true);
  });
});

describe('端点存储(浏览器不可用时静默兜底)', () => {
  it('Node 里没有 localStorage:读 = null(未配置)、写不炸', () => {
    expect(getLogEndpoint()).toBeNull();
    expect(() => setLogEndpoint('http://example.test/logs')).not.toThrow();
  });
});
