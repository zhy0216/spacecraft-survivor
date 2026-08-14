import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { audioBus, killStreakPitch, masterVolume, upgradeBurstFamily } from './audio';

/**
 * Node 环境没有 AudioContext,用 stub 全局 AudioContext 的假实现验证:
 * 只做"有没有发声(节点创建/start 次数)""限流丢没丢""总线 gain 归零"这类状态断言,
 * 不碰真实的音频调度。
 */

/** audioBus 是单例,AudioContext 只建一次,故 mock 实例跨测试持久存在 */
let mock: MockAudioContext | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Param {
  value = 0;
  setValueAtTime(v: number) {
    this.value = v;
  }
  linearRampToValueAtTime(v: number) {
    this.value = v;
  }
  exponentialRampToValueAtTime(v: number) {
    this.value = v;
  }
  setTargetAtTime(v: number) {
    this.value = v;
  }
  cancelScheduledValues() {}
}

class MockNode {
  gain = new Param();
  frequency = new Param();
  Q = new Param();
  type = 'sine';
  buffer: unknown = null;
  loop = false;
  onended: (() => void) | null = null;
  connected: unknown[] = [];
  started = 0;
  stopped = 0;
  connect(n: unknown) {
    this.connected.push(n);
  }
  disconnect() {}
  start() {
    this.started++;
  }
  stop() {
    this.stopped++;
    this.onended?.();
  }
}

class MockAudioContext {
  static instances = 0;
  state = 'running';
  currentTime = 0;
  sampleRate = 48000;
  destination = new MockNode();
  gains: MockNode[] = [];
  nodes: MockNode[] = [];

  constructor() {
    MockAudioContext.instances++;
    mock = this;
  }

  private note(n: MockNode): void {
    this.nodes.push(n);
  }

  createGain() {
    const n = new MockNode();
    this.gains.push(n);
    this.note(n);
    return n;
  }

  createOscillator() {
    const n = new MockNode();
    this.note(n);
    return n;
  }

  createBufferSource() {
    const n = new MockNode();
    this.note(n);
    return n;
  }

  createBiquadFilter() {
    const n = new MockNode();
    this.note(n);
    return n;
  }

  createBuffer(channels: number, length: number, sampleRate: number) {
    return {
      length,
      sampleRate,
      numberOfChannels: channels,
      getChannelData: () => new Float32Array(length),
    };
  }

  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
}

/** 累计起过声的源节点数(振荡器/噪声源才算) */
const started = () => mock!.nodes.reduce((s, n) => s + n.started, 0);

describe('audioBus(无素材解码能力时的合成兜底)', () => {
  beforeEach(() => {
    vi.stubGlobal('AudioContext', MockAudioContext);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('API 齐备', () => {
    const names = [
      'resume',
      'setMuted',
      'setMasterVolume',
      'playShoot',
      'playKill',
      'playHurt',
      'playCollect',
      'playUpgrade',
      'playUpgradeBurst',
      'playPlace',
      'playEliteWarn',
      'playBossWarn',
      'playExplosion',
      'setAmbience',
    ];
    for (const n of names) {
      expect(typeof (audioBus as Record<string, unknown>)[n]).toBe('function');
    }
    expect(typeof masterVolume.value).toBe('number');
  });

  it('升星爆发音把基础/合成塔映射到正确武器家族', () => {
    expect([0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5].map((t) => upgradeBurstFamily(t))).toEqual([
      0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5,
    ]);
    expect(upgradeBurstFamily(999)).toBe(0);
  });

  it('import 时不创建 AudioContext,resume 后才懒建并激活', async () => {
    expect(MockAudioContext.instances).toBe(0);
    await audioBus.resume();
    expect(MockAudioContext.instances).toBe(1);
    expect(mock).not.toBeNull();
    expect(mock!.state).toBe('running');
  });

  it('开火音按家族分域发声,同家族 16ms 窗口内限流、跨家族互不干扰', async () => {
    await audioBus.resume();
    const before = started();
    audioBus.playShoot('ammo', 0);
    expect(started() - before).toBe(1);
    audioBus.playShoot('ammo', 1); // 同一窗口内,直接丢
    expect(started() - before).toBe(1);
    audioBus.playShoot('heat', 0); // 不同家族,不受 ammo 的窗口限制
    expect(started() - before).toBe(2);
    audioBus.playShoot('bogus', 0); // 未知家族退回 ammo,同样被限流
    expect(started() - before).toBe(2);
    await sleep(30); // 窗口过后恢复
    audioBus.playShoot('ammo', 0);
    expect(started() - before).toBe(3);
  });

  it('各发声方法都能出声且不抛错(每个至少起一个源)', async () => {
    await audioBus.resume();
    const calls: Array<() => void> = [
      () => audioBus.playKill(),
      () => audioBus.playHurt('hull'),
      () => audioBus.playHurt('spark'),
      () => audioBus.playCollect(),
      () => audioBus.playUpgrade(),
      () => audioBus.playUpgradeBurst(1, 2),
      () => audioBus.playPlace(),
      () => audioBus.playEliteWarn(),
      () => audioBus.playBossWarn(),
      () => audioBus.setAmbience(0.5),
    ];
    for (const c of calls) {
      const before = started();
      c();
      expect(started()).toBeGreaterThan(before);
    }
  });

  it('setMuted 把总线增益归零;静音时不再新建任何节点,再开恢复', async () => {
    await audioBus.resume();
    expect(mock!.gains[0]!.gain.value).toBe(1); // 默认未静音
    audioBus.setMuted(true);
    expect(mock!.gains[0]!.gain.value).toBe(0);
    const nodesBefore = mock!.nodes.length;
    audioBus.playKill();
    expect(mock!.nodes.length).toBe(nodesBefore); // 静音时跳过发声,零节点占用
    audioBus.setMuted(false);
    expect(mock!.gains[0]!.gain.value).toBe(1);
    await sleep(20); // 让出 kill 的限流窗口,保证这次真的发声
    const gainsBefore = mock!.gains.length;
    const startedBefore = started();
    audioBus.playKill();
    expect(mock!.gains.length).toBe(gainsBefore); // gain/filter 复用池不增长
    expect(started()).toBeGreaterThan(startedBefore); // 但源重新起声
  });

  it('无 decodeAudioData 时 setAmbience 仍用 ratio 驱动兜底底噪', async () => {
    await audioBus.resume();
    audioBus.setAmbience(1);
    const amb = mock!.gains[mock!.gains.length - 1]!;
    expect(amb.gain.value).toBeCloseTo(0.09 * masterVolume.value, 5);
    audioBus.setAmbience(0);
    expect(amb.gain.value).toBeCloseTo(0, 5);
  });

  it('setMasterVolume 夹取到 0..1', () => {
    audioBus.setMasterVolume(2);
    expect(masterVolume.value).toBe(1);
    audioBus.setMasterVolume(-1);
    expect(masterVolume.value).toBe(0);
    audioBus.setMasterVolume(0.8);
  });
});

describe('killStreakPitch(连杀音高,纯函数)', () => {
  it('第 1 层 = 基准音高(倍率 1),此后每层 +2 半音(×2^(2/12))', () => {
    const step = Math.pow(2, 2 / 12);
    expect(killStreakPitch(1)).toBeCloseTo(1, 12);
    expect(killStreakPitch(2)).toBeCloseTo(step, 12);
    expect(killStreakPitch(3)).toBeCloseTo(step * step, 12);
    expect(killStreakPitch(4)).toBeCloseTo(Math.pow(2, 6 / 12), 12);
  });

  it('封顶 +10 半音:第 6 层起不再爬(连杀声不嘶叫成警报)', () => {
    const cap = Math.pow(2, 10 / 12);
    expect(killStreakPitch(6)).toBeCloseTo(cap, 12);
    expect(killStreakPitch(20)).toBeCloseTo(cap, 12);
  });

  it('0/负数/NaN 退回基准音高(防御,不除 0)', () => {
    expect(killStreakPitch(0)).toBe(1);
    expect(killStreakPitch(-3)).toBe(1);
    expect(killStreakPitch(Number.NaN)).toBe(1);
  });
});
