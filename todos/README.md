# STARWRECK i18n 任务索引

目标：在不改变 sim 确定性、存档格式、运行日志编码和现有 UI 生命周期的前提下，支持
`zh-CN` / `en` 两种玩家语言，并为后续语言扩展留下稳定结构。

## 实施顺序

| 顺序 | 任务 | 依赖 | 结果 |
|---|---|---|---|
| 01 | [i18n 基础设施](done/01-i18n-foundation.md) | — | 类型安全资源、fallback、格式化器、加载器 ✅ |
| 02 | [语言设置与运行时切换](done/02-locale-settings-runtime.md) | 01 | 自动识别、持久化、切换后原地刷新 UI ✅ |
| 03 | [内容 ID 与展示层边界](done/03-content-ids-presentation-boundary.md) | 01 | `data/`、`sim/` 不再持有玩家语言文案 ✅ |
| 04 | [标题与通用菜单](done/04-shell-and-common-ui.md) | 01、02 | 标题、设置、暂停、通用提示双语化 ✅ |
| 05 | [HUD 与舰船背包](done/05-hud-and-armory.md) | 02、03 | 战斗常驻界面双语化 ✅ |
| 06 | [升级流程](done/06-upgrade-flow.md) | 02、03 | 三选一、合成、拒绝原因双语化 ✅ |
| 07 | [整备商店](done/07-refit-shop.md) | 02、03 | 商店、购买、替换流程双语化 ✅ |
| 08 | [图鉴](done/08-codex.md) | 02、03 | 内容资料、解锁条件、效果摘要双语化 ✅ |
| 09 | [结算与胜利终幕](done/09-game-over-and-epilogue.md) | 02、03 | 战报、解锁、结局叙事双语化 ✅ |
| 10 | [质量门禁与布局适配](done/10-i18n-quality-gates.md) | 04–09 | key 完整性、伪语言、无硬编码、布局验收 ✅ |

## 总体口径

- `src/sim/`、存档、checksum、运行日志只认识数值或稳定 ID，不认识 locale，也不 import `src/i18n/`。
- 中文是源语言与最终 fallback；缺英文 key 时显示中文，不显示裸 key。
- 翻译 key 使用稳定语义 ID，不使用中文原文或数组下标作为 key。
- UI 继续遵守“整页只创建一次”：切换语言只改已有节点，不重建 DOM、不重复注册监听器。
- 完整短语进入翻译资源；不要把中文词片段按固定语序拼成句子。
- 玩家文案优先写入 `textContent`。需要多种样式时拆成多个 DOM 节点，不把翻译字符串拼进 `innerHTML`。
- 每个迁移任务同时补齐 `zh-CN` 与 `en`，不留“先接 key、以后再翻”的半成品。
- `debugPanel`、autobalance CLI 和开发注释首轮不要求翻译，但不能被玩家模式引用。

## 完成定义

- 设置页可选择“自动 / 简体中文 / English”，刷新后保持。
- 系统语言为英文时首次进入显示英文；不支持的语言回落到中文。
- 战斗中切换语言不影响本局状态、rng、checksum、存档和输入监听器数量。
- 玩家可见流程从标题到胜利终幕不存在硬编码中文。
- `npm test`、`npm run build` 与 i18n 专项检查全部通过。
