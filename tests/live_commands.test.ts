import { describe, expect, it } from 'vitest';
import { SessionRoom } from '../src/worker';

/** Server half of a WebSocketPair, driven by the test. */
class FakeServerSocket {
  readonly sent: Record<string, unknown>[] = [];
  private listeners = new Map<
    string,
    Array<(event: { data?: string }) => void>
  >();
  addEventListener(type: string, cb: (event: { data?: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  closed: string | null = null;
  close(_code?: number, reason?: string): void {
    this.closed = reason ?? '';
  }
  receive(message: unknown): void {
    for (const cb of this.listeners.get('message') ?? [])
      cb({ data: JSON.stringify(message) });
  }
  ofType(type: string): Record<string, unknown>[] {
    return this.sent.filter((m) => m.type === type);
  }
}

type RoomInternals = {
  initialize(): Promise<void>;
  admit(
    server: FakeServerSocket,
    clientId: string,
    kind: 'browser' | 'agent',
  ): Promise<void>;
};

const element = {
  id: 'a',
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
};
const create = { type: 'CREATE_ELEMENT', element };

async function room(stored?: unknown[]) {
  const state = {
    id: { name: 'room-123' },
    storage: {
      get: async (key: string) => (key === 'commands' ? stored : undefined),
      put: async () => {},
    },
  };
  const instance = new SessionRoom(
    state as unknown as DurableObjectState,
    {} as Env,
  ) as unknown as RoomInternals;
  await instance.initialize();
  const alice = new FakeServerSocket();
  const bob = new FakeServerSocket();
  await instance.admit(alice, 'alice-client', 'browser');
  await instance.admit(bob, 'bob-client', 'browser');
  return { instance, alice, bob };
}

describe('live room commands', () => {
  it('relays a well-formed command and replays it to who joins later', async () => {
    const { instance, alice, bob } = await room();
    alice.receive({ type: 'command', command: create });
    expect(bob.ofType('apply')).toEqual([
      { type: 'apply', command: create, from: alice.ofType('init')[0]?.self },
    ]);
    const carol = new FakeServerSocket();
    await instance.admit(carol, 'carol-client', 'browser');
    expect(carol.ofType('init')[0]?.commands).toEqual([create]);
  });

  it.each([
    ['without its elements', { type: 'CREATE_ELEMENTS' }],
    ['of an unknown type', { type: 'REVIEW_UNKNOWN_COMMAND' }],
    ['with an invalid element', { type: 'CREATE_ELEMENT', element: {} }],
  ])('drops a command %s', async (_, command) => {
    const { instance, alice, bob } = await room();
    alice.receive({ type: 'command', command });
    expect(bob.ofType('apply')).toEqual([]);
    const carol = new FakeServerSocket();
    await instance.admit(carol, 'carol-client', 'browser');
    expect(carol.ofType('init')[0]?.commands).toEqual([]);
  });

  it('leaves a malformed command out of a stored log', async () => {
    const { alice } = await room([
      create,
      { type: 'CREATE_ELEMENTS' },
      { type: 'DELETE_ELEMENTS', ids: ['zzz'] },
    ]);
    expect(alice.ofType('init')[0]?.commands).toEqual([
      create,
      { type: 'DELETE_ELEMENTS', ids: ['zzz'] },
    ]);
  });

  it('replaces the first of two tabs with the same client id that join at once', async () => {
    const { instance } = await room();
    const first = new FakeServerSocket();
    const second = new FakeServerSocket();
    await Promise.all([
      instance.admit(first, 'carol-client', 'browser'),
      instance.admit(second, 'carol-client', 'browser'),
    ]);
    // Both registered, they would miss each other's edits.
    expect(first.closed).toBe('replaced');
    expect(second.closed).toBeNull();
  });
});
