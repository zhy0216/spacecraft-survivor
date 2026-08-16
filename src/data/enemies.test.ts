/**
 * 敌人数值表(07 号 issue T2)的表级不变量。
 * 钉的不是行为逻辑(那在 sim/ 里),而是数据表本身的口径:下标即 kind、
 * 冲锋段与 behavior 自洽、驻留方位对得上各自的方向压力、敌我色域分离、
 * ENEMY_RADIUS_MAX → 空间哈希 cell 的推导链。
 * 后续调平衡时随便改数字是被鼓励的,但改坏这几条就是改坏了机制本身。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { tuning } from '../sim/config';
import { ELITE } from './affixes';
import {
  BOSS,
  BH_SEEK,
  BH_SEEK_CHARGE,
  BH_SPORE,
  BH_STRAFE,
  BH_STRAFE_CHARGE,
  ENEMIES,
  ENEMY_KIND_COUNT,
  ENEMY_RADIUS_MAX,
  KIND_BEETLE,
  KIND_BOSS,
  KIND_SPORE,
  KIND_STRAFER,
  KIND_SWARM,
  KIND_TRAILER,
  ZONE_HP_MULT,
} from './enemies';

// 最后一条用例要临时改前摇(验证表可写),跑完必须还原,否则污染同文件后续用例
const BASE_WINDUP = ENEMIES[KIND_BEETLE]!.chargeWindup;
afterEach(() => {
  ENEMIES[KIND_BEETLE]!.chargeWindup = BASE_WINDUP;
});

describe('敌人数值表', () => {
  it('下标 === kind:状态机靠 ENEMIES[e.kind] 直取,错一位就全型串味', () => {
    expect(ENEMIES.length).toBe(ENEMY_KIND_COUNT);
    ENEMIES.forEach((def, i) => expect(def.kind).toBe(i));
    // 03 号:数据一致性测试断言稳定 ID(slug),中文显示名走 presenter 查翻译
    expect(ENEMIES[KIND_SWARM]!.slug).toBe('swarm_leech');
    expect(ENEMIES[KIND_STRAFER]!.slug).toBe('side_raider');
    expect(ENEMIES[KIND_TRAILER]!.slug).toBe('tail_maggot');
    expect(ENEMIES[KIND_BEETLE]!.slug).toBe('ram_beetle');
  });

  it('slug 稳定 ID:全表唯一、小写下划线,与 kind 一一对应;Boss 用独立标识(03 号)', () => {
    // slug 是翻译/编辑器身份;数值 kind 才是存档与模拟身份 —— 顺序必须与 KIND_* 常量一致,
    // 错一位 presenter 就会拿 A 型的 slug 去翻 B 型的名字
    const SLUGS = ['swarm_leech', 'side_raider', 'tail_maggot', 'ram_beetle', 'spore_gunner'];
    expect(ENEMIES.length).toBe(SLUGS.length);
    ENEMIES.forEach((def, i) => {
      expect(def.slug, `下标 ${i} 的 slug 必须与顺序表一致`).toBe(SLUGS[i]);
      expect(def.slug, `下标 ${i} 的 slug 是小写下划线`).toMatch(/^[a-z][a-z0-9_]*$/);
    });
    expect(new Set(SLUGS).size).toBe(SLUGS.length);
    // Boss 不进 ENEMIES 表(见 KIND_BOSS 注释),slug 用独立标识,且不与表内任何敌型撞车
    expect(BOSS.slug).toBe('hive_colossus');
    expect(BOSS.slug).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(SLUGS).not.toContain(BOSS.slug);
  });

  it('GDD §14 锁定值不会被"顺手调平衡"改掉', () => {
    const swarm = ENEMIES[KIND_SWARM]!;
    expect(swarm.hp).toBe(8);
    expect(swarm.contactDamage).toBe(5);
    expect(swarm.speed).toBe(80);

    const strafer = ENEMIES[KIND_STRAFER]!;
    expect(strafer.hp).toBe(20);
    expect(strafer.contactDamage).toBe(10);
    expect(strafer.chargeSpeed).toBe(220); // §14 的 220 是冲刺速,不是接近速度
  });

  it('ENEMY_RADIUS_MAX = 表里最大半径,且 tuning 从它推导(空间哈希 cell = ×2)', () => {
    let max = 0;
    for (const def of ENEMIES) max = Math.max(max, def.radius);
    expect(ENEMY_RADIUS_MAX).toBe(max);
    // 写死在 config 里就会在加新敌型时悄悄失配:cell 小于最大半径,3×3 邻域不再覆盖查询半径
    expect(tuning.enemyRadiusMax).toBe(ENEMY_RADIUS_MAX);
  });

  it('冲锋段与 behavior 自洽:该冲的参数齐,不冲的一律 0', () => {
    for (const def of ENEMIES) {
      const charges = def.behavior === BH_SEEK_CHARGE || def.behavior === BH_STRAFE_CHARGE;
      if (charges) {
        expect(def.chargeRange).toBeGreaterThan(0);
        expect(def.chargeWindup).toBeGreaterThan(0); // 前摇 = "看得懂、来得及躲"的唯一来源
        expect(def.chargeSpeed).toBeGreaterThan(def.speed); // 不比接近速度快就不叫冲刺
        expect(def.chargeDuration).toBeGreaterThan(0);
      } else {
        // 不冲的敌型留着非 0 冲锋参数,渲染层的前摇指示就会对着永不冲锋的敌人闪
        expect(def.chargeRange).toBe(0);
        expect(def.chargeWindup).toBe(0);
        expect(def.chargeSpeed).toBe(0);
        expect(def.chargeDuration).toBe(0);
        expect(def.chargeRecover).toBe(0);
      }
    }
  });

  it('驻留方位角对得上各自的方向压力(07 验收:侧掠者走舷侧、尾随蛆占船尾)', () => {
    const strafer = ENEMIES[KIND_STRAFER]!;
    expect(strafer.behavior).toBe(BH_STRAFE_CHARGE);
    expect(strafer.strafeOffsetDeg).toBe(90); // ±90° = 舷侧,左右舷由 e.side 生成时定死
    expect(strafer.strafeRadius).toBeGreaterThan(0);

    const trailer = ENEMIES[KIND_TRAILER]!;
    expect(trailer.behavior).toBe(BH_STRAFE);
    expect(trailer.strafeOffsetDeg).toBe(180); // 船尾正后方 = 惩罚死角舷

    expect(ENEMIES[KIND_SWARM]!.behavior).toBe(BH_SEEK); // 直线追船,不绕
  });

  it('冲撞甲虫的前摇够玩家转 90°(07 验收"来得及转向躲避")', () => {
    const beetle = ENEMIES[KIND_BEETLE]!;
    expect(beetle.behavior).toBe(BH_SEEK_CHARGE);
    // 船 100°/s × 0.9s = 90°:前摇期间足够把船身转出冲锋直线。
    // 这条挂在 shipTurnRate 上而不是写死 0.9 —— 转向速率一旦调慢,前摇就得跟着加长
    expect(beetle.chargeWindup * tuning.shipTurnRate).toBeGreaterThanOrEqual(90);
  });

  it('敌我色域分离:红紫暖色,绿分量被压住(GDD §12,冷色船体是 0x7fc4ff)', () => {
    for (const def of ENEMIES) {
      const r = (def.tint >> 16) & 0xff;
      const g = (def.tint >> 8) & 0xff;
      expect(r).toBeGreaterThanOrEqual(0xb0); // 红分量必须强
      // 蓝不设限(紫色本就蓝分量高),但绿一高就滑向冷色/自然色,千单位同屏就分不清敌我了
      expect(g).toBeLessThanOrEqual(0x8c);
    }
  });

  it('残骸掉落值是 ≥0 的整数,且不是全 0(10 号经济的记账前提)', () => {
    // 整数:残骸是全程唯一成长资源,升级曲线按整点记账 —— 一旦掉出 0.5 颗,
    // "离下一次升级还差几只怪"这条读数就变成没法验的近似,scrap 也不再恒是整数。
    // 这条只钉口径不钉具体数值:四个数是占位,调平衡时随便改是被鼓励的(todos/05 的验收口径)
    for (const def of ENEMIES) {
      expect(Number.isInteger(def.scrap)).toBe(true);
      expect(def.scrap).toBeGreaterThanOrEqual(0);
    }
    // 全 0 的表能通过上面每一条,却让整局一颗残骸都攒不出来 —— 升级流程从此永远不触发,
    // 而症状是"玩了十分钟没弹过卡",不会有任何一处报错
    expect(ENEMIES.some((def) => def.scrap > 0)).toBe(true);
  });

  it('普通敌人星币面额为 1/2/2/4/3,且所有面额都是非负整数', () => {
    expect(ENEMIES.map((def) => def.starCoins)).toEqual([1, 2, 2, 4, 3]);
    for (const def of ENEMIES) {
      expect(Number.isInteger(def.starCoins)).toBe(true);
      expect(def.starCoins).toBeGreaterThanOrEqual(0);
    }
    expect(ELITE.starCoins).toBe(15); // 原 10:2026-08-15 随精英威胁加压(hpMul 12/接触 ×2)抬面额
    expect(BOSS.starCoins).toBe(30);
  });

  it('HP 时间缩放口径来自 GDD §14,单地图星区乘数固定 ×1', () => {
    expect(tuning.enemyHpScalePerMinute).toBe(0.09);
    expect(ZONE_HP_MULT).toBe(1);
  });

  it('表是可写的:单测能临时改字段再还原(没有 readonly,也没 Object.freeze)', () => {
    // "改数据文件即可调平衡"(todos/05 验收口径)的机械保证:
    // 冻表会让后续验证"前摇时长可配"的用例无从下手
    ENEMIES[KIND_BEETLE]!.chargeWindup = 0.2;
    expect(ENEMIES[KIND_BEETLE]!.chargeWindup).toBe(0.2);
  });

  it('孢子炮手:编号追加在末尾、下标 === kind,旧四型的 kind 一字没动', () => {
    expect(KIND_SPORE).toBe(ENEMY_KIND_COUNT - 1); // 追加位:表尾
    expect(ENEMIES[KIND_SPORE]!.kind).toBe(KIND_SPORE);
    expect(ENEMIES[KIND_SPORE]!.slug).toBe('spore_gunner');
    // 既有四型的下标与编号必须原样(其它 agent 的用例按 0-3 钉死)
    expect(ENEMIES[KIND_SWARM]!.kind).toBe(0);
    expect(ENEMIES[KIND_STRAFER]!.kind).toBe(1);
    expect(ENEMIES[KIND_TRAILER]!.kind).toBe(2);
    expect(ENEMIES[KIND_BEETLE]!.kind).toBe(3);
  });

  it('Boss 标记恒在表外:KIND_BOSS 不许与任何表内 kind 撞车', () => {
    // 22 号把表长从 4 推到 5 时,Boss 标记(原 4)必须让位 —— 撞车的症状是
    // "孢子被当 Boss 召唤/缩放",这类 bug 只在特定 seed 下露馅,极难查
    expect(KIND_BOSS).toBe(ENEMY_KIND_COUNT); // 越界哨兵 = 表长,天然落在表外
    for (const def of ENEMIES) {
      expect(def.kind).not.toBe(KIND_BOSS);
    }
  });

  it('Boss 召唤表长度 = ENEMY_KIND_COUNT(照抄 WaveBurst.counts 的钉法)', () => {
    // 短一位就会静默漏掉一型(noUncheckedIndexedAccess 拦不住数据表写短):
    // 加敌型忘补召唤表时,[4] 读出 undefined 被召唤循环当 0,不会报任何错
    expect(BOSS.summonCounts.length).toBe(ENEMY_KIND_COUNT);
  });

  it('孢子炮手:远程字段自洽 —— 行为是 BH_SPORE、不冲锋、弹幕参数齐全且为正', () => {
    const spore = ENEMIES[KIND_SPORE]!;
    expect(spore.behavior).toBe(BH_SPORE);
    // 远程型不冲锋:冲锋段全 0(渲染层的前摇指示不会对着它闪)
    expect(spore.chargeRange).toBe(0);
    expect(spore.chargeWindup).toBe(0);
    expect(spore.chargeSpeed).toBe(0);
    expect(spore.chargeDuration).toBe(0);
    expect(spore.chargeRecover).toBe(0);
    // 弹幕参数必须齐全:少了任何一个,状态机/发射侧读到的就是 0(静默哑火,最难查)
    expect(spore.sporeRange).toBeGreaterThan(0);
    expect(spore.sporeMinRange).toBeGreaterThan(0);
    expect(spore.sporeMinRange).toBeLessThan(spore.sporeRange); // 距离带下界 < 上界,带才有宽度
    expect(spore.sporeInterval).toBeGreaterThan(0);
    expect(spore.sporeWarnTime).toBeGreaterThan(0);
    expect(spore.sporeSpeed).toBeGreaterThan(0);
    expect(spore.sporeDamage).toBeGreaterThan(0);
    expect(Number.isInteger(spore.sporeSalvoCount)).toBe(true);
    expect(spore.sporeSalvoCount).toBeGreaterThanOrEqual(1);
    expect(spore.sporeSpreadDeg).toBeGreaterThanOrEqual(0);
    // 非远程型:弹幕字段全 0(不留残值,渲染层的蓄力环不会对着它们画)
    for (const def of ENEMIES) {
      if (def.behavior === BH_SPORE) continue;
      expect(def.sporeRange).toBe(0);
      expect(def.sporeMinRange).toBe(0);
      expect(def.sporeInterval).toBe(0);
      expect(def.sporeWarnTime).toBe(0);
      expect(def.sporeSpeed).toBe(0);
      expect(def.sporeDamage).toBe(0);
      expect(def.sporeSalvoCount).toBe(0);
      expect(def.sporeSpreadDeg).toBe(0);
    }
  });

  it('孢子炮手的 tint 也在红紫暖色域内(GDD §12 敌我色域分离)', () => {
    const spore = ENEMIES[KIND_SPORE]!;
    const r = (spore.tint >> 16) & 0xff;
    const g = (spore.tint >> 8) & 0xff;
    expect(r).toBeGreaterThanOrEqual(0xb0);
    expect(g).toBeLessThanOrEqual(0x8c);
  });
});
