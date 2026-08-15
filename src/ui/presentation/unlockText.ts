/**
 * 解锁展示 presenter(03 号)—— unlockConditionText / unlockName 从 ui/codex / main 移出。
 * 名字按解锁条目 id 查 content.unlocks(资源即唯一翻译,key 与存档掩码解耦);
 * 条件文案按 COND_* 分派、阈值走 formatNumber;未知条件编号 → 本地化错误且带原始编号。
 */
import type { content as zhContent } from '../../i18n/resources/zh-CN/content';
import { t } from '../../i18n';
import { formatNumber } from '../../i18n/format';
import { COND_ELITE_KILLS, COND_FIRST_WIN, COND_KILLS, type UnlockEntry } from '../../data/unlocks';

/** content.unlocks 的条目名 key 空间:三条解锁 id(conditions 段不是条目名,unlockName 不查它) */
type UnlockId = Exclude<keyof (typeof zhContent)['unlocks'], 'conditions'>;

/** 解锁条目名:content.unlocks.<id>(资源 key 由解锁 id 键控,与存档掩码位解耦) */
export function unlockName(entry: UnlockEntry): string {
  return t(`content:unlocks.${entry.id as UnlockId}`);
}

/** 解锁条件文案:首次胜利 / 单局击杀 N / 累计精英击杀 N;未知条件编号 → 本地化错误 */
export function unlockConditionText(entry: UnlockEntry): string {
  switch (entry.condition.kind) {
    case COND_FIRST_WIN:
      return t('content:unlocks.conditions.firstWin');
    case COND_KILLS:
      return t('content:unlocks.conditions.kills', { target: formatNumber(entry.condition.target) });
    case COND_ELITE_KILLS:
      return t('content:unlocks.conditions.eliteKills', { target: formatNumber(entry.condition.target) });
    default:
      return t('content:unlocks.conditions.unknown', { kind: entry.condition.kind });
  }
}
