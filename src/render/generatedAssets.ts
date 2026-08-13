import { Assets, type Texture } from 'pixi.js';
import {
  BACKGROUND_ART_URL,
  BOSS_ART_URL,
  ENEMY_ART_URLS,
  ENEMY_RIG_PART_URLS,
  SHIP_HULL_ART_URL,
  SUPPORT_ART_URLS,
  TOWER_ART_URLS,
} from './artUrls';

/**
 * fal.ai 生成资源的运行时映射(round-1 首批四敌/六塔/四支援;round-2 补孢子炮手与 Boss)。
 *
 * URL 清单住在 ./artUrls(纯字符串、无 pixi,ui 图鉴同源引用);本文件只负责把清单装成
 * Texture。这里故意引用 assets/game 下的运行时版本,而不是 investigations 里保留的生产源图:
 * 原图负责回溯生成结果,运行时图负责首屏体积与显存。背景与核心舰壳各一张;敌人、炮塔、
 * 设施数组顺序分别与 ENEMIES / TOWERS / SUPPORTS 的数字类型严格一致,渲染器因此可以继续
 * 按 kind/type 直取,不在热路径里查字符串表。
 */

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
  /** Boss 专属(round-2);null = 回退底座型纹理放大(见 artUrls.BOSS_ART_URL 注释) */
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
    loadTexture(BACKGROUND_ART_URL, 'background'),
    loadTexture(SHIP_HULL_ART_URL, 'ship-hull'),
    loadTextureSet(ENEMY_ART_URLS, 'enemy'),
    Promise.all(ENEMY_RIG_PART_URLS.map((urls, kind) => loadRigParts(urls, kind))),
    loadTexture(BOSS_ART_URL, 'boss'),
    loadTextureSet(TOWER_ART_URLS, 'tower'),
    loadTextureSet(SUPPORT_ART_URLS, 'support'),
  ]);
  return { background, shipHull, enemies, enemyRigParts, boss, towers, supports };
}
