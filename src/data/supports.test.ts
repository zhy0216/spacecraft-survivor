/**
 * 支援设施数值表(06 号 issue T2)的表级不变量。
 * 与 data/towers.test.ts 同口径:钉的不是邻接规则(那在 sim/support.ts 里,靠 neighborCell 判正交四邻),
 * 而是**数据表本身的口径** —— 下标即 type、GDD §5.3 的四行效果、"一设施只认一系"的匹配矩阵、
 * 装甲舱那条例外(不作用于相邻塔),以及冷色域与六塔不撞色。
 *
 * 后续调平衡时随便改数字是被鼓励的(那正是本表存在的理由),但改坏这几条就是改坏了机制本身:
 * 比如给散热器补一档 fireRateMul,它就同时是一座弹药库;
 * 比如把某个不用的乘法档从 1 改成 0,相邻塔的热上限会被连乘当场抹成 0;
 * 比如让两种设施认同一个 throttle,"四选一"的取舍就塌成了"随便放哪个都行"。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  SUP_AMMO_BAY,
  SUP_ARMOR_BAY,
  SUP_CAPACITOR,
  SUP_RADIATOR,
  SUPPORT_KIND_COUNT,
  SUPPORT_THR_NONE,
  supportAffects,
  type SupportDef,
  SUPPORTS,
} from './supports';
import { THR_AMMO, THR_CHARGE, THR_HEAT, TOWERS } from './towers';

/** 最后一条用例要临时改弹药库射速档(验证表可写),跑完必须还原,否则污染同文件后续用例 */
const BASE_FIRE_RATE_MUL = SUPPORTS[SUP_AMMO_BAY]!.fireRateMul;
afterEach(() => {
  SUPPORTS[SUP_AMMO_BAY]!.fireRateMul = BASE_FIRE_RATE_MUL;
});

/** 六个效果档 + 各自的中性值。"没用上"必须**恰好**等于中性值,残值会被连乘/求和放大 */
const EFFECTS: Array<[string, (d: SupportDef) => number, number]> = [
  ['fireRateMul', (d) => d.fireRateMul, 1],
  ['reloadMul', (d) => d.reloadMul, 1],
  ['heatMaxMul', (d) => d.heatMaxMul, 1],
  ['chargeRateMul', (d) => d.chargeRateMul, 1],
  ['hullHp', (d) => d.hullHp, 0], // 唯一的加法档 ⇒ 中性值是 0 而不是 1
  ['edgeDamageMul', (d) => d.edgeDamageMul, 1],
];

/** 下标 === type:每种设施**该动**的档;表里其余档必须原封不动躺在中性值上 */
const ACTIVE_FIELDS: string[][] = [
  ['fireRateMul', 'reloadMul'], // 弹药库
  ['heatMaxMul'], // 散热器
  ['chargeRateMul'], // 电容组
  ['hullHp', 'edgeDamageMul'], // 装甲舱
];

describe('支援设施数值表', () => {
  it('下标 === type:sim/render 靠 SUPPORTS[cell.supportType] 直取,错一位就全设施串味', () => {
    expect(SUPPORTS.length).toBe(SUPPORT_KIND_COUNT);
    expect(SUPPORT_KIND_COUNT).toBe(4); // GDD §5.3 的 MVP 四种(1.0 目标 8 种)
    SUPPORTS.forEach((def, i) => expect(def.type).toBe(i));
    expect(SUPPORTS[SUP_AMMO_BAY]!.name).toBe('弹药库');
    expect(SUPPORTS[SUP_RADIATOR]!.name).toBe('散热器');
    expect(SUPPORTS[SUP_CAPACITOR]!.name).toBe('电容组');
    expect(SUPPORTS[SUP_ARMOR_BAY]!.name).toBe('装甲舱');
  });

  it('四种名字互不相同:放置提示从本表现生成,重名就是两个点不出区别的选项', () => {
    // ui 里不抄第二份名字(改数据表自动跟上),于是"能不能选对"完全押在这一列上
    expect(new Set(SUPPORTS.map((d) => d.name)).size).toBe(SUPPORT_KIND_COUNT);
    for (const def of SUPPORTS) expect(def.name.length).toBeGreaterThan(0);
  });

  it('GDD §5.3 的四行效果逐条对得上,且倍率方向没写反', () => {
    const ammo = SUPPORTS[SUP_AMMO_BAY]!;
    expect(ammo.fireRateMul).toBe(1.25); // 相邻弹药系:射速 +25%
    expect(ammo.reloadMul).toBe(0.7); // 装填 -30%
    expect(SUPPORTS[SUP_RADIATOR]!.heatMaxMul).toBe(1.5); // 相邻过热系:过热上限 +50%
    expect(SUPPORTS[SUP_CAPACITOR]!.chargeRateMul).toBe(1.3); // 相邻充能系:充能速度 +30%
    const armor = SUPPORTS[SUP_ARMOR_BAY]!;
    expect(armor.hullHp).toBe(15); // 船体 HP +15
    expect(armor.edgeDamageMul).toBe(0.8); // 所在舷受撞伤害 -20%

    // 方向读反一次,"增益"就成了减益,而四个倍率的取值链路各不相同(有的乘有的除有的当上限),
    // 光看数字看不出谁该大于 1 —— 所以在数据这一层就把方向钉死
    expect(ammo.fireRateMul).toBeGreaterThan(1); // 乘在射速上:越大越快
    expect(ammo.reloadMul).toBeLessThan(1); // 乘在装填**时长**上:越小越短
    expect(SUPPORTS[SUP_RADIATOR]!.heatMaxMul).toBeGreaterThan(1); // 乘在热上限上:越大越能烧
    expect(SUPPORTS[SUP_CAPACITOR]!.chargeRateMul).toBeGreaterThan(1); // chargeTime 除它:越大越快
    expect(armor.hullHp).toBeGreaterThan(0); // 加在 HP 上限上
    expect(armor.edgeDamageMul).toBeLessThan(1); // 乘在受撞伤害上:越小越硬
    // 且没有一个倍率 ≤ 0:连乘口径的前提就是这个(负倍率会把装填/伤害算成负数)
    for (const def of SUPPORTS) {
      for (const [name, get, neutral] of EFFECTS) {
        if (neutral !== 1) continue; // 加法档不吃这条
        expect(get(def), `${def.name}.${name}`).toBeGreaterThan(0);
      }
    }
  });

  it('装甲舱 throttle = SUPPORT_THR_NONE:不作用于任何相邻塔 ⇒ 永远不产生连线', () => {
    const armor = SUPPORTS[SUP_ARMOR_BAY]!;
    expect(armor.throttle).toBe(SUPPORT_THR_NONE);
    // 落在 THR_*(0/1/2)的编号之外,supportAffects 一句 `>= 0` 就把整类挡在门外
    expect(SUPPORT_THR_NONE).toBeLessThan(0);
    for (const thr of [THR_AMMO, THR_HEAT, THR_CHARGE]) {
      expect(SUPPORT_THR_NONE).not.toBe(thr);
    }
    // 对六塔全员恒 false ⇒ 它进不了 supportLinks ⇒ UI 画不出线来(画了就是误导)
    for (const def of TOWERS) expect(supportAffects(armor, def), def.name).toBe(false);
  });

  it('只有装甲舱的 hullHp/edgeDamageMul 非中性:船体档是全甲板求和/连乘,残值会被放大', () => {
    for (const def of SUPPORTS) {
      const isArmor = def.type === SUP_ARMOR_BAY;
      // hullHp 是加法档:另外三种留个 +1 就是白送三点船血,还随格数线性膨胀
      expect(def.hullHp !== 0, def.name).toBe(isArmor);
      // edgeDamageMul 是连乘档:留个 0.99 就是每格偷偷减伤,而它压根不在 GDD §5.3 里
      expect(def.edgeDamageMul !== 1, def.name).toBe(isArmor);
    }
    // 反过来,装甲舱的四个邻接倍率整段恒等 —— 它连 link 都不产生,留残值就是一笔永远读不出来的账
    const armor = SUPPORTS[SUP_ARMOR_BAY]!;
    expect(armor.fireRateMul).toBe(1);
    expect(armor.reloadMul).toBe(1);
    expect(armor.heatMaxMul).toBe(1);
    expect(armor.chargeRateMul).toBe(1);
  });

  it('三种节流系设施各自只对一种 throttle 生效(TOWERS × SUPPORTS 矩阵与 GDD §5.3 一致)', () => {
    const OWNED: Array<[number, number]> = [
      [SUP_AMMO_BAY, THR_AMMO],
      [SUP_RADIATOR, THR_HEAT],
      [SUP_CAPACITOR, THR_CHARGE],
    ];
    for (const [sup, thr] of OWNED) {
      const def = SUPPORTS[sup]!;
      expect(def.throttle, def.name).toBe(thr);
      for (const tower of TOWERS) {
        // 命中**当且仅当**同系:这就是 GDD §4.3 的"类型不匹配无效果",
        // 且整个游戏里只由 supportAffects 这一个函数判(UI 连线与 buff 计算读的是同一份)
        const want = tower.throttle === thr;
        expect(supportAffects(def, tower), `${def.name} × ${tower.name}`).toBe(want);
      }
      // 六塔三系各两座 + 17 号六座进化塔继承基塔节流系 ⇒ 每种节流系设施恰好带得动四座塔
      // (进化后继续吃邻接,17 号口径;基塔带得动的那两座是"判定机制"的锚点,见 towers.test.ts)
      expect(TOWERS.filter((t) => supportAffects(def, t)).length, def.name).toBe(4);
    }

    // 每座塔恰好被**一种**设施认领:0 就是有塔配不到设施,2 就是两种设施重叠、四选一的取舍塌掉
    for (const tower of TOWERS) {
      expect(SUPPORTS.filter((s) => supportAffects(s, tower)).length, tower.name).toBe(1);
    }
    // 三种节流系设施的 throttle 互不相同(装甲舱不在此列,它压根不认系)
    const throttles = SUPPORTS.map((d) => d.throttle).filter((t) => t >= 0);
    expect(new Set(throttles).size).toBe(throttles.length);
  });

  it('不用的乘法档一律填 1、加法档填 0:每种设施只在自己那一列上非中性', () => {
    // 与 data/towers.ts 的 growth 一段同源:0 作乘数是"归零",会把相邻塔的射速/热上限
    // 直接抹成 0,与"这一档用不上"是两码事;而加法档留 1 是白送,同样不是"用不上"
    SUPPORTS.forEach((def, i) => {
      const active = new Set(ACTIVE_FIELDS[i]!);
      for (const [name, get, neutral] of EFFECTS) {
        const label = `${def.name}.${name}`;
        if (active.has(name)) expect(get(def), label).not.toBe(neutral);
        else expect(get(def), label).toBe(neutral);
      }
    });
  });

  it('四色互不相同、一律冷色,且不与六塔的 tint 撞色(连线颜色取的就是它)', () => {
    for (const def of SUPPORTS) {
      const r = (def.tint >> 16) & 0xff;
      const b = def.tint & 0xff;
      // 门槛比 towers.test.ts 松一档:装甲舱刻意是低饱和钢蓝(结构件不抢输出件的高饱和),
      // 但"蓝强于红"这条敌我色域分离的底线(GDD §12)四种一个都不许破
      expect(b, def.name).toBeGreaterThan(r);
    }
    expect(new Set(SUPPORTS.map((d) => d.tint)).size).toBe(SUPPORT_KIND_COUNT);

    // 与六塔撞色 = 甲板上一格设施和一座塔涂成同一个颜色,连线两端就读不出谁是谁
    const towerTints = new Set(TOWERS.map((d) => d.tint));
    for (const def of SUPPORTS) expect(towerTints.has(def.tint), def.name).toBe(false);
  });

  it('表是可写的:单测能临时改字段再还原(没有 readonly,也没 Object.freeze)', () => {
    // "改数据文件即可调平衡"(todos/05 验收口径)的机械保证:
    // 冻表会让后续验证"邻接加成可配"的用例无从下手,也会让调参面板失去落点
    const ammo = SUPPORTS[SUP_AMMO_BAY]!;
    ammo.fireRateMul = 2;
    expect(SUPPORTS[SUP_AMMO_BAY]!.fireRateMul).toBe(2);
  });
});
