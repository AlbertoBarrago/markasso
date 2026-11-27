import { normalizeRect } from '../core/geometry';
import type { Viewport } from '../core/viewport';
import { worldToScreen } from '../core/viewport';
import { getCanvasInk } from './theme_cache';

/** True when the canvas background is light (black ink, see getCanvasInk). */
function onLightCanvas(): boolean {
  return getCanvasInk() === '0,0,0';
}

/** Snap and anchor highlight: cyan on a dark canvas, a deeper blue on light. */
function snapColor(): string {
  return onLightCanvas() ? '#0b6fd0' : 'cyan';
}

/** Fill of resize/rotate handles: dark knobs on a dark canvas, white on light. */
function handleFill(): string {
  return onLightCanvas() ? '#ffffff' : '#1c1c2a';
}

import type {
  ArrowElement,
  ConnectorAnchor,
  Element,
  LineElement,
} from '../elements/element';
import { getShapeDefinition, type ShapeSide } from '../elements/shapes';
import {
  getStencilLabelBox,
  getStencilLabelHeight,
  isRotatableStencil,
} from '../elements/stencils/registry';
import {
  computeElbowRoute,
  ELBOW_STUB,
  getQuadraticBounds,
  getQuadraticPoint,
  type RouteDirection,
  type RoutePoint,
  traceRoundedRoute,
} from './connector_geometry';
import {
  containerIds,
  crossedObstacles,
  isRouteNodeType,
  nodeCoreRect,
  type RouteObstacle,
} from './route_obstacles';
import {
  getShapeBorderPointToward,
  getShapeDistToBoundary,
  getShapeNearestBorderPoint,
  getShapeSideEdge,
} from './shape_geometry';

/**
 * Returns the distance from (px, py) to the actual visual boundary of an element.
 * Used to pick the best snap candidate when multiple elements overlap.
 */
export function distToShapeBoundary(
  el: Element,
  b: { x: number; y: number; w: number; h: number },
  px: number,
  py: number,
): number {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const hw = b.w / 2;
  const hh = b.h / 2;
  if (hw < 0.001 || hh < 0.001) return Math.hypot(px - cx, py - cy);
  const dx = px - cx;
  const dy = py - cy;

  if (el.type === 'ellipse') {
    // Approximate distance to ellipse boundary: |normalized_radius - 1| * min_radius
    const n = Math.hypot(dx / hw, dy / hh);
    return Math.abs(n - 1) * Math.min(hw, hh);
  }
  if (el.type === 'rhombus') {
    // Distance to diamond boundary: |L1_normalized - 1| * min_half
    const n = Math.abs(dx) / hw + Math.abs(dy) / hh;
    return Math.abs(n - 1) * Math.min(hw, hh);
  }
  if (el.type === 'shape') {
    const [lx, ly] = el.rotation
      ? rotatePoint(px, py, cx, cy, -el.rotation)
      : [px, py];
    return getShapeDistToBoundary(el.kind, b.w, b.h, lx - b.x, ly - b.y);
  }
  // Rectangle / text / image / freehand: distance to nearest edge
  const insideX = hw - Math.abs(dx);
  const insideY = hh - Math.abs(dy);
  if (insideX < 0 || insideY < 0) {
    return Math.hypot(Math.max(0, -insideX), Math.max(0, -insideY));
  }
  return Math.min(insideX, insideY);
}

/**
 * Labeled stencils hang their label below the icon box: a point on the
 * box's bottom edge moves below the label, so connectors entering from
 * below stop under the text instead of crossing it. Sides and top are
 * unaffected. Rotated stencils keep the plain box.
 */
function belowStencilLabel(
  el: Element,
  b: { y: number; h: number },
  localY: number,
): number {
  if (el.type !== 'stencil' || el.rotation) return localY;
  return Math.abs(localY - (b.y + b.h)) < 0.5
    ? localY + getStencilLabelHeight(el)
    : localY;
}

/**
 * Parameter t at which the ray center + t * (dx, dy) leaves `rect` (given
 * relative to the ray origin), or null when the ray misses it.
 */
function rayExitRect(
  dx: number,
  dy: number,
  rect: { x: number; y: number; w: number; h: number },
): number | null {
  let tMin = 0;
  let tMax = Infinity;
  for (const [d, lo, hi] of [
    [dx, rect.x, rect.x + rect.w],
    [dy, rect.y, rect.y + rect.h],
  ] as const) {
    if (Math.abs(d) < 1e-9) {
      if (lo > 0 || hi < 0) return null;
      continue;
    }
    const t1 = lo / d;
    const t2 = hi / d;
    tMin = Math.max(tMin, Math.min(t1, t2));
    tMax = Math.min(tMax, Math.max(t1, t2));
  }
  return tMax >= tMin && tMax < Infinity ? tMax : null;
}

/**
 * Box connectors treat as the element: its bounds, plus the label hanging
 * below an unrotated stencil, so arrows attach around the text, route clear
 * of it and auto layout reserves room for it.
 */
export function getConnectorBox(el: Element): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const b = getElementBounds(el);
  if (el.type !== 'stencil' || el.rotation) return b;
  const label = getStencilLabelBox(el);
  if (!label) return b;
  const x = Math.min(b.x, label.x);
  const right = Math.max(b.x + b.w, label.x + label.w);
  return { x, y: b.y, w: right - x, h: label.y + label.h - b.y };
}

/**
 * Returns the point on the border of an element in the direction from its center toward (targetX, targetY).
 * For ellipses uses the true ellipse boundary; for all others uses the bounding rectangle.
 */
export function getElementBorderPoint(
  el: Element,
  targetX: number,
  targetY: number,
): [number, number] {
  const b = getElementBounds(el);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const rot = ('rotation' in el ? el.rotation : undefined) ?? 0;

  // Rotate direction into shape's local (un-rotated) coordinate space
  let dx = targetX - cx;
  let dy = targetY - cy;
  if (rot) {
    const cos = Math.cos(-rot);
    const sin = Math.sin(-rot);
    const ldx = dx * cos - dy * sin;
    const ldy = dx * sin + dy * cos;
    dx = ldx;
    dy = ldy;
  }

  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return [cx, b.y]; // fallback: top-center

  let lx: number;
  let ly: number;

  if (el.type === 'ellipse') {
    const angle = Math.atan2(dy, dx);
    lx = (b.w / 2) * Math.cos(angle);
    ly = (b.h / 2) * Math.sin(angle);
  } else if (el.type === 'rhombus') {
    // Diamond border: L1-norm intersection
    const hw = b.w / 2;
    const hh = b.h / 2;
    const t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
    lx = dx * t;
    ly = dy * t;
  } else if (el.type === 'shape') {
    const [bx, by] = getShapeBorderPointToward(el.kind, b.w, b.h, dx, dy);
    lx = bx - b.w / 2;
    ly = by - b.h / 2;
  } else {
    // Rectangle / text / image / freehand — axis-aligned border intersection
    const hw = b.w / 2;
    const hh = b.h / 2;
    const t = Math.min(
      Math.abs(dx) > 0.001 ? hw / Math.abs(dx) : Infinity,
      Math.abs(dy) > 0.001 ? hh / Math.abs(dy) : Infinity,
    );
    lx = dx * t;
    ly = dy * t;
  }

  // A ray that crosses an unrotated stencil's label leaves on the far side
  // of the label, so the connector never runs over the text.
  if (el.type === 'stencil' && !rot) {
    const label = getStencilLabelBox(el);
    const t = label
      ? rayExitRect(dx, dy, {
          x: label.x - cx,
          y: label.y - cy,
          w: label.w,
          h: label.h,
        })
      : null;
    if (t !== null && Math.hypot(dx * t, dy * t) > Math.hypot(lx, ly)) {
      lx = dx * t;
      ly = dy * t;
    }
  }

  // Rotate result back to world space
  if (rot) {
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    return [cx + lx * cos - ly * sin, cy + lx * sin + ly * cos];
  }
  return [cx + lx, cy + ly];
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function rotatePoint(
  x: number,
  y: number,
  cx: number,
  cy: number,
  angle: number,
): [number, number] {
  const dx = x - cx;
  const dy = y - cy;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
}

function nearestRectBorderPoint(
  b: { x: number; y: number; w: number; h: number },
  px: number,
  py: number,
): [number, number] {
  const x1 = b.x;
  const y1 = b.y;
  const x2 = b.x + b.w;
  const y2 = b.y + b.h;
  const inside = px >= x1 && px <= x2 && py >= y1 && py <= y2;

  if (!inside) return [clamp(px, x1, x2), clamp(py, y1, y2)];

  const distances = [
    { d: Math.abs(px - x1), point: [x1, py] as [number, number] },
    { d: Math.abs(x2 - px), point: [x2, py] as [number, number] },
    { d: Math.abs(py - y1), point: [px, y1] as [number, number] },
    { d: Math.abs(y2 - py), point: [px, y2] as [number, number] },
  ];
  distances.sort((a, b) => a.d - b.d);
  return distances[0]!.point;
}

/**
 * Returns the nearest visual border point to the user's pointer.
 * This is intentionally pointer-driven: snap previews should attach where the
 * cursor is, not where a center-to-center connector would later infer a border.
 */
export function getNearestElementBorderPoint(
  el: Element,
  px: number,
  py: number,
): [number, number] {
  const b = getElementBounds(el);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const rotation = ('rotation' in el ? el.rotation : undefined) ?? 0;
  const [localPx, localPy] = rotation
    ? rotatePoint(px, py, cx, cy, -rotation)
    : [px, py];

  let localPoint: [number, number];

  if (el.type === 'ellipse') {
    const rx = b.w / 2;
    const ry = b.h / 2;
    const dx = localPx - cx;
    const dy = localPy - cy;
    if (
      rx < 0.001 ||
      ry < 0.001 ||
      (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001)
    ) {
      localPoint = [cx, b.y];
    } else {
      const scale = 1 / Math.hypot(dx / rx, dy / ry);
      localPoint = [cx + dx * scale, cy + dy * scale];
    }
  } else if (el.type === 'rhombus') {
    const dx = localPx - cx;
    const dy = localPy - cy;
    const hw = b.w / 2;
    const hh = b.h / 2;
    if (
      hw < 0.001 ||
      hh < 0.001 ||
      (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001)
    ) {
      localPoint = [cx, b.y];
    } else {
      const t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
      localPoint = [cx + dx * t, cy + dy * t];
    }
  } else if (el.type === 'shape') {
    const [nx, ny] = getShapeNearestBorderPoint(
      el.kind,
      b.w,
      b.h,
      localPx - b.x,
      localPy - b.y,
    );
    localPoint = [b.x + nx, b.y + ny];
  } else {
    localPoint = nearestRectBorderPoint(b, localPx, localPy);
  }
  localPoint = [localPoint[0], belowStencilLabel(el, b, localPoint[1])];

  return rotation
    ? rotatePoint(localPoint[0], localPoint[1], cx, cy, rotation)
    : localPoint;
}

export interface ElementSnapTarget {
  elementId: string;
  worldX: number;
  worldY: number;
  distance: number;
  /** Set when the target is a port: the connector end gets pinned there. */
  anchor?: ConnectorAnchor;
}

/** Elements that expose N/E/S/W connection ports. */
function hasPorts(el: Element): boolean {
  return (
    el.type === 'rectangle' ||
    el.type === 'ellipse' ||
    el.type === 'rhombus' ||
    el.type === 'shape' ||
    el.type === 'stencil' ||
    el.type === 'text' ||
    el.type === 'image'
  );
}

/** Converts a world point to an anchor relative to the element's local box. */
export function worldToAnchor(
  el: Element,
  wx: number,
  wy: number,
): ConnectorAnchor {
  const b = getElementBounds(el);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const [lx, ly] = el.rotation
    ? rotatePoint(wx, wy, cx, cy, -el.rotation)
    : [wx, wy];
  return {
    x: b.w > 0 ? clamp((lx - b.x) / b.w, 0, 1) : 0.5,
    y: b.h > 0 ? clamp((ly - b.y) / b.h, 0, 1) : 0.5,
  };
}

/**
 * World position of an anchor, projected onto the element's outline. The
 * projection keeps the end on the border when a resize changes the shape's
 * proportions (e.g. the slanted side of a data block moves).
 */
export function anchorToWorld(
  el: Element,
  anchor: ConnectorAnchor,
): [number, number] {
  const b = getElementBounds(el);
  const lx = b.x + anchor.x * b.w;
  const ly = b.y + anchor.y * b.h;
  const [wx, wy] = el.rotation
    ? rotatePoint(lx, ly, b.x + b.w / 2, b.y + b.h / 2, el.rotation)
    : [lx, ly];
  return getNearestElementBorderPoint(el, wx, wy);
}

export interface ElementPort {
  worldX: number;
  worldY: number;
  anchor: ConnectorAnchor;
}

/** The four cardinal ports of an element, following its rotation. */
export function getElementPorts(el: Element): ElementPort[] {
  if (!hasPorts(el)) return [];
  const b = getElementBounds(el);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const reach = b.w + b.h + 1;
  const rotation = el.rotation ?? 0;
  const dirs: Array<[number, number]> = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ];
  return dirs.map(([dx, dy]) => {
    const [tx, ty] = rotatePoint(
      cx + dx * reach,
      cy + dy * reach,
      cx,
      cy,
      rotation,
    );
    const [worldX, worldY] = getElementBorderPoint(el, tx, ty);
    return { worldX, worldY, anchor: worldToAnchor(el, worldX, worldY) };
  });
}

/**
 * Snap target for a connector end: a port within `portRadius` wins (pinned
 * end), otherwise the nearest border point within `snapRadius` (floating end).
 */
export function findConnectorSnapTarget(
  elements: ReadonlyArray<Element>,
  px: number,
  py: number,
  snapRadius: number,
  portRadius: number,
  ignoreId?: string,
): ElementSnapTarget | null {
  let bestPort: ElementSnapTarget | null = null;
  for (const el of elements) {
    if (el.id === ignoreId || el.visible === false) continue;
    for (const port of getElementPorts(el)) {
      const distance = Math.hypot(px - port.worldX, py - port.worldY);
      if (distance > portRadius) continue;
      if (!bestPort || distance < bestPort.distance) {
        bestPort = {
          elementId: el.id,
          worldX: port.worldX,
          worldY: port.worldY,
          distance,
          anchor: port.anchor,
        };
      }
    }
  }
  return (
    bestPort ??
    findNearestElementSnapTarget(elements, px, py, snapRadius, ignoreId)
  );
}

export function findNearestElementSnapTarget(
  elements: ReadonlyArray<Element>,
  px: number,
  py: number,
  snapRadius: number,
  ignoreId?: string,
): ElementSnapTarget | null {
  let best: ElementSnapTarget | null = null;
  for (const el of elements) {
    if (el.id === ignoreId || el.visible === false) continue;
    if (el.type === 'line' || el.type === 'arrow') continue;
    const [worldX, worldY] = getNearestElementBorderPoint(el, px, py);
    const distance = Math.hypot(px - worldX, py - worldY);
    if (distance > snapRadius) continue;
    if (!best || distance < best.distance) {
      best = { elementId: el.id, worldX, worldY, distance };
    }
  }
  return best;
}

/**
 * Resolves the effective endpoints of a line/arrow element,
 * snapping to the border of connected elements (facing each other).
 */
export function resolveArrowEndpoints(
  el: {
    x: number;
    y: number;
    x2: number;
    y2: number;
    startElementId?: string;
    endElementId?: string;
    startAnchor?: ConnectorAnchor;
    endAnchor?: ConnectorAnchor;
  },
  allElements: ReadonlyArray<Element>,
): { x: number; y: number; x2: number; y2: number } {
  let { x, y, x2, y2 } = el;

  const byId = elementsById(allElements);
  const startEl = el.startElementId
    ? (byId.get(el.startElementId) ?? null)
    : null;
  const endEl = el.endElementId ? (byId.get(el.endElementId) ?? null) : null;

  // Pinned ends are resolved first: a floating end then faces the pinned
  // point instead of the other element's center.
  const startPinned =
    startEl && el.startAnchor ? anchorToWorld(startEl, el.startAnchor) : null;
  const endPinned =
    endEl && el.endAnchor ? anchorToWorld(endEl, el.endAnchor) : null;

  // Effective targets used for direction computation
  const startB = startEl ? getElementBounds(startEl) : null;
  const endB = endEl ? getElementBounds(endEl) : null;
  const [startCx, startCy] =
    startPinned ??
    (startB ? [startB.x + startB.w / 2, startB.y + startB.h / 2] : [x, y]);
  const [endCx, endCy] =
    endPinned ?? (endB ? [endB.x + endB.w / 2, endB.y + endB.h / 2] : [x2, y2]);

  if (startPinned) {
    [x, y] = startPinned;
  } else if (startEl) {
    const startBounds = getElementBounds(startEl);
    const storedStartDist = distToShapeBoundary(startEl, startBounds, x, y);
    [x, y] =
      storedStartDist <= 1
        ? getNearestElementBorderPoint(startEl, x, y)
        : getElementBorderPoint(startEl, endCx, endCy);
  }
  if (endPinned) {
    [x2, y2] = endPinned;
  } else if (endEl) {
    const endBounds = getElementBounds(endEl);
    const storedEndDist = distToShapeBoundary(endEl, endBounds, x2, y2);
    [x2, y2] =
      storedEndDist <= 1
        ? getNearestElementBorderPoint(endEl, x2, y2)
        : getElementBorderPoint(endEl, startCx, startCy);
  }

  return { x, y, x2, y2 };
}

/** Local unit directions of the N/E/S/W sides, in `getElementPorts` order. */
const SIDE_DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/** Side (index into SIDE_DIRS) of the element's box facing a local offset. */
function sideFacing(lx: number, ly: number, hw: number, hh: number): number {
  const nx = hw > 0 ? lx / hw : lx;
  const ny = hh > 0 ? ly / hh : ly;
  if (Math.abs(nx) >= Math.abs(ny)) return nx >= 0 ? 1 : 3;
  return ny >= 0 ? 2 : 0;
}

/**
 * Side of `from` facing `to`, picked like draw.io: leave along the axis
 * with the larger free gap between the two boxes. Comparing gaps (not
 * center offsets scaled by the box) keeps wide, short shapes from always
 * exiting through the bottom and crossing their neighbors.
 */
function sideTowardBox(
  from: { x: number; y: number; w: number; h: number },
  to: { x: number; y: number; w: number; h: number },
): number {
  const dx = to.x + to.w / 2 - (from.x + from.w / 2);
  const dy = to.y + to.h / 2 - (from.y + from.h / 2);
  const gapX = Math.abs(dx) - (from.w + to.w) / 2;
  const gapY = Math.abs(dy) - (from.h + to.h) / 2;
  if (gapX >= gapY) return dx >= 0 ? 1 : 3;
  return dy >= 0 ? 2 : 0;
}

/** World-space axis direction of a side, snapped after applying rotation. */
function sideDirection(el: Element, side: number): RouteDirection {
  const [ldx, ldy] = SIDE_DIRS[side]!;
  const rot = el.rotation ?? 0;
  const wx = ldx * Math.cos(rot) - ldy * Math.sin(rot);
  const wy = ldx * Math.sin(rot) + ldy * Math.cos(rot);
  return Math.abs(wx) >= Math.abs(wy)
    ? { dx: wx >= 0 ? 1 : -1, dy: 0 }
    : { dx: 0, dy: wy >= 0 ? 1 : -1 };
}

/**
 * Where a connector end attached to `el` leaves it on an elbow route. A
 * pinned end keeps its point and leaves by the side its anchor sits on; a
 * floating end moves to the port facing `target`, so flowcharts get clean
 * mid-side attachments instead of corner hits.
 */
function elbowEnd(
  el: Element,
  anchor: ConnectorAnchor | undefined,
  pinned: RoutePoint,
  target: RoutePoint,
  targetBox?: { x: number; y: number; w: number; h: number },
  forcedSide?: number,
): { point: RoutePoint; dir: RouteDirection; stub: number } {
  const b = getElementBounds(el);
  const box = getConnectorBox(el);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  // Leaving sideways from an icon whose label is wider than the icon, the
  // stub runs past the label so the next turn doesn't cut through it.
  const stubFor = (dir: RouteDirection) =>
    dir.dx !== 0 ? ELBOW_STUB + (box.w - b.w) / 2 : ELBOW_STUB;
  if (anchor) {
    const side = sideFacing(anchor.x - 0.5, anchor.y - 0.5, 0.5, 0.5);
    const dir = sideDirection(el, side);
    return { point: pinned, dir, stub: stubFor(dir) };
  }
  const [lx, ly] = el.rotation
    ? rotatePoint(target[0], target[1], cx, cy, -el.rotation)
    : target;
  const side =
    forcedSide ??
    (targetBox && !el.rotation
      ? sideTowardBox(box, targetBox)
      : sideFacing(lx - cx, ly - cy, b.w / 2, b.h / 2));
  const port = getElementPorts(el)[side];
  const dir = sideDirection(el, side);
  return {
    point: port ? [port.worldX, port.worldY] : pinned,
    dir,
    stub: stubFor(dir),
  };
}

/** Where one elbow end leaves its element: point, outward direction, stub. */
interface ElbowEnd {
  point: RoutePoint;
  readonly dir: RouteDirection;
  stub: number;
}

/** Sides (indices into SIDE_DIRS) forced on the two ends of a connector. */
interface SidePair {
  readonly start: number;
  readonly end: number;
}

/** Both ends of an elbow connector before ports are spread along sides. */
interface ElbowPlan {
  readonly start: RoutePoint;
  readonly end: RoutePoint;
  readonly startEl: Element | undefined;
  readonly endEl: Element | undefined;
  readonly s: ElbowEnd | null;
  readonly e: ElbowEnd | null;
  /** Both ends were put on one shared coordinate (see sharedOffset). */
  readonly aligned: boolean;
}

/**
 * Plans the two ends of an elbow connector from its own data and the
 * elements it is attached to: the side each end leaves by, the port it
 * starts from, and a shared coordinate when two flat sides face each other.
 */
function planElbowEnds(
  el: LineElement | ArrowElement,
  allElements: ReadonlyArray<Element>,
  sides?: SidePair,
): ElbowPlan {
  const pts = resolveArrowEndpoints(el, allElements);
  const start: RoutePoint = [pts.x, pts.y];
  const end: RoutePoint = [pts.x2, pts.y2];

  const byId = elementsById(allElements);
  const startEl = el.startElementId ? byId.get(el.startElementId) : undefined;
  const endEl = el.endElementId ? byId.get(el.endElementId) : undefined;

  // A floating end faces the other end's pinned point, its element's
  // center, or its free position, in that order.
  const targetOf = (
    other: Element | undefined,
    otherAnchor: ConnectorAnchor | undefined,
    otherPoint: RoutePoint,
  ): RoutePoint => {
    if (!other || otherAnchor) return otherPoint;
    const [ocx, ocy] = getElementCenter(other);
    return [ocx, ocy];
  };

  // Two floating ends on unrotated shapes pick their sides from the gap
  // between the boxes, so both ends agree on the axis.
  const boxOf = (
    other: Element | undefined,
    otherAnchor: ConnectorAnchor | undefined,
  ) =>
    other && !otherAnchor && !other.rotation
      ? getConnectorBox(other)
      : undefined;

  const s = startEl
    ? elbowEnd(
        startEl,
        el.startAnchor,
        start,
        targetOf(endEl, el.endAnchor, end),
        boxOf(endEl, el.endAnchor),
        sides?.start,
      )
    : null;
  const e = endEl
    ? elbowEnd(
        endEl,
        el.endAnchor,
        end,
        targetOf(startEl, el.startAnchor, start),
        boxOf(startEl, el.startAnchor),
        sides?.end,
      )
    : null;

  let aligned = false;
  if (s && e && startEl && endEl && !el.startAnchor && !el.endAnchor) {
    const shared = sharedOffset(startEl, s.dir, endEl, e.dir);
    if (shared !== null) {
      placeAlong(s, startEl, shared);
      placeAlong(e, endEl, shared);
      aligned = true;
    }
  }
  return { start, end, startEl, endEl, s, e, aligned };
}

const byIdCache = new WeakMap<
  ReadonlyArray<Element>,
  ReadonlyMap<string, Element>
>();

/**
 * Elements of an (immutable) array by id, built once per array: routing a
 * scene looks up both ends of every connector. The first element with an
 * id wins, as `Array.find` did.
 */
function elementsById(
  allElements: ReadonlyArray<Element>,
): ReadonlyMap<string, Element> {
  let map = byIdCache.get(allElements);
  if (!map) {
    const built = new Map<string, Element>();
    for (const el of allElements) if (!built.has(el.id)) built.set(el.id, el);
    map = built;
    byIdCache.set(allElements, map);
  }
  return map;
}

/** Key of one connector end in the port slot map. */
const slotKey = (id: string, which: 'start' | 'end') => `${id}:${which}`;

/** A visible elbow connector of the scene and its planned ends. */
interface PlannedElbow {
  readonly el: LineElement | ArrowElement;
  readonly plan: ElbowPlan;
}

/** Space between two connector ends that share a side. */
const PORT_GAP = 20;
/** Clearance between a spread end and the end of its side (less on short sides). */
const PORT_MARGIN = 8;

/**
 * Moves ordered points along a segment as little as possible so that
 * consecutive ones are at least `PORT_GAP` apart: points that would come too
 * close are merged into a cluster, spaced evenly and centered on their mean,
 * then kept inside [lo + PORT_MARGIN, hi - PORT_MARGIN]. A point no other
 * point crowds keeps its place, so a connector that already runs straight
 * is not bent. When the side is too short for the full gap, the gap shrinks.
 */
export function spreadAlongSide(
  preferred: ReadonlyArray<number>,
  lo: number,
  hi: number,
): number[] {
  const n = preferred.length;
  const margin = Math.min(PORT_MARGIN, (hi - lo) / 4);
  const min = lo + margin;
  const max = hi - margin;
  if (n < 2 || max <= min) return [...preferred];
  const gap = Math.min(PORT_GAP, (max - min) / (n - 1));

  interface Cluster {
    readonly first: number;
    readonly count: number;
    readonly sum: number;
    readonly start: number;
  }
  const make = (first: number, count: number, sum: number): Cluster => {
    const width = (count - 1) * gap;
    const center = sum / count;
    const start =
      count === 1
        ? center
        : Math.min(Math.max(center - width / 2, min), max - width);
    return { first, count, sum, start };
  };
  const clusters: Cluster[] = [];
  preferred.forEach((p, i) => {
    let cur = make(i, 1, p);
    for (;;) {
      const prev = clusters[clusters.length - 1];
      if (!prev || prev.start + prev.count * gap <= cur.start + 0.001) break;
      clusters.pop();
      cur = make(prev.first, prev.count + cur.count, prev.sum + cur.sum);
    }
    clusters.push(cur);
  });
  const out: number[] = [];
  for (const c of clusters) {
    for (let k = 0; k < c.count; k++) out.push(c.start + k * gap);
  }
  return out;
}

/**
 * Separates the floating elbow ends that leave the same flat side of a node
 * and would sit on top of each other (typically all on its middle port):
 * see spreadAlongSide. Ends on a side are ordered by where their other end
 * sits along the side's axis (then by connector id), so fanned-out
 * connectors do not cross each other. Returns the ends it moved, with their
 * new coordinate along the side (x for top/bottom, y for left/right).
 *
 * Pinned ends, hidden connectors, self-loops and sides with a single port
 * (see sideSpan) keep their planned point, and a side with a single
 * end is left alone. The result depends only on the plans, so every live
 * peer computes the same routes (see routeElbows, which caches them).
 */
function elbowPortSlots(
  planned: ReadonlyArray<PlannedElbow>,
  steered: ReadonlySet<string> = new Set(),
): ReadonlyMap<string, number> {
  interface Member {
    readonly key: string;
    readonly group: string;
    readonly node: Element;
    readonly dir: RouteDirection;
    /** The end's planned coordinate along the side's axis. */
    readonly at: number;
    /** The other end's coordinate along the same axis. */
    readonly toward: number;
    /**
     * Angle from the side's normal to the other end. Coincident ends are
     * ordered by it, like draw.io: the end whose connector turns away
     * sooner takes the outer slot, so the two never cross.
     */
    readonly angle: number;
    readonly id: string;
  }
  const groups = new Map<string, Member[]>();
  /** Connectors whose ends sharedOffset put on one coordinate. */
  const aligned: Array<readonly [Member, Member]> = [];
  for (const { el, plan } of planned) {
    if (el.startElementId && el.startElementId === el.endElementId) continue;
    const ends = [
      [
        plan.s,
        plan.startEl,
        el.startAnchor,
        plan.e?.point ?? plan.end,
        'start',
      ],
      [plan.e, plan.endEl, el.endAnchor, plan.s?.point ?? plan.start, 'end'],
    ] as const;
    const added: Member[] = [];
    for (const [end, node, anchor, other, which] of ends) {
      if (!end || !node || anchor || !sideSpan(node, end.dir)) continue;
      const axis = end.dir.dx === 0 ? 0 : 1;
      const depth =
        (other[0] - end.point[0]) * end.dir.dx +
        (other[1] - end.point[1]) * end.dir.dy;
      const member: Member = {
        key: slotKey(el.id, which),
        group: `${node.id}:${end.dir.dx},${end.dir.dy}`,
        node,
        dir: end.dir,
        at: end.point[axis],
        toward: other[axis],
        angle: Math.atan2(other[axis] - end.point[axis], depth),
        id: el.id,
      };
      const members = groups.get(member.group) ?? [];
      members.push(member);
      groups.set(member.group, members);
      added.push(member);
    }
    if (plan.aligned && added.length === 2)
      aligned.push([added[0]!, added[1]!]);
  }

  // A connector that ran straight between two facing sides (sharedOffset)
  // should stay straight: each of its ends prefers the coordinate its
  // partner was given. Sides are placed from the most crowded down, so the
  // fewer ends of a quieter side line up with the busier one (a lone end
  // simply follows its partner), with ties broken by group key.
  const partnerOf = new Map<string, string>();
  for (const [a, b] of aligned) {
    partnerOf.set(a.key, b.key);
    partnerOf.set(b.key, a.key);
  }
  const placedAt = new Map<string, number>();
  const slots = new Map<string, number>();
  const order = [...groups.entries()].sort(
    ([ka, a], [kb, b]) =>
      b.length - a.length || (ka < kb ? -1 : ka > kb ? 1 : 0),
  );
  for (const [, members] of order) {
    const { node, dir } = members[0]!;
    const [lo, hi] = sideSpan(node, dir)!;
    const preferred = new Map<Member, number>();
    for (const m of members) {
      const partner = partnerOf.get(m.key);
      const there = partner === undefined ? undefined : placedAt.get(partner);
      // On a side it shares, a connector moved to another side pair (see
      // routeElbows) leaves toward its other end, so a fan-out's outer
      // arrows take the outer slots instead of crossing the ones already
      // running straight. Alone on its side it keeps the middle port.
      const own =
        steered.has(m.id) && members.length > 1
          ? Math.min(Math.max(m.toward, lo), hi)
          : m.at;
      preferred.set(
        m,
        there !== undefined && there >= lo && there <= hi ? there : own,
      );
    }
    const pref = (m: Member) => preferred.get(m)!;
    // Preferred position first, so ends that are already apart keep their
    // order and their place; only coincident ones are ordered by angle.
    // Positions are compared on a 0.01 grid, not with a tolerance, which
    // would not be transitive (a ~ b ~ c but a < c) and could make the
    // order depend on the order of the elements.
    const grid = (m: Member) => Math.round(pref(m) * 100);
    members.sort(
      (a, b) =>
        grid(a) - grid(b) ||
        a.angle - b.angle ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const placed = spreadAlongSide(members.map(pref), lo, hi);
    members.forEach((m, i) => {
      placedAt.set(m.key, placed[i]!);
      if (Math.abs(placed[i]! - m.at) > 0.01) slots.set(m.key, placed[i]!);
    });
  }
  return slots;
}

/**
 * Moves an end's point to `along` on its side's axis. On a flowchart symbol
 * the point also moves across, onto the outline, since that side may be
 * slanted or curved; flat sides keep their line.
 */
function placeAlong(end: ElbowEnd, node: Element, along: number): void {
  const vertical = end.dir.dx === 0;
  let across = vertical ? end.point[1] : end.point[0];
  if (node.type === 'shape' && !node.rotation) {
    const b = getElementBounds(node);
    const [start, length] = vertical ? [b.x, b.w] : [b.y, b.h];
    // Clamped: at huge coordinates a span end can round just past the box.
    const local = Math.min(Math.max(along - start, 0), length);
    const edge = getShapeSideEdge(node.kind, b.w, b.h, sideOf(end.dir), local);
    if (edge !== null) {
      across = edge + (vertical ? b.y : b.x);
      // An end deep in a slant or a wave gets a longer stub, so the first
      // turn clears the box instead of cutting back through the symbol.
      const outer = vertical
        ? end.dir.dy === 1
          ? b.y + b.h
          : b.y
        : end.dir.dx === 1
          ? b.x + b.w
          : b.x;
      end.stub = ELBOW_STUB + Math.abs(outer - across);
    }
  }
  end.point = vertical ? [along, across] : [across, along];
}

/** The box side an outward axis direction leaves by. */
function sideOf(dir: RouteDirection): ShapeSide {
  if (dir.dy === -1) return 'top';
  if (dir.dy === 1) return 'bottom';
  return dir.dx === 1 ? 'right' : 'left';
}

/**
 * Polyline a connector is drawn along: its two resolved ends, or the full
 * orthogonal route for `routing: 'elbow'`. Curved lines (cx/cy) are not
 * covered here; callers keep their quadratic path for those.
 *
 * Elbows of the scene come from routeElbows (computed once per elements
 * array). A connector that is not in `allElements` as this very object (a
 * preview being drawn, an edited copy) is routed on its own; an edited copy
 * still attached exactly like the scene's connector of that id reuses its
 * port slots and side choice.
 */
export function resolveConnectorRoute(
  el: LineElement | ArrowElement,
  allElements: ReadonlyArray<Element>,
): RoutePoint[] {
  if (el.routing !== 'elbow') {
    const pts = resolveArrowEndpoints(el, allElements);
    return [
      [pts.x, pts.y],
      [pts.x2, pts.y2],
    ];
  }
  const scene = routeElbows(allElements);
  const routed = scene.routes.get(el);
  if (routed) return routed.map((p): RoutePoint => [p[0], p[1]]);
  const original = elementsById(allElements).get(el.id);
  const same =
    original !== undefined &&
    (original.type === 'line' || original.type === 'arrow') &&
    sameAttachment(original, el);
  return finishRoute(
    {
      el,
      plan: planElbowEnds(
        el,
        allElements,
        same ? scene.sides.get(original) : undefined,
      ),
    },
    same ? scene.slots : NO_SLOTS,
  );
}

/** Whether two connectors attach to the same nodes in the same way. */
function sameAttachment(
  a: LineElement | ArrowElement,
  b: LineElement | ArrowElement,
): boolean {
  const anchor = (x: ConnectorAnchor | undefined) => (x ? `${x.x},${x.y}` : '');
  return (
    a.startElementId === b.startElementId &&
    a.endElementId === b.endElementId &&
    anchor(a.startAnchor) === anchor(b.startAnchor) &&
    anchor(a.endAnchor) === anchor(b.endAnchor)
  );
}

/** The routes of a scene's elbows and what produced them. */
interface SceneRoutes {
  readonly routes: ReadonlyMap<Element, RoutePoint[]>;
  readonly slots: ReadonlyMap<string, number>;
  /** Side pairs chosen instead of the baseline, by connector. */
  readonly sides: ReadonlyMap<Element, SidePair>;
}

const routeCache = new WeakMap<ReadonlyArray<Element>, SceneRoutes>();
const NO_SIDES: ReadonlyMap<Element, SidePair> = new Map();
const NO_SLOTS: ReadonlyMap<string, number> = new Map();

/** The route of a planned elbow once its ends sit on their slots. */
function finishRoute(
  { el, plan }: PlannedElbow,
  slots: ReadonlyMap<string, number>,
): RoutePoint[] {
  // Copies: placeAlong moves the ends, and plans may be reused.
  const s = plan.s && { ...plan.s };
  const e = plan.e && { ...plan.e };
  const startSlot = slots.get(slotKey(el.id, 'start'));
  const endSlot = slots.get(slotKey(el.id, 'end'));
  if (s && plan.startEl && startSlot !== undefined)
    placeAlong(s, plan.startEl, startSlot);
  if (e && plan.endEl && endSlot !== undefined)
    placeAlong(e, plan.endEl, endSlot);
  return computeElbowRoute(
    s?.point ?? plan.start,
    s?.dir ?? null,
    e?.point ?? plan.end,
    e?.dir ?? null,
    s?.stub,
    e?.stub,
  );
}

/** Plans, port slots and routes of every visible elbow of a scene. */
function routeScene(
  allElements: ReadonlyArray<Element>,
  sides: ReadonlyMap<Element, SidePair>,
): {
  planned: PlannedElbow[];
  slots: ReadonlyMap<string, number>;
  routes: Map<Element, RoutePoint[]>;
} {
  const planned: PlannedElbow[] = [];
  for (const el of allElements) {
    if (el.type !== 'line' && el.type !== 'arrow') continue;
    if (el.routing !== 'elbow' || el.visible === false) continue;
    planned.push({ el, plan: planElbowEnds(el, allElements, sides.get(el)) });
  }
  const steered = new Set([...sides.keys()].map((el) => el.id));
  const slots = elbowPortSlots(planned, steered);
  const routes = new Map<Element, RoutePoint[]>();
  for (const p of planned) routes.set(p.el, finishRoute(p, slots));
  return { planned, slots, routes };
}

/**
 * The nodes routes should not run through (frames and groups excluded). A
 * rotated node counts with the box around its rotated shape: wider than the
 * shape itself, so a route that clears it never cuts the real outline.
 */
function sceneObstacles(allElements: ReadonlyArray<Element>): RouteObstacle[] {
  const nodes = allElements
    .filter((el) => el.visible !== false && isRouteNodeType(el.type))
    .map((el) => {
      const box = getConnectorBox(el);
      return {
        el,
        id: el.id,
        type: el.type,
        box: el.rotation ? rotateBoxOf(el, box) : box,
      };
    });
  const containers = containerIds(nodes);
  return nodes
    .filter((n) => !containers.has(n.id))
    .map((n) => ({
      id: n.id,
      core: nodeCoreRect(n.el.rotation ? 'rectangle' : n.type, n.box),
    }));
}

/** Nodes each elbow runs through, by connector. */
function sceneCrossings(
  planned: ReadonlyArray<PlannedElbow>,
  routes: ReadonlyMap<Element, RoutePoint[]>,
  obstacles: ReadonlyArray<RouteObstacle>,
): Map<Element, string[]> {
  const crossings = new Map<Element, string[]>();
  for (const { el } of planned) {
    const ends = new Set(
      [el.startElementId, el.endElementId].filter(
        (id): id is string => id !== undefined,
      ),
    );
    const crossed = crossedObstacles(routes.get(el)!, obstacles, ends);
    if (crossed.length > 0) crossings.set(el, crossed);
  }
  return crossings;
}

/**
 * The facing side pair on the other axis, for a connector the baseline
 * routes through a node: top and bottom when it left sideways, left and
 * right when it left vertically. Only for connectors between two distinct,
 * unrotated nodes with floating ends, and only when the boxes leave room on
 * that axis for both stubs. Null otherwise.
 */
function otherAxisSides({ el, plan }: PlannedElbow): SidePair | null {
  const { startEl, endEl, s } = plan;
  if (!startEl || !endEl || !s || startEl === endEl) return null;
  if (el.startAnchor || el.endAnchor || startEl.rotation || endEl.rotation)
    return null;
  const a = getConnectorBox(startEl);
  const b = getConnectorBox(endEl);
  const dx = b.x + b.w / 2 - (a.x + a.w / 2);
  const dy = b.y + b.h / 2 - (a.y + a.h / 2);
  if (s.dir.dx !== 0) {
    if (Math.abs(dy) - (a.h + b.h) / 2 < ELBOW_STUB * 2) return null;
    return dy > 0 ? { start: 2, end: 0 } : { start: 0, end: 2 };
  }
  if (Math.abs(dx) - (a.w + b.w) / 2 < ELBOW_STUB * 2) return null;
  return dx > 0 ? { start: 1, end: 3 } : { start: 3, end: 1 };
}

/** Number of `(connector, node)` crossings. */
function crossingCount(crossings: ReadonlyMap<Element, string[]>): number {
  let count = 0;
  for (const nodes of crossings.values()) count += nodes.length;
  return count;
}

/** Whether `next` drops some node crossings of `base` and adds none. */
function isStrictSubset(
  next: ReadonlyMap<Element, string[]>,
  base: ReadonlyMap<Element, string[]>,
): boolean {
  for (const [el, nodes] of next) {
    const before = base.get(el);
    if (!before || nodes.some((node) => !before.includes(node))) return false;
  }
  return crossingCount(next) < crossingCount(base);
}

/**
 * Most side switches tried in one scene. Beyond it the scene keeps today's
 * routes: checking a batch costs time with every switch, and a board that
 * tangled is not fixed by one alternative side pair per connector.
 */
const MAX_SIDE_SWITCHES = 32;

/** Samples of a curved line drawn by its control point. */
const CURVE_SAMPLES = 12;

/** Every connector's drawn polyline, curves sampled, elbows from `routes`. */
function connectorPolylines(
  allElements: ReadonlyArray<Element>,
  routes: ReadonlyMap<Element, RoutePoint[]>,
): Map<Element, RoutePoint[]> {
  const lines = new Map<Element, RoutePoint[]>();
  for (const el of allElements) {
    if ((el.type !== 'line' && el.type !== 'arrow') || el.visible === false)
      continue;
    const routed = routes.get(el);
    if (routed) {
      lines.set(el, routed);
      continue;
    }
    const pts = resolveArrowEndpoints(el, allElements);
    if (el.type === 'line' && el.cx !== undefined && el.cy !== undefined) {
      const { cx, cy } = el;
      lines.set(
        el,
        Array.from({ length: CURVE_SAMPLES + 1 }, (_, i): RoutePoint => {
          const p = getQuadraticPoint(
            pts.x,
            pts.y,
            cx,
            cy,
            pts.x2,
            pts.y2,
            i / CURVE_SAMPLES,
          );
          return [p.x, p.y];
        }),
      );
    } else {
      lines.set(el, [
        [pts.x, pts.y],
        [pts.x2, pts.y2],
      ]);
    }
  }
  return lines;
}

/**
 * Whether segments a-b and c-d cross. A segment's start counts when it is
 * an inner vertex of its polyline (`aInner`, `cInner`), so a crossing right
 * on a vertex is seen once, while connectors meeting at their own ends
 * (on a node's border) are not crossings.
 */
function segmentsCross(
  a: RoutePoint,
  b: RoutePoint,
  c: RoutePoint,
  d: RoutePoint,
  aInner: boolean,
  cInner: boolean,
): boolean {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return false;
  const u = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den;
  const v = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
  const slack = 1e-6;
  const within = (t: number, inner: boolean) =>
    (inner ? t > -slack : t > slack) && t < 1 - slack;
  return within(u, aInner) && within(v, cInner);
}

/** Shortest shared stretch of two collinear segments that reads as one line. */
const MIN_OVERLAP = 2;

/**
 * Whether two axis-aligned segments run along the same line for a while:
 * drawn on top of each other they read as one connector.
 */
function segmentsOverlap(
  a: RoutePoint,
  b: RoutePoint,
  c: RoutePoint,
  d: RoutePoint,
): boolean {
  const vertical = (p: RoutePoint, q: RoutePoint) =>
    Math.abs(p[0] - q[0]) < 0.5;
  const horizontal = (p: RoutePoint, q: RoutePoint) =>
    Math.abs(p[1] - q[1]) < 0.5;
  let along: 0 | 1;
  if (vertical(a, b) && vertical(c, d) && Math.abs(a[0] - c[0]) < 0.5)
    along = 1;
  else if (horizontal(a, b) && horizontal(c, d) && Math.abs(a[1] - c[1]) < 0.5)
    along = 0;
  else return false;
  const lo = Math.max(
    Math.min(a[along], b[along]),
    Math.min(c[along], d[along]),
  );
  const hi = Math.min(
    Math.max(a[along], b[along]),
    Math.max(c[along], d[along]),
  );
  return hi - lo > MIN_OVERLAP;
}

/**
 * Crossings and shared stretches between the `changed` connectors and every
 * other connector.
 */
function connectorCrossings(
  lines: ReadonlyMap<Element, RoutePoint[]>,
  changed: ReadonlySet<Element>,
  limit = Infinity,
): number {
  let count = 0;
  const all = [...lines.entries()];
  for (let ia = 0; ia < all.length; ia++) {
    const [a, pa] = all[ia]!;
    if (!changed.has(a)) continue;
    for (let ib = 0; ib < all.length; ib++) {
      const [b, pb] = all[ib]!;
      // A pair of changed connectors is counted once.
      if (ib === ia || (changed.has(b) && ib < ia)) continue;
      for (let i = 1; i < pa.length; i++)
        for (let j = 1; j < pb.length; j++)
          if (
            segmentsCross(
              pa[i - 1]!,
              pa[i]!,
              pb[j - 1]!,
              pb[j]!,
              i > 1,
              j > 1,
            ) ||
            segmentsOverlap(pa[i - 1]!, pa[i]!, pb[j - 1]!, pb[j]!)
          ) {
            count++;
            // Past the limit the answer is already "worse": stop counting.
            if (count > limit) return count;
          }
    }
  }
  return count;
}

/**
 * Routes every visible elbow of a scene, once per (immutable) elements
 * array. The baseline is today's routing: side choice by free gap, ports
 * spread on shared sides, routes from their ends. A connector that runs
 * through a node may switch to the facing side pair on the other axis (a
 * fan-out leaving its hub by the bottom instead of sideways), when that
 * route alone crosses nothing. All switches are then applied together, the
 * ports spread again, and the result kept only if its node crossings are a
 * strict subset of the baseline's and the connectors whose routes changed
 * cross or run along no more connectors than before; otherwise the
 * baseline stands.
 * Scenes whose routes cross nothing are untouched, and the outcome depends
 * only on the scene, so live peers agree.
 */
function routeElbows(allElements: ReadonlyArray<Element>): SceneRoutes {
  const cached = routeCache.get(allElements);
  if (cached) return cached;
  const base = routeScene(allElements, NO_SIDES);
  let result: SceneRoutes = { ...base, sides: NO_SIDES };
  const candidates = base.planned.filter((p) => otherAxisSides(p) !== null);
  // Obstacles cost a scan of the board: skip them when nothing can switch.
  if (candidates.length > 0) {
    const obstacles = sceneObstacles(allElements);
    const baseCrossings = sceneCrossings(base.planned, base.routes, obstacles);
    const proposals = new Map<Element, SidePair>();
    for (const p of candidates) {
      if (!baseCrossings.has(p.el)) continue;
      const pair = otherAxisSides(p)!;
      const alone: PlannedElbow = {
        el: p.el,
        plan: planElbowEnds(p.el, allElements, pair),
      };
      const route = finishRoute(alone, NO_SLOTS);
      const single = sceneCrossings(
        [alone],
        new Map([[p.el, route]]),
        obstacles,
      );
      if (single.size === 0) proposals.set(p.el, pair);
    }
    if (proposals.size > 0 && proposals.size <= MAX_SIDE_SWITCHES) {
      const next = routeScene(allElements, proposals);
      const nextCrossings = sceneCrossings(
        next.planned,
        next.routes,
        obstacles,
      );
      if (isStrictSubset(nextCrossings, baseCrossings)) {
        const changed = new Set(
          next.planned
            .filter((p) => {
              const a = base.routes.get(p.el)!;
              const b = next.routes.get(p.el)!;
              return (
                a.length !== b.length ||
                a.some((pt, i) => pt[0] !== b[i]![0] || pt[1] !== b[i]![1])
              );
            })
            .map((p) => p.el),
        );
        const before = connectorCrossings(
          connectorPolylines(allElements, base.routes),
          changed,
        );
        const after = connectorCrossings(
          connectorPolylines(allElements, next.routes),
          changed,
          before,
        );
        if (after <= before) result = { ...next, sides: proposals };
      }
    }
  }
  routeCache.set(allElements, result);
  return result;
}

/**
 * Stretch of the side a connector leaves `el` by where several ends can
 * spread, along that side (x for top/bottom, y for left/right): a flat side
 * inset from rounded corners, or the stretch a flowchart symbol declares
 * (see ShapeSides), which may be slanted or curved. Null for sides with a
 * single port (ellipse, rhombus, round or pointed symbol ends) and for
 * rotated elements.
 */
function sideSpan(
  el: Element,
  dir: RouteDirection,
): readonly [number, number] | null {
  if (el.rotation) return null;
  const b = getElementBounds(el);
  const vertical = dir.dx === 0;
  if (el.type === 'shape') {
    const span = getShapeDefinition(el.kind).sides(b.w, b.h)[sideOf(dir)];
    if (!span || span[1] - span[0] < 1) return null;
    const offset = vertical ? b.x : b.y;
    return [span[0] + offset, span[1] + offset];
  }
  if (
    el.type !== 'rectangle' &&
    el.type !== 'stencil' &&
    el.type !== 'text' &&
    el.type !== 'image'
  )
    return null;
  // A stencil's bottom side is the bottom of its label.
  const side =
    el.type === 'stencil' && dir.dy === 1 ? (getStencilLabelBox(el) ?? b) : b;
  const inset = el.type === 'rectangle' ? (el.cornerRadius ?? 0) : 0;
  const [lo, hi] = vertical
    ? [side.x, side.x + side.w]
    : [side.y, side.y + side.h];
  return hi - lo > inset * 2 ? [lo + inset, hi - inset] : null;
}

/**
 * Common coordinate for two floating elbow ends leaving facing flat sides
 * whose extents overlap, so the connector runs straight instead of making a
 * small step between two nearly aligned nodes (draw.io does the same). The
 * start's center wins when it lies on the end's side, then the end's
 * center, then the middle of the overlap. Null when the sides don't face
 * each other or don't overlap.
 */
function sharedOffset(
  startEl: Element,
  startDir: RouteDirection,
  endEl: Element,
  endDir: RouteDirection,
): number | null {
  if (startDir.dx !== -endDir.dx || startDir.dy !== -endDir.dy) return null;
  const a = sideSpan(startEl, startDir);
  const b = sideSpan(endEl, endDir);
  if (!a || !b) return null;
  const lo = Math.max(a[0], b[0]);
  const hi = Math.min(a[1], b[1]);
  if (hi - lo < 1) return null;
  const vertical = startDir.dx === 0;
  const center = (el: Element) => getElementCenter(el)[vertical ? 0 : 1];
  const within = (v: number) => v >= lo && v <= hi;
  const startCenter = center(startEl);
  if (within(startCenter)) return startCenter;
  const endCenter = center(endEl);
  if (within(endCenter)) return endCenter;
  return (lo + hi) / 2;
}

/**
 * Draws the connection ports of a snap candidate; the port the connector
 * would pin to (if any) is filled.
 */
export function drawPortIndicators(
  ctx: CanvasRenderingContext2D,
  el: Element,
  viewport: Viewport,
  activeAnchor?: ConnectorAnchor,
): void {
  const ports = getElementPorts(el);
  if (ports.length === 0) return;
  ctx.save();
  ctx.resetTransform();
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  ctx.setLineDash([]);
  ctx.lineWidth = 1.5;
  const portColor = snapColor();
  const portIdle = onLightCanvas()
    ? 'rgba(255,255,255,0.9)'
    : 'rgba(0,0,0,0.6)';
  ctx.strokeStyle = portColor;
  for (const port of ports) {
    const [sx, sy] = worldToScreen(viewport, port.worldX, port.worldY);
    const isActive =
      activeAnchor !== undefined &&
      Math.abs(activeAnchor.x - port.anchor.x) < 1e-6 &&
      Math.abs(activeAnchor.y - port.anchor.y) < 1e-6;
    ctx.fillStyle = isActive ? portColor : portIdle;
    ctx.beginPath();
    ctx.arc(sx, sy, isActive ? 5 : 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/** Draws a snap indicator circle (see snapColor) at the given world-space position. */
export function drawSnapIndicator(
  ctx: CanvasRenderingContext2D,
  worldX: number,
  worldY: number,
  viewport: Viewport,
): void {
  ctx.save();
  ctx.resetTransform();
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

  const [sx, sy] = worldToScreen(viewport, worldX, worldY);
  ctx.strokeStyle = snapColor();
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.arc(sx, sy, 16, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.restore();
}

const HANDLE_SIZE = 8;
const HANDLE_HALF = HANDLE_SIZE / 2;

export const ROTATION_HANDLE_R = 7;
export const ROTATION_HANDLE_OFFSET = 34;

export type HandlePosition = 'nw' | 'n' | 'ne' | 'w' | 'e' | 'sw' | 's' | 'se';

export interface Handle {
  position: HandlePosition;
  screenX: number;
  screenY: number;
}

export function getElementBounds(
  el: Element,
  allElements?: ReadonlyArray<Element>,
): { x: number; y: number; w: number; h: number } {
  switch (el.type) {
    case 'rectangle':
    case 'ellipse':
    case 'rhombus':
    case 'shape':
    case 'stencil':
    case 'text':
    case 'image': {
      return normalizeRect(el);
    }
    case 'line':
    case 'arrow': {
      if (el.routing === 'elbow') {
        const route = resolveConnectorRoute(el, allElements ?? [el]);
        const xs = route.map((p) => p[0]);
        const ys = route.map((p) => p[1]);
        const minX = Math.min(...xs);
        const minY = Math.min(...ys);
        return {
          x: minX,
          y: minY,
          w: Math.max(...xs) - minX,
          h: Math.max(...ys) - minY,
        };
      }
      const pts = allElements ? resolveArrowEndpoints(el, allElements) : el;
      if (el.type === 'line' && el.cx !== undefined && el.cy !== undefined) {
        const bounds = getQuadraticBounds(
          pts.x,
          pts.y,
          el.cx,
          el.cy,
          pts.x2,
          pts.y2,
        );
        return {
          x: bounds.minX,
          y: bounds.minY,
          w: bounds.maxX - bounds.minX,
          h: bounds.maxY - bounds.minY,
        };
      }
      return {
        x: Math.min(pts.x, pts.x2),
        y: Math.min(pts.y, pts.y2),
        w: Math.abs(pts.x2 - pts.x),
        h: Math.abs(pts.y2 - pts.y),
      };
    }
    case 'curve': {
      // Tight bounds of quadratic bezier including control point
      const minX = Math.min(el.x, el.x2, el.cx);
      const minY = Math.min(el.y, el.y2, el.cy);
      const maxX = Math.max(el.x, el.x2, el.cx);
      const maxY = Math.max(el.y, el.y2, el.cy);
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    case 'freehand':
    case 'polygon': {
      if (el.points.length === 0) return { x: el.x, y: el.y, w: 0, h: 0 };
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const [px, py] of el.points) {
        minX = Math.min(minX, px);
        minY = Math.min(minY, py);
        maxX = Math.max(maxX, px);
        maxY = Math.max(maxY, py);
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
  }
}

/**
 * The world-space box the element covers once drawn: its bounds, turned by
 * its rotation about the center the renderer rotates it around.
 */
export function getRotatedBounds(
  el: Element,
  allElements?: ReadonlyArray<Element>,
): { x: number; y: number; w: number; h: number } {
  return rotateBoxOf(el, getElementBounds(el, allElements));
}

/**
 * The axis-aligned box around `box` once turned by the element's rotation,
 * about the element's center: the extent of something drawn with it, such as
 * the element or the element with its label.
 */
export function rotateBoxOf(
  el: Element,
  box: { x: number; y: number; w: number; h: number },
): { x: number; y: number; w: number; h: number } {
  if (!el.rotation) return box;
  const [cx, cy] = getElementCenter(el);
  const cos = Math.cos(el.rotation);
  const sin = Math.sin(el.rotation);
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [px, py] of [
    [box.x, box.y],
    [box.x + box.w, box.y],
    [box.x + box.w, box.y + box.h],
    [box.x, box.y + box.h],
  ] as const) {
    const rx = cx + (px - cx) * cos - (py - cy) * sin;
    const ry = cy + (px - cx) * sin + (py - cy) * cos;
    minX = Math.min(minX, rx);
    minY = Math.min(minY, ry);
    maxX = Math.max(maxX, rx);
    maxY = Math.max(maxY, ry);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Returns the world-space center of any element. */
export function getElementCenter(el: Element): [number, number] {
  const { x, y, w, h } = getElementBounds(el);
  return [x + w / 2, y + h / 2];
}

/**
 * Whether the selection offers a rotation handle. Not when a selected vendor
 * icon may not be rotated, nor for a lone connector: its ends already set its
 * direction, and a rotation would draw them away from where they are grabbed
 * and from the shapes they are attached to.
 */
export function canRotateSelection(elements: ReadonlyArray<Element>): boolean {
  if (elements.some((el) => el.type === 'stencil' && !isRotatableStencil(el)))
    return false;
  const only = elements.length === 1 ? elements[0]! : null;
  return !(
    only &&
    (only.type === 'line' || only.type === 'arrow' || only.type === 'curve')
  );
}

/** Returns the screen-space position of the rotation handle for the given selection, or null. */
export function getRotationHandleScreen(
  elements: ReadonlyArray<Element>,
  viewport: Viewport,
  allElements?: ReadonlyArray<Element>,
): { screenX: number; screenY: number } | null {
  if (elements.length === 0 || !canRotateSelection(elements)) return null;

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const el of elements) {
    const { x, y, w, h } = getElementBounds(el, allElements);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  }

  const [, sy] = worldToScreen(viewport, minX, minY);
  const mx =
    (worldToScreen(viewport, minX, minY)[0] +
      worldToScreen(viewport, maxX, maxY)[0]) /
    2;

  // For a single rotated element, rotate the handle position around the element center
  const rotation = elements.length === 1 ? (elements[0]!.rotation ?? 0) : 0;
  if (rotation) {
    const [cx, cy] = getElementCenter(elements[0]!);
    const [scx, scy] = worldToScreen(viewport, cx, cy);
    const dx = mx - scx;
    const dy = sy - ROTATION_HANDLE_OFFSET - scy;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    return {
      screenX: scx + dx * cos - dy * sin,
      screenY: scy + dx * sin + dy * cos,
    };
  }

  return { screenX: mx, screenY: sy - ROTATION_HANDLE_OFFSET };
}

/**
 * The rows the rotation handle covers on screen as `drawSelection` paints it,
 * in canvas pixels, or null when none is painted: a selection that cannot
 * rotate, or one holding a locked element (only its outline is drawn).
 *
 * The handle sits a fixed number of screen pixels from the box, so zoom does
 * not change its distance; for a single rotated element it turns with the
 * element about its center, so it may be beside or below the box.
 */
export function getRotationHandleSpan(
  elements: ReadonlyArray<Element>,
  viewport: Viewport,
  allElements?: ReadonlyArray<Element>,
): { top: number; bottom: number } | null {
  if (elements.some((el) => el.locked)) return null;
  const handle = getRotationHandleScreen(elements, viewport, allElements);
  if (!handle) return null;
  return {
    top: handle.screenY - ROTATION_HANDLE_R,
    bottom: handle.screenY + ROTATION_HANDLE_R,
  };
}

/**
 * Hit-test whether a screen point is on one of the endpoints of a line/arrow.
 * Returns 'start', 'end', or null.
 */
/**
 * The two ends a connector is drawn between, where its endpoint handles go:
 * an elbow's route can leave a shape from a spread port rather than from
 * the end resolveArrowEndpoints gives.
 */
export function getConnectorEnds(
  el: LineElement | ArrowElement,
  allElements: ReadonlyArray<Element>,
): { x: number; y: number; x2: number; y2: number } {
  if (el.routing !== 'elbow') return resolveArrowEndpoints(el, allElements);
  const route = resolveConnectorRoute(el, allElements);
  const [x, y] = route[0]!;
  const [x2, y2] = route[route.length - 1]!;
  return { x, y, x2, y2 };
}

export function hitTestEndpoint(
  el: Element,
  viewport: Viewport,
  screenX: number,
  screenY: number,
  allElements?: ReadonlyArray<Element>,
): 'start' | 'end' | null {
  if (el.type !== 'line' && el.type !== 'arrow') return null;
  const R = 5 + 4; // handle radius + tolerance

  const pts = allElements ? getConnectorEnds(el, allElements) : el;
  const [sx1, sy1] = worldToScreen(viewport, pts.x, pts.y);
  const [sx2, sy2] = worldToScreen(viewport, pts.x2, pts.y2);

  if (Math.hypot(screenX - sx1, screenY - sy1) <= R) return 'start';
  if (Math.hypot(screenX - sx2, screenY - sy2) <= R) return 'end';
  return null;
}

export function drawSelection(
  ctx: CanvasRenderingContext2D,
  elements: ReadonlyArray<Element>,
  viewport: Viewport,
  allElements?: ReadonlyArray<Element>,
): void {
  if (elements.length === 0) return;

  ctx.save();
  ctx.resetTransform();
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

  // Compute union bounding box in world space
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const el of elements) {
    const { x, y, w, h } = getElementBounds(el, allElements);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  }

  // For a single rotated element, rotate the entire selection in screen space
  const rotation = elements.length === 1 ? (elements[0]!.rotation ?? 0) : 0;
  if (rotation) {
    const [cx, cy] = getElementCenter(elements[0]!);
    const [scx, scy] = worldToScreen(viewport, cx, cy);
    ctx.translate(scx, scy);
    ctx.rotate(rotation);
    ctx.translate(-scx, -scy);
  }

  const [sx, sy] = worldToScreen(viewport, minX, minY);
  const [ex, ey] = worldToScreen(viewport, maxX, maxY);

  if (elements.length > 1) {
    for (const el of elements)
      drawSelectedElementOutline(ctx, el, viewport, allElements);
  }

  // Dashed selection rectangle: this light blue reads on both canvases
  ctx.strokeStyle = 'rgba(120,180,255,0.8)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 3]);
  ctx.strokeRect(sx - 1, sy - 1, ex - sx + 2, ey - sy + 2);
  ctx.setLineDash([]);

  // A locked element cannot be resized, rotated or reshaped: only the
  // outline shows it is selected (the select tool offers no handle either).
  if (elements.some((el) => el.locked)) {
    ctx.restore();
    return;
  }

  // Resize handles
  const handles = getHandlePositions(sx, sy, ex, ey);
  ctx.fillStyle = handleFill();
  ctx.strokeStyle = 'rgba(120,180,255,0.9)';
  ctx.lineWidth = 1.5;

  for (const h of handles) {
    ctx.fillRect(
      h.screenX - HANDLE_HALF,
      h.screenY - HANDLE_HALF,
      HANDLE_SIZE,
      HANDLE_SIZE,
    );
    ctx.strokeRect(
      h.screenX - HANDLE_HALF,
      h.screenY - HANDLE_HALF,
      HANDLE_SIZE,
      HANDLE_SIZE,
    );
  }

  if (canRotateSelection(elements)) {
    // Rotation handle — connector line + circle with ↻ arc indicator
    const mx = (sx + ex) / 2;
    const rotHandleY = sy - ROTATION_HANDLE_OFFSET;

    // Connector line from top-center of box to rotation handle
    ctx.strokeStyle = 'rgba(120,180,255,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(mx, sy - 1);
    ctx.lineTo(mx, rotHandleY + ROTATION_HANDLE_R);
    ctx.stroke();

    // Rotation handle circle
    ctx.strokeStyle = 'rgba(120,180,255,0.9)';
    ctx.fillStyle = handleFill();
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(mx, rotHandleY, ROTATION_HANDLE_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // ↻ arc indicator inside circle (partial arc with arrowhead)
    const arcR = ROTATION_HANDLE_R - 2.5;
    const arcStart = -0.7 * Math.PI;
    const arcEnd = 0.5 * Math.PI;
    ctx.strokeStyle = 'rgba(120,180,255,0.9)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(mx, rotHandleY, arcR, arcStart, arcEnd);
    ctx.stroke();

    // Small filled arrowhead at end of arc
    const arrowAngle = arcEnd + Math.PI / 2;
    const arrowTipX = mx + arcR * Math.cos(arcEnd);
    const arrowTipY = rotHandleY + arcR * Math.sin(arcEnd);
    const ah = 3;
    ctx.fillStyle = 'rgba(120,180,255,0.9)';
    ctx.beginPath();
    ctx.moveTo(arrowTipX, arrowTipY);
    ctx.lineTo(
      arrowTipX - ah * Math.cos(arrowAngle - Math.PI / 6),
      arrowTipY - ah * Math.sin(arrowAngle - Math.PI / 6),
    );
    ctx.lineTo(
      arrowTipX - ah * Math.cos(arrowAngle + Math.PI / 6),
      arrowTipY - ah * Math.sin(arrowAngle + Math.PI / 6),
    );
    ctx.closePath();
    ctx.fill();
  }

  // Endpoint handles for single line/arrow selection (drawn on top of bounding box handles)
  if (elements.length === 1) {
    const el = elements[0]!;
    if (el.type === 'line' || el.type === 'arrow') {
      const pts = getConnectorEnds(el, allElements ?? elements);
      const [x1s, y1s] = worldToScreen(viewport, pts.x, pts.y);
      const [x2s, y2s] = worldToScreen(viewport, pts.x2, pts.y2);

      ctx.fillStyle = snapColor();
      ctx.strokeStyle = handleFill();
      ctx.lineWidth = 1.5;

      ctx.beginPath();
      ctx.arc(x1s, y1s, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(x2s, y2s, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Midpoint control-point handle for lines
      // cx/cy set → full handle (curve active); undefined → ghost handle (drag to curve)
      // Elbow routes ignore cx/cy, so they get no curve handle.
      if (el.type === 'line' && el.routing !== 'elbow') {
        const curveActive = el.cx !== undefined && el.cy !== undefined;
        const cpX = el.cx ?? (pts.x + pts.x2) / 2;
        const cpY = el.cy ?? (pts.y + pts.y2) / 2;
        const [scpx, scpy] = worldToScreen(viewport, cpX, cpY);

        if (curveActive) {
          // Guide lines from endpoints to control point
          ctx.strokeStyle = 'rgba(180, 160, 255, 0.3)';
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(x1s, y1s);
          ctx.lineTo(scpx, scpy);
          ctx.lineTo(x2s, y2s);
          ctx.stroke();
          ctx.setLineDash([]);

          // Solid handle
          ctx.fillStyle = 'rgba(180, 160, 255, 0.9)';
          ctx.strokeStyle = handleFill();
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(scpx, scpy, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        } else {
          // Ghost handle — hint that the line can be curved
          ctx.fillStyle = 'rgba(180, 160, 255, 0.25)';
          ctx.strokeStyle = 'rgba(180, 160, 255, 0.5)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(scpx, scpy, 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
    }
  }

  ctx.restore();
}

function drawSelectedElementOutline(
  ctx: CanvasRenderingContext2D,
  element: Element,
  viewport: Viewport,
  allElements?: ReadonlyArray<Element>,
): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(120,180,255,0.85)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);

  const s = (wx: number, wy: number) => worldToScreen(viewport, wx, wy);
  const PAD = 4;

  switch (element.type) {
    case 'line':
    case 'arrow': {
      if (element.routing === 'elbow') {
        const route = resolveConnectorRoute(element, allElements ?? [element]);
        ctx.beginPath();
        traceRoundedRoute(ctx, route, s);
        ctx.stroke();
        break;
      }
      const pts = resolveArrowEndpoints(element, allElements ?? [element]);
      const [x1s, y1s] = s(pts.x, pts.y);
      const [x2s, y2s] = s(pts.x2, pts.y2);
      ctx.beginPath();
      if (
        element.type === 'line' &&
        element.cx !== undefined &&
        element.cy !== undefined
      ) {
        const [cxs, cys] = s(element.cx, element.cy);
        ctx.moveTo(x1s, y1s);
        ctx.quadraticCurveTo(cxs, cys, x2s, y2s);
      } else {
        ctx.moveTo(x1s, y1s);
        ctx.lineTo(x2s, y2s);
      }
      ctx.stroke();
      break;
    }
    case 'curve': {
      const [x1s, y1s] = s(element.x, element.y);
      const [cxs, cys] = s(element.cx, element.cy);
      const [x2s, y2s] = s(element.x2, element.y2);
      ctx.beginPath();
      ctx.moveTo(x1s, y1s);
      ctx.quadraticCurveTo(cxs, cys, x2s, y2s);
      ctx.stroke();
      break;
    }
    case 'freehand':
    case 'polygon': {
      if (element.points.length < 2) break;
      ctx.beginPath();
      const [p0x, p0y] = s(element.points[0]![0], element.points[0]![1]);
      ctx.moveTo(p0x, p0y);
      for (let i = 1; i < element.points.length; i++) {
        const [px, py] = s(element.points[i]![0], element.points[i]![1]);
        ctx.lineTo(px, py);
      }
      if (element.type === 'polygon' && element.closed) ctx.closePath();
      ctx.stroke();
      break;
    }
    case 'ellipse': {
      const { x, y, w, h } = getElementBounds(element);
      const [sx, sy] = s(x, y);
      const [ex, ey] = s(x + w, y + h);
      const rotation = element.rotation ?? 0;
      const cx = (sx + ex) / 2;
      const cy = (sy + ey) / 2;
      const rx = Math.abs(ex - sx) / 2 + PAD;
      const ry = Math.abs(ey - sy) / 2 + PAD;
      if (rotation) {
        ctx.translate(cx, cy);
        ctx.rotate(rotation);
        ctx.translate(-cx, -cy);
      }
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      break;
    }
    case 'rhombus': {
      const { x, y, w, h } = getElementBounds(element);
      const [sx, sy] = s(x, y);
      const [ex, ey] = s(x + w, y + h);
      const rotation = element.rotation ?? 0;
      const cx = (sx + ex) / 2;
      const cy = (sy + ey) / 2;
      if (rotation) {
        ctx.translate(cx, cy);
        ctx.rotate(rotation);
        ctx.translate(-cx, -cy);
      }
      ctx.beginPath();
      ctx.moveTo(cx, sy - PAD);
      ctx.lineTo(ex + PAD, cy);
      ctx.lineTo(cx, ey + PAD);
      ctx.lineTo(sx - PAD, cy);
      ctx.closePath();
      break;
    }
    default: {
      const { x, y, w, h } = getElementBounds(element);
      const [sx, sy] = s(x, y);
      const [ex, ey] = s(x + w, y + h);
      const rotation = element.rotation ?? 0;
      if (rotation) {
        const [cx, cy] = getElementCenter(element);
        const [scx, scy] = s(cx, cy);
        ctx.translate(scx, scy);
        ctx.rotate(rotation);
        ctx.translate(-scx, -scy);
      }
      ctx.strokeRect(sx - PAD, sy - PAD, ex - sx + PAD * 2, ey - sy + PAD * 2);
      break;
    }
  }

  if (
    element.type !== 'line' &&
    element.type !== 'arrow' &&
    element.type !== 'curve' &&
    element.type !== 'freehand' &&
    element.type !== 'polygon' &&
    element.type !== 'rectangle' &&
    element.type !== 'shape' &&
    element.type !== 'stencil' &&
    element.type !== 'text' &&
    element.type !== 'image'
  ) {
    ctx.stroke();
  }

  ctx.restore();
}

/** Draws a faint highlight border around a hovered (but not selected) element. */
export function drawHoverHighlight(
  ctx: CanvasRenderingContext2D,
  element: Element,
  viewport: Viewport,
  allElements?: ReadonlyArray<Element>,
): void {
  ctx.save();
  ctx.resetTransform();
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

  ctx.strokeStyle = 'rgba(120, 180, 255, 0.55)';
  ctx.lineWidth = 2;
  ctx.setLineDash([]);

  const s = (wx: number, wy: number) => worldToScreen(viewport, wx, wy);

  switch (element.type) {
    case 'line':
    case 'arrow': {
      // Follow the connector as rendered: ends resolved against the shapes
      // they are bound to, and the full route for elbow connectors.
      const all = allElements ?? [element];
      ctx.beginPath();
      if (
        element.type === 'line' &&
        element.routing !== 'elbow' &&
        element.cx !== undefined &&
        element.cy !== undefined
      ) {
        const pts = resolveArrowEndpoints(element, all);
        const [x1s, y1s] = s(pts.x, pts.y);
        const [x2s, y2s] = s(pts.x2, pts.y2);
        const [cxs, cys] = s(element.cx, element.cy);
        ctx.moveTo(x1s, y1s);
        ctx.quadraticCurveTo(cxs, cys, x2s, y2s);
      } else {
        traceRoundedRoute(ctx, resolveConnectorRoute(element, all), s);
      }
      ctx.stroke();
      break;
    }
    case 'curve': {
      const [x1s, y1s] = s(element.x, element.y);
      const [cxs, cys] = s(element.cx, element.cy);
      const [x2s, y2s] = s(element.x2, element.y2);
      ctx.beginPath();
      ctx.moveTo(x1s, y1s);
      ctx.quadraticCurveTo(cxs, cys, x2s, y2s);
      ctx.stroke();
      break;
    }
    case 'freehand':
    case 'polygon': {
      if (element.points.length < 2) break;
      ctx.beginPath();
      const [p0x, p0y] = s(element.points[0]![0], element.points[0]![1]);
      ctx.moveTo(p0x, p0y);
      for (let i = 1; i < element.points.length; i++) {
        const [px, py] = s(element.points[i]![0], element.points[i]![1]);
        ctx.lineTo(px, py);
      }
      if (element.type === 'polygon' && element.closed) ctx.closePath();
      ctx.stroke();
      break;
    }
    default: {
      // Rectangular elements: draw a padded rect (with rotation if needed)
      const { x, y, w, h } = getElementBounds(element);
      const [sx, sy] = s(x, y);
      const [ex, ey] = s(x + w, y + h);

      const rotation = element.rotation ?? 0;
      if (rotation) {
        const [cx, cy] = getElementCenter(element);
        const [scx, scy] = s(cx, cy);
        ctx.translate(scx, scy);
        ctx.rotate(rotation);
        ctx.translate(-scx, -scy);
      }

      ctx.strokeRect(sx - 2, sy - 2, ex - sx + 4, ey - sy + 4);
      break;
    }
  }

  ctx.restore();
}

export function drawMarquee(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): void {
  ctx.save();
  ctx.resetTransform();
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  ctx.strokeStyle = 'rgba(120,180,255,0.7)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 2]);
  ctx.fillStyle = 'rgba(120, 180, 255, 0.06)';
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const w = Math.abs(x2 - x1);
  const h = Math.abs(y2 - y1);
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
  ctx.restore();
}

function getHandlePositions(
  sx: number,
  sy: number,
  ex: number,
  ey: number,
): Handle[] {
  const mx = (sx + ex) / 2;
  const my = (sy + ey) / 2;
  return [
    { position: 'nw', screenX: sx, screenY: sy },
    { position: 'n', screenX: mx, screenY: sy },
    { position: 'ne', screenX: ex, screenY: sy },
    { position: 'w', screenX: sx, screenY: my },
    { position: 'e', screenX: ex, screenY: my },
    { position: 'sw', screenX: sx, screenY: ey },
    { position: 's', screenX: mx, screenY: ey },
    { position: 'se', screenX: ex, screenY: ey },
  ];
}

/** Computes the 8 handle positions for the current selection in CSS-pixel screen space. */
export function getSelectionHandles(
  elements: ReadonlyArray<Element>,
  viewport: Viewport,
  allElements?: ReadonlyArray<Element>,
): Handle[] {
  if (elements.length === 0) return [];
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const el of elements) {
    const { x, y, w, h } = getElementBounds(el, allElements);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  }
  const [sx, sy] = worldToScreen(viewport, minX, minY);
  const [ex, ey] = worldToScreen(viewport, maxX, maxY);
  const handles = getHandlePositions(sx, sy, ex, ey);

  // Rotate handle positions for a single rotated element
  const rotation = elements.length === 1 ? (elements[0]!.rotation ?? 0) : 0;
  if (rotation) {
    const [cx, cy] = getElementCenter(elements[0]!);
    const [scx, scy] = worldToScreen(viewport, cx, cy);
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    for (const h of handles) {
      const dx = h.screenX - scx;
      const dy = h.screenY - scy;
      h.screenX = scx + dx * cos - dy * sin;
      h.screenY = scy + dx * sin + dy * cos;
    }
  }

  return handles;
}

export function hitTestHandle(
  handles: Handle[],
  screenX: number,
  screenY: number,
  tolerance = 8,
): HandlePosition | null {
  for (const h of handles) {
    if (
      screenX >= h.screenX - HANDLE_HALF - tolerance &&
      screenX <= h.screenX + HANDLE_HALF + tolerance &&
      screenY >= h.screenY - HANDLE_HALF - tolerance &&
      screenY <= h.screenY + HANDLE_HALF + tolerance
    ) {
      return h.position;
    }
  }
  return null;
}

export function drawAlignGuides(
  ctx: CanvasRenderingContext2D,
  guides: Array<{ axis: 'x' | 'y'; worldPos: number }>,
  viewport: Viewport,
  canvasWidth: number,
  canvasHeight: number,
): void {
  if (guides.length === 0) return;
  const dpr = window.devicePixelRatio;
  ctx.save();
  ctx.resetTransform();
  ctx.strokeStyle = '#4d96ff';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.globalAlpha = 0.85;

  for (const guide of guides) {
    const [sx, sy] = worldToScreen(viewport, guide.worldPos, guide.worldPos);
    ctx.beginPath();
    if (guide.axis === 'x') {
      const px = sx * dpr;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, canvasHeight);
    } else {
      const py = sy * dpr;
      ctx.moveTo(0, py);
      ctx.lineTo(canvasWidth, py);
    }
    ctx.stroke();
  }

  ctx.restore();
}
