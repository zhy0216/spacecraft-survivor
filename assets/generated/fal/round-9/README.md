# fal.ai round 9 —— 3★ 武器图鉴试点

本轮先为自动机炮与激光棱镜恢复独立星级图片：

- 2★：在现有 round-8 炮头上做青色外轮廓强化，保留原炮体身份。
- 3★：用 `genmedia v0.7.0` 的 `fal-ai/nano-banana-pro/edit`，以现有炮头为参考，
  重新设计为实际合成形态“风暴机炮”和“极光阵列”，不是简单放大或加光。

## 运行时输出

- `assets/game/fal-round-8/towers/autocannon-head-star2.png`
- `assets/game/fal-round-8/towers/autocannon-head-star3.png`
- `assets/game/fal-round-8/towers/laser-prism-head-star2.png`
- `assets/game/fal-round-8/towers/laser-prism-head-star3.png`

四张运行时图均为 128×128 RGBA PNG。它们现在与 round-10 的其余星级图一起由渲染器按
槽位星级加载；战斗层仍沿用既有的星级缩放、炮口旋转和弹道 FX。

## 3★ 生成与后处理

- 模型：`fal-ai/nano-banana-pro/edit`
- 参考图：对应的 round-8 基础炮头
- 画幅 / 分辨率：`1:1` / `1K`
- 输出：PNG
- 风暴机炮背景由模型输出为均匀灰色，使用连通域 flood-fill 去背，避免灰色炮体被色差键误删。
- 极光阵列背景为 `#ff00ff`，使用 imagegen 的 `remove_chroma_key.py` 去背。
- 两张透明源图均用 Lanczos 缩到 128×128，透明角落已验证。

完整请求参数与 prompt 在 `results/jobs.json`，花费与选片结论在 `results/ledger.json`。
