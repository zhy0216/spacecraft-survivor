/**
 * 转向力寻路的三个行为原语(07 号 issue T1)—— 纯函数、零副作用、零分配。
 * 铁律:本目录永不 import pixi/DOM;这里更进一步,连 World / Enemy / tuning 都不引 ——
 * 只吃标量、把结果写进调用方给的 out。换来两件事:1000 敌的热循环全程复用同一个 Vec2
 * (运行期零新增分配,铁律 3),以及三种行为能脱开世界单独钉住(单测直接喂坐标,
 * 不必造一整个 World 再反推它到底在绕谁)。
 *
 * GDD §13:寻路只有转向力,没有 A*。所以这三个原语就是全部敌人 AI 的地基,
 * 四种 MVP 敌人都是它们的组合(见 src/data/enemies.ts 的 BH_*),分型靠 switch 不靠继承。
 *
 * 方位角约定(全仓统一,改这里等于改所有敌型的手感):
 *   bearing = atan2(ey - ty, ex - tx),即"船 → 敌"的方位;
 *   目标方位 = targetHeading + offsetRad,offsetRad = ±π/2 是舷侧、π 是船尾、0 是船头正前。
 * 角度差一律先过 wrapAngle —— 不折回就会挑远路绕一圈(与 stepShip 的转向是同一个坑)。
 */
import { type Vec2, wrapAngle } from './ship';

/**
 * 绕行的极坐标 P 控制增益(1/s):切向按弧长误差、径向按距离误差各自出速度。
 * 取 2 的理由是阻尼:期望速度还要过一层 accel 的一阶追随,合成后
 * ζ = 0.5·√(accel / gain),绕行两型的 accel 是 7 与 8 → ζ ≈ 0.94~1.0(临界阻尼附近)。
 * 调大就会绕着驻留半径来回荡 —— 十几只一起荡是最扎眼的画面噪声。
 * 它是控制律的形状而不是平衡旋钮(平衡旋钮是数值表里的 speed / strafeRadius),
 * 所以照 ship.ts 的 DAMP_DECAY 那样留在模块里,不进 tuning、不进数值表。
 */
const STRAFE_TAN_GAIN = 2;
const STRAFE_RAD_GAIN = 2;

/**
 * 驻留锚点:以船为心、相对船头偏 offsetRad、距船 radius 的那个点。
 * 给渲染层画调试点、给单测钉方位口径用 —— strafe **刻意不走它**:
 * 直奔锚点是切弦而过,船一机动就退化成追尾,07 验收标准第一条钉的就是这个。
 */
export function anchorPoint(
  tx: number,
  ty: number,
  targetHeading: number,
  offsetRad: number,
  radius: number,
  out: Vec2,
): Vec2 {
  const a = targetHeading + offsetRad;
  out.x = tx + Math.cos(a) * radius;
  out.y = ty + Math.sin(a) * radius;
  return out;
}

/**
 * 追踪:直线朝目标的期望速度(单位方向 × speed)。
 * 速度与距离无关 —— 转向力不是弹簧,远近一个样,追不追得上交给 speed 与 accel。
 * 与目标重合时给零向量而不是 NaN(|| 1 的老套路:此时 dx/dy 本就都是 0)。
 */
export function seek(
  ex: number,
  ey: number,
  tx: number,
  ty: number,
  speed: number,
  out: Vec2,
): Vec2 {
  const dx = tx - ex;
  const dy = ty - ey;
  const dist = Math.hypot(dx, dy) || 1;
  out.x = (dx / dist) * speed;
  out.y = (dy / dist) * speed;
  return out;
}

/**
 * 绕行:切向切入,从船的指定方位逼近并驻留在 (targetHeading + offsetRad, radius) 上。
 *
 * 用**极坐标分解**而不是"朝锚点 seek":后者在距离已经对、只是方位没对时会走弦线穿过船腹,
 * 既不像侧掠、又会把尾随蛆送进船的正面火力弧。这里把误差拆成两路各自出速度:
 *   切向 —— 角度误差换算成弧长(×dist)才与径向同量纲,沿最短弧绕船走;
 *   径向 —— 太远(radErr>0)向内、太近向外。
 * 合成后**夹**到 speed,而不是归一化到 speed:定长速度在锚点附近没有不动点,
 * 会绕成一圈极限环(单测钉了稳态收敛)。远离锚点时误差项远超上限,照样是满速切入,
 * 肉眼与"归一化"没有区别 —— 只在最后那几十 px 上多了个刹车。
 */
export function strafe(
  ex: number,
  ey: number,
  tx: number,
  ty: number,
  targetHeading: number,
  offsetRad: number,
  radius: number,
  speed: number,
  out: Vec2,
): Vec2 {
  const dx = ex - tx;
  const dy = ey - ty;
  const dist = Math.hypot(dx, dy);
  const targetBearing = targetHeading + offsetRad;

  // 与船完全重合时方位角无定义:取"当前方位 = 目标方位",退化成纯径向推出去,
  // 下一帧极坐标就重新成立。这样调用方不必为一个几乎不会发生的帧多接一条分支。
  const ok = dist > 0;
  const angErr = ok ? wrapAngle(targetBearing - Math.atan2(dy, dx)) : 0;
  // 径向单位向量(船 → 敌),向外为正
  const rx = ok ? dx / dist : Math.cos(targetBearing);
  const ry = ok ? dy / dist : Math.sin(targetBearing);

  const vt = angErr * dist * STRAFE_TAN_GAIN;
  const vr = -(dist - radius) * STRAFE_RAD_GAIN;

  // 切向单位向量 = 径向逆时针转 90°:沿它走 bearing 增大,所以正的 angErr 直接当系数用
  let vx = -ry * vt + rx * vr;
  let vy = rx * vt + ry * vr;

  const m = Math.hypot(vx, vy);
  if (m > speed) {
    const k = speed / m;
    vx *= k;
    vy *= k;
  }
  out.x = vx;
  out.y = vy;
  return out;
}

/**
 * 冲锋锁定:求敌 → 船的单位方向,不含速度(速度是 DASH 段的 chargeSpeed 的事)。
 * 进入前摇时调用**一次**并把结果存进 e.lockX/lockY,此后到冲刺结束都不许再调 ——
 * "冲刺中不重新瞄准"是玩家来得及转向躲避的唯一机制来源(07 验收标准第二条)。
 */
export function lockCharge(ex: number, ey: number, tx: number, ty: number, out: Vec2): Vec2 {
  const dx = tx - ex;
  const dy = ty - ey;
  const dist = Math.hypot(dx, dy) || 1;
  out.x = dx / dist;
  out.y = dy / dist;
  return out;
}
