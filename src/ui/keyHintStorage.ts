/**
 * I 键首局提示(28 号)的 localStorage 适配器。与 ui/settingsStorage.ts 同一条边界:
 * 读写存储只发生在这里。只记一件永久事实 —— "玩家按过一次 I"(武器布局面板开过),
 * 首局可发现性提示读它:按过一次就永久不再飘。这是**提示**不是存档:不进 sim、
 * 不进 runSave、不参与 checksum,与局内存档/元进度/设置各用各的键。
 *
 * 兜底口径与设置同向:读不出来就当"没按过"(最坏后果只是提示再飘一次),
 * 写不进去也静默失败 —— 一条提示不值得为它中断任何流程。
 */

/** 存储键。版本号进键名,语义自明:这个键只代表"I 键被人按开过一次" */
const I_KEY_HINT_STORAGE_KEY = 'starwreck.keyhint.i-pressed.v1';

/** 读"是否按过一次 I"。缺失 / 损坏 / 隐私模式一律按没按过算 */
export function loadIPressed(): boolean {
  try {
    return localStorage.getItem(I_KEY_HINT_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** 写"按过一次 I"。配额耗尽 / 隐私模式静默失败 —— 提示丢一条不是损失 */
export function markIPressed(): void {
  try {
    localStorage.setItem(I_KEY_HINT_STORAGE_KEY, '1');
  } catch {
    // 静默失败:见文件头兜底口径
  }
}
