import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScene } from '../src/core/scene';
import type { RectangleElement, TextElement } from '../src/elements/element';
import { History } from '../src/engine/history';
import { reducer } from '../src/engine/reducer';
import { TextTool } from '../src/tools/text_tool';

vi.mock('../src/i18n', () => ({ t: (key: string) => key }));

const style = {
  strokeColor: '#000',
  fillColor: 'transparent',
  strokeWidth: 1,
  opacity: 1,
  roughness: 0,
} as const;

function rect(id: string, x = 0): RectangleElement {
  return { ...style, id, type: 'rectangle', x, y: 0, width: 10, height: 10 };
}

afterEach(() => vi.unstubAllGlobals());

describe('undo steps', () => {
  it('records no step for a command that changes nothing, and keeps redo', () => {
    const history = new History({ ...createScene(), elements: [rect('a')] });
    history.dispatch({ type: 'MOVE_ELEMENT', id: 'a', dx: 5, dy: 0 });
    history.undo();
    expect(history.canRedo()).toBe(true);
    // Same size again: a new scene object, but nothing to undo.
    history.dispatch({ type: 'RESIZE_ELEMENT', id: 'a', width: 10 });
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(true);
    history.redo();
    expect(history.present.elements[0]!.x).toBe(5);
  });

  it('records no step for a drag that changes nothing', () => {
    const history = new History({ ...createScene(), elements: [rect('a')] });
    history.dispatch({ type: 'MOVE_ELEMENT', id: 'a', dx: 5, dy: 0 });
    history.undo();
    history.beginDrag();
    history.dispatch({ type: 'RESIZE_ELEMENT', id: 'a', height: 10 });
    history.endDrag();
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(true);
  });

  it('still records a type-only change, which the diff leaves out', () => {
    const history = new History({ ...createScene(), elements: [rect('a')] });
    history.dispatch({
      type: 'UPDATE_ELEMENT',
      id: 'a',
      props: { type: 'ellipse' },
    });
    expect(history.present.elements[0]!.type).toBe('ellipse');
    expect(history.canUndo()).toBe(true);
  });

  it('still records a text default change, and undoes it', () => {
    const history = new History(createScene());
    history.dispatch({ type: 'SET_FONT_SIZE', size: 48 });
    expect(history.present.appState.fontSize).toBe(48);
    history.undo();
    expect(history.present.appState.fontSize).toBe(20);
  });
});

describe('undo keeps the choices made after the step', () => {
  it('keeps the shape kind and the inherited style', () => {
    const history = new History(createScene());
    history.dispatch({ type: 'CREATE_ELEMENT', element: rect('a') });
    history.dispatch({
      type: 'SET_TOOL',
      tool: 'shape',
      shapeKind: 'database',
    });
    history.undo();
    expect(history.present.elements).toHaveLength(0);
    expect(history.present.appState.activeTool).toBe('shape');
    expect(history.present.appState.shapeKind).toBe('database');
  });

  it('keeps the opacity a tool switch took from the selection', () => {
    const faded = { ...rect('a'), opacity: 0.4 };
    const history = new History({
      ...createScene(),
      elements: [faded],
      selectedIds: new Set(['a']),
    });
    history.dispatch({ type: 'MOVE_ELEMENT', id: 'a', dx: 5, dy: 0 });
    history.dispatch({ type: 'SET_TOOL', tool: 'rectangle' });
    expect(history.present.appState.opacity).toBe(0.4);
    history.undo();
    expect(history.present.appState.opacity).toBe(0.4);
  });
});

describe('bring to front', () => {
  it('keeps the moved elements in their stacking order', () => {
    const scene = {
      ...createScene(),
      elements: [rect('a'), rect('b'), rect('c')],
    };
    // Selected C first, then A.
    const out = reducer(scene, {
      type: 'REORDER_ELEMENTS',
      ids: ['c', 'a'],
      targetIndex: 3,
    });
    expect(out.elements.map((el) => el.id)).toEqual(['b', 'a', 'c']);
  });
});

/** Minimal DOM surface for the text editor. */
class TestNode extends EventTarget {
  style: Record<string, string> = {};
  value = '';
  offsetWidth = 100;
  offsetHeight = 24;
  scrollHeight = 24;
  spellcheck = false;
  textContent = '';
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 800, height: 600 };
  }
  setAttribute() {}
  appendChild() {}
  focus() {}
  select() {}
  remove() {}
}

/** Opens the editor on `el`, sets its value and size, and blurs it. */
function editAndBlur(
  el: TextElement,
  value: string,
  size: { width: number; height: number },
) {
  vi.useFakeTimers();
  const nodes: TestNode[] = [];
  vi.stubGlobal(
    'document',
    Object.assign(new TestNode(), {
      body: new TestNode(),
      documentElement: { getAttribute: () => 'dark' },
      createElement: () => {
        const node = new TestNode();
        nodes.push(node);
        return node;
      },
    }),
  );
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      devicePixelRatio: 1,
      matchMedia: () => ({ matches: false }),
    }),
  );
  vi.stubGlobal('requestAnimationFrame', vi.fn());
  const history = new History({ ...createScene(), elements: [el] });
  const ctx = {
    history,
    canvas: new TestNode() as unknown as HTMLCanvasElement,
    onPreviewUpdate: () => {},
  };
  new TextTool().editExisting(el, ctx);
  const editor = nodes[0]!;
  editor.value = value;
  editor.offsetWidth = size.width;
  editor.offsetHeight = size.height;
  editor.dispatchEvent(new Event('blur'));
  vi.useRealTimers();
  return history;
}

describe('editing a text', () => {
  const text: TextElement = {
    ...style,
    id: 't',
    type: 'text',
    x: 0,
    y: 0,
    width: 100,
    height: 24,
    content: 'Before',
    fontSize: 20,
    fontFamily: 'sans-serif',
  };

  it('undoes the new text and its new box in one step', () => {
    const history = editAndBlur(text, 'A much longer text', {
      width: 240,
      height: 48,
    });
    expect(history.present.elements[0]).toMatchObject({
      content: 'A much longer text',
      width: 240,
      height: 48,
    });
    history.undo();
    expect(history.present.elements[0]).toMatchObject({
      content: 'Before',
      width: 100,
      height: 24,
    });
    expect(history.canUndo()).toBe(false);
  });

  it('keeps the indentation of code', () => {
    const code = { ...text, isCode: true, content: '  indented\n' };
    const history = editAndBlur(code, '  indented\n    more\n', {
      width: 100,
      height: 24,
    });
    expect(history.present.elements[0]).toMatchObject({
      content: '  indented\n    more\n',
    });
  });

  it('still trims plain text', () => {
    const history = editAndBlur(text, '  spaced  ', { width: 100, height: 24 });
    expect(history.present.elements[0]).toMatchObject({ content: 'spaced' });
  });
});

describe('undo controls', () => {
  it('hear about a step once its drag or text transaction ends', () => {
    const history = new History({ ...createScene(), elements: [rect('a')] });
    const seen: boolean[] = [];
    history.subscribe(() => seen.push(history.canUndo()));
    history.beginDrag();
    history.dispatch({ type: 'MOVE_ELEMENT', id: 'a', dx: 5, dy: 0 });
    history.endDrag();
    expect(seen.at(-1)).toBe(true);
  });

  it('hear about the redo stack a no-op drag gives back', () => {
    const history = new History({ ...createScene(), elements: [rect('a')] });
    history.dispatch({ type: 'MOVE_ELEMENT', id: 'a', dx: 5, dy: 0 });
    history.undo();
    const seen: boolean[] = [];
    history.subscribe(() => seen.push(history.canRedo()));
    history.beginDrag();
    history.endDrag();
    expect(seen.at(-1)).toBe(true);
  });
});

describe('a text commit inside an open transaction', () => {
  it('folds into it and leaves it open for its owner', () => {
    const text: TextElement = {
      ...style,
      id: 't',
      type: 'text',
      x: 0,
      y: 0,
      width: 100,
      height: 24,
      content: 'Before',
      fontSize: 20,
      fontFamily: 'sans-serif',
    };
    vi.useFakeTimers();
    const nodes: TestNode[] = [];
    vi.stubGlobal(
      'document',
      Object.assign(new TestNode(), {
        body: new TestNode(),
        documentElement: { getAttribute: () => 'dark' },
        createElement: () => {
          const node = new TestNode();
          nodes.push(node);
          return node;
        },
      }),
    );
    vi.stubGlobal(
      'window',
      Object.assign(new EventTarget(), {
        devicePixelRatio: 1,
        matchMedia: () => ({ matches: false }),
      }),
    );
    vi.stubGlobal('requestAnimationFrame', vi.fn());
    const history = new History({ ...createScene(), elements: [text] });
    const ctx = {
      history,
      canvas: new TestNode() as unknown as HTMLCanvasElement,
      onPreviewUpdate: () => {},
    };
    new TextTool().editExisting(text, ctx);
    // A slider pressed while editing opens its transaction before the blur.
    history.beginDrag();
    const editor = nodes[0]!;
    editor.value = 'After';
    editor.offsetWidth = 200;
    editor.dispatchEvent(new Event('blur'));
    vi.useRealTimers();
    expect(history.isDragging).toBe(true);
    history.dispatch({ type: 'APPLY_STYLE', ids: ['t'], opacity: 0.5 });
    history.dispatch({ type: 'APPLY_STYLE', ids: ['t'], opacity: 0.3 });
    history.endDrag();
    history.undo();
    expect(history.present.elements[0]).toMatchObject({
      content: 'Before',
      opacity: 1,
    });
    expect(history.canUndo()).toBe(false);
  });
});
