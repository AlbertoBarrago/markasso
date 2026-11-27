import { describe, expect, it } from 'vitest';
import { type Element, SHAPE_KINDS } from '../src/elements/element';
import {
  SHAPE_DEFINITIONS,
  shapeCommandsToPathData,
} from '../src/elements/shapes';
import {
  flattenShapeCommands,
  getLabelWrapWidth,
  getShapeBorderPointToward,
  getShapeDistToBoundary,
  getShapeNearestBorderPoint,
  getShapeOutlinePolygon,
  getShapeTextBox,
} from '../src/rendering/shape_geometry';

const W = 200;
const H = 100;
const EPS = 1e-6;

describe('shape definitions', () => {
  for (const kind of SHAPE_KINDS) {
    describe(kind, () => {
      it('has a closed outline that stays inside its box', () => {
        const poly = getShapeOutlinePolygon(kind, W, H);
        expect(poly.length).toBeGreaterThan(3);
        const first = poly[0]!;
        const last = poly[poly.length - 1]!;
        expect(last[0]).toBeCloseTo(first[0]);
        expect(last[1]).toBeCloseTo(first[1]);
        for (const [x, y] of poly) {
          expect(x).toBeGreaterThanOrEqual(-EPS);
          expect(x).toBeLessThanOrEqual(W + EPS);
          expect(y).toBeGreaterThanOrEqual(-EPS);
          expect(y).toBeLessThanOrEqual(H + EPS);
        }
      });

      it('has a non-empty text box inside its box', () => {
        const box = getShapeTextBox(kind, W, H);
        expect(box.w).toBeGreaterThan(0);
        expect(box.h).toBeGreaterThan(0);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.w).toBeLessThanOrEqual(W + EPS);
        expect(box.y + box.h).toBeLessThanOrEqual(H + EPS);
      });

      it('touches all four sides of its box', () => {
        const poly = getShapeOutlinePolygon(kind, W, H);
        const xs = poly.map((p) => p[0]);
        const ys = poly.map((p) => p[1]);
        expect(Math.min(...xs)).toBeCloseTo(0);
        expect(Math.max(...xs)).toBeCloseTo(W);
        expect(Math.min(...ys)).toBeCloseTo(0);
        // The document's wavy bottom never quite reaches the box edge.
        expect(Math.max(...ys)).toBeGreaterThan(H * 0.9);
      });

      it('does not produce NaN for a degenerate 0x0 box', () => {
        const poly = getShapeOutlinePolygon(kind, 0, 0);
        for (const [x, y] of poly) {
          expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
        }
      });
    });
  }
});

describe('flattenShapeCommands', () => {
  it('closes subpaths by repeating the first point', () => {
    const [poly] = flattenShapeCommands([
      ['M', 0, 0],
      ['L', 10, 0],
      ['L', 10, 10],
      ['Z'],
    ]);
    expect(poly).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 0],
    ]);
  });

  it('splits open subpaths at each move', () => {
    const paths = flattenShapeCommands(
      SHAPE_DEFINITIONS.predefinedProcess.details!(W, H),
    );
    expect(paths).toHaveLength(2);
  });

  it('samples cubic segments ending exactly on their end point', () => {
    const [poly] = flattenShapeCommands([
      ['M', 0, 0],
      ['C', 0, 10, 10, 10, 10, 0],
    ]);
    expect(poly!.length).toBeGreaterThan(2);
    expect(poly![poly!.length - 1]).toEqual([10, 0]);
  });
});

describe('getShapeBorderPointToward', () => {
  it('hits the cap tip of a terminator', () => {
    const [x, y] = getShapeBorderPointToward('terminator', W, H, 1, 0);
    expect(x).toBeCloseTo(W);
    expect(y).toBeCloseTo(H / 2);
  });

  it('hits the top edge straight up', () => {
    const [x, y] = getShapeBorderPointToward('terminator', W, H, 0, -1);
    expect(x).toBeCloseTo(W / 2);
    expect(y).toBeCloseTo(0);
  });

  it('hits the slanted side of a data parallelogram', () => {
    // skew = min(0.2w, 0.5h) = 40, right edge goes (200,0) → (160,100)
    const [x, y] = getShapeBorderPointToward('data', W, H, 1, 0);
    expect(x).toBeCloseTo(180);
    expect(y).toBeCloseTo(H / 2);
  });

  it('follows the wavy bottom of a document', () => {
    const [x, y] = getShapeBorderPointToward('document', W, H, 0, 1);
    expect(x).toBeCloseTo(W / 2);
    expect(y).toBeCloseTo(H * 0.9);
  });

  it('falls back to top-center for a zero direction', () => {
    expect(getShapeBorderPointToward('delay', W, H, 0, 0)).toEqual([W / 2, 0]);
  });
});

describe('getShapeNearestBorderPoint / getShapeDistToBoundary', () => {
  it('projects an outside point onto the closest edge', () => {
    const [x, y] = getShapeNearestBorderPoint('delay', W, H, W + 10, H / 2);
    expect(x).toBeCloseTo(W);
    expect(y).toBeCloseTo(H / 2);
  });

  it('measures the distance from the center of a stadium', () => {
    expect(
      getShapeDistToBoundary('terminator', W, H, W / 2, H / 2),
    ).toBeCloseTo(H / 2);
  });

  it('is zero on the outline', () => {
    expect(getShapeDistToBoundary('preparation', W, H, W, H / 2)).toBeCloseTo(
      0,
    );
  });
});

describe('shapeCommandsToPathData', () => {
  it('serializes and offsets every command', () => {
    expect(
      shapeCommandsToPathData(
        [['M', 0, 0], ['L', 1.234, 2], ['C', 1, 2, 3, 4, 5, 6], ['Z']],
        10,
        20,
      ),
    ).toBe('M 10 20 L 11.23 22 C 11 22 13 24 15 26 Z');
  });
});

describe('getLabelWrapWidth', () => {
  const base = {
    id: 'el',
    x: 0,
    y: 0,
    width: W,
    height: H,
    strokeColor: '#000',
    fillColor: 'transparent',
    strokeWidth: 1,
    opacity: 1,
    roughness: 0,
  } as const;

  it('keeps the widths the renderer used before it was shared', () => {
    expect(getLabelWrapWidth({ ...base, type: 'rectangle' }, W, H)).toBe(
      W - 16,
    );
    expect(getLabelWrapWidth({ ...base, type: 'ellipse' }, W, H)).toBe(
      W * 0.7 - 16,
    );
    expect(getLabelWrapWidth({ ...base, type: 'rhombus' }, W, H)).toBe(
      W * 0.7 - 16,
    );
    for (const kind of SHAPE_KINDS) {
      expect(getLabelWrapWidth({ ...base, type: 'shape', kind }, W, H)).toBe(
        getShapeTextBox(kind, W, H).w - 16,
      );
    }
  });

  it('never goes below the label font size', () => {
    const tiny: Element = {
      ...base,
      type: 'rectangle',
      width: 10,
      labelFontSize: 24,
    };
    expect(getLabelWrapWidth(tiny, 10, H)).toBe(24);
  });
});

/** Points where the segment p..q crosses the ray from c along (dx, dy). */
function rayCrossings(
  polygon: ReadonlyArray<readonly [number, number]>,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): number {
  let count = 0;
  for (let i = 0; i + 1 < polygon.length; i++) {
    const [px, py] = polygon[i]!;
    const [qx, qy] = polygon[i + 1]!;
    const ex = qx - px;
    const ey = qy - py;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((px - cx) * ey - (py - cy) * ex) / den;
    const u = ((px - cx) * dy - (py - cy) * dx) / den;
    // Half-open on u so a ray through a vertex counts it once.
    if (t > 1e-9 && u >= 0 && u < 1) count++;
  }
  return count;
}

describe('every flowchart symbol', () => {
  for (const kind of SHAPE_KINDS) {
    it(`${kind} is star-shaped around its center`, () => {
      // Border snapping casts rays from the center and takes the first
      // crossing: every ray must cross the outline exactly once, at any
      // proportions. Densely sampled, since pockets can be narrow.
      for (const [w, h] of [
        [200, 100],
        [100, 200],
        [300, 60],
        [80, 80],
      ] as const) {
        const polygon = getShapeOutlinePolygon(kind, w, h);
        for (let i = 0; i < 720; i++) {
          const angle = (i / 720) * Math.PI * 2 + 0.001;
          const crossings = rayCrossings(
            polygon,
            w / 2,
            h / 2,
            Math.cos(angle),
            Math.sin(angle),
          );
          if (crossings !== 1)
            throw new Error(`${kind} ${w}x${h}: ${crossings} at ${angle}`);
        }
      }
    });

    it(`${kind} declares side stretches inside its box`, () => {
      const sides = SHAPE_DEFINITIONS[kind].sides(W, H);
      for (const [side, span] of Object.entries(sides)) {
        if (!span) continue;
        const length = side === 'top' || side === 'bottom' ? W : H;
        expect(span[0]).toBeGreaterThanOrEqual(-EPS);
        expect(span[1]).toBeLessThanOrEqual(length + EPS);
        expect(span[1]).toBeGreaterThan(span[0]);
      }
    });
  }
});

describe('ISO symbols added in 1.29', () => {
  it('meet the border where their shape says', () => {
    // Stored data: the concave right side is deepest at mid height.
    const s = Math.min(W * 0.12, H * 0.35);
    const [rx, ry] = getShapeBorderPointToward('storedData', W, H, 1, 0);
    expect(rx).toBeCloseTo(W - s, 1);
    expect(ry).toBeCloseTo(H / 2, 1);
    // Off-page connector and merge end in a point at the bottom center.
    for (const kind of ['offPageConnector', 'merge'] as const) {
      const [bx, by] = getShapeBorderPointToward(kind, W, H, 0, 1);
      expect(bx).toBeCloseTo(W / 2);
      expect(by).toBeCloseTo(H);
    }
  });

  it('draw multiple documents as one outline with the hidden edges as details', () => {
    const def = SHAPE_DEFINITIONS.multiDocument;
    expect(flattenShapeCommands(def.outline(W, H))).toHaveLength(1);
    expect(flattenShapeCommands(def.details!(W, H))).toHaveLength(2);
  });

  it('keep their text box inside the outline', () => {
    const added = [
      'manualOperation',
      'display',
      'offPageConnector',
      'storedData',
      'internalStorage',
      'multiDocument',
      'merge',
      'loopStart',
      'loopEnd',
    ] as const;
    const inside = (
      polygon: ReadonlyArray<readonly [number, number]>,
      x: number,
      y: number,
    ) => {
      // Point in polygon, or within half a unit of its outline.
      let hit = false;
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [xi, yi] = polygon[i]!;
        const [xj, yj] = polygon[j]!;
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
          hit = !hit;
      }
      return hit || near(polygon, x, y);
    };
    const near = (
      polygon: ReadonlyArray<readonly [number, number]>,
      x: number,
      y: number,
    ) =>
      polygon.some(([px, py], i) => {
        const [qx, qy] = polygon[(i + 1) % polygon.length]!;
        const len = Math.hypot(qx - px, qy - py) || 1;
        const t = Math.max(
          0,
          Math.min(1, ((x - px) * (qx - px) + (y - py) * (qy - py)) / len ** 2),
        );
        return Math.hypot(px + t * (qx - px) - x, py + t * (qy - py) - y) < 0.5;
      });
    for (const kind of added) {
      const polygon = getShapeOutlinePolygon(kind, W, H);
      const box = getShapeTextBox(kind, W, H);
      for (const [x, y] of [
        [box.x, box.y],
        [box.x + box.w, box.y],
        [box.x, box.y + box.h],
        [box.x + box.w, box.y + box.h],
      ] as const)
        if (!inside(polygon, x, y))
          throw new Error(`${kind}: text box corner (${x}, ${y}) outside`);
    }
  });

  it('declare an insert size only where 160 x 80 reads badly', () => {
    const sized = Object.entries(SHAPE_DEFINITIONS)
      .filter(([, def]) => def.insertSize)
      .map(([kind]) => kind);
    expect(sized.sort()).toEqual(['merge', 'offPageConnector']);
  });
});
