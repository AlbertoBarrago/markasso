import type { History } from '../engine/history';
import { t } from '../i18n';
import {
  type CloudAction,
  cloudAction,
  cloudActionAvailable,
} from './cloud_boards';
import { boardsShortcut } from './keyboard_utils';

const isMac = navigator.platform.toUpperCase().includes('MAC');
const mod = isMac ? '⌘' : 'Ctrl+';

interface Shortcut {
  icon: string;
  label: string;
  key: string;
  iconClass?: string;
  /** The cloud action the shortcut runs: the row shows only when it is available. */
  cloud?: CloudAction;
}

const SHORTCUTS: Shortcut[] = [
  { icon: '⌘', label: t('commandPalette'), key: `${mod}K` },
  {
    icon: '⌕',
    label: t('elementSearch'),
    key: `${mod}F`,
    iconClass: 'wl-shortcut-icon--search',
  },
  { icon: '📂', label: t('openFile'), key: `${mod}O` },
  { icon: '💾', label: t('saveFile'), key: `${mod}S` },
  {
    icon: '☁',
    label: t('cloudBoards'),
    key: `${mod}⇧O`,
    cloud: 'cloudBoards',
  },
  { icon: '↩', label: t('undoLabel'), key: `${mod}Z` },
  { icon: '↪', label: t('redoLabel'), key: isMac ? '⌘⇧Z' : 'Ctrl+Y' },
];

/**
 * The first-visit card on an empty board: what Markasso is for (drawing with
 * AI agents), where drawings are kept, the main shortcuts, and two ways in:
 * drawing, or connecting an agent through `onConnectAgent` (the "Connect AI
 * agent" dialog). It closes itself as soon as something is drawn.
 */
export function initWelcome(
  appEl: HTMLElement,
  history: History,
  onConnectAgent: () => void,
): void {
  if (history.present.elements.length > 0) return;
  const shortcuts = SHORTCUTS.filter(
    (s) => !s.cloud || cloudActionAvailable(history, s.cloud),
  );

  const overlay = document.createElement('div');
  overlay.id = 'welcome-overlay';

  overlay.innerHTML = `
    <div class="wl-card" role="dialog" aria-modal="true" aria-label="${t('welcomeAria')}" aria-describedby="welcome-desc">
      <div class="wl-brand">
        <img width="140" height="140" src="/markasso-logo-icon.svg" alt="Markasso logo"/>
        <span class="wl-name">Markasso</span>
      </div>
      <p class="wl-pitch">${t('welcomePitch')}</p>
      <p class="wl-tagline" id="welcome-desc">
        ${t('welcomeTagline').replace('\n', '<br>')}
      </p>
      <ul class="wl-shortcuts">
        ${shortcuts
          .map(
            (s) => `
          <li class="wl-shortcut-row${s.cloud ? ' wl-shortcut-row--cloud' : ''}">
            <span class="wl-shortcut-icon${s.iconClass ? ` ${s.iconClass}` : ''}">${s.icon}</span>
            <span class="wl-shortcut-label">${s.label}</span>
            <kbd class="wl-kbd">${s.key}</kbd>
          </li>
        `,
          )
          .join('')}
      </ul>
      <div class="wl-actions">
        <button class="wl-agent">${t('connectAiAgent')}</button>
        <button class="wl-cta">${t('startDrawing')}</button>
      </div>
    </div>
  `;

  const dismiss = (): void => {
    overlay.classList.add('wl-out');
    overlay.addEventListener('animationend', () => overlay.remove(), {
      once: true,
    });
    unsubscribe();
    document.removeEventListener('keydown', onKey);
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') dismiss();
    // The card is modal, so the global handler would ignore the shortcut it
    // advertises: close the card and open the boards from here instead.
    if (boardsShortcut(e) && cloudActionAvailable(history, 'cloudBoards')) {
      e.preventDefault();
      e.stopPropagation();
      dismiss();
      cloudAction(history, 'cloudBoards');
    }
  };

  overlay.querySelector('.wl-cta')!.addEventListener('click', dismiss);
  overlay.querySelector('.wl-agent')!.addEventListener('click', () => {
    dismiss();
    onConnectAgent();
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) dismiss();
  });
  document.addEventListener('keydown', onKey);

  // Auto-dismiss as soon as the user draws something
  const unsubscribe = history.subscribe((scene) => {
    if (scene.elements.length > 0) dismiss();
  });

  appEl.appendChild(overlay);
}
