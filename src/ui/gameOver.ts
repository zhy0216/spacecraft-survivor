/**
 * 结算界面(08 号 issue T3)—— DOM 覆盖层,**永不 import pixi**(铁律 1 的另一半:
 * 世界里的东西走 Pixi,菜单/卡片/面板走 #ui)。
 *
 * 它只做三件事:把一局的结果念出来(胜/负 + 存活时间 + 击杀数 + 航段进度)、
 * 摆一张可选的船形剪影、给一个「再来一局」。**一个字都不认识 World**:
 * 摘数据、停 sim、换 World 全在 main.ts 那条重开流程里,这里收的是一份纯数据 RunSummary ——
 * 于是"结算显示什么"能脱开渲染与 sim 单测(下面那几个纯函数就是拦网),
 * 而 10 号 issue 把结算并进正式流程时,换掉的只是这一层的皮。
 *
 * 剪影同理只收一个 dataURL(渲染层的 captureShipSilhouette 给,抓不到就是 null):
 * ui 层不认识 pixi,也就不该知道那张图是怎么截出来的。
 *
 * 配色按 GDD §12 的敌我色域分离:整块面板一律冷色(我方废铁的青蓝),
 * **暖红只许出现在失败标题那几个字上**,不铺成色块 —— 铺开就成了敌方色域,
 * 而失败界面里唯一属于敌人的只有"你被打沉了"这个事实本身。
 */
import { RESULT_LOSE, RESULT_WIN } from '../sim/world';

/** 冷色域:我方废铁本色,与 ui/placement.ts 的合法高亮同一支蓝(两处提示读起来才是同一件事) */
const OK_COLOR = '#9adcff';
/** 暖红只用于失败标题这几个字(GDD §12:敌方色域不铺成面) */
const LOSE_COLOR = '#ff7a6b';
const IDLE_COLOR = '#5f7a99';
const VALUE_COLOR = '#c8dcf0';
/** 船体冷色废铁本色,与提示条边框同一个值 */
const LINE_COLOR = '#2b4a6e';

/**
 * 满屏遮罩。**铺满整屏是故意的**:它是 #ui 的直接子元素,于是吃到 index.html 里
 * `#ui > * { pointer-events:auto }` 那条规则 —— 结算弹出后,点击一律落在这块遮罩上而不是画布上,
 * 玩家不会对着一艘已经沉了的船继续放塔(而放塔在 sim 里照样会成功,那才是最难解释的一类 bug)。
 * 收起时 display:none,连同 pointer-events 一起失效,战斗中不会挡住任何一次点击。
 */
const ROOT_CSS =
  'position:fixed;inset:0;display:none;align-items:center;justify-content:center;' +
  'background:rgba(5,7,13,.82);' +
  'font:13px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;user-select:none;';

const CARD_CSS =
  'min-width:260px;max-width:min(92vw,420px);padding:22px 28px;border-radius:10px;' +
  `background:rgba(10,16,26,.94);border:1px solid ${LINE_COLOR};text-align:center;`;

const TITLE_CSS = 'font-size:22px;letter-spacing:.18em;margin-bottom:6px;';
const NOTE_CSS = `color:${IDLE_COLOR};margin-bottom:14px;`;

/**
 * 剪影。默认 display:none —— 截图失败(渲染上下文丢了、离屏 canvas 不给 toDataURL)时
 * 结算界面照常弹,只是少一张图:一张锦上添花的图绝不许把胜负结算这条主流程带崩。
 */
const SHOT_CSS = 'display:none;max-width:60%;height:auto;margin:0 auto 14px;';

/**
 * 读数区。white-space:pre + 等宽字体 + 左对齐(卡片本身居中):三行的标签都是 4 个汉字,
 * 于是数值天然对成一列,不必为三行读数摆一套 grid。写法与 ui/placement.ts 的提示条同源。
 */
const STATS_CSS = `white-space:pre;text-align:left;display:inline-block;color:${VALUE_COLOR};margin-bottom:16px;`;

/** button 不继承页面字体,font:inherit 这一句不能省(否则读数是等宽、按钮是系统黑体) */
const BTN_CSS =
  'display:block;width:100%;padding:9px 0;border-radius:6px;cursor:pointer;font:inherit;' +
  `border:1px solid ${LINE_COLOR};background:rgba(43,74,110,.28);color:${OK_COLOR};letter-spacing:.1em;`;

/** 一局的结算数据 —— **纯数据**,由 main.ts 从 World 上摘好递进来(见文件头) */
export interface RunSummary {
  /** RESULT_WIN / RESULT_LOSE(sim/world.ts) */
  result: number;
  /** 存活时间(秒)= world.elapsed */
  survivedSec: number;
  kills: number;
  /** world.wave.segment:下标,显示时 +1(见 segmentLabel) */
  segment: number;
  /** WAVE_SEGMENTS.length;由调用方传而不是本文件去 import 数据表 —— 短脚本单测才好摆 */
  segmentCount: number;
  /** 船形剪影 dataURL;渲染层抓不到就是 null,此时那一格整个不显示 */
  silhouette: string | null;
}

export interface GameOverUi {
  show(s: RunSummary): void;
  hide(): void;
}

/**
 * 存活时间 m:ss。秒数**向下取整**:8:59.9 报成 8:59 而不是 9:00 ——
 * 胜利界面上报出一个比总时长还大的数,会让人以为脚本多跑了一段。
 * 负数(理论上出不来)夹成 0,免得显示成 "-1:-3" 这种读不出来的东西。
 */
export function formatDuration(sec: number): string {
  const total = Math.floor(sec > 0 ? sec : 0);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * 航段进度 "n/4"。segment 是**下标**,显示时 +1(玩家读的是第几段,不是数组下标);
 * 脚本走完时 segment == count(越界值),此时报满段并注明全通 ——
 * 直接 +1 会印出 "5/4",而那正是胜利界面上最不该出现的一个数。
 * 与调参面板共用这一个函数(见 ui/debugPanel.ts):两处显示的"航段进度"必须是同一句话,
 * 各写各的迟早会在"走完那一刻"分家。
 */
export function segmentLabel(segment: number, count: number): string {
  if (count <= 0) return '—';
  if (segment >= count) return `${count}/${count}(全通)`;
  const n = segment > 0 ? segment + 1 : 1;
  return `${n}/${count}`;
}

/**
 * 结果标题。**未知码不许静默兜底成胜利**(与 ui/placement.ts 的 denyMessage 同一条口径):
 * RESULT_RUNNING 或将来新加的结果码漏配文案时,得当场把码印出来 ——
 * 悄悄显示"航段全通"的话,一条判定写反了都没人看得见。
 */
export function resultTitle(result: number): string {
  switch (result) {
    case RESULT_WIN:
      return '航段全通';
    case RESULT_LOSE:
      return '船体解体';
    default:
      return `本局结束(结果码 ${result})`;
  }
}

/** 标题下面那句话。分成两句而不是并进标题:标题要能一眼扫到,原因留给第二行慢慢读 */
export function resultNote(result: number): string {
  switch (result) {
    case RESULT_WIN:
      return '脚本走完 —— 这艘船活着开出了怪潮';
    case RESULT_LOSE:
      return '船体 HP 归零 —— 这一局的账都记在甲板上';
    default:
      return '结果码没有配文案(这是个 bug)';
  }
}

/**
 * 三行读数。做成**纯函数返回整块文本**(而不是就地改一堆 DOM 节点):
 * "结算到底显示了什么"于是能在 Node 里数出来 —— 少一行、把击杀数印成小数、
 * 胜利时航段印成 5/4,全都是要等真人打完一整局(8–10 分钟)才看得见的错。
 * 击杀数取整:kills 本来就是整数,这一句防的是将来有人往里塞个加权分。
 */
export function summaryText(s: RunSummary): string {
  return [
    `存活时间  ${formatDuration(s.survivedSec)}`,
    `击杀数量  ${Math.round(s.kills)}`,
    `航段进度  ${segmentLabel(s.segment, s.segmentCount)}`,
  ].join('\n');
}

/**
 * 焦点在调参面板的输入框里:此时 Enter 是在提交一个数值,不该被当成"再来一局"抢走。
 * 判据与 ui/placement.ts 里那份一字不差 —— tweakpane 挂在 body 上、位置比 #ui 还靠后,
 * 结算弹出时它照样点得到,所以这道拦网这里也得有(为两行 DOM 判断单开一个共享模块不值得,
 * 但两处必须同口径:哪天放置那边改了判据,这里也得跟)。
 */
function isTyping(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

/**
 * 接线结算界面。整局(乃至整个页面生命周期)**只建一次**:DOM 与 window 监听器都在这里挂,
 * 重开走的是 show/hide,而不是重建一份 —— 每重开一局多一份监听器 = 一次 Enter 重开好几局,
 * 多一块遮罩 = 战斗中屏幕上永远糊着一层看不见的点击拦截层(与 ui/placement.ts 的 setWorld 同一条教训)。
 *
 * @param opts.onRestart 「再来一局」的去处。**结算界面不认识 World、不动 loop、不复位任何状态**:
 *   那一整套(新 World + 新 loop + renderer.setWorld + placement.setWorld + UI 复位)在 main.ts 一处,
 *   这里只负责把"玩家想再来一局"这件事说出来。
 */
export function createGameOverUi(opts: { onRestart: () => void }): GameOverUi {
  const root = document.createElement('div');
  root.style.cssText = ROOT_CSS;
  const card = document.createElement('div');
  card.style.cssText = CARD_CSS;
  const titleEl = document.createElement('div');
  titleEl.style.cssText = TITLE_CSS;
  const noteEl = document.createElement('div');
  noteEl.style.cssText = NOTE_CSS;
  const shotEl = document.createElement('img');
  shotEl.style.cssText = SHOT_CSS;
  shotEl.alt = '本局最终船形';
  const statsEl = document.createElement('div');
  statsEl.style.cssText = STATS_CSS;
  const btn = document.createElement('button');
  btn.style.cssText = BTN_CSS;
  // 键位写在按钮上:结算界面没有别的地方能提示"Enter 也行",而重开是这里唯一的动作
  btn.textContent = '再来一局(Enter)';
  card.append(titleEl, noteEl, shotEl, statsEl, btn);
  root.appendChild(card);
  document.getElementById('ui')!.appendChild(root);

  // 可见性自己记一份,不去读 style.display 反解:Enter 的守卫读的就是它,
  // 而"面板收着的时候按 Enter 不该重开"是这道守卫唯一的职责
  let visible = false;

  function hide(): void {
    visible = false;
    root.style.display = 'none';
  }

  function restart(): void {
    // 先收起面板再回调:main.ts 那边也会 hide 一次(重开流程的一步),但"点了就该消失"
    // 不该依赖调用方记得那一句 —— 何况 onRestart 里要新建 World,那一瞬间面板还挂着就是花屏
    hide();
    opts.onRestart();
  }

  btn.addEventListener('click', restart);

  window.addEventListener('keydown', (e) => {
    // 收着的时候一律不认:战斗中按 Enter 不该把正打着的一局重开掉
    if (!visible || e.repeat || isTyping()) return;
    if (e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
    // **必须挡掉默认行为**:按钮刚被点过时它是带着焦点的,而 Enter 对一个聚焦的 button
    // 默认会再派一次 click —— 那就是一次按键重开两局(第二局立刻被第三局顶掉,
    // 玩家只会看到"重开之后局数莫名其妙跳了")
    e.preventDefault();
    restart();
  });

  return {
    show(s: RunSummary): void {
      titleEl.textContent = resultTitle(s.result);
      // 整块面板只有这几个字用暖色(GDD §12);胜利则是我方冷色域
      titleEl.style.color = s.result === RESULT_LOSE ? LOSE_COLOR : OK_COLOR;
      noteEl.textContent = resultNote(s.result);
      statsEl.textContent = summaryText(s);
      // 抓不到剪影就整个不显示,**且不去动 src** —— 置空 src 在部分浏览器上会重新请求当前页面,
      // 而这里唯一想表达的只是"这一局没截到图"
      if (s.silhouette !== null) {
        shotEl.src = s.silhouette;
        shotEl.style.display = 'block';
      } else {
        shotEl.style.display = 'none';
      }
      visible = true;
      root.style.display = 'flex';
    },
    hide,
  };
}
