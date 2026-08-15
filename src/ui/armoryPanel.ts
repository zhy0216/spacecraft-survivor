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
import { TOWERS } from '../data/towers';
import { isTyping } from '../core/isTyping';
import { t } from '../i18n';
import { audioBus } from '../render/audio';
import type { World } from '../sim/world';
import { createShipDiagram, slotFacingName, type ShipDiagramUi } from './shipDiagram';
import { throttleFamilyName, weaponDisplayName } from './presentation/contentText';

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
  /**
   * 语言切换后原地重画(05 号):标题/副题/槽位朝向/法令区/提示走当前语言。
   * 只重画文案,不改变 picked/visible 状态、不重注册监听 —— 由 shipDiagram.refreshLocale
   * 用上一次的 paint 入参重画(背包与商店共用同一张图,谁也不各存一份翻译状态)。
   */
  refreshLocale(): void;
}

export function createArmoryPanel(hooks: ArmoryPanelHooks): ArmoryPanelUi {
  let visible = false;
  let world: World | null = null;
  let picked = -1;

  const root = document.createElement('div');
  root.style.cssText = ROOT_CSS;
  // 标题/副题不再由这里写死:shipDiagram 自己取 ui:armory.title / ui:armory.eyebrow 的翻译,
  // 背包与商店(07)共用同一份默认 —— 各传一遍只会长出两套翻译状态
  const shipDiagram: ShipDiagramUi = createShipDiagram({
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
    // 语言切换后重画文案:交给 shipDiagram(它用上次 paint 的入参重画,保留 picked 选择态)
    refreshLocale: () => shipDiagram.refreshLocale(),
  };
}

/** 面板上一条槽位的可读摘要(单测与调试面板共用;不另拼一份朝向表) */
export function slotSummary(world: World, slot: number): string {
  const s = world.weapons[slot];
  const facing = slotFacingName(slot);
  if (!s || s.type < 0) return `${facing} · ${t('ui:slot.empty')}`;
  const def = TOWERS[s.type];
  if (!def) return `${facing} · ${t('ui:slot.unknownTower', { type: s.type })}`;
  return `${facing} · ${weaponDisplayName(s.type)} ${'★'.repeat(s.stars)} · ${throttleFamilyName(def.throttle)}`;
}
