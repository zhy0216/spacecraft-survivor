/**
 * 标题界面 —— 进游戏看到的第一页,DOM 覆盖层,永不 import pixi。
 * 与结算/起手/暂停同一条纪律:**整页只建一次**,来回走 show/hide
 * (每次重建就是每次多挂一份 window 监听器,一次回车能开好几局)。
 *
 * ## 它解决的问题:进来就已经在打了
 *
 * 在此之前页面一载入就直接弹起手配置、选完当场开跑 —— 于是"上一局打到一半关了页面"
 * 与"想改个设置"这两件事都无处安放。标题界面把开跑前的三条路摆在同一屏上:
 * 继续上次航行 / 开一局新的 / 设置。
 *
 * ## 「继续」与「新航行」的不对称
 *
 * 「继续」是**无损**的,点错了大不了再暂停存一次;「新航行」在有存档时是**有损**的 ——
 * 开新局就意味着那份半局存档再也回不来了。两颗按钮的份量不对等,故:
 *   - 有存档时「继续」是主按钮(亮色、Enter 默认落在它上面);
 *   - 「新航行」此时变成**两段式**:点一次先问"确定要放弃存档吗",再点才真的走。
 * 不用浏览器 confirm():那东西会抢走焦点与键盘,而且长得跟游戏一点关系都没有。
 *
 * 纯函数(continueLineText / newRunLabel)全部导出,Node 里直接钉,不装 jsdom ——
 * 与 ui/loadoutFlow.ts 的纯函数同一条测试口径。
 */
import type { RunSaveDigest } from '../sim/runSave';
import { formatDuration, segmentLabel } from './gameOver';
import { isTyping } from './isTyping';

const OK_COLOR = '#9adcff';
const IDLE_COLOR = '#5f7a99';
const VALUE_COLOR = '#c8dcf0';
const LINE_COLOR = '#2b4a6e';
/** 放弃存档的二段确认用暖色:整页唯一的暖色 = 整页唯一有损的一步(GDD §12 敌我色域分离的引申) */
const WARN_COLOR = '#ffb066';

const ROOT_CSS =
  'position:fixed;inset:0;display:none;align-items:center;justify-content:center;' +
  'background:rgba(5,7,13,.9);' +
  'font:13px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;user-select:none;';

const CARD_CSS =
  'min-width:320px;max-width:min(94vw,420px);padding:30px 30px 24px;border-radius:10px;' +
  `background:rgba(10,16,26,.94);border:1px solid ${LINE_COLOR};text-align:center;`;

const TITLE_CSS = `color:${OK_COLOR};font-size:30px;letter-spacing:.3em;margin-bottom:2px;`;
const SUB_CSS = `color:${IDLE_COLOR};font-size:11px;letter-spacing:.24em;margin-bottom:22px;`;

const BTN_CSS =
  'display:block;width:100%;padding:10px 0;border-radius:6px;cursor:pointer;font:inherit;' +
  `border:1px solid ${LINE_COLOR};background:rgba(43,74,110,.28);color:${OK_COLOR};` +
  'letter-spacing:.1em;margin-bottom:8px;';

/** 主按钮(有存档时的「继续」):底色更实,一眼看得出默认走哪条 */
const PRIMARY_CSS = BTN_CSS.replace('background:rgba(43,74,110,.28)', 'background:rgba(43,74,110,.6)');
const QUIET_CSS = BTN_CSS.replace(`color:${OK_COLOR}`, `color:${VALUE_COLOR}`);

/** 存档读数行:压在「继续」按钮下方的一行小字,说清"继续的是什么" */
const SAVE_LINE_CSS = `color:${IDLE_COLOR};font-size:11px;margin:-4px 0 12px;letter-spacing:.04em;`;
const HINT_CSS = `color:${IDLE_COLOR};font-size:11px;margin-top:12px;letter-spacing:.06em;`;

/**
 * 存档摘要那一行小字。**四个读数缺一不可**:航段说明打到哪、时长说明投入了多少、
 * 击杀说明战果、血量说明接手的是什么处境 —— 少了最后一样,玩家会在毫不知情的
 * 情况下接手一艘残血船,而"继续"这个词承诺的是接着打,不是接着送。
 */
export function continueLineText(d: RunSaveDigest): string {
  const seg = segmentLabel(d.segment, d.segmentCount);
  const hp = `${Math.round(d.hp)}/${Math.round(d.maxHp)}`;
  return `航段 ${seg} · ${formatDuration(d.elapsedSec)} · 击杀 ${d.kills} · 船体 ${hp}`;
}

/**
 * 「新航行」按钮的文案。有存档时先问一句 —— 措辞里必须出现"放弃存档",
 * 不能只写"确定?":玩家点第一下时未必意识到代价,而第二下就没有回头路了。
 */
export function newRunLabel(hasSave: boolean, confirming: boolean): string {
  if (!hasSave) return '开始航行';
  return confirming ? '确定?这会放弃存档进度' : '开始新航行';
}

export interface TitleScreenHooks {
  /** 「继续上次航行」:main 读档建世界、接线开跑 */
  onContinue(): void;
  /** 「开始/新航行」:main 走起手配置选择,选完开新局(有存档时已由本页二段确认过) */
  onNewRun(): void;
  /** 「设置」:main 收起本页、弹设置页,关掉后再把本页弹回来 */
  onSettings(): void;
}

export interface TitleScreenUi {
  /** 弹出标题页。@param digest 存档摘要;null = 没有可继续的航行(「继续」整颗不出现) */
  show(digest: RunSaveDigest | null): void;
  hide(): void;
  visible(): boolean;
}

export function createTitleScreen(hooks: TitleScreenHooks): TitleScreenUi {
  let visible = false;
  let hasSave = false;
  /** 「新航行」的二段确认状态。**每次 show 复位**:上一次没点完的确认不该留到下一次 */
  let confirming = false;

  const root = document.createElement('div');
  root.style.cssText = ROOT_CSS;
  const card = document.createElement('div');
  card.style.cssText = CARD_CSS;

  const title = document.createElement('div');
  title.style.cssText = TITLE_CSS;
  title.textContent = 'STARWRECK';
  const sub = document.createElement('div');
  sub.style.cssText = SUB_CSS;
  sub.textContent = '星 骸';

  const continueBtn = document.createElement('button');
  continueBtn.style.cssText = PRIMARY_CSS;
  continueBtn.textContent = '继续上次航行';
  continueBtn.addEventListener('click', () => {
    if (!hasSave) return;
    hide();
    hooks.onContinue();
  });

  const saveLine = document.createElement('div');
  saveLine.style.cssText = SAVE_LINE_CSS;

  const newBtn = document.createElement('button');
  newBtn.style.cssText = BTN_CSS;
  newBtn.addEventListener('click', () => {
    // 没有存档 = 没有代价,直接走;有存档则第一下只是把话问出来
    if (hasSave && !confirming) {
      confirming = true;
      paint();
      return;
    }
    hide();
    hooks.onNewRun();
  });

  const settingsBtn = document.createElement('button');
  settingsBtn.style.cssText = QUIET_CSS;
  settingsBtn.textContent = '设置';
  settingsBtn.addEventListener('click', () => {
    hooks.onSettings();
  });

  const hint = document.createElement('div');
  hint.style.cssText = HINT_CSS;

  card.append(title, sub, continueBtn, saveLine, newBtn, settingsBtn, hint);
  root.appendChild(card);
  document.getElementById('ui')!.appendChild(root);

  let digest: RunSaveDigest | null = null;

  function paint(): void {
    // 没有存档时「继续」与那行读数整个不出现,而不是置灰:一个永远点不动的按钮
    // 只会让新玩家怀疑自己是不是漏了什么前置条件
    continueBtn.style.display = hasSave ? 'block' : 'none';
    saveLine.style.display = hasSave ? 'block' : 'none';
    saveLine.textContent = digest === null ? '' : continueLineText(digest);
    newBtn.textContent = newRunLabel(hasSave, confirming);
    // 整份重设 cssText(而不是单改 color):cssText 赋值会把之前逐属性设的值一并冲掉,
    // 两种写法混用就会变成"确认色改了一次、下次 paint 又被冲回去"这种时灵时不灵的现象。
    // 没有存档时它就是这一页唯一的主按钮,故用 PRIMARY;有存档时主按钮是「继续」
    newBtn.style.cssText =
      (hasSave ? BTN_CSS : PRIMARY_CSS) + (confirming ? `color:${WARN_COLOR};` : '');
    hint.textContent = hasSave ? 'Enter 继续 · Esc 取消确认' : 'Enter 开始';
  }

  function hide(): void {
    visible = false;
    root.style.display = 'none';
  }

  window.addEventListener('keydown', (e) => {
    if (!visible || e.repeat || isTyping()) return;
    if (e.code === 'Escape') {
      // Esc 只撤销"放弃存档"那句问话。**不是关闭标题页** —— 标题页背后没有可以回去的地方
      if (!confirming) return;
      e.preventDefault();
      confirming = false;
      paint();
      return;
    }
    if (e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
    e.preventDefault();
    // Enter 落在**无损**的那条路上:有存档就继续,没存档才开新局 ——
    // 让一次误触的回车永远不会抹掉进度(二段确认的第二下也只认鼠标,不认 Enter)
    hide();
    if (hasSave) hooks.onContinue();
    else hooks.onNewRun();
  });

  return {
    show(next: RunSaveDigest | null): void {
      digest = next;
      hasSave = next !== null;
      confirming = false; // 上一次没点完的确认不留到这一次
      paint();
      visible = true;
      root.style.display = 'flex';
    },
    hide,
    visible: () => visible,
  };
}
