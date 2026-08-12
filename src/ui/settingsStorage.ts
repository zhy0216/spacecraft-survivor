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

/** 读设置。缺失 / 损坏 / 隐私模式一律给一份出厂设置(那不是错误,是"这台机器还没设置过") */
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw === null) return createSettings();
    return parseSettings(raw);
  } catch {
    return createSettings();
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
  audioBus.setMasterVolume(s.masterVolume);
  audioBus.setMuted(s.muted);
  renderer?.setEffects(s.shake, s.damageNumbers);
}
