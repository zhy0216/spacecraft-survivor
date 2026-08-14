/**
 * 世界状态与规则 —— 纯逻辑层。
 * 铁律:本目录永不 import pixi/DOM。这换来:同 seed 确定性、Node 里可单测、渲染可替换。
 *
 * 当前内容 = 玩家船(02)+ 四型敌人(07)+ 槽位武器与它们打出来的子弹(改版 05)+ 挨打这一半(改版 09)
 *   + 波次脚本出怪(08)+ 经验/星币双轨经济(改版 10/16)+ 整备商店(改版 21):
 *   一艘玩家船(输入只以纯数据 ShipCommand 从外部灌入,sim 永不读键盘),
 *   由 sim/waves.ts 的运行器按航段脚本从**船外环**刷出来的敌人,
 *   武器槽里的塔真的开火产生的子弹与可视化事件,
 *   以及贴上来的敌人对船体 HP 的结算。
 *
 * —— 甲板网格 → 固定槽位(改版,用户设计会)——
 * 甲板/格放置/邻接/焊接/空间进化全部删除,换成 **4 武器槽 + 4 支援槽**:
 *   武器从固定硬点开火、射界 = 固定槽位朝向 + 船头(船转向仍旋转所有射界,「转船找射界」
 *   的手感原样保留);支援 = 全船被动(聚合见 sim/support.ts);三把同型武器自动合成
 *   (data/merges.ts);整备 = 星币商店(买武器 / 买法令 / 付费修复 / 刷新货架)。
 *   槽位模型与槽位数学在 sim/armory.ts,本文件只做"世界这一层"的接线 —— 记账、合成、商店。
 *
 * 01 号 issue 那批"凭空重生的压测哑弹"在 05 号整段删除:哑弹与真弹共用一个池,
 * "500 弹同屏不掉帧"这条验收测的就是假东西 —— 500 弹现在得由塔真的打出来才算数。
 *
 * 分工:单只敌人的行为(追踪/绕行/冲锋状态机)在 sim/enemy.ts,炮管的追瞄与归位在 sim/turret.ts,
 * 子弹的积分与命中在 sim/bullet.ts,受击判定的全部几何(受击圆/支援减伤/HP 上限)在
 * sim/damage.ts,「脚本 → 出怪事件」的翻译在 sim/waves.ts(它一个字都不认识世界,只说"朝这个方向
 * 出一只这型的怪"),本文件只做"世界这一层"的接线 —— 出怪落点、邻居分离、积分位置、接触粗筛、
 * 开火的去处(FireSink)、船体受击结算、事件老化、死亡回收、掉落记账、槽位获得/合成/商店。
 * 拆开的理由是它们能脱开世界单测(见 enemy.test.ts / turret.test.ts / bullet.test.ts /
 * damage.test.ts),而这里钉的是顺序与生命周期。
 *
 * 局终这件事本文件只做到"判"为止(08 号 T3):帧尾的 settleOutcome 把胜负结论落成 result
 * 与一次 onGameOver,而**暂停、重开、动 loop、弹结算界面一概不在这里** ——
 * 世界不认识"游戏流程",那一层在 main.ts。于是有了结论之后 step() 照常可以被调用
 * (既有那条"船沉后世界照常往下跑"的用例仍然成立),停不停由调用方决定。
 * HP 上限与受击减伤问 damage.ts 的两个挂钩(改版 06 号支援聚合);
 * onEnemySpawn / onEnemyDeath 是一对对称的挂钩(渲染/统计想知道"谁来了、谁没了")。
 *
 * 掉落(改版 10 号)落在帧尾的 reap 里:每只死者当场掉一颗 XP 掉落物,面额按型取自数值表
 * (精英 ×3 / Boss ×12,见 spawnDrop);磁吸与收取的**全部规则**在 sim/drop.ts(它连世界都不认识,
 * 喂一个池 + 船心坐标就能单测),本文件照旧只做接线 —— 敌人死了往池里放一颗(spawnDrop)、
 * 把 stepDrops 结算出来的那笔账记进 scrap(经验增幅器的 xpMul 在 drop.ts 内部乘好)。
 * 星币(改版 16 号)与残骸不同源但同仓:**所有击杀**都当场进账 world.starCoins
 * (普通怪按型、精英 10、Boss 30,不造掉落物、不走磁吸),消费点 = 时停中的 rerollOffer(10 星币
 * 重掷三候选,每级最多一次)+ 整备商店(买武器 / 买法令 / 付费修复 / 刷新货架)。
 * 三选一经济(T2)同样只在这里接线:sim/upgrade.ts 负责生成合法候选(新武器 5% / 武器升级 25% /
 * 支援 35% / 法令 35%),本文件负责扣残骸、记升级次数、帧尾在够钱时弹出一次 offer。
 * 暂停/卡片/商店面板仍一概不在 World,那层在 main.ts。
 */
import { SIM_DT } from '../core/loop';
import { Pool } from '../core/pool';
import { Rng } from '../core/rng';
import { SpatialHash } from '../core/spatialHash';
import {
  AFFIX_ARMORED,
  AFFIX_FISSION,
  AFFIX_FRENZY,
  AFFIX_MAGNETIC,
  AFFIX_PHASED,
  AFFIXES,
  ELITE,
} from '../data/affixes';
import {
  DOCK_EDICT_COUNT,
  DOCK_EDICT_PRICE,
  DOCK_REPAIR_FRACTION,
  DOCK_REPAIR_PRICE,
  DOCK_SHOP_REFRESH_PRICE,
  DOCK_WEAPON_COUNT,
  DOCK_WEAPON_PRICE,
  DROP_MAX_ALIVE,
  MAGNET_PICKUP_RADIUS_MUL,
  MAGNET_PICKUP_SURGE,
  REFIT_HEAL_FRACTION,
  REROLL_PRICE,
  SHOP_BEACON_LIFETIME,
  SHOP_BEACON_MAX_DIST,
  SHOP_BEACON_MIN_DIST,
  SHOP_BEACON_RADIUS,
  shopDiscountPrice,
  skipRefundFor,
  STARTING_STAR_COINS,
  upgradeCost as economyUpgradeCost,
  UPGRADE_OFFER_COOLDOWN,
} from '../data/economy';
import { BOSS, ENEMIES, KIND_BOSS, KIND_BEETLE, KIND_STRAFER, KIND_SWARM, KIND_TRAILER } from '../data/enemies';
import {
  createEdictLevels,
  edictCanStack,
  edictLevel,
  EDICT_KIND_COUNT,
  EDICTS,
} from '../data/edicts';
import {
  isMergeResult,
  mergeResultOf as dataMergeResultOf,
} from '../data/merges';
import {
  THR_AMMO,
  THR_CHARGE,
  THR_HEAT,
  TOWER_KIND_COUNT,
  STAR_MAX,
  towerMagazine,
  TOWERS,
} from '../data/towers';
import { UNLOCK_EDICT, UNLOCK_TOWER, UNLOCKS } from '../data/unlocks';
import { SPAWN_RADIUS, SPAWN_RADIUS_BAND, WAVE_MAX_ALIVE } from '../data/waves';
import {
  createWeaponSlots,
  slotMaxStars,
  slotStarCount,
  swapWeaponSlots,
  type WeaponSlot,
  WEAPON_HARDPOINTS,
  WEAPON_SLOT_COUNT,
} from './armory';
import { type Bullet, createBullet, resetBullet, stepBullets } from './bullet';
import { tuning } from './config';
import { hullDamageTaken, hullMaxHp, shipRadius } from './damage';
import {
  createEnemyBullet,
  type EnemyBullet,
  ENEMY_BULLET_MAX_ALIVE,
  resetEnemyBullet,
  stepEnemyBullets,
} from './enemyBullet';
import { stepInterception, stepInterceptHits } from './intercept';
import {
  bossContactDamage,
  bossRadius,
  initBoss,
  initSummon,
  stepBossBehavior,
} from './boss';
import { createDrop, type Drop, DROP_KIND_MAGNET, resetDrop, stepDrops } from './drop';
import {
  affixMask,
  applyDamage,
  createEnemy,
  type Enemy,
  enemyRadius,
  hasAffix,
  initEnemy,
  initSplit,
  resetEnemy,
  ST_APPROACH,
  stepEnemyBehavior,
} from './enemy';
import {
  createFxEvent,
  fxLifeForStars,
  type FireSink,
  type FxEvent,
  FXV_HULL_HIT,
  FXV_IMPACT,
  FXV_KILL,
  FXV_RESONANCE,
  FXV_STAR_UPGRADE,
  resetFxEvent,
} from './fx';
import type { EnemyBulletSink } from './enemyBullet';
import { createShip, DEG2RAD, type Ship, type ShipCommand, stepShip, type Vec2 } from './ship';
import { aggregateEdictBuffs, createEdictBuffs, type EdictBuffs } from './edictBuffs';
import { stepTurrets } from './turret';
import {
  OFFER_EDICT,
  OFFER_NEW_WEAPON,
  type UpgradeOption,
  rollUpgradeOffer,
  UPGRADE_NO_OFFER,
} from './upgrade';
import {
  type BurstPeek,
  createWaveState,
  peekNextBurst,
  type SpawnSink,
  stepWaves,
  type WaveState,
} from './waves';

/** 渲染层与既有调用方都从 world 取 Enemy 类型,实体定义搬去 enemy.ts 后这条保持它们不破 */
export type { Enemy } from './enemy';
/** 子弹同理:实体搬去 bullet.ts 之后,渲染层的 `import type { Bullet } from '../sim/world'` 不必改 */
export type { Bullet } from './bullet';
/** 敌方弹丸同理(22 号):渲染层从 world 取类型,与 Enemy / Bullet 同一条既有路径 */
export type { EnemyBullet } from './enemyBullet';

/** 无输入的默认指令:让不接线输入的调用方(单测、无头跑批)照常 world.step() */
const IDLE: ShipCommand = { desiredHeading: null };

/**
 * 地图是**无限的**:没有边界圈、没有对船的贴边夹取(原 WORLD_RADIUS 已删)。
 * 船开到哪,交战就在哪 —— 出怪环(data/waves.ts 的 SPAWN_RADIUS)本就以船为心,
 * 空间哈希按 cell 坐标散列(core/spatialHash),坐标多大都装得下。
 *
 * 原边界的真正职责("防止玩家一路开出怪潮之外把这一局拖成散步")由下面这对常量接手:
 * 被甩开超过 ENEMY_RECYCLE_RADIUS 的敌人**回收进视野缓冲圈** —— 以船为心、朝航向前方
 * ±ENEMY_RECYCLE_SPREAD_DEG 的扇面、落点半径与新生怪同一档(出怪带
 * [SPAWN_RADIUS, +BAND)):"落在身后追不上的怪,悄悄挪到你正开过去的那一侧屏幕外"
 * (VS 同款的屏外重定位)。相对旧"整点镜像"口径的两个改动:
 *  1. **触发圈收紧 1450 → 1350**:旧口径把不可见带留到出怪环外沿 + 2×BAND,怪在
 *     [1300,1450) 的屏外死带里白跑几百帧 —— 分离/空间哈希/碰撞全在看不见的对象上白付,
 *     还在 WAVE_MAX_ALIVE 触顶时挤掉新刷的怪。缓冲圈 = 出怪环外沿 + 50 = 1350:
 *     死带从 150px 缩到 50px,每只怪少挂几十帧的账(这就是"省计算")。
 *  2. **落点从"单点镜像"换成"前向扇面"**:旧口径整群镜像到航向正前方 1150 处一个点
 *     (单列纵队,直航时前方永远只有这一条细流);新口径把每只的半径/角度按 e.animSeed
 *     抖开 —— 一条 100° 弧 × 出怪带,进屏不再是排队,且转向时落点跟着航向走,
 *     "往哪开,压力就补到哪边"("跑"仍然有代价,机制本体不变)。
 * **一次 rng 都不掷**(方向 = 航向 ± animSeed 折叠,半径 = 出怪带内 animSeed 抖动;
 * animSeed 是出生位置 hash 出的每只定值,见 sim/enemy.ts),于是同 seed 同输入的确定性
 * 回放照旧成立,回收也不扰动出怪序列。
 */
/** 触发回收的距离(> 出怪环外沿 SPAWN_RADIUS + BAND = 1300:新生的怪绝不会被当场误判;落点恒 < 1300,也绝不会下一帧再来一次) */
export const ENEMY_RECYCLE_RADIUS = SPAWN_RADIUS + SPAWN_RADIUS_BAND + 50;
/** 回收落点扇面的半宽(度):与 data/waves.ts 各流 spreadDeg 同一套"半展宽"词汇,落点落在航向 ± 这一档内 */
export const ENEMY_RECYCLE_SPREAD_DEG = 50;

/** 压测出怪环的内/外半径:别把敌人直接生在船脸上。**只服务于 stressSyncCounts 那条 debug 路径** */
const SPAWN_MIN_RADIUS = 300;
const SPAWN_MAX_RADIUS = 1200;

/**
 * 孢子弹丸的碰撞半径(22 号,px)。数据表里没有单独一档(现在只有孢子一种弹),
 * 留在世界侧与发射点同源 —— 判定体多大、渲染层画多大,由这一个数对齐。
 */
const SPORE_BULLET_RADIUS = 5;

/**
 * 敌人期望速度的暂存。模块级复用而不是每只现造:1000 敌 × 60Hz 下,
 * 循环里 new 一个对象就是每秒六万次分配,直接写在 GC 停顿上(铁律 3:运行期零新增分配)。
 */
const desired: Vec2 = { x: 0, y: 0 };

/**
 * 加速窗内无方向输入时"沿船头满推"的期望航向暂存(模块级复用,铁律 3:
 * 每逻辑帧最多写一次,绝不跨帧持有 —— stepShip 只读不存引用)。
 */
const boostForward: Vec2 = { x: 0, y: 0 };

/**
 * 威胁罗盘的实际出怪统计采用一阶指数平滑。1.25s 足够把低速怪流的逐只脉冲抹平，
 * 又不会让侧压 burst 过了几秒还把箭头拽在旧方向。衰减与单次成功出怪的脉冲增益都按
 * 固定 SIM_DT 预先算好：热路径只做乘加，不现算 exp、也不分配样本对象。
 *
 * 单次事件加 (1-decay)/dt，意味着稳定的 N 只/秒输入最终收敛到 N；burst 则按实际成功
 * 落地的只数当场抬高强度。World 的在场上限在记录样本之前挡掉请求，故触顶丢弃天然一票不投。
 */
const THREAT_SMOOTH_TAU = 1.25;
const THREAT_SMOOTH_DECAY = Math.exp(-SIM_DT / THREAT_SMOOTH_TAU);
/** 单次成功事件的方向脉冲增益(导出给单测钉"回收喂的恰好是一发脉冲"这条契约) */
export const THREAT_SPAWN_IMPULSE = (1 - THREAT_SMOOTH_DECAY) / SIM_DT;
/** 最近实际生成速率低于这一档时，旧样本已经没有指向意义，回退波次脚本的派生方向。 */
const THREAT_DIRECTION_MIN_RATE = 0.05;

/**
 * 逐武器 DPS 读数(HUD 统计面板)的一阶指数平滑 —— 与威胁罗盘同一套写法与理由:
 * 帧首统一衰减,伤害结算时按 (1-decay)/dt 的脉冲增益进账,稳定的 X 伤害/秒收敛到 X。
 * 2.5s 比罗盘的 1.25s 更钝:DPS 是"这门炮最近打得怎么样"的读数,迫击炮几秒一发的
 * 攒-放节奏在 1.25s 窗口下会在 0 与峰值之间大幅跳动,读不出均值。
 * 纯 HUD 读数,不参与任何判定,不进 checksum(照 threatRate 口径)。
 */
const DPS_SMOOTH_TAU = 2.5;
const DPS_SMOOTH_DECAY = Math.exp(-SIM_DT / DPS_SMOOTH_TAU);
const DPS_SMOOTH_IMPULSE = (1 - DPS_SMOOTH_DECAY) / SIM_DT;
/** 两股相反压力把方向向量抵消时同样回退，避免 atan2(≈0,≈0) 给出随机抖动。 */
const THREAT_DIRECTION_EPSILON = 1e-6;

/**
 * —— 齐射共振判定(24 号,broadside 时刻复活)——
 * 8 槽每 45° 一档朝向,相邻三槽正好张成一面 90° 的"舷":短窗内相邻三槽都开过火
 * → 推一条 FXV_RESONANCE 表现事件(舷侧闪光 + 和弦)。
 * **v1 刻意做成表现层**:lastFiredTick / 共振冷却计时器不进 checksum、不进 runSave ——
 * 先例是逐武器 DPS 的 2.5s 一阶平滑(fcc6c1b:"按实际结算量归账,不进 checksum"),它们只喂
 * fx、不参与任何判定、一次 rng 都不掷;读档后统计清零,代价只是"读档头半秒不共振",可接受
 * (todos/24 口径说明)。两常量**不进 sim/config.ts**:调参面板绑不读取的旋钮是审计点过名的
 * 死代码模式,进面板就必须真绑。
 */
/** 判定窗(秒):三槽的最近开火都落在这段窗内才算一次共振。占位待调 */
const RESONANCE_WINDOW = 0.5;
/** 判定窗折算成 tick 数(SIM_DT 是编译期常量,模块加载时算一次,热路径只做整数比较) */
const RESONANCE_WINDOW_TICKS = RESONANCE_WINDOW / SIM_DT;
/** 两次共振之间的最短间隔(秒):触发后置位、逐帧减,冷却期内不触发也不推事件。占位待调 */
const RESONANCE_COOLDOWN = 4;

/**
 * 局终结果码(08 号 T3),由 World.result 持有、settleOutcome 置位。
 * 定义在 sim 这一侧而不是 ui:判定发生在世界里,文案才是 ui 的事 ——
 * 反过来的话 sim 就得 import ui,铁律 1 当场破掉。
 * 三个值互斥、不是位标志:一局只可能落在其中一个上(先到的那个把这一局定死)。
 */
export const RESULT_RUNNING = 0;
/**
 * 胜利:波次脚本走完(wave.done)**且 Boss 已击杀**(15 号)—— 第 4 段走完只是进入
 * Boss 战的时机,活过 Boss 才算这一局赢了
 */
export const RESULT_WIN = 1;
/** 失败:船体 HP 归零(shipDead)。**优先于胜利**,同一帧两样都成立时算失败(见 settleOutcome) */
export const RESULT_LOSE = 2;

/** 整备操作不是战斗放置,流程过期一律挡在门外(整备面板的操作共用这一个码) */
export const REFIT_NOT_ACTIVE = -20;

/**
 * 重摇失败(16 号):星币不足(重摇价 = data/economy 的 REROLL_PRICE)。
 * **负数、落在既有成功码之外**是有意的:调用方拿到的与 takeUpgrade 是同一条返回通道,
 * 一个 `>= 0` 判据就能把"新候选数"与"失败理由"分开(重摇成功返回新候选数)。
 */
export const REROLL_NO_STARCOINS = -30;
/** 重摇失败:当前这档 offer 已经摇过一次(每级最多 1 次,todos/16)。 */
export const REROLL_ALREADY_DONE = -31;

/**
 * 船坞商店(改版 21 号)失败码。与 REROLL_* 同一条"负数、落在既有成功码之外"的口径:
 * 调用方拿到的与 takeUpgrade 是同一条返回通道,一个 `< 0` 判据就能把成功与失败分开,
 * ui 照码说人话(refitFlow.refitDenyMessage)。
 */
/** 这张法令卡已经卖出(或下标越界 —— 本轮货架没有这一格)。 */
export const DOCK_EDICT_SOLD = -40;
/** 星币不足(价 = data/economy 的 DOCK_EDICT_PRICE / DOCK_REPAIR_PRICE)。 */
export const DOCK_NO_STARCOINS = -41;
/** 船体已满血,付费修复没有意义。 */
export const DOCK_HP_FULL = -42;

/**
 * —— 槽位获得 / 替换 / 支援的返回码(改版)——
 * 同一套"负数 = 失败理由、0 = 成功"的口径:UI 把 takeUpgrade / acquireWeapon /
 * replaceWeapon / buyShopWeapon 的返回值放进同一个通道说人话。
 */
/** 获得武器成功(已入槽;若同型同星凑满三把,三合一升星已在内部完成)。 */
export const ACQUIRE_OK = 0;
/**
 * 武器槽已满、且本次获得不触发合成(没有空槽可落,同型 1★ 也没凑够两把可吸收):
 * 调用方先让玩家选一个替换槽,再走 replaceWeapon
 */
export const ACQUIRE_REPLACE_NEEDED = -50;
/** 武器型越界(数值表写坏):TOWERS[type] 取不到。 */
export const ACQUIRE_INVALID_TYPE = -51;
/** 替换武器成功(旧武器被换下;若同型同星凑满三把,三合一升星已在内部完成)。 */
export const REPLACE_OK = 0;
/** 替换失败:槽位下标越界或目标槽是空槽(空槽不需要替换,走 acquireWeapon)。 */
export const REPLACE_BAD_SLOT = -60;
/** 替换失败:武器型越界(数值表写坏)。 */
export const REPLACE_INVALID_TYPE = -61;
/** 授予法令成功(层数 +1)。 */
export const EDICT_OK = 0;
/**
 * 这条法令已经满层(EDICT_MAX_LEVEL)。正常玩不出来 —— 满层的法令由卡池与船坞货架双双过滤
 * (sim/upgrade.ts 的 collectPool / World.rollDockEdicts),这一码是**兜底而不是流程**:
 * 过滤与授予各判各的,少了它,一次过滤疏漏就会变成"点了卡、扣了钱、什么都没加"的静默吞卡。
 */
export const EDICT_MAXED = -53;
/** 法令型越界(数值表写坏):EDICTS[type] 取不到。 */
export const EDICT_INVALID_TYPE = -54;
/** 换位失败:两个下标里有越界的,或两个是同一个槽(换了等于没换)。 */
export const SWAP_BAD_SLOT = -80;
/** 商店买武器失败:货架这一格已经卖出(或下标越界)。 */
export const SHOP_WEAPON_SOLD = -70;
/** 商店买武器失败:星币不足(价 = data/economy 的 DOCK_WEAPON_PRICE)。 */
export const SHOP_NO_STARCOINS = -71;
/** 刷新商店货架失败:星币不足(价 = data/economy 的 DOCK_SHOP_REFRESH_PRICE)。 */
export const SHOP_NO_REFRESH_STARCOINS = -72;

/**
 * 法令的船坞货架解锁闸门位(21 号):下标 = 法令号,值 = 该法令在 UNLOCKS 表里的下标
 * (= 解锁掩码位)。与 upgrade.ts 的 EDICT_UNLOCK_BIT 是**同一张映射** —— 那张表是模块
 * 私有的,而船坞货架是第二个消费点,故按同一条"加载时扫 UNLOCKS 表"的口径再建一份:
 * 改解锁表两处同源自动跟(都是"模块加载时算一次"),不必两头维护。
 * 掩码位 i = UNLOCKS[i] 开没开;未被闸门覆盖的法令填 -1 = 恒进池(与 upgrade.ts 同约定)。
 */
const DOCK_EDICT_UNLOCK_BIT: number[] = new Array<number>(EDICT_KIND_COUNT).fill(-1);
/**
 * 商店武器货架的解锁闸门位(改版 21 号):与 DOCK_EDICT_UNLOCK_BIT 同一条"加载时扫表"口径,
 * 下标 = TOWER_*,值 = UNLOCKS 下标(UNLOCK_TOWER 类)。未解锁的塔(导弹巢)不进商店货架。
 */
const SHOP_WEAPON_UNLOCK_BIT: number[] = new Array<number>(TOWER_KIND_COUNT).fill(-1);
for (let i = 0; i < UNLOCKS.length; i++) {
  const u = UNLOCKS[i]!;
  if (u.kind === UNLOCK_EDICT && u.type >= 0 && u.type < EDICT_KIND_COUNT) {
    DOCK_EDICT_UNLOCK_BIT[u.type] = i;
  } else if (u.kind === UNLOCK_TOWER && u.type >= 0 && u.type < TOWER_KIND_COUNT) {
    SHOP_WEAPON_UNLOCK_BIT[u.type] = i;
  }
}
export class World {
  readonly rng: Rng;
  readonly enemies: Pool<Enemy>;
  readonly bullets: Pool<Bullet>;

  /**
   * 场上的**敌方弹丸**(22 号,GDD §6.2 孢子炮手的远程攻击)。
   * 与 bullets 同一条生命周期写法:池里的普通对象、维护 px/py 供渲染插值、
   * 移动/命中/到期由 sim/enemyBullet.ts 的 stepEnemyBullets 每帧推进(倒序 swap-remove 回收),
   * 点防拦截的命中移除在 sim/intercept.ts 的 stepInterceptHits。
   * 它是**真 sim 状态**(决定船掉不掉血),故进 checksum —— 与 bullets 同一条"只哈位置"口径
   * (伤害/半径是发射那一刻定死的常量,位置已抓住任何弹道分叉)。
   * 数量级:孢子在场个位数、每轮齐射 3 发,全场稳定几十颗;上限见 ENEMY_BULLET_MAX_ALIVE(保险丝)。
   */
  readonly enemyBullets: Pool<EnemyBullet>;

  /**
   * 场上的 XP 掉落物(改版 10 号;旧名"残骸",字段与池名沿用)。敌人死在哪就掉在哪
   * (reap 里的 spawnDrop,**所有击杀都掉**,含精英/Boss),此后由 sim/drop.ts 的 stepDrops
   * 每帧推进磁吸与收取 —— 起吸/锁定/收取的规则一个字都不在本文件,
   * 世界这一层只知道"谁死了、船在哪"(与子弹的 stepBullets、敌人的 stepEnemyBehavior 同一条分工)。
   * 生命周期也与那两样同款:池里的普通对象、维护 px/py 供渲染插值、收下的当场倒序 swap-remove 回收。
   */
  readonly drops: Pool<Drop>;
  /** cell = 最大敌半径 ×2(GDD §13):查询半径不超过一个 cell 时,3×3 邻域必然覆盖 */
  readonly grid = new SpatialHash<Enemy>(tuning.enemyRadiusMax * 2);
  tick = 0;
  /** 全局只有一艘船,故不进对象池;它同样维护 px/py 与 pheading 供渲染插值(铁律 2) */
  readonly ship: Ship = createShip();

  /**
   * 武器槽(改版 §5,用户设计会):长度 = WEAPON_SLOT_COUNT 的定长数组,type = -1 = 空槽。
   * 整局同一个对象,获得/替换/升星合成都是就地改字段 —— 渲染层持有它的引用,按槽位直读。
   * 槽位数学(硬点/射界)在 sim/armory.ts;节流状态(冷却/弹夹/热量/充能)由 sim/tower.ts 推进。
   * 它是逐帧演化的真状态(槽位 + 节流),进 checksum(与旧甲板逐格哈希同一条理由)。
   */
  readonly weapons: WeaponSlot[] = createWeaponSlots();

  /**
   * **已持有法令的层数表**(用户设计会:支援并入法令),长度 = EDICT_KIND_COUNT,下标 = EDICT_*。
   * 0 = 未持有,上限 EDICT_MAX_LEVEL(5)。法令**不占任何槽位**、可重复持有 = 叠层
   * (聚合规则见 sim/edictBuffs.ts:乘法档 base^层、加法档 add×层)。
   *
   * 取代了旧的两样东西:支援槽数组(supports)与法令位掩码(edicts)。掩码换成层数表是
   * "最多拿 5 次"这条规则的直接落地 —— 一位存不下五层,而两套并行的被动本就该只有一套。
   * 它是逐帧演化的真状态、**不是派生量**,逐条进 checksum(与槽位等级同口径):
   * 法令只改 effective 数值,而那些数值本就参与判定(谁开火、转到哪、捡不捡得到),
   * 漏了它重放当场失配。
   */
  readonly edictLevels: number[] = createEdictLevels();

  /**
   * 本帧的**全船法令聚合**。每帧 step 帧首由 aggregateEdictBuffs 就地重写,再传给
   * sim/turret(开火节奏)、sim/tower(节流包装)、sim/damage(船体 HP/减伤)、
   * sim/ship(转向/巡航)与 stepDrops(经验倍率/磁吸)。
   * 它不在 checksum 里:是 edictLevels(已逐条哈希)与数据表的纯函数,哈它是把同一件事哈两遍。
   */
  readonly buffs: EdictBuffs = createEdictBuffs();

  /**
   * 本局的波次脚本进度(08 号 issue)。整局同一个对象,由 stepWaves 每帧就地推进。
   * **不提供 reset()**:重开 = 换整个 World(池 / rng / tick / 槽位全是新的才谈得上"同 seed 可复现")。
   *
   * 里头 segment / segTime / burstNext / eliteNext / debt 是真状态(全进 checksum,14 号起精英游标也哈),
   * unlockMask 是开局定死的输入配置(19 号,不进 checksum),dirRad / intensity / done 是它们与脚本的
   * 纯函数(派生量口径见 sim/waves.ts 的字段注释)。
   * **tuning.stressSpawn = true 时它整段旁路**:冻在初值、方向不转、永不 done。
   */
  readonly wave: WaveState;

  /**
   * 解锁状态位掩码(19 号):位 i = UNLOCKS[i] 开没开。**跨局存档的一部分**,与局内字段
   * (edicts / offer 那些)不是一类东西,故不借它们存,单独走构造参数 —— 参照 seed 的构造待遇。
   * 用法只有两处:卡池过滤(rollUpgradeOffer 的 unlockMask 参数)与解锁精英门控
   * (createWaveState 喂给波次运行器)。
   * **它不进 checksum**:只收窄候选集合(升级卡池 / 商店货架)与"解锁槽位出不出",
   * 与跨 seed 同一条口径 —— 换个掩码重放,同 seed 的 rng 序列逐位不变(19 号验收,过滤在掷前)。
   */
  readonly unlockMask: number;

  /**
   * 本帧贴到船身的敌人 —— **粗筛候选**(照 sim/turret.ts 的 candidates 口径),不是"真撞上的人"。
   * 敌人循环里只做一次廉价的圆判定(船体受击圆 + 体型)就入名单,精筛与扣血全在
   * settleHullDamage 一处 —— 判定几何全仓只有 damage.ts 那一份(船体受击圆),热循环里再抄一遍
   * 迟早写歪。于是它是**超集** —— 名单里的人可能没真碰上(粗筛宁大勿小)。
   * 每帧在敌人循环前清空;元素是池中对象,step() 返回后立刻读,别跨帧存引用 ——
   * 死者回池后同一个对象会变成另一只敌人。
   */
  readonly contacts: Enemy[] = [];

  /**
   * 船体 HP 归零。它只是**这一帧的状态位**,不是这一局的结论:失败结论要等帧尾的 settleOutcome
   * 落成 result —— 受击结算发生在帧中,胜负两条路只有在帧尾才有同一个判定点。
   * 结算界面、重开、暂停、动 loop 一概不在这里,那一层在 main.ts。
   * 它是 ship.hp 的派生量(除了归零那一刻没有第二条来路),故**不进 checksum**。
   */
  shipDead = false;

  /**
   * 船沉的**一次性**回调(09 号受击模型的出口)。只在 hp 第一次归零那一帧响一次:
   * damageShip 的首句就把已 dead 的世界挡在门外,于是尸体上再挨多少下都不会再响,
   * 调用方不必自己去重 —— 与 onEnemyDeath"同帧重复致命只算一次"是同一条口径。
   */
  onShipDestroyed: (() => void) | null = null;

  /**
   * 本局的结果码(RESULT_*),由 step() 帧尾的 settleOutcome 置位,**置位后永不再变**。
   * 它是 shipDead / wave.done / bossPhase 的**派生量**(settleOutcome 只读这三样,没有第三条来路;
   * bossPhase 本身进 checksum,故 result 仍没有独立信息),故**不进 checksum**。
   */
  result = RESULT_RUNNING;

  /**
   * 局终的**一次性**回调,胜负共用一个出口(参数 = RESULT_WIN / RESULT_LOSE)。
   * 只在结论落定那一帧响一次:settleOutcome 的首句就把已有结论的世界挡在门外,
   * 于是结算界面弹出后世界再被 step 多少帧也不会弹第二次,流程那一侧不必自己去重。
   *
   * **回调里该做的事全在 main.ts**:停 loop(run.paused)、弹结算界面 ——
   * World 一样都不做,它连"这一局要不要停"都不知道。
   */
  onGameOver: ((result: number) => void) | null = null;

  /**
   * 死亡挂钩(表现与统计的出口)。回调返回后对象立刻回池,
   * 所以回调里必须当场取走 x/y/kind,不能存引用等下一帧再读。
   *
   * **掉落不走它**:那是世界自己的账,已经在 reap 里由 spawnDrop 当场落地(排在本回调之前) ——
   * 挂钩接不接、接的人做了什么,都不该决定这一局能不能捡到经验。
   */
  onEnemyDeath: ((e: Enemy) => void) | null = null;

  /**
   * 出怪挂钩,与 onEnemyDeath 对称:每成功出一只怪、initEnemy 填完之后当场响一次。
   * 同一条口径 —— 回调里当场读 kind/x/y,**别跨帧存引用**(对象在池里,死后会被复用成另一只敌人)。
   * "同 seed 两局出怪序列一致"(08 验收)只能靠它逐只比对:池里的 items 被 swap-remove 打乱过顺序,
   * 拿它当序列比的是另一件事。
   *
   * **只有正式出怪器走它**:压测那条 debug 路径是凭空补人凑数量,不是"这一局的波次里来了一只怪"。
   */
  onEnemySpawn: ((e: Enemy) => void) | null = null;

  /** 累计击杀。面板改数量导致的清场不计入 —— 那不是打死的 */
  kills = 0;

  /**
   * 累计**精英**击杀(19 号):精英 = affixes ≠ 0(与 spawnDrop 同一条判定,词缀位由 14 号
   * 在 initEnemy 里落地;Boss 绝不用 affixes 位,故不占这一格)。与 kills 同一条
   * "回收那一帧记账"的口径,也同一条**派生量口径**:击杀本身在敌人池与 affixes 里可见
   * (affixes 进 checksum),故**不进 checksum** —— 它只供存档侧做累计解锁判定
   * (unlocks.ts 的 COND_ELITE_KILLS),跨局累计,第 0 局起不清零。
   */
  eliteKills = 0;

  /**
   * Boss 阶段(15 号 T1)的状态机位:0 = 未进入(脚本没走完);1 = 战斗中;
   * 2 = 已击杀。进入 = 脚本走完那一帧(enterBossPhase 生成 Boss 一只,与敌人同池);
   * 击杀 = reap 里 Boss 尸体落账那一帧翻成 2 —— 胜利判定只认这一位(见 settleOutcome)。
   * 逐帧演化的真状态,进 checksum:它决定"召唤还跑不跑",而召唤消费 rng。
   */
  bossPhase = 0;

  /**
   * 已完成的召唤次数 —— "到点即消费"的游标,照 wave.eliteNext 先例进 checksum:
   * 它差一,本局的召唤就整批错位,而召唤的错位要等若干帧后反哺到小怪位置才露馅。
   */
  bossSummonN = 0;

  /**
   * 距下次召唤的剩余秒数。真状态、逐帧演化,×100 进 checksum;
   * 渲染层读它做召唤预告:它 < BOSS.summonWarnTime 时 Boss 就要开始召唤了
   * (与精英预警共用提示通道,见 todos/15 验收"召唤有预告")。
   */
  bossSummonCooldown = 0;

  /**
   * Boss 被击杀的时刻(elapsed,与 kills 同一条"回收那一帧记账"的口径)—— 一次性记录,
   * 结算界面(胜利时间/本局统计)读它。与 kills 同一条派生量口径:
   * 击杀本身在敌人池与 bossPhase 里可见,故**不进 checksum**。
   */
  bossKilledAt = 0;

  /**
   * 在场 Boss 的对象引用(工程审计的 O(1) 缓存):spawnBoss 挂上、stepBossSummon 只读。
   * 是**派生缓存**(全表扫描随时找得回),故不进 checksum、不进存档 —— 读档恢复后
   * 由 stepBossSummon 第一次调用现扫重挂;引用失效(Boss 死亡回池)以 dead 为判据。
   */
  private bossRef: Enemy | null = null;

  /**
   * 已收集、未花掉的残骸(改版后 = **经验**,字段名沿用 GDD 的"残骸"口径)—— **成长资源**,
   * 掉落物由 spawnDrop 造、stepDrops 收、takeUpgrade/skipUpgrade 花。
   * 面额是数值表里的整数 scrap(精英 ×3 / Boss ×12 见 spawnDrop),收取时整颗进账,
   * **经验增幅器(支援)的 xpMul 在 stepDrops 内部乘好**,故本字段可以是小数
   * (旧版"恒为整数"的不变量随 xpMul 引入而退役 —— 数值仍逐帧演化、进 checksum)。
   *
   * 它是逐帧演化出来的状态、**不是派生量**:收下的那颗当场出池,池里再也找不到它 ——
   * 于是漏了它,"磁吸多收/漏收了一颗"这类回归在池空之后就彻底看不见了,故进 checksum。
   */
  scrap = 0;

  /**
   * 已入账、未花掉的星币(改版 16 号,GDD §7 第二货币)。**恒整数**:面额是数值表里的整数
   * (普通怪按型 ENEMIES[kind].starCoins / ELITE.starCoins / BOSS.starCoins),
   * **所有击杀**都当场整笔进账(spawnDrop 里结),重摇/商店购买时整笔扣费
   * (rerollOffer / buyDockEdict / buyDockRepair / buyShopWeapon / refreshShop),全程没有系数。
   *
   * 与残骸同口径的只是"逐帧演化出来的账目"这一面;**它不进 checksum**(与 maxHp 同一条
   * "不进"的先例,理由见下):星币只影响 UI 读数与消费,不参与任何 sim 判定 ——
    * 消费点消耗的 rng 本身都在随机序列里(重摇每次恰 2×UPGRADE_CHOICE_COUNT 次、船坞货架
    * 每轮恰 DOCK_EDICT_COUNT 次、商店货架每轮恰 DOCK_WEAPON_COUNT 次、特价每轮恰 1 次;
    * **购买本身一次都不掷**),
   * 余额只是那条序列的**读数**:同一局扣过费没有,序列照样逐位可复现。
   * "星币 ≥ X 触发行为就要进 checksum"指的是 sim **自己**按余额做决定(如余额够了自动弹商店);
   * 玩家主动点击的购买是 step() 之外的外部输入 —— 失败的尝试一个字段都不动,
   * 成功的尝试效果落在 edicts / ship.hp / 槽位这三个已在哈希里的字段上,故余额照旧不进。
   *
   * **开局不是 0**:每局白送 STARTING_STAR_COINS(见 data/economy.ts 那条口径)。
   * 读档局在 runSave 的 restore 里被存档余额整个覆盖,不会再补发一次。
   */
  starCoins = STARTING_STAR_COINS;

  /**
   * 已经**结算完**的升级次数,同时也是下一次费用曲线的级数。
   * 它不是槽位星级之和:跳过照样算结算一次;经济曲线只关心这局已经消费过几次机会。
   * 逐帧演化、进 checksum。
   */
  upgrades = 0;

  /**
   * 当前待选的候选卡。长度 0 = 没有待选;>0 = World 等玩家结算,自己绝不暂停。
   * 数组整局复用,rollUpgradeOffer 就地改三个对象;候选消耗了 rng 且决定玩家能拿什么,
   * 不是槽位的派生量,故逐项进 checksum。
   */
  readonly offer: UpgradeOption[] = [];

  /**
   * 距下一次允许弹卡的剩余秒数(data/economy 的 UPGRADE_OFFER_COOLDOWN)。
   * completeUpgrade 置位、settleUpgrade 每帧尾减 dt:早期相邻档价差只有 9-21,
   * 一波混战攒出跨档余额时,没有它的话恢复战斗的下一帧会立刻再次时停弹卡。
   * 初值 0 = 首次弹卡不受限。它决定 rollUpgradeOffer **何时**消耗 rng,
   * 是逐帧演化的真状态而不是派生量,故进 checksum。
   */
  offerCooldown = 0;

  /**
   * 当前这档 offer 是否已经重摇过一次(每级最多 1 次,16 号)。true = 星币够也不许再摇,
   * 防"刷到天牌才停";与跳过/takeUpgrade 各管各的,不互相抵扣。
   * 它是**真状态**:重摇在 step() 之外由玩家操作触发,而它决定 rerollOffer 是否再次消耗
   * 2×UPGRADE_CHOICE_COUNT 次 rng —— 漏了它,"这档摇没摇过"的分叉就从确定性口径下漏掉,
   * 故进 checksum(照 offerCooldown 的先例:凡是决定 rng 何时被消耗的字段都是真状态)。
   * **每次新 offer 生成时重置为 false**(重置点 = settleUpgrade 里 rollUpgradeOffer 成功那一处):
   * 次数限制按"级"计,新一档三张全新候选就是一次新的机会。
   */
  offerRerolled = false;

  /**
   * 新 offer 生成那一帧的一次性出口。只要 offer 还没结算,settleUpgrade 的长度守卫就不再生成、
   * 回调也不会重复响。停 loop / 放大 / 弹卡全在 main.ts,World 不认识流程层。
   */
  onUpgradeOffer: (() => void) | null = null;

  /**
   * 已跨入下一航段、正在等待玩家整备。World 只持有状态并响一次回调；暂停与 UI 仍在 main.ts。
   * pending 期间 stepWaves 不再推进,故即使无头调用方继续 step,下一波也不会偷跑。
   * (旧版的 refitWelded"每轮只焊一块甲板"随焊接删除 —— 整备现在只逛商店,没有次数限制。)
   */
  refitPending = false;
  /** 参数 = 开出这个商店的航段下标。 */
  onRefitOffer: ((segment: number) => void) | null = null;

  /**
   * —— 地图商店信标(用户设计会:取消"每跨一段自动弹面板")——
   * 每跨一个航段(约两分钟)在船周围随机方位、随机距离处生成一个信标,只存在
   * SHOP_BEACON_LIFETIME 秒;玩家**开船撞上去**才开商店面板(时停)、才拿免费回血。
   * 没赶到就随信标一起消失,这一轮什么都没有 —— 于是"要不要冒着虫潮横穿半张图"
   * 成了每两分钟一次的真取舍(把面板搬上地图的全部意义就在这一句)。
   *
   * 四个字段全是**逐帧演化的真状态**(位置消耗过 rng、计时决定还剩几帧可接),进 checksum。
   * 渲染层按 active 画信标与屏边指示箭头,HUD 按 ttl 画倒计时。
   */
  shopBeaconActive = false;
  shopBeaconX = 0;
  shopBeaconY = 0;
  /** 剩余存活秒数(≤ 0 = 本轮作废)。active = false 时恒 0 */
  shopBeaconTtl = 0;
  /** 开出这个信标的航段下标(接上时喂给 onRefitOffer,面板标题读它) */
  shopBeaconSegment = 0;
  /** 信标生成那一帧的一次性出口(HUD 弹"商店已开启"提示 / 播音效)。参数 = 航段下标 */
  onShopBeacon: ((segment: number) => void) | null = null;

  /**
   * 本轮整备的船坞法令货架(21 号):每个元素是一条**还没卖出**的法令号,卖出一格当场写成 -1;
   * 长度 = 本轮实际掷出的条数(可选池被掏空就少,0..DOCK_EDICT_COUNT)。
   * 进入整备那一帧(step 里 refitPending 置位处)由 rollDockEdicts 掷定,整备结束
   * (completeRefit)清空,下一轮整备重掷 —— 与 offer 同一条"生成一次、当场消费 rng"的生命周期。
   *
   * 它与 offer 同一条性质:**消耗了 rng、决定玩家这轮能买什么**,故逐项进 checksum
   * (已售出的格子哈成 -1,售出与否同样在哈希里,照 offerRerolled 的"真状态"先例);
   * 星币余额则仍不进 —— 购买是 step() 之外的外部输入、一次 rng 都不掷,效果落在
   * edicts 与 ship.hp 这两个已在哈希里的字段上,余额只是那条序列的读数(理由全文见
   * starCoins 字段注释;购买零 rng 的口径见 buyDockEdict)。
   */
  readonly dockEdictOffers: number[] = [];
  /** 货架掷定的可选池暂存(铁律 3:整局复用、不新建数组) */
  private readonly dockPool: number[] = [];

  /**
   * 本轮整备的**商店武器货架**(改版 21 号):每个元素是一把**还没卖出**的 TOWER_* 型,
   * 卖出一格当场写成 -1;长度 = 本轮实际掷出的条数(0..DOCK_WEAPON_COUNT)。
   * 与 dockEdictOffers 同一条生命周期:跨段那一帧由 rollShopWeapons 掷定、completeRefit 清空。
   * 它消耗了 rng、决定玩家这轮能买什么,故逐项进 checksum(与 dockEdictOffers 同一份理由)。
   */
  readonly shopWeapons: number[] = [];
  /** 商店货架掷定的可选池暂存(铁律 3:整局复用、不新建数组) */
  private readonly shopPool: number[] = [];

  /**
   * 本轮货架的**特价位**(打折机制:每次上架恰选一件商品打折):
   *   -1 = 本轮没有特价(货架全空);
   *   0..DOCK_EDICT_COUNT-1 = 法令货架的第几格打特价;
   *   DOCK_EDICT_COUNT..DOCK_EDICT_COUNT+DOCK_WEAPON_COUNT-1 = 武器货架的第几格打特价。
   * 只在**还没售出的格**之间挑(特价落在已售出上是废格)。与两张货架同一条生命周期:
   * 跨段那一帧 rollShopDiscount 掷定(排在信标 → 法令 → 武器之后)、completeRefit 与
   * 信标到期双双清空;refreshShop 重掷武器货架后**跟着重掷**(新货架配新特价)。
   * 它消耗了 rng、决定玩家这一轮花多少钱,故进 checksum(与两张货架同一条理由;
   * 恒掷 1 次、池空也掷,消耗次数与货架内容无关 —— 同 seed 同操作序列逐位可复现)。
   */
  shopDiscountIndex = -1;
  /** 特价掷定的可选池暂存(铁律 3:整局复用、不新建数组) */
  private readonly discountPool: number[] = [];

  /**
   * 开火/命中的可视化事件(05 号 issue):渲染层遍历 world.fx.items 逐个画,按 life 淡出。
   * **纯表现,一律不进 checksum**(理由见 checksum 末尾那段);每帧在 step 末尾统一老化,
   * life ≤ 0 倒序 swap-remove 回池 —— 与子弹、敌人共用同一套生命周期写法(铁律 3)。
   */
  readonly fx = new Pool<FxEvent>(createFxEvent, resetFxEvent);

  /**
   * 正式出怪器实际成功落地事件的一阶平滑统计。三个数整局就地演化、不存逐事件历史：
   * rate 是平滑后的只/秒；dirX/dirY 是同一批事件按出生角累积的加权方向向量。
   * 纯 HUD 读数，不参与任何判定，也不进 checksum（与 FxEvent 同口径）。
   * dirX/dirY 不设 private：单测要直读向量钉"回收喂的恰好是一发脉冲、方向 = 落点方位"
   * （threatDirection 有速率回退路径，钉不了这个增量口径）。
   */
  private threatRate = 0;
  threatDirX = 0;
  threatDirY = 0;

  /**
   * 逐塔型的实际 DPS 平滑值(下标 = TOWER_*)。伤害结算的唯一入口(damageEnemy)在
   * 带 towerType 时按**实际结算量**(词缀抗性折算后)进账,帧首统一衰减(见 DPS_SMOOTH_TAU)。
   * 纯 HUD 读数(dpsOf),不参与任何判定、不进 checksum —— 与 threatRate 同一条口径。
   */
  private readonly dpsByType = new Float64Array(TOWER_KIND_COUNT);

  /**
   * 逐塔型的**本局累计**实际伤害(下标 = TOWER_*,与 dpsByType 同一处进账、同一份口径,
   * 只是不衰减)。局末武器战报读它 —— "这一局谁扛了输出"的总账。
   * 纯读数,不参与任何判定、不进 checksum(照 kills 的派生量口径:伤害效果已落在敌 hp 上)。
   */
  readonly runDamageByType = new Float64Array(TOWER_KIND_COUNT);

  /**
   * 本局的**峰值总 DPS**(全武器 dpsByType 之和的历史最大值)。帧首衰减后现算现比,
   * 局末战报的"最高一刻打出了多少"。纯读数,不进 checksum(与 runDamageByType 同口径)。
   */
  peakDps = 0;

  /**
   * —— 齐射共振统计(24 号,v1 纯表现)—— 与 threatRate / dpsByType 同一条
   * "纯统计、只喂 fx、不参与任何判定"的口径,故**不进 checksum、不进 runSave**
   * (读档后统计清零,代价只是"读档头半秒不共振",口径全文见 RESONANCE_WINDOW 那段)。
   */
  /** 每槽最近一次开火的 tick 数(长度 = WEAPON_SLOT_COUNT,初值 -1 = 从未开火)。 */
  readonly lastFiredTick: number[] = new Array<number>(WEAPON_SLOT_COUNT).fill(-1);
  /**
   * 共振冷却剩余秒(> 0 = 冷却期内,判定照走但不触发、不推事件)。触发那一帧置
   * RESONANCE_COOLDOWN,step 帧尾逐帧减 SIM_DT —— 与 boost 那批秒数计时器同一条写法,
   * 只是这一条不进 checksum(它不参与任何判定)。
   */
  resonanceCooldown = 0;

  /**
   * 加速技能(空格,畅玩性)的两个计时器,秒。boostTime > 0 = 加速窗内:巡航上限与推力
   * 都按 tuning.boost* 放大(乘进 stepShip 的 cruiseMul/accelMul);boostCooldown 从
   * **触发那一帧**起算(含加速窗本身),归零前不许再次触发。
   * 两个都是**真状态**:它们直接决定船的速度上限与推力 —— 差一帧,船的位置当帧分叉,
   * 故都进 checksum(×100,与 offerCooldown 那批秒数字段同一条量化理由)。
   * 触发条件读的是 cmd.boost(输入以纯数据进 sim,铁律 1),同 seed + 同输入序列照旧同轨迹。
   */
  boostTime = 0;
  boostCooldown = 0;

  /**
   * 磁吸涌剩余秒(26 号改):> 0 = 涌期间,起吸半径的连乘链尾部再乘 MAGNET_PICKUP_RADIUS_MUL
   * (25 × 80 = 2000 ≈ 弃置半径,即"全场");0 = 无涌。
   * **唯一置位点**:玩家收下磁吸宝物(spawnDrop 里精英死亡掉落、stepDrops 报数、本帧置位,
   * 三处合起来把涌的触发权从"精英死亡自动白送"挪到"亲自去捡")。取 max 不叠加 ——
   * 涌还醒着时拾起第二颗,只是余量不足就补满,不把涌抻成常态。零 rng:拾取是确定性事件。
   * 每帧在 stepDrops **之后**减 SIM_DT(照 resonanceCooldown 同款写法):置位排在递减之后,
   * 拾起那一帧的磁吸已按旧半径跑完,涌从下一帧起足额走 MAGNET_PICKUP_SURGE 秒;
   * 时停期间 step 不跑,计时器自然冻结 —— 时停不消耗涌,正是想要的。
   * 它是逐帧演化的真状态:直接决定残骸的起吸判定,漏了它,涌期间"这颗吸不吸得上"的分叉
   * 就从确定性口径下漏掉,故进 checksum(×100,与 boost 那批秒数字段同一条量化理由)、进 runSave。
   * 锁定机制(drop.ts 的"进过半径就永不放手")原样吃这个半径:涌结束后已锁定的照飞。
   */
  magnetSurgeTime = 0;

  /** 磁吸宝物收取计数(26 号改):stepDrops 每帧先清零再报数,置位 magnetSurgeTime 读它。整帧复用零分配 */
  private readonly dropOrbOut = { n: 0 };

  private scratch: Enemy[] = [];

  /**
   * 狂热光环(14 号)的半径内受害者暂存。帧首按在场光环携带者各查一次空间哈希、
   * 收进这份数组(整帧复用、零分配),敌人循环里靠它判"这一只加不加速"。
   * **可能含重复**:同一只被多只光环覆盖会进多次(倍率连乘 = 光环叠加),故不能当 Set 用。
   * 与 scratch 分开:scratch 在敌人循环里被邻居分离反复清空,这份要活到整帧走完。
   */
  private auraVictims: Enemy[] = [];

  /**
   * 开火的去处(sim/fx.ts 的 FireSink + sim/enemyBullet.ts 的 EnemyBulletSink)。
   * 塔与子弹只 `import type` 那份契约,经它回到世界里来 ——
   * 双向直连(world 调 turret、turret 取 world 的池)就是一个运行期循环依赖,
   * 在 ESM 里表现为"某一侧拿到 undefined",且只在改了 import 顺序时才炸。
   *
   * 做成**字段上的对象字面量**而不是 `World implements FireSink`:渲染层要遍历的事件池叫
   * world.fx,而契约里记事件的方法也叫 fx —— 同一个类上放不下两个同名成员。
   * 构造时建一次、整局复用(箭头函数捕获 this),不在每帧的开火路径上现造对象。
   */
  private readonly sink: FireSink & EnemyBulletSink = {
    spawnBullet: () => this.bullets.spawn(),
    damage: (e, amount, throttle, towerType) => this.damageEnemy(e, amount, throttle, towerType),
    fx: (kind, x0, y0, x1, y1, radius, towerType, damage = 0, dmgRatio = 0, stars = 0) => {
      const e = this.fx.spawn();
      e.kind = kind;
      e.x0 = x0;
      e.y0 = y0;
      e.x1 = x1;
      e.y1 = y1;
      e.radius = radius;
      e.towerType = towerType;
      e.life = fxLifeForStars(kind, stars);
      e.damage = damage;
      e.dmgRatio = dmgRatio;
      e.stars = stars;
    },
    query: (x, y, r, out) => {
      this.grid.query(x, y, r, out);
    },
    // —— 敌方弹丸的命中去处(22 号,EnemyBulletSink)——命中船体受击圆 = 真掉血
    // (改版 09 号:不再有"蹭轮廓只出火花"的擦碰层):走 damageShip(减伤在 damageShip 里
    // 按支援聚合现算),飘字与血条同款"各算各的一份、两边同源"的口径(见 settleHullDamage)
    hullHit: (x, y, damage) => {
      if (this.shipDead) return;
      // 飘字与扣血共用 shipDamageTakenMul(支援 × 加速窗)—— 两本账同源,见 settleHullDamage
      const dealt = damage * this.shipDamageTakenMul();
      this.damageShip(damage);
      this.pushHitFx(FXV_HULL_HIT, x, y, dealt, 0);
    },
    // 开火事件(改版):旧版的 broadside(单舷 ≥3 塔同帧开火)统计随甲板四舷删除,
    // 签名保留 slotIndex 是"这座塔开火"的唯一事件通道。24 号起在此落账 lastFiredTick
    // 并做齐射共振判定(纯统计、零 rng、不进 checksum —— 见 RESONANCE_WINDOW 那段)
    fired: (slotIndex) => {
      // 落账:记录的是"这个槽位开过火",不是"这把武器"—— 合成/替换换掉武器**不清**它,
      // 于是换位聚拢三塔后,过去短窗内的旧开火照样能凑成一面舷(判定只认槽位下标)。
      this.lastFiredTick[slotIndex] = this.tick;
      // 冷却期内不触发也不推事件(触发那一帧置 RESONANCE_COOLDOWN 秒)
      if (this.resonanceCooldown > 0) return;
      // 每次落账后只查**包含该槽的三个相邻三元组**(i-2..i / i-1..i+1 / i..i+2,mod 8 环回),
      // 中心分别是 i-1 / i / i+1 —— 不必扫全圈:其余三元组不含本槽,本槽刚落的账影响不到它们。
      const windowStart = this.tick - RESONANCE_WINDOW_TICKS;
      for (let d = -1; d <= 1; d++) {
        const center = (slotIndex + d + WEAPON_SLOT_COUNT) % WEAPON_SLOT_COUNT;
        if (this.resonanceTripletReady(center, windowStart)) {
          this.resonanceCooldown = RESONANCE_COOLDOWN;
          // v1 只做演出:推一条 FXV_RESONANCE 事件,towerType 借放三元组中心槽下标
          // (渲染层照 WEAPON_SLOT_FACING[中心槽] + heading 画舷侧弧光),坐标填船位、
          // radius 恒 0、life 走 fxLife(kind) —— 与其余 fx 事件同一条唯一生命周期路径。
          this.sink.fx(FXV_RESONANCE, this.ship.x, this.ship.y, this.ship.x, this.ship.y, 0, center);
          return;
        }
      }
    },
  };

  /**
   * 出怪的去处(sim/waves.ts 的 SpawnSink),与上面那个 sink: FireSink 同一条写法与同一条理由:
   * 运行器只 `import type` 那份契约、永远不认识 World —— 双向直连(world 调 waves、waves 取 world 的池)
   * 就是一个运行期循环依赖,在 ESM 里表现为"某一侧拿到 undefined",且只在改了 import 顺序时才炸。
   * 做成**字段上的对象字面量**:构造时建一次、整局复用(箭头函数捕获 this),
   * 不在每帧的出怪路径上现造对象(铁律 3)。
   */
  private readonly waveSink: SpawnSink = {
    spawn: (kind, angleRad, affixes) => this.spawnFromWave(kind, angleRad, affixes),
  };

  /**
   * @param seed 随机种子(同 seed 同操作序列逐位可复现,01 号验收)。
   * @param unlockMask 解锁状态位掩码(19 号):位 i = UNLOCKS[i] 开没开。跨局存档的一部分,
   *   与 seed 同一条"构造时给一次"的待遇 —— 它只收窄卡池与解锁精英事件的候选集合,
   *   不移动 rng 消耗次数,故不进 checksum。缺省 0 = 一切未解锁(既有调用方语义不变)。
   */
  constructor(seed: number, unlockMask: number = 0) {
    this.rng = new Rng(seed);
    this.unlockMask = unlockMask;
    this.wave = createWaveState(unlockMask);
    this.enemies = new Pool<Enemy>(createEnemy, resetEnemy);
    this.bullets = new Pool<Bullet>(createBullet, resetBullet);
    this.enemyBullets = new Pool<EnemyBullet>(createEnemyBullet, resetEnemyBullet);
    this.drops = new Pool<Drop>(createDrop, resetDrop);
    // HP 上限问 damage.hullMaxHp 而不是直接读 tuning:法令聚合(装甲协议 +15/层)让它
    // 成为**法令层数的派生量** —— 构造时零法令 = 聚合全中性,上限 = 基准 100。
    this.ship.hp = this.ship.maxHp = hullMaxHp(this.buffs);
  }

  /** 开局至今的秒数。HP 时间缩放(GDD §14)的唯一时间源:挂在 tick 上才与 checksum 同口径 */
  get elapsed(): number {
    return this.tick * SIM_DT;
  }

  /** 下一次升级所需残骸。只从 upgrades 派生,不单独进 checksum。 */
  get upgradeCost(): number {
    return economyUpgradeCost(this.upgrades);
  }

  /**
   * 当前实际转向速率(°/s)= tuning 基础值 + 已持有法令的加点(重心校准 +10)。
   * (旧版的"每扩建一格 −1°/s"随甲板删除 —— 槽位制没有扩建,转向只有基准与法令两档。)
   */
  get turnRate(): number {
    return tuning.shipTurnRate + this.buffs.turnRateAdd;
  }

  /**
   * 当前主压方向 —— 世界系**绝对角**(弧度,0 = +X,顺时针为正,与 ship.heading 同一套),
   * 不是相对船头的角(相对船头的话玩家转舵就没意义了,GDD §6.3「最优舷持续漂移」)。
   *
   * 11 号的威胁罗盘直接读这两个 getter:HUD 不必认识 WaveState 的内部字段,
   * 将来波次状态改结构,要跟着改的也只有这两句。
   */
  get threatDirection(): number {
    const x = this.threatDirX;
    const y = this.threatDirY;
    return this.threatRate > THREAT_DIRECTION_MIN_RATE &&
      x * x + y * y > THREAT_DIRECTION_EPSILON * THREAT_DIRECTION_EPSILON
      ? Math.atan2(y, x)
      : this.wave.dirRad;
  }

  /**
   * 当前主压强度(只/秒)= 正式出怪器实际成功落地事件的一阶平滑速率。
   * 普通流与 burst 都进；在场上限丢弃的请求不进。没有成功样本时从 0 起步，不拿脚本计划速率冒充实况。
   */
  get threatIntensity(): number {
    return this.threatRate;
  }

  /** peekNextBurst 的答复暂存与对外读数对象:整局复用,渲染帧现读不新增分配(铁律 3) */
  private readonly burstPeek: BurstPeek = { etaSeconds: 0, offsetDeg: 0, pattern: 0 };
  private readonly burstWarningOut = { etaSeconds: 0, dirRad: 0, pattern: 0 };

  /**
   * 下一个侧压 burst 的预警读数(11 号罗盘的补课,HUD 预警箭头用):
   * etaSeconds = 还有几秒触发,dirRad = 世界系绝对角(脚本当前主压方向 + 脚本偏移,
   * 与罗盘回退路径同源);pattern = BURST_PATTERN_* 原样透传 —— 环阵时来向箭头没有意义,
   * HUD/渲染层照它改画全环脉冲(25 号)。
   * 没有待触发的 burst(段内已放完 / 脚本走完 / 压测旁路)返回 null。
   * 纯读取、零 rng、不进 checksum —— 它只是把脚本里本来就写着的事提前念给玩家听。
   * 返回的是整局复用的同一个对象,调用方当场读走,别跨帧存引用。
   */
  burstWarning(): { etaSeconds: number; dirRad: number; pattern: number } | null {
    if (tuning.stressSpawn || this.wave.done) return null;
    if (!peekNextBurst(this.wave, this.burstPeek)) return null;
    this.burstWarningOut.etaSeconds = this.burstPeek.etaSeconds;
    this.burstWarningOut.dirRad = this.wave.dirRad + this.burstPeek.offsetDeg * DEG2RAD;
    this.burstWarningOut.pattern = this.burstPeek.pattern;
    return this.burstWarningOut;
  }

  /**
   * @param cmd 本逻辑帧的输入(纯数据)。只读不缓存引用,调用方可以整局复用同一个对象;
   *   缺省 = 松手,让 world.step() 的既有调用方(单测、无头跑批)不必关心输入。
   *
   * 顺序定死(单测按此钉):**支援聚合 + HP 上限(帧首派生量)** → 船 → 出怪 →
   * 重建空间哈希 → 清 contacts → 敌人(视野回收重投(在 px/py 存档之前,防插值拖影)→
   * 积分 + hitCd 递减 + 粗筛入 contacts)→ 点防拦截 → 炮管(含节流与开火)→ 子弹 →
   * 残骸(磁吸与收取)→ 船体受击结算 → 可视化事件老化 → 回收死者(含掉落)→ 局终判定 →
   * 升级候选结算。
   * (地图无限,原"贴边夹取"一步已删,见 ENEMY_RECYCLE_RADIUS 那段。)
   *
   * 支援聚合排在**最前**:这一帧的塔按最新的支援加成开火、这一帧的撞击按最新的上限与减伤
   * 结算 —— 买下一座支援后,加成与上限当帧就生效,而不是靠下一次 step 才想起来重算
   * (改版 06 号验收"购买即时生效"的落点就在这两句)。
   * 出怪排在建哈希之前,新生的敌人当帧就参与分离;
   * 炮管排在敌人循环**之后**:敌人本帧已经动完,塔瞄的就是本帧位置 ——
   * 反过来的话每座塔都恒定落后一帧,贴脸高速目标会永远被瞄在身后(04 号 issue);
   * 点防拦截排在炮管**之前**(顺序 = 优先级,一帧里弹丸与敌人同时在射界内时先拦弹丸,
   * 理由全文见 sim/intercept.ts 的文件头);
   * 子弹排在炮管之后,于是本帧新出膛的弹当帧就走一步、px/py 停在炮口
   * (与"出怪排在建哈希之前、新生敌人当帧就动"同一条口径);
   * 残骸排在子弹之后、受击结算之前 —— 它是世界里会动的东西,该在这一帧的伤害账结清之前把自己走完;
   * 而它与子弹刻意**不**同口径:本帧新掉的那颗还没进池(掉落发生在帧尾的 reap),
   * 于是它当帧一步不动、px/py 停在敌人倒下的地方,下一帧才起吸 ——
   * 那正是玩家该读到的因果:先看见经验掉在尸体上,再看见它飞过来;
   * 受击结算排在**子弹之后**,于是"本帧刚被塔打死的敌人"那一句过滤真的有意义(尸体不许再咬一口),
   * 又排在**回收之前**,因为尸体整帧都还在池里 —— contacts 里存的是池中对象,
   * 回收先走的话名单里会留着已经出池、且可能已被复用成另一只敌人的引用;
   * 回收排在最后,于是"本帧被打死的敌人"在整帧里始终可见(渲染/结算读到的是同一批人);
   * 局终判定排在**回收之后**,于是它读到的是这一帧走完的账 —— 最后一发打死的那只算进 kills,
   * 结算界面上的击杀数才不会比玩家亲眼看到的少一只;
   * 升级候选排在局终之后且只在 RESULT_RUNNING 时生成:同一帧若已经胜负落定,绝不再在结算界面下面弹卡。
   */
  step(cmd: ShipCommand = IDLE): void {
    this.tick++;
    let openedRefit = false;

    // 威胁统计先衰减、再接本帧成功出怪的脉冲。顺序定死后，同一帧的 burst 会以完整强度出现，
    // 而不是刚落地就先被扣掉一帧；没有新样本时三项只做乘法，平滑地退回 0。
    this.threatRate *= THREAT_SMOOTH_DECAY;
    this.threatDirX *= THREAT_SMOOTH_DECAY;
    this.threatDirY *= THREAT_SMOOTH_DECAY;
    // 逐武器 DPS 同一条"帧首衰减、结算时进脉冲"的顺序(常量注释里有账):
    // 本帧稍后开火的伤害以完整强度进账,没在打的塔平滑退回 0。
    // 顺手把总和跟峰值比一次(局末战报的"最高一刻"):在衰减后取样,读到的是稳态口径
    let dpsSum = 0;
    for (let i = 0; i < TOWER_KIND_COUNT; i++) {
      this.dpsByType[i]! *= DPS_SMOOTH_DECAY;
      dpsSum += this.dpsByType[i]!;
    }
    if (dpsSum > this.peakDps) this.peakDps = dpsSum;

    // 法令聚合与 HP 上限两样派生量在帧首统一刷,于是"这一帧"的塔与"这一帧"的撞击
    // 读到的都是最新的法令。聚合每帧全量重算:10 条法令的几次 pow,
    // 比维护 revision 守卫便宜(旧版那套守卫是几十格甲板遍历的遗产,层数表不需要)。
    // 它也是转向/巡航/磁吸/星币概率的来源 —— 帧首刷一次,后面每一处现读同一份。
    aggregateEdictBuffs(this.edictLevels, this.buffs);
    // HP 上限同理是**法令层数的派生量**(装甲协议 +15/层,damage.hullMaxHp):拿到的当帧就该生效,
    // 每帧现算而不是记个脏标记。
    //
    // **只夹不涨**:上限回落时把 hp 压进新上限(否则会留下一艘 hp > maxHp 的船,
    // 血条画出去满出来),但上限涨上去时 hp 一分不还 —— 装甲协议是船的规格,不是治疗。
    this.ship.maxHp = hullMaxHp(this.buffs);
    if (this.ship.hp > this.ship.maxHp) this.ship.hp = this.ship.maxHp;

    // 加速技能(空格):触发判定在计时递减**之前** —— 触发那一帧就是加速的第一帧,
    // 玩家按下与船提速之间没有一帧的空档。冷却从触发起算(含加速窗),归零前按了也不响。
    // cmd.boost 是每逻辑帧采样的纯数据输入(与 desiredHeading 同一条铁律 1 口径)
    if (cmd.boost && this.boostCooldown <= 0) {
      this.boostTime = tuning.boostDuration;
      this.boostCooldown = tuning.boostCooldown;
    }
    const boosting = this.boostTime > 0;
    if (this.boostTime > 0) this.boostTime = Math.max(0, this.boostTime - SIM_DT);
    if (this.boostCooldown > 0) this.boostCooldown = Math.max(0, this.boostCooldown - SIM_DT);

    // 船先动:敌人这一帧要追的是船的新位置,晚一帧追会让高速时的包夹肉眼可见地滞后。
    // 地图无限,船不再被任何边界夹取(原 WORLD_RADIUS 已删,理由见 ENEMY_RECYCLE_RADIUS 那段)。
    // 巡航倍率(18 号巡航校准)照 turnRateDeg 的先例由 World 现算传入:未持有 = 1,逐位恒等;
    // 加速窗内巡航与推力再乘 tuning.boost*(现读,面板拖动即时生效)。
    // 加速窗内**无方向输入**时沿船头满推(desired 顶成船头方向):不给这一手,
    // 松着方向键按空格就什么都不发生 —— "点燃了推进器船却不动"是最违和的哑火
    const ship = this.ship;
    let desiredHeading = cmd.desiredHeading;
    if (boosting && desiredHeading === null) {
      boostForward.x = Math.cos(ship.heading);
      boostForward.y = Math.sin(ship.heading);
      desiredHeading = boostForward;
    }
    stepShip(
      ship,
      desiredHeading,
      SIM_DT,
      this.turnRate,
      this.buffs.cruiseSpeedMul * (boosting ? tuning.boostSpeedMul : 1),
      boosting ? tuning.boostAccelMul : 1,
    );

    // 商店信标:计时 + 接触判定。排在 stepShip **之后**,于是判的是船**本帧**的位置 ——
    // 晚一帧的话高速冲刺穿过信标会出现"明明擦过去了却没接上"。
    // **先判到店、后判到期**:同一帧既撞上又走完计时算到店(玩家赶上了就是赶上了)。
    if (this.shopBeaconActive) {
      this.shopBeaconTtl -= SIM_DT;
      const bdx = ship.x - this.shopBeaconX;
      const bdy = ship.y - this.shopBeaconY;
      // 判定半径 = 信标半径 + 船体受击圆(damage.shipRadius 的唯一口径,与撞击精筛同一份几何)
      const br = SHOP_BEACON_RADIUS + shipRadius(tuning.shipLength);
      if (bdx * bdx + bdy * bdy <= br * br) {
        // 到店:信标当场熄灭(一轮一次,面板关掉也不许再接一次),开面板 + 免费回血。
        // 回血挂在**接上的这一刻**而不是关面板时:玩家要能在店里看着血条回上去,
        // 再决定这 25 星币的付费修复还买不买(data/economy 的 REFIT_HEAL_FRACTION 那段)
        this.shopBeaconActive = false;
        this.shopBeaconTtl = 0;
        this.refitPending = true;
        this.ship.hp = Math.min(
          this.ship.maxHp,
          this.ship.hp + Math.ceil(this.ship.maxHp * REFIT_HEAL_FRACTION),
        );
        openedRefit = true;
      } else if (this.shopBeaconTtl <= 0) {
        // 没赶到:信标熄灭,两张货架与特价一起作废 —— 留着的话下一轮会拿到过期货
        this.shopBeaconTtl = 0;
        this.shopBeaconActive = false;
        this.dockEdictOffers.length = 0;
        this.shopWeapons.length = 0;
        this.shopDiscountIndex = -1;
      }
    }

    // 出怪。正式路径是波次脚本的运行器(sim/waves.ts):它一个字都不认识世界,只说"朝这个方向
    // 出一只这型的怪",落点由 waveSink → spawnFromWave 补完。
    // **位置不许挪**:排在船积分**之后**,于是出怪环是以船**本帧**的位置为心的
    //(晚一帧的话高速航行时整个环会拖在船身后,主压方向当场歪掉);
    // 又排在建哈希**之前**,于是新生的敌人当帧就参与分离、当帧就动(铁律 2 的 px/py 停在出生点)。
    //
    // tuning.stressSpawn = true 时**整段旁路**回到 01 号那条压测路(见 stressSyncCounts):
    // 波次状态冻在初值(方向不转、永不 done、这一局没有胜利条件),换来"场上恒定 N 只"这种定数。
    // 注意:压测路上运行中通过面板改数量会消耗 rng,之后的 checksum 不再与"从头跑"可比
    if (tuning.stressSpawn) this.stressSyncCounts();
    else if (!this.refitPending) {
      const segmentBefore = this.wave.segment;
      // 商店搬上地图之后**段边界不再停顿**(stopAtSegmentBoundary = false):虫潮连续流动,
      // 玩家自己决定什么时候脱离战线去接信标 —— 那正是"过去拿"这条设计的代价所在。
      stepWaves(this.wave, SIM_DT, this.rng, this.waveSink, false);
      if (this.wave.segment !== segmentBefore && !this.wave.done) {
        // 跨段那一帧一次掷定四样,**顺序定死**(信标位置 → 法令货架 → 武器货架 → 特价):
        // 与出怪同一条"帧首、定死顺序"的确定性 —— 玩家去不去、买不买都扰动不到这条随机序列
        // (接信标与购买都零 rng,见 buyDockEdict / buyShopWeapon)。
        // 货架在**信标生成时**就掷定而不是接上时才掷:接不接得上取决于玩家操作,
        // 让它决定 rng 时点等于把随机序列交给玩家手速 —— 同 seed 同操作序列的回放当场作废。
        this.spawnShopBeacon();
        this.rollDockEdicts();
        this.rollShopWeapons();
        this.rollShopDiscount();
        this.onShopBeacon?.(this.wave.segment);
      }
    }

    // Boss 阶段(15 号 T1):脚本走完(第 4 段结束)的那一帧进入 —— 世界侧状态机,
    // 不做第 5 段、不改 wave.done 语义(wave.done 仍是"脚本走完"的派生量,sim/waves.ts
    // 原样保留;压测路旁路 stepWaves,done 恒 false,这里天然进不来)。
    // 进入 = 生成 Boss 一只(零 rng);此后每帧推进召唤计时(召唤消费 rng,排在这里与
    // 出怪同一条"帧首"顺序,先出怪后召唤的顺序定死,同 seed 才逐位可复现)。
    // 船已沉就不再登场:失败优先口径,出场与否由 shipDead 决定,确定性不受影响。
    // 进入的那一帧不扣召唤计时 —— 与 enemy 状态机"刚进入某状态的那一帧不扣计时"同口径,
    // "Boss 登场后整 summonInterval 秒才首召"这条承诺才钉得住
    if (this.wave.done && this.bossPhase === 0 && !this.shipDead) this.enterBossPhase();
    else if (this.bossPhase === 1) this.stepBossSummon();

    // 重建空间哈希
    const enemies = this.enemies.items;
    this.grid.clear();
    for (let i = 0; i < enemies.length; i++) this.grid.insert(enemies[i]!);

    // 船坐标与全局倍率 hoist 出循环:1000 敌是本轮压测场景,热循环里每帧多几次属性穿透没必要。
    // hoist 到帧内而不是构造时 —— 每帧仍是现读,面板拖动照样即时生效
    const tx = ship.x;
    const ty = ship.y;
    const sep = tuning.enemySeparation;
    const speedScale = tuning.enemySpeedScale;
    // 词缀表参数每帧现读(与 tuning 同口径:改 data/affixes.ts 即时生效,不必重开)
    const frenzy = AFFIXES[AFFIX_FRENZY]!;
    const frenzyR = frenzy.frenzyRadius;
    const frenzyMul = frenzy.frenzySpeedMul;
    const magnetPickupMul = AFFIXES[AFFIX_MAGNETIC]!.pickupMul;

    // 帧首(哈希已重建、敌人循环之前):在场词缀的**全局效应**扫一遍(14 号)。
    // 狂热光环:以每个光环携带者为心查空间哈希,把半径内的**其他**敌人收进 auraVictims ——
    // 携带者自己恰好在半径内也不许自加速("半径内其他敌人加速"是词缀原话);
    // 同一只被多只光环覆盖会进多次,倍率连乘 = 光环叠加。
    // grid.query 只做 AABB 粗筛(spatialHash 契约:精确距离由调用方判定,
    // 与邻居分离/爆炸命中同一口径),这里补一次平方距离复核,防角落格误加速。
    // 磁力干扰:任一携带者在场,玩家拾取半径整体 ×pickupMul —— 修正挂在
    // drop.magnetRadius 读的那一处(drop.ts),本帧扫描只负责把"干扰在场"翻成倍率。
    this.auraVictims.length = 0;
    let magnetMul = 1;
    for (let i = 0; i < enemies.length; i++) {
      const c = enemies[i]!;
      if (c.affixes === 0) continue; // 普通怪(绝多数):一条分支都不进,热路径不白付
      if (hasAffix(c, AFFIX_FRENZY)) {
        const fr2 = frenzyR * frenzyR;
        this.grid.query(c.x, c.y, frenzyR, this.scratch);
        for (let k = 0; k < this.scratch.length; k++) {
          const t = this.scratch[k]!;
          if (t === c) continue;
          const ox = t.x - c.x;
          const oy = t.y - c.y;
          if (ox * ox + oy * oy >= fr2) continue;
          this.auraVictims.push(t);
        }
      }
      if (hasAffix(c, AFFIX_MAGNETIC)) magnetMul = magnetPickupMul;
    }
    // 磁力协议(拾取半径 +30%/层):与词缀干扰同一个倍率连乘 —— 层数变了当帧即读
    // (聚合在帧首刷过)。未持有 = ×1,既有链路逐位一字不差
    magnetMul *= this.buffs.magnetRadiusMul;
    // 磁吸涌(26 号改)接在这条连乘链尾部:与磁力协议/磁力干扰同一条链,一律连乘 ——
    // 涌的倍率大到干扰减半也罩全场,不必开例外。锁定机制(drop.ts 的"进过半径就永不放手")
    // 原样吃这个半径:涌结束后已锁定的照飞,这正是想要的"哗——全进账"
    if (this.magnetSurgeTime > 0) magnetMul *= MAGNET_PICKUP_RADIUS_MUL;
    // 粗筛半径 = 船体受击圆(damage.shipRadius 的唯一口径,与精筛同一份几何)
    const contactR = shipRadius(tuning.shipLength);

    this.contacts.length = 0;

    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i]!;

      // 无限地图的防风筝(理由全文见 ENEMY_RECYCLE_RADIUS):被甩开的敌人回收进视野缓冲圈。
      // 排在 px/py 存档**之前**,于是插值的两端都在新位置上 —— 不会有一帧横跨整张屏的拖影
      // (它本就在屏外,但 144Hz 插值的中间采样点可能扫进屏里)。
      // 只有 BH_SEEK/接近段的怪才可能落到这么远(驻留/冲锋的活动半径 ≤ 560),状态机不必复位。
      // **Boss 不参与回收**(二轮审查收束账):追速 56 < 巡航 130,直线风筝必触发回收,而回收
      // 落点(1150-1300)恒在全塔 3★ 射程(≈790)之外 —— 旧口径下 Boss 每被甩开就瞬移到航向
      // 前方,风筝期间双方互不可达,终局战既不赢也不输、还能无限刷召唤波资源。排除后 Boss
      // 只从它实际的位置诚实逼近:逃跑 = 玩家主动放弃完成(想收束随时掉头,Boss 就在身后),
      // 战斗中也不会因一次拉扯把 Boss 瞬移到视野另一头、把战场几何搅碎。
      {
        const fdx = e.x - tx;
        const fdy = e.y - ty;
        const fd2 = fdx * fdx + fdy * fdy;
        if (e.kind !== KIND_BOSS && fd2 > ENEMY_RECYCLE_RADIUS * ENEMY_RECYCLE_RADIUS) {
          // 落点**零 rng**:半径与扇面角偏都取自 e.animSeed([0,1) 的出生哈希,每只恒定,
          // 于是同 seed 回放/读档逐位一致,也不扰动出怪随机序列。s2 = 同一粒种子的第二个
          // 分数折(×137 取小数),把"半径偏大"与"角偏右"这两件事解耦开。
          const s = e.animSeed;
          const s2 = (s * 137) % 1;
          const ang =
            ship.heading + (s2 * 2 - 1) * ENEMY_RECYCLE_SPREAD_DEG * DEG2RAD;
          const r = SPAWN_RADIUS + s * SPAWN_RADIUS_BAND;
          e.x = tx + Math.cos(ang) * r;
          e.y = ty + Math.sin(ang) * r;
          // 回收也是一次"压力从这个方向来"的既成事实,照出怪那样喂给威胁罗盘(方向 = 实际
          // 落点方位)。不喂的话,玩家背对主压方向持续逃跑时,慢速主压流全部被回收进航向
          // 正前方,罗盘却仍指着身后的脚本方位 —— HUD 读数与实际来向长期相反。
          // 只喂方向不喂 threatRate:强度读数的语义是"出怪速率",回收没有新增一只怪。
          // 与出怪样本同款零分配、零 rng,且威胁统计不进 checksum,确定性不受影响
          this.threatDirX += Math.cos(ang) * THREAT_SPAWN_IMPULSE;
          this.threatDirY += Math.sin(ang) * THREAT_SPAWN_IMPULSE;
        }
      }

      e.px = e.x;
      e.py = e.y;
      const isBoss = e.kind === KIND_BOSS;

      // 无敌帧逐帧减 dt、夹 0。**每只敌人各自一份**:
      // 全船一个冷却的话,蜂群贴脸时只有最先判到的那一只咬得动,"一百只压上来"与"一只压上来"
      // 的掉血速率会一模一样(见 Enemy.hitCd 的字段注释)。Boss 与普通怪同一条冷却。
      if (e.hitCd > 0) e.hitCd = Math.max(0, e.hitCd - SIM_DT);
      // 受击闪白逐帧减 dt、夹 0(与 hitCd 同口径):闪白是"这一发打中了"的回执,
      // 减到 0 就熄 —— 渲染层只读剩余量,不自己推第二份计时(纯表现,不进 checksum)
      if (e.hitFlash > 0) e.hitFlash = Math.max(0, e.hitFlash - SIM_DT);

      // 行为只给"期望速度 + 追随系数",位置由这里积分(sim/enemy 不碰位置)。
      // Boss 走自己的状态机(sim/boss.ts,寻路原语与普通怪同源:seek/lockCharge),
      // 契约与 stepEnemyBehavior 完全一致 —— 下面的积分一行都不分叉。
      const follow = isBoss
        ? stepBossBehavior(e, ship, SIM_DT, desired)
        : stepEnemyBehavior(e, ship, SIM_DT, desired);
      // 孢子齐射落地(22 号):状态机在蓄力到期那一帧置位 sporeFire 闩,这里当场读走并清回 ——
      // 发射弹丸是副作用,状态机只出"期望速度 + 追随系数"(见 sim/enemy.ts 的文件头)。
      // 排在本帧积分之前:弹丸从孢子上一帧的位置出膛,预警环画的也是那个位置(见 fireSporeVolley)
      if (e.sporeFire) {
        e.sporeFire = false;
        this.fireSporeVolley(e);
      }
      let dvx = desired.x;
      let dvy = desired.y;

      // 邻居分离**只在接近段叠加**:前摇/冲刺/硬直期间被同伴推离锁定直线,
      // 直线冲锋就不再是直线 —— 前摇预警画出的那条线会变成谎言(07 验收标准第二条)。
      // 分离半径用全局 tuning.enemySeparation 而不做成 per-kind:它是人群的物理常量,
      // 且必须守住"查询半径 ≤ 一个 cell"的性能口径(GDD §13)。
      // Boss 的 state 恒 ≠ ST_APPROACH,走不到这里 —— 巨型个体不被虫群推挤。
      if (sep > 0 && e.state === ST_APPROACH) {
        const def = ENEMIES[e.kind]!;
        const speed = def.speed * speedScale * e.speedMul;
        this.grid.query(e.x, e.y, sep, this.scratch);
        for (let j = 0; j < this.scratch.length; j++) {
          const n = this.scratch[j]!;
          if (n === e) continue;
          const ox = e.x - n.x;
          const oy = e.y - n.y;
          const d2 = ox * ox + oy * oy;
          if (d2 >= sep * sep || d2 === 0) continue;
          const d = Math.sqrt(d2);
          const push = ((sep - d) / sep) * speed;
          dvx += (ox / d) * push;
          dvy += (oy / d) * push;
        }
      }

      // 狂热光环加成(14 号):只对接近段生效 —— 与邻居分离同一条口径,冲刺是锁定直线,
      // 加速会让前摇预警画出的那条线变成谎言;前摇/硬直里期望速度本就归零,乘什么都还是零。
      // 倍率读词缀表、每帧现乘进期望速度,再走下面同一阶追随(目标变远、追随系数不变)。
      // auraVictims 是帧首按光环携带者查空间哈希攒出来的(可能含重复 = 多光环叠加连乘)
      if (e.state === ST_APPROACH && this.auraVictims.length > 0) {
        for (let j = 0; j < this.auraVictims.length; j++) {
          if (this.auraVictims[j] === e) {
            dvx *= frenzyMul;
            dvy *= frenzyMul;
          }
        }
      }

      e.vx += (dvx - e.vx) * follow;
      e.vy += (dvy - e.vy) * follow;
      e.x += e.vx * SIM_DT;
      e.y += e.vy * SIM_DT;

      // 粗筛:船体受击圆 + 敌人体型(与精筛**同一份几何**,damage.shipRadius)。
      // 只登记,不扣血、不弹开、不消灭 —— 结算全在帧尾的 settleHullDamage 一处做完,
      // 这里多做一步都会跟它打架(而且要在 1000 敌的热循环里重复付判定的钱)。
      // 体型那一项走 enemyRadius(精英 ×ELITE.scale);Boss 走 bossRadius()(15 号:
      // 它不进 ENEMIES 表,判定体单独一份口径,与 sim/boss.ts 的 bossRadius 同源)。
      // 粗筛圆的半径口径全仓只有这两份来源,别处不许另抄
      const cr = contactR + (isBoss ? bossRadius() : enemyRadius(e));
      const cdx = e.x - tx;
      const cdy = e.y - ty;
      if (cdx * cdx + cdy * cdy < cr * cr) this.contacts.push(e);
    }

    // 点防拦截(22 号):**排在 stepTurrets 之前** —— 顺序就是优先级,一帧里弹丸与敌人
    // 同时在射界内时,点防先把这一发打给弹丸;onFired 写下的 cooldown 把 stepTurrets 的
    // canFire 当场闸住,天然不会双射(设计决策与理由全文见 sim/intercept.ts 的文件头)。
    // 零 rng:拦截一步都不掷,出怪/召唤的随机序列不受影响
    stepInterception(this.weapons, ship, this.enemyBullets.items, SIM_DT, this.sink, this.buffs);

    // 炮管:朝射界内最近的敌人转,没得打就归位(04 号 issue),够得着又转得过来就开火(05 号)。
    // 传 this.grid 而不是 enemies:1000 敌 × 四座塔的线性扫描是 GDD §13 明令要用哈希避开的那件事;
    // 传 this.sink 而不是 this:开火侧只认识 FireSink 那份契约,永远不认识 World(见 sim/fx.ts);
    // 传 this.buffs:全船法令聚合,开火节奏与伤害倍率的唯一来源 ——
    // "哪一系吃哪条法令"已在聚合里按 throttle 折过,故这里不再逐槽挑倍率
    stepTurrets(this.weapons, ship, this.grid, SIM_DT, this.sink, this.buffs);

    // 子弹:积分 → 命中 → 迫击炮到期在落点炸 AoE(规则全在 sim/bullet.ts,本文件只给它一个 sink)
    stepBullets(this.bullets, SIM_DT, this.sink);

    // 敌方弹丸(22 号):积分 → 船体受击圆判定(真掉血)→ 回池。
    // 排在 my 子弹之后:拦截弹本帧已经飞完,弹丸再动,命中结算在下面那个 pass 里做 ——
    // 顺序定死,同 seed 逐帧可复现;它也是 damageShip 那条预留接口的第一个真实调用方
    stepEnemyBullets(this.enemyBullets, SIM_DT, this.ship, this.sink);

    // 拦截弹 × 弹丸的命中结算(22 号):两边都移动完的这一帧末,线段 × 圆判定,
    // 命中 = 双回池 + FXV_IMPACT(确认这一发打在弹丸上)。零 rng、零分配
    stepInterceptHits(this.bullets, this.enemyBullets, (towerType, x, y, stars) => {
      this.sink.fx(FXV_IMPACT, x, y, x, y, 0, towerType, 0, 0, stars);
    });

    // 残骸:起吸 → 匀速直追 → 收取,收到多少当帧进账(规则全在 sim/drop.ts,这里只给它池与船心)。
    // 船心传的是本帧**积分之后**的位置:残骸追的是船现在在哪 ——
    // 晚一帧的话,高速航行时整串残骸会恒定拖在船身后(与出怪环以船本帧位置为心同一条理由)。
    // magnetMul 是帧首扫出来的磁力修正(词缀干扰 × 法令过载,14/18 号);
    // 经验倍率(buffs.xpMul)由 stepDrops 内部乘好 —— 这一句只进账。
    // dropOrbOut 同时接着磁吸宝物的收取计数:收下几颗,置位几句后面的 magnetSurgeTime
    this.scrap += stepDrops(this.drops, ship.x, ship.y, SIM_DT, magnetMul, this.buffs.xpMul, this.dropOrbOut);

    // 磁吸涌计时排在 stepDrops **之后**递减(照 resonanceCooldown 同款写法,逐帧减 dt、夹 0):
    // 时停期间 step 不跑,计时器自然冻结 —— 时停不消耗涌(想要的)。
    if (this.magnetSurgeTime > 0) {
      this.magnetSurgeTime = Math.max(0, this.magnetSurgeTime - SIM_DT);
    }
    // 磁吸宝物置位(26 号改)排在递减**之后**:拾起那一帧的磁吸已按旧半径跑完,
    // 涌从下一帧起足额走 MAGNET_PICKUP_SURGE 秒;取 max 不叠加 —— 涌还醒着时
    // 拾起第二颗,只是余量不足就补满。零 rng:拾取是确定性事件。
    if (this.dropOrbOut.n > 0) {
      this.magnetSurgeTime = Math.max(this.magnetSurgeTime, MAGNET_PICKUP_SURGE);
    }

    // 船体受击结算:粗筛名单 → 受击圆精筛 → 扣血(顺序理由见块注释与 settleHullDamage)
    this.settleHullDamage();

    // 可视化事件老化。倒序 swap-remove(与 reap 同一个下标坑);它纯是表现,不参与任何判定,
    // 故老化排在开火之后、回收之前的哪一步都无所谓 —— 唯一要紧的是每帧只走一次
    const fx = this.fx.items;
    for (let i = fx.length - 1; i >= 0; i--) {
      const e = fx[i]!;
      e.life -= SIM_DT;
      if (e.life <= 0) this.fx.despawnAt(i);
    }
    // 共振冷却同一条"纯表现"口径,跟着 fx 老化一起走帧(逐帧减 dt、夹 0):
    // 它不参与任何判定、不进 checksum,只决定"这一帧的齐射还推不推演出"
    if (this.resonanceCooldown > 0) {
      this.resonanceCooldown = Math.max(0, this.resonanceCooldown - SIM_DT);
    }

    this.reap();

    // 局终判定收尾:这一帧的判据(shipDead 在受击结算里置、wave.done 在帧首的出怪那一步置、
    // bossPhase 与 kills 在 reap 里才落账)到这里才全部就位。判完世界也不停 ——
    // 停不停是 main.ts 的事
    this.settleOutcome();

    // 同一帧若沉船/通关，结算优先，不能在结算面板下面再弹一层商店。
    if (openedRefit) {
      if (this.result === RESULT_RUNNING) this.onRefitOffer?.(this.shopBeaconSegment);
      else {
        this.refitPending = false;
        // 整备被局终吞掉:两张货架一起清空,免得下一轮(不会有)或任何读它的路径拿到过期货
        this.dockEdictOffers.length = 0;
        this.shopWeapons.length = 0;
      }
    }

    // 经济是帧尾最后一步:本帧刚收到的经验已经进账、胜负也已经定完。
    // 只有仍在跑的局才会生成候选;World 只响回调,暂停与弹卡归 main.ts。
    this.settleUpgrade();
  }
  /**
   * 局终判定(08 号 T3 + 15 号 Boss)—— 一局最多落一次结论,**判完就此定死**。
   * 放在 step() 的最末而不是判据产生的那几处:shipDead 在帧中的受击结算里置位、
   * wave.done 在帧首的出怪那一步置位、bossPhase 在帧尾的 reap 里翻(击杀那一帧才落账),
   * 只有帧尾这一个点上三条路都已就位、本帧的击杀也已入账,
   * 回调里读到的存活时间与击杀数才是完整的一帧(结算界面读的就是这两个数)。
   *
   * **失败优先于胜利**:同一帧既沉船又走完脚本算失败 —— 船都没了,最后那一段脚本走没走完不重要,
   * 反过来会让"终点线前一秒被撞沉"变成一次莫名其妙的胜利。
   * **胜利 = 脚本走完 且 Boss 已击杀**(15 号):第 4 段走完只是进入 Boss 战的时机,
   * Boss 未击杀前 wave.done 什么都不给。
   * 两者互斥、且各只触发一次,全靠首句那一个提前返回。
   *
   * World **不自己暂停、不重开、不动 loop**:有了结论之后 step() 照常可以继续调用
   *(既有那条"船沉后世界照常往下跑"的用例仍然成立)—— 世界不认识"游戏流程"。
   */
  private settleOutcome(): void {
    // 已经有结论就再也不改口:这一句同时保证了 onGameOver 只可能响一次
    //(与 damageShip 那句 shipDead 早返回、applyDamage 的"同帧重复致命只算一次"是同一条口径)
    if (this.result !== RESULT_RUNNING) return;
    if (this.shipDead) this.result = RESULT_LOSE;
    else if (this.wave.done && this.bossPhase === 2) this.result = RESULT_WIN;
    else return; // 还在跑:一个字段都不动,更不响回调
    this.onGameOver?.(this.result);
  }

  /**
   * 帧尾检查是否该生成一次三选一。候选存在时一律不重掷:玩家停在卡片前多久都看到同一组三张,
   * rng 也不会因为 UI 停留时间不同而继续往前走。
   *
   * 弹卡冷却也在这里走帧(每帧减 dt、夹 0):上一次结算后的 UPGRADE_OFFER_COOLDOWN 秒内
   * 即使够钱也不弹 —— 挡的是"跨档余额让恢复战斗的下一帧立刻再时停"那种连环打断,
   * 攒出的余额一分不丢,只是延后。注意它移动了 rollUpgradeOffer 消耗 rng 的时点,
   * 是确定性口径的一部分(进 checksum)。
   *
   * 四类都没有合法项时 rollUpgradeOffer 返回 0:当场按「跳过」结算并且**不响回调** ——
   * 弹一张空面板会把玩家永久卡在时停里;什么都不做则下一帧又满足够钱条件,形成每帧重掷死循环。
   */
  private settleUpgrade(): void {
    if (this.offerCooldown > 0) {
      const left = this.offerCooldown - SIM_DT;
      this.offerCooldown = left > 0 ? left : 0;
      if (left > 0) return;
    }
    if (
      this.result !== RESULT_RUNNING ||
      this.refitPending ||
      this.offer.length > 0 ||
      this.scrap < this.upgradeCost
    )
      return;
    // 战斗内升级在槽位上新增武器(同型 = 升星合成),或叠一层法令(两类权重见 data/economy.ts);
    // 商店专属于地图信标。edictLevels 让**满层**的法令剔出候选(不是"已持有"——法令可叠到 5 层);
    // weapons 让已满 3★ 的同型武器剔出候选;unlockMask(19 号)让未解锁的塔/法令不进候选 ——
    // 三者同一条"只收窄可选表、不碰 rng"口径
    if (
      rollUpgradeOffer(this.rng, this.offer, this.edictLevels, this.unlockMask, this.weapons) === 0
    ) {
      this.completeUpgrade(skipRefundFor(this.upgradeCost));
      return;
    }
    // 新一档三张全新候选 = 一次新的重摇机会(16 号):次数限制随档重置。
    // 排在 rollUpgradeOffer **之后**:失败的那一档(返回 0)没有生成新 offer,不重置。
    this.offerRerolled = false;
    this.onUpgradeOffer?.();
  }

  /**
   * 结算一轮经济账。refund 是返还额的上限,实际到账夹在本轮 cost 内:
   * 第 0 级费用若低于返还额,跳过最多只是免单,绝不能净赚经验并立刻再弹一张。
   * 顺手把弹卡冷却拉满:下一次三选一至少隔 UPGRADE_OFFER_COOLDOWN 秒(理由见 settleUpgrade)。
   */
  private completeUpgrade(refund: number): void {
    const cost = this.upgradeCost;
    this.scrap -= cost;
    this.scrap += Math.min(Math.max(0, refund), cost);
    this.upgrades++;
    this.offer.length = 0;
    this.offerCooldown = UPGRADE_OFFER_COOLDOWN;
  }

  /**
   * 统一回收本帧的死者。**必须倒序**:pool 的 despawnAt 是 swap-remove,
   * 正序遍历时被顶上来的那只会跳过当前下标而漏检(pool.ts 注释已给口径);
   * 倒序则被顶上来的对象一定落在已经走过的区间,不会漏也不会重。
   * 残骸与挂钩都在**对象回池之前**当场读完 x/y/kind:回池后同一个对象会被复用成另一只敌人。
   */
  private reap(): void {
    for (let i = this.enemies.size - 1; i >= 0; i--) {
      const e = this.enemies.items[i]!;
      if (!e.dead) continue;
      this.kills++;
      // 精英击杀计数(19 号):与 spawnDrop 同一条"affixes ≠ 0 即精英"的判定,
      // Boss 绝不用 affixes 位故不计入;与 kills 同一条回收帧记账、不进 checksum
      if (e.affixes !== 0) {
        this.eliteKills++;
      }
      // 死亡爆点(畅玩性调整):坐标/半径在回池前当场读走(与 spawnDrop 同口径)。
      // 借 sink.fx 走 FxEvent 的唯一生命周期路径;towerType 一格借放敌型下标,
      // 渲染层照它取 enemyTint 配色(见 sim/fx.ts 的 FXV_KILL)。纯表现、零 rng、不进 checksum。
      // Boss 的爆点半径走 bossRadius()(它不进 ENEMIES 表,enemyTint 对越界 kind 有兜底)
      // damage 带致死那一发的实际伤害(Enemy.lastHit,reap 前刚由 damageEnemy 写过)、
      // dmgRatio = 致死伤害 / 满血 —— 飘字与配色在回池前当场取走
      this.sink.fx(
        FXV_KILL,
        e.x,
        e.y,
        e.x,
        e.y,
        e.kind === KIND_BOSS ? bossRadius() : enemyRadius(e),
        e.kind,
        e.lastHit,
        e.maxHp > 0 ? e.lastHit / e.maxHp : 0,
      );
      // 掉落排在公开挂钩**之前**:先把世界自己的账落地(经验是这一局的成长资源,不是一段表现),
      // 再把这具尸体递给外面 —— 于是挂钩接不接、接的人在回调里做了什么,都影响不到掉落。
      // onEnemyDeath 的既有语义一个字没变:仍是回池前、每只恰好一次(见它的字段注释)
      this.spawnDrop(e);
      this.onEnemyDeath?.(e);
      // Boss 击杀(15 号):记时刻、翻阶段 —— 掉落与挂钩已经走完,这里只落世界自己的账;
      // 胜利结论由帧尾 settleOutcome 读 bossPhase 落定(与 kills 同一条"回收那一帧记账"的口径)
      if (e.kind === KIND_BOSS) {
        this.bossPhase = 2;
        this.bossKilledAt = this.elapsed;
      }
      // 裂变(14 号):死亡当场分裂成 splitCount 只 —— **复用敌人池**、不带词缀、普通血量,
      // 一次 rng 都不掷(side 继承父体,见 initSplit):精英结算扰动不到出怪随机序列。
      // 排在掉落/挂钩之后(分裂体是"新出生的敌人",与父体的账互不相干);
      // 又排在 despawnAt **之前**:spawn() 会先对取出的对象跑一遍 reset(逐字段清零),
      // 而池后进先出,第一只分裂体拿到的正是父体这个对象 —— 先回池再 initSplit,
      // initSplit 读到的 parent.x/kind/side 就全是清零后的脏值了。
      // spawn 只往数组尾 push,倒序回收的 reap 不会回头碰到它们
      const split = e.affixes !== 0 && hasAffix(e, AFFIX_FISSION)
        ? AFFIXES[AFFIX_FISSION]!.splitCount
        : 0;
      for (let j = 0; j < split && this.enemies.size < WAVE_MAX_ALIVE; j++) {
        initSplit(this.enemies.spawn(), e, this.elapsed);
      }
      this.enemies.despawnAt(i);
    }
  }

  /**
   * 一只死者的死亡结算 —— **击杀落账的唯一落点**(与 spawnFromWave 同一条分工:
   * 规则在别处,这里只补世界这一层才知道的三件事:掉在哪、值多少、在场上限)。
   * 只在 reap 里、对象回池之前调用:坐标必须当场读走。
   *
   * 改版后它同时管两本账:
   *   **星币**(用户设计会:改成**概率掉落**):每次击杀**恒掷 1 次 rng**,命中
   *     buffs.starCoinChance(基础 3%,星图协议每层 +2 个点 —— 二轮审查重锚,见
   *     data/economy 的 STARCOIN_DROP_CHANCE)才进账,面额一个字不改 ——
   *     普通怪按型(ENEMIES[kind].starCoins,1-4)、精英 ELITE.starCoins(10)、
   *     Boss BOSS.starCoins(30)。**不造掉落物**:星币没有"掉在地上捡不到"的问题,
   *     也不占 DROP_MAX_ALIVE、不走磁吸;
   *   **经验**(改版 10 号):每只死者在原地掉一颗 XP 掉落物,面额 = 该敌型 scrap 面值,
   *     精英 ×3 / Boss ×12(读数据表,见下)—— 掉落物承载经验,磁吸拾取才有"捡得到才升级"的取舍。
   *
   * **rng 消耗口径(定死)**:星币那一掷**无条件发生**,与命中与否、有没有星图协议、
   * 是不是 Boss 全无关 —— 与 sim/upgrade.ts 那条"每个候选位恒 2 次"一字同源。
   * 少了这条,拿一层星图协议就会把整条随机序列往前挪,同 seed 的出怪序列当场作废。
   * 经验那条路仍是零 rng(每只必掉、面额按型定死)。
   *
   * 经验掉落物:速度不填,池里取出来的那颗刚走过 resetDrop,vx/vy = 0 就是"停在尸体上等人来捡";
   * 面额 ≤ 0 的型**不掉**(数值表允许 0,见 enemies.test.ts 的表级不变量):
   * 一颗看得见却给不了任何东西的经验只会骗玩家专程绕一趟,还白占着下面那道保险丝的名额;
    * 触到在场上限就**丢弃这一颗、不留账**(与 spawnFromWave 那句一字同源):
    * DROP_MAX_ALIVE 是保险丝不是旋钮,理由全文见 data/economy.ts。
    * (星币那条路没有保险丝:它直接进账,根本不经过掉落物池。)
    *
    * 磁吸宝物(26 号改):**精英(affixes ≠ 0)必掉一颗**,与经验掉落物同池、同位置、
    * 同磁吸/收取规则,只有收下时的账不同(stepDrops 报数 → step 置 magnetSurgeTime)。
    * 独立一颗而不是塞进经验掉落物:经验那颗随时可能因面额 ≤ 0 或保险丝被弃,
    * 宝物的"精英必掉"承诺不能挂在它的命上。零 rng(与经验那条路同口径,必掉、位置定死);
    * Boss 无词缀位、分裂体不带词缀,天然不掉 —— 宝物是精英的专属犒赏。
    */
  private spawnDrop(e: Enemy): void {
    const isBoss = e.kind === KIND_BOSS;
    // 星币:**先掷、后判**(掷在最前面且无条件 —— 见上面那段 rng 消耗口径)。
    // 精英判定与 eliteKills 同一条(affixes ≠ 0),Boss 走专用 kind
    const coinRoll = this.rng.next();
    if (coinRoll < this.buffs.starCoinChance) {
      if (isBoss) this.starCoins += BOSS.starCoins;
      else if (e.affixes !== 0) this.starCoins += ELITE.starCoins;
      else this.starCoins += ENEMIES[e.kind]!.starCoins;
    }

    // 经验掉落物:面额 = 该敌型的 scrap 面值 × 档位倍率 ——
    // 精英 ×3 读 ELITE.scrapMul(旧"3× 残骸"占位字段,16 号后 sim 不再读它,这里重新启用);
    // Boss 读 BOSS.dropMul(平衡系统解耦:旧口径挂在 hpMul 上,hpMul 被闸门抬到 52 后
    // 掉落会跟着变 600 残骸 —— 掉落是经济账、血量是战斗账,两笔账不共用一个旋钮)
    const base = isBoss ? ENEMIES[BOSS.baseKind]!.scrap : ENEMIES[e.kind]!.scrap;
    const value = isBoss ? base * BOSS.dropMul : e.affixes !== 0 ? base * ELITE.scrapMul : base;
    if (value > 0 && this.drops.size < DROP_MAX_ALIVE) {
      const d = this.drops.spawn();
      d.x = d.px = e.x;
      d.y = d.py = e.y;
      d.value = value;
    }

    // 磁吸宝物:精英必掉。与经验那颗同池同位置(重叠出生:一颗普通菱形 + 一颗金色宝物,
    // 拾起时一起被吸走);value 恒 0 —— 它进账的是涌而不是经验(kind 分流,见 drop.ts)。
    // **不经过 DROP_MAX_ALIVE 保险丝**(二轮审查):精英整局只有脚本定死的 ~8 只,宝物是
    // 这个量级的稀罕物,而保险丝是为"每只怪必掉一颗"的洪峰设的 —— 被它拦住的话,
    // "精英必掉一颗"的承诺会在残骸触顶时静默作废,且宝物 value 恒 0、折半兜底也救不了它。
    if (e.affixes !== 0) {
      const o = this.drops.spawn();
      o.x = o.px = e.x;
      o.y = o.py = e.y;
      o.kind = DROP_KIND_MAGNET;
    }
  }

  /**
   * 本帧的船体受击结算 —— 受击圆判定与扣血**全仓只有这一处**。
   * 只走 contacts 那份粗筛名单:精筛与粗筛是**同一份几何**(船体受击圆 + 体型),
   * 故这份名单已经是"真碰上"的超集,这里只补冷却与扣血两件事。
   *
   * 撞完**不击退、不消灭敌人、不改它的状态机**:VS 式的贴脸就是"它压在那儿继续磨",
   * 弹开会把蜂群贴脸变成一件物理玩具,而 GDD §4.6 要的是一条稳定可读的掉血曲线。
   * 伤害与火花**共用同一个冷却**(e.hitCd):于是每只敌人每 enemyHitInterval 最多结算一次,
   * 蜂群贴脸也不会让结算次数失控;掉血速率则由 enemyHitInterval × contactDamage × 全局倍率
   * 三根旋钮定死(验收标准第一条"一次接触只结算一次、蜂群贴脸掉血速率可控可调"说的就是这件事)。
   */
  private settleHullDamage(): void {
    // 船沉了就一切停手。伤害那一半本来就被 damageShip 的首句挡着,漏的是**表现**这一半:
    // 不挡的话尸体上还会一路冒撞击圆环,而结算界面背后那张静止的战场看着仍在挨打。
    // 顺带也省了尸体上那一圈没有任何后果的判定(蜂群贴脸时是几十次圆判定)
    if (this.shipDead) return;
    const ship = this.ship;
    const scale = tuning.enemyContactDamageScale;
    // 受击圆半径 = 船体半长(全仓唯一口径,damage.shipRadius)
    const hullR = shipRadius(tuning.shipLength);
    for (let i = 0; i < this.contacts.length; i++) {
      const e = this.contacts[i]!;
      // 本帧刚被塔打死的敌人不许再咬一口 —— 这一句之所以有意义,全靠结算排在子弹之后
      if (e.dead) continue;
      // 冷却没走完的连判定都不做(免得"没伤害的擦碰"每帧刷一次,把结算当烟花放)
      if (e.hitCd > 0) continue;
      const isBoss = e.kind === KIND_BOSS;
      // 体型与伤害口径:Boss 走 sim/boss.ts 的 bossRadius / bossContactDamage
      //(大质量撞击伤害更高 = 数值换倍率,判定几何仍是改版 09 号那一套,不新开机制);
      // 普通怪照旧走 enemyRadius(精英 ×ELITE.scale)与 ENEMIES 表的 contactDamage
      const r = isBoss ? bossRadius() : enemyRadius(e);
      const dx = e.x - ship.x;
      const dy = e.y - ship.y;
      const hitR = hullR + r;
      // 粗筛名单是超集,没真碰上的直接放过(圆 + 体型,含边界)
      if (dx * dx + dy * dy > hitR * hitR) continue;
      e.hitCd = tuning.enemyHitInterval;

      const raw = (isBoss ? bossContactDamage() : ENEMIES[e.kind]!.contactDamage) * scale;
      // 飘字带**实际结算**的伤害 —— 与 damageShip 里同一份乘式(shipDamageTakenMul:
      // 支援减伤 × 加速窗减伤,同一份聚合与同一个 boostTime,确定性不变),
      // 于是红字与血条扣掉的量永远一致,玩家不会读到两本账
      this.pushHitFx(FXV_HULL_HIT, e.x, e.y, raw * this.shipDamageTakenMul(), 0);
      this.damageShip(raw);
    }
  }

  /**
   * 挨打的可视化事件入池。借 sink.fx 而不是在这里再写一遍取池/填字段/取 life ——
   * FxEvent 的生命周期全仓只该有一条路径(fxLife 的口径也才不会分裂)。
   * 起点终点同点、半径 0:这两种表现都画在**接触点**上(见 renderer 的 FXV_SPARK / FXV_HULL_HIT);
   * towerType 填 0 只是占位 —— 挨打不是任何一座塔打出来的,渲染层对这两种 kind 也不读它。
   * @param damage 实际结算的伤害量(仅 FXV_HULL_HIT 填,红字飘字用;火花 = 0 不飘字)
   * @param dmgRatio 伤害 / 满血,飘字配色用(船体飘字恒红,这里恒 0)
   */
  private pushHitFx(kind: number, x: number, y: number, damage = 0, dmgRatio = 0): void {
    this.sink.fx(kind, x, y, x, y, 0, 0, damage, dmgRatio);
  }

  /**
   * 船体受伤的**唯一入口**:碰撞结算(settleHullDamage)与敌方弹幕命中(sink.hullHit)都走它。
   *
   * @param amount 伤害量(调用方已乘过全局倍率)。≤ 0 一律不算数:
   *   否则"零伤害的接触"也会被算作一次受击,反馈就成了噪音
   * @returns 本次是否真的扣到血(船已沉 / amount ≤ 0 → false)
   *
   * 实际结算量 = amount × 支援聚合的 damageTakenMul(改版 06 号装甲舱 ×0.8)——
   * 减伤的唯一去处就是这一句(与飘字那一边同源,见 settleHullDamage)。
   * 旧版的四舷惩罚(edgePenalty / 受击闪红)随甲板删除:受击不再有方向性反馈。
   */
  /**
   * 船体受伤的总倍率 = 支援减伤(装甲舱 ×0.8)× 加速窗减伤(boostDamageTakenMul,
   * 仅 boostTime > 0 的那几帧)。**飘字与扣血的唯一共同乘式**:settleHullDamage /
   * sink.hullHit 的红字与 damageShip 的血条读的都是它,两本账永远一致。
   * 倍率夹 0(面板拖成负数不该把受伤变成回血),与 stepShip 那批倍率同一道保护。
   */
  shipDamageTakenMul(): number {
    const boostMul = this.boostTime > 0 ? Math.max(0, tuning.boostDamageTakenMul) : 1;
    return hullDamageTaken(this.buffs) * boostMul;
  }

  damageShip(amount: number): boolean {
    // 已沉就一切停手:这一句同时保证了 onShipDestroyed 只可能响一次(与 applyDamage 的
    // "同帧重复致命只算一次"同一条口径),08 号的失败流程不必自己去重
    if (this.shipDead || amount <= 0) return false;

    const dealt = amount * this.shipDamageTakenMul();
    this.ship.hp = Math.max(0, this.ship.hp - dealt);

    if (this.ship.hp <= 0) {
      this.shipDead = true;
      // 只把"船沉了"这件事递出去。失败**结论**由帧尾的 settleOutcome 出(result + onGameOver),
      // 不在这里抢着判:受击结算发生在帧中,那时本帧的死者还没回收进 kills ——
      // 抢着判的话结算界面上的击杀数会比玩家亲眼看到的少一只
      this.onShipDestroyed?.();
    }
    return true;
  }

  /**
   * 05 号 issue 的唯一伤害入口(塔/子弹都走这里)。
   * 只标记不回收:真正的出池与掉落在 step 末尾统一做,于是调用方不必知道对象在池里的下标,
   * 也不会在别人遍历到一半时把数组搅乱。
   * @param throttle 开火塔的节流系(THR_*)。词缀抗性(14 号)在**这一处**按它判定:
   *   装甲抗弹药系、相位抗能量系,倍率读 data/affixes.ts(ballisticMul/energyMul)。
   *   不带 = 既有调用方语义,一律不抗(普通怪本来就是恒 1,无词缀时此参数完全无效)
   * @returns 本次是否致死(同帧重复致命只算一次,见 applyDamage)
   */
  damageEnemy(e: Enemy, amount: number, throttle?: number, towerType?: number): boolean {
    // 抗性判定挂在伤害结算的唯一入口,与塔的节流(throttle)字段对齐 —— 不另造伤害类型体系
    // (todos/14 口径:装甲 = 弹药系、相位 = 过热/充能系)。乘出来的仍是"这一发实际造成的伤害"
    if (throttle !== undefined && e.affixes !== 0) {
      if (throttle === THR_AMMO && hasAffix(e, AFFIX_ARMORED)) {
        amount *= AFFIXES[AFFIX_ARMORED]!.ballisticMul;
      } else if ((throttle === THR_HEAT || throttle === THR_CHARGE) && hasAffix(e, AFFIX_PHASED)) {
        amount *= AFFIXES[AFFIX_PHASED]!.energyMul;
      }
    }
    // 逐武器 DPS 归账(HUD 统计面板)与本局累计总账(局末战报):按**实际结算量**
    // (抗性已折算)进账,与飘字同一份真相。型越界(表写坏/测试桩乱传)只是不归账,
    // 不炸整局 —— 归账是纯读数,照 threatRate 口径
    if (towerType !== undefined && towerType >= 0 && towerType < TOWER_KIND_COUNT) {
      this.dpsByType[towerType]! += amount * DPS_SMOOTH_IMPULSE;
      this.runDamageByType[towerType]! += amount;
    }
    // 实际结算量写给敌对象:命中飘字(FXV_IMPACT)与死亡飘字(FXV_KILL)都认它 ——
    // 不带抗性时 amount 就是调用方给的原值,语义一字不变(见 Enemy.lastHit 的字段注释)
    e.lastHit = amount;
    return applyDamage(e, amount);
  }

  /**
   * 塔型 type 最近的实际 DPS(一阶平滑,窗口 DPS_SMOOTH_TAU)。HUD 统计面板的唯一读口;
   * 型越界返回 0(HUD 逐槽读,空槽 type = -1 走这条兜底)。
   */
  dpsOf(type: number): number {
    return type >= 0 && type < TOWER_KIND_COUNT ? this.dpsByType[type]! : 0;
  }

  /**
   * 齐射共振(24 号):以 center 为中心的三元组(center-1 / center / center+1,mod 8 环回)
   * 三槽是否都成立 —— **空槽即断**(type < 0 不是舷:空槽插在三塔中间就绝不许共振),
   * 且三槽的最近开火都落在 windowStart 之后的窗内(-1 哨兵 = 从未开火,天然不落窗)。
   * 纯统计零 rng,只喂 fired 的判定,不进 checksum(见 RESONANCE_WINDOW 那段)。
   */
  private resonanceTripletReady(center: number, windowStart: number): boolean {
    for (let d = -1; d <= 1; d++) {
      const s = (center + d + WEAPON_SLOT_COUNT) % WEAPON_SLOT_COUNT;
      if (this.weapons[s]!.type < 0) return false;
      const t = this.lastFiredTick[s]!;
      if (t < 0 || t < windowStart) return false;
    }
    return true;
  }

  /**
   * 结算一张候选卡。候选 → 取用的翻译只走 sim/upgrade 那三个函数,
   * 真正获得仍走 this.acquireWeapon 这唯一入口;只有成功码才扣费并清空候选。
   * 被拒时残骸、升级次数与 offer 一个字段都不动,玩家可以换卡或退回重选。
   *
   * @param choice 候选下标(offer 数组内的编号)
   * @param slotIndex 武器槽已满时的替换位(缺省 -1 = 不替换):OFFER_NEW_WEAPON 遇到
   *   ACQUIRE_REPLACE_NEEDED 且给定了合法槽位时,当场走 replaceWeapon 完成这一张卡 ——
   *   UI 的流程是"点卡 → 弹替换选择 → 再点同一张卡(slotIndex 带上)"。
   *   槽满但同型已有两把 1★ 时 acquireWeapon 直接吸收合成(见 absorbIncoming),
   *   一次点击成功、不经过替换层。
   * @returns 成功 = 0(ACQUIRE_OK / REPLACE_OK / EDICT_OK 共用);负数 = 理由码
   *   (UPGRADE_NO_OFFER / ACQUIRE_REPLACE_NEEDED / EDICT_MAXED / 各 INVALID_*)。
   */
  takeUpgrade(choice: number, slotIndex: number = -1): number {
    const opt = this.offer[choice];
    if (!opt) return UPGRADE_NO_OFFER;
    let code = 0;
    if (opt.kind === OFFER_EDICT) {
      // 法令:不占槽 —— 层数 +1,与 buyDockEdict 同一条授予路径(grantEdict 是唯一入口)
      code = this.grantEdict(opt.type);
    } else if (opt.kind === OFFER_NEW_WEAPON) {
      code = this.acquireWeapon(opt.type);
      // 槽满:玩家选好替换槽后带着 slotIndex 再点一次,当场换下旧的
      if (code === ACQUIRE_REPLACE_NEEDED && slotIndex >= 0) {
        code = this.replaceWeapon(slotIndex, opt.type);
      }
    }
    if (code >= 0) this.completeUpgrade(0);
    return code;
  }

  /**
   * 获得一把武器(星级版):每一次获得都落一个空槽、1★ 起步(同型也是一把新武器 ——
   * 三合一升星合成在落位后当场检查:同型同星凑满 3 把合一,见 fuseTriplesOf)。
   * 槽满时同型已有两把 1★ 会走吸收合成(不占槽、不需要替换,见 absorbIncoming)。
   * @param type TOWER_*(合成结果塔也可经此直接获得 —— 卡池/商店已把 isMergeResult 挡在外面,
   *   这里只做表级兜底,不重复裁决)
   * @returns ACQUIRE_OK(0)= 已入槽 1★ 或已吸收合成(可能已当场三合一升星/变身);
   *   ACQUIRE_REPLACE_NEEDED = 槽满且不满足吸收条件,调用方先选替换槽再走 replaceWeapon;
   *   ACQUIRE_INVALID_TYPE = 型越界。
   * 零 rng:获得与合成都不掷随机,同 seed 同操作序列逐位可复现。
   */
  acquireWeapon(type: number): number {
    return this.mergeOrInstall(type, -1);
  }

  /**
   * 用新武器换下 slotIndex 槽的旧武器(槽满时的替换通道,UI 的"换槽"流程)。
   * 替换也算一次获得:旧武器清空、新武器落位 1★(三合一升星合成照常在落位后检查 ——
   * 新落位的这把可能凑满同型同星三把,当场合一)。
   * @returns REPLACE_OK(0)= 已替换(可能已触发合成);REPLACE_BAD_SLOT = 下标越界或目标槽是空槽
   *   (空槽不需要替换,走 acquireWeapon);REPLACE_INVALID_TYPE = 型越界。
   * 零 rng。
   */
  replaceWeapon(slotIndex: number, type: number): number {
    if (TOWERS[type] === undefined) return REPLACE_INVALID_TYPE;
    const slot = this.weapons[slotIndex];
    if (!slot || slot.type < 0) return REPLACE_BAD_SLOT;
    // 旧武器清空(checksum 才不会带着旧武器的残值),再按获得规则落位
    this.clearSlot(slotIndex);
    return this.mergeOrInstall(type, slotIndex) >= 0 ? REPLACE_OK : REPLACE_INVALID_TYPE;
  }

  /**
   * 授予一层法令(用户设计会)—— **法令的唯一入口**(升级三选一与船坞货架都走它)。
   * 法令不占槽、可重复持有,每条最多 EDICT_MAX_LEVEL 层;层数 +1 即"叠一层"。
   * @returns EDICT_OK(0)= 层数 +1;EDICT_MAXED = 这条已满层;EDICT_INVALID_TYPE = 型越界。
   * 零 rng;聚合由帧首的 aggregateEdictBuffs 自动跟上,这里不用重刷任何缓存 ——
   * 唯一要当场同步的是 HP 上限(装甲协议那一层的 +15 必须在**这一帧**就能看见,
   * 而帧首的刷新已经过去了;晚一帧的话玩家点下卡片时血条不动,那正是最该有反馈的一瞬)。
   */
  grantEdict(type: number): number {
    if (EDICTS[type] === undefined) return EDICT_INVALID_TYPE;
    if (!edictCanStack(this.edictLevels, type)) return EDICT_MAXED;
    this.edictLevels[type] = edictLevel(this.edictLevels, type) + 1;
    aggregateEdictBuffs(this.edictLevels, this.buffs);
    this.ship.maxHp = hullMaxHp(this.buffs);
    return EDICT_OK;
  }

  /**
   * 交换两个武器槽的内容(按 I 打开的武器面板,ui/armoryPanel.ts)。
   * 八个槽围成一圈、每槽朝向固定(sim/armory 的 WEAPON_SLOT_FACING),于是"把哪门炮摆到船头"
   * 是玩家唯一能主动调的火控决策 —— 换位本身零成本、零 rng、不消耗任何资源,
   * 它调的是**布局**而不是强度(强度的出口是升级与合成)。
   * 空槽也允许参与:把一门炮换到空槽 = 把它挪个朝向,那正是面板最常见的用法。
   * @returns 0 = 已交换;SWAP_BAD_SLOT = 下标越界或两个下标相同(换了等于没换)。
   */
  swapWeapons(a: number, b: number): number {
    const sa = this.weapons[a];
    const sb = this.weapons[b];
    if (!sa || !sb || a === b) return SWAP_BAD_SLOT;
    swapWeaponSlots(sa, sb);
    return 0;
  }

  /**
   * 合成配方查询(星级版 §5.5):这一型合到 3★ 会不会变身、变成什么。
   * 转发 data/merges.ts(世界侧不做第二份判定),UI/渲染层读同一份。
   */
  mergeResultOf(type: number): number {
    return dataMergeResultOf(type);
  }

  /**
   * 把一把新武器装进槽位 —— 槽位与节流状态的**唯一写入点**。
   * 起手状态与随机开局(loadout.ts)的 installWeapon 同一条口径:满弹进场(非弹药系的塔这里恒 0)、
   * 零热量/零冷却/零充能、炮管归位(射界中心)。**不触发升星**(升星在调用方跑,见 mergeOrInstall)。
   * 节流状态全清 = 新武器从"冷静、满装、归位"起步,而不是继承旧武器的残热/残弹
   * (replaceWeapon 换下旧武器时,新武器的第一发不受旧武器状态影响)。
   */
  private installWeapon(slotIndex: number, type: number, stars: number): void {
    const slot = this.weapons[slotIndex]!;
    const def = TOWERS[type]!;
    slot.type = type;
    slot.stars = stars;
    slot.cooldown = 0;
    slot.ammo = towerMagazine(def, stars);
    slot.reloadLeft = 0;
    slot.heat = 0;
    slot.coolLock = 0;
    slot.charge = 0;
    slot.turretOffset = 0;
  }

  /**
   * 获得一把武器(星级系统的唯一裁决处,acquireWeapon / replaceWeapon / buyShopWeapon 都走它):
   * 每一次获得都落一个槽(1★ 起步,同型也不例外 —— 再没有"吸收进旧武器"这条路),
   * 落位后跑三合一检查(fuseTriplesOf)。
   * 槽满时有一条例外:**同型已有两把 1★** 时,正要获得的这把直接参与三合一(吸收合成,
   * 见 absorbIncoming)—— 3 把合 1 把、新枪不占槽,合成完必然腾出空位,不需要替换。
   * @returns ACQUIRE_OK(0)= 已入槽 1★ 或已吸收合成(可能已当场三合一升星/变身);
   *   ACQUIRE_REPLACE_NEEDED = 槽满且不满足吸收条件,调用方先让玩家选替换槽再走 replaceWeapon;
   *   ACQUIRE_INVALID_TYPE = 型越界。
   * 零 rng。
   */
  private mergeOrInstall(type: number, preferredSlot: number): number {
    if (TOWERS[type] === undefined) return ACQUIRE_INVALID_TYPE;
    // 落位:preferredSlot(调用方已把它清成空槽)或第一个空槽
    let slot = preferredSlot >= 0 ? preferredSlot : -1;
    if (slot < 0 || this.weapons[slot] === undefined || this.weapons[slot]!.type >= 0) {
      slot = -1;
      for (let i = 0; i < WEAPON_SLOT_COUNT; i++) {
        if (this.weapons[i]!.type < 0) {
          slot = i;
          break;
        }
      }
    }
    if (slot < 0) {
      // 槽满:同型已有两把 1★ → 吸收合成(第三把不占槽);否则才轮到换槽
      if (slotStarCount(this.weapons, type, 1) >= 2) {
        this.absorbIncoming(type);
        return ACQUIRE_OK;
      }
      return ACQUIRE_REPLACE_NEEDED;
    }
    this.installWeapon(slot, type, 1);
    this.fuseTriplesOf(type);
    return ACQUIRE_OK;
  }

  /** 升星仪式锚在幸存武器硬点，而不是船心；事件仍使用世界坐标，不要求渲染层回查槽位。 */
  private emitStarUpgrade(slotIndex: number, towerType: number, stars: number): void {
    const hp = WEAPON_HARDPOINTS[slotIndex];
    if (!hp) return;
    const cos = Math.cos(this.ship.heading);
    const sin = Math.sin(this.ship.heading);
    const x = this.ship.x + hp.x * cos - hp.y * sin;
    const y = this.ship.y + hp.x * sin + hp.y * cos;
    this.sink.fx(FXV_STAR_UPGRADE, x, y, x, y, 0, towerType, 0, 0, stars);
  }

  /**
   * 三合一升星合成(用户设计会):**同型同星的槽凑满 3 把 → 当场合为 1 把同型星 +1**。
   *   3× 1★ → 1× 2★;3× 2★ → 1× 3★(2★ 合成 3★ 时若这一型有配方,当场换装成配方结果塔,
   *   节流状态全清重装 —— 变身是"换一门新炮",不是免费装填);
   * 幸存槽 = 三把里下标最小的那把(最早入手,平级取最早槽的同一口径),其余两把清成空槽。
   * 只沿被获得的那一型向上查(其他型的槽数没动):1★ 合一后**连锁**再看 2★ 三把齐没齐 ——
   * 满 3★ 到顶,链止步(上限是两次合一,零 rng、零分配)。
   */
  private fuseTriplesOf(type: number): void {
    this.fuseTriplesFrom(type, 1);
  }

  /**
   * 吸收合成(槽满时的三合一,改版 24 号优化):正要获得的这把 1★ **不落槽**,
   * 直接当第三把与槽里已有的两把同型 1★ 合一。槽静止态同型同星最多两把
   * (第三把早在获得那一刻就合掉了),故调用前提 = 1★ 恰两把;
   * 幸存槽 = 下标最小那把(与 fuseTriplesOf 同一口径),其余清空;
   * 吸出的 2★ 可能凑满已有的两把 2★,照同一条链从 2★ 起继续查。
   * 合成后必然腾出 ≥1 个空槽(3 把合 1 把、新枪没占槽),所以这是槽满时
   * 唯一一条不用换槽的购买/获得通道。零 rng。
   */
  private absorbIncoming(type: number): void {
    const members: number[] = [];
    for (let i = 0; i < WEAPON_SLOT_COUNT; i++) {
      const s = this.weapons[i]!;
      if (s.type === type && s.stars === 1) members.push(i);
    }
    const keep = members[0]!;
    for (let m = 1; m < members.length; m++) this.clearSlot(members[m]!);
    this.weapons[keep]!.stars = 2; // 升星不清节流状态(同 fuseTriplesOf 的 1★→2★ 口径)
    this.emitStarUpgrade(keep, type, 2);
    this.fuseTriplesFrom(type, 2);
  }

  /**
   * 从 startStar 起沿三合一链向上查(type 别的星的槽数没动)。吸收合成从 2★ 接链 ——
   * 它吸出的那一把 2★ 可能凑满槽里已有的两把 2★,其余口径与 fuseTriplesOf 逐字相同:
   * 同型同星的槽凑满 3 把 → 当场合为 1 把同型星 +1;幸存槽 = 三把里下标最小的那把
   * (最早入手,平级取最早槽的同一口径),其余两把清成空槽;满 3★ 到顶,链止步。
   */
  private fuseTriplesFrom(type: number, startStar: number): void {
    for (let star = startStar; star < STAR_MAX; star++) {
      const members: number[] = [];
      for (let i = 0; i < WEAPON_SLOT_COUNT && members.length < 3; i++) {
        const s = this.weapons[i]!;
        if (s.type === type && s.stars === star) members.push(i);
      }
      if (members.length < 3) return;
      const keep = members[0]!;
      for (let m = 1; m < members.length; m++) this.clearSlot(members[m]!);
      const next = star + 1;
      if (next === STAR_MAX) {
        // 3★ 有配方 → 变身;无配方(导弹巢/合成武器)→ 3★ 到顶
        const result = dataMergeResultOf(type);
        if (result >= 0) {
          this.installWeapon(keep, result, STAR_MAX);
          this.emitStarUpgrade(keep, result, STAR_MAX);
        } else {
          this.weapons[keep]!.stars = STAR_MAX;
          this.emitStarUpgrade(keep, type, STAR_MAX);
        }
      } else {
        this.weapons[keep]!.stars = next; // 升星不清节流状态:这不是免费装填
        this.emitStarUpgrade(keep, type, next);
      }
    }
  }

  /** 清空一个武器槽(替换与三合一的共同收尾):checksum 不许带着旧武器的残值 */
  private clearSlot(slotIndex: number): void {
    const slot = this.weapons[slotIndex]!;
    slot.type = -1;
    slot.stars = 0;
    slot.cooldown = 0;
    slot.ammo = 0;
    slot.reloadLeft = 0;
    slot.heat = 0;
    slot.coolLock = 0;
    slot.charge = 0;
    slot.turretOffset = 0;
  }

  /** 完成本轮整备并放行下一航段；余额保留，但至少 5 秒内不连续弹普通升级。 */
  completeRefit(): boolean {
    if (!this.refitPending) return false;
    this.refitPending = false;
    // 两张货架与特价随整备结束清空:下一轮跨段时 rollDockEdicts / rollShopWeapons / rollShopDiscount 重掷
    //(与 offer 结算清空的同一条生命周期)
    this.dockEdictOffers.length = 0;
    this.shopWeapons.length = 0;
    this.shopDiscountIndex = -1;
    // 免费回血**不在这里** —— 它挂在"接上信标"那一刻(见 step 里的接触分支):
    // 关面板才回血的话,玩家在店里没法判断那 25 星币的付费修复还要不要买。
    this.offerCooldown = Math.max(this.offerCooldown, UPGRADE_OFFER_COOLDOWN);
    return true;
  }

  /**
   * 掷定本轮**商店信标**的落点(用户设计会)。只在 step 里跨段那一帧调用,排在两张货架之前 ——
   * 三者的顺序定死(信标 → 法令货架 → 武器货架),同 seed 逐位可复现。
   *
   * rng 消耗口径(定死):**恰好 2 次**(方位角 + 距离),与"这一轮玩家去没去"无关。
   * 极坐标而不是矩形抖动:方位均匀 = 信标不会偏爱某个象限;距离夹在
   * [SHOP_BEACON_MIN_DIST, SHOP_BEACON_MAX_DIST] 之间 —— 下界保证它不会贴脸白送,
   * 上界保证 30 秒的存活时间里跑得到(理由与数值见 data/economy.ts)。
   * 以**船当前位置**为心而不是世界原点:地图无限,离原点的绝对坐标没有意义,
   * "离我多远"才是玩家判断"这趟跑不跑得赢"的唯一读数。
   */
  private spawnShopBeacon(): void {
    const ang = this.rng.next() * Math.PI * 2;
    const dist = SHOP_BEACON_MIN_DIST + this.rng.next() * (SHOP_BEACON_MAX_DIST - SHOP_BEACON_MIN_DIST);
    this.shopBeaconX = this.ship.x + Math.cos(ang) * dist;
    this.shopBeaconY = this.ship.y + Math.sin(ang) * dist;
    this.shopBeaconTtl = SHOP_BEACON_LIFETIME;
    this.shopBeaconActive = true;
    this.shopBeaconSegment = this.wave.segment;
  }

  /**
   * 掷定本轮整备的船坞法令货架(21 号)。**只在 step 里 refitPending 置位那一帧调用**:
   * 与出怪同一条"帧首、定死顺序"的确定性 —— 同 seed 同操作序列,货架逐位可复现。
   *
   * rng 消耗口径(定死,与 upgrade.ts 文件头同一条):**每个货架位恰好消耗 1 次 rng**,
   * 即使这一位最终空着(可选池没有货)也照样消耗 —— 消耗次数与持有状态、解锁状态、
   * 池大小全无关,于是"玩家又抽到一张法令"这种事移动不了整条随机序列。
   * 可选池 = 未持有(法令不叠级,货架不摆买了也白买的重复卡)+ 已解锁(19 号闸门,
   * 照 upgrade.ts 的 collectPool 过滤)+ 本轮尚未上架(两张一样的卡等于少一个选项)。
   */
  private rollDockEdicts(): void {
    const offers = this.dockEdictOffers;
    offers.length = 0;
    const pool = this.dockPool;
    for (let slot = 0; slot < DOCK_EDICT_COUNT; slot++) {
      pool.length = 0;
      for (let type = 0; type < EDICT_KIND_COUNT; type++) {
        if (offers.includes(type)) continue; // 本轮已上架:不摆重复卡
        if (!edictCanStack(this.edictLevels, type)) continue; // 已满层:不摆买了也白买的卡
        const unlockBit = DOCK_EDICT_UNLOCK_BIT[type]!;
        if (unlockBit >= 0 && (this.unlockMask & (1 << unlockBit)) === 0) continue; // 未解锁
        pool.push(type);
      }
      // 与 rollUpgradeOffer 同款取型(Math.floor(roll × pool) + 越界夹取);
      // 池空也照样掷这一次(消耗次数与池大小无关,见上面的口径)
      const roll = this.rng.next();
      if (pool.length === 0) continue;
      offers.push(pool[Math.min(pool.length - 1, Math.floor(roll * pool.length))]!);
    }
  }

  /**
   * 船坞商店(改版 21 号):买下第 index 张法令卡。法令是全船被动、**即时生效、无占槽**
   * (与 takeUpgrade 的 OFFER_EDICT 分支同一条授予路径:置位掩码,效果走六个现读点)。
   *
   * 与 rerollOffer 同一条"step() 之外的外部输入"路径:
   *   **一次 rng 都不掷** —— 购买只动账(星币 / 法令掩码 / 货架),随机序列原地不动,
   *   于是"买没买"反过来扰动不到出怪序列(同 seed 同操作序列逐位可复现);
    *   校验顺序定死(整备闸门 → 货架有货 → 星币够),失败原样返回、一个字段都不动。
    * 成功后:扣费(本格是特价位就按 shopDiscountPrice 的特价扣,否则原价)→ 货架当场下架
    * (一卡一售)→ 置位掩码 → 同步船体上限(照旧口径:
    * 结构加固的 +20 是派生量,现算现夹,hp 只夹不涨)。
   *
   * @returns 0 = 成功;负数 = 理由码(REFIT_NOT_ACTIVE / DOCK_EDICT_SOLD / DOCK_NO_STARCOINS)。
   */
  buyDockEdict(index: number): number {
    if (!this.refitPending) return REFIT_NOT_ACTIVE;
    const type = this.dockEdictOffers[index];
    if (type === undefined || type < 0) return DOCK_EDICT_SOLD;
    // 特价:本格恰是 rollShopDiscount 掷中的那格就按 shopDiscountPrice 扣,否则原价
    const price = this.shopDiscountIndex === index ? shopDiscountPrice(DOCK_EDICT_PRICE) : DOCK_EDICT_PRICE;
    if (this.starCoins < price) return DOCK_NO_STARCOINS;
    this.starCoins -= price;
    this.dockEdictOffers[index] = -1; // 一卡一售:当场下架,本轮不再出现
    this.grantEdict(type); // 唯一授予入口(层数 +1 + 当帧同步 HP 上限)
    if (this.ship.hp > this.ship.maxHp) this.ship.hp = this.ship.maxHp;
    return 0;
  }

  /**
   * 船坞商店(改版 21 号):付费修复船体(立即、无放置)。与 buyDockEdict 同一条外部输入口径:
   * **零 rng**、失败一个字段都不动、可重复购买、夹在 maxHp 上不溢出。
   * 满血拒绝(DOCK_HP_FULL)是"可买但没必要"的口径,与 ui 的置灰按钮互为主备
   * (置灰只是读数,真正的裁决始终以返回码为准)。
   * 修复量 = ceil(maxHp × DOCK_REPAIR_FRACTION) —— 与 completeRefit 的免费回血同一条
   * ceil 取整口径(见 data/economy 的 REFIT_HEAL_FRACTION 那段):比例修复不许因为舍入
   * 变成"回了个寂寞"。
   *
   * @returns 0 = 成功;负数 = 理由码(REFIT_NOT_ACTIVE / DOCK_HP_FULL / DOCK_NO_STARCOINS)。
   */
  buyDockRepair(): number {
    if (!this.refitPending) return REFIT_NOT_ACTIVE;
    if (this.ship.hp >= this.ship.maxHp) return DOCK_HP_FULL;
    if (this.starCoins < DOCK_REPAIR_PRICE) return DOCK_NO_STARCOINS;
    this.starCoins -= DOCK_REPAIR_PRICE;
    this.ship.hp = Math.min(
      this.ship.maxHp,
      this.ship.hp + Math.ceil(this.ship.maxHp * DOCK_REPAIR_FRACTION),
    );
    return 0;
  }

  /**
   * 掷定本轮整备的**商店武器货架**(改版 21 号)。与 rollDockEdicts 同一条"跨段帧首掷定"
   * 的生命周期与同一条 rng 纪律 —— 但有一个差异,定死如下:
   *   **每个货架位恰好消耗 1 次 rng**(与 rollDockEdicts 逐字同款;约束里的确定性口径以本条
   *   为准 —— 商店只有"武器"一个类别,没有类别掷,2 次/位是给升级三选一的"类别 + 下标"
   *   两掷预留的口径,商店用不上第二条腿)。
   * 过滤(与升级卡池同一条"只收窄可选表、不碰 rng"的口径):
   *   **合成结果塔不进**(isMergeResult):合成武器只能靠 3★ 变身,商店能买到就违背了
   *     "变身只在合到 3★ 时触发"的闸门;
   *   **已拥有但未满 3★ 的同型照进**(星级系统):同型卡是三合一升星的原料,买下照常落槽;
   *   **已满 3★ 的同型不进**:到顶了,买来没星可升,是死卡;
   *   **未解锁的型不进**(19 号闸门,照 SHOP_WEAPON_UNLOCK_BIT);
   *   **货架内不去重**(与 rollDockEdicts 不同 —— 那边不摆重复卡,因为法令卡重复 = 废格):
   *   同型两把 = 合法的三合一原料(两把同型 1★ 摆上货架,买下立刻 2★),去重反而砍掉
   *   升星最顺的进货渠道。
   */
  rollShopWeapons(): void {
    const offers = this.shopWeapons;
    offers.length = 0;
    const pool = this.shopPool;
    for (let slot = 0; slot < DOCK_WEAPON_COUNT; slot++) {
      pool.length = 0;
      for (let type = 0; type < TOWER_KIND_COUNT; type++) {
        if (isMergeResult(type)) continue; // 合成结果塔:只从 3★ 变身来(见上面)
        if (slotMaxStars(this.weapons, type) >= STAR_MAX) continue; // 已有满 3★ 同型:死卡
        const unlockBit = SHOP_WEAPON_UNLOCK_BIT[type]!;
        if (unlockBit >= 0 && (this.unlockMask & (1 << unlockBit)) === 0) continue; // 未解锁
        pool.push(type);
      }
      // 与 rollDockEdicts 同款取型;池空也照样掷这一次(消耗次数与池大小无关)
      const roll = this.rng.next();
      if (pool.length === 0) continue;
      offers.push(pool[Math.min(pool.length - 1, Math.floor(roll * pool.length))]!);
    }
  }

  /**
   * 掷定本轮货架的**特价位**(打折机制:每次上架恰选一件商品打 SHOP_DISCOUNT_FRACTION 折)。
   * 跨段那一帧排在 rollShopWeapons 之后调用(顺序定死:信标 → 法令 → 武器 → 特价);
   * refreshShop 重掷武器货架后也调一次(新货架配新特价)。
   *
   * rng 消耗口径(定死,与两张货架同一条):**恰好 1 次**,池空也照样掷 —— 消耗次数与
   * 货架内容、售出状态全无关,于是"又卖掉一件商品"这种事移动不了整条随机序列。
   * 可选池 = 本轮**还没售出**的货架位(法令 0..len-1、武器 DOCK_EDICT_COUNT+下标):
   * 特价落在已售出上是废格,玩家读着"打折"却买不了。武器下标偏置 DOCK_EDICT_COUNT
   * 而不是 dockEdictOffers.length —— 偏置随长度浮动的话,同一格武器在不同局的编号会漂。
   */
  rollShopDiscount(): void {
    const pool = this.discountPool;
    pool.length = 0;
    for (let i = 0; i < this.dockEdictOffers.length; i++) {
      if (this.dockEdictOffers[i]! >= 0) pool.push(i);
    }
    for (let i = 0; i < this.shopWeapons.length; i++) {
      if (this.shopWeapons[i]! >= 0) pool.push(DOCK_EDICT_COUNT + i);
    }
    const roll = this.rng.next();
    this.shopDiscountIndex =
      pool.length === 0 ? -1 : pool[Math.min(pool.length - 1, Math.floor(roll * pool.length))]!;
  }

  /**
   * 船坞商店(改版 21 号):买下第 index 张武器卡。与 buyDockEdict 同一条外部输入口径:
   * **一次 rng 都不掷**(货架是跨段掷定的,买不买不扰动随机序列)、失败一个字段都不动。
   * 获得与 upgrade 卡同一条路(mergeOrInstall):每次购买都落一个空槽、1★ 起步(同型也不例外),
   * 落位后三合一升星合成照常检查;槽满且给了合法替换位(slotIndex)就当场换下旧的;
   * 槽满又没给替换位 → 同型已有两把 1★ 时吸收合成(3 把合 1 把、不占槽),
   * 否则 ACQUIRE_REPLACE_NEEDED(**不扣星币、货架不动**,UI 先让玩家选槽再带着 slotIndex 回来买)。
    * 成功后:扣费(本格是特价位就按 shopDiscountPrice 的特价扣,否则原价)→ 货架当场下架
    * (一卡一售)→ 落位/合成已在 mergeOrInstall 内完成。
   *
   * @returns 0 = 成功(ACQUIRE_OK);负数 = 理由码(REFIT_NOT_ACTIVE / SHOP_WEAPON_SOLD /
   *   SHOP_NO_STARCOINS / ACQUIRE_REPLACE_NEEDED / REPLACE_BAD_SLOT / ACQUIRE_INVALID_TYPE)。
   */
  buyShopWeapon(index: number, slotIndex: number = -1): number {
    if (!this.refitPending) return REFIT_NOT_ACTIVE;
    const type = this.shopWeapons[index];
    if (type === undefined || type < 0) return SHOP_WEAPON_SOLD;
    // 特价:本格恰是 rollShopDiscount 掷中的那格就按 shopDiscountPrice 扣,否则原价
    const price = this.shopDiscountIndex === DOCK_EDICT_COUNT + index ? shopDiscountPrice(DOCK_WEAPON_PRICE) : DOCK_WEAPON_PRICE;
    if (this.starCoins < price) return SHOP_NO_STARCOINS;
    // 优先空槽;槽满时用调用方给的替换位(目标槽必须非空 = 才是"替换");
    // 都没有 = 交给 mergeOrInstall:同型已有两把 1★ 时走吸收合成(3 把合 1 把、不占槽),
    // 否则退回 ACQUIRE_REPLACE_NEEDED(不扣星币、货架不动)
    let slot = -1;
    for (let k = 0; k < WEAPON_SLOT_COUNT; k++) {
      if (this.weapons[k]!.type < 0) {
        slot = k;
        break;
      }
    }
    if (slot < 0 && slotIndex >= 0 && this.weapons[slotIndex] !== undefined && this.weapons[slotIndex]!.type >= 0) {
      slot = slotIndex;
    }
    if (slot < 0) {
      const code = this.mergeOrInstall(type, -1); // 吸收合成或 ACQUIRE_REPLACE_NEEDED
      if (code < 0) return code;
    } else {
      // 替换位(槽满时):照 replaceWeapon 的同一手先把旧武器清空,mergeOrInstall 才会落位
      // (它的契约是"调用方已把 preferredSlot 清成空槽" —— 不清的话它会把占着的槽当作
      // 非法落位、转去找空槽,槽满时当场退回 ACQUIRE_REPLACE_NEEDED,换装永远买不成)。
      if (this.weapons[slot]!.type >= 0) this.clearSlot(slot);
      const code = this.mergeOrInstall(type, slot);
      if (code < 0) return code;
    }
    this.starCoins -= price;
    this.shopWeapons[index] = -1; // 一卡一售:当场下架,本轮不再出现
    return ACQUIRE_OK;
  }

  /**
   * 船坞商店(改版 21 号):刷新武器货架。与 rerollOffer 同一条"玩家主动操作消费 rng"的
   * 外部输入口径 —— 刷新消耗的 rng 在随机序列里,同 seed 同操作序列逐位可复现。
   * 校验顺序定死(整备闸门 → 星币够),失败原样返回、一个字段都不动。
   * 成功后重掷武器货架(DOCK_WEAPON_COUNT 次 rng)**并跟着重掷特价**(恰 1 次 rng,
   * 新货架配新特价 —— 打折机制:每次上架选一件商品打折)。
   *
   * @returns 0 = 成功;负数 = 理由码(REFIT_NOT_ACTIVE / SHOP_NO_REFRESH_STARCOINS)。
   */
  refreshShop(): number {
    if (!this.refitPending) return REFIT_NOT_ACTIVE;
    if (this.starCoins < DOCK_SHOP_REFRESH_PRICE) return SHOP_NO_REFRESH_STARCOINS;
    this.starCoins -= DOCK_SHOP_REFRESH_PRICE;
    this.rollShopWeapons();
    this.rollShopDiscount();
    return 0;
  }

  /**
   * 跳过当前候选。照样消费这一次升级并 upgrades++(防同帧重弹 + 下一档全新候选 = 付费重随),
   * 直接残骸损失恒为 UPGRADE_SKIP_FEE(refund = cost − 手续费,见 data/economy.skipRefundFor);
   * 没有待选时返回 false 且不动账,避免 UI 的过期按钮凭空消费一次曲线。
   */
  skipUpgrade(): boolean {
    if (this.offer.length === 0) return false;
    this.completeUpgrade(skipRefundFor(this.upgradeCost));
    return true;
  }

  /**
   * 重摇当前三选一(16 号):玩家在时停中的一次主动操作,与 skipUpgrade / takeUpgrade 同一条
   * **"step() 之外的外部输入"路径** —— 消费 rng、改 offer 都是玩家行为的一部分,天然确定性:
   * 序列推进由玩家操作决定,同 seed 同操作序列逐位可复现。
   *
   * 校验顺序定死:**有待选 → 星币够 → 本档还没摇过** 才动手;任何一条不满足就原样返回,
   * 一个字段都不动 —— 尤其**不消耗 rng**(失败的尝试不许推动随机序列)。
   * 通过校验后:扣 REROLL_PRICE 星币 → 再次调 rollUpgradeOffer 重掷三个候选位 ——
   * 自动继承它那套定死的 2×UPGRADE_CHOICE_COUNT 次 rng 消耗与卡池过滤,rng 口径与首掷完全相同,
   * 改平衡不会漂。三候选可能与原候选重复(与 GDD 语义一致,不额外去重,rollUpgradeOffer
   * 的去重只在**本次**新掷的三张之间)。
   *
   * @returns 成功 = 新候选数(与 offer.length 相等,照 takeUpgrade 的成功码口径);
   *   失败 = 负数理由码:UPGRADE_NO_OFFER(没有待选)、REROLL_NO_STARCOINS(星币不足)、
   *   REROLL_ALREADY_DONE(本档已摇过一次)。
   */
  rerollOffer(): number {
    if (this.offer.length === 0) return UPGRADE_NO_OFFER;
    if (this.starCoins < REROLL_PRICE) return REROLL_NO_STARCOINS;
    if (this.offerRerolled) return REROLL_ALREADY_DONE;
    this.starCoins -= REROLL_PRICE;
    this.offerRerolled = true;
    // edictLevels 同传:重摇后的法令候选同样剔掉已满层(与首掷同一套过滤);
    // unlockMask 同传:重摇后的卡同样不出现未解锁的塔/法令(与首掷同一套过滤)
    return rollUpgradeOffer(this.rng, this.offer, this.edictLevels, this.unlockMask, this.weapons);
  }
  /**
   * 把运行器的一次"朝这个方向出一只这型的怪"落成世界里的一只敌人 —— **正式出怪的唯一落点**。
   * 脚本那一半(什么时候、朝哪、出几只)全在 sim/waves.ts,这里只补它不该知道的三件事:
   * 出生点坐标、在场上限、池与 initEnemy。
   *
   * 出生点以**船**为心而不是场心:镜头永远跟着船走(GDD §3.3),以场心算的话船开到边上时,
   * 一侧的怪会当着玩家的面在屏幕里凭空出现,另一侧则要空飞两千像素才进场 ——
   * 而"屏幕外环形区生成"正是 08 号任务的原话。半径与抖动带见 data/waves.ts(它同时是
   * sim 与渲染层之间关于"视野有多大"的唯一约定:sim 不知道屏幕多大,铁律 1)。
   *
   * 触到在场上限就**丢弃这一发、不留账**:留账的话上限一解除会把攒下的怪一口气吐出来,
   * 正是"卡了之后更卡"的那条死亡螺旋。丢弃发生在掷半径之前,故触顶帧只消耗掉运行器那一次角度 ——
   * 上限是保险丝不是旋钮(见 WAVE_MAX_ALIVE),正常脚本下够不到,够到了这一局本就要输。
   *
   * rng 消耗顺序**定死为 角(运行器里)→ 半径(这里)→ initEnemy 的 side**,共三次、与型号无关
   *(型号与词缀由脚本给死,不掷随机)—— 于是改一次平衡(改速率、改型号、改展宽、改词缀)
   * 都不会移动整条随机序列,"同 seed 同波次"这条验收不会因为一次数值调整而全废。
   */
  private spawnFromWave(kind: number, angleRad: number, affixes?: readonly number[]): void {
    if (this.enemies.size >= WAVE_MAX_ALIVE) return;
    // 半径抖着来:不抖的话一股流出上百只之后会在屏外排成一道正圆弧,还会整排同时抵达 ——
    // "持续压力"当场被压成一下一下的脉冲(理由全文见 SPAWN_RADIUS_BAND)
    const r = SPAWN_RADIUS + this.rng.next() * SPAWN_RADIUS_BAND;
    const x = this.ship.x + Math.cos(angleRad) * r;
    const y = this.ship.y + Math.sin(angleRad) * r;
    const e = this.enemies.spawn();
    // HP 时间缩放只在出生时算一次(GDD §14):在场的敌人不会因为时间流逝而回血变硬;
    // 词缀位掩码在这里落地(affixMask 把 WaveElite.affixes 的编号数组换算成掩码,undefined = 普通怪),
    // 精英的 HP ×ELITE.hpMul 在 initEnemy 里当场算好
    initEnemy(e, kind, x, y, this.elapsed, this.rng, affixMask(affixes));
    // 只在敌人真正进池并完成初始化后记样本：burst 与普通流共用这一条入口；触顶丢弃在上面
    // 已经 return，故不会把“请求过但没生成”的怪算进罗盘强度。只记角度与一次固定脉冲，零分配。
    this.threatRate += THREAT_SPAWN_IMPULSE;
    this.threatDirX += Math.cos(angleRad) * THREAT_SPAWN_IMPULSE;
    this.threatDirY += Math.sin(angleRad) * THREAT_SPAWN_IMPULSE;
    // 挂钩排在 initEnemy **之后**:回调读到的必须是填完的敌人(kind/x/y 都已就位),不是个空壳
    this.onEnemySpawn?.(e);
  }

  /**
   * 进入 Boss 战(15 号 T1):脚本走完(第 4 段结束)那一帧调用一次。
   * Boss 与敌人**同池**(铁律 3:池对象,不 new 常量对象),kind = KIND_BOSS 作专用标记;
   * 生成**零 rng** —— 出生方向 = 脚本最后一帧保留的主压方向(wave.dirRad 在段走完后
   * 由 refreshDerived 留在最后一帧的值),半径 = 出怪环中点,side 由 initBoss 定死 0。
   * 于是"Boss 什么时候来、从哪来"都是确定性事实,不扰动召唤与出怪的随机序列。
   */
  private enterBossPhase(): void {
    this.bossPhase = 1;
    this.bossSummonN = 0;
    this.bossSummonCooldown = BOSS.summonInterval;
    const a = this.wave.dirRad;
    const r = SPAWN_RADIUS + SPAWN_RADIUS_BAND / 2;
    const e = this.enemies.spawn();
    initBoss(e, this.ship.x + Math.cos(a) * r, this.ship.y + Math.sin(a) * r, this.elapsed);
    // 与 spawnFromWave 同口径:只在真正进池并初始化后记样本 + 响挂钩。
    // 罗盘指向 = 主压方向(最后一帧),于是"威胁来了"的读数与 Boss 实际来向一致
    this.threatRate += THREAT_SPAWN_IMPULSE;
    this.threatDirX += Math.cos(a) * THREAT_SPAWN_IMPULSE;
    this.threatDirY += Math.sin(a) * THREAT_SPAWN_IMPULSE;
    this.onEnemySpawn?.(e);
    this.bossRef = e; // 召唤侧 O(1) 缓存的挂载点(见 stepBossSummon)
  }

  /**
   * 推进 Boss 战的召唤侧(15 号):每帧减召唤计时,到点触发一次召唤事件。
   *
   * rng 口径定死:**每只召唤怪恰好一次 rng.angle()**(出生角),型号/数量直给
   * (BOSS.summonCounts,与 waves 的"每成功出一只恰一次 rng、型号/数量不掷随机"
   * 同一条纪律 —— 改召唤构成不会移动整条随机序列)。
   * 召唤怪在 Boss 身边一圈出生(BOSS.summonRingRadius,以 Boss 为心)、
   * 共享 WAVE_MAX_ALIVE 在场上限:触顶丢弃、**不留账**(与 spawnFromWave 一字同源,
   * 且丢弃发生在掷角度之前 —— 触顶帧一次 rng 都不消耗)。
   * 游标 bossSummonN 照 eliteNext 的"到点即消费"口径:事件触发即 +1、计时重置,
   * 即使一只都没落地 —— 上限是保险丝不是配额。
   * Boss 已击杀时由 bossPhase 挡在门外,这里再兜一道(尸体回池后池里就没有它了)。
   */
  private stepBossSummon(): void {
    // Boss 引用缓存在 spawnBoss 挂上,这里每帧只读缓存、不再全表扫敌人池(工程审计:
    // 纯逻辑层唯一的每帧线性扫描)。失效判据 = 引用被回池(dead 为真 —— Boss 死亡那一帧
    // reap 先翻 bossPhase 再回池,本函数由 bossPhase 挡在门外,这条是双保险)。
    // 读档恢复时 bossRef 是空(它是派生缓存、不进 checksum 不进存档),第一次调用
    // 现扫一遍重新挂上 —— 稳态 O(1),恢复路径一次 O(n)。
    let boss = this.bossRef;
    if (!boss || boss.dead) {
      boss = null;
      const items = this.enemies.items;
      for (let i = 0; i < items.length; i++) {
        const e = items[i]!;
        if (e.kind === KIND_BOSS) {
          boss = e;
          break;
        }
      }
      this.bossRef = boss;
    }
    if (!boss) return;
    this.bossSummonCooldown -= SIM_DT;
    if (this.bossSummonCooldown > 0) return;
    this.bossSummonN++;
    this.bossSummonCooldown = BOSS.summonInterval;
    const counts = BOSS.summonCounts;
    for (let k = 0; k < counts.length; k++) {
      const n = counts[k]!;
      for (let j = 0; j < n; j++) {
        if (this.enemies.size >= WAVE_MAX_ALIVE) return; // 保险丝:触顶丢弃,不留账
        const a = this.rng.angle(); // 每只召唤怪恰一次(与出怪的"每只恰一次"同口径)
        const x = boss.x + Math.cos(a) * BOSS.summonRingRadius;
        const y = boss.y + Math.sin(a) * BOSS.summonRingRadius;
        const e = this.enemies.spawn();
        // side 由 initSummon 按下标交替直给:左右舷都有,且一次 rng 都不额外掷
        initSummon(e, k, x, y, this.elapsed, j);
        // 罗盘样本照 spawnFromWave 同口径:每成功落地一只记一次,方向 = 召唤怪落点方位
        this.threatRate += THREAT_SPAWN_IMPULSE;
        const dx = e.x - this.ship.x;
        const dy = e.y - this.ship.y;
        const d = Math.hypot(dx, dy) || 1;
        this.threatDirX += (dx / d) * THREAT_SPAWN_IMPULSE;
        this.threatDirY += (dy / d) * THREAT_SPAWN_IMPULSE;
        this.onEnemySpawn?.(e);
      }
    }
  }

  /**
   * 孢子的齐射落地(22 号)—— 发射敌方弹丸是副作用,世界侧的唯一发射点。
   * **零 rng**:发射时刻由状态机计时器决定、方向 = 船当前方位 + 固定扇面偏移,
   * 于是"同 seed 两局:同一帧、同一方向、同一批弹丸"逐位可复现,出怪序列一步不挪。
   *
   * 弹丸伤害在发射那一刻定死(def.sporeDamage,飞行途中不回查敌人 —— 与 Bullet.damage
   * 同一条口径;精英/词缀不放大弹伤,放大的只有体型与 HP,与 14 号语义一致)。
   * life = 锚定距离 / 弹速 + 2s 余量:船在弹丸飞行途中还能机动,余量覆盖"船往远处躲"
   * 的那段航程,到期自然消失(射程上限的唯一表达,见 EnemyBullet.life)。
   */
  private fireSporeVolley(e: Enemy): void {
    const def = ENEMIES[e.kind]!;
    // 触顶丢弃、不留账:ENEMY_BULLET_MAX_ALIVE 是保险丝不是旋钮(与 spawnFromWave 一字同源)
    if (this.enemyBullets.size + def.sporeSalvoCount > ENEMY_BULLET_MAX_ALIVE) return;
    // 齐射扇面:固定偏移、固定步长,不掷随机(与 fireBullets 的扇开同一条写法)
    const base = Math.atan2(this.ship.y - e.y, this.ship.x - e.x);
    const n = Math.max(1, def.sporeSalvoCount);
    const step = n > 1 ? (def.sporeSpreadDeg * DEG2RAD) / (n - 1) : 0;
    const offset = -((n - 1) / 2) * step;
    const life = def.sporeRange / def.sporeSpeed + 2;
    for (let i = 0; i < n; i++) {
      const a = base + offset + i * step;
      const b = this.enemyBullets.spawn();
      b.kind = e.kind; // 来源敌型:渲染层据此取 enemyTint 配色(将来新远程型直接换号)
      b.x = b.px = e.x;
      b.y = b.py = e.y;
      b.vx = Math.cos(a) * def.sporeSpeed;
      b.vy = Math.sin(a) * def.sporeSpeed;
      // 弹幕伤害乘全局倍率,与 effectiveDamage 同一条口径(0 允许、负数与 NaN 一律当 0):
      // 面板/economy 测试要能整体关掉这一路伤害而不动接触伤害
      const scale = tuning.enemySporeDamageScale;
      b.damage = def.sporeDamage * (scale > 0 ? scale : 0);
      b.life = life;
      b.radius = SPORE_BULLET_RADIUS;
    }
  }

  /**
   * **debug 压测路径,不是正式出怪器** —— 正式的在 step() 里走 stepWaves + spawnFromWave。
   * 只有 tuning.stressSpawn = true 时才被调用,而 tuning.stressEnemies 与四条 enemyMix*
   * 也只在这条路上生效:它维持"场上恒定 N 只"这种压测才要的定数(01 号验收:1000 敌同屏 60fps),
   * 代价是这一局没有波次、没有主压方向、也没有胜利条件。
   *
   * 让面板改数量即时生效:不足则补,超出则回收(清场不算击杀,故不走 reap 的挂钩)。
   * **只剩敌人这一半**:子弹那一半(维持 tuning.stressBullets 颗哑弹)在 05 号 issue 整段删除 ——
   * 凭空重生的哑弹与真弹共用一个池,"500 弹同屏不掉帧"这条验收测的就是假东西。
   */
  private stressSyncCounts(): void {
    while (this.enemies.size < tuning.stressEnemies) this.spawnStressEnemy();
    while (this.enemies.size > tuning.stressEnemies) this.enemies.despawnAt(this.enemies.size - 1);
  }

  /**
   * 压测出一只怪(debug 路径,见 stressSyncCounts):以**船**为心的整圈上随机撒,与波次一个字都不沾。
   * 以船为心而不是场心:地图无限之后没有"场心"这回事 —— 船开出去多远,压测的虫堆都得跟着,
   * 否则拖着面板跑两屏就把 1000 敌全甩没了,压测测的就成了空场。
   * rng 消耗顺序**定死为 kind → angle → radius → side**,且与 kind 无关:
   * 改某一型的行为、甚至改出怪占比,都不会移动整条随机序列(位置序列照旧,只是型号变了),
   * 确定性回放才不会因为一次平衡调整而全废。
   */
  private spawnStressEnemy(): void {
    const kind = this.stressPickKind();
    const a = this.rng.angle();
    const r = SPAWN_MIN_RADIUS + this.rng.next() * (SPAWN_MAX_RADIUS - SPAWN_MIN_RADIUS);
    const e = this.enemies.spawn();
    // HP 时间缩放只在出生时算一次(GDD §14):在场的敌人不会因为时间流逝而回血变硬
    initEnemy(
      e,
      kind,
      this.ship.x + Math.cos(a) * r,
      this.ship.y + Math.sin(a) * r,
      this.elapsed,
      this.rng,
    );
  }

  /**
   * 按 tuning.enemyMix* 四个权重轮盘赌(**仅压测路径**:正式出怪器的型号由 data/waves.ts 的
   * 脚本逐条流给死,一次随机都不掷)。只影响新生成的敌人 —— 面板拖占比不会让已在场的敌人变型。
   * 无论权重如何都**恰好消耗一次 rng**:消耗次数随权重变的话,拖一下面板整条序列就错位了。
   */
  private stressPickKind(): number {
    // 面板下限是 0,这里再夹一次是防手改配置写出负权重把轮盘转反
    const w0 = Math.max(0, tuning.enemyMixSwarm);
    const w1 = Math.max(0, tuning.enemyMixStrafer);
    const w2 = Math.max(0, tuning.enemyMixTrailer);
    const w3 = Math.max(0, tuning.enemyMixBeetle);
    const total = w0 + w1 + w2 + w3;
    // 先取那一次随机数再判空:消耗次数必须与权重无关,否则拖一下面板整条序列就错位了
    const t = this.rng.next() * total;
    if (total <= 0) return KIND_SWARM; // 四个都拖到 0:回落成蜂群蛭,总不能出个空气

    // 累加比较(而不是逐个减):求和顺序与 total 一致,权重为 0 的型在浮点边界上也绝不会被选中
    let acc = w0;
    if (t < acc) return KIND_SWARM;
    acc += w1;
    if (t < acc) return KIND_STRAFER;
    acc += w2;
    if (t < acc) return KIND_TRAILER;
    return KIND_BEETLE;
  }

  /** 全体实体位置的滚动哈希。同 seed 同 tick 数 → 必然相同(01 号 issue 验收口径) */
  checksum(): string {
    let h = 0;
    const acc = (v: number): void => {
      h = (Math.imul(h, 31) + (Math.round(v * 8) | 0)) | 0;
    };
    // 船排在最前:它是这条哈希里唯一受输入影响的量,顺序固定才能跨运行比对。
    // 朝向换算成度再累加 —— Math.round(v*8) 对弧度太粗(量化步长 0.125 rad ≈ 7°),
    // 换成度后分辨率是 0.125°,才抓得住"同一条输入序列转出的角度不一致"
    acc(this.ship.x);
    acc(this.ship.y);
    acc((this.ship.heading * 180) / Math.PI);
    // 船体 HP:这一局唯一的失败进度。漏了它,"撞击没结算""无敌帧漏判""擦碰也扣了血"这三类回归
    // 全都会从确定性口径下漏掉。不放大 100 倍 —— HP 是 100 量级的量,acc 内部量化到 1/8 绰绰有余。
    //
    // **maxHp / shipDead / result 都不进**,它们是派生量:
    //   maxHp = damage.hullMaxHp(buffs, edicts),而支援槽与法令掩码下面都单独哈过了 ——
    //     哈它就是把同一件事哈两遍;
    //   shipDead 除了"hp 归零那一刻置位"没有第二条来路,hp 已经进来了,它就没有独立信息;
    //   result 又是 shipDead / wave.done / bossPhase 的纯函数(settleOutcome 只读这三样;
    //   bossPhase 在下面单独哈过),同理没有独立信息。
    acc(this.ship.hp);
    // 加速技能的两个计时器紧跟着船:它们直接决定巡航上限与推力的倍率,差一帧船的位置
    // 当帧分叉 —— 照 offerCooldown"凡是决定判定何时改变的字段都是真状态"的先例进哈希。
    // × 100 的量化理由与那批秒数字段一字同源(1/8 的步长抓不住单帧差)
    acc(this.boostTime * 100);
    acc(this.boostCooldown * 100);
    // 磁吸涌(26 号改)紧跟加速计时器:它直接决定起吸半径(涌 × 25 ≈ 全场),差一帧就是
    // "这颗残骸吸不吸得上"当帧分叉 —— 照 boost 那批秒数字段同一条 × 100 量化理由进哈希
    acc(this.magnetSurgeTime * 100);
    // 武器槽紧跟着船(改版 §5,取代旧甲板的逐格哈希):槽位与节流状态是逐帧演化的真状态,
    // 漏了它们,"某座塔的装填提前了一帧"这类分叉就从确定性口径下漏掉了 ——
    // 而节流状态恰恰决定了下一帧谁开火。顺序 = 槽位下标 0..7,永不改。
    // 每个槽都哈(空槽哈 type = -1 与全零字段):"清槽漏了字段"这类回归当场现形。
    // turretOffset 换算成度的理由与 heading 那句一致 —— Math.round(v*8) 对弧度太粗。
    // cooldown/reloadLeft/coolLock/charge/heat × 100 的理由与"弧度换算成度"同源:
    // Math.round(v * 8) 对 0..1 量级的秒数/进度太粗(量化步长 0.125),抓不住一两帧的差别
    for (let i = 0; i < WEAPON_SLOT_COUNT; i++) {
      const s = this.weapons[i]!;
      acc(s.type);
      acc(s.stars);
      acc((s.turretOffset * 180) / Math.PI);
      acc(s.cooldown * 100);
      acc(s.ammo);
      acc(s.reloadLeft * 100);
      acc(s.heat * 100);
      acc(s.coolLock * 100);
      acc(s.charge * 100);
    }
    // 波次进度紧跟着槽位(08 号):它是这一局的推进进度,逐帧演化(段内计时 → 段推进 → 逐流的出怪账),
    // 不是任何东西的派生量 —— 漏了它,"某一段早换了一帧""某条流的账差了半只"这类分叉不会当场炸出来,
    // 只会在几十秒后以"怪莫名其妙多了一只"的形式浮上来,那时早已看不出是哪一帧走岔的。
    // 顺序 = segment → segTime → burstNext → eliteNext → debt,与 WaveState 的字段顺序一致,永不改。
    // **eliteNext 也进**(14 号):精英事件是"到点即消费"的游标,它差一,本段的精英
    // 就整只错位 —— 重放时"这只精英出没出过"是唯一从普通怪身上看不出差别的状态
    // (词缀对普通怪的影响要等光环/抗性在若干帧后反哺到位置才露馅,游标是即时的那一面)。
    // × 100 的理由与冷却/装填/惩罚那批秒数字段一字同源:acc 内部量化到 1/8,不放大的话段内计时的
    // 分辨率只有 0.125s(整整七帧半),debt 那种 0..1 量级的账更是直接被抹平。
    //
    // **dirRad / intensity / done 一律不进**,与 maxHp / shipDead 同一条派生量口径:
    // 三者都是 segment + segTime + 脚本的纯函数(sim/waves.ts 里就是这么算出来的),
    // 而 segment 与 segTime 上面刚哈过 —— 哈它们只是把同一件事哈两遍
    acc(this.wave.segment);
    acc(this.wave.segTime * 100);
    acc(this.wave.burstNext);
    acc(this.wave.eliteNext);
    for (let i = 0; i < this.wave.debt.length; i++) acc(this.wave.debt[i]! * 100);
    // Boss 阶段(15 号)紧跟着波次进度:phase 与召唤游标/计时是逐帧演化的真状态 ——
    // 召唤消费 rng(每只召唤怪一次角度),漏了它们,"同 seed 两局召唤时刻/数量错位"
    // 就会从确定性口径下漏掉(照 eliteNext 先例);bossKilledAt 是击杀时刻的一次性记录
    // (与 kills 同一条派生量口径,击杀本身在敌人池与 bossPhase 里可见),不进哈希;
    // Boss 本体在敌人池里,下面逐只哈过了。
    // × 100 的理由与波次那批秒数字段一字同源:acc 内部量化到 1/8,不放大的话召唤计时的
    // 分辨率只有 0.125s(整整七帧半),差一两帧根本看不出来
    acc(this.bossPhase);
    acc(this.bossSummonN);
    acc(this.bossSummonCooldown * 100);
    for (const e of this.enemies.items) {
      acc(e.x);
      acc(e.y);
      // 型号与血量也进哈希:否则"出怪混型错位"或"伤害算错"这两类回归会从确定性口径下漏掉
      acc(e.kind);
      // 词缀位掩码也进(14 号):漏了它,"该带词缀的精英成了普通怪"这类回归从确定性口径下漏掉 ——
      // 血量可能被 ELITE.hpMul 兜住,但狂热光环/磁力干扰的效果反哺的是**别人**的位置
      acc(e.affixes);
      acc(e.hp);
      // 无敌帧剩余秒同理是逐帧演化的状态:它决定"这一口该不该咬",漏了它,
      // "结算间隔算错"就只会在血条上慢慢体现,而不会当场炸出一次确定性分叉。× 100 同上
      acc(e.hitCd * 100);
      // animSeed 从纯表现升格为判定输入(视野回收的落点半径/角偏,见 ENEMY_RECYCLE_RADIUS
      // 那段),按"checksum 哈所有真状态字段"的口径必须进 —— × 1000 只求绊线分辨率,
      // 落点分叉的第一责任人仍是下面的 x/y(animSeed 本身是出生位置的确定性哈希)。
      acc(e.animSeed * 1000);
      // **hitFlash / lastHit 一律不进**:hitFlash 是纯表现(闪白不参与任何判定,渲染层
      // 只读它上色,少闪一帧不改变世界的下一帧);
      // lastHit 是伤害输入的派生量(amount × 抗性,抗性读 e.affixes、伤害最终落在 e.hp,
      // 两个输入都已在哈希里 —— 哈它只是把同一件事哈两遍,与 maxHp 同一条口径)。
      // 本哈希本来也不逐字段哈敌人(状态机/速度/朝向都不进),它们不在,表现字段更不该在
    }
    // 子弹**只哈位置**:伤害/存活/穿透都是发射那一刻定死的常量(见 sim/bullet.ts),
    // 而位置已经能抓住任何弹道分叉 —— 多哈几个不会变的数只是把同一件事哈好几遍。
    for (const b of this.bullets.items) {
      acc(b.x);
      acc(b.y);
    }
    // 敌方弹丸(22 号)紧跟 my 子弹,且同样**只哈位置**,理由也是同一条:
    // 伤害/半径是发射那一刻按敌型定死的常量;存在性(池里有几颗)本身就在这条循环里
    // —— 少哈一颗,齐射错位/拦截漏判这类分叉就只会在船体 HP 上慢慢体现,当场看不出来
    for (const b of this.enemyBullets.items) {
      acc(b.x);
      acc(b.y);
    }
    // 残骸紧跟着子弹,而且同样**只哈位置**,理由也是同一条:value 是掉落那一刻按敌型定死的常量
    //(与子弹的 damage 一样,飞行途中绝不会变);magnet 是只从 false 变 true 的单向锁,
    // 它一旦不同,下一帧的位置立刻就分开了(锁住的每帧朝船走一步,没锁的停在原地)——
    // 位置这一项已经抓得住,多哈几个不会变的数只是把同一件事哈好几遍。
    // **kind 例外**(26 号改):它决定收下这颗是进经验还是置涌,直接改 magnetSurgeTime ——
    // 一颗宝物被当成经验收下的分叉,位置轨迹上完全看不出来(两条路飞向船的方式一字不差),
    // 却会让涌少一场,故 kind 单独进哈希。
    for (const d of this.drops.items) {
      acc(d.x);
      acc(d.y);
      acc(d.kind);
    }
    // 收下的残骸当场出池,故池里再也找不到它 —— 这一笔账必须单独进哈希,
    // 否则"磁吸多收了一颗/漏收了一颗"这类回归在场上残骸清空之后就彻底看不见了。
    // 经验增幅器的 xpMul 让收账可以是小数,acc 内部量化到 1/8 照样抓得住倍率分叉
    acc(this.scrap);
    // 升级次数与候选紧跟残骸经济账。upgradeCost 不进:它是 upgrades 的纯函数(data/economy.upgradeCost)。
    // offer 则必须进:它消耗了 rng、决定玩家能拿什么,不是槽位或残骸的派生量;
    // 漏了它,"同 seed 弹出不同三张卡"要等玩家选完、槽位分叉后才看得见。
    acc(this.upgrades);
    // 弹卡冷却是逐帧演化的真状态:它决定 rollUpgradeOffer **何时**消耗 rng,差一帧就是整条
    // 随机序列错位。× 100 的理由与那批秒数字段一字同源(量化到 1/8 抓不住单帧差)
    acc(this.offerCooldown * 100);
    acc(this.refitPending ? 1 : 0);
    // 商店信标:位置消耗过 rng、计时决定还剩几帧可接、active 决定接不接得上 —— 全是真状态。
    // 坐标是世界 px(量级上千),照 ship.x/y 的口径不放大;ttl × 100 与那批秒数字段同源
    // (量化到 1/8 抓不住单帧差)。**shopBeaconSegment 不进**:它是 wave.segment 在
    // 生成那一帧的快照,而 segment 本身下面就哈过 —— 派生量口径,哈它是把同一件事哈两遍
    acc(this.shopBeaconActive ? 1 : 0);
    acc(this.shopBeaconX);
    acc(this.shopBeaconY);
    acc(this.shopBeaconTtl * 100);
    for (const opt of this.offer) {
      acc(opt.kind);
      acc(opt.type);
      acc(opt.level);
    }
    // 法令层数表紧跟候选:它是逐帧演化的真状态(抽卡叠层、永不撤销),而它只改
    // effective 数值(射速/伤害/转向/拾取半径/过热/HP/巡航/星币概率) —— 那些数值本就参与判定,
    // 漏了它,"同 seed 一边叠到第 2 层散热协议一边只有 1 层"就会在若干帧后以"谁的塔先开火"
    // 的形式分叉,却查不出是哪一帧走岔的。**逐条哈层数而不是哈一个掩码**:
    // 掩码存不下"叠了几层",而层数正是效果强度本身。整数,不放大(与 offer 的 kind/type 同口径)。
    // 法令聚合(buffs)不进:它是本表 + 数据表的纯函数,哈它只是把同一件事哈两遍。
    // **unlockMask(19 号)不进**:它是开局定死的跨局存档输入,只收窄候选集合与解锁槽位
    // 出不出,不参与任何判定、不移动 rng 消耗 —— 与跨 seed 同一条口径,哈它只是把
    // "同一份存档"哈一遍;eliteKills 同理不进(与 kills 同一条派生量口径,见字段注释)
    for (let i = 0; i < EDICT_KIND_COUNT; i++) acc(this.edictLevels[i]!);
    // 船坞法令货架(21 号)紧跟法令掩码:它消耗了 rng、决定玩家这轮能买什么,不是任何
    // 派生量 —— 漏了它,"同 seed 两局货架摆出不同两张卡"要等买完、法令掩码分叉后才
    // 看得见(与 offer 逐项进哈希同一条理由);已售出的格子哈成 -1,售出与否同样在哈希里
    for (const t of this.dockEdictOffers) acc(t);
    // 商店武器货架(改版 21 号)紧跟法令货架:同一条"消耗了 rng、决定玩家这轮能买什么"的理由,
    // 逐项进哈希;已售出的格子哈成 -1,售出与否同样在哈希里
    for (const t of this.shopWeapons) acc(t);
    // 特价位(打折机制)紧跟武器货架:与两张货架同一条"消耗了 rng、决定玩家这轮花多少钱"的
    // 理由,漏了它,"同 seed 一边打五折一边原价"的分叉在余额(不进 checksum)上永远看不见
    acc(this.shopDiscountIndex);
    // 重摇次数限制(16 号)紧跟候选:它决定 rerollOffer **是否**再次消耗 2×count 次 rng,
    // 差一次就是整条随机序列错位 —— 照 offerCooldown 的先例进 checksum。
    // **starCoins 余额不进**:它只影响 UI 读数与消费、不参与任何 sim 判定;重摇与船坞
    // 购买(改版 21 号)消耗的 rng 本身在序列里,余额只是那条序列的读数 —— 扣过费没有,
    // 序列照样逐位可复现(与 maxHp 同一条"不进"的口径,理由全文见 starCoins 字段注释)。
    acc(this.offerRerolled ? 1 : 0);
    // FxEvent 一律**不进** checksum:它纯是表现(少画一条闪电不改变世界的下一帧),
    // 混进来只会让"渲染改一下淡出时长"看起来像一次确定性回归。
    return (h >>> 0).toString(16).padStart(8, '0');
  }
}
