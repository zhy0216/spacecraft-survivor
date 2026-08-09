/**
 * 战斗 HUD(11 号 issue H1/H2)—— 固定在屏幕空间的 DOM 覆盖层,永不 import pixi。
 * 世界里同时有多少敌人都不会改变这里的节点数:整页只创建一次,每帧只改已有节点的
 * textContent / style。重开也只走 setWorld 换引用,不重复 append DOM 或注册监听器。
 *
 * 布局只占屏幕上沿、屏下缘与威胁所在的边缘,中央战场完全留空。升级时停与结算期间由 setPaused
 * 把整层淡到几乎不可见,且根节点强制 pointer-events:none,不会与放大甲板或卡片抢焦点。
 */
import { BOSS, KIND_BOSS } from '../data/enemies';
import { WAVE_SEGMENTS } from '../data/waves';
import { audioBus } from '../render/audio';
import type { Enemy, World } from '../sim/world';
import { formatDuration } from './gameOver';

const OK_COLOR = '#9adcff';
const VALUE_COLOR = '#c8dcf0';
const IDLE_COLOR = '#5f7a99';
const LINE_COLOR = '#2b4a6e';
const HP_COLOR = '#73d9e8';
const SCRAP_COLOR = '#e6c878';
const STAR_COLOR = '#ffd86e';
const THREAT_COLOR = '#ff5f77';

const ROOT_CSS =
  'position:fixed;inset:0;pointer-events:none!important;user-select:none;opacity:1;' +
  'transition:opacity 140ms ease;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;';

/** 三块读数贴上沿排开;中间只有一枚窄计时器,不会盖住中央交战区 */
const TOP_CSS =
  // 四周先留一条 48px 的罗盘通道:箭头贴边走,不会压在 HP/计时/航段文字上
  // 右侧额外给开发期常驻的 Tweakpane 留位;正式 HUD 不应被调参工具盖住。
  'position:absolute;left:48px;right:300px;top:48px;display:grid;' +
  'grid-template-columns:minmax(150px,300px) 1fr minmax(150px,300px);gap:18px;align-items:start;';

const PANEL_CSS =
  `padding:8px 10px;border:1px solid ${LINE_COLOR};border-radius:7px;` +
  'background:rgba(5,7,13,.68);box-shadow:0 2px 12px rgba(0,0,0,.28);';
const LABEL_ROW_CSS = 'display:flex;align-items:baseline;justify-content:space-between;gap:12px;';
const LABEL_CSS = `color:${IDLE_COLOR};letter-spacing:.08em;white-space:nowrap;`;
const VALUE_CSS = `color:${VALUE_COLOR};white-space:nowrap;`;
const TRACK_CSS =
  `height:5px;margin-top:5px;overflow:hidden;border-radius:999px;background:rgba(43,74,110,.35);` +
  `box-shadow:inset 0 0 0 1px ${LINE_COLOR};`;
const FILL_CSS = 'height:100%;width:0;border-radius:inherit;transition:width 80ms linear;';

const TIMER_CSS =
  `${PANEL_CSS}justify-self:center;min-width:86px;text-align:center;color:${OK_COLOR};` +
  'font-size:17px;letter-spacing:.12em;';
const SEGMENT_CSS = `${PANEL_CSS}justify-self:end;width:min(280px,100%);`;

/**
 * 星币读数(16 号):与残骸读数同族(同一套 PANEL/LABEL_ROW/LABEL/VALUE 样式)的独立读数,
 * 但没有进度轨道 —— 星币只有余额、没有"目标费用"可填。贴在 vitals 面板正下方
 * (面板顶 48 + 两行面板高:行 17.4×2 + 轨道 10×2 + gap 7 + padding 16 ≈ 78 + 间距 14 = 140);
 * vitals 将来加行需同步改这里。
 */
const STARCOINS_CSS = `${PANEL_CSS}position:absolute;left:48px;top:140px;`;

/**
 * 精英血条(14 号):屏下缘居中的短条。与静音开关同一套罗盘通道边距(bottom:48px),
 * 面板/轨道/描边复用上沿既有样式 —— 精英一亮就按"既有血条"的读法读它。
 * 默认 display:none,有精英才亮(与 burst 预警箭头同一条显示/隐藏口径)。
 */
const ELITE_CSS =
  `${PANEL_CSS}position:absolute;left:50%;bottom:48px;width:min(340px,60vw);` +
  'transform:translateX(-50%);display:none;';

/**
 * Boss 血条(15 号):屏下缘、精英血条正上方(Boss 战期间两者可能同时在场上)。
 * 与精英条同一套 PANEL/TRACK/FILL 样式,但**钉 Boss 本体、常驻直到击杀**:
 * 精英条是"亮一只随时被顶替"(affixes ≠ 0 的池序第一只),Boss 条是这一战唯一的
 * 中心读数 —— 两者并列但绝不复用同一根条(Boss 的 affixes 恒为 0,扫精英也扫不到它)。
 * 默认 display:none,场上有 Boss 才亮;击杀(Boss 出池)当帧隐藏。
 */
const BOSS_CSS =
  `${PANEL_CSS}position:absolute;left:50%;bottom:98px;width:min(520px,76vw);` +
  'transform:translateX(-50%);display:none;';
/** 底座甲虫(tint 0xff1f4b)同系更深的红:与精英条(威胁红 #ff5f77)一眼分得开 */
const BOSS_HP_COLOR = '#ff1f4b';

/**
 * 静音开关:左下角小按钮,与四周 48px 罗盘通道同一套边距。
 * 根节点是 pointer-events:none!important,这里必须自己放行点击(auto 覆盖继承值,
 * 子树可单独开 target —— 整层其它区域仍不抢焦点)。
 */
const MUTE_CSS =
  'position:absolute;left:48px;bottom:48px;padding:6px 12px;' +
  `border:1px solid ${LINE_COLOR};border-radius:7px;` +
  'background:rgba(5,7,13,.68);box-shadow:0 2px 12px rgba(0,0,0,.28);' +
  'font:inherit;letter-spacing:.08em;cursor:pointer;user-select:none;' +
  'pointer-events:auto!important;';

/** 罗盘根是一支向 +X 的 CSS 箭头;sync 时只改位置、旋转、尺寸与透明度 */
const THREAT_CSS =
  'position:absolute;width:24px;height:24px;transform-origin:50% 50%;will-change:left,top,transform;' +
  'pointer-events:none;';
const THREAT_SHAFT_CSS =
  `position:absolute;left:0;top:50%;width:68%;height:2px;border-radius:999px;background:${THREAT_COLOR};` +
  'transform:translateY(-50%);';
const THREAT_TIP_CSS =
  'position:absolute;right:0;top:50%;width:0;height:0;transform:translateY(-50%);' +
  `border-top:6px solid transparent;border-bottom:6px solid transparent;border-left:10px solid ${THREAT_COLOR};`;

/** 从脚本推导罗盘的满强度:改波次速率,视觉刻度自动跟着走,不另养一枚魔法数 */
export const THREAT_INTENSITY_MAX = Math.max(
  1,
  ...WAVE_SEGMENTS.map((seg) => {
    let start = 0;
    let end = 0;
    for (const stream of seg.streams) {
      start += stream.rate0 > 0 && Number.isFinite(stream.rate0) ? stream.rate0 : 0;
      end += stream.rate1 > 0 && Number.isFinite(stream.rate1) ? stream.rate1 : 0;
    }
    return Math.max(start, end);
  }),
);

/** 开发期 Tweakpane 固定在右侧约 256px;罗盘把这条不可用区域从战场边缘扣掉。 */
const HUD_RIGHT_GUTTER = 288;

/**
 * burst 预警窗(秒):距侧压事件触发不足这一档时,在来向边缘亮出第二支(空心)箭头。
 * 3s 够转半个船身(shipTurnRate 100°/s × 3s = 300°),又不至于常驻刷屏。
 * 预警箭头随 eta 递减越来越实,出怪瞬间交棒给实况罗盘(那支实心箭头由真实出怪统计驱动)。
 */
export const BURST_WARNING_WINDOW = 3;

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** 任意进度夹到 [0,1];max <= 0 / NaN 时回落 0,不把 NaN 写进 CSS */
export function hudRatio(value: number, max: number): number {
  if (!(max > 0) || !Number.isFinite(max)) return 0;
  const ratio = finiteOrZero(value) / max;
  return ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
}

export interface SegmentReadout {
  label: string;
  ratio: number;
}

/** 当前航段的名字、n/N 与段内进度;脚本走完钉在满格,不显示 5/4 */
export function segmentReadout(segment: number, segTime: number): SegmentReadout {
  const count = WAVE_SEGMENTS.length;
  if (count === 0) return { label: '—', ratio: 0 };
  if (Number.isFinite(segment) && segment >= count) return { label: `${count}/${count} 全通`, ratio: 1 };
  const index = Number.isFinite(segment) && segment >= 0 ? Math.floor(segment) : 0;
  const seg = WAVE_SEGMENTS[index] ?? WAVE_SEGMENTS[0]!;
  return {
    label: `${index + 1}/${count} ${seg.name}`,
    ratio: hudRatio(segTime, seg.duration),
  };
}

export interface ThreatVisual {
  x: number;
  y: number;
  rotationDeg: number;
  strength: number;
  sizePx: number;
  linePx: number;
  opacity: number;
  brightness: number;
}

/**
 * 世界绝对角 → 屏幕边缘交点。0 = 右、π/2 = 下,与 World/画布的 y 向下一致。
 * 强度同时驱动箭头尺寸/线宽与透明度/亮度,低压仍保留常驻轮廓。
 */
export function threatVisual(direction: number, intensity: number, width: number, height: number): ThreatVisual {
  const angle = Number.isFinite(direction) ? direction : 0;
  const viewportW = Number.isFinite(width) && width > 0 ? width : 1;
  const viewportH = Number.isFinite(height) && height > 0 ? height : 1;
  const cx = viewportW * 0.5;
  const cy = viewportH * 0.5;
  const margin = Math.min(22, Math.max(16, Math.min(viewportW, viewportH) * 0.025));
  const rightEdge = Math.max(cx, viewportW - HUD_RIGHT_GUTTER);
  const halfWRight = Math.max(0, rightEdge - cx);
  const halfWLeft = Math.max(0, cx - margin);
  const halfH = Math.max(0, cy - margin);
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const halfW = dx >= 0 ? halfWRight : halfWLeft;
  const tx = Math.abs(dx) > 1e-9 ? halfW / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const ty = Math.abs(dy) > 1e-9 ? halfH / Math.abs(dy) : Number.POSITIVE_INFINITY;
  const distance = Math.min(tx, ty);
  const strength = hudRatio(intensity, THREAT_INTENSITY_MAX);
  return {
    x: cx + dx * (Number.isFinite(distance) ? distance : 0),
    y: cy + dy * (Number.isFinite(distance) ? distance : 0),
    // 箭头放在来敌侧边缘,但头部朝向屏幕内/船心,读起来是“怪流从这里压进来”。
    rotationDeg: (angle * 180) / Math.PI + 180,
    strength,
    sizePx: 22 + strength * 16,
    linePx: 2 + strength * 4,
    opacity: 0.38 + strength * 0.58,
    brightness: 0.78 + strength * 0.72,
  };
}

export interface HudUi {
  /** 重开只换引用;DOM 与任何监听器都不重建 */
  setWorld(world: World): void;
  /** 升级时停 / 结算时淡出,不与卡片或放大甲板抢焦点 */
  setPaused(paused: boolean): void;
  /** 每渲染帧同步现有节点 */
  sync(): void;
}

interface BarEls {
  value: HTMLSpanElement;
  fill: HTMLDivElement;
}

function createBar(parent: HTMLElement, labelText: string, color: string): BarEls {
  const row = document.createElement('div');
  row.style.cssText = LABEL_ROW_CSS;
  const label = document.createElement('span');
  label.style.cssText = LABEL_CSS;
  label.textContent = labelText;
  const value = document.createElement('span');
  value.style.cssText = VALUE_CSS;
  row.append(label, value);
  const track = document.createElement('div');
  track.style.cssText = TRACK_CSS;
  const fill = document.createElement('div');
  fill.style.cssText = `${FILL_CSS}background:${color};`;
  track.appendChild(fill);
  parent.append(row, track);
  return { value, fill };
}

export function createHud(opts: { world: World }): HudUi {
  let world = opts.world;
  let paused = false;

  const root = document.createElement('div');
  root.style.cssText = ROOT_CSS;
  const top = document.createElement('div');
  top.style.cssText = TOP_CSS;

  const vitals = document.createElement('div');
  vitals.style.cssText = `${PANEL_CSS}display:flex;flex-direction:column;gap:7px;`;
  const hp = createBar(vitals, '船体 HP', HP_COLOR);
  const scrap = createBar(vitals, '升级残骸', SCRAP_COLOR);

  const timer = document.createElement('div');
  timer.style.cssText = TIMER_CSS;

  const segment = document.createElement('div');
  segment.style.cssText = SEGMENT_CSS;
  const segmentBar = createBar(segment, '航段进度', OK_COLOR);

  top.append(vitals, timer, segment);

  const threat = document.createElement('div');
  threat.style.cssText = THREAT_CSS;
  threat.title = '主压方向';
  const shaft = document.createElement('div');
  shaft.style.cssText = THREAT_SHAFT_CSS;
  const tip = document.createElement('div');
  tip.style.cssText = THREAT_TIP_CSS;
  threat.append(shaft, tip);

  // burst 预警箭头:与实况罗盘同一套形状,但**空心描边样式**(只留箭头尖 + 一小截空心杆),
  // 且闪烁 —— "要来了"与"正在来"必须一眼分得开。默认藏着,只在预警窗内亮
  const warn = document.createElement('div');
  warn.style.cssText = THREAT_CSS + 'display:none;';
  warn.title = '即将来袭';
  const warnShaft = document.createElement('div');
  warnShaft.style.cssText = THREAT_SHAFT_CSS + 'background:none;border-top:2px dashed ' + THREAT_COLOR + ';height:0!important;';
  const warnTip = document.createElement('div');
  warnTip.style.cssText = THREAT_TIP_CSS;
  warn.append(warnShaft, warnTip);

  // 静音开关:默认有声(开)。点击只切 audioBus 总线增益并改自己的文字/颜色,
  // 不新增任何窗口监听、不动 sim;按钮本体是 div,不会抢键盘焦点(Enter/空格不受干扰)
  const muteBtn = document.createElement('div');
  muteBtn.style.cssText = MUTE_CSS;
  muteBtn.title = '静音开关';
  let muted = false;
  function paintMute(): void {
    muteBtn.textContent = muted ? '声音:关' : '声音:开';
    muteBtn.style.color = muted ? IDLE_COLOR : OK_COLOR;
  }
  muteBtn.addEventListener('click', () => {
    muted = !muted;
    audioBus.setMuted(muted);
    paintMute();
  });
  paintMute();

  // 精英血条:屏下缘、与静音开关不抢位(一个贴左、一个居中)。填充色取威胁红,
  // 与罗盘箭头同色 —— 这一只就是当下最需要盯着的威胁
  const elite = document.createElement('div');
  elite.style.cssText = ELITE_CSS;
  const eliteBar = createBar(elite, '精英', THREAT_COLOR);

  // Boss 血条:常驻版(15 号),叠在精英条正上方;标签直取 BOSS.name(改数值表跟着走)
  const boss = document.createElement('div');
  boss.style.cssText = BOSS_CSS;
  const bossBar = createBar(boss, BOSS.name, BOSS_HP_COLOR);

  // 星币读数:残骸读数的同族姊妹 —— ★ 前缀的一行数字,无进度轨道;每帧 sync 直接写余额
  const starCoins = document.createElement('div');
  starCoins.style.cssText = STARCOINS_CSS;
  starCoins.title = '星币';
  const starRow = document.createElement('div');
  starRow.style.cssText = LABEL_ROW_CSS;
  const starLabel = document.createElement('span');
  starLabel.style.cssText = LABEL_CSS;
  starLabel.textContent = '★ 星币';
  const starValue = document.createElement('span');
  starValue.style.cssText = `${VALUE_CSS}color:${STAR_COLOR};`;
  starRow.append(starLabel, starValue);
  starCoins.appendChild(starRow);

  root.append(top, threat, warn, muteBtn, elite, boss, starCoins);
  document.getElementById('ui')!.appendChild(root);

  function sync(): void {
    const hpMax = finiteOrZero(world.ship.maxHp);
    const hpNow = finiteOrZero(world.ship.hp);
    hp.value.textContent = `${Math.max(0, Math.round(hpNow))} / ${Math.max(0, Math.round(hpMax))}`;
    hp.fill.style.width = `${hudRatio(hpNow, hpMax) * 100}%`;

    const cost = finiteOrZero(world.upgradeCost);
    const scrapNow = finiteOrZero(world.scrap);
    scrap.value.textContent = `${Math.max(0, Math.round(scrapNow))} / ${Math.max(0, Math.round(cost))}`;
    scrap.fill.style.width = `${hudRatio(scrapNow, cost) * 100}%`;

    const coins = finiteOrZero(world.starCoins);
    starValue.textContent = String(Math.max(0, Math.round(coins)));

    timer.textContent = formatDuration(world.elapsed);

    const seg = segmentReadout(world.wave.segment, world.wave.segTime);
    segmentBar.value.textContent = seg.label;
    segmentBar.fill.style.width = `${seg.ratio * 100}%`;

    const visual = threatVisual(world.threatDirection, world.threatIntensity, window.innerWidth, window.innerHeight);
    threat.style.left = `${visual.x}px`;
    threat.style.top = `${visual.y}px`;
    threat.style.width = `${visual.sizePx}px`;
    threat.style.height = `${visual.sizePx}px`;
    threat.style.opacity = String(visual.opacity);
    threat.style.filter =
      `brightness(${visual.brightness}) drop-shadow(0 0 ${2 + visual.strength * 8}px rgba(255,95,119,.9))`;
    threat.style.transform = `translate(-50%,-50%) rotate(${visual.rotationDeg}deg)`;
    shaft.style.height = `${visual.linePx}px`;
    tip.style.borderTopWidth = `${visual.sizePx * 0.25}px`;
    tip.style.borderBottomWidth = `${visual.sizePx * 0.25}px`;
    tip.style.borderLeftWidth = `${visual.sizePx * 0.42}px`;

    // burst 预警:eta 进窗才亮。强度冒充值随 eta 递减走高(越近越大越实),
    // 叠一层随 eta 的快闪(渲染帧现算 sin,不依赖 CSS keyframes);出怪瞬间 burstNext
    // 游标前移,warning 自动换到下一个事件或消失 —— 交棒给上面那支实况箭头
    const burst = world.burstWarning();
    if (burst && burst.etaSeconds <= BURST_WARNING_WINDOW) {
      const closeness = 1 - burst.etaSeconds / BURST_WARNING_WINDOW;
      const wv = threatVisual(burst.dirRad, THREAT_INTENSITY_MAX * (0.4 + 0.6 * closeness), window.innerWidth, window.innerHeight);
      const blink = 0.55 + 0.45 * Math.abs(Math.sin(burst.etaSeconds * Math.PI * 3));
      warn.style.display = 'block';
      warn.style.left = `${wv.x}px`;
      warn.style.top = `${wv.y}px`;
      warn.style.width = `${wv.sizePx}px`;
      warn.style.height = `${wv.sizePx}px`;
      warn.style.opacity = String(wv.opacity * blink);
      warn.style.transform = `translate(-50%,-50%) rotate(${wv.rotationDeg}deg)`;
      warnTip.style.borderTopWidth = `${wv.sizePx * 0.25}px`;
      warnTip.style.borderBottomWidth = `${wv.sizePx * 0.25}px`;
      warnTip.style.borderLeftWidth = `${wv.sizePx * 0.42}px`;
    } else {
      warn.style.display = 'none';
    }

    // 精英血条 + Boss 血条(14/15 号)共用一趟池扫描:前者"亮一只随时被顶替",
    // 后者钉 Boss 本体常驻 —— 两根条并列不复用(Boss 的 affixes 恒为 0,扫精英扫不到它)。
    let eliteTarget: Enemy | null = null;
    let bossTarget: Enemy | null = null;
    const enemies = world.enemies.items;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i]!;
      if (eliteTarget === null && e.affixes !== 0) eliteTarget = e;
      if (bossTarget === null && e.kind === KIND_BOSS) bossTarget = e;
      if (eliteTarget !== null && bossTarget !== null) break;
    }
    if (eliteTarget !== null) {
      const eMax = finiteOrZero(eliteTarget.maxHp);
      const eNow = finiteOrZero(eliteTarget.hp);
      elite.style.display = 'block';
      eliteBar.value.textContent = `${Math.max(0, Math.round(eNow))} / ${Math.max(0, Math.round(eMax))}`;
      eliteBar.fill.style.width = `${hudRatio(eNow, eMax) * 100}%`;
    } else {
      elite.style.display = 'none';
    }

    // Boss 血条:显示条件 = 场上有 Boss(bossPhase 1 期间恒在,击杀出池当帧隐藏)。
    // 比例每帧 sync 读 Boss 本体的 hp/maxHp —— 钉的就是它,不是任何替代物
    if (bossTarget !== null) {
      const bMax = finiteOrZero(bossTarget.maxHp);
      const bNow = finiteOrZero(bossTarget.hp);
      boss.style.display = 'block';
      bossBar.value.textContent = `${Math.max(0, Math.round(bNow))} / ${Math.max(0, Math.round(bMax))}`;
      bossBar.fill.style.width = `${hudRatio(bNow, bMax) * 100}%`;
    } else {
      boss.style.display = 'none';
    }
  }

  sync();

  return {
    setWorld(next: World): void {
      world = next;
      sync();
    },
    setPaused(next: boolean): void {
      if (paused === next) return;
      paused = next;
      root.style.opacity = paused ? '0.06' : '1';
    },
    sync,
  };
}
