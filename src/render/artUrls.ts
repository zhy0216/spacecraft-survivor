/**
 * 生成美术的 URL 清单 —— 纯字符串,**永不 import pixi**(铁律 1 边界的特例出口:
 * ui 层的图鉴页要引用同一批图,而它不允许 import pixi;故清单与加载逻辑拆成两个文件,
 * 本文件只负责"哪张图在哪",generatedAssets.ts 负责把它装成 Texture)。
 *
 * 数组顺序与 data 表的数字类型严格对应(敌人 = ENEMIES 的 kind、塔 = TOWERS 的 type),
 * 渲染器与图鉴因此可以按 kind/type 直取,不在热路径里查字符串表。改图/加图只动这里,
 * 两个消费方(renderer、ui/codex)自动跟上 —— 清单抄第二份的下场是图鉴指着旧路径 404。
 */
export const ENEMY_ART_URLS = [
  new URL('../../assets/game/fal-round-1/enemies/swarm-leech.png', import.meta.url).href,
  new URL('../../assets/game/fal-round-1/enemies/side-raider.png', import.meta.url).href,
  new URL('../../assets/game/fal-round-1/enemies/tail-maggot.png', import.meta.url).href,
  new URL('../../assets/game/fal-round-1/enemies/charging-beetle.png', import.meta.url).href,
  // 22 号新增的孢子炮手补于 round-2(assets/generated/fal/round-2 有源图与回执),下标 = KIND_SPORE
  new URL('../../assets/game/fal-round-2/enemies/spore-cannon.png', import.meta.url).href,
] as const;

/**
 * Boss 专属贴图(round-5):KIND_BOSS 不进 ENEMIES 表,故不占 ENEMY_ART_URLS 下标,单独一张。
 * 加载失败时 Renderer 回退到底座型(冲撞甲虫)的纹理放大 —— 与逐型回退同一条"坏一张不塌一局"的口径。
 */
export const BOSS_ART_URL = new URL(
  '../../assets/game/fal-round-5/enemies/boss-war-beetle.png',
  import.meta.url,
).href;

/**
 * 骨架部件图(round-3,24 号 issue):外层下标 === EnemyKind,null = 这一型还没做骨架。
 * **内层顺序 === RigDef.textureCount 的 tex 号,也就是画序**(小的在后面),
 * 与 render/enemyRig.ts 的 RIG_* 表严格对应 —— 两边错位不会报错,只会让部件叠错前后,
 * 故两处都把顺序写进注释,改一处必须改另一处。
 */
export const ENEMY_RIG_PART_URLS: readonly (readonly string[] | null)[] = [
  // KIND_SWARM 蜂群蛭:裂瓣在后,核心口器盘在前(盘压住 6 片瓣根的直边切口)
  [
    new URL('../../assets/game/fal-round-3/enemies/swarm-leech/lobe.png', import.meta.url).href,
    new URL('../../assets/game/fal-round-3/enemies/swarm-leech/core.png', import.meta.url).href,
  ],
  // KIND_STRAFER 侧掠者:尾尖 → 尾上段 → 爪足 → 胸 → 头
  [
    new URL('../../assets/game/fal-round-3/enemies/side-raider/tail-b.png', import.meta.url).href,
    new URL('../../assets/game/fal-round-3/enemies/side-raider/tail-a.png', import.meta.url).href,
    new URL('../../assets/game/fal-round-3/enemies/side-raider/leg.png', import.meta.url).href,
    new URL('../../assets/game/fal-round-3/enemies/side-raider/thorax.png', import.meta.url).href,
    new URL('../../assets/game/fal-round-3/enemies/side-raider/head.png', import.meta.url).href,
  ],
  null, // KIND_TRAILER 尾随蛆
  null, // KIND_BEETLE 冲撞甲虫
  null, // KIND_SPORE 孢子炮手
];

/** 基础塔(0..5)的生成贴图;6..11 合成塔与 12 导弹巢没有独立贴图(见 ui/codex 的血统回退口径) */
export const TOWER_ART_URLS = [
  new URL('../../assets/game/fal-round-1/towers/autocannon.png', import.meta.url).href,
  new URL('../../assets/game/fal-round-1/towers/laser-prism.png', import.meta.url).href,
  new URL('../../assets/game/fal-round-1/towers/arc-coil.png', import.meta.url).href,
  new URL('../../assets/game/fal-round-1/towers/railgun.png', import.meta.url).href,
  new URL('../../assets/game/fal-round-1/towers/point-defense.png', import.meta.url).href,
  new URL('../../assets/game/fal-round-1/towers/plasma-mortar.png', import.meta.url).href,
] as const;

export const SUPPORT_ART_URLS = [
  new URL('../../assets/game/fal-round-1/supports/ammo-bay.png', import.meta.url).href,
  new URL('../../assets/game/fal-round-1/supports/radiator.png', import.meta.url).href,
  new URL('../../assets/game/fal-round-1/supports/capacitor-bank.png', import.meta.url).href,
  new URL('../../assets/game/fal-round-1/supports/armor-bay.png', import.meta.url).href,
] as const;

export const BACKGROUND_ART_URL = new URL(
  '../../assets/game/fal-round-1/backgrounds/starwreck-nebula.webp',
  import.meta.url,
).href;

/**
 * 舰壳(round-4):round-1 那张其实**从没经过生成器** —— 当时图像生成不可用,临时手画了一张
 * SVG 兜底再栅格化,于是全仓只有它一张不是生成美术,平涂色块也与塔/设施的质感对不上。
 * 本轮用 nano-banana-pro 真生成:废铁改装舰俯视图(焊接补丁 / 外挂装甲 / 平铺管线 /
 * 橙色警示条),冷蓝灰主色仍落在 SHIP_FILL 的色域里,船头指向 +X(与 hullArtG 不加旋转偏移对齐)。
 * 出图按 (shipLength + CELL×0.72) : (shipWidth + CELL×0.45) = 1.368 垫边到目标宽高比再缩放,
 * 让 Renderer 那步"强制拉伸到船体包围盒"退化成等比缩放 —— 船不会被压扁。
 */
export const SHIP_HULL_ART_URL = new URL(
  '../../assets/game/fal-round-4/ships/scrapper-hull.png',
  import.meta.url,
).href;
