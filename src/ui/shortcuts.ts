import type { ActiveTool } from '../core/app_state';
import { ELEMENT_CLIPBOARD_MIME } from '../core/clipboard';
import { fitToElements } from '../core/viewport';
import type { History } from '../engine/history';
import { exportMarkasso } from '../io/markasso';
import type { SelectTool } from '../tools/select_tool';
import type { HistoryActions } from './canvas_gesture';
import {
  elementPayloadFrom,
  pasteElementPayload,
  writeSelectionToClipboardData,
} from './clipboard_actions';
import {
  fileShortcut,
  isFocusInPanel,
  isModalDialogOpen,
} from './keyboard_utils';
import { toggleLibrary } from './library_panel';
import { toggleMinimap } from './settings';
import {
  copyStyle,
  duplicateSelection,
  groupSelection,
  pasteStyle,
  selectAll,
  toggleSelectionLock,
  ungroupSelection,
} from './style_actions';
import { selectedElements } from './style_state';
import { zoomIn, zoomOut } from './toolbar';

// The Plus and Minus keys sit on different physical keys per layout (e.g.
// BracketRight and Slash on Italian), and on US layouts Plus is Shift+=, so
// Ctrl+Plus/Minus is matched by physical key as well: the codes whose
// unmodified character is + / = or -, from the layout map where supported
// and from plain key presses otherwise.
const zoomInCodes = new Set(['Equal', 'NumpadAdd']);
const zoomOutCodes = new Set(['Minus', 'NumpadSubtract']);

interface KeyboardLayoutApi {
  getLayoutMap(): Promise<Map<string, string>>;
}
void (navigator as Navigator & { keyboard?: KeyboardLayoutApi }).keyboard
  ?.getLayoutMap()
  .then((layout) => {
    zoomInCodes.clear();
    zoomOutCodes.clear();
    zoomInCodes.add('NumpadAdd');
    zoomOutCodes.add('NumpadSubtract');
    for (const [code, char] of layout) {
      if (char === '+' || char === '=') zoomInCodes.add(code);
      else if (char === '-') zoomOutCodes.add(code);
    }
  })
  .catch(() => {
    /* keep the US-layout defaults */
  });

// Only + and -: on some layouts = is Shift+0, which must stay Reset zoom.
function learnZoomKey(e: KeyboardEvent): void {
  if (e.key === '+') {
    zoomOutCodes.delete(e.code);
    zoomInCodes.add(e.code);
  } else if (e.key === '-') {
    zoomInCodes.delete(e.code);
    zoomOutCodes.add(e.code);
  }
}

function zoomKeyDirection(e: KeyboardEvent): 'in' | 'out' | null {
  if (zoomInCodes.has(e.code) || e.key === '+') return 'in';
  if (zoomOutCodes.has(e.code) || e.key === '-') return 'out';
  return null;
}

export function initShortcuts(
  history: History,
  selectTool: SelectTool,
  openPreferences: () => void,
  openFile: () => void,
  historyActions: HistoryActions = history,
): void {
  const shortcuts = new Map<string, () => void>([
    ['h', () => history.dispatch({ type: 'SET_TOOL', tool: 'hand' })],
    ['v', () => history.dispatch({ type: 'SET_TOOL', tool: 'select' })],
    ['1', () => history.dispatch({ type: 'SET_TOOL', tool: 'select' })],
    ['r', () => history.dispatch({ type: 'SET_TOOL', tool: 'rectangle' })],
    ['2', () => history.dispatch({ type: 'SET_TOOL', tool: 'rectangle' })],
    ['e', () => history.dispatch({ type: 'SET_TOOL', tool: 'ellipse' })],
    ['4', () => history.dispatch({ type: 'SET_TOOL', tool: 'ellipse' })],
    ['a', () => history.dispatch({ type: 'SET_TOOL', tool: 'line' })],
    ['5', () => history.dispatch({ type: 'SET_TOOL', tool: 'line' })],
    ['l', () => history.dispatch({ type: 'SET_TOOL', tool: 'line' })],
    ['p', () => history.dispatch({ type: 'SET_TOOL', tool: 'freehand' })],
    ['6', () => history.dispatch({ type: 'SET_TOOL', tool: 'freehand' })],
    ['t', () => history.dispatch({ type: 'SET_TOOL', tool: 'text' })],
    ['7', () => history.dispatch({ type: 'SET_TOOL', tool: 'text' })],
    ['n', () => history.dispatch({ type: 'SET_TOOL', tool: 'sticky' })],
    ['d', () => history.dispatch({ type: 'SET_TOOL', tool: 'rombo' })],
    ['3', () => history.dispatch({ type: 'SET_TOOL', tool: 'rombo' })],
    ['s', () => history.dispatch({ type: 'SET_TOOL', tool: 'shape' })],
    ['i', () => toggleLibrary()],
    ['0', () => history.dispatch({ type: 'SET_TOOL', tool: 'eraser' })],
    ['g', () => history.dispatch({ type: 'TOGGLE_GRID' })],
    ['m', () => toggleMinimap()],
  ]);

  // Space bar handling: hold to activate hand tool temporarily
  let spacePressed = false;
  let previousTool: ActiveTool | null = null;

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key === ',') {
      e.preventDefault();
      // The menu would open on top of the dialog, behind its overlay.
      if (isModalDialogOpen()) return;
      openPreferences();
      return;
    }
    // Checked before the text-field guard on purpose: the browser's own
    // Open/Save would otherwise win while a label is being edited.
    const fileAction = fileShortcut(e);
    if (fileAction) {
      e.preventDefault();
      if (isModalDialogOpen()) return;
      if (fileAction === 'open') openFile();
      else exportMarkasso(history.present);
      return;
    }
    // Don't capture shortcuts when typing in an input/textarea/select/contenteditable
    const target = e.target as HTMLElement;
    if (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' ||
      target.isContentEditable
    )
      return;

    // Ctrl+Plus / Ctrl+Minus — same as the toolbar zoom buttons; this also
    // keeps the browser from zooming the page.
    if (!e.ctrlKey && !e.altKey && !e.metaKey) learnZoomKey(e);
    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      const dir = zoomKeyDirection(e);
      if (dir) {
        e.preventDefault();
        if (dir === 'in') zoomIn(history);
        else zoomOut(history);
        return;
      }
    }

    // Block single-key shortcuts when focus is inside a UI panel; allow modifier combos (Ctrl/Cmd+…)
    if (isFocusInPanel() && !e.ctrlKey && !e.metaKey) return;

    // Space bar: activate hand tool while pressed
    if (e.key === ' ' && !e.ctrlKey && !e.metaKey) {
      // Keep native Space activation on focused controls (buttons/menu items).
      // This avoids stealing Space from toolbar buttons after a11y focus updates.
      if (target.closest('button, [role="button"], [role="menuitem"]')) return;
      e.preventDefault();
      if (!spacePressed) {
        spacePressed = true;
        previousTool = history.present.appState.activeTool;
        history.dispatch({ type: 'SET_TOOL', tool: 'hand' });
      }
      return;
    }

    // Escape: tool switch or delegate group exit to SelectTool
    if (e.key === 'Escape') {
      if (history.present.appState.activeTool !== 'select') {
        history.dispatch({ type: 'SET_TOOL', tool: 'select' });
      }
      // SelectTool.onKeyDown handles CLEAR_SELECTION and group exit
      return;
    }

    const key = e.key.toLowerCase();
    if (
      (e.ctrlKey || e.metaKey) &&
      (key === 'y' || (e.shiftKey && key === 'z'))
    ) {
      e.preventDefault();
      historyActions.redo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && key === 'z') {
      e.preventDefault();
      historyActions.undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && key === 'a') {
      e.preventDefault();
      selectAll(history);
      return;
    }

    // Delete/Backspace alone — delete selected unlocked elements.
    // Escape is the non-destructive way to clear selection.
    if (
      (e.key === 'Delete' || e.key === 'Backspace') &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.shiftKey &&
      !e.altKey
    ) {
      e.preventDefault();
      const scene = history.present;
      const ids = [...scene.selectedIds].filter((id) => {
        const el = scene.elements.find((el) => el.id === id);
        return el && !el.locked;
      });
      if (ids.length > 0) {
        history.dispatch({ type: 'DELETE_ELEMENTS', ids });
      }
      history.dispatch({ type: 'SET_TOOL', tool: 'select' });
      return;
    }

    // Cmd/Ctrl+Delete/Backspace — delete selected elements regardless of active tool
    if (
      (e.metaKey || e.ctrlKey) &&
      (e.key === 'Delete' || e.key === 'Backspace')
    ) {
      const scene = history.present;
      const ids = [...scene.selectedIds].filter((id) => {
        const el = scene.elements.find((el) => el.id === id);
        return el && !el.locked;
      });
      if (ids.length > 0) {
        e.preventDefault();
        history.dispatch({ type: 'DELETE_ELEMENTS', ids });
        return;
      }
    }

    // Ctrl+D — duplicate selected elements with a small offset
    if ((e.ctrlKey || e.metaKey) && key === 'd') {
      e.preventDefault();
      duplicateSelection(history);
      return;
    }

    // Ctrl+Alt+C (Cmd+Alt+C): copy the style of the first selected element,
    // for Ctrl+Alt+V and for the format painter (the next click applies it).
    if ((e.ctrlKey || e.metaKey) && e.altKey && key === 'c') {
      e.preventDefault();
      const first = selectedElements(history.present)[0];
      if (first) {
        copyStyle(history);
        selectTool.activateFormatPainter(first);
      }
      return;
    }

    // Ctrl+Alt+V (Cmd+Alt+V): paste the copied style on the selection
    if ((e.ctrlKey || e.metaKey) && e.altKey && key === 'v') {
      e.preventDefault();
      selectTool.formatPainterActive = false;
      pasteStyle(history);
      return;
    }

    // Ctrl+Shift+] — bring to front
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === ']') {
      e.preventDefault();
      const scene = history.present;
      const ids = [...scene.selectedIds];
      if (ids.length > 0) {
        history.dispatch({
          type: 'REORDER_ELEMENTS',
          ids,
          targetIndex: scene.elements.length,
        });
      }
      return;
    }

    // Ctrl+Shift+[ — send to back
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === '[') {
      e.preventDefault();
      const scene = history.present;
      const ids = [...scene.selectedIds];
      if (ids.length > 0) {
        history.dispatch({ type: 'REORDER_ELEMENTS', ids, targetIndex: 0 });
      }
      return;
    }

    // Ctrl+G — group selected elements
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && key === 'g') {
      e.preventDefault();
      groupSelection(history);
      return;
    }

    // Ctrl+Shift+G — ungroup
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && key === 'g') {
      e.preventDefault();
      ungroupSelection(history);
      selectTool.activeGroupId = null;
      return;
    }

    // Ctrl+Shift+L — toggle lock on selected elements (e.code = layout-independent)
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyL') {
      e.preventDefault();
      toggleSelectionLock(history);
      return;
    }

    if (e.key === '\\') {
      document.body.classList.toggle('ui-hidden');
      return;
    }

    if (e.key === 'f' || e.key === 'F') {
      const vp = fitToElements(
        history.present.elements,
        window.innerWidth,
        window.innerHeight,
      );
      history.dispatch({
        type: 'SET_VIEWPORT',
        offsetX: vp.offsetX,
        offsetY: vp.offsetY,
        zoom: vp.zoom,
      });
      return;
    }
    if (e.key === '0' && e.shiftKey) {
      history.dispatch({
        type: 'SET_VIEWPORT',
        offsetX: 0,
        offsetY: 0,
        zoom: 1,
      });
      return;
    }

    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      const fn = shortcuts.get(e.key.toLowerCase());
      if (fn) {
        // A shortcut may move focus to an input (e.g. `I` focuses the library
        // search): without this the key itself would be typed into it.
        e.preventDefault();
        fn();
      }
    }
  });

  // Release space bar: restore previous tool
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ' && spacePressed) {
      spacePressed = false;
      if (previousTool && previousTool !== 'hand') {
        history.dispatch({ type: 'SET_TOOL', tool: previousTool });
        previousTool = null;
      }
    }
  });

  document.addEventListener('copy', (e) => {
    if (window.getSelection()?.toString() || !e.clipboardData) return;
    if (writeSelectionToClipboardData(history, e.clipboardData))
      e.preventDefault();
  });

  document.addEventListener(
    'paste',
    (e) => {
      if (!e.clipboardData) return;
      const serialized = elementPayloadFrom(
        e.clipboardData.getData(ELEMENT_CLIPBOARD_MIME),
        e.clipboardData.getData('text/plain'),
      );
      // Anything else (images, Mermaid text) goes on to the other handlers.
      if (pasteElementPayload(history, serialized)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );
}
