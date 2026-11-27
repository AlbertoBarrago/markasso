import type { ElementType } from '../elements/element';
import type { RoutePoint } from './connector_geometry';

/**
 * When a connector "runs through" a node, measured the same way by the
 * elbow router (which avoids it) and by the MCP layout warnings (which
 * report it), so the two can never disagree. Pure geometry on boxes: the
 * caller supplies each node's connector box.
 */

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A node a connector must not run through: its id and its core rectangle. */
export interface RouteObstacle {
  readonly id: string;
  readonly core: Rect;
}

/** Shortest run of a connector inside a node that counts as crossing it. */
export const MIN_INSIDE = 8;

/** Element types connectors attach to, and so must not run through. */
const NODE_TYPES: ReadonlySet<ElementType> = new Set([
  'rectangle',
  'ellipse',
  'rhombus',
  'shape',
  'stencil',
  'text',
  'image',
  'polygon',
]);

export function isRouteNodeType(type: ElementType): boolean {
  return NODE_TYPES.has(type);
}

/**
 * Part of a node a connector must not cross: the rectangle inscribed in an
 * ellipse or rhombus (so passing near a corner of the bounding box is not a
 * crossing), the connector box otherwise, inset by a couple of pixels so a
 * stroke running along the border doesn't count.
 */
export function nodeCoreRect(type: ElementType, box: Rect): Rect {
  const scale =
    type === 'ellipse' ? Math.SQRT1_2 : type === 'rhombus' ? 0.5 : 1;
  const w = box.w * scale - 4;
  const h = box.h * scale - 4;
  return {
    x: box.x + (box.w - w) / 2,
    y: box.y + (box.h - h) / 2,
    w: Math.max(0, w),
    h: Math.max(0, h),
  };
}

/** Length of segment a-b inside `r` (Liang-Barsky clipping). */
export function lengthInside(a: RoutePoint, b: RoutePoint, r: Rect): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  const edges: Array<[number, number]> = [
    [-dx, a[0] - r.x],
    [dx, r.x + r.w - a[0]],
    [-dy, a[1] - r.y],
    [dy, r.y + r.h - a[1]],
  ];
  for (const [p, q] of edges) {
    if (Math.abs(p) < 1e-9) {
      if (q < 0) return 0;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return 0;
  }
  return (t1 - t0) * Math.hypot(dx, dy);
}

export function containsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

/**
 * Nodes drawn around others: frames or groups. Connectors inside them are
 * expected, so they are no obstacles (and no "through node" warning). Only
 * a node holding another node that is not text counts: a box with a caption
 * inside is still a box. Nodes are swept in x order, so the check stays
 * close to linear on boards where few nodes overlap.
 */
export function containerIds(
  nodes: ReadonlyArray<{
    readonly id: string;
    readonly box: Rect;
    readonly type?: ElementType;
  }>,
): Set<string> {
  const ids = new Set<string>();
  const sorted = [...nodes].sort((a, b) => a.box.x - b.box.x);
  for (let i = 0; i < sorted.length; i++) {
    const outer = sorted[i]!;
    const right = outer.box.x + outer.box.w;
    // Everything inside starts at or after outer.x: scan back over ties.
    let j = i;
    while (j > 0 && sorted[j - 1]!.box.x >= outer.box.x) j--;
    for (; j < sorted.length && sorted[j]!.box.x <= right; j++) {
      const inner = sorted[j]!;
      if (inner === outer || inner.type === 'text') continue;
      if (containsRect(outer.box, inner.box)) {
        ids.add(outer.id);
        break;
      }
    }
  }
  return ids;
}

/**
 * Obstacles a route runs through: at least MIN_INSIDE of it inside their
 * core, its own end nodes excluded. Ids in obstacle order.
 */
export function crossedObstacles(
  route: ReadonlyArray<RoutePoint>,
  obstacles: ReadonlyArray<RouteObstacle>,
  ends: ReadonlySet<string>,
): string[] {
  const crossed: string[] = [];
  // The route's bounding box rules out most obstacles at once.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of route) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  for (const obstacle of obstacles) {
    const { core } = obstacle;
    if (
      core.x > maxX ||
      core.y > maxY ||
      core.x + core.w < minX ||
      core.y + core.h < minY
    )
      continue;
    if (ends.has(obstacle.id)) continue;
    let inside = 0;
    for (let i = 1; i < route.length; i++)
      inside += lengthInside(route[i - 1]!, route[i]!, obstacle.core);
    if (inside >= MIN_INSIDE) crossed.push(obstacle.id);
  }
  return crossed;
}
