/**
 * 世界状态与规则 —— 纯逻辑层。
 * 铁律:本目录永不 import pixi/DOM。这换来:同 seed 确定性、Node 里可单测、渲染可替换。
 *
 * 当前内容 = 玩家船(02)+ 四型敌人(07)+ 武器塔与它们打出来的子弹(05)+ 挨打这一半(09)
 *   + 波次脚本出怪(08):
 *   一艘玩家船(输入只以纯数据 ShipCommand 从外部灌入,sim 永不读键盘),
 *   由 sim/waves.ts 的运行器按航段脚本从**船外环**刷出来的敌人,
 *   甲板上的塔真的开火产生的子弹与可视化事件,
 *   以及贴上来的敌人对船体 HP 的结算与四舷受击惩罚。
 *
 * 01 号 issue 那批"凭空重生的压测哑弹"在 05 号整段删除:哑弹与真弹共用一个池,
 * "500 弹同屏不掉帧"这条验收测的就是假东西 —— 500 弹现在得由塔真的打出来才算数。
 *
 * 分工:单只敌人的行为(追踪/绕行/冲锋状态机)在 sim/enemy.ts,炮管的追瞄与归位在 sim/turret.ts,
 * 子弹的积分与命中在 sim/bullet.ts,受击判定的全部几何(核心区/甲板轮廓/四舷/射速惩罚)在
 * sim/damage.ts,「脚本 → 出怪事件」的翻译在 sim/waves.ts(它一个字都不认识世界,只说"朝这个方向
 * 出一只这型的怪"),本文件只做"世界这一层"的接线 —— 出怪落点、邻居分离、积分位置、接触粗筛、
 * 开火的去处(FireSink)、船体受击结算、事件老化、死亡回收。
 * 拆开的理由是它们能脱开世界单测(见 enemy.test.ts / turret.test.ts / bullet.test.ts /
 * damage.test.ts),而这里钉的是顺序与生命周期。
 *
 * 局终这件事本文件只做到"判"为止(08 号 T3):帧尾的 settleOutcome 把胜负结论落成 result
 * 与一次 onGameOver,而**暂停、重开、动 loop、弹结算界面一概不在这里** ——
 * 世界不认识"游戏流程",那一层在 main.ts。于是有了结论之后 step() 照常可以被调用
 *(既有那条"船沉后世界照常往下跑"的用例仍然成立),停不停由调用方决定。
 * HP 上限与舷向减伤问 damage.ts 的两个挂钩(06 号装甲舱届时只填函数体);
 * onEnemySpawn / onEnemyDeath 是一对对称的挂钩(渲染/统计想知道"谁来了、谁没了")。
 *
 * 残骸掉落(10 号 T1)落在帧尾的 reap 里:每只死者当场掉一颗,面额按型取自数值表。
 * 磁吸与收取的**全部规则**在 sim/drop.ts(它连世界都不认识,喂一个池 + 一块甲板 + 船心坐标就能单测),
 * 本文件照旧只做接线 —— 敌人死了往池里放一颗(spawnDrop)、把 stepDrops 结算出来的那笔账记进 scrap。
 * 星币(16 号)与残骸不同源但同仓:精英/Boss 击杀在 spawnDrop 里当场入账 world.starCoins
 * (不造掉落物、不走磁吸),消费点 = 时停中的 rerollOffer(10 星币重掷三候选,每级最多一次)。
 * 三选一经济(T2)同样只在这里接线:sim/upgrade.ts 负责生成合法候选,本文件负责扣残骸、记升级次数、
 * 帧尾在够钱时弹出一次 offer。暂停/卡片/放大甲板仍一概不在 World,那层在 main.ts。
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
  DROP_MAX_ALIVE,
  REROLL_PRICE,
  skipRefundFor,
  upgradeCost as economyUpgradeCost,
  UPGRADE_OFFER_COOLDOWN,
} from '../data/economy';
import { BOSS, ENEMIES, KIND_BOSS, KIND_BEETLE, KIND_STRAFER, KIND_SWARM, KIND_TRAILER } from '../data/enemies';
import { SUP_AMMO_BAY } from '../data/supports';
import {
  FX_LIFE_BEAM,
  FX_LIFE_BLAST,
  FX_LIFE_CHAIN,
  FX_LIFE_LANCE,
  THR_AMMO,
  THR_CHARGE,
  THR_HEAT,
  TOWER_AUTOCANNON,
} from '../data/towers';
import { SPAWN_RADIUS, SPAWN_RADIUS_BAND, WAVE_MAX_ALIVE } from '../data/waves';
import { type Bullet, createBullet, resetBullet, stepBullets } from './bullet';
import { tuning } from './config';
import {
  classifyHit,
  deckOuterRadius,
  edgeDamageMul,
  HIT_CORE,
  HIT_NONE,
  hitBroadside,
  hullMaxHp,
} from './damage';
import {
  createDeck,
  type Deck,
  deckTurnRate,
  EDGE_COUNT,
  isEdgeExposed,
  isPlaceSuccess,
  isWeldSuccess,
  moveModule,
  MOVE_OK,
  placeAt,
  weldPiece,
} from './deck';
import {
  bossContactDamage,
  bossRadius,
  initBoss,
  initSummon,
  stepBossBehavior,
} from './boss';
import { createDrop, type Drop, resetDrop, stepDrops } from './drop';
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
  FX_LIFE_HULL_HIT,
  FX_LIFE_KILL,
  FX_LIFE_SPARK,
  type FireSink,
  type FxEvent,
  FXV_BLAST,
  FXV_CHAIN,
  FXV_HULL_HIT,
  FXV_KILL,
  FXV_LANCE,
  FXV_SPARK,
  resetFxEvent,
} from './fx';
import { createShip, DEG2RAD, type Ship, type ShipCommand, stepShip, type Vec2 } from './ship';
import { syncSupportBuffs } from './support';
import { stepTurrets } from './turret';
import {
  optionContent,
  optionSupportType,
  optionTowerType,
  rollUpgradeOffer,
  OFFER_DECK,
  type UpgradeOption,
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

/** 无输入的默认指令:让不接线输入的调用方(单测、无头跑批)照常 world.step() */
const IDLE: ShipCommand = { desiredHeading: null };

/**
 * 地图是**无限的**:没有边界圈、没有对船的贴边夹取(原 WORLD_RADIUS 已删)。
 * 船开到哪,交战就在哪 —— 出怪环(data/waves.ts 的 SPAWN_RADIUS)本就以船为心,
 * 空间哈希按 cell 坐标散列(core/spatialHash),坐标多大都装得下。
 *
 * 原边界的真正职责("防止玩家一路开出怪潮之外把这一局拖成散步")由下面这对常量接手:
 * 被甩开超过 ENEMY_FALLBEHIND_RADIUS 的敌人**沿船心镜像重投**到 ENEMY_REJOIN_RADIUS ——
 * 即"落在身后追不上的怪,悄悄挪到你正开过去的那一侧屏幕外"(VS 同款的屏外重定位)。
 * 镜像而不是原地拉近:拉近的怪永远吊在船尾追不上,压力等于零;镜像则让逃跑本身把压力
 * 转到航向前方,"跑"仍然有代价。**一次 rng 都不掷**(方向 = 旧方位取反,距离定死),
 * 于是同 seed 同输入的确定性回放照旧成立,重定位也不会扰动出怪序列。
 */
/** 触发重投的距离(> 出怪环外沿 SPAWN_RADIUS + BAND = 1300,新生的怪绝不会被当场误判) */
export const ENEMY_FALLBEHIND_RADIUS = SPAWN_RADIUS + SPAWN_RADIUS_BAND * 2;
/** 重投落点半径 = 出怪环内沿:与新刷的怪同一档距离,进屏节奏一致,玩家分不出谁是挪过来的 */
export const ENEMY_REJOIN_RADIUS = SPAWN_RADIUS;

/** 压测出怪环的内/外半径:别把敌人直接生在船脸上。**只服务于 stressSyncCounts 那条 debug 路径** */
const SPAWN_MIN_RADIUS = 300;
const SPAWN_MAX_RADIUS = 1200;

/**
 * 敌人期望速度的暂存。模块级复用而不是每只现造:1000 敌 × 60Hz 下,
 * 循环里 new 一个对象就是每秒六万次分配,直接写在 GC 停顿上(铁律 3:运行期零新增分配)。
 */
const desired: Vec2 = { x: 0, y: 0 };

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
const THREAT_SPAWN_IMPULSE = (1 - THREAT_SMOOTH_DECAY) / SIM_DT;
/** 最近实际生成速率低于这一档时，旧样本已经没有指向意义，回退波次脚本的派生方向。 */
const THREAT_DIRECTION_MIN_RATE = 0.05;
/** 两股相反压力把方向向量抵消时同样回退，避免 atan2(≈0,≈0) 给出随机抖动。 */
const THREAT_DIRECTION_EPSILON = 1e-6;

/**
 * 可视化事件的存续秒数:开火那几种一律取 data/towers 的 FX_LIFE_*,挨打这两种取 sim/fx.ts 的
 * FX_LIFE_SPARK / FX_LIFE_HULL_HIT(渲染层读的是同一批常量,两边才不会各算各的淡出时长)。
 * 挨打那两个刻意不进数值表:那张表是"某座塔开火的表现有多长",而船上一座塔都没有照样会被撞 ——
 * 放进去只会让平衡调整与受击反馈莫名其妙地耦在一起(理由全文见 sim/fx.ts)。
 * FXV_MUZZLE 数值表没给档 —— 它只是"炮口闪一下",退回最短的那一档(与光束同长)即可;
 * 表里没有的数不该由 sim 现发明一个,那就成了第二处真相。
 */
function fxLife(kind: number): number {
  switch (kind) {
    case FXV_CHAIN:
      return FX_LIFE_CHAIN;
    case FXV_LANCE:
      return FX_LIFE_LANCE;
    case FXV_BLAST:
      return FX_LIFE_BLAST;
    case FXV_SPARK:
      return FX_LIFE_SPARK;
    case FXV_HULL_HIT:
      return FX_LIFE_HULL_HIT;
    case FXV_KILL:
      return FX_LIFE_KILL;
    default:
      return FX_LIFE_BEAM;
  }
}

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

/** 整备操作不是战斗放置，流程过期与“本轮已经焊过甲板”各用独立结果码。 */
export const REFIT_NOT_ACTIVE = -20;
export const REFIT_ALREADY_WELDED = -21;

/**
 * 重摇失败(16 号):星币不足(重摇价 = data/economy 的 REROLL_PRICE)。
 * **负数、落在既有成功码之外**是有意的:调用方拿到的与 takeUpgrade 是同一条返回通道,
 * 一次 `> 0` 判据就能把"新候选数"与"失败理由"分开(重摇成功返回新候选数)。
 */
export const REROLL_NO_STARCOINS = -30;
/** 重摇失败:当前这档 offer 已经摇过一次(每级最多 1 次,todos/16)。 */
export const REROLL_ALREADY_DONE = -31;

export class World {
  readonly rng: Rng;
  readonly enemies: Pool<Enemy>;
  readonly bullets: Pool<Bullet>;

  /**
   * 场上的残骸掉落物(10 号 issue T1)。敌人死在哪就掉在哪(reap 里的 spawnDrop),
   * 此后由 sim/drop.ts 的 stepDrops 每帧推进磁吸与收取 —— 起吸/锁定/收取的规则一个字都不在本文件,
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
   * 甲板(03 号 issue):起始 = T0 拾荒艇的 3×4 全空格。整局同一个对象,
   * 放塔与 12 号扩建都是就地改字段 —— 渲染层持有它的引用,靠 revision 做脏标记。
   */
  readonly deck: Deck = createDeck();

  /**
   * 本局的波次脚本进度(08 号 issue)。整局同一个对象,由 stepWaves 每帧就地推进。
   * **不提供 reset()**:重开 = 换整个 World(池 / rng / tick / 甲板全是新的才谈得上"同 seed 可复现"),
   * 单独把波次拨回去只会造出一个"敌人还在场、脚本却从头开始"的四不像。
   *
   * 里头 segment / segTime / burstNext / eliteNext / debt 是真状态(全进 checksum,14 号起精英游标也哈),
   * dirRad / intensity / done 是它们与脚本的纯函数(派生量口径见 sim/waves.ts 的字段注释)。
   * **tuning.stressSpawn = true 时它整段旁路**:冻在初值、方向不转、永不 done。
   */
  readonly wave: WaveState = createWaveState();

  /**
   * 本帧贴到船身的敌人 —— **粗筛候选**(照 sim/turret.ts 的 candidates 口径),不是"真撞上的人"。
   * 敌人循环里只做一次廉价的圆判定(甲板外接圆 + 体型)就入名单,精筛(damage.ts 的 classifyHit)
   * 与扣血全在 settleHullDamage 一处:判定几何全仓只有 damage.ts 那一份,热循环里再抄一遍
   * 迟早写歪,而那时"画出来的判定体"与"真正扣血的判定体"就不是同一个了。
   * 于是它是**超集** —— 名单里的人可能一层都没碰上(粗筛宁大勿小,半径口径见敌人循环里那段 cr)。
   * 每帧在敌人循环前清空;元素是池中对象,step() 返回后立刻读,别跨帧存引用 ——
   * 死者回池后同一个对象会变成另一只敌人。
   */
  readonly contacts: Enemy[] = [];

  /**
   * 四舷的受击惩罚剩余秒,下标 = EDGE_*。>0 = 该舷闪红(渲染层)+ 该舷塔射速惩罚中(sim/turret)。
   * 整局复用同一个致密四元组(铁律 3:运行期零新增分配),逐帧减 dt 夹 0。
   *
   * 闪红与射速惩罚读的是**这同一个计时器**:两件事天然同起同落,想差一帧都做不到 ——
   * 渲染层要是为闪红另起一个衰减计时,玩家看到的"这一舷在闪"与"这一舷的塔在变慢"就会各走各的,
   * 而它们本该是同一次挨打。"惩罚不可叠加延长"的语义也一并白送(见 damageShip)。
   */
  readonly edgePenalty: number[] = new Array<number>(EDGE_COUNT).fill(0);

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
   *
   * 它与 onGameOver **各管一件事、不合并**:这个说的是"船沉了"(帧中、只有失败这一条路),
   * onGameOver 说的是"这一局结束了,结果是 X"(帧尾、胜负共用一个出口)。
   * 想接失败流程请接 onGameOver;想接"沉船那一刻的爆炸表现"才接这个。
   */
  onShipDestroyed: (() => void) | null = null;

  /**
   * 本局的结果码(RESULT_*),由 step() 帧尾的 settleOutcome 置位,**置位后永不再变**。
   * 它是 shipDead / wave.done / bossPhase 的**派生量**(settleOutcome 只读这三样,没有第三条来路;
   * bossPhase 本身进 checksum,故 result 仍没有独立信息),
   * 故**不进 checksum** —— 与 maxHp / shipDead / wave 的 dirRad 同一条口径。
   */
  result = RESULT_RUNNING;

  /**
   * 局终的**一次性**回调,胜负共用一个出口(参数 = RESULT_WIN / RESULT_LOSE)。
   * 只在结论落定那一帧响一次:settleOutcome 的首句就把已有结论的世界挡在门外,
   * 于是结算界面弹出后世界再被 step 多少帧也不会弹第二次,流程那一侧不必自己去重。
   *
   * **回调里该做的事全在 main.ts**:停 loop(run.paused)、弹结算界面、截船形剪影 ——
   * World 一样都不做,它连"这一局要不要停"都不知道。
   */
  onGameOver: ((result: number) => void) | null = null;

  /**
   * 死亡挂钩(表现与统计的出口)。回调返回后对象立刻回池,
   * 所以回调里必须当场取走 x/y/kind,不能存引用等下一帧再读。
   *
   * **残骸掉落不走它**:那是世界自己的账,已经在 reap 里由 spawnDrop 当场落地(排在本回调之前) ——
   * 挂钩接不接、接的人做了什么,都不该决定这一局能不能捡到残骸。
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
   * 距下次召唤的剩余秒数。真状态、逐帧演化,×100 进 checksum(与 edgePenalty 同口径);
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
   * 已收集、未花掉的残骸(GDD §7:全程唯一成长资源),**恒整数** ——
   * 面额是数值表里的整数 scrap,收下时整颗进账,全程没有任何地方给它乘系数或按比例结算。
   * 收取在 T1 接线,花费/跳过返还由本轮 T2 的 completeUpgrade 统一结算。
   *
   * 它是逐帧演化出来的状态、**不是派生量**:收下的那颗当场出池,池里再也找不到它 ——
   * 于是漏了它,"磁吸多收/漏收了一颗"这类回归在池空之后就彻底看不见了,故进 checksum。
   */
  scrap = 0;

  /**
   * 已入账、未花掉的星币(GDD §7 第二货币,16 号)。**恒整数**:面额是数值表里的整数
   * (ELITE.starCoins / BOSS.starCoins),精英/Boss 击杀当场整笔进账(spawnDrop 里结),
   * 重摇时整笔扣费(rerollOffer),全程没有任何系数或按比例结算。
   *
   * 与残骸同口径的只是"逐帧演化出来的账目"这一面;**它不进 checksum**(与 maxHp 同一条
   * "不进"的先例,但理由不同,见下):星币只影响 UI 读数与消费,不参与任何 sim 判定 ——
   * 重摇消耗的 rng 本身在随机序列里(每次恰 2×UPGRADE_CHOICE_COUNT 次),余额只是那条
   * 序列的**读数**:同一局扣过费没有,序列照样逐位可复现。一旦出现"星币 ≥ X 触发某行为"
   * 的规则(如商店购买门槛),它就成了判定输入,必须改成进 checksum(todos/16 口径)。
   */
  starCoins = 0;

  /**
   * 已经**结算完**的升级次数,同时也是下一次费用曲线的级数。
   * 它不是甲板等级之和:跳过照样算结算一次、同一张卡也可能新建 Lv1 或叠到 Lv4;
   * 经济曲线只关心这局已经消费过几次机会。逐帧演化、进 checksum。
   */
  upgrades = 0;

  /**
   * 当前待选的候选卡。长度 0 = 没有待选;>0 = World 等玩家结算,自己绝不暂停。
   * 数组整局复用,rollUpgradeOffer 就地改三个对象;候选消耗了 rng 且决定玩家能放什么,
   * 不是甲板的派生量,故逐项进 checksum。
   */
  readonly offer: UpgradeOption[] = [];

  /**
   * 距下一次允许弹卡的剩余秒数(data/economy 的 UPGRADE_OFFER_COOLDOWN)。
   * completeUpgrade 置位、settleUpgrade 每帧尾减 dt:早期相邻档价差只有 9-21,
   * 一波混战攒出跨档余额时,没有它的话恢复战斗的下一帧会立刻再次时停弹卡。
   * 初值 0 = 首次弹卡不受限。它决定 rollUpgradeOffer **何时**消耗 rng,
   * 是逐帧演化的真状态而不是派生量,故进 checksum(与 edgePenalty 同口径)。
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
   * pending 期间 stepWaves 不再推进，故即使无头调用方继续 step，下一波也不会偷跑。
   */
  refitPending = false;
  /** 本轮整备是否已经焊过一块甲板；每轮最多一块，跳过则保持 false。 */
  refitWelded = false;
  /** 参数 = 即将开始的航段下标。 */
  onRefitOffer: ((segment: number) => void) | null = null;

  /**
   * 开火/命中的可视化事件(05 号 issue):渲染层遍历 world.fx.items 逐个画,按 life 淡出。
   * **纯表现,一律不进 checksum**(理由见 checksum 末尾那段);每帧在 step 末尾统一老化,
   * life ≤ 0 倒序 swap-remove 回池 —— 与子弹、敌人共用同一套生命周期写法(铁律 3)。
   */
  readonly fx = new Pool<FxEvent>(createFxEvent, resetFxEvent);

  /**
   * 本帧开火塔最多的那一舷(EDGE_*),**-1 = 本帧一座塔都没开火**;
   * broadsideCount = 该舷本帧的开火塔数,≥3 就是单舷齐射,渲染层据此给一次镜头顿挫(05 号 T5)。
   * 一座塔按它**每一条暴露边**各投一票、角落格同时算进两舷(归属规则与理由见 sink.fired)。
   * 与 contacts 同口径**逐帧重建**:它是"这一帧发生了什么"的读数,不是累计状态 ——
   * 不清的话镜头会被上一帧的齐射一直顶着。
   */
  broadsideEdge = -1;
  broadsideCount = 0;

  /**
   * 正式出怪器实际成功落地事件的一阶平滑统计。三个数整局就地演化、不存逐事件历史：
   * rate 是平滑后的只/秒；dirX/dirY 是同一批事件按出生角累积的加权方向向量。
   * 纯 HUD 读数，不参与任何判定，也不进 checksum（与 broadside/FxEvent 同口径）。
   */
  private threatRate = 0;
  private threatDirX = 0;
  private threatDirY = 0;

  private scratch: Enemy[] = [];

  /**
   * 狂热光环(14 号)的半径内受害者暂存。帧首按在场光环携带者各查一次空间哈希、
   * 收进这份数组(整帧复用、零分配),敌人循环里靠它判"这一只加不加速"。
   * **可能含重复**:同一只被多只光环覆盖会进多次(倍率连乘 = 光环叠加),故不能当 Set 用。
   * 与 scratch 分开:scratch 在敌人循环里被邻居分离反复清空,这份要活到整帧走完。
   */
  private auraVictims: Enemy[] = [];

  /** 本帧各舷的开火塔数,下标 = EDGE_*。整局复用同一个致密四元组(铁律 3:运行期零新增分配) */
  private readonly edgeFires: number[] = new Array<number>(EDGE_COUNT).fill(0);

  /**
   * 开火的去处(sim/fx.ts 的 FireSink)。塔与子弹只 `import type` 那份契约,经它回到世界里来 ——
   * 双向直连(world 调 turret、turret 取 world 的池)就是一个运行期循环依赖,
   * 在 ESM 里表现为"某一侧拿到 undefined",且只在改了 import 顺序时才炸。
   *
   * 做成**字段上的对象字面量**而不是 `World implements FireSink`:渲染层要遍历的事件池叫
   * world.fx,而契约里记事件的方法也叫 fx —— 同一个类上放不下两个同名成员。
   * 构造时建一次、整局复用(箭头函数捕获 this),不在每帧的开火路径上现造对象。
   */
  private readonly sink: FireSink = {
    spawnBullet: () => this.bullets.spawn(),
    damage: (e, amount, throttle) => this.damageEnemy(e, amount, throttle),
    fx: (kind, x0, y0, x1, y1, radius, towerType) => {
      const e = this.fx.spawn();
      e.kind = kind;
      e.x0 = x0;
      e.y0 = y0;
      e.x1 = x1;
      e.y1 = y1;
      e.radius = radius;
      e.towerType = towerType;
      e.life = fxLife(kind);
    },
    query: (x, y, r, out) => {
      this.grid.query(x, y, r, out);
    },
    fired: (cell) => {
      // 一座塔属于它**每一条暴露边**对应的舷,故角落格的这一发**同时记进两舷** ——
      // 判据就是既有的 isEdgeExposed,与 damage.cellFireRateMul(射速惩罚的逐塔归属)
      // 是同一条规则,全仓只此一份:玩家读到的"这一舷在齐射"与"这一舷在挨罚"说的必须是同一批塔。
      //
      // 不按"每格只挑一条边"(05 号临时的 lowestEdge、或按格心方位角都是这一类)的理由是甲板拓扑:
      // 3×4 甲板按暴露边数,BOW/STERN 各 3 格、PORT/STARBOARD 各 4 格,四舷都摆得下 3 座塔;
      // 挑一条边则 PORT 与 STERN 当场瘪成 2 格(两头的角落格被算给了别人),
      // 那两舷永远凑不满"≥3 塔齐射",一半的 broadside 反馈直接死掉(逐格计数见 damage.test.ts)。
      // 代价是 broadsideCount 的语义从"开火塔数"变成"**这一舷**有几座塔开了火",
      // 角落格的一发在两舷各算一票 —— 而这与它凭两条暴露边拿到 +60° 射界(GDD §4.2)是同一件事:
      // 它本来就同时对着两个方向打。
      //
      // 没有暴露边 = 内部格/离线塔,本就打不响;真进来了这个循环也一票不投,
      // 不必单独挡一手(那会让 broadsideEdge 变成瞎猜)
      for (let edge = 0; edge < EDGE_COUNT; edge++) {
        if (!isEdgeExposed(cell, edge)) continue;
        const n = this.edgeFires[edge]! + 1;
        this.edgeFires[edge] = n;
        // 严格 > 才换舷 = 平局保留先到的那一舷(edge 顺序固定 ⇒ 结果确定),与索敌的"保留先到者"同口径
        if (n > this.broadsideCount) {
          this.broadsideCount = n;
          this.broadsideEdge = edge;
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

  constructor(seed: number) {
    this.rng = new Rng(seed);
    this.enemies = new Pool<Enemy>(createEnemy, resetEnemy);
    this.bullets = new Pool<Bullet>(createBullet, resetBullet);
    this.drops = new Pool<Drop>(createDrop, resetDrop);
    // HP 上限问 damage.hullMaxHp 而不是直接读 tuning:06 号的装甲舱("船体 HP +15")会把它变成
    // **甲板的派生量**,调用点今天就接好,届时 06 只需要把那个函数体填掉,World 一个字不用动。
    // 满血进场(hp = maxHp):createShip 里那份初值只是"船不进池"的兜底,真相以这一句为准
    this.ship.hp = this.ship.maxHp = hullMaxHp(this.deck);
  }

  /** 开局至今的秒数。HP 时间缩放(GDD §14)的唯一时间源:挂在 tick 上才与 checksum 同口径 */
  get elapsed(): number {
    return this.tick * SIM_DT;
  }

  /** 下一次升级所需残骸。只从 upgrades 派生,不单独进 checksum。 */
  get upgradeCost(): number {
    return economyUpgradeCost(this.upgrades);
  }

  /** 当前实际转向速率(°/s)= tuning 基础值 − 每个扩建占用格 1°/s。 */
  get turnRate(): number {
    return deckTurnRate(this.deck);
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
  private readonly burstPeek: BurstPeek = { etaSeconds: 0, offsetDeg: 0 };
  private readonly burstWarningOut = { etaSeconds: 0, dirRad: 0 };

  /**
   * 下一个侧压 burst 的预警读数(11 号罗盘的补课,HUD 预警箭头用):
   * etaSeconds = 还有几秒触发,dirRad = 世界系绝对角(脚本当前主压方向 + 脚本偏移,
   * 与罗盘回退路径同源)。没有待触发的 burst(段内已放完 / 脚本走完 / 压测旁路)返回 null。
   * 纯读取、零 rng、不进 checksum —— 它只是把脚本里本来就写着的事提前念给玩家听。
   * 返回的是整局复用的同一个对象,调用方当场读走,别跨帧存引用。
   */
  burstWarning(): { etaSeconds: number; dirRad: number } | null {
    if (tuning.stressSpawn || this.wave.done) return null;
    if (!peekNextBurst(this.wave, this.burstPeek)) return null;
    this.burstWarningOut.etaSeconds = this.burstPeek.etaSeconds;
    this.burstWarningOut.dirRad = this.wave.dirRad + this.burstPeek.offsetDeg * DEG2RAD;
    return this.burstWarningOut;
  }

  /**
   * @param cmd 本逻辑帧的输入(纯数据)。只读不缓存引用,调用方可以整局复用同一个对象;
   *   缺省 = 松手,让 world.step() 的既有调用方(单测、无头跑批)不必关心输入。
   *
   * 顺序定死(单测按此钉):**甲板派生量(邻接 buff + HP 上限)** → 船 → 出怪 →
   * 重建空间哈希 → 清 contacts / 清 broadside / edgePenalty 逐帧减 dt →
   * 敌人(镜像重投(在 px/py 存档之前,防插值拖影)→ 积分 + hitCd 递减 + 粗筛入 contacts)→
   * 炮管(含节流与开火)→ 子弹 → 残骸(磁吸与收取)→ 船体受击结算 →
   * 可视化事件老化 → 回收死者(含掉落)→ 局终判定 → 升级候选结算。
   * (地图无限,原"贴边夹取"一步已删,见 ENEMY_FALLBEHIND_RADIUS 那段。)
   * 甲板派生量排在**最前**(见下面那两句):这一帧的塔按最新的邻接加成开火、这一帧的撞击按最新的
   * 上限结算 —— 12 号拆掉一格甲板(setOccupied 清 supportType)后,加成与上限当帧就回落,
   * 而不是靠下一次放置才想起来重刷(06 号验收第三条"拆除即时移除"的落点就在这两句)。
   * 出怪排在建哈希之前,新生的敌人当帧就参与分离;
   * 炮管排在敌人循环**之后**:敌人本帧已经动完,塔瞄的就是本帧位置 ——
   * 反过来的话每座塔都恒定落后一帧,贴脸高速目标会永远被瞄在身后(04 号 issue);
   * 子弹排在炮管之后,于是本帧新出膛的弹当帧就走一步、px/py 停在炮口
   *(与"出怪排在建哈希之前、新生敌人当帧就动"同一条口径);
   * 残骸排在子弹之后、受击结算之前 —— 它是世界里会动的东西,该在这一帧的伤害账结清之前把自己走完;
   * 而它与子弹刻意**不**同口径:本帧新掉的那颗还没进池(掉落发生在帧尾的 reap),
   * 于是它当帧一步不动、px/py 停在敌人倒下的地方,下一帧才起吸 ——
   * 那正是玩家该读到的因果:先看见残骸掉在尸体上,再看见它飞过来;
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

    // 甲板的两样派生量在帧首统一刷,于是"这一帧"的塔与"这一帧"的撞击读到的都是最新的甲板。
    //
    // 邻接加成:sync 自带 revision 守卫,甲板没变时整帧 O(1)(见 sim/support.ts),
    // 故放在热路径上不心疼。放这里而不是只在 place 之后刷一次 —— 甲板还有 place 之外的改法
    // (12 号的 setOccupied 焊/拆),而那条路不该被迫记得来调一次 buff 重算。
    syncSupportBuffs(this.deck);
    // HP 上限同理是**甲板的派生量**(装甲舱 +15,damage.hullMaxHp):拆掉装甲舱的当帧就该回落,
    // 这正是 06 号验收第三条"拆除即时移除"要的即时性 —— place 里那一句只管得住"放下去"这一半。
    // 每帧现算而不是记个脏标记:hullMaxHp 是十来格的一遍加法,比维护第二个 revision 便宜得多。
    //
    // **只夹不涨**:上限回落时把 hp 压进新上限(否则拆掉装甲舱会留下一艘 hp > maxHp 的船,
    // 血条画出去满出来),但上限涨上去时 hp 一分不还 —— 装甲舱是船的规格,不是治疗
    // (与 place 里那句"这一局打下来的账一分不还"同一条口径)。
    // 不在这里判 shipDead:hp 已经是 0,夹取对它是恒等,多一个分支只是多一条要维护的路
    this.ship.maxHp = hullMaxHp(this.deck);
    if (this.ship.hp > this.ship.maxHp) this.ship.hp = this.ship.maxHp;

    // 船先动:敌人这一帧要追的是船的新位置,晚一帧追会让高速时的包夹肉眼可见地滞后。
    // 地图无限,船不再被任何边界夹取(原 WORLD_RADIUS 已删,理由见 ENEMY_FALLBEHIND_RADIUS 那段)
    const ship = this.ship;
    stepShip(ship, cmd.desiredHeading, SIM_DT, this.turnRate);

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
      // 正式流程在段边界停住:下一段的编号/预告已经可读，但它的第一只怪要等整备完成后再出生。
      stepWaves(this.wave, SIM_DT, this.rng, this.waveSink, true);
      if (this.wave.segment !== segmentBefore && !this.wave.done) {
        this.refitPending = true;
        this.refitWelded = false;
        openedRefit = true;
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
    // 粗筛半径 = 甲板外接圆(damage.ts 的唯一口径,随 12 号扩建一起长),体型那一项见下面 cr
    const contactR = deckOuterRadius(this.deck);

    this.contacts.length = 0;
    // broadside 与 contacts 同口径:逐帧重建的"这一帧发生了什么",在敌人循环之前就清干净,
    // 于是一帧都没塔开火时读到的是 -1/0,而不是上一帧的齐射(见字段注释)
    this.broadsideEdge = -1;
    this.broadsideCount = 0;
    for (let e = 0; e < this.edgeFires.length; e++) this.edgeFires[e] = 0;

    // 四舷惩罚逐帧减 dt、夹 0。排在结算(帧尾)**之前**:本帧新挨的那一下拿到的是完整的
    // hitPenaltyTime,不会当帧就被扣掉一个 dt(否则"0.5s 惩罚"实际只有 0.4833s,还差得刚好一帧)。
    // 夹 0 而不是让它跑成负数:负数会让 checksum 里这一项在整局没挨打的舷上无限发散,
    // 也会让 cellFireRateMul 的"严格 > 0 才罚"退化成一句废话
    for (let e = 0; e < this.edgePenalty.length; e++) {
      const left = this.edgePenalty[e]! - SIM_DT;
      this.edgePenalty[e] = left > 0 ? left : 0;
    }

    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i]!;

      // 无限地图的防风筝(理由全文见 ENEMY_FALLBEHIND_RADIUS):被甩开的敌人沿船心镜像重投。
      // 排在 px/py 存档**之前**,于是插值的两端都在新位置上 —— 不会有一帧横跨整张屏的拖影
      // (它本就在屏外,但 144Hz 插值的中间采样点可能扫进屏里)。
      // 只有 BH_SEEK/接近段的怪才可能落到这么远(驻留/冲锋的活动半径 ≤ 560),状态机不必复位。
      {
        const fdx = e.x - tx;
        const fdy = e.y - ty;
        const fd2 = fdx * fdx + fdy * fdy;
        if (fd2 > ENEMY_FALLBEHIND_RADIUS * ENEMY_FALLBEHIND_RADIUS) {
          const fd = Math.sqrt(fd2);
          const k = -ENEMY_REJOIN_RADIUS / fd;
          e.x = tx + fdx * k;
          e.y = ty + fdy * k;
          // 重投也是一次"压力从这个方向来"的既成事实,照出怪那样喂给威胁罗盘(方向 = 新落点方位
          // = 旧方位取反)。不喂的话,玩家背对主压方向持续逃跑时,慢速主压流全部被镜像到航向
          // 正前方,罗盘却仍指着身后的脚本方位 —— HUD 读数与实际来向长期相反。
          // 只喂方向不喂 threatRate:强度读数的语义是"出怪速率",重投没有新增一只怪。
          // 与出怪样本同款零分配、零 rng,且威胁统计不进 checksum,确定性不受影响
          this.threatDirX += (-fdx / fd) * THREAT_SPAWN_IMPULSE;
          this.threatDirY += (-fdy / fd) * THREAT_SPAWN_IMPULSE;
        }
      }

      e.px = e.x;
      e.py = e.y;
      const isBoss = e.kind === KIND_BOSS;

      // 无敌帧逐帧减 dt、夹 0(与 edgePenalty 同口径)。**每只敌人各自一份**:
      // 全船一个冷却的话,蜂群贴脸时只有最先判到的那一只咬得动,"一百只压上来"与"一只压上来"
      // 的掉血速率会一模一样(见 Enemy.hitCd 的字段注释)。Boss 与普通怪同一条冷却。
      if (e.hitCd > 0) e.hitCd = Math.max(0, e.hitCd - SIM_DT);

      // 行为只给"期望速度 + 追随系数",位置由这里积分(sim/enemy 不碰位置)。
      // Boss 走自己的状态机(sim/boss.ts,寻路原语与普通怪同源:seek/lockCharge),
      // 契约与 stepEnemyBehavior 完全一致 —— 下面的积分一行都不分叉。
      const follow = isBoss
        ? stepBossBehavior(e, ship, SIM_DT, desired)
        : stepEnemyBehavior(e, ship, SIM_DT, desired);
      let dvx = desired.x;
      let dvy = desired.y;

      // 邻居分离**只在接近段**叠加:前摇/冲刺/硬直期间被同伴推离锁定直线,
      // 直线冲锋就不再是直线 —— 前摇预警画出的那条线会变成谎言(07 验收标准第二条)。
      // 分离半径用全局 tuning.enemySeparation 而不做成 per-kind:它是人群的物理常量,
      // 且必须守住"查询半径 ≤ 一个 cell"的性能口径(GDD §13)。
      // Boss 的 state 恒 ≠ ST_APPROACH,走不到这里 —— 巨型个体不被虫群推挤。
      if (sep > 0 && e.state === ST_APPROACH) {
        const def = ENEMIES[e.kind]!;
        const speed = def.speed * speedScale;
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

      // 粗筛:甲板外接圆 + 敌人体型。只登记,不扣血、不弹开、不消灭 ——
      // 三层判定(核心区/甲板轮廓/没碰上)与结算全在帧尾的 settleHullDamage 一处做完,
      // 这里多做一步都会跟它打架(而且要在 1000 敌的热循环里重复付核心/稀疏轮廓判定的钱)。
      //
      // 体型那一项乘 √2 而不是直接加 radius:精筛把核心/每个甲板格按体型**两轴各外扩** radius,
      // 扩出的角点距离会比原外接半径 + r 更远 —— 只加 r 会在甲板格四角漏掉一小片真擦碰,
      // 而粗筛漏掉的人这一帧就彻底结算不到(名单是超集才有意义)。
      // R + r√2 是它的紧上界(hypot(半长+r, 半宽+r) ≤ hypot(半长, 半宽) + hypot(r, r)),
      // 代价只是一次乘法 —— 逐只现算精确外接半径要一次开方,那才是 1000 敌热循环里付不起的钱
      const cdx = e.x - tx;
      const cdy = e.y - ty;
      // 体型那一项走 enemyRadius(精英 ×ELITE.scale);Boss 走 bossRadius()(15 号:
      // 它不进 ENEMIES 表,判定体单独一份口径,与 sim/boss.ts 的 bossRadius 同源)。
      // 粗筛圆的半径口径全仓只有这两份来源,别处不许另抄
      const cr = contactR + (isBoss ? bossRadius() : enemyRadius(e)) * Math.SQRT2;
      if (cdx * cdx + cdy * cdy < cr * cr) this.contacts.push(e);
    }

    // 炮管:朝射界内最近的敌人转,没得打就归位(04 号 issue),够得着又转得过来就开火(05 号)。
    // 传 this.grid 而不是 enemies:1000 敌 × 十座塔的线性扫描是 GDD §13 明令要用哈希避开的那件事;
    // 传 this.sink 而不是 this:开火侧只认识 FireSink 那份契约,永远不认识 World(见 sim/fx.ts);
    // 传 this.edgePenalty:被撞舷的塔在惩罚期内变慢(09 号 §4.6),逐塔归属由 damage.cellFireRateMul 定
    stepTurrets(this.deck, ship, this.grid, SIM_DT, this.sink, this.edgePenalty);

    // 子弹:积分 → 命中 → 迫击炮到期在落点炸 AoE(规则全在 sim/bullet.ts,本文件只给它一个 sink)
    stepBullets(this.bullets, SIM_DT, this.sink);

    // 残骸:起吸 → 匀速直追 → 收取,收到多少当帧进账(规则全在 sim/drop.ts,这里只给它池、甲板与船心)。
    // 船心传的是本帧**积分之后**的位置:残骸追的是船现在在哪 ——
    // 晚一帧的话,高速航行时整串残骸会恒定拖在船身后(与出怪环以船本帧位置为心同一条理由)。
    // 甲板也传进去:起吸半径是**甲板的派生量**(drop.magnetRadius),
    // GDD §5.3 的磁力收集器届时只填那个函数体,本行一个字都不用改;
    // magnetMul 是帧首扫出来的磁力干扰修正(14 号:携带者在场 → 拾取半径 ×pickupMul)
    this.scrap += stepDrops(this.drops, this.deck, ship.x, ship.y, SIM_DT, magnetMul);

    // 船体受击结算:粗筛名单 → 三层判定 → 扣血/出火花(顺序理由见块注释与 settleHullDamage)
    this.settleHullDamage();

    // 可视化事件老化。倒序 swap-remove(与 reap 同一个下标坑);它纯是表现,不参与任何判定,
    // 故老化排在开火之后、回收之前的哪一步都无所谓 —— 唯一要紧的是每帧只走一次
    const fx = this.fx.items;
    for (let i = fx.length - 1; i >= 0; i--) {
      const e = fx[i]!;
      e.life -= SIM_DT;
      if (e.life <= 0) this.fx.despawnAt(i);
    }

    this.reap();

    // 局终判定收尾:这一帧的判据(shipDead 在受击结算里置、wave.done 在帧首的出怪那一步置、
    // bossPhase 与 kills 在 reap 里才落账)到这里才全部就位。判完世界也不停 ——
    // 停不停是 main.ts 的事
    this.settleOutcome();

    // 同一帧若沉船/通关，结算优先，不能在结算面板下面再弹一层整备。
    if (openedRefit) {
      if (this.result === RESULT_RUNNING) this.onRefitOffer?.(this.wave.segment);
      else {
        this.refitPending = false;
        this.refitWelded = false;
      }
    }

    // 经济是帧尾最后一步:本帧刚收到的残骸已经进账、胜负也已经定完。
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
   * 三类都没有合法项时 rollUpgradeOffer 返回 0:当场按「跳过」结算并且**不响回调** ——
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
    // 战斗内升级只在现有甲板上新增/强化炮塔与支援；甲板拼块专属于两分钟整备。
    if (rollUpgradeOffer(this.deck, this.rng, this.offer, false) === 0) {
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
   * 第 0 级费用若低于返还额,跳过最多只是免单,绝不能净赚残骸并立刻再弹一张。
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
      // 死亡爆点(畅玩性调整):坐标/半径在回池前当场读走(与 spawnDrop 同口径)。
      // 借 sink.fx 走 FxEvent 的唯一生命周期路径;towerType 一格借放敌型下标,
      // 渲染层照它取 enemyTint 配色(见 sim/fx.ts 的 FXV_KILL)。纯表现、零 rng、不进 checksum。
      // Boss 的爆点半径走 bossRadius()(它不进 ENEMIES 表,enemyTint 对越界 kind 有兜底)
      this.sink.fx(
        FXV_KILL,
        e.x,
        e.y,
        e.x,
        e.y,
        e.kind === KIND_BOSS ? bossRadius() : enemyRadius(e),
        e.kind,
      );
      // 掉落排在公开挂钩**之前**:先把世界自己的账落地(残骸是这一局的成长资源,不是一段表现),
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
   * 16 号起它同时管两本账:
   *   **精英 / Boss = 星币**(GDD §7):击杀当场 `starCoins += 面额`,**不造掉落物** ——
   *     14/15 的"3×/4× 残骸"就是星币的占位(两处注释的"16 号星币落地前就是它"正是这个意思),
   *     落地后整体替换,星币没有"掉在地上捡不到"的问题,也不占 DROP_MAX_ALIVE、不走磁吸;
   *   **普通怪 = 基础残骸掉落物**(data/enemies 的整数 scrap)。
   * 两条路都**一次 rng 都不掷**:每只必掉、面额按型定死 ——
   * 于是战斗打得好不好(死了几只、什么时候死)反过来扰动不到出怪的随机序列,
   * 08 号那条"同 seed 同出怪序列"照旧成立。
   *
   * 残骸掉落物:速度不填,池里取出来的那颗刚走过 resetDrop,vx/vy = 0 就是"停在尸体上等人来捡";
   * 面额 ≤ 0 的型**不掉**(数值表允许 0,见 enemies.test.ts 的表级不变量):
   * 一颗看得见却给不了任何东西的残骸只会骗玩家专程绕一趟,还白占着下面那道保险丝的名额;
   * 触到在场上限就**丢弃这一颗、不留账**(与 spawnFromWave 那句一字同源):
   * DROP_MAX_ALIVE 是保险丝不是旋钮,理由全文见 data/economy.ts。
   * (星币那条路没有保险丝:它直接进账,根本不经过掉落物池。)
   */
  private spawnDrop(e: Enemy): void {
    if (e.kind === KIND_BOSS) {
      this.starCoins += BOSS.starCoins;
      return;
    }
    if (e.affixes !== 0) {
      // 精英(14 号 → 16 号)= 固定星币面额:零 rng、掉的就是"这一只"的,不会被普通掉落顶替
      this.starCoins += ELITE.starCoins;
      return;
    }
    const value = ENEMIES[e.kind]!.scrap;
    if (value <= 0 || this.drops.size >= DROP_MAX_ALIVE) return;
    const d = this.drops.spawn();
    d.x = d.px = e.x;
    d.y = d.py = e.y;
    d.value = value;
  }

  /**
   * 本帧的船体受击结算 —— 三层判定(核心区 / 甲板轮廓 / 没碰上)与扣血**全仓只有这一处**。
   * 只走 contacts 那份粗筛名单:精筛是"转回局部系 + 固定核心 + 稀疏 occupied 格",给全场 1000 只人手来一遍
   * 是白付的钱,而粗筛圆罩得住两层判定的全部范围(半径怎么取见敌人循环里那段 √2 的说明)。
   *
   * 撞完**不击退、不消灭敌人、不改它的状态机**:VS 式的贴脸就是"它压在那儿继续磨",
   * 弹开会把蜂群贴脸变成一件物理玩具,而 GDD §4.6 要的是一条稳定可读的掉血曲线。
   * 伤害与火花**共用同一个冷却**(e.hitCd):于是每只敌人每 enemyHitInterval 最多产出一个事件,
   * 蜂群贴脸也刷不爆 fx 池;掉血速率则由 enemyHitInterval × contactDamage × 全局倍率三根旋钮定死
   *(验收标准第一条"一次接触只结算一次、蜂群贴脸掉血速率可控可调"说的就是这件事)。
   */
  private settleHullDamage(): void {
    // 船沉了就一切停手。伤害那一半本来就被 damageShip 的首句挡着,漏的是**表现**这一半:
    // 不挡的话尸体上还会一路冒火花与撞击圆环,而结算界面背后那张静止的战场看着仍在挨打。
    // 顺带也省了尸体上那一圈没有任何后果的精筛(蜂群贴脸时是几十次矩形判定)
    if (this.shipDead) return;
    const ship = this.ship;
    const deck = this.deck;
    const scale = tuning.enemyContactDamageScale;
    for (let i = 0; i < this.contacts.length; i++) {
      const e = this.contacts[i]!;
      // 本帧刚被塔打死的敌人不许再咬一口 —— 这一句之所以有意义,全靠结算排在子弹之后
      if (e.dead) continue;
      const isBoss = e.kind === KIND_BOSS;
      // 体型与伤害口径:Boss 走 sim/boss.ts 的 bossRadius / bossContactDamage
      //(大质量撞击伤害更高 = 数值换倍率,判定几何仍是 09 号那一套,不新开机制);
      // 普通怪照旧走 enemyRadius(精英 ×ELITE.scale)与 ENEMIES 表的 contactDamage
      const hit = classifyHit(ship, deck, e.x, e.y, isBoss ? bossRadius() : enemyRadius(e));
      // 粗筛名单是超集,一层都没碰上的直接放过;冷却没走完的连火花都不出(免得"没伤害的擦碰"
      // 每帧刷一个事件,把 fx 池当烟花放)
      if (hit === HIT_NONE || e.hitCd > 0) continue;
      e.hitCd = tuning.enemyHitInterval;

      if (hit === HIT_CORE) {
        this.damageShip(
          (isBoss ? bossContactDamage() : ENEMIES[e.kind]!.contactDamage) * scale,
          e.x,
          e.y,
        );
        this.pushHitFx(FXV_HULL_HIT, e.x, e.y);
      } else {
        // 蹭到核心区之外的甲板:**只出火花,一分血都不结算**(GDD §4.4)。
        // classifyHit 先判核心后判轮廓,所以核心区里的敌人永远走不进这一支
        this.pushHitFx(FXV_SPARK, e.x, e.y);
      }
    }
  }

  /**
   * 挨打的可视化事件入池。借 sink.fx 而不是在这里再写一遍取池/填字段/取 life ——
   * FxEvent 的生命周期全仓只该有一条路径(fxLife 的口径也才不会分裂)。
   * 起点终点同点、半径 0:这两种表现都画在**接触点**上(见 renderer 的 FXV_SPARK / FXV_HULL_HIT);
   * towerType 填 0 只是占位 —— 挨打不是任何一座塔打出来的,渲染层对这两种 kind 也不读它。
   */
  private pushHitFx(kind: number, x: number, y: number): void {
    this.sink.fx(kind, x, y, x, y, 0, 0);
  }

  /**
   * 船体受伤的**唯一入口**:碰撞结算(settleHullDamage)走它,而它同时就是
   * **敌方弹幕伤害的接口预留** —— MVP 没有远程敌,故本轮不造弹丸、不加敌方子弹池、
   * 不给 EnemyDef 加远程字段;将来那一发打到船上,调的还是这一个方法。
   *
   * @param amount 伤害量(调用方已乘过全局倍率)。≤ 0 一律不算数:
   *   否则"零伤害的接触"也会把那一舷刷成闪红 + 射速惩罚,反馈就成了噪音
   * @param x @param y 接触点世界坐标 —— 撞的是哪一舷由它相对**船头**的方位角定(damage.hitBroadside),
   *   而不是由敌人是谁定:同一只敌人绕到船尾再撞,闪的就该是船尾
   * @returns 本次是否真的扣到血(船已沉 / amount ≤ 0 → false)
   */
  damageShip(amount: number, x: number, y: number): boolean {
    // 已沉就一切停手:这一句同时保证了 onShipDestroyed 只可能响一次(与 applyDamage 的
    // "同帧重复致命只算一次"同一条口径),08 号的失败流程不必自己去重
    if (this.shipDead || amount <= 0) return false;

    const edge = hitBroadside(this.ship, x, y);
    // 舷向减伤是 06 号装甲舱("所在舷受撞伤害 -20%")的挂钩,MVP 恒返回 1 —— 调用点今天就接好
    const dealt = amount * edgeDamageMul(this.deck, edge);
    this.ship.hp = Math.max(0, this.ship.hp - dealt);

    // **惩罚不可叠加延长**(验收标准第三条):已经在挨罚就不再把计时推回 0.5s ——
    // 每次受击都重置的话,蜂群贴脸就是一条常亮的红边 + 永不恢复的射速,正是那条要避开的死亡螺旋。
    // 闪红读的是同一个计时器,于是"闪红"与"射速惩罚"天然同窗口、不可能差一帧
    if (this.edgePenalty[edge]! <= 0) this.edgePenalty[edge] = tuning.hitPenaltyTime;

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
  damageEnemy(e: Enemy, amount: number, throttle?: number): boolean {
    // 抗性判定挂在伤害结算的唯一入口,与塔的节流(throttle)字段对齐 —— 不另造伤害类型体系
    // (todos/14 口径:装甲 = 弹药系、相位 = 过热/充能系)。乘出来的仍是"这一发实际造成的伤害"
    if (throttle !== undefined && e.affixes !== 0) {
      if (throttle === THR_AMMO && hasAffix(e, AFFIX_ARMORED)) {
        amount *= AFFIXES[AFFIX_ARMORED]!.ballisticMul;
      } else if ((throttle === THR_HEAT || throttle === THR_CHARGE) && hasAffix(e, AFFIX_PHASED)) {
        amount *= AFFIXES[AFFIX_PHASED]!.energyMul;
      }
    }
    return applyDamage(e, amount);
  }

  /**
   * 结算一张候选到指定格。候选 → 内容码/型号的翻译只走 sim/upgrade 那三个函数,
   * 真正放置仍走 this.place 这唯一入口;只有 PLACE_OK / PLACE_UPGRADE 才扣费并清空候选。
   * 被拒时残骸、升级次数与 offer 一个字段都不动,玩家可以换格或退回重选。
   */
  takeUpgrade(choice: number, col: number, row: number, rotation: number = 0): number {
    const opt = this.offer[choice];
    if (!opt) return UPGRADE_NO_OFFER;
    if (opt.kind === OFFER_DECK) {
      const code = this.weld(opt.type, rotation, col, row);
      if (isWeldSuccess(code)) this.completeUpgrade(0);
      return code;
    }
    const code = this.place(
      col,
      row,
      optionContent(opt),
      optionTowerType(opt),
      optionSupportType(opt),
    );
    if (isPlaceSuccess(code)) this.completeUpgrade(0);
    return code;
  }

  /** 拼块焊接的 World 入口:原子改拓扑后，当场同步 online / 邻接 / HP 上限。 */
  weld(pieceType: number, rotation: number, col: number, row: number): number {
    const code = weldPiece(this.deck, pieceType, rotation, col, row);
    if (isWeldSuccess(code)) {
      syncSupportBuffs(this.deck);
      this.ship.maxHp = hullMaxHp(this.deck);
      if (this.ship.hp > this.ship.maxHp) this.ship.hp = this.ship.maxHp;
    }
    return code;
  }

  /** 整备期每轮最多焊一块甲板；普通战斗升级不会生成 OFFER_DECK。 */
  weldRefitPiece(pieceType: number, rotation: number, col: number, row: number): number {
    if (!this.refitPending) return REFIT_NOT_ACTIVE;
    if (this.refitWelded) return REFIT_ALREADY_WELDED;
    const code = this.weld(pieceType, rotation, col, row);
    if (isWeldSuccess(code)) this.refitWelded = true;
    return code;
  }

  /** 整备期搬运现有炮塔/支援；运行期状态由 deck.moveModule 原样随模块移动。 */
  moveRefitModule(fromCol: number, fromRow: number, toCol: number, toRow: number): number {
    if (!this.refitPending) return REFIT_NOT_ACTIVE;
    const code = moveModule(this.deck, fromCol, fromRow, toCol, toRow);
    if (code === MOVE_OK) {
      syncSupportBuffs(this.deck);
      this.ship.maxHp = hullMaxHp(this.deck);
      if (this.ship.hp > this.ship.maxHp) this.ship.hp = this.ship.maxHp;
    }
    return code;
  }

  /** 完成本轮整备并放行下一航段；余额保留，但至少 5 秒内不连续弹普通升级。 */
  completeRefit(): boolean {
    if (!this.refitPending) return false;
    this.refitPending = false;
    this.refitWelded = false;
    this.offerCooldown = Math.max(this.offerCooldown, UPGRADE_OFFER_COOLDOWN);
    return true;
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
   * 通过校验后:扣 REROLL_PRICE 星币 → 再次调 rollUpgradeOffer(deck, rng, offer, false)
   * 重掷三个候选位 —— 自动继承它那套定死的 2×UPGRADE_CHOICE_COUNT 次 rng 消耗与
   * optionHasLegalPlacement 过滤(重摇后的卡同样放不下就出不来),rng 口径与首掷完全相同,
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
    return rollUpgradeOffer(this.deck, this.rng, this.offer, false);
  }

  /**
   * 全仓唯一的放置入口(与 damageEnemy 同口径:规则在 sim/deck,World 只转发)。
   * @param towerType content = CELL_WEAPON 时的塔型;缺省 = 自动机炮(GDD §5.2 的万金油),
   *   于是既有的三参调用方语义原样成立。往已有**同种**塔的格上再放一座 = 同名叠级
   *   (PLACE_UPGRADE,GDD §5.4),换塔型/换内容仍然是 PLACE_TAKEN —— 规则全在 sim/deck,这里不复述。
   * @param supportType content = CELL_SUPPORT 时的设施型;缺省 = 弹药库(GDD §4.3 的"弹药库先行"),
   *   于是既有的三/四参调用方语义同样原样成立。两套编号各管各的一半、绝不合并 ——
   *   0 在两边分别是自动机炮与弹药库,理由全文见 sim/deck 的 canPlace。
   * @returns PLACE_* 理由码;被拒时世界一个字段都没动,ui 层照码说人话(成功判定用 isPlaceSuccess)
   *
   * 灰盒/测试直接调用它仍属于 step() 之外的外部修改,之后的 checksum 不再与"同 seed 从头跑"可比;
   * 正式流程只从 takeUpgrade 进来,选择与格子就是那一帧的玩家输入,可被回放层记录。
   */
  place(
    col: number,
    row: number,
    content: number,
    towerType: number = TOWER_AUTOCANNON,
    supportType: number = SUP_AMMO_BAY,
  ): number {
    const code = placeAt(this.deck, col, row, content, towerType, supportType);
    // 放置成功就重刷上限:HP 上限从设计上就是**甲板的派生量**(06 号的装甲舱 +15)。
    // hullMaxHp 当场遍历 cells、不读任何缓存,故这一句放下去当帧就是新的上限。
    // **hp 不跟着涨**:上限是船的规格,当前 HP 是这一局打下来的账 —— 装一块装甲舱不该顺手治疗。
    // 被拒的放置一个字段都没动(见 sim/deck),自然也不必重刷
    if (isPlaceSuccess(code)) {
      this.ship.maxHp = hullMaxHp(this.deck);
      // 邻接加成也当场重算,不等下一帧的 step:放置发生在 step **之外**(ui 的一次点击),
      // 而 10 号的"三选一 → 时停 → 放置"里时间是停的 —— 那时不补这一句,玩家就会看见
      // 一块焊好的弹药库连着一门一动不动的机炮,直到时停结束才突然提速。
      // 它自己带 revision 守卫,故与帧首那次 sync 重复调用是 O(1),不必怕多算一遍
      syncSupportBuffs(this.deck);
    }
    return code;
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
    let boss: Enemy | null = null;
    for (let i = 0; i < this.enemies.items.length; i++) {
      const e = this.enemies.items[i]!;
      if (e.kind === KIND_BOSS) {
        boss = e;
        break;
      }
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
    //   maxHp = damage.hullMaxHp(deck),而甲板本身下面逐格哈过了 —— 哈它就是把同一件事哈两遍;
    //   shipDead 除了"hp 归零那一刻置位"没有第二条来路,hp 已经进来了,它就没有独立信息;
    //   result 又是 shipDead / wave.done / bossPhase 的纯函数(settleOutcome 只读这三样;
    //   bossPhase 在下面单独哈过),同理没有独立信息。
    acc(this.ship.hp);
    // 甲板紧跟着船:build 也是世界状态,少了它,"塔放错格"或"扩建没同步"这类回归会从确定性口径下漏掉。
    // 顺序 = deck.cells 的下标顺序(row-major,见 sim/deck),与渲染遍历同一条,永不改;
    // exposed/online 是 occupied 的派生量,进哈希只是把同一件事哈两遍,故跳过。
    // turretOffset 则**不是**派生量,而是逐帧追瞄/归位演化出来的状态(04 号 issue):
    // 漏了它,"塔瞄错方向"这类回归就从确定性口径下漏掉,而它恰恰是 05 号开火方向的唯一依据。
    // 换算成度的理由与 heading 那句一致 —— Math.round(v*8) 对弧度太粗。
    //
    // 塔的运行期状态(05 号 issue)与 turretOffset 同理:冷却/弹夹/装填/热量/过热锁/充能
    // **全是逐帧演化出来的状态,不是派生量**,漏了它们,"某座塔的装填提前了一帧"这类分叉
    // 就从确定性口径下漏掉了 —— 而节流状态恰恰决定了下一帧谁开火。
    // cooldown/reloadLeft/coolLock/charge × 100 的理由与"弧度换算成度"同源:
    // Math.round(v * 8) 对 0..1 量级的秒数/进度太粗(量化步长 0.125),抓不住一两帧的差别
    //
    // 支援设施的**型号**(06 号)与 towerType 同理是一次放置定死的世界状态,不是派生量:
    // 漏了它,"该放弹药库却放成了散热器"这类回归会从确定性口径下漏掉 —— 而两者对同一门炮
    // 一个提速一个不提速,下一帧谁开火就此不同。而那四个**邻接 buff 缓存与 buffRevision 一律不进**:
    // 它们是 occupied/content/supportType/towerType/online 的纯函数(recomputeSupportBuffs 每次
    // 全甲板重算,没有第二条来路),而这几样上下逐格全哈过了 —— 哈缓存只是把同一件事哈两遍,
    // 与 exposed/online 跳过是同一条理由
    for (const c of this.deck.cells) {
      acc(c.col);
      acc(c.row);
      acc(c.occupied ? 1 : 0);
      acc(c.content);
      acc(c.supportType);
      acc((c.turretOffset * 180) / Math.PI);
      acc(c.towerType);
      acc(c.level);
      acc(c.cooldown * 100);
      acc(c.ammo);
      acc(c.reloadLeft * 100);
      // 与同组另外四项一样放大 100 倍:acc 内部量化到 1/8,不放大的话热量分辨率只有 0.125,
      // 而电弧塔一帧的降温量(coolPerSec/60)比这还小 —— 差一帧的热量会从确定性口径下漏掉
      acc(c.heat * 100);
      acc(c.coolLock * 100);
      acc(c.charge * 100);
    }
    // 四舷惩罚剩余秒紧跟着甲板:它是逐帧演化出来的状态(受击置位 + 每帧减 dt),不是任何东西的派生量 ——
    // 漏了它,"某一舷的射速惩罚早退了一帧"这类分叉就从确定性口径下漏掉,而它恰恰决定了下一帧谁打得快。
    // × 100 的理由与冷却/装填/热量那批秒数字段一字同源:acc 内部量化到 1/8,不放大的话
    // 0.5s 量级的计时器分辨率只有 0.125,差一两帧根本看不出来
    for (let e = 0; e < this.edgePenalty.length; e++) acc(this.edgePenalty[e]! * 100);
    // 波次进度紧跟着四舷惩罚(08 号):它是这一局的推进进度,逐帧演化(段内计时 → 段推进 → 逐流的出怪账),
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
    }
    // 子弹**只哈位置**:伤害/存活/穿透都是发射那一刻定死的常量(见 sim/bullet.ts),
    // 而位置已经能抓住任何弹道分叉 —— 多哈几个不会变的数只是把同一件事哈好几遍。
    for (const b of this.bullets.items) {
      acc(b.x);
      acc(b.y);
    }
    // 残骸紧跟着子弹,而且同样**只哈位置**,理由也是同一条:value 是掉落那一刻按敌型定死的常量
    //(与子弹的 damage 一样,飞行途中绝不会变);magnet 是只从 false 变 true 的单向锁,
    // 它一旦不同,下一帧的位置立刻就分开了(锁住的每帧朝船走一步,没锁的停在原地)——
    // 位置这一项已经抓得住,多哈几个不会变的数只是把同一件事哈好几遍。
    for (const d of this.drops.items) {
      acc(d.x);
      acc(d.y);
    }
    // 收下的残骸当场出池,故池里再也找不到它 —— 这一笔账必须单独进哈希,
    // 否则"磁吸多收了一颗/漏收了一颗"这类回归在场上残骸清空之后就彻底看不见了。
    // 整数,**不放大**:acc 内部量化到 1/8,整数原样进去分毫不差(与坐标那批放大是两回事)
    acc(this.scrap);
    // 升级次数与候选紧跟残骸经济账。upgradeCost 不进:它是 upgrades 的纯函数(data/economy.upgradeCost)。
    // offer 则必须进:它消耗了 rng、决定玩家能放什么,不是甲板或残骸的派生量;
    // 漏了它,"同 seed 弹出不同三张卡"要等玩家选完、甲板分叉后才看得见。
    acc(this.upgrades);
    // 弹卡冷却是逐帧演化的真状态:它决定 rollUpgradeOffer **何时**消耗 rng,差一帧就是整条
    // 随机序列错位。× 100 的理由与 edgePenalty 那批秒数字段一字同源(量化到 1/8 抓不住单帧差)
    acc(this.offerCooldown * 100);
    acc(this.refitPending ? 1 : 0);
    acc(this.refitWelded ? 1 : 0);
    for (const opt of this.offer) {
      acc(opt.kind);
      acc(opt.type);
      acc(opt.level);
    }
    // 重摇次数限制(16 号)紧跟候选:它决定 rerollOffer **是否**再次消耗 2×count 次 rng,
    // 差一次就是整条随机序列错位 —— 照 offerCooldown 的先例进 checksum。
    // **starCoins 余额不进**:它只影响 UI 读数与消费、不参与任何判定;重摇消耗的 rng
    // 本身在序列里,余额只是那条序列的读数 —— 扣过费没有,序列照样逐位可复现
    // (与 maxHp 同一条"不进"的口径,理由全文见 starCoins 字段注释)。
    acc(this.offerRerolled ? 1 : 0);
    // FxEvent 一律**不进** checksum:它纯是表现(少画一条闪电不改变世界的下一帧),
    // 混进来只会让"渲染改一下淡出时长"看起来像一次确定性回归。broadside 同理是本帧的表现读数。
    return (h >>> 0).toString(16).padStart(8, '0');
  }
}
