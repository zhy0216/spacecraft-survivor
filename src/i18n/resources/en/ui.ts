import type { DeepRecord } from '../../types';
import type { ui as zhUi } from '../zh-CN/ui';

/** 英文界面文案。结构以 zh-CN/ui 为准,值可自由换。 */
export const ui: DeepRecord<typeof zhUi> = {
  title: {
    // STARWRECK 是产品名,不译;中文名 STARWRECK 星骸 只在 zh-CN 出现
    base: 'STARWRECK',
  },
  menu: {
    newRun: 'Start Voyage',
    continueRun: 'Continue Voyage',
    newRunWithSave: 'New Voyage',
    settings: 'Settings',
    codex: 'Codex',
    abandonSave: 'Sure? This will abandon your save',
    continueLine: 'Segment {{segment}} · {{duration}} · Kills {{kills}} · Hull {{hp}}',
    hintContinue: '{{enter}} to Continue · {{esc}} to cancel',
    hintStart: '{{enter}} to Start',
  },
  settings: {
    title: 'Settings',
    volume: 'Master Volume',
    sound: 'Sound',
    shake: 'Screen Shake',
    damageNumbers: 'Damage Numbers',
    hitstop: 'Hitstop',
    language: 'Language',
    back: 'Back ({{esc}})',
    reset: 'Restore Defaults',
    instantSaveHint: 'Settings apply instantly and are saved automatically',
    shakeLevels: {
      off: 'Off',
      low: 'Low',
      standard: 'Standard',
    },
  },
  language: {
    // auto 档自称随语言翻;简体中文 / English 两个 self 名不翻
    auto: 'Auto',
    autoSystem: 'Auto: follows your system language',
    loadFailed: 'Failed to load language, keeping current language',
  },
  pause: {
    title: 'Paused',
    resume: 'Resume ({{esc}})',
    restart: 'New Run (new seed)',
    retry: 'Retry Run (same seed)',
    saveAndQuit: 'Save & Quit to Title',
    saveFailed: 'Save failed (storage unavailable)',
    settings: 'Settings',
    soundOn: 'Sound: On',
    soundOff: 'Sound: Off',
    hint: 'Press {{esc}} anytime during battle to pause',
  },
  keys: {
    wasd: 'Steer',
    space: 'Boost',
    layout: 'Weapon layout',
    firingArc: 'Firing arc',
    pause: 'Pause',
  },
  toast: {
    unlock: 'Unlocked: {{name}}',
    keyHint: 'Press I to adjust weapon orientation',
    magnet: 'Magnet storm: debris flies to you for 2s',
  },
  banner: {
    boss: 'Cordon breached',
    bossSupply: 'Cordon breached · supply beacon dropped',
    segmentCleared: 'Segment {{segment}} cleared · supply beacon dropped',
  },
  upload: {
    noEndpoint: 'No upload endpoint configured',
    noLog: 'No run log this game',
    failed: 'Upload failed',
  },
};
