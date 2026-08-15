/**
 * 自动平衡 CLI —— `npm run balance`。
 * 求解核心(src/sim/autobalance.ts)是纯函数、由单测钉死;本文件是唯一碰 fs / 子进程的薄胶水:
 * 读实时表 → 闭式求解 → 打印前后体检 → 写回数值表 → 跑七份裁判测试当验收门。
 *
 * 契约:「数值该是多少」由 data/balance.ts 的哲学旋钮表达,「数值本身」由求解器拥有 ——
 * 手改的数值在下次运行会被拉回带内、被编辑行的注释规范成自动求解口径。
 *
 * flags:
 *   --dry-run    只打印求解结果,不落盘、不跑测试
 *   --no-verify  落盘但不跑回归测试
 *
 * 退出码:0 = 全带内且(验证通过);1 = 有越带未解 / 回归测试未通过。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { CORRIDOR_BAND } from '../src/data/balance';
import { TOWERS } from '../src/data/towers';
import { corridorReport, type CorridorRow } from '../src/sim/balance';
import {
  applyEdits,
  applyEditsToTable,
  makeBossEdit,
  solveTowerEdits,
} from '../src/sim/autobalance';

const dryRun = process.argv.includes('--dry-run');
const noVerify = process.argv.includes('--no-verify');

/** 裁判测试七份:走廊 / 闸门(含真机)/ 数值表锚点 / 掉落与 Boss 行为 */
const VERIFY_FILES = [
  'src/data/balance.test.ts',
  'src/sim/balance.test.ts',
  'src/sim/bossGate.test.ts',
  'src/data/towers.test.ts',
  'src/sim/tower.test.ts',
  'src/data/enemies.test.ts',
  'src/sim/boss.test.ts',
];

/** 全表体检报告(与 balance.test.ts 的调参面板同口径) */
function formatReport(rows: CorridorRow[]): string {
  const pad = (s: string, w: number) => s.padEnd(w);
  const lines = [`${pad('塔', 8)} ${pad('星', 4)} ${pad('难度', 7)} ${pad('火力', 9)} ${pad('锚线', 9)} 残差比`];
  for (const r of rows) {
    const flag = Math.abs(r.ratio - 1) > CORRIDOR_BAND ? ' ← 越带' : '';
    lines.push(
      `${pad(r.slug, 8)} ${pad(String(r.stars), 4)} ${pad(r.difficulty.toFixed(2), 7)} ${pad(
        r.power.toFixed(1),
        9,
      )} ${pad(r.line.toFixed(1), 9)} ${r.ratio.toFixed(2)}${flag}`,
    );
  }
  return lines.join('\n');
}

function outOfBand(rows: CorridorRow[]): CorridorRow[] {
  return rows.filter((r) => Math.abs(r.ratio - 1) > CORRIDOR_BAND);
}

console.log('== 求解前走廊体检 ==');
console.log(formatReport(corridorReport()));

const towerEdits = solveTowerEdits();
if (towerEdits.length === 0) {
  console.log('\n零编辑:表已在带内。');
} else {
  console.log('\n== 编辑清单 ==');
  for (const e of towerEdits) {
    const name = TOWERS[e.anchor]?.slug ?? `?${e.anchor}`;
    console.log(`  ${name}.${e.field}: ${e.current} → ${e.proposed}`);
  }
}

// Boss 推导必须在塔表编辑内存应用之后(refGateDps 读实时 TOWERS)
applyEditsToTable(towerEdits);
const bossEdit = makeBossEdit();
if (bossEdit) {
  console.log(`  Boss.hpMul: ${bossEdit.current} → ${bossEdit.proposed}(= round(闸门反推))`);
}

console.log('\n== 求解后走廊体检 ==');
const after = corridorReport();
console.log(formatReport(after));
const stragglers = outOfBand(after);
if (stragglers.length > 0) {
  console.error(`\n${stragglers.length} 处越带未解:${stragglers.map((r) => `${r.slug}${r.stars}★`).join('、')}`);
  if (dryRun) process.exit(1);
}

if (dryRun) {
  console.log('\n--dry-run:未落盘、未跑测试。');
  process.exit(0);
}

// —— 落盘(零编辑 = 不碰文件)——
const towersPath = new URL('../src/data/towers.ts', import.meta.url);
const enemiesPath = new URL('../src/data/enemies.ts', import.meta.url);
if (towerEdits.length > 0) {
  const towersText = applyEdits(readFileSync(towersPath, 'utf8'), towerEdits);
  writeFileSync(towersPath, towersText, 'utf8');
}
if (bossEdit) {
  const enemiesText = applyEdits(readFileSync(enemiesPath, 'utf8'), [bossEdit]);
  writeFileSync(enemiesPath, enemiesText, 'utf8');
}
const wroteFiles = [
  ...(towerEdits.length > 0 ? ['src/data/towers.ts'] : []),
  ...(bossEdit ? ['src/data/enemies.ts'] : []),
];
if (wroteFiles.length > 0) console.log(`\n已写回 ${wroteFiles.join(' 与 ')}。`);
else console.log('\n零编辑:未落盘。');

if (noVerify) {
  console.log('--no-verify:跳过回归测试。');
  process.exit(stragglers.length > 0 ? 1 : 0);
}

// —— 验收门:七份裁判测试(含真机 ~9s)——
console.log('\n== 回归验证 ==');
const verify = spawnSync('npx', ['--no-install', 'vitest', 'run', ...VERIFY_FILES], {
  stdio: 'inherit',
});
if (verify.status !== 0) {
  console.error('\n回归测试未通过:回退改动(git checkout src/data/towers.ts src/data/enemies.ts)后回数据侧调。');
  process.exit(1);
}
console.log('\n全绿:表已在带内,闸门自洽,真机验证通过。');
process.exit(0);
