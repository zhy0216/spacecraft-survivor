/**
 * 程序化星野 —— 无限地图的方位参照(接替被删掉的场地边界圈:镜头永远跟着船,
 * 画面里必须有**世界锚定**的不动点,玩家才读得出"我在动、往哪动、多快")。
 *
 * 做法:两层视差平面,各自按 512px 的 chunk 网格**确定性**生成星点 ——
 * 星点坐标/大小/亮度全部由 hash(chunkX, chunkY, 层号) 播种的小 PRNG 算出,
 * 不存任何"已访问区域"的状态:船开出去一万像素再回头,看到的还是同一片星
 * (这正是"动态生成 + 省内存"的口径:内存里永远只有视野内 ±1 chunk 的两张 Graphics,
 * 与航程无关;重访靠重算,不靠记录)。
 *
 * 视差 = 每层把镜头 pivot 乘一个 <1 的系数:远层动得慢、近层动得快,
 * 船一开就有纵深。层的 scale 与世界层相同,于是星点大小用世界 px 表达,
 * 与敌人/子弹同一套尺度直觉。
 *
 * 重绘只发生在**可见 chunk 集合变化**的那一帧(巡航速度下约几秒一次),
 * 平时 sync 只改容器变换 —— 逐帧零几何重建、零分配(铁律 3)。
 * 每次重绘的规模 = 视野 chunk 数 × 每 chunk 星数 ≈ 数百个圆,一次性的量,可忽略。
 *
 * PRNG 不用 Math.random(与链电折角定死常量同一条理由):渲染层掷真随机,
 * 同一片天区两次路过就长得不一样,"方位参照"当场失效。
 * 色域一律冷色暗调(GDD §12:暖色是敌人的),亮度压在残骸(DROP_TINT)之下 ——
 * 星野是背景,不许与任何可拾取/可攻击的东西抢读数。
 */
import { Container, Graphics } from 'pixi.js';

/** chunk 边长(虚拟平面 px)。取视野(~1333×750 世界 px)的一半档:平移一屏跨 2~3 个 chunk */
const CHUNK = 512;
/** 可见范围外扩的 chunk 数:星点必须在进入视野**之前**就画好,否则会在屏幕边上凭空亮起 */
const CHUNK_MARGIN = 1;

interface StarLayerSpec {
  /** 视差系数(镜头 pivot × 它):越小越"远"、动得越慢 */
  parallax: number;
  /** 每 chunk 星数 */
  stars: number;
  /** 星点半径区间(世界 px) */
  rMin: number;
  rMax: number;
  /** 不透明度区间 */
  aMin: number;
  aMax: number;
  /** 冷色小调色板,按 PRNG 逐星取 */
  colors: number[];
}

/** 远层:多、小、暗;近层:少、大、亮一点。两层的速度差才是纵深感的来源 */
const LAYER_SPECS: StarLayerSpec[] = [
  {
    parallax: 0.35,
    stars: 14,
    rMin: 0.7,
    rMax: 1.4,
    aMin: 0.16,
    aMax: 0.4,
    colors: [0x8fa8c8, 0xa9c1d9, 0x7e93b5],
  },
  {
    parallax: 0.7,
    stars: 8,
    rMin: 1.0,
    rMax: 2.1,
    aMin: 0.28,
    aMax: 0.6,
    colors: [0xcfe2f3, 0x9ab8d8, 0x9adcff],
  },
];

/**
 * chunk 坐标 → 32 位种子。乘的是两个常用的大素数(Boost hash_combine 同款),
 * 相邻 chunk 的种子彻底不相关 —— 直接用 cx ^ cy 会让对角线上的 chunk 星图重复。
 */
function chunkSeed(cx: number, cy: number, salt: number): number {
  let h = Math.imul(cx, 0x9e3779b1) ^ Math.imul(cy, 0x85ebca77) ^ Math.imul(salt + 1, 0xc2b2ae3d);
  h ^= h >>> 16;
  h = Math.imul(h, 0x45d9f3b);
  h ^= h >>> 13;
  return h >>> 0;
}

/** mulberry32:够快够散的小 PRNG,一个 chunk 一支,画完即弃(局部变量,不留状态) */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class StarLayer {
  readonly view = new Container();
  private readonly g = new Graphics();
  /** 上一次画过的可见 chunk 范围(含边距)。初值取"空范围",首帧必然触发一次重绘 */
  private cx0 = 1;
  private cy0 = 1;
  private cx1 = 0;
  private cy1 = 0;

  constructor(private readonly spec: StarLayerSpec, private readonly salt: number) {
    this.view.addChild(this.g);
  }

  /**
   * @param scale 世界层缩放(星层同值,星点大小才与世界同尺度)
   * @param pivotX @param pivotY 世界层 pivot(镜头看向的世界点);本层乘 parallax 后使用
   * @param posX @param posY 世界层 position(屏幕中心 + broadside 顿挫):星野跟着一起顿,
   *   齐射那一下整张画面是一体的 —— 只有世界层抖、星空钉死不动,反而穿帮
   */
  sync(
    scale: number,
    pivotX: number,
    pivotY: number,
    posX: number,
    posY: number,
    viewW: number,
    viewH: number,
  ): void {
    const spec = this.spec;
    const vpx = pivotX * spec.parallax;
    const vpy = pivotY * spec.parallax;
    this.view.scale.set(scale);
    this.view.pivot.set(vpx, vpy);
    this.view.position.set(posX, posY);

    // 可见虚拟平面矩形 → chunk 范围(外扩 CHUNK_MARGIN)
    const halfW = viewW / 2 / scale;
    const halfH = viewH / 2 / scale;
    const cx0 = Math.floor((vpx - halfW) / CHUNK) - CHUNK_MARGIN;
    const cy0 = Math.floor((vpy - halfH) / CHUNK) - CHUNK_MARGIN;
    const cx1 = Math.floor((vpx + halfW) / CHUNK) + CHUNK_MARGIN;
    const cy1 = Math.floor((vpy + halfH) / CHUNK) + CHUNK_MARGIN;
    if (cx0 === this.cx0 && cy0 === this.cy0 && cx1 === this.cx1 && cy1 === this.cy1) return;
    this.cx0 = cx0;
    this.cy0 = cy0;
    this.cx1 = cx1;
    this.cy1 = cy1;
    this.redraw();
  }

  /** 整层重画当前范围内的全部 chunk。只在范围变化帧调用(见 sync 的早退) */
  private redraw(): void {
    const g = this.g;
    const spec = this.spec;
    g.clear();
    for (let cy = this.cy0; cy <= this.cy1; cy++) {
      for (let cx = this.cx0; cx <= this.cx1; cx++) {
        const rng = mulberry32(chunkSeed(cx, cy, this.salt));
        for (let i = 0; i < spec.stars; i++) {
          const x = (cx + rng()) * CHUNK;
          const y = (cy + rng()) * CHUNK;
          const r = spec.rMin + rng() * (spec.rMax - spec.rMin);
          const a = spec.aMin + rng() * (spec.aMax - spec.aMin);
          const color = spec.colors[Math.floor(rng() * spec.colors.length)] ?? 0xcfe2f3;
          g.circle(x, y, r).fill({ color, alpha: a });
        }
      }
    }
  }
}

export class Starfield {
  private readonly layers = LAYER_SPECS.map((spec, i) => new StarLayer(spec, i));

  /** 按远→近的顺序加进 stage(远层画在下面) */
  get views(): Container[] {
    return this.layers.map((l) => l.view);
  }

  sync(
    scale: number,
    pivotX: number,
    pivotY: number,
    posX: number,
    posY: number,
    viewW: number,
    viewH: number,
  ): void {
    for (let i = 0; i < this.layers.length; i++) {
      this.layers[i]!.sync(scale, pivotX, pivotY, posX, posY, viewW, viewH);
    }
  }
}
