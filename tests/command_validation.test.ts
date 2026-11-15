import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Command } from '../src/commands/commands';
import { createScene } from '../src/core/scene';
import type { Element } from '../src/elements/element';
import { isSessionCommand } from '../src/engine/ephemeral';
import { History } from '../src/engine/history';
import {
  isValidSessionCommand,
  SESSION_COMMAND_TYPES,
} from '../src/io/command_validation';

const rect = (id: string, extra: Record<string, unknown> = {}): Element =>
  ({
    id,
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    strokeColor: '#000',
    fillColor: 'transparent',
    strokeWidth: 1,
    opacity: 1,
    roughness: 0,
    ...extra,
  }) as Element;

const viewport = { offsetX: 0, offsetY: 0, zoom: 1 };

describe('isValidSessionCommand', () => {
  it('covers every command the reducer handles and the room relays', () => {
    const reducer = readFileSync(
      new URL('../src/engine/reducer.ts', import.meta.url),
      'utf8',
    );
    const relayed = [...reducer.matchAll(/^ {4}case '([A-Z_]+)':/gm)]
      .map((match) => match[1] as string)
      .filter((type) => isSessionCommand({ type }));
    expect(relayed.length).toBeGreaterThan(20);
    expect([...SESSION_COMMAND_TYPES].sort()).toEqual([...relayed].sort());
  });

  it.each<Command>([
    { type: 'CREATE_ELEMENT', element: rect('a'), select: false },
    { type: 'CREATE_ELEMENTS', elements: [rect('a'), rect('b')] },
    { type: 'UPDATE_ELEMENT', id: 'a', props: { label: 'Hi' } as never },
    { type: 'MOVE_ELEMENT', id: 'a', dx: 1, dy: -2 },
    { type: 'MOVE_ELEMENTS', ids: ['a', 'b'], dx: 0.5, dy: 0 },
    { type: 'RESIZE_ELEMENT', id: 'a', width: 10, endElementId: null },
    {
      type: 'RESIZE_ELEMENT',
      id: 'a',
      startElementId: 'b',
      startAnchor: { x: 0.5, y: 0 },
      endAnchor: null,
      points: [
        [0, 0],
        [1, 1],
      ],
    },
    { type: 'DELETE_ELEMENTS', ids: [] },
    {
      type: 'PATCH_ELEMENTS',
      create: [{ element: rect('c'), index: 0 }],
      update: [{ id: 'a', set: { x: 4 }, unset: ['label'] }],
      delete: ['b'],
      order: ['c', 'a'],
    },
    { type: 'PATCH_ELEMENTS' },
    { type: 'EDIT_TEXT', id: 'a', content: '' },
    {
      type: 'SET_SHAPE_LABEL',
      id: 'a',
      label: 'x',
      labelFontSize: 16,
      labelFontFamily: 'Inter',
    },
    { type: 'SET_FONT_FAMILY', family: 'Inter' },
    { type: 'SET_FONT_SIZE', size: 20 },
    { type: 'SET_ROTATION', id: 'a', rotation: 1.5 },
    { type: 'REORDER_ELEMENTS', ids: ['a'], targetIndex: 0 },
    { type: 'LOAD_SCENE', elements: [rect('a')], viewport },
    { type: 'LOAD_SCENE', elements: [], viewport },
    { type: 'GROUP_ELEMENTS', ids: ['a', 'b'], groupId: 'g' },
    { type: 'UNGROUP_ELEMENTS', groupId: 'g' },
    { type: 'LOCK_ELEMENTS', ids: ['a'] },
    { type: 'UNLOCK_ELEMENTS', ids: ['a'] },
    { type: 'SET_TEXT_MODE', mode: 'code' },
    { type: 'ALIGN_ELEMENTS', moves: [{ id: 'a', x: 1, y: 2 }] },
    { type: 'APPLY_STYLE', ids: ['a'], strokeColor: '#f00', bold: true },
    { type: 'APPLY_STYLE', opacity: 0.5 },
  ])('accepts $type', (command) => {
    expect(isValidSessionCommand(command)).toBe(true);
  });

  it.each<[string, unknown]>([
    ['nothing', null],
    ['an array', []],
    ['no type', { ids: ['a'] }],
    ['an unknown type', { type: 'REVIEW_UNKNOWN_COMMAND' }],
    ['an inherited key as type', { type: 'constructor' }],
    ['a legacy undo', { type: 'UNDO' }],
    ['an ephemeral command', { type: 'SELECT_ELEMENTS', ids: ['a'] }],
    ['elements missing', { type: 'CREATE_ELEMENTS' }],
    ['an invalid element', { type: 'CREATE_ELEMENT', element: { id: 'a' } }],
    [
      'an image loaded from a URL',
      {
        type: 'CREATE_ELEMENT',
        element: rect('a', {
          type: 'image',
          src: 'https://example.com/pixel.png',
          naturalWidth: 1,
          naturalHeight: 1,
        }),
      },
    ],
    ['ids missing', { type: 'DELETE_ELEMENTS' }],
    [
      'ids that are not strings',
      { type: 'MOVE_ELEMENTS', ids: [1], dx: 0, dy: 0 },
    ],
    [
      'a delta that is not a number',
      { type: 'MOVE_ELEMENT', id: 'a', dx: null, dy: 0 },
    ],
    [
      'a patch that changes the type',
      { type: 'UPDATE_ELEMENT', id: 'a', props: { type: 'image' } },
    ],
    [
      'a patch that changes the id',
      { type: 'PATCH_ELEMENTS', update: [{ id: 'a', set: { id: 'b' } }] },
    ],
    [
      'a patch pointing an image at a URL',
      {
        type: 'UPDATE_ELEMENT',
        id: 'a',
        props: { src: 'https://example.com/x.png' },
      },
    ],
    [
      'a patch without fields',
      { type: 'PATCH_ELEMENTS', update: [{ id: 'a' }] },
    ],
    [
      'a created entry without index',
      { type: 'PATCH_ELEMENTS', create: [{ element: rect('a') }] },
    ],
    ['moves missing', { type: 'ALIGN_ELEMENTS' }],
    ['a scene without viewport', { type: 'LOAD_SCENE', elements: [] }],
    ['a style with a wrong value type', { type: 'APPLY_STYLE', opacity: '1' }],
    [
      'a resize with a text size',
      { type: 'RESIZE_ELEMENT', id: 'a', width: '10' },
    ],
    ['an unknown text mode', { type: 'SET_TEXT_MODE', mode: 'html' }],
  ])('refuses %s', (_, command) => {
    expect(isValidSessionCommand(command)).toBe(false);
  });

  it('accepts what the editor emits, undo and redo included', () => {
    const history = new History(createScene());
    const emitted: Command[] = [];
    history.setOnCommand((command) => emitted.push(command));
    history.dispatch({ type: 'CREATE_ELEMENT', element: rect('a') });
    history.dispatch({ type: 'CREATE_ELEMENTS', elements: [rect('b')] });
    history.dispatch({ type: 'SELECT_ELEMENTS', ids: ['a', 'b'] });
    history.dispatch({ type: 'MOVE_ELEMENTS', ids: ['a', 'b'], dx: 5, dy: 5 });
    history.dispatch({ type: 'APPLY_STYLE', strokeColor: '#f00' });
    history.dispatch({ type: 'GROUP_ELEMENTS', ids: ['a', 'b'], groupId: 'g' });
    history.dispatch({ type: 'REORDER_ELEMENTS', ids: ['a'], targetIndex: 2 });
    history.dispatch({ type: 'SET_ROTATION', id: 'a', rotation: 1 });
    history.dispatch({ type: 'DELETE_ELEMENTS', ids: ['b'] });
    for (let i = 0; i < 6; i++) history.undo();
    for (let i = 0; i < 3; i++) history.redo();
    const relayed = emitted.filter(isSessionCommand);
    expect(relayed.some((command) => command.type === 'PATCH_ELEMENTS')).toBe(
      true,
    );
    for (const command of relayed) {
      expect(isValidSessionCommand(JSON.parse(JSON.stringify(command)))).toBe(
        true,
      );
    }
  });
});

describe('live replay', () => {
  it('skips a command that fails to apply and keeps the rest', () => {
    const history = new History(createScene());
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      history.resetForLiveReplay([
        { type: 'CREATE_ELEMENT', element: rect('a') },
        { type: 'FROM_A_NEWER_CLIENT' } as unknown as Command,
        { type: 'CREATE_ELEMENT', element: rect('b') },
      ]);
    } finally {
      console.error = original;
    }
    expect(history.present.elements.map((el) => el.id)).toEqual(['a', 'b']);
    expect(errors).toHaveLength(1);
  });
});
