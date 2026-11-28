import { t } from '../i18n';
import { onLivePeers, type PeerInfo, setLiveName } from '../io/realtime';
import { openAgentChat } from './agent_chat_panel';

/**
 * Renders the live-session participant list: an editable "you" row followed by
 * the other connected peers. Called with presence updates via `onLivePeers`.
 *
 * AI agent rows get an Ask button that opens the agent chat sidebar on that
 * agent (see agent_chat_panel.ts); the click also reaches the document, which
 * closes the People popover.
 */
export function initPeopleList(container: HTMLElement): () => void {
  let editing = false;
  let lastOthers: PeerInfo[] = [];
  let lastSelf: PeerInfo | null = null;

  /** An AI agent's row: name and the Ask button. */
  function buildAgent(peer: PeerInfo): HTMLElement {
    const row = buildRow(peer.name, peer.color, false);
    row.classList.add('pp-agent');
    const ask = document.createElement('button');
    ask.type = 'button';
    ask.className = 'pp-ask';
    ask.textContent = t('agentAsk');
    ask.addEventListener('click', () => openAgentChat(peer.id));
    row.appendChild(ask);
    return row;
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
  }

  const stopPeers = onLivePeers((others, self) => {
    render(others, self);
  });
  return stopPeers;
}
