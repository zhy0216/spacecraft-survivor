import { Assets, type Texture } from 'pixi.js';

/**
 * 第一轮 fal.ai 资源的运行时映射。
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
] as const;

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

export async function loadGeneratedArt(): Promise<GeneratedArtTextures> {
  const [background, shipHull, enemies, towers, supports] = await Promise.all([
    loadTexture(BACKGROUND_URL, 'background'),
    loadTexture(SHIP_HULL_URL, 'ship-hull'),
    loadTextureSet(ENEMY_URLS, 'enemy'),
    loadTextureSet(TOWER_URLS, 'tower'),
    loadTextureSet(SUPPORT_URLS, 'support'),
  ]);
  return { background, shipHull, enemies, towers, supports };
}
