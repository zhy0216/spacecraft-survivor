/**
 * 舰船一览 —— 纯 DOM 覆盖层,永不 import pixi(铁律 1 的另一半)。
 *
 * 商店搬到地图信标之后,"买东西"发生在一个**看不见自己船**的时停面板里:玩家面对货架时
 * 得凭记忆回答三个问题 —— 我现在装了什么、整圈哪个方向没火力、这把买回来会装到哪。
 * 本模块把船画出来,让这三问都变成一眼的事:
 *   八个武器槽按**真实朝向**围成一圈(sim/armory 的 WEAPON_SLOT_FACING,槽 0 = 正前 = 正上,
 *   顺时针一圈),每个已装武器在自己那一格内侧画一枚**射界扇形**(角宽 = towerArcDeg、
 *   半径按 towerRange 归一),于是"整圈哪里是缺口"不用逐格读数字。
 *
 * 扇形方向用 CSS 的 conic-gradient 画:它的 0deg 恰好是正上、正角度恰好顺时针 ——
 * 与 WEAPON_SLOT_FACING 的口径**逐字对齐**(0 = 船头、顺时针为正),故槽位朝向可以直接
 * 当角度用,中间不做任何翻转;这也是整个面板"画的就是船上那门炮"的可信度来源。
 *
 * 本模块**只读 World**(weapons / edictLevels / buffs / ship.hp),一个字段都不写:
 * 换装的裁决在 sim(World.buyShopWeapon),点槽这件事只以回调形式交给调用方,
 * 于是同一张图既能在商店里当"选一个槽替换"的选择器,也能在别处当只读的舰况面板。
 *
 * 悬停态(hoverSlot)归本模块自己管:调用方给的是"要虚装的那把武器"(incoming)与
 * "只读还是等选槽"(mode),鼠标停在哪一格是纯表现,交出去只会让两边的状态各存一份。
 */
import {
  TOWERS,
  TOWER_ARC,
  TOWER_AUTOCANNON,
  TOWER_LASER,
  TOWER_MISSILE_NEST,
  TOWER_MORTAR,
  TOWER_PD,
  TOWER_RAILGUN,
  towerArcDeg,
  towerRange,
} from '../data/towers';
import { EDICTS } from '../data/edicts';
import { SHIP_HULL_ART_URL, TOWER_STAR_ART_URLS } from '../render/artUrls';
import { t } from '../i18n';
import {
  WEAPON_HARDPOINTS,
  WEAPON_SLOT_COUNT,
  WEAPON_SLOT_FACING,
  type WeaponSlot,
} from '../sim/armory';
import { tuning } from '../sim/config';
import { slotSustainedDps } from '../sim/tower';
import type { World } from '../sim/world';
import { starLine } from './codex';
import { edictName, throttleFamilyName, weaponDisplayName } from './presentation/contentText';
import { edictScopeLabel } from './presentation/edictText';

const OK_COLOR = '#9adcff';
const TEXT_COLOR = '#c8dcf0';
const MUTED_COLOR = '#6f89a5';
const LINE_COLOR = '#2b4a6e';
/** 选中/预览的暖色。暖色是敌人的色域(GDD §12),只许用在**玩家自己点出来的那一小块**上 */
const SEL_COLOR = '#ffd479';

/**
 * 槽位编号 → 朝向名(05 号迁进 i18n)。与 sim/armory 的 WEAPON_SLOT_FACING 一一对应,
 * **改了那张表就得改这张**(错位 = 面板上写着"正前"的那门炮其实朝后,
 * 而这种错要等玩家在战斗里被侧面咬死才发现)。ui/armoryPanel 与 refitFlow 都从这里取,
 * 不许各存一份翻译状态。朝向的文案 key 在 ui:facing.*,越界退回「槽 N」。
 */
type FacingKey = 'front' | 'frontRight' | 'right' | 'backRight' | 'back' | 'backLeft' | 'left' | 'frontLeft';
const FACING_SLOTS: Record<number, FacingKey> = {
  0: 'front',
  1: 'frontRight',
  2: 'right',
  3: 'backRight',
  4: 'back',
  5: 'backLeft',
  6: 'left',
  7: 'frontLeft',
};
export function slotFacingName(slot: number): string {
  const key = FACING_SLOTS[slot];
  if (key === undefined) return t('ui:slot.slotN', { slot });
  return t(`ui:facing.${key}`);
}

/**
 * 武器的几何图标,与 upgradeFlow 的 cardIcon 同一套"无外部资产"口径
 * (未知型号显式报 ?,不静默冒充第 0 型)。商店与舰船图都按 TOWER_* 下标分派。
 */
export function towerGlyph(type: number): string {
  switch (type) {
    case TOWER_AUTOCANNON:
      return '▰';
    case TOWER_LASER:
      return '◇';
    case TOWER_ARC:
      return 'ϟ';
    case TOWER_RAILGUN:
      return '➠';
    case TOWER_PD:
      return '✣';
    case TOWER_MORTAR:
      return '◉';
    case TOWER_MISSILE_NEST:
      return '♁';
    default:
      return '?';
  }
}

/** 塔的渲染色(数值表 0xRRGGBB 整数)→ CSS 颜色;型越界退回弱化色 */
export function towerTintCss(type: number): string {
  const tint = TOWERS[type]?.tint;
  return tint === undefined ? MUTED_COLOR : `#${tint.toString(16).padStart(6, '0')}`;
}

// —— 环形布局的几何(px)。四个数互相咬合,改一个就要重算另外三个 ——
/** 画布边长:八格 + 扇形 + 船体全塞进这个正方形,外面再由 flex 居中 */
const RING_PX = 460;
const RING_C = RING_PX / 2;
/**
 * 槽位卡片中心离船心的半径。与卡片宽度一起定死了**斜 45° 那四格挤不挤**:
 * 相邻两格(0° 与 45°)的水平间距 = CHIP_R×sin45° − CHIP_W,当前 = 118.8 − 112 ≈ 6.8px。
 * 把卡片调宽或把半径调小,首先撞车的就是这四对 —— 而"两张卡黏在一起"读起来像一张卡。
 */
const CHIP_R = 168;
const CHIP_W = 112;
const CHIP_H = 64;
/**
 * 射界扇形的半径区间:短程点防(210)贴着船身,最远的湮灭长矛(900)也不许顶到槽位卡片。
 * 上界 102 = 斜格最近的那个角到船心的距离(≈106)再留 4px:扇形从卡片底下露出一截
 * 会让人以为那是两样东西。
 */
const WEDGE_MIN_R = 52;
const WEDGE_MAX_R = 102;
/** 归一化用的射程区间(px,取自 data/towers 的最短/最远两把)。夹在 [0,1] 后线性映射到半径 */
const RANGE_MIN = 200;
const RANGE_MAX = 900;

// —— 炮位贴图(舰壳图上画出"船上那门炮")——
// 几何口径与 render/renderer 的炮位同步(shipG 局部空间):硬点坐标问 sim/armory 的
// WEAPON_HARDPOINTS(船心 0,0,+X 船头),再按舰壳图的图面/世界宽度比缩放到本图。
// 世界里舰壳图宽 = shipLength + CELL×SHIP_HULL_LENGTH_PAD(=48+12×0.72=56.64),
// 图面上舰壳图宽 154px(HULL_ART_CSS),两者相除 = 每世界 px 在图面上是几 px。
/** 舰壳图在图面上的显示宽度(px,与 HULL_ART_CSS 的 width 同值) */
const HULL_ART_PX = 154;
/** 舰壳图的世界宽度(shipLength + CELL×SHIP_HULL_LENGTH_PAD,renderer 的 hull.width 同口径) */
const HULL_ART_WORLD_W = tuning.shipLength + (tuning.shipLength / 4) * 0.72;
/** 世界 px → 图面 px:硬点与炮头尺寸都乘它 */
const PX_PER_WORLD = HULL_ART_PX / HULL_ART_WORLD_W;
/** 炮头贴图边长(世界 px = CELL×0.88,renderer 的 SLOT_GLYPH)→ 图面 px */
const TURRET_PX = (tuning.shipLength / 4) * 0.88 * PX_PER_WORLD;
/** 炮头的机械转轴在贴图里距顶边 72%(renderer 的 TOWER_HEAD_ANCHOR_Y),旋转以它为原点 */
const TURRET_ANCHOR_Y = 0.72;
/** 星级 → 炮头贴图缩放(renderer 的 starScale 同表:1★ 原大、2★ 1.16、3★ 1.32) */
function turretStarScale(stars: number): number {
  return stars >= 3 ? 1.32 : stars === 2 ? 1.16 : 1;
}

const BOARD_CSS =
  'pointer-events:auto;display:flex;flex-direction:column;align-items:center;gap:12px;' +
  'padding:20px 24px 18px;border-radius:12px;box-sizing:border-box;' +
  `border:1px solid ${LINE_COLOR};background:linear-gradient(180deg,rgba(8,14,24,.9) 0%,rgba(5,9,17,.9) 100%);` +
  'box-shadow:0 18px 48px rgba(0,0,0,.4);';
const HEAD_CSS = 'display:flex;align-items:flex-end;justify-content:space-between;gap:16px;width:100%;';
const EYEBROW_CSS = `color:${MUTED_COLOR};font-size:10px;letter-spacing:.22em;text-transform:uppercase;`;
const TITLE_CSS = `color:${OK_COLOR};font-size:16px;letter-spacing:.12em;`;
const READOUT_CSS = `color:${MUTED_COLOR};font-size:11px;text-align:right;line-height:1.6;`;
const HP_TRACK_CSS =
  `width:100%;height:7px;border-radius:999px;border:1px solid ${LINE_COLOR};` +
  'background:rgba(9,16,26,.9);overflow:hidden;';
const HP_FILL_CSS = 'height:100%;border-radius:999px;transition:width 120ms;';
const RING_CSS = `position:relative;width:${RING_PX}px;height:${RING_PX}px;`;
/** 船体轮廓与内胆:两层同形状叠放(外层大 2px = 描边)。clip-path 吃不到 border,只能这么描 */
const HULL_CLIP = 'clip-path:polygon(50% 0%,84% 24%,84% 86%,68% 100%,32% 100%,16% 86%,16% 24%);';
const HULL_EDGE_CSS =
  `position:absolute;left:50%;top:50%;width:68px;height:98px;margin:-49px 0 0 -34px;` +
  `background:#7fb2dd;opacity:.85;${HULL_CLIP}`;
const HULL_CSS =
  'position:absolute;left:50%;top:50%;width:62px;height:92px;margin:-46px 0 0 -31px;' +
  `background:linear-gradient(180deg,#3d5f80 0%,#22354f 58%,#16233a 100%);${HULL_CLIP}`;
const BOW_CSS =
  'position:absolute;left:50%;top:50%;width:24px;height:3px;margin:-44px 0 0 -12px;' +
  'border-radius:2px;background:#dff2ff;box-shadow:0 0 10px rgba(223,242,255,.6);';
/** 真实舰壳图原图船头朝右；旋转 -90° 后与本图「船头朝上」的槽位口径对齐。 */
const HULL_ART_CSS =
  'position:absolute;left:50%;top:50%;width:154px;height:auto;' +
  'transform:translate(-50%,-50%) rotate(-90deg);transform-origin:center;pointer-events:none;' +
  'filter:drop-shadow(0 0 2px rgba(223,242,255,.65)) drop-shadow(0 10px 16px rgba(0,0,0,.5));';
const CHIP_CSS =
  `position:absolute;width:${CHIP_W}px;height:${CHIP_H}px;box-sizing:border-box;` +
  'padding:5px 6px;border-radius:8px;font:inherit;line-height:1.35;text-align:center;display:flex;' +
  `flex-direction:column;justify-content:center;gap:1px;color:${TEXT_COLOR};overflow:hidden;` +
  'transition:border-color 100ms,background 100ms;';
const FACING_CSS = `color:${MUTED_COLOR};font-size:10px;letter-spacing:.1em;`;
// 11px 而不是 12:最长的型号名(等离子迫击炮 = 6 个汉字)加上图标恰好占满卡片内宽,
// 再大一档就得靠省略号截字,而"等离子迫击…"与"等离子…"在货架上是同一串,分不出来
const NAME_CSS = 'font-size:11px;letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
const META_CSS = `color:${MUTED_COLOR};font-size:10px;white-space:nowrap;`;
const FOOT_CSS = 'width:100%;display:flex;flex-direction:column;gap:6px;';
const FOOT_TITLE_CSS = `color:${MUTED_COLOR};font-size:10px;letter-spacing:.16em;text-transform:uppercase;`;
const EDICT_WRAP_CSS = 'display:flex;flex-wrap:wrap;gap:5px;';
const HINT_CSS = `color:${MUTED_COLOR};font-size:11px;letter-spacing:.04em;text-align:center;`;
/** 悬停武器槽的描述 tooltip:整页只此一个,pointer-events:none 永不抢鼠标(与 HUD/图鉴同一条口径) */
const TIP_CSS =
  'position:fixed;display:none;max-width:300px;white-space:pre-line;line-height:1.55;' +
  'z-index:1000;pointer-events:none;background:rgba(10,16,26,.97);' +
  `border:1px solid ${LINE_COLOR};border-radius:6px;padding:8px 10px;` +
  `color:${TEXT_COLOR};font-size:12px;`;

/** 要虚装到船上的那把武器(悬停货架卡 / 待选槽替换时的幽灵) */
export interface ShipDiagramIncoming {
  /** TOWER_* */
  type: number;
  /** 真的买下去会是几星(新武器恒 1★,由调用方填) */
  stars: number;
}

export interface ShipDiagramState {
  /** 'view' = 只读;'pick' = 商店替换;'swap' = 背包内点两个槽交换 */
  mode: 'view' | 'pick' | 'swap';
  /** 虚装的武器;null = 没有待买的东西 */
  incoming: ShipDiagramIncoming | null;
  /**
   * view 态下 incoming 会落到哪个槽(调用方算出的第一个空槽;-1 = 没有空槽)。
   * pick 态下本字段不看:那时"落到哪"由鼠标停在哪一格决定(hoverSlot)。
   */
  target: number;
  /** swap 态下第一次点中的槽位;-1 / 省略 = 尚未选择 */
  selected?: number;
}

export interface ShipDiagramUi {
  /** 整块面板的根节点(调用方自己决定挂到哪、怎么定位) */
  readonly root: HTMLElement;
  /** 按当前世界重画。world = null 时画成空船(换局那一瞬不该留着上一局的读数) */
  paint(world: World | null, state: ShipDiagramState): void;
  /**
   * 语言切换后原地重画(05 号)。用**上一次 paint 的入参**重画(保留 hoverSlot / mode /
   * incoming / selected),标题/副题/船体读数/法令区/提示行全走当前语言;
   * 不重注册监听、不重建八张槽位卡片(节点是整局只建一次的)。
   */
  refreshLocale(): void;
}

export interface ShipDiagramOpts {
  /** 点了第 slot 格(只在 mode = 'pick' / 'swap' 时响);不传 = 纯只读面板 */
  onSlotClick?(slot: number): void;
  /** 背包与商店默认共用同一个标题,特殊页可覆盖;不传时取 ui:armory.title 的翻译 */
  title?: string;
  eyebrow?: string;
}

/** 幽灵武器的 DPS 暂存槽:UI 侧也照铁律 3 复用一份,不为每次重画新建对象 */
const ghostSlot: WeaponSlot = {
  type: -1,
  stars: 1,
  cooldown: 0,
  ammo: 0,
  reloadLeft: 0,
  heat: 0,
  coolLock: 0,
  charge: 0,
  turretOffset: 0,
};

/** 射程 → 扇形半径(px)。夹在 [WEDGE_MIN_R, WEDGE_MAX_R]:再远的射程也不许顶穿槽位卡片 */
export function wedgeRadius(range: number): number {
  const t = (range - RANGE_MIN) / (RANGE_MAX - RANGE_MIN);
  const clamped = t > 0 ? (t < 1 ? t : 1) : 0; // NaN 一并接住(与 towers 的 clampLevel 同一条写法)
  return WEDGE_MIN_R + (WEDGE_MAX_R - WEDGE_MIN_R) * clamped;
}

/** 槽位朝向(弧度,0 = 船头)→ 角度(度,0 = 正上、顺时针为正),即 conic-gradient 的 from 口径 */
export function slotFacingDeg(slot: number): number {
  return ((WEAPON_SLOT_FACING[slot] ?? 0) * 180) / Math.PI;
}

export function createShipDiagram(opts: ShipDiagramOpts = {}): ShipDiagramUi {
  const root = document.createElement('div');
  root.style.cssText = BOARD_CSS;
  root.className = 'sw-ship-board';

  // —— 头部:标题 + 船体/火力读数 ——
  const head = document.createElement('div');
  head.style.cssText = HEAD_CSS;
  head.className = 'sw-ship-head';
  const titleBox = document.createElement('div');
  const eyebrow = document.createElement('div');
  eyebrow.style.cssText = EYEBROW_CSS;
  eyebrow.textContent = opts.eyebrow ?? t('ui:armory.eyebrow');
  const title = document.createElement('div');
  title.style.cssText = TITLE_CSS;
  title.textContent = opts.title ?? t('ui:armory.title');
  titleBox.append(eyebrow, title);
  // 船体/持续火力读数:标签与数值分开建 DOM 节点(05 号 —— 翻译只进 textContent,
  // 绝不再往 innerHTML 里拼翻译;语言切换时只改 label 节点,数值节点照旧)
  const readout = document.createElement('div');
  readout.style.cssText = READOUT_CSS;
  const readoutHpLabel = document.createElement('span');
  readoutHpLabel.style.cssText = `color:${MUTED_COLOR};margin-right:4px;`;
  const readoutHpValue = document.createElement('span');
  readoutHpValue.style.cssText = `color:${TEXT_COLOR};`;
  const readoutRow1 = document.createElement('div');
  readoutRow1.append(readoutHpLabel, readoutHpValue);
  const readoutDpsLabel = document.createElement('span');
  readoutDpsLabel.style.cssText = `color:${MUTED_COLOR};margin-right:4px;`;
  const readoutDpsValue = document.createElement('span');
  readoutDpsValue.style.cssText = `color:${TEXT_COLOR};`;
  const readoutRow2 = document.createElement('div');
  readoutRow2.append(readoutDpsLabel, readoutDpsValue);
  readout.append(readoutRow1, readoutRow2);
  head.append(titleBox, readout);

  const hpTrack = document.createElement('div');
  hpTrack.style.cssText = HP_TRACK_CSS;
  const hpFill = document.createElement('div');
  hpFill.style.cssText = HP_FILL_CSS;
  hpTrack.appendChild(hpFill);

  // —— 环形:扇形层 → 船体 → 槽位卡片层(后挂的盖在上面,卡片永远可点) ——
  const ring = document.createElement('div');
  ring.style.cssText = RING_CSS;
  ring.className = 'sw-ship-ring';
  const wedges: HTMLElement[] = [];
  for (let i = 0; i < WEAPON_SLOT_COUNT; i++) {
    const wedge = document.createElement('div');
    wedge.style.cssText = 'position:absolute;border-radius:50%;pointer-events:none;';
    ring.appendChild(wedge);
    wedges.push(wedge);
  }
  const hullEdge = document.createElement('div');
  hullEdge.style.cssText = HULL_EDGE_CSS;
  const hull = document.createElement('div');
  hull.style.cssText = HULL_CSS;
  const bow = document.createElement('div');
  bow.style.cssText = BOW_CSS;
  const hullArt = document.createElement('img');
  hullArt.style.cssText = HULL_ART_CSS;
  hullArt.src = SHIP_HULL_ART_URL;
  hullArt.alt = t('ui:ship.shipAlt');
  // 资产加载失败时隐藏图片，下面的程序化船壳仍然可读。
  hullArt.addEventListener('error', () => { hullArt.style.display = 'none'; });
  ring.append(hullEdge, hull, bow, hullArt);

  // —— 炮位贴图层:八个硬点上各放一枚真实炮头贴图,盖在舰壳图上、压在卡片层下 ——
  // 与槽位卡片同一条生命周期:整局只建一次,paint 只改 src/位置/旋转/显隐。
  // 贴图加载失败的单枚炮位就地隐藏(与 hullArt 同一条退路,不炸掉整层)。
  const turretLayer = document.createElement('div');
  turretLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
  const turrets: HTMLImageElement[] = [];
  for (let slot = 0; slot < WEAPON_SLOT_COUNT; slot++) {
    const img = document.createElement('img');
    img.style.cssText = 'position:absolute;pointer-events:none;object-fit:contain;';
    img.alt = '';
    img.addEventListener('error', () => { img.style.display = 'none'; });
    turretLayer.appendChild(img);
    turrets.push(img);
  }
  ring.appendChild(turretLayer);

  // 槽位卡片:整局只建一次,此后每次 paint 只改文案与描边(与 armoryPanel 同一条生命周期)。
  // 单独装进一层 chipLayer 并**最后挂**:后挂 = 盖在扇形与船体之上(卡片永远可点),
  // 同时"环里最后一层就是八张卡、下标即槽位"成了一条稳定契约 ——
  // 往环里加装饰(船体描边之类)不会把卡片挤到别的下标上去
  const chipLayer = document.createElement('div');
  chipLayer.style.cssText = 'position:absolute;inset:0;';
  const chips: HTMLButtonElement[] = [];
  for (let slot = 0; slot < WEAPON_SLOT_COUNT; slot++) {
    const chip = document.createElement('button');
    const rad = (slotFacingDeg(slot) * Math.PI) / 180;
    const cx = RING_C + CHIP_R * Math.sin(rad);
    const cy = RING_C - CHIP_R * Math.cos(rad);
    chip.style.cssText = `${CHIP_CSS}left:${cx - CHIP_W / 2}px;top:${cy - CHIP_H / 2}px;`;
    chip.addEventListener('click', () => clickSlot(slot));
    chip.addEventListener('mouseenter', () => hover(slot));
    chip.addEventListener('mouseleave', () => hover(-1));
    chipLayer.appendChild(chip);
    chips.push(chip);
  }
  ring.appendChild(chipLayer);

  // —— 脚部:法令(全船被动,不占槽,只能在这里读)+ 一行看图说明 ——
  const foot = document.createElement('div');
  foot.style.cssText = FOOT_CSS;
  const edictTitle = document.createElement('div');
  edictTitle.style.cssText = FOOT_TITLE_CSS;
  edictTitle.textContent = t('ui:ship.edictsTitle');
  const edictWrap = document.createElement('div');
  edictWrap.style.cssText = EDICT_WRAP_CSS;
  foot.append(edictTitle, edictWrap);

  const hint = document.createElement('div');
  hint.style.cssText = HINT_CSS;

  // 悬停武器槽的描述 tooltip:整页只此一个(与 HUD 法令悬停同一条口径),最后挂 ——
  // 头/HP 条/环/脚部的 children 下标不因它挪位
  const tip = document.createElement('div');
  tip.style.cssText = TIP_CSS;

  root.append(head, hpTrack, ring, foot, hint, tip);
  hint.className = 'sw-ship-hint';

  /** 鼠标停在哪一格(-1 = 没有)。只在 pick 态下改变画面 —— 是纯表现,不交给调用方 */
  let hoverSlot = -1;
  /** 上一次 paint 的入参:悬停要就地重画,总得有一份"照什么画"的记录 */
  let lastWorld: World | null = null;
  let lastState: ShipDiagramState = { mode: 'view', incoming: null, target: -1 };

  function clickSlot(slot: number): void {
    if (lastState.mode === 'view') return;
    if (lastState.mode === 'swap') {
      opts.onSlotClick?.(slot);
      return;
    }
    // 空槽点不动:与画面上的 disabled 同一条判据(真 DOM 不会点穿 disabled,测试桩会)。
    // 少了这一句,"替换一个空槽"会被当成合法请求送进 World,而那本该是走不到的分支
    const s = lastWorld?.weapons[slot];
    if (!s || s.type < 0) return;
    opts.onSlotClick?.(slot);
  }

  function hover(slot: number): void {
    if (hoverSlot === slot) return;
    hoverSlot = slot;
    if (lastState.mode === 'pick') paint(lastWorld, lastState); // 只读态的悬停不改画面,省一次重画
    showChipTip(slot);
  }

  /**
   * 悬停已装武器的槽 → 弹描述 tooltip(名称★星级 · 系 / 当前星级那一行数值 / 持续火力)。
   * 空槽收起 —— 与商店货架、图鉴同一套"数值进悬停"的口径;描述的是**这格现在装的这把**,
   * 不是待买的幽灵。paint 一律先把 tip 收起:换装/换位后世界变了,旧描述不许还悬在屏幕上。
   */
  function showChipTip(slot: number): void {
    const world = lastWorld;
    const s = slot >= 0 ? world?.weapons[slot] : undefined;
    const def = s && s.type >= 0 ? TOWERS[s.type] : undefined;
    if (!world || !s || s.type < 0 || def === undefined) {
      tip.style.display = 'none';
      return;
    }
    const stars = s.stars >= 1 && s.stars <= 3 ? s.stars : 1;
    const dps = world ? slotSustainedDps(s, def, world.buffs) : 0;
    tip.textContent = [
      `${weaponDisplayName(s.type)} ${'★'.repeat(stars)} · ${throttleFamilyName(def.throttle)}`,
      starLine(def, stars),
      `${t('ui:ship.readoutDps')} ${Math.round(dps)}/s`,
    ].join('\n');
    tip.style.display = 'block';
    // 定位在槽位卡下方,贴屏边时夹回(与 HUD/图鉴 tooltip 同一条"永远可读"的口径)
    const anchor = chips[slot]!;
    const rect = typeof anchor.getBoundingClientRect === 'function'
      ? anchor.getBoundingClientRect()
      : { left: 8, bottom: 8 };
    const vw = window.innerWidth || 1024;
    tip.style.left = `${Math.max(8, Math.min(rect.left, vw - 316))}px`;
    tip.style.top = `${rect.bottom + 6}px`;
  }

  /** 一枚炮头贴图:按"这一格最终装的是什么"摆到硬点上,朝向 = 槽位射界中心(见文件头)。
   * 船体局部 +X = 船头、+Y = 右舷(WEAPON_HARDPOINTS),图面上船头朝上、右舷朝右:
   * 于是硬点 (hx, hy) → 图面 (RING_C + hy·scale, RING_C − hx·scale)(与 hullArt 的 rotate(-90°) 对齐)。
   * 机械转轴在贴图 72% 处(TOWER_HEAD_ANCHOR_Y),故绕 (50%, 72%) 旋转、该点落在硬点上。 */
  function paintTurret(index: number, type: number, stars: number, ghost: boolean): void {
    const img = turrets[index]!;
    const def = type >= 0 ? TOWERS[type] : undefined;
    const starUrls = def !== undefined && type >= 0 ? TOWER_STAR_ART_URLS[type] : undefined;
    const url = starUrls?.[Math.max(1, Math.min(3, Math.floor(stars))) - 1] ?? starUrls?.[0];
    if (url === undefined) {
      img.style.display = 'none';
      img.src = ''; // 清掉旧 src:隐藏的炮头不该还指着一把已经不在这格的炮
      return;
    }
    const hp = WEAPON_HARDPOINTS[index];
    if (!hp) {
      // 硬点表写坏:这一枚炮头不画,不炸掉整层(与 renderer 的 syncWeaponSprites 同一条退路)
      img.style.display = 'none';
      img.src = '';
      return;
    }
    const size = TURRET_PX * turretStarScale(stars);
    const hx = RING_C + hp.y * PX_PER_WORLD;
    const hy = RING_C - hp.x * PX_PER_WORLD;
    img.src = url;
    img.style.display = 'block';
    img.style.width = `${size}px`;
    img.style.height = `${size}px`;
    img.style.left = `${hx - size / 2}px`;
    img.style.top = `${hy - size * TURRET_ANCHOR_Y}px`;
    img.style.transformOrigin = '50% 72%';
    img.style.transform = `rotate(${slotFacingDeg(index)}deg)`;
    // 幽灵炮头压暗一档:与扇形/卡片的幽灵态同一支"还没买下来"的口径
    img.style.opacity = ghost ? '.45' : '1';
  }

  /** 一枚射界扇形:conic-gradient 的 0deg = 正上、顺时针为正,与槽位朝向同一口径(见文件头) */
  function paintWedge(index: number, type: number, level: number, ghost: boolean): void {
    const wedge = wedges[index]!;
    const def = type >= 0 ? TOWERS[type] : undefined;
    if (!def) {
      wedge.style.display = 'none';
      return;
    }
    const r = wedgeRadius(towerRange(def, level));
    const arc = towerArcDeg(def, level);
    const from = slotFacingDeg(index) - arc / 2;
    const color = towerTintCss(type);
    wedge.style.display = 'block';
    wedge.style.left = `${RING_C - r}px`;
    wedge.style.top = `${RING_C - r}px`;
    wedge.style.width = `${2 * r}px`;
    wedge.style.height = `${2 * r}px`;
    // 内浓外淡的两段:扇形本身已经在说"能打多远",再来一层渐变就不至于糊成一块实心饼
    wedge.style.background =
      `conic-gradient(from ${from}deg,${color}4d 0deg,${color}1a ${arc}deg,transparent ${arc}deg)`;
    // 幽灵(还没买下来的那把)压暗一档 + 虚线感:与已装的武器一眼分得开
    wedge.style.opacity = ghost ? '.5' : '.85';
  }

  function paint(world: World | null, state: ShipDiagramState): void {
    lastWorld = world;
    lastState = state;
    tip.style.display = 'none'; // 换装/换位/重画后旧描述不作数,悬停重新点亮
    const pick = state.mode === 'pick';
    const swap = state.mode === 'swap';
    // pick 态:虚装落在鼠标停着的那一格;view 态:落在调用方算好的空槽上
    const ghostAt = state.incoming ? (pick ? hoverSlot : state.target) : -1;

    let totalDps = 0;
    for (let slot = 0; slot < WEAPON_SLOT_COUNT; slot++) {
      const chip = chips[slot]!;
      const s: WeaponSlot | undefined = world?.weapons[slot];
      const equipped = s && s.type >= 0 ? s : undefined;
      const def = equipped ? TOWERS[equipped.type] : undefined;
      const ghost = ghostAt === slot ? state.incoming : null;
      const facing = slotFacingName(slot);

      if (equipped && def && world) totalDps += slotSustainedDps(equipped, def, world.buffs);

      // 炮头贴图按"这一格最终会是什么"画:虚装盖住原有的那把(与扇形/卡片同一份幽灵口径)
      if (ghost) paintTurret(slot, ghost.type, ghost.stars, true);
      else paintTurret(slot, equipped?.type ?? -1, equipped?.stars ?? 1, false);

      // 扇形按"这一格最终会是什么"画:虚装盖住原有的那把,于是换装前后的射界差是看得见的
      if (ghost) paintWedge(slot, ghost.type, ghost.stars, true);
      else paintWedge(slot, equipped?.type ?? -1, equipped?.stars ?? 1, false);

      // 卡片内容一律用真实 DOM 节点 + textContent 拼装:翻译与内容名不进 innerHTML
      // (与 05 号"翻译只进 textContent"同一条纪律 —— 标签/数值/图标分节点写)
      chip.textContent = '';
      const facingLine = document.createElement('div');
      facingLine.style.cssText = FACING_CSS;
      facingLine.textContent = facing;
      chip.appendChild(facingLine);
      if (ghost) {
        const gdef = TOWERS[ghost.type];
        if (equipped && def) {
          // 换装预览:旧的划掉、新的顶上 —— 玩家点下去之前就看得到自己拿什么换什么
          const old = document.createElement('div');
          old.style.cssText = `${NAME_CSS}color:${MUTED_COLOR};text-decoration:line-through;`;
          old.textContent = `${weaponDisplayName(equipped.type)} ${'★'.repeat(equipped.stars)}`;
          chip.appendChild(old);
        }
        const ghostName = document.createElement('div');
        ghostName.style.cssText = `${NAME_CSS}color:${SEL_COLOR};`;
        ghostName.textContent =
          (gdef === undefined ? t('ui:slot.unknownWeapon', { type: ghost.type }) : weaponDisplayName(ghost.type)) +
          ` ${'★'.repeat(ghost.stars)}`;
        chip.appendChild(ghostName);
        if (!equipped) {
          const meta = document.createElement('div');
          meta.style.cssText = META_CSS;
          meta.textContent = ghostMeta(world, ghost);
          chip.appendChild(meta);
        }
      } else if (equipped && def) {
        const dps = world ? slotSustainedDps(equipped, def, world.buffs) : 0;
        const name = document.createElement('div');
        name.style.cssText = NAME_CSS;
        const glyph = document.createElement('span');
        glyph.style.cssText = `color:${towerTintCss(equipped.type)};`;
        glyph.textContent = towerGlyph(equipped.type);
        const nameText = document.createElement('span');
        nameText.textContent = `${weaponDisplayName(equipped.type)} ${'★'.repeat(equipped.stars)}`;
        name.append(glyph, nameText);
        chip.appendChild(name);
        const meta = document.createElement('div');
        meta.style.cssText = META_CSS;
        meta.textContent =
          `${throttleFamilyName(def.throttle)} · ${Math.round(towerArcDeg(def, equipped.stars))}° · ` +
          `${Math.round(dps)}/s`;
        chip.appendChild(meta);
      } else {
        const empty = document.createElement('div');
        empty.style.cssText = `${NAME_CSS}color:${MUTED_COLOR};`;
        empty.textContent = t('ui:slot.emptyFull');
        chip.appendChild(empty);
      }

      // 描边三态:待选(pick 态的可点格)/ 预览命中 / 常态。空槽走虚线,"这里还能装"是一眼的事
      const highlight = ghostAt === slot || (pick && hoverSlot === slot) || (swap && state.selected === slot);
      const dashed = !equipped && !ghost;
      chip.style.border = `1px ${dashed ? 'dashed' : 'solid'} ${highlight ? SEL_COLOR : LINE_COLOR}`;
      chip.style.background = highlight
        ? 'rgba(255,212,121,.14)'
        : equipped
          ? 'rgba(21,34,52,.82)'
          : 'rgba(13,21,34,.6)';
      chip.style.boxShadow = equipped
        ? equipped.stars >= 3
          ? '0 0 18px rgba(255,241,168,.42), inset 0 0 16px rgba(255,212,121,.08)'
          : equipped.stars === 2
            ? '0 0 14px rgba(255,212,121,.26)'
            : 'none'
        : 'none';
      // 商店替换只能点已装武器；背包换位允许点空槽，用来把武器挪到空方位。
      const clickable = swap || (pick && !!equipped);
      chip.disabled = !clickable;
      chip.style.cursor = clickable ? 'pointer' : 'default';
      chip.style.opacity = pick && !equipped ? '.45' : '1';
    }

    // 船体读数:HP 条 + 总持续 DPS(与 HUD 火力面板同一份 slotSustainedDps 口径)
    const hp = world ? world.ship.hp : 0;
    const maxHp = world ? world.ship.maxHp : 0;
    const ratio = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
    hpFill.style.width = `${ratio * 100}%`;
    // 血条颜色只在**自己的血**上用暖色(与渲染层 FXV_HULL_HIT 的暖红同一条豁免)
    hpFill.style.background = ratio > 0.55 ? '#5ce8b4' : ratio > 0.25 ? '#ffd479' : '#ff7a6b';
    // 读数只改 textContent:标签(翻译)与数值(数字)分节点写,绝不把翻译拼进 innerHTML
    readoutHpLabel.textContent = t('ui:ship.readoutHp');
    readoutHpValue.textContent = `${Math.round(hp)}/${Math.round(maxHp)}`;
    readoutDpsLabel.textContent = t('ui:ship.readoutDps');
    readoutDpsValue.textContent = `${Math.round(totalDps)}/s`;

    // 法令:全船被动不占任何槽位,不在这里印就整局无处可查。chip 前缀 = 作用域标签(系名/全船)
    // 节点现建现挂(不是 60fps 热路径);翻译与数值一律走 textContent。
    // 清空用 textContent = ''(真实 DOM 会移除全部子节点;测试桩也能照常跑)
    edictWrap.textContent = '';
    let held = 0;
    for (let i = 0; i < EDICTS.length; i++) {
      const level = world?.edictLevels[i] ?? 0;
      if (level <= 0) continue;
      held++;
      const def = EDICTS[i]!;
      const color = `#${def.tint.toString(16).padStart(6, '0')}`;
      const chip = document.createElement('span');
      chip.style.cssText =
        `padding:2px 7px;border-radius:999px;border:1px solid ${LINE_COLOR};` +
        `background:rgba(21,34,52,.62);font-size:11px;color:${TEXT_COLOR};`;
      const dot = document.createElement('span');
      dot.style.cssText = `color:${color};`;
      dot.textContent = '◆';
      const text = document.createElement('span');
      text.textContent = ` ${edictScopeLabel(def)} ${edictName(def.type)} ×${level}`;
      chip.append(dot, text);
      edictWrap.appendChild(chip);
    }
    if (held === 0) {
      const empty = document.createElement('span');
      empty.style.cssText = `color:${MUTED_COLOR};font-size:11px;`;
      empty.textContent = t('ui:ship.noEdicts');
      edictWrap.appendChild(empty);
    }

    hint.textContent = pick
      ? t('ui:ship.hint.pick')
      : swap
        ? state.selected !== undefined && state.selected >= 0
          ? t('ui:ship.hint.swapSelected', { facing: slotFacingName(state.selected) })
          : t('ui:ship.hint.swap')
        : t('ui:ship.hint.view');
  }

  /** 语言切换后原地重画(05 号):标题/副题/法令标题现刷,正文用上一次的入参重画一遍 */
  function refreshLocale(): void {
    eyebrow.textContent = opts.eyebrow ?? t('ui:armory.eyebrow');
    title.textContent = opts.title ?? t('ui:armory.title');
    edictTitle.textContent = t('ui:ship.edictsTitle');
    paint(lastWorld, lastState);
  }

  return { root, paint, refreshLocale };
}

/**
 * **还没装上船**的那把武器的持续 DPS 预估。商店卡与舰船图上的幽灵格共用这一份 ——
 * 两处各算一份的话,同一把武器会在货架上与船上印出不同的数,而玩家没法判断哪个是真的。
 * 走 sim/tower 的 slotSustainedDps(与 HUD 火力面板同源),法令加成一并算进去。
 * world = null(换局那一瞬)时没有 buffs 可读,返回 0 而不是拿中性值现编一个。
 */
export function previewSustainedDps(world: World | null, type: number, stars: number): number {
  const def = TOWERS[type];
  if (!def || !world) return 0;
  ghostSlot.type = type;
  ghostSlot.stars = stars;
  return slotSustainedDps(ghostSlot, def, world.buffs);
}

/** 幽灵武器落在空槽上时那一行读数(系名 · 射界 · 预估 DPS);拿不到世界就只印前两项 */
function ghostMeta(world: World | null, incoming: ShipDiagramIncoming): string {
  const def = TOWERS[incoming.type];
  if (!def) return t('ui:slot.unknown');
  const head = `${throttleFamilyName(def.throttle)} · ${Math.round(towerArcDeg(def, incoming.stars))}°`;
  if (!world) return head;
  return `${head} · ${Math.round(previewSustainedDps(world, incoming.type, incoming.stars))}/s`;
}
