import type { Command } from '../commands/commands';
import type { Element } from '../elements/element';
import { isValidElement } from './element_validation';

/**
 * The commands a peer sends to a live room, paced to the room's quota.
 *
 * A room accepts at most 200 commands per peer every 5 seconds and drops the
 * rest without telling the sender, whose board then differs from everyone
 * else's for good. A drag emits one command per pointer move, so a few
 * seconds of dragging went past the quota, and so did an agent drawing a
 * large diagram.
 *
 * Two things keep a peer under it:
 * - Consecutive commands that continue the same gesture are merged: moves of
 *   the same elements add up, resizes and rotations of the same element keep
 *   the last value (their fields are absolute). Order is kept, and only the
 *   last command in the queue is ever merged into.
 * - At most `maxPerWindow` commands leave per window; the rest wait.
 *
 * The first command after a quiet moment leaves at once, so a click feels
 * immediate; a gesture then reaches the peers every `intervalMs`.
 *
 * Shared by the app (io/realtime.ts) and the MCP server (mcp/src/live.ts), so
 * free of DOM dependencies.
 */
export interface OutboxOptions {
  /** Sends one command now; the outbox never retries it. */
  send: (command: Command) => void;
  /** How often a gesture is sent. */
  intervalMs?: number;
  /** Commands per window: below the room's 200, which counts every command. */
  maxPerWindow?: number;
  windowMs?: number;
}

export class LiveOutbox {
  private readonly send: (command: Command) => void;
  private readonly intervalMs: number;
  private readonly maxPerWindow: number;
  private readonly windowMs: number;
  private queue: Command[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Send times in the current window, oldest first. */
  private sent: number[] = [];

  constructor(options: OutboxOptions) {
    this.send = options.send;
    this.intervalMs = options.intervalMs ?? 50;
    this.maxPerWindow = options.maxPerWindow ?? 150;
    this.windowMs = options.windowMs ?? 5_000;
  }

  /** True while commands are waiting to be sent. */
  get pending(): boolean {
    return this.queue.length > 0;
  }

  push(command: Command): void {
    const last = this.queue.at(-1);
    const merged = last ? mergeCommands(last, command) : null;
    if (merged) this.queue[this.queue.length - 1] = merged;
    else this.queue.push(command);
    // Quiet: send now and hold the next ones for an interval.
    if (this.timer === null) this.flush();
  }

  /** Sends what the quota allows now, and schedules the rest. */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const now = Date.now();
    this.sent = this.sent.filter((time) => now - time < this.windowMs);
    while (this.queue.length > 0 && this.sent.length < this.maxPerWindow) {
      const command = this.queue.shift() as Command;
      this.sent.push(now);
      this.send(command);
    }
    // Wait an interval, or until the oldest send leaves the window when the
    // quota is used up.
    const wait =
      this.queue.length > 0 && this.sent.length >= this.maxPerWindow
        ? Math.max(this.intervalMs, (this.sent[0] ?? now) + this.windowMs - now)
        : this.intervalMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.queue.length > 0) this.flush();
    }, wait);
  }

  /**
   * Sends what is waiting before a voluntary leave, where nothing is sent
   * later: as much as the quota allows now, and the rest is dropped. The
   * queue is merged, so after a gesture it is short; without this, an edit
   * made just before leaving (an undo, say) never reached the peers.
   */
  drain(): void {
    this.flush();
    this.clear();
  }

  /** Drops what is waiting, e.g. when the connection is gone. */
  clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
  }
}

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, index) => id === b[index]);

/**
 * `next` folded into `last`, or null when they cannot be merged. A merged
 * command gives the same scene as the two applied in order (moves add up:
 * the peers may differ from the sender in the last bits of a coordinate).
 */
export function mergeCommands(last: Command, next: Command): Command | null {
  if (last.type === 'MOVE_ELEMENTS' && next.type === 'MOVE_ELEMENTS') {
    if (!sameIds(last.ids, next.ids)) return null;
    return { ...last, dx: last.dx + next.dx, dy: last.dy + next.dy };
  }
  if (last.type === 'MOVE_ELEMENT' && next.type === 'MOVE_ELEMENT') {
    if (last.id !== next.id) return null;
    return { ...last, dx: last.dx + next.dx, dy: last.dy + next.dy };
  }
  if (last.type === 'RESIZE_ELEMENT' && next.type === 'RESIZE_ELEMENT') {
    if (last.id !== next.id) return null;
    return { ...last, ...next };
  }
  if (last.type === 'SET_ROTATION' && next.type === 'SET_ROTATION') {
    return last.id === next.id ? next : null;
  }
  return null;
}

/** Elements per CREATE_ELEMENTS, well under the validation limit (5,000). */
const PIECE_ELEMENTS = 1_000;
/** Size of one CREATE_ELEMENTS, under the room's message limit (512 KB). */
const PIECE_CHARS = 400_000;

/**
 * Elements as CREATE_ELEMENTS commands a room accepts: each one within the
 * room's message and validation limits. Used to publish a board to a room
 * (the app's and the agent's seed) and by the room to compact its log.
 *
 * With `validOnly`, elements the room would refuse are left out first: one
 * of them would make the room refuse its whole piece. An element too large
 * for any message goes alone in its piece, which the room then refuses.
 */
export function createCommands(
  elements: readonly Element[],
  { validOnly = false }: { validOnly?: boolean } = {},
): Array<{ type: 'CREATE_ELEMENTS'; elements: Element[] }> {
  const commands: Array<{ type: 'CREATE_ELEMENTS'; elements: Element[] }> = [];
  let piece: Element[] = [];
  let pieceChars = 0;
  const flush = (): void => {
    if (piece.length === 0) return;
    commands.push({ type: 'CREATE_ELEMENTS', elements: piece });
    piece = [];
    pieceChars = 0;
  };
  for (const element of elements) {
    if (validOnly && !isValidElement(element)) continue;
    const chars = JSON.stringify(element).length;
    if (
      piece.length >= PIECE_ELEMENTS ||
      (piece.length > 0 && pieceChars + chars > PIECE_CHARS)
    )
      flush();
    piece.push(element);
    pieceChars += chars;
  }
  flush();
  return commands;
}
