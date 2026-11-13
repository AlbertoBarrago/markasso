import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from '../src/commands/commands';
import { createScene, type Scene } from '../src/core/scene';
import type { Element } from '../src/elements/element';
import { reducer } from '../src/engine/reducer';
import {
  createCommands,
  LiveOutbox,
  mergeCommands,
} from '../src/io/live_outbox';

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

const move = (dx: number, dy = 0, ids = ['a']): Command => ({
  type: 'MOVE_ELEMENTS',
  ids,
  dx,
  dy,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('LiveOutbox', () => {
  it('sends the first command at once and merges a drag into few commands', () => {
    const sent: Command[] = [];
    const outbox = new LiveOutbox({ send: (c) => sent.push(c) });
    outbox.push(move(1));
    expect(sent).toEqual([move(1)]);
    // 60 pointer moves a second for 3 s: 180 commands, more than the room
    // takes from one peer in 5 s.
    for (let i = 0; i < 180; i++) {
      outbox.push(move(1));
      vi.advanceTimersByTime(1000 / 60);
    }
    vi.advanceTimersByTime(100);
    expect(sent.length).toBeLessThan(70);
    const total = sent.reduce(
      (sum, c) => sum + (c.type === 'MOVE_ELEMENTS' ? c.dx : 0),
      0,
    );
    expect(total).toBe(181);
    expect(outbox.pending).toBe(false);
  });

  it('keeps the order of commands it cannot merge', () => {
    const sent: Command[] = [];
    const outbox = new LiveOutbox({ send: (c) => sent.push(c) });
    outbox.push(move(1));
    outbox.push(move(2));
    outbox.push({ type: 'DELETE_ELEMENTS', ids: ['b'] });
    outbox.push(move(3));
    outbox.push(move(4, 0, ['c']));
    vi.advanceTimersByTime(60);
    expect(sent).toEqual([
      move(1),
      move(2),
      { type: 'DELETE_ELEMENTS', ids: ['b'] },
      move(3),
      move(4, 0, ['c']),
    ]);
  });

  it('holds a burst past the quota and sends it as the window frees up', () => {
    const sent: Command[] = [];
    const outbox = new LiveOutbox({ send: (c) => sent.push(c) });
    for (let i = 0; i < 400; i++)
      outbox.push({ type: 'DELETE_ELEMENTS', ids: [`e${i}`] });
    vi.advanceTimersByTime(100);
    expect(sent).toHaveLength(150);
    vi.advanceTimersByTime(5_000);
    expect(sent).toHaveLength(300);
    vi.advanceTimersByTime(5_000);
    expect(sent).toHaveLength(400);
    // Never more than 150 in any 5 s, under the room's 200.
    expect(sent.map((c) => (c as { ids: string[] }).ids[0])).toEqual(
      Array.from({ length: 400 }, (_, i) => `e${i}`),
    );
  });

  it('drops what is waiting when cleared', () => {
    const sent: Command[] = [];
    const outbox = new LiveOutbox({ send: (c) => sent.push(c) });
    outbox.push(move(1));
    outbox.push({ type: 'DELETE_ELEMENTS', ids: ['b'] });
    outbox.clear();
    vi.advanceTimersByTime(1_000);
    expect(sent).toEqual([move(1)]);
  });

  it('sends what is waiting before a leave, within the quota', () => {
    const sent: Command[] = [];
    const outbox = new LiveOutbox({ send: (c) => sent.push(c) });
    // A creation and its undo, a moment before leaving.
    outbox.push({ type: 'CREATE_ELEMENT', element: rect('a') });
    outbox.push({ type: 'DELETE_ELEMENTS', ids: ['a'] });
    outbox.drain();
    expect(sent.map((c) => c.type)).toEqual([
      'CREATE_ELEMENT',
      'DELETE_ELEMENTS',
    ]);
    expect(outbox.pending).toBe(false);
    // Past the quota, the rest is dropped: nothing is sent after a leave.
    for (let i = 0; i < 200; i++)
      outbox.push({ type: 'DELETE_ELEMENTS', ids: [`e${i}`] });
    outbox.drain();
    vi.advanceTimersByTime(10_000);
    expect(sent).toHaveLength(150);
  });
});

describe('mergeCommands', () => {
  it.each<[string, Command[]]>([
    ['moves of the same elements', [move(3, 1), move(-1, 2), move(0.5, 0)]],
    [
      'single moves',
      [
        { type: 'MOVE_ELEMENT', id: 'a', dx: 1, dy: 1 },
        { type: 'MOVE_ELEMENT', id: 'a', dx: 2, dy: -3 },
      ],
    ],
    [
      'resizes',
      [
        { type: 'RESIZE_ELEMENT', id: 'a', x: 5, width: 30 },
        { type: 'RESIZE_ELEMENT', id: 'a', width: 40, height: 20 },
      ],
    ],
    [
      'rotations',
      [
        { type: 'SET_ROTATION', id: 'a', rotation: 0.5 },
        { type: 'SET_ROTATION', id: 'a', rotation: 1 },
      ],
    ],
  ])('folds %s into one with the same result', (_, commands) => {
    const base: Scene = { ...createScene(), elements: [rect('a'), rect('b')] };
    const stepByStep = commands.reduce<Scene>(
      (scene, command) => reducer(scene, command, true),
      base,
    );
    const merged = commands
      .slice(1)
      .reduce<Command>(
        (acc, next) => mergeCommands(acc, next) as Command,
        commands[0] as Command,
      );
    expect(reducer(base, merged, true).elements).toEqual(stepByStep.elements);
  });

  it.each<[string, Command, Command]>([
    ['moves of other elements', move(1), move(1, 0, ['b'])],
    ['moves of a different set', move(1), move(1, 0, ['a', 'b'])],
    [
      'resizes of different elements',
      { type: 'RESIZE_ELEMENT', id: 'a', width: 1 },
      { type: 'RESIZE_ELEMENT', id: 'b', width: 1 },
    ],
    ['different commands', move(1), { type: 'DELETE_ELEMENTS', ids: ['a'] }],
  ])('keeps %s apart', (_, last, next) => {
    expect(mergeCommands(last, next)).toBeNull();
  });
});

describe('createCommands', () => {
  it('splits a board into pieces a room accepts, valid elements only', () => {
    const label = 'x'.repeat(1_000);
    const elements = [
      ...Array.from({ length: 2_400 }, (_, i) => rect(`r${i}`, { label })),
      rect('bad', { rotation: 100 }),
    ];
    const commands = createCommands(elements, { validOnly: true });
    expect(commands.length).toBeGreaterThan(2);
    for (const command of commands) {
      expect(command.elements.length).toBeLessThanOrEqual(1_000);
      expect(JSON.stringify(command).length).toBeLessThan(512 * 1024);
    }
    const sent = commands.flatMap((c) => c.elements.map((el) => el.id));
    expect(sent).toHaveLength(2_400);
    expect(sent).not.toContain('bad');
    expect(createCommands([])).toEqual([]);
  });
});
