/**
 * i18next 类型增强:让 t() 的 key 与插值参数在编译期受检。
 * key 空间 = zh-CN 资源的递归形状(唯一真相源);插值参数按每个值里的 {{var}} 逐条约束。
 */
import type { common } from './resources/zh-CN/common';
import type { ui } from './resources/zh-CN/ui';
import type { content } from './resources/zh-CN/content';
import type { story } from './resources/zh-CN/story';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    strictKeyChecks: true;
    resources: {
      common: typeof common;
      ui: typeof ui;
      content: typeof content;
      story: typeof story;
    };
  }
}
