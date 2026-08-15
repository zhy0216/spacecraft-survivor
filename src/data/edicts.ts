/**
 * 法令数值表(用户设计会:支援并入法令)—— 纯数据,只 import 同目录的 data/towers 取 THR_*。
 * 铁律:src/data 与 src/sim 一样永不 import pixi/DOM;**也永不 import sim/config** ——
 * 数据表是配置的上游,引回去就成环。依赖方向是 edicts → towers **单向**
 * (towers.ts 一个字都不知道本文件的存在)。
 *
 * —— 支援并入法令(用户设计会)——
 * 旧版是**两套**全船被动:支援(占 4 个槽、可叠、效果强)与法令(不占槽、唯一、效果弱)。
 * 两者一共只覆盖 9 条效果轴,其中 4 条两边同时占(散热器 ×1.5 / 散热协议 ×1.2、
 * 装甲舱 +15 / 结构加固 +20、磁力收集器 ×1.3 / 磁力过载 ×1.3、弹药库射速 / 曳光·急速协议),
 * 于是"这两张卡到底差在哪"没有答案。本次改版把两套合成一套:
 *   **一条效果轴 = 一条法令**,数值取原来强的那一档(支援档);
 *   法令不占槽、可重复持有,**每条最多 EDICT_MAX_LEVEL 层**,层数即叠加次数
 *   (持有 2 层的散热协议,UI 印作「散热协议 ×2」)。
 * 于是玩家只需要记住一件事:法令是全船被动,拿重了就是叠层。
 *
 * 与 data/towers.ts 同风格:
 *   数字常量而非 enum(热循环里按下标直取最省事,isolatedModules 下 enum 也不划算);
 *   字段不加 readonly、不 Object.freeze —— 单测要临时改字段再 afterEach 还原;
 *   **不用的乘法档填 1、加法档填 0 并注明**(两个中性值的分工与 towers.ts 的 growth 一段同源:
 *     0 作乘数是"归零",会把射速/拾取半径直接抹成 0,与"这一档用不上"是两码事)。
 *
 * 叠加口径(**定死**,sim/edictBuffs.ts 照它算,别处不许另立一套):
 *   乘法档一律 **base^level**(2 层散热协议 = ×1.25² = ×1.5625,连乘永远推不到 ≤ 0);
 *   加法档一律 **add × level**(2 层装甲协议 = +30);
 *   —— 与 sim/damage.ts 那句"返回倍率而不是减伤值"一字同源。
 *
 * 作用域路由(与旧支援表的 throttle 字段同一条,原样保留):
 *   throttle >= 0 = **系限定**(弹药 0 / 过热 1 / 充能 2),四个族倍率只作用于该系武器;
 *   throttle === EDICT_THR_NONE(-1)= **全船无条件**(船体 / 经济 / 机动那几档)。
 */
import { THR_AMMO, THR_CHARGE, THR_HEAT } from './towers';

// —— 系限定档(吸收原弹药库 / 散热器 / 电容组)——
export const EDICT_AMMO = 0; // 弹药协议(原弹药库 + 曳光协议 + 急速协议)
export const EDICT_COOLANT = 1; // 散热协议(原散热器 + 散热协议)
export const EDICT_CAPACITOR = 2; // 电容协议(原电容组)
// —— 全船档(吸收原装甲舱 / 结构加固 / 经验增幅器 / 磁力收集器 / 磁力过载)——
export const EDICT_ARMOR = 3; // 装甲协议(原装甲舱 + 结构加固)
export const EDICT_XP = 4; // 增幅协议(原经验增幅器)
export const EDICT_MAGNET = 5; // 磁力协议(原磁力收集器 + 磁力过载)
// —— 机动档(原法令独有的两条,原样保留;增压校准是第三条,动的是加速技能冷却)——
export const EDICT_GYRO = 6; // 重心校准
export const EDICT_CRUISE = 7; // 巡航校准
// —— 经济档(用户设计会:星币改 10% 概率掉落,这条是玩家对抗"抽不到星币"的唯一投资方向)——
export const EDICT_STARCHART = 8; // 星图协议
/**
 * 进阶法令:条件式解锁(单局击杀达标)后才进候选池,未解锁时由卡池过滤挡在候选之外
 * (与 data/unlocks.ts 的 edict-rapid 条目咬合 —— 那条解锁的下标位不许改,旧存档的掩码指着它)。
 * 合并后九条基础法令各占一条轴,进阶法令只好另开一轴:**全武器伤害**是唯一没被占掉的那条,
 * 且它也是"解锁内容 = 更强的既有档"这条口径下最直白的一档(GDD §10:只解锁内容,不解锁数值 ——
 * 它进的是卡池,不是白送的永久加成)。
 */
export const EDICT_OVERDRIVE = 9; // 超载协议
/**
 * 机动档第三条:加速技能(空格)冷却 -0.3 秒/层(5 层 = 5 → 3.5s,真空期 ~3.9 → 2.4s)。
 * 排在第 10 位而不是跟在巡航校准后面:0..9 是旧存档的掩码位,EDICT_OVERDRIVE 的下标位尤其
 * 不许动(见 data/unlocks.ts),新法令一律往后追加。
 */
export const EDICT_BOOST = 10; // 增压校准
export const EDICT_KIND_COUNT = 11;

/**
 * 同一条法令的叠层上限(用户设计会定死)。与 data/towers.ts 的 STAR_MAX 同一条待遇:
 * 它是**设计口径不是旋钮** —— 改它要连带重算整条经济账(法令是三选一的主体类别,
 * 上限决定了一局能把几条轴推到头)。满层的法令由卡池过滤剔出候选(见 sim/upgrade.ts),
 * 于是"抽到已满层法令"的沉默死卡从结构上不存在。
 */
export const EDICT_MAX_LEVEL = 5;

/**
 * throttle 填它 = **不作用于特定武器系**(船体 / 经济 / 机动那几档)。
 * 故意用 -1 而不是另开一个"无"档:它落在 THR_*(0/1/2)的编号之外 ——
 * 效果聚合只需一句 `>= 0` 就把"系限定"与"全船"分开(见 sim/edictBuffs.ts 的路由)。
 */
export const EDICT_THR_NONE = -1;

export interface EdictDef {
  /** 下标 === type,与 EDICT_* 一致;EDICTS[type] 直取,错一位就全船串味 */
  type: number;
  /**
   * slug:翻译/编辑器身份 —— 全表唯一、小写下划线(见 edicts.test)。
   * **数值 type 才是存档与模拟身份**,slug 不进存档、不被 sim 读取。
   */
  slug: string;
  /**
   * devName:开发/调参用的**中文开发名**,只给人看、逻辑不读。
   * 玩家界面不得读它 —— 显示名一律走 presenter(src/ui/presentation/contentText 的 edictName)。
   */
  devName: string;
  /**
   * 作用的武器系(data/towers 的 THR_*),或 EDICT_THR_NONE = 全船无条件生效。
   * 作用系相同的武器共享这一条法令的加成;不匹配的武器一个字都不受影响。
   */
  throttle: number;
  // —— 系限定档(仅 throttle >= 0 的法令填非中性值)——
  /** 本系武器:射速倍率(> 1 = 更快);不用填 1 */
  fireRateMul: number;
  /** 本系武器:装填时间倍率(< 1 = 更短);不用填 1 */
  reloadMul: number;
  /** 本系武器:过热上限倍率(> 1 = 能连烧更久);不用填 1 */
  heatMaxMul: number;
  /** 本系武器:充能速度倍率(> 1 = 更快,chargeTime 除它);不用填 1 */
  chargeRateMul: number;
  // —— 全船档(仅 throttle === EDICT_THR_NONE 的法令填非中性值)——
  /** **全部**武器的伤害倍率(超载协议 = 1.15);不用填 1 */
  damageMul: number;
  /** 船体 HP 加点,**加法**(2 层装甲协议 = +30):它是点数,不是比例。不用填 0 */
  hullHpAdd: number;
  /** 受击伤害倍率(< 1 = 减伤),连乘;不用填 1 */
  damageTakenMul: number;
  /** 经验获取倍率(> 1 = 每颗经验掉落进账更多),连乘;不用填 1 */
  xpMul: number;
  /** 磁吸半径倍率(> 1 = 起吸半径更大),连乘;不用填 1 */
  magnetRadiusMul: number;
  /** 转向速率加点 °/s,**加法**;不用填 0 */
  turnRateAdd: number;
  /** 巡航速度倍率,连乘;不用填 1 */
  cruiseSpeedMul: number;
  /**
   * 加速技能冷却的加减秒,**加法**(负值 = 更短,增压校准 = -0.3)。全表唯一的负向加法轴:
   * 这条"变强"的方向是减,加法档不许为负的审计(edicts.test)只对它开绿灯。不用填 0
   */
  boostCooldownAdd: number;
  /**
   * 星币掉落概率加点(**加法**,绝对概率:0.08 = +8 个百分点)。
   * 基础概率在 data/economy.ts 的 STARCOIN_DROP_CHANCE;总概率夹在 [0, 1]
   * (夹取在 sim/edictBuffs.ts,本表只管"这一层加几个点")。不用填 0
   */
  starCoinChanceAdd: number;
  /**
   * 渲染色。一律**冷色**(GDD §12:敌我色域完全分离),且与各武器的 tint 都不撞。
   */
  tint: number;
}

/**
 * 下标 === type,顺序 弹药/散热/电容/装甲/增幅/磁力/重心/巡航/星图/超载;
 * sim 靠 EDICTS[type] 直取。除标注"占位待调"外,系限定三条的数值逐字继承原支援表
 * (弹药库 1.25/0.7、散热器 1.5、电容组 1.3),装甲/增幅/磁力同理 ——
 * 合并的是**两张表**,不是两组数值:玩家原本能拿到的最强档一个都没变弱。
 * —— 例外:散热/增幅两条已按 5 层复利压档(1.5 → 1.25,5 层 ×7.6 → ×3.05),
 * "逐字继承原支援表"的口径从此只对**未压档**的条目成立;全表统一压档要等第二波
 * "满层质变"一起做(这里只治"买断过热机制"和"拉穿经济曲线"两处真失衡,别顺手压别的八条)。
 */
export const EDICTS: EdictDef[] = [
  {
    type: EDICT_AMMO,
    slug: 'ammo_protocol',
    devName: '弹药协议',
    // 弹药系(机炮 / 点防 / 导弹巢 / 风暴机炮 / 荆棘星幕)。
    // "突发满速后必然停火装填"是弹药系的手感,这条正是买断那段停火的东西
    throttle: THR_AMMO,
    fireRateMul: 1.25, // 原弹药库:射速 +25%(5 层 ≈ ×3.05)
    reloadMul: 0.7, // 原弹药库:装填 -30%(5 层 ≈ ×0.17)
    heatMaxMul: 1,
    chargeRateMul: 1, // 不作用的乘法档填 1 = 恒等(填 0 会把热上限/充能直接抹成 0)
    damageMul: 1,
    hullHpAdd: 0, // 非全船档:加法填 0、乘法填 1
    damageTakenMul: 1,
    xpMul: 1,
    magnetRadiusMul: 1,
    turnRateAdd: 0,
    cruiseSpeedMul: 1,
    boostCooldownAdd: 0,
    starCoinChanceAdd: 0,
    tint: 0x4fb3a5, // 占位待调(青绿)
  },
  {
    type: EDICT_COOLANT,
    slug: 'coolant_protocol',
    devName: '散热协议',
    throttle: THR_HEAT, // 过热系(激光 / 电弧 / 极光阵列 / 雷霆王冠)
    fireRateMul: 1,
    reloadMul: 1,
    heatMaxMul: 1.25, // 原散热器 1.5 按 5 层复利压档:×7.6 会把过热机制整个买断、过热系手感签名消失 ⇒ 5 层 ≈ ×3.05(占位待调)
    chargeRateMul: 1,
    damageMul: 1,
    hullHpAdd: 0,
    damageTakenMul: 1,
    xpMul: 1,
    magnetRadiusMul: 1,
    turnRateAdd: 0,
    cruiseSpeedMul: 1,
    boostCooldownAdd: 0,
    starCoinChanceAdd: 0,
    tint: 0x5aa8d8, // 占位待调(中调天蓝)
  },
  {
    type: EDICT_CAPACITOR,
    slug: 'capacitor_protocol',
    devName: '电容协议',
    throttle: THR_CHARGE, // 充能系(磁轨 / 迫击炮 / 湮灭长矛 / 焦土骤雨)
    fireRateMul: 1,
    reloadMul: 1,
    heatMaxMul: 1,
    chargeRateMul: 1.3, // 原电容组:充能速度 +30%(chargeTime 除它 ⇒ 攒得更快)
    damageMul: 1,
    hullHpAdd: 0,
    damageTakenMul: 1,
    xpMul: 1,
    magnetRadiusMul: 1,
    turnRateAdd: 0,
    cruiseSpeedMul: 1,
    boostCooldownAdd: 0,
    starCoinChanceAdd: 0,
    tint: 0x7d8ee8, // 占位待调(偏紫的蓝)
  },
  {
    type: EDICT_ARMOR,
    slug: 'armor_protocol',
    devName: '装甲协议',
    // 原装甲舱(HP +15 / 受击 ×0.8)与原结构加固(HP +20)合并成一条:两者是同一条船体轴。
    // HP 取 15 那一档而不是 20 —— 它带着减伤那半边,合并后单层总价值仍高于旧结构加固
    throttle: EDICT_THR_NONE,
    fireRateMul: 1,
    reloadMul: 1,
    heatMaxMul: 1,
    chargeRateMul: 1, // 四个系倍率整段恒等
    damageMul: 1,
    hullHpAdd: 15, // 船体 HP +15(加法,5 层 = +75)
    damageTakenMul: 0.8, // 受击伤害 -20%(连乘,5 层 ≈ ×0.33)
    xpMul: 1,
    magnetRadiusMul: 1,
    turnRateAdd: 0,
    cruiseSpeedMul: 1,
    boostCooldownAdd: 0,
    starCoinChanceAdd: 0,
    tint: 0x8fa6bd, // 占位待调(低饱和钢蓝)
  },
  {
    type: EDICT_XP,
    slug: 'amp_protocol',
    devName: '增幅协议',
    // 原经验增幅器:"法令可以加速升级"的核心档。它不移动 rng、不改波次,只放大掉落收益,
    // 于是"点了它升级更快"是玩家一眼能验证的承诺
    throttle: EDICT_THR_NONE,
    fireRateMul: 1,
    reloadMul: 1,
    heatMaxMul: 1,
    chargeRateMul: 1,
    damageMul: 1,
    hullHpAdd: 0,
    damageTakenMul: 1,
    xpMul: 1.25, // 原 1.5 按 5 层复利压档:×7.6 拉穿经济曲线 ⇒ 5 层 ≈ ×3.05(连乘;占位待调)
    magnetRadiusMul: 1,
    turnRateAdd: 0,
    cruiseSpeedMul: 1,
    boostCooldownAdd: 0,
    starCoinChanceAdd: 0,
    tint: 0xa0e8cf, // 占位待调(冷薄荷绿:b > r 守住冷色审计)
  },
  {
    type: EDICT_MAGNET,
    slug: 'magnet_protocol',
    devName: '磁力协议',
    // 原磁力收集器与原磁力过载(两条 ×1.3 的同轴卡)合并成一条。配合磁吸缩小(240→80),
    // 它是玩家对抗"捡不到"的主要投资方向
    throttle: EDICT_THR_NONE,
    fireRateMul: 1,
    reloadMul: 1,
    heatMaxMul: 1,
    chargeRateMul: 1,
    damageMul: 1,
    hullHpAdd: 0,
    damageTakenMul: 1,
    xpMul: 1,
    magnetRadiusMul: 1.3, // 磁吸半径 +30%(连乘,5 层 ≈ ×3.7 ⇒ 80 → 297,约等于旧的 240 宽容档)
    turnRateAdd: 0,
    cruiseSpeedMul: 1,
    boostCooldownAdd: 0,
    starCoinChanceAdd: 0,
    tint: 0x8ab8e8, // 占位待调(冷灰蓝)
  },
  {
    type: EDICT_GYRO,
    slug: 'gyro_calibration',
    devName: '重心校准',
    throttle: EDICT_THR_NONE,
    fireRateMul: 1,
    reloadMul: 1,
    heatMaxMul: 1,
    chargeRateMul: 1,
    damageMul: 1,
    hullHpAdd: 0,
    damageTakenMul: 1,
    xpMul: 1,
    magnetRadiusMul: 1,
    turnRateAdd: 10, // 转向 +10°/s(加法,5 层 = +50 ⇒ 基线 100 翻半倍)
    cruiseSpeedMul: 1,
    boostCooldownAdd: 0,
    starCoinChanceAdd: 0,
    tint: 0x9fb0e0, // 占位待调(淡靛)
  },
  {
    type: EDICT_CRUISE,
    slug: 'cruise_calibration',
    devName: '巡航校准',
    throttle: EDICT_THR_NONE,
    fireRateMul: 1,
    reloadMul: 1,
    heatMaxMul: 1,
    chargeRateMul: 1,
    damageMul: 1,
    hullHpAdd: 0,
    damageTakenMul: 1,
    xpMul: 1,
    magnetRadiusMul: 1,
    turnRateAdd: 0,
    cruiseSpeedMul: 1.1, // 巡航速度 +10%(连乘,5 层 ≈ ×1.61)
    boostCooldownAdd: 0,
    starCoinChanceAdd: 0,
    tint: 0x6fd0e8, // 占位待调(冷青)
  },
  {
    type: EDICT_STARCHART,
    slug: 'starchart_protocol',
    devName: '星图协议',
    // 用户设计会:星币改成**每次击杀按概率掉落**(data/economy 的 STARCOIN_DROP_CHANCE),
    // 这条是唯一能抬那个概率的东西。二轮审查重锚:基础概率降到 3% 后,本层的加点同步
    // 从 +8 收到 +2 ⇒ 5 层 = 12.5% ≈ 基础的 4.2 倍;用户设计会再抬基础 +20 个百分点 → 23%,
    // 本层加点暂不动(5 层 = 33%,相对增量只剩约 +43%,占位待调);概率的上夹在 sim/edictBuffs.ts
    // (总概率恒落在 [0,1])
    throttle: EDICT_THR_NONE,
    fireRateMul: 1,
    reloadMul: 1,
    heatMaxMul: 1,
    chargeRateMul: 1,
    damageMul: 1,
    hullHpAdd: 0,
    damageTakenMul: 1,
    xpMul: 1,
    magnetRadiusMul: 1,
    turnRateAdd: 0,
    cruiseSpeedMul: 1,
    boostCooldownAdd: 0,
    starCoinChanceAdd: 0.02, // 星币掉落概率 +2 个百分点(基础抬到 23% 后占位待调)
    tint: 0xb8d8f0, // 占位待调(最浅的一档冷白蓝:与"星"的语感对上)
  },
  {
    // 进阶法令(解锁才进池,见 data/unlocks.ts 的 edict-rapid 条目)。
    // 十条基础法令各占一条轴之后,**全武器伤害**是唯一没被占掉的那条 —— 也正因为它谁都吃,
    // 才配当解锁奖励。倍率取 1.15 而不是更高:5 层 ≈ ×2.01,与一把武器从 Lv1 升到 Lv5 同量级
    type: EDICT_OVERDRIVE,
    slug: 'overdrive_protocol',
    devName: '超载协议',
    throttle: EDICT_THR_NONE,
    fireRateMul: 1,
    reloadMul: 1,
    heatMaxMul: 1,
    chargeRateMul: 1,
    damageMul: 1.15, // 全武器伤害 +15%(连乘,5 层 ≈ ×2.01;占位待调)
    hullHpAdd: 0,
    damageTakenMul: 1,
    xpMul: 1,
    magnetRadiusMul: 1,
    turnRateAdd: 0,
    cruiseSpeedMul: 1,
    boostCooldownAdd: 0,
    starCoinChanceAdd: 0,
    tint: 0xa8c0ff, // 占位待调(高亮靛白:全场唯一一条碰伤害的法令,色上也该最扎眼)
  },
  {
    type: EDICT_BOOST,
    slug: 'boost_calibration',
    devName: '增压校准',
    // 机动档第三条:加速技能(空格)冷却 -0.3 秒/层(5 层 = -1.5 ⇒ 5 → 3.5s,真空期 ~3.9 → ~2.4s)。
    // 加法档取负值是这条轴的本意 —— "变强"的方向是减;触发点的 ≥ 0 夹取在 sim/world.ts。
    throttle: EDICT_THR_NONE,
    fireRateMul: 1,
    reloadMul: 1,
    heatMaxMul: 1,
    chargeRateMul: 1,
    damageMul: 1,
    hullHpAdd: 0,
    damageTakenMul: 1,
    xpMul: 1,
    magnetRadiusMul: 1,
    turnRateAdd: 0,
    cruiseSpeedMul: 1,
    boostCooldownAdd: -0.3, // 加速冷却 -0.3 秒/层(占位待调)
    starCoinChanceAdd: 0,
    tint: 0x58e0c0, // 占位待调(冷薄荷青:b > r 守住冷色审计,且与各系/各法令都不撞)
  },
];

/**
 * 层数夹取:任何按层取值的地方进门第一件事(与 data/towers.ts 的 clampLevel 同一条口径)。
 * `!(level >= 1)` 而不是 `level < 1`:**NaN 与任何数比较都是 false**,写成前者才把 NaN 一并接住 ——
 * 少了这一手,一个未初始化的层数就会顺着 Math.pow 把射速/血量全变成 NaN,
 * 而 NaN 在 checksum 里被 `| 0` 抹成 0,分叉当场就从确定性口径下漏掉了。
 * 0 是合法输入(= 没持有),故下界回落到 0 而不是 1。
 */
export function clampEdictLevel(level: number): number {
  if (!(level >= 1)) return 0;
  if (level > EDICT_MAX_LEVEL) return EDICT_MAX_LEVEL;
  return Math.floor(level);
}

/** 建一份"一条法令都没有"的层数表(World 构造时一次,此后就地改)。下标 === EDICT_* */
export function createEdictLevels(): number[] {
  return new Array<number>(EDICT_KIND_COUNT).fill(0);
}

/** 这条法令持有几层(越界 / 未持有恒 0)。层数的唯一读法,别处不许再写一遍下标夹取 */
export function edictLevel(levels: readonly number[], type: number): number {
  return clampEdictLevel(levels[type] ?? 0);
}

/** 这条法令还能不能再叠(满层 = 卡池把它剔出候选,见 sim/upgrade.ts 的 collectPool) */
export function edictCanStack(levels: readonly number[], type: number): boolean {
  return edictLevel(levels, type) < EDICT_MAX_LEVEL;
}

/** 已持有的法令条数(层数 > 0 的种类数)。HUD 的徽记行与结算卡读它 */
export function edictHeldCount(levels: readonly number[]): number {
  let n = 0;
  for (let i = 0; i < EDICT_KIND_COUNT; i++) {
    if (edictLevel(levels, i) > 0) n++;
  }
  return n;
}
