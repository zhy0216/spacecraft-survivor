/**
 * 暂停菜单(玩家模式)—— DOM 覆盖层,永不 import pixi(铁律 1 的另一半)。
 *
 * 玩家模式(无调试面板)下,战斗中的暂停/重开入口原本只有调参面板里有;本菜单补上:
 * 战斗中按 Esc 时停世界,弹一张「继续 / 再来一局 / 再试一局 / 声音」的菜单。
 * 它与升级/整备/结算共用同一套"run.paused 挡住 advance"的时停口径(见 main.ts),
 * 但**不认识 World、不动 loop** —— 它只把"玩家想暂停/继续/换局"说给 main 听:
 * 暂停/继续的实际动作(run.paused 翻转)由 main 的回调执行,与升级时停一字同源。
 *
 * 与升级/整备流程的 Esc 不冲突的判定:那些流程打开时 run.paused 恒为 true,
 * 而本菜单只在 canPause()(main 传 `() => !run.paused`,即战斗运行中)时响应 Esc ——
 * 时停状态下的 Esc 永远归流程自己(重选/取消),玩家模式才归本菜单。
 */
import { audioBus } from '../render/audio';
import { isTyping } from '../core/isTyping';

const OK_COLOR = '#9adcff';
const IDLE_COLOR = '#5f7a99';
const VALUE_COLOR = '#c8dcf0';
const LINE_COLOR = '#2b4a6e';

/** 满屏遮罩,与结算/起手界面同款:铺满吃下全部 pointer-events,菜单期间点不到战场 */
const ROOT_CSS =
  'position:fixed;inset:0;display:none;align-items:center;justify-content:center;' +
  'background:rgba(5,7,13,.82);' +
  'font:13px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;user-select:none;';

const CARD_CSS =
  'min-width:240px;padding:22px 28px;border-radius:10px;' +
  `background:rgba(10,16,26,.94);border:1px solid ${LINE_COLOR};text-align:center;`;

const TITLE_CSS = `color:${OK_COLOR};font-size:20px;letter-spacing:.22em;margin-bottom:14px;`;

const BTN_CSS =
  'display:block;width:100%;padding:9px 0;border-radius:6px;cursor:pointer;font:inherit;' +
  `border:1px solid ${LINE_COLOR};background:rgba(43,74,110,.28);color:${OK_COLOR};` +
  'letter-spacing:.1em;margin-bottom:8px;';

const MUTE_CSS = BTN_CSS.replace(`color:${OK_COLOR}`, `color:${VALUE_COLOR}`);

const HINT_CSS = `color:${IDLE_COLOR};font-size:11px;margin-top:10px;letter-spacing:.06em;`;

// 键位表(静态、非按钮):键名列右对齐、说明列左对齐,两列拼成一张居中的表
const KEYS_CSS = `font-size:11px;margin:0 0 10px;padding-top:10px;border-top:1px solid ${LINE_COLOR};`;
const KEY_CSS = `color:${VALUE_COLOR};display:inline-block;width:76px;text-align:right;margin-right:10px;letter-spacing:.06em;`;
const KEYDESC_CSS = `color:${IDLE_COLOR};display:inline-block;text-align:left;letter-spacing:.06em;`;

export interface PauseMenuHooks {
  /** 战斗运行中?(main 传 `() => !run.paused`;时停/结算/起手选择时不响应 Esc) */
  canPause(): boolean;
  /** 玩家按了 Esc / 「继续」:main 置 run.paused = true 冻结世界 */
  onPause(): void;
  /** 「继续」:main 置 run.paused = false 恢复战斗 */
  onResume(): void;
  /** 「再来一局」(换种子):main 走 restart —— 弹起手选择,由 main 顺带 hide 本菜单 */
  onRestart(): void;
  /** 「再试一局」(同种子同起手):main 走 retry */
  onRetry(): void;
  /**
   * 别人正占着 Esc 吗(设置页开在本菜单之上时,main 传 `() => settingsMenu.visible()`)。
   * **让路必须是主动的**:两个覆盖层的 keydown 都挂在同一个 window 上,谁先收到取决于
   * 创建顺序 —— 靠 stopPropagation 抢等于把行为押在 main 里两行代码的先后上。
   * 可选:不传 = 没有人抢(既有调用方与单测语义一字不变)。
   */
  blocked?(): boolean;
  /** 「设置」:main 收起本菜单、弹设置页(关掉后由 main 再把本菜单弹回来) */
  onSettings(): void;
  /**
   * 「保存并退出」:main 存一份局内存档、回标题界面。
   * @returns 真的存上了没有(配额耗尽 / 隐私模式会是 false)—— 按钮据此改口,
   *   宁可当场说"保存失败"也不给一个空头承诺(见 ui/runSaveStorage.ts 的口径)
   */
  onSaveAndQuit(): boolean;
  /**
   * 静音开关的单一真相源(二轮审查):get 供上色、set 供点击 —— main 注入 settings.muted
   * 那一份账;不传(单测)退回 audioBus 单例,与旧行为逐字一致。
   */
  muted?: { get(): boolean; set(m: boolean): void };
}

export interface PauseMenuUi {
  show(): void;
  hide(): void;
  visible(): boolean;
}

export function createPauseMenu(hooks: PauseMenuHooks): PauseMenuUi {
  let visible = false;

  const root = document.createElement('div');
  root.style.cssText = ROOT_CSS;

  const card = document.createElement('div');
  card.style.cssText = CARD_CSS;

  const title = document.createElement('div');
  title.style.cssText = TITLE_CSS;
  title.textContent = '已暂停';

  const resumeBtn = document.createElement('button');
  resumeBtn.style.cssText = BTN_CSS;
  resumeBtn.textContent = '继续(Esc)';
  resumeBtn.addEventListener('click', resume);

  const restartBtn = document.createElement('button');
  restartBtn.style.cssText = BTN_CSS;
  restartBtn.textContent = '再来一局(换种子)';
  restartBtn.addEventListener('click', () => {
    hide();
    hooks.onRestart();
  });

  const retryBtn = document.createElement('button');
  retryBtn.style.cssText = BTN_CSS;
  retryBtn.textContent = '再试一局(同种子)';
  retryBtn.addEventListener('click', () => {
    hide();
    hooks.onRetry();
  });

  // 「保存并退出」排在换局两项之前:它是**不丢进度**的那条出口,而重开是丢进度的 ——
  // 相邻两颗按钮一个保住半小时、一个抹掉半小时,先摆保住的那颗
  const saveQuitBtn = document.createElement('button');
  saveQuitBtn.style.cssText = BTN_CSS;
  saveQuitBtn.textContent = '保存并退出到标题';
  saveQuitBtn.addEventListener('click', () => {
    // 存不上就**留在菜单里**并当场改口:此时退出会静默丢掉这一局,
    // 而玩家点这颗按钮的全部意图恰恰是"别丢"(见 onSaveAndQuit 的返回值口径)
    if (hooks.onSaveAndQuit()) return;
    saveQuitBtn.textContent = '保存失败(存储不可用)';
  });

  // 静态键位表:暂停菜单就是"我还能干什么"的求助页,键位放这里最顺(非按钮、不可点)
  const KEY_ROWS: ReadonlyArray<readonly [string, string]> = [
    ['WASD', '航向'],
    ['空格', '加速'],
    ['I', '武器布局'],
    ['按住 Tab', '射界'],
    ['Esc', '暂停'],
  ];
  const keyTable = document.createElement('div');
  keyTable.style.cssText = KEYS_CSS;
  for (const [key, desc] of KEY_ROWS) {
    const row = document.createElement('div');
    const keySpan = document.createElement('span');
    keySpan.style.cssText = KEY_CSS;
    keySpan.textContent = key;
    const descSpan = document.createElement('span');
    descSpan.style.cssText = KEYDESC_CSS;
    descSpan.textContent = desc;
    row.append(keySpan, descSpan);
    keyTable.appendChild(row);
  }

  const settingsBtn = document.createElement('button');
  settingsBtn.style.cssText = BTN_CSS;
  settingsBtn.textContent = '设置';
  settingsBtn.addEventListener('click', () => {
    hooks.onSettings();
  });

  const muteBtn = document.createElement('button');
  muteBtn.style.cssText = MUTE_CSS;
  // 真相源 = hooks(main 注入 settings.muted);缺省退回 audioBus(单测旧口径)
  function paintMute(): void {
    muteBtn.textContent = (hooks.muted ? hooks.muted.get() : audioBus.isMuted()) ? '声音:关' : '声音:开';
  }
  muteBtn.addEventListener('click', () => {
    if (hooks.muted) {
      hooks.muted.set(!hooks.muted.get());
    } else {
      audioBus.setMuted(!audioBus.isMuted());
    }
    paintMute();
  });
  paintMute();

  const hint = document.createElement('div');
  hint.style.cssText = HINT_CSS;
  hint.textContent = '战斗中按 Esc 随时暂停';

  card.append(
    title,
    resumeBtn,
    saveQuitBtn,
    restartBtn,
    retryBtn,
    keyTable,
    settingsBtn,
    muteBtn,
    hint,
  );
  root.appendChild(card);
  document.getElementById('ui')!.appendChild(root);

  function pause(): void {
    visible = true;
    root.style.display = 'flex';
    paintMute();
    // 「保存并退出」的文案每次弹出都复位:上一次的"保存失败"是**那一次**的结论,
    // 留着它会让下一次暂停一进来就挂着一句吓人的错误(而此刻可能根本没试过存)
    saveQuitBtn.textContent = '保存并退出到标题';
    hooks.onPause();
  }

  /** 纯收起,不触发 onResume:main 在 restart/retry 时用它关菜单,世界状态由 main 自己定 */
  function hide(): void {
    visible = false;
    root.style.display = 'none';
  }

  function resume(): void {
    if (!visible) return;
    hide();
    hooks.onResume();
  }

  window.addEventListener('keydown', (e) => {
    // 收着的时候一律不认;焦点在输入框里时 Esc 是打字,不该被当成暂停/继续
    if (e.repeat || e.code !== 'Escape' || isTyping()) return;
    // 设置页开在本菜单之上时,这一记 Esc 归它(见 blocked 的注释):
    // 不让路的话"关设置页"会同一次按键把暂停也解掉,玩家直接摔回战斗
    if (hooks.blocked?.()) return;
    if (visible) {
      resume();
      return;
    }
    if (hooks.canPause()) pause();
  });

  return {
    show: pause,
    hide,
    visible: () => visible,
  };
}
