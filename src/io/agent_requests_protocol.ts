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
 *    `replied` with a text answer; the room relays both to the sender only.
 *
 * Requests are never broadcast and never enter the room's command log.
 */

/** Longest request text a person can send. */
export const MAX_AGENT_REQUEST_CHARS = 2000;
/** Longest reply text an agent can send back. */
export const MAX_AGENT_REPLY_CHARS = 4000;
/** Client-chosen correlation id, echoed back with the first status. */
export const REQUEST_REF_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export type PeerKind = 'browser' | 'agent';

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
  /** The sender's own ref, echoed on `sent` and `rejected`. */
  ref?: string;
  status: AgentRequestStatus;
  reason?: AgentRequestRejection;
  /** The agent's answer, on `replied`. */
  text?: string;
}

/** Room to one browser peer: whether it may send requests to agents. */
export interface RequestAccessMsg {
  type: 'request_access';
  allowed: boolean;
}
