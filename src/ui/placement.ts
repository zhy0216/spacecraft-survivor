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
import { SUP_AMMO_BAY, SUPPORT_KIND_COUNT, SUPPORTS } from '../data/supports';
import { TOWER_AUTOCANNON, TOWER_KIND_COUNT, TOWER_MAX_LEVEL, TOWERS } from '../data/towers';
import {
  CELL_SUPPORT,
  CELL_WEAPON,
  cellIndexAtWorld,
  isPlaceSuccess,
  PLACE_BAD_CONTENT,
  PLACE_BAD_SUPPORT,
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
    // 同上,设施型那一半(06 号):0 键的轮换永远落在 SUPPORTS 的下标内,故正常也点不出来。
    // 与 BAD_TOWER 分成两句话而不是合并成"型号不对":型号填错的是塔还是设施,得一眼看得出
    case PLACE_BAD_SUPPORT:
      return '没有这种支援设施(数值表里查不到)';
    // 本文件只会传武器塔/支援设施,故正常点不出来;留着是为了将来加内容类型时不至于静默兜底
    case PLACE_BAD_CONTENT:
      return '只能放武器塔或支援设施(MVP 没有拆除)';
    default:
      return `放置被拒绝(理由码 ${code})`;
  }
}

/**
 * 当前选的是什么 —— 武器塔报**塔名**、支援设施报**设施名**,两份名字都取自数值表,
 * ui 里不抄第二份(06 号起设施分四型,抄一份就等于埋一处会和数据表走散的文案)。
 * 型号越界一律报回原始下标而不是兜底成第 0 种:选错了要看得见,静默换成另一座塔/另一种设施才是真的坑。
 * 第三参缺省 = 弹药库,与 world.place / placeAt 的默认值同一个值(「弹药库先行」,GDD §4.3):
 * 漏传参数时的行为才与看得见的提示条一致 —— 两处默认值分家的话,提示条说的和真放下去的会是两种设施。
 */
export function placeLabel(content: number, towerType: number, supportType: number = SUP_AMMO_BAY): string {
  if (content !== CELL_WEAPON) return SUPPORTS[supportType]?.name ?? `未知设施(${supportType})`;
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
 * 按一次 0 键之后该选哪种支援设施(入参 = 按下之前的选择)。
 * 已经在支援模式里 → 轮换到下一种;不在(刚才选的是武器塔)→ 落回第 0 种 = 弹药库先行(GDD §4.3),
 * 与 world.place / placeAt 的默认设施型同一个值:进支援模式第一眼看到的,就是漏传参数时会放下去的那种。
 * 取模现读 SUPPORT_KIND_COUNT,数值表里加第五种设施时这里一个字都不用改。
 * 独立成纯函数、不碰 state 与 DOM,理由与 denyMessage 同:轮换是**环形**规则,
 * 少一次取模要在浏览器里连按四下才看得出来,而这道拦网在 Node 里就能拦住。
 */
export function nextSupportType(content: number, supportType: number): number {
  if (content !== CELL_SUPPORT) return SUP_AMMO_BAY;
  return (supportType + 1) % SUPPORT_KIND_COUNT;
}

/**
 * 键位提示行。塔与设施的名字**全部从数值表现生成**:表里加一座塔/一种设施、改个名字,这行自动跟上,
 * 不必回头改 ui(05 号验收口径:改数据文件即可,不改代码)。只在建面板时算一次,不进热循环。
 * 设施单独占一行而不是挤在第一行末尾:四种设施一个键轮换,得把"按 0 会在这四种之间转"讲明白 ——
 * 键位表里只写"0 支援设施"的话,玩家永远不会知道另外三种存在。
 */
export function keyHintText(): string {
  let towers = '';
  for (let i = 0; i < TOWERS.length; i++) {
    towers += `${i > 0 ? ' · ' : ''}${i + 1} ${TOWERS[i]!.name}`;
  }
  let supports = '';
  for (let i = 0; i < SUPPORTS.length; i++) {
    supports += `${i > 0 ? ' · ' : ''}${SUPPORTS[i]!.name}`;
  }
  return `B 开关 · Esc 退出 · 左键放置\n${towers}\n0 支援设施(再按 0 轮换):${supports}`;
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
 *   B 切换放置模式 · **1..6 直选六种武器塔** · **0 进支援模式并轮换四种设施** · Esc 退出 · 鼠标左键放置。
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
  /**
   * 换掉整局的 World(08 号 issue T3 的重开流程:一局从开始到胜负/重开全程不刷新页面)。
   * 重开 = 换一个新 World(池、rng、tick、甲板全是新的,才谈得上"同 seed 可复现"),
   * 于是这条交互也必须跟着改指向 —— 忘了换,玩家在新船上点下去的每一格都会落进上一局那艘沉船里,
   * 而画面上什么都不会发生(渲染层读的是新 World 的甲板):那是最难查的一类"点了没反应"。
   */
  setWorld(world: World): void;
}

export function createPlacementUi(opts: PlacementUiOpts): PlacementUi {
  // world 是**可重赋的局部变量**而不是解构常量:重开一局要换掉整个 World(见 setWorld),
  // 而闭包里每处(pick / tryPlace)都是现读它 —— 于是换引用这一件事就够了,
  // window 事件与提示条 DOM 一行都不必重挂(重挂 = 每重开一局多一份监听器、多一条提示条)。
  let world = opts.world;
  const { canvas, screenToWorld } = opts;
  const state: PlacementUiState = {
    active: false,
    content: CELL_WEAPON,
    // 起手就是机炮:GDD §5.2 的"基础输出、万金油",也是 world.place 的默认塔型 ——
    // 两处默认值取同一座塔,漏传参数时的行为才与看得见的提示条一致
    towerType: TOWER_AUTOCANNON,
    // 起手就是弹药库:06 号的"弹药库先行"(GDD §4.3),同样与 world.place 的默认设施型取同一个值
    supportType: SUP_AMMO_BAY,
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
      ? `放置模式:开 · 当前 ${placeLabel(state.content, state.towerType, state.supportType)}`
      : '放置模式:关';
  }

  /**
   * 抹掉闪现行并停掉它的计时器。退出放置模式(setActive)与重开一局(setWorld)共用:
   * 留着的话,那行红字要等超时才消 —— 而它说的是**上一次**(甚至上一局)的事,
   * 挂在新的语境下就成了一条对不上号的提示。
   */
  function clearFlash(): void {
    if (flashTimer) window.clearTimeout(flashTimer);
    flashTimer = 0;
    flashEl.textContent = '';
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
    clearFlash();
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
    // 合法性一律以 sim 的答复为准:ui 这边绝不预判(预判就是第二份会走散的规则)。
    // 塔型与设施型一起递过去:两者各只在自己那种 content 下有意义,由 sim 挑,ui 不在这里分岔
    const code = world.place(cell.col, cell.row, state.content, state.towerType, state.supportType);
    // 成功有两种(新放 PLACE_OK / 叠级 PLACE_UPGRADE),故判定走 isPlaceSuccess 而不是 === PLACE_OK:
    // 把码逐个列在 ui 这边,迟早会漏掉后加的那一个,然后一次成功的升级会被当成拒绝闪红
    if (isPlaceSuccess(code)) {
      state.denyIndex = -1;
      // 等级现读那一格(placeAt 已经写完):ui 不自己推"应该升到几级",省得与 sim 的夹取规则走散
      flash(
        placedMessage(code, placeLabel(state.content, state.towerType, state.supportType), cell.level),
        OK_COLOR,
      );
      return;
    }
    state.denyIndex = i;
    flash(denyMessage(code), DENY_COLOR);
  }

  /**
   * 选内容/塔型/设施型。选了就直接进放置模式:灰盒入口下"选了却没开"只会让人以为键位没生效。
   * 两个型号一律整份传进来(而不是只改跟 content 对得上的那一个):"另一个保持原样"还是"重置"
   * 由调用点自己写明,于是"按 0 看一眼再按回武器塔时,选的还是原来那座"这条约定看得见,
   * 而不是藏在这里的一句条件里。
   */
  function select(content: number, towerType: number, supportType: number): void {
    state.content = content;
    state.towerType = towerType;
    state.supportType = supportType;
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
    // 数字键选内容:**0 = 支援设施(再按一次换下一种),1..6 = 六种武器塔**
    // (键 - 1 = TOWER_*,与数值表的顺序一致)。
    // 按位数解析而不是逐个列 case:数值表里加一座塔就自动多一个键位,这里一个字都不用改
    // (数字键只到 9,塔多过 9 座就该上 10 号的三选一卡片了,而不是继续加键位)。
    // 只认主键盘的 DigitN:小键盘的 NumpadN 在放置这种低频操作上不值得再养一条分支
    if (!e.code.startsWith('Digit')) return;
    const n = Number(e.code.slice(5));
    if (!Number.isInteger(n)) return;
    // **一个 0 键管四种设施**(进支援模式 + 轮换,规则见 nextSupportType):不给四种各分一个键 ——
    // 1..6 已被六座塔占满,往上排只剩 7/8/9 三个位,数值表加第五种设施时键位当场就断。
    // 选武器塔则不动 supportType:按 0 看一眼再按回武器塔,选的还是原来那座塔(与 05 号的口径一致)
    if (n === 0) select(CELL_SUPPORT, state.towerType, nextSupportType(state.content, state.supportType));
    else if (n <= TOWER_KIND_COUNT) select(CELL_WEAPON, n - 1, state.supportType);
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
    setWorld(next: World): void {
      world = next;
      // 两个下标都是**上一艘船**上的位置,与新甲板毫无关系:不复位的话,重开后的第一帧
      // 会照着旧下标去描一个高亮框/一格红闪 —— 渲染层那两处判空只挡得住越界,
      // 挡不住"下标碰巧还落在范围内"。hoverIndex 不必在这里现算:调用方每渲染帧都调 syncHover,
      // 下一帧它自己就按真实光标位置补上了。
      state.hoverIndex = -1;
      state.denyIndex = -1;
      // 上一局最后那条拒绝文案(连同它的超时)一并抹掉:新船开出去的第一眼不该挂着上一局的红字
      clearFlash();
      // **放置模式的开关状态原样保留**:开着还是关着是玩家自己的选择,重开一局不该顺手替他改;
      // 提示条的文案也只跟这个开关走(见 refresh),故这里没什么可刷的
    },
  });
}
