import {
  type AgentRequestRejection,
  type AgentRequestStatus,
  MAX_AGENT_REQUEST_CHARS,
  MAX_REPLIES_PER_REQUEST,
  type RequestAccessMsg,
  type RequestStatusMsg,
  sanitizeReplyElements,
} from './agent_requests_protocol';
import {
  readSessionStorage,
  removeSessionStorage,
  writeSessionStorage,
} from './safe_storage';

/**
 * Client state of the requests this tab sends to AI agents in a live room.
 * realtime.ts owns the socket: it attaches its sender for the room it joins
 * and feeds the room's answers here; the agent chat panel reads and
 * subscribes. See agent_requests_protocol.ts for the flow.
 *
 * Threads are kept per room in sessionStorage, so a reload of the tab (which
 * rejoins the same room with the same client id) finds them again, and a
 * reply that lands after the reload still updates its request. Leaving the
 * room forgets them.
 */

/** One answer from the agent. */
export interface AgentReply {
  readonly text: string;
  /** Epoch ms when this tab received it. */
  readonly at: number;
  /** Elements the agent changed for the request (absent when none). */
  readonly elements?: readonly string[];
}

/**
 * Client-only states on top of the protocol's: `sending` until the room
 * confirms, `interrupted` for a request still unconfirmed when the socket
 * dropped or the tab reloaded (it may or may not have reached the room).
 */
export type AgentRequestEntryStatus =
  | AgentRequestStatus
  | 'sending'
  | 'interrupted';

/** One request and its progress, as shown in the agent's thread. */
export interface AgentRequestEntry {
  readonly ref: string;
  readonly text: string;
  /** Epoch ms when it was sent. */
  readonly sentAt: number;
  id?: string;
  status: AgentRequestEntryStatus;
  reason?: AgentRequestRejection;
  replies: AgentReply[];
}

/** The requests sent to one agent, oldest first. */
export interface AgentThread {
  readonly agentId: string;
  /** The agent's name when last asked, shown once it left the room. */
  name: string;
  entries: AgentRequestEntry[];
  /** Replies received and not yet seen in the chat panel. */
  unread: number;
}

/** A reply just received, for notifications. */
export interface AgentReplyEvent {
  readonly agentId: string;
  readonly agentName: string;
}

/** Requests kept per agent; older ones are dropped. */
export const MAX_ENTRIES_PER_AGENT = 50;
/** Replies kept per request (an agent may answer one request many times). */
export const MAX_REPLIES_PER_ENTRY = MAX_REPLIES_PER_REQUEST;
/**
 * Entries per agent tried, in order, when the full history does not fit the
 * tab's storage quota: the newest messages are the ones worth keeping.
 */
const FALLBACK_ENTRY_LIMITS = [20, 5, 0] as const;
const STORAGE_PREFIX = 'markasso-agent-chat-';

type Sender = (msg: unknown) => void;

let allowed = false;
let link: { roomId: string; send: Sender } | null = null;
const threads = new Map<string, AgentThread>();
const byRef = new Map<string, AgentRequestEntry>();
const byId = new Map<string, AgentRequestEntry>();
const listeners = new Set<() => void>();
const replyListeners = new Set<(event: AgentReplyEvent) => void>();

function storageKey(roomId: string): string {
  return `${STORAGE_PREFIX}${roomId}`;
}

/** Writes the threads of the current room; a refused write only loses history. */
let warnedStorage = false;

/** Replies held in `entries`: the most there can be unread. */
function replyTotal(entries: readonly AgentRequestEntry[]): number {
  return entries.reduce((n, e) => n + e.replies.length, 0);
}

/** Unread never counts replies that were dropped to stay within limits. */
function clampUnread(thread: AgentThread): void {
  thread.unread = Math.min(thread.unread, replyTotal(thread.entries));
}

function serialize(entryLimit: number): string {
  const kept = [...threads.values()].map((thread) => {
    const entries = entryLimit > 0 ? thread.entries.slice(-entryLimit) : [];
    return {
      ...thread,
      entries,
      unread: Math.min(thread.unread, replyTotal(entries)),
    };
  });
  return JSON.stringify({ v: 1, threads: kept });
}

/**
 * Writes the threads of the current room. When the quota refuses the full
 * history, the newest entries are stored instead; when nothing can be stored
 * the chat keeps working and only a reload loses it (warned once).
 */
function persist(): void {
  if (!link) return;
  const key = storageKey(link.roomId);
  for (const limit of [MAX_ENTRIES_PER_AGENT, ...FALLBACK_ENTRY_LIMITS])
    if (writeSessionStorage(key, serialize(limit))) return;
  if (!warnedStorage) {
    warnedStorage = true;
    console.warn(
      '[agent-chat] This tab cannot store the chat: a reload will lose it.',
    );
  }
}

function emit(): void {
  persist();
  for (const listener of listeners) listener();
}

function forget(): void {
  threads.clear();
  byRef.clear();
  byId.clear();
}

function index(entry: AgentRequestEntry): void {
  byRef.set(entry.ref, entry);
  if (entry.id) byId.set(entry.id, entry);
}

const ENTRY_STATUSES: ReadonlySet<string> = new Set<AgentRequestEntryStatus>([
  'sending',
  'sent',
  'received',
  'replied',
  'rejected',
  'interrupted',
]);
const REJECTIONS: ReadonlySet<string> = new Set<AgentRequestRejection>([
  'unauthorized',
  'unavailable',
  'rate_limited',
  'invalid',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseReply(value: unknown): AgentReply | null {
  if (!isRecord(value)) return null;
  const { text, at } = value;
  if (typeof text !== 'string' || typeof at !== 'number') return null;
  const elements = sanitizeReplyElements(value.elements);
  return elements.length > 0 ? { text, at, elements } : { text, at };
}

function parseEntry(value: unknown): AgentRequestEntry | null {
  if (!isRecord(value)) return null;
  const { ref, text, sentAt, id, status, reason, replies } = value;
  if (
    typeof ref !== 'string' ||
    typeof text !== 'string' ||
    typeof sentAt !== 'number' ||
    typeof status !== 'string' ||
    !ENTRY_STATUSES.has(status) ||
    !Array.isArray(replies)
  )
    return null;
  const entry: AgentRequestEntry = {
    ref,
    text,
    sentAt,
    // The confirmation of a request still sending was lost with the page.
    status:
      status === 'sending'
        ? 'interrupted'
        : (status as AgentRequestEntryStatus),
    replies: replies
      .map(parseReply)
      .filter((r) => r !== null)
      .slice(-MAX_REPLIES_PER_ENTRY),
  };
  if (typeof id === 'string') entry.id = id;
  if (typeof reason === 'string' && REJECTIONS.has(reason))
    entry.reason = reason as AgentRequestRejection;
  return entry;
}

/**
 * Threads stored for `roomId`. The data is this tab's own, but it is parsed
 * defensively: an older or damaged copy yields what is still valid.
 */
function loadThreads(roomId: string): AgentThread[] {
  const raw = readSessionStorage(storageKey(roomId));
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    console.warn('[agent-chat] Dropping an unreadable stored chat', error);
    return [];
  }
  if (!isRecord(data) || data.v !== 1 || !Array.isArray(data.threads))
    return [];
  const loaded: AgentThread[] = [];
  for (const value of data.threads) {
    if (!isRecord(value)) continue;
    const { agentId, name, entries } = value;
    if (
      typeof agentId !== 'string' ||
      typeof name !== 'string' ||
      !Array.isArray(entries)
    )
      continue;
    const { unread } = value;
    const thread: AgentThread = {
      agentId,
      name,
      entries: entries
        .map(parseEntry)
        .filter((e) => e !== null)
        .slice(-MAX_ENTRIES_PER_AGENT),
      // Absent from copies stored before unread counts existed.
      unread:
        typeof unread === 'number' && Number.isInteger(unread) && unread > 0
          ? unread
          : 0,
    };
    clampUnread(thread);
    loaded.push(thread);
  }
  return loaded;
}

/** Notified on any change of access or of a request's progress. */
export function subscribeAgentRequests(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Attaches the live socket's sender for `roomId` and restores the threads
 * this tab kept for that room. Access stays off until the room answers `auth`.
 */
export function attachAgentRequests(roomId: string, send: Sender): void {
  forget();
  allowed = false;
  link = { roomId, send };
  for (const thread of loadThreads(roomId)) {
    threads.set(thread.agentId, thread);
    for (const entry of thread.entries) index(entry);
  }
  emit();
}

/** The session ended: forgets access and every request, stored ones too. */
export function detachAgentRequests(): void {
  if (link) removeSessionStorage(storageKey(link.roomId));
  link = null;
  allowed = false;
  forget();
  for (const listener of listeners) listener();
}

/** Whether the room confirmed this tab's licence for agent requests. */
export function canSendAgentRequests(): boolean {
  return allowed && link !== null;
}

/**
 * Drops access until the room answers a new `auth` (on a disconnect, or the
 * licence removed). A request still waiting for the room's confirmation may
 * or may not have reached it: it shows as unconfirmed, and a late `sent`
 * still updates it.
 */
export function revokeAgentRequestAccess(): void {
  let changed = allowed;
  allowed = false;
  for (const entry of byRef.values()) {
    if (entry.status !== 'sending') continue;
    entry.status = 'interrupted';
    changed = true;
  }
  if (changed) emit();
}

export function agentRequests(agentId: string): readonly AgentRequestEntry[] {
  return threads.get(agentId)?.entries ?? [];
}

/** Every agent this tab has asked in the room, in first-asked order. */
export function agentThreads(): readonly AgentThread[] {
  return [...threads.values()];
}

/**
 * Sends `text` to `agent`. Returns false, sending nothing, when access is
 * not granted or the text is empty or too long; the room checks all of this
 * again.
 */
export function sendAgentRequest(
  agent: { readonly id: string; readonly name: string },
  text: string,
): boolean {
  const trimmed = text.trim();
  if (
    !link ||
    !canSendAgentRequests() ||
    !trimmed ||
    trimmed.length > MAX_AGENT_REQUEST_CHARS
  )
    return false;
  const ref = crypto.randomUUID();
  const entry: AgentRequestEntry = {
    ref,
    text: trimmed,
    sentAt: Date.now(),
    status: 'sending',
    replies: [],
  };
  const thread = threads.get(agent.id) ?? {
    agentId: agent.id,
    name: agent.name,
    entries: [],
    unread: 0,
  };
  thread.name = agent.name;
  thread.entries.push(entry);
  for (const dropped of thread.entries.splice(
    0,
    Math.max(0, thread.entries.length - MAX_ENTRIES_PER_AGENT),
  )) {
    byRef.delete(dropped.ref);
    if (dropped.id) byId.delete(dropped.id);
  }
  clampUnread(thread);
  threads.set(agent.id, thread);
  index(entry);
  link.send({ type: 'request', ref, to: agent.id, text: trimmed });
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
  let replied: AgentThread | undefined;
  if (msg.status === 'replied') {
    if (typeof msg.text === 'string' && msg.text) {
      // The room validated them; this tab checks again before using them.
      const elements = sanitizeReplyElements(msg.elements);
      entry.replies.push(
        elements.length > 0
          ? { text: msg.text, at: Date.now(), elements }
          : { text: msg.text, at: Date.now() },
      );
      replied = [...threads.values()].find((t) => t.entries.includes(entry));
      if (replied) replied.unread++;
    }
    entry.replies.splice(
      0,
      Math.max(0, entry.replies.length - MAX_REPLIES_PER_ENTRY),
    );
    if (replied) clampUnread(replied);
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
  // Before the change notification: a listener that is showing this thread
  // marks it read, so the badge never flashes the reply as unread.
  if (replied) {
    const event = { agentId: replied.agentId, agentName: replied.name };
    for (const listener of replyListeners) listener(event);
  }
  emit();
}

/** Notified once per reply received, after it is counted as unread. */
export function onAgentReply(cb: (event: AgentReplyEvent) => void): () => void {
  replyListeners.add(cb);
  return () => {
    replyListeners.delete(cb);
  };
}

/**
 * The agent's replies were seen (its thread is shown in the panel). Returns
 * whether anything changed, i.e. whether subscribers were notified.
 */
export function markAgentThreadRead(agentId: string): boolean {
  const thread = threads.get(agentId);
  if (!thread || thread.unread === 0) return false;
  thread.unread = 0;
  emit();
  return true;
}

/** Replies not yet seen, over every agent of the room. */
export function unreadAgentReplies(): number {
  let total = 0;
  for (const thread of threads.values()) total += thread.unread;
  return total;
}
