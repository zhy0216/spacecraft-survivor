/**
 * HUD 的关键规则都在纯函数上钉住:条形夹取、航段进度、绝对角到屏幕边缘、强度双通道表现。
 * 末尾的小 DOM 桩只守重开/时停这两条流程约束:单实例换 World,不重复挂节点或监听器。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  restore(): void;
}

function installDom(): StubDom {
  const g = globalThis as unknown as Record<string, unknown>;
  const prevWindow = g.window;
  const prevDocument = g.document;
  const dom: StubDom = {
    ui: createStubEl(),
    windowListeners: 0,
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
  };
  g.document = {
    createElement: (tag: string): StubEl => createStubEl(tag),
    getElementById: (id: string): StubEl | null => (id === 'ui' ? dom.ui : null),
  };
  return dom;
}

interface StubEnemy {
  affixes: number;
  hp: number;
  maxHp: number;
}

interface StubWorld {
  ship: { hp: number; maxHp: number };
  scrap: number;
  upgradeCost: number;
  elapsed: number;
  wave: { segment: number; segTime: number };
  threatDirection: number;
  threatIntensity: number;
  burstWarning(): { etaSeconds: number; dirRad: number } | null;
  enemies: { items: StubEnemy[] };
}

function stubWorld(over: Partial<StubWorld> = {}): StubWorld {
  return {
    ship: { hp: 75, maxHp: 100 },
    scrap: 10,
    upgradeCost: 40,
    elapsed: 65,
    wave: { segment: 0, segTime: WAVE_SEGMENTS[0]!.duration * 0.5 },
    threatDirection: 0,
    threatIntensity: THREAT_INTENSITY_MAX * 0.5,
    burstWarning: () => null,
    enemies: { items: [] },
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
    // 与屏下缘精英血条,没有按敌人数增长的节点或中央遮罩
    expect(root.children.length).toBe(5);
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
