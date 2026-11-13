import type { Command } from '../commands/commands';
import type { AppState } from '../core/app_state';
import { createScene, type Scene } from '../core/scene';
import { isEphemeralCommand } from './ephemeral';
import { reducer } from './reducer';
import {
  buildRevertPatch,
  composeChange,
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
    if (!drag.touched) {
      this.future = drag.future;
      return;
    }
    rebaseIndices(drag.change, drag.sceneBefore, this._present);
    this.past.push({
      change: drag.change,
      appStateBefore: drag.appStateBefore,
      appStateAfter: this._present.appState,
    });
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
      appState: { ...appState, lastCreatedId: null, justCreatedText: false },
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
    if (
      this.readOnly &&
      (!isEphemeralCommand(command.type) ||
        command.type === 'SET_JUST_CREATED_TEXT')
    )
      return;
    // Commands that target the local selection carry its ids from here on,
    // so a shared session changes the SAME elements on every client.
    const resolved = withTargets(this._present, command);
    const next = reducer(this._present, resolved);
    if (next === this._present) return;

    if (!isEphemeralCommand(resolved.type)) {
      const step = diffScenes(this._present, next);
      if (this.drag) {
        composeChange(this.drag.change, step);
        this.drag.touched = true;
      } else {
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
 * Restore the per-user appState recorded with an undo step (e.g. the font size
 * default a command changed), keeping view and tool state as they are now.
 * The selection stays as-is unless `selectedIds` is given (cancelled drag);
 * either way it is limited to elements that still exist.
 */
function restoreLocalState(
  scene: Scene,
  appState: AppState,
  selectedIds: ReadonlySet<string> = scene.selectedIds,
): Scene {
  const elementIds = new Set(scene.elements.map((element) => element.id));
  const current = scene.appState;
  const currentLastCreatedId = current.lastCreatedId;

  return {
    ...scene,
    selectedIds: new Set([...selectedIds].filter((id) => elementIds.has(id))),
    appState: {
      ...appState,
      activeTool: current.activeTool,
      strokeColor: current.strokeColor,
      fillColor: current.fillColor,
      strokeWidth: current.strokeWidth,
      gridVisible: current.gridVisible,
      gridType: current.gridType,
      toolLocked: current.toolLocked,
      justCreatedText: current.justCreatedText,
      lastCreatedId:
        currentLastCreatedId && elementIds.has(currentLastCreatedId)
          ? currentLastCreatedId
          : null,
    },
  };
}
