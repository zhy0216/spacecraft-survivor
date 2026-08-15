# 03 · 内容稳定 ID 与展示层边界

- 优先级：P0 — 不先拆边界，后续每个界面都会继续从中文数据表取名字
- 依赖：01
- 涉及：`data/towers.ts`、`enemies.ts`、`edicts.ts`、`affixes.ts`、`waves.ts`、`unlocks.ts`、`sim/upgrade.ts`、UI presenter

## 背景

武器、敌人、法令、词缀和航段名称当前直接存在数值表中；`edictDesc`、`throttleName` 等展示文本
甚至由 `data/` 生成，`sim/upgrade.optionLabel` 也会返回中文。这样做在单语言下保证了“名称只有一份”，
但多语言后会迫使 data/sim 认识 locale，违背确定性边界。

本任务要保留“身份只有一份”，只是把身份从中文名称改成稳定 ID，玩家名字由展示层查翻译。

## 任务

- [ ] 为内容定义稳定 slug ID，建议示例：
      - tower：`autocannon`、`laser_prism`、`arc_coil`、`railgun`……
      - enemy：`swarm_leech`、`side_raider`、`tail_maggot`……
      - edict：`ammo_protocol`、`coolant_protocol`……
      - affix：`frenzy`、`fission`、`magnetic`……
      - wave segment：`departure_lane`、`debris_belt`……
- [ ] ID 必须与现有数值 `type/kind` 一一对应；增加表级测试钉住唯一性、非空和顺序长度。
- [ ] 从玩家数据定义中移除或停止消费 `name` / `description`。若需分阶段迁移，可暂留 `devName`，但玩家 UI 不得再读取它。
- [ ] 在 `content` namespace 建立所有内容名称与描述的 `zh-CN` / `en` 资源。
- [ ] 新建展示层 presenter，例如 `src/ui/presentation/contentText.ts`：
      - `towerName(type)`
      - `enemyName(kind)`
      - `edictName(type)`
      - `affixName(id)` / `affixDescription(id)`
      - `waveSegmentName(index)`
      - 越界时输出带原始编号的本地化错误文案
- [ ] 把以下展示函数移出 data/sim，放入 `src/ui/presentation/`：
      - `throttleName` / 武器系标签
      - `edictScopeLabel`
      - `edictDesc`
      - `sim/upgrade.optionLabel`
      - 任何只为人类显示的 `behaviorName`、unlock condition 文案
- [ ] `edictDesc` 等动态效果描述读取纯数值，逐项调用翻译 key；数字、百分比、正负号走 `i18n/format.ts`。
- [ ] 动态效果列表的分隔符和顺序由 locale presenter 决定，不在数值表里写 `·`、`/` 或中文单位。
- [ ] `sim/balance`、autobalance 等开发输出改用稳定 ID；如需要人类名称，在 CLI/UI 边界再解析，不让 sim import i18n。
- [ ] 更新依赖中文名称的测试：数据一致性测试断言 ID，展示测试在 presenter 层断言中文/英文。

## 存档与确定性要求

- [ ] 不修改塔型、敌型、法令、解锁位的现有数值编号。
- [ ] runSave 继续保存数值编号，不保存 slug 或翻译名称。
- [ ] runLog 继续保存 `kind/type/act`，上传负载结构版本不因 i18n 改动升级。
- [ ] 同一 World 在不同 locale 下 checksum 完全相同。

## 验收标准

- [ ] `src/data/` 和 `src/sim/` 不 import `src/i18n/`。
- [ ] 玩家 UI 不再直接读取 `TOWERS[type].name`、`EDICTS[type].name` 等字段。
- [ ] 中文与英文下，同一个 type 显示不同名字，但购买、合成、解锁和伤害行为完全一致。
- [ ] 改一个翻译名称只需改资源文件，不改 data/sim 或调用点。
- [ ] 越界内容仍显示可诊断的原始编号，不静默兜底成第 0 种内容。

## 口径说明与交接

- 数值编号仍是存档/模拟身份；slug 是翻译与编辑身份。两者都稳定，但职责不同。
- 不把翻译 key 塞进存档，不把 `t()` 塞进数值表 getter。
- `AFFIXES.description` 当前含“复用池”“读某字段”等开发实现说明，英文玩家文案应改写成真正面向玩家的效果描述，开发细节留在代码注释。
