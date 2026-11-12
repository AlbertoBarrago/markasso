import { describe, expect, it } from 'vitest';
import { createScene, type Scene } from '../src/core/scene';
import type {
  Element,
  LineElement,
  RectangleElement,
} from '../src/elements/element';
import { captureStyle } from '../src/elements/style_snapshot';
import {
  buildContextMenu,
  type ContextMenuAction,
  formatShortcut,
} from '../src/ui/context_menu_items';

const base = {
  strokeColor: '#000',
  fillColor: 'transparent',
  strokeWidth: 1,
  opacity: 1,
  roughness: 0,
  x: 0,
  y: 0,
} as const;
const rect: RectangleElement = {
  ...base,
  id: 'r',
  type: 'rectangle',
  width: 10,
  height: 10,
};
const line: LineElement = { ...base, id: 'l', type: 'line', x2: 10, y2: 10 };

function sceneWith(elements: Element[], selected: string[]): Scene {
  return { ...createScene(), elements, selectedIds: new Set(selected) };
}

function actions(scene: Scene, hasCopiedStyle = false): ContextMenuAction[][] {
  return buildContextMenu(scene, { hasCopiedStyle, isMac: true }).map((g) =>
    g.map((item) => item.action),
  );
}

describe('buildContextMenu', () => {
  it('offers paste and select all on empty canvas', () => {
    expect(actions(sceneWith([rect], []))).toEqual([['paste', 'selectAll']]);
  });

  it('offers the element actions for a selection', () => {
    const flat = actions(sceneWith([rect], ['r'])).flat();
    expect(flat).toEqual([
      'cut',
      'copy',
      'paste',
      'copyAsPng',
      'copyAsSvg',
      'editText',
      'copyStyle',
      'sendBackward',
      'bringForward',
      'sendToBack',
      'bringToFront',
      'duplicate',
      'lock',
      'delete',
    ]);
  });

  it('says "add text" for an unlabelled shape and "edit text" otherwise', () => {
    const label = (scene: Scene) =>
      buildContextMenu(scene, { hasCopiedStyle: false, isMac: true })
        .flat()
        .find((item) => item.action === 'editText')?.labelKey;
    expect(label(sceneWith([line], ['l']))).toBe('addText');
    expect(label(sceneWith([{ ...line, label: 'yes' }], ['l']))).toBe(
      'editText',
    );
  });

  it('offers grouping for two loose elements and ungrouping for a group', () => {
    const loose = actions(sceneWith([rect, line], ['r', 'l'])).flat();
    expect(loose).toContain('group');
    expect(loose).not.toContain('ungroup');
    expect(loose).not.toContain('editText');

    const grouped = actions(
      sceneWith(
        [
          { ...rect, groupId: 'g' },
          { ...line, groupId: 'g' },
        ],
        ['r', 'l'],
      ),
    ).flat();
    expect(grouped).toContain('ungroup');
    expect(grouped).not.toContain('group');
  });

  it('offers paste style only once a style was copied', () => {
    expect(actions(sceneWith([rect], ['r'])).flat()).not.toContain(
      'pasteStyle',
    );
    expect(actions(sceneWith([rect], ['r']), true).flat()).toContain(
      'pasteStyle',
    );
  });

  it('keeps cut and delete away from a locked selection', () => {
    const flat = actions(sceneWith([{ ...rect, locked: true }], ['r'])).flat();
    expect(flat).not.toContain('cut');
    expect(flat).not.toContain('delete');
    expect(flat).toContain('unlock');
  });
});

describe('formatShortcut', () => {
  it('uses symbols in Apple order on Mac and names elsewhere', () => {
    expect(formatShortcut(['mod', 'alt'], 'C', true)).toBe('⌥⌘C');
    expect(formatShortcut(['shift', 'mod'], ']', true)).toBe('⇧⌘]');
    expect(formatShortcut(['mod', 'alt'], 'C', false)).toBe('Ctrl+Alt+C');
  });
});

describe('captureStyle', () => {
  it('keeps only the style keys the element sets', () => {
    const style = captureStyle({ ...rect, cornerRadius: 8 });
    expect(style).toEqual({
      strokeColor: '#000',
      fillColor: 'transparent',
      strokeWidth: 1,
      opacity: 1,
      roughness: 0,
      cornerRadius: 8,
    });
  });
});
