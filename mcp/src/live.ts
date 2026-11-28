import type { Command } from '../../src/commands/commands';
import { isSessionCommand } from '../../src/engine/ephemeral';
import {
  type AgentActivity,
  type AgentRequestMsg,
  MAX_AGENT_REPLY_CHARS,
  sanitizeReplyElements,
} from '../../src/io/agent_requests_protocol';
import { isValidSessionCommand } from '../../src/io/command_validation';
import { createCommands, LiveOutbox } from '../../src/io/live_outbox';
import type { Diagram } from './diagram';
import { markassoBaseUrl } from './storage';

/**
 * Joins a Markasso live room as a peer, speaking the same WebSocket protocol
 * as the app (src/io/realtime.ts): the room's command log is replayed into
 * the diagram's History, remote commands are applied as they arrive, and
 * every local command is forwarded. People in the room see the agent in the
 * participant list and its cursor moving to where it works.
 */

export interface PeerInfo {
  readonly id: string;
  readonly name: string;
  readonly color: string;
}

type ServerMsg =
  | { type: 'init'; self: string; commands: Command[]; peers: PeerInfo[] }
  | { type: 'apply'; command: Command; from: string }
  | { type: 'presence'; peers: PeerInfo[] }
  | { type: 'cursor' }
  | { type: 'error'; error: string }
  /** The room refused one of the agent's edits. */
  | { type: 'rejected'; reason: unknown }
  | AgentRequestMsg;

/** The room state a socket gets once it is admitted. */
type InitMsg = Extract<ServerMsg, { type: 'init' }>;

/** A request a person in the room sent to this agent. */
export interface LiveRequest {
  readonly id: string;
  readonly fromName: string;
  readonly text: string;
}

/** Undelivered requests kept; older ones are dropped beyond this. */
const MAX_INBOX = 20;
/** Delivered request ids the agent may still answer with `reply`. */
const MAX_ANSWERABLE = 100;
/**
 * How long the agent must stay idle before the room hears it: a model that
 * calls live_wait_request again right after a timeout never shows as idle.
 */
const IDLE_GRACE_MS = 5000;
/** Elements remembered per request; well above what a reply carries. */
const MAX_TRACKED_ELEMENTS = 500;

const ROOM_ID = /^[a-zA-Z0-9_-]{3,64}$/;
const AGENT_COLOR = '#c77dff';
const JOIN_TIMEOUT_MS = 10_000;
/** Close code the room uses for an agent without a valid licence. */
const CLOSE_LICENCE_REQUIRED = 4402;
/** Close code the room uses when it has no place for another peer. */
const CLOSE_ROOM_FULL = 1013;
/** Close code (with reason "replaced") for a socket a newer one replaced. */
const CLOSE_REPLACED = 1000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10_000;
/**
 * How long the link keeps trying to get back into the room after a drop,
 * join timeouts included: the attempts never outlast this window.
 */
const RECONNECT_WINDOW_MS = 45_000;
const LICENCE_MESSAGE =
  "Drawing live with an AI agent needs a Markasso Cloud licence. Get one at https://markasso.it/cloud, then set MARKASSO_LICENSE in this MCP server's environment.";

export class LiveError extends Error {
  override name = 'LiveError';
}

/**
 * Where the link stands with the room: joining for the first time, in it,
 * trying to get back in after a drop, given up (the room refused it or the
 * reconnect window ran out), or left on purpose.
 */
export type LiveState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'lost'
  | 'left';

/** How a socket ended, as the room or the network reported it. */
export interface LiveClose {
  /** WebSocket close code, or null when the attempt failed before one. */
  readonly code: number | null;
  readonly reason: string;
}

/** A close the room means as final: retrying would only repeat it. */
function isFinalClose(close: LiveClose): boolean {
  return (
    close.code === CLOSE_LICENCE_REQUIRED ||
    close.code === CLOSE_ROOM_FULL ||
    (close.code === CLOSE_REPLACED && close.reason === 'replaced')
  );
}

/** " (code 1006: reason)" for a status line, empty when nothing is known. */
export function describeClose(close: LiveClose | null): string {
  if (!close) return '';
  const parts = [
    close.code !== null ? `code ${close.code}` : '',
    close.reason,
  ].filter(Boolean);
  return parts.length > 0 ? ` (${parts.join(': ')})` : '';
}

/** One connection attempt that did not get into the room. */
class AttemptFailed extends LiveError {
  constructor(
    message: string,
    readonly close: LiveClose,
    readonly final: boolean,
  ) {
    super(message);
  }
}

/**
 * Whether a live link points at the Markasso instance this server is set up
 * for (`MARKASSO_URL`, default markasso.it). The licence key is a paid
 * credential and the link is untrusted input (it can come from a document, a
 * label or a live request), so the key is only ever sent to that instance.
 */
function isConfiguredInstance(origin: string): boolean {
  try {
    return new URL(origin).origin === new URL(markassoBaseUrl()).origin;
  } catch {
    return false;
  }
}

function licenceMessage(origin: string): string {
  if (process.env.MARKASSO_LICENSE?.trim() && !isConfiguredInstance(origin)) {
    return `This room needs a Markasso Cloud licence, and the key in MARKASSO_LICENSE was not sent because the link points to ${origin}, not to ${markassoBaseUrl()}. If that is your own Markasso instance, set MARKASSO_URL to it in this MCP server's environment.`;
  }
  return LICENCE_MESSAGE;
}

/** Room id and app origin from a live link (`...?live=<room>`) or a bare id. */
export function parseLiveLink(link: string): { room: string; origin: string } {
  const trimmed = link.trim();
  if (ROOM_ID.test(trimmed))
    return { room: trimmed, origin: markassoBaseUrl() };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new LiveError(
      'Expected a Markasso live link (…?live=<room>) or a room id.',
    );
  }
  const room = url.searchParams.get('live');
  if (!room || !ROOM_ID.test(room)) {
    throw new LiveError('The link has no valid "live" room parameter.');
  }
  return { room, origin: url.origin };
}

function randomClientId(): string {
  const alphabet =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export interface JoinResult {
  readonly link: LiveLink;
  /** True when the room was empty and the agent published its diagram. */
  readonly seeded: boolean;
  /** Elements the agent had locally and dropped to adopt the room. */
  readonly discarded: number;
}

/** What each refusal reason of the room means, for the model. */
const REJECTION_TEXT: Record<string, string> = {
  too_large:
    'one edit was too large for a single message, usually a large image',
  rate: 'too many edits in a short time',
  full: 'the room reached its size limit',
  invalid: 'an edit could not be applied',
};

export class LiveLink {
  readonly room: string;
  readonly url: string;
  private socket: WebSocket | null = null;
  private peers: PeerInfo[] = [];
  private selfId = '';
  /**
   * One identity for the whole session, reused on every reconnect: the room
   * then replaces the stale socket instead of seeing a second peer, and
   * still accepts replies to requests it routed to this agent before a drop.
   */
  private readonly clientId = randomClientId();
  private _state: LiveState = 'connecting';
  /** How the last socket or attempt ended (see describeClose). */
  private _lastClose: LiveClose | null = null;
  /**
   * Bumped for each socket and on leave: events of an older socket arriving
   * late are ignored, so they never act on the current connection.
   */
  private attemptId = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private reconnectDeadline = 0;
  /** The close that started the current reconnect, for its notice. */
  private dropClose: LiveClose | null = null;
  /** One-shot notes for the model's next tool answer (see takeNotices). */
  private notices: string[] = [];
  private inbox: LiveRequest[] = [];
  /**
   * Delivered request ids the agent may answer, each with the elements the
   * agent changed for it (sent with the reply), or null once that cannot be
   * told: edits made while several requests waited for an answer could be
   * for any of them, so none of them claims those edits.
   */
  private readonly answerable = new Map<string, Set<string> | null>();
  /** Delivered requests still waiting for their first reply. */
  private readonly unanswered = new Set<string>();
  /** live_wait_request calls currently waiting. */
  private waiting = 0;
  /** The activity the room last heard from this agent. */
  private activitySent: AgentActivity | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private stopTracking: (() => void) | null = null;
  /** Pending `waitForRequests` calls, woken by a request or a disconnect. */
  private readonly waiters = new Set<() => void>();
  /** Set while replaying a remote undo/redo, which History re-emits. */

  private constructor(
    private readonly diagram: Diagram,
    room: string,
    private readonly origin: string,
    private readonly name: string,
  ) {
    this.room = room;
    this.url = `${origin}/?live=${encodeURIComponent(room)}`;
  }

  /** Only a link in the room sends edits, activity and answers. */
  private get open(): boolean {
    return this._state === 'connected';
  }

  get state(): LiveState {
    return this._state;
  }

  get lastClose(): LiveClose | null {
    return this._lastClose;
  }

  /** Notes about the connection since the last call, each reported once. */
  takeNotices(): string[] {
    const taken = this.notices;
    this.notices = [];
    return taken;
  }

  /** Throws a LiveError that says why the room cannot be reached now. */
  assertConnected(): void {
    if (this._state === 'reconnecting')
      throw new LiveError(
        'The live session is reconnecting: try again in a few seconds.',
      );
    if (!this.open)
      throw new LiveError(
        'Not connected to the live room: call live_join again.',
      );
  }

  /**
   * Attributes the agent's own edits to the request it is working on, when
   * only one waits for an answer (see `answerable`). Deleted elements leave
   * every request, so they never fill the bound.
   */
  private noteEdited(
    changed: ReadonlySet<string>,
    removed: ReadonlySet<string>,
  ): void {
    for (const requestId of this.answerable.keys()) {
      const touched = this.answerable.get(requestId);
      for (const id of removed) touched?.delete(id);
    }
    if (changed.size === 0) return;
    if (this.unanswered.size > 1) {
      for (const requestId of this.unanswered)
        this.answerable.set(requestId, null);
      return;
    }
    for (const requestId of this.unanswered) {
      const touched = this.answerable.get(requestId);
      if (!touched) continue;
      for (const id of changed) {
        // Bounded: a reply carries at most MAX_REPLY_ELEMENTS anyway.
        if (touched.size >= MAX_TRACKED_ELEMENTS) break;
        touched.add(id);
      }
    }
  }

  /**
   * What the agent is doing for the people in the room: waiting for
   * requests, busy with delivered ones still unanswered, or neither.
   */
  private currentActivity(): AgentActivity {
    if (this.waiting > 0) return 'listening';
    if (this.unanswered.size > 0) return 'working';
    return 'idle';
  }

  /**
   * Tells the room when the activity changes. Going idle waits
   * IDLE_GRACE_MS, and is dropped if the agent is busy again by then.
   */
  private updateActivity(): void {
    if (!this.open) return;
    const next = this.currentActivity();
    if (next === 'idle' && this.activitySent !== 'idle') {
      if (this.idleTimer) return;
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        if (this.currentActivity() === 'idle') this.sendActivity('idle');
      }, IDLE_GRACE_MS);
      // Never keeps the process alive on its own.
      this.idleTimer.unref?.();
      return;
    }
    this.clearIdleTimer();
    if (next !== this.activitySent) this.sendActivity(next);
  }

  private sendActivity(activity: AgentActivity): void {
    this.activitySent = activity;
    this.send({
      type: 'presence',
      name: this.name,
      color: AGENT_COLOR,
      activity,
    });
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Stops attributing edits (the session is over). */
  private untrack(): void {
    this.stopTracking?.();
    this.stopTracking = null;
  }

  static async join(
    diagram: Diagram,
    link: string,
    name: string,
  ): Promise<JoinResult> {
    const { room, origin } = parseLiveLink(link);
    const live = new LiveLink(diagram, room, origin, name);
    // The first join is not retried: its failure goes back to the caller.
    const result = await live.openSocket((msg) => live.enterRoom(msg, true));
    return { link: live, ...result };
  }

  get connected(): boolean {
    return this.open;
  }

  /** Other people currently in the room. */
  get otherPeers(): ReadonlyArray<PeerInfo> {
    return this.peers.filter((p) => p.id !== this.selfId);
  }

  /** Edits handed to the room so far, sent or waiting (see guarded in server.ts). */
  editCount = 0;

  /** Reasons the room gave for refusing edits since the last answer. */
  private rejections: string[] = [];

  /**
   * Why the room refused some of the agent's edits since the last call, as
   * a note for the model: the board it sees here then differs from the
   * room's. Empty when nothing was refused.
   */
  takeRejections(): string {
    if (this.rejections.length === 0) return '';
    const reasons = this.rejections.map(
      (reason) => REJECTION_TEXT[reason] ?? reason,
    );
    this.rejections = [];
    return `The live room refused some of your edits (${reasons.join('; ')}): the other people do not see them.`;
  }

  /**
   * Resolves once the edits held back by the room's quota are sent (at
   * most `timeoutMs`), then after `graceMs` more, so a refusal of the last
   * ones has time to arrive.
   */
  async settle(timeoutMs: number, graceMs: number): Promise<void> {
    await this.outbox.idle(timeoutMs);
    await new Promise((resolve) => setTimeout(resolve, graceMs));
  }

  /**
   * Requests received and ready to hand to the model. None while out of the
   * room: they stay queued until it is back, since telling their senders
   * they were received needs the room.
   */
  get pendingRequests(): number {
    return this.open ? this.inbox.length : 0;
  }

  /**
   * Hands every queued request to the caller (the model) and tells each
   * sender it was received. They can then be answered with `reply`. Hands
   * nothing while out of the room (see pendingRequests).
   */
  takeRequests(): LiveRequest[] {
    if (!this.open) return [];
    const taken = this.inbox;
    this.inbox = [];
    for (const request of taken) {
      this.answerable.set(request.id, new Set());
      this.unanswered.add(request.id);
    }
    while (this.answerable.size > MAX_ANSWERABLE) {
      const oldest = this.answerable.keys().next().value;
      if (oldest === undefined) break;
      this.answerable.delete(oldest);
      this.unanswered.delete(oldest);
    }
    // "Working" first, so a sender never sees its request received by an
    // agent the room still shows as listening.
    this.updateActivity();
    for (const request of taken)
      this.send({ type: 'agent_status', id: request.id, status: 'received' });
    return taken;
  }

  /**
   * Resolves with the queued requests as soon as there is one, or with none
   * after `timeoutMs`, or once the session is lost or left. A drop the link
   * recovers from does not end the wait: it keeps the same deadline.
   */
  async waitForRequests(timeoutMs: number): Promise<LiveRequest[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.recoverable && this.pendingRequests === 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await this.waitForWake(remaining);
      // Woken in the room: by a request (another waiting call may take
      // it) or the timeout. Only a wake while out of the room waits on.
      if (this.open) break;
    }
    // Updates the activity: working with what it got, else idle (late).
    return this.takeRequests();
  }

  /** In the room, or on its way back. */
  private get recoverable(): boolean {
    return this._state === 'connected' || this._state === 'reconnecting';
  }

  /** Waits for a request, a change of connection, or `timeoutMs`. */
  private waitForWake(timeoutMs: number): Promise<void> {
    this.waiting++;
    this.updateActivity();
    return new Promise<void>((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        // Here, not after the await: a request wakes every waiting call
        // at once, and none may take it while the others still count as
        // listening (the room would hear `received` before `working`).
        this.waiting--;
        resolve();
      };
      const timer = setTimeout(wake, timeoutMs);
      this.waiters.add(wake);
    });
  }

  /**
   * Sends an answer to the person behind a delivered request, pointing at
   * `elements` when given, else at the elements the agent changed for it.
   * Returns how many elements the reply points at, and whether the changes
   * could not be told apart from another request's (`ambiguous`).
   */
  reply(
    id: string,
    text: string,
    elements?: ReadonlyArray<string>,
  ): { pointed: number; ambiguous: boolean } {
    this.assertConnected();
    if (!this.answerable.has(id))
      throw new LiveError(`Unknown request id "${id}".`);
    const touched = this.answerable.get(id) ?? null;
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > MAX_AGENT_REPLY_CHARS)
      throw new LiveError(
        `A reply needs 1 to ${MAX_AGENT_REPLY_CHARS} characters.`,
      );
    // Deleted since: nothing to show for them.
    const present = new Set(this.diagram.elements.map((el) => el.id));
    const ids = sanitizeReplyElements(
      [...(elements ?? touched ?? [])].filter((elementId) =>
        present.has(elementId),
      ),
    );
    this.unanswered.delete(id);
    this.updateActivity();
    this.send({
      type: 'agent_status',
      id,
      status: 'replied',
      text: trimmed,
      ...(ids.length > 0 ? { elements: ids } : {}),
    });
    return { pointed: ids.length, ambiguous: !elements && touched === null };
  }

  private wakeWaiters(): void {
    for (const wake of [...this.waiters]) wake();
  }

  private receiveRequest(msg: AgentRequestMsg): void {
    if (
      typeof msg.id !== 'string' ||
      typeof msg.text !== 'string' ||
      typeof msg.fromName !== 'string'
    )
      return;
    this.inbox.push({ id: msg.id, fromName: msg.fromName, text: msg.text });
    if (this.inbox.length > MAX_INBOX) this.inbox.shift();
    this.wakeWaiters();
  }

  /** Scene commands, paced to the room's quota (see LiveOutbox). */
  private readonly outbox = new LiveOutbox({
    send: (command) => this.send({ type: 'command', command }),
  });

  /** Queues a scene command for the room, counting it (see editCount). */
  private publish(command: Command): void {
    this.editCount++;
    this.outbox.push(command);
  }

  private send(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  /**
   * Opens one socket to the room and resolves with what `onInit` returns,
   * run as soon as the room's `init` arrives (in the same event, so no
   * remote command can slip in before it). Rejects with an AttemptFailed
   * when the attempt ends before that. Every listener belongs to this
   * attempt only: once another socket is opened or the link is left, this
   * socket's events are ignored.
   */
  private openSocket<T>(
    onInit: (msg: InitMsg) => T,
    timeoutMs = JOIN_TIMEOUT_MS,
  ): Promise<T> {
    const attempt = ++this.attemptId;
    const current = (): boolean => attempt === this.attemptId;
    const origin = this.origin;
    const wsOrigin = origin.replace(/^http/, 'ws');
    const url = `${wsOrigin}/session/ws?room=${encodeURIComponent(this.room)}&clientId=${this.clientId}`;

    return new Promise<T>((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch (error) {
        reject(
          new AttemptFailed(
            'Could not connect to the live room.',
            {
              code: null,
              reason: error instanceof Error ? error.message : String(error),
            },
            false,
          ),
        );
        return;
      }
      this.socket = socket;
      /** In the room: `init` arrived. */
      let admitted = false;
      /** The promise is settled, one way or the other. */
      let settled = false;
      const fail = (error: AttemptFailed): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
        try {
          socket.close();
        } catch {
          /* already closing */
        }
      };
      const timer = setTimeout(
        () =>
          fail(
            new AttemptFailed(
              'Timed out joining the live room.',
              { code: null, reason: 'join timed out' },
              false,
            ),
          ),
        timeoutMs,
      );

      socket.addEventListener('open', () => {
        if (!current()) return;
        // Must be the first message: rooms that require a licence for agents
        // admit the peer only after checking it, and ignore it otherwise.
        // The room forgets it on disconnect, so every socket sends it.
        const license = process.env.MARKASSO_LICENSE?.trim();
        if (license && isConfiguredInstance(origin))
          this.send({ type: 'auth', license });
        this.send({ type: 'presence', name: this.name, color: AGENT_COLOR });
      });

      socket.addEventListener('message', (event) => {
        if (!current()) return;
        let msg: ServerMsg;
        try {
          msg = JSON.parse(String(event.data)) as ServerMsg;
        } catch {
          return;
        }
        if (msg.type === 'init') {
          if (settled) return;
          admitted = true;
          settled = true;
          clearTimeout(timer);
          resolve(onInit(msg));
        } else if (msg.type === 'apply') {
          // Before `init` the room's log already holds it.
          if (!admitted) return;
          // Bare UNDO/REDO from an outdated client: see isSessionCommand.
          if (
            isSessionCommand(msg.command) &&
            isValidSessionCommand(msg.command)
          ) {
            // An exception in a socket listener would end the process.
            try {
              this.diagram.history.applyRemote(msg.command);
            } catch (error) {
              console.error(
                'Skipped a live command that failed to apply',
                error,
              );
            }
          }
        } else if (msg.type === 'presence') {
          this.peers = msg.peers;
        } else if (msg.type === 'request') {
          // Kept even before `init`: the room registers a socket, and may
          // route requests to it, before it sends the room state.
          this.receiveRequest(msg);
        } else if (msg.type === 'rejected' && typeof msg.reason === 'string') {
          // Reported with the next tool answer (see takeRejections).
          if (!this.rejections.includes(msg.reason))
            this.rejections.push(msg.reason);
        } else if (msg.type === 'error' && !admitted) {
          const final =
            msg.error === 'licence required' || msg.error === 'room full';
          fail(
            new AttemptFailed(
              msg.error === 'licence required'
                ? licenceMessage(origin)
                : `The live room refused to join: ${msg.error}.`,
              { code: null, reason: msg.error },
              final,
            ),
          );
        }
      });

      socket.addEventListener('close', (event) => {
        if (!current()) return;
        const close: LiveClose = {
          code: typeof event.code === 'number' ? event.code : null,
          reason: typeof event.reason === 'string' ? event.reason : '',
        };
        if (!admitted) {
          fail(
            new AttemptFailed(
              close.code === CLOSE_LICENCE_REQUIRED
                ? licenceMessage(origin)
                : 'The live room closed the connection.',
              close,
              isFinalClose(close),
            ),
          );
          return;
        }
        this.dropped(close);
      });
      socket.addEventListener('error', () => {
        if (!current() || admitted) return;
        fail(
          new AttemptFailed(
            'Could not connect to the live room.',
            { code: null, reason: 'socket error' },
            false,
          ),
        );
      });
    });
  }

  /**
   * Takes the room's state on `init`. On the first join the room's log
   * replaces the local diagram, or the local diagram seeds an empty room;
   * on a reconnect the room is authoritative even when empty, and nothing
   * is published, so stale content never comes back.
   */
  private enterRoom(
    msg: InitMsg,
    first: boolean,
  ): { seeded: boolean; discarded: number } {
    const history = this.diagram.history;
    this.selfId = msg.self;
    this.peers = msg.peers;
    const local = [...this.diagram.elements];
    let seeded = false;
    let discarded = 0;
    if (msg.commands.length > 0 || !first) {
      if (first) discarded = local.length;
      history.resetForLiveReplay(msg.commands.filter(isValidSessionCommand));
    } else if (local.length > 0) {
      // Empty room: publish what the agent already drew, in pieces the
      // room accepts.
      for (const command of createCommands(local, { validOnly: true }))
        this.publish(command);
      seeded = true;
    }
    if (first) {
      // Installed once for the whole session: both check `open`, so edits
      // made while out of the room are neither sent nor attributed to a
      // request (an offline deletion would drop a valid reference).
      history.setOnCommand((command) => {
        if (this.open && isSessionCommand(command)) this.publish(command);
      });
      this.untrack();
      this.stopTracking = this.diagram.onLocalChange((changed, removed) => {
        if (this.open) this.noteEdited(changed, removed);
      });
    }
    this._state = 'connected';
    this.reconnectAttempt = 0;
    // A new socket starts with no activity in the room: say it again.
    this.clearIdleTimer();
    this.sendActivity(this.currentActivity());
    // Requests that arrived while out of the room can be delivered now.
    if (this.inbox.length > 0) this.wakeWaiters();
    return { seeded, discarded };
  }

  /** The socket of a joined session closed: retry unless it is final. */
  private dropped(close: LiveClose): void {
    this._lastClose = close;
    this.dropClose = close;
    // Not sent: the room's log replaces the diagram when the link is back.
    this.outbox.clear();
    this.clearIdleTimer();
    if (isFinalClose(close)) {
      this.lose();
      return;
    }
    this._state = 'reconnecting';
    this.reconnectAttempt = 0;
    this.reconnectDeadline = Date.now() + RECONNECT_WINDOW_MS;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempt++;
    if (Date.now() + delay >= this.reconnectDeadline) {
      this.lose();
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, delay);
  }

  private async reconnect(): Promise<void> {
    if (this._state !== 'reconnecting') return;
    const remaining = this.reconnectDeadline - Date.now();
    try {
      await this.openSocket(
        (msg) => {
          // Written with the state change, so no answer can miss it.
          this.notices.push(
            `The live session dropped${describeClose(this.dropClose)} and reconnected. The board was reloaded from the room, so your most recent edits may be missing: call diagram_read before editing further.`,
          );
          return this.enterRoom(msg, false);
        },
        Math.min(JOIN_TIMEOUT_MS, remaining),
      );
    } catch (error) {
      // Left while the attempt ran: nothing more to do.
      if (this._state !== 'reconnecting') return;
      if (error instanceof AttemptFailed) {
        this._lastClose = error.close;
        if (error.final) {
          this.lose();
          return;
        }
      } else {
        console.error('Unexpected error while reconnecting', error);
      }
      this.scheduleReconnect();
    }
  }

  /** Gives up on the room: waiting calls return, nothing is sent anymore. */
  private lose(): void {
    this._state = 'lost';
    this.cancelReconnect();
    this.untrack();
    this.clearIdleTimer();
    this.wakeWaiters();
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /** Moves the agent's cursor so people see where it is working. */
  pointAt(x: number, y: number): void {
    if (!this.open) return;
    this.send({ type: 'cursor', x, y, name: this.name, color: AGENT_COLOR });
  }

  leave(): void {
    // Edits already applied here still reach the peers before the close.
    if (this.open) this.outbox.drain();
    this._state = 'left';
    // Late events of any socket of this link are ignored from now on.
    this.attemptId++;
    this.cancelReconnect();
    this.wakeWaiters();
    this.untrack();
    this.clearIdleTimer();
    // The History hook is left in place: it checks `open`, and clearing it
    // here could detach the hook of a link that joined after this one.
    this.socket?.close();
    this.socket = null;
  }

  /**
   * Leaves once every edit held back by the room's quota is sent, then
   * waits for the socket to close (at most `timeoutMs`), so the last edits
   * leave the process before it exits. A lost connection clears the queue,
   * which ends the wait; the 60 s cap (twelve quota windows, about 1,800
   * unmerged commands) only bounds a pathological burst.
   */
  async leaveAndWait(timeoutMs = 1000): Promise<void> {
    await this.outbox.idle(60_000);
    const socket = this.socket;
    // Listening before the close starts, which may report it right away.
    const closed =
      socket && socket.readyState !== 3 // WebSocket.CLOSED
        ? new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, timeoutMs);
            socket.addEventListener('close', () => {
              clearTimeout(timer);
              resolve();
            });
          })
        : Promise.resolve();
    this.leave();
    await closed;
  }
}
