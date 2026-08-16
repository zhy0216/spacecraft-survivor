/**
 * 移动端驾驶层：底部固定摇杆 + 加速键 + 背包键。
 *
 * UI 只把手势翻译成 Input 的虚拟航向/虚拟 Space，sim 仍然只消费 ShipCommand，
 * 因此键盘和触控共用同一条确定性输入管线。节点整页只创建一次；暂停、商店、
 * 升级时只收起并释放输入，绝不重挂 pointer 监听器。
 *
 * 背包键不是驾驶输入：它只是按 I 打开舰船背包的触控入口，动作由 main 通过
 * setArmoryAction 注入（mobileControls 建得比 armoryPanel 早，故走注入而非构造参数）。
 */
import type { Input } from '../core/input';
import { t } from '../i18n';

const DEAD_ZONE_RATIO = 0.12;
const KNOB_TRAVEL_RATIO = 0.3;

export interface MobileControlsUi {
  /** runVisible 决定是否为战场预留底带；enabled 决定控件是否显示并接受手势。 */
  sync(runVisible: boolean, enabled: boolean): void;
  /** false = 左航向右加速；true = 左加速右航向。 */
  setSwapped(swapped: boolean): void;
  /** 背包键点下时回调（main 接 armoryPanel.toggle，与按 I 同一条路径）。 */
  setArmoryAction(action: () => void): void;
  refreshLocale(): void;
}

export function createMobileControls(input: Input): MobileControlsUi {
  const root = document.createElement('div');
  root.id = 'mobile-controls';
  root.className = 'sw-mobile-controls';
  root.setAttribute('aria-hidden', 'true');

  const steer = document.createElement('div');
  steer.className = 'sw-mobile-steer';
  steer.setAttribute('role', 'group');

  const steerLabel = document.createElement('div');
  steerLabel.className = 'sw-mobile-control-label';

  const pad = document.createElement('div');
  pad.className = 'sw-mobile-stick-pad';
  const guides = document.createElement('div');
  guides.className = 'sw-mobile-stick-guides';
  const knob = document.createElement('div');
  knob.className = 'sw-mobile-stick-knob';
  pad.append(guides, knob);
  steer.append(steerLabel, pad);

  const boostWrap = document.createElement('div');
  boostWrap.className = 'sw-mobile-boost-wrap';
  const boostLabel = document.createElement('div');
  boostLabel.className = 'sw-mobile-control-label';
  const boost = document.createElement('button');
  boost.type = 'button';
  boost.className = 'sw-mobile-boost';
  boost.setAttribute('aria-label', t('ui:keys.space'));
  const boostCore = document.createElement('span');
  boostCore.className = 'sw-mobile-boost-core';
  boostCore.textContent = '»';
  boost.appendChild(boostCore);
  boostWrap.append(boostLabel, boost);

  const armoryWrap = document.createElement('div');
  armoryWrap.className = 'sw-mobile-armory-wrap';
  const armoryLabel = document.createElement('div');
  armoryLabel.className = 'sw-mobile-control-label';
  const armory = document.createElement('button');
  armory.type = 'button';
  armory.className = 'sw-mobile-armory';
  armory.setAttribute('aria-label', t('ui:keys.layout'));
  const armoryIcon = document.createElement('span');
  armoryIcon.className = 'sw-mobile-armory-icon';
  armory.appendChild(armoryIcon);
  armoryWrap.append(armoryLabel, armory);

  root.append(steer, armoryWrap, boostWrap);
  document.getElementById('ui')!.appendChild(root);

  let steerPointer = -1;
  let boostPointer = -1;
  let lastRunVisible = false;
  let lastEnabled = false;
  let armoryAction: (() => void) | null = null;

  function resetStick(): void {
    steerPointer = -1;
    input.clearVirtualHeading();
    knob.style.transform = 'translate3d(0,0,0)';
    pad.classList.remove('is-active');
  }

  function resetBoost(): void {
    boostPointer = -1;
    input.setVirtualKey('Space', false);
    boost.classList.remove('is-active');
  }

  function updateStick(clientX: number, clientY: number): void {
    const rect = pad.getBoundingClientRect();
    const cx = rect.left + rect.width * 0.5;
    const cy = rect.top + rect.height * 0.5;
    const dx = clientX - cx;
    const dy = clientY - cy;
    const distance = Math.hypot(dx, dy);
    const travel = Math.max(1, Math.min(rect.width, rect.height) * KNOB_TRAVEL_RATIO);
    const visualScale = distance > travel ? travel / distance : 1;
    const visualX = dx * visualScale;
    const visualY = dy * visualScale;
    knob.style.transform = `translate3d(${visualX}px,${visualY}px,0)`;

    if (distance <= travel * DEAD_ZONE_RATIO) input.clearVirtualHeading();
    else input.setVirtualHeading(dx, dy);
  }

  pad.addEventListener('pointerdown', (event) => {
    if (!lastEnabled || steerPointer >= 0) return;
    event.preventDefault();
    steerPointer = event.pointerId;
    pad.setPointerCapture?.(event.pointerId);
    pad.classList.add('is-active');
    updateStick(event.clientX, event.clientY);
  });
  pad.addEventListener('pointermove', (event) => {
    if (event.pointerId !== steerPointer) return;
    event.preventDefault();
    updateStick(event.clientX, event.clientY);
  });
  const releaseStick = (event: PointerEvent): void => {
    if (event.pointerId !== steerPointer) return;
    event.preventDefault();
    resetStick();
  };
  pad.addEventListener('pointerup', releaseStick);
  pad.addEventListener('pointercancel', releaseStick);
  pad.addEventListener('lostpointercapture', releaseStick);

  boost.addEventListener('pointerdown', (event) => {
    if (!lastEnabled || boostPointer >= 0) return;
    event.preventDefault();
    boostPointer = event.pointerId;
    boost.setPointerCapture?.(event.pointerId);
    input.setVirtualKey('Space', true);
    boost.classList.add('is-active');
  });
  const releaseBoost = (event: PointerEvent): void => {
    if (event.pointerId !== boostPointer) return;
    event.preventDefault();
    resetBoost();
  };
  boost.addEventListener('pointerup', releaseBoost);
  boost.addEventListener('pointercancel', releaseBoost);
  boost.addEventListener('lostpointercapture', releaseBoost);

  // 背包键只在控件可见（runActive 且未暂停）时响应；动作留给 main 注入，本层不认面板。
  armory.addEventListener('click', () => {
    if (lastEnabled) armoryAction?.();
  });

  // 长按不弹系统菜单；这块区域只负责驾驶。
  root.addEventListener('contextmenu', (event) => event.preventDefault());

  function refreshLocale(): void {
    steerLabel.textContent = t('ui:keys.wasd');
    boostLabel.textContent = t('ui:keys.space');
    boost.setAttribute('aria-label', t('ui:keys.space'));
    armoryLabel.textContent = t('ui:keys.layout');
    armory.setAttribute('aria-label', t('ui:keys.layout'));
  }

  function requestGameResize(): void {
    // Renderer resizeTo 指向 #game；切换底带后补一记 resize，让 Pixi 读取新的容器高度。
    window.requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }

  refreshLocale();

  return {
    sync(runVisible: boolean, enabled: boolean): void {
      if (runVisible !== lastRunVisible) {
        lastRunVisible = runVisible;
        document.documentElement.classList.toggle('sw-mobile-run', runVisible);
        requestGameResize();
      }
      const controlsVisible = runVisible && enabled;
      root.classList.toggle('sw-mobile-controls-visible', controlsVisible);
      root.setAttribute('aria-hidden', controlsVisible ? 'false' : 'true');
      if (!controlsVisible && lastEnabled) {
        resetStick();
        resetBoost();
      }
      lastEnabled = controlsVisible;
    },
    setSwapped(swapped: boolean): void {
      root.classList.toggle('sw-mobile-controls-swapped', swapped);
    },
    setArmoryAction(action: () => void): void {
      armoryAction = action;
    },
    refreshLocale,
  };
}
