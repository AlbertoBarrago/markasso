import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScene } from '../src/core/scene';
import type {
  ArrowElement,
  Element,
  LineElement,
  RectangleElement,
} from '../src/elements/element';
import { History } from '../src/engine/history';
import { drawSelection } from '../src/rendering/draw_selection';
import { SelectTool } from '../src/tools/select_tool';
import { StickyTool } from '../src/tools/sticky_tool';
import type { ToolContext } from '../src/tools/tool';

/** The fields of a MouseEvent the tools read. */
function me(clientX = 0, clientY = 0, shiftKey = false): MouseEvent {
  return {
    clientX,
    clientY,
    shiftKey,
    altKey: false,
    preventDefault: () => {},
  } as unknown as MouseEvent;
}

/** Default viewport and a zero-origin canvas: screen == world. */
function makeCtx(history: History): ToolContext {
  return {
    history,
    canvas: {
      getBoundingClientRect: () =>
        ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect,
    } as HTMLCanvasElement,
    onPreviewUpdate: () => {},
  };
}

function rect(id: string, x: number, y: number, extra = {}): RectangleElement {
  return {
    id,
    type: 'rectangle',
    x,
    y,
    width: 100,
    height: 60,
    strokeColor: '#000',
    fillColor: 'transparent',
    strokeWidth: 2,
    opacity: 1,
    roughness: 0,
    ...extra,
  };
}

/** An arrow from the right side of `a` (100,0 100x60) to `b` (400,0). */
function boundArrow(extra: Partial<ArrowElement> = {}): ArrowElement {
  return {
    id: 'arrow',
    type: 'arrow',
    x: 200,
    y: 30,
    x2: 400,
    y2: 30,
    startElementId: 'a',
    endElementId: 'b',
    strokeColor: '#000',
    fillColor: 'transparent',
    strokeWidth: 2,
    opacity: 1,
    roughness: 0,
    ...extra,
  };
}

function setup(elements: Element[], selected: string[]) {
  const history = new History({
    ...createScene(),
    elements,
    selectedIds: new Set(selected),
  });
  return { history, ctx: makeCtx(history), tool: new SelectTool() };
}

const find = (history: History, id: string) =>
  history.present.elements.find((el) => el.id === id) as Element & {
    [key: string]: unknown;
  };

beforeEach(() => {
  vi.stubGlobal('window', {
    devicePixelRatio: 1,
    matchMedia: () => ({ matches: false }),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('SelectTool connector ends', () => {
  const nodes = [rect('a', 100, 0), rect('b', 400, 0)];

  it('keeps an end attached after a click on its handle without a drag', () => {
    const { history, ctx, tool } = setup([...nodes, boundArrow()], ['arrow']);
    tool.onMouseDown(me(400, 30), 400, 30, ctx);
    tool.onMouseUp(me(400, 30), 400, 30, ctx);
    expect(find(history, 'arrow').endElementId).toBe('b');
    expect(history.canUndo()).toBe(false);
  });

  it('keeps it attached through a jitter under the drag threshold', () => {
    const { history, ctx, tool } = setup([...nodes, boundArrow()], ['arrow']);
    tool.onMouseDown(me(400, 30), 400, 30, ctx);
    tool.onMouseMove(me(402, 31), 402, 31, ctx);
    tool.onMouseUp(me(402, 31), 402, 31, ctx);
    expect(find(history, 'arrow').endElementId).toBe('b');
  });

  it('lets a dragged end follow the pointer, and restores it on cancel', () => {
    const { history, ctx, tool } = setup([...nodes, boundArrow()], ['arrow']);
    tool.onMouseDown(me(400, 30), 400, 30, ctx);
    tool.onMouseMove(me(300, 300), 300, 300, ctx);
    // Detached while dragging, so it is drawn at the pointer.
    expect(find(history, 'arrow')).toMatchObject({ x2: 300, y2: 300 });
    expect(find(history, 'arrow').endElementId).toBeUndefined();
    tool.onCancel(ctx);
    expect(find(history, 'arrow')).toMatchObject({
      x2: 400,
      y2: 30,
      endElementId: 'b',
    });
  });

  it('grabs an end where it is drawn, not where it was stored', () => {
    // Stored ends far from the shapes they are attached to.
    const stale = boundArrow({ x: 0, y: 500, x2: 10, y2: 510 });
    const { history, ctx, tool } = setup([...nodes, stale], ['arrow']);
    // The end is drawn on b's left border.
    tool.onMouseDown(me(400, 30), 400, 30, ctx);
    tool.onMouseMove(me(300, 300), 300, 300, ctx);
    tool.onMouseUp(me(300, 300), 300, 300, ctx);
    expect(find(history, 'arrow')).toMatchObject({ x2: 300, y2: 300 });
    expect(find(history, 'arrow').endElementId).toBeUndefined();
    expect(find(history, 'arrow').startElementId).toBe('a');
  });
});

describe('SelectTool locked elements', () => {
  it('leaves locked elements in place on an arrow-key nudge', () => {
    const { history, ctx, tool } = setup(
      [rect('a', 0, 0, { locked: true }), rect('b', 200, 0)],
      ['a', 'b'],
    );
    tool.onKeyDown(
      { key: 'ArrowRight', shiftKey: false, preventDefault() {} } as never,
      ctx,
    );
    expect(find(history, 'a').x).toBe(0);
    expect(find(history, 'b').x).toBe(201);
  });

  it('offers no resize handle on a locked element', () => {
    const { history, ctx, tool } = setup(
      [rect('a', 0, 0, { locked: true })],
      ['a'],
    );
    // The bottom-right handle of an unlocked rectangle.
    tool.onMouseDown(me(100, 60), 100, 60, ctx);
    tool.onMouseMove(me(200, 160), 200, 160, ctx);
    tool.onMouseUp(me(200, 160), 200, 160, ctx);
    expect(find(history, 'a')).toMatchObject({ width: 100, height: 60 });
  });

  it('draws no handle around a locked element', () => {
    const calls: string[] = [];
    const ctx2d = new Proxy(
      {},
      {
        get: (_target, prop) =>
          typeof prop === 'string' && /^[a-z]/.test(prop)
            ? (..._args: unknown[]) => calls.push(prop)
            : undefined,
        set: () => true,
      },
    ) as CanvasRenderingContext2D;
    const viewport = { offsetX: 0, offsetY: 0, zoom: 1 };
    drawSelection(ctx2d, [rect('a', 0, 0)], viewport);
    expect(calls.filter((c) => c === 'fillRect')).toHaveLength(8);
    calls.length = 0;
    drawSelection(ctx2d, [rect('a', 0, 0, { locked: true })], viewport);
    expect(calls.filter((c) => c === 'fillRect')).toHaveLength(0);
    expect(calls.filter((c) => c === 'arc')).toHaveLength(0);
    // The selection outline still shows.
    expect(calls).toContain('strokeRect');
  });
});

describe('SelectTool group resize', () => {
  it('scales the control point of a curved line with the rest', () => {
    const curved: LineElement = {
      id: 'q',
      type: 'line',
      x: 0,
      y: 100,
      x2: 200,
      y2: 100,
      cx: 100,
      cy: 40,
      strokeColor: '#000',
      fillColor: 'transparent',
      strokeWidth: 2,
      opacity: 1,
      roughness: 0,
    };
    const { history, ctx, tool } = setup(
      [rect('a', 0, 0, { width: 200, height: 100 }), curved],
      ['a', 'q'],
    );
    // Bottom-right corner of the union (0,0 200x100), dragged to double it.
    tool.onMouseDown(me(200, 100), 200, 100, ctx);
    tool.onMouseMove(me(400, 200), 400, 200, ctx);
    tool.onMouseUp(me(400, 200), 400, 200, ctx);
    expect(find(history, 'q')).toMatchObject({
      x2: 400,
      y2: 200,
      cx: 200,
      cy: 80,
    });
  });
});

describe('StickyTool', () => {
  it('places nothing on a mouseup that did not start on the canvas', () => {
    const history = new History(createScene());
    const ctx = makeCtx(history);
    const tool = new StickyTool();
    tool.onMouseUp(me(300, 300), 300, 300, ctx);
    expect(history.present.elements).toHaveLength(0);
    tool.onMouseDown(me(300, 300), 300, 300, ctx);
    tool.onMouseUp(me(300, 300), 300, 300, ctx);
    expect(history.present.elements).toHaveLength(1);
    // A second release, with no new press, places nothing more.
    tool.onMouseUp(me(300, 300), 300, 300, ctx);
    expect(history.present.elements).toHaveLength(1);
  });
});

describe('SelectTool resize with an attached elbow connector', () => {
  it('starts from the bounds the handles are drawn at', async () => {
    const { getElementBounds } = await import(
      '../src/rendering/draw_selection'
    );
    // An elbow from a's top port to b: its route leaves a upward, outside
    // the box its two ends alone would give.
    const elbow = boundArrow({
      id: 'w',
      routing: 'elbow',
      startAnchor: { x: 0.5, y: 0 },
      endAnchor: { x: 0.5, y: 0 },
      x: 0,
      y: 0,
      x2: 0,
      y2: 0,
    } as Partial<ArrowElement>);
    const a = rect('a', 100, 100);
    const b = rect('b', 400, 300);
    const { history, ctx, tool } = setup([a, b, elbow], ['a', 'b', 'w']);
    const all = history.present.elements;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const el of all) {
      const box = getElementBounds(el, all);
      maxX = Math.max(maxX, box.x + box.w);
      minY = Math.min(minY, box.y);
      maxY = Math.max(maxY, box.y + box.h);
    }
    const h = maxY - minY;
    // The bottom-right handle, 10 px down.
    tool.onMouseDown(me(maxX, maxY), maxX, maxY, ctx);
    tool.onMouseMove(me(maxX, maxY + 10), maxX, maxY + 10, ctx);
    tool.onMouseUp(me(maxX, maxY + 10), maxX, maxY + 10, ctx);
    expect(find(history, 'a').height).toBeCloseTo((60 * (h + 10)) / h, 9);
  });
});
