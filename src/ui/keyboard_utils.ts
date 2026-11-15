/** Returns true when keyboard focus is inside a UI panel (not the canvas). */
export function isFocusInPanel(): boolean {
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body) return false;

  // Keep global single-key shortcuts disabled while interacting with modal/panel UI.
  if (
    active.closest(
      '#context-panel, #floating-style-bar, .fsb-popover, #library-panel, .settings-panel, #welcome-overlay, #whats-new-overlay, #shortcuts-help',
    )
  )
    return true;

  // Toolbar buttons should not disable shortcuts (regression after a11y focus updates).
  if (active.closest('.tb-btn')) return false;

  // Non-toolbar controls in toolbar islands (e.g. export menu items) keep blocking.
  return (
    active.closest('.tb-island, .tb-island-topright, .tb-island-topleft') !==
    null
  );
}

/**
 * Returns true while a modal dialog is shown. Dialogs are either removed from
 * the DOM or hidden with `display: none` when closed, so presence alone is not
 * enough: an element with no client rects is not rendered.
 */
export function isModalDialogOpen(): boolean {
  // Native <dialog> elements opened with showModal() are modal without the
  // attribute.
  return [
    ...document.querySelectorAll('[aria-modal="true"], dialog[open]'),
  ].some(
    (el) =>
      el.getClientRects().length > 0 &&
      (el.tagName !== 'DIALOG' || isShownModally(el)),
  );
}

/** Whether an open <dialog> was opened with showModal(), not show(). */
function isShownModally(dialog: Element): boolean {
  try {
    return dialog.matches(':modal');
  } catch {
    // Engines without :modal: every dialog here is opened modally.
    return true;
  }
}

/** True when the target is a field the user types into: shortcuts and clipboard handlers leave it alone. */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable
  );
}

/** Key events that started while a modal dialog was shown. */
const dialogKeys = new WeakSet<Event>();
let trackingDialogKeys = false;

/**
 * Records, before any other handler runs (window, capture phase), whether a
 * modal dialog was open when a key went down. A dialog may close on that very
 * key (Escape) before the canvas handlers see it, and they must still leave
 * the key to the dialog.
 */
export function trackDialogKeys(): void {
  if (trackingDialogKeys) return;
  trackingDialogKeys = true;
  window.addEventListener(
    'keydown',
    (e) => {
      if (isModalDialogOpen()) dialogKeys.add(e);
    },
    true,
  );
}

/** True when the key belongs to a modal dialog, not to the canvas behind it. */
export function keyBelongsToDialog(e: Event): boolean {
  return dialogKeys.has(e) || isModalDialogOpen();
}

/**
 * Maps Cmd/Ctrl+O and Cmd/Ctrl+S to the board's file actions. Without this the
 * browser keeps its own meaning for them: Chrome's Cmd+O opens a native file
 * dialog that shows a `.markasso` file as raw JSON in a new tab, and Cmd+S
 * saves the page HTML instead of the board.
 */
export function fileShortcut(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
): 'open' | 'save' | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return null;
  const key = e.key.toLowerCase();
  if (key === 'o') return 'open';
  if (key === 's') return 'save';
  return null;
}

type KeyFields = Pick<
  KeyboardEvent,
  'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'
>;

/**
 * Bring to front / send to back: Ctrl/Cmd+Shift+] / [, or Ctrl/Cmd+Option+]
 * / [ (macOS browsers keep Cmd+Shift+] / [ for switching tabs). Matched by
 * physical key too, since Shift turns ] into } and Italian needs AltGr for it.
 */
export function reorderShortcut(e: KeyFields): 'front' | 'back' | null {
  if (!(e.ctrlKey || e.metaKey) || !(e.shiftKey || e.altKey)) return null;
  if (e.code === 'BracketRight' || e.key === ']' || e.key === '}')
    return 'front';
  if (e.code === 'BracketLeft' || e.key === '[' || e.key === '{') return 'back';
  return null;
}

/**
 * Copy / paste style: Ctrl/Cmd+Alt+C / V. Matched by physical key too: on
 * macOS Option turns C into ç and V into √.
 */
export function styleShortcut(e: KeyFields): 'copy' | 'paste' | null {
  if (!(e.ctrlKey || e.metaKey) || !e.altKey) return null;
  const key = e.key.toLowerCase();
  if (key === 'c' || e.code === 'KeyC') return 'copy';
  if (key === 'v' || e.code === 'KeyV') return 'paste';
  return null;
}

/**
 * View keys, without Ctrl/Cmd/Alt (Ctrl/Cmd+F belongs to the element
 * search): F fits all, backslash hides the UI, Shift+0 resets the zoom,
 * matched by physical key since Shift turns 0 into ) on US and = on Italian
 * layouts.
 */
export function viewShortcut(
  e: KeyFields,
): 'fitAll' | 'toggleUi' | 'resetZoom' | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === 'f' || e.key === 'F') return 'fitAll';
  if (e.key === '\\') return 'toggleUi';
  if (e.shiftKey && e.code === 'Digit0') return 'resetZoom';
  return null;
}

/**
 * True when a paste belongs to the board: not typed into a field, and not
 * made while a modal dialog is open (Cmd+V there must not add elements
 * behind it).
 */
export function pasteBelongsToBoard(e: Pick<Event, 'target'>): boolean {
  return !isEditableTarget(e.target) && !isModalDialogOpen();
}

/**
 * True when a copy or cut belongs to the browser: text is selected, the
 * focus is in a field, or a modal dialog is open (a cut there must not
 * delete the elements behind it).
 */
export function browserOwnsClipboard(e: Pick<Event, 'target'>): boolean {
  return !pasteBelongsToBoard(e) || !!window.getSelection()?.toString();
}
