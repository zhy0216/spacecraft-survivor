/**
 * 航段整备流程：每次敌群升级前冻结下一波，允许最多焊一块甲板，并自由搬运现有模块。
 * 与普通升级彻底分开：本流程不消费残骸、不生成炮塔/支援，也没有任何战斗中可调用的移动入口。
 */
import { DECK_PIECES, deckPieceCellCount } from '../data/deckPieces';
import { ENEMIES } from '../data/enemies';
import { SUP_AMMO_BAY, SUPPORTS } from '../data/supports';
import { TOWER_AUTOCANNON, TOWERS } from '../data/towers';
import { WAVE_SEGMENTS, type WaveSegment } from '../data/waves';
import type { PlacementUiState } from '../render/renderer';
import {
  CELL_EMPTY,
  CELL_SUPPORT,
  CELL_WEAPON,
  cellIndexAtLocal,
  deckGridAtLocal,
  DECK_ROTATIONS,
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
import type { Vec2 } from '../sim/ship';
import { REFIT_ALREADY_WELDED, REFIT_NOT_ACTIVE, type World } from '../sim/world';

const OK_COLOR = '#9adcff';
const DENY_COLOR = '#ff7a6b';
const TEXT_COLOR = '#c8dcf0';
const MUTED_COLOR = '#6f89a5';
const LINE_COLOR = '#2b4a6e';
const PANEL_CSS =
  'position:fixed;left:18px;top:18px;width:min(330px,calc(100vw - 36px));display:none;' +
  'flex-direction:column;gap:10px;padding:14px;border-radius:9px;' +
  `border:1px solid ${LINE_COLOR};background:rgba(7,12,21,.95);color:${TEXT_COLOR};` +
  'font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;user-select:none;';
const TITLE_CSS = `color:${OK_COLOR};font-size:16px;letter-spacing:.1em;`;
const THREAT_CSS =
  `padding:10px;border:1px solid ${LINE_COLOR};border-radius:7px;color:${TEXT_COLOR};` +
  'background:rgba(21,34,52,.42);white-space:pre-line;';
const HELP_CSS = `color:${MUTED_COLOR};white-space:pre-line;`;
const CARDS_CSS = 'display:grid;grid-template-columns:1fr 1fr;gap:8px;';
const CARD_CSS =
  `padding:9px;border:1px solid ${LINE_COLOR};border-radius:7px;background:rgba(18,29,45,.72);` +
  `color:${TEXT_COLOR};font:inherit;text-align:left;cursor:pointer;`;
const BTN_CSS =
  `padding:8px 12px;border:1px solid ${LINE_COLOR};border-radius:6px;background:rgba(43,74,110,.28);` +
  `color:${OK_COLOR};font:inherit;cursor:pointer;`;
const TOAST_CSS =
  'position:fixed;left:18px;bottom:18px;display:none;padding:8px 12px;border-radius:6px;' +
  `border:1px solid ${LINE_COLOR};background:rgba(5,7,13,.82);` +
  'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;pointer-events:none;';
const FLASH_MS = 1500;

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
    default:
      return `整备操作被拒绝(理由码 ${code})`;
  }
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
  onResolved(): void;
}

export function createRefitFlow(opts: RefitFlowOpts): RefitFlowUi {
  let world = opts.world;
  const { canvas, screenToDeckLocal, onResolved } = opts;
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

  const panel = document.createElement('div');
  panel.style.cssText = PANEL_CSS;
  const title = document.createElement('div');
  title.style.cssText = TITLE_CSS;
  title.textContent = '航段整备';
  const threat = document.createElement('div');
  threat.style.cssText = THREAT_CSS;
  const help = document.createElement('div');
  help.style.cssText = HELP_CSS;
  const cards = document.createElement('div');
  cards.style.cssText = CARDS_CSS;
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
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
  finish.style.cssText = BTN_CSS;
  finish.textContent = '锁定布局，开始下一波';
  actions.append(skipWeld, back, rotate, finish);
  panel.append(title, threat, help, cards, actions);

  const toast = document.createElement('div');
  toast.style.cssText = TOAST_CSS;
  const ui = document.getElementById('ui')!;
  ui.append(panel, toast);

  const pieceButtons: HTMLButtonElement[] = [];
  for (let i = 0; i < DECK_PIECES.length; i++) {
    const def = DECK_PIECES[i]!;
    const button = document.createElement('button');
    button.style.cssText = CARD_CSS;
    button.innerHTML =
      `<span style="color:${OK_COLOR};font-size:18px">${def.icon}</span><br>` +
      `${def.name}<br><span style="color:${MUTED_COLOR}">+${deckPieceCellCount(i)} 格</span>`;
    button.addEventListener('click', () => choosePiece(i));
    cards.appendChild(button);
    pieceButtons.push(button);
  }

  let phase = PHASE_OFF;
  let lastX = 0;
  let lastY = 0;
  let flashTimer = 0;

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
    cards.style.display = phase === PHASE_PICK ? 'grid' : 'none';
    skipWeld.style.display = phase === PHASE_PICK ? 'block' : 'none';
    rotate.style.display = phase === PHASE_WELD ? 'block' : 'none';
    finish.style.display = phase === PHASE_ARRANGE ? 'block' : 'none';
    back.style.display =
      phase === PHASE_WELD || (phase === PHASE_ARRANGE && !world.refitWelded) ? 'block' : 'none';

    if (phase === PHASE_PICK) {
      help.textContent = '本轮最多焊接一块甲板，也可以跳过扩建。\n旧甲板不可拆；进入重排后可移动炮塔与支援设施。';
      for (let i = 0; i < pieceButtons.length; i++) {
        const enabled = hasWeldPlacement(world.deck, i);
        pieceButtons[i]!.disabled = !enabled;
        pieceButtons[i]!.style.opacity = enabled ? '1' : '.38';
        pieceButtons[i]!.style.cursor = enabled ? 'pointer' : 'not-allowed';
      }
      return;
    }
    if (phase === PHASE_WELD) {
      const name = DECK_PIECES[state.weldPieceType]?.name ?? '未知拼块';
      help.textContent = `焊接 ${name} · ${state.weldRotation * 90}°\nR 旋转，点击甲板旁的冷色 ghost 确认。`;
      return;
    }
    if (state.moveSourceIndex >= 0) {
      help.textContent =
        `已拿起：${moduleName(world, state.moveSourceIndex)}\n` +
        '点击冷色空格落位；点击另一座模块可切换选择，Esc 取消。';
    } else {
      help.textContent = '重排阶段：点击一座炮塔或支援设施，再点击目标空格。\n炮塔只能落在边缘格；支援可落在任意空甲板格。';
    }
  }

  function choosePiece(pieceType: number): void {
    if (phase !== PHASE_PICK || !hasWeldPlacement(world.deck, pieceType)) return;
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
    panel.style.display = 'none';
  }

  skipWeld.addEventListener('click', enterArrange);
  back.addEventListener('click', backToPick);
  rotate.addEventListener('click', rotatePiece);
  finish.addEventListener('click', resolve);

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
      syncPanel();
      panel.style.display = 'flex';
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
