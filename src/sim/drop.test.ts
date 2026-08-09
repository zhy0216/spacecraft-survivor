/**
 * 残骸掉落物与磁吸拾取(10 号 issue T1)。
 * 这里只喂"一个残骸池 + 一块空甲板 + 一对船心坐标",不造 World、不造敌人:
 * 掉落与世界之间没有任何契约(stepDrops 的五个参数就是它需要知道的全部),
 * 于是每一条磁吸规则都能被逐帧钉死 —— 而这些规则恰恰是玩家唯一能感觉到的东西:
 * 多远开始吸、擦过去收不收得下、船开走了会不会被甩掉。
 *
 * 钉的几条(改坏就等于改坏了 10 号的验收标准):
 *   进过起吸半径一次就**锁定**,此后船开出半径也不放手(免得在边界上一吸一松地抖);
 *   锁定后**匀速直追船心**、方向每帧重算,净逼近速度 = 磁吸速度 - 船速(那三根旋钮的算术口径);
 *   收取判在**本帧走完的新位置**上,含边界;够得着船心就落在船心,**绝不冲过头**;
 *   返回值是本帧收到的**残骸总量**(value 之和,不是颗数),没收到就是 0;
 *   三根旋钮每帧现读:拖大起吸半径,同一颗残骸当帧就从"整局不动"变成"被吸走"
 *     ——"拾取半径改动可体感验证"(验收标准第四条)在 Node 里能表达的就是这一条,
 *     真人拖面板看手感那一半量不出来,不在这里假装验过;
 *   零分配的可观测形式:收下即复用、复用前逐字段清零(magnet 也得清)。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SIM_DT } from '../core/loop';
import { Pool } from '../core/pool';
import { tuning } from './config';
import { createDeck } from './deck';
import { createDrop, type Drop, DROP_CULL_RADIUS, magnetRadius, resetDrop, stepDrops } from './drop';

/**
 * 基线旋钮:下面所有算术("每帧走 5px""170 起吸")都从这三个数推,不在断言里另写死一份。
 * 显式设定而不是躺在 config 的默认值上,与 ship.test.ts 同一条理由 ——
 * M0 就是要反复拖这几个数,不该拖一下就把这批用例带崩。
 */
const BASE = { dropMagnetRadius: 170, dropMagnetSpeed: 300, dropCollectRadius: 22 };
Object.assign(tuning, BASE);
// 有用例会拖旋钮来验证"每帧现读",跑完必须还原,否则污染同文件后续用例
afterEach(() => Object.assign(tuning, BASE));

/** 每帧位移:磁吸速度 × dt = 5px。写成派生量,拖动基线时这批用例跟着走 */
const STEP = tuning.dropMagnetSpeed * SIM_DT;

/**
 * 一块最普通的空甲板。MVP 的 magnetRadius 压根不看它(恒返回旋钮),
 * 造它只是为了走通那条"起吸半径是甲板的派生量"的挂钩 —— GDD §5.3 的磁力收集器届时就长在这里。
 */
const deck = createDeck();

interface Harness {
  drops: Pool<Drop>;
  /** 船心。用例可以逐帧挪它 —— 世界里船本来就一直在动,而磁吸追的是它现在在哪 */
  ship: { x: number; y: number };
  /** 跑 n 帧,返回这 n 帧一共收到的残骸总量 */
  step(times?: number): number;
}

function harness(shipX = 0, shipY = 0): Harness {
  const drops = new Pool<Drop>(createDrop, resetDrop);
  const ship = { x: shipX, y: shipY };
  return {
    drops,
    ship,
    step(times = 1) {
      let got = 0;
      for (let i = 0; i < times; i++) got += stepDrops(drops, deck, ship.x, ship.y, SIM_DT);
      return got;
    },
  };
}

/**
 * 往池里放一颗停在 (x, y) 的残骸。字段按需覆写,其余走 createDrop 的零值 ——
 * 与 World 掉落时"从池里取一颗已清零的残骸,当场把字段填满"的口径一致。
 * px/py 起手 = 当前位置:敌人倒下的那一刻它还没动过(铁律 2 的两端)。
 */
function dropAt(h: Harness, x: number, y: number, fields: Partial<Drop> = {}): Drop {
  const d = h.drops.spawn();
  d.value = 1; // 缺省面额:多数用例只关心"收到了没有",不关心收了几颗
  Object.assign(d, fields);
  d.x = d.px = x;
  d.y = d.py = y;
  return d;
}

/** 残骸离船心多远 —— 起吸与收取两条判据说的都是这个数 */
function distToShip(h: Harness, d: Drop): number {
  return Math.hypot(d.x - h.ship.x, d.y - h.ship.y);
}

describe('起吸(进过半径一次就锁定)', () => {
  it('半径之外一动不动:残骸不会自己飘过来,也不会被莫名其妙收走', () => {
    const h = harness();
    const d = dropAt(h, tuning.dropMagnetRadius + 1, 0);

    expect(h.step(60)).toBe(0);

    expect(d.magnet).toBe(false);
    expect(d.x).toBe(tuning.dropMagnetRadius + 1);
    expect(d.y).toBe(0);
    expect(h.drops.size).toBe(1);
  });

  it('判据含边界:恰好落在起吸圆上算吸,差千分之一就当没看见', () => {
    const onEdge = harness();
    const a = dropAt(onEdge, tuning.dropMagnetRadius, 0);
    onEdge.step();
    expect(a.magnet).toBe(true);
    expect(a.x).toBeCloseTo(tuning.dropMagnetRadius - STEP, 9);

    const justOut = harness();
    const b = dropAt(justOut, tuning.dropMagnetRadius + 0.001, 0);
    justOut.step();
    expect(b.magnet).toBe(false);
    expect(b.x).toBe(tuning.dropMagnetRadius + 0.001); // 连一丝位移都没有
  });

  it('锁定之后船开出半径也不放手 —— 否则残骸会在边界上一吸一松地抖', () => {
    const h = harness();
    const d = dropAt(h, 100, 0);
    h.step(); // 100 < 170 → 这一帧锁定
    expect(d.magnet).toBe(true);

    // 船一脚油门开到半个世界之外(远超起吸半径):锁定是单向的,它照追不误
    h.ship.x = 2000;
    const before = d.x;
    h.step(10);
    expect(d.magnet).toBe(true);
    expect(d.x - before).toBeCloseTo(STEP * 10, 6); // 每帧照样走满一步,朝着船的新位置

    // 对照:同一时刻新掉的一颗(从没进过半径)一动不动 —— 差别只在"进过没有",不在坐标
    const fresh = dropAt(h, 100, 0);
    h.step(10);
    expect(fresh.magnet).toBe(false);
    expect(fresh.x).toBe(100);
  });

  it('没锁定的残骸按自己的速度漂,磁吸不接管这一段惯性;进圈那一帧才换成磁吸速度', () => {
    const h = harness();
    // 11px/帧 朝船漂:第 4 帧起进圈(200 → 189 → 178 → 167)
    const d = dropAt(h, 200, 0, { vx: -660 });

    h.step(3);
    expect(d.magnet).toBe(false);
    expect(d.vx).toBe(-660); // 漂移速度是掉落方给的,磁吸没碰它
    expect(d.x).toBeCloseTo(167, 6);

    h.step();
    expect(d.magnet).toBe(true);
    expect(d.vx).toBeCloseTo(-tuning.dropMagnetSpeed, 6); // 换成"直追船心 × 磁吸速度"
    expect(d.x).toBeCloseTo(167 - STEP, 6);
  });
});

describe('匀速直追船心', () => {
  it('每帧位移 = 磁吸速度 × dt,方向指向船心(斜着来的也一样)', () => {
    const h = harness();
    const straight = dropAt(h, 100, 0);
    const diagonal = dropAt(h, 60, 80); // 距离 100,单位方向 (-0.6, -0.8)

    h.step();

    expect(straight.x).toBeCloseTo(100 - STEP, 9);
    expect(straight.y).toBe(0);
    expect(diagonal.x).toBeCloseTo(60 - 0.6 * STEP, 9);
    expect(diagonal.y).toBeCloseTo(80 - 0.8 * STEP, 9);
    // 位移的模恒等于一步,与方向无关(匀速,不是分轴各走一步)
    expect(Math.hypot(diagonal.x - 60, diagonal.y - 80)).toBeCloseTo(STEP, 9);
  });

  it('方向每帧重算:船一拐弯,残骸跟着拐,而不是沿锁定那一刻的直线飞过去', () => {
    const h = harness();
    const d = dropAt(h, 0, 100); // 起手正下方 → 朝 -Y 走
    h.step();
    expect(d.vx).toBe(0);
    expect(d.vy).toBeCloseTo(-tuning.dropMagnetSpeed, 6);

    h.ship.x = 500; // 船横着开走
    h.step();
    expect(d.vx).toBeGreaterThan(0); // 追的是船的新位置,不是记忆里那一条
  });

  it('净逼近速度 = 磁吸速度 - 船速:船以巡航速度逃也追得上,拖到船速以下就永远追不上', () => {
    // 这就是 tuning 里那句"dropMagnetSpeed 必须显著大于 shipCruiseSpeed"的算术形式
    const chase = harness();
    const d = dropAt(chase, -30, 0); // 船屁股后面 30px,当帧锁定
    const closing = (tuning.dropMagnetSpeed - tuning.shipCruiseSpeed) * SIM_DT;
    const need = Math.ceil((30 - tuning.dropCollectRadius) / closing) + 1;

    let got = 0;
    for (let i = 0; i < need; i++) {
      chase.ship.x += tuning.shipCruiseSpeed * SIM_DT; // 船先动(与 world.step 的顺序一致)
      got += chase.step();
    }
    expect(got).toBe(d.value);
    expect(chase.drops.size).toBe(0);

    // 反例:磁吸速度拖到船速以下,被吸住的残骸只会越掉越远 —— 追不上就是追不上
    tuning.dropMagnetSpeed = 60;
    const lost = harness();
    const slow = dropAt(lost, -30, 0);
    let total = 0;
    for (let i = 0; i < 120; i++) {
      lost.ship.x += tuning.shipCruiseSpeed * SIM_DT;
      total += lost.step();
    }
    expect(total).toBe(0);
    expect(slow.magnet).toBe(true); // 仍然锁着(不放手),只是够不着
    expect(distToShip(lost, slow)).toBeGreaterThan(30);
  });
});

describe('收取', () => {
  it('判据含边界,且判在**本帧走完的新位置**上(这一帧的位移正是它飞完的最后一段)', () => {
    // 先把磁吸速度停掉,单独钉"多近算收下"这条边界:残骸不动,判的就是帧首那个距离
    tuning.dropMagnetSpeed = 0;
    const onEdge = harness();
    dropAt(onEdge, tuning.dropCollectRadius, 0);
    expect(onEdge.step()).toBe(1);
    expect(onEdge.drops.size).toBe(0);

    const justOut = harness();
    const outside = dropAt(justOut, tuning.dropCollectRadius + 0.001, 0);
    expect(justOut.step(10)).toBe(0);
    expect(justOut.drops.size).toBe(1);

    // 恢复磁吸:帧首 26px 够不着(26 > 22),走完这一帧的 5px 就够得着了 —— 判在积分之后,
    // 反过来的话每颗残骸都要在收取圈里白白多躺一帧
    tuning.dropMagnetSpeed = BASE.dropMagnetSpeed;
    const late = harness();
    dropAt(late, tuning.dropCollectRadius + 4, 0);
    expect(late.step()).toBe(1);
    expect(late.drops.size).toBe(0);
    expect(outside.x).toBe(tuning.dropCollectRadius + 0.001); // 上一段那颗没被顺手挪走
  });

  it('返回的是本帧收到的**总量**(value 之和,不是颗数),没收到就是 0', () => {
    const h = harness();
    dropAt(h, 0, 0, { value: 1 });
    dropAt(h, 5, 0, { value: 2 });
    dropAt(h, 0, 5, { value: 4 });
    dropAt(h, 300, 0, { value: 99 }); // 半径之外,这一帧与它无关

    expect(h.step()).toBe(7);
    expect(h.drops.size).toBe(1);
    expect(h.step()).toBe(0); // 剩下那颗够不着 → 一分不进账(调用方直接 += 这个数)
  });

  it('一帧位移够得着船心就落在船心、绝不冲过头 —— 收取半径拖到 0 也收得下', () => {
    // 冲过头的残骸下一帧要掉头回来,于是在收取半径小于一帧位移时会绕着船心来回抖、永远收不下
    tuning.dropCollectRadius = 0;
    const h = harness();
    dropAt(h, 3, 0); // 3px < 一帧的 5px

    expect(h.step()).toBe(1);
    expect(h.drops.size).toBe(0);
  });

  it('同帧收下一片(含末尾与相邻)一个不漏,够不着的一颗不误收 —— 倒序 swap-remove 的下标坑', () => {
    const h = harness();
    const all: Drop[] = [];
    for (let i = 0; i < 5; i++) {
      // 0/3/4 号(队首 + 队尾相邻两颗)贴在船心上必被收下,1/2 号远在起吸半径之外
      const collected = i === 0 || i === 3 || i === 4;
      all.push(dropAt(h, collected ? 0 : 400, 0, { value: i + 1 }));
    }

    expect(h.step()).toBe(1 + 4 + 5);

    expect(h.drops.size).toBe(2);
    expect(new Set(h.drops.items)).toEqual(new Set([all[1]!, all[2]!]));
  });
});

describe('旋钮每帧现读(验收标准第四条:拾取半径改动可体感验证)', () => {
  it('拖大起吸半径,同一颗残骸当帧从"整局不动"变成"被吸走"', () => {
    const h = harness();
    const d = dropAt(h, 300, 0);

    expect(h.step(60)).toBe(0); // 300 > 170:一秒过去了,它还躺在原地
    expect(d.x).toBe(300);

    tuning.dropMagnetRadius = 400; // 面板上拖一下(不重开一局、不重建任何东西)
    h.step();
    expect(d.magnet).toBe(true);
    expect(d.x).toBeCloseTo(300 - STEP, 9);
  });

  it('magnetRadius 是"起吸半径 = 甲板的派生量"这条挂钩,MVP 恒 = 旋钮本身', () => {
    // GDD §5.3 的磁力收集器("拾取半径 +30%")届时只填这个函数体,stepDrops 一个字都不用改
    expect(magnetRadius(deck)).toBe(tuning.dropMagnetRadius);
    tuning.dropMagnetRadius = 999;
    expect(magnetRadius(deck)).toBe(999);
  });
});

describe('对象池与零分配(铁律 2 / 铁律 3)', () => {
  it('px/py = 上一逻辑帧位置(渲染插值的两端),吸着走的与躺着漂的都维护', () => {
    const h = harness();
    const pulled = dropAt(h, 100, 0);
    const drifting = dropAt(h, 400, 0, { vx: 60, vy: -60 });

    h.step();

    expect(pulled.px).toBe(100);
    expect(pulled.py).toBe(0);
    expect(pulled.x).toBeCloseTo(100 - STEP, 9);

    expect(drifting.px).toBe(400);
    expect(drifting.py).toBe(0);
    expect(drifting.x).toBeCloseTo(400 + 60 * SIM_DT, 12);
    expect(drifting.y).toBeCloseTo(-60 * SIM_DT, 12);
  });

  it('收下的残骸回池被下一颗复用,且复用前逐字段清回初值(magnet 尤其不能漏)', () => {
    const h = harness();
    const first = dropAt(h, 30, 0, { value: 7 });
    h.step(3); // 吸进来 → 收下 → 回池
    expect(h.drops.size).toBe(0);
    expect(first.magnet).toBe(true);

    const second = h.drops.spawn();
    expect(second).toBe(first); // 同一个对象:没有 new 出新的,这就是"回收进池"的证据
    // 漏清 magnet 的话,这颗新掉的残骸一出生就自带磁吸,隔着半个屏幕直奔船而来
    expect(second).toEqual(createDrop());
  });

  it('resetDrop:Object.keys 的每个字段都清回初值 —— 将来加字段忘了重置会被这条抓住', () => {
    const d = createDrop();
    const rec = d as unknown as Record<string, number | boolean>;
    const initial = { ...rec }; // createDrop() 的返回值即"初值"的定义
    const keys = Object.keys(rec);
    expect(keys.length).toBeGreaterThan(0);

    for (const k of keys) {
      const v = rec[k];
      // 逐字段弄脏(数字 +13、布尔取反),保证下面的断言不会空过
      rec[k] = typeof v === 'boolean' ? !v : (v as number) + 13;
      expect(rec[k]).not.toBe(initial[k]);
    }

    resetDrop(d);
    for (const k of keys) expect(rec[k]).toBe(initial[k]);
  });

  it('空池的一帧什么都不做,返回 0(还没死过人的甲板不该为掉落白掏任何开销)', () => {
    const h = harness();
    expect(h.step(10)).toBe(0);
    expect(h.drops.size).toBe(0);
  });
});

describe('离场剔除(无限地图:被甩在身后的残骸不许白占池位)', () => {
  it('离船超过 DROP_CULL_RADIUS 的未锁定残骸当帧回池,按 ceil(value/2) 折半入账', () => {
    const h = harness();
    dropAt(h, DROP_CULL_RADIUS + 1, 0, { value: 4 });
    // 折半回收(畅玩性调整):风筝远离的打法从"静默漏钱"变成"远程收一半",
    // 亲自去捡仍收满额 —— 下限保住了,激励没丢
    expect(h.step()).toBe(2);
    expect(h.drops.size).toBe(0);
  });

  it('面额 1 的残骸折半按 ceil 收 1,绝不折成 0(否则最常见的蜂群残骸又回到静默漏钱)', () => {
    const h = harness();
    dropAt(h, DROP_CULL_RADIUS + 1, 0, { value: 1 });
    expect(h.step()).toBe(1);
    expect(h.drops.size).toBe(0);
  });

  it('恰好压在剔除圆上的还留着(> 才剔:与起吸"含边界算吸"相反侧的同一条口径)', () => {
    const h = harness();
    dropAt(h, DROP_CULL_RADIUS, 0);
    expect(h.step(10)).toBe(0);
    expect(h.drops.size).toBe(1);
  });

  it('已锁定的绝不剔除:那是一笔已承诺的进账,船跑到天边它也照追', () => {
    const h = harness();
    const d = dropAt(h, tuning.dropMagnetRadius, 0); // 恰在起吸圆上,当帧锁定
    h.step();
    expect(d.magnet).toBe(true);

    h.ship.x = DROP_CULL_RADIUS * 2; // 船瞬移出圈:未锁定的话这颗当帧就该没了
    h.step(5);
    expect(h.drops.size).toBe(1);
    expect(d.vx).toBeGreaterThan(0); // 还在朝船追
  });
});
