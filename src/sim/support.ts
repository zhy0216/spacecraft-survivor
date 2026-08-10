/**
 * 支援效果的全船聚合(改版 06 号 —— 甲板删除后的重写)—— **全仓唯一一份叠加规则**。
 * 铁律 1:本目录永不 import pixi/DOM,也不用 Math.random —— 聚合只是"遍历 4 个支援槽 + 查表"的
 *   确定性算术:同一组槽位问一百遍答案都一样,Node 里拿一个纯对象就能把每一格钉住。
 * 铁律 3:结果写进**调用方给的 out**(World 持有同一个实例整局复用),本模块零分配。
 *
 * —— 邻接 → 全船的语义替换(用户设计会)——
 * 旧版支援是"甲板格 + 正交邻接"(弹药库给相邻的弹药系塔加射速),随网格一起删除。
 * 新语义:**支援槽 = 全船被动**,每持有一个支援,按它的作用系给**全船所有**同类武器/船体一个
 * 全局效果;重复持有连乘/连加(两座弹药库 = 弹药系射速 ×1.25²)。于是不再有"邻接""所在舷"
 * 这些空间概念 —— 效果从"摆在哪里"解耦,只数"持有了几个"。
 *
 * 叠加口径(与 data/supports 文件头那段一字同源,定死,别处不许另立一套):
 *   乘法档一律**连乘**(两座弹药库 = ×1.25²,推不到 ≤ 0);
 *   **只有 hullHp 是加法**(两座装甲舱 = +30):它是点数,不是比例。
 *   每个档只归一个作用域:系限定档(fireRateMul/reloadMul/heatMaxMul/chargeRateMul)按
 *   支援的 throttle 折进 THR_* 对应的那一个族(弹药 0 / 过热 1 / 充能 2);
 *   全船档(hullHp/damageTakenMul/xpMul/magnetRadiusMul)走 SUPPORT_THR_NONE(-1)那一路。
 *   —— 数据表保证"不作用的档填中性值"(乘法 1、加法 0),故这两路互不越界:
 *   系限定的支援把全船档填成中性,全船的支援把系限定档填成中性 —— 路由只认 throttle,
 *   与"表里恰好填了中性值"无关,将来给某座支援补第二档效果也不会悄悄串味。
 */
import { SUPPORTS } from '../data/supports';
import type { SupportSlot } from './armory';

/**
 * 一帧的全船支援聚合。**每帧由 World.step 重算一次**(4 个槽的几遍乘法,便宜),
 * 再传给 sim/turret(开火节奏)、sim/tower(节流包装)、sim/damage(船体 HP/减伤)
 * 与 World 自己(经验倍率 / 磁吸半径)。三组数组按下标 THR_* 直取(弹药 0 / 过热 1 / 充能 2)。
 * 它不在 checksum 里:是 supports(已逐槽哈希)与数据表的纯函数,哈它只是把同一件事哈两遍。
 */
export interface SupportBuffs {
  /** 本族武器:射速倍率(> 1 = 更快);每族一个 */
  fireRateMul: [number, number, number];
  /** 本族武器:装填时长倍率(< 1 = 更短) */
  reloadMul: [number, number, number];
  /** 本族武器:过热上限倍率(> 1 = 能连烧更久) */
  heatMaxMul: [number, number, number];
  /** 本族武器:充能速度倍率(> 1 = 更快,chargeTime 除它) */
  chargeRateMul: [number, number, number];
  /** 船体 HP 加成(点,加法) */
  hullHp: number;
  /** 受击伤害倍率(< 1 = 减伤,连乘) */
  damageTakenMul: number;
  /** 经验获取倍率(> 1 = 每颗经验掉落进账更多,连乘) */
  xpMul: number;
  /** 磁吸半径倍率(> 1 = 起吸半径更大,连乘) */
  magnetRadiusMul: number;
}

/** 一份"没有支援"的聚合(全部中性值)。World 构造时建一次,此后每帧由 aggregate 就地重写 */
export function createSupportBuffs(): SupportBuffs {
  return {
    fireRateMul: [1, 1, 1],
    reloadMul: [1, 1, 1],
    heatMaxMul: [1, 1, 1],
    chargeRateMul: [1, 1, 1],
    hullHp: 0,
    damageTakenMul: 1,
    xpMul: 1,
    magnetRadiusMul: 1,
  };
}

/**
 * 把当前支援槽全量聚合成 SupportBuffs,写进 out 并返回它。
 * 每帧全量重算而不是守卫增量:槽位一局只变几次、且只有 World.acquireSupport 一条来路,
 * 4 个槽的重算比维护一份 revision 便宜得多(旧版邻接那套守卫是几十格的遍历,这里不需要)。
 *
 * 路由只有一句 `sup.throttle >= 0`:
 *   >= 0 = 系限定(弹药/散热/电容):四个族倍率乘进 throttle 指向的那一族 ——
 *     数据表把"不作用的族档"填成 1,乘进去是恒等,循环里不需要按型号分支;
 *   -1(SUPPORT_THR_NONE)= 全船(装甲舱/经验增幅器/磁力收集器):四个全船档走下面那一路。
 */
export function aggregateSupportBuffs(supports: readonly SupportSlot[], out: SupportBuffs): SupportBuffs {
  // 全量复位成中性值(与旧版 recomputeSupportBuffs 的"逐格复位成 1"同一条口径):
  // 复位值是 1/0 而不是"增量累减" —— 全量重算买的是"绝不漏更新"。
  out.fireRateMul[0] = out.fireRateMul[1] = out.fireRateMul[2] = 1;
  out.reloadMul[0] = out.reloadMul[1] = out.reloadMul[2] = 1;
  out.heatMaxMul[0] = out.heatMaxMul[1] = out.heatMaxMul[2] = 1;
  out.chargeRateMul[0] = out.chargeRateMul[1] = out.chargeRateMul[2] = 1;
  out.hullHp = 0;
  out.damageTakenMul = 1;
  out.xpMul = 1;
  out.magnetRadiusMul = 1;

  for (let i = 0; i < supports.length; i++) {
    // 非支援槽恒 type -1,而 SUPPORTS[-1] 本就是 undefined ⇒ **一次取表**就同时挡掉了空槽与越界
    const sup = SUPPORTS[supports[i]!.type];
    if (!sup) continue;
    if (sup.throttle >= 0) {
      const thr = sup.throttle;
      out.fireRateMul[thr] = out.fireRateMul[thr]! * sup.fireRateMul;
      out.reloadMul[thr] = out.reloadMul[thr]! * sup.reloadMul;
      out.heatMaxMul[thr] = out.heatMaxMul[thr]! * sup.heatMaxMul;
      out.chargeRateMul[thr] = out.chargeRateMul[thr]! * sup.chargeRateMul;
    } else {
      out.hullHp += sup.hullHp; // 唯一加法档:HP 是点数,不是比例
      out.damageTakenMul *= sup.damageTakenMul;
      out.xpMul *= sup.xpMul;
      out.magnetRadiusMul *= sup.magnetRadiusMul;
    }
  }
  return out;
}
