/**
 * 共享类型:i18n 基础设施的类型出口。
 * 本文件保持纯类型、不 import 任何运行时 —— en 资源文件要用 DeepRecord 做结构校验,
 * 若这里引入运行时依赖会拖出环。
 */

/**
 * 递归结构约束:把 zh-CN 资源的**结构**映射成「同键、值均为 string」。
 *
 * 英文资源写成 `const common: DeepRecord<typeof zhCommon> = { ... }` 之后,tsc 会校验:
 *   - 少写 key → 报缺属性;
 *   - 多写 key → 对象字面量的多余属性检查直接报错;
 *   - 嵌套层级不一致 → 类型不匹配报错。
 * 英文因此不可能长出与中文不同的形状,值却可以随意换 —— zh-CN 是 key shape 的唯一真相源。
 */
export type DeepRecord<T> = T extends string
  ? string
  : T extends readonly (infer E)[]
    ? readonly DeepRecord<E>[]
    : { [K in keyof T]: DeepRecord<T[K]> };

/**
 * 界面对象在语言切换后需要重读翻译的契约。实现方提供 `refreshLocale(): void`,
 * 语言切换后由调用方(通常是设置页)逐个触发重刷。详见 02 号任务。
 */
export interface LocaleAware {
  refreshLocale(): void;
}
