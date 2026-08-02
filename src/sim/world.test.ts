/**
 * 本文件在 Node 环境运行,这本身就是"sim 不依赖 Pixi/DOM"的验证(01 号 issue)。
 *
 * 单只敌人的行为(状态机/前摇/冲刺锁定)在 enemy.test.ts 钉;这里钉的是**世界这一层的接线**:
 * step 的顺序、出怪混型的随机序列、接触检测只检测不结算、死亡回收的下标坑与掉落挂钩。
 *
 * 07 验收标准里可自动化的那几条也钉在这里(T5):它们的口径都是"一整个世界连着跑若干秒",
 * 单只敌人的用例复现不出来 —— 方向压力得有一艘真在机动的船,HP 时间缩放得真跑到第 5 分钟。
 * 唯独"1000 只蜂群蛭同屏 60fps"是真机浏览器的事,Node 里量不出帧率,不在这里假装验过。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SIM_DT, SIM_HZ } from '../core/loop';
import { ENEMIES, KIND_BEETLE, KIND_STRAFER, KIND_SWARM, KIND_TRAILER } from '../data/enemies';
import { tuning } from './config';
import { type Enemy, ST_APPROACH, ST_DASH, ST_WINDUP } from './enemy';
import { DEG2RAD, type ShipCommand, type Vec2, wrapAngle } from './ship';
import { World } from './world';

// 测试用小规模(压测数量是浏览器场景的事,这里只验证逻辑正确性)。
// 与 ship.test.ts 同口径:有用例会拖数量/占比/分离半径,跑完必须还原,否则污染同文件后续用例
const BASE = {
  stressEnemies: 300,
  stressBullets: 100,
  enemySeparation: 14,
  enemySpeedScale: 1,
  enemyHpScalePerMinute: 0.09,
  shipContactRadius: 56,
  enemyMixSwarm: 70,
  enemyMixStrafer: 15,
  enemyMixTrailer: 10,
  enemyMixBeetle: 5,
};
Object.assign(tuning, BASE);
/** 有用例要临时改甲虫前摇(证明"时长可配"),与 enemy.test.ts 同口径:跑完必须还原 */
const BASE_BEETLE_WINDUP = ENEMIES[KIND_BEETLE]!.chargeWindup;
afterEach(() => {
  Object.assign(tuning, BASE);
  ENEMIES[KIND_BEETLE]!.chargeWindup = BASE_BEETLE_WINDUP;
});

/** 只出某一型:验收混型逻辑时才好把断言写死(其余三型权重归零 = 面板上"只看一型"的用法) */
function onlyKind(kind: number): void {
  tuning.enemyMixSwarm = kind === KIND_SWARM ? 100 : 0;
  tuning.enemyMixStrafer = kind === KIND_STRAFER ? 100 : 0;
  tuning.enemyMixTrailer = kind === KIND_TRAILER ? 100 : 0;
  tuning.enemyMixBeetle = kind === KIND_BEETLE ? 100 : 0;
}

describe('World 确定性', () => {
  it('同 seed 同 tick 数 → checksum 相同(01 号 issue 验收)', () => {
    const a = new World(123);
    const b = new World(123);
    for (let i = 0; i < 120; i++) {
      a.step();
      b.step();
    }
    expect(a.enemies.size).toBe(300);
    expect(a.bullets.size).toBe(100);
    expect(a.checksum()).toBe(b.checksum());
  });

  it('不同 seed → checksum 不同', () => {
    const a = new World(1);
    const b = new World(2);
    for (let i = 0; i < 30; i++) {
      a.step();
      b.step();
    }
    expect(a.checksum()).not.toBe(b.checksum());
  });

  it('空间哈希 cell = 最大敌半径 ×2(GDD §13 不变量)', () => {
    expect(new World(1).grid.cellSize).toBe(tuning.enemyRadiusMax * 2);
  });

  it('实体数量跟随 tuning 动态调整(面板改数量即时生效)', () => {
    const w = new World(9);
    w.step();
    expect(w.enemies.size).toBe(300);
    tuning.stressEnemies = 150;
    w.step();
    expect(w.enemies.size).toBe(150);
    tuning.stressEnemies = 300;
    w.step();
    expect(w.enemies.size).toBe(300);
  });

  it('checksum 抓得住敌人的型号与血量(不然出怪错型/伤害算错会从确定性口径下漏掉)', () => {
    tuning.stressEnemies = 20;
    const w = new World(3);
    w.step();
    const e = w.enemies.items[0]!;

    const before = w.checksum();
    e.hp += 1;
    expect(w.checksum()).not.toBe(before);

    const afterHp = w.checksum();
    e.kind = (e.kind + 1) % ENEMIES.length;
    expect(w.checksum()).not.toBe(afterHp);
  });

  it('两个同 seed 世界并排跑:只给其中一边扣一滴血就分叉,补上同一下又合流', () => {
    tuning.stressEnemies = 40;
    tuning.stressBullets = 20;
    const a = new World(88);
    const b = new World(88);
    for (let i = 0; i < 90; i++) {
      a.step();
      b.step();
    }
    expect(a.checksum()).toBe(b.checksum());

    // 走真伤害入口(05 号 issue 的塔就是这么打的),且刻意不打死:位置一点没动,只有 hp 变了。
    // 分叉 = hp 确实进了 checksum,"伤害算错"这类回归才不会从确定性口径下漏掉
    expect(a.damageEnemy(a.enemies.items[0]!, 1)).toBe(false);
    expect(a.checksum()).not.toBe(b.checksum());

    // 另一边补上同样一下就又对上了:上面的差异确实来自那滴血,而不是别处早就在漂移
    expect(b.damageEnemy(b.enemies.items[0]!, 1)).toBe(false);
    expect(a.checksum()).toBe(b.checksum());
  });

  it('elapsed = tick × SIM_DT(HP 时间缩放的唯一时间源,与 checksum 同口径)', () => {
    tuning.stressEnemies = 5;
    const w = new World(1);
    expect(w.elapsed).toBe(0);
    for (let i = 0; i < 90; i++) w.step();
    expect(w.elapsed).toBeCloseTo(1.5, 12);
  });
});

describe('出怪混型(08 号波次脚本接手前的临时出怪器)', () => {
  it('按 tuning.enemyMix* 轮盘赌:默认占比下四型都出得来', () => {
    const w = new World(31);
    w.step();
    const seen = new Set<number>();
    for (const e of w.enemies.items) seen.add(e.kind);
    expect(seen).toEqual(new Set([KIND_SWARM, KIND_STRAFER, KIND_TRAILER, KIND_BEETLE]));
  });

  it('其余三型权重归零 → 全场同型(面板上"只看一型"的肉眼验收用法)', () => {
    for (const kind of [KIND_SWARM, KIND_STRAFER, KIND_TRAILER, KIND_BEETLE]) {
      onlyKind(kind);
      tuning.stressEnemies = 40;
      const w = new World(12);
      w.step();
      for (const e of w.enemies.items) expect(e.kind).toBe(kind);
    }
  });

  it('四个权重全为 0 → 回落蜂群蛭(总不能出个空气)', () => {
    tuning.enemyMixSwarm = 0;
    tuning.enemyMixStrafer = 0;
    tuning.enemyMixTrailer = 0;
    tuning.enemyMixBeetle = 0;
    tuning.stressEnemies = 10;
    const w = new World(4);
    w.step();
    expect(w.enemies.size).toBe(10);
    for (const e of w.enemies.items) expect(e.kind).toBe(KIND_SWARM);
  });

  it('rng 消耗顺序与 kind 无关:改占比只换型号,不移动整条随机序列', () => {
    // px/py 是出生点(敌人循环开头存的上一帧位置),比 x/y 干净:后者已被各型不同的速度带偏
    const spawnPoints = (setup: () => void): number[] => {
      setup();
      tuning.stressEnemies = 30;
      const w = new World(55);
      w.step();
      const out: number[] = [];
      for (const e of w.enemies.items) out.push(e.px, e.py);
      return out;
    };
    // 全出蜂群蛭与全出甲虫,出生点必须逐个相同 —— 每只固定消耗 kind→angle→radius→side 四次
    const base = spawnPoints(() => onlyKind(KIND_SWARM));
    expect(spawnPoints(() => onlyKind(KIND_BEETLE))).toEqual(base);
    // 权重全 0 的回落分支同样得消耗掉 kind 那一次:少取一次,后面所有敌人的出生点就整体错位
    expect(
      spawnPoints(() => {
        onlyKind(KIND_SWARM);
        tuning.enemyMixSwarm = 0; // 到这儿四个权重都是 0,走的是回落成蜂群蛭那条路
      }),
    ).toEqual(base);
  });

  it('出怪排在敌人循环之前:新生敌人当帧就动,px/py 停在出生环上(铁律 2)', () => {
    onlyKind(KIND_SWARM);
    tuning.stressEnemies = 8;
    const w = new World(6);
    w.step();
    for (const e of w.enemies.items) {
      // 首帧渲染插值的两端不重合 = 它当帧确实被推进过,而不是等到下一帧才开始动
      expect(Math.hypot(e.x - e.px, e.y - e.py)).toBeGreaterThan(0);
      expect(Math.hypot(e.px, e.py)).toBeGreaterThanOrEqual(300); // 出怪环内半径,没生在船脸上
    }
  });

  it('HP 时间缩放接线:晚出生的那批确实更硬(GDD §14)', () => {
    onlyKind(KIND_SWARM);
    tuning.stressEnemies = 6;
    const w = new World(17);
    w.step();
    const early = w.enemies.items[0]!.hp;
    expect(early).toBeCloseTo(ENEMIES[KIND_SWARM]!.hp * (1 + 0.09 * (w.elapsed / 60)), 9);

    w.tick = 60 * 60; // 直接把世界拨到第 60 秒:HP 缩放的时间源就是 tick,不必空跑一分钟
    tuning.stressEnemies = 0;
    w.step(); // 清场
    tuning.stressEnemies = 6;
    w.step(); // 这一批出生在第 60 秒

    const late = w.enemies.items[0]!.hp;
    expect(late).toBeCloseTo(ENEMIES[KIND_SWARM]!.hp * (1 + 0.09 * (w.elapsed / 60)), 9);
    expect(late).toBeGreaterThan(early * 1.08);
  });
});

/**
 * 07 验收标准里可自动化的部分(T5)。这几条都得在一个真世界里连着跑若干秒才成立:
 * 方向压力说的是"相对**当前**船头的方位",船不动就退化成一句废话;
 * HP 时间缩放说的是第 5 分钟,也只有真跑到 tick=18000 才算数。
 * 剩下的"1000 只同屏 60fps"要真机浏览器,不在这里验(Node 里量不出帧率)。
 */
describe('07 验收标准(可自动化的部分)', () => {
  it('侧掠者从当前船侧发起:起手瞬间的方位在舷侧 45°~135°,而不是聚在船尾 180°(追尾)', () => {
    onlyKind(KIND_STRAFER);
    tuning.stressEnemies = 24;
    tuning.stressBullets = 0; // 子弹与本条无关,省掉它让这条跑得快些
    const w = new World(101);

    const bearings: number[] = [];
    const watch = watchStates(w, (e, was) => {
      // 只在 APPROACH→WINDUP 那一帧取样:起手之后方向就锁死了,冲刺途中方位自然会滑向船头,
      // 事后回看必然测歪。这一帧的 px/py 正是状态机做判定时用的位置(敌人循环开头存的),
      // ship 也已经是本帧的新位置 —— 与 shouldWindup 的口径严丝合缝
      if (was === ST_APPROACH && e.state === ST_WINDUP) {
        bearings.push(wrapAngle(bearingTo(w, e.px, e.py) - w.ship.heading) / DEG2RAD);
      }
    });

    // 折线巡航:船一路在动还转了三次向,"舷侧"是个移动靶。静止船上测这条毫无意义 ——
    // 追尾型在静止船周围也能凑出各种方位角
    for (const leg of [0, 90, 180, 270]) cruise(w, leg, 5, watch);

    expect(bearings.length).toBeGreaterThan(15); // 真取到样了,不是空过 20 秒
    for (const deg of bearings) {
      // 判据是 |目标方位差| < 30°、目标方位 = 船头 ±90° → 起手必落在 60°~120°,这里留足余量。
      // 一旦退化成追尾,这些值会齐刷刷跑到 180° 附近
      expect(Math.abs(deg)).toBeGreaterThanOrEqual(45);
      expect(Math.abs(deg)).toBeLessThanOrEqual(135);
    }
    // 左右舷都用得上(e.side 出生时定死):全挤一侧的话玩家固定一边火力就免疫了
    expect(bearings.some((d) => d > 0)).toBe(true);
    expect(bearings.some((d) => d < 0)).toBe(true);
  });

  it('尾随蛆持续占据船尾象限:硬转 90° 甩开后绕回**新的**船尾,松手停船也咬在驻留半径上', () => {
    onlyKind(KIND_TRAILER);
    tuning.stressEnemies = 20;
    tuning.stressBullets = 0;
    const w = new World(202);

    /** 落在船尾 ±45° 象限内的比例 */
    const sternFrac = (): number => {
      let ok = 0;
      for (const e of w.enemies.items) {
        const err = wrapAngle(bearingTo(w, e.x, e.y) - (w.ship.heading + Math.PI));
        if (Math.abs(err) < 45 * DEG2RAD) ok++;
      }
      return ok / w.enemies.size;
    };

    cruise(w, 0, 6); // 先直线巡航 6s,让它们从出怪环各处排到船尾
    expect(sternFrac()).toBeGreaterThanOrEqual(0.8);

    cruise(w, 90, 1); // 硬转 90°(100°/s,0.9s 转完):老船尾这一刻变成了正横
    // 转完当场确实被甩到舷侧 —— 有这条对照,下面那条才不是"它们本来就在那儿"的空过
    expect(sternFrac()).toBeLessThan(0.5);

    cruise(w, 90, 4); // 再直线 4s:够它们绕回新船尾
    let worst = 1;
    // 逐帧取最差值而不是只看最后一眼:"持续占据"要的是稳态,不是某一帧的巧合
    cruise(w, 90, 1, () => {
      worst = Math.min(worst, sternFrac());
    });
    expect(worst).toBeGreaterThanOrEqual(0.8);

    // 松手停船(不给输入 = World.step 的缺省;船头朝向不变):纯追踪型这时会一头扎进船身,
    // 尾随蛆则停在驻留半径上咬尾。这一条挡的是"BH_STRAFE 退化成 seek" ——
    // 退化之后上面几条照样能过(追得慢的东西本来就落在船后),方向压力却已经没了
    for (let f = 0; f < 3 * SIM_HZ; f++) w.step();
    expect(sternFrac()).toBeGreaterThanOrEqual(0.8);

    const radius = ENEMIES[KIND_TRAILER]!.strafeRadius;
    const nearest = Math.min(
      ...w.enemies.items.map((e) => Math.hypot(e.x - w.ship.x, e.y - w.ship.y)),
    );
    expect(nearest).toBeGreaterThan(radius * 0.5);
    expect(nearest).toBeLessThan(radius * 1.5);
  });

  it('冲撞甲虫:每次冲刺前必有前摇,帧数由数据表的 chargeWindup 算出来(改数据即改手感)', () => {
    // 0.9 是表里的占位值;另一档证明帧数是从数据算的,不是把 54 写死在代码里
    for (const windup of [BASE_BEETLE_WINDUP, 0.4]) {
      ENEMIES[KIND_BEETLE]!.chargeWindup = windup;
      onlyKind(KIND_BEETLE);
      tuning.stressEnemies = 12;
      tuning.stressBullets = 0;
      const w = new World(303);

      const windupFrames = new Map<Enemy, number>();
      const dashes: number[] = [];
      const watch = watchStates(w, (e, was) => {
        if (e.state === ST_WINDUP) windupFrames.set(e, (windupFrames.get(e) ?? 0) + 1);
        if (e.state === ST_DASH && was !== ST_DASH) {
          // 冲刺只能从前摇里出来。少了这一票,玩家看到的就是无预警的秒杀
          expect(was).toBe(ST_WINDUP);
          dashes.push(windupFrames.get(e) ?? 0);
          windupFrames.set(e, 0);
        }
      });

      for (const leg of [0, 90, 180]) cruise(w, leg, 4, watch);

      expect(dashes.length).toBeGreaterThanOrEqual(3); // 真冲起来了,不是空过 12 秒
      for (const frames of dashes) expect(frames).toBe(Math.round(windup / SIM_DT));
    }
  });

  it('HP 时间缩放跑满 5 分钟:此刻重生的敌人 = 基础血 ×1.45(GDD §14)', () => {
    onlyKind(KIND_SWARM);
    tuning.stressEnemies = 1; // 就一只:要真跑满 18000 帧,场上人越少跑得越快
    tuning.stressBullets = 0;
    const w = new World(77);

    // 回收在帧尾、出怪在帧首 → 打死之后要隔两帧才补出新的一只。
    // 想让新敌恰好生在第 5 分钟那一帧(tick=18000),就得提前两帧动手
    const fiveMin = 5 * 60 * SIM_HZ;
    while (w.tick < fiveMin - 2) w.step();

    const first = w.enemies.items[0]!;
    expect(first.hp).toBeLessThan(ENEMIES[KIND_SWARM]!.hp * 1.1); // 它生在开局,当然还是软的
    expect(w.damageEnemy(first, 9999)).toBe(true);

    w.step(); // 帧尾回收
    expect(w.enemies.size).toBe(0);
    w.step(); // 帧首补位
    expect(w.tick).toBe(fiveMin);
    expect(w.elapsed).toBeCloseTo(300, 9);

    const fresh = w.enemies.items[0]!;
    expect(fresh.hp).toBeCloseTo(ENEMIES[KIND_SWARM]!.hp * 1.45, 9);
    expect(fresh.maxHp).toBe(fresh.hp); // 满血出生,而不是带着上一条命的残血被复用
  });
});

describe('接触检测(只检测,伤害结算是 09 号 issue)', () => {
  it('判定圆 = shipContactRadius + 该型体型,圈外的不登记', () => {
    onlyKind(KIND_SWARM);
    tuning.stressEnemies = 3;
    const w = new World(2);
    w.step();

    const r = tuning.shipContactRadius + ENEMIES[KIND_SWARM]!.radius;
    const [near, far, away] = w.enemies.items as [Enemy, Enemy, Enemy];
    // near 卡在船体判定圆之外、算上体型之内:漏掉 def.radius 那一项的话它就检不出来了
    park(near, r - 3, 0);
    park(far, r + 5, 0);
    park(away, 900, 0);
    expect(r - 3).toBeGreaterThan(tuning.shipContactRadius);
    w.step();

    expect(w.contacts).toContain(near);
    expect(w.contacts).not.toContain(far);
    expect(w.contacts).not.toContain(away);
  });

  it('只登记不结算:血量、状态、数量一概不动(09 接手前不许提前扣血)', () => {
    onlyKind(KIND_SWARM);
    tuning.stressEnemies = 4;
    const w = new World(13);
    w.step();
    for (const e of w.enemies.items) park(e, 0, 0); // 全压在船身上
    const hp = w.enemies.items.map((e) => e.hp);

    w.step();
    expect(w.contacts.length).toBe(4);
    expect(w.enemies.size).toBe(4);
    expect(w.kills).toBe(0);
    expect(w.enemies.items.map((e) => e.hp)).toEqual(hp);
    for (const e of w.enemies.items) expect(e.dead).toBe(false);
  });

  it('把船挪进敌群:名单与"真的贴到船"的那批人逐个吻合,下一帧开头清空', () => {
    onlyKind(KIND_SWARM);
    tuning.stressEnemies = 12;
    const w = new World(41);
    w.step();

    // 把敌群摆成一串,距离从判定圆内一路排到圈外,然后把船直接挪进这堆人中间
    const items = w.enemies.items;
    for (let i = 0; i < items.length; i++) park(items[i]!, 400, 20 + i * 12);
    w.ship.x = 400;
    w.ship.y = 0;
    w.step();

    const r = tuning.shipContactRadius + ENEMIES[KIND_SWARM]!.radius;
    let inside = 0;
    for (const e of items) {
      // 接触检测在敌人积分之后、船本帧也早已走完 → 拿收尾坐标复算,与检测时的口径严格一致
      const touching = Math.hypot(e.x - w.ship.x, e.y - w.ship.y) < r;
      expect(w.contacts.includes(e)).toBe(touching);
      if (touching) inside++;
    }
    expect(inside).toBeGreaterThan(0); // 圈内圈外都得有人,否则这条断言是空过的
    expect(inside).toBeLessThan(items.length);
    expect(w.contacts.length).toBe(inside);
    expect(new Set(w.contacts).size).toBe(w.contacts.length); // 同一只不会被登记两次

    // 清空发生在敌人循环**之前**:这一帧一只敌人都没有,名单照样得是空的。
    // 若改成"靠重新检测覆盖",空帧就会把上一帧的名单留给 09 号 issue,变成幽灵碰撞
    const ref = w.contacts;
    tuning.stressEnemies = 0;
    w.step();
    expect(w.contacts.length).toBe(0);
    expect(w.contacts).toBe(ref); // 原地清空复用同一个数组,不是每帧 new 一个(铁律 3)
  });

  it('每帧重建:上一帧贴上来的敌人离开后不会留在名单里', () => {
    onlyKind(KIND_SWARM);
    tuning.stressEnemies = 2;
    const w = new World(14);
    w.step();
    for (const e of w.enemies.items) park(e, 0, 0);
    w.step();
    expect(w.contacts.length).toBe(2);

    for (const e of w.enemies.items) park(e, 900, 0);
    w.step();
    expect(w.contacts.length).toBe(0);
  });
});

describe('死亡回收与掉落挂钩(07 号 T3)', () => {
  it('damageEnemy 只标记不出池,step 末尾统一回收并累加 kills', () => {
    onlyKind(KIND_SWARM);
    tuning.stressEnemies = 5;
    const w = new World(8);
    w.step();
    const victim = w.enemies.items[0]!;

    expect(w.damageEnemy(victim, victim.hp)).toBe(true);
    // 标记 ≠ 出池:05 号 issue 的塔不必知道对象在池里的下标,也不会把别人的遍历搅乱
    expect(w.enemies.size).toBe(5);
    expect(w.kills).toBe(0);

    w.step();
    expect(w.enemies.size).toBe(4);
    expect(w.kills).toBe(1);
    expect(w.enemies.items).not.toContain(victim);
  });

  it('挂钩在回池前触发,回调里拿得到坐标与型号(10 号 issue 的残骸掉落点)', () => {
    onlyKind(KIND_BEETLE);
    tuning.stressEnemies = 3;
    const w = new World(19);
    w.step();
    const victim = w.enemies.items[0]!;
    const at = { x: 0, y: 0, kind: -1, hits: 0 };
    w.onEnemyDeath = (e) => {
      at.x = e.x;
      at.y = e.y;
      at.kind = e.kind;
      at.hits++;
    };

    w.damageEnemy(victim, 9999);
    const x = victim.x;
    const y = victim.y;
    w.step(); // 尸体在本帧仍被推进(它整帧都还在场),所以坐标对着回收那一刻取

    expect(at.hits).toBe(1);
    expect(at.kind).toBe(KIND_BEETLE);
    expect(Math.hypot(at.x - x, at.y - y)).toBeLessThan(20); // 就在它倒下的地方,不是 (0,0)
  });

  it('同一帧打死一片(含末尾与相邻)一个不漏 —— 倒序回收才躲得开 swap-remove 的下标坑', () => {
    onlyKind(KIND_SWARM);
    tuning.stressEnemies = 8;
    const w = new World(23);
    w.step();

    const all = [...w.enemies.items];
    const doomed = [all[0]!, all[5]!, all[6]!, all[7]!]; // 相邻三只 + 末尾:正序回收必漏
    const survivors = all.filter((e) => !doomed.includes(e));
    for (const e of doomed) w.damageEnemy(e, 9999);

    const dropped: Enemy[] = [];
    w.onEnemyDeath = (e) => dropped.push(e);
    w.step();

    expect(w.kills).toBe(4);
    expect(dropped.length).toBe(4);
    expect(new Set(dropped)).toEqual(new Set(doomed));
    expect(w.enemies.size).toBe(4);
    expect(new Set(w.enemies.items)).toEqual(new Set(survivors)); // 活人一个没被误伤
  });

  it('同帧重复致命只算一次击杀(10 号的掉落不会按命中数重复给)', () => {
    onlyKind(KIND_SWARM);
    tuning.stressEnemies = 4;
    const w = new World(24);
    w.step();
    const victim = w.enemies.items[0]!;

    expect(w.damageEnemy(victim, 9999)).toBe(true);
    expect(w.damageEnemy(victim, 9999)).toBe(false);
    let hits = 0;
    w.onEnemyDeath = () => hits++;
    w.step();
    expect(w.kills).toBe(1);
    expect(hits).toBe(1);
  });

  it('回收进池的对象在下一次出怪时被复用(运行期零新增分配的可观测形式)', () => {
    onlyKind(KIND_SWARM);
    tuning.stressEnemies = 6;
    const w = new World(26);
    w.step();

    const doomed = new Set([w.enemies.items[1]!, w.enemies.items[3]!, w.enemies.items[5]!]);
    let hits = 0;
    w.onEnemyDeath = () => hits++;
    for (const e of doomed) expect(w.damageEnemy(e, 9999)).toBe(true);

    w.step(); // 帧尾回收:挂钩响三次,场上一具尸体都不许留
    expect(hits).toBe(3);
    expect(w.kills).toBe(3);
    expect(w.enemies.size).toBe(3);
    for (const e of w.enemies.items) {
      expect(e.dead).toBe(false);
      expect(doomed.has(e)).toBe(false);
    }

    w.step(); // 下一帧帧首按 stressEnemies 补回三只
    expect(w.enemies.size).toBe(6);
    // 补出来的正是刚回收的那三个对象(池是后进先出),没有 new 出新的 —— 这就是"回收进池"的证据
    const reused = w.enemies.items.filter((e) => doomed.has(e));
    expect(reused.length).toBe(3);
    for (const e of reused) {
      // 复用前走了 resetEnemy + initEnemy:上一条命的死亡标记没被带过来
      //(带过来的话它一出生就会被当尸体回收,场上人数会诡异地少一只)
      expect(e.dead).toBe(false);
      expect(e.state).toBe(ST_APPROACH);
      expect(e.hp).toBe(e.maxHp);
      expect(e.hp).toBeGreaterThan(0);
    }
  });

  it('没打死的不回收;面板清场也不算击杀、不掉落', () => {
    onlyKind(KIND_SWARM);
    tuning.stressEnemies = 6;
    const w = new World(25);
    w.step();
    let hits = 0;
    w.onEnemyDeath = () => hits++;

    expect(w.damageEnemy(w.enemies.items[0]!, 1)).toBe(false); // 蜂群蛭 8 血,挨一下死不了
    w.step();
    expect(w.enemies.size).toBe(6);

    tuning.stressEnemies = 2; // 面板拖数量 = 清场,不是打死的
    w.step();
    expect(w.enemies.size).toBe(2);
    expect(w.kills).toBe(0);
    expect(hits).toBe(0);
  });
});

describe('邻居分离只在接近段叠加', () => {
  it('冲刺中的敌人不被同伴推离锁定直线(否则前摇画出的预警线就成了谎言)', () => {
    expect(driftUnderPack(ST_DASH)).toBe(0);
  });

  it('对照:同一构型在接近段确实被挤开 —— 上面那条不是"分离力根本没生效"的空过', () => {
    expect(driftUnderPack(ST_APPROACH)).toBeLessThan(-0.5);
  });
});

/**
 * 巡航输入。整局复用同一个指令对象 —— World.step 只读不缓存引用,压测与回放也是这么灌输入的。
 */
const cruiseDir: Vec2 = { x: 1, y: 0 };
const cruiseCmd: ShipCommand = { desiredHeading: cruiseDir };

/**
 * 让船朝 headingDeg 方向持续巡航若干秒。
 * 方向压力的用例一律用**折线机动**(直线腿 + 硬转弯)而不是绕圈:转弯那一下才是考点
 *(敌人得跟着"当前"船头重新排队),直线腿则给它们排回去的时间;绕圈则会因为
 * 尾随蛆比船慢(125 vs 130)而被离心甩开,测出来的是速度差而不是方位逻辑。
 * @param onFrame 每逻辑帧末尾回调:"持续占据"要逐帧采样,只看最后一眼会把巧合当稳态
 */
function cruise(w: World, headingDeg: number, seconds: number, onFrame?: () => void): void {
  const a = headingDeg * DEG2RAD;
  cruiseDir.x = Math.cos(a);
  cruiseDir.y = Math.sin(a);
  for (let f = 0; f < Math.round(seconds * SIM_HZ); f++) {
    w.step(cruiseCmd);
    onFrame?.();
  }
}

/** 船 → 敌方位角(全仓统一口径:atan2(ey - ty, ex - tx)) */
function bearingTo(w: World, x: number, y: number): number {
  return Math.atan2(y - w.ship.y, x - w.ship.x);
}

/**
 * 逐帧盯住每只敌人的状态跃迁,返回一个塞给 cruise 的 onFrame。
 * 拿对象引用当键而不是下标:池的 swap-remove 会把下标换位,按下标记状态会张冠李戴。
 * @param onStep 每帧对每只敌人回调 (敌人, 它上一帧的状态)。新出生的敌人上一帧没有状态,给 undefined
 */
function watchStates(
  w: World,
  onStep: (e: Enemy, prevState: number | undefined) => void,
): () => void {
  const prev = new Map<Enemy, number>();
  return () => {
    for (const e of w.enemies.items) onStep(e, prev.get(e));
    prev.clear();
    for (const e of w.enemies.items) prev.set(e, e.state);
  };
}

/** 把敌人钉在某处并清速度:构造判定用的确定构型,免得被上一帧的惯性带走 */
function park(e: Enemy, x: number, y: number): void {
  e.x = e.px = x;
  e.y = e.py = y;
  e.vx = 0;
  e.vy = 0;
}

/**
 * 让一只甲虫沿 +X 走,同伴全压在它的 +Y 侧:分离力若参与,它必然被推出 -Y。
 * @returns 若干帧后的横向位移(负 = 被挤开了)
 */
function driftUnderPack(state: number): number {
  onlyKind(KIND_SWARM);
  tuning.stressEnemies = 6;
  const w = new World(21);
  w.step();
  // 船摆在正 +X 的场边:接近段的期望速度也沿 +X,于是横向位移只可能来自分离力
  w.ship.x = 1200;
  w.ship.y = 0;

  const items = w.enemies.items;
  const charger = items[0]!;
  charger.kind = KIND_BEETLE;
  park(charger, 0, 0);
  charger.state = state;
  charger.timer = 5; // 够跑完下面这几帧,中途不会转到硬直
  charger.lockX = 1;
  charger.lockY = 0;
  charger.vx = ENEMIES[KIND_BEETLE]!.chargeSpeed;

  for (let f = 0; f < 10; f++) {
    // 每帧把同伴重新贴回来:冲刺的比同伴快得多,不重摆的话第二帧就没人挤得到它了
    for (let i = 1; i < items.length; i++) park(items[i]!, charger.x, charger.y + 4 + i);
    w.step();
  }
  expect(charger.state).toBe(state); // 状态没被状态机带走,这十帧钉的确实是同一个分支
  expect(charger.x).toBeGreaterThan(0); // 它确实在往前走,不是原地不动才"没漂移"
  return charger.y;
}
