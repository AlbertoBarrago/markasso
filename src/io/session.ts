import type { GridType } from '../core/app_state';
import type { Viewport } from '../core/viewport';
import type { Element } from '../elements/element';
import type { History } from '../engine/history';
import { validateElements, validateViewport } from './element_validation';

const STORAGE_KEY = 'markasso-session';
const DEBOUNCE_MS = 500;
/** Longest a change waits for a quiet moment before it is saved anyway. */
const MAX_WAIT_MS = 2000;
const ROOM_ID = /^[a-zA-Z0-9_-]{3,64}$/;

// ── Load (called before History is created) ─────────────────────────────────

export interface SessionData {
  elements: Element[];
  viewport: Viewport;
  gridVisible: boolean;
  gridSize: number;
  gridType: GridType;
  /**
   * Live room the drawing was last synced with, or null for a drawing of
   * this browser only. Opening that same room again brings nothing new, so
   * it needs no confirmation.
   */
  liveRoom: string | null;
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
    const liveRoom =
      typeof d.liveRoom === 'string' && ROOM_ID.test(d.liveRoom)
        ? d.liveRoom
        : null;
    return { elements, viewport, gridVisible, gridSize, gridType, liveRoom };
  } catch {
    return null;
  }
}

// ── Init (called after all UI is wired up) ──────────────────────────────────

/** The debounced save still waiting to run, if any (see flushSession). */
let pendingSave: (() => void) | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
/** When the oldest change still unsaved arrived (see MAX_WAIT_MS). */
let pendingSince: number | null = null;

/**
 * Runs the pending debounced save right away. Call it before reloading the
 * page, otherwise the last DEBOUNCE_MS of edits would be lost.
 */
export function flushSession(): void {
  if (pendingTimer !== null) clearTimeout(pendingTimer);
  pendingTimer = null;
  pendingSince = null;
  const save = pendingSave;
  pendingSave = null;
  save?.();
}

export interface SessionOptions {
  /**
   * True while the canvas shows a board that is stored elsewhere (a cloud
   * board): saving it here would overwrite the drawing of this browser.
   */
  paused?: () => boolean;
  /** Live room the canvas is in sync with, if any (see SessionData.liveRoom). */
  liveRoom?: () => string | null;
}

export function initSession(
  history: History,
  options: SessionOptions = {},
): void {
  history.subscribe((scene) => {
    if (pendingTimer !== null) clearTimeout(pendingTimer);
    pendingSave = () => {
      if (options.paused?.()) return;
      try {
        if (scene.elements.length === 0) {
          localStorage.removeItem(STORAGE_KEY);
          return;
        }
        const liveRoom = options.liveRoom?.() ?? null;
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            version: 1,
            viewport: scene.viewport,
            elements: scene.elements,
            gridVisible: scene.appState.gridVisible,
            gridSize: scene.appState.gridSize,
            gridType: scene.appState.gridType,
            ...(liveRoom && { liveRoom }),
          }),
        );
      } catch (e) {
        if (
          e instanceof DOMException &&
          (e.name === 'QuotaExceededError' ||
            e.name === 'NS_ERROR_DOM_QUOTA_REACHED')
        ) {
          showQuotaWarning();
        } else {
          console.error('Could not save the session', e);
        }
      }
    };
    // Every change re-arms the debounce, panning and zooming included: cap
    // the wait so a long continuous interaction still gets saved.
    const now = Date.now();
    pendingSince ??= now;
    if (now - pendingSince >= MAX_WAIT_MS) flushSession();
    else pendingTimer = setTimeout(flushSession, DEBOUNCE_MS);
  });
  // Closing or reloading the tab inside the debounce would lose the last
  // edit. `pagehide` is not reliable on mobile, hence `visibilitychange` too.
  window.addEventListener('pagehide', flushSession);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSession();
  });
}

// ── Quota warning toast ─────────────────────────────────────────────────────

function showQuotaWarning(): void {
  if (document.getElementById('markasso-quota-toast')) return;
  const toast = document.createElement('div');
  toast.id = 'markasso-quota-toast';
  toast.className = 'quota-toast';
  toast.innerHTML = `
    <span>Session not saved — storage quota exceeded. Use <strong>Save .markasso</strong> to keep your work.</span>
    <button class="quota-toast-close" title="Dismiss">✕</button>
  `;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  const dismiss = (): void => {
    toast.classList.remove('visible');
    toast.addEventListener('transitionend', () => toast.remove(), {
      once: true,
    });
  };
  toast.querySelector('.quota-toast-close')?.addEventListener('click', dismiss);
  setTimeout(dismiss, 8000);
}
