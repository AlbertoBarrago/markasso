import {
  isImageSource,
  isValidElement,
  isValidStencilSource,
  MAX_ELEMENTS,
  MAX_POINTS_PER_ELEMENT,
  validateViewport,
} from './element_validation';

/**
 * Shape checks for the commands that travel through a live room.
 *
 * A room relays what its peers send and replays its log to everyone who
 * joins, so one malformed command reaches every client, and a command the
 * reducer throws on would break the room for good. The room (src/worker.ts)
 * refuses what fails here, and the clients (src/io/realtime.ts, the MCP
 * server) skip it again on their side, since they cannot trust the room's
 * history either.
 *
 * The checks are structural: the type must be one that is relayed, the fields
 * the reducer reads must be there with the right type, and whole elements
 * must pass the same validation as an opened file. They do not judge whether
 * a command makes sense for the current scene: the reducer already ignores
 * ids it does not know.
 *
 * Kept free of DOM-dependent imports, the `Command` type included, like
 * engine/ephemeral.ts, so the Cloudflare Worker can use it.
 */

type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function isIdList(value: unknown): boolean {
  return (
    Array.isArray(value) && value.length <= MAX_ELEMENTS && value.every(isId)
  );
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const optional =
  (check: (value: unknown) => boolean) =>
  (value: unknown): boolean =>
    value === undefined || check(value);

const isString = (value: unknown): boolean => typeof value === 'string';
const isBoolean = (value: unknown): boolean => typeof value === 'boolean';
const optionalNumber = optional(isNumber);
const optionalString = optional(isString);
const optionalBoolean = optional(isBoolean);
const optionalIdList = optional(isIdList);

function isPoint(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    isNumber(value[0]) &&
    isNumber(value[1])
  );
}

/** A connector end: an element id to attach to, or null to detach. */
const isEndTarget = optional((value) => value === null || isId(value));

/** A pinned connector end, or null to let it float along the border. */
const isAnchor = optional(
  (value) =>
    value === null ||
    (isRecord(value) && isNumber(value.x) && isNumber(value.y)),
);

/**
 * A partial element, as UPDATE_ELEMENT and PATCH_ELEMENTS carry it. An
 * element never changes identity or type after creation, and the two fields
 * that hold content from outside the app keep the rules of a whole element:
 * an image source stays an inline image, a stencil source a known one.
 */
function isElementPatch(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if ('id' in value || 'type' in value) return false;
  if ('src' in value && !isImageSource(value.src)) return false;
  if ('source' in value && !isValidStencilSource(value.source)) return false;
  return true;
}

function isElementList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_ELEMENTS &&
    value.every(isValidElement)
  );
}

function isListOf(value: unknown, check: (item: Fields) => boolean): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_ELEMENTS &&
    value.every((item) => isRecord(item) && check(item))
  );
}

const STROKE_STYLES = new Set(['solid', 'dashed', 'dotted']);
const TEXT_MODES = new Set(['text', 'code']);

const STYLE_STRINGS = [
  'strokeColor',
  'fillColor',
  'labelColor',
  'strokeStyle',
  'lineCap',
  'lineJoin',
  'shadowColor',
  'textAlign',
  'arrowHead',
  'shapeKind',
  'routing',
  'startHeadStyle',
  'endHeadStyle',
];
const STYLE_NUMBERS = [
  'strokeWidth',
  'opacity',
  'roughness',
  'shadowBlur',
  'shadowOffsetX',
  'shadowOffsetY',
  'cornerRadius',
];
const STYLE_BOOLEANS = ['bold', 'italic', 'underline', 'strikethrough'];

const RESIZE_NUMBERS = [
  'x',
  'y',
  'width',
  'height',
  'x2',
  'y2',
  'cx',
  'cy',
  'fontSize',
];

/** One check per relayed command type; a type missing here is refused. */
const CHECKS: Record<string, (c: Fields) => boolean> = {
  CREATE_ELEMENT: (c) => isValidElement(c.element) && optionalBoolean(c.select),
  CREATE_ELEMENTS: (c) => isElementList(c.elements),
  UPDATE_ELEMENT: (c) => isId(c.id) && isElementPatch(c.props),
  MOVE_ELEMENT: (c) => isId(c.id) && isNumber(c.dx) && isNumber(c.dy),
  MOVE_ELEMENTS: (c) => isIdList(c.ids) && isNumber(c.dx) && isNumber(c.dy),
  RESIZE_ELEMENT: (c) =>
    isId(c.id) &&
    RESIZE_NUMBERS.every((key) => optionalNumber(c[key])) &&
    optional(
      (points) =>
        Array.isArray(points) &&
        points.length <= MAX_POINTS_PER_ELEMENT &&
        points.every(isPoint),
    )(c.points) &&
    isEndTarget(c.startElementId) &&
    isEndTarget(c.endElementId) &&
    isAnchor(c.startAnchor) &&
    isAnchor(c.endAnchor),
  DELETE_ELEMENTS: (c) => isIdList(c.ids),
  PATCH_ELEMENTS: (c) =>
    optional((create) =>
      isListOf(
        create,
        (item) =>
          isValidElement(item.element) &&
          Number.isInteger(item.index) &&
          (item.index as number) >= 0,
      ),
    )(c.create) &&
    optional((update) =>
      isListOf(
        update,
        (item) =>
          isId(item.id) &&
          isElementPatch(item.set) &&
          optional((unset) => Array.isArray(unset) && unset.every(isString))(
            item.unset,
          ),
      ),
    )(c.update) &&
    optionalIdList(c.delete) &&
    optionalIdList(c.order),
  EDIT_TEXT: (c) => isId(c.id) && isString(c.content),
  SET_SHAPE_LABEL: (c) =>
    isId(c.id) &&
    isString(c.label) &&
    optionalNumber(c.labelFontSize) &&
    optionalString(c.labelFontFamily),
  SET_FONT_FAMILY: (c) => isString(c.family) && optionalIdList(c.ids),
  SET_FONT_SIZE: (c) =>
    isNumber(c.size) &&
    optionalIdList(c.ids) &&
    optional((bounds) =>
      isListOf(
        bounds,
        (box) => isId(box.id) && isNumber(box.width) && isNumber(box.height),
      ),
    )(c.bounds) &&
    optionalNumber(c.width) &&
    optionalNumber(c.height),
  SET_ROTATION: (c) => isId(c.id) && isNumber(c.rotation),
  SET_STROKE_STYLE: (c) => STROKE_STYLES.has(c.style as string),
  REORDER_ELEMENTS: (c) => isIdList(c.ids) && isNumber(c.targetIndex),
  TOGGLE_ELEMENT_VISIBILITY: (c) => isId(c.id),
  RENAME_LAYER: (c) => isId(c.id) && isString(c.name),
  LOAD_SCENE: (c) =>
    isElementList(c.elements) && validateViewport(c.viewport) !== null,
  GROUP_ELEMENTS: (c) => isIdList(c.ids) && isId(c.groupId),
  UNGROUP_ELEMENTS: (c) => isId(c.groupId),
  LOCK_ELEMENTS: (c) => isIdList(c.ids),
  UNLOCK_ELEMENTS: (c) => isIdList(c.ids),
  SET_TEXT_MODE: (c) =>
    TEXT_MODES.has(c.mode as string) && optionalIdList(c.ids),
  ALIGN_ELEMENTS: (c) =>
    isListOf(
      c.moves,
      (move) => isId(move.id) && isNumber(move.x) && isNumber(move.y),
    ),
  APPLY_STYLE: (c) =>
    optionalIdList(c.ids) &&
    STYLE_STRINGS.every((key) => optionalString(c[key])) &&
    STYLE_NUMBERS.every((key) => optionalNumber(c[key])) &&
    STYLE_BOOLEANS.every((key) => optionalBoolean(c[key])),
};

/** The command types a live room relays (see engine/ephemeral.ts). */
export const SESSION_COMMAND_TYPES: ReadonlySet<string> = new Set(
  Object.keys(CHECKS),
);

/**
 * Whether `value` is a command a live room may relay and a client may apply:
 * a relayed type with the fields the reducer needs. Ephemeral commands and
 * unknown types are refused.
 */
export function isValidSessionCommand(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  // Own keys only: `constructor` and the like are not command types.
  if (!Object.hasOwn(CHECKS, value.type)) return false;
  return (CHECKS[value.type] as (c: Fields) => boolean)(value);
}
