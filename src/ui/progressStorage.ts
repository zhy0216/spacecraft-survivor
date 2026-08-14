/**
 * 元进度存档的 localStorage 适配器(19 号 issue 的"存档模块"的浏览器半边)。
 * 铁律 1 的边界:读写 localStorage 只能发生在**这里**,sim/progress.ts 一字不碰 DOM/localStorage;
 * 本文件是唯一认识那把锁的模块,反过来它也绝不认识 World —— 只搬 `Progress` 这份纯数据。
 *
 * 兜底口径:损坏 / 缺失 / 隐私模式 / 配额耗尽,一律静默兜底成空进度或静默失败,
 * 绝不把异常扔回结算流程 —— 存档是"下一把的新理由",不是这一局的收尾闸门
 * (存不下就丢,不能因为配额把 game over 流程炸掉)。
 * 本文件在 Node 里没有 localStorage,故不可单测,测试只覆盖 sim/progress.ts 的纯函数。
 */
import { createProgress, parseProgress, serializeProgress, type Progress } from '../sim/progress';

/** 存档键。版本号进键名:结构升级时换后缀即清档,旧版本数据不强行兼容 */
export const PROGRESS_STORAGE_KEY = 'starwreck.progress.v1';

/** 读存档。缺失 / 损坏 / localStorage 不可用(隐私模式抛异常)一律返回空进度 */
export function loadProgress(): Progress {
  try {
    const raw = localStorage.getItem(PROGRESS_STORAGE_KEY);
    if (raw === null) return createProgress();
    return parseProgress(raw) ?? createProgress();
  } catch {
    return createProgress();
  }
}

/** 写存档。配额耗尽 / 隐私模式抛异常时静默失败 —— 解锁状态丢了可以再打,不能卡死收尾 */
export function saveProgress(p: Progress): void {
  try {
    localStorage.setItem(PROGRESS_STORAGE_KEY, serializeProgress(p));
  } catch {
    // 静默失败:见文件头兜底口径
  }
}
