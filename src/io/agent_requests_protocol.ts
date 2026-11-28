/**
 * Wire protocol for requests that people in a live room send to an AI agent
 * peer (the Markasso MCP server). Shared by the room (worker), the app and the
 * MCP server, so every side agrees on shapes and limits.
 *
 * Flow:
 * 1. A browser peer with a stored Markasso Cloud licence sends `auth` after
 *    joining. The room answers it alone with `request_access`.
 * 2. An allowed peer sends `request` to an agent. The room forwards it only to
 *    that agent and confirms to the sender with `request_status: sent` (or
 *    `rejected`, with a reason).
 * 3. The agent reports `received` when the request reaches its model and
 *    `replied` with a text answer, plus the ids of the elements it changed
 *    for it; the room relays both to the sender only, with the sender's
 *    `ref` on every status so it can match a reply even if `sent` was lost.
 *
 * Requests are never broadcast and never enter the room's command log.
 */

/** Longest request text a person can send. */
export const MAX_AGENT_REQUEST_CHARS = 2000;
/** Longest reply text an agent can send back. */
export const MAX_AGENT_REPLY_CHARS = 4000;
/** Client-chosen correlation id, echoed back with every status. */
export const REQUEST_REF_RE = /^[a-zA-Z0-9_-]{1,64}$/;
/** Replies an agent can send to one request; the room drops the rest. */
export const MAX_REPLIES_PER_REQUEST = 20;
/** Element ids a reply can point at; more are dropped. */
export const MAX_REPLY_ELEMENTS = 50;
/** Same bound as element ids in element_validation.ts. */
export const MAX_ELEMENT_ID_CHARS = 128;

/**
 * The valid element ids of an untrusted `elements` field: strings of 1 to
 * MAX_ELEMENT_ID_CHARS characters, without duplicates, at most
 * MAX_REPLY_ELEMENTS. Anything else yields an empty list.
 */
export function sanitizeReplyElements(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  // Looks at a bounded prefix: a huge list from a peer costs no more.
  for (const id of value.slice(0, MAX_REPLY_ELEMENTS * 4)) {
    if (ids.size >= MAX_REPLY_ELEMENTS) break;
    if (
      typeof id === 'string' &&
      id.length > 0 &&
      id.length <= MAX_ELEMENT_ID_CHARS
    )
      ids.add(id);
  }
  return [...ids];
}

export type PeerKind = 'browser' | 'agent';

/**
 * What an agent peer is doing, from its own presence: waiting for requests,
 * busy with delivered ones, or neither (it sees new requests only with its
 * next action). Absent for agents that predate it.
 */
export type AgentActivity = 'listening' | 'working' | 'idle';

export function isAgentActivity(value: unknown): value is AgentActivity {
  return value === 'listening' || value === 'working' || value === 'idle';
}

export type AgentRequestRejection =
  /** The sender has no valid licence (or never proved one). */
  | 'unauthorized'
  /** The target is not a connected agent. */
  | 'unavailable'
  /** Too many requests in a short time. */
  | 'rate_limited'
  /** Empty or too long text. */
  | 'invalid';

export type AgentRequestStatus = 'sent' | 'received' | 'replied' | 'rejected';

/** Room to the agent: one request to handle. */
export interface AgentRequestMsg {
  type: 'request';
  id: string;
  from: string;
  fromName: string;
  text: string;
}

/** Room to the sender: progress of one of their requests. */
export interface RequestStatusMsg {
  type: 'request_status';
  /** Server id; absent only on a rejection before an id was assigned. */
  id?: string;
  /** The sender's own ref, echoed on every status (when it sent one). */
  ref?: string;
  status: AgentRequestStatus;
  reason?: AgentRequestRejection;
  /** The agent's answer, on `replied`. */
  text?: string;
  /** Elements the agent changed for this request, on `replied`. */
  elements?: string[];
}

/** Room to one browser peer: whether it may send requests to agents. */
export interface RequestAccessMsg {
  type: 'request_access';
  allowed: boolean;
}
