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
 * 注意:11 号 issue 会要求战斗中甲板走简化渲染(远景只留轮廓),本轮**不做两套**,先把一套画对。
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
 * 节流读数(05 号 issue T5):deckThrottleG 逐帧把每座在线塔的节流状态画在它自己那一格上 ——
 * 弹夹条 + 装填进度 / 热量条 + 过热闪红 / 充能环,外加一排等级点。三套机制**各绑一种几何形状**
 * (沿 Y 的条 / 沿 X 的条 / 一个圆),而不是三条一样的条换个颜色:颜色这条通道已经被"哪座塔"
 * 占满了(读数一律取 def.tint,与该塔的弹和光效同色),再拿它区分机制就是把两条信息压进一个通道。
 * 这三样正是 06 号支援设施的三个作用锚点,画面上分不出三件事,06 号就没法让玩家看出加成落在哪。
 */
import {
  Application,
  Container,
  Graphics,
  Particle,
  ParticleContainer,
  Rectangle,
  type Texture,
} from 'pixi.js';
import { ENEMIES, type EnemyDef } from '../data/enemies';
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
  towerHeatMax,
  towerMagazine,
  towerRange,
} from '../data/towers';
import { type Arc, cellArc, isTurretCell } from '../sim/arc';
import { tuning } from '../sim/config';
import { deckOuterRadius, hullCoreHalfExtents } from '../sim/damage';
import {
  canPlace,
  CELL_SUPPORT,
  CELL_WEAPON,
  cellLocalPos,
  type Deck,
  deckCellSize,
  EDGE_BOW,
  EDGE_COUNT,
  EDGE_PORT,
  EDGE_STARBOARD,
  EDGE_STERN,
  edgeWorldNormal,
  isEdgeExposed,
  isPlaceSuccess,
} from '../sim/deck';
import { ST_WINDUP } from '../sim/enemy';
import {
  FX_LIFE_HULL_HIT,
  FX_LIFE_SPARK,
  FXV_BEAM,
  FXV_BLAST,
  FXV_CHAIN,
  FXV_HULL_HIT,
  FXV_LANCE,
  FXV_MUZZLE,
  FXV_SPARK,
} from '../sim/fx';
import { lerpAngle, type Vec2 } from '../sim/ship';
import type { Bullet, Enemy, World } from '../sim/world';
import { WORLD_RADIUS } from '../sim/world';

/** 未使用粒子的"停车位":粒子只增不删,多余的挪出视野(避免运行期增删 GPU 缓冲) */
const OFFSCREEN = 1e6;

// 敌人纹理一律画成灰阶(暗面 + 亮边),真正的颜色靠粒子 tint 相乘出来:
// tint 是逐粒子的静态属性,建粒子时上传一次就不再动,于是"按型上色"零每帧开销。
// 剪影结构与船体同一套语汇(暗底亮边),唯独色域相反 —— 敌取 src/data/enemies.ts 的红紫暖色,
// 我方取下面的冷色,千敌同屏时靠色域而不是靠描边把自己认出来(GDD §12)。
const ENEMY_FILL = 0x9a9a9a;
const ENEMY_EDGE = 0xffffff;
// 船体走冷色废铁(GDD §12)
const SHIP_FILL = 0x2b4a6e;
const SHIP_EDGE = 0x7fc4ff;

// —— 甲板配色:我方一律冷色域(GDD §12),三种格状态靠明度 + 蓝↔青的色相分开 ——
// 空格沿用船体本色:空格就是"还没装东西的船体",不该比装了东西的格更抢眼。
const DECK_EMPTY_FILL = SHIP_FILL;
const DECK_WEAPON_FILL = 0x3d78b8; // 武器塔:更亮的冷蓝
const DECK_SUPPORT_FILL = 0x2c7f76; // 支援设施:冷青,与武器塔同为冷色但色相分得开
const DECK_GRID_COLOR = 0x4d7ea8; // 格线:压在填充与轮廓之间的中间调,只交代"这里是分格的"
const DECK_GRID_WIDTH = 1.5;
/** 离线格(见 sim/deck 的 online 口径:武器塔失去全部暴露边)一律去色 + 压暗,一眼看出它是死的 */
const DECK_OFFLINE_FILL = 0x3a4048;
const DECK_OFFLINE_ALPHA = 0.35;
/** 格与格之间留缝:不留缝时相邻格的描边会叠成一条粗线,3×4 看上去就成了一整块 */
const DECK_CELL_GAP = 2;
const DECK_HULL_WIDTH = 2.5;
/** 船头亮边 + 艏尖:快速转向时头尾必须一眼分得清(T3 验收口径),故给最亮的一档冷白 */
const DECK_BOW_COLOR = 0xdff2ff;
const DECK_BOW_WIDTH = 4;
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
/** 高亮矩形相对格边的内缩:留出底板格线,免得高亮把格子边界糊掉 */
const DECK_HILITE_PAD = 4;
const DECK_HILITE_FILL_ALPHA = 0.16; // 薄薄一层:合法格要看得出"能放",但不能盖掉格子本身的状态色
const DECK_HILITE_WIDTH = 2;
const DECK_HOVER_WIDTH = 3; // 悬停格比其它合法格粗一档:光标在哪一格必须无歧义
const DECK_DENY_FILL_ALPHA = 0.22;

// —— 射界叠加层(04 号 issue,按住 Tab):我方冷色域(GDD §12),与弹道/合法格同一支蓝 ——
// 扇形是"这一片我打得到"的读数而不是实体,故填充压到极淡的一层、边界靠描边交代:
// 十座塔的扇形大面积互相重叠,填充再重一点就叠成一整块亮斑,反而读不出各塔的边界在哪。
const DECK_ARC_COLOR = 0x9adcff;
const DECK_ARC_FILL_ALPHA = 0.1;
const DECK_ARC_STROKE_ALPHA = 0.45;
const DECK_ARC_WIDTH = 1.5;
/** 炮口线取比扇形更亮一档的冷白(与船头标识同色):它是"炮管归位"在画面上唯一看得见的东西 */
const DECK_MUZZLE_COLOR = 0xdff2ff;
const DECK_MUZZLE_WIDTH = 3;
/** 炮口线长度(× 格边长):够伸出格外半格,不至于整条埋在格子自己的填充色里 */
const DECK_MUZZLE_LEN = 1;

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
const THR_PAD = 4.5;
const THR_BAR_THICK = 3.5;
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
const THR_RING_WIDTH = 3;
const THR_RING_TRACK_ALPHA = 0.5;
/** 满充的芯线:"可以放了"必须与"快满了"一眼分开,否则充能塔看上去永远在原地转圈 */
const THR_RING_FULL_WIDTH = 1.5;
/** 等级点(GDD §5.4 的 Lv1→Lv5):半径与间距,5 个点排下来仍在一格之内 */
const THR_LEVEL_DOT_R = 1.7;
const THR_LEVEL_DOT_GAP = 4.6;

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
/** 炮口火光的半径与不透明度(见 drawFx 里 FXV_MUZZLE 那一支:sim 本轮不产出它) */
const FX_MUZZLE_RADIUS = 4;
const FX_MUZZLE_ALPHA = 0.8;

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
const HULL_HIT_WIDTH = 5;
/** 惩罚满格时的不透明度。不给满 1:闪红是"叠在船体上的一层伤",不该把那一舷的轮廓整条替换掉 */
const HULL_HIT_ALPHA = 0.85;
/** 判定体轮廓(按住 Tab):细线 + 半透明 —— 它是叠在甲板上的调试读数,不许压过格子本身的状态色 */
const HULL_CORE_WIDTH = 2;
const HULL_CORE_ALPHA = 0.7;

// —— 船体 HP 条(09 号 issue T4 的**灰盒**读数)——整条会被 11 号 issue 的战斗 HUD 换掉,见 drawShipHp。
// 故这批常量刻意只有"槽 + 填充 + 一记受击回执"这几个,不做数字、分段、渐变、低血警告:
// 本轮要的只是"被撞了、掉了多少"在画面上存在,好看是 11 号的事。
/** 条长 = 船宽 × 它。与船同宽,于是"这条是这艘船的血"不用任何图例就读得出来 */
const HP_BAR_WIDTH_MUL = 1;
const HP_BAR_HEIGHT = 7;
/** 条与船体外接圆之间的留白(世界 px):贴着画会在急转弯时被甲板的角蹭到 */
const HP_BAR_GAP = 12;
/** 槽底沿用节流读数那一档暗色(THR_TRACK_COLOR),alpha 再高一点:HP 见底时槽必须还在(理由同 THR_TRACK_*) */
const HP_TRACK_ALPHA = 0.75;
/** 填充取船体轮廓那支冷蓝(GDD §12 我方冷色域):血条是船的一部分,不该另起一个色 */
const HP_FILL_COLOR = SHIP_EDGE;
/** 受击回执:暖红描边的线宽 + 横向抖动的幅度(世界 px)与衰减期内走完的振荡周期数(相位写法见 stepBroadside) */
const HP_HIT_WIDTH = 2;
const HP_HIT_SHAKE = 4;
const HP_HIT_CYCLES = 2.5;

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
  /** 悬停格在 deck.cells 里的下标,-1 = 不在甲板上 */
  hoverIndex: number;
  /** 刚被拒绝的格,-1 = 无;由 ui 层超时清零(渲染层不持有计时器) */
  denyIndex: number;
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
  return g.fill(ENEMY_FILL).stroke({ width: Math.max(1.5, r * 0.25), color: ENEMY_EDGE });
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
 */
function deckCellFill(content: number, online: boolean): number {
  if (!online) return DECK_OFFLINE_FILL;
  if (content === CELL_WEAPON) return DECK_WEAPON_FILL;
  if (content === CELL_SUPPORT) return DECK_SUPPORT_FILL;
  return DECK_EMPTY_FILL;
}

export class Renderer {
  readonly app: Application;
  private world: World;
  private worldLayer = new Container();
  /** 下标 === EnemyKind(与 ENEMIES 同序);每型一个容器,理由见构造函数里的取舍说明 */
  private enemyPcs: ParticleContainer[] = [];
  private enemyParticles: Particle[][] = [];
  private enemyTextures: Texture[] = [];
  /** 每帧复用的分桶数组:清空只用 length=0,绝不新建(运行期零分配,铁律 3) */
  private enemyBuckets: Enemy[][] = [];
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
   * 开火光效层(05 号 T5)。挂在 **worldLayer** 而不是 deckG:FxEvent 的坐标是**世界坐标**
   * (命中点在敌人身上,不在船上),挂进甲板局部空间会让整条光束跟着船转 —— 船一转,
   * 上一帧打出去的光束就会甩到别处去。
   */
  private fxG = new Graphics();
  private telegraphG: Graphics;
  /** 甲板容器:子层几何全在船体局部空间,它自己每帧只吃插值位姿(见文件头) */
  private deckG = new Container();
  private deckBaseG = new Graphics();
  /** 放置高亮:压在底板之上,否则合法格的半透明色块会被格子填充盖掉 */
  private deckHiliteG = new Graphics();
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
   * 船体 HP 条(09 号 T4 的灰盒读数,11 号 issue 会整条换掉 —— 见 drawShipHp)。
   * 挂在 **worldLayer 的最上层**、**不进 deckG**:进了甲板容器就会跟着船一起转,
   * 船头朝下时玩家得倒着读自己的血量;排在最上层则是因为它是"这一局还剩多少余地"这一个数,
   * 千敌贴脸时正是最该看见它的时刻,不许被任何东西盖住。
   */
  private shipHpG = new Graphics();
  /**
   * 底板几何的脏标记。占用/内容一局里只变几次(放塔、12 号焊接拼块),
   * 却要每帧出现在画面上 —— 故按 deck.revision 重建,而不是每帧 clear 重画。
   * 初值 -1 保证首帧必建一次(revision 从 0 起)。
   */
  private deckRevision = -1;
  /** 放置模式状态:由 ui 层塞进来,渲染层只读(见 PlacementUiState) */
  private placement: PlacementUiState | null = null;
  /** 高亮层上一帧是否画过东西:退出放置模式时只需 clear 一次,而不是每帧空转 */
  private hiliteDrawn = false;
  /** 射界叠加层开关:main.ts 每渲染帧灌 input.isDown('Tab'),渲染层只存 bool、不持有输入 */
  private arcOverlay = false;
  /** 叠加层上一帧是否画过:松开 Tab 时 clear 一次即可(照 hiliteDrawn 的写法) */
  private arcDrawn = false;
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
  /**
   * 齐射闪光:一张铺满屏幕的冷白薄片,挂在 **stage** 上而不是 worldLayer 里 ——
   * 闪光只能是"加"(叠一层亮色),而 Container.tint 是"乘",乘白色等于不变,压根闪不起来;
   * 挂进 worldLayer 又会被镜头缩放/平移带着走。几何只建 1×1,每帧靠 scale 撑到屏幕大小:
   * 窗口一改大小就不必重建几何(与 resizeTo: window 同步,零分配)。
   */
  private flashG = new Graphics().rect(0, 0, 1, 1).fill(FX_CORE_COLOR);

  static async create(world: World): Promise<Renderer> {
    const app = new Application();
    await app.init({
      background: 0x05070d,
      resizeTo: window,
      antialias: false,
      resolution: 1, // 压测口径:1x 分辨率(GDD §13 中端核显预算)
      preference: 'webgl',
    });
    document.getElementById('game')!.appendChild(app.canvas);
    return new Renderer(app, world);
  }

  private constructor(app: Application, world: World) {
    this.app = app;
    this.world = world;

    const bounds = new Rectangle(
      -WORLD_RADIUS * 2,
      -WORLD_RADIUS * 2,
      WORLD_RADIUS * 4,
      WORLD_RADIUS * 4,
    );
    const dyn = { position: true, rotation: false, color: false };

    // —— 关键取舍:四型 = 四个 ParticleContainer,而不是塞进同一个容器按型换色/换形 ——
    // ParticleContainer 整个容器只绑一张纹理(ParticleContainerPipe 里 container.texture ||=
    // children[0].texture),想在单容器里按型换形状就得上图集 + 把 uvs 设成 dynamic;
    // 更要命的是池用 swap-remove 回收,粒子↔实体的下标映射每帧都在变,所以单容器要按型上色
    // 就必须把 color 设成 dynamic(想按型换大小还得再加 vertex)——
    // 那等于每帧为全部 1000 个粒子重传 4 顶点的颜色/顶点缓冲,而这些值其实一辈子不变。
    // 分容器的代价只是多 3 个 draw call,GPU 侧可忽略。故:dynamicProperties 保持只有 position
    // 是动态的,每帧只重传位置,tint 与纹理都退化成建粒子时上传一次的静态属性。
    for (let k = 0; k < ENEMIES.length; k++) {
      const def = ENEMIES[k]!;
      // 2x 分辨率 + 抗锯齿:纹理只生成一次,拿一点显存换灰盒剪影的边缘可读性
      const tex = app.renderer.generateTexture({
        target: buildEnemyShape(def),
        resolution: 2,
        antialias: true,
      });
      this.enemyTextures.push(tex);
      // 显式把纹理绑在容器上(而不是听任它取第一个粒子的):让"一容器一纹理"这条约束写在明面上
      this.enemyPcs.push(
        new ParticleContainer({ dynamicProperties: dyn, boundsArea: bounds, texture: tex }),
      );
      this.enemyParticles.push([]);
      this.enemyBuckets.push([]);
    }

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

    // 方位参照:镜头跟船后画面里没有不动的东西,靠场地边界圈才知道自己漂到哪了
    const ring = new Graphics().circle(0, 0, WORLD_RADIUS).stroke({ width: 3, color: 0x1c2740 });

    // 冲锋前摇的指示层:每帧 clear 后重画(几何逐帧变),故与静态的边界圈分开
    this.telegraphG = new Graphics();

    // 灰盒船体 = 甲板本身:六个子层装进一个容器,容器负责"跟着船走",子层只管局部几何。
    // 子层序:射界扇形(底衬)→ 底板 → 被撞舷闪红(压住底板那条冷色轮廓线,否则等于没画)
    // → 炮口线(炮管长在甲板上,理应压住底板)
    // → 节流读数(压住炮口线:按住 Tab 时那条线正好横穿格心,把读数划掉就白画了)
    // → 放置高亮(临时的交互层,"我要放哪一格"任何时候都不许被别的层盖住)。
    // 闪红排在炮口线之下:炮管归位是每帧都要看的读数,不该被半秒钟的伤害反馈盖掉。
    // 这里不建几何 —— 格子内容要等 sync() 的脏标记在首帧补上(deckRevision = -1)。
    this.deckG.addChild(
      this.deckArcG,
      this.deckBaseG,
      this.deckHitG,
      this.deckMuzzleG,
      this.deckThrottleG,
      this.deckHiliteG,
    );

    // 层序:边界圈 → 前摇指示 → 敌(按 kind 顺序,后面的型压住前面的:冲撞甲虫排最后,
    // 不会被蜂群蛭糊掉)→ 弹 → 开火光效 → 甲板 → HP 条。指示层压在敌人之下:锁定线不该糊住甲虫自己的剪影。
    // 光效排在弹之后、甲板之前:它是"这一发打出去了"的读数,压住敌人才看得见命中在谁身上,
    // 但绝不许盖住甲板自己的格子(放塔与节流读数在那上面)。
    // 甲板压在敌与弹之上,千敌贴脸时自己的格子不会被糊掉 —— 放塔时更是必须看得见;
    // HP 条再压在甲板之上收尾:蜂群把船埋了的那一刻,正是"还剩多少血"最不能被盖住的时候。
    this.worldLayer.addChild(ring, this.telegraphG);
    for (let k = 0; k < this.enemyPcs.length; k++) this.worldLayer.addChild(this.enemyPcs[k]!);
    for (let s = 0; s < this.bulletPcs.length; s++) this.worldLayer.addChild(this.bulletPcs[s]!);
    this.worldLayer.addChild(this.fxG, this.deckG, this.shipHpG);
    // 闪光片挂在 stage 最上层(屏幕空间),不进 worldLayer —— 理由见 flashG 的字段注释
    this.flashG.visible = false;
    app.stage.addChild(this.worldLayer, this.flashG);
  }

  /** 每渲染帧调用。alpha ∈ [0,1):在上一逻辑帧与当前逻辑帧之间插值 */
  sync(alpha: number): void {
    const screen = this.app.screen;

    // 船的插值位姿:镜头与船体都取样它。直接用 ship.x/heading 会让整个画面按 60Hz 台阶抖(铁律 2)
    const ship = this.world.ship;
    const sx = ship.px + (ship.x - ship.px) * alpha;
    const sy = ship.py + (ship.y - ship.py) * alpha;
    // 朝向必须沿最短弧插值:线性插值一旦跨过 ±π 边界,船头会反向甩一整圈
    const sh = lerpAngle(ship.pheading, ship.heading, alpha);

    // 镜头(GDD §3.3):缩放由"船占屏高 20%"反推,固定不变 ——
    // 随速度变焦会让"船身长度"这个唯一的距离参照失效,射界判断也就没了标尺。
    const scale = (screen.height * tuning.cameraShipHeightFraction) / tuning.shipLength;
    // 屏高比例换算回世界单位,于是 look-ahead 的实际观感与窗口大小无关
    const lookAhead = (screen.height * tuning.cameraLookAhead) / scale;
    this.worldLayer.scale.set(scale);
    // pivot 落在船前方 → 船被推到屏幕后半区,腾出的视野正是要转过去的方向
    this.worldLayer.pivot.set(sx + Math.cos(sh) * lookAhead, sy + Math.sin(sh) * lookAhead);

    // broadside 顿挫直接加在镜头的屏幕位置上:worldLayer 无旋转,故世界系的方向向量
    // 与屏幕系一一对应,不必再换算一次。screenToWorld 走的是 worldLayer.toLocal,
    // 于是抖动期间"光标底下是哪一格"依然算得对(那句注释里预留的"将来加震屏"就是这里)。
    // dt 取渲染帧的实际间隔(不是 SIM_DT):这条计时器在渲染层自持,与逻辑帧率无关。
    const dt = Math.min(this.app.ticker.deltaMS / 1000, BROADSIDE_MAX_DT);
    const kick = this.stepBroadside(dt, sh);
    this.worldLayer.position.set(
      screen.width / 2 + this.broadsideDirX * kick,
      screen.height / 2 + this.broadsideDirY * kick,
    );

    // 按型分桶:每帧单趟遍历,桶是复用数组(length=0 而不是新建),运行期零分配
    const buckets = this.enemyBuckets;
    for (let k = 0; k < buckets.length; k++) buckets[k]!.length = 0;
    const enemies = this.world.enemies.items;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i]!;
      const bucket = buckets[e.kind];
      if (bucket) bucket.push(e); // kind 越界只是不画这一只,不炸掉整局
    }

    this.telegraphG.clear();
    for (let k = 0; k < buckets.length; k++) {
      const def = ENEMIES[k]!;
      const bucket = buckets[k]!;
      this.syncParticles(this.enemyParticles[k]!, this.enemyPcs[k]!, bucket, {
        texture: this.enemyTextures[k]!,
        tint: def.tint,
        alpha,
      });
      this.drawTelegraph(bucket, def, alpha, TELEGRAPH_MAX_PER_KIND);
    }

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

    // 开火光效:瞬时判定的四类全在这一层。**不插值**(见 drawFx)
    this.drawFx();

    // 甲板:底板只在 deck.revision 变了才重建,高亮层每帧现算(它跟着鼠标走)。
    // 容器只吃插值位姿,格子几何一律是局部坐标 —— 甲板与船体一同旋转由此成立(见文件头)
    const deck = this.world.deck;
    if (deck.revision !== this.deckRevision) {
      this.deckRevision = deck.revision;
      this.drawDeckBase(deck);
    }
    this.drawDeckHit(deck);
    this.drawDeckHilite(deck);
    this.drawDeckThrottle(deck);
    this.drawDeckArcs(deck);
    this.deckG.position.set(sx, sy);
    this.deckG.rotation = sh;

    // HP 条吃的是同一个插值船位、却**只吃位置不吃朝向**(见 shipHpG 字段注释),故不能塞进上面那两行
    this.drawShipHp(sx, sy);
  }

  /**
   * 四舷里剩余最久的那一档惩罚秒数;0 = 本帧没有任何一舷在挨罚。
   *
   * 被撞舷闪红与 HP 条的受击回执共用它 —— 两处读的都是 **sim 的那一个计时器**
   * (world.edgePenalty,与该舷塔的射速惩罚同源),于是"闪红 / 血条抖一下 / 塔变慢"
   * 三件事天然同起同落,想差一帧都做不到;渲染层要是为血条另起一个衰减计时器,
   * 玩家看到的三条反馈就会各走各的,而它们本该是同一次挨打。
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
   * 画布像素 → 世界坐标。放置交互(ui/placement.ts)拾格子的第一步:
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
   * 只在 deck.revision 变化时调用,故这里可以放心多跑几趟循环。
   */
  private drawDeckBase(deck: Deck): void {
    const g = this.deckBaseG;
    g.clear();
    const size = deckCellSize();
    const half = size / 2;
    const inset = DECK_CELL_GAP / 2;
    const cells = deck.cells;

    // 一、格子本体:按 content 上色,离线格灰显
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      if (!c.occupied) continue; // 不属于船体的格不画:12 号扩建前恒为 true
      const p = cellLocalPos(deck, c.col, c.row, localPos);
      const fill = deckCellFill(c.content, c.online);
      const a = c.online ? 1 : DECK_OFFLINE_ALPHA;
      g.rect(p.x - half + inset, p.y - half + inset, size - DECK_CELL_GAP, size - DECK_CELL_GAP)
        .fill({ color: fill, alpha: a })
        .stroke({ width: DECK_GRID_WIDTH, color: DECK_GRID_COLOR, alpha: a });
    }

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
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      if (!c.occupied || !isEdgeExposed(c, EDGE_BOW)) continue;
      const p = cellLocalPos(deck, c.col, c.row, localPos);
      g.moveTo(p.x + half, p.y - half).lineTo(p.x + half, p.y + half);
      if (p.x + half > bowX) bowX = p.x + half; // 艏尖挂在最靠前的那条暴露边上
      bow++;
    }
    if (bow > 0) {
      g.stroke({ width: DECK_BOW_WIDTH, color: DECK_BOW_COLOR });
      // 艏尖挂在最靠前的那条暴露边上、顶在中线(局部 y = 0):
      // 12 号把甲板焊歪之后它依然在船体正前方,这段不必跟着改
      const w = size * DECK_PROW_HALF_W;
      g.poly([bowX, -w, bowX + size * DECK_PROW_LEN, 0, bowX, w]).fill(DECK_BOW_COLOR);
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
    // 判据问 hitPenaltyLeft —— HP 条的受击回执读的是同一个数,"有没有一舷在挨罚"不该有第二份写法
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
   * 每帧重画 12 个矩形的代价可忽略(相比之下底板走脏标记,是因为它一直在画面上却极少变)。
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
      if (!isPlaceSuccess(canPlace(deck, c.col, c.row, st.content, st.towerType))) continue;
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
      const legal = isPlaceSuccess(canPlace(deck, hover.col, hover.row, st.content, st.towerType));
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
  private drawDeckArcs(deck: Deck): void {
    if (!this.arcOverlay) {
      // 松开 Tab 时清一次就够(照 drawDeckHilite):每帧 clear 两个空 Graphics 不贵,但也没必要
      if (this.arcDrawn) {
        this.deckArcG.clear();
        this.deckMuzzleG.clear();
        this.arcDrawn = false;
      }
      return;
    }
    this.arcDrawn = true;
    this.drawArcFans(deck);
    this.drawArcMuzzles(deck);
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
   * 与炮口线共用一层还顺带保证了"同开同关"—— 松开 Tab 时 drawDeckArcs 那一次 clear 把两者一起收走。
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
   * 船体 HP 条(09 号 issue T4)——"被撞了、掉了多少"在画面上的落点。
   * 没有它,09 号整条链路(判定体 → 结算 → 惩罚)在屏幕上就只剩几个火花,肉眼验收无从谈起。
   *
   * **这是可以整条删掉的灰盒版**:11 号 issue 的战斗 HUD 会把血量搬进屏幕空间,届时本方法、
   * shipHpG 字段与那批 HP_* 常量一起删除,sim 侧一个字都不用改 —— 它读的只有
   * world.ship.hp / maxHp 两个公开字段,除此之外不持有任何状态。所以这里刻意不做
   * 数字、分段、渐变、低血量警告:那些是 11 号要连着整套 HUD 一起定的事,
   * 现在做了,11 号只会得到一份必须先拆掉的旧设计。
   *
   * 挂在 worldLayer(见 shipHpG 字段注释)⇒ 它吃的是镜头的缩放,单位是**世界 px**:
   * 船在画面里多大,血条就多长。11 号会反过来把它做成屏幕空间的固定尺寸,不再随镜头变。
   * 竖直偏移问 sim 的 deckOuterRadius(与 World 粗筛同一个数,渲染层不自己推第二份):
   * 那是船体在**任何朝向**下的最大外延,于是"血条不压在船身上"与船头指哪儿无关,
   * 12 号把甲板焊大之后它也自动让开。
   *
   * 每帧 clear 重画,不做脏标记:船一直在动,条的位置每帧都变(与 drawDeckThrottle 同一条取舍)。
   */
  private drawShipHp(sx: number, sy: number): void {
    const g = this.shipHpG;
    g.clear();
    const ship = this.world.ship;
    const w = tuning.shipWidth * HP_BAR_WIDTH_MUL;

    // 受击回执的强度取 sim 的惩罚计时器(见 hitPenaltyLeft):于是"血条抖一下"与"那一舷闪红"
    // 是同一段时间窗 —— 玩家把两件事连起来看,正是这条反馈存在的目的。
    // clamp01 兜住 hitPenaltyTime 被面板拖到 0 的情形(除出来的 Infinity/NaN 会画出 NaN 几何)
    const k = clamp01(this.hitPenaltyLeft() / tuning.hitPenaltyTime);
    // 相位照 stepBroadside 那一顿的写法:cos 起手 = 1,受击那一帧立刻给出最大位移
    // (先 sin 的话第一帧纹丝不动,"抖了一下"就没了);幅度再乘 k,于是自己衰减回原位。
    // 按**已走过的比例**推进而不是按秒:惩罚时长被拖长拖短,这一抖都刚好走完 HP_HIT_CYCLES 个来回
    const kick = k > 0 ? Math.cos((1 - k) * HP_HIT_CYCLES * Math.PI * 2) * k * HP_HIT_SHAKE : 0;
    const x0 = sx - w / 2 + kick;
    const y0 = sy + deckOuterRadius(this.world.deck) + HP_BAR_GAP;

    // 槽底:空槽也要看得出"这里有一条血条",否则 HP 见底 = 读数整条消失(与 THR_TRACK_* 同一条取舍)
    g.rect(x0, y0, w, HP_BAR_HEIGHT).fill({ color: THR_TRACK_COLOR, alpha: HP_TRACK_ALPHA });
    // 比例每帧现算、不缓存:maxHp 是甲板的派生量(06 号的装甲舱会让它变,见 damage.hullMaxHp),
    // 缓存住就会与真实上限走散。maxHp ≤ 0 时直接当空槽,不让除法把 NaN 宽度喂进 Graphics
    const t = ship.maxHp > 0 ? clamp01(ship.hp / ship.maxHp) : 0;
    if (t > 0) g.rect(x0, y0, w * t, HP_BAR_HEIGHT).fill(HP_FILL_COLOR);
    // 挨打的回执:整条描一圈暖红(甲板上的暖色是 GDD §4.6 明令的例外,见 HULL_HIT_COLOR)+ 横向抖动。
    // 色相与位移两条通道一起上,是因为一次撞击掉的血可能只有几个点 ——
    // 光靠填充长度那一丁点变化,肉眼根本抓不住"刚刚挨了一下",而那正是本条要交代的事
    if (k > 0) {
      g.rect(x0, y0, w, HP_BAR_HEIGHT).stroke({
        width: HP_HIT_WIDTH,
        color: HULL_HIT_COLOR,
        alpha: HULL_HIT_ALPHA * k,
      });
    }
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
  private drawDeckThrottle(deck: Deck): void {
    const g = this.deckThrottleG;
    g.clear();
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
          if (c.reloadLeft > 0 && def.reload > 0) {
            const t = clamp01(1 - c.reloadLeft / def.reload);
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
          const max = towerHeatMax(def, c.level);
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
  private drawFx(): void {
    const g = this.fxG;
    g.clear();
    const items = this.world.fx.items;
    for (let i = 0; i < items.length; i++) {
      const e = items[i]!;
      // 色相 = 哪座塔打的(与它的子弹同色,一眼认得出是哪门炮);查不到就退回冷色兜底,
      // 绝不让暖色漏进我方光效(GDD §12 的敌我色域分离不可破)
      const def = TOWERS[e.towerType];
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
          break;
        }
        case FXV_MUZZLE: {
          // 炮口火光。本轮 sim 侧**不产出**它(FX_BULLET 的出膛位置由子弹自己交代),
          // 但事件类型已经在 sim/fx.ts 里定义好,这里照画一支:将来 sim 补发时不会被悄悄吞掉。
          // 数值表没给它对应的 FX_LIFE_*,故不淡出 —— 它本就只活一两帧,也不该在这里自造一个常量。
          g.circle(e.x0, e.y0, FX_MUZZLE_RADIUS).fill({ color, alpha: FX_MUZZLE_ALPHA });
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

  /**
   * 冲锋前摇的可读性指示(07 号验收标准:前摇可读、玩家来得及转向躲避)。画两样:
   * 锁定线 = 锁定方向 × 冲刺全程距离。方向在进 WINDUP 时就写死、冲刺中不再瞄准(见 sim/enemy),
   *   所以这条线是一句"待会儿只会撞这条线上"的承诺 —— 玩家照它横向挪开即可,这是躲避的唯一依据;
   * 收缩环 = 剩余前摇时间,环收到贴住体型那一刻起冲,给出"还有多久"的读数。
   * 颜色取该型自己的 tint,与它的剪影同色 → 不用猜是哪一只要冲。
   * 同一型的所有指示攒进一条 path 只 stroke 一次,把每帧的几何指令数压到 ≤ 敌型数。
   */
  private drawTelegraph(
    bucket: readonly Enemy[],
    def: EnemyDef,
    alpha: number,
    budget: number,
  ): void {
    // 数据驱动地跳过:没有前摇时长的型永远进不了 WINDUP(见 sim/enemy 状态机),不必逐个体检查
    if (def.chargeWindup <= 0 || budget <= 0) return;
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
      g.circle(x, y, def.radius * (1 + TELEGRAPH_RING_GROWTH * t));
    }
    if (drawn > 0) g.stroke({ width: TELEGRAPH_WIDTH, color: def.tint, alpha: TELEGRAPH_ALPHA });
  }

  private syncParticles(
    particles: Particle[],
    pc: ParticleContainer,
    entities: readonly (Enemy | Bullet)[],
    opts: { texture: Texture; tint: number; alpha: number },
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
      const e = entities[i] as Interpolatable | undefined;
      if (e) {
        p.x = e.px + (e.x - e.px) * a;
        p.y = e.py + (e.y - e.py) * a;
      } else {
        p.x = OFFSCREEN;
        p.y = OFFSCREEN;
      }
    }
  }
}
