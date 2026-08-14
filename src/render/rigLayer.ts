/**
 * 骨架的 pixi 绑定层(24 号 issue):把 enemyRig.ts 解出来的部件位姿写进粒子。
 *
 * 分成两个文件是有意的:enemyRig.ts 是纯数学(不 import pixi,能在 Node 里逐帧钉住),
 * 这里只负责"容器/粒子/纹理"这些必须有 GPU 上下文才谈得上的事。
 *
 * **一容器一纹理**那条约束原样保住 —— 单件贴图年代是"每型一个容器",现在是
 * "每型每部件纹理一个容器"。同一张纹理的多个实例(6 片裂瓣 / 4 条爪足)共用一个容器,
 * 于是容器数是**部件纹理数**而不是部件数:蜂群蛭 2 个、侧掠者 5 个。
 * 多出来的那几个 draw call 在 GPU 侧可忽略(与当年为 tint 分容器同一笔账),
 * 换到的是每只怪从"一张会飘的贴纸"变成"会爬会甩的活物"。
 */
import { Particle, ParticleContainer, type Rectangle, type Texture } from 'pixi.js';
import { poseRig, RIG_STRIDE, type RigDef, type RigRootPose, rigBufferLength } from './enemyRig';

/** 屏外停车位:多出来的粒子丢到这里,与单件贴图那条路同一个常量口径 */
const OFFSCREEN = 1e6;

/** RigLayer 每帧要的那点敌人字段。写成结构类型而不是 import Enemy —— 这一层不该认识 sim */
export interface RigEntity {
  x: number;
  y: number;
  px: number;
  py: number;
  vx: number;
  vy: number;
  state: number;
  lockX: number;
  lockY: number;
  animSeed: number;
  hitFlash: number;
}

/** 逐只怪的动画驱动读数,由 RigDriver 写进调用方的 scratch(绝不 new) */
export interface RigDrive {
  /** 相位倍率:前摇发抖 = 提频,硬直 = 降频 */
  freqMul: number;
  /** 摆幅倍率:0 = 静止位姿,>1 = 加剧 */
  swingMul: number;
}

/**
 * 状态机 → 动画的映射。做成一个**建一次就长期持有**的对象而不是每帧现传闭包:
 * 热循环里每只怪要调它三次,每帧现造闭包等于每帧上千次堆分配。
 * RigLayer 因此不认识 ST_* 状态码,也不认识生成图的正面偏移 —— 那些都是渲染层的口径。
 */
export interface RigDriver {
  /** 根姿态:朝向角 + 左右镜像;targetX/Y 是本帧插值后的飞船位置 */
  rootPose(
    e: RigEntity,
    bodyX: number,
    bodyY: number,
    animClock: number,
    rig: RigDef,
    targetX: number,
    targetY: number,
    out: RigRootPose,
  ): void;
  /** 按状态机写 out 的两个倍率 */
  drive(e: RigEntity, out: RigDrive): void;
  /** 逐只怪的 tint(受击闪白) */
  tint(e: RigEntity): number;
}

/**
 * 一型敌人的一套骨架容器(普通与精英各建一套,差别只有 baseScale)。
 *
 * 粒子只增不删,与单件贴图那条路同一条口径:面板改出怪占比后各型留着自己的历史峰值
 * "停车位"不回落,拿一点常驻显存换掉运行期的缓冲重建。
 */
export class RigLayer {
  /** 下标 = 部件纹理号 = 画序(小的在后面);调用方按序 addChild 就得到正确的前后关系 */
  readonly containers: ParticleContainer[] = [];
  private readonly particles: Particle[][] = [];
  /** 位姿 scratch:整层共用一份,逐只怪重写 —— 每帧为上千只怪解位姿,绝不 new */
  private readonly pose: Float32Array;
  /** 驱动读数 scratch:同上 */
  private readonly driveScratch: RigDrive = { freqMul: 1, swingMul: 1 };
  /** 根姿态 scratch:侧掠者每帧会据飞船位置改左右与倾角,同样禁止逐只分配 */
  private readonly rootScratch: RigRootPose = { angle: 0, flipX: 1 };
  /** instanceCount[t] = 每只怪在 t 号容器里占几个粒子 */
  private readonly instanceCount: number[] = [];
  /** partSlot[i] = 第 i 个槽位在它那张纹理内部的实例序号 */
  private readonly partSlot: number[] = [];
  /** slotsByTex[t] = 用这张纹理的槽位下标(建粒子时按它取解剖关节当锚点) */
  private readonly slotsByTex: number[][] = [];

  constructor(
    private readonly rig: RigDef,
    private readonly textures: readonly Texture[],
    bounds: Rectangle,
    /** 单位空间 → 世界像素;精英传入已乘过 ELITE.scale 的值 */
    private readonly baseScale: number,
  ) {
    this.pose = new Float32Array(rigBufferLength(rig));
    for (let t = 0; t < rig.textureCount; t++) {
      this.instanceCount.push(0);
      this.particles.push([]);
      this.slotsByTex.push([]);
      this.containers.push(
        new ParticleContainer({
          // 与单件贴图那条路同样的三项例外:vertex(呼吸/伸缩逐帧改缩放,烤在四角顶点里)、
          // rotation(每根骨都在转)、color(受击闪白逐粒子改 tint)
          dynamicProperties: { position: true, rotation: true, vertex: true, color: true },
          boundsArea: bounds,
          texture: textures[t]!,
        }),
      );
    }
    for (let i = 0; i < rig.parts.length; i++) {
      const t = rig.parts[i]!.tex;
      this.partSlot.push(this.instanceCount[t]!);
      this.instanceCount[t]!++;
      this.slotsByTex[t]!.push(i);
    }
  }

  /**
   * 把一桶同型敌人的位姿写进粒子。
   *
   * @param alpha     渲染插值系数(与单件贴图那条路同一口径:60Hz 逻辑帧在高刷屏上不插值就是顿挫)
   * @param animClock 渲染层的动画时钟(秒)
   */
  sync(
    bucket: readonly RigEntity[],
    alpha: number,
    animClock: number,
    targetX: number,
    targetY: number,
    driver: RigDriver,
  ): void {
    const rig = this.rig;
    const parts = rig.parts;
    const pose = this.pose;
    const drive = this.driveScratch;
    const root = this.rootScratch;

    // 扩容:纹理是静态属性,增粒子后需 update() 重传;锚点在建粒子时按槽位一次写死
    for (let t = 0; t < rig.textureCount; t++) {
      const perEnemy = this.instanceCount[t]!;
      const need = bucket.length * perEnemy;
      const arr = this.particles[t]!;
      if (arr.length < need) {
        const pc = this.containers[t]!;
        const slots = this.slotsByTex[t]!;
        while (arr.length < need) {
          const p = parts[slots[arr.length % perEnemy]!]!;
          const particle = new Particle({
            texture: this.textures[t]!,
            x: OFFSCREEN,
            y: OFFSCREEN,
            anchorX: p.ax,
            anchorY: p.ay,
            tint: 0xffffff,
          });
          pc.addParticle(particle);
          arr.push(particle);
        }
        pc.update();
      }
    }

    for (let j = 0; j < bucket.length; j++) {
      const e = bucket[j]!;
      const x = e.px + (e.x - e.px) * alpha;
      const y = e.py + (e.y - e.py) * alpha;
      driver.drive(e, drive);
      driver.rootPose(e, x, y, animClock, rig, targetX, targetY, root);
      const phase = animClock * rig.freq * drive.freqMul + e.animSeed * Math.PI * 2;
      poseRig(rig, x, y, root.angle, this.baseScale, phase, drive.swingMul, pose, root.flipX);
      const tint = driver.tint(e);
      for (let i = 0; i < parts.length; i++) {
        const t = parts[i]!.tex;
        const particle = this.particles[t]![j * this.instanceCount[t]! + this.partSlot[i]!]!;
        const o = i * RIG_STRIDE;
        particle.x = pose[o]!;
        particle.y = pose[o + 1]!;
        particle.rotation = pose[o + 2]!;
        particle.scaleX = pose[o + 3]!;
        particle.scaleY = pose[o + 4]!;
        particle.tint = tint;
      }
    }

    // 本帧用不到的粒子挪到屏外(不销毁,见类注释的"只增不删")
    for (let t = 0; t < rig.textureCount; t++) {
      const arr = this.particles[t]!;
      for (let k = bucket.length * this.instanceCount[t]!; k < arr.length; k++) {
        const particle = arr[k]!;
        particle.x = OFFSCREEN;
        particle.y = OFFSCREEN;
      }
    }
  }
}
