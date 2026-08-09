/**
 * HUD 的关键规则都在纯函数上钉住:条形夹取、航段进度、绝对角到屏幕边缘、强度双通道表现。
 * 末尾的小 DOM 桩只守重开/时停这两条流程约束:单实例换 World,不重复挂节点或监听器。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EDICT_GYRO, EDICT_HULL, EDICT_TRACER, EDICTS, edictMask } from '../data/edicts';
import { UNLOCKS } from '../data/unlocks';
import { WAVE_SEGMENTS } from '../data/waves';
import type { World } from '../sim/world';
import { createHud, hudRatio, segmentReadout, THREAT_INTENSITY_MAX, threatVisual } from './hud';

describe('hudRatio / segmentReadout', () => {
  it('条形进度夹在 [0,1],坏分母与 NaN 不流进 CSS', () => {
    expect(hudRatio(25, 100)).toBe(0.25);
    expect(hudRatio(-1, 100)).toBe(0);
    expect(hudRatio(200, 100)).toBe(1);
    expect(hudRatio(Number.NaN, 100)).toBe(0);
    expect(hudRatio(10, 0)).toBe(0);
    expect(hudRatio(10, Number.NaN)).toBe(0);
  });

  it('航段从 WAVE_SEGMENTS 派生名字、n/N 与段内进度', () => {
    const first = WAVE_SEGMENTS[0]!;
    const readout = segmentReadout(0, first.duration * 0.5);
    expect(readout.label).toContain(first.name);
    expect(readout.label).toContain(`1/${WAVE_SEGMENTS.length}`);
    expect(readout.ratio).toBe(0.5);
  });

  it('脚本走完钉在满格,不印出 5/4', () => {
    const done = segmentReadout(WAVE_SEGMENTS.length, 999);
    expect(done.label).toBe(`${WAVE_SEGMENTS.length}/${WAVE_SEGMENTS.length} 全通`);
    expect(done.ratio).toBe(1);
  });
});

describe('threatVisual', () => {
  it('世界绝对角映射到对应可用屏幕边缘,箭头由来敌侧朝屏幕内', () => {
    const right = threatVisual(0, 1, 1000, 600);
    const down = threatVisual(Math.PI * 0.5, 1, 1000, 600);
    const left = threatVisual(Math.PI, 1, 1000, 600);
    expect(right.x).toBeGreaterThan(680);
    expect(right.x).toBeLessThan(730);
    expect(right.y).toBeCloseTo(300);
    expect(right.rotationDeg).toBeCloseTo(180);
    expect(down.x).toBeCloseTo(500);
    expect(down.y).toBeGreaterThan(500);
    expect(down.rotationDeg).toBeCloseTo(270);
    expect(left.x).toBeLessThan(100);
    expect(left.y).toBeCloseTo(300);
    expect(left.rotationDeg).toBeCloseTo(360);
  });

  it('强度同时加粗/放大箭头并提高透明度/亮度', () => {
    const low = threatVisual(0, 0, 1280, 720);
    const high = threatVisual(0, THREAT_INTENSITY_MAX, 1280, 720);
    expect(high.sizePx).toBeGreaterThan(low.sizePx);
    expect(high.linePx).toBeGreaterThan(low.linePx);
    expect(high.opacity).toBeGreaterThan(low.opacity);
    expect(high.brightness).toBeGreaterThan(low.brightness);
  });

  it('NaN / 负强度 / 坏视口全部回落成有限值', () => {
    for (const visual of [
      threatVisual(Number.NaN, Number.NaN, Number.NaN, -1),
      threatVisual(Number.POSITIVE_INFINITY, -100, 0, 0),
    ]) {
      for (const value of Object.values(visual)) expect(Number.isFinite(value)).toBe(true);
      expect(visual.strength).toBe(0);
    }
  });
});

interface StubStyle {
  cssText: string;
  [key: string]: string;
}

interface StubEl {
  tagName: string;
  style: StubStyle;
  textContent: string;
  title: string;
  children: StubEl[];
  listeners: Map<string, (e?: unknown) => void>;
  append(...kids: StubEl[]): void;
  appendChild(kid: StubEl): StubEl;
  addEventListener(type: string, fn: (e?: unknown) => void): void;
}

function createStubEl(tag = 'div'): StubEl {
  const el: StubEl = {
    tagName: tag.toUpperCase(),
    style: { cssText: '' },
    textContent: '',
    title: '',
    children: [],
    listeners: new Map(),
    append(...kids: StubEl[]): void {
      el.children.push(...kids);
    },
    appendChild(kid: StubEl): StubEl {
      el.children.push(kid);
      return kid;
    },
    addEventListener(type: string, fn: (e?: unknown) => void): void {
      el.listeners.set(type, fn);
    },
  };
  return el;
}

interface StubDom {
  ui: StubEl;
  windowListeners: number;
  /** toast 的到点计时器桩(与 upgradeFlow/refitFlow 的桩同款) */
  timers: Map<number, () => void>;
  fireTimers(): void;
  restore(): void;
}

function installDom(): StubDom {
  const g = globalThis as unknown as Record<string, unknown>;
  const prevWindow = g.window;
  const prevDocument = g.document;
  let nextTimer = 0;
  const timers = new Map<number, () => void>();
  const dom: StubDom = {
    ui: createStubEl(),
    windowListeners: 0,
    timers,
    fireTimers(): void {
      for (const fn of [...timers.values()]) fn();
      timers.clear();
    },
    restore(): void {
      g.window = prevWindow;
      g.document = prevDocument;
    },
  };
  g.window = {
    innerWidth: 1000,
    innerHeight: 600,
    addEventListener(): void {
      dom.windowListeners++;
    },
    setTimeout(fn: () => void): number {
      const id = nextTimer++;
      timers.set(id, fn);
      return id;
    },
    clearTimeout(id: number): void {
      timers.delete(id);
    },
  };
  g.document = {
    createElement: (tag: string): StubEl => createStubEl(tag),
    getElementById: (id: string): StubEl | null => (id === 'ui' ? dom.ui : null),
  };
  return dom;
}

interface StubEnemy {
  kind?: number;
  affixes: number;
  hp: number;
  maxHp: number;
}

interface StubWorld {
  ship: { hp: number; maxHp: number };
  scrap: number;
  starCoins: number;
  upgradeCost: number;
  elapsed: number;
  wave: { segment: number; segTime: number };
  threatDirection: number;
  threatIntensity: number;
  burstWarning(): { etaSeconds: number; dirRad: number } | null;
  enemies: { items: StubEnemy[] };
  /** 已持有法令掩码(18 号):HUD 徽记按它逐位查名字 */
  edicts: number;
  /** 解锁状态掩码(19 号):位 i = UNLOCKS[i] 开没开;图鉴计数按它数置位 */
  unlockMask: number;
}

function stubWorld(over: Partial<StubWorld> = {}): StubWorld {
  return {
    ship: { hp: 75, maxHp: 100 },
    scrap: 10,
    starCoins: 10,
    upgradeCost: 40,
    elapsed: 65,
    wave: { segment: 0, segTime: WAVE_SEGMENTS[0]!.duration * 0.5 },
    threatDirection: 0,
    threatIntensity: THREAT_INTENSITY_MAX * 0.5,
    burstWarning: () => null,
    enemies: { items: [] },
    edicts: 0,
    unlockMask: 0,
    ...over,
  };
}

/** 在桩树里找包含某段文字的节点 */
function findText(root: StubEl, part: string): StubEl | undefined {
  if (root.textContent.includes(part)) return root;
  for (const child of root.children) {
    const found = findText(child, part);
    if (found) return found;
  }
  return undefined;
}

describe('createHud', () => {
  let dom: StubDom;

  beforeEach(() => {
    dom = installDom();
  });
  afterEach(() => {
    dom.restore();
  });

  it('固定在屏幕空间、中央不挂面板,且不接管任何指针/窗口事件', () => {
    createHud({ world: stubWorld() as unknown as World });
    const root = dom.ui.children[0]!;
    expect(root.style.cssText).toContain('position:fixed');
    expect(root.style.cssText).toContain('pointer-events:none');
    // 只含上沿读数、两支边缘箭头(实况罗盘 + burst 预警)、左下角静音开关
    // 与屏下缘两根血条(精英 + Boss)、星币读数、法令徽记(18 号)、解锁 toast
    // 与图鉴读数(19 号),没有按敌人数增长的节点或中央遮罩
    expect(root.children.length).toBe(10);
    expect(dom.windowListeners).toBe(0);
  });

  it('同步 HP、升级进度、计时器、航段和威胁箭头', () => {
    createHud({ world: stubWorld() as unknown as World });
    const root = dom.ui.children[0]!;
    expect(findText(root, '75 / 100')).toBeDefined();
    expect(findText(root, '10 / 40')).toBeDefined();
    expect(findText(root, '1:05')).toBeDefined();
    expect(findText(root, WAVE_SEGMENTS[0]!.name)).toBeDefined();
    const threat = root.children[1]!;
    expect(threat.title).toBe('主压方向');
    expect(Number.parseFloat(threat.style.left!)).toBeGreaterThan(680);
    expect(Number.parseFloat(threat.style.left!)).toBeLessThan(730);
    expect(threat.style.transform).toContain('rotate(180deg)');
    expect(threat.style.opacity).not.toBe('');
  });

  it('星币读数:与残骸同族的独立面板,显示余额且 setWorld 换世界同步更新', () => {
    const hud = createHud({ world: stubWorld({ starCoins: 27 }) as unknown as World });
    const root = dom.ui.children[0]!;
    const coins = root.children[6]!;
    expect(coins.title).toBe('星币');
    expect(findText(root, '★ 星币')).toBeDefined();
    const value = coins.children[0]!.children[1]!;
    expect(value.textContent).toBe('27');

    hud.setWorld(stubWorld({ starCoins: 4 }) as unknown as World);
    expect(value.textContent).toBe('4');
  });

  it('法令徽记:无法令时隐藏,持有后按掩码印出名字,setWorld 换世界同步更新', () => {
    const hud = createHud({ world: stubWorld() as unknown as World });
    const root = dom.ui.children[0]!;
    const edicts = root.children[7]!;
    expect(edicts.title).toBe('已生效法令');
    // 简单口径:无法令整体隐藏(display:none),持有才亮
    expect(edicts.style.display).toBe('none');

    // 抽到曳光协议 + 结构加固:掩码两位置位,徽记按名字显示,未持有的不出现
    hud.setWorld(
      stubWorld({ edicts: edictMask(EDICT_TRACER) | edictMask(EDICT_HULL) }) as unknown as World,
    );
    expect(edicts.style.display).toBe('block');
    expect(findText(root, EDICTS[EDICT_TRACER]!.name)).toBeDefined();
    expect(findText(root, EDICTS[EDICT_HULL]!.name)).toBeDefined();
    expect(findText(root, EDICTS[EDICT_GYRO]!.name)).toBeUndefined();

    // 重开一局(新世界无法令):徽记当帧收起
    hud.setWorld(stubWorld() as unknown as World);
    expect(edicts.style.display).toBe('none');
  });

  it('图鉴读数:按 world.unlockMask 置位数显示已解锁数/总数,setWorld 换世界当帧跟上', () => {
    const hud = createHud({ world: stubWorld({ unlockMask: 0b011 }) as unknown as World });
    const root = dom.ui.children[0]!;
    const collection = root.children[9]!;
    expect(collection.title).toBe('图鉴');
    expect(findText(root, '图鉴')).toBeDefined();
    const value = collection.children[0]!.children[1]!;
    // 位 0 + 位 1 置位 = 已解锁 2 条;总数直取 UNLOCKS.length(与 World 掩码同编码)
    expect(value.textContent).toBe(`2/${UNLOCKS.length}`);

    // 全解锁掩码:计数当帧跟上
    hud.setWorld(stubWorld({ unlockMask: (1 << UNLOCKS.length) - 1 }) as unknown as World);
    expect(value.textContent).toBe(`${UNLOCKS.length}/${UNLOCKS.length}`);

    // 空掩码(新档):归零
    hud.setWorld(stubWorld() as unknown as World);
    expect(value.textContent).toBe(`0/${UNLOCKS.length}`);
  });

  it('解锁 toast:toast() 亮出"解锁 XX",到点自动消失;setWorld 换局清掉上一局的提示', () => {
    const hud = createHud({ world: stubWorld() as unknown as World });
    const root = dom.ui.children[0]!;
    const toastEl = root.children[8]!;
    // 初始隐藏(display:none 写在 cssText 里,toast() 点亮时才落成 style.display 属性)
    expect(toastEl.style.cssText).toContain('display:none');

    hud.toast('解锁:导弹巢');
    expect(toastEl.textContent).toBe('解锁:导弹巢');
    expect(toastEl.style.display).toBe('block');
    // 长在 pointer-events:none 的根里,不抢焦点
    expect(root.style.cssText).toContain('pointer-events:none');

    // 到点自动消失
    dom.fireTimers();
    expect(toastEl.style.display).toBe('none');
    expect(toastEl.textContent).toBe('');
    expect(dom.timers.size).toBe(0);

    // 再弹一条;换局(setWorld)当场清掉,计时器也不留
    hud.toast('解锁:急速协议');
    expect(toastEl.style.display).toBe('block');
    expect(dom.timers.size).toBe(1);
    hud.setWorld(stubWorld() as unknown as World);
    expect(toastEl.style.display).toBe('none');
    expect(toastEl.textContent).toBe('');
    expect(dom.timers.size).toBe(0);
  });

  it('静音开关:默认有声,点击在开/关之间切换并同步文字与颜色', () => {
    createHud({ world: stubWorld() as unknown as World });
    const mute = dom.ui.children[0]!.children[3]!;
    expect(mute.title).toBe('静音开关');
    expect(mute.textContent).toBe('声音:开');
    const colorOn = mute.style.color;
    mute.listeners.get('click')!(undefined);
    expect(mute.textContent).toBe('声音:关');
    expect(mute.style.color).not.toBe(colorOn);
    mute.listeners.get('click')!(undefined);
    expect(mute.textContent).toBe('声音:开');
    expect(mute.style.color).toBe(colorOn);
  });

  it('精英血条:无精英隐藏,有精英亮出并反映 hp/maxHp', () => {
    const hud = createHud({ world: stubWorld() as unknown as World });
    const root = dom.ui.children[0]!;
    const elite = root.children[4]!;
    expect(elite.style.display).toBe('none');

    hud.setWorld(
      stubWorld({ enemies: { items: [{ affixes: 0b101, hp: 30, maxHp: 200 }] } }) as unknown as World,
    );
    expect(elite.style.display).toBe('block');
    expect(findText(root, '30 / 200')).toBeDefined();
    const fill = elite.children[1]!.children[0]!;
    expect(fill.style.width).toBe('15%');

    // 精英退场(死亡回池)当帧隐藏
    hud.setWorld(stubWorld() as unknown as World);
    expect(elite.style.display).toBe('none');
  });

  it('精英血条:多只精英钉池序第一只,第一只退场后切到剩下那只', () => {
    const hud = createHud({
      world: stubWorld({
        enemies: {
          items: [
            { affixes: 0b001, hp: 10, maxHp: 100 },
            { affixes: 0b010, hp: 90, maxHp: 100 },
          ],
        },
      }) as unknown as World,
    });
    const root = dom.ui.children[0]!;
    expect(findText(root, '10 / 100')).toBeDefined();

    hud.setWorld(
      stubWorld({ enemies: { items: [{ affixes: 0b010, hp: 45, maxHp: 100 }] } }) as unknown as World,
    );
    expect(findText(root, '45 / 100')).toBeDefined();
    expect(findText(root, '10 / 100')).toBeUndefined();
  });

  it('Boss 血条:常驻直到击杀 —— 无 Boss 隐藏,有 Boss 亮出并反映 hp/maxHp,出池当帧隐藏', () => {
    const hud = createHud({ world: stubWorld() as unknown as World });
    const root = dom.ui.children[0]!;
    const boss = root.children[5]!;
    expect(boss.style.display).toBe('none');

    // Boss(kind 4,affixes 恒 0)进场:血条亮出,比例钉 Boss 本体的 hp/maxHp
    hud.setWorld(
      stubWorld({ enemies: { items: [{ kind: 4, affixes: 0, hp: 240, maxHp: 480 }] } }) as unknown as World,
    );
    expect(boss.style.display).toBe('block');
    expect(findText(root, '240 / 480')).toBeDefined();
    const fill = boss.children[1]!.children[0]!;
    expect(fill.style.width).toBe('50%');

    // 击杀(Boss 出池)当帧隐藏
    hud.setWorld(stubWorld() as unknown as World);
    expect(boss.style.display).toBe('none');
  });

  it('Boss 血条与精英血条互不复用:场上有 Boss 又有精英时两根条各亮各的', () => {
    createHud({
      world: stubWorld({
        enemies: {
          items: [
            { affixes: 0b001, hp: 30, maxHp: 200 },
            { kind: 4, affixes: 0, hp: 240, maxHp: 480 },
          ],
        },
      }) as unknown as World,
    });
    const root = dom.ui.children[0]!;
    const elite = root.children[4]!;
    const boss = root.children[5]!;
    expect(elite.style.display).toBe('block');
    expect(boss.style.display).toBe('block');
    expect(findText(root, '30 / 200')).toBeDefined();
    expect(findText(root, '240 / 480')).toBeDefined();
  });

  it('时停淡出;重开只换 World 引用,不重复 append DOM', () => {
    const hud = createHud({ world: stubWorld() as unknown as World });
    const root = dom.ui.children[0]!;
    hud.setPaused(true);
    expect(Number(root.style.opacity)).toBeLessThan(0.1);
    hud.setPaused(false);
    expect(root.style.opacity).toBe('1');

    const next = stubWorld({
      ship: { hp: 12, maxHp: 90 },
      scrap: 33,
      upgradeCost: 55,
      elapsed: 130,
      threatDirection: Math.PI,
    });
    hud.setWorld(next as unknown as World);
    expect(dom.ui.children.length).toBe(1);
    expect(findText(root, '12 / 90')).toBeDefined();
    expect(findText(root, '33 / 55')).toBeDefined();
    expect(findText(root, '2:10')).toBeDefined();
    expect(Number.parseFloat(root.children[1]!.style.left!)).toBeLessThan(100);
  });

  it('burst 预警:进窗才亮出第二支箭头,窗外与无事件时都藏着', () => {
    const hud = createHud({
      world: stubWorld({ burstWarning: () => ({ etaSeconds: 1.5, dirRad: 0 }) }) as unknown as World,
    });
    const root = dom.ui.children[0]!;
    const warn = root.children[2]!;
    expect(warn.title).toBe('即将来袭');
    expect(warn.style.display).toBe('block');
    expect(warn.style.opacity).not.toBe('');

    // 距触发还远(窗外):预警不该常驻刷屏
    hud.setWorld(stubWorld({ burstWarning: () => ({ etaSeconds: 30, dirRad: 0 }) }) as unknown as World);
    expect(warn.style.display).toBe('none');
    // 本段 burst 已放完 / 脚本走完:burstWarning 返回 null
    hud.setWorld(stubWorld() as unknown as World);
    expect(warn.style.display).toBe('none');
  });
});
