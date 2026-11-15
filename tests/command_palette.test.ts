import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScene } from '../src/core/scene';
import type { Element } from '../src/elements/element';
import { History } from '../src/engine/history';
import type { SelectTool } from '../src/tools/select_tool';

vi.mock('../src/i18n', () => ({
  t: (key: string) => key,
  getLocale: () => 'en',
  LOCALES: [],
}));

/** Minimal DOM capture: the palette renders its entries into plain nodes. */
class Node {
  id = '';
  className = '';
  textContent = '';
  innerHTML = '';
  value = '';
  style = { display: '', setProperty: vi.fn() };
  classList = { toggle: vi.fn(), add: vi.fn(), remove: vi.fn() };
  dataset = {};
  children: Node[] = [];
  queries = new Map<string, Node>();
  appendChild(node: Node) {
    this.children.push(node);
    return node;
  }
  append(node: Node) {
    this.appendChild(node);
  }
  getAttribute() {
    return null;
  }
  setAttribute() {}
  addEventListener() {}
  querySelector(selector: string): Node {
    let node = this.queries.get(selector);
    if (!node) {
      node = new Node();
      this.queries.set(selector, node);
    }
    return node;
  }
  querySelectorAll() {
    return [];
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** The entry labels of the palette opened on `history`. */
async function paletteLabels(history: History): Promise<string> {
  const nodes: Node[] = [];
  const root = new Node();
  const keydown = vi.fn();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal('document', {
    body: root,
    documentElement: root,
    createElement: () => {
      const node = new Node();
      nodes.push(node);
      return node;
    },
    addEventListener: vi.fn(),
  });
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: false }),
    addEventListener: (name: string, callback: unknown) => {
      if (name === 'keydown')
        keydown.mockImplementation(callback as () => void);
    },
  });
  vi.stubGlobal('requestAnimationFrame', vi.fn());
  const { initCommandPalette } = await import('../src/ui/command_palette');
  const noop = () => {};
  initCommandPalette(history, {} as SelectTool, noop, noop);
  keydown({ key: 'k', ctrlKey: true, preventDefault: noop });
  const palette = nodes.find((node) => node.id === 'cmd-palette-overlay')!;
  return palette
    .querySelector('#cmd-list')
    .children.map((node) => node.innerHTML)
    .join('');
}

const rect = {
  id: 'r',
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  strokeColor: '#000',
  fillColor: 'transparent',
  strokeWidth: 1,
  opacity: 1,
  roughness: 0,
} as Element;

describe('command palette', () => {
  it('names Select all as the menu does', async () => {
    const labels = await paletteLabels(new History(createScene()));
    expect(labels).toContain('selectAll');
  });

  it('offers saving and exporting only when there is something to save', async () => {
    const empty = await paletteLabels(new History(createScene()));
    for (const key of ['exportPNG', 'exportSVG', 'saveMarkasso', 'clearCanvas'])
      expect(empty).not.toContain(key);
    vi.resetModules();
    const drawn = await paletteLabels(
      new History({ ...createScene(), elements: [rect] }),
    );
    for (const key of ['exportPNG', 'exportSVG', 'saveMarkasso', 'clearCanvas'])
      expect(drawn).toContain(key);
  });
});

describe('image export', () => {
  it('asks about the background, then exports with the answer', async () => {
    const answer = vi.fn();
    vi.doMock('../src/ui/dialog', () => ({ dialog: answer }));
    const { exportImage } = await import('../src/ui/export_actions');
    const scene = { ...createScene(), elements: [rect] };
    const run = vi.fn();

    answer.mockResolvedValueOnce('exportWithBackground');
    await exportImage(() => scene, run);
    expect(run).toHaveBeenLastCalledWith(scene, true);

    answer.mockResolvedValueOnce('exportTransparent');
    await exportImage(() => scene, run);
    expect(run).toHaveBeenLastCalledWith(scene, false);

    answer.mockResolvedValueOnce(null);
    await exportImage(() => scene, run);
    expect(run).toHaveBeenCalledTimes(2);
    vi.doUnmock('../src/ui/dialog');
  });
});
