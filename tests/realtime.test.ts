import { describe, expect, it, vi } from 'vitest';
import type { Command } from '../src/commands/commands';
import { createScene } from '../src/core/scene';
import { isEphemeralCommand, isSessionCommand } from '../src/engine/ephemeral';
import { History } from '../src/engine/history';

function rect(id: string) {
  return {
    id,
    type: 'rectangle' as const,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    strokeColor: '#000',
    fillColor: 'transparent',
    strokeWidth: 1,
    opacity: 1,
    roughness: 0,
  };
}

describe('isSessionCommand', () => {
  it('relays persistent commands', () => {
    const cmd: Command = { type: 'CREATE_ELEMENT', element: rect('1') };
    expect(isSessionCommand(cmd)).toBe(true);
  });

  it('filters ephemeral (view-only) commands', () => {
    expect(isEphemeralCommand('PAN_VIEWPORT')).toBe(true);
    expect(isSessionCommand({ type: 'PAN_VIEWPORT' })).toBe(false);
    expect(isSessionCommand({ type: 'SELECT_ELEMENTS' })).toBe(false);
    expect(isSessionCommand({ type: 'SET_TOOL' })).toBe(false);
  });

  it('drops bare UNDO/REDO (undo travels as PATCH_ELEMENTS)', () => {
    expect(isSessionCommand({ type: 'UNDO' })).toBe(false);
    expect(isSessionCommand({ type: 'REDO' })).toBe(false);
    expect(isSessionCommand({ type: 'PATCH_ELEMENTS' })).toBe(true);
  });
});

describe('History.applyRemote', () => {
  it('applies a remote command via the reducer', () => {
    const h = new History(createScene());
    h.applyRemote({ type: 'CREATE_ELEMENT', element: rect('a') });
    expect(h.present.elements).toHaveLength(1);
  });

  it('keeps per-user appState defaults when a remote style is applied', () => {
    const h = new History(createScene());
    h.dispatch({ type: 'CREATE_ELEMENT', element: rect('mine') });
    h.dispatch({ type: 'SELECT_ELEMENTS', ids: ['mine'] });
    h.dispatch({ type: 'SET_STROKE_COLOR', color: '#111111' });

    // A remote peer changes the selected element's color.
    h.applyRemote({ type: 'APPLY_STYLE', strokeColor: '#ff0000' });

    // The element color is shared...
    expect(h.present.elements[0]?.strokeColor).toBe('#ff0000');
    // ...but the local default color is untouched (per-user).
    expect(h.present.appState.strokeColor).toBe('#111111');
  });

  it('bakes the target element ids into a broadcast APPLY_STYLE', () => {
    const onCommand = vi.fn();
    const h = new History(createScene(), onCommand);
    h.dispatch({ type: 'CREATE_ELEMENT', element: rect('a') });
    h.dispatch({ type: 'CREATE_ELEMENT', element: rect('b') });
    h.dispatch({ type: 'SELECT_ELEMENTS', ids: ['a', 'b'] });

    h.dispatch({ type: 'APPLY_STYLE', strokeWidth: 8 });

    const sent = onCommand.mock.calls.at(-1)?.[0] as
      | { type: string; ids?: string[] }
      | undefined;
    expect(sent?.type).toBe('APPLY_STYLE');
    expect(sent?.ids).toEqual(['a', 'b']);
  });

  it('does not change a peer default stroke width when a remote style is applied', () => {
    // User A changes the stroke width of their own element.
    const onCommand = vi.fn();
    const a = new History(createScene(), onCommand);
    a.dispatch({ type: 'CREATE_ELEMENT', element: rect('a1') });
    a.dispatch({ type: 'SELECT_ELEMENTS', ids: ['a1'] });
    a.dispatch({ type: 'APPLY_STYLE', strokeWidth: 8 });
    const sent = onCommand.mock.calls.at(-1)?.[0] as
      | { type: string; ids?: string[]; strokeWidth?: number }
      | undefined;

    // User B has their own element selected and a different default width.
    const b = new History(createScene());
    b.dispatch({ type: 'CREATE_ELEMENT', element: rect('b1') });
    b.dispatch({ type: 'SELECT_ELEMENTS', ids: ['b1'] });
    b.dispatch({ type: 'SET_STROKE_WIDTH', width: 3 });

    // B receives A's broadcast command.
    b.applyRemote(sent as never);

    // B's own element is untouched (different id)...
    expect(b.present.elements[0]?.strokeWidth).toBe(1);
    // ...and B's default stroke width is untouched (per-user).
    expect(b.present.appState.strokeWidth).toBe(3);
  });

  it('does not let a remote CREATE_ELEMENT hijack the receiver lastCreatedId fallback', () => {
    // User A draws a freehand stroke without selecting it (select: false),
    // as the freehand tool does mid-drawing/on commit.
    const onCommand = vi.fn();
    const a = new History(createScene(), onCommand);
    a.dispatch({
      type: 'CREATE_ELEMENT',
      element: rect('a-stroke'),
      select: false,
    });
    const sent = onCommand.mock.calls.at(-1)?.[0] as Command;

    // User B receives A's stroke over the wire but never selects it.
    const b = new History(createScene());
    b.applyRemote(sent);
    expect(b.present.appState.lastCreatedId).toBeNull();

    // B now changes stroke width with nothing selected (e.g. adjusting their
    // own pending freehand default before drawing).
    b.dispatch({ type: 'APPLY_STYLE', strokeWidth: 6 });

    // A's element must be untouched: B's style change had no target of its own.
    expect(b.present.elements[0]?.strokeWidth).toBe(1);
  });

  it('does not touch the undo/redo stack of the reader', () => {
    const h = new History(createScene());
    h.applyRemote({ type: 'CREATE_ELEMENT', element: rect('remote') });
    // Remote ops only: nothing is undoable for the reader.
    expect(h.canUndo()).toBe(false);
    h.undo();
    const ids = h.present.elements.map((e) => e.id);
    expect(ids).toEqual(['remote']);
  });

  it('does not re-broadcast via onCommand (no echo loop)', () => {
    const onCommand = vi.fn();
    const h = new History(createScene(), onCommand);
    h.applyRemote({ type: 'CREATE_ELEMENT', element: rect('remote') });
    expect(onCommand).not.toHaveBeenCalled();
  });
});

describe('History.resetForLiveReplay', () => {
  it('replays a command log onto a fresh scene', () => {
    const h = new History(createScene());
    h.dispatch({ type: 'CREATE_ELEMENT', element: rect('mine') });
    h.resetForLiveReplay([
      { type: 'CREATE_ELEMENT', element: rect('r1') },
      { type: 'CREATE_ELEMENT', element: rect('r2') },
    ]);
    const ids = h.present.elements.map((e) => e.id).sort();
    expect(ids).toEqual(['r1', 'r2']);
    expect(h.canUndo()).toBe(false);
  });

  it("keeps this user's tool, style defaults and grid", () => {
    const h = new History(createScene());
    h.dispatch({ type: 'SET_TOOL', tool: 'rectangle' });
    h.dispatch({ type: 'APPLY_STYLE', strokeColor: '#ff0000' });
    h.dispatch({ type: 'SET_TOOL_LOCK', locked: true });
    h.dispatch({ type: 'TOGGLE_GRID' });
    h.dispatch({
      type: 'CREATE_ELEMENT',
      element: rect('mine'),
      select: false,
    });
    const before = h.present.appState;
    h.resetForLiveReplay([{ type: 'CREATE_ELEMENT', element: rect('r1') }]);
    expect(h.present.appState).toEqual({
      ...before,
      // It pointed at an element of the board that was replaced.
      lastCreatedId: null,
    });
  });

  it('notifies once, also for an empty room', () => {
    const h = new History(createScene());
    h.dispatch({ type: 'CREATE_ELEMENT', element: rect('mine') });
    const listener = vi.fn();
    h.subscribe(listener);
    h.resetForLiveReplay([]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0].elements).toEqual([]);
    h.resetForLiveReplay([
      { type: 'CREATE_ELEMENT', element: rect('r1') },
      { type: 'CREATE_ELEMENT', element: rect('r2') },
    ]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('keeps the viewport when a peer loads a scene', () => {
    const h = new History(createScene());
    h.dispatch({ type: 'SET_VIEWPORT', offsetX: 5, offsetY: 6, zoom: 2 });
    h.applyRemote({
      type: 'LOAD_SCENE',
      elements: [rect('theirs')],
      viewport: { offsetX: 900, offsetY: 900, zoom: 0.2 },
    });
    expect(h.present.viewport).toEqual({ offsetX: 5, offsetY: 6, zoom: 2 });
    expect(h.present.elements.map((e) => e.id)).toEqual(['theirs']);
  });
});
