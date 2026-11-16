import { describe, expect, it } from 'vitest';
import type { Command } from '../src/commands/commands';
import type { AppState } from '../src/core/app_state';
import { createScene } from '../src/core/scene';
import type { ShapeElement } from '../src/elements/element';
import { ShapeTool } from '../src/tools/shape_tool';
import type { ToolContext } from '../src/tools/tool';

interface Harness {
  ctx: ToolContext;
  dispatched: Command[];
  previewUpdates: () => number;
}

/** A tool context that records dispatched commands and preview refreshes. */
function makeHarness(appState: Partial<AppState> = {}): Harness {
  const dispatched: Command[] = [];
  let previews = 0;
  const scene = createScene();
  const ctx = {
    history: {
      present: { ...scene, appState: { ...scene.appState, ...appState } },
      dispatch: (command: Command) => {
        dispatched.push(command);
      },
    },
    canvas: {} as HTMLCanvasElement,
    onPreviewUpdate: () => {
      previews++;
    },
  } as unknown as ToolContext;
  return { ctx, dispatched, previewUpdates: () => previews };
}

const plain = { shiftKey: false } as MouseEvent;
const shift = { shiftKey: true } as MouseEvent;

function created(dispatched: Command[]): ShapeElement {
  const cmd = dispatched.find((c) => c.type === 'CREATE_ELEMENT');
  if (cmd?.type !== 'CREATE_ELEMENT') throw new Error('no CREATE_ELEMENT');
  return cmd.element as ShapeElement;
}

describe('ShapeTool', () => {
  it('creates the selected flowchart symbol with the current style', () => {
    const { ctx, dispatched } = makeHarness({
      shapeKind: 'database',
      strokeColor: '#ff0000',
      fillColor: '#00ff00',
      strokeWidth: 4,
    });
    const tool = new ShapeTool();

    tool.onMouseDown(plain, 10, 20, ctx);
    tool.onMouseUp(plain, 110, 70, ctx);

    const shape = created(dispatched);
    expect(shape).toMatchObject({
      type: 'shape',
      kind: 'database',
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      strokeColor: '#ff0000',
      fillColor: '#00ff00',
      strokeWidth: 4,
    });
    expect(shape.id).not.toBe('__preview__');
    expect(tool.preview).toBeNull();
  });

  it('switches back to select, keeping the new selection', () => {
    const { ctx, dispatched } = makeHarness();
    const tool = new ShapeTool();

    tool.onMouseDown(plain, 0, 0, ctx);
    tool.onMouseUp(plain, 50, 50, ctx);

    expect(dispatched.at(-1)).toEqual({
      type: 'SET_TOOL',
      tool: 'select',
      keepSelection: true,
    });
  });

  it('stays on the shape tool while the tool is locked', () => {
    const { ctx, dispatched } = makeHarness({ toolLocked: true });
    const tool = new ShapeTool();

    tool.onMouseDown(plain, 0, 0, ctx);
    tool.onMouseUp(plain, 50, 50, ctx);

    expect(dispatched.map((c) => c.type)).toEqual(['CREATE_ELEMENT']);
  });

  it('constrains to a square with Shift, keeping the drag direction', () => {
    const { ctx, dispatched } = makeHarness();
    const tool = new ShapeTool();

    tool.onMouseDown(plain, 100, 100, ctx);
    tool.onMouseUp(shift, 20, 160, ctx);

    expect(created(dispatched)).toMatchObject({ width: -60, height: 60 });
  });

  it('ignores a click without a drag', () => {
    const { ctx, dispatched } = makeHarness();
    const tool = new ShapeTool();

    tool.onMouseDown(plain, 5, 5, ctx);
    tool.onMouseUp(plain, 6, 6, ctx);

    expect(dispatched).toEqual([]);
  });

  it('ignores mouse moves and ups without a press', () => {
    const { ctx, dispatched, previewUpdates } = makeHarness();
    const tool = new ShapeTool();

    tool.onMouseMove(plain, 50, 50, ctx);
    tool.onMouseUp(plain, 50, 50, ctx);

    expect(tool.preview).toBeNull();
    expect(previewUpdates()).toBe(0);
    expect(dispatched).toEqual([]);
  });

  it('previews the symbol while dragging', () => {
    const { ctx, previewUpdates } = makeHarness({ shapeKind: 'document' });
    const tool = new ShapeTool();

    tool.onMouseDown(plain, 0, 0, ctx);
    tool.onMouseMove(plain, 40, 30, ctx);
    expect(tool.preview).toMatchObject({
      id: '__preview__',
      kind: 'document',
      width: 40,
      height: 30,
    });

    tool.onMouseMove(shift, 40, 30, ctx);
    expect(tool.preview).toMatchObject({ width: 30, height: 30 });
    expect(previewUpdates()).toBe(2);
  });

  it('Shift on a zero-width drag still yields a square', () => {
    const { ctx } = makeHarness();
    const tool = new ShapeTool();

    tool.onMouseDown(plain, 0, 0, ctx);
    tool.onMouseMove(shift, 0, 30, ctx);

    expect(tool.preview).toMatchObject({ width: 0, height: 0 });
  });

  it('cancel drops the drag and refreshes the preview', () => {
    const { ctx, dispatched, previewUpdates } = makeHarness();
    const tool = new ShapeTool();

    tool.onMouseDown(plain, 0, 0, ctx);
    tool.onMouseMove(plain, 40, 40, ctx);
    tool.onCancel(ctx);
    tool.onMouseUp(plain, 80, 80, ctx);

    expect(tool.preview).toBeNull();
    expect(previewUpdates()).toBe(2);
    expect(dispatched).toEqual([]);
  });

  it('deactivating drops the drag', () => {
    const { ctx, dispatched } = makeHarness();
    const tool = new ShapeTool();

    tool.onMouseDown(plain, 0, 0, ctx);
    tool.onMouseMove(plain, 40, 40, ctx);
    tool.onDeactivate(ctx);
    tool.onMouseUp(plain, 80, 80, ctx);

    expect(tool.preview).toBeNull();
    expect(dispatched).toEqual([]);
  });

  it('uses a crosshair cursor', () => {
    expect(new ShapeTool().getCursor()).toBe('crosshair');
  });
});
