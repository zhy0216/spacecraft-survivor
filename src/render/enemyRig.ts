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
 * 正面偏移合成根角。侧掠者是有意的例外 —— 它不追随自身速度,而是左右翻面朝向飞船,
 * 再在水平方向上下各留 30° 倾转,让横向切入的头尾关系始终可读。
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
   * 当前骨架都不用；保留给真正需要世界系固定朝向的后续敌型。
   */
  readonly fixedRootAngle: number | null;
  /**
   * 非 null = 根骨左右翻面朝向目标,并把倾角限制在水平轴上下 maxTurn 内。
   * forwardAngle 是静止骨架里“本体中心 → 头”的原始角,用于把分件图校准到水平朝向。
   */
  readonly targetFacing: RigTargetFacing | null;
  /**
   * 非 0 = 这一型不跟速度朝向,根角改用 time × spin(蜂群蛭:口器绕圈就是它的"活着")。
   * 与单件贴图年代 ENEMY_ANIM.spin 同一条口径,换骨架不改变这一型转不转。
   */
  readonly spin: number;
}

/** 左右翻面朝向目标时的骨架校准参数 */
export interface RigTargetFacing {
  /** 静止骨架内“本体中心 → 头”的原始角(rad) */
  readonly forwardAngle: number;
  /** 相对水平朝向允许的最大倾角(rad) */
  readonly maxTurn: number;
}

/** 根骨最终姿态:rotation 配合 scaleX 的符号共同完成左右换向 */
export interface RigRootPose {
  angle: number;
  flipX: 1 | -1;
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
  targetFacing: null,
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

/** 静止骨架里“本体中心 → 头关节(149.9,-65.5)”的原始朝向 */
export const STRAFER_FORWARD_ANGLE = Math.atan2(-65.5, 149.9);
/** 侧掠者面向飞船时相对水平轴允许的最大倾角:上下各 30° */
export const STRAFER_TARGET_TURN_LIMIT = 30 * D2R;

/**
 * 解出“左右翻面 + 有限倾转”的根姿态,写进 out(热路径零分配)。
 *
 * 侧掠者的主体保持横向剪影:目标在右就用原图,目标在左就沿本地 Y 轴镜像整套骨架；
 * 垂直分量只负责让头上下倾斜,并钳在 ±maxTurn,不会因为从船顶/船底掠过而整只倒立。
 */
export function targetFacingRootPose(
  bodyX: number,
  bodyY: number,
  targetX: number,
  targetY: number,
  facing: RigTargetFacing,
  out: RigRootPose,
): void {
  const dx = targetX - bodyX;
  const dy = targetY - bodyY;
  const flipX: 1 | -1 = dx < 0 ? -1 : 1;
  const rawTilt = Math.atan2(dy, Math.abs(dx)) * flipX;
  const tilt = Math.max(-facing.maxTurn, Math.min(facing.maxTurn, rawTilt));
  out.flipX = flipX;
  // 镜像会把原始正面角 θ 变成 π-θ,所以左右两边的校准项符号相反。
  out.angle = tilt - flipX * facing.forwardAngle;
}

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
  fixedRootAngle: null,
  targetFacing: {
    forwardAngle: STRAFER_FORWARD_ANGLE,
    maxTurn: STRAFER_TARGET_TURN_LIMIT,
  },
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
 * 尾随蛆(KIND_TRAILER):头 → 颈 → 身 → 尾的四段链。
 *
 * Seedance 2 的动作参考里,它不是整张贴图左右摇,而是弯曲波从头一路传到尾尖。
 * 这里把后段摆幅逐级放大、相位逐级滞后:头只轻点,尾巴走最大弧,同时保持四块都挂在
 * 同一条 FK 链上 —— 父动子跟,不会出现“身体转了、尾巴留在原地”的纸片穿帮。
 */
export const RIG_TRAILER: RigDef = {
  textureCount: 4, // 画序:0 tail → 1 body → 2 neck → 3 head
  freq: 3,
  fixedRootAngle: null,
  targetFacing: null,
  spin: 0,
  parts: [
    // 0:头根。锚点取颈部接口,头壳向前(-Y)伸出。
    part({
      tex: 3,
      parent: -1,
      ax: 0.5,
      ay: 0.8,
      dy: -145,
      scale: 0.34,
      swing: 0.04,
      pumpX: 0.025,
      pumpY: 0.025,
    }),
    // 1:颈段从头壳下缘接出；分件图本身含三节甲片,故只需一根骨。
    part({
      tex: 2,
      parent: 0,
      ax: 0.5,
      ay: 0.05,
      scale: 0.33,
      swing: 0.11,
      phase: 0.45,
      pumpX: -0.025,
      pumpY: 0.035,
    }),
    // 2:腹段接在颈段末端,摆幅与相位继续递增,形成从头往后跑的 S 波。
    part({
      tex: 1,
      parent: 1,
      ax: 0.5,
      ay: 0.05,
      dy: 130,
      scale: 0.34,
      swing: 0.19,
      phase: 1.05,
      pumpX: -0.035,
      pumpY: 0.045,
    }),
    // 3:弯月尾的粗端在纹理右下。挂到腹段末端后,原画弧线自然回卷到身体一侧。
    part({
      tex: 0,
      parent: 2,
      ax: 0.88,
      ay: 0.84,
      dy: 162,
      rest: -8 * D2R,
      scale: 0.39,
      swing: 0.3,
      phase: 1.7,
      pumpX: 0.035,
      pumpY: -0.02,
    }),
  ],
};

/**
 * 冲撞甲虫(KIND_BEETLE):主甲壳 + 楔头 + 左右两组足。
 * Seedance 2 的冲刺参考里,前摇由足组内收、甲壳压低交代；冲刺时两侧足反相蹬开。
 * 左右足使用独立分件纹理,所以不靠整只怪镜像也能保持关节朝向正确。
 */
export const RIG_BEETLE: RigDef = {
  textureCount: 4, // 画序:0 left legs → 1 right legs → 2 body → 3 head
  freq: 6,
  fixedRootAngle: null,
  targetFacing: null,
  spin: 0,
  parts: [
    part({
      tex: 2,
      parent: -1,
      dy: 25,
      scale: 0.48,
      swing: 0.018,
      pumpX: 0.025,
      pumpY: -0.018,
    }),
    // 楔头压在主甲壳前端,锚点取后缘；轻微点头让“锁定/冲刺”不只靠预警线表达。
    part({
      tex: 3,
      parent: 0,
      ax: 0.5,
      ay: 0.82,
      dy: -105,
      scale: 0.36,
      swing: 0.045,
      phase: Math.PI * 0.5,
      pumpX: -0.02,
      pumpY: 0.035,
    }),
    part({
      tex: 0,
      parent: 0,
      ax: 0.82,
      ay: 0.18,
      dx: -82,
      dy: -10,
      scale: 0.34,
      swing: 0.22,
      phase: 0,
    }),
    part({
      tex: 1,
      parent: 0,
      ax: 0.18,
      ay: 0.18,
      dx: 82,
      dy: -10,
      scale: 0.34,
      swing: 0.22,
      phase: Math.PI,
    }),
  ],
};

/** 孢子锚足源图里“关节 → 刃尖”的原始轴向(约 135°),rest 用它校准到各自的放射方向。 */
const SPORE_ANCHOR_AXIS = 135 * D2R;

/**
 * 孢子炮手(KIND_SPORE):软体炮座 + 伸缩虹吸管 + 四根锚足 + 三簇发光孢囊。
 * 锚定态降低频率,蓄力态提高频率并压小摆幅(RIG_STATE_DRIVE),虹吸管与孢囊再以挤压伸展
 * 补上一条“正在充压”的颜色/体积读数；即使预警环被虫群遮住,玩家仍看得出它要开火。
 */
export const RIG_SPORE: RigDef = {
  textureCount: 4, // 画序:0 anchor → 1 pods → 2 body → 3 siphon
  freq: 2.4,
  fixedRootAngle: null,
  targetFacing: null,
  spin: 0,
  parts: [
    part({
      tex: 2,
      parent: -1,
      dy: 20,
      scale: 0.55,
      swing: 0.018,
      pumpX: 0.035,
      pumpY: 0.035,
    }),
    // 虹吸管锚在炮座正面,口朝 -Y；纵向鼓胀比横向更明显,像一段在蓄压的肌肉管。
    part({
      tex: 3,
      parent: 0,
      ax: 0.5,
      ay: 0.96,
      dy: -92,
      scale: 0.34,
      swing: 0.045,
      phase: Math.PI * 0.5,
      pumpX: -0.045,
      pumpY: 0.1,
    }),
    // 四足的目标轴向依次为左上、右上、左下、右下；相位错开成落地的抓挠波。
    ...[
      { dx: -86, dy: -42, axis: -145, phase: 0 },
      { dx: 86, dy: -42, axis: -35, phase: Math.PI },
      { dx: -72, dy: 58, axis: 145, phase: Math.PI * 0.5 },
      { dx: 72, dy: 58, axis: 35, phase: Math.PI * 1.5 },
    ].map((p) =>
      part({
        tex: 0,
        parent: 0,
        ax: 0.88,
        ay: 0.08,
        dx: p.dx,
        dy: p.dy,
        rest: p.axis * D2R - SPORE_ANCHOR_AXIS,
        scale: 0.32,
        swing: 0.16,
        phase: p.phase,
      }),
    ),
    // 发光孢囊压在炮座后层,三簇错相呼吸,避免整只怪像一个同步缩放的气球。
    ...[
      { dx: -66, dy: 5, phase: 0 },
      { dx: 66, dy: 5, phase: (Math.PI * 2) / 3 },
      { dx: 0, dy: 82, phase: (Math.PI * 4) / 3 },
    ].map((p) =>
      part({
        tex: 1,
        parent: 0,
        dx: p.dx,
        dy: p.dy,
        scale: 0.15,
        phase: p.phase,
        pumpX: 0.11,
        pumpY: 0.11,
      }),
    ),
  ],
};

/** Boss 足件的原始轴向:左足从根部指向左下约 125°,右足镜像后约 55°。 */
const BOSS_LEFT_LEG_AXIS = 125;
const BOSS_RIGHT_LEG_AXIS = 55;

/**
 * 合围巨兽(Boss):母巢腹腔 + 头甲 + 六足 + 四枚孵化囊 + 中央产卵虹膜。
 *
 * Boss 不塞进 ENEMY_RIGS —— KIND_BOSS 在 ENEMIES 表外,渲染层以独立骨架层加载它。
 * 四枚囊和中央虹膜正是 Seedance 2 里“脉动 → 虹膜张开 → 小怪爬出”的关键帧读数；
 * 召唤逻辑仍由 sim/world.ts 的 BOSS.summonCounts 驱动,骨架只负责把这件事提前画明白。
 */
export const RIG_BOSS: RigDef = {
  textureCount: 6, // 0 left leg → 1 right leg → 2 body → 3 egg → 4 iris → 5 head
  // Seedance 2 的动作参考显示的是"重心呼吸 + 延迟踏步",而不是整只 Boss 同步摆动;
  // 提高基础频率后仍由每个部件的 phase 错开,不会回到机械齐步。
  freq: 1.55,
  fixedRootAngle: null,
  targetFacing: null,
  spin: 0,
  parts: [
    // 腹腔不是一块静态贴纸:轻微反相挤压让体积读作"在呼吸"。
    part({ tex: 2, parent: -1, dy: 18, scale: 0.44, swing: 0.045, pumpX: 0.04, pumpY: -0.025 }),
    // 头甲有独立的迟滞点头,相位与腹腔错开半拍。
    part({ tex: 5, parent: 0, ax: 0.5, ay: 0.82, dy: -112, scale: 0.34, swing: 0.06, phase: Math.PI * 0.5, pumpX: 0.018, pumpY: -0.012 }),
    ...[
      { dx: -112, dy: -62, axis: -155, phase: 0 },
      { dx: -128, dy: 8, axis: 180, phase: (Math.PI * 2) / 3 },
      { dx: -102, dy: 78, axis: 145, phase: (Math.PI * 4) / 3 },
    ].map((p) => part({ tex: 0, parent: 0, ax: 0.9, ay: 0.08, dx: p.dx, dy: p.dy, rest: (p.axis - BOSS_LEFT_LEG_AXIS) * D2R, scale: 0.24, swing: 0.2, phase: p.phase, pumpX: 0.05, pumpY: -0.025 })),
    ...[
      { dx: 112, dy: -62, axis: -25, phase: Math.PI },
      { dx: 128, dy: 8, axis: 0, phase: Math.PI / 3 },
      { dx: 102, dy: 78, axis: 35, phase: (Math.PI * 5) / 3 },
    ].map((p) => part({ tex: 1, parent: 0, ax: 0.1, ay: 0.08, dx: p.dx, dy: p.dy, rest: (p.axis - BOSS_RIGHT_LEG_AXIS) * D2R, scale: 0.24, swing: 0.2, phase: p.phase, pumpX: 0.05, pumpY: -0.025 })),
    ...[
      { dx: -72, dy: 5, phase: 0 },
      { dx: 72, dy: 5, phase: Math.PI },
      { dx: -62, dy: 78, phase: Math.PI * 0.5 },
      { dx: 62, dy: 78, phase: Math.PI * 1.5 },
    ].map((p) => part({ tex: 3, parent: 0, dx: p.dx, dy: p.dy, scale: 0.12, phase: p.phase, swing: 0.035, pumpX: 0.18, pumpY: 0.13 })),
    // 虹膜盖在腹腔正中最前层；召唤前摇时由 Boss 专属 driver 提频放大,像一扇正在开的门。
    part({ tex: 4, parent: 0, dx: 0, dy: 66, scale: 0.14, swing: 0.08, phase: Math.PI * 0.25, pumpX: 0.17, pumpY: 0.12 }),
  ],
};

/**
 * 逐型骨架表。**下标 === EnemyKind**(与 data/enemies.ts 的 ENEMIES 同序)。
 * 当前五型都已接入；类型仍保留 null,以后某型缺件/临时撤回时渲染层可逐型回退单件贴图。
 */
export const ENEMY_RIGS: readonly (RigDef | null)[] = [
  RIG_SWARM, // KIND_SWARM 蜂群蛭
  RIG_STRAFER, // KIND_STRAFER 侧掠者
  RIG_TRAILER, // KIND_TRAILER 尾随蛆
  RIG_BEETLE, // KIND_BEETLE 冲撞甲虫
  RIG_SPORE, // KIND_SPORE 孢子炮手
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
 * @param bodyFlipX 1 = 原向, -1 = 沿根骨本地 Y 轴镜像整套骨架(左右换向)
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
  bodyFlipX: 1 | -1 = 1,
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
    const localX = p.dx * bodyFlipX;
    out[o] = px + (localX * ca - p.dy * sa) * bodyScale;
    out[o + 1] = py + (localX * sa + p.dy * ca) * bodyScale;
    const w = Math.sin(phase + p.phase);
    out[o + 2] = pa + (p.rest + p.swing * swingMul * w) * bodyFlipX;
    const s = bodyScale * p.scale;
    out[o + 3] = s * bodyFlipX * (1 + p.pumpX * swingMul * w);
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
