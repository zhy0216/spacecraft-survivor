/**
 * HUD 的关键规则都在纯函数上钉住:条形夹取、航段进度、绝对角到屏幕边缘、强度双通道表现。
 * 末尾的小 DOM 桩只守重开/时停这两条流程约束:单实例换 World,不重复挂节点或监听器。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEdictLevels, EDICT_AMMO, EDICT_ARMOR, EDICT_GYRO, EDICTS } from '../data/edicts';
import { WEAPON_SLOT_COUNT } from '../sim/armory';
import { KIND_BOSS } from '../data/enemies';
import { TOWER_AUTOCANNON, TOWER_LASER, TOWERS } from '../data/towers';
import { UNLOCKS } from '../data/unlocks';
import { WAVE_SEGMENTS, BURST_PATTERN_RING } from '../data/waves';
import type { WeaponSlot } from '../sim/armory';
import { createEdictBuffs, type EdictBuffs } from '../sim/edictBuffs';
import {
  FIRE_CHARGING,
  FIRE_COOLDOWN,
  FIRE_LOCKED,
  FIRE_READY,
  FIRE_RELOAD,
  slotSustainedDps,
} from '../sim/tower';
import type { World } from '../sim/world';
import { initI18n } from '../i18n';
import {
  boostReadout,
  createHud,
  fireReadoutColor,
  fireReadoutText,
  formatDps,
  hudRatio,
  radarProject,
  segmentReadout,
  THREAT_INTENSITY_MAX,
  threatVisual,
} from './hud';
import { edictName, towerName, waveSegmentName } from './presentation/contentText';
import { edictDesc, edictScopeLabel } from './presentation/edictText';

beforeEach(async () => {
  await initI18n('zh-CN');
});

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
    expect(readout.label).toContain(waveSegmentName(0));
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
  /** 法令 tooltip 定位要读面板几何(showEdictTip):桩一律报零,够用 */
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number };
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
    getBoundingClientRect(): { left: number; top: number; right: number; bottom: number } {
      return { left: 0, top: 0, right: 0, bottom: 0 };
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
  /** x/y 是商店信标那一行要的:HUD 报「还剩几秒 · 还有多远」,距离取船心到信标 */
  ship: { hp: number; maxHp: number; x: number; y: number };
  scrap: number;
  starCoins: number;
  upgradeCost: number;
  elapsed: number;
  wave: { segment: number; segTime: number };
  threatDirection: number;
  threatIntensity: number;
  burstWarning(): { etaSeconds: number; dirRad: number; pattern: number } | null;
  enemies: { items: StubEnemy[] };
  /** 已持有法令的层数表:HUD 徽记按它逐条查名字,层数 ≥ 2 的挂 ×N */
  edictLevels: number[];
  /** 地图商店信标:HUD 那一行倒计时按它显示"还剩几秒 · 还有多远" */
  shopBeaconActive: boolean;
  shopBeaconX: number;
  shopBeaconY: number;
  shopBeaconTtl: number;
  /** 解锁状态掩码(19 号):位 i = UNLOCKS[i] 开没开;图鉴计数按它数置位 */
  unlockMask: number;
  /** 火力统计面板:击杀数 + 武器槽(名字/等级/节流状态出格)+ 支援聚合(理论 DPS 的倍率来源) */
  kills: number;
  weapons: WeaponSlot[];
  buffs: EdictBuffs;
  /** 加速技能(空格)的两个计时器:HUD 冷却条读它们 */
  boostTime: number;
  boostCooldown: number;
}

/** 武器槽桩:节流状态全零(就绪),用例按需覆写装填/锁死/蓄力 */
function stubWeapon(type: number, stars: number, over: Partial<WeaponSlot> = {}): WeaponSlot {
  return {
    type,
    stars,
    cooldown: 0,
    ammo: 1,
    reloadLeft: 0,
    heat: 0,
    coolLock: 0,
    charge: 1,
    turretOffset: 0,
    ...over,
  };
}

function stubWorld(over: Partial<StubWorld> = {}): StubWorld {
  return {
    ship: { hp: 75, maxHp: 100, x: 0, y: 0 },
    scrap: 10,
    starCoins: 10,
    upgradeCost: 40,
    elapsed: 65,
    wave: { segment: 0, segTime: WAVE_SEGMENTS[0]!.duration * 0.5 },
    threatDirection: 0,
    threatIntensity: THREAT_INTENSITY_MAX * 0.5,
    burstWarning: () => null,
    enemies: { items: [] },
    edictLevels: createEdictLevels(),
    shopBeaconActive: false,
    shopBeaconX: 0,
    shopBeaconY: 0,
    shopBeaconTtl: 0,
    unlockMask: 0,
    kills: 0,
    weapons: [],
    buffs: createEdictBuffs(),
    boostTime: 0,
    boostCooldown: 0,
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
    // 只含上沿读数(左列纵队:vitals/星币/法令/图鉴/火力全在 grid 第一格里)、
    // 两支边缘箭头(实况罗盘 + burst 预警)、左下角静音开关、静音开关正上方的键位提示行
    // (28 号新增节点 —— 计数 10 → 11,它插在 muteBtn 之后、精英血条之前)、
    // 屏下缘两根血条(精英 + Boss)、解锁 toast、段落横幅(26 号,display:none 的常驻节点)、
    // 战术雷达以及低血量红晕(畅玩性),
    // 没有按敌人数增长的节点或中央遮罩 —— 雷达把几百个点画在一块 canvas 里,不铺 DOM
    // (法令悬停 tooltip 是第 12 个根节点:常驻隐藏,悬停法令 chip 才点亮)
    expect(root.children.length).toBe(12);
    expect(dom.windowListeners).toBe(0);
  });

  it('同步 HP、升级进度、计时器、航段和威胁箭头', () => {
    createHud({ world: stubWorld() as unknown as World });
    const root = dom.ui.children[0]!;
    expect(findText(root, '75 / 100')).toBeDefined();
    // 玩家形态(默认)不亮经验数值:读数留空,升级进度只靠进度条比例(10/40 → 25%)
    expect(findText(root, '10 / 40')).toBeUndefined();
    // 顶栏 grid 第一格是左列纵队,vitals 是纵队第一块
    const vitals = root.children[0]!.children[0]!.children[0]!;
    expect(vitals.children[2]!.children[1]!.textContent).toBe('');
    expect(vitals.children[3]!.children[0]!.style.width).toBe('25%');
    expect(findText(root, '1:05')).toBeDefined();
    expect(findText(root, waveSegmentName(0))).toBeDefined();
    const threat = root.children[1]!;
    expect(threat.title).toBe('主压方向');
    expect(Number.parseFloat(threat.style.left!)).toBeGreaterThan(680);
    expect(Number.parseFloat(threat.style.left!)).toBeLessThan(730);
    expect(threat.style.transform).toContain('rotate(180deg)');
    expect(threat.style.opacity).not.toBe('');
  });

  it('经验读数按形态分流:debug 注入才显示精确数值,默认玩家形态为空字符串', () => {
    // 开发形态(main 解析 ?debug 后注入 debug: true):精确读数照旧
    createHud({ world: stubWorld() as unknown as World, debug: true });
    expect(findText(dom.ui.children[0]!, '10 / 40')).toBeDefined();

    // 玩家形态(默认不传 debug):同一世界的数值区是空字符串
    createHud({ world: stubWorld() as unknown as World });
    const playerVitals = dom.ui.children[1]!.children[0]!.children[0]!.children[0]!;
    expect(playerVitals.children[2]!.children[1]!.textContent).toBe('');
  });

  it('星币读数:左列纵队第二块(血条面板正下方,不再自记偏移),单行分两列显示余额与场上怪数,setWorld 同步更新', () => {
    const hud = createHud({
      world: stubWorld({
        starCoins: 27,
        enemies: {
          items: [
            { affixes: 0, hp: 1, maxHp: 1 },
            { affixes: 0, hp: 1, maxHp: 1 },
            { affixes: 0, hp: 1, maxHp: 1 },
          ],
        },
      }) as unknown as World,
    });
    const root = dom.ui.children[0]!;
    const coins = root.children[0]!.children[0]!.children[1]!;
    expect(coins.title).toBe('星币');
    expect(findText(root, '★ 星币')).toBeDefined();
    // 单行两列:starRow.children[0] = 余额组,children[1] = 场上怪组;各组 [label, value]
    const row = coins.children[0]!;
    const coinValue = row.children[0]!.children[1]!;
    const enemyValue = row.children[1]!.children[1]!;
    expect(coinValue.textContent).toBe('27');
    expect(enemyValue.textContent).toBe('3');

    hud.setWorld(stubWorld({ starCoins: 4, enemies: { items: [{ affixes: 0, hp: 1, maxHp: 1 }] } }) as unknown as World);
    expect(coinValue.textContent).toBe('4');
    expect(enemyValue.textContent).toBe('1');
  });

  it('法令徽记:无法令时隐藏,持有后印名字、叠层挂 ×N,setWorld 换世界同步更新', () => {
    const hud = createHud({ world: stubWorld() as unknown as World });
    const root = dom.ui.children[0]!;
    const edicts = root.children[0]!.children[0]!.children[3]!;
    expect(edicts.title).toBe('已生效法令');
    // 简单口径:无法令整体隐藏(display:none),持有才亮
    expect(edicts.style.display).toBe('none');

    // 弹药协议 1 层 + 装甲协议 2 层:徽记按名字显示,叠到 2 层的那条挂 ×2,未持有的不出现
    const levels = createEdictLevels();
    levels[EDICT_AMMO] = 1;
    levels[EDICT_ARMOR] = 2;
    hud.setWorld(stubWorld({ edictLevels: levels }) as unknown as World);
    expect(edicts.style.display).toBe('block');
    expect(findText(root, edictName(EDICT_AMMO))).toBeDefined();
    // "拿过两次过热上限就显示 过热上限 ×2" —— 这一行就是那条要求的落点
    expect(findText(root, `${edictName(EDICT_ARMOR)}×2`)).toBeDefined();
    expect(findText(root, edictName(EDICT_GYRO))).toBeUndefined();

    // 重开一局(新世界无法令):徽记当帧收起
    hud.setWorld(stubWorld() as unknown as World);
    expect(edicts.style.display).toBe('none');
  });

  it('法令 chip 悬停 tooltip:点亮名字×层/作用域/一层效果,移开即隐;面板底色之上必须显式给定文字色', () => {
    const levels = createEdictLevels();
    levels[EDICT_AMMO] = 1;
    createHud({ world: stubWorld({ edictLevels: levels }) as unknown as World });
    const root = dom.ui.children[0]!;
    const tip = root.children[11]!;
    expect(tip.style.cssText).toContain('display:none');
    // PANEL_CSS 只给深色底、不给定文字色,而页面基色是黑 —— 少了 color 就是黑字黑底,
    // 玩家悬停只见一个空面板(真机复现过的回归,这里是那道防线的钉子)
    expect(tip.style.cssText).toContain('color:');

    const edicts = root.children[0]!.children[0]!.children[3]!;
    const chip = edicts.children[0]!.children[1]!.children[0]!;
    chip.listeners.get('mouseenter')!();
    expect(tip.style.display).toBe('block');
    const def = EDICTS[EDICT_AMMO]!;
    expect(tip.textContent).toBe(`${edictName(def.type)} ×1\n${edictScopeLabel(def)}\n${edictDesc(def)}`);
    chip.listeners.get('mouseleave')!();
    expect(tip.style.display).toBe('none');
  });

  it('图鉴读数:按 world.unlockMask 置位数显示已解锁数/总数,setWorld 换世界当帧跟上', () => {
    const hud = createHud({ world: stubWorld({ unlockMask: 0b011 }) as unknown as World });
    const root = dom.ui.children[0]!;
    const collection = root.children[0]!.children[0]!.children[4]!;
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
    // 解锁 toast 排在键位提示行(28 号新增)之后:root 第 7 枚(0 起)
    const toastEl = root.children[7]!;
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

  it('静音单一真相源(二轮审查):注入 hooks 后点击走 hooks、上色读 hooks,外部改动 sync 当帧对齐', () => {
    let muted = false;
    let calls = 0;
    const hud = createHud({
      world: stubWorld() as unknown as World,
      muted: {
        get: () => muted,
        set: (m: boolean) => {
          calls++;
          muted = m;
        },
      },
    });
    const mute = dom.ui.children[0]!.children[3]!;
    expect(mute.textContent).toBe('声音:开');
    // 点击走 hooks(不再直写 audioBus):状态只在 hooks 那一份里翻
    mute.listeners.get('click')!(undefined);
    expect(calls).toBe(1);
    expect(muted).toBe(true);
    expect(mute.textContent).toBe('声音:关');
    // 设置页改的静音 = 外部改真相源:sync 当帧把按钮画对,不必等下一次点击
    muted = false;
    hud.sync();
    expect(mute.textContent).toBe('声音:开');
  });

  it('键位提示行(28 号):常驻小字印出 I/Tab 玩法键,纯静态、鼠标穿透、加速不重复进这行', () => {
    const hud = createHud({ world: stubWorld() as unknown as World });
    const root = dom.ui.children[0]!;
    // 静音开关(下标 3)正上方、精英血条(下标 5)之前 —— 与实现构造顺序一字同源
    const keyHints = root.children[4]!;
    expect(keyHints.textContent).toBe('[I] 武器布局 · [Tab] 射界');
    // 加速有自己的条标签(「加速 [空格]」),不重复进这行
    expect(keyHints.textContent).not.toContain('加速');
    // 常驻小字:pointer-events 穿透、贴 48px 罗盘通道同套边距(不新开档位)、无监听不可点
    expect(keyHints.style.cssText).toContain('pointer-events:none');
    expect(keyHints.style.cssText).toContain('left:48px');
    expect(keyHints.listeners.size).toBe(0);
    // 时停淡出随整层走:setPaused 改 root 的 opacity,这一行是 root 子层自动带上
    hud.setPaused(true);
    expect(Number(root.style.opacity)).toBeLessThan(0.1);
    hud.setPaused(false);
    // 纯静态:换局(setWorld)节点原样复用、文案不变、不重复挂 DOM
    hud.setWorld(stubWorld() as unknown as World);
    expect(dom.ui.children.length).toBe(1);
    expect(keyHints.textContent).toBe('[I] 武器布局 · [Tab] 射界');
  });

  it('精英血条:无精英隐藏,有精英亮出并反映 hp/maxHp', () => {
    const hud = createHud({ world: stubWorld() as unknown as World });
    const root = dom.ui.children[0]!;
    // 精英血条排键位提示行(28 号新增)之后:root 第 5 枚(0 起)
    const elite = root.children[5]!;
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
    // Boss 血条排键位提示行(28 号新增)之后:root 第 6 枚(0 起)
    const boss = root.children[6]!;
    expect(boss.style.display).toBe('none');

    // Boss(kind 4,affixes 恒 0)进场:血条亮出,比例钉 Boss 本体的 hp/maxHp
    hud.setWorld(
      stubWorld({ enemies: { items: [{ kind: KIND_BOSS, affixes: 0, hp: 240, maxHp: 480 }] } }) as unknown as World,
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
            { kind: KIND_BOSS, affixes: 0, hp: 240, maxHp: 480 },
          ],
        },
      }) as unknown as World,
    });
    const root = dom.ui.children[0]!;
    // 键位提示行(28 号新增)在两者之前:精英第 5、Boss 第 6(0 起)
    const elite = root.children[5]!;
    const boss = root.children[6]!;
    expect(elite.style.display).toBe('block');
    expect(boss.style.display).toBe('block');
    expect(findText(root, '30 / 200')).toBeDefined();
    expect(findText(root, '240 / 480')).toBeDefined();
  });

  it('时停淡出;重开只换 World 引用,不重复 append DOM', () => {
    // debug: true:换世界后的经验读数(33 / 55)才有数值可断言
    const hud = createHud({ world: stubWorld() as unknown as World, debug: true });
    const root = dom.ui.children[0]!;
    hud.setPaused(true);
    expect(Number(root.style.opacity)).toBeLessThan(0.1);
    hud.setPaused(false);
    expect(root.style.opacity).toBe('1');

    const next = stubWorld({
      ship: { hp: 12, maxHp: 90, x: 0, y: 0 },
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
      world: stubWorld({
        burstWarning: () => ({ etaSeconds: 1.5, dirRad: 0, pattern: 0 }),
      }) as unknown as World,
    });
    const root = dom.ui.children[0]!;
    const warn = root.children[2]!;
    expect(warn.title).toBe('即将来袭');
    expect(warn.style.display).toBe('block');
    expect(warn.style.opacity).not.toBe('');

    // 距触发还远(窗外):预警不该常驻刷屏
    hud.setWorld(
      stubWorld({ burstWarning: () => ({ etaSeconds: 30, dirRad: 0, pattern: 0 }) }) as unknown as World,
    );
    expect(warn.style.display).toBe('none');
    // 本段 burst 已放完 / 脚本走完:burstWarning 返回 null
    hud.setWorld(stubWorld() as unknown as World);
    expect(warn.style.display).toBe('none');
  });

  it('burst 预警:环阵改画全环脉冲 —— 钉在屏心的正圆随 eta 合拢,箭头两件套让位', () => {
    const hud = createHud({
      world: stubWorld({
        burstWarning: () => ({ etaSeconds: 1.5, dirRad: 0, pattern: BURST_PATTERN_RING }),
      }) as unknown as World,
    });
    const root = dom.ui.children[0]!;
    const warn = root.children[2]!;
    expect(warn.style.display).toBe('block');
    // 环子层亮、箭头两件套藏:全环脉冲没有"来向",不该挂着方向箭头
    expect(warn.children[0]!.style.display).toBe('none'); // shaft
    expect(warn.children[1]!.style.display).toBe('none'); // tip
    expect(warn.children[2]!.style.display).toBe('block'); // ring
    // 环是钉在屏幕中心的正圆(1000×600 桩视口 → 圆心 500,300),不是贴边的方向箭头
    expect(Number.parseFloat(warn.style.left!)).toBeCloseTo(500, 6);
    expect(Number.parseFloat(warn.style.top!)).toBeCloseTo(300, 6);
    const w1 = Number.parseFloat(warn.style.width!);
    expect(w1).toBeGreaterThan(0);
    expect(Number.parseFloat(warn.style.height!)).toBeCloseTo(w1, 6);
    // 合拢感:eta 越近环半径越小 —— 换一个更近的 eta,环当场收一圈
    hud.setWorld(
      stubWorld({
        burstWarning: () => ({ etaSeconds: 0.5, dirRad: 0, pattern: BURST_PATTERN_RING }),
      }) as unknown as World,
    );
    expect(Number.parseFloat(warn.style.width!)).toBeLessThan(w1);
    // 换回方向流:箭头两件套复亮、环子层收回 —— 同一枚节点两种形态互不残留
    hud.setWorld(
      stubWorld({
        burstWarning: () => ({ etaSeconds: 1.5, dirRad: 0, pattern: 0 }),
      }) as unknown as World,
    );
    expect(warn.children[0]!.style.display).toBe('block');
    expect(warn.children[1]!.style.display).toBe('block');
    expect(warn.children[2]!.style.display).toBe('none');
  });

  it('火力统计:理论 DPS 逐槽求和出格,同型合并 ×N 且发射读数取最快就绪那把,空槽格藏着', () => {
    // 两门机炮:2★ 就绪、1★ 装填中 —— 合并格该报"就绪"(下一发确实从 2★ 那把出膛);
    // 激光锁死 1.2s —— 单独格报"过热 1.2s"
    const world = stubWorld({
      kills: 42,
      weapons: [
        stubWeapon(TOWER_AUTOCANNON, 2),
        stubWeapon(TOWER_LASER, 3, { coolLock: 1.2 }),
        stubWeapon(TOWER_AUTOCANNON, 1, { reloadLeft: 0.9 }),
        stubWeapon(-1, 0),
      ],
    });
    const hud = createHud({ world: world as unknown as World });
    const root = dom.ui.children[0]!;
    const firepower = root.children[0]!.children[0]!.children[5]!;
    expect(firepower.title).toBe('火力统计');
    expect(findText(firepower, '击杀')).toBeDefined();
    expect(findText(firepower, '42')).toBeDefined();
    // DPS 是固定理论值(slotSustainedDps),不随实时输出漂:期望值用同一份纯函数现算
    const buffs = createEdictBuffs();
    const acDps =
      slotSustainedDps(stubWeapon(TOWER_AUTOCANNON, 2), TOWERS[TOWER_AUTOCANNON]!, buffs) +
      slotSustainedDps(stubWeapon(TOWER_AUTOCANNON, 1), TOWERS[TOWER_AUTOCANNON]!, buffs);
    const laserDps = slotSustainedDps(stubWeapon(TOWER_LASER, 3), TOWERS[TOWER_LASER]!, buffs);
    // 星级 + 所属系 + 同型 ×N:合并格报最高星那把,系名直取单一来源
    expect(findText(firepower, `${towerName(TOWER_AUTOCANNON)} ★★ · 弹药系 ×2`)).toBeDefined();
    expect(findText(firepower, formatDps(acDps))).toBeDefined();
    expect(findText(firepower, `${towerName(TOWER_LASER)} ★★★ · 过热系`)).toBeDefined();
    expect(findText(firepower, formatDps(laserDps))).toBeDefined();
    expect(findText(firepower, formatDps(acDps + laserDps))).toBeDefined();
    // 发射读数:机炮格就绪(装填那把不拖累),激光格报过热剩余秒
    expect(findText(firepower, '就绪')).toBeDefined();
    expect(findText(firepower, '过热 1.2s')).toBeDefined();
    // 格节点按槽上限预建:两格点亮,其余藏着(display:none),节点数不随内容涨。
    // 上限从 armory 现读(8 个槽):写死数字的话槽位一扩这一条就是假绿
    const rows = firepower.children;
    expect(rows.length).toBe(2 + WEAPON_SLOT_COUNT);
    expect(rows[2]!.style.display).toBe('block');
    expect(rows[3]!.style.display).toBe('block');
    expect(rows[4]!.style.display).toBe('none');
    // 就绪小条:激光格按 1 - coolLock/overheatLock 回充(2s 锁罚走掉 0.8s = 40%)
    const laserFill = rows[3]!.children[1]!.children[0]!;
    expect(laserFill.style.width).toBe(`${(1 - 1.2 / TOWERS[TOWER_LASER]!.overheatLock) * 100}%`);

    // 换局(空槽新世界):武器格全收、文本清空,击杀归零
    hud.setWorld(stubWorld() as unknown as World);
    expect(rows[2]!.style.display).toBe('none');
    expect(findText(firepower, `${towerName(TOWER_AUTOCANNON)}`)).toBeUndefined();
    expect(findText(firepower, '过热')).toBeUndefined();
  });

  it('加速冷却条:窗内印"加速中",冷却回充印剩余秒,归零印"就绪"', () => {
    const hud = createHud({ world: stubWorld({ boostCooldown: 2.5 }) as unknown as World });
    const root = dom.ui.children[0]!;
    const vitals = root.children[0]!.children[0]!.children[0]!;
    // 第三根条(下标 4/5 = 行/轨道):回充中印剩余秒
    expect(vitals.children[4]!.children[1]!.textContent).toBe('2.5s');

    hud.setWorld(stubWorld({ boostTime: 0.8, boostCooldown: 4.9 }) as unknown as World);
    expect(vitals.children[4]!.children[1]!.textContent).toBe('加速中');
    expect(vitals.children[5]!.children[0]!.style.width).toBe('100%');

    hud.setWorld(stubWorld() as unknown as World);
    expect(vitals.children[4]!.children[1]!.textContent).toBe('就绪');
    expect(vitals.children[5]!.children[0]!.style.width).toBe('100%');
  });
});

describe('radarProject', () => {
  it('量程内线性缩放,量程外沿方向钉在圈沿并标 clamped', () => {
    const out = { x: 0, y: 0, clamped: false };
    // 量程 1500 → 半径 71:750 世界 px 落在半径一半
    radarProject(750, 0, 1500, 71, out);
    expect(out.x).toBeCloseTo(35.5);
    expect(out.y).toBe(0);
    expect(out.clamped).toBe(false);
    // 3000 px(两倍量程):钉在圈沿,方向不变
    radarProject(0, 3000, 1500, 71, out);
    expect(out.x).toBeCloseTo(0);
    expect(out.y).toBeCloseTo(71);
    expect(out.clamped).toBe(true);
    // 斜向钉沿:模长 = 半径
    radarProject(3000, 3000, 1500, 71, out);
    expect(Math.hypot(out.x, out.y)).toBeCloseTo(71);
    expect(out.clamped).toBe(true);
  });

  it('坏输入(NaN / 非正量程)落在圆心,不把 NaN 写进 canvas', () => {
    const out = { x: 9, y: 9, clamped: true };
    radarProject(Number.NaN, 10, 1500, 71, out);
    expect(out.x).toBe(0);
    expect(Number.isFinite(out.y)).toBe(true);
    radarProject(100, 100, 0, 71, out);
    expect(out).toEqual({ x: 0, y: 0, clamped: false });
    radarProject(100, 100, Number.NaN, 71, out);
    expect(out).toEqual({ x: 0, y: 0, clamped: false });
  });
});

describe('formatDps / boostReadout', () => {
  it('DPS 排版:平滑尾巴印 0,个位数留一位小数,两位数以上取整,NaN 不外漏', () => {
    expect(formatDps(0)).toBe('0');
    expect(formatDps(0.04)).toBe('0');
    expect(formatDps(3.14)).toBe('3.1');
    expect(formatDps(12.6)).toBe('13');
    expect(formatDps(Number.NaN)).toBe('0');
  });

  it('加速读数:窗内加速中,冷却按 1 - cd/cdMax 回充,归零就绪', () => {
    expect(boostReadout(0.5, 4.4, 5)).toEqual({ text: '加速中', ratio: 1, active: true });
    expect(boostReadout(0, 0, 5)).toEqual({ text: '就绪', ratio: 1, active: false });
    const mid = boostReadout(0, 2.5, 5);
    expect(mid.text).toBe('2.5s');
    expect(mid.ratio).toBeCloseTo(0.5);
    expect(mid.active).toBe(false);
    // 坏刻度(cdMax 0/NaN)不把 NaN 写进 CSS:hudRatio 兜底,ratio 仍是有限数
    expect(Number.isFinite(boostReadout(0, 2, 0).ratio)).toBe(true);
  });

  it('发射读数排版:三种硬等待带前缀,冷却只印秒,就绪印"就绪";NaN 秒不外漏', () => {
    expect(fireReadoutText(FIRE_RELOAD, 1.23)).toBe('装填 1.2s');
    expect(fireReadoutText(FIRE_LOCKED, 0.8)).toBe('过热 0.8s');
    expect(fireReadoutText(FIRE_CHARGING, 2.4)).toBe('充能 2.4s');
    expect(fireReadoutText(FIRE_COOLDOWN, 0.35)).toBe('0.3s');
    expect(fireReadoutText(FIRE_READY, 0)).toBe('就绪');
    expect(fireReadoutText(FIRE_RELOAD, Number.NaN)).toBe('装填 0.0s');
  });

  it('发射读数配色:过热是唯一暖色,其余全在冷色域且五态互不相同', () => {
    const colors = [FIRE_READY, FIRE_COOLDOWN, FIRE_RELOAD, FIRE_LOCKED, FIRE_CHARGING].map(fireReadoutColor);
    expect(new Set(colors).size).toBe(5);
    expect(fireReadoutColor(FIRE_LOCKED)).toBe('#ff9a5c');
  });
});
