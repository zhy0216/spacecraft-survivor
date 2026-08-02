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
 * 扇形的角度与半径**一律问 sim**(cellArc / tuning.turretRange),渲染层一行射界数学都不许自己写 ——
 * 04 号的验收标准是"可视化与实际可命中区域一致",重算一份就等于埋下两个迟早走散的真相。
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
import { type Arc, cellArc, isTurretCell } from '../sim/arc';
import { tuning } from '../sim/config';
import {
  canPlace,
  CELL_SUPPORT,
  CELL_WEAPON,
  cellLocalPos,
  type Deck,
  deckCellSize,
  EDGE_BOW,
  EDGE_PORT,
  EDGE_STARBOARD,
  EDGE_STERN,
  isEdgeExposed,
  PLACE_OK,
} from '../sim/deck';
import { ST_WINDUP } from '../sim/enemy';
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
const BULLET_TINT = 0x9adcff;
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
// 放置高亮:合法格用弹道同色的冷青蓝,与船体自身的蓝拉开一档明度。
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
  private bulletPc: ParticleContainer;
  private bulletParticles: Particle[] = [];
  private bulletTex: Texture;
  private telegraphG: Graphics;
  /** 甲板容器:子层几何全在船体局部空间,它自己每帧只吃插值位姿(见文件头) */
  private deckG = new Container();
  private deckBaseG = new Graphics();
  /** 放置高亮:压在底板之上,否则合法格的半透明色块会被格子填充盖掉 */
  private deckHiliteG = new Graphics();
  /** 射界扇形(04 号):压在底板之下 —— 它是底衬,不许糊住格子本身的状态色 */
  private deckArcG = new Graphics();
  /**
   * 炮口线。与扇形分开一层,是因为两者的寿命不同:扇形几何一局里只变几次(放塔、改参数),
   * 炮管却每帧都在转 —— 同一个 Graphics 里没法只 clear 一半,合在一起就等于扇形也跟着每帧重建。
   */
  private deckMuzzleG = new Graphics();
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
  /**
   * 扇形几何的三个缓存键:几何只随"哪些格是在线塔"(deck.revision)与两个 tuning 数变化,
   * 三者都没动就一帧都不用重画。初值 -1 保证首次按住 Tab 必建一次(合法值全为正)。
   */
  private arcRevision = -1;
  private arcDeg = -1;
  private arcRange = -1;
  /** 叠加层上一帧是否画过:松开 Tab 时 clear 一次即可(照 hiliteDrawn 的写法) */
  private arcDrawn = false;

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

    // 灰盒纹理:代码生成,无美术资产
    this.bulletTex = app.renderer.generateTexture(
      new Graphics().rect(-4, -1.5, 8, 3).fill(0xffffff),
    );

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
    this.bulletPc = new ParticleContainer({ dynamicProperties: dyn, boundsArea: bounds });

    // 方位参照:镜头跟船后画面里没有不动的东西,靠场地边界圈才知道自己漂到哪了
    const ring = new Graphics().circle(0, 0, WORLD_RADIUS).stroke({ width: 3, color: 0x1c2740 });

    // 冲锋前摇的指示层:每帧 clear 后重画(几何逐帧变),故与静态的边界圈分开
    this.telegraphG = new Graphics();

    // 灰盒船体 = 甲板本身:四个子层装进一个容器,容器负责"跟着船走",子层只管局部几何。
    // 子层序:射界扇形(底衬)→ 底板 → 炮口线(炮管长在甲板上,理应压住底板)
    // → 放置高亮(临时的交互层,"我要放哪一格"任何时候都不许被别的层盖住)。
    // 这里不建几何 —— 格子内容要等 sync() 的脏标记在首帧补上(deckRevision = -1)。
    this.deckG.addChild(this.deckArcG, this.deckBaseG, this.deckMuzzleG, this.deckHiliteG);

    // 层序:边界圈 → 前摇指示 → 敌(按 kind 顺序,后面的型压住前面的:冲撞甲虫排最后,
    // 不会被蜂群蛭糊掉)→ 弹 → 甲板。指示层压在敌人之下:锁定线不该糊住甲虫自己的剪影。
    // 甲板最后加:压在敌与弹之上,千敌贴脸时自己的格子不会被糊掉 —— 放塔时更是必须看得见
    this.worldLayer.addChild(ring, this.telegraphG);
    for (let k = 0; k < this.enemyPcs.length; k++) this.worldLayer.addChild(this.enemyPcs[k]!);
    this.worldLayer.addChild(this.bulletPc, this.deckG);
    app.stage.addChild(this.worldLayer);
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
    this.worldLayer.position.set(screen.width / 2, screen.height / 2);

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

    this.syncParticles(this.bulletParticles, this.bulletPc, this.world.bullets.items, {
      texture: this.bulletTex,
      tint: BULLET_TINT,
      alpha,
    });

    // 甲板:底板只在 deck.revision 变了才重建,高亮层每帧现算(它跟着鼠标走)。
    // 容器只吃插值位姿,格子几何一律是局部坐标 —— 甲板与船体一同旋转由此成立(见文件头)
    const deck = this.world.deck;
    if (deck.revision !== this.deckRevision) {
      this.deckRevision = deck.revision;
      this.drawDeckBase(deck);
    }
    this.drawDeckHilite(deck);
    this.drawDeckArcs(deck);
    this.deckG.position.set(sx, sy);
    this.deckG.rotation = sh;
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
      if (canPlace(deck, c.col, c.row, st.content) !== PLACE_OK) continue;
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
      const legal = canPlace(deck, hover.col, hover.row, st.content) === PLACE_OK;
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
   *     就得到局部中心角),半径直接取 tuning.turretRange —— 这两个数正是 sim 索敌判定用的那两个,
   *     不是渲染层照着规则重推的第二份;
   *   二、"船旋转时射界实时跟随、无一帧延迟":整层挂在 deckG 下,吃的是与底板同一个插值位姿,
   *     于是"扇形跟着船转"与"甲板跟着船转"在结构上就是同一件事,想差一帧都做不到。
   * 扇形几何只随 deck.revision(放塔、12 号焊接)与两个 tuning 数变化 → 三个缓存键脏标记重建;
   * 炮管每帧在动,炮口线只能每帧重画,所以两者分在两层 Graphics 上(见 deckMuzzleG)。
   */
  private drawDeckArcs(deck: Deck): void {
    if (!this.arcOverlay) {
      // 松开 Tab 时清一次就够(照 drawDeckHilite),顺手把缓存键作废:
      // 下次按住 Tab 才会重建几何,否则清掉的画面再也不会被补回来
      if (this.arcDrawn) {
        this.deckArcG.clear();
        this.deckMuzzleG.clear();
        this.arcDrawn = false;
        this.arcRevision = -1;
      }
      return;
    }
    this.arcDrawn = true;

    // 现读 tuning(与 sim 每逻辑帧现读同口径):面板拖射界档位/射程时,扇形当场跟着变
    const arcDeg = tuning.turretArcDeg;
    const range = tuning.turretRange;
    if (deck.revision !== this.arcRevision || arcDeg !== this.arcDeg || range !== this.arcRange) {
      this.arcRevision = deck.revision;
      this.arcDeg = arcDeg;
      this.arcRange = range;
      this.drawArcFans(deck, arcDeg, range);
    }
    this.drawArcMuzzles(deck, arcDeg);
  }

  /**
   * 扇形本体。全部塔攒成一条 path 只 fill + stroke 一次(照底板/高亮层的写法):
   * 扇形是"我打得到哪里"的整体读数,不需要逐塔不同的表现。
   * 只画在线的武器塔 —— isTurretCell 已经把 online 判进去(离线塔不开火,画出扇形就是骗玩家),
   * cellArc 再兜一层"没有暴露边就返回 false"。
   */
  private drawArcFans(deck: Deck, arcDeg: number, range: number): void {
    const g = this.deckArcG;
    g.clear();
    const cells = deck.cells;
    let drawn = 0;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      if (!isTurretCell(c) || !cellArc(c, 0, arcDeg, arcTmp)) continue;
      const p = cellLocalPos(deck, c.col, c.row, localPos);
      // 圆心 = 格心(sim 索敌也是从格心量距离),moveTo → arc → closePath 合成一块扇形
      g.moveTo(p.x, p.y)
        .arc(p.x, p.y, range, arcTmp.center - arcTmp.half, arcTmp.center + arcTmp.half)
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
   */
  private drawArcMuzzles(deck: Deck, arcDeg: number): void {
    const g = this.deckMuzzleG;
    g.clear();
    const len = deckCellSize() * DECK_MUZZLE_LEN;
    const cells = deck.cells;
    let drawn = 0;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      if (!isTurretCell(c) || !cellArc(c, 0, arcDeg, arcTmp)) continue;
      const p = cellLocalPos(deck, c.col, c.row, localPos);
      // 不必 wrapAngle:cos/sin 对超出 ±π 的角一样正确,折回只是白算两次三角函数
      const a = arcTmp.center + c.turretOffset;
      g.moveTo(p.x, p.y).lineTo(p.x + Math.cos(a) * len, p.y + Math.sin(a) * len);
      drawn++;
    }
    if (drawn > 0) g.stroke({ width: DECK_MUZZLE_WIDTH, color: DECK_MUZZLE_COLOR });
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
