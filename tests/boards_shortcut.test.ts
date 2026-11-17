import { describe, expect, it } from 'vitest';
import { boardsShortcut } from '../src/ui/keyboard_utils';

const key = (
  k: string,
  mods: Partial<
    Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>
  > = {},
  code = 'KeyO',
) => ({
  key: k,
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('boardsShortcut', () => {
  it('matches Cmd/Ctrl+Shift+O', () => {
    expect(boardsShortcut(key('O', { metaKey: true, shiftKey: true }))).toBe(
      true,
    );
    expect(boardsShortcut(key('O', { ctrlKey: true, shiftKey: true }))).toBe(
      true,
    );
  });

  it('matches by character, not physical key (Dvorak O key types R)', () => {
    expect(
      boardsShortcut(key('R', { ctrlKey: true, shiftKey: true }, 'KeyO')),
    ).toBe(false);
    expect(
      boardsShortcut(key('O', { ctrlKey: true, shiftKey: true }, 'KeyS')),
    ).toBe(true);
  });

  it('leaves Cmd/Ctrl+O to the file shortcut', () => {
    expect(boardsShortcut(key('o', { metaKey: true }))).toBe(false);
  });

  it('ignores Shift+O without Cmd/Ctrl, and combos with Alt', () => {
    expect(boardsShortcut(key('O', { shiftKey: true }))).toBe(false);
    expect(
      boardsShortcut(key('O', { metaKey: true, shiftKey: true, altKey: true })),
    ).toBe(false);
  });

  it('ignores other keys', () => {
    expect(
      boardsShortcut(key('P', { metaKey: true, shiftKey: true }, 'KeyP')),
    ).toBe(false);
  });
});
