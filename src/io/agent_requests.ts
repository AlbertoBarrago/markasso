import {
  type AgentRequestRejection,
  type AgentRequestStatus,
  MAX_AGENT_REQUEST_CHARS,
  type RequestAccessMsg,
  type RequestStatusMsg,
} from './agent_requests_protocol';

/**
 * Client state of the requests this tab sends to AI agents in a live room.
 * realtime.ts owns the socket: it plugs its sender in and feeds the room's
 * answers here; the people list reads and subscribes. See
 * agent_requests_protocol.ts for the flow.
 */

/** One request and its progress, as shown under the agent's row. */
export interface AgentRequestEntry {
  readonly ref: string;
  readonly text: string;
  id?: string;
  status: AgentRequestStatus | 'sending';
  reason?: AgentRequestRejection;
  replies: string[];
}

/** Requests kept per agent: the panel shows a short recent history only. */
const MAX_ENTRIES_PER_AGENT = 5;

let allowed = false;
let sender: ((msg: unknown) => void) | null = null;
const threads = new Map<string, AgentRequestEntry[]>();
const byRef = new Map<string, AgentRequestEntry>();
const byId = new Map<string, AgentRequestEntry>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Notified on any change of access or of a request's progress. */
export function subscribeAgentRequests(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Attaches the live socket's sender, or detaches it (null) when the session
 * ends, which also forgets access and every request.
 */
export function setAgentRequestSender(
  send: ((msg: unknown) => void) | null,
): void {
  sender = send;
  if (send) return;
  allowed = false;
  threads.clear();
  byRef.clear();
  byId.clear();
  emit();
}

/** Whether the room confirmed this tab's licence for agent requests. */
export function canSendAgentRequests(): boolean {
  return allowed && sender !== null;
}

/** Drops access until the room answers a new `auth` (e.g. on reconnect). */
export function revokeAgentRequestAccess(): void {
  if (!allowed) return;
  allowed = false;
  emit();
}

export function agentRequests(agentId: string): readonly AgentRequestEntry[] {
  return threads.get(agentId) ?? [];
}

/**
 * Sends `text` to the agent `agentId`. Returns false, sending nothing, when
 * access is not granted or the text is empty or too long; the room checks
 * all of this again.
 */
export function sendAgentRequest(agentId: string, text: string): boolean {
  const trimmed = text.trim();
  if (
    !canSendAgentRequests() ||
    !trimmed ||
    trimmed.length > MAX_AGENT_REQUEST_CHARS
  )
    return false;
  const ref = crypto.randomUUID();
  const entry: AgentRequestEntry = {
    ref,
    text: trimmed,
    status: 'sending',
    replies: [],
  };
  const thread = [...agentRequests(agentId), entry];
  for (const dropped of thread.splice(
    0,
    Math.max(0, thread.length - MAX_ENTRIES_PER_AGENT),
  )) {
    byRef.delete(dropped.ref);
    if (dropped.id) byId.delete(dropped.id);
  }
  threads.set(agentId, thread);
  byRef.set(ref, entry);
  sender?.({ type: 'request', ref, to: agentId, text: trimmed });
  emit();
  return true;
}

export function handleRequestAccess(msg: RequestAccessMsg): void {
  allowed = msg.allowed === true;
  emit();
}

export function handleRequestStatus(msg: RequestStatusMsg): void {
  const entry =
    (msg.ref ? byRef.get(msg.ref) : undefined) ??
    (msg.id ? byId.get(msg.id) : undefined);
  if (!entry) return;
  if (msg.id && !entry.id) {
    entry.id = msg.id;
    byId.set(msg.id, entry);
  }
  if (msg.status === 'replied') {
    if (typeof msg.text === 'string' && msg.text) entry.replies.push(msg.text);
    entry.status = 'replied';
  } else if (msg.status === 'rejected') {
    entry.status = 'rejected';
    if (msg.reason) entry.reason = msg.reason;
    // The room took access away (e.g. it restarted): ask again on reconnect.
    if (msg.reason === 'unauthorized') allowed = false;
  } else if (entry.status !== 'replied') {
    // `received` never overrides a reply that overtook it.
    entry.status = msg.status;
  }
  emit();
}
