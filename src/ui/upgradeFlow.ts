/**
 * 三选一升级流程 —— DOM 覆盖层(10 号 issue T4),**永不 import pixi**(铁律 1 的另一半:
 * 世界里的东西走 Pixi,菜单/卡片/面板走 #ui 覆盖层)。
 *
 * 两阶段状态机,除此之外没有第三条路:
 *   **选卡**(读 world.offer 弹卡)→ 点一张卡 → **放置**(把候选照 PlacementUiState 填进去,
 *   渲染层现成的合法格高亮直接生效)→ 点合法格确认 → world.takeUpgrade → onResolved()
 *   (收卡、复位甲板缩放、恢复战斗全在 main.ts 那一侧)。
 * 取消只回退**一格**:放置阶段 Esc / 右键 / 「重选」退回选卡(不扣费、更不恢复战斗);
 * 选卡阶段唯一的出口是「跳过」(world.skipUpgrade,返还额见 skipRefund)。
 * **刻意没有"什么都不选直接关掉"这条路**:费用是"这一次升级"本身,不消费掉的话
 * World 下一帧照样满足 scrap ≥ upgradeCost,当场再弹同一张卡 —— 那才是真正的死循环。
 * 非法格点击一律照 PLACE_* 码闪红 + 说人话,**不结算、不恢复战斗**(验收:非法格不可确认放置)。
 *
 * 本文件**取代**了 03 号的灰盒放置入口 ui/placement.ts:那个文件连同它的键位与提示条整个删除,
 * 三个纯函数 denyMessage / placeLabel / placedMessage 迁到这里(nextSupportType / keyHintText
 * 随灰盒键位一起没了)。删而不是降级成一个 debug 开关,两条理由都不是洁癖:
 *   一、**PlacementUiState 只能有一个主人**。渲染层持有的是一个状态对象引用(setPlacement),
 *       两套入口就是两个都在就地改它字段的写者,外加两条 canvas click 监听 ——
 *       时停期间点一下甲板会被两边各解释一次,而其中一边压根不知道"待选候选"这回事。
 *   二、**一个绕开经济的放置口会让"一局 12–15 次升级"这条平衡口径当场作废**
 *       (见 sim/economy.test.ts):随手放几座塔之后,所有关于残骸/曲线的实测都不作数了。
 * 灰盒时期"要能在浏览器里真的点出合法格高亮与拒绝理由"这个诉求由本流程原样接住
 * (而且带时停、带放大),故那条路没有留下的价值。
 *
 * 分层与旧文件一字不差:ui 只碰 DOM 与事件;屏幕像素 → 甲板局部坐标走渲染层给的 screenToDeckLocal
 * (镜头公式只在渲染层存一份 —— 甲板放大 30% 之后更是只有它算得对),放置本身走 world.takeUpgrade,
 * 合法性判定一行都不在这里重写(重写就是第二份会走散的规则)。
 * 状态对象 PlacementUiState 的定义在渲染层并由本文件 import type 进来,依赖方向单向 ui → render:
 * 本文件就地改它的字段,渲染层只读 —— 两边不必再约定"通知"通道,也不新增分配(铁律 3)。
 *
 * 卡片上的名称 / 一句话描述 / 当前等级**一律从数值表现生成**,不给 data/towers、data/supports
 * 与 data/deckPieces 加 desc 字段:表里改一个数、加一座塔/拼块,卡片自己就跟上
 * (05 号验收口径:改数据文件即可调平衡,不改代码);而多一个手写描述字段,就是多一处会走散的真相。
 */
import { skipRefundFor, UPGRADE_SKIP_FEE } from '../data/economy';
import { DECK_PIECES, deckPieceCellCount } from '../data/deckPieces';
import {
  SUP_AMMO_BAY,
  SUP_ARMOR_BAY,
  SUP_CAPACITOR,
  SUP_RADIATOR,
  type SupportDef,
  SUPPORTS,
} from '../data/supports';
import {
  THR_AMMO,
  THR_CHARGE,
  THR_HEAT,
  TOWER_ARC,
  TOWER_AUTOCANNON,
  TOWER_LASER,
  TOWER_MAX_LEVEL,
  TOWER_MORTAR,
  TOWER_PD,
  TOWER_RAILGUN,
  type TowerDef,
  TOWERS,
  towerAoeDamage,
  towerArcDeg,
  towerBurst,
  towerChargeTime,
  towerDamage,
  towerFireInterval,
  towerRange,
} from '../data/towers';
import {
  CELL_WEAPON,
  cellIndexAtLocal,
  deckGridAtLocal,
  DECK_ROTATIONS,
  isPlaceSuccess,
  isWeldSuccess,
  PLACE_BAD_CONTENT,
  PLACE_BAD_SUPPORT,
  PLACE_BAD_TOWER,
  PLACE_INTERIOR,
  PLACE_MAX_LEVEL,
  PLACE_NO_CELL,
  PLACE_TAKEN,
  PLACE_UPGRADE,
  WELD_BAD_PIECE,
  WELD_BAD_ROTATION,
  WELD_DETACHED,
  WELD_OVERLAP,
} from '../sim/deck';
import type { Vec2 } from '../sim/ship';
import {
  OFFER_SUPPORT,
  OFFER_TOWER,
  OFFER_DECK,
  optionContent,
  optionLabel,
  optionSupportType,
  optionTowerType,
  UPGRADE_NO_OFFER,
  type UpgradeOption,
} from '../sim/upgrade';
import type { World } from '../sim/world';
import { audioBus } from '../render/audio';
import type { PlacementUiState } from '../render/renderer';

/**
 * 提示文字配色:与渲染层的高亮同色(合法 = 冷青蓝、拒绝 = 暖红),
 * 于是"格上闪一下"与"下面这行字"读起来是同一件事,而不是两条互不相干的反馈。
 * 冷色是我方色域(GDD §12);暖色只许出现在这一行短命的文字上,不铺成色块。
 */
const OK_COLOR = '#9adcff';
const DENY_COLOR = '#ff7a6b';
const IDLE_COLOR = '#5f7a99';
const VALUE_COLOR = '#c8dcf0';
/** 船体冷色废铁本色,与结算界面/旧提示条的边框同一个值 */
const LINE_COLOR = '#2b4a6e';

/**
 * 卡片面板:**贴屏幕底边、不铺满整屏**。这一条是硬约束不是审美 ——
 * index.html 里 `#ui > *` 把覆盖层的直接子元素设成 pointer-events:auto(卡片要能点),
 * 而放置阶段玩家必须能点到屏幕正中那块甲板:铺满整屏的面板会把每一次放置点击都吃掉。
 */
const PANEL_CSS =
  'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);display:none;' +
  'flex-direction:column;align-items:center;gap:10px;' +
  'font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;user-select:none;';

const HEAD_CSS = `color:${IDLE_COLOR};letter-spacing:.08em;`;
const CARDS_CSS = 'display:flex;gap:12px;justify-content:center;flex-wrap:wrap;';

/**
 * 一张卡。button 而不是 div:键盘能聚焦、回车能按,而"点了没反应"在时停里最难查。
 * font:inherit 不能省(button 不继承页面字体,否则卡片是系统黑体、面板是等宽,读起来像两套 UI)。
 * 定宽 + 左对齐:三张卡的标题/描述/等级要能横着对成三行,长短不一时眼睛才不必来回找。
 */
const CARD_CSS =
  'width:196px;padding:12px 14px;border-radius:8px;cursor:pointer;text-align:left;font:inherit;' +
  `background:rgba(10,16,26,.94);border:1px solid ${LINE_COLOR};color:${VALUE_COLOR};`;
const CARD_ICON_CSS =
  `color:${OK_COLOR};font-size:24px;line-height:1;text-align:center;margin-bottom:8px;` +
  'text-shadow:0 0 10px rgba(154,220,255,.42);';
const CARD_TITLE_CSS = `color:${OK_COLOR};font-size:15px;letter-spacing:.06em;margin-bottom:6px;`;
/** 描述行留常驻高度:三张卡的描述长短不一,不撑住的话等级行会参差成三个高度 */
const CARD_DESC_CSS = 'min-height:3.2em;';
const CARD_LEVEL_CSS = `color:${IDLE_COLOR};margin-top:6px;`;

const BTN_CSS =
  'padding:7px 18px;border-radius:6px;cursor:pointer;font:inherit;' +
  `border:1px solid ${LINE_COLOR};background:rgba(43,74,110,.28);color:${OK_COLOR};letter-spacing:.1em;`;

/**
 * 回执/拒绝提示条(左下角一行)。**pointer-events:none 是必须的**:它是 #ui 的直接子元素,
 * 不摘掉就会吃掉左下角那片区域的点击,而那片区域底下正是甲板可能飘过去的地方。
 * 它**独立于卡片面板**,故收卡之后仍然留在屏幕上 —— 那正是"叠级"唯一的回执:
 * 同名叠级不占新格(GDD §5.4),恢复战斗后画面上什么都没多出来,
 * 只有这行「自动机炮 升到 Lv3」能证明刚才那一下落成了什么。
 */
const TOAST_CSS =
  'position:fixed;left:12px;bottom:12px;padding:8px 12px;border-radius:6px;display:none;' +
  `background:rgba(5,7,13,.72);border:1px solid ${LINE_COLOR};` +
  'font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre;' +
  'pointer-events:none;user-select:none;';

/** 提示条的存留时长(ms)。同时也是渲染层那格红闪的时长:计时器只此一份,在 ui 这边 */
const FLASH_MS = 1400;

/** 甲板局部坐标暂存:模块级复用(照 sim/world.ts 的 desired 写法),鼠标移动不该按帧新建对象 */
const deckLocal: Vec2 = { x: 0, y: 0 };
const deckGrid = { col: 0, row: 0 };

// —— 流程阶段。三个值互斥,**没有第四种**:收着 / 选卡 / 放置 ——
const PHASE_OFF = 0;
const PHASE_PICK = 1;
const PHASE_PLACE = 2;

/**
 * 理由码 → 中文拒绝文案(自 ui/placement.ts 迁来)。规则少到不必做教学关(GDD §4.1),
 * 前提是**每次拒绝都当场把规则原文讲一遍**,所以文案里带上出处,
 * 而不是一句干巴巴的"不能放在这里"。
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
    // 型号一律来自 world.offer(sim/upgrade 的候选生成只挑数值表里存在的型),故正常点不出来;
    // 留着是为了候选生成哪天走岔时,拒绝的理由是"型号不对"而不是一句看不懂的码
    case PLACE_BAD_TOWER:
      return '没有这种塔型(数值表里查不到)';
    // 同上,设施型那一半。与 BAD_TOWER 分成两句话而不是合并成"型号不对":
    // 型号填错的是塔还是设施,得一眼看得出
    case PLACE_BAD_SUPPORT:
      return '没有这种支援设施(数值表里查不到)';
    // 本流程只会传武器塔/支援设施(optionContent 只产出这两种),故正常点不出来;
    // 留着是为了将来加内容类型时不至于静默兜底
    case PLACE_BAD_CONTENT:
      return '只能放武器塔或支援设施(MVP 没有拆除)';
    case WELD_OVERLAP:
      return '拼块与既有甲板重叠';
    case WELD_DETACHED:
      return '拼块必须贴住船体任意一条外边缘(GDD §4.4)';
    case WELD_BAD_PIECE:
      return '没有这种甲板拼块';
    case WELD_BAD_ROTATION:
      return '拼块旋转档无效';
    // 10 号 issue 新增的一档:卡还在屏幕上,World 那边的待选却已经没了
    //(重开了一局、或这一次升级已经被结算过)。它**不是**放置规则被撞上,
    // 故文案里不提甲板 —— 提了只会让玩家去找一个根本不存在的格子问题
    case UPGRADE_NO_OFFER:
      return '这一次升级已经不在了(卡片过期,已恢复战斗)';
    default:
      return `放置被拒绝(理由码 ${code})`;
  }
}

/**
 * 当前选的是什么 —— 武器塔报**塔名**、支援设施报**设施名**,两份名字都取自数值表,
 * ui 里不抄第二份(设施分四型,抄一份就等于埋一处会和数据表走散的文案)。
 * 型号越界一律报回原始下标而不是兜底成第 0 种:选错了要看得见,静默换成另一座塔/另一种设施才是真的坑。
 * 第三参缺省 = 弹药库,与 world.place / placeAt 的默认值同一个值(「弹药库先行」,GDD §4.3):
 * 漏传参数时的行为才与看得见的提示一致 —— 两处默认值分家的话,提示说的和真放下去的会是两种设施。
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
 * 卡片标题 = 候选的名字,**一律走 sim/upgrade 的 optionLabel**(它读的是数值表)。
 * 留着这层薄包装而不是让面板直接调 optionLabel:标题这一格将来要加前缀/后缀(11 号的 HUD)时
 * 只改这里,而"名字从哪来"这条规矩不会因为改版而被顺手绕过 —— ui 永远不抄第二份名字。
 */
export function cardTitle(opt: UpgradeOption): string {
  return optionLabel(opt);
}

/**
 * 无外部资产的卡片图标。型号仍然取 UpgradeOption.type(也就是数值表下标),不按卡名做字符串猜测:
 * 改名不会让图标走丢,塔/设施/拼块三套同编号也不会串台。每种内容各用一个简明的几何符号,
 * 即使系统没有彩色 emoji 字体也能稳定显示;未知型号显式报 ?,不静默冒充第 0 型。
 */
export function cardIcon(opt: UpgradeOption): string {
  if (opt.kind === OFFER_DECK) return DECK_PIECES[opt.type]?.icon ?? '?';
  if (opt.kind === OFFER_TOWER) {
    switch (optionTowerType(opt)) {
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
      default:
        return '?';
    }
  }
  switch (optionSupportType(opt)) {
    case SUP_AMMO_BAY:
      return '▦';
    case SUP_RADIATOR:
      return '≋';
    case SUP_CAPACITOR:
      return '⚡';
    case SUP_ARMOR_BAY:
      return '⬢';
    default:
      return '?';
  }
}

/**
 * 这一次拿到手会是几级(塔)。0(尚未拥有)与已满级(只能新建)都是**一座新的 Lv1 塔**,
 * 1..4 则是叠到下一级。卡片上的射程/射界照这个等级报 —— 报当前等级就是在描述玩家已有的东西,
 * 而这张卡承诺的是"点下去之后"。
 */
function grantedLevel(opt: UpgradeOption): number {
  if (opt.level >= 1 && opt.level < TOWER_MAX_LEVEL) return Math.floor(opt.level) + 1;
  return 1;
}

/**
 * 数值印成字符串:先四舍五入到两位小数再交给 String。
 * 数值表里写的是 1.25 / 0.7 这种两位数,但连乘与等级成长会带出浮点毛刺
 * (0.7000000000000001),原样印在卡片上就是一串没人看得懂的噪声。
 */
function num(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/** 节流系的名字(THR_*)。三档正是三种支援设施的作用锚点,故名字与编号都不许合并 */
function throttleName(throttle: number): string {
  switch (throttle) {
    case THR_AMMO:
      return '弹药系';
    case THR_HEAT:
      return '过热系';
    case THR_CHARGE:
      return '充能系';
    default:
      return `未知节流系(${throttle})`;
  }
}

/**
 * 节流系 + 它在手感上的那一句话(GDD §5.1 三选一的分水岭)。
 * 卡片上只写"弹药系"三个字等于没说 —— 玩家要判断的是"这座塔打起来是什么节奏",
 * 而三套机制的区别恰恰全在括号里那半句。
 */
function throttleDesc(throttle: number): string {
  switch (throttle) {
    case THR_AMMO:
      return '弹药系(打空要装填)';
    case THR_HEAT:
      return '过热系(贪连射会锁死)';
    case THR_CHARGE:
      return '充能系(攒满才放)';
    default:
      return throttleName(throttle);
  }
}

/**
 * 支援设施的一句话 = **把它数值表里那几项非中性的字段念出来**。
 * 中性值的口径与 data/supports.ts 一字同源(乘法档 1、加法档 0 = "这一档用不上"),
 * 于是把某一项调回中性,卡片上那一句自己就消失了 —— 不必回头改文案。
 * 装甲舱天然落在后两句上(它不作用于相邻塔),而那正是它与另外三种的区别所在。
 */
function supportDesc(def: SupportDef): string {
  const parts: string[] = [];
  // throttle < 0 = 不作用于任何相邻塔(SUPPORT_THR_NONE,只有装甲舱),
  // 此时连"相邻 X 系塔"这个前缀都不该出现 —— 出现了就是在承诺一个它做不到的事
  if (def.throttle >= 0) {
    const muls: string[] = [];
    if (def.fireRateMul !== 1) muls.push(`射速 ×${num(def.fireRateMul)}`);
    if (def.reloadMul !== 1) muls.push(`装填 ×${num(def.reloadMul)}`);
    if (def.heatMaxMul !== 1) muls.push(`热上限 ×${num(def.heatMaxMul)}`);
    if (def.chargeRateMul !== 1) muls.push(`充能 ×${num(def.chargeRateMul)}`);
    if (muls.length > 0) parts.push(`相邻${throttleName(def.throttle)}塔 ${muls.join(' / ')}`);
  }
  if (def.hullHp !== 0) parts.push(`船体 HP ${def.hullHp > 0 ? '+' : ''}${num(def.hullHp)}`);
  if (def.edgeDamageMul !== 1) parts.push(`所在舷受撞 ×${num(def.edgeDamageMul)}`);
  // 一项都没有 = 数值表把这一型的效果全调成中性了。**不许印成空串**:
  // 一张没有描述的卡看上去就是"渲染坏了",而实际上是数据表把它调成了一块砖
  return parts.length > 0 ? parts.join(' · ') : '这一型在数值表里没有任何效果';
}

/**
 * 表面 DPS(当前档现算)—— "伤害是随等级/加成一直在变的数"这条老顾虑的解法就是**现算不缓存**:
 * 卡片弹出那一刻按数值表 + 等级算一遍,升一级重算一遍,永远不会印出过期的数。
 * "表面" = 单目标持续输出的上限:含 Lv3 的多管跳变,不含装填/过热的停火窗与链跳/AoE 的
 * 群体收益 —— 那些是塔的**节奏与形状**,卡片上由节流系那半句与塔名承诺,数字只答"这座塔多重"。
 * 充能系没有 fireInterval,节奏在 chargeTime;迫击炮的伤害全在落点(def.damage 恒 0),取 AoE 档。
 */
export function towerDps(def: TowerDef, level: number): number {
  const dmg = def.damage > 0 ? towerDamage(def, level) : towerAoeDamage(def, level);
  const shots = towerBurst(def, level);
  if (def.throttle === THR_CHARGE) {
    const charge = towerChargeTime(def, level);
    return charge > 0 ? (dmg * shots) / charge : 0;
  }
  const interval = towerFireInterval(def, level);
  return interval > 0 ? (dmg * shots) / interval : 0;
}

/**
 * 塔卡片上的伤害读数。玩家最常见的抉择是"新建一座 vs 给旧的叠一级",
 * 而卡面此前刻意不报伤害 —— 两条路的强度无从比较,升级的期待感也就无从谈起。
 * 已有未满级的同型塔时报 `伤 X→Y/s`(这张卡承诺的正是那一级的跳变);
 * 新建(未装备/已满级)只报拿到手那一级的数。
 */
function dpsText(def: TowerDef, opt: UpgradeOption): string {
  const granted = grantedLevel(opt);
  if (opt.level >= 1 && opt.level < TOWER_MAX_LEVEL) {
    return `伤 ${num(towerDps(def, opt.level))}→${num(towerDps(def, granted))}/s`;
  }
  return `伤 ${num(towerDps(def, granted))}/s`;
}

/**
 * 卡片的一句话描述 —— **全部从数值表现生成**(见文件头:不给数值表加 desc 字段)。
 * 塔报"射界档 / 射程 / 表面 DPS / 节流系"四样(GDD §5.1 的四要素终于凑齐:
 * 伤害那一档由 towerDps 现算当前档,不再因为"它一直在变"而缺席)。
 * 射界只报数值表里那一档:角落格 +60°(GDD §4.2)是**格子**的属性,要等选了格才算得出来,
 * 写进卡片就成了一个对不上的数。
 * 型号越界不静默兜底(与 placeLabel 同一条口径):把下标印出来,免得玩家照着另一座塔的读数下判断。
 */
export function cardDesc(opt: UpgradeOption): string {
  if (opt.kind === OFFER_DECK) {
    const def = DECK_PIECES[opt.type];
    if (!def) return `数值表里查不到这种甲板拼块(型号 ${opt.type})`;
    const cells = deckPieceCellCount(opt.type);
    return `${cells} 格 · 可旋转 · 焊到任意外边缘 · 转向 -${cells}°/s`;
  }
  if (opt.kind === OFFER_TOWER) {
    const def = TOWERS[optionTowerType(opt)];
    if (!def) return `数值表里查不到这座塔(型号 ${opt.type})`;
    const lv = grantedLevel(opt);
    // 射程取整:它是像素距离,小数位对玩家没有任何意义(等级成长乘出来全是 399.00000000000006)
    return `射界 ${num(towerArcDeg(def, lv))}° · 射程 ${Math.round(towerRange(def, lv))} · ${dpsText(def, opt)} · ${throttleDesc(def.throttle)}`;
  }
  const def = SUPPORTS[optionSupportType(opt)];
  if (!def) return `数值表里查不到这种设施(型号 ${opt.type})`;
  return supportDesc(def);
}

/**
 * 卡片上的等级行。支援设施没有等级,明确说“不叠级/本次新建”;塔则三档各有各的话要说:
 *   0 = 甲板上还没有这一型;
 *   1..4 = 已有,点下去就是同名叠级(GDD §5.4,不占新格);
 *   满级 = 叠不动了,这张卡只能在别的格上**新建**一座 —— 不写清楚的话,
 *     玩家会照着"再点一次那座塔"的直觉去点,然后吃一记 PLACE_MAX_LEVEL。
 * `!(lv >= 1)` 而不是 `lv < 1`:**NaN 与任何数比较都是 false**,写成前者才把 NaN 一并接住
 * (与渲染层的 clamp01 同一条写法)。
 */
export function cardLevelText(opt: UpgradeOption): string {
  if (opt.kind === OFFER_DECK) return '确认即焊死 · 局内不可拆/不可挪';
  if (opt.kind === OFFER_SUPPORT) return '设施不叠级 · 本次新建';
  const lv = opt.level;
  if (!(lv >= 1)) return '未装备';
  if (lv >= TOWER_MAX_LEVEL) return `Lv${TOWER_MAX_LEVEL}(满级,只能新建)`;
  return `当前 Lv${Math.floor(lv)}`;
}

/**
 * 跳过这一次升级实际返还多少残骸 = cost − 手续费(畅玩性调整,语义见 data/economy)。
 * **与 World.skipUpgrade 调的是同一个 skipRefundFor**:两边分家时,玩家看到的返还数
 * 与到账数会各走各的,而这种差额要攒好几次才看得出来 —— 留这层薄包装只为 ui 侧
 * 的调用点(按钮文案/toast/测试)有个稳定的名字。
 */
export function skipRefund(cost: number): number {
  return skipRefundFor(cost);
}

/** 焦点在调参面板的输入框里:此时数字键/Esc 是在打字,不该被当成选卡/取消抢走 */
function isTyping(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

/**
 * 三选一升级流程的对外面孔。**它就是渲染层每帧读的那个 PlacementUiState**
 * (Object.assign 在同一个对象上长出这四个方法),于是 ui 就地改字段、渲染层只读,
 * 两边不必再约定通知通道。
 */
export interface UpgradeFlowUi extends PlacementUiState {
  /**
   * 换掉整局的 World(08 号 issue T3 的重开流程:一局从开始到胜负/重开全程不刷新页面)。
   * 接口名与语义与旧的 ui/placement.ts **一字不差**,08 号那条重开流程照旧调这一个。
   * 重开 = 换一个新 World(池、rng、tick、甲板全是新的,才谈得上"同 seed 可复现"),
   * 于是这条交互也必须跟着改指向 —— 忘了换,玩家在新船上点下去的每一格都会落进上一局那艘沉船里。
   */
  setWorld(world: World): void;
  /**
   * 按最后已知的鼠标位置重算悬停格。调用方每渲染帧调一次 —— 时停期间船是不动的,
   * 但**甲板放大有一段缓动**(见 renderer 的 setDeckZoom):只在 mousemove 里算的话,
   * 缓动那零点几秒里玩家看到的高亮框与点下去落的格不是同一个,而塔一放就不可移动、不可出售(GDD §4.5)。
   */
  syncHover(): void;
  /** 读 world.offer 弹卡(main.ts 在 onUpgradeOffer 里调,时停与放大也在那一侧) */
  show(): void;
  /** 收卡。**不恢复战斗、不动 loop** —— 那是 main.ts 的事(World 与 ui 都不认识"游戏流程") */
  hide(): void;
}

export interface UpgradeFlowOpts {
  world: World;
  canvas: HTMLCanvasElement;
  /**
   * 由渲染层提供(见 Renderer.screenToDeckLocal):画布像素 → **甲板局部坐标**,结果写进 out。
   * 不是 screenToWorld:甲板放大 30% 之后,世界坐标那条路算出来的格与画面上高亮的那一格差一截。
   */
  screenToDeckLocal(sx: number, sy: number, out: Vec2): Vec2;
  /** 结算完(放置成功 / 跳过 / 卡片过期)→ main 收放大、恢复战斗。本文件不认识 loop,也不动 run */
  onResolved(): void;
}

/** 一张卡的图标 + 三块文本节点。整局复用同一批元素,弹一次卡只改 textContent */
interface CardEls {
  root: HTMLButtonElement;
  icon: HTMLDivElement;
  title: HTMLDivElement;
  desc: HTMLDivElement;
  level: HTMLDivElement;
}

export function createUpgradeFlow(opts: UpgradeFlowOpts): UpgradeFlowUi {
  // world 是**可重赋的局部变量**而不是解构常量:重开一局要换掉整个 World(见 setWorld),
  // 而闭包里每处(pick / confirm / skip)都是现读它 —— 于是换引用这一件事就够了,
  // window 事件与面板 DOM 一行都不必重挂(重挂 = 每重开一局多一份监听器、多一块面板)。
  let world = opts.world;
  const { canvas, screenToDeckLocal, onResolved } = opts;

  const state: PlacementUiState = {
    active: false,
    content: CELL_WEAPON,
    // 起手值只是占位:真正的三个字段在选中卡片那一刻由候选填满(见 choose)。
    // 仍然取 world.place 的两个默认值(自动机炮 / 弹药库),漏填时的行为才与提示文案一致
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

  // —— DOM:两个直接子节点(卡片面板 + 左下角提示条),append 进 #ui 覆盖层,行内 style ——
  const panel = document.createElement('div');
  panel.style.cssText = PANEL_CSS;
  const headEl = document.createElement('div');
  headEl.style.cssText = HEAD_CSS;
  const cardsEl = document.createElement('div');
  cardsEl.style.cssText = CARDS_CSS;
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:10px;';
  const skipBtn = document.createElement('button');
  skipBtn.style.cssText = BTN_CSS;
  const backBtn = document.createElement('button');
  backBtn.style.cssText = BTN_CSS;
  backBtn.textContent = '重选(Esc / 右键)';
  const rotateBtn = document.createElement('button');
  rotateBtn.style.cssText = BTN_CSS;
  rotateBtn.textContent = '旋转(R)';
  btnRow.append(skipBtn, backBtn, rotateBtn);
  panel.append(headEl, cardsEl, btnRow);
  const toast = document.createElement('div');
  toast.style.cssText = TOAST_CSS;
  const ui = document.getElementById('ui')!;
  ui.appendChild(panel);
  ui.appendChild(toast);

  const cards: CardEls[] = [];
  let phase = PHASE_OFF;
  /** 已选中的候选在 world.offer 里的下标;-1 = 还没选。takeUpgrade 收的就是它 */
  let chosen = -1;
  let flashTimer = 0;
  // 最后已知的鼠标位置:选中卡片时立刻算一次悬停,不必等玩家先动一下鼠标
  let lastX = 0;
  let lastY = 0;

  /**
   * 建一张卡。**只在这里建**,建好就整局复用(弹卡只改 textContent)——
   * 每次弹卡重建 DOM 就等于每次都要重挂三个监听器,而它们最后都指向同一个下标。
   * 下标由闭包捕获:卡片的位置与 world.offer 的下标一一对应,点第二张就是 takeUpgrade(1, ...)。
   */
  function createCard(index: number): CardEls {
    const root = document.createElement('button');
    root.style.cssText = CARD_CSS;
    const icon = document.createElement('div');
    icon.style.cssText = CARD_ICON_CSS;
    const title = document.createElement('div');
    title.style.cssText = CARD_TITLE_CSS;
    const desc = document.createElement('div');
    desc.style.cssText = CARD_DESC_CSS;
    const level = document.createElement('div');
    level.style.cssText = CARD_LEVEL_CSS;
    root.append(icon, title, desc, level);
    root.addEventListener('click', () => choose(index));
    cardsEl.appendChild(root);
    return { root, icon, title, desc, level };
  }

  /**
   * 抹掉提示条并停掉它的计时器。退回选卡(cancel)与重开一局(setWorld)共用:
   * 留着的话,那行字要等超时才消 —— 而它说的是**上一张卡**(甚至上一局)的事。
   * **收卡(hide)刻意不调它**:放置成功那一句回执正是要留到战斗恢复之后才有意义(见 TOAST_CSS)。
   */
  function clearFlash(): void {
    if (flashTimer) window.clearTimeout(flashTimer);
    flashTimer = 0;
    toast.textContent = '';
    toast.style.display = 'none';
  }

  /** 闪一句话。连点时重置计时:上一次的超时不该把这一次的提示提前抹掉 */
  function flash(text: string, color: string): void {
    toast.textContent = text;
    toast.style.color = color;
    toast.style.display = 'block';
    if (flashTimer) window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => {
      flashTimer = 0;
      toast.textContent = '';
      toast.style.display = 'none';
      // 渲染层不持有计时器,那格红闪存留多久由这里说了算(见 PlacementUiState.denyIndex)
      state.denyIndex = -1;
      state.weldDenied = false;
    }, FLASH_MS);
  }

  /**
   * 屏幕坐标 → 甲板格下标(不在甲板上 -1)。
   * clientX/Y 减去画布左上角即得画布像素:resolution=1 + resizeTo=window,CSS 尺寸与像素尺寸 1:1。
   * rect 每次现取而不缓存 —— 窗口缩放/滚动都会让它过期,而这里是每帧几次的调用,不是热循环。
   * 换算与取格**全走渲染层 + sim 那两份**(screenToDeckLocal / cellIndexAtLocal):
   * 时停期间甲板还在做放大缓动,自己算一份必然与画面上的高亮框对不上。
   */
  function pick(clientX: number, clientY: number): number {
    const rect = canvas.getBoundingClientRect();
    const p = screenToDeckLocal(clientX - rect.left, clientY - rect.top, deckLocal);
    return cellIndexAtLocal(world.deck, p.x, p.y);
  }

  function pickGrid(clientX: number, clientY: number): void {
    const rect = canvas.getBoundingClientRect();
    const p = screenToDeckLocal(clientX - rect.left, clientY - rect.top, deckLocal);
    deckGridAtLocal(world.deck, p.x, p.y, deckGrid);
    if (deckGrid.col !== state.hoverCol || deckGrid.row !== state.hoverRow) {
      // 拒绝红闪只钉住刚才点下去的锚点；移到另一格后重新按当前 sim 判据显示绿/红。
      state.weldDenied = false;
    }
    state.hoverCol = deckGrid.col;
    state.hoverRow = deckGrid.row;
  }

  /** 按当前阶段刷面板:选卡阶段露卡片 + 跳过,放置阶段露一行提示 + 重选 */
  function syncPanel(): void {
    if (phase === PHASE_PICK) {
      const cost = world.upgradeCost;
      // 三个数一行念完:残骸是"我有多少"、花费是"这一下扣多少"——
      // 少了它们,玩家永远不知道自己下一张卡还要攒多久(11 号的 HUD 会接手这条读数)
      headEl.textContent = `三选一升级 · 残骸 ${Math.round(world.scrap)} · 本次花费 ${cost}`;
      cardsEl.style.display = 'flex';
      skipBtn.style.display = 'block';
      backBtn.style.display = 'none';
      rotateBtn.style.display = 'none';
      return;
    }
    if (state.weldPieceType >= 0) {
      const name = DECK_PIECES[state.weldPieceType]?.name ?? `未知甲板拼块(${state.weldPieceType})`;
      headEl.textContent = `焊接:${name} · 旋转 ${state.weldRotation * 90}° —— R 旋转，点绿色 ghost 确认`;
      rotateBtn.style.display = 'block';
    } else {
      headEl.textContent = `放置:${placeLabel(state.content, state.towerType, state.supportType)} —— 点甲板上高亮的格确认`;
      rotateBtn.style.display = 'none';
    }
    cardsEl.style.display = 'none';
    skipBtn.style.display = 'none';
    backBtn.style.display = 'block';
  }

  /** 把 world.offer 摊到卡片上。元素复用,多出来的藏起来(offer 可能不足三张:甲板快满时) */
  function renderCards(): void {
    const offer = world.offer;
    // 按需补卡:数量以 world.offer 为准,不去读 UPGRADE_CHOICE_COUNT ——
    // 候选数是 sim 那边的事,ui 照着一个常量摆卡就等于埋一处"数值表调了、面板没跟上"
    for (let i = cards.length; i < offer.length; i++) cards.push(createCard(i));
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i]!;
      const opt = offer[i];
      if (!opt) {
        card.root.style.display = 'none';
        continue;
      }
      card.root.style.display = 'block';
      card.icon.textContent = cardIcon(opt);
      card.title.textContent = cardTitle(opt);
      card.desc.textContent = cardDesc(opt);
      card.level.textContent = cardLevelText(opt);
    }
    skipBtn.textContent = `跳过(手续费 ${UPGRADE_SKIP_FEE} · 返还 ${skipRefund(world.upgradeCost)})`;
  }

  function hide(): void {
    phase = PHASE_OFF;
    chosen = -1;
    // 高亮层一并熄掉:留着 active 的话,恢复战斗后甲板上会一直挂着一圈"能放这里"的框
    state.active = false;
    state.weldPieceType = -1;
    state.weldRotation = 0;
    state.weldDenied = false;
    state.hoverIndex = -1;
    state.denyIndex = -1;
    state.moveSourceIndex = -1;
    panel.style.display = 'none';
  }

  /**
   * 这一次升级结算完了(放置成功 / 跳过 / 卡片过期)。
   * 先收面板再回调:main 那边也会 hide 一次(恢复战斗流程的一步),但"结算完就该消失"
   * 不该依赖调用方记得那一句(与 ui/gameOver.ts 的 restart 同一条口径)。
   * 提示条**不清**:那行回执要留到战斗恢复之后才读得到(见 clearFlash)。
   */
  function resolve(): void {
    hide();
    onResolved();
  }

  /**
   * 选中一张卡 → 进放置阶段。**这一刻不扣任何费**:扣费在 world.takeUpgrade 里,
   * 与"真的放下去了"是同一件事 —— 否则退回选卡(cancel)就得有一条退款路径,
   * 而每多一条钱的路径,"12–15 次升级"那条平衡口径就多一个对不上的地方。
   */
  function choose(index: number): void {
    if (phase !== PHASE_PICK) return;
    const opt = world.offer[index];
    // 越界/空卡:候选比卡片少时那张卡本就是藏起来的,这一句是拦网
    if (!opt) return;
    chosen = index;
    // 三个字段照候选原样填,ui 不在这里分岔 —— 渲染层的合法格高亮读的就是它们,
    // 与 world.takeUpgrade 最终交给 place 的是同一套值(高亮 = 规则,03 号立下的口径)
    state.content = optionContent(opt);
    state.towerType = optionTowerType(opt);
    state.supportType = optionSupportType(opt);
    state.weldPieceType = opt.kind === OFFER_DECK ? opt.type : -1;
    state.weldRotation = 0;
    state.weldDenied = false;
    state.active = true;
    state.denyIndex = -1;
    state.moveSourceIndex = -1;
    if (state.weldPieceType >= 0) pickGrid(lastX, lastY);
    else state.hoverIndex = pick(lastX, lastY);
    phase = PHASE_PLACE;
    clearFlash();
    syncPanel();
  }

  /**
   * 退回选卡(Esc / 右键 / 「重选」)。**不扣费、不恢复战斗**:
   * 时停要一直停到这一次升级真的结算掉为止,否则"重选"就成了一条免费的暂停。
   */
  function cancel(): void {
    if (phase !== PHASE_PLACE) return;
    chosen = -1;
    state.active = false;
    state.weldPieceType = -1;
    state.weldRotation = 0;
    state.weldDenied = false;
    state.hoverIndex = -1;
    state.denyIndex = -1;
    state.moveSourceIndex = -1;
    phase = PHASE_PICK;
    // 上一条拒绝文案说的是刚才那张卡的事,退回来就不该再挂着
    clearFlash();
    syncPanel();
  }

  /** 点甲板确认放置。合法性一律以 sim 的答复为准:ui 这边绝不预判(预判就是第二份会走散的规则) */
  function confirm(clientX: number, clientY: number): void {
    if (state.weldPieceType >= 0) {
      pickGrid(clientX, clientY);
      const code = world.takeUpgrade(
        chosen,
        state.hoverCol,
        state.hoverRow,
        state.weldRotation,
      );
      if (isWeldSuccess(code)) {
        state.weldDenied = false;
        const name = DECK_PIECES[state.weldPieceType]?.name ?? `甲板拼块(${state.weldPieceType})`;
        flash(`已焊接:${name} · 转向 ${world.turnRate}°/s`, OK_COLOR);
        audioBus.playPlace();
        resolve();
        return;
      }
      if (code === UPGRADE_NO_OFFER) {
        flash(denyMessage(code), DENY_COLOR);
        resolve();
        return;
      }
      state.weldDenied = true;
      flash(denyMessage(code), DENY_COLOR);
      return;
    }
    const i = pick(clientX, clientY);
    const cell = i >= 0 ? world.deck.cells[i] : undefined;
    if (!cell) {
      // 拾取这一步已经答出"这里不是甲板格",不必再编一对 col/row 去 sim 兜一圈。
      // denyIndex 保持 -1:没有格子可闪,反馈只剩这行文案
      state.denyIndex = -1;
      flash(denyMessage(PLACE_NO_CELL), DENY_COLOR);
      return;
    }
    const code = world.takeUpgrade(chosen, cell.col, cell.row);
    // 成功有两种(新放 PLACE_OK / 叠级 PLACE_UPGRADE),故判定走 isPlaceSuccess 而不是 === PLACE_OK:
    // 把码逐个列在 ui 这边,迟早会漏掉后加的那一个,然后一次成功的升级会被当成拒绝闪红
    if (isPlaceSuccess(code)) {
      state.denyIndex = -1;
      // 等级现读那一格(takeUpgrade 里的 place 已经写完):ui 不自己推"应该升到几级",
      // 省得与 sim 的夹取规则走散
      let text = placedMessage(code, placeLabel(state.content, state.towerType, state.supportType), cell.level);
      // 叠级的回执带上伤害变化量(畅玩性调整):同名叠级不占新格,恢复战斗后画面上什么都没
      // 多出来 —— 这行 toast 是"这次升级让我变强了多少"唯一的可比读数,只报名字等于没报
      if (code === PLACE_UPGRADE && state.content === CELL_WEAPON) {
        const def = TOWERS[state.towerType];
        if (def) text += ` · 伤 ${num(towerDps(def, cell.level - 1))}→${num(towerDps(def, cell.level))}/s`;
      }
      flash(text, OK_COLOR);
      audioBus.playPlace();
      resolve();
      return;
    }
    if (code === UPGRADE_NO_OFFER) {
      // 待选没了(重开、或这一次升级已被别处结算掉):留在放置阶段就是个永远确认不了的死局 ——
      // 唯一不把玩家卡在时停里的做法是说清楚并放行。**它不是一次"放置被拒"**,故不闪格子
      state.denyIndex = -1;
      flash(denyMessage(code), DENY_COLOR);
      resolve();
      return;
    }
    // 非法格:闪红 + 说人话,**一分钱不扣、一帧不恢复**(验收标准:非法格不可确认放置)。
    // 玩家还站在放置阶段里,可以换一格,也可以 Esc 退回去换一张卡
    state.denyIndex = i;
    flash(denyMessage(code), DENY_COLOR);
  }

  /**
   * 跳过这一次升级(手续费制,见 data/economy 的 UPGRADE_SKIP_FEE)。**照样是一次结算** ——
   * World 那边会扣费、按 cost − 手续费返还、upgrades++、清空 offer,
   * 于是下一帧不会再弹同一张卡,而下一档的三张是全新候选(= 付费重随)。
   */
  function skip(): void {
    if (phase !== PHASE_PICK) return;
    const refund = skipRefund(world.upgradeCost);
    if (world.skipUpgrade()) flash(`跳过这次升级 —— 手续费 ${UPGRADE_SKIP_FEE},返还 ${refund} 残骸`, OK_COLOR);
    // 无待选(理论上这张卡根本不该在屏幕上)也照样放行:留在这儿就是个点什么都没用的面板
    else flash(denyMessage(UPGRADE_NO_OFFER), DENY_COLOR);
    resolve();
  }

  skipBtn.addEventListener('click', skip);
  backBtn.addEventListener('click', cancel);
  function rotate(): void {
    if (phase !== PHASE_PLACE || state.weldPieceType < 0) return;
    state.weldRotation = (state.weldRotation + 1) % DECK_ROTATIONS;
    state.weldDenied = false;
    pickGrid(lastX, lastY);
    syncPanel();
  }
  rotateBtn.addEventListener('click', rotate);

  window.addEventListener('keydown', (e) => {
    // 收着的时候一律不认:战斗中按 Esc/数字键不该动到升级流程
    if (phase === PHASE_OFF || e.repeat || isTyping()) return;
    if (e.code === 'Escape') {
      cancel();
      return;
    }
    if (e.code === 'KeyR') {
      rotate();
      return;
    }
    // 数字键直选卡片(1..N = 从左到右)。只认主键盘的 DigitN:小键盘在这种低频操作上
    // 不值得再养一条分支。放置阶段不认数字键 —— 那时该点的是格子,不是卡
    if (phase !== PHASE_PICK || !e.code.startsWith('Digit')) return;
    const n = Number(e.code.slice(5));
    if (Number.isInteger(n) && n >= 1) choose(n - 1);
  });

  // 移动听 window:指针挪到调参面板上时悬停格不该冻在原地(甲板还在那底下)。
  // 点击只听 canvas —— 点面板、点卡片不该往甲板上放东西
  window.addEventListener('mousemove', (e) => {
    lastX = e.clientX;
    lastY = e.clientY;
    if (state.active) {
      if (state.weldPieceType >= 0) pickGrid(lastX, lastY);
      else state.hoverIndex = pick(lastX, lastY);
    }
  });

  canvas.addEventListener('click', (e) => {
    // 选卡阶段点画布一律不算数:那时还没决定放什么,一次误点不该变成一座放错格的塔
    if (phase !== PHASE_PLACE) return;
    lastX = e.clientX;
    lastY = e.clientY;
    confirm(e.clientX, e.clientY);
  });

  // 右键取消 = 放置类交互的通用手势。**卡片一弹出来就挡掉浏览器菜单**(不止放置阶段):
  // 时停期间那张系统菜单会盖在甲板上,收掉它之前玩家什么都点不了,而世界是停着的 ——
  // 看上去就像"游戏卡死在一张右键菜单上"。战斗中(PHASE_OFF)则一律不管,右键仍归浏览器
  canvas.addEventListener('contextmenu', (e) => {
    if (phase === PHASE_OFF) return;
    e.preventDefault();
    cancel();
  });

  return Object.assign(state, {
    show(): void {
      // 没有待选却被弹起来(World 只在真的生成了候选时才响 onUpgradeOffer,这一句是拦网):
      // 空面板会把玩家永久卡在时停里,故当场说清楚并放行
      if (world.offer.length === 0) {
        flash(denyMessage(UPGRADE_NO_OFFER), DENY_COLOR);
        resolve();
        return;
      }
      phase = PHASE_PICK;
      chosen = -1;
      // 选卡阶段**不高亮**:还没决定放什么,"哪些格合法"这个问题根本还没有答案
      state.active = false;
      state.weldPieceType = -1;
      state.weldRotation = 0;
      state.weldDenied = false;
      state.hoverIndex = -1;
      state.denyIndex = -1;
      state.moveSourceIndex = -1;
      renderCards();
      syncPanel();
      panel.style.display = 'flex';
      // 三选一弹卡那一刻的"弹出"音;空 offer 的早退路径在上面已 return,不会走到这
      audioBus.playUpgrade();
    },
    hide,
    syncHover(): void {
      if (!state.active) return;
      if (state.weldPieceType >= 0) pickGrid(lastX, lastY);
      else state.hoverIndex = pick(lastX, lastY);
    },
    setWorld(next: World): void {
      world = next;
      // 面板整个收掉、阶段回到"收着":offer 是**上一局**的候选、chosen 是它的下标 ——
      // 留着就会拿新世界的 offer 去兑上一局的选择,或者对着一张空 offer 点确认。
      // 这与旧 ui/placement.ts 的 setWorld 刻意不同:那时的 active 是玩家自己按 B 拨的开关
      //(重开不该替他改),这里的 active 是"正在放一张卡"这个流程阶段,换一局就没有了。
      // **不调 onResolved**:恢复战斗是 main.ts 重开流程自己的一步(run.paused / 甲板缩放都在那边),
      // 这里替它调一次,反而会在装配到一半时把上一局的收尾动作跑出来
      hide();
      // 上一局最后那条提示(连同它的超时)一并抹掉:新船开出去的第一眼不该挂着上一局的回执
      clearFlash();
    },
  });
}
