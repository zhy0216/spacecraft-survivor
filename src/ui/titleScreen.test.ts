/**
 * 标题界面的纯函数(不装 jsdom,与 ui/loadoutFlow.test.ts 同一条口径)。
 * 钉的是两句**给玩家看的话**,而它们各自守着一个不可逆的决定:
 * ① 存档摘要必须说清"继续的是什么"(尤其血量:接手一艘残血船而不自知是最坏的一种意外);
 * ② 「新航行」在有存档时必须把代价说出来 —— 二段确认的措辞里没有"放弃存档"四个字,
 *    这个二段确认就等于没有。
 */
import { describe, expect, it } from 'vitest';
import type { RunSaveDigest } from '../sim/runSave';
import { continueLineText, newRunLabel } from './titleScreen';

const DIGEST: RunSaveDigest = {
  elapsedSec: 754,
  segment: 2,
  segmentCount: 4,
  kills: 318,
  hp: 63.4,
  maxHp: 115,
};

describe('标题界面:存档摘要那一行', () => {
  it('四个读数齐全:航段 / 时长 / 击杀 / 船体', () => {
    const line = continueLineText(DIGEST);
    expect(line).toContain('3/4'); // segment 是下标,玩家读的是第几段
    expect(line).toContain('12:34'); // 754s
    expect(line).toContain('318');
    expect(line).toContain('63/115'); // 血量取整,分子分母都印
  });

  it('脚本走完(已进 Boss 战)时印全通,而不是印出一个比总段数还大的数', () => {
    expect(continueLineText({ ...DIGEST, segment: 4 })).toContain('4/4');
    expect(continueLineText({ ...DIGEST, segment: 4 })).not.toContain('5/4');
  });

  it('满血与空血都印得出来(整取不留小数)', () => {
    expect(continueLineText({ ...DIGEST, hp: 115, maxHp: 115 })).toContain('115/115');
    expect(continueLineText({ ...DIGEST, hp: 0.4, maxHp: 100 })).toContain('0/100');
  });
});

describe('标题界面:「新航行」的二段确认', () => {
  it('没有存档 = 没有代价,一句话直说', () => {
    expect(newRunLabel(false, false)).toBe('开始航行');
  });

  it('有存档时第一下只是问话,且措辞里点明"放弃存档"', () => {
    expect(newRunLabel(true, false)).toBe('开始新航行');
    expect(newRunLabel(true, true)).toContain('放弃存档');
  });

  it('没有存档时不会问出一句无意义的确认', () => {
    // hasSave = false 时无论 confirming 是什么,文案都不该冒出"放弃存档"
    expect(newRunLabel(false, true)).toBe('开始航行');
  });
});
