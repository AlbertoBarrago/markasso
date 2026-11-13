import { measureTextBounds } from '../core/text_measure';
import { cloneElementsWithOffset } from '../elements/clone';
import {
  applyStyleCommand,
  captureStyle,
  type StyleSnapshot,
} from '../elements/style_snapshot';
import type { History } from '../engine/history';
import {
  hasShapeLabel,
  selectedElements,
  type TextFormatKey,
} from './style_state';

/**
 * Style and arrange commands shared by the context panel and the floating
 * style bar, so both go through the same dispatches and undo steps.
 */

/**
 * Whether a swatch preset shows as the current color. Colors are compared
 * case-insensitively, so a hex typed in the picker still marks its preset.
 */
export function isSwatchActive(preset: string, current: string): boolean {
  return preset.toLowerCase() === current.toLowerCase();
}

/** True while the text tool edits the labels of the selected shapes. */
function isEditingLabelColor(history: History): boolean {
  const scene = history.present;
  return (
    scene.appState.activeTool === 'text' &&
    selectedElements(scene).some(hasShapeLabel)
  );
}

/** Applies `color` as the stroke, or as the label color while editing labels. */
export function applyStrokeOrLabelColor(history: History, color: string): void {
  history.dispatch(
    isEditingLabelColor(history)
      ? { type: 'APPLY_STYLE', labelColor: color }
      : { type: 'APPLY_STYLE', strokeColor: color },
  );
}

/**
 * Sets the font size; each selected text element is resized to fit its own
 * content at that size. Sizes outside 6 to 400 are ignored.
 */
export function applyFontSize(history: History, size: number): void {
  if (Number.isNaN(size) || size < 6 || size > 400) return;
  const bounds = selectedElements(history.present).flatMap((el) => {
    if (el.type !== 'text') return [];
    const box = measureTextBounds(
      el.content,
      size,
      el.fontFamily,
      el.bold,
      el.padding,
    );
    return [{ id: el.id, width: box.width, height: box.height }];
  });
  history.dispatch({
    type: 'SET_FONT_SIZE',
    size,
    ...(bounds.length > 0 && { bounds }),
  });
}

/** Toggles a text format, reading the current value from the first text. */
export function toggleTextFormat(history: History, key: TextFormatKey): void {
  const firstText = selectedElements(history.present).find(
    (el) => el.type === 'text',
  );
  const current = firstText?.type === 'text' ? !!firstText[key] : false;
  history.dispatch({ type: 'APPLY_STYLE', [key]: !current });
}

export type LayerMove = 'back' | 'backward' | 'forward' | 'front';

/** Moves the selection in the stacking order, relative to its first element. */
export function reorderSelection(history: History, move: LayerMove): void {
  const scene = history.present;
  const ids = [...scene.selectedIds];
  if (ids.length === 0) return;
  const currentIndex = scene.elements.findIndex((el) => el.id === ids[0]);
  let targetIndex = currentIndex;
  if (move === 'back') targetIndex = 0;
  else if (move === 'backward') targetIndex = Math.max(0, currentIndex - 1);
  else if (move === 'forward')
    targetIndex = Math.min(scene.elements.length - 1, currentIndex + 1);
  else targetIndex = scene.elements.length - 1;
  if (targetIndex !== currentIndex) {
    history.dispatch({ type: 'REORDER_ELEMENTS', ids, targetIndex });
  }
}

/** Duplicates the selection with a small offset. */
export function duplicateSelection(history: History): void {
  const elements = selectedElements(history.present);
  const newElements = cloneElementsWithOffset(elements, 20, 20);
  if (newElements.length > 0)
    history.dispatch({ type: 'CREATE_ELEMENTS', elements: newElements });
}

/** Deletes the selection; locked elements stay, as with the Delete key. */
export function deleteSelection(history: History): void {
  const ids = selectedElements(history.present)
    .filter((el) => !el.locked)
    .map((el) => el.id);
  if (ids.length > 0) history.dispatch({ type: 'DELETE_ELEMENTS', ids });
}

/** Locks the selection, or unlocks it when every element is locked. */
export function toggleSelectionLock(history: History): void {
  const scene = history.present;
  const ids = [...scene.selectedIds];
  if (ids.length === 0) return;
  const allLocked = ids.every(
    (id) => scene.elements.find((el) => el.id === id)?.locked,
  );
  history.dispatch(
    allLocked
      ? { type: 'UNLOCK_ELEMENTS', ids }
      : { type: 'LOCK_ELEMENTS', ids },
  );
}

/** The style "Copy style" captured, for "Paste style". */
let copiedStyle: StyleSnapshot | null = null;

/** Captures the style of the first selected element for `pasteStyle`. */
export function copyStyle(history: History): void {
  const first = selectedElements(history.present)[0];
  if (first) copiedStyle = captureStyle(first);
}

export function hasCopiedStyle(): boolean {
  return copiedStyle !== null;
}

/** Applies the copied style to the selection, in one undo step. */
export function pasteStyle(history: History): void {
  if (copiedStyle === null) return;
  if (selectedElements(history.present).length === 0) return;
  history.dispatch(applyStyleCommand(copiedStyle));
}

/** Groups two or more selected elements. */
export function groupSelection(history: History): void {
  const ids = [...history.present.selectedIds];
  if (ids.length < 2) return;
  history.dispatch({
    type: 'GROUP_ELEMENTS',
    ids,
    groupId: crypto.randomUUID(),
  });
}

/** The ids of the groups the selection belongs to. */
export function selectedGroupIds(history: History): Set<string> {
  return new Set(
    selectedElements(history.present)
      .map((el) => el.groupId)
      .filter((gid): gid is string => gid !== undefined),
  );
}

/** Dissolves every group the selection belongs to. */
export function ungroupSelection(history: History): void {
  for (const groupId of selectedGroupIds(history)) {
    history.dispatch({ type: 'UNGROUP_ELEMENTS', groupId });
  }
}

export function selectAll(history: History): void {
  const ids = history.present.elements.map((el) => el.id);
  if (ids.length > 0) history.dispatch({ type: 'SELECT_ELEMENTS', ids });
}
