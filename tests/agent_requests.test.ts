import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentRequests,
  agentThreads,
  attachAgentRequests,
  canSendAgentRequests,
  detachAgentRequests,
  handleRequestAccess,
  handleRequestStatus,
  MAX_ENTRIES_PER_AGENT,
  MAX_REPLIES_PER_ENTRY,
  revokeAgentRequestAccess,
  sendAgentRequest,
} from '../src/io/agent_requests';

const AGENT = { id: 'agent', name: 'Claude' };
const ROOM = 'room-1';
const STORAGE_KEY = `markasso-agent-chat-${ROOM}`;

/** An in-memory sessionStorage, as one browser tab has. */
function tabStorage(): Map<string, string> {
  const items = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key),
  });
  return items;
}

function connect(roomId = ROOM) {
  const sent: Record<string, unknown>[] = [];
  attachAgentRequests(roomId, (msg) =>
    sent.push(msg as Record<string, unknown>),
  );
  return sent;
}

/** Simulates a reload: the module state goes, the tab's storage stays. */
function reload(items: Map<string, string>): Record<string, unknown>[] {
  const saved = new Map(items);
  detachAgentRequests();
  for (const [key, value] of saved) items.set(key, value);
  return connect();
}

let storage: Map<string, string>;
beforeEach(() => {
  storage = tabStorage();
});
afterEach(() => {
  detachAgentRequests();
  vi.unstubAllGlobals();
});

describe('agent requests (client)', () => {
  it('sends nothing until the room grants access', () => {
    const sent = connect();
    expect(canSendAgentRequests()).toBe(false);
    expect(sendAgentRequest(AGENT, 'hi')).toBe(false);
    expect(sent).toEqual([]);
  });

  it('tracks a request from sent to replied', () => {
    const sent = connect();
    handleRequestAccess({ type: 'request_access', allowed: true });
    expect(sendAgentRequest(AGENT, '  Add a cache  ')).toBe(true);
    const ref = sent[0]?.ref as string;
    expect(sent[0]).toEqual({
      type: 'request',
      ref,
      to: 'agent',
      text: 'Add a cache',
    });
    handleRequestStatus({
      type: 'request_status',
      ref,
      id: 'r',
      status: 'sent',
    });
    handleRequestStatus({
      type: 'request_status',
      id: 'r',
      status: 'replied',
      text: 'Done',
    });
    // A late `received` does not hide the answer.
    handleRequestStatus({
      type: 'request_status',
      id: 'r',
      status: 'received',
    });
    expect(agentRequests('agent')).toEqual([
      expect.objectContaining({
        status: 'replied',
        replies: [{ text: 'Done', at: expect.any(Number) }],
      }),
    ]);
  });

  it('loses access on an unauthorized rejection and on disconnect', () => {
    const sent = connect();
    handleRequestAccess({ type: 'request_access', allowed: true });
    sendAgentRequest(AGENT, 'hi');
    handleRequestStatus({
      type: 'request_status',
      ref: sent[0]?.ref as string,
      status: 'rejected',
      reason: 'unauthorized',
    });
    expect(canSendAgentRequests()).toBe(false);
    handleRequestAccess({ type: 'request_access', allowed: true });
    revokeAgentRequestAccess();
    expect(canSendAgentRequests()).toBe(false);
  });

  it(`keeps only the last ${MAX_ENTRIES_PER_AGENT} requests per agent`, () => {
    connect();
    handleRequestAccess({ type: 'request_access', allowed: true });
    for (let i = 0; i < MAX_ENTRIES_PER_AGENT + 2; i++)
      sendAgentRequest(AGENT, `request ${i}`);
    const texts = agentRequests('agent').map((e) => e.text);
    expect(texts).toHaveLength(MAX_ENTRIES_PER_AGENT);
    expect(texts[0]).toBe('request 2');
  });

  it('remembers the agent name for a thread whose agent left', () => {
    connect();
    handleRequestAccess({ type: 'request_access', allowed: true });
    sendAgentRequest(AGENT, 'hi');
    expect(agentThreads()).toEqual([
      expect.objectContaining({ agentId: 'agent', name: 'Claude' }),
    ]);
  });

  it('forgets everything, stored copy included, when the session ends', () => {
    connect();
    handleRequestAccess({ type: 'request_access', allowed: true });
    sendAgentRequest(AGENT, 'hi');
    expect(storage.has(STORAGE_KEY)).toBe(true);
    detachAgentRequests();
    expect(agentRequests('agent')).toEqual([]);
    expect(canSendAgentRequests()).toBe(false);
    expect(storage.has(STORAGE_KEY)).toBe(false);
  });
});

describe('agent requests across a reload', () => {
  it('restores the thread and applies a reply that lands after the reload', () => {
    const sent = connect();
    handleRequestAccess({ type: 'request_access', allowed: true });
    sendAgentRequest(AGENT, 'Add a cache');
    handleRequestStatus({
      type: 'request_status',
      ref: sent[0]?.ref as string,
      id: 'r',
      status: 'sent',
    });

    reload(storage);
    expect(canSendAgentRequests()).toBe(false);
    expect(agentRequests('agent')).toEqual([
      expect.objectContaining({ text: 'Add a cache', status: 'sent' }),
    ]);
    handleRequestStatus({
      type: 'request_status',
      id: 'r',
      status: 'replied',
      text: 'Done',
    });
    expect(agentRequests('agent')[0]?.status).toBe('replied');
  });

  it('marks a request still sending as interrupted', () => {
    connect();
    handleRequestAccess({ type: 'request_access', allowed: true });
    sendAgentRequest(AGENT, 'hi');
    reload(storage);
    expect(agentRequests('agent')[0]?.status).toBe('interrupted');
  });

  it('keeps rooms apart', () => {
    connect();
    handleRequestAccess({ type: 'request_access', allowed: true });
    sendAgentRequest(AGENT, 'hi');
    const saved = new Map(storage);
    detachAgentRequests();
    for (const [key, value] of saved) storage.set(key, value);
    connect('room-2');
    expect(agentThreads()).toEqual([]);
  });

  it('ignores a damaged stored copy, keeping its valid entries', () => {
    storage.set(STORAGE_KEY, '{not json');
    connect();
    expect(agentThreads()).toEqual([]);
    detachAgentRequests();

    storage.set(
      STORAGE_KEY,
      JSON.stringify({
        v: 1,
        threads: [
          {
            agentId: 'agent',
            name: 'Claude',
            entries: [
              { ref: 'a', text: 'ok', sentAt: 1, status: 'sent', replies: [] },
              { ref: 'b', text: 'bad status', sentAt: 1, status: 'x' },
            ],
          },
          { agentId: 42 },
        ],
      }),
    );
    connect();
    expect(agentRequests('agent').map((e) => e.ref)).toEqual(['a']);
  });

  it('works without sessionStorage, only forgetting on reload', () => {
    vi.stubGlobal('sessionStorage', undefined);
    connect();
    handleRequestAccess({ type: 'request_access', allowed: true });
    expect(sendAgentRequest(AGENT, 'hi')).toBe(true);
    expect(agentRequests('agent')).toHaveLength(1);
  });

  it('stores the newest entries when the quota refuses the full history', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const items = new Map<string, string>();
    // Room for about five short requests, not fifty.
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (value.length > 1500) throw new Error('QuotaExceededError');
        items.set(key, value);
      },
      removeItem: (key: string) => items.delete(key),
    });
    connect();
    handleRequestAccess({ type: 'request_access', allowed: true });
    for (let i = 0; i < 30; i++) sendAgentRequest(AGENT, `request ${i}`);
    expect(agentRequests('agent')).toHaveLength(30);
    reload(items);
    const texts = agentRequests('agent').map((e) => e.text);
    expect(texts.at(-1)).toBe('request 29');
    expect(texts.length).toBeLessThan(30);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('agent requests across a disconnect', () => {
  it('marks a request still sending as unconfirmed, and a late `sent` fixes it', () => {
    const sent = connect();
    handleRequestAccess({ type: 'request_access', allowed: true });
    sendAgentRequest(AGENT, 'hi');
    revokeAgentRequestAccess();
    expect(agentRequests('agent')[0]?.status).toBe('interrupted');
    handleRequestStatus({
      type: 'request_status',
      ref: sent[0]?.ref as string,
      id: 'r',
      status: 'sent',
    });
    expect(agentRequests('agent')[0]?.status).toBe('sent');
  });

  it(`keeps the last ${MAX_REPLIES_PER_ENTRY} replies of a request`, () => {
    const sent = connect();
    handleRequestAccess({ type: 'request_access', allowed: true });
    sendAgentRequest(AGENT, 'hi');
    handleRequestStatus({
      type: 'request_status',
      ref: sent[0]?.ref as string,
      id: 'r',
      status: 'sent',
    });
    for (let i = 0; i < MAX_REPLIES_PER_ENTRY + 3; i++)
      handleRequestStatus({
        type: 'request_status',
        id: 'r',
        status: 'replied',
        text: `reply ${i}`,
      });
    const replies = agentRequests('agent')[0]?.replies ?? [];
    expect(replies).toHaveLength(MAX_REPLIES_PER_ENTRY);
    expect(replies[0]?.text).toBe('reply 3');
  });
});
