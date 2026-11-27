import {
  type AnyShapeKind,
  isShapeKind,
  type ShapeKind,
} from '../elements/element';
import {
  getShapeDefinition,
  shapeCommandsToPathData,
} from '../elements/shapes';

/** i18n key of each flowchart kind's display name. */
export const SHAPE_KIND_LABEL_KEYS: Readonly<Record<ShapeKind, string>> = {
  terminator: 'shapeTerminator',
  data: 'shapeData',
  document: 'shapeDocument',
  database: 'shapeDatabase',
  predefinedProcess: 'shapePredefinedProcess',
  preparation: 'shapePreparation',
  manualInput: 'shapeManualInput',
  delay: 'shapeDelay',
  manualOperation: 'shapeManualOperation',
  display: 'shapeDisplay',
  offPageConnector: 'shapeOffPageConnector',
  storedData: 'shapeStoredData',
  internalStorage: 'shapeInternalStorage',
  multiDocument: 'shapeMultiDocument',
  merge: 'shapeMerge',
  loopStart: 'shapeLoopStart',
  loopEnd: 'shapeLoopEnd',
};

/** i18n key of a kind's name; kinds from a newer version share one. */
export function shapeKindLabelKey(kind: AnyShapeKind): string {
  return isShapeKind(kind) ? SHAPE_KIND_LABEL_KEYS[kind] : 'shapeUnknown';
}

/**
 * Toolbar/menu icon for a flowchart kind, generated from the same geometry
 * the canvas renders so icons can never drift from the actual shapes.
 */
export function shapeKindIcon(kind: AnyShapeKind, size = 18): string {
  const def = getShapeDefinition(kind);
  // Shape box inside the 20x20 viewBox: wide by default, taller for the
  // database, and the insert proportions for symbols that declare them.
  const insert = def.insertSize;
  const [w, h] =
    kind === 'database'
      ? [12, 15]
      : insert
        ? fitBox(insert.w, insert.h, 16, 14)
        : [16, 11];
  const ox = (20 - w) / 2;
  const oy = (20 - h) / 2;
  const outline = shapeCommandsToPathData(def.outline(w, h), ox, oy);
  const details = def.details
    ? `<path d="${shapeCommandsToPathData(def.details(w, h), ox, oy)}"/>`
    : '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${outline}"/>${details}</svg>`;
}

/** Largest box with the proportions of `w` x `h` inside `maxW` x `maxH`. */
function fitBox(
  w: number,
  h: number,
  maxW: number,
  maxH: number,
): [number, number] {
  const scale = Math.min(maxW / w, maxH / h);
  return [w * scale, h * scale];
}
