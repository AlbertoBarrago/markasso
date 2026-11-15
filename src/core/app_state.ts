import type {
  ConnectorRouting,
  ElementType,
  ShapeKind,
} from '../elements/element';

export type DrawableTool = Exclude<
  ElementType,
  'image' | 'rhombus' | 'curve' | 'polygon' | 'arrow' | 'stencil'
>;
export type ActiveTool =
  | 'select'
  | 'hand'
  | 'eraser'
  | DrawableTool
  | 'rombo'
  | 'sticky';
export type GridType = 'dot' | 'line' | 'mm';

export interface AppState {
  readonly activeTool: ActiveTool;
  readonly strokeColor: string;
  readonly fillColor: string;
  readonly strokeWidth: number;
  readonly fontSize: number;
  readonly fontFamily: string;
  readonly textAlign: 'left' | 'center' | 'right';
  readonly textMode: 'text' | 'code';
  readonly opacity: number;
  readonly roughness: number;
  readonly gridVisible: boolean;
  readonly gridSize: number;
  readonly gridType: GridType;
  readonly strokeStyle: 'solid' | 'dashed' | 'dotted';
  readonly justCreatedText: boolean;
  readonly toolLocked: boolean;
  /** Flowchart symbol drawn by the `shape` tool. */
  readonly shapeKind: ShapeKind;
  /** Routing applied to connectors drawn with the line tool. */
  readonly lineRouting: ConnectorRouting;
  /** ID of the last element created with select:false — allows the panel to style it without selecting it */
  readonly lastCreatedId: string | null;
}

export function createAppState(): AppState {
  // Read through globalThis: this module also runs in the Worker, where the
  // live room applies commands with the reducer and neither global exists.
  const { document: doc, window: win } = globalThis as {
    document?: {
      documentElement: { getAttribute(name: string): string | null };
    };
    window?: { matchMedia(query: string): { matches: boolean } };
  };
  const resolvedTheme = doc?.documentElement.getAttribute('data-theme');
  const defaultStrokeColor = resolvedTheme === 'light' ? '#000000' : '#e2e2ef';

  const isMobile = win?.matchMedia('(pointer: coarse)').matches ?? false;

  return {
    activeTool: 'select',
    strokeColor: defaultStrokeColor,
    fillColor: 'transparent',
    strokeWidth: isMobile ? 4 : 1,
    fontSize: 20,
    fontFamily: 'Arial, sans-serif',
    textAlign: 'left',
    textMode: 'text',
    opacity: 1,
    roughness: 0,
    gridVisible: true,
    gridSize: 20,
    gridType: 'dot',
    strokeStyle: 'solid',
    justCreatedText: false,
    toolLocked: false,
    shapeKind: 'terminator',
    lineRouting: 'straight',
    lastCreatedId: null,
  };
}
