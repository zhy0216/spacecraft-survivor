/**
 * 自动平衡求解器(平衡系统)—— 把「改数据即可调平衡」升级成「一条命令全表重锚」。
 * 与 sim/balance.ts 的分工:那份是**裁判**(走廊判定 / 闸门数学),这份是**求解**:
 * 读出当前表、算出把每座塔推回走廊的数值、以编辑清单(BalanceEdit)返回。
 * 铁律 1 照旧:不 import pixi/DOM、不用 Math.random、不碰 fs —— 文件读写全在 scripts/ 的 CLI 里,
 * 本文件是纯函数 + 对数据表的普通字段赋值,单测可直接驱动。
 *
 * —— 分解引理(正确性根基)——
 * 对任意塔、任意星级 s:corridorPower(s) = damageStat(s) × K(s),其中
 *   damageStat(s) = baseDamageStat × growth.damage^(2(s−1))(starLevel 1→3→5,指数 0/2/4);
 *   K(s) 不含伤害(sim/tower.ts 的 slotSustainedDps 逐节流族核对:
 *     弹药系 duty 的分母只含整数 magazine/shots 与 interval/reload;过热系 duty 的 firing
 *     只含 heatMax/heatRate;充能系只含 chargeTime —— 三族都与伤害无关)。
 * 推论:
 *   1. 1★(合成塔 3★)压线 = **一次线性射击**:new = current × 锚线/火力,浮点精确;
 *   2. P(s)/P(1) = g^(2(s−1)) × K(s)/K(1) 对 g **严格单调连续** → 二分安全;
 *      (弹药系 ceil(magazine/shots) 的折点只随整数 magazine 走,求解器不碰 magazine → 折点不移动)
 *   3. 两旋钮解耦:damage 只整体缩放、growth.damage 只改形状 —— 先钉 1★ 再二分成长,零迭代;
 *   4. 塔间零串扰:锚线只依赖难度指数(与伤害无关)与机炮锚(永不触碰),逐塔独立求解。
 *
 * —— 契约:表由求解器拥有 ——
 * 手改的数值在下次 `npm run balance` 时会被拉回带内、行尾注释被规范成自动求解口径
 * (CLI 打印前后体检表,改动全程可见,不是静默行为)。「数值该是多少」的表达是
 * data/balance.ts 的哲学旋钮(难度指数 / k / 带宽 / 溢价 / TTK),「数值本身」是求解器的产物。
 */
import { CORRIDOR_BAND, GATE_TTK_TARGET } from '../data/balance';
import { BOSS, ENEMIES } from '../data/enemies';
import { isMergeResult } from '../data/merges';
import { FX_MORTAR, GROWTH_DAMAGE_MIN, STAR_MAX, TOWERS, TOWER_AUTOCANNON, type TowerDef } from '../data/towers';
import { WAVE_TOTAL_TIME } from '../data/waves';
import {
  bossHpMulForGate,
  corridorAnchorP,
  corridorLine,
  corridorOk,
  corridorPower,
  neutralBuffs,
  slotFor,
  towerStars,
} from './balance';
import { hpScaleAt } from './enemy';

/** 求解器唯一会动的字段:主伤害旋钮(迫击炮系 = 落点档)+ 成长斜率旋钮。
 *  机炮整行与合成签名字段(测试钉死)天然不在此列。 */
export type EditField = 'damage' | 'aoeDamage' | 'growth.damage';

export interface BalanceEdit {
  /** 写回目标文件 */
  file: 'towers' | 'enemies';
  /** 塔表 = TOWER_* 型号;enemies 忽略(只认 BOSS.hpMul) */
  anchor: number;
  /** 字段路径;Boss 只有 'hpMul' */
  field: EditField | 'hpMul';
  /** 读表得到的现值(写回时值对不上 = 文件被并发改过 → 跳过不覆盖) */
  current: number;
  /** 求解目标值(已 2 位有效数字圆整) */
  proposed: number;
  /** 写回时替换整行尾注的注释(自动求解口径,逐字确定 → 幂等) */
  comment: string;
}

export interface SolveResult {
  towerEdits: BalanceEdit[];
  /** null = 现值已与推导一致(幂等);推导必须发生在塔表编辑内存应用之后 */
  bossEdit: BalanceEdit | null;
}

/** 2 位有效数字圆整(落盘口径):1.704→1.7、3.28→3.3、52.2→52、87→87(整数原样)。
 *  toPrecision 对半值按 round-half-even,确定性即幂等。 */
export function toSig2(v: number): number {
  return Number(v.toPrecision(2));
}

/** 圆整候选集:2 位有效数字 ± 相邻一档(如 87 → 86/87/88,3.26 → 3.2/3.3/3.4)。
 *  带宽 ±20% 远大于单档 ~6-10%,候选回退只在极边缘情形才被用到。 */
function roundCandidates(v: number): number[] {
  const base = toSig2(v);
  if (!(base > 0)) return [base];
  const step = Math.pow(10, Math.floor(Math.log10(base)) - 1);
  return [...new Set([base, toSig2(v - step), toSig2(v + step)])];
}

/** 主伤害旋钮的当前值(FX_MORTAR 塔 = aoeDamage,damage 恒 0 不许碰) */
function damageStat(def: TowerDef): number {
  return def.fx === FX_MORTAR ? def.aoeDamage : def.damage;
}

/** 带探针的残差比(corridorRatio 只认实时表,这里接受 clone) */
function ratioWith(def: TowerDef, stars: number): number {
  return corridorPower(slotFor(def.type, stars), def, neutralBuffs()) / corridorLine(def, stars);
}

/** 全星级档的最大残差偏差(圆整候选的择优目标) */
function worstDeviation(def: TowerDef): number {
  let worst = 0;
  for (const s of towerStars(def)) {
    const d = Math.abs(ratioWith(def, s) - 1);
    if (d > worst) worst = d;
  }
  return worst;
}

/**
 * 压线的一次线性射击:把该星级的走廊火力精确推到锚线上(未圆整)。
 * 线性性由分解引理保证;火力 ≤ 0(表被改坏)返回 NaN = 不可解。
 */
export function pinDamage(def: TowerDef, stars: number): number {
  const power = corridorPower(slotFor(def.type, stars), def, neutralBuffs());
  if (!(power > 0)) return Number.NaN;
  return damageStat(def) * (corridorLine(def, stars) / power);
}

/**
 * growth.damage 的二分求解(未圆整):让端到端步进 P₃/P₁ 追平锚线的端到端步进
 * (= corridorAnchorP(3)/corridorAnchorP(1),现算不硬编码 —— 机炮的双管/曳光弹跳变都在里面)。
 * 探针用浅克隆,不污染实时表;g 下界钳 GROWTH_DAMAGE_MIN(用户设计会:每星伤害 ≥ 3×,
 * data/towers 的同一份常数 —— 求解不许把成长解回 3×/星 之下),上界自适应倍增
 * (3→6→12→24→48→96),仍够不到 = 形状自带跳变超过锚线目标 → 返回下界(最小合法成长,
 * 由带内判据收尾)。60 轮二分,每轮区间减半,终止宽 < 1e-9。
 */
export function solveGrowth(def: TowerDef): number {
  const target = corridorAnchorP(3) / corridorAnchorP(1);
  const p1 = corridorPower(slotFor(def.type, 1), def, neutralBuffs());
  const f = (g: number): number => {
    const probe = { ...def, growth: { ...def.growth, damage: g } };
    return corridorPower(slotFor(def.type, 3), probe, neutralBuffs()) / p1 - target;
  };
  let lo = GROWTH_DAMAGE_MIN;
  if (f(lo) >= 0) return lo; // 最小成长已追平(形状自带跳变):回到下界,交给带内判据
  let hi = 3.0;
  while (f(hi) < 0) {
    hi *= 2;
    if (hi > 96) return lo; // 扩界仍够不到 = 不可解:回到下界(与上一支同一条收尾)
  }
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < 0) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-9) break;
  }
  return (lo + hi) / 2;
}

/** 伤害旋钮行尾注释(逐字生成 → 幂等) */
function damageComment(def: TowerDef, stars: number): string {
  const line = corridorLine(def, stars).toFixed(1);
  return isMergeResult(def.type)
    ? `// 自动求解:L₃≈${line}(合成溢价);再平衡跑 npm run balance`
    : `// 自动求解:L₁≈${line};再平衡跑 npm run balance`;
}

const GROWTH_COMMENT = '// 自动求解:成长斜率追平锚线;再平衡跑 npm run balance';

/** 逐塔求解:返回把全表推回走廊的塔表编辑。机炮整行永不触碰;全星在带内的塔零编辑(幂等)。 */
export function solveTowerEdits(): BalanceEdit[] {
  const edits: BalanceEdit[] = [];
  for (const def of TOWERS) {
    if (def.type === TOWER_AUTOCANNON) continue; // 锚塔整行(锚线依赖它,含 growth)
    if (towerStars(def).every((s) => corridorOk(def, s))) continue; // 已在带内 → 零编辑
    const field: EditField = def.fx === FX_MORTAR ? 'aoeDamage' : 'damage';
    const pinS = isMergeResult(def.type) ? STAR_MAX : 1;
    const targetD = pinDamage(def, pinS);
    if (!Number.isFinite(targetD)) continue; // 不可解(坏表):不编辑,报告标记
    const targetG = isMergeResult(def.type) ? Number.NaN : solveGrowth(def);

    // 圆整候选组合择优:使全星最大残差偏差最小的 (伤害, 成长) 对
    const dCands = roundCandidates(targetD);
    const gCands = Number.isFinite(targetG) ? roundCandidates(targetG) : [Number.NaN];
    let best: { d: number; g: number; worst: number } | null = null;
    for (const d of dCands) {
      for (const g of gCands) {
        const probe = {
          ...def,
          [field]: d,
          growth: Number.isFinite(g) ? { ...def.growth, damage: g } : def.growth,
        };
        const worst = worstDeviation(probe);
        if (!best || worst < best.worst) best = { d, g, worst };
      }
    }
    if (!best || best.worst > CORRIDOR_BAND) continue; // 圆整后仍越带:不编辑,报告标记

    const curD = damageStat(def);
    if (curD !== best.d) {
      edits.push({
        file: 'towers',
        anchor: def.type,
        field,
        current: curD,
        proposed: best.d,
        comment: damageComment(def, pinS),
      });
    }
    if (Number.isFinite(best.g) && def.growth.damage !== best.g) {
      edits.push({
        file: 'towers',
        anchor: def.type,
        field: 'growth.damage',
        current: def.growth.damage,
        proposed: best.g,
        comment: GROWTH_COMMENT,
      });
    }
  }
  return edits;
}

/** 把塔表编辑就地应用到内存 TOWERS(CLI 推导 Boss 编辑、测试用;调用方负责还原/落盘) */
export function applyEditsToTable(edits: readonly BalanceEdit[]): void {
  for (const e of edits) {
    if (e.file !== 'towers') continue;
    const def = TOWERS[e.anchor];
    if (!def) continue;
    if (e.field === 'damage') def.damage = e.proposed;
    else if (e.field === 'aoeDamage') def.aoeDamage = e.proposed;
    else def.growth.damage = e.proposed;
  }
}

/**
 * Boss 编辑:proposed = round(bossHpMulForGate())。**必须在塔表编辑内存应用后调用** ——
 * bossHpMulForGate 内部 refGateDps 直接读实时 TOWERS(函数签名没有表参数),
 * 顺序由 solveAll / CLI 强制。现值一致返回 null(幂等)。
 */
export function makeBossEdit(): BalanceEdit | null {
  const derived = bossHpMulForGate();
  const proposed = Math.round(derived);
  if (BOSS.hpMul === proposed) return null;
  const base = ENEMIES[BOSS.baseKind]!;
  const scale = hpScaleAt(WAVE_TOTAL_TIME);
  const hpAt = Math.round(base.hp * scale * proposed);
  // 两行注释整块重生成(换行分隔):第一行是值行尾注,第二行是续行(自带 2 空格缩进,
  // applyEdits 逐字 splice 进 hpMul 行之后)—— 手写数字 (60.3 / 43.5 / 68.8 / ≈3578)
  // 一个都不留,全部现算,永不再陈
  const comment =
    `// 闸门反推(自动求解):净 DPS × TTK ${GATE_TTK_TARGET}s / ${(base.hp * scale).toFixed(1)} ≈ ${derived.toFixed(1)} → 取整 ${proposed};\n` +
    `  // Boss HP = ${base.hp} × ${scale.toFixed(2)} × ${proposed} ≈ ${hpAt}。推导见 sim/balance.ts 的 bossHpMulForGate。再平衡跑 npm run balance`;
  return { file: 'enemies', anchor: -1, field: 'hpMul', current: BOSS.hpMul, proposed, comment };
}

/** 组合入口:求解塔表编辑 → 内存应用 → 推导 Boss 编辑(会临时改动内存 TOWERS) */
export function solveAll(): SolveResult {
  const towerEdits = solveTowerEdits();
  applyEditsToTable(towerEdits);
  const bossEdit = makeBossEdit();
  return { towerEdits, bossEdit };
}

// —— 文本写回(纯函数、幂等;文件读写本身在 scripts/ 的 CLI)——

/** 数字的落盘格式:整数输出整数、浮点去尾零(6 → "6"、3.3 → "3.3"、1.7 → "1.7"、0.09 → "0.09") */
function fmtNum(v: number): string {
  return String(Number(v.toPrecision(12)));
}

/**
 * 在 fileText 上按块作用域应用编辑,返回新文本。纯函数、幂等(同一批编辑重应用 → 文本不变);
 * 找不到锚 / 字段值对不上(文件被并发改过)= 该编辑跳过、其余照常 —— 坏编辑只防御不抛。
 *
 * towers.ts 锚点规约:塔块 = `    type: <常量名>,` 到下一个 `    type: ` 或 `];`;
 * 字段行按缩进精确消歧(`    damage:` 4 空格、`    aoeDamage:` 4 空格、`      damage:` 6 空格 =
 * growth 子块;界面注释的 2 空格 `damage: number;` 天然免疫)。常量名映射从文本现扫
 * (`export const TOWER_X = n;`),与求解侧的锚(型号)互证,不硬编码第二份名字表。
 *
 * enemies.ts:Boss 编辑 = 值行 + 紧随其后的 `  //` 续注整块重生成(消灭陈数字)。
 */
export function applyEdits(fileText: string, edits: readonly BalanceEdit[]): string {
  const lines = fileText.split('\n');
  // 常量名 → 型号(从文本现扫;找不到名 = 该编辑跳过)
  const nameToType = new Map<string, number>();
  for (const line of lines) {
    const m = /^export const (TOWER_\w+) = (\d+);/.exec(line);
    if (m) nameToType.set(m[1]!, Number(m[2]));
  }

  for (const e of edits) {
    if (e.file === 'towers') {
      const anchorName = [...nameToType.entries()].find(([, t]) => t === e.anchor)?.[0];
      if (anchorName === undefined) continue;
      // 块头与块尾
      let blockStart = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === `    type: ${anchorName},`) {
          blockStart = i;
          break;
        }
      }
      if (blockStart < 0) continue;
      let blockEnd = lines.length;
      for (let i = blockStart + 1; i < lines.length; i++) {
        if (/^    type: \w+,/.test(lines[i]!) || /^\];/.test(lines[i]!)) {
          blockEnd = i;
          break;
        }
      }
      // 字段行(缩进消歧 + 现值校验)
      const indent = e.field === 'growth.damage' ? '      ' : '    ';
      const fieldName = e.field === 'growth.damage' ? 'damage' : e.field;
      const re = new RegExp(`^${indent}${fieldName}: ([\\d.]+),`);
      let hit = -1;
      for (let i = blockStart; i < blockEnd; i++) {
        const m = re.exec(lines[i]!);
        if (m && Number(m[1]) === e.current) {
          hit = i;
          break;
        }
      }
      if (hit < 0) continue;
      lines[hit] = lines[hit]!.replace(
        new RegExp(`^(\\s*${fieldName}\\s*:\\s*)[\\d.]+(,).*$`),
        `$1${fmtNum(e.proposed)}$2 ${e.comment}`,
      );
    } else if (e.field === 'hpMul') {
      // 值行 + 续注整块重生成(只认 BOSS 块;接口里的 `hpMul: number;` 不匹配 [\d.]+ 的约束)
      let hit = -1;
      for (let i = 0; i < lines.length; i++) {
        const m = /^  hpMul: ([\d.]+),/.exec(lines[i]!);
        if (m && Number(m[1]) === e.current) {
          hit = i;
          break;
        }
      }
      if (hit < 0) continue;
      let tail = hit + 1;
      while (tail < lines.length && /^  \/\/ /.test(lines[tail]!)) tail++;
      const parts = e.comment.split('\n');
      lines[hit] = `  hpMul: ${fmtNum(e.proposed)}, ${parts[0]!}`;
      lines.splice(hit + 1, tail - (hit + 1), parts[1]!);
    }
  }
  return lines.join('\n');
}
