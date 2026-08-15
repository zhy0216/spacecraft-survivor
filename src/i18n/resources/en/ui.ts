import type { DeepRecord } from '../../types';
import type { ui as zhUi } from '../zh-CN/ui';

/** 英文界面文案。结构以 zh-CN/ui 为准,值可自由换。 */
export const ui: DeepRecord<typeof zhUi> = {
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
  },
  pause: {
    title: 'Paused',
    resume: 'Resume',
    restart: 'New Run',
    retry: 'Retry Run',
    saveAndQuit: 'Save & Quit',
  },
};
