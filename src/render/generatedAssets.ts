import { Assets, type Texture } from 'pixi.js';

/**
 * fal.ai 生成资源的运行时映射(round-1 首批四敌/六塔/四支援;round-2 补孢子炮手与 Boss)。
 *
 * 这里故意引用 assets/game 下的运行时版本，而不是 investigations 里保留的生产源图：
 * 原图负责回溯生成结果，运行时图负责首屏体积与显存。背景与核心舰壳各一张；敌人、炮塔、
 * 设施数组顺序分别与 ENEMIES / TOWERS / SUPPORTS 的数字类型严格一致，渲染器因此可以继续
 * 按 kind/type 直取，不在热路径里查字符串表。
 */
const ENEMY_URLS = [
  new URL('../../assets/game/fal-round-1/enemies/swarm-leech.png', import.meta.url).href,
  new URL('../../assets/game/fal-round-1/enemies/side-raider.png', import.meta.url).href,
  new URL('../../assets/game/fal-round-1/enemies/tail-maggot.png', import.meta.url).href,
  new URL('../../assets/game/fal-round-1/enemies/charging-beetle.png', import.meta.url).href,
  // 22 号新增的孢子炮手补于 round-2(assets/generated/fal/round-2 有源图与回执),下标 = KIND_SPORE
  new URL('../../assets/game/fal-round-2/enemies/spore-cannon.png', import.meta.url).href,
] as const;

/**
 * Boss 专属贴图(round-2):KIND_BOSS 不进 ENEMIES 表,故不占 ENEMY_URLS 下标,单独一张。
 * 加载失败时 Renderer 回退到底座型(冲撞甲虫)的纹理放大 —— 与逐型回退同一条"坏一张不塌一局"的口径。
 */
const BOSS_URL = new URL('../../assets/game/fal-round-2/enemies/boss-war-beetle.png', import.meta.url)
  .href;

/**
 * 骨架部件图(round-3,24 号 issue):外层下标 === EnemyKind,null = 这一型还没做骨架。
 * **内层顺序 === RigDef.textureCount 的 tex 号,也就是画序**(小的在后面),
 * 与 render/enemyRig.ts 的 RIG_* 表严格对应 —— 两边错位不会报错,只会让部件叠错前后,
 * 故两处都把顺序写进注释,改一处必须改另一处。
 */
const ENEMY_RIG_PART_URLS: readonly (readonly string[] | null)[] = [
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

const TOWER_URLS = [
  new URL('../../assets/game/fal-round-1/towers/autocannon.png', import.meta.url).href,
  new URL('../../assets/game/fal-round-1/towers/laser-prism.png', import.meta.url).href,
  new URL('../../assets/game/fal-round-1/towers/arc-coil.png', import.meta.url).href,
  new URL('../../assets/game/fal-round-1/towers/railgun.png', import.meta.url).href,
  new URL('../../assets/game/fal-round-1/towers/point-defense.png', import.meta.url).href,
  new URL('../../assets/game/fal-round-1/towers/plasma-mortar.png', import.meta.url).href,
] as const;

const SUPPORT_URLS = [
  new URL('../../assets/game/fal-round-1/supports/ammo-bay.png', import.meta.url).href,
  new URL('../../assets/game/fal-round-1/supports/radiator.png', import.meta.url).href,
  new URL('../../assets/game/fal-round-1/supports/capacitor-bank.png', import.meta.url).href,
  new URL('../../assets/game/fal-round-1/supports/armor-bay.png', import.meta.url).href,
] as const;

const BACKGROUND_URL = new URL(
  '../../assets/game/fal-round-1/backgrounds/starwreck-nebula.webp',
  import.meta.url,
).href;

const SHIP_HULL_URL = new URL(
  '../../assets/game/fal-round-1/ships/scrapper-hull.png',
  import.meta.url,
).href;

export interface GeneratedArtTextures {
  readonly background: Texture | null;
  readonly shipHull: Texture | null;
  readonly enemies: readonly (Texture | null)[];
  /**
   * 骨架部件(round-3):下标 === EnemyKind,内层 === 画序。
   * **一型的部件是全有或全无**:少一块的骨架在画面上是一只缺了头的怪,比整型回退单件贴图糟得多,
   * 所以任一部件加载失败就把整型置 null,渲染层照旧走单件贴图那条路(逐型回退,不影响别的型)。
   */
  readonly enemyRigParts: readonly (readonly Texture[] | null)[];
  /** Boss 专属(round-2);null = 回退底座型纹理放大(见 BOSS_URL 注释) */
  readonly boss: Texture | null;
  readonly towers: readonly (Texture | null)[];
  readonly supports: readonly (Texture | null)[];
}

async function loadTexture(url: string, label: string): Promise<Texture | null> {
  try {
    return await Assets.load<Texture>(url);
  } catch (error) {
    // 单张候选图坏掉不该阻断开局：Renderer 会为敌人回退程序化剪影、为甲板保留原色块。
    console.warn(`[generated-art] failed to load ${label}; using renderer fallback`, error);
    return null;
  }
}

function loadTextureSet(urls: readonly string[], prefix: string): Promise<(Texture | null)[]> {
  return Promise.all(urls.map((url, index) => loadTexture(url, `${prefix}-${index}`)));
}

/** 一型骨架的部件图:全有才返回数组,缺一块就整型置 null(理由见 GeneratedArtTextures.enemyRigParts) */
async function loadRigParts(
  urls: readonly string[] | null,
  kind: number,
): Promise<readonly Texture[] | null> {
  if (!urls) return null;
  const parts = await loadTextureSet(urls, `enemy-${kind}-rig`);
  if (parts.some((t) => t === null)) {
    console.warn(`[generated-art] enemy ${kind} rig incomplete; falling back to single sprite`);
    return null;
  }
  return parts as Texture[];
}

export async function loadGeneratedArt(): Promise<GeneratedArtTextures> {
  const [background, shipHull, enemies, enemyRigParts, boss, towers, supports] = await Promise.all([
    loadTexture(BACKGROUND_URL, 'background'),
    loadTexture(SHIP_HULL_URL, 'ship-hull'),
    loadTextureSet(ENEMY_URLS, 'enemy'),
    Promise.all(ENEMY_RIG_PART_URLS.map((urls, kind) => loadRigParts(urls, kind))),
    loadTexture(BOSS_URL, 'boss'),
    loadTextureSet(TOWER_URLS, 'tower'),
    loadTextureSet(SUPPORT_URLS, 'support'),
  ]);
  return { background, shipHull, enemies, enemyRigParts, boss, towers, supports };
}
