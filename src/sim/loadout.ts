/**
 * 起始装配表 → 甲板的薄接线层(10 号 issue T2)。
 * 逐条走 placeAt,因此边缘/内部、塔型与设施型的合法性仍只有 sim/deck 那一份;
 * 本模块不认识 World,也不把起手塔偷偷塞进 World 构造函数。
 */
import { STARTING_LOADOUT } from '../data/loadout';
import { type Deck, isPlaceSuccess, placeAt } from './deck';

export function applyStartingLoadout(deck: Deck): void {
  for (let i = 0; i < STARTING_LOADOUT.length; i++) {
    const entry = STARTING_LOADOUT[i]!;
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
      `起始装配被拒:下标 ${i},格 (${entry.col},${entry.row}),content ${entry.content},理由码 ${code}`,
    );
  }
}
