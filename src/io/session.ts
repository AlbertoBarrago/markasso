import type { GridType } from '../core/app_state';
import type { Viewport } from '../core/viewport';
import type { Element } from '../elements/element';
import type { History } from '../engine/history';
import { t } from '../i18n';
import { validateElements, validateViewport } from './element_validation';
import { removeStorage } from './safe_storage';

const STORAGE_KEY = 'markasso-session';
const DEBOUNCE_MS = 500;

// ── Load (called before History is created) ─────────────────────────────────

export interface SessionData {
  elements: Element[];
  viewport: Viewport;
  gridVisible: boolean;
  gridSize: number;
  gridType: GridType;
}

export function loadSession(): SessionData | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Record<string, unknown>;
    const elements = validateElements(d.elements);
    if (!elements || elements.length === 0) return null;
    const viewport: Viewport = validateViewport(d.viewport) ?? {
      offsetX: 0,
      offsetY: 0,
      zoom: 1,
    };
    const VALID_GRID_TYPES: GridType[] = ['dot', 'line', 'mm'];
    const gridVisible =
      typeof d.gridVisible === 'boolean' ? d.gridVisible : true;
    const gridSize =
      typeof d.gridSize === 'number' && d.gridSize > 0 ? d.gridSize : 20;
    const gridType: GridType = VALID_GRID_TYPES.includes(d.gridType as GridType)
      ? (d.gridType as GridType)
      : 'dot';
    return { elements, viewport, gridVisible, gridSize, gridType };
  } catch {
    return null;
  }
}

// ── Init (called after all UI is wired up) ──────────────────────────────────

/** The debounced save still waiting to run, if any (see flushSession). */
let pendingSave: (() => void) | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Runs the pending debounced save right away. Call it before reloading the
 * page, otherwise the last DEBOUNCE_MS of edits would be lost.
 */
export function flushSession(): void {
  if (pendingTimer !== null) clearTimeout(pendingTimer);
  pendingTimer = null;
  const save = pendingSave;
  pendingSave = null;
  save?.();
}

export function initSession(history: History): void {
  history.subscribe((scene) => {
    if (pendingTimer !== null) clearTimeout(pendingTimer);
    pendingSave = () => {
      if (scene.elements.length === 0) {
        removeStorage(STORAGE_KEY);
        return;
      }
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            version: 1,
            viewport: scene.viewport,
            elements: scene.elements,
            gridVisible: scene.appState.gridVisible,
            gridSize: scene.appState.gridSize,
            gridType: scene.appState.gridType,
          }),
        );
      } catch (e) {
        if (
          e instanceof DOMException &&
          (e.name === 'QuotaExceededError' ||
            e.name === 'NS_ERROR_DOM_QUOTA_REACHED')
        ) {
          showStorageWarning(t('sessionQuotaFull'), true);
        } else {
          // Storage blocked by the browser: nothing will survive a reload,
          // so the warning stays until dismissed.
          showStorageWarning(t('sessionStorageBlocked'), false);
        }
      }
    };
    pendingTimer = setTimeout(flushSession, DEBOUNCE_MS);
  });
}

// ── Storage warning toast ───────────────────────────────────────────────────

/** Tells the user the session is not being kept, once per page. */
function showStorageWarning(message: string, autoDismiss: boolean): void {
  if (document.getElementById('markasso-quota-toast')) return;
  const toast = document.createElement('div');
  toast.id = 'markasso-quota-toast';
  toast.className = 'quota-toast';
  const text = document.createElement('span');
  text.textContent = message;
  const close = document.createElement('button');
  close.className = 'quota-toast-close';
  close.title = t('close');
  close.textContent = '✕';
  toast.append(text, close);
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  const dismiss = (): void => {
    toast.classList.remove('visible');
    toast.addEventListener('transitionend', () => toast.remove(), {
      once: true,
    });
  };
  close.addEventListener('click', dismiss);
  if (autoDismiss) setTimeout(dismiss, 8000);
}
