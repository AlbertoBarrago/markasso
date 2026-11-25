import '../styles/mcp-tabs.css';
import { t } from '../i18n';
import { buildMcpClients } from './mcp_clients';
import { copyToClipboard } from './share_actions';

export interface McpTabsOptions {
  /** Accessible name of the tab list. */
  readonly label: string;
  /** Client selected first; defaults to the first one. */
  readonly initialId?: string | undefined;
  /** Told every time a client is selected, e.g. to remember it. */
  readonly onSelect?: (id: string) => void;
}

export interface McpTabs {
  /** The tab list and its panel, to place in the page. */
  readonly element: HTMLElement;
  /** Moves focus to the selected tab. */
  focusSelected(): void;
}

/**
 * One tab per MCP client (data from mcp_clients.ts) with its install snippet
 * and a copy button. Shared by the "Connect AI agent" dialog and the /agents
 * page so the two never drift apart.
 *
 * WAI-ARIA tabs with automatic activation: arrows move and select, only the
 * selected tab is in the tab order.
 */
export function createMcpTabs(options: McpTabsOptions): McpTabs {
  const clients = buildMcpClients();
  const element = document.createElement('div');
  element.className = 'mcp-tabs-widget';
  element.innerHTML = `
    <div class="mcp-tabs" role="tablist"></div>
    <div class="mcp-panel" role="tabpanel">
      <p class="mcp-where"></p>
      <div class="mcp-snippet">
        <pre><code></code></pre>
        <button class="mcp-copy" type="button"></button>
      </div>
    </div>
  `;
  const tabsEl = element.querySelector<HTMLElement>('.mcp-tabs')!;
  tabsEl.setAttribute('aria-label', options.label);
  const panelEl = element.querySelector<HTMLElement>('.mcp-panel')!;
  const whereEl = element.querySelector<HTMLElement>('.mcp-where')!;
  const codeEl = element.querySelector<HTMLElement>('.mcp-snippet code')!;
  const copyBtn = element.querySelector<HTMLButtonElement>('.mcp-copy')!;

  let active = clients.find((c) => c.id === options.initialId) ?? clients[0]!;

  const tabs = clients.map((client) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'ui-button mcp-tab';
    tab.id = `mcp-tab-${client.id}`;
    tab.setAttribute('role', 'tab');
    tab.textContent = client.name;
    tab.addEventListener('click', () => select(clients.indexOf(client)));
    tabsEl.appendChild(tab);
    return tab;
  });

  function select(index: number): void {
    active = clients[index]!;
    clients.forEach((c, i) => {
      const selected = c.id === active.id;
      tabs[i]!.setAttribute('aria-selected', String(selected));
      tabs[i]!.tabIndex = selected ? 0 : -1;
    });
    panelEl.setAttribute('aria-labelledby', `mcp-tab-${active.id}`);
    // Snippets and file names go in as text: they are shown, not parsed.
    whereEl.textContent = t(active.whereKey).replace(
      '{{file}}',
      active.file ?? '',
    );
    codeEl.textContent = active.snippet;
    copyBtn.textContent = t('mcpCopy');
    options.onSelect?.(active.id);
  }

  tabsEl.addEventListener('keydown', (e) => {
    const current = clients.indexOf(active);
    let next: number;
    if (e.key === 'ArrowRight') next = (current + 1) % clients.length;
    else if (e.key === 'ArrowLeft')
      next = (current - 1 + clients.length) % clients.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = clients.length - 1;
    else return;
    e.preventDefault();
    select(next);
    tabs[next]!.focus();
  });

  copyBtn.addEventListener('click', () => {
    void copyToClipboard(active.snippet).then((ok) => {
      // On failure the snippet stays selectable in the <pre> above.
      copyBtn.textContent = ok ? t('mcpCopied') : t('mcpCopyFailed');
    });
  });

  select(clients.indexOf(active));

  return {
    element,
    focusSelected(): void {
      tabs[clients.indexOf(active)]?.focus({ preventScroll: true });
    },
  };
}
