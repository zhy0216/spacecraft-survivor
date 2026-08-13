/**
 * 武器面板(按 I)—— DOM 覆盖层,永不 import pixi(铁律 1 的另一半)。
 *
 * 八个武器槽围成一圈、每槽朝向固定(sim/armory 的 WEAPON_SLOT_FACING),于是"把哪门炮摆到船头"
 * 是玩家唯一能主动调的火控决策。本面板就干这一件事:**时停 + 点两下换位**。
 *   点第一下 = 选中(高亮);点第二下 = 与选中的那个槽互换内容;点同一个 = 取消选中。
 * 不能卖、不能拆:换位调的是**布局**而不是强度(强度的出口是升级与合成),
 * 多一个"扔掉武器"的按钮就多一条手滑扔掉主力炮的路,而这一局没有任何撤销。
 *
 * 与暂停菜单/升级三选一共用同一套"run.paused 挡住 advance"的时停口径(见 main.ts):
 * 本面板**不认识 loop、不动 run** —— 它只把"玩家想开/关面板"说给 main 听,
 * 冻结与恢复由 main 的回调执行(与 pauseMenu 一字同源)。
 * 它认识 World,但只读 weapons + 调 swapWeapons 这一个方法:换位的裁决在 sim,不在这里。
 *
 * 布局是**九宫格**:八个槽按朝向摆在自己那一格(上 = 船头),正中是一枚朝上的船形指针。
 * 摆成一圈而不是一行八格,是因为槽位编号本身没有意义 —— 玩家要读的是"这门炮朝哪",
 * 而一行八格的列表逼着他在脑子里把编号翻译成方位,那正是这个面板要消灭的那一步。
 */
import { throttleName, TOWERS, towerArcDeg, towerRange } from '../data/towers';
import { audioBus } from '../render/audio';
import { slotSustainedDps } from '../sim/tower';
import { WEAPON_SLOT_COUNT, type WeaponSlot } from '../sim/armory';
import type { World } from '../sim/world';
import { isTyping } from '../core/isTyping';
// 朝向中文名从舰船图那边取:商店的舰船一览与本面板印的必须是同一张表,
// 各存一份就会出现"同一个槽在两个面板上叫不同的方向"(SLOT_CELL 与它咬合的纪律见下)
import { SLOT_FACING_NAME } from './shipDiagram';

const OK_COLOR = '#9adcff';
const IDLE_COLOR = '#5f7a99';
const VALUE_COLOR = '#c8dcf0';
const LINE_COLOR = '#2b4a6e';
const SEL_COLOR = '#ffd479';

const ROOT_CSS =
  'position:fixed;inset:0;display:none;align-items:center;justify-content:center;' +
  'background:rgba(5,7,13,.82);' +
  'font:13px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;user-select:none;';

const CARD_CSS =
  'padding:20px 24px;border-radius:10px;' +
  `background:rgba(10,16,26,.94);border:1px solid ${LINE_COLOR};text-align:center;`;

const TITLE_CSS = `color:${OK_COLOR};font-size:18px;letter-spacing:.22em;margin-bottom:4px;`;
const SUB_CSS = `color:${IDLE_COLOR};font-size:11px;letter-spacing:.06em;margin-bottom:14px;`;

/** 九宫格:8 个槽 + 正中的船形指针 */
const GRID_CSS = 'display:grid;grid-template-columns:repeat(3,124px);grid-gap:8px;justify-content:center;';

const CELL_CSS =
  'padding:8px 6px;border-radius:8px;cursor:pointer;font:inherit;text-align:center;' +
  `border:1px solid ${LINE_COLOR};background:rgba(43,74,110,.22);color:${VALUE_COLOR};` +
  'min-height:74px;display:flex;flex-direction:column;justify-content:center;gap:2px;';

const CENTER_CSS =
  'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
  `color:${IDLE_COLOR};font-size:11px;letter-spacing:.08em;`;

const NAME_CSS = 'font-size:12px;letter-spacing:.04em;';
const META_CSS = `color:${IDLE_COLOR};font-size:10px;letter-spacing:.02em;`;
const FACING_CSS = `color:${IDLE_COLOR};font-size:10px;letter-spacing:.1em;`;

const HINT_CSS = `color:${IDLE_COLOR};font-size:11px;margin-top:12px;letter-spacing:.06em;`;

/**
 * 槽位编号 → 九宫格下标(0..8,行优先;4 = 正中,留给船形指针)。
 * 槽 0 = 正前 → 顶部中间;顺时针一圈 —— 与 sim/armory 的 WEAPON_SLOT_FACING 一一对应,
 * **改了那张表就得改这张**(两张表错位 = 面板上换的位置与实际朝向对不上,
 * 而那是玩家换完位才会在战斗里发现的那类错)。
 */
const SLOT_CELL: number[] = [1, 2, 5, 8, 7, 6, 3, 0];

export interface ArmoryPanelHooks {
  /** 能不能开面板?(main 传 `() => !run.paused` —— 时停/结算/起手选择时 I 键不响应) */
  canOpen(): boolean;
  /** 打开:main 置 run.paused = true 并 loop.halt() 冻结世界 */
  onOpen(): void;
  /** 关闭:main 置 run.paused = false 恢复战斗 */
  onClose(): void;
  /**
   * 别人正占着键盘吗(暂停菜单/设置页开着时,main 传对应的 visible())。
   * 与 pauseMenu 的 blocked 同一条理由:两个覆盖层的 keydown 挂在同一个 window 上,
   * 谁先收到取决于创建顺序 —— 让路必须是主动的。可选:不传 = 没有人抢。
   */
  blocked?(): boolean;
}

export interface ArmoryPanelUi {
  show(): void;
  hide(): void;
  visible(): boolean;
  setWorld(world: World | null): void;
  /** 单测用:当前选中的槽位(-1 = 没选) */
  selected(): number;
}

export function createArmoryPanel(hooks: ArmoryPanelHooks): ArmoryPanelUi {
  let visible = false;
  let world: World | null = null;
  /** 第一次点中的槽;-1 = 还没选。**关面板时复位** —— 留着的话下次打开会莫名其妙亮着一格 */
  let picked = -1;

  const root = document.createElement('div');
  root.style.cssText = ROOT_CSS;

  const card = document.createElement('div');
  card.style.cssText = CARD_CSS;

  const title = document.createElement('div');
  title.style.cssText = TITLE_CSS;
  title.textContent = '武器布局';

  const sub = document.createElement('div');
  sub.style.cssText = SUB_CSS;
  sub.textContent = '世界已暂停 · 点两个槽交换位置';

  const grid = document.createElement('div');
  grid.style.cssText = GRID_CSS;

  // 九个格子一次建齐(其中第 4 格是船形指针,不可点):节点只建一次,此后每次打开只改文本与描边
  const cells: HTMLElement[] = [];
  for (let c = 0; c < 9; c++) {
    if (c === 4) {
      const center = document.createElement('div');
      center.style.cssText = CENTER_CSS;
      center.innerHTML = '<div style="font-size:22px;">▲</div><div>船头</div>';
      cells.push(center);
      grid.appendChild(center);
      continue;
    }
    const btn = document.createElement('button');
    btn.style.cssText = CELL_CSS;
    cells.push(btn);
    grid.appendChild(btn);
  }
  // 槽位 → 按钮:建完格子再接线,于是"哪一格是哪个槽"只由 SLOT_CELL 一张表说了算
  for (let slot = 0; slot < WEAPON_SLOT_COUNT; slot++) {
    const cell = cells[SLOT_CELL[slot]!]!;
    cell.addEventListener('click', () => clickSlot(slot));
  }

  const hint = document.createElement('div');
  hint.style.cssText = HINT_CSS;
  hint.textContent = 'I / Esc 关闭 · 换位不消耗任何资源';

  card.append(title, sub, grid, hint);
  root.appendChild(card);
  document.getElementById('ui')!.appendChild(root);

  /** 一个槽的三行文本(空槽只有一行"空")。等级/DPS 现读 World —— 换完位当帧就重画 */
  function paintCell(slot: number): void {
    const cell = cells[SLOT_CELL[slot]!]!;
    const facing = SLOT_FACING_NAME[slot] ?? `槽${slot}`;
    const s: WeaponSlot | undefined = world?.weapons[slot];
    const def = s && s.type >= 0 ? TOWERS[s.type] : undefined;
    if (!s || !def) {
      cell.innerHTML =
        `<div style="${FACING_CSS}">${facing}</div>` +
        `<div style="${NAME_CSS}color:${IDLE_COLOR};">— 空 —</div>`;
    } else {
      // DPS 走 sim/tower 的 slotSustainedDps(与 HUD 火力面板同一份口径):
      // 面板上印一个自己算的数,玩家换完位一对照就会发现两处对不上
      const dps = world ? slotSustainedDps(s, def, world.buffs) : 0;
      cell.innerHTML =
        `<div style="${FACING_CSS}">${facing}</div>` +
        `<div style="${NAME_CSS}">${def.name} ★${s.stars} ${throttleName(def.throttle)}</div>` +
        `<div style="${META_CSS}">${Math.round(towerArcDeg(def, s.stars))}° · ` +
        `${Math.round(towerRange(def, s.stars))} · ${Math.round(dps)}/s</div>`;
    }
    // 选中态:暖色描边。暖色是敌人的色域(GDD §12),这里只用在**一格描边**上、
    // 且只在玩家自己点出来的那一瞬存在 —— 与过热锁死那条暖红同一档"小面积读数"的豁免
    const on = slot === picked;
    cell.style.borderColor = on ? SEL_COLOR : LINE_COLOR;
    cell.style.background = on ? 'rgba(255,212,121,.14)' : 'rgba(43,74,110,.22)';
  }

  function paint(): void {
    for (let i = 0; i < WEAPON_SLOT_COUNT; i++) paintCell(i);
    sub.textContent =
      picked >= 0
        ? `已选中「${SLOT_FACING_NAME[picked] ?? picked}」· 再点一个槽与它交换`
        : '世界已暂停 · 点两个槽交换位置';
  }

  function clickSlot(slot: number): void {
    if (!visible || !world) return;
    if (picked < 0) {
      picked = slot;
      audioBus.playPlace();
      paint();
      return;
    }
    if (picked === slot) {
      // 点自己 = 取消选中。给一条明确的退路,否则"选错了怎么办"只能靠关面板
      picked = -1;
      audioBus.playPlace();
      paint();
      return;
    }
    // 成败以 World.swapWeapons 的返回码为准(裁决在 sim);失败时只是不换,面板不撒谎
    if (world.swapWeapons(picked, slot) === 0) audioBus.playPlace();
    picked = -1;
    paint();
  }

  function show(): void {
    visible = true;
    picked = -1;
    root.style.display = 'flex';
    paint();
    hooks.onOpen();
  }

  /** 纯收起,不触发 onClose:main 换局时用它关面板,世界状态由 main 自己定 */
  function hide(): void {
    visible = false;
    picked = -1;
    root.style.display = 'none';
  }

  function close(): void {
    if (!visible) return;
    hide();
    hooks.onClose();
  }

  window.addEventListener('keydown', (e) => {
    if (e.repeat || isTyping()) return;
    // 让路:暂停菜单/设置页开着时,这一记按键归它们(理由见 hooks.blocked)
    if (hooks.blocked?.()) return;
    if (visible) {
      if (e.code === 'KeyI' || e.code === 'Escape') close();
      return;
    }
    if (e.code === 'KeyI' && hooks.canOpen()) show();
  });

  return {
    show,
    hide,
    visible: () => visible,
    setWorld: (w) => {
      world = w;
      picked = -1;
      if (visible) paint();
    },
    selected: () => picked,
  };
}

/** 面板上一条槽位的可读摘要(单测与调试面板共用;UI 之外不许再拼一份) */
export function slotSummary(world: World, slot: number): string {
  const s = world.weapons[slot];
  const facing = SLOT_FACING_NAME[slot] ?? `槽${slot}`;
  if (!s || s.type < 0) return `${facing} · 空`;
  const def = TOWERS[s.type];
  if (!def) return `${facing} · 未知塔型(${s.type})`;
  return `${facing} · ${def.name} ★${s.stars} · ${throttleName(def.throttle)}`;
}
