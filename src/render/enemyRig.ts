/**
 * 敌人 cutout 骨架(24 号 issue):把一只怪拆成若干部件,逐部件一个粒子,每帧前向求解一遍 FK。
 *
 * 为什么不上 Spine/DragonBones:那两者一个实例 = 一个 Container + mesh,GDD §13 的
 * **1000 敌 @60fps** 预算在几百只上就穿了;而且要一条现在不存在的编辑器/导出管线。
 * 这里做的是 Spine 非 mesh 模式的内核 —— 部件 + 关节 + 前向运动学,别的一概不要:
 * 于是每只怪仍然只是"几个粒子",ParticleContainer 那条批渲染快路径原样保住
 * (代价只是容器数从每型 1 个变成每型 N 个纹理,GPU 侧就是多几个 draw call)。
 *
 * 铁律:本文件**不 import pixi、不碰 DOM** —— 位姿解算是纯数学,能在 Node 单测里逐帧钉住。
 * 也绝不分配:poseRig 把结果写进调用方给的 Float32Array,热循环里为 1000 只怪调它。
 *
 * 坐标系:部件表写在"单位空间"里 —— 边长 512、原点在生物中心、**+X 右 +Y 下**,
 * 与 round-1 的 512px 候选图逐像素同一套坐标(静止位姿就是照着那张图校准出来的,
 * 见 assets/generated/fal/round-3/results/ledger.json 的 rest_pose_calibration)。
 * 它不是世界坐标也不是"船头朝 +X"的局部坐标:默认仍由渲染层把速度朝向与生成图的
 * 正面偏移合成根角。侧掠者是有意的例外 —— 它靠横向位移表达"侧掠",整只怪始终保持
 * 头在屏幕上方,避免绕行时把有明确头尾的剪影倒过来。
 */

/** 位姿输出的每部件步长:x, y, rotation, scaleX, scaleY */
export const RIG_STRIDE = 5;

/** 单位空间的边长。部件表里的坐标都以它为尺,渲染层按 视觉跨度/RIG_UNIT 换算世界缩放 */
export const RIG_UNIT = 512;

/**
 * 骨架里的一个部件槽位。
 *
 * 位移写成"相对父关节"而不是绝对坐标,是 FK 的全部意义所在:父动子跟,
 * 尾巴甩起来时第二节自动挂在第一节的末端上,不必逐节重算绝对位置(也就不会脱节)。
 */
export interface RigPart {
  /** 部件纹理下标;**同纹理的多个实例(6 片裂瓣 / 4 条爪足)共用一个容器**,靠 phase 错开相位 */
  tex: number;
  /**
   * 关节点在部件纹理内的归一化坐标 = 粒子的 anchorX/anchorY,骨骼绕它转。
   * 取解剖关节而不是图心:绕图心转会让部件在根部张开一道缝(cutout 动画最常见的穿帮)。
   */
  ax: number;
  ay: number;
  /**
   * 父槽位下标;-1 = 直接挂在敌人根上。
   * **必须 < 自身下标** —— poseRig 靠这条按下标单趟前向解完,不排序、不递归、不查表。
   */
  parent: number;
  /** 静止时本关节相对**父关节**的位移(单位空间,在父的局部系里) */
  dx: number;
  dy: number;
  /** 静止时本部件相对**父部件**的转角(rad) */
  rest: number;
  /** 部件尺寸倍率(乘在整只怪的基准缩放上) */
  scale: number;
  /** 摆动幅度(rad):叠加在 rest 上的正弦摆 —— 爬动/甩鞭/点头都是它 */
  swing: number;
  /**
   * 相位偏移(rad)。同纹理多实例**只靠它区分**:6 片裂瓣按 k·2π/6 错开就成了绕圈的蠕动波,
   * 4 条爪足按 k·π/2 错开就成了行进的步态波。齐步走的虫子看着像玩具,错开才像活的。
   */
  phase: number;
  /** 沿局部 X(骨骼长轴)的伸缩幅度,乘在 scale 上 */
  pumpX: number;
  /** 沿局部 Y 的伸缩幅度;与 pumpX **反号**即"挤压-拉伸",读作体积守恒的肌肉收缩 */
  pumpY: number;
}

/** 一型敌人的整套骨架 */
export interface RigDef {
  /** 部件表;下标 = 槽位,父下标必须小于自身(见 RigPart.parent) */
  readonly parts: readonly RigPart[];
  /** 纹理数 = 该型要开的容器数;parts[i].tex ∈ [0, textureCount)。下标即画序,小的在后面 */
  readonly textureCount: number;
  /** 摆动角频率(rad/s) */
  readonly freq: number;
  /**
   * 非 null = 根骨不跟随速度,始终使用这个世界角(rad)。
   * 侧掠者用它保持头朝屏幕上方:移动方向由位移、爪足与尾鞭交代,不靠整只怪翻转。
   */
  readonly fixedRootAngle: number | null;
  /**
   * 非 0 = 这一型不跟速度朝向,根角改用 time × spin(蜂群蛭:口器绕圈就是它的"活着")。
   * 与单件贴图年代 ENEMY_ANIM.spin 同一条口径,换骨架不改变这一型转不转。
   */
  readonly spin: number;
}

/** 单个槽位的构造:把可选项塞上缺省,让部件表只写那一件真正在意的字段 */
function part(p: Partial<RigPart> & Pick<RigPart, 'tex' | 'parent'>): RigPart {
  return {
    tex: p.tex,
    parent: p.parent,
    ax: p.ax ?? 0.5,
    ay: p.ay ?? 0.5,
    dx: p.dx ?? 0,
    dy: p.dy ?? 0,
    rest: p.rest ?? 0,
    scale: p.scale ?? 1,
    swing: p.swing ?? 0,
    phase: p.phase ?? 0,
    pumpX: p.pumpX ?? 0,
    pumpY: p.pumpY ?? 0,
  };
}

const D2R = Math.PI / 180;

/**
 * 蜂群蛭(KIND_SWARM):环状口器盘 + 6 片裂瓣的放射脉动。
 *
 * 部件只有两张图,却是全场最多的一型 —— 每只 7 个粒子,分摊在 2 个容器里。
 * 裂瓣的相位按 k·2π/6 递增:绕着口器转一圈的蠕动波,而不是 6 片一起呼吸。
 * pumpX/pumpY 反号(+0.14/-0.07)是沿瓣长伸缩、同时横向收窄 = 吸盘一张一合的读数;
 * 这一型本来就靠"口器绕圈"交代活着(spin),脉动是加在它之上的第二条通道。
 *
 * 裂瓣轴向 29° + k·60° 不是拍脑袋:它是从 round-1 原图量出来的真实瓣位
 * (径向极值的 6 个峰),照着切图、照着摆,装配 IoU 0.900。
 * 关节点取瓣根(ax=0,即纹理左缘)而不是瓣心:绕瓣心转会把瓣根甩出核心盘之外露馅。
 */
const LEECH_LOBE_AXIS = 29;
/**
 * 瓣根关节到生物中心的距离(单位空间)。
 *
 * 它不是拍脑袋的 —— 裂瓣是从原图上按 **±45° 扇区、r ≥ 40** 切下来的,轴转到纹理 +X,
 * 于是裁剪框最左那条边落在两个内角上,离中心 40 × cos45° = 28.2 而不是 40。
 * 切 ±45° 而不是 ±31°(瓣间隔 60°,45 让相邻瓣重叠 30°)是**必须的**:
 * 按 60° 半宽以内切,瓣根会被截窄成一条细颈,六片瓣在画面上就散成"轮毂 + 六个挂件",
 * 而原图那圈瓣在根部是宽幅融合的。重叠区双绘的是同一份材料,正好把凹口填回原样。
 */
const LEECH_LOBE_ROOT = 28.2;
/** 生物中心投影到裁剪图内的纵向比例(切图时实测,不是 0.5 —— 真实裂瓣并非严格轴对称) */
const LEECH_LOBE_PIVOT_Y = 0.5598;

export const RIG_SWARM: RigDef = {
  textureCount: 2, // 0 = lobe(在后), 1 = core(在前,压住 6 片瓣根的直边切口)
  freq: 2.0,
  fixedRootAngle: null,
  spin: 0.9,
  parts: [
    // 0:核心口器盘 —— 骨架的根,只做整体呼吸
    part({ tex: 1, parent: -1, pumpX: 0.05, pumpY: 0.05 }),
    // 1..6:6 片裂瓣,同纹理同参数,只有 rest 与 phase 逐片递增
    ...Array.from({ length: 6 }, (_, k) => {
      const th = (LEECH_LOBE_AXIS + k * 60) * D2R;
      return part({
        tex: 0,
        parent: 0,
        ax: 0, // 瓣根 = 纹理左缘(扇区的内边)
        ay: LEECH_LOBE_PIVOT_Y,
        dx: Math.cos(th) * LEECH_LOBE_ROOT,
        dy: Math.sin(th) * LEECH_LOBE_ROOT,
        rest: th,
        swing: 0.14,
        phase: (k * Math.PI * 2) / 6,
        pumpX: 0.14,
        pumpY: -0.07,
      });
    }),
  ],
};

/**
 * 把静止位姿的头关节(149.9,-65.5)转到根原点正上方所需的角度。
 * 取整到 -66° 是美术旋钮:头仍保留一点自然的右偏,但任何移动方向都不会再把它翻到下方。
 */
export const STRAFER_UPRIGHT_ANGLE = -66 * D2R;

/**
 * 侧掠者(KIND_STRAFER):头 + 胸 + 4 爪足 + 两节尾链。
 *
 * 这一型验的是**链式甩鞭**:tail-b 挂在 tail-a 上(parent 指向 6),
 * 前一节摆 0.09、后一节摆 0.20 且相位滞后 0.6 rad —— 鞭梢比鞭身走得晚、甩得大,
 * 这就是鞭子看起来是鞭子而不是两根棍的全部原因。
 * 爪足 4 条按 k·π/2 错开成行进波(与蜂群蛭的绕圈波同一条"错相位"口径)。
 *
 * 尾巴比 round-1 原图长约两成:tail-b 接在 tail-a 末端之后而不是挤进原剪影里
 * (模型切尾巴的位置与原图画法不同,硬挤只会让第二节几乎全被压住)。
 * 多出来的那一截换到的是真正甩得开的第二节 —— 这一型的看点就在尾巴上,值这个偏差。
 */
export const RIG_STRAFER: RigDef = {
  textureCount: 5, // 画序:0 tail-b → 1 tail-a → 2 leg → 3 thorax → 4 head
  freq: 4.5,
  fixedRootAngle: STRAFER_UPRIGHT_ANGLE,
  spin: 0,
  parts: [
    // 0:胸(根)。整只怪的位姿由它起算,自身只做极轻的横滚
    part({ tex: 3, parent: -1, dx: 10, dy: -115, swing: 0.02, pumpX: 0.02, pumpY: 0.02 }),
    // 1:铬色喙头 —— 关节取喙根(ax=0.18)而不是图心,点头才像点头、不像整颗头平移
    part({ tex: 4, parent: 0, ax: 0.18, ay: 0.55, dx: 139.9, dy: 49.5, swing: 0.07, phase: Math.PI * 0.5 }),
    // 2..5:4 条爪足,关节取足根球(ay=0.08);0.55 缩放是量出来的 —— 分件图把这块小部件画大了近一倍
    ...[-64, -34, 8, 38].map((dx, k) =>
      part({
        tex: 2,
        parent: 0,
        ax: 0.5,
        ay: 0.08,
        dx,
        dy: 53,
        scale: 0.55,
        swing: 0.3,
        phase: (k * Math.PI) / 2,
      }),
    ),
    // 6:尾上段(外弧+上尾),关节取粗端切面
    part({ tex: 1, parent: 0, ax: 0.08, ay: 0.08, dx: -44, dy: -39, rest: 62 * D2R, swing: 0.09, phase: Math.PI }),
    // 7:尾尖,挂在尾上段末端 —— 位移已换算到 tail-a 的局部系
    part({
      tex: 0,
      parent: 6,
      ax: 0.07,
      ay: 0.7,
      dx: 222.6,
      dy: 220.4,
      rest: 16 * D2R,
      scale: 0.7,
      swing: 0.2,
      phase: Math.PI + 0.6,
    }),
  ],
};

/**
 * 逐型骨架表。**下标 === EnemyKind**(与 data/enemies.ts 的 ENEMIES 同序),
 * null = 这一型还没做骨架,渲染层照旧走单件贴图那条路 —— 分型回退,做一型接一型,
 * 与"坏一张图不塌一局"同一条兜底口径。
 */
export const ENEMY_RIGS: readonly (RigDef | null)[] = [
  RIG_SWARM, // KIND_SWARM 蜂群蛭
  RIG_STRAFER, // KIND_STRAFER 侧掠者
  null, // KIND_TRAILER 尾随蛆
  null, // KIND_BEETLE 冲撞甲虫
  null, // KIND_SPORE 孢子炮手
];

/**
 * 前向求解一只怪的整套部件位姿,写进 out(长度需 ≥ parts.length × RIG_STRIDE)。
 *
 * 单趟 for:第 i 个槽位只读 out 里下标更小的父槽位(RigPart.parent 的约束保证了这一点),
 * 所以一遍就解完,没有递归也没有第二趟。每部件两次三角函数 + 十来次乘加,
 * 1000 只 × 7 部件 ≈ 7000 次,和它省掉的 1000 次 Container 变换比可以忽略。
 *
 * @param bodyAngle 根角(rad):已包含朝向与生成图的正面偏移,由调用方合成
 * @param bodyScale 单位空间 → 世界像素的基准缩放
 * @param phase     本帧动画相位(rad):调用方按 animClock × freq + animSeed × 2π 算好,
 *                  相位而不是时间进来 —— 状态机要给某一型提频(前摇发抖)时不必改这里
 * @param swingMul  摆幅总倍率:1 = 常态,冲刺/前摇由调用方放大或压扁,0 = 完全静止(静止位姿)
 */
export function poseRig(
  rig: RigDef,
  bodyX: number,
  bodyY: number,
  bodyAngle: number,
  bodyScale: number,
  phase: number,
  swingMul: number,
  out: Float32Array,
): void {
  const parts = rig.parts;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const o = i * RIG_STRIDE;
    let px: number;
    let py: number;
    let pa: number;
    if (p.parent < 0) {
      px = bodyX;
      py = bodyY;
      pa = bodyAngle;
    } else {
      const po = p.parent * RIG_STRIDE;
      px = out[po]!;
      py = out[po + 1]!;
      pa = out[po + 2]!;
    }
    // 关节位移在**父的动画后朝向**里旋转 —— 用静止朝向的话,父一动子就脱节
    const ca = Math.cos(pa);
    const sa = Math.sin(pa);
    out[o] = px + (p.dx * ca - p.dy * sa) * bodyScale;
    out[o + 1] = py + (p.dx * sa + p.dy * ca) * bodyScale;
    const w = Math.sin(phase + p.phase);
    out[o + 2] = pa + p.rest + p.swing * swingMul * w;
    const s = bodyScale * p.scale;
    out[o + 3] = s * (1 + p.pumpX * swingMul * w);
    out[o + 4] = s * (1 + p.pumpY * swingMul * w);
  }
}

/** 一只怪的位姿缓冲需要多少个 float */
export function rigBufferLength(rig: RigDef): number {
  return rig.parts.length * RIG_STRIDE;
}

/** 该型每只怪要在 tex 号容器里占几个粒子(= 该纹理的实例数) */
export function rigInstanceCount(rig: RigDef, tex: number): number {
  let n = 0;
  for (let i = 0; i < rig.parts.length; i++) if (rig.parts[i]!.tex === tex) n++;
  return n;
}
