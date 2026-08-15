import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEdictLevels } from '../data/edicts';
import { TOWER_AUTOCANNON, TOWER_LASER } from '../data/towers';
import { createWeaponSlots, type WeaponSlot } from '../sim/armory';
import { createEdictBuffs } from '../sim/edictBuffs';
import type { World } from '../sim/world';
import { initI18n } from '../i18n';
import { createArmoryPanel } from './armoryPanel';

interface StubEl {
  tagName: string;
  src: string;
  alt: string;
  style: Record<string, string>;
  textContent: string;
  innerHTML: string;
  disabled: boolean;
  children: StubEl[];
  handlers: Map<string, Array<() => void>>;
  append(...children: StubEl[]): void;
  appendChild(child: StubEl): StubEl;
  addEventListener(type: string, handler: () => void): void;
}

function createStubEl(tagName = 'div'): StubEl {
  const element: StubEl = {
    tagName: tagName.toUpperCase(),
    src: '',
    alt: '',
    style: {},
    textContent: '',
    innerHTML: '',
    disabled: false,
    children: [],
    handlers: new Map(),
    append(...children): void { element.children.push(...children); },
    appendChild(child): StubEl { element.children.push(child); return child; },
    addEventListener(type, handler): void {
      const handlers = element.handlers.get(type) ?? [];
      handlers.push(handler);
      element.handlers.set(type, handlers);
    },
  };
  return element;
}

function fire(element: StubEl, type: string): void {
  for (const handler of element.handlers.get(type) ?? []) handler();
}

function installDom(): { ui: StubEl; restore(): void } {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previousWindow = globals.window;
  const previousDocument = globals.document;
  const ui = createStubEl();
  globals.window = { addEventListener(): void {} };
  globals.document = {
    createElement: (tagName: string): StubEl => createStubEl(tagName),
    getElementById: (id: string): StubEl | null => id === 'ui' ? ui : null,
  };
  return {
    ui,
    restore(): void {
      globals.window = previousWindow;
      globals.document = previousDocument;
    },
  };
}

function createWorld(): World {
  const weapons = createWeaponSlots();
  weapons[0]!.type = TOWER_AUTOCANNON;
  weapons[0]!.stars = 1;
  weapons[2]!.type = TOWER_LASER;
  weapons[2]!.stars = 2;
  const world = {
    weapons,
    ship: { hp: 80, maxHp: 100 },
    buffs: createEdictBuffs(),
    edictLevels: createEdictLevels(),
    swapWeapons(a: number, b: number): number {
      const first: WeaponSlot = weapons[a]!;
      weapons[a] = weapons[b]!;
      weapons[b] = first;
      return 0;
    },
  };
  return world as unknown as World;
}

describe('舰船背包面板', () => {
  let dom: ReturnType<typeof installDom>;

  beforeEach(async () => {
    await initI18n('zh-CN');
    dom = installDom();
  });
  afterEach(() => dom.restore());

  it('与商店共用完整舰船图，点两个真实朝向槽交换武器', () => {
    const world = createWorld();
    let opened = 0;
    const panel = createArmoryPanel({
      canOpen: () => true,
      onOpen: () => { opened++; },
      onClose: () => {},
    });
    panel.setWorld(world);
    panel.show();

    const root = dom.ui.children[0]!;
    const diagram = root.children[0]!;
    const head = diagram.children[0]!;
    const ring = diagram.children[2]!;
    const chipLayer = ring.children[ring.children.length - 1]!;
    const hullArt = ring.children[ring.children.length - 2]!;
    const chips = chipLayer.children;

    expect(opened).toBe(1);
    expect(((head.children[0] as StubEl).children[1] as StubEl).textContent).toBe('舰船背包');
    expect(hullArt.tagName).toBe('IMG');
    expect(hullArt.src).toContain('scrapper-hull.png');
    expect(chips[0]!.innerHTML).toContain('正前');
    expect(chips[2]!.innerHTML).toContain('正右');

    fire(chips[0]!, 'click');
    expect(panel.selected()).toBe(0);
    expect(chips[0]!.style.border).toContain('#ffd479');
    fire(chips[2]!, 'click');
    expect(panel.selected()).toBe(-1);
    expect(world.weapons[0]!.type).toBe(TOWER_LASER);
    expect(world.weapons[2]!.type).toBe(TOWER_AUTOCANNON);
  });
});
