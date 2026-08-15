/** ui:具体界面文案(标题菜单 / 设置 / 暂停)。结构以本文件为准,en 照抄结构。 */
export const ui = {
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
  },
  pause: {
    title: '已暂停',
    resume: '继续',
    restart: '再来一局',
    retry: '再试一局',
    saveAndQuit: '保存并退出',
  },
} as const;
