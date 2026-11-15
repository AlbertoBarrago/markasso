import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  browserStorage,
  isStorageAvailable,
  readStorage,
  removeStorage,
  writeStorage,
} from '../src/io/safe_storage';

/** localStorage as a browser with blocked site data exposes it: any access throws. */
function blockStorage(): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('SecurityError: access denied');
    },
  });
}

/** A working localStorage whose writes can be refused (quota). */
function workingStorage(refuseWrites = false): Storage {
  const items = new Map<string, string>();
  const storage = {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key: string) => items.get(key) ?? null,
    key: (index: number) => [...items.keys()][index] ?? null,
    removeItem: (key: string) => {
      items.delete(key);
    },
    setItem: (key: string, value: string) => {
      if (refuseWrites) throw new Error('QuotaExceededError');
      items.set(key, value);
    },
  } as Storage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
  return storage;
}

beforeEach(() => vi.resetModules());
afterEach(() => {
  Reflect.deleteProperty(globalThis, 'localStorage');
  vi.unstubAllGlobals();
});

describe('safe storage', () => {
  it('reads, writes and removes when storage works', () => {
    workingStorage();
    expect(isStorageAvailable()).toBe(true);
    expect(writeStorage('k', 'v')).toBe(true);
    expect(readStorage('k')).toBe('v');
    removeStorage('k');
    expect(readStorage('k')).toBeNull();
  });

  it('falls back to "not set" when the browser blocks storage', () => {
    blockStorage();
    expect(isStorageAvailable()).toBe(false);
    expect(readStorage('k')).toBeNull();
    expect(writeStorage('k', 'v')).toBe(false);
    expect(() => removeStorage('k')).not.toThrow();
  });

  it('reports a refused write', () => {
    workingStorage(true);
    expect(writeStorage('k', 'v')).toBe(false);
  });

  it('gives a Storage that refuses every call when the browser blocks it', () => {
    blockStorage();
    const storage = browserStorage();
    // Callers handle these errors already: nothing is kept in memory only.
    expect(() => storage.setItem('board', '1')).toThrow('SecurityError');
    expect(() => storage.getItem('board')).toThrow('SecurityError');
  });

  it('gives localStorage itself when it works', () => {
    const storage = workingStorage();
    expect(browserStorage()).toBe(storage);
  });
});

describe('modules that read storage at load', () => {
  it('start with blocked storage', async () => {
    blockStorage();
    vi.stubGlobal('navigator', { languages: ['it-IT'], language: 'it-IT' });
    vi.stubGlobal('document', { documentElement: { lang: '' } });
    const i18n = await import('../src/i18n');
    expect(i18n.getLocale()).toBe('it');
  });

  it('keep the default theme with blocked storage', async () => {
    blockStorage();
    vi.stubGlobal('navigator', { languages: ['en'], language: 'en' });
    vi.stubGlobal('document', {
      documentElement: {
        lang: '',
        setAttribute() {},
        getAttribute: () => null,
        style: { setProperty() {} },
      },
    });
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false, addEventListener() {} }),
    });
    const { getThemeMode } = await import('../src/ui/settings');
    expect(getThemeMode()).toBe('dark');
  });
});

describe('language', () => {
  it('does not reload when the choice cannot be saved', async () => {
    blockStorage();
    const reload = vi.fn();
    vi.stubGlobal('navigator', { languages: ['en'], language: 'en' });
    vi.stubGlobal('document', { documentElement: { lang: '' } });
    vi.stubGlobal('location', { reload });
    const { setLocale } = await import('../src/i18n');
    expect(setLocale('it')).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('custom colors', () => {
  it('do not throw when the color cannot be remembered', async () => {
    workingStorage(true);
    const { saveCustomColor, loadCustomColor } = await import(
      '../src/ui/color_picker'
    );
    expect(() => saveCustomColor('stroke', '#ff0000')).not.toThrow();
    expect(loadCustomColor('stroke')).toBeNull();
  });
});

describe('theme', () => {
  it('keeps the chosen mode when it cannot be saved', async () => {
    blockStorage();
    vi.stubGlobal('navigator', { languages: ['en'], language: 'en' });
    vi.stubGlobal('document', {
      documentElement: {
        lang: '',
        setAttribute() {},
        getAttribute: () => null,
        style: { setProperty() {} },
      },
    });
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false, addEventListener() {} }),
    });
    const { applyTheme, getThemeMode } = await import('../src/ui/settings');
    applyTheme('light');
    expect(getThemeMode()).toBe('light');
  });
});

describe('session autosave', () => {
  it('warns, and keeps warning, when the browser blocks storage', async () => {
    blockStorage();
    vi.stubGlobal('navigator', { languages: ['en'], language: 'en' });
    const appended: Array<{ id: string; textContent: string }> = [];
    const node = () => ({
      id: '',
      className: '',
      title: '',
      textContent: '',
      classList: { add() {}, remove() {} },
      append(...children: Array<{ textContent: string }>) {
        this.textContent = children.map((c) => c.textContent).join(' ');
      },
      addEventListener() {},
    });
    vi.stubGlobal('document', {
      documentElement: { lang: '', getAttribute: () => null },
      createElement: node,
      getElementById: (id: string) => appended.find((n) => n.id === id) ?? null,
      body: {
        appendChild: (n: { id: string; textContent: string }) =>
          appended.push(n),
      },
    });
    vi.stubGlobal('requestAnimationFrame', () => 0);
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const { History } = await import('../src/engine/history');
    const { createScene } = await import('../src/core/scene');
    const { initSession, flushSession } = await import('../src/io/session');
    const history = new History(createScene());
    initSession(history);
    history.dispatch({
      type: 'CREATE_ELEMENT',
      element: {
        id: 'a',
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        strokeColor: '#000',
        fillColor: 'transparent',
        strokeWidth: 1,
        opacity: 1,
        roughness: 0,
      },
    });
    timers.mockClear();
    flushSession();
    expect(appended).toHaveLength(1);
    expect(appended[0]!.textContent).toContain('blocks site storage');
    // No auto-dismiss timer: it stays until closed.
    expect(timers).not.toHaveBeenCalledWith(expect.any(Function), 8000);
    timers.mockRestore();
  });
});
