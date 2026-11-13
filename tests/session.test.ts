import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScene, type Scene } from '../src/core/scene';
import type { Element } from '../src/elements/element';
import type { History } from '../src/engine/history';
import { flushSession, initSession, loadSession } from '../src/io/session';

const KEY = 'markasso-session';

const rect = (id: string): Element => ({
  id,
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  strokeColor: '#000',
  fillColor: 'transparent',
  strokeWidth: 1,
  opacity: 1,
  roughness: 0,
});

// Built before the browser globals are stubbed: createScene reads them.
const base = createScene();
const sceneWith = (...ids: string[]): Scene => ({
  ...base,
  elements: ids.map(rect),
});

let store: Map<string, string>;
let windowListeners: Map<string, () => void>;
let documentListeners: Map<string, () => void>;
let visibility: string;
let change: (scene: Scene) => void;

const history = {
  subscribe(listener: (scene: Scene) => void) {
    change = listener;
    return () => {};
  },
} as unknown as History;

const saved = (): { elements: Element[]; liveRoom?: string } | null => {
  const raw = store.get(KEY);
  return raw ? JSON.parse(raw) : null;
};

beforeEach(() => {
  vi.useFakeTimers();
  store = new Map();
  windowListeners = new Map();
  documentListeners = new Map();
  visibility = 'visible';
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  });
  vi.stubGlobal('window', {
    addEventListener: (type: string, cb: () => void) =>
      windowListeners.set(type, cb),
  });
  vi.stubGlobal('document', {
    get visibilityState() {
      return visibility;
    },
    addEventListener: (type: string, cb: () => void) =>
      documentListeners.set(type, cb),
  });
});
afterEach(() => {
  flushSession();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('session autosave', () => {
  it('saves after the debounce and loads it back', () => {
    initSession(history);
    change(sceneWith('a'));
    expect(saved()).toBeNull();
    vi.advanceTimersByTime(500);
    expect(saved()?.elements.map((el) => el.id)).toEqual(['a']);
    expect(loadSession()?.elements).toHaveLength(1);
    expect(loadSession()?.liveRoom).toBeNull();
  });

  it('does not wait forever while changes keep coming', () => {
    initSession(history);
    for (let elapsed = 0; elapsed < 2000; elapsed += 100) {
      change(sceneWith('a'));
      vi.advanceTimersByTime(100);
      expect(saved()).toBeNull();
    }
    change(sceneWith('a', 'b'));
    expect(saved()?.elements).toHaveLength(2);
  });

  it('saves a pending change when the page is hidden or closed', () => {
    initSession(history);
    change(sceneWith('a'));
    windowListeners.get('pagehide')?.();
    expect(saved()?.elements).toHaveLength(1);

    change(sceneWith('a', 'b'));
    documentListeners.get('visibilitychange')?.();
    expect(saved()?.elements).toHaveLength(1);
    visibility = 'hidden';
    documentListeners.get('visibilitychange')?.();
    expect(saved()?.elements).toHaveLength(2);
  });

  it('keeps the local drawing while a board stored elsewhere is open', () => {
    let paused = false;
    initSession(history, { paused: () => paused });
    change(sceneWith('mine'));
    vi.advanceTimersByTime(500);

    paused = true;
    change(sceneWith('cloud-1', 'cloud-2'));
    vi.advanceTimersByTime(500);
    change(sceneWith());
    vi.advanceTimersByTime(500);
    expect(saved()?.elements.map((el) => el.id)).toEqual(['mine']);

    paused = false;
    change(sceneWith('left-as-local'));
    vi.advanceTimersByTime(500);
    expect(saved()?.elements.map((el) => el.id)).toEqual(['left-as-local']);
  });

  it('records the live room the drawing is synced with', () => {
    let room: string | null = 'room-123';
    initSession(history, { liveRoom: () => room });
    change(sceneWith('a'));
    vi.advanceTimersByTime(500);
    expect(loadSession()?.liveRoom).toBe('room-123');

    room = null;
    change(sceneWith('a', 'b'));
    vi.advanceTimersByTime(500);
    expect(loadSession()?.liveRoom).toBeNull();
  });

  it('ignores a malformed live room in stored data', () => {
    store.set(
      KEY,
      JSON.stringify({ elements: [rect('a')], liveRoom: 'no spaces allowed' }),
    );
    expect(loadSession()?.liveRoom).toBeNull();
  });

  it('removes the stored drawing when the canvas is emptied', () => {
    initSession(history);
    change(sceneWith('a'));
    vi.advanceTimersByTime(500);
    change(sceneWith());
    vi.advanceTimersByTime(500);
    expect(saved()).toBeNull();
  });
});
