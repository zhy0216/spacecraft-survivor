/**
 * 航段整备流程 —— 纯商店(改版:甲板网格删除后的落点)。
 * 旧版的「左甲板工作区 + 三阶段(选拼块/焊接/重排)+ 空间进化」随甲板一起删除,
 * 本流程剩两块:**左侧舰船一览**(ui/shipDiagram)+ **右侧一栏商店** ——
 * 武器商店(30 ★/把,不满 10 ★ 刷新,槽满转到舰船上点一格替换)、
 * 法令卡(25 ★ 即时生效、无占槽)、付费修复(25 ★ 回 40% HP,满血置灰)、完成整备
 * (completeRefit → hide + onResolved,恢复战斗在 main.ts)。与普通升级彻底分开:
 * 不消费残骸、不生成三选一、没有战斗中可调用的入口;购买全部零 rng,ui 只照返回码说人话。
 *
 * —— 为什么商店里要画船(用户反馈)——
 * 商店搬上地图后,买东西这一刻玩家已经离开了战斗视角:货架上写着"磁轨炮 30 ★",
 * 但"我现在有几把炮、哪个方向是缺口、这把买回来装哪儿"三问全靠记。左侧那张图就是答案 ——
 * 八个槽按真实朝向围一圈、每把武器画出自己的射界扇形;**悬停一张货架卡**,它就以幽灵态
 * 虚装到即将落位的那一格上(槽满时则跟着鼠标落在待替换的那一格),于是"买它会变成什么样"
 * 是买之前看得见的事,而不是买完才知道。
 *
 * —— 替换(武器槽满时)——
 * buyShopWeapon(index) 在槽满且没给替换位时返回 ACQUIRE_REPLACE_NEEDED —— **不扣星币、
 * 货架不动**(world.ts 的 doc 原文),于是"选槽失败/取消"天然一分钱不扣。
 * 面板转入 pick 态:**玩家在左侧舰船图上点一个槽** → 带着 slotIndex 重买一次
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
} from '../data/economy';
import { edictDesc, EDICTS } from '../data/edicts';
import { mergeResultOf } from '../data/merges';
import { throttleName, TOWERS, towerArcDeg, towerRange } from '../data/towers';
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
  createShipDiagram,
  previewSustainedDps,
  SLOT_FACING_NAME,
  towerGlyph,
  towerTintCss,
  type ShipDiagramState,
  type ShipDiagramUi,
} from './shipDiagram';

const OK_COLOR = '#9adcff';
const DENY_COLOR = '#ff7a6b';
const TEXT_COLOR = '#c8dcf0';
const MUTED_COLOR = '#6f89a5';
const LINE_COLOR = '#2b4a6e';
const ROOT_CSS =
  'position:fixed;inset:0;z-index:20;display:none;pointer-events:none!important;' +
  // 淡幕:整备是时停时刻,压暗背后那一屏虫潮才读得清货架与舰船图(仍透出地图,信标位置不丢)
  'background:radial-gradient(120% 100% at 30% 50%,rgba(4,8,14,.42) 0%,rgba(3,6,11,.68) 100%);' +
  `color:${TEXT_COLOR};font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;user-select:none;`;
/** 舰船图的容器:占满商店左边那一半,内容居中;屏太矮时让它自己滚,而不是把图裁掉 */
const BOARD_WRAP_CSS =
  'position:absolute;left:0;top:0;bottom:0;right:340px;display:flex;align-items:center;' +
  'justify-content:center;padding:20px;box-sizing:border-box;overflow:auto;pointer-events:none;';
const SHOP_CSS =
  'position:absolute;right:0;top:0;height:100%;width:340px;box-sizing:border-box;display:flex;' +
  'pointer-events:auto;flex-direction:column;gap:14px;padding:24px 22px 20px;overflow:auto;' +
  `border-left:1px solid ${LINE_COLOR};background:linear-gradient(180deg,#080e18 0%,#060b13 100%);` +
  'box-shadow:-20px 0 48px rgba(0,0,0,.34);';
const SHOP_HEAD_CSS =
  `padding-bottom:14px;border-bottom:1px solid ${LINE_COLOR};display:flex;align-items:flex-end;` +
  'justify-content:space-between;gap:12px;';
const EYEBROW_CSS = `color:${MUTED_COLOR};font-size:10px;letter-spacing:.22em;text-transform:uppercase;`;
const SHOP_TITLE_CSS = `color:${OK_COLOR};font-size:18px;letter-spacing:.12em;`;
const QUOTA_CSS =
  `padding:4px 8px;border-radius:999px;border:1px solid ${LINE_COLOR};color:${MUTED_COLOR};` +
  'font-size:10px;white-space:nowrap;';
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
// 一列而不是两列:武器卡要印下"节流系 · 射界 · 射程 · DPS"与合成进度,两列挤在 340px 侧栏里
// 会把每一行都折断,而这些数正是"这把值不值 30 星币"的全部依据
const CARDS_CSS = 'display:grid;grid-template-columns:1fr;gap:8px;';
const CARD_CSS =
  `min-height:72px;padding:11px;border:1px solid ${LINE_COLOR};border-radius:8px;` +
  'background:rgba(18,29,45,.72);box-shadow:inset 0 1px 0 rgba(255,255,255,.025);' +
  `color:${TEXT_COLOR};font:inherit;text-align:left;cursor:pointer;transition:border-color 100ms,background 100ms,opacity 100ms;`;
const ROW_CSS =
  `width:100%;padding:8px 10px;border:1px solid ${LINE_COLOR};border-radius:6px;` +
  'background:rgba(18,29,45,.72);' +
  `color:${TEXT_COLOR};font:inherit;text-align:left;cursor:pointer;transition:border-color 100ms,background 100ms,opacity 100ms;`;
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
const FLASH_MS = 1500;

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

function round(value: number): string {
  return String(Math.round(value * 100) / 100);
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

  const shop = document.createElement('div');
  shop.style.cssText = SHOP_CSS;

  // —— 店头:标题 + 星币余额 ——
  const shopHead = document.createElement('div');
  shopHead.style.cssText = SHOP_HEAD_CSS;
  const shopTitleBox = document.createElement('div');
  const shopEyebrow = document.createElement('div');
  shopEyebrow.style.cssText = EYEBROW_CSS;
  shopEyebrow.textContent = 'DOCK SUPPLY';
  const shopTitle = document.createElement('div');
  shopTitle.style.cssText = SHOP_TITLE_CSS;
  shopTitle.textContent = '舰装商店';
  shopTitleBox.append(shopEyebrow, shopTitle);
  const starBalance = document.createElement('div');
  starBalance.style.cssText = QUOTA_CSS;
  shopHead.append(shopTitleBox, starBalance);

  // —— 航段行(旧版威胁摘要删掉后留下的简版:下一波是第几段) ——
  const segment = document.createElement('div');
  segment.style.cssText = SEGMENT_CSS;

  // —— 武器商店(改版主菜):卡片 + 刷新 ——
  const weaponSection = document.createElement('div');
  weaponSection.style.cssText = SECTION_CSS;
  const weaponHead = document.createElement('div');
  weaponHead.style.cssText = SECTION_HEAD_CSS;
  const weaponTitle = document.createElement('div');
  weaponTitle.style.cssText = SECTION_TITLE_CSS;
  weaponTitle.textContent = '武器商店';
  const refreshBtn = document.createElement('button');
  refreshBtn.style.cssText = REFRESH_BTN_CSS;
  refreshBtn.addEventListener('click', refreshShop);
  weaponHead.append(weaponTitle, refreshBtn);
  const cards = document.createElement('div');
  cards.style.cssText = CARDS_CSS;
  weaponSection.append(weaponHead, cards);

  // —— 替换态:武器槽满时盖住卡片的那一层。**槽位不在这里列** ——
  // 要换掉哪一把取决于"它朝哪、射界多宽",那是列表读不出的东西,故选槽整个搬到左侧舰船图上
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
  starSection.appendChild(starTitle);
  const edictRows: HTMLButtonElement[] = [];
  for (let i = 0; i < DOCK_EDICT_COUNT; i++) {
    const row = document.createElement('button');
    row.style.cssText = ROW_CSS;
    row.addEventListener('click', () => buyDockEdict(i));
    starSection.appendChild(row);
    edictRows.push(row);
  }
  const repairBtn = document.createElement('button');
  repairBtn.style.cssText = BTN_CSS;
  repairBtn.textContent = `修复船体 +${Math.round(DOCK_REPAIR_FRACTION * 100)}% HP · ${DOCK_REPAIR_PRICE} ★`;
  repairBtn.addEventListener('click', buyRepair);
  starSection.appendChild(repairBtn);

  const finish = document.createElement('button');
  finish.style.cssText = PRIMARY_BTN_CSS;
  finish.style.marginTop = 'auto';
  finish.textContent = '完成整备 · 开始下一波';
  finish.addEventListener('click', resolve);

  shop.append(shopHead, segment, weaponSection, starSection, finish);
  root.appendChild(shop);

  // —— 左半屏:舰船一览(shop 之后挂,故 root.children[0] 仍是 shop) ——
  const boardWrap = document.createElement('div');
  boardWrap.style.cssText = BOARD_WRAP_CSS;
  const shipDiagram: ShipDiagramUi = createShipDiagram({ onSlotClick: pickReplacement });
  boardWrap.appendChild(shipDiagram.root);
  root.appendChild(boardWrap);

  const toast = document.createElement('div');
  toast.style.cssText = TOAST_CSS;
  const ui = document.getElementById('ui')!;
  ui.append(root, toast);

  // 武器货架卡:与法令行同一条"只建一次、整局复用"的生命周期,syncPanel 只改文案与置灰
  const weaponCards: HTMLButtonElement[] = [];
  for (let i = 0; i < DOCK_WEAPON_COUNT; i++) {
    const card = document.createElement('button');
    card.style.cssText = CARD_CSS;
    card.addEventListener('click', () => buyWeapon(i));
    // 悬停 = 在左边那张船图上虚装一把给你看(见文件头"为什么商店里要画船")
    card.addEventListener('mouseenter', () => hoverCardChanged(i));
    card.addEventListener('mouseleave', () => hoverCardChanged(-1));
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
   * 全店唯一的刷新点:任何购买/刷新/换局后当场重刷。置灰只认"已售出/满血"两样 UI 读数;
   * **星币不足不置灰**,那是点击时的 deny 反馈 —— 余额随时可能被另一张卡花掉,置灰态会
   * 过期,真正的裁决始终以 world 的返回码为准。
   */
  function syncPanel(): void {
    starBalance.textContent = `★ ${world.starCoins}`;

    // 武器卡:替换态时整排让位,只露提示与退路(选槽在左边那张船图上)
    const pickerOpen = pendingBuy !== null;
    cards.style.display = pickerOpen ? 'none' : 'grid';
    picker.style.display = pickerOpen ? 'flex' : 'none';
    if (pendingBuy) {
      const name = TOWERS[pendingBuy.type]?.name ?? '这把武器';
      pickerHint.textContent = `在左侧舰船上点一个武器槽，把它换成「${name}」；取消不扣星币`;
    }
    setGrey(refreshBtn, pickerOpen);
    refreshBtn.textContent = `刷新 ${DOCK_SHOP_REFRESH_PRICE} ★`;
    const empty = firstEmptySlot();
    for (let i = 0; i < weaponCards.length; i++) {
      const card = weaponCards[i]!;
      const type = world.shopWeapons[i];
      const sold = type === undefined || type < 0;
      setGrey(card, sold || pickerOpen);
      if (sold) {
        card.innerHTML =
          `<span style="color:${MUTED_COLOR};font-size:12px">` +
          `${type === undefined ? '本轮无货' : '已售出'}</span>`;
        continue;
      }
      const def = TOWERS[type];
      // 数值行:与舰船图上那一格印的是同一套读数(系名 · 射界 · 射程 · 1★ 持续 DPS),
      // 于是"货架上这把"与"船上那把"能直接对着比 —— 这正是要不要花 30 星币的全部依据
      const stats = def
        ? `${throttleName(def.throttle)} · ${Math.round(towerArcDeg(def, 1))}° · ` +
          `射程 ${Math.round(towerRange(def, 1))} · ${Math.round(previewSustainedDps(world, type, 1))}/s`
        : '数值表里没有这一型';
      // 同型同星的实际把数:三合一升星按它说话,同型买下也照常落槽(空槽 / 替换)
      const c1 = slotStarCount(world.weapons, type, 1);
      const c2 = slotStarCount(world.weapons, type, 2);
      const c3 = slotStarCount(world.weapons, type, 3);
      const mergeResult = mergeResultOf(type);
      const notes: string[] = [];
      if (c1 + c2 + c3 > 0) {
        const parts: string[] = [];
        if (c3 > 0) parts.push(`★3 ×${c3}`);
        if (c2 > 0) parts.push(`★2 ×${c2}`);
        if (c1 > 0) parts.push(`★1 ×${c1}`);
        notes.push(`已有 ${parts.join(' ')}`);
      } else {
        notes.push('入手 ★1');
      }
      notes.push(empty >= 0 ? `装到「${SLOT_FACING_NAME[empty] ?? `槽${empty}`}」空槽` : '槽已满 · 需替换一把');
      // 买下 = 一把 ★1。两种"当场触发"提前说;合到 ★3 的变身名字也只在这里亮出来
      if (c1 === 2) {
        if (c2 === 2) {
          notes.push(mergeResult >= 0 ? `买下连合 ★3 变身「${TOWERS[mergeResult]?.name ?? '合成武器'}」` : '买下连合 ★3');
        } else {
          notes.push('买下合成 ★2');
        }
      } else if (mergeResult >= 0 && c2 === 2) {
        notes.push(`再合一把 ★2 变身「${TOWERS[mergeResult]?.name ?? '合成武器'}」`);
      }
      card.innerHTML =
        `<span style="display:flex;justify-content:space-between;gap:8px;color:${OK_COLOR};font-size:13px;margin-bottom:3px">` +
        `<span><span style="color:${towerTintCss(type)}">${towerGlyph(type)}</span> ${def?.name ?? `未知武器(${type})`}</span>` +
        `<span>${DOCK_WEAPON_PRICE} ★</span></span>` +
        `<span style="display:block;color:${TEXT_COLOR};font-size:11px">${stats}</span>` +
        `<span style="display:block;color:${MUTED_COLOR};font-size:11px">${notes.join(' · ')}</span>`;
    }

    // 法令卡
    for (let i = 0; i < edictRows.length; i++) {
      const row = edictRows[i]!;
      const type = world.dockEdictOffers[i];
      const sold = type === undefined || type < 0;
      setGrey(row, sold);
      if (sold) {
        row.innerHTML =
          `<span style="color:${MUTED_COLOR};font-size:12px">` +
          `${type === undefined ? '本轮无货' : '已售出'}</span>`;
      } else {
        row.innerHTML =
          `<span style="display:flex;justify-content:space-between;gap:8px;color:${OK_COLOR};font-size:13px;margin-bottom:3px">` +
          `<span>${EDICTS[type]?.name ?? `未知法令(${type})`}</span><span>${DOCK_EDICT_PRICE} ★</span></span>` +
          `<span style="color:${MUTED_COLOR};font-size:11px">${dockEdictEffect(type)}</span>`;
      }
    }

    // 付费修复:满血置灰
    setGrey(repairBtn, world.ship.hp >= world.ship.maxHp);

    // 舰船图:与货架同一次重画。买完一把武器、修完一次船,左边那张图当帧就跟上 ——
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

  /** 买成之后的回执:三合一当场升星 / ★3 变身时,回执把结果说出来而不是干巴巴的"已购入" */
  function weaponReceipt(type: number, before: { max: number; result: number }): string {
    const name = TOWERS[type]?.name ?? '未知武器';
    const result = mergeResultOf(type);
    const afterResult = result >= 0 ? slotStarCount(world.weapons, result, 3) : 0;
    if (afterResult > before.result) {
      return `已购入：${name} 合 ★3 变身「${TOWERS[result]?.name ?? '合成武器'}」`;
    }
    const afterMax = slotMaxStars(world.weapons, type);
    if (afterMax > before.max) return `已购入：${name} 合到 ★${afterMax}`;
    return `已购入：${name}`;
  }

  /**
   * 买第 index 张武器卡。槽有空位 → 世界当场落位;槽满 → ACQUIRE_REPLACE_NEEDED
   * (不扣星币、货架不动),转入替换态(选槽在左侧舰船图上);其余失败码照 refitDenyMessage 说人话。
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
        ? `${TOWERS[oldSlot.type]?.name ?? '未知武器'} ★${oldSlot.stars}`
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
    // 换装的回执:换下的旧武器照报,三合一升星/★3 变身照 weaponReceipt 的口径补一句
    const receipt = weaponReceipt(pending.type, before);
    const name = TOWERS[pending.type]?.name ?? '未知武器';
    const fusion = receipt.slice(`已购入：${name}`.length); // '' / ' 合到 ★2' / ' 合 ★3 变身「…」'
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
      segment.textContent = `整备 · 航段 ${segmentIndex + 1}`;
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
