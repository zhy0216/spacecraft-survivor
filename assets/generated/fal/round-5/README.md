# fal.ai round 5 —— 商店宣传图与 Boss 高细节贴图

本轮使用 `genmedia v0.7.0` 的 `fal-ai/nano-banana-pro`。两张运行时图都保留了源图、
处理后图与请求回执，便于复查生成参数和重新下载。

## 商店主视觉

- 请求：`019ffd94-204d-7050-917c-7abf485af798`
- 输出：`ui/shop-bay-nanobanana-source.png`
- 运行时：`assets/game/ui/shop-bay-nanobanana.png`
- 构图：16:9 舰坞货架，左侧留标题负空间，右侧为冷蓝霓虹与少量琥珀工作灯。

## Boss 贴图

- 请求：`019ffd95-7a5a-7393-ba0b-b7e69b512290`
- 源图：`enemies/boss-war-beetle-nanobanana-source.png`
- 处理图：`enemies/boss-war-beetle-nanobanana.png`
- 处理：使用项目 imagegen 的 chroma-key 去背脚本，输出 RGBA，保留推进器烟雾与装甲边缘。
