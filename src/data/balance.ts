/**
 * 平衡系统的数值口径(平衡系统)—— 纯数据,只 import 同目录的 data/towers。
 * 铁律:src/data 与 src/sim 一样永不 import pixi/DOM;**也永不 import sim/config** ——
 * 数据表是配置的上游,引回去就成环。依赖方向是 balance → towers **单向**
 * (towers.ts 一个字都不知道本文件的存在)。
 *
 * 本文件是平衡系统的**旋钮面**:难度指数 + 走廊三旋钮 + 火力口径常数 + Boss 闸门常数
 * 都住在这里,调平衡只改本文件的数、不改一行逻辑(与 todos/05 同一条验收口径)。
 *
 * —— 平衡系统的两条腿 ——
 * 1. **难度指数**(difficultyOf):「操作难度大的武器拿数值优势」——先把"操作难"量化。
 *    闭式、只读数值表基础字段、与星级无关(充能时长随星缩短是成长奖励,不算操作难度)。
 *    对自动机炮归一 = 1.0(机炮是 GDD §14 锁定的锚,走廊锚线也取它)。
 * 2. **难度→火力走廊**(判定在 sim/balance.ts):每星级档的火力必须落在
 *    锚线 × (1 + k×(难度−1)) 的 ±b 带内 —— 难的塔必须真的更强,易的塔不许偷偷超线。
 *    本文件只给常数,判定逻辑在 sim/balance.ts(它要读 sim/tower.ts 的 slotSustainedDps,
 *    那是"含整个节流周期的闭式持续 DPS"的单一真相源,不在这里重写一份)。
 *
 * 与 data/towers.ts 同风格:数字常量而非 enum;字段不加 readonly、不 Object.freeze ——
 * 单测要临时改字段再 afterEach 还原,冻表会让"改数据即可调平衡"这条验收无从下手。
 */
import {
  FX_CHAIN,
  FX_MORTAR,
  TOWERS,
  TOWER_AUTOCANNON,
  type TowerDef,
} from './towers';

// —— 难度指数(操作难度指数)——

/**
 * 节流系的难度底子(下标 = THR_*)。三套机制是**机制上可区分**的(不是同一个冷却换三种皮,
 * data/towers.ts 文件头),操作负担也确实分档:
 *   弹药 1.0 = 万金油的代价:突发满速后必然停火装填,但停火是**表定死的**,不用玩家操心;
 *   过热 1.15 = 点射纪律:贪连射吃锁死罚时,克制点射就永不停火 —— 热度管理是玩家的事;
 *   充能 1.35 = 攒-放节奏:满充等目标、提前量要预判,漏一发 = 白攒一整轮 —— 最难。
 * 严格递增是机制要求(难度档不许倒挂,balance.test 钉着),调数值可以,调顺序不行。
 */
export const FAM_BY_THROTTLE = [1.0, 1.15, 1.35] as const;

/**
 * 提前量的参考飞行时间(秒)= 机炮的 range/bulletSpeed = 380/420。
 * 弹丸飞行秒数除以它再 +1:机炮 = 2,瞬时判定(光束/链电/光矛,弹速 0)= 1。
 * 取机炮做分母是「对锚归一」的同一条口径 —— 机炮的难度就是刻度尺本身。
 */
export const TRAVEL_TIME_REF = 380 / 420;

/**
 * 射界覆盖的参考弧度(度)= 机炮的中档 100°。g = 参考弧度 / 塔弧度:
 * 30° 极窄 = 3.33(世界大部分在弧外,得靠转船去喂),150° 广角 = 0.67(几乎不用摆位)。
 */
export const ARC_REF_DEG = 100;

/**
 * 落点容错的参考半径(px)。落点半径就是「瞄不准的赎罪券」:m = 1/(1 + aoeRadius/90),
 * 半径 90 的落点 = 难度打对折。参考值取迫击炮占位值一档的 90,与 TRAVEL_TIME_REF 同一条口径。
 */
export const AOE_REF_RADIUS = 90;

/**
 * 自动索敌的参考链数:链跳每多一跳,难度按 1/(1 + (chainCount−1)/5) 打折 ——
 * 链跳自动补刀是容错,链数越多容错越大(电弧 3 跳 = 0.71,雷霆 6 跳 = 0.5)。
 */
export const CHAIN_REF_COUNT = 5;

/**
 * 穿透容错的参考穿透数:基础穿透(极光 pierce 1)= 1/(1 + 1/3) = 0.75 档。
 * **只计 def.pierce,3★ 的 pierceAtLv5 跳变不算** —— 那是成长奖励(与难度指数
 * 「与星级无关」的口径同一条:升星买的是数值,不是操作负担)。
 */
export const PIERCE_REF_COUNT = 3;

/**
 * 乘积压缩指数:D = (D_raw / D_raw(机炮)) ^ 0.6。
 * 七个维度连乘,磁轨级的 raw 会比机炮高出 20 倍 —— 乘出来没有直觉;
 * 指数压缩把极端值拉回可读区间(磁轨 ≈ 6,机炮 = 1)。0.6 是经验档:
 * 太小(0.3)难度差异被抹平,太大(1.0)又回到乘积爆炸。
 */
export const DIFF_COMPRESS_EXP = 0.6;

/**
 * 操作难度指数 —— 闭式、与星级无关、对机炮归一 = 1.0。
 * 七个维度连乘(各维语义见对应常量):
 *   节流系 FAM × 瞄准(容差×转速) × 提前量(弹丸飞行) × 射界(弧度倒数)
 *   × 落点容错(仅迫击炮系) × 自动索敌(仅链电) × 穿透容错(仅基础穿透)
 * 数值表被改坏(aimTol/turnRate ≤ 0、arcDeg ≤ 0、弹速 ≤ 0)一律回落中性档而不是除 0 崩掉:
 * 难度指数是分析工具,不参与战斗结算,坏表的兜底该比战斗侧更宽容。
 */
/**
 * 七维连乘的未归一难度(枪锚也走同一套因子,归一才有意义)。
 * 数值表被改坏(aimTol/turnRate ≤ 0、arcDeg ≤ 0、弹速 ≤ 0)一律回落中性档而不是除 0 崩掉:
 * 难度指数是分析工具,不参与战斗结算,坏表的兜底该比战斗侧更宽容。
 * 唯一例外是瞄准档:非正容差/转速按最难档 9 计 —— 非正容差在战斗侧意味着永不命中,那是坏的极限。
 */
function rawDifficulty(def: TowerDef, gun: TowerDef): number {
  // 节流系底子:越界回落 1.0(坏表当弹药档,不崩)
  const fam = FAM_BY_THROTTLE[def.throttle] ?? 1;

  // 瞄准精度:容差越小、炮管越沉 = 越难对准(机炮 6°×360°/s,磁轨 2°×120°/s = 9 倍)
  const aim =
    def.aimTolDeg > 0 && def.turnRate > 0
      ? (gun.aimTolDeg * gun.turnRate) / (def.aimTolDeg * def.turnRate)
      : 9;

  // 弹道提前量:弹丸飞行秒数。瞬时判定塔弹速恒 0 = 不提前量。
  const lead =
    def.bulletSpeed > 0 && def.range > 0
      ? 1 + def.range / def.bulletSpeed / TRAVEL_TIME_REF
      : 1;

  // 射界覆盖:弧度越窄,世界里大部分方位都不在弧内。
  const gate = def.arcDeg > 0 ? ARC_REF_DEG / def.arcDeg : 1;

  // 落点容错:只有迫击炮系吃这一档(打的是落点范围,准头不是点)。
  const mortar = def.fx === FX_MORTAR && def.aoeRadius > 0 ? 1 / (1 + def.aoeRadius / AOE_REF_RADIUS) : 1;

  // 自动索敌:只有链电吃这一档(链跳自动补刀,玩家不必逐目标瞄准)。
  const chain =
    def.fx === FX_CHAIN && def.chainCount > 1
      ? 1 / (1 + (def.chainCount - 1) / CHAIN_REF_COUNT)
      : 1;

  // 穿透容错:基础穿透让弹丸穿过前排补后排,容错上升。
  const pierce = def.pierce > 0 ? 1 / (1 + def.pierce / PIERCE_REF_COUNT) : 1;

  return fam * aim * lead * gate * mortar * chain * pierce;
}

export function difficultyOf(def: TowerDef): number {
  const gun = TOWERS[TOWER_AUTOCANNON]!;
  return Math.pow(rawDifficulty(def, gun) / rawDifficulty(gun, gun), DIFF_COMPRESS_EXP);
}

// —— 难度→火力走廊(判定在 sim/balance.ts,这里只给三旋钮)——

/**
 * 技能溢价斜率 k:难度每 +1,火力锚线抬 55%。
 * 这就是「操作难度大的拿数值优势」的量化 —— k = 0 等于宣布难度白难,k 太大
 * (≈1.0)会把磁轨的单发顶到数百,单发数字先于手感崩溃。0.55 是"难塔显著更值"的档。
 * 之后调难度时这是第一个旋钮(降到 ~0.35 = 优势更温和)。
 */
export const CORRIDOR_SLOPE = 0.55;

/**
 * 走廊带宽 b:火力许落在锚线的 ±20% 内。带而不是点:对表微调鲁棒(挪一个 damage 不炸),
 * 对"整行拍平"敏感(机炮级数值塞给难塔 = 越带)。**双侧**:难塔不许偷懒,易塔也不许偷偷超线。
 */
export const CORRIDOR_BAND = 0.2;

/**
 * 合成武器的获取溢价:合成塔只存在于 3★,代价是 9 把同型武器(3×1★→2★、3×2★→3★)。
 * 那是**操作难度之外的另一条轴**(获取成本),走廊给它单乘 1.5 的锚线 ——
 * 不认可这条轴就改回 1(合成塔与基础塔同线比)。
 */
export const FUSED_ACQ_PREMIUM = 1.5;

// —— 火力指数口径(sim/balance.ts 的 slotPowerDps)——

/**
 * 落点 AoE 的期望敌密度 ρ(只/px²):F_aoe = 1 + π × aoeRadius² × ρ。
 * 推导:中场满压 ≈ 1000 敌散布在约 π×1500² ≈ 7.1M px² 的作战圈内 ≈ 1/7000;
 * 取 1/9000 略低于满压 —— AoE 的期望命中数按"日常压力"而不是"最满一波"计,
 * 高光时刻比模型强是 AoE 的定位福利。改这个数 = 改"打一群值多少"的整个口径。
 */
export const POWER_ENEMY_DENSITY = 1 / 9000;

/**
 * 线上命中的参考敌半径(px)= 蜂群蛭 7 圆整的 8。F_lance = 1 + lanceWidth/(2×8):
 * 线段半宽覆盖的横向敌数期望(敌方来袭方向近似正交于轴线)。
 */
export const POWER_ENEMY_RADIUS_REF = 8;

/**
 * 覆盖因子在火力指数里的权重 w:slotPowerDps 的 F_cov^w。
 * 走廊不变式断言在**不含覆盖**的火力上(arcDeg 已进难度指数,火力再乘覆盖 = 对窄弧塔
 * 双重惩罚,会把磁轨推到单发数百的荒谬档);含覆盖的 slotPowerDps 只做展示口径与
 * 专精带校验(见 sim/balance.test.ts)。
 */
export const CORRIDOR_COVERAGE_WEIGHT = 1.0;

// —— Boss 闸门(判定与枚举在 sim/balance.ts,这里只给常数)——

/**
 * 闸门配装的 Boss TTK 目标(秒):最弱合法配装(星级质量 ≥ 6、≥3 把武器、≥5 层法令,
 * 法令按**零 DPS 贡献**的纯功能档计 —— 保守口径,带弹药/超载叠层的真实玩家只会更快)
 * 应当在这个时间内击杀 Boss。取窗口中点 114,单测断言落 [105, 120] 内。
 * 2026-08-16 难度上调:82.5 → 124(+50%,Boss 血量同步 +50%,配 Z 字冲刺的走廊压力)。
 * 2026-08-16 再调:124 → 114(Boss 血量 3853 → ≈3509,-9%:冲刺轨迹加长到跨屏后
 * 反打压力上抬,血量回落一点,闸门配装的 TTK 仍钉在同一窗口内)。
 * 之后调难度时这是第二个旋钮:抬它 = 闸门更松,压它 = 更紧。
 */
export const GATE_TTK_TARGET = 114;
/** TTK 窗口下界(秒):目标值的最小合法档 */
export const GATE_TTK_MIN = 105;
/** TTK 窗口上界(秒):目标值的最大合法档 */
export const GATE_TTK_MAX = 120;

/**
 * 闸门配装的星级质量下限:Σstars ≥ 6 —— 用户口径「3★+2★+1★」(= 6)的星级质量制形式,
 * 3×2★ 同样达标,3★ 是可选尖峰(9 把同型的获取成本在经济上送不到,见 sim/balance.ts 的可行性账)。
 */
export const GATE_STAR_MASS_MIN = 6;
/** 闸门配装的最少武器把数(质量分给再少都不行,3 把是「一套组合」的最小读法) */
export const GATE_WEAPONS_MIN = 3;
/** 闸门配装的最少法令层数(任意构成,重复叠层也算 —— 用户口径定死) */
export const GATE_EDICT_LEVELS_MIN = 5;

/**
 * 欠闸门配装的 TTK 与闸门 TTK 的最小时间比:欠闸门打 2 倍以上的时间,
 * 期间每 7 秒一波召唤怪在场上无限堆积(淹没账见 sim/bossGate.test.ts)。
 */
export const GATE_TTK_RATIO_MIN = 2;

/**
 * 淹没账的判据:欠闸门 TTK 期间未清召唤怪的总 HP ≥ 本常数 × 船体 HP(100)。
 * 10 = 哪怕接触效率只有一成,这些怪也够把船咬穿好几遍 —— 「欠闸门必然淹死」的闭式依据。
 */
export const GATE_SUMMON_OVERWHELM_RATIO = 10;

/**
 * 经济可行性的武器获取下界(把):12–15 次升级 × 40% 武器权重 ≈ 4.8–6 张武器卡,
 * 星币 ≈ 1–3 把商店武器,加开局双机炮 ≈ 6–9 把 —— 断言 ≥ 7 是「压在可达窗口下缘」的记账
 * (推导细节见 sim/bossGate.test.ts 的经济可行性用例)。
 */
export const GATE_WEAPON_ACQ_FLOOR = 7;
