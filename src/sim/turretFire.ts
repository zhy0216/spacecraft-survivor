/**
 * 开火分派与五种弹道(改版 05 号 —— 从 sim/turret.ts 拆出的"打出去"这一半)。
 * 铁律 1:本目录永不 import pixi/DOM,也不用 Math.random —— 多发扇开、链跳选择、线段命中
 *   全是确定性规则,同 seed 必然复现。
 * 铁律 3:模块级暂存三件套(muzzle / candidates / chained)与 sim/turret.ts 共用:
 *   它们只在 stepTurrets 的一次调用内有效,绝不跨帧持有 —— candidates 里装的是池中对象,
 *   敌人一回收,同一个对象下一帧就变成了另一只(见 core/pool 的口径)。
 *
 * 与 sim/turret.ts 的分工:那边管"朝哪转、转不转得过来、节流放不放行"(裁决),
 * 这边管"放行了就打出什么"(表现):按 def.fx 分派五种开火,分界线是弹速 ——
 *   FX_BULLET / FX_MORTAR 走子弹池 —— 飞行途中看得见、躲得开,是玩家读得懂的弹道;
 *   FX_BEAM / FX_CHAIN / FX_LANCE 当场结算 + 推一个 FxEvent 让画面存续几帧 ——
 *     磁轨那种一帧两千 px 的东西做成弹丸必然隧穿(60Hz 下一步跨过整只敌人),
 *     而光束与链电本就没有"飞行"这回事,给它们造弹丸只会凭空多一套要维护的状态。
 * 两个文件共享同一批模块级暂存,故必须同栈调用(只有 stepTurrets 调本模块,单向)。
 */
import { ENEMIES, KIND_BOSS } from '../data/enemies';
import {
  FX_BEAM,
  FX_BULLET,
  FX_CHAIN,
  FX_LANCE,
  FX_MORTAR,
  type TowerDef,
  towerBurst,
  towerChainCount,
  towerPierce,
  towerRange,
} from '../data/towers';
import type { WeaponSlot } from './armory';
import { BK_DIRECT, BK_MORTAR } from './bullet';
import { effectiveAoeDamage, effectiveDamage } from './tower';
import { type Enemy, enemyRadius } from './enemy';
import { type FireSink, FXV_BEAM, FXV_CHAIN, FXV_LANCE } from './fx';
import { DEG2RAD, type Vec2 } from './ship';

/** 当前这座塔的炮位(硬点世界坐标)。stepTurrets 每槽写一次,开火那几个函数直接读 */
export const muzzle: Vec2 = { x: 0, y: 0 };
/**
 * 本帧的粗筛候选,全塔共享。stepTurrets 从空间哈希查一次填入、出函数前清空:
 * 不替对象池扣着一批过期引用。开火那几种瞬时判定(链跳/穿透)也复用这一份,不再额外查哈希。
 */
export const candidates: Enemy[] = [];
/**
 * 链电本次开火**已命中**的敌人。模块级复用而不是每次开火现造一个数组:
 * 一座电弧塔每秒一两次开火,现造就是每秒一两次分配 —— 而铁律 3 要的是运行期零新增分配。
 * 出 fireChain 前 `length = 0`(理由同 candidates:里面装的是池中对象,不许跨调用留着)。
 */
const chained: Enemy[] = [];

/**
 * 按塔型分派一次开火。
 * @param aim 炮口的世界朝向(弧度)—— 弹道一律沿它,而不是直指目标:
 *   容差之内的那点偏差正是"炮管刚刚转到"的手感,直指目标等于把容差这道门槛白设了
 * @returns 这一次实际打出去几发(喂给 onFired 记代价)。0 = 没打出去,调用方不记代价
 */
export function fire(
  slot: WeaponSlot,
  def: TowerDef,
  target: Enemy,
  aim: number,
  range: number,
  sink: FireSink,
): number {
  switch (def.fx) {
    case FX_BULLET:
      return fireBullets(slot, def, aim, range, sink);
    case FX_MORTAR:
      return fireMortar(slot, def, target, aim, range, sink);
    case FX_BEAM:
      return fireBeam(slot, def, target, sink);
    case FX_CHAIN:
      return fireChain(slot, def, target, sink);
    case FX_LANCE:
      return fireLance(slot, def, aim, range, sink);
    default:
      // 认不出的 fx(数值表被改坏)一律哑火,而不是随便挑一种表现顶上:
      // 顶上去的话现场看到的是"这门炮打出了别人的弹",离"表填错了"这个真因十万八千里
      return 0;
  }
}

/**
 * 直射弹(机炮、点防):沿炮口朝向打出 towerBurst 发。
 * 射程以 life 表达(life = 射程 / 弹速),不给子弹存出膛点再逐帧量距离 —— 理由见 sim/bullet.ts。
 */
function fireBullets(
  slot: WeaponSlot,
  def: TowerDef,
  aim: number,
  range: number,
  sink: FireSink,
): number {
  // 弹速非正 = 数值表被改坏:life = 射程/弹速 会变成 Infinity 或 NaN,那颗弹永不回收,
  // 子弹池会一路涨到掉帧。当场哑火,代价是"这门炮不响",而不是一个越跑越卡的世界
  if (!(def.bulletSpeed > 0)) return 0;

  const n = towerBurst(def, slot.level);
  const damage = effectiveDamage(def, slot.level);
  const pierce = towerPierce(def, slot.level);
  const life = range / def.bulletSpeed;
  // 多发扇开的整束宽度 = **瞄准容差**,不为它新造一个旋钮:
  // 于是每一发的方向都还落在"算打得到"的那个锥里(容差之外的方向本就不许开火),
  // 而且扇开量随塔而变 —— 宽容差的近防散得开,窄容差的主炮几乎是并排两发。
  // n = 1 时步长恒 0,不必分支;全程无随机(铁律 1)
  const step = n > 1 ? (def.aimTolDeg * DEG2RAD) / (n - 1) : 0;
  const base = -((n - 1) / 2) * step;

  for (let i = 0; i < n; i++) {
    const a = aim + base + i * step;
    const b = sink.spawnBullet();
    b.kind = BK_DIRECT;
    b.x = b.px = muzzle.x;
    b.y = b.py = muzzle.y;
    b.vx = Math.cos(a) * def.bulletSpeed;
    b.vy = Math.sin(a) * def.bulletSpeed;
    // 伤害在**发射那一刻定死**:塔升级、槽位被替换都不该改变已经出膛的这一发(见 sim/bullet.ts)
    b.damage = damage;
    b.life = life;
    b.pierce = pierce;
    b.radius = def.bulletRadius;
    b.towerType = def.type;
    // 节流系同 damage 一条口径定死:词缀抗性(14 号)在伤害结算处认它,飞行途中不回查塔
    b.throttle = def.throttle;
    // aoeRadius / aoeDamage 保持 resetBullet 清出来的 0:直射弹没有落点 AoE
  }
  return n;
}

/**
 * 抛射弹(迫击炮、轨道火雨):每发**途中不碰撞**的弹,飞到落点炸一片(GDD §5.2 的"越过前排")。
 * 落点取目标**当前**位置、不做提前量:抛射的全部乐趣就是"看得见落点、来得及走开",
 * 加了提前量它就成了必中的追踪弹,那是另一种塔。
 * 发数 = def.burst(轨道火雨三连发 = 3),0 = 恒 1 发 —— 与 fireBullets 同一条多发射击口径:
 * 展开宽度 = 瞄准容差,不为恒发数新造一个旋钮;n = 1 时步长恒 0,与单发迫击炮逐位一致。
 * 充能系"一次泄放"的代价照旧按一次记(onFired 只清空蓄力):三发是同一次蓄力的表现。
 */
function fireMortar(
  slot: WeaponSlot,
  def: TowerDef,
  target: Enemy,
  aim: number,
  range: number,
  sink: FireSink,
): number {
  if (!(def.bulletSpeed > 0)) return 0; // 理由同 fireBullets:Infinity 的 life 是个不回收的弹

  const n = def.burst > 0 ? def.burst : 1;
  const dx = target.x - muzzle.x;
  const dy = target.y - muzzle.y;
  // 夹在射程内是给浮点边界与将来的规则变动兜底(findArcTarget 已保证 ≤ range):
  // 落点绝不许跑到射界叠加层画出来的那个圆之外 —— 那条圆就是玩家读到的"这门炮够得到哪"
  const dist = Math.min(Math.hypot(dx, dy), range);
  const damage = effectiveAoeDamage(def, slot.level);
  const step = n > 1 ? (def.aimTolDeg * DEG2RAD) / (n - 1) : 0;
  const base = -((n - 1) / 2) * step;

  for (let i = 0; i < n; i++) {
    const a = aim + base + i * step;
    const b = sink.spawnBullet();
    b.kind = BK_MORTAR;
    b.x = b.px = muzzle.x;
    b.y = b.py = muzzle.y;
    b.vx = Math.cos(a) * def.bulletSpeed;
    b.vy = Math.sin(a) * def.bulletSpeed;
    b.damage = 0; // 直击不结算:伤害全在落点(见 data/towers 里迫击炮那一行)
    b.life = dist / def.bulletSpeed;
    b.radius = def.bulletRadius;
    b.aoeRadius = def.aoeRadius;
    b.aoeDamage = damage;
    b.towerType = def.type;
    b.throttle = def.throttle; // 词缀抗性(14 号)的伤害系判据,发射那一刻定死
  }
  return n;
}

/**
 * 持续光束(激光 / 相位切割者):瞬时判定 + 一条每次开火续命的可视化。
 * "持续"= fireInterval 0.1s 的伤害 tick,视觉连续、判定离散(见 data/towers 里激光那一行):
 * 真做成 dps × dt 的连续积分,伤害就会跟着帧长漂,确定性也没了。
 *
 * 穿透光束(相位切割者 = towerPierce > 0):光束不再停在首目标 —— 沿炮口→目标的射线一路切到
 * 射程尽头,凡"身体与该线相交"的敌人全吃满(与磁轨的线段判定同一条几何,线半宽复用
 * lanceWidth)。首目标必在线上,故不存在"打空了还要不要记代价"的分叉,代价口径与单体一致。
 * 线画到射程尽头:画面上的那束光就是它的全部作用范围(画到哪儿就是打到哪儿)。
 */
function fireBeam(slot: WeaponSlot, def: TowerDef, target: Enemy, sink: FireSink): number {
  // 节流系跟进去:词缀抗性(14 号:装甲/相位)在伤害结算处认 def.throttle
  const damage = effectiveDamage(def, slot.level);
  const dx = target.x - muzzle.x;
  const dy = target.y - muzzle.y;
  const dist = Math.hypot(dx, dy);

  if (towerPierce(def, slot.level) > 0 && dist > 0) {
    const ux = dx / dist;
    const uy = dy / dist;
    const range = towerRange(def, slot.level);
    for (let i = 0; i < candidates.length; i++) {
      const e = candidates[i]!;
      if (e.dead) continue;
      const ex = e.x - muzzle.x;
      const ey = e.y - muzzle.y;
      const along = ex * ux + ey * uy;
      if (along < 0 || along > range) continue;
      const perp = Math.abs(ex * uy - ey * ux);
      if (perp > def.lanceWidth + enemyRadius(e)) continue;
      sink.damage(e, damage, def.throttle);
    }
    sink.fx(FXV_BEAM, muzzle.x, muzzle.y, muzzle.x + ux * range, muzzle.y + uy * range, 0, def.type);
    return 1;
  }

  // 单体光束(激光):命中点取目标**当前**位置,瞬时判定,画到哪儿就是打到哪儿
  sink.damage(target, damage, def.throttle);
  sink.fx(FXV_BEAM, muzzle.x, muzzle.y, target.x, target.y, 0, def.type);
  return 1;
}

/**
 * 链式闪电(电弧):首目标 = findArcTarget 选中的那只(与其余塔同一条索敌口径),
 * 之后逐跳找"距上一跳点最近、在 chainRange 内、还没被这一发打过的活人",伤害逐跳 × chainFalloff。
 * 总命中数 = towerChainCount(含首目标),每跳推一个 FXV_CHAIN,渲染层首尾相接连成整条链。
 * @returns 恒 1 —— 一次放电就是"一发":代价按发算,与它跳了几只无关
 *   (按跳数扣热量的话,电弧塔在人堆里会瞬间过热,而"清蜂群"正是它的定位)
 */
function fireChain(slot: WeaponSlot, def: TowerDef, target: Enemy, sink: FireSink): number {
  const total = towerChainCount(def, slot.level);
  let damage = effectiveDamage(def, slot.level);
  let hop: Enemy | null = target;
  let fromX = muzzle.x;
  let fromY = muzzle.y;

  chained.length = 0;
  while (hop) {
    sink.damage(hop, damage, def.throttle); // 节流系跟进去:词缀抗性(14 号)在结算处认它
    sink.fx(FXV_CHAIN, fromX, fromY, hop.x, hop.y, 0, def.type);
    chained.push(hop);
    // 判在这里而不是循环头:chainCount 被改成 0/负数时,首目标照样吃这一下 ——
    // "打得到却不掉血"比"少跳一只"难查得多
    if (chained.length >= total) break;
    fromX = hop.x;
    fromY = hop.y;
    damage *= def.chainFalloff;
    hop = nextHop(fromX, fromY, def.chainRange);
  }

  chained.length = 0; // 出函数前清空:里面装的是池中对象,不许跨调用扣着过期引用
  return 1;
}

/**
 * 下一跳的目标:距上一跳点最近、在 chainRange 内、未死、且**不在本次已命中列表**里的那只。
 * 同距**严格 `<` 才替换** = 保留候选里先到的那一只(与 findArcTarget / hitDirect 一字同源):
 * candidates 的顺序由上游定死(每帧 clear + 按 items 顺序 insert)⇒ 跳跃序列确定 ⇒ 同 seed 必然复现。
 * 已命中列表用线性 includes:一条链最多几跳,建一个 Set 的分配代价远大于这几次比较(铁律 3)。
 */
function nextHop(x: number, y: number, range: number): Enemy | null {
  const r2 = range * range;
  let best: Enemy | null = null;
  let bestD2 = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const e = candidates[i]!;
    // 尸体整帧都还在场上(回收在 step 末尾),但不该再吃一发 —— 含本次前几跳刚打死的那几只,
    // 否则 10 号 issue 的掉落会按命中数重复给
    if (e.dead) continue;
    const dx = e.x - x;
    const dy = e.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 > r2) continue; // 含边界:恰好落在跳跃半径上算跳得到(与射程圆同口径)
    if (d2 >= bestD2) continue;
    if (chained.includes(e)) continue; // 最后判:链子绝不许在两只之间来回弹
    best = e;
    bestD2 = d2;
  }
  return best;
}

/**
 * 穿透直线(磁轨):从炮口沿炮口朝向拉一条长 towerRange 的线段,**线上全员吃满**(不衰减)。
 * 做成瞬时线段而不是高速穿透弹:60Hz 下一帧走两千 px 的弹丸必然隧穿(一步跨过整只敌人),
 * 而给它加子步进就等于在热循环里为一座塔单开一套积分。
 * 判据 = 点到**线段**的距离(投影落在 [0, range] 之内 + 垂距 ≤ 半宽 + 体型):
 * 只判点到直线的话,身后与射程之外的敌人也会一起中弹。
 */
function fireLance(
  slot: WeaponSlot,
  def: TowerDef,
  aim: number,
  range: number,
  sink: FireSink,
): number {
  const ux = Math.cos(aim);
  const uy = Math.sin(aim);
  const damage = effectiveDamage(def, slot.level);

  for (let i = 0; i < candidates.length; i++) {
    const e = candidates[i]!;
    if (e.dead) continue;
    const edef = ENEMIES[e.kind];
    if (!edef && e.kind !== KIND_BOSS) continue; // kind 越界只是不打这一只,不炸掉整局;Boss 是表外的合法目标(15 号)
    const dx = e.x - muzzle.x;
    const dy = e.y - muzzle.y;
    const along = dx * ux + dy * uy;
    if (along < 0 || along > range) continue;
    // 叉积的绝对值 = 点到直线的距离(u 是单位向量),不必开方也不必再算一次投影
    const perp = Math.abs(dx * uy - dy * ux);
    if (perp > def.lanceWidth + enemyRadius(e)) continue; // 含边界,与全仓其余命中判据同口径
    sink.damage(e, damage, def.throttle); // 节流系跟进去:词缀抗性(14 号)在结算处认它
  }

  // 无条件推一条光柱,哪怕一个人都没扫到:"打出去了但没打中"正是玩家判断这门沉炮该不该
  // 提前多少的唯一读数(与迫击炮那条 FXV_BLAST 同一条理由)。终点画到射程尽头 = 可视化即作用范围
  sink.fx(FXV_LANCE, muzzle.x, muzzle.y, muzzle.x + ux * range, muzzle.y + uy * range, 0, def.type);
  return 1;
}
