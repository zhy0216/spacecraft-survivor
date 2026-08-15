import type { DeepRecord } from '../../types';
import type { story as zhStory } from '../zh-CN/story';

/** 英文叙事文本。结构以 zh-CN/story 为准,值可自由换。 */
export const story: DeepRecord<typeof zhStory> = {
  title: {
    subtitle: 'Star Wreck',
  },
  victory: {
    kicker: 'Voyage log · past the cordon',
    title: 'There is still starlight beyond the gate',
    body: 'The Boss’s wreck holds no throne, only a still-glowing coordinate. It points your course into deeper dark.',
    next: 'Next voyage · chase the signal',
  },
  epilogue: {
    kicker: 'Voyage log · past the cordon',
    title: 'There is still starlight beyond the gate',
    reveal: 'You pierced not a hive — only its gatekeeper.',
    body: 'The Boss’s wreck holds no throne, only a still-glowing coordinate. It points your course into deeper dark.',
    next: 'Next voyage · chase the signal',
    hint: 'Click the screen / Enter to return to the title',
    aria: 'Victory epilogue, click to return to the title',
    alt: 'The cobbled ship breaches the shattered beetle Boss; the core of its wreck casts the star map toward a vast shadow beyond',
  },
};
