/**
 * 渲染层:只读 sim 状态画图,在 prev/cur 位置间按 alpha 插值。
 * 规则:render 可以 import sim,sim 永不 import render。
 * 大批量实体走 ParticleContainer(GDD §13 性能预算的关键)。
 * 镜头跟船(GDD §3.3):固定缩放 + 航向前方 look-ahead,取样一律用插值后的位姿。
 * 敌我色域分离(GDD §12 / 07 号 issue):敌人一律红紫暖色剪影、我方船与弹一律冷色,
 * 四型之间再靠形状 + 体型区分 —— 色相与轮廓两条通道各自独立,色盲玩家丢了色相仍认得出型。
 *
 * —— 槽位制船体(改版,甲板网格删除后的渲染模型)——旧文件头里的甲板/格子/邻接/焊接全部删除:
 * 船体不再是 deckG 里的一张格子网,而是 shipG 容器里的**固定船壳 + 4 个武器硬点**:
 *   几何全部画在船体局部空间(硬点一律问 sim/armory 的 WEAPON_HARDPOINTS,
 *   射界中心一律问 sim/arc 的 slotArc,渲染层一行几何数学都不自己推),
 *   容器每帧只吃插值后的 position/rotation —— 于是"炮口与船体一同旋转"是结构上必然成立的。
 * 真实炮头贴图挂在硬点上,炮头每帧按"局部射界中心 + turretOffset"转
 * (与旧 syncDeckModuleRotations 同一套做法,只是格子换成了固定槽位);
 * 炮管方向直接由生成贴图的实体结构表达;按住 Tab(setArcOverlay)补上射界扇形、判定圆与节流读数。
 * 扇形角度/半径**一律问 sim / 数值表**(slotArc + towerArcDeg/towerRange),渲染层一行
 * 射界数学都不许自己写 —— 04 号的验收标准是"可视化与实际可命中区域一致"。
 *
 * 开火表现(05 号 issue T5):子弹按 towerType 分 ParticleContainer,瞬时判定的四类
 * (光束/链电/穿透光柱/落点 AoE)不进子弹池 —— sim 每帧交出一串 FxEvent(sim/fx.ts),
 * 渲染层在 fxG 上照 kind 分别画、按 life 淡出。弹与光效一律冷色(逐塔取 def.tint)。
 * FXV_MUZZLE(炮口闪)的坐标是 sim 在开火那一帧用 slotMuzzleWorld 算好的**世界坐标**,
 * 画进 muzzleFxG(压在 shipG 之上)即可,渲染层不再回查槽位。
 *
 * 齐射共振(FXV_RESONANCE,24 号 v1 纯演出,不加伤害):短窗内相邻三槽齐射的那一下,
 * 沿那面舷画一道冷色弧光 —— towerType 借放三元组中心槽下标(见 sim/fx.ts),
 * 朝向 = WEAPON_SLOT_FACING[中心槽] + 插值 heading(铁律 2);juicePlayed 保证时停/高刷屏下只闪一次。
 *
 * 受击表现(改版 09 号):甲板四舷随网格删除后,受击只有"撞进船心圆 = 真掉血"一层
 * (sim/damage 的 shipRadius),旧的被撞舷闪红 / edgePenalty 整段删除;
 * 世界只交 FXV_HULL_HIT(暖红扩散环)与 FXV_SPARK 事件。broadside 镜头顿挫
 * (单舷 ≥3 塔齐射的统计随四舷删除)随之退场 —— 渲染层不再自持任何顿挫计时/闪光片。
 *
 * 残骸掉落(10 号 issue T4):掉落物照敌/弹那一套走 ParticleContainer —— 一容器一纹理、
 * dynamicProperties 只有 position、位置吃 alpha 插值。
 *
 * 沉船爆炸、伤害飘字、前摇指示、精英/Boss 预警、震屏照旧 —— 全部是渲染层自持的纯表现,
 * 一个 sim 字段都不动、不进 checksum(铁律 1 的边界就画在这儿)。
 */
import {
  Application,
  Container,
  Graphics,
  Particle,
  ParticleContainer,
  Rectangle,
  Sprite,
  Text,
  type Texture,
} from 'pixi.js';
import { ELITE } from '../data/affixes';
import {
  BOSS,
  ENEMIES,
  KIND_BOSS,
  KIND_SPORE,
  KIND_STRAFER,
  type EnemyDef,
} from '../data/enemies';
import {
  FX_BULLET,
  FX_MORTAR,
  TOWER_AUTOCANNON,
  TOWER_AURORA,
  TOWER_ANNIHILATION,
  TOWER_ARC,
  TOWER_DELUGE,
  TOWER_LASER,
  TOWER_MORTAR,
  TOWER_PD,
  TOWER_RAILGUN,
  TOWER_STORM_CANNON,
  TOWER_THUNDER,
  TOWER_THORN,
  THR_AMMO,
  THR_CHARGE,
  THR_HEAT,
  STAR_MAX,
  TOWERS,
  towerArcDeg,
  type TowerDef,
  towerMagazine,
  towerRange,
} from '../data/towers';
import { SHOP_BEACON_LIFETIME, SHOP_BEACON_RADIUS } from '../data/economy';
import { BURST_PATTERN_RING, SPAWN_RADIUS } from '../data/waves';
import { type Arc, slotArc } from '../sim/arc';
import { WEAPON_HARDPOINTS, WEAPON_SLOT_COUNT, WEAPON_SLOT_FACING } from '../sim/armory';
import { tuning } from '../sim/config';
import { shipRadius } from '../sim/damage';
import { DROP_KIND_MAGNET, type Drop } from '../sim/drop';
import { ENEMY_HIT_FLASH, enemyRadius, ST_SPORE_WINDUP, ST_WINDUP } from '../sim/enemy';
import { BOSS_CHASE, BOSS_DASH, BOSS_RECOVER, BOSS_WINDUP, BOSS_Z_LEGS, bossRadius, bossZLaneDir } from '../sim/boss';
import {
  FX_LIFE_HULL_HIT,
  FX_LIFE_KILL,
  FX_LIFE_RESONANCE,
  FX_LIFE_SPARK,
  fxLifeForStars,
  FXV_BEAM,
  FXV_BLAST,
  FXV_CHAIN,
  FXV_HULL_HIT,
  FXV_IMPACT,
  FXV_KILL,
  FXV_LANCE,
  FXV_MUZZLE,
  FXV_RESONANCE,
  FXV_STAR_UPGRADE,
  FXV_SPARK,
} from '../sim/fx';
import { lerpAngle, type Vec2 } from '../sim/ship';
import { slotHeatMax, slotReload } from '../sim/tower';
import { peekNextElite, type ElitePeek } from '../sim/waves';
import type { Bullet, Enemy, EnemyBullet, World } from '../sim/world';
import { audioBus } from './audio';
import {
  ENEMY_RIGS,
  RIG_BOSS,
  RIG_UNIT,
  STRAFER_TARGET_TURN_LIMIT,
  targetFacingRootPose,
  type RigDef,
  type RigRootPose,
  type RigTargetFacing,
} from './enemyRig';
import { type GeneratedArtTextures, loadGeneratedArt } from './generatedAssets';
import { TOWER_STAR_HEAD_SCALES } from './artUrls';
import { ENEMY_BODY_FILL, enemyTint, SHIP_EDGE, SHIP_FILL } from './palette';
import { RigLayer, type RigDrive, type RigDriver, type RigEntity } from './rigLayer';
import { Starfield } from './starfield';

/** 未使用粒子的"停车位":粒子只增不删,多余的挪出视野(避免运行期增删 GPU 缓冲) */
const OFFSCREEN = 1e6;

// —— 屏外剔除 ——
// 地图无限、镜头只看一小块:视图矩形反向变换回世界系后外扩一圈缓冲带,
// 怪落在带外就整只跳过 —— 不进分桶 → 粒子不写位姿(留在 OFFSCREEN 停车位),
// 骨架那条路(RigLayer)同桶同口径,每帧省掉屏外上千只的位姿解算与缓冲上传。
// 缓冲带必须兜住:最大视觉外延(radius 14 × 精英 1.5 × 视觉 1.18 ≈ 25px)+
// 单帧插值位移(冲刺 ≤ 380px/s → 每帧 < 8px)。64 两倍有余;
// 震屏不是靠余量兜的 —— position 含震屏,反向变换把它精确吸收。
const CULL_MARGIN = 64;
/** 剔除矩形的模块级 scratch:每帧重写,绝不 new(与 animFrameScratch 同一条零分配纪律) */
const cullRectScratch = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

/**
 * 屏幕视图矩形 → 世界系剔除矩形(外扩 margin)。
 * worldLayer 无旋转:世界 = pivot + (屏幕 - position) / scale。
 * 纯函数,拆出来就是为了 Node 单测(renderer.test.ts 钉反向变换口径)。
 */
export function viewCullRect(
  scale: number,
  pivotX: number,
  pivotY: number,
  posX: number,
  posY: number,
  width: number,
  height: number,
  margin: number,
  out: { minX: number; minY: number; maxX: number; maxY: number },
): { minX: number; minY: number; maxX: number; maxY: number } {
  out.minX = pivotX + (0 - posX) / scale - margin;
  out.maxX = pivotX + (width - posX) / scale + margin;
  out.minY = pivotY + (0 - posY) / scale - margin;
  out.maxY = pivotY + (height - posY) / scale + margin;
  return out;
}

// 敌人纹理一律画成浅灰阶(明面 + 亮边),真正的颜色靠粒子 tint 相乘出来:
// tint 是逐粒子的静态属性,建粒子时上传一次就不再动,于是"按型上色"零每帧开销。
const ENEMY_EDGE = 0xffffff;
// —— 残骸掉落物(10 号 issue T4)——GDD §12 的"拾荒焊接美学:船是冷色废铁拼焊的" ——
// 残骸 = 低饱和钢白:与六塔那批高饱和冷色差的是饱和度、与敌人的红紫暖色差的是整个色域。
const DROP_TINT = 0xb9cfe0;
/** Boss 巨大慢速激光球的专属高热橙紫,与孢子炮手小弹丸保持明显层级差。 */
const BOSS_LASER_TINT = 0xff6b45;
/** 纹理一律灰阶(暗面 + 亮边),真正的颜色靠粒子 tint 相乘 —— 与敌人/子弹纹理同一套做法 */
const DROP_FILL = 0x8f959c;
const DROP_EDGE = 0xffffff;
const DROP_EDGE_WIDTH = 1.2;
// —— 07 polish:统一星尘材质语言 ——
// 三种语境共用同一组“亮核 + 轨道微粒 + 四向闪芒”语法:
//   掉落物把它烤进粒子纹理(零逐帧开销);击杀与商店信标在已有 Graphics 上逐帧画。
// 色相仍服从各自职责(残骸钢蓝 / 宝物金 / 击杀敌色 / 信标冷青),统一的是材质的高光与碎屑形态,
// 因而不会为了“看起来同款”破坏 GDD §12 的敌我色域分离。
const STARDUST_CORE_COLOR = 0xf4fbff;
const STARDUST_WARM_COLOR = 0xffdfa0;
const STARDUST_ANGLES = [0.12, 1.08, 2.26, 3.24, 4.35, 5.46] as const;
const STARDUST_ORBITS = [1, 0.74, 1.12, 0.84, 1.04, 0.7] as const;
const STARDUST_SIZES = [1, 0.62, 0.82, 0.55, 0.74, 0.5] as const;
/**
 * 菱形的外接半径(世界 px)。**刻意不取拾取半径**:拾取判定是围着**船心**量的
 * (sim/drop 的 dropCollectRadius),不是围着这一颗残骸 —— 照那个数画出去,
 * 满屏就是一片糊住虫潮的光斑,而它承诺的距离感还是错的。
 */
const DROP_RADIUS = 5;

// —— 磁吸宝物(26 号改)—— 精英死亡掉落的拾取物 ——
// 金色:与低饱和钢白的经验残骸分家。暖色域(金)在 GDD §12 里归敌人侧,
// 但金币读数是星币账本的颜色(ui/hud 的 SCRAP_COLOR 同款),且它只会躺在地上等人捡、
// 从不作为威胁行动 —— 这里用暖金当"宝物"语汇,而不是"敌人"语汇。
const MAGNET_ORB_TINT = 0xffd166;
/**
 * 宝物的外接半径(世界 px)。比经验残骸大一号:它是"特别的那一颗"——
 * 形状(六角)+ 颜色(金)+ 个头三层读数里,颜色是第一眼、个头是余光里的那一层。
 */
const MAGNET_ORB_RADIUS = 7;
/** 宝物的粒子缩放:渲染在 2x 纹理上,再乘 1.4 兜住"比残骸大一号"的承诺 */
const MAGNET_ORB_SCALE = 1.4;

// —— 船体局部几何的尺度基准 ——
// 船是固定船壳(tuning.shipLength 48 × shipWidth 36,不再有可扩建的甲板),
// 局部空间里的一切线宽/间距/读数**按船长等比**(取旧"格边长 12"的同一量级):
// 战斗态整船几十 px,写死 px 的话改一次船长就得回来重调一遍全部常数。
const CELL = tuning.shipLength / 4;

// —— 舰壳图缩放(旧参数原样保留)——
/** 舰壳图比 tuning 声明的船体略大一圈,露出装甲侧裙、推进器和舰艏(旧参数原样保留) */
const SHIP_HULL_LENGTH_PAD = 0.72;
const SHIP_HULL_WIDTH_PAD = 0.45;
/** 四型生成图都按战斗态飞船的视觉量级展示,并再放大一档;甲虫继续保留重甲型的体型读数。 */
const ENEMY_VISUAL_SPAN = (tuning.shipLength + CELL * SHIP_HULL_LENGTH_PAD) * 1.15;
const ENEMY_HEAVY_VISUAL_SCALE = 1.15;
/** 精英在 sim 的 1.5× 判定体之外再多一档纯视觉放大,不改伤害/碰撞平衡。 */
const ELITE_VISUAL_SCALE = 1.18;
/** 金橙滤色 + 同色常驻光环:与普通怪的红紫本色分开,一眼就是高优先级目标。 */
const ELITE_TINT = 0xffbd54;
/** Boss 是收尾焦点:碰撞直径 16.8% 屏高,再乘 1.5 的纯视觉倍率 = 约 1/4 屏高。 */
const BOSS_VISUAL_SCALE = 1.5;
/** Boss 的预警环不贴着视觉边缘:留出一圈冷色负空间,避免高细节贴图把倒计时环吃掉。 */
const BOSS_TELEGRAPH_RING_GAP = 10;
/** 召唤倒计时环比本体再外扩一档,与 Boss 的视觉尺寸而不是碰撞圆对齐。 */
const BOSS_SUMMON_RING_GAP = 16;
/** fal.ai 候选图的正面朝纹理上方(-Y),而船体局部 0 弧度朝船头(+X),两者相差 90°。 */
const GENERATED_ART_FORWARD_OFFSET = Math.PI / 2;
/** 单件生成图原始正面朝 -Y；骨架分件有自己的实测 forwardAngle,两条路径各自校准。 */
const STRAFER_ART_TARGET_FACING: RigTargetFacing = {
  forwardAngle: -Math.PI / 2,
  maxTurn: STRAFER_TARGET_TURN_LIMIT,
};
/** 灰盒飞镖原始尖头朝 +X,无需正面偏移,但同样执行左右换向与 ±30° 倾转。 */
const STRAFER_SHAPE_TARGET_FACING: RigTargetFacing = {
  forwardAngle: 0,
  maxTurn: STRAFER_TARGET_TURN_LIMIT,
};

// —— 炮位(改版:4 个固定硬点,不再有格子)——硬点坐标只来自 sim/armory 的 WEAPON_HARDPOINTS ——
/** 炮位贴图/兜底色块的边长(× CELL)。留出硬点周围的读数呼吸空间 */
const SLOT_GLYPH = CELL * 0.88;
/** round-8 炮头把机械转轴画在画布下部;锚点对准它,瞄准时炮身才不会绕硬点公转。 */
const TOWER_HEAD_ANCHOR_Y = 0.72;
// —— 射界叠加层(按住 Tab):我方冷色域(GDD §12),与弹道同一支蓝 ——
// 扇形是"这一片我打得到"的读数而不是实体,填充压到极淡、边界靠描边交代
const SLOT_ARC_COLOR = 0x9adcff;
const SLOT_ARC_FILL_ALPHA = 0.1;
const SLOT_ARC_STROKE_ALPHA = 0.45;
const SLOT_ARC_WIDTH = 1.2;
/** 充能读数落在真实炮头前方的一档位置,不再用它画常驻假炮管。 */
const SLOT_EFFECT_TIP_LEN = CELL;
/** 判定体轮廓(按住 Tab,与射界扇形同开同关):受击 = 船心圆(damage.shipRadius 唯一口径) */
const HULL_CORE_WIDTH = 1.2;
const HULL_CORE_ALPHA = 0.7;

// —— 节流读数(05 号 issue T5:"三种节流机制在 UI 上可读")——
// 三套机制**各绑一种几何形状**:弹药 = 沿 Y 的条、过热 = 沿 X 的条、充能 = 一个圆 ——
// 而不是三条一样的条换个颜色:颜色这条通道已经被"哪门炮"占满了(读数一律取 def.tint,
// 与该炮的弹和光效同色),再拿它区分机制就是把两条信息压进一个通道。
// 整层画在**船体局部空间**(与硬点同一套坐标),跟着船转:读数长在它所属的炮位上,不会飘。
/** 读数相对硬点的前移(× CELL,朝船头):别把炮位贴图本身盖掉 */
const THR_GAUGE_OFF = CELL * 0.42;
const THR_BAR_THICK = CELL * 0.094;
/** 条长(× CELL):比旧格边长略短,四槽的读数各自长在自己炮位旁边,不互相叠 */
const THR_BAR_LEN = CELL * 0.7;
/** 槽底:比任何塔色都暗一档 —— 空槽也要看得出"这里有一条读数" */
const THR_TRACK_COLOR = 0x0a1626;
const THR_TRACK_ALPHA = 0.55;
/** 装填进度用冷白 + 半透明:与"弹夹余量"(塔本色实心)同槽不同色,两者一眼分得开 */
const THR_RELOAD_ALPHA = 0.5;
/**
 * 过热锁死的闪烁频率(次/秒)。相位直接取 slot.coolLock —— 它本就在逐帧递减,
 * 于是渲染层不必自持第二个计时器;暂停时闪烁也跟着停(它读的是 sim 状态,不是墙钟)。
 */
const THR_OVERHEAT_BLINK_HZ = 6;
const THR_RING_RADIUS = CELL * 0.3; // 充能环半径(× CELL)
const THR_RING_WIDTH = CELL * 0.08;
const THR_RING_TRACK_ALPHA = 0.5;
/** 满充的芯线:"可以放了"必须与"快满了"一眼分开,否则充能塔看上去永远在原地转圈 */
const THR_RING_FULL_WIDTH = CELL * 0.04;
/** 等级点(GDD §5.4 的 Lv1→Lv5):半径与间距,5 个点排下来仍在炮位一档之内 */
const THR_LEVEL_DOT_R = CELL * 0.046;
const THR_LEVEL_DOT_GAP = CELL * 0.123;
/** 过热锁死闪红:暖色是敌人的色域(GDD §12),只许这么小一条、这么短一阵 */
const THR_DENY_COLOR = 0xff7a6b;

// —— 开火表现(05 号 issue T5)——四类瞬时表现的可辨识度靠**各绑一条形变通道**:
// 光束 = 细实线常亮;链电 = 逐跳折线;穿透 = 粗光柱随 life 收窄;AoE = 圆环随 life 扩张。
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
const FX_STAR_COLORS = [0x9adcff, 0xffd479, 0xfff1a8] as const;
const FX_STAR_UPGRADE_R0 = 12;
const FX_STAR_UPGRADE_R1 = 86;
const FX_STAR_UPGRADE_BURST_WIDTH = 3.2;
const FX_STAR_UPGRADE_CRACK_COUNT = 4;
const FX_CHAIN_WIDTH = 2;
const FX_CHAIN_ALPHA = 0.9;
/** 折角幅度(× 跳长):按跳长缩放,短跳才不会被折成一团 */
const FX_CHAIN_KINK = 0.16;
/** 折角的位置(沿跳的比例)与横向偏移(× 折角幅度)。定死不掷随机 —— 渲染层掷随机
 *  就等于在 sim 之外又开了一条随机源,同 seed 回放会画出不同的画面 */
const FX_CHAIN_KINK_AT = [0.28, 0.55, 0.8];
const FX_CHAIN_KINK_OFF = [1, -0.62, 0.3];
const FX_LANCE_WIDTH = 9;
const FX_LANCE_ALPHA = 0.5;
const FX_LANCE_CORE_WIDTH = 2;
const FX_BLAST_RING_WIDTH = 2.5;
/** 环的起手半径(× 真实 aoeRadius):从这里扩张到 1.0,**收尾那一帧的圈 = 实际炸到的范围** */
const FX_BLAST_START = 0.35;
/** 覆盖面的实心盘:极淡的一层,负责"炸到多大一片"的面积读数 */
const FX_BLAST_FILL_ALPHA = 0.16;
/** 炮口火光的半径与不透明度:略大于节流点,保证战斗态缩放下仍能越过塔色块被看见 */
const FX_MUZZLE_RADIUS = 7;
const FX_MUZZLE_ALPHA = 0.8;
/** 同色光晕落在同色塔块上仍会隐形;冷白描边与芯点提供不依赖塔色的第二条亮度通道 */
const FX_MUZZLE_RING_WIDTH = 2.5;
const FX_MUZZLE_CORE_RADIUS = 2.3;

// —— 受击表现(改版 09 号)——船体真伤害的暖红。我方船上唯一许可的暖色
// (GDD §4.6 明令的例外,与过热闪红同一条豁免):正因为整艘船连弹带光效都是冷色,
// "这一下啃到船了"才只能靠色相反转喊出来。只许出现在**线**上且**短促**,绝不铺成色块。
const HULL_HIT_COLOR = 0xff5a48;

/**
 * 火花 FXV_SPARK = "蹭到了但没进受击圆,一分血都没掉"。冷白、小、**随 life 收缩**;
 * 真伤害 FXV_HULL_HIT 则是暖红圆环**随 life 扩散**。两者在色域 + 形状 + 形变三条通道
 * 上同时相反,是因为 sim 侧它们是截然不同的两件事,画面上分不开就等于让玩家学错判定体。
 */
const FX_SPARK_COLOR = FX_CORE_COLOR;
/** 星芒射线的满长(世界 px)与线宽:比子弹还小一圈 —— 它是"没事"的读数,不该抢戏 */
const FX_SPARK_LEN = 7;
const FX_SPARK_WIDTH = 1.6;
/** 从命中点向外发散的四条射线的单位方向(±√2/2,合起来是一个 ×)。定死不掷随机 */
const FX_SPARK_DIRS = [0.707, 0.707, -0.707, 0.707, -0.707, -0.707, 0.707, -0.707];
/** 真伤害圆环:从 R0 扩到 R1(世界 px)。起手就比火花大一圈 —— "掉血了"必须比"擦到了"更响 */
const FX_HULL_HIT_R0 = 5;
const FX_HULL_HIT_R1 = 17;
const FX_HULL_HIT_WIDTH = 2.5;
const FX_IMPACT_COLOR = 0xc8f4ff;
const FX_IMPACT_LEN = 6;
const FX_IMPACT_WIDTH = 1.4;
/** 逐星真实弹道的程序化尾迹。路径按塔型/星级分组后一次 stroke,不为每颗弹新建事件对象。 */
const BULLET_TRAIL_LENGTH = [0, 4, 10, 19] as const;
const BULLET_TRAIL_WIDTH = [0, 1.1, 2.1, 3.6] as const;
const BULLET_TRAIL_ALPHA = [0, 0.38, 0.56, 0.72] as const;
const BULLET_TRAIL_CORE_WIDTH = 1.05;
const MORTAR_ORBIT_RADIUS = 7;
const MORTAR_ORBIT_PARTICLES = 3;
/** 3★ 命中星芒与爆炸碎片的固定方向:零随机,同一发在存续期内不会抖成噪点。 */
const FX_STAR_DIRS = [
  1, 0,
  0.5, 0.866,
  -0.5, 0.866,
  -1, 0,
  -0.5, -0.866,
  0.5, -0.866,
] as const;

/**
 * 击杀爆点 FXV_KILL(畅玩性调整):敌人死亡处一个从敌半径向外扩的短促圆环 + 四条放射短线。
 * 配色取 enemyTint(该敌型的红紫暖色):死的是敌人,爆点属于敌方色域 —— 与 FXV_BLAST
 * (我方冷色 AoE 承诺)在色域上天然分开,不会被读成"这里炸到了这么大一片"。
 * 射线方向定死不掷随机;取正交而不是对角,与火花的 × 形在形状通道上错开。
 */
const FX_KILL_RING_WIDTH = 2;
/** 爆环收尾半径 = 敌半径 × 它:虫死时"啵"地散开一圈,比本体大但远小于 AoE 的量级 */
const FX_KILL_EXPAND = 2.5;
/** 放射短线的满长(× 敌半径)与线宽 */
const FX_KILL_RAY = 1.4;
const FX_KILL_RAY_WIDTH = 1.6;
const FX_KILL_DIRS = [1, 0, 0, 1, -1, 0, 0, -1];
/** 击杀时星尘比爆环再飞远一档:暖色尸爆外面留一圈冷白/金色碎屑,成为“可拾荒”的句号。 */
const FX_KILL_STARDUST_EXPAND = 3.2;

// —— 齐射共振(24 号,v1 纯演出,不加伤害)——短窗内相邻三槽齐射的那一下,沿这面舷
// 铺一道冷色弧光:半径取船体受击圆(damage.shipRadius 全仓唯一口径,贴船壳外缘),
// 角跨 = 相邻三槽张成的整面 90° 舷,中心 = WEAPON_SLOT_FACING[中心槽] + heading。
// 两笔同一条弧(宽晕 + 亮芯),与光束同款双通道;色域一路冷白,不借任何一座塔的 tint ——
// 它是整条舷的和声,不是哪一门炮的功劳。
const RESONANCE_ARC_SPAN = Math.PI / 2;
const RESONANCE_ARC_GLOW_WIDTH = 5;
const RESONANCE_ARC_GLOW_ALPHA = 0.35;
const RESONANCE_ARC_CORE_WIDTH = 2;
const RESONANCE_ARC_CORE_ALPHA = 0.9;

// —— 伤害飘字(畅玩性)——
/** 飘字池容量 = 同屏上限。环形复用,池满顶掉最旧,绝不 new */
const DMG_POOL_SIZE = 64;
/** 飘字存续秒。短促是要点:它是"这一发多痛"的一瞥,不是战场字幕 */
const DMG_LIFE = 0.6; // 占位待调
/** 上飘速度(世界 px/s):0.6s 飘 ~8 世界 px ≈ 一两个身形,数字留在命中点附近 */
const DMG_RISE = 14;
/** 字号(世界 px)。战斗缩放 ≈ 屏高/750,1080p 下 10px 字 ≈ 14 屏幕 px */
const DMG_FONT_SIZE = 10; // 占位待调
/** 每帧最多新飘几个:迫击炮一圈炸 10 只也只飘 6 个,超出的本帧静默跳过 */
const DMG_SPAWN_CAP = 6;
/** 同帧同点事件(一圈 AoE 炸一片)的落点错开:固定 8 向、半径 3 世界 px —— 定死不掷随机 */
const DMG_JITTER_DIRS = [3, 0, 2.12, 2.12, 0, 3, -2.12, 2.12, -3, 0, -2.12, -2.12, 0, -3, 2.12, -2.12];
/** 船体真伤害的红字:与 FXV_HULL_HIT 圆环同一支暖红,"掉的是自己的血"只靠色相喊 */
const DMG_COLOR_HULL = 0xff5a48;
/** 击杀的暖黄:死亡是这一局的正反馈节拍,颜色要比普通命中亮一档 */
const DMG_COLOR_KILL = 0xffc46b;
/** 命中飘字按"伤害/满血"插值的黄端 */
const DMG_COLOR_HIT_YELLOW = 0xffd35c;
/** 命中飘字从白变黄的阈值带:伤害占比 < 0.08 = 白(蹭血),> 0.25 = 黄(重创) */
const DMG_RATIO_WHITE = 0.08;
const DMG_RATIO_YELLOW = 0.25;

// —— 沉船爆炸(畅玩性)——
/** 演出总时长(秒)。main 侧读同一份常量推迟结算界面,让爆炸读得完(见 main.ts) */
export const SHIP_DEATH_FX_TIME = 0.9; // 占位待调
/** 扩散环:三条错峰起手、各自 0.5s 从 R0 扩到 R1 并淡出 —— 波次感 = 船在解体 */
const DEATH_RING_COUNT = 3;
const DEATH_RING_DELAYS = [0, 0.12, 0.24];
const DEATH_RING_DURATION = 0.5;
const DEATH_RING_R0 = 8;
const DEATH_RING_R1 = 64;
const DEATH_RING_WIDTHS = [3.5, 2.5, 2];
const DEATH_RING_ALPHAS = [0.95, 0.8, 0.65];
/** 环色:冷白爆闪 → 我方冷蓝(船的颜色)→ 暖红火舌(全游戏唯一一次"我方色域被烧"的画面) */
const DEATH_RING_COLORS = [FX_CORE_COLOR, 0x9adcff, HULL_HIT_COLOR];
/** 碎片:20 块 3px 见方、全向飞散 + 空间拖拽减速 + 自旋,寿命比演出短一截 */
const DEATH_DEBRIS_COUNT = 20;
const DEATH_DEBRIS_SPEED = 70; // 世界 px/s 基准
const DEATH_DEBRIS_LIFE = 0.7;
const DEATH_DEBRIS_DRAG = 1.6; // 1/s,速度衰减系数

/** 飘字池里的一格:Text 复用 + 自己的生命周期,字段在构造时一次声明齐(运行期绝不新增) */
interface DmgSlot {
  text: Text;
  active: boolean;
  x: number;
  y: number;
  life: number;
  full: number;
}

/** 沉船爆炸的一块碎片:小方块 Graphics + 运动学,构造时一次建齐(演出是触发式的,但不现造对象) */
interface DeathDebris {
  g: Graphics;
  vx: number;
  vy: number;
  spin: number;
  life: number;
  full: number;
}

/** 一个已填武器槽的炮位绑定:贴图/兜底色块 + 重建时定死的塔型 */
interface WeaponBinding {
  /** 槽位下标(0..WEAPON_SLOT_COUNT-1) */
  slot: number;
  /** 该槽的塔型(重建时定死;数值表写坏 = undefined = 不画) */
  def: TowerDef | undefined;
  /** 贴图精灵(有生成图)或兜底色块(无);精灵的 rotation 每帧跟随炮管,色块不动 */
  g: Sprite | Graphics;
}

/**
 * 飘字文本:伤害取整 —— 溅射的零头不印小数点,扫一眼读得出才是飘字的本分
 */
export function dmgNumberText(damage: number): string {
  return String(Math.round(damage));
}

/**
 * 飘字配色(纯函数,便于单测):船体真伤害恒红;击杀恒暖黄;直射命中按"伤害/满血"
 * 从白到黄插值 —— 小伤害 = "蹭到了"的白,大伤害 = "重创"的黄,颜色即力度。
 */
export function dmgNumberColor(kind: number, ratio: number): number {
  if (kind === FXV_HULL_HIT) return DMG_COLOR_HULL;
  if (kind === FXV_KILL) return DMG_COLOR_KILL;
  const t = (ratio - DMG_RATIO_WHITE) / (DMG_RATIO_YELLOW - DMG_RATIO_WHITE);
  return lerpColor(0xffffff, DMG_COLOR_HIT_YELLOW, clamp01(t));
}

/**
 * 两个 0xRRGGBB 颜色按 k ∈ [0,1] 逐通道线性插值(飘字配色与受击闪白共用)。
 * 逐通道 Math.round(而不是位运算截断):k=0.5 的黑白中点恰好是 0x808080,插值是对称的。
 * 走 clamp01 的防御口径:NaN 被 `!(k > 0)` 接住,数值表被改坏也画不出 NaN 颜色。
 */
export function lerpColor(a: number, b: number, k: number): number {
  const t = clamp01(k);
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  return (
    (Math.round(ar + (br - ar) * t) << 16) |
    (Math.round(ag + (bg - ag) * t) << 8) |
    Math.round(ab + (bb - ab) * t)
  );
}

/**
 * 受击闪白的强度 0..1(剩余秒 / 满值)。渲染层拿它把敌剪影朝白色混合:
 * 刚命中的一帧最白,随 0.08s 衰减淡回本色(纯表现,不进 checksum)
 */
export function hitFlashMix(hitFlash: number): number {
  return clamp01(hitFlash / ENEMY_HIT_FLASH);
}

/** 渲染帧 dt 的上限(秒):切后台回来时 deltaMS 会是好几秒,不夹住就等于把反馈一口气跳完 */
/** 商店信标的颜色(冷青:我方色域,GDD §12 —— 它是补给点不是威胁) */
const BEACON_COLOR = 0x7ce8d8;
/**
 * 屏边指示箭头挂在离船多远的一圈上(世界 px)。取得比船体大一圈、比屏幕短边小 ——
 * 箭头是"往那边走"的读数,贴在船身上会与炮位挤成一团,贴到视野外就等于没画。
 */
const BEACON_ARROW_RADIUS = 150;
/** 离得比这更近就不画箭头(判定环已经在视野里,本体与箭头同时出现是噪声) */
const BEACON_ARROW_MIN_DIST = 420;

const MAX_RENDER_DT = 0.1;

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
/** Boss 出场的纯表现窗口:一记强镜头低频震动 + 背景紫红色相脉冲,不改任何 sim 状态。 */
export const BOSS_ENTRANCE_FX_TIME = 1.35;
const BOSS_ENTRANCE_SHAKE_PIXELS = 8.5;
const BOSS_ENTRANCE_BG_COLOR = 0x5c173f;
const BOSS_ENTRANCE_BG_TINT = 0xff9fc8;
const BOSS_ENTRANCE_BG_ALPHA = 0.24;

// —— 环阵 burst 预警(25 号)——屏幕空间,挂在 stage 上,不进 worldLayer ——
/**
 * 预警窗(秒):与 ui/hud 的 BURST_WARNING_WINDOW 同值 —— render 不反向依赖 ui(见
 * setArcOverlay 的依赖方向注释),而两套预警必须同进同出,这里照抄一份,改口径时两处一起改。
 */
const BURST_RING_WARN_WINDOW = 3;
/** 全环脉冲的闪烁频率:与 HUD 的 burst 预警同一招、同一节奏(渲染帧现算 sin,不依赖 CSS keyframes) */
const BURST_RING_BLINK_HZ = 3;
/** 环合拢到船心时保留的最小半径(px):收没了会变成"砸在船身上的一点",留一圈读得出"围死了" */
const BURST_RING_MIN_RADIUS = 8;

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
 * 去重靠渲染层把上次见过的阶段位锁存起来,再拿这一帧的相位喂进来 ——
 * 窗口内反复渲染帧不会重复发声。
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
 * 取硬点 / 屏幕点的暂存。模块级复用而不是每次现造(照 sim/world.ts 的 desired 写法):
 * 八个武器槽每帧要问好几遍硬点与扇形,现造就是每秒上千次分配(铁律 3)。用完即弃,绝不跨函数存活。
 */
const screenPos: Vec2 = { x: 0, y: 0 };
/** 射界暂存:同理,叠加层每帧要向 sim 问一遍全部槽的扇形,现造就是每秒上千次分配(铁律 3) */
const arcTmp: Arc = { center: 0, half: 0 };
/** 精英出生点的暂存(世界 → 屏幕换算,toGlobal 的 out 参数):热路径复用,零分配 */
const eliteSpawnWorld: Vec2 = { x: 0, y: 0 };
const eliteSpawnScreen: Vec2 = { x: 0, y: 0 };
/** Boss 本体/召唤预告环的暂存(世界 → 屏幕换算),与精英那对同一条口径 */
const bossWarnWorld: Vec2 = { x: 0, y: 0 };
const bossWarnScreen: Vec2 = { x: 0, y: 0 };
/** 环阵预警环心的暂存(世界 → 屏幕换算):burstRingG 挂在 stage(屏幕空间),画之前必须换算 */
const burstRingWorld: Vec2 = { x: 0, y: 0 };
const burstRingScreen: Vec2 = { x: 0, y: 0 };

/**
 * 按敌人定义生成灰盒剪影几何。形状与体型是色相之外的第二条辨识通道(色盲安全):
 * 圆 = 蜂群蛭(最小最多)、飞镖 = 侧掠者(尖头,一眼是"高速切入")、
 * 胶囊 = 尾随蛆(细长)、六边 = 冲撞甲虫(最大,重甲感)。
 * 尺寸一律以 def.radius(碰撞半径)为基准:灰盒阶段视觉 = 判定,别让玩家学错距离感;
 * 拉长的形状只在长轴方向超出,不放大实际判定圆。
 * 注意:粒子的 rotation 是静态属性,所以剪影朝向固定朝 +X ——
 * 这些形状只是"型号标签",不表示该敌人的实际航向,别照它判断冲锋方向。
 * 几何必须对原点上下左右对称 —— 粒子锚点固定 0.5,纹理是按包围盒裁的。
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
    case 'spore': {
      // 带刺球:交替 2r 个顶点在"判定圆"与"1.35r 刺尖"之间往返 —— 与圆型蜂群蛭同族,
      // 但多一圈尖刺作为色相之外的第二条辨识通道。刺尖不出判定圆太多(箭头是 1.2r,它 1.35r)
      const spikes = 8;
      const pts: number[] = [];
      for (let i = 0; i < spikes * 2; i++) {
        const a = (i / (spikes * 2)) * Math.PI * 2;
        const rr = i % 2 === 0 ? r : r * 1.35;
        pts.push(Math.cos(a) * rr, Math.sin(a) * rr);
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
 * 四型生成图都裁成同尺寸方图,这里把普通敌型的最长视觉边对齐战斗态舰壳长度;
 * 重甲甲虫再大一档。碰撞仍读 def.radius,视觉尺寸不反向污染 sim 数值。
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
  // 孢子炮手:中频小幅呼吸 + 轻微摆动,读作"炮台在鼓胀蓄能";不自转(它是锚定的,不飘)
  { freq: 2.4, breatheAmp: 0.09, wobbleAmp: 0.12, spin: 0 }, // KIND_SPORE 孢子炮手
];

/** 动画读数的模块级 scratch:syncParticles 热循环每帧重写,绝不 new(与 localPos 同一条零分配纪律) */
const animFrameScratch = { scale: 0, spin: 0, wobble: 0 };
/** 单件贴图回退路径的左右朝向 scratch:逐只重写,不在热循环分配对象 */
const targetFacingScratch: RigRootPose = { angle: 0, flipX: 1 };

/**
 * 骨架的"状态 → 动画"映射表(24 号 issue):下标 === ST_*(sim/enemy.ts 的状态码)。
 *
 * 骨架真正比单件贴图多出来的表达力就在这张表上 —— 同一套骨骼,靠提频/改摆幅把状态机演出来:
 *   接近:常态爬动;
 *   **前摇:提频到 3 倍、摆幅压到 0.55** —— 高频小幅 = 绷紧发抖,而不是"摆得更大";
 *     它与 drawTelegraph 的锁定线是同一件事的两条通道(GDD §6 前摇必须可读),
 *     锁定线交代"往哪冲",发抖交代"就是现在";
 *   冲刺:摆幅 1.5 倍、频率 1.6 倍 —— 尾鞭甩开、爪足向后蹬;
 *   硬直:半速小摆 = 啃咬后脱离时的脱力感。
 * 数值是表现旋钮,不进 checksum、不影响任何判定(与 ENEMY_ANIM 同一条"渲染只读"口径)。
 */
const RIG_STATE_DRIVE: readonly RigDrive[] = [
  { freqMul: 1, swingMul: 1 }, // ST_APPROACH
  { freqMul: 3, swingMul: 0.55 }, // ST_WINDUP
  { freqMul: 1.6, swingMul: 1.5 }, // ST_DASH
  { freqMul: 0.5, swingMul: 0.7 }, // ST_RECOVER
  { freqMul: 0.7, swingMul: 0.8 }, // ST_ANCHOR(孢子炮手用,两型首批骨架走不到)
  { freqMul: 2.6, swingMul: 0.5 }, // ST_SPORE_WINDUP(同上)
];
const RIG_DRIVE_FALLBACK: RigDrive = { freqMul: 1, swingMul: 1 };

/**
 * 骨架驱动器:整个渲染器共用一个实例(建一次长期持有)。
 * 每帧每只怪要调它三次,现造闭包等于每帧上千次堆分配 —— 故做成对象而不是传闭包进 RigLayer。
 */
const rigDriver: RigDriver = {
  rootPose(
    e: RigEntity,
    bodyX: number,
    bodyY: number,
    animClock: number,
    rig: RigDef,
    targetX: number,
    targetY: number,
    out: RigRootPose,
  ): void {
    out.flipX = 1;
    // 自转型(蜂群蛭):不跟速度朝向,口器绕圈就是它的"活着" —— 与单件贴图年代 ENEMY_ANIM.spin 同一条口径
    if (rig.spin !== 0) {
      out.angle = animClock * rig.spin + e.animSeed * Math.PI * 2;
      return;
    }
    // 侧掠者:不跟自身速度转整圈,而是朝飞船左右翻面,上下只倾转 30°。
    if (rig.targetFacing !== null) {
      targetFacingRootPose(bodyX, bodyY, targetX, targetY, rig.targetFacing, out);
      return;
    }
    if (rig.fixedRootAngle !== null) {
      out.angle = rig.fixedRootAngle;
      return;
    }
    let vx = e.vx;
    let vy = e.vy;
    // 冲锋前摇会刹停,但方向已锁死:用锁定向量,免得怪在预警环里停在上一方向
    if (e.state === ST_WINDUP || e.state === BOSS_WINDUP) {
      vx = e.lockX;
      vy = e.lockY;
    }
    if (vx * vx + vy * vy <= 1e-6) {
      // 速度与锁向都退化(刚出生的那一帧/被推到静止):退回锁向,再退回 0。
      // 单件贴图那条路在这种帧上是"不写 rotation、留着上一帧的值",骨架必须给出一个确定角,
      // 于是这里把它钉成纯函数 —— 同一状态永远解出同一位姿,不带帧间隐藏状态。
      vx = e.lockX;
      vy = e.lockY;
      if (vx * vx + vy * vy <= 1e-6) {
        out.angle = GENERATED_ART_FORWARD_OFFSET;
        return;
      }
    }
    out.angle = Math.atan2(vy, vx) + GENERATED_ART_FORWARD_OFFSET;
  },
  drive(e: RigEntity, out: RigDrive): void {
    const d = RIG_STATE_DRIVE[e.state] ?? RIG_DRIVE_FALLBACK;
    out.freqMul = d.freqMul;
    out.swingMul = d.swingMul;
  },
  tint(_e: RigEntity): number {
    // 恒白 = 部件图原色。**受击闪白在这里是空操作,和单件贴图那条路一样** ——
    // 粒子 tint 是相乘的,生成图的基准 tint 已经是 0xffffff,朝白色混合等于不动
    // (enemyTextureTints 在生成图加载成功时就是 0xffffff,而它实际上总是加载成功)。
    // 这是既有的哑火,不是骨架引入的:要让满色贴图"闪一下"得换通道(加色滤镜/额外一层),
    // 不在本次改动范围内 —— 但也不在这里写个 lerp(白,白) 假装它在工作。
    return 0xffffff;
  },
};

/** 精英与普通怪共用动作,但额外套金橙色；受击时才从金橙闪向白,比原色怪更清楚。 */
const eliteRigDriver: RigDriver = {
  rootPose: rigDriver.rootPose,
  drive: rigDriver.drive,
  tint(e: RigEntity): number {
    return e.hitFlash > 0
      ? lerpColor(ELITE_TINT, 0xffffff, hitFlashMix(e.hitFlash))
      : ELITE_TINT;
  },
};

/** Boss 的 10..13 状态码不占普通怪的 RIG_STATE_DRIVE 下标,单独映射巨物的慢重步态。 */
const bossRigDriver: RigDriver = {
  rootPose: rigDriver.rootPose,
  drive(e: RigEntity, out: RigDrive): void {
    switch (e.state) {
      case BOSS_CHASE:
        out.freqMul = 0.88;
        out.swingMul = 1.08;
        break;
      case BOSS_WINDUP:
        out.freqMul = 2.45;
        out.swingMul = 0.72;
        break;
      case BOSS_DASH:
        out.freqMul = 1.85;
        out.swingMul = 1.65;
        break;
      case BOSS_RECOVER:
        out.freqMul = 0.5;
        out.swingMul = 0.84;
        break;
      default:
        out.freqMul = 0.88;
        out.swingMul = 1.08;
    }
  },
  tint: rigDriver.tint,
};

/**
 * 单帧动画读数的纯计算:给同步循环一次算出缩放乘数 / 自转角 / 摆动角。
 * 拆出来就是为了 Node 单测 —— 热路径之外的三个 sin 换来的可测性值得(renderer.test.ts 钉边界)。
 * 写进调用方给的 out(缺省 = 模块级 scratch),绝不 new:syncParticles 每帧要为 1000 只怪调它。
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
 * 粒子的 rotation 是静态属性,拉长的形状于是会在除 +X 外的任何飞行方向上指错,反倒骗人。
 * 朝向信息本来就由弹道自己交代(它在动),形状只负责回答"这是哪一种弹":
 *   直射弹(FX_BULLET)= 实心亮点,半径**取真实碰撞半径**(灰盒阶段视觉 = 判定);
 *   抛射弹(FX_MORTAR)= 空心环,它途中不碰撞、只在落点炸,给个"壳"的读数与直射弹一眼分得开。
 * 几何一律画成白色:颜色由粒子 tint 相乘出来(建粒子时上传一次,零每帧开销)。
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
 * 敌方弹丸的剪影(22 号):发光的孢子球 —— 实心圆 + 一圈半透明外晕。
 * 形状与直射弹同族(都是圆),色相却取 enemyTint(KIND_SPORE) 的暖红紫:
 * GDD §12 敌我色域分离靠的就是这一条,形状通道不必再为它另开一档。
 * 半径取碰撞半径(灰盒阶段视觉 = 判定,与子弹纹理同一口径)。
 */
function buildSporeBulletShape(): Graphics {
  const r = 5;
  return new Graphics()
    .circle(0, 0, r)
    .fill(0xffffff)
    .stroke({ width: 2, color: 0xffffff, alpha: 0.45 });
}

/**
 * Boss 激光球剪影:大实心能量核 + 双层轨道 + 四道短促放射刺。
 * 纹理以 32px 碰撞半径烘焙,运行时不再逐粒子缩放;碰撞体与视觉体因此一一对齐。
 */
function buildBossLaserBallShape(): Graphics {
  const r = 32;
  const g = new Graphics();
  g.circle(0, 0, r).fill({ color: 0xffffff, alpha: 0.18 });
  g.circle(0, 0, r * 0.82).stroke({ width: 3.5, color: 0xffffff, alpha: 0.78 });
  g.circle(0, 0, r * 0.54).fill(0xffffff);
  g.circle(0, 0, r * 0.23).fill({ color: 0xffffff, alpha: 0.95 });
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    const inner = r * 0.84;
    const outer = r * 1.16;
    g.moveTo(Math.cos(a) * inner, Math.sin(a) * inner)
      .lineTo(Math.cos(a) * outer, Math.sin(a) * outer);
  }
  g.stroke({ width: 2.4, color: 0xffffff, alpha: 0.68 });
  return g;
}

/**
 * 统一星尘晕:六颗定相位轨道微粒,奇数位是四向闪芒、偶数位是圆尘。
 * 不掷随机:击杀回放、信标呼吸与截图在同一时间点必然长得一样;调用方只给 phase 让整圈缓慢转动。
 * `radius` 是轨道基准而不是判定半径,所以同一语法可缩到 5px 掉落纹理、也可放到 46px 信标。
 */
function drawStardustHalo(
  g: Graphics,
  cx: number,
  cy: number,
  radius: number,
  phase: number,
  alpha: number,
  primary = STARDUST_CORE_COLOR,
  accent = STARDUST_WARM_COLOR,
): void {
  const baseSize = Math.max(0.65, radius * 0.075);
  let glints = 0;
  for (let i = 0; i < STARDUST_ANGLES.length; i++) {
    const a = STARDUST_ANGLES[i]! + phase;
    const orbit = radius * STARDUST_ORBITS[i]!;
    const x = cx + Math.cos(a) * orbit;
    const y = cy + Math.sin(a) * orbit;
    const size = baseSize * STARDUST_SIZES[i]!;
    const color = i % 3 === 1 ? accent : primary;
    if ((i & 1) === 0) {
      g.circle(x, y, size).fill({ color, alpha: alpha * (0.58 + STARDUST_SIZES[i]! * 0.32) });
      continue;
    }
    g.moveTo(x - size * 1.7, y).lineTo(x + size * 1.7, y);
    g.moveTo(x, y - size * 1.7).lineTo(x, y + size * 1.7);
    glints++;
  }
  if (glints > 0) {
    g.stroke({ width: Math.max(0.65, baseSize * 0.42), color: primary, alpha: alpha * 0.82 });
  }
}

/**
 * 残骸掉落物的剪影(10 号 issue T4)。一律**菱形**,且全场只有这一种形状 ——
 * 圆 / 飞镖 / 胶囊 / 六边被四型敌人占满,实心点与空心环被两类子弹占满,菱形是唯一还空着的一档:
 * 于是"地上那颗是残骸"不必靠颜色也认得出(色盲安全,与敌人分型同一条口径)。
 * 几何画成灰阶(暗面 + 亮边),颜色由粒子 tint 相乘得到,与敌人/子弹纹理同一套做法。
 * 形状对原点对称(粒子锚点固定 0.5,纹理按包围盒裁)。
 */
function buildDropShape(): Graphics {
  const r = DROP_RADIUS;
  const g = new Graphics()
    .poly([r, 0, 0, r, -r, 0, 0, -r])
    .fill(DROP_FILL)
    .stroke({ width: DROP_EDGE_WIDTH, color: DROP_EDGE });
  // 星尘烤进纹理:ParticleContainer 仍只上传 position,不为满屏掉落物新增逐帧几何。
  drawStardustHalo(g, 0, 0, r * 1.65, 0, 0.9, DROP_EDGE, DROP_EDGE);
  return g;
}

/**
 * 磁吸宝物的剪影(26 号改):**正六角**(尖顶朝上),中间留一圈亮边。
 * 形状通道:圆 / 飞镖 / 胶囊 / 六边被敌人占满,实心点与空心环被子弹占满,菱形归经验残骸 ——
 * 六角是还空着的、与菱形一眼分得开的一档,再叠金色 tint 与放大一号的个头,
 * "这一颗是宝物"不必靠任何一个单通道也能认得(色盲安全口径与 buildDropShape 同源)。
 * 几何画成灰阶(暗面 + 亮边),颜色由粒子 tint 相乘得到,与敌人/子弹纹理同一套做法。
 */
function buildMagnetOrbShape(): Graphics {
  const r = MAGNET_ORB_RADIUS;
  const pts: number[] = [];
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 3;
    pts.push(Math.cos(a) * r, Math.sin(a) * r);
  }
  const g = new Graphics()
    .poly(pts)
    .fill(DROP_FILL)
    .stroke({ width: DROP_EDGE_WIDTH * 1.4, color: DROP_EDGE });
  drawStardustHalo(g, 0, 0, r * 1.55, Math.PI / 6, 1, DROP_EDGE, DROP_EDGE);
  // 宝物多一枚亮核,与普通残骸的空心菱形拉开层级;最终颜色仍由 MAGNET_ORB_TINT 相乘。
  g.circle(0, 0, r * 0.22).fill(DROP_EDGE);
  return g;
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

/** 表现层统一的星级夹取。旧档/坏值回落 1★,不让数组下标与线宽算出 NaN。 */
export function visualStarTier(stars: number): 1 | 2 | 3 {
  return stars >= 3 ? 3 : stars >= 2 ? 2 : 1;
}

function isAutocannonFamily(type: number): boolean {
  return type === TOWER_AUTOCANNON || type === TOWER_STORM_CANNON;
}

function isPointDefenseFamily(type: number): boolean {
  return type === TOWER_PD || type === TOWER_THORN;
}

function isRailFamily(type: number): boolean {
  return type === TOWER_RAILGUN || type === TOWER_ANNIHILATION;
}

function isMortarFamily(type: number): boolean {
  return type === TOWER_MORTAR || type === TOWER_DELUGE;
}

/**
 * 读数比例夹取。`!(t > 0)` 而不是 `t < 0`:**NaN 与任何数比较都是 false**,写成前者才把
 * NaN 一并接住 —— 数值表被改坏时,除出来的 NaN 会让 Graphics 画出长度 NaN 的矩形,
 * 整个船层当场消失;夹成 0 只是"这条读数是空的",画面还在。
 */
function clamp01(t: number): number {
  if (!(t > 0)) return 0;
  return t > 1 ? 1 : t;
}

/** Boss 出场色相/低频震动的平滑包络:刚触发为 1,在 BOSS_ENTRANCE_FX_TIME 内平滑退到 0。 */
export function bossEntranceStrength(left: number): number {
  const t = clamp01(left / BOSS_ENTRANCE_FX_TIME);
  return t * t * (3 - 2 * t);
}

// —— 震屏(纯表现,渲染层自持:受击/击杀事件入账为 trauma,按指数衰减)——
const SHAKE_MAX_TRAUMA = 1;
const SHAKE_DECAY_TAU = 0.12;
const SHAKE_FREQUENCY = 48;
const SHAKE_PIXEL_SCALE = 4.5;

// —— 加速技能表现(纯表现,渲染层自持;sim 侧只有 world.boostTime 一个读数)——
/** 点火那一帧入账的震屏 trauma:比受击(0.85)轻 —— 是"推背感",不是"挨了一下" */
const BOOST_SHAKE_TRAUMA = 0.45;
/** 拖尾采样点上限(环形复用,life ≤ 0 的槽位即空闲;24 点 × 0.45s 存续覆盖整条尾迹) */
const BOOST_TRAIL_MAX = 24;
/** 单个拖尾点的存续秒:淡出快于加速窗(1.1s),尾迹只跟在船屁股后面,不铺满整条航线 */
const BOOST_TRAIL_LIFE = 0.45;
/** 尾焰/拖尾颜色 = HUD 冷却条的推进器青绿(ui/hud 的 BOOST_COLOR 十六进制同值) */
const BOOST_TINT = 0x8ef2c0;
/** 尾焰基准长度(船体局部 px):约半个船身,flicker 后在 0.75~1 倍间喘 */
const BOOST_FLAME_LEN = 26;

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
  /** 程序化动画时钟:渲染帧累加(与 stepShake 同一份 dt),时停期间照走 —— 虫子冻结不等于死物 */
  private animClock = 0;
  /**
   * 精英(affixes ≠ 0)各型独立容器。尺寸 = ELITE.scale × ELITE_VISUAL_SCALE,
   * 再套金橙滤色与常驻光环；轮廓、尺寸、颜色三条通道同时回答“这只不一样”。
   */
  private elitePcs: ParticleContainer[] = [];
  private eliteParticles: Particle[][] = [];
  private eliteBuckets: Enemy[][] = [];
  /**
   * 逐型 cutout 骨架层(24 号 issue),下标 === EnemyKind。
   * 非 null = 这一型改走"每部件一个粒子"的骨架路径,上面那套单件贴图的容器**一个粒子都不建**
   * (syncParticles 是按需扩容的,不调它就永远是空容器),于是不会双重绘制。
   * null = 这一型没做骨架或部件图缺失,照旧走单件贴图 —— 逐型回退,做一型接一型。
   */
  private enemyRigLayers: (RigLayer | null)[] = [];
  /** 精英骨架:与普通型同部件,baseScale 乘 ELITE.scale × ELITE_VISUAL_SCALE */
  private eliteRigLayers: (RigLayer | null)[] = [];
  /**
   * Boss(15 号)的专属容器:底座型(冲撞甲虫)的**同一张纹理、同一个 tint**,只是静态缩放
   * 让剪影外接半径 = bossRadius() —— 判定体多大画多大。独立容器而不是塞进 kind 桶:
   * kind = KIND_BOSS 不在 ENEMIES 表里,普通桶的越界兜底是"不画这一只" —— Boss 必须画。
   */
  private bossPc: ParticleContainer;
  private bossParticles: Particle[] = [];
  private bossBucket: Enemy[] = [];
  /** round-7 Boss 拆件齐全时走骨架；null 才回退上面的整图粒子。 */
  private bossRigLayer: RigLayer | null = null;
  /** Boss 的实际整图与 tint(round-7 专属图,骨架缺件时使用;构造时定死,sync 只读) */
  private bossTexture: Texture;
  private bossTextureTint = 0xffffff;
  private bossTextureScale = 1;
  private bossRotationOffset = 0;
  /**
   * 子弹:一种"会产生子弹的塔型"一个容器,取舍与上面的敌人分型完全一致。
   * 下标不是 towerType 而是 slot —— 六种塔里只有三种真的打出子弹(光束/链电/磁轨是瞬时判定),
   * 为另外三种留空容器等于白挂三个只会被遍历、永远为空的对象。towerType → slot 走 bulletSlot。
   */
  private bulletSlot: number[] = [];
  private bulletPcs: ParticleContainer[] = [];
  private bulletParticles: Particle[][] = [];
  private bulletTextures: Texture[] = [];
  /** 炮位贴图(下标 === towerType):装填/重建时按 type 直取,与敌人纹理同一套加载契约 */
  private towerTextures: readonly (Texture | null)[] = [];
  /** 星级炮位贴图(下标 === towerType,内层 0..2 === 1★..3★),与图鉴同源。 */
  private towerStarTextures: readonly (readonly (Texture | null)[])[] = [];
  /** 下标 = slot,取 tint 用(冷色域,GDD §12) */
  private bulletDefs: TowerDef[] = [];
  private bulletBuckets: Bullet[][] = [];
  /**
   * 残骸掉落物(10 号 issue T4)。经验残骸一个容器:形状恒为菱形、颜色恒为 DROP_TINT。
   * 磁吸宝物(26 号改)另开一个容器(dropOrbPc):形状/颜色/个头都不同,
   * 与经验残骸分桶后各自整池直接喂,免得每帧给粒子改 tint/texture(它们是静态属性,改了要重传)。
   */
  private dropPc: ParticleContainer;
  private dropParticles: Particle[] = [];
  private dropTexture: Texture;
  private dropOrbPc: ParticleContainer;
  private dropOrbParticles: Particle[] = [];
  private dropOrbTexture: Texture;
  /** 分桶暂存:每帧清空重灌(与 bulletBuckets 同款),整帧复用、零分配 */
  private dropXpBucket: Drop[] = [];
  private dropOrbBucket: Drop[] = [];
  /**
   * 敌方弹丸(22 号)。与残骸同款"一个容器就够":全场只有孢子一种弹,
   * 形状(发光球)与 tint(enemyTint(KIND_SPORE) 暖红紫)都只有一份,不必分桶。
   */
  private sporeBulletPc: ParticleContainer;
  private sporeBulletParticles: Particle[] = [];
  private sporeBulletTexture: Texture;
  /** Boss 巨大慢速激光球:独立纹理/容器,否则同一张 5px 孢子球无法表达它的体量。 */
  private bossLaserPc: ParticleContainer;
  private bossLaserParticles: Particle[] = [];
  private bossLaserTexture: Texture;
  /** 敌方弹丸分桶暂存,数组整帧复用避免每帧分配。 */
  private sporeBulletBucket: EnemyBullet[] = [];
  private bossLaserBucket: EnemyBullet[] = [];
  /** 巨大球的短能量尾迹,挂在球体之下,让“激光球”而不是普通大圆点一眼成立。 */
  private bossLaserTrailG = new Graphics();
  /**
   * 开火光效层(05 号 T5)。挂在 **worldLayer** 而不是 shipG:FxEvent 的坐标是**世界坐标**
   * (命中点在敌人身上,不在船上),挂进船体局部空间会让整条光束跟着船转 —— 船一转,
   * 上一帧打出去的光束就会甩到别处去。
   */
  private fxG = new Graphics();
  /** 真弹丸的逐星尾迹/迫击炮环绕微光:压在弹体粒子之下,每帧 clear 后按现存弹丸程序化重画。 */
  private bulletTrailG = new Graphics();
  /** 炮口闪专层：压在船体之上；其余命中/弹道 FX 仍在船体之下，不能反过来糊住自己的船。 */
  private muzzleFxG = new Graphics();
  /**
   * 伤害飘字层(畅玩性)。挂在 **worldLayer**、世界坐标:命中点在哪字就飘在哪。
   */
  private dmgG = new Container();
  /** 飘字池:Text 是昂贵视图(一个 = 一张离屏画布),64 格构造时一次建齐、环形复用 ——
   *  命中路上绝不 new(铁律 3);数组序 = 生成序,环形游标绕一圈正好先碰到最旧的 */
  private dmgSlots: DmgSlot[] = [];
  /** 飘字环形游标:下一格写哪。池满时顶掉游标所指的那格 = 全场最旧的一格 */
  private dmgCursor = 0;
  /** 本渲染帧已新飘的个数,drawFx 开头清零:每帧 DMG_SPAWN_CAP 封顶(8 杀/秒也不堆字) */
  private dmgSpawnedThisFrame = 0;
  /** 沉船爆炸演出剩余秒;>0 = 演出中,逐渲染帧减 dt(纯表现,main 侧读 SHIP_DEATH_FX_TIME 延迟结算) */
  private deathLeft = 0;
  private deathFull = SHIP_DEATH_FX_TIME;
  /** 爆炸锚点(世界坐标):触发那一刻的船心,整场演出钉死不动(沉船帧后世界即冻结) */
  private deathX = 0;
  private deathY = 0;
  /** 爆炸层:扩散环(Graphics)+ 碎片池,整局复用,演出外整层隐藏(与 dmgG 同为最高层读数) */
  private deathLayer = new Container();
  private deathG = new Graphics();
  private deathDebris: DeathDebris[] = [];
  private telegraphG: Graphics;
  /**
   * 地图商店信标(用户设计会):一枚脉冲的菱形 + 一圈接触判定环 + 屏边指示箭头。
   * 独立一层而不是并进 telegraphG:预告层每帧 clear 后按敌人重画,而信标是**世界里的一个地点**,
   * 两者的生命周期不同(一个逐帧、一个 30 秒),混在一起迟早互相清掉。
   */
  private beaconG: Graphics;
  /**
   * 船体容器:壳图 / 程序化船身 / 真实炮头 / 炮位状态 / 射界扇形 / 节流读数全部画在
   * 船体局部空间,它自己每帧只吃插值位姿(见文件头)——"炮头与船体一同旋转"由此在结构上成立。
   */
  private shipG = new Container();
  /** 固定核心舰壳图(生成图):承载装甲侧裙/推进器,整局一张 Sprite */
  private hullArtG = new Container();
  /** 程序化船身兜底(生成图缺失时可见;构造时画一次,固定船壳运行期零重建) */
  private hullG = new Graphics();
  /** 舰壳图是否加载成功:失败时用 hullG 的程序化船身兜底(generatedAssets 的兜底契约) */
  private hasHullArt = false;
  /** 炮头贴图层:随槽位内容重建(Sprite/色块只在装填那一下增删),瞄准每帧只改已有精灵 */
  private weaponG = new Container();
  private weaponBindings: WeaponBinding[] = [];
  /**
   * 炮位内容的脏标记签名:4 个槽的 type 压进一个数(每槽 4 位)。type 只在获得/替换/合成
   * 时变,故签名不变就绝不重建;重开换世界由 setWorld 置 -1 强制首帧重建(与旧 deckRevision 同一条纪律)。
   */
  private weaponSig = '';
  /** 射界扇形 + 判定圆(按住 Tab):压在船体之下 —— 它是底衬,不许糊住船身与炮位 */
  private arcG = new Graphics();
  /**
   * 炮位状态层:点防扫描环与 3★ 充能聚焦。真实炮管已经在贴图里,这里不再画常驻方向线。
   * 它与扇形分层,因为扇形只在 Tab 时画,状态读数却需要随炮头每帧更新。
   */
  private weaponStateG = new Graphics();
  /**
   * 节流读数(05 号 T5)。与炮位状态分开一层的理由同源:弹夹/热量/充能**每一逻辑帧都在变**。
   */
  private throttleG = new Graphics();
  /** 射界叠加层开关:main.ts 每渲染帧灌 input.isDown('Tab') */
  private arcOverlay = false;
  /** 详细射界上一帧是否画过:退出 Tab 时 clear 一次即可,不让隐藏层每帧空转 */
  private arcDrawn = false;
  /** 节流读数上一帧是否画过：回到战斗态时只 clear 一次，不让隐藏层每帧空转。 */
  private throttleDrawn = false;
  /** 程序化星野(无限地图的方位参照)。变换由 sync 与镜头同步 */
  private readonly starfield = new Starfield();
  /** Boss 出场的屏幕空间背景色相层:压在星野/世界之下,只改背景,绝不把敌我轮廓一起染色。 */
  private readonly bossEntranceG = new Graphics();
  /** Boss 出场演出剩余秒;阶段沿触发后由渲染帧 dt 自持,不进 checksum。 */
  private bossEntranceLeft = 0;
  /** 震屏(纯表现,渲染层自持):trauma 衰减 + 相位推进,结果直接加进镜头位置 */
  private shakeTrauma = 0;
  private shakePhase = 0;
  private shakeX = 0;
  private shakeY = 0;

  /**
   * 玩家设置的两个表现开关(ui/settings.ts 的 shake / damageNumbers,经 setEffects 灌进来)。
   * 初值 = 出厂设置 = 这两样功能上线时原本写死的行为:设置系统即使一次都没被调用过,
   * 渲染层的表现也与从前逐帧一致(设置不该在"没人碰过它"的时候改变任何东西)。
   */
  private shakeScale = 1;
  private showDamageNumbers = true;

  /**
   * 加速技能表现(畅玩性):尾焰画在船体局部空间(跟着船转),拖尾画在世界空间
   * (甩在身后的才叫尾迹)。trail 是定长环形缓冲,构造时一次建齐(铁律 3);
   * lastBoostTime 是点火的沿检测基准 —— boostTime 只在触发那一帧上跳,其余帧单调递减。
   */
  private boostFlameG = new Graphics();
  private boostTrailG = new Graphics();
  private boostTrail: { x: number; y: number; life: number }[] = [];
  private lastBoostTime = 0;

  /**
   * 精英出场预警的去重键(segment × ELITE_WARN_KEY_STRIDE + eliteNext;哨兵 -1 = 无预警)。
   * 预警窗口持续 ELITE_WARN_LEAD 秒,同一只精英只该在**进窗那一帧**响一次 ——
   * 键不变就绝不重复发声;精英出生(eliteNext 前移)或换段后键变,下一只进窗照常响。
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
   * 环阵 burst 预警层(25 号):挂在 stage(屏幕空间),与 eliteWarnG / bossWarnG 同一条口径 ——
   * 全环脉冲是 HUD 级读数(方向箭头对环阵无意义:没有来向),不被镜头缩放/平移带着走。
   * 每帧 clear 后按需重画,整局一层复用。
   */
  private readonly burstRingG = new Graphics();
  /**
   * Boss 出场演出的去重锁:阶段(0/1/2)的上次可见值。只在 bossPhase 从别的值翻进 1 的
   * 那一帧启动音频 / 震屏 / 背景色相 —— 渲染帧与逻辑帧不同步(120Hz 屏上同一逻辑帧会被采样
   * 两次),不锁存就会把一次出场当成两次。初值 -1:重开换世界后第一帧必与 0 不同,
   * 但 bossWarnOnEnter(-1, 0) 为 false,不会误触发。
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
    this.towerStarTextures = generatedArt.towerStars;

    if (this.backgroundSprite) {
      this.backgroundSprite.anchor.set(0.5);
      this.backgroundSprite.alpha = 0.9;
    }

    // 固定舰壳图:整局一张 Sprite,尺寸按 tuning 船体包围盒 + 垫边(旧参数原样保留)
    this.hasHullArt = !!generatedArt.shipHull;
    if (generatedArt.shipHull) {
      const hull = new Sprite(generatedArt.shipHull);
      hull.anchor.set(0.5);
      hull.width = tuning.shipLength + CELL * SHIP_HULL_LENGTH_PAD;
      hull.height = tuning.shipWidth + CELL * SHIP_HULL_WIDTH_PAD;
      this.hullArtG.addChild(hull);
    }
    // 程序化船身兜底:生成图缺失时可见(固定船壳 → 构造时画一次,运行期零重建)
    this.hullG.visible = !this.hasHullArt;

    // 地图无限,粒子容器的 boundsArea 给一个"永远罩住镜头"的巨矩形:它只是让 Pixi 免算
    // 逐粒子包围盒,不参与任何逐粒子裁剪 —— 船开出几个场半径之外,千只虫子不会一帧集体消失。
    const bounds = new Rectangle(-1e8, -1e8, 2e8, 2e8);
    const dyn = { position: true, rotation: false, color: false };

    // —— 关键取舍:四型 = 四个 ParticleContainer,而不是塞进同一个容器按型换色/换形 ——
    // ParticleContainer 整个容器只绑一张纹理,想按型换形状就得上图集 + 把 uvs 设成 dynamic;
    // 更要命的是池用 swap-remove 回收,粒子↔实体的下标映射每帧都在变,单容器按型上色就必须
    // 把 color 设成 dynamic —— 那等于每帧为全部 1000 个粒子重传颜色缓冲,而这些值其实
    // 一辈子不变。分容器的代价只是多 3 个 draw call,GPU 侧可忽略。故 dynamicProperties
    // 保持只有 position 是动态的,每帧只重传位置,tint 与纹理都退化成建粒子时上传一次的静态属性。
    //
    // 敌人容器例外三项(程序化动画,取舍见 ENEMY_ANIM 的注释):
    //   vertex: true —— 呼吸 = 逐帧改 scaleX/scaleY,scale 烤在四角顶点里,不重传就看不见;
    //   rotation: true —— 摆动/自转逐帧改角度;
    //   color: true —— 受击闪白(畅玩性)要逐粒子改 tint,不开这一项 tint 只在建粒子时上传一次。
    // 子弹/残骸仍是原样(纯静态属性),四型敌人多付出的只是本就逐帧上传的缓冲。
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
          // 蜂群蛭也要自转(口器绕圈 = 活着),故敌人容器一律开 rotation + vertex(见上注释);
          // color 供受击闪白逐粒子改 tint(见上注释)
          dynamicProperties: { ...dyn, rotation: true, vertex: true, color: true },
          boundsArea: bounds,
          texture: tex,
        }),
      );
      this.enemyParticles.push([]);
      this.enemyBuckets.push([]);
      // 精英容器与普通型同纹理同 dynamicProperties,唯一差别是 sync 时传进去的静态缩放
      this.elitePcs.push(
        new ParticleContainer({
          dynamicProperties: { ...dyn, rotation: true, vertex: true, color: true },
          boundsArea: bounds,
          texture: tex,
        }),
      );
      this.eliteParticles.push([]);
      this.eliteBuckets.push([]);

      // —— 骨架(24 号):这一型有骨架表且部件图齐全,就建骨架层,否则留 null 走上面那条单件贴图路 ——
      // baseScale 把单位空间(512)映到与单件贴图**完全相同**的世界视觉跨度:
      // 单件路是 128px 纹理 → generatedEnemySpan,而 128 纹理像素就是 512 单位,于是同一个尺寸。
      // 换骨架不改这一型多大 —— 一次只改一件事(它现在会动了),不顺手动尺寸。
      const rig = ENEMY_RIGS[k] ?? null;
      const rigParts = generatedArt.enemyRigParts[k] ?? null;
      if (rig && rigParts && rigParts.length === rig.textureCount) {
        const rigScale = generatedEnemySpan(def) / RIG_UNIT;
        this.enemyRigLayers.push(new RigLayer(rig, rigParts, bounds, rigScale));
        this.eliteRigLayers.push(
          new RigLayer(rig, rigParts, bounds, rigScale * ELITE.scale * ELITE_VISUAL_SCALE),
        );
      } else {
        this.enemyRigLayers.push(null);
        this.eliteRigLayers.push(null);
      }
    }

    // —— Boss(15 号):round-7 的母巢整图 + 拆件骨架,缺件时回退整图 ——
    // 静态缩放使剪影外接半径 = bossRadius()(sim/boss.ts 的唯一口径),
    // 判定体多大画多大 —— 与"灰盒阶段视觉 = 判定"同一条口径,换不换贴图都不动摇
    const bossGenerated = generatedArt.boss ?? null;
    const bossTex = bossGenerated ?? this.enemyTextures[BOSS.baseKind]!;
    this.bossTexture = bossTex;
    // 回退底座纹理时它可能是程序化剪影(需要上底座 tint);专属图与生成图一律白 tint 原色
    this.bossTextureTint = bossGenerated ? 0xffffff : this.enemyTextureTints[BOSS.baseKind]!;
    this.bossTextureScale = (bossRadius() * 2 * BOSS_VISUAL_SCALE) / Math.max(bossTex.width, bossTex.height);
    this.bossRotationOffset = bossGenerated
      ? GENERATED_ART_FORWARD_OFFSET
      : this.enemyRotationOffsets[BOSS.baseKind]!;
    this.bossPc = new ParticleContainer({
      dynamicProperties: { ...dyn, rotation: true, vertex: true, color: true },
      boundsArea: bounds,
      texture: bossTex,
    });
    const bossRigParts = generatedArt.bossRigParts;
    if (bossRigParts && bossRigParts.length === RIG_BOSS.textureCount) {
      const bossRigScale = (bossRadius() * 2 * BOSS_VISUAL_SCALE) / RIG_UNIT;
      this.bossRigLayer = new RigLayer(RIG_BOSS, bossRigParts, bounds, bossRigScale);
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
    // 磁吸宝物(26 号改):同款做法、独立容器 —— 六角金色,与经验菱形分家
    this.dropOrbTexture = app.renderer.generateTexture({
      target: buildMagnetOrbShape(),
      resolution: 2,
      antialias: true,
    });
    this.dropOrbPc = new ParticleContainer({
      dynamicProperties: dyn,
      boundsArea: bounds,
      texture: this.dropOrbTexture,
    });

    // 敌方弹丸:同一套粒子做法,单容器就够(理由见 sporeBulletPc 字段注释)。
    this.sporeBulletTexture = app.renderer.generateTexture({
      target: buildSporeBulletShape(),
      resolution: 2,
      antialias: true,
    });
    this.sporeBulletPc = new ParticleContainer({
      dynamicProperties: dyn,
      boundsArea: bounds,
      texture: this.sporeBulletTexture,
    });
    this.bossLaserTexture = app.renderer.generateTexture({
      target: buildBossLaserBallShape(),
      resolution: 2,
      antialias: true,
    });
    this.bossLaserPc = new ParticleContainer({
      dynamicProperties: dyn,
      boundsArea: bounds,
      texture: this.bossLaserTexture,
    });

    // 冲锋前摇的指示层:每帧 clear 后重画(几何逐帧变)
    this.telegraphG = new Graphics();
    this.beaconG = new Graphics();

    // 船体 = shipG 一个容器:七个子层装进一个容器,容器负责"跟着船走",子层只管局部几何。
    // 子层序:射界扇形(底衬)→ 加速尾焰(长在船尾、压不住船身)→ 舰壳图 → 程序化船身兜底
    // → 炮位贴图 → 炮位状态读数 → 节流读数。
    // 扇形画在船体之下:它是底衬,不许糊住船身与炮位;状态读数长在炮位上,理应压住贴图。
    // 这里不建炮位几何 —— 槽位内容要等 sync() 的签名检查在首帧补上(weaponSig = -1)。
    this.shipG.addChild(this.arcG, this.boostFlameG, this.hullArtG, this.hullG, this.weaponG, this.weaponStateG, this.throttleG);
    // 拖尾环形缓冲一次建齐(铁律 3):life ≤ 0 = 空闲槽,运行期只改字段
    for (let i = 0; i < BOOST_TRAIL_MAX; i++) this.boostTrail.push({ x: 0, y: 0, life: 0 });

    // 层序:前摇指示 → 敌(按 kind 顺序,后面的型压住前面的:冲撞甲虫排最后,
    // 不会被蜂群蛭糊掉)→ Boss(最大的个体,压在全部普通/精英剪影之上)
    // → 残骸 → 弹 → 开火光效 → 船体 → 炮口闪。
    // 指示层压在敌人之下:锁定线不该糊住甲虫自己的剪影。
    // 光效排在弹之后、船体之前:它是"这一发打出去了"的读数,压住敌人才看得见命中在谁身上,
    // 但绝不许盖住船身与炮位(节流读数与炮位状态在那上面)。
    // 船体压在敌与弹之上,千敌贴脸时自己的船不会被糊掉;
    // 残骸排在**敌之上、弹之下**:压在敌之下的话,残骸一掉出来就被它自己那堆虫子埋了,
    // 而"残骸正往船上飞"是这一局经济在转的唯一读数。
    // 飘字与爆炸层压在一切世界层之上(包括船体与炮口闪):"这一发多痛 / 船没了"是
    // 场上优先级最高的两类读数。
    this.worldLayer.addChild(this.telegraphG);
    // 信标压在预告之上、敌剪影之下:它是"这里有个地点"的读数,不该糊住虫群,
    // 但也不能被一层虫子完全埋掉(埋掉就等于这一轮商店不存在)
    this.worldLayer.addChild(this.beaconG);
    // 骨架型与单件型混排在同一段层序里:骨架型加的是它那几个部件容器(数组下标即画序,
    // 小的在后面 —— 侧掠者的尾尖在最底、头在最上),单件型仍是一个容器。
    // 未接骨架的型的单件容器照旧加进来(它永远是空的,不会双重绘制,见 enemyRigLayers 注释)。
    for (let k = 0; k < this.enemyPcs.length; k++) {
      this.worldLayer.addChild(this.enemyPcs[k]!);
      const rl = this.enemyRigLayers[k];
      if (rl) for (const pc of rl.containers) this.worldLayer.addChild(pc);
    }
    // 精英容器压在普通型之上:大个体不该被身后小个体的剪影啃掉边(与"甲虫排最后"同一条取舍)
    for (let k = 0; k < this.elitePcs.length; k++) {
      this.worldLayer.addChild(this.elitePcs[k]!);
      const rl = this.eliteRigLayers[k];
      if (rl) for (const pc of rl.containers) this.worldLayer.addChild(pc);
    }
    // Boss 容器压在一切敌剪影之上:骨架齐全时整图容器保持空,部件容器按画序叠上来。
    this.worldLayer.addChild(this.bossPc);
    if (this.bossRigLayer) {
      for (const pc of this.bossRigLayer.containers) this.worldLayer.addChild(pc);
    }
    this.worldLayer.addChild(this.dropPc);
    // 磁吸宝物(26 号改)紧跟经验残骸:同一层带,宝物压在上——"特别的那一颗"读得出来
    this.worldLayer.addChild(this.dropOrbPc);
    this.worldLayer.addChild(this.sporeBulletPc);
    this.worldLayer.addChild(this.bossLaserTrailG);
    this.worldLayer.addChild(this.bossLaserPc);
    this.worldLayer.addChild(this.bulletTrailG);
    for (let s = 0; s < this.bulletPcs.length; s++) this.worldLayer.addChild(this.bulletPcs[s]!);
    // 加速拖尾压在开火光效之下、弹之上:它是船自己的航迹,不该糊住"这一发打中了"的读数
    this.worldLayer.addChild(this.boostTrailG);
    this.worldLayer.addChild(this.fxG, this.shipG, this.muzzleFxG);
    this.worldLayer.addChild(this.dmgG, this.deathLayer);

    // —— 伤害飘字池:Text 昂贵(建一个 = 一张离屏画布),故 64 格一次建齐、整局复用,
    // 命中时只改 text/tint/position(铁律 3)。共享同一份样式(白 fill),颜色走 tint 乘出来 ——
    // tint 是逐格属性,改一格不影响其它格(改 style.fill 则是共享样式,一格变色全池变色)
    for (let i = 0; i < DMG_POOL_SIZE; i++) {
      const text = new Text({
        text: '',
        anchor: 0.5,
        resolution: 2, // 2x 离屏渲染:字号只有 10 世界 px,1x 会被镜头放大成马赛克
        style: {
          fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace',
          fontSize: DMG_FONT_SIZE,
          fontWeight: 'bold',
          fill: 0xffffff,
          stroke: { color: 0x000000, width: 2 }, // 黑描边:数字压在虫潮上也要读得出
        },
      });
      text.visible = false;
      this.dmgG.addChild(text);
      this.dmgSlots.push({ text, active: false, x: 0, y: 0, life: 0, full: DMG_LIFE });
    }

    // —— 沉船爆炸层:环 + 碎片全部预建,触发时只改状态(演出是一次性事件,但对象绝不现造) ——
    this.deathLayer.addChild(this.deathG);
    for (let i = 0; i < DEATH_DEBRIS_COUNT; i++) {
      // 碎片取船体本色(明面/亮边交替):炸出去的就是自己的船,颜色 = 残骸的语汇
      const g = new Graphics().rect(-1.6, -1.6, 3.2, 3.2).fill(i % 2 === 0 ? SHIP_FILL : SHIP_EDGE);
      g.visible = false;
      this.deathLayer.addChild(g);
      this.deathDebris.push({ g, vx: 0, vy: 0, spin: 0, life: 0, full: DEATH_DEBRIS_LIFE });
    }
    this.deathLayer.visible = false;

    // Boss 色相层压在静态远景之上、星野之下:它只给“宇宙底色”换一拍紫红,
    // 星野与战场实体仍保留自己的冷/暖色域,不被整屏滤镜糊成一色。
    if (this.backgroundSprite) app.stage.addChild(this.backgroundSprite);
    app.stage.addChild(
      this.bossEntranceG,
      ...this.starfield.views,
      this.worldLayer,
      this.eliteWarnG,
      this.bossWarnG,
      this.burstRingG,
    );
  }

  /**
   * 每渲染帧调用。alpha ∈ [0,1):在上一逻辑帧与当前逻辑帧之间插值。
   * 船体位姿(shipG)、镜头与一切世界层实体都取样同一个插值结果(铁律 2)。
   */
  sync(alpha: number): void {
    const screen = this.app.screen;

    // 船的插值位姿:镜头与船体都取样它。直接用 ship.x/heading 会让整个画面按 60Hz 台阶抖(铁律 2)
    const ship = this.world.ship;
    const sx = ship.px + (ship.x - ship.px) * alpha;
    const sy = ship.py + (ship.y - ship.py) * alpha;
    // 朝向必须沿最短弧插值:线性插值一旦跨过 ±π 边界,船头会反向甩一整圈
    const sh = lerpAngle(ship.pheading, ship.heading, alpha);

    // dt 取渲染帧的实际间隔(不是 SIM_DT):震屏/飘字/爆炸演出都在渲染层自持,与逻辑帧率无关
    const dt = Math.min(this.app.ticker.deltaMS / 1000, MAX_RENDER_DT);
    // Boss 阶段沿要在背景与镜头之前消费:触发这一帧立刻换色、立刻给震屏入账,不晚一帧。
    this.stepBossEntrance(dt);
    this.syncBackground(screen.width, screen.height, sx, sy);
    this.syncBossEntranceBackground(screen.width, screen.height);

    // 镜头(GDD §3.3):战斗态缩放由"船占屏高比例"反推,固定不变 ——
    // 随速度变焦会让"船身长度"这个唯一的距离参照失效,射界判断也就没了标尺。
    // 船是固定船壳(不再有可扩建的甲板),故缩放是常数,也没有"甲板视图放大"这回事。
    const scale = (screen.height * tuning.cameraShipHeightFraction) / tuning.shipLength;
    this.worldLayer.scale.set(scale);
    // pivot 落在船前方 → 船被推到屏幕后半区,腾出的视野正是要转过去的方向
    const pivotX = sx + Math.cos(sh) * ((screen.height * tuning.cameraLookAhead) / scale);
    const pivotY = sy + Math.sin(sh) * ((screen.height * tuning.cameraLookAhead) / scale);
    this.worldLayer.pivot.set(pivotX, pivotY);

    // 程序化动画时钟与缓动同一份 dt:掉帧时一次多走一段,总节奏不变
    this.animClock += dt;
    // 震屏 / 飘字 / 爆炸演出都是渲染层自持的计时(同一份 dt):
    // 时停/结算期间照走 —— 死亡爆炸要的就是"世界冻住、碎片继续飞"的反差
    this.stepShake(dt);
    this.stepDmgNumbers(dt);
    this.stepDeathFx(dt);
    // 加速表现(尾焰 + 拖尾 + 点火震屏)也是渲染层自持:读的只有 world.boostTime 一个数
    this.stepBoostFx(dt, sx, sy, sh);
    // 震屏直接加在镜头的屏幕位置上:worldLayer 无旋转,世界系的方向向量与屏幕系一一对应
    this.worldLayer.position.set(screen.width / 2 + this.shakeX, screen.height / 2 + this.shakeY);

    // 屏外剔除的视图矩形(世界系,含缓冲带):分桶前算一次,热循环里每只怪只付 4 个比较。
    // 前摇中的怪不受此限(见分桶循环):锁定线是屏外可读性承诺,不随距离熄灭。
    viewCullRect(
      scale,
      pivotX,
      pivotY,
      screen.width / 2 + this.shakeX,
      screen.height / 2 + this.shakeY,
      screen.width,
      screen.height,
      CULL_MARGIN,
      cullRectScratch,
    );

    // 星野与镜头同一帧同一组变换(含震屏):它是世界锚定的背景,镜头动它就得动
    this.starfield.sync(
      scale,
      pivotX,
      pivotY,
      screen.width / 2 + this.shakeX,
      screen.height / 2 + this.shakeY,
      screen.width,
      screen.height,
    );

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
      // 屏外剔除:怪在视图缓冲带外就不画(不进桶 → 粒子留在 OFFSCREEN 停车位)。
      // 前摇中的怪除外:它的锁定线是"待会儿只撞这条线上"的屏外承诺(GDD §6 前摇必须可读),
      // 怪在屏外、冲刺线却照常压进屏 —— 把前摇怪也剔了,线会在怪进屏前凭空消失。
      if (
        e.state !== ST_WINDUP &&
        (e.x < cullRectScratch.minX ||
          e.x > cullRectScratch.maxX ||
          e.y < cullRectScratch.minY ||
          e.y > cullRectScratch.maxY)
      ) {
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
    this.drawEliteAuras(alpha);
    for (let k = 0; k < buckets.length; k++) {
      const def = ENEMIES[k]!;
      const bucket = buckets[k]!;
      const eliteBucket = this.eliteBuckets[k]!;
      const rigLayer = this.enemyRigLayers[k];
      const eliteRigLayer = this.eliteRigLayers[k];
      if (rigLayer && eliteRigLayer) {
        // 骨架型:整型改走部件路径,上面那套单件容器一个粒子都不建(syncParticles 按需扩容,不调它就是空的)
        rigLayer.sync(bucket, alpha, this.animClock, sx, sy, rigDriver);
        eliteRigLayer.sync(eliteBucket, alpha, this.animClock, sx, sy, eliteRigDriver);
      } else {
        const targetFacing =
          def.kind === KIND_STRAFER
            ? this.enemyRotationOffsets[k] === 0
              ? STRAFER_SHAPE_TARGET_FACING
              : STRAFER_ART_TARGET_FACING
            : undefined;
        this.syncParticles(this.enemyParticles[k]!, this.enemyPcs[k]!, bucket, {
          texture: this.enemyTextures[k]!,
          tint: this.enemyTextureTints[k]!,
          scale: this.enemyTextureScales[k]!,
          rotationOffset: def.shape === 'circle' ? undefined : this.enemyRotationOffsets[k],
          anim: ENEMY_ANIM[k]!,
          alpha,
          flashBase: this.enemyTextureTints[k]!,
          targetFacing,
          targetX: sx,
          targetY: sy,
        });
        // 精英:sim 判定体放大之外再加纯视觉放大与金橙滤色,永久光环由 drawEliteAuras 画在底层。
        this.syncParticles(this.eliteParticles[k]!, this.elitePcs[k]!, eliteBucket, {
          texture: this.enemyTextures[k]!,
          tint: ELITE_TINT,
          scale: this.enemyTextureScales[k]! * ELITE.scale * ELITE_VISUAL_SCALE,
          rotationOffset: def.shape === 'circle' ? undefined : this.enemyRotationOffsets[k],
          anim: ENEMY_ANIM[k]!,
          alpha,
          flashBase: ELITE_TINT,
          targetFacing,
          targetX: sx,
          targetY: sy,
        });
      }
      // 前摇指示按型共享配额:精英与普通怪同型,合起来不能超过一型的预算
      let budget = TELEGRAPH_MAX_PER_KIND;
      budget = this.drawTelegraph(bucket, def, alpha, budget);
      this.drawTelegraph(eliteBucket, def, alpha, budget);
      // 孢子蓄力预警(22 号)与冲锋前摇共用同一块 telegraphG 与同一份配额:
      // 两种"环合拢即发作"的读数在画面上互斥共存,不该各自无上限地画
      budget = this.drawSporeTelegraph(bucket, def, alpha, budget);
      this.drawSporeTelegraph(eliteBucket, def, alpha, budget);
    }
    // Boss:优先走 round-7 母巢骨架；任一部件加载失败才整型回退到专属整图。
    if (this.bossRigLayer) {
      this.bossRigLayer.sync(this.bossBucket, alpha, this.animClock, sx, sy, bossRigDriver);
    } else {
      this.syncParticles(this.bossParticles, this.bossPc, this.bossBucket, {
        texture: this.bossTexture,
        tint: this.bossTextureTint,
        scale: this.bossTextureScale,
        rotationOffset: this.bossRotationOffset,
        anim: ENEMY_ANIM[BOSS.baseKind]!,
        alpha,
        flashBase: this.bossTextureTint,
      });
    }
    this.drawBossTelegraph(alpha, sx, sy);

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
    this.drawBulletTrails(alpha);
    for (let s = 0; s < bBuckets.length; s++) {
      this.syncParticles(this.bulletParticles[s]!, this.bulletPcs[s]!, bBuckets[s]!, {
        texture: this.bulletTextures[s]!,
        tint: this.bulletDefs[s]!.tint,
        alpha,
      });
    }

    // 敌方弹丸(22 号):按来源分桶。普通孢子仍走 5px 小球;Boss 的 KIND_BOSS
    // 单独走 32px 巨型激光球纹理,避免用同一粒子纹理把两种威胁画成同一个尺寸。
    this.sporeBulletBucket.length = 0;
    this.bossLaserBucket.length = 0;
    const enemyBullets = this.world.enemyBullets.items;
    for (let i = 0; i < enemyBullets.length; i++) {
      const bullet = enemyBullets[i]!;
      if (bullet.kind === KIND_BOSS) this.bossLaserBucket.push(bullet);
      else this.sporeBulletBucket.push(bullet);
    }
    // 与敌人粒子同一套 alpha 插值:普通弹丸 220px/s,60Hz 逻辑帧在 144Hz 屏上不插值就是顿挫
    this.syncParticles(this.sporeBulletParticles, this.sporeBulletPc, this.sporeBulletBucket, {
      texture: this.sporeBulletTexture,
      tint: enemyTint(KIND_SPORE), // 暖红紫:与冷色我方弹道一眼分家(GDD §12)
      alpha,
    });
    this.syncParticles(this.bossLaserParticles, this.bossLaserPc, this.bossLaserBucket, {
      texture: this.bossLaserTexture,
      tint: BOSS_LASER_TINT,
      alpha,
    });
    this.drawBossLaserTrails(alpha);

    // 掉落物按 kind 分桶后整桶喂(磁吸宝物与经验残骸纹理/tint/个头都不同):
    // 与它们同一套 syncParticles ⇒ 一并吃 alpha 插值:磁吸段每秒 300px,不插值就是一串跳点
    this.dropXpBucket.length = 0;
    this.dropOrbBucket.length = 0;
    const dropItems = this.world.drops.items;
    for (let i = 0; i < dropItems.length; i++) {
      const d = dropItems[i]!;
      (d.kind === DROP_KIND_MAGNET ? this.dropOrbBucket : this.dropXpBucket).push(d);
    }
    this.syncParticles(this.dropParticles, this.dropPc, this.dropXpBucket, {
      texture: this.dropTexture,
      tint: DROP_TINT,
      alpha,
    });
    this.syncParticles(this.dropOrbParticles, this.dropOrbPc, this.dropOrbBucket, {
      texture: this.dropOrbTexture,
      tint: MAGNET_ORB_TINT,
      scale: MAGNET_ORB_SCALE,
      alpha,
    });

    // 开火光效:瞬时判定的四类全在这一层。**不插值**(见 drawFx)
    this.drawFx(sh);

    // 船体:炮位只在槽位内容变化时重建(签名检查),炮头旋转与炮位状态每帧同步,
    // 容器只吃插值位姿,子层几何一律是局部坐标 —— 船与炮位一同旋转由此成立(见文件头)
    this.drawShopBeacon(sx, sy);
    this.syncWeaponSprites();
    this.syncWeaponRotations();
    this.drawSlotWeaponState();
    if (this.arcOverlay) {
      // 按住 Tab:射界扇形 + 判定圆 + 节流读数一起出现(全部读同一个 arcOverlay,
      // 不会出现"松了 Tab 但读数还挂着"的半套状态)
      this.drawSlotArcs();
      this.drawSlotThrottle();
      this.arcDrawn = true;
      this.throttleDrawn = true;
    } else {
      // 退出 Tab 时各 clear 一次就够:整局绝大多数帧没有扇形可画,不让隐藏层每帧空转
      if (this.arcDrawn) {
        this.arcG.clear();
        this.arcDrawn = false;
      }
      if (this.throttleDrawn) {
        this.throttleG.clear();
        this.throttleDrawn = false;
      }
    }
    this.shipG.position.set(sx, sy);
    this.shipG.rotation = sh;

    // 精英出场预警(出生前 ~2s):屏幕空间一层,读 wave 的只读游标 —— 零 rng、零状态改动,
    // 只把脚本里早就写着的事提前念给玩家听。放在帧末:镜头/船体变换都已落地。
    this.syncEliteWarning(sx, sy);
    // 环阵 burst 预警(25 号):同上,屏幕空间一层,读 world.burstWarning 的只读读数 ——
    // 方向流不画(那是 HUD 箭头的事),只有下一个 burst 是环阵时才亮全环脉冲
    this.syncBurstRingWarning(sx, sy);
    // Boss 战提示(出场音 + 召唤预告,15 号):同上,屏幕空间一层,读 world 的 bossPhase /
    // bossSummonCooldown —— 零 rng、零状态改动,只把 sim 里早就写着的事念给玩家听。
    this.syncBossWarn(sx, sy, alpha);
  }

  /**
   * 画布像素 → 世界坐标。普通世界交互的统一入口。
   * 走 worldLayer.toLocal:镜头怎么变(缩放、震屏)这里都不用改。
   * out 由调用方给,零分配(铁律 3)。
   */
  screenToWorld(sx: number, sy: number, out: Vec2): Vec2 {
    screenPos.x = sx;
    screenPos.y = sy;
    return this.worldLayer.toLocal(screenPos, undefined, out);
  }

  /**
   * 射界叠加层开关(GDD §4.2:**按住** Tab 显示,不是 toggle,所以这里收的是"键此刻是否按着"
   * 而不是一次按键事件)。渲染层不 import core/input —— 键盘状态由 main.ts 每渲染帧灌进来,
   * (输入/ui → render,render 不反向依赖)。
   */
  setArcOverlay(on: boolean): void {
    this.arcOverlay = on;
  }

  /**
   * 灌一份玩家的表现设置(ui/settings.ts)。**只收纯表现的两项**:震屏强度与伤害飘字 ——
   * 它们既不进 checksum、也不改变 sim 的任何判定,故设置页随便怎么拨都动不了
   * "同 seed + 同输入 → 同轨迹"这条口径(音量归 audioBus,顿帧归 main,各有各的落点)。
   * 幂等且便宜(两次赋值),设置页每次改动直接整份重灌,不必算增量。
   * @param shake 0..1,0 = 完全静止(调用方已夹取,这里再夹一次:渲染层不信任何外部读数)
   */
  setEffects(shake: number, damageNumbers: boolean): void {
    this.shakeScale = Number.isFinite(shake) ? Math.min(1, Math.max(0, shake)) : 1;
    this.showDamageNumbers = damageNumbers;
  }

  /**
   * 换掉整个 World(08 号 issue T3 的重开流程 —— 验收标准原文:一局从开始到胜利/失败/重开
   * **全流程无需刷新页面**)。重开一律是"换一个新 World",而不是给 World 加 reset():
   * 池、rng、tick、槽位全是新的,才谈得上"同 seed 可复现"(旧世界跑过的随机数一个都不许留)。
   *
   * 于是渲染层这边要作废的,只有**跨 World 就会说谎的缓存**:
   *   weaponSig:新世界的 4 个武器槽从空槽起步,不置 -1 就会与上一局最后那个签名撞上 ——
   *     炮位于是停在上一局的武器,而且再也不会自己好起来(脏标记的判据是"变了没有",
   *     不是"是不是同一艘船";与旧 deckRevision 同一条理由);
   *   eliteWarnKey / bossPhaseSeen:新 World 的 segment/eliteNext/bossPhase 从 0 起,
   *     留着旧键会让新局第一只精英/Boss 被误判成"已经响过"(哨兵 -1 首帧必过比较、不误响);
   *   飘字与爆炸演出是**上一局**的表现,换世界当场清空(尤其沉船爆炸,新一局的船好好的,
   *   不许再炸一遍);炮口闪同理清掉(坐标属于上一局的世界空间,清掉防残影)。
   * 其余脏标记 arcDrawn / throttleDrawn 是**自愈的**,这里一个字都不必写:
   * 条件(按住 Tab)一旦不成立,对应的 draw* 会 clear 一次再落回 false ——
   * 新局第一帧就把上一局的残影抹干净了。
   */
  setWorld(world: World): void {
    this.world = world;
    this.weaponSig = '';
    this.muzzleFxG.clear();
    this.bulletTrailG.clear();
    this.eliteWarnKey = -1;
    this.bossPhaseSeen = -1;
    this.bossEntranceLeft = 0;
    this.bossEntranceG.clear();
    if (this.backgroundSprite) this.backgroundSprite.tint = 0xffffff;
    this.shakeTrauma = 0;
    this.shakeX = 0;
    this.shakeY = 0;
    // 飘字与爆炸演出是**上一局**的表现,换世界当场清空
    for (let i = 0; i < this.dmgSlots.length; i++) {
      const s = this.dmgSlots[i]!;
      s.active = false;
      s.life = 0;
      s.text.visible = false;
    }
    this.dmgCursor = 0;
    this.deathLeft = 0;
    this.deathLayer.visible = false;
    this.deathG.clear();
    // 加速表现同属上一局:尾焰/拖尾当场清,点火沿检测基准回 0(新世界 boostTime 必然是 0)
    this.lastBoostTime = 0;
    this.boostFlameG.clear();
    this.boostTrailG.clear();
    for (let i = 0; i < this.boostTrail.length; i++) this.boostTrail[i]!.life = 0;
  }

  /**
   * 炮位贴图:只随槽位内容变化重建(8 槽 type 的签名检查)。获得/替换/合成时才分配 Sprite;
   * 平常战斗帧只由 syncWeaponRotations 改已有精灵的 rotation,兜底色块完全静态。
   * 某一型贴图没加载到时,在同一位置画一块按型色块兜底(generatedAssets 的契约:坏一张图
   * 不该让那个炮位在画面上消失)。
   */
  private syncWeaponSprites(): void {
    const w = this.world.weapons;
    let sig = '';
    for (let i = 0; i < WEAPON_SLOT_COUNT; i++) {
      const slot = w[i]!;
      const t = slot.type;
      const stars = Math.max(0, Math.min(STAR_MAX, Math.floor(slot.stars)));
      sig += `${t < 0 ? -1 : t}:${stars};`;
    }
    if (sig === this.weaponSig) return;
    this.weaponSig = sig;

    const old = this.weaponG.removeChildren();
    for (let i = 0; i < old.length; i++) old[i]!.destroy();
    this.weaponBindings.length = 0;

    for (let i = 0; i < WEAPON_SLOT_COUNT; i++) {
      const slot = w[i]!;
      if (slot.type < 0) continue;
      const def = TOWERS[slot.type];
      const hp = WEAPON_HARDPOINTS[i];
      // 数值表/硬点表写坏:这一个槽不画,不炸掉整局(noUncheckedIndexedAccess 也逼着判)
      if (!def || !hp) continue;
      const size = SLOT_GLYPH;
      const stars = Math.max(1, Math.min(STAR_MAX, Math.floor(slot.stars)));
      const starSet = this.towerStarTextures[slot.type];
      const tex = starSet?.[stars - 1] ?? this.towerTextures[slot.type];
      let g: Sprite | Graphics;
      if (tex) {
        const s = new Sprite(tex);
        s.anchor.set(0.5, TOWER_HEAD_ANCHOR_Y);
        const starScale = TOWER_STAR_HEAD_SCALES[stars - 1] ?? 1;
        s.scale.set((size * starScale) / Math.max(tex.width, tex.height));
        // round-8 是带材质与功能色的完整炮头,再乘 tint 会吃掉钢蓝层次和橙色警示纹。
        // 武器身份色仍由弹道、射界与节流读数取 def.tint 表达。
        s.tint = 0xffffff;
        s.position.set(hp.x, hp.y);
        g = s;
      } else {
        // 兜底色块:同色相,尺寸与贴图同档 —— 只在装填那一下分配,不进热路径(铁律 3 管的是逐帧)
        const fb = new Graphics().rect(-size / 2, -size / 2, size, size).fill(def.tint);
        fb.position.set(hp.x, hp.y);
        g = fb;
      }
      this.weaponG.addChild(g);
      this.weaponBindings.push({ slot: i, def, g });
    }
  }

  /**
   * 炮位贴图正面跟随 sim 的真实局部炮口角;世界朝向仍由 shipG.rotation 统一叠加。
   * 只遍历已存在的炮位(最多 8 项),不创建临时对象、不重算硬点。
   * 局部射界中心问 slotArc(heading 传 0):sim 存的是**相对射界中心**的偏角(slot.turretOffset),
   * 这里加一下就是船体局部朝向 —— 与 sim/armory 的 slotArcCenter 同一条算术,不必去追
   * ship.heading(那是 shipG 的 rotation 已经替我们做完的事)。
   */
  private syncWeaponRotations(): void {
    for (let k = 0; k < this.weaponBindings.length; k++) {
      const b = this.weaponBindings[k]!;
      if (!b.def || b.g instanceof Graphics) continue; // 兜底色块是静态的,不跟炮管转
      const slot = this.world.weapons[b.slot]!;
      slotArc(b.slot, 0, towerArcDeg(b.def, slot.stars), arcTmp);
      b.g.rotation = arcTmp.center + slot.turretOffset + GENERATED_ART_FORWARD_OFFSET;
    }
  }

  /**
   * 商店信标:世界里的一枚脉冲菱形 + 接触环;**船离得远时在屏边画一枚指向箭头**。
   * 箭头是这套设计成立的关键 —— 信标只活 30 秒且生成在 600..1400px 外,
   * 没有指向的话玩家得先绕一圈找它,那 30 秒就成了纯粹的运气。
   * 剩余时间靠**环的缺口**表达(走完一圈 = 到期):不印数字,读数由 HUD 那一行管,
   * 世界层只负责"它在那边、还剩多久"这两件事的空间表达。
   * @param sx/@param sy 船的插值位置(镜头同源;箭头挂在船周围一圈上,不是屏幕边缘的绝对像素)
   */
  private drawShopBeacon(sx: number, sy: number): void {
    const g = this.beaconG;
    g.clear();
    const w = this.world;
    if (!w.shopBeaconActive) return;
    const bx = w.shopBeaconX;
    const by = w.shopBeaconY;
    // 脉冲:1Hz 的呼吸,与预告层的闪烁同一条"程序化动画时钟"口径(animClock 随渲染帧走)
    const pulse = 0.75 + 0.25 * Math.sin(this.animClock * Math.PI * 2);
    const r = SHOP_BEACON_RADIUS;
    // 菱形本体(冷青:我方色域,GDD §12 —— 它是玩家的补给点,不是威胁)
    g.moveTo(bx, by - r * 0.5 * pulse)
      .lineTo(bx + r * 0.38 * pulse, by)
      .lineTo(bx, by + r * 0.5 * pulse)
      .lineTo(bx - r * 0.38 * pulse, by)
      .closePath()
      .fill({ color: BEACON_COLOR, alpha: 0.5 });
    // 与掉落物/击杀同一组轨道微粒 + 四向闪芒。慢速反转避免它读成敌方前摇的收缩环。
    drawStardustHalo(
      g,
      bx,
      by,
      r * (0.72 + pulse * 0.12),
      -this.animClock * 0.42,
      0.52 + pulse * 0.32,
      STARDUST_CORE_COLOR,
      STARDUST_WARM_COLOR,
    );
    // 信标亮核与磁吸宝物同语法:玩家余光先读到“星尘聚成一处”,再靠冷青色判断它是补给点。
    g.circle(bx, by, 2.2 + pulse * 1.4).fill({ color: STARDUST_CORE_COLOR, alpha: 0.9 });
    // 接触环 = 真判定半径(与 sim 那句 SHOP_BEACON_RADIUS + shipRadius 的前半段同源):
    // 画得比判定大或小都会让"明明碰到了却没进店"变成一个查不出的抱怨
    g.circle(bx, by, r).stroke({ width: 2, color: BEACON_COLOR, alpha: 0.55 * pulse });
    // 剩余时间环:按 ttl 比例画一段弧,走完一圈就是到期。
    // **arc 之前必须 moveTo 到弧起点**:Graphics 的路径是连续的,不挪笔的话它会从上一条
    // 子路径的收笔处拉一条直线连过来 —— 屏幕上就是一条横穿半个战场的青线
    const frac = Math.max(0, Math.min(1, w.shopBeaconTtl / SHOP_BEACON_LIFETIME));
    if (frac > 0) {
      const ringR = r + 6;
      g.moveTo(bx, by - ringR) // 弧起点 = -π/2 方向(正上),与下面那句的起始角同源
        .arc(bx, by, ringR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac)
        .stroke({ width: 3, color: BEACON_COLOR, alpha: 0.8 });
    }
    // 屏边指示箭头:离得近(判定环已经在视野里)就不画 —— 画面上同时有本体和箭头是噪声
    const dx = bx - sx;
    const dy = by - sy;
    const dist = Math.hypot(dx, dy);
    if (dist <= BEACON_ARROW_MIN_DIST) return;
    const ang = Math.atan2(dy, dx);
    const ax = sx + Math.cos(ang) * BEACON_ARROW_RADIUS;
    const ay = sy + Math.sin(ang) * BEACON_ARROW_RADIUS;
    const c = Math.cos(ang);
    const sn = Math.sin(ang);
    // 一枚朝向信标的实心三角(局部系:尖端 +X),按 ang 旋转到位
    g.moveTo(ax + c * 11, ay + sn * 11)
      .lineTo(ax - sn * 6 - c * 6, ay + c * 6 - sn * 6)
      .lineTo(ax + sn * 6 - c * 6, ay - c * 6 - sn * 6)
      .closePath()
      .fill({ color: BEACON_COLOR, alpha: 0.85 * pulse });
  }

  private drawSlotWeaponState(): void {
    const g = this.weaponStateG;
    g.clear();
    const w = this.world.weapons;
    // 真实炮管已经烤进 round-8 贴图;这里只保留少量逐星状态读数。
    for (let i = 0; i < WEAPON_SLOT_COUNT; i++) {
      const slot = w[i]!;
      const def = TOWERS[slot.type];
      const hp = WEAPON_HARDPOINTS[i];
      if (!def || !hp) continue;
      const stars = visualStarTier(slot.stars);
      slotArc(i, 0, towerArcDeg(def, slot.stars), arcTmp);
      const a = arcTmp.center + slot.turretOffset;

      if (stars >= 2 && isPointDefenseFamily(def.type)) {
        const scan = this.animClock * (stars === 3 ? 5.5 : 3.8) + i * 0.7;
        const r = stars === 3 ? 8.5 : 6.5;
        g.circle(hp.x, hp.y, r).stroke({
          width: stars === 3 ? 1.5 : 1,
          color: def.tint,
          alpha: stars === 3 ? 0.36 : 0.22,
        });
        g.moveTo(hp.x + Math.cos(scan) * r, hp.y + Math.sin(scan) * r)
          .arc(hp.x, hp.y, r, scan, scan + (stars === 3 ? Math.PI * 0.78 : Math.PI * 0.48))
          .stroke({ width: stars === 3 ? 2 : 1.4, color: FX_CORE_COLOR, alpha: 0.62 });
      }

      // 3★ 充能重武器在最后约 28% 充能段出现"向炮口收缩"的读数,不延迟真实开火。
      if (stars === 3 && def.throttle === THR_CHARGE && slot.charge > 0.72) {
        const q = clamp01((slot.charge - 0.72) / 0.28);
        const tipX = hp.x + Math.cos(a) * SLOT_EFFECT_TIP_LEN;
        const tipY = hp.y + Math.sin(a) * SLOT_EFFECT_TIP_LEN;
        const r = 11 - q * 7;
        g.circle(tipX, tipY, r).stroke({ width: 1.2 + q * 1.8, color: def.tint, alpha: 0.28 + q * 0.55 });
        for (let k = 0; k < 3; k++) {
          const p = this.animClock * 6 + (k / 3) * Math.PI * 2;
          g.circle(tipX + Math.cos(p) * r, tipY + Math.sin(p) * r, 1.1 + q * 0.8);
        }
        g.fill({ color: FX_CORE_COLOR, alpha: 0.5 + q * 0.42 });
        g.circle(tipX, tipY, 1.5 + q * 2.2).fill({ color: FX_CORE_COLOR, alpha: 0.72 + q * 0.25 });
      }
    }
  }

  /**
   * 射界叠加层(按住 Tab,GDD §4.2)。04 号的两条验收标准都由"画在船体局部空间 + 几何全问 sim"落实:
   *   一、"可视化与实际可命中区域一致":扇形的中心角/半角一律取自 sim 的 slotArc(heading 传 0
   *     就得到局部中心角),弧度与半径**逐塔**取 towerArcDeg / towerRange —— 这三个数正是 sim
   *     (sim/turret 的 slotArc + findArcTarget)索敌判定用的那三个,不是渲染层照着规则重推的第二份;
   *   二、"船旋转时射界实时跟随、无一帧延迟":整层挂在 shipG 下,吃的是与船体同一个插值位姿,
   *     于是"扇形跟着船转"与"船跟着航向转"在结构上就是同一件事,想差一帧都做不到。
   * 圆心 = 硬点(sim 索敌从硬点量距离,见 findArcTarget 的 ox/oy 注释),不是船心 ——
   * 舷侧槽与船心差着大半个船长,拿船心当圆心会把扇形的覆盖范围整体歪掉。
   * 判定圆与扇形同开同关(09 号 T4 验收点名):受击 = 船心圆,半径问 damage.shipRadius,
   * 渲染层一行判定几何都不许自己推。
   */
  private drawSlotArcs(): void {
    const g = this.arcG;
    g.clear();
    const w = this.world.weapons;
    let drawn = 0;
    for (let i = 0; i < WEAPON_SLOT_COUNT; i++) {
      const slot = w[i]!;
      if (slot.type < 0) continue;
      const def = TOWERS[slot.type];
      const hp = WEAPON_HARDPOINTS[i];
      if (!def || !hp) continue;
      slotArc(i, 0, towerArcDeg(def, slot.stars), arcTmp);
      const r = towerRange(def, slot.stars);
      g.moveTo(hp.x, hp.y)
        .arc(hp.x, hp.y, r, arcTmp.center - arcTmp.half, arcTmp.center + arcTmp.half)
        .closePath();
      drawn++;
    }
    // 全部槽攒成一条 path 只 fill + stroke 一次(照旧底板的写法):
    // 扇形是"我打得到哪里"的整体读数,不需要逐槽不同的表现
    if (drawn > 0) {
      g.fill({ color: SLOT_ARC_COLOR, alpha: SLOT_ARC_FILL_ALPHA }).stroke({
        width: SLOT_ARC_WIDTH,
        color: SLOT_ARC_COLOR,
        alpha: SLOT_ARC_STROKE_ALPHA,
      });
    }
    // 判定体轮廓:船心圆(sim/damage 的 shipRadius 是全仓唯一口径,渲染层不自己推第二份)
    g.circle(0, 0, shipRadius(tuning.shipLength)).stroke({
      width: HULL_CORE_WIDTH,
      color: HULL_HIT_COLOR,
      alpha: HULL_CORE_ALPHA,
    });
  }

  /**
   * 槽位节流读数(05 号 issue T5 验收:"三种节流机制在 UI 上可读 —— 弹夹数 / 热量条 / 充能环")。
   * 每帧 clear 后重画,**不做脏标记**:弹夹/热量/充能每一逻辑帧都在变,压根没有可缓存的余地
   * (与每帧现算的 Tab 扇形同一条取舍)。
   * 四槽各三四条几何指令,与 Tab 扇形同量级 —— 500 弹那条性能口径在别处(粒子容器),不在这里。
   * 只画已填的槽(type ≥ 0):空槽没有节流可言;数值表里查不到的槽一并跳过
   * (noUncheckedIndexedAccess 也逼着判)。
   * 三种机制各自的形状与位置见文件上方 THR_* 那段;等级点三种塔共用同一处(硬点船尾侧),
   * 于是"这门炮几级"永远在同一个地方读,不必先认出它挂的是哪一套节流。
   *
   * 分母一律走 sim/tower 的 slot* 包装(slotReload / slotHeatMax):支援聚合与法令把装填时长 /
   * 热上限改了之后,拿裸 def 当分母的条会在真装完/真锁死之前就走满,然后停在顶上等 ——
   * "读数与 sim 用的必须是同一个数"是 05 号那三套读数的立身之本
   * (分子 slot.ammo/heat/charge 本就是 sim 写的,分母再抄一份迟早走散)。
   */
  private drawSlotThrottle(): void {
    const g = this.throttleG;
    g.clear();
    const w = this.world.weapons;
    // 法令聚合已含散热协议的热上限倍率:与 sim/turret 的 onFired 同一个分母,热条才画得准
    const buffs = this.world.buffs;
    for (let i = 0; i < WEAPON_SLOT_COUNT; i++) {
      const slot = w[i]!;
      if (slot.type < 0) continue;
      const def = TOWERS[slot.type];
      const hp = WEAPON_HARDPOINTS[i];
      if (!def || !hp) continue;
      // 读数锚点 = 硬点朝船头前移一档:别盖住炮位贴图本身(与旧"读数贴格边"同一层取舍)
      const cx = hp.x + THR_GAUGE_OFF;
      const cy = hp.y;
      const color = def.tint;
      switch (def.throttle) {
        case THR_AMMO: {
          // 弹夹条:沿 +Y(右舷)增长。装填期间 sim 侧的 ammo 恒 0(见 sim/tower 的状态机:
          // 打空即进装填,装填完毕才一次性填满),故"空槽 + 一条推进中的冷白进度"
          // 正好读成"正在把弹夹填回去",两条读数各占一半时间、绝不同时出现
          const x = cx - THR_BAR_THICK / 2;
          const y0 = cy - THR_BAR_LEN / 2;
          g.rect(x, y0, THR_BAR_THICK, THR_BAR_LEN).fill({
            color: THR_TRACK_COLOR,
            alpha: THR_TRACK_ALPHA,
          });
          const cap = towerMagazine(def, slot.stars);
          const ammo = cap > 0 ? clamp01(slot.ammo / cap) : 0;
          if (ammo > 0) g.rect(x, y0, THR_BAR_THICK, THR_BAR_LEN * ammo).fill(color);
          // 分母走 sim/tower 的 slotReload(而不是裸 def.reload):弹药库把装填时间乘短了,
          // 拿基准值当分母,进度条会在真装完之前就走满,然后停在顶上等 —— 读数与实际节奏当场对不上
          const reload = slotReload(slot, def, buffs);
          if (slot.reloadLeft > 0 && reload > 0) {
            const t = clamp01(1 - slot.reloadLeft / reload);
            if (t > 0) {
              g.rect(x, y0, THR_BAR_THICK, THR_BAR_LEN * t).fill({
                color: FX_CORE_COLOR,
                alpha: THR_RELOAD_ALPHA,
              });
            }
          }
          break;
        }
        case THR_HEAT: {
          // 热量条:沿 +X(船头)增长 —— 与弹夹条**正交**,两者绝不会被读成同一种东西
          const y = cy - THR_BAR_THICK / 2;
          const x0 = cx - THR_BAR_LEN / 2;
          g.rect(x0, y, THR_BAR_LEN, THR_BAR_THICK).fill({
            color: THR_TRACK_COLOR,
            alpha: THR_TRACK_ALPHA,
          });
          // 上限走 sim/tower 的 slotHeatMax(而不是裸 towerHeatMax):散热协议把上限抬高之后,
          // 拿基准值当分母的热量条会在塔还远没锁死时就画满 —— 而"收支平衡点"正是过热系的全部手感,
          // 读数与 sim 用的必须是同一个数(理由同上面那条 slotReload)
          const max = slotHeatMax(slot, def, buffs);
          const t = max > 0 ? clamp01(slot.heat / max) : 0;
          // 过热锁死:整条满长闪暖红。暖色是敌人的色域(GDD §12),故只许**这么小一条、这么短一阵**,
          // 而且必须是"闪"不是常亮 —— 常亮的暖条等于在自家船上钉死一块假的敌方色。
          // 闪灭的那个半周期照常画真实热量,于是"锁死中"与"还在降温"两条信息都读得到
          if (slot.coolLock > 0 && Math.floor(slot.coolLock * THR_OVERHEAT_BLINK_HZ) % 2 === 0) {
            g.rect(x0, y, THR_BAR_LEN, THR_BAR_THICK).fill(THR_DENY_COLOR);
          } else if (t > 0) {
            g.rect(x0, y, THR_BAR_LEN * t, THR_BAR_THICK).fill(color);
          }
          break;
        }
        case THR_CHARGE: {
          // 充能环:三种读数里唯一的圆。从**船头方向**(局部角 0)起手扫,起点是个固定的锚,
          // 于是"扫过了多少"一眼估得出来,不必先去猜这一圈是从哪儿开始的
          const r = THR_RING_RADIUS;
          g.circle(cx, cy, r).stroke({
            width: THR_RING_WIDTH,
            color: THR_TRACK_COLOR,
            alpha: THR_RING_TRACK_ALPHA,
          });
          const t = clamp01(slot.charge);
          if (t > 0) {
            // 必须先 moveTo 到弧的起点:Pixi 的 arc 会从"当前点"连一条线过来,
            // 而上一句 stroke 之后当前点还停在槽底圆的收尾处 —— 少这一句就会多出一条从环上甩出去的线
            g.moveTo(cx + r, cy)
              .arc(cx, cy, r, 0, t * Math.PI * 2)
              .stroke({ width: THR_RING_WIDTH, color });
          }
          if (t >= 1) {
            // 满充:再描一圈冷白芯。"攒满了在等目标"与"还在攒"是两种状态(见 sim/tower:
            // 无目标也照常蓄、满 1.0 就停在那里等),读数分不开的话充能塔看上去永远在原地转圈
            g.circle(cx, cy, r).stroke({ width: THR_RING_FULL_WIDTH, color: FX_CORE_COLOR });
          }
          break;
        }
        default:
          break; // 认不出的节流档只是不画读数,不炸掉整层(与敌人 kind 越界同一条兜底口径)
      }

      // 星级点(星级系统:1★..3★):三种机制共用同一处 —— 硬点船尾侧,沿 +Y 居中排开。
      // 用点数而不是数字:炮位旁边能塞进去的字号已经小到认不出是几,而三个点数得清。
      // 上限夹在 STAR_MAX:数据表被改坏也不该排出炮位一档
      const stars = Math.min(Math.max(Math.floor(slot.stars), 0), STAR_MAX);
      if (stars > 0) {
        const x = hp.x - THR_GAUGE_OFF;
        const y0 = hp.y - ((stars - 1) * THR_LEVEL_DOT_GAP) / 2;
        for (let k = 0; k < stars; k++) g.circle(x, y0 + k * THR_LEVEL_DOT_GAP, THR_LEVEL_DOT_R);
        // 攒成一条 path 一次填充:星级点是一组读数,不需要逐点不同的表现
        g.fill(FX_CORE_COLOR);
      }
    }
  }

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
   * FxEvent 不背这个数(见 sim/fx.ts 的字段表),只能顺着 towerType 在武器槽里反查;
   * 最多 8 个槽,逐事件扫一遍的开销可忽略。查不到(槽已换装/表被改坏)退回 1:
   * 音频宁可恒常也不哑火。
   * 分母与节流读数同一条口径(slotHeatMax,含法令倍率;充能直接读 slot.charge)。
   */
  private shootThrottle(towerType: number, def: TowerDef): number {
    const w = this.world.weapons;
    for (let i = 0; i < w.length; i++) {
      const slot = w[i]!;
      if (slot.type !== towerType) continue;
      switch (def.throttle) {
        case THR_HEAT: {
          const max = slotHeatMax(slot, def, this.world.buffs);
          return max > 0 ? clamp01(slot.heat / max) : 1;
        }
        case THR_CHARGE:
          return clamp01(slot.charge);
        default:
          return 1;
      }
    }
    return 1;
  }

  /** FxEvent 携带星级时优先使用快照；旧事件/弹道命中事件回查当前槽位作为兼容兜底。 */
  private fxStarsForTower(towerType: number): number {
    for (let i = 0; i < WEAPON_SLOT_COUNT; i++) {
      const slot = this.world.weapons[i];
      if (slot && slot.type === towerType) return Math.max(1, Math.min(STAR_MAX, Math.floor(slot.stars)));
    }
    return 1;
  }

  /**
   * 升星结算的专属爆发几何。基础武器与对应合成武器共用一条视觉语汇：
   * 激光变粗、电弧分叉、磁轨裂纹、迫击炮扩散环；未知塔型退回通用星芒。
   * 这段只读 FxEvent，不写 sim 状态，且所有随机性都由固定角度构成，回放不会漂移。
   */
  private drawStarUpgradeBurst(
    g: Graphics,
    e: { x0: number; y0: number; towerType: number },
    heading: number,
    stars: number,
    t: number,
    tint: number,
  ): void {
    const cx = e.x0;
    const cy = e.y0;
    const r = FX_STAR_UPGRADE_R0 + (FX_STAR_UPGRADE_R1 - FX_STAR_UPGRADE_R0) * (1 - t);
    const alpha = t * 0.9;
    const isLaser = e.towerType === TOWER_LASER || e.towerType === TOWER_AURORA;
    const isArc = e.towerType === TOWER_ARC || e.towerType === TOWER_THUNDER;
    const isRail = e.towerType === TOWER_RAILGUN || e.towerType === TOWER_ANNIHILATION;
    const isMortar = e.towerType === TOWER_MORTAR || e.towerType === TOWER_DELUGE;

    if (isLaser) {
      // "变粗":四条互相垂直的能量轴，中心段宽、边缘快速收细。
      const half = r * (0.35 + 0.18 * stars);
      for (let k = 0; k < 4; k++) {
        const a = heading + (k * Math.PI) / 2;
        const dx = Math.cos(a) * half;
        const dy = Math.sin(a) * half;
        g.moveTo(cx - dx, cy - dy).lineTo(cx + dx, cy + dy);
      }
      g.stroke({ width: (FX_STAR_UPGRADE_BURST_WIDTH + stars * 1.4) * t, color: tint, alpha });
      g.circle(cx, cy, r * 0.2).fill({ color: FX_CORE_COLOR, alpha: alpha * 0.95 });
      return;
    }

    if (isArc) {
      // "电弧分叉":四条主枝在中段各自再分成两叉。
      const branch = r * (0.62 + stars * 0.08);
      for (let k = 0; k < 4; k++) {
        const a = heading + (k * Math.PI) / 2 + Math.PI / 4;
        const mx = cx + Math.cos(a) * branch * 0.46;
        const my = cy + Math.sin(a) * branch * 0.46;
        for (let f = -1; f <= 1; f += 2) {
          const endA = a + f * 0.34;
          g.moveTo(cx, cy).lineTo(mx, my).lineTo(cx + Math.cos(endA) * branch, cy + Math.sin(endA) * branch);
        }
      }
      g.stroke({ width: Math.max(1.4, FX_STAR_UPGRADE_BURST_WIDTH * 0.72) * t, color: tint, alpha });
      return;
    }

    if (isRail) {
      // "磁轨裂纹":从核心向外的四组不规则折线，像装甲被贯穿后裂开。
      const crack = r * (0.72 + stars * 0.06);
      for (let k = 0; k < FX_STAR_UPGRADE_CRACK_COUNT; k++) {
        const a = heading + (k / FX_STAR_UPGRADE_CRACK_COUNT) * Math.PI * 2;
        const p1 = crack * 0.38;
        const p2 = crack * 0.67;
        const wiggle = (k % 2 === 0 ? 1 : -1) * 0.14;
        g.moveTo(cx, cy)
          .lineTo(cx + Math.cos(a + wiggle) * p1, cy + Math.sin(a + wiggle) * p1)
          .lineTo(cx + Math.cos(a - wiggle) * p2, cy + Math.sin(a - wiggle) * p2)
          .lineTo(cx + Math.cos(a + wiggle * 0.5) * crack, cy + Math.sin(a + wiggle * 0.5) * crack);
      }
      g.stroke({ width: Math.max(1.5, FX_STAR_UPGRADE_BURST_WIDTH * 0.82) * t, color: tint, alpha });
      return;
    }

    if (isMortar) {
      // "迫击炮环":多层落点环，逐层向外扩散，和 AoE 的落点语汇保持一致。
      g.circle(cx, cy, r * 0.46).stroke({ width: 2.4 + stars * 0.5, color: tint, alpha: alpha * 0.8 });
      g.circle(cx, cy, r * 0.74).stroke({ width: 2 + stars * 0.4, color: FX_CORE_COLOR, alpha: alpha * 0.72 });
      g.circle(cx, cy, r).stroke({ width: 1.6 + stars * 0.35, color: tint, alpha: alpha * 0.62 });
      return;
    }

    // 其它型号(机炮、点防、合成塔)保留通用星芒作为安全兜底。
    for (let k = 0; k < stars + 2; k++) {
      const a = (k / (stars + 2)) * Math.PI * 2 + heading;
      const inner = r * 0.55;
      const outer = r * (1.08 + 0.12 * t);
      g.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner)
        .lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
    }
    g.stroke({ width: 2, color: tint, alpha: alpha * 0.8 });
  }

  /**
   * 真实弹丸的逐星尾迹。按「塔型桶 × 星级」合并路径后一次 stroke:
   * 500 弹压测下最多几十次描边,不会退化成每颗弹一次 Graphics 提交。
   * 迫击炮的环绕微光同样只画表现,不生成 Bullet、不参与碰撞。
   */
  private drawBulletTrails(alpha: number): void {
    const g = this.bulletTrailG;
    g.clear();

    for (let s = 0; s < this.bulletBuckets.length; s++) {
      const bucket = this.bulletBuckets[s]!;
      const def = this.bulletDefs[s]!;
      for (let tier = 1 as 1 | 2 | 3; tier <= 3; tier = (tier + 1) as 1 | 2 | 3) {
        let paths = 0;
        const pointDefense = isPointDefenseFamily(def.type);
        const mortar = def.fx === FX_MORTAR;
        const lengthMul = pointDefense ? 0.72 : mortar ? 1.25 : 1;
        const len = BULLET_TRAIL_LENGTH[tier] * lengthMul;

        for (let i = 0; i < bucket.length; i++) {
          const b = bucket[i]!;
          if (visualStarTier(b.stars) !== tier) continue;
          const speed = Math.hypot(b.vx, b.vy);
          if (speed <= 0) continue;
          const x = b.px + (b.x - b.px) * alpha;
          const y = b.py + (b.y - b.py) * alpha;
          const ux = b.vx / speed;
          const uy = b.vy / speed;
          g.moveTo(x - ux * len, y - uy * len).lineTo(x, y);
          paths++;
        }
        if (paths > 0) {
          g.stroke({
            width: BULLET_TRAIL_WIDTH[tier],
            color: def.tint,
            alpha: BULLET_TRAIL_ALPHA[tier],
          });
        }

        // 2★/3★ 再描一条冷白细芯:宽晕交代能量量级,细芯交代真实运动方向。
        if (tier >= 2 && paths > 0) {
          for (let i = 0; i < bucket.length; i++) {
            const b = bucket[i]!;
            if (visualStarTier(b.stars) !== tier) continue;
            const speed = Math.hypot(b.vx, b.vy);
            if (speed <= 0) continue;
            const x = b.px + (b.x - b.px) * alpha;
            const y = b.py + (b.y - b.py) * alpha;
            const core = len * (tier === 3 ? 0.78 : 0.62);
            g.moveTo(x - (b.vx / speed) * core, y - (b.vy / speed) * core).lineTo(x, y);
          }
          g.stroke({
            width: BULLET_TRAIL_CORE_WIDTH,
            color: FX_CORE_COLOR,
            alpha: tier === 3 ? 0.92 : 0.72,
          });
        }

        if (!mortar || tier < 2) continue;
        let motes = 0;
        let rings = 0;
        for (let i = 0; i < bucket.length; i++) {
          const b = bucket[i]!;
          if (visualStarTier(b.stars) !== tier) continue;
          const x = b.px + (b.x - b.px) * alpha;
          const y = b.py + (b.y - b.py) * alpha;
          const count = tier === 3 ? MORTAR_ORBIT_PARTICLES : 2;
          const phase = this.animClock * (tier === 3 ? 5.2 : 3.6) + b.x * 0.003 + b.y * 0.002;
          // 最后 180ms 把环绕光点吸回弹芯:不延迟真实落点，只给 3★ 爆炸补上“压缩 → 爆发”的前半拍。
          const landingScale = 0.25 + 0.75 * clamp01(b.life / 0.18);
          for (let k = 0; k < count; k++) {
            const a = phase + (k / count) * Math.PI * 2;
            const r = MORTAR_ORBIT_RADIUS * (tier === 3 ? 1 : 0.72) * landingScale;
            g.circle(x + Math.cos(a) * r, y + Math.sin(a) * r, tier === 3 ? 1.35 : 1);
            motes++;
          }
          if (tier === 3) {
            g.circle(x, y, (5.5 + Math.sin(phase * 0.7) * 0.8) * landingScale);
            rings++;
          }
        }
        if (motes > 0) g.fill({ color: FX_CORE_COLOR, alpha: tier === 3 ? 0.9 : 0.65 });
        if (rings > 0) g.stroke({ width: 1.2, color: def.tint, alpha: 0.52 });
      }
    }
  }

  /** Boss 巨大慢速球的能量尾迹:只画表现,位置/命中仍完全由 sim 的 EnemyBullet 决定。 */
  private drawBossLaserTrails(alpha: number): void {
    const g = this.bossLaserTrailG;
    g.clear();
    const bucket = this.bossLaserBucket;
    for (let i = 0; i < bucket.length; i++) {
      const b = bucket[i]!;
      const x = b.px + (b.x - b.px) * alpha;
      const y = b.py + (b.y - b.py) * alpha;
      const speed = Math.hypot(b.vx, b.vy);
      if (speed <= 1e-6) continue;
      const ux = b.vx / speed;
      const uy = b.vy / speed;
      const len = 42 + Math.min(28, speed * 0.12);
      g.moveTo(x - ux * len, y - uy * len).lineTo(x, y);
    }
    if (bucket.length > 0) {
      g.stroke({ width: 7, color: BOSS_LASER_TINT, alpha: 0.22 });
      // 细白芯与大球的中心高光同源,不把尾迹画成一条纯色实线。
      for (let i = 0; i < bucket.length; i++) {
        const b = bucket[i]!;
        const x = b.px + (b.x - b.px) * alpha;
        const y = b.py + (b.y - b.py) * alpha;
        const speed = Math.hypot(b.vx, b.vy);
        if (speed <= 1e-6) continue;
        const ux = b.vx / speed;
        const uy = b.vy / speed;
        const len = 30 + Math.min(18, speed * 0.08);
        g.moveTo(x - ux * len, y - uy * len).lineTo(x, y);
      }
      g.stroke({ width: 1.8, color: 0xffffff, alpha: 0.58 });
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
   * 与塔数同量级(十几个到几十个),与 500 弹那条口径不在一个数量级上,故不设配额上限。
   * @param heading 船的插值朝向(铁律 2):FXV_RESONANCE 的舷侧弧光朝
   *   WEAPON_SLOT_FACING[中心槽] + heading 铺开,用插值角才不按 60Hz 逻辑帧台阶抖。
   */
  private drawFx(heading: number): void {
    const g = this.fxG;
    g.clear();
    const muzzleG = this.muzzleFxG;
    muzzleG.clear();
    // 每帧飘字配额清零:同帧的事件再多也只新飘 DMG_SPAWN_CAP 个(见 spawnDmgNumber)
    this.dmgSpawnedThisFrame = 0;
    const items = this.world.fx.items;
    for (let i = 0; i < items.length; i++) {
      const e = items[i]!;
      // 色相 = 哪座塔打的(与它的子弹同色,一眼认得出是哪门炮);查不到就退回冷色兜底,
      // 绝不让暖色漏进我方光效(GDD §12 的敌我色域分离不可破)
      const def = TOWERS[e.towerType];
      // 开火音:开火事件是"这一帧发生了什么"的表现层读数,音频照同一批事件发声 ——
      // 节流值从武器槽反查(事件不带 throttle),音频引擎自带同族限流,蜂群贴脸不糊成一片
      const playAudio = !e.audioPlayed;
      if (playAudio) e.audioPlayed = true;
      // 飘字:一次性消费锁与音频/震屏各管各的 —— 飘字生命周期(0.6s)比事件(0.1-0.25s)长,
      // 必须在事件还活着时取出;同帧重复采样(120Hz 屏)也由这把锁挡住,一个字只飘一次
      if (!e.dmgPlayed) {
        e.dmgPlayed = true;
        if (e.damage > 0) this.spawnDmgNumber(e.kind, e.x0, e.y0, e.damage, e.dmgRatio);
      }
      const family = this.shootFamily(e.kind);
      if (playAudio && family) audioBus.playShoot(family, def ? this.shootThrottle(e.towerType, def) : 1);
      const color = def ? def.tint : FX_TINT_FALLBACK;
      switch (e.kind) {
        case FXV_BEAM: {
          // 细实线 + **常亮**:激光是 10Hz 的伤害 tick + 每帧续命的可视化(见 05 设计约定),
          // 按 life 线性淡出会把"持续光束"画成一闪一闪的虚线 —— 那正好毁掉它与另外三类的区别
          const star = visualStarTier(e.stars > 0 ? e.stars : this.fxStarsForTower(e.towerType));
          const t = fxFade(e.life, fxLifeForStars(e.kind, star));
          const starMul = star <= 1 ? 1 : star === 2 ? 1.55 : 2.2;
          const dx = e.x1 - e.x0;
          const dy = e.y1 - e.y0;
          const len = Math.hypot(dx, dy);
          if (star >= 2 && len > 0) {
            const nx = -dy / len;
            const ny = dx / len;
            const offset = star === 3 ? 4.5 : 2.5;
            for (let side = -1; side <= 1; side += 2) {
              g.moveTo(e.x0 + nx * offset * side, e.y0 + ny * offset * side)
                .lineTo(e.x1 + nx * offset * side, e.y1 + ny * offset * side);
            }
            g.stroke({
              width: star === 3 ? 2 : 1.2,
              color,
              alpha: (star === 3 ? 0.36 : 0.25) * t,
            });
          }
          g.moveTo(e.x0, e.y0)
            .lineTo(e.x1, e.y1)
            .stroke({ width: FX_BEAM_GLOW_WIDTH * starMul, color, alpha: FX_BEAM_GLOW_ALPHA * t });
          g.moveTo(e.x0, e.y0)
            .lineTo(e.x1, e.y1)
            .stroke({
              width: FX_BEAM_CORE_WIDTH * (star <= 1 ? 1 : star === 2 ? 1.25 : 1.6),
              color: FX_CORE_COLOR,
              alpha: FX_BEAM_CORE_ALPHA_FLOOR + (1 - FX_BEAM_CORE_ALPHA_FLOOR) * t,
            });
          if (star === 3 && len > 0) {
            // 三颗能量节沿判定线稳定流向目标;只画表现,不新增伤害 tick。
            const phase = (this.animClock * 0.9 + e.x0 * 0.0017 + e.y0 * 0.0011) % 1;
            for (let k = 0; k < 3; k++) {
              const f = (phase + k / 3) % 1;
              g.circle(e.x0 + dx * f, e.y0 + dy * f, 1.5 + 0.8 * t);
            }
            g.fill({ color: FX_CORE_COLOR, alpha: 0.72 * t });
            // 炮口三片光阑 + 命中日冕:建立 3★ 激光自己的几何签名。
            const base = Math.atan2(dy, dx);
            for (let k = 0; k < 3; k++) {
              const a = base + (k / 3) * Math.PI * 2;
              g.moveTo(e.x0 + Math.cos(a) * 3, e.y0 + Math.sin(a) * 3)
                .lineTo(e.x0 + Math.cos(a) * 9, e.y0 + Math.sin(a) * 9);
            }
            g.stroke({ width: 1.5, color: FX_CORE_COLOR, alpha: 0.7 * t });
            const corona = 5 + Math.sin(this.animClock * 9) * 1.2;
            g.circle(e.x1, e.y1, corona).stroke({ width: 2, color, alpha: 0.58 * t });
          }
          break;
        }
        case FXV_CHAIN: {
          // 一跳一个事件,首尾相接自然连成整条链;折角是它与光束唯一的形状差别,故必须画
          const star = visualStarTier(e.stars > 0 ? e.stars : this.fxStarsForTower(e.towerType));
          const t = fxFade(e.life, fxLifeForStars(e.kind, star));
          if (star >= 2) {
            this.strokeChainHop(
              e.x0,
              e.y0,
              e.x1,
              e.y1,
              color,
              (star === 3 ? 0.34 : 0.22) * t,
              star === 3 ? 3.8 : 2.8,
              -0.52,
            );
          }
          if (star === 3) {
            this.strokeChainHop(e.x0, e.y0, e.x1, e.y1, color, 0.32 * t, 5.2, 1);
          }
          this.strokeChainHop(
            e.x0,
            e.y0,
            e.x1,
            e.y1,
            star === 3 ? FX_CORE_COLOR : color,
            FX_CHAIN_ALPHA * t * (star >= 3 ? 1.18 : star === 2 ? 1.08 : 1),
            star === 3 ? 2.4 : FX_CHAIN_WIDTH,
            1,
          );
          if (star >= 2) {
            const nodeR = star === 3 ? 4.5 : 2.8;
            g.circle(e.x1, e.y1, nodeR).stroke({ width: star === 3 ? 1.8 : 1.2, color, alpha: 0.7 * t });
            if (star === 3) {
              for (let k = 0; k < FX_STAR_DIRS.length; k += 2) {
                const dx = FX_STAR_DIRS[k]! * nodeR * 1.8;
                const dy = FX_STAR_DIRS[k + 1]! * nodeR * 1.8;
                g.moveTo(e.x1, e.y1).lineTo(e.x1 + dx, e.y1 + dy);
              }
              g.stroke({ width: 1.1, color: FX_CORE_COLOR, alpha: 0.54 * t });
            }
          }
          break;
        }
        case FXV_LANCE: {
          // 唯一"越来越细"的一类:光柱随 life 从 FX_LANCE_WIDTH 收成一条芯线,
          // 读起来就是"贯穿的那一瞬间已经过去,现在只剩余波"
          const lanceStars = visualStarTier(e.stars > 0 ? e.stars : this.fxStarsForTower(e.towerType));
          const t = fxFade(e.life, fxLifeForStars(e.kind, lanceStars));
          const dx = e.x1 - e.x0;
          const dy = e.y1 - e.y0;
          const len = Math.hypot(dx, dy);
          const nx = len > 0 ? -dy / len : 0;
          const ny = len > 0 ? dx / len : 0;
          if (lanceStars >= 2 && len > 0) {
            const offset = lanceStars === 3 ? 8 : 4.5;
            for (let side = -1; side <= 1; side += 2) {
              g.moveTo(e.x0 + nx * offset * side, e.y0 + ny * offset * side)
                .lineTo(e.x1 + nx * offset * side, e.y1 + ny * offset * side);
            }
            g.stroke({
              width: lanceStars === 3 ? 3.2 : 1.8,
              color,
              alpha: (lanceStars === 3 ? 0.28 : 0.2) * t,
            });
          }
          g.moveTo(e.x0, e.y0)
            .lineTo(e.x1, e.y1)
            .stroke({
              // 下限夹在芯线宽度上:光晕收得比芯线还细就不再是光晕了,让它平滑地退化成芯线本身
              width: Math.max(FX_LANCE_CORE_WIDTH, FX_LANCE_WIDTH * (lanceStars <= 1 ? 1 : lanceStars === 2 ? 1.35 : 1.8) * t),
              color,
              alpha: FX_LANCE_ALPHA * t,
            });
          g.moveTo(e.x0, e.y0)
            .lineTo(e.x1, e.y1)
            .stroke({ width: lanceStars === 3 ? 3.2 : FX_LANCE_CORE_WIDTH, color: FX_CORE_COLOR, alpha: t });
          if (lanceStars === 3 && len > 0) {
            const p = 1 - t;
            const ring = 8 + p * 28;
            g.circle(e.x0, e.y0, ring).stroke({ width: 3.2 * t, color: FX_CORE_COLOR, alpha: 0.72 * t });
            g.circle(e.x1, e.y1, ring * 0.72).stroke({ width: 2.2 * t, color, alpha: 0.48 * t });
            // 空间裂痕:沿射线定距放六段交错短缝,随余波慢慢拉开。
            for (let k = 1; k <= 6; k++) {
              const f = k / 7;
              const cx = e.x0 + dx * f;
              const cy = e.y0 + dy * f;
              const side = k % 2 === 0 ? 1 : -1;
              const crack = 5 + 13 * p;
              g.moveTo(cx - nx * crack * side, cy - ny * crack * side)
                .lineTo(cx + nx * crack * 0.35 * side, cy + ny * crack * 0.35 * side);
            }
            g.stroke({ width: 1.5, color, alpha: 0.38 * t });
          }
          break;
        }
        case FXV_STAR_UPGRADE: {
          const t = fxFade(e.life, fxLifeForStars(e.kind, e.stars));
          const stars = Math.max(1, Math.min(STAR_MAX, Math.floor(e.stars || 1)));
          const p = 1 - t;
          const r = FX_STAR_UPGRADE_R0 + (FX_STAR_UPGRADE_R1 - FX_STAR_UPGRADE_R0) * p;
          const tint = FX_STAR_COLORS[stars - 1] ?? FX_STAR_COLORS[0];
          if (stars === 3) {
            // 前段向内抽离、随后点燃核心:与后面的向外签名爆发形成方向反差。
            const collapse = clamp01((0.2 - p) / 0.2);
            if (collapse > 0) {
              const cr = 18 + collapse * 46;
              for (let k = 0; k < FX_STAR_DIRS.length; k += 2) {
                g.circle(e.x0 + FX_STAR_DIRS[k]! * cr, e.y0 + FX_STAR_DIRS[k + 1]! * cr, 2.2);
              }
              g.fill({ color: FX_CORE_COLOR, alpha: collapse * 0.85 });
            }
            const ignite = clamp01(1 - Math.abs(p - 0.22) / 0.14);
            if (ignite > 0) g.circle(e.x0, e.y0, 8 + ignite * 20).fill({ color: FX_CORE_COLOR, alpha: ignite * 0.72 });
          }
          g.circle(e.x0, e.y0, r).stroke({ width: 3 + stars, color: tint, alpha: t * 0.9 });
          g.circle(e.x0, e.y0, r * 0.48).stroke({ width: 2, color: FX_CORE_COLOR, alpha: t });
          this.drawStarUpgradeBurst(g, e, heading, stars, t, tint);
          if (playAudio) audioBus.playUpgradeBurst(e.towerType, stars);
          break;
        }
        case FXV_BLAST: {
          // 唯一的圆。实心盘一直摊在**真实 aoeRadius** 上交代"炸到多大一片",
          // 扩张环负责"炸了"这件事本身 —— 环收尾那一帧正好压在盘的边界上,
          // 于是这一层同样守得住射界叠加层那条"可视化 = 实际作用范围"的口径。
          const stars = visualStarTier(e.stars > 0 ? e.stars : this.fxStarsForTower(e.towerType));
          const t = fxFade(e.life, fxLifeForStars(e.kind, stars));
          const p = 1 - t;
          const r = e.radius * (FX_BLAST_START + (1 - FX_BLAST_START) * (1 - t));
          g.circle(e.x0, e.y0, e.radius).fill({ color, alpha: FX_BLAST_FILL_ALPHA * t });
          g.circle(e.x0, e.y0, r).stroke({
            width: FX_BLAST_RING_WIDTH,
            color: FX_CORE_COLOR,
            alpha: t,
          });
          if (stars >= 2) {
            const inner = e.radius * (0.18 + p * 0.64);
            g.circle(e.x0, e.y0, inner).stroke({
              width: stars === 3 ? 3.2 : 2,
              color,
              alpha: (stars === 3 ? 0.68 : 0.45) * t,
            });
          }
          if (stars === 3) {
            const outer1 = e.radius * (0.48 + p * 0.9);
            const outer2 = e.radius * (0.62 + p * 1.12);
            g.circle(e.x0, e.y0, outer1).stroke({ width: 2.1, color: FX_CORE_COLOR, alpha: 0.42 * t });
            g.circle(e.x0, e.y0, outer2).stroke({ width: 1.4, color, alpha: 0.24 * t });
            const flash = clamp01((0.24 - p) / 0.24);
            if (flash > 0) g.circle(e.x0, e.y0, e.radius * (0.14 + 0.2 * flash)).fill({ color: FX_CORE_COLOR, alpha: flash * 0.82 });
            const shardStart = e.radius * (0.35 + p * 0.45);
            const shardEnd = shardStart + e.radius * (0.22 + p * 0.3);
            for (let k = 0; k < FX_STAR_DIRS.length; k += 2) {
              const ux = FX_STAR_DIRS[k]!;
              const uy = FX_STAR_DIRS[k + 1]!;
              g.moveTo(e.x0 + ux * shardStart, e.y0 + uy * shardStart)
                .lineTo(e.x0 + ux * shardEnd, e.y0 + uy * shardEnd);
            }
            g.stroke({ width: 1.8, color: FX_CORE_COLOR, alpha: 0.55 * t });
          }
          break;
        }
        case FXV_SPARK: {
          // "蹭到船体轮廓、但没进受击圆" —— **一分血都没掉**(sim 侧压根没走结算,见 09 号设计约定)。
          // 冷白 + 星芒 + 随 life 收缩,三条通道与下面那支暖红扩散环处处相反:
          // 玩家要靠这个差别学会自己的判定体到底多大,分不开就等于没给反馈。
          // 色相**不取 def.tint**:它不是任何一座塔打出来的(sim 侧填进去的 towerType 没有意义)
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
          // (与过热闪红同一条豁免,见 HULL_HIT_COLOR),不是 §12 敌我色域分离被破了。
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
          const stars = visualStarTier(e.stars > 0 ? e.stars : this.fxStarsForTower(e.towerType));
          const t = fxFade(e.life, fxLifeForStars(e.kind, stars));
          const len = FX_IMPACT_LEN * t * (stars === 3 ? 1.7 : stars === 2 ? 1.25 : 1);
          g.moveTo(e.x0 - len, e.y0).lineTo(e.x0 + len, e.y0);
          g.moveTo(e.x0, e.y0 - len).lineTo(e.x0, e.y0 + len);
          g.stroke({ width: FX_IMPACT_WIDTH * (stars === 3 ? 1.45 : 1), color: FX_IMPACT_COLOR, alpha: t });
          if (stars >= 2) {
            const p = 1 - t;
            g.circle(e.x0, e.y0, 3 + p * (stars === 3 ? 12 : 6)).stroke({
              width: stars === 3 ? 2 : 1.2,
              color,
              alpha: (stars === 3 ? 0.66 : 0.42) * t,
            });
          }
          if (stars === 3) {
            for (let k = 0; k < FX_STAR_DIRS.length; k += 2) {
              const ux = FX_STAR_DIRS[k]!;
              const uy = FX_STAR_DIRS[k + 1]!;
              g.moveTo(e.x0 + ux * 3, e.y0 + uy * 3).lineTo(e.x0 + ux * len * 1.25, e.y0 + uy * len * 1.25);
            }
            g.stroke({ width: 1.1, color: FX_CORE_COLOR, alpha: 0.72 * t });
          }
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
          // 暖色尸爆外再散一圈冷白/金色星尘:与地上的掉落物、地图信标共用材质语法,
          // 把“击杀 → 掉出可拾荒物 → 去补给点消费”串成一条视觉链。
          drawStardustHalo(
            g,
            e.x0,
            e.y0,
            e.radius * FX_KILL_STARDUST_EXPAND * (0.68 + (1 - t) * 0.42),
            (1 - t) * 0.9 + e.x0 * 0.0013 + e.y0 * 0.0007,
            t,
          );
          break;
        }
        case FXV_MUZZLE: {
          // 炮口火光画进船体上方的专层;同源塔色只做外圈,冷白描边 + 芯点提供独立亮度通道,
          // 否则同色实心圆落在同色塔块上仍等于没画。life 复用最短的 FX_LIFE_BEAM。
          // 坐标 = sim 开火那一帧用 slotMuzzleWorld 算好的世界坐标(见 sim/turret),
          // 渲染层不再回查槽位 —— 与光束/链电那几类同一份"事件自带世界坐标"的口径。
          const stars = visualStarTier(e.stars > 0 ? e.stars : this.fxStarsForTower(e.towerType));
          const t = fxFade(e.life, fxLifeForStars(e.kind, stars));
          const radius = FX_MUZZLE_RADIUS * (0.65 + 0.35 * t) * (stars === 3 ? 1.3 : stars === 2 ? 1.12 : 1);
          const aim = Math.atan2(e.y1 - e.y0, e.x1 - e.x0);
          const nx = -Math.sin(aim);
          const ny = Math.cos(aim);
          muzzleG
            .circle(e.x0, e.y0, radius)
            .fill({ color, alpha: FX_MUZZLE_ALPHA * t })
            .stroke({ width: FX_MUZZLE_RING_WIDTH, color: FX_CORE_COLOR, alpha: t })
            .circle(e.x0, e.y0, FX_MUZZLE_CORE_RADIUS)
            .fill({ color: FX_CORE_COLOR, alpha: t });
          if (stars >= 2 && isAutocannonFamily(e.towerType)) {
            const spread = 3.2;
            for (let side = -1; side <= 1; side += 2) {
              muzzleG.circle(e.x0 + nx * spread * side, e.y0 + ny * spread * side, radius * 0.42);
            }
            muzzleG.fill({ color: FX_CORE_COLOR, alpha: 0.84 * t });
          }
          if (stars === 3) {
            const p = 1 - t;
            const shock = radius * (1.1 + p * (isRailFamily(e.towerType) ? 3.4 : 1.8));
            muzzleG.circle(e.x0, e.y0, shock).stroke({
              width: isRailFamily(e.towerType) ? 3.2 : 2,
              color: isRailFamily(e.towerType) ? FX_CORE_COLOR : color,
              alpha: (isRailFamily(e.towerType) ? 0.82 : 0.52) * t,
            });
            const cone = isRailFamily(e.towerType) ? 26 : isMortarFamily(e.towerType) ? 18 : 13;
            for (let side = -1; side <= 1; side += 2) {
              const a = aim + side * (isRailFamily(e.towerType) ? 0.08 : 0.18);
              muzzleG.moveTo(e.x0, e.y0).lineTo(e.x0 + Math.cos(a) * cone, e.y0 + Math.sin(a) * cone);
            }
            muzzleG.stroke({ width: 1.6, color: FX_CORE_COLOR, alpha: 0.68 * t });
            if (e.towerType === TOWER_ARC || e.towerType === TOWER_THUNDER) {
              const crown = 7 + p * 6;
              for (let k = 0; k < FX_STAR_DIRS.length; k += 2) {
                const ux = FX_STAR_DIRS[k]!;
                const uy = FX_STAR_DIRS[k + 1]!;
                muzzleG.moveTo(e.x0 + ux * 2, e.y0 + uy * 2).lineTo(e.x0 + ux * crown, e.y0 + uy * crown);
              }
              muzzleG.stroke({ width: 1.5, color, alpha: 0.72 * t });
            }
          }
          break;
        }
        case FXV_RESONANCE: {
          // 齐射共振(24 号,v1 纯演出):towerType 借放三元组中心槽下标(见 sim/fx.ts),不是塔型 ——
          // 上面按塔型取的 def/color 对这一种 kind 不适用,弧光走自己的冷白双通道(宽晕 + 亮芯)。
          // 弧朝 WEAPON_SLOT_FACING[中心槽] + heading 铺开,角跨 = 相邻三槽张成的整面 90° 舷;
          // 槽位下标越界(数值表写坏)兜底成船头朝向,与 sim/armory 的 slotArcCenter 同一条口径。
          // 半径取船体受击圆:弧贴在船壳外缘;"沿舷侧"而不是从炮口射出去。
          const t = fxFade(e.life, FX_LIFE_RESONANCE);
          const a = (WEAPON_SLOT_FACING[e.towerType] ?? 0) + heading;
          const r = shipRadius(tuning.shipLength);
          const half = RESONANCE_ARC_SPAN / 2;
          // arc 之前 moveTo 到弧起点:Graphics 路径是连续的,不挪笔会从上一条子路径收笔处拉直线过来
          g.moveTo(e.x0 + Math.cos(a - half) * r, e.y0 + Math.sin(a - half) * r)
            .arc(e.x0, e.y0, r, a - half, a + half)
            .stroke({ width: RESONANCE_ARC_GLOW_WIDTH, color: FX_CORE_COLOR, alpha: RESONANCE_ARC_GLOW_ALPHA * t });
          g.moveTo(e.x0 + Math.cos(a - half) * r, e.y0 + Math.sin(a - half) * r)
            .arc(e.x0, e.y0, r, a - half, a + half)
            .stroke({ width: RESONANCE_ARC_CORE_WIDTH, color: FX_CORE_COLOR, alpha: RESONANCE_ARC_CORE_ALPHA * t });
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
    width = FX_CHAIN_WIDTH,
    kinkScale = 1,
  ): void {
    const g = this.fxG;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len <= 0) return; // 零长跳(同点)没有法线可言,画了也只是一个点
    // 单位法线:把折点推离连线用
    const nx = -dy / len;
    const ny = dx / len;
    const amp = len * FX_CHAIN_KINK * kinkScale;
    g.moveTo(x0, y0);
    for (let k = 0; k < FX_CHAIN_KINK_AT.length; k++) {
      const s = FX_CHAIN_KINK_AT[k]!;
      const o = FX_CHAIN_KINK_OFF[k]! * amp;
      g.lineTo(x0 + dx * s + nx * o, y0 + dy * s + ny * o);
    }
    g.lineTo(x1, y1).stroke({ width, color, alpha });
  }

  /**
   * 伤害飘字入池(畅玩性,drawFx 消费 FxEvent 时调用)。环形游标复用 DMG_POOL_SIZE 格:
   * 池满顶掉最旧(数组序 = 生成序,游标绕一圈正好先碰到最旧的);每帧 DMG_SPAWN_CAP 封顶 ——
   * 迫击炮一圈炸 10 只也只飘 6 个,8 杀/秒更不会在屏幕上堆成数字墙。
   * 同帧同点的多个事件按固定 8 向错开落点(定死不掷随机,与 FX_KILL_DIRS 同一条口径)。
   */
  private spawnDmgNumber(kind: number, x: number, y: number, damage: number, ratio: number): void {
    // 玩家关掉飘字 = **一个字都不生成**(而不是生成完再隐藏):飘字的成本在 Text 更新与
    // 逐帧推进上,画出来再设 visible=false 只省下最后一步,等于关了个寂寞
    if (!this.showDamageNumbers) return;
    if (this.dmgSpawnedThisFrame >= DMG_SPAWN_CAP) return;
    this.dmgSpawnedThisFrame++;
    const slot = this.dmgSlots[this.dmgCursor]!;
    this.dmgCursor = (this.dmgCursor + 1) % this.dmgSlots.length;
    const j = (this.dmgCursor * 2) % DMG_JITTER_DIRS.length;
    slot.active = true;
    slot.x = x + DMG_JITTER_DIRS[j]!;
    slot.y = y + DMG_JITTER_DIRS[j + 1]!;
    slot.life = slot.full = DMG_LIFE;
    const t = slot.text;
    t.text = dmgNumberText(damage);
    t.tint = dmgNumberColor(kind, ratio);
    t.alpha = 1;
    t.visible = true;
    t.position.set(slot.x, slot.y);
  }

  /**
   * 飘字逐渲染帧推进:上飘 + 淡出。渲染层自持计时(与 stepShake 同一份 dt)—— 时停期间照走。
   * 只改已激活的格,数组扫描 64 格是常数开销,热路径无分配。
   */
  private stepDmgNumbers(dt: number): void {
    for (let i = 0; i < this.dmgSlots.length; i++) {
      const slot = this.dmgSlots[i]!;
      if (!slot.active) continue;
      slot.life -= dt;
      if (slot.life <= 0) {
        slot.active = false;
        slot.text.visible = false;
        continue;
      }
      slot.y -= DMG_RISE * dt;
      slot.text.position.set(slot.x, slot.y);
      // 前 40% 满亮、后 60% 线性淡出:数字要"先看清、再消失",而不是一出生就开始褪色
      const t = slot.life / slot.full;
      slot.text.alpha = t > 0.6 ? 1 : t / 0.6;
    }
  }

  /**
   * 沉船爆炸演出(畅玩性,main.ts 的 onShipDestroyed 接线):扩散环 + 船色碎片 + 重震 + 爆炸音。
   * **纯表现**:一个 sim 字段都不动、不进 checksum —— 世界只负责说"船没了",怎么炸是渲染层的事。
   * 演出总时长 = SHIP_DEATH_FX_TIME,main 侧读同一份常量推迟结算界面,让这一下读得完。
   */
  playShipDeathExplosion(): void {
    this.deathLeft = this.deathFull = SHIP_DEATH_FX_TIME;
    // 锚点 = 船的上一帧位置:沉船那一帧世界随即冻结(loop.halt → alpha 归零),
    // 画面上船停在插值后的 px/py,爆炸就从那一点炸开,碎片与残骸不会错位
    this.deathX = this.world.ship.px;
    this.deathY = this.world.ship.py;
    for (let i = 0; i < this.deathDebris.length; i++) {
      const d = this.deathDebris[i]!;
      const a = (i / this.deathDebris.length) * Math.PI * 2;
      // 速度/自旋走固定表散布(定死不掷随机,与 FX_KILL_DIRS 同一条口径):
      // 每场爆炸形状一致可复现,20 块各飞各的不重叠
      const speed = DEATH_DEBRIS_SPEED * (0.65 + (0.35 * ((i * 7) % 3)) / 2);
      d.g.position.set(this.deathX, this.deathY);
      d.g.rotation = a;
      d.g.alpha = 1;
      d.g.visible = true;
      d.vx = Math.cos(a) * speed;
      d.vy = Math.sin(a) * speed;
      d.spin = ((i % 5) - 2) * 4;
      d.life = d.full = DEATH_DEBRIS_LIFE;
    }
    // 重震:沉船是全场最重的一次反馈 —— 震屏直接拉满,让既有衰减曲线接管后面那 ~0.5s
    this.shakeTrauma = SHAKE_MAX_TRAUMA;
    audioBus.playExplosion();
  }

  /** 爆炸演出逐渲染帧推进(渲染层自持计时,与 stepShake 同一份 dt):环扩散 + 碎片飞散 */
  private stepDeathFx(dt: number): void {
    if (this.deathLeft <= 0) {
      if (this.deathLayer.visible) {
        this.deathLayer.visible = false;
        this.deathG.clear();
        for (const d of this.deathDebris) d.g.visible = false;
      }
      return;
    }
    this.deathLeft = Math.max(0, this.deathLeft - dt);
    this.deathLayer.visible = true;
    const elapsed = this.deathFull - this.deathLeft;
    // 扩散环:三条错峰起手(0/0.12/0.24s)、各自 0.5s 从 R0 扩到 R1 并淡出 ——
    // 环的"波次感"读作船在解体,而不是一次性画一个圈
    const g = this.deathG;
    g.clear();
    for (let k = 0; k < DEATH_RING_COUNT; k++) {
      const t = (elapsed - DEATH_RING_DELAYS[k]!) / DEATH_RING_DURATION;
      if (t <= 0 || t >= 1) continue;
      g.circle(this.deathX, this.deathY, DEATH_RING_R0 + (DEATH_RING_R1 - DEATH_RING_R0) * t).stroke({
        width: DEATH_RING_WIDTHS[k]!,
        color: DEATH_RING_COLORS[k]!,
        alpha: DEATH_RING_ALPHAS[k]! * (1 - t),
      });
    }
    // 碎片:直线飞出 + 空间拖拽减速 + 自旋 + 淡出 —— 世界冻住它们照样飞(表现层自持计时)
    for (let i = 0; i < this.deathDebris.length; i++) {
      const d = this.deathDebris[i]!;
      if (d.life <= 0) continue;
      d.life -= dt;
      const drag = Math.exp(-Math.max(0, dt) * DEATH_DEBRIS_DRAG);
      d.vx *= drag;
      d.vy *= drag;
      d.g.x += d.vx * dt;
      d.g.y += d.vy * dt;
      d.g.rotation += d.spin * dt;
      d.g.alpha = Math.max(0, d.life / d.full);
      if (d.life <= 0) d.g.visible = false;
    }
  }

  /**
   * 加速技能表现(畅玩性):点火震屏 + 船尾尾焰 + 世界空间拖尾。
   * **纯表现**:sim 侧只读 world.boostTime 一个数,一个字段都不写回。
   * 尾焰画在船体局部空间(跟 shipG 一起转),拖尾逐渲染帧在船尾世界坐标落点、
   * 存续期内淡出缩小 —— 世界冻结(时停)时不再落新点,已有的照常淡完(渲染层自持计时)。
   */
  private stepBoostFx(dt: number, sx: number, sy: number, sh: number): void {
    const boostTime = this.world.boostTime;
    // 点火沿检测:boostTime 只会在触发那一帧上跳(其余帧单调递减),上跳 = 一次点火
    if (boostTime > this.lastBoostTime) {
      this.shakeTrauma = Math.min(SHAKE_MAX_TRAUMA, this.shakeTrauma + BOOST_SHAKE_TRAUMA);
    }
    this.lastBoostTime = boostTime;
    const boosting = boostTime > 0;

    // 尾焰:两层三角(外层青绿 + 内层白芯),长度随动画时钟快闪 —— 火在喘,不是一块静态贴片
    const flame = this.boostFlameG;
    flame.clear();
    if (boosting) {
      const flicker = 0.75 + 0.25 * Math.sin(this.animClock * 40);
      const len = BOOST_FLAME_LEN * flicker;
      const half = tuning.shipWidth * 0.18;
      const stern = -tuning.shipLength / 2;
      flame
        .moveTo(stern, -half)
        .lineTo(stern - len, 0)
        .lineTo(stern, half)
        .closePath()
        .fill({ color: BOOST_TINT, alpha: 0.85 });
      flame
        .moveTo(stern, -half * 0.45)
        .lineTo(stern - len * 0.55, 0)
        .lineTo(stern, half * 0.45)
        .closePath()
        .fill({ color: 0xffffff, alpha: 0.9 });
    }

    // 拖尾:加速中每渲染帧在船尾世界坐标落一个采样点(环形缓冲找空闲槽,满了就不落 ——
    // 丢最新的点比顶掉最旧的便宜,且尾迹的头部本就被船身盖着看不见)
    if (boosting) {
      const sternX = sx - Math.cos(sh) * (tuning.shipLength / 2);
      const sternY = sy - Math.sin(sh) * (tuning.shipLength / 2);
      for (let i = 0; i < this.boostTrail.length; i++) {
        const t = this.boostTrail[i]!;
        if (t.life > 0) continue;
        t.x = sternX;
        t.y = sternY;
        t.life = BOOST_TRAIL_LIFE;
        break;
      }
    }
    // 存续期内:半径随寿命收缩、透明度随寿命淡出 —— 一条越远越细越淡的航迹
    const g = this.boostTrailG;
    g.clear();
    for (let i = 0; i < this.boostTrail.length; i++) {
      const t = this.boostTrail[i]!;
      if (t.life <= 0) continue;
      t.life -= dt;
      if (t.life <= 0) continue;
      const k = t.life / BOOST_TRAIL_LIFE;
      g.circle(t.x, t.y, 2 + 5 * k).fill({ color: BOOST_TINT, alpha: 0.4 * k });
    }
  }

  /**
   * Boss 阶段沿的唯一消费者:0/读档哨兵 → 1 时启动一次出场演出并发一次专属音。
   * 检测放在帧首,于是同一帧的背景与镜头都能吃到满强度;持续时间只由渲染 dt 推进,
   * 暂停/高刷屏不会多触发,也绝不反写 world.bossPhase。
   */
  private stepBossEntrance(dt: number): void {
    const phase = this.world.bossPhase;
    if (phase !== this.bossPhaseSeen) {
      const enter = bossWarnOnEnter(this.bossPhaseSeen, phase);
      this.bossPhaseSeen = phase;
      if (enter) {
        this.bossEntranceLeft = BOSS_ENTRANCE_FX_TIME;
        this.shakeTrauma = Math.max(this.shakeTrauma, SHAKE_MAX_TRAUMA);
        // 相位也踢开一档:避免恰好落在 sin/cos 过零点时“满 trauma 却第一帧看似没动”。
        this.shakePhase += Math.PI * 0.37;
        audioBus.playBossWarn();
      }
    }
    if (this.bossEntranceLeft > 0) {
      this.bossEntranceLeft = Math.max(0, this.bossEntranceLeft - Math.max(0, dt));
    }
  }

  /**
   * 震屏(畅玩性):受击/击杀事件入账为 trauma,按指数衰减;相位按秒推进 ——
   * 于是无论 30fps 还是 144fps,抖动都走完同一段时长,观感不随帧率漂移。
   * 渲染层自持计时(与 stepDmgNumbers 同一份 dt):时停/结算期间照走。
   */
  private stepShake(dt: number): void {
    const items = this.world.fx.items;
    for (let i = 0; i < items.length; i++) {
      const e = items[i]!;
      if (e.juicePlayed) continue;
      e.juicePlayed = true;
      const stars = visualStarTier(e.stars > 0 ? e.stars : this.fxStarsForTower(e.towerType));
      if (e.kind === FXV_HULL_HIT) this.shakeTrauma += 0.85;
      else if (e.kind === FXV_LANCE && stars === 3) this.shakeTrauma += 0.95;
      else if (e.kind === FXV_BLAST) this.shakeTrauma += stars === 3 ? 0.92 : stars === 2 ? 0.18 : 0;
      else if (e.kind === FXV_STAR_UPGRADE && stars === 3) this.shakeTrauma += 0.72;
      else if (e.kind === FXV_IMPACT) this.shakeTrauma += stars === 3 ? 0.24 : stars === 2 ? 0.12 : 0.08;
      else if (e.kind === FXV_KILL) this.shakeTrauma += 0.035;
      // 齐射共振的轻震:≤ 击杀档 —— 它是自己船的齐射不是挨打,只给"这一舷响了"的手感
      else if (e.kind === FXV_RESONANCE) this.shakeTrauma += 0.03;
    }
    this.shakeTrauma = Math.min(
      SHAKE_MAX_TRAUMA,
      this.shakeTrauma * Math.exp(-Math.max(0, dt) / SHAKE_DECAY_TAU),
    );
    this.shakePhase += Math.max(0, dt) * SHAKE_FREQUENCY;
    // 玩家的震屏强度只乘在**振幅**上,不碰 trauma 的累积与衰减:
    // 乘进 trauma 的话,关掉再打开会因为衰减常数被改写而留下一段"半强度"的过渡,
    // 而振幅是每帧现算的纯输出 —— 拨到 0 当帧就绝对静止,拨回来当帧就恢复原样
    // Boss 入场多一条慢衰减低频量:普通受击的 trauma 约 0.1s 就退完,不足以托住“巨物进场”这一拍。
    // 两者相加后统一乘玩家设置,震屏关到 0 时 Boss 也绝对静止。
    const bossEntranceShake = bossEntranceStrength(this.bossEntranceLeft) * BOSS_ENTRANCE_SHAKE_PIXELS;
    const amplitude =
      (this.shakeTrauma * this.shakeTrauma * SHAKE_PIXEL_SCALE + bossEntranceShake) * this.shakeScale;
    this.shakeX = Math.sin(this.shakePhase * 1.7) * amplitude;
    this.shakeY = Math.cos(this.shakePhase * 1.3) * amplitude;
  }

  /** 背景色相脉冲:一层暗紫红铺底 + 远景贴图轻微玫红 tint,星野与战场实体不染色。 */
  private syncBossEntranceBackground(width: number, height: number): void {
    const strength = bossEntranceStrength(this.bossEntranceLeft);
    const g = this.bossEntranceG;
    g.clear();
    if (strength > 0) {
      g.rect(0, 0, width, height).fill({
        color: BOSS_ENTRANCE_BG_COLOR,
        alpha: BOSS_ENTRANCE_BG_ALPHA * strength,
      });
    }
    if (this.backgroundSprite) {
      this.backgroundSprite.tint = lerpColor(0xffffff, BOSS_ENTRANCE_BG_TINT, strength);
    }
  }

  /**
   * 远景按 cover 方式铺满屏幕，并留 12% 超扫给视差。位移用平滑周期函数而不是取模：
   * 船飞得再远也不会在某一帧把背景从右边瞬移回左边。
   */
  private syncBackground(width: number, height: number, shipX: number, shipY: number): void {
    const bg = this.backgroundSprite;
    if (!bg) return;
    const tex = bg.texture;
    const cover = Math.max(width / tex.width, height / tex.height) * 1.12;
    bg.scale.set(cover);
    bg.position.set(
      width / 2 - Math.sin(shipX * 0.0007) * width * 0.025,
      height / 2 - Math.sin(shipY * 0.0007) * height * 0.025,
    );
  }

  /**
   * 精英常驻识别环:金橙双圈 + 四个短刻度,画在敌人下方。
   * 半径跟随精英的真实判定体并补上 ELITE_VISUAL_SCALE,所以五种轮廓都能完整落在圈内；
   * 相位只做 5% 呼吸,不会与“环合拢即冲刺/开火”的前摇语义混淆。
   */
  private drawEliteAuras(alpha: number): void {
    const g = this.telegraphG;
    let drawn = 0;
    for (let k = 0; k < this.eliteBuckets.length; k++) {
      const bucket = this.eliteBuckets[k]!;
      for (let i = 0; i < bucket.length; i++) {
        const e = bucket[i]!;
        const x = e.px + (e.x - e.px) * alpha;
        const y = e.py + (e.y - e.py) * alpha;
        const pulse = 1 + Math.sin(this.animClock * 4 + e.animSeed * Math.PI * 2) * 0.05;
        const r = enemyRadius(e) * ELITE_VISUAL_SCALE * pulse + 4;
        g.circle(x, y, r).circle(x, y, r + 4);
        for (let n = 0; n < 4; n++) {
          const a = this.animClock * 0.7 + n * (Math.PI / 2);
          const c = Math.cos(a);
          const s = Math.sin(a);
          g.moveTo(x + c * (r + 1), y + s * (r + 1)).lineTo(
            x + c * (r + 7),
            y + s * (r + 7),
          );
        }
        drawn++;
      }
    }
    if (drawn > 0) {
      g.stroke({ width: 1.8, color: ELITE_TINT, alpha: 0.62 });
    }
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
      // **放大的**体型上才合得上"合拢即起冲"的承诺(与 drawTelegraph 的精英口径同一条)
      g.circle(x, y, enemyRadius(e) * (1 + TELEGRAPH_RING_GROWTH * t));
    }
    if (drawn > 0) {
      g.stroke({ width: TELEGRAPH_WIDTH, color: enemyTint(def.kind), alpha: TELEGRAPH_ALPHA });
    }
    return budget;
  }

  /**
   * Boss 冲锋前摇(15 号):与普通甲虫同一条可读性通道(telegraphG 里的指示线 + 收缩环),
   * 数值走 BOSS 表 —— 冲刺全程 = 底座 chargeSpeed × chargeSpeedMul × enemySpeedScale ×
   * chargeDuration(与 sim/boss.ts 的 DASH 分支同一份乘式),环径走 bossRadius()
   * (与判定体同源):环合拢那一刻正好贴住 Boss 本体,起冲即"贴住了"。
   * 冲刺是 Z 字折线,指示线按同一条折线画(几何走 bossZLaneDir,与 sim 共用 ——
   * 两条路各自手搓旋转矩阵会漂出两个口径):线还是那句"待会儿只撞这条线上"的承诺,
   * 只是承诺对象从一条直线扩成一条 Z 形走廊。
   * Boss 全场只有一只,不占 TELEGRAPH_MAX_PER_KIND 配额。
   */
  private drawBossTelegraph(alpha: number, shipX: number, shipY: number): void {
    const g = this.telegraphG;
    const base = ENEMIES[BOSS.baseKind]!;
    const reach = (base.chargeSpeed * BOSS.chargeSpeedMul * tuning.enemySpeedScale * BOSS.chargeDuration) / BOSS_Z_LEGS;
    const tint = enemyTint(BOSS.baseKind);
    const bucket = this.bossBucket;
    const lane: Vec2 = { x: 0, y: 0 };
    let drawn = 0;
    for (let i = 0; i < bucket.length; i++) {
      const e = bucket[i]!;
      if (e.state !== BOSS_WINDUP) continue;
      drawn++;
      // 位置与粒子同口径插值,否则指示线会比 Boss 本体晚一帧(与 drawTelegraph 同一条)
      const bx = e.px + (e.x - e.px) * alpha;
      const by = e.py + (e.y - e.py) * alpha;
      let x = bx;
      let y = by;
      g.moveTo(x, y);
      for (let leg = 0; leg < BOSS_Z_LEGS; leg++) {
        bossZLaneDir(e.lockX, e.lockY, leg, lane);
        x += lane.x * reach;
        y += lane.y * reach;
        g.lineTo(x, y);
      }
      // 夹住 [0,1]:面板改 chargeWindup 时正在前摇的 Boss 不至于画出巨环
      const t = Math.max(0, Math.min(1, e.timer / BOSS.chargeWindup)); // 1 → 0
      g.circle(
        bx,
        by,
        bossRadius() * BOSS_VISUAL_SCALE * (1 + TELEGRAPH_RING_GROWTH * t) + BOSS_TELEGRAPH_RING_GAP,
      );
    }
    if (drawn > 0) {
      g.stroke({ width: TELEGRAPH_WIDTH, color: tint, alpha: TELEGRAPH_ALPHA });
    }

    // 巨大慢速激光球的蓄能线:只在预警窗口内画,颜色/节奏与冲锋线分开,
    // 让玩家明确知道 Boss 正在朝当前船位锁定一颗大球。发射后 cooldown 被重置,
    // 线自然熄灭;方向只用于预警,实际弹道仍由 sim 在发射帧锁定。
    const laserLeft = this.world.bossLaserCooldown;
    if (laserLeft <= 0 || laserLeft > BOSS.laserWarnTime || bucket.length === 0) return;
    const boss = bucket[0]!;
    const bx = boss.px + (boss.x - boss.px) * alpha;
    const by = boss.py + (boss.y - boss.py) * alpha;
    const dx = shipX - bx;
    const dy = shipY - by;
    const dist = Math.hypot(dx, dy);
    if (dist <= 1e-6) return;
    const ux = dx / dist;
    const uy = dy / dist;
    const t = Math.max(0, Math.min(1, laserLeft / BOSS.laserWarnTime));
    const pulse = 0.45 + 0.55 * Math.abs(Math.sin(this.animClock * 7.5));
    g.moveTo(bx + ux * (bossRadius() * 0.7), by + uy * (bossRadius() * 0.7))
      .lineTo(shipX - ux * 10, shipY - uy * 10);
    g.circle(bx, by, bossRadius() * BOSS_VISUAL_SCALE + 5 + t * 10);
    g.stroke({
      width: 2.2 + (1 - t) * 2.2,
      color: BOSS_LASER_TINT,
      alpha: (0.22 + (1 - t) * 0.5) * pulse,
    });
  }

  /**
   * 孢子炮手的蓄力预警(22 号):锚定后进蓄力的那 sporeWarnTime 秒里,在炮手身上画一圈
   * 随剩余时间收缩的环 —— 与冲锋前摇的收缩环同一语言("环合拢即开火",见 drawTelegraph),
   * 颜色取该型 tint。数据驱动地跳过:sporeWarnTime <= 0 的型永远进不了 ST_SPORE_WINDUP
   * (与 drawTelegraph 的 chargeWindup 跳过同款)。
   * @returns 剩余配额(精英与普通桶同型共享,见 sync 的调用处)
   */
  private drawSporeTelegraph(
    bucket: readonly Enemy[],
    def: EnemyDef,
    alpha: number,
    budget: number,
  ): number {
    if (def.sporeWarnTime <= 0 || budget <= 0) return budget;
    const g = this.telegraphG;
    let drawn = 0;
    for (let i = 0; i < bucket.length; i++) {
      if (budget <= 0) break;
      const e = bucket[i]!;
      if (e.state !== ST_SPORE_WINDUP) continue;
      budget--;
      drawn++;
      // 位置与粒子同口径插值,否则预警环会比炮手本体晚一帧(与 drawTelegraph 同一条)
      const x = e.px + (e.x - e.px) * alpha;
      const y = e.py + (e.y - e.py) * alpha;
      // 夹住 [0,1]:面板/单测改 sporeWarnTime 时正在蓄力的那几只不至于画出巨环
      const t = Math.max(0, Math.min(1, e.timer / def.sporeWarnTime)); // 1 → 0:越近开火越紧
      // 环径走 enemyRadius:精英的判定体已被 sim 放大(×ELITE.scale),环必须收到**放大的**
      // 体型上才合得上"合拢即开火"的承诺(与 drawTelegraph 的精英口径同一条)
      g.circle(x, y, enemyRadius(e) * (1 + TELEGRAPH_RING_GROWTH * t));
    }
    if (drawn > 0) {
      g.stroke({ width: TELEGRAPH_WIDTH, color: enemyTint(def.kind), alpha: TELEGRAPH_ALPHA });
    }
    return budget;
  }

  /**
   * Boss 战提示(15 号):出场音 + 召唤预告,都在屏幕空间一层(bossWarnG)上做。
   *
   * 出场音/震屏/背景换色由帧首 stepBossEntrance 统一消费阶段沿;本函数只画战中召唤预告。
   *
   * 召唤预告:bossSummonCooldown ≤ BOSS.summonWarnTime 时,在 Boss 身上画一圈
   * 随剩余时间收弧的倒计时环 + 屏边一支指向 Boss 的箭头(仅 Boss 在屏外时)——
   * 与精英预警同一套"边缘箭头 + 倒计时环"视觉通道,靠 Boss 专属色(底座 tint)与
   * 更慢的闪烁节奏分得开。数据源 = world 的只读字段,零 rng、零状态改动。
   */
  private syncBossWarn(shipX: number, shipY: number, alpha: number): void {
    void shipX;
    void shipY;
    const g = this.bossWarnG;
    g.clear();
    const w = this.world;
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
    const r = Math.max(
      6,
      bossRadius() * this.worldLayer.scale.x * BOSS_VISUAL_SCALE + BOSS_SUMMON_RING_GAP,
    );
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

  /**
   * 环阵 burst 预警(25 号):下一个未触发的 burst 是环阵时,以船为心画一圈收缩的全环脉冲 ——
   * 全环合围的"阵型时刻"在怪出生前就铺出来(方向箭头对环阵无意义:没有来向)。
   *
   * 数据源 = world.burstWarning(peekNextBurst 的只读游标),与 HUD 的 burst 预警同一份读数、
   * 零 rng、零状态改动,只把脚本里早就写着的事提前念给玩家听。预警消失不需要专门判定:
   * burst 实际触发(burstNext 前移)或该段结束后,peek 要么换到下一个事件、要么返回 null,
   * 环自然熄灭 —— 与精英预警同一条口径。
   *
   * 视觉:正圆从屏缘随剩余 eta 合拢向船(越近环越收越实),叠一层随 eta 的快闪;
   * 威胁红与 HUD 的 burst 预警同色 —— 两套预警读的是同一件事,颜色不能打架。
   */
  private syncBurstRingWarning(shipX: number, shipY: number): void {
    const g = this.burstRingG;
    g.clear();
    const w = this.world;
    // 压测旁路/脚本走完时 burstWarning 返回 null;方向流 burst 不画环(那是 HUD 箭头的事)
    const burst = w.burstWarning();
    if (!burst || burst.pattern !== BURST_PATTERN_RING || burst.etaSeconds > BURST_RING_WARN_WINDOW) return;
    const closeness = 1 - burst.etaSeconds / BURST_RING_WARN_WINDOW; // 0 → 1:越近环越收越实
    const blink = 0.55 + 0.45 * Math.abs(Math.sin(burst.etaSeconds * Math.PI * BURST_RING_BLINK_HZ));
    const half = Math.min(this.app.screen.width, this.app.screen.height) / 2;
    const radius = Math.max(BURST_RING_MIN_RADIUS, half * (0.05 + 0.95 * (1 - closeness)));
    // shipX/shipY 是插值世界位姿,而 burstRingG 挂在 stage(屏幕空间)——必须经 worldLayer
    // 换算(与 bossWarnG/eliteWarnG 同一条口径):地图无限、船在世界系无界漂移,
    // 直接画会钉在屏幕左上角、越漂越远,永远不在船心
    burstRingWorld.x = shipX;
    burstRingWorld.y = shipY;
    this.worldLayer.toGlobal(burstRingWorld, burstRingScreen);
    g.circle(burstRingScreen.x, burstRingScreen.y, radius).stroke({
      width: 2 + closeness * 3,
      color: 0xff5f77,
      alpha: (0.45 + 0.55 * closeness) * blink,
    });
  }

  private syncParticles(
    particles: Particle[],
    pc: ParticleContainer,
    entities: readonly (Enemy | Bullet | Drop | EnemyBullet)[],
    opts: {
      texture: Texture;
      tint: number;
      alpha: number;
      scale?: number;
      rotationOffset?: number;
      /** 侧掠者单贴图回退:朝目标左右翻面,并把倾角限制在水平轴附近 */
      targetFacing?: RigTargetFacing;
      targetX?: number;
      targetY?: number;
      /** 程序化动画参数:只在敌人/精英/Boss 容器传入,子弹/残骸不付这个分支 */
      anim?: EnemyAnim;
      /**
       * 受击闪白的基础色:只在敌人/精英/Boss 容器传入(它们开了 color: true 动态属性)——
       * 每帧按 hitFlash 剩余量在基础色与白之间插值,其余帧原样重写基础色。
       * 子弹/残骸不传 = 走静态 tint,一条分支都不进(热路径不白付)
       */
      flashBase?: number;
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
        if (
          entity &&
          opts.targetFacing !== undefined &&
          opts.targetX !== undefined &&
          opts.targetY !== undefined
        ) {
          targetFacingRootPose(
            p.x,
            p.y,
            opts.targetX,
            opts.targetY,
            opts.targetFacing,
            targetFacingScratch,
          );
          p.rotation = targetFacingScratch.angle;
          // 左右换向靠 scaleX 符号；每帧从基准/呼吸读数重算,不拿上一帧的负缩放继续相乘。
          const facingScale = frame?.scale ?? opts.scale ?? 1;
          p.scaleX = facingScale * targetFacingScratch.flipX;
          p.scaleY = facingScale;
        } else if (entity && (opts.rotationOffset !== undefined || anim)) {
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
        // 受击闪白:把剪影朝白色按剩余强度混合(容器开了 color:true,这一格每帧都要重写 tint)。
        // 绝大帧数 hitFlash = 0,只写基础色;闪白的 0.08s 里才付一次 lerp
        if (opts.flashBase !== undefined) {
          const base = opts.flashBase;
          if (entity && 'hitFlash' in entity) {
            const flash = (entity as { hitFlash: number }).hitFlash;
            p.tint = flash > 0 ? lerpColor(base, 0xffffff, hitFlashMix(flash)) : base;
          } else {
            p.tint = base;
          }
        }
      } else {
        p.x = OFFSCREEN;
        p.y = OFFSCREEN;
      }
    }
  }
}
