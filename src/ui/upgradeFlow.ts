/**
 * 三选一升级流程 —— DOM 覆盖层(10 号 issue T4 改版),**永不 import pixi**(铁律 1 的另一半)。
 *
 * —— 甲板删除后的重写(用户设计会)——
 * 旧版「选卡 → 甲板放置」的两阶段状态机随甲板网格整段删除,现在是**点卡即结算**的单阶段流程:
 *   弹卡(读 world.offer,3 张)→ 点一张 → world.takeUpgrade 当场结算 → resolve()(收卡、恢复战斗在 main.ts)。
 * 唯一子阶段是「换槽」:武器槽全满时点新武器卡,takeUpgrade 返回 ACQUIRE_REPLACE_NEEDED,弹替换
 * 选择层列出当前 4 槽 → 点某一槽 → **带着槽位再调一次 takeUpgrade(choice, slotIndex)** —— world.ts
 * 的文档口径:替换由 takeUpgrade 内部走 replaceWeapon 并在那一次完成结算,这里绝不直接调
 * replaceWeapon(否则 completeUpgrade 不跑,同一张卡下一帧当场再弹)。替换层 Esc / 右键 / 「返回
 * 重选」只退回选卡(不扣费、不恢复战斗);选卡阶段唯一的出口是「跳过」(world.skipUpgrade);另有
 * 「重摇」(16 号)花 REROLL_PRICE 星币换一手牌,失败由返回码裁决,置灰只是"看就知道不行"。
 * **没有"什么都不选直接关掉"这条路**:费用是"这一次升级"本身,不消费的话 World 下一帧照样满足
 * scrap ≥ upgradeCost,当场再弹同一张卡。支援槽满(SUPPORT_FULL)是唯一"点卡但不结算"的拒绝:卡还在。
 *
 * 卡片上的名称 / 一句话描述 / 当前等级**一律从数值表现生成**(改数据文件即可调平衡,05 号验收),
 * 不给 data/towers、data/supports、data/edicts 加 desc 字段。
 *
 * 对外契约(改版后最小化):opts = `{ world, onResolved }`,接口 = show / hide / setWorld。main.ts 一侧
 * **不再有 setPlacement / syncHover / 画布拾格** —— 渲染层的 PlacementUiState 与本文件再无瓜葛;
 * 费用读数分两形态:玩家模式标题只写「世界已暂停 · 三选一」(残骸数由 HUD 管),?debug 时(与 main.ts
 * 同一条 URL 判定)才印 残骸/花费。
 */
import { REROLL_PRICE, skipRefundFor, UPGRADE_SKIP_FEE } from '../data/economy';
import { type EdictDef, edictLevel, EDICT_MAX_LEVEL, EDICTS, EDICT_THR_NONE } from '../data/edicts';
import { mergeResultOf } from '../data/merges';
import { THR_AMMO, THR_CHARGE, THR_HEAT, TOWER_MAX_LEVEL, type TowerDef, TOWERS, towerAoeDamage, towerArcDeg, towerBurst, towerChargeTime, towerDamage, towerFireInterval, towerRange } from '../data/towers';
import { WEAPON_SLOT_COUNT } from '../sim/armory';
import { OFFER_EDICT, OFFER_NEW_WEAPON, OFFER_WEAPON_UPGRADE, optionLabel, UPGRADE_NO_OFFER, type UpgradeOption } from '../sim/upgrade';
import { ACQUIRE_INVALID_TYPE, ACQUIRE_REPLACE_NEEDED, EDICT_INVALID_TYPE, EDICT_MAXED, REROLL_ALREADY_DONE, REROLL_NO_STARCOINS, REPLACE_BAD_SLOT, REPLACE_INVALID_TYPE, type World } from '../sim/world';
import { audioBus } from '../render/audio';

// 提示文字配色:成功 = 冷青蓝、拒绝 = 暖红(与渲染层高亮同色;冷色是我方色域,GDD §12)
const OK_COLOR = '#9adcff';
const DENY_COLOR = '#ff7a6b';
const IDLE_COLOR = '#5f7a99';
const VALUE_COLOR = '#c8dcf0';
const LINE_COLOR = '#2b4a6e'; // 船体冷色废铁本色,与结算界面/旧提示条的边框同一个值

// 卡片面板:贴屏幕底边、不铺满整屏(index.html 里 `#ui > *` 直接子元素 pointer-events:auto)
const PANEL_CSS =
  'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);display:none;' +
  'flex-direction:column;align-items:center;gap:10px;' +
  'font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;user-select:none;';
const HEAD_CSS = `color:${IDLE_COLOR};letter-spacing:.08em;`;
const CARDS_CSS = 'display:flex;gap:12px;justify-content:center;flex-wrap:wrap;';
// 一张卡。button 而不是 div:键盘能聚焦、回车能按,而"点了没反应"在时停里最难查
const CARD_CSS =
  'width:196px;padding:12px 14px;border-radius:8px;cursor:pointer;text-align:left;font:inherit;' +
  `background:rgba(10,16,26,.94);border:1px solid ${LINE_COLOR};color:${VALUE_COLOR};`;
const CARD_ICON_CSS =
  `color:${OK_COLOR};font-size:24px;line-height:1;text-align:center;margin-bottom:8px;` +
  'text-shadow:0 0 10px rgba(154,220,255,.42);';
const CARD_TITLE_CSS = `color:${OK_COLOR};font-size:15px;letter-spacing:.06em;margin-bottom:6px;`;
const CARD_DESC_CSS = 'min-height:3.2em;'; // 描述行留常驻高度:三张卡长短不一,不撑住则等级行参差
const CARD_LEVEL_CSS = `color:${IDLE_COLOR};margin-top:6px;`;
const BTN_CSS =
  'padding:7px 18px;border-radius:6px;cursor:pointer;font:inherit;' +
  `border:1px solid ${LINE_COLOR};background:rgba(43,74,110,.28);color:${OK_COLOR};letter-spacing:.1em;`;
// 换槽选择层(武器槽全满时的替换子阶段):居中列出当前 4 槽 + 返回按钮,盖在卡片面板上方
const PICKER_CSS =
  'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);display:none;' +
  'flex-direction:column;align-items:center;gap:10px;padding:16px 18px;border-radius:10px;' +
  `background:rgba(10,16,26,.96);border:1px solid ${LINE_COLOR};z-index:2;` +
  'font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;user-select:none;';
const SLOT_CSS =
  'width:210px;padding:9px 14px;border-radius:6px;cursor:pointer;text-align:left;font:inherit;' +
  `border:1px solid ${LINE_COLOR};background:rgba(43,74,110,.28);color:${VALUE_COLOR};`;
// 回执/拒绝提示条(左下角一行)。**pointer-events:none 是必须的**:它是 #ui 直接子元素,不摘掉会吃掉点击
const TOAST_CSS =
  'position:fixed;left:12px;bottom:12px;padding:8px 12px;border-radius:6px;display:none;' +
  `background:rgba(5,7,13,.72);border:1px solid ${LINE_COLOR};` +
  'font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre;' +
  'pointer-events:none;user-select:none;';
const FLASH_MS = 1400; // 提示条存留时长(ms)

/**
 * 玩家模式不印残骸/花费(残骸数由 HUD 管);与 main.ts 同一条 ?debug 判定。
 * `typeof location !== 'undefined'` 那一手是给 Node 端的调用方兜底:本模块的**纯函数部分**
 * (edictDesc / cardDesc / denyMessage)被 ui/refitFlow.ts 复用,而那边的单测跑在无 DOM 的
 * Node 环境里 —— 模块级裸读 location 会让整个文件在 import 那一刻就炸,
 * 而它想要的只是两句文案。
 */
const DEBUG = typeof location !== 'undefined' && location.search.includes('debug');

// —— 流程阶段。三个值互斥:**收着 / 选卡 / 换槽** ——
const PHASE_OFF = 0;
const PHASE_PICK = 1;
const PHASE_REPLACE = 2;

/** 理由码 → 中文拒绝文案。独立成纯函数、不碰 DOM,于是能在 Node 里单测:漏码会静默退化成兜底串 */
const DENY_MSGS: Record<number, string> = {
  [UPGRADE_NO_OFFER]: '这一次升级已经不在了(卡片过期,已恢复战斗)',
  [EDICT_MAXED]: `这条法令已经满层(${EDICT_MAX_LEVEL} 层封顶)—— 换一张或跳过`,
  [ACQUIRE_REPLACE_NEEDED]: '武器槽已满 —— 从替换层选一个槽,换下旧武器',
  [REPLACE_BAD_SLOT]: '这个槽不能替换(下标越界或空槽)',
  [ACQUIRE_INVALID_TYPE]: '没有这种塔型(数值表里查不到)',
  [REPLACE_INVALID_TYPE]: '没有这种塔型(数值表里查不到)',
  [EDICT_INVALID_TYPE]: '没有这条法令(数值表里查不到)',
  [REROLL_NO_STARCOINS]: `星币不足(重摇需要 ${REROLL_PRICE})`,
  [REROLL_ALREADY_DONE]: '本档已经摇过一次,不能再摇',
};

export function denyMessage(code: number): string {
  return DENY_MSGS[code] ?? `升级被拒绝(理由码 ${code})`;
}

/** 卡片标题 = 候选的名字,**一律走 sim/upgrade 的 optionLabel**(它读的是数值表),ui 不抄第二份 */
export function cardTitle(opt: UpgradeOption): string {
  return optionLabel(opt);
}

// 无外部资产的卡片图标:型号 = 数值表下标 → 几何符号,改名不会让图标走丢;未知型号显式报 ?。
// 两套符号各自独立(下标互不相干),按 data/towers(TOWER_*)与 data/edicts(EDICT_*)的编号排列;
// TOWER_ICONS 里 6..11 是合成塔(卡池不进,恒空位)。
// EDICT_ICONS 十条:弹药/散热/电容/装甲/增幅/磁力/重心/巡航/星图/超载
const TOWER_ICONS: string[] = ['▰', '◇', 'ϟ', '➠', '✣', '◉', '', '', '', '', '', '', '♁'];
const EDICT_ICONS: string[] = ['▦', '≋', '⚡', '⬢', '✚', '◈', '⟲', '➤', '✧', '≫'];

function kindIcon(list: string[], type: number): string {
  return list[type] || '?';
}

export function cardIcon(opt: UpgradeOption): string {
  if (opt.kind === OFFER_NEW_WEAPON || opt.kind === OFFER_WEAPON_UPGRADE) return kindIcon(TOWER_ICONS, opt.type);
  return kindIcon(EDICT_ICONS, opt.type);
}

/** 数值印成字符串:先四舍五入到两位小数再交给 String(连乘会带出浮点毛刺,原样印是噪声) */
function num(v: number): string {
  return String(Math.round(v * 100) / 100);
}

// 节流系的名字与手感一句话(THR_*;三档正是三条系限定法令的作用锚点,故编号与语义都不许合并)
const THROTTLE_NAMES = ['弹药系', '过热系', '充能系'];
const THROTTLE_DESCS = ['弹药系(打空要装填)', '过热系(贪连射会锁死)', '充能系(攒满才放)'];

function throttleName(throttle: number): string {
  return THROTTLE_NAMES[throttle] ?? `未知节流系(${throttle})`;
}

function throttleDesc(throttle: number): string {
  return THROTTLE_DESCS[throttle] ?? throttleName(throttle);
}

/**
 * 法令卡的一句话 = **念数值表里那几项非中性的字段**(船坞商店的法令卡也念它,见 refitFlow —— 
 * 同一张表两处各念一遍必然走散)(乘法档 1、加法档 0 = "这档用不上",
 * 调回中性那一句自己就消失)。法令是**全船被动**:作用系限定(throttle ≥ 0)的前缀读作
 * 「全船 X 系」;船体/经济/机动那几条(EDICT_THR_NONE)不作用于特定系,落在无前缀那几句。
 *
 * 念的是**一层的效果**而不是"当前总量":卡片上写的是"点下去会多出什么",
 * 而"已经叠到几层"由 cardLevelText 那一行单独报(「散热协议 ×2 → ×3」)—— 两件事分开说,
 * 玩家才不会把"这条法令有多强"和"这一张卡给多少"看混。
 */
export function edictDesc(def: EdictDef): string {
  const parts: string[] = [];
  if (def.throttle !== EDICT_THR_NONE) {
    const muls: string[] = [];
    if (def.fireRateMul !== 1) muls.push(`射速 ×${num(def.fireRateMul)}`);
    if (def.reloadMul !== 1) muls.push(`装填 ×${num(def.reloadMul)}`);
    if (def.heatMaxMul !== 1) muls.push(`热上限 ×${num(def.heatMaxMul)}`);
    if (def.chargeRateMul !== 1) muls.push(`充能 ×${num(def.chargeRateMul)}`);
    if (muls.length > 0) parts.push(`全船${throttleName(def.throttle)} ${muls.join(' / ')}`);
  }
  if (def.damageMul !== 1) parts.push(`全武器伤害 ×${num(def.damageMul)}`);
  if (def.hullHpAdd !== 0) parts.push(`船体 HP ${def.hullHpAdd > 0 ? '+' : ''}${num(def.hullHpAdd)}`);
  if (def.damageTakenMul !== 1) parts.push(`受击 ×${num(def.damageTakenMul)}`);
  if (def.xpMul !== 1) parts.push(`经验 ×${num(def.xpMul)}`);
  if (def.magnetRadiusMul !== 1) parts.push(`磁吸半径 ×${num(def.magnetRadiusMul)}`);
  if (def.turnRateAdd !== 0) {
    parts.push(`转向 ${def.turnRateAdd > 0 ? '+' : ''}${num(def.turnRateAdd)}°/s`);
  }
  if (def.cruiseSpeedMul !== 1) parts.push(`巡航速度 ×${num(def.cruiseSpeedMul)}`);
  if (def.starCoinChanceAdd !== 0) {
    parts.push(`星币概率 ${def.starCoinChanceAdd > 0 ? '+' : ''}${num(def.starCoinChanceAdd * 100)}%`);
  }
  // 一项都没有 = 数值表把这一条的效果全调成中性了。**不许印成空串**
  return parts.length > 0 ? parts.join(' · ') : '这一条在数值表里没有任何效果';
}

/**
 * 表面 DPS(当前档现算):卡片弹出那一刻按数值表 + 等级算一遍,升一级重算一遍,不印过期的数。
 * "表面" = 单目标持续输出的上限,不含装填/过热的停火窗与链跳/AoE 的群体收益;充能系节奏在
 * chargeTime;迫击炮的伤害全在落点(def.damage 恒 0),取 AoE 档。
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

/** 塔卡片上的伤害读数:升级报 `伤 X→Y/s`(这张卡承诺的正是那一级的跳变),新建只报拿到手那一级 */
function dpsText(def: TowerDef, fromLevel: number, toLevel: number): string {
  if (fromLevel >= 1 && toLevel > fromLevel) {
    return `伤 ${num(towerDps(def, fromLevel))}→${num(towerDps(def, toLevel))}/s`;
  }
  return `伤 ${num(towerDps(def, toLevel))}/s`;
}

/** 新武器卡实际到手会是几级 = 存档级 + 1(未存过 = Lv1),夹在 TOWER_MAX_LEVEL 上(与 acquireWeapon 同一份算式) */
function newWeaponGranted(world: World, opt: UpgradeOption): number {
  const banked = world.weaponBankedLevels[opt.type] ?? 0;
  return Math.min(TOWER_MAX_LEVEL, 1 + banked);
}

/**
 * 卡片的一句话描述 —— **全部从数值表现生成**(见文件头)。塔(新武器/武器升级)报
 * "射界档 / 射程 / 表面 DPS / 节流系"四样,升级卡再报 X→Y 跳变;法令念数值表里非中性的字段。
 * world 只在读新武器的存档级时用到。
 */
export function cardDesc(opt: UpgradeOption, world?: World): string {
  if (opt.kind === OFFER_NEW_WEAPON) {
    const def = TOWERS[opt.type];
    if (!def) return `数值表里查不到这座塔(型号 ${opt.type})`;
    const lv = world ? newWeaponGranted(world, opt) : 1;
    return `射界 ${num(towerArcDeg(def, lv))}° · 射程 ${Math.round(towerRange(def, lv))} · ${dpsText(def, 0, lv)} · ${throttleDesc(def.throttle)}`;
  }
  if (opt.kind === OFFER_WEAPON_UPGRADE) {
    const def = TOWERS[opt.type];
    if (!def) return `数值表里查不到这座塔(型号 ${opt.type})`;
    const lv = opt.level;
    if (lv >= TOWER_MAX_LEVEL) return `当前 Lv${TOWER_MAX_LEVEL}(满级) · 点这张卡不再涨级`;
    if (lv >= 1) return `当前 Lv${Math.floor(lv)} → Lv${Math.floor(lv) + 1} · ${dpsText(def, lv, lv + 1)}`;
    // 未拥有:level = 存档等级(opt.level 口径见 upgrade.ts),点了存到 lv+1,获得时兑现
    return `未持有 · 等级存档 Lv${Math.max(1, lv + 1)}(获得时生效)`;
  }
  const def = EDICTS[opt.type];
  if (!def) return `数值表里查不到这条法令(型号 ${opt.type})`;
  return edictDesc(def);
}

/**
 * 卡片上的等级行。三类各有各的话要说:新武器报"拿到手从几级起步"(存档级 + 1),
 * 已有同型再挂一句"第 N 把 · 三把合成"(那是合成的唯一入口,不写清楚玩家不会知道重复有用);
 * 武器升级已拥有 = 当前级、未拥有 = 存档等级;
 * 法令报**当前层 → 下一层**(「散热协议 ×2 → ×3」)—— 这就是"拿过两次就显示 ×2"那条要求的落点。
 */
export function cardLevelText(opt: UpgradeOption, world?: World): string {
  if (opt.kind === OFFER_NEW_WEAPON) {
    const lv = world ? newWeaponGranted(world, opt) : 1;
    // opt.level = 槽里已有几把同型的最高等级(0 = 一把都没有,见 upgrade.ts 的 level 口径);
    // 有同型且这一型有配方时,这张卡的真正价值是"往三合一凑一把",标题必须先说这件事
    const owned = opt.level > 0;
    const mergeable = mergeResultOf(opt.type) >= 0;
    if (owned && mergeable) return `已有同型 · 再拿一把 · 凑满 3 把当场合成`;
    return `新武器 · 获得后从 Lv${lv} 起步${mergeable ? ' · 可三合一合成' : ''}`;
  }
  if (opt.kind === OFFER_WEAPON_UPGRADE) {
    const lv = opt.level;
    if (lv >= TOWER_MAX_LEVEL) return `当前 Lv${TOWER_MAX_LEVEL}(满级)`;
    if (lv >= 1) return `当前 Lv${Math.floor(lv)}`;
    return '未持有 · 存档等级';
  }
  // 法令:当前层 → 下一层。满层那一档正常不会出现在候选里(卡池已剔),留一句兜底文案
  const lv = Math.max(0, Math.floor(opt.level));
  if (lv >= EDICT_MAX_LEVEL) return `法令 · 已满层(×${EDICT_MAX_LEVEL})`;
  if (lv <= 0) return `法令 · 不占槽 · 可叠到 ×${EDICT_MAX_LEVEL}`;
  return `法令 · 当前 ×${lv} → ×${lv + 1}(上限 ×${EDICT_MAX_LEVEL})`;
}

/** 跳过返还 = cost − 手续费。**与 World.skipUpgrade 调的是同一个 skipRefundFor**:分家的话提示与到账会各走各的 */
export function skipRefund(cost: number): number {
  return skipRefundFor(cost);
}

/** 焦点在调参面板的输入框里:此时数字键/Esc 是在打字,不该被当成选卡/取消抢走 */
function isTyping(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

/** 三选一升级流程的对外面孔。main.ts 在 onUpgradeOffer 里 show、结算完由 onResolved 接手 */
export interface UpgradeFlowUi {
  /** 换掉整局的 World(重开 = 换新 World,这条交互必须跟着改指向,否则点下去的全落进上一局) */
  setWorld(world: World): void;
  /** 读 world.offer 弹卡(main.ts 在 onUpgradeOffer 里调,时停在那一侧) */
  show(): void;
  /** 收卡。**不恢复战斗、不动 loop** —— 那是 main.ts 的事(World 与 ui 都不认识"游戏流程") */
  hide(): void;
}

/** 改版后的最小契约:只剩 World 与结算回调。画布/拾格/渲染层状态随放置阶段一起删除 */
export interface UpgradeFlowOpts {
  world: World;
  /** 结算完(取用成功 / 跳过 / 卡片过期)→ main 收卡、恢复战斗。本文件不认识 loop,也不动 run */
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
  // world 是**可重赋的局部变量**而不是解构常量:重开一局换掉整个 World(见 setWorld),
  // 闭包里每处(choose / skip / reroll)都是现读它 —— 换引用这一件事就够了,监听器与 DOM 不必重挂。
  let world = opts.world;
  const { onResolved } = opts;

  function makeDiv(css: string): HTMLDivElement {
    const el = document.createElement('div');
    el.style.cssText = css;
    return el;
  }
  function makeBtn(css: string, text: string): HTMLButtonElement {
    const el = document.createElement('button');
    el.style.cssText = css;
    el.textContent = text;
    return el;
  }

  // —— DOM:三个直接子节点(卡片面板 + 换槽选择层 + 左下角提示条),append 进 #ui,行内 style ——
  const headEl = makeDiv(HEAD_CSS);
  const cardsEl = makeDiv(CARDS_CSS);
  const rerollBtn = makeBtn(BTN_CSS, `重摇(${REROLL_PRICE} 星币)`);
  const skipBtn = makeBtn(BTN_CSS, '');
  const btnRow = makeDiv('display:flex;gap:10px;');
  btnRow.append(rerollBtn, skipBtn);
  const panel = makeDiv(PANEL_CSS);
  panel.append(headEl, cardsEl, btnRow);

  const pickerTitle = makeDiv(HEAD_CSS);
  const pickerSlots = makeDiv('display:flex;flex-direction:column;gap:8px;');
  const pickerBack = makeBtn(BTN_CSS, '返回重选(Esc / 右键)');
  const picker = makeDiv(PICKER_CSS);
  picker.append(pickerTitle, pickerSlots, pickerBack);

  const toast = makeDiv(TOAST_CSS);
  const ui = document.getElementById('ui')!;
  ui.appendChild(panel);
  ui.appendChild(picker);
  ui.appendChild(toast);

  const cards: CardEls[] = [];
  const slotBtns: HTMLButtonElement[] = [];
  for (let i = 0; i < WEAPON_SLOT_COUNT; i++) {
    const btn = makeBtn(SLOT_CSS, '');
    const index = i;
    btn.addEventListener('click', () => confirmReplace(index));
    pickerSlots.appendChild(btn);
    slotBtns.push(btn);
  }

  let phase = PHASE_OFF;
  let chosen = -1; // 待结算的候选在 world.offer 里的下标;-1 = 还没选。takeUpgrade 收的就是它
  let flashTimer = 0;

  /** 建一张卡。**只在这里建**,建好就整局复用(弹卡只改 textContent) */
  function createCard(index: number): CardEls {
    const root = makeBtn(CARD_CSS, '');
    const icon = makeDiv(CARD_ICON_CSS);
    const title = makeDiv(CARD_TITLE_CSS);
    const desc = makeDiv(CARD_DESC_CSS);
    const level = makeDiv(CARD_LEVEL_CSS);
    root.append(icon, title, desc, level);
    root.addEventListener('click', () => choose(index));
    cardsEl.appendChild(root);
    return { root, icon, title, desc, level };
  }

  /** 抹掉提示条并停掉它的计时器(退回选卡与重开一局共用) */
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
    }, FLASH_MS);
  }

  /** 重摇按钮的置灰态,每次弹卡 / 重摇之后现读 World 刷新一次:星币不足或本档已摇过都不可点(置灰只是读数,裁决以返回码为准) */
  function syncRerollState(): void {
    const enabled = world.starCoins >= REROLL_PRICE && !world.offerRerolled;
    rerollBtn.disabled = !enabled;
    rerollBtn.style.opacity = enabled ? '1' : '0.5';
    rerollBtn.style.cursor = enabled ? 'pointer' : 'not-allowed';
  }

  /** 刷面板头:玩家模式不印残骸/花费(?debug 才印,与 main.ts 同一条判定) */
  function syncPanel(): void {
    headEl.textContent = DEBUG
      ? `三选一升级 · 残骸 ${Math.round(world.scrap)} · 本次花费 ${world.upgradeCost}`
      : '世界已暂停 · 三选一';
    syncRerollState();
  }

  /** 把 world.offer 摊到卡片上。元素复用,多出来的藏起来(offer 可能不足三张) */
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
      card.desc.textContent = cardDesc(opt, world);
      card.level.textContent = cardLevelText(opt, world);
    }
    skipBtn.textContent = `跳过(手续费 ${UPGRADE_SKIP_FEE} · 返还 ${skipRefund(world.upgradeCost)})`;
  }

  function hide(): void {
    phase = PHASE_OFF;
    chosen = -1;
    panel.style.display = 'none';
    picker.style.display = 'none';
  }

  /**
   * 这一次升级结算完了(取用成功 / 跳过 / 卡片过期)。先收面板再回调:main 那边也会 hide 一次,
   * 但"结算完就该消失"不该依赖调用方记得那一句。提示条**不清**:那行回执要留到战斗恢复后读。
   */
  function resolve(): void {
    hide();
    onResolved();
  }

  /** 这一型武器在槽里的最高等级(取用后现读,与回执文案同一份真相) */
  function maxWeaponLevelNow(type: number): number {
    let lv = 0;
    for (let i = 0; i < world.weapons.length; i++) {
      const slot = world.weapons[i]!;
      if (slot.type === type && slot.level > lv) lv = slot.level;
    }
    return lv;
  }

  /**
   * 取用成功后的回执文案,按三类各说各的话。**在 takeUpgrade 之后调用**,等级/层数
   * 一律现读 World —— 卡片承诺的是"点下去之后",回执说的就是"点下去之后"。
   */
  function successToast(opt: UpgradeOption): string {
    const label = optionLabel(opt);
    if (opt.kind === OFFER_NEW_WEAPON) return `获得:${label}`;
    if (opt.kind === OFFER_WEAPON_UPGRADE) {
      const lv = maxWeaponLevelNow(opt.type);
      if (lv >= TOWER_MAX_LEVEL) return `${label} 已是满级 Lv${lv}`;
      if (lv >= 1) return `${label} 升到 Lv${lv}`;
      return `${label} 等级存档 Lv${world.weaponBankedLevels[opt.type] ?? 0}(获得时生效)`;
    }
    // 法令:层数现读 World(grantEdict 已经加过一层)—— 这就是"拿过两次过热上限就显示 ×2"
    const lv = edictLevel(world.edictLevels, opt.type);
    return lv >= 2 ? `${label} ×${lv}` : `法令生效:${label} · 全船被动`;
  }

  /**
   * 点一张卡 → **当场结算**(没有放置阶段)。成败全以 world.takeUpgrade 的返回码为准:
   *   成功(≥ 0)→ 回执 + resolve;新武器槽满(ACQUIRE_REPLACE_NEEDED)→ 进换槽子阶段;
   *   待选没了(UPGRADE_NO_OFFER)→ 说清楚并放行;其余拒绝(SUPPORT_FULL 等)→ 闪红说人话,
   *   **一分不扣、一帧不恢复**,卡还留着。
   */
  function choose(index: number): void {
    if (phase !== PHASE_PICK) return;
    const opt = world.offer[index];
    // 越界/空卡:候选比卡片少时那张卡本就是藏起来的,这一句是拦网
    if (!opt) return;
    const code = world.takeUpgrade(index);
    if (code >= 0) {
      flash(successToast(opt), OK_COLOR);
      audioBus.playPlace();
      resolve();
      return;
    }
    if (code === UPGRADE_NO_OFFER) {
      flash(denyMessage(code), DENY_COLOR);
      resolve();
      return;
    }
    if (code === ACQUIRE_REPLACE_NEEDED) {
      chosen = index;
      showPicker();
      return;
    }
    flash(denyMessage(code), DENY_COLOR);
  }

  /** 换槽选择层:列出当前 4 槽,点某一槽 = 带着槽位把这张卡再结算一次 */
  function showPicker(): void {
    const opt = world.offer[chosen];
    pickerTitle.textContent = opt
      ? `武器槽已满 —— 换下哪一把,给「${optionLabel(opt)}」让位?`
      : '武器槽已满';
    for (let i = 0; i < WEAPON_SLOT_COUNT; i++) {
      const btn = slotBtns[i]!;
      const slot = world.weapons[i];
      if (!slot || slot.type < 0) {
        btn.disabled = true;
        btn.style.opacity = '0.4';
        btn.textContent = `槽 ${i} · 空槽`;
        continue;
      }
      const def = TOWERS[slot.type];
      btn.disabled = false;
      btn.style.opacity = '1';
      btn.textContent = `槽 ${i} · ${def?.name ?? `未知塔型(${slot.type})`} Lv${slot.level}`;
    }
    phase = PHASE_REPLACE;
    clearFlash();
    panel.style.display = 'none';
    picker.style.display = 'flex';
  }

  /**
   * 点替换层里的某一槽。**不直接调 replaceWeapon**:world.ts 的口径是带 slotIndex 再调一次
   * takeUpgrade,由它内部当场替换并完成结算(completeUpgrade 也在那一次跑,否则 offer 不清空,
   * 同一张卡下一帧当场再弹)。opt 在调用前先抓住 —— 结算成功后 world.offer 已被清空,回执还要用它。
   */
  function confirmReplace(slotIndex: number): void {
    if (phase !== PHASE_REPLACE) return;
    const opt = world.offer[chosen];
    if (!opt) {
      flash(denyMessage(UPGRADE_NO_OFFER), DENY_COLOR);
      resolve();
      return;
    }
    const code = world.takeUpgrade(chosen, slotIndex);
    if (code >= 0) {
      flash(`获得:${optionLabel(opt)}`, OK_COLOR);
      audioBus.playPlace();
      resolve();
      return;
    }
    if (code === UPGRADE_NO_OFFER) {
      flash(denyMessage(code), DENY_COLOR);
      resolve();
      return;
    }
    // 替换失败(正常点不出来):留在替换层,可换一个槽或退回重选
    flash(denyMessage(code), DENY_COLOR);
  }

  /** 退回选卡(Esc / 右键 / 「返回重选」)。**不扣费、不恢复战斗** */
  function cancelReplace(): void {
    if (phase !== PHASE_REPLACE) return;
    chosen = -1;
    phase = PHASE_PICK;
    picker.style.display = 'none';
    panel.style.display = 'flex';
    clearFlash();
    syncPanel();
  }

  /**
   * 跳过这一次升级(手续费制,见 data/economy 的 UPGRADE_SKIP_FEE)。**照样是一次结算** ——
   * World 扣费、按 cost − 手续费返还、upgrades++、清空 offer,于是下一帧不会再弹同一张卡,
   * 而下一档的三张是全新候选(= 付费重随)。
   */
  function skip(): void {
    if (phase !== PHASE_PICK) return;
    const refund = skipRefund(world.upgradeCost);
    if (world.skipUpgrade()) flash(`跳过这次升级 —— 手续费 ${UPGRADE_SKIP_FEE},返还 ${refund} 残骸`, OK_COLOR);
    // 无待选(理论上这张卡根本不该在屏幕上)也照样放行:留在这儿就是个点什么都没用的面板
    else flash(denyMessage(UPGRADE_NO_OFFER), DENY_COLOR);
    resolve();
  }

  /**
   * 重摇这一手牌(16 号):花 REROLL_PRICE 星币,让 World 重掷三个候选。
   * **不结算、不恢复战斗** —— 重摇只是换一手牌,时停要继续停到这一次升级真的结算掉为止。
   * 失败按返回码处理(星币不足 / 本档已摇过 → 重刷置灰态;待选没了 → 说清楚并放行)。
   */
  function reroll(): void {
    if (phase !== PHASE_PICK || rerollBtn.disabled) return;
    const code = world.rerollOffer();
    if (code > 0) {
      renderCards();
      syncPanel();
      flash(`已重摇 —— 花费 ${REROLL_PRICE} 星币`, OK_COLOR);
      return;
    }
    if (code === REROLL_NO_STARCOINS || code === REROLL_ALREADY_DONE) {
      // 失败的原因恰好就是置灰的两个条件:重刷一次置灰态,让按钮与账目重新对齐
      syncRerollState();
      return;
    }
    flash(denyMessage(code), DENY_COLOR);
    resolve();
  }

  skipBtn.addEventListener('click', skip);
  rerollBtn.addEventListener('click', reroll);
  pickerBack.addEventListener('click', cancelReplace);

  window.addEventListener('keydown', (e) => {
    // 收着的时候一律不认:战斗中按 Esc/数字键不该动到升级流程
    if (phase === PHASE_OFF || e.repeat || isTyping()) return;
    if (e.code === 'Escape') {
      cancelReplace();
      return;
    }
    // 数字键直选卡片(1..N = 从左到右)。只认主键盘的 DigitN。换槽阶段不认数字键
    if (phase !== PHASE_PICK || !e.code.startsWith('Digit')) return;
    const n = Number(e.code.slice(5));
    if (Number.isInteger(n) && n >= 1) choose(n - 1);
  });

  // 右键 = 退回选卡的通用手势。卡片/替换层一弹出来就挡掉浏览器菜单(时停期间那张系统菜单
  // 会盖在甲板上,收掉它之前玩家什么都点不了);战斗中(PHASE_OFF)则一律不管
  document.addEventListener('contextmenu', (e) => {
    if (phase === PHASE_OFF) return;
    e.preventDefault();
    cancelReplace();
  });

  return {
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
      renderCards();
      syncPanel();
      picker.style.display = 'none';
      panel.style.display = 'flex';
      // 弹卡那一刻的"弹出"音;空 offer 的早退路径在上面已 return,不会走到这
      audioBus.playUpgrade();
    },
    hide,
    setWorld(next: World): void {
      world = next;
      // 面板整个收掉、阶段回到"收着":offer 是**上一局**的候选、chosen 是它的下标 ——
      // 留着就会拿新世界的 offer 去兑上一局的选择,或者对着一张空 offer 点确认。
      // **不调 onResolved**:恢复战斗是 main.ts 重开流程自己的一步(run.paused 在那边),
      // 这里替它调一次,反而会在装配到一半时把上一局的收尾动作跑出来
      hide();
      // 上一局最后那条提示(连同它的超时)一并抹掉:新船开出去的第一眼不该挂着上一局的回执
      clearFlash();
    },
  };
}
