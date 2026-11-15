import { describe, expect, it } from 'vitest';
import type { Element } from '../src/elements/element';
import { History } from '../src/engine/history';
import {
  type LayerMove,
  layerTarget,
  reorderSelection,
} from '../src/ui/style_actions';

const ids = ['a', 'b', 'c', 'd', 'e'];

/** The stacking order after `move` on a scene of `ids`, selected in order. */
function reorder(selection: string[], move: LayerMove): string {
  const history = new History();
  history.dispatch({
    type: 'CREATE_ELEMENTS',
    elements: ids.map(
      (id, index) =>
        ({
          id,
          type: 'rectangle',
          x: index * 10,
          y: 0,
          width: 10,
          height: 10,
          strokeColor: '#000',
          fillColor: 'transparent',
          strokeWidth: 1,
          opacity: 1,
          roughness: 0,
        }) as Element,
    ),
  });
  history.dispatch({ type: 'SELECT_ELEMENTS', ids: selection });
  reorderSelection(history, move);
  return history.present.elements.map((el) => el.id).join('');
}

describe('reorderSelection', () => {
  it('moves a single element one step and to either end', () => {
    expect(reorder(['b'], 'forward')).toBe('acbde');
    expect(reorder(['b'], 'backward')).toBe('bacde');
    expect(reorder(['b'], 'front')).toBe('acdeb');
    expect(reorder(['b'], 'back')).toBe('bacde');
  });

  it('does not depend on the order the elements were selected in', () => {
    // Selected e first: sending backward moved b up before.
    expect(reorder(['e', 'b'], 'backward')).toBe('beacd');
    expect(reorder(['b', 'e'], 'backward')).toBe('beacd');
    expect(reorder(['c', 'b'], 'backward')).toBe('bcade');
    expect(reorder(['c', 'b'], 'forward')).toBe('adbce');
    expect(reorder(['e', 'b'], 'front')).toBe('acdbe');
  });

  it('makes no undo step when the order would not change', () => {
    const history = new History();
    expect(
      layerTarget([{ id: 'a' }, { id: 'b' }], new Set(['b']), 'front'),
    ).toBeNull();
    expect(
      layerTarget([{ id: 'a' }, { id: 'b' }], new Set(['b']), 'forward'),
    ).toBeNull();
    expect(
      layerTarget([{ id: 'a' }, { id: 'b' }], new Set(['a']), 'backward'),
    ).toBeNull();
    expect(
      layerTarget([{ id: 'a' }, { id: 'b' }], new Set(), 'back'),
    ).toBeNull();
    // A stale id: nothing to move.
    expect(layerTarget([{ id: 'a' }], new Set(['x']), 'forward')).toBeNull();
    reorderSelection(history, 'front');
    expect(history.canUndo()).toBe(false);
  });

  it('moves a split selection forward past the next element above it', () => {
    // e is on top already: nothing to pass.
    expect(
      layerTarget(
        ids.map((id) => ({ id })),
        new Set(['b', 'e']),
        'forward',
      ),
    ).toBeNull();
    expect(reorder(['b', 'd'], 'forward')).toBe('acebd');
  });
});
