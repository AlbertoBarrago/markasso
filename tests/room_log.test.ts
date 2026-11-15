import { describe, expect, it } from 'vitest';
import type { Command } from '../src/commands/commands';
import { createScene } from '../src/core/scene';
import type { Element } from '../src/elements/element';
import { History } from '../src/engine/history';
import { type LogStorage, RoomLog } from '../src/worker/room_log';

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

/** A valid image element of about `chars` characters (its data URL). */
const image = (id: string, chars: number): Element =>
  ({
    ...rect(id),
    type: 'image',
    src: `data:image/png;base64,${'A'.repeat(chars)}`,
    naturalWidth: 10,
    naturalHeight: 10,
  }) as Element;

/** The board a peer that joins builds from the log it receives. */
function joinerBoard(commands: readonly unknown[]): Element[] {
  const history = new History(createScene());
  history.resetForLiveReplay(commands as Command[]);
  return [...history.present.elements];
}

/** A Map-backed storage that also counts calls and can fail on demand. */
function memoryStorage() {
  const values = new Map<string, unknown>();
  let failPuts = false;
  const calls = { put: 0, delete: 0 };
  const storage = {
    get: async (key: string) => structuredClone(values.get(key)),
    put: async (entries: Record<string, unknown>) => {
      calls.put++;
      if (Object.keys(entries).length > 128) throw new Error('too many keys');
      if (failPuts) throw new Error('storage down');
      for (const [key, value] of Object.entries(entries))
        values.set(key, structuredClone(value));
    },
    delete: async (keys: string[]) => {
      calls.delete++;
      for (const key of keys) values.delete(key);
      return keys.length;
    },
  } as unknown as LogStorage;
  return {
    storage,
    values,
    calls,
    fail: (on: boolean) => {
      failPuts = on;
    },
  };
}

describe('RoomLog', () => {
  it('keeps every element of a long session, where the old log lost them', () => {
    const log = new RoomLog();
    const commands: unknown[] = [];
    const send = (command: unknown) => {
      expect(log.append(command)).toBe(true);
      commands.push(command);
    };
    for (let i = 0; i < 20; i++)
      send({ type: 'CREATE_ELEMENT', element: rect(`r${i}`, { x: i * 10 }) });
    // Well past the 5,000 commands the old log kept.
    for (let i = 0; i < 6_000; i++)
      send({ type: 'MOVE_ELEMENTS', ids: [`r${i % 20}`], dx: 1, dy: 0 });
    send({ type: 'DELETE_ELEMENTS', ids: ['r3'] });

    const replayed = joinerBoard(log.commands);
    expect(replayed).toHaveLength(19);
    // Exactly what a peer replaying every command would have.
    expect(replayed).toEqual(joinerBoard(commands));
    expect(log.commands.length).toBeLessThan(1_001);
  });

  it('refuses a command the reducer throws on, and leaves the room as it was', () => {
    const log = new RoomLog();
    log.append({ type: 'CREATE_ELEMENT', element: rect('a') });
    const before = log.commands;
    // Valid in shape, but an unknown type makes the reducer throw.
    expect(log.append({ type: 'CREATE_ELEMENTS' })).toBe(false);
    expect(log.append({ type: 'NOT_A_COMMAND' })).toBe(false);
    expect(log.commands).toEqual(before);
  });

  it('splits a large board into commands a peer could have sent', () => {
    const log = new RoomLog();
    const label = 'x'.repeat(1_000);
    for (let i = 0; i < 2_500; i++)
      expect(
        log.append({
          type: 'CREATE_ELEMENT',
          element: rect(`r${i}`, { label }),
        }),
      ).toBe(true);
    log.compact();
    const commands = log.commands;
    expect(commands.length).toBeGreaterThan(2);
    for (const command of commands) {
      expect(command.type).toBe('CREATE_ELEMENTS');
      expect((command.elements as unknown[]).length).toBeLessThanOrEqual(1_000);
      expect(JSON.stringify(command).length).toBeLessThan(512 * 1024);
    }
    expect(joinerBoard(commands)).toHaveLength(2_500);
  });

  it('refuses what would grow the room past its size limit', () => {
    const log = new RoomLog();
    let accepted = 0;
    for (let i = 0; i < 100; i++)
      if (
        log.append({
          type: 'CREATE_ELEMENT',
          element: image(`b${i}`, 400_000),
        })
      )
        accepted++;
    expect(accepted).toBeGreaterThan(10);
    expect(accepted).toBeLessThan(100);
    // Removing content makes room again.
    expect(
      log.append({ type: 'DELETE_ELEMENTS', ids: ['b0', 'b1', 'b2'] }),
    ).toBe(true);
    expect(
      log.append({
        type: 'CREATE_ELEMENT',
        element: image('again', 400_000),
      }),
    ).toBe(true);
  });

  it('counts small commands that add content against the size limit', () => {
    const log = new RoomLog();
    const label = 'x'.repeat(9_900);
    let accepted = 0;
    for (let i = 0; i < 2_600; i++)
      if (
        log.append({
          type: 'CREATE_ELEMENT',
          element: rect(`r${i}`, { label }),
        })
      )
        accepted++;
    // Each one is small, but 2,600 of them are about twice the limit.
    expect(accepted).toBeLessThan(2_600);
    // A full room still takes moves and deletes.
    expect(
      log.append({ type: 'MOVE_ELEMENTS', ids: ['r0'], dx: 1, dy: 1 }),
    ).toBe(true);
    expect(log.append({ type: 'DELETE_ELEMENTS', ids: ['r1'] })).toBe(true);
  });

  it('refuses a command that leaves an element compaction would lose', () => {
    const log = new RoomLog();
    log.append({ type: 'CREATE_ELEMENT', element: rect('a') });
    log.append({
      type: 'CREATE_ELEMENT',
      element: {
        ...rect('t'),
        type: 'text',
        content: 'hi',
        fontSize: 16,
        fontFamily: 'sans-serif',
      },
    });
    // Past a full turn, and past the text length limit.
    expect(log.append({ type: 'SET_ROTATION', id: 'a', rotation: 7 })).toBe(
      false,
    );
    expect(
      log.append({ type: 'EDIT_TEXT', id: 't', content: 'x'.repeat(10_001) }),
    ).toBe(false);
    expect(log.append({ type: 'SET_ROTATION', id: 'a', rotation: 1 })).toBe(
      true,
    );
    log.compact();
    expect(joinerBoard(log.commands).map((el) => el.id)).toEqual(['a', 't']);
  });

  it('saves in chunks and loads back the same board', async () => {
    const { storage, values } = memoryStorage();
    const log = new RoomLog();
    for (let i = 0; i < 12; i++)
      log.append({ type: 'CREATE_ELEMENT', element: image(`r${i}`, 200_000) });
    await log.save(storage, { lastActivity: 42 });
    expect(values.get('log:meta')).toEqual({ chunks: expect.any(Number) });
    expect(
      (values.get('log:meta') as { chunks: number }).chunks,
    ).toBeGreaterThan(1);
    expect(values.get('lastActivity')).toBe(42);
    for (const [key, value] of values)
      if (key.startsWith('log:') && key !== 'log:meta')
        expect(JSON.stringify(value).length).toBeLessThan(1_000_000);

    const loaded = new RoomLog();
    await loaded.load(storage);
    expect(joinerBoard(loaded.commands)).toEqual(joinerBoard(log.commands));
  });

  it('reads the single-value log of older versions and moves it to chunks', async () => {
    const { storage, values } = memoryStorage();
    values.set('commands', [
      { type: 'CREATE_ELEMENT', element: rect('a') },
      { type: 'CREATE_ELEMENTS' },
      { type: 'MOVE_ELEMENT', id: 'a', dx: 5, dy: 0 },
    ]);
    const log = new RoomLog();
    await log.load(storage);
    expect(joinerBoard(log.commands)).toEqual([rect('a', { x: 5 })]);
    await log.save(storage);
    expect(values.has('commands')).toBe(false);
    expect(values.get('log:meta')).toEqual({ chunks: 1 });
  });

  it('drops the chunks a compaction no longer needs', async () => {
    const { storage, values } = memoryStorage();
    const log = new RoomLog();
    for (let i = 0; i < 12; i++)
      log.append({ type: 'CREATE_ELEMENT', element: image(`r${i}`, 200_000) });
    await log.save(storage);
    const before = (values.get('log:meta') as { chunks: number }).chunks;
    log.append({
      type: 'DELETE_ELEMENTS',
      ids: Array.from({ length: 11 }, (_, i) => `r${i}`),
    });
    log.compact();
    await log.save(storage);
    expect(values.get('log:meta')).toEqual({ chunks: 1 });
    for (let i = 1; i < before; i++) expect(values.has(`log:${i}`)).toBe(false);
  });

  it('keeps unsaved changes after a failed save and writes them next time', async () => {
    const { storage, values, fail } = memoryStorage();
    const log = new RoomLog();
    log.append({ type: 'CREATE_ELEMENT', element: rect('a') });
    fail(true);
    await expect(log.save(storage)).rejects.toThrow('storage down');
    fail(false);
    await log.save(storage);
    const loaded = new RoomLog();
    await loaded.load(storage);
    expect(joinerBoard(loaded.commands)).toEqual([rect('a')]);
    expect(values.get('log:meta')).toEqual({ chunks: 1 });
  });
});
