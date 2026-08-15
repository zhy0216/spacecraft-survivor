/**
 * LocaleAware UI 注册表:语言切换成功后的重刷调度(02 号)。
 *
 * 全项目 UI 一律**只建一次**,语言切换不能靠销毁重建页面 —— 重建一份就等于多一份
 * window 监听器,一次按键能连开好几页(见 ui/settingsMenu.ts 文件头那条整页只建一次的纪律)。
 * 于是做成"注册表 + 统一重刷":切换成功后由 main 调一次 refreshAllLocaleAware,
 * 每个已注册 UI 各跑一遍自己的 refreshLocale()(只重画文案,不动业务状态)。
 *
 * 用 Set 而非数组:同一 UI 重复注册天然幂等 —— 排掉"注册了两遍 → 一次切换刷两遍"
 * 这类监听器泄漏的镜像事故。当前只有 settingsMenu 注册(语言行的自身标签要走 t());
 * 04-09 号把其余界面的全量文案迁进 t() 时,各自在 main 里注册即可,本模块不再变。
 */
import type { LocaleAware } from './types';

const registered = new Set<LocaleAware>();

/** 注册一个语言切换后需要重刷文案的 UI。幂等:重复注册只算一份。 */
export function registerLocaleAware(ui: LocaleAware): void {
  registered.add(ui);
}

/** 注销。留给将来可能"整页销毁"的场景;现网没有调用方。 */
export function unregisterLocaleAware(ui: LocaleAware): void {
  registered.delete(ui);
}

/** 逐个触发 refreshLocale。**只在语言真正切换成功后调用**(main 的 setLanguage)。 */
export function refreshAllLocaleAware(): void {
  for (const ui of registered) ui.refreshLocale();
}

/** 测试钩子:当前已注册的 UI 数量。 */
export function __localeAwareCount(): number {
  return registered.size;
}
