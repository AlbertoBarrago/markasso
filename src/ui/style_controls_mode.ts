/**
 * Where the style controls of a selection or drawing tool live (Settings >
 * Style controls): the context panel, or a compact bar floating next to the
 * selection (as in the macOS app). The value is persisted with the other UI
 * settings; this module only holds the live value and tells its listeners.
 */
export type StyleControlsMode = 'panel' | 'floating';

let mode: StyleControlsMode = 'panel';
const listeners = new Set<() => void>();

export function isFloatingStyleControls(): boolean {
  return mode === 'floating';
}

export function setStyleControlsMode(next: StyleControlsMode): void {
  if (next === mode) return;
  mode = next;
  for (const listener of listeners) listener();
}

/** Calls `listener` after every change of mode; returns the unsubscribe. */
export function onStyleControlsModeChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
