/**
 * 炮管推进与开火裁决(改版 04/05 号 —— 甲板删除后的重写)—— 全仓唯一写 slot.turretOffset 的地方,
 * 也是"这一帧哪座塔打了"的唯一裁决处;"打出去就打出什么"的表现分派在 sim/turretFire.ts。
 * 铁律 1:本目录永不 import pixi/DOM,也不用 Math.random —— 塔瞄哪只、转到哪一格弧度,
 *   全由"槽位 + 船位姿 + 空间哈希里的敌人"决定,同 seed 必然复现;本轮的开火路径
 *   **一次随机都不需要**:多发扇开、链跳选择、线段命中全是确定性规则。
 * 铁律 3:模块级暂存(一个 Arc、一个 Vec2、一个候选数组)与 turretFire 共用,运行期零新增分配;
 *   它们**只在一次调用内有效**、绝不跨帧持有 —— 候选数组里装的是池中对象,
 *   敌人一回收,同一个对象下一帧就变成了另一只(见 core/pool 的口径)。
 *
 * 分工:射界几何与"射界内谁最近"在 sim/arc.ts(无状态查询),节流状态机在 sim/tower.ts,
 * 开火表现分派在 sim/turretFire.ts,子弹的积分与命中在 sim/bullet.ts,一塔一档的数值全在
 * data/towers.ts —— 本文件一个裸数字都不写(**改数据文件即可调平衡**,05 验收标准第三条),
 * 只做接线与裁决:逐帧把炮口朝目标转、没目标就转回射界中心,够得着且转得过来就按塔型分派开火。
 *
 * —— 甲板格 → 武器槽的迭代替换(用户设计会)——
 * 旧版遍历 deck.cells、按 isTurretCell 挡离线塔;新版遍历 WEAPON_SLOT_COUNT 个武器槽,
 * 空槽(type = -1)跳过 —— 没有离线/在线这回事,填了的槽永远能开火。
 * 炮位 = slotMuzzleWorld(硬点世界坐标,不再有"格心"),射界 = slotArc
 * (槽位朝向 + 船头,不再有角落加宽),炮管偏角仍存在 slot.turretOffset。
 *
 * 炮管**平滑转向而不是瞬时对齐**(与 stepShip 追随期望航向同一套写法):
 * 瞬时归位在画面上是"弹回",而转速上限(def.turnRate)加上瞄准容差(def.aimTolDeg)
 * 合起来就是 GDD §5.2 那句"塔转不过来就打不到" —— 磁轨那种沉炮追不上贴脸的快目标,
 * 只能靠转船去喂它,这正是"走位即火控"落到单座塔上的样子。
 */
import type { SpatialHash } from '../core/spatialHash';
import { type TowerDef, towerArcDeg, towerChainCount, towerRange } from '../data/towers';
import { type Arc, findArcTarget, slotArc } from './arc';
import { type WeaponSlot, WEAPON_SLOT_COUNT, slotMuzzleWorld } from './armory';
import { tuning } from './config';
import { shipRadius } from './damage';
import { type Enemy } from './enemy';
import { type FireSink, FXV_MUZZLE } from './fx';
import { DEG2RAD, type Ship, wrapAngle } from './ship';
import type { EdictBuffs } from './edictBuffs';
import { canFire, onFired, slotTowerDef, stepThrottle } from './tower';
import { candidates, fire, muzzle } from './turretFire';

/** 当前这座塔的射界。逐塔覆写,不跨调用留值 */
const arc: Arc = { center: 0, half: 0 };

/**
 * 这座塔**够得着的最远距离**(自炮位起算)—— 共享候选圈半径的取值依据,不是射程本身。
 * 对绝大多数塔它就等于射程;电弧塔例外:首目标落在射程边缘后,链还能沿着敌群再往外走
 * (chainCount-1) 跳、每跳最多 chainRange。按射程取圈会让后几跳静默够不着,
 * 且会让这座塔的实际链长取决于别的槽里还有没有射程更远的塔(见文件头)。
 * 这是个**上界**,不是真实链长:链只有在敌人恰好一路排开时才走得这么远,粗筛宁大勿小。
 */
function towerOutreach(def: TowerDef, level: number): number {
  const range = towerRange(def, level);
  const hops = towerChainCount(def, level) - 1;
  return hops > 0 ? range + hops * def.chainRange : range;
}

/**
 * 推进全部武器槽的炮管一逻辑帧,并按各塔的节流与射界开火。
 * @param weapons World.weapons(长度 = WEAPON_SLOT_COUNT 的槽位数组;type = -1 的空槽跳过)
 * @param ship 玩家船(硬点与射界都随 ship.heading 旋转)
 * @param grid 本帧已重建好的敌人空间哈希(World 在敌人循环前 clear + 全量 insert)
 * @param dt 固定时步(SIM_DT);转速与节流都按秒定义,乘 dt 才与 stepShip 同口径
 * @param sink 开火的去处(World 实现)。**传 null = 只追瞄、不开火** ——
 *   04 号那批纯几何用例因此不必造一整套世界,而"炮管朝哪"这件事本就不该依赖"打得出打不出"。
 *   节流(装填/降温/蓄力)无论有没有 sink 都照常推进:它是时间的函数,不是开火的副作用。
 * @param buffs 本帧的法令聚合(sim/edictBuffs.ts 现算):四个 slot* 包装的倍率来源,
 *   由 World 每帧算好传进来 —— 全船被动没有"这一座塔"的归属问题,全部槽共用一份。
 *   **"哪一系吃哪条法令"已经在聚合里按 throttle 折过**(弹药协议只落进 THR_AMMO 那一族),
 *   故本函数不再逐槽挑倍率:少了那一步,"射速加成漏了某一系"这类 bug 没有落脚点。
 *
 * 三条性能口径(1000 敌 + 满槽武器是 01 号压测场景的常态):
 *   一、没有一座武器就**直接返回** —— 压测场景默认空槽,不该为它白掏一次查询;
 *   二、**每帧只查一次空间哈希**:以船心为心、半径 = **全船最大射程** + 船体受击圆半径,
 *     四座塔共享这一份候选。每塔各查一次是四倍 Map 查找,而查询半径本就只是粗筛
 *     (哈希按 cell 返回超集),精筛在 findArcTarget 里逐塔以**自己的炮位**为原点做,没有精度损失;
 *     取最大射程而不是各塔自己的射程,是这条共享的充分条件 —— 少一分,射得最远的那座塔就会瞎一圈。
 *     链跳与磁轨的线段判定也**复用这一份候选**,不再额外查哈希。磁轨的线段终点就在自己射程内,
 *     但**链电不是**:一条链能从射程边缘再往外走 (chainCount-1) × chainRange,所以它的触及范围
 *     要单独算进 outreach(见上面的 towerOutreach)。少算这一截会出两种病:Lv5 电弧的后几跳
 *     够不着(「每级 +1 跳」的成长有一半是空的),以及别的槽里多一座射程更远的**无关**塔
 *     会把候选圈撑大、让同一条链凭空多跳几只 —— 一座塔的行为取决于旁边有什么塔,最难查的那类 bug。
 *     唯一的例外是迫击炮的落点 AoE,它在 sim/bullet.ts 里自己问一次(爆点可能落在这个圆之外)。
 *   三、绝不对 world.enemies.items 做线性扫描(GDD §13)。
 *
 * 哈希分桶用的是敌人**移动前**的位置(World 先建哈希、再跑敌人循环),而 e.x/e.y 已是本帧位置,
 * 这 ≤6px 的错位只可能影响恰好卡在射程边界上的目标,下一帧自然纠正 —— 不为它扩查询半径:
 * 扩半径是每帧都要付的钱,买的却是一个一帧后自动消失的边界抖动。
 */
export function stepTurrets(
  weapons: readonly WeaponSlot[],
  ship: Ship,
  grid: SpatialHash<Enemy>,
  dt: number,
  sink: FireSink | null,
  buffs: EdictBuffs,
): void {
  // 一趟扫出两件事:有没有武器、全船最大射程是多少。
  // 塔型非法(数值表被改坏 / 将来某处漏了校验)的槽在这里就不算数:它下面那个循环也会跳过,
  // 两处用同一条判据(slotTowerDef 取不到 def),不会出现"算进了查询半径却永远不开火"的塔
  let hasTurret = false;
  let maxOutreach = 0;
  for (let i = 0; i < WEAPON_SLOT_COUNT; i++) {
    const slot = weapons[i]!;
    if (slot.type < 0) continue;
    const def = slotTowerDef(slot);
    if (!def) continue;
    hasTurret = true;
    const out = towerOutreach(def, slot.stars);
    if (out > maxOutreach) maxOutreach = out;
  }
  if (!hasTurret) return;

  // 船体受击圆半径:任何硬点离船心都不超过它,故"离某炮位 ≤ maxOutreach 的敌人"必然落在这个圆里 ——
  // 一次查询覆盖全塔的充分条件,少一分就会漏掉舷侧塔够得到、船心够不到的那一圈目标
  const reach = maxOutreach + shipRadius(tuning.shipLength);
  grid.query(ship.x, ship.y, reach, candidates);

  for (let i = 0; i < WEAPON_SLOT_COUNT; i++) {
    const slot = weapons[i]!;
    if (slot.type < 0) continue; // 空槽:没有塔可言
    const def = slotTowerDef(slot);
    if (!def) continue;
    const stars = slot.stars;

    // 节流**有没有目标都要推进**:装填、降温、蓄力都在这里,只在有目标时跑的话,
    // 弹药塔会"没敌人时永远装不完",充能塔也攒不出那一发迎面的抢跳。
    // 受击射速惩罚已随四舷删除,故这里不再有 fireMul —— 法令倍率全部从聚合进
    stepThrottle(slot, def, dt, buffs);

    slotArc(i, ship.heading, towerArcDeg(def, stars), arc);
    slotMuzzleWorld(ship, i, muzzle);
    const range = towerRange(def, stars);
    const target = findArcTarget(candidates, muzzle.x, muzzle.y, arc, range);

    // 有目标就追它的方位,没目标就归位(回到扇形中心 = 偏角 0)。
    // 存的是**相对射界中心**的偏角:船一转,射界与炮管一起转,这里不必每帧追赶 heading
    let want = 0;
    let bearing = 0;
    if (target) {
      bearing = Math.atan2(target.y - muzzle.y, target.x - muzzle.x);
      // 夹进 ±half:findArcTarget 已保证目标在射界内,这一夹是给浮点边界兜底 ——
      // 炮口在任何一帧都不许指到扇形外面去(渲染层画出来的扇形就是它的活动范围)
      want = Math.max(-arc.half, Math.min(arc.half, wrapAngle(bearing - arc.center)));
    }

    // 与 stepShip 追随期望航向同一套:先折回最短弧,再以每帧上限夹取,绝不瞬间对齐。
    // 差值小于一帧的上限时夹取不生效 → 当帧精确落到 want,不会在目标附近来回过冲
    const maxTurn = def.turnRate * DEG2RAD * dt;
    const diff = wrapAngle(want - slot.turretOffset);
    slot.turretOffset = wrapAngle(slot.turretOffset + Math.max(-maxTurn, Math.min(maxTurn, diff)));

    // —— 开火门槛三道,缺一不可 ——
    // 第一道:有没有地方开火(sink = null 就是纯追瞄)、射界内有没有目标
    if (!sink || !target) continue;
    // 炮口的世界朝向 = 射界中心 + 相对偏角(sim/armory 对 turretOffset 的定义就是这一句)
    const aim = wrapAngle(arc.center + slot.turretOffset);
    // 第二道:**炮口没对准目标就不开火**。这就是"塔转不过来就打不到"的全部实现 ——
    // 少了它,转速上限只影响炮管这根装饰品,沉炮照样能贴脸秒杀高速目标
    if (Math.abs(wrapAngle(bearing - aim)) > def.aimTolDeg * DEG2RAD) continue;
    // 第三道:节流放不放行(弹夹/热量/充能,规则全在 sim/tower.ts,这里不复述)
    if (!canFire(slot, def)) continue;

    const shots = fire(slot, def, target, aim, range, sink, buffs.damageMul);
    // shots = 0 只可能是数值表被改坏(弹速非正、fx 越界):那种塔当场哑火,
    // 而**不记代价** —— 记了就会白扣一发弹药/一份热量,现场看上去像"塔在打但没伤害"
    if (shots <= 0) continue;
    // 所有塔型共用的一次短促炮口闪:只在真正打出至少一发/一次结算后推事件,哑火不闪。
    // 一次 trigger 只推一条(双管仍是一座塔开了一次火),渲染层按 towerType 取同源冷色。
    sink.fx(FXV_MUZZLE, muzzle.x, muzzle.y, muzzle.x, muzzle.y, 0, def.type, 0, 0, slot.stars);
    // 与 stepThrottle 传同一个 buffs:写进 cooldown 的那个间隔和逐帧夹取它的那个上限必须同源,
    // 否则法令倍率变化时写进去的新间隔会被下一帧按旧上限夹回去
    onFired(slot, def, shots, buffs);
    sink.fired(i);
  }

  candidates.length = 0;
}
