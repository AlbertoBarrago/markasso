import type { Command } from '../commands/commands';
import type { AppState } from '../core/app_state';
import { createScene, type Scene } from '../core/scene';
import { isEphemeralCommand } from './ephemeral';
import { reducer } from './reducer';
import {
  buildRevertPatch,
  composeChange,
  deepEqual,
  diffScenes,
  emptyChange,
  rebaseIndices,
  type SceneChange,
} from './scene_diff';

/**
 * Bakes the target elements into the commands that act on "the selection"
 * (APPLY_STYLE and the text font and mode commands) when they carry no `ids`.
 * In a shared session every client then changes the same elements, never
 * each peer's own selection. APPLY_STYLE without a selection targets the
 * last-created element.
 */
function withTargets(scene: Scene, command: Command): Command {
  switch (command.type) {
    case 'APPLY_STYLE': {
      if (command.ids !== undefined) return command;
      const ids =
        scene.selectedIds.size > 0
          ? [...scene.selectedIds]
          : scene.appState.lastCreatedId
            ? [scene.appState.lastCreatedId]
            : [];
      return { ...command, ids };
    }
    case 'SET_FONT_FAMILY':
    case 'SET_FONT_SIZE':
    case 'SET_TEXT_MODE':
      return command.ids !== undefined
        ? command
        : { ...command, ids: [...scene.selectedIds] };
    default:
      return command;
  }
}

type Listener = (scene: Scene) => void;

/** One undo step: the net local change plus the local appState around it. */
interface UndoEntry {
  readonly change: SceneChange;
  readonly appStateBefore: AppState;
  readonly appStateAfter: AppState;
}

/** A drag (move/resize/rotate) in progress, folded into a single undo step. */
interface DragState {
  readonly change: SceneChange;
  readonly sceneBefore: Scene;
  readonly appStateBefore: AppState;
  readonly selectedIdsBefore: ReadonlySet<string>;
  /** Redo stack set aside at drag start, restored if the drag changes nothing. */
  readonly future: UndoEntry[];
  touched: boolean;
}

/**
 * Undo/redo stack plus the single entry point for state changes.
 *
 * Undo is per-user: steps record what THIS client changed (see scene_diff.ts)
 * and undo/redo/cancel emit a PATCH_ELEMENTS command through `onCommand`, so in
 * a live session peers apply the same patch and edits made by others survive.
 */
export class History {
  readOnly = false;

  /** Replace a document snapshot without retaining undo entries from another board. */
  replaceScene(elements: Scene['elements'], viewport: Scene['viewport']): void {
    this.past = [];
    this.future = [];
    this.drag = null;
    this._present = {
      ...createScene(),
      elements,
      viewport,
      appState: this._present.appState,
    };
    this.notify();
  }

  private past: UndoEntry[] = [];
  private _present: Scene;
  private future: UndoEntry[] = [];
  private listeners: Listener[] = [];
  private drag: DragState | null = null;

  constructor(
    initial: Scene = createScene(),
    private onCommand?: (command: Command) => void,
  ) {
    this._present = initial;
  }

  get present(): Scene {
    return this._present;
  }

  /** True between beginDrag and endDrag (or cancelDrag). */
  get isDragging(): boolean {
    return this.drag !== null;
  }

  /** Call at the start of a drag (move/resize/rotate). Every command until
   *  endDrag folds into one undo step, so the drag undoes in a single Ctrl+Z. */
  beginDrag(): void {
    if (this.readOnly) return;
    if (this.drag) return;
    this.drag = {
      change: emptyChange(),
      sceneBefore: this._present,
      appStateBefore: this._present.appState,
      selectedIdsBefore: this._present.selectedIds,
      future: this.future,
      touched: false,
    };
    this.future = [];
  }

  /** Call at the end of a drag. Records the undo step if anything changed. */
  endDrag(): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    // The commands of the drag notified while it was open, before the undo
    // and redo stacks were settled: notify once more when they change, so
    // undo/redo buttons follow.
    if (!drag.touched) {
      this.future = drag.future;
      if (drag.future.length > 0) this.notify();
      return;
    }
    rebaseIndices(drag.change, drag.sceneBefore, this._present);
    this.past.push({
      change: drag.change,
      appStateBefore: drag.appStateBefore,
      appStateAfter: this._present.appState,
    });
    this.notify();
  }

  /** Cancel an in-progress drag and revert what it changed. Edits peers made
   *  during the drag are kept, and the revert is broadcast. */
  cancelDrag(): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.future = drag.future;
    rebaseIndices(drag.change, drag.sceneBefore, this._present);
    this.revert(
      drag.change,
      'undo',
      drag.appStateBefore,
      drag.selectedIdsBefore,
    );
  }

  /** Set/replace the outbound hook used to forward local commands (e.g. to a
   *  realtime session), including the patches undo/redo produce. Ephemeral
   *  filtering is left to the consumer. */
  setOnCommand(cb?: (command: Command) => void): void {
    this.onCommand = cb;
  }

  /** Apply a command received from the network. Runs the same deterministic
   *  reducer for convergence but does NOT touch the undo/redo stack (other
   *  people's actions must not pollute your undo history) and does NOT
   *  re-broadcast it via onCommand (avoids echo loops). */
  applyRemote(command: Command): void {
    if (this.readOnly) return;
    // `isRemote` keeps per-user appState defaults (colors, stroke width, font)
    // local: remote clients apply the element changes but never inherit the
    // sender's default style.
    const next = reducer(this._present, command, true);
    if (next === this._present) return;
    this._present = next;
    this.notify();
  }

  /**
   * Replaces the board with the room's (used when joining or rejoining a live
   * room: the room's log is authoritative), then notifies once. Clears undo.
   *
   * Only the board is replaced: the tool, the default style and the grid are
   * this user's own and survive a join or a reconnect. The viewport survives
   * too unless `keepViewport` is false.
   */
  resetForLiveReplay(commands: readonly Command[], keepViewport = true): void {
    if (this.readOnly) return;
    const { viewport, appState } = this._present;
    this.past = [];
    this.future = [];
    this.drag = null;
    const fresh = createScene();
    let scene: Scene = {
      ...fresh,
      // These two point at elements of the board being replaced.
      appState: { ...appState, lastCreatedId: null },
      viewport: keepViewport ? viewport : fresh.viewport,
    };
    for (const command of commands) {
      // One command the reducer cannot apply must not cost the rest of the
      // board: skip it and keep replaying.
      try {
        scene = reducer(scene, command, true);
      } catch (error) {
        console.error('Skipped a live command that failed to apply', error);
      }
    }
    this._present = scene;
    this.notify();
  }

  dispatch(command: Command): void {
    if (this.readOnly && !isEphemeralCommand(command.type)) return;
    // Commands that target the local selection carry its ids from here on,
    // so a shared session changes the SAME elements on every client.
    const resolved = withTargets(this._present, command);
    const next = reducer(this._present, resolved);
    if (next === this._present) return;

    if (!isEphemeralCommand(resolved.type)) {
      const step = diffScenes(this._present, next);
      // A command that changes nothing undo would bring back (no element, no
      // order, only appState fields undo keeps as they are) is no step: it
      // would make Ctrl+Z look dead and drop the redo stack.
      const undoable = isUndoableChange(step, this._present, next);
      if (this.drag) {
        composeChange(this.drag.change, step);
        if (undoable) this.drag.touched = true;
      } else if (undoable) {
        this.past.push({
          change: step,
          appStateBefore: this._present.appState,
          appStateAfter: next.appState,
        });
        this.future = [];
      }
    }

    this._present = next;
    this.onCommand?.(resolved);
    this.notify();
  }

  undo(): void {
    if (this.readOnly) return;
    if (this.drag) {
      this.cancelDrag();
      return;
    }
    const entry = this.past.pop();
    if (!entry) return;
    this.future.push(entry);
    this.revert(entry.change, 'undo', entry.appStateBefore);
  }

  redo(): void {
    if (this.readOnly) return;
    if (this.drag) {
      this.cancelDrag();
      return;
    }
    const entry = this.future.pop();
    if (!entry) return;
    this.past.push(entry);
    this.revert(entry.change, 'redo', entry.appStateAfter);
  }

  canUndo(): boolean {
    return !this.readOnly && this.past.length > 0;
  }
  canRedo(): boolean {
    return !this.readOnly && this.future.length > 0;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private notify(): void {
    for (const l of this.listeners) l(this._present);
  }

  /** Move the scene across `change` (see buildRevertPatch), restore the local
   *  appState of that side, and broadcast the element patch. */
  private revert(
    change: SceneChange,
    direction: 'undo' | 'redo',
    appState: AppState,
    selectedIds?: ReadonlySet<string>,
  ): void {
    const patch = buildRevertPatch(change, this._present, direction);
    const patched = patch ? reducer(this._present, patch) : this._present;
    this._present = restoreLocalState(patched, appState, selectedIds);
    if (patch) this.onCommand?.(patch);
    this.notify();
  }
}

/**
 * appState fields undo and redo leave as they are now: the tool and the
 * default style, which the tool switch and the style panel also set without
 * an undo step (SET_TOOL inherits the selection's style and sets the shape
 * kind), and view settings. Restoring them would undo choices the user made
 * after the step. The text defaults (font size and family, alignment, mode)
 * and the line routing are restored.
 */
const KEPT_ON_UNDO = [
  'activeTool',
  'strokeColor',
  'fillColor',
  'strokeWidth',
  'opacity',
  'roughness',
  'strokeStyle',
  'shapeKind',
  'gridVisible',
  'gridType',
  'toolLocked',
] as const satisfies ReadonlyArray<keyof AppState>;

const KEPT_ON_UNDO_SET: ReadonlySet<string> = new Set([
  ...KEPT_ON_UNDO,
  // Restored separately: kept only while its element exists.
  'lastCreatedId',
]);

/**
 * Whether a change is worth an undo step: it touches elements or their order,
 * or an appState field that undo restores. An element change the diff leaves
 * out (a type-only change: the type is identity there) still counts, so the
 * board is never changed without a step.
 */
function isUndoableChange(
  change: SceneChange,
  prev: Scene,
  next: Scene,
): boolean {
  if (change.elements.size > 0 || change.order) return true;
  if (!sameElements(prev.elements, next.elements)) return true;
  const before = prev.appState;
  const after = next.appState;
  return (Object.keys(after) as Array<keyof AppState>).some(
    (key) => !KEPT_ON_UNDO_SET.has(key) && after[key] !== before[key],
  );
}

/** Same elements in the same order, by value (unchanged ones keep identity). */
function sameElements(a: Scene['elements'], b: Scene['elements']): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((el, i) => el === b[i] || deepEqual(el, b[i]));
}

/**
 * Restore the per-user appState recorded with an undo step (e.g. the font size
 * default a command changed), keeping the fields in KEPT_ON_UNDO as they are
 * now. The selection stays as-is unless `selectedIds` is given (cancelled
 * drag); either way it is limited to elements that still exist.
 */
function restoreLocalState(
  scene: Scene,
  appState: AppState,
  selectedIds: ReadonlySet<string> = scene.selectedIds,
): Scene {
  const elementIds = new Set(scene.elements.map((element) => element.id));
  const current = scene.appState;
  const kept: Partial<Record<keyof AppState, unknown>> = {};
  for (const key of KEPT_ON_UNDO) kept[key] = current[key];
  const currentLastCreatedId = current.lastCreatedId;

  return {
    ...scene,
    selectedIds: new Set([...selectedIds].filter((id) => elementIds.has(id))),
    appState: {
      ...appState,
      ...(kept as Partial<AppState>),
      lastCreatedId:
        currentLastCreatedId && elementIds.has(currentLastCreatedId)
          ? currentLastCreatedId
          : null,
    },
  };
}
