/**
 * 渲染层:只读 sim 状态画图,在 prev/cur 位置间按 alpha 插值。
 * 规则:render 可以 import sim,sim 永不 import render。
 * 大批量实体走 ParticleContainer(GDD §13 性能预算的关键)。
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
import type { Bullet, Enemy, World } from '../sim/world';
import { WORLD_RADIUS } from '../sim/world';

/** 未使用粒子的"停车位":粒子只增不删,多余的挪出视野(避免运行期增删 GPU 缓冲) */
const OFFSCREEN = 1e6;

// 敌我色域完全分离(GDD §12):敌 = 红紫暖色,我方/弹 = 冷色
const ENEMY_TINTS = [0xff4d6d, 0xe84393, 0xc44dff, 0x9b59ff, 0xff6348, 0xd63031] as const;
const BULLET_TINT = 0x9adcff;

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
  private marker: Graphics;

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

    // 定位参考:场地边界圈 + 吸引点标记(02 号 issue 后换成船)
    const ring = new Graphics().circle(0, 0, WORLD_RADIUS).stroke({ width: 3, color: 0x1c2740 });
    this.marker = new Graphics().circle(0, 0, 12).stroke({ width: 2, color: BULLET_TINT });

    this.worldLayer.addChild(ring, this.enemyPc, this.bulletPc, this.marker);
    app.stage.addChild(this.worldLayer);
  }

  /** 每渲染帧调用。alpha ∈ [0,1):在上一逻辑帧与当前逻辑帧之间插值 */
  sync(alpha: number): void {
    const screen = this.app.screen;
    // 镜头:骨架阶段固定俯瞰全场;02 号 issue 改为跟船 + 15% look-ahead(GDD §3.3)
    const scale = Math.min(screen.width, screen.height) / (WORLD_RADIUS * 2.15);
    this.worldLayer.position.set(screen.width / 2, screen.height / 2);
    this.worldLayer.scale.set(scale);

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

    this.marker.position.set(this.world.target.x, this.world.target.y);
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
