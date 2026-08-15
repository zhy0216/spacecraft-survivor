# fal.ai round 10 —— 全系星级炮头与战斗接入

本轮把剩余五个基础炮系与进阶导弹巢补齐到独立星级贴图，并接入战斗炮位：

- 2★：沿用 round-8 基础炮头，用统一青色外轮廓强化，保留武器身份。
- 3★：使用 `genmedia v0.7.0` 的 `fal-ai/nano-banana-pro/edit`，以基础炮头为参考重画高阶形态。
- 合成塔复用对应血统的 3★ 形态：雷霆王冠/湮灭长矛/焦土骤雨/荆棘星幕分别沿用电弧/磁轨/迫击炮/点防的高阶炮头。
- 自动机炮与激光棱镜的 3★ 形态仍来自 round-9；本轮统一切换到同一套战斗加载逻辑。

## 新增运行时输出

运行时图均为 128×128 RGBA PNG：

- `assets/game/fal-round-10/towers/arc-coil-head-star2.png`
- `assets/game/fal-round-10/towers/arc-coil-head-star3.png`
- `assets/game/fal-round-10/towers/railgun-head-star2.png`
- `assets/game/fal-round-10/towers/railgun-head-star3.png`
- `assets/game/fal-round-10/towers/point-defense-head-star2.png`
- `assets/game/fal-round-10/towers/point-defense-head-star3.png`
- `assets/game/fal-round-10/towers/plasma-mortar-head-star2.png`
- `assets/game/fal-round-10/towers/plasma-mortar-head-star3.png`
- `assets/game/fal-round-10/towers/missile-nest-head-star2.png`
- `assets/game/fal-round-10/towers/missile-nest-head-star3.png`

[全系七种武器的星级对比图](results/all-tower-star-tier-contact.png)

[本轮五种新增武器的星级对比图](results/star-tier-contact.png)

3★ 的 Nano Banana Pro 源图先用 imagegen 的 `remove_chroma_key.py` 去除平色键背景，再缩放到运行时尺寸；未选中的重复候选保留在 `towers/` 供回溯，不接入运行时。

## 接入点

- `src/render/artUrls.ts`：统一维护图鉴与战斗共用的 1★/2★/3★ URL 清单。
- `src/render/generatedAssets.ts`：按塔型和星级加载纹理。
- `src/render/renderer.ts`：战斗中按槽位 `stars` 选择对应炮头，星级变化会触发炮位重建。
- `src/ui/shipDiagram.ts`：整备/舰船图也显示对应星级炮头。

完整 prompt、请求 ID、选片记录见 `results/jobs.json` 与 `results/ledger.json`。
