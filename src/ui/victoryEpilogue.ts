/**
 * 胜利终幕 —— 玩家在结算卡确认战报后看到的全屏故事钩子。
 *
 * 它与标题/结算页一样只建一次、只做 DOM 展示，不认识 World。main.ts 决定何时弹出，
 * 玩家点击整张画面（或按 Enter）后，它只把“返回主菜单”这件事交还给 onClose。
 * 生成图不烤字：叙事文本由 DOM 叠上去，既清晰，也能在不重生成美术的情况下继续调文案；
 * 文案走 story:epilogue.*(09 号),语言切换后原地重画,不重播终幕流程。
 *
 * 终幕也是结算现场的一部分:带上 onUpload 时,「下一次航行」提示下面摆一颗
 * 保存/上传日志按钮(与结算卡同一条 upload 流程与同一句三态文案);
 * 关闭终幕走 opts.remind(漏存提醒 popover)的 request —— 日志没保存就先弹框,
 * 由框里的选择决定「返回主菜单」何时执行。
 */
import { isTyping } from '../core/isTyping';
import { t } from '../i18n';
import { uploadButtonText, type UploadOutcome } from './gameOver';

const ART_URL = new URL(
  '../../assets/game/ui/victory-epilogue-nanobanana.webp',
  import.meta.url,
).href;

const ROOT_CSS =
  'position:fixed;inset:0;display:none;overflow:hidden;cursor:pointer;' +
  'background:#030712;color:#d9efff;user-select:none;' +
  'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;';
const ART_CSS =
  'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center;';
const SHADE_CSS =
  'position:absolute;inset:0;pointer-events:none;' +
  'background:linear-gradient(90deg,rgba(3,7,18,.92) 0%,rgba(3,7,18,.68) 30%,rgba(3,7,18,.08) 63%),' +
  'linear-gradient(0deg,rgba(2,5,12,.72) 0%,rgba(2,5,12,0) 48%);';
const STORY_CSS =
  'position:absolute;left:clamp(28px,7vw,132px);bottom:clamp(42px,9vh,116px);' +
  'width:min(570px,82vw);pointer-events:none;text-shadow:0 2px 18px rgba(0,0,0,.9);';
const KICKER_CSS =
  'color:#7fcff2;font-size:clamp(10px,1vw,13px);letter-spacing:.28em;margin-bottom:12px;';
const TITLE_CSS =
  'color:#e6f6ff;font-size:clamp(32px,4.4vw,68px);line-height:1.04;letter-spacing:.08em;' +
  'font-weight:700;margin-bottom:18px;';
const REVEAL_CSS =
  'color:#9adcff;font-size:clamp(16px,1.55vw,24px);line-height:1.55;margin-bottom:12px;';
const BODY_CSS =
  'color:#9bb3c8;font-size:clamp(12px,1.05vw,16px);line-height:1.8;max-width:48ch;margin-bottom:22px;';
const NEXT_CSS =
  'display:inline-block;padding:9px 14px;border:1px solid rgba(127,207,242,.58);' +
  'background:rgba(8,21,35,.62);color:#bde9ff;font-size:clamp(11px,.95vw,14px);' +
  'letter-spacing:.12em;margin-bottom:16px;';
const HINT_CSS = 'color:#627f99;font-size:11px;letter-spacing:.12em;';
/**
 * 保存/上传日志按钮:故事层整体 pointer-events:none(点击整屏 = 关闭),按钮自己
 * pointer-events:auto 接回点击,并在 click 里 stopPropagation —— 点按钮不许顺带关终幕。
 */
const LOG_BTN_CSS =
  'pointer-events:auto;display:inline-block;padding:9px 14px;margin-bottom:16px;cursor:pointer;' +
  'border:1px solid rgba(127,207,242,.58);background:rgba(8,21,35,.62);color:#bde9ff;' +
  'font-size:clamp(11px,.95vw,14px);letter-spacing:.12em;' +
  'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;';

export interface VictoryEpilogueUi {
  show(): void;
  hide(): void;
  visible(): boolean;
  /** 语言切换成功后原地重画叙事文案(09 号):只改文字,不重新 show / 不重置终幕流程 */
  refreshLocale(): void;
}

export function createVictoryEpilogue(opts: {
  onClose: () => void;
  /** 「保存/上传本局日志」的按钮出口(与结算卡同一条流程)。不传就不摆这颗按钮。 */
  onUpload?: () => Promise<UploadOutcome>;
  /** 本机开发环境:按钮改口「保存本局日志」(与结算卡同口径,见 ui/gameOver.ts) */
  uploadLocal?: boolean;
  /** 漏存提醒 popover:关闭终幕先过它的 request,日志没保存就弹框(见 ui/runLogRemind.ts) */
  remind?: { request: (onLeave: () => void) => void };
}): VictoryEpilogueUi {
  let visible = false;

  const root = document.createElement('div');
  root.style.cssText = ROOT_CSS;
  root.className = 'sw-victory-overlay';
  root.tabIndex = 0;
  root.setAttribute('role', 'button');

  const art = document.createElement('img');
  art.style.cssText = ART_CSS;
  art.src = ART_URL;
  art.draggable = false;

  const shade = document.createElement('div');
  shade.style.cssText = SHADE_CSS;

  const story = document.createElement('div');
  story.style.cssText = STORY_CSS;
  story.className = 'sw-victory-story';
  const kicker = document.createElement('div');
  kicker.style.cssText = KICKER_CSS;
  const title = document.createElement('div');
  title.style.cssText = TITLE_CSS;
  title.className = 'sw-victory-title';
  const reveal = document.createElement('div');
  reveal.style.cssText = REVEAL_CSS;
  const body = document.createElement('div');
  body.style.cssText = BODY_CSS;
  body.className = 'sw-victory-body';
  const next = document.createElement('div');
  next.style.cssText = NEXT_CSS;
  const hint = document.createElement('div');
  hint.style.cssText = HINT_CSS;
  const logBtn = document.createElement('button');
  logBtn.style.cssText = LOG_BTN_CSS;
  story.append(kicker, title, reveal, body, next, hint);
  if (opts.onUpload !== undefined) story.appendChild(logBtn);

  root.append(art, shade, story);
  document.getElementById('ui')!.appendChild(root);

  /** 上传按钮状态:与结算卡同一句三态文案(uploadButtonText),busy 置灰防重入 */
  let uploadBusy = false;
  let uploadOutcome: UploadOutcome | null = null;

  /**
   * 叙事文案从 story:epilogue.* 现读(生成图不烤字:中英文都由 DOM 叠上去)。
   * show 与 refreshLocale 共用 —— 语言切过之后,收着时的下次 show 也按当前语言重画。
   */
  function paintText(): void {
    root.setAttribute('aria-label', t('story:epilogue.aria'));
    art.alt = t('story:epilogue.alt');
    kicker.textContent = t('story:epilogue.kicker');
    title.textContent = t('story:epilogue.title');
    reveal.textContent = t('story:epilogue.reveal');
    body.textContent = t('story:epilogue.body');
    next.textContent = t('story:epilogue.next');
    hint.textContent = t('story:epilogue.hint');
  }
  paintText();
  paintLogBtn();

  /** 保存/上传按钮的三态文案(与结算卡/提醒 popover 同一个 uploadButtonText 口径) */
  function paintLogBtn(): void {
    if (opts.onUpload === undefined) return;
    logBtn.disabled = uploadBusy;
    logBtn.textContent = uploadButtonText({
      uploadLocal: opts.uploadLocal ?? false,
      busy: uploadBusy,
      outcome: uploadOutcome,
    });
  }

  async function upload(): Promise<void> {
    if (uploadBusy || opts.onUpload === undefined) return;
    uploadBusy = true;
    paintLogBtn();
    const outcome = await opts.onUpload();
    uploadBusy = false;
    uploadOutcome = outcome;
    paintLogBtn();
  }

  function hide(): void {
    visible = false;
    root.style.display = 'none';
  }

  function close(): void {
    if (!visible) return;
    // 先收终幕再回调,与结算卡同一条口径;漏存提醒(若传入)在动作之前拦一道
    const go = () => {
      hide();
      opts.onClose();
    };
    if (opts.remind === undefined) {
      go();
      return;
    }
    opts.remind.request(go);
  }

  root.addEventListener('click', close);
  logBtn.addEventListener('click', (e) => {
    // 按钮在整屏点击关闭的 root 之内:不拦下冒泡,点一下上传 = 上传 + 顺带关终幕
    e.stopPropagation();
    void upload();
  });
  window.addEventListener('keydown', (e) => {
    if (!visible || e.repeat || isTyping()) return;
    if (e.code !== 'Enter' && e.code !== 'NumpadEnter' && e.code !== 'Space') return;
    e.preventDefault();
    close();
  });

  return {
    show(): void {
      paintText();
      // 上传状态属于"上一局的那一次 show":新一局复位回待传
      uploadBusy = false;
      uploadOutcome = null;
      paintLogBtn();
      visible = true;
      root.style.display = 'block';
      root.focus();
    },
    hide,
    visible: () => visible,
    /**
     * 语言切换成功后原地重画(09 号):只把 kicker/标题/正文/下一航行提示/aria-label/alt
     * 换成当前语言,**不重新 show、不重置流程、不触发 onClose** —— 终幕是一种进行中的状态,
     * 切换语言不能把它重新播一遍。
     */
    refreshLocale(): void {
      paintText();
      paintLogBtn();
    },
  };
}
