/**
 * 图鉴页 —— DOM 覆盖层,**永不 import pixi**(与设置/结算/标题同一条铁律 1 边界)。
 * 入口是标题界面的「图鉴」按钮,关掉后回标题(onClose 由 main 记,本文件只管关掉自己)。
 *
 * **整页只建一次**(与 settingsMenu 同一条纪律):DOM 与 window 监听器都在 createCodexUi 里挂,
 * 反复 show/hide 不重建 —— 建两份就是两份 Esc 监听器、两块遮罩。
 *
 * 布局 = **以图为主**:顶部一行过滤器(全部/武器/敌人/法令),内容是卡片网格 ——
 * 每张卡配图 + 名称,未解锁灰显;具体数值不在网格里占行,悬停弹 tooltip 展示
 * (tooltip 与 HUD 法令悬停同一条"整页只此一个"的口径,pointer-events:none 永不抢鼠标)。
 * **武器卡是星级三档缩略图**(同一张贴图按战斗倍率放大三张,图下各标 ★/★★/★★★ ——
 * 游戏里 2★/3★ 的炮头就是放大件,不标星数玩家认不出图上画的是几星的枪);敌/法令仍一张大图。
 * **星级三档数值全部印在悬停里**:1★/2★/3★ 各一行伤害 · 射程 · 射速/充能 —— 旧版只印
 * 数值表 1★ 的底值,2★/3★ 的成长(starLevel 曲线)图上没有数字,玩家还以为高星不涨伤。
 *
 * 配图口径:有生成贴图的用真实 PNG(13 武器型号 / 5 敌型 + Boss,URL 清单与渲染层
 * 同源,见 render/artUrls.ts —— 本文件不 import pixi,但可以 import 纯字符串清单);没贴图的
 * 未知新型号与法令画程序化 SVG 徽章(升级卡片同一套字形 + 数值表 tint)。
 *
 * 「图鉴到底显示了什么」全部走纯函数(codexRows 那一层),Node 里可直接数出来 ——
 * 与 gameOver.summaryText 同一条口径:锁定判定、悬停行、每行配了哪张图,哪一条错
 * 都只是几行字符串拼接,却要等真人进一次图鉴才看得见。
 */
import { isTyping } from '../core/isTyping';
import {
  BOSS,
  ENEMIES,
  type EnemyDef,
} from '../data/enemies';
import { EDICT_MAX_LEVEL, EDICTS } from '../data/edicts';
import { MERGES } from '../data/merges';
import {
  FX_MORTAR,
  THR_CHARGE,
  towerAoeDamage,
  towerChargeTime,
  towerDamage,
  towerFireInterval,
  towerRange,
  TOWERS,
  type TowerDef,
} from '../data/towers';
import {
  UNLOCK_EDICT,
  UNLOCK_ELITE,
  UNLOCK_TOWER,
  UNLOCKS,
  type UnlockEntry,
} from '../data/unlocks';
import { WAVE_LOCKED_ELITES } from '../data/waves';
import { t } from '../i18n';
import { BOSS_ART_URL, ENEMY_ART_URLS, TOWER_ART_URLS, TOWER_STAR_HEAD_SCALES } from '../render/artUrls';
import type { Progress } from '../sim/progress';
import { collectionItemName } from './gameOver';
import { EDICT_ICONS, TOWER_ICONS } from './upgradeFlow';
import {
  affixName,
  bossName,
  edictName,
  enemyName,
  throttleFamilyName,
  weaponDisplayName,
} from './presentation/contentText';
import { behaviorName } from './presentation/behaviorText';
import { edictSummaryText } from './presentation/edictText';
import { unlockConditionText } from './presentation/unlockText';

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

/** 卡片网格:每格 76px 起,列数随卡片宽度自适应(敌人/法令 ≈ 6-7 列) */
const GRID_CSS = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(76px,1fr));gap:8px;';
/** 武器网格:星级三档缩略图并排 ≈ 96px + 卡片内边距,最小列宽放宽到 108px,别把三档图挤溢出 */
const GRID_WEAPONS_CSS =
  'display:grid;grid-template-columns:repeat(auto-fill,minmax(108px,1fr));gap:8px;';
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

/**
 * 星级三档缩略图:每档一列(图 + 星数标签),三列并排,1★ 基准 26px、
 * 2★/3★ 按 TOWER_STAR_HEAD_SCALES 放大(26/30/34px) —— 与战斗里的炮位放大同一份倍率。
 * 标签色与 renderer 的 FX_STAR_COLORS 同一份(1★ 冷蓝/2★ 金/3★ 亮金):金色留给星级徽记,
 * 与 docs/weapon-star-fire-patterns「金色只用于星级徽记」同一条口径。
 */
const STAR_THUMB_COL_CSS = 'display:flex;flex-direction:column;align-items:center;gap:2px;';
const STAR_LABEL_CSS = 'font-size:10px;line-height:1;letter-spacing:.02em;';
const STAR_LABEL_COLORS = ['#9adcff', '#ffd479', '#fff1a8'] as const;
const STAR_THUMB_BASE_PX = 26;

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

/** 数值印法:两位小数内舍入、尾零省掉(1.25 / 1.5 / 0.7,不印 1.250) */
export function formatMul(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/** 统计行:三个累计计数器,与结算界面的元进度读数同源 */
export function codexStatsText(p: Progress): string {
  return t('ui:codex.stats', { wins: p.wins, kills: p.kills, eliteKills: p.eliteKills });
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
 * 一行的配图。三种来路:真实贴图(PNG,清单与渲染层同源)、星级三档(武器:同一张贴图按
 * 战斗里的星级倍率 1/1.16/1.32 放大,图下各标 ★/★★/★★★)或程序化 SVG 徽章
 * (数据表先加了新型而贴图还没跟上时:字形 + 数值表 tint)。null = 没配到图,DOM 只摆文字。
 */
export type CodexArt =
  | { kind: 'img'; urls: string[] }
  | { kind: 'stars'; url: string }
  | { kind: 'svg'; svg: string };

/** 图鉴一行:名称 + 锁定标记 + 配图 + 悬停行(具体数值全部在悬停里,网格只摆图与名) */
export interface CodexRow {
  name: string;
  locked: boolean;
  art: CodexArt | null;
  /** 悬停 tooltip 的行:首行标题,其余具体数值;锁定行末条 = 「未解锁 · 条件」 */
  hover: string[];
  /**
   * 稳定身份(不随语言变):武器/法令 = 数值 type,敌人 = kind,Boss = 'boss',精英 = 解锁条目 id。
   * DOM 层写进 `data-content-id`,测试与自动化用它找行,不再拿中文名当唯一身份。
   */
  id?: string;
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
 * 武器配图:round-8 清单已覆盖全部 13 个型号(合成塔条目复用对应血统炮头)。
 * 武器行是**星级三档**:同一张贴图按战斗里的倍率放大三张,图下各标星数 ——
 * 游戏里 2★/3★ 的炮头就是放大件(1.16/1.32,见 renderer 与 docs/weapon-star-fire-patterns),
 * 图鉴不标星数,玩家就看不出图上画的是几星的枪。以后数据表先加了新型、贴图还没补上时,
 * 再按 MERGES 回退底座或画字形徽章。
 */
export function towerArt(type: number): CodexArt | null {
  let url: string | undefined = TOWER_ART_URLS[type];
  if (url === undefined) {
    for (const r of MERGES) {
      if (r.result === type) {
        url = TOWER_ART_URLS[r.base];
        break;
      }
    }
  }
  if (url !== undefined) return { kind: 'stars', url };
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
export function starLine(def: TowerDef, stars: number): string {
  const dmg = def.fx === FX_MORTAR ? towerAoeDamage(def, stars) : towerDamage(def, stars);
  const range = Math.round(towerRange(def, stars));
  const star = '★'.repeat(stars);
  const dmgKey = def.fx === FX_MORTAR ? 'ui:codex.star.mortarDamage' : 'ui:codex.star.damage';
  const head = t(dmgKey, { stars: star, dmg: formatMul(dmg) });
  if (def.throttle === THR_CHARGE) {
    const sec = formatMul(towerChargeTime(def, stars));
    return `${head} · ${t('ui:codex.star.range', { range })} · ${t('ui:codex.star.charge', { sec })}`;
  }
  const interval = towerFireInterval(def, stars);
  const rate = interval > 0 ? formatMul(1 / interval) : '—';
  return `${head} · ${t('ui:codex.star.range', { range })} · ${t('ui:codex.star.rate', { rate })}`;
}

/** 武器悬停行:标题(合成武器带血统)+ 三条星级读数 */
export function weaponHover(type: number): string[] {
  const def = TOWERS[type];
  if (def === undefined) return [t('ui:codex.weapon.unknown', { type })];
  let head = `${weaponDisplayName(type)} · ${throttleFamilyName(def.throttle)}`;
  for (const r of MERGES) {
    if (r.result === type) {
      // 血统行不报底座名:合成武器显示名 = 底座名(用户口径「三星武器不改名字」),报了就是自己合自己
      head = t('ui:codex.weapon.head.fusion', {
        name: weaponDisplayName(type),
        stars: '★'.repeat(3),
        family: throttleFamilyName(def.throttle),
      });
    }
  }
  return [head, starLine(def, 1), starLine(def, 2), starLine(def, 3)];
}

/** 敌型悬停行:标题 + 身板 + 掉落(残骸是升级资源、星币是商店货币,两样都报) */
export function enemyHover(e: EnemyDef): string[] {
  return [
    `${enemyName(e.kind)} · ${behaviorName(e.behavior)}`,
    t('ui:codex.enemy.hp', { hp: e.hp, dmg: e.contactDamage }),
    t('ui:codex.enemy.drops', { scrap: e.scrap, coins: e.starCoins }),
  ];
}

/** 精英悬停行:词缀名单走 presenter(affixes 下标 → 名字),锁定追加条件 */
export function eliteHover(entry: UnlockEntry): string[] {
  const lines: string[] = [collectionItemName(entry)];
  const elite = WAVE_LOCKED_ELITES[entry.type];
  if (elite !== undefined) {
    const names: string[] = [];
    for (const a of elite.affixes) names.push(affixName(a));
    lines.push(t('ui:codex.elite.affixes', { list: names.join(' · ') }));
  }
  return lines;
}

/** 法令悬停行:效果摘要 + 叠层上限(满层即从卡池剔出,上限就是"这条能推多深") */
export function edictHover(type: number): string[] {
  const def = EDICTS[type];
  if (def === undefined) return [t('ui:codex.edict.unknown', { type })];
  return [edictSummaryText(def), t('ui:codex.edict.maxLevel', { max: EDICT_MAX_LEVEL })];
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
  id: string,
): CodexRow {
  const idx = lockIndexOf(kind, type);
  if (idx >= 0 && (mask & (1 << idx)) === 0) {
    return {
      name,
      locked: true,
      art,
      id,
      hover: [...hover, t('ui:codex.locked', { cond: unlockConditionText(UNLOCKS[idx]!) })],
    };
  }
  return { name, locked: false, art, id, hover };
}

/**
 * 全量目录:武器 → 敌人 → 法令。
 * 分区标题取 `ui.codex.section.*`(与结算图鉴块的分类名各自成段,读法不同 ——
 * 那里是解锁项的窄块,这里是通读目录)。
 */
export function codexRows(progress: Progress): CodexSection[] {
  const mask = progress.unlockMask;
  const sections: CodexSection[] = [];

  const weapons: CodexRow[] = [];
  for (let type = 0; type < TOWERS.length; type++) {
    weapons.push(
      rowForLocked(
        mask,
        UNLOCK_TOWER,
        type,
        weaponDisplayName(type),
        weaponHover(type),
        towerArt(type),
        String(type),
      ),
    );
  }
  sections.push({ key: 'weapons', title: t('ui:codex.section.weapons'), rows: weapons });

  const enemies: CodexRow[] = [];
  for (const e of ENEMIES) {
    enemies.push({
      name: enemyName(e.kind),
      locked: false,
      art: imgArt(ENEMY_ART_URLS[e.kind]),
      hover: enemyHover(e),
      id: String(e.kind),
    });
  }
  // Boss = 放大的冲撞甲虫:HP/接触按底座 × 倍率现算(与 sim 的派生同一条公式)
  const base = ENEMIES[BOSS.baseKind]!;
  enemies.push({
    name: bossName(),
    locked: false,
    art: imgArt(BOSS_ART_URL),
    id: 'boss',
    hover: [
      t('ui:codex.boss.head', { name: bossName() }),
      t('ui:codex.boss.stats', {
        hp: Math.round(base.hp * BOSS.hpMul),
        dmg: Math.round(base.contactDamage * BOSS.contactDamageMul),
      }),
      t('ui:codex.boss.rewards', { coins: BOSS.starCoins, scale: BOSS.scale }),
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
      ? [...eliteHover(entry), t('ui:codex.locked', { cond: unlockConditionText(entry) })]
      : eliteHover(entry);
    enemies.push({
      name: collectionItemName(entry),
      locked,
      art: eliteKind === undefined ? null : imgArt(ENEMY_ART_URLS[eliteKind]),
      hover,
      id: entry.id,
    });
  }
  sections.push({ key: 'enemies', title: t('ui:codex.section.enemies'), rows: enemies });

  const edicts: CodexRow[] = [];
  for (const d of EDICTS) {
    edicts.push(
      rowForLocked(
        mask,
        UNLOCK_EDICT,
        d.type,
        edictName(d.type),
        edictHover(d.type),
        edictArt(d.type),
        String(d.type),
      ),
    );
  }
  sections.push({ key: 'edicts', title: t('ui:codex.section.edicts'), rows: edicts });

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
  /** 语言切换成功后原地重画文案:保留筛选/滚动/掩码/统计(只重画,不重建监听、不改 filter) */
  refreshLocale(): void;
}

/** 过滤器档位:值与 CodexSection.key 一一对应,'all' = 全部显示。key 恒稳定(切换语言不变),label 现读 t() */
const FILTERS = [
  { key: 'all', labelKey: 'ui:codex.filter.all' },
  { key: 'weapons', labelKey: 'ui:codex.filter.weapons' },
  { key: 'enemies', labelKey: 'ui:codex.filter.enemies' },
  { key: 'edicts', labelKey: 'ui:codex.filter.edicts' },
] as const;

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
    btn.textContent = t(f.labelKey);
    btn.setAttribute('data-filter', f.key);
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
  backBtn.setAttribute('data-action', 'codex-back');
  backBtn.textContent = t('ui:codex.back', { esc: t('common:keys.esc') });
  backBtn.addEventListener('click', close);

  // 悬停 tooltip:整页只此一个(与 HUD 法令悬停同一条口径),卡片悬停点亮、移开即隐
  const tip = document.createElement('div');
  tip.style.cssText = TIP_CSS;

  card.append(titleEl, statsEl, filterRow, scrollEl, backBtn);
  root.append(card, tip);
  document.getElementById('ui')!.appendChild(root);

  /** 静态 chrome(返回按钮):show 与 refreshLocale 共用 —— 语言切换发生在图鉴收着时,
   * refreshLocale 会提前返回,于是 show 也要按当前语言刷它(标题/统计/网格/alt 在 render 里现读) */
  function paintStatic(): void {
    backBtn.textContent = t('ui:codex.back', { esc: t('common:keys.esc') });
  }

  /** 过滤器按钮的选中态:选中的高亮,其余回落;标签现读 t()(语言切换后 paintFilters 一起重刷) */
  function paintFilters(): void {
    for (const f of FILTERS) {
      const btn = filterBtns.get(f.key)!;
      btn.textContent = t(f.labelKey);
      btn.style.cssText = f.key === filter ? FILTER_ON_CSS : FILTER_BTN_CSS;
    }
  }

  /** 一张卡:配图容器 + 名称;悬停点亮 tooltip(定位在卡下方,贴屏边时夹回)。
   * data-content-kind = 分区键、data-content-id = 行 id(见 CodexRow.id)——
   * 测试与自动化用它们定位行,不拿本地化名称当唯一身份。 */
  function appendCell(grid: HTMLElement, row: CodexRow, kind: string): void {
    const cell = document.createElement('div');
    cell.style.cssText = row.locked ? CELL_LOCKED_CSS : CELL_CSS;
    cell.dataset.contentKind = kind;
    cell.dataset.contentId = row.id ?? '';
    if (row.art !== null) {
      const artBox = document.createElement('div');
      artBox.style.cssText = CELL_ART_CSS;
      if (row.art.kind === 'stars') {
        // 星级三档缩略图:同一张贴图按战斗倍率放大,每档图下各标星数 ——
        // 不标的话 2★/3★ 只是同图变大小,玩家认不出图上画的是几星的枪
        for (let s = 0; s < 3; s++) {
          const col = document.createElement('div');
          col.style.cssText = STAR_THUMB_COL_CSS;
          const img = document.createElement('img');
          const px = Math.round(STAR_THUMB_BASE_PX * (TOWER_STAR_HEAD_SCALES[s] ?? 1));
          img.style.cssText = CELL_IMG_CSS + `width:${px}px;height:${px}px;`;
          img.src = row.art.url;
          img.alt = `${row.name} ${'★'.repeat(s + 1)}`;
          const label = document.createElement('div');
          label.style.cssText = STAR_LABEL_CSS + `color:${STAR_LABEL_COLORS[s] ?? '#ffd479'};`;
          label.textContent = '★'.repeat(s + 1);
          col.append(img, label);
          artBox.appendChild(col);
        }
      } else if (row.art.kind === 'img') {
        const size = row.art.urls.length > 1 ? '34px' : '56px';
        for (const url of row.art.urls) {
          const img = document.createElement('img');
          img.style.cssText = CELL_IMG_CSS + `width:${size};height:${size};`;
          img.src = url;
          img.alt = t('ui:codex.alt');
          artBox.appendChild(img);
        }
      } else {
        const img = document.createElement('img');
        img.style.cssText = CELL_IMG_CSS + 'width:56px;height:56px;';
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(row.art.svg)}`;
        img.alt = t('ui:codex.alt');
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
    titleEl.textContent = t('ui:codex.title', { unlocked, total });
    statsEl.textContent = codexStatsText(p);
    scrollEl.replaceChildren();
    for (const section of codexRows(p)) {
      if (filter !== 'all' && section.key !== filter) continue;
      const label = document.createElement('div');
      label.style.cssText = CATEGORY_CSS;
      label.textContent = section.title;
      scrollEl.appendChild(label);
      const grid = document.createElement('div');
      grid.style.cssText = section.key === 'weapons' ? GRID_WEAPONS_CSS : GRID_CSS;
      for (const row of section.rows) appendCell(grid, row, section.key);
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

  /**
   * 语言切换成功后原地重画(08 号)。图鉴只建一次,切换不能靠销毁重建 ——
   * 重画走 render()(标题/统计/网格整块重排),**保留**:
   *   - filter(闭包里的本地状态,render 只读它,不重置);
   *   - 滚动位置(先记 scrollEl.scrollTop,重排后还原 —— 重排会先滚回顶);
   *   - 掩码与统计(现读同一份 progress,未变);
   *   - tooltip 保持原样(tip 在 scrollEl 外,render 不碰它)。
   * **不重建 window 监听、不重注册任何事件**;收着时无事可做(下次 show 按当前语言重刷)。
   */
  function refreshLocale(): void {
    if (!visible) return;
    const top = scrollEl.scrollTop;
    paintStatic();
    paintFilters();
    render();
    scrollEl.scrollTop = top;
  }

  return {
    show(): void {
      paintStatic();
      paintFilters();
      render();
      visible = true;
      root.style.display = 'flex';
    },
    hide,
    visible: () => visible,
    refreshLocale,
  };
}
