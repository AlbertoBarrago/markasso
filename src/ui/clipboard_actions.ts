import {
  ELEMENT_CLIPBOARD_MIME,
  ELEMENT_CLIPBOARD_TEXT_PREFIX,
  serializeElementClipboard,
} from '../core/clipboard';
import { cloneElementsWithOffset } from '../elements/clone';
import type { History } from '../engine/history';
import { validateElements } from '../io/element_validation';
import { elementsToSVG, renderElementsPNG } from '../rendering/export';
import { selectedElements } from './style_state';

/**
 * Element copy, cut and paste, shared by the keyboard (the document `copy`
 * and `paste` events, see shortcuts.ts) and the context menu.
 */

/** Consecutive pastes of the same copy step further away from the source. */
let pasteCount = 0;

/**
 * Writes the selection to a clipboard event's data. Returns false when there
 * is nothing selected, so the browser's own copy goes ahead.
 */
export function writeSelectionToClipboardData(
  history: History,
  data: DataTransfer,
): boolean {
  const selected = selectedElements(history.present);
  if (selected.length === 0) return false;
  const serialized = serializeElementClipboard(selected);
  data.setData('text/plain', `${ELEMENT_CLIPBOARD_TEXT_PREFIX}${serialized}`);
  try {
    data.setData(ELEMENT_CLIPBOARD_MIME, serialized);
  } catch {
    // The text fallback keeps element paste working on restricted browsers.
  }
  pasteCount = 0;
  return true;
}

/**
 * The serialized elements in clipboard data (custom type, or the prefixed
 * text fallback), or an empty string when it holds something else.
 */
export function elementPayloadFrom(custom: string, text: string): string {
  if (custom) return custom;
  return text.startsWith(ELEMENT_CLIPBOARD_TEXT_PREFIX)
    ? text.slice(ELEMENT_CLIPBOARD_TEXT_PREFIX.length)
    : '';
}

/**
 * Pastes serialized elements with a growing offset. Returns false when the
 * payload is not a valid Markasso element list (the caller then lets other
 * paste handlers run).
 */
export function pasteElementPayload(
  history: History,
  serialized: string,
): boolean {
  if (!serialized) return false;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(serialized) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (payload.version !== 1) return false;
  const elements = validateElements(payload.elements);
  if (!elements || elements.length === 0) return false;
  pasteCount += 1;
  const offset = pasteCount * 20;
  history.dispatch({
    type: 'CREATE_ELEMENTS',
    elements: cloneElementsWithOffset(elements, offset, offset),
  });
  return true;
}

/**
 * Copies the selection from a menu: `execCommand('copy')` fires the document
 * `copy` event inside the click's user activation, so the keyboard path
 * writes the data. Returns false when the browser refused.
 */
export function copySelection(history: History): boolean {
  if (selectedElements(history.present).length === 0) return false;
  return document.execCommand('copy');
}

/** Copies the selection, then deletes its unlocked elements. */
export function cutSelection(history: History): void {
  if (!copySelection(history)) return;
  const ids = selectedElements(history.present)
    .filter((el) => !el.locked)
    .map((el) => el.id);
  if (ids.length > 0) history.dispatch({ type: 'DELETE_ELEMENTS', ids });
}

/**
 * Pastes Markasso elements from the system clipboard, for a menu (no paste
 * event there). The browser may ask for permission the first time.
 * @throws when the clipboard cannot be read; the caller reports it.
 */
export async function pasteFromSystemClipboard(
  history: History,
): Promise<boolean> {
  const text = await navigator.clipboard.readText();
  return pasteElementPayload(history, elementPayloadFrom('', text));
}

/** Copies the selection as a PNG image (2x, transparent background). */
export async function copySelectionAsPNG(history: History): Promise<void> {
  const blob = await renderElementsPNG(selectedElements(history.present));
  if (!blob) return;
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

/** Copies the selection as SVG markup (transparent background). */
export async function copySelectionAsSVG(history: History): Promise<void> {
  const svg = elementsToSVG(selectedElements(history.present));
  if (svg) await navigator.clipboard.writeText(svg);
}
