import { measureTextBounds } from '../core/text_measure';
import { cloneElementsWithOffset } from '../elements/clone';
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
 * Sets the font size; a selected text element is resized to fit it. Sizes
 * outside 6 to 400 are ignored.
 */
export function applyFontSize(history: History, size: number): void {
  if (Number.isNaN(size) || size < 6 || size > 400) return;
  const scene = history.present;
  const selectedText = scene.elements.find(
    (el) => scene.selectedIds.has(el.id) && el.type === 'text',
  );
  const bounds =
    selectedText?.type === 'text'
      ? measureTextBounds(
          selectedText.content,
          size,
          selectedText.fontFamily,
          selectedText.bold,
          selectedText.padding,
        )
      : undefined;
  history.dispatch({
    type: 'SET_FONT_SIZE',
    size,
    ...(bounds !== undefined && {
      width: bounds.width,
      height: bounds.height,
    }),
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

export function deleteSelection(history: History): void {
  const ids = [...history.present.selectedIds];
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
