/**
 * 航段装配流程：每次敌群升级前冻结下一波，进入固定的「左侧飞船甲板 + 右侧商店」界面。
 * 商店当前只出售本轮免费的一块甲板拼块；选完后仍在同一界面自由搬运现有模块。
 * 与普通升级彻底分开：本流程不消费残骸、不生成炮塔/支援，也没有任何战斗中可调用的移动入口。
 */
import { DECK_PIECES, deckPieceCellCount } from '../data/deckPieces';
import { DOCK_EDICT_COUNT, DOCK_EDICT_PRICE, DOCK_REPAIR_FRACTION, DOCK_REPAIR_PRICE } from '../data/economy';
import { EDICTS } from '../data/edicts';
import { ENEMIES } from '../data/enemies';
import { evolutionOf } from '../data/evolutions';
import { SUP_AMMO_BAY, SUPPORTS } from '../data/supports';
import { TOWER_AUTOCANNON, TOWER_MAX_LEVEL, TOWERS } from '../data/towers';
import { WAVE_SEGMENTS, type WaveSegment } from '../data/waves';
import type { PlacementUiState } from '../render/renderer';
import {
  CELL_EMPTY,
  CELL_SUPPORT,
  CELL_WEAPON,
  cellIndexAtLocal,
  deckGridAtLocal,
  DECK_ROTATIONS,
  EVOLVE_BAD_SUPPORT,
  EVOLVE_BAD_TARGET,
  EVOLVE_NOT_MAX_LEVEL,
  EVOLVE_NO_RECIPE,
  EVOLVE_OK,
  hasWeldPlacement,
  isWeldSuccess,
  MOVE_NO_SOURCE,
  MOVE_NO_TARGET,
  MOVE_OK,
  MOVE_SAME_CELL,
  MOVE_TARGET_TAKEN,
  MOVE_WEAPON_INTERIOR,
  WELD_BAD_PIECE,
  WELD_BAD_ROTATION,
  WELD_DETACHED,
  WELD_OVERLAP,
} from '../sim/deck';
import { findEvolutionPairs } from '../sim/evolve';
import type { Vec2 } from '../sim/ship';
import { audioBus } from '../render/audio';
import { REFIT_ALREADY_WELDED, REFIT_NOT_ACTIVE, DOCK_EDICT_SOLD, DOCK_HP_FULL, DOCK_NO_STARCOINS, type World } from '../sim/world';

const OK_COLOR = '#9adcff';
const DENY_COLOR = '#ff7a6b';
const TEXT_COLOR = '#c8dcf0';
const MUTED_COLOR = '#6f89a5';
const LINE_COLOR = '#2b4a6e';
const ROOT_CSS =
  'position:fixed;inset:0;z-index:20;display:none;pointer-events:none!important;' +
  `color:${TEXT_COLOR};font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;user-select:none;`;
const WORKSPACE_CSS =
  'position:absolute;inset:0 0 0 0;box-sizing:border-box;pointer-events:none;' +
  'background:linear-gradient(90deg,rgba(5,7,13,.82) 0%,rgba(5,7,13,.32) 32%,rgba(5,7,13,.14) 72%,rgba(5,7,13,.52) 100%);';
const WORKSPACE_HEAD_CSS =
  'position:absolute;left:28px;top:24px;display:flex;align-items:center;gap:12px;';
const EYEBROW_CSS = `color:${MUTED_COLOR};font-size:10px;letter-spacing:.22em;text-transform:uppercase;`;
const TITLE_CSS = `color:${OK_COLOR};font-size:22px;letter-spacing:.14em;text-shadow:0 0 16px rgba(154,220,255,.28);`;
const PHASE_CSS =
  `padding:5px 9px;border:1px solid ${LINE_COLOR};border-radius:999px;color:${OK_COLOR};` +
  'background:rgba(10,18,29,.72);font-size:10px;letter-spacing:.12em;';
const WORKSPACE_HINT_CSS =
  'position:absolute;left:28px;right:28px;bottom:24px;display:flex;align-items:flex-end;' +
  'justify-content:space-between;gap:18px;padding:12px 14px;border-radius:8px;' +
  `border:1px solid ${LINE_COLOR};background:rgba(5,9,16,.84);box-shadow:0 10px 30px rgba(0,0,0,.22);`;
const HELP_CSS = `color:${TEXT_COLOR};white-space:pre-line;`;
const HINT_KEYS_CSS = `color:${MUTED_COLOR};white-space:nowrap;text-align:right;`;
const SHOP_CSS =
  'position:absolute;right:0;top:0;height:100%;box-sizing:border-box;display:flex;pointer-events:auto;' +
  'flex-direction:column;gap:14px;padding:24px 22px 20px;overflow:auto;' +
  `border-left:1px solid ${LINE_COLOR};background:linear-gradient(180deg,#080e18 0%,#060b13 100%);` +
  'box-shadow:-20px 0 48px rgba(0,0,0,.34);';
const SHOP_HEAD_CSS =
  `padding-bottom:14px;border-bottom:1px solid ${LINE_COLOR};display:flex;align-items:flex-end;` +
  'justify-content:space-between;gap:12px;';
const SHOP_TITLE_CSS = `color:${OK_COLOR};font-size:18px;letter-spacing:.12em;`;
const QUOTA_CSS =
  `padding:4px 8px;border-radius:999px;border:1px solid ${LINE_COLOR};color:${MUTED_COLOR};` +
  'font-size:10px;white-space:nowrap;';
const THREAT_CSS =
  `padding:10px;border:1px solid ${LINE_COLOR};border-radius:7px;color:${TEXT_COLOR};` +
  'background:rgba(21,34,52,.42);white-space:pre-line;';
const SHOP_NOTE_CSS = `color:${MUTED_COLOR};white-space:pre-line;`;
const CARDS_CSS = 'display:grid;grid-template-columns:1fr 1fr;gap:8px;';
const CARD_CSS =
  `min-height:104px;padding:11px;border:1px solid ${LINE_COLOR};border-radius:8px;` +
  'background:rgba(18,29,45,.72);box-shadow:inset 0 1px 0 rgba(255,255,255,.025);' +
  `color:${TEXT_COLOR};font:inherit;text-align:left;cursor:pointer;transition:border-color 100ms,background 100ms,opacity 100ms;`;
// 星币区(21 号):与免费甲板区共用同一组货架视觉,但一行一卡、更矮 ——
// 法令没有图标格,信息只有"名字 + 效果 + 价",给满格卡片是浪费侧栏的垂直空间
const STAR_CSS =
  'display:flex;flex-direction:column;gap:8px;padding-top:14px;' +
  `border-top:1px solid ${LINE_COLOR};`;
const STAR_HEAD_CSS =
  'display:flex;align-items:flex-end;justify-content:space-between;gap:10px;';
const STAR_TITLE_CSS = `color:${OK_COLOR};font-size:13px;letter-spacing:.1em;`;
const EDICT_ROW_CSS =
  `width:100%;padding:8px 10px;border:1px solid ${LINE_COLOR};border-radius:6px;` +
  'background:rgba(18,29,45,.72);' +
  `color:${TEXT_COLOR};font:inherit;text-align:left;cursor:pointer;transition:border-color 100ms,background 100ms,opacity 100ms;`;
const BTN_CSS =
  `width:100%;padding:9px 12px;border:1px solid ${LINE_COLOR};border-radius:6px;` +
  `background:rgba(43,74,110,.28);color:${OK_COLOR};font:inherit;cursor:pointer;letter-spacing:.04em;`;
const PRIMARY_BTN_CSS =
  BTN_CSS +
  `background:rgba(64,126,164,.38);border-color:${OK_COLOR};box-shadow:0 0 18px rgba(154,220,255,.12);`;
const ACTIONS_CSS =
  `margin-top:auto;padding-top:14px;border-top:1px solid ${LINE_COLOR};display:grid;grid-template-columns:1fr 1fr;gap:8px;`;
const TOAST_CSS =
  'position:fixed;left:28px;bottom:108px;z-index:22;display:none;padding:8px 12px;border-radius:6px;' +
  `border:1px solid ${LINE_COLOR};background:rgba(5,7,13,.82);` +
  'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;pointer-events:none;white-space:pre-line;';
const EVOLVE_COLOR = '#ffd76a';
const EVOLVE_LINE_COLOR = '#c9a04a';
const EVOLVE_BANNER_CSS =
  'position:absolute;left:28px;right:28px;bottom:116px;align-items:center;' +
  'justify-content:space-between;gap:14px;padding:10px 14px;border-radius:8px;' +
  `border:1px solid ${EVOLVE_LINE_COLOR};background:rgba(36,29,9,.82);` +
  'box-shadow:0 0 18px rgba(255,215,106,.14);white-space:pre-line;';
const EVOLVE_TEXT_CSS = `color:${EVOLVE_COLOR};`;
const EVOLVE_BTN_CSS =
  BTN_CSS +
  `width:auto;white-space:nowrap;pointer-events:auto;border-color:${EVOLVE_LINE_COLOR};` +
  `background:rgba(120,90,20,.32);color:${EVOLVE_COLOR};`;
const FLASH_MS = 1500;

/** 商店实际像素宽度；渲染器用同一个结果把飞船居中到左侧剩余区域。 */
export function refitShopWidth(viewportWidth: number): number {
  if (!(viewportWidth > 0) || !Number.isFinite(viewportWidth)) return 0;
  return Math.round(Math.min(430, Math.max(300, viewportWidth * 0.34)));
}

const PHASE_OFF = 0;
const PHASE_PICK = 1;
const PHASE_WELD = 2;
const PHASE_ARRANGE = 3;

const deckLocal: Vec2 = { x: 0, y: 0 };
const deckGrid = { col: 0, row: 0 };

/** 下一航段情报。它只读数据表，因此调波次脚本后整备面板会自动跟着变化。 */
export function refitThreatSummary(segmentIndex: number): string {
  const segment = WAVE_SEGMENTS[segmentIndex];
  if (!segment) return '下一波资料缺失';

  const seenBefore = new Set<number>();
  for (let i = 0; i < segmentIndex; i++) collectKinds(WAVE_SEGMENTS[i]!, seenBefore);
  const current = new Set<number>();
  collectKinds(segment, current);

  const streamNames: string[] = [];
  for (let i = 0; i < segment.streams.length; i++) {
    const stream = segment.streams[i]!;
    const name = ENEMIES[stream.kind]?.name ?? `未知敌型(${stream.kind})`;
    streamNames.push(`${name} ${round(stream.rate0)}→${round(stream.rate1)}/秒`);
  }
  const newNames: string[] = [];
  current.forEach((kind) => {
    if (!seenBefore.has(kind)) newNames.push(ENEMIES[kind]?.name ?? `未知敌型(${kind})`);
  });

  let maxBurst = 0;
  for (let i = 0; i < segment.bursts.length; i++) {
    const counts = segment.bursts[i]!.counts;
    let total = 0;
    for (let j = 0; j < counts.length; j++) total += counts[j] ?? 0;
    if (total > maxBurst) maxBurst = total;
  }

  const lines = [
    `下一波 ${segmentIndex + 1}/${WAVE_SEGMENTS.length} · ${segment.name}`,
    `持续 ${round(segment.duration)} 秒 · 主压流：${streamNames.join('、') || '无持续怪流'}`,
  ];
  if (newNames.length > 0) lines.push(`新敌型：${newNames.join('、')}`);
  if (segment.bursts.length > 0)
    lines.push(`突发压力：${segment.bursts.length} 次，最大一波 ${maxBurst} 只`);
  return lines.join('\n');
}

function collectKinds(segment: WaveSegment, out: Set<number>): void {
  for (let i = 0; i < segment.streams.length; i++) out.add(segment.streams[i]!.kind);
  for (let i = 0; i < segment.bursts.length; i++) {
    const counts = segment.bursts[i]!.counts;
    for (let kind = 0; kind < counts.length; kind++) if ((counts[kind] ?? 0) > 0) out.add(kind);
  }
  for (let i = 0; i < segment.elites.length; i++) out.add(segment.elites[i]!.kind);
}

function round(value: number): string {
  return String(Math.round(value * 100) / 100);
}

export function refitDenyMessage(code: number): string {
  switch (code) {
    case MOVE_NO_SOURCE:
      return '先选择一座炮塔或支援设施';
    case MOVE_NO_TARGET:
      return '目标必须是现有甲板上的空格';
    case MOVE_TARGET_TAKEN:
      return '目标格已有模块；可先点它切换选中模块';
    case MOVE_WEAPON_INTERIOR:
      return '炮塔只能移到当前甲板的边缘格';
    case MOVE_SAME_CELL:
      return '已经在这个格子上了';
    case WELD_OVERLAP:
      return '拼块与现有甲板重叠';
    case WELD_DETACHED:
      return '拼块必须贴住现有甲板的一条外边缘';
    case WELD_BAD_PIECE:
      return '没有这种甲板拼块';
    case WELD_BAD_ROTATION:
      return '拼块旋转档无效';
    case REFIT_ALREADY_WELDED:
      return '本轮整备已经焊过一块甲板';
    case REFIT_NOT_ACTIVE:
      return '整备已经结束';
    case EVOLVE_BAD_TARGET:
      return '进化目标格不是炮塔';
    case EVOLVE_BAD_SUPPORT:
      return '被吞噬的格不是支援设施';
    case EVOLVE_NOT_MAX_LEVEL:
      return `只有满级 Lv${TOWER_MAX_LEVEL} 的炮塔才能进化`;
    case EVOLVE_NO_RECIPE:
      return '这一对模块没有进化配方（进化不可逆）';
    case DOCK_EDICT_SOLD:
      return '这张法令已经售出';
    case DOCK_NO_STARCOINS:
      return '星币不足，无法购买';
    case DOCK_HP_FULL:
      return '船体已满血，无需修复';
    default:
      return `整备操作被拒绝(理由码 ${code})`;
  }
}

/**
 * 一张法令的效果文案 —— **逐字取自数值表**(EDICTS 的中性填档:乘法 1、加法 0),
 * ui 不许抄第二份(与 upgrade.ts 的 optionLabel 同一条口径)。全中性的守卫只是
 * 数据表写坏的兜底,正常七条至少有一档非中性。
 */
export function dockEdictEffect(type: number): string {
  const def = EDICTS[type];
  if (!def) return '未知法令';
  const parts: string[] = [];
  if (def.ammoFireRateMul !== 1) parts.push(`弹药射速 ×${round(def.ammoFireRateMul)}`);
  if (def.turnRateAdd !== 0) parts.push(`转向 +${round(def.turnRateAdd)}°/s`);
  if (def.magnetRadiusMul !== 1) parts.push(`拾取半径 ×${round(def.magnetRadiusMul)}`);
  if (def.heatMaxMul !== 1) parts.push(`过热上限 ×${round(def.heatMaxMul)}`);
  if (def.hullHpAdd !== 0) parts.push(`船体 HP +${def.hullHpAdd}`);
  if (def.cruiseSpeedMul !== 1) parts.push(`巡航速度 ×${round(def.cruiseSpeedMul)}`);
  if (parts.length === 0) return '全船被动';
  return parts.join(' · ');
}

function moduleName(world: World, index: number): string {
  const cell = world.deck.cells[index];
  if (!cell) return '未知模块';
  if (cell.content === CELL_WEAPON)
    return `${TOWERS[cell.towerType]?.name ?? '未知炮塔'} Lv${cell.level}`;
  if (cell.content === CELL_SUPPORT)
    return SUPPORTS[cell.supportType]?.name ?? '未知支援设施';
  return '空格';
}

function isTyping(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

export interface RefitFlowUi extends PlacementUiState {
  setWorld(world: World): void;
  syncHover(): void;
  show(segmentIndex: number): void;
  hide(): void;
}

export interface RefitFlowOpts {
  world: World;
  canvas: HTMLCanvasElement;
  screenToDeckLocal(sx: number, sy: number, out: Vec2): Vec2;
  /** 0 = 收起；>0 = 右侧商店占用的屏幕宽度，供渲染器把甲板移到左侧工作区中央。 */
  onLayout?(rightInset: number): void;
  onResolved(): void;
}

export function createRefitFlow(opts: RefitFlowOpts): RefitFlowUi {
  let world = opts.world;
  const { canvas, screenToDeckLocal, onLayout, onResolved } = opts;
  const state: PlacementUiState = {
    active: false,
    content: CELL_WEAPON,
    towerType: TOWER_AUTOCANNON,
    supportType: SUP_AMMO_BAY,
    weldPieceType: -1,
    weldRotation: 0,
    hoverCol: 0,
    hoverRow: 0,
    weldDenied: false,
    hoverIndex: -1,
    denyIndex: -1,
    moveSourceIndex: -1,
  };

  const root = document.createElement('div');
  root.style.cssText = ROOT_CSS;

  const workspace = document.createElement('div');
  workspace.style.cssText = WORKSPACE_CSS;
  const workspaceHead = document.createElement('div');
  workspaceHead.style.cssText = WORKSPACE_HEAD_CSS;
  const workspaceTitleBox = document.createElement('div');
  const workspaceEyebrow = document.createElement('div');
  workspaceEyebrow.style.cssText = EYEBROW_CSS;
  workspaceEyebrow.textContent = 'SHIP ASSEMBLY';
  const title = document.createElement('div');
  title.style.cssText = TITLE_CSS;
  title.textContent = '飞船装配';
  workspaceTitleBox.append(workspaceEyebrow, title);
  const phaseLabel = document.createElement('div');
  phaseLabel.style.cssText = PHASE_CSS;
  workspaceHead.append(workspaceTitleBox, phaseLabel);

  const workspaceHint = document.createElement('div');
  workspaceHint.style.cssText = WORKSPACE_HINT_CSS;
  const help = document.createElement('div');
  help.style.cssText = HELP_CSS;
  const hintKeys = document.createElement('div');
  hintKeys.style.cssText = HINT_KEYS_CSS;
  hintKeys.textContent = '左键 确认  ·  右键 / Esc 取消  ·  R 旋转';
  workspaceHint.append(help, hintKeys);

  // 空间进化提示条(17 号 issue):重排阶段扫甲板,有配方配对时亮出"可进化"横幅与确认按钮。
  // 整条横幅 pointer-events 随根节点为 none,只有确认按钮自己显式 pointer-events:auto ——
  // 提示文字下方的甲板照样可以点,按钮才是唯一会吞点击的区域。
  const evolveBanner = document.createElement('div');
  evolveBanner.style.cssText = EVOLVE_BANNER_CSS;
  const evolveText = document.createElement('div');
  evolveText.style.cssText = EVOLVE_TEXT_CSS;
  const evolveBtn = document.createElement('button');
  evolveBtn.style.cssText = EVOLVE_BTN_CSS;
  evolveBtn.textContent = '确认进化';
  evolveBanner.append(evolveText, evolveBtn);
  workspace.append(workspaceHead, workspaceHint, evolveBanner);

  const shop = document.createElement('div');
  shop.style.cssText = SHOP_CSS;
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
  const quota = document.createElement('div');
  quota.style.cssText = QUOTA_CSS;
  shopHead.append(shopTitleBox, quota);

  const threat = document.createElement('div');
  threat.style.cssText = THREAT_CSS;
  const shopNote = document.createElement('div');
  shopNote.style.cssText = SHOP_NOTE_CSS;
  const cards = document.createElement('div');
  cards.style.cssText = CARDS_CSS;

  // 星币区(21 号):免费甲板下方的付费货架 —— 法令卡(即时生效,无放置)+ 付费修复。
  // 与卡片同一条"只建一次、整局复用"的生命周期:每次 syncStarShop 只改文案与置灰态,
  // 不重建 DOM(理由与 pieceButtons 那段一字同源)。
  const starSection = document.createElement('div');
  starSection.style.cssText = STAR_CSS;
  const starHead = document.createElement('div');
  starHead.style.cssText = STAR_HEAD_CSS;
  const starTitle = document.createElement('div');
  starTitle.style.cssText = STAR_TITLE_CSS;
  starTitle.textContent = '星币商店';
  const starBalance = document.createElement('div');
  starBalance.style.cssText = QUOTA_CSS;
  starHead.append(starTitle, starBalance);
  starSection.appendChild(starHead);
  const edictRows: HTMLButtonElement[] = [];
  for (let i = 0; i < DOCK_EDICT_COUNT; i++) {
    const row = document.createElement('button');
    row.style.cssText = EDICT_ROW_CSS;
    row.addEventListener('click', () => buyDockEdict(i));
    starSection.appendChild(row);
    edictRows.push(row);
  }
  const repairBtn = document.createElement('button');
  repairBtn.style.cssText = BTN_CSS;
  repairBtn.textContent = `修复船体 +${Math.round(DOCK_REPAIR_FRACTION * 100)}% HP · ${DOCK_REPAIR_PRICE} ★`;
  repairBtn.addEventListener('click', buyRepair);
  starSection.appendChild(repairBtn);

  const actions = document.createElement('div');
  actions.style.cssText = ACTIONS_CSS;
  const skipWeld = document.createElement('button');
  skipWeld.style.cssText = BTN_CSS;
  skipWeld.textContent = '不扩建，进入重排';
  const back = document.createElement('button');
  back.style.cssText = BTN_CSS;
  back.textContent = '返回扩建选择';
  const rotate = document.createElement('button');
  rotate.style.cssText = BTN_CSS;
  rotate.textContent = '旋转(R)';
  const finish = document.createElement('button');
  finish.style.cssText = PRIMARY_BTN_CSS;
  finish.textContent = '完成装配 · 开始下一波';
  actions.append(skipWeld, back, rotate, finish);
  shop.append(shopHead, threat, shopNote, cards, starSection, actions);
  root.append(workspace, shop);

  const toast = document.createElement('div');
  toast.style.cssText = TOAST_CSS;
  const ui = document.getElementById('ui')!;
  ui.append(root, toast);

  const pieceButtons: HTMLButtonElement[] = [];
  for (let i = 0; i < DECK_PIECES.length; i++) {
    const def = DECK_PIECES[i]!;
    const button = document.createElement('button');
    button.style.cssText = CARD_CSS;
    button.innerHTML =
      `<span style="display:block;color:${OK_COLOR};font-size:22px;line-height:1;margin-bottom:9px;text-shadow:0 0 10px rgba(154,220,255,.28)">${def.icon}</span>` +
      `<span style="display:block;color:${TEXT_COLOR};font-size:13px;margin-bottom:4px">${def.name}</span>` +
      `<span style="color:${MUTED_COLOR}">+${deckPieceCellCount(i)} 格 · 本轮免费</span>`;
    button.addEventListener('click', () => choosePiece(i));
    cards.appendChild(button);
    pieceButtons.push(button);
  }

  let phase = PHASE_OFF;
  let lastX = 0;
  let lastY = 0;
  let flashTimer = 0;
  let layoutActive = false;
  /** 进化配对的复用缓冲:findEvolutionPairs 收 out 正是为了这里每帧整块重写不新建数组(铁律 3) */
  const evoBuf: number[] = [];

  /**
   * 重扫进化配对并刷新提示条。挂在 syncPanel 顶部 —— 甲板的一切变更(焊/搬/进化/阶段切换)
   * 都经过 syncPanel,于是配对随重排变化的那一步天然在这里:刚吃完一对,当场扫出下一对。
   * 配对表只在前 [0] 塔格 / [1] 支援格那对可触发,其余对先只报个数(吃一对重扫一次,下一对自动顶上)。
   */
  function syncEvolve(): void {
    findEvolutionPairs(world.deck, evoBuf);
    const has = phase === PHASE_ARRANGE && evoBuf.length >= 2;
    evolveBtn.disabled = !has;
    evolveBtn.style.cursor = has ? 'pointer' : 'not-allowed';
    evolveBanner.style.display = has ? 'flex' : 'none';
    if (!has) return;
    const towerCell = world.deck.cells[evoBuf[0]!];
    const supportCell = world.deck.cells[evoBuf[1]!];
    if (!towerCell || !supportCell) return;
    const result = evolutionOf(towerCell.towerType, supportCell.supportType);
    const resultName = result >= 0 ? TOWERS[result]?.name ?? '未知进化塔' : '未知进化塔';
    let text =
      `可进化：${TOWERS[towerCell.towerType]?.name ?? '未知炮塔'} Lv${towerCell.level} ＋ ` +
      `${SUPPORTS[supportCell.supportType]?.name ?? '未知支援'} → ${resultName}\n` +
      '确认后支援格释放、塔替换为进化型（不可逆）';
    if (evoBuf.length >= 4) text += `\n另有 ${(evoBuf.length - 2) / 2} 对可进化`;
    evolveText.textContent = text;
  }

  /**
   * 确认进化:吃配对表第一对(塔格 + 支援格),按返回码给反馈。
   * 成功:世界当场改甲板(支援格清空、塔替换为进化型,revision bump 由 evolveAt 负责),
   * 这里 syncPanel 重扫配对,被吃掉的一对立刻从提示里消失、下一对顶上。
   * 失败:refitDenyMessage 说人话 + 塔格红闪,配对原样保留。
   * 相位闸门 = 只认 PHASE_ARRANGE:焊接/选拼块阶段按钮本就隐藏,这层 if 是防桩的拦网。
   */
  function confirmEvolve(): void {
    if (phase !== PHASE_ARRANGE || evoBuf.length < 2) return;
    const towerCell = world.deck.cells[evoBuf[0]!];
    const supportCell = world.deck.cells[evoBuf[1]!];
    if (!towerCell || !supportCell) {
      syncEvolve();
      return;
    }
    const result = evolutionOf(towerCell.towerType, supportCell.supportType);
    const resultName = result >= 0 ? TOWERS[result]?.name ?? '未知进化塔' : '未知进化塔';
    const code = world.evolveRefitTower(towerCell.col, towerCell.row, supportCell.col, supportCell.row);
    if (code === EVOLVE_OK) {
      flash(`已进化：${resultName}（支援格已释放，不可逆）`, EVOLVE_COLOR);
      syncPanel();
      return;
    }
    state.denyIndex = evoBuf[0]!;
    flash(refitDenyMessage(code), DENY_COLOR);
    syncEvolve();
  }

  function syncLayout(): void {
    const width = refitShopWidth(window.innerWidth);
    shop.style.width = `${width}px`;
    workspace.style.right = `${width}px`;
    toast.style.right = `${width + 28}px`;
    if (layoutActive) onLayout?.(width);
  }

  syncLayout();

  function pick(clientX: number, clientY: number): number {
    const rect = canvas.getBoundingClientRect();
    const p = screenToDeckLocal(clientX - rect.left, clientY - rect.top, deckLocal);
    return cellIndexAtLocal(world.deck, p.x, p.y);
  }

  function pickGrid(clientX: number, clientY: number): void {
    const rect = canvas.getBoundingClientRect();
    const p = screenToDeckLocal(clientX - rect.left, clientY - rect.top, deckLocal);
    deckGridAtLocal(world.deck, p.x, p.y, deckGrid);
    if (deckGrid.col !== state.hoverCol || deckGrid.row !== state.hoverRow)
      state.weldDenied = false;
    state.hoverCol = deckGrid.col;
    state.hoverRow = deckGrid.row;
  }

  function flash(text: string, color: string): void {
    toast.textContent = text;
    toast.style.color = color;
    toast.style.display = 'block';
    if (flashTimer) window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => {
      flashTimer = 0;
      toast.style.display = 'none';
      state.denyIndex = -1;
      state.weldDenied = false;
    }, FLASH_MS);
  }

  function clearFlash(): void {
    if (flashTimer) window.clearTimeout(flashTimer);
    flashTimer = 0;
    toast.style.display = 'none';
    state.denyIndex = -1;
    state.weldDenied = false;
  }

  function resetInteraction(): void {
    state.active = false;
    state.weldPieceType = -1;
    state.weldRotation = 0;
    state.weldDenied = false;
    state.hoverIndex = -1;
    state.denyIndex = -1;
    state.moveSourceIndex = -1;
  }

  function syncPanel(): void {
    syncEvolve();
    syncStarShop();
    cards.style.display = 'grid';
    skipWeld.style.display = phase === PHASE_PICK ? 'block' : 'none';
    rotate.style.display = phase === PHASE_WELD ? 'block' : 'none';
    finish.style.display = phase === PHASE_ARRANGE ? 'block' : 'none';
    back.style.display =
      phase === PHASE_WELD || (phase === PHASE_ARRANGE && !world.refitWelded) ? 'block' : 'none';

    skipWeld.style.gridColumn = '1 / -1';
    finish.style.gridColumn = phase === PHASE_ARRANGE && world.refitWelded ? '1 / -1' : 'auto';

    const canChoosePiece = phase === PHASE_PICK || phase === PHASE_WELD;
    for (let i = 0; i < pieceButtons.length; i++) {
      const button = pieceButtons[i]!;
      const enabled = canChoosePiece && !world.refitWelded && hasWeldPlacement(world.deck, i);
      const selected = phase === PHASE_WELD && state.weldPieceType === i;
      button.disabled = !enabled;
      button.style.opacity = enabled ? '1' : '.34';
      button.style.cursor = enabled ? 'pointer' : 'not-allowed';
      button.style.borderColor = selected ? OK_COLOR : LINE_COLOR;
      button.style.background = selected ? 'rgba(43,84,116,.92)' : 'rgba(18,29,45,.72)';
      button.style.boxShadow = selected
        ? '0 0 0 1px rgba(154,220,255,.16),0 0 18px rgba(154,220,255,.12)'
        : 'inset 0 1px 0 rgba(255,255,255,.025)';
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    }

    if (phase === PHASE_PICK) {
      phaseLabel.textContent = '01 · 选择扩建';
      quota.textContent = '甲板配额 0 / 1';
      shopNote.textContent = '选择一块甲板拼块，再到左侧船体边缘确认焊接位置。\n本轮免费且最多选择一块。';
      help.textContent = '左侧是飞船装配区，格子与射界保持常显。\n从右侧商店选择甲板，或跳过扩建直接整理现有模块。';
      hintKeys.textContent = '数字键 1–4 选择  ·  左键 确认';
      return;
    }
    if (phase === PHASE_WELD) {
      const name = DECK_PIECES[state.weldPieceType]?.name ?? '未知拼块';
      phaseLabel.textContent = '02 · 定位焊接';
      quota.textContent = '甲板配额 0 / 1';
      shopNote.textContent = `已选 ${name}。可以直接点另一张商品切换形状，确认焊接后货架锁定。`;
      help.textContent = `正在定位：${name} · ${state.weldRotation * 90}°\n移动到现有甲板外沿，点击冷色 ghost 确认焊接。`;
      hintKeys.textContent = 'R 旋转  ·  Esc / 右键 取消选择';
      back.textContent = '取消当前选择';
      return;
    }
    phaseLabel.textContent = '03 · 模块重排';
    quota.textContent = world.refitWelded ? '甲板配额 1 / 1' : '本轮未扩建';
    shopNote.textContent = world.refitWelded
      ? '甲板已焊接，商店本轮关闭。整理好左侧模块后即可开始下一波。'
      : '本轮尚未扩建；仍可返回商店选择一块甲板。现有模块可在左侧自由重排。';
    back.textContent = '返回甲板商店';
    hintKeys.textContent = '左键 选取 / 落位  ·  Esc / 右键 取消';
    if (state.moveSourceIndex >= 0) {
      help.textContent =
        `已拿起：${moduleName(world, state.moveSourceIndex)}\n` +
        '点击冷色空格落位；点击另一座模块可切换选择，Esc 取消。';
    } else {
      help.textContent = '重排阶段：点击一座炮塔或支援设施，再点击目标空格。\n炮塔只能落在边缘格；支援可落在任意空甲板格。';
    }
  }

  /**
   * 星币区的置灰态与文案,挂在 syncPanel 顶部 —— 与 syncEvolve 同一条"一切变更都经过
   * syncPanel"的刷新路径:买过一张卡/修过一次血/换过阶段,当场重刷余额与货架。
   * 置灰只认两条 UI 读数:货架已售出(disabled)、船满血(disabled) —— **星币不足不置灰**,
   * 那是点击时的 deny 反馈(见 buyDockEdict / buyRepair):整备期间余额随时可能被另一张
   * 卡花掉,置灰态会过期,真正的裁决始终以 world 的返回码为准(照 upgradeFlow 的 syncRerollState
   * 同一条口径,只是把"不足"那半边留给了点击反馈,让玩家能看到"买不起"这句话)。
   */
  function syncStarShop(): void {
    starBalance.textContent = `★ ${world.starCoins}`;
    for (let i = 0; i < edictRows.length; i++) {
      const row = edictRows[i]!;
      const type = world.dockEdictOffers[i];
      const sold = type === undefined || type < 0;
      row.disabled = sold;
      row.style.opacity = sold ? '.34' : '1';
      row.style.cursor = sold ? 'not-allowed' : 'pointer';
      if (sold) {
        row.innerHTML =
          `<span style="display:block;color:${MUTED_COLOR};font-size:12px">` +
          `${type === undefined ? '本轮无货' : '已售出'}</span>`;
      } else {
        row.innerHTML =
          `<span style="display:flex;justify-content:space-between;gap:8px;color:${OK_COLOR};font-size:13px;margin-bottom:3px">` +
          `<span>${EDICTS[type]?.name ?? `未知法令(${type})`}</span><span>${DOCK_EDICT_PRICE} ★</span></span>` +
          `<span style="color:${MUTED_COLOR};font-size:11px">${dockEdictEffect(type)}</span>`;
      }
    }
    const full = world.ship.hp >= world.ship.maxHp;
    repairBtn.disabled = full;
    repairBtn.style.opacity = full ? '.34' : '1';
    repairBtn.style.cursor = full ? 'not-allowed' : 'pointer';
  }

  /**
   * 买第 index 张法令卡(21 号):**即时生效、无放置** —— 法令是全船被动,点一下就是买,
   * 不存在"买完再摆"这回事(与升级里的法令卡同一条授予语义)。
   * 成功:World 已扣费/置掩码/下架,这里重刷货架并报回执;失败(星币不足/已售出/整备已结束):
   * refitDenyMessage 说人话,失败原子不动账 —— 按钮置灰态只在"售出/满血"两处给,
   * 星币不足正是靠这一支的 toast 反馈(见 syncStarShop 那段)。
   */
  function buyDockEdict(index: number): void {
    if (phase === PHASE_OFF) return;
    const row = edictRows[index];
    if (!row || row.disabled) return; // 置灰(已售出)自守:真 DOM 不会点穿 disabled,桩会
    const type = world.dockEdictOffers[index];
    const code = world.buyDockEdict(index);
    if (code < 0) {
      flash(refitDenyMessage(code), DENY_COLOR);
      syncStarShop();
      return;
    }
    // 成功路径上 type 必然 ≥ 0(刚被世界扣费授予),这里只是把 undefined 收窄掉
    const name = type !== undefined && type >= 0 ? (EDICTS[type]?.name ?? '法令') : '法令';
    flash(`已购入：${name}`, OK_COLOR);
    audioBus.playPlace();
    syncPanel();
  }

  /** 买一次付费修复(21 号):可重复购买、满血时置灰(灰态由 syncStarShop 管,这里只认返回码)。 */
  function buyRepair(): void {
    if (phase === PHASE_OFF || repairBtn.disabled) return; // 满血置灰自守(理由同上)
    const code = world.buyDockRepair();
    if (code < 0) {
      flash(refitDenyMessage(code), DENY_COLOR);
      syncStarShop();
      return;
    }
    flash(`已修复船体 +${Math.round(DOCK_REPAIR_FRACTION * 100)}%`, OK_COLOR);
    audioBus.playPlace();
    syncPanel();
  }

  function choosePiece(pieceType: number): void {
    if (
      (phase !== PHASE_PICK && phase !== PHASE_WELD) ||
      world.refitWelded ||
      !hasWeldPlacement(world.deck, pieceType)
    )
      return;
    resetInteraction();
    state.active = true;
    state.weldPieceType = pieceType;
    pickGrid(lastX, lastY);
    phase = PHASE_WELD;
    clearFlash();
    syncPanel();
  }

  function enterArrange(): void {
    resetInteraction();
    phase = PHASE_ARRANGE;
    clearFlash();
    syncPanel();
  }

  function backToPick(): void {
    if (world.refitWelded) return;
    resetInteraction();
    phase = PHASE_PICK;
    clearFlash();
    syncPanel();
  }

  function confirmWeld(clientX: number, clientY: number): void {
    pickGrid(clientX, clientY);
    const code = world.weldRefitPiece(
      state.weldPieceType,
      state.weldRotation,
      state.hoverCol,
      state.hoverRow,
    );
    if (isWeldSuccess(code)) {
      const name = DECK_PIECES[state.weldPieceType]?.name ?? '甲板拼块';
      enterArrange();
      flash(`已焊接 ${name}，现在可以重排模块`, OK_COLOR);
      audioBus.playPlace();
      return;
    }
    state.weldDenied = true;
    flash(refitDenyMessage(code), DENY_COLOR);
  }

  function selectSource(index: number): void {
    state.moveSourceIndex = index;
    state.hoverIndex = index;
    state.active = true;
    state.denyIndex = -1;
    syncPanel();
  }

  function clearSource(): void {
    state.moveSourceIndex = -1;
    state.hoverIndex = -1;
    state.denyIndex = -1;
    state.active = false;
    syncPanel();
  }

  function arrangeClick(clientX: number, clientY: number): void {
    const index = pick(clientX, clientY);
    const target = index >= 0 ? world.deck.cells[index] : undefined;
    if (!target || !target.occupied) {
      state.denyIndex = index;
      flash(refitDenyMessage(MOVE_NO_TARGET), DENY_COLOR);
      return;
    }

    if (state.moveSourceIndex < 0) {
      if (target.content === CELL_WEAPON || target.content === CELL_SUPPORT) {
        selectSource(index);
        return;
      }
      state.denyIndex = index;
      flash('请选择一座炮塔或支援设施', DENY_COLOR);
      return;
    }

    if (index === state.moveSourceIndex) {
      clearSource();
      return;
    }
    if (target.content !== CELL_EMPTY) {
      selectSource(index);
      return;
    }

    const source = world.deck.cells[state.moveSourceIndex];
    if (!source) {
      clearSource();
      flash(refitDenyMessage(MOVE_NO_SOURCE), DENY_COLOR);
      return;
    }
    const name = moduleName(world, state.moveSourceIndex);
    const code = world.moveRefitModule(source.col, source.row, target.col, target.row);
    if (code === MOVE_OK) {
      clearSource();
      flash(`已移动 ${name}`, OK_COLOR);
      return;
    }
    state.denyIndex = index;
    flash(refitDenyMessage(code), DENY_COLOR);
  }

  function rotatePiece(): void {
    if (phase !== PHASE_WELD) return;
    state.weldRotation = (state.weldRotation + 1) % DECK_ROTATIONS;
    state.weldDenied = false;
    syncPanel();
  }

  function resolve(): void {
    const completed = world.completeRefit();
    hide();
    if (completed) onResolved();
  }

  function hide(): void {
    phase = PHASE_OFF;
    resetInteraction();
    root.style.display = 'none';
    ui.style.zIndex = '';
    syncEvolve();
    if (layoutActive) {
      layoutActive = false;
      onLayout?.(0);
    }
  }

  skipWeld.addEventListener('click', enterArrange);
  back.addEventListener('click', backToPick);
  rotate.addEventListener('click', rotatePiece);
  finish.addEventListener('click', resolve);
  evolveBtn.addEventListener('click', confirmEvolve);
  window.addEventListener('resize', syncLayout);

  window.addEventListener('mousemove', (event) => {
    lastX = event.clientX;
    lastY = event.clientY;
    if (!state.active) return;
    if (phase === PHASE_WELD) pickGrid(lastX, lastY);
    else if (phase === PHASE_ARRANGE) state.hoverIndex = pick(lastX, lastY);
  });

  window.addEventListener('keydown', (event) => {
    if (phase === PHASE_OFF || isTyping()) return;
    if (event.code === 'KeyR' && phase === PHASE_WELD) {
      event.preventDefault();
      rotatePiece();
      return;
    }
    if ((phase === PHASE_PICK || phase === PHASE_WELD) && event.code.startsWith('Digit')) {
      const n = Number(event.code.slice(5));
      if (Number.isInteger(n) && n >= 1 && n <= pieceButtons.length) {
        event.preventDefault();
        choosePiece(n - 1);
      }
      return;
    }
    if (event.code !== 'Escape') return;
    event.preventDefault();
    if (phase === PHASE_WELD) backToPick();
    else if (phase === PHASE_ARRANGE && state.moveSourceIndex >= 0) clearSource();
  });

  canvas.addEventListener('click', (event) => {
    lastX = event.clientX;
    lastY = event.clientY;
    if (phase === PHASE_WELD) confirmWeld(event.clientX, event.clientY);
    else if (phase === PHASE_ARRANGE) arrangeClick(event.clientX, event.clientY);
  });

  canvas.addEventListener('contextmenu', (event) => {
    if (phase === PHASE_OFF) return;
    event.preventDefault();
    if (phase === PHASE_WELD) backToPick();
    else if (phase === PHASE_ARRANGE && state.moveSourceIndex >= 0) clearSource();
  });

  return Object.assign(state, {
    show(segmentIndex: number): void {
      if (!world.refitPending) {
        hide();
        onResolved();
        return;
      }
      phase = PHASE_PICK;
      resetInteraction();
      clearFlash();
      threat.textContent = refitThreatSummary(segmentIndex);
      // Tweakpane 是运行时追加到 body 的后置兄弟；临时抬高 #ui 的堆叠层，确保固定商店完整盖住它。
      // #ui 自身 pointer-events:none，左侧没有 UI 控件的区域仍会把点击透给 canvas。
      ui.style.zIndex = '10';
      root.style.display = 'block';
      layoutActive = true;
      syncLayout();
      syncPanel();
    },
    hide,
    syncHover(): void {
      if (!state.active) return;
      if (phase === PHASE_WELD) pickGrid(lastX, lastY);
      else if (phase === PHASE_ARRANGE) state.hoverIndex = pick(lastX, lastY);
    },
    setWorld(next: World): void {
      world = next;
      hide();
      clearFlash();
    },
  });
}
