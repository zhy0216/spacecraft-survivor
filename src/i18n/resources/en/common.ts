import type { DeepRecord } from '../../types';
import type { common as zhCommon } from '../zh-CN/common';

/**
 * 英文资源。值随语言走,结构必须与 zh-CN 完全一致 —— DeepRecord 在编译期校验:
 * 多了/少了 key、层级对不上,tsc 直接报错。**不得自行扩展结构**,zh-CN 是唯一真相源。
 */
export const common: DeepRecord<typeof zhCommon> = {
  confirm: 'Confirm',
  cancel: 'Cancel',
  back: 'Back',
  retry: 'Retry',
  close: 'Close',
  yes: 'Yes',
  no: 'No',
  on: 'On',
  off: 'Off',
  enabled: 'Enabled',
  disabled: 'Disabled',
  unlocked: 'Unlocked',
  locked: 'Locked',
  keys: {
    esc: 'Esc',
    enter: 'Enter',
  },
  errors: {
    saveFailed: 'Save failed',
    loadFailed: 'Load failed',
    uploadFailed: 'Upload failed',
  },
  enemiesLeft_one: '{{count}} enemy left',
  enemiesLeft_other: '{{count}} enemies left',
};
