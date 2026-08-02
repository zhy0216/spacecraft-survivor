/**
 * 放置交互 —— 灰盒入口(03 号 issue T4)。
 * 存在的唯一理由:让"合法格高亮 / 非法放置被拒并说明理由"这条规则**能被真人在浏览器里点出来**,
 * 而不是只活在单测里。10 号 issue 的"三选一 → 时停 → 甲板放大 → 拖放"会把这一整套换掉
 * (键位、提示条、点击拾取全部作废),所以这里刻意不做任何会让人舍不得删的东西:
 * 不做时停(想暂停用既有调参面板)、不做拖影、不做撤销,只留一条"选类型 → 点格子 → 得到答复"的最短路径。
 *
 * 分层:ui 只碰 DOM 与事件,**永不 import pixi**(铁律 1 的另一半)——
 * 屏幕像素换世界坐标走渲染层给的 screenToWorld,镜头公式只在渲染层存一份;
 * 放置本身走 world.place,合法性判定一行都不在这里重写(重写就是第二份会走散的规则)。
 * 状态对象 PlacementUiState 的定义在渲染层并由本文件 import type 进来,依赖方向单向 ui → render:
 * 本文件每帧就地改它的字段,渲染层只读 —— 两边不必再约定"通知"通道,也不新增分配(铁律 3)。
 */
import { TOWER_AUTOCANNON, TOWER_KIND_COUNT, TOWER_MAX_LEVEL, TOWERS } from '../data/towers';
import {
  CELL_SUPPORT,
  CELL_WEAPON,
  cellIndexAtWorld,
  isPlaceSuccess,
  PLACE_BAD_CONTENT,
  PLACE_BAD_TOWER,
  PLACE_INTERIOR,
  PLACE_MAX_LEVEL,
  PLACE_NO_CELL,
  PLACE_TAKEN,
  PLACE_UPGRADE,
} from '../sim/deck';
import type { Vec2 } from '../sim/ship';
import type { World } from '../sim/world';
import type { PlacementUiState } from '../render/renderer';

/**
 * 提示文字配色:与渲染层的高亮同色(合法 = 冷青蓝、拒绝 = 暖红),
 * 于是"格上闪一下"与"下面这行字"读起来是同一件事,而不是两条互不相干的反馈。
 * 冷色是我方色域(GDD §12);暖色只许出现在这一行短命的文字上,不铺成色块。
 */
const OK_COLOR = '#9adcff';
const DENY_COLOR = '#ff7a6b';
const IDLE_COLOR = '#5f7a99';

/**
 * 提示条本体样式。**pointer-events:none 是必须的**:index.html 里 `#ui > *` 把覆盖层的
 * 直接子元素设成 auto(卡片要能点),提示条不摘掉就会吃掉左下角那片区域的点击 ——
 * 而那片区域底下正是甲板可能飘过去的地方。
 */
const BOX_CSS =
  'position:fixed;left:12px;bottom:12px;padding:8px 12px;border-radius:6px;' +
  'background:rgba(5,7,13,.72);border:1px solid #2b4a6e;' + // 边框取船体冷色废铁本色
  'font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre;' +
  'pointer-events:none;user-select:none;';
/** 闪现行常驻占位:文案清空时不塌高度,免得提示条每次拒绝都跳一下 */
const FLASH_CSS = `min-height:1.6em;color:${DENY_COLOR};`;

/** 拒绝提示的存留时长(ms)。同时也是渲染层那格红闪的时长:计时器只此一份,在 ui 这边 */
const FLASH_MS = 1000;

/** 世界坐标暂存:模块级复用(照 sim/world.ts 的 desired 写法),鼠标移动不该按帧新建对象 */
const worldPos: Vec2 = { x: 0, y: 0 };

export interface PlacementUiOpts {
  world: World;
  canvas: HTMLCanvasElement;
  /** 由渲染层提供(见 Renderer.screenToWorld):画布像素 → 世界坐标,结果写进 out */
  screenToWorld(sx: number, sy: number, out: Vec2): Vec2;
}

/**
 * 理由码 → 中文拒绝文案。规则少到不必做教学关(GDD §4.1),前提是**每次拒绝都当场把规则原文讲一遍**,
 * 所以文案里带上出处,而不是一句干巴巴的"不能放在这里"。
 * 独立成纯函数、不碰 DOM,于是能在 Node 里单测:漏一个码就会静默退化成兜底文案,肉眼很难发现。
 */
export function denyMessage(code: number): string {
  switch (code) {
    case PLACE_INTERIOR:
      return '内部格只能放支援设施(GDD §4.1)';
    case PLACE_TAKEN:
      return '格子已被占用 —— 战斗中不可移动、不可出售(GDD §4.5)';
    case PLACE_NO_CELL:
      return '这里不是甲板格';
    // 叠级到顶(05 号 issue):这一条与 TAKEN 是两回事 —— 那格明明是同一种塔,只是叠不动了。
    // 上限写成常量而不是字面量:数值表把 Lv 上限一改,这行提示自动跟上(改数据即可调平衡)
    case PLACE_MAX_LEVEL:
      return `已是 Lv${TOWER_MAX_LEVEL},叠不动了(GDD §5.4)`;
    // 本文件只会传数值表里存在的塔型,故正常点不出来;留着是为了将来加塔时不至于静默兜底
    case PLACE_BAD_TOWER:
      return '没有这种塔型(数值表里查不到)';
    // 本文件只会传武器塔/支援设施,故正常点不出来;留着是为了将来加内容类型时不至于静默兜底
    case PLACE_BAD_CONTENT:
      return '只能放武器塔或支援设施(MVP 没有拆除)';
    default:
      return `放置被拒绝(理由码 ${code})`;
  }
}

/**
 * 当前选的是什么 —— 武器塔一律报**塔名**(取自数值表,不在 ui 里抄第二份名字),
 * 支援设施只有一种(06 号 issue 才分型),故先笼统叫它一声。
 * 塔型越界报回原始下标而不是兜底成机炮:选错了要看得见,静默换成另一座塔才是真的坑。
 */
export function placeLabel(content: number, towerType: number): string {
  if (content !== CELL_WEAPON) return '支援设施';
  return TOWERS[towerType]?.name ?? `未知塔型(${towerType})`;
}

/**
 * 放置成功后的一句回执。**两种成功要分得开**(GDD §5.4:同名叠级不占新格):
 * 玩家往一座已有的机炮上再点一次时,画面上什么都不会多出来 —— 那一刻唯一能证明"点中了"的
 * 就是这行「升到 LvN」;少了它,叠级与"点了个没反应的格"在体感上一模一样。
 * 纯函数、不碰 DOM:理由与 denyMessage 同 —— 漏配文案只会静默退化,得让单测看得见。
 */
export function placedMessage(code: number, label: string, level: number): string {
  return code === PLACE_UPGRADE ? `${label} 升到 Lv${level}` : `已放置:${label}`;
}

/**
 * 键位提示行。六种塔的键位**从数值表现生成**:数值表里加一座塔、改个名字,这行自动跟上,
 * 不必回头改 ui(05 号验收口径:改数据文件即可,不改代码)。只在建面板时算一次,不进热循环。
 */
export function keyHintText(): string {
  let towers = '';
  for (let i = 0; i < TOWERS.length; i++) {
    towers += `${i > 0 ? ' · ' : ''}${i + 1} ${TOWERS[i]!.name}`;
  }
  return `B 开关 · Esc 退出 · 左键放置 · 0 支援设施\n${towers}`;
}

/** 焦点在调参面板的输入框里:此时数字键/B 是在打字,不该被当成键位抢走 */
function isTyping(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

/**
 * 接线放置交互,返回给渲染层用的状态对象(整局就这一个,调用方原样交给 renderer.setPlacement)。
 * 键位刻意避开 WASD(那是 core/input 的航向键,放置模式下船照常能开):
 *   B 切换放置模式 · **1..6 直选六种武器塔** · 0 支援设施 · Esc 退出 · 鼠标左键放置。
 * 05 号起数字键直接选塔型(而不是先选"武器塔"再另找地方选型号):六座塔是这一号 issue 的主角,
 * 中间再插一层菜单只会让灰盒验收变慢;真正的选塔流程是 10 号的三选一卡片,那时这套键位整个作废。
 */
export interface PlacementUi extends PlacementUiState {
  /**
   * 按最后已知的鼠标位置重算悬停格。调用方每渲染帧调一次 ——
   * 只在 mousemove 里算的话,船一动、光标不动,高亮框就跟着甲板飘走了:
   * 玩家看到的框和点下去落的格不是同一个,而塔一放就不可移动、不可出售(GDD §4.5)。
   */
  syncHover(): void;
}

export function createPlacementUi(opts: PlacementUiOpts): PlacementUi {
  const { world, canvas, screenToWorld } = opts;
  const state: PlacementUiState = {
    active: false,
    content: CELL_WEAPON,
    // 起手就是机炮:GDD §5.2 的"基础输出、万金油",也是 world.place 的默认塔型 ——
    // 两处默认值取同一座塔,漏传参数时的行为才与看得见的提示条一致
    towerType: TOWER_AUTOCANNON,
    hoverIndex: -1,
    denyIndex: -1,
  };

  // —— 提示条:append 进 #ui 覆盖层,行内 style(不改 index.html;10 号会把它整个删掉) ——
  const box = document.createElement('div');
  box.style.cssText = BOX_CSS;
  const statusEl = document.createElement('div');
  const keysEl = document.createElement('div');
  keysEl.style.color = IDLE_COLOR;
  // 键位常驻:灰盒入口没有任何别的地方写着"按 B",藏进 README 等于没有
  keysEl.textContent = keyHintText();
  const flashEl = document.createElement('div');
  flashEl.style.cssText = FLASH_CSS;
  box.append(statusEl, keysEl, flashEl);
  document.getElementById('ui')!.appendChild(box);

  let flashTimer = 0;
  // 最后已知的鼠标位置:开启放置模式时立刻算一次悬停,不必等玩家先动一下鼠标
  let lastX = 0;
  let lastY = 0;

  function refresh(): void {
    statusEl.style.color = state.active ? OK_COLOR : IDLE_COLOR;
    statusEl.textContent = state.active
      ? `放置模式:开 · 当前 ${placeLabel(state.content, state.towerType)}`
      : '放置模式:关';
  }

  /** 闪一句话。连点时重置计时:上一次的超时不该把这一次的提示提前抹掉 */
  function flash(text: string, color: string): void {
    flashEl.textContent = text;
    flashEl.style.color = color;
    if (flashTimer) window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => {
      flashTimer = 0;
      flashEl.textContent = '';
      // 渲染层不持有计时器,那格红闪存留多久由这里说了算(见 PlacementUiState.denyIndex)
      state.denyIndex = -1;
    }, FLASH_MS);
  }

  /**
   * 屏幕坐标 → 甲板格下标(不在甲板上 -1)。
   * clientX/Y 减去画布左上角即得画布像素:resolution=1 + resizeTo=window,CSS 尺寸与像素尺寸 1:1。
   * rect 每次现取而不缓存 —— 窗口缩放/滚动都会让它过期,而这里是每帧几次的调用,不是热循环。
   * 拾取用 **sim 当前位姿**而非渲染插值位姿:最多差一逻辑帧(< 17ms),灰盒完全可接受,
   * 换来的是 ui 层不必再复制一份插值公式(10 号的时停放置流里船根本不动,这点差异会自动消失)。
   */
  function pick(clientX: number, clientY: number): number {
    const rect = canvas.getBoundingClientRect();
    const w = screenToWorld(clientX - rect.left, clientY - rect.top, worldPos);
    const ship = world.ship;
    return cellIndexAtWorld(world.deck, ship.x, ship.y, ship.heading, w.x, w.y);
  }

  function setActive(on: boolean): void {
    state.active = on;
    state.denyIndex = -1;
    state.hoverIndex = on ? pick(lastX, lastY) : -1;
    // 一并抹掉上一条拒绝文案:否则"放置模式:关"底下还挂着一行红字,要等计时器到点才消
    if (flashTimer) window.clearTimeout(flashTimer);
    flashTimer = 0;
    flashEl.textContent = '';
    refresh();
  }

  function tryPlace(clientX: number, clientY: number): void {
    const i = pick(clientX, clientY);
    const cell = i >= 0 ? world.deck.cells[i] : undefined;
    if (!cell) {
      // 拾取这一步已经答出"这里不是甲板格",不必再编一对 col/row 去 sim 兜一圈。
      // denyIndex 保持 -1:没有格子可闪,反馈只剩这行文案
      state.denyIndex = -1;
      flash(denyMessage(PLACE_NO_CELL), DENY_COLOR);
      return;
    }
    // 合法性一律以 sim 的答复为准:ui 这边绝不预判(预判就是第二份会走散的规则)
    const code = world.place(cell.col, cell.row, state.content, state.towerType);
    // 成功有两种(新放 PLACE_OK / 叠级 PLACE_UPGRADE),故判定走 isPlaceSuccess 而不是 === PLACE_OK:
    // 把码逐个列在 ui 这边,迟早会漏掉后加的那一个,然后一次成功的升级会被当成拒绝闪红
    if (isPlaceSuccess(code)) {
      state.denyIndex = -1;
      // 等级现读那一格(placeAt 已经写完):ui 不自己推"应该升到几级",省得与 sim 的夹取规则走散
      flash(placedMessage(code, placeLabel(state.content, state.towerType), cell.level), OK_COLOR);
      return;
    }
    state.denyIndex = i;
    flash(denyMessage(code), DENY_COLOR);
  }

  /**
   * 选内容/塔型。选了就直接进放置模式:灰盒入口下"选了却没开"只会让人以为键位没生效。
   * 支援设施不动 towerType(它对支援设施无意义),于是按 0 看一眼再按回武器塔时,选的还是原来那座。
   */
  function select(content: number, towerType: number): void {
    state.content = content;
    state.towerType = towerType;
    if (state.active) refresh();
    else setActive(true);
  }

  window.addEventListener('keydown', (e) => {
    // e.repeat:按住 B 不放会连续 toggle,看上去就是"开关坏了"
    if (e.repeat || isTyping()) return;
    if (e.code === 'KeyB') {
      setActive(!state.active);
      return;
    }
    if (e.code === 'Escape') {
      if (state.active) setActive(false);
      return;
    }
    // 数字键选内容:**0 = 支援设施,1..6 = 六种武器塔**(键 - 1 = TOWER_*,与数值表的顺序一致)。
    // 按位数解析而不是逐个列 case:数值表里加一座塔就自动多一个键位,这里一个字都不用改
    // (数字键只到 9,塔多过 9 座就该上 10 号的三选一卡片了,而不是继续加键位)。
    // 只认主键盘的 DigitN:小键盘的 NumpadN 在放置这种低频操作上不值得再养一条分支
    if (!e.code.startsWith('Digit')) return;
    const n = Number(e.code.slice(5));
    if (!Number.isInteger(n)) return;
    if (n === 0) select(CELL_SUPPORT, state.towerType);
    else if (n <= TOWER_KIND_COUNT) select(CELL_WEAPON, n - 1);
  });

  // 移动听 window:指针挪到调参面板上时悬停格不该冻在原地(世界还在那底下)。
  // 点击只听 canvas —— 点面板、点提示条不该往甲板上放东西
  window.addEventListener('mousemove', (e) => {
    lastX = e.clientX;
    lastY = e.clientY;
    if (state.active) state.hoverIndex = pick(lastX, lastY);
  });

  canvas.addEventListener('click', (e) => {
    if (!state.active) return;
    lastX = e.clientX;
    lastY = e.clientY;
    tryPlace(e.clientX, e.clientY);
  });

  refresh();
  return Object.assign(state, {
    syncHover(): void {
      if (state.active) state.hoverIndex = pick(lastX, lastY);
    },
  });
}
