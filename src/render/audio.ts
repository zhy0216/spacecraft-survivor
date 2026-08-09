/**
 * 音频总线(WebAudio 合成器)—— 全仓唯一的发声出口,零素材文件、零 import。
 *
 * 口径:
 * - 不碰 sim:sim 的确定性口径下不允许任何"听得到"的副作用,这里只被渲染层与事件出口调用;
 *   本文件连类型 import 都没有,单独成立(铁律 1 的边界就画在 sim 目录之外)。
 * - 自动播放策略:AudioContext 不在 import 时创建,只在第一次 resume()(浏览器手势)才懒建并激活;
 *   全部发声方法在 context 缺位时静默 no-op —— 环境没声卡、测试无 WebAudio,都不许崩。
 * - 合成器:每种音效 = 一条短 envelope(attack 起音 + 指数衰减),靠波形/频段/时长分音色,
 *   击杀(低频爆点)/拾取(高频叮)/受击(撞击+火花)/开火(四家族)各占一域,蜂群贴脸才分得开。
 * - 节点复用:voice 池复用 GainNode 与噪声用的 BiquadFilterNode;振荡器/噪声源是 one-shot
 *   (WebAudio 规定一个源只能 start 一次,用完即弃) —— 但池子封顶 MAX_VOICES,超限直接丢,
 *   于是存活节点有硬上限、不随事件数增长,也没有逐帧分配(发声是事件驱动,天然不与帧率耦合)。
 * - 并发两道闸:同类型 16ms 级窗口限流(蜂群一帧十几个受击事件只出一声)+ voice 池并发上限。
 * - 音量分级:开火 < 击杀 < 拾取/放置 < 受击 < broadside 和弦;主音量走 masterVolume 概念,
 *   静音走总线 gain 归零(context 保留,便于再开)。
 * - 底噪(怪潮密度驱动):预生成 1s 白噪 buffer 循环 + 低通 + 55Hz 副低频,音量随 ratio 浮动,
 *   ratio=0 时增益归零(底噪是表现层的"氛围",用 Math.random 生成噪声数据无伤确定性)。
 */
const MAX_VOICES = 20;
/** 底噪层音量上限(压到最小,只给画面垫一层"还活着"的震动感) */
const AMBIENCE_VOLUME = 0.09;

/** 一个可复用 voice:gain 与 filter 可无限复用,source 是一次性耗材 */
interface Voice {
  gain: GainNode;
  filter: BiquadFilterNode | null;
  source: AudioScheduledSourceNode | null;
  busy: boolean;
}

/** 单条发声的参数表:波形/扫频/包络/峰值增益(peak 会乘 masterVolume) */
interface VoiceSpec {
  type?: OscillatorType;
  freq?: number;
  /** 线性扫频终点(缺省=恒定音高) */
  freqEnd?: number;
  /** 用共享噪声 buffer 发声(与振荡器二选一) */
  noise?: boolean;
  filterType?: BiquadFilterType;
  filterFreq?: number;
  filterQ?: number;
  /** 起音(s) */
  attack: number;
  /** 衰减(s) */
  decay: number;
  /** 峰值增益 */
  peak: number;
  /** 相对延迟(s):和弦/双音叠放用 */
  startAt?: number;
}

/** 同类型音效的最小间隔(s):窗口内再来的事件直接丢 —— 蜂群贴脸的解药 */
const MIN_INTERVAL: Record<string, number> = {
  'shoot:ammo': 0.016,
  'shoot:heat': 0.03,
  'shoot:charge': 0.04,
  'shoot:beam': 0.03,
  kill: 0.014,
  'hurt:hull': 0.03,
  'hurt:spark': 0.018,
  collect: 0.02,
  place: 0.05,
  upgrade: 0.08,
  broadside: 0.22,
  'warn:elite': 0.5,
  'warn:boss': 0.8,
};

let ctx: AudioContext | null = null;
let busGain: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;
let muted = false;
let ambienceRatio = 0;
let ambience: { gain: GainNode } | null = null;
const voices: Voice[] = [];
const lastPlayedAt = new Map<string, number>();

/** 主音量(0..1)。发声明时乘进各 voice 的峰值,静音开关与之正交(走总线 gain) */
export const masterVolume = { value: 0.8 };

/** 懒建 AudioContext + 总线 + 共享噪声 buffer;环境没有 WebAudio 时返回 null,全部发声静默 */
function ensureCtx(): AudioContext | null {
  if (ctx) return ctx;
  const AC =
    (globalThis as { AudioContext?: typeof AudioContext }).AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  try {
    ctx = new AC();
    busGain = ctx.createGain();
    busGain.gain.value = muted ? 0 : 1;
    busGain.connect(ctx.destination);
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    if (ambienceRatio > 0) ensureAmbience(ctx);
    return ctx;
  } catch {
    ctx = null;
    busGain = null;
    noiseBuffer = null;
    return null;
  }
}

/** 底噪链(只建一次):噪声循环 + 55Hz 副低频 → 低通 → 底噪 gain → 总线 */
function ensureAmbience(c: AudioContext): void {
  if (ambience || !noiseBuffer || !busGain) return;
  const src = c.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 320;
  filter.Q.value = 0.6;
  const sub = c.createOscillator();
  sub.type = 'sine';
  sub.frequency.value = 55;
  const gain = c.createGain();
  src.connect(filter);
  sub.connect(filter);
  filter.connect(gain);
  gain.connect(busGain);
  src.start();
  sub.start();
  ambience = { gain };
}

/** 限流闸:同一 key 在 MIN_INTERVAL 窗口内最多放行一次 */
function throttled(key: string): boolean {
  const min = MIN_INTERVAL[key] ?? 0.016;
  const now = performance.now();
  const last = lastPlayedAt.get(key);
  if (last !== undefined && now - last < min * 1000) return false;
  lastPlayedAt.set(key, now);
  return true;
}

/** 从池里取一个空闲 voice;池满直接丢(并发上限就是这道闸) */
function acquireVoice(c: AudioContext): Voice | null {
  for (const v of voices) {
    if (!v.busy) {
      v.busy = true;
      return v;
    }
  }
  if (voices.length >= MAX_VOICES) return null;
  const gain = c.createGain();
  gain.connect(busGain!);
  const v: Voice = { gain, filter: null, source: null, busy: true };
  voices.push(v);
  return v;
}

function releaseVoice(v: Voice): void {
  v.source?.disconnect();
  v.source = null;
  v.busy = false;
}

/**
 * 发声核心:取 voice → 写 envelope → 接振荡器/噪声源 → 排定 stop,onended 归还池。
 * 包络起点取 0.0001 而非 0:exponentialRamp 不允许从 0 出发(真实浏览器会抛错)。
 */
function playVoice(spec: VoiceSpec): void {
  const c = ctx;
  const bus = busGain;
  const nb = noiseBuffer;
  if (!c || !bus || !nb || muted) return;
  const v = acquireVoice(c);
  if (!v) return;
  const t = c.currentTime + (spec.startAt ?? 0);
  const gain = v.gain;
  const end = spec.attack + spec.decay;
  const peak = spec.peak * masterVolume.value;
  gain.gain.cancelScheduledValues(t);
  gain.gain.setValueAtTime(0.0001, t);
  if (peak > 0.0005) {
    gain.gain.linearRampToValueAtTime(peak, t + spec.attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + end);
  } else {
    // masterVolume 归零时指数斜坡从 0 出发会抛错,走线性收尾
    gain.gain.linearRampToValueAtTime(peak, t + spec.attack);
    gain.gain.linearRampToValueAtTime(0, t + end);
  }
  let src: AudioScheduledSourceNode;
  if (spec.noise) {
    if (!v.filter) {
      v.filter = c.createBiquadFilter();
      v.filter.connect(gain);
    }
    const filter = v.filter;
    if (spec.filterType) filter.type = spec.filterType;
    filter.frequency.setValueAtTime(spec.filterFreq ?? 1000, t);
    if (spec.filterQ !== undefined) filter.Q.setValueAtTime(spec.filterQ, t);
    const s = c.createBufferSource();
    s.buffer = nb;
    s.connect(filter);
    src = s;
  } else {
    const o = c.createOscillator();
    o.type = spec.type ?? 'sine';
    o.frequency.setValueAtTime(spec.freq ?? 440, t);
    if (spec.freqEnd !== undefined) o.frequency.linearRampToValueAtTime(spec.freqEnd, t + end);
    o.connect(gain);
    src = o;
  }
  v.source = src;
  src.onended = () => releaseVoice(v);
  src.start(t);
  src.stop(t + end + 0.02);
}

/**
 * 首次用户输入(键盘/点击)时调用:创建并 resume AudioContext,解锁自动播放。
 */
export function resume(): Promise<void> {
  const c = ensureCtx();
  if (!c || c.state !== 'suspended') return Promise.resolve();
  return c.resume().catch(() => undefined);
}

/** 静音开关:总线 gain 归零(保留 context 便于再开);启动时默认未静音 */
export function setMuted(m: boolean): void {
  muted = m;
  if (ctx && busGain) {
    busGain.gain.cancelScheduledValues(ctx.currentTime);
    busGain.gain.setTargetAtTime(m ? 0 : 1, ctx.currentTime, 0.02);
  }
}

export function setMasterVolume(v: number): void {
  masterVolume.value = Math.min(1, Math.max(0, v));
}

/**
 * 开火音,按塔型/节流分色 —— 四家族各占一个波形/频段,音量全仓最低,不糊成一片:
 * - 'ammo'   弹药系:短促方波"哒哒"爆点
 * - 'heat'   过热系:带通噪声"嘶"(节流越高越长越亮)
 * - 'charge' 充能系:锯齿波扫频爆发
 * - 'beam'   光束系:高频正弦短鸣
 * @param kind    家族名,未知值退回 'ammo'
 * @param throttle 0..1 节流压力:越高音调越高(烧热了声音上扬)
 */
export function playShoot(kind: string, throttle: number): void {
  const t = Math.min(1, Math.max(0, throttle));
  let family = kind;
  if (family !== 'ammo' && family !== 'heat' && family !== 'charge' && family !== 'beam') {
    family = 'ammo';
  }
  if (!throttled('shoot:' + family)) return;
  let spec: VoiceSpec;
  switch (family) {
    case 'heat':
      spec = {
        noise: true,
        filterType: 'bandpass',
        filterFreq: 900 * (1 + t * 0.7),
        filterQ: 0.8,
        attack: 0.02,
        decay: 0.22 + t * 0.12,
        peak: 0.1,
      };
      break;
    case 'charge':
      spec = {
        type: 'sawtooth',
        freq: 110,
        freqEnd: 420 * (1 + t * 0.6),
        attack: 0.05,
        decay: 0.15,
        peak: 0.12,
      };
      break;
    case 'beam':
      spec = {
        type: 'sine',
        freq: 880,
        freqEnd: 1250 + t * 400,
        attack: 0.006,
        decay: 0.15,
        peak: 0.1,
      };
      break;
    default:
      spec = {
        type: 'square',
        freq: 200 + t * 90,
        freqEnd: 150,
        attack: 0.003,
        decay: 0.055,
        peak: 0.13,
      };
  }
  playVoice(spec);
}

/** 击杀:短促爆点 —— 低频方波砸下去 + 噪声冲击。连杀音高爬升留给后续接线,这里只占位 */
export function playKill(): void {
  if (!throttled('kill')) return;
  playVoice({ type: 'square', freq: 180, freqEnd: 88, attack: 0.002, decay: 0.07, peak: 0.2 });
  playVoice({ noise: true, filterType: 'bandpass', filterFreq: 700, filterQ: 0.7, attack: 0.002, decay: 0.05, peak: 0.16 });
}

/**
 * 受击,与 sim 的 FXV_SPARK / FXV_HULL_HIT 同口径两种:
 * - 'hull' 真伤害:低频正弦下沉 + 低通噪声"撞击",最沉的反馈
 * - 'spark' 擦甲板:带通噪声火花 + 细金属刮音
 */
export function playHurt(kind: 'spark' | 'hull'): void {
  if (kind === 'hull') {
    if (!throttled('hurt:hull')) return;
    playVoice({ type: 'sine', freq: 100, freqEnd: 58, attack: 0.004, decay: 0.18, peak: 0.3 });
    playVoice({ noise: true, filterType: 'lowpass', filterFreq: 240, filterQ: 0.5, attack: 0.004, decay: 0.12, peak: 0.24 });
  } else {
    if (!throttled('hurt:spark')) return;
    playVoice({ noise: true, filterType: 'bandpass', filterFreq: 2600, filterQ: 1.4, attack: 0.002, decay: 0.08, peak: 0.16 });
    playVoice({ type: 'sine', freq: 940, freqEnd: 1500, attack: 0.002, decay: 0.05, peak: 0.1 });
  }
}

/** 残骸拾取:轻快高频叮声(基频 + 八度泛音),与击杀的低频爆点区分 */
export function playCollect(): void {
  if (!throttled('collect')) return;
  playVoice({ type: 'sine', freq: 1318, attack: 0.002, decay: 0.12, peak: 0.18 });
  playVoice({ type: 'sine', freq: 2637, attack: 0.002, decay: 0.08, peak: 0.08, startAt: 0.01 });
}

/** 升级:三选一弹卡的双音"弹出" */
export function playUpgrade(): void {
  if (!throttled('upgrade')) return;
  playVoice({ type: 'sine', freq: 523, attack: 0.003, decay: 0.09, peak: 0.2 });
  playVoice({ type: 'sine', freq: 784, attack: 0.003, decay: 0.14, peak: 0.2, startAt: 0.05 });
}

/** 放置/焊接确认:方波短鸣 + 焊花噪声点击 */
export function playPlace(): void {
  if (!throttled('place')) return;
  playVoice({ type: 'square', freq: 330, freqEnd: 240, attack: 0.003, decay: 0.1, peak: 0.18 });
  playVoice({ noise: true, filterType: 'bandpass', filterFreq: 1400, filterQ: 1.0, attack: 0.002, decay: 0.05, peak: 0.1 });
}

/**
 * broadside 专属和弦(GDD §12 的签名时刻):C-E-G-C' 大三和弦锯齿叠放 + C2 正弦垫底,
 * 一次起 5 个 voice、总峰值远超单塔开火 —— 靠耳朵就该认得出"这是齐射"。
 */
export function playBroadside(): void {
  if (!throttled('broadside')) return;
  const base = 261.6;
  const freqs = [base, base * 1.26, base * 1.5, base * 2];
  for (let i = 0; i < freqs.length; i++) {
    playVoice({
      type: 'sawtooth',
      freq: freqs[i]!,
      freqEnd: freqs[i]! * 0.98,
      attack: 0.004,
      decay: 0.28,
      peak: 0.11,
      startAt: i * 0.012,
    });
  }
  playVoice({ type: 'sine', freq: 65.4, attack: 0.004, decay: 0.32, peak: 0.22 });
}

/** 精英警告:低频鸣响(基础版,后续接线直接调用即可) */
export function playEliteWarn(): void {
  if (!throttled('warn:elite')) return;
  playVoice({ type: 'sawtooth', freq: 185, freqEnd: 150, attack: 0.03, decay: 0.4, peak: 0.26 });
}

/** 首领警告:更低更长的低频鸣响,与精英警告靠音高/时长分开 */
export function playBossWarn(): void {
  if (!throttled('warn:boss')) return;
  playVoice({ type: 'sawtooth', freq: 92, freqEnd: 70, attack: 0.05, decay: 0.7, peak: 0.3 });
}

/**
 * 底噪层:怪潮密度 0..1 驱动音量,ratio=0 时增益归零(无声)。
 * 早于首次 resume 调用时只记账,等 context 就位后再建链。
 */
export function setAmbience(ratio: number): void {
  ambienceRatio = Math.min(1, Math.max(0, ratio));
  const c = ensureCtx();
  if (!c) return;
  if (ambienceRatio === 0 && !ambience) return;
  ensureAmbience(c);
  if (ambience) {
    ambience.gain.gain.setTargetAtTime(
      ambienceRatio * AMBIENCE_VOLUME * masterVolume.value,
      c.currentTime,
      0.08,
    );
  }
}

/** 单例音频总线:只被渲染层/事件出口调用,永不反向驱动 sim */
export const audioBus = {
  resume,
  setMuted,
  setMasterVolume,
  playShoot,
  playKill,
  playHurt,
  playCollect,
  playUpgrade,
  playPlace,
  playBroadside,
  playEliteWarn,
  playBossWarn,
  setAmbience,
};
