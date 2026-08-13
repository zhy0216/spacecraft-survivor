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
  throttleName,
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
import { edictScopeLabel, EDICTS } from '../data/edicts';
import { WEAPON_SLOT_COUNT, WEAPON_SLOT_FACING, type WeaponSlot } from '../sim/armory';
import { slotSustainedDps } from '../sim/tower';
import type { World } from '../sim/world';

const OK_COLOR = '#9adcff';
const TEXT_COLOR = '#c8dcf0';
const MUTED_COLOR = '#6f89a5';
const LINE_COLOR = '#2b4a6e';
/** 选中/预览的暖色。暖色是敌人的色域(GDD §12),只许用在**玩家自己点出来的那一小块**上 */
const SEL_COLOR = '#ffd479';

/**
 * 槽位编号 → 朝向中文名。与 sim/armory 的 WEAPON_SLOT_FACING 一一对应,
 * **改了那张表就得改这张**(错位 = 面板上写着"正前"的那门炮其实朝后,
 * 而这种错要等玩家在战斗里被侧面咬死才发现)。ui/armoryPanel 也从这里取,不许各存一份。
 */
export const SLOT_FACING_NAME: string[] = ['正前', '右前', '正右', '右后', '正后', '左后', '正左', '左前'];

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

/** 要虚装到船上的那把武器(悬停货架卡 / 待选槽替换时的幽灵) */
export interface ShipDiagramIncoming {
  /** TOWER_* */
  type: number;
  /** 真的买下去会是几星(新武器恒 1★,由调用方填) */
  stars: number;
}

export interface ShipDiagramState {
  /** 'view' = 只读舰况;'pick' = 等玩家点一个槽(武器槽满时的替换购买) */
  mode: 'view' | 'pick';
  /** 虚装的武器;null = 没有待买的东西 */
  incoming: ShipDiagramIncoming | null;
  /**
   * view 态下 incoming 会落到哪个槽(调用方算出的第一个空槽;-1 = 没有空槽)。
   * pick 态下本字段不看:那时"落到哪"由鼠标停在哪一格决定(hoverSlot)。
   */
  target: number;
}

export interface ShipDiagramUi {
  /** 整块面板的根节点(调用方自己决定挂到哪、怎么定位) */
  readonly root: HTMLElement;
  /** 按当前世界重画。world = null 时画成空船(换局那一瞬不该留着上一局的读数) */
  paint(world: World | null, state: ShipDiagramState): void;
}

export interface ShipDiagramOpts {
  /** 点了第 slot 格(只在 mode = 'pick' 时响);不传 = 纯只读面板 */
  onSlotClick?(slot: number): void;
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

  // —— 头部:标题 + 船体/火力读数 ——
  const head = document.createElement('div');
  head.style.cssText = HEAD_CSS;
  const titleBox = document.createElement('div');
  const eyebrow = document.createElement('div');
  eyebrow.style.cssText = EYEBROW_CSS;
  eyebrow.textContent = 'YOUR SHIP';
  const title = document.createElement('div');
  title.style.cssText = TITLE_CSS;
  title.textContent = '舰船一览';
  titleBox.append(eyebrow, title);
  const readout = document.createElement('div');
  readout.style.cssText = READOUT_CSS;
  head.append(titleBox, readout);

  const hpTrack = document.createElement('div');
  hpTrack.style.cssText = HP_TRACK_CSS;
  const hpFill = document.createElement('div');
  hpFill.style.cssText = HP_FILL_CSS;
  hpTrack.appendChild(hpFill);

  // —— 环形:扇形层 → 船体 → 槽位卡片层(后挂的盖在上面,卡片永远可点) ——
  const ring = document.createElement('div');
  ring.style.cssText = RING_CSS;
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
  ring.append(hullEdge, hull, bow);

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
  edictTitle.textContent = '已生效法令';
  const edictWrap = document.createElement('div');
  edictWrap.style.cssText = EDICT_WRAP_CSS;
  foot.append(edictTitle, edictWrap);

  const hint = document.createElement('div');
  hint.style.cssText = HINT_CSS;

  root.append(head, hpTrack, ring, foot, hint);

  /** 鼠标停在哪一格(-1 = 没有)。只在 pick 态下改变画面 —— 是纯表现,不交给调用方 */
  let hoverSlot = -1;
  /** 上一次 paint 的入参:悬停要就地重画,总得有一份"照什么画"的记录 */
  let lastWorld: World | null = null;
  let lastState: ShipDiagramState = { mode: 'view', incoming: null, target: -1 };

  function clickSlot(slot: number): void {
    if (lastState.mode !== 'pick') return; // 只读态点了也不响:换装的入口只有一个
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
    const pick = state.mode === 'pick';
    // pick 态:虚装落在鼠标停着的那一格;view 态:落在调用方算好的空槽上
    const ghostAt = state.incoming ? (pick ? hoverSlot : state.target) : -1;

    let totalDps = 0;
    for (let slot = 0; slot < WEAPON_SLOT_COUNT; slot++) {
      const chip = chips[slot]!;
      const s: WeaponSlot | undefined = world?.weapons[slot];
      const equipped = s && s.type >= 0 ? s : undefined;
      const def = equipped ? TOWERS[equipped.type] : undefined;
      const ghost = ghostAt === slot ? state.incoming : null;
      const facing = SLOT_FACING_NAME[slot] ?? `槽${slot}`;

      if (equipped && def && world) totalDps += slotSustainedDps(equipped, def, world.buffs);

      // 扇形按"这一格最终会是什么"画:虚装盖住原有的那把,于是换装前后的射界差是看得见的
      if (ghost) paintWedge(slot, ghost.type, ghost.stars, true);
      else paintWedge(slot, equipped?.type ?? -1, equipped?.stars ?? 1, false);

      const lines: string[] = [`<div style="${FACING_CSS}">${facing}</div>`];
      if (ghost) {
        const gdef = TOWERS[ghost.type];
        const gname = gdef?.name ?? `未知武器(${ghost.type})`;
        if (equipped && def) {
          // 换装预览:旧的划掉、新的顶上 —— 玩家点下去之前就看得到自己拿什么换什么
          lines.push(
            `<div style="${NAME_CSS}color:${MUTED_COLOR};text-decoration:line-through">` +
              `${def.name} ★${equipped.stars}</div>`,
          );
        }
        lines.push(
          `<div style="${NAME_CSS}color:${SEL_COLOR}">▸ ${gname} ★${ghost.stars}</div>`,
        );
        if (!equipped) lines.push(`<div style="${META_CSS}">${ghostMeta(world, ghost)}</div>`);
      } else if (equipped && def) {
        const dps = world ? slotSustainedDps(equipped, def, world.buffs) : 0;
        lines.push(
          `<div style="${NAME_CSS}"><span style="color:${towerTintCss(equipped.type)}">` +
            `${towerGlyph(equipped.type)}</span> ${def.name} ★${equipped.stars}</div>`,
          `<div style="${META_CSS}">${throttleName(def.throttle)} · ` +
            `${Math.round(towerArcDeg(def, equipped.stars))}° · ${Math.round(dps)}/s</div>`,
        );
      } else {
        lines.push(`<div style="${NAME_CSS}color:${MUTED_COLOR}">— 空槽 —</div>`);
      }
      chip.innerHTML = lines.join('');

      // 描边三态:待选(pick 态的可点格)/ 预览命中 / 常态。空槽走虚线,"这里还能装"是一眼的事
      const highlight = ghostAt === slot || (pick && hoverSlot === slot);
      const dashed = !equipped && !ghost;
      chip.style.border = `1px ${dashed ? 'dashed' : 'solid'} ${highlight ? SEL_COLOR : LINE_COLOR}`;
      chip.style.background = highlight
        ? 'rgba(255,212,121,.14)'
        : equipped
          ? 'rgba(21,34,52,.82)'
          : 'rgba(13,21,34,.6)';
      // pick 态才可点:只读面板上的格子不是按钮,给出手型只会骗玩家点一下试试
      const clickable = pick && !!equipped;
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
    readout.innerHTML =
      `船体 <span style="color:${TEXT_COLOR}">${Math.round(hp)}/${Math.round(maxHp)}</span>` +
      ` · 持续火力 <span style="color:${TEXT_COLOR}">${Math.round(totalDps)}/s</span>`;

    // 法令:全船被动不占任何槽位,不在这里印就整局无处可查。chip 前缀 = 作用域标签(系名/全船)
    const owned: string[] = [];
    for (let i = 0; i < EDICTS.length; i++) {
      const level = world?.edictLevels[i] ?? 0;
      if (level <= 0) continue;
      const def = EDICTS[i]!;
      const color = `#${def.tint.toString(16).padStart(6, '0')}`;
      owned.push(
        `<span style="padding:2px 7px;border-radius:999px;border:1px solid ${LINE_COLOR};` +
          `background:rgba(21,34,52,.62);font-size:11px;color:${TEXT_COLOR}">` +
          `<span style="color:${color}">◆</span> ${edictScopeLabel(def)} ${def.name} ×${level}</span>`,
      );
    }
    edictWrap.innerHTML =
      owned.length > 0
        ? owned.join('')
        : `<span style="color:${MUTED_COLOR};font-size:11px">尚未持有任何法令</span>`;

    hint.textContent = pick
      ? '点一个武器槽把它换成新武器 · 扇形 = 该槽射界与射程'
      : '扇形 = 该槽射界与射程 · 上方为船头';
  }

  return { root, paint };
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
  if (!def) return '未知型号';
  const head = `${throttleName(def.throttle)} · ${Math.round(towerArcDeg(def, incoming.stars))}°`;
  if (!world) return head;
  return `${head} · ${Math.round(previewSustainedDps(world, incoming.type, incoming.stars))}/s`;
}
