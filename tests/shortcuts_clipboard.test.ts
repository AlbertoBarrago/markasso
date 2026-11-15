import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScene } from '../src/core/scene';
import type { RectangleElement } from '../src/elements/element';
import { History } from '../src/engine/history';
import { cutSelectionToClipboardData } from '../src/ui/clipboard_actions';
import { buildContextMenu } from '../src/ui/context_menu_items';
import {
  browserOwnsClipboard,
  isEditableTarget,
  isModalDialogOpen,
  keyBelongsToDialog,
  pasteBelongsToBoard,
  reorderShortcut,
  styleShortcut,
  trackDialogKeys,
  viewShortcut,
} from '../src/ui/keyboard_utils';

type Mods = Partial<
  Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>
>;
const key = (k: string, code: string, mods: Mods = {}) => ({
  key: k,
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

afterEach(() => vi.unstubAllGlobals());

describe('view keys', () => {
  it('leave Ctrl/Cmd+F to the element search', () => {
    expect(viewShortcut(key('f', 'KeyF'))).toBe('fitAll');
    expect(viewShortcut(key('F', 'KeyF', { shiftKey: true }))).toBe('fitAll');
    expect(viewShortcut(key('f', 'KeyF', { metaKey: true }))).toBeNull();
    expect(viewShortcut(key('f', 'KeyF', { ctrlKey: true }))).toBeNull();
    expect(viewShortcut(key('\\', 'Backslash', { metaKey: true }))).toBeNull();
    expect(viewShortcut(key('\\', 'Backslash'))).toBe('toggleUi');
  });

  it('reset the zoom on Shift+0 whatever the layout makes of it', () => {
    // US gives ")", Italian "=", with Shift held.
    for (const k of [')', '=', '0']) {
      expect(viewShortcut(key(k, 'Digit0', { shiftKey: true }))).toBe(
        'resetZoom',
      );
    }
    expect(viewShortcut(key('0', 'Digit0'))).toBeNull();
  });
});

describe('reorder keys', () => {
  it('match the bracket keys by position, with Shift or Option', () => {
    // US with Shift gives braces.
    expect(
      reorderShortcut(
        key('}', 'BracketRight', { metaKey: true, shiftKey: true }),
      ),
    ).toBe('front');
    expect(
      reorderShortcut(
        key('{', 'BracketLeft', { ctrlKey: true, shiftKey: true }),
      ),
    ).toBe('back');
    // macOS: Option+Cmd, where Option composes another character.
    expect(
      reorderShortcut(
        key('‘', 'BracketRight', { metaKey: true, altKey: true }),
      ),
    ).toBe('front');
    expect(reorderShortcut(key(']', 'BracketRight', { metaKey: true }))).toBe(
      null,
    );
  });
});

describe('style keys', () => {
  it('match Option+Cmd+C / V although Option composes the letter', () => {
    expect(
      styleShortcut(key('ç', 'KeyC', { metaKey: true, altKey: true })),
    ).toBe('copy');
    expect(
      styleShortcut(key('√', 'KeyV', { metaKey: true, altKey: true })),
    ).toBe('paste');
    expect(styleShortcut(key('c', 'KeyC', { metaKey: true }))).toBeNull();
  });
});

describe('context menu labels', () => {
  it('show Option+Cmd for the order keys on a Mac', () => {
    const rect: RectangleElement = {
      id: 'r',
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      strokeColor: '#000',
      fillColor: 'transparent',
      strokeWidth: 1,
      opacity: 1,
      roughness: 0,
    };
    const scene = {
      ...createScene(),
      elements: [rect],
      selectedIds: new Set(['r']),
    };
    const shortcutOf = (isMac: boolean, action: string) =>
      buildContextMenu(scene, { hasCopiedStyle: false, isMac })
        .flat()
        .find((item) => item.action === action)?.shortcut;
    expect(shortcutOf(true, 'bringToFront')).toBe('⌥⌘]');
    expect(shortcutOf(true, 'sendToBack')).toBe('⌥⌘[');
    expect(shortcutOf(false, 'bringToFront')).toBe('Ctrl+Shift+]');
  });
});

describe('editable targets', () => {
  it('cover every field the user types into', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(isEditableTarget({ tagName } as unknown as EventTarget)).toBe(
        true,
      );
    }
    expect(
      isEditableTarget({
        tagName: 'DIV',
        isContentEditable: true,
      } as unknown as EventTarget),
    ).toBe(true);
    expect(
      isEditableTarget({
        tagName: 'BUTTON',
        isContentEditable: false,
      } as unknown as EventTarget),
    ).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  it('leave copy, cut and paste to the browser in a field, on selected text or behind a dialog', () => {
    let selected = '';
    let dialogOpen = false;
    vi.stubGlobal('window', {
      getSelection: () => ({ toString: () => selected }),
    });
    vi.stubGlobal('document', {
      querySelectorAll: () =>
        dialogOpen ? [{ tagName: 'DIV', getClientRects: () => [{}] }] : [],
    });
    const canvas = { tagName: 'CANVAS' } as unknown as EventTarget;
    const button = { tagName: 'BUTTON' } as unknown as EventTarget;
    const field = { tagName: 'TEXTAREA' } as unknown as EventTarget;
    expect(browserOwnsClipboard({ target: canvas })).toBe(false);
    expect(pasteBelongsToBoard({ target: canvas })).toBe(true);
    expect(browserOwnsClipboard({ target: field })).toBe(true);
    expect(pasteBelongsToBoard({ target: field })).toBe(false);
    // A dialog's button has the focus: Cmd+X must not cut the board behind.
    dialogOpen = true;
    expect(browserOwnsClipboard({ target: button })).toBe(true);
    expect(pasteBelongsToBoard({ target: button })).toBe(false);
    dialogOpen = false;
    selected = 'some text';
    expect(browserOwnsClipboard({ target: canvas })).toBe(true);
  });
});

describe('modal dialogs', () => {
  /** A minimal window and document with one dialog that can open and close. */
  function stubDom() {
    const win = new EventTarget();
    vi.stubGlobal('window', win);
    let open = false;
    const dialog = {
      tagName: 'DIV',
      getClientRects: () => (open ? [{}] : []),
    };
    const nativeDialog = {
      tagName: 'DIALOG',
      getClientRects: () => [{}],
      matches: (selector: string) => {
        if (selector === ':modal') throw new Error('unsupported');
        return false;
      },
    };
    let natives: unknown[] = [];
    vi.stubGlobal('document', {
      querySelectorAll: () => [dialog, ...natives],
    });
    return {
      win,
      setOpen: (value: boolean) => {
        open = value;
      },
      openNative: () => {
        natives = [nativeDialog];
      },
    };
  }

  it('count a native dialog opened with showModal', () => {
    const dom = stubDom();
    expect(isModalDialogOpen()).toBe(false);
    dom.openNative();
    expect(isModalDialogOpen()).toBe(true);
  });

  it('keep a key that closed its dialog away from the canvas', () => {
    const dom = stubDom();
    trackDialogKeys();
    dom.setOpen(true);
    const escapeKey = new Event('keydown');
    // The dialog closes on Escape before the canvas handlers run.
    dom.win.addEventListener('keydown', () => dom.setOpen(false));
    let seenByCanvas: boolean | null = null;
    dom.win.addEventListener('keydown', (e) => {
      seenByCanvas = !keyBelongsToDialog(e);
    });
    dom.win.dispatchEvent(escapeKey);
    expect(seenByCanvas).toBe(false);
    // With the dialog closed, the next key is the canvas's again.
    dom.win.dispatchEvent(new Event('keydown'));
    expect(seenByCanvas).toBe(true);
  });
});

describe('cut', () => {
  it('writes the selection, then deletes its unlocked elements', () => {
    const rect = (id: string, locked = false): RectangleElement => ({
      id,
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      strokeColor: '#000',
      fillColor: 'transparent',
      strokeWidth: 1,
      opacity: 1,
      roughness: 0,
      ...(locked && { locked }),
    });
    const history = new History({
      ...createScene(),
      elements: [rect('a'), rect('b', true), rect('c')],
      selectedIds: new Set(['a', 'b']),
    });
    const written = new Map<string, string>();
    const data = {
      setData: (type: string, value: string) => written.set(type, value),
    } as unknown as DataTransfer;
    expect(cutSelectionToClipboardData(history, data)).toBe(true);
    expect(written.get('text/plain')).toContain('"id":"a"');
    expect(written.get('text/plain')).toContain('"id":"b"');
    expect(history.present.elements.map((el) => el.id)).toEqual(['b', 'c']);
  });

  it('lets the browser cut when nothing is selected', () => {
    const history = new History(createScene());
    const data = { setData: () => {} } as unknown as DataTransfer;
    expect(cutSelectionToClipboardData(history, data)).toBe(false);
  });
});
