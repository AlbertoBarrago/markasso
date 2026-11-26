import { describe, expect, it } from 'vitest';
import {
  computeElbowRoute,
  distToQuadraticCurve,
  distToRoundedRoute,
  distToRoute,
  getArrowHeadLength,
  getArrowHeadShape,
  getArrowHeadVector,
  getQuadraticBounds,
  getQuadraticPoint,
  getRouteLength,
  getRoutePointAt,
  type RouteDirection,
  type RoutePathSink,
  type RoutePoint,
  roundRouteCorners,
  simplifyRoute,
  traceRoundedRoute,
} from '../src/rendering/connector_geometry';

describe('getArrowHeadVector', () => {
  it('uses the control point to orient the arrowhead at the end of a quadratic line', () => {
    const head = getArrowHeadVector(
      { x: 0, y: 0, x2: 100, y2: 0 },
      { cx: 80, cy: 40 },
      'end',
    );

    expect(head).toEqual({ fromX: 80, fromY: 40, tipX: 100, tipY: 0 });
  });

  it('uses the control point to orient the arrowhead at the start of a quadratic line', () => {
    const head = getArrowHeadVector(
      { x: 0, y: 0, x2: 100, y2: 0 },
      { cx: 20, cy: 40 },
      'start',
    );

    expect(head).toEqual({ fromX: 20, fromY: 40, tipX: 0, tipY: 0 });
  });

  it('falls back to the opposite endpoint when the control point collapses onto the tip', () => {
    const head = getArrowHeadVector(
      { x: 0, y: 0, x2: 100, y2: 0 },
      { cx: 100, cy: 0 },
      'end',
    );

    expect(head).toEqual({ fromX: 0, fromY: 0, tipX: 100, tipY: 0 });
  });

  it('computes the midpoint on a quadratic curve', () => {
    const point = getQuadraticPoint(0, 0, 50, 100, 100, 0, 0.5);
    expect(point.x).toBe(50);
    expect(point.y).toBe(50);
  });

  it('computes tight quadratic bounds', () => {
    const bounds = getQuadraticBounds(0, 0, 50, 100, 100, 0);
    expect(bounds.minX).toBe(0);
    expect(bounds.maxX).toBe(100);
    expect(bounds.minY).toBe(0);
    expect(bounds.maxY).toBe(50);
  });

  it('measures distance to the actual quadratic curve', () => {
    const dist = distToQuadraticCurve(50, 50, 0, 0, 50, 100, 100, 0);
    expect(dist).toBeCloseTo(0, 4);
  });
});

const RIGHT: RouteDirection = { dx: 1, dy: 0 };
const LEFT: RouteDirection = { dx: -1, dy: 0 };
const UP: RouteDirection = { dx: 0, dy: -1 };
const DOWN: RouteDirection = { dx: 0, dy: 1 };

/** Every elbow route must be orthogonal and respect both end directions. */
function expectValidRoute(
  route: RoutePoint[],
  start: RoutePoint,
  startDir: RouteDirection | null,
  end: RoutePoint,
  endDir: RouteDirection | null,
): void {
  expect(route[0]).toEqual(start);
  expect(route[route.length - 1]).toEqual(end);
  for (let i = 1; i < route.length; i++) {
    const [ax, ay] = route[i - 1]!;
    const [bx, by] = route[i]!;
    expect(ax === bx || ay === by).toBe(true);
  }
  if (startDir) {
    const [ax, ay] = route[0]!;
    const [bx, by] = route[1]!;
    expect(Math.sign(bx - ax)).toBe(startDir.dx);
    expect(Math.sign(by - ay)).toBe(startDir.dy);
  }
  if (endDir) {
    const [ax, ay] = route[route.length - 2]!;
    const [bx, by] = route[route.length - 1]!;
    // The last leg travels into the shape, against its outward normal.
    expect(Math.sign(bx - ax)).toBe(-endDir.dx || 0);
    expect(Math.sign(by - ay)).toBe(-endDir.dy || 0);
  }
}

describe('computeElbowRoute', () => {
  it('joins facing horizontal stubs with a Z through the midpoint', () => {
    const route = computeElbowRoute([0, 0], RIGHT, [100, 50], LEFT);
    expect(route).toEqual([
      [0, 0],
      [50, 0],
      [50, 50],
      [100, 50],
    ]);
    expectValidRoute(route, [0, 0], RIGHT, [100, 50], LEFT);
  });

  it('joins perpendicular stubs with a single corner', () => {
    const route = computeElbowRoute([0, 0], RIGHT, [100, 100], UP);
    expect(route).toEqual([
      [0, 0],
      [100, 0],
      [100, 100],
    ]);
  });

  it('uses the mirrored corner when the direct one would double back', () => {
    const route = computeElbowRoute([0, 0], RIGHT, [-100, 100], UP);
    expect(route).toEqual([
      [0, 0],
      [16, 0],
      [16, 84],
      [-100, 84],
      [-100, 100],
    ]);
    expectValidRoute(route, [0, 0], RIGHT, [-100, 100], UP);
  });

  it('detours around when both stubs face away on the same line', () => {
    const route = computeElbowRoute([0, 0], LEFT, [100, 0], RIGHT);
    expectValidRoute(route, [0, 0], LEFT, [100, 0], RIGHT);
    expect(Math.min(...route.map((p) => p[1]))).toBeLessThan(0);
  });

  it('routes free ends along the dominant axis', () => {
    expect(computeElbowRoute([0, 0], null, [100, 40], null)).toEqual([
      [0, 0],
      [50, 0],
      [50, 40],
      [100, 40],
    ]);
    expect(computeElbowRoute([0, 0], null, [40, 100], null)).toEqual([
      [0, 0],
      [0, 50],
      [40, 50],
      [40, 100],
    ]);
  });

  it('turns once toward a free end', () => {
    expect(computeElbowRoute([0, 0], DOWN, [100, 100], null)).toEqual([
      [0, 0],
      [0, 100],
      [100, 100],
    ]);
  });

  it('produces valid routes for every pair of directions', () => {
    const dirs = [UP, RIGHT, DOWN, LEFT];
    const ends: RoutePoint[] = [
      [200, 120],
      [-150, 80],
      [60, -200],
      [-90, -40],
    ];
    for (const sd of dirs) {
      for (const ed of dirs) {
        for (const end of ends) {
          const route = computeElbowRoute([0, 0], sd, end, ed);
          expectValidRoute(route, [0, 0], sd, end, ed);
        }
      }
    }
  });
});

describe('route helpers', () => {
  const route: RoutePoint[] = [
    [0, 0],
    [100, 0],
    [100, 100],
  ];

  it('simplifies duplicates and collinear points', () => {
    expect(
      simplifyRoute([
        [0, 0],
        [0, 0],
        [50, 0],
        [100, 0],
        [100, 100],
      ]),
    ).toEqual(route);
  });

  it('measures and samples along the route', () => {
    expect(getRouteLength(route)).toBe(200);
    expect(getRoutePointAt(route, 0.5)).toEqual([100, 0]);
    expect(getRoutePointAt(route, 0.75)).toEqual([100, 50]);
  });

  it('measures the distance to the closest segment', () => {
    expect(distToRoute(110, 50, route)).toBe(10);
  });
});

describe('roundRouteCorners', () => {
  it('cuts each inner vertex with a turn tangent to both legs', () => {
    expect(
      roundRouteCorners([
        [0, 0],
        [100, 0],
        [100, 100],
      ]),
    ).toEqual([
      { kind: 'line', to: [92, 0] },
      { kind: 'turn', corner: [100, 0], to: [100, 8] },
      { kind: 'line', to: [100, 100] },
    ]);
  });

  it('clamps the radius to half of the shorter adjacent leg', () => {
    // Z route with a 6px middle leg: both turns shrink to 3px and meet.
    expect(
      roundRouteCorners([
        [0, 0],
        [50, 0],
        [50, 6],
        [100, 6],
      ]),
    ).toEqual([
      { kind: 'line', to: [47, 0] },
      { kind: 'turn', corner: [50, 0], to: [50, 3] },
      { kind: 'turn', corner: [50, 6], to: [53, 6] },
      { kind: 'line', to: [100, 6] },
    ]);
  });

  it('keeps straight and degenerate vertices sharp', () => {
    expect(
      roundRouteCorners([
        [0, 0],
        [50, 0],
        [100, 0],
      ]),
    ).toEqual([
      { kind: 'line', to: [50, 0] },
      { kind: 'line', to: [100, 0] },
    ]);
    expect(
      roundRouteCorners([
        [0, 0],
        [0, 0],
        [0, 50],
      ]),
    ).toEqual([
      { kind: 'line', to: [0, 0] },
      { kind: 'line', to: [0, 50] },
    ]);
  });

  it('still rounds a sub-pixel jog that survives simplifyRoute', () => {
    const turns = roundRouteCorners(
      simplifyRoute([
        [0, 0],
        [10, 0],
        [10, 0.8],
        [20, 0.8],
      ]),
    ).flatMap((seg) => (seg.kind === 'turn' ? [seg] : []));
    expect(turns.map((t) => t.corner)).toEqual([
      [10, 0],
      [10, 0.8],
    ]);
    // Each turn takes half of the 0.8 jog.
    expect(turns[0]!.to[1]).toBeCloseTo(0.4, 9);
    expect(turns[1]!.to[0]).toBeCloseTo(10.4, 9);
  });

  it('leaves a two point route and an empty one as they are', () => {
    expect(
      roundRouteCorners([
        [0, 0],
        [10, 10],
      ]),
    ).toEqual([{ kind: 'line', to: [10, 10] }]);
    expect(roundRouteCorners([])).toEqual([]);
  });
});

describe('distToRoundedRoute', () => {
  const route: RoutePoint[] = [
    [0, 0],
    [100, 0],
    [100, 100],
  ];

  it('measures to the drawn turn, not to the cut corner', () => {
    // Midpoint of the 8px turn at (100, 0): (98, 2).
    expect(distToRoundedRoute(98, 2, route)).toBeLessThan(0.05);
    expect(distToRoute(98, 2, route)).toBe(2);
    expect(distToRoundedRoute(100, 0, route)).toBeGreaterThan(2.5);
  });

  it('matches the polyline on straight runs', () => {
    expect(distToRoundedRoute(50, 10, route)).toBeCloseTo(10, 6);
    expect(distToRoundedRoute(110, 50, route)).toBeCloseTo(10, 6);
  });

  it('handles routes without a segment', () => {
    expect(distToRoundedRoute(3, 4, [[0, 0]])).toBe(5);
    expect(distToRoundedRoute(3, 4, [])).toBe(Infinity);
  });
});

describe('traceRoundedRoute', () => {
  function recorder(): { sink: RoutePathSink; calls: unknown[][] } {
    const calls: unknown[][] = [];
    return {
      calls,
      sink: {
        moveTo: (...a) => calls.push(['M', ...a]),
        lineTo: (...a) => calls.push(['L', ...a]),
        quadraticCurveTo: (...a) => calls.push(['Q', ...a]),
      },
    };
  }

  it('traces the rounded route through the given mapping', () => {
    const { sink, calls } = recorder();
    traceRoundedRoute(
      sink,
      [
        [0, 0],
        [100, 0],
        [100, 100],
      ],
      (x, y) => [x * 2 + 1, y * 2 + 1],
    );
    expect(calls).toEqual([
      ['M', 1, 1],
      ['L', 185, 1],
      ['Q', 201, 1, 201, 17],
      ['L', 201, 201],
    ]);
  });

  it('draws nothing for a route without a segment', () => {
    const { sink, calls } = recorder();
    traceRoundedRoute(sink, [[5, 5]]);
    expect(calls).toEqual([]);
  });
});

describe('getArrowHeadShape', () => {
  // Horizontal connector pointing right, tip at (100, 0); head length 12.
  const shape = (style: Parameters<typeof getArrowHeadShape>[0]) =>
    getArrowHeadShape(style, 0, 0, 100, 0, 2);

  it('keeps the classic open head geometry', () => {
    const open = shape('open');
    expect(open.kind).toBe('polyline');
    if (open.kind !== 'polyline') return;
    const len = getArrowHeadLength(2);
    expect(open.points[1]).toEqual([100, 0]);
    expect(open.points[0]![0]).toBeCloseTo(100 - len * Math.cos(Math.PI / 6));
    expect(open.points[0]![1]).toBeCloseTo(len * Math.sin(Math.PI / 6));
    expect(open.points[2]![1]).toBeCloseTo(-len * Math.sin(Math.PI / 6));
  });

  it('closes triangles and fills only the filled variant', () => {
    const hollow = shape('triangle');
    const filled = shape('triangleFilled');
    expect(hollow).toMatchObject({ kind: 'polygon', filled: false });
    expect(filled).toMatchObject({ kind: 'polygon', filled: true });
  });

  it('builds a diamond that ends 1.2 head lengths behind the tip', () => {
    const diamond = shape('diamondFilled');
    expect(diamond.kind).toBe('polygon');
    if (diamond.kind !== 'polygon') return;
    const xs = diamond.points.map((p) => p[0]);
    expect(Math.max(...xs)).toBeCloseTo(100);
    expect(Math.min(...xs)).toBeCloseTo(100 - getArrowHeadLength(2) * 1.2);
  });

  it('places the circle so it touches the tip', () => {
    const circle = shape('circle');
    expect(circle.kind).toBe('circle');
    if (circle.kind !== 'circle') return;
    expect(circle.cx + circle.r).toBeCloseTo(100);
    expect(circle.cy).toBeCloseTo(0);
  });

  it('follows the connector direction', () => {
    const up = getArrowHeadShape('triangle', 0, 100, 0, 0, 2);
    if (up.kind !== 'polygon') throw new Error('expected polygon');
    // Pointing up: every back point sits below the tip.
    for (const [, y] of up.points.slice(1)) expect(y).toBeGreaterThan(0);
  });
});
