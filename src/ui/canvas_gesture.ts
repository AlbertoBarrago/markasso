import type { History } from '../engine/history';
import type { Tool, ToolContext } from '../tools/tool';

/** Routes history actions through the active canvas gesture until release. */
export class CanvasGesture {
  private tool: Tool | null = null;
  cancelled = false;

  constructor(private readonly ctx: ToolContext) {}

  begin(tool: Tool): void {
    this.tool = tool;
    this.cancelled = false;
  }

  end(): void {
    this.tool = null;
    this.cancelled = false;
  }

  cancel(): boolean {
    if (!this.tool) return false;
    if (!this.cancelled) {
      this.cancelled = true;
      this.tool.onCancel?.(this.ctx);
      this.ctx.history.cancelDrag();
      this.ctx.onPreviewUpdate?.();
    }
    return true;
  }

  undo(): void {
    if (!this.cancel()) this.ctx.history.undo();
  }

  redo(): void {
    if (!this.cancel()) this.ctx.history.redo();
  }
}

export type HistoryActions = Pick<History, 'undo' | 'redo'>;
