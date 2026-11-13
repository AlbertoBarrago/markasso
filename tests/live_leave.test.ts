import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScene } from '../src/core/scene';
import { History } from '../src/engine/history';
import {
  getLiveSessionUrl,
  joinLiveSession,
  leaveLiveSession,
} from '../src/io/realtime';

/** Platform WebSocket stand-in driven by the test. */
class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  readonly sent: unknown[] = [];
  closed: { code?: number; reason?: string } | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
    this.onmessage?.({
      data: JSON.stringify({
        type: 'init',
        self: 'me',
        commands: [],
        peers: [],
      }),
    });
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closed = { code, reason } as { code?: number; reason?: string };
    this.onclose?.(this.closed);
  }
}

const rect = {
  id: 'a',
  type: 'rectangle' as const,
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

let address: URL;
let store: Map<string, string>;
beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  address = new URL('https://markasso.example/?live=room-123&x=1');
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('location', {
    get href() {
      return address.href;
    },
    get search() {
      return address.search;
    },
    protocol: 'https:',
    host: 'markasso.example',
    pathname: '/',
  });
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: false }),
    history: {
      state: null,
      replaceState: (_: unknown, __: string, url: URL) => {
        address = new URL(String(url));
      },
    },
  });
  // realtime.ts listens here for licence changes (markasso-cloud-change).
  // createAppState reads the theme from documentElement.
  vi.stubGlobal(
    'document',
    Object.assign(new EventTarget(), {
      documentElement: { getAttribute: () => null },
    }),
  );
  store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('leaveLiveSession', () => {
  it('is a no-op outside a session', () => {
    expect(leaveLiveSession()).toBe(false);
  });

  it('closes the room, stops relaying and never reconnects', () => {
    const history = new History(createScene());
    joinLiveSession(history, { roomId: 'room-123' });
    const socket = FakeSocket.all[0]!;
    socket.open();
    expect(getLiveSessionUrl()).not.toBeNull();

    expect(leaveLiveSession()).toBe(true);
    expect(socket.closed).toEqual({ code: 1000, reason: 'left' });
    expect(getLiveSessionUrl()).toBeNull();
    // The live link is gone from the address, other parameters stay.
    expect(address.search).toBe('?x=1');

    // Local edits are no longer sent, and no reconnect is ever scheduled.
    const sentBefore = socket.sent.length;
    history.dispatch({ type: 'CREATE_ELEMENT', element: rect });
    expect(socket.sent).toHaveLength(sentBefore);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
    // The board stays as a local copy.
    expect(history.present.elements.map((e) => e.id)).toEqual(['a']);
  });

  it('sends the edits still waiting to be paced out before leaving', () => {
    const history = new History(createScene());
    joinLiveSession(history, { roomId: 'room-123' });
    const socket = FakeSocket.all[0]!;
    socket.open();
    history.dispatch({ type: 'CREATE_ELEMENT', element: rect });
    // Within the pacing interval: waits in the outbox.
    history.dispatch({ type: 'DELETE_ELEMENTS', ids: ['a'] });
    leaveLiveSession();
    const sent = socket.sent
      .filter((m) => (m as { type: string }).type === 'command')
      .map((m) => (m as { command: { type: string } }).command.type);
    expect(sent).toEqual(['CREATE_ELEMENT', 'DELETE_ELEMENTS']);
  });

  it.each([
    ['another tab of the same browser joins', 1000, 'replaced', 'replaced'],
    ['the room is full', 1013, 'Room full', 'full'],
  ])('ends the session without reconnecting when %s', (_, code, reason, expected) => {
    const history = new History(createScene());
    const ended: string[] = [];
    const status: boolean[] = [];
    joinLiveSession(history, {
      roomId: 'room-123',
      onEnded: (why) => ended.push(why),
      onStatus: (connected) => status.push(connected),
    });
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.close(code, reason);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(ended).toEqual([expected]);
    // No "reconnecting" status: the session is over.
    expect(status).toEqual([true]);
    expect(leaveLiveSession()).toBe(false);
  });

  it('backs off while the room keeps refusing before the first init', () => {
    const history = new History(createScene());
    joinLiveSession(history, { roomId: 'room-123' });
    // Sockets that open and drop without ever receiving the room state.
    for (let attempt = 0; attempt < 3; attempt++) {
      const socket = FakeSocket.all.at(-1)!;
      socket.onopen?.();
      socket.close(1006);
      vi.advanceTimersByTime(1000);
    }
    // 1 s, then 2 s, then 4 s: after three 1 s steps only two retries ran.
    expect(FakeSocket.all).toHaveLength(3);
    leaveLiveSession();
  });

  it('can leave while reconnecting after a dropped connection', () => {
    const history = new History(createScene());
    joinLiveSession(history, { roomId: 'room-123' });
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.close(1006);
    expect(leaveLiveSession()).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
  });
});

describe('live agent request access', () => {
  afterEach(() => {
    leaveLiveSession();
  });

  it('proves a stored licence on every connect, and nothing without one', () => {
    const history = new History(createScene());
    joinLiveSession(history, { roomId: 'room-123' });
    FakeSocket.all[0]!.open();
    expect(FakeSocket.all[0]!.sent).not.toContainEqual(
      expect.objectContaining({ type: 'auth' }),
    );
    leaveLiveSession();

    store.set('markasso-cloud-license', ' MKC-KEY ');
    joinLiveSession(history, { roomId: 'room-123' });
    FakeSocket.all[1]!.open();
    expect(FakeSocket.all[1]!.sent).toContainEqual({
      type: 'auth',
      license: 'MKC-KEY',
    });
    FakeSocket.all[1]!.close(1006);
    vi.advanceTimersByTime(1000);
    FakeSocket.all[2]!.open();
    expect(FakeSocket.all[2]!.sent).toContainEqual({
      type: 'auth',
      license: 'MKC-KEY',
    });
  });

  it('re-authorizes when the licence changes during the session', () => {
    const history = new History(createScene());
    joinLiveSession(history, { roomId: 'room-123' });
    const socket = FakeSocket.all[0]!;
    socket.open();
    store.set('markasso-cloud-license', 'MKC-NEW');
    document.dispatchEvent(new Event('markasso-cloud-change'));
    expect(socket.sent.at(-1)).toEqual({ type: 'auth', license: 'MKC-NEW' });
    store.delete('markasso-cloud-license');
    document.dispatchEvent(new Event('markasso-cloud-change'));
    expect(socket.sent.at(-1)).toEqual({ type: 'auth', license: '' });
  });
});
