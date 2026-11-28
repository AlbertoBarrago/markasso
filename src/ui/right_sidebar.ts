/**
 * The right edge holds one sidebar at a time (library, agent chat): they
 * share the same slot and would overlap. A sidebar claims the slot when it
 * opens, which closes the one holding it, and releases it when it closes.
 */

let holder: { readonly id: string; readonly close: () => void } | null = null;

/** Takes the slot for `id`, closing the sidebar that held it. */
export function claimRightSidebar(id: string, close: () => void): void {
  const previous = holder;
  holder = { id, close };
  if (previous && previous.id !== id) previous.close();
}

/** Frees the slot if `id` holds it. */
export function releaseRightSidebar(id: string): void {
  if (holder?.id === id) holder = null;
}
