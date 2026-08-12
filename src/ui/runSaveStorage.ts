/**
 * 局内存档的 localStorage 适配器 —— 与 ui/progressStorage.ts 同一条边界与同一套兜底:
 * 读写 localStorage 只能发生在**这里**,sim/runSave.ts 一字不碰 DOM/localStorage。
 *
 * 兜底口径与元进度那份**只有一处不同**,而这一处很要紧:
 * - 相同:损坏 / 缺失 / 隐私模式 / 配额耗尽一律静默兜底,绝不把异常扔回游戏流程。
 * - 不同:元进度写失败只是"这次解锁没记上",而局内存档写失败意味着**玩家以为存上了、
 *   其实没存**。于是 saveRun 返回 boolean 而不是 void —— 调用方(暂停菜单)据此
 *   把"已保存"改口成"保存失败",宁可当场说实话,也不给一个空头承诺。
 *
 * 半局存档的体积比元进度大一个量级(几百只实体 × 十几个数,几十到几百 KB),
 * 故只留**一个槽位**、每次覆盖:多存档位会把 5MB 配额吃穿,而"接着上次打"只需要最近这一份。
 * 本文件在 Node 里没有 localStorage,故不可单测,测试只覆盖 sim/runSave.ts 的纯函数。
 */
import {
  parseRunSnapshot,
  serializeRunSnapshot,
  tryRestoreRun,
  type RunSnapshot,
} from '../sim/runSave';
import type { World } from '../sim/world';

/** 存档键。版本号进的是**结构**(RunSnapshot.v)而不是键名,理由见 sim/runSave.ts 文件头 */
export const RUN_SAVE_STORAGE_KEY = 'starwreck.run.v1';

/**
 * 读一份局内存档。缺失 / 损坏 / 版本对不上 / localStorage 不可用一律返回 null =
 * "没有可继续的航行"(标题界面据此把「继续」置灰)。
 */
export function loadRunSnapshot(): RunSnapshot | null {
  try {
    const raw = localStorage.getItem(RUN_SAVE_STORAGE_KEY);
    if (raw === null) return null;
    return parseRunSnapshot(raw);
  } catch {
    return null;
  }
}

/**
 * 写一份局内存档。@returns 真的写进去了没有 —— 配额耗尽 / 隐私模式时是 false。
 * 存档体积大,配额耗尽是真会发生的事(尤其元进度那边还攒着剪影),故失败要说出来。
 */
export function saveRunSnapshot(snap: RunSnapshot): boolean {
  try {
    localStorage.setItem(RUN_SAVE_STORAGE_KEY, serializeRunSnapshot(snap));
    return true;
  } catch {
    return false;
  }
}

/**
 * 删掉局内存档。**局终必须调用**:一局打完了还留着半局存档,玩家下次进来
 * 会看到一个「继续」按钮通向一场已经结束的战斗(读进去当场弹结算)。
 */
export function clearRunSnapshot(): void {
  try {
    localStorage.removeItem(RUN_SAVE_STORAGE_KEY);
  } catch {
    // 静默失败:见文件头兜底口径
  }
}

/**
 * 读档并直接建出世界。null = 没有存档 / 存档不可用 —— 两种情况对调用方是同一件事
 * (都得从头开一局),故不区分:分开的话 main 要为"有档但读不出来"单独写一条分支,
 * 而那条分支能做的事和"没有档"一模一样。
 * 读不出来的档当场删掉:留着它只会让玩家每次进标题都点一次那个必然失败的「继续」。
 */
export function loadRunWorld(): { world: World; snapshot: RunSnapshot } | null {
  const snapshot = loadRunSnapshot();
  if (snapshot === null) return null;
  const world = tryRestoreRun(snapshot);
  if (world === null) {
    clearRunSnapshot();
    return null;
  }
  return { world, snapshot };
}
