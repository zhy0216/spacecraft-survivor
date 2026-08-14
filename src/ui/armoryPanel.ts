/**
 * 舰船背包(按 I) —— 与商店中央区共用 ui/shipDiagram 的完整飞船。
 *
 * 背包不再维护一套简化九宫格：八个武器槽、真实朝向、射界扇形、船体、HP、
 * 持续火力与已生效法令都由同一张舰船图绘制。商店里看到的槽位与按 I 打开的
 * 背包因此不会再有布局或文案分叉。
 *
 * 操作仍只有一件事：点第一个槽选中，再点一个槽与它交换；点同一槽取消。
 * 换位裁决仍在 World.swapWeapons，面板只负责时停与表现。
 */
import { throttleName, TOWERS } from '../data/towers';
import { isTyping } from '../core/isTyping';
import { audioBus } from '../render/audio';
import type { World } from '../sim/world';
import { createShipDiagram, SLOT_FACING_NAME, type ShipDiagramUi } from './shipDiagram';

const ROOT_CSS =
  'position:fixed;inset:0;z-index:20;display:none;align-items:center;justify-content:center;' +
  'padding:20px;box-sizing:border-box;overflow:auto;background:rgba(5,7,13,.86);' +
  'font:13px/1.58 ui-monospace,SFMono-Regular,Menlo,monospace;user-select:none;';

export interface ArmoryPanelHooks {
  /** 能不能开面板?(main 传 `() => !run.paused` —— 时停/结算时 I 键不响应) */
  canOpen(): boolean;
  /** 打开:main 置 run.paused = true 并 loop.halt() 冻结世界 */
  onOpen(): void;
  /** 关闭:main 置 run.paused = false 恢复战斗 */
  onClose(): void;
  /** 暂停菜单/设置页等覆盖层正在占用键盘时主动让路 */
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
  let picked = -1;

  const root = document.createElement('div');
  root.style.cssText = ROOT_CSS;
  const shipDiagram: ShipDiagramUi = createShipDiagram({
    title: '舰船背包',
    eyebrow: 'SHIP INVENTORY',
    onSlotClick: clickSlot,
  });
  root.appendChild(shipDiagram.root);
  document.getElementById('ui')!.appendChild(root);

  function paint(): void {
    shipDiagram.paint(world, {
      mode: 'swap',
      incoming: null,
      target: -1,
      selected: picked,
    });
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
      picked = -1;
      audioBus.playPlace();
      paint();
      return;
    }
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

  /** 纯收起,不触发 onClose:main 换局时用它关面板 */
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
    setWorld: (next) => {
      world = next;
      picked = -1;
      if (visible) paint();
    },
    selected: () => picked,
  };
}

/** 面板上一条槽位的可读摘要(单测与调试面板共用;不另拼一份朝向表) */
export function slotSummary(world: World, slot: number): string {
  const s = world.weapons[slot];
  const facing = SLOT_FACING_NAME[slot] ?? `槽${slot}`;
  if (!s || s.type < 0) return `${facing} · 空`;
  const def = TOWERS[s.type];
  if (!def) return `${facing} · 未知塔型(${s.type})`;
  return `${facing} · ${def.name} ${'★'.repeat(s.stars)} · ${throttleName(def.throttle)}`;
}
