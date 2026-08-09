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
 *
 * 06 号支援设施接入之后,本文件又多了一条唯一性:**四个 cell* 包装
 * (cellFireInterval / cellReload / cellHeatMax / cellChargeTime)是全仓唯一读
 * cell 上那四个邻接 buff 缓存的地方**,塔的每一处取值都必须从它们进 ——
 * stepCooldown 的夹取上限、onFired 的三处冷却与装填/热上限、stepThrottle 的充能与装填夹取,
 * 连渲染层的热量条/装填条也读同一份。别处再算一遍就是第二条取值链路,而漏掉的那一处
 * 永远读的是"隔壁没有设施"的数 —— 这类漏网只在"放下设施之后的某个特定分支"里才现形。
 * 缓存本身由 sim/support.ts 全甲板重算(邻接规则住在那边),本文件只读不写:
 * 取值规则住在这边,两边各只有一份,谁都不必知道对方是怎么算的。
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

/*
 * —— 邻接加成后的取值(06 号 issue T2)——
 * 四个包装一律 (cell, def) 入参:等级从格上取、加成也从格上取,于是调用点只需要"这一格 + 这份表"
 * 就问得出实际读数,不必知道加成从哪来、是乘还是除、要不要过下限保护。
 * 缓存(cell.fireRateMul / reloadMul / heatMaxMul / chargeRateMul)是 sim/support.ts 按
 * 正交邻接**连乘**出来的派生量,1 = 这一格没有任何相邻设施 —— 故四个包装在没有设施的甲板上
 * 与今天的链路逐位一字不差(乘 1 / 除 1 在 IEEE754 下是恒等),既有用例一条都不用改。
 */

/**
 * 这一格的实际射击间隔(秒/次)= 等级取值 ÷ 全局倍率 ÷ 受击惩罚 ÷ **邻接加成** ÷ 法令倍率。
 * 弹药库 fireRateMul = 1.25 ⇒ 机炮 0.4s → 0.32s。四个旋钮各除各的,理由见 effectiveFireInterval。
 * @param edictMul 法令的弹药系射速倍率(18 号曳光协议 = 1.1),缺省 1 = 未持有。sim/turret.ts
 *   按格上节流系挑好传入(非弹药系塔恒 1),本函数只认倍率、不认法令是谁。
 */
export function cellFireInterval(cell: DeckCell, def: TowerDef, fireMul = 1, edictMul = 1): number {
  return effectiveFireInterval(def, cell.level, fireMul, cell.fireRateMul, edictMul);
}

/**
 * 这一格的实际装填时长(秒)= 数值表的 reload × 邻接加成(弹药库 0.7 = 短三成)。
 * **乘法而不是"每座 -30%"的加法**(06 号约定里"四个倍率一律连乘"那条):两座弹药库夹一门炮
 * 是 0.7² = 0.49,而加法在四座围一门时会把装填推成负数 —— 负的 reloadLeft 让 canFire 当场放行,
 * 那门炮此后再也不装填,弹药系的硬停顿整条消失。
 * 不随等级成长:GDD §5.4 的成长档里没有装填这一项(弹夹是加法档,装填是定值),
 * 故这里只有 def.reload 而没有 towerXxx(def, level) —— 与另外三个包装的形状差异是数值表决定的,不是漏写。
 */
export function cellReload(cell: DeckCell, def: TowerDef): number {
  return def.reload * cell.reloadMul;
}

/**
 * 这一格的实际过热上限 = 等级取值 × 邻接加成 × 法令倍率。
 * 渲染层的热量条分母读的也是它:分子(cell.heat)夹在这个上限里,两边同源才不会画出框。
 * @param edictMul 法令的过热上限倍率(18 号散热协议 = 1.2),缺省 1 = 未持有;
 *   由 sim/turret.ts 按格上节流系挑好传入(非过热系塔恒 1)。
 */
export function cellHeatMax(cell: DeckCell, def: TowerDef, edictMul = 1): number {
  return towerHeatMax(def, cell.level) * cell.heatMaxMul * edictMul;
}

/**
 * 这一格的实际蓄力时长(秒)= 等级取值 ÷ 邻接加成(电容组 1.3 = 攒快三成)。
 * 缓存里存的是**充能速度**倍率(> 1 = 更快)而不是时长倍率,与 fireRateMul 同一口径:
 * 数据表里四个倍率一律"越大越好",看表的人不必逐行想这一档到底是乘还是除。
 * 除数过一遍 safeScale:与 effectiveFireInterval 同一道保护 —— 数值表被填成 0 会算出
 * Infinity 的蓄力时长,那座塔此后一帧都攒不起来,而且从画面上完全看不出是表填错了。
 */
export function cellChargeTime(cell: DeckCell, def: TowerDef): number {
  return towerChargeTime(def, cell.level) / safeScale(cell.chargeRateMul);
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
 *
 * 同一夹也是受击惩罚(fireMul)"不制造死亡螺旋"的机械保证:惩罚期内写进去的那个更长的冷却,
 * 在 0.5s 窗口结束的下一帧就被夹回基准间隔 —— 惩罚绝不会拖过它自己的窗口。
 * 故本函数**必须**收到与 onFired 同一个 fireMul:拿基准间隔来夹,惩罚期内写进去的长冷却
 * 会被当场夹回去,整条惩罚等于没有(09 号 T3 的射速惩罚会静默失效)。
 *
 * 第三条同源的理由属于 06 号:上限走 cellFireInterval(从格上取邻接加成),于是**放下弹药库
 * 那一刻正在走的这一轮冷却当场变短** —— 不夹的话"射速 +25%"要等这一发的旧冷却走完才看得见,
 * 而放置正是玩家最盯着看反馈的那一帧。
 */
function stepCooldown(
  cell: DeckCell,
  def: TowerDef,
  dt: number,
  fireMul: number,
  edictMul: number,
): void {
  if (cell.cooldown <= 0) return;
  const max = cellFireInterval(cell, def, fireMul, edictMul);
  if (cell.cooldown > max) cell.cooldown = max;
  cell.cooldown -= dt;
  if (cell.cooldown <= THROTTLE_EPS) cell.cooldown = 0;
}

/**
 * 推进一座塔的节流一逻辑帧。**有没有目标都要跑** —— 装填、降温、蓄力都在这里:
 * 只在有目标时推进,弹药塔就会"没敌人时永远装不完",充能塔也攒不出那一发迎面的抢跳。
 * 调用方(sim/turret.ts)先按 isTurretCell 挡掉离线塔:离线塔一切冻结(与 04 号炮管同口径),
 * 所以本函数不认识 online —— 它只管"这一帧的时间过去了,状态该走到哪"。
 * @param fireMul 受击射速惩罚倍率(09 号 T3),缺省 1 = 没被撞。见 effectiveFireInterval 那段。
 * @param edictMul 法令的弹药系射速倍率(18 号曳光协议),缺省 1 = 未持有。只进射击间隔:
 *   装填/降温/蓄力那几条腿一个字都不碰 —— 法令是"打得快",不是"装得快/凉得快"。
 */
export function stepThrottle(
  cell: DeckCell,
  def: TowerDef,
  dt: number,
  fireMul = 1,
  edictMul = 1,
): void {
  switch (def.throttle) {
    case THR_AMMO: {
      // 冷却与装填**并行**推进:装填完毕那一帧就该能开火,不再叠一层射击间隔。
      // (reload 1.5s 远长于 fireInterval,并行只是为了这条语义不依赖数值大小)
      stepCooldown(cell, def, dt, fireMul, edictMul);
      if (cell.reloadLeft > 0) {
        // 剩余装填每帧现夹在**当前**装填时长之内,理由与 stepCooldown 那道夹取一字同源:
        // 放下弹药库,正在走的这一轮装填当场变短;不夹的话"装填 -30%"要等这一轮 1.5s 走完
        // 才看得见,而那正是玩家盯着看反馈的那一秒半。反向也成立:设施被 12 号拆掉之后,
        // 塔不会带着一段"买来的短装填"跑完这一轮(上限当帧回到基准,只夹不涨)
        const max = cellReload(cell, def);
        if (cell.reloadLeft > max) cell.reloadLeft = max;
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
      // 惩罚只作用在射击间隔上,降温与锁死那两条腿一个字都不改:
      // 挨一下就连降温也变慢的话,被撞舷的过热塔会越挨越打不动 —— 那正是"死亡螺旋"本身
      stepCooldown(cell, def, dt, fireMul, edictMul);
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
      // 电容组的加成也从这里进(cellChargeTime 现读格上的 chargeRateMul):蓄力是充能系的
      // **全部**节奏,加成不进这一句就等于电容组对磁轨完全无效
      const t = cellChargeTime(cell, def);
      if (t > 0) {
        // 蓄力也乘 fireMul:充能系没有 cooldown 这条腿,不在这里乘,六塔里的迫击炮与磁轨
        // 就对受击**完全免疫** —— 被撞舷的三座塔里有两座照常输出,"被撞舷会顿一下"的反馈死掉一半。
        // 这与"充能系的节奏只由 chargeTime 给"不矛盾:fireMul 不是射速旋钮
        // (面板上的 towerFireRateScale 在 effectiveFireInterval 里,那条路对充能系照旧恒 0),
        // 它是**受击惩罚** —— 一次外部事件让这座塔顿 0.5s,与"塔本身多快"是两回事
        cell.charge += (dt * safeScale(fireMul)) / t;
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
      stepCooldown(cell, def, dt, fireMul, edictMul);
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
 * @param fireMul 受击射速惩罚倍率(09 号 T3),缺省 1 = 没被撞。**只进射击间隔**:
 *   惩罚期内挨的这一发照常扣一发弹药/一份热量,不多不少 —— 惩罚是"下一发慢一点",
 *   不是"这一发更贵",否则被撞舷会连带更快见底/更快过热,那就成了死亡螺旋。
 * @param edictMul 法令的弹药系射速倍率(18 号曳光协议),缺省 1 = 未持有。与 fireMul 同一条
 *   "只进射击间隔"的口径:法令是打得快,不是更省弹药/更不发热。
 * @param heatMaxEdictMul 法令的过热上限倍率(18 号散热协议),缺省 1 = 未持有。
 *   只进热上限(cellHeatMax):抬的是"能连烧多久",单发的代价一个字不变。
 */
export function onFired(
  cell: DeckCell,
  def: TowerDef,
  shots: number,
  fireMul = 1,
  edictMul = 1,
  heatMaxEdictMul = 1,
): void {
  // 至少算一发:调用点就是"确实开火了"那一处,传 0/NaN 进来会让弹夹永不见底 = 节流形同虚设
  const n = shots > 1 ? Math.floor(shots) : 1;

  switch (def.throttle) {
    case THR_AMMO: {
      cell.cooldown = cellFireInterval(cell, def, fireMul, edictMul);
      cell.ammo -= n;
      if (cell.ammo <= 0) {
        cell.ammo = 0; // 夹 0:UI 直接把这个整数印出来,不能出现 -1 发
        // 判据也走包装:写 `def.reload > 0` 而按加成后的时长去装填,两个数就会在
        // reloadMul 把它压到 0(或表被填成负数)时分叉 —— 那时塔会带着一个 ≤ 0 的 reloadLeft
        // 进"装填中",canFire 当场放行,弹夹却永远填不回来。一个数只算一次
        const reload = cellReload(cell, def);
        if (reload > 0) {
          cell.reloadLeft = reload;
        } else {
          // 装填时间被调成 0 = 无停顿:当场满弹,而不是留下一座弹夹恒 0、永远打不响的塔
          cell.ammo = towerMagazine(def, cell.level);
        }
      }
      break;
    }

    case THR_HEAT: {
      cell.cooldown = cellFireInterval(cell, def, fireMul, edictMul);
      cell.heat += def.heatPerShot * n;
      // 散热器抬的是**上限**(cellHeatMax),不是每发热量:于是"能连烧多久"变长,
      // 而单发的代价一个字不变 —— 与 GDD §5.3 那行"过热上限 +50%"逐字对应
      const max = cellHeatMax(cell, def, heatMaxEdictMul);
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
      cell.cooldown = cellFireInterval(cell, def, fireMul, edictMul);
      break;
  }
}

/**
 * 实际射击间隔(秒/次)= 数值表的等级取值 ÷ 全局射速倍率。
 * **每次调用现读 tuning**(与 stepShip / stepEnemyBehavior 同口径):面板拖一下,下一次开火的
 * 冷却就按新倍率写进去,不必重开;缓存进模块常量就等于"改了要重启",调参面板也就白做了。
 * 充能系的 base 恒 0,除下来照样是 0,不必特判 —— 它的节奏在 chargeTime 那一边。
 *
 * 入参形状是 (def, level) 而不是 (cell):06 号的邻接加成因此只是**多一个参数**,
 * 与"哪一格"完全解耦 —— 从格上取那个数这一步收在 cellFireInterval 一处(见上面那组包装),
 * 而不需要本函数认识 DeckCell 的字段布局。
 *
 * @param fireMul **受击射速惩罚**倍率(09 号 T3),缺省 1 = 没被撞;< 1 = 这一舷刚挨了一下,
 *   间隔按倍率变长。它是船体状态(world.edgePenalty)的函数,不是塔的属性,所以走参数而不是
 *   再读一次 tuning —— 本文件对甲板只剩类型依赖(见文件头),更不该反过来认识 World。
 * @param buffMul **邻接加成**倍率(06 号 T2:弹药库 1.25 = 快两成半),缺省 1 = 相邻没有生效的设施。
 *   正常调用方一律不直接传它 —— 走 cellFireInterval 从格上取,免得"加成"在第二处被算一遍。
 * @param edictMul **法令倍率**(18 号曳光协议 = 1.1,弹药系射速 +10%),缺省 1 = 未持有。
 *   与 buffMul 同一条路:sim/turret.ts 按格上节流系挑好传入(非弹药系恒 1),
 *   本函数只认倍率、不认法令是谁 —— 与 tuning 同一档"改数据即可调平衡"。
 *
 * 四个旋钮**各除各的、各自过一遍 safeScale**,而不是先乘成一个数再除:它们分别是数值面板、
 * 船体状态、甲板布局、法令集合的函数,合并之后任何一边被填坏(0/NaN)都会顺着乘法把另外
 * 三边一起吞掉(NaN × 有限数还是 NaN),而下限保护也只剩一道、护不住各自的量级。
 * 射速的唯一去处就是这一条式子:另开一份"加成后的间隔"必然与 stepCooldown 那道夹取错开口径。
 */
export function effectiveFireInterval(
  def: TowerDef,
  level: number,
  fireMul = 1,
  buffMul = 1,
  edictMul = 1,
): number {
  return (
    towerFireInterval(def, level) /
    safeScale(tuning.towerFireRateScale) /
    safeScale(fireMul) /
    safeScale(buffMul) /
    safeScale(edictMul)
  );
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
