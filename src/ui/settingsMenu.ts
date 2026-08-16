/**
 * 设置页 —— DOM 覆盖层,永不 import pixi(与暂停/结算界面同一条铁律 1 边界)。
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
import { t } from '../i18n';
import type { LanguagePreference } from '../i18n';
import { createSettings, nextLanguage, nextShake, type Settings } from './settings';
import { shakeText, volumeText } from './presentation/settingsText';

const OK_COLOR = '#9adcff';
const IDLE_COLOR = '#5f7a99';
const VALUE_COLOR = '#c8dcf0';
const LINE_COLOR = '#2b4a6e';
/** 语言切换失败的可读错误:整页唯一的暖色留给唯一一种"这步没成功"的情况 */
const WARN_COLOR = '#ffb066';

/** 满屏遮罩,与暂停/结算界面同款(铺满吃下全部 pointer-events) */
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

/** 语言切换失败的报错行:红橙色小字,嵌在语言行正下方,平时隐藏 */
const ERROR_CSS = `color:${WARN_COLOR};font-size:11px;margin-top:-4px;text-align:center;`;

/** 音量每点一次走 10%:够细(10 档)又够快(一路点到底 10 下) */
const VOLUME_STEP = 0.1;

/** 四行"标签 + 切换按钮"的标签 key:编译期可枚尽,addToggleRow 才敢把 string 喂给 t() */
type SettingsRowKey =
  | 'ui:settings.sound'
  | 'ui:settings.shake'
  | 'ui:settings.damageNumbers'
  | 'ui:settings.hitstop';

export interface SettingsMenuHooks {
  /** 当前设置(main 持有唯一那一份;设置页不自己存,每次 show 现读) */
  get(): Settings;
  /** 改了一项。main 负责落盘 + 分发到各落点(applySettings),本页只管画 */
  onChange(next: Settings): void;
  /**
   * 改语言。main 负责异步切换 + 落盘 + 全 UI 重刷,本页只管把"想换成什么"说出去:
   * 切成功与否由 main 决定 —— 失败时它调本页的 showLocaleError,绝不把一个
   * 没生效的值存进设置(见 main.ts 的 setLanguage)。
   */
  onLanguage(next: LanguagePreference): void;
  /** 关掉了(返回按钮 / Esc)。回哪去由调用方记 —— 标题界面来的回标题,暂停菜单来的回暂停 */
  onClose(): void;
}

export interface SettingsMenuUi {
  show(): void;
  hide(): void;
  visible(): boolean;
  /** 语言切换成功后由 main 统一触发:只重画文案,不碰业务状态 */
  refreshLocale(): void;
  /** 语言切换失败:给出可读错误。main 只调它,不落盘 */
  showLocaleError(message: string): void;
}

export function createSettingsMenu(hooks: SettingsMenuHooks): SettingsMenuUi {
  let visible = false;

  const root = document.createElement('div');
  root.style.cssText = ROOT_CSS;
  root.className = 'sw-overlay sw-settings-overlay';
  const card = document.createElement('div');
  card.style.cssText = CARD_CSS;
  card.className = 'sw-modal sw-settings-card';
  const title = document.createElement('div');
  title.style.cssText = TITLE_CSS;
  title.textContent = t('ui:settings.title');
  card.appendChild(title);

  /** 改一项:就地取一份新设置交给 main,再照 main 那一份重画(**不信自己算出来的值**) */
  function patch(part: Partial<Settings>): void {
    hooks.onChange({ ...hooks.get(), ...part });
    paint();
  }

  /** 一行"标题 + 单颗切换按钮"(声音/飘字/顿帧/震屏都是这个形状)。返回标签与按钮,供 paint 重画 */
  function addToggleRow(
    labelKey: SettingsRowKey,
    action: string,
    onClick: () => void,
  ): { name: HTMLElement; btn: HTMLButtonElement } {
    const row = document.createElement('div');
    row.style.cssText = ROW_CSS;
    row.className = 'sw-settings-row';
    const name = document.createElement('div');
    name.style.cssText = LABEL_CSS;
    name.className = 'sw-settings-label';
    name.textContent = t(labelKey);
    const btn = document.createElement('button');
    btn.style.cssText = BTN_CSS;
    btn.dataset.action = action;
    btn.addEventListener('click', onClick);
    row.append(name, btn);
    card.appendChild(row);
    return { name, btn };
  }

  // —— 主音量:− / 读数 / + ——
  const volRow = document.createElement('div');
  volRow.style.cssText = ROW_CSS;
  volRow.className = 'sw-settings-row';
  const volName = document.createElement('div');
  volName.style.cssText = LABEL_CSS;
  volName.className = 'sw-settings-label';
  volName.textContent = t('ui:settings.volume');
  const volCtrl = document.createElement('div');
  volCtrl.style.cssText = CTRL_CSS;
  volCtrl.className = 'sw-settings-control';
  const volDown = document.createElement('button');
  volDown.style.cssText = STEP_CSS;
  volDown.dataset.action = 'settings-volume-down';
  volDown.textContent = '−';
  volDown.addEventListener('click', () => {
    patch({ masterVolume: hooks.get().masterVolume - VOLUME_STEP });
  });
  const volRead = document.createElement('span');
  volRead.style.cssText = READOUT_CSS;
  const volUp = document.createElement('button');
  volUp.style.cssText = STEP_CSS;
  volUp.dataset.action = 'settings-volume-up';
  volUp.textContent = '+';
  volUp.addEventListener('click', () => {
    patch({ masterVolume: hooks.get().masterVolume + VOLUME_STEP });
  });
  volCtrl.append(volDown, volRead, volUp);
  volRow.append(volName, volCtrl);
  card.appendChild(volRow);

  const mute = addToggleRow('ui:settings.sound', 'settings-mute', () => {
    patch({ muted: !hooks.get().muted });
  });
  const shake = addToggleRow('ui:settings.shake', 'settings-shake', () => {
    patch({ shake: nextShake(hooks.get().shake) });
  });
  const dmg = addToggleRow('ui:settings.damageNumbers', 'settings-damage-numbers', () => {
    patch({ damageNumbers: !hooks.get().damageNumbers });
  });
  const hitstop = addToggleRow('ui:settings.hitstop', 'settings-hitstop', () => {
    patch({ hitstop: !hooks.get().hitstop });
  });

  // —— 语言:单颗循环按钮(自动 → 简体中文 → English)。与音量/震屏同一种"点一下走一档"
  // 的形状,不碰会吃方向键的原生 select —— 键盘是战斗输入,方向键必须留给战斗。
  // 走 onLanguage 而不是 onChange:切换是异步的(要加载语言包),由 main 决定成不成
  const langRow = document.createElement('div');
  langRow.style.cssText = ROW_CSS;
  langRow.className = 'sw-settings-row';
  const langName = document.createElement('div');
  langName.style.cssText = LABEL_CSS;
  langName.className = 'sw-settings-label';
  const langBtn = document.createElement('button');
  langBtn.style.cssText = BTN_CSS;
  langBtn.dataset.action = 'settings-language';
  langBtn.addEventListener('click', () => {
    hooks.onLanguage(nextLanguage(hooks.get().language));
  });
  langRow.append(langName, langBtn);
  card.appendChild(langRow);

  // auto 档的说明小字:只有语言真在 auto 档时才出现,免得每行底下都挂一行提示
  const langHint = document.createElement('div');
  langHint.style.cssText = HINT_CSS;
  card.appendChild(langHint);

  // 切换失败的报错行:平时隐藏,main 调 showLocaleError 才亮出来
  const langError = document.createElement('div');
  langError.style.cssText = ERROR_CSS;
  card.appendChild(langError);

  const backBtn = document.createElement('button');
  backBtn.style.cssText = WIDE_BTN_CSS;
  backBtn.dataset.action = 'settings-back';
  backBtn.addEventListener('click', close);

  const resetBtn = document.createElement('button');
  resetBtn.style.cssText = RESET_CSS;
  resetBtn.dataset.action = 'settings-reset';
  resetBtn.addEventListener('click', () => {
    // 恢复默认 = 五项全回出厂。但语言那项不能走 onChange 直接落盘:
    // 切换是异步的、且只有切成功才该持久化(见 main.ts 的 setLanguage 口径)——
    // 于是这里**先把当前语言扣住**经 onChange 落盘的只是其余四项,
    // 若语言确实要变,单独走 onLanguage,由 main 决定成不成、要不要存
    const next = createSettings();
    hooks.onChange({ ...hooks.get(), ...next, language: hooks.get().language });
    if (hooks.get().language !== next.language) hooks.onLanguage(next.language);
    paint();
  });

  const hint = document.createElement('div');
  hint.style.cssText = HINT_CSS;
  hint.textContent = t('ui:settings.instantSaveHint');

  card.append(backBtn, resetBtn, hint);
  root.appendChild(card);
  document.getElementById('ui')!.appendChild(root);

  /** 上一次语言切换失败的可读错误。**每次 show 复位**:那是那一次的结论,不该留到下次打开 */
  let localeError: string | null = null;

  /**
   * 语言行(唯一一行有"自称"的行)。self 名固定:简体中文 / English 不随语言翻,
   * 「自动」随语言翻(Auto),auto 档额外挂一句解释。
   */
  function paintLanguage(): void {
    const pref = hooks.get().language;
    langName.textContent = t('ui:settings.language');
    langBtn.textContent = pref === 'auto' ? t('ui:language.auto') : pref === 'zh-CN' ? '简体中文' : 'English';
    langHint.textContent = pref === 'auto' ? t('ui:language.autoSystem') : '';
    langError.textContent = localeError ?? '';
    langError.style.display = localeError === null ? 'none' : 'block';
  }

  /**
   * 照 main 那一份设置重画全部读数与文案。**只读不算**:显示的就是真正生效的那一份。
   * 语言切换成功后(paintLanguage)与迁移后的整页文案一起走这里 ——
   * 只改 textContent,不动 visible / 任何业务状态。
   */
  function paint(): void {
    const s = hooks.get();
    title.textContent = t('ui:settings.title');
    volName.textContent = t('ui:settings.volume');
    volRead.textContent = volumeText(s.masterVolume);
    mute.name.textContent = t('ui:settings.sound');
    mute.btn.textContent = s.muted ? t('common:off') : t('common:on');
    shake.name.textContent = t('ui:settings.shake');
    shake.btn.textContent = shakeText(s.shake);
    dmg.name.textContent = t('ui:settings.damageNumbers');
    dmg.btn.textContent = s.damageNumbers ? t('common:on') : t('common:off');
    hitstop.name.textContent = t('ui:settings.hitstop');
    hitstop.btn.textContent = s.hitstop ? t('common:on') : t('common:off');
    // 键位 token(Esc)与动作文本分开:键名从 common.keys 取,句子整体由翻译决定
    backBtn.textContent = t('ui:settings.back', { esc: t('common:keys.esc') });
    resetBtn.textContent = t('ui:settings.reset');
    hint.textContent = t('ui:settings.instantSaveHint');
    // 静音时把音量读数压暗:调了半天音量却没声音是设置页最常见的一次迷惑
    volRead.style.color = s.muted ? IDLE_COLOR : VALUE_COLOR;
    paintLanguage();
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
      localeError = null; // 上一次切换失败的结论不留到这次打开(与暂停菜单同一条口径)
      paint();
      visible = true;
      root.style.display = 'flex';
    },
    hide,
    visible: () => visible,
    // 语言切换成功后 main 触发:整页文案跟着语言重刷(paint 会顺带重画语言行)。
    // 只重画,不注册监听器、不动 visible 等业务状态
    refreshLocale: paint,
    showLocaleError(message: string): void {
      localeError = message;
      paintLanguage();
    },
  };
}
