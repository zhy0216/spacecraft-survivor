import { ENEMIES } from '../data/enemies';

/**
 * 敌纹理的灰阶底色。Pixi 最终显示的是「底色 × tint」，可访问性审计必须检查这个合成结果，
 * 不能只检查看起来更亮、但屏幕上并不存在的原始 tint。
 */
export const ENEMY_BODY_FILL = 0xbbbbbb;

/** 船体冷色废铁；与塔、弹、支援设施共同组成我方冷色域。 */
export const SHIP_FILL = 0x2b4a6e;
export const SHIP_EDGE = 0x7fc4ff;

/** kind 越界时仍退回暖红，绝不让未知敌人混进我方冷色。 */
export function enemyTint(kind: number): number {
  return ENEMIES[kind]?.tint ?? ENEMIES[0]!.tint;
}
