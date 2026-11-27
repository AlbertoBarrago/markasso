import { type AnyShapeKind, isShapeKind, type ShapeKind } from './element';

/**
 * Path commands in shape-local coordinates, where (0, 0) is the top-left
 * corner of the normalized bounding box and (w, h) the bottom-right one.
 * Only absolute move/line/cubic/close are used so the same data can drive
 * Canvas 2D, SVG export and the polygonal approximation used for hit/snap math.
 */
export type ShapeCommand =
  | readonly ['M', number, number]
  | readonly ['L', number, number]
  | readonly ['C', number, number, number, number, number, number]
  | readonly ['Z'];

export interface ShapeBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export type ShapeSide = 'top' | 'right' | 'bottom' | 'left';

/**
 * For each side, the stretch where several elbow connector ends can attach
 * spread out, in shape-local coordinates along that side (x for top and
 * bottom, y for left and right), or null to keep a single middle port. The
 * stretch may be slanted or curved: ends are placed on the outline there.
 * On a round cap or a point, only its middle half is used, where the
 * outline still faces the side.
 */
export type ShapeSides = Readonly<
  Record<ShapeSide, readonly [number, number] | null>
>;

export interface ShapeDefinition {
  /** Closed outline: filled, stroked, and used for connector snapping. */
  outline(w: number, h: number): ShapeCommand[];
  /** Where connector ends may spread on each side (see ShapeSides). */
  sides(w: number, h: number): ShapeSides;
  /** Inner strokes that are drawn but never filled (e.g. cylinder rim). */
  details?(w: number, h: number): ShapeCommand[];
  /** Area where the label is laid out, in shape-local coordinates. */
  textBox(w: number, h: number): ShapeBox;
  /**
   * Size a new symbol gets when inserted, for symbols that read badly at
   * the common 160 x 80 (a square off-page connector, a merge triangle).
   */
  insertSize?: { readonly w: number; readonly h: number };
}

/** Cubic bezier constant approximating a quarter circle. */
export const CUBIC_CIRCLE_K = 0.5523;
const K = CUBIC_CIRCLE_K;

/**
 * Quarter-ellipse arc from (x0, y0) to (x1, y1) that leaves the start point
 * along `startAxis`. Two of them make each half-ellipse cap below.
 */
function quarter(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  startAxis: 'x' | 'y',
): ShapeCommand {
  return startAxis === 'x'
    ? ['C', x0 + (x1 - x0) * K, y0, x1, y1 - (y1 - y0) * K, x1, y1]
    : ['C', x0, y0 + (y1 - y0) * K, x1 - (x1 - x0) * K, y1, x1, y1];
}

/** Middle half of `0..length`: the usable part of a cap or a point. */
function middleHalf(length: number): readonly [number, number] {
  return [length * 0.25, length * 0.75];
}

/**
 * How far each sheet of the multiple documents symbol sits behind the
 * next: 8% of the short side, but at least 2 units (without exceeding 20%)
 * so the sheets stay apart in a 16 px icon too.
 */
function sheetOffset(w: number, h: number): number {
  const short = Math.min(w, h);
  return Math.min(Math.max(short * 0.08, 2), short * 0.2);
}

/** Every side usable along its full length. */
function allSides(w: number, h: number): ShapeSides {
  return { top: [0, w], right: [0, h], bottom: [0, w], left: [0, h] };
}

function rectCommands(w: number, h: number): ShapeCommand[] {
  return [['M', 0, 0], ['L', w, 0], ['L', w, h], ['L', 0, h], ['Z']];
}

export const SHAPE_DEFINITIONS: Readonly<Record<ShapeKind, ShapeDefinition>> = {
  // Start/end: stadium with half-circle caps.
  terminator: {
    outline(w, h) {
      const r = Math.min(w / 2, h / 2);
      return [
        ['M', r, 0],
        ['L', w - r, 0],
        quarter(w - r, 0, w, h / 2, 'x'),
        quarter(w, h / 2, w - r, h, 'y'),
        ['L', r, h],
        quarter(r, h, 0, h / 2, 'x'),
        quarter(0, h / 2, r, 0, 'y'),
        ['Z'],
      ];
    },
    // Flat between the round ends; on the ends, their middle half. A short
    // or circular terminator has (almost) no flat top: the middle half of
    // its width, on the curve, is used instead.
    sides(w, h) {
      const r = Math.min(w / 2, h / 2);
      const flat: readonly [number, number] =
        w - 2 * r >= w * 0.5 ? [r, w - r] : middleHalf(w);
      return {
        top: flat,
        right: middleHalf(h),
        bottom: flat,
        left: middleHalf(h),
      };
    },
    textBox(w, h) {
      const r = Math.min(w / 2, h / 2);
      return { x: r * 0.4, y: 0, w: Math.max(0, w - r * 0.8), h };
    },
  },

  // Input/output: parallelogram leaning right.
  data: {
    outline(w, h) {
      const s = Math.min(w * 0.2, h * 0.5);
      return [['M', s, 0], ['L', w, 0], ['L', w - s, h], ['L', 0, h], ['Z']];
    },
    // The slanted sides take ends too, placed on the slant.
    sides(w, h) {
      const s = Math.min(w * 0.2, h * 0.5);
      return { top: [s, w], right: [0, h], bottom: [0, w - s], left: [0, h] };
    },
    textBox(w, h) {
      const s = Math.min(w * 0.2, h * 0.5);
      return { x: s, y: 0, w: Math.max(0, w - s * 2), h };
    },
  },

  // Document: rectangle with a wavy bottom edge.
  document: {
    outline(w, h) {
      const a = h * 0.1;
      const base = h - a;
      return [
        ['M', 0, 0],
        ['L', w, 0],
        ['L', w, base],
        ['C', (w * 2) / 3, base - a * 1.8, w / 3, base + a * 1.8, 0, base],
        ['Z'],
      ];
    },
    // Ends on the bottom sit on the wave.
    sides(w, h) {
      const base = h - h * 0.1;
      return { top: [0, w], right: [0, base], bottom: [0, w], left: [0, base] };
    },
    textBox(w, h) {
      return { x: 0, y: 0, w, h: h * 0.82 };
    },
  },

  // Database: vertical cylinder, the visible front of the top rim is a detail.
  database: {
    outline(w, h) {
      const ry = Math.min(h * 0.15, w * 0.25);
      return [
        ['M', 0, ry],
        quarter(0, ry, w / 2, 0, 'y'),
        quarter(w / 2, 0, w, ry, 'x'),
        ['L', w, h - ry],
        quarter(w, h - ry, w / 2, h, 'y'),
        quarter(w / 2, h, 0, h - ry, 'x'),
        ['Z'],
      ];
    },
    // Straight walls; on the rims, their middle half.
    sides(w, h) {
      const ry = Math.min(h * 0.15, w * 0.25);
      return {
        top: middleHalf(w),
        right: [ry, h - ry],
        bottom: middleHalf(w),
        left: [ry, h - ry],
      };
    },
    details(w, h) {
      const ry = Math.min(h * 0.15, w * 0.25);
      return [
        ['M', 0, ry],
        quarter(0, ry, w / 2, ry * 2, 'y'),
        quarter(w / 2, ry * 2, w, ry, 'x'),
      ];
    },
    textBox(w, h) {
      const ry = Math.min(h * 0.15, w * 0.25);
      return { x: 0, y: ry * 2, w, h: Math.max(0, h - ry * 3) };
    },
  },

  // Predefined process (subroutine): rectangle with two inner side bars.
  predefinedProcess: {
    outline: rectCommands,
    sides: allSides,
    details(w, h) {
      const d = Math.min(w * 0.1, 16);
      return [
        ['M', d, 0],
        ['L', d, h],
        ['M', w - d, 0],
        ['L', w - d, h],
      ];
    },
    textBox(w, h) {
      const d = Math.min(w * 0.1, 16);
      return { x: d, y: 0, w: Math.max(0, w - d * 2), h };
    },
  },

  // Preparation: elongated hexagon.
  preparation: {
    outline(w, h) {
      const s = Math.min(w * 0.2, h * 0.5);
      return [
        ['M', s, 0],
        ['L', w - s, 0],
        ['L', w, h / 2],
        ['L', w - s, h],
        ['L', s, h],
        ['L', 0, h / 2],
        ['Z'],
      ];
    },
    // On the pointed ends, their middle half.
    sides(w, h) {
      const s = Math.min(w * 0.2, h * 0.5);
      return {
        top: [s, w - s],
        right: middleHalf(h),
        bottom: [s, w - s],
        left: middleHalf(h),
      };
    },
    textBox(w, h) {
      const s = Math.min(w * 0.2, h * 0.5);
      return { x: s * 0.6, y: 0, w: Math.max(0, w - s * 1.2), h };
    },
  },

  // Manual input: quadrilateral with the top edge sloping up to the right.
  manualInput: {
    outline(w, h) {
      const t = h * 0.25;
      return [['M', 0, t], ['L', w, 0], ['L', w, h], ['L', 0, h], ['Z']];
    },
    // Ends on the sloping top sit on the slope.
    sides(w, h) {
      return {
        top: [0, w],
        right: [0, h],
        bottom: [0, w],
        left: [h * 0.25, h],
      };
    },
    textBox(w, h) {
      const t = h * 0.25;
      return { x: 0, y: t, w, h: h - t };
    },
  },

  // Delay: rectangle whose right side is a half ellipse ("D" shape).
  delay: {
    outline(w, h) {
      const r = Math.min(w / 2, h / 2);
      return [
        ['M', 0, 0],
        ['L', w - r, 0],
        quarter(w - r, 0, w, h / 2, 'x'),
        quarter(w, h / 2, w - r, h, 'y'),
        ['L', 0, h],
        ['Z'],
      ];
    },
    // On the round right side, its middle half.
    sides(w, h) {
      const r = Math.min(w / 2, h / 2);
      return {
        top: [0, w - r],
        right: middleHalf(h),
        bottom: [0, w - r],
        left: [0, h],
      };
    },
    textBox(w, h) {
      const r = Math.min(w / 2, h / 2);
      return { x: 0, y: 0, w: Math.max(0, w - r * 0.4), h };
    },
  },

  // ISO 5807 symbols added in 1.29 (appended: kind order is stable).

  // Manual operation: trapezoid narrowing downward.
  manualOperation: {
    outline(w, h) {
      const s = Math.min(w * 0.2, h * 0.5);
      return [['M', 0, 0], ['L', w, 0], ['L', w - s, h], ['L', s, h], ['Z']];
    },
    // The slanted sides take ends too, placed on the slant.
    sides(w, h) {
      const s = Math.min(w * 0.2, h * 0.5);
      return { top: [0, w], right: [0, h], bottom: [s, w - s], left: [0, h] };
    },
    textBox(w, h) {
      const s = Math.min(w * 0.2, h * 0.5);
      return { x: s, y: 0, w: Math.max(0, w - s * 2), h };
    },
  },

  // Display: pointed left end, round right end.
  display: {
    outline(w, h) {
      const s = Math.min(w * 0.15, h * 0.5);
      return [
        ['M', s, 0],
        ['L', w - s, 0],
        quarter(w - s, 0, w, h / 2, 'x'),
        quarter(w, h / 2, w - s, h, 'y'),
        ['L', s, h],
        ['L', 0, h / 2],
        ['Z'],
      ];
    },
    // Flat top and bottom; on the point and the cap, their middle half.
    sides(w, h) {
      const s = Math.min(w * 0.15, h * 0.5);
      return {
        top: [s, w - s],
        right: middleHalf(h),
        bottom: [s, w - s],
        left: middleHalf(h),
      };
    },
    // Between the point and the cap, so its corners stay inside.
    textBox(w, h) {
      const s = Math.min(w * 0.15, h * 0.5);
      return { x: s, y: 0, w: Math.max(0, w - s * 2), h };
    },
  },

  // Off-page connector: a box ending in a point, the flow continues on
  // another page.
  offPageConnector: {
    outline(w, h) {
      const p = Math.min(h * 0.35, w * 0.5);
      return [
        ['M', 0, 0],
        ['L', w, 0],
        ['L', w, h - p],
        ['L', w / 2, h],
        ['L', 0, h - p],
        ['Z'],
      ];
    },
    sides(w, h) {
      const p = Math.min(h * 0.35, w * 0.5);
      return {
        top: [0, w],
        right: [0, h - p],
        bottom: middleHalf(w),
        left: [0, h - p],
      };
    },
    textBox(w, h) {
      const p = Math.min(h * 0.35, w * 0.5);
      return { x: 0, y: 0, w, h: Math.max(0, h - p) };
    },
    insertSize: { w: 80, h: 80 },
  },

  // Stored data: convex left side, concave right side.
  storedData: {
    outline(w, h) {
      const s = Math.min(w * 0.12, h * 0.35);
      return [
        ['M', s, 0],
        ['L', w, 0],
        // One curve for the concave side, s deep at mid height: leaving the
        // corners steeply keeps the outline star-shaped around its center
        // (two quarter arcs would leave them flat and form pockets).
        ['C', w - (s * 4) / 3, h / 3, w - (s * 4) / 3, (h * 2) / 3, w, h],
        ['L', s, h],
        quarter(s, h, 0, h / 2, 'x'),
        quarter(0, h / 2, s, 0, 'y'),
        ['Z'],
      ];
    },
    // Flat top and bottom; on both curved sides, their middle half.
    sides(w, h) {
      const s = Math.min(w * 0.12, h * 0.35);
      return {
        top: [s, w],
        right: middleHalf(h),
        bottom: [s, w],
        left: middleHalf(h),
      };
    },
    textBox(w, h) {
      const s = Math.min(w * 0.12, h * 0.35);
      return { x: s, y: 0, w: Math.max(0, w - s * 2), h };
    },
  },

  // Internal storage: a box with a top band and a left band.
  internalStorage: {
    outline: rectCommands,
    sides: allSides,
    details(w, h) {
      const d = Math.min(w * 0.1, h * 0.2, 16);
      return [
        ['M', d, 0],
        ['L', d, h],
        ['M', 0, d],
        ['L', w, d],
      ];
    },
    textBox(w, h) {
      const d = Math.min(w * 0.1, h * 0.2, 16);
      return { x: d, y: d, w: Math.max(0, w - d), h: Math.max(0, h - d) };
    },
  },

  // Multiple documents: three stacked sheets as one silhouette, the front
  // one with the document's wavy bottom; the hidden sheet edges are details.
  multiDocument: {
    outline(w, h) {
      const o = sheetOffset(w, h);
      const fw = w - 2 * o;
      const a = (h - 2 * o) * 0.1;
      const base = h - a;
      return [
        ['M', 0, 2 * o],
        ['L', o, 2 * o],
        ['L', o, o],
        ['L', 2 * o, o],
        ['L', 2 * o, 0],
        ['L', w, 0],
        ['L', w, base - 2 * o],
        ['L', w - o, base - 2 * o],
        ['L', w - o, base - o],
        ['L', fw, base - o],
        ['L', fw, base],
        ['C', (fw * 2) / 3, base - a * 1.8, fw / 3, base + a * 1.8, 0, base],
        ['Z'],
      ];
    },
    details(w, h) {
      const o = sheetOffset(w, h);
      const fw = w - 2 * o;
      const base = h - (h - 2 * o) * 0.1;
      return [
        ['M', o, 2 * o],
        ['L', fw, 2 * o],
        ['L', fw, base - o],
        ['M', 2 * o, o],
        ['L', w - o, o],
        ['L', w - o, base - 2 * o],
      ];
    },
    sides(w, h) {
      const o = sheetOffset(w, h);
      const base = h - (h - 2 * o) * 0.1;
      return {
        top: [2 * o, w],
        right: [0, base - 2 * o],
        bottom: [0, w - 2 * o],
        left: [2 * o, base],
      };
    },
    textBox(w, h) {
      const o = sheetOffset(w, h);
      return { x: 0, y: 2 * o, w: w - 2 * o, h: (h - 2 * o) * 0.82 };
    },
  },

  // Merge: a triangle pointing down.
  merge: {
    outline(w, h) {
      return [['M', 0, 0], ['L', w, 0], ['L', w / 2, h], ['Z']];
    },
    // The flat top; at the bottom point, its middle half.
    sides(w) {
      return { top: [0, w], right: null, bottom: middleHalf(w), left: null };
    },
    textBox(w, h) {
      return { x: w * 0.25, y: 0, w: w * 0.5, h: h * 0.5 };
    },
    insertSize: { w: 100, h: 80 },
  },

  // Loop limit, start: top corners cut. A pair with loopEnd, since shapes
  // cannot be flipped and rotating would turn the label upside down.
  loopStart: {
    outline(w, h) {
      const c = Math.min(w * 0.2, h * 0.3);
      return [
        ['M', c, 0],
        ['L', w - c, 0],
        ['L', w, c],
        ['L', w, h],
        ['L', 0, h],
        ['L', 0, c],
        ['Z'],
      ];
    },
    sides(w, h) {
      const c = Math.min(w * 0.2, h * 0.3);
      return { top: [c, w - c], right: [c, h], bottom: [0, w], left: [c, h] };
    },
    // Its top corners sit on the cut edges, so the box stays inside.
    textBox(w, h) {
      const c = Math.min(w * 0.2, h * 0.3);
      return {
        x: c / 2,
        y: c / 2,
        w: Math.max(0, w - c),
        h: Math.max(0, h - c / 2),
      };
    },
  },

  // Loop limit, end: bottom corners cut.
  loopEnd: {
    outline(w, h) {
      const c = Math.min(w * 0.2, h * 0.3);
      return [
        ['M', 0, 0],
        ['L', w, 0],
        ['L', w, h - c],
        ['L', w - c, h],
        ['L', c, h],
        ['L', 0, h - c],
        ['Z'],
      ];
    },
    sides(w, h) {
      const c = Math.min(w * 0.2, h * 0.3);
      return {
        top: [0, w],
        right: [0, h - c],
        bottom: [c, w - c],
        left: [0, h - c],
      };
    },
    // Its bottom corners sit on the cut edges, so the box stays inside.
    textBox(w, h) {
      const c = Math.min(w * 0.2, h * 0.3);
      return {
        x: c / 2,
        y: 0,
        w: Math.max(0, w - c),
        h: Math.max(0, h - c / 2),
      };
    },
  },
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Serializes shape commands to SVG path data, offset by (ox, oy). */
export function shapeCommandsToPathData(
  commands: ReadonlyArray<ShapeCommand>,
  ox: number,
  oy: number,
): string {
  return commands
    .map((cmd) => {
      if (cmd[0] === 'Z') return 'Z';
      if (cmd[0] === 'C') {
        return `C ${round2(cmd[1] + ox)} ${round2(cmd[2] + oy)} ${round2(cmd[3] + ox)} ${round2(cmd[4] + oy)} ${round2(cmd[5] + ox)} ${round2(cmd[6] + oy)}`;
      }
      return `${cmd[0]} ${round2(cmd[1] + ox)} ${round2(cmd[2] + oy)}`;
    })
    .join(' ');
}

/**
 * Stand-in for a kind this version does not know (written by a newer one):
 * a plain rectangle, so the element stays visible, selectable and
 * connectable until the app is updated.
 */
const UNKNOWN_SHAPE: ShapeDefinition = {
  outline: rectCommands,
  sides: allSides,
  textBox: (w, h) => ({ x: 0, y: 0, w, h }),
};

/** The geometry of a kind, or the rectangle stand-in for an unknown one. */
export function getShapeDefinition(kind: AnyShapeKind): ShapeDefinition {
  return isShapeKind(kind) ? SHAPE_DEFINITIONS[kind] : UNKNOWN_SHAPE;
}
