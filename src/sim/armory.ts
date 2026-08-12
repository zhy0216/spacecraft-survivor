/**
 * 槽位制武器库(改版 GDD §5 —— 甲板网格删除后的落点)—— 纯逻辑。
 * 铁律 1:本目录永不 import pixi/DOM,也不用 Math.random —— 槽位只是"定长数组 + 按位填",
 *   同 seed 必然复现;炮口的世界位置与射界中心全是"船位姿 + 槽位下标"的确定性算术。
 * 铁律 3:本文件只建**一次**槽位数组(World 构造时),运行期就地改字段,零新增分配;
 *   slotMuzzleWorld 的结果写进调用方给的 out(模块级暂存由 turret/intercept 各自持有)。
 *
 * —— 槽位制对网格制的替换(用户设计会)——
 * 甲板/格放置/邻接/焊接随网格删除后,武器改为**固定槽位**:
 *   8 个武器槽**沿船体一圈均布**挂在 World 上,槽位编号即"这门炮装在哪"的全部含义;
 *   武器从固定硬点(WEAPON_HARDPOINTS)开火,射界中心 = 固定槽位朝向(WEAPON_SLOT_FACING)
 *   + 船头朝向 —— 船转向仍整体旋转所有射界,「转船找射界」的手感原样保留,
 *   只是"射界来自格子的暴露边"变成了"射界来自槽位的固定朝向"。
 * 支援槽整类删除(用户设计会:支援并入法令,见 data/edicts.ts 文件头)——
 * 全船被动不再占任何槽位,本文件只剩武器这一件事。
 *
 * 槽位数学是渲染层与 sim 的**共享口径**:
 *   slotMuzzleWorld = 船心 + 旋转(船体局部硬点, ship.heading) —— 画炮口、开火起点同一份;
 *   slotArcCenter = WEAPON_SLOT_FACING[i] + ship.heading —— 画扇形、索敌中心同一份。
 */
import { TOWER_MAX_LEVEL } from '../data/towers';
import { type Ship, type Vec2, wrapAngle } from './ship';

/**
 * 武器槽数量(用户设计会定死:**8 个正好围成一圈**)。改它 = 改平衡口径,与 TOWER_KIND_COUNT 同理。
 * 8 而不是 4 的理由是射界:每槽 45° 一档,八个朝向把整圈铺满,于是"哪个方向没有火力"
 * 变成玩家自己排出来的结果(按 I 开武器面板换位,见 ui/armoryPanel.ts),而不是槽位表定死的。
 */
export const WEAPON_SLOT_COUNT = 8;

/**
 * 八个武器槽的船体局部炮口偏移(世界 px)。**ship-local**:槽 i 的炮口 =
 * 船心 + 旋转(WEAPON_HARDPOINTS[i], ship.heading)(见 slotMuzzleWorld)。
 * 取值沿一个 18×13 的椭圆均布(每 45° 一个),**都落在船体包围盒
 * (shipLength 48 × shipWidth 36)之内** —— 于是"炮口从船身轮廓上冒火"与"炮口悬在船外"
 * 两种违和都不会出现。下标 = 槽位编号,与 WEAPON_SLOT_FACING 一一对应
 * (0 船头 → 顺时针一圈 → 7 左前)。
 */
export const WEAPON_HARDPOINTS: { x: number; y: number }[] = [
  { x: 18, y: 0 }, // 槽 0:正船头
  { x: 12.7, y: 9.2 }, // 槽 1:右前
  { x: 0, y: 13 }, // 槽 2:正右舷
  { x: -12.7, y: 9.2 }, // 槽 3:右后
  { x: -18, y: 0 }, // 槽 4:正船尾
  { x: -12.7, y: -9.2 }, // 槽 5:左后
  { x: 0, y: -13 }, // 槽 6:正左舷
  { x: 12.7, y: -9.2 }, // 槽 7:左前
];

/**
 * 八个武器槽的船体局部射界中心(弧度,**0 = 船头**,与 ship.heading 同向口径:顺时针为正)。
 * 世界系射界中心 = 本值 + ship.heading(slotArcCenter;船转向时所有射界一起转)。
 * 八个朝向**每 45° 一档、与硬点方位角一一对应**:槽位射界是"这门炮朝哪打"的固定承诺,
 * 玩家记住"槽 0 = 正前、槽 4 = 正后"即可规划走位与换位。
 */
export const WEAPON_SLOT_FACING: number[] = [
  0, // 槽 0:正前
  Math.PI / 4, // 槽 1:右前
  Math.PI / 2, // 槽 2:正右
  (3 * Math.PI) / 4, // 槽 3:右后
  Math.PI, // 槽 4:正后(wrapAngle 的值域是 (-π, π],π 原样保留)
  (-3 * Math.PI) / 4, // 槽 5:左后
  -Math.PI / 2, // 槽 6:正左
  -Math.PI / 4, // 槽 7:左前
];

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

/** 建一整份 8 槽武器槽位数组(World 构造时调用一次) */
export function createWeaponSlots(): WeaponSlot[] {
  const out: WeaponSlot[] = [];
  for (let i = 0; i < WEAPON_SLOT_COUNT; i++) out.push(createWeaponSlot());
  return out;
}

/**
 * 交换两个槽的**全部内容**(武器面板换位的唯一实现;World.swapWeapons 转发它)。
 * 槽位对象整局复用(铁律 3),故不能换引用、只能逐字段对拷 —— 本函数是"WeaponSlot 有哪些字段"
 * 的第二个知情处(第一处是 createWeaponSlot),加字段时两处一起改,单测钉着两处对齐。
 *
 * 节流状态**跟着武器走**(弹夹/热量/充能一起搬):换位是"把这门炮挪个位置",
 * 不是"拆了再装一门新的" —— 借换位刷新弹夹与热量就等于给了玩家一个免费装填按钮,
 * 而弹药系那段硬停顿正是它的全部代价。
 * 唯独 **turretOffset 双双归零**:它是炮管相对**射界中心**的偏角,而换位恰恰换掉了射界中心,
 * 原样搬过去等于让炮管从一个毫无来由的角度起转(视觉上是换位瞬间炮管猛地一甩)。
 */
export function swapWeaponSlots(a: WeaponSlot, b: WeaponSlot): void {
  let t: number = a.type;
  a.type = b.type;
  b.type = t;
  t = a.level;
  a.level = b.level;
  b.level = t;
  t = a.cooldown;
  a.cooldown = b.cooldown;
  b.cooldown = t;
  t = a.ammo;
  a.ammo = b.ammo;
  b.ammo = t;
  t = a.reloadLeft;
  a.reloadLeft = b.reloadLeft;
  b.reloadLeft = t;
  t = a.heat;
  a.heat = b.heat;
  b.heat = t;
  t = a.coolLock;
  a.coolLock = b.coolLock;
  b.coolLock = t;
  t = a.charge;
  a.charge = b.charge;
  b.charge = t;
  a.turretOffset = 0; // 见上:射界中心换了,炮管一律归位
  b.turretOffset = 0;
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
