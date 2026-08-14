import { describe, expect, it } from 'vitest';
import { KIND_BEETLE, KIND_SPORE, KIND_STRAFER, KIND_SWARM, KIND_TRAILER } from '../data/enemies';
import {
  ENEMY_RIGS,
  poseRig,
  RIG_STRAFER,
  RIG_STRIDE,
  RIG_SWARM,
  STRAFER_TARGET_TURN_LIMIT,
  targetFacingRootPose,
  type RigDef,
  type RigRootPose,
  rigBufferLength,
  rigInstanceCount,
} from './enemyRig';

/**
 * 骨架是纯数学(不 import pixi),于是能在 Node 里逐帧钉住。这里钉三类:
 *  1. **静止位姿**:swingMul=0 时各关节必须落回校准值 —— 部件表是从 round-1 原图量出来再抄进 TS 的,
 *     抄错一个数在画面上只是"某块歪了一点",很难一眼看出,但在这里会当场红;
 *  2. **FK 传导**:父动子必须跟着动(甩鞭/爬动全靠它),且刚体变换该保持的性质要保持;
 *  3. **结构不变量**:parent < 自身(poseRig 单趟前向解完的前提)、tex 不越界。
 * 画图本身需要 WebGL 上下文,不在这里测。
 */

const D2R = Math.PI / 180;

/** 取第 i 个槽位的位姿读数 */
function slot(out: Float32Array, i: number) {
  const o = i * RIG_STRIDE;
  return { x: out[o]!, y: out[o + 1]!, rot: out[o + 2]!, sx: out[o + 3]!, sy: out[o + 4]! };
}

/** 在原点、零转角、单位缩放下解一次静止位姿(= 部件表里写的那套单位空间坐标) */
function restPose(rig: RigDef): Float32Array {
  const out = new Float32Array(rigBufferLength(rig));
  poseRig(rig, 0, 0, 0, 1, 0, 0, out);
  return out;
}

/** 侧掠者在原点,按目标位置解根姿态后求一次静止骨架 */
function straferFacingPose(targetX: number, targetY: number): {
  root: RigRootPose;
  pose: Float32Array;
} {
  const root: RigRootPose = { angle: 0, flipX: 1 };
  targetFacingRootPose(0, 0, targetX, targetY, RIG_STRAFER.targetFacing!, root);
  const pose = new Float32Array(rigBufferLength(RIG_STRAFER));
  poseRig(RIG_STRAFER, 0, 0, root.angle, 1, 0, 0, pose, root.flipX);
  return { root, pose };
}

describe('结构不变量', () => {
  const all: [string, RigDef][] = [
    ['蜂群蛭', RIG_SWARM],
    ['侧掠者', RIG_STRAFER],
  ];

  it.each(all)('%s:父槽位下标严格小于自身 —— poseRig 单趟前向解完的前提', (_n, rig) => {
    rig.parts.forEach((p, i) => {
      expect(p.parent).toBeLessThan(i);
      expect(p.parent).toBeGreaterThanOrEqual(-1);
    });
  });

  it.each(all)('%s:纹理下标不越界,且每张纹理都至少有一个实例(不开空容器)', (_n, rig) => {
    let total = 0;
    for (let t = 0; t < rig.textureCount; t++) {
      const n = rigInstanceCount(rig, t);
      expect(n).toBeGreaterThan(0);
      total += n;
    }
    // 实例总数 = 槽位数:没有槽位指向 textureCount 之外
    expect(total).toBe(rig.parts.length);
    for (const p of rig.parts) expect(p.tex).toBeLessThan(rig.textureCount);
  });

  it('逐型骨架表下标 === EnemyKind;未做骨架的型是 null(渲染层据此回退单件贴图)', () => {
    expect(ENEMY_RIGS[KIND_SWARM]).toBe(RIG_SWARM);
    expect(ENEMY_RIGS[KIND_STRAFER]).toBe(RIG_STRAFER);
    expect(ENEMY_RIGS[KIND_TRAILER]).toBeNull();
    expect(ENEMY_RIGS[KIND_BEETLE]).toBeNull();
    expect(ENEMY_RIGS[KIND_SPORE]).toBeNull();
  });

  it('侧掠者不再钉死根角:它朝飞船左右换向,倾角限制为 30°', () => {
    expect(RIG_SWARM.fixedRootAngle).toBeNull();
    expect(RIG_SWARM.targetFacing).toBeNull();
    expect(RIG_STRAFER.fixedRootAngle).toBeNull();
    expect(RIG_STRAFER.targetFacing?.maxTurn).toBeCloseTo(STRAFER_TARGET_TURN_LIMIT, 9);
    expect(RIG_STRAFER.spin).toBe(0);
  });

  it('poseRig 只写 rigBufferLength 个 float,不越界写脏后面的怪', () => {
    const rig = RIG_STRAFER;
    const n = rigBufferLength(rig);
    const out = new Float32Array(n + 4);
    out.fill(-999);
    poseRig(rig, 0, 0, 0, 1, 0, 1, out);
    for (let i = n; i < out.length; i++) expect(out[i]).toBe(-999);
  });
});

describe('静止位姿(swingMul=0):关节落在从 round-1 原图量出来的校准值上', () => {
  it('蜂群蛭:核心盘在原点,6 片裂瓣的根均匀分布在 r=28.2 的圆上、间隔 60°', () => {
    const out = restPose(RIG_SWARM);
    const core = slot(out, 0);
    expect(core.x).toBeCloseTo(0, 6);
    expect(core.y).toBeCloseTo(0, 6);

    // 28.2 = 切图时的 r₀(40) × cos(半角 45°):裁剪框最左那条边落在扇区的两个内角上,
    // 不在轴上。把它当 40 会让六片瓣整体外移、瓣根从核心盘下面露出来(改过一次的坑)
    for (let k = 0; k < 6; k++) {
      const lobe = slot(out, 1 + k);
      const th = (29 + k * 60) * D2R;
      expect(Math.hypot(lobe.x, lobe.y)).toBeCloseTo(28.2, 4);
      expect(lobe.x).toBeCloseTo(Math.cos(th) * 28.2, 4);
      expect(lobe.y).toBeCloseTo(Math.sin(th) * 28.2, 4);
      // 瓣自身朝向 = 它所在的轴向:切图时已把瓣轴转到纹理 +X,于是 rest 直接就是轴角
      expect(lobe.rot).toBeCloseTo(th, 6);
    }
  });

  it('侧掠者:头/爪足/尾链的关节落在校准位置(单位空间,+X 右 +Y 下)', () => {
    const out = restPose(RIG_STRAFER);
    expect(slot(out, 0)).toMatchObject({ x: 10, y: -115 }); // 胸(根)
    const head = slot(out, 1);
    expect(head.x).toBeCloseTo(149.9, 3);
    expect(head.y).toBeCloseTo(-65.5, 3);
    // 4 条爪足同一条下缘线,x 从左到右
    const legX = [-54, -24, 18, 48];
    legX.forEach((x, k) => {
      const leg = slot(out, 2 + k);
      expect(leg.x).toBeCloseTo(x, 3);
      expect(leg.y).toBeCloseTo(-62, 3);
    });
    const tailA = slot(out, 6);
    expect(tailA.x).toBeCloseTo(-34, 3);
    expect(tailA.y).toBeCloseTo(-154, 3);
    expect(tailA.rot).toBeCloseTo(62 * D2R, 6);
    // 尾尖挂在尾上段末端:位移写在 tail-a 的局部系里,解出来要落回校准的绝对位置
    const tailB = slot(out, 7);
    expect(tailB.x).toBeCloseTo(-124, 0);
    expect(tailB.y).toBeCloseTo(146, 0);
    expect(tailB.rot).toBeCloseTo(78 * D2R, 6);
  });

  it('侧掠者会朝飞船左右换向,左向是整套骨架镜像而不是把头继续固定在上方', () => {
    const right = straferFacingPose(100, 0);
    const left = straferFacingPose(-100, 0);
    expect(right.root.flipX).toBe(1);
    expect(left.root.flipX).toBe(-1);

    const rightHead = slot(right.pose, 1);
    const leftHead = slot(left.pose, 1);
    expect(rightHead.x).toBeGreaterThan(160);
    expect(leftHead.x).toBeLessThan(-160);
    expect(Math.abs(rightHead.y)).toBeLessThan(1);
    expect(Math.abs(leftHead.y)).toBeLessThan(1);

    // 左向位姿应是右向位姿沿屏幕 Y 轴的镜像；纹理也靠负 scaleX 真正翻面。
    for (let i = 0; i < RIG_STRAFER.parts.length; i++) {
      expect(slot(left.pose, i).x).toBeCloseTo(-slot(right.pose, i).x, 3);
      expect(slot(left.pose, i).y).toBeCloseTo(slot(right.pose, i).y, 3);
      expect(slot(right.pose, i).sx).toBeGreaterThan(0);
      expect(slot(left.pose, i).sx).toBeLessThan(0);
    }
  });

  it('飞船在斜上/斜下时只倾转,根朝向严格钳在水平轴上下 30°', () => {
    const belowRight = slot(straferFacingPose(10, 1000).pose, 1);
    const belowLeft = slot(straferFacingPose(-10, 1000).pose, 1);
    const aboveRight = slot(straferFacingPose(10, -1000).pose, 1);
    expect(Math.atan2(belowRight.y, belowRight.x)).toBeCloseTo(STRAFER_TARGET_TURN_LIMIT, 5);
    expect(Math.atan2(belowLeft.y, belowLeft.x)).toBeCloseTo(
      Math.PI - STRAFER_TARGET_TURN_LIMIT,
      5,
    );
    expect(Math.atan2(aboveRight.y, aboveRight.x)).toBeCloseTo(-STRAFER_TARGET_TURN_LIMIT, 5);
  });

  it('swingMul=0 时缩放退化成纯静态倍率(不呼吸),爪足带着自己的 0.55', () => {
    const out = restPose(RIG_STRAFER);
    expect(slot(out, 0).sx).toBeCloseTo(1, 6);
    expect(slot(out, 2).sx).toBeCloseTo(0.55, 6);
    expect(slot(out, 2).sy).toBeCloseTo(0.55, 6);
    expect(slot(out, 7).sx).toBeCloseTo(0.7, 6);
  });
});

describe('FK 传导', () => {
  it('根角旋转 θ,整只怪绕根原点刚性转 θ —— 位置与朝向一起转,部件间距不变', () => {
    const rig = RIG_STRAFER;
    const a = new Float32Array(rigBufferLength(rig));
    const b = new Float32Array(rigBufferLength(rig));
    const th = 0.7;
    poseRig(rig, 0, 0, 0, 1, 0, 0, a);
    poseRig(rig, 0, 0, th, 1, 0, 0, b);
    for (let i = 0; i < rig.parts.length; i++) {
      const p = slot(a, i);
      const q = slot(b, i);
      expect(q.x).toBeCloseTo(p.x * Math.cos(th) - p.y * Math.sin(th), 3);
      expect(q.y).toBeCloseTo(p.x * Math.sin(th) + p.y * Math.cos(th), 3);
      expect(q.rot).toBeCloseTo(p.rot + th, 5);
    }
  });

  it('缩放只放大位移,不动朝向', () => {
    const rig = RIG_SWARM;
    const a = new Float32Array(rigBufferLength(rig));
    const b = new Float32Array(rigBufferLength(rig));
    poseRig(rig, 0, 0, 0, 1, 0, 0, a);
    poseRig(rig, 0, 0, 0, 3, 0, 0, b);
    for (let i = 0; i < rig.parts.length; i++) {
      expect(slot(b, i).x).toBeCloseTo(slot(a, i).x * 3, 4);
      expect(slot(b, i).y).toBeCloseTo(slot(a, i).y * 3, 4);
      expect(slot(b, i).rot).toBeCloseTo(slot(a, i).rot, 6);
    }
  });

  it('父动子跟:尾上段一摆,尾尖的**位置**跟着走 —— 这条塌了尾巴就会脱节', () => {
    const rig = RIG_STRAFER;
    const still = new Float32Array(rigBufferLength(rig));
    const swung = new Float32Array(rigBufferLength(rig));
    poseRig(rig, 0, 0, 0, 1, 0, 0, still);
    // 相位取 π/2:sin=1,各槽位都摆到幅值上
    poseRig(rig, 0, 0, 0, 1, Math.PI / 2, 1, swung);
    const tailAMoved = Math.abs(slot(swung, 6).rot - slot(still, 6).rot);
    expect(tailAMoved).toBeGreaterThan(0.01);
    const tipShift = Math.hypot(
      slot(swung, 7).x - slot(still, 7).x,
      slot(swung, 7).y - slot(still, 7).y,
    );
    // 尾尖挂在尾上段末端(约 300 单位远),父转 0.09 rad 就该把它推开二十几个单位
    expect(tipShift).toBeGreaterThan(10);
  });

  it('鞭梢摆得比鞭身大且相位滞后 —— 两根一起等幅同相摆的是棍子不是鞭子', () => {
    const rig = RIG_STRAFER;
    const a = rig.parts[6]!; // tail-a
    const b = rig.parts[7]!; // tail-b
    expect(b.swing).toBeGreaterThan(a.swing);
    expect(b.phase).not.toBeCloseTo(a.phase, 3);
  });

  it('同纹理多实例靠相位错开:6 片裂瓣 / 4 条爪足的 phase 互不相同', () => {
    const lobes = RIG_SWARM.parts.filter((p) => p.tex === 0).map((p) => p.phase);
    expect(new Set(lobes).size).toBe(6);
    const legs = RIG_STRAFER.parts.filter((p) => p.tex === 2).map((p) => p.phase);
    expect(new Set(legs).size).toBe(4);
  });

  it('swingMul 线性缩放摆幅:0 = 静止位姿,放大即整体加剧(冲刺/前摇由调用方推它)', () => {
    const rig = RIG_SWARM;
    const rest = restPose(rig);
    const half = new Float32Array(rigBufferLength(rig));
    const full = new Float32Array(rigBufferLength(rig));
    poseRig(rig, 0, 0, 0, 1, Math.PI / 2, 0.5, half);
    poseRig(rig, 0, 0, 0, 1, Math.PI / 2, 1, full);
    const i = 1; // 第一片裂瓣
    const dHalf = slot(half, i).rot - slot(rest, i).rot;
    const dFull = slot(full, i).rot - slot(rest, i).rot;
    expect(dHalf).toBeCloseTo(dFull / 2, 6);
    expect(Math.abs(dFull)).toBeGreaterThan(0.01);
  });
});
