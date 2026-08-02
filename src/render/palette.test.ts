import { describe, expect, it } from 'vitest';
import { ENEMIES } from '../data/enemies';
import { SUPPORTS } from '../data/supports';
import { TOWERS } from '../data/towers';
import { ENEMY_BODY_FILL, SHIP_EDGE, SHIP_FILL, enemyTint } from './palette';

type Rgb = readonly [number, number, number];

/** Machado 等人的 100% 缺陷矩阵（线性 RGB）；这里做可重复的静态审计，不依赖截图或人工工具。 */
const simulations: ReadonlyArray<readonly [string, readonly number[]]> = [
  [
    'protanopia',
    [
      0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116,
      1.051998,
    ],
  ],
  [
    'deuteranopia',
    [
      0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294,
      0.968881,
    ],
  ],
  [
    'tritanopia',
    [
      1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367,
      0.3039,
    ],
  ],
];

function linearRgb(color: number): Rgb {
  const channel = (shift: number): number => {
    const v = ((color >> shift) & 0xff) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return [channel(16), channel(8), channel(0)];
}

function simulate(color: number, matrix: readonly number[]): Rgb {
  const [r, g, b] = linearRgb(color);
  const at = (row: number): number =>
    Math.max(
      0,
      Math.min(
        1,
        matrix[row * 3]! * r + matrix[row * 3 + 1]! * g + matrix[row * 3 + 2]! * b,
      ),
    );
  return [at(0), at(1), at(2)];
}

/** 线性 RGB → OKLab；欧氏距离比直接量 RGB 更贴近人眼的明度/色相差。 */
function oklab([r, g, b]: Rgb): Rgb {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function distance(a: Rgb, b: Rgb): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Pixi 灰阶纹理 × tint 的逐通道乘色；审计屏幕上的实体填充，而不是未合成的 tint。 */
function multiplyTint(fill: number, tint: number): number {
  const channel = (shift: number): number =>
    Math.round((((fill >> shift) & 0xff) * ((tint >> shift) & 0xff)) / 255);
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

describe('敌我配色审计(H5)', () => {
  it('正常视觉下敌方保持暖红紫、船/塔/弹/支援保持冷色', () => {
    for (const def of ENEMIES) {
      const color = def.tint;
      const r = (color >> 16) & 0xff;
      const g = (color >> 8) & 0xff;
      const b = color & 0xff;
      expect(Math.max(r, b), `enemy #${color.toString(16)}`).toBeGreaterThan(g);
      expect(r, `enemy #${color.toString(16)}`).toBeGreaterThan(g);
    }

    const allied = [
      SHIP_FILL,
      SHIP_EDGE,
      ...TOWERS.map((d) => d.tint),
      ...SUPPORTS.map((d) => d.tint),
    ];
    for (const color of allied) {
      const r = (color >> 16) & 0xff;
      const b = color & 0xff;
      expect(b, `ally #${color.toString(16)}`).toBeGreaterThan(r);
    }
  });

  it.each(simulations)('%s 下每种敌色仍与每种我方实体色保持可辨距离', (name, matrix) => {
    // 弹与开火 FX 逐塔复用 TOWERS.tint，所以把塔色纳入就是把弹/FX 一并审计。
    const allied = [
      SHIP_FILL,
      SHIP_EDGE,
      ...TOWERS.map((d) => d.tint),
      ...SUPPORTS.map((d) => d.tint),
    ];
    for (let kind = 0; kind < ENEMIES.length; kind++) {
      const renderedBody = multiplyTint(ENEMY_BODY_FILL, enemyTint(kind));
      const enemy = oklab(simulate(renderedBody, matrix));
      for (const color of allied) {
        const delta = distance(enemy, oklab(simulate(color, matrix)));
        expect(
          delta,
          `${name}: enemy kind ${kind} vs ally #${color.toString(16)}`,
        ).toBeGreaterThan(0.08);
      }
    }
  });

  it('颜色之外仍保留轮廓通道：四敌型剪影互不相同', () => {
    expect(new Set(ENEMIES.map((d) => d.shape)).size).toBe(ENEMIES.length);
    for (let kind = 0; kind < ENEMIES.length; kind++) expect(enemyTint(kind)).toBe(ENEMIES[kind]!.tint);
  });
});
