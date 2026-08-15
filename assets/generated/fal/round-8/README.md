# fal.ai round 8 —— 战斗炮头重做

本轮使用 `genmedia v0.7.0` 的 `fal-ai/nano-banana-pro`，把战斗画面里由 Pixi
`Graphics` 画出的常驻白色炮管线替换为真正带物理炮管、导轨、电极、发射筒和炮口的旋转炮头。

## 运行时输出

- `assets/game/fal-round-8/towers/autocannon-head.png`
- `assets/game/fal-round-8/towers/laser-prism-head.png`
- `assets/game/fal-round-8/towers/arc-coil-head.png`
- `assets/game/fal-round-8/towers/railgun-head.png`
- `assets/game/fal-round-8/towers/point-defense-head.png`
- `assets/game/fal-round-8/towers/plasma-mortar-head.png`
- `assets/game/fal-round-8/towers/missile-nest-head.png`

七张运行时图均为 128×128 RGBA PNG。六种合成武器复用对应基础血统的真实炮头，
所以 `TOWER_ART_URLS` 仍按 13 个 `TOWERS[type]` 下标完整映射，不再回退色块。

## 生成与后处理

- 模型：`fal-ai/nano-banana-pro`
- 画幅 / 分辨率：`1:1` / `1K`
- 输出：PNG，纯色 `#ff00ff` 背景
- 去背：imagegen 技能的 `remove_chroma_key.py`，`--auto-key border --soft-matte --despill`
- 运行时缩放：Lanczos 128×128，完整保留原始方形画布，透明角落已验证
- 炮头转轴：生成构图统一把机械轴心放在画布下部；渲染锚点 `y = 0.72`

## Prompt 组合

完整可复现结构保存在 `results/jobs.json`。最终七张都由以下三段拼接：

1. `system_prompt`
2. 各武器的 `subject_prompt`
3. `shared_prompt_suffix`

共同目标是：严格正交俯视、武器朝十二点方向、只画旋转炮头、不画固定底座、阴影、弹道、
瞄准线、开火特效、文字或 UI；材质统一为冷钢蓝拾荒机械，辅以少量青色状态灯和橙色警示纹。

## 选片

- 自动机炮、电弧塔、磁轨炮、点防阵列、等离子迫击炮：首张选用。
- 激光棱镜：首张出现斜向 X 构图，第二张改为严格竖直双导轨后选用。
- 导弹巢：首张把发射筒画成朝相机的圆孔且夹带微小标签，第二张改为六枚平躺纵向发射匣后选用。

审查图：

- `results/turret-heads-alpha-contact.png`：六个基础系透明源图
- `results/turret-heads-runtime-contact.png`：七个运行时炮头

## 花费

9 次成功生成 × $0.15 = **$1.35**。另有一次参数格式错误导致的 HTTP 422，未返回成功生成回执，
不计入成功调用。详见 `results/ledger.json`。
