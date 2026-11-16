import { describe, expect, it } from 'vitest';
import type { Command } from '../src/commands/commands';
import { createScene } from '../src/core/scene';
import { EllipseTool } from '../src/tools/ellipse_tool';
import { EraserTool } from '../src/tools/eraser_tool';
import { PenTool } from '../src/tools/pen_tool';
import { RectangleTool } from '../src/tools/rectangle_tool';
import { RomboTool } from '../src/tools/rombo_tool';
import type { ToolContext } from '../src/tools/tool';

const nullCtx = null as unknown as ToolContext;

describe('EllipseTool', () => {
  it('getCursor returns a string', () => {
    expect(
      typeof (
        new EllipseTool() as unknown as { getCursor(): string }
      ).getCursor(),
    ).toBe('string');
  });

  it('onDeactivate resets preview to null', () => {
    const tool = new EllipseTool();
    (tool as unknown as { drawing: boolean }).drawing = true;
    tool.onDeactivate(nullCtx);
    expect(tool.preview).toBeNull();
  });
});

describe('RectangleTool', () => {
  it('getCursor returns a string', () => {
    expect(
      typeof (
        new RectangleTool() as unknown as { getCursor(): string }
      ).getCursor(),
    ).toBe('string');
  });

  it('onDeactivate resets preview to null', () => {
    const tool = new RectangleTool();
    (tool as unknown as { drawing: boolean }).drawing = true;
    tool.onDeactivate(nullCtx);
    expect(tool.preview).toBeNull();
  });
});

describe('RomboTool', () => {
  it('getCursor returns a string', () => {
    expect(
      typeof (
        new RomboTool() as unknown as { getCursor(): string }
      ).getCursor(),
    ).toBe('string');
  });

  it('onDeactivate resets preview to null', () => {
    const tool = new RomboTool();
    tool.onDeactivate(nullCtx);
    expect(tool.preview).toBeNull();
  });
});

describe('EraserTool', () => {
  it('getCursor returns a string', () => {
    expect(
      typeof (
        new EraserTool() as unknown as { getCursor(): string }
      ).getCursor(),
    ).toBe('string');
  });
});

describe('PenTool', () => {
  it('getCursor returns a string', () => {
    expect(
      typeof (new PenTool() as unknown as { getCursor(): string }).getCursor(),
    ).toBe('string');
  });

  it('onCancel resets all stroke state', () => {
    const tool = new PenTool();
    (tool as unknown as { drawing: boolean }).drawing = true;
    (tool as unknown as { points: number[][] }).points = [[0, 0]];
    tool.onCancel(nullCtx);
    expect(tool.preview).toBeNull();
    expect((tool as unknown as { drawing: boolean }).drawing).toBe(false);
    expect((tool as unknown as { points: number[][] }).points).toHaveLength(0);
  });
});

/** A tool context that records dispatched commands and preview refreshes. */
function recordingCtx(): {
  ctx: ToolContext;
  dispatched: Command[];
  previewUpdates: () => number;
} {
  const dispatched: Command[] = [];
  let previews = 0;
  const ctx = {
    history: {
      present: createScene(),
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

describe.each([
  ['RectangleTool', () => new RectangleTool()],
  ['EllipseTool', () => new EllipseTool()],
  ['RomboTool', () => new RomboTool()],
])('%s drag', (_name, make) => {
  const plain = { shiftKey: false } as MouseEvent;
  const shift = { shiftKey: true } as MouseEvent;

  it('Shift constrains the created shape to equal sides', () => {
    const { ctx, dispatched } = recordingCtx();
    const tool = make();

    tool.onMouseDown(plain, 100, 100, ctx);
    tool.onMouseUp(shift, 20, 160, ctx);

    const cmd = dispatched.find((c) => c.type === 'CREATE_ELEMENT');
    expect(cmd?.type === 'CREATE_ELEMENT' && cmd.element).toMatchObject({
      x: 100,
      y: 100,
      width: -60,
      height: 60,
    });
  });

  it('cancel drops the drag and refreshes the preview', () => {
    const { ctx, dispatched, previewUpdates } = recordingCtx();
    const tool = make();

    tool.onMouseDown(plain, 0, 0, ctx);
    tool.onMouseMove(plain, 40, 40, ctx);
    expect(tool.preview).not.toBeNull();
    tool.onCancel(ctx);
    tool.onMouseUp(plain, 80, 80, ctx);

    expect(tool.preview).toBeNull();
    expect(previewUpdates()).toBe(2);
    expect(dispatched).toEqual([]);
  });
});
