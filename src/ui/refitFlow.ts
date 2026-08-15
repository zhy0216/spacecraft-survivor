/**
 * 航段整备流程 —— 纯商店(改版:甲板网格删除后的落点)。
 * 旧版的「左甲板工作区 + 三阶段(选拼块/焊接/重排)+ 空间进化」随甲板一起删除,
 * 本流程剩两块:**中间舰船背包**(ui/shipDiagram)+ **右侧一栏商店** ——
 * 武器商店(30 ★/把,各 3 张货架,不满 10 ★ 刷新,槽满转到舰船上点一格替换)、
 * 法令卡(25 ★ 即时生效、无占槽)、付费修复(25 ★ 回 40% HP,满血置灰)、完成整备
 * (completeRefit → hide + onResolved,恢复战斗在 main.ts)。与普通升级彻底分开:
 * 不消费残骸、不生成三选一、没有战斗中可调用的入口;购买全部零 rng,ui 只照返回码说人话。
 *
 * —— 商店优化(打折机制 + 余额搬家)——
 * 每次上架(跨段掷定 / 刷新货架)恰有一件商品打 SHOP_DISCOUNT_FRACTION 折:特价位的卡片
 * 原价划线、特价亮金(与星币同款金色)。店头**不再印星币余额** —— 左上统计版(HUD 左列)
 * 的 ★ 星币常驻显示且与商店同款金色,店里的钱袋读数整个挪过去,店头只留标题。
 * 特价数走 data/economy 的 shopDiscountPrice:与 World 扣费共用同一份算法,印多少扣多少。
 *
 * —— 为什么商店里要画船(用户反馈)——
 * 商店搬上地图后,买东西这一刻玩家已经离开了战斗视角:货架上写着"磁轨炮 30 ★",
 * 但"我现在有几把炮、哪个方向是缺口、这把买回来装哪儿"三问全靠记。中间的舰船背包就是答案 ——
 * 八个槽按真实朝向围一圈、每把武器画出自己的射界扇形;**悬停一张货架卡**,它就以幽灵态
 * 虚装到即将落位的那一格上(槽满时则跟着鼠标落在待替换的那一格),于是"买它会变成什么样"
 * 是买之前看得见的事,而不是买完才知道。
 *
 * —— 替换(武器槽满时)——
 * buyShopWeapon(index) 在槽满且没给替换位时,同型已有两把 1★ 会**吸收合成**
 * (3 把合 1 把、不占槽、当场成功);否则返回 ACQUIRE_REPLACE_NEEDED —— **不扣星币、
 * 货架不动**(world.ts 的 doc 原文),于是"选槽失败/取消"天然一分钱不扣。
 * 面板转入 pick 态:**玩家在中间舰船背包上点一个槽** → 带着 slotIndex 重买一次
 * (buyShopWeapon(index, slotIndex) 内部完成换装/扣费/下架/查三合一)。
 * 换成在船上点而不是在侧栏列 8 行,是因为要换掉哪一把取决于"它朝哪、射界多宽" ——
 * 那正是列表读不出、非得看图的东西。**不单独调 replaceWeapon**:它不扣星币,
 * 先换再买会白送一把武器。
 *
 * —— 对外接口(main.ts 照此接线)——
 * RefitFlowOpts = { world, onResolved };canvas / screenToDeckLocal / onLayout 已随甲板删除。
 * 生命周期:每局只建一次 → setWorld(world) → show(segmentIndex)(onRefitOffer 里调,
 * 暂停归 main)→ hide() / onResolved()(run.paused = false 在 main.ts)。
 * RefitFlowUi 不再 extends PlacementUiState:纯商店没有拾格/高亮,渲染层不再接它。
 */
import { slotMaxStars, slotStarCount, WEAPON_SLOT_COUNT } from '../sim/armory';
import {
  DOCK_EDICT_COUNT,
  DOCK_EDICT_PRICE,
  DOCK_REPAIR_FRACTION,
  DOCK_REPAIR_PRICE,
  DOCK_SHOP_REFRESH_PRICE,
  DOCK_WEAPON_COUNT,
  DOCK_WEAPON_PRICE,
  shopDiscountPrice,
} from '../data/economy';
import { edictDesc, EDICTS } from '../data/edicts';
import { mergeResultOf } from '../data/merges';
import { TOWERS } from '../data/towers';
import { WAVE_SEGMENTS } from '../data/waves';
import {
  ACQUIRE_REPLACE_NEEDED,
  DOCK_EDICT_SOLD,
  DOCK_HP_FULL,
  DOCK_NO_STARCOINS,
  REFIT_NOT_ACTIVE,
  SHOP_NO_REFRESH_STARCOINS,
  SHOP_NO_STARCOINS,
  SHOP_WEAPON_SOLD,
  type World,
} from '../sim/world';
import { audioBus } from '../render/audio';
import {
  edictArt,
  edictHover,
  towerArt,
  weaponHover,
  type CodexArt,
} from './codex';
import {
  createShipDiagram,
  SLOT_FACING_NAME,
  type ShipDiagramState,
  type ShipDiagramUi,
} from './shipDiagram';

const OK_COLOR = '#9adcff';
const DENY_COLOR = '#ff7a6b';
const TEXT_COLOR = '#c8dcf0';
const MUTED_COLOR = '#6f89a5';
const LINE_COLOR = '#2b4a6e';
const STAR_COLOR = '#ffd86e';
const ROOT_CSS =
  'position:fixed;inset:0;z-index:20;display:none;pointer-events:none!important;' +
  // 淡幕从 HUD 左列的右边才开始:左列最宽 300px + 48px 边距，再留 12px 呼吸缝。
  // 这样星币/船体/火力面板与背包一样清晰，中央战场仍会逐渐压暗以托住舰船图。
  'background:linear-gradient(90deg,transparent 0,transparent 360px,rgba(4,8,14,.42) 460px,rgba(3,6,11,.68) 100%);' +
  `color:${TEXT_COLOR};font:13px/1.58 ui-monospace,SFMono-Regular,Menlo,monospace;user-select:none;` +
  '-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;';
/**
 * 舰船背包的容器:桌面端相对**整块屏幕**居中,不再按「扣掉右侧商店」后的剩余区域居中。
 * 右侧货架有更高的层级，窄屏上两者一旦交叠，仍由货架盖住背包边缘，不会挡住购买操作。
 */
const BOARD_WRAP_CSS =
  'position:absolute;inset:0;z-index:1;display:flex;align-items:center;' +
  'justify-content:center;padding:20px;box-sizing:border-box;overflow:auto;pointer-events:none;';
const SHOP_CSS =
  'position:absolute;right:0;top:0;z-index:2;height:100%;width:340px;box-sizing:border-box;display:flex;' +
  'pointer-events:auto;flex-direction:column;gap:14px;padding:24px 22px 20px;overflow:auto;' +
  `border-left:1px solid ${LINE_COLOR};background:linear-gradient(180deg,#080e18 0%,#060b13 100%);` +
  'box-shadow:-20px 0 48px rgba(0,0,0,.34);';
const SHOP_HEAD_CSS =
  `position:sticky;top:0;z-index:2;padding-bottom:14px;border-bottom:1px solid ${LINE_COLOR};` +
  'display:flex;align-items:center;justify-content:space-between;gap:12px;';
const EYEBROW_CSS = `color:${MUTED_COLOR};font-size:10px;letter-spacing:.22em;text-transform:uppercase;`;
const SHOP_TITLE_CSS = `color:${OK_COLOR};font-size:18px;letter-spacing:.12em;`;
// 店头不再印星币余额(商店优化:余额看左上统计版那一行 ★ 星币,与商店同款金色)——
const SEGMENT_CSS =
  `padding:10px;border:1px solid ${LINE_COLOR};border-radius:7px;color:${TEXT_COLOR};` +
  'background:rgba(21,34,52,.42);';
const SECTION_CSS =
  'display:flex;flex-direction:column;gap:8px;padding-top:14px;' +
  `border-top:1px solid ${LINE_COLOR};`;
const SECTION_HEAD_CSS = 'display:flex;align-items:flex-end;justify-content:space-between;gap:10px;';
const SECTION_TITLE_CSS = `color:${OK_COLOR};font-size:13px;letter-spacing:.1em;`;
const REFRESH_BTN_CSS =
  `padding:4px 9px;border-radius:999px;border:1px solid ${LINE_COLOR};` +
  `background:rgba(43,74,110,.28);color:${OK_COLOR};font:inherit;font-size:10px;cursor:pointer;` +
  'letter-spacing:.06em;white-space:nowrap;';
// 图鉴式货架：卡面只放大图、名称、价格，数值与合成说明收进悬停 tooltip。
const CARDS_CSS = 'display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;';
const CARD_CSS =
  `min-height:126px;padding:7px 5px;border:1px solid ${LINE_COLOR};border-radius:8px;` +
  'background:rgba(18,29,45,.72);box-shadow:inset 0 1px 0 rgba(255,255,255,.025);' +
  `color:${TEXT_COLOR};font:inherit;text-align:center;cursor:pointer;box-sizing:border-box;` +
  'display:flex;flex-direction:column;align-items:center;justify-content:space-between;gap:4px;' +
  'transition:border-color 100ms,background 100ms,opacity 100ms,transform 100ms;';
const ITEM_ART_CSS =
  'display:block;width:68px;height:68px;max-width:100%;object-fit:contain;border-radius:6px;' +
  'border:1px solid rgba(43,74,110,.6);background:rgba(5,7,13,.66);box-sizing:border-box;';
const ITEM_NAME_CSS =
  `display:block;color:${OK_COLOR};font-size:11px;line-height:1.25;min-height:2.5em;` +
  'word-break:keep-all;overflow-wrap:normal;';
const ITEM_PRICE_CSS = `display:block;color:${TEXT_COLOR};font-size:10px;line-height:1.25;`;
const BTN_CSS =
  `width:100%;padding:9px 12px;border:1px solid ${LINE_COLOR};border-radius:6px;` +
  `background:rgba(43,74,110,.28);color:${OK_COLOR};font:inherit;cursor:pointer;letter-spacing:.04em;`;
const PRIMARY_BTN_CSS =
  BTN_CSS +
  `background:rgba(64,126,164,.38);border-color:${OK_COLOR};box-shadow:0 0 18px rgba(154,220,255,.12);`;
const TOAST_CSS =
  'position:fixed;left:28px;bottom:28px;z-index:22;display:none;padding:8px 12px;border-radius:6px;' +
  `border:1px solid ${LINE_COLOR};background:rgba(5,7,13,.82);` +
  'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;pointer-events:none;white-space:pre-line;';
const TIP_CSS =
  'position:fixed;display:none;max-width:320px;white-space:pre-line;line-height:1.55;' +
  'z-index:24;pointer-events:none;background:rgba(10,16,26,.98);' +
  `border:1px solid rgba(43,74,110,.88);border-radius:7px;padding:9px 11px;` +
  `color:${TEXT_COLOR};font-size:12px;box-shadow:0 12px 30px rgba(0,0,0,.42);`;
const FLASH_MS = 1500;
const SHOP_ART_URL = new URL('../../assets/game/ui/shop-bay-nanobanana.png', import.meta.url).href;
const REFIT_STYLE =
  '.starwreck-refit-card,.starwreck-refit-button,.starwreck-refit-row{touch-action:manipulation;}' +
  '.starwreck-refit-card:focus-visible,.starwreck-refit-button:focus-visible,.starwreck-refit-row:focus-visible{' +
  'outline:2px solid #dff2ff;outline-offset:2px;box-shadow:0 0 0 4px rgba(154,220,255,.16);}' +
  '.starwreck-refit-card:hover{border-color:#6d9bc4!important;background:rgba(31,51,75,.9)!important;transform:translateY(-1px);}' +
  '@media (max-width:760px){' +
  '.starwreck-refit-board{left:0!important;right:0!important;top:0!important;bottom:auto!important;' +
  'height:44vh!important;padding:max(10px,env(safe-area-inset-top)) 10px 10px!important;' +
  'border-bottom:1px solid #2b4a6e;background:rgba(4,8,14,.82);overflow:auto!important;}' +
  '.starwreck-refit-shop{left:0!important;right:0!important;top:44vh!important;width:100%!important;' +
  'height:56vh!important;padding:16px max(14px,env(safe-area-inset-right)) ' +
  'max(18px,env(safe-area-inset-bottom)) max(14px,env(safe-area-inset-left))!important;' +
  'gap:10px!important;border-left:0!important;border-top:1px solid #2b4a6e;box-shadow:0 -16px 38px rgba(0,0,0,.32);}' +
  '.starwreck-refit-card,.starwreck-refit-row{min-height:118px!important;padding:7px 5px!important;}' +
  '.starwreck-refit-button{min-height:44px!important;}' +
  '.starwreck-refit-toast{left:max(10px,env(safe-area-inset-left))!important;right:max(10px,env(safe-area-inset-right))!important;' +
  'bottom:max(10px,env(safe-area-inset-bottom))!important;white-space:normal!important;}' +
  '}' +
  '@media (max-width:420px){' +
  '.starwreck-refit-board{height:40vh!important;}' +
  '.starwreck-refit-shop{top:40vh!important;height:60vh!important;}' +
  '.starwreck-refit-shop-head{align-items:flex-start!important;}' +
  '.starwreck-refit-section-head{align-items:flex-start!important;}' +
  '}' +
  '@media (max-height:560px) and (max-width:760px){' +
  '.starwreck-refit-board{height:36vh!important;}' +
  '.starwreck-refit-shop{top:36vh!important;height:64vh!important;}' +
  '}' +
  '@media (min-resolution:2dppx){' +
  '.starwreck-refit-root{font-size:13.5px!important;line-height:1.62!important;}' +
  '.starwreck-refit-card,.starwreck-refit-button,.starwreck-refit-row{border-color:#3d6288!important;}' +
  '}';

export interface RefitFlowUi {
  /** 换掉整局的 World(重开流程)。同时收面板、清提示:旧局的面板状态不能带到新船上去 */
  setWorld(world: World): void;
  /** 弹商店(main.ts 在 onRefitOffer 里调;时停也在那一侧)。参数 = 即将开始的航段下标 */
  show(segmentIndex: number): void;
  /** 收面板。**不恢复战斗、不动 loop** —— 那是 main.ts 的事(World 与 ui 都不认识流程) */
  hide(): void;
}

/**
 * 整备流程的构造参数。**只认 world + onResolved** —— 旧版的 canvas / screenToDeckLocal /
 * onLayout(给渲染器报商店宽度、把甲板居中到左侧装配区)随工作区一起删除:纯商店没有
 * 甲板可拾格,也没有需要居中的工作区。main.ts 每局只建一次,重开走 setWorld。
 */
export interface RefitFlowOpts {
  world: World;
  /** 点「完成整备」后回调:收面板、恢复战斗(run.paused = false)全在 main.ts 那一侧 */
  onResolved(): void;
}

/**
 * 理由码 → 中文拒绝文案。只保留商店相关的码(weld/move/evolve 那批随甲板删除)。
 * 独立成纯函数、不碰 DOM,于是能在 Node 里单测:漏一个码就会静默退化成兜底文案。
 */
export function refitDenyMessage(code: number): string {
  switch (code) {
    case ACQUIRE_REPLACE_NEEDED:
      return '武器槽已满：先选择一把要替换的武器';
    case SHOP_WEAPON_SOLD:
      return '这把武器已经售出';
    case SHOP_NO_STARCOINS:
      return '星币不足，无法购买';
    case SHOP_NO_REFRESH_STARCOINS:
      return '星币不足，无法刷新货架';
    case DOCK_EDICT_SOLD:
      return '这张法令已经售出';
    case DOCK_NO_STARCOINS:
      return '星币不足，无法购买';
    case DOCK_HP_FULL:
      return '船体已满血，无需修复';
    case REFIT_NOT_ACTIVE:
      return '整备已经结束';
    default:
      return `整备操作被拒绝(理由码 ${code})`;
  }
}

/**
 * 一张法令的效果文案 —— **转发 upgradeFlow 的 edictDesc**,不在这里念第二遍数值表。
 * 升级三选一的法令卡与船坞货架的法令卡是同一批东西,文案分家的话改一次数值表就得改两处,
 * 而"两处只改了一处"的症状是两个面板对同一条法令印出不同的数 —— 玩家没法判断哪个是真的。
 * 型号越界的兜底也一并继承(不静默冒充第 0 条)。
 */
export function dockEdictEffect(type: number): string {
  const def = EDICTS[type];
  if (!def) return '未知法令';
  return edictDesc(def);
}

/** 节流系的单字(与 shipDiagram / armoryPanel 同源:卡片窄,只取一个字) */
export function createRefitFlow(opts: RefitFlowOpts): RefitFlowUi {
  // world 是**可重赋的局部变量**而不是解构常量:重开一局要换掉整个 World(见 setWorld),
  // 闭包里每处都现读它 —— 换引用这一件事就够了,面板 DOM 一行都不必重挂。
  let world = opts.world;
  const { onResolved } = opts;

  const root = document.createElement('div');
  root.style.cssText = ROOT_CSS;
  root.className = 'starwreck-refit-root';

  const shop = document.createElement('div');
  shop.style.cssText = SHOP_CSS;
  shop.className = 'starwreck-refit-shop';

  // —— 店头:标题(余额不在店里印,左上统计版的 ★ 星币常驻显示,与商店同款金色)——
  const shopHead = document.createElement('div');
  shopHead.style.cssText = SHOP_HEAD_CSS;
  shopHead.className = 'starwreck-refit-shop-head';
  shopHead.style.backgroundImage = `linear-gradient(90deg,rgba(8,14,24,.97) 0%,rgba(8,14,24,.9) 58%,rgba(8,14,24,.78) 100%),url("${SHOP_ART_URL}")`;
  shopHead.style.backgroundSize = 'cover';
  shopHead.style.backgroundPosition = 'center';
  shopHead.style.borderRadius = '8px';
  shopHead.style.padding = '14px';
  const shopTitleBox = document.createElement('div');
  const shopEyebrow = document.createElement('div');
  shopEyebrow.style.cssText = EYEBROW_CSS;
  shopEyebrow.textContent = 'DOCK SUPPLY';
  const shopTitle = document.createElement('div');
  shopTitle.style.cssText = SHOP_TITLE_CSS;
  shopTitle.textContent = '舰装商店';
  shopTitleBox.append(shopEyebrow, shopTitle);
  shopHead.appendChild(shopTitleBox);

  // —— 航段行(旧版威胁摘要删掉后留下的简版:下一波是第几段) ——
  const segment = document.createElement('div');
  segment.style.cssText = SEGMENT_CSS;

  // —— 武器商店(改版主菜):卡片 + 刷新 ——
  const weaponSection = document.createElement('div');
  weaponSection.style.cssText = SECTION_CSS;
  const weaponHead = document.createElement('div');
  weaponHead.style.cssText = SECTION_HEAD_CSS;
  weaponHead.className = 'starwreck-refit-section-head';
  const weaponTitle = document.createElement('div');
  weaponTitle.style.cssText = SECTION_TITLE_CSS;
  weaponTitle.textContent = '武器商店';
  const refreshBtn = document.createElement('button');
  refreshBtn.style.cssText = REFRESH_BTN_CSS;
  refreshBtn.className = 'starwreck-refit-button';
  refreshBtn.addEventListener('click', refreshShop);
  weaponHead.append(weaponTitle, refreshBtn);
  const cards = document.createElement('div');
  cards.style.cssText = CARDS_CSS;
  weaponSection.append(weaponHead, cards);

  // —— 替换态:武器槽满时盖住卡片的那一层。**槽位不在这里列** ——
  // 要换掉哪一把取决于"它朝哪、射界多宽",那是列表读不出的东西,故选槽整个搬到中间舰船背包上
  // (点击经 createShipDiagram 的 onSlotClick 回到 pickReplacement)。这里只留提示 + 退路。
  const picker = document.createElement('div');
  picker.style.cssText = SECTION_CSS;
  picker.style.display = 'none';
  const pickerTitle = document.createElement('div');
  pickerTitle.style.cssText = SECTION_TITLE_CSS;
  pickerTitle.textContent = '武器槽已满';
  const pickerHint = document.createElement('div');
  pickerHint.style.cssText = `color:${MUTED_COLOR};font-size:11px;`;
  const pickerCancel = document.createElement('button');
  pickerCancel.style.cssText = BTN_CSS;
  pickerCancel.className = 'starwreck-refit-button';
  pickerCancel.textContent = '取消购买';
  pickerCancel.addEventListener('click', cancelPicker);
  picker.append(pickerTitle, pickerHint, pickerCancel);
  weaponSection.appendChild(picker);

  // —— 星币区:法令卡 + 付费修复(既有,文案与置灰口径原样保留) ——
  const starSection = document.createElement('div');
  starSection.style.cssText = SECTION_CSS;
  const starTitle = document.createElement('div');
  starTitle.style.cssText = SECTION_TITLE_CSS;
  starTitle.textContent = '法令卡';
  const edictCards = document.createElement('div');
  edictCards.style.cssText = CARDS_CSS;
  starSection.append(starTitle, edictCards);
  const edictRows: HTMLButtonElement[] = [];
  for (let i = 0; i < DOCK_EDICT_COUNT; i++) {
    const row = document.createElement('button');
    row.style.cssText = CARD_CSS;
    row.className = 'starwreck-refit-card starwreck-refit-row';
    row.addEventListener('click', () => buyDockEdict(i));
    row.addEventListener('mouseenter', () => showEdictTip(i, row));
    row.addEventListener('mouseleave', hideTip);
    row.addEventListener('focus', () => showEdictTip(i, row));
    row.addEventListener('blur', hideTip);
    edictCards.appendChild(row);
    edictRows.push(row);
  }
  const repairBtn = document.createElement('button');
  repairBtn.style.cssText = BTN_CSS;
  repairBtn.className = 'starwreck-refit-button';
  repairBtn.textContent = `修复船体 +${Math.round(DOCK_REPAIR_FRACTION * 100)}% HP · ${DOCK_REPAIR_PRICE} ★`;
  repairBtn.addEventListener('click', buyRepair);
  starSection.appendChild(repairBtn);

  const finish = document.createElement('button');
  finish.style.cssText = PRIMARY_BTN_CSS;
  finish.className = 'starwreck-refit-button';
  finish.style.marginTop = 'auto';
  finish.textContent = '完成整备 · 开始下一波';
  finish.addEventListener('click', resolve);

  shop.append(shopHead, segment, weaponSection, starSection, finish);
  root.appendChild(shop);

  // —— 中央区:舰船背包(shop 之后挂,故 root.children[0] 仍是 shop) ——
  const boardWrap = document.createElement('div');
  boardWrap.style.cssText = BOARD_WRAP_CSS;
  boardWrap.className = 'starwreck-refit-board';
  const shipDiagram: ShipDiagramUi = createShipDiagram({ onSlotClick: pickReplacement });
  boardWrap.appendChild(shipDiagram.root);
  root.appendChild(boardWrap);

  const toast = document.createElement('div');
  toast.style.cssText = TOAST_CSS;
  toast.className = 'starwreck-refit-toast';
  const tip = document.createElement('div');
  tip.style.cssText = TIP_CSS;
  const ui = document.getElementById('ui')!;
  const styleEl = document.createElement('style');
  styleEl.textContent = REFIT_STYLE;
  document.head?.appendChild(styleEl);
  root.appendChild(tip);
  ui.append(root, toast);

  // 武器货架卡:与法令行同一条"只建一次、整局复用"的生命周期,syncPanel 只改文案与置灰
  const weaponCards: HTMLButtonElement[] = [];
  for (let i = 0; i < DOCK_WEAPON_COUNT; i++) {
    const card = document.createElement('button');
    card.style.cssText = CARD_CSS;
    card.className = 'starwreck-refit-card';
    card.addEventListener('click', () => buyWeapon(i));
    // 悬停同时做两件事：舰船上虚装预览 + 像图鉴一样弹说明。
    card.addEventListener('mouseenter', () => {
      hoverCardChanged(i);
      showWeaponTip(i, card);
    });
    card.addEventListener('mouseleave', () => {
      hoverCardChanged(-1);
      hideTip();
    });
    card.addEventListener('focus', () => showWeaponTip(i, card));
    card.addEventListener('blur', hideTip);
    cards.appendChild(card);
    weaponCards.push(card);
  }

  let shown = false;
  /** 待换槽购买:null = 不在替换态。index = 武器货架位,type 由世界验过 ≥ 0 */
  let pendingBuy: { index: number; type: number } | null = null;
  /** 鼠标停在第几张货架卡(-1 = 没有);只喂舰船图的幽灵预览,不参与任何裁决 */
  let hoverCard = -1;
  let flashTimer = 0;

  function flash(text: string, color: string): void {
    toast.textContent = text;
    toast.style.color = color;
    toast.style.display = 'block';
    if (flashTimer) window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => {
      flashTimer = 0;
      toast.style.display = 'none';
    }, FLASH_MS);
  }

  function clearFlash(): void {
    if (flashTimer) window.clearTimeout(flashTimer);
    flashTimer = 0;
    toast.style.display = 'none';
  }

  /** 图鉴的配图结构 → 商店卡可直接使用的 src。多图条目货架只取第一张主图。 */
  function artSrc(art: CodexArt | null): string | null {
    if (art === null) return null;
    if (art.kind === 'img') return art.urls[0] ?? null;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(art.svg)}`;
  }

  function itemArtHtml(art: CodexArt | null, fallback: string): string {
    const src = artSrc(art);
    if (src === null) {
      return `<span style="${ITEM_ART_CSS}display:flex;align-items:center;justify-content:center;color:${MUTED_COLOR};font-size:28px">${fallback}</span>`;
    }
    return `<img style="${ITEM_ART_CSS}" src="${src}" alt="">`;
  }

  function priceText(discounted: boolean, base: number): string {
    return discounted
      ? `特价 ${shopDiscountPrice(base)} ★（原价 ${base} ★）`
      : `${base} ★`;
  }

  function placeTip(anchor: HTMLElement): void {
    const viewportWidth = window.innerWidth || 1024;
    const viewportHeight = window.innerHeight || 768;
    const rect = typeof anchor.getBoundingClientRect === 'function'
      ? anchor.getBoundingClientRect()
      : { left: 8, right: 100, top: 8, bottom: 100 };
    const left = Math.max(8, Math.min(rect.left, viewportWidth - 344));
    const below = rect.bottom + 7;
    // 右栏靠底的法令卡改往上弹，避免说明被视口裁掉。
    const top = below + 190 <= viewportHeight ? below : Math.max(8, rect.top - 197);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  function hideTip(): void {
    tip.style.display = 'none';
  }

  function weaponNotes(type: number): string[] {
    const c1 = slotStarCount(world.weapons, type, 1);
    const c2 = slotStarCount(world.weapons, type, 2);
    const c3 = slotStarCount(world.weapons, type, 3);
    const mergeResult = mergeResultOf(type);
    const notes: string[] = [];
    if (c1 + c2 + c3 > 0) {
      const parts: string[] = [];
      if (c3 > 0) parts.push(`${'★'.repeat(3)} ×${c3}`);
      if (c2 > 0) parts.push(`${'★'.repeat(2)} ×${c2}`);
      if (c1 > 0) parts.push(`★ ×${c1}`);
      notes.push(`已有 ${parts.join(' ')}`);
    } else {
      notes.push('入手 ★');
    }
    const empty = firstEmptySlot();
    if (empty >= 0) {
      notes.push(`装到「${SLOT_FACING_NAME[empty] ?? `槽${empty}`}」空槽`);
    } else {
      // 槽满但同型已凑两把 ★:买下走吸收合成(3 把合 1 把,不占槽),不需要替换
      notes.push(c1 === 2 ? '槽已满 · 与两把 ★ 三合一,无需替换' : '槽已满 · 需替换一把');
    }
    if (c1 === 2) {
      if (c2 === 2) {
        notes.push(
          mergeResult >= 0
            ? `买下连合 ${'★'.repeat(3)} 变身「${TOWERS[mergeResult]?.name ?? '合成武器'}」`
            : `买下连合 ${'★'.repeat(3)}`,
        );
      } else {
        notes.push(`买下合成 ${'★'.repeat(2)}`);
      }
    } else if (mergeResult >= 0 && c2 === 2) {
      notes.push(`再合一把 ${'★'.repeat(2)} 变身「${TOWERS[mergeResult]?.name ?? '合成武器'}」`);
    }
    return notes;
  }

  function showWeaponTip(index: number, anchor: HTMLElement): void {
    if (!shown) return;
    const type = world.shopWeapons[index];
    if (type === undefined || type < 0) return hideTip();
    const lines = weaponHover(type);
    lines[0] = `${lines[0] ?? (TOWERS[type]?.name ?? '未知武器')} · ${priceText(
      world.shopDiscountIndex === DOCK_EDICT_COUNT + index,
      DOCK_WEAPON_PRICE,
    )}`;
    lines.push(weaponNotes(type).join(' · '));
    tip.textContent = lines.join('\n');
    tip.style.display = 'block';
    placeTip(anchor);
  }

  function showEdictTip(index: number, anchor: HTMLElement): void {
    if (!shown) return;
    const type = world.dockEdictOffers[index];
    if (type === undefined || type < 0) return hideTip();
    const name = EDICTS[type]?.name ?? `未知法令(${type})`;
    tip.textContent = [
      `${name} · ${priceText(world.shopDiscountIndex === index, DOCK_EDICT_PRICE)}`,
      ...edictHover(type),
    ].join('\n');
    tip.style.display = 'block';
    placeTip(anchor);
  }

  /** 按钮置灰三件套(disabled / 透明度 / 光标):各货架共用一份写法 */
  function setGrey(el: HTMLButtonElement, grey: boolean): void {
    el.disabled = grey;
    el.style.opacity = grey ? '.34' : '1';
    el.style.cursor = grey ? 'not-allowed' : 'pointer';
  }

  /** 第一个空槽下标(-1 = 槽已满)。与 World.acquireWeapon 的落位顺序同向:从槽 0 往后找 */
  function firstEmptySlot(): number {
    for (let i = 0; i < WEAPON_SLOT_COUNT; i++) {
      const slot = world.weapons[i];
      if (!slot || slot.type < 0) return i;
    }
    return -1;
  }

  /** 舰船图这一帧该画成什么:替换态跟着鼠标走,只读态把悬停的那把虚装到第一个空槽(恒 1★) */
  function diagramState(): ShipDiagramState {
    if (pendingBuy) {
      return {
        mode: 'pick',
        incoming: { type: pendingBuy.type, stars: 1 },
        target: -1,
      };
    }
    const type = hoverCard >= 0 ? world.shopWeapons[hoverCard] : undefined;
    if (type === undefined || type < 0) return { mode: 'view', incoming: null, target: -1 };
    return { mode: 'view', incoming: { type, stars: 1 }, target: firstEmptySlot() };
  }

  /** 悬停换了一张卡:只重画舰船图(货架文案与余额一个字都没变,整屏重刷是白干) */
  function hoverCardChanged(index: number): void {
    if (!shown || hoverCard === index) return;
    hoverCard = index;
    shipDiagram.paint(world, diagramState());
  }

  /**
   * 货架价格的 HTML(打折机制):原价恒印;本格是特价位(shopDiscountIndex)时原价划线、
   * 特价亮金(与星币同款金色),一眼就是"这件打折"。特价数走 shopDiscountPrice ——
   * 与 World 扣费共用同一份算法,印 15 就扣 15,绝不各说各话。
   */
  function priceHtml(discounted: boolean, base: number): string {
    if (!discounted) return `${base} ★`;
    return (
      `<span style="color:${STAR_COLOR}">特价 <s style="color:${MUTED_COLOR}">${base} ★</s>` +
      ` ${shopDiscountPrice(base)} ★</span>`
    );
  }

  /**
   * 全店唯一的刷新点:任何购买/刷新/换局后当场重刷。置灰只认"已售出/满血"两样 UI 读数;
   * **星币不足不置灰**,那是点击时的 deny 反馈 —— 余额随时可能被另一张卡花掉,置灰态会
   * 过期,真正的裁决始终以 world 的返回码为准。
   */
  function syncPanel(): void {
    hideTip();
    // 星币余额不在店里印(商店优化):左上统计版(HUD 左列)的 ★ 星币常驻显示,与商店同款金色

    // 武器卡:替换态时整排让位,只露提示与退路(选槽在中间舰船背包上)
    const pickerOpen = pendingBuy !== null;
    cards.style.display = pickerOpen ? 'none' : 'grid';
    picker.style.display = pickerOpen ? 'flex' : 'none';
    if (pendingBuy) {
      const name = TOWERS[pendingBuy.type]?.name ?? '这把武器';
      pickerHint.textContent = `在中间舰船背包上点一个武器槽，把它换成「${name}」；取消不扣星币`;
    }
    setGrey(refreshBtn, pickerOpen);
    refreshBtn.textContent = `刷新 ${DOCK_SHOP_REFRESH_PRICE} ★`;
    for (let i = 0; i < weaponCards.length; i++) {
      const card = weaponCards[i]!;
      const type = world.shopWeapons[i];
      const sold = type === undefined || type < 0;
      setGrey(card, sold || pickerOpen);
      if (sold) {
        card.innerHTML =
          `<span style="${ITEM_ART_CSS}display:flex;align-items:center;justify-content:center;` +
          `color:${MUTED_COLOR};font-size:24px">—</span>` +
          `<span style="${ITEM_NAME_CSS}color:${MUTED_COLOR}">${type === undefined ? '本轮无货' : '已售出'}</span>`;
        continue;
      }
      const def = TOWERS[type];
      card.innerHTML =
        itemArtHtml(towerArt(type), '?') +
        `<span style="${ITEM_NAME_CSS}">${def?.name ?? `未知武器(${type})`}</span>` +
        `<span style="${ITEM_PRICE_CSS}">${priceHtml(
          world.shopDiscountIndex === DOCK_EDICT_COUNT + i,
          DOCK_WEAPON_PRICE,
        )}</span>`;
    }

    // 法令卡
    for (let i = 0; i < edictRows.length; i++) {
      const row = edictRows[i]!;
      const type = world.dockEdictOffers[i];
      const sold = type === undefined || type < 0;
      setGrey(row, sold);
      if (sold) {
        row.innerHTML =
          `<span style="${ITEM_ART_CSS}display:flex;align-items:center;justify-content:center;` +
          `color:${MUTED_COLOR};font-size:24px">—</span>` +
          `<span style="${ITEM_NAME_CSS}color:${MUTED_COLOR}">${type === undefined ? '本轮无货' : '已售出'}</span>`;
      } else {
        row.innerHTML =
          itemArtHtml(edictArt(type), '◆') +
          `<span style="${ITEM_NAME_CSS}">${EDICTS[type]?.name ?? `未知法令(${type})`}</span>` +
          `<span style="${ITEM_PRICE_CSS}">${priceHtml(
            world.shopDiscountIndex === i,
            DOCK_EDICT_PRICE,
          )}</span>`;
      }
    }

    // 付费修复:满血置灰
    setGrey(repairBtn, world.ship.hp >= world.ship.maxHp);

    // 舰船背包:与货架同一次重画。买完一把武器、修完一次船,中间的图当帧就跟上 ——
    // 两块面板要是各刷各的,玩家就得靠"关了再开"去确认自己刚买的东西真的装上了
    shipDiagram.paint(world, diagramState());
  }

  /**
   * 买卡前的武器快照:回执按"买前 → 买后"的差说话(落新 ★1 / 三合一升星 / ★3 变身),
   * 与 upgradeFlow 的 weaponSnapshot 同一条口径。
   */
  function weaponBefore(type: number): { max: number; result: number } {
    const result = mergeResultOf(type);
    return {
      max: slotMaxStars(world.weapons, type),
      result: result >= 0 ? slotStarCount(world.weapons, result, 3) : 0,
    };
  }

  /** 买成之后的回执:三合一当场升星 / ★★★ 变身时,回执把结果说出来而不是干巴巴的"已购入" */
  function weaponReceipt(type: number, before: { max: number; result: number }): string {
    const name = TOWERS[type]?.name ?? '未知武器';
    const result = mergeResultOf(type);
    const afterResult = result >= 0 ? slotStarCount(world.weapons, result, 3) : 0;
    if (afterResult > before.result) {
      return `已购入：${name} 合 ${'★'.repeat(3)} 变身「${TOWERS[result]?.name ?? '合成武器'}」`;
    }
    const afterMax = slotMaxStars(world.weapons, type);
    if (afterMax > before.max) return `已购入：${name} 合到 ${'★'.repeat(afterMax)}`;
    return `已购入：${name}`;
  }

  /**
   * 买第 index 张武器卡。槽有空位 → 世界当场落位;槽满且同型已凑两把 ★ → 吸收合成当场成功;
   * 其余槽满 → ACQUIRE_REPLACE_NEEDED(不扣星币、货架不动),转入替换态(选槽在中间舰船背包上);
   * 其他失败码照 refitDenyMessage 说人话。
   */
  function buyWeapon(index: number): void {
    if (!shown || pendingBuy) return;
    const card = weaponCards[index];
    if (!card || card.disabled) return; // 售出置灰自守:真 DOM 不会点穿 disabled,桩会
    const type = world.shopWeapons[index];
    if (type === undefined || type < 0) return;
    const before = weaponBefore(type);
    const code = world.buyShopWeapon(index);
    if (code === ACQUIRE_REPLACE_NEEDED) {
      pendingBuy = { index, type };
      syncPanel();
      return;
    }
    if (code < 0) {
      flash(refitDenyMessage(code), DENY_COLOR);
      syncPanel();
      return;
    }
    flash(weaponReceipt(type, before), OK_COLOR);
    audioBus.playPlace();
    syncPanel();
  }

  /**
   * 在舰船图上点了一个武器槽(替换态):带着槽位重买。**不单独调 replaceWeapon** ——
   * buyShopWeapon(index, slotIndex) 内部已含换装/扣费/下架/查三合一(world.ts 的 doc 原文),
   * 先 replace 再买会白送一把不扣钱的武器。换装成功报"换下旧武器"的回执。
   */
  function pickReplacement(slotIndex: number): void {
    const pending = pendingBuy;
    if (!pending || !shown) return;
    const oldSlot = world.weapons[slotIndex];
    const oldName =
      oldSlot && oldSlot.type >= 0
        ? `${TOWERS[oldSlot.type]?.name ?? '未知武器'} ${'★'.repeat(oldSlot.stars)}`
        : null;
    const before = weaponBefore(pending.type);
    const code = world.buyShopWeapon(pending.index, slotIndex);
    pendingBuy = null;
    if (code === ACQUIRE_REPLACE_NEEDED) {
      // 点击瞬间槽位又空了(理论走不到:能进替换态 = 八槽全满,这是防桩):退出让玩家重买
      flash(refitDenyMessage(code), DENY_COLOR);
      syncPanel();
      return;
    }
    if (code < 0) {
      flash(refitDenyMessage(code), DENY_COLOR);
      syncPanel();
      return;
    }
    // 换装的回执:换下的旧武器照报,三合一升星/★★★ 变身照 weaponReceipt 的口径补一句
    const receipt = weaponReceipt(pending.type, before);
    const name = TOWERS[pending.type]?.name ?? '未知武器';
    const fusion = receipt.slice(`已购入：${name}`.length); // '' / ' 合到 ★★' / ' 合 ★★★ 变身「…」'
    flash(oldName ? `已换装：${name}${fusion} → ${oldName}` : receipt, OK_COLOR);
    audioBus.playPlace();
    syncPanel();
  }

  /** 取消换槽购买:不在替换态时是空操作;在的话也只退出替换态 —— 失败尝试一分钱不扣 */
  function cancelPicker(): void {
    if (!pendingBuy) return;
    pendingBuy = null;
    syncPanel();
  }

  /** 刷新武器货架:花 DOCK_SHOP_REFRESH_PRICE 星币重掷。置灰(替换态)时点击不生效 */
  function refreshShop(): void {
    if (!shown || refreshBtn.disabled) return;
    const code = world.refreshShop();
    if (code < 0) {
      flash(refitDenyMessage(code), DENY_COLOR);
      syncPanel();
      return;
    }
    flash(`已刷新货架 —— 花费 ${DOCK_SHOP_REFRESH_PRICE} 星币`, OK_COLOR);
    audioBus.playPlace();
    syncPanel();
  }

  /** 买第 index 张法令卡:即时生效、无放置 —— 法令是全船被动,点一下就是买(语义同升级卡) */
  function buyDockEdict(index: number): void {
    if (!shown) return;
    const row = edictRows[index];
    if (!row || row.disabled) return;
    const type = world.dockEdictOffers[index];
    const code = world.buyDockEdict(index);
    if (code < 0) {
      flash(refitDenyMessage(code), DENY_COLOR);
      syncPanel();
      return;
    }
    const name = type !== undefined && type >= 0 ? (EDICTS[type]?.name ?? '法令') : '法令';
    flash(`已购入：${name}`, OK_COLOR);
    audioBus.playPlace();
    syncPanel();
  }

  /** 买一次付费修复:可重复购买、满血时置灰(灰态由 syncPanel 管,这里只认返回码) */
  function buyRepair(): void {
    if (!shown || repairBtn.disabled) return;
    const code = world.buyDockRepair();
    if (code < 0) {
      flash(refitDenyMessage(code), DENY_COLOR);
      syncPanel();
      return;
    }
    flash(`已修复船体 +${Math.round(DOCK_REPAIR_FRACTION * 100)}%`, OK_COLOR);
    audioBus.playPlace();
    syncPanel();
  }

  /** 完成本轮整备:世界放行下一航段(含免费回血),收面板,回调归 main 恢复战斗 */
  function resolve(): void {
    const completed = world.completeRefit();
    hide();
    if (completed) onResolved();
  }

  function hide(): void {
    shown = false;
    pendingBuy = null;
    hoverCard = -1; // 悬停是纯表现,但留着的话下次开面板会莫名其妙先亮着一格幽灵
    hideTip();
    root.style.display = 'none';
    ui.style.zIndex = '';
    // 提示条**不清**:那行回执(已购入/已换装)要留到战斗恢复之后才读得到
  }

  return {
    show(segmentIndex: number): void {
      // 没有待整备却被弹起来(World 只在真的跨段时响 onRefitOffer,这一句是拦网):
      // 空面板会把玩家卡在时停里,故当场说清楚并放行
      if (!world.refitPending) {
        hide();
        onResolved();
        return;
      }
      shown = true;
      pendingBuy = null;
      hoverCard = -1;
      clearFlash();
      segment.textContent =
        segmentIndex >= WAVE_SEGMENTS.length
          ? '整备 · 决战在即'
          : `整备 · 航段 ${segmentIndex + 1}`;
      // Tweakpane 是运行时追加到 body 的后置兄弟;临时抬高 #ui 的堆叠层,确保固定商店盖住它
      ui.style.zIndex = '10';
      root.style.display = 'block';
      syncPanel();
    },
    hide,
    setWorld(next: World): void {
      world = next;
      hide();
      clearFlash();
    },
  };
}
