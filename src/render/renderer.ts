/**
 * 渲染层:只读 sim 状态画图,在 prev/cur 位置间按 alpha 插值。
 * 规则:render 可以 import sim,sim 永不 import render。
 * 大批量实体走 ParticleContainer(GDD §13 性能预算的关键)。
 * 镜头跟船(GDD §3.3):固定缩放 + 航向前方 look-ahead,取样一律用插值后的位姿。
 * 敌我色域分离(GDD §12 / 07 号 issue):敌人一律红紫暖色剪影、我方船与弹一律冷色,
 * 四型之间再靠形状 + 体型区分 —— 色相与轮廓两条通道各自独立,色盲玩家丢了色相仍认得出型。
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
import { tuning } from '../sim/config';
import { ST_WINDUP } from '../sim/enemy';
import { lerpAngle } from '../sim/ship';
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
  private shipG: Graphics;

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

    // 灰盒船体:几何朝 +X(与 heading = 0 同向),每帧只改 position/rotation,不重建几何。
    // 船长宽在此一次性读取、不进调参面板 —— 改了甲板格子也得跟着重算(03 号 issue)。
    // 尾部凹口是唯一的朝向线索:纯三角形在快速转向时分不清头尾。
    const len = tuning.shipLength;
    const wid = tuning.shipWidth;
    this.shipG = new Graphics()
      .poly([len / 2, 0, -len / 2, wid / 2, -len * 0.3, 0, -len / 2, -wid / 2])
      .fill(SHIP_FILL)
      .stroke({ width: 3, color: SHIP_EDGE });

    // 层序:边界圈 → 前摇指示 → 敌(按 kind 顺序,后面的型压住前面的:冲撞甲虫排最后,
    // 不会被蜂群蛭糊掉)→ 弹 → 船。指示层压在敌人之下:锁定线不该糊住甲虫自己的剪影。
    // 船最后加:压在敌与弹之上,千敌贴脸时自己不会被糊掉
    this.worldLayer.addChild(ring, this.telegraphG);
    for (let k = 0; k < this.enemyPcs.length; k++) this.worldLayer.addChild(this.enemyPcs[k]!);
    this.worldLayer.addChild(this.bulletPc, this.shipG);
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

    this.shipG.position.set(sx, sy);
    this.shipG.rotation = sh;
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
