/**
 * 结算界面(08 号 issue T3)—— DOM 覆盖层,**永不 import pixi**(铁律 1 的另一半:
 * 世界里的东西走 Pixi,菜单/卡片/面板走 #ui)。
 *
 * 它只做五件事:把一局的结果念出来(胜/负 + 存活时间 + 击杀数 + 航段进度)、
 * 报一次「解锁 XX」(19 号)、铺一张元进度图鉴(19 号:
 * 塔/敌人/法令的解锁状态,未解锁灰显)、给一个「再来一局」。
 * **一个字都不认识 World**:
 * 摘数据、停 sim、换 World 全在 main.ts 那条重开流程里,这里收的是一份纯数据 RunSummary ——
 * 于是"结算显示什么"能脱开渲染与 sim 单测(下面那几个纯函数就是拦网),
 * 而 10 号 issue 把结算并进正式流程时,换掉的只是这一层的皮。
 *
 * 配色按 GDD §12 的敌我色域分离:整块面板一律冷色(我方废铁的青蓝),
 * **暖红只许出现在失败标题那几个字上**,不铺成色块 —— 铺开就成了敌方色域,
 * 而失败界面里唯一属于敌人的只有"你被打沉了"这个事实本身。
 */
import {
  UNLOCK_EDICT,
  UNLOCK_ELITE,
  UNLOCK_TOWER,
  UNLOCKS,
  type UnlockEntry,
} from '../data/unlocks';
import { WAVE_LOCKED_ELITES } from '../data/waves';
import type { Progress } from '../sim/progress';
import { RESULT_LOSE, RESULT_WIN } from '../sim/world';
import { isTyping } from '../core/isTyping';
import { edictName, enemyName, towerName } from './presentation/contentText';
import { unlockName } from './presentation/unlockText';

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

/** 武器战报块:读数区之下、「解锁 XX」之上;行 = 名字 + 占比条 + 伤害数(冷色域,GDD §12) */
const REPORT_CSS = 'text-align:left;margin-bottom:16px;';
const REPORT_TITLE_CSS = `color:${IDLE_COLOR};font-size:12px;letter-spacing:.12em;margin-bottom:4px;`;
const REPORT_ROW_CSS = `display:flex;align-items:center;gap:8px;color:${VALUE_COLOR};`;
const REPORT_TRACK_CSS =
  'flex:1 1 auto;height:5px;border-radius:999px;background:rgba(43,74,110,.35);overflow:hidden;';
const REPORT_FILL_CSS = `height:100%;background:${OK_COLOR};border-radius:inherit;`;

/** button 不继承页面字体,font:inherit 这一句不能省(否则读数是等宽、按钮是系统黑体) */
const BTN_CSS =
  'display:block;width:100%;padding:9px 0;border-radius:6px;cursor:pointer;font:inherit;' +
  `border:1px solid ${LINE_COLOR};background:rgba(43,74,110,.28);color:${OK_COLOR};letter-spacing:.1em;`;

/**
 * 上传回调的返回口径:null = 成功(按钮改口「已上传」);非 null = 一句失败原因
 * (按钮原样印它 —— "未配置上传地址"与"上传失败"是两种不同的下一步,不该合成一句话)。
 */
export type UploadOutcome = string | null;

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
  /** 本次结算新开锁的 UNLOCKS 下标(增量);空数组 = 没有新解锁,「解锁 XX」区块整个不显示 */
  newUnlocks: number[];
  /** 结算后的元进度(sim/progress.ts):解锁掩码 + 计数器,图鉴读它 */
  progressStats: Progress;
  /**
   * 武器战报(本局逐塔型累计实际伤害,main.ts 从 world.runDamageByType 摘好、
   * 只带 damage > 0 的型、按伤害降序)。空数组 = 整块战报不显示(一炮没开的局没有战报)。
   */
  weaponReport: { type: number; damage: number }[];
  /** 本局峰值总 DPS(world.peakDps);战报标题行印它 */
  peakDps: number;
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
      return '船体 HP 归零 —— 这一局的账,都记在战报里';
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

export interface WeaponReportRow {
  /** 塔名(presenter 的 towerName 查翻译;型越界 → 本地化错误,与 resultTitle 的未知码同一口径) */
  name: string;
  /** 累计伤害(取整 —— 战报是总账,小数位是噪音) */
  damage: number;
  /** 占本局武器总伤害的比例 0..1(条形宽度;总量 0 时全 0) */
  ratio: number;
}

/**
 * 武器战报的显示行。做成纯函数(照 summaryText 的理由):"战报到底显示了什么"
 * 要能在 Node 里数出来 —— 占比算错、除零 NaN 流进条宽,都是要等真人打完一局才看得见的错。
 * 比例分母 = 全武器伤害总和(不是第一名):条形读作"输出占比",加起来是一整局的 100%。
 */
export function weaponReportRows(report: { type: number; damage: number }[]): WeaponReportRow[] {
  let total = 0;
  for (const r of report) total += r.damage > 0 ? r.damage : 0;
  const rows: WeaponReportRow[] = [];
  for (const r of report) {
    const dmg = r.damage > 0 && Number.isFinite(r.damage) ? r.damage : 0;
    rows.push({
      name: towerName(r.type),
      damage: Math.round(dmg),
      ratio: total > 0 ? dmg / total : 0,
    });
  }
  return rows;
}

/** 图鉴分类名(UNLOCK_* → 类别文案);未知 kind 印出码本身,与 resultTitle 的未知结果码同一口径 */
export function collectionCategoryName(kind: number): string {
  switch (kind) {
    case UNLOCK_TOWER:
      return '塔';
    case UNLOCK_ELITE:
      return '敌人';
    case UNLOCK_EDICT:
      return '法令';
    default:
      return `分类 ${kind}`;
  }
}

/** 解锁精英的底敌型名(WAVE_LOCKED_ELITES[type] → enemyName);查不到返回 null */
function eliteBaseName(entry: UnlockEntry): string | null {
  const elite = WAVE_LOCKED_ELITES[entry.type];
  if (elite === undefined) return null;
  return enemyName(elite.kind);
}

/**
 * 图鉴条目显示名:塔/法令走 presenter(towerName / edictName 查翻译)、解锁名走 unlockName;
 * 精英条目把底敌型名带进括号("虫群母巢(冲撞甲虫精英)"),未解锁时玩家也读得到"解锁的是什么"。
 */
export function collectionItemName(entry: UnlockEntry): string {
  switch (entry.kind) {
    case UNLOCK_TOWER:
      return towerName(entry.type);
    case UNLOCK_EDICT:
      return edictName(entry.type);
    case UNLOCK_ELITE: {
      const base = eliteBaseName(entry);
      return base === null ? unlockName(entry) : `${unlockName(entry)}(${base}精英)`;
    }
    default:
      return unlockName(entry);
  }
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
 * @param opts.onTitle 「返回标题」(存档改版)。不传就不摆这个按钮。
 *   补的是流程上的一个死角:玩家模式下 Esc 暂停菜单要求 `!run.paused`,而局终之后
 *   run.paused 恒为真 —— 没有这颗按钮的话,一局打完就只剩"再来一局/再试一局"两条路,
 *   想去改个设置或干脆歇一会儿都得刷新页面。
 * @param opts.onVictoryContinue 胜利局确认战报后的去处。传入时，胜利卡的主按钮不直接重开，
 *   而是进入全屏终幕；失败局仍保留再来一局 / 同种子重试 / 返回标题三条路。
 * @param opts.onUpload 「上传本局日志」的去处(运行日志系统)。不传就不摆这个按钮。
 *   返回 Promise<UploadOutcome>:null = 已上传,非 null = 失败原因(印在按钮上)。
 *   上传中按钮置灰防重入,新一局 show 时状态复位 —— 这一局的上传结果不赖到下一局。
 *   胜利局确认战报进终幕之前,上传按钮照常留着:上传不跟任何一条主流程抢路。
 */
export function createGameOverUi(opts: {
  onRestart: () => void;
  onRetry?: () => void;
  onTitle?: () => void;
  onVictoryContinue?: () => void;
  onUpload?: () => Promise<UploadOutcome>;
}): GameOverUi {
  const root = document.createElement('div');
  root.style.cssText = ROOT_CSS;
  const card = document.createElement('div');
  card.style.cssText = CARD_CSS;
  const titleEl = document.createElement('div');
  titleEl.style.cssText = TITLE_CSS;
  const noteEl = document.createElement('div');
  noteEl.style.cssText = NOTE_CSS;
  const statsEl = document.createElement('div');
  statsEl.style.cssText = STATS_CSS;
  // 武器战报:一炮没开的局(weaponReport 空)整块隐藏,由 renderWeaponReport 决定露不露脸
  const reportEl = document.createElement('div');
  reportEl.style.cssText = REPORT_CSS;
  reportEl.style.display = 'none';
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
  // 键位写在按钮上:结算界面没有别的地方能提示"Enter 也行",而重开是这里唯一的动作。
  btn.textContent = '再来一局(Enter)';
  // 「再试这一局」摆在「再来一局」下面:换种子重开仍是主动作(同一份怪潮打第二遍没什么可玩的),
  // 同 seed 重试是"这一局我想再练一次"的次动作 —— 顺序即优先级。
  // 起手由种子派生(随机开局),同 seed 重试连起手一起原样重来,标签上写明,免得和"再来一局"的区别只剩一个括号
  const retryBtn = document.createElement('button');
  retryBtn.style.cssText = BTN_CSS + 'margin-top:8px;';
  retryBtn.textContent = '再试这一局(R · 同种子同起手)';
  // 「返回标题」排在最后、且用暗色:局终之后玩家八成想马上再开一局,
  // 回标题是那条"我先歇会儿 / 去改个设置"的次要出口,不该跟重开抢眼
  const titleBtn = document.createElement('button');
  titleBtn.style.cssText = BTN_CSS + `margin-top:8px;color:${IDLE_COLOR};`;
  titleBtn.textContent = '返回标题';
  // 「上传本局日志」垫底:它是遥测出口,不是玩法出口,颜色与「返回标题」同一档暗色。
  // 状态三态:待传 → 上传中…(置灰)→ 已上传 / 失败原因(见 upload)
  const uploadBtn = document.createElement('button');
  uploadBtn.style.cssText = BTN_CSS + `margin-top:8px;color:${IDLE_COLOR};`;
  uploadBtn.textContent = '上传本局日志(U)';
  card.append(titleEl, noteEl, statsEl, reportEl, unlockEl, collectionEl, btn);
  if (opts.onRetry) card.appendChild(retryBtn);
  if (opts.onTitle) card.appendChild(titleBtn);
  if (opts.onUpload) card.appendChild(uploadBtn);
  root.appendChild(card);
  document.getElementById('ui')!.appendChild(root);

  // 可见性自己记一份,不去读 style.display 反解:Enter 的守卫读的就是它,
  // 而"面板收着的时候按 Enter 不该重开"是这道守卫唯一的职责
  let visible = false;
  /** 最近一次 show 的结果码:胜利 + 有终幕钩子时,主动作从“重开”切成“确认战报” */
  let shownResult = RESULT_LOSE;
  /** 上传进行中(置灰防重入:onUpload 是异步的,双击会发两遍同一份负载) */
  let uploadBusy = false;

  function continuesToEpilogue(): boolean {
    return shownResult === RESULT_WIN && opts.onVictoryContinue !== undefined;
  }

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

  function primaryAction(): void {
    if (!continuesToEpilogue()) {
      restart();
      return;
    }
    hide();
    opts.onVictoryContinue?.();
  }

  function retry(): void {
    // 与 restart 同口径:先收面板再回调,理由一字同源
    hide();
    opts.onRetry?.();
  }

  function toTitle(): void {
    // 与 restart / retry 同口径:先收面板再回调
    hide();
    opts.onTitle?.();
  }

  /**
   * 上传本局日志。三态都写在同一颗按钮上(待传 → 上传中… → 结果),不另开状态区:
   * 它是遥测出口,不值得占结算卡一整块版面。置灰防重入的理由见 uploadBusy 的注释;
   * 结果直接印失败原因(null = 「已上传」)—— 玩家知道下一步该去配端点还是检查网络。
   */
  async function upload(): Promise<void> {
    if (uploadBusy || opts.onUpload === undefined) return;
    uploadBusy = true;
    uploadBtn.disabled = true;
    uploadBtn.textContent = '上传中…';
    const outcome = await opts.onUpload();
    uploadBusy = false;
    uploadBtn.disabled = false;
    uploadBtn.textContent = outcome === null ? '已上传' : outcome;
  }

  /**
   * 刷新武器战报:行内容全走 weaponReportRows(纯函数,那边测),这里只摆 DOM。
   * 一局一次的重建(replaceChildren + 现建行节点),照 renderCollection 的先例 ——
   * 铁律 3 管的是热路径,结算一局只弹一次。
   */
  function renderWeaponReport(s: RunSummary): void {
    if (s.weaponReport.length === 0) {
      reportEl.replaceChildren();
      reportEl.style.display = 'none';
      return;
    }
    reportEl.replaceChildren();
    const title = document.createElement('div');
    title.style.cssText = REPORT_TITLE_CSS;
    title.textContent = `武器战报 · 峰值 ${Math.round(s.peakDps > 0 ? s.peakDps : 0)} DPS`;
    reportEl.appendChild(title);
    for (const row of weaponReportRows(s.weaponReport)) {
      const line = document.createElement('div');
      line.style.cssText = REPORT_ROW_CSS;
      const name = document.createElement('span');
      name.textContent = row.name;
      const track = document.createElement('div');
      track.style.cssText = REPORT_TRACK_CSS;
      const fill = document.createElement('div');
      fill.style.cssText = REPORT_FILL_CSS;
      fill.style.width = `${Math.round(row.ratio * 100)}%`;
      track.appendChild(fill);
      const value = document.createElement('span');
      value.textContent = String(row.damage);
      line.append(name, track, value);
      reportEl.appendChild(line);
    }
    reportEl.style.display = 'block';
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
      // 名字走 unlockName(查 content.unlocks 翻译) —— 与局内 toast 同源,结算页报的与局内弹的是同一句
      lines.push(`解锁:${UNLOCKS[i] === undefined ? `#${i}` : unlockName(UNLOCKS[i]!)}`);
    }
    unlockEl.textContent = lines.join('\n');
    unlockEl.style.display = 'block';
  }

  /** 刷新图鉴:塔 → 敌人 → 法令三栏列内容解锁项(已解锁彩色、未解锁灰显 + 标注) */
  function renderCollection(s: RunSummary): void {
    const mask = s.progressStats.unlockMask;
    const content: Array<{ index: number; entry: UnlockEntry }> = [];
    for (let i = 0; i < UNLOCKS.length; i++) {
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
  }

  btn.addEventListener('click', primaryAction);
  retryBtn.addEventListener('click', retry);
  titleBtn.addEventListener('click', toTitle);
  uploadBtn.addEventListener('click', () => {
    void upload();
  });

  window.addEventListener('keydown', (e) => {
    // 收着的时候一律不认:战斗中按 Enter/R 不该把正打着的一局重开掉
    if (!visible || e.repeat || isTyping()) return;
    // R = 同 seed 重试(与放置阶段的旋转键无冲突:结算界面弹出时升级流程必然收着)
    if (!continuesToEpilogue() && opts.onRetry && e.code === 'KeyR') {
      e.preventDefault();
      retry();
      return;
    }
    // U = 上传本局日志(未传 onUpload 时没有这颗按钮,按键同样不认)
    if (opts.onUpload !== undefined && e.code === 'KeyU') {
      e.preventDefault();
      void upload();
      return;
    }
    if (e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
    // **必须挡掉默认行为**:按钮刚被点过时它是带着焦点的,而 Enter 对一个聚焦的 button
    // 默认会再派一次 click —— 那就是一次按键重开两局(第二局立刻被第三局顶掉,
    // 玩家只会看到"重开之后局数莫名其妙跳了")
    e.preventDefault();
    primaryAction();
  });

  return {
    show(s: RunSummary): void {
      shownResult = s.result;
      titleEl.textContent = resultTitle(s.result);
      // 整块面板只有这几个字用暖色(GDD §12);胜利则是我方冷色域
      titleEl.style.color = s.result === RESULT_LOSE ? LOSE_COLOR : OK_COLOR;
      noteEl.textContent = resultNote(s.result);
      statsEl.textContent = summaryText(s);
      renderWeaponReport(s);
      renderUnlocks(s);
      renderCollection(s);
      // 胜利时先让玩家确认完整战报，再进故事终幕；终幕本身点击后回主菜单，
      // 所以这张卡不再同时摆重试/回标题三条岔路。失败流程保持原样。
      const epilogueNext = continuesToEpilogue();
      btn.textContent = epilogueNext ? '确认战报 · 查看航行结局(Enter)' : '再来一局(Enter)';
      retryBtn.style.display = epilogueNext ? 'none' : 'block';
      titleBtn.style.display = epilogueNext ? 'none' : 'block';
      // 上传状态属于"上一局的那一次 show":新一局复位回待传 —— 已上传/失败那句不许赖到下一局
      uploadBusy = false;
      uploadBtn.disabled = false;
      uploadBtn.textContent = '上传本局日志(U)';
      visible = true;
      root.style.display = 'flex';
    },
    hide,
  };
}
