import { Assets, type Texture } from 'pixi.js';
import {
  BACKGROUND_ART_URL,
  BOSS_ART_URL,
  BOSS_RIG_PART_URLS,
  ENEMY_ART_URLS,
  ENEMY_RIG_PART_URLS,
  SHIP_HULL_ART_URL,
  SUPPORT_ART_URLS,
  TOWER_ART_URLS,
  TOWER_STAR_ART_URLS,
} from './artUrls';

/**
 * fal.ai 生成资源的运行时映射(round-1 首批敌/支援;round-2 补孢子炮手;
 * round-7 补齐普通怪骨架并重做母巢 Boss;round-8 重做全系旋转炮头)。
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
  /** Boss 专属整图(round-7);骨架缺件时回退到它 */
  readonly boss: Texture | null;
  /** Boss 专属骨架部件(round-7);任一缺件 = 整套 null,渲染层回退 boss 整图 */
  readonly bossRigParts: readonly Texture[] | null;
  readonly towers: readonly (Texture | null)[];
  /** 星级炮头:下标 === towerType,内层 0..2 === 1★..3★;战斗炮位与图鉴同源。 */
  readonly towerStars: readonly (readonly (Texture | null)[])[];
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
  label: string,
): Promise<readonly Texture[] | null> {
  if (!urls) return null;
  const parts = await loadTextureSet(urls, `${label}-rig`);
  if (parts.some((t) => t === null)) {
    console.warn(`[generated-art] ${label} rig incomplete; falling back to single sprite`);
    return null;
  }
  return parts as Texture[];
}

export async function loadGeneratedArt(): Promise<GeneratedArtTextures> {
  const [background, shipHull, enemies, enemyRigParts, boss, bossRigParts, towers, towerStars, supports] = await Promise.all([
    loadTexture(BACKGROUND_ART_URL, 'background'),
    loadTexture(SHIP_HULL_ART_URL, 'ship-hull'),
    loadTextureSet(ENEMY_ART_URLS, 'enemy'),
    Promise.all(ENEMY_RIG_PART_URLS.map((urls, kind) => loadRigParts(urls, `enemy-${kind}`))),
    loadTexture(BOSS_ART_URL, 'boss'),
    loadRigParts(BOSS_RIG_PART_URLS, 'boss'),
    loadTextureSet(TOWER_ART_URLS, 'tower'),
    Promise.all(TOWER_STAR_ART_URLS.map((urls, type) => loadTextureSet(urls, `tower-${type}-star`))),
    loadTextureSet(SUPPORT_ART_URLS, 'support'),
  ]);
  return { background, shipHull, enemies, enemyRigParts, boss, bossRigParts, towers, towerStars, supports };
}
