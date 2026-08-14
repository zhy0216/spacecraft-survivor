/**
 * 随机开局装配(起手配置系统删除后的替身)—— 纯逻辑,永不 import pixi/DOM。
 *
 * 改版口径(用户设计会):开局不再弹「起手配置四选一」,改为**随机**落下两座基础塔:
 *   塔型从六种基础武器(机炮/激光/电弧/磁轨/点防/迫击炮,data/towers.ts 0..5)里随机;
 *   槽位从 8 个武器槽里**无放回**随机抽两个 —— "位置也随机"由此成立。
 * 不再授予任何起手法令:开局火力就是两门 1★ 炮,法令一律走局内获取。
 *
 * 随机数一律走 world.rng —— 同一 seed 两次开跑,起手完全一致(与波次、卡池同一条
 * mulberry32 序列)。起手落在 World 构造之后、第一次 step 之前;与旧口径「起手是开跑前
 * 输入、不移动 rng 消耗次数」不同:随机起手**消耗 rng**,但这不破坏确定性 ——
 * 同 seed 的消耗顺序逐帧一致;读档则槽位与 rng 游标都已存下,根本不需要重放起手。
 *
 * 装配只做"填槽 + 初始化节流状态"这一件事,不触发三合一升星 —— 起手是一次性输入,
 * 语义上不是"获得"(旧 loadout.test 的同一条钉法:起手给 2 把同型武器 = 两个 1★ 槽,
 * 不该当场合 2★)。
 */
import {
  TOWER_ARC,
  TOWER_AUTOCANNON,
  TOWER_LASER,
  TOWER_MORTAR,
  TOWER_PD,
  TOWER_RAILGUN,
  TOWERS,
  towerMagazine,
} from '../data/towers';
import { type WeaponSlot, WEAPON_SLOT_COUNT } from './armory';
import type { World } from './world';

/** 开局随机池:六种基础武器(下标顺序 = data/towers.ts 0..5,不含合成塔与进阶塔) */
export const START_TOWER_POOL = [
  TOWER_AUTOCANNON,
  TOWER_LASER,
  TOWER_ARC,
  TOWER_RAILGUN,
  TOWER_PD,
  TOWER_MORTAR,
];

/** 开局随机落下几座塔 */
export const START_TOWER_COUNT = 2;

/**
 * 随机起手:从 START_TOWER_POOL 抽 START_TOWER_COUNT 座(可同型),落在随机抽出的
 * **不同**空槽上。抽槽无放回(同一格不叠两门炮),抽型有放回(允许双机炮开局)。
 * rng 消耗 = 每座塔两次 next(先抽槽、后抽型),同 seed 完全可复现。
 * 空槽不足(口径被改坏)时只放得下几座放几座,并照旧把理由码留在控制台,
 * 绝不静默吞掉 —— 症状只会是"开局少一门炮",离配置现场太远。
 */
export function applyRandomStart(world: World): void {
  const empty: number[] = [];
  for (let i = 0; i < WEAPON_SLOT_COUNT; i++) {
    if (world.weapons[i]!.type < 0) empty.push(i);
  }
  const count = Math.min(START_TOWER_COUNT, empty.length);
  for (let n = 0; n < count; n++) {
    const at = world.rng.int(0, empty.length);
    const slotIndex = empty.splice(at, 1)[0]!;
    const type = START_TOWER_POOL[world.rng.int(0, START_TOWER_POOL.length)]!;
    installWeapon(world.weapons[slotIndex]!, type);
  }
  if (count < START_TOWER_COUNT) {
    console.warn(`随机起手只落下 ${count}/${START_TOWER_COUNT} 座:开局空槽不足`);
  }
}

/**
 * 一把新武器的起手状态(**与 World 的普通获得同一条口径**):
 * 满弹进场(非弹药系的塔这里恒 0)、零热量、零冷却、零充能、炮管归位。
 * 塔型越界(配置表写坏)时弹药按 0 起步 —— 渲染层与节流对越界 type 有自己的兜底
 * (打不响、画成占位),这里不做第二层裁决。
 * 导出是为了给测试直接装配固定配装(如 bossGate.test 的闸门满编流),规则入口仍是 applyRandomStart。
 */
export function installWeapon(slot: WeaponSlot, type: number): void {
  const def = TOWERS[type];
  slot.type = type;
  slot.stars = 1; // 起手直落 1★ —— 升星合成只在获得流程(World.mergeOrInstall)里触发
  slot.cooldown = 0;
  slot.ammo = def ? towerMagazine(def, 1) : 0;
  slot.reloadLeft = 0;
  slot.heat = 0;
  slot.coolLock = 0;
  slot.charge = 0;
  slot.turretOffset = 0;
}
