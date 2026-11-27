import type {
  ArrowElement,
  ConnectorRouting,
  Element,
  LineElement,
} from '../../src/elements/element';
import {
  getQuadraticPoint,
  type RoutePoint,
} from '../../src/rendering/connector_geometry';
import { getConnectorLabelBoxes } from '../../src/rendering/connector_labels';
import {
  getConnectorBox,
  resolveConnectorRoute,
} from '../../src/rendering/draw_selection';
import {
  containerIds,
  containsRect,
  lengthInside,
  MIN_INSIDE,
  nodeCoreRect,
} from '../../src/rendering/route_obstacles';
import { type Diagram, edgeShortId } from './diagram';

/**
 * Geometric checks of a diagram as it is drawn: connectors through nodes,
 * labels on top of things, crossing connectors and overlapping nodes. The
 * agent drawing a diagram often can't look at the result, so these tell it
 * when the picture is unclear and what to try.
 *
 * Everything is computed from the resolved geometry (the routes and label
 * boxes the renderer uses), never from stored connector points.
 */

type Connector = LineElement | ArrowElement;
type Rect = { x: number; y: number; w: number; h: number };
type Segment = readonly [RoutePoint, RoutePoint];

/** A connection between two keyed nodes, as the agent knows it. */
export interface EdgeName {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  /** Decides which hints apply (elbow routing only helps straight ones). */
  readonly routing: ConnectorRouting;
}

export interface DiagramWarnings {
  /** A connector drawn across a node that is not one of its ends. */
  readonly throughNodes: ReadonlyArray<{ edge: EdgeName; node: string }>;
  /** A connector label on top of a node, or of another connector's label. */
  readonly labelOverlaps: ReadonlyArray<
    { edge: EdgeName; node: string } | { edge: EdgeName; label: EdgeName }
  >;
  /** Pairs of connectors whose strokes cross, with how many times. */
  readonly crossings: ReadonlyArray<{
    a: EdgeName;
    b: EdgeName;
    count: number;
  }>;
  /** Pairs of nodes whose boxes overlap (one inside the other excluded). */
  readonly nodeOverlaps: ReadonlyArray<readonly [string, string]>;
}

/** Smallest overlap, in px on each axis, worth reporting. */
const MIN_OVERLAP = 2;
/** Crossings this close to a segment end are joins, not crossings. */
const END_SLACK = 3;
/** Samples used to treat a curved connector as a polyline. */
const CURVE_SAMPLES = 12;
/** Items listed per warning type before "and N more". */
const MAX_LISTED = 8;

function isConnector(el: Element): el is Connector {
  return el.type === 'line' || el.type === 'arrow';
}

/** Polyline the connector is drawn along (curves sampled). */
function polylineOf(
  el: Connector,
  elements: ReadonlyArray<Element>,
): RoutePoint[] {
  const route = resolveConnectorRoute(el, elements);
  if (
    el.type !== 'line' ||
    // An elbow keeps a curve's control point but is never drawn as one.
    el.routing === 'elbow' ||
    el.cx === undefined ||
    el.cy === undefined ||
    route.length !== 2
  )
    return route;
  const [[x1, y1], [x2, y2]] = route as [RoutePoint, RoutePoint];
  const { cx, cy } = el;
  return Array.from({ length: CURVE_SAMPLES + 1 }, (_, i) => {
    const p = getQuadraticPoint(x1, y1, cx, cy, x2, y2, i / CURVE_SAMPLES);
    return [p.x, p.y] as RoutePoint;
  });
}

function segmentsOf(points: ReadonlyArray<RoutePoint>): Segment[] {
  return points.slice(1).map((p, i) => [points[i]!, p] as const);
}

function overlaps(a: Rect, b: Rect): boolean {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w >= MIN_OVERLAP && h >= MIN_OVERLAP;
}

/**
 * Whether two segments cross away from their ends. Connectors that share a
 * node meet at its border, and an elbow's bends meet the next segment: both
 * are joins, not crossings. Collinear runs are left out too.
 */
function segmentsCross(s: Segment, t: Segment): boolean {
  const [[ax, ay], [bx, by]] = s;
  const [[cx, cy], [dx, dy]] = t;
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return false;
  const u = ((cx - ax) * sy - (cy - ay) * sx) / den;
  const v = ((cx - ax) * ry - (cy - ay) * rx) / den;
  const lenS = Math.hypot(rx, ry);
  const lenT = Math.hypot(sx, sy);
  return (
    u * lenS > END_SLACK &&
    (1 - u) * lenS > END_SLACK &&
    v * lenT > END_SLACK &&
    (1 - v) * lenT > END_SLACK
  );
}

export function findWarnings(diagram: Diagram): DiagramWarnings {
  const elements = diagram.elements;
  const keys = diagram.nodeKeys();
  const nodes = elements.filter(
    (el) => keys.has(el.id) && el.visible !== false,
  );
  const boxes = new Map(nodes.map((el) => [el.id, getConnectorBox(el)]));
  // A node drawn around others is a frame or group: connectors and labels
  // inside it are expected, and so is the containment itself. Same rule as
  // the elbow router (a caption inside a box does not make it a frame).
  const containers = containerIds(
    nodes.map((el) => ({ id: el.id, box: boxes.get(el.id)!, type: el.type })),
  );
  const solid = nodes.filter((el) => !containers.has(el.id));
  const cores = new Map(
    solid.map((el) => [el.id, nodeCoreRect(el.type, boxes.get(el.id)!)]),
  );

  const edges: Array<{ name: EdgeName; el: Connector; segments: Segment[] }> =
    [];
  for (const el of elements) {
    if (!isConnector(el) || el.visible === false) continue;
    const from = el.startElementId ? keys.get(el.startElementId) : undefined;
    const to = el.endElementId ? keys.get(el.endElementId) : undefined;
    if (!from || !to) continue;
    edges.push({
      name: {
        id: edgeShortId(el),
        from,
        to,
        routing: el.routing ?? 'straight',
      },
      el,
      segments: segmentsOf(polylineOf(el, elements)),
    });
  }

  const throughNodes: Array<{ edge: EdgeName; node: string }> = [];
  for (const edge of edges) {
    for (const node of solid) {
      if (
        node.id === edge.el.startElementId ||
        node.id === edge.el.endElementId
      )
        continue;
      const core = cores.get(node.id)!;
      const inside = edge.segments.reduce(
        (sum, [a, b]) => sum + lengthInside(a, b, core),
        0,
      );
      if (inside >= MIN_INSIDE)
        throughNodes.push({ edge: edge.name, node: keys.get(node.id)! });
    }
  }

  const labels = getConnectorLabelBoxes(elements);
  const labelRects = edges.flatMap((edge) => {
    const box = labels.get(edge.el.id);
    return box
      ? [
          {
            edge: edge.name,
            rect: {
              x: box.x - box.w / 2,
              y: box.y - box.h / 2,
              w: box.w,
              h: box.h,
            },
          },
        ]
      : [];
  });
  const labelOverlaps: Array<
    { edge: EdgeName; node: string } | { edge: EdgeName; label: EdgeName }
  > = [];
  labelRects.forEach((label, i) => {
    for (const node of solid) {
      if (overlaps(label.rect, cores.get(node.id)!))
        labelOverlaps.push({ edge: label.edge, node: keys.get(node.id)! });
    }
    for (const other of labelRects.slice(i + 1)) {
      if (overlaps(label.rect, other.rect))
        labelOverlaps.push({ edge: label.edge, label: other.edge });
    }
  });

  const crossings: Array<{ a: EdgeName; b: EdgeName; count: number }> = [];
  edges.forEach((a, i) => {
    for (const b of edges.slice(i + 1)) {
      let count = 0;
      for (const s of a.segments)
        for (const t of b.segments) if (segmentsCross(s, t)) count++;
      if (count > 0) crossings.push({ a: a.name, b: b.name, count });
    }
  });

  const nodeOverlaps: Array<readonly [string, string]> = [];
  nodes.forEach((a, i) => {
    const ba = boxes.get(a.id)!;
    for (const b of nodes.slice(i + 1)) {
      const bb = boxes.get(b.id)!;
      if (overlaps(ba, bb) && !containsRect(ba, bb) && !containsRect(bb, ba))
        nodeOverlaps.push([keys.get(a.id)!, keys.get(b.id)!]);
    }
  });

  return { throughNodes, labelOverlaps, crossings, nodeOverlaps };
}

function edgeText(edge: EdgeName): string {
  return `${edge.from} -> ${edge.to} (id ${edge.id})`;
}

/** Up to MAX_LISTED items joined with "; ", then how many were left out. */
function listed(items: ReadonlyArray<string>): string {
  const shown = items.slice(0, MAX_LISTED).join('; ');
  const rest = items.length - MAX_LISTED;
  return rest > 0 ? `${shown}; and ${rest} more` : shown;
}

/**
 * Short text for the agent, one line per kind of problem with a hint, or
 * an empty string when the diagram is clear.
 */
export function formatWarnings(w: DiagramWarnings): string {
  const lines: string[] = [];
  if (w.throughNodes.length > 0) {
    const byEdge = new Map<string, { edge: EdgeName; nodes: string[] }>();
    for (const { edge, node } of w.throughNodes) {
      const entry = byEdge.get(edge.id) ?? { edge, nodes: [] };
      entry.nodes.push(node);
      byEdge.set(edge.id, entry);
    }
    lines.push(
      `- Connections through nodes: ${listed([...byEdge.values()].map((e) => `${edgeText(e.edge)} crosses ${e.nodes.join(', ')}`))}. Hint: move the crossed nodes off the line (diagram_update x/y) or try the other layout direction.`,
    );
  }
  if (w.labelOverlaps.length > 0)
    lines.push(
      `- Labels overlapping: ${listed(
        w.labelOverlaps.map((o) =>
          'node' in o
            ? `label of ${edgeText(o.edge)} on node ${o.node}`
            : `labels of ${edgeText(o.edge)} and ${edgeText(o.label)}`,
        ),
      )}. Hint: move the nodes apart or shorten the labels.`,
    );
  if (w.crossings.length > 0) {
    const total = w.crossings.reduce((sum, c) => sum + c.count, 0);
    const anyStraight = w.crossings.some(
      (c) => c.a.routing === 'straight' || c.b.routing === 'straight',
    );
    const hint = anyStraight
      ? 'try the other layout direction, or routing "elbow" on the straight ones (diagram_update_edge)'
      : 'try the other layout direction';
    lines.push(
      `- Crossing connections (${total}): ${listed(w.crossings.map((c) => `${edgeText(c.a)} x ${edgeText(c.b)}`))}. Hint: ${hint}.`,
    );
  }
  if (w.nodeOverlaps.length > 0)
    lines.push(
      `- Overlapping nodes: ${listed(w.nodeOverlaps.map(([a, b]) => `${a} and ${b}`))}. Hint: run diagram_layout, or move them (diagram_update x/y).`,
    );
  return lines.length > 0 ? `Warnings:\n${lines.join('\n')}` : '';
}

/** Warnings of the current diagram as text to append to a tool result. */
export function warningsSuffix(diagram: Diagram): string {
  const text = formatWarnings(findWarnings(diagram));
  return text ? `\n${text}` : '';
}
