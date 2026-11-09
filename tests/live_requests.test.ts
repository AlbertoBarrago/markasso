import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionRoom } from '../src/worker';
import { mockPolar, polarEnv } from './polar_fake';

const KEY = 'MKC_1C285B2D-6CE6-4BC7-B8BE-ADB6A7E304DA';
const OTHER = 'MKC_9D3E1F7A-0B2C-4D5E-8F90-123456789ABC';

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
  close(): void {
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

type RoomInternals = {
  admit(
    server: FakeServerSocket,
    clientId: string,
    kind: 'browser' | 'agent',
  ): Promise<void>;
};

/** A room with a licensed person, an unlicensed person and an agent. */
async function room() {
  mockPolar([KEY]);
  const state = {
    id: { name: 'room-123' },
    storage: { get: async () => undefined, put: async () => {} },
  };
  const { env } = polarEnv();
  const instance = new SessionRoom(
    state as unknown as DurableObjectState,
    env,
  ) as unknown as RoomInternals;
  const alice = new FakeServerSocket();
  const bob = new FakeServerSocket();
  const agent = new FakeServerSocket();
  await instance.admit(alice, 'alice-client', 'browser');
  await instance.admit(bob, 'bob-client', 'browser');
  await instance.admit(agent, 'agent-client', 'agent');
  return { instance, alice, bob, agent };
}

async function authorize(peer: FakeServerSocket, license: string) {
  peer.receive({ type: 'auth', license });
  await vi.waitFor(() => {
    if (peer.ofType('request_access').length === 0) throw new Error('pending');
  });
  return peer.ofType('request_access').at(-1);
}

const ask = (peer: FakeServerSocket, text = 'Add a cache', ref = 'r1') =>
  peer.receive({ type: 'request', ref, to: 'agent-client', text });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('live agent requests', () => {
  it('lists each peer with its kind', async () => {
    const { alice } = await room();
    expect(alice.ofType('presence').at(-1)?.peers).toEqual([
      expect.objectContaining({ id: 'alice-client', kind: 'browser' }),
      expect.objectContaining({ id: 'bob-client', kind: 'browser' }),
      expect.objectContaining({ id: 'agent-client', kind: 'agent' }),
    ]);
  });

  it('tells only the licensed peer it may send requests', async () => {
    const { alice, bob, agent } = await room();
    expect(await authorize(alice, KEY)).toEqual({
      type: 'request_access',
      allowed: true,
    });
    expect(bob.ofType('request_access')).toEqual([]);
    expect(agent.ofType('request_access')).toEqual([]);
    expect(JSON.stringify(alice.sent)).not.toContain(KEY);
  });

  it('forwards a licensed request to the agent alone', async () => {
    const { alice, bob, agent } = await room();
    await authorize(alice, KEY);
    ask(alice);
    const [request] = agent.ofType('request');
    expect(request).toMatchObject({
      from: 'alice-client',
      text: 'Add a cache',
    });
    expect(alice.ofType('request_status')).toEqual([
      { type: 'request_status', id: request?.id, ref: 'r1', status: 'sent' },
    ]);
    expect(bob.ofType('request')).toEqual([]);
    expect(bob.ofType('request_status')).toEqual([]);
  });

  it.each([
    ['no auth', null],
    ['a wrong key', OTHER],
  ])('rejects a request from a peer with %s', async (_, license) => {
    const { bob, agent } = await room();
    if (license) {
      expect(await authorize(bob, license)).toMatchObject({ allowed: false });
    }
    ask(bob);
    expect(agent.ofType('request')).toEqual([]);
    expect(bob.ofType('request_status')).toEqual([
      {
        type: 'request_status',
        status: 'rejected',
        reason: 'unauthorized',
        ref: 'r1',
      },
    ]);
  });

  it('keeps an unlicensed peer drawing', async () => {
    const { alice, bob } = await room();
    await authorize(bob, OTHER);
    bob.receive({
      type: 'command',
      command: { type: 'DELETE_ELEMENTS', ids: ['x'] },
    });
    expect(alice.ofType('apply')).toHaveLength(1);
  });

  it('never lets an agent send requests', async () => {
    const { agent } = await room();
    await authorize(agent, KEY).catch(() => undefined);
    agent.receive({ type: 'request', to: 'agent-client', text: 'loop' });
    expect(agent.ofType('request')).toEqual([]);
  });

  it('rejects requests to a peer that is not a connected agent', async () => {
    const { alice, agent } = await room();
    await authorize(alice, KEY);
    alice.receive({ type: 'request', ref: 'r1', to: 'bob-client', text: 'hi' });
    agent.close();
    ask(alice, 'hi', 'r2');
    expect(
      alice.ofType('request_status').map((m) => [m.ref, m.reason]),
    ).toEqual([
      ['r1', 'unavailable'],
      ['r2', 'unavailable'],
    ]);
  });

  it('rejects empty or too long text', async () => {
    const { alice, agent } = await room();
    await authorize(alice, KEY);
    ask(alice, '   ');
    ask(alice, 'x'.repeat(2001));
    expect(agent.ofType('request')).toEqual([]);
    expect(alice.ofType('request_status').map((m) => m.reason)).toEqual([
      'invalid',
      'invalid',
    ]);
  });

  it('rate limits a sender', async () => {
    const { alice, agent } = await room();
    await authorize(alice, KEY);
    for (let i = 0; i < 7; i++) ask(alice, `request ${i}`, `r${i}`);
    expect(agent.ofType('request')).toHaveLength(6);
    expect(alice.ofType('request_status').at(-1)).toMatchObject({
      ref: 'r6',
      status: 'rejected',
      reason: 'rate_limited',
    });
  });

  it('relays the agent progress to the sender only', async () => {
    const { alice, bob, agent } = await room();
    await authorize(alice, KEY);
    ask(alice);
    const id = agent.ofType('request')[0]?.id;
    agent.receive({ type: 'agent_status', id, status: 'received' });
    agent.receive({
      type: 'agent_status',
      id,
      status: 'replied',
      text: 'Done',
    });
    expect(alice.ofType('request_status').slice(1)).toEqual([
      { type: 'request_status', id, status: 'received' },
      { type: 'request_status', id, status: 'replied', text: 'Done' },
    ]);
    expect(bob.ofType('request_status')).toEqual([]);
  });

  it('ignores answers from anyone but the target agent', async () => {
    const { alice, bob, agent } = await room();
    await authorize(alice, KEY);
    ask(alice);
    const id = agent.ofType('request')[0]?.id;
    bob.receive({ type: 'agent_status', id, status: 'replied', text: 'fake' });
    expect(alice.ofType('request_status')).toHaveLength(1);
  });

  it('bounds licence checks per connection', async () => {
    const { bob } = await room();
    const fetch = vi.mocked(globalThis.fetch);
    for (let i = 0; i < 8; i++) bob.receive({ type: 'auth', license: OTHER });
    await vi.waitFor(() => {
      if (bob.ofType('request_access').length < 8) throw new Error('pending');
    });
    // The invalid answer is cached after the first lookup; the limit stops
    // the rest from even reaching the cache.
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(5);
    expect(bob.ofType('request_access').every((m) => !m.allowed)).toBe(true);
  });
});
