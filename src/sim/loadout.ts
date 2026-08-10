/**
 * 起始装配表 → 甲板的薄接线层(10 号 issue T2,20 号支持选配置)。
 * 逐条走 placeAt,因此边缘/内部、塔型与设施型的合法性仍只有 sim/deck 那一份;
 * 本模块不认识 World,也不把起手塔偷偷塞进 World 构造函数。
 *
 * 20 号:装配哪一套配置由调用方(开局选择界面)决定 —— 传 LOADOUTS 下标或整条定义均可;
 * 缺省 = 0(标准起手),于是既有调用方与单测的"无参 = 左右舷双机炮"语义原样成立。
 * 选择发生在 World 构造之前,装配本身对同一配置逐条确定 —— 同 seed + 同配置 → 同轨迹
 * (配置只通过甲板形状进入 sim,不移动任何 rng 消耗次数)。
 */
import { LOADOUTS, type LoadoutDef } from '../data/loadout';
import { type Deck, isPlaceSuccess, placeAt } from './deck';

export function applyStartingLoadout(deck: Deck, loadout: LoadoutDef | number = 0): void {
  const def = typeof loadout === 'number' ? LOADOUTS[loadout] : loadout;
  if (def === undefined) {
    // 下标越界也是数值表写坏的一类:报出来而不是静默开一局空甲板
    // (空甲板=没有起手塔,症状与"表里全被拒"一样难查)
    console.warn(`起始装配被拒:找不到配置 ${String(loadout)}`);
    return;
  }
  for (let i = 0; i < def.entries.length; i++) {
    const entry = def.entries[i]!;
    const code = placeAt(
      deck,
      entry.col,
      entry.row,
      entry.content,
      entry.towerType,
      entry.supportType,
    );
    if (isPlaceSuccess(code)) continue;
    // 数值表写坏时只跳过这一条,不让整局启动崩掉;但也绝不静默吞掉 —— 理由码与坐标留在控制台,
    // 否则症状只会是「开局少一门炮」,等到整局零掉落时才发现,离配置现场太远。
    console.warn(
      `起始装配被拒:配置 ${def.id},下标 ${i},格 (${entry.col},${entry.row}),content ${entry.content},理由码 ${code}`,
    );
  }
}
