import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Element } from '../../src/elements/element';
import { Diagram } from '../src/diagram';
import { LiveLink, parseLiveLink } from '../src/live';

/** Minimal stand-in for the platform WebSocket, driven by the test. */
class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket | null = null;
  readyState = 0;
  readonly url: string;
  readonly sent: unknown[] = [];
  private listeners = new Map<
    string,
    Array<(event: { data?: string }) => void>
  >();
  constructor(url: string) {
    this.url = url;
    FakeSocket.last = this;
    queueMicrotask(() => {
      this.readyState = FakeSocket.OPEN;
      this.emit('open', {});
    });
  }
  addEventListener(type: string, cb: (event: { data?: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = 3;
    this.emit('close', {});
  }
  emit(type: string, event: { data?: string }): void {
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

  it('returns nothing after the timeout or a disconnect', async () => {
    const { result, socket } = await join(new Diagram(), []);
    expect(await result.link.waitForRequests(5)).toEqual([]);
    const waiting = result.link.waitForRequests(10_000);
    socket.close();
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
});
