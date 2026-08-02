# STARWRECK MVP — Issue 索引

> 来源:`GDD.md` v0.1 | 生成日期:2026-08-01

## MVP 范围定义

- **一张地图**:单场景开阔太空战场,由波次脚本驱动的连续航段组成单局(约 8–10 分钟),存活到底即胜利。无星图、无节点(商店/事件/船坞)、无 Boss。
- **一艘飞船**:T0 拾荒艇(3×4 甲板)。无船级进化树、无主动技。

对应 GDD 里程碑:≈ M0 手感灰盒 + M1 垂直切片中的甲板/塔/敌人部分,砍掉星图与船坞。

## Issue 列表

| # | 文件 | 标题 | 优先级 | 依赖 |
|---|---|---|---|---|
| 01 | [01-project-scaffold.md](done/01-project-scaffold.md) | 项目脚手架与游戏主循环 | P0 ✅ | — |
| 02 | [02-ship-movement.md](done/02-ship-movement.md) | 飞船操控、惯性移动与镜头 | P0 ✅ | 01 |
| 03 | [03-deck-grid.md](done/03-deck-grid.md) | 甲板网格与放置规则 | P0 ✅ | 01 |
| 04 | [04-firing-arcs.md](done/04-firing-arcs.md) | 射界系统与可视化 | P0 ✅ | 03 |
| 05 | [05-weapon-towers.md](done/05-weapon-towers.md) | 武器塔框架与 6 种 MVP 塔 | P0 ✅ | 03, 04 |
| 06 | [06-support-facilities.md](06-support-facilities.md) | 支援设施与邻接协同 | P1 | 03, 05 |
| 07 | [07-enemies.md](done/07-enemies.md) | 敌人系统与 4 种 MVP 敌人 | P0 ✅ | 01, 02 |
| 08 | [08-waves-map.md](08-waves-map.md) | 波次脚本与单局地图 | P1 | 02, 07 |
| 09 | [09-damage-model.md](done/09-damage-model.md) | 受击模型与船体 HP | P0 ✅ | 02, 07 |
| 10 | [10-economy-upgrade.md](10-economy-upgrade.md) | 残骸经济与三选一升级 | P1 | 03, 05, 06 |
| 11 | [11-hud.md](11-hud.md) | HUD 与威胁罗盘 | P1 | 08, 09, 10 |
| 12 | [12-deck-expansion.md](12-deck-expansion.md) | 甲板拼块扩建(延伸) | P2 | 03, 04, 10 |

## 建议实施顺序

```
01 → 02 → 07(蜂群蛭+侧掠者)→ 05 最小子集(机炮+电弧,固定舷位)
   ↓
【M0 灰盒验证门】GDD §15:5 人盲测,三条不全过先调手感,不往下走
   ↓
03 → 04 → 05 全量 → 09 → 10 → 06 → 08 → 11 → 12(可选)
```

## 明确不做(MVP 之外)

星图/节点选路、船坞重排与出售、星区 Boss、船级进化树、主动技、空间进化配方(§5.5)、法令、星币/商店/重摇、精英与词缀、元解锁/图鉴、音频系统、登舰机制、手柄适配、手机适配。

## 备注:GDD 内部口径冲突

§4.3 写"邻接 MVP 只实装弹药库",但 §5.3 表格标了 4 种支援设施为 MVP ✅。本 issue 集按 **4 种全做、弹药库先行**处理(见 06),先验证"连线读得懂"再加其余三种。
