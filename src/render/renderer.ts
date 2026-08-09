/**
 * 渲染层:只读 sim 状态画图,在 prev/cur 位置间按 alpha 插值。
 * 规则:render 可以 import sim,sim 永不 import render。
 * 大批量实体走 ParticleContainer(GDD §13 性能预算的关键)。
 * 镜头跟船(GDD §3.3):固定缩放 + 航向前方 look-ahead,取样一律用插值后的位姿。
 * 敌我色域分离(GDD §12 / 07 号 issue):敌人一律红紫暖色剪影、我方船与弹一律冷色,
 * 四型之间再靠形状 + 体型区分 —— 色相与轮廓两条通道各自独立,色盲玩家丢了色相仍认得出型。
 *
 * 甲板(03 号 issue):船体不再是一个箭头,而是 deckG 容器里的一张格子网。
 * 几何**全部画在船体局部空间**(格心一律问 sim 的 cellLocalPos,渲染层绝不自己再算一遍),
 * 容器每帧只吃插值后的 position/rotation —— 于是"甲板与船体一同旋转"是结构上必然成立的,
 * 而不是靠两处变换算得一样。逐格用 cellWorldPos 摆 12 个 Graphics 也能画出同一幅画面,
 * 但那等于每帧重做一遍船体变换,格与格之间还会各自吃到浮点误差而抖动。
 * 甲板分两档:战斗态船与敌人同尺度,只留船壳图、模块贴图、船头标识与开火/受击反馈;
 * 升级时停或按住 Tab 才进甲板视图(按外接圆放大到占屏 ~60%),补上格子、射界、连线与节流细节。
 *
 * 射界叠加层(04 号 issue,按住 Tab):同样挂在 deckG 里、同样只画局部几何,
 * 于是"扇形随船实时旋转"与"甲板随船旋转"是同一件事,不可能差一帧。
 * 扇形的角度与半径**一律问 sim / 数值表**(cellArc + towerArcDeg/towerRange),
 * 渲染层一行射界数学都不许自己写 —— 04 号的验收标准是"可视化与实际可命中区域一致",
 * 重算一份就等于埋下两个迟早走散的真相。
 *
 * 开火表现(05 号 issue T5):子弹按 towerType 分 ParticleContainer(取舍与敌人分型同一套),
 * 瞬时判定的四类(光束/链电/穿透光柱/落点 AoE)压根不进子弹池 —— sim 每帧交出一串 FxEvent
 * (sim/fx.ts),渲染层在 fxG 上照 kind 分别画、按 life 淡出。sim 只说"发生了什么、在哪",
 * 怎么画一个字都不说:这是 sim 与渲染之间唯一的缝,换掉整个渲染层也不必改 sim 一行。
 * 弹与光效**一律冷色**(逐塔取 def.tint),与敌人的红紫暖色完全分离(GDD §12)。
 * broadside 反馈(单舷 ≥3 塔同帧开火)的衰减计时**只在渲染层自持**:它纯是表现,
 * 进了 sim 就等于让确定性回放去为一次镜头抖动负责(铁律 1 的边界就画在这儿)。
 *
 * 受击表现(09 号 issue T4):被撞的那一舷把**该舷全部暴露边**描一遍暖红,alpha 随 world.edgePenalty
 * 衰减 —— 计时器与"该舷塔射速惩罚"读的是同一个数,于是"闪红"与"变慢"天然同窗口、想差一帧都做不到。
 * 暖色出现在自家甲板上是 GDD §4.6 明令的例外(与过热闪红同一条豁免),不是 §12 敌我色域分离被破了:
 * 满屏冷蓝里"这一舷刚挨了一下"只有靠色相反转才喊得出来。
 * 擦碰与真伤害必须**一眼分得开**(sim 侧本就是两件事:核心区外只出火花、一分血不掉):
 * 故 FXV_SPARK = 冷白星芒随 life 收缩、FXV_HULL_HIT = 暖红圆环随 life 扩散 ——
 * 色域与形变两条通道各自独立,色盲玩家丢了色相仍分得出"擦了一下"和"掉血了"。
 *
 * 邻接连线(06 号 issue T3):deckLinkG 把"生效中的支援加成"画成支援格心 → 受益塔格心的一条线。
 * 配对表**一律问 sim 的 supportLinks**,渲染层一行类型匹配规则都不许自己写 —— 与射界叠加层只调
 * cellArc 是同一条口径:两处各判一次,迟早会画出一条"看得见却没生效"的线,而那比不画更糟
 * (06 号验收标准原文:节流类型不匹配时 UI 不画连线,避免误导)。逐对 stroke,于是多来源的加成
 * 在画面上自然叠出更亮的一段 —— "buff 可叠加"这条读数不必再另找地方交代。
 * 装甲舱是唯一的例外:它压根不作用于相邻塔(对任何塔都不匹配 ⇒ supportLinks 永远不给它配对),
 * 故改画两条自己的读数 —— 格内一个盾(它在加船体 HP)+ 沿它自己每一条暴露边内壁一道冷色粗带
 * (它护的舷)。舷线与下面那条被撞舷闪红长在**同一批边**上,靠色域(冷 vs 暖红)与线宽分开;
 * 内部格的装甲舱没有暴露边 ⇒ 只有盾、没有舷线,"只加 HP、不护舷"于是画的就是它本来的样子。
 *
 * 进化金光(17 号):同一层 deckLinkG 里多画一路 —— 整备阶段(refitPending)配对存在时,
 * 满级塔 → 被吞支援之间一条金线,配对表一律问 sim 的 findEvolutionPairs(与 supportLinks
 * 同一条"渲染不写规则"的口径);整备阶段外一个分支都不进,金线一行都不画。
 * 与"可进化"按钮(UI 层,别的任务)各自独立:渲染只管画线,按钮照自己那套来。
 *
 * 节流读数(05 号 issue T5):deckThrottleG 逐帧把每座在线塔的节流状态画在它自己那一格上 ——
 * 弹夹条 + 装填进度 / 热量条 + 过热闪红 / 充能环,外加一排等级点。三套机制**各绑一种几何形状**
 * (沿 Y 的条 / 沿 X 的条 / 一个圆),而不是三条一样的条换个颜色:颜色这条通道已经被"哪座塔"
 * 占满了(读数一律取 def.tint,与该塔的弹和光效同色),再拿它区分机制就是把两条信息压进一个通道。
 * 这三样正是 06 号支援设施的三个作用锚点,画面上分不出三件事,06 号就没法让玩家看出加成落在哪。
 *
 * 残骸掉落(10 号 issue T4):掉落物照敌/弹那一套走 ParticleContainer —— 一容器一纹理、
 * dynamicProperties 只有 position、位置吃 alpha 插值。它们同屏能有上千颗(sim 那边的
 * DROP_MAX_ALIVE 保险丝)且每一颗每帧都在动,画成 Graphics 就是每帧上千条几何指令;
 * 而被吸住的残骸每秒跑 300px(比船的巡航还快一倍),不插值在 144Hz 屏上就是一串跳点,
 * 偏偏"残骸飞进船里"是玩家每隔几秒就要看一次的正反馈(铁律 2)。
 *
 * 甲板视图(升级时停 / 按住 Tab):setDeckZoom 只立"要不要视图"的意图,倍数按甲板外接圆
 * 现算(deckViewZoom),缩放**乘进镜头 scale(worldLayer)整体拉近** —— 只放大 deckG 的话,
 * 射界扇形/弹道/光效仍按未放大的世界坐标画,"可视化 = 可命中区域"(04 号口径)当场破掉;
 * 镜头整体拉近则甲板与世界共用同一个变换,几何关系永远诚实。
 * 拾格子一律走 screenToDeckLocal(deckG.toLocal):镜头/缩放公式只在渲染层存一份,
 * ui 层自己补一份就是两处必然走散的真相 —— 走散的样子恰恰是"看到的高亮框与
 * 点下去的格差一截":玩家只会觉得这游戏点不准,而不会觉得是缩放算错了。
 */
import {
  Application,
  Container,
  Graphics,
  Particle,
  ParticleContainer,
  Rectangle,
  Sprite,
  type Texture,
} from 'pixi.js';
import { ELITE } from '../data/affixes';
import {
  BOSS,
  ENEMIES,
  KIND_BEETLE,
  KIND_BOSS,
  KIND_STRAFER,
  KIND_SWARM,
  KIND_TRAILER,
  type EnemyDef,
} from '../data/enemies';
import { DECK_PIECES } from '../data/deckPieces';
import { SUPPORTS } from '../data/supports';
import {
  FX_BULLET,
  FX_LIFE_BEAM,
  FX_LIFE_BLAST,
  FX_LIFE_CHAIN,
  FX_LIFE_LANCE,
  FX_MORTAR,
  THR_AMMO,
  THR_CHARGE,
  THR_HEAT,
  TOWER_MAX_LEVEL,
  TOWERS,
  towerArcDeg,
  type TowerDef,
  towerMagazine,
  towerRange,
} from '../data/towers';
import { SPAWN_RADIUS } from '../data/waves';
import { type Arc, cellArc, isTurretCell } from '../sim/arc';
import { tuning } from '../sim/config';
import { deckOuterRadius, hullCoreHalfExtents } from '../sim/damage';
import {
  canMoveModule,
  canPlace,
  canWeldPiece,
  CELL_SUPPORT,
  CELL_WEAPON,
  cellLocalPos,
  type Deck,
  type DeckCell,
  deckCellSize,
  deckPieceCellAt,
  EDGE_BOW,
  EDGE_COUNT,
  EDGE_PORT,
  EDGE_STARBOARD,
  EDGE_STERN,
  edgeWorldNormal,
  isEdgeExposed,
  isPlaceSuccess,
  MOVE_OK,
  WELD_OK,
} from '../sim/deck';
import type { Drop } from '../sim/drop';
import { enemyRadius, ST_WINDUP } from '../sim/enemy';
import { BOSS_WINDUP, bossRadius } from '../sim/boss';
import {
  FX_LIFE_HULL_HIT,
  FX_LIFE_IMPACT,
  FX_LIFE_KILL,
  FX_LIFE_SPARK,
  FXV_BEAM,
  FXV_BLAST,
  FXV_CHAIN,
  FXV_HULL_HIT,
  FXV_IMPACT,
  FXV_KILL,
  FXV_LANCE,
  FXV_MUZZLE,
  FXV_SPARK,
} from '../sim/fx';
import { findEvolutionPairs } from '../sim/evolve';
import { lerpAngle, type Vec2 } from '../sim/ship';
import { supportLinks } from '../sim/support';
import { cellHeatMax, cellReload } from '../sim/tower';
import { peekNextElite, type ElitePeek } from '../sim/waves';
import type { Bullet, Enemy, World } from '../sim/world';
import { audioBus } from './audio';
import { type GeneratedArtTextures, loadGeneratedArt } from './generatedAssets';
import { ENEMY_BODY_FILL, enemyTint, SHIP_EDGE, SHIP_FILL } from './palette';
import { Starfield } from './starfield';

/** 未使用粒子的"停车位":粒子只增不删,多余的挪出视野(避免运行期增删 GPU 缓冲) */
const OFFSCREEN = 1e6;

// 敌人纹理一律画成浅灰阶(明面 + 亮边),真正的颜色靠粒子 tint 相乘出来:
// tint 是逐粒子的静态属性,建粒子时上传一次就不再动,于是"按型上色"零每帧开销。
// 剪影结构与船体同一套语汇(暗底亮边),唯独色域相反 —— 敌取 src/data/enemies.ts 的红紫暖色,
// 我方取下面的冷色,千敌同屏时靠色域而不是靠描边把自己认出来(GDD §12)。
const ENEMY_EDGE = 0xffffff;
// —— 残骸掉落物(10 号 issue T4)——GDD §12 的"拾荒焊接美学:船是冷色废铁拼焊的" ——
// 残骸就是那批废铁本身(GDD 开篇:残骸 = XP,星之残骸 = 你的船),故取**低饱和钢白**:
// 与六塔那批高饱和冷色(弹与光效)差的是饱和度、与敌人的红紫暖色差的是整个色域 ——
// 它既不是威胁也不是自己的火力,是地上等着捡的材料,不该抢任何一方的读数。
const DROP_TINT = 0xb9cfe0;
/** 纹理一律灰阶(暗面 + 亮边),真正的颜色靠粒子 tint 相乘 —— 与敌人/子弹纹理同一套做法 */
const DROP_FILL = 0x8f959c;
const DROP_EDGE = 0xffffff;
const DROP_EDGE_WIDTH = 1.2;
/**
 * 菱形的外接半径(世界 px)。**刻意不取拾取半径**:拾取判定是围着**船心**量的
 * (sim/drop 的 dropCollectRadius),不是围着这一颗残骸 —— 照那个数画出去,
 * 满屏就是一片糊住虫潮的光斑,而它承诺的距离感还是错的(与"灰盒阶段视觉 = 判定"
 * 那条口径不冲突:这里根本没有以残骸为圆心的判定可对齐)。
 * 比最大的子弹再大一点点:一颗残骸值几分钱不重要,"地上还有没有没捡的"必须一眼看得见。
 */
const DROP_RADIUS = 5;

// —— 甲板局部几何的尺度基准 ——
// 船缩到与敌人同档(tuning.shipLength 48,格边长 12)之后,甲板上的线宽/间距/读数
// 一律**按格边长等比**,不再写死绝对 px:同一套比例在战斗态(整船几十 px)与甲板视图
// (放大 7~9 倍)下都成立 —— 写死 px 的话,视图里 3.5px 的弹夹条会被放大成一根 30px 的杠。
// tuning.shipLength 本就不热调(见 config 注释:渲染器构造时一次性读取),模块加载时算一次即可。
const CELL = deckCellSize();

// —— 甲板配色:我方一律冷色域(GDD §12),三种格状态靠明度 + 蓝↔青的色相分开 ——
// 空格沿用船体本色:空格就是"还没装东西的船体",不该比装了东西的格更抢眼。
const DECK_EMPTY_FILL = SHIP_FILL;
const DECK_WEAPON_FILL = 0x3d78b8; // 武器塔:更亮的冷蓝
const DECK_SUPPORT_FILL = 0x2c7f76; // 支援设施:冷青,与武器塔同为冷色但色相分得开
const DECK_GRID_COLOR = 0x4d7ea8; // 格线:压在填充与轮廓之间的中间调,只交代"这里是分格的"
const DECK_GRID_WIDTH = CELL * 0.04;
/** 底色保留类型色，但让下面的舰壳铆钉与装甲分区透出来，不再像十二块纯色方砖。 */
const DECK_CELL_FILL_ALPHA = 0.62;
/** 离线格(见 sim/deck 的 online 口径:武器塔失去全部暴露边)一律去色 + 压暗,一眼看出它是死的 */
const DECK_OFFLINE_FILL = 0x3a4048;
const DECK_OFFLINE_ALPHA = 0.35;
/** 格与格之间留缝:不留缝时相邻格的描边会叠成一条粗线,3×4 看上去就成了一整块 */
const DECK_CELL_GAP = CELL * 0.055;
/** 生成模块图在格内占据的最长边(× 格边长);留下格线和节流读数的呼吸空间。 */
const DECK_MODULE_SIZE = 0.88;
/** fal.ai 候选图的正面朝纹理上方(-Y),而甲板局部 0 弧度朝船头(+X),两者相差 90°。 */
const GENERATED_ART_FORWARD_OFFSET = Math.PI / 2;
/**
 * 甲板视图(升级三选一 / 整备)里船体的固定朝向:局部 +X = 船头,转到屏幕正上方要 -90°。
 * build 界面展示的是"这艘船"而不是战场 —— 船头该指哪不归进入页面那一刻的航向管。
 */
const DECK_VIEW_UP_FACING = -Math.PI / 2;
/** 舰壳比初始 3×4 甲板略大一圈，露出装甲侧裙、推进器和舰艏。 */
const SHIP_HULL_LENGTH_PAD = 0.72;
const SHIP_HULL_WIDTH_PAD = 0.45;
/** 四型都按战斗态飞船的视觉量级展示，并再放大一档；甲虫继续保留重甲型的体型读数。 */
const ENEMY_VISUAL_SPAN = (tuning.shipLength + CELL * SHIP_HULL_LENGTH_PAD) * 1.15;
const ENEMY_HEAVY_VISUAL_SCALE = 1.15;
const DECK_HULL_WIDTH = CELL * 0.067;
/** 船头亮边 + 艏尖:快速转向时头尾必须一眼分得清(T3 验收口径),故给最亮的一档冷白 */
const DECK_BOW_COLOR = 0xdff2ff;
const DECK_BOW_WIDTH = CELL * 0.107;
/**
 * 艏尖三角的长与半宽(× 格边长)。它是**纯装饰**,故意伸出甲板前沿一点点 ——
 * 甲板本身已经占满 tuning 声明的包围盒(deckCellSize 取两轴较小值),想让尖头露在外面只能超出去。
 * 超出的是观感不是口径:镜头缩放仍以 tuning.shipLength 为准,判定更是一格也不多(碰撞在 sim)。
 */
const DECK_PROW_LEN = 0.5;
const DECK_PROW_HALF_W = 0.42;
// 放置高亮:合法格用与我方弹道同域的冷青蓝,与船体自身的蓝拉开一档明度。
// 拒绝色是暖色,故**只许小面积短促闪一下**(细描边 + 低 alpha):大面积暖色块会污染
// "暖色 = 敌人"这条全局约定(GDD §12),真正的拒绝理由由 DOM 文案给。
const DECK_HILITE_OK = 0x9adcff;
const DECK_HILITE_DENY = 0xff7a6b;
/** 整备时被拿起的模块：琥珀色只标“来源”，冷青色仍专门表示合法落点。 */
const DECK_HILITE_SOURCE = 0xffc46b;
/** 高亮矩形相对格边的内缩:留出底板格线,免得高亮把格子边界糊掉 */
const DECK_HILITE_PAD = CELL * 0.107;
const DECK_HILITE_FILL_ALPHA = 0.16; // 薄薄一层:合法格要看得出"能放",但不能盖掉格子本身的状态色
const DECK_HILITE_WIDTH = CELL * 0.055;
const DECK_HOVER_WIDTH = CELL * 0.08; // 悬停格比其它合法格粗一档:光标在哪一格必须无歧义
const DECK_DENY_FILL_ALPHA = 0.22;

// —— 甲板视图(升级时停 / 按住 Tab)——战斗中船与敌人同档大小,甲板细节根本看不清也不该看:
// 格子、读数、射界只在这两个场景里放大展示,平时画面上就是一艘小船在虫潮里打(用户口径:
// "只有升级或主动打开甲板设置时才展示甲板")。
/**
 * 甲板视图里,甲板外接圆**直径**占屏幕短边的比例。放大倍数不再是写死的档位,
 * 而是每帧按 deckOuterRadius 现算(见 deckViewZoom):12 号焊出更大的船,视图自动缩一点,
 * 整船永远完整落在屏幕里 —— 写死倍数的话,扩建三次之后甲板就伸出屏幕外了。
 * 缩放乘进镜头 scale(worldLayer)整体拉近(理由见文件头与 sync):甲板、敌人、弹道、
 * 射界共用同一个变换,视图里的几何关系永远诚实;DOM HUD 不在 worldLayer,照旧不动。
 */
const DECK_VIEW_FRACTION = 0.6;
/**
 * 缩放的指数缓动时间常数(秒)。**短促**是要点:它是"世界停了,轮到你摆甲板"的一记转场,
 * 不是一段动画 —— 拖长了玩家每次升级都得先干等它放完(一局要等十几次)。
 * 缓动只改镜头 scale;拾格子一律走 deckG.toLocal(见 screenToDeckLocal),
 * 于是缓动走到一半点下去,"看到的高亮框"与"点中的格"仍然是同一格:两者读的是同一个变换本身。
 */
const DECK_ZOOM_TAU = 0.08;
/**
 * 与目标差到这一档以内就直接吸附。指数缓动永远只是逼近,不吸附就等于往后每一帧都在
 * 给镜头 scale 写一个肉眼看不出差别的新值(worldLayer 的变换一改,底下全部子层都要重算)。
 */
const DECK_ZOOM_EPS = 0.002;

// —— 屏幕空间远景 —— 背景不进 worldLayer，否则会跟战场等比缩放，星云看起来贴在虫群脚下。
/** 多留一圈画面给缓慢视差位移，任何窗口比例下都不露底。 */
const BACKGROUND_OVERSCAN = 1.12;
/** 视差只占屏幕很小一档：交代航行感，但不能让静态远景抢走战斗运动。 */
const BACKGROUND_PARALLAX = 0.025;
const BACKGROUND_PARALLAX_FREQ = 0.0007;
const BACKGROUND_ALPHA = 0.9;

// —— 射界叠加层(04 号 issue,按住 Tab):我方冷色域(GDD §12),与弹道/合法格同一支蓝 ——
// 扇形是"这一片我打得到"的读数而不是实体,故填充压到极淡的一层、边界靠描边交代:
// 十座塔的扇形大面积互相重叠,填充再重一点就叠成一整块亮斑,反而读不出各塔的边界在哪。
const DECK_ARC_COLOR = 0x9adcff;
const DECK_ARC_FILL_ALPHA = 0.1;
const DECK_ARC_STROKE_ALPHA = 0.45;
const DECK_ARC_WIDTH = CELL * 0.04;
/** 炮口线取比扇形更亮一档的冷白(与船头标识同色):它是"炮管归位"在画面上唯一看得见的东西 */
const DECK_MUZZLE_COLOR = 0xdff2ff;
const DECK_MUZZLE_WIDTH = CELL * 0.08;
/** 炮口线长度(× 格边长):够伸出格外半格,不至于整条埋在格子自己的填充色里 */
const DECK_MUZZLE_LEN = 1;

// —— 邻接连线(06 号 issue T3)——"这一格的加成落在哪座塔上"在画面上唯一的落点 ——
// 配对表**一律问 sim 的 supportLinks**:正交相邻、受益格得是一座在线的塔、节流类型必须匹配 ——
// 三条判据全在那一份里,渲染层一行都不许自己重写。与射界叠加层只调 cellArc 同一条口径:
// 重推一份就是两个迟早走散的真相,而这一个走散了,甲板上就会出现一条"看得见却没生效"的线,
// 那比不画更糟(06 号验收标准原文:节流类型不匹配时 UI 不画连线,避免误导)。
// 色相取该设施自己的 tint(与它的格填充同色,见 deckCellFill)⇒ "这条线是哪种设施给的"不用猜;
// **逐对 stroke** 而不是把全部配对攒成一条 path:两条半透明的线叠在一起会更亮,
// 那正是"两座弹药库夹一门机炮 = 加成连乘"的读数;攒成一条 path 只会平铺成一个 alpha,叠加当场看不见。
const DECK_LINK_WIDTH = CELL * 0.055;
/**
 * 不给满 1:连线是**叠在**甲板上的一层读数,压过格子本身的状态色就喧宾夺主了;
 * 半透明同时是"多来源叠加"那条读数的载体(见上),给满就再也叠不出亮度差。
 */
const DECK_LINK_ALPHA = 0.6;
/** 受益塔那一端的小实心圆:线有两个端点,没有它就读不出加成是**从哪一格流向哪一格**。
 *  只点在塔这一头 —— 支援格那一头本来就长着设施自己的整块色 */
const DECK_LINK_DOT_R = CELL * 0.08;

// —— 进化金光(17 号 issue)—— 与邻接连线共用 deckLinkG 与同一条画线方式,只换色相与强度 ——
// 金色是"配方满足、可以合成"的**行动读数**:支援连线取设施自己的 tint(冷色),金线靠色相
// 与它一眼分家;与整备期拖模块的琥珀来源框(DECK_HILITE_SOURCE)同属船坞界面的暖色豁免
// (GDD §4.6,同过热闪红那条),但明度再高一档、且叠一层宽光晕 ——
// 提示必须先于任何常驻读数被看见,它是"下一步可以做什么"的入口。
const DECK_EVOLVE_GLOW_WIDTH = CELL * 0.13;
const DECK_EVOLVE_GLOW_ALPHA = 0.3;
const DECK_EVOLVE_CORE_WIDTH = CELL * 0.07;
const DECK_EVOLVE_CORE_ALPHA = 0.95;
const DECK_EVOLVE_COLOR = 0xffd35c;

// —— 装甲舱:它不作用于相邻塔,故**一条连线都不画**(画了就是误导),改用两条自己的读数 ——
//   ① 格内一个盾形图标 = "这一格在给船体加 HP",判据是 def.hullHp > 0 —— 与 sim/damage 的
//      hullMaxHp 读**同一个字段**,于是数值表把加成调成 0,盾自己就消失了;
//   ② 沿它**自己每一条暴露边**一道粗线 = "它护的是这几舷",判据是 def.edgeDamageMul < 1 且该边暴露 ——
//      舷向归属与 sim/damage 的 edgeDamageMul 一字同源(都问 isEdgeExposed)。
// 于是内部格的装甲舱只剩一个盾、一条舷线都没有,正好把"只加 HP、不护舷"画成了它本来的样子;
// 角落格的装甲舱同时描两舷,也与减伤真的落在两舷一致。
// 舷线与 09 号的被撞舷闪红长在**同一批边**上,靠色域(冷 vs 暖红)与线宽两条通道分开:
// 前者是"这一舷有护甲"的常驻读数,后者是"这一舷刚挨了一下"的半秒回执 ——
// 闪红更宽、又压在更上层,挨打那半秒理应由它说话:那一刻要读的是伤害,不是护甲。
const DECK_ARMOR_EDGE_WIDTH = CELL * 0.094;
const DECK_ARMOR_EDGE_ALPHA = 0.9;
/**
 * 舷线从格边**往里缩**这么多(世界 px),而不是正压在边上。
 * 压在边上会把那条边原本的读数一并盖掉:船体轮廓(DECK_HULL_WIDTH 2.5)还好,
 * **船头亮边只有 4 px 宽** —— 一块装甲舱放在船头格,3.5 px 的带子正好把它啃得只剩两道边,
 * 而"头尾一眼分得清"是 03 号立下的验收口径,不该被 06 号的一条读数换掉。
 * 缩进去之后它读成"沿这一舷内壁铆的一层甲",三条线(轮廓 / 装甲 / 闪红)各在各的位置上共存。
 */
const DECK_ARMOR_EDGE_INSET = CELL * 0.08;
// 舷线的颜色见下方的 DECK_ARMOR_EDGE_COLOR(它取冷白 FX_CORE_COLOR,得等那个常量先声明)
/** 盾形图标的半长(沿船长)/半宽(沿舷宽),× 格边长 */
const DECK_SHIELD_HALF_H = 0.22;
const DECK_SHIELD_HALF_W = 0.17;
/** 盾尖那一段的收腰位置(× 半长):肩到腰是直的,腰到尖才收 —— 少了它盾就退化成一个三角形 */
const DECK_SHIELD_WAIST = 0.25;
const DECK_SHIELD_WIDTH = CELL * 0.048;
/** 盾用冷白描边 + 极淡填充:格填充已经是这块设施自己的 tint(见 deckCellFill),
 *  图标再用同色就等于画在自己身上 —— 只有比它亮一档才认得出这是个图标 */
const DECK_SHIELD_FILL_ALPHA = 0.18;

// —— 节流读数(05 号 issue T5:"三种节流机制在 UI 上可读")——
// 三套机制**各绑一种几何形状**,而不是三条一模一样的条换个颜色:颜色这条通道已经被"哪座塔"占满了
// (读数一律取 def.tint,与该塔打出的弹、光效同色,于是"这一格是哪门炮"不用再猜),
// 再拿它去区分机制,就等于把两条信息压进同一个通道,缩到一格这么小时谁都读不出来。故:
//   弹药 THR_AMMO   = 贴**船尾侧**格边、沿舷宽方向的条(弹夹余量),装填中另叠一条冷白进度;
//   过热 THR_HEAT   = 贴**左舷侧**格边、沿船长方向的条(热量),过热锁死时闪暖红;
//   充能 THR_CHARGE = 格心的一圈环(充能进度),满充再描一圈冷白芯。
// "沿 Y 的条 / 沿 X 的条 / 一个圆"三者的朝向与形状互不相同 —— 这正是 06 号支援设施要作用的
// 三个锚点在画面上的样子,一眼分不出三件事,06 号就没法让玩家看出自己加成到了哪一套。
// 整层画在**甲板局部空间**(与格子同一套坐标),跟着船转:读数长在它所属的那一格上,不会飘。
/** 读数与格边的间距:留出底板格线,免得读数糊在格子边界上(与 DECK_HILITE_PAD 同一条取舍) */
const THR_PAD = CELL * 0.12;
const THR_BAR_THICK = CELL * 0.094;
/** 槽底:比任何格填充都暗一档 —— 空槽也要看得出"这里有一条读数",否则弹药打空 = 读数消失 */
const THR_TRACK_COLOR = 0x0a1626;
const THR_TRACK_ALPHA = 0.55;
/** 装填进度用冷白 + 半透明:与"弹夹余量"(塔本色实心)同槽不同色,两者一眼分得开 */
const THR_RELOAD_ALPHA = 0.5;
/**
 * 过热锁死的闪烁频率(次/秒)。相位直接取 cell.coolLock —— 它本就在逐帧递减,
 * 于是渲染层不必自持第二个计时器;暂停时闪烁也跟着停(它读的是 sim 状态,不是墙钟)。
 */
const THR_OVERHEAT_BLINK_HZ = 6;
const THR_RING_RADIUS = 0.3; // 充能环半径(× 格边长)
const THR_RING_WIDTH = CELL * 0.08;
const THR_RING_TRACK_ALPHA = 0.5;
/** 满充的芯线:"可以放了"必须与"快满了"一眼分开,否则充能塔看上去永远在原地转圈 */
const THR_RING_FULL_WIDTH = CELL * 0.04;
/** 等级点(GDD §5.4 的 Lv1→Lv5):半径与间距,5 个点排下来仍在一格之内 */
const THR_LEVEL_DOT_R = CELL * 0.046;
const THR_LEVEL_DOT_GAP = CELL * 0.123;

// —— 开火表现(05 号 issue T5)——四类瞬时表现的可辨识度靠**各绑一条形变通道**,而不只是换个颜色:
// 色相已经被"哪座塔打的"占用了(一律取 def.tint,于是弹与光效同源、玩家认得出是哪门炮),
// 光是换色分不出"这是光束还是穿透"。故每一类各挑一条随 life 演化的独立通道:
//   光束 FXV_BEAM   = 细实线 + **常亮**(不随 life 变形,唯一"静止"的一类);
//   链电 FXV_CHAIN  = 逐跳折线 + 折角(唯一"不直"的一类,一跳一个事件,天然连成链);
//   穿透 FXV_LANCE  = 粗光柱**随 life 收窄**(唯一"越来越细"的一类);
//   AoE  FXV_BLAST  = 圆环**随 life 扩张**(唯一的圆)。
// 全部取自 def.tint = 冷色域(GDD §12),暖色一律留给敌人。
/** 塔型越界时的兜底冷色:数值表被改坏也不该在画面上冒出一块暖色(GDD §12 不可破) */
const FX_TINT_FALLBACK = 0x9adcff;
/** 光效的高光芯色:比任何塔的 tint 都亮一档的冷白,给"能量"一个统一的核心 */
const FX_CORE_COLOR = 0xeaf6ff;
/**
 * 装甲舱舷线的颜色(声明在这儿只因为它要用上面那个冷白;语义上属甲板那组)。
 * **必须比格填充亮一档,绝不能取 def.tint** —— 舷线缩进 DECK_ARMOR_EDGE_INSET 之后整条
 * 落在格填充里面,而格填充已经是这块设施自己的 tint(见 deckCellFill):
 * 同色叠同色不透明底会合成回原色,整条线是零像素。这与盾图标那条规矩
 * (DECK_SHIELD_FILL_ALPHA)是同一条,故取同一个冷白 —— 盾与舷线本就该读成
 * 同一套"这块是装甲"的语汇。
 */
const DECK_ARMOR_EDGE_COLOR = FX_CORE_COLOR;
const FX_BEAM_GLOW_WIDTH = 5;
const FX_BEAM_GLOW_ALPHA = 0.3;
const FX_BEAM_CORE_WIDTH = 1.6;
/** 光束存续只有 FX_LIFE_BEAM(≈3 逻辑帧),按 life 线性淡出会把"持续光束"画成一闪一闪的虚线,
 *  故只从这个底 alpha 起微微收一点 —— "常亮"正是它与另外三类的区别所在 */
const FX_BEAM_CORE_ALPHA_FLOOR = 0.55;
const FX_CHAIN_WIDTH = 2;
const FX_CHAIN_ALPHA = 0.9;
/** 折角幅度(× 跳长):按跳长缩放,短跳才不会被折成一团 */
const FX_CHAIN_KINK = 0.16;
/** 折角的位置(沿跳的比例)与横向偏移(× 折角幅度)。定死不掷随机 —— 逐帧重掷会让链电在
 *  存续的 7 帧里抖成一团噪点,而它要传达的是"这一发打到了这几只",不是噪点 */
const FX_CHAIN_KINK_AT = [0.28, 0.55, 0.8];
const FX_CHAIN_KINK_OFF = [1, -0.62, 0.3];
const FX_LANCE_WIDTH = 9;
const FX_LANCE_ALPHA = 0.5;
const FX_LANCE_CORE_WIDTH = 2;
const FX_BLAST_RING_WIDTH = 2.5;
/** 环的起手半径(× 真实 aoeRadius):从这里扩张到 1.0,**收尾那一帧的圈 = 实际炸到的范围** */
const FX_BLAST_START = 0.35;
/** 覆盖面的实心盘:极淡的一层,负责"炸到多大一片"的面积读数,扩张环负责"炸了" */
const FX_BLAST_FILL_ALPHA = 0.16;
/** 炮口火光的半径与不透明度：略大于节流点，保证战斗态缩放下仍能越过塔色块被看见。 */
const FX_MUZZLE_RADIUS = 7;
const FX_MUZZLE_ALPHA = 0.8;
/** 同色光晕落在同色塔块上仍会隐形；冷白描边与芯点提供不依赖塔色的第二条亮度通道。 */
const FX_MUZZLE_RING_WIDTH = 2.5;
const FX_MUZZLE_CORE_RADIUS = 2.3;

// —— 受击表现(09 号 issue T4)——被撞舷闪红 / 船体真伤害 / 判定体轮廓共用的暖红 ——
/**
 * 我方甲板上**唯一许可的暖色**,GDD §4.6 明令的例外(与 THR_HEAT 的过热闪红同一条豁免)。
 * 别把它当成 §12 敌我色域分离被破了:恰恰相反,正因为整艘船连弹带光效都是冷色,
 * "这一舷刚挨了一下"才只能靠色相反转喊出来 —— 换成又一支冷蓝,它就会淹进底板与读数里。
 * 代价是它只许出现在**线**上(舷边、圆环、判定体轮廓)且**短促**,绝不铺成色块:
 * 大面积暖色会把玩家的"暖色 = 敌人"这条条件反射整个污染掉(DECK_HILITE_DENY 同一条取舍)。
 */
const HULL_HIT_COLOR = 0xff5a48;
/** 闪红的线宽比船体轮廓(DECK_HULL_WIDTH)粗一档:它要盖住那条冷色轮廓线,而不是并排画在旁边 */
const HULL_HIT_WIDTH = CELL * 0.134;
/** 惩罚满格时的不透明度。不给满 1:闪红是"叠在船体上的一层伤",不该把那一舷的轮廓整条替换掉 */
const HULL_HIT_ALPHA = 0.85;
/** 判定体轮廓(按住 Tab):细线 + 半透明 —— 它是叠在甲板上的调试读数,不许压过格子本身的状态色 */
const HULL_CORE_WIDTH = CELL * 0.055;
const HULL_CORE_ALPHA = 0.7;

/**
 * 火花 FXV_SPARK = "蹭到甲板了、但没进核心区,一分血都没掉"。冷白(与我方光效同一支芯色)、
 * 小、**随 life 收缩**;真伤害 FXV_HULL_HIT 则是暖红圆环**随 life 扩散**。
 * 两者在**色域 + 形状 + 形变**三条通道上同时相反,是因为 sim 侧它们是截然不同的两件事
 * (擦碰不结算伤害,见 09 号设计约定),画面上分不开就等于让玩家学错自己的判定体到底多大。
 */
const FX_SPARK_COLOR = FX_CORE_COLOR;
/** 星芒射线的满长(世界 px)与线宽:比子弹还小一圈 —— 它是"没事"的读数,不该抢戏 */
const FX_SPARK_LEN = 7;
const FX_SPARK_WIDTH = 1.6;
/**
 * 从命中点向外发散的四条射线的单位方向(±√2/2,合起来是一个 ×)。定死不掷随机,
 * 与链电折角(FX_CHAIN_KINK_*)同一条理由:渲染层掷随机就等于在 sim 之外又开了一条随机源,
 * 同 seed 回放会画出不同的画面。
 * 取对角而不是正交:甲板格线与两条节流条已经把水平/垂直占满了,斜的才认得出是"另一件事"。
 */
const FX_SPARK_DIRS = [0.707, 0.707, -0.707, 0.707, -0.707, -0.707, 0.707, -0.707];
/** 真伤害圆环:从 R0 扩到 R1(世界 px)。起手就比火花大一圈 —— "掉血了"必须比"擦到了"更响 */
const FX_HULL_HIT_R0 = 5;
const FX_HULL_HIT_R1 = 17;
const FX_HULL_HIT_WIDTH = 2.5;
const FX_IMPACT_COLOR = 0xc8f4ff;
const FX_IMPACT_LEN = 6;
const FX_IMPACT_WIDTH = 1.4;

/**
 * 击杀爆点 FXV_KILL(畅玩性调整):敌人死亡处一个从敌半径向外扩的短促圆环 + 四条放射短线。
 * 配色取 enemyTint(该敌型的红紫暖色):死的是敌人,爆点属于敌方色域 —— 与 FXV_BLAST
 * (我方冷色 AoE 承诺)在色域上天然分开,不会被读成"这里炸到了这么大一片"。
 * 射线方向定死不掷随机,与火花(FX_SPARK_DIRS)同一条理由;取正交而不是对角,
 * 与火花的 × 形在形状通道上错开 —— 蜂群贴脸时两种事件常同屏。
 */
const FX_KILL_RING_WIDTH = 2;
/** 爆环收尾半径 = 敌半径 × 它:虫死时"啵"地散开一圈,比本体大但远小于 AoE 的量级 */
const FX_KILL_EXPAND = 2.5;
/** 放射短线的满长(× 敌半径)与线宽 */
const FX_KILL_RAY = 1.4;
const FX_KILL_RAY_WIDTH = 1.6;
const FX_KILL_DIRS = [1, 0, 0, 1, -1, 0, 0, -1];

// —— broadside 反馈(05 号 issue T5 可选项)——
/** 触发门槛:与 sim 的口径一致(world.broadsideCount ≥ 3 = 单舷齐射) */
const BROADSIDE_MIN = 3;
/** 反馈时长(秒)。短促是要点:它是"齐射打出去了"的一记回执,不是持续的镜头病 */
const BROADSIDE_TIME = 0.18;
/** 顿挫幅度(屏幕 px)。挂在屏幕像素上而不是世界单位:抖动是给眼睛看的,不该随镜头缩放变 */
const BROADSIDE_SHAKE_PX = 7;
/** 衰减期内走完的振荡周期数:定周期而不是定频率,于是抖动的"节拍"与帧率无关 */
const BROADSIDE_CYCLES = 1.5;
const BROADSIDE_FLASH_ALPHA = 0.18;
/** 渲染帧 dt 的上限(秒):切后台回来时 deltaMS 会是好几秒,不夹住就等于把反馈一口气跳完 */
const BROADSIDE_MAX_DT = 0.1;
const SHAKE_MAX_TRAUMA = 1;
const SHAKE_DECAY_TAU = 0.12;
const SHAKE_FREQUENCY = 48;
const SHAKE_PIXEL_SCALE = 4.5;

/**
 * 前摇指示器每帧重建几何(Graphics 不像粒子那样能只改位置),故设硬上限:超配额的本帧不画。
 * 配额**按型均分**而不是共享一个池:共享时按 kind 顺序消费,前摇短、数量多的侧掠者会先抽干,
 * 把配额留给排在后面的甲虫 —— 而"冲撞甲虫的前摇可读"正是 07 号的验收标准,不能被别的型饿死。
 */
const TELEGRAPH_MAX_PER_KIND = 32;
/** 半透明:指示器是"预告"不是实体,压不住敌人自己的剪影 */
const TELEGRAPH_ALPHA = 0.5;
/** 蓄力环起始半径 = radius×(1+GROWTH),随剩余前摇收缩到 radius;环合拢那一刻起冲 */
const TELEGRAPH_RING_GROWTH = 2;
const TELEGRAPH_WIDTH = 2;

// —— 精英出场预警(14 号:出生前 ~2s 的视觉/音频提示)——屏幕空间,挂在 stage 上,不进 worldLayer ——
/** 预警窗口(秒):eta 进窗才开始画/发声(todos/14 口径的 ~2s) */
export const ELITE_WARN_LEAD = 2;
/** 屏边箭头到屏幕边缘的留白(px):别让它顶进 HUD 角标底下 */
const ELITE_WARN_EDGE_MARGIN = 28;
/** 箭头底尺寸(px)与随接近生长的幅度:越近越大,读得出"快来了" */
const ELITE_WARN_ARROW_BASE = 13;
const ELITE_WARN_ARROW_GROW = 9;
/** 闪烁频率(次/秒):渲染帧现算 sin,不依赖 CSS keyframes(与 HUD 的 burst 预警同一招) */
const ELITE_WARN_BLINK_HZ = 3;
/** 去重键的段基数:segment / eliteNext 都远小于它 ⇒ (segment, eliteNext) 单射进一个键 */
const ELITE_WARN_KEY_STRIDE = 1 << 20;

// —— Boss 战提示(15 号)——
/**
 * 召唤预告环的闪烁频率。比精英预警(3Hz)慢一档:同一套"边缘箭头 + 倒计时环"视觉通道,
 * 靠节奏与 Boss 专属色(底座 tint)分得开,不另造第四种预警形状
 */
const BOSS_WARN_BLINK_HZ = 2;

/**
 * 精英出场预警的帧判定(纯函数,便于单测):当前帧是否处于预警窗口内
 * —— 存在下一个未触发的精英(peekNextElite 的答复),且距出生 ≤ ELITE_WARN_LEAD 秒。
 * 预警消失不在这里判定:精英实际出生(eliteNext 游标前移)或该段结束后,
 * peek 要么换到下一只、要么返回 null,窗口自然熄灭。
 */
export function eliteWarnActive(peek: ElitePeek | null): boolean {
  return peek !== null && peek.etaSeconds <= ELITE_WARN_LEAD;
}

/**
 * 把 (segment, eliteNext) 游标压成一只精英的去重键:键变了 = 预警换到了另一只身上。
 * 哨兵 -1 不与任何真键冲突(segment / eliteNext 都 ≥ 0)。
 */
export function eliteWarnKey(segment: number, eliteNext: number): number {
  return segment * ELITE_WARN_KEY_STRIDE + eliteNext;
}

/**
 * Boss 召唤预告的窗口判定(15 号):战斗中(bossPhase === 1)且距下次召唤的剩余冷却
 * ≤ BOSS.summonWarnTime 才亮 —— 判据与 sim/world 的 bossSummonCooldown 一字同源,
 * 渲染层不自己推第二份"下一次召唤什么时候"。
 * 冷却 ≤ 0 不算:到点即触发,sim 侧当场重置回 summonInterval(见 stepBossSummon),
 * 把 0 也算进窗口会让预告环在召唤完成的那一帧还挂一整圈。
 */
export function bossSummonWarnActive(cooldown: number, bossPhase: number): boolean {
  return bossPhase === 1 && cooldown > 0 && cooldown <= BOSS.summonWarnTime;
}

/** 召唤预告的剩余比例(1 → 0):满环 = 刚进窗,弧长收没 = 召唤触发(画弧用,与判定同一份分母) */
export function bossSummonWarnFraction(cooldown: number): number {
  return clamp01(cooldown / BOSS.summonWarnTime);
}

/**
 * Boss 出场音的帧判定(纯函数,便于单测):只在 bossPhase 从别的值翻进 1 的那一帧该响。
 * 去重靠渲染层把上次见过的阶段位锁存起来,再拿这一帧的相位喂进来(与 broadsideTick
 * 按 world.tick 去重同一条口径) —— 窗口内反复渲染帧不会重复发声。
 */
export function bossWarnOnEnter(prevPhase: number, nextPhase: number): boolean {
  return nextPhase === 1 && prevPhase !== 1;
}

interface Interpolatable {
  x: number;
  y: number;
  px: number;
  py: number;
}

/**
 * 取格心 / 屏幕点的暂存。模块级复用而不是每次现造(照 sim/world.ts 的 desired 写法):
 * 甲板高亮每帧要问十几次格心,现造就是每秒上千次分配(铁律 3)。用完即弃,绝不跨函数存活。
 */
const localPos: Vec2 = { x: 0, y: 0 };
const screenPos: Vec2 = { x: 0, y: 0 };
/** 射界暂存:同理,叠加层每帧要向 sim 问一遍全部塔的扇形,现造就是每秒上千次分配(铁律 3) */
const arcTmp: Arc = { center: 0, half: 0 };
/** 判定体半长/半宽的暂存(09 号 T4 的调试轮廓)。与上面两个同一条口径:模块级复用,零分配 */
const coreTmp: Vec2 = { x: 0, y: 0 };
/**
 * 邻接连线的**第二个**端点(06 号 T3)。单独再开一个而不是复用 localPos:
 * 一条连线要同时握住支援格心与受益塔格心两个点,而 cellLocalPos 是写进调用方给的 out ——
 * 两次都传 localPos,第二次就把第一次的答案覆盖掉,线会从塔画到塔(长度恒 0)。
 */
const linkPos: Vec2 = { x: 0, y: 0 };
const weldCoord = { col: 0, row: 0 };
/** 精英出生点的暂存(世界 → 屏幕换算,toGlobal 的 out 参数):热路径复用,零分配 */
const eliteSpawnWorld: Vec2 = { x: 0, y: 0 };
const eliteSpawnScreen: Vec2 = { x: 0, y: 0 };
/** Boss 本体/召唤预告环的暂存(世界 → 屏幕换算),与精英那对同一条口径 */
const bossWarnWorld: Vec2 = { x: 0, y: 0 };
const bossWarnScreen: Vec2 = { x: 0, y: 0 };

/**
 * 放置模式的 UI 状态。**接口定义在渲染层并导出**,依赖方向因此是单向的 ui → render:
 * ui 层持有这个对象、每帧就地改字段,渲染层只存引用、只读不写(零分配),render 不 import ui。
 * 10 号 issue 的"三选一 → 时停 → 甲板放大 → 拖放"会整套换掉 ui 那一侧,本接口是它们之间唯一的缝。
 */
export interface PlacementUiState {
  /** 放置模式开关:关着时高亮层一片空白 */
  active: boolean;
  /** CELL_WEAPON | CELL_SUPPORT —— 决定哪些格算合法(武器塔仅限边缘格,GDD §4.1) */
  content: number;
  /**
   * 要放的塔型(TOWER_*),仅当 content = CELL_WEAPON 时有意义(支援设施走 0 号键,不看它)。
   * 合法性与它有关,故高亮层必须把它一并交给 canPlace:**同格同型 = 升级**(GDD §5.4),
   * 同格异型才是拒绝 —— 少传这一个参数,画面就会把"能叠级的那一格"画成不能放,
   * 而"高亮 = 规则"是 03 号立下的口径(ui 与渲染层都不许自己再判一遍合法性)。
   */
  towerType: number;
  /**
   * 要放的设施型号(SUP_*,见 data/supports),仅当 content = CELL_SUPPORT 时有意义
   * (武器塔走 1..6 键,不看它)。与 towerType 同一条理由:合法性与它有关
   * (支援型号非法 = PLACE_BAD_SUPPORT),故高亮层必须把它一并交给 canPlace ——
   * 少传这一个参数,画面就会把"型号填错了"的那一次放置画成能放,点下去才被拒。
   */
  supportType: number;
  /** >=0 = 甲板拼块焊接模式；-1 = 普通塔/设施放置。 */
  weldPieceType: number;
  /** 拼块顺时针 90° 旋转档。 */
  weldRotation: number;
  /** 焊接 ghost 的稳定逻辑锚点；可落在当前 backing rectangle 外。 */
  hoverCol: number;
  hoverRow: number;
  /** 最近一次焊接拒绝，供 ghost 短促红闪。 */
  weldDenied: boolean;
  /** 悬停格在 deck.cells 里的下标,-1 = 不在甲板上 */
  hoverIndex: number;
  /** 刚被拒绝的格,-1 = 无;由 ui 层超时清零(渲染层不持有计时器) */
  denyIndex: number;
  /** >=0 = 整备期正在搬运的来源格；-1 = 普通放置/焊接。 */
  moveSourceIndex: number;
}

/**
 * 按敌人定义生成灰盒剪影几何。形状与体型是色相之外的第二条辨识通道(色盲安全):
 * 圆 = 蜂群蛭(最小最多)、飞镖 = 侧掠者(尖头,一眼是"高速切入")、
 * 胶囊 = 尾随蛆(细长)、六边 = 冲撞甲虫(最大,重甲感)。
 * 尺寸一律以 def.radius(碰撞半径)为基准:灰盒阶段视觉 = 判定,别让玩家学错距离感;
 * 拉长的形状只在长轴方向超出,不放大实际判定圆。
 * 注意:粒子的 rotation 是静态属性(见构造函数的取舍),所以剪影朝向固定朝 +X ——
 * 这些形状只是"型号标签",不表示该敌人的实际航向,别照它判断冲锋方向(那是前摇锁定线的活)。
 * 几何必须对原点上下左右对称 —— 粒子锚点固定 0.5,纹理是按包围盒裁的,
 * 包围盒不对称就等于把剪影整体偏移出实体真实位置(描边是对称外扩的,不破坏这一点)。
 */
function buildEnemyShape(def: EnemyDef): Graphics {
  const r = def.radius;
  const g = new Graphics();
  switch (def.shape) {
    case 'circle':
      g.circle(0, 0, r);
      break;
    case 'arrow':
      // 尖头 + 尾部内凹(与船体同一套语汇):内凹让它在最小尺寸下也不退化成一个三角块
      g.poly([r * 1.2, 0, -r * 1.2, r * 0.85, -r * 0.5, 0, -r * 1.2, -r * 0.85]);
      break;
    case 'capsule':
      // 圆角半径正好取半高 → 两端半圆的"胶囊";细长比例是它与圆形蜂群蛭的主要区别
      g.roundRect(-r * 1.5, -r * 0.6, r * 3, r * 1.2, r * 0.6);
      break;
    case 'hex': {
      const pts: number[] = [];
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        pts.push(Math.cos(a) * r, Math.sin(a) * r);
      }
      g.poly(pts);
      break;
    }
  }
  // 描边宽度随体型缩放:固定宽度会把 r=7 的蜂群蛭糊成一个亮点,形状通道就废了
  return g
    .fill(ENEMY_BODY_FILL)
    .stroke({ width: Math.max(1.5, r * 0.25), color: ENEMY_EDGE });
}

/**
 * 四型生成图都裁成同尺寸方图，这里把普通敌型的最长视觉边对齐战斗态舰壳长度；
 * 重甲甲虫再大一档。碰撞仍读 def.radius，视觉尺寸不反向污染 sim 数值。
 */
function generatedEnemySpan(def: EnemyDef): number {
  return ENEMY_VISUAL_SPAN * (def.shape === 'hex' ? ENEMY_HEAVY_VISUAL_SCALE : 1);
}

/**
 * 单型敌人的程序化动画参数(第一步:纯表现,不换贴图,零 API 成本)。
 * 全部乘在"静止缩放的基准"之上,不碰 sim 数值 —— 判定体多大画多大那条口径不受影响。
 * 相位 = animClock × freq + seed × 2π,seed 来自 e.animSeed(出生位置 hash,同 seed 两局一致)。
 */
export interface EnemyAnim {
  /** 呼吸/摆动角频率(rad/s);0 = 这一型不做周期动作 */
  freq: number;
  /** 呼吸幅度:基准缩放的乘数波动 ±(0 = 不缩放)。必须 < 1,否则缩放会翻负 */
  breatheAmp: number;
  /** 摆动幅度(rad):叠加在行进朝向角上(0 = 不摆)。前摇锁向期间照摆 —— 蓄力颤抖也是信号 */
  wobbleAmp: number;
  /** 自旋速度(rad/s):非 0 = 圆型敌人持续漂移自转,不跟随速度朝向 */
  spin: number;
}

/**
 * 每型一档,下标 === EnemyKind(与 ENEMIES 同序,热路径按 kind 直取,不查字符串表)。
 * 取值按"轮廓越圆越靠频率低幅度小的慢漂,轮廓越明确越靠高频小摆":
 * 蜂群蛭(近圆,数量最多)= 缓慢呼吸 + 自转,口器绕圈就是它的"活着";
 * 侧掠者/尾随蛆(新月/J 形)= 高频小幅摆动,读作游动;甲虫(重甲楔形)= 最低幅,读作沉稳蓄力。
 */
const ENEMY_ANIM: readonly EnemyAnim[] = [
  { freq: 2.0, breatheAmp: 0.07, wobbleAmp: 0, spin: 0.9 }, // KIND_SWARM 蜂群蛭
  { freq: 4.5, breatheAmp: 0.06, wobbleAmp: 0.15, spin: 0 }, // KIND_STRAFER 侧掠者
  { freq: 3.0, breatheAmp: 0.1, wobbleAmp: 0.25, spin: 0 }, // KIND_TRAILER 尾随蛆
  { freq: 6.0, breatheAmp: 0.05, wobbleAmp: 0.08, spin: 0 }, // KIND_BEETLE 冲撞甲虫
];

/** 动画读数的模块级 scratch:syncParticles 热循环每帧重写,绝不 new(与 localPos 同一条零分配纪律) */
const animFrameScratch = { scale: 0, spin: 0, wobble: 0 };

/**
 * 单帧动画读数的纯计算:给同步循环一次算出缩放乘数 / 自转角 / 摆动角。
 * 拆出来就是为了 Node 单测 —— 热路径之外的三个 sin 换来的可测性值得(renderer.test.ts 钉边界)。
 * 写进调用方给的 out(缺省 = 模块级 scratch),绝不 new:syncParticles 每帧要为 1000 只怪调它,
 * 返回值一旦是新建对象,帧时间就直接写在 GC 上(零分配铁律,与 localPos 同一条纪律)。
 */
export function enemyAnimFrame(
  anim: EnemyAnim,
  time: number,
  seed: number,
  baseScale: number,
  out: { scale: number; spin: number; wobble: number } = animFrameScratch,
): { scale: number; spin: number; wobble: number } {
  const phase = time * anim.freq + seed * Math.PI * 2;
  out.scale = baseScale * (1 + Math.sin(phase) * anim.breatheAmp);
  out.spin = time * anim.spin + seed * Math.PI * 2;
  out.wobble = Math.sin(phase) * anim.wobbleAmp;
  return out;
}

/**
 * 按塔型生成子弹剪影。**一律取圆对称的轮廓**,不用拉长的弹丸 ——
 * 粒子的 rotation 是静态属性(取舍见构造函数里那段:每帧为 500 颗重传旋转,买的只是一个小块的朝向),
 * 拉长的形状于是会在除 +X 外的任何飞行方向上指错,反倒骗人。朝向信息本来就由弹道自己交代(它在动),
 * 形状只负责回答"这是哪一种弹":
 *   直射弹(FX_BULLET)= 实心亮点,半径**取真实碰撞半径**(灰盒阶段视觉 = 判定,别让玩家学错距离感);
 *   抛射弹(FX_MORTAR)= 空心环,它途中不碰撞、只在落点炸,给个"壳"的读数与直射弹一眼分得开。
 * 几何一律画成白色:颜色由粒子 tint 相乘出来(建粒子时上传一次,零每帧开销),与敌人纹理同一套做法。
 */
function buildBulletShape(def: TowerDef): Graphics {
  const r = Math.max(1, def.bulletRadius);
  const g = new Graphics();
  if (def.fx === FX_MORTAR) {
    // 线宽随半径缩放:固定线宽会把大口径炮弹画成一个细圈,"壳"的读数就没了
    return g.circle(0, 0, r).stroke({ width: Math.max(1.5, r * 0.5), color: 0xffffff });
  }
  // 实心 + 一圈半透明外晕:纯实心小点在深色背景上会糊成一颗噪点,外晕给它可辨的边界
  return g
    .circle(0, 0, r)
    .fill(0xffffff)
    .stroke({ width: 1, color: 0xffffff, alpha: 0.5 });
}

/**
 * 残骸掉落物的剪影(10 号 issue T4)。一律**菱形**,且全场只有这一种形状 ——
 * 圆 / 飞镖 / 胶囊 / 六边被四型敌人占满,实心点与空心环被两类子弹占满,菱形是唯一还空着的一档:
 * 于是"地上那颗是残骸"不必靠颜色也认得出(色盲安全,与敌人分型同一条口径)。
 * 价值差(1/2/2/4,见 data/enemies 的 scrap)**不进画面**:一容器一纹理是这套粒子的前提
 * (取舍见构造函数那段),按价值分容器就得为一个"捡到就没了"的差别多挂三层;
 * 玩家真正要读的是"我攒了多少"(面板读数 / 11 号的 HUD 残骸条),不是"这一颗值几分"。
 * 几何画成灰阶(暗面 + 亮边),颜色由粒子 tint 相乘得到,与敌人/子弹纹理同一套做法。
 * 形状对原点对称(粒子锚点固定 0.5,纹理按包围盒裁):不对称就等于把剪影整体偏出实体真实位置。
 */
function buildDropShape(): Graphics {
  const r = DROP_RADIUS;
  return new Graphics()
    .poly([r, 0, 0, r, -r, 0, 0, -r])
    .fill(DROP_FILL)
    .stroke({ width: DROP_EDGE_WIDTH, color: DROP_EDGE });
}

/**
 * FxEvent 的存续比例:1 = 刚发生,0 = 这一帧就要被 World 回收。
 * full ≤ 0 时退化成 1 —— 数值表被改坏(FX_LIFE_* 填了 0)也不该让画面上出现 NaN 几何。
 */
function fxFade(life: number, full: number): number {
  if (full <= 0) return 1;
  const t = life / full;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * 读数比例夹取。`!(t > 0)` 而不是 `t < 0`:**NaN 与任何数比较都是 false**,写成前者才把 NaN 一并接住 ——
 * 数值表被改坏(弹夹上限填 0、热上限填 0)时,除出来的 NaN 会让 Graphics 画出一条长度 NaN 的矩形,
 * 整个甲板层当场消失;夹成 0 只是"这条读数是空的",画面还在。
 */
function clamp01(t: number): number {
  if (!(t > 0)) return 0;
  return t > 1 ? 1 : t;
}

/**
 * 格填充色。离线格一律去色(灰),不按内容上色 —— "这格是塔还是支援"在它不工作时不重要,
 * "它不工作"才重要;把两条信息叠在同一个色块上,玩家一眼只会读到更抢眼的那条。
 *
 * 武器与支援都**按型上色**,色相分别取 TOWERS[towerType].tint / SUPPORTS[supportType].tint:
 * 战斗远景不画文字也能认塔；支援连线又复用同一个 tint,顺着颜色就能找到来源。
 * 查不到类型(越界或数值表被改坏)分别回落既有的冷蓝/冷青,绝不冒出 undefined 色(GDD §12)。
 * 收整个 cell 而不是两个散字段:支援格要多读一个 supportType,再往参数表里加一个 number
 * 就成了三个位置相邻的同类型参数,调用点传错顺序编译器一声不吭。
 */
function deckCellFill(cell: DeckCell): number {
  if (!cell.online) return DECK_OFFLINE_FILL;
  if (cell.content === CELL_WEAPON) return TOWERS[cell.towerType]?.tint ?? DECK_WEAPON_FILL;
  if (cell.content === CELL_SUPPORT) return SUPPORTS[cell.supportType]?.tint ?? DECK_SUPPORT_FILL;
  return DECK_EMPTY_FILL;
}

export class Renderer {
  readonly app: Application;
  private world: World;
  /** 屏幕空间远景：覆盖画布并做极轻视差，不参与战场镜头缩放。加载失败则只留 app 底色。 */
  private backgroundSprite: Sprite | null;
  private worldLayer = new Container();
  /** 下标 === EnemyKind(与 ENEMIES 同序);每型一个容器,理由见构造函数里的取舍说明 */
  private enemyPcs: ParticleContainer[] = [];
  private enemyParticles: Particle[][] = [];
  private enemyTextures: Texture[] = [];
  /** 生成图自带暖色时取白色；程序化灰阶兜底仍取 enemyTint。全部只在建粒子时上传一次。 */
  private enemyTextureTints: number[] = [];
  /** 每型纹理静态缩放到与飞船同档的世界视觉尺寸。 */
  private enemyTextureScales: number[] = [];
  /** 生成图的正面朝 -Y，程序化箭头朝 +X；逐型记偏移，热路径不再分支查纹理来源。 */
  private enemyRotationOffsets: number[] = [];
  /** 每帧复用的分桶数组:清空只用 length=0,绝不新建(运行期零分配,铁律 3) */
  private enemyBuckets: Enemy[][] = [];
  /** 程序化动画时钟:渲染帧累加(与 stepShake 同一份 dt),时停/甲板视图期间照走 —— 虫子冻结不等于死物 */
  private animClock = 0;
  /**
   * 精英(affixes ≠ 0)各型独立容器。与普通型**同一张纹理、同一个 tint**,只是静态缩放
   * 乘 ELITE.scale:体型差就是"这只不一样"的第一眼读数,而色相通道已经被"哪一型"占满。
   * 分容器而不是把缩放做成逐粒子动态:后者 = 每帧为全部 1000 只重传顶点缓冲,
   * 正是构造函数里那段放弃的取舍 —— 精英一局只有个位数,一只近乎永远为空的容器,
   * 换来所有粒子保持"建粒子时上传一次"的静态预算。
   */
  private elitePcs: ParticleContainer[] = [];
  private eliteParticles: Particle[][] = [];
  private eliteBuckets: Enemy[][] = [];
  /**
   * Boss(15 号)的专属容器:底座型(冲撞甲虫)的**同一张纹理、同一个 tint**,只是静态缩放
   * 让剪影外接半径 = bossRadius() —— 判定体多大画多大。与精英"判定体放大多少剪影就放大
   * 多少"同一条口径,而倍率不走 ELITE:bossRadius 是 sim/boss.ts 的唯一口径,渲染层不另抄。
   * 独立容器而不是塞进 kind 桶:kind = KIND_BOSS 不在 ENEMIES 表里,普通桶的越界兜底
   * 是"不画这一只" —— Boss 必须画,所以单独一只近乎恒非空的容器。
   */
  private bossPc: ParticleContainer;
  private bossParticles: Particle[] = [];
  private bossBucket: Enemy[] = [];
  private bossTextureScale = 1;
  private bossRotationOffset = 0;
  /**
   * 子弹:一种"会产生子弹的塔型"一个容器,取舍与上面的敌人分型完全一致(见构造函数那段说明)。
   * 下标不是 towerType 而是 slot —— 六种塔里只有三种真的打出子弹(光束/链电/磁轨是瞬时判定),
   * 为另外三种留空容器等于白挂三个只会被遍历、永远为空的对象。towerType → slot 的换算走 bulletSlot。
   */
  private bulletSlot: number[] = [];
  private bulletPcs: ParticleContainer[] = [];
  private bulletParticles: Particle[][] = [];
  private bulletTextures: Texture[] = [];
  /** 下标 = slot,取 tint 用(冷色域,GDD §12);同时把"这个 slot 是哪座塔"写在明面上 */
  private bulletDefs: TowerDef[] = [];
  private bulletBuckets: Bullet[][] = [];
  /**
   * 残骸掉落物(10 号 issue T4)。与敌/弹相反,这里**只有一个容器、不分型**:
   * 分容器分的是纹理与 tint(见构造函数那段取舍),而掉落物两样都只有一份
   * (形状恒为菱形、颜色恒为 DROP_TINT,价值差不进画面 —— 见 buildDropShape),
   * 分了只是多挂几个永远为空却每帧被遍历的对象。也不必分桶:池里的 items 本就是致密数组,
   * 整池直接喂给 syncParticles 就行,连那一趟按型分桶的遍历都省了。
   */
  private dropPc: ParticleContainer;
  private dropParticles: Particle[] = [];
  private dropTexture: Texture;
  /**
   * 开火光效层(05 号 T5)。挂在 **worldLayer** 而不是 deckG:FxEvent 的坐标是**世界坐标**
   * (命中点在敌人身上,不在船上),挂进甲板局部空间会让整条光束跟着船转 —— 船一转,
   * 上一帧打出去的光束就会甩到别处去。
   */
  private fxG = new Graphics();
  /** 炮口闪专层：压在甲板之上；其余命中/弹道 FX 仍在甲板之下，不能反过来糊住自己的船。 */
  private muzzleFxG = new Graphics();
  private telegraphG: Graphics;
  /** 甲板容器:子层几何全在船体局部空间,它自己每帧只吃插值位姿(见文件头) */
  private deckG = new Container();
  /** 固定核心舰壳图：只承载装甲侧裙/推进器；真正可扩建的轮廓仍由 deckBaseG 按 occupied 绘制。 */
  private deckHullArtG = new Container();
  /** 舰壳图是否加载成功:战斗态底板据此决定要不要为(全部/扩建)格补船体底色(见 drawDeckBase) */
  private hasHullArt = false;
  private deckBaseG = new Graphics();
  /** 生成的塔/设施图层：随 deck.revision 重建，塔身旋转每帧只改已有 Sprite。 */
  private deckModuleG = new Container();
  private deckTurretSprites: { sprite: Sprite; cell: DeckCell }[] = [];
  private towerTextures: readonly (Texture | null)[];
  private supportTextures: readonly (Texture | null)[];
  /** 放置高亮:压在底板之上,否则合法格的半透明色块会被格子填充盖掉 */
  private deckHiliteG = new Graphics();
  /**
   * 邻接连线 + 装甲舱读数(06 号 T3)+ 进化金光(17 号)。**压在底板之上**:连线要从一格心画到
   * 另一格心,画在底板之下会被两头的格子填充啃掉两截,中间那段悬空的线读不出是从哪儿连到哪儿。
   * 与底板**共用 deck.revision 脏标记**(见 deckRevision):配对只在放置时变
   * (supportLinks 只读 occupied/content/supportType/towerType/online,这几样一变 revision 就 +1),
   * 每帧重画等于让一局里只变几次的几何陪着 60Hz 空转 —— 与底板同一条取舍,故干脆同一个标记;
   * 进化金光额外多认一个 refitSeen 闸门(整备起止不碰 revision,见该字段)。
   */
  private deckLinkG = new Graphics();
  /** 射界扇形(04 号):压在底板之下 —— 它是底衬,不许糊住格子本身的状态色 */
  private deckArcG = new Graphics();
  /**
   * 被撞舷闪红(09 号 T4)。**压在底板之上**:它要盖掉那一舷原本的冷色轮廓线,
   * 画在底板之下就会被格子填充整块挡住,"被撞了"这件事在画面上根本不存在。
   * 与炮口线/读数分层的理由同源:它只在受击后的 hitPenaltyTime 秒里有东西可画,
   * 合进底板就等于让一局只变几次的底板陪着这半秒钟每帧重建。
   */
  private deckHitG = new Graphics();
  /**
   * 炮口线。与扇形分开一层,是因为两者的寿命不同:扇形几何一局里只变几次(放塔、改参数),
   * 炮管却每帧都在转 —— 同一个 Graphics 里没法只 clear 一半,合在一起就等于扇形也跟着每帧重建。
   */
  private deckMuzzleG = new Graphics();
  /**
   * 节流读数(05 号 T5)。与底板分开一层的理由与炮口线同源:底板一局里只变几次(走 revision 脏标记),
   * 而弹夹/热量/充能**每一逻辑帧都在变** —— 合在一个 Graphics 里就等于让底板陪着它每帧重建。
   * 挂在 deckG 里(局部坐标)而不是 worldLayer:读数是"这一格上那座塔的状态",必须跟着格子转。
   */
  private deckThrottleG = new Graphics();
  /**
   * 底板几何的脏标记。占用/内容一局里只变几次(放塔、12 号焊接拼块),
   * 却要每帧出现在画面上 —— 故按 deck.revision 重建,而不是每帧 clear 重画。
   * 初值 -1 保证首帧必建一次(revision 从 0 起)。
   */
  private deckRevision = -1;
  /**
   * 整备阶段闸门(world.refitPending)的上次可见值(17 号)。进化金光随它翻转而重建:
   * 进整备 = 金线进场、整备结束 = 金线清空,而这两个时点甲板 revision 一个字都不变 ——
   * 不记这一档的话,金线会挂到下一次放置/焊接才出现/消失(与 deckRevision 同一条脏标记纪律)。
   */
  private refitSeen = false;
  /**
   * 邻接配对表的复用缓冲(扁平二元组:out[2k] = 支援格下标、out[2k+1] = 受益塔格下标)。
   * 挂在实例上而不是每次现造:重建虽然只发生在放置那一下,但铁律 3 的口径是运行期零新增分配 ——
   * sim 的 supportLinks 收 out 参数,正是为了让调用方能把这块缓冲整局用到底。
   */
  private linkPairs: number[] = [];
  /**
   * 进化配对的复用缓冲(扁平二元组:out[2k] = 满级塔格下标、out[2k+1] = 被吞支援格下标)。
   * 与 linkPairs 同一条口径:sim 的 findEvolutionPairs 收 out,整局复用这一块(铁律 3)。
   */
  private evolvePairs: number[] = [];
  /** 放置模式状态:由 ui 层塞进来,渲染层只读(见 PlacementUiState) */
  private placement: PlacementUiState | null = null;
  /** 高亮层上一帧是否画过东西:退出放置模式时只需 clear 一次,而不是每帧空转 */
  private hiliteDrawn = false;
  /**
   * 甲板缩放的**当前值**与**目标档位**(10 号 issue T4 的时停放大)。分成两个数是为了缓动:
   * 目标由 sync 每帧按"要不要甲板视图"现算(见 deckViewZoom),当前值朝它缓动(见 stepDeckZoom)。
   * 两个都从 1 起步 —— 战斗中甲板就是原尺寸,放大只在升级时停 / 按住 Tab 的那几秒里存在。
   * 计时/相位全在渲染层自持,与 broadside 那一组同一条理由:它纯是表现,
   * 进了 sim 就等于让确定性回放为一次镜头动画负责(铁律 1 的边界画在这儿)。
   */
  private deckZoom = 1;
  private deckZoomTarget = 1;
  /** 流程侧(main 的升级时停)是否要求甲板视图。与按住 Tab 的 arcOverlay 在 sync 里取或 */
  private deckViewRequested = false;
  /** 固定装配界面右侧商店占掉的屏幕宽度；甲板视图据此只在左侧剩余区域内居中与缩放。 */
  private deckViewRightInset = 0;
  /** 航段装配模式：只展示星野与飞船甲板，隐藏冻结的敌人、弹道和掉落物。 */
  private assemblyView = false;
  /** 底板当前画的是哪一档(战斗简化版 / 甲板视图详细版):模式翻转也要触发底板重建 */
  private deckBaseDetailed = false;
  /** 程序化星野(无限地图的方位参照,接替旧的场地边界圈)。变换由 sync 与镜头同步 */
  private readonly starfield = new Starfield();
  /** 射界叠加层开关:main.ts 每渲染帧灌 input.isDown('Tab'),放置态会在 sync 内并入同一 detailed 状态 */
  private arcOverlay = false;
  /** 详细射界上一帧是否画过:退出 Tab/放置时 clear 一次即可(照 hiliteDrawn 的写法) */
  private arcDrawn = false;
  /** 详细节流读数上一帧是否画过：回到战斗态时只 clear 一次，不让隐藏层每帧空转。 */
  private throttleDrawn = false;
  /**
   * 闪红层上一帧是否画过。整局绝大多数帧四舷惩罚都是 0(受击才有,每次只有半秒),
   * 照 hiliteDrawn / arcDrawn 那条口径:惩罚归零后 clear 一次就够,不必每帧空转一个 Graphics。
   */
  private hitDrawn = false;
  /**
   * broadside 反馈的三个运行期状态(05 号 T5 可选项)。**只在渲染层**:
   * 它纯是表现,进了 sim 就等于让确定性回放为一次镜头抖动负责(见文件头)。
   * broadsideTick = 已经为哪一逻辑帧触发过 —— 渲染帧与逻辑帧不同步(120Hz 屏上同一逻辑帧
   * 会被采样两次,掉帧时又会一次跨过好几个逻辑帧),不按 tick 去重就会把一次齐射当成两次。
   * 初值 -1:World.tick 从 0 起步,首帧齐射也必须能触发。
   */
  private broadsideTick = -1;
  private broadsideLeft = 0;
  /** 顿挫方向(世界系单位向量,= 开火那一舷法线的反向 = 后坐)。触发时定死,衰减期间不再跟船转 */
  private broadsideDirX = 0;
  private broadsideDirY = 0;
  private shakeTrauma = 0;
  private shakePhase = 0;
  private shakeX = 0;
  private shakeY = 0;
  /**
   * 齐射闪光:一张铺满屏幕的冷白薄片,挂在 **stage** 上而不是 worldLayer 里 ——
   * 闪光只能是"加"(叠一层亮色),而 Container.tint 是"乘",乘白色等于不变,压根闪不起来;
   * 挂进 worldLayer 又会被镜头缩放/平移带着走。几何只建 1×1,每帧靠 scale 撑到屏幕大小:
   * 窗口一改大小就不必重建几何(与 resizeTo: window 同步,零分配)。
   */
  private flashG = new Graphics().rect(0, 0, 1, 1).fill(FX_CORE_COLOR);

  /**
   * 精英出场预警的去重键(segment × ELITE_WARN_KEY_STRIDE + eliteNext;哨兵 -1 = 无预警)。
   * 预警窗口持续 ELITE_WARN_LEAD 秒,同一只精英只该在**进窗那一帧**响一次 ——
   * 键不变就绝不重复发声;精英出生(eliteNext 前移)或换段后键变,下一只进窗照常响
   * (与 broadsideTick 按 world.tick 去重同一条口径)。
   */
  private eliteWarnKey = -1;
  /** 预警层:挂在 stage(屏幕空间),不被镜头缩放/平移带着走 —— 它是 HUD 级的读数 */
  private readonly eliteWarnG = new Graphics();
  /** peekNextElite 的答复暂存:整局复用,渲染帧现读不新增分配(铁律 3) */
  private readonly elitePeek: ElitePeek = { etaSeconds: 0, kind: 0, count: 0, affixes: [] };

  /**
   * Boss 召唤预告层(15 号):挂在 stage(屏幕空间),与 eliteWarnG 同一条口径 ——
   * 预告是 HUD 级读数,不被镜头缩放/平移带着走。
   */
  private readonly bossWarnG = new Graphics();
  /**
   * 出场音的去重锁:Boss 阶段(0/1/2)的上次可见值。只在 bossPhase 从别的值翻进 1 的那
   * 一帧响 playBossWarn() 一次 —— 渲染帧与逻辑帧不同步(120Hz 屏上同一逻辑帧会被采样
   * 两次),不锁存就会把一次出场当成两次。初值 -1:重开换世界后第一帧必与 0 不同,
   * 但 bossWarnOnEnter(-1, 0) 为 false,不会误响(与 broadsideTick 初值同一条口径)。
   */
  private bossPhaseSeen = -1;

  static async create(world: World): Promise<Renderer> {
    const app = new Application();
    await app.init({
      background: 0x05070d,
      resizeTo: window,
      antialias: false,
      resolution: 1, // 压测口径:1x 分辨率(GDD §13 中端核显预算)
      preference: 'webgl',
    });
    const generatedArt = await loadGeneratedArt();
    document.getElementById('game')!.appendChild(app.canvas);
    return new Renderer(app, world, generatedArt);
  }

  private constructor(app: Application, world: World, generatedArt: GeneratedArtTextures) {
    this.app = app;
    this.world = world;
    this.backgroundSprite = generatedArt.background ? new Sprite(generatedArt.background) : null;
    this.towerTextures = generatedArt.towers;
    this.supportTextures = generatedArt.supports;

    if (this.backgroundSprite) {
      this.backgroundSprite.anchor.set(0.5);
      this.backgroundSprite.alpha = BACKGROUND_ALPHA;
    }

    this.hasHullArt = !!generatedArt.shipHull;
    if (generatedArt.shipHull) {
      const hull = new Sprite(generatedArt.shipHull);
      const size = deckCellSize();
      hull.anchor.set(0.5);
      hull.width = tuning.shipLength + size * SHIP_HULL_LENGTH_PAD;
      hull.height = tuning.shipWidth + size * SHIP_HULL_WIDTH_PAD;
      this.deckHullArtG.addChild(hull);
    }

    // 地图无限,粒子容器的 boundsArea 给一个"永远罩住镜头"的巨矩形:它只是让 Pixi 免算
    // 逐粒子包围盒,不参与任何逐粒子裁剪 —— 以前按 WORLD_RADIUS 取的话,船开出两个场半径
    // 之外整个容器会被判在屏幕外,千只虫子一帧集体消失。
    const bounds = new Rectangle(-1e8, -1e8, 2e8, 2e8);
    const dyn = { position: true, rotation: false, color: false };

    // —— 关键取舍:四型 = 四个 ParticleContainer,而不是塞进同一个容器按型换色/换形 ——
    // ParticleContainer 整个容器只绑一张纹理(ParticleContainerPipe 里 container.texture ||=
    // children[0].texture),想在单容器里按型换形状就得上图集 + 把 uvs 设成 dynamic;
    // 更要命的是池用 swap-remove 回收,粒子↔实体的下标映射每帧都在变,所以单容器要按型上色
    // 就必须把 color 设成 dynamic(想按型换大小还得再加 vertex)——
    // 那等于每帧为全部 1000 个粒子重传 4 顶点的颜色/顶点缓冲,而这些值其实一辈子不变。
    // 分容器的代价只是多 3 个 draw call,GPU 侧可忽略。故:dynamicProperties 保持只有 position
    // 是动态的,每帧只重传位置,tint 与纹理都退化成建粒子时上传一次的静态属性。
    //
    // 敌人容器例外两项(程序化动画,取舍见 ENEMY_ANIM 的注释):
    //   vertex: true —— 呼吸 = 逐帧改 scaleX/scaleY,scale 烤在四角顶点里,不重传就看不见;
    //   rotation: true —— 摆动/自转逐帧改角度(其余三型本来就要按速度转向,圆型蜂群蛭这次也要自转)。
    // 旧注释那句"这些值一辈子不变"的反对不成立:它们是这一帧就要变的数,不重传 = 动画不存在。
    // 子弹/残骸仍是原样(纯静态属性),四型敌人多付出的只是两个本就逐帧上传的缓冲。
    for (let k = 0; k < ENEMIES.length; k++) {
      const def = ENEMIES[k]!;
      const generatedTexture = generatedArt.enemies[k] ?? null;
      // 单张加载失败时回到原有程序化剪影；回退是逐型的，不会因为一张坏图把四型一起撤掉。
      const tex =
        generatedTexture ??
        app.renderer.generateTexture({
          target: buildEnemyShape(def),
          resolution: 2,
          antialias: true,
        });
      this.enemyTextures.push(tex);
      this.enemyTextureTints.push(generatedTexture ? 0xffffff : enemyTint(def.kind));
      this.enemyTextureScales.push(generatedEnemySpan(def) / Math.max(tex.width, tex.height));
      this.enemyRotationOffsets.push(generatedTexture ? GENERATED_ART_FORWARD_OFFSET : 0);
      // 显式把纹理绑在容器上(而不是听任它取第一个粒子的):让"一容器一纹理"这条约束写在明面上
      this.enemyPcs.push(
        new ParticleContainer({
          // 蜂群蛭也要自转(口器绕圈 = 活着),故敌人容器一律开 rotation + vertex(见上注释)
          dynamicProperties: { ...dyn, rotation: true, vertex: true },
          boundsArea: bounds,
          texture: tex,
        }),
      );
      this.enemyParticles.push([]);
      this.enemyBuckets.push([]);
      // 精英容器与普通型同纹理同 dynamicProperties,唯一差别是 sync 时传进去的静态缩放
      this.elitePcs.push(
        new ParticleContainer({
          dynamicProperties: { ...dyn, rotation: true, vertex: true },
          boundsArea: bounds,
          texture: tex,
        }),
      );
      this.eliteParticles.push([]);
      this.eliteBuckets.push([]);
    }

    // —— Boss(15 号):底座型的同一张纹理、同一个 tint,静态缩放使剪影外接半径 = bossRadius() ——
    // 不占 ENEMIES 桶、不走精英缩放(affixes 恒 0 且 ELITE 倍率是精英的账):
    // 判定体 = 底座 radius × BOSS.scale(sim/boss.ts 的 bossRadius 是全仓唯一口径),
    // 剪影就按它画 —— 与"灰盒阶段视觉 = 判定"同一条口径,玩家学到的距离感是 Boss 真身
    const baseDef = ENEMIES[BOSS.baseKind]!;
    const bossTex = this.enemyTextures[BOSS.baseKind]!;
    // 纹理的包围盒半径(半宽)≈ 底座 radius(六边形顶点落在 radius 上,描边略有外扩):
    // 缩放到"半宽 = bossRadius()"即得判定体同尺寸的剪影
    this.bossTextureScale = (bossRadius() * 2) / Math.max(bossTex.width, bossTex.height);
    this.bossRotationOffset = this.enemyRotationOffsets[BOSS.baseKind]!;
    this.bossPc = new ParticleContainer({
      dynamicProperties: { ...dyn, rotation: true, vertex: true },
      boundsArea: bounds,
      texture: bossTex,
    });

    // —— 子弹同样按型分容器,理由与上面那段一字不差(tint/纹理是静态属性,分容器才免得每帧重传)——
    // 只为**真的会产生子弹**的塔型建:FX_BEAM/FX_CHAIN/FX_LANCE 是瞬时判定,画面上的东西全在 fxG,
    // 一颗子弹都不入池,给它们留空容器等于白挂三个永远为空却每帧被遍历的对象。
    // TOWERS 的下标 === towerType,故这里顺序 push 出来的 bulletSlot 可以直接用 towerType 索引。
    for (let t = 0; t < TOWERS.length; t++) {
      const def = TOWERS[t]!;
      if (def.fx !== FX_BULLET && def.fx !== FX_MORTAR) {
        this.bulletSlot.push(-1);
        continue;
      }
      this.bulletSlot.push(this.bulletPcs.length);
      // 2x 分辨率 + 抗锯齿:子弹是全场最小的实体,靠这一点显存换它在 1x 画布上还看得出是个圆
      const tex = app.renderer.generateTexture({
        target: buildBulletShape(def),
        resolution: 2,
        antialias: true,
      });
      this.bulletTextures.push(tex);
      this.bulletPcs.push(
        new ParticleContainer({ dynamicProperties: dyn, boundsArea: bounds, texture: tex }),
      );
      this.bulletParticles.push([]);
      this.bulletDefs.push(def);
      this.bulletBuckets.push([]);
    }

    // 残骸掉落物:同一套粒子做法,只是**一个容器就够**(理由见 dropPc 的字段注释)。
    // 2x 分辨率 + 抗锯齿:菱形只有 5px 出头,1x 画布上不这么烤就糊成一个亮点,形状通道当场作废
    this.dropTexture = app.renderer.generateTexture({
      target: buildDropShape(),
      resolution: 2,
      antialias: true,
    });
    this.dropPc = new ParticleContainer({
      dynamicProperties: dyn,
      boundsArea: bounds,
      texture: this.dropTexture,
    });

    // 冲锋前摇的指示层:每帧 clear 后重画(几何逐帧变)
    this.telegraphG = new Graphics();

    // 船体 = 甲板本身:八个子层装进一个容器,容器负责"跟着船走",子层只管局部几何。
    // 子层序:射界扇形(底衬)→ 底板 → 生成模块图 → 邻接连线
    // (06 号:线要跨过格心,压在底板之下会被填充啃断)
    // → 被撞舷闪红(压住底板那条冷色轮廓线,否则等于没画)
    // → 炮口线(炮管长在甲板上,理应压住底板)
    // → 节流读数(压住炮口线:按住 Tab 时那条线正好横穿格心,把读数划掉就白画了)
    // → 放置高亮(临时的交互层,"我要放哪一格"任何时候都不许被别的层盖住)。
    // 闪红排在炮口线之下:炮管归位是每帧都要看的读数,不该被半秒钟的伤害反馈盖掉;
    // 而它排在连线之上是有意的 —— 装甲舱的舷线与闪红长在同一批边上,挨打那半秒该由闪红说话。
    // 这里不建几何 —— 格子内容要等 sync() 的脏标记在首帧补上(deckRevision = -1)。
    this.deckG.addChild(
      this.deckArcG,
      this.deckHullArtG,
      this.deckBaseG,
      this.deckModuleG,
      this.deckLinkG,
      this.deckHitG,
      this.deckMuzzleG,
      this.deckThrottleG,
      this.deckHiliteG,
    );
    this.deckLinkG.visible = false;

    // 层序:前摇指示 → 敌(按 kind 顺序,后面的型压住前面的:冲撞甲虫排最后,
    // 不会被蜂群蛭糊掉)→ Boss(最大的个体,压在全部普通/精英剪影之上)
    // → 残骸 → 弹 → 开火光效 → 甲板 → 炮口闪。
    // 指示层压在敌人之下:锁定线不该糊住甲虫自己的剪影。
    // 光效排在弹之后、甲板之前:它是"这一发打出去了"的读数,压住敌人才看得见命中在谁身上,
    // 但绝不许盖住甲板自己的格子(放塔与节流读数在那上面)。
    // 甲板压在敌与弹之上,千敌贴脸时自己的格子不会被糊掉 —— 放塔时更是必须看得见;
    // 11 号起 HP 已搬到固定屏幕空间的 DOM HUD,这里不再保留不受时停淡出控制的灰盒重复读数。
    // 残骸(10 号 T4)排在**敌之上、弹之下**:压在敌之下的话,残骸一掉出来就被它自己那堆虫子埋了,
    // 而"残骸正往船上飞"是这一局经济在转的唯一读数;压在弹与光效之上又会让自己的火力
    // 被一串小菱形点花 —— 它终究只是地上的材料,抢不过"我打中了谁"。
    // 一颗才 5px,盖在敌人剪影上也不至于让威胁读数打折。
    this.worldLayer.addChild(this.telegraphG);
    for (let k = 0; k < this.enemyPcs.length; k++) this.worldLayer.addChild(this.enemyPcs[k]!);
    // 精英容器压在普通型之上:大个体不该被身后小个体的剪影啃掉边(与"甲虫排最后"同一条取舍)
    for (let k = 0; k < this.elitePcs.length; k++) this.worldLayer.addChild(this.elitePcs[k]!);
    // Boss 容器压在一切敌剪影之上:它是这一战最大的个体,任何虫群都不许啃它的边
    this.worldLayer.addChild(this.bossPc);
    this.worldLayer.addChild(this.dropPc);
    for (let s = 0; s < this.bulletPcs.length; s++) this.worldLayer.addChild(this.bulletPcs[s]!);
    this.worldLayer.addChild(this.fxG, this.deckG, this.muzzleFxG);
    // 闪光片挂在 stage 最上层(屏幕空间),不进 worldLayer —— 理由见 flashG 的字段注释
    this.flashG.visible = false;
    if (this.backgroundSprite) app.stage.addChild(this.backgroundSprite);
    // 星野压在静态远景之上、世界层之下:它是世界锚定的方位参照(接替旧边界圈),
    // 但终究是背景 —— 不许盖住任何实体
    app.stage.addChild(...this.starfield.views, this.worldLayer, this.eliteWarnG, this.bossWarnG, this.flashG);
  }

  /**
   * 每渲染帧调用。alpha ∈ [0,1):在上一逻辑帧与当前逻辑帧之间插值。
   * @param beforeDeckDraw 可选的甲板交互同步点:镜头、甲板位姿与缩放都已经更新,
   *   合法格高亮还没画。main 在这里重算悬停格,于是放大缓动/转船的**当前帧**里
   *   screenToDeckLocal 与马上要画出来的 deckG 读的是同一个变换,不留一帧错格。
   */
  sync(alpha: number, beforeDeckDraw?: () => void): void {
    const screen = this.app.screen;

    // 船的插值位姿:镜头与船体都取样它。直接用 ship.x/heading 会让整个画面按 60Hz 台阶抖(铁律 2)
    const ship = this.world.ship;
    const sx = ship.px + (ship.x - ship.px) * alpha;
    const sy = ship.py + (ship.y - ship.py) * alpha;
    // 朝向必须沿最短弧插值:线性插值一旦跨过 ±π 边界,船头会反向甩一整圈
    const sh = lerpAngle(ship.pheading, ship.heading, alpha);

    this.syncBackground(screen.width, screen.height, sx, sy);

    // 甲板视图开关:流程侧的升级时停(setDeckZoom)或按住 Tab,二者任一都进同一套详细态 ——
    // 缩放目标、底板详细档、连线/读数/射界的显隐全读这一个布尔,不会出现半套状态。
    const wantDeckView = this.deckViewRequested || this.arcOverlay;

    // 镜头(GDD §3.3):战斗态缩放由"船占屏高比例"反推,固定不变 ——
    // 随速度变焦会让"船身长度"这个唯一的距离参照失效,射界判断也就没了标尺。
    const baseScale = (screen.height * tuning.cameraShipHeightFraction) / tuning.shipLength;
    // 甲板视图的放大倍数按当前甲板外接圆现算:扩建后的船也永远完整落在屏幕里
    this.deckZoomTarget = wantDeckView ? this.deckViewZoom(baseScale) : 1;
    // dt 取渲染帧的实际间隔(不是 SIM_DT):broadside 与缩放两条缓动都在渲染层自持,与逻辑帧率无关
    const dt = Math.min(this.app.ticker.deltaMS / 1000, BROADSIDE_MAX_DT);
    // 程序化动画时钟与缓动同一份 dt:掉帧时一次多走一段,总节奏不变(与 stepBroadside 同口径)
    this.animClock += dt;
    this.stepDeckZoom(dt);
    // 甲板视图 = **整个 worldLayer 的镜头拉近**,不是只放大 deckG:
    // 只放大甲板的话,射界扇形/弹道/光效仍按未放大的世界坐标画,扇形看着能罩住的敌人
    // 实际距离是射程的好几倍 —— 04 号"可视化 = 可命中区域"的口径当场破掉。
    // 镜头整体拉近则甲板、敌人、弹道、扇形共用同一个变换,几何关系永远诚实;
    // 视图里虫潮跟着变大也是对的:那就是"凑近看自己的船",时停里它们本就冻结。
    const scale = baseScale * this.deckZoom;
    // 屏高比例换算回世界单位,于是 look-ahead 的实际观感与窗口大小无关。
    // scale 已含视图缩放 ⇒ 拉近时镜头前推那一截(世界单位)自动同步归零,
    // 放大后的甲板不会偏在屏幕后半区、上缘也不会伸出屏幕外。
    // 甲板视图(升级/整备)一律不推:船体已固定朝上,再沿真实航向看前就失去了"看船本身"的意义
    const lookAhead =
      this.assemblyView || this.deckViewRequested ? 0 : (screen.height * tuning.cameraLookAhead) / scale;
    this.worldLayer.scale.set(scale);
    // pivot 落在船前方 → 船被推到屏幕后半区,腾出的视野正是要转过去的方向
    const pivotX = sx + Math.cos(sh) * lookAhead;
    const pivotY = sy + Math.sin(sh) * lookAhead;
    this.worldLayer.pivot.set(pivotX, pivotY);

    // broadside 顿挫直接加在镜头的屏幕位置上:worldLayer 无旋转,故世界系的方向向量
    // 与屏幕系一一对应,不必再换算一次。screenToWorld 走的是 worldLayer.toLocal,
    // 于是抖动期间"光标底下是哪一格"依然算得对(那句注释里预留的"将来加震屏"就是这里)。
    const broadsideKick = this.assemblyView ? 0 : this.stepBroadside(dt, sh);
    if (this.assemblyView) {
      this.shakeX = 0;
      this.shakeY = 0;
    } else {
      this.stepShake(dt);
    }
    if (this.assemblyView && this.flashG.visible) this.flashG.visible = false;
    const viewportWidth = Math.max(1, screen.width - this.deckViewRightInset);
    const posX = viewportWidth / 2 + this.broadsideDirX * broadsideKick + this.shakeX;
    const posY = screen.height / 2 + this.broadsideDirY * broadsideKick + this.shakeY;
    this.worldLayer.position.set(posX, posY);

    // 星野与镜头同一帧同一组变换(含顿挫):它是世界锚定的背景,镜头动它就得动
    this.starfield.sync(scale, pivotX, pivotY, posX, posY, screen.width, screen.height);

    // 按型分桶:每帧单趟遍历,桶是复用数组(length=0 而不是新建),运行期零分配
    const buckets = this.enemyBuckets;
    for (let k = 0; k < buckets.length; k++) buckets[k]!.length = 0;
    const eliteBuckets = this.eliteBuckets;
    for (let k = 0; k < eliteBuckets.length; k++) eliteBuckets[k]!.length = 0;
    this.bossBucket.length = 0;
    const enemies = this.world.enemies.items;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i]!;
      // Boss(kind 4,affixes 恒 0)不进普通桶也不进精英桶:它走专属容器
      //(kind 越界在普通桶是"不画这一只"的兜底,Boss 必须画 —— 见 bossPc 字段注释)
      if (e.kind === KIND_BOSS) {
        this.bossBucket.push(e);
        continue;
      }
      // 精英(affixes ≠ 0)不进普通桶:它们走各自的精英容器(体型 ×ELITE.scale,见字段注释)
      if (e.affixes !== 0) {
        const eb = eliteBuckets[e.kind];
        if (eb) eb.push(e); // kind 越界只是不画这一只,不炸掉整局
      } else {
        const bucket = buckets[e.kind];
        if (bucket) bucket.push(e); // kind 越界只是不画这一只,不炸掉整局
      }
    }

    this.telegraphG.clear();
    for (let k = 0; k < buckets.length; k++) {
      const def = ENEMIES[k]!;
      const bucket = buckets[k]!;
      this.syncParticles(this.enemyParticles[k]!, this.enemyPcs[k]!, bucket, {
        texture: this.enemyTextures[k]!,
        tint: this.enemyTextureTints[k]!,
        scale: this.enemyTextureScales[k]!,
        rotationOffset: def.shape === 'circle' ? undefined : this.enemyRotationOffsets[k],
        anim: ENEMY_ANIM[k]!,
        alpha,
      });
      // 精英:同纹理同 tint,静态缩放乘 ELITE.scale —— 与 sim/enemy 的 enemyRadius 同一个乘数,
      // 判定体放大多少剪影就放大多少,不会出现"挨打的圈比画出来的大/小"的错位
      const eliteBucket = this.eliteBuckets[k]!;
      this.syncParticles(this.eliteParticles[k]!, this.elitePcs[k]!, eliteBucket, {
        texture: this.enemyTextures[k]!,
        tint: this.enemyTextureTints[k]!,
        scale: this.enemyTextureScales[k]! * ELITE.scale,
        rotationOffset: def.shape === 'circle' ? undefined : this.enemyRotationOffsets[k],
        anim: ENEMY_ANIM[k]!,
        alpha,
      });
      // 前摇指示按型共享配额:精英与普通怪同型,合起来不能超过一型的预算
      let budget = TELEGRAPH_MAX_PER_KIND;
      budget = this.drawTelegraph(bucket, def, alpha, budget);
      this.drawTelegraph(eliteBucket, def, alpha, budget);
    }
    // Boss:底座型同纹理同 tint,静态缩放使剪影外接半径 = bossRadius()(构造时算好)——
    // 与普通型分桶同一条 syncParticles 路径,判定体多大画多大
    this.syncParticles(this.bossParticles, this.bossPc, this.bossBucket, {
      texture: this.enemyTextures[BOSS.baseKind]!,
      tint: this.enemyTextureTints[BOSS.baseKind]!,
      scale: this.bossTextureScale,
      rotationOffset: this.bossRotationOffset,
      anim: ENEMY_ANIM[BOSS.baseKind]!,
      alpha,
    });
    this.drawBossTelegraph(alpha);

    // 子弹按 towerType 分桶,写法与上面的敌人分型一字不差(复用数组 + length = 0,零分配)。
    // 越界或非弹道塔(bulletSlot 为 -1)的弹只是不画,不炸掉整局 —— 与 kind 越界同一条兜底口径
    const bBuckets = this.bulletBuckets;
    for (let s = 0; s < bBuckets.length; s++) bBuckets[s]!.length = 0;
    const bullets = this.world.bullets.items;
    for (let i = 0; i < bullets.length; i++) {
      const b = bullets[i]!;
      const slot = this.bulletSlot[b.towerType];
      if (slot !== undefined && slot >= 0) bBuckets[slot]!.push(b);
    }
    for (let s = 0; s < bBuckets.length; s++) {
      this.syncParticles(this.bulletParticles[s]!, this.bulletPcs[s]!, bBuckets[s]!, {
        texture: this.bulletTextures[s]!,
        tint: this.bulletDefs[s]!.tint,
        alpha,
      });
    }

    // 残骸掉落物:整池直接喂进去(池的 items 本就是致密数组,不必像敌/弹那样先分桶),
    // 与它们同一套 syncParticles ⇒ 一并吃 alpha 插值:磁吸段每秒 300px,不插值就是一串跳点
    this.syncParticles(this.dropParticles, this.dropPc, this.world.drops.items, {
      texture: this.dropTexture,
      tint: DROP_TINT,
      alpha,
    });

    // 开火光效:瞬时判定的四类全在这一层。**不插值**(见 drawFx)
    this.drawFx();

    // 甲板:底板只在 deck.revision 变了或战斗/视图两档翻转时才重建,高亮层每帧现算(它跟着鼠标走)。
    // 容器只吃插值位姿,格子几何一律是局部坐标 —— 甲板与船体一同旋转由此成立(见文件头)
    const deck = this.world.deck;
    // 进化金光多认一个闸门:refitPending 起止不碰 deck.revision(进整备/整备结束都不改甲板),
    // 不记 refitSeen 的话金线会挂到下一次放置才出现/消失(17 号:整备阶段外不画)
    const refitActive = this.world.refitPending;
    if (
      deck.revision !== this.deckRevision ||
      wantDeckView !== this.deckBaseDetailed ||
      refitActive !== this.refitSeen
    ) {
      this.deckRevision = deck.revision;
      this.deckBaseDetailed = wantDeckView;
      this.refitSeen = refitActive;
      this.drawDeckBase(deck, wantDeckView);
      this.drawDeckModules(deck);
      // 邻接连线与底板同一个脏标记:两者都只在放置那一下变(见 deckLinkG 的字段注释)
      this.drawDeckLinks(deck);
    }
    this.deckG.position.set(sx, sy);
    // 甲板视图(升级/整备)里船体固定朝上,不跟当前航向转 —— build 界面的可读性
    // 优先于"船头此刻指哪";战斗态(Tab 射界叠加除外)才让甲板随航向旋转
    this.deckG.rotation = this.deckViewRequested ? DECK_VIEW_UP_FACING : sh;
    // 甲板视图的缩放缓动在帧首、镜头 scale 落地之前就推完了(见上面的 stepDeckZoom 调用):
    // 时停期间 loop 不再推进(alpha 恒 0、世界一动不动),但 ticker 与 sync 照跑,
    // 于是这段缓动仍然动得起来;它本就该是纯表现,与 sim 的时间无关。
    // 甲板交互必须卡在**变换已落地、高亮还没画**的这一点重算:放在 main 的 sync 之前会读上一帧变换,
    // 放在 sync 之后又会让这一帧的框晚一帧。回调由 main 灌入,render 不反向 import ui。
    beforeDeckDraw?.();
    // 战斗态只留船壳、模块贴图、船头标识与开火/受击反馈;甲板视图才恢复格子、邻接、装甲、
    // 节流与射界 —— 所有详细子层读同一个 wantDeckView,不会出现"松了 Tab 但装甲图标还挂着"。
    const deckDetailed = wantDeckView;
    this.deckLinkG.visible = deckDetailed;
    this.drawDeckHit(deck);
    this.drawDeckHilite(deck);
    this.drawDeckThrottle(deck, deckDetailed);
    this.drawDeckArcs(deck, deckDetailed);
    this.syncDeckModuleRotations();

    // 精英出场预警(出生前 ~2s):屏幕空间一层,读 wave 的只读游标 —— 零 rng、零状态改动,
    // 只把脚本里早就写着的事提前念给玩家听。放在帧末:镜头/甲板变换都已落地。
    this.syncEliteWarning(sx, sy);
    // Boss 战提示(出场音 + 召唤预告,15 号):同上,屏幕空间一层,读 world 的 bossPhase /
    // bossSummonCooldown —— 零 rng、零状态改动,只把 sim 里早就写着的事念给玩家听。
    this.syncBossWarn(sx, sy, alpha);

  }

  /**
   * 四舷里剩余最久的那一档惩罚秒数;0 = 本帧没有任何一舷在挨罚。
   *
   * 被撞舷闪红读的是 **sim 的那一个计时器**(world.edgePenalty,与该舷塔的射速惩罚同源),
   * 于是"闪红 / 塔变慢"天然同起同落,想差一帧都做不到。
   * 取最大值而不是"有没有":两舷同时挨打时,回执理应按**还没走完的那一档**继续给。
   */
  private hitPenaltyLeft(): number {
    const penalty = this.world.edgePenalty;
    let left = 0;
    for (let e = 0; e < EDGE_COUNT; e++) {
      const v = penalty[e]!;
      if (v > left) left = v;
    }
    return left;
  }

  /**
   * 画布像素 → 世界坐标。普通世界交互的统一入口;10 号的放大甲板拾取改走 screenToDeckLocal:
   * 镜头的缩放/pivot 都在渲染层,ui 层不该再复制一份镜头公式 —— 那是两处必然会走散的真相。
   * 走 worldLayer.toLocal:镜头怎么变(将来加震屏、变焦)这里都不用改。
   * out 由调用方给,零分配(铁律 3)。
   */
  screenToWorld(sx: number, sy: number, out: Vec2): Vec2 {
    screenPos.x = sx;
    screenPos.y = sy;
    return this.worldLayer.toLocal(screenPos, undefined, out);
  }

  /**
   * 画布像素 → **甲板局部坐标**(局部 +X = 船头、+Y = 右舷,与 cellLocalPos / cellIndexAtLocal
   * 是同一套坐标)。10 号 issue 的放置流一律走这一条拾格子。
   *
   * 为什么不接着用 screenToWorld + cellIndexAtWorld:那条路要在 ui 侧把"镜头缩放 → 船位姿"
   * 这串变换重走一遍(甲板视图的拉近也在里面)—— ui 层自己抄一份镜头/缩放公式,
   * 两处迟早走散,而走散的样子恰好是**看到的高亮框与点中的格差一截**
   * (那还是玩家花了残骸、正要把塔放下去的那一刻)。
   * 这里走 deckG.toLocal:镜头怎么变(缩放、broadside 震屏)、甲板放没放大、放大缓动走到哪一帧、
   * 船此刻转到什么角度 —— 全部由容器**当前的**世界变换自己交代,本方法与调用方一个字都不用改。
   * 于是"缓动中途点下去也不会错格"是结构上成立的:高亮画在这个变换下,拾取也问这个变换。
   * out 由调用方给,零分配(铁律 3)。
   */
  screenToDeckLocal(sx: number, sy: number, out: Vec2): Vec2 {
    screenPos.x = sx;
    screenPos.y = sy;
    return this.deckG.toLocal(screenPos, undefined, out);
  }

  /**
   * 时停放大开关(GDD §11 / 10 号 issue T4:三选一 → **时停** → 甲板视图 + 合法格高亮)。
   * 只立"要不要视图"这一个意图,倍数与缓动由 sync 每渲染帧现算(见 deckViewZoom / stepDeckZoom)——
   * 于是调用方(main.ts 的弹卡/结算那两句)不必关心动画,也绝不会在 UI 事件里直接写 scale。
   * 与 setPlacement / setArcOverlay 同一条依赖方向:流程状态由 main/ui 灌进来,
   * 渲染层不认识"时停"这件事,也不去碰 loop —— 冻结世界是 main + loop.halt 的活。
   */
  setDeckZoom(on: boolean): void {
    this.deckViewRequested = on;
    // 开火事件的坐标属于开火那一刻的世界空间；时停后它的 life 不再衰减,而甲板还会继续放大。
    // 进入放置详细态就立即清掉这层,避免一枚冻结闪光脱离塔身、永久压在选格界面上。
    if (on) this.muzzleFxG.clear();
  }

  /**
   * 航段装配是一个独立的固定界面，不是把战斗画面原样冻住后盖一张菜单：左边只留飞船甲板，
   * 右边由 DOM 商店接管。隐藏的只是表现容器，World 中的敌人/子弹/掉落状态一项不改；退出装配后
   * 同一批对象会原样恢复，因此这不会影响确定性、战斗结算或对象池。
   */
  setAssemblyView(on: boolean): void {
    this.assemblyView = on;
    const showBattle = !on;
    this.telegraphG.visible = showBattle;
    for (let i = 0; i < this.enemyPcs.length; i++) this.enemyPcs[i]!.visible = showBattle;
    for (let i = 0; i < this.elitePcs.length; i++) this.elitePcs[i]!.visible = showBattle;
    this.bossPc.visible = showBattle;
    this.dropPc.visible = showBattle;
    for (let i = 0; i < this.bulletPcs.length; i++) this.bulletPcs[i]!.visible = showBattle;
    this.fxG.visible = showBattle;
    this.muzzleFxG.visible = showBattle;
    if (on) {
      // 装配界面不应把进入前那一下齐射的镜头顿挫带到下一波恢复战斗之后。
      this.broadsideLeft = 0;
      this.broadsideDirX = 0;
      this.broadsideDirY = 0;
      this.flashG.visible = false;
    }
  }

  /** 右侧固定商店的实时宽度；窗口缩放时由 refitFlow 重新灌入。 */
  setDeckViewRightInset(px: number): void {
    this.deckViewRightInset = Number.isFinite(px) && px > 0 ? px : 0;
  }

  /**
   * 甲板视图的放大倍数:让甲板外接圆直径占屏幕短边的 DECK_VIEW_FRACTION。
   * 每帧现算而不是进入视图时算一次:放置流程里就能焊拼块(甲板当场变大)、窗口也随时会变尺寸,
   * 两者都该让倍数当帧跟上 —— deckOuterRadius 是十几格的一遍 hypot,热路径付得起。
   * 下限夹在 1:空甲板(理论上不存在)或极端小屏也绝不会把甲板"缩小"进视图。
   */
  private deckViewZoom(scale: number): number {
    const r = deckOuterRadius(this.world.deck);
    if (r <= 0) return 1;
    const screen = this.app.screen;
    const viewportWidth = Math.max(1, screen.width - this.deckViewRightInset);
    const fit = (Math.min(viewportWidth, screen.height) * DECK_VIEW_FRACTION) / (2 * r * scale);
    return fit > 1 ? fit : 1;
  }

  /**
   * 换掉整个 World(08 号 issue T3 的重开流程 —— 验收标准原文:一局从开始到胜利/失败/重开
   * **全流程无需刷新页面**)。重开一律是"换一个新 World",而不是给 World 加 reset():
   * 池、rng、tick、甲板全是新的,才谈得上"同 seed 可复现"(旧世界跑过的随机数一个都不许留)。
   *
   * 于是渲染层这边要作废的,只有**跨 World 就会说谎的缓存**这两处:
   *   deckRevision:新甲板的 revision 从 0 起步,不置 -1 就会与上一局最后那个值撞上 ——
   *     底板与邻接连线于是停在上一局的样子(空船看上去还带着上一局放的塔),而且再也不会自己好起来:
   *     脏标记的判据是"变了没有",不是"是不是同一艘船";
   *   broadside 那一组:去重键 broadsideTick 认的是 world.tick,而新 World 的 tick 同样从 0 起 ——
   *     留着旧值只会让新局的第 n 帧齐射被误判成"这一帧已经触发过"。顺手把衰减与方向清零、
   *     把闪光片关掉:那是**上一局最后一次齐射**的镜头顿挫,不该跟着新船开出去
   *     (flashG 挂在 stage 上、不归任何一层的 clear 管,只能在这儿关)。
   *
   * 其余脏标记 hitDrawn / hiliteDrawn / arcDrawn **是自愈的**,这里一个字都不必写:
   * 三者各自的条件(某舷在挨罚 / 放置模式开着 / 按住 Tab)一旦不成立,对应的 draw* 会 clear 一次
   * 再落回 false —— 新局第一帧就把上一局的残影抹干净了;条件仍然成立时它们本来就每帧重画。
   * 粒子也不必动:池里的粒子只增不删,本帧多出来的那些下一次 syncParticles 会被挪去 OFFSCREEN。
   */
  setWorld(world: World): void {
    this.world = world;
    this.deckRevision = -1;
    this.refitSeen = false;
    this.broadsideTick = -1;
    this.broadsideLeft = 0;
    this.broadsideDirX = 0;
    this.broadsideDirY = 0;
    this.flashG.visible = false;
    // 预警去重键同理:新 World 的 segment/eliteNext 从 0 起,留着旧键会让新局第一只精英
    // 被误判成"这一只已经响过"(与 broadsideTick 那一段同一条理由)
    this.eliteWarnKey = -1;
    // Boss 出场音去重锁同理:新 World 的 bossPhase 从 0 起,留着旧值(通常是 1/2)会让
    // 新局的 Boss 出场被误判成"已经响过";-1 则首帧必然走过一次比较,但 0 不是进战,
    // 不会误响(与 broadsideTick 初值 -1 同一条口径)
    this.bossPhaseSeen = -1;
    // 时停放大是**上一局那张卡片**留下的表现状态,新局一律从战斗态起步:
    // 调参面板的重开按钮在时停期间照样点得动(它不认识"正在弹卡"),不复位的话新船会带着
    // 上一局的甲板视图开出去,而那一局再也没有一次 setDeckZoom(false) 来关它。
    // **当场吸附、不缓动**:重开是"换一艘船",不是一次转场 —— 缩回去的那段动画属于上一局
    this.deckViewRequested = false;
    this.deckViewRightInset = 0;
    this.setAssemblyView(false);
    this.deckZoom = 1;
    this.deckZoomTarget = 1;
  }

  /**
   * 截一张当前船形剪影的 dataURL,抓不到返回 null(08 号 T3 可选项:结算界面的"最终船形",
   * P3 传播素材的最小雏形)。
   *
   * 抓 **deckG** 而不是整块画布:玩家要留下的是"我这一局把船拼成了什么样",
   * 而画布上那一千只虫子只会把它糊掉。extract 走的是 target 的 **local bounds**,
   * 于是容器自己的位姿(镜头缩放、船此刻的朝向)一概不进图 —— 出来的永远是船头朝 +X 的正像,
   * 而不是玩家沉船那一瞬刚好歪着的那个角度。
   *
   * 交互层与逐帧读数临时藏起来:放置高亮 / 射界扇形 / 弹夹热量画的都是"此刻的操作状态",
   * 不是这艘船本身,留在图里就成了一张糊着蓝框的截图。藏与还原走 try/finally ——
   * extract 抛了(上下文丢失、离屏 canvas 不给 toDataURL)也绝不能把这几层永久关掉,
   * 那会让重开后的甲板缺三层读数。整体再 try/catch 兜底:剪影是锦上添花,
   * 抓不到就交 null(ui 侧 RunSummary.silhouette 收的就是 string | null),结算界面照常弹 ——
   * 一张图绝不许把胜负结算这条主流程带崩。
   *
   * 一局只调一次(结算那一下),故这里的临时数组与分辨率都不必心疼(铁律 3 管的是热路径)。
   */
  captureShipSilhouette(): string | null {
    const hidden = [
      this.deckArcG,
      this.deckMuzzleG,
      this.deckThrottleG,
      this.deckHiliteG,
      this.deckHitG,
    ];
    try {
      for (let i = 0; i < hidden.length; i++) hidden[i]!.visible = false;
      // 4x + 抗锯齿:船缩到 48×36 世界 px 后,deckG 的 local bounds 只有 ~60×48 ——
      // 4x 出 ~240px。这里不取 8x:剪影要进 localStorage 限量集合(19 号口径"降采样或限量",
      // sim/progress.ts 已做最近 10 张 + 500KB 预算,渲染侧负责压单张体积;PNG dataURL 按
      // 面积走,8x 比 4x 大 ~4 倍),240px 对图鉴缩略图足够,结算卡片则用 CSS 封顶缩放 ——
      // 图鉴收藏优先保容量,清晰度交给按需放大
      const canvas = this.app.renderer.extract.canvas({
        target: this.deckG,
        resolution: 4,
        antialias: true,
      });
      // toDataURL 在 ICanvas 上是**可选**方法(某些离屏 canvas 实现没有它):没有就当作抓不到
      return canvas.toDataURL?.('image/png') ?? null;
    } catch {
      return null;
    } finally {
      for (let i = 0; i < hidden.length; i++) hidden[i]!.visible = true;
    }
  }

  /**
   * 接线放置模式。只存引用不拷贝:ui 层每帧就地改字段(hoverIndex/denyIndex),
   * 渲染层下一帧自然读到最新值,两边不必再约定一个"通知"通道。传 null = 摘掉放置层。
   */
  setPlacement(state: PlacementUiState | null): void {
    this.placement = state;
    // 摘掉时不留残影:下一次 drawDeckHilite 会看 hiliteDrawn 补一次 clear
  }

  /**
   * 射界叠加层开关(GDD §4.2:**按住** Tab 显示,不是 toggle,所以这里收的是"键此刻是否按着"
   * 而不是一次按键事件)。渲染层不 import core/input —— 键盘状态由 main.ts 每渲染帧灌进来,
   * 与 setPlacement 同一条依赖方向(输入/ui → render,render 不反向依赖)。
   */
  setArcOverlay(on: boolean): void {
    this.arcOverlay = on;
  }

  /**
   * 甲板底板:格子填充 + 格线 + 船体轮廓 + 船头标识,全部画在船体局部空间(局部 +X = 船头)。
   * 轮廓照 sim 推导出的 exposed 位掩码逐边画,而不是照 3×4 的矩形写死 ——
   * 12 号扩建出非矩形甲板时,这段一个字都不用改(也顺手把"哪几条边算暴露"画给玩家看,
   * 而暴露边正是 04 号射界与"武器塔只能上边缘格"的依据)。
   * 只在 deck.revision 或战斗/视图两档变化时调用,故这里可以放心多跑几趟循环。
   *
   * @param detailed 甲板视图才画格子填充与格线;战斗态的船与敌人同档大小,几十 px 里塞一张
   *   3×4 网格只会糊成噪点 —— 战斗态只留船壳图、模块贴图、轮廓与船头标识,
   *   "甲板"作为一套 build 界面只在升级时停 / Tab 里存在(用户口径,亦即 GDD §3.3
   *   "细节留给船坞放大视图"的彻底版)。
   */
  private drawDeckBase(deck: Deck, detailed: boolean): void {
    const g = this.deckBaseG;
    g.clear();
    const size = deckCellSize();
    const half = size / 2;
    const inset = DECK_CELL_GAP / 2;
    const cells = deck.cells;

    // 一、格子本体:按 content 上色,离线格灰显。只在甲板视图里画(见方法注释)
    if (detailed) {
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i]!;
        if (!c.occupied) continue; // 不属于船体的格不画:12 号扩建前恒为 true
        const p = cellLocalPos(deck, c.col, c.row, localPos);
        const fill = deckCellFill(c);
        const a = c.online ? 1 : DECK_OFFLINE_ALPHA;
        g.rect(p.x - half + inset, p.y - half + inset, size - DECK_CELL_GAP, size - DECK_CELL_GAP)
          .fill({ color: fill, alpha: a * DECK_CELL_FILL_ALPHA })
          .stroke({ width: DECK_GRID_WIDTH, color: DECK_GRID_COLOR, alpha: a });
      }
    } else {
      // 战斗态不画格子,但船必须仍有"身体":舰壳图的尺寸定死在初始 3×4 包围盒上,
      // 12 号焊出去的扩建格在它覆盖范围之外 —— 不补底色的话,焊上去的甲板在战斗里只剩
      // 一条发丝级轮廓,P3"船形即成长"在战斗画面上就消失了;舰壳图整张加载失败时,
      // 整艘船同样靠这层底色兜住(generatedAssets 的兜底契约)。
      // 不留格缝、不描格线:它是船身剪影的一部分,不是"甲板网格"——格子只属于甲板视图。
      const halfLen = tuning.shipLength / 2;
      const halfWid = tuning.shipWidth / 2;
      let filled = 0;
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i]!;
        if (!c.occupied) continue;
        const p = cellLocalPos(deck, c.col, c.row, localPos);
        if (this.hasHullArt && Math.abs(p.x) < halfLen && Math.abs(p.y) < halfWid) continue;
        g.rect(p.x - half, p.y - half, size, size);
        filled++;
      }
      // 攒成一条 path 一次填充:同色同 alpha 的船身底色,不需要逐格表现
      if (filled > 0) g.fill(SHIP_FILL);
    }

    // 舰壳贴图已经完整交代战斗态的船形与朝向；继续描甲板外缘只会在它外面套出一个
    // 3×4 的矩形“格子”。建造轮廓只属于详细甲板视图，贴图缺失时才保留作兜底。
    if (!detailed && this.hasHullArt) return;

    // 二、船体轮廓 = 所有暴露边(船头那条除外,它归下面单独描)。攒成一条 path 只 stroke 一次
    let hull = 0;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      if (!c.occupied) continue;
      const p = cellLocalPos(deck, c.col, c.row, localPos);
      // 局部 +X = 船头、+Y = 右舷(全仓唯一口径,与 sim/deck 的边下标一致)
      if (isEdgeExposed(c, EDGE_STARBOARD)) {
        g.moveTo(p.x - half, p.y + half).lineTo(p.x + half, p.y + half);
        hull++;
      }
      if (isEdgeExposed(c, EDGE_PORT)) {
        g.moveTo(p.x - half, p.y - half).lineTo(p.x + half, p.y - half);
        hull++;
      }
      if (isEdgeExposed(c, EDGE_STERN)) {
        g.moveTo(p.x - half, p.y - half).lineTo(p.x - half, p.y + half);
        hull++;
      }
    }
    if (hull > 0) g.stroke({ width: DECK_HULL_WIDTH, color: SHIP_EDGE });

    // 三、船头标识:朝向必须一眼可辨(纯矩形网格在快速转向时分不清头尾)。两重保险 ——
    // 全部朝船头的暴露边加亮描边(高速转向时看的是这条最亮的边),外加一个艏尖三角(静止时看形状)
    let bow = 0;
    let bowX = -Infinity;
    let bowY = 0;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      if (!c.occupied || !isEdgeExposed(c, EDGE_BOW)) continue;
      const p = cellLocalPos(deck, c.col, c.row, localPos);
      g.moveTo(p.x + half, p.y - half).lineTo(p.x + half, p.y + half);
      const edgeX = p.x + half;
      if (edgeX > bowX || (edgeX === bowX && Math.abs(p.y) < Math.abs(bowY))) {
        bowX = edgeX;
        bowY = p.y;
      }
      bow++;
    }
    if (bow > 0) {
      g.stroke({ width: DECK_BOW_WIDTH, color: DECK_BOW_COLOR });
      // 艏尖挂在最靠前、且最接近原船中线的那条真实暴露边上。异形扩建可能只向一侧伸出，
      // 若仍写死 y=0，三角会悬在空气里，与实际船形脱节。
      const w = size * DECK_PROW_HALF_W;
      g.poly([
        bowX,
        bowY - w,
        bowX + size * DECK_PROW_LEN,
        bowY,
        bowX,
        bowY + w,
      ]).fill(DECK_BOW_COLOR);
    }
  }

  /**
   * 把生成的塔/设施图放进甲板格。只随 deck.revision 重建：放置、升级、焊接时才分配 Sprite；
   * 平常战斗帧只由 syncDeckModuleRotations 改现有塔图的 rotation，设施图完全静态。
   * 某一型贴图没加载到时,在同一层画一块按型色块兜底(generatedAssets 的契约:坏一张图
   * 不该让那一格在画面上消失)—— 战斗态底板已不再画格子,这一层是该契约唯一的落点。
   */
  private drawDeckModules(deck: Deck): void {
    const old = this.deckModuleG.removeChildren();
    for (let i = 0; i < old.length; i++) old[i]!.destroy();
    this.deckTurretSprites.length = 0;

    const maxSize = deckCellSize() * DECK_MODULE_SIZE;
    const cells = deck.cells;
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i]!;
      if (!cell.occupied) continue;

      let texture: Texture | null | undefined;
      if (cell.content === CELL_WEAPON) texture = this.towerTextures[cell.towerType];
      else if (cell.content === CELL_SUPPORT) texture = this.supportTextures[cell.supportType];
      else continue;

      const p = cellLocalPos(deck, cell.col, cell.row, localPos);
      if (!texture) {
        // 兜底色块:取该格的类型色(离线自动灰),尺寸与贴图同档 —— 只在放置/焊接那一下分配,
        // 不进热路径(铁律 3 管的是逐帧)
        const fb = new Graphics()
          .rect(-maxSize / 2, -maxSize / 2, maxSize, maxSize)
          .fill(deckCellFill(cell));
        fb.position.set(p.x, p.y);
        fb.alpha = cell.online ? 1 : DECK_OFFLINE_ALPHA;
        this.deckModuleG.addChild(fb);
        continue;
      }
      const sprite = new Sprite(texture);
      sprite.anchor.set(0.5);
      sprite.position.set(p.x, p.y);
      sprite.scale.set(maxSize / Math.max(texture.width, texture.height));
      sprite.rotation = GENERATED_ART_FORWARD_OFFSET;
      sprite.alpha = cell.online ? 1 : DECK_OFFLINE_ALPHA;
      if (!cell.online) sprite.tint = 0x8a929b;
      this.deckModuleG.addChild(sprite);

      if (cell.content === CELL_WEAPON) this.deckTurretSprites.push({ sprite, cell });
    }
  }

  /**
   * 塔图正面跟随 sim 的真实局部炮口角；世界朝向仍由 deckG.rotation 统一叠加。
   * 只遍历已存在的塔 Sprite（满甲板也只是十几项），不创建临时对象、不重算格心。
   * 甲板视图(升级/整备)里跳过:模块一律朝上(与船体同向),不跟随射界方向
   * —— build 界面展示的是船的整体构型,炮口角是战斗读数,不在这里掺和。
   */
  private syncDeckModuleRotations(): void {
    if (this.deckViewRequested) return;
    for (let i = 0; i < this.deckTurretSprites.length; i++) {
      const binding = this.deckTurretSprites[i]!;
      const cell = binding.cell;
      const def = TOWERS[cell.towerType];
      if (!def || !cellArc(cell, 0, towerArcDeg(def, cell.level), arcTmp)) continue;
      binding.sprite.rotation = arcTmp.center + cell.turretOffset + GENERATED_ART_FORWARD_OFFSET;
    }
  }

  /**
   * 邻接效果的可视化(06 号 issue T3)—— 支援设施到受益塔的连线,外加装甲舱那两条自成一路的读数。
   *
   * 06 号验收标准第二条是"连线只出现在**真实生效**的配对上",本方法落实它的手段只有一条:
   * 配对表**必须**来自 sim 的 supportLinks —— 正交相邻(不含斜角、洞不算邻居)、受益格得是一座
   * 在线的塔、节流类型必须匹配(supportAffects),三条判据一个字都不在这里重写。
   * 于是"画出来的就是真生效的"是**结构上的**:UI 与 buff 计算读的是同一份表,而不是两处各判一次
   * (与射界叠加层只调 cellArc 完全同一条口径 —— 那边保的是"可视化 = 可命中区域")。
   *
   * 几何一律画在**甲板局部空间**(格心问 cellLocalPos,渲染层绝不自己再算一遍):
   * 于是"连线随船旋转"与"甲板随船旋转"是同一件事,想差一帧都做不到。
   * 只在 deck.revision 变化时调用(见 deckLinkG 的字段注释),故这里可以放心多跑几趟循环。
   */
  private drawDeckLinks(deck: Deck): void {
    const g = this.deckLinkG;
    g.clear();
    const cells = deck.cells;

    const pairs = supportLinks(deck, this.linkPairs);
    for (let k = 0; k + 1 < pairs.length; k += 2) {
      // 下标越界只是不画这一对,不炸掉整层(与敌人 kind 越界同一条兜底口径;
      // noUncheckedIndexedAccess 也逼着判)
      const sup = cells[pairs[k]!];
      const tower = cells[pairs[k + 1]!];
      if (!sup || !tower) continue;
      const def = SUPPORTS[sup.supportType];
      if (!def) continue;
      // 两个端点必须落在两个不同的暂存上,理由见 linkPos 的注释
      const a = cellLocalPos(deck, sup.col, sup.row, localPos);
      const b = cellLocalPos(deck, tower.col, tower.row, linkPos);
      // **逐对** stroke:同一座塔被两座弹药库夹着时,两条半透明的线叠出更亮的一段 ——
      // 那正是"buff 可叠加"在画面上的读数(攒成一条 path 就只剩一个 alpha,叠加当场看不见)
      g.moveTo(a.x, a.y)
        .lineTo(b.x, b.y)
        .stroke({ width: DECK_LINK_WIDTH, color: def.tint, alpha: DECK_LINK_ALPHA });
      // 塔端的小实心圆 = 箭头:线是无向的,没有它就读不出加成**从哪一格流向哪一格**。
      // 不透明度给满(与线相反):它是端点标记,不参与上面那条"叠加靠 alpha"的读数
      g.circle(b.x, b.y, DECK_LINK_DOT_R).fill(def.tint);
    }

    // 进化金光(17 号):配方满足时满级塔 → 被吞支援之间的金线,画在 buff 连线之上 ——
    // 它是"可以合成"的行动提示,必须比常驻的加成读数先被看见
    this.drawEvolutionLinks(deck);

    // 装甲舱那一路:它对任何塔都不匹配 ⇒ supportLinks 永远不会给出它的配对,上面这个循环
    // 天然一条线都画不到它头上(这正是"不作用于相邻塔就不该有连线"落在结构上、而不是靠一句特判)
    this.drawDeckArmor(deck);
  }

  /**
   * 进化金光提示(17 号 issue T1,渲染侧)—— 配方满足时,满级塔格心 → 被吞支援格心的一条金线。
   *
   * 配对表**一律问 sim 的 findEvolutionPairs**(满级 + 正交相邻 + 型号匹配三条判据全在那一份里,
   * 连同"进化塔在配方里不再是 base"的不可逆性),渲染层一行规则都不自己写 —— 与 supportLinks
   * 完全同一条口径,也正因为如此:支援换成别的型号、或塔已经被升走,金线**自己就消失**,
   * 不需要这里再补一个"不满足就擦"的分支(06 号验收那条"连线只画真实生效的配对"在此原样成立)。
   *
   * 画法照抄邻接连线:逐对 moveTo/lineTo + stroke(不攒 path —— 多条金线不该被平铺成一个 alpha),
   * 只是色相换成金色、再叠一层宽光晕:"金光"是提示,要比常驻的 buff 连线先被看见。
   * 端点小圆落在**塔端**(配对的第一个下标):线是无向的,没有它就分不出哪一格是进化的主角、
   * 哪一格是会被吞噬的燃料。
   *
   * 闸门 = world.refitPending(与 sim/world 的 evolveRefitTower 同一个开关):整备阶段外金线
   * 一行都不画 —— "配方满足"只是必要条件,"正在船坞里"才是时机(17 号口径:进化只发生在船坞)。
   * 渲染层不 import ui(依赖方向 ui → render),读世界状态正是它唯一的位置。
   */
  private drawEvolutionLinks(deck: Deck): void {
    if (!this.world.refitPending) return;
    const g = this.deckLinkG;
    const cells = deck.cells;
    const pairs = findEvolutionPairs(deck, this.evolvePairs);
    for (let k = 0; k + 1 < pairs.length; k += 2) {
      // 下标越界只是不画这一对,不炸掉整层(与 supportLinks 同一条兜底口径;
      // noUncheckedIndexedAccess 也逼着判)
      const tower = cells[pairs[k]!];
      const support = cells[pairs[k + 1]!];
      if (!tower || !support) continue;
      // 两个端点必须落在两个不同的暂存上,理由见 linkPos 的注释
      const a = cellLocalPos(deck, tower.col, tower.row, localPos);
      const b = cellLocalPos(deck, support.col, support.row, linkPos);
      // 光晕 + 芯线两次 stroke:一次是"这片金光存在",一次是"它连到哪一格"。
      // 芯线线宽压在邻接线上(DECK_LINK_WIDTH 0.055×格边)之上,提示不会被 buff 线盖没
      g.moveTo(a.x, a.y)
        .lineTo(b.x, b.y)
        .stroke({
          width: DECK_EVOLVE_GLOW_WIDTH,
          color: DECK_EVOLVE_COLOR,
          alpha: DECK_EVOLVE_GLOW_ALPHA,
        });
      g.moveTo(a.x, a.y)
        .lineTo(b.x, b.y)
        .stroke({
          width: DECK_EVOLVE_CORE_WIDTH,
          color: DECK_EVOLVE_COLOR,
          alpha: DECK_EVOLVE_CORE_ALPHA,
        });
      g.circle(a.x, a.y, DECK_LINK_DOT_R).fill(DECK_EVOLVE_COLOR);
    }
  }

  /**
   * 装甲舱的两条读数(设计取舍见文件上方 DECK_ARMOR_* 那段)。
   * 判据一律读**表字段**、绝不特判 SUP_ARMOR_BAY —— 与 sim/damage 的两个函数同源:
   *   盾   ← def.hullHp > 0        :hullMaxHp 逐格加的就是这个字段;
   *   舷线 ← def.edgeDamageMul < 1 且该边暴露:edgeDamageMul 逐格连乘的就是这个字段,
   *          而"哪几舷"两边都问 isEdgeExposed 这**同一个函数**。
   * 于是画面永远不会比数值表多承诺一分:把装甲舱的 edgeDamageMul 调回 1(= 不再减伤),
   * 舷线自己就消失了;哪天给别的设施也加上船体加成,它当场就有盾,不必回头改这里。
   * 内部格的装甲舱一条暴露边都没有 ⇒ 只剩一个盾,正好把"只加 HP、不护舷"画成了它本来的样子。
   *
   * 与连线共用 deckLinkG 与它那一次 clear(由 drawDeckLinks 负责):两者都只随 deck.revision 变,
   * 分成两层就多一个必须记得一起 clear 的对象。
   */
  private drawDeckArmor(deck: Deck): void {
    const g = this.deckLinkG;
    const size = deckCellSize();
    const half = size / 2;
    const sh = size * DECK_SHIELD_HALF_H;
    const sw = size * DECK_SHIELD_HALF_W;
    const cells = deck.cells;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      if (!c.occupied || c.content !== CELL_SUPPORT) continue;
      const def = SUPPORTS[c.supportType];
      if (!def) continue;
      const p = cellLocalPos(deck, c.col, c.row, localPos);

      // 一、它护的舷:逐格一次 stroke,边线几何照 drawDeckBase / drawDeckHit 那套四种端点写法,
      // 只是整条往格内缩 DECK_ARMOR_EDGE_INSET(理由见那个常量:别把船头亮边啃掉)——
      // 于是 12 号把甲板焊成非矩形之后,这道线依然沿着**真实的船体轮廓**走(与闪红同一批边)。
      // 相邻两块装甲舱之间那条边本就不暴露,故不会有两格把同一条线描两遍的事
      if (def.edgeDamageMul < 1) {
        const ai = half - DECK_ARMOR_EDGE_INSET;
        let drawn = 0;
        for (let e = 0; e < EDGE_COUNT; e++) {
          if (!isEdgeExposed(c, e)) continue;
          // 局部 +X = 船头、+Y = 右舷(全仓唯一口径,与 sim/deck 的边下标一致)。
          // 沿边那一轴仍取满格宽:角落格的两条带会在拐角交叉成一个 L,正是"两舷都护着"的样子
          switch (e) {
            case EDGE_BOW:
              g.moveTo(p.x + ai, p.y - half).lineTo(p.x + ai, p.y + half);
              break;
            case EDGE_STARBOARD:
              g.moveTo(p.x - half, p.y + ai).lineTo(p.x + half, p.y + ai);
              break;
            case EDGE_STERN:
              g.moveTo(p.x - ai, p.y - half).lineTo(p.x - ai, p.y + half);
              break;
            case EDGE_PORT:
              g.moveTo(p.x - half, p.y - ai).lineTo(p.x + half, p.y - ai);
              break;
            default:
              continue; // 认不出的边下标只是不画,不炸掉整层
          }
          drawn++;
        }
        if (drawn > 0) {
          g.stroke({
            width: DECK_ARMOR_EDGE_WIDTH,
            color: DECK_ARMOR_EDGE_COLOR,
            alpha: DECK_ARMOR_EDGE_ALPHA,
          });
        }
      }

      // 二、盾形图标:肩在船头侧、尖朝船尾(= 常见的下垂盾,船头朝上时读起来最顺手)。
      // 它只回答"这一格在给船体加 HP",不表示方向 —— 真正的方向读数是上面那几条舷线。
      // 加成的**具体点数**由调参面板的"HP 上限"只读项 + 11 号 DOM HUD 给:
      // 一格三十几 px 塞不下一个认得出的数字(与等级点不用数字同一条理由)
      if (def.hullHp > 0) {
        g.poly([
          p.x + sh,
          p.y - sw,
          p.x + sh,
          p.y + sw,
          p.x - sh * DECK_SHIELD_WAIST,
          p.y + sw,
          p.x - sh,
          p.y,
          p.x - sh * DECK_SHIELD_WAIST,
          p.y - sw,
        ])
          .fill({ color: FX_CORE_COLOR, alpha: DECK_SHIELD_FILL_ALPHA })
          .stroke({ width: DECK_SHIELD_WIDTH, color: FX_CORE_COLOR });
      }
    }
  }

  /**
   * 被撞舷闪红(09 号 issue T4 —— "被撞了"这件事在画面上唯一的落点)。
   *
   * 读的是 world.edgePenalty:**射速惩罚用的同一个计时器**,不是渲染层自持的第二个 ——
   * 于是"这一舷在闪红"与"这一舷的塔在变慢"永远是同一段时间窗,想差一帧都做不到
   * (broadside 顿挫那种表现计时才该留在渲染层:它不对应任何 sim 状态)。
   * 惩罚的"不可叠加延长"语义也一并白送:计时器不重置,闪红自然也不会被连续受击刷成常亮。
   *
   * 逐边一次 stroke,而不是四条边攒成一条 path:四舷各有各的剩余时间,合成一条就只剩一个 alpha,
   * "哪一舷刚挨的、哪一舷快好了"这条读数当场作废(与 drawFx 逐事件 stroke 同一条理由)。
   * 边线几何照 drawDeckBase 那套四种端点写法逐格描 —— 于是 12 号把甲板焊成非矩形之后,
   * 闪红依然沿着**真实的船体轮廓**走,不必在这里再补一条特例。
   */
  private drawDeckHit(deck: Deck): void {
    const g = this.deckHitG;
    const penalty = this.world.edgePenalty;
    // 先看四舷有没有事:整局绝大多数帧全是 0(见 hitDrawn 字段注释),归零后 clear 一次就够。
    // 判据问 hitPenaltyLeft —— "有没有一舷在挨罚"不该有第二份写法
    if (this.hitPenaltyLeft() <= 0) {
      if (this.hitDrawn) {
        g.clear();
        this.hitDrawn = false;
      }
      return;
    }
    g.clear();
    this.hitDrawn = true;

    const size = deckCellSize();
    const half = size / 2;
    const cells = deck.cells;
    for (let e = 0; e < EDGE_COUNT; e++) {
      const left = penalty[e]!;
      if (left <= 0) continue;
      let drawn = 0;
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i]!;
        if (!c.occupied || !isEdgeExposed(c, e)) continue;
        const p = cellLocalPos(deck, c.col, c.row, localPos);
        // 局部 +X = 船头、+Y = 右舷(全仓唯一口径,与 sim/deck 的边下标一致)
        switch (e) {
          case EDGE_BOW:
            g.moveTo(p.x + half, p.y - half).lineTo(p.x + half, p.y + half);
            break;
          case EDGE_STARBOARD:
            g.moveTo(p.x - half, p.y + half).lineTo(p.x + half, p.y + half);
            break;
          case EDGE_STERN:
            g.moveTo(p.x - half, p.y - half).lineTo(p.x - half, p.y + half);
            break;
          case EDGE_PORT:
            g.moveTo(p.x - half, p.y - half).lineTo(p.x + half, p.y - half);
            break;
          default:
            continue; // 认不出的边下标只是不画,不炸掉整层(与敌人 kind 越界同一条兜底口径)
        }
        drawn++;
      }
      // clamp01 兜住 hitPenaltyTime 被面板拖到 0 的情形(除出来的 Infinity/NaN 会画出 alpha 为 NaN 的线)
      if (drawn > 0) {
        g.stroke({
          width: HULL_HIT_WIDTH,
          color: HULL_HIT_COLOR,
          alpha: HULL_HIT_ALPHA * clamp01(left / tuning.hitPenaltyTime),
        });
      }
    }
  }

  /**
   * 放置高亮:合法格铺一层薄色 + 悬停格加粗描边 + 被拒格短促闪一下。
   * 合法性每帧现问 canPlace(只读不写),于是 ui 层不必缓存一份"哪些格能放"——
   * 一局里甲板会变(放塔、12 号扩建),缓存就是又一个会走散的真相。
   * 每帧重画局内几十个矩形的代价可忽略(相比之下底板走脏标记,是因为它一直在画面上却极少变)。
   */
  private drawDeckHilite(deck: Deck): void {
    const g = this.deckHiliteG;
    const st = this.placement;
    if (!st || !st.active) {
      // 关掉时清一次就够:每帧 clear 一个空 Graphics 不贵,但也没必要
      if (this.hiliteDrawn) {
        g.clear();
        this.hiliteDrawn = false;
      }
      return;
    }
    g.clear();
    this.hiliteDrawn = true;

    if (st.weldPieceType >= 0) {
      this.drawWeldHilite(deck, st);
      return;
    }

    if (st.moveSourceIndex >= 0) {
      this.drawMoveHilite(deck, st);
      return;
    }

    const size = deckCellSize();
    const half = size / 2;
    const box = size - DECK_HILITE_PAD * 2;
    const cells = deck.cells;

    let ok = 0;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      // 合法 = isPlaceSuccess:空格(PLACE_OK)与**同型可叠级的格**(PLACE_UPGRADE)都算能放,
      // 判定口径与 world.place 的答复完全一致 —— 高亮层要是只认 PLACE_OK,
      // 玩家就会看着一片"不能放"的甲板,却点下去成功升了一级
      if (!isPlaceSuccess(canPlace(deck, c.col, c.row, st.content, st.towerType, st.supportType)))
        continue;
      const p = cellLocalPos(deck, c.col, c.row, localPos);
      g.rect(p.x - half + DECK_HILITE_PAD, p.y - half + DECK_HILITE_PAD, box, box);
      ok++;
    }
    // 全部合法格攒成一条 path 一次填充:高亮是"哪里能放"的整体读数,不需要逐格不同的表现
    if (ok > 0) {
      g.fill({ color: DECK_HILITE_OK, alpha: DECK_HILITE_FILL_ALPHA }).stroke({
        width: DECK_HILITE_WIDTH,
        color: DECK_HILITE_OK,
      });
    }

    // 悬停格:加粗描边。非法时用拒绝色描边(而不是铺色块)—— 暖色只许出现在这一圈线上。
    // 下标来自 ui 层,可能因甲板换了(12 号)而过期,故必须判空(noUncheckedIndexedAccess 也逼着判)
    const hover = st.hoverIndex >= 0 ? cells[st.hoverIndex] : undefined;
    if (hover) {
      const legal = isPlaceSuccess(
        canPlace(deck, hover.col, hover.row, st.content, st.towerType, st.supportType),
      );
      const p = cellLocalPos(deck, hover.col, hover.row, localPos);
      g.rect(p.x - half + DECK_HILITE_PAD, p.y - half + DECK_HILITE_PAD, box, box).stroke({
        width: DECK_HOVER_WIDTH,
        color: legal ? DECK_HILITE_OK : DECK_HILITE_DENY,
      });
    }

    // 被拒格:短促闪一下(闪多久由 ui 层的超时清零决定,渲染层不持有计时器)。
    // 真正说明理由的是 DOM 文案,这里只负责把玩家的视线钉回"是这一格不行"
    const deny = st.denyIndex >= 0 ? cells[st.denyIndex] : undefined;
    if (deny) {
      const p = cellLocalPos(deck, deny.col, deny.row, localPos);
      g.rect(p.x - half + DECK_HILITE_PAD, p.y - half + DECK_HILITE_PAD, box, box)
        .fill({ color: DECK_HILITE_DENY, alpha: DECK_DENY_FILL_ALPHA })
        .stroke({ width: DECK_HILITE_WIDTH, color: DECK_HILITE_DENY });
    }
  }

  /** 整备搬运高亮：来源用琥珀，所有可落点继续用“合法操作”的冷青。 */
  private drawMoveHilite(deck: Deck, st: PlacementUiState): void {
    const g = this.deckHiliteG;
    const cells = deck.cells;
    const source = cells[st.moveSourceIndex];
    if (!source) return;

    const size = deckCellSize();
    const half = size / 2;
    const box = size - DECK_HILITE_PAD * 2;
    let targets = 0;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      if (canMoveModule(deck, source.col, source.row, c.col, c.row) !== MOVE_OK) continue;
      const p = cellLocalPos(deck, c.col, c.row, localPos);
      g.rect(p.x - half + DECK_HILITE_PAD, p.y - half + DECK_HILITE_PAD, box, box);
      targets++;
    }
    if (targets > 0) {
      g.fill({ color: DECK_HILITE_OK, alpha: DECK_HILITE_FILL_ALPHA }).stroke({
        width: DECK_HILITE_WIDTH,
        color: DECK_HILITE_OK,
      });
    }

    const sourcePos = cellLocalPos(deck, source.col, source.row, localPos);
    g.rect(
      sourcePos.x - half + DECK_HILITE_PAD,
      sourcePos.y - half + DECK_HILITE_PAD,
      box,
      box,
    )
      .fill({ color: DECK_HILITE_SOURCE, alpha: DECK_HILITE_FILL_ALPHA })
      .stroke({ width: DECK_HOVER_WIDTH, color: DECK_HILITE_SOURCE });

    const hover = st.hoverIndex >= 0 ? cells[st.hoverIndex] : undefined;
    if (hover && hover !== source) {
      const legal =
        canMoveModule(deck, source.col, source.row, hover.col, hover.row) === MOVE_OK;
      const p = cellLocalPos(deck, hover.col, hover.row, localPos);
      g.rect(p.x - half + DECK_HILITE_PAD, p.y - half + DECK_HILITE_PAD, box, box).stroke({
        width: DECK_HOVER_WIDTH,
        color: legal ? DECK_HILITE_OK : DECK_HILITE_DENY,
      });
    }

    const deny = st.denyIndex >= 0 ? cells[st.denyIndex] : undefined;
    if (deny) {
      const p = cellLocalPos(deck, deny.col, deny.row, localPos);
      g.rect(p.x - half + DECK_HILITE_PAD, p.y - half + DECK_HILITE_PAD, box, box)
        .fill({ color: DECK_HILITE_DENY, alpha: DECK_DENY_FILL_ALPHA })
        .stroke({ width: DECK_HILITE_WIDTH, color: DECK_HILITE_DENY });
    }
  }

  /** 拼块焊接高亮:所有合法锚点给冷色标记，鼠标下整块 ghost 按 sim 判据显示绿/红。 */
  private drawWeldHilite(deck: Deck, st: PlacementUiState): void {
    const g = this.deckHiliteG;
    const def = DECK_PIECES[st.weldPieceType];
    if (!def) return;
    const size = deckCellSize();
    const half = size / 2;
    const pad = def.cells.length / 2;

    let anchors = 0;
    for (let row = deck.minRow - pad; row < deck.minRow + deck.rows + pad; row++) {
      for (let col = deck.minCol - pad; col < deck.minCol + deck.cols + pad; col++) {
        if (canWeldPiece(deck, st.weldPieceType, st.weldRotation, col, row) !== WELD_OK) continue;
        const p = cellLocalPos(deck, col, row, localPos);
        // 下限只兜零/负,不再写死 2px:焊接只发生在甲板视图里,锚点随格边长等比即可
        g.circle(p.x, p.y, Math.max(0.5, size * 0.08));
        anchors++;
      }
    }
    if (anchors > 0) g.fill({ color: DECK_HILITE_OK, alpha: 0.75 });

    const code = canWeldPiece(
      deck,
      st.weldPieceType,
      st.weldRotation,
      st.hoverCol,
      st.hoverRow,
    );
    const legal = code === WELD_OK && !st.weldDenied;
    const color = legal ? DECK_HILITE_OK : DECK_HILITE_DENY;
    const count = def.cells.length / 2;
    for (let i = 0; i < count; i++) {
      if (
        !deckPieceCellAt(
          st.weldPieceType,
          st.weldRotation,
          st.hoverCol,
          st.hoverRow,
          i,
          weldCoord,
        )
      )
        continue;
      const p = cellLocalPos(deck, weldCoord.col, weldCoord.row, localPos);
      g.rect(
        p.x - half + DECK_HILITE_PAD,
        p.y - half + DECK_HILITE_PAD,
        size - DECK_HILITE_PAD * 2,
        size - DECK_HILITE_PAD * 2,
      )
        .fill({ color, alpha: legal ? DECK_HILITE_FILL_ALPHA : DECK_DENY_FILL_ALPHA })
        .stroke({ width: DECK_HOVER_WIDTH, color });
    }
  }

  /**
   * 射界叠加层(按住 Tab,GDD §4.2)。04 号的两条验收标准都由"画在船体局部空间 + 几何全问 sim"落实:
   *   一、"可视化与实际可命中区域一致":扇形的中心角/半角一律取自 sim 的 cellArc(heading 传 0
   *     就得到局部中心角),弧度与半径**逐塔**取 towerArcDeg / towerRange —— 这三个数正是 sim
   *     索敌判定用的那三个,不是渲染层照着规则重推的第二份;
   *   二、"船旋转时射界实时跟随、无一帧延迟":整层挂在 deckG 下,吃的是与底板同一个插值位姿,
   *     于是"扇形跟着船转"与"甲板跟着船转"在结构上就是同一件事,想差一帧都做不到。
   *
   * 05 号起**每帧重画扇形**,原先的 arcRevision/arcDeg/arcRange 三个缓存键随之删掉:
   * 弧度与射程不再是全塔共用的两个 tuning 数,而是"逐塔的 def × 该塔当前等级"——
   * 缓存键要跟上就得把 12 座塔的 (towerType, level) 全编进去,那已经比重画本身贵了;
   * 而重画的代价只是 12 个扇形,与每帧现算的放置高亮层同量级(它一直就是这么干的)。
   */
  private drawDeckArcs(deck: Deck, detailed: boolean): void {
    // 炮口朝向是战斗态唯一常驻的塔细节：每帧都要跟 sim 的 turretOffset 同步。
    this.drawArcMuzzles(deck);
    if (!detailed) {
      // 退出 Tab/放置时只清详细底衬；炮口层刚在上面重画，不能一起清掉。
      if (this.arcDrawn) {
        this.deckArcG.clear();
        this.arcDrawn = false;
      }
      return;
    }
    this.arcDrawn = true;
    this.drawArcFans(deck);
    // 判定体轮廓与射界扇形同开同关(09 号 T4 验收点名):它必须排在 drawArcMuzzles 之后,
    // 因为两者共用 deckMuzzleG,而那个方法开头就 clear 一次(见下面 drawHullCore 的说明)
    this.drawHullCore();
  }

  /**
   * 扇形本体。全部塔攒成一条 path 只 fill + stroke 一次(照底板/高亮层的写法):
   * 扇形是"我打得到哪里"的整体读数,不需要逐塔不同的表现 —— 逐塔不同的是**几何**(弧度/射程),
   * 那已经由 towerArcDeg / towerRange 逐塔算进去了。
   * 只画在线的武器塔 —— isTurretCell 已经把 online 判进去(离线塔不开火,画出扇形就是骗玩家),
   * cellArc 再兜一层"没有暴露边就返回 false";数值表里查不到的 towerType 一并跳过
   * (noUncheckedIndexedAccess 也逼着判:非武器格的 towerType 恒 -1)。
   */
  private drawArcFans(deck: Deck): void {
    const g = this.deckArcG;
    g.clear();
    const cells = deck.cells;
    let drawn = 0;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      if (!isTurretCell(c)) continue;
      const def = TOWERS[c.towerType];
      if (!def || !cellArc(c, 0, towerArcDeg(def, c.level), arcTmp)) continue;
      const p = cellLocalPos(deck, c.col, c.row, localPos);
      // 圆心 = 格心(sim 索敌也是从格心量距离),moveTo → arc → closePath 合成一块扇形
      g.moveTo(p.x, p.y)
        .arc(
          p.x,
          p.y,
          towerRange(def, c.level),
          arcTmp.center - arcTmp.half,
          arcTmp.center + arcTmp.half,
        )
        .closePath();
      drawn++;
    }
    if (drawn > 0) {
      g.fill({ color: DECK_ARC_COLOR, alpha: DECK_ARC_FILL_ALPHA }).stroke({
        width: DECK_ARC_WIDTH,
        color: DECK_ARC_COLOR,
        alpha: DECK_ARC_STROKE_ALPHA,
      });
    }
  }

  /**
   * 炮口线:起点格心、长一格,方向 = 局部射界中心 + cell.turretOffset ——
   * sim 存的是**相对射界中心**的偏角(见 deck.ts 的字段注释),所以这里加一下就是局部朝向,
   * 不必再去追船体 heading(那是 deckG 的 rotation 已经替我们做完的事)。
   * 有它,"射界内无目标 → 炮管归位"才在画面上看得见:没有它,叠加层只能证明扇形画对了,
   * 证不出塔真的在转、真的会回中(而这正是 04 号里唯一需要肉眼抽查的一条)。
   * 05 号起弧度逐塔取:cellArc 的中心角其实与 arcDeg 无关(只有半角受它影响),
   * 但仍照实传该塔自己的档位 —— 两处口径分家的那一天,分歧不该从这里冒出来。
   */
  private drawArcMuzzles(deck: Deck): void {
    const g = this.deckMuzzleG;
    g.clear();
    const len = deckCellSize() * DECK_MUZZLE_LEN;
    const cells = deck.cells;
    let drawn = 0;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      if (!isTurretCell(c)) continue;
      const def = TOWERS[c.towerType];
      if (!def || !cellArc(c, 0, towerArcDeg(def, c.level), arcTmp)) continue;
      const p = cellLocalPos(deck, c.col, c.row, localPos);
      // 不必 wrapAngle:cos/sin 对超出 ±π 的角一样正确,折回只是白算两次三角函数
      const a = arcTmp.center + c.turretOffset;
      g.moveTo(p.x, p.y).lineTo(p.x + Math.cos(a) * len, p.y + Math.sin(a) * len);
      drawn++;
    }
    if (drawn > 0) g.stroke({ width: DECK_MUZZLE_WIDTH, color: DECK_MUZZLE_COLOR });
  }

  /**
   * 受击判定体轮廓(09 号 issue T4,按住 Tab 与射界扇形同开同关)。
   *
   * 半长/半宽一律问 sim 的 hullCoreHalfExtents,渲染层一行判定几何都不许自己推 ——
   * 与射界叠加层那条"可视化与实际可命中区域一致"是同一条口径:重算一份就是两个迟早走散的真相,
   * 而这一个走散了,玩家学到的"我这么大"就是假的。
   * 它**恒等于初始 3×4 甲板的核心区**(GDD §4.4:判定小于外形,且不随扩建变大):
   * 12 号焊出再大的甲板,这个矩形一格也不涨 —— 调试模式下"外形变大了、挨打的地方没变"必须一眼可见,
   * 否则这条设计只存在于 sim 的注释里,谁也验不了。
   *
   * 画进 deckMuzzleG 而不是 deckArcG:后者是压在底板**之下**的底衬(见构造函数的层序),
   * 核心区整个落在甲板范围内,画在那儿会被格子填充一块不剩地盖掉。
   * 与炮口线共用一层；战斗态炮口线仍常驻，只有这条核心轮廓随 detailed 开关增删。
   */
  private drawHullCore(): void {
    const h = hullCoreHalfExtents(coreTmp);
    // 局部 +X = 半长(船头方向)、+Y = 半宽(右舷方向),与甲板格心同一套局部坐标;
    // 甲板对称于船心,故矩形直接以原点为中心铺开
    this.deckMuzzleG.rect(-h.x, -h.y, h.x * 2, h.y * 2).stroke({
      width: HULL_CORE_WIDTH,
      color: HULL_HIT_COLOR,
      alpha: HULL_CORE_ALPHA,
    });
  }

  /**
   * 甲板节流读数(05 号 issue T5 验收:"三种节流机制在 UI 上可读 —— 弹夹数 / 热量条 / 充能环")。
   *
   * 每帧 clear 后重画,**不做脏标记**:弹夹/热量/充能每一逻辑帧都在变,压根没有可缓存的余地
   * (与每帧现算的放置高亮层同一条取舍;走 revision 脏标记的是一局里只变几次的底板)。
   * 十几座塔各三四条几何指令,与高亮层同量级 —— 500 弹那条性能口径在别处(粒子容器),不在这里。
   *
   * 只画**在线**的武器塔(isTurretCell 已把 online 判进去):离线塔一切冻结、连节流都不推进
   * (与 sim/turret 同口径),给它画一条永远不动的弹夹条只会让人以为塔卡住了 ——
   * 底板那边它已经灰显了,"它是死的"这条信息不该再被一层活读数盖过去。
   * 数值表里查不到的 towerType 一并跳过(非武器格恒 -1,noUncheckedIndexedAccess 也逼着判)。
   *
   * 三种机制各自的形状与位置见文件上方 THR_* 那段;等级点三种塔共用同一处(船头侧格边),
   * 于是"这塔几级"永远在同一个地方读,不必先认出它挂的是哪一套节流。
   */
  private drawDeckThrottle(deck: Deck, detailed: boolean): void {
    const g = this.deckThrottleG;
    if (!detailed) {
      if (this.throttleDrawn) {
        g.clear();
        this.throttleDrawn = false;
      }
      return;
    }
    g.clear();
    this.throttleDrawn = true;
    const size = deckCellSize();
    const half = size / 2;
    const len = size - THR_PAD * 2; // 条长 / 等级点可用的净宽
    const cells = deck.cells;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      if (!isTurretCell(c)) continue;
      const def = TOWERS[c.towerType];
      if (!def) continue;
      const p = cellLocalPos(deck, c.col, c.row, localPos);
      const color = def.tint;
      switch (def.throttle) {
        case THR_AMMO: {
          // 弹夹条:贴船尾侧格边,沿 +Y(右舷)增长。装填期间 sim 侧的 ammo 恒 0(见 sim/tower 的
          // 状态机:打空即进装填,装填完毕才一次性填满),故"空槽 + 一条推进中的冷白进度"
          // 正好读成"正在把弹夹填回去",两条读数各占一半时间、绝不同时出现
          const x = p.x - half + THR_PAD;
          const y0 = p.y - len / 2;
          g.rect(x, y0, THR_BAR_THICK, len).fill({
            color: THR_TRACK_COLOR,
            alpha: THR_TRACK_ALPHA,
          });
          const cap = towerMagazine(def, c.level);
          const ammo = cap > 0 ? clamp01(c.ammo / cap) : 0;
          if (ammo > 0) g.rect(x, y0, THR_BAR_THICK, len * ammo).fill(color);
          // 分母走 sim/tower 的 cellReload(而不是裸 def.reload):06 号的弹药库把装填时间乘短了,
          // 拿基准值当分母,进度条会在真装完之前就走满,然后停在顶上等 —— 读数与实际节奏当场对不上。
          // "读数与 sim 用的必须是同一个数"是 05 号那三套读数的立身之本
          const reload = cellReload(c, def);
          if (c.reloadLeft > 0 && reload > 0) {
            const t = clamp01(1 - c.reloadLeft / reload);
            if (t > 0) {
              g.rect(x, y0, THR_BAR_THICK, len * t).fill({
                color: FX_CORE_COLOR,
                alpha: THR_RELOAD_ALPHA,
              });
            }
          }
          break;
        }
        case THR_HEAT: {
          // 热量条:贴左舷侧格边,沿 +X(船头)增长 —— 与弹夹条**正交**,两者绝不会被读成同一种东西
          const y = p.y - half + THR_PAD;
          const x0 = p.x - len / 2;
          g.rect(x0, y, len, THR_BAR_THICK).fill({
            color: THR_TRACK_COLOR,
            alpha: THR_TRACK_ALPHA,
          });
          // 上限走 sim/tower 的 cellHeatMax(而不是裸 towerHeatMax):06 号的散热器把上限抬高之后,
          // 拿基准值当分母的热量条会在塔还远没锁死时就画满 —— 而"收支平衡点"正是过热系的全部手感,
          // 读数与 sim 用的必须是同一个数(理由同上面那条 cellReload)
          const max = cellHeatMax(c, def);
          const t = max > 0 ? clamp01(c.heat / max) : 0;
          // 过热锁死:整条满长闪暖红。暖色是敌人的色域(GDD §12),故只许**这么小一条、这么短一阵**,
          // 而且必须是"闪"不是常亮 —— 常亮的暖条等于在自家甲板上钉死一块假的敌方色。
          // 闪灭的那半个周期照常画真实热量,于是"锁死中"与"还在降温"两条信息都读得到
          if (c.coolLock > 0 && Math.floor(c.coolLock * THR_OVERHEAT_BLINK_HZ) % 2 === 0) {
            g.rect(x0, y, len, THR_BAR_THICK).fill(DECK_HILITE_DENY);
          } else if (t > 0) {
            g.rect(x0, y, len * t, THR_BAR_THICK).fill(color);
          }
          break;
        }
        case THR_CHARGE: {
          // 充能环:三种读数里唯一的圆。从**船头方向**(局部角 0)起手扫,起点是个固定的锚,
          // 于是"扫过了多少"一眼估得出来,不必先去猜这一圈是从哪儿开始的
          const r = size * THR_RING_RADIUS;
          g.circle(p.x, p.y, r).stroke({
            width: THR_RING_WIDTH,
            color: THR_TRACK_COLOR,
            alpha: THR_RING_TRACK_ALPHA,
          });
          const t = clamp01(c.charge);
          if (t > 0) {
            // 必须先 moveTo 到弧的起点:Pixi 的 arc 会从"当前点"连一条线过来,
            // 而上一句 stroke 之后当前点还停在槽底圆的收尾处 —— 少这一句就会多出一条从环上甩出去的线
            g.moveTo(p.x + r, p.y)
              .arc(p.x, p.y, r, 0, t * Math.PI * 2)
              .stroke({ width: THR_RING_WIDTH, color });
          }
          if (t >= 1) {
            // 满充:再描一圈冷白芯。"攒满了在等目标"与"还在攒"是两种状态(见 sim/tower:
            // 无目标也照常蓄、满 1.0 就停在那里等),读数分不开的话充能塔看上去永远在原地转圈
            g.circle(p.x, p.y, r).stroke({ width: THR_RING_FULL_WIDTH, color: FX_CORE_COLOR });
          }
          break;
        }
        default:
          break; // 认不出的节流档只是不画读数,不炸掉整层(与敌人 kind 越界同一条兜底口径)
      }

      // 等级点(GDD §5.4 的 Lv1→Lv5):三种机制共用同一处 —— 船头侧格边,沿 +Y 居中排开。
      // 用点数而不是数字:一格才三十几 px,能塞进去的字号已经小到认不出是几,而五个点数得清。
      // 上限夹在 TOWER_MAX_LEVEL:数据表被改坏(或将来放宽等级上限)也不该排出格外
      const lv = Math.min(Math.max(Math.floor(c.level), 0), TOWER_MAX_LEVEL);
      if (lv > 0) {
        const x = p.x + half - THR_PAD;
        const y0 = p.y - ((lv - 1) * THR_LEVEL_DOT_GAP) / 2;
        for (let k = 0; k < lv; k++) g.circle(x, y0 + k * THR_LEVEL_DOT_GAP, THR_LEVEL_DOT_R);
        // 攒成一条 path 一次填充:等级点是一组读数,不需要逐点不同的表现
        g.fill(FX_CORE_COLOR);
      }
    }
  }

  /**
   * 开火光效(05 号 issue T5):照 world.fx.items 逐个事件画,按 life 淡出。
   *
   * **不做插值**:FxEvent 的坐标是"开火那一逻辑帧"的世界坐标,给它插值就得再存一份 prev、
   * 还要回答"命中点在敌人身上、敌人却已经动了"这种没有正确答案的问题;而它总共只活 3~15 帧,
   * 最多差一逻辑帧(16.7ms)—— 那点滞后肉眼分辨不出,一份多余的状态却要一直维护下去。
   *
   * 逐事件 stroke/fill 而不是攒成一条 path:alpha 是逐事件的(每个事件的 life 各不相同),
   * 攒在一起就只能共用一个 alpha,淡出这条通道当场作废。同屏事件数被"射速 × 存续"钉死在
   * 与塔数同量级(十几到几十个),与 500 弹那条口径不在一个数量级上,故不设配额上限
   * (前摇指示器要设,是因为它的上限是"敌人数",那是上千)。
   */
  /**
   * 开火音家族映射:音频随 FXV 类型而不是塔型走 —— 同一种事件永远同一种音色
   * (对照 sim/fx.ts 的五种开火事件;受击/击杀那几种返回 null = 不出声)。
   * 弹药系塔(FXV_MUZZLE)哒哒、激光(FXV_BEAM)短鸣、电弧(FXV_CHAIN)是过热系"嘶"、
   * 磁轨/迫击炮(FXV_LANCE/BLAST)都是充能系爆发 —— 与 audio.ts 的四家族一一对应。
   */
  private shootFamily(kind: number): 'ammo' | 'heat' | 'charge' | 'beam' | null {
    switch (kind) {
      case FXV_MUZZLE:
        return 'ammo';
      case FXV_BEAM:
        return 'beam';
      case FXV_CHAIN:
        return 'heat';
      case FXV_LANCE:
        return 'charge';
      case FXV_BLAST:
        return 'charge';
      default:
        return null;
    }
  }

  /**
   * 该塔当前节流压力(0..1),喂给 playShoot 的 throttle —— 热量越高"嘶"声越亮越绵长。
   * FxEvent 不背这个数(见 sim/fx.ts 的字段表),只能顺着 towerType 在甲板上反查;
   * 甲板最多十几格,逐事件扫一遍的开销可忽略。查不到(塔已拆/表被改坏)退回 1:
   * 音频宁可恒常也不哑火。
   */
  private shootThrottle(towerType: number, def: TowerDef): number {
    const cells = this.world.deck.cells;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      if (c.towerType !== towerType) continue;
      switch (def.throttle) {
        case THR_HEAT: {
          const max = cellHeatMax(c, def);
          return max > 0 ? clamp01(c.heat / max) : 1;
        }
        case THR_CHARGE:
          return clamp01(c.charge);
        default:
          return 1;
      }
    }
    return 1;
  }

  private drawFx(): void {
    const g = this.fxG;
    g.clear();
    const muzzleG = this.muzzleFxG;
    muzzleG.clear();
    // 放置时停会冻结 FxEvent 寿命;甲板视图里也不该有一枚寿命冻结的闪光常亮在炮口上。
    // 恢复时 target 先回 1、镜头缩放还在缓动:阈值取 1.05 而不是贴死 1 ——
    // 指数缓动的尾巴(1.05 → 1.002)还要拖 ~0.25s,而 1.05 档的缩放差在闪光半径(7 世界 px)
    // 面前只有约 2px,肉眼分不出;贴死 1 的话松开 Tab 后塔照常开火、闪光却整段哑火。
    const showMuzzle = this.deckZoomTarget <= 1 && this.deckZoom <= 1.05;
    const items = this.world.fx.items;
    for (let i = 0; i < items.length; i++) {
      const e = items[i]!;
      // 色相 = 哪座塔打的(与它的子弹同色,一眼认得出是哪门炮);查不到就退回冷色兜底,
      // 绝不让暖色漏进我方光效(GDD §12 的敌我色域分离不可破)
      const def = TOWERS[e.towerType];
      // 开火音:开火事件是"这一帧发生了什么"的表现层读数,音频照同一批事件发声 ——
      // 节流值从甲板反查(事件不带 throttle),音频引擎自带同族限流,蜂群贴脸不糊成一片
      const playAudio = !e.audioPlayed;
      if (playAudio) e.audioPlayed = true;
      const family = this.shootFamily(e.kind);
      if (playAudio && family) audioBus.playShoot(family, def ? this.shootThrottle(e.towerType, def) : 1);
      const color = def ? def.tint : FX_TINT_FALLBACK;
      switch (e.kind) {
        case FXV_BEAM: {
          // 细实线 + **常亮**:激光是 10Hz 的伤害 tick + 每帧续命的可视化(见 05 设计约定),
          // 按 life 线性淡出会把"持续光束"画成一闪一闪的虚线 —— 那正好毁掉它与另外三类的区别
          const t = fxFade(e.life, FX_LIFE_BEAM);
          g.moveTo(e.x0, e.y0)
            .lineTo(e.x1, e.y1)
            .stroke({ width: FX_BEAM_GLOW_WIDTH, color, alpha: FX_BEAM_GLOW_ALPHA * t });
          g.moveTo(e.x0, e.y0)
            .lineTo(e.x1, e.y1)
            .stroke({
              width: FX_BEAM_CORE_WIDTH,
              color: FX_CORE_COLOR,
              alpha: FX_BEAM_CORE_ALPHA_FLOOR + (1 - FX_BEAM_CORE_ALPHA_FLOOR) * t,
            });
          break;
        }
        case FXV_CHAIN: {
          // 一跳一个事件,首尾相接自然连成整条链;折角是它与光束唯一的形状差别,故必须画
          const t = fxFade(e.life, FX_LIFE_CHAIN);
          this.strokeChainHop(e.x0, e.y0, e.x1, e.y1, color, FX_CHAIN_ALPHA * t);
          break;
        }
        case FXV_LANCE: {
          // 唯一"越来越细"的一类:光柱随 life 从 FX_LANCE_WIDTH 收成一条芯线,
          // 读起来就是"贯穿的那一瞬间已经过去,现在只剩余波"
          const t = fxFade(e.life, FX_LIFE_LANCE);
          g.moveTo(e.x0, e.y0)
            .lineTo(e.x1, e.y1)
            .stroke({
              // 下限夹在芯线宽度上:光晕收得比芯线还细就不再是光晕了,让它平滑地退化成芯线本身
              width: Math.max(FX_LANCE_CORE_WIDTH, FX_LANCE_WIDTH * t),
              color,
              alpha: FX_LANCE_ALPHA * t,
            });
          g.moveTo(e.x0, e.y0)
            .lineTo(e.x1, e.y1)
            .stroke({ width: FX_LANCE_CORE_WIDTH, color: FX_CORE_COLOR, alpha: t });
          break;
        }
        case FXV_BLAST: {
          // 唯一的圆。实心盘一直摊在**真实 aoeRadius** 上交代"炸到多大一片",
          // 扩张环负责"炸了"这件事本身 —— 环收尾那一帧正好压在盘的边界上,
          // 于是这一层同样守得住射界叠加层那条"可视化 = 实际作用范围"的口径。
          const t = fxFade(e.life, FX_LIFE_BLAST);
          const r = e.radius * (FX_BLAST_START + (1 - FX_BLAST_START) * (1 - t));
          g.circle(e.x0, e.y0, e.radius).fill({ color, alpha: FX_BLAST_FILL_ALPHA * t });
          g.circle(e.x0, e.y0, r).stroke({
            width: FX_BLAST_RING_WIDTH,
            color: FX_CORE_COLOR,
            alpha: t,
          });
          break;
        }
        case FXV_SPARK: {
          // "蹭到甲板轮廓、但没进核心区" —— **一分血都没掉**(sim 侧压根没走结算,见 09 号设计约定)。
          // 冷白 + 星芒 + 随 life 收缩,三条通道与下面那支暖红扩散环处处相反:
          // 玩家要靠这个差别学会自己的判定体到底多大,分不开就等于没给反馈。
          // 色相**不取 def.tint**:它不是任何一座塔打出来的(sim 侧填进去的 towerType 没有意义),
          // 顺着 def 取色只会在数值表一改就跟着乱跳
          const t = fxFade(e.life, FX_LIFE_SPARK);
          const len = FX_SPARK_LEN * t;
          // 四条射线一律**从命中点向外**画,而不是各画一条过中心的对称线段 ——
          // 后者的四个方向两两相反,等于把同一个 × 描两遍(半透明时还会叠出一根深浅不匀的芯)
          for (let k = 0; k < FX_SPARK_DIRS.length; k += 2) {
            const dx = FX_SPARK_DIRS[k]! * len;
            const dy = FX_SPARK_DIRS[k + 1]! * len;
            g.moveTo(e.x0, e.y0).lineTo(e.x0 + dx, e.y0 + dy);
          }
          // 四条射线共用一次 stroke:同一个事件同一个 alpha,拆开画只是白跑三趟
          g.stroke({ width: FX_SPARK_WIDTH, color: FX_SPARK_COLOR, alpha: t });
          if (playAudio) audioBus.playHurt('spark');
          break;
        }
        case FXV_HULL_HIT: {
          // 真伤害:暖红圆环随 life 扩散淡出。暖色出现在自家船上是 GDD §4.6 明令的例外
          // (与被撞舷闪红同一条豁免,见 HULL_HIT_COLOR),不是 §12 敌我色域分离被破了。
          // 与 FXV_BLAST 的扩张环形状同族、色域相反:那是我方炸到敌人,这是敌人啃到我方
          const t = fxFade(e.life, FX_LIFE_HULL_HIT);
          const r = FX_HULL_HIT_R0 + (FX_HULL_HIT_R1 - FX_HULL_HIT_R0) * (1 - t);
          g.circle(e.x0, e.y0, r).stroke({
            width: FX_HULL_HIT_WIDTH,
            color: HULL_HIT_COLOR,
            alpha: t,
          });
          if (playAudio) audioBus.playHurt('hull');
          break;
        }
        case FXV_IMPACT: {
          const t = fxFade(e.life, FX_LIFE_IMPACT);
          const len = FX_IMPACT_LEN * t;
          g.moveTo(e.x0 - len, e.y0).lineTo(e.x0 + len, e.y0);
          g.moveTo(e.x0, e.y0 - len).lineTo(e.x0, e.y0 + len);
          g.stroke({ width: FX_IMPACT_WIDTH, color: FX_IMPACT_COLOR, alpha: t });
          if (playAudio) audioBus.playHurt('spark');
          break;
        }
        case FXV_KILL: {
          // 击杀爆点:towerType 一格借放的是**敌型下标**(见 sim/fx.ts),配色走 enemyTint ——
          // 上面按塔型取的 color 对这一种 kind 不适用,当场覆盖。radius = 敌半径(sim 填的),
          // 环从本体半径向外扩、射线向外缩,全部随 life 淡出:短促的一记"这只没了"的句号
          if (playAudio) audioBus.playKill();
          const t = fxFade(e.life, FX_LIFE_KILL);
          const tint = enemyTint(e.towerType);
          const r = e.radius * (1 + (FX_KILL_EXPAND - 1) * (1 - t));
          g.circle(e.x0, e.y0, r).stroke({ width: FX_KILL_RING_WIDTH, color: tint, alpha: t * 0.9 });
          const len = e.radius * FX_KILL_RAY * t;
          for (let k = 0; k < FX_KILL_DIRS.length; k += 2) {
            const sx = e.x0 + FX_KILL_DIRS[k]! * r;
            const sy = e.y0 + FX_KILL_DIRS[k + 1]! * r;
            g.moveTo(sx, sy).lineTo(sx + FX_KILL_DIRS[k]! * len, sy + FX_KILL_DIRS[k + 1]! * len);
          }
          g.stroke({ width: FX_KILL_RAY_WIDTH, color: tint, alpha: t * 0.7 });
          break;
        }
        case FXV_MUZZLE: {
          if (!showMuzzle) break;
          // 炮口火光画进甲板上方的专层；同源塔色只做外圈，冷白描边 + 芯点提供独立亮度通道，
          // 否则同色实心圆落在同色塔块上仍等于没画。life 复用最短的 FX_LIFE_BEAM。
          const t = fxFade(e.life, FX_LIFE_BEAM);
          const radius = FX_MUZZLE_RADIUS * (0.65 + 0.35 * t);
          muzzleG
            .circle(e.x0, e.y0, radius)
            .fill({ color, alpha: FX_MUZZLE_ALPHA * t })
            .stroke({ width: FX_MUZZLE_RING_WIDTH, color: FX_CORE_COLOR, alpha: t })
            .circle(e.x0, e.y0, FX_MUZZLE_CORE_RADIUS)
            .fill({ color: FX_CORE_COLOR, alpha: t });
          break;
        }
        default:
          break; // 认不出的 kind 只是不画,不炸掉整局(与敌人 kind 越界同一条兜底口径)
      }
    }
  }

  /**
   * 画一跳链电:起点 → 三个折点 → 终点。折点位置与横向偏移是**定死的常量**,不掷随机 ——
   * 逐帧重掷会让同一跳在存续的那几帧里抖成一团噪点,而它要传达的是"这一发打到了这几只";
   * 而且渲染层掷随机就等于在 sim 之外又开了一条随机源,调试时永远复现不出同一张画面。
   * 折角幅度按跳长缩放:短跳被固定幅度折一下就成了一团麻。
   */
  private strokeChainHop(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: number,
    alpha: number,
  ): void {
    const g = this.fxG;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len <= 0) return; // 零长跳(同点)没有法线可言,画了也只是一个点
    // 单位法线:把折点推离连线用
    const nx = -dy / len;
    const ny = dx / len;
    const amp = len * FX_CHAIN_KINK;
    g.moveTo(x0, y0);
    for (let k = 0; k < FX_CHAIN_KINK_AT.length; k++) {
      const s = FX_CHAIN_KINK_AT[k]!;
      const o = FX_CHAIN_KINK_OFF[k]! * amp;
      g.lineTo(x0 + dx * s + nx * o, y0 + dy * s + ny * o);
    }
    g.lineTo(x1, y1).stroke({ width: FX_CHAIN_WIDTH, color, alpha });
  }

  /**
   * broadside 反馈(05 号 T5 可选项):单舷 ≥3 塔同帧开火 → 镜头朝该舷的**反**方向短促一顿,
   * 外加一层冷色闪光。返回本帧的顿挫位移(屏幕 px,已含方向的标量部分),由 sync 加到镜头位置上。
   *
   * 计时与相位全在渲染层自持:它纯是表现,进了 sim 就等于让确定性回放为一次镜头抖动负责。
   * 触发按 world.tick 去重(见 broadsideTick 字段注释)。
   * 方向取"开火那一舷"的世界法线(edgeWorldNormal —— sim 判定用的同一份口径,
   * 渲染层不自己推第二份),取负号 = 后坐:炮口朝右舷,镜头就朝左顿一下。
   * 相位按**已走过的比例**推进而不是按秒:于是无论 30fps 还是 144fps,这一顿都刚好走完
   * BROADSIDE_CYCLES 个来回,观感不随帧率漂移。
   */
  private stepBroadside(dt: number, heading: number): number {
    const w = this.world;
    if (w.broadsideCount >= BROADSIDE_MIN && w.tick !== this.broadsideTick) {
      this.broadsideTick = w.tick;
      // 齐射那一下的和弦(GDD §12 的签名时刻):只在这帧触发一次 —— tick 去重挡住了同帧重复,
      // 音频引擎另有 0.22s 窗口再兜一道
      audioBus.playBroadside();
      this.broadsideLeft = BROADSIDE_TIME;
      const edge = w.broadsideEdge;
      if (edge >= 0 && edge < EDGE_COUNT) {
        const n = edgeWorldNormal(edge, heading);
        this.broadsideDirX = -Math.cos(n);
        this.broadsideDirY = -Math.sin(n);
      } else {
        // 没有可用的舷(sim 给 -1):只闪不顿,总好过朝一个瞎猜的方向甩镜头
        this.broadsideDirX = 0;
        this.broadsideDirY = 0;
      }
    }

    const flash = this.flashG;
    if (this.broadsideLeft <= 0) {
      if (flash.visible) flash.visible = false;
      return 0;
    }
    this.broadsideLeft = Math.max(0, this.broadsideLeft - dt);
    const k = this.broadsideLeft / BROADSIDE_TIME; // 1 → 0

    // 闪光片每帧撑到屏幕大小:窗口尺寸随时会变(resizeTo: window),几何却只建过 1×1
    const screen = this.app.screen;
    flash.visible = k > 0;
    flash.scale.set(screen.width, screen.height);
    flash.alpha = BROADSIDE_FLASH_ALPHA * k;

    // cos 起手 = 1:触发那一帧立刻给出最大位移(先 sin 的话第一帧纹丝不动,"顿挫"就没了)
    return Math.cos((1 - k) * BROADSIDE_CYCLES * Math.PI * 2) * k * BROADSIDE_SHAKE_PX;
  }

  private stepShake(dt: number): void {
    const items = this.world.fx.items;
    for (let i = 0; i < items.length; i++) {
      const e = items[i]!;
      if (e.juicePlayed) continue;
      e.juicePlayed = true;
      if (e.kind === FXV_HULL_HIT) this.shakeTrauma += 0.85;
      else if (e.kind === FXV_IMPACT) this.shakeTrauma += 0.08;
      else if (e.kind === FXV_KILL) this.shakeTrauma += 0.035;
    }
    this.shakeTrauma = Math.min(
      SHAKE_MAX_TRAUMA,
      this.shakeTrauma * Math.exp(-Math.max(0, dt) / SHAKE_DECAY_TAU),
    );
    this.shakePhase += Math.max(0, dt) * SHAKE_FREQUENCY;
    const amplitude = this.shakeTrauma * this.shakeTrauma * SHAKE_PIXEL_SCALE;
    this.shakeX = Math.sin(this.shakePhase * 1.7) * amplitude;
    this.shakeY = Math.cos(this.shakePhase * 1.3) * amplitude;
  }

  /**
   * 远景按 cover 方式铺满屏幕，并留 12% 超扫给视差。位移用平滑周期函数而不是取模：
   * 船飞得再远也不会在某一帧把背景从右边瞬移回左边。
   */
  private syncBackground(width: number, height: number, shipX: number, shipY: number): void {
    const bg = this.backgroundSprite;
    if (!bg) return;
    const tex = bg.texture;
    const cover = Math.max(width / tex.width, height / tex.height) * BACKGROUND_OVERSCAN;
    bg.scale.set(cover);
    bg.position.set(
      width / 2 - Math.sin(shipX * BACKGROUND_PARALLAX_FREQ) * width * BACKGROUND_PARALLAX,
      height / 2 - Math.sin(shipY * BACKGROUND_PARALLAX_FREQ) * height * BACKGROUND_PARALLAX,
    );
  }

  /**
   * 甲板缩放的缓动(10 号 issue T4 的时停放大)。目标由 setDeckZoom 立,这里每渲染帧推一段。
   *
   * 指数逼近而不是"每帧加固定一档":后者的时长会随帧率漂移(144Hz 屏上放完只要 30Hz 屏的
   * 五分之一时间),而 1 - e^(-dt/τ) 这一式对任意 dt 都给出同一条时间曲线 ——
   * 掉帧那一帧 dt 大,它就一次多走一段,总时长不变(与 stepBroadside "按已走过的比例推进相位"
   * 是同一条口径:观感不随帧率漂移)。
   * 到位后**吸附并停手**:差值小于 DECK_ZOOM_EPS 就写死目标值,此后每帧只比一个数就返回。
   * 本方法只推数值,不碰任何容器 —— 缩放由 sync 乘进镜头 scale(worldLayer),
   * 于是甲板、敌人、弹道、射界共用同一个变换,视图里的几何关系永远诚实(理由见 sync)。
   */
  private stepDeckZoom(dt: number): void {
    const target = this.deckZoomTarget;
    if (this.deckZoom === target) return;
    // dt ≤ 0(首帧 deltaMS 为 0)时 k = 0:这一帧不动,下一帧照常 —— 绝不除以 0、也绝不外插
    const k = 1 - Math.exp(-Math.max(0, dt) / DECK_ZOOM_TAU);
    let z = this.deckZoom + (target - this.deckZoom) * k;
    if (Math.abs(target - z) <= DECK_ZOOM_EPS) z = target;
    this.deckZoom = z;
  }

  /**
   * 冲锋前摇的可读性指示(07 号验收标准:前摇可读、玩家来得及转向躲避)。画两样:
   * 锁定线 = 锁定方向 × 冲刺全程距离。方向在进 WINDUP 时就写死、冲刺中不再瞄准(见 sim/enemy),
   *   所以这条线是一句"待会儿只会撞这条线上"的承诺 —— 玩家照它横向挪开即可,这是躲避的唯一依据;
   * 收缩环 = 剩余前摇时间,环收到贴住体型那一刻起冲,给出"还有多久"的读数。
   * 颜色取该型自己的 tint,与它的剪影同色 → 不用猜是哪一只要冲。
   * 同一型的所有指示攒进一条 path 只 stroke 一次,把每帧的几何指令数压到 ≤ 敌型数。
   * @returns 剩余配额(精英/普通两只桶同型共享一个预算,见 sync)
   */
  private drawTelegraph(
    bucket: readonly Enemy[],
    def: EnemyDef,
    alpha: number,
    budget: number,
  ): number {
    // 数据驱动地跳过:没有前摇时长的型永远进不了 WINDUP(见 sim/enemy 状态机),不必逐个体检查
    if (def.chargeWindup <= 0 || budget <= 0) return budget;
    const g = this.telegraphG;
    // 每帧现读敌速倍率:sim 侧的冲刺速度同样是 chargeSpeed × enemySpeedScale(见 sim/enemy),
    // 漏乘的话把倍率拖到 2 就只画出一半危险区 —— 而这条线是玩家横向挪开的唯一依据
    const reach = def.chargeSpeed * tuning.enemySpeedScale * def.chargeDuration;
    let drawn = 0;
    for (let i = 0; i < bucket.length; i++) {
      if (budget <= 0) break;
      const e = bucket[i]!;
      if (e.state !== ST_WINDUP) continue;
      budget--;
      drawn++;
      // 位置与粒子同口径插值,否则指示线会比敌人本体晚一帧
      const x = e.px + (e.x - e.px) * alpha;
      const y = e.py + (e.y - e.py) * alpha;
      g.moveTo(x, y).lineTo(x + e.lockX * reach, y + e.lockY * reach);
      // 夹住 [0,1]:面板/单测改 chargeWindup 时正在前摇的那几只不至于画出巨环
      const t = Math.max(0, Math.min(1, e.timer / def.chargeWindup)); // 1 → 0
      // 环径走 enemyRadius:精英的判定体已被 sim 放大(×ELITE.scale),环必须收到
      // **放大的**体型上才合得上"合拢即起冲"的承诺 —— 照 def.radius 画的话,
      // 环会在精英的身体里合拢,冲撞甲虫型精英的前摇读数当场作废(14 号验收点名)
      g.circle(x, y, enemyRadius(e) * (1 + TELEGRAPH_RING_GROWTH * t));
    }
    if (drawn > 0) {
      g.stroke({ width: TELEGRAPH_WIDTH, color: enemyTint(def.kind), alpha: TELEGRAPH_ALPHA });
    }
    return budget;
  }

  /**
   * Boss 冲锋前摇(15 号):与普通甲虫同一条可读性通道(telegraphG 里的锁定线 + 收缩环),
   * 数值走 BOSS 表 —— 冲刺全程 = 底座 chargeSpeed × chargeSpeedMul × enemySpeedScale ×
   * chargeDuration(与 sim/boss.ts 的 DASH 分支同一份乘式),环径走 bossRadius()
   * (与判定体同源):环合拢那一刻正好贴住 Boss 本体,起冲即"贴住了"。
   * Boss 全场只有一只,不占 TELEGRAPH_MAX_PER_KIND 配额。
   */
  private drawBossTelegraph(alpha: number): void {
    const g = this.telegraphG;
    const base = ENEMIES[BOSS.baseKind]!;
    const reach = base.chargeSpeed * BOSS.chargeSpeedMul * tuning.enemySpeedScale * BOSS.chargeDuration;
    const tint = enemyTint(BOSS.baseKind);
    const bucket = this.bossBucket;
    let drawn = 0;
    for (let i = 0; i < bucket.length; i++) {
      const e = bucket[i]!;
      if (e.state !== BOSS_WINDUP) continue;
      drawn++;
      // 位置与粒子同口径插值,否则指示线会比 Boss 本体晚一帧(与 drawTelegraph 同一条)
      const x = e.px + (e.x - e.px) * alpha;
      const y = e.py + (e.y - e.py) * alpha;
      g.moveTo(x, y).lineTo(x + e.lockX * reach, y + e.lockY * reach);
      // 夹住 [0,1]:面板改 chargeWindup 时正在前摇的 Boss 不至于画出巨环
      const t = Math.max(0, Math.min(1, e.timer / BOSS.chargeWindup)); // 1 → 0
      g.circle(x, y, bossRadius() * (1 + TELEGRAPH_RING_GROWTH * t));
    }
    if (drawn > 0) {
      g.stroke({ width: TELEGRAPH_WIDTH, color: tint, alpha: TELEGRAPH_ALPHA });
    }
  }

  /**
   * 精英出场预警(14 号:出生前 ~2s 的视觉/音频提示,别让"突发"变"秒杀")。
   *
   * 数据源 = sim/waves 的 peekNextElite(world.wave 的只读游标):零 rng、零状态改动,
   * 只把脚本里早就写着的事提前念给玩家听 —— 与 HUD 的 burst 预警(burstWarning)同一条口径。
   * 预警消失不需要专门的判定:精英实际出生(eliteNext 游标前移)或该段结束之后,
   * peek 要么换到下一只精英、要么返回 null,窗口自然熄灭。
   *
   * 视觉:屏幕边缘一支箭头指向出生点(色相 = 该型 tint,一眼知道来的是哪一型),
   * 外加一圈随剩余 eta 收缩的倒计时环 —— 满环 = 刚进窗,合拢 = 出生。
   * 出生点 = 船心 + 主压方向 × SPAWN_RADIUS,与 sim/world 的 spawnFromWave 同口径
   * (不含 rng 抖动:±150px 的抖动在屏边箭头上读不出来,拿 0 抖动已经够诚实)。
   *
   * 音频:进窗那一帧响一次 —— 去重键 = (segment, eliteNext),窗口内键不变,
   * 绝不会在 2 秒窗口里反复发声(audio.ts 的 'warn:elite' 限流窗口再兜一道)。
   */
  /**
   * Boss 战提示(15 号):出场音 + 召唤预告,都在屏幕空间一层(bossWarnG)上做。
   *
   * 出场音:bossPhase 从别的值翻进 1 的那一帧响一次 —— 去重靠 bossPhaseSeen 锁存
   * 上次见过的阶段位(0/1/2 单调演化,同局只可能进战一次;换世界由 setWorld 复位)。
   *
   * 召唤预告:bossSummonCooldown ≤ BOSS.summonWarnTime 时,在 Boss 身上画一圈
   * 随剩余时间收弧的倒计时环 + 屏边一支指向 Boss 的箭头(仅 Boss 在屏外时)——
   * 与精英预警同一套"边缘箭头 + 倒计时环"视觉通道,靠 Boss 专属色(底座 tint)与
   * 更慢的闪烁节奏分得开。数据源 = world 的只读字段,零 rng、零状态改动。
   */
  private syncBossWarn(shipX: number, shipY: number, alpha: number): void {
    const g = this.bossWarnG;
    g.clear();
    if (this.assemblyView) return; // 装配界面是独立的固定界面,不叠战斗读数
    const w = this.world;
    // 出场音:只在 bossPhase 翻进 1 的那一帧响一次(去重键 = 阶段位,见 bossPhaseSeen)
    if (w.bossPhase !== this.bossPhaseSeen) {
      const enter = bossWarnOnEnter(this.bossPhaseSeen, w.bossPhase);
      this.bossPhaseSeen = w.bossPhase;
      if (enter) audioBus.playBossWarn(); // 专属低频鸣响(13 号音频联动):Boss 登场
    }
    const boss = this.bossBucket[0];
    if (!boss) return;
    // 召唤预告窗口:战斗中且距下次召唤 ≤ 预警窗(bossSummonWarnActive 的判据与
    // sim/world 的 bossSummonCooldown 一字同源)。击杀(Boss 出池)后桶空,自动熄灭。
    if (!bossSummonWarnActive(w.bossSummonCooldown, w.bossPhase)) return;

    const bx = boss.px + (boss.x - boss.px) * alpha;
    const by = boss.py + (boss.y - boss.py) * alpha;
    bossWarnWorld.x = bx;
    bossWarnWorld.y = by;
    this.worldLayer.toGlobal(bossWarnWorld, bossWarnScreen);
    const screen = this.app.screen;
    const cx = screen.width / 2;
    const cy = screen.height / 2;
    const frac = bossSummonWarnFraction(w.bossSummonCooldown); // 1 → 0:越近越少
    const blink = 0.5 + 0.5 * Math.abs(Math.sin(w.bossSummonCooldown * Math.PI * BOSS_WARN_BLINK_HZ));
    const tint = enemyTint(BOSS.baseKind);

    // 倒计时环:圈在 Boss 本体外沿(半径 = bossRadius × 镜头缩放 + 一圈余量,与判定体同源),
    // 满环 = 刚进窗,弧长随剩余冷却收没 = 召唤触发 —— 与精英预警的倒计时环同一语言
    const r = Math.max(6, bossRadius() * this.worldLayer.scale.x + 6);
    g.moveTo(bossWarnScreen.x + r, bossWarnScreen.y)
      .arc(bossWarnScreen.x, bossWarnScreen.y, r, 0, frac * Math.PI * 2)
      .stroke({ width: 2.5, color: tint, alpha: 0.85 * blink });

    // 屏边箭头(仅 Boss 落在屏外时):指向 Boss 的来向。Boss 在场内时环已经够读,
    // 箭头只负责"它现在在哪一侧、正压过来"这条屏外信息 —— 与精英预警箭头同款三角
    let dx = bossWarnScreen.x - cx;
    let dy = bossWarnScreen.y - cy;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) {
      dx = Math.cos(w.wave.dirRad);
      dy = Math.sin(w.wave.dirRad);
    } else {
      dx /= len;
      dy /= len;
    }
    const dist = Math.min(
      len,
      (screen.width / 2 - ELITE_WARN_EDGE_MARGIN) / Math.abs(dx),
      (screen.height / 2 - ELITE_WARN_EDGE_MARGIN) / Math.abs(dy),
    );
    if (dist < len) {
      const px = cx + dx * dist;
      const py = cy + dy * dist;
      const ang = Math.atan2(dy, dx);
      const size = ELITE_WARN_ARROW_BASE + ELITE_WARN_ARROW_GROW * (1 - frac);
      g.poly([
        px + Math.cos(ang) * size,
        py + Math.sin(ang) * size,
        px + Math.cos(ang + 2.4) * size * 0.55,
        py + Math.sin(ang + 2.4) * size * 0.55,
        px + Math.cos(ang - 2.4) * size * 0.55,
        py + Math.sin(ang - 2.4) * size * 0.55,
      ]).fill({ color: tint, alpha: blink });
    }
  }

  /**
   * 精英出场预警(14 号:出生前 ~2s 的视觉/音频提示,别让"突发"变"秒杀")。
   *
   * 数据源 = sim/waves 的 peekNextElite(world.wave 的只读游标):零 rng、零状态改动,
   * 只把脚本里早就写着的事提前念给玩家听 —— 与 HUD 的 burst 预警(burstWarning)同一条口径。
   * 预警消失不需要专门的判定:精英实际出生(eliteNext 游标前移)或该段结束之后,
   * peek 要么换到下一只精英、要么返回 null,窗口自然熄灭。
   *
   * 视觉:屏幕边缘一支箭头指向出生点(色相 = 该型 tint,一眼知道来的是哪一型),
   * 外加一圈随剩余 eta 收缩的倒计时环 —— 满环 = 刚进窗,合拢 = 出生。
   * 出生点 = 船心 + 主压方向 × SPAWN_RADIUS,与 sim/world 的 spawnFromWave 同口径
   * (不含 rng 抖动:±150px 的抖动在屏边箭头上读不出来,拿 0 抖动已经够诚实)。
   *
   * 音频:进窗那一帧响一次 —— 去重键 = (segment, eliteNext),窗口内键不变,
   * 绝不会在 2 秒窗口里反复发声(audio.ts 的 'warn:elite' 限流窗口再兜一道)。
   */
  private syncEliteWarning(shipX: number, shipY: number): void {
    const g = this.eliteWarnG;
    g.clear();
    if (this.assemblyView) return; // 装配界面是独立的固定界面,不叠战斗读数
    const w = this.world;
    // 没有下一个未触发的精英(段内放完 / 脚本走完)= 没有预警;压测旁路把 wave 冻在首段,
    // 教学段 elites 恒空,peek 天然 false,都不必在这里特判
    if (!peekNextElite(w.wave, this.elitePeek) || !eliteWarnActive(this.elitePeek)) {
      this.eliteWarnKey = -1;
      return;
    }
    const key = eliteWarnKey(w.wave.segment, w.wave.eliteNext);
    if (key !== this.eliteWarnKey) {
      this.eliteWarnKey = key;
      audioBus.playEliteWarn(); // 专属低鸣(13 号音频联动):只在预警窗口开头响一次
    }

    const peek = this.elitePeek;
    const dir = w.wave.dirRad;
    eliteSpawnWorld.x = shipX + Math.cos(dir) * SPAWN_RADIUS;
    eliteSpawnWorld.y = shipY + Math.sin(dir) * SPAWN_RADIUS;
    this.worldLayer.toGlobal(eliteSpawnWorld, eliteSpawnScreen);
    const screen = this.app.screen;
    const cx = screen.width / 2;
    const cy = screen.height / 2;
    let dx = eliteSpawnScreen.x - cx;
    let dy = eliteSpawnScreen.y - cy;
    const len = Math.hypot(dx, dy);
    // 船贴着出生点(理论上不可能:出生环恒在屏外)时退回主压方向,别让 |dx|/|dy| 除出 Infinity
    if (len < 1e-6) {
      dx = Math.cos(dir);
      dy = Math.sin(dir);
    } else {
      dx /= len;
      dy /= len;
    }
    // 把箭头压到屏幕边缘(出生点恒在屏外),同时兜住"点恰好落在屏内"的极端情形
    const dist = Math.min(
      len,
      (screen.width / 2 - ELITE_WARN_EDGE_MARGIN) / Math.abs(dx),
      (screen.height / 2 - ELITE_WARN_EDGE_MARGIN) / Math.abs(dy),
    );
    const px = cx + dx * dist;
    const py = cy + dy * dist;
    const ang = Math.atan2(dy, dx);
    const eta = peek.etaSeconds;
    const closeness = 1 - eta / ELITE_WARN_LEAD; // 0 → 1:越近越大越实
    const blink = 0.55 + 0.45 * Math.abs(Math.sin(eta * Math.PI * ELITE_WARN_BLINK_HZ));
    const tint = enemyTint(peek.kind);
    const size = ELITE_WARN_ARROW_BASE + ELITE_WARN_ARROW_GROW * closeness;
    // 箭头:尖朝出生方向。三角而非 HUD 预警的菱形 —— 两套预警一眼分得开
    g.poly([
      px + Math.cos(ang) * size,
      py + Math.sin(ang) * size,
      px + Math.cos(ang + 2.4) * size * 0.55,
      py + Math.sin(ang + 2.4) * size * 0.55,
      px + Math.cos(ang - 2.4) * size * 0.55,
      py + Math.sin(ang - 2.4) * size * 0.55,
    ]).fill({ color: tint, alpha: blink });
    // 倒计时环:剩余 eta 的比例段,收到零 = 出生
    const r = size * 1.7;
    g.moveTo(px + r, py)
      .arc(px, py, r, 0, (1 - closeness) * Math.PI * 2)
      .stroke({ width: 2.5, color: tint, alpha: 0.85 * blink });
  }

  private syncParticles(
    particles: Particle[],
    pc: ParticleContainer,
    entities: readonly (Enemy | Bullet | Drop)[],
    opts: {
      texture: Texture;
      tint: number;
      alpha: number;
      scale?: number;
      rotationOffset?: number;
      /** 程序化动画参数:只在敌人/精英/Boss 容器传入,子弹/残骸不付这个分支 */
      anim?: EnemyAnim;
    },
  ): void {
    // 扩容:tint/texture 是静态属性,增粒子后需 pc.update() 重传。
    // 粒子只增不删 —— 面板改出怪占比后,各型各自留着自己的历史峰值"停车位"不回落,
    // 拿一点常驻显存换掉运行期的缓冲重建
    if (particles.length < entities.length) {
      while (particles.length < entities.length) {
        const p = new Particle({
          texture: opts.texture,
          x: OFFSCREEN,
          y: OFFSCREEN,
          anchorX: 0.5,
          anchorY: 0.5,
          scaleX: opts.scale ?? 1,
          scaleY: opts.scale ?? 1,
          tint: opts.tint,
        });
        pc.addParticle(p);
        particles.push(p);
      }
      pc.update();
    }

    const a = opts.alpha;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i]!;
      const entity = entities[i];
      const e = entity as Interpolatable | undefined;
      if (e) {
        p.x = e.px + (e.x - e.px) * a;
        p.y = e.py + (e.y - e.py) * a;
        const anim = opts.anim;
        let seed = 0.5;
        let frame: { scale: number; spin: number; wobble: number } | undefined;
        if (anim && entity) {
          // anim 只随敌人容器传入,这里读得到 animSeed;兜 0.5 只是让类型收窄闭嘴,实际走不到
          seed = 'animSeed' in entity ? entity.animSeed : 0.5;
          frame = enemyAnimFrame(anim, this.animClock, seed, opts.scale ?? 1, animFrameScratch);
          // 呼吸 = 逐帧重写缩放(容器已开 vertex: true):基准永远是 opts.scale,
          // 不拿 p.scaleX 当基准 —— 那是上一帧的呼吸值,拿它当基准会逐帧放大/缩小漂移
          if (anim.breatheAmp > 0) {
            p.scaleX = frame.scale;
            p.scaleY = frame.scale;
          }
        }
        if (entity && (opts.rotationOffset !== undefined || anim)) {
          let vx = entity.vx;
          let vy = entity.vy;
          // 冲锋前摇会刹停,但朝向已经锁死;用锁定向量,避免候选图在预警环里停在上一方向。
          // Boss 走自己的状态机(sim/boss.ts),前摇码是 BOSS_WINDUP —— 与 ST_WINDUP 同一条
          if ('state' in entity && (entity.state === ST_WINDUP || entity.state === BOSS_WINDUP)) {
            vx = entity.lockX;
            vy = entity.lockY;
          }
          if (anim && frame && anim.spin !== 0) {
            // 自旋型(蜂群蛭):不跟速度朝向,持续漂移转 —— 口器绕圈就是它的"活着"信号
            p.rotation = frame.spin;
          } else if (vx * vx + vy * vy > 1e-6) {
            p.rotation =
              Math.atan2(vy, vx) +
              (opts.rotationOffset ?? 0) +
              (anim && frame ? frame.wobble : 0);
          }
        }
      } else {
        p.x = OFFSCREEN;
        p.y = OFFSCREEN;
      }
    }
  }
}
