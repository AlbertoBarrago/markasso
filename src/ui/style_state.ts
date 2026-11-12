import type { Scene } from '../core/scene';
import type {
  ArrowHeadStyle,
  ConnectorRouting,
  Element,
  ShapeKind,
} from '../elements/element';
import { hasEndHead, hasStartHead } from '../rendering/connector_geometry';
import { hasFillStyle, hasStrokeStyle, styleTypeOf } from './style_type';

/** Tools whose next element can be styled before it is drawn. */
export const DRAWING_TOOLS: ReadonlySet<string> = new Set([
  'rectangle',
  'ellipse',
  'line',
  'rombo',
  'shape',
  'freehand',
  'text',
]);

export type ArrowHeadPlacement = 'none' | 'end' | 'start' | 'both';
export type TextFormatKey = 'bold' | 'italic' | 'underline' | 'strikethrough';

/** Which style controls apply to the current selection or drawing tool. */
export interface StyleSections {
  readonly stroke: boolean;
  readonly fill: boolean;
  readonly width: boolean;
  /** Stroke style and roughness share this flag. */
  readonly strokeStyle: boolean;
  readonly lineCap: boolean;
  readonly arrowHead: boolean;
  readonly startHead: boolean;
  readonly endHead: boolean;
  readonly routing: boolean;
  readonly border: boolean;
  readonly shapeKind: boolean;
  readonly text: boolean;
  /** Spatial alignment of two or more elements. */
  readonly spatialAlign: boolean;
  /** Duplicate, delete, lock (selection only). */
  readonly actions: boolean;
  readonly formatPainter: boolean;
}

/** Current values shown by the style controls. */
export interface StyleValues {
  /** Stroke color, or the label color while the text tool edits shape labels. */
  readonly strokeColor: string;
  readonly fillColor: string;
  readonly strokeWidth: number;
  readonly strokeStyle: string;
  readonly roughness: number;
  readonly opacity: number;
  readonly lineCap: string;
  readonly arrowHead: ArrowHeadPlacement;
  readonly startHeadStyle: ArrowHeadStyle;
  readonly endHeadStyle: ArrowHeadStyle;
  readonly routing: ConnectorRouting;
  readonly rounded: boolean;
  readonly shapeKind: ShapeKind | undefined;
  readonly fontSize: number | undefined;
  readonly fontFamily: string | undefined;
  readonly textMode: 'text' | 'code';
  readonly textAlign: 'left' | 'center' | 'right';
  readonly textFormat: Readonly<Record<TextFormatKey, boolean>>;
  readonly allLocked: boolean;
}

/**
 * Style controls state, shared by the context panel and the floating style
 * bar so both show the same sections and values for the same scene.
 */
export interface StyleState {
  /** `tool`: a drawing tool with nothing selected; `selection` otherwise. */
  readonly mode: 'tool' | 'selection';
  readonly selected: readonly Element[];
  /** The stroke row is titled "Color" (text, or shape labels being edited). */
  readonly strokeIsColor: boolean;
  /** The stroke row edits shape label colors instead of strokes. */
  readonly labelColorMode: boolean;
  readonly sections: StyleSections;
  readonly values: StyleValues;
}

/** Elements carrying a label whose color the text tool can change. */
export function hasShapeLabel(
  el: Element,
): el is Element & { labelColor?: string } {
  return (
    el.type === 'rectangle' ||
    el.type === 'ellipse' ||
    el.type === 'rhombus' ||
    el.type === 'shape' ||
    el.type === 'stencil' ||
    el.type === 'line' ||
    el.type === 'arrow'
  );
}

export function selectedElements(scene: Scene): Element[] {
  return [...scene.selectedIds]
    .map((id) => scene.elements.find((el) => el.id === id))
    .filter((el): el is Element => el !== undefined);
}

function textFormatOf(el: Element | undefined): Record<TextFormatKey, boolean> {
  const t = el?.type === 'text' ? el : undefined;
  return {
    bold: !!t?.bold,
    italic: !!t?.italic,
    underline: !!t?.underline,
    strikethrough: !!t?.strikethrough,
  };
}

/**
 * The style controls state for `scene`, or `null` when there is nothing to
 * style (no selection and no drawing tool).
 */
export function getStyleState(scene: Scene): StyleState | null {
  const selected = selectedElements(scene);
  if (selected.length > 0) return selectionState(scene, selected);
  if (DRAWING_TOOLS.has(scene.appState.activeTool)) return toolState(scene);
  return null;
}

/** Tool mode: the defaults the next element is drawn with. */
function toolState(scene: Scene): StyleState {
  const { appState } = scene;
  const { activeTool } = appState;
  // The last drawn element wins over appState, so the controls show what the
  // tool just produced (APPLY_STYLE restyles it in tool mode).
  const lastEl = appState.lastCreatedId
    ? scene.elements.find((e) => e.id === appState.lastCreatedId)
    : undefined;
  const isText = activeTool === 'text';
  const hasStyle = activeTool !== 'text' && activeTool !== 'freehand';
  return {
    mode: 'tool',
    selected: [],
    strokeIsColor: isText,
    labelColorMode: false,
    sections: {
      stroke: true,
      fill:
        activeTool === 'rectangle' ||
        activeTool === 'ellipse' ||
        activeTool === 'rombo' ||
        activeTool === 'shape' ||
        activeTool === 'text',
      width: !isText,
      strokeStyle: hasStyle,
      lineCap: false,
      arrowHead: activeTool === 'line',
      startHead: false,
      endHead: false,
      routing: activeTool === 'line',
      border: activeTool === 'rectangle' || activeTool === 'rombo',
      shapeKind: activeTool === 'shape',
      text: isText,
      spatialAlign: false,
      actions: false,
      formatPainter: false,
    },
    values: {
      strokeColor: lastEl ? lastEl.strokeColor : appState.strokeColor,
      fillColor: lastEl ? lastEl.fillColor : appState.fillColor,
      strokeWidth: lastEl ? lastEl.strokeWidth : appState.strokeWidth,
      strokeStyle: lastEl
        ? (lastEl.strokeStyle ?? 'solid')
        : appState.strokeStyle,
      roughness: lastEl ? (lastEl.roughness ?? 0) : appState.roughness,
      opacity: lastEl ? lastEl.opacity : appState.opacity,
      lineCap: 'round',
      arrowHead:
        (lastEl?.type === 'line' ? lastEl.arrowHead : undefined) ?? 'none',
      startHeadStyle: 'open',
      endHeadStyle: 'open',
      routing: appState.lineRouting,
      rounded: false,
      shapeKind: appState.shapeKind,
      fontSize: isText ? appState.fontSize : undefined,
      fontFamily: isText ? appState.fontFamily : undefined,
      textMode: appState.textMode,
      textAlign: appState.textAlign,
      textFormat: textFormatOf(lastEl),
      allLocked: false,
    },
  };
}

const CAP_TYPES: ReadonlySet<string> = new Set(['line', 'freehand']);

/** Selection mode: values come from the first selected element. */
function selectionState(scene: Scene, selected: Element[]): StyleState {
  const first = selected[0]!;
  const allText = selected.every((el) => el.type === 'text');
  const allImage = selected.every((el) => styleTypeOf(el) === 'image');
  const labelColorMode =
    scene.appState.activeTool === 'text' && selected.some(hasShapeLabel);
  const firstLabelTarget = selected.find(hasShapeLabel);
  const restylable = !labelColorMode && !allImage;
  const firstLine = selected.find((el) => el.type === 'line');
  const firstConnector = selected.find(
    (el) => el.type === 'line' || el.type === 'arrow',
  );
  const connectors = selected.filter(
    (el) => el.type === 'line' || el.type === 'arrow',
  );
  // A head row shows when a selected connector actually draws that head.
  const withStartHead = connectors.find(hasStartHead);
  const withEndHead = connectors.find(hasEndHead);
  const firstShape = selected.find((el) => el.type === 'shape');
  const firstText = first.type === 'text' ? first : undefined;
  const cornerRadius =
    first.type === 'rectangle' || first.type === 'rhombus'
      ? (first.cornerRadius ?? 0)
      : 0;

  return {
    mode: 'selection',
    selected,
    strokeIsColor: allText || labelColorMode,
    labelColorMode,
    sections: {
      stroke: !allImage,
      fill: restylable && selected.some(hasFillStyle),
      width: !labelColorMode && !allText && !allImage,
      strokeStyle: restylable && !allText && selected.some(hasStrokeStyle),
      lineCap:
        restylable && !allText && selected.some((el) => CAP_TYPES.has(el.type)),
      arrowHead: restylable && !allText && firstLine !== undefined,
      startHead: !labelColorMode && withStartHead !== undefined,
      endHead: !labelColorMode && withEndHead !== undefined,
      routing: !labelColorMode && firstConnector !== undefined,
      border:
        !labelColorMode &&
        selected.some((el) => el.type === 'rectangle' || el.type === 'rhombus'),
      shapeKind: !labelColorMode && firstShape !== undefined,
      text: allText,
      spatialAlign: selected.length >= 2,
      actions: true,
      formatPainter: selected.length === 1,
    },
    values: {
      strokeColor:
        labelColorMode && firstLabelTarget
          ? (firstLabelTarget.labelColor ?? firstLabelTarget.strokeColor)
          : first.strokeColor,
      fillColor: first.fillColor,
      strokeWidth: first.strokeWidth,
      strokeStyle: first.strokeStyle ?? 'solid',
      roughness: first.roughness ?? 0,
      opacity: first.opacity,
      lineCap: first.lineCap ?? 'round',
      arrowHead:
        (firstLine?.type === 'line' ? firstLine.arrowHead : undefined) ??
        'none',
      startHeadStyle:
        (withStartHead?.type === 'line'
          ? withStartHead.startHeadStyle
          : undefined) ?? 'open',
      endHeadStyle: withEndHead?.endHeadStyle ?? 'open',
      routing:
        (firstConnector?.type === 'line' || firstConnector?.type === 'arrow'
          ? firstConnector.routing
          : undefined) ?? 'straight',
      rounded: cornerRadius > 0,
      shapeKind: firstShape?.type === 'shape' ? firstShape.kind : undefined,
      fontSize: allText ? firstText?.fontSize : undefined,
      fontFamily: allText ? firstText?.fontFamily : undefined,
      textMode: firstText?.isCode ? 'code' : 'text',
      textAlign: firstText?.textAlign ?? 'left',
      textFormat: textFormatOf(first),
      allLocked: selected.every((el) => el.locked),
    },
  };
}
