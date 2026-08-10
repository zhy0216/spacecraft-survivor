/**
 * 起手配置表(10 号 issue T2 + 20 号 issue)——「这一局怎么开场」是数值数据,不属于 World 构造逻辑。
 * data 层永不反向 import sim,故 content 用与 sim/deck.CELL_WEAPON 对齐的稳定数据码 1;
 * 真正落子仍由 sim/loadout.ts 逐条走 placeAt,规则与普通放置只有一份。
 *
 * 20 号起,固定单表 STARTING_LOADOUT 升级为多配置 LOADOUTS(GDD §10「起手配置:解锁的船体与
 * 初始塔组合可在开局选择」—— 本表先做"初始塔组合"半边,船体另论):
 *   - 每条配置 = { id, name, desc, entries },id 供 UNLOCKS 条目人工对照、entries 与旧表同形状;
 *   - **下标即编号且只增不改**:main.ts 的 loadoutIndex 与 UNLOCKS 条目的 type 都按下标咬合,
 *     重排/删改会让旧档位的解锁掩码指到另一套配置(与 UNLOCKS 的位掩码同一条稳定性纪律);
 *   - 门禁不在这里声明:一条配置"要不要解锁"由 UNLOCKS 表里 kind=UNLOCK_LOADOUT 且 type=下标
 *     的那一条决定,本表不 import unlocks(那会与 unlocks → towers 的依赖方向打架)。
 *     判定与条件文案在 ui/loadoutFlow.ts(唯一同时读两张表的下游)。
 *
 * 确定性口径(与 seed 同一条):起手配置是**开跑前输入**,选择发生在 World 构造之前,
 * applyStartingLoadout 对同一配置是逐条确定性的 —— 同 seed + 同配置 → 同一条轨迹;
 * 配置差异只通过甲板形状进入 sim(多一门炮 = 多一次开火),不移动任何 rng 消耗次数。
 */
import { SUP_AMMO_BAY } from './supports';
import {
  TOWER_ARC,
  TOWER_AUTOCANNON,
  TOWER_LASER,
  TOWER_MORTAR,
  TOWER_RAILGUN,
} from './towers';

export interface LoadoutEntry {
  col: number;
  row: number;
  /** 与 sim/deck.CELL_* 对齐;data 层不能反向 import sim */
  content: number;
  towerType: number;
  supportType: number;
}

export interface LoadoutDef {
  /** 唯一 id;UNLOCKS 条目靠它解释 type 下标之外还可人工对照,永不作为判定依据 */
  id: string;
  /** 卡片标题(图鉴/解锁 toast 读 UNLOCKS 表那份同名文案,两处必须一致) */
  name: string;
  /** 一句话风味说明,卡片上直接印 */
  desc: string;
  /** 逐条经 placeAt 落地;所有条目必须能在全新 3×4 甲板上一次放完(loadout.test 钉着) */
  entries: LoadoutEntry[];
}

/** 下标 === 配置编号,与 LOADOUTS 一一对应;UNLOCKS 的 type 引的就是它。只增不改 */
export const LOADOUT_STANDARD = 0; // 标准起手:永远可用
export const LOADOUT_ARC = 1; // 弧光开局:永远可用
export const LOADOUT_BOMBARD = 2; // 炮击开局:累计精英击杀 5 解锁(unlocks.ts)
export const LOADOUT_SNIPER = 3; // 狙击开局:单局击杀 150 解锁(unlocks.ts)
export const LOADOUT_COUNT = 4;

/**
 * 四条起手配置。全部条目都落在全新 3×4 甲板的合法格上(武器一律边缘格,GDD §4.1);
 * 角落格射界 +60°(sim/arc.ts 叠的那层)是刻意选角:谁站角落,谁的开局射界就宽一档。
 *
 * 0. 标准起手 —— 与旧 STARTING_LOADOUT 逐字节相同:左右舷各一门自动机炮。
 *    旧档(以及任何依赖默认行为的调用方)读到的就是它:applyStartingLoadout(deck) 恒指 0。
 * 1. 弧光开局 —— 激光(船艏左舷角)+ 电弧(船艉右舷角):两条过热系,斜对角铺开。
 * 2. 炮击开局 —— 双迫击炮一艏一艉沿中轴线排开:520 射程落点 AoE 前后开花。
 * 3. 狙击开局 —— 双磁轨炮并踞船艏两角:700 射程贯穿线,角落把 30° 极窄弧加宽到 90°。
 */
export const LOADOUTS: LoadoutDef[] = [
  {
    id: 'standard',
    name: '标准起手',
    desc: '左右舷各一门自动机炮:弹药系万金油,开局即有两道中弧射界的均衡火力',
    entries: [
      { col: 0, row: 1, content: 1, towerType: TOWER_AUTOCANNON, supportType: SUP_AMMO_BAY },
      { col: 2, row: 1, content: 1, towerType: TOWER_AUTOCANNON, supportType: SUP_AMMO_BAY },
    ],
  },
  {
    id: 'arc',
    name: '弧光开局',
    desc: '激光棱镜与电弧塔分踞船艏左舷、船艉右舷两角:角落射界 +60°,开局即铺开两条斜向火力带',
    entries: [
      { col: 0, row: 0, content: 1, towerType: TOWER_LASER, supportType: SUP_AMMO_BAY },
      { col: 2, row: 3, content: 1, towerType: TOWER_ARC, supportType: SUP_AMMO_BAY },
    ],
  },
  {
    id: 'bombard',
    name: '炮击开局',
    desc: '双等离子迫击炮一艏一艉沿中轴排开:520 射程的落点 AoE 前后开花,代价是 3 秒充能节奏',
    entries: [
      { col: 1, row: 0, content: 1, towerType: TOWER_MORTAR, supportType: SUP_AMMO_BAY },
      { col: 1, row: 3, content: 1, towerType: TOWER_MORTAR, supportType: SUP_AMMO_BAY },
    ],
  },
  {
    id: 'sniper',
    name: '狙击开局',
    desc: '双磁轨炮并踞船艏两角:700 射程贯穿线,角落把极窄弧加宽到 90°,开局就是斩首配置',
    entries: [
      { col: 0, row: 0, content: 1, towerType: TOWER_RAILGUN, supportType: SUP_AMMO_BAY },
      { col: 2, row: 0, content: 1, towerType: TOWER_RAILGUN, supportType: SUP_AMMO_BAY },
    ],
  },
];
