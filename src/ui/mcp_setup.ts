import { t } from '../i18n';
import { MCP_DOCS_URL } from './mcp_clients';
import { createMcpTabs } from './mcp_tabs';

export interface McpSetupHandle {
  open(): void;
}

const openListeners: (() => void)[] = [];

/** Register a callback run every time the setup dialog opens (idle tips). */
export function onMcpSetupOpen(fn: () => void): void {
  openListeners.push(fn);
}

const EXAMPLE_KEYS = ['mcpExample1', 'mcpExample2', 'mcpExample3'] as const;

/**
 * "Connect AI agent" dialog: one tab per MCP client with its install snippet
 * and a copy button, plus example prompts. Reached from the menu, the command
 * palette and the live-session invite.
 */
export function initMcpSetup(appEl: HTMLElement): McpSetupHandle {
  let modalEl: HTMLElement | null = null;
  /** Remembered across openings: people usually return for the same client. */
  let activeId: string | undefined;

  function open(): void {
    if (modalEl) return;

    modalEl = document.createElement('div');
    modalEl.id = 'mcp-setup-modal';
    modalEl.innerHTML = `
      <div class="mcp-card" role="dialog" aria-modal="true" aria-labelledby="mcp-title">
        <div class="mcp-header">
          <h2 class="mcp-title" id="mcp-title">${t('connectAiAgent')}</h2>
          <button class="guide-close mcp-close" aria-label="${t('close')}">&times;</button>
        </div>
        <p class="mcp-desc">${t('mcpSetupDesc')}</p>
        <div class="mcp-tabs-slot"></div>
        <h3 class="mcp-subtitle">${t('mcpExamplesTitle')}</h3>
        <ul class="mcp-examples">
          ${EXAMPLE_KEYS.map((key) => `<li>${t(key)}</li>`).join('')}
        </ul>
        <p class="mcp-live">${t('mcpLiveHint')}</p>
        <a class="mcp-docs" href="${MCP_DOCS_URL}" target="_blank" rel="noopener noreferrer">${t('mcpDocs')}</a>
      </div>
    `;

    const tabs = createMcpTabs({
      label: t('connectAiAgent'),
      initialId: activeId,
      onSelect: (id) => {
        activeId = id;
      },
    });
    modalEl.querySelector('.mcp-tabs-slot')!.replaceWith(tabs.element);

    const close = (): void => {
      if (!modalEl) return;
      const el = modalEl;
      el.classList.add('mcp-out');
      el.addEventListener('animationend', () => el.remove(), { once: true });
      modalEl = null;
      document.removeEventListener('keydown', onKey);
    };

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };

    modalEl
      .querySelector<HTMLButtonElement>('.mcp-close')!
      .addEventListener('click', close);
    modalEl.addEventListener('click', (e) => {
      if (e.target === modalEl) close();
    });
    document.addEventListener('keydown', onKey);

    appEl.appendChild(modalEl);
    requestAnimationFrame(() => tabs.focusSelected());
    for (const fn of openListeners) fn();
  }

  return { open };
}
