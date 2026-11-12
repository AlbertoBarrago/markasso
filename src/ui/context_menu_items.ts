import type { Scene } from '../core/scene';
import type { Element } from '../elements/element';
import { selectedElements } from './style_state';

/** Actions the right-click menu can run (see context_menu.ts). */
export type ContextMenuAction =
  | 'cut'
  | 'copy'
  | 'paste'
  | 'copyAsPng'
  | 'copyAsSvg'
  | 'editText'
  | 'copyStyle'
  | 'pasteStyle'
  | 'sendBackward'
  | 'bringForward'
  | 'sendToBack'
  | 'bringToFront'
  | 'group'
  | 'ungroup'
  | 'duplicate'
  | 'lock'
  | 'unlock'
  | 'delete'
  | 'selectAll';

export interface ContextMenuItem {
  readonly action: ContextMenuAction;
  /** i18n key of the label. */
  readonly labelKey: string;
  /** Keyboard shortcut shown on the right, already formatted. */
  readonly shortcut?: string;
  readonly danger?: boolean;
}

/** Items in groups; the menu draws a divider between groups. */
export type ContextMenuModel = ReadonlyArray<ReadonlyArray<ContextMenuItem>>;

export interface ContextMenuOptions {
  /** A style was copied, so "Paste style" applies. */
  readonly hasCopiedStyle: boolean;
  /** Formats shortcuts with Mac symbols (⌘⌥⇧) instead of Ctrl/Alt/Shift. */
  readonly isMac: boolean;
}

type Modifier = 'mod' | 'alt' | 'shift';

/** Formats a shortcut the way each platform writes it. */
export function formatShortcut(
  modifiers: readonly Modifier[],
  key: string,
  isMac: boolean,
): string {
  if (isMac) {
    // Apple order: Option, Shift, Command.
    const symbols = { alt: '⌥', shift: '⇧', mod: '⌘' } as const;
    return (['alt', 'shift', 'mod'] as const)
      .filter((m) => modifiers.includes(m))
      .map((m) => symbols[m])
      .join('')
      .concat(key);
  }
  const names = { mod: 'Ctrl', alt: 'Alt', shift: 'Shift' } as const;
  return [
    ...(['mod', 'alt', 'shift'] as const)
      .filter((m) => modifiers.includes(m))
      .map((m) => names[m]),
    key,
  ].join('+');
}

/** Elements whose text the label or text editor can add or change. */
function textTarget(selected: readonly Element[]): Element | null {
  if (selected.length !== 1) return null;
  const el = selected[0]!;
  switch (el.type) {
    case 'text':
    case 'rectangle':
    case 'ellipse':
    case 'rhombus':
    case 'shape':
    case 'stencil':
    case 'line':
    case 'arrow':
      return el;
    default:
      return null;
  }
}

function hasText(el: Element): boolean {
  if (el.type === 'text') return true;
  return 'label' in el && typeof el.label === 'string' && el.label !== '';
}

/**
 * The right-click menu for `scene`: element actions when something is
 * selected (the menu selects what was right-clicked first), otherwise the
 * canvas actions. Items that cannot apply are left out, not disabled.
 */
export function buildContextMenu(
  scene: Scene,
  options: ContextMenuOptions,
): ContextMenuModel {
  const k = (modifiers: readonly Modifier[], key: string): string =>
    formatShortcut(modifiers, key, options.isMac);
  const selected = selectedElements(scene);
  const paste: ContextMenuItem = {
    action: 'paste',
    labelKey: 'paste',
    shortcut: k(['mod'], 'V'),
  };

  if (selected.length === 0) {
    return [
      [
        paste,
        {
          action: 'selectAll',
          labelKey: 'selectAll',
          shortcut: k(['mod'], 'A'),
        },
      ],
    ];
  }

  const allLocked = selected.every((el) => el.locked);
  const unlocked = selected.some((el) => !el.locked);
  const groupIds = new Set(
    selected.map((el) => el.groupId).filter((g) => g !== undefined),
  );
  const oneWholeGroup =
    groupIds.size === 1 && selected.every((el) => el.groupId !== undefined);
  const text = textTarget(selected);

  const groups: ContextMenuItem[][] = [
    [
      ...(unlocked
        ? [
            {
              action: 'cut',
              labelKey: 'cut',
              shortcut: k(['mod'], 'X'),
            } as const,
          ]
        : []),
      { action: 'copy', labelKey: 'copy', shortcut: k(['mod'], 'C') },
      paste,
    ],
    [
      { action: 'copyAsPng', labelKey: 'copyAsPng' },
      { action: 'copyAsSvg', labelKey: 'copyAsSvg' },
    ],
    text
      ? [
          {
            action: 'editText',
            labelKey: hasText(text) ? 'editText' : 'addText',
          },
        ]
      : [],
    [
      {
        action: 'copyStyle',
        labelKey: 'copyStyle',
        shortcut: k(['mod', 'alt'], 'C'),
      },
      ...(options.hasCopiedStyle
        ? [
            {
              action: 'pasteStyle',
              labelKey: 'pasteStyle',
              shortcut: k(['mod', 'alt'], 'V'),
            } as const,
          ]
        : []),
    ],
    [
      { action: 'sendBackward', labelKey: 'sendBackward' },
      { action: 'bringForward', labelKey: 'bringForward' },
      {
        action: 'sendToBack',
        labelKey: 'toBack',
        shortcut: k(['mod', 'shift'], '['),
      },
      {
        action: 'bringToFront',
        labelKey: 'toFront',
        shortcut: k(['mod', 'shift'], ']'),
      },
    ],
    [
      ...(selected.length >= 2 && !oneWholeGroup
        ? [
            {
              action: 'group',
              labelKey: 'group',
              shortcut: k(['mod'], 'G'),
            } as const,
          ]
        : []),
      ...(groupIds.size > 0
        ? [
            {
              action: 'ungroup',
              labelKey: 'ungroup',
              shortcut: k(['mod', 'shift'], 'G'),
            } as const,
          ]
        : []),
    ],
    [
      { action: 'duplicate', labelKey: 'duplicate', shortcut: k(['mod'], 'D') },
      allLocked
        ? {
            action: 'unlock',
            labelKey: 'unlockElements',
            shortcut: k(['mod', 'shift'], 'L'),
          }
        : {
            action: 'lock',
            labelKey: 'lockElements',
            shortcut: k(['mod', 'shift'], 'L'),
          },
    ],
    unlocked
      ? [
          {
            action: 'delete',
            labelKey: 'delete',
            shortcut: options.isMac ? '⌫' : 'Del',
            danger: true,
          },
        ]
      : [],
  ];
  return groups.filter((g) => g.length > 0);
}
