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
    settings: 'Settings',
    codex: 'Codex',
    abandonSave: 'Sure? This will abandon your save',
    saveLine: 'Segment {{segment}} · {{duration}} · Kills {{kills}} · Hull {{hp}}',
  },
  settings: {
    title: 'Settings',
    volume: 'Volume',
    language: 'Language',
  },
  language: {
    // auto 档自称随语言翻;简体中文 / English 两个 self 名不翻
    auto: 'Auto',
    autoSystem: 'Auto: follows your system language',
    loadFailed: 'Failed to load language, keeping current language',
  },
  pause: {
    title: 'Paused',
    resume: 'Resume',
    restart: 'New Run',
    retry: 'Retry Run',
    saveAndQuit: 'Save & Quit',
  },
};
