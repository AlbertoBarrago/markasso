import { isSessionCommand } from './engine/ephemeral';
import {
  type AgentRequestMsg,
  type AgentRequestRejection,
  MAX_AGENT_REPLY_CHARS,
  MAX_AGENT_REQUEST_CHARS,
  type PeerKind,
  REQUEST_REF_RE,
  type RequestAccessMsg,
  type RequestStatusMsg,
} from './io/agent_requests_protocol';
import { randomAnimalName } from './io/animal_names';
import { validateElements } from './io/element_validation';
import {
  buildIssueBody,
  buildIssueTitle,
  validateReport,
} from './io/report_validation';
import { boardRequest, purgeBoards } from './worker/boards';
import { licenseCheck, licenseKeyValid } from './worker/license';
import { macDownload } from './worker/mac_download';
import { RoomLog } from './worker/room_log';

const ID_LENGTH = 8;
const ID_CHARS =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const TTL_SECONDS = 60 * 60 * 24 * 90;
const MAX_REQUEST_BYTES = 1_000_000;

// The REPORT_RATE_LIMITER binding only bounds bursts (its `period` is capped
// at 60s by the Workers runtime); this is the actual per-IP quota window.
const REPORT_QUOTA_LIMIT = 3;
const REPORT_QUOTA_WINDOW_SECONDS = 600;

function generateId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
  return Array.from(bytes, (byte) => ID_CHARS[byte % ID_CHARS.length]).join('');
}

// ── Realtime sessions (Durable Object) ───────────────────────────────────────

interface PeerInfo {
  id: string;
  name: string;
  color: string;
  kind: PeerKind;
}

const LAST_ACTIVITY_KEY = 'lastActivity';
const ROOM_ID_RE = /^[a-zA-Z0-9_-]{3,64}$/;
const CLIENT_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;
const MAX_PEERS = 20;
const CMD_WINDOW_MS = 5000;
const MAX_CMD_PER_WINDOW = 200;
const MAX_MSG_BYTES = 512 * 1024;
/** Requests a person may send to agents per window (see agent_requests_protocol). */
const REQUEST_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 6;
/** Licence checks one browser peer may ask for per connection. */
const MAX_AUTH_ATTEMPTS = 5;
/** Licence checks the whole room may ask for per window (fresh clientIds). */
const AUTH_WINDOW_MS = 60_000;
const MAX_AUTH_PER_WINDOW = 30;
/** Requests whose sender is remembered for routing agent replies. */
const MAX_TRACKED_REQUESTS = 200;
/** How long a gated agent has to send its `auth` message after connecting. */
const AGENT_AUTH_TIMEOUT_MS = 5000;
/** Set by the Worker on the request it forwards to a room; never trusted from clients. */
const PEER_KIND_HEADER = 'X-Markasso-Peer';
/** WebSocket close code for a live agent without a valid licence. */
const CLOSE_LICENCE_REQUIRED = 4402;
/** A room is "inactive" when it has no connected peers and no activity for this long. */
const INACTIVE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/** KV prefix used to enumerate live rooms for the daily cleanup cron. */
const ROOM_INDEX_PREFIX = 'room:';
const ROOM_INDEX_TTL = 90 * 24 * 60 * 60; // 90 days

/**
 * Pure inactivity check, extracted so the cleanup policy is unit-testable.
 * A room is only reclaimed when nobody is connected AND it has been idle
 * longer than the threshold.
 */
export function isRoomInactive(
  now: number,
  lastActivity: number,
  connectedPeers: number,
  thresholdMs: number,
): boolean {
  return connectedPeers === 0 && now - lastActivity > thresholdMs;
}

///**
/**
 * One live editing room. A single serialization point: it appends commands to
 * the room's log and broadcasts each to the other connected peers. Peers
 * converge by replaying the same deterministic reducer in server order.
 *
 * No server-side reducer: the log is relayed as-is and applied identically on
 * every client (LWW for concurrent edits to the same element).
 */
export class SessionRoom {
  private readonly state: DurableObjectState;
  private readonly env: Env;
  /** The room's content: see RoomLog. */
  private readonly log = new RoomLog();
  private readonly sockets = new Map<WebSocket, string>(); // ws -> clientId
  private readonly peers = new Map<string, Omit<PeerInfo, 'id'>>(); // clientId -> props
  /**
   * clientId -> the id other peers see. The clientId is the secret a peer
   * reconnects with (it replaces the socket that holds it and keeps its name
   * and licence), so it never leaves the room: every message names peers by
   * this derived id instead.
   */
  private readonly publicIds = new Map<string, string>();
  /**
   * The hash being computed for a clientId. Shared, so connections with the
   * same clientId resume in the order they arrived and the latest one is
   * the one that stays (see admit).
   */
  private readonly publicIdTasks = new Map<string, Promise<string>>();
  private readonly cmdCounts = new Map<string, number>();
  /** Browser peers that proved a valid licence: they may message agents. */
  private readonly licensed = new Set<string>();
  private readonly authAttempts = new Map<string, number>();
  private authWindowStart = Date.now();
  private authCount = 0;
  /** Send times of each peer's recent agent requests, for the rate limit. */
  private readonly requestTimes = new Map<string, number[]>();
  /** Request id -> sender and target, so only the target can answer. */
  private readonly requests = new Map<string, { from: string; to: string }>();
  private cmdWindowStart = Date.now();
  private loaded = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private lastActivity = Date.now();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private async initialize(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await this.log.load(this.state.storage);
    const last = await this.state.storage.get<number>(LAST_ACTIVITY_KEY);
    if (typeof last === 'number') this.lastActivity = last;
  }

  /** The room name (the value passed to `idFromName`) — used for KV indexing. */
  private roomId(): string {
    return this.state.id.name ?? '';
  }

  private touch(): void {
    this.lastActivity = Date.now();
  }

  /**
   * Resolve the persistent per-user identity. The client sends a stable
   * `clientId` (a random secret kept in localStorage) so a peer keeps their
   * name/color across reconnects and can only ever modify their own
   * properties. Clients that don't send one get a throwaway server id.
   */
  private resolveClientId(raw: string | null): string {
    return raw && CLIENT_ID_RE.test(raw) ? raw : crypto.randomUUID();
  }

  /**
   * The id other peers see for `clientId`: stable across reconnects, so
   * cursors and the people list keep following the same peer, different in
   * every room, and not reversible to the clientId.
   */
  private async publicId(clientId: string): Promise<string> {
    const known = this.publicIds.get(clientId);
    if (known) return known;
    let task = this.publicIdTasks.get(clientId);
    if (!task) {
      task = crypto.subtle
        .digest(
          'SHA-256',
          new TextEncoder().encode(`${this.roomId()}:${clientId}`),
        )
        .then((digest) => {
          const id = Array.from(
            new Uint8Array(digest).subarray(0, 16),
            (byte) => byte.toString(16).padStart(2, '0'),
          ).join('');
          this.publicIds.set(clientId, id);
          this.publicIdTasks.delete(clientId);
          return id;
        });
      this.publicIdTasks.set(clientId, task);
    }
    return task;
  }

  /** The connected peer other peers know as `publicId`, if any. */
  private clientIdOf(publicId: string): string | undefined {
    for (const clientId of this.sockets.values())
      if (this.publicIds.get(clientId) === publicId) return clientId;
    return undefined;
  }

  /** Record this room in the KV index so the daily cron can find it. */
  private async indexRoom(): Promise<void> {
    try {
      await this.env.SHARE_LINKS.put(ROOM_INDEX_PREFIX + this.roomId(), '1', {
        expirationTtl: ROOM_INDEX_TTL,
      });
    } catch {
      // A KV write failure must never break the live session.
    }
  }

  async fetch(request: Request): Promise<Response> {
    await this.initialize();
    const url = new URL(request.url);

    // Internal endpoint used by the daily cleanup cron.
    if (request.method === 'POST' && url.pathname === '/cleanup') {
      return this.cleanup();
    }

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    server.accept();

    // Reject peers beyond the room's capacity.
    if (this.sockets.size >= MAX_PEERS) {
      server.send(JSON.stringify({ type: 'error', error: 'room full' }));
      server.close(1013, 'Room full');
      return new Response(null, { status: 101, webSocket: client });
    }

    const clientId = this.resolveClientId(url.searchParams.get('clientId'));
    const kind: PeerKind =
      request.headers.get(PEER_KIND_HEADER) === 'agent' ? 'agent' : 'browser';

    if (kind === 'agent' && this.env.LIVE_AGENT_REQUIRES_LICENSE === 'true') {
      this.awaitAgentAuth(server, clientId);
    } else {
      await this.admit(server, clientId, kind);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Holds a non-browser peer (an MCP agent) outside the room until its first
   * message, `{ type: 'auth', license }`, proves a valid Markasso Cloud
   * licence. Nothing of the room is sent before that. Messages that arrive
   * while the licence is checked are replayed once the peer is admitted.
   */
  private awaitAgentAuth(server: WebSocket, clientId: string): void {
    const queued: string[] = [];
    let state: 'waiting' | 'checking' | 'done' = 'waiting';
    const refuse = (code: number, error: string): void => {
      state = 'done';
      try {
        server.send(JSON.stringify({ type: 'error', error }));
        server.close(code, error);
      } catch {
        /* already closing */
      }
    };
    const timer = setTimeout(
      () => refuse(CLOSE_LICENCE_REQUIRED, 'licence required'),
      AGENT_AUTH_TIMEOUT_MS,
    );
    server.addEventListener('message', (event) => {
      const data = String(event.data);
      if (state === 'checking') {
        if (queued.length < 50 && data.length <= MAX_MSG_BYTES)
          queued.push(data);
        return;
      }
      if (state !== 'waiting') return;
      clearTimeout(timer);
      let license: string | null = null;
      try {
        const msg = JSON.parse(data) as { type?: unknown; license?: unknown };
        if (msg.type === 'auth' && typeof msg.license === 'string')
          license = msg.license;
      } catch {
        /* not an auth message: refused below */
      }
      state = 'checking';
      void licenseKeyValid(license, this.env).then(
        async (valid) => {
          if (!valid) return refuse(CLOSE_LICENCE_REQUIRED, 'licence required');
          state = 'done';
          await this.admit(server, clientId, 'agent');
          for (const raw of queued) this.receive(clientId, raw);
        },
        (error: unknown) => {
          console.log('[live] licence lookup failed', error);
          refuse(1011, 'licence service unavailable');
        },
      );
    });
    server.addEventListener('close', () => clearTimeout(timer));
  }

  /** Parses one raw socket message from an admitted peer. */
  private receive(clientId: string, raw: string): void {
    if (raw.length > MAX_MSG_BYTES) return;
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    this.handleMessage(clientId, msg);
  }

  /** Registers a socket as a room peer and sends it the room state. */
  private async admit(
    server: WebSocket,
    clientId: string,
    kind: PeerKind,
  ): Promise<void> {
    // Resolved first: the replacement below and the registration must not be
    // split by an await, or two tabs with the same clientId admitted at once
    // would both stay registered and miss each other's edits.
    const self = await this.publicId(clientId);
    // A reconnect with the same clientId replaces any stale live socket so a
    // peer never ends up with two identities in the same room.
    for (const [sock, id] of this.sockets) {
      if (id === clientId) {
        try {
          sock.close(1000, 'replaced');
        } catch {
          /* already closing */
        }
        this.sockets.delete(sock);
      }
    }

    this.sockets.set(server, clientId);
    const known = this.peers.get(clientId);
    if (known) known.kind = kind;
    else
      this.peers.set(clientId, {
        name: randomAnimalName(),
        color: '#a78bfa',
        kind,
      });
    this.touch();
    await this.indexRoom();
    await this.state.storage.put(LAST_ACTIVITY_KEY, this.lastActivity);

    server.send(
      JSON.stringify({
        type: 'init',
        self,
        commands: this.log.commands,
        peers: this.peerList(),
      }),
    );
    this.broadcast({ type: 'presence', peers: this.peerList() });

    server.addEventListener('message', (event) => {
      this.receive(clientId, String(event.data));
    });
    server.addEventListener('close', () => {
      this.dropPeer(server, clientId);
    });
    server.addEventListener('error', () => {
      this.dropPeer(server, clientId);
    });
  }

  private handleMessage(clientId: string, msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as Record<string, unknown>;

    if (m.type === 'command' && m.command) {
      const command = m.command as { type?: string };
      // Also drops bare UNDO/REDO from outdated clients (see isSessionCommand).
      if (!isSessionCommand(command)) return;
      if (!this.allowCommand(clientId)) return;
      // Relayed to every peer and replayed to every joiner: a command the
      // room cannot apply (malformed, refused by the reducer, too large for
      // the room) must stop here.
      if (!this.log.append(command)) return;
      this.touch();
      this.broadcast(
        { type: 'apply', command, from: this.publicIds.get(clientId) },
        /* except */ clientId,
      );
      this.schedulePersist();
      return;
    }

    if (m.type === 'cursor') {
      const x = Number(m.x);
      const y = Number(m.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const peer = this.peers.get(clientId);
      this.broadcast(
        {
          type: 'cursor',
          from: this.publicIds.get(clientId),
          x,
          y,
          name: peer?.name ?? randomAnimalName(),
          color: peer?.color ?? '#a78bfa',
        },
        /* except */ clientId,
      );
      return;
    }

    if (m.type === 'presence') {
      // Security: a peer may only ever update their OWN name/color. The
      // entry is keyed by the connection's clientId, so a message can never
      // touch another peer's properties.
      const peer = this.peers.get(clientId);
      if (!peer) return;
      if (
        typeof m.name === 'string' &&
        m.name.length > 0 &&
        m.name.length <= 24
      ) {
        peer.name = m.name;
      }
      if (typeof m.color === 'string' && /^#[0-9a-f]{6}$/i.test(m.color)) {
        peer.color = m.color;
      }
      this.touch();
      this.broadcast({ type: 'presence', peers: this.peerList() });
      return;
    }

    if (m.type === 'auth') {
      this.authorizeRequests(clientId, m.license);
      return;
    }

    if (m.type === 'request') {
      this.relayRequest(clientId, m);
      return;
    }

    if (m.type === 'agent_status') {
      this.relayAgentStatus(clientId, m);
    }
  }

  /**
   * A browser peer proves its Markasso Cloud licence to message agents. Unlike
   * the agent gate this never blocks the peer: without a licence it keeps
   * drawing, it only gets `allowed: false`. The answer goes to that peer
   * alone, so nobody learns who in the room holds a licence.
   */
  private authorizeRequests(clientId: string, license: unknown): void {
    if (this.peers.get(clientId)?.kind !== 'browser') return;
    const now = Date.now();
    if (now - this.authWindowStart >= AUTH_WINDOW_MS) {
      this.authWindowStart = now;
      this.authCount = 0;
    }
    const attempts = (this.authAttempts.get(clientId) ?? 0) + 1;
    this.authAttempts.set(clientId, attempts);
    // Bounds the Polar lookups random keys can trigger, per peer and per room
    // (a script can reconnect with fresh clientIds). Over the limit the peer
    // keeps the access it already had.
    if (
      attempts > MAX_AUTH_ATTEMPTS ||
      ++this.authCount > MAX_AUTH_PER_WINDOW
    ) {
      this.sendTo(clientId, {
        type: 'request_access',
        allowed: this.licensed.has(clientId),
      });
      return;
    }
    if (typeof license !== 'string' || license.length > 200) {
      this.licensed.delete(clientId);
      this.sendTo(clientId, { type: 'request_access', allowed: false });
      return;
    }
    void licenseKeyValid(license, this.env).then(
      (valid) => this.grantRequests(clientId, valid),
      (error: unknown) => {
        console.log('[live] request licence lookup failed', error);
        this.grantRequests(clientId, false);
      },
    );
  }

  private grantRequests(clientId: string, allowed: boolean): void {
    // The peer may have left while the licence was checked.
    if (!this.isConnected(clientId)) return;
    if (allowed) this.licensed.add(clientId);
    else this.licensed.delete(clientId);
    this.sendTo(clientId, { type: 'request_access', allowed });
  }

  /**
   * Forwards a person's request to one agent, and only to it. Everything is
   * checked here, whatever the client UI shows: a licensed browser sender, a
   * connected agent target, a bounded text and a per-sender rate limit.
   */
  private relayRequest(clientId: string, m: Record<string, unknown>): void {
    const ref =
      typeof m.ref === 'string' && REQUEST_REF_RE.test(m.ref)
        ? m.ref
        : undefined;
    const sender = this.peers.get(clientId);
    const text = typeof m.text === 'string' ? m.text.trim() : '';
    // Peers name each other by public id: resolve the target's own.
    const to = (typeof m.to === 'string' && this.clientIdOf(m.to)) || '';
    let rejection: AgentRequestRejection | null = null;
    if (sender?.kind !== 'browser' || !this.licensed.has(clientId))
      rejection = 'unauthorized';
    else if (!text || text.length > MAX_AGENT_REQUEST_CHARS)
      rejection = 'invalid';
    else if (this.peers.get(to)?.kind !== 'agent' || !this.isConnected(to))
      rejection = 'unavailable';
    // Last, so only well-formed requests count against the limit.
    else if (!this.allowRequest(clientId)) rejection = 'rate_limited';
    if (rejection || !sender) {
      this.sendTo(clientId, {
        type: 'request_status',
        status: 'rejected',
        reason: rejection ?? 'unauthorized',
        ...(ref ? { ref } : {}),
      });
      return;
    }

    const id = crypto.randomUUID();
    this.requests.set(id, { from: clientId, to });
    if (this.requests.size > MAX_TRACKED_REQUESTS) {
      // Maps iterate in insertion order: drop the oldest.
      const oldest = this.requests.keys().next().value;
      if (oldest) this.requests.delete(oldest);
    }
    this.touch();
    this.sendTo(to, {
      type: 'request',
      id,
      from: this.publicIds.get(clientId) ?? '',
      fromName: sender.name,
      text,
    });
    this.sendTo(clientId, {
      type: 'request_status',
      id,
      status: 'sent',
      ...(ref ? { ref } : {}),
    });
  }

  /** Relays an agent's progress on a request to the person who sent it. */
  private relayAgentStatus(clientId: string, m: Record<string, unknown>): void {
    const id = typeof m.id === 'string' ? m.id : '';
    const tracked = this.requests.get(id);
    // Only the agent the request was sent to may answer it.
    if (!tracked || tracked.to !== clientId) return;
    if (m.status === 'received') {
      this.sendTo(tracked.from, {
        type: 'request_status',
        id,
        status: 'received',
      });
      return;
    }
    if (m.status === 'replied') {
      const text = typeof m.text === 'string' ? m.text.trim() : '';
      if (!text || text.length > MAX_AGENT_REPLY_CHARS) return;
      this.touch();
      this.sendTo(tracked.from, {
        type: 'request_status',
        id,
        status: 'replied',
        text,
      });
    }
  }

  private allowRequest(clientId: string): boolean {
    const now = Date.now();
    const recent = (this.requestTimes.get(clientId) ?? []).filter(
      (time) => now - time < REQUEST_WINDOW_MS,
    );
    if (recent.length >= MAX_REQUESTS_PER_WINDOW) {
      this.requestTimes.set(clientId, recent);
      return false;
    }
    recent.push(now);
    this.requestTimes.set(clientId, recent);
    return true;
  }

  private isConnected(clientId: string): boolean {
    for (const id of this.sockets.values()) if (id === clientId) return true;
    return false;
  }

  /** Sends to every socket of one peer (normally exactly one). */
  private sendTo(
    clientId: string,
    msg: AgentRequestMsg | RequestStatusMsg | RequestAccessMsg,
  ): void {
    const data = JSON.stringify(msg);
    for (const [socket, peerId] of this.sockets) {
      if (peerId !== clientId) continue;
      try {
        socket.send(data);
      } catch {
        // socket may be closing
      }
    }
  }

  private dropPeer(socket: WebSocket, clientId: string): void {
    this.sockets.delete(socket);
    this.cmdCounts.delete(clientId);
    // A replaced socket closes after its successor joined: keep the
    // successor's licence and limits.
    if (!this.isConnected(clientId)) {
      this.licensed.delete(clientId);
      this.authAttempts.delete(clientId);
      this.requestTimes.delete(clientId);
    }
    // Keep the peer's name/color in `peers` so a reconnect with the same
    // clientId restores them; only the live list is broadcast.
    this.broadcast({ type: 'presence', peers: this.peerList() });
  }

  private allowCommand(peerId: string): boolean {
    const now = Date.now();
    if (now - this.cmdWindowStart >= CMD_WINDOW_MS) {
      this.cmdWindowStart = now;
      this.cmdCounts.clear();
    }
    const count = (this.cmdCounts.get(peerId) ?? 0) + 1;
    if (count > MAX_CMD_PER_WINDOW) return false;
    this.cmdCounts.set(peerId, count);
    return true;
  }

  private peerList(): PeerInfo[] {
    const connected = new Set(this.sockets.values());
    return [...this.peers.entries()]
      .filter(([id]) => connected.has(id))
      .map(([id, p]) => ({ id: this.publicIds.get(id) ?? '', ...p }));
  }

  private broadcast(msg: unknown, exceptPeerId?: string): void {
    const data = JSON.stringify(msg);
    for (const [socket, peerId] of this.sockets) {
      if (peerId === exceptPeerId) continue;
      try {
        socket.send(data);
      } catch {
        // socket may be closing
      }
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(async () => {
      this.persistTimer = null;
      try {
        await this.log.save(this.state.storage, {
          [LAST_ACTIVITY_KEY]: this.lastActivity,
        });
      } catch (error) {
        // The changes stay pending: the next command saves them again.
        console.log('[live] could not save the room log', error);
      }
    }, 800);
  }

  /**
   * Called by the daily cron. Reclaims the room when it is inactive (no
   * connected peers and idle past the threshold), wiping its persisted log.
   */
  private async cleanup(): Promise<Response> {
    await this.initialize();
    const inactive = isRoomInactive(
      Date.now(),
      this.lastActivity,
      this.sockets.size,
      INACTIVE_THRESHOLD_MS,
    );
    if (!inactive) return Response.json({ deleted: false });

    await this.state.storage.deleteAll();
    this.log.reset();
    this.peers.clear();
    try {
      await this.env.SHARE_LINKS.delete(ROOM_INDEX_PREFIX + this.roomId());
    } catch {
      /* best-effort */
    }
    return Response.json({ deleted: true });
  }
}

function isAllowedOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get('Origin');
  return origin === null || origin === url.origin;
}

function apiHeaders(request: Request, url: URL): Headers {
  const headers = new Headers({ Vary: 'Origin' });
  const origin = request.headers.get('Origin');
  if (origin === url.origin) headers.set('Access-Control-Allow-Origin', origin);
  return headers;
}

function jsonResponse(
  request: Request,
  url: URL,
  body: unknown,
  status = 200,
): Response {
  const headers = apiHeaders(request, url);
  headers.set('Cache-Control', 'no-store');
  return Response.json(body, { status, headers });
}

type JsonBodyResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: number; readonly error: string };

export async function readJsonBody(
  request: Request,
  maxBytes = MAX_REQUEST_BYTES,
): Promise<JsonBodyResult> {
  if (
    !request.headers
      .get('Content-Type')
      ?.toLowerCase()
      .startsWith('application/json')
  ) {
    return {
      ok: false,
      status: 415,
      error: 'Content-Type must be application/json',
    };
  }

  const contentLength = request.headers.get('Content-Length');
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    return { ok: false, status: 413, error: 'Request body too large' };
  }
  if (!request.body) return { ok: false, status: 400, error: 'Invalid JSON' };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        return { ok: false, status: 413, error: 'Request body too large' };
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, status: 400, error: 'Invalid JSON' };
  } finally {
    reader.releaseLock();
  }
}

const worker = {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const isBoardRoute =
      url.pathname === '/api/board' || url.pathname.startsWith('/api/board/');
    const isLicenceRoute = url.pathname === '/api/licence/check';
    if ((isBoardRoute || isLicenceRoute) && env.CLOUD_ENABLED !== 'true') {
      return jsonResponse(request, url, { error: 'Not found' }, 404);
    }
    const isApiRoute =
      url.pathname === '/api/share' ||
      url.pathname.startsWith('/api/share/') ||
      url.pathname === '/api/report' ||
      isLicenceRoute ||
      url.pathname === '/api/board' ||
      url.pathname.startsWith('/api/board/');

    if (isApiRoute && !isAllowedOrigin(request, url)) {
      return jsonResponse(request, url, { error: 'Origin not allowed' }, 403);
    }

    if (request.method === 'OPTIONS' && isApiRoute) {
      const headers = apiHeaders(request, url);
      headers.set(
        'Access-Control-Allow-Methods',
        url.pathname.startsWith('/api/board')
          ? 'GET, POST, PUT, DELETE, OPTIONS'
          : 'GET, POST, OPTIONS',
      );
      headers.set(
        'Access-Control-Allow-Headers',
        url.pathname.startsWith('/api/board')
          ? 'Content-Type, Authorization, If-Match, If-None-Match, X-Markasso-License'
          : 'Content-Type',
      );
      return new Response(null, { status: 204, headers });
    }

    if (
      url.pathname === '/api/board' ||
      url.pathname.startsWith('/api/board/')
    ) {
      const response = await boardRequest(request, env);
      for (const [key, value] of apiHeaders(request, url))
        response.headers.set(key, value);
      response.headers.set('Access-Control-Expose-Headers', 'ETag');
      return response;
    }

    if (
      (request.method === 'GET' || request.method === 'HEAD') &&
      (url.pathname === '/download/mac' ||
        url.pathname === '/download/mac.json')
    ) {
      return macDownload(request, env);
    }

    if (request.method === 'POST' && isLicenceRoute) {
      const response = await licenseCheck(request, env);
      for (const [key, value] of apiHeaders(request, url))
        response.headers.set(key, value);
      response.headers.set('Cache-Control', 'no-store');
      return response;
    }

    if (request.method === 'POST' && url.pathname === '/api/share') {
      const clientAddress =
        request.headers.get('CF-Connecting-IP') ?? 'unknown';
      const rateLimit = await env.SHARE_RATE_LIMITER.limit({
        key: `share:${clientAddress}`,
      });
      if (!rateLimit.success) {
        const response = jsonResponse(
          request,
          url,
          { error: 'Too many requests' },
          429,
        );
        response.headers.set('Retry-After', '60');
        return response;
      }

      const body = await readJsonBody(request);
      if (!body.ok) {
        return jsonResponse(request, url, { error: body.error }, body.status);
      }
      const elements = validateElements(body.value);
      if (!elements) {
        return jsonResponse(request, url, { error: 'Invalid scene' }, 400);
      }

      const id = generateId();
      await env.SHARE_LINKS.put(id, JSON.stringify(elements), {
        expirationTtl: TTL_SECONDS,
      });
      return jsonResponse(request, url, {
        id,
        url: `${url.origin}/#s=${id}`,
        expiresAt: new Date(Date.now() + TTL_SECONDS * 1000).toISOString(),
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/report') {
      const clientAddress =
        request.headers.get('CF-Connecting-IP') ?? 'unknown';

      const burst = await env.REPORT_RATE_LIMITER.limit({
        key: `report:${clientAddress}`,
      });
      if (!burst.success) {
        const response = jsonResponse(
          request,
          url,
          { error: 'Too many requests' },
          429,
        );
        response.headers.set('Retry-After', '60');
        return response;
      }

      const quotaKey = `report-quota:${clientAddress}`;
      const quotaUsed = Number((await env.SHARE_LINKS.get(quotaKey)) ?? '0');
      if (quotaUsed >= REPORT_QUOTA_LIMIT) {
        const response = jsonResponse(
          request,
          url,
          { error: 'Too many requests' },
          429,
        );
        response.headers.set(
          'Retry-After',
          String(REPORT_QUOTA_WINDOW_SECONDS),
        );
        return response;
      }

      const body = await readJsonBody(request);
      if (!body.ok) {
        return jsonResponse(request, url, { error: body.error }, body.status);
      }
      const report = validateReport(body.value);
      if (!report) {
        return jsonResponse(request, url, { error: 'Invalid report' }, 400);
      }

      const githubResponse = await fetch(
        `https://api.github.com/repos/${env.REPORT_REPO}/issues`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
            'User-Agent': 'markasso-report-form',
          },
          body: JSON.stringify({
            title: buildIssueTitle(report),
            body: buildIssueBody(report),
            labels: ['user-report'],
          }),
        },
      );

      if (!githubResponse.ok) {
        return jsonResponse(
          request,
          url,
          { error: 'Failed to submit report' },
          502,
        );
      }

      await env.SHARE_LINKS.put(quotaKey, String(quotaUsed + 1), {
        expirationTtl: REPORT_QUOTA_WINDOW_SECONDS,
      });

      const issue = (await githubResponse.json()) as { html_url: string };
      return jsonResponse(request, url, { url: issue.html_url }, 201);
    }

    if (request.method === 'GET' && url.pathname.startsWith('/api/share/')) {
      const id = url.pathname.slice('/api/share/'.length);
      if (!new RegExp(`^[a-zA-Z0-9]{${ID_LENGTH}}$`).test(id)) {
        return jsonResponse(request, url, { error: 'Not found' }, 404);
      }

      const data = await env.SHARE_LINKS.get(id);
      if (!data) return jsonResponse(request, url, { error: 'Not found' }, 404);

      const headers = apiHeaders(request, url);
      headers.set('Content-Type', 'application/json');
      headers.set('Cache-Control', 'private, max-age=60');
      return new Response(data, { headers });
    }

    if (request.method === 'GET' && url.pathname === '/session/ws') {
      const room = url.searchParams.get('room');
      if (!room || !ROOM_ID_RE.test(room)) {
        return jsonResponse(request, url, { error: 'Invalid room' }, 400);
      }
      const id = env.SESSION_ROOMS.idFromName(room);
      // Browsers always send the app's Origin on the WebSocket handshake; any
      // other peer (the MCP server, a script) is an agent and may have to
      // authenticate (see SessionRoom.awaitAgentAuth). The header is always
      // overwritten, so a client cannot claim to be a browser through it.
      const headers = new Headers(request.headers);
      headers.set(
        PEER_KIND_HEADER,
        request.headers.get('Origin') === url.origin ? 'browser' : 'agent',
      );
      return env.SESSION_ROOMS.get(id).fetch(new Request(request, { headers }));
    }

    return env.ASSETS.fetch(request);
  },

  /**
   * Daily cleanup of inactive live sessions (cron: `0 12 * * *`). Enumerates
   * every room tracked in the KV index and asks each Durable Object to reclaim
   * itself if it has been idle with no connected peers past the threshold.
   */
  async scheduled(_controller, env, _ctx): Promise<void> {
    try {
      if (env.CLOUD_ENABLED === 'true') await purgeBoards(env);
    } catch {
      console.log('[cron] board cleanup unavailable');
    }
    const rooms: string[] = [];
    let cursor: string | null = null;
    do {
      const list: Awaited<ReturnType<typeof env.SHARE_LINKS.list>> =
        await env.SHARE_LINKS.list({
          prefix: ROOM_INDEX_PREFIX,
          cursor,
        });
      for (const key of list.keys) {
        rooms.push(key.name.slice(ROOM_INDEX_PREFIX.length));
      }
      cursor = list.list_complete ? null : list.cursor;
    } while (cursor);

    let checked = 0;
    let deleted = 0;
    for (const room of rooms) {
      if (!ROOM_ID_RE.test(room)) continue;
      try {
        const id = env.SESSION_ROOMS.idFromName(room);
        const res = await env.SESSION_ROOMS.get(id).fetch(
          new Request('https://internal/cleanup', { method: 'POST' }),
        );
        const body = (await res.json()) as { deleted: boolean };
        checked++;
        if (body.deleted) deleted++;
      } catch {
        // A room that fails to respond is left for the next run.
      }
    }
    console.log(
      `[cron] session cleanup: ${checked} checked, ${deleted} deleted`,
    );
  },
} satisfies ExportedHandler<Env>;

export default worker;
