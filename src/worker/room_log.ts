import type { Command } from '../commands/commands';
import { createScene, type Scene } from '../core/scene';
import { reducer } from '../engine/reducer';
import { isValidSessionCommand } from '../io/command_validation';
import { isValidElement } from '../io/element_validation';
import { createCommands } from '../io/live_outbox';

/**
 * The command log of one live room, with the scene it builds.
 *
 * A peer joining the room replays the log onto an empty board, so the log is
 * the room's content. It used to be a list capped at 5,000 commands that
 * dropped its oldest entries, the very ones that created the board: past the
 * cap, whoever joined or reconnected got a board with elements missing.
 *
 * The room now applies every command with the same reducer and in the same
 * order as a joining peer, so it always holds the scene that peer would
 * build. When the log grows, it is compacted: replaced by that scene, as a
 * few CREATE_ELEMENTS, which replays to exactly the same board. A command
 * the reducer cannot apply is refused, since it would break every replay.
 *
 * The log is stored in chunks: one storage value is capped at about 2 MB,
 * and a log in a single value stopped being saved once it grew past that.
 */

/** A command as it travels over the wire, already validated. */
export type WireCommand = { type: string; [key: string]: unknown };

/** Storage the log needs: the Durable Object's, or a fake in tests. */
export type LogStorage = Pick<DurableObjectStorage, 'get' | 'put' | 'delete'>;

/** Commands appended since the last compaction that trigger the next one. */
const COMPACT_AFTER_COMMANDS = 1_000;
/** Size (JSON characters) appended since the last compaction that triggers one. */
const COMPACT_AFTER_CHARS = 4_000_000;
/**
 * The most the room keeps (scene plus log, in JSON characters). The room
 * lives in one isolate with 128 MB of memory, and holds both. Past this, a
 * command that brings content is refused (see SMALL_COMMAND_CHARS).
 */
const MAX_ROOM_CHARS = 24_000_000;
/**
 * Size of one stored chunk. Storage caps a value at 2 MB and may hold a
 * string with two bytes per character: half of it leaves room for both.
 */
const CHUNK_CHARS = 700_000;
/** Keys per storage call: `put` and `delete` take at most 128, atomically. */
const MAX_KEYS_PER_CALL = 128;

/** Before chunks, the whole log was one value under this key. */
const LEGACY_KEY = 'commands';
const META_KEY = 'log:meta';
const chunkKey = (index: number): string => `log:${index}`;

interface Chunk {
  commands: WireCommand[];
  chars: number;
}

export class RoomLog {
  private scene: Scene = createScene();
  private chunks: Chunk[] = [];
  /** Chunks changed since the last save. */
  private readonly dirty = new Set<number>();
  /** Chunks the storage holds (from the last save or load). */
  private storedChunks = 0;
  /** The storage still has the single-value log of older versions. */
  private legacyStored = false;
  private appendedCommands = 0;
  private appendedChars = 0;
  /** Size of the log (sum of the chunks). */
  private logChars = 0;
  /** Size of the last snapshot, the scene at the last compaction. */
  private snapshotChars = 0;

  /** The log to send to a peer that joins: it replays to the room's scene. */
  get commands(): WireCommand[] {
    return this.chunks.flatMap((chunk) => chunk.commands);
  }

  /**
   * Applies a command to the room's scene and appends it to the log. Returns
   * false, leaving the room unchanged, when the command is not valid, the
   * reducer throws on it, it leaves an element that is not valid, or it
   * would grow the room past its size limit.
   */
  append(command: unknown): command is WireCommand {
    if (!isValidSessionCommand(command)) return false;
    const wire = command as WireCommand;
    const chars = JSON.stringify(wire).length;
    if (growsContent(wire) && this.size() + chars > MAX_ROOM_CHARS) {
      // A compaction may free enough (moves and restyles of the same
      // elements collapse into one snapshot); otherwise the room is full.
      this.compact();
      if (this.size() + chars > MAX_ROOM_CHARS) return false;
    }
    let next: Scene;
    try {
      next = reducer(this.scene, wire as unknown as Command, true);
    } catch {
      return false;
    }
    // A valid command can still leave an element that is not (a rotation
    // past a full turn, a text past its length limit). Compaction would put
    // it in a CREATE_ELEMENTS that every peer refuses, together with the
    // healthy elements of the same piece.
    if (!changedElementsValid(this.scene, next)) return false;
    this.scene = next;
    this.push(wire, chars);
    this.appendedCommands++;
    this.appendedChars += chars;
    if (
      this.appendedCommands >= COMPACT_AFTER_COMMANDS ||
      this.appendedChars >= COMPACT_AFTER_CHARS
    )
      this.compact();
    return true;
  }

  /** Replaces the log with the scene it builds. */
  compact(): void {
    this.chunks = [];
    this.logChars = 0;
    this.appendedCommands = 0;
    this.appendedChars = 0;
    for (const command of createCommands(this.scene.elements))
      this.push(command, JSON.stringify(command).length);
    this.snapshotChars = this.logChars;
    for (let index = 0; index < this.chunks.length; index++)
      this.dirty.add(index);
  }

  /** Forgets everything, as when the cleanup cron reclaims the room. */
  reset(): void {
    this.scene = createScene();
    this.chunks = [];
    this.dirty.clear();
    this.storedChunks = 0;
    this.legacyStored = false;
    this.appendedCommands = 0;
    this.appendedChars = 0;
    this.logChars = 0;
    this.snapshotChars = 0;
  }

  /**
   * Loads the stored log and rebuilds the scene from it. Commands that are
   * not valid or that the reducer refuses are left out, so a room broken by
   * one of them loads again. A log stored by an older version is read too.
   */
  async load(storage: LogStorage): Promise<void> {
    this.reset();
    const meta = await storage.get<{ chunks?: unknown }>(META_KEY);
    let stored: unknown[] = [];
    if (
      meta &&
      typeof meta.chunks === 'number' &&
      Number.isInteger(meta.chunks)
    ) {
      this.storedChunks = meta.chunks;
      for (let index = 0; index < meta.chunks; index++) {
        const chunk = await storage.get<unknown[]>(chunkKey(index));
        if (Array.isArray(chunk)) stored.push(...chunk);
      }
    } else {
      const legacy = await storage.get<unknown[]>(LEGACY_KEY);
      if (Array.isArray(legacy)) {
        stored = legacy;
        this.legacyStored = true;
      }
    }
    for (const command of stored) this.append(command);
    // Whatever was loaded is saved again in the current layout, compacted
    // when it is long: the next save rewrites every chunk.
    if (this.appendedCommands > 0 || this.legacyStored) this.compact();
  }

  /**
   * Writes the chunks changed since the last save, plus `extra` entries, in
   * one atomic call when they fit in it. On failure the changes stay pending
   * for the next save, and the error is thrown to the caller.
   */
  async save(
    storage: LogStorage,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const changed = [...this.dirty].filter(
      (index) => index < this.chunks.length,
    );
    const entries: Array<[string, unknown]> = changed.map((index) => [
      chunkKey(index),
      this.chunks[index]?.commands ?? [],
    ]);
    // The meta entry goes last: when the chunks need more than one call, it
    // only switches to the new chunks once they are all written.
    entries.push(...Object.entries(extra), [
      META_KEY,
      { chunks: this.chunks.length },
    ]);
    this.dirty.clear();
    try {
      for (let start = 0; start < entries.length; start += MAX_KEYS_PER_CALL)
        await storage.put(
          Object.fromEntries(entries.slice(start, start + MAX_KEYS_PER_CALL)),
        );
    } catch (error) {
      for (const index of changed) this.dirty.add(index);
      throw error;
    }
    const stale = [];
    for (let index = this.chunks.length; index < this.storedChunks; index++)
      stale.push(chunkKey(index));
    if (this.legacyStored) stale.push(LEGACY_KEY);
    this.storedChunks = this.chunks.length;
    this.legacyStored = false;
    // Keys no meta points at: harmless if a delete fails, retried next time.
    for (let start = 0; start < stale.length; start += MAX_KEYS_PER_CALL)
      await storage.delete(stale.slice(start, start + MAX_KEYS_PER_CALL));
  }

  private push(command: WireCommand, chars: number): void {
    let last = this.chunks.at(-1);
    if (
      !last ||
      (last.commands.length > 0 && last.chars + chars > CHUNK_CHARS)
    ) {
      last = { commands: [], chars: 0 };
      this.chunks.push(last);
    }
    last.commands.push(command);
    last.chars += chars;
    this.logChars += chars;
    this.dirty.add(this.chunks.length - 1);
  }

  /**
   * What the room holds: the log, and the scene. The scene is not measured
   * on every command (that would serialize it each time): it is at most the
   * last snapshot plus what was appended since.
   */
  private size(): number {
    return this.logChars + this.snapshotChars + this.appendedChars;
  }
}

/**
 * Whether a command can bring new content to the room. These are refused in
 * a full room; the others (moves, deletes, restyles, reorders) keep working
 * there, since deleting is how a full room frees space, and compaction folds
 * them away.
 */
function growsContent(command: WireCommand): boolean {
  switch (command.type) {
    case 'CREATE_ELEMENT':
    case 'CREATE_ELEMENTS':
    case 'LOAD_SCENE':
    case 'UPDATE_ELEMENT':
    case 'EDIT_TEXT':
    case 'SET_SHAPE_LABEL':
    case 'RENAME_LAYER':
      return true;
    case 'RESIZE_ELEMENT':
      return command.points !== undefined;
    case 'PATCH_ELEMENTS':
      return command.create !== undefined || command.update !== undefined;
    default:
      return false;
  }
}

/**
 * Whether every element the reducer created or changed is valid. The reducer
 * keeps the objects of the elements it leaves alone, so only the new objects
 * are checked.
 */
function changedElementsValid(before: Scene, after: Scene): boolean {
  if (after.elements === before.elements) return true;
  const kept = new Set<unknown>(before.elements);
  return after.elements.every((el) => kept.has(el) || isValidElement(el));
}
