/**
 * The compact layout: touch screens and windows below the `sm` breakpoint
 * (40rem). overlays.css hides the hints, the command palette and element
 * search there with this exact query; TypeScript that must agree with those
 * rules uses it too (tests/compact_layout.test.ts keeps them in sync).
 */
export const COMPACT_LAYOUT = '(pointer: coarse), (width < 40rem)';

/** Whether the compact layout applies now (false outside a browser). */
export function isCompactLayout(): boolean {
  return typeof matchMedia === 'function' && matchMedia(COMPACT_LAYOUT).matches;
}

/** Calls `onEnter` each time the window switches into the compact layout. */
export function onCompactLayoutEnter(onEnter: () => void): void {
  if (typeof matchMedia !== 'function') return;
  matchMedia(COMPACT_LAYOUT).addEventListener('change', (e) => {
    if (e.matches) onEnter();
  });
}
