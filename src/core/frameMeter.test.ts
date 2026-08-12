/**
 * 帧率读数的三条要害:平均会磨平卡顿(所以要单独的最差帧)、最差帧要能滚出窗口
 * (否则一次卡顿会永远挂在面板上)、时间断点不算掉帧(切标签页回来不该报 30000ms)。
 */
import { describe, expect, it } from 'vitest';
import { FRAME_SPIKE_MS, FrameMeter } from './frameMeter';

/** 60fps 的一帧 */
const F60 = 1000 / 60;

/** 喂 n 帧同样长度的帧 */
function feed(meter: FrameMeter, ms: number, n: number): void {
  for (let i = 0; i < n; i++) meter.push(ms);
}

describe('FrameMeter', () => {
  it('稳定 60fps:三个读数都对得上(帧率 60 / 帧时 16.7 / 最差帧就是那一帧)', () => {
    const meter = new FrameMeter();
    feed(meter, F60, 120); // 两秒,足够把窗口填满并滚过一轮

    expect(meter.fps).toBeCloseTo(60, 6);
    expect(meter.frameMs).toBeCloseTo(F60, 6);
    expect(meter.worstMs).toBeCloseTo(F60, 6);
  });

  it('一记 50ms 卡顿:平均帧率几乎看不出来,最差帧当场跳到 50', () => {
    const meter = new FrameMeter();
    feed(meter, F60, 120);
    meter.push(50);

    // 平均值只掉两帧上下 —— 这正是"光看 fps 读不出掉帧"的量化说明
    expect(meter.fps).toBeGreaterThan(57);
    expect(meter.fps).toBeLessThan(60);
    expect(meter.worstMs).toBe(50);
  });

  it('卡顿滚出窗口后最差帧回落(不会一直挂着上一秒的账)', () => {
    const meter = new FrameMeter();
    feed(meter, F60, 120);
    meter.push(50);
    expect(meter.worstMs).toBe(50);

    feed(meter, F60, 120); // 又两秒好帧:那一记卡顿早已滚出 1 秒窗
    expect(meter.worstMs).toBeCloseTo(F60, 6);
  });

  it('窗口只留最近约 1 秒:更早的帧不再参与平均', () => {
    const meter = new FrameMeter();
    feed(meter, 50, 40); // 先两秒的 20fps
    feed(meter, F60, 120); // 再两秒的 60fps

    // 若窗口没滚,平均会被前半段拖到 30fps 上下
    expect(meter.fps).toBeCloseTo(60, 6);
  });

  it('时间断点(切标签页回来)整窗作废,不算成一次超级掉帧', () => {
    const meter = new FrameMeter();
    feed(meter, F60, 120);
    meter.push(FRAME_SPIKE_MS + 1);

    expect(meter.worstMs).toBe(0);
    expect(meter.fps).toBe(0);
    expect(meter.frameMs).toBe(0);

    // 断点之后照常重新攒读数
    feed(meter, F60, 120);
    expect(meter.fps).toBeCloseTo(60, 6);
  });

  it('非正/非数样本只丢自己,不作废窗口', () => {
    const meter = new FrameMeter();
    feed(meter, F60, 120);
    const before = meter.fps;

    meter.push(0);
    meter.push(-5);
    meter.push(Number.NaN);

    expect(meter.fps).toBe(before);
    expect(meter.worstMs).toBeCloseTo(F60, 6);
  });

  it('容量封顶不越界:2000fps 也照样算得出读数(窗口自己变短)', () => {
    const meter = new FrameMeter();
    feed(meter, 0.5, 5000); // 远超 512 的缓冲容量

    expect(meter.fps).toBeCloseTo(2000, 6);
    expect(meter.worstMs).toBe(0.5);
  });

  it('单帧长过窗口时窗口不清空(300ms 一帧要报 3.3fps,不是 0)', () => {
    const meter = new FrameMeter();
    feed(meter, 300, 5);

    expect(meter.fps).toBeCloseTo(1000 / 300, 6);
    expect(meter.worstMs).toBe(300);
  });
});
