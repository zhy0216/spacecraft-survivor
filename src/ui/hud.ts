/**
 * 战斗 HUD(11 号 issue H1/H2)—— 固定在屏幕空间的 DOM 覆盖层,永不 import pixi。
 * 世界里同时有多少敌人都不会改变这里的节点数:整页只创建一次,每帧只改已有节点的
 * textContent / style。重开也只走 setWorld 换引用,不重复 append DOM 或注册监听器。
 *
 * 布局只占屏幕上沿、屏下缘与威胁所在的边缘,中央战场完全留空。升级时停与结算期间由 setPaused
 * 把整层淡到几乎不可见,且根节点强制 pointer-events:none,不会与放大甲板或卡片抢焦点。
 */
import { BOSS, KIND_BOSS } from '../data/enemies';
import { edictLevel, EDICTS } from '../data/edicts';
import { TOWERS } from '../data/towers';
import { UNLOCKS } from '../data/unlocks';
import { WAVE_SEGMENTS } from '../data/waves';
import { audioBus } from '../render/audio';
import { WEAPON_SLOT_COUNT } from '../sim/armory';
import { tuning } from '../sim/config';
import {
  FIRE_CHARGING,
  FIRE_COOLDOWN,
  FIRE_LOCKED,
  FIRE_READY,
  FIRE_RELOAD,
  type FireReadout,
  slotFireReadout,
  slotSustainedDps,
} from '../sim/tower';
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

/**
 * 顶栏布局(玩家模式默认全宽;开发期 ?debug 时右侧给常驻 Tweakpane 留位)。
 * 四周留一条 48px 的罗盘通道:箭头贴边走,不会压在 HP/计时/航段文字上。
 * 右侧 gutter 由 createHud 的 rightGutter 决定(玩家模式 0,开发模式 288)——
 * 正式 HUD 不应被调参工具盖住,玩家模式整条屏幕都属于战场。
 */
function topCss(rightGutter: number): string {
  const right = rightGutter > 0 ? `right:${rightGutter + 12}px` : 'right:48px';
  return (
    `position:absolute;left:48px;${right};top:48px;display:grid;` +
    'grid-template-columns:minmax(150px,300px) 1fr minmax(150px,300px);gap:18px;align-items:start;'
  );
}

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
 * 左列纵队:vitals 血条面板 + 星币/法令/图鉴/火力四块读数,住在顶栏 grid 的第一格里、
 * 一根 flex 纵列自动堆叠(间距 14px)。此前四块各自 absolute 记 top 偏移,vitals 加一行
 * 就要手改整串数字 —— 加速条上线时那笔账没跟上,星币面板直接压进了血条面板;
 * 法令隐藏时中段还留一个空洞。flex 纵列把这两类失配一并消灭:增行/隐藏,下面的自动跟上。
 */
const LEFT_COL_CSS = 'display:flex;flex-direction:column;gap:14px;align-items:stretch;';

/**
 * 星币读数(16 号):与残骸读数同族(同一套 PANEL/LABEL_ROW/LABEL/VALUE 样式)的独立读数,
 * 但没有进度轨道 —— 星币只有余额、没有"目标费用"可填。位置由左列纵队给,不自带偏移。
 */
const STARCOINS_CSS = PANEL_CSS;

/**
 * 法令徽记(18 号):左列第二块读数,一行印出**已持有**法令的名字 —— "所见即所得":
 * 抽到哪条,这里立刻多出哪个名字(与支援连线的同级口径:画面即真相,不另开菜单去翻)。
 * 名字直取 data/edicts(ui 不抄第二份);无法令时整体隐藏(display:none),持有才亮,
 * 纵队里下面的面板自动补位。
 */
const EDICTS_CSS = `${PANEL_CSS}display:none;`;

/**
 * 图鉴读数(19 号):左列第三块。一行"图鉴 n/总":已解锁计数 = world.unlockMask 的置位数
 * (位 i = UNLOCKS[i],与 World 构造时喂进来的 progress.unlockMask 同编码),
 * 总数直取 UNLOCKS.length —— 每帧 sync 现算,重开换世界(setWorld → sync)当帧跟上,
 * HUD 不需要单独接进度引用。
 */
const COLLECTION_CSS = PANEL_CSS;
/**
 * 商店信标倒计时(用户设计会):与法令徽记同一条"没有就整块隐藏"的口径 ——
 * 信标一局只在四个航段边界各亮 30 秒,常驻一块空面板等于把最该被注意到的那一行稀释掉。
 */
const BEACON_CSS = `${PANEL_CSS}display:none;`;

/**
 * 火力统计面板:左列末块。行结构:击杀数 + 总 DPS 两行常驻,其下每**持有的武器型**一格:
 * 一行"名字 Lv ×数量 | 下一次发射 | 理论 DPS" + 一根就绪小条。
 * DPS 是 sim/tower 的 slotSustainedDps —— **固定数值**(等级/支援/法令/tuning 的纯函数,
 * 含装填/过热/充能整周期的单体持续口径),不随场面波动;实时账只喂局末战报的峰值。
 * 下一次发射读数走 slotFireReadout(与 canFire 判序同源),装填/过热/充能各配一色。
 * 同型多把合并成一格印 ×N(DPS 逐槽求和,发射读数取最快就绪那把)。
 * 格节点按武器槽上限只建一次,每帧改 textContent 与 display —— 整页"永不重建 DOM"的口径。
 */
const FIREPOWER_CSS = `${PANEL_CSS}display:flex;flex-direction:column;gap:5px;`;
/** 武器格的就绪小条:比 vitals 的 5px 轨道再细一档 —— 是行内读数,不是主条 */
const FIRE_TRACK_CSS =
  `height:3px;margin-top:3px;overflow:hidden;border-radius:999px;background:rgba(43,74,110,.35);`;
/** 加速技能冷却条的填充色:推进器青绿,与 HP 青/星币金/威胁红都分得开 */
const BOOST_COLOR = '#8ef2c0';
/** 过热锁死的读数色:全 HUD 唯一的暖色 —— GDD §12 把暖色只留给"拒绝/过热"这类小面积读数 */
const HEAT_WARN_COLOR = '#ff9a5c';
/** 充能读数色:磁轨系的亮靛(与就绪的 OK 蓝、冷却的灰蓝一眼分得开,仍在冷色域) */
const CHARGE_COLOR = '#8a96ff';

/**
 * 战术雷达(右下角):一块圆形 canvas,每帧 2D 重绘 —— 怪群/精英/Boss/经验掉落的方位一览。
 * 罗盘只报"主压从哪边来"的一个方向,雷达补上"身后还剩多少没清、掉落散落在哪"的全景。
 * canvas 而不是 DOM 点:同屏几百只怪,几百个 DOM 节点就是几百次 style 写入,
 * 而一块 148px 的 2D canvas 每帧全清全画只是几百次 fillRect —— HUD 永不 import pixi 的
 * 铁律不碰(canvas 2D 是 DOM 自带的)。右缘与罗盘通道同一套 gutter 口径(开发模式让位 Tweakpane)。
 */
const RADAR_SIZE = 148;
/** 雷达量程(世界 px):盖住出怪环(SPAWN_RADIUS 1300)再留一点余量;更远的贴边钉在圈沿 */
const RADAR_RANGE = 1500;
function radarCss(rightGutter: number): string {
  const right = rightGutter > 0 ? `right:${rightGutter + 12}px` : 'right:48px';
  return (
    `position:absolute;${right};bottom:48px;width:${RADAR_SIZE}px;height:${RADAR_SIZE}px;` +
    `border-radius:50%;border:1px solid ${LINE_COLOR};background:rgba(5,7,13,.55);` +
    'box-shadow:0 2px 12px rgba(0,0,0,.28);'
  );
}

/**
 * 解锁 toast(19 号):与升级/改造流程那两枚 toast 同族的提示条,但长在 HUD 根里
 * (时停淡出时跟着一起淡)。叠在静音开关正上方(开关 bottom:48,条放 104,都对齐
 * 48px 罗盘通道);pointer-events 继承根的 none,不抢焦点。颜色取星币金 ——
 * "解锁"是正向的收藏事件,与 ★ 同色系。
 */
const TOAST_CSS =
  'position:absolute;left:48px;bottom:104px;padding:8px 12px;border-radius:6px;display:none;' +
  `border:1px solid ${LINE_COLOR};background:rgba(5,7,13,.78);box-shadow:0 2px 12px rgba(0,0,0,.28);` +
  `color:${STAR_COLOR};letter-spacing:.06em;white-space:pre;`;

/** 解锁 toast 的存留时长(ms):到点自动消失(简单口径:闪现一下,不赖到局末) */
const UNLOCK_TOAST_MS = 2600;

/**
 * 低血量警告的屏边红晕(畅玩性)。满屏径向渐变(中心透明 → 边缘暖红),pointer-events:none
 * 绝不挡点击;透明度由 sync 按血量脉冲 —— 血量 ≥25% 恒 0(隐藏),<25% 在 0.15~0.4 间呼吸。
 * 它是 HUD 根节点的一个子层,于是 setPaused 的整层淡出(setPaused 改 root 的 opacity)自动带上它。
 */
const VIGNETTE_CSS =
  'position:absolute;inset:0;pointer-events:none;' +
  'background:radial-gradient(ellipse at center,transparent 52%,rgba(255,44,34,0.6) 100%);' +
  'opacity:0;';
/** 亮起阈值:血量掉到 25% 以下才开始警告(半血就闪会让人以为船快没了) */
const VIGNETTE_HP_RATIO = 0.25;
/** 呼吸周期(ms):1.2s 一呼一吸,节奏是"心跳"不是"警报灯" */
const VIGNETTE_CYCLE_MS = 1200;
/** 呼吸的透明度下限/上限:0.15 是"还在渗血",0.4 是"快撑不住了" —— 不给满,不糊住战场 */
const VIGNETTE_ALPHA_MIN = 0.15;
const VIGNETTE_ALPHA_MAX = 0.4;

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

/**
 * DPS 读数排版:0.05 以下印 '0'(平滑尾巴永远到不了精确 0,别让读数长期挂着 0.0x),
 * 10 以下留一位小数(早期单塔 DPS 是个位数,取整会把升级前后的差别抹平),再往上取整。
 */
export function formatDps(v: number): string {
  const n = finiteOrZero(v);
  if (n < 0.05) return '0';
  return n < 10 ? n.toFixed(1) : String(Math.round(n));
}

/**
 * 下一次发射读数排版:三种硬等待(装填/过热/充能)带状态前缀,普通冷却只印秒
 * (射速的间隙不值得占字),就绪印"就绪"。秒数一位小数 —— 与加速条同一档读数精度。
 */
export function fireReadoutText(state: number, seconds: number): string {
  const sec = `${finiteOrZero(seconds).toFixed(1)}s`;
  switch (state) {
    case FIRE_RELOAD:
      return `装填 ${sec}`;
    case FIRE_LOCKED:
      return `过热 ${sec}`;
    case FIRE_CHARGING:
      return `充能 ${sec}`;
    case FIRE_COOLDOWN:
      return sec;
    default:
      return '就绪';
  }
}

/** 发射读数配色:文本与就绪小条同色 —— 过热是全 HUD 唯一的暖色,其余全在冷色域 */
export function fireReadoutColor(state: number): string {
  switch (state) {
    case FIRE_RELOAD:
      return SCRAP_COLOR;
    case FIRE_LOCKED:
      return HEAT_WARN_COLOR;
    case FIRE_CHARGING:
      return CHARGE_COLOR;
    case FIRE_COOLDOWN:
      return IDLE_COLOR;
    default:
      return OK_COLOR;
  }
}

/**
 * slotFireReadout 的模块级暂存两枚:scratch 逐槽问,best 存"同型里最快就绪那把"
 * (HUD 每帧 4 槽 × 2 次比较,不逐槽 new;单线程 sync 内独占,与 radarScratch 同一条纪律)
 */
const fireScratch: FireReadout = { state: FIRE_READY, seconds: 0, ratio: 1 };
const fireBest: FireReadout = { state: FIRE_READY, seconds: 0, ratio: 1 };

export interface BoostReadout {
  /** 数值区文本:加速中 / 就绪 / 剩余冷却秒 */
  text: string;
  /** 冷却回充进度 0..1(加速中与就绪都钉满格) */
  ratio: number;
  /** 加速窗内(渲染层可借它点亮填充) */
  active: boolean;
}

/** 加速技能读数:boostTime > 0 = 窗内;冷却条按 1 - cd/cdMax 回充,归零印"就绪" */
export function boostReadout(boostTime: number, cooldown: number, cdMax: number): BoostReadout {
  if (finiteOrZero(boostTime) > 0) return { text: '加速中', ratio: 1, active: true };
  const cd = finiteOrZero(cooldown);
  if (cd <= 0) return { text: '就绪', ratio: 1, active: false };
  return { text: `${cd.toFixed(1)}s`, ratio: 1 - hudRatio(cd, cdMax), active: false };
}

export interface RadarPoint {
  /** 相对雷达圆心的屏幕偏移(px,y 向下,与世界系同向 —— 雷达不随船头旋转,北就是世界 -Y) */
  x: number;
  y: number;
  /** 超出量程、被钉在圈沿(画得更淡:方向仍真,距离已饱和) */
  clamped: boolean;
}

/**
 * 世界相对位移 → 雷达屏幕偏移。量程内线性缩放,量程外沿方向钉在圈沿;
 * 结果写进调用方给的 out(每帧几百个点,不 new —— 与 sim 侧的模块级暂存同一条纪律)。
 * 坏输入(NaN / 非正量程)一律落在圆心:雷达是读数,绝不把 NaN 写进 canvas 变换。
 */
export function radarProject(
  dx: number,
  dy: number,
  range: number,
  radiusPx: number,
  out: RadarPoint,
): RadarPoint {
  const vx = finiteOrZero(dx);
  const vy = finiteOrZero(dy);
  if (!(range > 0) || !Number.isFinite(range) || !(radiusPx > 0)) {
    out.x = 0;
    out.y = 0;
    out.clamped = false;
    return out;
  }
  const d = Math.hypot(vx, vy);
  if (d <= range) {
    const k = radiusPx / range;
    out.x = vx * k;
    out.y = vy * k;
    out.clamped = false;
  } else {
    const k = radiusPx / d;
    out.x = vx * k;
    out.y = vy * k;
    out.clamped = true;
  }
  return out;
}

/** radarProject 的模块级暂存(HUD 每帧几百个点,不逐点 new;单线程 sync 内独占) */
const radarScratch: RadarPoint = { x: 0, y: 0, clamped: false };

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
 * rightGutter 默认 288(开发期 Tweakpane 占位);玩家模式传 0 让罗盘用到整条右缘。
 */
export function threatVisual(
  direction: number,
  intensity: number,
  width: number,
  height: number,
  rightGutter: number = HUD_RIGHT_GUTTER,
): ThreatVisual {
  const angle = Number.isFinite(direction) ? direction : 0;
  const viewportW = Number.isFinite(width) && width > 0 ? width : 1;
  const viewportH = Number.isFinite(height) && height > 0 ? height : 1;
  const cx = viewportW * 0.5;
  const cy = viewportH * 0.5;
  const margin = Math.min(22, Math.max(16, Math.min(viewportW, viewportH) * 0.025));
  const rightEdge = Math.max(cx, viewportW - (rightGutter > 0 ? rightGutter : 0));
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
  /**
   * 局内解锁提示(19 号):闪现"解锁 XX",到点自动消失。由 main 每渲染帧按
   * 阈值检测驱动(达成瞬间弹一次);根节点 pointer-events:none,不抢焦点。
   */
  toast(msg: string): void;
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

export function createHud(opts: { world: World; rightGutter?: number; debug?: boolean }): HudUi {
  let world = opts.world;
  let paused = false;
  const rightGutter = opts.rightGutter ?? HUD_RIGHT_GUTTER;
  // debug 由 main 注入(URL 口径只解析一次),HUD 不自己摸 location:sync 是 60fps 热路径,
  // 且测试桩里根本没有 location
  const debug = opts.debug ?? false;

  const root = document.createElement('div');
  root.style.cssText = ROOT_CSS;
  const top = document.createElement('div');
  top.style.cssText = topCss(rightGutter);

  const vitals = document.createElement('div');
  vitals.style.cssText = `${PANEL_CSS}display:flex;flex-direction:column;gap:7px;`;
  const hp = createBar(vitals, '船体 HP', HP_COLOR);
  const scrap = createBar(vitals, '升级残骸', SCRAP_COLOR);
  // 加速技能(空格):第三根条 —— 满格 = 就绪,回充中印剩余秒,窗内印"加速中"
  const boost = createBar(vitals, '加速 [空格]', BOOST_COLOR);

  const timer = document.createElement('div');
  timer.style.cssText = TIMER_CSS;

  const segment = document.createElement('div');
  segment.style.cssText = SEGMENT_CSS;
  const segmentBar = createBar(segment, '航段进度', OK_COLOR);

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

  // 法令徽记(18 号):一行"法令"标签 + 已持有名单;节点只建一次,每帧按掩码改写文本
  const edicts = document.createElement('div');
  edicts.style.cssText = EDICTS_CSS;
  edicts.title = '已生效法令';
  const edictsRow = document.createElement('div');
  edictsRow.style.cssText = LABEL_ROW_CSS;
  const edictsLabel = document.createElement('span');
  edictsLabel.style.cssText = LABEL_CSS;
  edictsLabel.textContent = '法令';
  const edictsValue = document.createElement('span');
  edictsValue.style.cssText = `${VALUE_CSS}color:${OK_COLOR};`;
  edictsRow.append(edictsLabel, edictsValue);
  edicts.appendChild(edictsRow);

  // 商店信标倒计时:一行"商店"标签 + 剩余秒数与距离;节点只建一次,每帧现读世界。
  // 距离也报:玩家判断"这趟跑不跑得赢"要的是**秒数与距离两个数一起看**
  //(巡航 130px/s —— 剩 8 秒、还有 900px 就是明摆着的放弃)
  const beacon = document.createElement('div');
  beacon.style.cssText = BEACON_CSS;
  beacon.title = '地图商店信标';
  const beaconRow = document.createElement('div');
  beaconRow.style.cssText = LABEL_ROW_CSS;
  const beaconLabel = document.createElement('span');
  beaconLabel.style.cssText = LABEL_CSS;
  beaconLabel.textContent = '商店';
  const beaconValue = document.createElement('span');
  beaconValue.style.cssText = `${VALUE_CSS}color:${STAR_COLOR};`;
  beaconRow.append(beaconLabel, beaconValue);
  beacon.appendChild(beaconRow);

  // 图鉴读数(19 号):星币/法令同族的第三块左列面板,节点只建一次,每帧按掩码现算
  const collection = document.createElement('div');
  collection.style.cssText = COLLECTION_CSS;
  collection.title = '图鉴';
  const collectionRow = document.createElement('div');
  collectionRow.style.cssText = LABEL_ROW_CSS;
  const collectionLabel = document.createElement('span');
  collectionLabel.style.cssText = LABEL_CSS;
  collectionLabel.textContent = '图鉴';
  const collectionValue = document.createElement('span');
  collectionValue.style.cssText = `${VALUE_CSS}color:${OK_COLOR};`;
  collectionRow.append(collectionLabel, collectionValue);
  collection.appendChild(collectionRow);

  // 火力统计面板:击杀 + 总 DPS 两行常驻,加上按武器槽上限预建的武器格(初始全藏,
  // 每帧按持有情况点亮)。格 = 一行三段(名字 | 下一次发射 | 理论 DPS)+ 一根就绪小条
  const firepower = document.createElement('div');
  firepower.style.cssText = FIREPOWER_CSS;
  firepower.title = '火力统计';
  function statRow(labelText: string, valueColor: string): { row: HTMLDivElement; value: HTMLSpanElement; label: HTMLSpanElement } {
    const row = document.createElement('div');
    row.style.cssText = LABEL_ROW_CSS;
    const label = document.createElement('span');
    label.style.cssText = LABEL_CSS;
    label.textContent = labelText;
    const value = document.createElement('span');
    value.style.cssText = `${VALUE_CSS}color:${valueColor};`;
    row.append(label, value);
    firepower.appendChild(row);
    return { row, value, label };
  }
  const killsRow = statRow('击杀', VALUE_COLOR);
  const totalDpsRow = statRow('总 DPS', OK_COLOR);
  interface WeaponBox {
    box: HTMLDivElement;
    label: HTMLSpanElement;
    cd: HTMLSpanElement;
    value: HTMLSpanElement;
    fill: HTMLDivElement;
  }
  const weaponBoxes: WeaponBox[] = [];
  for (let i = 0; i < WEAPON_SLOT_COUNT; i++) {
    const box = document.createElement('div');
    box.style.display = 'none';
    const row = document.createElement('div');
    row.style.cssText = LABEL_ROW_CSS;
    const label = document.createElement('span');
    label.style.cssText = LABEL_CSS;
    const cd = document.createElement('span');
    cd.style.cssText = `color:${IDLE_COLOR};white-space:nowrap;`;
    const value = document.createElement('span');
    value.style.cssText = VALUE_CSS;
    row.append(label, cd, value);
    const track = document.createElement('div');
    track.style.cssText = FIRE_TRACK_CSS;
    const fill = document.createElement('div');
    fill.style.cssText = FILL_CSS;
    track.appendChild(fill);
    box.append(row, track);
    firepower.appendChild(box);
    weaponBoxes.push({ box, label, cd, value, fill });
  }

  // 解锁 toast(19 号):初始隐藏,toast() 点亮并计时自动收回 —— 与升级/改造流程的
  // flash 同一条"闪现一下"的口径;连点重置计时,换局(setWorld)清掉上一局的话
  const unlockToast = document.createElement('div');
  unlockToast.style.cssText = TOAST_CSS;
  let toastTimer = 0;
  function clearToast(): void {
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = 0;
    unlockToast.textContent = '';
    unlockToast.style.display = 'none';
  }
  function toast(msg: string): void {
    unlockToast.textContent = msg;
    unlockToast.style.display = 'block';
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastTimer = 0;
      unlockToast.textContent = '';
      unlockToast.style.display = 'none';
    }, UNLOCK_TOAST_MS);
  }

  // 低血量红晕:铺满全屏的警告层,长在 HUD 根里 —— 时停淡出(setPaused 改 root opacity)
  // 自动带上它,点击穿透继承根的 pointer-events:none
  const vignette = document.createElement('div');
  vignette.style.cssText = VIGNETTE_CSS;
  vignette.title = '船体受损';

  // 战术雷达:一块圆形 canvas,布局走 gutter 口径(开发模式给 Tweakpane 让位)。
  // getContext 拿不到(测试桩 / 极端环境)就整块隐藏 —— 雷达是读数,缺了不碰主流程
  const radar = document.createElement('canvas') as HTMLCanvasElement;
  radar.width = RADAR_SIZE;
  radar.height = RADAR_SIZE;
  radar.style.cssText = radarCss(rightGutter);
  radar.title = '战术雷达';
  const radarCtx: CanvasRenderingContext2D | null =
    typeof radar.getContext === 'function' ? radar.getContext('2d') : null;
  if (!radarCtx) radar.style.display = 'none';

  // 左列纵队进顶栏 grid 第一格:vitals 在头,四块读数按序堆下去 —— 位置全交给 flex,
  // 不再有任何一块自记 top 偏移(星币压血条那类失配从结构上消灭)
  const leftCol = document.createElement('div');
  leftCol.style.cssText = LEFT_COL_CSS;
  leftCol.append(vitals, starCoins, beacon, edicts, collection, firepower);
  top.append(leftCol, timer, segment);

  root.append(top, threat, warn, muteBtn, elite, boss, unlockToast, radar, vignette);
  document.getElementById('ui')!.appendChild(root);

  function sync(): void {
    const hpMax = finiteOrZero(world.ship.maxHp);
    const hpNow = finiteOrZero(world.ship.hp);
    hp.value.textContent = `${Math.max(0, Math.round(hpNow))} / ${Math.max(0, Math.round(hpMax))}`;
    hp.fill.style.width = `${hudRatio(hpNow, hpMax) * 100}%`;

    // 低血量警告(畅玩性):血量 <25% 才亮,透明度按墙钟呼吸(0.15→0.4)。
    // 走 performance.now 而不是 sim 时间:红晕是给"玩家正被压着打"的屏幕反馈,
    // 时停/结算里 HUD 整层淡出,这里继续呼吸也无妨(看不见的部分由 setPaused 兜着)
    const hpRatio = hudRatio(hpNow, hpMax);
    if (hpRatio < VIGNETTE_HP_RATIO) {
      const phase = (performance.now() % VIGNETTE_CYCLE_MS) / VIGNETTE_CYCLE_MS;
      const pulse = 0.5 + 0.5 * Math.sin(phase * Math.PI * 2); // 0..1,一周期一呼一吸
      vignette.style.opacity = String(VIGNETTE_ALPHA_MIN + (VIGNETTE_ALPHA_MAX - VIGNETTE_ALPHA_MIN) * pulse);
    } else {
      vignette.style.opacity = '0';
    }

    const cost = finiteOrZero(world.upgradeCost);
    const scrapNow = finiteOrZero(world.scrap);
    // 玩家形态不展示具体经验值/费用:数值区留空,只保留进度条(?debug 才显示精确读数)
    scrap.value.textContent = debug ? `${Math.max(0, Math.round(scrapNow))} / ${Math.max(0, Math.round(cost))}` : '';
    scrap.fill.style.width = `${hudRatio(scrapNow, cost) * 100}%`;

    // 加速技能:读数与条都走纯函数 boostReadout(冷却上限现读 tuning —— 面板拖动即时改刻度)。
    // 窗内点亮成白色抢眼一瞬,回充/就绪回推进器青绿
    const br = boostReadout(world.boostTime, world.boostCooldown, tuning.boostCooldown);
    boost.value.textContent = br.text;
    boost.fill.style.width = `${br.ratio * 100}%`;
    boost.fill.style.background = br.active ? '#eafff4' : BOOST_COLOR;

    const coins = finiteOrZero(world.starCoins);
    starValue.textContent = String(Math.max(0, Math.round(coins)));

    // 法令徽记:每帧按 world.edictLevels 现读已持有名单 —— 名字直取 data/edicts(ui 不抄第二份),
    // **层数 ≥ 2 的挂一个 ×N**(用户设计会:"拿过两次过热上限就显示 过热上限 ×2");
    // 一层都没有时整体隐藏;叠层 / 重开换世界,当帧跟上
    const edictNames: string[] = [];
    for (let i = 0; i < EDICTS.length; i++) {
      const lv = edictLevel(world.edictLevels, i);
      if (lv <= 0) continue;
      edictNames.push(lv >= 2 ? `${EDICTS[i]!.name}×${lv}` : EDICTS[i]!.name);
    }
    if (edictNames.length > 0) {
      edicts.style.display = 'block';
      edictsValue.textContent = edictNames.join(' ');
    } else {
      edicts.style.display = 'none';
    }

    // 商店信标:亮着才显示,报"还剩几秒 · 还有多远"。距离取船心到信标的直线距离
    // (与 sim 的接触判定同一对坐标),不减判定半径 —— 玩家读的是"要跑多远",不是"还差几像素"
    if (world.shopBeaconActive) {
      const dx = world.shopBeaconX - world.ship.x;
      const dy = world.shopBeaconY - world.ship.y;
      beacon.style.display = 'block';
      beaconValue.textContent = `${Math.max(0, Math.ceil(finiteOrZero(world.shopBeaconTtl)))}s · ${Math.round(
        Math.hypot(dx, dy),
      )}px`;
    } else {
      beacon.style.display = 'none';
    }

    // 图鉴读数(19 号):已解锁计数 = world.unlockMask 置位数 / UNLOCKS 总数。
    // World 的掩码就是开局时喂进来的 progress.unlockMask(同编码,world.ts 字段注释),
    // 局内只增不减、重开换世界当帧跟上 —— HUD 不另接进度引用
    let unlocked = 0;
    for (let i = 0; i < UNLOCKS.length; i++) {
      if ((world.unlockMask & (1 << i)) !== 0) unlocked++;
    }
    collectionValue.textContent = `${unlocked}/${UNLOCKS.length}`;

    // 火力统计:击杀直读;DPS 是 slotSustainedDps 的**理论固定值**(逐槽算、同型求和),
    // 下一次发射读数走 slotFireReadout,同型多把取"最快就绪那把"(下一发确实从它出膛)。
    // 同型合并成一格印 ×N;格数上限 = 武器槽数,这两层 O(4×4) 的小循环没有分配、没有排序
    killsRow.value.textContent = String(Math.max(0, Math.round(finiteOrZero(world.kills))));
    const buffs = world.buffs;
    let boxCursor = 0;
    let totalDps = 0;
    const weapons = world.weapons;
    for (let i = 0; i < weapons.length; i++) {
      const slot = weapons[i]!;
      if (slot.type < 0) continue;
      const def = TOWERS[slot.type];
      // 首见槽位才出格:往前扫到同型就交给它那一格(count/maxLevel/dps/发射读数一次算齐)
      let firstSeen = true;
      let count = 0;
      let maxLevel = 0;
      let dps = 0;
      for (let j = 0; j < weapons.length; j++) {
        const other = weapons[j]!;
        if (other.type !== slot.type) continue;
        if (j < i) {
          firstSeen = false;
          break;
        }
        count++;
        if (other.level > maxLevel) maxLevel = other.level;
        if (def) {
          dps += slotSustainedDps(other, def, buffs);
          slotFireReadout(other, def, buffs, fireScratch);
          if (count === 1 || fireScratch.seconds < fireBest.seconds) {
            fireBest.state = fireScratch.state;
            fireBest.seconds = fireScratch.seconds;
            fireBest.ratio = fireScratch.ratio;
          }
        }
      }
      if (!firstSeen) continue;
      totalDps += dps;
      const name = def?.name ?? '?';
      const b = weaponBoxes[boxCursor++]!;
      b.box.style.display = 'block';
      b.label.textContent = count > 1 ? `${name} Lv${maxLevel} ×${count}` : `${name} Lv${maxLevel}`;
      b.value.textContent = formatDps(dps);
      if (def) {
        const color = fireReadoutColor(fireBest.state);
        b.cd.textContent = fireReadoutText(fireBest.state, fireBest.seconds);
        b.cd.style.color = color;
        b.fill.style.width = `${hudRatio(fireBest.ratio, 1) * 100}%`;
        b.fill.style.background = color;
      } else {
        // 塔型越界(表被改坏):名字已印 '?',发射读数与小条留空,不拿 NaN 去画
        b.cd.textContent = '';
        b.fill.style.width = '0%';
      }
    }
    // 没点亮的格连文本一起清:换局(setWorld → sync)时上一局的武器名不许在隐藏格里赖着
    for (; boxCursor < weaponBoxes.length; boxCursor++) {
      const b = weaponBoxes[boxCursor]!;
      b.box.style.display = 'none';
      b.label.textContent = '';
      b.cd.textContent = '';
      b.value.textContent = '';
      b.fill.style.width = '0%';
    }
    totalDpsRow.value.textContent = formatDps(totalDps);

    timer.textContent = formatDuration(world.elapsed);

    const seg = segmentReadout(world.wave.segment, world.wave.segTime);
    segmentBar.value.textContent = seg.label;
    segmentBar.fill.style.width = `${seg.ratio * 100}%`;

    const visual = threatVisual(
      world.threatDirection,
      world.threatIntensity,
      window.innerWidth,
      window.innerHeight,
      rightGutter,
    );
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
      const wv = threatVisual(
        burst.dirRad,
        THREAT_INTENSITY_MAX * (0.4 + 0.6 * closeness),
        window.innerWidth,
        window.innerHeight,
        rightGutter,
      );
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

    // 战术雷达:全清全画。点位 = 世界相对位移经 radarProject 缩进圈内(不随船头旋转,
    // 世界系方向即雷达方向 —— 与罗盘箭头同一套"世界绝对角"口径,两块读数不打架)。
    // 复用上面那趟池扫描拿不到位置明细,这里自己再遍历一次 items:每帧几百次 fillRect,
    // 是 canvas 2D 的舒适区;radarScratch 复用,零分配
    if (radarCtx) {
      const c = radarCtx;
      const center = RADAR_SIZE / 2;
      const rim = center - 3;
      const shipX = finiteOrZero(world.ship.x);
      const shipY = finiteOrZero(world.ship.y);
      c.clearRect(0, 0, RADAR_SIZE, RADAR_SIZE);
      // 距离参照:半量程刻度环 + 十字线,极淡 —— 是标尺,不是内容
      c.strokeStyle = 'rgba(43,74,110,.55)';
      c.lineWidth = 1;
      c.beginPath();
      c.arc(center, center, rim * 0.5, 0, Math.PI * 2);
      c.stroke();
      c.beginPath();
      c.moveTo(center - rim, center);
      c.lineTo(center + rim, center);
      c.moveTo(center, center - rim);
      c.lineTo(center, center + rim);
      c.stroke();
      // 经验掉落:金色小点,画在敌点之下。圈外的不画 —— 捡不到的方位只是噪音
      c.fillStyle = SCRAP_COLOR;
      const dropItems = world.drops.items;
      for (let i = 0; i < dropItems.length; i++) {
        const d = dropItems[i]!;
        const p = radarProject(d.x - shipX, d.y - shipY, RADAR_RANGE, rim, radarScratch);
        if (p.clamped) continue;
        c.fillRect(center + p.x - 1, center + p.y - 1, 2, 2);
      }
      // 敌人:普通 = 威胁红小点,精英 = 亮一号的大点,Boss = 深红大方块(与 Boss 血条同色)。
      // 钉在圈沿的(量程外)透明度减半:方向仍真,距离已饱和
      for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i]!;
        const p = radarProject(e.x - shipX, e.y - shipY, RADAR_RANGE, rim, radarScratch);
        c.globalAlpha = p.clamped ? 0.45 : 1;
        if (e.kind === KIND_BOSS) {
          c.fillStyle = BOSS_HP_COLOR;
          c.fillRect(center + p.x - 3, center + p.y - 3, 6, 6);
        } else if (e.affixes !== 0) {
          c.fillStyle = '#ff8ba0';
          c.fillRect(center + p.x - 2, center + p.y - 2, 4, 4);
        } else {
          c.fillStyle = THREAT_COLOR;
          c.fillRect(center + p.x - 1, center + p.y - 1, 2, 2);
        }
      }
      c.globalAlpha = 1;
      // 自己的船:圆心一支按船头朝向的小三角(雷达不转,船头在雷达上转 —— 与战场同构)
      c.save();
      c.translate(center, center);
      c.rotate(finiteOrZero(world.ship.heading));
      c.fillStyle = OK_COLOR;
      c.beginPath();
      c.moveTo(6, 0);
      c.lineTo(-4, -4);
      c.lineTo(-4, 4);
      c.closePath();
      c.fill();
      c.restore();
    }
  }

  sync();

  return {
    setWorld(next: World): void {
      world = next;
      // 上一局(或上一帧)弹的解锁提示属于旧世界:换局当场清掉,不赖到新局里
      clearToast();
      sync();
    },
    setPaused(next: boolean): void {
      if (paused === next) return;
      paused = next;
      root.style.opacity = paused ? '0.06' : '1';
    },
    sync,
    toast,
  };
}
