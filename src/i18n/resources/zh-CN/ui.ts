/** ui:具体界面文案(标题菜单 / 设置 / 暂停)。结构以本文件为准,en 照抄结构。 */
export const ui = {
  title: {
    // 页面标题的本地化基底:STARWRECK 是产品名,永不翻译;开发模式追加 "· dev"(main.ts)
    base: 'STARWRECK 星骸',
  },
  menu: {
    newRun: '开始航行',
    continueRun: '继续上次航行',
    settings: '设置',
    codex: '图鉴',
    abandonSave: '确定?这会放弃存档进度',
    saveLine: '航段 {{segment}} · {{duration}} · 击杀 {{kills}} · 船体 {{hp}}',
  },
  settings: {
    title: '设置',
    volume: '音量',
    language: '语言',
  },
  language: {
    // auto 档的自称随语言翻(Auto);简体中文 / English 两个 self 名不翻
    auto: '自动',
    autoSystem: '自动:跟随系统语言',
    loadFailed: '语言资源加载失败,已保留当前语言',
  },
  pause: {
    title: '已暂停',
    resume: '继续',
    restart: '再来一局',
    retry: '再试一局',
    saveAndQuit: '保存并退出',
  },
} as const;
