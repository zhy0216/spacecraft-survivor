/**
 * 塔的节流状态机(05 号 issue T2)—— 三套**机制上互不相同**的开火节奏。
 * 本文件是全仓唯一推进 cell.cooldown / ammo / reloadLeft / heat / coolLock / charge
 * 这六个运行期读数的地方(甲板只负责它们的生灭,渲染层与 UI 只读)。
 *
 * 铁律 1:本目录永不 import pixi/DOM,也不用 Math.random —— 三套机制全是"逐帧累减/累加 + 阈值"的
 *   确定性算术,同 seed 必然复现;喂一个格子 + 一份 def 就能在 Node 里把每一帧钉住。
 * 铁律 3:状态**扁平挂在 DeckCell 上**(见 deck.ts 里那段"格与塔一一对应"的理由),
 *   本文件不新建任何对象、不留任何跨帧容器 —— 满甲板逐帧跑它,分配数恒为 0。
 *
 * 依赖方向刻意只有一条:本文件 `import type { DeckCell }`(**类型 import,编译后整条消失**),
 * 而 deck.ts 一个字都不认识本文件。于是运行期依赖图上压根没有 tower ↔ deck 这条边,
 * 永远不可能成环;甲板是那块状态的房东,推进它的规则住在这里。
 *
 * 三套为什么必须**机制上**可区分,而不是同一个 cooldown 换三种皮:
 * 它们是 06 号支援设施的三个作用锚点(供弹 / 散热 / 电容),合并成一个旋钮,
 * 06 就只剩一种支援设施可做,GDD §5.1 的"节流三选一"当场作废。三者的特征定死如下 ——
 *   弹药 THR_AMMO   :突发满速,弹夹见底**必然停火一整段**(硬停顿,时长与射速无关);
 *   过热 THR_HEAT   :**点射就永不停火**,只有贪连射才被罚(收支平衡点就是它的全部手感);
 *   充能 THR_CHARGE :攒-放,节奏只由 chargeTime 给,**与射速旋钮完全无关**;满 1.0 停着等目标。
 * 每个分支只碰自己那套字段(tower.test.ts 有一条在逐帧扫"三者的读数字段互不复用"),
 * 于是 UI 那三种画法(弹夹条 / 热量条 / 充能环)读到的永远是三种真不同的东西。
 */
import {
  THR_AMMO,
  THR_CHARGE,
  THR_HEAT,
  type TowerDef,
  towerAoeDamage,
  towerChargeTime,
  towerDamage,
  towerFireInterval,
  towerHeatMax,
  towerMagazine,
  TOWERS,
} from '../data/towers';
import { tuning } from './config';
import type { DeckCell } from './deck';

/**
 * 计时到期的判据容差(秒),与 enemy.ts 的 TIMER_EPS 一字同源:
 * cooldown / reloadLeft / coolLock 都是逐帧减 dt 的浮点累减,1.5s 这种 dt 整数倍的时长
 * 减完会落在 ±1e-16 上,不兜住就会随机多出一帧 —— 而"装填恰好 reload/SIM_DT 帧"
 * 正是弹药系那条硬停顿的全部可信度。1e-9 远小于一帧(1/60 s),只吃得掉浮点残差、吃不掉真帧。
 * charge 是反向累加,用的是同一个容差(见 stepThrottle 的充能分支)。
 */
export const THROTTLE_EPS = 1e-9;

/**
 * 全局射速倍率的下限。倍率是面板上的旋钮,拖到 0 会让 fireInterval 变成 Infinity 并写进 cell.cooldown,
 * 而 `Infinity - dt` 恒为 Infinity —— 那座塔此后再也减不回来(NaN 更会顺着 checksum
 * 把整局的确定性口径搅烂),连 stepCooldown 那道夹取都救不了它:上限本身就是 Infinity。
 * 夹一个正下限:0 附近的语义仍然是"慢到几乎不开火",但一切都是可逆的。
 */
const SCALE_MIN = 1e-3;

/**
 * 射速倍率取值。写成 `v > SCALE_MIN ? ... : ...` 而不是判它小于下限,是 data/towers 的 clampLevel 同一手:
 * **NaN 与任何数比较都是 false**,于是面板上敲进来的一个空值也一并落到下限,不会顺着除法污染全场。
 */
function safeScale(v: number): number {
  return v > SCALE_MIN ? v : SCALE_MIN;
}

/**
 * 这一格上的塔定义;没有塔(或塔型非法)返回 undefined。
 * 只看 towerType 不看 content:**towerType === -1 就是甲板对"这格没有塔"的唯一表达**
 * (createDeck 的初值、recomputeDeck 的清理、placeAt 的初始化三处一致),
 * 而 TOWERS[-1] 与 TOWERS[1.5] 在 noUncheckedIndexedAccess 下本就是 undefined,一次取表即可。
 * 顺带让本文件对 deck 只剩类型依赖 —— 要判 CELL_WEAPON 就得**运行期** import 甲板,那条边不值得连。
 */
export function cellTowerDef(cell: DeckCell): TowerDef | undefined {
  return TOWERS[cell.towerType];
}

/**
 * 冷却倒计时,弹药系与过热系共用(充能系没有冷却,见下)。
 * 到期夹成**精确 0**:于是 canFire 那边只需比 `<= 0`,浮点残差只在这一处兜,不散到判据里去。
 *
 * 剩余冷却每帧现夹在**当前**的射击间隔内,理由有两条:
 *   一、全局射速倍率是面板上随时会被拖的旋钮,夹了它,拖快时**正在走的这一轮**也当场变快,
 *     而不是要等这一轮走完 —— "面板拖动即时生效"才是完整的;
 *   二、倍率一度被拖到极小值时写进去的那个天文数字,拖回来的下一帧就被夹掉,
 *     那座塔一定救得回来。不夹的话它会一直冻到本局结束(cooldown 只减不设上限)。
 */
function stepCooldown(cell: DeckCell, def: TowerDef, dt: number): void {
  if (cell.cooldown <= 0) return;
  const max = effectiveFireInterval(def, cell.level);
  if (cell.cooldown > max) cell.cooldown = max;
  cell.cooldown -= dt;
  if (cell.cooldown <= THROTTLE_EPS) cell.cooldown = 0;
}

/**
 * 推进一座塔的节流一逻辑帧。**有没有目标都要跑** —— 装填、降温、蓄力都在这里:
 * 只在有目标时推进,弹药塔就会"没敌人时永远装不完",充能塔也攒不出那一发迎面的抢跳。
 * 调用方(sim/turret.ts)先按 isTurretCell 挡掉离线塔:离线塔一切冻结(与 04 号炮管同口径),
 * 所以本函数不认识 online —— 它只管"这一帧的时间过去了,状态该走到哪"。
 */
export function stepThrottle(cell: DeckCell, def: TowerDef, dt: number): void {
  switch (def.throttle) {
    case THR_AMMO: {
      // 冷却与装填**并行**推进:装填完毕那一帧就该能开火,不再叠一层射击间隔。
      // (reload 1.5s 远长于 fireInterval,冷却早就归 0 了;并行只是为了这条语义不依赖数值大小)
      stepCooldown(cell, def, dt);
      if (cell.reloadLeft > 0) {
        cell.reloadLeft -= dt;
        if (cell.reloadLeft <= THROTTLE_EPS) {
          cell.reloadLeft = 0;
          // 按**当前**等级满弹:装填途中升了级,这一夹就直接吃到新弹夹上限(GDD §5.4 的成长看得见)
          cell.ammo = towerMagazine(def, cell.level);
        }
      }
      break;
    }

    case THR_HEAT: {
      stepCooldown(cell, def, dt);
      // 降温**任何时候都在跑**,含强制冷却期间:UI 的热量条因此一直在往下走,
      // 玩家看得见"还剩多久能打",而不是锁死期间冻在顶上、解锁那一刻突然归零。
      if (cell.heat > 0) {
        cell.heat -= def.coolPerSec * dt;
        if (cell.heat < 0) cell.heat = 0;
      }
      if (cell.coolLock > 0) {
        cell.coolLock -= dt;
        if (cell.coolLock <= THROTTLE_EPS) {
          cell.coolLock = 0;
          // 罚满了就**从零起手**:惩罚时长是设计者定的那一个数(overheatLock),
          // 不该再取决于 coolPerSec 顺带降到了几 —— 两个旋钮各管各的,调一个不会牵动另一个
          cell.heat = 0;
        }
      }
      break;
    }

    case THR_CHARGE: {
      // 充能系**没有冷却**:cell.cooldown 从 placeAt 的初值 0 起就再没人写过非 0(onFired 也恒写 0),
      // 故这里连清零都不必 —— 热循环里不放一句注定为真的赋值。UI 的"充能系 cooldown 恒 0"由此成立。
      const t = towerChargeTime(def, cell.level);
      if (t > 0) {
        cell.charge += dt / t;
        // 满了就**精确停在 1.0**(而不是留个 0.9999…):UI 的充能环要能画满,
        // canFire 那边也才能干干净净地比 `>= 1`。这一夹同时就是"满充后停着等目标"——
        // 无目标也照常蓄、蓄满不外溢,于是目标一进射界就是当场一发,而不是再等一个周期
        if (cell.charge >= 1 - THROTTLE_EPS) cell.charge = 1;
      } else {
        // chargeTime 被调成 0(或负)= 取消蓄力:当场满充,而不是吐出 NaN/Infinity 把塔弄死。
        // 与弹药系 reload 调 0 的兜底同口径 —— "改数据文件即可调平衡"里也包含"调过头也不许崩"
        cell.charge = 1;
      }
      break;
    }

    default:
      // 未知节流(数值表被改坏)退化成纯冷却:这样的塔至少还打得响,便于当场看出是表填错了
      stepCooldown(cell, def, dt);
      break;
  }
}

/**
 * 这一帧允许开火吗。**只问节流**:射界、瞄准容差、有没有目标由 sim/turret.ts 在外面判,
 * 三道门槛各管各的,才能在单测里分别钉住(节流用例不必造一只敌人)。
 * 三个分支读的字段两两不交 —— 这就是"三套机制不是同一个 cooldown 换皮"的机械形式。
 */
export function canFire(cell: DeckCell, def: TowerDef): boolean {
  switch (def.throttle) {
    // 装填中一律不许开火(哪怕弹夹上限刚被升级抬高),这就是弹药系那段硬停顿
    case THR_AMMO:
      return cell.reloadLeft <= 0 && cell.ammo > 0 && cell.cooldown <= 0;
    // 过热锁死期间一律不许开火;没锁死就只看射击间隔 —— 于是点射永远打得出去
    case THR_HEAT:
      return cell.coolLock <= 0 && cell.cooldown <= 0;
    // 攒满才放,与射击间隔无关(充能系的 fireInterval 恒 0,压根没有那个旋钮)
    case THR_CHARGE:
      return cell.charge >= 1;
    default:
      return cell.cooldown <= 0;
  }
}

/**
 * 刚刚开了一火:把代价记在自己那套机制上。**必须与真的开火一一对应**
 * (sim/turret.ts 在按 def.fx 分派完开火表现之后立刻调它)——
 * 少调一次就是白嫖一发,多调一次就是凭空扣掉一发弹药/一份热量。
 * @param shots 这一次打出去几发(机炮 Lv3 双管 = 2,见 towerBurst)。
 *   连发的代价按发算:不乘 shots 就等于"升到 Lv3 之后多出来的那一发是免费的",
 *   弹夹与热量这两套机制会随着等级悄悄变弱 —— 而它们正是 06 号要作用的锚点。
 */
export function onFired(cell: DeckCell, def: TowerDef, shots: number): void {
  // 至少算一发:调用点就是"确实开火了"那一处,传 0/NaN 进来会让弹夹永不见底 = 节流形同虚设
  const n = shots > 1 ? Math.floor(shots) : 1;

  switch (def.throttle) {
    case THR_AMMO: {
      cell.cooldown = effectiveFireInterval(def, cell.level);
      cell.ammo -= n;
      if (cell.ammo <= 0) {
        cell.ammo = 0; // 夹 0:UI 直接把这个整数印出来,不能出现 -1 发
        if (def.reload > 0) {
          cell.reloadLeft = def.reload;
        } else {
          // 装填时间被调成 0 = 无停顿:当场满弹,而不是留下一座弹夹恒 0、永远打不响的塔
          cell.ammo = towerMagazine(def, cell.level);
        }
      }
      break;
    }

    case THR_HEAT: {
      cell.cooldown = effectiveFireInterval(def, cell.level);
      cell.heat += def.heatPerShot * n;
      const max = towerHeatMax(def, cell.level);
      if (cell.heat >= max) {
        // 夹到上限而不是让它冲过头:热量条是 heat / heatMax,超过 1 的条会画到框外面去
        cell.heat = max;
        cell.coolLock = def.overheatLock;
      }
      break;
    }

    case THR_CHARGE:
      // 一次放空,与打了几发无关:充能系的"发数"是同一次泄放的表现,不是攒了几管电
      cell.charge = 0;
      // 恒 0,且**不读 fireInterval** —— 充能系的节奏只有 chargeTime 一个旋钮,
      // 哪天有人往表里填了非 0 的 fireInterval(data/towers.test.ts 那条断言是第一道防线),
      // 这里也不许它插一脚变成两个旋钮打架
      cell.cooldown = 0;
      break;

    default:
      cell.cooldown = effectiveFireInterval(def, cell.level);
      break;
  }
}

/**
 * 实际射击间隔(秒/次)= 数值表的等级取值 ÷ 全局射速倍率。
 * **每次调用现读 tuning**(与 stepShip / stepEnemyBehavior 同口径):面板拖一下,下一次开火的
 * 冷却就按新倍率写进去,不必重开;缓存进模块常量就等于"改了要重启",调参面板也就白做了。
 * 充能系的 base 恒 0,除下来照样是 0,不必特判 —— 它的节奏在 chargeTime 那一边。
 *
 * 入参形状是 (def, level) 而不是 (cell):06 号支援设施的邻接加成只需在本函数里多读一步
 * "相邻格有没有供弹/散热设施",几十个调用点一个字都不用改。本轮不实现邻接。
 */
export function effectiveFireInterval(def: TowerDef, level: number): number {
  return towerFireInterval(def, level) / safeScale(tuning.towerFireRateScale);
}

/**
 * 实际单次伤害 = 数值表的等级取值 × 全局伤害倍率,同样每次现读 tuning。
 * 倍率允许为 0(全场零伤害是个可逆、可理解的调试态),但**负数与 NaN 一律当 0**:
 * 负伤害等于给敌人回血,NaN 更会顺着 hp 一路污染到 checksum,而那是确定性口径的根。
 * 06 号的邻接加成同样从这里进(见 effectiveFireInterval 的那段)。
 */
export function effectiveDamage(def: TowerDef, level: number): number {
  const scale = tuning.towerDamageScale;
  return towerDamage(def, level) * (scale > 0 ? scale : 0);
}

/**
 * 实际落点 AoE 伤害 = 数值表的等级取值 × 全局伤害倍率。倍率口径与 effectiveDamage 一字不差
 * (0 允许、负数与 NaN 一律当 0):同一个旋钮在直击与落点上给出两种答案是说不通的。
 *
 * 单开一个包装而不是让开火侧直接读 towerAoeDamage:迫击炮的 def.damage 恒 0
 * (途中不碰撞,伤害全在落点),少了这一层,面板上的 towerDamageScale 就会漏掉六塔里的一座 ——
 * 而"全局倍率只在本文件现乘"正是数据表不必认识 config 的前提(倍率写进 data/towers 就成环了)。
 * 06 号的邻接加成同样从这里进(见 effectiveFireInterval 的那段)。
 */
export function effectiveAoeDamage(def: TowerDef, level: number): number {
  const scale = tuning.towerDamageScale;
  return towerAoeDamage(def, level) * (scale > 0 ? scale : 0);
}
