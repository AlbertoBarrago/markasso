import { describe, expect, it } from 'vitest';
import type {
  Element,
  LineElement,
  RectangleElement,
} from '../src/elements/element';
import type { RoutePoint } from '../src/rendering/connector_geometry';
import {
  getConnectorBox,
  resolveConnectorRoute,
} from '../src/rendering/draw_selection';
import {
  crossedObstacles,
  nodeCoreRect,
} from '../src/rendering/route_obstacles';

const style = {
  strokeColor: '#000',
  fillColor: 'transparent',
  strokeWidth: 2,
  opacity: 1,
  roughness: 0,
} as const;

function box(
  id: string,
  x: number,
  y: number,
  w = 160,
  h = 70,
): RectangleElement {
  return { ...style, id, type: 'rectangle', x, y, width: w, height: h };
}

function elbow(
  id: string,
  from: string,
  to: string,
  extra: Partial<LineElement> = {},
): LineElement {
  return {
    ...style,
    id,
    type: 'line',
    x: 0,
    y: 0,
    x2: 0,
    y2: 0,
    arrowHead: 'end',
    routing: 'elbow',
    startElementId: from,
    endElementId: to,
    ...extra,
  };
}

/**
 * The flow gallery's fan-out/fan-in, top to bottom, with fixed ids and the
 * hub centered over its children, as the layered layout places it.
 */
function fanOut(extra: Partial<LineElement> = {}): Element[] {
  const children = ['users', 'orders', 'billing', 'search'];
  return [
    box('gateway', 330, 0),
    ...children.map((id, i) => box(id, i * 220, 170)),
    box('bus', 330, 340),
    ...children.map((id) => elbow(`g-${id}`, 'gateway', id, extra)),
    ...children.map((id) => elbow(`${id}-b`, id, 'bus', extra)),
  ];
}

const isLine = (el: Element): el is LineElement => el.type === 'line';

/** Nodes each connector runs through, as the MCP warnings measure them. */
function throughNodes(elements: Element[]): string[] {
  const nodes = elements.filter((el) => el.type === 'rectangle');
  const obstacles = nodes.map((el) => ({
    id: el.id,
    core: nodeCoreRect(el.type, getConnectorBox(el)),
  }));
  return elements
    .filter(isLine)
    .flatMap((line) =>
      crossedObstacles(
        resolveConnectorRoute(line, elements),
        obstacles,
        new Set([line.startElementId!, line.endElementId!]),
      ).map((node) => `${line.id} through ${node}`),
    );
}

/** Whether two axis-aligned segments cross away from their ends. */
function segmentsCross(
  [a, b]: readonly [RoutePoint, RoutePoint],
  [c, d]: readonly [RoutePoint, RoutePoint],
): boolean {
  const aVertical = a[0] === b[0];
  const cVertical = c[0] === d[0];
  if (aVertical === cVertical) return false;
  const [v1, v2, h1, h2] = aVertical ? [a, b, c, d] : [c, d, a, b];
  const x = v1[0];
  const y = h1[1];
  const inside = (p: number, q: number, t: number) =>
    t > Math.min(p, q) + 1 && t < Math.max(p, q) - 1;
  return inside(h1[0], h2[0], x) && inside(v1[1], v2[1], y);
}

function crossings(elements: Element[]): string[] {
  const lines = elements.filter(isLine);
  const segments = (line: LineElement) => {
    const route = resolveConnectorRoute(line, elements);
    return route.slice(1).map((p, i) => [route[i]!, p] as const);
  };
  const found: string[] = [];
  lines.forEach((a, i) => {
    for (const b of lines.slice(i + 1))
      if (segments(a).some((s) => segments(b).some((t) => segmentsCross(s, t))))
        found.push(`${a.id} x ${b.id}`);
  });
  return found;
}

describe('scene-aware elbow sides', () => {
  it('routes a fan-out and fan-in around the siblings, without crossings', () => {
    const scene = fanOut();
    expect(throughNodes(scene)).toEqual([]);
    expect(crossings(scene)).toEqual([]);
  });

  it('gives the same routes whatever the order of the elements', () => {
    const scene = fanOut();
    const routes = (elements: Element[]) =>
      Object.fromEntries(
        elements
          .filter(isLine)
          .map((line) => [line.id, resolveConnectorRoute(line, elements)]),
      );
    const forward = routes(scene);
    expect(routes([...scene].reverse())).toEqual(forward);
    expect(routes([...scene.slice(6), ...scene.slice(0, 6)].reverse())).toEqual(
      forward,
    );
  });

  it('routes a connector that is not in the scene (a preview) as before', () => {
    const scene = fanOut();
    const preview = elbow('preview', 'gateway', 'bus');
    const route = resolveConnectorRoute(preview, scene);
    expect(route.length).toBeGreaterThanOrEqual(2);
    // An edited copy of a scene connector gets the scene's side choice.
    const original = scene.find((el) => el.id === 'g-users') as LineElement;
    const copy = { ...original };
    expect(resolveConnectorRoute(copy, scene)).toEqual(
      resolveConnectorRoute(original, scene),
    );
  });

  it('leaves pinned ends on the side of their anchor', () => {
    // Anchored on the gateway's left side: the route keeps that side even
    // though it runs through the siblings.
    const scene = fanOut({ startAnchor: { x: 0, y: 0.5 } });
    const line = scene.find((el) => el.id === 'g-users') as LineElement;
    const [start] = resolveConnectorRoute(line, scene);
    expect(start![0]).toBeCloseTo(330);
  });

  it('keeps scenes whose routes cross nothing exactly as before', () => {
    // Two boxes one above the other: a straight vertical connector.
    const scene: Element[] = [
      box('a', 0, 0),
      box('b', 0, 200),
      elbow('l', 'a', 'b'),
    ];
    expect(resolveConnectorRoute(scene[2] as LineElement, scene)).toEqual([
      [80, 70],
      [80, 200],
    ]);
  });

  describe('review cases', () => {
    // Two small boxes offset diagonally: the baseline runs a vertical stretch
    // at x = 140, and a blocker there makes the router try the other axis.
    const pair = (): Element[] => [
      box('a', 0, 0, 40, 40),
      box('b', 240, 120, 40, 40),
      elbow('l', 'a', 'b'),
    ];
    const routeOf = (scene: Element[]) =>
      resolveConnectorRoute(
        scene.find((e) => e.id === 'l') as LineElement,
        scene,
      );
    const baseline = routeOf(pair());

    it('switches sides to avoid a blocker', () => {
      expect(routeOf([...pair(), box('block', 130, 50, 20, 20)])).not.toEqual(
        baseline,
      );
    });

    it('measures rotated blockers by their rotated shape', () => {
      // 80 x 20 turned upright: it stands at x 165..185, clear of x = 140.
      const rotated: Element = {
        ...box('block', 135, 60, 80, 20),
        rotation: Math.PI / 2,
      };
      expect(routeOf([...pair(), rotated])).toEqual(baseline);
    });

    it('keeps a box with a caption inside as an obstacle', () => {
      const caption: Element = {
        ...style,
        id: 'caption',
        type: 'text',
        x: 133,
        y: 53,
        width: 10,
        height: 10,
        content: 'x',
        fontSize: 8,
        fontFamily: 'Arial',
      };
      const withBlocker = [...pair(), box('block', 130, 50, 20, 20)];
      expect(routeOf([...withBlocker, caption])).toEqual(routeOf(withBlocker));
    });

    it('refuses a switch that would cross another connector', () => {
      // A curve the switched route would cut through at (80, 80).
      const curve: LineElement = {
        ...style,
        id: 'curve',
        type: 'line',
        x: 80,
        y: 60,
        x2: 80,
        y2: 100,
        cx: 80,
        cy: 80,
        arrowHead: 'end',
        label: 'flow',
      };
      expect(
        routeOf([...pair(), box('block', 130, 50, 20, 20), curve]),
      ).toEqual(baseline);
    });

    it('lets an edited copy with another anchor keep its own anchor', () => {
      const scene = fanOut();
      const original = scene.find((el) => el.id === 'g-users') as LineElement;
      const copy: LineElement = { ...original, startAnchor: { x: 1, y: 0.5 } };
      const [start] = resolveConnectorRoute(copy, scene);
      expect(start).toEqual([490, 35]);
    });
  });
});
