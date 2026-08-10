/**
 * 音频总线 —— 全仓唯一的发声出口。浏览器优先播放 genmedia 生成的音乐/音效素材,
 * WebAudio 解码不可用或单个素材加载失败时才退回轻量合成器。
 *
 * 口径:
 * - 不碰 sim:sim 的确定性口径下不允许任何"听得到"的副作用,这里只被渲染层与事件出口调用;
 *   本文件连类型 import 都没有,单独成立(铁律 1 的边界就画在 sim 目录之外)。
 * - 自动播放策略:AudioContext 不在 import/逐帧更新时创建,只在第一次 resume()(浏览器手势)懒建并激活;
 *   全部发声方法在 context 缺位时静默 no-op —— 环境没声卡、测试无 WebAudio,都不许崩。
 * - 主音源:背景音乐由 Lyria 2 生成并做了首尾交叉淡化;14 个战斗/UI 音效由 Sonilo 生成,
 *   经裁切、单声道化和尾部淡出后交给 AudioBufferSourceNode 播放。
 * - 兜底合成器:voice 池复用 GainNode 与噪声用的 BiquadFilterNode;振荡器/噪声源是 one-shot
 *   (WebAudio 规定一个源只能 start 一次,用完即弃) —— 但池子封顶 MAX_VOICES,超限直接丢,
 *   于是存活节点有硬上限、不随事件数增长,也没有逐帧分配(发声是事件驱动,天然不与帧率耦合)。
 * - 并发两道闸:同类型 16ms 级窗口限流(蜂群一帧十几个受击事件只出一声)+ voice 池并发上限。
 * - 音量分级:开火 < 击杀 < 拾取/放置 < 受击 < broadside 和弦;主音量走 masterVolume 概念,
 *   静音走总线 gain 归零(context 保留,便于再开)。
 * - 怪潮密度驱动背景音乐的音量与低通开度;旧白噪/55Hz 底噪只留给无解码能力的测试/旧环境。
 */
const MAX_VOICES = 20;
const MAX_SAMPLE_VOICES = 28;
const MUSIC_VOLUME = 0.25;
/** 无素材解码能力时的底噪兜底音量 */
const FALLBACK_AMBIENCE_VOLUME = 0.09;

// —— 击杀连段的音高爬升(畅玩性)——
// 击杀是割草游戏的正反馈节拍器:连杀 = 音高逐级上扬,玩家听得出"这一波杀疯了"。
// 音频在 sim 之外(纯表现,不受确定性约束),故窗口计时走 performance.now() 墙钟 ——
// 与限流闸(throttled)同一只钟,渲染层每帧调用多少次都不影响它。
/** 连杀窗口(ms):窗口内再来一次击杀 = 叠一层;超过 = 连杀断掉、从头数 */
const KILL_COMBO_WINDOW_MS = 1500; // 占位待调
/** 每叠一层升的半音数;频率倍率 = 2^(半音/12)(十二平均律) */
const KILL_COMBO_SEMITONES_PER_STACK = 2;
/** 音高爬升封顶(半音):叠到 6 层就不再升,免得连杀声嘶叫成警报 */
const KILL_COMBO_MAX_SEMITONES = 10;
/** 连杀层数(模块级状态,重开/换局自然被窗口清掉,不必单独 reset) */
let killStreak = 0;
/** 上一次真正出声的击杀时刻(performance.now());0 = 还没杀过 */
let lastKillAt = 0;

/**
 * 连杀层数 → 音高倍率(纯函数,便于单测):第 1 层恒 1.0(基准音),此后每层 +2 半音、
 * 封顶 +10 半音。0/负数/NaN 一律退回 1.0(防御:NaN 一路传染进 Math.pow 会产出 NaN 频率)
 */
export function killStreakPitch(stacks: number): number {
  if (!(stacks > 0)) return 1;
  const semis = Math.min(
    KILL_COMBO_MAX_SEMITONES,
    (stacks - 1) * KILL_COMBO_SEMITONES_PER_STACK,
  );
  return Math.pow(2, semis / 12);
}

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

type SampleKey =
  | 'shoot-ammo'
  | 'shoot-heat'
  | 'shoot-charge'
  | 'shoot-beam'
  | 'kill'
  | 'hurt-hull'
  | 'hurt-spark'
  | 'collect'
  | 'upgrade'
  | 'place'
  | 'broadside'
  | 'elite-warn'
  | 'boss-warn'
  | 'explosion';

/** Vite 在构建时把这些 URL 指向带 hash 的运行时素材。 */
const SAMPLE_URLS: Record<SampleKey, string> = {
  'shoot-ammo': new URL('../../assets/game/audio/sfx/shoot-ammo.wav', import.meta.url).href,
  'shoot-heat': new URL('../../assets/game/audio/sfx/shoot-heat.wav', import.meta.url).href,
  'shoot-charge': new URL('../../assets/game/audio/sfx/shoot-charge.wav', import.meta.url).href,
  'shoot-beam': new URL('../../assets/game/audio/sfx/shoot-beam.wav', import.meta.url).href,
  kill: new URL('../../assets/game/audio/sfx/kill.wav', import.meta.url).href,
  'hurt-hull': new URL('../../assets/game/audio/sfx/hurt-hull.wav', import.meta.url).href,
  'hurt-spark': new URL('../../assets/game/audio/sfx/hurt-spark.wav', import.meta.url).href,
  collect: new URL('../../assets/game/audio/sfx/collect.wav', import.meta.url).href,
  upgrade: new URL('../../assets/game/audio/sfx/upgrade.wav', import.meta.url).href,
  place: new URL('../../assets/game/audio/sfx/place.wav', import.meta.url).href,
  broadside: new URL('../../assets/game/audio/sfx/broadside.wav', import.meta.url).href,
  'elite-warn': new URL('../../assets/game/audio/sfx/elite-warn.wav', import.meta.url).href,
  'boss-warn': new URL('../../assets/game/audio/sfx/boss-warn.wav', import.meta.url).href,
  explosion: new URL('../../assets/game/audio/sfx/explosion.wav', import.meta.url).href,
};

const MUSIC_URL = new URL(
  '../../assets/game/audio/music/starwreck-loop.mp3',
  import.meta.url,
).href;

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
  explosion: 0.8,
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
const sampleBuffers = new Map<SampleKey, AudioBuffer>();
let generatedAudioLoad: Promise<void> | null = null;
let generatedAudioLoadComplete = false;
let sampleVoiceCount = 0;
let musicBuffer: AudioBuffer | null = null;
let musicSource: AudioBufferSourceNode | null = null;
let musicGain: GainNode | null = null;
let musicFilter: BiquadFilterNode | null = null;

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
    return ctx;
  } catch {
    ctx = null;
    busGain = null;
    noiseBuffer = null;
    return null;
  }
}

function supportsGeneratedAudio(c: AudioContext): boolean {
  return typeof c.decodeAudioData === 'function' && typeof globalThis.fetch === 'function';
}

function updateMusicMix(): void {
  const c = ctx;
  if (!c || !musicGain || !musicFilter) return;
  const level = MUSIC_VOLUME * (0.82 + ambienceRatio * 0.18) * masterVolume.value;
  musicGain.gain.cancelScheduledValues(c.currentTime);
  musicGain.gain.setTargetAtTime(level, c.currentTime, 0.16);
  musicFilter.frequency.cancelScheduledValues(c.currentTime);
  musicFilter.frequency.setTargetAtTime(5200 + ambienceRatio * 8800, c.currentTime, 0.22);
}

function startMusic(): void {
  const c = ctx;
  if (!c || !busGain || !musicBuffer || musicSource) return;
  const source = c.createBufferSource();
  const filter = c.createBiquadFilter();
  const gain = c.createGain();
  source.buffer = musicBuffer;
  source.loop = true;
  filter.type = 'lowpass';
  filter.Q.value = 0.55;
  source.connect(filter);
  filter.connect(gain);
  gain.connect(busGain);
  musicSource = source;
  musicFilter = filter;
  musicGain = gain;
  updateMusicMix();
  source.start();
}

async function decodeUrl(c: AudioContext, url: string): Promise<AudioBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return c.decodeAudioData(await response.arrayBuffer());
}

/** 第一次解锁音频时一次性预解码;加载期间宁可短暂安静,也不把旧音色漏回正式浏览器。 */
function loadGeneratedAudio(c: AudioContext): Promise<void> {
  if (generatedAudioLoad) return generatedAudioLoad;
  const sampleJobs = (Object.entries(SAMPLE_URLS) as Array<[SampleKey, string]>).map(
    async ([key, url]) => {
      sampleBuffers.set(key, await decodeUrl(c, url));
    },
  );
  const musicJob = decodeUrl(c, MUSIC_URL).then((buffer) => {
    musicBuffer = buffer;
    startMusic();
  });
  generatedAudioLoad = Promise.allSettled([...sampleJobs, musicJob]).then((results) => {
    generatedAudioLoadComplete = true;
    const failed = results.filter((result) => result.status === 'rejected').length;
    if (failed > 0) {
      console.warn(`[audio] ${failed} generated asset(s) failed to decode; using synth fallback`);
    }
  });
  return generatedAudioLoad;
}

/** 已有素材就播放;返回 false 表示调用方需要决定等待还是走合成兜底。 */
function playSample(key: SampleKey, peak: number, playbackRate = 1): boolean {
  const c = ctx;
  const buffer = sampleBuffers.get(key);
  if (!c || !busGain || !buffer) return false;
  // 已经有正式素材时,静音或并发封顶都算“消费掉”这次事件,不能再漏到旧合成兜底。
  if (muted || sampleVoiceCount >= MAX_SAMPLE_VOICES) return true;
  const source = c.createBufferSource();
  const gain = c.createGain();
  const now = c.currentTime;
  source.buffer = buffer;
  source.playbackRate.setValueAtTime(Math.min(1.8, Math.max(0.75, playbackRate)), now);
  gain.gain.setValueAtTime(peak * masterVolume.value, now);
  source.connect(gain);
  gain.connect(busGain);
  sampleVoiceCount++;
  source.onended = () => {
    source.disconnect();
    gain.disconnect();
    sampleVoiceCount--;
  };
  source.start(now);
  return true;
}

function deferSynthFallback(): boolean {
  return !!ctx && supportsGeneratedAudio(ctx) && !generatedAudioLoadComplete;
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
export async function resume(): Promise<void> {
  const c = ensureCtx();
  if (!c) return;
  if (c.state === 'suspended') await c.resume().catch(() => undefined);
  if (supportsGeneratedAudio(c)) void loadGeneratedAudio(c);
}

/** 静音开关:总线 gain 归零(保留 context 便于再开);启动时默认未静音 */
export function setMuted(m: boolean): void {
  muted = m;
  if (ctx && busGain) {
    busGain.gain.cancelScheduledValues(ctx.currentTime);
    busGain.gain.setTargetAtTime(m ? 0 : 1, ctx.currentTime, 0.02);
  }
  if (!m) startMusic();
}

/** 只读静音状态:HUD 与暂停菜单共用同一枚开关,各自画按钮文字时读它对齐 */
export function isMuted(): boolean {
  return muted;
}

export function setMasterVolume(v: number): void {
  masterVolume.value = Math.min(1, Math.max(0, v));
  updateMusicMix();
  if (ctx && ambience) {
    ambience.gain.gain.setTargetAtTime(
      ambienceRatio * FALLBACK_AMBIENCE_VOLUME * masterVolume.value,
      ctx.currentTime,
      0.08,
    );
  }
}

/**
 * 开火音,按塔型分配四条 genmedia 音轨,音量全仓最低,不糊成一片:
 * - 'ammo'   弹药系:短促电磁弹丸/金属枪机
 * - 'heat'   过热系:等离子喷发与明亮电弧
 * - 'charge' 充能系:磁轨蓄能后重击释放
 * - 'beam'   光束系:干净锐利的激光点火
 * @param kind    家族名,未知值退回 'ammo'
 * @param throttle 0..1 节流压力:轻微改变素材播放速率,让热量/充能状态听得见但不走调
 */
export function playShoot(kind: string, throttle: number): void {
  const t = Math.min(1, Math.max(0, throttle));
  let family = kind;
  if (family !== 'ammo' && family !== 'heat' && family !== 'charge' && family !== 'beam') {
    family = 'ammo';
  }
  if (!throttled('shoot:' + family)) return;
  const rate = 0.96 + t * 0.08;
  const sampleKey = `shoot-${family}` as SampleKey;
  const samplePeak =
    family === 'charge' ? 0.13 : family === 'ammo' ? 0.1 : family === 'heat' ? 0.08 : 0.07;
  if (playSample(sampleKey, samplePeak, rate)) return;
  if (deferSynthFallback()) return;
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

/**
 * 击杀:外星目标破裂 + 残骸亮点。连杀时素材播放音高逐级上扬:
 * 只在**真正出声**的那次叠层(限流丢掉的击杀不数 —— 那是同帧的重复采样,不是第二次击杀),
 * 于是音高的节奏与耳朵听到的爆点一一对应,不会出现"没听到声、音高却爬了"的错位。
 */
export function playKill(): void {
  if (!throttled('kill')) return;
  const now = performance.now();
  killStreak = now - lastKillAt <= KILL_COMBO_WINDOW_MS ? killStreak + 1 : 1;
  lastKillAt = now;
  const pitch = killStreakPitch(killStreak);
  if (playSample('kill', 0.16, pitch)) return;
  if (deferSynthFallback()) return;
  playVoice({ type: 'square', freq: 180 * pitch, freqEnd: 88 * pitch, attack: 0.002, decay: 0.07, peak: 0.2 });
  playVoice({ noise: true, filterType: 'bandpass', filterFreq: 700, filterQ: 0.7, attack: 0.002, decay: 0.05, peak: 0.16 });
}

/**
 * 沉船爆炸(畅玩性:死亡演出的一记重锤)。素材包含低频冲击、撕裂金属和扩散等离子,
 * 比普通受击更长、更响 —— 它是"船没了"这整场演出唯一的音效落点,
 * 与扩散环/碎片/震屏共用同一个触发点(renderer.playShipDeathExplosion),一次且仅一次。
 */
export function playExplosion(): void {
  if (!throttled('explosion')) return;
  if (playSample('explosion', 0.46)) return;
  if (deferSynthFallback()) return;
  playVoice({ type: 'sine', freq: 120, freqEnd: 32, attack: 0.004, decay: 0.5, peak: 0.4 });
  playVoice({ noise: true, filterType: 'lowpass', filterFreq: 900, filterQ: 0.5, attack: 0.002, decay: 0.34, peak: 0.32 });
}

/**
 * 受击,与 sim 的 FXV_SPARK / FXV_HULL_HIT 同口径两种:
 * - 'hull' 真伤害:船壳重击、舱板共振与低频冲击
 * - 'spark' 擦甲板:短促金属刮擦与电火花
 */
export function playHurt(kind: 'spark' | 'hull'): void {
  if (kind === 'hull') {
    if (!throttled('hurt:hull')) return;
    if (playSample('hurt-hull', 0.32)) return;
    if (deferSynthFallback()) return;
    playVoice({ type: 'sine', freq: 100, freqEnd: 58, attack: 0.004, decay: 0.18, peak: 0.3 });
    playVoice({ noise: true, filterType: 'lowpass', filterFreq: 240, filterQ: 0.5, attack: 0.004, decay: 0.12, peak: 0.24 });
  } else {
    if (!throttled('hurt:spark')) return;
    if (playSample('hurt-spark', 0.18)) return;
    if (deferSynthFallback()) return;
    playVoice({ noise: true, filterType: 'bandpass', filterFreq: 2600, filterQ: 1.4, attack: 0.002, decay: 0.08, peak: 0.16 });
    playVoice({ type: 'sine', freq: 940, freqEnd: 1500, attack: 0.002, decay: 0.05, peak: 0.1 });
  }
}

/** 残骸拾取:上扬的数字提示音 + 金属亮点,与击杀冲击区分 */
export function playCollect(): void {
  if (!throttled('collect')) return;
  if (playSample('collect', 0.17)) return;
  if (deferSynthFallback()) return;
  playVoice({ type: 'sine', freq: 1318, attack: 0.002, decay: 0.12, peak: 0.18 });
  playVoice({ type: 'sine', freq: 2637, attack: 0.002, decay: 0.08, peak: 0.08, startAt: 0.01 });
}

/** 升级:三选一确认用的全息上扬提示音 */
export function playUpgrade(): void {
  if (!throttled('upgrade')) return;
  if (playSample('upgrade', 0.2)) return;
  if (deferSynthFallback()) return;
  playVoice({ type: 'sine', freq: 523, attack: 0.003, decay: 0.09, peak: 0.2 });
  playVoice({ type: 'sine', freq: 784, attack: 0.003, decay: 0.14, peak: 0.2, startAt: 0.05 });
}

/** 放置/焊接确认:磁吸锁扣 + 焊花 + 确认亮音 */
export function playPlace(): void {
  if (!throttled('place')) return;
  if (playSample('place', 0.19)) return;
  if (deferSynthFallback()) return;
  playVoice({ type: 'square', freq: 330, freqEnd: 240, attack: 0.003, decay: 0.1, peak: 0.18 });
  playVoice({ noise: true, filterType: 'bandpass', filterFreq: 1400, filterQ: 1.0, attack: 0.002, decay: 0.05, peak: 0.1 });
}

/**
 * broadside 专属同步齐射素材(GDD §12 的签名时刻),总峰值远超单塔开火;
 * 无素材解码能力时才退回 C-E-G-C' 合成和弦。
 */
export function playBroadside(): void {
  if (!throttled('broadside')) return;
  if (playSample('broadside', 0.42)) return;
  if (deferSynthFallback()) return;
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

/** 精英警告:短促双音金属警报 */
export function playEliteWarn(): void {
  if (!throttled('warn:elite')) return;
  if (playSample('elite-warn', 0.28)) return;
  if (deferSynthFallback()) return;
  playVoice({ type: 'sawtooth', freq: 185, freqEnd: 150, attack: 0.03, decay: 0.4, peak: 0.26 });
}

/** 首领警告:更低、更长的舰桥警报,与精英警告靠重量/时长分开 */
export function playBossWarn(): void {
  if (!throttled('warn:boss')) return;
  if (playSample('boss-warn', 0.34)) return;
  if (deferSynthFallback()) return;
  playVoice({ type: 'sawtooth', freq: 92, freqEnd: 70, attack: 0.05, decay: 0.7, peak: 0.3 });
}

/**
 * 怪潮密度 0..1:正式浏览器用它打开背景音乐的高频并小幅抬升音量;
 * 无解码能力的环境才启用旧底噪作为兼容兜底。
 */
export function setAmbience(ratio: number): void {
  ambienceRatio = Math.min(1, Math.max(0, ratio));
  const c = ctx;
  if (!c) return;
  if (supportsGeneratedAudio(c)) {
    updateMusicMix();
    return;
  }
  if (ambienceRatio === 0 && !ambience) return;
  ensureAmbience(c);
  if (ambience) {
    ambience.gain.gain.setTargetAtTime(
      ambienceRatio * FALLBACK_AMBIENCE_VOLUME * masterVolume.value,
      c.currentTime,
      0.08,
    );
  }
}

/** 单例音频总线:只被渲染层/事件出口调用,永不反向驱动 sim */
export const audioBus = {
  resume,
  setMuted,
  isMuted,
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
  playExplosion,
  setAmbience,
};
