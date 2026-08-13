/**
 * 起手配置选择界面(20 号 issue,GDD §10「起手配置…可在开局选择」)—— DOM 覆盖层,永不 import pixi。
 * 与 ui/gameOver.ts 同一条皮:铺满整屏的遮罩 + 卡片,整页只建一次,重开走 show/hide。
 *
 * 出现时机:首局开跑前与每次「再来一局」(main.ts 的 restart)之后 —— 玩家挑完配置才装配新局;
 * 「再试这一局」(同 seed 重试)不经过它,连起手一起原样重来。
 *
 * 门禁判定在这份 UI 里(而非 data 层):解锁掩码位 i = UNLOCKS[i],而一条配置的锁 = UNLOCKS 表里
 * kind=UNLOCK_LOADOUT 且 type=配置下标 的那一条 —— 只有同时读 LOADOUTS 与 UNLOCKS 两张表才能算,
 * 而 data 表之间不许互引(unlocks → towers 的依赖方向)。于是纯函数部分(loadoutCards /
 * loadoutUnlockIndex / loadoutConditionText)全部导出,Node 里直接钉,不装 jsdom。
 */
import { LOADOUTS, type LoadoutDef } from '../data/loadout';
import {
  COND_ELITE_KILLS,
  COND_FIRST_WIN,
  COND_KILLS,
  COND_NONE,
  UNLOCK_LOADOUT,
  UNLOCKS,
  type UnlockEntry,
} from '../data/unlocks';
import { TOWER_KIND_COUNT, TOWERS } from '../data/towers';
import { EDICTS, EDICT_KIND_COUNT } from '../data/edicts';
import { WEAPON_SLOT_COUNT } from '../sim/armory';
import { isTyping } from './isTyping';

/** 冷色域与结算界面同一支:我方废铁的青蓝系(GDD §12,敌我色域分离) */
const OK_COLOR = '#9adcff';
const IDLE_COLOR = '#5f7a99';
const VALUE_COLOR = '#c8dcf0';
const LINE_COLOR = '#2b4a6e';

/**
 * 满屏遮罩,与结算界面的 ROOT_CSS 同款:铺满整屏吃下全部 pointer-events(index.html 的
 * `#ui > * { pointer-events:auto }`),选择期间对着一艘没出港的船点格子没有任何意义。
 */
const ROOT_CSS =
  'position:fixed;inset:0;display:none;align-items:center;justify-content:center;' +
  'background:rgba(5,7,13,.82);' +
  'font:13px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;user-select:none;';

const PANEL_CSS =
  'max-width:min(96vw,880px);max-height:92vh;overflow-y:auto;padding:22px 28px;border-radius:10px;' +
  `background:rgba(10,16,26,.94);border:1px solid ${LINE_COLOR};text-align:center;`;

const TITLE_CSS = 'font-size:20px;letter-spacing:.18em;margin-bottom:4px;';
const NOTE_CSS = `color:${IDLE_COLOR};margin-bottom:16px;`;

/** 卡片排成一行,窄屏自动换行(wrap)而不是横向挤爆 */
const GRID_CSS =
  'display:flex;flex-wrap:wrap;gap:12px;justify-content:center;align-items:stretch;';
const CARD_CSS =
  'flex:0 1 190px;padding:14px 14px 10px;border-radius:8px;cursor:pointer;text-align:left;' +
  `border:1px solid ${LINE_COLOR};background:rgba(20,30,44,.6);`;
const CARD_LOCKED_CSS = `opacity:.45;cursor:default;`;
const CARD_NAME_CSS = `color:${OK_COLOR};font-size:14px;letter-spacing:.08em;margin-bottom:4px;`;
const CARD_DESC_CSS = `color:${VALUE_COLOR};font-size:12px;line-height:1.6;min-height:58px;`;
/** 槽位示意图:等宽 + 白字,与读数区同款写法 */
const DIAGRAM_CSS =
  'white-space:pre;color:#e8f2ff;font:inherit;margin:8px 0 6px;background:rgba(5,7,13,.5);' +
  'border-radius:4px;padding:4px 6px;';
const CARD_FOOT_CSS = `color:${IDLE_COLOR};font-size:12px;`;
const KEY_BADGE_CSS =
  `display:inline-block;min-width:16px;text-align:center;margin-right:6px;` +
  `border:1px solid ${LINE_COLOR};border-radius:3px;color:${OK_COLOR};`;

/** 示意图用的单字代号:武器/支援各一档,不认识的型号一律 '?'(数值表写坏时当场看得见) */
const TOWER_GLYPH: string[] = [
  '机', // TOWER_AUTOCANNON
  '光', // TOWER_LASER
  '弧', // TOWER_ARC
  '轨', // TOWER_RAILGUN
  '防', // TOWER_PD
  '迫', // TOWER_MORTAR
  '风', // TOWER_STORM_CANNON(合成武器,起手表不引用,占位)
  '极', // TOWER_AURORA
  '湮', // TOWER_ANNIHILATION
  '雷', // TOWER_THUNDER
  '焦', // TOWER_DELUGE
  '荆', // TOWER_THORN
  '弹', // TOWER_MISSILE_NEST
];
function glyphForTower(type: number): string {
  return type >= 0 && type < TOWER_KIND_COUNT ? TOWER_GLYPH[type]! : '?';
}

/**
 * 法令的单字:现读 EDICTS[type].name 的首字(弹药→弹、散热→散、电容→容),不再是与表并排写死的
 * 字形表 —— 法令改名/加条时字形自动跟着走,不会有旧名残留(如原「经验增幅器」的「验」)。
 * 不认识的号一律 '?',与 TOWER_GLYPH 同一条口径。
 */
function glyphForEdict(type: number): string {
  const def = type >= 0 && type < EDICT_KIND_COUNT ? EDICTS[type] : undefined;
  return def ? def.name.charAt(0) : '?';
}

/**
 * 起手配置示意图:两行文本 —— 武器槽(WEAPON_SLOT_COUNT 个,空格用 '·')+ 开局法令。
 * 一行直接读出"开局带几门炮、什么炮、带哪几条法令",与槽位制的装配心智一致。
 * 槽位数从 sim/armory 现读而不是写死 4:槽位扩到 8 之后写死的那个数会画出一张少一半的图。
 */
export function loadoutDiagram(def: LoadoutDef): string {
  const weapons = Array.from({ length: WEAPON_SLOT_COUNT }, (_, i) =>
    i < def.weapons.length ? glyphForTower(def.weapons[i]!) : '·',
  );
  const edicts = def.edicts.map((t) => glyphForEdict(t));
  const lines = [`武器 [${weapons.join('][')}]`];
  lines.push(edicts.length > 0 ? `法令 ${edicts.join(' ')}` : '法令 —');
  lines.push('↑ 船头');
  return lines.join('\n');
}

/**
 * 一条配置的门禁在 UNLOCKS 表里的下标;无条件配置返回 -1。
 * 链接方式 = kind + type 双向咬合(与 UNLOCK_ELITE 的槽位同一条纪律):改 type 忘改这里必被测试抓。
 */
export function loadoutUnlockIndex(loadoutIdx: number): number {
  for (let i = 0; i < UNLOCKS.length; i++) {
    const u = UNLOCKS[i]!;
    if (u.kind === UNLOCK_LOADOUT && u.type === loadoutIdx) return i;
  }
  return -1;
}

/** 这条配置对这份解锁掩码开没开:-1(无门禁)恒开;有门禁就看那一位 */
export function loadoutUnlocked(loadoutIdx: number, unlockMask: number): boolean {
  const i = loadoutUnlockIndex(loadoutIdx);
  return i < 0 || (unlockMask & (1 << i)) !== 0;
}

/**
 * 锁定条件的玩家文案(卡片上的灰字)。未知条件编号印码,与 gameOver 的未知结果码同一口径:
 * 悄悄显示"无条件"会把一条写错编号的锁变成形同虚设。
 */
export function loadoutConditionText(entry: UnlockEntry): string {
  switch (entry.condition.kind) {
    case COND_FIRST_WIN:
      return '通关 1 局解锁';
    case COND_KILLS:
      return `单局击杀 ${entry.condition.target} 解锁`;
    case COND_ELITE_KILLS:
      return `累计击杀 ${entry.condition.target} 只精英解锁`;
    case COND_NONE:
      return '无条件解锁';
    default:
      return `条件 ${entry.condition.kind} 解锁`;
  }
}

/** 一张卡片的展示数据:纯函数,Node 里逐字段钉 */
export interface LoadoutCardView {
  /** LOADOUTS 下标,onSelect 原样回传 */
  index: number;
  def: LoadoutDef;
  diagram: string;
  unlocked: boolean;
  /** 未解锁时的条件文案;已解锁恒 '' */
  conditionText: string;
}

/** 整页四张卡片:配置表 + 解锁掩码 → 展示数据。掩码 0 = 只有前两条可用 */
export function loadoutCards(unlockMask: number): LoadoutCardView[] {
  const out: LoadoutCardView[] = [];
  for (let i = 0; i < LOADOUTS.length; i++) {
    const def = LOADOUTS[i]!;
    const unlocked = loadoutUnlocked(i, unlockMask);
    const gate = loadoutUnlockIndex(i);
    out.push({
      index: i,
      def,
      diagram: loadoutDiagram(def),
      unlocked,
      conditionText: unlocked ? '' : loadoutConditionText(UNLOCKS[gate]!),
    });
  }
  return out;
}

export interface LoadoutFlowUi {
  /** 弹出选择界面;unlockMask = 此刻的进度掩码(每局结算后 main 侧已更新) */
  show(unlockMask: number): void;
  hide(): void;
}

/**
 * 接线选择界面。整页只建一次(DOM 与 window 监听器),重开走 show/hide ——
 * 与结算界面同一条教训:每局多一份监听器 = 一次按键选好几局。
 * @param opts.onSelect 选中的 LOADOUTS 下标。界面自己收起后回调(与 gameOver 的"点了就该消失"同口径),
 *   装配新 World 的事在 main.ts 那条流程里。
 */
export function createLoadoutFlow(opts: { onSelect: (index: number) => void }): LoadoutFlowUi {
  const root = document.createElement('div');
  root.style.cssText = ROOT_CSS;
  const panel = document.createElement('div');
  panel.style.cssText = PANEL_CSS;
  const title = document.createElement('div');
  title.style.cssText = TITLE_CSS;
  title.textContent = '选择起手配置';
  const note = document.createElement('div');
  note.style.cssText = NOTE_CSS;
  note.textContent = '数字键 1–4 或点击卡片选择 · 起手配置是开跑前输入,不影响本局种子';
  const grid = document.createElement('div');
  grid.style.cssText = GRID_CSS;
  panel.append(title, note, grid);
  root.appendChild(panel);
  document.getElementById('ui')!.appendChild(root);

  let visible = false;
  // 每张卡片的点击闭包:show 时按最新掩码重建,旧卡片连同旧闭包一起被 replaceChildren 丢掉
  const handlers: Array<() => void> = [];

  function select(index: number): void {
    hide();
    opts.onSelect(index);
  }

  function hide(): void {
    visible = false;
    root.style.display = 'none';
  }

  window.addEventListener('keydown', (e) => {
    if (!visible || e.repeat || isTyping()) return;
    const digit = e.code.startsWith('Digit')
      ? Number(e.code.slice(5))
      : e.code.startsWith('Numpad')
        ? Number(e.code.slice(6))
        : NaN;
    if (Number.isNaN(digit) || digit < 1 || digit > LOADOUTS.length) return;
    // 锁着的卡片不响应数字键(与点击同一条闸门)
    if (!loadoutUnlocked(digit - 1, shownMask)) return;
    e.preventDefault();
    select(digit - 1);
  });

  let shownMask = 0;

  return {
    show(unlockMask: number): void {
      shownMask = unlockMask;
      handlers.length = 0;
      grid.replaceChildren();
      const cards = loadoutCards(unlockMask);
      for (const card of cards) {
        const el = document.createElement('div');
        el.style.cssText = card.unlocked ? CARD_CSS : CARD_CSS + CARD_LOCKED_CSS;
        const badge = document.createElement('div');
        badge.style.cssText = KEY_BADGE_CSS;
        badge.textContent = String(card.index + 1);
        const nameEl = document.createElement('div');
        nameEl.style.cssText = CARD_NAME_CSS;
        nameEl.textContent = card.def.name;
        const descEl = document.createElement('div');
        descEl.style.cssText = CARD_DESC_CSS;
        descEl.textContent = card.def.desc;
        const diagramEl = document.createElement('div');
        diagramEl.style.cssText = DIAGRAM_CSS;
        diagramEl.textContent = card.diagram;
        const footEl = document.createElement('div');
        footEl.style.cssText = CARD_FOOT_CSS;
        footEl.textContent = card.unlocked ? '点击选择' : card.conditionText;
        el.append(badge, nameEl, descEl, diagramEl, footEl);
        if (card.unlocked) {
          const fn = (): void => select(card.index);
          handlers.push(fn);
          el.addEventListener('click', fn);
        }
        grid.appendChild(el);
      }
      visible = true;
      root.style.display = 'flex';
    },
    hide,
  };
}
