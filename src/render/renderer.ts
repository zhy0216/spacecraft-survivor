/**
 * 渲染层:只读 sim 状态画图,在 prev/cur 位置间按 alpha 插值。
 * 规则:render 可以 import sim,sim 永不 import render。
 * 大批量实体走 ParticleContainer(GDD §13 性能预算的关键)。
 * 镜头跟船(GDD §3.3):固定缩放 + 航向前方 look-ahead,取样一律用插值后的位姿。
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
import { tuning } from '../sim/config';
import { lerpAngle } from '../sim/ship';
import type { Bullet, Enemy, World } from '../sim/world';
import { WORLD_RADIUS } from '../sim/world';

/** 未使用粒子的"停车位":粒子只增不删,多余的挪出视野(避免运行期增删 GPU 缓冲) */
const OFFSCREEN = 1e6;

// 敌我色域完全分离(GDD §12):敌 = 红紫暖色,我方/弹 = 冷色
const ENEMY_TINTS = [0xff4d6d, 0xe84393, 0xc44dff, 0x9b59ff, 0xff6348, 0xd63031] as const;
const BULLET_TINT = 0x9adcff;
// 船体走冷色废铁(GDD §12):暗底 + 亮边,千敌同屏时靠色域而不是描边把自己认出来
const SHIP_FILL = 0x2b4a6e;
const SHIP_EDGE = 0x7fc4ff;

interface Interpolatable {
  x: number;
  y: number;
  px: number;
  py: number;
}

export class Renderer {
  readonly app: Application;
  private world: World;
  private worldLayer = new Container();
  private enemyPc: ParticleContainer;
  private bulletPc: ParticleContainer;
  private enemyParticles: Particle[] = [];
  private bulletParticles: Particle[] = [];
  private enemyTex: Texture;
  private bulletTex: Texture;
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
    this.enemyTex = app.renderer.generateTexture(new Graphics().circle(0, 0, 7).fill(0xffffff));
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
    this.enemyPc = new ParticleContainer({ dynamicProperties: dyn, boundsArea: bounds });
    this.bulletPc = new ParticleContainer({ dynamicProperties: dyn, boundsArea: bounds });

    // 方位参照:镜头跟船后画面里没有不动的东西,靠场地边界圈才知道自己漂到哪了
    const ring = new Graphics().circle(0, 0, WORLD_RADIUS).stroke({ width: 3, color: 0x1c2740 });

    // 灰盒船体:几何朝 +X(与 heading = 0 同向),每帧只改 position/rotation,不重建几何。
    // 船长宽在此一次性读取、不进调参面板 —— 改了甲板格子也得跟着重算(03 号 issue)。
    // 尾部凹口是唯一的朝向线索:纯三角形在快速转向时分不清头尾。
    const len = tuning.shipLength;
    const wid = tuning.shipWidth;
    this.shipG = new Graphics()
      .poly([len / 2, 0, -len / 2, wid / 2, -len * 0.3, 0, -len / 2, -wid / 2])
      .fill(SHIP_FILL)
      .stroke({ width: 3, color: SHIP_EDGE });

    // 船最后加:压在敌与弹之上,千敌贴脸时自己不会被糊掉
    this.worldLayer.addChild(ring, this.enemyPc, this.bulletPc, this.shipG);
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

    this.syncParticles(this.enemyParticles, this.enemyPc, this.world.enemies.items, {
      texture: this.enemyTex,
      tints: ENEMY_TINTS,
      alpha,
    });
    this.syncParticles(this.bulletParticles, this.bulletPc, this.world.bullets.items, {
      texture: this.bulletTex,
      tints: [BULLET_TINT],
      alpha,
    });

    this.shipG.position.set(sx, sy);
    this.shipG.rotation = sh;
  }

  private syncParticles(
    particles: Particle[],
    pc: ParticleContainer,
    entities: readonly (Enemy | Bullet)[],
    opts: { texture: Texture; tints: readonly number[]; alpha: number },
  ): void {
    // 扩容:tint/texture 是静态属性,增粒子后需 pc.update() 重传
    if (particles.length < entities.length) {
      while (particles.length < entities.length) {
        const i = particles.length;
        const p = new Particle({
          texture: opts.texture,
          x: OFFSCREEN,
          y: OFFSCREEN,
          anchorX: 0.5,
          anchorY: 0.5,
          tint: opts.tints[i % opts.tints.length]!,
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
