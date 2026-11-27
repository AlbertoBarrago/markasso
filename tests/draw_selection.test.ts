import { describe, expect, it } from 'vitest';
import { createViewport } from '../src/core/viewport';
import type {
  ArrowElement,
  LineElement,
  RectangleElement,
  RhombusElement,
  ShapeElement,
} from '../src/elements/element';
import type { Handle } from '../src/rendering/draw_selection';
import {
  anchorToWorld,
  distToShapeBoundary,
  findConnectorSnapTarget,
  findNearestElementSnapTarget,
  getConnectorEnds,
  getElementBorderPoint,
  getElementBounds,
  getElementCenter,
  getElementPorts,
  getNearestElementBorderPoint,
  getRotationHandleScreen,
  getSelectionHandles,
  hitTestEndpoint,
  hitTestHandle,
  resolveArrowEndpoints,
  resolveConnectorRoute,
  spreadAlongSide,
  worldToAnchor,
} from '../src/rendering/draw_selection';

function makeRect(
  id: string,
  x: number,
  y: number,
  w = 100,
  h = 60,
): RectangleElement {
  return {
    id,
    type: 'rectangle',
    x,
    y,
    width: w,
    height: h,
    strokeColor: '#000',
    fillColor: 'transparent',
    strokeWidth: 2,
    opacity: 1,
    roughness: 0,
  };
}

function makeArrow(overrides: Partial<ArrowElement> = {}): ArrowElement {
  return {
    id: 'a1',
    type: 'arrow',
    x: 0,
    y: 0,
    x2: 200,
    y2: 200,
    strokeColor: '#000',
    fillColor: 'transparent',
    strokeWidth: 2,
    opacity: 1,
    roughness: 0,
    ...overrides,
  };
}

function makeLine(overrides: Partial<LineElement> = {}): LineElement {
  return {
    id: 'l1',
    type: 'line',
    x: 0,
    y: 0,
    x2: 100,
    y2: 0,
    strokeColor: '#000',
    fillColor: 'transparent',
    strokeWidth: 2,
    opacity: 1,
    roughness: 0,
    ...overrides,
  };
}

describe('resolveArrowEndpoints', () => {
  it('returns stored positions when no connections', () => {
    const arrow = makeArrow({ x: 10, y: 20, x2: 110, y2: 120 });
    const result = resolveArrowEndpoints(arrow, []);
    expect(result).toEqual({ x: 10, y: 20, x2: 110, y2: 120 });
  });

  it('resolves startElementId to element border facing the other endpoint', () => {
    // rect at (0,0) 100×60 → center (50, 30); other end at (200, 200)
    // direction from center toward (200,200): dx=150, dy=170
    // t = min(50/150, 30/170) = 30/170 → hits bottom edge
    // border: x = 50 + 150*(30/170) ≈ 76.47, y = 60
    const rect = makeRect('r1', 0, 0, 100, 60);
    const arrow = makeArrow({ x: 999, y: 999, startElementId: 'r1' });
    const result = resolveArrowEndpoints(arrow, [rect]);
    expect(result.x).toBeCloseTo(1300 / 17, 5); // ≈ 76.47
    expect(result.y).toBe(60); // bottom edge
    expect(result.x2).toBe(200); // end unchanged
  });

  it('resolves endElementId to element border facing the other endpoint', () => {
    // rect at (100,200) 80×40 → center (140, 220); other end at (0, 0)
    // direction from center toward (0,0): dx=-140, dy=-220
    // t = min(40/140, 20/220) = 20/220 → hits top edge
    // border: x2 ≈ 127.27, y2 = 200 (top edge)
    const rect = makeRect('r2', 100, 200, 80, 40);
    const arrow = makeArrow({ x2: 999, y2: 999, endElementId: 'r2' });
    const result = resolveArrowEndpoints(arrow, [rect]);
    expect(result.x2).toBeCloseTo(1400 / 11, 5); // ≈ 127.27
    expect(result.y2).toBe(200); // top edge
    expect(result.x).toBe(0); // start unchanged
  });

  it('resolves both endpoints to their respective borders facing each other', () => {
    // r1 at (0,0) 100×60 → center (50, 30)
    // r2 at (300,400) 60×40 → center (330, 420)
    // r1 border toward r2: t = min(50/280, 30/390) = 1/13 → x ≈ 71.54, y = 60
    // r2 border toward r1: t = min(30/280, 20/390) = 2/39 → x2 ≈ 315.64, y2 = 400
    const r1 = makeRect('r1', 0, 0, 100, 60);
    const r2 = makeRect('r2', 300, 400, 60, 40);
    const arrow = makeArrow({
      x: 999,
      y: 999,
      x2: 999,
      y2: 999,
      startElementId: 'r1',
      endElementId: 'r2',
    });
    const result = resolveArrowEndpoints(arrow, [r1, r2]);
    expect(result.x).toBeCloseTo(930 / 13, 5); // ≈ 71.54 (r1 bottom-right)
    expect(result.y).toBe(60); // r1 bottom edge
    expect(result.x2).toBeCloseTo(12310 / 39, 5); // ≈ 315.64 (r2 top-left)
    expect(result.y2).toBe(400); // r2 top edge
  });

  it('preserves stored border anchors when connected endpoints were snapped by cursor', () => {
    const r1 = makeRect('r1', 0, 0, 100, 60);
    const r2 = makeRect('r2', 300, 400, 60, 40);
    const arrow = makeArrow({
      x: 0,
      y: 12,
      x2: 330,
      y2: 400,
      startElementId: 'r1',
      endElementId: 'r2',
    });
    const result = resolveArrowEndpoints(arrow, [r1, r2]);
    expect(result.x).toBe(0);
    expect(result.y).toBe(12);
    expect(result.x2).toBe(330);
    expect(result.y2).toBe(400);
  });

  it('falls back to stored position if connected element not found', () => {
    const arrow = makeArrow({ x: 5, y: 6, startElementId: 'missing' });
    const result = resolveArrowEndpoints(arrow, []);
    expect(result.x).toBe(5);
    expect(result.y).toBe(6);
  });
});

describe('getElementBounds with arrow connections', () => {
  it('returns bounds from stored positions when no allElements provided', () => {
    const arrow = makeArrow({ x: 10, y: 20, x2: 110, y2: 80 });
    const b = getElementBounds(arrow);
    expect(b).toEqual({ x: 10, y: 20, w: 100, h: 60 });
  });

  it('uses resolved border endpoints when allElements provided', () => {
    // r1 at (0,0) 100×60 → center (50,30); r2 at (200,300) 100×60 → center (250,330)
    // r1 border toward r2: dx=200, dy=300, t=min(50/200,30/300)=1/10 → (70, 60)
    // r2 border toward r1: dx=-200, dy=-300, t=1/10 → (230, 300)
    // bounds: x=70, y=60, w=160, h=240
    const r1 = makeRect('r1', 0, 0, 100, 60);
    const r2 = makeRect('r2', 200, 300, 100, 60);
    const arrow = makeArrow({
      x: 999,
      y: 999,
      x2: 999,
      y2: 999,
      startElementId: 'r1',
      endElementId: 'r2',
    });
    const b = getElementBounds(arrow, [r1, r2, arrow]);
    expect(b.x).toBe(70);
    expect(b.y).toBe(60);
    expect(b.w).toBe(160);
    expect(b.h).toBe(240);
  });

  it('uses quadratic bounds for bent lines', () => {
    const line = makeLine({ cx: 50, cy: 100 });
    const b = getElementBounds(line);
    expect(b.x).toBe(0);
    expect(b.y).toBe(0);
    expect(b.w).toBe(100);
    expect(b.h).toBe(50);
  });
});

// ── getSelectionHandles ───────────────────────────────────────────────────────

describe('getSelectionHandles', () => {
  const vp = createViewport(); // zoom=1, offset=(0,0)

  it('returns empty array for no elements', () => {
    expect(getSelectionHandles([], vp)).toEqual([]);
  });

  it('returns 8 handles for a single rect', () => {
    const rect = makeRect('r1', 100, 100, 200, 100);
    const handles = getSelectionHandles([rect], vp);
    expect(handles).toHaveLength(8);
  });

  it('handles cover all 8 positions', () => {
    const rect = makeRect('r1', 0, 0, 100, 60);
    const positions = getSelectionHandles([rect], vp).map((h) => h.position);
    expect(positions).toEqual(
      expect.arrayContaining(['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se']),
    );
  });

  it('nw handle is at top-left corner in screen space', () => {
    const rect = makeRect('r1', 50, 30, 100, 60);
    const handles = getSelectionHandles([rect], vp);
    const nw = handles.find((h) => h.position === 'nw')!;
    expect(nw.screenX).toBe(50);
    expect(nw.screenY).toBe(30);
  });

  it('se handle is at bottom-right corner in screen space', () => {
    const rect = makeRect('r1', 50, 30, 100, 60);
    const handles = getSelectionHandles([rect], vp);
    const se = handles.find((h) => h.position === 'se')!;
    expect(se.screenX).toBe(150);
    expect(se.screenY).toBe(90);
  });

  it('multi-element selection returns handles covering union bounds', () => {
    const r1 = makeRect('r1', 0, 0, 50, 50);
    const r2 = makeRect('r2', 100, 100, 50, 50);
    const handles = getSelectionHandles([r1, r2], vp);
    const nw = handles.find((h) => h.position === 'nw')!;
    const se = handles.find((h) => h.position === 'se')!;
    expect(nw.screenX).toBe(0);
    expect(nw.screenY).toBe(0);
    expect(se.screenX).toBe(150);
    expect(se.screenY).toBe(150);
  });

  it('respects viewport zoom', () => {
    const rect = makeRect('r1', 0, 0, 100, 60);
    const zoomed = { offsetX: 0, offsetY: 0, zoom: 2 };
    const handles = getSelectionHandles([rect], zoomed);
    const se = handles.find((h) => h.position === 'se')!;
    expect(se.screenX).toBe(200);
    expect(se.screenY).toBe(120);
  });

  it('rotated single element has handles different from unrotated', () => {
    const base = makeRect('r1', 0, 0, 100, 100);
    const rotated: RectangleElement = { ...base, rotation: Math.PI / 4 };
    const baseHandles = getSelectionHandles([base], vp);
    const rotHandles = getSelectionHandles([rotated], vp);
    const baseNW = baseHandles.find((h) => h.position === 'nw')!;
    const rotNW = rotHandles.find((h) => h.position === 'nw')!;
    // After rotation the nw handle should move
    expect(rotNW.screenX).not.toBeCloseTo(baseNW.screenX, 0);
  });
});

// ── hitTestHandle ─────────────────────────────────────────────────────────────

describe('hitTestHandle', () => {
  const handles: Handle[] = [
    { position: 'nw', screenX: 0, screenY: 0 },
    { position: 'se', screenX: 100, screenY: 100 },
  ];

  it('returns the position of a directly hit handle', () => {
    expect(hitTestHandle(handles, 0, 0)).toBe('nw');
    expect(hitTestHandle(handles, 100, 100)).toBe('se');
  });

  it('returns null when no handle is hit', () => {
    expect(hitTestHandle(handles, 50, 50)).toBeNull();
  });

  it('returns handle when within default tolerance', () => {
    expect(hitTestHandle(handles, 7, 7)).toBe('nw');
  });

  it('returns null just outside default tolerance', () => {
    expect(hitTestHandle(handles, 13, 13)).toBeNull();
  });

  it('respects custom tolerance', () => {
    expect(hitTestHandle(handles, 20, 0, 16)).toBe('nw');
    expect(hitTestHandle(handles, 21, 0, 16)).toBeNull();
  });

  it('returns null for empty handle array', () => {
    expect(hitTestHandle([], 0, 0)).toBeNull();
  });
});

// ── hitTestEndpoint ───────────────────────────────────────────────────────────

describe('hitTestEndpoint', () => {
  const vp = createViewport();

  it('returns null for non-line/arrow elements', () => {
    const rect = makeRect('r1', 0, 0, 100, 60);
    expect(hitTestEndpoint(rect, vp, 0, 0)).toBeNull();
  });

  it('returns "start" when clicking near the start endpoint', () => {
    const line = makeLine({ x: 50, y: 50, x2: 200, y2: 200 });
    expect(hitTestEndpoint(line, vp, 50, 50)).toBe('start');
  });

  it('returns "end" when clicking near the end endpoint', () => {
    const line = makeLine({ x: 50, y: 50, x2: 200, y2: 200 });
    expect(hitTestEndpoint(line, vp, 200, 200)).toBe('end');
  });

  it('returns null when clicking in the middle', () => {
    const line = makeLine({ x: 0, y: 0, x2: 100, y2: 0 });
    expect(hitTestEndpoint(line, vp, 50, 0)).toBeNull();
  });
});

// ── getElementCenter ──────────────────────────────────────────────────────────

describe('getElementCenter', () => {
  it('returns center of a rectangle', () => {
    const rect = makeRect('r1', 0, 0, 100, 60);
    expect(getElementCenter(rect)).toEqual([50, 30]);
  });

  it('returns center with non-zero origin', () => {
    const rect = makeRect('r1', 20, 10, 80, 40);
    expect(getElementCenter(rect)).toEqual([60, 30]);
  });
});

// ── getRotationHandleScreen ───────────────────────────────────────────────────

describe('getRotationHandleScreen', () => {
  const vp = createViewport();

  it('returns null for empty selection', () => {
    expect(getRotationHandleScreen([], vp)).toBeNull();
  });

  it('returns handle above the bounding box center', () => {
    const rect = makeRect('r1', 0, 0, 100, 60);
    const h = getRotationHandleScreen([rect], vp)!;
    expect(h).not.toBeNull();
    expect(h.screenX).toBeCloseTo(50, 1);
    expect(h.screenY).toBeLessThan(0);
  });

  it('returns null-safe value for multi-element (no rotation)', () => {
    const r1 = makeRect('r1', 0, 0, 50, 50);
    const r2 = makeRect('r2', 100, 0, 50, 50);
    const h = getRotationHandleScreen([r1, r2], vp)!;
    expect(h).not.toBeNull();
    expect(h.screenX).toBeCloseTo(75, 1);
  });
});

// ── getElementBorderPoint ─────────────────────────────────────────────────────

describe('getElementBorderPoint', () => {
  it('returns right-border point for rect when target is to the right', () => {
    const rect = makeRect('r1', 0, 0, 100, 60);
    const [x, y] = getElementBorderPoint(rect, 200, 30);
    expect(x).toBe(100);
    expect(y).toBeCloseTo(30, 1);
  });

  it('returns top-border point for rect when target is above', () => {
    const rect = makeRect('r1', 0, 0, 100, 60);
    const [x, y] = getElementBorderPoint(rect, 50, -100);
    expect(y).toBe(0);
    expect(x).toBeCloseTo(50, 1);
  });

  it('falls back to top-center when target is exactly at center', () => {
    const rect = makeRect('r1', 0, 0, 100, 60);
    const [, y] = getElementBorderPoint(rect, 50, 30);
    expect(y).toBe(0);
  });

  it('works for ellipse elements', () => {
    const ellipse = {
      id: 'e1',
      type: 'ellipse' as const,
      x: 0,
      y: 0,
      width: 100,
      height: 60,
      strokeColor: '#000',
      fillColor: 'transparent',
      strokeWidth: 2,
      opacity: 1,
      roughness: 0,
    };
    const [bx, by] = getElementBorderPoint(ellipse, 100, 30);
    expect(bx).toBeGreaterThan(50);
    expect(by).toBeCloseTo(30, 0);
  });
});

describe('getNearestElementBorderPoint', () => {
  it('returns the nearest rect edge point under the cursor', () => {
    const rect = makeRect('r1', 0, 0, 100, 60);
    const [x, y] = getNearestElementBorderPoint(rect, -5, 12);
    expect(x).toBe(0);
    expect(y).toBe(12);
  });

  it('uses the nearest rect edge when cursor is inside the shape', () => {
    const rect = makeRect('r1', 0, 0, 100, 60);
    const [x, y] = getNearestElementBorderPoint(rect, 8, 20);
    expect(x).toBe(0);
    expect(y).toBe(20);
  });

  it('projects ellipse snap to the visual boundary', () => {
    const ellipse = {
      id: 'e1',
      type: 'ellipse' as const,
      x: 0,
      y: 0,
      width: 100,
      height: 60,
      strokeColor: '#000',
      fillColor: 'transparent',
      strokeWidth: 2,
      opacity: 1,
      roughness: 0,
    };
    const [x, y] = getNearestElementBorderPoint(ellipse, 100, 30);
    expect(x).toBeCloseTo(100, 1);
    expect(y).toBeCloseTo(30, 1);
  });
});

describe('findNearestElementSnapTarget', () => {
  it('returns the closest border snap target within radius', () => {
    const r1 = makeRect('r1', 0, 0, 100, 60);
    const r2 = makeRect('r2', 200, 0, 100, 60);
    const snap = findNearestElementSnapTarget([r1, r2], 104, 12, 20);
    expect(snap).toMatchObject({ elementId: 'r1', worldX: 100, worldY: 12 });
  });

  it('returns null when no border is within radius', () => {
    const rect = makeRect('r1', 0, 0, 100, 60);
    expect(findNearestElementSnapTarget([rect], 150, 30, 20)).toBeNull();
  });
});

// ── distToShapeBoundary ───────────────────────────────────────────────────────

describe('distToShapeBoundary', () => {
  const b = { x: 0, y: 0, w: 100, h: 60 };

  it('returns 0 for point on rect edge', () => {
    const rect = makeRect('r1', 0, 0, 100, 60);
    expect(distToShapeBoundary(rect, b, 0, 30)).toBeCloseTo(0, 1);
    expect(distToShapeBoundary(rect, b, 50, 0)).toBeCloseTo(0, 1);
  });

  it('returns small value for point inside rect (near edge)', () => {
    const rect = makeRect('r1', 0, 0, 100, 60);
    expect(distToShapeBoundary(rect, b, 1, 30)).toBeCloseTo(1, 1);
  });

  it('returns positive value for ellipse at center', () => {
    const ellipse = {
      id: 'e1',
      type: 'ellipse' as const,
      x: 0,
      y: 0,
      width: 100,
      height: 60,
      strokeColor: '#000',
      fillColor: 'transparent',
      strokeWidth: 2,
      opacity: 1,
      roughness: 0,
    };
    const dist = distToShapeBoundary(ellipse, b, 50, 30);
    expect(dist).toBeGreaterThan(0);
  });
});

function makeShape(overrides: Partial<ShapeElement> = {}): ShapeElement {
  return {
    id: 's1',
    type: 'shape',
    kind: 'terminator',
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    strokeColor: '#000',
    fillColor: 'transparent',
    strokeWidth: 2,
    opacity: 1,
    roughness: 0,
    ...overrides,
  };
}

describe('flowchart shape snapping', () => {
  it('uses the shape outline for the border point', () => {
    const data = makeShape({ kind: 'data', x: 100, y: 100 });
    const [x, y] = getElementBorderPoint(data, 1000, 150);
    expect(x).toBeCloseTo(280);
    expect(y).toBeCloseTo(150);
  });

  it('normalizes negative width/height boxes', () => {
    const flipped = makeShape({ x: 200, y: 100, width: -200, height: -100 });
    expect(getElementBounds(flipped)).toEqual({ x: 0, y: 0, w: 200, h: 100 });
    const [x, y] = getElementBorderPoint(flipped, 1000, 50);
    expect(x).toBeCloseTo(200);
    expect(y).toBeCloseTo(50);
  });

  it('accounts for rotation', () => {
    const rotated = makeShape({ rotation: Math.PI / 2 });
    // World "down" is local "right": the cap tip, rotated back below center.
    const [x, y] = getElementBorderPoint(rotated, 100, 500);
    expect(x).toBeCloseTo(100);
    expect(y).toBeCloseTo(150);
  });

  it('snaps the nearest border point onto the outline', () => {
    const db = makeShape({ kind: 'database' });
    const [x, y] = getNearestElementBorderPoint(db, 100, -10);
    expect(x).toBeCloseTo(100);
    expect(y).toBeCloseTo(0);
    expect(distToShapeBoundary(db, getElementBounds(db), 100, -10)).toBeCloseTo(
      10,
    );
  });

  it('is a snap target for connectors', () => {
    const shape = makeShape();
    const target = findNearestElementSnapTarget([shape], 205, 50, 10);
    expect(target?.elementId).toBe('s1');
    expect(target?.worldX).toBeCloseTo(200);
  });

  it('resolves bound connector endpoints on the outline', () => {
    const shape = makeShape({ kind: 'preparation' });
    const arrow = makeArrow({
      x: 500,
      y: 50,
      x2: 500,
      y2: 50,
      startElementId: 's1',
    });
    const pts = resolveArrowEndpoints(arrow, [shape, arrow]);
    expect(pts.x).toBeCloseTo(200);
    expect(pts.y).toBeCloseTo(50);
  });
});

describe('connector anchors', () => {
  it('exposes four cardinal ports on the outline', () => {
    const ports = getElementPorts(makeRect('r1', 0, 0, 100, 60));
    const expected = [
      [50, 0],
      [100, 30],
      [50, 60],
      [0, 30],
    ];
    ports.forEach((p, i) => {
      expect(p.worldX).toBeCloseTo(expected[i]![0]!);
      expect(p.worldY).toBeCloseTo(expected[i]![1]!);
    });
    expect(ports[1]!.anchor.x).toBeCloseTo(1);
    expect(ports[1]!.anchor.y).toBeCloseTo(0.5);
  });

  it('has no ports on connectors', () => {
    expect(getElementPorts(makeLine())).toEqual([]);
  });

  it('rotates ports with the element', () => {
    const rotated: RectangleElement = {
      ...makeRect('r1', 0, 0, 100, 60),
      rotation: Math.PI / 2,
    };
    const [north] = getElementPorts(rotated);
    // Local north of a 90deg-rotated box points to world east.
    expect(north!.worldX).toBeCloseTo(80);
    expect(north!.worldY).toBeCloseTo(30);
    expect(north!.anchor.x).toBeCloseTo(0.5);
    expect(north!.anchor.y).toBeCloseTo(0);
  });

  it('round-trips world points through anchors', () => {
    const rect = makeRect('r1', 10, 20, 100, 60);
    const anchor = worldToAnchor(rect, 110, 35);
    expect(anchor).toEqual({ x: 1, y: 0.25 });
    expect(anchorToWorld(rect, anchor)).toEqual([110, 35]);
  });

  it('prefers a port over the plain border inside the port radius', () => {
    const rect = makeRect('r1', 0, 0, 100, 60);
    const port = findConnectorSnapTarget([rect], 103, 28, 20, 10);
    expect(port).toMatchObject({ worldX: 100, worldY: 30 });
    expect(port?.anchor).toEqual({ x: 1, y: 0.5 });

    const border = findConnectorSnapTarget([rect], 103, 10, 20, 10);
    expect(border).toMatchObject({ worldX: 100, worldY: 10 });
    expect(border?.anchor).toBeUndefined();
  });

  it('keeps a pinned end on its port after the element moves', () => {
    const moved = makeRect('r1', 300, 300, 100, 60);
    const other = makeRect('r2', 0, 0, 100, 60);
    const line = makeLine({
      x: 50,
      y: 0,
      x2: 500,
      y2: 500,
      startElementId: 'r1',
      startAnchor: { x: 0.5, y: 0 },
      endElementId: 'r2',
    });
    const pts = resolveArrowEndpoints(line, [moved, other, line]);
    expect([pts.x, pts.y]).toEqual([350, 300]);
    // The floating end faces the pinned point, not the other center.
    const [ex, ey] = getElementBorderPoint(other, 350, 300);
    expect(pts.x2).toBeCloseTo(ex);
    expect(pts.y2).toBeCloseTo(ey);
  });

  it('keeps a pinned end on the outline after a resize', () => {
    const data = makeShape({ kind: 'data', width: 400, height: 100 });
    const line = makeLine({
      startElementId: 's1',
      startAnchor: { x: 0.9, y: 0.5 },
    });
    const pts = resolveArrowEndpoints(line, [data, line]);
    // skew = 50: (360, 50) projects onto the slanted side (400,0)→(350,100)
    expect(pts.x).toBeCloseTo(372);
    expect(pts.y).toBeCloseTo(56);
    expect(
      distToShapeBoundary(data, getElementBounds(data), pts.x, pts.y),
    ).toBeCloseTo(0);
  });
});

describe('resolveConnectorRoute', () => {
  const r1 = makeRect('r1', 0, 0, 100, 60);
  const r2 = makeRect('r2', 300, 200, 100, 60);

  const elbow = (extra: Partial<Parameters<typeof makeLine>[0]> = {}) =>
    makeLine({
      x: 50,
      y: 30,
      x2: 60,
      y2: 230,
      routing: 'elbow',
      startElementId: 'top',
      endElementId: 'bottom',
      ...extra,
    });

  it('runs straight between nearly aligned shapes instead of stepping', () => {
    const top = makeRect('top', 0, 0, 160, 70);
    const bottom = makeRect('bottom', 10, 200, 160, 70);
    const line = elbow();
    const route = resolveConnectorRoute(line, [top, bottom, line]);
    // The start's center (x = 80) lies on the bottom shape's top side.
    expect(route).toEqual([
      [80, 70],
      [80, 200],
    ]);
  });

  it('meets in the overlap when neither center fits the other side', () => {
    const top = makeRect('top', 0, 0, 100, 70);
    const bottom = makeRect('bottom', 80, 200, 100, 70);
    const line = elbow();
    const route = resolveConnectorRoute(line, [top, bottom, line]);
    expect(route).toEqual([
      [90, 70],
      [90, 200],
    ]);
  });

  it('keeps the stepped route when the sides do not overlap', () => {
    const top = makeRect('top', 0, 0, 100, 70);
    const bottom = makeRect('bottom', 140, 300, 100, 70);
    const line = elbow();
    const route = resolveConnectorRoute(line, [top, bottom, line]);
    expect(route.length).toBe(4);
    expect(route[0]).toEqual([50, 70]);
  });

  it('leaves pinned ends where they are', () => {
    const top = makeRect('top', 0, 0, 160, 70);
    const bottom = makeRect('bottom', 10, 200, 160, 70);
    const line = elbow({ startAnchor: { x: 0.5, y: 1 } });
    const route = resolveConnectorRoute(line, [top, bottom, line]);
    expect(route[0]).toEqual([80, 70]);
    expect(route[route.length - 1]).toEqual([90, 200]);
  });

  it('returns the two ends for straight connectors', () => {
    const line = makeLine({ x: 0, y: 0, x2: 50, y2: 50 });
    expect(resolveConnectorRoute(line, [line])).toEqual([
      [0, 0],
      [50, 50],
    ]);
  });

  it('attaches floating elbow ends to the facing mid-side ports', () => {
    const line = makeLine({
      x: 50,
      y: 30,
      x2: 350,
      y2: 230,
      routing: 'elbow',
      startElementId: 'r1',
      endElementId: 'r2',
    });
    const route = resolveConnectorRoute(line, [r1, r2, line]);
    expect(route.length).toBe(4);
    const rounded = route.map(([x, y]) => [Math.round(x), Math.round(y)]);
    // The horizontal gap (200) beats the vertical one (140): leave right,
    // enter left, turn in the corridor between the shapes.
    expect(rounded).toEqual([
      [100, 30],
      [200, 30],
      [200, 230],
      [300, 230],
    ]);
    expect(getElementBounds(line, [r1, r2, line])).toMatchObject({
      x: 100,
      w: 200,
    });
  });

  it('routes a wide shape sideways instead of across its neighbor below', () => {
    // Orders above Payments, Postgres to the right (the MCP e2e layout).
    const orders = makeRect('orders', 492, 2, 160, 70);
    const payments = makeRect('payments', 492, 132, 160, 70);
    const db = makeRect('db', 752, 124, 160, 80);
    const line = makeLine({
      routing: 'elbow',
      startElementId: 'orders',
      endElementId: 'db',
    });
    const route = resolveConnectorRoute(line, [orders, payments, db, line]);
    expect(route[0]).toEqual([652, 37]);
    // No point of the route enters the Payments box.
    for (const [x, y] of route) {
      const inside = x > 492 && x < 652 && y > 132 && y < 202;
      expect(inside).toBe(false);
    }
  });

  it('keeps vertical stacks on their top and bottom sides', () => {
    const top = makeRect('top', 0, 0, 160, 60);
    const below = makeRect('below', 20, 200, 160, 60);
    const line = makeLine({
      routing: 'elbow',
      startElementId: 'top',
      endElementId: 'below',
    });
    const route = resolveConnectorRoute(line, [top, below, line]);
    expect(route[0]).toEqual([80, 60]);
    // Enters through the top side, straight below the start (no step).
    expect(route[route.length - 1]).toEqual([80, 200]);
  });

  it('leaves a pinned elbow end by the side of its anchor', () => {
    const line = makeLine({
      x: 100,
      y: 30,
      x2: 350,
      y2: 230,
      routing: 'elbow',
      startElementId: 'r1',
      startAnchor: { x: 1, y: 0.5 },
      endElementId: 'r2',
    });
    const route = resolveConnectorRoute(line, [r1, r2, line]);
    expect(route[0]![0]).toBeCloseTo(100);
    expect(route[0]![1]).toBeCloseTo(30);
    // First leg heads right, out of the anchored side.
    expect(route[1]![0]).toBeGreaterThan(100);
    expect(route[1]![1]).toBeCloseTo(30);
  });
});

describe('spreadAlongSide', () => {
  it('keeps points that are already far enough apart', () => {
    expect(spreadAlongSide([10, 100], 0, 200)).toEqual([10, 100]);
    expect(spreadAlongSide([42], 0, 200)).toEqual([42]);
  });

  it('separates coincident points around their mean', () => {
    expect(spreadAlongSide([100, 100], 0, 200)).toEqual([90, 110]);
    expect(spreadAlongSide([100, 100, 100], 0, 200)).toEqual([80, 100, 120]);
  });

  it('merges a cluster with a neighbor it pushes into', () => {
    expect(spreadAlongSide([100, 100, 118], 0, 200)).toEqual([86, 106, 126]);
  });

  it('keeps a cluster inside the side, clear of its ends', () => {
    expect(spreadAlongSide([5, 5], 0, 200)).toEqual([8, 28]);
    expect(spreadAlongSide([199, 199], 0, 200)).toEqual([172, 192]);
  });

  it('shrinks the gap when the side is too short', () => {
    expect(spreadAlongSide([20, 20, 20], 0, 40)).toEqual([8, 20, 32]);
  });

  it('still separates ends on a very short side', () => {
    expect(spreadAlongSide([6, 6], 0, 12)).toEqual([3, 9]);
  });
});

describe('elbow port spreading', () => {
  const hub = makeRect('hub', 0, 0, 200, 60);
  const below = makeRect('below', 0, 200, 200, 60);
  const further = makeRect('further', 60, 400, 100, 60);
  const link = (id: string, to: string, extra: Partial<LineElement> = {}) =>
    makeLine({
      id,
      x: 100,
      y: 30,
      x2: 100,
      y2: 230,
      routing: 'elbow',
      startElementId: 'hub',
      endElementId: to,
      ...extra,
    });

  it('spreads parallel connectors on both shared sides, keeping them straight', () => {
    const l1 = link('l1', 'below');
    const l2 = link('l2', 'below');
    const all = [hub, below, l1, l2];
    expect(resolveConnectorRoute(l1, all)).toEqual([
      [90, 60],
      [90, 200],
    ]);
    expect(resolveConnectorRoute(l2, all)).toEqual([
      [110, 60],
      [110, 200],
    ]);
  });

  it('does not depend on the order of the elements', () => {
    const l1 = link('l1', 'below');
    const l2 = link('l2', 'below');
    const forward = [hub, below, l1, l2];
    const backward = [l2, l1, below, hub];
    expect(resolveConnectorRoute(l1, backward)).toEqual(
      resolveConnectorRoute(l1, forward),
    );
    expect(resolveConnectorRoute(l2, backward)).toEqual(
      resolveConnectorRoute(l2, forward),
    );
  });

  it('moves the other end along when it alone was spread, so it stays straight', () => {
    const near = link('near', 'below');
    const far = link('far', 'further');
    const all = [hub, below, further, near, far];
    // Both leave the hub's bottom center and point at x = 100: the tie goes
    // by id, so "far" takes 90 and "near" 110. Each target top has a single
    // end, which follows its start.
    expect(resolveConnectorRoute(far, all)).toEqual([
      [90, 60],
      [90, 400],
    ]);
    expect(resolveConnectorRoute(near, all)).toEqual([
      [110, 60],
      [110, 200],
    ]);
  });

  it('leaves pinned ends and lone ends where they are', () => {
    const free = link('free', 'below');
    const pinned = link('pinned', 'below', {
      startAnchor: { x: 0.5, y: 1 },
      endAnchor: { x: 0.5, y: 0 },
    });
    const all = [hub, below, free, pinned];
    expect(resolveConnectorRoute(free, all)).toEqual([
      [100, 60],
      [100, 200],
    ]);
  });

  it('leaves ends that are already apart where they are', () => {
    const small = makeRect('small', 20, 200, 40, 60);
    const straight = link('straight', 'small');
    const loose = makeLine({
      id: 'loose',
      x: 100,
      y: 30,
      x2: 0,
      y2: 300,
      routing: 'elbow',
      startElementId: 'hub',
    });
    const all = [hub, small, straight, loose];
    // The straight link sits at x = 40, the loose one at the middle port.
    expect(resolveConnectorRoute(straight, all)).toEqual([
      [40, 60],
      [40, 200],
    ]);
    expect(resolveConnectorRoute(loose, all)[0]).toEqual([100, 60]);
  });

  it('orders coincident ends by angle so their connectors do not cross', () => {
    const free = (id: string, x2: number, y2: number) =>
      makeLine({
        id,
        x: 100,
        y: 30,
        x2,
        y2,
        routing: 'elbow',
        startElementId: 'hub',
      });
    // "early" turns right sooner: it takes the outer (right) slot.
    const early = free('a-early', 140, 140);
    const late = free('b-late', 160, 220);
    const all = [hub, early, late];
    expect(resolveConnectorRoute(late, all)[0]).toEqual([90, 60]);
    expect(resolveConnectorRoute(early, all)[0]).toEqual([110, 60]);
  });

  it('keeps parallel connectors straight when both their sides are spread', () => {
    const api = makeRect('api', 0, 0, 240, 80);
    const store = makeRect('store', 0, 260, 240, 80);
    const log = makeRect('log', 360, 260, 180, 80);
    const edge = (id: string, to: string) =>
      makeLine({
        id,
        x: 120,
        y: 40,
        x2: 120,
        y2: 300,
        routing: 'elbow',
        startElementId: 'api',
        endElementId: to,
      });
    const read = edge('read', 'store');
    const write = edge('write', 'store');
    const audit = edge('audit', 'log');
    const all = [api, store, log, read, write, audit];
    // Three ends leave the api's bottom (100, 120, 140; audit turns right,
    // so it takes the right slot); the store's two ends line up with them.
    expect(resolveConnectorRoute(read, all)).toEqual([
      [100, 80],
      [100, 260],
    ]);
    expect(resolveConnectorRoute(write, all)).toEqual([
      [120, 80],
      [120, 260],
    ]);
    expect(resolveConnectorRoute(audit, all)[0]).toEqual([140, 80]);
  });

  it('puts the endpoint handles where the spread route starts and ends', () => {
    const l1 = link('l1', 'below');
    const l2 = link('l2', 'below');
    expect(getConnectorEnds(l2, [hub, below, l1, l2])).toEqual({
      x: 110,
      y: 60,
      x2: 110,
      y2: 200,
    });
  });

  it('skips hidden connectors', () => {
    const shown = link('shown', 'below');
    const hidden = link('hidden', 'below', { visible: false });
    expect(resolveConnectorRoute(shown, [hub, below, shown, hidden])).toEqual([
      [100, 60],
      [100, 200],
    ]);
  });
});

describe('elbow port spreading on flowchart symbols', () => {
  const link = (
    id: string,
    from: string,
    to: string,
    extra: Partial<LineElement> = {},
  ) =>
    makeLine({
      id,
      x: 0,
      y: 0,
      x2: 0,
      y2: 0,
      routing: 'elbow',
      startElementId: from,
      endElementId: to,
      ...extra,
    });

  it('spreads a request and its response on a terminator, keeping them straight', () => {
    // The demo case: an agent and the server below it, connected both ways.
    const agent = makeShape({ id: 'agent', kind: 'terminator', x: 0, y: 0 });
    const server = makeRect('server', 0, 300, 200, 80);
    const request = link('request', 'agent', 'server');
    const response = link('response', 'server', 'agent');
    const all = [agent, server, request, response];
    const a = resolveConnectorRoute(request, all);
    const b = resolveConnectorRoute(response, all);
    // Two separate, straight vertical connectors on the terminator's flat
    // bottom (between its round ends, x in [50, 150]).
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
    expect(a[0]![0]).not.toBe(b[b.length - 1]![0]);
    for (const [x, y] of [a[0]!, b[b.length - 1]!]) {
      expect(y).toBeCloseTo(100);
      expect(x).toBeGreaterThan(50);
      expect(x).toBeLessThan(150);
    }
  });

  it('places spread ends on a slanted side, on the slant', () => {
    // A data parallelogram: its left side runs from (40, 0) down to (0, 100).
    const data = makeShape({ id: 'data', kind: 'data', x: 400, y: 0 });
    const left = makeRect('left', 0, 0, 100, 100);
    const l1 = link('l1', 'left', 'data');
    const l2 = link('l2', 'left', 'data');
    const all = [data, left, l1, l2];
    const ends = [l1, l2].map((l) => {
      const route = resolveConnectorRoute(l, all);
      return route[route.length - 1]!;
    });
    expect(ends[0]![1]).not.toBeCloseTo(ends[1]![1]);
    for (const [x, y] of ends) {
      // On the slant: x = 400 + 40 * (1 - y / 100).
      expect(x).toBeCloseTo(400 + 40 * (1 - y / 100), 3);
    }
  });

  it('spreads on the walls and the middle of the rims of a cylinder', () => {
    const db = makeShape({ id: 'db', kind: 'database', x: 0, y: 300 });
    const app = makeRect('app', 0, 0, 200, 80);
    const read = link('read', 'app', 'db');
    const write = link('write', 'app', 'db');
    const all = [db, app, read, write];
    const tops = [read, write].map((l) => {
      const route = resolveConnectorRoute(l, all);
      return route[route.length - 1]!;
    });
    expect(tops[0]![0]).not.toBeCloseTo(tops[1]![0]);
    for (const [x, y] of tops) {
      // Within the middle half of the top rim, on the ellipse (above the
      // rim's lowest point at y = 300 + 15).
      expect(x).toBeGreaterThanOrEqual(50);
      expect(x).toBeLessThanOrEqual(150);
      expect(y).toBeGreaterThanOrEqual(300);
      expect(y).toBeLessThan(315);
    }
  });

  it('spreads on the middle half of a round end, on the curve', () => {
    // Left to right: the terminator's round right end takes both.
    const hub = makeShape({ id: 'hub', kind: 'terminator', x: 0, y: 0 });
    const right = makeRect('right', 400, 0, 100, 100);
    const r1 = link('r1', 'hub', 'right');
    const r2 = link('r2', 'right', 'hub');
    const all = [hub, right, r1, r2];
    const a = resolveConnectorRoute(r1, all)[0]!;
    const b = resolveConnectorRoute(r2, all).at(-1)!;
    expect(a[1]).not.toBeCloseTo(b[1]);
    for (const [x, y] of [a, b]) {
      expect(y).toBeGreaterThanOrEqual(25);
      expect(y).toBeLessThanOrEqual(75);
      // On the drawn cap: four cubics approximating a circle of radius 50
      // centered at (150, 50), within 0.01 of it. The flattened polygon,
      // used before, sat up to 0.06 inside.
      expect(Math.hypot(x - 150, y - 50)).toBeCloseTo(50, 1);
    }
  });

  it('spreads on the bottom rim of a cylinder, exactly on the curve', () => {
    // 200 x 100 cylinder: bottom rim is a half ellipse, rx 100, ry 15,
    // centered at (100, 85).
    const db = makeShape({ id: 'db', kind: 'database', x: 0, y: 0 });
    const out = makeRect('out', 0, 300, 200, 80);
    const l1 = link('l1', 'db', 'out');
    const l2 = link('l2', 'db', 'out');
    const all = [db, out, l1, l2];
    const starts = [l1, l2].map((l) => resolveConnectorRoute(l, all)[0]!);
    expect(starts[0]![0]).not.toBeCloseTo(starts[1]![0]);
    for (const [x, y] of starts) {
      expect(y).toBeGreaterThan(85);
      expect(((x - 100) / 100) ** 2 + ((y - 85) / 15) ** 2).toBeCloseTo(1, 2);
    }
  });

  it('spreads vertical links on a circular terminator too', () => {
    const circle = makeShape({
      id: 'circle',
      kind: 'terminator',
      width: 100,
      height: 100,
    });
    const below = makeRect('below', 0, 300, 100, 80);
    const l1 = link('l1', 'circle', 'below');
    const l2 = link('l2', 'circle', 'below');
    const all = [circle, below, l1, l2];
    const a = resolveConnectorRoute(l1, all)[0]!;
    const b = resolveConnectorRoute(l2, all)[0]!;
    expect(a[0]).not.toBeCloseTo(b[0]);
    // On the drawn outline (cubics within 0.01 of the circle).
    for (const [x, y] of [a, b])
      expect(Math.hypot(x - 50, y - 50)).toBeCloseTo(50, 1);
  });

  it('gives an end deep in a wave a stub that clears the box', () => {
    // A tall document and a thin box tucked beside its wavy bottom: they
    // align at x = 45, where the wave dips to y ~ 456, and the route must
    // detour. Its first turn has to clear the document's box (y = 500),
    // not run back through the wave.
    const doc = makeShape({
      id: 'doc',
      kind: 'document',
      width: 100,
      height: 500,
    });
    const box = makeRect('box', 41, 486, 8, 80);
    const l = link('l', 'doc', 'box');
    const route = resolveConnectorRoute(l, [doc, box, l]);
    expect(route[0]![0]).toBeCloseTo(45);
    expect(route[0]![1]).toBeLessThan(500);
    expect(route[1]![1]).toBeGreaterThan(500);
  });

  it('keeps decisions on their vertices', () => {
    const decision: RhombusElement = {
      ...makeRect('decision', 0, 0, 200, 100),
      type: 'rhombus',
    };
    const below = makeRect('below', 0, 300, 200, 80);
    const d1 = link('d1', 'decision', 'below');
    const d2 = link('d2', 'decision', 'below');
    const all = [decision, below, d1, d2];
    expect(resolveConnectorRoute(d1, all)[0]).toEqual([100, 100]);
    expect(resolveConnectorRoute(d2, all)[0]).toEqual([100, 100]);
  });

  it('runs straight between a symbol and a box that face each other', () => {
    // Offset, but the terminator's flat bottom overlaps the box's top.
    const start = makeShape({ id: 'start', kind: 'terminator', x: 0, y: 0 });
    const step = makeRect('step', 120, 300, 200, 80);
    const flow = link('flow', 'start', 'step');
    const route = resolveConnectorRoute(flow, [start, step, flow]);
    expect(route).toHaveLength(2);
    expect(route[0]![0]).toBeCloseTo(route[1]![0]);
  });
});

describe('elbow port spreading order', () => {
  it('orders nearly coincident ends the same whatever the element order', () => {
    const hub = makeRect('hub', 0, 400, 200, 100);
    // Three boxes above whose centers differ by less than 0.01: comparing
    // with a tolerance instead of a grid was not transitive.
    const boxes = [99.994, 100, 100.006].map((cx, i) =>
      makeRect(`b${i}`, cx - 20, 0, 40, 60),
    );
    const links = ['z', 'm', 'a'].map((id, i) =>
      makeLine({
        id,
        x: 0,
        y: 0,
        x2: 0,
        y2: 0,
        routing: 'elbow',
        startElementId: `b${i}`,
        endElementId: 'hub',
      }),
    );
    const ends = (all: Parameters<typeof resolveConnectorRoute>[1]) =>
      links.map((l) => resolveConnectorRoute(l, all).at(-1));
    const forward = ends([hub, ...boxes, ...links]);
    expect(ends([...[...links].reverse(), ...boxes, hub])).toEqual(forward);
    expect(ends([links[1]!, hub, links[2]!, ...boxes, links[0]!])).toEqual(
      forward,
    );
  });
});
