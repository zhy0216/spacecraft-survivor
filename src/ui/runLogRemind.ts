/**
 * 漏存提醒 popover(可永久关闭)—— 一局结束后,玩家要离开结算现场
 * (再来一局 / 再试一局 / 返回标题 / 胜利终幕关闭)而本局日志还没保存时,
 * 弹在一切覆盖层之上的小提示框(独立的一块对话框,不是结算卡里的内联条)。
 *
 * **只建一次、只做 DOM**:main.ts 造一个实例,结算卡与胜利终幕共用它 ——
 * 两边各建一份的话,同时只会亮一块、却要多维护两处文案与两套按钮状态。
 * 玩家在框里有三条路:保存日志(成功即放行原动作)/ 仍要离开(直接放行)/ 取消(哪也不去);
 * 底部「以后不再提醒」写 localStorage 永久关闭,此后 request 一律直接放行。
 * 日志已经保存过(isLogSaved 为真)时,request 同样直接放行 ——
 * 结算卡保存过的局,终幕关闭不会再问一遍。
 *
 * 与原动作的接缝是 request(onLeave):不弹框(已保存/已永久关闭)时立刻执行;
 * 弹了框,就由框里的选择决定 onLeave 何时执行(保存成功 / 仍要离开)。已经弹着时
 * 新的 request 一律忽略 —— Enter 连打不该把同一个动作排队两遍。
 *
 * 与 gameOver.ts 的结算卡同一条配色口径(我方冷色域,见 GDD §12):
 * 遮罩半透明压暗,对话框本体与结算卡同底同边。
 */
import { t } from '../i18n';
import { uploadButtonText, type UploadOutcome } from './gameOver';
import { dismissRunLogRemind, isRunLogRemindDismissed } from './runLogUpload';

const OK_COLOR = '#9adcff';
const IDLE_COLOR = '#5f7a99';
const VALUE_COLOR = '#c8dcf0';
const LINE_COLOR = '#2b4a6e';

/** z-index 是硬要求:结算卡/终幕的覆盖层没有 z-index,晚 append 的会压在早 append 的上面 */
const ROOT_CSS =
  'position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:10;' +
  'background:rgba(5,7,13,.6);' +
  'font:13px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;user-select:none;';
const BOX_CSS =
  'min-width:280px;max-width:min(88vw,400px);padding:18px 22px;border-radius:10px;' +
  `background:rgba(10,16,26,.97);border:1px solid ${LINE_COLOR};text-align:center;`;
const MSG_CSS = `color:${OK_COLOR};margin-bottom:4px;`;
const NOTE_CSS = `color:${IDLE_COLOR};margin-bottom:14px;`;
/** 保存是主建议(动作档配色);仍要离开是次选,同一款按钮但读数档配色 */
const SAVE_BTN_CSS =
  'display:block;width:100%;padding:9px 0;border-radius:6px;cursor:pointer;font:inherit;' +
  `border:1px solid ${LINE_COLOR};background:rgba(43,74,110,.28);color:${OK_COLOR};letter-spacing:.1em;`;
const LEAVE_BTN_CSS = SAVE_BTN_CSS + `margin-top:8px;color:${VALUE_COLOR};`;
/** 底栏:取消与「以后不再提醒」两个小字链接,两端排开 */
const FOOT_CSS = 'display:flex;justify-content:space-between;margin-top:10px;';
const LINK_CSS = `font-size:12px;color:${IDLE_COLOR};cursor:pointer;`;

export interface RunLogRemindUi {
  /**
   * 玩家请求一条离开动作(重开/重试/回标题/终幕关闭)。日志已保存或已永久关闭提醒时
   * **直接执行**;否则弹出提示框,由框里的选择决定 onLeave 何时执行(见文件头)。
   */
  request(onLeave: () => void): void;
  /** 语言切换成功后原地重画文案(与其它 ui 模块同一个 registerLocaleAware 契约) */
  refreshLocale(): void;
}

export function createRunLogRemind(opts: {
  onUpload: () => Promise<UploadOutcome>;
  uploadLocal?: boolean;
  isLogSaved: () => boolean;
}): RunLogRemindUi {
  const root = document.createElement('div');
  root.style.cssText = ROOT_CSS;
  const box = document.createElement('div');
  box.style.cssText = BOX_CSS;
  const msgEl = document.createElement('div');
  msgEl.style.cssText = MSG_CSS;
  const noteEl = document.createElement('div');
  noteEl.style.cssText = NOTE_CSS;
  const saveBtn = document.createElement('button');
  saveBtn.style.cssText = SAVE_BTN_CSS;
  const leaveBtn = document.createElement('button');
  leaveBtn.style.cssText = LEAVE_BTN_CSS;
  const footEl = document.createElement('div');
  footEl.style.cssText = FOOT_CSS;
  const cancelEl = document.createElement('span');
  cancelEl.style.cssText = LINK_CSS;
  const dismissEl = document.createElement('span');
  dismissEl.style.cssText = LINK_CSS;
  footEl.append(cancelEl, dismissEl);
  box.append(msgEl, noteEl, saveBtn, leaveBtn, footEl);
  root.appendChild(box);
  document.getElementById('ui')!.appendChild(root);

  let visible = false;
  /** 弹框时玩家的原动作(重开/重试/回标题):放行时执行,取消时丢弃 */
  let pending: (() => void) | null = null;
  /** 保存按钮三态,与结算卡/终幕的上传按钮同一条口径(见 uploadButtonText) */
  let busy = false;
  let outcome: UploadOutcome | null = null;

  function paint(): void {
    msgEl.textContent = t('ui:remind.message');
    noteEl.textContent = t('ui:remind.note');
    saveBtn.textContent = uploadButtonText({
      uploadLocal: opts.uploadLocal ?? false,
      busy,
      outcome,
    });
    saveBtn.disabled = busy;
    leaveBtn.textContent = t('ui:remind.leaveAnyway');
    cancelEl.textContent = t('ui:remind.cancel');
    dismissEl.textContent = t('ui:remind.dismiss');
  }

  function hide(): void {
    visible = false;
    pending = null;
    root.style.display = 'none';
  }

  /** 放行原动作:先收框再执行(与结算卡"先收面板再回调"同一条口径) */
  function proceed(): void {
    const go = pending;
    hide();
    go?.();
  }

  function request(onLeave: () => void): void {
    // 已保存 / 已永久关闭:提醒纯属噪音,直接放行
    if (opts.isLogSaved() || isRunLogRemindDismissed()) {
      onLeave();
      return;
    }
    // 已经弹着:同一动作再点多少次都不排队(Enter 连打只算一次)
    if (visible) return;
    pending = onLeave;
    busy = false;
    outcome = null;
    paint();
    visible = true;
    root.style.display = 'flex';
  }

  async function save(): Promise<void> {
    if (busy) return;
    busy = true;
    paint();
    const res = await opts.onUpload();
    busy = false;
    // 保存成功:提醒的理由消失,放行原动作;失败:框留着,按钮改口失败原因(可重试)
    if (res.status === 'done') {
      proceed();
      return;
    }
    outcome = res;
    paint();
  }

  function leaveAnyway(): void {
    proceed();
  }

  function cancel(): void {
    hide();
  }

  function dismiss(): void {
    dismissRunLogRemind();
    hide();
  }

  saveBtn.addEventListener('click', () => {
    void save();
  });
  leaveBtn.addEventListener('click', leaveAnyway);
  cancelEl.addEventListener('click', cancel);
  dismissEl.addEventListener('click', dismiss);
  // 点遮罩(而不是框本身)= 取消;e.target === root 才认,框内点击冒泡上来不算
  root.addEventListener('click', (e) => {
    if (e.target === root) cancel();
  });

  paint();

  return {
    request,
    refreshLocale(): void {
      paint();
    },
  };
}
