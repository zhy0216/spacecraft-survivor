/**
 * 胜利终幕 —— 玩家在结算卡确认战报后看到的全屏故事钩子。
 *
 * 它与标题/结算页一样只建一次、只做 DOM 展示，不认识 World。main.ts 决定何时弹出，
 * 玩家点击整张画面（或按 Enter）后，它只把“返回主菜单”这件事交还给 onClose。
 * 生成图不烤字：中文叙事由 DOM 叠上去，既清晰，也能在不重生成美术的情况下继续调文案。
 */
import { isTyping } from '../core/isTyping';

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

export interface VictoryEpilogueUi {
  show(): void;
  hide(): void;
  visible(): boolean;
}

export function createVictoryEpilogue(opts: { onClose: () => void }): VictoryEpilogueUi {
  let visible = false;

  const root = document.createElement('div');
  root.style.cssText = ROOT_CSS;
  root.tabIndex = 0;
  root.setAttribute('role', 'button');
  root.setAttribute('aria-label', '胜利终幕，点击返回主菜单');

  const art = document.createElement('img');
  art.style.cssText = ART_CSS;
  art.src = ART_URL;
  art.alt = '拼装舰穿过破碎的甲虫 Boss，残骸核心把星图投向更深处的巨大阴影';
  art.draggable = false;

  const shade = document.createElement('div');
  shade.style.cssText = SHADE_CSS;

  const story = document.createElement('div');
  story.style.cssText = STORY_CSS;
  const kicker = document.createElement('div');
  kicker.style.cssText = KICKER_CSS;
  kicker.textContent = '航行记录 · 封锁线之后';
  const title = document.createElement('div');
  title.style.cssText = TITLE_CSS;
  title.textContent = '门后仍有星海';
  const reveal = document.createElement('div');
  reveal.style.cssText = REVEAL_CSS;
  reveal.textContent = '你击穿的不是巢穴，只是守门者。';
  const body = document.createElement('div');
  body.style.cssText = BODY_CSS;
  body.textContent = 'Boss 的残骸里没有王座，只有一枚仍在发亮的坐标。它正把你的航线，指向更深的黑暗。';
  const next = document.createElement('div');
  next.style.cssText = NEXT_CSS;
  next.textContent = '下一次航行 · 追踪信号源';
  const hint = document.createElement('div');
  hint.style.cssText = HINT_CSS;
  hint.textContent = '点击画面 / Enter 返回主菜单';
  story.append(kicker, title, reveal, body, next, hint);

  root.append(art, shade, story);
  document.getElementById('ui')!.appendChild(root);

  function hide(): void {
    visible = false;
    root.style.display = 'none';
  }

  function close(): void {
    if (!visible) return;
    hide();
    opts.onClose();
  }

  root.addEventListener('click', close);
  window.addEventListener('keydown', (e) => {
    if (!visible || e.repeat || isTyping()) return;
    if (e.code !== 'Enter' && e.code !== 'NumpadEnter' && e.code !== 'Space') return;
    e.preventDefault();
    close();
  });

  return {
    show(): void {
      visible = true;
      root.style.display = 'block';
      root.focus();
    },
    hide,
    visible: () => visible,
  };
}
