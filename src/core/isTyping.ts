/**
 * 「焦点在输入框里」的判定 —— 键盘快捷键的公共拦网。
 * 各处 DOM 覆盖层(升级/结算/起手/暂停/设置/标题/武器布局)都要在"用户正在输入"时让开按键,
 * 免得 Enter 被当成重开、数字键被当成选卡;core/input 的 preventDefault 也要让开
 * (否则调参面板的文本框打不出空格、Tab 切不动焦点)。判据必须全仓同口径,
 * 故收成共享模块而不是各抄一份(gameOver.ts 当初注释过"为两行 DOM 判断单开一个共享模块
 * 不值得",那时只有两处;第三次出现就值了;二轮审查后连 core/input 也要用,故从 ui/ 上移到 core/)。
 * 只在浏览器运行(读 document.activeElement),永不 import pixi。
 */
export function isTyping(): boolean {
  // Node 单测环境没有 document(core/input.test 用 fake window):没有输入框可言
  if (typeof document === 'undefined') return false;
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}
