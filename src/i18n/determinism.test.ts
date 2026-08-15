/**
 * 跨语言确定性回归(10 号质量门):同 seed、同输入,zh-CN 与 en 下世界必须逐帧同轨迹。
 *
 * 这测的不是"World 写得对不对"(那由 world/runSave 的既有测试负责),而是"语言有没有
 * 渗进 sim"。如果哪天有人把一句 t() 挪进 sim/ 或 data/,同 seed 两种语言会当场分叉 ——
 * 本测试在**语言已确实切换**(用 t() 值断言语言生效)的前提下跑同一段脚本,比对
 * checksum 序列、capture/restore digest 与快照 JSON,任何一处不一致都直接失败。
 */
import { describe, expect, it } from 'vitest';
import { applyRandomStart } from '../sim/loadout';
import { captureRun, digestRunSnapshot, serializeRunSnapshot } from '../sim/runSave';
import type { ShipCommand } from '../sim/ship';
import { World } from '../sim/world';
import { changeLocale, currentLocale, initI18n, t } from './index';

const SEED = 20260801;

/** 同一段确定性输入序列:折线转向 + 周期加速(照 runSave.test 的 runTo 口径,不掷任何随机)。 */
function runSteps(world: World, frames: number): void {
  const cmd: ShipCommand = { desiredHeading: { x: 1, y: 0 }, boost: false };
  for (let i = 0; i < frames; i++) {
    const a = (i / 90) * Math.PI * 0.5;
    cmd.desiredHeading = { x: Math.cos(a), y: Math.sin(a) };
    cmd.boost = i % 300 === 0;
    world.step(cmd);
  }
}

function runOneLocale(): { checksums: string[]; digest: ReturnType<typeof digestRunSnapshot>; json: string } {
  const world = new World(SEED);
  applyRandomStart(world);
  const checksums: string[] = [];
  for (let i = 0; i < 10; i++) {
    runSteps(world, 60);
    checksums.push(world.checksum());
  }
  const snap = captureRun(world, { seed: SEED });
  return {
    checksums,
    digest: digestRunSnapshot(snap),
    json: serializeRunSnapshot(snap),
  };
}

describe('10 号门禁:跨语言确定性', () => {
  it('语言确实切换了(zh 与 en 的翻译值不同,测试不是空跑)', async () => {
    await initI18n('zh-CN');
    expect(t('common:confirm')).toBe('确认');
    await changeLocale('en');
    expect(currentLocale()).toBe('en');
    expect(t('common:confirm')).toBe('Confirm');
  });

  it('同 seed 同输入:zh-CN 与 en 下 checksum 序列、digest、快照 JSON 完全一致', async () => {
    await initI18n('zh-CN');
    const zh = runOneLocale();

    await changeLocale('en');
    expect(currentLocale()).toBe('en');
    const en = runOneLocale();

    expect(en.checksums).toEqual(zh.checksums);
    expect(en.digest).toEqual(zh.digest);
    expect(en.json).toBe(zh.json);
  });

  it('快照 JSON 里没有任何语言痕迹(字段名不含 language/locale)', () => {
    const { json } = runOneLocale();
    expect(json).not.toMatch(/"language"/);
    expect(json).not.toMatch(/"locale"/);
  });
});
