/**
 * 法令效果的全船聚合(用户设计会:支援并入法令)—— **全仓唯一一份叠加规则**。
 * 铁律 1:本目录永不 import pixi/DOM,也不用 Math.random —— 聚合只是"遍历 10 条法令层数 + 查表"的
 *   确定性算术:同一份层数表问一百遍答案都一样,Node 里拿一个纯数组就能把每一档钉住。
 * 铁律 3:结果写进**调用方给的 out**(World 持有同一个实例整局复用),本模块零分配。
 *
 * —— 两套被动合并成一套(用户设计会)——
 * 旧版是 sim/support.ts(支援槽聚合)+ data/edicts.ts 里六个散落的 edictXxx(mask) 函数**两条**
 * 取值链路,而它们加的是同一批数值(见 data/edicts.ts 文件头那段合并说明)。本文件是合并后的
 * 唯一入口:法令层数表进来,一份 EdictBuffs 出去,下游(tower / turret / damage / drop / ship)
 * 只认这一个结构 —— 于是"法令是谁、叠了几层"这件事被彻底收在这里,开火链路上再也没有
 * edictMul / edictHeatMaxMul 这类顺着签名一路传的散参。
 *
 * 叠加口径(与 data/edicts.ts 文件头一字同源,定死,别处不许另立一套):
 *   乘法档 **base^level**(2 层散热协议 = ×1.5²);加法档 **add × level**(2 层装甲协议 = +30)。
 *   每个档只归一个作用域:系限定档(fireRateMul/reloadMul/heatMaxMul/chargeRateMul)按法令的
 *   throttle 折进 THR_* 对应的那一族(弹药 0 / 过热 1 / 充能 2);全船档走 EDICT_THR_NONE 那一路。
 *   —— 数据表保证"不作用的档填中性值"(乘法 1、加法 0),故两路互不越界:路由只认 throttle,
 *   与"表里恰好填了中性值"无关,将来给某条法令补第二档效果也不会悄悄串味。
 */
import { STARCOIN_DROP_CHANCE } from '../data/economy';
import { EDICT_KIND_COUNT, EDICTS, edictLevel } from '../data/edicts';

/**
 * 一帧的全船法令聚合。**每帧由 World.step 重算一次**(10 条法令的几次 pow,便宜),
 * 再传给 sim/tower(节流取值)、sim/turret(开火节奏)、sim/damage(船体 HP / 减伤)、
 * sim/ship(转向 / 巡航)与 World 自己(经验倍率 / 磁吸半径 / 星币概率)。
 * 三族数组按下标 THR_* 直取(弹药 0 / 过热 1 / 充能 2)。
 * 它不在 checksum 里:是 edictLevels(已逐条哈过)与数据表的纯函数,哈它只是把同一件事哈两遍。
 */
export interface EdictBuffs {
  /** 本族武器:射速倍率(> 1 = 更快);每族一个 */
  fireRateMul: [number, number, number];
  /** 本族武器:装填时长倍率(< 1 = 更短) */
  reloadMul: [number, number, number];
  /** 本族武器:过热上限倍率(> 1 = 能连烧更久) */
  heatMaxMul: [number, number, number];
  /** 本族武器:充能速度倍率(> 1 = 更快,chargeTime 除它) */
  chargeRateMul: [number, number, number];
  /** **全部**武器的伤害倍率(超载协议;> 1 = 更疼) */
  damageMul: number;
  /** 船体 HP 加成(点,加法) */
  hullHp: number;
  /** 受击伤害倍率(< 1 = 减伤,连乘) */
  damageTakenMul: number;
  /** 经验获取倍率(> 1 = 每颗经验掉落进账更多,连乘) */
  xpMul: number;
  /** 磁吸半径倍率(> 1 = 起吸半径更大,连乘) */
  magnetRadiusMul: number;
  /** 转向速率加成(°/s,加法) */
  turnRateAdd: number;
  /** 巡航速度倍率(> 1 = 更快,连乘) */
  cruiseSpeedMul: number;
  /** 加速技能冷却的加减秒(加法,负值 = 更短;来自增压校准) */
  boostCooldownAdd: number;
  /**
   * 每次击杀掉星币的概率,**已含基础值**(data/economy 的 STARCOIN_DROP_CHANCE)且已夹在 [0, 1]。
   * 下游(World.onEnemyKilled)直接拿它与一次 rng 比大小,不再自己加基础值 ——
   * "基础 + 法令 + 夹取"只在本文件算一次。
   */
  starCoinChance: number;
}

/**
 * 一份"一条法令都没有"的聚合(全部中性值 + 基础星币概率)。
 * World 构造时建一次,此后每帧由 aggregateEdictBuffs 就地重写。
 */
export function createEdictBuffs(): EdictBuffs {
  return {
    fireRateMul: [1, 1, 1],
    reloadMul: [1, 1, 1],
    heatMaxMul: [1, 1, 1],
    chargeRateMul: [1, 1, 1],
    damageMul: 1,
    hullHp: 0,
    damageTakenMul: 1,
    xpMul: 1,
    magnetRadiusMul: 1,
    turnRateAdd: 0,
    cruiseSpeedMul: 1,
    boostCooldownAdd: 0,
    starCoinChance: clamp01(STARCOIN_DROP_CHANCE),
  };
}

/** 概率夹取。`> 0` 式的写法把 NaN 一并接住(NaN 与任何数比较都是 false),与 clampEdictLevel 同源 */
function clamp01(v: number): number {
  return v > 0 ? (v < 1 ? v : 1) : 0;
}

/**
 * 把当前法令层数表全量聚合成 EdictBuffs,写进 out 并返回它。
 * 每帧全量重算而不是守卫增量:法令一局只变十几次、且只有 World.grantEdict 一条来路,
 * 10 条的重算比维护一份 revision 便宜得多。
 *
 * 路由只有一句 `def.throttle >= 0`:
 *   >= 0 = 系限定(弹药/散热/电容):四个族倍率乘进 throttle 指向的那一族 ——
 *     数据表把"不作用的族档"填成 1,乘进去是恒等,循环里不需要按型号分支;
 *   -1(EDICT_THR_NONE)= 全船(装甲/增幅/磁力/重心/巡航/星图/超载):八个全船档走下面那一路。
 *
 * 层数为 0 的法令**整条跳过**:`Math.pow(x, 0) === 1` 本就是恒等,跳过只是省掉十次 pow;
 * 但 hullHp/turnRateAdd/starCoinChanceAdd 这三个加法档乘 0 也是 0,两路都不会因跳过而漏账。
 */
export function aggregateEdictBuffs(levels: readonly number[], out: EdictBuffs): EdictBuffs {
  // 全量复位成中性值:复位值是 1/0 而不是"增量累减" —— 全量重算买的是"绝不漏更新"
  out.fireRateMul[0] = out.fireRateMul[1] = out.fireRateMul[2] = 1;
  out.reloadMul[0] = out.reloadMul[1] = out.reloadMul[2] = 1;
  out.heatMaxMul[0] = out.heatMaxMul[1] = out.heatMaxMul[2] = 1;
  out.chargeRateMul[0] = out.chargeRateMul[1] = out.chargeRateMul[2] = 1;
  out.damageMul = 1;
  out.hullHp = 0;
  out.damageTakenMul = 1;
  out.xpMul = 1;
  out.magnetRadiusMul = 1;
  out.turnRateAdd = 0;
  out.cruiseSpeedMul = 1;
  out.boostCooldownAdd = 0;
  let starChance = STARCOIN_DROP_CHANCE;

  for (let i = 0; i < EDICT_KIND_COUNT; i++) {
    const n = edictLevel(levels, i); // 夹取在这里做一次:下面的 pow/乘法都吃夹过的层数
    if (n <= 0) continue;
    const def = EDICTS[i];
    if (!def) continue; // 表被裁短(数值表改坏):跳过而不是把 undefined 乘进全船
    if (def.throttle >= 0) {
      const thr = def.throttle;
      out.fireRateMul[thr] = out.fireRateMul[thr]! * Math.pow(def.fireRateMul, n);
      out.reloadMul[thr] = out.reloadMul[thr]! * Math.pow(def.reloadMul, n);
      out.heatMaxMul[thr] = out.heatMaxMul[thr]! * Math.pow(def.heatMaxMul, n);
      out.chargeRateMul[thr] = out.chargeRateMul[thr]! * Math.pow(def.chargeRateMul, n);
    } else {
      out.damageMul *= Math.pow(def.damageMul, n);
      out.hullHp += def.hullHpAdd * n; // 加法档:HP 是点数,不是比例
      out.damageTakenMul *= Math.pow(def.damageTakenMul, n);
      out.xpMul *= Math.pow(def.xpMul, n);
      out.magnetRadiusMul *= Math.pow(def.magnetRadiusMul, n);
      out.turnRateAdd += def.turnRateAdd * n; // 加法档
      out.cruiseSpeedMul *= Math.pow(def.cruiseSpeedMul, n);
      out.boostCooldownAdd += def.boostCooldownAdd * n; // 加法档(负值 = 冷却更短)
      starChance += def.starCoinChanceAdd * n; // 加法档(绝对概率点数)
    }
  }
  // 夹取只在出门这一处:下游拿到的 starCoinChance 恒落在 [0,1],不必再判一次
  out.starCoinChance = clamp01(starChance);
  return out;
}
