/**
 * 玩家船的运动模型 —— 单摇杆船(GDD §3.1:输入 = 期望航向,不是直接位移)。
 * 铁律:本目录永不 import pixi/DOM,也不 import core/input —— 输入只以纯数据(ShipCommand)
 * 从外部灌进来,换来"同 seed + 同输入序列 → 同一条轨迹"以及在 Node 里单测的能力。
 * 船全局只有一艘,故不进对象池;但同样维护 px/py 与 pheading,渲染层靠它们插值(铁律 2)。
 */
import { tuning } from './config';

export interface Vec2 {
  x: number;
  y: number;
}

/** World.step 的纯数据入参:输入永远不进 sim,由 main.ts 每逻辑帧从 Input 取值填好传进来 */
export interface ShipCommand {
  desiredHeading: Vec2 | null;
}

export interface Ship {
  x: number;
  y: number;
  /** 上一逻辑帧位置,渲染插值用(铁律 2) */
  px: number;
  py: number;
  vx: number;
  vy: number;
  /** 当前船头朝向,弧度,0 = +X,顺时针为正(y 轴朝下) */
  heading: number;
  /** 上一逻辑帧朝向,渲染插值用 */
  pheading: number;
}

export const DEG2RAD = Math.PI / 180;

/** 指数阻尼的衰减档:e^-5 ≈ 0.7% 残速,把 shipDamping 读成"松手 N 秒内停"的口径 */
const DAMP_DECAY = 5;
/** px/s,低于此直接归零:掐掉指数尾巴的无限漂移,也让 checksum 稳定 */
const STOP_EPS = 1;

/** 折回 (-π, π]。角度差必须先折回再用,否则转向会挑远路绕一圈 */
export function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** 沿最短弧插值:直接对两个角做线性插值,跨 ±π 时会整整甩头一圈 */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t;
}

export function createShip(): Ship {
  // 船头默认朝屏幕上方:y 轴朝下,所以是 -π/2
  return { x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, heading: -Math.PI / 2, pheading: -Math.PI / 2 };
}

/**
 * 推进一逻辑帧。顺序不可改(单测按此钉住):
 * 存上一帧 → 转向(有上限)→ 沿船头推力 → 夹巡航速度 / 或纯阻尼 → 积分位置。
 * 四个 tuning 参数一律每帧现读 —— 这就是"面板拖动即时改变手感、无需重启"的唯一实现机制。
 */
export function stepShip(ship: Ship, desired: Vec2 | null, dt: number): void {
  ship.px = ship.x;
  ship.py = ship.y;
  ship.pheading = ship.heading;

  const dx = desired?.x ?? 0;
  const dy = desired?.y ?? 0;
  if (dx * dx + dy * dy > 0) {
    // 只取方向不看长度:摇杆推半程也是全速,快慢由加速度决定而非输入幅度
    const want = Math.atan2(dy, dx);
    const diff = wrapAngle(want - ship.heading);
    const maxTurn = tuning.shipTurnRate * DEG2RAD * dt;
    // 以转向速率为上限追随期望航向,绝不瞬间对齐 —— 转向速率是全游戏最重要的手感参数(GDD §3.2)
    ship.heading = wrapAngle(ship.heading + Math.max(-maxTurn, Math.min(maxTurn, diff)));

    // 推力沿船头方向、而不是沿期望航向:这才产生"先转船、再找射界"的手感(GDD §3.1 走位 = 火控)
    ship.vx += Math.cos(ship.heading) * tuning.shipAccel * dt;
    ship.vy += Math.sin(ship.heading) * tuning.shipAccel * dt;

    const sp = Math.hypot(ship.vx, ship.vy);
    if (sp > tuning.shipCruiseSpeed) {
      const k = tuning.shipCruiseSpeed / sp;
      ship.vx *= k;
      ship.vy *= k;
    }
  } else {
    // 松手(零向量等同无输入):不转向,只阻尼滑行。有输入时不叠加阻尼,
    // 否则"巡航速度"就变成了推力与阻尼的平衡点,参数语义被污染。
    // Math.max 兜住 shipDamping,面板拖到 0 时不至于除零。
    const k = Math.exp((-DAMP_DECAY * dt) / Math.max(0.05, tuning.shipDamping));
    ship.vx *= k;
    ship.vy *= k;
    if (Math.hypot(ship.vx, ship.vy) < STOP_EPS) ship.vx = ship.vy = 0;
  }

  ship.x += ship.vx * dt;
  ship.y += ship.vy * dt;
}
