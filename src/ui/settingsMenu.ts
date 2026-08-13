/**
 * 设置页 —— DOM 覆盖层,永不 import pixi(与暂停/结算/起手界面同一条铁律 1 边界)。
 *
 * **整页只建一次、两个入口共用**(标题界面的「设置」与暂停菜单的「设置」):
 * 建两份的话,在暂停菜单里调过的音量回到标题界面就会显示成旧值 —— 两个页面各记各的,
 * 而玩家眼里它们本来就该是同一页。onClose 因此要告诉调用方"从哪来的、该回哪去"由调用方记,
 * 本文件只负责"关掉自己"。
 *
 * 设置项一律做成**按钮循环**而不是滑杆:键盘是战斗输入(方向/加速/Tab 射界),
 * 一个拿到焦点的 range 滑杆会把方向键吃掉,而那种"回到战斗后船不转了"的故障
 * 玩家永远不会联想到自己刚才动过设置。按钮点一下走一档,焦点问题就不存在。
 *
 * 每改一项立刻 onChange:设置页没有「保存」按钮 —— 拨过去就生效、就落盘,
 * 于是不存在"改了没保存"的中间态,也不必为它画一个确认流程。
 */
import { isTyping } from '../core/isTyping';
import {
  createSettings,
  nextShake,
  shakeText,
  volumeText,
  type Settings,
} from './settings';

const OK_COLOR = '#9adcff';
const IDLE_COLOR = '#5f7a99';
const VALUE_COLOR = '#c8dcf0';
const LINE_COLOR = '#2b4a6e';

/** 满屏遮罩,与暂停/结算/起手界面同款(铺满吃下全部 pointer-events) */
const ROOT_CSS =
  'position:fixed;inset:0;display:none;align-items:center;justify-content:center;' +
  'background:rgba(5,7,13,.86);' +
  'font:13px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;user-select:none;';

const CARD_CSS =
  'min-width:340px;max-width:min(94vw,460px);padding:22px 26px;border-radius:10px;' +
  `background:rgba(10,16,26,.94);border:1px solid ${LINE_COLOR};`;

const TITLE_CSS =
  `color:${OK_COLOR};font-size:19px;letter-spacing:.22em;margin-bottom:16px;text-align:center;`;

/** 一行设置:左标题右控件,标题固定宽度对齐 —— 一列读数比参差不齐的行好扫 */
const ROW_CSS =
  'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;';
const LABEL_CSS = `color:${VALUE_COLOR};letter-spacing:.08em;`;
const CTRL_CSS = 'display:flex;align-items:center;gap:6px;';

const BTN_CSS =
  'padding:5px 12px;border-radius:6px;cursor:pointer;font:inherit;' +
  `border:1px solid ${LINE_COLOR};background:rgba(43,74,110,.28);color:${OK_COLOR};` +
  'letter-spacing:.08em;';

/** 音量的 −/+ 两颗小按钮:等宽,免得 +/− 一大一小 */
const STEP_CSS = BTN_CSS.replace('padding:5px 12px', 'padding:5px 0;width:30px;text-align:center');

/** 读数(音量百分比):等宽居中,数字跳动时行不左右晃 */
const READOUT_CSS =
  `color:${VALUE_COLOR};min-width:52px;text-align:center;display:inline-block;`;

const WIDE_BTN_CSS =
  'display:block;width:100%;padding:9px 0;border-radius:6px;cursor:pointer;font:inherit;' +
  `border:1px solid ${LINE_COLOR};background:rgba(43,74,110,.28);color:${OK_COLOR};` +
  'letter-spacing:.1em;margin-top:14px;';

const RESET_CSS = WIDE_BTN_CSS.replace(`color:${OK_COLOR}`, `color:${IDLE_COLOR}`).replace(
  'margin-top:14px',
  'margin-top:6px',
);

const HINT_CSS = `color:${IDLE_COLOR};font-size:11px;margin-top:12px;text-align:center;`;

/** 音量每点一次走 10%:够细(10 档)又够快(一路点到底 10 下) */
const VOLUME_STEP = 0.1;

export interface SettingsMenuHooks {
  /** 当前设置(main 持有唯一那一份;设置页不自己存,每次 show 现读) */
  get(): Settings;
  /** 改了一项。main 负责落盘 + 分发到各落点(applySettings),本页只管画 */
  onChange(next: Settings): void;
  /** 关掉了(返回按钮 / Esc)。回哪去由调用方记 —— 标题界面来的回标题,暂停菜单来的回暂停 */
  onClose(): void;
}

export interface SettingsMenuUi {
  show(): void;
  hide(): void;
  visible(): boolean;
}

export function createSettingsMenu(hooks: SettingsMenuHooks): SettingsMenuUi {
  let visible = false;

  const root = document.createElement('div');
  root.style.cssText = ROOT_CSS;
  const card = document.createElement('div');
  card.style.cssText = CARD_CSS;
  const title = document.createElement('div');
  title.style.cssText = TITLE_CSS;
  title.textContent = '设置';
  card.appendChild(title);

  /** 改一项:就地取一份新设置交给 main,再照 main 那一份重画(**不信自己算出来的值**) */
  function patch(part: Partial<Settings>): void {
    hooks.onChange({ ...hooks.get(), ...part });
    paint();
  }

  /** 一行"标题 + 单颗切换按钮"(声音/飘字/顿帧/震屏都是这个形状) */
  function addToggleRow(label: string, onClick: () => void): HTMLButtonElement {
    const row = document.createElement('div');
    row.style.cssText = ROW_CSS;
    const name = document.createElement('div');
    name.style.cssText = LABEL_CSS;
    name.textContent = label;
    const btn = document.createElement('button');
    btn.style.cssText = BTN_CSS;
    btn.addEventListener('click', onClick);
    row.append(name, btn);
    card.appendChild(row);
    return btn;
  }

  // —— 主音量:− / 读数 / + ——
  const volRow = document.createElement('div');
  volRow.style.cssText = ROW_CSS;
  const volName = document.createElement('div');
  volName.style.cssText = LABEL_CSS;
  volName.textContent = '主音量';
  const volCtrl = document.createElement('div');
  volCtrl.style.cssText = CTRL_CSS;
  const volDown = document.createElement('button');
  volDown.style.cssText = STEP_CSS;
  volDown.textContent = '−';
  volDown.addEventListener('click', () => {
    patch({ masterVolume: hooks.get().masterVolume - VOLUME_STEP });
  });
  const volRead = document.createElement('span');
  volRead.style.cssText = READOUT_CSS;
  const volUp = document.createElement('button');
  volUp.style.cssText = STEP_CSS;
  volUp.textContent = '+';
  volUp.addEventListener('click', () => {
    patch({ masterVolume: hooks.get().masterVolume + VOLUME_STEP });
  });
  volCtrl.append(volDown, volRead, volUp);
  volRow.append(volName, volCtrl);
  card.appendChild(volRow);

  const muteBtn = addToggleRow('声音', () => {
    patch({ muted: !hooks.get().muted });
  });
  const shakeBtn = addToggleRow('画面震动', () => {
    patch({ shake: nextShake(hooks.get().shake) });
  });
  const dmgBtn = addToggleRow('伤害飘字', () => {
    patch({ damageNumbers: !hooks.get().damageNumbers });
  });
  const hitstopBtn = addToggleRow('击杀顿帧', () => {
    patch({ hitstop: !hooks.get().hitstop });
  });

  const backBtn = document.createElement('button');
  backBtn.style.cssText = WIDE_BTN_CSS;
  backBtn.textContent = '返回(Esc)';
  backBtn.addEventListener('click', close);

  const resetBtn = document.createElement('button');
  resetBtn.style.cssText = RESET_CSS;
  resetBtn.textContent = '恢复默认';
  resetBtn.addEventListener('click', () => {
    patch(createSettings());
  });

  const hint = document.createElement('div');
  hint.style.cssText = HINT_CSS;
  hint.textContent = '设置即时生效并自动保存';

  card.append(backBtn, resetBtn, hint);
  root.appendChild(card);
  document.getElementById('ui')!.appendChild(root);

  /** 照 main 那一份设置重画全部读数。**只读不算**:显示的就是真正生效的那一份 */
  function paint(): void {
    const s = hooks.get();
    volRead.textContent = volumeText(s.masterVolume);
    muteBtn.textContent = s.muted ? '关' : '开';
    shakeBtn.textContent = shakeText(s.shake);
    dmgBtn.textContent = s.damageNumbers ? '开' : '关';
    hitstopBtn.textContent = s.hitstop ? '开' : '关';
    // 静音时把音量读数压暗:调了半天音量却没声音是设置页最常见的一次迷惑
    volRead.style.color = s.muted ? IDLE_COLOR : VALUE_COLOR;
  }

  function close(): void {
    if (!visible) return;
    hide();
    hooks.onClose();
  }

  function hide(): void {
    visible = false;
    root.style.display = 'none';
  }

  window.addEventListener('keydown', (e) => {
    if (!visible || e.repeat || isTyping()) return;
    if (e.code !== 'Escape') return;
    // 设置页开着时 Esc 归自己。**让路是对方主动的**:暂停菜单收一个 blocked() 钩子问
    // "设置页开着吗",开着就不响应 Esc(见 pauseMenu.ts)。
    // 这里不用 stopPropagation/stopImmediatePropagation 去抢 —— 两个监听器挂在同一个 window 上,
    // 谁先谁后取决于**创建顺序**,靠事件传播来分胜负等于把行为押在 main 里两行代码的先后上,
    // 哪天调了初始化顺序就会变成"关设置页顺手解了暂停",而那时没人会想到是顺序问题
    e.preventDefault();
    close();
  });

  return {
    show(): void {
      paint();
      visible = true;
      root.style.display = 'flex';
    },
    hide,
    visible: () => visible,
  };
}
