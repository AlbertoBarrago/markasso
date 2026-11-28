import { fitToBox } from '../core/viewport';
import type { History } from '../engine/history';
import { getLocale, t } from '../i18n';
import {
  type AgentRequestEntry,
  agentRequests,
  agentThreads,
  canSendAgentRequests,
  markAgentThreadRead,
  onAgentReply,
  sendAgentRequest,
  subscribeAgentRequests,
  unreadAgentReplies,
} from '../io/agent_requests';
import {
  type AgentActivity,
  MAX_AGENT_REQUEST_CHARS,
} from '../io/agent_requests_protocol';
import { onLivePeers, type PeerInfo } from '../io/realtime';
import { getRotatedBounds } from '../rendering/draw_selection';
import { renderChatMarkdown } from './markdown';
import { claimRightSidebar, releaseRightSidebar } from './right_sidebar';

/**
 * Agent chat sidebar: the conversation of this tab with each AI agent of a
 * live room. Requests are private to the sender (see
 * io/agent_requests_protocol.ts), so this is a one-to-one chat per agent,
 * not a room chat. It shares the right edge with the library (one open at a
 * time, see right_sidebar.ts).
 *
 * The header and the message list are rebuilt only when what they show
 * changed, so a presence update never drops a text selection in a reply or
 * the focus on a link; the composer is built once and only updated, so
 * typing, focus and caret survive every update. Drafts are kept per agent.
 *
 * Keys pressed inside the panel never reach the board's shortcuts or tools:
 * Delete on a focused tab must not delete the selected shapes.
 */

const STATUS_KEYS: Record<AgentRequestEntry['status'], string> = {
  sending: 'agentRequestSending',
  sent: 'agentRequestSent',
  received: 'agentRequestReceived',
  replied: 'agentRequestReplied',
  rejected: 'agentRequestInvalid',
  interrupted: 'agentRequestInterrupted',
};

const REJECTION_KEYS: Record<
  NonNullable<AgentRequestEntry['reason']>,
  string
> = {
  unauthorized: 'agentRequestUnauthorized',
  unavailable: 'agentRequestUnavailable',
  rate_limited: 'agentRequestRateLimited',
  invalid: 'agentRequestInvalid',
};

const ACTIVITY_KEYS: Record<AgentActivity, string> = {
  listening: 'agentListening',
  working: 'agentWorking',
  idle: 'agentIdle',
};

/** "Listening", "Working" or "Not listening"; null when the agent says nothing. */
export function agentActivityLabel(
  activity: AgentActivity | null,
): string | null {
  return activity ? t(ACTIVITY_KEYS[activity]) : null;
}

/**
 * The status under a request. One the agent has not picked up yet says why
 * when the agent tells what it is doing: busy with others, or not listening
 * (requests also reach it with its next action, so it is not lost).
 */
function statusLabel(
  entry: AgentRequestEntry,
  activity: AgentActivity | null,
): string {
  if (entry.status === 'rejected' && entry.reason)
    return t(REJECTION_KEYS[entry.reason]);
  if (entry.status === 'sent' && activity === 'working')
    return t('agentRequestQueued');
  if (entry.status === 'sent' && activity === 'idle')
    return t('agentRequestNotListening');
  return t(STATUS_KEYS[entry.status]);
}

/** A chat partner: a connected agent, or one this tab asked that has left. */
interface ChatAgent {
  readonly id: string;
  readonly name: string;
  readonly color: string | null;
  readonly online: boolean;
  /** From the agent's presence; null when it left or never says. */
  readonly activity: AgentActivity | null;
}

/** How close to the bottom (px) still counts as "following" the thread. */
const FOLLOW_THRESHOLD = 48;

let openImpl: ((agentId?: string) => void) | null = null;
let toggleImpl: (() => void) | null = null;

/** Opens the chat, on `agentId` when given (else the last or first agent). */
export function openAgentChat(agentId?: string): void {
  openImpl?.(agentId);
}

/** Opens or closes the chat. */
export function toggleAgentChat(): void {
  toggleImpl?.();
}

/** Canvas width (px) below which the sidebar closes to show elements. */
const MIN_FIT_WIDTH = 320;

/** The box around `boxes` (at least one). */
function unionOf(
  boxes: ReadonlyArray<{ x: number; y: number; w: number; h: number }>,
): { x: number; y: number; w: number; h: number } {
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.w));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** How long a reply toast stays on screen. */
const TOAST_MS = 6000;

/** "9+" past nine: the badge is a hint, not a counter to read. */
function badgeText(count: number): string {
  return count > 9 ? '9+' : String(count);
}

/**
 * Shows `button` only while there is someone to chat with (a connected agent
 * or an earlier thread), with a badge of the unread replies, and makes it
 * toggle the chat.
 */
export function bindAgentChatTrigger(button: HTMLElement): void {
  let agentsOnline = false;
  const badge = document.createElement('span');
  badge.className = 'tb-badge';
  badge.setAttribute('aria-hidden', 'true');
  button.appendChild(badge);
  const update = (): void => {
    button.hidden = !agentsOnline && agentThreads().length === 0;
    const unread = unreadAgentReplies();
    badge.hidden = unread === 0;
    badge.textContent = badgeText(unread);
    const label =
      unread === 0
        ? t('agentChat')
        : `${t('agentChat')}, ${t('agentChatUnread').replace('{{count}}', String(unread))}`;
    button.title = label;
    button.setAttribute('aria-label', label);
  };
  onLivePeers((others) => {
    agentsOnline = others.some((p) => p.kind === 'agent');
    update();
  });
  subscribeAgentRequests(update);
  // The click goes on to the document, which closes the People popover.
  button.addEventListener('click', () => toggleAgentChat());
  update();
}

export function initAgentChatPanel(
  workspace: HTMLElement,
  history: History,
): void {
  const panel = document.createElement('aside');
  panel.id = 'agent-chat-panel';
  panel.className = 'ui-island';
  panel.setAttribute('aria-label', t('agentChat'));
  // Hidden by opacity for the transition: inert keeps it out of the tab order.
  panel.inert = true;

  const header = document.createElement('div');
  header.className = 'ac-header';
  const agentsBar = document.createElement('div');
  agentsBar.className = 'ac-agents';
  agentsBar.setAttribute('role', 'tablist');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'lib-close ac-close';
  close.title = t('close');
  close.setAttribute('aria-label', t('close'));
  close.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/></svg>';
  header.append(agentsBar, close);

  const body = document.createElement('div');
  body.className = 'ac-body';
  body.setAttribute('role', 'log');
  body.setAttribute('aria-live', 'polite');

  // Composer: built once, see the module comment.
  const footer = document.createElement('div');
  footer.className = 'ac-footer';
  const notice = document.createElement('p');
  notice.className = 'ac-notice';
  const compose = document.createElement('div');
  compose.className = 'ac-compose';
  const input = document.createElement('textarea');
  input.className = 'ui-field ac-input';
  input.rows = 2;
  input.maxLength = MAX_AGENT_REQUEST_CHARS;
  const composeFooter = document.createElement('div');
  composeFooter.className = 'ac-compose-footer';
  const hint = document.createElement('span');
  hint.className = 'ac-hint';
  hint.textContent = t('agentAskHint');
  const sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.className = 'ui-button ac-send';
  sendBtn.textContent = t('agentSend');
  composeFooter.append(hint, sendBtn);
  compose.append(input, composeFooter);
  footer.append(notice, compose);

  panel.append(header, body, footer);
  workspace.appendChild(panel);

  let open = false;
  let selected: string | null = null;
  let livePeers: PeerInfo[] = [];
  const drafts = new Map<string, string>();
  /** Names of agents seen in the room, for one that leaves mid-draft. */
  const knownNames = new Map<string, string>();
  /** Message count last rendered per agent, to follow new messages. */
  let renderedCount = -1;
  let renderedFor: string | null = null;
  /** What the header and the list last showed: unchanged means no rebuild. */
  let agentsShown = '';
  let messagesShown = '';
  /** Focus to give back on close, when the panel took it on open. */
  let returnFocus: HTMLElement | null = null;

  const timeFormat = (): Intl.DateTimeFormat =>
    new Intl.DateTimeFormat(getLocale(), {
      hour: '2-digit',
      minute: '2-digit',
    });

  /** Connected agents first, then agents asked earlier that have left. */
  function chatAgents(): ChatAgent[] {
    const agents: ChatAgent[] = livePeers
      .filter((p) => p.kind === 'agent')
      .map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        online: true,
        activity: p.activity ?? null,
      }));
    for (const thread of agentThreads()) {
      if (agents.some((a) => a.id === thread.agentId)) continue;
      agents.push({
        id: thread.agentId,
        name: thread.name,
        color: null,
        online: false,
        activity: null,
      });
    }
    // An agent that left while being written to stays, offline, until the
    // draft is sent elsewhere or cleared: otherwise the focused composer would
    // silently switch to another agent mid-sentence.
    // Once the session ended (no peers, threads forgotten) nothing stays.
    const inSession = livePeers.length > 0 || agentThreads().length > 0;
    const name = selected ? knownNames.get(selected) : undefined;
    if (
      inSession &&
      selected &&
      name !== undefined &&
      input.value.trim() &&
      !agents.some((a) => a.id === selected)
    )
      agents.push({
        id: selected,
        name,
        color: null,
        online: false,
        activity: null,
      });
    return agents;
  }

  function current(agents: ChatAgent[]): ChatAgent | null {
    return agents.find((a) => a.id === selected) ?? agents[0] ?? null;
  }

  function select(agentId: string): void {
    if (selected === agentId) return;
    if (selected) drafts.set(selected, input.value);
    selected = agentId;
    input.value = drafts.get(agentId) ?? '';
    render();
  }

  function renderAgents(agents: ChatAgent[], active: ChatAgent | null): void {
    const unread = new Map(agentThreads().map((t) => [t.agentId, t.unread]));
    const shown = JSON.stringify([agents, active?.id, [...unread]]);
    if (shown === agentsShown) return;
    agentsShown = shown;
    // The tabs are about to be replaced: keep the keyboard on the tab that
    // had it (the one just clicked, or one reached with Tab).
    const focused = document.activeElement;
    const focusedId =
      focused instanceof HTMLElement && agentsBar.contains(focused)
        ? (focused.dataset.agentId ?? null)
        : null;
    agentsBar.innerHTML = '';
    for (const agent of agents) {
      // A single agent is a title, not a choice.
      const single = agents.length === 1;
      const item = document.createElement(single ? 'div' : 'button');
      if (item instanceof HTMLButtonElement) {
        item.type = 'button';
        item.className = 'ui-button ac-agent';
        item.dataset.agentId = agent.id;
        item.setAttribute('role', 'tab');
        item.setAttribute('aria-selected', String(agent.id === active?.id));
        item.addEventListener('click', () => select(agent.id));
      } else item.className = 'ac-agent-title';
      const dot = document.createElement('span');
      dot.className = 'pp-dot';
      if (agent.color) dot.style.background = agent.color;
      else dot.classList.add('ac-dot-offline');
      const name = document.createElement('span');
      name.className = 'ac-agent-name';
      name.textContent = agent.name;
      item.append(dot, name);
      const activity = agentActivityLabel(agent.activity);
      if (activity) {
        const label = document.createElement('span');
        label.className = 'ac-activity';
        label.dataset.activity = agent.activity ?? '';
        label.textContent = activity;
        item.appendChild(label);
      }
      // The thread on screen is read as it updates; other tabs show a count.
      const count = agent.id === active?.id ? 0 : (unread.get(agent.id) ?? 0);
      if (count > 0) {
        const badge = document.createElement('span');
        badge.className = 'tb-badge ac-tab-badge';
        badge.textContent = badgeText(count);
        item.appendChild(badge);
      }
      agentsBar.appendChild(item);
    }
    if (focusedId !== null)
      [...agentsBar.querySelectorAll<HTMLElement>('.ac-agent')]
        .find((tab) => tab.dataset.agentId === focusedId)
        ?.focus();
  }

  /**
   * "Show on canvas (N)": selects the elements a reply points at and fits
   * the view to what is drawn for them (connectors resolved from their
   * shapes, rotation included), clear of the sidebar. On a screen too narrow
   * to show both, the sidebar closes first. Elements deleted since are
   * skipped; with none left the button says so and stays clickable, since a
   * peer may bring them back.
   */
  function showOnCanvasButton(ids: readonly string[]): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ui-button ac-show';
    button.textContent = t('agentReplyShow').replace(
      '{{count}}',
      String(ids.length),
    );
    button.addEventListener('click', () => {
      const all = history.present.elements;
      const wanted = new Set(ids);
      const elements = all.filter((el) => wanted.has(el.id));
      const gone = elements.length === 0;
      button.classList.toggle('ac-show-gone', gone);
      button.title = gone ? t('agentReplyShowGone') : '';
      if (gone) return;
      history.dispatch({
        type: 'SELECT_ELEMENTS',
        ids: elements.map((el) => el.id),
      });
      let right = 20;
      const sidebar = panel.getBoundingClientRect().width;
      if (sidebar > 0) {
        if (window.innerWidth - sidebar < MIN_FIT_WIDTH) setOpen(false);
        // Keeps the elements out from under the sidebar.
        else right = sidebar + 40;
      }
      const vp = fitToBox(
        unionOf(elements.map((el) => getRotatedBounds(el, all))),
        window.innerWidth,
        window.innerHeight,
        // A single small node should not fill the screen.
        { right, maxZoom: 1.5 },
      );
      history.dispatch({
        type: 'SET_VIEWPORT',
        offsetX: vp.offsetX,
        offsetY: vp.offsetY,
        zoom: vp.zoom,
      });
    });
    return button;
  }

  function meta(text: string, error = false): HTMLElement {
    const el = document.createElement('div');
    el.className = 'ac-meta';
    if (error) el.classList.add('ac-meta-error');
    el.textContent = text;
    return el;
  }

  function renderMessages(agent: ChatAgent | null): void {
    const entries = agent ? agentRequests(agent.id) : [];
    const shown = JSON.stringify([
      agent?.id,
      agent?.name,
      agent?.activity,
      getLocale(),
      // The last reply's time too: past the reply cap the count stays put
      // while the oldest reply gives way to a new one.
      entries.map((e) => [
        e.ref,
        e.status,
        e.reason,
        e.replies.length,
        e.replies.at(-1)?.at,
      ]),
    ]);
    if (shown === messagesShown) return;
    messagesShown = shown;
    const messages = entries.reduce((n, e) => n + 1 + e.replies.length, 0);
    const following =
      body.scrollHeight - body.scrollTop - body.clientHeight < FOLLOW_THRESHOLD;
    const grew = agent?.id === renderedFor && messages > renderedCount;
    const switched = agent?.id !== renderedFor;
    renderedFor = agent?.id ?? null;
    renderedCount = messages;

    body.innerHTML = '';
    if (!agent) return;
    if (entries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'ac-empty';
      empty.textContent = t('agentChatEmpty').replace('{{name}}', agent.name);
      body.appendChild(empty);
      return;
    }
    const time = timeFormat();
    for (const entry of entries) {
      const mine = document.createElement('div');
      mine.className = 'ac-msg ac-msg-me';
      const text = document.createElement('div');
      text.className = 'ac-text';
      text.textContent = entry.text;
      // Once answered, the status is implied by the reply below.
      const status =
        entry.status === 'replied'
          ? time.format(entry.sentAt)
          : `${time.format(entry.sentAt)} · ${statusLabel(entry, agent.activity)}`;
      mine.append(
        text,
        meta(
          status,
          entry.status === 'rejected' || entry.status === 'interrupted',
        ),
      );
      body.appendChild(mine);
      for (const reply of entry.replies) {
        const theirs = document.createElement('div');
        theirs.className = 'ac-msg ac-msg-agent';
        const content = document.createElement('div');
        content.className = 'ac-text ac-markdown';
        // renderChatMarkdown escapes the text and keeps only http(s) links.
        content.innerHTML = renderChatMarkdown(reply.text);
        theirs.append(content);
        if (reply.elements?.length)
          theirs.appendChild(showOnCanvasButton(reply.elements));
        theirs.appendChild(meta(time.format(reply.at)));
        body.appendChild(theirs);
      }
    }
    if (switched || (grew && following)) body.scrollTop = body.scrollHeight;
  }

  function renderFooter(agent: ChatAgent | null): void {
    let blocked: string | null = null;
    if (!agent) blocked = '';
    else if (!agent.online) blocked = t('agentRequestUnavailable');
    else if (!canSendAgentRequests()) blocked = t('agentRequestUnauthorized');
    notice.hidden = !blocked;
    notice.textContent = blocked ?? '';
    compose.hidden = blocked !== null;
    if (agent)
      input.placeholder = t('agentAskPlaceholder').replace(
        '{{name}}',
        agent.name,
      );
    sendBtn.disabled = !input.value.trim();
    fitInput();
  }

  function render(): void {
    const agents = chatAgents();
    // Nobody left to talk to (the session ended): nothing to show.
    if (agents.length === 0 && open) setOpen(false);
    // A toast for a conversation that is gone (session ended) is stale.
    if (toast && !agents.some((a) => a.id === toast?.agentId)) dismissToast();
    const agent = current(agents);
    if (agent && selected !== agent.id) {
      if (selected) drafts.set(selected, input.value);
      selected = agent.id;
      input.value = drafts.get(agent.id) ?? '';
    }
    if (agent && isShowing(agent.id)) {
      // Seen in the panel: its toast has nothing left to say.
      if (toast?.agentId === agent.id) dismissToast();
      // Marking read notifies again, which renders with the count at zero.
      if (markAgentThreadRead(agent.id)) return;
    }
    renderAgents(agents, agent);
    renderMessages(agent);
    renderFooter(agent);
  }

  /** Whether `agentId`'s thread is on screen right now. */
  function isShowing(agentId: string): boolean {
    return (
      open && selected === agentId && document.visibilityState === 'visible'
    );
  }

  let toast: {
    readonly el: HTMLElement;
    readonly agentId: string;
    timer: ReturnType<typeof setTimeout> | null;
  } | null = null;

  function dismissToast(): void {
    if (!toast) return;
    if (toast.timer) clearTimeout(toast.timer);
    toast.el.remove();
    toast = null;
  }

  /**
   * "{{name}} replied" with an Open button, for a reply that arrives while
   * its thread is not on screen. One at a time: a newer reply replaces it.
   */
  function showReplyToast(agentId: string, agentName: string): void {
    // Replacing a toast the keyboard is on moves the focus to the new one.
    const hadFocus = toast?.el.contains(document.activeElement) ?? false;
    dismissToast();
    const el = document.createElement('div');
    el.className = 'share-toast agent-reply-toast';
    el.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.textContent = t('agentReplyToast').replace('{{name}}', agentName);
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'ui-button agent-reply-toast-open';
    openBtn.textContent = t('agentChatOpenThread');
    openBtn.addEventListener('click', () => {
      dismissToast();
      openAgentChat(agentId);
    });
    el.append(text, openBtn);
    document.body.appendChild(el);
    const current: NonNullable<typeof toast> = {
      el,
      agentId,
      timer: setTimeout(dismissToast, TOAST_MS),
    };
    toast = current;
    // It never expires under the pointer or the keyboard.
    const pause = (): void => {
      if (current.timer) clearTimeout(current.timer);
      current.timer = null;
    };
    const resume = (): void => {
      if (toast !== current || current.timer) return;
      if (el.matches(':hover') || el.contains(document.activeElement)) return;
      current.timer = setTimeout(dismissToast, TOAST_MS);
    };
    el.addEventListener('mouseenter', pause);
    el.addEventListener('focusin', pause);
    el.addEventListener('mouseleave', resume);
    // After the focus has moved, so `activeElement` is the new target.
    el.addEventListener('focusout', () => setTimeout(resume));
    if (hadFocus) openBtn.focus();
  }

  /**
   * Grows the textbox with its text, up to the CSS max-height; past that it
   * scrolls. Needs the element laid out to measure it.
   */
  function fitInput(): void {
    if (!open || compose.hidden) return;
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight + 2}px`;
  }

  function setOpen(next: boolean): void {
    if (next) claimRightSidebar('agent-chat', () => setOpen(false));
    else releaseRightSidebar('agent-chat');
    const wasOpen = open;
    open = next;
    panel.inert = !next;
    panel.classList.toggle('open', next);
    document.body.classList.toggle('agent-chat-open', next);
    if (next) {
      if (!wasOpen) {
        const active = document.activeElement;
        returnFocus =
          active instanceof HTMLElement && active !== document.body
            ? active
            : null;
      }
      render();
      body.scrollTop = body.scrollHeight;
      if (!compose.hidden) input.focus();
    } else if (wasOpen) {
      // inert already moved focus out of the panel; hand it back to what
      // opened it when that is still on screen.
      if (returnFocus?.isConnected && !returnFocus.closest('[hidden]'))
        returnFocus.focus();
      returnFocus = null;
    }
  }

  function submit(): void {
    const agent = current(chatAgents());
    if (!agent?.online) return;
    if (!sendAgentRequest(agent, input.value)) return;
    input.value = '';
    drafts.delete(agent.id);
    // The send already rendered with the old text in the box.
    renderFooter(agent);
    body.scrollTop = body.scrollHeight;
  }

  input.addEventListener('input', () => {
    sendBtn.disabled = !input.value.trim();
    fitInput();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  sendBtn.addEventListener('click', submit);
  close.addEventListener('click', () => setOpen(false));
  // See the module comment: the board's key handlers listen on window.
  panel.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' && !e.isComposing) setOpen(false);
  });

  openImpl = (agentId) => {
    if (agentId) select(agentId);
    setOpen(true);
  };
  toggleImpl = () => setOpen(!open);

  onLivePeers((others) => {
    livePeers = others;
    for (const peer of others)
      if (peer.kind === 'agent') knownNames.set(peer.id, peer.name);
    render();
  });
  subscribeAgentRequests(render);
  onAgentReply(({ agentId, agentName }) => {
    if (isShowing(agentId)) markAgentThreadRead(agentId);
    else showReplyToast(agentId, agentName);
  });
  // Replies that came in while the tab was in the background are read once
  // the thread is back on screen.
  document.addEventListener('visibilitychange', () => {
    if (selected && isShowing(selected)) render();
  });
  render();
}
