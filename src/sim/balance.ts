/**
 * 平衡系统的判定侧(平衡系统)—— 火力指数、难度→火力走廊、Boss 闸门数学。
 * 与 data/balance.ts 的分工:那份是**旋钮面**(难度指数 + 全部平衡常数,改数不改逻辑),
 * 这份是**裁判**(闭式计算与判定)。铁律 1 照旧:不 import pixi/DOM,不用 Math.random ——
 * 走廊与闸门全是「数值表 + 一份合成 EdictBuffs」的确定性算术,同一张表问一百遍答案都一样。
 *
 * —— 火力指数的底料 ——
 * sim/tower.ts 的 slotSustainedDps 是「含整个节流周期的闭式持续 DPS」的单一真相源
 * (弹药系摊上装填硬停顿、过热系摊上锁死罚时、充能系就是攒-放),HUD 火力面板读的也是它。
 * 本文件**一字不改它**,只在其上包多目标/覆盖因子:
 *   P_走廊 = slotSustainedDps × 链跳 × 穿透 × 线上 × 落点(不含覆盖);
 *   P_火力 = P_走廊 × F_cov^w(含覆盖,展示口径与专精带校验)。
 * 走廊特意**不含覆盖**:arcDeg 已经进了难度指数,火力再乘一遍覆盖 = 对窄弧塔双重惩罚,
 * 会把磁轨推到单发数百的荒谬档(data/balance.ts 的 CORRIDOR_COVERAGE_WEIGHT 一段)。
 *
 * —— 走廊不变式 ——
 * 每塔 × 每星级档:|P − 锚线| ≤ b × 锚线,锚线 = 同星级机炮的 P × (1 + k×(难度−1)) × 合成溢价。
 * 这就是「操作难度大的拿数值优势」的量化:难的塔必须真的更强,易的塔不许偷偷超线(双侧带)。
 *
 * —— Boss 闸门 ——
 * 闸门配装(用户口径):星级质量 Σstars ≥ 6、≥ 3 把武器、≥ 5 层法令(任意构成)。
 * refGateDps = 枚举全部合法配装的走廊火力取**最小**(保守:最弱合法配装都能过,闸门才算数),
 * Boss HP 由它反推(见 bossHpMulForGate)。欠闸门配装的败局由召唤压力闭式保证,
 * 判定细节在 sim/bossGate.test.ts —— 本文件只提供账本函数。
 */
import { CORRIDOR_BAND, CORRIDOR_COVERAGE_WEIGHT, CORRIDOR_SLOPE, difficultyOf, FUSED_ACQ_PREMIUM, GATE_EDICT_LEVELS_MIN, GATE_STAR_MASS_MIN, GATE_TTK_TARGET, GATE_WEAPONS_MIN, POWER_ENEMY_DENSITY, POWER_ENEMY_RADIUS_REF } from '../data/balance';
import { BOSS, ENEMIES } from '../data/enemies';
import { EDICT_KIND_COUNT, edictLevel } from '../data/edicts';
import { isMergeResult } from '../data/merges';
import { STAR_MAX, TOWERS, TOWER_AUTOCANNON, TOWER_KIND_COUNT, towerChainCount, towerPierce, towerRange, type TowerDef } from '../data/towers';
import { WAVE_TOTAL_TIME } from '../data/waves';
import { type WeaponSlot } from './armory';
import { aggregateEdictBuffs, createEdictBuffs, type EdictBuffs } from './edictBuffs';
import { hpScaleAt } from './enemy';
import { slotSustainedDps } from './tower';

// —— 多目标 / 覆盖因子 ——

/**
 * 链跳火力因子 = 完全几何和(含首跳):1 + f + f² + … = (1 − fⁿ)/(1 − f)。
 * f = 每跳衰减,首跳伤害就是单发伤害(slotSustainedDps 的口径),故和式从 1 起。
 * 坏表兜底:f ≤ 0 或 n ≤ 1 = 没有链跳这件事;f ≥ 1 = 逐跳不衰减,和式退化成 n。
 */
export function chainFactor(def: TowerDef, stars: number): number {
  const n = towerChainCount(def, stars);
  if (n <= 1) return 1;
  const f = def.chainFalloff;
  if (!(f > 0)) return 1;
  if (f >= 1) return n;
  return (1 - Math.pow(f, n)) / (1 - f);
}

/** 穿透火力因子:穿过 1 只补 1 只,pierce 次穿透 = 最多 pierce+1 只(3★ 曳光弹跳变计入) */
export function pierceFactor(def: TowerDef, stars: number): number {
  return 1 + towerPierce(def, stars);
}

/** 线上命中火力因子:线段半宽覆盖的期望敌数(参考半径见 data/balance 的 POWER_ENEMY_RADIUS_REF) */
export function lanceFactor(def: TowerDef): number {
  return 1 + def.lanceWidth / (2 * POWER_ENEMY_RADIUS_REF);
}

/** 落点 AoE 火力因子:1 + π·r²·ρ(期望落点敌数,ρ 是设计常数,推导见 data/balance) */
export function aoeFactor(def: TowerDef): number {
  return 1 + Math.PI * def.aoeRadius * def.aoeRadius * POWER_ENEMY_DENSITY;
}

/** 扇区覆盖因子(对机炮归一 = 1.0):弧度占比 × (射程/机炮射程)² —— 覆盖面积比 */
export function covFactor(def: TowerDef, stars: number): number {
  const gun = TOWERS[TOWER_AUTOCANNON]!;
  const gunCov = (gun.arcDeg / 360) * Math.pow(towerRange(gun, 1) / gun.range, 2);
  const cov = (def.arcDeg / 360) * Math.pow(towerRange(def, stars) / gun.range, 2);
  return cov / gunCov;
}

/** 多目标总因子:链跳 × 穿透 × 线上 × 落点 —— 走廊火力口径的全部多目标项 */
export function multiTargetFactor(def: TowerDef, stars: number): number {
  return chainFactor(def, stars) * pierceFactor(def, stars) * lanceFactor(def) * aoeFactor(def);
}

// —— 火力指数 ——

/** 一份「一条法令都没有」的聚合(中性值 + 基础星币概率),闸门配装的法令保守口径也用它 */
export function neutralBuffs(): EdictBuffs {
  return createEdictBuffs();
}

/** 造一个只带 (type, stars) 的槽位快照:slotSustainedDps 只读 type/stars,其余节流状态不参与闭式 */
export function slotFor(type: number, stars: number): WeaponSlot {
  return { type, stars, cooldown: 0, ammo: 0, reloadLeft: 0, heat: 0, coolLock: 0, charge: 0, turretOffset: 0 };
}

/** 走廊火力:单目标持续 DPS × 多目标因子(不含覆盖 —— 理由见文件头) */
export function corridorPower(slot: WeaponSlot, def: TowerDef, buffs: EdictBuffs): number {
  return slotSustainedDps(slot, def, buffs) * multiTargetFactor(def, slot.stars);
}

/** 完整火力指数:走廊火力 × 覆盖^w(展示口径;专精带校验在 balance.test.ts) */
export function slotPowerDps(slot: WeaponSlot, def: TowerDef, buffs: EdictBuffs): number {
  return corridorPower(slot, def, buffs) * Math.pow(covFactor(def, slot.stars), CORRIDOR_COVERAGE_WEIGHT);
}

// —— 走廊判定 ——

/** 走廊锚线:同星级机炮的走廊火力(难度 1.0 的刻度零点) */
export function corridorAnchorP(stars: number): number {
  const gun = TOWERS[TOWER_AUTOCANNON]!;
  return corridorPower(slotFor(TOWER_AUTOCANNON, stars), gun, neutralBuffs());
}

/** 该塔在该星级的走廊目标线 = 锚 × (1 + k×(难度−1)) × 合成溢价 */
export function corridorLine(def: TowerDef, stars: number): number {
  const premium = isMergeResult(def.type) ? FUSED_ACQ_PREMIUM : 1;
  return corridorAnchorP(stars) * (1 + CORRIDOR_SLOPE * (difficultyOf(def) - 1)) * premium;
}

/** 走廊残差比 P / 锚线:1.0 = 正压线,< 1 = 偷懒,> 1 = 超线 */
export function corridorRatio(def: TowerDef, stars: number): number {
  return corridorPower(slotFor(def.type, stars), def, neutralBuffs()) / corridorLine(def, stars);
}

/** 走廊判定:残差比落在 [1−b, 1+b] 内(双侧带,见 data/balance 的 CORRIDOR_BAND) */
export function corridorOk(def: TowerDef, stars: number): boolean {
  const ratio = corridorRatio(def, stars);
  return Math.abs(ratio - 1) <= CORRIDOR_BAND;
}

/** 该塔能存在的星级档:合成塔只存在于 3★(只从三合一变身体来),其余 1..3★ */
export function towerStars(def: TowerDef): number[] {
  return isMergeResult(def.type) ? [STAR_MAX] : [1, 2, 3];
}

export interface CorridorRow {
  type: number;
  name: string;
  stars: number;
  difficulty: number;
  power: number;
  line: number;
  ratio: number;
}

/** 全表走廊体检报告 —— 走廊测试失败时印它当调参面板(哪座塔几星越带、越了多少,一目了然) */
export function corridorReport(): CorridorRow[] {
  const rows: CorridorRow[] = [];
  for (const def of TOWERS) {
    for (const stars of towerStars(def)) {
      rows.push({
        type: def.type,
        name: def.name,
        stars,
        difficulty: difficultyOf(def),
        power: corridorPower(slotFor(def.type, stars), def, neutralBuffs()),
        line: corridorLine(def, stars),
        ratio: corridorRatio(def, stars),
      });
    }
  }
  return rows;
}

// —— Boss 闸门 ——

/** 已持有的法令总层数(闸门的「5 层任意构成」读数,与 edictHeldCount 的「条数」是两码事) */
export function edictTotalLevels(levels: readonly number[]): number {
  let n = 0;
  for (let i = 0; i < EDICT_KIND_COUNT; i++) n += edictLevel(levels, i);
  return n;
}

/**
 * 闸门合法性(用户口径原样):星级质量 ≥ 6、武器 ≥ 3 把、法令层 ≥ 5。
 * 质量是**必要条件/展示规则**;真正的闸门是 DPS(见 refGateDps —— 最弱合法配装的走廊火力)。
 * 已知退化(写进注释留给「之后再调难度」):8 把 1★ 质量 = 8 天然合法 ——
 * 收紧的候选旋钮是加「≥1 把 2★+」条款,本轮不实现。
 */
export function gateLegal(weapons: readonly WeaponSlot[], levels: readonly number[]): boolean {
  let mass = 0;
  let count = 0;
  for (const s of weapons) {
    if (s.type < 0 || s.type >= TOWER_KIND_COUNT) continue;
    mass += Math.max(1, Math.min(STAR_MAX, Math.floor(s.stars)));
    count++;
  }
  return mass >= GATE_STAR_MASS_MIN && count >= GATE_WEAPONS_MIN && edictTotalLevels(levels) >= GATE_EDICT_LEVELS_MIN;
}

/**
 * 一把武器进卡池的唯一通道是「新武器 1★ 起手 + 三合一升星」,故任何真实甲板状态都满足
 * 融合闭包:**同一 (型, 星级) 的持有数 ≤ 2**(凑满 3 把当场合一,见 World.fuseTriplesOf)。
 * 枚举配装时守着这条,否则会算出「6×1★ 电弧」这类现实中一进手就当场合成的假配置。
 */
const FUSION_CLOSURE_COPIES = 2;

/**
 * 配装枚举的**有界背包**(8 槽、13 型 × 星级档、每档 ≤ 2 把,质量 ≤ 24):
 * 对每个 (型, 星级) 档做 0..2 把的 0-1 枚举,状态 (槽数, 质量, 把数) 记 DPS 极值。
 * 规模 9×25×9 状态 × 39 档 × 3 把 ≈ 24 万步,毫秒级;枚举是穷尽的最小/最大,不是启发式。
 * @param minimize true = 求最小 DPS(闸门锚定用);false = 求最大 DPS(欠闸门上界用)
 * @param legal 状态合法判据(质量, 把数)→ 是否计入答案
 */
function extremeLoadoutDps(minimize: boolean, legal: (mass: number, count: number) => boolean): number {
  const SLOTS = 8;
  const MASS = SLOTS * STAR_MAX;
  const KINDS: { type: number; stars: number }[] = [];
  for (let t = 0; t < TOWER_KIND_COUNT; t++) {
    for (const stars of towerStars(TOWERS[t]!)) KINDS.push({ type: t, stars });
  }
  const dpsOf = (k: { type: number; stars: number }) =>
    corridorPower(slotFor(k.type, k.stars), TOWERS[k.type]!, neutralBuffs());

  // dp[slots][mass][count] = 极值 DPS;起点 0 把 = 0 DPS,其余 = 不可达(±Infinity)
  const NONE = minimize ? Infinity : -Infinity;
  const dp: number[][][] = [];
  for (let s = 0; s <= SLOTS; s++) {
    dp.push([]);
    for (let m = 0; m <= MASS; m++) {
      dp[s]!.push(new Array<number>(SLOTS + 1).fill(NONE));
    }
  }
  dp[0]![0]![0] = 0;

  for (const kind of KINDS) {
    const value = dpsOf(kind);
    // 逆序刷表:每种档最多 2 把,同一档不许在正序里被自己刷两遍
    for (let s = SLOTS; s >= 0; s--) {
      for (let m = MASS; m >= 0; m--) {
        for (let c = SLOTS; c >= 0; c--) {
          const cur = dp[s]![m]![c]!;
          if (!Number.isFinite(cur)) continue;
          for (let copies = 1; copies <= FUSION_CLOSURE_COPIES; copies++) {
            const ns = s + copies;
            const nm = m + copies * kind.stars;
            const nc = c + copies;
            if (ns > SLOTS || nm > MASS || nc > SLOTS) break;
            const candidate = cur + copies * value;
            const cell = dp[ns]![nm]![nc]!;
            if (minimize ? candidate < cell : candidate > cell) dp[ns]![nm]![nc] = candidate;
          }
        }
      }
    }
  }

  let best = NONE;
  for (let m = 0; m <= MASS; m++) {
    for (let c = 0; c <= SLOTS; c++) {
      if (!legal(m, c)) continue;
      for (let s = 0; s <= SLOTS; s++) {
        const v = dp[s]![m]![c]!;
        if (Number.isFinite(v) && (minimize ? v < best : v > best)) best = v;
      }
    }
  }
  if (!Number.isFinite(best)) return 0; // 状态空间改坏(比如闸门质量超过 8 槽上限):报 0 而不是 NaN
  return best;
}

/**
 * 闸门配装的锚定 DPS = **全部合法配装(融合闭包)里走廊火力最小**的那一个。
 * 保守口径:最弱合法配装都能过,闸门才算数 —— 「3★+2★+1★」与「3×2★」都合法,
 * 谁最弱锚就钉在谁身上。法令按**零 DPS 贡献**计(neutralBuffs):真实玩家带弹药/超载叠层只会更快。
 */
export function refGateDps(): number {
  return extremeLoadoutDps(true, (mass, count) => mass >= GATE_STAR_MASS_MIN && count >= GATE_WEAPONS_MIN);
}

/** 欠闸门配装的 DPS 上界 = 全部「质量 ≤ 5」配装(融合闭包)里走廊火力最大的那个(诊断口径) */
export function belowGateMaxDps(): number {
  return extremeLoadoutDps(false, (mass) => mass < GATE_STAR_MASS_MIN);
}

/**
 * Boss HP 倍率反推:闸门配装**边清场边磨 Boss**的可行性记账。
 * 分子 = (闸门锚定 DPS − 召唤清场需求) × TTK 目标 ——
 * 召唤每 summonInterval 秒进一批、单批总 HP = summonBatchHpAt(480) ≈ 151,清场需求 ≈ 16.8 DPS;
 * 不扣掉它,Boss HP 就会锚成「闸门配装 100% 火力磨 Boss 恰好按时击杀」——
 * 那 82.5 秒里 9 批召唤怪在场上无限制堆积,闸门配装自己先被淹死,闸门就成了谎话。
 * 分母 = 底座 HP × 480s 时间缩放 = 40 × 1.72 = 68.8。
 * 结果写回 data/enemies.ts 的 BOSS.hpMul,bossGate.test.ts 钉 1% 自洽 ——
 * 改武器表后重跑那条测试,差值就是「该把 Boss 血量同步抬/压多少」的现成读数。
 * 长时间 Boss 战期间 hpScaleAt 继续爬,真实清场需求比 480s 口径更高 —— 模型偏保守(利于闸门成立)。
 */
export function bossHpMulForGate(): number {
  const base = ENEMIES[BOSS.baseKind]!;
  const clear = summonBatchHpAt(WAVE_TOTAL_TIME) / BOSS.summonInterval;
  return ((refGateDps() - clear) * GATE_TTK_TARGET) / (base.hp * hpScaleAt(WAVE_TOTAL_TIME));
}

/** Boss 出生时的总 HP(出生时刻口径:底座 HP × 时间缩放 × hpMul) */
export function bossHpAt(seconds: number): number {
  const base = ENEMIES[BOSS.baseKind]!;
  return base.hp * hpScaleAt(seconds) * BOSS.hpMul;
}

/**
 * 配装总 DPS 的 Boss 击杀耗时(边清场边磨 Boss 的净口径):TTK = Boss HP / (总 DPS − 清场需求)。
 * 总 DPS ≤ 清场需求 = 召唤怪越打越多,TTK 无穷 —— 纯 DPS 闸门的闭式地板。
 */
export function bossNetTtk(totalDps: number): number {
  const clear = summonBatchHpAt(WAVE_TOTAL_TIME) / BOSS.summonInterval;
  const net = totalDps - clear;
  return net > 0 ? bossHpAt(WAVE_TOTAL_TIME) / net : Infinity;
}

/** 单批召唤的总 HP 流入(同一时刻口径,召唤怪出生时按当时 hpScaleAt 现乘) */
export function summonBatchHpAt(seconds: number): number {
  let total = 0;
  for (let k = 0; k < BOSS.summonCounts.length; k++) {
    const n = BOSS.summonCounts[k]!;
    if (n <= 0) continue;
    const def = ENEMIES[k];
    if (!def) continue;
    total += n * def.hp * hpScaleAt(seconds);
  }
  return total;
}

/** 把一份法令层数表聚合成 EdictBuffs(闸门账本需要「这 5 层到底加了什么」时用) */
export function buffsForLevels(levels: readonly number[]): EdictBuffs {
  return aggregateEdictBuffs(levels, createEdictBuffs());
}
