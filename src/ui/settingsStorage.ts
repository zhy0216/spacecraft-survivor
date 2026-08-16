/**
 * 玩家设置的 localStorage 适配器 + **落点分发**。与 ui/progressStorage.ts 同一条边界:
 * 读写存储只发生在这里,ui/settings.ts 一字不碰 DOM/localStorage。
 *
 * 本文件多担一件事:applySettings —— 把一份设置**送到它真正生效的那几个地方**。
 * 做成一个函数而不是散落在各调用点,是因为设置有三个来路(页载、设置页改动、暂停菜单里
 * 的静音按钮),而"改了设置但某一路忘了同步"这种错只会以"重开页面才生效"的形式出现,
 * 玩家多半只会以为自己记错了。一处分发,三条来路都走它。
 *
 * 设置的兜底方向与存档相反:读不出来就用默认(见 settings.ts 的 normalizeSettings),
 * 写不进去也静默失败 —— 音量没记住是小事,不值得为它中断任何流程。
 */
import { audioBus } from '../render/audio';
import type { Renderer } from '../render/renderer';
import { createSettings, parseSettings, serializeSettings, type Settings } from './settings';

/** 设置键。与局内存档/元进度**各用各的键**:清了存档不该顺手把音量调回默认 */
export const SETTINGS_STORAGE_KEY = 'starwreck.settings.v1';

/**
 * 统计面板的设备出厂档:桌面默认开、移动端默认关 —— 移动端统计条占着摇杆上方
 * 的整条下沿,不该默认叠在手指跟前;桌面左上角有的是空位,默认亮着让火力读数
 * 第一次进游戏就看得见。玩家一旦在设置页/P 键做出过选择,存的显式值永远优先。
 * 断点与 index.html 的移动端响应式断点**同一条口径**(窄屏 ≤900px / 粗指针触屏),
 * 改断点必须两边一起改。matchMedia 缺席(测试/非常规环境)按桌面开。
 */
function statsPanelDeviceDefault(): boolean {
  if (typeof window === 'undefined') return true;
  const mq = window.matchMedia?.('(max-width: 900px), (hover: none) and (pointer: coarse)');
  return !mq?.matches;
}

/** 这台机器还没设置过时的那份出厂设置:其余项走纯数据层的 createSettings,统计面板随设备走 */
function freshSettings(): Settings {
  return { ...createSettings(), showStatsPanel: statsPanelDeviceDefault() };
}

/** 存盘里有没有显式的 showStatsPanel 字段(老 v1 设置没有它,见 normalizeSettings 的兜底) */
function hasStatsPanelField(json: string): boolean {
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    return typeof o === 'object' && o !== null && 'showStatsPanel' in o;
  } catch {
    return false;
  }
}

/** 读设置。缺失 / 损坏 / 隐私模式一律给一份出厂设置(那不是错误,是"这台机器还没设置过") */
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw === null) return freshSettings();
    const s = parseSettings(raw);
    // 老档没有 showStatsPanel:那台机器上从没为它做过选择,补设备出厂档而不是硬编码关
    if (!hasStatsPanelField(raw)) return { ...s, showStatsPanel: statsPanelDeviceDefault() };
    return s;
  } catch {
    return freshSettings();
  }
}

/** 写设置。配额耗尽 / 隐私模式静默失败 —— 音量没记住不值得打断任何流程 */
export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, serializeSettings(s));
  } catch {
    // 静默失败:见文件头兜底口径
  }
}

/**
 * 把设置送到各自的落点。**幂等**:同一份设置灌几次结果一样,
 * 于是调用方不必判断"这次改的是哪一项",改完整份重灌即可。
 *
 * renderer 可缺席(undefined):页载时先读设置、再 await Renderer.create,
 * 那一段里音量已经该生效了,而渲染层还不存在 —— 与其让调用方记住"这时候只能调音频",
 * 不如在这里收下一个可选参数,渲染层就位后再整份重灌一次。
 */
export function applySettings(s: Settings, renderer?: Renderer): void {
  // language 不走这条分发:它由 i18n 管线生效(见 settings.ts 的落点注释),
  // 不经过音视频层,漏在这一处反而是对的。
  audioBus.setMasterVolume(s.masterVolume);
  audioBus.setMuted(s.muted);
  renderer?.setEffects(s.shake, s.damageNumbers);
}
