/**
 * Boss 个体与行为(15 号 T1)—— 纯逻辑,与 sim/enemy.ts 同一条分工:
 * 本文件只产出"期望速度 + 追随系数 + 状态机"和出生/召唤的实体填充,
 * 位置积分、邻居分离、接触粗筛、死亡回收全在 World。
 *
 * Boss = **放大的四型之一**(底座 = 冲撞甲虫):所有数值都在 data/enemies.ts 的
 * BOSS 常量里(体型/HP/接触伤害/冲锋参数全是底座值的倍率,召唤节奏直给秒数)——
 * 改平衡只改那张表,本文件一行不动。
 * 它用**专用 kind 标记**(KIND_BOSS = 4,不在 ENEMIES 表里,理由见 data/enemies.ts),
 * **绝不用 affixes 位**:affixes ≠ 0 是 14 号精英的血条扫描与 ELITE 缩放的判据。
 *
 * 行为 = 周期召唤 + 冲锋,复用现有三原语:
 *   - 接近段走 seek(直线追船),进冲锋距离(chargeRange × chargeRangeMul)就锁方向进长前摇;
 *   - 前摇刹停 + 锁方向(lockCharge)→ Z 字折线全速冲刺 → 硬直:冲刺时长三等分,
 *     逐段朝锁向交替偏转 ±chargeZAngleDeg —— 三段折成一条 Z 形走廊,威胁从一条线
 *     扩成一条带。方向仍是"锁定方向"的确定性函数,冲刺中绝不重新瞄准的承诺不变,
 *     预警线按同一条折线画(renderer 的 drawBossTelegraph),「画哪撞哪」依然成立;
 *   - 召唤不走状态机:World 侧一个召唤计时器(BOSS.summonInterval 周期),
 *     每只召唤怪恰好一次角度 rng,型号/数量直给(照 waves 的"每成功出一只恰一次 rng")。
 *   侧掠的 strafe 原语 T1 不用(底座不绕行),留到 T2 的封锁线巨舰。
 *
 * 状态码刻意避开普通敌的 ST_*(0..3) 与任何位语义冲突:世界那些"只对 ST_APPROACH
 * 生效"的效果(邻居分离、狂热光环加成)按 `e.state === ST_APPROACH` 判 ——
 * Boss 的 state 恒不等于它,于是天然跳过,不必到处加 kind 分支。
 */
import {
  BOSS,
  ENEMIES,
  KIND_BOSS,
} from '../data/enemies';
import { tuning } from './config';
import { enemyAnimSeed, hpScaleAt, type Enemy, ST_APPROACH } from './enemy';
import { type Ship, type Vec2 } from './ship';
import { lockCharge, seek } from './steering';

/** 接近段:seek 追船,进冲锋距离就锁方向进前摇 */
export const BOSS_CHASE = 10;
/** 前摇:刹住不动,方向已锁死(渲染层据此画预警,与 07 的 ST_WINDUP 同一条可读性口径) */
export const BOSS_WINDUP = 11;
/** 冲刺:沿锁定方向折 Z 字(三等分,逐段 ±chargeZAngleDeg 偏转),期间绝不重新瞄准 */
export const BOSS_DASH = 12;
/** 硬直:不出力,靠惯性滑出去(冲完的反打窗口) */
export const BOSS_RECOVER = 13;

/** Z 字冲刺的折线段数(结构常数,不是平衡旋钮:Z 就是三笔,角度才是旋钮) */
export const BOSS_Z_LEGS = 3;

/**
 * Z 字冲刺第 leg 段的期望方向(单位向量):锁向交替偏转 ±chargeZAngleDeg,0° = 退化回直线。
 * 纯函数、零分配:renderer 的预警折线(drawBossTelegraph)与 DASH 分支共用它 ——
 * 两条路各自手搓旋转矩阵会漂出两个口径,「画哪撞哪」的承诺就没法保证。
 */
export function bossZLaneDir(lockX: number, lockY: number, leg: number, out: Vec2): Vec2 {
  const sign = leg % 2 === 0 ? 1 : -1;
  const ang = (BOSS.chargeZAngleDeg * Math.PI) / 180;
  const s = Math.sin(ang) * sign;
  const c = Math.cos(ang);
  out.x = lockX * c - lockY * s;
  out.y = lockX * s + lockY * c;
  return out;
}

/**
 * 计时到期的判据容差(秒)。与 sim/enemy.ts 的 TIMER_EPS 同一套浮点口径:
 * 0.2s 这种 dt 整数倍的时长减完会落在 ±1e-17 上,不兜住就会随机多出一帧。
 */
const TIMER_EPS = 1e-9;

/** Boss 碰撞半径:底座 radius × BOSS.scale。**唯一口径** —— 接触粗筛、受击判定、
 * 死亡爆点全走它,别处不许另抄(与 enemy.ts 的 enemyRadius 同一条分工)。
 * 它不进 ENEMIES 表,故没有"精英 ×ELITE.scale"那一档:Boss 不用 affixes 位。 */
export function bossRadius(): number {
  return ENEMIES[BOSS.baseKind]!.radius * BOSS.scale;
}

/** Boss 接触伤害:底座 contactDamage × BOSS.contactDamageMul(大质量撞击伤害更高)。
 * 09 号受击模型只换这个数,不新开机制。 */
export function bossContactDamage(): number {
  return ENEMIES[BOSS.baseKind]!.contactDamage * BOSS.contactDamageMul;
}

/**
 * 出生:池 spawn 之后由 World 调用,把一只空壳 Enemy 填成 Boss。
 * **一次 rng 都不掷**(side 定死 0,位置由调用方给)——
 * Boss 是脚本的收尾,不掷随机就不扰动出怪/召唤的随机序列(同 seed 铁律)。
 * HP 时间缩放只在出生时算一次(与 initEnemy 同口径,在场的 Boss 不会回血变硬)。
 */
export function initBoss(e: Enemy, x: number, y: number, elapsedSec: number): void {
  const base = ENEMIES[BOSS.baseKind]!;
  e.x = e.px = x;
  e.y = e.py = y;
  e.vx = 0;
  e.vy = 0;
  e.kind = KIND_BOSS;
  e.affixes = 0; // 绝不用词缀位(理由见文件头)
  e.hp = e.maxHp = base.hp * hpScaleAt(elapsedSec) * BOSS.hpMul;
  e.state = BOSS_CHASE;
  e.timer = 0;
  e.lockX = 0;
  e.lockY = 0;
  e.side = 0;
  e.animSeed = enemyAnimSeed(x, y);
  e.hitCd = 0;
  e.dead = false;
}

/**
 * 召唤怪出生:与 initEnemy 同源,但**一次 rng 都不掷** —— 出生角由 World 在调用前掷完
 * (每只召唤怪恰好一次,见 World 的召唤),side 按批次内下标交替直给(左右舷都有,
 * 不掷随机就不会让召唤扰动随机序列)。普通血量、无词缀:召唤怪不是小精英。
 */
export function initSummon(
  e: Enemy,
  kind: number,
  x: number,
  y: number,
  elapsedSec: number,
  index: number,
): void {
  const def = ENEMIES[kind]!;
  e.x = e.px = x;
  e.y = e.py = y;
  e.vx = 0;
  e.vy = 0;
  e.kind = kind;
  e.affixes = 0;
  e.hp = e.maxHp = def.hp * hpScaleAt(elapsedSec);
  e.state = ST_APPROACH;
  e.timer = 0;
  e.lockX = 0;
  e.lockY = 0;
  e.side = index % 2 === 0 ? -1 : 1;
  e.animSeed = enemyAnimSeed(x, y);
  e.hitCd = 0;
  e.dead = false;
}

/**
 * 推进 Boss 行为一帧:与 stepEnemyBehavior 同一条契约 —— 期望速度写进 out,
 * 返回追随系数 follow ∈ (0, 1],调用方(World)负责积分位置。
 * 顺序与步进口径照 enemy.ts:先推进计时器并处理到期转移,再按(可能刚更新的)状态出力;
 * 到期那一帧当场按新状态出力,不空转一帧;刚进入某状态的那一帧不扣计时。
 * 速度一律现乘 tuning.enemySpeedScale(与 stepEnemyBehavior 同口径)。
 */
export function stepBossBehavior(b: Enemy, ship: Ship, dt: number, out: Vec2): number {
  const base = ENEMIES[BOSS.baseKind]!;

  switch (b.state) {
    case BOSS_WINDUP:
      b.timer -= dt;
      if (b.timer <= TIMER_EPS) {
        b.state = BOSS_DASH;
        b.timer = BOSS.chargeDuration;
      }
      break;
    case BOSS_DASH:
      b.timer -= dt;
      if (b.timer <= TIMER_EPS) {
        b.state = BOSS_RECOVER;
        b.timer = BOSS.chargeRecover;
      }
      break;
    case BOSS_RECOVER:
      b.timer -= dt;
      if (b.timer <= TIMER_EPS) {
        b.state = BOSS_CHASE;
        b.timer = 0;
      }
      break;
    default:
      // 接近段没有时限,只看够不够格起手。方向在这一刻一次性锁死:
      // 之后无论船怎么跑,冲刺都只沿这条线走 —— 与冲撞甲虫同一条"躲得掉"的依据。
      // 借 out 当暂存:下面 WINDUP 分支会把它覆盖成零向量,不多占一个模块级 Vec2。
      {
        const dx = b.x - ship.x;
        const dy = b.y - ship.y;
        const range = base.chargeRange * BOSS.chargeRangeMul;
        if (dx * dx + dy * dy <= range * range) {
          lockCharge(b.x, b.y, ship.x, ship.y, out);
          b.lockX = out.x;
          b.lockY = out.y;
          b.state = BOSS_WINDUP;
          b.timer = BOSS.chargeWindup;
        }
      }
      break;
  }

  switch (b.state) {
    case BOSS_WINDUP:
      // 刹住:期望速度归零 + 双倍追随系数,肉眼看得出"停下来蓄力"这个停顿
      out.x = 0;
      out.y = 0;
      return Math.min(1, base.accel * BOSS.accelMul * dt * 2);
    case BOSS_DASH: {
      // Z 字折线冲刺:冲刺时长三等分,逐段朝锁向交替偏转 ±chargeZAngleDeg(0° = 退化回老直线)。
      // 折线是锁定方向的确定性函数 —— 这里绝不重新读 ship 的位置,任何"冲刺中微调"都会让
      // 前摇预警画出的折线变成谎言(与 07 验收标准第二条同一条口径)。段号由 timer 剩余量
      // 闭式折出,不新增字段:同 seed 逐帧可复现,读档/checksum 口径零改动。
      const sp = base.chargeSpeed * BOSS.chargeSpeedMul * tuning.enemySpeedScale;
      const elapsed = BOSS.chargeDuration - b.timer;
      const leg = Math.min(BOSS_Z_LEGS - 1, Math.floor((elapsed * BOSS_Z_LEGS) / BOSS.chargeDuration));
      bossZLaneDir(b.lockX, b.lockY, leg, out);
      out.x *= sp;
      out.y *= sp;
      return 1; // 瞬时到速:冲刺要"弹出去",而不是慢慢加速
    }
    case BOSS_RECOVER:
      // 不出力,靠惯性滑出去(半速追随 = 减速比前摇慢一倍)
      out.x = 0;
      out.y = 0;
      return Math.min(1, base.accel * BOSS.accelMul * dt * 0.5);
    default: {
      const speed = base.speed * BOSS.speedMul * tuning.enemySpeedScale;
      seek(b.x, b.y, ship.x, ship.y, speed, out);
      return Math.min(1, base.accel * BOSS.accelMul * dt);
    }
  }
}
