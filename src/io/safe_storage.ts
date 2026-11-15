/**
 * localStorage access that survives a browser blocking it. With cookies or
 * site data disabled (and in some private modes or managed browsers), merely
 * reading `localStorage` throws a SecurityError, and a write can also throw
 * when the quota is full. Every preference read here falls back to "not
 * set", and every write reports whether it was kept, so the app still starts
 * and works, only without remembering things across reloads.
 */

/** The value stored under `key`, or null when absent or unreadable. */
export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Stores `value` under `key`. Returns false when the browser refused it. */
export function writeStorage(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** Removes `key`; does nothing when storage is unavailable. */
export function removeStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing stored to remove.
  }
}

/** Whether the browser lets this page use localStorage at all. */
export function isStorageAvailable(): boolean {
  try {
    localStorage.getItem('');
    return true;
  } catch {
    return false;
  }
}

/**
 * `localStorage`, or, when the browser blocks it, a Storage whose every call
 * throws, as `localStorage` itself does in some private modes. For code that
 * takes a `Storage` and already handles its errors (the cloud client warns
 * that the licence cannot be stored, and keeps edit tokens in the link):
 * nothing that must outlive the tab is ever held in memory instead.
 */
export function browserStorage(): Storage {
  try {
    const storage = localStorage;
    storage.getItem('');
    return storage;
  } catch (error) {
    return blockedStorage(error);
  }
}

/** A Storage that refuses every call with `error`. */
function blockedStorage(error: unknown): Storage {
  const refuse = (): never => {
    throw error;
  };
  return {
    get length(): number {
      return refuse();
    },
    clear: refuse,
    getItem: refuse,
    key: refuse,
    removeItem: refuse,
    setItem: refuse,
  };
}
