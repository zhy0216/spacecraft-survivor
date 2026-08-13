# fal.ai round 4 —— 舰壳重做 + 敌人配色分家 + 加速音效

生成工具 `genmedia v0.7.0`。本轮解决三件事:舰壳是全仓唯一没经过生成器的美术、
五种敌人在屏幕上是同一档暗绯红、加速技能是唯一没有专属音效的事件。

## 1. 舰壳(真·首次生成)

`assets/game/fal-round-1/ships/scrapper-hull.png` 一直是**手画 SVG 的栅格化兜底** ——
round-1 当时内置图像生成不可用,临时画了 `ships/scrapper-hull-source.svg` 顶上,
于是它成了全仓唯一不是生成美术的一张,平涂色块与塔/设施的质感也对不上。

- 模型:`fal-ai/nano-banana-pro`(**不是** flux-2-pro)。flux 对 "spaceship" 有极强的
  侧视图先验,三个种子在 prompt 写死 "strict orthographic top-down view" 的情况下
  仍然全部出侧面剖视(废稿留在 `ships/scrapper-hull-4410*-source.png`)。
  nano-banana-pro 带 `system_prompt`,能把"相机永远在正上方俯视"提到指令层,一次就对。
- 候选:seed 55101 / 55102 / 55103,`ships/nb-*-source.png`。**选用 55102** ——
  船头那组橙色人字纹在缩到 48px 时仍读得出朝向,且它的紧致包围盒 1.603 最接近目标宽高比。
- 后处理 `scripts` 见提交说明:按"绿度" G − max(R,B) 抠像(而不是按到纯绿的距离),
  因为尾焰是青色、青色的 G 与 B 同高,按绿度算才不会把尾焰一起吃掉;随后 despill、
  按 alpha 紧致裁切、**垫边到 1.368**,最后缩到 768 宽落到
  `assets/game/fal-round-4/ships/scrapper-hull.png`。

1.368 = (shipLength 48 + CELL×0.72) ÷ (shipWidth 36 + CELL×0.45),即 Renderer 给舰壳
Sprite 强制指定的宽高比。**垫边而不是拉伸**:Renderer 那步"拉到船体包围盒"于是退化成等比缩放,
船不会被压扁。改 `shipLength`/`shipWidth`/两个 PAD 中的任何一个,这张图都要按新比例重垫边。

## 2. 敌人配色(本地重着色,零 API 花费)

问题不在 `data/enemies.ts` 的 `tint`:生成图存在时 `renderer.ts` 把 tint 设成 `0xffffff`,
**屏幕上的敌人颜色来自 PNG 本身**,tint 只剩死亡爆点与孢子弹在用。实测五张图的主色相
全部落在 349°–359°,只有 9° 跨度 —— 这就是"都是红色的"的量化原因。

手段是**对现有 PNG 做逐型色相旋转**,不重新生成:round-3 的骨架切图枢轴刚校准过
(蜂群蛭 lobe 的关节半径 40→28.2 是一整个提交),重生成会把那份实测全部作废。
色相旋转只动 H/S/V,alpha 与像素位置一个不碰,几何与枢轴原样成立。

| 型 | 目标色相 | gamma | 意图 |
|---|---:|---:|---|
| 蜂群蛭 swarm | 300° | 0.72 | 洋红 |
| 侧掠者 strafer | 25° | 0.60 | 橙,**明度最高**(唯一突发侧切型,余光要先看见) |
| 尾随蛆 trailer | 348° | 1.22 | 深绯红,**明度最低**(gamma>1 才是压暗) |
| 冲撞甲虫 beetle | 356° | 0.72 | 猩红 |
| 孢子炮手 spore | 288° | 0.72 | 紫罗兰 |
| Boss | 356° | 0.88 | 跟甲虫同色同明度档(它是甲虫的放大版) |

护栏:旋完落在暖色带 [265°, 45°] 之外的像素夹回边界。没有它,侧掠者 +25° 会把原图的
橙色发光孔洞推到 60° 出头的黄绿 —— 那正是 GDD §12 禁止的绿分量。重着色后六张图的
"绿分量占优"像素数均为 **0**。同时整体提亮:平均明度 0.29–0.37 → 0.39–0.48。

`data/enemies.ts` 的 `tint` 同步换成同色相的值,让死亡爆点与虫体同色。tint 另受
`enemies.test.ts` 的硬线约束(`r ≥ 0xb0` 且 `g ≤ 0x8c`),比 `palette.test.ts` 的
`r > g` 严得多,**贴图不受这条约束**(它只管 tint),所以贴图能比 tint 更饱和:

- 到不了"橙金":金色要 `g ≈ 0xa0`,越 `0x8c` 这条线就滑向暖黄。`g` 顶到 `0x8c` = 最橙的一点。
- 蜂群蛭没取高饱和洋红:那一档在红色盲下会塌到船体 `0x2b4a6e` 附近(OKLab 距 0.065 < 0.08)。

五型两两最小可辨距离(OKLab,取正常视觉与三种色盲模拟的最差值)从 **0.0425 → 0.0881**,
硬约束内的纯优化上限是 0.0913 —— 基本吃满。

## 3. 加速音效

`playBoost` 原先是全仓唯一没有专属素材的事件(代码里写着"genmedia 下一轮再补"),
一直走纯合成兜底。本轮用 `sonilo/v1.1/text-to-sound-effects` 生成(与现有 14 个音效同一模型,
音色同族),源文件 `../../../audio/generated/boost-0.wav`。

素材本身是 2.97s 不衰减的持续喷流,按现有流水线裁到 **1.10s = `tuning.boostDuration`**:
声音正好铺满加速窗,窗一关声音也收尾,"还在加速"变成听得见的事。尾部 0.30s 淡出
(素材自己不衰减,不淡会硬切),单声道 44.1kHz,峰值归一到 0.95,事件增益 0.30 在
`render/audio.ts`(击杀 0.16 与爆炸 0.46 之间)。

## 复现

`genmedia` 的参数是单横杠 flag(`--prompt` / `--seed` / `--aspect_ratio`),
**不是** `--input k=v`;`--download` 在本机静默失效(退出码 0、不落盘),
要自己从结果 JSON 取 `result.images[0].url`(音频取 `result.audio.url`)再 `curl`。
回执全部留在 `results/`。
