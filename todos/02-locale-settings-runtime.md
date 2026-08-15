# 02 · 语言设置、自动识别与运行时切换

- 优先级：P0 — 基础设施有了以后必须能让玩家实际选择语言
- 依赖：01
- 涉及：`ui/settings.ts`、`ui/settingsStorage.ts`、`ui/settingsMenu.ts`、`main.ts`、`index.html`

## 背景

现有设置只有音量和表现项，由 `main.ts` 持有唯一真相源，并在标题与暂停两个入口共用同一设置页。
语言也应沿用这套结构。项目所有 UI 都只创建一次，因此切换语言不能靠销毁重建页面，否则会重复注册
window 监听器，破坏既有生命周期纪律。

## 任务

- [ ] 在 `Settings` 增加 `language: 'auto' | 'zh-CN' | 'en'`。
- [ ] `createSettings()` 默认 `auto`；`normalizeSettings()` 对老设置缺字段、非法字符串逐项回落到 `auto`。
- [ ] 保持现有设置存储兼容：老 `starwreck.settings.v1` 能直接读取，不清空音量、静音和表现设置。
- [ ] 在 `src/i18n/locale.ts` 实现语言解析：
      - 显式 `zh-CN` / `en` 直接使用
      - `auto` 按 `navigator.languages` 顺序寻找支持语言
      - `zh`、`zh-Hans`、`zh-SG` 等简体中文兼容项映射为 `zh-CN`
      - `en-*` 映射为 `en`
      - 无匹配时回落 `zh-CN`
      - Node/测试环境没有 navigator 时也能工作
- [ ] 调整启动顺序：`loadSettings → resolveLocale → await initI18n → 创建 Renderer/UI`，避免首屏先闪中文再变英文。
- [ ] 每次语言生效时同步：
      - `document.documentElement.lang`
      - `document.documentElement.dir`（当前两种语言均为 `ltr`，先把接口留好）
      - `document.title`
- [ ] 设置页增加语言行，按钮循环“自动 → 简体中文 → English → 自动”，或使用三颗等权按钮；不得使用会吃方向键的原生 select/range。
- [ ] 建立 `LocaleAware` UI 注册表。语言切换成功后由 `main.ts` 统一调用所有已创建 UI 的 `refreshLocale()`。
- [ ] `refreshLocale()` 只重画文案与 locale 格式，不注册监听器、不改变 visible/paused/confirming/pendingBuy/filter 等业务状态。
- [ ] 语言资源加载失败时：保留当前语言、设置页给出可读错误，不把设置持久化成一个没有生效的值。
- [ ] 给 locale 解析、老设置兼容、切换失败与成功路径补单测。

## 验收标准

- [ ] 浏览器偏好英文且设置为自动时，第一次可见 UI 就是英文。
- [ ] 显式选择中文/英文优先于系统语言，刷新页面后保持。
- [ ] 从标题页和暂停页进入设置，看到的是同一个语言状态。
- [ ] 战斗暂停时切换语言，返回后世界仍暂停，本局 checksum、rng、血量、货架和候选不变。
- [ ] 连续切换语言不会出现一次按键触发多次、按钮回调重复、遮罩叠加等监听器泄漏。
- [ ] `html lang` 与页面标题跟随当前语言。

## 口径说明与交接

- `language` 是表现设置，不进 runSave、progress、runLog 或 checksum。
- 切换语言不要求重启本局，也不允许用 `location.reload()` 逃避 UI 刷新。
- `auto` 保存的是偏好值，不保存当时解析出的 locale；系统语言以后变化时，下次启动应重新解析。
