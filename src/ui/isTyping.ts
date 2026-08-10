/**
 * 「焦点在输入框里」的判定 —— 键盘快捷键的公共拦网。
 * 三处 DOM 覆盖层(升级/结算/起手配置)都要在"用户正在输入数字"时让开按键,免得
 * Enter 被当成重开、数字键被当成选卡;判据必须全仓同口径,故收成共享模块而不是再抄第四份
 * (gameOver.ts 当初注释过"为两行 DOM 判断单开一个共享模块不值得",那时只有两处;第三次出现就值了)。
 * 只在浏览器运行:ui 层铁律,永不 import pixi。
 */
export function isTyping(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}
