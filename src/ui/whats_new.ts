import { t } from '../i18n';
import { readStorage, writeStorage } from '../io/safe_storage';

const STORAGE_KEY = 'markasso-whats-new-version';

/**
 * Release whose highlights are shown. Bump it only when the list below
 * changes, so patch releases don't reopen the same notice.
 */
export const WHATS_NEW_ID = '1.22';
const RELEASE_URL = 'https://github.com/AlbertoBarrago/markasso/releases';

/** [title, text, optional link]: the link opens in a new tab. */
const HIGHLIGHTS: readonly (readonly [string, string, string?])[] = [
  ['whatsNewStyleBarTitle', 'whatsNewStyleBar'],
  ['whatsNewContextMenuTitle', 'whatsNewContextMenu'],
  ['whatsNewCloudTitle', 'whatsNewCloud', '/cloud/'],
  ['whatsNewMacTitle', 'whatsNewMac', '/mac/'],
];

/**
 * What to do with the notice on this visit:
 * - `skip`: these highlights were already seen;
 * - `markSeen`: a first visit (no notice ever seen, nothing drawn yet). Its
 *   "new" features are not news to someone who never used Markasso, so the
 *   welcome card shows instead and these highlights count as seen;
 * - `show`: a returning visitor who has not seen these highlights. Someone
 *   with a saved drawing but no stored version predates the notice.
 */
export function whatsNewAction(
  stored: string | null,
  hasSavedWork: boolean,
): 'show' | 'skip' | 'markSeen' {
  if (stored === WHATS_NEW_ID) return 'skip';
  if (stored === null && !hasSavedWork) return 'markSeen';
  return 'show';
}

/**
 * Shows the release highlights once per WHATS_NEW_ID, to returning visitors
 * only (see {@link whatsNewAction}).
 * @param hasSavedWork whether this browser has a saved drawing.
 * @returns true when the notice was shown (the welcome card is then skipped).
 */
export function initWhatsNew(
  appEl: HTMLElement,
  hasSavedWork: boolean,
): boolean {
  const action = whatsNewAction(readStorage(STORAGE_KEY), hasSavedWork);
  if (action === 'markSeen') writeStorage(STORAGE_KEY, WHATS_NEW_ID);
  if (action !== 'show') return false;

  const overlay = document.createElement('div');
  overlay.id = 'whats-new-overlay';

  overlay.innerHTML = `
    <div class="ui-card wn-card" role="dialog" aria-modal="true" aria-label="${t('whatsNewAria')}" aria-describedby="whats-new-desc">
      <div class="wn-kicker">Markasso ${WHATS_NEW_ID}</div>
      <h2 class="wn-title">${t('whatsNewTitle')}</h2>
      <p class="wn-desc" id="whats-new-desc">${t('whatsNewDesc')}</p>
      <ul class="wn-list">
        ${HIGHLIGHTS.map(([title, text, href]) => `<li><strong>${t(title)}</strong> ${t(text)}${href ? ` <a class="wn-more" href="${href}" target="_blank" rel="noopener">${t('whatsNewMore')}</a>` : ''}</li>`).join('')}
      </ul>
      <div class="wn-actions">
        <a class="wn-link" href="${RELEASE_URL}" target="_blank" rel="noopener noreferrer">${t('whatsNewDetails')}</a>
        <button class="wn-cta" type="button">${t('startDrawing')}</button>
      </div>
    </div>
  `;

  const dismiss = (): void => {
    writeStorage(STORAGE_KEY, WHATS_NEW_ID);
    overlay.classList.add('wn-out');
    overlay.addEventListener('animationend', () => overlay.remove(), {
      once: true,
    });
    document.removeEventListener('keydown', onKey);
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') dismiss();
  };

  const cta = overlay.querySelector<HTMLButtonElement>('.wn-cta')!;
  cta.addEventListener('click', dismiss);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) dismiss();
  });
  document.addEventListener('keydown', onKey);
  appEl.appendChild(overlay);
  cta.focus({ preventScroll: true });

  return true;
}
