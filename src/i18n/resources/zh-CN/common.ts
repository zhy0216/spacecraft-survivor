/**
 * common:通用动作、状态、错误、键位名。**key shape 的唯一真相源** ——
 * 英文资源以此递归结构为约束(见 DeepRecord),新增 key 在这里加,en 那边照抄结构即可。
 */
export const common = {
  confirm: '确认',
  cancel: '取消',
  back: '返回',
  retry: '重试',
  close: '关闭',
  yes: '是',
  no: '否',
  on: '开',
  off: '关',
  enabled: '已启用',
  disabled: '已禁用',
  unlocked: '已解锁',
  locked: '未解锁',
  keys: {
    esc: 'Esc',
    enter: 'Enter',
  },
  errors: {
    saveFailed: '保存失败',
    loadFailed: '读取失败',
    uploadFailed: '上传失败',
  },
  // 复数一对:中文两种形式同值,但**两个都要有** —— 英文才拿得到 one/other 两把钥匙。
  enemiesLeft_one: '还剩 {{count}} 只敌舰',
  enemiesLeft_other: '还剩 {{count}} 只敌舰',
} as const;
