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
import { isTyping } from './isTyping';

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

  const muteBtn = document.createElement('button');
  muteBtn.style.cssText = MUTE_CSS;
  function paintMute(): void {
    muteBtn.textContent = audioBus.isMuted() ? '声音:关' : '声音:开';
  }
  muteBtn.addEventListener('click', () => {
    audioBus.setMuted(!audioBus.isMuted());
    paintMute();
  });
  paintMute();

  const hint = document.createElement('div');
  hint.style.cssText = HINT_CSS;
  hint.textContent = '战斗中按 Esc 随时暂停';

  card.append(title, resumeBtn, restartBtn, retryBtn, muteBtn, hint);
  root.appendChild(card);
  document.getElementById('ui')!.appendChild(root);

  function pause(): void {
    visible = true;
    root.style.display = 'flex';
    paintMute();
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
