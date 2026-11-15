import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeRotation } from '../src/core/geometry';
import { createScene } from '../src/core/scene';
import type {
  Element,
  LineElement,
  RectangleElement,
  TextElement,
} from '../src/elements/element';
import { History } from '../src/engine/history';
import { reducer } from '../src/engine/reducer';
import { getRotationHandleScreen } from '../src/rendering/draw_selection';
import { sceneToSVG } from '../src/rendering/export';
import { SelectTool } from '../src/tools/select_tool';
import type { ToolContext } from '../src/tools/tool';

const style = {
  strokeColor: '#000',
  fillColor: 'transparent',
  strokeWidth: 2,
  opacity: 1,
  roughness: 0,
} as const;

function rect(extra: Partial<RectangleElement> = {}): RectangleElement {
  return {
    ...style,
    id: 'r',
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    ...extra,
  };
}

/** The fields of a MouseEvent the tool reads; screen == world. */
function me(clientX: number, clientY: number, shiftKey = false): MouseEvent {
  return {
    clientX,
    clientY,
    shiftKey,
    altKey: false,
    preventDefault: () => {},
  } as unknown as MouseEvent;
}

function setup(elements: Element[]) {
  const history = new History({
    ...createScene(),
    elements,
    selectedIds: new Set([elements[0]!.id]),
  });
  const ctx: ToolContext = {
    history,
    canvas: {
      getBoundingClientRect: () =>
        ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect,
    } as HTMLCanvasElement,
    onPreviewUpdate: () => {},
  };
  return { history, ctx, tool: new SelectTool() };
}

/** Where a point of the element's unrotated frame is drawn. */
function drawnAt(el: RectangleElement, lx: number, ly: number) {
  const cx = el.x + el.width / 2;
  const cy = el.y + el.height / 2;
  const r = el.rotation ?? 0;
  const dx = lx - cx;
  const dy = ly - cy;
  return [
    cx + dx * Math.cos(r) - dy * Math.sin(r),
    cy + dx * Math.sin(r) + dy * Math.cos(r),
  ] as const;
}

function drag(
  tool: SelectTool,
  ctx: ToolContext,
  from: readonly [number, number],
  to: readonly [number, number],
) {
  tool.onMouseDown(me(from[0], from[1]), from[0], from[1], ctx);
  tool.onMouseMove(me(to[0], to[1]), to[0], to[1], ctx);
  tool.onMouseUp(me(to[0], to[1]), to[0], to[1], ctx);
}

beforeEach(() => {
  vi.stubGlobal('window', {
    devicePixelRatio: 1,
    matchMedia: () => ({ matches: false }),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('resizing a rotated element', () => {
  it('grows along its own axis and keeps the opposite side in place', () => {
    const el = rect({ rotation: Math.PI / 2 });
    const { history, ctx, tool } = setup([el]);
    // The east handle is drawn below the center once turned by 90°.
    const east = drawnAt(el, 100, 25);
    const west = drawnAt(el, 0, 25);
    drag(tool, ctx, east, [east[0], east[1] + 20]);
    const out = history.present.elements[0] as RectangleElement;
    expect(out.width).toBeCloseTo(120, 9);
    expect(out.height).toBeCloseTo(50, 9);
    const [wx, wy] = drawnAt(out, out.x, out.y + out.height / 2);
    expect(wx).toBeCloseTo(west[0], 9);
    expect(wy).toBeCloseTo(west[1], 9);
  });

  it('pins the opposite corner of a corner drag at 45°', () => {
    const el = rect({ rotation: Math.PI / 4 });
    const { history, ctx, tool } = setup([el]);
    const se = drawnAt(el, 100, 50);
    const nw = drawnAt(el, 0, 0);
    // Out along the element's own diagonal, by 30 local px each way.
    const [ux, uy] = [Math.SQRT1_2, Math.SQRT1_2];
    const to = [se[0] + 30 * (ux - uy), se[1] + 30 * (uy + ux)] as const;
    drag(tool, ctx, se, to);
    const out = history.present.elements[0] as RectangleElement;
    expect(out.width).toBeCloseTo(130, 9);
    expect(out.height).toBeCloseTo(80, 9);
    const [wx, wy] = drawnAt(out, out.x, out.y);
    expect(wx).toBeCloseTo(nw[0], 9);
    expect(wy).toBeCloseTo(nw[1], 9);
  });

  it('shows a resize cursor that follows the rotation', () => {
    const el = rect({ rotation: Math.PI / 2 });
    const { ctx, tool } = setup([el]);
    const [ex, ey] = drawnAt(el, 100, 25);
    expect(tool.getCursor(ex, ey, ctx)).toBe('ns-resize');
  });
});

describe('connector rotation', () => {
  const line: LineElement = {
    ...style,
    id: 'l',
    type: 'line',
    x: 0,
    y: 0,
    x2: 200,
    y2: 0,
  };
  const viewport = { offsetX: 0, offsetY: 0, zoom: 1 };

  it('offers no rotation handle on a lone connector', () => {
    expect(getRotationHandleScreen([line], viewport)).toBeNull();
    expect(
      getRotationHandleScreen([{ ...line, id: 'a', type: 'arrow' }], viewport),
    ).toBeNull();
    expect(getRotationHandleScreen([rect()], viewport)).not.toBeNull();
  });
});

describe('reducer limits that match element validation', () => {
  it('keeps a rotation within one turn', () => {
    const scene = { ...createScene(), elements: [rect()] };
    const out = reducer(scene, { type: 'SET_ROTATION', id: 'r', rotation: 7 });
    expect(out.elements[0]!.rotation).toBeCloseTo(7 - 2 * Math.PI, 12);
    expect(normalizeRotation(-Math.PI / 2)).toBe(-Math.PI / 2);
  });

  it('clamps a resized font size', () => {
    const text: TextElement = {
      ...style,
      id: 't',
      type: 'text',
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      content: 'hi',
      fontSize: 20,
      fontFamily: 'sans-serif',
    };
    const scene = { ...createScene(), elements: [text] };
    const small = reducer(scene, {
      type: 'RESIZE_ELEMENT',
      id: 't',
      fontSize: 0.2,
    });
    expect((small.elements[0] as TextElement).fontSize).toBe(1);
    const big = reducer(scene, {
      type: 'RESIZE_ELEMENT',
      id: 't',
      fontSize: 5000,
    });
    expect((big.elements[0] as TextElement).fontSize).toBe(1000);
  });
});

describe('export bounds', () => {
  it('fit a rotated element', () => {
    const svg = sceneToSVG(
      [rect({ width: 400, height: 20, rotation: Math.PI / 2 })],
      { canvasColor: '#fff', withBackground: false },
    )!;
    // 20 x 400 once turned, plus the 24 px margin on each side.
    expect(svg).toMatch(/^<svg [^>]*width="68" height="448"/);
  });
});

describe('SVG export of rotated paths', () => {
  it('turns a polygon as the canvas does', () => {
    const svg = sceneToSVG(
      [
        {
          ...style,
          id: 'p',
          type: 'polygon',
          x: 0,
          y: 0,
          points: [
            [0, 0],
            [400, 0],
            [400, 20],
            [0, 20],
          ],
          closed: true,
          rotation: Math.PI / 2,
        },
      ],
      { canvasColor: '#fff', withBackground: false },
    )!;
    expect(svg).toMatch(/^<svg [^>]*width="68" height="448"/);
    expect(svg).toContain('transform="rotate(90,');
  });
});
