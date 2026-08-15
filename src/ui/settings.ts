/**
 * 玩家设置的**纯数据层**(零 DOM / 零 localStorage,Node 里可单测)——
 * 与 sim/progress.ts 对 ui/progressStorage.ts 是同一种分工:
 * 本文件只管"一份设置长什么样、怎么夹取、怎么 JSON 往返",
 * 读写存储在 ui/settingsStorage.ts,画面在 ui/settingsMenu.ts,两者都在下游。
 *
 * ## 一条自律:设置项必须**真的接在什么东西上**
 *
 * 设置页最容易长出来的东西是装饰性开关 —— 界面上摆着、拨过去什么也不发生。
 * 于是这里的每一项都在注释里写明它落到哪一行代码上;加新项之前先找到那个落点,
 * 找不到就不该加。目前五项各有出处:
 *   masterVolume / muted → render/audio.ts 的 setMasterVolume / setMuted
 *   shake               → render/renderer.ts 的震屏位移(setEffects)
 *   damageNumbers       → render/renderer.ts 的伤害飘字入池(setEffects)
 *   hitstop             → main.ts 的击杀顿帧窗口
 *   language            → main.ts 的语言解析 + i18n 初始化(i18n/locale.ts 的 resolveLanguage)
 *
 * ## 设置不是存档
 *
 * 它既不进 checksum、也不影响任何 sim 判定(全是表现与音量,语言更是界面层的事)——
 * 于是改设置绝不会让"同 seed 同输入 → 同轨迹"这条口径松动一分,
 * 也因此它单独一个存储键、与局内存档/元进度互不牵连:清了存档不该顺手把音量调回默认。
 */
import type { LanguagePreference } from '../i18n/locale';
import { isLanguagePreference } from '../i18n/locale';

/** 一份玩家设置。全部是表现/音量/语言,与 sim 无关(见文件头) */
export interface Settings {
  /** 主音量 0..1。落点:audioBus.setMasterVolume */
  masterVolume: number;
  /** 静音。与主音量各管各的:调低音量不等于静音,静音也不该把音量旋钮清零 */
  muted: boolean;
  /** 震屏强度 0..1(0 = 完全关闭)。落点:renderer 的震屏位移倍率 */
  shake: number;
  /** 伤害飘字开关。落点:renderer 的飘字入池 —— 关掉后一个字都不生成,不是画出来再隐藏 */
  damageNumbers: boolean;
  /** 击杀顿帧(hitstop)。落点:main 的冻结窗;关掉后击杀不再顿挫,画面更顺 */
  hitstop: boolean;
  /**
   * 界面语言偏好。'auto' = 跟随系统语言。落点:main 的 setLanguage ——
   * 走 i18n 那条管线,不进 applySettings 的音视频分发。存的是**偏好**而不是
   * 当时解析出的具体语言:系统语言以后变了,下次启动应重新解析。
   */
  language: LanguagePreference;
}

/**
 * 出厂设置。**与各处代码里原本写死的值一致**(音量 0.8 = audio.ts 的 masterVolume 初值,
 * 震屏/飘字/顿帧都是原本恒开)—— 于是"没有设置文件的新玩家"与"设置全默认的老玩家"
 * 玩到的是同一个游戏,设置系统上线不改变任何既有手感。语言默认 auto:
 * 没有明确说过要哪种语言的人,理应跟着系统语言走 —— 而 auto 探测不到
 * 中文时回落英文(见 i18n/locale.ts 的 resolveLanguage:默认英文,除非浏览器检测到中文)。
 */
export function createSettings(): Settings {
  return {
    masterVolume: 0.8,
    muted: false,
    shake: 1,
    damageNumbers: true,
    hitstop: true,
    language: 'auto',
  };
}

/** 0..1 夹取,非数/NaN 退回 fallback(手改过的设置文件不许把音量弄成 NaN 而让整条音频哑掉) */
function clamp01(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/** 语言偏好:只有 auto / zh-CN / en 三张合法牌,手写进去的怪字符串一律回退 fallback */
function normalizeLanguage(v: unknown, fallback: LanguagePreference): LanguagePreference {
  return typeof v === 'string' && isLanguagePreference(v) ? v : fallback;
}

/**
 * 任意来路的数据 → 一份合法设置。**逐项兜底而不是整份判废**(与局内存档相反):
 * 设置只影响表现,一项坏了退回该项的默认值即可,没有理由因为一个坏字段
 * 把玩家其余几项都调回出厂 —— 而半局存档一个字段错位就会毁掉整局,故那边从严。
 */
export function normalizeSettings(raw: unknown): Settings {
  const d = createSettings();
  if (typeof raw !== 'object' || raw === null) return d;
  const o = raw as Record<string, unknown>;
  return {
    masterVolume: clamp01(o['masterVolume'], d.masterVolume),
    muted: bool(o['muted'], d.muted),
    shake: clamp01(o['shake'], d.shake),
    damageNumbers: bool(o['damageNumbers'], d.damageNumbers),
    hitstop: bool(o['hitstop'], d.hitstop),
    // 老 `starwreck.settings.v1` 没有这一项:缺字段按上面的 normalizeLanguage 回落 auto ——
    // 其余四项原样保留,不会被这一项的新增连累清空
    language: normalizeLanguage(o['language'], d.language),
  };
}

export function serializeSettings(s: Settings): string {
  return JSON.stringify(s);
}

/** 非法 JSON 也照样给一份默认设置:设置读不出来不是错误状态,是"这台机器还没设置过" */
export function parseSettings(json: string): Settings {
  try {
    return normalizeSettings(JSON.parse(json));
  } catch {
    return createSettings();
  }
}

/** 音量百分比文案等**显示文案**随语言迁移后移出本纯数据层(见 ui/presentation/settingsText.ts)。 */

/**
 * 震屏强度的三档循环。做成"档"而不是连续滑杆:震屏是晕动症开关,
 * 玩家要的是"关掉 / 小一点 / 原样",没人需要 37% 的震屏。
 */
export function nextShake(v: number): number {
  if (v > 0.55) return 0.5;
  if (v > 0.01) return 0;
  return 1;
}

/** 语言三档循环:自动 → 简体中文 → English → 自动。设置页那颗按钮每点一次走一档 */
export function nextLanguage(v: LanguagePreference): LanguagePreference {
  if (v === 'auto') return 'zh-CN';
  if (v === 'zh-CN') return 'en';
  return 'auto';
}
