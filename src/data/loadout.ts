/**
 * 起始装配表(10 号 issue T2)——「这一局怎么开场」是数值数据,不属于 World 构造逻辑。
 * data 层永不反向 import sim,故 content 用与 sim/deck.CELL_WEAPON 对齐的稳定数据码 1;
 * 真正落子仍由 sim/loadout.ts 逐条走 placeAt,规则与普通放置只有一份。
 */
import { SUP_AMMO_BAY } from './supports';
import { TOWER_AUTOCANNON } from './towers';

export interface LoadoutEntry {
  col: number;
  row: number;
  /** 与 sim/deck.CELL_* 对齐;data 层不能反向 import sim */
  content: number;
  towerType: number;
  supportType: number;
}

/**
 * M0 的固定舷位起手塔:左右舷各一门自动机炮。
 * 不塞进 World 构造函数 —— 大量规则单测需要一块全空甲板;正式开局由 main.ts 显式套用本表。
 */
export const STARTING_LOADOUT: LoadoutEntry[] = [
  { col: 0, row: 1, content: 1, towerType: TOWER_AUTOCANNON, supportType: SUP_AMMO_BAY },
  { col: 2, row: 1, content: 1, towerType: TOWER_AUTOCANNON, supportType: SUP_AMMO_BAY },
];
