/**
 * 图鉴页 —— DOM 覆盖层,**永不 import pixi**(与设置/结算/标题同一条铁律 1 边界)。
 * 入口是标题界面的「图鉴」按钮,关掉后回标题(onClose 由 main 记,本文件只管关掉自己)。
 *
 * **整页只建一次**(与 settingsMenu 同一条纪律):DOM 与 window 监听器都在 createCodexUi 里挂,
 * 反复 show/hide 不重建 —— 建两份就是两份 Esc 监听器、两块遮罩。
 *
 * 与结算界面里那张小图鉴(ui/gameOver.ts 的 renderCollection)不同,这里是**全量目录**:
 * 武器 13 型、敌人 6 型 + Boss + 精英事件、法令 10 条、起手配置 4 套,未解锁的灰显 +
 * 条件文案(「下一把的新理由」就摆在眼前)。数据一律现读 progress(main 持唯一那一份,
 * 每局结算后已更新):getProgress() 每次 show 现取,不缓存。
 *
 * 「图鉴到底显示了什么」全部走纯函数(codexRows 那一层),Node 里可直接数出来 ——
 * 与 gameOver.summaryText 同一条口径:锁定判定、效果摘要、合成武器底座名,哪一条错
 * 都只是几行字符串拼接,却要等真人进一次图鉴才看得见。
 */
import { isTyping } from '../core/isTyping';
import {
  BH_SEEK,
  BH_SEEK_CHARGE,
  BH_SPORE,
  BH_STRAFE,
  BH_STRAFE_CHARGE,
  BOSS,
  ENEMIES,
} from '../data/enemies';
import { EDICTS, type EdictDef } from '../data/edicts';
import { LOADOUTS } from '../data/loadout';
import { MERGES } from '../data/merges';
import { FX_MORTAR, throttleName, TOWERS } from '../data/towers';
import {
  COND_ELITE_KILLS,
  COND_FIRST_WIN,
  COND_KILLS,
  UNLOCK_COLLECT,
  UNLOCK_EDICT,
  UNLOCK_ELITE,
  UNLOCK_LOADOUT,
  UNLOCK_TOWER,
  UNLOCKS,
  type UnlockEntry,
} from '../data/unlocks';
import type { Progress } from '../sim/progress';
import { collectionItemName } from './gameOver';

const OK_COLOR = '#9adcff';
const IDLE_COLOR = '#5f7a99';
const VALUE_COLOR = '#c8dcf0';
const LINE_COLOR = '#2b4a6e';

/** 满屏遮罩,与设置/暂停/结算同款(铺满吃下全部 pointer-events) */
const ROOT_CSS =
  'position:fixed;inset:0;display:none;align-items:center;justify-content:center;' +
  'background:rgba(5,7,13,.86);' +
  'font:13px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;user-select:none;';

/**
 * 卡片比设置页更宽(560):图鉴行带数值详情,太窄会换行折成三行。
 * 竖向 flex + 内层滚动:标题与返回按钮永远在屏内,滚的只是中间那一截目录。
 */
const CARD_CSS =
  'min-width:340px;max-width:min(94vw,560px);max-height:86vh;padding:22px 26px;border-radius:10px;' +
  `background:rgba(10,16,26,.94);border:1px solid ${LINE_COLOR};` +
  'display:flex;flex-direction:column;';

const TITLE_CSS =
  `color:${OK_COLOR};font-size:19px;letter-spacing:.22em;text-align:center;`;
const STATS_CSS =
  `color:${VALUE_COLOR};text-align:center;margin-bottom:8px;letter-spacing:.06em;`;

/** 目录滚动区:flex:1 让它占掉卡片剩余高度,内容超高时自己滚,不把返回按钮挤出屏外 */
const SCROLL_CSS = 'flex:1 1 auto;overflow-y:auto;margin-top:4px;padding-right:6px;';
const CATEGORY_CSS = `color:${IDLE_COLOR};font-size:12px;letter-spacing:.12em;margin-top:12px;margin-bottom:3px;`;
/** 图鉴条目:已解锁 = 读数同色;未解锁 = 灰字 + 降透明度(与结算图鉴同一套灰显) */
const ROW_CSS = `color:${VALUE_COLOR};`;
const ROW_LOCKED_CSS = `color:${IDLE_COLOR};opacity:.45;`;
/** 船形剪影缩略图;dataURL 原样显示,object-fit 兜住剪影的透明边(与结算图鉴同款) */
const SHOT_THUMB_CSS =
  `width:52px;height:52px;object-fit:contain;background:rgba(5,7,13,.6);` +
  `border:1px solid ${LINE_COLOR};border-radius:4px;margin:4px 6px 0 0;`;
const SHOT_PLACEHOLDER_CSS = `color:${IDLE_COLOR};margin-top:4px;`;

const BACK_BTN_CSS =
  'display:block;width:100%;padding:9px 0;border-radius:6px;cursor:pointer;font:inherit;' +
  `border:1px solid ${LINE_COLOR};background:rgba(43,74,110,.28);color:${OK_COLOR};` +
  'letter-spacing:.1em;margin-top:14px;';

// —— 纯函数层:图鉴「显示了什么」,Node 里可测 ——

/** 解锁条件文案(未解锁条目灰显时并排印出来 —— 只说清"差什么",不说怎么玩) */
export function unlockConditionText(entry: UnlockEntry): string {
  switch (entry.condition.kind) {
    case COND_FIRST_WIN:
      return '首次胜利';
    case COND_KILLS:
      return `单局击杀 ${entry.condition.target}`;
    case COND_ELITE_KILLS:
      return `累计精英击杀 ${entry.condition.target}`;
    default:
      return '无条件';
  }
}

/**
 * 敌型行为短标签。文案取自 enemies.ts 各 BH_* 常量注释的短截 ——
 * 图鉴只要"这一型怎么打"的一行直觉,不要状态机的全文。
 */
export function behaviorName(bh: number): string {
  switch (bh) {
    case BH_SEEK:
      return '直线追船';
    case BH_STRAFE:
      return '侧向驻留';
    case BH_STRAFE_CHARGE:
      return '侧向冲锋';
    case BH_SEEK_CHARGE:
      return '直线冲锋';
    case BH_SPORE:
      return '远程喷吐';
    default:
      return `行为 ${bh}`;
  }
}

/** 倍率印法:两位小数内舍入、尾零省掉(1.25 / 1.5 / 0.7,不印 1.250) */
export function formatMul(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/**
 * 法令效果摘要:前缀作用域(系限定 / 全船),再按固定顺序挑**非中性**字段拼一行。
 * 数据表口径"不用就填 1/0"(见 edicts.ts),故非中性即有效 —— 每个字段一行标签,
 * 加法档印 +N、概率档换算成百分点,读法与升级卡片同一套(× 倍率 / + 点数)。
 */
export function edictSummaryText(def: EdictDef): string {
  // throttleName 本身就带「系」字(THROTTLE_NAMES = 弹药系/过热系/充能系),别再叠一个
  const scope = def.throttle >= 0 ? throttleName(def.throttle) : '全船';
  const parts: string[] = [];
  if (def.fireRateMul !== 1) parts.push(`射速 ×${formatMul(def.fireRateMul)}`);
  if (def.reloadMul !== 1) parts.push(`装填 ×${formatMul(def.reloadMul)}`);
  if (def.heatMaxMul !== 1) parts.push(`过热 ×${formatMul(def.heatMaxMul)}`);
  if (def.chargeRateMul !== 1) parts.push(`充能 ×${formatMul(def.chargeRateMul)}`);
  if (def.damageMul !== 1) parts.push(`伤害 ×${formatMul(def.damageMul)}`);
  if (def.hullHpAdd !== 0) parts.push(`船体 +${def.hullHpAdd}`);
  if (def.damageTakenMul !== 1) parts.push(`受击 ×${formatMul(def.damageTakenMul)}`);
  if (def.xpMul !== 1) parts.push(`经验 ×${formatMul(def.xpMul)}`);
  if (def.magnetRadiusMul !== 1) parts.push(`磁吸 ×${formatMul(def.magnetRadiusMul)}`);
  if (def.turnRateAdd !== 0) parts.push(`转向 +${def.turnRateAdd}°/s`);
  if (def.cruiseSpeedMul !== 1) parts.push(`巡航 ×${formatMul(def.cruiseSpeedMul)}`);
  if (def.starCoinChanceAdd !== 0) parts.push(`星币 +${Math.round(def.starCoinChanceAdd * 100)}%`);
  return `${scope}:${parts.length === 0 ? '—' : parts.join(' · ')}`;
}

/** 统计行:三个累计计数器,与结算界面的元进度读数同源 */
export function codexStatsText(p: Progress): string {
  return `胜场 ${p.wins} · 总击杀 ${p.kills} · 精英击杀 ${p.eliteKills}`;
}

/** 内容解锁计数(与结算图鉴同口径:UNLOCKS 剔掉船形收藏,数掩码置位) */
export function codexUnlockStats(progress: Progress): { unlocked: number; total: number } {
  let total = 0;
  let unlocked = 0;
  for (let i = 0; i < UNLOCKS.length; i++) {
    if (UNLOCKS[i]!.kind === UNLOCK_COLLECT) continue; // 船形收藏无条件,不占分子分母
    total++;
    if ((progress.unlockMask & (1 << i)) !== 0) unlocked++;
  }
  return { unlocked, total };
}

/** 图鉴一行:名称 + 详情(已解锁 = 关键数值;锁定 = 解锁条件)+ 锁定标记 */
export interface CodexRow {
  name: string;
  /** 已解锁:关键数值;锁定:解锁条件文案(DOM 层拼进"(未解锁 · …)") */
  detail: string;
  locked: boolean;
}

export interface CodexSection {
  title: string;
  rows: CodexRow[];
}

/**
 * 内容锁反查:UNLOCKS 里 kind+type 对应的条目下标;没有 = 这条内容不在解锁表里,恒解锁
 * (基础武器/敌人/法令全部如此 —— 解锁表只管"入池闸门",不管目录本身)。
 */
function lockIndexOf(kind: number, type: number): number {
  for (let i = 0; i < UNLOCKS.length; i++) {
    const e = UNLOCKS[i]!;
    if (e.kind === kind && e.type === type) return i;
  }
  return -1;
}

/** 造一行:带锁的内容照掩码判定,锁定行把详情换成解锁条件 */
function rowForLocked(
  mask: number,
  kind: number,
  type: number,
  name: string,
  detail: string,
): CodexRow {
  const idx = lockIndexOf(kind, type);
  if (idx >= 0 && (mask & (1 << idx)) === 0) {
    return { name, detail: unlockConditionText(UNLOCKS[idx]!), locked: true };
  }
  return { name, detail, locked: false };
}

/**
 * 武器行详情:合成武器经 MERGES 反查底座名("极光阵列 激光棱镜合3★");其余印射程/伤害/系别。
 * 迫击炮类(FX_MORTAR)直击伤害恒 0、伤害全在落点 —— 印「落点伤害」而不是一个误导性的 0。
 */
function towerDetail(type: number): string {
  const t = TOWERS[type];
  if (t === undefined) return `#${type}`;
  const family = throttleName(t.throttle); // 本身就带「系」字,见 edictSummaryText 同款注释
  for (const r of MERGES) {
    if (r.result === type) return `${TOWERS[r.base]?.name ?? `#${r.base}`}合3★ · ${family}`;
  }
  const dmg = t.fx === FX_MORTAR ? `落点伤害 ${t.aoeDamage}` : `伤害 ${t.damage}`;
  return `射程 ${t.range} · ${dmg} · ${family}`;
}

/**
 * 全量目录:武器 → 敌人 → 法令 → 起手配置(船形剪影是图片,DOM 层直接摆 progress.silhouettes)。
 * 分区标题「武器/敌人」取目录语义,与结算图鉴块的「塔/敌人」分类名并立 ——
 * 那里是解锁项的窄块,这里是通读目录,读法不同(若需统一再并一处)。
 */
export function codexRows(progress: Progress): CodexSection[] {
  const mask = progress.unlockMask;
  const sections: CodexSection[] = [];

  const weapons: CodexRow[] = [];
  for (let type = 0; type < TOWERS.length; type++) {
    weapons.push(rowForLocked(mask, UNLOCK_TOWER, type, TOWERS[type]!.name, towerDetail(type)));
  }
  sections.push({ title: '武器', rows: weapons });

  const enemies: CodexRow[] = [];
  for (const e of ENEMIES) {
    enemies.push({
      name: e.name,
      detail: `HP ${e.hp} · 接触 ${e.contactDamage} · ${behaviorName(e.behavior)}`,
      locked: false,
    });
  }
  // Boss = 放大的冲撞甲虫:HP/接触按底座 × 倍率现算(与 sim 的派生同一条公式)
  const base = ENEMIES[BOSS.baseKind]!;
  enemies.push({
    name: BOSS.name,
    detail:
      `HP ${Math.round(base.hp * BOSS.hpMul)} · 接触 ` +
      `${Math.round(base.contactDamage * BOSS.contactDamageMul)} · 巨型冲锋 · 召唤蜂群`,
    locked: false,
  });
  // 精英事件(UNLOCK_ELITE 条目):命名走 collectionItemName,与结算图鉴同源
  for (let i = 0; i < UNLOCKS.length; i++) {
    const entry = UNLOCKS[i]!;
    if (entry.kind !== UNLOCK_ELITE) continue;
    const locked = (mask & (1 << i)) === 0;
    enemies.push({
      name: collectionItemName(entry),
      detail: locked ? unlockConditionText(entry) : '',
      locked,
    });
  }
  sections.push({ title: '敌人', rows: enemies });

  const edicts: CodexRow[] = [];
  for (const d of EDICTS) {
    edicts.push(rowForLocked(mask, UNLOCK_EDICT, d.type, d.name, edictSummaryText(d)));
  }
  sections.push({ title: '法令', rows: edicts });

  const loadouts: CodexRow[] = [];
  for (let i = 0; i < LOADOUTS.length; i++) {
    loadouts.push(rowForLocked(mask, UNLOCK_LOADOUT, i, LOADOUTS[i]!.name, LOADOUTS[i]!.desc));
  }
  sections.push({ title: '起手配置', rows: loadouts });

  return sections;
}

export interface CodexHooks {
  /** 当前元进度(main 持唯一那一份;每次 show 现读 —— 每局结算后它已更新,不缓存) */
  getProgress(): Progress;
  /** 关掉了(返回按钮 / Esc)。图鉴只从标题进,故只回标题(与 settingsMenu 的 onClose 同一条让路) */
  onClose(): void;
}

export interface CodexUi {
  show(): void;
  hide(): void;
  visible(): boolean;
}

export function createCodexUi(hooks: CodexHooks): CodexUi {
  let visible = false;

  const root = document.createElement('div');
  root.style.cssText = ROOT_CSS;
  const card = document.createElement('div');
  card.style.cssText = CARD_CSS;
  const titleEl = document.createElement('div');
  titleEl.style.cssText = TITLE_CSS;
  const statsEl = document.createElement('div');
  statsEl.style.cssText = STATS_CSS;
  const scrollEl = document.createElement('div');
  scrollEl.style.cssText = SCROLL_CSS;
  const backBtn = document.createElement('button');
  backBtn.style.cssText = BACK_BTN_CSS;
  backBtn.textContent = '返回(Esc)';
  backBtn.addEventListener('click', close);

  card.append(titleEl, statsEl, scrollEl, backBtn);
  root.appendChild(card);
  document.getElementById('ui')!.appendChild(root);

  /**
   * 整块重排:标题/统计照 getProgress 现读,目录整块 replaceChildren 重建 ——
   * 与 gameOver.renderCollection 同一条先例:图鉴一开一次,分配不在铁律 3 的热路径上。
   */
  function render(): void {
    const p = hooks.getProgress();
    const { unlocked, total } = codexUnlockStats(p);
    titleEl.textContent = `图鉴 · 内容解锁 ${unlocked}/${total}`;
    statsEl.textContent = codexStatsText(p);
    scrollEl.replaceChildren();
    for (const section of codexRows(p)) {
      const label = document.createElement('div');
      label.style.cssText = CATEGORY_CSS;
      label.textContent = section.title;
      scrollEl.appendChild(label);
      for (const row of section.rows) {
        const item = document.createElement('div');
        item.style.cssText = row.locked ? ROW_LOCKED_CSS : ROW_CSS;
        if (row.locked) {
          item.textContent = `${row.name}(未解锁 · ${row.detail})`;
        } else {
          item.textContent = row.detail.length > 0 ? `${row.name}  ${row.detail}` : row.name;
        }
        scrollEl.appendChild(item);
      }
    }
    // 船形剪影收尾:全量展示(存档侧本来就限量 10 张);一张都没有给占位,别让这一栏空着
    const label = document.createElement('div');
    label.style.cssText = CATEGORY_CSS;
    label.textContent = '船形剪影';
    scrollEl.appendChild(label);
    if (p.silhouettes.length === 0) {
      const ph = document.createElement('div');
      ph.style.cssText = SHOT_PLACEHOLDER_CSS;
      ph.textContent = '暂无收藏剪影 —— 每局结算自动收录';
      scrollEl.appendChild(ph);
    } else {
      for (const url of p.silhouettes) {
        const thumb = document.createElement('img');
        thumb.style.cssText = SHOT_THUMB_CSS;
        thumb.src = url;
        thumb.alt = '历史船形';
        scrollEl.appendChild(thumb);
      }
    }
  }

  function close(): void {
    if (!visible) return;
    hide();
    hooks.onClose();
  }

  function hide(): void {
    visible = false;
    root.style.display = 'none';
  }

  window.addEventListener('keydown', (e) => {
    if (!visible || e.repeat || isTyping()) return;
    if (e.code !== 'Escape') return;
    e.preventDefault();
    close();
  });

  return {
    show(): void {
      render();
      visible = true;
      root.style.display = 'flex';
    },
    hide,
    visible: () => visible,
  };
}
