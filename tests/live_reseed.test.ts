import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from '../src/commands/commands';
import { createScene } from '../src/core/scene';
import type { Element } from '../src/elements/element';
import { History } from '../src/engine/history';
import { joinLiveSession, leaveLiveSession } from '../src/io/realtime';

/**
 * Platform WebSocket stand-in driven by the test. `open` sends the `init`
 * the room would send with its current log (SessionRoom.admit); the scene
 * commands the client sends are kept in `commands`.
 */
class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  readonly commands: Command[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  open(log: readonly Command[]): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
    this.onmessage?.({
      data: JSON.stringify({
        type: 'init',
        self: 'me',
        commands: log,
        peers: [],
      }),
    });
  }
  send(data: string): void {
    const msg = JSON.parse(data) as { type: string; command?: Command };
    if (msg.type === 'command' && msg.command) this.commands.push(msg.command);
  }
  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.onclose?.({ code, reason } as { code?: number; reason?: string });
  }
}

const rect = (id: string): Element =>
  ({
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
  }) as Element;

/** The board a peer builds by replaying `log`, as a joiner does. */
function replay(log: readonly Command[]): string[] {
  const history = new History(createScene());
  history.resetForLiveReplay(log);
  return history.present.elements.map((el) => el.id);
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('location', {
    href: 'https://markasso.example/',
    search: '',
    protocol: 'https:',
    host: 'markasso.example',
    pathname: '/',
  });
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: false }),
    history: { state: null, replaceState: () => {} },
  });
  // realtime.ts listens here for licence changes (markasso-cloud-change).
  // createAppState reads the theme from documentElement.
  vi.stubGlobal(
    'document',
    Object.assign(new EventTarget(), {
      documentElement: { getAttribute: () => null },
    }),
  );
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
  });
});
afterEach(() => {
  leaveLiveSession();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('seeding a live room', () => {
  it('does not republish the starting board when the seeder reconnects to a cleared room', () => {
    // The creator starts a session from a board holding two shapes, as the
    // toolbar does (seedElements: history.present.elements).
    const seeder = new History(createScene());
    seeder.dispatch({ type: 'CREATE_ELEMENT', element: rect('a') });
    seeder.dispatch({ type: 'CREATE_ELEMENT', element: rect('b') });
    joinLiveSession(seeder, {
      roomId: 'room-123',
      seedElements: seeder.present.elements,
    });
    const first = FakeSocket.all[0]!;
    first.open([]);
    vi.advanceTimersByTime(1_000);
    expect(replay(first.commands)).toEqual(['a', 'b']);

    // The board is cleared in the session.
    seeder.dispatch({ type: 'DELETE_ELEMENTS', ids: ['a', 'b'] });
    vi.advanceTimersByTime(1_000);
    expect(replay(first.commands)).toEqual([]);

    // The room compacts its log (RoomLog.compact, on load or past 1,000
    // commands): an empty scene compacts to no commands at all, the same
    // log a brand-new room has. The connection drops (a deploy, an
    // eviction, a network blip) and the seeder reconnects to that log.
    first.close(1006);
    vi.advanceTimersByTime(1_000);
    expect(FakeSocket.all).toHaveLength(2);
    const second = FakeSocket.all[1]!;
    second.open([]);
    vi.advanceTimersByTime(1_000);

    // The seeder still shows the cleared board...
    expect(seeder.present.elements).toEqual([]);
    // ...and the room must stay cleared for everyone: the deleted shapes
    // are not sent again.
    expect(replay(second.commands)).toEqual([]);
  });

  it('republishes the current board when the seeder reconnects to a room that lost its content', () => {
    const seeder = new History(createScene());
    seeder.dispatch({ type: 'CREATE_ELEMENT', element: rect('a') });
    seeder.dispatch({ type: 'CREATE_ELEMENT', element: rect('b') });
    joinLiveSession(seeder, {
      roomId: 'room-123',
      seedElements: seeder.present.elements,
    });
    const first = FakeSocket.all[0]!;
    first.open([]);
    vi.advanceTimersByTime(1_000);

    // One shape is deleted, then the idle room is reclaimed (the daily
    // cleanup) while the tab sleeps: it comes back to an empty log.
    seeder.dispatch({ type: 'DELETE_ELEMENTS', ids: ['a'] });
    vi.advanceTimersByTime(1_000);
    first.close(1006);
    vi.advanceTimersByTime(1_000);
    const second = FakeSocket.all[1]!;
    second.open([]);
    vi.advanceTimersByTime(1_000);

    // The room is rebuilt from the board as it is now, not as it started.
    expect(seeder.present.elements.map((el) => el.id)).toEqual(['b']);
    expect(replay(second.commands)).toEqual(['b']);
  });

  it('keeps and republishes shapes drawn after starting from an empty board', () => {
    const seeder = new History(createScene());
    joinLiveSession(seeder, { roomId: 'room-123', seedElements: [] });
    const first = FakeSocket.all[0]!;
    first.open([]);
    seeder.dispatch({ type: 'CREATE_ELEMENT', element: rect('c') });
    vi.advanceTimersByTime(1_000);

    first.close(1006);
    vi.advanceTimersByTime(1_000);
    const second = FakeSocket.all[1]!;
    second.open([]);
    vi.advanceTimersByTime(1_000);

    expect(seeder.present.elements.map((el) => el.id)).toEqual(['c']);
    expect(replay(second.commands)).toEqual(['c']);
  });
});
