/**
 * 结算界面(08 号 issue T3)—— DOM 覆盖层,**永不 import pixi**(铁律 1 的另一半:
 * 世界里的东西走 Pixi,菜单/卡片/面板走 #ui)。
 *
 * 它只做五件事:把一局的结果念出来(胜/负 + 存活时间 + 击杀数 + 航段进度)、
 * 摆一张可选的船形剪影、报一次「解锁 XX」(19 号)、铺一张元进度图鉴(19 号:
 * 塔/敌人/法令的解锁状态 + 最近几张船形剪影,未解锁灰显)、给一个「再来一局」。
 * **一个字都不认识 World**:
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
import { EDICTS } from '../data/edicts';
import { ENEMIES } from '../data/enemies';
import { TOWERS } from '../data/towers';
import {
  UNLOCK_COLLECT,
  UNLOCK_EDICT,
  UNLOCK_ELITE,
  UNLOCK_TOWER,
  UNLOCKS,
  type UnlockEntry,
} from '../data/unlocks';
import { WAVE_LOCKED_ELITES } from '../data/waves';
import type { Progress } from '../sim/progress';
import { RESULT_LOSE, RESULT_WIN } from '../sim/world';

/** 冷色域:我方废铁本色,与 ui/upgradeFlow.ts 的合法高亮同一支蓝(两处提示读起来才是同一件事) */
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
 * 于是数值天然对成一列,不必为三行读数摆一套 grid。写法与 ui/upgradeFlow.ts 的提示条同源。
 */
const STATS_CSS = `white-space:pre;text-align:left;display:inline-block;color:${VALUE_COLOR};margin-bottom:16px;`;

/** 「解锁 XX」块:与读数同一套左对齐多行文本,但用提示条那支冷青蓝(19 号:解锁是正反馈,不是账本) */
const UNLOCK_CSS =
  'white-space:pre;text-align:left;' +
  `display:inline-block;color:${OK_COLOR};margin-bottom:16px;letter-spacing:.04em;`;

/** 图鉴块:与读数区之间顶边线分隔;内容超高时自己滚动,别把按钮挤出屏外 */
const COLLECTION_CSS =
  'margin-top:14px;padding-top:12px;border-top:1px solid rgba(43,74,110,.55);' +
  'text-align:left;max-height:38vh;overflow-y:auto;';
const COLLECTION_TITLE_CSS = `color:${OK_COLOR};font-size:12px;letter-spacing:.16em;margin-bottom:2px;`;
const CATEGORY_CSS = `color:${IDLE_COLOR};font-size:12px;letter-spacing:.12em;margin-top:10px;margin-bottom:3px;`;
/** 图鉴条目:已解锁 = 读数同色;未解锁 = 灰字 + 降透明度(灰显,见 renderCollection) */
const ITEM_CSS = `color:${VALUE_COLOR};`;
const ITEM_LOCKED_CSS = `color:${IDLE_COLOR};opacity:.45;`;
/** 历史船形缩略图;dataURL 原样显示,object-fit 兜住剪影的透明边 */
const SHOT_THUMB_CSS =
  `width:52px;height:52px;object-fit:contain;background:rgba(5,7,13,.6);` +
  `border:1px solid ${LINE_COLOR};border-radius:4px;margin:4px 6px 0 0;`;
const SHOT_PLACEHOLDER_CSS = `color:${IDLE_COLOR};margin-top:4px;`;

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
  /** Boss 被击杀的时刻(elapsed 秒)= world.bossKilledAt;未击杀 = 0。只有胜利局会印它 */
  bossKilledAtSec: number;
  /** 船形剪影 dataURL;渲染层抓不到就是 null,此时那一格整个不显示 */
  silhouette: string | null;
  /** 本次结算新开锁的 UNLOCKS 下标(增量);空数组 = 没有新解锁,「解锁 XX」区块整个不显示 */
  newUnlocks: number[];
  /** 结算后的元进度(sim/progress.ts):解锁掩码 + 计数器 + 剪影集合,图鉴读它 */
  progressStats: Progress;
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
 * 结果标题。**未知码不许静默兜底成胜利**(与 ui/upgradeFlow.ts 的 denyMessage 同一条口径):
 * RESULT_RUNNING 或将来新加的结果码漏配文案时,得当场把码印出来 ——
 * 悄悄显示"Boss 击破"的话,一条判定写反了都没人看得见。
 * 胜利文案挂 Boss(15 号):胜利的唯一来路是 Boss 已击杀(world.ts 的 settleOutcome),
 * 不再有"脚本走完即赢"这回事,标题跟着判定口径走。
 */
export function resultTitle(result: number): string {
  switch (result) {
    case RESULT_WIN:
      return 'Boss 击破';
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
      return '封锁线 Boss 已被击破 —— 这艘船活着开出了怪潮';
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
 * 胜利时追加一行 Boss 击杀时刻。失败局**一律不显示这一行**(简单口径):
 * 这一行是"赢了这场仗"的记功,不是统计数字 —— 失败局就算真杀了 Boss
 * (Boss 死后被虫群淹了),读它也只是在伤口上撒盐。
 */
export function summaryText(s: RunSummary): string {
  const lines = [
    `存活时间  ${formatDuration(s.survivedSec)}`,
    `击杀数量  ${Math.round(s.kills)}`,
    `航段进度  ${segmentLabel(s.segment, s.segmentCount)}`,
  ];
  if (s.result === RESULT_WIN) {
    lines.push(`Boss 击杀  ${formatDuration(s.bossKilledAtSec)}`);
  }
  return lines.join('\n');
}

/**
 * 图鉴一次展示的剪影张数:从 progressStats.silhouettes 取**最近 N 张**
 * (存档侧本来就限量存最近 10 张,这里只摆一小排,免得结算卡拖一堆 100KB 级 dataURL)。
 */
export const COLLECTION_SILHOUETTE_MAX = 3;

/** 图鉴分类名(UNLOCK_* → 类别文案);未知 kind 印出码本身,与 resultTitle 的未知结果码同一口径 */
export function collectionCategoryName(kind: number): string {
  switch (kind) {
    case UNLOCK_TOWER:
      return '塔';
    case UNLOCK_ELITE:
      return '敌人';
    case UNLOCK_EDICT:
      return '法令';
    case UNLOCK_COLLECT:
      return '船形剪影';
    default:
      return `分类 ${kind}`;
  }
}

/** 解锁精英的底敌型名(WAVE_LOCKED_ELITES[type] → ENEMIES[kind].name);查不到返回 null */
function eliteBaseName(entry: UnlockEntry): string | null {
  const elite = WAVE_LOCKED_ELITES[entry.type];
  if (elite === undefined) return null;
  return ENEMIES[elite.kind]?.name ?? null;
}

/**
 * 图鉴条目显示名:从内容表读(towers / edicts / waves),数据表改名图鉴跟着走 ——
 * 与 summaryText 的"段数由调用方传"相反:这里是静态展示,数据表即真相。
 * 精英条目把底敌型名带进括号("虫群母巢(冲撞甲虫精英)"),未解锁时玩家也读得到"解锁的是什么"。
 */
export function collectionItemName(entry: UnlockEntry): string {
  switch (entry.kind) {
    case UNLOCK_TOWER:
      return TOWERS[entry.type]?.name ?? entry.name;
    case UNLOCK_EDICT:
      return EDICTS[entry.type]?.name ?? entry.name;
    case UNLOCK_ELITE: {
      const base = eliteBaseName(entry);
      return base === null ? entry.name : `${entry.name}(${base}精英)`;
    }
    default:
      return entry.name;
  }
}

/**
 * 焦点在调参面板的输入框里:此时 Enter 是在提交一个数值,不该被当成"再来一局"抢走。
 * 判据与 ui/upgradeFlow.ts 里那份一字不差 —— tweakpane 挂在 body 上、位置比 #ui 还靠后,
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
 * 多一块遮罩 = 战斗中屏幕上永远糊着一层看不见的点击拦截层(与 ui/upgradeFlow.ts 的 setWorld 同一条教训)。
 *
 * @param opts.onRestart 「再来一局」的去处。**结算界面不认识 World、不动 loop、不复位任何状态**:
 *   那一整套(新 World + 新 loop + renderer.setWorld + upgradeFlow.setWorld + UI 复位)在 main.ts 一处,
 *   这里只负责把"玩家想再来一局"这件事说出来。
 * @param opts.onRetry 「再试这一局」(同 seed 重开,畅玩性调整)。不传就不摆这个按钮 ——
 *   语义仍是"说出玩家想要什么",换不换种子是 main.ts 那条重开流程的事。
 *   被特定波次组合打死后,"我知道 48s 右舷会来侧掠者"这类死后学习必须有处可用,
 *   否则 9 分钟从零重来的失败惩罚被换种子无谓放大。
 */
export function createGameOverUi(opts: { onRestart: () => void; onRetry?: () => void }): GameOverUi {
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
  // —— 19 号:「解锁 XX」+ 图鉴两块。图鉴常显(未解锁全灰 = "下一把的新理由"就摆在眼前),
  // 「解锁 XX」只在本次有新解锁时露脸;内容由 show() 按 newUnlocks / progressStats 现刷 ——
  const unlockEl = document.createElement('div');
  unlockEl.style.cssText = UNLOCK_CSS;
  unlockEl.style.display = 'none'; // 默认收着:首局往往没有新解锁,由 renderUnlocks 决定何时露脸
  const collectionEl = document.createElement('div');
  collectionEl.style.cssText = COLLECTION_CSS;
  const collectionTitleEl = document.createElement('div');
  collectionTitleEl.style.cssText = COLLECTION_TITLE_CSS;
  const collectionItemsEl = document.createElement('div');
  collectionEl.append(collectionTitleEl, collectionItemsEl);
  const btn = document.createElement('button');
  btn.style.cssText = BTN_CSS;
  // 键位写在按钮上:结算界面没有别的地方能提示"Enter 也行",而重开是这里唯一的动作
  btn.textContent = '再来一局(Enter)';
  // 「再试这一局」摆在「再来一局」下面:换种子重开仍是主动作(同一份怪潮打第二遍没什么可玩的),
  // 同 seed 重试是"这一局我想再练一次"的次动作 —— 顺序即优先级
  const retryBtn = document.createElement('button');
  retryBtn.style.cssText = BTN_CSS + 'margin-top:8px;';
  retryBtn.textContent = '再试这一局(R · 同种子)';
  card.append(titleEl, noteEl, shotEl, statsEl, unlockEl, collectionEl, btn);
  if (opts.onRetry) card.appendChild(retryBtn);
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

  function retry(): void {
    // 与 restart 同口径:先收面板再回调,理由一字同源
    hide();
    opts.onRetry?.();
  }

  /** 刷新「解锁 XX」块:有新解锁才露脸;空数组整个隐藏(没有新解锁的局没有这条新闻) */
  function renderUnlocks(s: RunSummary): void {
    if (s.newUnlocks.length === 0) {
      unlockEl.textContent = '';
      unlockEl.style.display = 'none';
      return;
    }
    const lines: string[] = [];
    for (const i of s.newUnlocks) {
      // 名字取 UNLOCKS 表 —— 与局内 toast 同源,结算页报的与局内弹的是同一句
      lines.push(`解锁:${UNLOCKS[i]?.name ?? `#${i}`}`);
    }
    unlockEl.textContent = lines.join('\n');
    unlockEl.style.display = 'block';
  }

  /** 刷新图鉴:塔 → 敌人 → 法令三栏列内容解锁项(已解锁彩色、未解锁灰显 + 标注),末尾挂最近几张船形剪影 */
  function renderCollection(s: RunSummary): void {
    const mask = s.progressStats.unlockMask;
    const content: Array<{ index: number; entry: UnlockEntry }> = [];
    for (let i = 0; i < UNLOCKS.length; i++) {
      if (UNLOCKS[i]!.kind === UNLOCK_COLLECT) continue; // 船形收藏无条件,不占"内容解锁"的分子分母
      content.push({ index: i, entry: UNLOCKS[i]! });
    }
    let unlocked = 0;
    for (const c of content) if ((mask & (1 << c.index)) !== 0) unlocked++;
    collectionTitleEl.textContent = `图鉴 · 内容解锁 ${unlocked}/${content.length}`;
    collectionItemsEl.replaceChildren();
    for (const kind of [UNLOCK_TOWER, UNLOCK_ELITE, UNLOCK_EDICT]) {
      const members = content.filter((c) => c.entry.kind === kind);
      if (members.length === 0) continue;
      const label = document.createElement('div');
      label.style.cssText = CATEGORY_CSS;
      label.textContent = collectionCategoryName(kind);
      collectionItemsEl.appendChild(label);
      for (const { index, entry } of members) {
        const locked = (mask & (1 << index)) === 0;
        const item = document.createElement('div');
        item.style.cssText = locked ? ITEM_LOCKED_CSS : ITEM_CSS;
        item.textContent = locked
          ? `${collectionItemName(entry)}(未解锁)`
          : collectionItemName(entry);
        collectionItemsEl.appendChild(item);
      }
    }
    // 船形剪影收尾:最近 N 张缩略图;一张都没有给占位(别让这一栏空着)
    const label = document.createElement('div');
    label.style.cssText = CATEGORY_CSS;
    label.textContent = collectionCategoryName(UNLOCK_COLLECT);
    collectionItemsEl.appendChild(label);
    const shots = s.progressStats.silhouettes.slice(-COLLECTION_SILHOUETTE_MAX);
    if (shots.length === 0) {
      const ph = document.createElement('div');
      ph.style.cssText = SHOT_PLACEHOLDER_CSS;
      ph.textContent = '暂无收藏剪影 —— 每局结算自动收录';
      collectionItemsEl.appendChild(ph);
    } else {
      for (const url of shots) {
        const thumb = document.createElement('img');
        thumb.style.cssText = SHOT_THUMB_CSS;
        thumb.src = url;
        thumb.alt = '历史船形';
        collectionItemsEl.appendChild(thumb);
      }
    }
  }

  btn.addEventListener('click', restart);
  retryBtn.addEventListener('click', retry);

  window.addEventListener('keydown', (e) => {
    // 收着的时候一律不认:战斗中按 Enter/R 不该把正打着的一局重开掉
    if (!visible || e.repeat || isTyping()) return;
    // R = 同 seed 重试(与放置阶段的旋转键无冲突:结算界面弹出时升级流程必然收着)
    if (opts.onRetry && e.code === 'KeyR') {
      e.preventDefault();
      retry();
      return;
    }
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
      renderUnlocks(s);
      renderCollection(s);
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
