/**
 * 三选一升级流程 —— DOM 覆盖层(10 号 issue T4 改版),**永不 import pixi**(铁律 1 的另一半)。
 *
 * —— 甲板删除后的重写(用户设计会)——
 * 旧版「选卡 → 甲板放置」的两阶段状态机随甲板网格整段删除,现在是**点卡即结算**的单阶段流程:
 *   弹卡(读 world.offer,3 张)→ 点一张 → world.takeUpgrade 当场结算 → resolve()(收卡、恢复战斗在 main.ts)。
 * 唯一子阶段是「换槽」:武器槽全满时点新武器卡,takeUpgrade 返回 ACQUIRE_REPLACE_NEEDED,弹替换
 * 选择层列出当前 8 槽 → 点某一槽 → **带着槽位再调一次 takeUpgrade(choice, slotIndex)** —— world.ts
 * 的文档口径:替换由 takeUpgrade 内部走 replaceWeapon 并在那一次完成结算,这里绝不直接调
 * replaceWeapon(否则 completeUpgrade 不跑,同一张卡下一帧当场再弹)。替换层 Esc / 右键 / 「返回
 * 重选」只退回选卡(不扣费、不恢复战斗);选卡阶段唯一的出口是「跳过」(world.skipUpgrade);另有
 * 「重摇」(16 号)花 REROLL_PRICE 星币换一手牌,失败由返回码裁决,置灰只是"看就知道不行"。
 * **没有"什么都不选直接关掉"这条路**:费用是"这一次升级"本身,不消费的话 World 下一帧照样满足
 * scrap ≥ upgradeCost,当场再弹同一张卡。支援槽满(SUPPORT_FULL)是唯一"点卡但不结算"的拒绝:卡还在。
 *
 * 卡片上的名称 / 一句话描述 / 当前等级**一律从数值表现生成**(改数据文件即可调平衡,05 号验收),
 * 不给 data/towers、data/supports、data/edicts 加 desc 字段。
 *
 * 对外契约(改版后最小化):opts = `{ world, onResolved }`,接口 = show / hide / setWorld。main.ts 一侧
 * **不再有 setPlacement / syncHover / 画布拾格** —— 渲染层的 PlacementUiState 与本文件再无瓜葛;
 * 费用读数分两形态:玩家模式标题只写「世界已暂停 · 三选一」(残骸数由 HUD 管),?debug 时(与 main.ts
 * 同一条 URL 判定)才印 残骸/花费。
 */
import { REROLL_PRICE, skipRefundFor, UPGRADE_SKIP_FEE } from '../data/economy';
import { edictLevel, EDICT_MAX_LEVEL, EDICTS } from '../data/edicts';
import { mergeResultOf } from '../data/merges';
import { THR_AMMO, THR_CHARGE, THR_HEAT, type TowerDef, TOWERS, towerAoeDamage, towerArcDeg, towerBurst, towerChargeTime, towerDamage, towerFireInterval, towerRange } from '../data/towers';
import { slotMaxStars, slotStarCount, WEAPON_SLOT_COUNT } from '../sim/armory';
import { OFFER_NEW_WEAPON, UPGRADE_NO_OFFER, type UpgradeOption } from '../sim/upgrade';
import { ACQUIRE_INVALID_TYPE, ACQUIRE_REPLACE_NEEDED, EDICT_INVALID_TYPE, EDICT_MAXED, REROLL_ALREADY_DONE, REROLL_NO_STARCOINS, REPLACE_BAD_SLOT, REPLACE_INVALID_TYPE, type World } from '../sim/world';
import { audioBus } from '../render/audio';
import { isTyping } from '../core/isTyping';
import { t } from '../i18n';
import { towerName } from './presentation/contentText';
import { edictDesc } from './presentation/edictText';
import { optionLabel } from './presentation/upgradeText';

// 提示文字配色:成功 = 冷青蓝、拒绝 = 暖红(与渲染层高亮同色;冷色是我方色域,GDD §12)
const OK_COLOR = '#9adcff';
const DENY_COLOR = '#ff7a6b';
const IDLE_COLOR = '#5f7a99';
const VALUE_COLOR = '#c8dcf0';
const LINE_COLOR = '#2b4a6e'; // 船体冷色废铁本色,与结算界面/旧提示条的边框同一个值

// 卡片面板:贴屏幕底边、不铺满整屏(index.html 里 `#ui > *` 直接子元素 pointer-events:auto)
const PANEL_CSS =
  'position:fixed;inset:0;display:none;z-index:20;' +
  'flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:28px;' +
  'background:radial-gradient(ellipse at center,rgba(13,37,58,.72) 0%,rgba(4,8,14,.88) 72%);' +
  'font:13px/1.62 ui-monospace,SFMono-Regular,Menlo,monospace;user-select:none;' +
  'box-sizing:border-box;overflow:auto;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;';
const HEAD_CSS = `color:${IDLE_COLOR};letter-spacing:.08em;`;
const CARDS_CSS = 'display:flex;gap:12px;justify-content:center;flex-wrap:wrap;max-width:100%;';
// 一张卡。button 而不是 div:键盘能聚焦、回车能按,而"点了没反应"在时停里最难查
const CARD_CSS =
  'width:196px;padding:12px 14px;border-radius:8px;cursor:pointer;text-align:left;font:inherit;' +
  `background:rgba(10,16,26,.94);border:1px solid ${LINE_COLOR};color:${VALUE_COLOR};`;
const CARD_ICON_CSS =
  `color:${OK_COLOR};font-size:24px;line-height:1;text-align:center;margin-bottom:8px;` +
  'text-shadow:0 0 10px rgba(154,220,255,.42);';
const CARD_TITLE_CSS = `color:${OK_COLOR};font-size:15px;letter-spacing:.06em;margin-bottom:6px;`;
const CARD_DESC_CSS = 'min-height:3.2em;'; // 描述行留常驻高度:三张卡长短不一,不撑住则等级行参差
const CARD_LEVEL_CSS = `color:${IDLE_COLOR};margin-top:6px;`;
const CARD_COMPARE_CSS = `display:block;color:${VALUE_COLOR};font-size:11px;line-height:1.5;margin-top:4px;`;
const BTN_CSS =
  'min-height:40px;padding:7px 18px;border-radius:6px;cursor:pointer;font:inherit;' +
  `border:1px solid ${LINE_COLOR};background:rgba(43,74,110,.28);color:${OK_COLOR};letter-spacing:.1em;`;
// 换槽选择层(武器槽全满时的替换子阶段):居中列出当前 4 槽 + 返回按钮,盖在卡片面板上方
const PICKER_CSS =
  'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);display:none;' +
  'flex-direction:column;align-items:center;gap:10px;padding:16px 18px;border-radius:10px;' +
  `background:rgba(10,16,26,.96);border:1px solid ${LINE_COLOR};z-index:2;` +
  'font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;user-select:none;';
const SLOT_CSS =
  'width:210px;padding:9px 14px;border-radius:6px;cursor:pointer;text-align:left;font:inherit;' +
  `border:1px solid ${LINE_COLOR};background:rgba(43,74,110,.28);color:${VALUE_COLOR};`;
// 回执/拒绝提示条(左下角一行)。**pointer-events:none 是必须的**:它是 #ui 直接子元素,不摘掉会吃掉点击
const TOAST_CSS =
  'position:fixed;left:12px;bottom:12px;padding:8px 12px;border-radius:6px;display:none;' +
  `background:rgba(5,7,13,.72);border:1px solid ${LINE_COLOR};` +
  'font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre;' +
  'pointer-events:none;user-select:none;';
const FLASH_MS = 1400; // 提示条存留时长(ms)
const TRANSITION_CSS =
  'position:fixed;inset:0;display:none;z-index:30;align-items:center;justify-content:center;' +
  'pointer-events:none;background:radial-gradient(circle,rgba(154,220,255,.24) 0%,rgba(4,8,14,0) 58%);' +
  `color:${OK_COLOR};font:700 20px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;` +
  'letter-spacing:.14em;text-shadow:0 0 12px rgba(154,220,255,.9),0 0 34px rgba(154,220,255,.5);';
const TRANSITION_STYLE =
  '@keyframes starwreck-upgrade-spotlight{0%{opacity:0;transform:scale(.72)}18%{opacity:1;transform:scale(1)}72%{opacity:1;transform:scale(1.04)}100%{opacity:0;transform:scale(1.18)}}' +
  '.starwreck-upgrade-card,.starwreck-upgrade-action,.starwreck-upgrade-slot{touch-action:manipulation;}' +
  '.starwreck-upgrade-card:focus-visible,.starwreck-upgrade-action:focus-visible,.starwreck-upgrade-slot:focus-visible{' +
  'outline:2px solid #dff2ff;outline-offset:3px;box-shadow:0 0 0 4px rgba(154,220,255,.18);}' +
  '@media (max-width:720px){' +
  '.starwreck-upgrade-panel{justify-content:flex-start!important;gap:10px!important;' +
  'padding:max(16px,env(safe-area-inset-top)) max(14px,env(safe-area-inset-right)) ' +
  'max(18px,env(safe-area-inset-bottom)) max(14px,env(safe-area-inset-left))!important;}' +
  '.starwreck-upgrade-head{width:min(100%,430px);font-size:12px;text-align:center;}' +
  '.starwreck-upgrade-cards{width:min(100%,430px);flex-direction:column!important;flex-wrap:nowrap!important;gap:9px!important;}' +
  '.starwreck-upgrade-card{width:100%!important;min-height:0;padding:13px 14px!important;box-sizing:border-box;}' +
  '.starwreck-upgrade-actions{width:min(100%,430px);display:grid!important;grid-template-columns:1fr;gap:8px!important;}' +
  '.starwreck-upgrade-action{width:100%;min-height:44px;}' +
  '.starwreck-upgrade-picker{width:calc(100% - 28px);max-width:430px;max-height:calc(100% - 28px);' +
  'box-sizing:border-box;overflow:auto;padding:16px!important;}' +
  '.starwreck-upgrade-slots,.starwreck-upgrade-slot{width:100%!important;box-sizing:border-box;}' +
  '}' +
  '@media (max-height:620px){' +
  '.starwreck-upgrade-panel{justify-content:flex-start!important;gap:8px!important;padding-top:12px!important;}' +
  '.starwreck-upgrade-card{padding-top:9px!important;padding-bottom:9px!important;}' +
  '.starwreck-upgrade-icon{font-size:20px!important;margin-bottom:4px!important;padding:5px 0!important;}' +
  '}' +
  '@media (min-resolution:2dppx){' +
  '.starwreck-upgrade-panel,.starwreck-upgrade-picker{font-size:13.5px!important;line-height:1.65!important;}' +
  '.starwreck-upgrade-card,.starwreck-upgrade-action,.starwreck-upgrade-slot{border-color:#3d6288!important;}' +
  '}';

/**
 * 玩家模式不印残骸/花费(残骸数由 HUD 管);与 main.ts 同一条 ?debug 判定。
 * `typeof location !== 'undefined'` 那一手是给 Node 端的调用方兜底:本模块的**纯函数部分**
 * (edictDesc / cardDesc / denyMessage)被 ui/refitFlow.ts 复用,而那边的单测跑在无 DOM 的
 * Node 环境里 —— 模块级裸读 location 会让整个文件在 import 那一刻就炸,
 * 而它想要的只是两句文案。
 */
const DEBUG = typeof location !== 'undefined' && location.search.includes('debug');

// —— 流程阶段。三个值互斥:**收着 / 选卡 / 换槽** ——
const PHASE_OFF = 0;
const PHASE_PICK = 1;
const PHASE_REPLACE = 2;

/**
 * 理由码 → 拒绝文案的翻译入口(06 号迁移):从「码 → 中文字符串」改成「码 → key + vars」,
 * t() 在调用时按当前语言取值,漏码会走 `deny.unknown` 兜底串(带原始编号,不冒充成别的理由)。
 * 独立成纯函数、不碰 DOM,于是能在 Node 里单测。
 */
interface DenyEntry {
  key: string;
  vars?: Record<string, number>;
}
const DENY_MSGS: Record<number, DenyEntry> = {
  [UPGRADE_NO_OFFER]: { key: 'ui:upgrade.deny.noOffer' },
  // 满层是数据常量(EDICT_MAX_LEVEL),英文按 count 走 one/other 复数分支
  [EDICT_MAXED]: { key: 'ui:upgrade.deny.edictMaxed', vars: { count: EDICT_MAX_LEVEL } },
  [ACQUIRE_REPLACE_NEEDED]: { key: 'ui:upgrade.deny.replaceNeeded' },
  [REPLACE_BAD_SLOT]: { key: 'ui:upgrade.deny.badSlot' },
  // 两种"塔型越界"共用同一句(拒绝码不同,文案同源)
  [ACQUIRE_INVALID_TYPE]: { key: 'ui:upgrade.deny.invalidTower' },
  [REPLACE_INVALID_TYPE]: { key: 'ui:upgrade.deny.invalidTower' },
  [EDICT_INVALID_TYPE]: { key: 'ui:upgrade.deny.invalidEdict' },
  [REROLL_NO_STARCOINS]: { key: 'ui:upgrade.deny.noStarCoins', vars: { price: REROLL_PRICE } },
  [REROLL_ALREADY_DONE]: { key: 'ui:upgrade.deny.alreadyRerolled' },
};

/**
 * 动态 key 的 t() 调用:i18next 的插值参数类型按静态 key 展开,这里 key 是映射表里的字面量,
 * 统一放宽参数类型 —— key 是否正确由上面的映射表(与 zh/en 资源)保证,编译器不再逐处重查。
 */
function tDynamic(key: string, vars?: Record<string, number | string>): string {
  return (t as unknown as (key: string, vars?: Record<string, number | string>) => string)(key, vars);
}

export function denyMessage(code: number): string {
  const entry = DENY_MSGS[code];
  if (!entry) return t('ui:upgrade.deny.unknown', { code });
  return tDynamic(entry.key, entry.vars);
}

/** 卡片标题 = 候选的名字,**一律走 presentation 的 optionLabel**(它委托 towerName/edictName 查翻译),ui 不抄第二份 */
export function cardTitle(opt: UpgradeOption): string {
  return optionLabel(opt);
}

// 无外部资产的卡片图标:型号 = 数值表下标 → 几何符号,改名不会让图标走丢;未知型号显式报 ?。
// 两套符号各自独立(下标互不相干),按 data/towers(TOWER_*)与 data/edicts(EDICT_*)的编号排列;
// TOWER_ICONS 里 6..11 是合成塔(卡池不进,恒空位)。
// EDICT_ICONS 十一条:弹药/散热/电容/装甲/增幅/磁力/重心/巡航/星图/超载/增压
// 导出给 ui/codex 用:图鉴的无贴图条目(导弹巢/法令)拿同一套字形画程序化徽章,
// 升级卡片与图鉴于是共用一套"型号 → 符号"的身份,不让两个 UI 各抄一份。
export const TOWER_ICONS: string[] = ['▰', '◇', 'ϟ', '➠', '✣', '◉', '', '', '', '', '', '', '♁'];
export const EDICT_ICONS: string[] = ['▦', '≋', '⚡', '⬢', '✚', '◈', '⟲', '➤', '✧', '≫', '⤴'];
const EDICT_ART_URL = new URL('../../assets/game/ui/edict-seal.svg', import.meta.url).href;
const UPGRADE_ART_URL = new URL('../../assets/game/ui/upgrade-core.svg', import.meta.url).href;

function kindIcon(list: string[], type: number): string {
  return list[type] || '?';
}

export function cardIcon(opt: UpgradeOption): string {
  if (opt.kind === OFFER_NEW_WEAPON) return kindIcon(TOWER_ICONS, opt.type);
  return kindIcon(EDICT_ICONS, opt.type);
}

/** 数值印成字符串:先四舍五入到两位小数再交给 String(连乘会带出浮点毛刺,原样印是噪声) */
function num(v: number): string {
  return String(Math.round(v * 100) / 100);
}

// 节流系的**手感一句话**("为什么打不响"的武器卡专属念法,不是节流系名字 ——
// 系名走 presenter 的 throttleFamilyName,这里只是给"系名 + 括号一句手感"这格卡面配的补充文案)。
// 06 号迁移:数组改成「节流码 → 翻译 key」,t() 按当前语言取整句,不缓存任何语言的字符串为常量。
const THROTTLE_DESCS: Readonly<Record<number, string>> = {
  [THR_AMMO]: 'ui:upgrade.card.throttleDesc.ammo',
  [THR_HEAT]: 'ui:upgrade.card.throttleDesc.heat',
  [THR_CHARGE]: 'ui:upgrade.card.throttleDesc.charge',
};

function throttleDesc(throttle: number): string {
  const key = THROTTLE_DESCS[throttle];
  if (key === undefined) return tDynamic('ui:upgrade.card.throttleDesc.unknown', { throttle });
  return tDynamic(key);
}

/**
 * 表面 DPS(当前档现算):卡片弹出那一刻按数值表 + 星级算一遍,不印过期的数。
 * "表面" = 单目标持续输出的上限,不含装填/过热的停火窗与链跳/AoE 的群体收益;充能系节奏在
 * chargeTime;迫击炮的伤害全在落点(def.damage 恒 0),取 AoE 档。
 */
export function towerDps(def: TowerDef, stars: number): number {
  const dmg = def.damage > 0 ? towerDamage(def, stars) : towerAoeDamage(def, stars);
  const shots = towerBurst(def, stars);
  if (def.throttle === THR_CHARGE) {
    const charge = towerChargeTime(def, stars);
    return charge > 0 ? (dmg * shots) / charge : 0;
  }
  const interval = towerFireInterval(def, stars);
  return interval > 0 ? (dmg * shots) / interval : 0;
}

/**
 * 卡片的一句话描述 —— **全部从数值表现生成**(见文件头)。武器卡报
 * "射界档 / 射程 / 表面 DPS(1★)/ 节流系(含系名)"四样;法令念数值表里非中性的字段
 * (edictDesc 已移入 presentation/edictText,系法令自带系名前缀、全船法令自带「全船」前缀)。
 */
export function cardDesc(opt: UpgradeOption, _world?: World): string {
  if (opt.kind === OFFER_NEW_WEAPON) {
    const def = TOWERS[opt.type];
    if (!def) return tDynamic('ui:upgrade.card.unknownTower', { type: opt.type });
    // 四样分句翻译,再由 weaponDesc 的整句模板决定顺序(英文可重排),不按中文语序硬拼
    const arc = tDynamic('ui:upgrade.card.arc', { deg: num(towerArcDeg(def, 1)) });
    const range = tDynamic('ui:upgrade.card.range', { n: Math.round(towerRange(def, 1)) });
    const dps = tDynamic('ui:upgrade.card.dps', { dps: num(towerDps(def, 1)) });
    const throttle = throttleDesc(def.throttle);
    return tDynamic('ui:upgrade.card.weaponDesc', { arc, range, dps, throttle });
  }
  const def = EDICTS[opt.type];
  if (!def) return tDynamic('ui:upgrade.card.unknownEdict', { type: opt.type });
  return edictDesc(def);
}

/**
 * 卡片上的等级行。两类各有各的话要说:
 *   新武器按**槽里同型同星的实际把数**说话(三合一升星:同星凑满 3 把当场合一 ——
 *   下一张卡能不能当场触发要在卡面上说清,变身的名字在武器卡上够不着,这里先把入口说清楚);
 *   法令报**当前层 → 下一层**(「散热协议 ×2 → ×3」)—— 这就是"拿过两次就显示 ×2"那条要求的落点。
 */
export function cardLevelText(opt: UpgradeOption, world?: World): string {
  if (opt.kind === OFFER_NEW_WEAPON) {
    const weapons = world?.weapons;
    const c1 = weapons ? slotStarCount(weapons, opt.type, 1) : 0;
    const c2 = weapons ? slotStarCount(weapons, opt.type, 2) : 0;
    const c3 = weapons ? slotStarCount(weapons, opt.type, 3) : 0;
    if (c1 + c2 + c3 === 0) {
      // 没给 world(纯函数兜底)时用卡面自带的 opt.level 说话,数字只会更保守
      if (opt.level > 0) return tDynamic('ui:upgrade.level.alreadyHeld', { stars: '★'.repeat(opt.level) });
      return tDynamic('ui:upgrade.level.newWeapon');
    }
    // ★ ×N 的持有清单是符号 + 数量,跨语言中性,不做英文复数(句子本身整句翻译)
    const parts: string[] = [];
    if (c3 > 0) parts.push(`${'★'.repeat(3)} ×${c3}`);
    if (c2 > 0) parts.push(`${'★'.repeat(2)} ×${c2}`);
    if (c1 > 0) parts.push(`★ ×${c1}`);
    const holdings = parts.join(' ');
    const mergeable = mergeResultOf(opt.type) >= 0;
    // 下一张卡 = 一把 ★。两种"当场触发"要提前说:
    //   凑满三把 ★ 合一;若这一合让 ★★ 也凑满三把,连锁合到 ★★★(有配方 = 当场变身合成武器)
    if (c1 === 2 && c2 === 2) {
      return tDynamic('ui:upgrade.level.chainThree', {
        holdings,
        stars: '★'.repeat(3),
        synthesis: mergeable ? tDynamic('ui:upgrade.level.synthesisSuffix') : '',
      });
    }
    if (c1 === 2) return tDynamic('ui:upgrade.level.twoHoldings', { holdings, stars: '★'.repeat(2) });
    return tDynamic('ui:upgrade.level.alreadyHeld', { stars: holdings });
  }
  // 法令:当前层 → 下一层。满层那一档正常不会出现在候选里(卡池已剔),留一句兜底文案
  const lv = Math.max(0, Math.floor(opt.level));
  if (lv >= EDICT_MAX_LEVEL) return tDynamic('ui:upgrade.level.edictMaxed', { max: EDICT_MAX_LEVEL });
  if (lv <= 0) return tDynamic('ui:upgrade.level.edictNew', { max: EDICT_MAX_LEVEL });
  return tDynamic('ui:upgrade.level.edictProgress', { lv, lv1: lv + 1, max: EDICT_MAX_LEVEL });
}

/**
 * 卡片上的升星前后数值预览。它只读当前槽位并在内存中模拟“再拿一把”的合成链，
 * 不改 World、不消耗 rng；渲染层和 UI 都可以用同一份结果来表达即将发生的变化。
 */
export interface UpgradeComparison {
  readonly beforeType: number;
  readonly afterType: number;
  readonly beforeStars: number;
  readonly afterStars: number;
  readonly beforeDps: number | null;
  readonly afterDps: number | null;
  readonly beforeRange: number | null;
  readonly afterRange: number | null;
}

function previewWeapon(opt: UpgradeOption, world?: World): UpgradeComparison {
  const type = opt.type;
  const def = TOWERS[type];
  if (!def) {
    return {
      beforeType: type, afterType: type, beforeStars: 0, afterStars: 0,
      beforeDps: null, afterDps: null, beforeRange: null, afterRange: null,
    };
  }
  const counts = [0, 0, 0];
  for (const slot of world?.weapons ?? []) {
    if (slot.type === type && slot.stars >= 1 && slot.stars <= 3) counts[slot.stars - 1]!++;
  }
  let beforeStars = counts[2]! > 0 ? 3 : counts[1]! > 0 ? 2 : counts[0]! > 0 ? 1 : 0;
  const beforeType = type;
  // 这张卡等价于添一把 1★，然后按 World.fuseTriplesOf 的同一条链连锁合成。
  counts[0]!++;
  let afterType = type;
  for (let star = 0; star < 2; star++) {
    while (counts[star]! >= 3) {
      counts[star]! -= 3;
      counts[star + 1]!++;
      if (star === 1) {
        const result = mergeResultOf(afterType);
        if (result >= 0) afterType = result;
      }
    }
  }
  const afterStars = counts[2]! > 0 ? 3 : counts[1]! > 0 ? 2 : counts[0]! > 0 ? 1 : 0;
  // 没有传 World 时保守地按候选自身 level 推导，不虚构持有数量。
  if (!world && opt.level > 0) beforeStars = Math.min(3, Math.floor(opt.level));
  const afterDef = TOWERS[afterType] ?? def;
  return {
    beforeType,
    afterType,
    beforeStars,
    afterStars: Math.max(afterStars, beforeStars === 0 ? 1 : afterStars),
    beforeDps: beforeStars > 0 ? towerDps(def, beforeStars) : null,
    afterDps: towerDps(afterDef, Math.max(afterStars, beforeStars === 0 ? 1 : afterStars)),
    beforeRange: beforeStars > 0 ? towerRange(def, beforeStars) : null,
    afterRange: towerRange(afterDef, Math.max(afterStars, beforeStars === 0 ? 1 : afterStars)),
  };
}

export function upgradeComparison(opt: UpgradeOption, world?: World): UpgradeComparison {
  if (opt.kind === OFFER_NEW_WEAPON) return previewWeapon(opt, world);
  const level = Math.max(0, Math.min(EDICT_MAX_LEVEL, Math.floor(opt.level)));
  return {
    beforeType: opt.type,
    afterType: opt.type,
    beforeStars: level,
    afterStars: Math.min(EDICT_MAX_LEVEL, level + 1),
    beforeDps: null,
    afterDps: null,
    beforeRange: null,
    afterRange: null,
  };
}

function fmtPreviewNumber(value: number | null): string {
  return value === null ? '—' : num(value);
}

/** 视觉层的一行短文案；数字仍来自 upgradeComparison 的纯结果,句式按语言整句翻译。 */
export function upgradeComparisonText(opt: UpgradeOption, world?: World): string {
  const c = upgradeComparison(opt, world);
  if (opt.kind !== OFFER_NEW_WEAPON) {
    return tDynamic('ui:upgrade.comparison.edict', { before: c.beforeStars, after: c.afterStars });
  }
  return tDynamic('ui:upgrade.comparison.weapon', {
    bd: fmtPreviewNumber(c.beforeDps),
    ad: fmtPreviewNumber(c.afterDps),
    br: fmtPreviewNumber(c.beforeRange),
    ar: fmtPreviewNumber(c.afterRange),
  });
}

/** 跳过返还 = cost − 手续费。**与 World.skipUpgrade 调的是同一个 skipRefundFor**:分家的话提示与到账会各走各的 */
export function skipRefund(cost: number): number {
  return skipRefundFor(cost);
}

// 焦点在输入框里 → 数字键/Esc 是在打字,不该被当成选卡/取消抢走。
// 判据走共享模块(二轮审查:本文件曾是全仓第四份拷贝,口径漂移隐患)

/** 三选一升级流程的对外面孔。main.ts 在 onUpgradeOffer 里 show、结算完由 onResolved 接手 */
export interface UpgradeFlowUi {
  /** 换掉整局的 World(重开 = 换新 World,这条交互必须跟着改指向,否则点下去的全落进上一局) */
  setWorld(world: World): void;
  /** 读 world.offer 弹卡(main.ts 在 onUpgradeOffer 里调,时停在那一侧) */
  show(): void;
  /** 收卡。**不恢复战斗、不动 loop** —— 那是 main.ts 的事(World 与 ui 都不认识"游戏流程") */
  hide(): void;
  /**
   * 语言切换后原地重画(06 号):候选卡 / 头部 / 按钮 / 替换层标签走当前语言。
   * **只改 textContent,不改 phase / chosen / World** —— 不重掷候选、不消费 rng、
   * 不自动选卡、不关面板、不恢复战斗;PHASE_OFF(面板收着)时是无操作。
   */
  refreshLocale(): void;
}

/** 改版后的最小契约:只剩 World 与结算回调。画布/拾格/渲染层状态随放置阶段一起删除 */
export interface UpgradeFlowOpts {
  world: World;
  /** 结算完(取用成功 / 跳过 / 卡片过期)→ main 收卡、恢复战斗。本文件不认识 loop,也不动 run */
  onResolved(): void;
}

/** 一张卡的图标 + 四块文本节点。整局复用同一批元素,弹一次卡只改 textContent */
interface CardEls {
  root: HTMLButtonElement;
  icon: HTMLDivElement;
  title: HTMLDivElement;
  desc: HTMLDivElement;
  /** 等级主行(新武器报持有/合成,法令报层数) */
  level: HTMLDivElement;
  /** 升星前后数值预览副行(与主行是兄弟节点,各自 textContent —— 翻译串永不进 innerHTML) */
  preview: HTMLDivElement;
}

export function createUpgradeFlow(opts: UpgradeFlowOpts): UpgradeFlowUi {
  // world 是**可重赋的局部变量**而不是解构常量:重开一局换掉整个 World(见 setWorld),
  // 闭包里每处(choose / skip / reroll)都是现读它 —— 换引用这一件事就够了,监听器与 DOM 不必重挂。
  let world = opts.world;
  const { onResolved } = opts;

  function makeDiv(css: string): HTMLDivElement {
    const el = document.createElement('div');
    el.style.cssText = css;
    return el;
  }
  function makeBtn(css: string, text: string): HTMLButtonElement {
    const el = document.createElement('button');
    el.style.cssText = css;
    el.textContent = text;
    return el;
  }

  // —— DOM:卡片面板 + 换槽选择层 + 提示条 + 升星过场,append 进 #ui,行内 style ——
  const headEl = makeDiv(HEAD_CSS);
  headEl.className = 'starwreck-upgrade-head';
  const cardsEl = makeDiv(CARDS_CSS);
  cardsEl.className = 'starwreck-upgrade-cards';
  const rerollBtn = makeBtn(BTN_CSS, '');
  const skipBtn = makeBtn(BTN_CSS, '');
  const btnRow = makeDiv('display:flex;gap:10px;');
  rerollBtn.className = 'starwreck-upgrade-action';
  skipBtn.className = 'starwreck-upgrade-action';
  btnRow.className = 'starwreck-upgrade-actions';
  btnRow.append(rerollBtn, skipBtn);
  const panel = makeDiv(PANEL_CSS);
  panel.className = 'starwreck-upgrade-panel';
  panel.append(headEl, cardsEl, btnRow);

  const pickerTitle = makeDiv(HEAD_CSS);
  const pickerSlots = makeDiv('display:flex;flex-direction:column;gap:8px;');
  const pickerBack = makeBtn(BTN_CSS, '');
  const picker = makeDiv(PICKER_CSS);
  picker.className = 'starwreck-upgrade-picker';
  pickerSlots.className = 'starwreck-upgrade-slots';
  pickerBack.className = 'starwreck-upgrade-action';
  picker.append(pickerTitle, pickerSlots, pickerBack);

  const toast = makeDiv(TOAST_CSS);
  const transition = makeDiv(TRANSITION_CSS);
  // 占位:过场只在 playUpgradeTransition 里现设文案后显示,这里不必预填任何语言
  transition.textContent = '';
  const ui = document.getElementById('ui')!;
  const styleEl = document.createElement('style');
  styleEl.textContent = TRANSITION_STYLE;
  document.head?.appendChild(styleEl);
  ui.appendChild(panel);
  ui.appendChild(picker);
  ui.appendChild(toast);
  ui.appendChild(transition);

  const cards: CardEls[] = [];
  const slotBtns: HTMLButtonElement[] = [];
  for (let i = 0; i < WEAPON_SLOT_COUNT; i++) {
    const btn = makeBtn(SLOT_CSS, '');
    btn.className = 'starwreck-upgrade-slot';
    const index = i;
    btn.addEventListener('click', () => confirmReplace(index));
    pickerSlots.appendChild(btn);
    slotBtns.push(btn);
  }

  let phase = PHASE_OFF;
  let chosen = -1; // 待结算的候选在 world.offer 里的下标;-1 = 还没选。takeUpgrade 收的就是它
  let flashTimer = 0;

  /** 建一张卡。**只在这里建**,建好就整局复用(弹卡只改 textContent) */
  function createCard(index: number): CardEls {
    const root = makeBtn(CARD_CSS, '');
    const icon = makeDiv(CARD_ICON_CSS);
    root.className = 'starwreck-upgrade-card';
    icon.className = 'starwreck-upgrade-icon';
    const title = makeDiv(CARD_TITLE_CSS);
    const desc = makeDiv(CARD_DESC_CSS);
    const level = makeDiv(CARD_LEVEL_CSS);
    const preview = makeDiv(CARD_COMPARE_CSS);
    root.append(icon, title, desc, level, preview);
    root.addEventListener('click', () => choose(index));
    cardsEl.appendChild(root);
    return { root, icon, title, desc, level, preview };
  }

  /** 抹掉提示条并停掉它的计时器(退回选卡与重开一局共用) */
  function clearFlash(): void {
    if (flashTimer) window.clearTimeout(flashTimer);
    flashTimer = 0;
    toast.textContent = '';
    toast.style.display = 'none';
  }

  /** 闪一句话。连点时重置计时:上一次的超时不该把这一次的提示提前抹掉 */
  function flash(text: string, color: string): void {
    toast.textContent = text;
    toast.style.color = color;
    toast.style.display = 'block';
    if (flashTimer) window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => {
      flashTimer = 0;
      toast.textContent = '';
      toast.style.display = 'none';
    }, FLASH_MS);
  }

  function playUpgradeTransition(opt: UpgradeOption, comparison = upgradeComparison(opt, world)): void {
    const isStarUpgrade = opt.kind === OFFER_NEW_WEAPON
      ? comparison.beforeStars > 0 && comparison.afterStars > comparison.beforeStars
      : comparison.beforeStars > 0 && comparison.afterStars > comparison.beforeStars;
    if (!isStarUpgrade) return;
    const label = opt.kind === OFFER_NEW_WEAPON
      ? tDynamic('ui:upgrade.transition.starUpgrade', {
          title: cardTitle(opt),
          stars: '★'.repeat(comparison.afterStars),
        })
      : tDynamic('ui:upgrade.transition.edictUpgrade', {
          title: cardTitle(opt),
          lv: comparison.afterStars,
        });
    transition.textContent = label;
    transition.style.display = 'flex';
    transition.style.animation = 'none';
    // 强制一次 reflow 让连续两次升星也能重新触发专属过场。
    void (transition as unknown as { offsetWidth?: number }).offsetWidth;
    transition.style.animation = 'starwreck-upgrade-spotlight 420ms ease-out both';
    window.setTimeout(() => {
      transition.style.display = 'none';
      transition.style.animation = '';
    }, 460);
  }

  /** 重摇按钮的置灰态,每次弹卡 / 重摇之后现读 World 刷新一次:星币不足或本档已摇过都不可点(置灰只是读数,裁决以返回码为准) */
  function syncRerollState(): void {
    const enabled = world.starCoins >= REROLL_PRICE && !world.offerRerolled;
    rerollBtn.disabled = !enabled;
    rerollBtn.style.opacity = enabled ? '1' : '0.5';
    rerollBtn.style.cursor = enabled ? 'pointer' : 'not-allowed';
  }

  /** 刷面板头与按钮:玩家模式不印残骸/花费(?debug 才印,与 main.ts 同一条判定);重摇按钮文案也在这里现取 */
  function syncPanel(): void {
    headEl.textContent = DEBUG
      ? tDynamic('ui:upgrade.head.debug', { scrap: Math.round(world.scrap), cost: world.upgradeCost })
      : tDynamic('ui:upgrade.head.paused');
    rerollBtn.textContent = tDynamic('ui:upgrade.reroll', { price: REROLL_PRICE });
    syncRerollState();
  }

  /** 把 world.offer 摊到卡片上。元素复用,多出来的藏起来(offer 可能不足三张) */
  function renderCards(): void {
    const offer = world.offer;
    // 按需补卡:数量以 world.offer 为准,不去读 UPGRADE_CHOICE_COUNT ——
    // 候选数是 sim 那边的事,ui 照着一个常量摆卡就等于埋一处"数值表调了、面板没跟上"
    for (let i = cards.length; i < offer.length; i++) cards.push(createCard(i));
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i]!;
      const opt = offer[i];
      if (!opt) {
        card.root.style.display = 'none';
        continue;
      }
      card.root.style.display = 'block';
      card.icon.textContent = cardIcon(opt);
      card.icon.style.backgroundImage = `url("${opt.kind === OFFER_NEW_WEAPON ? UPGRADE_ART_URL : EDICT_ART_URL}")`;
      card.icon.style.backgroundSize = '54px 54px';
      card.icon.style.backgroundRepeat = 'no-repeat';
      card.icon.style.backgroundPosition = 'center';
      card.icon.style.padding = '12px 0';
      card.icon.style.borderRadius = '8px';
      card.title.textContent = cardTitle(opt);
      card.desc.textContent = cardDesc(opt, world);
      // 等级主行与预览副行是**两个兄弟节点**,各自 textContent —— 翻译串与预览串都不进 innerHTML
      card.level.textContent = cardLevelText(opt, world);
      card.preview.textContent = upgradeComparisonText(opt, world);
    }
    skipBtn.textContent = tDynamic('ui:upgrade.skip', {
      fee: UPGRADE_SKIP_FEE,
      refund: skipRefund(world.upgradeCost),
    });
  }

  function hide(): void {
    phase = PHASE_OFF;
    chosen = -1;
    panel.style.display = 'none';
    picker.style.display = 'none';
  }

  /**
   * 这一次升级结算完了(取用成功 / 跳过 / 卡片过期)。先收面板再回调:main 那边也会 hide 一次,
   * 但"结算完就该消失"不该依赖调用方记得那一句。提示条**不清**:那行回执要留到战斗恢复后读。
   */
  function resolve(): void {
    hide();
    onResolved();
  }

  /**
   * 取用成功后的回执文案,按两类各说各的话。**在 takeUpgrade 之后调用**,星级/层数
   * 一律现读 World —— 卡片承诺的是"点下去之后",回执说的就是"点下去之后"。
   * 新武器卡按"点前 → 点后"的差说话:落了新 ★(获得)/ 三合一升星(合到 ★★/★★★)/
   * 合到 ★★★ 变身(名字直取合成结果)。beforeMax/beforeResult 是点卡前的快照。
   */
  function successToast(opt: UpgradeOption, beforeMax: number, beforeResult: number): string {
    const label = optionLabel(opt);
    if (opt.kind === OFFER_NEW_WEAPON) {
      const result = mergeResultOf(opt.type);
      const afterResult = result >= 0 ? slotStarCount(world.weapons, result, 3) : 0;
      if (afterResult > beforeResult) {
        return tDynamic('ui:upgrade.toast.transformed', { label, name: towerName(result) });
      }
      const afterMax = slotMaxStars(world.weapons, opt.type);
      if (afterMax > beforeMax) return tDynamic('ui:upgrade.toast.fusedTo', { label, stars: '★'.repeat(afterMax) });
      return tDynamic('ui:upgrade.toast.gotWeapon', { label });
    }
    // 法令:层数现读 World(grantEdict 已经加过一层)—— 这就是"拿过两次过热上限就显示 ×2"
    const lv = edictLevel(world.edictLevels, opt.type);
    return lv >= 2 ? tDynamic('ui:upgrade.toast.edictLevel', { label, lv }) : tDynamic('ui:upgrade.toast.edictActive', { label });
  }

  /** 点卡前的武器快照:回执按"点前 → 点后"的差说话(见 successToast) */
  function weaponSnapshot(opt: UpgradeOption): { max: number; result: number } {
    if (opt.kind !== OFFER_NEW_WEAPON) return { max: 0, result: 0 };
    const result = mergeResultOf(opt.type);
    return {
      max: slotMaxStars(world.weapons, opt.type),
      result: result >= 0 ? slotStarCount(world.weapons, result, 3) : 0,
    };
  }

  /**
   * 点一张卡 → **当场结算**(没有放置阶段)。成败全以 world.takeUpgrade 的返回码为准:
   *   成功(≥ 0)→ 回执 + resolve;新武器槽满(ACQUIRE_REPLACE_NEEDED)→ 进换槽子阶段;
   *   待选没了(UPGRADE_NO_OFFER)→ 说清楚并放行;其余拒绝(SUPPORT_FULL 等)→ 闪红说人话,
   *   **一分不扣、一帧不恢复**,卡还留着。
   */
  function choose(index: number): void {
    if (phase !== PHASE_PICK) return;
    const opt = world.offer[index];
    // 越界/空卡:候选比卡片少时那张卡本就是藏起来的,这一句是拦网
    if (!opt) return;
    const preview = upgradeComparison(opt, world);
    const before = weaponSnapshot(opt);
    const code = world.takeUpgrade(index);
    if (code >= 0) {
      flash(successToast(opt, before.max, before.result), OK_COLOR);
      playUpgradeTransition(opt, preview);
      audioBus.playPlace();
      resolve();
      return;
    }
    if (code === UPGRADE_NO_OFFER) {
      flash(denyMessage(code), DENY_COLOR);
      resolve();
      return;
    }
    if (code === ACQUIRE_REPLACE_NEEDED) {
      chosen = index;
      showPicker();
      return;
    }
    flash(denyMessage(code), DENY_COLOR);
  }

  /** 换槽层的标题 + 槽位标签。抽成独立函数:showPicker 与 refreshLocale 共用一份当前语言的重画 */
  function renderPickerLabels(): void {
    const opt = world.offer[chosen];
    pickerTitle.textContent = opt
      ? tDynamic('ui:upgrade.picker.title', { label: optionLabel(opt) })
      : tDynamic('ui:upgrade.picker.titleFull');
    pickerBack.textContent = tDynamic('ui:upgrade.picker.back');
    for (let i = 0; i < WEAPON_SLOT_COUNT; i++) {
      const btn = slotBtns[i]!;
      const slot = world.weapons[i];
      if (!slot || slot.type < 0) {
        btn.disabled = true;
        btn.style.opacity = '0.4';
        btn.textContent = tDynamic('ui:upgrade.picker.slotEmpty', { i });
        continue;
      }
      const def = TOWERS[slot.type];
      btn.disabled = false;
      btn.style.opacity = '1';
      btn.textContent = def === undefined
        ? tDynamic('ui:upgrade.picker.slotUnknown', { i, type: slot.type })
        : tDynamic('ui:upgrade.picker.slotTaken', {
            i,
            name: towerName(slot.type),
            stars: '★'.repeat(slot.stars),
          });
    }
  }

  /** 换槽选择层:列出当前 8 槽,点某一槽 = 带着槽位把这张卡再结算一次 */
  function showPicker(): void {
    renderPickerLabels();
    phase = PHASE_REPLACE;
    clearFlash();
    panel.style.display = 'none';
    picker.style.display = 'flex';
  }

  /**
   * 点替换层里的某一槽。**不直接调 replaceWeapon**:world.ts 的口径是带 slotIndex 再调一次
   * takeUpgrade,由它内部当场替换并完成结算(completeUpgrade 也在那一次跑,否则 offer 不清空,
   * 同一张卡下一帧当场再弹)。opt 在调用前先抓住 —— 结算成功后 world.offer 已被清空,回执还要用它。
   */
  function confirmReplace(slotIndex: number): void {
    if (phase !== PHASE_REPLACE) return;
    const opt = world.offer[chosen];
    if (!opt) {
      flash(denyMessage(UPGRADE_NO_OFFER), DENY_COLOR);
      resolve();
      return;
    }
    const before = weaponSnapshot(opt);
    const preview = upgradeComparison(opt, world);
    const code = world.takeUpgrade(chosen, slotIndex);
    if (code >= 0) {
      flash(successToast(opt, before.max, before.result), OK_COLOR);
      playUpgradeTransition(opt, preview);
      audioBus.playPlace();
      resolve();
      return;
    }
    if (code === UPGRADE_NO_OFFER) {
      flash(denyMessage(code), DENY_COLOR);
      resolve();
      return;
    }
    // 替换失败(正常点不出来):留在替换层,可换一个槽或退回重选
    flash(denyMessage(code), DENY_COLOR);
  }

  /** 退回选卡(Esc / 右键 / 「返回重选」)。**不扣费、不恢复战斗** */
  function cancelReplace(): void {
    if (phase !== PHASE_REPLACE) return;
    chosen = -1;
    phase = PHASE_PICK;
    picker.style.display = 'none';
    panel.style.display = 'flex';
    clearFlash();
    syncPanel();
  }

  /**
   * 跳过这一次升级(手续费制,见 data/economy 的 UPGRADE_SKIP_FEE)。**照样是一次结算** ——
   * World 扣费、按 cost − 手续费返还、upgrades++、清空 offer,于是下一帧不会再弹同一张卡,
   * 而下一档的三张是全新候选(= 付费重随)。
   */
  function skip(): void {
    if (phase !== PHASE_PICK) return;
    const refund = skipRefund(world.upgradeCost);
    if (world.skipUpgrade()) flash(tDynamic('ui:upgrade.flash.skip', { fee: UPGRADE_SKIP_FEE, refund }), OK_COLOR);
    // 无待选(理论上这张卡根本不该在屏幕上)也照样放行:留在这儿就是个点什么都没用的面板
    else flash(denyMessage(UPGRADE_NO_OFFER), DENY_COLOR);
    resolve();
  }

  /**
   * 重摇这一手牌(16 号):花 REROLL_PRICE 星币,让 World 重掷三个候选。
   * **不结算、不恢复战斗** —— 重摇只是换一手牌,时停要继续停到这一次升级真的结算掉为止。
   * 失败按返回码处理(星币不足 / 本档已摇过 → 重刷置灰态;待选没了 → 说清楚并放行)。
   */
  function reroll(): void {
    if (phase !== PHASE_PICK || rerollBtn.disabled) return;
    const code = world.rerollOffer();
    if (code > 0) {
      renderCards();
      syncPanel();
      flash(tDynamic('ui:upgrade.flash.rerolled', { price: REROLL_PRICE }), OK_COLOR);
      return;
    }
    if (code === REROLL_NO_STARCOINS || code === REROLL_ALREADY_DONE) {
      // 失败的原因恰好就是置灰的两个条件:重刷一次置灰态,让按钮与账目重新对齐
      syncRerollState();
      return;
    }
    flash(denyMessage(code), DENY_COLOR);
    resolve();
  }

  skipBtn.addEventListener('click', skip);
  rerollBtn.addEventListener('click', reroll);
  pickerBack.addEventListener('click', cancelReplace);

  window.addEventListener('keydown', (e) => {
    // 收着的时候一律不认:战斗中按 Esc/数字键不该动到升级流程
    if (phase === PHASE_OFF || e.repeat || isTyping()) return;
    if (e.code === 'Escape') {
      e.preventDefault();
      if (phase === PHASE_REPLACE) {
        cancelReplace();
      } else {
        // 选卡阶段的 Esc(二轮审查):不绑"跳过" —— 误触一记 Esc 不该扣 15 残骸手续费;
        // 但也不许是静默死键(全游戏其他覆盖层都认 Esc),flash 指路即可
        flash(tDynamic('ui:upgrade.flash.pickHint'), OK_COLOR);
      }
      return;
    }
    // 数字键直选卡片(1..N = 从左到右)。只认主键盘的 DigitN。换槽阶段不认数字键
    if (phase !== PHASE_PICK || !e.code.startsWith('Digit')) return;
    const n = Number(e.code.slice(5));
    if (Number.isInteger(n) && n >= 1) choose(n - 1);
  });

  // 右键 = 退回选卡的通用手势。卡片/替换层一弹出来就挡掉浏览器菜单(时停期间那张系统菜单
  // 会盖在甲板上,收掉它之前玩家什么都点不了);战斗中(PHASE_OFF)则一律不管
  document.addEventListener('contextmenu', (e) => {
    if (phase === PHASE_OFF) return;
    e.preventDefault();
    cancelReplace();
  });

  return {
    show(): void {
      // 没有待选却被弹起来(World 只在真的生成了候选时才响 onUpgradeOffer,这一句是拦网):
      // 空面板会把玩家永久卡在时停里,故当场说清楚并放行
      if (world.offer.length === 0) {
        flash(denyMessage(UPGRADE_NO_OFFER), DENY_COLOR);
        resolve();
        return;
      }
      phase = PHASE_PICK;
      chosen = -1;
      renderCards();
      syncPanel();
      picker.style.display = 'none';
      panel.style.display = 'flex';
      // 弹卡那一刻的"弹出"音;空 offer 的早退路径在上面已 return,不会走到这
      audioBus.playUpgrade();
    },
    hide,
    // 语言切换后原地重画文案(06 号)。只写 textContent / 现读 t():
    //   renderCards 只重画既有卡与跳过按钮,不新增 DOM(offer 没变,补卡循环不会跑)、
    //   不重掷候选、不消费 rng;syncPanel 重画头部与重摇按钮;换槽层开着时槽位标签当场翻新。
    //   **phase / chosen / World 一律不动** —— 切语言不自动选卡、不关面板、不恢复战斗。
    refreshLocale(): void {
      if (phase === PHASE_OFF) return;
      renderCards();
      syncPanel();
      renderPickerLabels();
    },
    setWorld(next: World): void {
      world = next;
      // 面板整个收掉、阶段回到"收着":offer 是**上一局**的候选、chosen 是它的下标 ——
      // 留着就会拿新世界的 offer 去兑上一局的选择,或者对着一张空 offer 点确认。
      // **不调 onResolved**:恢复战斗是 main.ts 重开流程自己的一步(run.paused 在那边),
      // 这里替它调一次,反而会在装配到一半时把上一局的收尾动作跑出来
      hide();
      // 上一局最后那条提示(连同它的超时)一并抹掉:新船开出去的第一眼不该挂着上一局的回执
      clearFlash();
      transition.style.display = 'none';
      transition.style.animation = '';
    },
  };
}
