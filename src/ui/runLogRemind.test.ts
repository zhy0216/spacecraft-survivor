/**
 * 漏存提醒 popover(ui/runLogRemind.ts)—— 结算卡/胜利终幕共用那一块提示框。
 *
 * 测的是"离开前那道闸"的完整口径:什么时候弹、每条路(保存/仍要离开/取消/永久关闭)
 * 各通向哪、以及原动作何时被执行。桩与 gameOver.test 同一条装桩口径:只给
 * createRunLogRemind 真的会碰的那几样(createElement/getElementById/append + 元素监听器),
 * 不发展成半个 jsdom。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changeLocale, initI18n } from '../i18n';
import type { UploadOutcome } from './gameOver';
import { createRunLogRemind } from './runLogRemind';

interface StubEl {
  tagName: string;
  style: { cssText: string; display: string };
  textContent: string;
  disabled: boolean;
  children: StubEl[];
  listeners: Map<string, (e: unknown) => void>;
  append(...kids: StubEl[]): void;
  appendChild(kid: StubEl): StubEl;
  addEventListener(type: string, fn: (e: unknown) => void): void;
}

function createStubEl(tag = 'div'): StubEl {
  const el: StubEl = {
    tagName: tag.toUpperCase(),
    style: { cssText: '', display: '' },
    textContent: '',
    disabled: false,
    children: [],
    listeners: new Map(),
    append(...kids: StubEl[]): void {
      el.children.push(...kids);
    },
    appendChild(kid: StubEl): StubEl {
      el.children.push(kid);
      return kid;
    },
    addEventListener(type: string, fn: (e: unknown) => void): void {
      el.listeners.set(type, fn);
    },
  };
  return el;
}

/** localStorage 桩(永久关闭偏好靠它记):与 gameOver.test 同一条装桩口径 */
function installLocalStorage(): { store: Map<string, string>; restore: () => void } {
  const g = globalThis as unknown as Record<string, unknown>;
  const prev = g.localStorage;
  const store = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
  return {
    store,
    restore: () => {
      g.localStorage = prev;
    },
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('漏存提醒 popover', () => {
  let uiRoot: StubEl;
  let restore: () => void;

  beforeEach(async () => {
    await initI18n('zh-CN');
    const g = globalThis as unknown as Record<string, unknown>;
    const prevWindow = g.window;
    const prevDocument = g.document;
    uiRoot = createStubEl();
    g.window = { addEventListener() {} };
    g.document = {
      createElement(tag: string): StubEl {
        return createStubEl(tag);
      },
      getElementById(id: string): StubEl | null {
        return id === 'ui' ? uiRoot : null;
      },
      activeElement: null,
    };
    restore = () => {
      g.window = prevWindow;
      g.document = prevDocument;
    };
  });

  afterEach(() => restore());

  /** 遮罩 = #ui 的唯一子节点;框 = 遮罩的唯一子节点 */
  function root(): StubEl {
    return uiRoot.children[0]!;
  }
  function box(): StubEl {
    return root().children[0]!;
  }
  /** 框结构:[msg, note, 保存, 仍要离开, 底栏(取消, 以后不再提醒)] */
  function saveBtn(): StubEl {
    return box().children[2]!;
  }
  function leaveBtn(): StubEl {
    return box().children[3]!;
  }
  function cancelEl(): StubEl {
    return box().children[4]!.children[0]!;
  }
  function dismissEl(): StubEl {
    return box().children[4]!.children[1]!;
  }

  function make(
    over: Partial<{
      uploadLocal: boolean;
      isLogSaved: () => boolean;
      onUpload: () => Promise<UploadOutcome>;
    }> = {},
  ): ReturnType<typeof createRunLogRemind> {
    return createRunLogRemind({
      onUpload: over.onUpload ?? (async () => ({ status: 'done' })),
      uploadLocal: over.uploadLocal,
      isLogSaved: over.isLogSaved ?? (() => false),
    });
  }

  it('默认收着;日志没保存时 request 弹框、原动作不执行', () => {
    const ui = make();
    // 初始 display:none 写在 cssText 里(桩的 style.display 只反映显式赋值)
    expect(root().style.cssText).toContain('display:none');
    let ran = 0;
    ui.request(() => ran++);
    expect(root().style.display).toBe('flex');
    expect(ran).toBe(0);
    expect(box().children[0]!.textContent).toBe('本局日志还没有保存');
    expect(box().children[1]!.textContent).toBe('离开后这一局的记录将无法再保存');
    expect(saveBtn().textContent).toBe('上传本局日志(U)');
    expect(leaveBtn().textContent).toBe('仍要离开');
    expect(cancelEl().textContent).toBe('取消');
    expect(dismissEl().textContent).toBe('以后不再提醒');
  });

  it('已保存(isLogSaved 真)或已永久关闭:request 直接放行原动作,不弹框', () => {
    const saved = make({ isLogSaved: () => true });
    let ran = 0;
    saved.request(() => ran++);
    expect(ran).toBe(1);
    expect(root().style.display).toBe('');

    const ls = installLocalStorage();
    try {
      ls.store.set('starwreck.runLogRemind.v1', 'off');
      const dismissed = make();
      let ran2 = 0;
      dismissed.request(() => ran2++);
      expect(ran2).toBe(1);
      expect(root().style.display).toBe('');
    } finally {
      ls.restore();
    }
  });

  it('保存日志:成功 = 收框并放行原动作;失败 = 框留着、按钮改口失败原因、可重试', async () => {
    const outcomes: UploadOutcome[] = [];
    const ui = make({ onUpload: async () => outcomes.shift() ?? { status: 'done' } });
    let ran = 0;
    // 失败:原动作不执行,按钮改口(与结算卡同一条码表)
    ui.request(() => ran++);
    outcomes.push({ status: 'error', code: 'upload-failed' });
    saveBtn().listeners.get('click')!(undefined);
    expect(saveBtn().textContent).toBe('上传中…');
    expect(saveBtn().disabled).toBe(true);
    await tick();
    expect(saveBtn().textContent).toBe('上传失败');
    expect(saveBtn().disabled).toBe(false);
    expect(root().style.display).toBe('flex');
    expect(ran).toBe(0);
    // 重试成功:框收、原动作执行
    outcomes.push({ status: 'done' });
    saveBtn().listeners.get('click')!(undefined);
    await tick();
    expect(root().style.display).toBe('none');
    expect(ran).toBe(1);
  });

  it('仍要离开:不经过保存直接放行原动作', () => {
    const ui = make();
    let ran = 0;
    ui.request(() => ran++);
    leaveBtn().listeners.get('click')!(undefined);
    expect(ran).toBe(1);
    expect(root().style.display).toBe('none');
  });

  it('取消:收框且不执行原动作;点遮罩 = 取消,点框内不算', () => {
    const ui = make();
    let ran = 0;
    ui.request(() => ran++);
    cancelEl().listeners.get('click')!(undefined);
    expect(ran).toBe(0);
    expect(root().style.display).toBe('none');
    // 点遮罩(e.target === 遮罩本身)同样是取消
    ui.request(() => ran++);
    root().listeners.get('click')!({ target: root() });
    expect(ran).toBe(0);
    expect(root().style.display).toBe('none');
    // 点框内冒泡上来(e.target 是框)不算遮罩点击
    ui.request(() => ran++);
    root().listeners.get('click')!({ target: box() });
    expect(root().style.display).toBe('flex');
    expect(ran).toBe(0);
  });

  it('以后不再提醒:写 localStorage、收框、不执行原动作;此后 request 一律直接放行', () => {
    const ls = installLocalStorage();
    try {
      const ui = make();
      let ran = 0;
      ui.request(() => ran++);
      dismissEl().listeners.get('click')!(undefined);
      expect(ls.store.get('starwreck.runLogRemind.v1')).toBe('off');
      expect(ran).toBe(0);
      expect(root().style.display).toBe('none');
      // 之后:不再弹框,直接放行
      let ran2 = 0;
      ui.request(() => ran2++);
      expect(ran2).toBe(1);
      expect(root().style.display).toBe('none');
    } finally {
      ls.restore();
    }
  });

  it('已弹着时 request 不重入:同一个动作不排队两遍', () => {
    const ui = make();
    let ran = 0;
    ui.request(() => ran++);
    ui.request(() => ran++);
    expect(root().style.display).toBe('flex');
    leaveBtn().listeners.get('click')!(undefined);
    expect(ran).toBe(1); // 只有第一个动作被放行
  });

  it('refreshLocale:英文重画文案与保存按钮三态,不触发任何动作', async () => {
    const ui = make();
    let ran = 0;
    ui.request(() => ran++);
    await changeLocale('en');
    ui.refreshLocale();
    expect(box().children[0]!.textContent).toBe("This run's log hasn't been saved yet");
    expect(box().children[1]!.textContent).toBe(
      "You won't be able to save this run's record after leaving",
    );
    expect(saveBtn().textContent).toBe('Upload Run Log (U)');
    expect(leaveBtn().textContent).toBe('Leave Anyway');
    expect(cancelEl().textContent).toBe('Cancel');
    expect(dismissEl().textContent).toBe("Don't ask again");
    expect(ran).toBe(0);
    expect(root().style.display).toBe('flex');
  });
});
