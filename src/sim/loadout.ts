/**
 * 起始装配表 → 槽位的薄接线层(改版 10/20 号 —— 甲板删除后的重写)。
 * 逐条把 LOADOUTS 的 weapons 填进 World 的武器槽(等级 1 起手)、edicts 逐层授予。
 * 起手配置是**开跑前输入**,直接走 armory 的槽位原语,不消费 rng、也不触发合成 ——
 * 合成是"获得第 3 把的那一刻"的机制(见 data/merges.ts),而开局配置是一次性输入,
 * 语义上不是"获得",loadout.test 钉着这条(起手给 3 把同型武器不该当场合成)。
 *
 * 20 号:装配哪一套配置由调用方(开局选择界面)决定 —— 传 LOADOUTS 下标或整条定义均可;
 * 缺省 = 0(标准起手),于是既有调用方与单测的"无参 = 双自动机炮 + 一层弹药协议"语义原样成立。
 * 选择发生在 World 构造之后、第一次 step 之前;装配本身对同一配置逐条确定 ——
 * 同 seed + 同配置 → 同轨迹(配置只通过槽位与武器节流状态进入 sim,不移动任何 rng 消耗次数)。
 *
 * 本模块不认识 World 的内部结算,只做"填槽 + 初始化节流状态"这一件事:
 * 法令聚合与 HP 上限由 World 每帧现算(见 sim/world.ts 的 step 帧首;grantEdict 也当场刷一次),
 * 故装配本身不必去重刷 maxHp —— 第一帧 step 自动把装甲协议的加成算进去(只夹不涨)。
 */
import { LOADOUTS, type LoadoutDef } from '../data/loadout';
import { towerMagazine, TOWERS } from '../data/towers';
import { type WeaponSlot, WEAPON_SLOT_COUNT } from './armory';
import type { World } from './world';

/**
 * 把一套起手配置落进 World。缺省 0 = 标准起手(双自动机炮 + 一层弹药协议)。
 * 武器逐条填进**第一个空槽**,起手状态与普通获得同一条口径(满弹、零热量、零充能、
 * 炮管归位,见 installWeapon 注释);法令逐条走 World.grantEdict —— **不在这里另写一遍叠层**,
 * 授予只有那一个入口(层数夹取与 HP 上限同步都在它里面)。
 * 装不下(配置表写坏 / 槽位数被改小 / 法令写超 5 层)时只跳过这一条、不让整局启动崩掉;
 * 但也绝不静默吞掉 —— 理由码留在控制台,否则症状只会是「开局少一门炮」,
 * 等到整局零掉落时才发现,离配置现场太远。
 */
export function applyStartingLoadout(
  world: World,
  loadout: LoadoutDef | number = 0,
): void {
  const def = typeof loadout === 'number' ? LOADOUTS[loadout] : loadout;
  if (def === undefined) {
    // 下标越界也是数值表写坏的一类:报出来而不是静默开一局空槽
    // (空槽=没有起手武器,症状与"表里全被拒"一样难查)
    console.warn(`起始装配被拒:找不到配置 ${String(loadout)}`);
    return;
  }
  for (let i = 0; i < def.weapons.length; i++) {
    const type = def.weapons[i]!;
    const slot = firstEmptySlot(world.weapons);
    if (!slot) {
      console.warn(`起始装配被拒:配置 ${def.id},武器槽已满(第 ${i} 条,type ${type})`);
      continue;
    }
    installWeapon(slot, type);
  }
  for (let i = 0; i < def.edicts.length; i++) {
    const type = def.edicts[i]!;
    // 授予走 World 的唯一入口:失败码(满层/型越界)原样报出来,不静默吞
    const code = world.grantEdict(type);
    if (code !== 0) {
      console.warn(`起始装配被拒:配置 ${def.id},法令授予失败(第 ${i} 条,type ${type},码 ${code})`);
    }
  }
}

/** 第一个空武器槽(没有返回 undefined —— 槽位制下填满 = 装不下) */
function firstEmptySlot(weapons: readonly WeaponSlot[]): WeaponSlot | undefined {
  for (let i = 0; i < WEAPON_SLOT_COUNT; i++) {
    if (weapons[i]!.type < 0) return weapons[i];
  }
  return undefined;
}

/**
 * 一把新武器的起手状态(**与 World 的普通获得同一条口径**):
 * 满弹进场(非弹药系的塔这里恒 0)、零热量、零冷却、零充能、炮管归位。
 * 塔型越界(配置表写坏)时弹药按 0 起步 —— 渲染层与节流对越界 type 有自己的兜底
 * (打不响、画成占位),这里不做第二层裁决。
 */
function installWeapon(slot: WeaponSlot, type: number): void {
  const def = TOWERS[type];
  slot.type = type;
  slot.level = 1;
  slot.cooldown = 0;
  slot.ammo = def ? towerMagazine(def, 1) : 0;
  slot.reloadLeft = 0;
  slot.heat = 0;
  slot.coolLock = 0;
  slot.charge = 0;
  slot.turretOffset = 0;
}
