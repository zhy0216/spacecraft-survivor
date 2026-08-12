/**
 * 点防拦截(改版 22 号 —— 甲板删除后的重写)—— 纯逻辑,与 sim/turret.ts 同一条"接线与裁决"分工。
 * 铁律 1:本目录永不 import pixi/DOM,也不用 Math.random —— 拦哪一颗、提前量怎么算,
 * 全由"槽位 + 船位姿 + 弹丸列表"决定,同 seed 必然复现;本文件**一次 rng 都不掷**,
 * 于是拦截一步都不会移动出怪/召唤的随机序列。
 *
 * 为什么不做进 sim/turret.ts:stepTurrets 是"塔 × 敌人"的既有裁决处,弹丸不在它的空间哈希里,
 * 塞进去等于给每座塔多开一条索敌通道、还要动它的循环。这里按 22 号口径另起一个**只认弹丸**的
 * 通行证,挂在 World.step 里、排在 stepTurrets **之前** —— 顺序就是优先级:
 *   一帧里弹丸与敌人同时在射界内时,点防先把这一发打给弹丸(拦截一发 = 免掉一次 sporeDamage),
 *   弹丸不存在/够不着时,onFired 没被调用、cooldown 闸门放行,stepTurrets 照常打敌人 ——
 *   "拦截不挤掉反虫群本分"这句话由 cooldown 闸门机械保证,不需要任何优先级标记。
 *
 * —— 甲板格 → 武器槽的迭代替换(与 sim/turret.ts 同一条)——
 * 旧版遍历 deck.cells 按 isTurretCell 挡离线塔;新版遍历 WEAPON_SLOT_COUNT 个武器槽,
 * 空槽(type = -1)跳过,只筛 interceptsProjectiles 旗子的塔(点防与荆棘壁垒)。
 * 炮位 = slotMuzzleWorld,射界 = slotArc,开火代价走 slot 版 onFired。
 *
 * 拦截弹是**真子弹**(走 my 子弹池、标记 intercept):从炮口飞向**一阶提前量**算出的交点,
 * 飞行途中由 stepInterceptHits 每帧做线段 × 圆判定 —— 打没打中由几何定,不搞"开火即必中"。
 * 提前量只算一阶(弹丸速度恒定、直线飞行,一阶已精确到二阶小量;船速与炮口位移都远小于弹速,
 * 二阶残差追不上 560 px/s 的拦截弹),零迭代、零分配。
 *
 * 拦截弹**绝不打敌人**:hitDirect 对 intercept 弹直接放行(见 sim/bullet.ts),它只认弹丸。
 * 这一条是"拦截承诺"的机械保证 —— 若拦截弹半路被虫群吃掉,玩家看到的就是点防在乱打。
 */
import type { Pool } from '../core/pool';
import { SIM_DT } from '../core/loop';
import { towerArcDeg, towerPierce, towerRange, TOWERS } from '../data/towers';
import { type Arc, slotArc } from './arc';
import { type WeaponSlot, WEAPON_SLOT_COUNT, slotMuzzleWorld } from './armory';
import { BK_DIRECT } from './bullet';
import { type EnemyBullet } from './enemyBullet';
import { type FireSink, FXV_MUZZLE } from './fx';
import { DEG2RAD, type Ship, wrapAngle } from './ship';
import type { EdictBuffs } from './edictBuffs';
import { canFire, effectiveDamage, onFired } from './tower';
import type { Bullet } from './bullet';

/** 当前这座塔的射界。逐塔覆写,不跨调用留值(与 turret.ts 同款暂存) */
const arc: Arc = { center: 0, half: 0 };
/** 当前这座塔的炮位(硬点世界坐标) */
const muzzle = { x: 0, y: 0 };

/**
 * 弹丸与本帧炮口/拦截弹的距离平方的粗筛上限 —— 只用于提前量算出来之前的第一道距离门槛,
 * 见 stepInterception 的循环;它不是命中判据(命中判据在 stepInterceptHits)。
 */
const PROJ_DIST2_EPS = 1e-6;

/**
 * 点防拦截通行证:遍历"拦截旗子"的武器槽(interceptsProjectiles = true,现在只有点防与荆棘壁垒),
 * 找射界 + 射程内、**朝船接近**、**距船最近**的那颗弹丸,转向它并在转到位 + 节流放行时开火。
 *
 * 目标选择的三条判据(定死,单测按此钉):
 *   1. **朝船接近**(dot(弹丸速度, 船 - 弹丸) > 0):已经掠过船身的弹丸不浪费弹药;
 *   2. 在塔的射界 + 射程内(与 stepTurrets 同一套几何,slotArc / towerRange);
 *   3. 多颗并存取**距船最近**的那颗(它最先到船,拦截的紧迫性最高);
 *      同距严格 `<` 才替换 = 保留池序先到者,与 findArcTarget 的索敌同一口径,结果确定。
 *
 * 开火 = 一枚 intercept 标记的真子弹,瞄准**一阶提前量**(弹丸继续直线飞行时子弹到达的位置)。
 * 转向/开火门槛与 stepTurrets 逐字同款(转速上限 + aimTol + canFire),唯一区别是目标类型。
 *
 * **不推进节流**:stepThrottle 由 stepTurrets 在下一段统一推进,这里只读 canFire、写 onFired ——
 * 同一帧内拦截先开火会把 cooldown 写满,stepTurrets 的 canFire 当场被闸住,天然不会双射。
 *
 * @param weapons World.weapons(长度 = WEAPON_SLOT_COUNT 的槽位数组;type = -1 的空槽跳过)
 * @param projectiles 场上全部敌方弹丸(World.enemyBullets.items)。弹丸数量级是几十,
 *   逐塔线性扫是常数开销,不为它单开空间哈希
 * @param buffs 本帧的法令聚合:传给 onFired 的节流包装(热上限/射击间隔的倍率来源)
 *   与拦截弹的伤害(buffs.damageMul)。**按系挑倍率那一步已经在聚合里做过**
 *   (见 sim/edictBuffs.ts 的 throttle 路由),与 stepTurrets 逐字同款
 */
export function stepInterception(
  weapons: readonly WeaponSlot[],
  ship: Ship,
  projectiles: readonly EnemyBullet[],
  dt: number,
  sink: FireSink,
  buffs: EdictBuffs,
): void {
  // 场上没有弹丸 = 没有可拦的东西:一趟扫描都省了(点防的"本分"交给 stepTurrets)
  if (projectiles.length === 0) return;

  for (let i = 0; i < WEAPON_SLOT_COUNT; i++) {
    const slot = weapons[i]!;
    if (slot.type < 0) continue; // 空槽:与 stepTurrets 同一条跳过判据
    const def = TOWERS[slot.type];
    if (!def) continue;
    // 拦截旗子:data/towers 的 interceptsProjectiles,荆棘壁垒与点防同筛(见该字段注释)
    if (!def.interceptsProjectiles) continue;
    const level = slot.level;

    slotArc(i, ship.heading, towerArcDeg(def, level), arc);
    slotMuzzleWorld(ship, i, muzzle);
    const range = towerRange(def, level);
    const range2 = range * range;

    // —— 选目标:射界 + 射程内、朝船接近、距船最近 ——
    let best: EnemyBullet | null = null;
    let bestD2 = Infinity;
    for (let j = 0; j < projectiles.length; j++) {
      const p = projectiles[j]!;
      const dx = p.x - muzzle.x;
      const dy = p.y - muzzle.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > range2) continue;
      // 射界判定与 findArcTarget 同款:方位角相对射界中心的偏差 ≤ 半宽(含边界)
      const bearing = Math.atan2(dy, dx);
      if (Math.abs(wrapAngle(bearing - arc.center)) > arc.half) continue;
      // 朝船接近:弹丸速度与"船 - 弹丸"方向同向才值得拦(掠过船身的放它走)
      const tx = ship.x - p.x;
      const ty = ship.y - p.y;
      if (p.vx * tx + p.vy * ty <= 0) continue;
      const shipD2 = tx * tx + ty * ty;
      if (shipD2 >= bestD2) continue; // 严格 < 才替换:同距保留先到者
      best = p;
      bestD2 = shipD2;
    }
    if (!best) continue; // 弹丸够不着/没有接近的:本分交给 stepTurrets

    // —— 转向目标,与 stepTurrets 同款(转速上限 + 最短弧)——
    const bearing = Math.atan2(best.y - muzzle.y, best.x - muzzle.x);
    const want = Math.max(-arc.half, Math.min(arc.half, wrapAngle(bearing - arc.center)));
    // 与 stepShip 追随期望航向同一套:先折回最短弧,再以每帧上限夹取,绝不瞬间对齐
    const maxTurn = def.turnRate * DEG2RAD * dt;
    const diff = wrapAngle(want - slot.turretOffset);
    slot.turretOffset = wrapAngle(slot.turretOffset + Math.max(-maxTurn, Math.min(maxTurn, diff)));

    // —— 开火门槛两道(节流之外不重复 stepTurrets 的"有目标"门槛)——
    const aim = wrapAngle(arc.center + slot.turretOffset);
    // 第一道:炮口没对准弹丸不开火(与 stepTurrets 的 aimTol 门槛逐字同款)
    if (Math.abs(wrapAngle(bearing - aim)) > def.aimTolDeg * DEG2RAD) continue;
    // 第二道:节流放不放行(弹夹/热量/充能,规则全在 sim/tower.ts)
    if (!canFire(slot, def)) continue;
    // 弹速非正的塔打不出拦截弹(数据被改坏的兜底,与 fireBullets 同款哑火)
    if (!(def.bulletSpeed > 0)) continue;

    // —— 开火:一枚 intercept 标记的真子弹,瞄准一阶提前量 ——
    // 提前量 = 子弹飞到"弹丸当前位置"所需时间 × 弹丸速度,加在弹丸当前位置上:
    // 弹丸直线匀速,这个交点就是子弹与弹丸真正的相遇点(一阶精确)。
    // 弹丸朝船接近 ⇒ 交点必在弹丸与炮口之间 ⇒ 落点在射程内,life 用当前距离即可
    const dist = Math.hypot(best.x - muzzle.x, best.y - muzzle.y) || PROJ_DIST2_EPS;
    const t = dist / def.bulletSpeed;
    const tx = best.x + best.vx * t;
    const ty = best.y + best.vy * t;
    const a = Math.atan2(ty - muzzle.y, tx - muzzle.x);

    const b = sink.spawnBullet();
    b.kind = BK_DIRECT;
    b.x = b.px = muzzle.x;
    b.y = b.py = muzzle.y;
    b.vx = Math.cos(a) * def.bulletSpeed;
    b.vy = Math.sin(a) * def.bulletSpeed;
    b.damage = effectiveDamage(def, level, buffs.damageMul);
    b.life = dist / def.bulletSpeed;
    b.pierce = towerPierce(def, level);
    b.radius = def.bulletRadius;
    b.towerType = def.type;
    b.throttle = def.throttle;
    b.intercept = true; // 拦截弹:只认弹丸,不认敌人(见 hitDirect 的分支与文件头)

    // 与 stepTurrets 同款:炮口闪、记节流代价、投一次"这座塔开火"的票
    sink.fx(FXV_MUZZLE, muzzle.x, muzzle.y, muzzle.x, muzzle.y, 0, def.type);
    onFired(slot, def, 1, buffs);
    sink.fired(i);
  }
}

/**
 * 拦截弹 × 弹丸的命中结算:每帧在两边都移动完之后跑一次。
 * 判据 = 拦截弹本帧位移的**线段**对弹丸当前位置的圆 —— 线段兜住拦截弹一帧 9px 的跳跃,
 * 圆半径 = 两半径之和 + 弹丸本帧位移(弹丸也移动了,圆在弹丸当前位按"胶囊超集"外扩,
 * 见 enemyBullet.ts 的移动口径);几何上这是保守超集,命中只可能略早、不会漏过。
 *
 * 命中 = 双回池 + FXV_IMPACT(直射弹命中的既有事件:确认这一发打在东西上)。
 * 倒序遍历两个池:swap-remove 回收在倒序下安全(被顶上来的对象落在已走过的区间)。
 * 同帧多颗拦截弹打同一颗弹丸:第一颗命中即回池,后续的扫不到它,继续飞向自己的目标。
 *
 * 零 rng、零分配(模块内无暂存,逐对线性扫;弹丸几十 × 拦截弹个位数是常数开销)。
 */
export function stepInterceptHits(
  bullets: Pool<Bullet>,
  projectiles: Pool<EnemyBullet>,
  emit: (towerType: number, x: number, y: number) => void,
): void {
  const bs = bullets.items;
  for (let i = bs.length - 1; i >= 0; i--) {
    const b = bs[i]!;
    if (!b.intercept) continue; // 普通弹不认弹丸,弹丸不认普通弹
    // 拦截弹本帧的位移向量(px/py 是 stepBullets 在积分前存的上一帧位置)
    const mx = b.x - b.px;
    const my = b.y - b.py;
    const len2 = mx * mx + my * my;
    const ps = projectiles.items;
    for (let j = ps.length - 1; j >= 0; j--) {
      const p = ps[j]!;
      const ox = p.x - b.px;
      const oy = p.y - b.py;
      // 线段 × 圆的最短距离平方(点在线段上的投影夹取):标准公式,免开方
      const along = len2 > 0 ? (ox * mx + oy * my) / len2 : 0;
      const t = along < 0 ? 0 : along > 1 ? 1 : along;
      const cx = b.px + mx * t;
      const cy = b.py + my * t;
      const ddx = p.x - cx;
      const ddy = p.y - cy;
      // 半径 = 弹丸半径 + 拦截弹半径 + 弹丸本帧位移(它这帧也动了,见函数头的说明)
      const step = Math.hypot(p.vx, p.vy) * SIM_DT;
      const r = p.radius + b.radius + step;
      if (ddx * ddx + ddy * ddy > r * r) continue;
      // 命中:双回池 + 事件。倒序回收安全;emit 由 World 实现(记 FXV_IMPACT + 塔色)
      projectiles.despawnAt(j);
      bullets.despawnAt(i);
      emit(b.towerType, p.x, p.y);
      break; // 这颗拦截弹已经消失,不再与下一颗弹丸比较
    }
  }
}
