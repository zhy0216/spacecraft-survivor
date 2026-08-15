/** ui:具体界面文案(标题菜单 / 设置 / 暂停)。结构以本文件为准,en 照抄结构。 */
export const ui = {
  title: {
    // 页面标题的本地化基底:STARWRECK 是产品名,永不翻译;开发模式追加 "· dev"(main.ts)
    base: 'STARWRECK 星骸',
  },
  menu: {
    newRun: '开始航行',
    continueRun: '继续上次航行',
    newRunWithSave: '开始新航行',
    settings: '设置',
    codex: '图鉴',
    abandonSave: '确定?这会放弃存档进度',
    continueLine: '航段 {{segment}} · {{duration}} · 击杀 {{kills}} · 船体 {{hp}}',
    hintContinue: '{{enter}} 继续 · {{esc}} 取消确认',
    hintStart: '{{enter}} 开始',
  },
  settings: {
    title: '设置',
    volume: '主音量',
    sound: '声音',
    shake: '画面震动',
    damageNumbers: '伤害飘字',
    hitstop: '击杀顿帧',
    language: '语言',
    back: '返回({{esc}})',
    reset: '恢复默认',
    instantSaveHint: '设置即时生效并自动保存',
    shakeLevels: {
      off: '关闭',
      low: '轻微',
      standard: '标准',
    },
  },
  language: {
    // auto 档的自称随语言翻(Auto);简体中文 / English 两个 self 名不翻
    auto: '自动',
    autoSystem: '自动:跟随系统语言',
    loadFailed: '语言资源加载失败,已保留当前语言',
  },
  pause: {
    title: '已暂停',
    resume: '继续({{esc}})',
    restart: '再来一局(换种子)',
    retry: '再试一局(同种子)',
    saveAndQuit: '保存并退出到标题',
    saveFailed: '保存失败(存储不可用)',
    settings: '设置',
    soundOn: '声音:开',
    soundOff: '声音:关',
    hint: '战斗中按 {{esc}} 随时暂停',
  },
  keys: {
    wasd: '航向',
    space: '加速',
    layout: '武器布局',
    firingArc: '射界',
    pause: '暂停',
  },
  toast: {
    unlock: '解锁:{{name}}',
    keyHint: '按 I 可调整武器朝向',
    magnet: '磁吸风暴:残骸自动飞向你 2 秒',
  },
  banner: {
    boss: '封锁线接敌',
    bossSupply: '封锁线接敌 · 补给信标已投放',
    segmentCleared: '航段 {{segment}} 肃清 · 补给信标已投放',
  },
  upload: {
    noEndpoint: '未配置上传地址',
    noLog: '本局无日志',
    failed: '上传失败',
  },
} as const;
