import { t } from '../i18n';
import {
  type AgentRequestEntry,
  agentRequests,
  canSendAgentRequests,
  sendAgentRequest,
  subscribeAgentRequests,
} from '../io/agent_requests';
import { MAX_AGENT_REQUEST_CHARS } from '../io/agent_requests_protocol';
import { onLivePeers, type PeerInfo, setLiveName } from '../io/realtime';

const STATUS_KEYS: Record<AgentRequestEntry['status'], string> = {
  sending: 'agentRequestSending',
  sent: 'agentRequestSent',
  received: 'agentRequestReceived',
  replied: 'agentRequestReplied',
  rejected: 'agentRequestInvalid',
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

function statusLabel(entry: AgentRequestEntry): string {
  if (entry.status === 'rejected' && entry.reason)
    return t(REJECTION_KEYS[entry.reason]);
  return t(STATUS_KEYS[entry.status]);
}

/**
 * Renders the live-session participant list: an editable "you" row followed by
 * the other connected peers. Called with presence updates via `onLivePeers`.
 *
 * AI agent rows get an Ask composer when the room confirmed this tab's licence
 * (see io/agent_requests.ts), followed by the recent requests and answers.
 * The list is rebuilt on every change, so the open composer, its draft and
 * its focus live here and are restored after each render.
 */
export function initPeopleList(container: HTMLElement): () => void {
  let editing = false;
  let composerFor: string | null = null;
  const drafts = new Map<string, string>();
  let lastOthers: PeerInfo[] = [];
  let lastSelf: PeerInfo | null = null;

  function buildThread(agentId: string): HTMLElement | null {
    const entries = agentRequests(agentId);
    if (entries.length === 0) return null;
    const thread = document.createElement('div');
    thread.className = 'pp-thread';
    for (const entry of entries) {
      const item = document.createElement('div');
      item.className = 'pp-request';
      const text = document.createElement('div');
      text.className = 'pp-request-text';
      text.textContent = entry.text;
      const status = document.createElement('div');
      status.className = 'pp-request-status';
      if (entry.status === 'rejected') status.classList.add('pp-request-error');
      status.textContent = statusLabel(entry);
      item.append(text, status);
      for (const reply of entry.replies) {
        const answer = document.createElement('div');
        answer.className = 'pp-reply';
        answer.textContent = reply;
        item.appendChild(answer);
      }
      thread.appendChild(item);
    }
    return thread;
  }

  function buildComposer(agent: PeerInfo): HTMLTextAreaElement {
    const input = document.createElement('textarea');
    input.className = 'pp-input pp-composer';
    input.rows = 2;
    input.maxLength = MAX_AGENT_REQUEST_CHARS;
    input.placeholder = t('agentAskPlaceholder').replace(
      '{{name}}',
      agent.name,
    );
    input.value = drafts.get(agent.id) ?? '';
    input.addEventListener('input', () => drafts.set(agent.id, input.value));
    input.addEventListener('keydown', (e) => {
      // Keeps canvas shortcuts (and the panel's own keys) out of the textbox.
      e.stopPropagation();
      if (e.key === 'Escape') {
        composerFor = null;
        rerender();
      } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (sendAgentRequest(agent.id, input.value)) drafts.delete(agent.id);
      }
    });
    return input;
  }

  /** An AI agent's row: name, Ask toggle, composer and recent requests. */
  function buildAgent(peer: PeerInfo): HTMLElement {
    const block = document.createElement('div');
    block.className = 'pp-agent';
    // Clicks here must not reach the document handler closing the panel.
    block.addEventListener('click', (e) => e.stopPropagation());
    const row = buildRow(peer.name, peer.color, false);
    block.appendChild(row);
    // Earlier requests stay visible even if access was lost since.
    const thread = buildThread(peer.id);
    if (!canSendAgentRequests()) {
      if (thread) block.appendChild(thread);
      return block;
    }

    const ask = document.createElement('button');
    ask.type = 'button';
    ask.className = 'pp-ask';
    ask.textContent = t('agentAsk');
    ask.setAttribute('aria-expanded', String(composerFor === peer.id));
    ask.addEventListener('click', () => {
      composerFor = composerFor === peer.id ? null : peer.id;
      rerender();
      if (composerFor)
        container.querySelector<HTMLElement>('.pp-composer')?.focus();
    });
    row.appendChild(ask);
    if (composerFor === peer.id) block.appendChild(buildComposer(peer));
    if (thread) block.appendChild(thread);
    return block;
  }

  function rerender(): void {
    if (lastSelf) render(lastOthers, lastSelf);
  }

  function buildRow(name: string, color: string, isSelf: boolean): HTMLElement {
    const row = document.createElement('div');
    row.className = 'pp-row';
    const dot = document.createElement('span');
    dot.className = 'pp-dot';
    dot.style.background = color;
    const label = document.createElement('span');
    label.className = 'pp-name';
    label.textContent = name;
    if (isSelf) {
      const you = document.createElement('span');
      you.className = 'pp-you';
      you.textContent = ` (${t('peopleYou')})`;
      label.appendChild(you);
      row.classList.add('pp-self');
    }
    row.append(dot, label);
    return row;
  }

  function render(others: PeerInfo[], self: PeerInfo): void {
    lastOthers = others;
    lastSelf = self;
    // A rename in progress owns the list until it ends (it re-renders then).
    if (editing) return;
    const focused =
      container.querySelector<HTMLTextAreaElement>('.pp-composer:focus');
    const caret = focused
      ? [focused.selectionStart, focused.selectionEnd]
      : null;
    if (composerFor && !others.some((p) => p.id === composerFor))
      composerFor = null;
    container.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'pp-title';
    title.textContent =
      others.length === 0
        ? t('peopleOnlyYou')
        : t('peopleConnected').replace('{{count}}', String(others.length));
    container.appendChild(title);

    const selfRow = buildRow(self.name, self.color, true);
    selfRow.addEventListener('click', () => {
      if (editing) return;
      editing = true;
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 24;
      input.className = 'pp-input';
      input.value = self.name;
      selfRow.replaceWith(input);
      input.focus();
      input.select();
      let cancelled = false;
      const finish = (): void => {
        if (!editing) return;
        editing = false;
        const val = input.value.trim();
        if (!cancelled && val) {
          // `setLiveName` re-runs `render` via the presence subscription.
          setLiveName(val);
        } else {
          rerender();
        }
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
        else if (e.key === 'Escape') {
          cancelled = true;
          input.blur();
        }
      });
      input.addEventListener('blur', finish);
    });
    container.appendChild(selfRow);

    for (const peer of others) {
      container.appendChild(
        peer.kind === 'agent'
          ? buildAgent(peer)
          : buildRow(peer.name, peer.color, false),
      );
    }

    if (caret) {
      const composer =
        container.querySelector<HTMLTextAreaElement>('.pp-composer');
      composer?.focus();
      composer?.setSelectionRange(caret[0] ?? 0, caret[1] ?? 0);
    }
  }

  const stopPeers = onLivePeers((others, self) => {
    render(others, self);
  });
  const stopRequests = subscribeAgentRequests(rerender);
  return () => {
    stopPeers();
    stopRequests();
  };
}
