/**
 * 图鉴页 —— DOM 覆盖层,**永不 import pixi**(与设置/结算/标题同一条铁律 1 边界)。
 * 入口是标题界面的「图鉴」按钮,关掉后回标题(onClose 由 main 记,本文件只管关掉自己)。
 *
 * **整页只建一次**(与 settingsMenu 同一条纪律):DOM 与 window 监听器都在 createCodexUi 里挂,
 * 反复 show/hide 不重建 —— 建两份就是两份 Esc 监听器、两块遮罩。
 *
 * 布局 = **以图为主**:顶部一行过滤器(全部/武器/敌人/法令),内容是卡片网格 ——
 * 每张卡一张大图(56px)+ 名称,未解锁灰显;具体数值不在网格里占行,悬停弹 tooltip 展示
 * (tooltip 与 HUD 法令悬停同一条"整页只此一个"的口径,pointer-events:none 永不抢鼠标)。
 * **星级三档全部印在悬停里**:1★/2★/3★ 各一行伤害 · 射程 · 射速/充能 —— 旧版只印
 * 数值表 1★ 的底值,2★/3★ 的成长(starLevel 曲线)图上没有数字,玩家还以为高星不涨伤。
 *
 * 配图口径:有生成贴图的用真实 PNG(6 基础塔 / 5 敌型 + Boss,URL 清单与渲染层
 * 同源,见 render/artUrls.ts —— 本文件不 import pixi,但可以 import 纯字符串清单);没贴图的
 * 画程序化 SVG 徽章(合成武器回退底座塔贴图、导弹巢与法令用升级卡片同一套字形 + 数值表 tint)。
 *
 * 「图鉴到底显示了什么」全部走纯函数(codexRows 那一层),Node 里可直接数出来 ——
 * 与 gameOver.summaryText 同一条口径:锁定判定、悬停行、每行配了哪张图,哪一条错
 * 都只是几行字符串拼接,却要等真人进一次图鉴才看得见。
 */
import { isTyping } from '../core/isTyping';
import { AFFIXES } from '../data/affixes';
import {
  BH_SEEK,
  BH_SEEK_CHARGE,
  BH_SPORE,
  BH_STRAFE,
  BH_STRAFE_CHARGE,
  BOSS,
  ENEMIES,
  type EnemyDef,
} from '../data/enemies';
import { EDICT_MAX_LEVEL, EDICTS, type EdictDef } from '../data/edicts';
import { MERGES } from '../data/merges';
import {
  FX_MORTAR,
  THR_CHARGE,
  throttleName,
  towerAoeDamage,
  towerChargeTime,
  towerDamage,
  towerFireInterval,
  towerRange,
  TOWERS,
  type TowerDef,
} from '../data/towers';
import {
  COND_ELITE_KILLS,
  COND_FIRST_WIN,
  COND_KILLS,
  UNLOCK_EDICT,
  UNLOCK_ELITE,
  UNLOCK_TOWER,
  UNLOCKS,
  type UnlockEntry,
} from '../data/unlocks';
import { WAVE_LOCKED_ELITES } from '../data/waves';
import { BOSS_ART_URL, ENEMY_ART_URLS, TOWER_ART_URLS } from '../render/artUrls';
import type { Progress } from '../sim/progress';
import { collectionItemName } from './gameOver';
import { EDICT_ICONS, TOWER_ICONS } from './upgradeFlow';

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
 * 卡片比设置页更宽(640):网格要排得开 13 座塔。竖向 flex + 内层滚动:
 * 标题/过滤器/返回按钮永远在屏内,滚的只是中间那一截网格。
 */
const CARD_CSS =
  'min-width:340px;max-width:min(94vw,640px);max-height:88vh;padding:20px 22px;border-radius:10px;' +
  `background:rgba(10,16,26,.94);border:1px solid ${LINE_COLOR};` +
  'display:flex;flex-direction:column;';

const TITLE_CSS =
  `color:${OK_COLOR};font-size:19px;letter-spacing:.22em;text-align:center;`;
const STATS_CSS =
  `color:${VALUE_COLOR};text-align:center;margin-bottom:6px;letter-spacing:.06em;`;

// —— 过滤器:一排小按钮,选中档高亮。filter 是本页自己的状态,跨 show 保留(整页只建一次)——
const FILTER_ROW_CSS = 'display:flex;gap:6px;margin:6px 0 2px;';
const FILTER_BTN_CSS =
  'padding:3px 10px;border-radius:5px;cursor:pointer;font:inherit;' +
  `border:1px solid rgba(43,74,110,.6);background:rgba(43,74,110,.18);color:${IDLE_COLOR};` +
  'letter-spacing:.08em;';
const FILTER_ON_CSS =
  'padding:3px 10px;border-radius:5px;cursor:pointer;font:inherit;' +
  `border:1px solid ${LINE_COLOR};background:rgba(43,74,110,.55);color:${OK_COLOR};` +
  'letter-spacing:.08em;';

/** 目录滚动区:flex:1 让它占掉卡片剩余高度,内容超高时自己滚,不把返回按钮挤出屏外 */
const SCROLL_CSS = 'flex:1 1 auto;overflow-y:auto;margin-top:4px;padding-right:6px;';
const CATEGORY_CSS = `color:${IDLE_COLOR};font-size:12px;letter-spacing:.12em;margin-top:12px;margin-bottom:6px;`;

/** 卡片网格:每格 76px 起,列数随卡片宽度自适应(13 塔 ≈ 6-7 列 × 2 行) */
const GRID_CSS = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(76px,1fr));gap:8px;';
/** 图鉴卡片:图上名下;锁定卡整卡降透明度(图跟着一起压暗,与结算图鉴同一套灰显) */
const CELL_CSS =
  'display:flex;flex-direction:column;align-items:center;gap:4px;padding:7px 2px 5px;' +
  'border-radius:6px;border:1px solid rgba(43,74,110,.45);background:rgba(10,16,26,.5);';
const CELL_LOCKED_CSS = CELL_CSS + 'opacity:.45;';
/** 配图容器:恒定 56px 高,单图 56px —— 网格行高不因配图张数参差 */
const CELL_ART_CSS = 'display:flex;gap:3px;align-items:center;height:56px;';
const CELL_IMG_CSS = 'object-fit:contain;background:rgba(5,7,13,.6);' +
  'border:1px solid rgba(43,74,110,.6);border-radius:4px;';
const CELL_NAME_CSS =
  `font-size:11px;color:${VALUE_COLOR};text-align:center;line-height:1.3;letter-spacing:.02em;`;

/** 悬停 tooltip:整页只此一个,pointer-events:none 永不抢鼠标(与 HUD 法令悬停同一条口径) */
const TIP_CSS =
  'position:fixed;display:none;max-width:300px;white-space:pre-line;line-height:1.55;' +
  'z-index:1000;pointer-events:none;background:rgba(10,16,26,.97);' +
  `border:1px solid rgba(43,74,110,.8);border-radius:6px;padding:8px 10px;` +
  `color:${VALUE_COLOR};font-size:12px;`;

const BACK_BTN_CSS =
  'display:block;width:100%;padding:9px 0;border-radius:6px;cursor:pointer;font:inherit;' +
  `border:1px solid ${LINE_COLOR};background:rgba(43,74,110,.28);color:${OK_COLOR};` +
  'letter-spacing:.1em;margin-top:14px;';

// —— 纯函数层:图鉴「显示了什么」(含悬停行),Node 里可测 ——

/** 解锁条件文案(未解锁条目的悬停末条 —— 只说清"差什么",不说怎么玩) */
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

/** 数值印法:两位小数内舍入、尾零省掉(1.25 / 1.5 / 0.7,不印 1.250) */
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

/** 内容解锁计数(与结算图鉴同口径:数掩码置位) */
export function codexUnlockStats(progress: Progress): { unlocked: number; total: number } {
  let total = 0;
  let unlocked = 0;
  for (let i = 0; i < UNLOCKS.length; i++) {
    total++;
    if ((progress.unlockMask & (1 << i)) !== 0) unlocked++;
  }
  return { unlocked, total };
}

/**
 * 一行的配图。两种来路:真实贴图(PNG,清单与渲染层同源)或程序化 SVG 徽章
 * (无贴图条目:导弹巢与法令,字形 + 数值表 tint)。null = 没配到图,DOM 只摆文字。
 */
export type CodexArt = { kind: 'img'; urls: string[] } | { kind: 'svg'; svg: string };

/** 图鉴一行:名称 + 锁定标记 + 配图 + 悬停行(具体数值全部在悬停里,网格只摆图与名) */
export interface CodexRow {
  name: string;
  locked: boolean;
  art: CodexArt | null;
  /** 悬停 tooltip 的行:首行标题,其余具体数值;锁定行末条 = 「未解锁 · 条件」 */
  hover: string[];
}

export interface CodexSection {
  /** 过滤器键:'weapons' | 'enemies' | 'edicts'(DOM 层按它过滤) */
  key: string;
  title: string;
  rows: CodexRow[];
}

/** 数字 tint → "#rrggbb"(SVG 徽章要的是 CSS 颜色串;数值表存的是 Pixi 数字色) */
export function tintHex(v: number): string {
  return `#${(v & 0xffffff).toString(16).padStart(6, '0')}`;
}

/**
 * 程序化徽章(无贴图条目的配图):暗底圆盘 + tint 虚线环 + 中心字形 ——
 * 结构与 assets/game/ui/edict-seal.svg 同族,但字形与 tint 跟条目走,
 * 升级卡片与图鉴共用同一套「型号 → 字形」身份(见 upgradeFlow 的 EDICT_ICONS/TOWER_ICONS)。
 */
export function glyphBadgeSvg(glyph: string, tint: string): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">' +
    '<circle cx="24" cy="24" r="21" fill="#091625" stroke="#2b4a6e" stroke-width="2.5"/>' +
    '<circle cx="24" cy="24" r="15.5" fill="none" stroke="' +
    tint +
    '" stroke-width="2.5" stroke-dasharray="7 5" opacity=".85"/>' +
    // 字形是给图鉴/升级卡看的身份符号,字体跟全 UI 同一支等宽栈:
    // img 里的 SVG 不继承页面字体,不写就落系统默认字(冷僻字形如 ⟲ 可能变成豆腐块)
    '<text x="24" y="25" font-size="17" text-anchor="middle" dominant-baseline="central" ' +
    'font-family="ui-monospace,SFMono-Regular,Menlo,monospace" fill="' +
    tint +
    '">' +
    glyph +
    '</text></svg>'
  );
}

/** 真实贴图配图:过滤掉 undefined(表里加了新型但还没出图时,那一张静默跳过) */
function imgArt(...urls: Array<string | undefined>): CodexArt | null {
  const found: string[] = [];
  for (const u of urls) if (u !== undefined) found.push(u);
  return found.length === 0 ? null : { kind: 'img', urls: found };
}

/**
 * 武器配图:基础塔(0..5)用本塔贴图;合成塔(6..11)回退**底座塔贴图**
 * (它们由底座 3★ 变身而来,悬停里标"底座合3★"两相印证 —— 渲染层对它们也只有 tint 色块兜底,
 * 图鉴给底座图反而比游戏里更易认);导弹巢与未知型画字形徽章。
 */
export function towerArt(type: number): CodexArt | null {
  if (type >= 0 && type < TOWER_ART_URLS.length) return imgArt(TOWER_ART_URLS[type]);
  for (const r of MERGES) {
    if (r.result === type) return imgArt(TOWER_ART_URLS[r.base]);
  }
  const def = TOWERS[type];
  if (def === undefined) return null;
  return { kind: 'svg', svg: glyphBadgeSvg(TOWER_ICONS[type] ?? '?', tintHex(def.tint)) };
}

/** 法令配图:字形徽章,字形与升级卡片同表、tint 取数值表(与卡片色域同一支冷色) */
export function edictArt(type: number): CodexArt | null {
  const def = EDICTS[type];
  if (def === undefined) return null;
  return {
    kind: 'svg',
    svg: glyphBadgeSvg(EDICT_ICONS[type] ?? '?', tintHex(def.tint)),
  };
}

/**
 * 一条星级读数:伤害(迫击炮类印落点伤害,直击恒 0)· 射程 · 射速/充能。
 * **1★/2★/3★ 三档全印** —— 星级成长走 data/towers 的 starLevel 曲线,2★ = 旧 Lv3、
 * 3★ = 旧 Lv5,数值由同表的 towerDamage/towerRange 等 getter 现算(与 sim 同一份函数,
 * 图鉴印的与游戏里打的永远同一个数)。
 */
function starLine(def: TowerDef, stars: number): string {
  const dmg = def.fx === FX_MORTAR ? towerAoeDamage(def, stars) : towerDamage(def, stars);
  const range = Math.round(towerRange(def, stars));
  if (def.throttle === THR_CHARGE) {
    return (
      `${'★'.repeat(stars)} ${def.fx === FX_MORTAR ? '落点伤害' : '伤害'} ${formatMul(dmg)} · ` +
      `射程 ${range} · 充能 ${formatMul(towerChargeTime(def, stars))}s`
    );
  }
  const interval = towerFireInterval(def, stars);
  const rate = interval > 0 ? formatMul(1 / interval) : '—';
  return (
    `${'★'.repeat(stars)} ${def.fx === FX_MORTAR ? '落点伤害' : '伤害'} ${formatMul(dmg)} · ` +
    `射程 ${range} · 射速 ${rate}/s`
  );
}

/** 武器悬停行:标题(合成武器带血统)+ 三条星级读数 */
export function weaponHover(type: number): string[] {
  const def = TOWERS[type];
  if (def === undefined) return [`未知塔型 #${type}`];
  let head = `${def.name} · ${throttleName(def.throttle)}`;
  for (const r of MERGES) {
    if (r.result === type) {
      head = `${def.name} · 由${TOWERS[r.base]?.name ?? '?'}合${'★'.repeat(3)}变身 · ${throttleName(def.throttle)}`;
    }
  }
  return [head, starLine(def, 1), starLine(def, 2), starLine(def, 3)];
}

/** 敌型悬停行:标题 + 身板 + 掉落(残骸是升级资源、星币是商店货币,两样都报) */
function enemyHover(e: EnemyDef): string[] {
  return [
    `${e.name} · ${behaviorName(e.behavior)}`,
    `HP ${e.hp} · 接触 ${e.contactDamage}`,
    `残骸 ${e.scrap} · 星币 ${e.starCoins}`,
  ];
}

/** 精英悬停行:词缀名单读数据表(affixes 下标 → 名字),锁定追加条件 */
function eliteHover(entry: UnlockEntry): string[] {
  const lines: string[] = [collectionItemName(entry)];
  const elite = WAVE_LOCKED_ELITES[entry.type];
  if (elite !== undefined) {
    const names: string[] = [];
    for (const a of elite.affixes) names.push(AFFIXES[a]?.name ?? `#${a}`);
    lines.push(`词缀 ${names.join(' · ')}`);
  }
  return lines;
}

/** 法令悬停行:效果摘要 + 叠层上限(满层即从卡池剔出,上限就是"这条能推多深") */
export function edictHover(type: number): string[] {
  const def = EDICTS[type];
  if (def === undefined) return [`未知法令 #${type}`];
  return [edictSummaryText(def), `最多 ${EDICT_MAX_LEVEL} 层`];
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

/** 造一行:带锁的内容照掩码判定,锁定行在悬停末条追加解锁条件(灰显交给 DOM 的 opacity) */
function rowForLocked(
  mask: number,
  kind: number,
  type: number,
  name: string,
  hover: string[],
  art: CodexArt | null,
): CodexRow {
  const idx = lockIndexOf(kind, type);
  if (idx >= 0 && (mask & (1 << idx)) === 0) {
    return {
      name,
      locked: true,
      art,
      hover: [...hover, `未解锁 · ${unlockConditionText(UNLOCKS[idx]!)}`],
    };
  }
  return { name, locked: false, art, hover };
}

/**
 * 全量目录:武器 → 敌人 → 法令。
 * 分区标题「武器/敌人」取目录语义,与结算图鉴块的「塔/敌人」分类名并立 ——
 * 那里是解锁项的窄块,这里是通读目录,读法不同(若需统一再并一处)。
 */
export function codexRows(progress: Progress): CodexSection[] {
  const mask = progress.unlockMask;
  const sections: CodexSection[] = [];

  const weapons: CodexRow[] = [];
  for (let type = 0; type < TOWERS.length; type++) {
    weapons.push(
      rowForLocked(mask, UNLOCK_TOWER, type, TOWERS[type]!.name, weaponHover(type), towerArt(type)),
    );
  }
  sections.push({ key: 'weapons', title: '武器', rows: weapons });

  const enemies: CodexRow[] = [];
  for (const e of ENEMIES) {
    enemies.push({
      name: e.name,
      locked: false,
      art: imgArt(ENEMY_ART_URLS[e.kind]),
      hover: enemyHover(e),
    });
  }
  // Boss = 放大的冲撞甲虫:HP/接触按底座 × 倍率现算(与 sim 的派生同一条公式)
  const base = ENEMIES[BOSS.baseKind]!;
  enemies.push({
    name: BOSS.name,
    locked: false,
    art: imgArt(BOSS_ART_URL),
    hover: [
      `${BOSS.name} · 巨型冲锋 · 召唤蜂群`,
      `HP ${Math.round(base.hp * BOSS.hpMul)} · 接触 ` +
        `${Math.round(base.contactDamage * BOSS.contactDamageMul)}`,
      `星币 ${BOSS.starCoins} · 体型 ×${BOSS.scale}`,
    ],
  });
  // 精英事件(UNLOCK_ELITE 条目):命名走 collectionItemName(与结算图鉴同源),
  // 配图用底座敌型的贴图 —— 精英就是"带词缀的底座",图同一张
  for (let i = 0; i < UNLOCKS.length; i++) {
    const entry = UNLOCKS[i]!;
    if (entry.kind !== UNLOCK_ELITE) continue;
    const locked = (mask & (1 << i)) === 0;
    const eliteKind = WAVE_LOCKED_ELITES[entry.type]?.kind;
    const hover = locked
      ? [...eliteHover(entry), `未解锁 · ${unlockConditionText(entry)}`]
      : eliteHover(entry);
    enemies.push({
      name: collectionItemName(entry),
      locked,
      art: eliteKind === undefined ? null : imgArt(ENEMY_ART_URLS[eliteKind]),
      hover,
    });
  }
  sections.push({ key: 'enemies', title: '敌人', rows: enemies });

  const edicts: CodexRow[] = [];
  for (const d of EDICTS) {
    edicts.push(
      rowForLocked(mask, UNLOCK_EDICT, d.type, d.name, edictHover(d.type), edictArt(d.type)),
    );
  }
  sections.push({ key: 'edicts', title: '法令', rows: edicts });

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

/** 过滤器档位:值与 CodexSection.key 一一对应,'all' = 全部显示 */
const FILTERS: Array<{ key: string; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'weapons', label: '武器' },
  { key: 'enemies', label: '敌人' },
  { key: 'edicts', label: '法令' },
];

export function createCodexUi(hooks: CodexHooks): CodexUi {
  let visible = false;
  /** 本页自己的过滤器状态:跨 show 保留(整页只建一次,与设置页的拨档同一份口径) */
  let filter = 'all';

  const root = document.createElement('div');
  root.style.cssText = ROOT_CSS;
  const card = document.createElement('div');
  card.style.cssText = CARD_CSS;
  const titleEl = document.createElement('div');
  titleEl.style.cssText = TITLE_CSS;
  const statsEl = document.createElement('div');
  statsEl.style.cssText = STATS_CSS;

  // 过滤器按钮:只建一次,选中档由 paintFilters 按 filter 现刷
  const filterRow = document.createElement('div');
  filterRow.style.cssText = FILTER_ROW_CSS;
  const filterBtns = new Map<string, HTMLButtonElement>();
  for (const f of FILTERS) {
    const btn = document.createElement('button');
    btn.textContent = f.label;
    btn.addEventListener('click', () => {
      filter = f.key;
      paintFilters();
      render();
    });
    filterBtns.set(f.key, btn);
    filterRow.appendChild(btn);
  }

  const scrollEl = document.createElement('div');
  scrollEl.style.cssText = SCROLL_CSS;
  const backBtn = document.createElement('button');
  backBtn.style.cssText = BACK_BTN_CSS;
  backBtn.textContent = '返回(Esc)';
  backBtn.addEventListener('click', close);

  // 悬停 tooltip:整页只此一个(与 HUD 法令悬停同一条口径),卡片悬停点亮、移开即隐
  const tip = document.createElement('div');
  tip.style.cssText = TIP_CSS;

  card.append(titleEl, statsEl, filterRow, scrollEl, backBtn);
  root.append(card, tip);
  document.getElementById('ui')!.appendChild(root);

  /** 过滤器按钮的选中态:选中的高亮,其余回落 */
  function paintFilters(): void {
    for (const f of FILTERS) {
      filterBtns.get(f.key)!.style.cssText = f.key === filter ? FILTER_ON_CSS : FILTER_BTN_CSS;
    }
  }

  /** 一张卡:配图容器 + 名称;悬停点亮 tooltip(定位在卡下方,贴屏边时夹回) */
  function appendCell(grid: HTMLElement, row: CodexRow): void {
    const cell = document.createElement('div');
    cell.style.cssText = row.locked ? CELL_LOCKED_CSS : CELL_CSS;
    if (row.art !== null) {
      const artBox = document.createElement('div');
      artBox.style.cssText = CELL_ART_CSS;
      const size = row.art.kind === 'img' && row.art.urls.length > 1 ? '34px' : '56px';
      if (row.art.kind === 'img') {
        for (const url of row.art.urls) {
          const img = document.createElement('img');
          img.style.cssText = CELL_IMG_CSS + `width:${size};height:${size};`;
          img.src = url;
          img.alt = '图鉴图标';
          artBox.appendChild(img);
        }
      } else {
        const img = document.createElement('img');
        img.style.cssText = CELL_IMG_CSS + `width:${size};height:${size};`;
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(row.art.svg)}`;
        img.alt = '图鉴图标';
        artBox.appendChild(img);
      }
      cell.appendChild(artBox);
    }
    const name = document.createElement('div');
    name.style.cssText = CELL_NAME_CSS;
    name.textContent = row.name;
    cell.appendChild(name);
    cell.addEventListener('mouseenter', () => {
      tip.textContent = row.hover.join('\n');
      tip.style.display = 'block';
      const rect = cell.getBoundingClientRect();
      // 贴卡片下沿;右缘会越出视口时夹回(与 HUD tooltip 同一条"永远可读"的口径)
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - 316));
      tip.style.left = `${left}px`;
      tip.style.top = `${rect.bottom + 6}px`;
    });
    cell.addEventListener('mouseleave', () => {
      tip.style.display = 'none';
    });
    grid.appendChild(cell);
  }

  /** 整块重排:标题/统计照 getProgress 现读,网格整块 replaceChildren 重建 —— 与
   * gameOver.renderCollection 同一条先例:图鉴一开一次,分配不在铁律 3 的热路径上。 */
  function render(): void {
    const p = hooks.getProgress();
    const { unlocked, total } = codexUnlockStats(p);
    titleEl.textContent = `图鉴 · 内容解锁 ${unlocked}/${total}`;
    statsEl.textContent = codexStatsText(p);
    scrollEl.replaceChildren();
    for (const section of codexRows(p)) {
      if (filter !== 'all' && section.key !== filter) continue;
      const label = document.createElement('div');
      label.style.cssText = CATEGORY_CSS;
      label.textContent = section.title;
      scrollEl.appendChild(label);
      const grid = document.createElement('div');
      grid.style.cssText = GRID_CSS;
      for (const row of section.rows) appendCell(grid, row);
      scrollEl.appendChild(grid);
    }
  }

  function close(): void {
    if (!visible) return;
    hide();
    hooks.onClose();
  }

  function hide(): void {
    visible = false;
    tip.style.display = 'none'; // 悬停的 tooltip 别留到下一次打开
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
      paintFilters();
      render();
      visible = true;
      root.style.display = 'flex';
    },
    hide,
    visible: () => visible,
  };
}
