import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Element } from '../../src/elements/element';
import { Diagram } from '../src/diagram';
import { LiveLink, parseLiveLink } from '../src/live';

type SocketEvent = {
  data?: string;
  code?: number | undefined;
  reason?: string | undefined;
};

/** Minimal stand-in for the platform WebSocket, driven by the test. */
class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket | null = null;
  readyState = 0;
  readonly url: string;
  readonly sent: unknown[] = [];
  private listeners = new Map<string, Array<(event: SocketEvent) => void>>();
  constructor(url: string) {
    this.url = url;
    FakeSocket.last = this;
    queueMicrotask(() => {
      this.readyState = FakeSocket.OPEN;
      this.emit('open', {});
    });
  }
  addEventListener(type: string, cb: (event: SocketEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.emit('close', { code, reason });
  }
  emit(type: string, event: SocketEvent): void {
    for (const cb of this.listeners.get(type) ?? []) cb(event);
  }
  receive(message: unknown): void {
    this.emit('message', { data: JSON.stringify(message) });
  }
}

const original = globalThis.WebSocket;
beforeEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
});
afterEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = original;
});

const rect = (id: string, label: string): Element => ({
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
  label,
});

async function join(diagram: Diagram, commands: unknown[]) {
  const pending = LiveLink.join(
    diagram,
    'https://markasso.it/?live=room-123',
    'Claude',
  );
  await new Promise((r) => setTimeout(r, 0));
  const socket = FakeSocket.last!;
  socket.receive({
    type: 'init',
    self: 'me',
    commands,
    peers: [{ id: 'p1', name: 'Alberto', color: '#fff' }],
  });
  return { result: await pending, socket };
}

describe('parseLiveLink', () => {
  it('reads the room from a live link or a bare id', () => {
    expect(parseLiveLink('https://markasso.it/?live=abc_123')).toEqual({
      room: 'abc_123',
      origin: 'https://markasso.it',
    });
    expect(parseLiveLink('abc-123').room).toBe('abc-123');
    expect(() => parseLiveLink('https://markasso.it/')).toThrow(
      'no valid "live"',
    );
  });
});

describe('LiveLink', () => {
  it('connects with presence and adopts a room that has content', async () => {
    const diagram = new Diagram([rect('local', 'Mine')]);
    const { result, socket } = await join(diagram, [
      { type: 'CREATE_ELEMENT', element: rect('room', 'From room') },
    ]);
    expect(socket.url).toMatch(
      /^wss:\/\/markasso\.it\/session\/ws\?room=room-123&clientId=[A-Za-z0-9]{24}$/,
    );
    expect(socket.sent[0]).toMatchObject({ type: 'presence', name: 'Claude' });
    expect(result.discarded).toBe(1);
    expect(diagram.elements.map((el) => el.id)).toEqual(['room']);
    expect(result.link.otherPeers.map((p) => p.name)).toEqual(['Alberto']);
  });

  it('publishes the local diagram to an empty room', async () => {
    const diagram = new Diagram([rect('local', 'Mine')]);
    const { result, socket } = await join(diagram, []);
    expect(result.seeded).toBe(true);
    expect(socket.sent[1]).toMatchObject({
      type: 'command',
      command: { type: 'CREATE_ELEMENTS' },
    });
  });

  it('forwards local edits and applies remote ones', async () => {
    const diagram = new Diagram();
    const { socket } = await join(diagram, []);
    await diagram.addNodes([{ key: 'api' }]);
    expect(socket.sent.at(-1)).toMatchObject({
      type: 'command',
      command: { type: 'CREATE_ELEMENTS' },
    });
    socket.receive({
      type: 'apply',
      from: 'p1',
      command: { type: 'CREATE_ELEMENT', element: rect('peer', 'Peer') },
    });
    expect(diagram.elements.map((el) => el.id)).toContain('peer');
  });

  it('skips malformed commands in the room log and from peers', async () => {
    const diagram = new Diagram();
    const { socket } = await join(diagram, [
      { type: 'CREATE_ELEMENTS' },
      { type: 'CREATE_ELEMENT', element: rect('room', 'From room') },
      { type: 'FROM_A_NEWER_CLIENT' },
    ]);
    expect(diagram.elements.map((el) => el.id)).toEqual(['room']);
    socket.receive({ type: 'apply', command: { type: 'CREATE_ELEMENTS' } });
    socket.receive({ type: 'apply', command: { type: 'DELETE_ELEMENTS' } });
    expect(diagram.elements.map((el) => el.id)).toEqual(['room']);
  });

  it('ignores a bare UNDO from an outdated client', async () => {
    const diagram = new Diagram();
    const { socket } = await join(diagram, []);
    await diagram.addNodes([{ key: 'api' }]);
    const sentBefore = socket.sent.length;
    socket.receive({ type: 'apply', from: 'p1', command: { type: 'UNDO' } });
    expect(diagram.elements).toHaveLength(1);
    expect(socket.sent).toHaveLength(sentBefore);
  });

  it('forwards its own undo to the room as a patch', async () => {
    const diagram = new Diagram();
    const { socket } = await join(diagram, []);
    await diagram.addNodes([{ key: 'api' }]);
    diagram.history.undo();
    expect(diagram.elements).toHaveLength(0);
    // Paced: a command right after another leaves on the next interval.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(socket.sent.at(-1)).toMatchObject({
      type: 'command',
      command: { type: 'PATCH_ELEMENTS', delete: [expect.any(String)] },
    });
  });

  it('stops forwarding after leaving', async () => {
    const diagram = new Diagram();
    const { result, socket } = await join(diagram, []);
    result.link.leave();
    const sentBefore = socket.sent.length;
    await diagram.addNodes([{ key: 'api' }]);
    expect(socket.sent).toHaveLength(sentBefore);
  });

  it('waits for the socket to close when leaving before an exit', async () => {
    const diagram = new Diagram();
    const { result, socket } = await join(diagram, []);
    await diagram.addNodes([{ key: 'api' }]);
    const start = Date.now();
    await result.link.leaveAndWait(5_000);
    // Closed, with the last edit sent, well before the time limit.
    expect(socket.readyState).toBe(3);
    expect(socket.sent.at(-1)).toMatchObject({ type: 'command' });
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it('reports the edits the room refused with the next answer', async () => {
    const diagram = new Diagram();
    const { result, socket } = await join(diagram, []);
    socket.receive({ type: 'rejected', reason: 'too_large' });
    socket.receive({ type: 'rejected', reason: 'too_large' });
    socket.receive({ type: 'rejected', reason: 'rate' });
    const note = result.link.takeRejections();
    expect(note).toContain('too large for a single message');
    expect(note).toContain('too many edits');
    expect(note.match(/too large/g)).toHaveLength(1);
    // Reported once.
    expect(result.link.takeRejections()).toBe('');
  });

  it('counts its edits and settles once the held back ones are sent', async () => {
    const diagram = new Diagram();
    const { result, socket } = await join(diagram, []);
    const before = result.link.editCount;
    await diagram.addNodes([{ key: 'api' }]);
    await diagram.addNodes([{ key: 'db' }]);
    expect(result.link.editCount).toBe(before + 2);
    // The second waits for the outbox interval; settling sends it.
    await result.link.settle(1_000, 0);
    const sent = socket.sent.filter(
      (m) => (m as { type?: string }).type === 'command',
    );
    expect(sent.length).toBeGreaterThanOrEqual(2);
  });

  it('authenticates first when MARKASSO_LICENSE is set', async () => {
    process.env.MARKASSO_LICENSE = ' MKC-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE ';
    try {
      const { socket } = await join(new Diagram([]), []);
      expect(socket.sent[0]).toEqual({
        type: 'auth',
        license: 'MKC-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE',
      });
      expect(socket.sent[1]).toMatchObject({ type: 'presence' });
    } finally {
      delete process.env.MARKASSO_LICENSE;
    }
  });

  it('never sends the licence to another host', async () => {
    process.env.MARKASSO_LICENSE = 'MKC-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE';
    try {
      const pending = LiveLink.join(
        new Diagram([]),
        'https://evil.example/?live=room-123',
        'Claude',
      );
      await new Promise((r) => setTimeout(r, 0));
      const socket = FakeSocket.last!;
      expect(socket.url).toMatch(/^wss:\/\/evil\.example\//);
      expect(socket.sent).toHaveLength(1);
      expect(socket.sent[0]).toMatchObject({ type: 'presence' });
      expect(JSON.stringify(socket.sent)).not.toContain('MKC-');
      socket.receive({ type: 'error', error: 'licence required' });
      await expect(pending).rejects.toThrow(
        /not sent because the link points to https:\/\/evil\.example/,
      );
    } finally {
      delete process.env.MARKASSO_LICENSE;
    }
  });

  it('sends the licence to the instance set in MARKASSO_URL', async () => {
    process.env.MARKASSO_LICENSE = 'MKC-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE';
    process.env.MARKASSO_URL = 'http://localhost:8787/';
    try {
      const pending = LiveLink.join(
        new Diagram([]),
        'http://localhost:8787/?live=room-123',
        'Claude',
      );
      await new Promise((r) => setTimeout(r, 0));
      const socket = FakeSocket.last!;
      expect(socket.sent[0]).toMatchObject({ type: 'auth' });
      socket.receive({ type: 'init', self: 'me', commands: [], peers: [] });
      (await pending).link.leave();
    } finally {
      delete process.env.MARKASSO_LICENSE;
      delete process.env.MARKASSO_URL;
    }
  });

  it('explains a missing licence when the room refuses the agent', async () => {
    const pending = LiveLink.join(
      new Diagram([]),
      'https://markasso.it/?live=room-123',
      'Claude',
    );
    await new Promise((r) => setTimeout(r, 0));
    FakeSocket.last!.receive({ type: 'error', error: 'licence required' });
    await expect(pending).rejects.toThrow(/Markasso Cloud licence/);
  });
});

describe('LiveLink requests', () => {
  const request = (id: string, text = 'Add a cache') => ({
    type: 'request',
    id,
    from: 'p1',
    fromName: 'Alberto',
    text,
  });

  it('queues requests and acknowledges them when taken', async () => {
    const { result, socket } = await join(new Diagram(), []);
    socket.receive(request('r1'));
    expect(result.link.pendingRequests).toBe(1);
    expect(result.link.takeRequests()).toEqual([
      { id: 'r1', fromName: 'Alberto', text: 'Add a cache' },
    ]);
    expect(socket.sent.at(-1)).toEqual({
      type: 'agent_status',
      id: 'r1',
      status: 'received',
    });
    expect(result.link.pendingRequests).toBe(0);
  });

  it('wakes a waiting call when a request arrives', async () => {
    const { result, socket } = await join(new Diagram(), []);
    const waiting = result.link.waitForRequests(10_000);
    socket.receive(request('r1'));
    expect((await waiting).map((r) => r.id)).toEqual(['r1']);
  });

  it('returns nothing after the timeout or when the room ends the session', async () => {
    const { result, socket } = await join(new Diagram(), []);
    expect(await result.link.waitForRequests(5)).toEqual([]);
    const waiting = result.link.waitForRequests(10_000);
    socket.close(1013, 'Room full');
    expect(await waiting).toEqual([]);
  });

  it('keeps only the latest twenty requests', async () => {
    const { result, socket } = await join(new Diagram(), []);
    for (let i = 0; i < 25; i++) socket.receive(request(`r${i}`));
    const ids = result.link.takeRequests().map((r) => r.id);
    expect(ids).toHaveLength(20);
    expect(ids[0]).toBe('r5');
  });

  it('replies only to delivered requests', async () => {
    const { result, socket } = await join(new Diagram(), []);
    socket.receive(request('r1'));
    expect(() => result.link.reply('r1', 'Done')).toThrow(/Unknown request/);
    result.link.takeRequests();
    result.link.reply('r1', '  Done  ');
    expect(socket.sent.at(-1)).toEqual({
      type: 'agent_status',
      id: 'r1',
      status: 'replied',
      text: 'Done',
    });
    expect(() => result.link.reply('r1', ' ')).toThrow(/characters/);
  });

  it('points a reply at the elements the agent changed for the request', async () => {
    const diagram = new Diagram();
    const { result, socket } = await join(diagram, []);
    // Created before the request, changed during it.
    await diagram.addNodes([{ key: 'old' }, { key: 'untouched' }]);
    socket.receive(request('r1'));
    result.link.takeRequests();
    diagram.update('old', { label: 'Renamed' });
    // A no-op edit changes nothing to point at.
    diagram.update('untouched', { label: 'untouched' });
    await diagram.addNodes([{ key: 'api' }, { key: 'tmp' }]);
    diagram.remove(['tmp']);
    // A person's edit in the room is theirs, not the agent's.
    socket.receive({
      type: 'apply',
      from: 'p1',
      command: { type: 'CREATE_ELEMENT', element: rect('peer', 'Peer') },
    });
    expect(result.link.reply('r1', 'Done')).toEqual({
      pointed: 2,
      ambiguous: false,
    });
    const { elements } = socket.sent.at(-1) as { elements: string[] };
    expect(elements).toHaveLength(2);
    expect(elements).toContain(diagram.idsOfKeys(['old'])[0]);
    expect(elements).toContain(diagram.idsOfKeys(['api'])[0]);
  });

  it('attributes nothing it cannot tell apart while several requests are open', async () => {
    const diagram = new Diagram();
    const { result, socket } = await join(diagram, []);
    socket.receive(request('r1'));
    socket.receive(request('r2', 'Add a db'));
    result.link.takeRequests();
    await diagram.addNodes([{ key: 'cache' }]);
    expect(result.link.reply('r1', 'Done')).toEqual({
      pointed: 0,
      ambiguous: true,
    });
    expect(socket.sent.at(-1)).not.toHaveProperty('elements');
    // Named explicitly, the answer still points where the agent says.
    result.link.reply('r2', 'Done', diagram.idsOfKeys(['cache']));
    expect(socket.sent.at(-1)).toMatchObject({
      elements: diagram.idsOfKeys(['cache']),
    });
  });

  it('forgets deleted elements, so they never use up the bound', async () => {
    const diagram = new Diagram();
    const { result, socket } = await join(diagram, []);
    socket.receive(request('r1'));
    result.link.takeRequests();
    const scratch = Array.from({ length: 600 }, (_, i) => ({ key: `t${i}` }));
    await diagram.addNodes(scratch);
    diagram.remove(scratch.map((n) => n.key));
    await diagram.addNodes([{ key: 'final' }]);
    expect(result.link.reply('r1', 'Done')).toEqual({
      pointed: 1,
      ambiguous: false,
    });
    expect(socket.sent.at(-1)).toMatchObject({
      elements: diagram.idsOfKeys(['final']),
    });
  });

  it('points at the nodes given instead, and stops counting once answered', async () => {
    const diagram = new Diagram();
    const { result, socket } = await join(diagram, []);
    await diagram.addNodes([{ key: 'old' }]);
    socket.receive(request('r1'));
    result.link.takeRequests();
    await diagram.addNodes([{ key: 'api' }]);
    result.link.reply('r1', 'See old', diagram.idsOfKeys(['old']));
    expect(socket.sent.at(-1)).toMatchObject({
      elements: diagram.idsOfKeys(['old']),
    });
    // Edits after the first answer belong to later requests.
    await diagram.addNodes([{ key: 'later' }]);
    result.link.reply('r1', 'Again');
    expect(socket.sent.at(-1)).toMatchObject({
      elements: diagram.idsOfKeys(['api']),
    });
  });
});

describe('LiveLink activity', () => {
  const request = (id: string) => ({
    type: 'request',
    id,
    from: 'p1',
    fromName: 'Alberto',
    text: 'Add a cache',
  });
  /** The activities the agent announced, in order. */
  const announced = (socket: FakeSocket): unknown[] =>
    socket.sent
      .filter(
        (m): m is { type: string; activity?: string } =>
          typeof m === 'object' && m !== null && 'activity' in m,
      )
      .map((m) => m.activity);

  afterEach(() => {
    vi.useRealTimers();
  });

  it('announces listening, working and, after a grace, idle', async () => {
    const { result, socket } = await join(new Diagram(), []);
    vi.useFakeTimers();
    expect(announced(socket)).toEqual(['idle']);
    const waiting = result.link.waitForRequests(60_000);
    expect(announced(socket)).toEqual(['idle', 'listening']);
    socket.receive(request('r1'));
    await waiting;
    expect(announced(socket)).toEqual(['idle', 'listening', 'working']);
    result.link.reply('r1', 'Done');
    // Not yet: the agent may pick up the next request right away.
    vi.advanceTimersByTime(4000);
    expect(announced(socket)).toHaveLength(3);
    vi.advanceTimersByTime(2000);
    expect(announced(socket)).toEqual(['idle', 'listening', 'working', 'idle']);
  });

  it('never shows idle between two waits in a row', async () => {
    const { result, socket } = await join(new Diagram(), []);
    vi.useFakeTimers();
    const first = result.link.waitForRequests(1000);
    vi.advanceTimersByTime(1000);
    await first;
    // The model calls again within the grace.
    const second = result.link.waitForRequests(60_000);
    vi.advanceTimersByTime(10_000);
    expect(announced(socket)).toEqual(['idle', 'listening']);
    result.link.leave();
    await second;
  });

  it('announces working before any received, even with two waits', async () => {
    const { result, socket } = await join(new Diagram(), []);
    const first = result.link.waitForRequests(60_000);
    const second = result.link.waitForRequests(60_000);
    const before = socket.sent.length;
    socket.receive(request('r1'));
    await Promise.all([first, second]);
    const after = socket.sent
      .slice(before)
      .map((m) => m as { type: string; activity?: string; status?: string });
    expect(after.map((m) => m.activity ?? m.status)).toEqual([
      'working',
      'received',
    ]);
  });
});
