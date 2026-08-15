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
 * Boss 专属整图(round-7 重做):母巢腹腔 / 四枚孵化囊 / 中央虹膜都落在暖红紫域。
 * KIND_BOSS 不进 ENEMIES 表,故不占 ENEMY_ART_URLS 下标；骨架部件加载失败时用它作整图回退。
 */
export const BOSS_ART_URL = new URL(
  '../../assets/game/fal-round-7/enemies/boss-brood-carrier.png',
  import.meta.url,
).href;

/**
 * 骨架部件图(round-3 首批、round-7 补齐):外层下标 === EnemyKind,null = 缺件时逐型回退。
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
  // KIND_TRAILER 尾随蛆:尾 → 身 → 颈 → 头
  [
    new URL('../../assets/game/fal-round-7/enemies/tail-maggot/tail.png', import.meta.url).href,
    new URL('../../assets/game/fal-round-7/enemies/tail-maggot/body.png', import.meta.url).href,
    new URL('../../assets/game/fal-round-7/enemies/tail-maggot/neck.png', import.meta.url).href,
    new URL('../../assets/game/fal-round-7/enemies/tail-maggot/head.png', import.meta.url).href,
  ],
  // KIND_BEETLE 冲撞甲虫:左足组 → 右足组 → 主甲壳 → 楔头
  [
    new URL('../../assets/game/fal-round-7/enemies/charging-beetle/leg-left.png', import.meta.url).href,
    new URL('../../assets/game/fal-round-7/enemies/charging-beetle/leg-right.png', import.meta.url).href,
    new URL('../../assets/game/fal-round-7/enemies/charging-beetle/body.png', import.meta.url).href,
    new URL('../../assets/game/fal-round-7/enemies/charging-beetle/head.png', import.meta.url).href,
  ],
  // KIND_SPORE 孢子炮手:锚足 → 孢囊 → 炮座 → 虹吸管
  [
    new URL('../../assets/game/fal-round-7/enemies/spore-cannon/anchor.png', import.meta.url).href,
    new URL('../../assets/game/fal-round-7/enemies/spore-cannon/pods.png', import.meta.url).href,
    new URL('../../assets/game/fal-round-7/enemies/spore-cannon/body.png', import.meta.url).href,
    new URL('../../assets/game/fal-round-7/enemies/spore-cannon/siphon.png', import.meta.url).href,
  ],
];

/**
 * Boss 骨架画序(round-7):左足 → 右足 → 母巢腹腔 → 孵化囊 → 产卵虹膜 → 头甲。
 * 左右足来自同一条生成足的镜像切件,关节方向因此在两侧都正确。
 */
export const BOSS_RIG_PART_URLS = [
  new URL('../../assets/game/fal-round-7/enemies/boss-brood-carrier/leg.png', import.meta.url).href,
  new URL('../../assets/game/fal-round-7/enemies/boss-brood-carrier/leg-mirrored.png', import.meta.url).href,
  new URL('../../assets/game/fal-round-7/enemies/boss-brood-carrier/body.png', import.meta.url).href,
  new URL('../../assets/game/fal-round-7/enemies/boss-brood-carrier/egg-sac.png', import.meta.url).href,
  new URL('../../assets/game/fal-round-7/enemies/boss-brood-carrier/iris.png', import.meta.url).href,
  new URL('../../assets/game/fal-round-7/enemies/boss-brood-carrier/head.png', import.meta.url).href,
] as const;

/**
 * Nano Banana Pro round-8 的真实旋转炮头。基础六系各一张,合成塔复用自己的血统炮头;
 * 导弹巢单独一张。数组下标仍与 TOWERS[type] 一一对应,所以战斗层和图鉴都不需要
 * 再画程序化“炮管线”或为合成塔退回色块。
 */
const AUTOCANNON_HEAD_URL = new URL(
  '../../assets/game/fal-round-8/towers/autocannon-head.png',
  import.meta.url,
).href;
const LASER_PRISM_HEAD_URL = new URL(
  '../../assets/game/fal-round-8/towers/laser-prism-head.png',
  import.meta.url,
).href;
const ARC_COIL_HEAD_URL = new URL(
  '../../assets/game/fal-round-8/towers/arc-coil-head.png',
  import.meta.url,
).href;
const RAILGUN_HEAD_URL = new URL(
  '../../assets/game/fal-round-8/towers/railgun-head.png',
  import.meta.url,
).href;
const POINT_DEFENSE_HEAD_URL = new URL(
  '../../assets/game/fal-round-8/towers/point-defense-head.png',
  import.meta.url,
).href;
const PLASMA_MORTAR_HEAD_URL = new URL(
  '../../assets/game/fal-round-8/towers/plasma-mortar-head.png',
  import.meta.url,
).href;
const MISSILE_NEST_HEAD_URL = new URL(
  '../../assets/game/fal-round-8/towers/missile-nest-head.png',
  import.meta.url,
).href;

// 星级炮头：2★ 是基础炮头的青色描边强化；3★ 按合成/高阶形态重新生成。
// 图鉴与战斗层共用下面的 TOWER_STAR_ART_URLS，避免预览和实战各走一套资源。
const AUTOCANNON_HEAD_STAR2_URL = new URL(
  '../../assets/game/fal-round-8/towers/autocannon-head-star2.png',
  import.meta.url,
).href;
const AUTOCANNON_HEAD_STAR3_URL = new URL(
  '../../assets/game/fal-round-8/towers/autocannon-head-star3.png',
  import.meta.url,
).href;
const LASER_PRISM_HEAD_STAR2_URL = new URL(
  '../../assets/game/fal-round-8/towers/laser-prism-head-star2.png',
  import.meta.url,
).href;
const LASER_PRISM_HEAD_STAR3_URL = new URL(
  '../../assets/game/fal-round-8/towers/laser-prism-head-star3.png',
  import.meta.url,
).href;
const ARC_COIL_HEAD_STAR2_URL = new URL(
  '../../assets/game/fal-round-10/towers/arc-coil-head-star2.png',
  import.meta.url,
).href;
const ARC_COIL_HEAD_STAR3_URL = new URL(
  '../../assets/game/fal-round-10/towers/arc-coil-head-star3.png',
  import.meta.url,
).href;
const RAILGUN_HEAD_STAR2_URL = new URL(
  '../../assets/game/fal-round-10/towers/railgun-head-star2.png',
  import.meta.url,
).href;
const RAILGUN_HEAD_STAR3_URL = new URL(
  '../../assets/game/fal-round-10/towers/railgun-head-star3.png',
  import.meta.url,
).href;
const POINT_DEFENSE_HEAD_STAR2_URL = new URL(
  '../../assets/game/fal-round-10/towers/point-defense-head-star2.png',
  import.meta.url,
).href;
const POINT_DEFENSE_HEAD_STAR3_URL = new URL(
  '../../assets/game/fal-round-10/towers/point-defense-head-star3.png',
  import.meta.url,
).href;
const PLASMA_MORTAR_HEAD_STAR2_URL = new URL(
  '../../assets/game/fal-round-10/towers/plasma-mortar-head-star2.png',
  import.meta.url,
).href;
const PLASMA_MORTAR_HEAD_STAR3_URL = new URL(
  '../../assets/game/fal-round-10/towers/plasma-mortar-head-star3.png',
  import.meta.url,
).href;
const MISSILE_NEST_HEAD_STAR2_URL = new URL(
  '../../assets/game/fal-round-10/towers/missile-nest-head-star2.png',
  import.meta.url,
).href;
const MISSILE_NEST_HEAD_STAR3_URL = new URL(
  '../../assets/game/fal-round-10/towers/missile-nest-head-star3.png',
  import.meta.url,
).href;

/**
 * 星级炮头展示倍率:下标 0..2 = 1★..3★。renderer 的战斗炮位贴图按它放大；
 * 图鉴的三档缩略图统一尺寸,星数靠图下标签读(贴图清单见 TOWER_STAR_ART_URLS)。
 */
export const TOWER_STAR_HEAD_SCALES = [1, 1.16, 1.32] as const;

export const TOWER_ART_URLS = [
  AUTOCANNON_HEAD_URL,
  LASER_PRISM_HEAD_URL,
  ARC_COIL_HEAD_URL,
  RAILGUN_HEAD_URL,
  POINT_DEFENSE_HEAD_URL,
  PLASMA_MORTAR_HEAD_URL,
  AUTOCANNON_HEAD_URL, // 风暴机炮
  LASER_PRISM_HEAD_URL, // 极光阵列
  RAILGUN_HEAD_URL, // 湮灭长矛
  ARC_COIL_HEAD_URL, // 雷霆王冠
  PLASMA_MORTAR_HEAD_URL, // 焦土骤雨
  POINT_DEFENSE_HEAD_URL, // 荆棘星幕
  MISSILE_NEST_HEAD_URL,
] as const;

/** 图鉴专用的 1★/2★/3★ 贴图清单,顺序仍严格对应 TOWERS[type]。 */
const AUTOCANNON_STAR_ART_URLS = [
  AUTOCANNON_HEAD_URL,
  AUTOCANNON_HEAD_STAR2_URL,
  AUTOCANNON_HEAD_STAR3_URL,
] as const;
const LASER_PRISM_STAR_ART_URLS = [
  LASER_PRISM_HEAD_URL,
  LASER_PRISM_HEAD_STAR2_URL,
  LASER_PRISM_HEAD_STAR3_URL,
] as const;
const ARC_COIL_STAR_ART_URLS = [
  ARC_COIL_HEAD_URL,
  ARC_COIL_HEAD_STAR2_URL,
  ARC_COIL_HEAD_STAR3_URL,
] as const;
const RAILGUN_STAR_ART_URLS = [
  RAILGUN_HEAD_URL,
  RAILGUN_HEAD_STAR2_URL,
  RAILGUN_HEAD_STAR3_URL,
] as const;
const POINT_DEFENSE_STAR_ART_URLS = [
  POINT_DEFENSE_HEAD_URL,
  POINT_DEFENSE_HEAD_STAR2_URL,
  POINT_DEFENSE_HEAD_STAR3_URL,
] as const;
const PLASMA_MORTAR_STAR_ART_URLS = [
  PLASMA_MORTAR_HEAD_URL,
  PLASMA_MORTAR_HEAD_STAR2_URL,
  PLASMA_MORTAR_HEAD_STAR3_URL,
] as const;
const MISSILE_NEST_STAR_ART_URLS = [
  MISSILE_NEST_HEAD_URL,
  MISSILE_NEST_HEAD_STAR2_URL,
  MISSILE_NEST_HEAD_STAR3_URL,
] as const;

export const TOWER_STAR_ART_URLS = [
  AUTOCANNON_STAR_ART_URLS,
  LASER_PRISM_STAR_ART_URLS,
  ARC_COIL_STAR_ART_URLS,
  RAILGUN_STAR_ART_URLS,
  POINT_DEFENSE_STAR_ART_URLS,
  PLASMA_MORTAR_STAR_ART_URLS,
  AUTOCANNON_STAR_ART_URLS, // 风暴机炮(合成型号复用血统炮头)
  LASER_PRISM_STAR_ART_URLS, // 极光阵列
  RAILGUN_STAR_ART_URLS, // 湮灭长矛(复用磁轨血统)
  ARC_COIL_STAR_ART_URLS, // 雷霆王冠(复用电弧血统)
  PLASMA_MORTAR_STAR_ART_URLS, // 焦土骤雨(复用迫击炮血统)
  POINT_DEFENSE_STAR_ART_URLS, // 荆棘星幕(复用点防血统)
  MISSILE_NEST_STAR_ART_URLS,
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
