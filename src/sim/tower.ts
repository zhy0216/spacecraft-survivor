/**
 * 塔的节流状态机(改版 05 号 —— 甲板删除后的重写)—— 三套**机制上互不相同**的开火节奏。
 * 本文件是全仓唯一推进 slot.cooldown / ammo / reloadLeft / heat / coolLock / charge
 * 这六个运行期读数的地方(槽位只负责它们的生灭,渲染层与 UI 只读)。
 *
 * 铁律 1:本目录永不 import pixi/DOM,也不用 Math.random —— 三套机制全是"逐帧累减/累加 + 阈值"的
 *   确定性算术,同 seed 必然复现;喂一个槽 + 一份 def 就能在 Node 里把每一帧钉住。
 * 铁律 3:状态**扁平挂在 WeaponSlot 上**(与旧 DeckCell 同一条分工:槽位是那块状态的房东,
 *   推进它的规则住在这里),本文件不新建任何对象、不留任何跨帧容器。
 *
 * 依赖方向刻意只有一条:本文件 `import type { WeaponSlot }`(**类型 import,编译后整条消失**),
 * 而 armory.ts 一个字都不认识本文件 —— 运行期依赖图上没有 tower ↔ armory 这条边。
 *
 * 三套为什么必须**机制上**可区分(与旧版一字同源):它们是支援设施的三个作用锚点
 * (供弹 / 散热 / 电容),合并成一个旋钮,支援就只剩一种可做。三者的特征定死如下 ——
 *   弹药 THR_AMMO   :突发满速,弹夹见底**必然停火一整段**(硬停顿,时长与射速无关);
 *   过热 THR_HEAT   :**点射就永不停火**,只有贪连射才被罚(收支平衡点就是它的全部手感);
 *   充能 THR_CHARGE :攒-放,节奏只由 chargeTime 给,**与射速旋钮完全无关**;满 1.0 停着等目标。
 *
 * 改版后的取值链路:四个 slot* 包装(slotFireInterval / slotReload / slotHeatMax /
 * slotChargeTime)是全仓唯一读 EdictBuffs 的地方 —— 塔的每一处取值都必须从它们进,
 * 别处再算一遍就是第二条取值链路。聚合本身由 sim/edictBuffs.ts 全船重算,本文件只读不写。
 *
 * —— 支援并入法令后的签名收敛(用户设计会)——
 * 旧版每个开火相关函数都拖着一条 edictMul / heatMaxEdictMul 的尾巴(支援走 buffs、法令走散参,
 * 两条取值链路并行)。两套被动合并成一套之后,**法令的倍率已经在 EdictBuffs 里**,
 * 那些散参整批删除:本文件的每一处取值只有 buffs 一个来源,调用方也不再需要
 * "按槽上节流系挑一个法令倍率传进来"这一步(挑系那件事在聚合里按 throttle 折过了)。
 *
 * 旧版的受击射速惩罚(fireMul / edgePenalty)随甲板四舷一起删除:
 * 被撞舷"顿一下"的反馈不再存在,惩罚倍率在签名里随之消失 —— 档位由 4 个(数值/受击/支援/法令)
 * 收成 3 个(数值/支援/法令),effectiveFireInterval 的 fireMul 参数保留为恒 1 的保留位
 * (将来若再做"全局减速"类效果,从那个位置进,不必改调用点)。
 */
import { SIM_DT } from '../core/loop';
import {
  FX_BULLET,
  FX_MORTAR,
  THR_AMMO,
  THR_CHARGE,
  THR_HEAT,
  type TowerDef,
  towerAoeDamage,
  towerBurst,
  towerChargeTime,
  towerDamage,
  towerFireInterval,
  towerHeatMax,
  towerMagazine,
  TOWERS,
} from '../data/towers';
import type { WeaponSlot } from './armory';
import { tuning } from './config';
import type { EdictBuffs } from './edictBuffs';

/**
 * 计时到期的判据容差(秒),与 enemy.ts 的 TIMER_EPS 一字同源:
 * cooldown / reloadLeft / coolLock 都是逐帧减 dt 的浮点累减,1.5s 这种 dt 整数倍的时长
 * 减完会落在 ±1e-16 上,不兜住就会随机多出一帧 —— 而"装填恰好 reload/SIM_DT 帧"
 * 正是弹药系那条硬停顿的全部可信度。1e-9 远小于一帧(1/60 s),只吃得掉浮点残差、吃不掉真帧。
 * charge 是反向累加,用的是同一个容差(见 stepThrottle 的充能分支)。
 */
export const THROTTLE_EPS = 1e-9;

/**
 * 全局射速倍率的下限。倍率是面板上的旋钮,拖到 0 会让 fireInterval 变成 Infinity 并写进 slot.cooldown,
 * 而 `Infinity - dt` 恒为 Infinity —— 那座塔此后再也减不回来(NaN 更会顺着 checksum
 * 把整局的确定性口径搅烂),连 stepCooldown 那道夹取都救不了它:上限本身就是 Infinity。
 * 夹一个正下限:0 附近的语义仍然是"慢到几乎不开火",但一切都是可逆的。
 */
const SCALE_MIN = 1e-3;

/**
 * 倍率取值。写成 `v > SCALE_MIN ? ... : ...` 而不是判它小于下限,是 data/towers 的 clampLevel 同一手:
 * **NaN 与任何数比较都是 false**,于是面板上敲进来的一个空值也一并落到下限,不会顺着除法污染全场。
 */
function safeScale(v: number): number {
  return v > SCALE_MIN ? v : SCALE_MIN;
}

/**
 * 这个槽上的塔定义;没有塔(或塔型非法)返回 undefined。
 * 只看 type 不看别的:**type === -1 就是槽位对"这里没有武器"的唯一表达**
 * (createWeaponSlots 的初值、World 清空槽位两处一致),而 TOWERS[-1] 与 TOWERS[1.5]
 * 在 noUncheckedIndexedAccess 下本就是 undefined,一次取表即可。
 */
export function slotTowerDef(slot: WeaponSlot): TowerDef | undefined {
  return TOWERS[slot.type];
}

/*
 * —— 支援聚合后的取值(改版 06 号)——
 * 四个包装一律 (slot, def, buffs) 入参:等级从槽上取、聚合倍率也从参数进,
 * 于是调用点只需要"这一个槽 + 这份表 + 这一帧的聚合"就问得出实际读数,
 * 不必知道倍率从哪来、是乘还是除、要不要过下限保护。
 * 聚合的系限定档(buffs.fireRateMul 等按下标 THR_* 直取)在**没有支援的甲板上全是 1**,
 * 故四个包装与旧链路在无支援时逐位一字不差(乘 1 / 除 1 在 IEEE754 下是恒等)。
 */

/**
 * 这个槽的实际射击间隔(秒/次)= 等级取值 ÷ 全局倍率 ÷ **法令聚合**。
 * 弹药协议 fireRateMul = 1.25 ⇒ 机炮 0.4s → 0.32s(2 层 = 1.25² ⇒ 0.256s)。
 * 两个旋钮各除各的,理由见 effectiveFireInterval。
 * @param fireMul 保留位(旧版受击惩罚的倍率),恒 1 —— 见文件头那段"惩罚随四舷删除"的说明。
 */
export function slotFireInterval(slot: WeaponSlot, def: TowerDef, buffs: EdictBuffs, fireMul = 1): number {
  return effectiveFireInterval(def, slot.stars, fireMul, buffs.fireRateMul[def.throttle]!);
}

/**
 * 这个槽的实际装填时长(秒)= 数值表的 reload × 支援聚合(弹药库 0.7 = 短三成)。
 * **乘法而不是"每座 -30%"的加法**(聚合口径里"倍率一律连乘"那条):两座弹药库 = 0.7² = 0.49,
 * 而加法在四座时会把装填推成负数 —— 负的 reloadLeft 让 canFire 当场放行,
 * 那门炮此后再也不装填,弹药系的硬停顿整条消失。
 * 不随等级成长:GDD §5.4 的成长档里没有装填这一项(弹夹是加法档,装填是定值)。
 */
export function slotReload(_slot: WeaponSlot, def: TowerDef, buffs: EdictBuffs): number {
  return def.reload * buffs.reloadMul[def.throttle]!;
}

/**
 * 这个槽的实际过热上限 = 等级取值 × 法令聚合(散热协议 1.5 = 能连烧半倍久)。
 * 渲染层的热量条分母读的也是它:分子(slot.heat)夹在这个上限里,两边同源才不会画出框。
 */
export function slotHeatMax(slot: WeaponSlot, def: TowerDef, buffs: EdictBuffs): number {
  return towerHeatMax(def, slot.stars) * buffs.heatMaxMul[def.throttle]!;
}

/**
 * 这个槽的实际蓄力时长(秒)= 等级取值 ÷ 支援聚合(电容组 1.3 = 攒快三成)。
 * 聚合里存的是**充能速度**倍率(> 1 = 更快)而不是时长倍率,与 fireRateMul 同一口径:
 * 数据表里四个倍率一律"越大越好",看表的人不必逐行想这一档到底是乘还是除。
 * 除数过一遍 safeScale:与 effectiveFireInterval 同一道保护 —— 倍率被填成 0 会算出
 * Infinity 的蓄力时长,那座塔此后一帧都攒不起来,而且从画面上完全看不出是表填错了。
 */
export function slotChargeTime(slot: WeaponSlot, def: TowerDef, buffs: EdictBuffs): number {
  return towerChargeTime(def, slot.stars) / safeScale(buffs.chargeRateMul[def.throttle]!);
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
 * 第三条同源的理由属于支援聚合:上限走 slotFireInterval(从聚合取倍率),于是**买下弹药库
 * 那一刻正在走的这一轮冷却当场变短** —— 不夹的话"射速 +25%"要等这一发的旧冷却走完才看得见,
 * 而购买正是玩家最盯着看反馈的那一帧。
 */
function stepCooldown(slot: WeaponSlot, def: TowerDef, dt: number, buffs: EdictBuffs): void {
  if (slot.cooldown <= 0) return;
  const max = slotFireInterval(slot, def, buffs);
  if (slot.cooldown > max) slot.cooldown = max;
  slot.cooldown -= dt;
  if (slot.cooldown <= THROTTLE_EPS) slot.cooldown = 0;
}

/**
 * 推进一个槽的节流一逻辑帧。**有没有目标都要跑** —— 装填、降温、蓄力都在这里:
 * 只在有目标时推进,弹药塔就会"没敌人时永远装不完",充能塔也攒不出那一发迎面的抢跳。
 * 调用方(sim/turret.ts)先按 type = -1 挡掉空槽:空槽没有节流可言。
 * @param buffs 本帧的法令聚合(sim/edictBuffs.ts 现算):四个 slot* 包装的倍率来源。
 */
export function stepThrottle(slot: WeaponSlot, def: TowerDef, dt: number, buffs: EdictBuffs): void {
  switch (def.throttle) {
    case THR_AMMO: {
      // 冷却与装填**并行**推进:装填完毕那一帧就该能开火,不再叠一层射击间隔。
      // (reload 1.5s 远长于 fireInterval,并行只是为了这条语义不依赖数值大小)
      stepCooldown(slot, def, dt, buffs);
      if (slot.reloadLeft > 0) {
        // 剩余装填每帧现夹在**当前**装填时长之内,理由与 stepCooldown 那道夹取一字同源:
        // 买下弹药库,正在走的这一轮装填当场变短;不夹的话"装填 -30%"要等这一轮 1.5s 走完
        // 才看得见,而那正是玩家盯着看反馈的那一秒半。
        const max = slotReload(slot, def, buffs);
        if (slot.reloadLeft > max) slot.reloadLeft = max;
        slot.reloadLeft -= dt;
        if (slot.reloadLeft <= THROTTLE_EPS) {
          slot.reloadLeft = 0;
          // 按**当前**等级满弹:装填途中升了级,这一夹就直接吃到新弹夹上限(GDD §5.4 的成长看得见)
          slot.ammo = towerMagazine(def, slot.stars);
        }
      }
      break;
    }

    case THR_HEAT: {
      stepCooldown(slot, def, dt, buffs);
      // 降温**任何时候都在跑**,含强制冷却期间:UI 的热量条因此一直在往下走,
      // 玩家看得见"还剩多久能打",而不是锁死期间冻在顶上、解锁那一刻突然归零。
      if (slot.heat > 0) {
        slot.heat -= def.coolPerSec * dt;
        if (slot.heat < 0) slot.heat = 0;
      }
      if (slot.coolLock > 0) {
        slot.coolLock -= dt;
        if (slot.coolLock <= THROTTLE_EPS) {
          slot.coolLock = 0;
          // 罚满了就**从零起手**:惩罚时长是设计者定的那一个数(overheatLock),
          // 不该再取决于 coolPerSec 顺带降到了几 —— 两个旋钮各管各的,调一个不会牵动另一个
          slot.heat = 0;
        }
      }
      break;
    }

    case THR_CHARGE: {
      // 充能系**没有冷却**:slot.cooldown 从安装的初值 0 起就再没人写过非 0(onFired 也恒写 0),
      // 故这里连清零都不必 —— 热循环里不放一句注定为真的赋值。UI 的"充能系 cooldown 恒 0"由此成立。
      // 电容组的加成也从这里进(slotChargeTime 现读聚合的 chargeRateMul):蓄力是充能系的
      // **全部**节奏,加成不进这一句就等于电容组对磁轨完全无效
      const t = slotChargeTime(slot, def, buffs);
      if (t > 0) {
        slot.charge += dt / t;
        // 满了就**精确停在 1.0**(而不是留个 0.9999…):UI 的充能环要能画满,
        // canFire 那边也才能干干净净地比 `>= 1`。这一夹同时就是"满充后停着等目标"——
        // 无目标也照常蓄、蓄满不外溢,于是目标一进射界就是当场一发,而不是再等一个周期
        if (slot.charge >= 1 - THROTTLE_EPS) slot.charge = 1;
      } else {
        // chargeTime 被调成 0(或负)= 取消蓄力:当场满充,而不是吐出 NaN/Infinity 把塔弄死。
        // 与弹药系 reload 调 0 的兜底同口径 —— "改数据文件即可调平衡"里也包含"调过头也不许崩"
        slot.charge = 1;
      }
      break;
    }

    default:
      // 未知节流(数值表被改坏)退化成纯冷却:这样的塔至少还打得响,便于当场看出是表填错了
      stepCooldown(slot, def, dt, buffs);
      break;
  }
}

/**
 * 这一帧允许开火吗。**只问节流**:射界、瞄准容差、有没有目标由 sim/turret.ts 在外面判,
 * 三道门槛各管各的,才能在单测里分别钉住(节流用例不必造一只敌人)。
 * 三个分支读的字段两两不交 —— 这就是"三套机制不是同一个 cooldown 换皮"的机械形式。
 */
export function canFire(slot: WeaponSlot, def: TowerDef): boolean {
  switch (def.throttle) {
    // 装填中一律不许开火(哪怕弹夹上限刚被升级抬高),这就是弹药系那段硬停顿
    case THR_AMMO:
      return slot.reloadLeft <= 0 && slot.ammo > 0 && slot.cooldown <= 0;
    // 过热锁死期间一律不许开火;没锁死就只看射击间隔 —— 于是点射永远打得出去
    case THR_HEAT:
      return slot.coolLock <= 0 && slot.cooldown <= 0;
    // 攒满才放,与射击间隔无关(充能系的 fireInterval 恒 0,压根没有那个旋钮)
    case THR_CHARGE:
      return slot.charge >= 1;
    default:
      return slot.cooldown <= 0;
  }
}

/**
 * 刚刚开了一火:把代价记在自己那套机制上。**必须与真的开火一一对应**
 * (sim/turret.ts 在按 def.fx 分派完开火表现之后立刻调它)——
 * 少调一次就是白嫖一发,多调一次就是凭空扣掉一发弹药/一份热量。
 * @param shots 这一次打出去几发(机炮 Lv3 双管 = 2,见 towerBurst)。
 *   连发的代价按发算:不乘 shots 就等于"升到 Lv3 之后多出来的那一发是免费的",
 *   弹夹与热量这两套机制会随着等级悄悄变弱 —— 而它们正是支援设施要作用的锚点。
 * @param buffs 本帧的法令聚合:只进射击间隔与热上限两个"大小"档
 *   (弹药协议的射速 / 散热协议的热上限),单发的代价与装填一个字不碰 —— 法令是"打得更快/
 *   连烧更久",不是"更省弹药/更不发热"。
 */
export function onFired(slot: WeaponSlot, def: TowerDef, shots: number, buffs: EdictBuffs): void {
  // 至少算一发:调用点就是"确实开火了"那一处,传 0/NaN 进来会让弹夹永不见底 = 节流形同虚设
  const n = shots > 1 ? Math.floor(shots) : 1;

  switch (def.throttle) {
    case THR_AMMO: {
      slot.cooldown = slotFireInterval(slot, def, buffs);
      slot.ammo -= n;
      if (slot.ammo <= 0) {
        slot.ammo = 0; // 夹 0:UI 直接把这个整数印出来,不能出现 -1 发
        // 判据也走包装:写 `def.reload > 0` 而按聚合后的时长去装填,两个数就会在
        // reloadMul 把它压到 0(或表被填成负数)时分叉 —— 那时塔会带着一个 ≤ 0 的 reloadLeft
        // 进"装填中",canFire 当场放行,弹夹却永远填不回来。一个数只算一次
        const reload = slotReload(slot, def, buffs);
        if (reload > 0) {
          slot.reloadLeft = reload;
        } else {
          // 装填时间被调成 0 = 无停顿:当场满弹,而不是留下一座弹夹恒 0、永远打不响的塔
          slot.ammo = towerMagazine(def, slot.stars);
        }
      }
      break;
    }

    case THR_HEAT: {
      slot.cooldown = slotFireInterval(slot, def, buffs);
      slot.heat += def.heatPerShot * n;
      // 散热器抬的是**上限**(slotHeatMax),不是每发热量:于是"能连烧多久"变长,
      // 而单发的代价一个字不变 —— 与 GDD §5.3 那行"过热上限 +50%"逐字对应
      const max = slotHeatMax(slot, def, buffs);
      if (slot.heat >= max) {
        // 夹到上限而不是让它冲过头:热量条是 heat / heatMax,超过 1 的条会画到框外面去
        slot.heat = max;
        slot.coolLock = def.overheatLock;
      }
      break;
    }

    case THR_CHARGE:
      // 一次放空,与打了几发无关:充能系的"发数"是同一次泄放的表现,不是攒了几管电
      slot.charge = 0;
      // 恒 0,且**不读 fireInterval** —— 充能系的节奏只有 chargeTime 一个旋钮,
      // 哪天有人往表里填了非 0 的 fireInterval(data/towers.test.ts 那条断言是第一道防线),
      // 这里也不许它插一脚变成两个旋钮打架
      slot.cooldown = 0;
      break;

    default:
      slot.cooldown = slotFireInterval(slot, def, buffs);
      break;
  }
}

/**
 * 实际射击间隔(秒/次)= 数值表的等级取值 ÷ 全局射速倍率。
 * **每次调用现读 tuning**(与 stepShip / stepEnemyBehavior 同口径):面板拖一下,下一次开火的
 * 冷却就按新倍率写进去,不必重开;缓存进模块常量就等于"改了要重启",调参面板也就白做了。
 * 充能系的 base 恒 0,除下来照样是 0,不必特判 —— 它的节奏在 chargeTime 那一边。
 *
 * 入参形状是 (def, level) 而不是 (slot):支援聚合因此只是**多一个参数**,
 * 与"哪一个槽"完全解耦 —— 从聚合取那个数这一步收在 slotFireInterval 一处(见上面那组包装),
 * 而不需要本函数认识 WeaponSlot 的字段布局。
 *
 * @param fireMul 保留位(旧版受击射速惩罚),缺省 1 = 无惩罚。它是"外部事件让塔顿一下"
 *   这类效果的预留通道,今天恒 1(见文件头)。
 * @param buffMul **法令聚合**倍率(弹药协议 1.25 = 快两成半;2 层 = 1.25²),缺省 1 = 没有生效的法令。
 *   正常调用方一律不直接传它 —— 走 slotFireInterval 从聚合取,免得"加成"在第二处被算一遍。
 *
 * 三个旋钮**各除各的、各自过一遍 safeScale**,而不是先乘成一个数再除:它们分别是数值面板、
 * 船体状态、法令聚合的函数,合并之后任何一边被填坏(0/NaN)都会顺着乘法把另外两边一起吞掉
 * (NaN × 有限数还是 NaN),而下限保护也只剩一道、护不住各自的量级。
 * 射速的唯一去处就是这一条式子:另开一份"加成后的间隔"必然与 stepCooldown 那道夹取错开口径。
 */
export function effectiveFireInterval(def: TowerDef, level: number, fireMul = 1, buffMul = 1): number {
  return (
    towerFireInterval(def, level) /
    safeScale(tuning.towerFireRateScale) /
    safeScale(fireMul) /
    safeScale(buffMul)
  );
}

/**
 * 实际单次伤害 = 数值表的等级取值 × 全局伤害倍率 × **法令伤害倍率**,同样每次现读 tuning。
 * 倍率允许为 0(全场零伤害是个可逆、可理解的调试态),但**负数与 NaN 一律当 0**:
 * 负伤害等于给敌人回血,NaN 更会顺着 hp 一路污染到 checksum,而那是确定性口径的根。
 * @param damageMul 法令聚合的全武器伤害倍率(超载协议 1.15;2 层 = 1.15²),缺省 1 = 未持有。
 *   它与 tuning 那个旋钮**各过各的门**(同一手 `> 0 ? : 0`):一边被填坏不许把另一边一起吞掉。
 */
export function effectiveDamage(def: TowerDef, level: number, damageMul = 1): number {
  const scale = tuning.towerDamageScale;
  return towerDamage(def, level) * (scale > 0 ? scale : 0) * (damageMul > 0 ? damageMul : 0);
}

/**
 * 实际落点 AoE 伤害 = 数值表的等级取值 × 全局伤害倍率。倍率口径与 effectiveDamage 一字不差
 * (0 允许、负数与 NaN 一律当 0):同一个旋钮在直击与落点上给出两种答案是说不通的。
 *
 * 单开一个包装而不是让开火侧直接读 towerAoeDamage:迫击炮的 def.damage 恒 0
 * (途中不碰撞,伤害全在落点),少了这一层,面板上的 towerDamageScale 就会漏掉六塔里的一座 ——
 * 而"全局倍率只在本文件现乘"正是数据表不必认识 config 的前提(倍率写进 data/towers 就成环了)。
 */
export function effectiveAoeDamage(def: TowerDef, level: number, damageMul = 1): number {
  const scale = tuning.towerDamageScale;
  return towerAoeDamage(def, level) * (scale > 0 ? scale : 0) * (damageMul > 0 ? damageMul : 0);
}

/**
 * 一次开火实际打出几发 —— sim/turretFire.ts 与 HUD 理论 DPS 的**同一份**口径。
 * 两个来源相乘:恒发数(def.burst,风暴机炮"双管齐射"/焦土骤雨"三连发"的合成签名,0 = 恒 1)
 * × Lv3 跳变(towerBurst,机炮双管)。今天两档不会同时非 1(合成武器不叠等级跳变,
 * 基塔不带恒发),乘积与"各自单独生效"逐位一致;将来真有塔两档都占,乘法也是唯一说得通的叠法
 * (恒发的每一管都吃跳变)。FX_MORTAR 只认恒发数(fireMortar 的口径:三连发是同一次蓄力的表现,
 * 不叠等级跳变);光束/链电/磁轨恒 1(一次结算就是"一发",代价按发算)。
 */
export function slotShotsPerFire(def: TowerDef, level: number): number {
  const constant = def.burst > 0 ? def.burst : 1;
  if (def.fx === FX_BULLET) return constant * towerBurst(def, level);
  if (def.fx === FX_MORTAR) return constant;
  return 1;
}

/**
 * 这个槽的**理论持续 DPS**(对单目标)—— HUD 火力面板的那一个固定数字。
 * "固定"指它只是 (等级, 法令聚合, tuning) 的纯函数:升级/拿法令/拖面板才变,
 * 打没打中不变 —— 与实时账(World.dpsOf 的平滑读数)是两码事,后者只喂局末战报的峰值。
 * "持续"指含整个节流周期:弹药系摊上装填硬停顿,过热系摊上贪连射的锁死罚时,充能系就是攒-放
 * —— 三套机制的取舍在这一个数字里可比(点防 18.5 > 机炮 13.2,虽然单发更轻)。
 * "单目标"指链跳/穿透/AoE 溅射一律不计:多目标收益随场面波动,不属于"固定数值"的口径
 * (迫击炮取落点伤害 —— 单目标吃的就是那一份,def.damage 恒 0)。
 * 数值全走 slot* 包装与 effective*(法令/tuning 各过各的门),别处不许再算第二遍。
 */
export function slotSustainedDps(slot: WeaponSlot, def: TowerDef, buffs: EdictBuffs): number {
  const shots = slotShotsPerFire(def, slot.stars);
  const dmg =
    def.fx === FX_MORTAR
      ? effectiveAoeDamage(def, slot.stars, buffs.damageMul)
      : effectiveDamage(def, slot.stars, buffs.damageMul);
  const perFire = shots * dmg;
  let dps: number;

  switch (def.throttle) {
    case THR_AMMO: {
      const interval = slotFireInterval(slot, def, buffs);
      if (!(interval > 0)) return 0; // 表被改坏(充能系才许 0 间隔),不除 0
      const reload = slotReload(slot, def, buffs);
      const magazine = towerMagazine(def, slot.stars);
      if (!(reload > 0) || !(magazine > 0)) {
        dps = perFire / interval; // 无装填(风暴机炮的买断/表调 0):硬停顿整条消失,纯射速
      } else {
        // 一整个弹夹周期:开火在 0, I, …, (F-1)I(每次耗 shots 发,F = ⌈M/shots⌉),
        // 见底那一刻起装填,下一夹的第一发等 max(装填, 冷却) —— 两者并行推进(stepThrottle 口径)
        const fires = Math.ceil(magazine / shots);
        dps = (fires * perFire) / ((fires - 1) * interval + Math.max(reload, interval));
      }
      break;
    }

    case THR_HEAT: {
      const interval = slotFireInterval(slot, def, buffs);
      if (!(interval > 0)) return 0;
      const burstDps = perFire / interval;
      // 满速连射的净热速率:≤ 0 = 收支平衡,永不停火(激光半速点射的分水岭、极光"无过热"签名)
      const heatRate = (def.heatPerShot * shots) / interval - def.coolPerSec;
      const heatMax = slotHeatMax(slot, def, buffs);
      if (heatRate <= 0 || !(heatMax > 0) || !(def.overheatLock > 0)) {
        dps = burstDps;
      } else {
        // 稳态周期:0 → 顶要 heatMax/净速率 秒(锁死到点热量归零,每一轮都从零起手),罚 overheatLock 秒
        const firing = heatMax / heatRate;
        dps = (burstDps * firing) / (firing + def.overheatLock);
      }
      break;
    }

    case THR_CHARGE: {
      // 攒-放的全部节奏就是蓄力时长;表调 0 = 当场满充(stepThrottle 兜底),封在一帧一发
      const t = slotChargeTime(slot, def, buffs);
      dps = perFire / (t > SIM_DT ? t : SIM_DT);
      break;
    }

    default: {
      const interval = slotFireInterval(slot, def, buffs);
      dps = interval > 0 ? perFire / interval : 0;
      break;
    }
  }
  return Number.isFinite(dps) && dps > 0 ? dps : 0;
}

// —— 下一次发射读数(HUD 火力面板的 CD 列)——
// 三套节流各自的"还要等多久":装填/锁死/蓄力是玩家该盯的三种硬等待,普通冷却只是射速的间隙。
export const FIRE_READY = 0; // 当下就能开火
export const FIRE_COOLDOWN = 1; // 射击间隔未走完
export const FIRE_RELOAD = 2; // 弹药系:装填中
export const FIRE_LOCKED = 3; // 过热系:锁死罚时中
export const FIRE_CHARGING = 4; // 充能系:蓄力中

export interface FireReadout {
  /** FIRE_* */
  state: number;
  /** 距下一次能开火的秒数(READY 恒 0) */
  seconds: number;
  /** 就绪进度 0..1(1 = 可开火;HUD 的小条按它填充) */
  ratio: number;
}

function clamp01(v: number): number {
  return v > 0 ? (v < 1 ? v : 1) : 0;
}

/**
 * 这个槽"下一次发射"读数,写进调用方给的 out(HUD 每帧逐槽问,零分配)。
 * 判序与 canFire 一字同源(装填/锁死/蓄满是各系的放行门,冷却排在其后):
 * 读数与放行判据分叉的话,面板印着"就绪"炮却哑着,那读数就成了谎话。
 * 进度分母全走 slot* 包装(当前等级/法令下的实际时长),与 stepThrottle 的逐帧夹取同源。
 */
export function slotFireReadout(
  slot: WeaponSlot,
  def: TowerDef,
  buffs: EdictBuffs,
  out: FireReadout,
): FireReadout {
  out.state = FIRE_READY;
  out.seconds = 0;
  out.ratio = 1;

  switch (def.throttle) {
    case THR_AMMO:
      if (slot.reloadLeft > 0) {
        const max = slotReload(slot, def, buffs);
        out.state = FIRE_RELOAD;
        out.seconds = slot.reloadLeft;
        out.ratio = max > 0 ? clamp01(1 - slot.reloadLeft / max) : 0;
      } else if (slot.cooldown > 0) {
        const max = slotFireInterval(slot, def, buffs);
        out.state = FIRE_COOLDOWN;
        out.seconds = slot.cooldown;
        out.ratio = max > 0 ? clamp01(1 - slot.cooldown / max) : 0;
      }
      break;

    case THR_HEAT:
      if (slot.coolLock > 0) {
        out.state = FIRE_LOCKED;
        out.seconds = slot.coolLock;
        out.ratio = def.overheatLock > 0 ? clamp01(1 - slot.coolLock / def.overheatLock) : 0;
      } else if (slot.cooldown > 0) {
        const max = slotFireInterval(slot, def, buffs);
        out.state = FIRE_COOLDOWN;
        out.seconds = slot.cooldown;
        out.ratio = max > 0 ? clamp01(1 - slot.cooldown / max) : 0;
      }
      break;

    case THR_CHARGE:
      if (slot.charge < 1) {
        out.state = FIRE_CHARGING;
        out.seconds = clamp01(1 - slot.charge) * slotChargeTime(slot, def, buffs);
        out.ratio = clamp01(slot.charge);
      }
      break;

    default:
      if (slot.cooldown > 0) {
        const max = slotFireInterval(slot, def, buffs);
        out.state = FIRE_COOLDOWN;
        out.seconds = slot.cooldown;
        out.ratio = max > 0 ? clamp01(1 - slot.cooldown / max) : 0;
      }
      break;
  }
  // 坏状态(NaN 计时器)不外漏成 NaN 文本/宽度:读数一律有限
  if (!Number.isFinite(out.seconds) || out.seconds < 0) out.seconds = 0;
  if (!Number.isFinite(out.ratio)) out.ratio = 0;
  return out;
}
