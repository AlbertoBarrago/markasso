import { measureTextBlock, wrapTextLines } from '../../src/core/text_metrics';
import type { ShapeKind } from '../../src/elements/element';
import {
  DEFAULT_LABEL_FONT_FAMILY,
  DEFAULT_SHAPE_LABEL_FONT_SIZE,
} from '../../src/elements/label_defaults';
import {
  getLabelWrapWidth,
  getShapeTextBox,
  LABEL_INSET,
  type LabeledShape,
  ROUND_LABEL_AREA,
} from '../../src/rendering/shape_geometry';

/**
 * Node sizes derived from their labels, measured with the same metrics and
 * wrap width (`getLabelWrapWidth`) the app draws with, so a node created
 * without width/height always fits its text.
 */

/** Breathing room around the text block inside a shape, at the default size. */
const PAD = 24;
/** Widest auto-sized node at the default size; both scale with the font. */
const MAX_W = 320;
const MAX_H = 4000;

export interface Size {
  readonly w: number;
  readonly h: number;
}

type SizedKind = 'rectangle' | 'ellipse' | 'rhombus' | ShapeKind;

function labeledShape(kind: SizedKind, fontSize: number): LabeledShape {
  return kind === 'rectangle' || kind === 'ellipse' || kind === 'rhombus'
    ? { type: kind, labelFontSize: fontSize }
    : { type: 'shape', kind, labelFontSize: fontSize };
}

/** Width of the label's widest explicit line. */
function naturalWidth(label: string, fontSize: number): number {
  return measureTextBlock(
    label.split('\n'),
    fontSize,
    DEFAULT_LABEL_FONT_FAMILY,
  ).width;
}

/** Text block of a label wrapped to `maxWidth`, breaking words like the app. */
function block(label: string, maxWidth: number, fontSize: number): Size {
  const lines = wrapTextLines(
    label,
    maxWidth,
    fontSize,
    DEFAULT_LABEL_FONT_FAMILY,
    false,
    true,
  );
  const { width, height } = measureTextBlock(
    lines,
    fontSize,
    DEFAULT_LABEL_FONT_FAMILY,
  );
  return { w: width, h: height };
}

const clamp = (n: number, min: number, max: number) =>
  Math.min(max, Math.max(min, n));

/**
 * Smallest comfortable size for a labeled node: as wide as the text up to
 * the maximum width (then wrapped), at least the default size, tall enough
 * for the wrapped lines inside the shape's text area. Padding and maximum
 * width grow with a larger font, so a big title stays on one line.
 */
export function sizeForLabel(
  kind: SizedKind,
  label: string,
  defaults: Size,
  fontSize: number = DEFAULT_SHAPE_LABEL_FONT_SIZE,
): Size {
  const scale = Math.max(1, fontSize / DEFAULT_SHAPE_LABEL_FONT_SIZE);
  const pad = PAD * scale;
  const maxW = MAX_W * scale;
  const shape = labeledShape(kind, fontSize);
  const text = naturalWidth(label, fontSize);
  if (kind === 'rectangle') {
    const w = Math.ceil(clamp(text + pad * 2, defaults.w, maxW));
    const b = block(label, getLabelWrapWidth(shape, w, defaults.h), fontSize);
    return { w, h: Math.ceil(Math.max(defaults.h, b.h + pad)) };
  }
  if (kind === 'ellipse' || kind === 'rhombus') {
    const w = Math.ceil(
      clamp(
        (text + LABEL_INSET) / ROUND_LABEL_AREA + pad,
        defaults.w,
        maxW * 1.25,
      ),
    );
    const b = block(label, getLabelWrapWidth(shape, w, defaults.h), fontSize);
    // Height at which the text block's corners touch the outline:
    // ellipse (x/rx)^2 + (y/ry)^2 = 1, rhombus |x|/hw + |y|/hh = 1.
    const across = Math.min(0.95, (b.w + 8) / w);
    const h =
      kind === 'ellipse'
        ? (b.h + 8) / Math.sqrt(1 - across * across)
        : (b.h + 8) / (1 - across);
    return { w, h: Math.ceil(clamp(h, defaults.h, MAX_H)) };
  }
  // Flowchart symbols. Text boxes are not proportional to the symbol (a
  // merge triangle's is half its width, multiple documents lose their
  // sheet offsets, which grow with the short side), so the width is found
  // by bisection: the narrowest one, from the default up, whose text box
  // wraps as wide as the label needs. Then the height grows until the
  // wrapped block fits, and the width is checked again at that height.
  const wrapAt = (w: number, h: number) => getLabelWrapWidth(shape, w, h);
  const cap = Math.ceil(maxW * 1.5);
  const target = Math.min(text, maxW - pad * 2);
  const narrowest = (h: number, from: number): number => {
    if (wrapAt(from, h) >= target) return from;
    if (wrapAt(cap, h) < target) return cap;
    let lo = from;
    let hi = cap;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (wrapAt(mid, h) >= target) hi = mid;
      else lo = mid;
    }
    return hi;
  };
  const fitHeight = (w: number): number => {
    let h = defaults.h;
    for (;;) {
      const b = block(label, wrapAt(w, h), fontSize);
      if (h >= MAX_H || getShapeTextBox(kind, w, h).h >= b.h + 8) return h;
      h += 10;
    }
  };
  let w = narrowest(defaults.h, Math.ceil(defaults.w));
  let h = fitHeight(w);
  // A taller box can narrow the text box (multiple documents): widen until
  // the label wraps as at the default height again.
  for (let i = 0; i < 3 && w < cap; i++) {
    const wider = narrowest(h, w);
    if (wider === w) break;
    w = wider;
    h = fitHeight(w);
  }
  return { w, h };
}

/** Size of a text node: its content, unwrapped. */
export function sizeForText(content: string, fontSize: number): Size {
  const { width, height } = measureTextBlock(
    content.split('\n'),
    fontSize,
    DEFAULT_LABEL_FONT_FAMILY,
  );
  // A few pixels of slack: the app never wraps a line that fits exactly.
  return { w: Math.ceil(width) + 4, h: Math.ceil(height) };
}
