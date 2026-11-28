import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionRoom } from '../src/worker';
import { polarEnv } from './polar_fake';

const KEY = 'MKC_1C285B2D-6CE6-4BC7-B8BE-ADB6A7E304DA';

/** Server half of a WebSocketPair, driven by the test. */
class FakeServerSocket {
  readonly sent: Record<string, unknown>[] = [];
  closed: { code: number; reason: string } | null = null;
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
  close(code: number, reason: string): void {
    this.closed = { code, reason };
    this.emit('close', {});
  }
  /** The client went away (network drop): no close code from the room. */
  drop(): void {
    this.emit('close', {});
  }
  emit(type: string, event: { data?: string }): void {
    for (const cb of this.listeners.get(type) ?? []) cb(event);
  }
  receive(message: unknown): void {
    this.emit('message', { data: JSON.stringify(message) });
  }
  ofType(type: string): Record<string, unknown>[] {
    return this.sent.filter((m) => m.type === type);
  }
}

type Ticket = { seq: number; closed: boolean };
type RoomInternals = {
  openTicket(server: FakeServerSocket, clientId: string): Ticket;
  admit(
    server: FakeServerSocket,
    clientId: string,
    kind: 'browser' | 'agent',
    ticket?: Ticket,
  ): Promise<boolean>;
  awaitAgentAuth(
    server: FakeServerSocket,
    clientId: string,
    ticket?: Ticket,
  ): void;
  sockets: Map<FakeServerSocket, string>;
  cmdCounts: Map<string, number>;
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

function room(env: Record<string, unknown> = {}) {
  const state = {
    id: { name: 'room-123' },
    storage: { get: async () => undefined, put: async () => {} },
  };
  return new SessionRoom(
    state as unknown as DurableObjectState,
    env as unknown as Env,
  ) as unknown as RoomInternals;
}

/** Whose sockets hold a seat in the room. */
const seated = (instance: RoomInternals) => [...instance.sockets.keys()];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('live room admission', () => {
  it('never lets an older attempt evict a newer one that got in first', async () => {
    const instance = room();
    const older = new FakeServerSocket();
    const newer = new FakeServerSocket();
    const oldTicket = instance.openTicket(older, 'agent-client');
    const newTicket = instance.openTicket(newer, 'agent-client');
    expect(
      await instance.admit(newer, 'agent-client', 'agent', newTicket),
    ).toBe(true);
    // The older attempt finishes last (a slow licence check, say).
    expect(
      await instance.admit(older, 'agent-client', 'agent', oldTicket),
    ).toBe(false);
    expect(newer.closed).toBeNull();
    expect(older.closed).toEqual({ code: 1000, reason: 'replaced' });
    expect(seated(instance)).toEqual([newer]);
  });

  it('still lets a newer attempt replace an older one', async () => {
    const instance = room();
    const older = new FakeServerSocket();
    const newer = new FakeServerSocket();
    const oldTicket = instance.openTicket(older, 'agent-client');
    const newTicket = instance.openTicket(newer, 'agent-client');
    await instance.admit(older, 'agent-client', 'agent', oldTicket);
    await instance.admit(newer, 'agent-client', 'agent', newTicket);
    expect(older.closed).toEqual({ code: 1000, reason: 'replaced' });
    expect(newer.closed).toBeNull();
    expect(seated(instance)).toEqual([newer]);
  });

  it('leaves no seat for a socket that closed while it was admitted', async () => {
    const instance = room();
    const alice = new FakeServerSocket();
    await instance.admit(alice, 'alice-client', 'browser');
    const agent = new FakeServerSocket();
    const ticket = instance.openTicket(agent, 'agent-client');
    // The public id is resolved asynchronously: the socket drops meanwhile.
    const admitting = instance.admit(agent, 'agent-client', 'agent', ticket);
    agent.drop();
    expect(await admitting).toBe(false);
    expect(seated(instance)).toEqual([alice]);
    expect(agent.ofType('init')).toEqual([]);
    expect(alice.ofType('presence').at(-1)?.peers).toHaveLength(1);
  });

  it('does nothing when the licence check of a closed agent ends', async () => {
    let grant: (response: Response) => void = () => {};
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          grant = resolve;
        }),
    );
    const { env } = polarEnv({ LIVE_AGENT_REQUIRES_LICENSE: 'true' });
    const instance = room(env as unknown as Record<string, unknown>);
    const alice = new FakeServerSocket();
    await instance.admit(alice, 'alice-client', 'browser');
    const admit = vi.spyOn(instance, 'admit');
    const abandoned = new FakeServerSocket();
    instance.awaitAgentAuth(abandoned, 'agent-client');
    abandoned.receive({ type: 'auth', license: KEY });
    abandoned.receive({ type: 'presence', name: 'Claude' });
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    // The client gave up on this attempt before the licence was confirmed.
    abandoned.drop();
    grant(
      Response.json({
        status: 'granted',
        key: KEY,
        benefit_id: '22222222-2222-4222-8222-222222222222',
        organization_id: '11111111-1111-4111-8111-111111111111',
        expires_at: null,
      }),
    );
    // The answer is cached once read: the check has ended by then.
    const cache = env.SHARE_LINKS as unknown as {
      put: ReturnType<typeof vi.fn>;
    };
    await vi.waitFor(() => expect(cache.put).toHaveBeenCalled());
    // A task boundary: every microtask of the check has run by then.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(admit).not.toHaveBeenCalled();
    expect(seated(instance)).toEqual([alice]);
    expect(abandoned.sent).toEqual([]);
  });

  it('refuses a socket when the room filled up during its admission', async () => {
    const instance = room();
    const late = new FakeServerSocket();
    const ticket = instance.openTicket(late, 'late-client');
    for (let i = 0; i < 20; i++)
      await instance.admit(
        new FakeServerSocket(),
        `peer-client-${i}`,
        'browser',
      );
    expect(await instance.admit(late, 'late-client', 'browser', ticket)).toBe(
      false,
    );
    expect(late.closed).toEqual({ code: 1013, reason: 'Room full' });
    expect(seated(instance)).not.toContain(late);
  });

  it('ignores what a replaced socket still sends', async () => {
    const instance = room();
    const bob = new FakeServerSocket();
    await instance.admit(bob, 'bob-client', 'browser');
    const older = new FakeServerSocket();
    const newer = new FakeServerSocket();
    await instance.admit(older, 'alice-client', 'browser');
    await instance.admit(newer, 'alice-client', 'browser');
    older.receive({ type: 'command', command: create });
    expect(bob.ofType('apply')).toEqual([]);
    newer.receive({ type: 'command', command: create });
    expect(bob.ofType('apply')).toHaveLength(1);
  });

  it('keeps the limits of the successor when a replaced socket closes late', async () => {
    const instance = room();
    const older = new FakeServerSocket();
    const newer = new FakeServerSocket();
    await instance.admit(older, 'alice-client', 'browser');
    await instance.admit(newer, 'alice-client', 'browser');
    newer.receive({ type: 'command', command: create });
    expect(instance.cmdCounts.get('alice-client')).toBe(1);
    // The old socket's close event arrives after the replacement.
    older.drop();
    expect(instance.cmdCounts.get('alice-client')).toBe(1);
    expect(seated(instance)).toEqual([newer]);
  });
});
