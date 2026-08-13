/**
 * 武器塔数值表(05 号 issue T1)—— 纯数据 + 等级取值,只 import 同目录的 data/arcs。
 * 铁律:src/data 与 src/sim 一样永不 import pixi/DOM;**也永不 import sim/config** ——
 * 数据表是配置的上游,引回去就成环(全局倍率 towerDamageScale / towerFireRateScale 留在 tuning,
 * 由 sim/tower.ts 在取值时现乘,本文件一个字都不知道它们的存在)。
 * 于是本文件就是 05 号验收标准的那一条:**改本文件即可调平衡,不改一行逻辑代码**。
 *
 * 与 data/enemies.ts 同风格:
 *   数字常量而非 enum(热循环里 switch 分派最省事,isolatedModules 下 enum 也不划算);
 *   字段不加 readonly、不 Object.freeze —— 单测要临时改字段再 afterEach 还原,
 *     冻表会让"改数据即可调平衡"这条验收无从下手;
 *   **不用的字段一律填 0 并注明** —— 留着非 0 残值,渲染层的热量条就会对着一座弹药塔画。
 *
 * 每座塔四要素(GDD §5.1):伤害 / 射程 / 弧度 / 节流机制。
 * 弧度一律取 data/arcs 的**档位常量**而不是裸数字:GDD §4.2 那张表改一档,六塔跟着走同一个数。
 * 节流三选一(过热 / 弹药 / 充能)是 06 号支援设施的三个作用锚点,所以三套机制必须**机制上可区分**,
 * 不是同一个冷却换三种皮 —— 各塔用哪一套写在 throttle 字段,状态机在 sim/tower.ts。
 *
 * 除自动机炮那一行是 GDD §14 锚点(逐字锁定,调平衡时不许顺手改)外,其余全部占位待调。
 */
import { ARC_MEDIUM_DEG, ARC_NARROW_DEG, ARC_VERY_NARROW_DEG, ARC_WIDE_DEG } from './arcs';

export const TOWER_AUTOCANNON = 0; // 自动机炮
export const TOWER_LASER = 1; // 激光棱镜
export const TOWER_ARC = 2; // 电弧塔
export const TOWER_RAILGUN = 3; // 磁轨炮
export const TOWER_PD = 4; // 点防阵列
export const TOWER_MORTAR = 5; // 等离子迫击炮

// —— 合成武器(用户设计会重写,取代 17 号旧"空间进化塔"):三合一升星合成
// (3× 同型 2★ → 合 3★ 的那一刻变身,data/merges.ts)的结果。编号 6..11 与 merges.ts 的配方
// 顺序**一一对应**(下标错位 = 配方张冠李戴,merges.test 钉着这条)。
// 每把合成武器的"签名"(三把拼一把买断的那条机制)写在对应塔的字段注释里,其余数值全部占位待调 ——
// 合成的判据与触发流程住在 sim/world.ts(World.fuseTriplesOf 合到 3★ 当场变身),本表只负责"变成什么"。
export const TOWER_STORM_CANNON = 6; // 3×自动机炮(合 3★)→ 风暴机炮(不再装填、双管齐射)
export const TOWER_AURORA = 7; // 3×激光棱镜(合 3★)→ 极光阵列(光束穿透、无过热)
export const TOWER_ANNIHILATION = 8; // 3×磁轨炮(合 3★)→ 湮灭长矛(全屏贯穿、充能更快)
export const TOWER_THUNDER = 9; // 3×电弧塔(合 3★)→ 雷霆王冠(链数翻倍)
export const TOWER_DELUGE = 10; // 3×迫击炮(合 3★)→ 焦土骤雨(三连发、落点更大)
export const TOWER_THORN = 11; // 3×点防(合 3★)→ 荆棘星幕(击落弹幕拦截旗子)

// —— 进阶塔(19 号 issue,GDD §10 的"只解锁内容"):条件式解锁后进三选一池。
// 不是进化塔(不在 evolutions.ts 的配方表里),isEvolutionTower(12) 恒 false ——
// 它走的是"解锁 → 入池"这条路,与进化塔的"配方 → 船坞"是两扇不同的闸门。
// 未解锁时由卡池过滤(sim/upgrade.ts 的 collectTypes,后续 issue 接线)挡在候选之外。
export const TOWER_MISSILE_NEST = 12; // 导弹巢(首次胜利解锁;弹药系迫击炮,见下)
export const TOWER_KIND_COUNT = 13;

/**
 * 星级上限(星级系统,取代旧 GDD §5.4 的同名叠级 Lv1→Lv5):1★ 起步,同型合成升星,最多 3★。
 * 2★ = 旧 Lv3 档数值 + burstAtLv3 机制跳变,3★ = 旧 Lv5 档 + pierceAtLv5 —— 换算见文件尾 starLevel。
 */
export const STAR_MAX = 3;

// —— 节流机制(GDD §5.1)。三档正是三条系限定法令的作用锚点,故编号与语义都不许合并 ——
export const THR_AMMO = 0; // 弹药:弹夹 + 装填 → 突发满速后**必然停火一段**
export const THR_HEAT = 1; // 过热:热量累积 + 强制冷却 → **点射就永不停火**,只罚贪连射
export const THR_CHARGE = 2; // 充能:蓄力满了才放 → 攒-放节奏,与射速旋钮无关

/** 节流系的中文名(下标 = THR_*;武器系标签与系限定法令作用域的单一来源,UI 不许再抄第二份) */
export const THROTTLE_NAMES = ['弹药系', '过热系', '充能系'] as const;

/** 节流系名字:越界(数值表被改坏)不抛,回落成可读的问号档 */
export function throttleName(throttle: number): string {
  return THROTTLE_NAMES[throttle] ?? '?';
}

// —— 开火表现 / 结算类型。sim/turret.ts 靠它 switch 分派,渲染层靠它选画法 ——
export const FX_BULLET = 0; // 直射弹(机炮、点防)→ 真子弹,飞行途中碰撞
export const FX_BEAM = 1; // 持续单体光束(激光)→ 瞬时判定
export const FX_CHAIN = 2; // 链式闪电(电弧)→ 瞬时判定,逐跳衰减
export const FX_LANCE = 3; // 穿透直线(磁轨)→ 瞬时线段判定
export const FX_MORTAR = 4; // 抛射 + 落点 AoE(迫击炮)→ 真子弹,途中不碰撞

/**
 * 可视化事件的存续秒数(sim/fx.ts 的 FxEvent.life 初值)。
 * 放在数值表里而不是渲染层:它决定的是"一次开火在屏幕上留多久",与色彩、线宽一样是可调的表现参数,
 * 而 World 每帧递减 life 是在 sim 里做的 —— 两边读同一个数才不会各算各的。
 * 四档按"这次开火有多重"排序:光束每 tick 一次、最轻最短;落点爆炸最重、留最久。
 *
 * 唯独光束这一档有个硬下界:它必须 **≥ 激光的 fireInterval**,否则两次伤害 tick 之间会有几帧
 * 一条光束都不在池里,画面上就成了 10Hz 频闪 —— 而"持续单体光束"正是它区别于其它五塔的那条
 * 表现通道(GDD §5.2)。取等于 fireInterval:再长就会在停火后拖一条不该有的尾巴。
 */
export const FX_LIFE_BEAM = 0.1; // = 激光 fireInterval,见上;占位待调
export const FX_LIFE_CHAIN = 0.12; // 占位待调
export const FX_LIFE_LANCE = 0.18; // 占位待调
export const FX_LIFE_BLAST = 0.25; // 占位待调

/**
 * 等级成长系数(GDD §5.4 的"数值成长")。
 * 乘法档一律**复利**:Lv N = base × m^(N-1) —— 与 GDD §14 的"升级所需残骸 10 × 1.25^级数"同形,
 * 于是"多贵 vs 多强"两条曲线可以直接对着比,不必换算。
 * 加法档(弹夹、链跳)刻意不用乘法:它们是**整数个**东西,乘出来的 20 × 1.3⁴ = 57.1 发没有意义,
 * 而"每级 +5 发"是玩家一眼能记住的承诺。
 *
 * 每座塔各带一份而不是全局共用一份:成长曲线本身就是塔的定位
 * (磁轨该在伤害上陡、点防该在弹夹上陡),共用一份等于把六塔的手感绑成一个旋钮。
 * **不用的乘法档填 1(= 无成长)而不是 0** —— 这里是本文件"不用就填 0"那条口径的唯一例外:
 * 0 作乘数是"归零",会把 2★ 的热上限直接抹成 0,与"这一档用不上"是两码事。
 * 口径仍是"按旧 Lv 步进"的每级数值:星级 getter 在 starLevel 里换算(2★→旧 Lv3、3★→旧 Lv5),
 * 本表一个数都不用重写。
 */
export interface TowerGrowth {
  damage: number; // 每旧级乘数(复利)
  fireRate: number; // 每旧级乘数;fireInterval = base / m^(N-1)
  range: number; // 每旧级乘数
  heatMax: number; // 每旧级乘数
  chargeRate: number; // 每旧级乘数;chargeTime = base / m^(N-1)
  magazine: number; // 每旧级**加法**(发),取整
  chain: number; // 每旧级**加法**(跳),取整
}

export interface TowerDef {
  /** 下标 === type,与 TOWER_* 一致;TOWERS[cell.towerType] 直取,错一位就全塔串味 */
  type: number;
  name: string;
  /** 射界弧度(度),取自 data/arcs 的档位常量。角落格 +60° 的加宽在 sim/arc.ts 上叠,不在这里 */
  arcDeg: number;
  range: number;
  /** 单次结算伤害;实际伤害还要乘 tuning.towerDamageScale 与等级成长(见 towerDamage) */
  damage: number;
  /** 秒/次。**充能系恒 0**:那类塔的节奏全由 chargeTime 决定,再压一层冷却就是两个旋钮打架 */
  fireInterval: number;
  /** 炮管转速 °/s(与 tuning.shipTurnRate 同单位口径),追瞄与归位共用 */
  turnRate: number;
  /**
   * 炮口与目标方位的夹角容差(度),超出不开火。
   * 这就是"塔转不过来就打不到"那层手感的唯一旋钮:转速慢 + 容差小 = 重炮打不了贴脸的快目标。
   */
  aimTolDeg: number;
  /** THR_* */
  throttle: number;
  // —— 弹药系(THR_AMMO);其余塔填 0 ——
  magazine: number;
  reload: number;
  // —— 过热系(THR_HEAT);其余塔填 0 ——
  heatPerShot: number;
  heatMax: number;
  coolPerSec: number;
  /** 过热到顶后的强制冷却秒数(期间一律不许开火) */
  overheatLock: number;
  // —— 充能系(THR_CHARGE);其余塔填 0 ——
  chargeTime: number;
  /** FX_* */
  fx: number;
  // —— FX_BULLET / FX_MORTAR 的弹道;其余塔填 0 ——
  bulletSpeed: number;
  bulletRadius: number;
  /** 基础穿透次数(Lv5 的跳变另计,见 pierceAtLv5) */
  pierce: number;
  // —— FX_CHAIN;其余塔填 0 ——
  /** 总命中数(含首目标) */
  chainCount: number;
  /** 每跳的搜索半径 */
  chainRange: number;
  /** 每跳伤害的衰减系数(< 1 才叫衰减) */
  chainFalloff: number;
  /** FX_LANCE 的线段半宽;其余塔填 0 */
  lanceWidth: number;
  // —— FX_MORTAR 的落点 AoE;其余塔填 0 ——
  aoeRadius: number;
  aoeDamage: number;
  /** 点防 true —— MVP 四敌均无弹幕(GDD §6),这就是那条"拦截弹幕接口预留" */
  interceptsProjectiles: boolean;
  /**
   * 每次开火**恒发几发**(进化塔签名:轨道火雨三连发 = 3);**0 = 恒 1 发**。
   * 与 burstAtLv3 正交:那是 Lv≥3 才出现的等级小跳变,这是"这塔天生一次打几发"
   * (17 号进化的轨道火雨,sim/turret.ts 的 fireMortar 读它)。
   */
  burst: number;
  /** Lv≥3 起每次开火发数(机炮双管 = 2);**0 = 无跳变,恒 1 发**(GDD §5.4) */
  burstAtLv3: number;
  /** Lv≥5 起额外穿透数(机炮曳光弹 = 1);0 = 无跳变(GDD §5.4) */
  pierceAtLv5: number;
  /** 渲染色。**一律冷色**(GDD §12:敌我色域完全分离),暖色只留给"拒绝/过热"这类小面积读数 */
  tint: number;
  growth: TowerGrowth;
}

/**
 * 下标 === type,顺序 机炮/激光/电弧/磁轨/点防/迫击炮 + 17 号六座进化塔(6..11,与 evolutions.ts
 * 配方顺序一一对应)+ 19 号进阶塔导弹巢(12,首次胜利解锁);sim 靠 TOWERS[cell.towerType] 直取
 */
export const TOWERS: TowerDef[] = [
  {
    type: TOWER_AUTOCANNON,
    name: '自动机炮',
    arcDeg: ARC_MEDIUM_DEG, // 中 100°(GDD §5.2)
    range: 380, // GDD §14 锁定
    damage: 6, // GDD §14 锁定
    fireInterval: 0.4, // GDD §14 锁定(= 2.5 发每秒)
    turnRate: 360, // 占位待调(= 04 号 tuning.turretTurnRate 的原值,手感基线原样接过来)
    aimTolDeg: 6, // 占位待调
    throttle: THR_AMMO, // 万金油的代价:突发满速后必然停火装填(GDD §5.2)
    magazine: 20, // GDD §14 锁定
    reload: 1.5, // GDD §14 锁定
    heatPerShot: 0,
    heatMax: 0,
    coolPerSec: 0,
    overheatLock: 0, // 非过热系,整段填 0
    chargeTime: 0, // 非充能系
    fx: FX_BULLET,
    bulletSpeed: 420, // 占位待调(= 01 号压测占位弹的 tuning.bulletSpeed,弹速手感原样接过来)
    bulletRadius: 3, // 占位待调
    pierce: 0, // 基础不穿透,Lv5 曳光弹才穿一层
    chainCount: 0,
    chainRange: 0,
    chainFalloff: 0, // 非链式
    lanceWidth: 0, // 非穿透线
    aoeRadius: 0,
    aoeDamage: 0, // 无 AoE
    interceptsProjectiles: false,
    burst: 0, // 非恒发塔
    burstAtLv3: 2, // GDD §5.4 举的例子:Lv3 双管
    pierceAtLv5: 1, // GDD §5.4 举的例子:Lv5 曳光弹
    tint: 0x66c2ff, // 占位待调(天蓝 = 最"标准"的一档冷色,主力塔占它)
    growth: {
      damage: 1.25, // 占位待调(Lv5 ≈ ×2.44)
      fireRate: 1.1, // 占位待调(Lv5 射速 ≈ ×1.46)
      range: 1.05, // 占位待调
      heatMax: 1,
      chargeRate: 1, // 不用的乘法档填 1 = 无成长
      magazine: 5, // 占位待调(Lv5 = 40 发)
      chain: 0,
    },
  },
  {
    type: TOWER_LASER,
    name: '激光棱镜',
    arcDeg: ARC_NARROW_DEG, // 窄 60°(GDD §5.2)
    range: 340, // 占位待调
    damage: 3, // 占位待调(每 tick;10Hz → 30 dps,"融精英"靠的是持续而不是单发)
    // "持续光束"= 10Hz 的单体伤害 tick + 一条每次开火续命的可视化:
    // 视觉连续、判定离散、确定性简单 —— 真做成 dps × dt 的连续积分,伤害就会跟着帧长漂
    fireInterval: 0.1, // 占位待调
    turnRate: 240, // 占位待调(比机炮沉:窄弧 + 慢转 = 得靠转船去喂它)
    aimTolDeg: 3, // 占位待调(光束最挑准头)
    throttle: THR_HEAT,
    magazine: 0,
    reload: 0, // 非弹药系
    heatPerShot: 1.6, // 占位待调
    heatMax: 24, // 占位待调(满速连射 24 / (16 - 8) = 3s 到顶)
    coolPerSec: 8, // 占位待调(半速点射 = 收支平衡 → 永不停火,这就是过热与弹药的分水岭)
    overheatLock: 2, // 占位待调
    chargeTime: 0, // 非充能系
    fx: FX_BEAM,
    bulletSpeed: 0,
    bulletRadius: 0,
    pierce: 0, // 瞬时判定,无弹丸
    chainCount: 0,
    chainRange: 0,
    chainFalloff: 0,
    lanceWidth: 0,
    aoeRadius: 0,
    aoeDamage: 0,
    interceptsProjectiles: false,
    burst: 0, // 非恒发塔
    burstAtLv3: 0,
    pierceAtLv5: 0, // 无 Lv3/Lv5 跳变(GDD §5.5 把"光束穿透"留给了相位切割者进化)
    tint: 0x3ff0e0, // 占位待调(高饱和青)
    growth: {
      damage: 1.28, // 占位待调(单体输出塔,伤害曲线最陡)
      // 射速档恒 1:0.1s 是"把持续伤害离散化"的口径,不是射速旋钮 ——
      // 调快它等于偷偷加 dps,还会让热量收支跟着变,升级效果就说不清了
      fireRate: 1,
      range: 1.06, // 占位待调
      heatMax: 1.18, // 占位待调(升级主要买"能连烧多久")
      chargeRate: 1,
      magazine: 0,
      chain: 0,
    },
  },
  {
    type: TOWER_ARC,
    name: '电弧塔',
    arcDeg: ARC_WIDE_DEG, // 广 150°(GDD §5.2)
    range: 260, // 占位待调(短程仍是它的代价,只比机炮的 68%,但不再是抽到即坏卡的 58%)
    damage: 7, // 占位待调(首跳伤害,之后逐跳 × chainFalloff)
    fireInterval: 0.55, // 占位待调(Lv1 单体 ≈ 12.7 DPS:仍不如机炮 15,但三目标 ≈ 27,清群定位成立)
    turnRate: 300, // 占位待调
    aimTolDeg: 12, // 占位待调(放电不挑准头,广弧塔的容差也该宽)
    throttle: THR_HEAT,
    magazine: 0,
    reload: 0,
    heatPerShot: 3, // 占位待调
    heatMax: 12, // 占位待调(满速连射净热 3/0.55 − 4 ≈ 1.45/s ⇒ ≈ 8.3s 到顶,与旧手感同档)
    coolPerSec: 4, // 占位待调(射速加快后同步抬,半速点射仍收支平衡 → 永不停火的分水岭不破)
    overheatLock: 1.6, // 占位待调
    chargeTime: 0,
    fx: FX_CHAIN,
    bulletSpeed: 0,
    bulletRadius: 0,
    pierce: 0,
    chainCount: 3, // 占位待调(含首目标;Lv1 即 2 跳 —— "清蜂群"的定位从 Lv2 才成立提前到开箱可用)
    chainRange: 130, // 占位待调(每跳的搜索半径,小于射程 = 只在扎堆处才连得起来)
    chainFalloff: 0.7, // 占位待调
    lanceWidth: 0,
    aoeRadius: 0,
    aoeDamage: 0,
    interceptsProjectiles: false,
    burst: 0, // 非恒发塔
    burstAtLv3: 0,
    pierceAtLv5: 0,
    tint: 0x8ae8ff, // 占位待调(最亮的一档电白蓝)
    growth: {
      damage: 1.2, // 占位待调
      fireRate: 1.08, // 占位待调
      range: 1.05, // 占位待调
      heatMax: 1.15, // 占位待调
      chargeRate: 1,
      magazine: 0,
      chain: 1, // 占位待调(每级 +1 跳:玩家一眼记得住的承诺)
    },
  },
  {
    type: TOWER_RAILGUN,
    name: '磁轨炮',
    arcDeg: ARC_VERY_NARROW_DEG, // 极窄 30°(GDD §5.2:轴线艺术)
    range: 700, // 占位待调(全场最远,换极窄弧)
    damage: 45, // 占位待调(线上全员吃满,不衰减)
    // 充能系恒 0:节奏全由 chargeTime 给。再压一层冷却,两个旋钮就会打架
    fireInterval: 0,
    turnRate: 120, // 占位待调(最沉的炮管:想让它开火基本得把船摆正)
    aimTolDeg: 2, // 占位待调(极窄弧的塔容差也极小)
    throttle: THR_CHARGE,
    magazine: 0,
    reload: 0,
    heatPerShot: 0,
    heatMax: 0,
    coolPerSec: 0,
    overheatLock: 0,
    chargeTime: 2.4, // 占位待调(攒-放的全部节奏)
    fx: FX_LANCE, // 瞬时线段判定 —— 60Hz 下一帧走两千 px 的高速弹必然隧穿
    bulletSpeed: 0,
    bulletRadius: 0,
    pierce: 0, // 线上全员命中,不走弹丸的穿透计数
    chainCount: 0,
    chainRange: 0,
    chainFalloff: 0,
    lanceWidth: 6, // 占位待调(线段半宽,与敌人半径相加后判定)
    aoeRadius: 0,
    aoeDamage: 0,
    interceptsProjectiles: false,
    burst: 0, // 非恒发塔
    burstAtLv3: 0,
    pierceAtLv5: 0,
    tint: 0x6c7cff, // 占位待调(最深的一档靛蓝)
    growth: {
      damage: 1.3, // 占位待调(爆发塔,伤害曲线最陡)
      fireRate: 1, // 恒 1:充能系的 fireInterval 本就是 0,成长全给 chargeRate
      range: 1.06, // 占位待调
      heatMax: 1,
      chargeRate: 1.12, // 占位待调(Lv5 充能 ≈ 快 1.57 倍)
      magazine: 0,
      chain: 0,
    },
  },
  {
    type: TOWER_PD,
    name: '点防阵列',
    arcDeg: ARC_WIDE_DEG, // 广 150°(GDD §5.2)
    range: 210, // 占位待调(近防:射程仍全场最短 = 机炮的 55%,但漏怪贴脸前多一秒反应窗)
    damage: 3, // 占位待调(单发轻、靠射速堆;持续 DPS ≈ 18.2 > 机炮 13.2,"最后一道近防闸"才对症)
    fireInterval: 0.12, // 占位待调
    turnRate: 540, // 占位待调(转得最快:近身目标的角速度最大,慢一点就永远追不上)
    aimTolDeg: 10, // 占位待调
    throttle: THR_AMMO,
    magazine: 40, // 占位待调(弹夹最大,配最快射速 ≈ 4.8s 打空)
    reload: 1.8, // 占位待调
    heatPerShot: 0,
    heatMax: 0,
    coolPerSec: 0,
    overheatLock: 0,
    chargeTime: 0,
    fx: FX_BULLET,
    bulletSpeed: 560, // 占位待调(近防要快到几乎不用提前量)
    bulletRadius: 2, // 占位待调
    pierce: 0,
    chainCount: 0,
    chainRange: 0,
    chainFalloff: 0,
    lanceWidth: 0,
    aoeRadius: 0,
    aoeDamage: 0,
    // GDD §5.2 的"击落弹幕":MVP 四敌均无弹幕(GDD §6 的孢子炮手在 1.0 才进池),
    // 所以这里只是一面**立起来的旗子** —— 弹幕实体出现的那天,拦截逻辑照这个字段筛塔,不必回头改表结构
    interceptsProjectiles: true,
    burst: 0, // 非恒发塔
    burstAtLv3: 0,
    pierceAtLv5: 0,
    tint: 0x5ce8b4, // 占位待调(最偏绿的一档冷色,与其余五塔一眼分开)
    growth: {
      damage: 1.22, // 占位待调
      fireRate: 1.1, // 占位待调
      range: 1.04, // 占位待调(近防的射程刻意不怎么长)
      heatMax: 1,
      chargeRate: 1,
      magazine: 10, // 占位待调(Lv5 = 80 发)
      chain: 0,
    },
  },
  {
    type: TOWER_MORTAR,
    name: '等离子迫击炮',
    arcDeg: ARC_NARROW_DEG, // 窄 60°(GDD §5.2)
    range: 520, // 占位待调
    // 直击不结算:抛射弹途中不碰撞(越过前排正是它的定位),伤害全在落点 → 见 aoeDamage。
    // 按本文件"不用就填 0"的口径填 0,免得渲染层/UI 拿它当单发伤害显示
    damage: 0,
    fireInterval: 0, // 充能系恒 0
    turnRate: 90, // 占位待调(最沉)
    aimTolDeg: 8, // 占位待调(打的是落点范围,准头容差比激光宽)
    throttle: THR_CHARGE,
    magazine: 0,
    reload: 0,
    heatPerShot: 0,
    heatMax: 0,
    coolPerSec: 0,
    overheatLock: 0,
    chargeTime: 3, // 占位待调(全场最慢的攒-放)
    fx: FX_MORTAR,
    bulletSpeed: 260, // 占位待调(慢到看得见抛物线,才有"躲开落点"的余地)
    bulletRadius: 4, // 占位待调(途中不碰撞,这个半径只给渲染用)
    pierce: 0,
    chainCount: 0,
    chainRange: 0,
    chainFalloff: 0,
    lanceWidth: 0,
    aoeRadius: 90, // 占位待调
    aoeDamage: 34, // 占位待调(落点全员吃满;等级成长走 towerAoeDamage,与 towerDamage 同口径)
    interceptsProjectiles: false,
    burst: 0, // 非恒发塔(恒发签名在进化塔轨道火雨上)
    burstAtLv3: 0,
    pierceAtLv5: 0, // 无跳变(GDD §5.5 把"三连发"留给了轨道火雨进化)
    tint: 0x3d8ad6, // 占位待调(最暗的一档钢蓝)
    growth: {
      damage: 1.26, // 占位待调:迫击炮的伤害全在 AoE,这一档喂的是 towerAoeDamage
      fireRate: 1,
      range: 1.06, // 占位待调
      heatMax: 1,
      chargeRate: 1.12, // 占位待调
      magazine: 0,
      chain: 0,
    },
  },
  // —— 合成武器(用户设计会):3×相同基础武器 → 1 把更强武器(data/merges.ts 的配方)。
  // 六座一律"继承基塔的节流系"(合成后继续吃同系支援的加成),签名是三把拼一把买断的那一条;
  // 不做 Lv3/Lv5 等级小跳变(那档成长属于基塔)。数值全部占位待调 ——
  {
    type: TOWER_STORM_CANNON,
    name: '风暴机炮',
    arcDeg: ARC_WIDE_DEG, // 机炮 100° + 50°(= 大 50%,两种读法同数)= 150°,恰好落在广角档
    range: 380, // 占位待调(= 机炮)
    damage: 6, // 占位待调
    fireInterval: 0.25, // 占位待调(比机炮 0.4 快六成:三把拼一把买断的"倾泻"签名)
    turnRate: 360, // 占位待调
    aimTolDeg: 6, // 占位待调
    throttle: THR_AMMO, // 继承机炮的弹药系:弹药库加成仍生效
    magazine: 20, // 占位待调(= 机炮)
    // **不再装填**(合成签名):打空当场满弹(sim/tower.ts 对 reload ≤ 0 的兜底),硬停顿整条消失
    reload: 0,
    heatPerShot: 0,
    heatMax: 0,
    coolPerSec: 0,
    overheatLock: 0,
    chargeTime: 0,
    fx: FX_BULLET,
    bulletSpeed: 420, // 占位待调
    bulletRadius: 3, // 占位待调
    pierce: 0,
    chainCount: 0,
    chainRange: 0,
    chainFalloff: 0,
    lanceWidth: 0,
    aoeRadius: 0,
    aoeDamage: 0,
    interceptsProjectiles: false,
    burst: 2, // **双管齐射**(合成签名):每次开火恒 2 发(与 Lv3 跳变正交,基础就有)
    burstAtLv3: 0, // 合成武器不做等级小跳变:签名是三把拼一把给的那条,不叠基塔的双管
    pierceAtLv5: 0, // 也不叠基塔的曳光弹
    tint: 0x7cc8ff, // 占位待调(亮天蓝:机炮系的最亮档)
    growth: {
      damage: 1.25, // 占位待调(= 机炮)
      fireRate: 1.1, // 占位待调
      range: 1.05, // 占位待调
      heatMax: 1,
      chargeRate: 1,
      magazine: 5, // 占位待调
      chain: 0,
    },
  },
  {
    type: TOWER_AURORA,
    name: '极光阵列',
    arcDeg: ARC_NARROW_DEG, // 窄 60°(= 激光)
    range: 380, // 占位待调(比激光略远)
    damage: 3, // 占位待调(每 tick)
    fireInterval: 0.1, // 占位待调(10Hz 离散化口径同激光)
    turnRate: 240, // 占位待调
    aimTolDeg: 3, // 占位待调
    throttle: THR_HEAT, // 继承激光的过热系:散热器加成仍生效
    magazine: 0,
    reload: 0,
    // **无过热**(合成签名):热量根本不累积,过热系四个数整段填 0
    heatPerShot: 0,
    heatMax: 0,
    coolPerSec: 0,
    overheatLock: 0,
    chargeTime: 0,
    fx: FX_BEAM,
    bulletSpeed: 0,
    bulletRadius: 0,
    // **光束穿透**签名:sim/turret.ts 的 fireBeam 以 pierce > 0 进穿透路径
    pierce: 1,
    chainCount: 0,
    chainRange: 0,
    chainFalloff: 0,
    lanceWidth: 4, // 穿透光束的线半宽:复用磁轨那一条线宽字段,穿透判定照它量
    aoeRadius: 0,
    aoeDamage: 0,
    interceptsProjectiles: false,
    burst: 0, // 非恒发塔
    burstAtLv3: 0,
    pierceAtLv5: 0, // 穿透是塔的本性,不是 Lv5 跳变
    tint: 0x2fe8d8, // 占位待调(亮青:激光系的最亮档)
    growth: {
      damage: 1.28, // 占位待调(= 激光)
      fireRate: 1, // 恒 1:0.1s 是离散化口径,不是射速旋钮
      range: 1.06, // 占位待调
      heatMax: 1, // 热上限恒 0,这一档也填 1(无过热 = 无热成长可谈)
      chargeRate: 1,
      magazine: 0,
      chain: 0,
    },
  },
  {
    type: TOWER_ANNIHILATION,
    name: '湮灭长矛',
    arcDeg: ARC_VERY_NARROW_DEG, // 极窄 30°(= 磁轨,轴线艺术不变)
    range: 900, // 占位待调("全屏贯穿":比磁轨 700 再远一截,射程本身就是贯穿的数值化)
    damage: 50, // 占位待调(比磁轨略高)
    fireInterval: 0, // 充能系恒 0
    turnRate: 120, // 占位待调(= 磁轨)
    aimTolDeg: 2, // 占位待调
    throttle: THR_CHARGE, // 继承磁轨的充能系:电容组加成仍生效
    magazine: 0,
    reload: 0,
    heatPerShot: 0,
    heatMax: 0,
    coolPerSec: 0,
    overheatLock: 0,
    // 磁轨 2.4s 减半以上 = "充能时间显著缩短",数值近似"击杀刷新充能"(机制特效留 M3 打磨)
    chargeTime: 1.0, // 占位待调
    fx: FX_LANCE, // 磁轨本就是线上全员命中的瞬时线段,穿透是继承来的,不另开门
    bulletSpeed: 0,
    bulletRadius: 0,
    pierce: 0, // 线段判定不走弹丸穿透计数
    chainCount: 0,
    chainRange: 0,
    chainFalloff: 0,
    lanceWidth: 7, // 占位待调(比磁轨 6 略宽)
    aoeRadius: 0,
    aoeDamage: 0,
    interceptsProjectiles: false,
    burst: 0, // 非恒发塔
    burstAtLv3: 0,
    pierceAtLv5: 0,
    tint: 0x8a96ff, // 占位待调(亮靛:磁轨系的最亮档)
    growth: {
      damage: 1.3, // 占位待调(= 磁轨)
      fireRate: 1, // 恒 1:充能系的成长全给 chargeRate
      range: 1.06, // 占位待调
      heatMax: 1,
      chargeRate: 1.12, // 占位待调
      magazine: 0,
      chain: 0,
    },
  },
  {
    type: TOWER_THUNDER,
    name: '雷霆王冠',
    arcDeg: ARC_WIDE_DEG, // 广 150°(= 电弧)
    range: 260, // 占位待调(= 电弧)
    damage: 7, // 占位待调(首跳伤害)
    fireInterval: 0.55, // 占位待调(= 电弧)
    turnRate: 300, // 占位待调
    aimTolDeg: 12, // 占位待调
    throttle: THR_HEAT, // **继承电弧的过热系**:散热器加成仍生效
    magazine: 0,
    reload: 0,
    heatPerShot: 3, // 占位待调(= 电弧)
    heatMax: 12, // 占位待调
    coolPerSec: 4, // 占位待调
    overheatLock: 1.6, // 占位待调
    chargeTime: 0,
    fx: FX_CHAIN,
    bulletSpeed: 0,
    bulletRadius: 0,
    pierce: 0,
    chainCount: 6, // **链数翻倍**(合成签名:电弧 3 → 6)
    chainRange: 130, // 占位待调(= 电弧)
    chainFalloff: 0.7, // 占位待调
    lanceWidth: 0,
    aoeRadius: 0,
    aoeDamage: 0,
    interceptsProjectiles: false,
    burst: 0, // 非恒发塔
    burstAtLv3: 0,
    pierceAtLv5: 0,
    tint: 0x8ce8ff, // 占位待调(电白蓝的最亮档)
    growth: {
      damage: 1.2, // 占位待调(= 电弧)
      fireRate: 1.08, // 占位待调
      range: 1.05, // 占位待调
      heatMax: 1.15, // 占位待调
      chargeRate: 1,
      magazine: 0,
      chain: 1, // 占位待调(每级 +1 跳,同电弧)
    },
  },
  {
    type: TOWER_DELUGE,
    name: '焦土骤雨',
    arcDeg: ARC_NARROW_DEG, // 窄 60°(= 迫击炮)
    range: 520, // 占位待调(= 迫击炮)
    damage: 0, // 直击不结算:伤害全在落点(同迫击炮口径)
    fireInterval: 0, // 充能系恒 0
    turnRate: 90, // 占位待调(= 迫击炮)
    aimTolDeg: 8, // 占位待调
    throttle: THR_CHARGE, // 继承迫击炮的充能系:电容组加成仍生效
    magazine: 0,
    reload: 0,
    heatPerShot: 0,
    heatMax: 0,
    coolPerSec: 0,
    overheatLock: 0,
    chargeTime: 3, // 占位待调(= 迫击炮:一次泄放 = 三发)
    fx: FX_MORTAR,
    bulletSpeed: 260, // 占位待调
    bulletRadius: 4, // 占位待调
    pierce: 0,
    chainCount: 0,
    chainRange: 0,
    chainFalloff: 0,
    lanceWidth: 0,
    aoeRadius: 105, // 占位待调(比迫击炮 90 略大:"覆盖更广"的合成签名)
    aoeDamage: 34, // 占位待调(= 迫击炮)
    interceptsProjectiles: false,
    burst: 3, // **三连发**(合成签名):一次充能泄放三颗落点弹(sim/turret.ts 的 fireMortar 读它)
    burstAtLv3: 0,
    pierceAtLv5: 0,
    tint: 0x6aa5e8, // 占位待调(钢蓝亮档)
    growth: {
      damage: 1.26, // 占位待调:伤害全在 AoE,这一档喂的是 towerAoeDamage
      fireRate: 1,
      range: 1.06, // 占位待调
      heatMax: 1,
      chargeRate: 1.12, // 占位待调
      magazine: 0,
      chain: 0,
    },
  },
  {
    type: TOWER_THORN,
    name: '荆棘星幕',
    arcDeg: ARC_WIDE_DEG, // 广 150°(= 点防)
    range: 210, // 占位待调(= 点防)
    damage: 3, // 占位待调
    fireInterval: 0.09, // 占位待调(比点防 0.12 再快一档:"星幕"密度的合成签名)
    turnRate: 540, // 占位待调(= 点防)
    aimTolDeg: 10, // 占位待调
    throttle: THR_AMMO, // 继承点防的弹药系:弹药库加成仍生效
    magazine: 40, // 占位待调(= 点防)
    reload: 1.8, // 占位待调(= 点防)
    heatPerShot: 0,
    heatMax: 0,
    coolPerSec: 0,
    overheatLock: 0,
    chargeTime: 0,
    fx: FX_BULLET,
    bulletSpeed: 560, // 占位待调(= 点防)
    bulletRadius: 2, // 占位待调
    pierce: 0,
    chainCount: 0,
    chainRange: 0,
    chainFalloff: 0,
    lanceWidth: 0,
    aoeRadius: 0,
    aoeDamage: 0,
    // **拦截旗子**(合成签名):"击落弹幕"的数值近似 = 弹幕减伤,反弹特效留 M3 ——
    // 弹幕实体出现的那天,拦截逻辑照这面旗子筛塔,荆棘与点防同筛
    interceptsProjectiles: true,
    burst: 0, // 非恒发塔
    burstAtLv3: 0,
    pierceAtLv5: 0,
    tint: 0x7fdfc8, // 占位待调(青绿亮档:点防系的最亮档)
    growth: {
      damage: 1.22, // 占位待调(= 点防)
      fireRate: 1.1, // 占位待调
      range: 1.04, // 占位待调(近防的射程刻意不怎么长)
      heatMax: 1,
      chargeRate: 1,
      magazine: 10, // 占位待调
      chain: 0,
    },
  },
  // —— 19 号进阶塔(GDD §10 的"只解锁内容"):首次胜利解锁后进三选一池。
  // 签名 = 节流系里唯一一座迫击炮:**弹药系装填节奏的落点 AoE** ——
  // 与迫击炮(充能系)的"攒-放"手感正好互为反面:一夹六发、打空装填、每发都是一颗落点弹。
  // 数值全部占位待调,但四条不变式要能在任意值上成立:
  //   弹药系四数齐全(magazine/reload/fireInterval 全正,没有买断例外);
  //   FX_MORTAR 五件套自洽(damage 0 / bulletSpeed / bulletRadius / aoeRadius / aoeDamage);
  //   等级成长全向(伤害在 AoE 档、弹夹加法成长);不叠 Lv3/Lv5 跳变 ——
  {
    type: TOWER_MISSILE_NEST,
    name: '导弹巢',
    arcDeg: ARC_MEDIUM_DEG, // 中 100°(比迫击炮的窄 60° 宽:导弹走弹道,射界宽一点才对得起装填的代价)
    range: 460, // 占位待调(夹在机炮 380 与迫击炮 520 之间)
    damage: 0, // 直击不结算:伤害全在落点(同迫击炮口径,见 FX_MORTAR 五件套)
    fireInterval: 1.2, // 占位待调(弹夹 6 发 × 1.2s = 一轮齐射 7.2s,打空接装填)
    turnRate: 150, // 占位待调(比迫击炮 90 略活:装填期足够把炮口转回来)
    aimTolDeg: 10, // 占位待调(打的是落点范围,准头容差比激光宽,同迫击炮 8 一档)
    throttle: THR_AMMO, // 弹药系迫击炮:弹药库邻接对这座塔生效(06 号支援设施的作用锚点)
    magazine: 6, // 占位待调(一夹六发 = 一整轮齐射)
    reload: 2.5, // 占位待调
    heatPerShot: 0,
    heatMax: 0,
    coolPerSec: 0,
    overheatLock: 0, // 非过热系,整段填 0
    chargeTime: 0, // 非充能系
    fx: FX_MORTAR,
    bulletSpeed: 320, // 占位待调(慢到看得见抛物线,才有"躲开落点"的余地,同迫击炮一档)
    bulletRadius: 5, // 占位待调(途中不碰撞,这个半径只给渲染用)
    pierce: 0,
    chainCount: 0,
    chainRange: 0,
    chainFalloff: 0, // 非链式
    lanceWidth: 0, // 非穿透线
    aoeRadius: 110, // 占位待调(比迫击炮 90 大:导弹的落点就该比炮弹糊得开)
    aoeDamage: 26, // 占位待调(单发略轻于迫击炮 34,但一夹六发 ≈ 156 全中 —— 密度换单发)
    interceptsProjectiles: false,
    burst: 0, // 非恒发塔(一次开火一发;密度由 1.2s 间隔 × 6 发弹夹给)
    burstAtLv3: 0, // 不做 Lv3 跳变:进阶塔的定位是"节流系交叉",不是叠等级小跳变
    pierceAtLv5: 0,
    tint: 0x4ec4f0, // 占位待调(中档天蓝,与 0x66c2ff 机炮拉开一档但仍在冷色域)
    growth: {
      damage: 1.25, // 占位待调:伤害全在 AoE,这一档喂的是 towerAoeDamage
      fireRate: 1.1, // 占位待调
      range: 1.06, // 占位待调
      heatMax: 1,
      chargeRate: 1, // 不用的乘法档填 1 = 无成长
      magazine: 3, // 占位待调(Lv5 = 6 + 4×3 = 18 发,弹夹是加法成长:整数个东西)
      chain: 0,
    },
  },
];

/**
 * 等级夹取:任何取值函数进门第一件事。
 * `!(level >= 1)` 而不是 `level < 1`:**NaN 与任何数比较都是 false**,写成前者才把 NaN 一并接住 ——
 * 少了这一手,一个未初始化的 cell.level 就会顺着 Math.pow 把伤害/射程全变成 NaN,
 * 而 NaN 在 checksum 里被 `| 0` 抹成 0,分叉当场就从确定性口径下漏掉了。
 * 取整是因为等级本就是整数档:非整数进来(将来若有"半级"类效果)也不会算出档位之间的怪值。
 */
/**
 * 星级 → 有效等级档:1★→1、2★→3、3★→5。
 * 成长表(TowerGrowth)不用改、还是按旧 Lv 步进:starLevel−1 = 0/2/4 恰好是旧 Lv1/Lv3/Lv5 的指数,
 * 于是 2★ 命中旧 Lv3 档数值、3★ 命中旧 Lv5 档 —— "星级自带成长"直接由旧数据兑现。
 * 夹取与取整口径照旧:非整数星级(将来若有"半星"类效果)也不会算出档位之间的怪值,
 * 而 NaN 在 checksum 里被 `| 0` 抹成 0,分叉当场就从确定性口径下漏掉。
 */
function starLevel(stars: number): number {
  if (!(stars >= 1)) return 1; // NaN 兜底(与旧 clampLevel 同一条守卫:NaN >= 1 恒 false)
  return Math.min(STAR_MAX, Math.floor(stars)) * 2 - 1;
}

/**
 * 以下取值函数是 sim 读表的**唯一入口**:一律 (def, stars) 入参、一律不读 tuning
 * (全局倍率在 sim/tower.ts 的 effectiveDamage / effectiveFireInterval 里现乘,数据表不认识 config)。
 * 入参形状定成这样是给 06 号留的口子:支援设施的邻接加成只需在 sim/tower.ts 的包装函数里多读一步,
 * 这里与几十处调用点一个字都不用改。
 */
export function towerDamage(def: TowerDef, stars: number): number {
  return def.damage * Math.pow(def.growth.damage, starLevel(stars) - 1);
}

/** 秒/次。充能系的 base 恒 0,除下来照样是 0,不必特判 */
export function towerFireInterval(def: TowerDef, stars: number): number {
  return def.fireInterval / Math.pow(def.growth.fireRate, starLevel(stars) - 1);
}

export function towerRange(def: TowerDef, stars: number): number {
  return def.range * Math.pow(def.growth.range, starLevel(stars) - 1);
}

/**
 * 射界弧度**不随星级成长**:GDD §5.4 只承诺"数值成长",射界是**格子**的属性
 * (加宽只由角落格的 +60° 与 §5.5 的进化配方给)。
 * 仍然照其余取值函数收下 stars:调用方一律写 towerArcDeg(def, slot.stars),
 * 哪天加特林要塞(§5.5:弧度 +50°)落地,改这一处即可,十几个调用点一个字不用动。
 */
export function towerArcDeg(def: TowerDef, stars: number): number {
  void stars;
  return def.arcDeg;
}

/** 弹夹上限(发)。加法成长 + 取整:弹夹是**整数个**东西,UI 直接把它印出来 */
export function towerMagazine(def: TowerDef, stars: number): number {
  return Math.round(def.magazine + def.growth.magazine * (starLevel(stars) - 1));
}

export function towerHeatMax(def: TowerDef, stars: number): number {
  return def.heatMax * Math.pow(def.growth.heatMax, starLevel(stars) - 1);
}

/** 攒满一发要多久(秒)。成长挂在 chargeRate 上,故这里是除法 —— 与 fireInterval 同形 */
export function towerChargeTime(def: TowerDef, stars: number): number {
  return def.chargeTime / Math.pow(def.growth.chargeRate, starLevel(stars) - 1);
}

/** 链式总命中数(含首目标)。同样是整数档 */
export function towerChainCount(def: TowerDef, stars: number): number {
  return Math.round(def.chainCount + def.growth.chain * (starLevel(stars) - 1));
}

/**
 * 每次开火几发(旧 GDD §5.4 的 Lv3 机制小跳变 → 星级系统里 2★ 触发;机炮双管 = 2)。
 * 0 = 该塔没有这次跳变 → 恒 1 发。跳变而不是连续成长:玩家要能在合到 2★ 那一刻**听出来**。
 */
export function towerBurst(def: TowerDef, stars: number): number {
  return stars >= 2 && def.burstAtLv3 > 0 ? def.burstAtLv3 : 1;
}

/** 弹丸穿透次数(旧 Lv5 机制小跳变 → 星级系统里 3★ 触发;机炮曳光弹 = +1) */
export function towerPierce(def: TowerDef, stars: number): number {
  return def.pierce + (stars >= 3 ? def.pierceAtLv5 : 0);
}

/**
 * 落点 AoE 伤害。迫击炮的 def.damage 恒 0(途中不碰撞),伤害全在落点 ——
 * 少了这个函数,它就是六塔里唯一升星不加伤的塔,而它偏偏是充能系里最慢的那座。
 * 复用 growth.damage 而不另开一档:落点伤害**就是**这座塔的伤害,两条曲线没有分开的理由。
 */
export function towerAoeDamage(def: TowerDef, stars: number): number {
  return def.aoeDamage * Math.pow(def.growth.damage, starLevel(stars) - 1);
}
