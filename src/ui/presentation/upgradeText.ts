/**
 * 升级候选展示 presenter(03 号)—— optionLabel 从 sim/upgrade 移出。
 * 候选名 = 塔名 / 法令名,一律委托 contentText 的 towerName / edictName(查 content 翻译),
 * 越界由它们吐带原始编号的本地化错误。sim 不认 locale(确定性边界),故本函数坐 ui 侧。
 */
import { OFFER_NEW_WEAPON, type UpgradeOption } from '../../sim/upgrade';
import { edictName, towerName } from './contentText';

/** 候选的名字:武器卡 = 塔名,法令卡 = 法令名(三选一卡面与换槽层共用,ui 不抄第二份) */
export function optionLabel(opt: UpgradeOption): string {
  if (opt.kind === OFFER_NEW_WEAPON) return towerName(opt.type);
  return edictName(opt.type);
}
