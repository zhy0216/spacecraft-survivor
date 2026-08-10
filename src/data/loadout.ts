/**
 * 起手配置表(10 号 issue T2 + 20 号 issue,改版设计会重写)——「这一局怎么开场」是数值数据。
 * data 层永不反向 import sim;真正落子仍由 sim/loadout.ts 逐条写进武器/支援槽,规则与普通获取只有一份。
 *
 * 甲板删除后,起手配置从"在 3×4 甲板上放塔"改为"开局占几个武器槽/支援槽":
 *   weapons = 开局直接持有的武器型列表(每项填一个武器槽,等级 1);
 *   supports = 开局直接持有的支援型列表(每项填一个支援槽,可重复 = 叠效)。
 * 槽位上限(WEAPON_SLOT_COUNT=4 / SUPPORT_SLOT_COUNT=4)在 sim/config.ts 或 world 常量里,
 * 本表只负责"这一局怎么开场",不校验槽位(loadout.test 钉着"必须装得下")。
 *
 * 20 号口径保留:**下标即编号且只增不改**(main.ts 的 loadoutIndex 与 UNLOCKS 条目的 type
 * 都按下标咬合);门禁不在这里声明(由 UNLOCKS 表 kind=UNLOCK_LOADOUT 决定);
 * 确定性口径保留:起手配置是**开跑前输入**,applyStartingLoadout 对同一配置逐条确定性,
 * 同 seed + 同配置 → 同一条轨迹(配置只通过槽位/武器状态进入 sim,不移动 rng 消耗次数)。
 */
import { SUP_AMMO_BAY } from './supports';
import {
  TOWER_ARC,
  TOWER_AUTOCANNON,
  TOWER_LASER,
  TOWER_MORTAR,
  TOWER_RAILGUN,
} from './towers';

export interface LoadoutDef {
  /** 唯一 id;UNLOCKS 条目靠它解释 type 下标之外还可人工对照,永不作为判定依据 */
  id: string;
  /** 卡片标题(图鉴/解锁 toast 读 UNLOCKS 表那份同名文案,两处必须一致) */
  name: string;
  /** 一句话风味说明,卡片上直接印 */
  desc: string;
  /** 开局直接持有的武器型列表(每项填一个武器槽,Lv1)。必须能装进 4 个武器槽 */
  weapons: number[];
  /** 开局直接持有的支援型列表(每项填一个支援槽,重复 = 叠效)。必须能装进 4 个支援槽 */
  supports: number[];
}

/** 下标 === 配置编号,与 LOADOUTS 一一对应;UNLOCKS 的 type 引的就是它。只增不改 */
export const LOADOUT_STANDARD = 0; // 标准起手:永远可用
export const LOADOUT_ARC = 1; // 弧光开局:永远可用
export const LOADOUT_BOMBARD = 2; // 炮击开局:累计精英击杀 5 解锁(unlocks.ts)
export const LOADOUT_SNIPER = 3; // 狙击开局:单局击杀 150 解锁(unlocks.ts)
export const LOADOUT_COUNT = 4;

/**
 * 四条起手配置。武器/支援都落在全新空槽上,全部能一次装下(loadout.test 钉着)。
 *
 * 0. 标准起手 —— 与旧"左右舷各一门自动机炮"逐字节等价:双自动机炮 + 弹药库。
 *    旧档(以及任何依赖默认行为的调用方)读到的就是它:applyStartingLoadout(loadout) 恒指 0。
 * 1. 弧光开局 —— 激光 + 电弧:两条过热系,斜对角铺开(旧版角落射界优势由槽位均权取代)。
 * 2. 炮击开局 —— 双迫击炮:520 射程落点 AoE 前后开花。
 * 3. 狙击开局 —— 双磁轨炮:700 射程贯穿线,开局就是斩首配置。
 */
export const LOADOUTS: LoadoutDef[] = [
  {
    id: 'standard',
    name: '标准起手',
    desc: '双自动机炮 + 弹药库:弹药系万金油,开局即有两道中弧射界的均衡火力',
    weapons: [TOWER_AUTOCANNON, TOWER_AUTOCANNON],
    supports: [SUP_AMMO_BAY],
  },
  {
    id: 'arc',
    name: '弧光开局',
    desc: '激光棱镜与电弧塔各一座:两条过热系斜向铺开,电弧清群、激光融精英',
    weapons: [TOWER_LASER, TOWER_ARC],
    supports: [SUP_AMMO_BAY],
  },
  {
    id: 'bombard',
    name: '炮击开局',
    desc: '双等离子迫击炮沿中轴排开:520 射程的落点 AoE 前后开花,代价是 3 秒充能节奏',
    weapons: [TOWER_MORTAR, TOWER_MORTAR],
    supports: [SUP_AMMO_BAY],
  },
  {
    id: 'sniper',
    name: '狙击开局',
    desc: '双磁轨炮并踞:700 射程贯穿线,开局就是斩首配置',
    weapons: [TOWER_RAILGUN, TOWER_RAILGUN],
    supports: [SUP_AMMO_BAY],
  },
];
