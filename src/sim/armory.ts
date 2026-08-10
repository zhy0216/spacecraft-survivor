/**
 * 槽位制武器库(改版 GDD §5 —— 甲板网格删除后的落点)—— 纯逻辑。
 * 铁律 1:本目录永不 import pixi/DOM,也不用 Math.random —— 槽位只是"定长数组 + 按位填",
 *   同 seed 必然复现;炮口的世界位置与射界中心全是"船位姿 + 槽位下标"的确定性算术。
 * 铁律 3:本文件只建**一次**槽位数组(World 构造时),运行期就地改字段,零新增分配;
 *   slotMuzzleWorld 的结果写进调用方给的 out(模块级暂存由 turret/intercept 各自持有)。
 *
 * —— 槽位制对网格制的替换(用户设计会)——
 * 甲板/格放置/邻接/焊接随网格删除后,武器与支援改为**固定槽位**:
 *   4 个武器槽 + 4 个支援槽挂在 World 上,槽位编号即"这门炮装在哪"的全部含义;
 *   武器从固定硬点(WEAPON_HARDPOINTS)开火,射界中心 = 固定槽位朝向(WEAPON_SLOT_FACING)
 *   + 船头朝向 —— 船转向仍整体旋转所有射界,「转船找射界」的手感原样保留,
 *   只是"射界来自格子的暴露边"变成了"射界来自槽位的固定朝向"。
 * 支援槽 = 全船被动,没有邻接、没有"摆在哪"这回事(聚合规则在 sim/support.ts)。
 *
 * 槽位数学是渲染层与 sim 的**共享口径**:
 *   slotMuzzleWorld = 船心 + 旋转(船体局部硬点, ship.heading) —— 画炮口、开火起点同一份;
 *   slotArcCenter = WEAPON_SLOT_FACING[i] + ship.heading —— 画扇形、索敌中心同一份。
 */
import { TOWER_MAX_LEVEL } from '../data/towers';
import { type Ship, type Vec2, wrapAngle } from './ship';

/** 武器槽数量(用户设计会定死;改它 = 改平衡口径,与 TOWER_KIND_COUNT 同理) */
export const WEAPON_SLOT_COUNT = 4;
/** 支援槽数量(同武器槽,定死) */
export const SUPPORT_SLOT_COUNT = 4;

/**
 * 四个武器槽的船体局部炮口偏移(世界 px)。**ship-local**:槽 i 的炮口 =
 * 船心 + 旋转(WEAPON_HARDPOINTS[i], ship.heading)(见 slotMuzzleWorld)。
 * 取值散在船身四角、都落在船体包围盒(shipLength 48 × shipWidth 36)之内,
 * 于是"炮口从船身轮廓上冒火"与"炮口悬在船外"两种违和都不会出现。
 * 下标 = 槽位编号,与 WEAPON_SLOT_FACING 一一对应(0 船头 / 1 右舷 / 2 船尾 / 3 左舷)。
 */
export const WEAPON_HARDPOINTS: { x: number; y: number }[] = [
  { x: 16, y: -8 }, // 槽 0(船头):船头偏右舷 —— 前方火力从船头冒火
  { x: 8, y: 15 }, // 槽 1(右舷):右舷偏船头
  { x: -16, y: 8 }, // 槽 2(船尾):船尾偏左舷
  { x: -8, y: -15 }, // 槽 3(左舷):左舷偏船尾
];

/**
 * 四个武器槽的船体局部射界中心(弧度,**0 = 船头**,与 ship.heading 同向口径:顺时针为正)。
 * 世界系射界中心 = 本值 + ship.heading(slotArcCenter;船转向时所有射界一起转)。
 * 刻意取四个正交朝向而不是按硬点方位角:槽位射界是"这门炮朝哪打"的固定承诺,
 * 玩家记住"槽 0 = 前方"即可规划走位,与硬点的细微偏移无关。
 */
export const WEAPON_SLOT_FACING: number[] = [0, Math.PI / 2, Math.PI, -Math.PI / 2];

/**
 * 一个已填的武器槽;**type = -1 = 空槽**。除 type/level 外的七个字段全是**运行期节流状态**
 * (从旧 DeckCell 原样搬来,字段语义与 sim/tower.ts 的节流状态机一一对应):
 *   cooldown / ammo / reloadLeft / heat / coolLock / charge 由 stepThrottle/onFired 逐帧演化,
 *   turretOffset = 炮管相对射界中心的偏角(sim/turret.ts 逐帧追瞄/归位,世界朝向 = arcCenter + 它)。
 * 它们决定"下一帧谁开火",故进 checksum(与旧甲板逐格哈希同一条理由)。
 */
export interface WeaponSlot {
  /** TOWER_*;-1 = 空槽 */
  type: number;
  /** 1..TOWER_MAX_LEVEL;空槽恒 0 */
  level: number;
  /** 距下次可开火的剩余秒(充能系恒 0:那类塔的节奏全由 charge 给) */
  cooldown: number;
  /** 弹夹剩余发数(弹药系;其余系恒 0) */
  ammo: number;
  /** 装填剩余秒(弹药系;> 0 = 装填中,不许开火) */
  reloadLeft: number;
  /** 当前热量(过热系;UI 的热量条 = heat / slotHeatMax) */
  heat: number;
  /** 过热锁死剩余秒(过热系;> 0 = 强制冷却,不许开火) */
  coolLock: number;
  /** 充能进度 0..1(充能系;满 1.0 才放行) */
  charge: number;
  /** 炮管相对射界中心的偏角(弧度);归位 = 0 */
  turretOffset: number;
}

/** 一个已填的支援槽;type = -1 = 空槽。支援 = 全船被动,重复持有允许(= 叠效,见 sim/support.ts) */
export interface SupportSlot {
  /** SUP_*;-1 = 空槽 */
  type: number;
}

/** 池 factory 语义(槽位不是池对象,但初值口径同 createBullet:字段一次性声明齐) */
function createWeaponSlot(): WeaponSlot {
  return {
    type: -1,
    level: 0,
    cooldown: 0,
    ammo: 0,
    reloadLeft: 0,
    heat: 0,
    coolLock: 0,
    charge: 0,
    turretOffset: 0,
  };
}

/** 建一整份 4 槽武器槽位数组(World 构造时调用一次) */
export function createWeaponSlots(): WeaponSlot[] {
  const out: WeaponSlot[] = [];
  for (let i = 0; i < WEAPON_SLOT_COUNT; i++) out.push(createWeaponSlot());
  return out;
}

/** 建一整份 4 槽支援槽位数组(World 构造时调用一次) */
export function createSupportSlots(): SupportSlot[] {
  const out: SupportSlot[] = [];
  for (let i = 0; i < SUPPORT_SLOT_COUNT; i++) out.push({ type: -1 });
  return out;
}

/**
 * 槽 i 的炮口世界坐标 = 船心 + 旋转(硬点, ship.heading),写进 out 并返回它。
 * 旋转约定与 sim/damage 的局部系变换同一套(local → world 按 heading 正旋):
 * 硬点是"船头朝 +X"时画出来的,船转了 heading,硬点跟着转。
 */
export function slotMuzzleWorld(ship: Ship, slotIndex: number, out: Vec2): Vec2 {
  const hp = WEAPON_HARDPOINTS[slotIndex];
  if (!hp) return out; // 槽位下标越界(数值表/调用方写坏):留在原地,不开火也不炸
  const cos = Math.cos(ship.heading);
  const sin = Math.sin(ship.heading);
  out.x = ship.x + hp.x * cos - hp.y * sin;
  out.y = ship.y + hp.x * sin + hp.y * cos;
  return out;
}

/**
 * 槽 i 的射界中心(世界系,弧度)= WEAPON_SLOT_FACING[i] + ship.heading。
 * 折回 (-π, π] 与 arc 的 center 口径一致(atan2 / wrapAngle 的值域)——
 * 船转向时所有射界一起转,「转船找射界」的手感由此成立。
 */
export function slotArcCenter(ship: Ship, slotIndex: number): number {
  // WEAPON_SLOT_FACING 长度 = WEAPON_SLOT_COUNT,槽位下标越界(调用方写坏)时兜底成船头朝向
  return wrapAngle((WEAPON_SLOT_FACING[slotIndex] ?? 0) + ship.heading);
}

/** 武器槽还有没有空位(任一槽 type = -1)。World.acquireWeapon 与 UI 的"还能不能买"都问它 */
export function slotHasSpace(weapons: readonly WeaponSlot[]): boolean {
  for (let i = 0; i < weapons.length; i++) {
    if (weapons[i]!.type < 0) return true;
  }
  return false;
}
