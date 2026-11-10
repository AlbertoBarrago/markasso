import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScene } from '../src/core/scene';
import type { RectangleElement, TextElement } from '../src/elements/element';
import { History } from '../src/engine/history';
import { initCanvasView } from '../src/ui/canvas_view';

vi.mock('../src/i18n', () => ({ t: (key: string) => key }));

/** Minimal DOM surface for the real canvas handlers and text editor. */
class TestNode extends EventTarget {
  style: Record<string, string> = {};
  value = '';
  offsetWidth = 100;
  offsetHeight = 24;
  clientWidth = 800;
  clientHeight = 600;
  getBoundingClientRect() {
    return { left: 0, top: 0 };
  }
  getContext() {
    return {};
  }
  setAttribute() {}
  appendChild() {}
  focus() {}
  select() {}
  remove() {}
}

function mouse(target: EventTarget, type: string, x: number, y: number) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, {
    button: 0,
    clientX: x,
    clientY: y,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
  });
  target.dispatchEvent(event);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('canvas text commit before another tool press', () => {
  it.each([
    'release',
    'cancel',
  ] as const)('keeps edited text when a subsequent move ends with %s', (ending) => {
    vi.useFakeTimers();
    const nodes: TestNode[] = [];
    const document = Object.assign(new TestNode(), {
      body: new TestNode(),
      documentElement: { getAttribute: () => 'dark' },
      createElement: () => {
        const node = new TestNode();
        nodes.push(node);
        return node;
      },
    });
    const window = Object.assign(new EventTarget(), {
      devicePixelRatio: 1,
      matchMedia: () => ({ matches: false }),
    });
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', window);
    vi.stubGlobal('requestAnimationFrame', vi.fn());
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
      },
    );
    const canvas = new TestNode();
    const base = {
      x: 0,
      y: 0,
      width: 100,
      height: 24,
      strokeColor: '#fff',
      fillColor: 'transparent',
      strokeWidth: 1,
      opacity: 1,
      roughness: 0,
    };
    const text: TextElement = {
      ...base,
      id: 'text',
      type: 'text',
      content: 'Before',
      fontSize: 20,
      fontFamily: 'sans-serif',
    };
    const rect: RectangleElement = {
      ...base,
      id: 'rect',
      type: 'rectangle',
      x: 300,
      height: 100,
      fillColor: '#123456',
    };
    const history = new History({
      ...createScene(),
      elements: [text, rect],
    });
    const { selectTool } = initCanvasView(
      canvas as unknown as HTMLCanvasElement,
      history,
    );
    mouse(canvas, 'dblclick', 50, 12);
    const editor = nodes.at(-2)!; // Textarea followed by its measuring span.
    expect(editor.value).toBe('Before');
    editor.value = 'After';
    editor.dispatchEvent(new Event('input'));
    vi.runOnlyPendingTimers();
    expect(history.present.appState.activeTool).toBe('select');

    mouse(canvas, 'mousedown', 350, 50);
    // Browser blur follows mousedown; synchronous commit must detach it.
    editor.dispatchEvent(new Event('blur'));
    mouse(canvas, 'mousemove', 380, 80);
    expect(history.present.elements[1]?.x).toBe(330);
    if (ending === 'release') {
      mouse(window, 'mouseup', 380, 80);
      history.undo();
    } else {
      selectTool.onCancel({
        history,
        canvas: canvas as unknown as HTMLCanvasElement,
      });
    }
    expect(history.present.elements[1]).toEqual(rect);
    expect(history.present.elements[0]).toMatchObject({ content: 'After' });
    expect(history.present.appState.activeTool).toBe('select');
    history.undo();
    expect(history.present.elements[0]).toMatchObject({ content: 'Before' });
  });
});
