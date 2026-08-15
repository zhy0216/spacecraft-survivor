# 01 · i18n 基础设施

- 优先级：P0 — 后续所有界面迁移的共同底座
- 依赖：—
- 范围：只搭基础设施与最小示例，不批量迁移现有 UI

## 背景

项目是 Vite + TypeScript + 原生 DOM/Pixi，没有 UI 框架。需要使用 `i18next` core，而不是
React/Vue 绑定。当前 TypeScript 已开启 `strict` 与 `noUncheckedIndexedAccess`，翻译 key、命名空间
和插值参数应尽可能在编译期检查，避免运行到某个罕见界面才发现缺 key。

## 任务

- [ ] 安装 `i18next` 运行时依赖，不引入 `react-i18next`、浏览器语言探测插件或 TMS SDK。
- [ ] 新建 `src/i18n/`：
      - `index.ts`：初始化、`t` 出口、切换语言、当前语言
      - `locale.ts`：支持语言类型与 locale 规范化
      - `format.ts`：数字、百分比、持续时间与紧凑数值格式
      - `types.ts`：资源 shape、`LocaleAware` 等共享类型
      - `resources/{zh-CN,en}/`：按 namespace 存资源
- [ ] 首轮 namespace 定为：
      - `common`：通用动作、状态、错误、键位名
      - `ui`：具体界面文案
      - `content`：武器、敌人、法令、词缀、航段等内容名称与描述
      - `story`：标题副标、胜利终幕等叙事文本
- [ ] 资源使用 `.ts` + `as const`，以 `zh-CN` 资源推导 key；英文资源使用递归 shape 约束，允许值不同但要求 key 结构一致。
- [ ] 配置 i18next：
      - 支持 `zh-CN`、`en`
      - `fallbackLng: 'zh-CN'`
      - 生产环境关闭自动上报 missing key
      - missing key 在开发环境显式告警
      - 统一 interpolation/escaping 策略
- [ ] 规定翻译结果只写入 `textContent`；初始化若设 `escapeValue: false`，必须在代码注释中说明安全前提：翻译字符串不得进入 `innerHTML`。
- [ ] 使用 Vite 静态可分析的加载方式加载语言资源。可以用字面量 loader map，或 `import.meta.glob`；禁止拼接任意路径再动态 import。
- [ ] 初始化时至少加载当前语言和 `zh-CN` fallback；切换到尚未加载的语言时先加载资源再 changeLanguage。
- [ ] `format.ts` 使用当前 locale 缓存 `Intl.NumberFormat`，提供至少：
      - `formatNumber(value, options?)`
      - `formatPercent(value, options?)`
      - `formatDuration(seconds)`，保持战斗计时器 `m:ss` 的语义
      - `formatSigned(value)`，供 `+15`、`-0.3s` 一类效果描述使用
- [ ] 给初始化、fallback、格式化和缺 key 行为补 Node 单测。

## 建议接口

```ts
export type SupportedLocale = 'zh-CN' | 'en';
export type LanguagePreference = 'auto' | SupportedLocale;

export async function initI18n(locale: SupportedLocale): Promise<void>;
export async function changeLocale(locale: SupportedLocale): Promise<void>;
export function currentLocale(): SupportedLocale;
export { t };

export interface LocaleAware {
  refreshLocale(): void;
}
```

具体签名可按 i18next 类型推导调整，但调用方不得直接依赖内部 resource loader。

## 验收标准

- [ ] `zh-CN`、`en` 都能初始化并读取同一个 typed key。
- [ ] 英文缺 key 时回落到中文；两边都缺时开发测试能发现。
- [ ] 插值参数缺失或 key 写错尽量由 TypeScript/测试拦截。
- [ ] 数字与百分比按 locale 格式化，且不会在每帧反复 new `Intl.NumberFormat`。
- [ ] `src/sim/`、`src/data/` 没有新增对 `src/i18n/` 的 import。
- [ ] `npm test`、`npm run build` 全绿。

## 口径说明与交接

- 中文资源是 fallback，也是 key shape 的唯一真相源；英文只提供翻译值，不自行扩展结构。
- 不以中文原文当 key：改措辞不应迫使全仓修改调用点。
- 当前只有两种语言，namespace 主要服务编辑与职责边界，不必为了懒加载把每个小页面拆成一个网络请求。
