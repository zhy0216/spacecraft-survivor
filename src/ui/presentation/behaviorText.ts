/**
 * 敌型行为展示 presenter(03 号)—— behaviorName 从 ui/codex 移出,改用 content.behaviors 翻译。
 * 越界(数值表被改坏) → 本地化错误且带原始编号,不静默兜底成某个已知行为。
 */
import { BH_SEEK, BH_SEEK_CHARGE, BH_SPORE, BH_STRAFE, BH_STRAFE_CHARGE } from '../../data/enemies';
import { t } from '../../i18n';

/**
 * 敌型行为短标签:图鉴只要"这一型怎么打"的一行直觉,不要状态机的全文。
 * 文案取自 content.behaviors(直线追船 / 侧向驻留 / 侧向冲锋 / 直线冲锋 / 远程喷吐)。
 */
export function behaviorName(bh: number): string {
  switch (bh) {
    case BH_SEEK:
      return t('content:behaviors.seek');
    case BH_STRAFE:
      return t('content:behaviors.strafe');
    case BH_STRAFE_CHARGE:
      return t('content:behaviors.strafeCharge');
    case BH_SEEK_CHARGE:
      return t('content:behaviors.seekCharge');
    case BH_SPORE:
      return t('content:behaviors.spore');
    default:
      return t('content:errors.unknownBehavior', { bh });
  }
}
