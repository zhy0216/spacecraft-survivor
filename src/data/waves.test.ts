/**
 * 波次脚本(08 号 issue T1)的表级不变量。
 * 与 data/towers.test.ts 同口径:钉的不是出怪逻辑(那在 sim/waves.ts 里),而是**脚本本身的口径** ——
 * 单局结构(4 段 × 120s、每两分钟一次敌群升级/玩家整备)、主压方向缓慢旋转且首尾相接不折回、
 * 侧压事件的时刻有序且落在段内、怪组合对得上敌人表、精英编排合法(教学段空 / at 升序 /
 * kind 与词缀编号合法)、出怪环大于镜头视野。
 *
 * 后续调波次节奏时随便改数字是被鼓励的(那正是本表存在的理由),但改坏这几条就是改坏了机制本身:
 * 把 dirEndDeg 写成折回的角,主压方向就会在段内倒着急甩;
 * 把某段的方向写成不动,那一段玩家就能摆好舷挂机(GDD §6.3 的整条设计意图当场作废);
 * 把出怪半径调到视野以内,敌人就会当着玩家的面凭空出现。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { tuning } from '../sim/config';
import { AFFIX_COUNT } from './affixes';
import { ENEMIES, ENEMY_KIND_COUNT, KIND_BEETLE, KIND_STRAFER, KIND_SWARM } from './enemies';
import {
  SPAWN_RADIUS,
  SPAWN_RADIUS_BAND,
  WAVE_LOCKED_ELITES,
  WAVE_MAX_ALIVE,
  WAVE_MAX_SPAWN_PER_TICK,
  WAVE_MAX_STREAMS,
  WAVE_SEGMENTS,
  WAVE_TOTAL_TIME,
  type WaveSegment,
} from './waves';
import { UNLOCK_ELITE, UNLOCKS } from './unlocks';

/**
 * 最后一条用例要把整份脚本 splice 成短脚本(验证表可写),跑完必须还原,
 * 否则污染同文件后续用例 —— 也正是 T2 的运行器单测要用的那套手法(真跑完整局 480s ≈ 28800 帧,等不起)。
 */
const BASE_SEGMENTS = WAVE_SEGMENTS.slice();
const BASE_TOTAL = BASE_SEGMENTS.reduce((sum, seg) => sum + seg.duration, 0);
afterEach(() => {
  WAVE_SEGMENTS.splice(0, WAVE_SEGMENTS.length, ...BASE_SEGMENTS);
});

/** 一次侧压事件的总只数 */
function burstTotal(counts: number[]): number {
  return counts.reduce((sum, n) => sum + n, 0);
}

/** 一段某一端的总压强(只/秒)= 各流该端速率之和 */
function intensity(seg: WaveSegment, end: 'rate0' | 'rate1'): number {
  return seg.streams.reduce((sum, s) => sum + s[end], 0);
}

/**
 * 镜头视野半径(世界 px):敌人在这个圈内出生就是"当着玩家的面凭空出现"。
 * 算式与 render/renderer.ts 的 sync() 一字对应(那里是唯一算镜头的地方):
 *   scale = 屏高 × cameraShipHeightFraction ÷ shipLength,视野半对角 = hypot(屏宽,屏高) / 2 / scale,
 *   再加镜头前推的 lookAhead = 屏高 × cameraLookAhead ÷ scale。
 * 屏幕尺寸取 21:9 的 3440×1440(市面最宽的一档):sim 不知道屏幕多大(铁律 1),
 * SPAWN_RADIUS 就是两边唯一的约定,按最宽的屏取上界才不会在某台机器上露馅。
 */
const SCREEN_W = 3440;
const SCREEN_H = 1440;
function viewRadius(): number {
  const scale = (SCREEN_H * tuning.cameraShipHeightFraction) / tuning.shipLength;
  return Math.hypot(SCREEN_W, SCREEN_H) / 2 / scale + (SCREEN_H * tuning.cameraLookAhead) / scale;
}

describe('波次脚本', () => {
  it('单局结构:4 段 × 120s,每两分钟一次敌群升级/玩家整备', () => {
    expect(WAVE_SEGMENTS.length).toBe(4);
    for (const seg of WAVE_SEGMENTS) {
      expect(seg.duration, seg.name).toBe(120);
      expect(seg.name.length, '段名给结算界面与调参面板显示,不许留空').toBeGreaterThan(0);
    }
    // 四段共 8 分钟；整备发生在前三个段边界，最终段结束直接结算。
    expect(WAVE_TOTAL_TIME).toBe(WAVE_SEGMENTS.reduce((s, seg) => s + seg.duration, 0));
    expect(WAVE_TOTAL_TIME).toBe(480);
  });

  it('主压方向首尾相接、写累积角不折回,且每段都在缓慢转(GDD §6.3:最优舷持续漂移)', () => {
    for (let i = 0; i + 1 < WAVE_SEGMENTS.length; i++) {
      const cur = WAVE_SEGMENTS[i]!;
      const next = WAVE_SEGMENTS[i + 1]!;
      // mod 360:下一段写 120 还是写 480 都行(累积角),但方向必须接得上 ——
      // 接不上就是换段那一帧主压方向瞬移,罗盘(11 号)会突然指向别处
      const gap = (((next.dirStartDeg - cur.dirEndDeg) % 360) + 360) % 360;
      expect(gap, `${cur.name} → ${next.name}`).toBe(0);
    }

    let sweep = 0;
    for (const seg of WAVE_SEGMENTS) {
      const turn = Math.abs(seg.dirEndDeg - seg.dirStartDeg);
      sweep += turn;
      // 一段内转过 360° 以上 = 写成了绕圈,插值出来的方向会快到没人跟得住
      expect(turn, seg.name).toBeLessThanOrEqual(360);
      const speed = turn / seg.duration;
      // 0 = 这一段方向不动 → 玩家摆好一个舷就能挂机整段,本作最核心的那条压力就没了
      expect(speed, seg.name).toBeGreaterThan(0);
      // 上界 3°/s = 转一整圈至少 120s。快过它就不叫"缓慢旋转",
      // 而是逼玩家全程满舵追(船只有 tuning.shipTurnRate = 100°/s,追是追得上,但那一局就只剩转舵了)
      expect(speed, seg.name).toBeLessThanOrEqual(3);
    }
    // 全局至少转满一整周:否则总存在一个"从头吃到尾"的航向,最优舷就不漂移了
    expect(sweep).toBeGreaterThanOrEqual(360);
  });

  it('主压怪流:种类落在敌人表内,速率为正,展宽还算得上一个"方向"', () => {
    for (const seg of WAVE_SEGMENTS) {
      expect(seg.streams.length, `${seg.name} 没有主压流 = 整段只有零星侧压`).toBeGreaterThan(0);
      for (const s of seg.streams) {
        // 下标即 kind(data/enemies.ts 的口径),错一位就出成另一型
        expect(Number.isInteger(s.kind)).toBe(true);
        expect(s.kind).toBeGreaterThanOrEqual(0);
        expect(s.kind).toBeLessThan(ENEMY_KIND_COUNT);
        expect(ENEMIES[s.kind]!.kind).toBe(s.kind);

        expect(s.rate0, `${seg.name}/${ENEMIES[s.kind]!.name}`).toBeGreaterThan(0);
        expect(s.rate1, `${seg.name}/${ENEMIES[s.kind]!.name}`).toBeGreaterThan(0);
        // 半展宽 ≥ 90° 等于说"四面八方都来",主压方向也就不存在了;负数则会把出生角算反
        expect(s.spreadDeg).toBeGreaterThanOrEqual(0);
        expect(s.spreadDeg).toBeLessThan(90);
      }
    }
  });

  it('密度曲线只涨不落,换段时也不掉压(否则每次换段都送一段白给的喘息)', () => {
    for (const seg of WAVE_SEGMENTS) {
      for (const s of seg.streams) {
        expect(s.rate1, `${seg.name}/${ENEMIES[s.kind]!.name}`).toBeGreaterThanOrEqual(s.rate0);
      }
    }
    for (let i = 0; i + 1 < WAVE_SEGMENTS.length; i++) {
      const cur = WAVE_SEGMENTS[i]!;
      const next = WAVE_SEGMENTS[i + 1]!;
      // 段尾总压强 ≤ 下一段段首:接缝处不许回落,九分钟才是一条曲线而不是四个小高潮
      expect(intensity(next, 'rate0'), `${cur.name} → ${next.name}`).toBeGreaterThanOrEqual(
        intensity(cur, 'rate1'),
      );
    }
  });

  it('侧压事件:at 升序且落在段内,怪组合长度 = ENEMY_KIND_COUNT', () => {
    for (const seg of WAVE_SEGMENTS) {
      let prevAt = -1;
      for (const b of seg.bursts) {
        expect(b.at, seg.name).toBeGreaterThanOrEqual(0);
        // 运行器只往前扫、不回头找(热路径不排序):乱序写的事件会被整个跳过
        expect(b.at, `${seg.name} 的事件必须按 at 升序`).toBeGreaterThan(prevAt);
        // == duration 也不行:那一刻已经进了下一段,事件永远轮不到触发
        expect(b.at, seg.name).toBeLessThan(seg.duration);
        prevAt = b.at;

        // 短一位就会静默漏掉一型(noUncheckedIndexedAccess 拦不住数据表写短)
        expect(b.counts.length, seg.name).toBe(ENEMY_KIND_COUNT);
        for (const n of b.counts) {
          expect(Number.isInteger(n)).toBe(true);
          expect(n).toBeGreaterThanOrEqual(0);
        }
        expect(burstTotal(b.counts), `${seg.name}@${b.at}s 是个不出怪的空事件`).toBeGreaterThan(0);

        // 相对当时的主压方向:±90 侧压、180 背后。超出 ±180 只是同一个方向的另一种写法,
        // 但写在表里就没人一眼看得出它压的是哪边了
        expect(b.offsetDeg, seg.name).toBeGreaterThanOrEqual(-180);
        expect(b.offsetDeg, seg.name).toBeLessThanOrEqual(180);
        expect(b.spreadDeg).toBeGreaterThanOrEqual(0);
        expect(b.spreadDeg).toBeLessThan(90);
      }
    }
  });

  it('同段内相邻两次侧压不压同一舷:连着两次同侧,玩家摆好一边就白赚', () => {
    for (const seg of WAVE_SEGMENTS) {
      let prevSide = 0;
      for (const b of seg.bursts) {
        // 0(正面)与 ±180(背后)不分左右,不参与交替判定
        if (b.offsetDeg === 0 || Math.abs(b.offsetDeg) === 180) continue;
        const side = b.offsetDeg > 0 ? 1 : -1;
        expect(side, `${seg.name}@${b.at}s 与上一次同舷`).not.toBe(prevSide);
        prevSide = side;
      }
    }
  });

  it('敌型逐段解锁:除打底的蜂群蛭外,每一型先在侧压事件里露面,下一段才进流', () => {
    // 一小队从一个方向来,比混进主压流里更看得清它的行为(冲锋型尤其:前摇得看得见才叫"来得及躲")
    const firstStream = new Array<number>(ENEMY_KIND_COUNT).fill(Infinity);
    const firstBurst = new Array<number>(ENEMY_KIND_COUNT).fill(Infinity);
    let t0 = 0;
    for (const seg of WAVE_SEGMENTS) {
      // 流是整段持续的,故它的首次露面时刻就是段首
      for (const s of seg.streams) firstStream[s.kind] = Math.min(firstStream[s.kind]!, t0);
      for (const b of seg.bursts) {
        b.counts.forEach((n, kind) => {
          if (n > 0) firstBurst[kind] = Math.min(firstBurst[kind]!, t0 + b.at);
        });
      }
      t0 += seg.duration;
    }

    for (let kind = 0; kind < ENEMY_KIND_COUNT; kind++) {
      const name = ENEMIES[kind]!.name;
      // 四型都得在脚本里真的出现过:设计了却一局都见不到的敌型等于没做
      expect(Math.min(firstStream[kind]!, firstBurst[kind]!), name).toBeLessThan(Infinity);
      if (kind === KIND_SWARM) continue; // 打底型,开局第一条流就是它
      expect(firstBurst[kind]!, `${name} 该先在侧压事件里露一次面`).toBeLessThan(
        firstStream[kind]!,
      );
    }
    // 开局第一段就得有一次侧掠者的侧压(第一次逼玩家换舷),最沉的冲撞甲虫则留到收尾段才进流
    expect(WAVE_SEGMENTS[0]!.bursts.some((b) => b.counts[KIND_STRAFER]! > 0)).toBe(true);
    const last = WAVE_SEGMENTS[WAVE_SEGMENTS.length - 1]!;
    expect(last.streams.some((s) => s.kind === KIND_BEETLE)).toBe(true);
  });

  it('精英编排:教学段不塞,其余段各 1–2 个;at 升序且落段内;kind 与词缀编号合法', () => {
    // 教学段(第一段)是"摆塔 + 认主压方向"的白给区,不塞精英(todos/14:教学段不塞)
    expect(WAVE_SEGMENTS[0]!.elites).toEqual([]);
    const all: { at: number; kind: number; count: number; affixes: number[] }[] = [];
    for (const seg of WAVE_SEGMENTS) {
      // 中后段给力:每段 1–2 个,塞满整段就没有"突发时刻"的节奏可言
      expect(seg.elites.length, `${seg.name} 的精英数`).toBeLessThanOrEqual(2);
      let prevAt = -1;
      for (const el of seg.elites) {
        expect(el.at, seg.name).toBeGreaterThanOrEqual(0);
        // 与 bursts 同一条游标口径:运行器只往前扫、不回头找,乱序写的事件会被整个跳过
        expect(el.at, `${seg.name} 的精英必须按 at 升序`).toBeGreaterThan(prevAt);
        // == duration 也不行:那一刻已经进了下一段,事件永远轮不到触发
        expect(el.at, seg.name).toBeLessThan(seg.duration);
        prevAt = el.at;

        // 精英是普通敌型的放大版:kind 必须落在敌人表内(错一位就出成另一型)
        expect(Number.isInteger(el.kind)).toBe(true);
        expect(el.kind).toBeGreaterThanOrEqual(0);
        expect(el.kind).toBeLessThan(ENEMY_KIND_COUNT);
        expect(ENEMIES[el.kind]!.kind).toBe(el.kind);

        expect(Number.isInteger(el.count)).toBe(true);
        expect(el.count, seg.name).toBeGreaterThanOrEqual(1);

        // 词缀 1–2 个(GDD §6.4);编号必须落在 data/affixes.ts 的合法区间内,
        // 出界的编号在运行器里会静默透传、效果永远挂不上
        expect(el.affixes.length, `${seg.name}@${el.at}s 的词缀数`).toBeGreaterThanOrEqual(1);
        expect(el.affixes.length).toBeLessThanOrEqual(2);
        for (const a of el.affixes) {
          expect(Number.isInteger(a)).toBe(true);
          expect(a).toBeGreaterThanOrEqual(0);
          expect(a).toBeLessThan(AFFIX_COUNT);
        }
        all.push(el);
      }
    }
    // 后三段每段至少一只:教学段白给,整局不能只有开头有惊喜
    for (let i = 1; i < WAVE_SEGMENTS.length; i++) {
      expect(WAVE_SEGMENTS[i]!.elites.length, WAVE_SEGMENTS[i]!.name).toBeGreaterThanOrEqual(1);
    }
    // 五种词缀整局至少各出场一次(14 号验收:每种效果都要被玩家撞见并验证)
    for (let a = 0; a < AFFIX_COUNT; a++) {
      expect(all.some((el) => el.affixes.includes(a)), `词缀 ${a} 整局没出场`).toBe(true);
    }
    // 单帧上限是"数据写坏"的保险丝:任何一次精英事件都要能一帧出完(与 bursts 同一条原子口径)
    let maxEliteEvent = 0;
    for (const seg of WAVE_SEGMENTS) for (const el of seg.elites) maxEliteEvent = Math.max(maxEliteEvent, el.count);
    expect(WAVE_MAX_SPAWN_PER_TICK).toBeGreaterThanOrEqual(maxEliteEvent);
  });

  it('出怪环大于镜头视野半径:小于它,敌人就当着玩家的面凭空出现', () => {
    const view = viewRadius();
    expect(view).toBeGreaterThan(0);
    expect(SPAWN_RADIUS).toBeGreaterThan(view);

    // 上界:出得太远,最慢的敌型要走好几秒才进屏,脚本写的密度曲线与实际压力就对不上了。
    // 挂在敌人表的最慢速度上而不是写死一个数 —— 敌速一改,这条边界跟着走
    const slowest = ENEMIES.reduce((m, d) => (d.speed < m ? d.speed : m), Infinity);
    expect((SPAWN_RADIUS + SPAWN_RADIUS_BAND - view) / slowest).toBeLessThanOrEqual(5);

    // 抖动带:0 的话一股流出上百只之后会在屏外排成一个正圆弧,同排的怪还会同时抵达
    expect(SPAWN_RADIUS_BAND).toBeGreaterThan(0);
  });

  it('两道保险丝:在场上限护住 1000 敌预算,单帧上限一帧能出完最大的一次侧压', () => {
    expect(WAVE_MAX_ALIVE).toBeGreaterThanOrEqual(tuning.stressEnemies); // 01 号的同屏预算

    let maxBurst = 0;
    for (const seg of WAVE_SEGMENTS) {
      for (const b of seg.bursts) maxBurst = Math.max(maxBurst, burstTotal(b.counts));
    }
    // 一次侧压是"定时事件",拆到两帧去出就不是同一波了;
    // 单帧上限护的是数据写坏(某条流的 rate 误填成 1e6),不该在正常脚本上生效
    expect(WAVE_MAX_SPAWN_PER_TICK).toBeGreaterThanOrEqual(maxBurst);
    expect(Number.isInteger(WAVE_MAX_SPAWN_PER_TICK)).toBe(true);
  });

  it('WAVE_MAX_STREAMS = 各段最长的 streams(debt 数组的预分配长度)', () => {
    let max = 0;
    for (const seg of WAVE_SEGMENTS) max = Math.max(max, seg.streams.length);
    expect(WAVE_MAX_STREAMS).toBe(max);
    expect(WAVE_MAX_STREAMS).toBeGreaterThan(0);
  });

  it('脚本是可写的:单测能整段 splice 成短脚本再还原(没有 readonly,也没 Object.freeze)', () => {
    // T2 的运行器单测全靠这一手:真跑完整局是 480s ≈ 28800 逻辑帧,
    // 冻表会让"跑到胜利"这条验收无从下手(与 data/towers.test.ts 那条"表是可写的"同源)
    const short: WaveSegment = {
      name: '短脚本',
      duration: 2,
      dirStartDeg: 0,
      dirEndDeg: 10,
      streams: [{ kind: KIND_SWARM, rate0: 1, rate1: 1, spreadDeg: 0 }],
      bursts: [],
      elites: [],
    };
    WAVE_SEGMENTS.splice(0, WAVE_SEGMENTS.length, short);
    expect(WAVE_SEGMENTS.length).toBe(1);
    expect(WAVE_SEGMENTS[0]!.duration).toBe(2);
    // 字段也得可写:改一个数就能试新节奏
    WAVE_SEGMENTS[0]!.duration = 3;
    expect(WAVE_SEGMENTS[0]!.duration).toBe(3);

    // WAVE_TOTAL_TIME 是模块加载时算的**设计口径**快照,不随 splice 变 ——
    // 运行器一个字都不读它(局终由逐段推进到越界自然得出),故这里不是漏算
    expect(WAVE_TOTAL_TIME).toBe(BASE_TOTAL);
  });
});

describe('解锁精英事件(19 号)—— 独立槽位,不碰既有段脚本的确定性', () => {
  it('槽位合法:segmentIndex/at 都落在目标段内,kind/count/词缀编号全部合法', () => {
    for (const el of WAVE_LOCKED_ELITES) {
      expect(el.unlockId.length, '解锁 id 不许空串').toBeGreaterThan(0);
      expect(Number.isInteger(el.segmentIndex)).toBe(true);
      expect(el.segmentIndex).toBeGreaterThanOrEqual(0);
      expect(el.segmentIndex).toBeLessThan(WAVE_SEGMENTS.length);
      const seg = WAVE_SEGMENTS[el.segmentIndex]!;
      expect(el.at, `${seg.name}@${el.at}s`).toBeGreaterThanOrEqual(0);
      // 与 WaveElite 同一条口径:== duration 那一刻已经进了下一段,事件永远轮不到触发
      expect(el.at, seg.name).toBeLessThan(seg.duration);

      // 精英是普通敌型的放大版:kind 必须落在敌人表内(错一位就出成另一型)
      expect(Number.isInteger(el.kind)).toBe(true);
      expect(el.kind).toBeGreaterThanOrEqual(0);
      expect(el.kind).toBeLessThan(ENEMY_KIND_COUNT);
      expect(ENEMIES[el.kind]!.kind).toBe(el.kind);

      expect(Number.isInteger(el.count)).toBe(true);
      expect(el.count).toBeGreaterThanOrEqual(1);

      for (const a of el.affixes) {
        expect(Number.isInteger(a)).toBe(true);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThan(AFFIX_COUNT);
      }
    }
  });

  it('词缀数 > 既有段上限 2:这就是"词缀更高的精英事件"', () => {
    // 既有段(GDD §6.4)的精英 1–2 词缀;解锁事件必须比它能解锁的"普通威胁"更重,
    // 否则"解锁了更强的精英"这句承诺就是空话
    for (const el of WAVE_LOCKED_ELITES) expect(el.affixes.length).toBeGreaterThanOrEqual(3);
    for (const seg of WAVE_SEGMENTS) {
      for (const el of seg.elites) expect(el.affixes.length).toBeLessThanOrEqual(2);
    }
  });

  it('教学段不塞、与既有段精英不挤在同几秒(编排口径:突发事件要错得开)', () => {
    for (const el of WAVE_LOCKED_ELITES) {
      expect(el.segmentIndex).not.toBe(0); // 教学段(离港航道)是白给区,不塞精英(todos/14)
      const seg = WAVE_SEGMENTS[el.segmentIndex]!;
      // 与既有精英的触发时刻错开:同一段同几秒冒出两只"突发",玩家分不清谁是谁的
      for (const existing of seg.elites) {
        expect(Math.abs(existing.at - el.at), `${seg.name}@${el.at}s 与既有精英 ${existing.at}s 撞车`).toBeGreaterThan(5);
      }
    }
  });

  it('解锁引用互相咬合:UNLOCK_ELITE 条目 ↔ WAVE_LOCKED_ELITES 槽位一一对应', () => {
    // unlocks.ts 的 UNLOCK_ELITE 条目 type = WAVE_LOCKED_ELITES 下标,
    // 且槽位的 unlockId === 该条目的 id —— 同串不同名,错位 = 解锁到别人家的事件
    const eliteEntries = UNLOCKS.filter((u) => u.kind === UNLOCK_ELITE);
    for (const u of eliteEntries) {
      const el = WAVE_LOCKED_ELITES[u.type];
      expect(el, `解锁条目 ${u.id} 引用的槽位不存在`).toBeDefined();
      expect(el!.unlockId).toBe(u.id);
    }
    // 反过来:每条槽位都有一条解锁条目指着,不许出现"永远出不来"的事件
    const ids = new Set(eliteEntries.map((u) => u.id));
    for (const el of WAVE_LOCKED_ELITES) expect(ids.has(el.unlockId)).toBe(true);
  });

  it('确定性口径:解锁事件零 rng —— 槽位表不在 WAVE_SEGMENTS 里,既有同 seed 序列结构上不受影响', () => {
    // 19 号验收"解锁状态不影响同 seed rng 序列":解锁精英是脚本事件(与既有精英同一条
    // "按 at 触发、整组出"的原子口径,不消耗任何 rng),且以独立槽位存在 ——
    // 它要么被运行器整条跳过(未解锁),要么按 at 归位后照脚本出(已解锁),
    // 两条路都不移动随机序列。这里钉的是结构前提:槽位表确实不在 WAVE_SEGMENTS 里,
    // 段脚本本身(与它的同 seed 用例)一个字都不用改
    expect(WAVE_LOCKED_ELITES.length).toBeGreaterThan(0);
    for (const seg of WAVE_SEGMENTS) {
      for (const el of seg.elites) {
        expect(el.affixes.length).toBeLessThanOrEqual(2); // 既有段的 1–2 词缀上限原样站着
      }
    }
    // 槽位表的存在不影响单局总时长:它不占段,也不在 WAVE_TOTAL_TIME 的口径里
    expect(WAVE_TOTAL_TIME).toBe(WAVE_SEGMENTS.reduce((s, seg) => s + seg.duration, 0));
  });
});
