# 10 · i18n 质量门禁、伪语言与布局验收

- 优先级：P0 收口 — 没有自动门禁，后续新增功能会很快重新写回硬编码中文
- 依赖：04–09
- 涉及：测试、脚本、CI、本地调试入口、README/开发约定

## 自动检查

- [ ] 增加资源 key parity 测试：`zh-CN` 与 `en` 的所有 namespace 路径完全一致。
- [ ] 增加 interpolation parity 测试：同一个 key 两种语言使用的变量集合一致；plural key 必须包含 `count`。
- [ ] 增加 empty/duplicate 检查：不允许空翻译、纯 key 值、意外重复 ID。
- [ ] 增加 AST 级玩家文案扫描：
      - `src/ui/`、`main.ts`、玩家可见 presenter 中不允许新增硬编码中文字符串
      - 忽略注释、测试 fixture、`debugPanel.ts` 和明确 allowlist
      - 不能只用简单 rg，因为中文注释很多
- [ ] 增加依赖边界检查：`src/sim/`、`src/data/`、`src/core/` 不得 import `src/i18n/`。
- [ ] 增加确定性回归：同 seed/同输入在 `zh-CN`、`en` 下 checksum 序列一致；capture/restore digest 一致。
- [ ] 增加 storage 回归：语言字段不进入 runSave/progress/runLog，老 settings 数据仍可读。
- [ ] 把专项检查接进 `npm test` 或新增 `npm run test:i18n`，并在 README 写明。

## 伪语言

- [ ] 增加仅开发环境可用的 `en-XA`/pseudo locale，不进入正式语言设置列表。
- [ ] 自动把文本扩张约 30%–40%，保留插值、星号、键位 token 和专名，便于暴露截断与硬编码。
- [ ] 提供 `?locale=pseudo` 或 debug 入口，优先级仅用于开发调试，不写入正式设置。
- [ ] 伪语言下跑标题、HUD、升级、商店、图鉴、结算的 DOM/截图验收。

## 布局与可访问性验收

- [ ] 审计固定 `min-width/max-width/width`、大 `letter-spacing`、`white-space: pre` 和 nowrap。
- [ ] 按桌面、窄屏、高 DPI 检查英文和伪语言：
      - 标题按钮不溢出
      - HUD 标签不覆盖数值
      - 升级三卡与跳过按钮可见
      - 商店 picker 与背包不打架
      - 图鉴滚动区仍可用
      - 结算按钮不被挤出屏幕
- [ ] 动态更新 `lang`/`dir` 后，aria-label、title、img alt 同步刷新。
- [ ] 翻译字符串不进入 `innerHTML`；若仍存在静态 HTML builder，测试保证其中没有翻译值或插值数据。

## 翻译质量

- [ ] 在 `docs/` 或资源旁维护简短术语表，至少覆盖核心玩法名词与大小写规则。
- [ ] 英文通读一次完整流程，不仅做逐字符串机器翻译：标题 → 战斗 → 升级 → 商店 → 图鉴 → 结算 → 终幕。
- [ ] 检查复数、冠词、单位、标点和按钮动词一致性。
- [ ] 中文源资源与迁移前现有文案做 diff，确认没有无意丢句或改变玩法说明。

## 最终验收

- [ ] `npm test` 全绿。
- [ ] `npm run build` 全绿。
- [ ] i18n key、插值、硬编码、边界检查全绿。
- [ ] 伪语言主流程无文本遮挡、不可点击按钮或不可读状态。
- [ ] 开发模式以外的玩家流程不存在裸 key、中文漏翻或 `undefined`。
- [ ] README 补充支持语言、语言设置位置和新增玩家文案的开发规则。

## 口径说明与交接

- 门禁的目标是防回归，不要求翻译代码注释、测试描述和开发调参面板。
- 对确实需要硬编码中文的极少数情况使用带理由的精确 allowlist，禁止整文件/整目录豁免。
